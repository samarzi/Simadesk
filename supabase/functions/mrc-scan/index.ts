/**
 * Supabase Edge Function — серверный скан и коррекция цен по правилам МРЦ
 * (WB / Ozon / Яндекс.Маркет), независимо от того, открыта ли вкладка SimaDesk.
 *
 * Работает по ячейкам rule.data.mrcItems[] (товар × магазин × МП, своя цена МРЦ
 * на каждую ячейку) — той же структуре, что использует клиентский
 * src/modules/repricer/services/mrcScanner.ts. Одно правило может содержать
 * ячейки на нескольких маркетплейсах одновременно — поэтому ячейки группируются
 * по item.mp, а не по rule.data.marketplace.
 *
 * Состояние по ячейке (lastUpdateAt для кулдауна, consecutiveAnomalies/consecutiveHealthy/
 * paused для защиты от повторяющихся аномалий — см. evaluateGate) хранится прямо в
 * repricer_rules.data.mrcState, ключ — item.key (id ячейки).
 * Подробный лог каждого изменения цены пишется в repricer_events,
 * ошибки API — в repricer_errors (см. supabase/migrations).
 *
 * Запускается по расписанию через pg_cron (см. supabase/migrations).
 * Требует авторизации (Authorization: Bearer <anon|service_role key>) — pg_cron
 * передаёт ключ через pg_net.http_post.
 * Deploy: supabase functions deploy mrc-scan --project-ref rdqwzojrsmbdxiczqjci
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  MRC_MAX_CHANGE_PCT,
  BUYER_PRICE_STALE_MS,
} from '../../../src/modules/repricer/types.ts';
import type { MrcCellState } from '../../../src/modules/repricer/types.ts';
import { emptyState, evaluateGate } from './gate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ── Константы ─────────────────────────────────────────────────────────────
// Safety-константы (TTL, пороги отклонения, лимит discount WB, ±% клампинга,
// кулдаун) импортированы из src/modules/repricer/types.ts и ./gate.ts —
// единого источника для клиента и сервера, чтобы значения не могли разойтись.

const WB_CHUNK_SIZE   = 20;   // сколько nmID запрашивать за один вызов list/goods/filter
const OZON_CHUNK_SIZE = 1000; // лимит offer_id за один вызов v5/product/info/prices

interface MrcItem {
  key: string;
  mp: 'wb' | 'ozon' | 'yandex';
  storeId: string;
  storeName: string;
  productId: string;
  vendorCode: string;
  productTitle: string;
  mrcPrice: number;
  enabled: boolean;
}

/** WB/Ozon/ЯМ: пропорциональное масштабирование текущей цены продавца, клампинг ±20% за цикл. */
function computeNewSellerPrice(target: number, currentSeller: number, showcase: number): number {
  if (showcase <= 0 || currentSeller <= 0) return currentSeller;
  const raw     = Math.ceil(currentSeller * (target / showcase));
  const maxDiff = Math.ceil(currentSeller * MRC_MAX_CHANGE_PCT);
  return Math.min(currentSeller + maxDiff, Math.max(currentSeller - maxDiff, raw));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Логирование (repricer_events / repricer_errors) ─────────────────────────
async function logEvent(supabase: any, ev: Record<string, any>): Promise<void> {
  try {
    await supabase.from('repricer_events').insert(ev);
  } catch {
    // лог не должен валить основной сканер
  }
}

async function logError(supabase: any, err: Record<string, any>): Promise<void> {
  try {
    await supabase.from('repricer_errors').insert(err);
  } catch {
    // лог не должен валить основной сканер
  }
}

// ── Общие хелперы для ячеек mrcItems ─────────────────────────────────────────

/** Включённые ячейки нужного МП из всех активных MRC-правил, сгруппированные по storeId. */
function collectItemsByStore(rules: any[], mp: string): Map<string, Array<{ rule: any; item: MrcItem }>> {
  const byStore = new Map<string, Array<{ rule: any; item: MrcItem }>>();
  for (const rule of rules) {
    const items: MrcItem[] = Array.isArray(rule.data?.mrcItems) ? rule.data.mrcItems : [];
    for (const item of items) {
      if (item.mp !== mp || item.enabled === false || !(item.mrcPrice > 0)) continue;
      const list = byStore.get(item.storeId) ?? [];
      list.push({ rule, item });
      byStore.set(item.storeId, list);
    }
  }
  return byStore;
}

function getState(rule: any, item: MrcItem): MrcCellState {
  const states: Record<string, MrcCellState> = rule.data.mrcState ?? {};
  rule.data.mrcState = states;
  if (!states[item.key]) states[item.key] = emptyState();
  return states[item.key];
}

async function persistRules(supabase: any, ruleIds: Set<string>, rulesById: Map<string, any>): Promise<void> {
  for (const id of ruleIds) {
    const rule = rulesById.get(id);
    if (rule) await supabase.from('repricer_rules').update({ data: rule.data }).eq('id', rule.id);
  }
}

// ── WB ───────────────────────────────────────────────────────────────────────
interface WbGoodsData { price: number }

async function fetchWbGoods(
  apiKey: string,
  nmIds: number[],
  supabase: any,
): Promise<Map<number, WbGoodsData>> {
  const priceMap = new Map<number, WbGoodsData>();

  for (let i = 0; i < nmIds.length; i += WB_CHUNK_SIZE) {
    const chunk = nmIds.slice(i, i + WB_CHUNK_SIZE);
    const params = new URLSearchParams({ limit: '1000', filterNmID: chunk.join(',') });
    const url = `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?${params}`;

    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch(url, { headers: { Authorization: apiKey } });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
    }
    if (!resp) continue;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await logError(supabase, {
        marketplace: 'wb',
        product_id: chunk.join(','),
        request: { filterNmID: chunk },
        response: { body: text.slice(0, 500) },
        http_status: resp.status,
        error: 'list/goods/filter failed',
      });
      continue;
    }

    const data = await resp.json();
    const items: any[] = data?.data?.listGoods ?? [];
    for (const item of items) {
      const nmID = Number(item.nmID);
      const price = Number(item.sizes?.[0]?.price ?? 0);
      if (nmID > 0 && price > 0) priceMap.set(nmID, { price });
    }
  }

  return priceMap;
}

// Реальная цена покупателя (без WB Кошелька/СПП, без зачёркнутой старой цены), собранная
// расширением SimaDesk с публичных страниц wildberries.ru — единственный источник решения
// "отклонилась ли витрина от МРЦ" (см. processWb ниже); без свежих (< BUYER_PRICE_STALE_MS)
// данных evaluateGate вернёт safe_mode 'no_fresh_data' — без подмены на цену, рассчитанную
// через discount из API.
async function fetchWbBuyerPrices(nmIds: number[], supabase: any): Promise<Map<number, number>> {
  const showcaseMap = new Map<number, number>();
  if (nmIds.length === 0) return showcaseMap;

  const { data } = await supabase
    .from('wb_buyer_prices')
    .select('nm_id, buyer_price, checked_at')
    .in('nm_id', nmIds);

  const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
  for (const row of data ?? []) {
    if (!row.nm_id || !row.buyer_price) continue;
    if (new Date(row.checked_at).getTime() < staleBefore) continue;
    showcaseMap.set(Number(row.nm_id), Number(row.buyer_price));
  }
  return showcaseMap;
}

async function uploadWbPrices(
  apiKey: string,
  updates: Array<{ nmID: number; price: number; discount?: number }>,
  store: any,
  supabase: any,
  log: any[],
): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < updates.length; i += 1000) {
    const batch = updates.slice(i, i + 1000);
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch('https://discounts-prices-api.wildberries.ru/api/v2/upload/task', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: batch }),
      });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
    if (!resp) { ok = false; continue; }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      ok = false;
      log.push({ mp: 'wb', store: store.name, error: `upload ${resp.status}: ${text.slice(0, 200)}` });
      await logError(supabase, {
        marketplace: 'wb',
        product_id: batch.map(b => b.nmID).join(','),
        request: { data: batch },
        response: { body: text.slice(0, 500) },
        http_status: resp.status,
        error: 'upload/task failed',
      });
    }
  }
  return ok;
}

async function processWb(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = collectItemsByStore(rules, 'wb');
  if (byStore.size === 0) return;

  for (const [storeId, entries] of byStore) {
    const { data: store } = await supabase.from('wb_stores').select('api_key, name').eq('id', storeId).single();
    if (!store?.api_key) { log.push({ mp: 'wb', storeId, error: 'store not found' }); continue; }

    const nmIds = [...new Set(entries.map(e => Number(e.item.productId)))].filter(n => n > 0);
    if (nmIds.length === 0) continue;

    const priceMap = await fetchWbGoods(store.api_key, nmIds, supabase);
    const showcaseMap = await fetchWbBuyerPrices(nmIds, supabase);

    const updates: Array<{ nmID: number; price: number }> = [];
    const adjustedCtx = new Map<number, { rule: any; item: MrcItem; target: number; oldSeller: number; oldShowcase: number; newSeller: number }>();
    const touchedRuleIds = new Set<string>();
    const rulesById = new Map<string, any>();

    for (const { rule, item } of entries) {
      rulesById.set(rule.id, rule);
      const nmID = Number(item.productId);
      const data = priceMap.get(nmID);
      if (!data) {
        await logError(supabase, {
          marketplace: 'wb', product_id: item.productId,
          request: { filterNmID: [nmID] }, response: null, http_status: null,
          error: 'no price data returned for nmID',
        });
        continue;
      }

      const target   = item.mrcPrice;
      const showcase = showcaseMap.get(nmID) ?? null; // только расширение — без фолбэка на API/discount
      const seller   = data.price;
      const state    = getState(rule, item);

      const gate = evaluateGate(state, showcase, target);
      touchedRuleIds.add(rule.id); // evaluateGate всегда мутирует счётчики state — нужно сохранить
      if (gate.status !== 'needs_adjust') {
        log.push({
          mp: 'wb', store: store.name, nmID, mrcPrice: target, showcase,
          action: gate.status, ...(gate.reason ? { reason: gate.reason } : {}),
        });
        if (gate.status === 'safe_mode' || gate.status === 'paused') {
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'wb', store_name: store.name,
            product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
            old_seller_price: seller, new_seller_price: null, old_buyer_price: showcase,
            target_mrc_price: target, action: gate.status,
            api_request: null, api_response: null, success: false, error: gate.reason,
          });
        }
        continue;
      }

      const newSeller = computeNewSellerPrice(target, seller, showcase as number);

      updates.push({ nmID, price: newSeller });
      adjustedCtx.set(nmID, { rule, item, target, oldSeller: seller, oldShowcase: showcase as number, newSeller });
      log.push({ mp: 'wb', store: store.name, nmID, mrcPrice: target, showcase, oldSeller: seller, newSeller, action: 'adjusted' });
    }

    if (updates.length > 0) {
      const ok = await uploadWbPrices(store.api_key, updates, store, supabase, log);

      for (const { rule, item, target, oldSeller, oldShowcase, newSeller } of adjustedCtx.values()) {
        if (ok) {
          getState(rule, item).lastUpdateAt = new Date().toISOString();
          rule.data.lastAppliedAt = new Date().toISOString();
          touchedRuleIds.add(rule.id);
        }
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'wb', store_name: store.name,
          product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
          old_seller_price: oldSeller, new_seller_price: newSeller, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { nmID: Number(item.productId), price: newSeller },
          api_response: { ok }, success: ok, error: ok ? null : 'upload/task failed',
        });
      }

      // Без мгновенной пост-проверки: новую витрину для WB теперь сообщит только
      // расширение при следующем обходе (см. fetchWbBuyerPrices) — как и для ЯМ,
      // см. комментарий в processYandex ниже.
    }

    await persistRules(supabase, touchedRuleIds, rulesById);
  }
}

// ── Ozon ─────────────────────────────────────────────────────────────────────
async function fetchOzonPrices(
  headers: Record<string, string>,
  offerIds: string[],
  store: any,
  supabase: any,
): Promise<Map<string, { price: number; oldPrice: number }>> {
  const priceMap = new Map<string, { price: number; oldPrice: number }>();

  for (let i = 0; i < offerIds.length; i += OZON_CHUNK_SIZE) {
    const chunk = offerIds.slice(i, i + OZON_CHUNK_SIZE);
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { offer_id: chunk, visibility: 'ALL' }, limit: chunk.length }),
      });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
    if (!resp) continue;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await logError(supabase, {
        marketplace: 'ozon', product_id: chunk.join(','),
        request: { filter: { offer_id: chunk } }, response: { body: text.slice(0, 500) },
        http_status: resp.status, error: 'info/prices failed',
      });
      continue;
    }

    const respJson = await resp.json();
    const items: any[] = respJson.items || respJson.result?.items || [];
    for (const item of items) {
      const price = parseFloat(item.price?.price || '0') || 0;
      const oldPrice = parseFloat(item.price?.old_price || '0') || 0;
      if (item.offer_id && price > 0) priceMap.set(item.offer_id, { price, oldPrice });
    }
  }

  return priceMap;
}

// Реальная цена покупателя (без Ozon Card, без зачёркнутой старой цены), собранная
// расширением SimaDesk с публичных страниц ozon.ru — см. fetchWbBuyerPrices/
// fetchYandexBuyerPrices выше/ниже, та же логика и тот же TTL.
//
// ВАЖНО: ozon_buyer_prices ключуется по глобальному Ozon product_id, а НЕ по offer_id —
// offer_id это артикул продавца, он не уникален между разными продавцами/магазинами
// (см. ту же схему в ozon-price-bridge/index.ts). Поэтому сначала резолвим offer_id →
// product_id через ozon_products, где (store_id, offer_id) уникальны, и только потом
// запрашиваем витрину по product_id — иначе есть риск подставить чужую цену по
// случайному совпадению артикула у другого продавца.
async function fetchOzonBuyerPrices(storeId: string, offerIds: string[], supabase: any): Promise<Map<string, number>> {
  const showcaseMap = new Map<string, number>();
  if (offerIds.length === 0) return showcaseMap;

  const { data: products } = await supabase
    .from('ozon_products')
    .select('offer_id, product_id')
    .eq('store_id', storeId)
    .in('offer_id', offerIds);

  const productIdByOfferId = new Map<string, number>();
  for (const p of products ?? []) {
    if (p.product_id) productIdByOfferId.set(p.offer_id, p.product_id);
  }
  const productIds = [...productIdByOfferId.values()];
  if (productIds.length === 0) return showcaseMap;

  const { data } = await supabase
    .from('ozon_buyer_prices')
    .select('product_id, buyer_price, checked_at')
    .in('product_id', productIds);

  const offerIdByProductId = new Map<number, string>();
  for (const [offerId, productId] of productIdByOfferId) offerIdByProductId.set(productId, offerId);

  const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
  for (const row of data ?? []) {
    const offerId = offerIdByProductId.get(row.product_id);
    if (!offerId || !row.buyer_price) continue;
    if (new Date(row.checked_at).getTime() < staleBefore) continue;
    showcaseMap.set(offerId, Number(row.buyer_price));
  }
  return showcaseMap;
}

async function processOzon(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = collectItemsByStore(rules, 'ozon');
  if (byStore.size === 0) return;

  for (const [storeId, entries] of byStore) {
    const { data: store } = await supabase.from('ozon_stores').select('client_id, api_key, name').eq('id', storeId).single();
    if (!store?.api_key) { log.push({ mp: 'ozon', storeId, error: 'store not found' }); continue; }

    const headers = { 'Content-Type': 'application/json', 'Client-Id': store.client_id, 'Api-Key': store.api_key };

    const offerIds = [...new Set(entries.map(e => e.item.productId))];
    if (offerIds.length === 0) continue;

    const priceMap = await fetchOzonPrices(headers, offerIds, store, supabase);
    const showcaseMap = await fetchOzonBuyerPrices(storeId, offerIds, supabase);

    const updates: Array<{ offer_id: string; price: string; old_price?: string; min_price: string; auto_action_enabled: 'DISABLED' }> = [];
    const adjustedCtx = new Map<string, { rule: any; item: MrcItem; target: number; oldSeller: number; oldShowcase: number; newSeller: number }>();
    const touchedRuleIds = new Set<string>();
    const rulesById = new Map<string, any>();

    for (const { rule, item } of entries) {
      rulesById.set(rule.id, rule);
      const data = priceMap.get(item.productId);
      if (!data) {
        await logError(supabase, {
          marketplace: 'ozon', product_id: item.productId,
          request: { offer_id: item.productId }, response: null, http_status: null,
          error: 'no price data returned for offer_id',
        });
        continue;
      }

      const target   = item.mrcPrice;
      const showcase = showcaseMap.get(item.productId) ?? null; // только расширение — без фолбэка на marketing_price
      const seller   = data.price;
      const state    = getState(rule, item);

      const gate = evaluateGate(state, showcase, target);
      touchedRuleIds.add(rule.id); // evaluateGate всегда мутирует счётчики state — нужно сохранить
      if (gate.status !== 'needs_adjust') {
        log.push({
          mp: 'ozon', store: store.name, offerId: item.productId, mrcPrice: target, showcase,
          action: gate.status, ...(gate.reason ? { reason: gate.reason } : {}),
        });
        if (gate.status === 'safe_mode' || gate.status === 'paused') {
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'ozon', store_name: store.name,
            product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
            old_seller_price: seller, new_seller_price: null, old_buyer_price: showcase,
            target_mrc_price: target, action: gate.status,
            api_request: null, api_response: null, success: false, error: gate.reason,
          });
        }
        continue;
      }

      const newSeller = computeNewSellerPrice(target, seller, showcase as number);
      const refOld = (data.oldPrice && data.oldPrice > seller) ? data.oldPrice : seller;
      const safeRefOld = refOld > newSeller ? refOld : 0;
      const safeMinP = Math.max(1, newSeller - 1);

      updates.push({
        offer_id: item.productId,
        price: String(newSeller),
        ...(safeRefOld > 0 ? { old_price: String(safeRefOld) } : {}),
        min_price: String(safeMinP),
        auto_action_enabled: 'DISABLED',
      });
      adjustedCtx.set(item.productId, { rule, item, target, oldSeller: seller, oldShowcase: showcase as number, newSeller });
      getState(rule, item).lastUpdateAt = new Date().toISOString();
      rule.data.lastAppliedAt = new Date().toISOString();
      touchedRuleIds.add(rule.id);
      log.push({ mp: 'ozon', store: store.name, offerId: item.productId, mrcPrice: target, showcase, oldSeller: seller, newSeller, action: 'adjusted' });
    }

    let uploadOk = true;
    if (updates.length > 0) {
      for (let i = 0; i < updates.length; i += 100) {
        const batch = updates.slice(i, i + 100);
        let resp: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          resp = await fetch('https://api-seller.ozon.ru/v1/product/import/prices', {
            method: 'POST', headers,
            body: JSON.stringify({ prices: batch }),
          });
          if (resp.status !== 429) break;
          await sleep(1000 * Math.pow(2, attempt));
        }
        if (!resp || !resp.ok) {
          uploadOk = false;
          const text = resp ? await resp.text().catch(() => '') : '';
          log.push({ mp: 'ozon', store: store.name, error: `import ${resp?.status}: ${text.slice(0, 200)}` });
          await logError(supabase, {
            marketplace: 'ozon', product_id: batch.map(b => b.offer_id).join(','),
            request: { prices: batch }, response: { body: text.slice(0, 500) },
            http_status: resp?.status ?? null, error: 'import/prices failed',
          });
        }
      }

      for (const { rule, item, target, oldSeller, oldShowcase, newSeller } of adjustedCtx.values()) {
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'ozon', store_name: store.name,
          product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
          old_seller_price: oldSeller, new_seller_price: newSeller, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { offer_id: item.productId, price: String(newSeller) },
          api_response: { ok: uploadOk }, success: uploadOk, error: uploadOk ? null : 'import/prices failed',
        });
      }

      // Без мгновенной пост-проверки: новую витрину для Ozon теперь сообщит только
      // расширение при следующем обходе (см. fetchOzonBuyerPrices) — как и для ЯМ,
      // см. комментарий в processYandex ниже.
    }

    await persistRules(supabase, touchedRuleIds, rulesById);
  }
}

// ── Яндекс Маркет ────────────────────────────────────────────────────────────
async function fetchYandexPrices(
  headers: Record<string, string>,
  campaignId: string,
  store: any,
  supabase: any,
  offerIds?: string[],
): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();

  try {
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ pageSize: '200' });
      if (pageToken) params.set('page_token', pageToken);
      const resp = await fetch(`https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices?${params}`, {
        method: offerIds ? 'POST' : 'GET',
        headers,
        ...(offerIds ? { body: JSON.stringify({ offerIds }) } : {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        await logError(supabase, {
          marketplace: 'yandex', product_id: offerIds?.join(',') ?? null,
          request: { campaignId, offerIds }, response: { body: text.slice(0, 500) },
          http_status: resp.status, error: 'offer-prices failed',
        });
        break;
      }
      const respJson = await resp.json();
      const items: any[] = respJson.result?.offers ?? [];
      for (const item of items) {
        const offerId = item.id ?? item.offerId ?? '';
        const price = Number(item.price?.value ?? 0);
        if (offerId && price > 0) priceMap.set(offerId, price);
      }
      pageToken = respJson.result?.paging?.nextPageToken;
      if (!pageToken || items.length === 0) break;
    }
  } catch (e: any) {
    await logError(supabase, {
      marketplace: 'yandex', product_id: offerIds?.join(',') ?? null,
      request: { campaignId, offerIds }, response: null, http_status: null,
      error: e?.message ?? String(e),
    });
  }

  return priceMap;
}

// Реальная цена покупателя (с учётом Буста/Плюса), собранная расширением SimaDesk
// с публичных страниц market.yandex.ru — основа решения "отклонилась ли витрина от
// МРЦ" (см. processYandex ниже); если свежих (< BUYER_PRICE_STALE_MS) данных нет,
// evaluateGate вернёт safe_mode 'no_fresh_data' — истинная пауза, без подмены
// на собственную цену продавца (см. комментарий в processYandex).
// ВАЖНО: yandex_buyer_prices ключуется по глобальному market_sku, а НЕ по offer_id —
// offer_id это артикул продавца, он не уникален между разными продавцами (см. ту же
// схему в yandex-price-bridge/index.ts). Резолвим offer_id → market_sku через
// yandex_products, где (store_id, offer_id) уникальны, прежде чем запрашивать витрину.
async function fetchYandexBuyerPrices(storeId: string, offerIds: string[], supabase: any): Promise<Map<string, number>> {
  const showcaseMap = new Map<string, number>();
  if (offerIds.length === 0) return showcaseMap;

  const { data: products } = await supabase
    .from('yandex_products')
    .select('offer_id, market_sku')
    .eq('store_id', storeId)
    .in('offer_id', offerIds);

  const skuByOfferId = new Map<string, number>();
  for (const p of products ?? []) {
    if (p.market_sku) skuByOfferId.set(p.offer_id, p.market_sku);
  }
  const skus = [...skuByOfferId.values()];
  if (skus.length === 0) return showcaseMap;

  const { data } = await supabase
    .from('yandex_buyer_prices')
    .select('market_sku, buyer_price, checked_at')
    .in('market_sku', skus);

  const offerIdBySku = new Map<number, string>();
  for (const [offerId, sku] of skuByOfferId) offerIdBySku.set(sku, offerId);

  const staleBefore = Date.now() - BUYER_PRICE_STALE_MS;
  for (const row of data ?? []) {
    const offerId = offerIdBySku.get(row.market_sku);
    if (!offerId || !row.buyer_price) continue;
    if (new Date(row.checked_at).getTime() < staleBefore) continue;
    showcaseMap.set(offerId, Number(row.buyer_price));
  }
  return showcaseMap;
}

async function processYandex(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = collectItemsByStore(rules, 'yandex');
  if (byStore.size === 0) return;

  for (const [storeId, entries] of byStore) {
    const { data: store } = await supabase.from('yandex_stores').select('api_key, campaign_id, business_id, name').eq('id', storeId).single();
    if (!store?.api_key || !store.campaign_id) { log.push({ mp: 'yandex', storeId, error: 'store not found' }); continue; }

    const headers = { 'Api-Key': store.api_key, 'Content-Type': 'application/json', Accept: 'application/json' };

    const offerIds = [...new Set(entries.map(e => e.item.productId))];
    if (offerIds.length === 0) continue;

    const priceMap = await fetchYandexPrices(headers, store.campaign_id, store, supabase, offerIds);
    const showcaseMap = await fetchYandexBuyerPrices(storeId, offerIds, supabase);

    const updates: Array<{ offerId: string; price: number }> = [];
    const adjustedCtx = new Map<string, { rule: any; item: MrcItem; target: number; oldPrice: number; oldShowcase: number; newPrice: number }>();
    const touchedRuleIds = new Set<string>();
    const rulesById = new Map<string, any>();

    for (const { rule, item } of entries) {
      rulesById.set(rule.id, rule);
      const currentSetPrice = priceMap.get(item.productId) ?? 0;
      if (!currentSetPrice) {
        await logError(supabase, {
          marketplace: 'yandex', product_id: item.productId,
          request: { campaignId: store.campaign_id }, response: null, http_status: null,
          error: 'no price data returned for offerId',
        });
        continue;
      }

      const target = item.mrcPrice;
      // Реальная цена покупателя (с Бустом/кешбэком Плюса) — то, что видит покупатель,
      // поэтому именно с ней сравниваем МРЦ (та же логика, что у клиента в mrcScanner.ts).
      // Без свежих (< BUYER_PRICE_STALE_MS) данных расширения — evaluateGate вернёт
      // safe_mode 'no_fresh_data': истинная пауза, а не подмена на currentSetPrice (Буст/Плюс
      // могут занижать реальную витрину относительно цены продавца — подмена рискует
      // продолжить молчаливый демпинг ниже МРЦ).
      const freshShowcase = showcaseMap.get(item.productId) ?? null;
      const state = getState(rule, item);

      const gate = evaluateGate(state, freshShowcase, target);
      touchedRuleIds.add(rule.id); // evaluateGate всегда мутирует счётчики state — нужно сохранить
      if (gate.status !== 'needs_adjust') {
        log.push({
          mp: 'yandex', store: store.name, offerId: item.productId, mrcPrice: target, currentSetPrice,
          ...(freshShowcase != null ? { showcase: freshShowcase } : {}),
          action: gate.status, ...(gate.reason ? { reason: gate.reason } : {}),
        });
        if (gate.status === 'safe_mode' || gate.status === 'paused') {
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'yandex', store_name: store.name,
            product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
            old_seller_price: currentSetPrice, new_seller_price: null, old_buyer_price: freshShowcase,
            target_mrc_price: target, action: gate.status,
            api_request: null, api_response: null, success: false, error: gate.reason,
          });
        }
        continue;
      }

      // gate.status === 'needs_adjust' гарантирует freshShowcase != null (см. evaluateGate).
      const showcase = freshShowcase!;
      const newPrice = computeNewSellerPrice(target, currentSetPrice, showcase);
      updates.push({ offerId: item.productId, price: newPrice });
      adjustedCtx.set(item.productId, { rule, item, target, oldPrice: currentSetPrice, oldShowcase: showcase, newPrice });
      getState(rule, item).lastUpdateAt = new Date().toISOString();
      rule.data.lastAppliedAt = new Date().toISOString();
      touchedRuleIds.add(rule.id);
      log.push({ mp: 'yandex', store: store.name, offerId: item.productId, mrcPrice: target, currentSetPrice, showcase, newPrice, action: 'adjusted' });
    }

    let updateOk = true;
    if (updates.length > 0) {
      const mappingsBody = {
        offerMappings: updates.map(o => ({ offer: { offerId: o.offerId, basicPrice: { value: o.price, currencyId: 'RUR' } } })),
      };
      const pricesBody = {
        offers: updates.map(o => ({ offerId: o.offerId, price: { value: o.price, currencyId: 'RUR' } })),
      };

      const [mappingsResp, pricesResp] = await Promise.all([
        fetch(`https://api.partner.market.yandex.ru/v2/businesses/${store.business_id}/offer-mappings/update`, {
          method: 'POST', headers, body: JSON.stringify(mappingsBody),
        }).catch((e) => { log.push({ mp: 'yandex', store: store.name, error: `mappings: ${e?.message}` }); return null; }),
        fetch(`https://api.partner.market.yandex.ru/v2/businesses/${store.business_id}/offer-prices/updates`, {
          method: 'POST', headers, body: JSON.stringify(pricesBody),
        }).catch((e) => { log.push({ mp: 'yandex', store: store.name, error: `prices: ${e?.message}` }); return null; }),
      ]);

      updateOk = !!mappingsResp?.ok && !!pricesResp?.ok;
      if (!pricesResp?.ok) {
        const text = pricesResp ? await pricesResp.text().catch(() => '') : '';
        await logError(supabase, {
          marketplace: 'yandex', product_id: updates.map(u => u.offerId).join(','),
          request: pricesBody, response: { body: text.slice(0, 500) },
          http_status: pricesResp?.status ?? null, error: 'offer-prices/updates failed',
        });
      }

      for (const { rule, item, target, oldPrice, oldShowcase, newPrice } of adjustedCtx.values()) {
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'yandex', store_name: store.name,
          product_id: item.productId, vendor_code: item.vendorCode, product_title: item.productTitle,
          old_seller_price: oldPrice, new_seller_price: newPrice, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { offerId: item.productId, price: newPrice },
          api_response: { ok: updateOk }, success: updateOk, error: updateOk ? null : 'offer-prices/updates failed',
        });
      }

      // Без мгновенной пост-проверки: *_buyer_prices обновляется только когда расширение
      // SimaDesk реально открывает страницу товара (асинхронно, не по нашему запросу) —
      // сразу после правки там почти гарантированно та же старая запись, а не отражение
      // нашей правки. Проверять и корректировать дальше будет следующий тик cron
      // (через ~20 мин), когда кулдаун пройдёт и (возможно) появятся свежие данные витрины.
    }

    // Каждый цикл держим все МРЦ-товары этого магазина вне акций ЯМ (промо переопределяют
    // цену продавца на витрине, что делает поддержание МРЦ бессмысленным).
    if (offerIds.length > 0 && store.business_id) {
      try {
        const resp = await fetch(`https://api.partner.market.yandex.ru/businesses/${store.business_id}/promos`, {
          method: 'POST', headers, body: JSON.stringify({ statuses: ['ACTIVE', 'UPCOMING'] }),
        });
        const respJson = await resp.json();
        const promos: any[] = respJson?.promos ?? [];
        await Promise.allSettled(promos.map((promo: any) =>
          fetch(`https://api.partner.market.yandex.ru/businesses/${store.business_id}/promos/offers/delete`, {
            method: 'POST', headers, body: JSON.stringify({ promoId: promo.id, deleteAllOffers: false, offerIds }),
          }),
        ));
      } catch (e: any) {
        log.push({ mp: 'yandex', store: store.name, error: `removeFromPromos: ${e?.message}` });
      }
    }

    await persistRules(supabase, touchedRuleIds, rulesById);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPA_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(SUPA_URL, SUPA_KEY);

  const log: any[] = [];

  try {
    const { data: rules, error } = await supabase.from('repricer_rules').select('id, data');
    if (error) throw error;

    const mrcRules = (rules ?? []).filter((r: any) =>
      r.data?.type === 'mrc' && r.data?.status === 'active' &&
      Array.isArray(r.data?.mrcItems) && r.data.mrcItems.length > 0,
    );

    await processOzon(supabase, mrcRules, log);
    await sleep(300);
    await processWb(supabase, mrcRules, log);
    await sleep(300);
    await processYandex(supabase, mrcRules, log);

    return new Response(JSON.stringify({ ok: true, rules: mrcRules.length, log }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e), log }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
