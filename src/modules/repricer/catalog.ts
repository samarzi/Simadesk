/**
 * Хелперы для работы с каталогом товаров всех маркетплейсов:
 * объединение по артикулу, получение остатков/цен/картинок для правил репрайсера.
 */

import type { WbProduct, WbStore } from '@/types/wb';
import type { OzonProduct, OzonStore } from '@/types/ozon';
import type { YandexProduct, YandexStore } from '@/types/yandex';
import type { Mp, RepricerRule, RuleProduct, UnifiedProduct } from './types';

export interface CatalogData {
  wbProducts: WbProduct[];
  wbStores: WbStore[];
  ozonProducts: OzonProduct[];
  ozonStores: OzonStore[];
  ymProducts: YandexProduct[];
  ymStores: YandexStore[];
}

/** Объединяет товары всех МП по артикулу (vendorCode). */
export function buildUnifiedProducts(data: CatalogData): UnifiedProduct[] {
  const map = new Map<string, UnifiedProduct>();
  const key = (s: string) => s.trim().toLowerCase();

  for (const p of data.wbProducts) {
    const code = p.vendor_code || String(p.nm_id);
    const k = key(code);
    if (!k) continue;
    const v = map.get(k) ?? { vendorCode: code, title: p.title || code, variants: [] };
    v.variants.push({
      mp: 'wb',
      storeId: p.store_id,
      storeName: data.wbStores.find(s => s.id === p.store_id)?.name ?? '',
      productId: String(p.nm_id),
      title: p.title || code,
      price: p.price ?? null,
      stock: p.stock_total ?? 0,
    });
    if (!v.title || v.title.length < (p.title?.length ?? 0)) v.title = p.title || v.title;
    map.set(k, v);
  }
  for (const p of data.ozonProducts) {
    const code = p.offer_id;
    const k = key(code);
    if (!k) continue;
    const v = map.get(k) ?? { vendorCode: code, title: p.name || code, variants: [] };
    v.variants.push({
      mp: 'ozon',
      storeId: p.store_id,
      storeName: data.ozonStores.find(s => s.id === p.store_id)?.name ?? '',
      productId: p.offer_id,
      title: p.name || code,
      price: p.price ?? null,
      stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0),
    });
    if (!v.title || v.title.length < (p.name?.length ?? 0)) v.title = p.name || v.title;
    map.set(k, v);
  }
  for (const p of data.ymProducts) {
    const code = p.vendor_code || p.offer_id;
    const k = key(code);
    if (!k) continue;
    const v = map.get(k) ?? { vendorCode: code, title: p.name || code, variants: [] };
    v.variants.push({
      mp: 'yandex',
      storeId: p.store_id,
      storeName: data.ymStores.find(s => s.id === p.store_id)?.name ?? '',
      productId: p.offer_id,
      title: p.name || code,
      price: p.basic_price ?? null,
      stock: p.stock_total ?? 0,
    });
    if (!v.title || v.title.length < (p.name?.length ?? 0)) v.title = p.name || v.title;
    map.set(k, v);
  }

  return [...map.values()].sort((a, b) => a.vendorCode.localeCompare(b.vendorCode));
}

/** Все магазины всех МП в едином списке (для пикера, формы и т.п.). */
export function allStoresFlat(data: CatalogData): Array<{ id: string; name: string; mp: Mp }> {
  return [
    ...data.wbStores.map(s   => ({ id: s.id, name: s.name, mp: 'wb'     as Mp })),
    ...data.ozonStores.map(s => ({ id: s.id, name: s.name, mp: 'ozon'   as Mp })),
    ...data.ymStores.map(s   => ({ id: s.id, name: s.name, mp: 'yandex' as Mp })),
  ];
}

/** Остаток конкретного товара (по marketplace + productId + storeId).
 *  storeId обязателен: offer_id/артикул задаётся продавцом и может совпасть
 *  у товаров из разных магазинов — без фильтра по магазину можно случайно
 *  взять остаток чужого товара с тем же артикулом. */
export function getStock(data: CatalogData, mp: Mp, productId: string, storeId: string): number {
  if (mp === 'wb') return data.wbProducts.find(p => String(p.nm_id) === productId && p.store_id === storeId)?.stock_total ?? 0;
  if (mp === 'ozon') {
    const p = data.ozonProducts.find(p => p.offer_id === productId && p.store_id === storeId);
    return (p?.stock_fbs ?? 0) + (p?.stock_fbo ?? 0);
  }
  return data.ymProducts.find(p => p.offer_id === productId && p.store_id === storeId)?.stock_total ?? 0;
}

/** Реальная цена товара на маркетплейсе сейчас (из последней синхронизации каталога). */
export function getCurrentPrice(data: CatalogData, rule: RepricerRule): number | null {
  if (rule.marketplace === 'wb') {
    return data.wbProducts.find(p => String(p.nm_id) === rule.productId && p.store_id === rule.storeId)?.price ?? null;
  }
  if (rule.marketplace === 'ozon') {
    return data.ozonProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId)?.price ?? null;
  }
  return data.ymProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId)?.basic_price ?? null;
}

/** Фото товара (первая картинка из карточки маркетплейса), если найдена в кэше. */
export function getProductImage(data: CatalogData, rule: RepricerRule): string | null {
  if (rule.marketplace === 'wb') {
    const p = data.wbProducts.find(p => String(p.nm_id) === rule.productId && p.store_id === rule.storeId);
    return p?.pictures?.[0] ?? null;
  }
  if (rule.marketplace === 'ozon') {
    const p = data.ozonProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId);
    return p?.images?.[0] ?? null;
  }
  const p = data.ymProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId);
  return p?.pictures?.[0] ?? null;
}

/** Резолвит productId товара для конкретного магазина по vendorCode (для создания правил на несколько магазинов). */
export function resolveProductForStore(data: CatalogData, store: { id: string; mp: Mp }, prod: RuleProduct): RuleProduct {
  let pid = prod.productId;
  if (store.mp === 'wb') {
    const p = data.wbProducts.find(p => (p.vendor_code === prod.vendorCode || String(p.nm_id) === prod.vendorCode) && p.store_id === store.id);
    if (p) pid = String(p.nm_id);
  } else if (store.mp === 'ozon') {
    const p = data.ozonProducts.find(p => p.offer_id === prod.vendorCode && p.store_id === store.id);
    if (p) pid = p.offer_id;
  } else {
    const p = data.ymProducts.find(p => (p.vendor_code === prod.vendorCode || p.offer_id === prod.vendorCode) && p.store_id === store.id);
    if (p) pid = p.offer_id;
  }
  return { ...prod, productId: pid };
}
