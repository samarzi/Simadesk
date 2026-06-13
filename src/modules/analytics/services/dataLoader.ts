/**
 * dataLoader — единая точка загрузки данных для Аналитики.
 * Делает параллельные запросы к API трёх МП + БД, собирает входы для агрегатора.
 */

import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { ozonOrdersApi, fetchAllPagesByCursor } from '@/services/ozonOrdersApi';
import { fetchAllYandexOrders } from '@/services/yandexApi';
import { fetchAllWbOrders, isWbCoolingDown } from '@/services/wbApi';
import { mpTransactionsDb, MpTransaction } from '@/services/mpTransactionsDb';
import { OzonPosting } from '@/types/ozon';
import { YandexOrder } from '@/types/yandex';
import { WbOrder } from '@/types/wb';
import { Mp, StoreInfo, TaxModel } from '../types';
import { ProductMap } from './orderAggregator';
import { settingsDb } from './settingsDb';

export interface LoadedData {
  ozonPostings: OzonPosting[];
  yandexOrders: YandexOrder[];
  wbOrders: WbOrder[];
  transactions: MpTransaction[];
  stores: StoreInfo[];
  products: ProductMap;
}

function normalizeTaxModel(raw: string | null | undefined): TaxModel {
  switch ((raw ?? '').toLowerCase()) {
    case 'usn6': case 'usn_6': return 'usn6';
    case 'usn15': case 'usn_15': return 'usn15';
    case 'osn': case 'osno': return 'osn';
    case 'npd': return 'npd';
    case 'patent': return 'patent';
    default: return 'none';
  }
}

export async function loadAllStores(): Promise<StoreInfo[]> {
  const [oz, ym, wb] = await Promise.all([
    ozonDb.getStores().catch(() => []),
    yandexDb.getStores().catch(() => []),
    wbDb.getStores().catch(() => []),
  ]);
  const settings = settingsDb.get();
  const make = (id: string, name: string, mp: Mp, raw: string | null | undefined, rate: number | null | undefined, ff: string | null | undefined): StoreInfo => {
    const override = settings.store_tax[id];
    return {
      id, name, mp,
      tax_model: override?.model ?? normalizeTaxModel(raw),
      tax_rate: override?.rate ?? ((rate ?? 0) / 100),
      fulfillment: ff ?? null,
    };
  };
  return [
    ...oz.map(s => make(s.id, s.name, 'ozon',   s.tax_model, s.tax_rate, s.fulfillment_model)),
    ...ym.map(s => make(s.id, s.name, 'yandex', s.tax_model, s.tax_rate, s.fulfillment_model)),
    ...wb.map(s => make(s.id, s.name, 'wb',     s.tax_model, s.tax_rate, s.fulfillment_model)),
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
  } catch {}
  try {
    const ps = await yandexDb.getProducts();
    for (const p of ps) {
      const info = { name: p.name, image: p.pictures?.[0], vendor_code: p.offer_id, mp_sku: p.market_sku ? String(p.market_sku) : undefined };
      map.set(`yandex|${p.offer_id}`, info);
      if (p.market_sku) map.set(`yandex|sku:${p.market_sku}`, info);
    }
  } catch {}
  try {
    const ps = await wbDb.getProducts();
    for (const p of ps) {
      const info = { name: p.title, image: p.pictures?.[0], vendor_code: p.vendor_code, mp_sku: String(p.nm_id) };
      map.set(`wb|${p.vendor_code}`, info);
      map.set(`wb|sku:${p.nm_id}`, info);
    }
  } catch {}
  return map;
}

function ymDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy}`;
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

  const ozonPostings: OzonPosting[] = [];
  const yandexOrders: YandexOrder[] = [];
  const wbOrders: WbOrder[] = [];

  // КЛЮЧЕВОЕ РЕШЕНИЕ для корректности длинных периодов:
  // Live order API маркетплейсов отдаёт надёжно только актуальные заказы (последние 60-90 дней).
  // На больших периодах Ozon FBO API ломается через 50 заказов (pagination bug),
  // WB Stats API упирается в rate-limits, YM /orders медленный.
  // Для исторических заказов (>60 дней назад) единственный надёжный источник — mp_transactions (финотчёт).
  // Аналитика после этого правильно сматчит live + tx и не будет терять/дублировать.
  const LIVE_WINDOW_DAYS = 60;
  const now = new Date();
  const liveEarliest = new Date(now.getTime() - LIVE_WINDOW_DAYS * 86400_000);
  const spanDays = (end.getTime() - start.getTime()) / 86400_000;
  const liveStart = spanDays > LIVE_WINDOW_DAYS && start < liveEarliest ? liveEarliest : start;
  if (liveStart !== start) {
    console.info(`[Analytics] Live orders API: ограничиваем окно до ${LIVE_WINDOW_DAYS} дней (${liveStart.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}). Заказы старше будут взяты из финотчёта (mp_transactions).`);
  }

  const ymFrom = ymDate(liveStart), ymTo = ymDate(end);
  const wbFrom = liveStart.toISOString().slice(0, 19);

  await Promise.all([
    ...ozStores.map(async store => {
      const creds = { client_id: store.client_id, api_key: store.api_key };
      const seen = new Set<string>();
      const CHUNK = 30 * 24 * 3600 * 1000;
      let s = liveStart;
      while (s < end) {
        const e = new Date(Math.min(s.getTime() + CHUNK, end.getTime()));
        if (signal?.aborted) return;
        try {
          const fbs = await fetchAllPagesByCursor(
            (lim, cur, sig) => ozonOrdersApi.getFbsPostings(creds, s.toISOString(), e.toISOString(), null, lim, cur, sig),
            50, signal,
          );
          for (const p of fbs) {
            if (seen.has(p.posting_number)) continue;
            seen.add(p.posting_number); p.store_id = store.id; ozonPostings.push(p);
          }
          // FBO пагинация по offset. Ozon API имеет баг: при больших offset может
          // возвращать те же posting_number с has_next=true — поэтому если страница
          // не принесла ни одного НОВОГО заказа, останавливаемся. Плюс жёсткий кап.
          let off = 0;
          const FBO_MAX_PAGES = 200; // 10 000 заказов за 30 дней на 1 чанк — с запасом
          for (let page = 0; page < FBO_MAX_PAGES; page++) {
            if (signal?.aborted) return;
            const fbo = await ozonOrdersApi.getFboPostings(creds, s.toISOString(), e.toISOString(), 50, off, signal);
            const hasNext = (fbo as any).__hasNext;
            let added = 0;
            for (const p of fbo) {
              if (seen.has(p.posting_number)) continue;
              seen.add(p.posting_number); p.store_id = store.id; ozonPostings.push(p);
              added++;
            }
            if (!hasNext || fbo.length === 0) break;
            if (added === 0) {
              console.warn(`[Analytics] Ozon FBO: страница ${page} (offset=${off}) — все ${fbo.length} заказов уже видены, останавливаемся (API pagination bug)`);
              break;
            }
            off += 50;
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') console.warn('[Analytics] Ozon:', err.message);
        }
        s = new Date(e.getTime() + 1);
      }
    }),
    ...ymStores.map(async store => {
      try { yandexOrders.push(...await fetchAllYandexOrders(store, ymFrom, ymTo, signal)); }
      catch (err: any) { if (err?.name !== 'AbortError') console.warn('[Analytics] YM:', err.message); }
    }),
    ...wbStores.map(async store => {
      if (isWbCoolingDown()) return;
      try { wbOrders.push(...await fetchAllWbOrders(store, wbFrom, signal)); }
      catch (err: any) { if (err?.name !== 'AbortError') console.warn('[Analytics] WB:', err.message); }
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
