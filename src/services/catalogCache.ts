/**
 * catalogCache — локальный кэш обогащённых данных карточек товара (габариты, фото, описание).
 *
 * Хранит результаты ручной синхронизации с API каждого МП.
 * При сбое API данные остаются в кэше — пользователь видит старые данные.
 * Обновляется ТОЛЬКО вручную (кнопка "Синхронизировать" в Каталоге).
 */

import { fetchAllOzonProducts }   from './ozonApi';
import { fetchAllWbProducts }     from './wbApi';
import { fetchAllYandexProducts } from './yandexApi';
import { ozonDb }    from './ozonDb';
import { wbDb }      from './wbDb';
import { yandexDb }  from './yandexDb';
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

const PREFIX = 'cat_cache_v2_';

// ── Core cache operations ─────────────────────────────────────────────────────

export const catalogCache = {
  get(storeId: string): StoreCache | null {
    try {
      const raw = localStorage.getItem(PREFIX + storeId);
      return raw ? (JSON.parse(raw) as StoreCache) : null;
    } catch { return null; }
  },

  set(storeId: string, products: CachedProduct[]): void {
    try {
      const entry: StoreCache = { storeId, syncedAt: new Date().toISOString(), products };
      localStorage.setItem(PREFIX + storeId, JSON.stringify(entry));
    } catch (e) { console.warn('[catalogCache] set:', e); }
  },

  getProduct(storeId: string, vendorCode: string): CachedProduct | null {
    const s = this.get(storeId);
    if (!s) return null;
    const key = vendorCode.trim().toLowerCase();
    return s.products.find(p => p.vendorCode.trim().toLowerCase() === key) ?? null;
  },

  getSyncedAt(storeId: string): string | null {
    return this.get(storeId)?.syncedAt ?? null;
  },

  /** Обновить только фото конкретного товара в кэше (после ручного редактирования). */
  setPhotos(storeId: string, vendorCode: string, photos: string[]): void {
    const cache = this.get(storeId);
    if (!cache) return;
    const key = vendorCode.trim().toLowerCase();
    const existing = cache.products.find(p => p.vendorCode.trim().toLowerCase() === key);
    if (existing) existing.photos = photos;
    else cache.products.push({ vendorCode, mpId: '', weight_g: null, length_mm: null, width_mm: null, height_mm: null, photos, description: '', barcode: '' });
    try { localStorage.setItem(PREFIX + storeId, JSON.stringify(cache)); } catch {}
  },

  clear(storeId: string): void {
    localStorage.removeItem(PREFIX + storeId);
  },
};

// ── Sync functions ─────────────────────────────────────────────────────────────

export async function syncOzonStore(
  store: OzonStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Fetch full product info with dimensions (same as Товары sync)
  const dbProducts = await fetchAllOzonProducts(store);
  if (!dbProducts.length) { catalogCache.set(store.id, []); return; }

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

  catalogCache.set(store.id, cached);
}

export async function syncYmStore(
  store: YandexStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!store.business_id) return;

  // Fetch full product info with dimensions (same as Товары sync)
  const dbProducts = await fetchAllYandexProducts(store);
  if (!dbProducts.length) { catalogCache.set(store.id, []); return; }

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

  catalogCache.set(store.id, cached);
}

export async function syncWbStore(
  store: WbStore,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Fetch full WB products with dimensions (same as Товары sync)
  const dbProducts = await fetchAllWbProducts(store);
  if (!dbProducts.length) { catalogCache.set(store.id, []); return; }

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
