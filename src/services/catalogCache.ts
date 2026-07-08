/**
 * catalogCache — локальный кэш обогащённых данных карточек товара (габариты, фото, описание).
 *
 * Хранит результаты ручной синхронизации с API каждого МП.
 * При сбое API данные остаются в кэше — пользователь видит старые данные.
 * Обновляется ТОЛЬКО вручную (кнопка "Синхронизировать" в Каталоге).
 *
 * Хранилище — IndexedDB (фото-урлы и описания могут не влезть в лимит localStorage
 * ~5MB для магазинов с тысячами SKU). Для синхронного доступа из шаблонов рендера
 * данные предзагружаются в memCache через preload() перед buildUnified().
 */

import { debug } from '@/utils/debug';
import { fetchAllOzonProducts }   from './ozonApi';
import { fetchAllWbProducts }     from './wbApi';
import { fetchAllYandexProducts } from './yandexApi';
import { ozonDb }    from './ozonDb';
import { wbDb }      from './wbDb';
import { yandexDb }  from './yandexDb';
import { dimensionsDb } from './dimensionsDb';
import { isEmpty }   from './dimensionsUnit';
import type { OzonStore }    from '@/types/ozon';
import type { WbStore }      from '@/types/wb';
import type { YandexStore }  from '@/types/yandex';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CachedProduct {
  vendorCode:  string;
  mpId:        string;    // offer_id for Ozon/YM, nmID.toString() for WB
  weight_g:    number | null;
  length_mm:   number | null;
  width_mm:    number | null;
  height_mm:   number | null;
  photos:      string[];  // ordered photo URLs for this specific store
  description: string;
  barcode:     string;
}

interface StoreCache {
  storeId:   string;
  syncedAt:  string;  // ISO date
  products:  CachedProduct[];
}

const DB_NAME  = 'simadesk-catalog-cache';
const DB_STORE = 'stores';
const LEGACY_PREFIX = 'cat_cache_v2_'; // старый localStorage-кэш, мигрируется при первом preload()

// In-memory cache, заполняется через preload() перед buildUnified — getProduct()/resolveDims()
// вызываются синхронно много раз и не могут ждать IndexedDB на каждый вызов.
const memCache = new Map<string, StoreCache | null>();

// Индекс normalizedVendorCode → CachedProduct по магазину — getProduct() вызывается тысячи раз
// при buildUnified() на каталоге из нескольких тысяч товаров, поэтому линейный .find() недопустим.
const productIndex = new Map<string, Map<string, CachedProduct>>();

function buildIndex(storeId: string, products: CachedProduct[]): Map<string, CachedProduct> {
  const idx = new Map<string, CachedProduct>();
  for (const p of products) idx.set(p.vendorCode.trim().toLowerCase(), p);
  productIndex.set(storeId, idx);
  return idx;
}

// ── IndexedDB helpers ────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'storeId' });
      };
      req.onsuccess = e => resolve((e.target as IDBOpenDBRequest).result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, storeId: string): Promise<StoreCache | null> {
  return new Promise(resolve => {
    try {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(storeId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbSet(db: IDBDatabase, entry: StoreCache): Promise<void> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function idbDelete(db: IDBDatabase, storeId: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(storeId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function persist(entry: StoreCache): void {
  openDb().then(db => {
    if (db) idbSet(db, entry).catch(e => debug.warn('[catalogCache] idb set failed', e));
  });
}

// ── Core cache operations ─────────────────────────────────────────────────────

export const catalogCache = {
  /**
   * Загрузить кэш указанных магазинов в память (вызывать перед buildUnified).
   * При первом обращении мигрирует старые записи из localStorage в IndexedDB.
   */
  async preload(storeIds: string[]): Promise<void> {
    const pending = storeIds.filter(id => !memCache.has(id));
    if (!pending.length) return;
    const db = await openDb();
    for (const storeId of pending) {
      let entry: StoreCache | null = null;
      if (db) {
        try { entry = await idbGet(db, storeId); } catch { entry = null; }
      }
      if (!entry) {
        // Миграция из старого localStorage-кэша
        try {
          const raw = localStorage.getItem(LEGACY_PREFIX + storeId);
          if (raw) {
            entry = JSON.parse(raw) as StoreCache;
            localStorage.removeItem(LEGACY_PREFIX + storeId);
            if (db) idbSet(db, entry).catch(() => {});
          }
        } catch { entry = null; }
      }
      memCache.set(storeId, entry);
      if (entry) buildIndex(storeId, entry.products);
    }
  },

  get(storeId: string): StoreCache | null {
    return memCache.get(storeId) ?? null;
  },

  set(storeId: string, products: CachedProduct[]): void {
    const entry: StoreCache = { storeId, syncedAt: new Date().toISOString(), products };
    memCache.set(storeId, entry);
    buildIndex(storeId, products);
    persist(entry);
  },

  getProduct(storeId: string, vendorCode: string): CachedProduct | null {
    const s = this.get(storeId);
    if (!s) return null;
    const idx = productIndex.get(storeId) ?? buildIndex(storeId, s.products);
    return idx.get(vendorCode.trim().toLowerCase()) ?? null;
  },

  getSyncedAt(storeId: string): string | null {
    return this.get(storeId)?.syncedAt ?? null;
  },

  /** Обновить только фото конкретного товара в кэше (после ручного редактирования). */
  setPhotos(storeId: string, vendorCode: string, photos: string[]): void {
    // Создаём запись кэша, если магазин ещё не синхронизировался — иначе фото
    //, сохранённые только на стороне МП (без записи в локальную БД), пропадут
    // из каталога после перезагрузки страницы.
    const cache = this.get(storeId) ?? { storeId, syncedAt: new Date().toISOString(), products: [] };
    const key = vendorCode.trim().toLowerCase();
    const idx = productIndex.get(storeId) ?? buildIndex(storeId, cache.products);
    const existing = idx.get(key);
    if (existing) {
      existing.photos = photos;
    } else {
      const np: CachedProduct = { vendorCode, mpId: '', weight_g: null, length_mm: null, width_mm: null, height_mm: null, photos, description: '', barcode: '' };
      cache.products.push(np);
      idx.set(key, np);
    }
    memCache.set(storeId, cache);
    persist(cache);
  },

  clear(storeId: string): void {
    memCache.delete(storeId);
    localStorage.removeItem(LEGACY_PREFIX + storeId);
    openDb().then(db => { if (db) idbDelete(db, storeId).catch(() => {}); });
  },
};

// ── Sync functions ─────────────────────────────────────────────────────────────

export async function syncOzonStore(
  store: OzonStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Fetch full product info with dimensions (same as Товары sync)
  const dbProducts = await fetchAllOzonProducts(store);
  // If API returned empty (rate-limit, 429, network error) — keep existing cache
  if (!dbProducts.length) return;

  onProgress?.(dbProducts.length / 2, dbProducts.length);

  try { await ozonDb.upsertProducts(dbProducts); } catch (e) { console.warn('[catalogCache] ozon DB save failed:', e); }

  onProgress?.(dbProducts.length, dbProducts.length);

  // Build local cache from what we just saved
  const cached: CachedProduct[] = dbProducts.map(p => ({
    vendorCode:  p.offer_id,
    mpId:        p.offer_id,
    weight_g:    p.weight_kg != null ? Math.round(p.weight_kg * 1000) : null,
    length_mm:   p.length_cm != null ? Math.round(p.length_cm * 10)   : null,
    width_mm:    p.width_cm  != null ? Math.round(p.width_cm  * 10)   : null,
    height_mm:   p.height_cm != null ? Math.round(p.height_cm * 10)   : null,
    photos:      p.images ?? [],
    description: '',
    barcode:     p.barcode ?? '',
  }));

  // Сохраняем в dimensionsDb (читается каталогом как финальный фоллбэк)
  dimensionsDb.setMany(
    cached
      .map(c => ({ vendorCode: c.vendorCode, dims: { weight_g: c.weight_g, length_mm: c.length_mm, width_mm: c.width_mm, height_mm: c.height_mm } }))
      .filter(e => !isEmpty(e.dims)),
  );

  catalogCache.set(store.id, cached);
}

export async function syncYmStore(
  store: YandexStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!store.business_id) return;

  // Fetch full product info with dimensions (same as Товары sync)
  const dbProducts = await fetchAllYandexProducts(store);
  // If API returned empty (rate-limit, 429, network error) — keep existing cache
  if (!dbProducts.length) return;

  onProgress?.(dbProducts.length / 2, dbProducts.length);

  try { await yandexDb.replaceStoreProducts(store.id, dbProducts); } catch (e) { console.warn('[catalogCache] yandex DB save failed:', e); }

  onProgress?.(dbProducts.length, dbProducts.length);

  // Build local cache
  const cached: CachedProduct[] = dbProducts.map(p => ({
    vendorCode:  p.offer_id,
    mpId:        p.offer_id,
    weight_g:    p.weight_kg != null ? Math.round(p.weight_kg * 1000) : null,
    length_mm:   p.length_cm != null ? Math.round(p.length_cm * 10)   : null,
    width_mm:    p.width_cm  != null ? Math.round(p.width_cm  * 10)   : null,
    height_mm:   p.height_cm != null ? Math.round(p.height_cm * 10)   : null,
    photos:      p.pictures ?? [],
    description: '',
    barcode:     '',
  }));

  dimensionsDb.setMany(
    cached
      .map(c => ({ vendorCode: c.vendorCode, dims: { weight_g: c.weight_g, length_mm: c.length_mm, width_mm: c.width_mm, height_mm: c.height_mm } }))
      .filter(e => !isEmpty(e.dims)),
  );

  catalogCache.set(store.id, cached);
}

export async function syncWbStore(
  store: WbStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Fetch full WB products with dimensions (same as Товары sync)
  const dbProducts = await fetchAllWbProducts(store);
  // If API returned empty (rate-limit, 429, network error) — keep existing cache
  if (!dbProducts.length) return;

  try { await wbDb.replaceStoreProducts(store.id, dbProducts); } catch (e) { console.warn('[catalogCache] wb DB save failed:', e); }

  onProgress?.(dbProducts.length, dbProducts.length);

  // Build local cache from WB products
  const cached: CachedProduct[] = dbProducts.map(p => ({
    vendorCode:  p.vendor_code,
    mpId:        String(p.nm_id),
    weight_g:    p.weight_kg != null ? Math.round(p.weight_kg * 1000) : null,
    length_mm:   p.length_cm != null ? Math.round(p.length_cm * 10)   : null,
    width_mm:    p.width_cm  != null ? Math.round(p.width_cm  * 10)   : null,
    height_mm:   p.height_cm != null ? Math.round(p.height_cm * 10)   : null,
    photos:      p.pictures ?? [],
    description: '',
    barcode:     '',
  }));

  dimensionsDb.setMany(
    cached
      .map(c => ({ vendorCode: c.vendorCode, dims: { weight_g: c.weight_g, length_mm: c.length_mm, width_mm: c.width_mm, height_mm: c.height_mm } }))
      .filter(e => !isEmpty(e.dims)),
  );

  catalogCache.set(store.id, cached);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtSyncDate(iso: string | null): string {
  if (!iso) return 'нет данных';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return 'только что';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
    if (diff < 86_400_000) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * 86_400_000) {
      const days = ['вс','пн','вт','ср','чт','пт','сб'];
      return days[d.getDay()] + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } catch { return iso.slice(0, 10); }
}
