import { OzonStore, OzonProduct } from '@/types/ozon';
import { supaFetch } from './supabaseClient';
import { companyService } from './companyService';

export const ozonDb = {
  // ── Stores ─────────────────────────────────────────────────────────────────

  getStores: (): Promise<OzonStore[]> => {
    const cid = companyService.getActiveId();
    if (!cid) return Promise.resolve([]);
    return supaFetch<OzonStore[]>(`ozon_stores?company_id=eq.${cid}&select=*&order=created_at.asc`);
  },

  createStore: async (store: Omit<OzonStore, 'id' | 'created_at'>): Promise<OzonStore> => {
    const cid = companyService.getActiveId();
    const r = await supaFetch<OzonStore[]>('ozon_stores', {
      method: 'POST',
      body: JSON.stringify({ ...store, company_id: cid }),
    });
    return Array.isArray(r) ? r[0] : r;
  },

  updateStore: (id: string, updates: Partial<OzonStore>): Promise<void> =>
    supaFetch(`ozon_stores?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteStore: (id: string): Promise<void> =>
    supaFetch(`ozon_stores?id=eq.${id}`, { method: 'DELETE' }),

  // ── Products ───────────────────────────────────────────────────────────────

  getProducts: async (): Promise<OzonProduct[]> => {
    const stores = await ozonDb.getStores();
    if (!stores.length) return [];
    const storeIds = stores.map(s => s.id);
    const storeFilter = storeIds.map(id => `store_id.eq.${id}`).join(',');
    const all: OzonProduct[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const page = await supaFetch<OzonProduct[]>(
        `ozon_products?or=(${storeFilter})&select=*&order=offer_id.asc&limit=${PAGE}&offset=${offset}`,
      );
      all.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  },

  upsertProducts: async (products: Omit<OzonProduct, 'id'>[]): Promise<void> => {
    for (let i = 0; i < products.length; i += 100) {
      const chunk = products.slice(i, i + 100);
      await supaFetch('ozon_products?on_conflict=store_id,offer_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk),
      });
    }
  },

  deleteProductsByStore: (storeId: string): Promise<void> =>
    supaFetch(`ozon_products?store_id=eq.${storeId}`, { method: 'DELETE' }),

  replaceStoreProducts: async (storeId: string, products: Omit<OzonProduct, 'id'>[]): Promise<void> => {
    await supaFetch(`ozon_products?store_id=eq.${storeId}`, { method: 'DELETE' });
    if (products.length > 0) {
      for (let i = 0; i < products.length; i += 100) {
        await supaFetch('ozon_products', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify(products.slice(i, i + 100)),
        });
      }
    }
  },

  updateProduct: (id: string, updates: Partial<OzonProduct>): Promise<void> =>
    supaFetch(`ozon_products?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...updates, synced_at: new Date().toISOString() }),
    }),

  deleteByOfferIds: (offerIds: string[]): Promise<void> => {
    const filter = offerIds.map(id => `offer_id.eq.${encodeURIComponent(id)}`).join(',');
    return supaFetch(`ozon_products?or=(${filter})`, { method: 'DELETE' });
  },

  updateByOfferIdAndStore: (
    storeId: string,
    offerId: string,
    updates: Partial<OzonProduct>,
  ): Promise<void> =>
    supaFetch(
      `ozon_products?store_id=eq.${storeId}&offer_id=eq.${encodeURIComponent(offerId)}`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ ...updates, synced_at: new Date().toISOString() }),
      },
    ),
};
