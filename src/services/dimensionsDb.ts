/**
 * dimensionsDb — хранилище «базовых» (эталонных) габаритов товаров по vendor_code.
 *
 * База: Ozon-единицы — мм + г. При синке в МП конвертируется через `dimensionsUnit.ts`.
 * Используется страницей «Каталог» для разрешения конфликтов между МП.
 *
 * Локально хранится в localStorage (с namespacing по company_id), пользователь
 * может перетянуть «эталон» из любого МП при разрешении конфликта.
 *
 * TODO: вынести в Supabase-таблицу product_dimensions (vendor_code, weight_g, length_mm, ...)
 * для синхронизации между устройствами.
 */

import { debug } from '@/utils/debug';
import { Dimensions, emptyDimensions } from './dimensionsUnit';
import { companyService } from './companyService';

interface Entry {
  vendor_code: string;
  dims: Dimensions;
  updated_at: string;
}

const STORAGE_KEY_PREFIX = 'dimensions_v1_';

function getKey(): string {
  const cid = companyService.getActiveId() ?? 'none';
  return STORAGE_KEY_PREFIX + cid;
}

function loadAll(): Map<string, Entry> {
  try {
    const raw = localStorage.getItem(getKey());
    if (!raw) return new Map();
    const arr: Entry[] = JSON.parse(raw);
    const map = new Map<string, Entry>();
    for (const e of arr) map.set(e.vendor_code.trim().toLowerCase(), e);
    return map;
  } catch { return new Map(); }
}

function saveAll(map: Map<string, Entry>): void {
  try {
    localStorage.setItem(getKey(), JSON.stringify([...map.values()]));
  } catch (e) { console.warn('[dimensionsDb] saveAll:', e); }
}

export const dimensionsDb = {
  get(vendorCode: string): Dimensions | null {
    const e = loadAll().get(vendorCode.trim().toLowerCase());
    return e ? e.dims : null;
  },

  set(vendorCode: string, dims: Dimensions): void {
    const map = loadAll();
    const key = vendorCode.trim().toLowerCase();
    map.set(key, { vendor_code: vendorCode, dims, updated_at: new Date().toISOString() });
    saveAll(map);
  },

  /** Удалить эталон. */
  remove(vendorCode: string): void {
    const map = loadAll();
    map.delete(vendorCode.trim().toLowerCase());
    saveAll(map);
  },

  all(): Entry[] {
    return [...loadAll().values()];
  },

  /** Очистить все. */
  clear(): void {
    try { localStorage.removeItem(getKey()); } catch (e) { debug.warn('[dimensionsDb] swallowed error', e); }
  },

  emptyEntry(): Dimensions { return emptyDimensions(); },
};
