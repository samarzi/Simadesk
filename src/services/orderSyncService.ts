/**
 * orderSyncService — единая точка хранения и обновления заказов.
 *
 * Принцип работы:
 *   1. При старте приложения init() запускается в фоне.
 *   2. Ozon и Яндекс Маркет синхронизируются сразу — без задержки.
 *   3. WB синхронизируется через 30 сек — даём HomeDashboard/AllOrders отработать.
 *   4. Для каждого магазина подтягиваем отсутствующие исторические месяцы.
 *   5. Раз в 20 часов обновляем последние 2 месяца (статусы могут меняться).
 *   6. queryOrders() использует _inFlight чтобы не дублировать API-запросы
 *      когда фоновый синк уже качает тот же месяц.
 *
 * Хранилище: таблица analytics_orders_cache в Supabase.
 * Текущий месяц никогда не кэшируется — всегда тянется свежим из API.
 */

import { ozonDb }          from '@/services/ozonDb';
import { wbDb }            from '@/services/wbDb';
import { yandexDb }        from '@/services/yandexDb';
import { ozonOrdersApi, fetchAllPagesByCursor } from '@/services/ozonOrdersApi';
import { fetchAllYandexOrders } from '@/services/yandexApi';
import { fetchAllWbOrders, isWbCoolingDown } from '@/services/wbApi';
import {
  analyticsOrderCache,
  monthStart, monthEnd, isMonthSettled, monthCacheKey, monthsInRange,
} from '@/services/analyticsOrderCache';
import { OzonPosting }  from '@/types/ozon';
import { YandexOrder }  from '@/types/yandex';
import { WbOrder }      from '@/types/wb';

const INCREMENTAL_TS_KEY = 'order_sync_incremental_v1';
const INCREMENTAL_TTL_MS = 20 * 60 * 60 * 1000; // 20 часов
const ROLLING_MONTHS = 2;
const FALLBACK_EARLIEST = '2023-01-01';
// Задержка перед WB-синком — ждём пока HomeDashboard/AllOrders отработают
const WB_SYNC_DELAY_MS = 30_000;

function toStr(d: Date): string { return d.toISOString().slice(0, 10); }

function ymDateStr(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2,'0')}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${d.getUTCFullYear()}`;
}

function getEarliestDate(createdAt: string | null | undefined): Date {
  if (createdAt) {
    const d = new Date(createdAt);
    if (!isNaN(d.getTime())) return monthStart(d);
  }
  return new Date(FALLBACK_EARLIEST);
}

export interface OrderSyncStatus {
  syncing: boolean;
  syncedStores: number;
  totalStores: number;
  currentStore?: string;
}

export interface OrderQueryResult {
  ozonPostings: OzonPosting[];
  yandexOrders: YandexOrder[];
  wbOrders:     WbOrder[];
}

export interface QueryProgress {
  done:    number;  // обработано (store × month) единиц
  total:   number;  // всего единиц
  cached:  number;  // из кэша
  fetched: number;  // из API
  errors:  number;  // ошибок
  currentLabel: string; // "янв. 2024 · StoreName"
}

type StatusListener = (s: OrderSyncStatus) => void;

class OrderSyncService {
  private _running    = false;
  private _initGen    = 0;
  private _listeners: StatusListener[] = [];
  private _status: OrderSyncStatus = { syncing: false, syncedStores: 0, totalStores: 0 };
  // Месяцы в процессе синхронизации: ключ = "platform:storeId:YYYY-MM"
  // queryOrders ждёт завершения вместо дублированного API-запроса
  private _inFlight = new Map<string, Promise<void>>();

  // ── Public API ──────────────────────────────────────────────────────────────

  onStatus(fn: StatusListener): () => void {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(l => l !== fn); };
  }

  get status(): OrderSyncStatus { return this._status; }

  /**
   * Запускается при старте приложения (в фоне, не блокирует UI).
   * Ozon и YM — сразу. WB — через 30 сек (избегаем 429 при конкуренции с UI).
   */
  async init(): Promise<void> {
    if (this._running) return;
    const gen = ++this._initGen;
    this._running = true;
    try {
      const [ozStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores().catch(() => [] as any[]),
        wbDb.getStores().catch(() => [] as any[]),
        yandexDb.getStores().catch(() => [] as any[]),
      ]);

      const totalStores = ozStores.length + wbStores.length + ymStores.length;
      if (totalStores === 0) return;

      const now = new Date();
      const lastTs = parseInt(localStorage.getItem(INCREMENTAL_TS_KEY) || '0');
      const needsIncremental = Date.now() - lastTs > INCREMENTAL_TTL_MS;
      let done = 0;

      this._emit({ syncing: true, syncedStores: 0, totalStores });

      const tick = (name: string) => {
        done++;
        this._emit({ syncing: true, syncedStores: done, totalStores, currentStore: name });
      };

      // Ozon и YM — без задержки, греют кэш пока пользователь изучает другие разделы
      await Promise.all([
        ...ozStores.map(async store => {
          await this._syncOzonStore(store, now, needsIncremental).catch(e =>
            console.warn(`[OrderSync] Ozon ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
        ...ymStores.map(async store => {
          await this._syncYandexStore(store, now, needsIncremental).catch(e =>
            console.warn(`[OrderSync] YM ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
      ]);

      if (this._initGen !== gen) return;

      // WB — ждём пока UI-запросы на старте отработают
      await new Promise(r => setTimeout(r, WB_SYNC_DELAY_MS));
      if (this._initGen !== gen) return;

      await Promise.all(
        wbStores.map(async store => {
          await this._syncWbStore(store, now, needsIncremental).catch(e =>
            console.warn(`[OrderSync] WB ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
      );

      if (this._initGen !== gen) return;

      if (needsIncremental) {
        localStorage.setItem(INCREMENTAL_TS_KEY, String(Date.now()));
      }
      console.info(`[OrderSync] Синхронизация завершена (${totalStores} магазинов)`);
    } catch (e) {
      console.warn('[OrderSync] init error:', e);
    } finally {
      if (this._initGen === gen) {
        this._running = false;
        this._emit({ syncing: false, syncedStores: 0, totalStores: 0 });
      }
    }
  }

  /**
   * Принудительное обновление (кнопка "Обновить").
   * Сбрасывает последние 2 месяца и синхронизирует всё без задержек.
   */
  async forceIncremental(): Promise<void> {
    localStorage.removeItem(INCREMENTAL_TS_KEY);
    ++this._initGen; // отменяем ожидающий init()
    this._running = true;
    try {
      const [ozStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores().catch(() => [] as any[]),
        wbDb.getStores().catch(() => [] as any[]),
        yandexDb.getStores().catch(() => [] as any[]),
      ]);

      const totalStores = ozStores.length + wbStores.length + ymStores.length;
      if (totalStores === 0) return;

      const now = new Date();
      let done = 0;
      this._emit({ syncing: true, syncedStores: 0, totalStores });

      const tick = (name: string) => {
        done++;
        this._emit({ syncing: true, syncedStores: done, totalStores, currentStore: name });
      };

      await Promise.all([
        ...ozStores.map(async store => {
          await this._syncOzonStore(store, now, true).catch(e =>
            console.warn(`[OrderSync] Ozon ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
        ...ymStores.map(async store => {
          await this._syncYandexStore(store, now, true).catch(e =>
            console.warn(`[OrderSync] YM ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
        ...wbStores.map(async store => {
          await this._syncWbStore(store, now, true).catch(e =>
            console.warn(`[OrderSync] WB ${store.name}:`, e?.message),
          );
          tick(store.name);
        }),
      ]);

      localStorage.setItem(INCREMENTAL_TS_KEY, String(Date.now()));
      console.info(`[OrderSync] forceIncremental завершён (${totalStores} магазинов)`);
    } catch (e) {
      console.warn('[OrderSync] forceIncremental error:', e);
    } finally {
      this._running = false;
      this._emit({ syncing: false, syncedStores: 0, totalStores: 0 });
    }
  }

  /**
   * Основной метод запроса заказов — используется вместо прямых API-вызовов.
   *
   * Логика:
   *   - Прошлые месяцы: кэш → если нет, ждём _inFlight (фоновый синк) → если нет, API
   *   - Текущий месяц: всегда из API (свежие данные)
   *   - onProgress: вызывается после каждого обработанного (магазин × месяц)
   */
  async queryOrders(
    storeIds: Set<string> | null,
    start: Date,
    end: Date,
    signal?: AbortSignal,
    onProgress?: (p: QueryProgress) => void,
  ): Promise<OrderQueryResult> {
    const [ozStores, ymStores, wbStores] = await Promise.all([
      ozonDb.getStores().catch(() => [] as any[]),
      yandexDb.getStores().catch(() => [] as any[]),
      wbDb.getStores().catch(() => [] as any[]),
    ]);

    const oz = storeIds ? ozStores.filter(s => storeIds.has(s.id)) : ozStores;
    const ym = storeIds ? ymStores.filter(s => storeIds.has(s.id)) : ymStores;
    const wb = storeIds ? wbStores.filter(s => storeIds.has(s.id)) : wbStores;

    const ozonPostings: OzonPosting[] = [];
    const yandexOrders: YandexOrder[] = [];
    const wbOrders:     WbOrder[]     = [];

    // Прогресс: (store × month) — одна единица на каждую пару
    const allMonths = monthsInRange(start, end);
    const progressTotal = (oz.length + ym.length + wb.length) * allMonths.length;
    let _done = 0, _cached = 0, _fetched = 0, _errors = 0;
    const tick = (wasCached: boolean, hadError: boolean, label: string) => {
      _done++;
      if (wasCached) _cached++;
      else if (hadError) _errors++;
      else _fetched++;
      onProgress?.({ done: _done, total: progressTotal, cached: _cached, fetched: _fetched, errors: _errors, currentLabel: label });
    };
    const mLabel = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric', timeZone: 'UTC' });

    // Предзагружаем кэш для всех магазинов одним батчем
    const ozCache = new Map<string, Map<string, any[]>>();
    const ymCache = new Map<string, Map<string, any[]>>();
    const wbCache = new Map<string, Map<string, any[]>>();
    await Promise.all([
      ...oz.map(async s => { ozCache.set(s.id, await analyticsOrderCache.loadRange(s.id, start, end)); }),
      ...ym.map(async s => { ymCache.set(s.id, await analyticsOrderCache.loadRange(s.id, start, end)); }),
      ...wb.map(async s => { wbCache.set(s.id, await analyticsOrderCache.loadRange(s.id, start, end)); }),
    ]);

    await Promise.all([

      // ── Ozon ────────────────────────────────────────────────────────────────
      ...oz.map(async store => {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const seen  = new Set<string>();
        const cache = ozCache.get(store.id) ?? new Map();

        for (const monthDate of monthsInRange(start, end)) {
          if (signal?.aborted) return;

          const mStart = monthStart(monthDate);
          const mEnd   = monthEnd(monthDate);
          const key    = monthCacheKey(monthDate);
          const s      = mStart < start ? start : mStart;
          const e      = mEnd   > end   ? end   : mEnd;
          const label  = `${mLabel(monthDate)} · ${store.name}`;

          // Кэш-хит
          if (isMonthSettled(monthDate) && cache.has(key)) {
            for (const p of cache.get(key) as OzonPosting[]) {
              if (!seen.has(p.posting_number)) {
                seen.add(p.posting_number);
                ozonPostings.push({ ...p, store_id: store.id });
              }
            }
            tick(true, false, label);
            continue;
          }

          // Фоновый синк уже тянет этот месяц — ждём его и читаем из кэша
          const flightKey = `ozon:${store.id}:${key}`;
          if (isMonthSettled(monthDate) && this._inFlight.has(flightKey)) {
            await this._inFlight.get(flightKey)!.catch(() => {});
            const fresh = await analyticsOrderCache.loadRange(store.id, mStart, mEnd);
            if (fresh.has(key)) {
              for (const p of fresh.get(key) as OzonPosting[]) {
                if (!seen.has(p.posting_number)) {
                  seen.add(p.posting_number);
                  ozonPostings.push({ ...p, store_id: store.id });
                }
              }
              tick(true, false, label);
              continue;
            }
          }

          // Нет в кэше — тянем из API
          const monthPostings: OzonPosting[] = [];
          let hadError = false;
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
              if (added === 0) break;
              off += 50;
            }
          } catch (err: any) {
            if (err?.name !== 'AbortError') { console.warn('[OrderSync] Ozon query:', err?.message); hadError = true; }
          }

          // Не кэшируем частично догруженный месяц — иначе недокачанные из-за
          // сбоя страницы (429/таймаут) навсегда потеряются: settled-месяц больше
          // никогда не перекачается сам. Пусть в следующий раз попробует заново.
          if (isMonthSettled(monthDate) && !hadError) {
            analyticsOrderCache.saveMonth(store.id, 'ozon', monthDate, monthPostings);
          }
          tick(false, hadError, label);
        }
      }),

      // ── Yandex Market ───────────────────────────────────────────────────────
      ...ym.map(async store => {
        const cache = ymCache.get(store.id) ?? new Map();

        for (const monthDate of monthsInRange(start, end)) {
          if (signal?.aborted) return;

          const mStart = monthStart(monthDate);
          const mEnd   = monthEnd(monthDate);
          const key    = monthCacheKey(monthDate);
          const s      = mStart < start ? start : mStart;
          const e      = mEnd   > end   ? end   : mEnd;
          const label  = `${mLabel(monthDate)} · ${store.name}`;

          if (isMonthSettled(monthDate) && cache.has(key)) {
            yandexOrders.push(...(cache.get(key) as YandexOrder[]));
            tick(true, false, label);
            continue;
          }

          const flightKey = `yandex:${store.id}:${key}`;
          if (isMonthSettled(monthDate) && this._inFlight.has(flightKey)) {
            await this._inFlight.get(flightKey)!.catch(() => {});
            const fresh = await analyticsOrderCache.loadRange(store.id, mStart, mEnd);
            if (fresh.has(key)) {
              yandexOrders.push(...(fresh.get(key) as YandexOrder[]));
              tick(true, false, label);
              continue;
            }
          }

          const monthOrders: YandexOrder[] = [];
          let hadError = false;
          try {
            const fetched = await fetchAllYandexOrders(store, ymDateStr(s), ymDateStr(e), signal);
            yandexOrders.push(...fetched);
            monthOrders.push(...fetched);
          } catch (err: any) {
            if (err?.name !== 'AbortError') { console.warn('[OrderSync] YM query:', err?.message); hadError = true; }
          }

          // См. комментарий в Ozon-ветке выше — не кэшируем частичный результат.
          if (isMonthSettled(monthDate) && !hadError) {
            analyticsOrderCache.saveMonth(store.id, 'yandex', monthDate, monthOrders);
          }
          tick(false, hadError, label);
        }
      }),

      // ── Wildberries ─────────────────────────────────────────────────────────
      ...wb.map(async store => {
        if (isWbCoolingDown()) {
          // WB охлаждается — отмечаем все месяцы как "ошибка" чтобы счётчик сошёлся
          for (let i = 0; i < allMonths.length; i++) tick(false, true, `WB · ${store.name} (rate limit)`);
          return;
        }

        const cache  = wbCache.get(store.id) ?? new Map();
        const months = monthsInRange(start, end);

        // Ждём если WB-синк в процессе для любого из нужных месяцев
        const wbFlightPromises: Promise<void>[] = [];
        for (const monthDate of months) {
          if (!isMonthSettled(monthDate)) continue;
          const k = `wb:${store.id}:${monthCacheKey(monthDate)}`;
          if (this._inFlight.has(k)) wbFlightPromises.push(this._inFlight.get(k)!.catch(() => {}));
        }
        if (wbFlightPromises.length > 0) {
          await Promise.all(wbFlightPromises);
          const fresh = await analyticsOrderCache.loadRange(store.id, start, end);
          for (const monthDate of months) {
            const k = monthCacheKey(monthDate);
            const label = `${mLabel(monthDate)} · ${store.name}`;
            if (isMonthSettled(monthDate) && fresh.has(k)) {
              wbOrders.push(...(fresh.get(k) as WbOrder[]));
              tick(true, false, label);
            } else {
              tick(false, false, label); // текущий месяц
            }
          }
          return;
        }

        // Определяем какие месяцы кэшированы (тикаем сразу), какие нет
        let fetchFrom: Date | null = null;
        const uncachedMonths: Date[] = [];
        for (const monthDate of months) {
          const key   = monthCacheKey(monthDate);
          const label = `${mLabel(monthDate)} · ${store.name}`;
          if (isMonthSettled(monthDate) && cache.has(key)) {
            wbOrders.push(...(cache.get(key) as WbOrder[]));
            tick(true, false, label);
          } else {
            uncachedMonths.push(monthDate);
            if (!fetchFrom) {
              const mStart = monthStart(monthDate);
              fetchFrom = mStart < start ? start : mStart;
            }
          }
        }

        if (!fetchFrom) return;

        let hadError = false;
        try {
          const fetched = await fetchAllWbOrders(store, fetchFrom.toISOString().slice(0, 19), signal);
          wbOrders.push(...fetched);

          const byMonth = new Map<string, WbOrder[]>();
          for (const order of fetched) {
            const d = new Date(order.created_at || 0);
            const k = monthCacheKey(d);
            if (!byMonth.has(k)) byMonth.set(k, []);
            byMonth.get(k)!.push(order);
          }
          for (const monthDate of months) {
            if (!isMonthSettled(monthDate)) continue;
            const key = monthCacheKey(monthDate);
            if (cache.has(key)) continue;
            analyticsOrderCache.saveMonth(store.id, 'wb', monthDate, byMonth.get(key) ?? []);
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') { console.warn('[OrderSync] WB query:', err?.message); hadError = true; }
        }

        // Тикаем все незакэшированные WB-месяцы одним разом после ответа API
        for (const monthDate of uncachedMonths) {
          tick(false, hadError, `${mLabel(monthDate)} · ${store.name}`);
        }
      }),
    ]);

    return { ozonPostings, yandexOrders, wbOrders };
  }

  // ── Background sync helpers ─────────────────────────────────────────────────

  private async _syncOzonStore(store: any, now: Date, needsIncremental: boolean): Promise<void> {
    const earliest = getEarliestDate(store.created_at);

    if (needsIncremental) {
      const rollingStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ROLLING_MONTHS, 1));
      await analyticsOrderCache.invalidateRange(store.id, rollingStart, now);
    }

    const cachedKeys = await analyticsOrderCache.loadCachedKeys(store.id, earliest, now);
    const months     = monthsInRange(earliest, now);
    const creds      = { client_id: store.client_id, api_key: store.api_key };
    const seen       = new Set<string>();

    for (const monthDate of months) {
      if (!isMonthSettled(monthDate)) continue;

      const key = monthCacheKey(monthDate);
      if (cachedKeys.has(key)) continue;

      const mStart = monthStart(monthDate);
      const mEnd   = monthEnd(monthDate);

      const flightKey = `ozon:${store.id}:${key}`;
      const p = (async () => {
        const monthPostings: OzonPosting[] = [];
        try {
          const fbs = await fetchAllPagesByCursor(
            (lim, cur) => ozonOrdersApi.getFbsPostings(creds, mStart.toISOString(), mEnd.toISOString(), null, lim, cur),
            50,
          );
          for (const p of fbs) {
            if (seen.has(p.posting_number)) continue;
            seen.add(p.posting_number); p.store_id = store.id;
            monthPostings.push(p);
          }
          let off = 0;
          for (let page = 0; page < 200; page++) {
            const fbo = await ozonOrdersApi.getFboPostings(creds, mStart.toISOString(), mEnd.toISOString(), 50, off);
            const hasNext = (fbo as any).__hasNext;
            let added = 0;
            for (const p of fbo) {
              if (seen.has(p.posting_number)) continue;
              seen.add(p.posting_number); p.store_id = store.id;
              monthPostings.push(p); added++;
            }
            if (!hasNext || fbo.length === 0 || added === 0) break;
            off += 50;
          }
          await analyticsOrderCache.saveMonth(store.id, 'ozon', monthDate, monthPostings);
        } catch (e: any) {
          console.warn(`[OrderSync] Ozon sync ${store.name} ${toStr(mStart)}:`, e?.message);
          throw e;
        }
      })();

      this._inFlight.set(flightKey, p);
      try { await p; } finally { this._inFlight.delete(flightKey); }

      await new Promise(r => setTimeout(r, 150));
    }
  }

  private async _syncYandexStore(store: any, now: Date, needsIncremental: boolean): Promise<void> {
    const earliest = getEarliestDate(store.created_at);

    if (needsIncremental) {
      const rollingStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ROLLING_MONTHS, 1));
      await analyticsOrderCache.invalidateRange(store.id, rollingStart, now);
    }

    const cachedKeys = await analyticsOrderCache.loadCachedKeys(store.id, earliest, now);
    const months     = monthsInRange(earliest, now);

    for (const monthDate of months) {
      if (!isMonthSettled(monthDate)) continue;

      const key = monthCacheKey(monthDate);
      if (cachedKeys.has(key)) continue;

      const mStart = monthStart(monthDate);
      const mEnd   = monthEnd(monthDate);

      const flightKey = `yandex:${store.id}:${key}`;
      const p = (async () => {
        try {
          const orders = await fetchAllYandexOrders(store, ymDateStr(mStart), ymDateStr(mEnd));
          await analyticsOrderCache.saveMonth(store.id, 'yandex', monthDate, orders);
        } catch (e: any) {
          console.warn(`[OrderSync] YM sync ${store.name} ${toStr(mStart)}:`, e?.message);
          throw e;
        }
      })();

      this._inFlight.set(flightKey, p);
      try { await p; } finally { this._inFlight.delete(flightKey); }

      await new Promise(r => setTimeout(r, 150));
    }
  }

  private async _syncWbStore(store: any, now: Date, needsIncremental: boolean): Promise<void> {
    if (isWbCoolingDown()) return;

    const earliest = getEarliestDate(store.created_at);

    if (needsIncremental) {
      const rollingStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ROLLING_MONTHS, 1));
      await analyticsOrderCache.invalidateRange(store.id, rollingStart, now);
    }

    const cachedKeys = await analyticsOrderCache.loadCachedKeys(store.id, earliest, now);
    const months     = monthsInRange(earliest, now);

    let fetchFrom: Date | null = null;
    for (const monthDate of months) {
      if (!isMonthSettled(monthDate)) continue;
      const key = monthCacheKey(monthDate);
      if (!cachedKeys.has(key)) { fetchFrom = monthStart(monthDate); break; }
    }

    if (!fetchFrom) return;

    // Регистрируем все незакэшированные месяцы как in-flight
    const flightKeys: string[] = [];
    for (const monthDate of months) {
      if (!isMonthSettled(monthDate)) continue;
      const key = monthCacheKey(monthDate);
      if (cachedKeys.has(key)) continue;
      flightKeys.push(`wb:${store.id}:${key}`);
    }

    const p = (async () => {
      try {
        const fetched = await fetchAllWbOrders(store, fetchFrom!.toISOString().slice(0, 19));
        const byMonth = new Map<string, WbOrder[]>();
        for (const order of fetched) {
          const d = new Date(order.created_at || 0);
          const k = monthCacheKey(d);
          if (!byMonth.has(k)) byMonth.set(k, []);
          byMonth.get(k)!.push(order);
        }
        for (const monthDate of months) {
          if (!isMonthSettled(monthDate)) continue;
          const key = monthCacheKey(monthDate);
          if (cachedKeys.has(key)) continue;
          await analyticsOrderCache.saveMonth(store.id, 'wb', monthDate, byMonth.get(key) ?? []);
        }
      } catch (e: any) {
        console.warn(`[OrderSync] WB sync ${store.name}:`, e?.message);
        throw e;
      }
    })();

    for (const fk of flightKeys) this._inFlight.set(fk, p);
    try { await p; } finally { for (const fk of flightKeys) this._inFlight.delete(fk); }
  }

  private _emit(s: OrderSyncStatus): void {
    this._status = s;
    this._listeners.forEach(fn => fn(s));
  }
}

export const orderSyncService = new OrderSyncService();
