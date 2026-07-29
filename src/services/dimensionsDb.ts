/**
 * dimensionsDb — хранилище «базовых» (эталонных) габаритов товаров по vendor_code.
 *
 * База: Ozon-единицы — мм + г. При синке в МП конвертируется через `dimensionsUnit.ts`.
 * Используется страницей «Каталог» для разрешения конфликтов между МП.
 *
 * Данные хранятся в таблице Supabase `product_dimensions` (синхронизация между устройствами)
 * с localStorage в роли быстрого оффлайн-кэша.
 */

import { debug } from '@/utils/debug';
import { Dimensions, emptyDimensions } from './dimensionsUnit';
import { companyService } from './companyService';
import { dbFetch } from './dbClient';

interface Entry {
  vendor_code: string;
  dims: Dimensions;
  updated_at: string;
}

interface DbRow {
  vendor_code: string;
  company_id: string;
  weight_g: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  updated_at: string;
}

const STORAGE_KEY_PREFIX = 'dimensions_v1_';

function getKey(): string {
  const cid = companyService.getActiveId() ?? 'none';
  return STORAGE_KEY_PREFIX + cid;
}

// In-memory кэш разобранной карты — get()/set() вызываются тысячи раз за один buildUnified()
// на крупных каталогах, повторный JSON.parse всего хранилища на каждый вызов был узким местом.
let cachedKey: string | null = null;
let cachedMap: Map<string, Entry> | null = null;

function loadAll(): Map<string, Entry> {
  const key = getKey();
  if (cachedMap && cachedKey === key) return cachedMap;
  let map = new Map<string, Entry>();
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const arr: Entry[] = JSON.parse(raw);
      for (const e of arr) map.set(e.vendor_code.trim().toLowerCase(), e);
    }
  } catch { map = new Map(); }
  cachedKey = key;
  cachedMap = map;
  return map;
}

function saveAll(map: Map<string, Entry>): void {
  try {
    localStorage.setItem(getKey(), JSON.stringify([...map.values()]));
    cachedKey = getKey();
    cachedMap = map;
  } catch (e) { console.warn('[dimensionsDb] saveAll:', e); }
}

function rowToEntry(row: DbRow): Entry {
  return {
    vendor_code: row.vendor_code,
    dims: {
      weight_g: row.weight_g,
      length_mm: row.length_mm,
      width_mm: row.width_mm,
      height_mm: row.height_mm,
    },
    updated_at: row.updated_at,
  };
}

/** Persist one entry to Supabase. Fire-and-forget — local cache is source of truth for reads. */
function syncToDb(vendorCode: string, dims: Dimensions, updatedAt: string): void {
  const companyId = companyService.getActiveId();
  if (!companyId) return;
  dbFetch<DbRow[]>('product_dimensions', {
    method: 'POST',
    body: JSON.stringify({
      vendor_code: vendorCode,
      company_id: companyId,
      weight_g: dims.weight_g,
      length_mm: dims.length_mm,
      width_mm: dims.width_mm,
      height_mm: dims.height_mm,
      updated_at: updatedAt,
    }),
  }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }).catch(e => {
    debug.warn('[dimensionsDb] syncToDb failed:', e);
  });
}

/** Persist many entries to Supabase in one batch upsert. Fire-and-forget. */
function syncManyToDb(entries: Entry[]): void {
  const companyId = companyService.getActiveId();
  if (!companyId || entries.length === 0) return;
  const rows: DbRow[] = entries.map(e => ({
    vendor_code: e.vendor_code,
    company_id: companyId,
    weight_g: e.dims.weight_g,
    length_mm: e.dims.length_mm,
    width_mm: e.dims.width_mm,
    height_mm: e.dims.height_mm,
    updated_at: e.updated_at,
  }));
  dbFetch<DbRow[]>('product_dimensions', {
    method: 'POST',
    body: JSON.stringify(rows),
  }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }).catch(e => {
    debug.warn('[dimensionsDb] syncManyToDb failed:', e);
  });
}

export const dimensionsDb = {
  get(vendorCode: string): Dimensions | null {
    const e = loadAll().get(vendorCode.trim().toLowerCase());
    return e ? e.dims : null;
  },

  set(vendorCode: string, dims: Dimensions): void {
    const map = loadAll();
    const key = vendorCode.trim().toLowerCase();
    const updatedAt = new Date().toISOString();
    map.set(key, { vendor_code: vendorCode, dims, updated_at: updatedAt });
    saveAll(map);
    syncToDb(vendorCode, dims, updatedAt);
  },

  /** Записать много эталонов одним сохранением (для синка каталога — кратно быстрее, чем по одному). */
  setMany(entries: Array<{ vendorCode: string; dims: Dimensions }>): void {
    if (entries.length === 0) return;
    const map = loadAll();
    const now = new Date().toISOString();
    const dbEntries: Entry[] = [];
    for (const { vendorCode, dims } of entries) {
      const entry: Entry = { vendor_code: vendorCode, dims, updated_at: now };
      map.set(vendorCode.trim().toLowerCase(), entry);
      dbEntries.push(entry);
    }
    saveAll(map);
    syncManyToDb(dbEntries);
  },

  /** Удалить эталон. */
  remove(vendorCode: string): void {
    const map = loadAll();
    map.delete(vendorCode.trim().toLowerCase());
    saveAll(map);
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    dbFetch('product_dimensions?' +
      `vendor_code=eq.${encodeURIComponent(vendorCode)}&company_id=eq.${companyId}`, {
      method: 'DELETE',
    }).catch(e => { debug.warn('[dimensionsDb] remove failed:', e); });
  },

  all(): Entry[] {
    return [...loadAll().values()];
  },

  /** Очистить все. */
  clear(): void {
    try { localStorage.removeItem(getKey()); } catch (e) { debug.warn('[dimensionsDb] swallowed error', e); }
    cachedKey = null;
    cachedMap = null;
  },

  /**
   * Загрузить данные из Supabase и обновить локальный кэш.
   * Вызывается при старте приложения, если localStorage пуст — для восстановления данных
   * после смены устройства или очистки хранилища.
   */
  async syncFromDb(): Promise<void> {
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    try {
      const rows = await dbFetch<DbRow[]>(
        `product_dimensions?company_id=eq.${companyId}&select=*`,
      );
      if (!rows || rows.length === 0) return;
      const map = loadAll();
      for (const row of rows) {
        const key = row.vendor_code.trim().toLowerCase();
        const existing = map.get(key);
        // Keep whichever is newer
        if (!existing || row.updated_at > existing.updated_at) {
          map.set(key, rowToEntry(row));
        }
      }
      saveAll(map);
    } catch (e) {
      debug.warn('[dimensionsDb] syncFromDb failed:', e);
    }
  },

  emptyEntry(): Dimensions { return emptyDimensions(); },
};
