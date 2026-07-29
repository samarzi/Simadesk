/**
 * StockModule — управление остатками товаров по всем маркетплейсам.
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { wbDb } from '@/services/wbDb';
import { fetchOzonStocks, updateOzonFbsStock, fetchAllOzonProducts } from '@/services/ozonApi';
import { yandexApi, fetchYandexWarehouses, updateYandexFbsStock, fetchAllYandexProducts } from '@/services/yandexApi';
import { wbApi, fetchAllWbProducts } from '@/services/wbApi';
import type { OzonStore, OzonProduct } from '@/types/ozon';
import type { WbStore, WbProduct } from '@/types/wb';
import type { YandexStore, YandexProduct } from '@/types/yandex';

type Mp = 'ozon' | 'wb' | 'yandex';
type StockFilter = 'all' | 'in-stock' | 'low' | 'out';
type SortField = 'name' | 'stock' | 'price' | 'mp';

const MP_LABEL: Record<Mp, string> = { ozon: 'Ozon', wb: 'WB', yandex: 'ЯМ' };
const MP_COLOR: Record<Mp, string> = { ozon: '#005bff', wb: '#cb11ab', yandex: '#fc3f1d' };

interface StockItem {
  id: string;
  mp: Mp;
  storeId: string;
  storeName: string;
  offerId: string;
  name: string;
  price: number | null;
  stockFbs: number;
  stockFbo: number;
  stockTotal: number;
  imageUrl: string | null;
  nmId?: number;
  /** Метка модели хранения: FBS/DBS — редактируемые, FBY/FBW — склад МП (readonly) */
  stockLabel: 'FBS' | 'FBY' | 'FBW' | 'DBS';
}

interface Warehouse { id: number; name: string; }

export class StockModule {
  private container: HTMLElement;
  private loading = false;
  private syncing = false;
  private items: StockItem[] = [];
  private search = '';
  private mpFilter: Mp | '' = '';
  private storeFilter = '';
  private stockFilter: StockFilter = 'all';
  private sortField: SortField = 'stock';
  private sortAsc = false;
  private lowThreshold = 5;

  private stores: { id: string; name: string; mp: Mp }[] = [];
  private ozStores: OzonStore[] = [];
  private wbStores: WbStore[] = [];
  private ymStores: YandexStore[] = [];

  // Raw DB records — used for fast stock-only sync (overlay + re-insert)
  private ozProducts: OzonProduct[] = [];
  private wbProducts: WbProduct[] = [];
  private ymProducts: YandexProduct[] = [];

  // Edit state
  private editItemId: string | null = null;
  private editValue = 0;
  private editWarehouseId: number | null = null;
  private editWarehouses: Warehouse[] = [];
  private editLoading = false;
  private editSaving = false;
  private editError = '';

  // Warehouse caches
  private ozWarehouses = new Map<string, Warehouse[]>();
  private ymWarehouses = new Map<string, Warehouse[]>();
  private wbWarehouses = new Map<string, Warehouse[]>();

  constructor(container: HTMLElement) { this.container = container; }

  show(): void {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.init();
  }
  hide(): void { this.container.style.display = 'none'; }

  async init(): Promise<void> {
    this.loading = true;
    this.render();
    await this.load();
    this.loading = false;
    this.render();
  }

  private async load(): Promise<void> {
    const [ozStores, ozProducts, ymStores, ymProducts, wbStores, wbProducts] = await Promise.all([
      ozonDb.getStores().catch((e) => { console.error('[Stock] getOzStores failed:', e); return [] as OzonStore[]; }),
      ozonDb.getProducts().catch((e) => { console.error('[Stock] getOzProducts failed:', e); return []; }),
      yandexDb.getStores().catch((e) => { console.error('[Stock] getYmStores failed:', e); return [] as YandexStore[]; }),
      yandexDb.getProducts().catch((e) => { console.error('[Stock] getYmProducts failed:', e); return []; }),
      wbDb.getStores().catch((e) => { console.error('[Stock] getWbStores failed:', e); return [] as WbStore[]; }),
      wbDb.getProducts().catch((e) => { console.error('[Stock] getWbProducts failed:', e); return []; }),
    ]);
    debug.log(`[Stock] load: oz=${ozProducts.length} wb=${wbProducts.length} ym=${ymProducts.length} | stores: oz=${ozStores.length} wb=${wbStores.length} ym=${ymStores.length}`);

    this.ozStores = ozStores;
    this.wbStores = wbStores;
    this.ymStores = ymStores;
    this.ozProducts = ozProducts as OzonProduct[];
    this.wbProducts = wbProducts as WbProduct[];
    this.ymProducts = ymProducts as YandexProduct[];
    this.stores = [
      ...ozStores.map(s => ({ id: s.id, name: s.name, mp: 'ozon' as Mp })),
      ...wbStores.map(s => ({ id: s.id, name: s.name, mp: 'wb' as Mp })),
      ...ymStores.map(s => ({ id: s.id, name: s.name, mp: 'yandex' as Mp })),
    ];
    const storeNames = new Map(this.stores.map(s => [s.id, s.name]));
    const wbFulfillment = new Map(wbStores.map(s => [s.id, s.fulfillment_model ?? null]));
    // If fbs_warehouse_id is set on a YM store, it's definitively FBS regardless of fulfillment_model in DB
    const ymFbsStoreIds = new Set(ymStores.filter(s => s.fbs_warehouse_id).map(s => s.id));
    const ymFulfillment = new Map(ymStores.map(s => [s.id,
      ymFbsStoreIds.has(s.id) ? 'FBS' : (s.fulfillment_model || s.placement_type || 'FBS') as string,
    ]));
    const items: StockItem[] = [];

    for (const p of ozProducts) {
      const fbs = p.stock_fbs ?? 0, fbo = p.stock_fbo ?? 0;
      items.push({ id: `ozon:${p.store_id}:${p.offer_id}`, mp: 'ozon', storeId: p.store_id,
        storeName: storeNames.get(p.store_id) ?? '', offerId: p.offer_id,
        name: p.name || p.offer_id, price: p.price ?? null,
        stockFbs: fbs, stockFbo: fbo, stockTotal: fbs + fbo, imageUrl: p.images?.[0] ?? null, stockLabel: 'FBS' });
    }
    for (const p of wbProducts) {
      const tot = p.stock_total ?? 0;
      // Only treat as FBW (marketplace warehouse, read-only) when explicitly set; default to FBS (seller-managed)
      const isFbw = wbFulfillment.get(p.store_id) === 'FBW';
      const wbLabel: StockItem['stockLabel'] = isFbw ? 'FBW' : 'FBS';
      items.push({ id: `wb:${p.store_id}:${p.vendor_code}`, mp: 'wb', storeId: p.store_id,
        storeName: storeNames.get(p.store_id) ?? '', offerId: p.vendor_code || String(p.nm_id),
        name: p.title || p.vendor_code || String(p.nm_id), price: p.price ?? null,
        stockFbs: isFbw ? 0 : tot, stockFbo: isFbw ? tot : 0,
        stockTotal: tot, imageUrl: null, nmId: p.nm_id, stockLabel: wbLabel });
    }
    for (const p of ymProducts) {
      const tot = p.stock_total ?? 0;
      const model = ymFulfillment.get(p.store_id) ?? 'FBS';
      const label: StockItem['stockLabel'] = model === 'FBY' ? 'FBY' : model === 'DBS' ? 'DBS' : 'FBS';
      const isFby = label === 'FBY';
      // FBY = склад Яндекса (аналог FBO/FBW) → stockFbo; FBS/DBS → stockFbs (seller-managed)
      items.push({ id: `yandex:${p.store_id}:${p.offer_id}`, mp: 'yandex', storeId: p.store_id,
        storeName: storeNames.get(p.store_id) ?? '', offerId: p.vendor_code || p.offer_id,
        name: p.name || p.offer_id, price: p.basic_price ?? null,
        stockFbs: isFby ? 0 : (p.stock_available ?? tot),
        stockFbo: isFby ? tot : 0,
        stockTotal: tot, imageUrl: null, stockLabel: label });
    }
    this.items = items;
  }

  // ── Sync from API ──────────────────────────────────────────────────────
  // Делает полный синхрон: загружает товары + остатки из API → сохраняет в БД → перезагружает

  private syncStatus = '';
  private syncErrors: string[] = [];

  async syncStocksFromApi(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncStatus = 'Подготовка…';
    this.syncErrors = [];
    this.render();

    try {
      // ── Ozon ──
      for (const store of this.ozStores) {
        try {
          const storeProds = this.ozProducts.filter(p => p.store_id === store.id);
          if (storeProds.length === 0) {
            // Первый запуск — полный синхрон
            this.syncStatus = `Ozon: ${store.name} — загружаем товары…`;
            this.render();
            const products = await fetchAllOzonProducts(store);
            debug.log(`[Stock] Ozon slow-path: ${products.length} products for store ${store.id}`);
            this.syncStatus = `Ozon: ${store.name} — сохраняем ${products.length}…`;
            this.render();
            // If API returned empty (rate-limit, 429) — keep existing data in DB
            if (products.length > 0) {
              await ozonDb.replaceStoreProducts(store.id, products);
            }
          } else {
            // Быстрый путь: обновляем только stock_fbs / stock_fbo
            this.syncStatus = `Ozon: ${store.name} — остатки…`;
            this.render();
            const stocks = await fetchOzonStocks(store);
            debug.log(`[Stock] Ozon fast-path: ${storeProds.length} cached, ${stocks.length} stocks from API`);
            const byOffer = new Map(stocks.map(s => [s.offer_id, s]));
            const updated = storeProds.map(({ id: _id, ...rest }) => ({
              ...rest,
              stock_fbs: byOffer.get(rest.offer_id)?.fbs ?? rest.stock_fbs,
              stock_fbo: byOffer.get(rest.offer_id)?.fbo ?? rest.stock_fbo,
            }));
            await ozonDb.replaceStoreProducts(store.id, updated);
          }
        } catch (e: unknown) {
          const msg = `Ozon «${store.name}»: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'ошибка'}`;
          console.warn('[Stock]', msg, e);
          this.syncErrors.push(msg);
          this.syncStatus = msg;
          this.render();
          await new Promise(r => setTimeout(r, 800));
        }
      }

      // ── WB ──
      for (const store of this.wbStores) {
        try {
          const storeProds = this.wbProducts.filter(p => p.store_id === store.id);
          if (storeProds.length === 0) {
            this.syncStatus = `WB: ${store.name} — загружаем карточки…`;
            this.render();
            const products = await fetchAllWbProducts(store);
            this.syncStatus = `WB: ${store.name} — сохраняем ${products.length}…`;
            this.render();
            // If API returned empty (rate-limit, 429) — keep existing data in DB
            if (products.length > 0) {
              await wbDb.replaceStoreProducts(store.id, products);
            }
          } else {
            this.syncStatus = `WB: ${store.name} — остатки…`;
            this.render();
            const raw = await wbApi.getStocks(store.api_key, '2019-01-01');
            const stocksMap = new Map<number, number>();
            for (const s of raw) {
              const nm = Number(s.nmId);
              if (!isFinite(nm)) continue;
              stocksMap.set(nm, (stocksMap.get(nm) ?? 0) + (Number(s.quantity) || 0));
            }
            const updated = storeProds.map(p => ({
              ...p,
              stock_total: stocksMap.get(p.nm_id) ?? p.stock_total ?? 0,
            }));
            await wbDb.replaceStoreProducts(store.id, updated);
          }
        } catch (e: unknown) {
          const msg = `WB «${store.name}»: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'ошибка'}`;
          console.warn('[Stock]', msg, e);
          this.syncErrors.push(msg);
          this.syncStatus = msg;
          this.render();
          await new Promise(r => setTimeout(r, 800));
        }
      }

      // ── Яндекс ──
      for (const store of this.ymStores) {
        if (!store.campaign_id) continue;
        try {
          const storeProds = this.ymProducts.filter(p => p.store_id === store.id);
          if (storeProds.length === 0) {
            this.syncStatus = `ЯМ: ${store.name} — загружаем товары…`;
            this.render();
            const products = await fetchAllYandexProducts(store);
            this.syncStatus = `ЯМ: ${store.name} — сохраняем ${products.length}…`;
            this.render();
            // If API returned empty (rate-limit, 429) — keep existing data in DB
            if (products.length > 0) {
              await yandexDb.replaceStoreProducts(store.id, products);
            }
          } else {
            this.syncStatus = `ЯМ: ${store.name} — остатки…`;
            this.render();
            const stocksMap = new Map<string, { total: number; available: number }>();
            let tok = '';
            for (let page = 0; page < 200; page++) {
              const chunk = await yandexApi.getStocks(store.api_key, store.campaign_id, tok);
              for (const wh of chunk.warehouses) {
                for (const offer of wh.offers ?? []) {
                  const cur = stocksMap.get(offer.offerId) ?? { total: 0, available: 0 };
                  for (const s of offer.stocks ?? []) {
                    const cnt = Number(s.count) || 0;
                    cur.total += cnt;
                    if (s.type === 'FIT' || s.type === 'AVAILABLE') cur.available += cnt;
                  }
                  stocksMap.set(offer.offerId, cur);
                }
              }
              if (!chunk.nextPageToken || chunk.nextPageToken === tok) break;
              tok = chunk.nextPageToken;
            }
            const updated = storeProds.map(p => {
              const s = stocksMap.get(p.offer_id);
              return { ...p, stock_total: s?.total ?? p.stock_total ?? 0, stock_available: s?.available ?? p.stock_available ?? 0 };
            });
            await yandexDb.replaceStoreProducts(store.id, updated);
          }
        } catch (e: unknown) {
          const msg = `ЯМ «${store.name}»: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'ошибка'}`;
          console.warn('[Stock]', msg, e);
          this.syncErrors.push(msg);
          this.syncStatus = msg;
          this.render();
          await new Promise(r => setTimeout(r, 800));
        }
      }

      this.syncStatus = 'Загружаем данные…';
      this.render();
      await this.load();

    } finally {
      this.syncing = false;
      this.syncStatus = '';
      this.render();
    }
  }

  // ── FBS Edit ───────────────────────────────────────────────────────────

  async openEdit(itemId: string): Promise<void> {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return;
    if (item.stockLabel === 'FBY' || item.stockLabel === 'FBW') return; // Склад МП — не редактируется через FBS API
    this.editItemId = itemId;
    this.editValue = item.stockFbs;
    this.editWarehouseId = null;
    this.editWarehouses = [];
    this.editError = '';
    this.editSaving = false;
    this.editLoading = true;
    this.render();
    try {
      if (item.mp === 'ozon') {
        if (!this.ozWarehouses.has(item.storeId)) {
          const store = this.ozStores.find(s => s.id === item.storeId);
          if (store) {
            const { ozonApi } = await import('@/services/ozonApi');
            const list = await ozonApi.getWarehouses({ client_id: store.client_id, api_key: store.api_key });
            this.ozWarehouses.set(item.storeId, list.map((w: any) => ({ id: w.warehouse_id, name: w.name ?? '' })));
          }
        }
        this.editWarehouses = this.ozWarehouses.get(item.storeId) ?? [];
      } else if (item.mp === 'yandex') {
        if (!this.ymWarehouses.has(item.storeId)) {
          const store = this.ymStores.find(s => s.id === item.storeId);
          if (store) {
            let list = await fetchYandexWarehouses(store);
            if (list.length === 0 && store.fbs_warehouse_id) {
              list = [{ warehouseId: store.fbs_warehouse_id, name: 'FBS склад' }];
            }
            this.ymWarehouses.set(item.storeId, list.map(w => ({ id: w.warehouseId, name: w.name })));
          }
        }
        this.editWarehouses = this.ymWarehouses.get(item.storeId) ?? [];
      } else {
        if (!this.wbWarehouses.has(item.storeId)) {
          const store = this.wbStores.find(s => s.id === item.storeId);
          if (store) { this.wbWarehouses.set(item.storeId, await wbApi.getWarehouses(store.api_key)); }
        }
        this.editWarehouses = this.wbWarehouses.get(item.storeId) ?? [];
      }
      if (this.editWarehouses.length === 1) this.editWarehouseId = this.editWarehouses[0].id;
    } catch (e: unknown) { this.editError = 'Ошибка загрузки складов: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? ''); }
    this.editLoading = false;
    this.render();
  }

  /** Inline-редактирование FBS прямо из строки таблицы. */
  async inlineSave(itemId: string, newValue: number): Promise<void> {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return;
    if (newValue < 0) newValue = 0;

    // Загружаем склады если ещё не кешированы
    try {
      if (item.mp === 'ozon' && !this.ozWarehouses.has(item.storeId)) {
        const store = this.ozStores.find(s => s.id === item.storeId);
        if (store) {
          const { ozonApi } = await import('@/services/ozonApi');
          const list = await ozonApi.getWarehouses({ client_id: store.client_id, api_key: store.api_key });
          this.ozWarehouses.set(item.storeId, list.map((w: any) => ({ id: w.warehouse_id, name: w.name ?? '' })));
        }
      } else if (item.mp === 'yandex' && !this.ymWarehouses.has(item.storeId)) {
        const store = this.ymStores.find(s => s.id === item.storeId);
        if (store) {
          let list = await fetchYandexWarehouses(store);
          if (list.length === 0 && store.fbs_warehouse_id) {
            list = [{ warehouseId: store.fbs_warehouse_id, name: 'FBS склад' }];
          }
          this.ymWarehouses.set(item.storeId, list.map(w => ({ id: w.warehouseId, name: w.name })));
        }
      } else if (item.mp === 'wb' && !this.wbWarehouses.has(item.storeId)) {
        const store = this.wbStores.find(s => s.id === item.storeId);
        if (store) { this.wbWarehouses.set(item.storeId, await wbApi.getWarehouses(store.api_key)); }
      }
    } catch (e: unknown) {
      this.editError = 'Ошибка загрузки складов: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? '');
      this.editItemId = itemId; this.editValue = newValue;
      this.editWarehouses = []; this.editLoading = false; this.editSaving = false;
      this.render(); return;
    }

    const warehouses = item.mp === 'ozon' ? (this.ozWarehouses.get(item.storeId) ?? [])
      : item.mp === 'yandex' ? (this.ymWarehouses.get(item.storeId) ?? [])
      : (this.wbWarehouses.get(item.storeId) ?? []);

    this.editItemId = itemId;
    this.editValue = newValue;
    this.editWarehouses = warehouses;
    this.editError = '';
    this.editLoading = false;
    this.editSaving = false;

    if (warehouses.length === 1) {
      this.editWarehouseId = warehouses[0].id;
      await this.saveEdit();
    } else {
      // Несколько складов — показываем модал для выбора
      this.editWarehouseId = null;
      this.render();
    }
  }

  closeEdit(): void { this.editItemId = null; this.editWarehouses = []; this.editError = ''; this.render(); }
  setEditValue(v: number): void { this.editValue = Math.max(0, v); this.render(); }
  setEditWarehouse(id: number): void { this.editWarehouseId = id; this.render(); }

  async saveEdit(): Promise<void> {
    if (!this.editItemId || this.editWarehouseId == null) return;
    const item = this.items.find(i => i.id === this.editItemId);
    if (!item) return;
    this.editSaving = true; this.editError = ''; this.render();
    try {
      if (item.mp === 'ozon') {
        const store = this.ozStores.find(s => s.id === item.storeId)!;
        await updateOzonFbsStock(store, [{ offer_id: item.offerId, stock: this.editValue, warehouse_id: this.editWarehouseId }]);
        item.stockFbs = this.editValue; item.stockTotal = item.stockFbs + item.stockFbo;
      } else if (item.mp === 'yandex') {
        const store = this.ymStores.find(s => s.id === item.storeId)!;
        const { yandexDb: ymDb } = await import('@/services/yandexDb');
        const prods = await ymDb.getProducts().catch(() => []);
        const prod = prods.find(p => p.store_id === item.storeId && (p.vendor_code || p.offer_id) === item.offerId);
        await updateYandexFbsStock(store, [{ offerId: prod?.offer_id ?? item.offerId, warehouseId: this.editWarehouseId, count: this.editValue }]);
        item.stockFbs = this.editValue; item.stockTotal = this.editValue;
      } else {
        const store = this.wbStores.find(s => s.id === item.storeId)!;
        if (!item.nmId) throw new Error('nm_id не найден');
        const barcodes = await wbApi.getCardBarcodes(store.api_key, item.nmId);
        if (!barcodes.length) throw new Error('Баркод не найден');
        await wbApi.updateFbsStocks(store.api_key, this.editWarehouseId, [{ sku: barcodes[0], amount: this.editValue }]);
        item.stockFbs = this.editValue; item.stockTotal = this.editValue;
      }
      this.editItemId = null; this.editWarehouses = [];
    } catch (e: unknown) { this.editError = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка'; }
    this.editSaving = false; this.render();
  }

  // ── Filters / Sort ─────────────────────────────────────────────────────

  setSearch(q: string): void { this.search = q; this.render(); }
  setMpFilter(mp: string): void { this.mpFilter = mp as Mp | ''; this.storeFilter = ''; this.render(); }
  setStoreFilter(id: string): void { this.storeFilter = id; this.render(); }
  setStockFilter(f: string): void { this.stockFilter = f as StockFilter; this.render(); }
  setSort(field: string): void {
    this.sortAsc = this.sortField === field ? !this.sortAsc : field === 'name';
    this.sortField = field as SortField;
    this.render();
  }
  setLowThreshold(n: number): void { this.lowThreshold = Math.max(1, n); this.render(); }

  private getFiltered(): StockItem[] {
    let list = this.items;
    if (this.mpFilter)    list = list.filter(i => i.mp === this.mpFilter);
    if (this.storeFilter) list = list.filter(i => i.storeId === this.storeFilter);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(i => `${i.offerId} ${i.name}`.toLowerCase().includes(q));
    }
    switch (this.stockFilter) {
      case 'in-stock': list = list.filter(i => i.stockTotal > this.lowThreshold); break;
      case 'low':      list = list.filter(i => i.stockTotal > 0 && i.stockTotal <= this.lowThreshold); break;
      case 'out':      list = list.filter(i => i.stockTotal === 0); break;
    }
    const dir = this.sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (this.sortField) {
        case 'name':  return a.name.localeCompare(b.name) * dir;
        case 'stock': return (a.stockTotal - b.stockTotal) * dir;
        case 'price': return ((a.price ?? 0) - (b.price ?? 0)) * dir;
        case 'mp':    return a.mp.localeCompare(b.mp) * dir;
        default: return 0;
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private esc(s: string | null | undefined): string {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  private fmtN(n: number): string { return n.toLocaleString('ru'); }
  private fmtMoney(n: number): string { return Math.round(n).toLocaleString('ru') + ' ₽'; }

  private stockBadge(n: number): string {
    const c = n === 0 ? '#ef4444' : n <= this.lowThreshold ? '#f59e0b' : '#16a34a';
    const bg = n === 0 ? 'rgba(239,68,68,.1)' : n <= this.lowThreshold ? 'rgba(245,158,11,.1)' : 'rgba(22,163,74,.1)';
    return `<span style="display:inline-block;min-width:44px;text-align:center;padding:3px 8px;border-radius:6px;background:${bg};color:${c};font-size:13px;font-weight:800">${this.fmtN(n)}</span>`;
  }

  // ── Edit Modal ─────────────────────────────────────────────────────────

  private renderEditModal(item: StockItem): string {
    const wh = this.editWarehouses;
    const canSave = !this.editSaving && !this.editLoading && this.editWarehouseId != null;

    return `
      <div style="position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65)"
           onclick="if(event.target===this)window.stockModule.closeEdit()">
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:18px;padding:0;width:380px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden"
             onclick="event.stopPropagation()">

          <!-- Modal header -->
          <div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
            <div style="width:8px;height:8px;border-radius:50%;background:${MP_COLOR[item.mp]};flex-shrink:0"></div>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:700;color:var(--text)">Изменить остаток ${item.stockLabel}</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:1px">${this.esc(item.name)}</div>
            </div>
            <button onclick="window.stockModule.closeEdit()" style="border:none;background:none;color:var(--text-2);cursor:pointer;font-size:20px;line-height:1;padding:2px 4px">×</button>
          </div>

          <div style="padding:18px 20px 20px">
            <!-- Info row -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px">
              <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;background:${MP_COLOR[item.mp]}20;color:${MP_COLOR[item.mp]}">${MP_LABEL[item.mp]}</span>
              <code style="font-size:11px;color:var(--text-2)">${this.esc(item.offerId)}</code>
              <span style="margin-left:auto;font-size:11px;color:var(--text-2)">сейчас: <b style="color:var(--text)">${this.fmtN(item.stockFbs)}</b></span>
            </div>

            <!-- Warehouse selector -->
            ${this.editLoading ? `
              <div style="text-align:center;padding:12px;color:var(--text-2);font-size:12px">Загружаем склады…</div>
            ` : wh.length > 1 ? `
              <div style="margin-bottom:14px">
                <label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">Склад ${item.stockLabel}</label>
                <select onchange="window.stockModule.setEditWarehouse(+this.value)"
                  style="width:100%;padding:9px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
                  <option value="">— выберите склад —</option>
                  ${wh.map(w => `<option value="${w.id}" ${this.editWarehouseId === w.id ? 'selected' : ''}>${this.esc(w.name)}</option>`).join('')}
                </select>
              </div>
            ` : wh.length === 1 ? `
              <div style="margin-bottom:14px;font-size:12px;color:var(--text-2)">Склад: <b style="color:var(--text)">${this.esc(wh[0].name)}</b></div>
            ` : !this.editError ? `
              <div style="margin-bottom:14px;font-size:12px;color:var(--text-2);padding:8px 12px;background:rgba(245,158,11,.08);border-radius:8px">
                Нет доступных складов ${item.stockLabel} для этого магазина
              </div>
            ` : ''}

            <!-- Quantity input -->
            <div style="margin-bottom:16px">
              <label style="font-size:11px;font-weight:600;color:var(--text-2);display:block;margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">Новый остаток</label>
              <div style="display:flex;align-items:center;gap:8px">
                <button onclick="window.stockModule.setEditValue(${this.editValue - 1})"
                  style="width:36px;height:36px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:18px;line-height:1;flex-shrink:0">−</button>
                <input type="number" min="0" value="${this.editValue}"
                  oninput="window.stockModule.setEditValue(+this.value)"
                  style="flex:1;padding:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:20px;font-weight:800;text-align:center;height:36px">
                <button onclick="window.stockModule.setEditValue(${this.editValue + 1})"
                  style="width:36px;height:36px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:18px;line-height:1;flex-shrink:0">+</button>
              </div>
            </div>

            <!-- Error -->
            ${this.editError ? `
              <div style="margin-bottom:14px;padding:9px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;font-size:11px;color:#ef4444">
                ${this.esc(this.editError)}
              </div>
            ` : ''}

            <!-- Actions -->
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">
              <button onclick="window.stockModule.closeEdit()"
                style="padding:10px;border:1px solid var(--border);background:transparent;color:var(--text-2);border-radius:9px;cursor:pointer;font-size:12px;font-weight:600">
                Отмена
              </button>
              <button onclick="window.stockModule.saveEdit()" ${canSave ? '' : 'disabled'}
                style="padding:10px;border:none;background:${canSave ? 'var(--accent)' : 'var(--border)'};color:${canSave ? '#000' : 'var(--text-2)'};border-radius:9px;cursor:${canSave ? 'pointer' : 'default'};font-size:12px;font-weight:800;transition:all .15s">
                ${this.editSaving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  render(): void {
    if (this.loading) {
      this.container.innerHTML = `
        <div class="oz-wrap"><div class="ord-loader">
          <div class="ord-loader-title">Загружаем остатки…</div>
          <div class="ord-loader-bar"><div class="ord-loader-bar-fill"></div></div>
        </div></div>`;
      return;
    }

    const filtered    = this.getFiltered();
    const total       = this.items.length;
    const inStock     = this.items.filter(i => i.stockTotal > this.lowThreshold).length;
    const low         = this.items.filter(i => i.stockTotal > 0 && i.stockTotal <= this.lowThreshold).length;
    const outOfStock  = this.items.filter(i => i.stockTotal === 0).length;
    const totalUnits  = this.items.reduce((s, i) => s + i.stockTotal, 0);
    const totalValue  = this.items.reduce((s, i) => s + (i.price ?? 0) * i.stockTotal, 0);

    const availableStores = this.mpFilter ? this.stores.filter(s => s.mp === this.mpFilter) : this.stores;

    const sortArrow = (f: string) => this.sortField === f
      ? `<span style="opacity:.6;font-size:9px">${this.sortAsc ? '▲' : '▼'}</span>` : '';

    const tabBtn = (id: StockFilter, label: string, count: number, color: string) => {
      const on = this.stockFilter === id;
      return `<button onclick="window.stockModule.setStockFilter('${id}')"
        style="padding:5px 14px;border:1.5px solid ${on ? color : 'var(--border)'};border-radius:20px;
          background:${on ? color : 'transparent'};color:${on ? (color === 'var(--accent)' ? '#000' : '#fff') : 'var(--text-2)'};
          cursor:pointer;font-size:11px;font-weight:${on ? '700' : '500'};display:inline-flex;align-items:center;gap:5px;white-space:nowrap">
        ${label}
        <span style="font-size:10px;opacity:${on ? '.8' : '.6'}">${this.fmtN(count)}</span>
      </button>`;
    };

    const thStyle = 'padding:9px 12px;text-align:left;font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;user-select:none';
    const thBtn   = (f: string, label: string) =>
      `<th style="${thStyle};cursor:pointer" onclick="window.stockModule.setSort('${f}')">${label} ${sortArrow(f)}</th>`;

    const editingItem = this.editItemId ? this.items.find(i => i.id === this.editItemId) : null;

    this.container.innerHTML = `
      ${editingItem ? this.renderEditModal(editingItem) : ''}

      <div class="oz-wrap">
        <!-- ── Topbar ── -->
        <div class="oz-topbar">
          <div class="oz-topbar-left">
            <div class="oz-brand">
              <svg class="oz-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
              </svg>
              <div>
                <div class="oz-brand-name">Остатки</div>
                <div style="font-size:10px;color:var(--text-2);margin-top:1px">${this.fmtN(total)} позиций · ${this.fmtN(totalUnits)} единиц</div>
              </div>
            </div>
          </div>
          <div class="oz-topbar-right">
            <button class="btn" onclick="window.stockModule.init()" title="Перезагрузить из базы">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:13px;height:13px"><path d="M14 8A6 6 0 1 1 8.5 2.1M14 2v4h-4"/></svg>
              Из базы
            </button>
            <button onclick="window.stockModule.syncStocksFromApi()" ${this.syncing ? 'disabled' : ''}
              style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;background:var(--accent);color:#000;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;opacity:${this.syncing?'.7':'1'}">
              ${this.syncing
                ? `<svg class="oz-spin" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" style="width:12px;height:12px"><path d="M36 20A16 16 0 1 1 20 4" stroke-dasharray="60 30"/></svg>${this.syncStatus || 'Синхронизация…'}`
                : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:12px;height:12px"><path d="M3 8a5 5 0 1 0 5-5M3 3v5h5"/></svg>Синхр. из API`}
            </button>
          </div>
        </div>

        ${this.syncErrors.length ? `
        <div style="padding:8px 16px;background:rgba(239,68,68,.08);border-bottom:1px solid rgba(239,68,68,.2);flex-shrink:0;display:flex;align-items:flex-start;gap:8px">
          <svg viewBox="0 0 16 16" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round" style="width:14px;height:14px;flex-shrink:0;margin-top:1px"><circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11v.5"/></svg>
          <div style="font-size:11px;color:#ef4444">${this.syncErrors.map(e => `<div>${e}</div>`).join('')}</div>
        </div>` : ''}

        <!-- ── Stat strip ── -->
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:0;border-bottom:1px solid var(--border);background:var(--bg2);flex-shrink:0">
          ${[
            { v: this.fmtN(total),          l: 'Всего позиций',   c: 'var(--text)' },
            { v: this.fmtN(inStock),         l: 'В наличии',       c: '#16a34a' },
            { v: this.fmtN(low),             l: `Мало (≤${this.lowThreshold})`, c: '#f59e0b' },
            { v: this.fmtN(outOfStock),      l: 'Нет в наличии',  c: '#ef4444' },
            { v: this.fmtN(totalUnits),      l: 'Единиц итого',   c: 'var(--text)' },
            { v: this.fmtMoney(totalValue),  l: 'Склад',          c: 'var(--accent)' },
          ].map((s, i) => `
            <div style="padding:10px 14px;${i < 5 ? 'border-right:1px solid var(--border);' : ''}text-align:center">
              <div style="font-size:15px;font-weight:800;color:${s.c};letter-spacing:-.3px">${s.v}</div>
              <div style="font-size:9px;color:var(--text-2);margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:.3px">${s.l}</div>
            </div>
          `).join('')}
        </div>

        <!-- ── Filters + chips ── -->
        <div style="padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input type="search" placeholder="Поиск по артикулу или названию…" value="${this.esc(this.search)}"
                oninput="window.stockModule.setSearch(this.value)"
                style="flex:1;min-width:200px;padding:8px 14px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">

              <select onchange="window.stockModule.setMpFilter(this.value)"
                style="padding:8px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
                <option value="">Все МП</option>
                <option value="ozon"   ${this.mpFilter==='ozon'   ?'selected':''}>Ozon</option>
                <option value="wb"     ${this.mpFilter==='wb'     ?'selected':''}>Wildberries</option>
                <option value="yandex" ${this.mpFilter==='yandex' ?'selected':''}>Яндекс Маркет</option>
              </select>

              ${availableStores.length > 1 ? `
                <select onchange="window.stockModule.setStoreFilter(this.value)"
                  style="padding:7px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
                  <option value="">Все магазины</option>
                  ${availableStores.map(s => `<option value="${s.id}" ${this.storeFilter===s.id?'selected':''}>${this.esc(s.name)}</option>`).join('')}
                </select>
              ` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${tabBtn('all',      'Все',          total,      'var(--accent)')}
            ${tabBtn('in-stock', 'В наличии',    inStock,    '#16a34a')}
            ${tabBtn('low',      `Мало ≤${this.lowThreshold}`, low, '#f59e0b')}
            ${tabBtn('out',      'Нет',          outOfStock, '#ef4444')}
          </div>
        </div>

        <!-- ── Table ── -->
        <div style="flex:1;overflow:auto;padding:16px 20px;padding-bottom:90px">
          ${filtered.length === 0 ? `
            <div style="text-align:center;padding:60px 20px;color:var(--text-2)">
              ${total === 0 ? `
                <div style="font-size:36px;margin-bottom:12px">${I.package('',36)}</div>
                <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px">Нет данных об остатках</div>
                <div style="font-size:12px;margin-bottom:18px">Нажмите «Синхр. из API» чтобы загрузить актуальные остатки,<br>или синхронизируйте магазины в разделе API Маркет</div>
                <button onclick="window.stockModule.syncStocksFromApi()"
                  style="padding:9px 22px;border:none;background:var(--accent);color:#000;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700">
                  Синхронизировать из API
                </button>
              ` : `
                <div style="font-size:14px;color:var(--text-2)">Нет позиций по заданным фильтрам</div>
              `}
            </div>
          ` : `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;overflow:hidden">
              <div>
                  <table style="width:100%;border-collapse:collapse">
                    <thead>
                      <tr style="background:var(--bg2);position:sticky;top:0;z-index:1;border-bottom:1px solid var(--border)">
                        <th style="${thStyle};cursor:pointer" onclick="window.stockModule.setSort('mp')">МП ${sortArrow('mp')}</th>
                        <th style="${thStyle}">Артикул</th>
                        ${thBtn('name',  'Название')}
                        ${thBtn('stock', 'Всего')}
                        <th style="${thStyle}">FBS</th>
                        <th style="${thStyle}">Склад МП</th>
                        ${thBtn('price', 'Цена')}
                        <th style="${thStyle}">Магазин</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${filtered.slice(0, 200).map(item => {
                        const isEditing = this.editItemId === item.id;
                        const safeId  = JSON.stringify(item.id);
                        const safeArt = this.esc(item.offerId).replace(/'/g,"\\'");
                        return `
                          <tr style="border-bottom:1px solid var(--border);background:${isEditing ? 'color-mix(in srgb,var(--accent) 4%,var(--bg))' : ''};"
                              onmouseover="if(!${isEditing})this.style.background='var(--bg2)'"
                              onmouseout="if(!${isEditing})this.style.background=''">

                            <!-- МП -->
                            <td style="padding:8px 12px;white-space:nowrap">
                              <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;color:${MP_COLOR[item.mp]};background:${MP_COLOR[item.mp]}18">
                                ${MP_LABEL[item.mp]}
                              </span>
                            </td>

                            <!-- Артикул -->
                            <td style="padding:8px 12px">
                              <div style="display:flex;align-items:center;gap:4px">
                                <code style="font-size:11px;color:var(--text-2);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(item.offerId)}">${this.esc(item.offerId)}</code>
                                <button onclick="event.stopPropagation();navigator.clipboard.writeText('${safeArt}');this.textContent='✓';setTimeout(()=>this.textContent='⎘',700)"
                                  style="border:none;background:none;cursor:pointer;font-size:11px;color:var(--text-2);padding:0;flex-shrink:0">⎘</button>
                              </div>
                            </td>

                            <!-- Название -->
                            <td style="padding:8px 12px;max-width:220px;font-size:12px;color:var(--text)">
                              <div style="display:flex;align-items:center;gap:4px;min-width:0">
                                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(item.name)}">${this.esc(item.name)}</span>
                                ${copyButton(item.name, 'Копировать название')}
                              </div>
                            </td>

                            <!-- Всего -->
                            <td style="padding:8px 12px;text-align:center">${this.stockBadge(item.stockTotal)}</td>

                            <!-- FBS — inline input для редактируемых моделей, readonly для FBY/FBW -->
                            <td style="padding:6px 12px;text-align:center">
                              ${(item.stockLabel === 'FBS' || item.stockLabel === 'DBS') ? `
                                <input type="number" min="0" value="${item.stockFbs}"
                                  onclick="event.stopPropagation()"
                                  onchange="event.stopPropagation();window.stockModule.inlineSave(${safeId},+this.value)"
                                  style="width:64px;padding:4px 6px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;font-weight:700;text-align:center;outline:none"
                                  onfocus="this.style.borderColor='var(--accent)'"
                                  onblur="this.style.borderColor='var(--border)'">
                              ` : `
                                <span style="font-size:11px;color:var(--text-3)">—</span>
                              `}
                            </td>

                            <!-- Склад МП (FBO / FBW / FBY — readonly) -->
                            <td style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-2)">
                              ${item.stockFbo > 0 ? `
                                <span style="display:inline-flex;align-items:center;gap:4px">
                                  <span style="font-size:9px;font-weight:700;color:var(--text-3)">${item.stockLabel === 'FBW' ? 'FBW' : item.stockLabel === 'FBY' ? 'FBY' : 'FBO'}</span>
                                  <span>${this.fmtN(item.stockFbo)}</span>
                                </span>
                              ` : '—'}
                            </td>

                            <!-- Цена -->
                            <td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--text);white-space:nowrap">
                              ${item.price != null ? this.fmtMoney(item.price) : '—'}
                            </td>

                            <!-- Магазин -->
                            <td style="padding:8px 12px;font-size:11px;color:var(--text-2);max-width:120px">
                              <div style="display:flex;align-items:center;gap:4px;min-width:0">
                                <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.esc(item.storeName)}</span>
                                ${copyButton(item.storeName, 'Копировать название магазина')}
                              </div>
                            </td>
                          </tr>`;
                      }).join('')}

                      ${filtered.length > 200 ? `
                        <tr><td colspan="8" style="padding:12px;text-align:center;color:var(--text-2);font-size:11px">
                          Показано 200 из ${this.fmtN(filtered.length)} — уточните фильтры
                        </td></tr>
                      ` : ''}
                    </tbody>
                  </table>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  }
}
