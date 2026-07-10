import { YandexStore, YandexProduct } from '@/types/yandex';
import { dbFetch } from './dbClient';
import { companyService } from './companyService';

export const yandexDb = {
  getStores: (): Promise<YandexStore[]> => {
    const cid = companyService.getActiveId();
    if (!cid) return Promise.resolve([]);
    return dbFetch<YandexStore[]>(`yandex_stores?company_id=eq.${cid}&select=*&order=created_at.asc`);
  },

  createStore: async (store: Omit<YandexStore, 'id' | 'created_at'>): Promise<YandexStore> => {
    const cid = companyService.getActiveId();
    const r = await dbFetch<YandexStore[]>('yandex_stores', {
      method: 'POST',
      body: JSON.stringify({ ...store, company_id: cid }),
    });
    return Array.isArray(r) ? r[0] : r;
  },

  updateStore: (id: string, updates: Partial<YandexStore>): Promise<void> =>
    dbFetch(`yandex_stores?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteStore: (id: string): Promise<void> =>
    dbFetch(`yandex_stores?id=eq.${id}`, { method: 'DELETE' }),
  // ON DELETE CASCADE в yandex_products удаляет товары автоматически

  getProducts: async (): Promise<YandexProduct[]> => {
    const stores = await yandexDb.getStores();
    if (!stores.length) return [];
    const ids = stores.map(s => s.id).join(',');
    const all: YandexProduct[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const page = await dbFetch<YandexProduct[]>(
        `yandex_products?store_id=in.(${ids})&order=offer_id.asc&limit=${PAGE}&offset=${offset}`,
      );
      all.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  },

  saveProducts: async (products: YandexProduct[]): Promise<void> => {
    if (!products.length) return;
    const storeId = products[0].store_id;
    await yandexDb.replaceStoreProducts(storeId, products);
  },

  replaceStoreProducts: async (storeId: string, products: YandexProduct[]): Promise<void> => {
    await dbFetch(`yandex_products?store_id=eq.${storeId}`, { method: 'DELETE' });
    if (!products.length) return;
    for (let i = 0; i < products.length; i += 100) {
      await dbFetch('yandex_products', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(products.slice(i, i + 100)),
      });
    }
  },
};
