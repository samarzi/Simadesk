/**
 * costPriceDb — управление себестоимостью товаров.
 *
 * ХРАНЕНИЕ: Supabase (таблица cost_prices) + локальный кеш в localStorage.
 *  - При загрузке: тянем из Supabase в кеш
 *  - При записи: пишем в Supabase + обновляем кеш
 *  - get() / all() / sync-чтение работает из кеша (без await)
 *  - set() / bulkSet() возвращают Promise — но используются и синхронно
 *    (UI сразу видит изменения в кеше, БД сохраняется в фоне).
 *
 *  Если миграция add_cost_prices.sql не применена — fallback на чистый localStorage.
 */

import { supaFetch } from './supabaseClient';
import { companyService } from './companyService';

const CACHE_KEY_PREFIX = 'cost_prices_v3_';  // per-company cache

interface CostEntry {
  vendorCode: string;     // оригинальный артикул
  cost: number;           // ₽
  updatedAt: string;
  companyId?: string;     // привязка к компании
}

// ── In-memory cache (синхронный доступ) ──────────────────────────────────────
let cache: Record<string, CostEntry> = {};
let cacheCompanyId: string | null = null;
let supabaseAvailable = true;            // станет false если миграция не применена

function getCacheKey(): string {
  const cid = companyService.getActiveId();
  return cid ? `${CACHE_KEY_PREFIX}${cid}` : `${CACHE_KEY_PREFIX}_default`;
}

function loadCache(): Record<string, CostEntry> {
  try { return JSON.parse(localStorage.getItem(getCacheKey()) || '{}'); } catch { return {}; }
}
function saveCache(): void {
  try { localStorage.setItem(getCacheKey(), JSON.stringify(cache)); } catch {}
}
const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// ── Backend sync ──────────────────────────────────────────────────────────────

/** Загрузить все себестоимости текущей компании с сервера в кеш.
 *  Мержит: если запись есть в localStorage но нет на сервере — пушим на сервер.
 *  Если есть на сервере — обновляем кеш (сервер = source of truth). */
async function refreshFromServer(): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid) return;
  // Не делаем запрос если токен ещё не готов — это вызовет 401 при старте
  const token = localStorage.getItem('sb_access_token');
  if (!token) return;
  // При смене компании — сбрасываем кеш и загружаем заново
  if (cacheCompanyId !== cid) {
    cache = {};
    cacheCompanyId = null;
  }
  if (cacheCompanyId === cid && Object.keys(cache).length > 0) return; // уже актуально

  try {
    const rows = await supaFetch<Array<{ vendor_code: string; cost: number; updated_at: string }>>(
      `cost_prices?company_id=eq.${cid}&select=vendor_code,cost,updated_at`,
    );

    // Сохраняем локальные записи которых нет на сервере — нужно допушить
    // Загружаем из localStorage (per-company ключ)
    const localCache = loadCache();
    const localOnly: CostEntry[] = [];
    const serverKeys = new Set<string>();
    for (const r of rows) serverKeys.add(norm(r.vendor_code));
    for (const [k, entry] of Object.entries(localCache)) {
      if (!serverKeys.has(k) && entry.cost > 0 && (entry.companyId === cid || !entry.companyId)) {
        localOnly.push(entry);
      }
    }

    // Обновляем кеш с сервера
    cache = {};
    for (const r of rows) {
      cache[norm(r.vendor_code)] = {
        vendorCode: r.vendor_code,
        cost: Number(r.cost),
        updatedAt: r.updated_at,
        companyId: cid,
      };
    }

    // Восстанавливаем локальные записи и пушим на сервер
    if (localOnly.length > 0) {
      console.info(`[costPriceDb] Допушиваем ${localOnly.length} записей из localStorage на сервер`);
      const toUpload: Array<{ company_id: string; vendor_code: string; cost: number; updated_at: string }> = [];
      for (const entry of localOnly) {
        cache[norm(entry.vendorCode)] = { ...entry, companyId: cid };
        toUpload.push({
          company_id: cid,
          vendor_code: entry.vendorCode,
          cost: entry.cost,
          updated_at: entry.updatedAt || new Date().toISOString(),
        });
      }
      // Пушим в фоне батчами по 50
      for (let i = 0; i < toUpload.length; i += 50) {
        supaFetch('cost_prices?on_conflict=company_id,vendor_code', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(toUpload.slice(i, i + 50)),
        }).catch(e => console.warn('[costPriceDb] re-push batch:', e));
      }
    }

    cacheCompanyId = cid;
    saveCache();
    supabaseAvailable = true;
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.includes('42P01') || (msg.includes('cost_prices') && msg.includes('not found'))) {
      // Миграция не применена — работаем чисто на localStorage
      supabaseAvailable = false;
      console.warn('[costPriceDb] Supabase table cost_prices не найдена. Используется localStorage.');
    } else {
      // 401, сетевая ошибка и т.д. — пробуем работать из localStorage
      console.warn('[costPriceDb] load failed (will use localStorage cache):', msg);
      // Загружаем из localStorage если кеш пуст
      if (Object.keys(cache).length === 0) {
        cache = loadCache();
        cacheCompanyId = cid;
      }
    }
  }
}

/** Сохранить запись на сервер с retry. */
async function pushToServer(vendorCode: string, cost: number, retries = 2): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid || !supabaseAvailable) return;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await supaFetch('cost_prices?on_conflict=company_id,vendor_code', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ company_id: cid, vendor_code: vendorCode, cost, updated_at: new Date().toISOString() }),
      });
      return; // успех
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (msg.includes('cost_prices') && msg.includes('42P01')) {
        supabaseAvailable = false;
        return;
      }
      console.warn(`[costPriceDb] push "${vendorCode}" attempt ${attempt + 1}/${retries + 1}:`, msg);
      if (attempt < retries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

/** Удалить запись с сервера. */
async function removeFromServer(vendorCode: string): Promise<void> {
  const cid = companyService.getActiveId();
  if (!cid || !supabaseAvailable) return;
  try {
    await supaFetch(
      `cost_prices?company_id=eq.${cid}&vendor_code=eq.${encodeURIComponent(vendorCode)}`,
      { method: 'DELETE' },
    );
  } catch (e) { console.warn('[costPriceDb] remove:', e); }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const costPriceDb = {
  /** Синхронно: получить из кеша. ВЫЗОВИТЕ refresh() при старте чтобы кеш был свежим. */
  get(vendorCode: string): number | null {
    const e = cache[norm(vendorCode)];
    return e?.cost ?? null;
  },

  /** Сохранить себестоимость (синхронно в кеш, асинхронно на сервер). */
  set(vendorCode: string, cost: number): void {
    if (!vendorCode || !isFinite(cost) || cost < 0) return;
    const c = Math.round(cost * 100) / 100;
    cache[norm(vendorCode)] = {
      vendorCode, cost: c,
      updatedAt: new Date().toISOString(),
      companyId: companyService.getActiveId() ?? undefined,
    };
    saveCache();
    pushToServer(vendorCode, c);
  },

  remove(vendorCode: string): void {
    delete cache[norm(vendorCode)];
    saveCache();
    removeFromServer(vendorCode);
  },

  bulkSet(items: Array<{ vendorCode: string; cost: number }>): { saved: number; skipped: number } {
    let saved = 0, skipped = 0;
    const cid = companyService.getActiveId();
    const now = new Date().toISOString();
    const toUpload: Array<{ company_id: string; vendor_code: string; cost: number; updated_at: string }> = [];
    for (const { vendorCode, cost } of items) {
      if (!vendorCode || !isFinite(cost) || cost < 0) { skipped++; continue; }
      const c = Math.round(cost * 100) / 100;
      cache[norm(vendorCode)] = { vendorCode, cost: c, updatedAt: now, companyId: cid ?? undefined };
      if (cid) toUpload.push({ company_id: cid, vendor_code: vendorCode, cost: c, updated_at: now });
      saved++;
    }
    saveCache();
    // Bulk upload в Supabase
    if (cid && supabaseAvailable && toUpload.length > 0) {
      supaFetch('cost_prices?on_conflict=company_id,vendor_code', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(toUpload),
      }).catch((e: any) => {
        if (String(e?.message ?? '').includes('cost_prices')) supabaseAvailable = false;
        console.warn('[costPriceDb] bulkSet:', e);
      });
    }
    return { saved, skipped };
  },

  setMany(vendorCodes: string[], cost: number): number {
    return this.bulkSet(vendorCodes.map(vc => ({ vendorCode: vc, cost }))).saved;
  },

  all(): CostEntry[] {
    return Object.values(cache).sort((a, b) => a.vendorCode.localeCompare(b.vendorCode));
  },

  clear(): void {
    cache = {};
    saveCache();
    // Не удаляем на сервере — clear() это локальная операция (для дебага)
  },

  /** Принудительная перезагрузка с сервера. Вызвать при смене компании или входе. */
  async refresh(): Promise<void> { return refreshFromServer(); },

  /** Доступен ли Supabase backend (миграция применена)? */
  isCloudSyncAvailable(): boolean { return supabaseAvailable; },

  /** Синхронизировать себестоимости из customColumnsDb → costPriceDb.
   *  Если в customColumnsDb есть cost_price, но нет в costPriceDb — добавляем. */
  syncFromCustomColumns(): void {
    try {
      // Читаем напрямую из localStorage чтобы избежать circular dependency
      const raw = localStorage.getItem('custom_column_values_v1');
      if (!raw) return;
      const allValues: Record<string, Record<string, any>> = JSON.parse(raw);
      const items: Array<{ vendorCode: string; cost: number }> = [];
      for (const [offerId, values] of Object.entries(allValues)) {
        const v = values['cost_price'];
        if (v != null && v !== '') {
          const n = Number(v);
          if (isFinite(n) && n > 0 && !cache[norm(offerId)]) {
            items.push({ vendorCode: offerId, cost: n });
          }
        }
      }
      if (items.length > 0) {
        console.info(`[costPriceDb] Синхронизация из customColumnsDb: ${items.length} новых записей`);
        costPriceDb.bulkSet(items);
      }
    } catch (e) {
      console.warn('[costPriceDb] syncFromCustomColumns:', e);
    }
  },
};

// Авто-загрузка при изменении компании
companyService.onChange?.(() => {
  cacheCompanyId = null;
  refreshFromServer().then(() => costPriceDb.syncFromCustomColumns()).catch(() => {});
});

// Авто-загрузка при старте — ждём появления токена, потом загружаем
(function tryLoad(attempt = 0) {
  const delay = attempt === 0 ? 800 : 3000;
  setTimeout(() => {
    const token = localStorage.getItem('sb_access_token');
    if (!token && attempt < 5) { tryLoad(attempt + 1); return; }
    refreshFromServer()
      .then(() => costPriceDb.syncFromCustomColumns())
      .catch(() => {});
  }, delay);
})();
