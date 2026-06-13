/**
 * dataLoader — единая точка загрузки данных для Аналитики.
 *
 * Кэш по КАЛЕНДАРНЫМ МЕСЯЦАМ:
 *  - Прошедшие месяцы (не текущий) кэшируются в analytics_orders_cache.
 *  - При повторном открытии любого периода (30д, 7д, "С начала") данные
 *    за прошедшие месяцы берутся из кэша — из API тянется только текущий месяц.
 *  - WB API не имеет верхней границы даты, поэтому кэшируем его тоже помесячно,
 *    запрашивая каждый раз с начала самого раннего незакэшированного месяца
 *    и разбивая результат по месяцам.
 */

import { debug } from '@/utils/debug';
import { ozonDb }          from '@/services/ozonDb';
import { wbDb }            from '@/services/wbDb';
import { yandexDb }        from '@/services/yandexDb';
import { ozonOrdersApi, fetchAllPagesByCursor } from '@/services/ozonOrdersApi';
import { fetchAllYandexOrders }                  from '@/services/yandexApi';
import { fetchAllWbOrders, isWbCoolingDown }      from '@/services/wbApi';
import { mpTransactionsDb, MpTransaction }        from '@/services/mpTransactionsDb';
import { analyticsOrderCache, monthStart, monthEnd, isMonthSettled, monthCacheKey } from '@/services/analyticsOrderCache';
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

function ymDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2,'0')}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${d.getUTCFullYear()}`;
}

/** Список календарных месяцев в диапазоне [start, end]. */
function monthsInRange(start: Date, end: Date): Date[] {
  const months: Date[] = [];
  let m = monthStart(start);
  while (m <= end) {
    months.push(m);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }
  return months;
}

export async function loadOrders(
  start: Date, end: Date,
  storeIds: Set<string>,
  signal?: AbortSignal,
): Promise<{ ozonPostings: OzonPosting[]; yandexOrders: YandexOrder[]; wbOrders: WbOrder[] }> {
  const [oz, ym, wb] = await Promise.all([
    ozonDb.getStores().catch(() => []),
    yandexDb.getStores().catch(() => []),
    wbDb.getStores().catch(() => []),
  ]);
  const ozStores = oz.filter(s => storeIds.has(s.id));
  const ymStores = ym.filter(s => storeIds.has(s.id));
  const wbStores = wb.filter(s => storeIds.has(s.id));

  // Live API надёжно отдаёт только последние ~60 дней.
  // Заказы старше идут из mp_transactions (финотчёт).
  const LIVE_WINDOW_DAYS = 60;
  const now = new Date();
  const liveEarliest = new Date(now.getTime() - LIVE_WINDOW_DAYS * 86400_000);
  const spanDays = (end.getTime() - start.getTime()) / 86400_000;
  const liveStart = spanDays > LIVE_WINDOW_DAYS && start < liveEarliest ? liveEarliest : start;
  if (liveStart !== start) {
    console.info(`[Analytics] Live API capped to ${LIVE_WINDOW_DAYS}d (${liveStart.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)})`);
  }
  // Инвертированный диапазон — возвращаем пустой результат (может быть при loadPrev далёкого прошлого)
  if (liveStart > end) return { ozonPostings: [], yandexOrders: [], wbOrders: [] };

  const ozonPostings: OzonPosting[] = [];
  const yandexOrders: YandexOrder[]  = [];
  const wbOrders:     WbOrder[]      = [];

  // Предзагружаем месячный кэш для всех магазинов
  const ozCache = new Map<string, Map<string, OzonPosting[]>>();
  const ymCache = new Map<string, Map<string, YandexOrder[]>>();
  const wbCache = new Map<string, Map<string, WbOrder[]>>();
  await Promise.all([
    ...ozStores.map(async s => { ozCache.set(s.id, await analyticsOrderCache.loadRange(s.id, liveStart, end) as any); }),
    ...ymStores.map(async s => { ymCache.set(s.id, await analyticsOrderCache.loadRange(s.id, liveStart, end) as any); }),
    ...wbStores.map(async s => { wbCache.set(s.id, await analyticsOrderCache.loadRange(s.id, liveStart, end) as any); }),
  ]);

  await Promise.all([

    // ── Ozon: по месяцам ────────────────────────────────────────────────
    ...ozStores.map(async store => {
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const seen  = new Set<string>();
      const cache = ozCache.get(store.id) ?? new Map();

      for (const monthDate of monthsInRange(liveStart, end)) {
        if (signal?.aborted) return;

        const mStart = monthStart(monthDate);
        const mEnd   = monthEnd(monthDate);
        const key    = monthCacheKey(monthDate);
        const s      = mStart < liveStart ? liveStart : mStart;
        const e      = mEnd   > end       ? end       : mEnd;

        // Закэшированный прошлый месяц — берём из кэша
        if (isMonthSettled(monthDate) && cache.has(key)) {
          const cached = cache.get(key) as OzonPosting[];
          for (const p of cached) {
            if (!seen.has(p.posting_number)) {
              seen.add(p.posting_number);
              ozonPostings.push({ ...p, store_id: store.id });
            }
          }
          console.debug(`[Analytics][cache] Ozon ${store.name} ${key} — ${cached.length} из кэша`);
          continue;
        }

        // Грузим из API
        const monthPostings: OzonPosting[] = [];
        try {
          const fbs = await fetchAllPagesByCursor(
            (lim, cur, sig) => ozonOrdersApi.getFbsPostings(creds, s.toISOString(), e.toISOString(), null, lim, cur, sig),
            50, signal,
          );
          for (const p of fbs) {
            if (seen.has(p.posting_number)) continue;
            seen.add(p.posting_number); p.store_id = store.id;
            ozonPostings.push(p); monthPostings.push(p);
          }
          let off = 0;
          for (let page = 0; page < 200; page++) {
            if (signal?.aborted) return;
            const fbo = await ozonOrdersApi.getFboPostings(creds, s.toISOString(), e.toISOString(), 50, off, signal);
            const hasNext = (fbo as any).__hasNext;
            let added = 0;
            for (const p of fbo) {
              if (seen.has(p.posting_number)) continue;
              seen.add(p.posting_number); p.store_id = store.id;
              ozonPostings.push(p); monthPostings.push(p); added++;
            }
            if (!hasNext || fbo.length === 0) break;
            if (added === 0) { console.warn(`[Analytics] Ozon FBO pagination bug at offset=${off}`); break; }
            off += 50;
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') console.warn('[Analytics] Ozon:', err.message);
        }

        // Сохраняем в кэш только прошедшие месяцы (в фоне)
        if (isMonthSettled(monthDate)) {
          analyticsOrderCache.saveMonth(store.id, 'ozon', monthDate, monthPostings);
        }
      }
    }),

    // ── Yandex Market: по месяцам ────────────────────────────────────────
    ...ymStores.map(async store => {
      const cache = ymCache.get(store.id) ?? new Map();

      for (const monthDate of monthsInRange(liveStart, end)) {
        if (signal?.aborted) return;

        const mStart = monthStart(monthDate);
        const mEnd   = monthEnd(monthDate);
        const key    = monthCacheKey(monthDate);
        const s      = mStart < liveStart ? liveStart : mStart;
        const e      = mEnd   > end       ? end       : mEnd;

        if (isMonthSettled(monthDate) && cache.has(key)) {
          const cached = cache.get(key) as YandexOrder[];
          yandexOrders.push(...cached);
          console.debug(`[Analytics][cache] YM ${store.name} ${key} — ${cached.length} из кэша`);
          continue;
        }

        const monthOrders: YandexOrder[] = [];
        try {
          const fetched = await fetchAllYandexOrders(store, ymDate(s), ymDate(e), signal);
          yandexOrders.push(...fetched);
          monthOrders.push(...fetched);
        } catch (err: any) {
          if (err?.name !== 'AbortError') console.warn('[Analytics] YM:', err.message);
        }

        if (isMonthSettled(monthDate)) {
          analyticsOrderCache.saveMonth(store.id, 'yandex', monthDate, monthOrders);
        }
      }
    }),

    // ── Wildberries: один запрос с начала самого раннего незакэшированного месяца
    //    Результат разбиваем по месяцам и кэшируем каждый отдельно.
    ...wbStores.map(async store => {
      if (isWbCoolingDown()) return;

      const cache  = wbCache.get(store.id) ?? new Map();
      const months = monthsInRange(liveStart, end);

      // Найдём первый незакэшированный прошлый месяц (или текущий месяц)
      let fetchFrom: Date | null = null;
      for (const monthDate of months) {
        const key = monthCacheKey(monthDate);
        if (isMonthSettled(monthDate) && cache.has(key)) {
          // Прошлый месяц закэширован — берём данные и идём дальше
          const cached = cache.get(key) as WbOrder[];
          wbOrders.push(...cached);
          console.debug(`[Analytics][cache] WB ${store.name} ${monthCacheKey(monthDate)} — ${cached.length} из кэша`);
        } else {
          // Первый незакэшированный месяц — с него начнём запрос к API
          if (!fetchFrom) {
            const mStart = monthStart(monthDate);
            fetchFrom = mStart < liveStart ? liveStart : mStart;
          }
        }
      }

      if (!fetchFrom) return; // всё из кэша

      try {
        const fetched = await fetchAllWbOrders(store, fetchFrom.toISOString().slice(0, 19), signal);
        wbOrders.push(...fetched);

        // Разбиваем результат по месяцам для кэша
        const byMonth = new Map<string, WbOrder[]>();
        for (const order of fetched) {
          const d = new Date(order.created_at || 0);
          const key = monthCacheKey(d);
          if (!byMonth.has(key)) byMonth.set(key, []);
          byMonth.get(key)!.push(order);
        }
        // Сохраняем прошедшие месяцы в кэш (в фоне)
        for (const monthDate of months) {
          if (!isMonthSettled(monthDate)) continue;
          const key = monthCacheKey(monthDate);
          if (cache.has(key)) continue; // уже было в кэше
          const monthOrders = byMonth.get(key) ?? [];
          analyticsOrderCache.saveMonth(store.id, 'wb', monthDate, monthOrders);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.warn('[Analytics] WB:', err.message);
      }
    }),
  ]);

  return { ozonPostings, yandexOrders, wbOrders };
}

export async function loadTransactions(
  storeIds: string[], start: Date, end: Date,
): Promise<MpTransaction[]> {
  if (!storeIds.length) return [];
  try { return await mpTransactionsDb.getByStores(storeIds, start.toISOString(), end.toISOString()); }
  catch (e) { console.warn('[Analytics] transactions:', e); return []; }
}
