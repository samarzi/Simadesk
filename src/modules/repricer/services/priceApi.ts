/**
 * Единый слой получения "витринных" (видимых покупателю) и продавческих цен
 * для движка МРЦ (mrcScanner). Использует уже существующие API-клиенты —
 * никакого скрейпинга страниц маркетплейсов внутри приложения.
 */

import { fetchWbCurrentPrices } from '@/services/wbApi';
import { ozonApi } from '@/services/ozonApi';
import { yandexApi } from '@/services/yandexApi';
import { dbFetch } from '@/services/dbClient';
import type { WbStore } from '@/types/wb';
import type { OzonStore } from '@/types/ozon';
import type { YandexStore } from '@/types/yandex';
import type { BuyerPriceInfo } from '../types';
import { BUYER_PRICE_STALE_MS, MRC_ANALYSIS_TIMEOUT_MS, WB_MRC_TIMEOUT_MS } from '../types';
import { withTimeout } from '../utils';

// ── WB ────────────────────────────────────────────────────────────────────────

export type WbPriceMap = Map<number, { price: number; discount: number; priceWithDisc: number }>;

/** Цены WB из ЛК продавца для конкретного магазина (priceWithDisc — расчётная цена с учётом СПП по данным API). */
export async function fetchWbPricesForStore(store: WbStore, nmIds: number[]): Promise<WbPriceMap> {
  return withTimeout(fetchWbCurrentPrices(store.api_key, nmIds), WB_MRC_TIMEOUT_MS, 'WB API');
}

/**
 * Реальные витринные цены WB из Supabase (таблица wb_buyer_prices), которые собирает
 * браузерное расширение SimaDesk на публичных страницах wildberries.ru.
 */
export async function fetchWbBuyerPrices(nmIds: number[]): Promise<Map<number, BuyerPriceInfo>> {
  const result = new Map<number, BuyerPriceInfo>();
  if (nmIds.length === 0) return result;
  try {
    const inList = nmIds.join(',');
    const rows = await dbFetch<Array<{ nm_id: number; buyer_price: number; checked_at: string }>>(
      `wb_buyer_prices?select=nm_id,buyer_price,checked_at&nm_id=in.(${inList})`,
    );
    const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
    for (const row of rows ?? []) {
      if (!row.nm_id || !row.buyer_price) continue;
      result.set(row.nm_id, {
        price: Number(row.buyer_price),
        checkedAt: row.checked_at,
        marketSku: null,
        fresh: new Date(row.checked_at).getTime() >= staleBefore,
      });
    }
  } catch (e) {
    console.warn('[priceApi] fetchWbBuyerPrices error:', e);
  }
  return result;
}

// ── Ozon ──────────────────────────────────────────────────────────────────────

export type OzonPriceMap = Map<string, { sellerPrice: number; oldPrice: number }>;

/** Цены Ozon из ЛК продавца (sellerPrice/oldPrice) для конкретного магазина. */
export async function fetchOzonPricesForStore(store: OzonStore, offerIds: string[]): Promise<OzonPriceMap> {
  return withTimeout(
    ozonApi.getSellerPrices(offerIds, { client_id: store.client_id, api_key: store.api_key }),
    MRC_ANALYSIS_TIMEOUT_MS, 'Ozon API',
  );
}

/**
 * Реальные витринные цены Ozon из Supabase (таблица ozon_buyer_prices), которые собирает
 * браузерное расширение SimaDesk на публичных страницах ozon.ru.
 *
 * ВАЖНО: таблица ключуется по `product_id` — глобальному Ozon-идентификатору товара,
 * уникальному на всей площадке. `offer_id` — это артикул продавца (см. OzonProduct.offer_id),
 * он НЕ уникален между разными продавцами/магазинами: два разных товара разных продавцов
 * вполне могут иметь одинаковый offer_id. Поэтому здесь обязательно передаём product_id —
 * без него не запрашиваем витрину вовсе, чтобы не подставить чужую цену по случайному
 * совпадению артикула (см. запись в ozon-price-bridge, который резолвит product_id так же).
 */
export async function fetchOzonBuyerPrices(items: Array<{ offerId: string; productId: number | null }>): Promise<Map<string, BuyerPriceInfo>> {
  const result = new Map<string, BuyerPriceInfo>();
  const byProductId = new Map<number, string>(); // product_id → offerId (для сборки результата)
  for (const it of items) {
    if (it.productId != null) byProductId.set(it.productId, it.offerId);
  }
  if (byProductId.size === 0) return result;
  try {
    const inList = [...byProductId.keys()].join(',');
    const rows = await dbFetch<Array<{ product_id: number; buyer_price: number; checked_at: string }>>(
      `ozon_buyer_prices?select=product_id,buyer_price,checked_at&product_id=in.(${inList})`,
    );
    const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
    for (const row of rows ?? []) {
      const offerId = byProductId.get(row.product_id);
      if (!offerId || !row.buyer_price) continue;
      result.set(offerId, {
        price: Number(row.buyer_price),
        checkedAt: row.checked_at,
        marketSku: null,
        fresh: new Date(row.checked_at).getTime() >= staleBefore,
      });
    }
  } catch (e) {
    console.warn('[priceApi] fetchOzonBuyerPrices error:', e);
  }
  return result;
}

// ── Yandex Market — цены продавца (offer-prices) ─────────────────────────────

export type YmSellerPriceMap = Map<string, { price: number; discountBase?: number }>;

export async function fetchYmSellerPrices(store: YandexStore): Promise<YmSellerPriceMap> {
  if (!store.campaign_id) return new Map();
  return withTimeout(
    yandexApi.getOfferPrices(store.api_key, String(store.campaign_id)),
    MRC_ANALYSIS_TIMEOUT_MS, 'ЯМ API',
  );
}

// ── Yandex Market — реальные витринные цены (из расширения SimaDesk) ────────

/**
 * Витринные цены ЯМ из Supabase (таблица yandex_buyer_prices), которые собирает
 * браузерное расширение SimaDesk на публичных страницах market.yandex.ru.
 * Учитывают Плюс/бусты, недоступные через API Маркета.
 *
 * ВАЖНО: таблица ключуется по `market_sku` — глобальному идентификатору товара на
 * Яндекс.Маркете, уникальному на всей площадке. `offer_id` — это артикул продавца,
 * он НЕ уникален между разными продавцами: у другого продавца может быть точно такой
 * же offer_id для совершенно другого товара. Поэтому обязательно передаём marketSku —
 * без него не запрашиваем витрину, чтобы не подставить чужую цену по совпадению артикула
 * (см. запись в yandex-price-bridge, который резолвит market_sku так же).
 */
export async function fetchYmBuyerPrices(items: Array<{ offerId: string; marketSku: number | null }>): Promise<Map<string, BuyerPriceInfo>> {
  const result = new Map<string, BuyerPriceInfo>();
  const bySku = new Map<number, string>(); // market_sku → offerId
  for (const it of items) {
    if (it.marketSku != null) bySku.set(it.marketSku, it.offerId);
  }
  if (bySku.size === 0) return result;
  try {
    const inList = [...bySku.keys()].join(',');
    const rows = await dbFetch<Array<{
      market_sku: number;
      buyer_price: number;
      checked_at: string;
    }>>(
      `yandex_buyer_prices?select=market_sku,buyer_price,checked_at&market_sku=in.(${inList})`,
    );
    const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
    for (const row of rows ?? []) {
      const offerId = bySku.get(row.market_sku);
      if (!offerId || !row.buyer_price) continue;
      result.set(offerId, {
        price: Number(row.buyer_price),
        checkedAt: row.checked_at,
        marketSku: row.market_sku,
        fresh: new Date(row.checked_at).getTime() >= staleBefore,
      });
    }
  } catch (e) {
    console.warn('[priceApi] fetchYmBuyerPrices error:', e);
  }
  return result;
}
