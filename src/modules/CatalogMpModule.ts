import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { toOzon, toWb, toYm } from '@/services/dimensionsUnit';
import type { Dimensions } from '@/services/dimensionsUnit';
import {
  catalogCache, syncOzonStore, syncYmStore, syncWbStore, fmtSyncDate,
} from '@/services/catalogCache';
import { updateWbPrices } from '@/services/wbApi';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import type { OzonStore, OzonProduct } from '@/types/ozon';
import type { WbStore, WbProduct } from '@/types/wb';
import type { YandexStore, YandexProduct } from '@/types/yandex';

// ─────────────────────────────── Constants ───────────────────────────────────

const OZON_STATUS_LABELS: Record<string, string> = {
  processed: 'В продаже',
  archived: 'В архиве',
  disabled: 'Скрыт продавцом',
  failed_moderation: 'Не прошёл модерацию',
  moderating: 'На модерации',
  not_moderated: 'Ожидает модерации',
  banned: 'Заблокирован',
  blocked: 'Заблокирован',
  price_error: 'Ошибка цены',
  sold_out: 'Распродан',
  expired: 'Истёк срок',
};

/** Ссылка на карточку товара так, как её видит покупатель на маркетплейсе. */
function mpStorefrontUrl(mp: 'ozon' | 'wb' | 'yandex', product: any, nmID?: number | null): string | null {
  switch (mp) {
    case 'wb':
      return nmID ? `https://www.wildberries.ru/catalog/${nmID}/detail.aspx` : null;
    case 'ozon':
      return product.sku ? `https://www.ozon.ru/product/${product.sku}/` : null;
    case 'yandex':
      if (product.market_model_id && product.market_sku) {
        return `https://market.yandex.ru/product/${product.market_model_id}?sku=${product.market_sku}`;
      }
      return product.market_sku ? `https://market.yandex.ru/search?text=${product.market_sku}` : null;
  }
}

// ─────────────────────────────── Interfaces ──────────────────────────────────

/** Общие поля габаритов, присутствующие у товаров всех трёх МП. */
type MpProduct = OzonProduct | WbProduct | YandexProduct;

interface OzonEntry  { store: OzonStore;   product: OzonProduct;   price: number | null; }
interface WbEntry    { store: WbStore;     product: WbProduct;     price: number | null; nmID: number | null; }
interface YmEntry    { store: YandexStore; product: YandexProduct; price: number | null; }

interface PhotoSet {
  storeId:   string;
  storeName: string;
  mp:        'ozon' | 'wb' | 'yandex';
  photos:    string[];
}

interface UnifiedProduct {
  key:         string;
  vendorCode:  string;
  displayName: string;
  brand:       string;
  ozon:        OzonEntry[];
  wb:          WbEntry[];
  ym:          YmEntry[];
  hasMps:      { ozon: boolean; wb: boolean; yandex: boolean };
  priceRange:  { min: number | null; max: number | null };
  dims:        Dimensions;
  hasConflict: boolean;
  cover:       string;
  photoSets:   PhotoSet[];
}

interface FilterState {
  mp:         '' | 'ozon' | 'wb' | 'yandex';
  priceMin:   string; priceMax:  string;
  weightMin:  string; weightMax: string;
  lengthMin:  string; lengthMax: string;
  widthMin:   string; widthMax:  string;
  heightMin:  string; heightMax: string;
  conflicts:  boolean;
}

interface StoreEdit {
  weight_kg: string; length_cm: string; width_cm: string; height_cm: string;
  price: string; discount: string; photos: string[];
  priceLocked: boolean;
  saving: boolean; saveError: string;
  name: string; brand: string; barcode: string; description: string; vat: string;
  extraLoaded: boolean; extraLoading: boolean;
}

interface MassEditState {
  priceMode: 'set' | 'percent' | 'delta';
  price: string;
  weight_kg: string; length_cm: string; width_cm: string; height_cm: string;
  discount: string;
  brand: string;
  vat: string;
  saving: boolean;
  error: string;
  progress: string;
}

// ─────────────────────────────── Module ──────────────────────────────────────

export class CatalogMpModule {
  private container: HTMLElement;
  private visible = false;

  // ── Data
  private products: UnifiedProduct[] = [];
  private filtered:  UnifiedProduct[] = [];
  private rendered  = 0;
  private readonly CHUNK = 60;

  // ── Stores
  private ozStores: OzonStore[]    = [];
  private wbStores: WbStore[]      = [];
  private ymStores: YandexStore[]  = [];

  // ── Sync status
  private syncing = new Map<string, boolean>();
  private syncErr = new Map<string, string>();

  // ── View state
  private view:         'list' | 'cards' = 'list';
  private search        = '';
  private showAdvanced  = false;
  private filters: FilterState = {
    mp: '', priceMin: '', priceMax: '', weightMin: '', weightMax: '',
    lengthMin: '', lengthMax: '', widthMin: '', widthMax: '',
    heightMin: '', heightMax: '', conflicts: false,
  };

  // ── Modal
  private openKey:     string | null = null;
  private modalTab:    'overview' | 'card' | 'photos' = 'overview';
  private editState  = new Map<string, StoreEdit>();
  private lightboxUrl: string | null = null;

  // ── Mass selection / edit
  private selected = new Set<string>();
  private massEditOpen = false;
  private massEdit: MassEditState = {
    priceMode: 'set', price: '',
    weight_kg: '', length_cm: '', width_cm: '', height_cm: '',
    discount: '', brand: '', vat: '',
    saving: false, error: '', progress: '',
  };

  // ── Photo-add panel
  private photoAddStoreId:  string | null = null;
  private photoAddMode:     'url' | 'file' = 'url';
  private photoAddUrlValue  = '';

  // ── Repricer locked codes
  private lockedCodes = new Set<string>();

  // ── Cache for "Карточка" extra data (VAT/description) keyed by `${storeId}:${vendorCode}`,
  // so reopening a product or switching tabs doesn't re-fire live API calls every time.
  private extraDataCache = new Map<string, { vat?: string; description?: string }>();

  // ── Infinite scroll
  private observer: IntersectionObserver | null = null;

  // ── Event delegation guard
  private eventsReady = false;

  // ── Search debounce
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Drag & drop photo reorder
  private dragSrcIdx:     number | null = null;
  private dragSrcStoreId: string | null = null;

  // ── Loading state
  private loading = true;
  private loadError = '';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  // ─────────────────────────── Lifecycle ───────────────────────────────────

  async show(): Promise<void> {
    this.visible = true;
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.container.style.height = '100%';
    this.container.style.overflow = 'hidden';
    this.render();
    this.setupEvents();
    if (!this.products.length && !this.loadError) {
      await this.load();
    }
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
    this.openKey = null;
    this.lightboxUrl = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  // ─────────────────────────── Data loading ────────────────────────────────

  /**
   * `silent`: используется после синка одного магазина — не показывает полноэкранный
   * лоадер (список и скролл остаются на месте) и не перечитывает правила репрайсера
   * (они не меняются от синка с маркетплейсом).
   */
  private async load(opts: { silent?: boolean } = {}): Promise<void> {
    if (!opts.silent) {
      this.loading = true;
      this.loadError = '';
      this.renderShell();
    }
    try {
      if (!opts.silent) {
        await repricerRulesDb.refresh();
        const rules = repricerRulesDb.all();
        this.lockedCodes = new Set(
          rules.map((r: any) => (r.vendorCode ?? r.offer_id ?? '').toLowerCase()).filter(Boolean),
        );
      }

      const [
        [ozStores, ozRows],
        [wbStores, wbRows],
        [ymStores, ymRows],
      ] = await Promise.all([
        Promise.all([ozonDb.getStores(), ozonDb.getProducts()]),
        Promise.all([wbDb.getStores(),   wbDb.getProducts()]),
        Promise.all([yandexDb.getStores(), yandexDb.getProducts()]),
      ]);

      this.ozStores = ozStores;
      this.wbStores = wbStores;
      this.ymStores = ymStores;

      await catalogCache.preload([...ozStores, ...wbStores, ...ymStores].map(s => s.id));

      this.products = this.buildUnified(ozRows, wbRows, ymRows);
      this.applyFilters();
    } catch (e: any) {
      if (opts.silent) throw e;
      this.loadError = e?.message ?? 'Ошибка загрузки данных';
    } finally {
      if (!opts.silent) {
        this.loading = false;
        this.renderShell();
      }
    }
  }

  // ─────────────────────────── Build unified ────────────────────────────────

  private buildUnified(ozRows: OzonProduct[], wbRows: WbProduct[], ymRows: YandexProduct[]): UnifiedProduct[] {
    const map = new Map<string, {
      ozon: OzonEntry[]; wb: WbEntry[]; ym: YmEntry[];
      allNames: string[]; brands: string[];
    }>();

    const getOrCreate = (vc: string) => {
      const k = vc.trim().toLowerCase();
      if (!map.has(k)) map.set(k, { ozon: [], wb: [], ym: [], allNames: [], brands: [] });
      return map.get(k)!;
    };

    for (const p of ozRows) {
      const vc = (p.offer_id ?? '').trim();
      if (!vc) continue;
      const store = this.ozStores.find(s => s.id === p.store_id);
      if (!store) continue;
      const entry = getOrCreate(vc);
      entry.ozon.push({ store, product: p, price: p.price ?? null });
      if (p.name) entry.allNames.push(p.name);
    }

    for (const p of wbRows) {
      const vc = (p.vendor_code ?? p.nm_id?.toString() ?? '').trim();
      if (!vc) continue;
      const store = this.wbStores.find(s => s.id === p.store_id);
      if (!store) continue;
      const entry = getOrCreate(vc);
      entry.wb.push({ store, product: p, price: p.price ?? null, nmID: p.nm_id ?? null });
      if (p.title) entry.allNames.push(p.title);
      if (p.brand) entry.brands.push(p.brand);
    }

    for (const p of ymRows) {
      const vc = (p.offer_id ?? p.vendor_code ?? '').trim();
      if (!vc) continue;
      const store = this.ymStores.find(s => s.id === p.store_id);
      if (!store) continue;
      const entry = getOrCreate(vc);
      entry.ym.push({ store, product: p, price: p.basic_price ?? null });
      if (p.name) entry.allNames.push(p.name);
      if (p.vendor) entry.brands.push(p.vendor);
    }

    const results: UnifiedProduct[] = [];
    for (const [k, { ozon, wb, ym, allNames, brands }] of map) {
      const firstOz = ozon[0]?.product;
      const firstWb = wb[0]?.product;
      const vendorCode = firstOz?.offer_id ?? firstWb?.vendor_code ?? ym[0]?.product?.offer_id ?? k;
      const displayName = allNames[0] ?? vendorCode;
      const brand = brands[0] ?? '';

      const dims = this.resolveDims(vendorCode, ozon, wb, ym);
      const hasConflict = this.detectConflict(vendorCode, ozon, wb, ym);

      const prices = [
        ...ozon.map(e => e.price), ...wb.map(e => e.price), ...ym.map(e => e.price),
      ].filter((p): p is number => p !== null && p > 0);
      const priceRange = {
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
      };

      const photoSets: PhotoSet[] = [];
      for (const e of ozon) {
        const cached = catalogCache.getProduct(e.store.id, vendorCode);
        const dbPhotos: string[] = (e.product.images ?? []);
        const photos = dbPhotos.length ? dbPhotos : (cached?.photos ?? []);
        if (photos.length) photoSets.push({ storeId: e.store.id, storeName: e.store.name ?? 'Ozon', mp: 'ozon', photos });
      }
      for (const e of wb) {
        const cached = catalogCache.getProduct(e.store.id, vendorCode);
        const dbPhotos: string[] = (e.product.pictures ?? []);
        const photos = dbPhotos.length ? dbPhotos : (cached?.photos ?? []);
        if (photos.length) photoSets.push({ storeId: e.store.id, storeName: e.store.name ?? 'WB', mp: 'wb', photos });
      }
      for (const e of ym) {
        const cached = catalogCache.getProduct(e.store.id, vendorCode);
        const dbPhotos: string[] = (e.product.pictures ?? []);
        const photos = dbPhotos.length ? dbPhotos : (cached?.photos ?? []);
        if (photos.length) photoSets.push({ storeId: e.store.id, storeName: e.store.name ?? 'Яндекс', mp: 'yandex', photos });
      }

      const cover = photoSets[0]?.photos[0] ?? '';

      results.push({
        key: k, vendorCode, displayName, brand,
        ozon, wb, ym,
        hasMps: { ozon: ozon.length > 0, wb: wb.length > 0, yandex: ym.length > 0 },
        priceRange, dims, hasConflict, cover, photoSets,
      });
    }

    results.sort((a, b) => a.vendorCode.localeCompare(b.vendorCode));
    return results;
  }

  /** Габариты из строки товара БД (weight_kg/length_cm/...), или null если не заполнены. */
  private dimsFromProductRow(p: MpProduct): Dimensions | null {
    if (!p?.weight_kg && !p?.length_cm) return null;
    return {
      weight_g:  Math.round((p.weight_kg ?? 0) * 1000),
      length_mm: Math.round((p.length_cm ?? 0) * 10),
      width_mm:  Math.round((p.width_cm  ?? 0) * 10),
      height_mm: Math.round((p.height_cm ?? 0) * 10),
    };
  }

  /** Габариты из ручного кэша синхронизации (catalogCache), или null если не записаны. */
  private dimsFromCache(storeId: string, vc: string): Dimensions | null {
    const c = catalogCache.getProduct(storeId, vc);
    if (c?.weight_g == null) return null;
    return { weight_g: c.weight_g, length_mm: c.length_mm ?? 0, width_mm: c.width_mm ?? 0, height_mm: c.height_mm ?? 0 };
  }

  /** Габариты для одного магазина: БД (свежее) > ручной кэш (для старых записей без габаритов в БД). */
  private resolveEntryDims(p: MpProduct, storeId: string, vc: string): Dimensions | null {
    return this.dimsFromProductRow(p) ?? this.dimsFromCache(storeId, vc);
  }

  private resolveDims(vc: string, ozon: OzonEntry[], wb: WbEntry[], ym: YmEntry[]): Dimensions {
    for (const e of ozon) {
      const d = this.resolveEntryDims(e.product, e.store.id, vc);
      if (d) return d;
    }
    for (const e of wb) {
      const d = this.resolveEntryDims(e.product, e.store.id, vc);
      if (d) return d;
    }
    for (const e of ym) {
      const d = this.resolveEntryDims(e.product, e.store.id, vc);
      if (d) return d;
    }
    return { weight_g: 0, length_mm: 0, width_mm: 0, height_mm: 0 };
  }

  private detectConflict(vc: string, ozon: OzonEntry[], wb: WbEntry[], ym: YmEntry[]): boolean {
    const dimsList: Dimensions[] = [];
    const push = (p: MpProduct, storeId: string) => {
      const d = this.resolveEntryDims(p, storeId, vc);
      if (d) dimsList.push(d);
    };
    for (const e of ozon) push(e.product, e.store.id);
    for (const e of wb)   push(e.product, e.store.id);
    for (const e of ym)   push(e.product, e.store.id);

    if (dimsList.length < 2) return false;
    const base = dimsList[0];
    return dimsList.some(d =>
      Math.abs((d.weight_g ?? 0) - (base.weight_g ?? 0)) > 10 ||
      Math.abs((d.length_mm ?? 0) - (base.length_mm ?? 0)) > 2 ||
      Math.abs((d.width_mm  ?? 0) - (base.width_mm  ?? 0)) > 2 ||
      Math.abs((d.height_mm ?? 0) - (base.height_mm ?? 0)) > 2,
    );
  }

  // ─────────────────────────── Filter & Search ──────────────────────────────

  private applyFilters(): void {
    const q = this.search.trim().toLowerCase();
    const f = this.filters;

    this.filtered = this.products.filter(p => {
      if (q && !p.vendorCode.toLowerCase().includes(q) &&
          !p.displayName.toLowerCase().includes(q) &&
          !p.brand.toLowerCase().includes(q)) return false;
      if (f.mp === 'ozon'   && !p.hasMps.ozon)   return false;
      if (f.mp === 'wb'     && !p.hasMps.wb)      return false;
      if (f.mp === 'yandex' && !p.hasMps.yandex)  return false;
      if (f.conflicts && !p.hasConflict)           return false;
      if (f.priceMin && p.priceRange.min !== null && p.priceRange.min < +f.priceMin) return false;
      if (f.priceMax && p.priceRange.max !== null && p.priceRange.max > +f.priceMax) return false;
      const wkg = (p.dims.weight_g ?? 0) / 1000;
      if (f.weightMin && wkg < +f.weightMin) return false;
      if (f.weightMax && wkg > +f.weightMax) return false;
      const lcm = (p.dims.length_mm ?? 0) / 10, wcm = (p.dims.width_mm ?? 0) / 10, hcm = (p.dims.height_mm ?? 0) / 10;
      if (f.lengthMin && lcm < +f.lengthMin) return false;
      if (f.lengthMax && lcm > +f.lengthMax) return false;
      if (f.widthMin  && wcm < +f.widthMin)  return false;
      if (f.widthMax  && wcm > +f.widthMax)  return false;
      if (f.heightMin && hcm < +f.heightMin) return false;
      if (f.heightMax && hcm > +f.heightMax) return false;
      return true;
    });

    this.rendered = 0;
    // Partial re-render: only update items + count if shell already exists (avoids full DOM rebuild on search)
    const itemsEl = this.container.querySelector<HTMLElement>('#cmp-items');
    if (itemsEl) {
      this.renderList();
      this.setupInfiniteScroll();
      const countEl = this.container.querySelector<HTMLElement>('.cmp-count');
      if (countEl) countEl.textContent = this.filtered.length.toLocaleString('ru');
    } else {
      this.renderShell();
    }
  }

  // ─────────────────────────── Rendering ────────────────────────────────────

  private render(): void { this.renderShell(); }

  private renderShell(): void {
    if (!this.visible) return;
    this.container.innerHTML = this.tplShell();
    this.renderList();
    this.setupInfiniteScroll();
    if (this.openKey) this.renderModal();
    if (this.lightboxUrl) this.renderLightbox();
    if (this.massEditOpen) this.renderMassEditModal();
  }

  private tplShell(): string {
    const f = this.filters;
    const advCount = [
      f.priceMin, f.priceMax, f.weightMin, f.weightMax,
      f.lengthMin, f.lengthMax, f.widthMin, f.widthMax, f.heightMin, f.heightMax,
    ].filter(Boolean).length + (f.conflicts ? 1 : 0);
    const hasAny = advCount > 0 || f.mp;

    return `
<div class="cmp-shell">
  <div class="cmp-header">
    <div class="cmp-header-left">
      <span class="cmp-title">Каталог</span>
      <span class="cmp-count">${this.loading ? '…' : this.filtered.length.toLocaleString('ru')}</span>
    </div>
    <div class="cmp-header-right">
      <div class="cmp-search-wrap">
        <svg class="cmp-search-icon" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.7"/><line x1="14" y1="14" x2="18" y2="18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input class="cmp-search" id="cmp-search-input" type="search" placeholder="Название, артикул, бренд…" value="${esc(this.search)}">
      </div>
      <div class="cmp-view-toggle">
        <button class="cmp-view-btn ${this.view==='list'?'active':''}" data-action="view-list" title="Список">
          <svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="2.5" rx="1"/><rect x="3" y="8.8" width="14" height="2.5" rx="1"/><rect x="3" y="13.5" width="14" height="2.5" rx="1"/></svg>
        </button>
        <button class="cmp-view-btn ${this.view==='cards'?'active':''}" data-action="view-cards" title="Карточки">
          <svg viewBox="0 0 20 20"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>
        </button>
      </div>
    </div>
  </div>

  <div class="cmp-filters">
    <div class="cmp-filter-chips">
      <button class="cmp-chip ${!f.mp?'active':''}" data-action="filter-mp" data-val="">Все МП</button>
      <button class="cmp-chip cmp-chip--ozon ${f.mp==='ozon'?'active':''}" data-action="filter-mp" data-val="ozon">Ozon</button>
      <button class="cmp-chip cmp-chip--wb ${f.mp==='wb'?'active':''}" data-action="filter-mp" data-val="wb">Wildberries</button>
      <button class="cmp-chip cmp-chip--ym ${f.mp==='yandex'?'active':''}" data-action="filter-mp" data-val="yandex">Яндекс</button>
      <button class="cmp-chip cmp-chip--conflict ${f.conflicts?'active':''}" data-action="filter-conflicts">⚠ Конфликты</button>
      <button class="cmp-chip cmp-chip--adv ${this.showAdvanced?'active':''}" data-action="toggle-advanced">
        Фильтры${advCount > 0 ? ` <span class="cmp-chip-cnt">${advCount}</span>` : ''} ▾
      </button>
      ${hasAny ? '<button class="cmp-chip cmp-chip--clear" data-action="clear-filters">✕ Сбросить</button>' : ''}
    </div>

    ${this.showAdvanced ? `
    <div class="cmp-adv-panel">
      <div class="cmp-adv-row">
        ${this.tplRangeFilter('Цена (₽)',   'priceMin',  'priceMax',  '')}
        ${this.tplRangeFilter('Вес (кг)',   'weightMin', 'weightMax', '0.001')}
        ${this.tplRangeFilter('Длина (см)', 'lengthMin', 'lengthMax', '0.1')}
        ${this.tplRangeFilter('Ширина(см)', 'widthMin',  'widthMax',  '0.1')}
        ${this.tplRangeFilter('Высота(см)', 'heightMin', 'heightMax', '0.1')}
      </div>
    </div>` : ''}
  </div>

  <div class="cmp-sync-bar" id="cmp-sync-bar">${this.tplSyncBar()}</div>

  <div class="cmp-select-bar" id="cmp-select-bar">${this.tplSelectBar()}</div>

  <div class="cmp-list-wrap" id="cmp-list-wrap">
    ${this.loading ? this.tplLoading() : this.loadError ? this.tplError() : ''}
    <div class="cmp-items ${this.view==='cards'?'cmp-items--cards':''}" id="cmp-items"></div>
    <div class="cmp-sentinel" id="cmp-sentinel"></div>
  </div>
</div>`;
  }

  private tplRangeFilter(label: string, minKey: string, maxKey: string, step: string): string {
    const f = this.filters as any;
    return `
    <div class="cmp-adv-group">
      <label class="cmp-adv-label">${label}</label>
      <div class="cmp-adv-range">
        <input type="number" class="cmp-adv-input" placeholder="от" value="${esc(f[minKey])}" data-filter="${minKey}" ${step ? `step="${step}"` : ''}>
        <span>—</span>
        <input type="number" class="cmp-adv-input" placeholder="до" value="${esc(f[maxKey])}" data-filter="${maxKey}" ${step ? `step="${step}"` : ''}>
      </div>
    </div>`;
  }

  private tplSyncBar(): string {
    const stores = [
      ...this.ozStores.map(s => ({ id: s.id, name: s.name ?? 'Ozon', mp: 'ozon', label: 'OZ' })),
      ...this.wbStores.map(s => ({ id: s.id, name: s.name ?? 'WB',   mp: 'wb',   label: 'WB' })),
      ...this.ymStores.map(s => ({ id: s.id, name: s.name ?? 'ЯМ',   mp: 'yandex', label: 'ЯМ' })),
    ];
    if (!stores.length) return '';
    return stores.map(s => {
      const isSyncing = !!this.syncing.get(s.id);
      const err = this.syncErr.get(s.id);
      const date = fmtSyncDate(catalogCache.getSyncedAt(s.id));
      return `<div class="cmp-sync-item">
        <span class="cmp-mp-badge cmp-mp-badge--${s.mp}">${s.label}</span>
        <span class="cmp-sync-name">${esc(s.name)}</span>
        <span class="cmp-sync-date ${err ? 'err' : ''}">${err ? esc(err) : date}</span>
        <button class="cmp-sync-btn" data-action="sync-store" data-store-id="${s.id}" data-mp="${s.mp}" ${isSyncing ? 'disabled' : ''}>
          ${isSyncing ? '<span class="cmp-spinner-sm"></span>' : '↻'} ${isSyncing ? 'Синхр…' : 'Обновить'}
        </button>
      </div>`;
    }).join('');
  }

  private tplLoading(): string {
    return `<div class="cmp-placeholder"><span class="cmp-spinner"></span>Загрузка…</div>`;
  }
  private tplError(): string {
    return `<div class="cmp-placeholder cmp-placeholder--err">
      ⚠ ${esc(this.loadError)}
      <button class="cmp-btn cmp-btn-sm" data-action="reload">Повторить</button>
    </div>`;
  }

  private renderList(): void {
    const el = this.container.querySelector<HTMLElement>('#cmp-items');
    if (!el) return;
    const chunk = this.filtered.slice(0, this.CHUNK);
    this.rendered = chunk.length;
    el.innerHTML = this.view === 'list'
      ? chunk.map(p => this.tplRow(p)).join('')
      : chunk.map(p => this.tplCard(p)).join('');
  }

  private appendChunk(): void {
    const el = this.container.querySelector<HTMLElement>('#cmp-items');
    if (!el || this.rendered >= this.filtered.length) return;
    const chunk = this.filtered.slice(this.rendered, this.rendered + this.CHUNK);
    if (!chunk.length) return;
    const frag = document.createDocumentFragment();
    for (const p of chunk) {
      const tmp = document.createElement('div');
      tmp.innerHTML = this.view === 'list' ? this.tplRow(p) : this.tplCard(p);
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    }
    el.appendChild(frag);
    this.rendered += chunk.length;
  }

  private tplMpBadges(p: UnifiedProduct): string {
    return [
      p.hasMps.ozon   ? '<span class="cmp-mp-badge cmp-mp-badge--ozon">OZ</span>'  : '',
      p.hasMps.wb     ? '<span class="cmp-mp-badge cmp-mp-badge--wb">WB</span>'    : '',
      p.hasMps.yandex ? '<span class="cmp-mp-badge cmp-mp-badge--ym">ЯМ</span>'    : '',
    ].join('');
  }

  private fmtDims(d: Dimensions): string {
    if (!d.weight_g && !d.length_mm) return '—';
    const parts: string[] = [];
    if (d.weight_g)  parts.push(`${(d.weight_g / 1000).toFixed(3)} кг`);
    if (d.length_mm || d.width_mm || d.height_mm)
      parts.push(`${((d.length_mm??0)/10).toFixed(0)}×${((d.width_mm??0)/10).toFixed(0)}×${((d.height_mm??0)/10).toFixed(0)} см`);
    return parts.join(' · ');
  }

  private fmtPrice(p: UnifiedProduct): string {
    if (p.priceRange.min == null) return '—';
    if (p.priceRange.min === p.priceRange.max) return `${p.priceRange.min.toLocaleString('ru')} ₽`;
    return `${p.priceRange.min.toLocaleString('ru')} – ${p.priceRange.max!.toLocaleString('ru')} ₽`;
  }

  private tplRow(p: UnifiedProduct): string {
    const checked = this.selected.has(p.key);
    return `
    <div class="cmp-row${p.hasConflict?' cmp-row--conflict':''}${checked?' cmp-row--selected':''}" data-action="open-product" data-key="${esc(p.key)}">
      <div class="cmp-row-check" data-action="toggle-select" data-key="${esc(p.key)}">
        <input type="checkbox" ${checked?'checked':''} tabindex="-1" readonly>
      </div>
      <div class="cmp-row-thumb">
        ${p.cover ? `<img src="${esc(p.cover)}" loading="lazy" alt="">` : '<div class="cmp-row-no-img"></div>'}
      </div>
      <div class="cmp-row-info">
        <div class="cmp-row-name">${esc(p.displayName)}</div>
        <div class="cmp-row-sub">
          <span class="cmp-row-vc">${esc(p.vendorCode)}</span>
          ${p.brand ? `<span class="cmp-row-brand">${esc(p.brand)}</span>` : ''}
        </div>
      </div>
      <div class="cmp-row-mps">${this.tplMpBadges(p)}</div>
      <div class="cmp-row-price">${this.fmtPrice(p)}</div>
      <div class="cmp-row-dims${p.hasConflict?' cmp-row-dims--conflict':''}">${this.fmtDims(p.dims)}</div>
    </div>`;
  }

  private tplCard(p: UnifiedProduct): string {
    const checked = this.selected.has(p.key);
    return `
    <div class="cmp-card-item${p.hasConflict?' cmp-card-item--conflict':''}${checked?' cmp-card-item--selected':''}" data-action="open-product" data-key="${esc(p.key)}">
      <div class="cmp-card-photo">
        <div class="cmp-card-check" data-action="toggle-select" data-key="${esc(p.key)}">
          <input type="checkbox" ${checked?'checked':''} tabindex="-1" readonly>
        </div>
        ${p.cover ? `<img src="${esc(p.cover)}" loading="lazy" alt="">` : '<div class="cmp-card-no-img"></div>'}
      </div>
      <div class="cmp-card-body">
        <div class="cmp-card-name">${esc(p.displayName)}</div>
        <div class="cmp-card-vc">${esc(p.vendorCode)}</div>
        <div class="cmp-card-foot">
          ${this.tplMpBadges(p)}
          <span class="cmp-card-price">${this.fmtPrice(p)}</span>
        </div>
      </div>
    </div>`;
  }

  // ─────────────────────────── Modal ────────────────────────────────────────

  private getProduct(key: string): UnifiedProduct | undefined {
    return this.products.find(p => p.key === key);
  }

  private openModal(key: string): void {
    this.openKey = key;
    this.modalTab = 'overview';
    this.editState.clear();
    this.photoAddStoreId = null;
    const p = this.getProduct(key);
    if (!p) return;

    const dimsFromProduct = (pr: MpProduct): { weight_kg: string; length_cm: string; width_cm: string; height_cm: string } => ({
      weight_kg: pr?.weight_kg ? String(+pr.weight_kg) : '',
      length_cm: pr?.length_cm ? String(+pr.length_cm) : '',
      width_cm:  pr?.width_cm  ? String(+pr.width_cm)  : '',
      height_cm: pr?.height_cm ? String(+pr.height_cm) : '',
    });

    const locked = this.lockedCodes.has(p.vendorCode.toLowerCase());
    for (const e of p.ozon) {
      const d = dimsFromProduct(e.product);
      const pr = e.product;
      const cached = this.extraDataCache.get(`${e.store.id}:${p.vendorCode}`);
      this.editState.set(e.store.id, {
        ...d, price: e.price != null ? String(e.price) : '', discount: '',
        photos: [...(p.photoSets.find(s=>s.storeId===e.store.id)?.photos??[])],
        priceLocked: locked, saving: false, saveError: '',
        name: pr?.name ?? '', brand: '', barcode: pr?.barcode ?? '', description: '', vat: cached?.vat ?? '',
        extraLoaded: !!cached, extraLoading: false,
      });
    }
    for (const e of p.wb) {
      const d = dimsFromProduct(e.product);
      const pr = e.product;
      const cached = this.extraDataCache.get(`${e.store.id}:${p.vendorCode}`);
      this.editState.set(e.store.id, {
        ...d, price: e.price != null ? String(e.price) : '',
        discount: pr.discount != null ? String(pr.discount) : '',
        photos: [...(p.photoSets.find(s=>s.storeId===e.store.id)?.photos??[])],
        priceLocked: locked, saving: false, saveError: '',
        name: pr?.title ?? '', brand: pr?.brand ?? '', barcode: '', description: cached?.description ?? '', vat: '',
        extraLoaded: !!cached, extraLoading: false,
      });
    }
    for (const e of p.ym) {
      const d = dimsFromProduct(e.product);
      const pr = e.product;
      const cached = this.extraDataCache.get(`${e.store.id}:${p.vendorCode}`);
      this.editState.set(e.store.id, {
        ...d, price: e.price != null ? String(e.price) : '', discount: '',
        photos: [...(p.photoSets.find(s=>s.storeId===e.store.id)?.photos??[])],
        priceLocked: locked, saving: false, saveError: '',
        name: pr?.name ?? '', brand: pr?.vendor ?? '', barcode: '', description: cached?.description ?? '', vat: '',
        extraLoaded: !!cached, extraLoading: false,
      });
    }

    this.renderModal();
  }

  private closeModal(): void {
    this.openKey = null;
    this.container.querySelector('.cmp-modal-backdrop')?.remove();
  }

  private renderModal(): void {
    this.container.querySelector('.cmp-modal-backdrop')?.remove();
    if (!this.openKey) return;
    const p = this.getProduct(this.openKey);
    if (!p) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.tplModal(p);
    while (tmp.firstChild) this.container.appendChild(tmp.firstChild);
  }

  private tplModal(p: UnifiedProduct): string {
    return `
<div class="cmp-modal-backdrop" data-action="close-modal-backdrop">
  <div class="cmp-modal">
    <div class="cmp-modal-hdr">
      <div class="cmp-modal-hdr-left">
        ${this.tplMpBadges(p)}
        <span class="cmp-modal-vc">${esc(p.vendorCode)}</span>
        ${p.brand ? `<span class="cmp-modal-brand">· ${esc(p.brand)}</span>` : ''}
      </div>
      <button class="cmp-modal-x" data-action="close-modal">✕</button>
    </div>
    <div class="cmp-modal-title">${esc(p.displayName)}</div>
    <div class="cmp-modal-body">
      ${this.tplGallery(p)}
      <div class="cmp-modal-right">
        <div class="cmp-modal-tabs">
          <button class="cmp-modal-tab ${this.modalTab==='overview'?'active':''}" data-action="modal-tab" data-tab="overview">Обзор</button>
          <button class="cmp-modal-tab ${this.modalTab==='card'?'active':''}" data-action="modal-tab" data-tab="card">Карточка</button>
          <button class="cmp-modal-tab ${this.modalTab==='photos'?'active':''}" data-action="modal-tab" data-tab="photos">Фото</button>
        </div>
        <div class="cmp-modal-tab-content" id="cmp-tab-content">
          ${this.modalTab==='overview' ? this.tplTabOverview(p) : this.modalTab==='card' ? this.tplTabCard(p) : this.tplTabPhotos(p)}
        </div>
      </div>
    </div>
  </div>
</div>`;
  }

  private tplGallery(p: UnifiedProduct): string {
    const all = p.photoSets.flatMap(s => s.photos).filter((u, i, a) => a.indexOf(u) === i).slice(0, 20);
    const main = all[0] ?? '';
    return `
    <div class="cmp-modal-gallery">
      <div class="cmp-gallery-main" id="cmp-gallery-main">
        ${main
          ? `<img src="${esc(main)}" alt="" data-action="open-lightbox" data-url="${esc(main)}">`
          : '<div class="cmp-gallery-empty">Нет фото</div>'}
      </div>
      <div class="cmp-gallery-thumbs">
        ${all.map((url, i) => `
          <div class="cmp-gallery-thumb ${i===0?'active':''}" data-action="select-photo" data-url="${esc(url)}">
            <img src="${esc(url)}" loading="lazy" alt="">
          </div>`).join('')}
      </div>
    </div>`;
  }

  private tplTabOverview(p: UnifiedProduct): string {
    const allEntries: { mpLabel: string; mp: string; storeName: string; price: number|null; url: string|null }[] = [
      ...p.ozon.map(e => ({ mpLabel: 'OZ', mp: 'ozon',   storeName: e.store.name??'Ozon',   price: e.price, url: mpStorefrontUrl('ozon', e.product) })),
      ...p.wb.map(e =>   ({ mpLabel: 'WB', mp: 'wb',     storeName: e.store.name??'WB',     price: e.price, url: mpStorefrontUrl('wb', e.product, e.nmID) })),
      ...p.ym.map(e =>   ({ mpLabel: 'ЯМ', mp: 'yandex', storeName: e.store.name??'Яндекс', price: e.price, url: mpStorefrontUrl('yandex', e.product) })),
    ];

    const dimSources: { label: string; dims: Dimensions }[] = [];
    for (const e of p.ozon) {
      const d = this.resolveEntryDims(e.product, e.store.id, p.vendorCode);
      if (d) dimSources.push({ label: `Ozon · ${e.store.name}`, dims: d });
    }
    for (const e of p.wb) {
      const d = this.resolveEntryDims(e.product, e.store.id, p.vendorCode);
      if (d) dimSources.push({ label: `WB · ${e.store.name}`, dims: d });
    }
    for (const e of p.ym) {
      const d = this.resolveEntryDims(e.product, e.store.id, p.vendorCode);
      if (d) dimSources.push({ label: `ЯМ · ${e.store.name}`, dims: d });
    }

    const stockRows: { mpLabel: string; mp: string; storeName: string; text: string; low: boolean }[] = [
      ...p.ozon.map(e => {
        const pr = e.product;
        const fbo = pr.stock_fbo ?? 0;
        const fbs = pr.stock_fbs ?? 0;
        const total = fbo + fbs;
        const statusLabel = OZON_STATUS_LABELS[pr.status] ?? pr.status ?? '';
        return {
          mpLabel: 'OZ', mp: 'ozon', storeName: e.store.name ?? 'Ozon',
          text: `FBO: ${fbo} · FBS: ${fbs}${statusLabel ? ' · ' + statusLabel : ''}`,
          low: total === 0,
        };
      }),
      ...p.wb.map(e => {
        const pr = e.product;
        const total = pr.stock_total ?? 0;
        return {
          mpLabel: 'WB', mp: 'wb', storeName: e.store.name ?? 'WB',
          text: `Остаток: ${total}`,
          low: total === 0,
        };
      }),
      ...p.ym.map(e => {
        const pr = e.product;
        const total = pr.stock_total ?? 0;
        const available = pr.stock_available ?? 0;
        const archived = !!pr.archived;
        return {
          mpLabel: 'ЯМ', mp: 'yandex', storeName: e.store.name ?? 'Яндекс',
          text: `Доступно: ${available} · Всего: ${total}${archived ? ' · В архиве' : ''}`,
          low: available === 0,
        };
      }),
    ];

    return `
    <div class="cmp-ov">
      <div class="cmp-ov-block">
        <div class="cmp-ov-head">Цены по магазинам</div>
        ${allEntries.map(e => `
          <div class="cmp-ov-row">
            <span class="cmp-mp-badge cmp-mp-badge--${e.mp}">${e.mpLabel}</span>
            <span class="cmp-ov-store">${esc(e.storeName)}</span>
            <span class="cmp-ov-val">${e.price ? e.price.toLocaleString('ru') + ' ₽' : '—'}</span>
            ${e.url
              ? `<a class="cmp-ov-link" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="Открыть на маркетплейсе">${I.externalLink('', 14)}</a>`
              : `<span class="cmp-ov-link cmp-ov-link--disabled" title="Ссылка недоступна — нужна синхронизация">${I.externalLink('', 14)}</span>`}
          </div>`).join('')}
      </div>

      <div class="cmp-ov-block">
        <div class="cmp-ov-head">Остатки и статус</div>
        ${stockRows.length
          ? stockRows.map(s => `
            <div class="cmp-ov-row">
              <span class="cmp-mp-badge cmp-mp-badge--${s.mp}">${s.mpLabel}</span>
              <span class="cmp-ov-store">${esc(s.storeName)}</span>
              <span class="cmp-ov-val${s.low ? ' cmp-ov-val--low' : ''}">${esc(s.text)}</span>
            </div>`).join('')
          : `<div class="cmp-ov-hint">Данных нет. Нажмите «Обновить» в строке синхронизации.</div>`}
      </div>

      <div class="cmp-ov-block">
        <div class="cmp-ov-head">Габариты ${p.hasConflict ? '<span class="cmp-conflict-tag">⚠ Конфликт</span>' : ''}</div>
        ${dimSources.length
          ? dimSources.map(d => `
            <div class="cmp-ov-row">
              <span class="cmp-ov-store">${esc(d.label)}</span>
              <span class="cmp-ov-val">${this.fmtDims(d.dims)}</span>
            </div>`).join('')
          : `<div class="cmp-ov-hint">Данных нет. Нажмите «Обновить» в строке синхронизации.</div>`}
      </div>
    </div>`;
  }

  private tplTabCard(p: UnifiedProduct): string {
    const mkSection = (storeId: string, mp: 'ozon'|'wb'|'yandex', storeName: string) => {
      const st = this.editState.get(storeId);
      if (!st) return '';
      const mpLabel = mp === 'ozon' ? 'OZ' : mp === 'wb' ? 'WB' : 'ЯМ';
      const showBrand = mp === 'wb' || mp === 'yandex';
      const showBarcode = mp === 'ozon';
      const showDescription = mp === 'wb' || mp === 'yandex';
      const showVat = mp === 'ozon';
      return `
      <div class="cmp-edit-section">
        <div class="cmp-edit-head">
          <span class="cmp-mp-badge cmp-mp-badge--${mp}">${mpLabel}</span>
          <span class="cmp-edit-store">${esc(storeName)}</span>
        </div>
        <div class="cmp-edit-grid">
          <label class="cmp-edit-field cmp-edit-field--wide">
            <span class="cmp-edit-label">Название</span>
            <input type="text" class="cmp-edit-input" data-field="name" data-store-id="${storeId}"
              value="${esc(st.name)}" placeholder="—">
          </label>
          ${showBrand ? `<label class="cmp-edit-field">
            <span class="cmp-edit-label">Бренд</span>
            <input type="text" class="cmp-edit-input" data-field="brand" data-store-id="${storeId}"
              value="${esc(st.brand)}" placeholder="—">
          </label>` : ''}
          ${showBarcode ? `<label class="cmp-edit-field">
            <span class="cmp-edit-label">Штрихкод</span>
            <input type="text" class="cmp-edit-input" data-field="barcode" data-store-id="${storeId}"
              value="${esc(st.barcode)}" placeholder="—">
          </label>` : ''}
          ${showVat ? `<label class="cmp-edit-field">
            <span class="cmp-edit-label">НДС</span>
            <select class="cmp-edit-input" data-field="vat" data-store-id="${storeId}" ${st.extraLoading?'disabled':''}>
              <option value="0"    ${st.vat==='0'?'selected':''}>Без НДС</option>
              <option value="0.1"  ${st.vat==='0.1'?'selected':''}>10%</option>
              <option value="0.2"  ${st.vat==='0.2'?'selected':''}>20%</option>
            </select>
          </label>` : ''}
          <label class="cmp-edit-field">
            <span class="cmp-edit-label">
              Цена (₽)
              ${st.priceLocked ? '<span class="cmp-lock-tag" title="Управляется репрайсером">' + I.lock('',12) + '</span>' : ''}
            </span>
            <input type="number" class="cmp-edit-input" data-field="price" data-store-id="${storeId}"
              value="${esc(st.price)}" ${st.priceLocked ? 'disabled' : ''} placeholder="—">
          </label>
          ${mp === 'wb' ? `<label class="cmp-edit-field">
            <span class="cmp-edit-label">Скидка (%)</span>
            <input type="number" min="0" max="99" class="cmp-edit-input" data-field="discount" data-store-id="${storeId}"
              value="${esc(st.discount)}" ${st.priceLocked ? 'disabled' : ''} placeholder="0">
          </label>` : ''}
          <label class="cmp-edit-field">
            <span class="cmp-edit-label">Вес (кг)</span>
            <input type="number" step="0.001" class="cmp-edit-input" data-field="weight_kg" data-store-id="${storeId}"
              value="${esc(st.weight_kg)}" placeholder="0.000">
          </label>
          <label class="cmp-edit-field">
            <span class="cmp-edit-label">Длина (см)</span>
            <input type="number" step="0.1" class="cmp-edit-input" data-field="length_cm" data-store-id="${storeId}"
              value="${esc(st.length_cm)}" placeholder="0.0">
          </label>
          <label class="cmp-edit-field">
            <span class="cmp-edit-label">Ширина (см)</span>
            <input type="number" step="0.1" class="cmp-edit-input" data-field="width_cm" data-store-id="${storeId}"
              value="${esc(st.width_cm)}" placeholder="0.0">
          </label>
          <label class="cmp-edit-field">
            <span class="cmp-edit-label">Высота (см)</span>
            <input type="number" step="0.1" class="cmp-edit-input" data-field="height_cm" data-store-id="${storeId}"
              value="${esc(st.height_cm)}" placeholder="0.0">
          </label>
          ${showDescription ? `<label class="cmp-edit-field cmp-edit-field--wide">
            <span class="cmp-edit-label">Описание ${st.extraLoading ? '<span class="cmp-spinner-sm"></span>' : ''}</span>
            <textarea class="cmp-edit-input cmp-edit-textarea" data-field="description" data-store-id="${storeId}"
              rows="4" ${st.extraLoading?'disabled':''} placeholder="—">${esc(st.description)}</textarea>
          </label>` : ''}
        </div>
        ${st.saveError ? `<div class="cmp-edit-error">${esc(st.saveError)}</div>` : ''}
        <div class="cmp-edit-foot">
          <button class="cmp-btn cmp-btn-primary${st.saving?' loading':''}" data-action="save-card"
            data-store-id="${storeId}" data-mp="${mp}" ${st.saving?'disabled':''}>
            ${st.saving ? '<span class="cmp-spinner-sm"></span> Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>`;
    };
    return `<div class="cmp-tab-card">
      ${p.ozon.map(e => mkSection(e.store.id, 'ozon', e.store.name??'Ozon')).join('')}
      ${p.wb.map(e =>   mkSection(e.store.id, 'wb',   e.store.name??'WB')).join('')}
      ${p.ym.map(e =>   mkSection(e.store.id, 'yandex', e.store.name??'Яндекс')).join('')}
    </div>`;
  }

  private tplTabPhotos(p: UnifiedProduct): string {
    const all = [
      ...p.ozon.map(e => ({ storeId: e.store.id, storeName: e.store.name??'Ozon', mp: 'ozon'   as const, mpLabel: 'OZ' })),
      ...p.wb.map(e =>   ({ storeId: e.store.id, storeName: e.store.name??'WB',   mp: 'wb'     as const, mpLabel: 'WB' })),
      ...p.ym.map(e =>   ({ storeId: e.store.id, storeName: e.store.name??'Яндекс', mp: 'yandex' as const, mpLabel: 'ЯМ' })),
    ];
    return `<div class="cmp-tab-photos">
      ${all.map(s => {
        const st = this.editState.get(s.storeId);
        const photos = st?.photos ?? [];
        const isAdding = this.photoAddStoreId === s.storeId;
        const syncedAt = fmtSyncDate(catalogCache.getSyncedAt(s.storeId));
        return `
        <div class="cmp-photo-section">
          <div class="cmp-photo-hdr">
            <span class="cmp-mp-badge cmp-mp-badge--${s.mp}">${s.mpLabel}</span>
            <span class="cmp-photo-store">${esc(s.storeName)}</span>
            <span class="cmp-photo-sync">· обновлено ${syncedAt}</span>
            ${st?.saving ? '<span class="cmp-spinner-sm"></span>' : ''}
            ${st?.saveError ? `<span class="cmp-photo-err">${esc(st.saveError)}</span>` : ''}
          </div>

          <div class="cmp-photo-grid">
            ${photos.length === 0 ? '<div class="cmp-photo-none">Фото нет</div>' : ''}
            ${photos.map((url, idx) => `
              <div class="cmp-photo-cell" draggable="true" data-drag-idx="${idx}" data-drag-store-id="${s.storeId}">
                <div class="cmp-photo-wrap" data-action="open-lightbox" data-url="${esc(url)}">
                  <img src="${esc(url)}" loading="lazy" alt="">
                  <span class="cmp-photo-num">${idx+1}</span>
                </div>
                <div class="cmp-photo-ctrl">
                  <span class="cmp-drag-handle" title="Перетащить">⠿</span>
                  <button class="cmp-pbtn cmp-pbtn--del" data-action="photo-delete" data-idx="${idx}" data-store-id="${s.storeId}" title="Удалить">✕</button>
                </div>
              </div>`).join('')}
          </div>

          <div class="cmp-photo-acts">
            <button class="cmp-btn cmp-btn-sm" data-action="photo-add-toggle" data-store-id="${s.storeId}">+ Добавить</button>
            ${photos.length > 0 ? `
              <button class="cmp-btn cmp-btn-sm cmp-btn-primary${st?.saving?' loading':''}"
                data-action="save-photos" data-store-id="${s.storeId}" data-mp="${s.mp}" ${st?.saving?'disabled':''}>
                ${st?.saving ? '<span class="cmp-spinner-sm"></span>' : 'Сохранить фото'}
              </button>` : ''}
          </div>

          ${isAdding ? `
          <div class="cmp-photo-add">
            <div class="cmp-photo-add-tabs">
              <button class="cmp-photo-add-tab ${this.photoAddMode==='url'?'active':''}" data-action="photo-mode-url" data-store-id="${s.storeId}">По ссылке</button>
              <button class="cmp-photo-add-tab ${this.photoAddMode==='file'?'active':''}" data-action="photo-mode-file" data-store-id="${s.storeId}">С компьютера</button>
            </div>
            ${this.photoAddMode === 'url' ? `
            <div class="cmp-photo-add-url">
              <input type="url" id="photo-url-input" class="cmp-edit-input" placeholder="https://…" value="${esc(this.photoAddUrlValue)}">
              <button class="cmp-btn cmp-btn-primary" data-action="photo-add-url" data-store-id="${s.storeId}">Добавить</button>
            </div>` : `
            <div class="cmp-photo-add-file">
              <input type="file" id="photo-file-input" accept="image/*" multiple style="display:none" data-store-id="${s.storeId}">
              <button class="cmp-btn cmp-btn-primary" data-action="photo-pick-file" data-store-id="${s.storeId}">Выбрать файлы</button>
              <span class="cmp-photo-file-hint">Загружаются при сохранении</span>
            </div>`}
          </div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  // ─────────────────────────── Mass selection / edit ────────────────────────

  private tplSelectBar(): string {
    if (!this.selected.size) return '';
    return `
    <div class="cmp-select-info">
      <span class="cmp-select-count">${this.selected.size} выбрано</span>
      <button class="cmp-btn cmp-btn-sm" data-action="select-clear">Снять выделение</button>
      <button class="cmp-btn cmp-btn-sm cmp-btn-primary" data-action="open-mass-edit">Массовое редактирование</button>
    </div>`;
  }

  private updateSelectBar(): void {
    const bar = this.container.querySelector<HTMLElement>('#cmp-select-bar');
    if (bar) bar.innerHTML = this.tplSelectBar();
  }

  private massEditAvailability(): { brand: boolean; vat: boolean; discount: boolean } {
    const selectedProducts = this.products.filter(p => this.selected.has(p.key));
    return {
      brand:    selectedProducts.some(p => p.wb.length > 0 || p.ym.length > 0),
      vat:      selectedProducts.some(p => p.ozon.length > 0),
      discount: selectedProducts.some(p => p.wb.length > 0),
    };
  }

  private openMassEdit(): void {
    this.massEdit = {
      priceMode: 'set', price: '',
      weight_kg: '', length_cm: '', width_cm: '', height_cm: '',
      discount: '', brand: '', vat: '',
      saving: false, error: '', progress: '',
    };
    this.massEditOpen = true;
    this.renderMassEditModal();
  }

  private renderMassEditModal(): void {
    this.container.querySelector('.cmp-mass-modal-backdrop')?.remove();
    if (!this.massEditOpen) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.tplMassEditModal();
    while (tmp.firstChild) this.container.appendChild(tmp.firstChild);
  }

  private tplMassEditModal(): string {
    const m = this.massEdit;
    const avail = this.massEditAvailability();
    return `
    <div class="cmp-modal-backdrop cmp-mass-modal-backdrop" data-action="close-mass-edit-backdrop">
      <div class="cmp-modal cmp-modal--sm">
        <div class="cmp-modal-hdr">
          <div class="cmp-modal-hdr-left"><span class="cmp-edit-store">Массовое редактирование · ${this.selected.size} товаров</span></div>
          <button class="cmp-modal-x" data-action="close-mass-edit">✕</button>
        </div>
        <div class="cmp-modal-tab-content">
          <div class="cmp-edit-grid">
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Цена</span>
              <select class="cmp-edit-input" data-mfield="priceMode" ${m.saving?'disabled':''}>
                <option value="set"     ${m.priceMode==='set'?'selected':''}>Установить, ₽</option>
                <option value="percent" ${m.priceMode==='percent'?'selected':''}>Изменить на, %</option>
                <option value="delta"   ${m.priceMode==='delta'?'selected':''}>Изменить на, ₽</option>
              </select>
            </label>
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Значение цены</span>
              <input type="number" class="cmp-edit-input" data-mfield="price" value="${esc(m.price)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Вес (кг)</span>
              <input type="number" step="0.001" class="cmp-edit-input" data-mfield="weight_kg" value="${esc(m.weight_kg)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Длина (см)</span>
              <input type="number" step="0.1" class="cmp-edit-input" data-mfield="length_cm" value="${esc(m.length_cm)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Ширина (см)</span>
              <input type="number" step="0.1" class="cmp-edit-input" data-mfield="width_cm" value="${esc(m.width_cm)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>
            <label class="cmp-edit-field">
              <span class="cmp-edit-label">Высота (см)</span>
              <input type="number" step="0.1" class="cmp-edit-input" data-mfield="height_cm" value="${esc(m.height_cm)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>
            ${avail.discount ? `<label class="cmp-edit-field">
              <span class="cmp-edit-label">Скидка WB (%)</span>
              <input type="number" min="0" max="99" class="cmp-edit-input" data-mfield="discount" value="${esc(m.discount)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>` : ''}
            ${avail.brand ? `<label class="cmp-edit-field">
              <span class="cmp-edit-label">Бренд</span>
              <input type="text" class="cmp-edit-input" data-mfield="brand" value="${esc(m.brand)}" placeholder="—" ${m.saving?'disabled':''}>
            </label>` : ''}
            ${avail.vat ? `<label class="cmp-edit-field">
              <span class="cmp-edit-label">НДС (Ozon)</span>
              <select class="cmp-edit-input" data-mfield="vat" ${m.saving?'disabled':''}>
                <option value="">— не менять —</option>
                <option value="0"   ${m.vat==='0'?'selected':''}>Без НДС</option>
                <option value="0.1" ${m.vat==='0.1'?'selected':''}>10%</option>
                <option value="0.2" ${m.vat==='0.2'?'selected':''}>20%</option>
              </select>
            </label>` : ''}
          </div>
          <div class="cmp-mass-hint">Заполните только те поля, которые нужно изменить — пустые поля останутся как есть. Цены товаров, заблокированных репрайсером, не изменятся.</div>
          ${m.error ? `<div class="cmp-edit-error">${esc(m.error)}</div>` : ''}
          ${m.progress ? `<div class="cmp-mass-progress">${esc(m.progress)}</div>` : ''}
          <div class="cmp-edit-foot">
            <button class="cmp-btn cmp-btn-primary${m.saving?' loading':''}" data-action="apply-mass-edit" ${m.saving?'disabled':''}>
              ${m.saving ? '<span class="cmp-spinner-sm"></span> Применение…' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /** Новые габариты товара с учётом полей массового редактирования (пустые поля — берём текущие). */
  private massEditDims(pr: MpProduct): Dimensions {
    const m = this.massEdit;
    return {
      weight_g:  m.weight_kg.trim() !== '' ? Math.round(+m.weight_kg * 1000) : Math.round((pr.weight_kg ?? 0) * 1000),
      length_mm: m.length_cm.trim() !== '' ? Math.round(+m.length_cm * 10)  : Math.round((pr.length_cm ?? 0) * 10),
      width_mm:  m.width_cm.trim()  !== '' ? Math.round(+m.width_cm  * 10)  : Math.round((pr.width_cm  ?? 0) * 10),
      height_mm: m.height_cm.trim() !== '' ? Math.round(+m.height_cm * 10) : Math.round((pr.height_cm ?? 0) * 10),
    };
  }

  /** Записать изменённые габариты массового редактирования обратно в строку товара (после успешного API-вызова). */
  private applyMassEditDims(pr: MpProduct): void {
    const m = this.massEdit;
    pr.weight_kg = m.weight_kg.trim() !== '' ? +m.weight_kg : pr.weight_kg;
    pr.length_cm = m.length_cm.trim() !== '' ? +m.length_cm : pr.length_cm;
    pr.width_cm  = m.width_cm.trim()  !== '' ? +m.width_cm  : pr.width_cm;
    pr.height_cm = m.height_cm.trim() !== '' ? +m.height_cm : pr.height_cm;
  }

  private async applyMassEdit(): Promise<void> {
    const m = this.massEdit;
    const selectedProducts = this.products.filter(p => this.selected.has(p.key));
    if (!selectedProducts.length) return;

    m.saving = true; m.error = ''; m.progress = '';
    this.renderMassEditModal();

    const hasPrice    = m.price.trim() !== '';
    const hasDims     = m.weight_kg.trim() !== '' || m.length_cm.trim() !== '' || m.width_cm.trim() !== '' || m.height_cm.trim() !== '';
    const hasDiscount = m.discount.trim() !== '';
    const hasBrand    = m.brand.trim() !== '';
    const hasVat      = m.vat.trim() !== '';

    const computeNewPrice = (current: number | null): number | null => {
      if (!hasPrice) return null;
      const v = +m.price;
      if (m.priceMode === 'set')     return v;
      if (m.priceMode === 'percent') return current != null ? Math.round(current * (1 + v / 100)) : null;
      return current != null ? Math.round(current + v) : null;
    };

    const total = selectedProducts.length;
    let errors = 0;
    const failedCodes: string[] = [];

    for (let i = 0; i < total; i++) {
      const p = selectedProducts[i];
      m.progress = `Обработка ${i + 1} из ${total}…`;
      this.renderMassEditModal();

      const locked = this.lockedCodes.has(p.vendorCode.toLowerCase());

      try {
        // ── Ozon
        for (const e of p.ozon) {
          const creds = { client_id: e.store.client_id, api_key: e.store.api_key };
          const pr = e.product;
          if (hasDims || hasVat) {
            const dims = this.massEditDims(pr);
            const oz = toOzon(dims);
            const item: Record<string, unknown> = {
              offer_id: p.vendorCode,
              weight: oz.weight, weight_unit: oz.weight_unit,
              depth: oz.depth, width: oz.width, height: oz.height,
              dimension_unit: oz.dimension_unit,
            };
            if (hasVat) item.vat = m.vat;
            await ozonApi.updateProduct(creds, item);
            if (hasDims) this.applyMassEditDims(pr);
          }
          if (hasPrice && !locked) {
            const newPrice = computeNewPrice(e.price);
            if (newPrice != null && newPrice > 0) {
              const priceStr = String(newPrice);
              await ozonApi.updatePrices(creds, [{ offer_id: p.vendorCode, price: priceStr, old_price: priceStr, min_price: priceStr }]);
              e.price = newPrice;
            }
          }
        }

        // ── WB
        for (const e of p.wb) {
          if (!e.nmID) continue;
          const pr = e.product;
          if (hasDims || hasBrand) {
            const dims = this.massEditDims(pr);
            const wb = toWb(dims);
            await wbApi.updateCard(e.store.api_key, e.nmID, {
              dimensions: { length: Math.round(wb.length ?? 0), width: Math.round(wb.width ?? 0), height: Math.round(wb.height ?? 0) },
              brand: hasBrand ? m.brand : undefined,
            });
            if (hasDims) this.applyMassEditDims(pr);
            if (hasBrand) pr.brand = m.brand;
          }
          if ((hasPrice || hasDiscount) && !locked) {
            const newPrice = hasPrice ? computeNewPrice(e.price) : e.price;
            const discount = hasDiscount ? Math.round(+m.discount) : (pr.discount != null ? Math.round(pr.discount) : undefined);
            if (newPrice != null && newPrice > 0) {
              await updateWbPrices(e.store.api_key, [{ nmID: e.nmID, price: Math.round(newPrice), discount }]);
              e.price = newPrice;
              if (hasDiscount) pr.discount = +m.discount;
            }
          }
        }

        // ── Yandex
        for (const e of p.ym) {
          const pr = e.product;
          if (hasDims || hasBrand) {
            const dims = this.massEditDims(pr);
            const ym = toYm(dims);
            const offer: Record<string, unknown> = {
              offerId: p.vendorCode,
              weightDimensions: { length: ym.length, width: ym.width, height: ym.height, weight: ym.weight },
            };
            if (hasBrand) offer.vendor = m.brand;
            await yandexApi.updateOffer(e.store.api_key, e.store.business_id!, offer);
            if (hasDims) this.applyMassEditDims(pr);
            if (hasBrand) pr.vendor = m.brand;
          }
          if (hasPrice && !locked && e.store.campaign_id) {
            const newPrice = computeNewPrice(e.price);
            if (newPrice != null && newPrice > 0) {
              await yandexApi.updateOfferPrices(e.store.api_key, String(e.store.campaign_id), [{ offerId: p.vendorCode, price: newPrice }]);
              e.price = newPrice;
            }
          }
        }

      } catch (e: any) {
        errors++;
        failedCodes.push(p.vendorCode);
        console.warn(`[mass-edit] ${p.vendorCode}:`, e?.message ?? e);
      } finally {
        // Пересчитываем независимо от того, упала ли часть запросов посередине —
        // успевшие примениться изменения (например, габариты в Ozon при ошибке в WB)
        // не должны "потеряться" из отображаемых данных.
        p.dims = this.resolveDims(p.vendorCode, p.ozon, p.wb, p.ym);
        if (hasPrice) {
          const prices = [...p.ozon.map(x => x.price), ...p.wb.map(x => x.price), ...p.ym.map(x => x.price)]
            .filter((x): x is number => x !== null && x > 0);
          p.priceRange = { min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null };
        }
      }
    }

    m.saving = false;
    m.progress = '';
    if (errors > 0) {
      const shown = failedCodes.slice(0, 5).join(', ') + (failedCodes.length > 5 ? `, +${failedCodes.length - 5}` : '');
      m.error = `Готово с ошибками: ${errors} из ${total} товаров не обновлены (${shown}).`;
      this.renderMassEditModal();
    } else {
      this.massEditOpen = false;
      this.selected.clear();
    }
    this.applyFilters();
    this.renderShell();
  }

  // ─────────────────────────── Lightbox ─────────────────────────────────────

  private renderLightbox(): void {
    this.container.querySelector('.cmp-lightbox')?.remove();
    if (!this.lightboxUrl) return;
    const d = document.createElement('div');
    d.className = 'cmp-lightbox';
    d.innerHTML = `
    <div class="cmp-lightbox-bg" data-action="close-lightbox">
      <button class="cmp-lightbox-x" data-action="close-lightbox">✕</button>
      <img src="${esc(this.lightboxUrl)}" class="cmp-lightbox-img" alt="">
    </div>`;
    this.container.appendChild(d);
  }

  // ─────────────────────────── Infinite scroll ──────────────────────────────

  private setupInfiniteScroll(): void {
    this.observer?.disconnect();
    const s = this.container.querySelector('#cmp-sentinel');
    if (!s) return;
    this.observer = new IntersectionObserver(es => { if (es[0]?.isIntersecting) this.appendChunk(); }, { rootMargin: '300px' });
    this.observer.observe(s);
  }

  // ─────────────────────────── Events ───────────────────────────────────────

  private setupEvents(): void {
    if (this.eventsReady) return;
    this.eventsReady = true;
    const c = this.container;

    c.addEventListener('input', e => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'cmp-search-input') {
        this.search = t.value;
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.applyFilters(), 200);
      }
      else if (t.matches('[data-field]')) {
        const st = this.editState.get(t.getAttribute('data-store-id')!);
        if (st) (st as any)[t.getAttribute('data-field')!] = t.value;
      }
      else if (t.matches('[data-filter]')) {
        (this.filters as any)[t.getAttribute('data-filter')!] = t.value;
        this.applyFilters();
      }
      else if (t.matches('[data-mfield]')) {
        (this.massEdit as any)[t.getAttribute('data-mfield')!] = t.value;
      }
      else if (t.id === 'photo-url-input') { this.photoAddUrlValue = t.value; }
    });

    // ── Photo file upload (delegated once — avoids stacking listeners on repeated clicks)
    c.addEventListener('change', async e => {
      const t = e.target as HTMLInputElement;
      if (t.id !== 'photo-file-input' || !t.files?.length) return;
      const sid = t.getAttribute('data-store-id')!;
      const st = this.editState.get(sid);
      const p = this.openKey ? this.getProduct(this.openKey) : undefined;
      if (!st || !p) return;
      const { uploadPhoto } = await import('@/services/photoUpload');
      for (const f of Array.from(t.files)) {
        try {
          const url = await uploadPhoto(f, p.vendorCode);
          st.photos.push(url);
        } catch (err: any) {
          st.saveError = err?.message ?? 'Ошибка загрузки фото';
        }
      }
      t.value = '';
      this.photoAddStoreId = null;
      this.refreshPhotosTab();
    });

    c.addEventListener('click', async e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action')!;

      switch (action) {
        case 'reload': await this.load(); break;

        case 'view-list':   this.view = 'list';  this.applyFilters(); break;
        case 'view-cards':  this.view = 'cards'; this.applyFilters(); break;

        case 'filter-mp':
          this.filters.mp = el.getAttribute('data-val') as any;
          this.applyFilters(); break;
        case 'filter-conflicts':
          this.filters.conflicts = !this.filters.conflicts;
          this.applyFilters(); break;
        case 'toggle-advanced':
          this.showAdvanced = !this.showAdvanced;
          this.renderShell(); break;
        case 'clear-filters':
          this.filters = { mp:'', priceMin:'', priceMax:'', weightMin:'', weightMax:'', lengthMin:'', lengthMax:'', widthMin:'', widthMax:'', heightMin:'', heightMax:'', conflicts: false };
          this.applyFilters(); break;

        case 'toggle-select': {
          const key = el.getAttribute('data-key')!;
          if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
          const input = el.querySelector('input[type=checkbox]') as HTMLInputElement | null;
          if (input) input.checked = this.selected.has(key);
          el.closest('.cmp-row, .cmp-card-item')?.classList.toggle('cmp-row--selected', this.selected.has(key));
          el.closest('.cmp-row, .cmp-card-item')?.classList.toggle('cmp-card-item--selected', this.selected.has(key));
          this.updateSelectBar();
          break;
        }
        case 'select-clear':
          this.selected.clear();
          this.container.querySelectorAll('.cmp-row-check input, .cmp-card-check input').forEach(i => (i as HTMLInputElement).checked = false);
          this.container.querySelectorAll('.cmp-row--selected, .cmp-card-item--selected').forEach(node => node.classList.remove('cmp-row--selected', 'cmp-card-item--selected'));
          this.updateSelectBar();
          break;
        case 'open-mass-edit':
          this.openMassEdit(); break;
        case 'close-mass-edit':
          this.massEditOpen = false;
          this.container.querySelector('.cmp-mass-modal-backdrop')?.remove();
          break;
        case 'close-mass-edit-backdrop':
          if (el === e.currentTarget || el.classList.contains('cmp-mass-modal-backdrop')) {
            this.massEditOpen = false;
            el.remove();
          }
          break;
        case 'apply-mass-edit':
          await this.applyMassEdit(); break;

        case 'open-product':
          this.openModal(el.getAttribute('data-key')!); break;
        case 'close-modal':
          this.closeModal(); break;
        case 'close-modal-backdrop':
          if (el === e.currentTarget || el.classList.contains('cmp-modal-backdrop')) this.closeModal();
          break;

        case 'modal-tab': {
          this.modalTab = el.getAttribute('data-tab') as any;
          const p = this.getProduct(this.openKey!);
          if (!p) break;
          const content = this.container.querySelector<HTMLElement>('#cmp-tab-content');
          if (content) content.innerHTML = this.modalTab==='overview' ? this.tplTabOverview(p) : this.modalTab==='card' ? this.tplTabCard(p) : this.tplTabPhotos(p);
          this.container.querySelectorAll('.cmp-modal-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === this.modalTab));
          if (this.modalTab === 'card') this.loadExtraData(p);
          break;
        }

        case 'select-photo': {
          const url = el.getAttribute('data-url')!;
          const main = this.container.querySelector<HTMLElement>('#cmp-gallery-main');
          if (main) main.innerHTML = `<img src="${esc(url)}" alt="" data-action="open-lightbox" data-url="${esc(url)}">`;
          this.container.querySelectorAll('.cmp-gallery-thumb').forEach(t => t.classList.toggle('active', t.getAttribute('data-url') === url));
          break;
        }

        case 'open-lightbox':
          this.lightboxUrl = el.getAttribute('data-url');
          this.renderLightbox(); break;
        case 'close-lightbox':
          this.lightboxUrl = null;
          this.container.querySelector('.cmp-lightbox')?.remove(); break;

        case 'sync-store':
          await this.doSync(el.getAttribute('data-store-id')!, el.getAttribute('data-mp')!); break;

        case 'save-card':
          if (this.openKey) await this.doSaveCard(this.openKey, el.getAttribute('data-store-id')!, el.getAttribute('data-mp') as any);
          break;

        case 'photo-up':
          this.movePhoto(el.getAttribute('data-store-id')!, +el.getAttribute('data-idx')!, -1); break;
        case 'photo-down':
          this.movePhoto(el.getAttribute('data-store-id')!, +el.getAttribute('data-idx')!, +1); break;
        case 'photo-delete':
          this.deletePhoto(el.getAttribute('data-store-id')!, +el.getAttribute('data-idx')!); break;

        case 'photo-add-toggle': {
          const sid = el.getAttribute('data-store-id')!;
          this.photoAddStoreId = this.photoAddStoreId === sid ? null : sid;
          this.photoAddUrlValue = '';
          this.refreshPhotosTab(); break;
        }
        case 'photo-mode-url':  this.photoAddMode = 'url';  this.refreshPhotosTab(); break;
        case 'photo-mode-file': this.photoAddMode = 'file'; this.refreshPhotosTab(); break;

        case 'photo-add-url': {
          const url = this.photoAddUrlValue.trim();
          const sid = el.getAttribute('data-store-id')!;
          if (url) {
            const st = this.editState.get(sid);
            if (st) { st.photos.push(url); this.photoAddUrlValue = ''; this.photoAddStoreId = null; }
          }
          this.refreshPhotosTab(); break;
        }
        case 'photo-pick-file':
          this.container.querySelector<HTMLInputElement>('#photo-file-input')?.click();
          break;
        case 'save-photos':
          if (this.openKey) await this.doSavePhotos(this.openKey, el.getAttribute('data-store-id')!, el.getAttribute('data-mp') as any);
          break;
      }
    });

    // ── Drag & drop photo reorder ──────────────────────────────────────────
    c.addEventListener('dragstart', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (!cell) return;
      this.dragSrcIdx     = +(cell.dataset.dragIdx ?? -1);
      this.dragSrcStoreId = cell.dataset.dragStoreId ?? null;
      (e as DragEvent).dataTransfer!.effectAllowed = 'move';
      cell.classList.add('cmp-dragging');
    });
    c.addEventListener('dragover', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (!cell || this.dragSrcIdx === null) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'move';
      c.querySelectorAll('.cmp-drag-over').forEach(el => el.classList.remove('cmp-drag-over'));
      cell.classList.add('cmp-drag-over');
    });
    c.addEventListener('dragleave', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (cell && !cell.contains(e.relatedTarget as Node)) cell.classList.remove('cmp-drag-over');
    });
    c.addEventListener('drop', e => {
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (!cell || this.dragSrcIdx === null || !this.dragSrcStoreId) return;
      const dstIdx     = +(cell.dataset.dragIdx ?? -1);
      const dstStoreId = cell.dataset.dragStoreId ?? null;
      cell.classList.remove('cmp-drag-over');
      if (dstStoreId === this.dragSrcStoreId && dstIdx !== this.dragSrcIdx) {
        const st = this.editState.get(this.dragSrcStoreId);
        if (st) {
          const [moved] = st.photos.splice(this.dragSrcIdx, 1);
          st.photos.splice(dstIdx, 0, moved);
          this.refreshPhotosTab();
        }
      }
      this.dragSrcIdx = null; this.dragSrcStoreId = null;
    });
    c.addEventListener('dragend', () => {
      c.querySelectorAll('.cmp-dragging, .cmp-drag-over').forEach(el => el.classList.remove('cmp-dragging', 'cmp-drag-over'));
      this.dragSrcIdx = null; this.dragSrcStoreId = null;
    });

    document.addEventListener('keydown', e => {
      if (!this.visible) return;
      if (e.key === 'Escape') {
        if (this.lightboxUrl) { this.lightboxUrl = null; this.container.querySelector('.cmp-lightbox')?.remove(); }
        else if (this.openKey) this.closeModal();
      }
    });
  }

  // ─────────────────────────── Sync ─────────────────────────────────────────

  private async doSync(storeId: string, mp: string): Promise<void> {
    this.syncing.set(storeId, true);
    this.syncErr.delete(storeId);
    this.updateSyncBar();
    try {
      if (mp === 'ozon') {
        const s = this.ozStores.find(s => s.id === storeId);
        if (s) await syncOzonStore(s);
      } else if (mp === 'wb') {
        const s = this.wbStores.find(s => s.id === storeId);
        if (s) await syncWbStore(s);
      } else {
        const s = this.ymStores.find(s => s.id === storeId);
        if (s) await syncYmStore(s);
      }
      await this.load({ silent: true });
    } catch (e: any) {
      this.syncErr.set(storeId, e?.message?.slice(0, 60) ?? 'Ошибка');
    } finally {
      this.syncing.set(storeId, false);
      this.updateSyncBar();
    }
  }

  private updateSyncBar(): void {
    const bar = this.container.querySelector<HTMLElement>('#cmp-sync-bar');
    if (bar) bar.innerHTML = this.tplSyncBar();
  }

  // ─────────────────────────── Save card ────────────────────────────────────

  private async doSaveCard(productKey: string, storeId: string, mp: 'ozon'|'wb'|'yandex'): Promise<void> {
    const st = this.editState.get(storeId);
    const p  = this.getProduct(productKey);
    if (!st || !p) return;
    st.saving = true; st.saveError = '';
    this.refreshCardTab();

    let saveOk = false;
    try {
      const dims: Dimensions = {
        weight_g:  st.weight_kg ? Math.round(+st.weight_kg * 1000) : 0,
        length_mm: st.length_cm ? Math.round(+st.length_cm * 10)   : 0,
        width_mm:  st.width_cm  ? Math.round(+st.width_cm  * 10)   : 0,
        height_mm: st.height_cm ? Math.round(+st.height_cm * 10)   : 0,
      };

      if (mp === 'ozon') {
        const e = p.ozon.find(x => x.store.id === storeId)!;
        const creds = { client_id: e.store.client_id, api_key: e.store.api_key };
        const oz = toOzon(dims);
        const item: Record<string, unknown> = {
          offer_id: p.vendorCode,
          weight: oz.weight, weight_unit: oz.weight_unit,
          depth: oz.depth, width: oz.width, height: oz.height,
          dimension_unit: oz.dimension_unit,
        };
        if (st.name) item.name = st.name;
        if (st.extraLoaded && st.vat) item.vat = st.vat;
        await ozonApi.updateProduct(creds, item);
        const pr = e.product;
        if (st.barcode && st.barcode !== (pr.barcode ?? '') && pr.sku) {
          await ozonApi.updateBarcode(creds, pr.sku, st.barcode);
        }
        if (!st.priceLocked && st.price) {
          await ozonApi.updatePrices(creds, [{ offer_id: p.vendorCode, price: st.price, old_price: st.price, min_price: st.price }]);
          e.price = +st.price;
        }
        // Update in-memory product dims so reopening modal shows correct values
        pr.weight_kg = st.weight_kg ? +st.weight_kg : null;
        pr.length_cm = st.length_cm ? +st.length_cm : null;
        pr.width_cm  = st.width_cm  ? +st.width_cm  : null;
        pr.height_cm = st.height_cm ? +st.height_cm : null;
        if (st.name) pr.name = st.name;
        if (st.barcode) pr.barcode = st.barcode;

      } else if (mp === 'wb') {
        const e = p.wb.find(x => x.store.id === storeId)!;
        if (!e.nmID) { st.saveError = 'Нет nmID — невозможно сохранить карточку в WB'; return; }
        const wb = toWb(dims);
        await wbApi.updateCard(e.store.api_key, e.nmID, {
          dimensions: { length: Math.round(wb.length ?? 0), width: Math.round(wb.width ?? 0), height: Math.round(wb.height ?? 0) },
          title: st.name || undefined,
          brand: st.brand || undefined,
          description: st.extraLoaded ? st.description : undefined,
        });
        if (!st.priceLocked && st.price) {
          const discount = st.discount ? Math.round(+st.discount) : undefined;
          await updateWbPrices(e.store.api_key, [{ nmID: e.nmID, price: Math.round(+st.price), discount }]);
          e.price = +st.price;
        }
        const pr = e.product;
        pr.weight_kg = st.weight_kg ? +st.weight_kg : null;
        pr.length_cm = st.length_cm ? +st.length_cm : null;
        pr.width_cm  = st.width_cm  ? +st.width_cm  : null;
        pr.height_cm = st.height_cm ? +st.height_cm : null;
        if (st.discount) pr.discount = +st.discount;
        if (st.name) pr.title = st.name;
        if (st.brand) pr.brand = st.brand;

      } else {
        const e = p.ym.find(x => x.store.id === storeId)!;
        const ym = toYm(dims);
        const offer: Record<string, unknown> = {
          offerId: p.vendorCode,
          weightDimensions: { length: ym.length, width: ym.width, height: ym.height, weight: ym.weight },
        };
        if (st.name) offer.name = st.name;
        if (st.brand) offer.vendor = st.brand;
        if (st.extraLoaded) offer.description = st.description;
        await yandexApi.updateOffer(e.store.api_key, e.store.business_id!, offer);
        if (!st.priceLocked && st.price && e.store.campaign_id) {
          await yandexApi.updateOfferPrices(
            e.store.api_key, String(e.store.campaign_id),
            [{ offerId: p.vendorCode, price: +st.price }],
          );
          e.price = +st.price;
        }
        const pr = e.product;
        pr.weight_kg = st.weight_kg ? +st.weight_kg : null;
        pr.length_cm = st.length_cm ? +st.length_cm : null;
        pr.width_cm  = st.width_cm  ? +st.width_cm  : null;
        pr.height_cm = st.height_cm ? +st.height_cm : null;
        if (st.name) pr.name = st.name;
        if (st.brand) pr.vendor = st.brand;
      }
      saveOk = true;
    } catch (e: any) {
      st.saveError = e?.message ?? 'Ошибка сохранения';
    } finally {
      st.saving = false;
      if (saveOk) {
        // Recalculate merged dims from updated per-store data
        p.dims = this.resolveDims(p.vendorCode, p.ozon, p.wb, p.ym);
        this.applyFilters();
        if (st.extraLoaded) {
          const cacheKey = `${storeId}:${p.vendorCode}`;
          const extra = mp === 'ozon' ? { vat: st.vat } : { description: st.description };
          this.extraDataCache.set(cacheKey, { ...this.extraDataCache.get(cacheKey), ...extra });
        }
      }
      this.refreshCardTab();
    }
  }

  // ─────────────────────────── Save photos ──────────────────────────────────

  private async doSavePhotos(productKey: string, storeId: string, mp: 'ozon'|'wb'|'yandex'): Promise<void> {
    const st = this.editState.get(storeId);
    const p  = this.getProduct(productKey);
    if (!st || !p) return;
    st.saving = true; st.saveError = '';
    this.refreshPhotosTab();

    try {
      // Повторно пытаемся загрузить локальные (data:) фото в Storage перед сохранением —
      // они появляются, если при добавлении файла Storage был недоступен. Не теряем их,
      // если попытка снова не удастся — оставляем в st.photos для следующей попытки.
      const { uploadPhoto, isDataUrl } = await import('@/services/photoUpload');
      for (let i = 0; i < st.photos.length; i++) {
        if (!isDataUrl(st.photos[i])) continue;
        try {
          const blob = await (await fetch(st.photos[i])).blob();
          const file = new File([blob], `photo.${blob.type.split('/')[1] || 'jpg'}`, { type: blob.type });
          st.photos[i] = await uploadPhoto(file, p.vendorCode);
        } catch { /* остаётся data:URL — повторим при следующем сохранении */ }
      }

      const urls = st.photos.filter(u => u.startsWith('http'));
      const pendingLocal = st.photos.filter(isDataUrl);

      if (mp === 'ozon') {
        const e = p.ozon.find(x => x.store.id === storeId)!;
        await ozonApi.updateProduct({ client_id: e.store.client_id, api_key: e.store.api_key }, { offer_id: p.vendorCode, images: urls });
        e.product.images = urls;

      } else if (mp === 'wb') {
        const e = p.wb.find(x => x.store.id === storeId)!;
        if (!e.nmID) { st.saveError = 'Нет nmID — невозможно сохранить фото в WB'; return; }
        await wbApi.updateCard(e.store.api_key, e.nmID, { photos: urls });
        e.product.pictures = urls;

      } else {
        const e = p.ym.find(x => x.store.id === storeId)!;
        await yandexApi.updateOffer(e.store.api_key, e.store.business_id!, { offerId: p.vendorCode, pictures: urls });
        e.product.pictures = urls;
      }

      st.photos = [...urls, ...pendingLocal];
      catalogCache.setPhotos(storeId, p.vendorCode, urls);
      const set = p.photoSets.find(s => s.storeId === storeId);
      if (set) set.photos = urls;
      p.cover = p.photoSets[0]?.photos[0] ?? '';

      if (pendingLocal.length > 0) {
        st.saveError = `${pendingLocal.length} фото не удалось загрузить в хранилище — попробуйте сохранить ещё раз`;
      }
    } catch (e: any) {
      st.saveError = e?.message ?? 'Ошибка сохранения фото';
    } finally {
      st.saving = false;
      this.refreshPhotosTab();
    }
  }

  // ─────────────────────────── Photo helpers ────────────────────────────────

  private movePhoto(storeId: string, idx: number, dir: -1 | 1): void {
    const st = this.editState.get(storeId);
    if (!st) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= st.photos.length) return;
    [st.photos[idx], st.photos[ni]] = [st.photos[ni], st.photos[idx]];
    this.refreshPhotosTab();
  }

  private deletePhoto(storeId: string, idx: number): void {
    const st = this.editState.get(storeId);
    if (!st) return;
    st.photos.splice(idx, 1);
    this.refreshPhotosTab();
  }

  private refreshPhotosTab(): void {
    if (this.modalTab !== 'photos' || !this.openKey) return;
    const p = this.getProduct(this.openKey);
    const el = this.container.querySelector<HTMLElement>('#cmp-tab-content');
    if (p && el) el.innerHTML = this.tplTabPhotos(p);
  }

  private refreshCardTab(): void {
    if (this.modalTab !== 'card' || !this.openKey) return;
    const p = this.getProduct(this.openKey);
    const el = this.container.querySelector<HTMLElement>('#cmp-tab-content');
    if (p && el) el.innerHTML = this.tplTabCard(p);
  }

  /** Подгружает описание (WB/Yandex) и НДС (Ozon) при первом открытии вкладки «Карточка». */
  private async loadExtraData(p: UnifiedProduct): Promise<void> {
    const pending: Promise<void>[] = [];

    for (const e of p.ozon) {
      const st = this.editState.get(e.store.id);
      if (!st || st.extraLoaded || st.extraLoading) continue;
      st.extraLoading = true;
      const creds = { client_id: e.store.client_id, api_key: e.store.api_key };
      const cacheKey = `${e.store.id}:${p.vendorCode}`;
      pending.push((async () => {
        try {
          const info = await ozonApi.getFullProductInfo(p.vendorCode, e.product.product_id ?? null, creds);
          st.vat = info?.vat ?? '0';
          this.extraDataCache.set(cacheKey, { ...this.extraDataCache.get(cacheKey), vat: st.vat });
        } catch { /* leave default */ }
        finally { st.extraLoaded = true; st.extraLoading = false; }
      })());
    }

    for (const e of p.wb) {
      const st = this.editState.get(e.store.id);
      if (!st || st.extraLoaded || st.extraLoading || !e.nmID) continue;
      st.extraLoading = true;
      const cacheKey = `${e.store.id}:${p.vendorCode}`;
      pending.push((async () => {
        try {
          const details = await wbApi.getCardDetails(e.store.api_key, e.nmID!);
          st.description = details?.description ?? '';
          this.extraDataCache.set(cacheKey, { ...this.extraDataCache.get(cacheKey), description: st.description });
        } catch { /* leave default */ }
        finally { st.extraLoaded = true; st.extraLoading = false; }
      })());
    }

    for (const e of p.ym) {
      const st = this.editState.get(e.store.id);
      if (!st || st.extraLoaded || st.extraLoading || !e.store.business_id) continue;
      st.extraLoading = true;
      const cacheKey = `${e.store.id}:${p.vendorCode}`;
      pending.push((async () => {
        try {
          const offer = await yandexApi.getOfferMapping(e.store.api_key, e.store.business_id!, p.vendorCode);
          st.description = offer?.description ?? '';
          this.extraDataCache.set(cacheKey, { ...this.extraDataCache.get(cacheKey), description: st.description });
        } catch { /* leave default */ }
        finally { st.extraLoaded = true; st.extraLoading = false; }
      })());
    }

    if (!pending.length) return;
    this.refreshCardTab();
    await Promise.all(pending);
    this.refreshCardTab();
  }

}
