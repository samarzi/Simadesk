/**
 * analyticsOrderCache — кэш сырых API-заказов по КАЛЕНДАРНЫМ МЕСЯЦАМ.
 *
 * Ключевое свойство: чанк = ровно один календарный месяц (chunk_from = 1-е число, chunk_to = последнее).
 * Благодаря этому ЛЮБОЙ период (30д, 7д, "С начала") бьёт в те же кэш-записи —
 * не нужно заново грузить данные при переключении периодов.
 *
 * Кэшируются только ПРОШЕДШИЕ месяцы (не текущий — в нём ещё могут появляться заказы).
 */

import { supaFetch } from '@/services/supabaseClient';

export const SETTLED_DAYS = 7;

interface CacheRow {
  chunk_from: string; // YYYY-MM-DD (1-е число месяца)
  chunk_to:   string; // YYYY-MM-DD (последнее число месяца)
  data: any[];
}

function toStr(d: Date): string { return d.toISOString().slice(0, 10); }

/** Первый день указанного месяца (UTC). */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Последний день указанного месяца (UTC), 23:59:59.999. */
export function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

/** Прошедший ли месяц (не текущий) — такой можно кэшировать. */
export function isMonthSettled(d: Date): boolean {
  const now = new Date();
  const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return monthStart(d) < curMonthStart;
}

/** Ключ кэша для месяца по дате. */
export function monthCacheKey(d: Date): string {
  return `${toStr(monthStart(d))}|${toStr(monthEnd(d))}`;
}

/** Список календарных месяцев в диапазоне [start, end] (UTC). */
export function monthsInRange(start: Date, end: Date): Date[] {
  const months: Date[] = [];
  let m = monthStart(start);
  while (m <= end) {
    months.push(m);
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }
  return months;
}

export const analyticsOrderCache = {

  /**
   * Загрузить все закэшированные месяцы для магазина в диапазоне дат.
   * Возвращает Map<"YYYY-MM-DD|YYYY-MM-DD", orders[]>.
   */
  async loadRange(storeId: string, start: Date, end: Date): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();
    try {
      const from = toStr(monthStart(start));
      const to   = toStr(monthEnd(end));
      const rows = await supaFetch<CacheRow[]>(
        `analytics_orders_cache` +
        `?store_id=eq.${encodeURIComponent(storeId)}` +
        `&chunk_from=gte.${from}&chunk_to=lte.${to}` +
        `&select=chunk_from,chunk_to,data`,
      );
      for (const row of rows) {
        result.set(`${row.chunk_from}|${row.chunk_to}`, row.data);
      }
    } catch (e) {
      console.warn('[analyticsOrderCache] loadRange:', e);
    }
    return result;
  },

  /** Загрузить только ключи закэшированных месяцев (без данных — быстро). */
  async loadCachedKeys(storeId: string, start: Date, end: Date): Promise<Set<string>> {
    const keys = new Set<string>();
    try {
      const from = toStr(monthStart(start));
      const to   = toStr(monthEnd(end));
      const rows = await supaFetch<{ chunk_from: string; chunk_to: string }[]>(
        `analytics_orders_cache` +
        `?store_id=eq.${encodeURIComponent(storeId)}` +
        `&chunk_from=gte.${from}&chunk_to=lte.${to}` +
        `&select=chunk_from,chunk_to`,
      );
      for (const row of rows) {
        keys.add(`${row.chunk_from}|${row.chunk_to}`);
      }
    } catch (e) {
      console.warn('[analyticsOrderCache] loadCachedKeys:', e);
    }
    return keys;
  },

  /** Сохранить один месяц в кэш (в фоне — ошибки не критичны). */
  async saveMonth(storeId: string, mp: string, monthDate: Date, data: any[]): Promise<void> {
    const s = monthStart(monthDate);
    const e = monthEnd(monthDate);
    try {
      await supaFetch<any>('analytics_orders_cache', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          store_id:   storeId,
          mp,
          chunk_from: toStr(s),
          chunk_to:   toStr(e),
          data,
          cached_at:  new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.warn('[analyticsOrderCache] saveMonth:', e);
    }
  },

  /** Инвалидировать конкретный диапазон дат (для инкрементального обновления). */
  async invalidateRange(storeId: string, start: Date, end: Date): Promise<void> {
    try {
      const from = toStr(monthStart(start));
      const to   = toStr(monthEnd(end));
      await supaFetch<any>(
        `analytics_orders_cache` +
        `?store_id=eq.${encodeURIComponent(storeId)}` +
        `&chunk_from=gte.${from}&chunk_to=lte.${to}`,
        { method: 'DELETE' },
      );
    } catch (e) {
      console.warn('[analyticsOrderCache] invalidateRange:', e);
    }
  },

  /** Инвалидировать весь кэш магазина. */
  async invalidateStore(storeId: string): Promise<void> {
    try {
      await supaFetch<any>(`analytics_orders_cache?store_id=eq.${encodeURIComponent(storeId)}`, { method: 'DELETE' });
    } catch (e) {
      console.warn('[analyticsOrderCache] invalidateStore:', e);
    }
  },
};
