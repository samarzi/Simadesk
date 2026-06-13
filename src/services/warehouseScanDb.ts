/**
 * Warehouse Scan DB — сохранение/загрузка результатов сканирования складов.
 *
 * Таблица Supabase: warehouse_scans
 *   id          uuid PK
 *   company_id  uuid FK → companies.id
 *   name        text       — пользовательское название скана
 *   platform    text       — 'yandex' | 'ozon'
 *   url         text       — URL страницы складов
 *   warehouses  jsonb      — массив складов (результат сканирования)
 *   created_at  timestamptz
 */

import { supaFetch } from './supabaseClient';
import { companyService } from './companyService';

export interface WarehouseScanRecord {
  id: string;
  company_id: string;
  name: string;
  platform: 'yandex' | 'ozon';
  url: string;
  warehouses: any[];
  created_at: string;
}

export const warehouseScanDb = {
  /** Получить все сканы для текущей компании и платформы */
  getScans: async (platform: 'yandex' | 'ozon'): Promise<WarehouseScanRecord[]> => {
    const cid = companyService.getActiveId();
    if (!cid) return [];
    return supaFetch<WarehouseScanRecord[]>(
      `warehouse_scans?company_id=eq.${cid}&platform=eq.${platform}&select=*&order=created_at.desc`
    );
  },

  /** Сохранить новый скан */
  saveScan: async (data: {
    name: string;
    platform: 'yandex' | 'ozon';
    url: string;
    warehouses: any[];
  }): Promise<WarehouseScanRecord> => {
    const cid = companyService.getActiveId();
    if (!cid) throw new Error('Не выбрана компания');
    const r = await supaFetch<WarehouseScanRecord[]>('warehouse_scans', {
      method: 'POST',
      body: JSON.stringify({
        company_id: cid,
        name: data.name,
        platform: data.platform,
        url: data.url,
        warehouses: data.warehouses,
      }),
    });
    return Array.isArray(r) ? r[0] : r;
  },

  /** Переименовать скан */
  renameScan: async (id: string, name: string): Promise<void> => {
    await supaFetch(`warehouse_scans?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  /** Удалить скан */
  deleteScan: (id: string): Promise<void> =>
    supaFetch(`warehouse_scans?id=eq.${id}`, { method: 'DELETE' }),
};
