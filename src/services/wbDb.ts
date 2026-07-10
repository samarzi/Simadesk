import { WbStore, WbProduct } from '@/types/wb';
import { dbFetch } from './dbClient';
import { companyService } from './companyService';

export const wbDb = {
  getStores: (): Promise<WbStore[]> => {
    const cid = companyService.getActiveId();
    if (!cid) return Promise.resolve([]);
    return dbFetch<WbStore[]>(`wb_stores?company_id=eq.${cid}&select=*&order=created_at.asc`);
  },

  createStore: async (store: Omit<WbStore, 'id' | 'created_at'>): Promise<WbStore> => {
    const cid = companyService.getActiveId();
    const r = await dbFetch<WbStore[]>('wb_stores', {
      method: 'POST',
      body: JSON.stringify({ ...store, company_id: cid }),
    });
    return Array.isArray(r) ? r[0] : r;
  },

  updateStore: (id: string, updates: Partial<WbStore>): Promise<void> =>
    dbFetch(`wb_stores?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteStore: (id: string): Promise<void> =>
    dbFetch(`wb_stores?id=eq.${id}`, { method: 'DELETE' }),
  // ON DELETE CASCADE в wb_products удаляет товары автоматически

  getProducts: async (): Promise<WbProduct[]> => {
    const stores = await wbDb.getStores();
    if (!stores.length) return [];
    const ids = stores.map(s => s.id).join(',');
    const all: WbProduct[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const page = await dbFetch<WbProduct[]>(
        `wb_products?store_id=in.(${ids})&order=nm_id.asc&limit=${PAGE}&offset=${offset}`,
      );
      all.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  },

  getStoreProducts: (storeId: string): Promise<WbProduct[]> =>
    dbFetch<WbProduct[]>(`wb_products?store_id=eq.${storeId}&select=nm_id,price,discount,stock_total`),

  replaceStoreProducts: async (storeId: string, products: WbProduct[]): Promise<void> => {
    await dbFetch(`wb_products?store_id=eq.${storeId}`, { method: 'DELETE' });
    if (!products.length) return;
    for (let i = 0; i < products.length; i += 100) {
      await dbFetch('wb_products', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(products.slice(i, i + 100)),
      });
    }
  },
};
