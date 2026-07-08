/**
 * dataLoader — единая точка загрузки данных для Аналитики.
 *
 * loadOrders() делегирует в orderSyncService.queryOrders(), который:
 *  - Читает прошедшие месяцы из кэша analytics_orders_cache
 *  - Тянет из API только текущий месяц (и отсутствующие в кэше)
 *  - Работает без ограничения в 60 дней — полный период доступен сразу
 */

import { debug } from '@/utils/debug';
import { ozonDb }          from '@/services/ozonDb';
import { wbDb }            from '@/services/wbDb';
import { yandexDb }        from '@/services/yandexDb';
import { mpTransactionsDb, MpTransaction } from '@/services/mpTransactionsDb';
import { orderSyncService, QueryProgress }  from '@/services/orderSyncService';
export type { QueryProgress };
import { OzonPosting }  from '@/types/ozon';
import { YandexOrder }  from '@/types/yandex';
import { WbOrder }      from '@/types/wb';
import { Mp, StoreInfo, TaxModel } from '../types';
import { ProductMap }   from './orderAggregator';
import { settingsDb }   from './settingsDb';

export interface LoadedData {
  ozonPostings: OzonPosting[];
  yandexOrders: YandexOrder[];
  wbOrders:     WbOrder[];
  transactions: MpTransaction[];
  stores:       StoreInfo[];
  products:     ProductMap;
}

function normalizeTaxModel(raw: string | null | undefined): TaxModel {
  switch ((raw ?? '').toLowerCase()) {
    case 'usn6':  case 'usn_6':  return 'usn6';
    case 'usn15': case 'usn_15': return 'usn15';
    case 'osn':   case 'osno':   return 'osn';
    case 'npd':                  return 'npd';
    case 'patent':               return 'patent';
    default:                     return 'none';
  }
}

export async function loadAllStores(): Promise<StoreInfo[]> {
  const [oz, ym, wb] = await Promise.all([
    ozonDb.getStores().catch(() => []),
    yandexDb.getStores().catch(() => []),
    wbDb.getStores().catch(() => []),
  ]);
  const settings = settingsDb.get();
  const make = (
    id: string, name: string, mp: Mp,
    raw: string | null | undefined,
    rate: number | null | undefined,
    ff: string | null | undefined,
    created_at?: string,
  ): StoreInfo => {
    const override = settings.store_tax[id];
    return {
      id, name, mp,
      tax_model:   override?.model ?? normalizeTaxModel(raw),
      tax_rate:    override?.rate  ?? ((rate ?? 0) / 100),
      fulfillment: ff ?? null,
      created_at,
    };
  };
  return [
    ...oz.map(s => make(s.id, s.name, 'ozon',   s.tax_model, s.tax_rate, s.fulfillment_model, s.created_at)),
    ...ym.map(s => make(s.id, s.name, 'yandex', s.tax_model, s.tax_rate, s.fulfillment_model, s.created_at)),
    ...wb.map(s => make(s.id, s.name, 'wb',     s.tax_model, s.tax_rate, s.fulfillment_model, s.created_at)),
  ];
}

export async function buildProductMap(): Promise<ProductMap> {
  const map: ProductMap = new Map();
  try {
    const ps = await ozonDb.getProducts();
    for (const p of ps) {
      const info = { name: p.name, image: p.images?.[0], vendor_code: p.offer_id, mp_sku: p.sku ? String(p.sku) : undefined };
      map.set(`ozon|${p.offer_id}`, info);
      if (p.sku) map.set(`ozon|sku:${p.sku}`, info);
    }
  } catch (e) { debug.warn('[dataLoader] swallowed error', e); }
  try {
    const ps = await yandexDb.getProducts();
    for (const p of ps) {
      const info = { name: p.name, image: p.pictures?.[0], vendor_code: p.offer_id, mp_sku: p.market_sku ? String(p.market_sku) : undefined };
      map.set(`yandex|${p.offer_id}`, info);
      if (p.market_sku) map.set(`yandex|sku:${p.market_sku}`, info);
    }
  } catch (e) { debug.warn('[dataLoader] swallowed error', e); }
  try {
    const ps = await wbDb.getProducts();
    for (const p of ps) {
      const info = { name: p.title, image: p.pictures?.[0], vendor_code: p.vendor_code, mp_sku: String(p.nm_id) };
      map.set(`wb|${p.vendor_code}`, info);
      map.set(`wb|sku:${p.nm_id}`, info);
    }
  } catch (e) { debug.warn('[dataLoader] swallowed error', e); }
  return map;
}


export async function loadOrders(
  start: Date, end: Date,
  storeIds: Set<string>,
  signal?: AbortSignal,
  onProgress?: (p: QueryProgress) => void,
): Promise<{ ozonPostings: OzonPosting[]; yandexOrders: YandexOrder[]; wbOrders: WbOrder[] }> {
  return orderSyncService.queryOrders(storeIds, start, end, signal, onProgress);
}

export async function loadTransactions(
  storeIds: string[], start: Date, end: Date,
): Promise<MpTransaction[]> {
  if (!storeIds.length) return [];
  try { return await mpTransactionsDb.getByStores(storeIds, start.toISOString(), end.toISOString()); }
  catch (e) { console.warn('[Analytics] transactions:', e); return []; }
}
