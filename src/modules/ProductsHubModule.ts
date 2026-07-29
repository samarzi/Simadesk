import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { showToast } from '@/utils/toast';
import * as XLSX from 'xlsx';
import { copyButton } from '@/utils/copyButton';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { ozonApi } from '@/services/ozonApi';
import { wbApi, updateWbPrices } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { costPriceDb } from '@/services/costPriceDb';
import { customColumnsDb } from '@/services/customColumnsDb';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import { dimensionsDb } from '@/services/dimensionsDb';
import { mpTransactionsDb, type MpTransaction } from '@/services/mpTransactionsDb';
import { producerDb, producerProductDb, producerMappingDb, producerFieldDb, type Producer, type ProducerProduct, type ProducerMapping, type ProducerFieldDef } from '@/services/producerDb';
import { catalogCache, syncOzonStore, syncWbStore, syncYmStore, fmtSyncDate } from '@/services/catalogCache';
import { toOzon, toWb, toYm } from '@/services/dimensionsUnit';
import type { Dimensions } from '@/services/dimensionsUnit';
import { boxes } from '@/stores/appStore';
import { RULE_LABELS } from '@/modules/repricer/types';
import type { RepricerRule } from '@/modules/repricer/types';
import { debug } from '@/utils/debug';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

type Mp = 'ozon' | 'wb' | 'yandex';

interface MpStoreEntry {
  mp: Mp;
  store_id: string;
  store_name: string;
  price: number | null;
  old_price: number | null;
  stock_fbs: number;
  stock_fbo: number;
  stock_total: number;
  stock_available: number;
  status: string | null;
  images: string[];
  url: string | null;
  // 30-day aggregates for this article on this store
  sales_qty: number;
  sales_revenue: number;
  returns_qty: number;
  commission: number;        // negative
  delivery: number;          // negative
  services: number;          // negative or positive
  net_profit: number;
  // Extra product fields (from DB, populated at load)
  description: string;
  vat: string;
  barcode: string;
  characteristics: Array<{ name: string; value: string }>;
}

interface BoxLink {
  box_id: string;
  box_name: string;
  image_url: string | null;
  specs: Record<string, string>;
}

interface SupplierLink {
  producer: Producer | null;
  product: ProducerProduct | null;
  quantity: number;
}

interface HubProduct {
  article: string;
  name: string;
  image_url: string | null;
  brand: string | null;
  category: string | null;
  barcode: string | null;
  cost_price: number | null;
  // Canonical dimensions (prefer override → first MP that has dims)
  weight_kg: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  mp_entries: MpStoreEntry[];
  box_links: BoxLink[];
  repricer_rules: RepricerRule[];
  supplier: SupplierLink | null;
  custom_fields: Array<{ id: string; label: string; value: any }>;
  // computed flags
  has_cost: boolean;
  has_mp: boolean;
  has_repricer: boolean;
  has_box: boolean;
}

interface Filters {
  q: string;
  mp: '' | Mp;
  no_cost: boolean;
  no_mp: boolean;
  no_repricer: boolean;
  status: string;         // '' | 'В продаже' | 'Нет в наличии' | 'В архиве'
  stock: 'any' | 'zero' | 'pos';
  price_min: number | null;
  price_max: number | null;
}

type Tab = 'overview' | 'finance' | 'card-edit' | 'photos';

interface EditState {
  mp: 'ozon' | 'wb' | 'yandex';
  name: string; brand: string; barcode: string; description: string; vat: string;
  price: string; old_price: string; min_price: string; discount: string;
  weight_kg: string; length_cm: string; width_cm: string; height_cm: string;
  photos: string[];
  priceLocked: boolean;
  saving: boolean; saveError: string; saveOk: boolean;
  extraLoaded: boolean; extraLoading: boolean;
}
type PeriodDays = 7 | 30 | 90 | 180;

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const ROW_H     = 82;
const OVERSCAN  = 6;
const HELP_KEY  = 'products_hub_help_v2';
const PERIOD_KEY = 'products_hub_period';
const DEFAULT_PERIOD: PeriodDays = 30;
const PERIOD_OPTIONS: Array<{ value: PeriodDays; label: string }> = [
  { value: 7,   label: '7 дней' },
  { value: 30,  label: '30 дней' },
  { value: 90,  label: '90 дней' },
  { value: 180, label: '180 дней' },
];

const MP_LABEL: Record<Mp, string> = { ozon: 'OZ', wb: 'WB', yandex: 'ЯМ' };
const MP_FULL:  Record<Mp, string> = { ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс Маркет' };

const OZON_STATUS: Record<string, string> = {
  processed: 'В продаже', archived: 'Архив', disabled: 'Скрыт',
  failed_moderation: 'Не прошёл модерацию', moderating: 'На модерации',
  not_moderated: 'Ожидает модерации', banned: 'Заблокирован',
  blocked: 'Заблокирован', price_error: 'Ошибка цены',
  sold_out: 'Распродан', expired: 'Истёк срок',
};

const SPEC_SKIP = new Set([
  'Артикул*', 'Артикул', 'Артикул продавца', 'Ваш SKU *',
  'Название товара', 'Название товара *', 'Название',
  'Ссылка на главное фото*', 'Ссылка на фото', 'Ссылки на дополнительные фото',
  'Цена, руб.*', 'Цена, руб.', 'Цена',
]);

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function getArticle(d: Record<string, any>): string {
  for (const f of ['Артикул*', 'Артикул', 'Артикул продавца', 'Ваш SKU *']) {
    const v = String(d[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}
function getName(d: Record<string, any>): string {
  for (const f of ['Название товара', 'Название товара *', 'Название']) {
    const v = String(d[f] ?? '').trim();
    if (v) return v;
  }
  return '';
}
function getImage(d: Record<string, any>): string | null {
  const u = String(d['Ссылка на главное фото*'] ?? d['Ссылка на фото'] ?? '').trim();
  return u.startsWith('http') ? u : null;
}
function getSpecs(d: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (SPEC_SKIP.has(k)) continue;
    if (/^Дополнительное фото/i.test(k)) continue;
    const val = String(v ?? '').trim();
    if (val && val !== '0') out[k] = val;
  }
  return out;
}
function pr(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? Math.round(n).toLocaleString('ru') + ' ₽' : '—';
}
function prSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const r = Math.round(n);
  if (r === 0) return '0 ₽';
  return (r > 0 ? '+' : '') + r.toLocaleString('ru') + ' ₽';
}
function num(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? n.toLocaleString('ru') : '—';
}

// ═══════════════════════════════════════════════════════════════════
// Module
// ═══════════════════════════════════════════════════════════════════

export class ProductsHubModule {
  private items: HubProduct[]    = [];
  private filtered: HubProduct[] = [];
  private selectedArticle: string | null = null;
  private activeTab: Tab = 'overview';
  private filters: Filters = { q: '', mp: '', no_cost: false, no_mp: false, no_repricer: false, status: '', stock: 'any', price_min: null, price_max: null };
  private sortBy: 'article' | 'profit' | 'sales' | 'stock' | 'margin' = 'article';
  private filtersOpen = false;
  private loading = false;
  private listScrollTop = 0;
  private listContainerH = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private priceDebounce: ReturnType<typeof setTimeout> | null = null;
  private listEl: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private period: PeriodDays = DEFAULT_PERIOD;
  // ── Multi-select & hidden
  private selectedArticles = new Set<string>();
  private hiddenArticles: Set<string> = new Set();
  private showHidden = false;
  private showOnlySelected = false;
  // Сырые транзакции для возможности пересчёта без обращения к серверу при смене периода
  private rawTransactions: MpTransaction[] = [];
  private storeIdToMp: Map<string, Mp> = new Map();
  private skuMaps = {
    ozon:   new Map<string, string>(),  // sku → article
    wb:     new Map<string, string>(),  // nm_id → article
    ymSku:  new Map<string, string>(),  // market_sku → article
    ymOffer: new Map<string, string>(), // offer_id (lowercase) → article
  };
  private hadTransactions = false;

  // ── Raw stores & products (needed for edit/save)
  private ozStores: any[] = [];
  private wbStores: any[] = [];
  private ymStores: any[] = [];
  private ozProds: any[] = [];
  private wbProds: any[] = [];
  private ymProds: any[] = [];

  // ── Edit state
  private editState = new Map<string, EditState>();
  private extraDataCache = new Map<string, { vat?: string; description?: string }>();
  private photoAddStoreId: string | null = null;
  private photoAddMode: 'url' | 'file' = 'url';
  private photoAddUrlValue = '';
  private syncing = new Map<string, boolean>();
  private syncErr = new Map<string, string>();
  private dragSrcIdx: number | null = null;
  private dragSrcStoreId: string | null = null;
  // lockedByMp: article (lowercase) → Set of MPs where repricer is active
  private lockedByMp = new Map<string, Set<Mp>>();
  private storeSyncedAt = new Map<string, string>(); // storeId → synced_at from Supabase
  // field def UUID → human-readable name
  private fieldDefNames = new Map<string, string>();

  // ── Lightbox
  private lightboxPhotos: string[] = [];
  private lightboxIdx = 0;
  private readonly onKeyDown = (e: KeyboardEvent) => {
    const lb = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
    if (!lb || lb.style.display === 'none') return;
    if (e.key === 'Escape') this.closeLightbox();
    else if (e.key === 'ArrowLeft' && this.lightboxPhotos.length > 1) {
      this.lightboxIdx = (this.lightboxIdx - 1 + this.lightboxPhotos.length) % this.lightboxPhotos.length;
      this.showLightboxImage(lb);
    } else if (e.key === 'ArrowRight' && this.lightboxPhotos.length > 1) {
      this.lightboxIdx = (this.lightboxIdx + 1) % this.lightboxPhotos.length;
      this.showLightboxImage(lb);
    }
  };
  constructor(private el: HTMLElement) {
    const saved = +(localStorage.getItem(PERIOD_KEY) ?? '0') as PeriodDays;
    if (PERIOD_OPTIONS.some(o => o.value === saved)) this.period = saved;
    try {
      const h = localStorage.getItem('ph_hidden_articles');
      if (h) this.hiddenArticles = new Set(JSON.parse(h) as string[]);
    } catch { /* ignore */ }
  }

  show(): void {
    this.el.style.display = 'flex';
    // Restore selection bar if items are selected
    this.updateSelectionBar();
    if (!this.listEl) {
      this.renderShell();
      this.load();
      if (!localStorage.getItem(HELP_KEY)) this.showHelp();
    } else {
      this.applyFilters();
      this.renderList();
    }
  }

  hide(): void {
    this.el.style.display = 'none';
    // Hide the fixed selection bar when navigating away
    const bar = this.el.querySelector<HTMLElement>('#ph-selection-bar');
    if (bar) bar.style.display = 'none';
  }

  // ─── Shell ──────────────────────────────────────────────────────

  private renderShell(): void {
    this.el.className = 'ph-root';
    this.el.style.position = 'relative';
    this.el.innerHTML = `
      <div class="ph-topbar">
        <div class="ph-search">
          <span class="ph-search-icon">${I.search('', 14)}</span>
          <input id="ph-search" placeholder="Артикул или название…" autocomplete="off">
        </div>

        <button id="ph-filters-btn" class="ph-filters-btn">
          ${I.filter('', 13)} Фильтры
          <span id="ph-filters-badge" class="ph-filters-badge" style="display:none">0</span>
        </button>

        <select id="ph-period" class="ph-select" title="Период анализа продаж и финансов">
          ${PERIOD_OPTIONS.map(o => `<option value="${o.value}"${this.period === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>

        <span id="ph-count" class="ph-count"></span>
        <button id="ph-import-btn" class="ph-hidden-tab-btn" title="Импортировать Excel-шаблон">${I.upload('', 14)} <span>Импорт</span></button>
        <input  id="ph-import-input" type="file" accept=".xlsx" style="display:none">
        <button id="ph-hidden-tab" class="ph-hidden-tab-btn" title="Скрытые товары">${I.eyeOff('', 14)} <span id="ph-hidden-tab-label">Скрытые</span></button>
        <button id="ph-help-btn" class="ph-iconbtn" title="Как пользоваться">${I.help('', 15)}</button>
        <button id="ph-reload"   class="ph-iconbtn" title="Обновить">${I.refresh('', 15)}</button>
      </div>

      <div id="ph-filter-panel" class="ph-filter-panel" style="display:none"></div>

      <div class="ph-body">
        <div class="ph-list-wrap">
          <div id="ph-list" class="ph-list">
            <div id="ph-spacer" style="width:1px;pointer-events:none"></div>
            <div id="ph-items" style="position:absolute;top:0;left:0;right:0"></div>
          </div>
        </div>
        <div id="ph-card" class="ph-card"></div>
      </div>

      <div id="ph-selection-bar" class="ph-selection-bar" style="display:none">
        <span id="ph-sel-count" class="ph-sel-count">0 выбрано</span>
        <div class="ph-sel-actions">
          <button id="ph-sel-only"   class="ph-sel-btn"        title="Показать только выбранные">Только выбранные</button>
          <button id="ph-sel-all"    class="ph-sel-btn"        title="Отметить все в списке">${I.check('', 14)} Отметить все</button>
          <div class="ph-sel-divider"></div>
          <button id="ph-sel-export" class="ph-sel-btn accent" title="Экспорт выбранных в Excel">${I.download('', 14)} Экспорт</button>
          <button id="ph-sel-edit"   class="ph-sel-btn"        title="Редактировать выбранные">${I.edit('', 14)} Редактировать</button>
          <div class="ph-sel-divider"></div>
          <button id="ph-sel-hide"   class="ph-sel-btn warn"   title="Скрыть выбранные">${I.eyeOff('', 14)} Скрыть</button>
          <button id="ph-sel-clear"  class="ph-sel-btn muted"  title="Снять выбор">✕</button>
        </div>
      </div>

      <div id="ph-help" class="ph-help-bg" style="display:none">
        <div class="ph-help-modal">
          <button id="ph-help-close" class="ph-help-close" title="Закрыть">✕</button>
          <div class="ph-help-title">Раздел «Товары» — как читать карточку</div>
          <div class="ph-help-body">
            <div><b>Список слева</b> — все товары из ваших магазинов на маркетплейсах + группы. Цветные точки справа — индикаторы проблем: красная — нет себестоимости, оранжевая — нет на МП, жёлтая — нет правил репрайсера, серая — нет в группах.</div>
            <div><b>Hero-метрики</b> — себестоимость, средняя цена, маржа за единицу и общий остаток. Маржа считается без учёта комиссий — реальную чистую прибыль смотрите во вкладке «Финансы».</div>
            <div><b>Магазины</b> — каждая строка отдельный магазин на маркетплейсе (даже если их несколько на одной площадке), с ценой, остатком и продажами за выбранный период.</div>
            <div><b>Финансы</b> — продажи, возвраты, комиссии, логистика и чистая прибыль агрегированы по всем магазинам (на основе реальных транзакций маркетплейсов). Период выбирается селектором в шапке.</div>
            <div><b>Группы и характеристики</b> — связки с группами товаров и поставщиком, плюс характеристики, габариты и кастомные поля.</div>
            <button class="ph-action primary" id="ph-help-ok" style="margin-top:8px;align-self:flex-start">Понятно</button>
          </div>
        </div>
      </div>
    `;

    this.listEl = this.el.querySelector('#ph-list')!;
    this.cardEl = this.el.querySelector('#ph-card')!;
    this.bindEvents();
  }

  private bindEvents(): void {
    const get = <T extends HTMLElement = HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`)!;

    get<HTMLInputElement>('ph-search').addEventListener('input', e => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.filters.q = (e.target as HTMLInputElement).value.toLowerCase().trim();
        this.applyFilters();
        this.renderList(true);
      }, 220);
    });

    get<HTMLSelectElement>('ph-period').addEventListener('change', e => {
      const v = +(e.target as HTMLSelectElement).value as PeriodDays;
      if (!PERIOD_OPTIONS.some(o => o.value === v)) return;
      this.period = v;
      try { localStorage.setItem(PERIOD_KEY, String(v)); } catch {}
      this.reaggregateSales();
    });

    // ── Filters button toggle
    get('ph-filters-btn').addEventListener('click', () => {
      this.filtersOpen = !this.filtersOpen;
      const panel = this.el.querySelector<HTMLElement>('#ph-filter-panel')!;
      const btn   = get('ph-filters-btn');
      if (this.filtersOpen) {
        panel.style.display = '';
        panel.innerHTML = this.tplFilterPanel();
        this.bindFilterPanel();
        btn.classList.add('on');
      } else {
        panel.style.display = 'none';
        btn.classList.remove('on');
      }
    });

    get('ph-reload').addEventListener('click', () => {
      const btn = get('ph-reload');
      btn.classList.add('spinning');
      this.load().finally(() => btn.classList.remove('spinning'));
    });
    document.addEventListener('keydown', this.onKeyDown);
    get('ph-help-btn').addEventListener('click', () => this.showHelp());
    get('ph-help-close').addEventListener('click', () => this.hideHelp());
    get('ph-help-ok').addEventListener('click', () => this.hideHelp());
    get('ph-help').addEventListener('click', e => { if (e.target === get('ph-help')) this.hideHelp(); });

    this.listEl!.addEventListener('scroll', () => {
      this.listScrollTop = this.listEl!.scrollTop;
      this.renderListItems();
    });

    // ── Extended events for edit/photos/sync (delegated on card container)
    this.cardEl!.addEventListener('input', e => {
      const t = e.target as HTMLInputElement;
      if (t.matches('[data-ph-field]')) {
        const st = this.editState.get(t.getAttribute('data-store-id')!);
        if (st) (st as unknown as Record<string, unknown>)[t.getAttribute('data-ph-field')!] = t.value;
      } else if (t.id === 'ph-photo-url-input') {
        this.photoAddUrlValue = t.value;
      }
    });

    this.cardEl!.addEventListener('change', async e => {
      const t = e.target as HTMLInputElement;
      if (t.id !== 'ph-photo-file-input' || !t.files?.length) return;
      const sid = t.getAttribute('data-store-id')!;
      const st = this.editState.get(sid);
      if (!st || !this.selectedArticle) return;
      const { uploadPhoto } = await import('@/services/photoUpload');
      for (const f of Array.from(t.files)) {
        try {
          const url = await uploadPhoto(f, this.selectedArticle);
          st.photos.push(url);
        } catch (err: unknown) {
          st.saveError = (err instanceof Error ? (err instanceof Error ? err.message : String(err)) : String(err)) ?? 'Ошибка загрузки фото';
        }
      }
      t.value = '';
      this.photoAddStoreId = null;
      this.refreshPhotosTab2();
    });

    this.cardEl!.addEventListener('click', async e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ph-action]');
      if (!el || !this.selectedArticle) return;
      const action = el.getAttribute('data-ph-action')!;
      const storeId = el.getAttribute('data-store-id') ?? '';
      const mp = el.getAttribute('data-mp') as 'ozon' | 'wb' | 'yandex' | null;

      switch (action) {
        case 'save-card':
          if (mp) await this.doSaveCard(this.selectedArticle, storeId, mp);
          break;
        case 'sync-store':
          await this.doSync(storeId, mp ?? '');
          break;
        case 'save-photos':
          if (mp) await this.doSavePhotos(this.selectedArticle, storeId, mp);
          break;
        case 'photo-add-toggle':
          this.photoAddStoreId = this.photoAddStoreId === storeId ? null : storeId;
          this.photoAddUrlValue = '';
          this.refreshPhotosTab2();
          break;
        case 'photo-mode-url':  this.photoAddMode = 'url';  this.refreshPhotosTab2(); break;
        case 'photo-mode-file': this.photoAddMode = 'file'; this.refreshPhotosTab2(); break;
        case 'photo-add-url': {
          const url = this.photoAddUrlValue.trim();
          if (url) {
            const st = this.editState.get(storeId);
            if (st) { st.photos.push(url); this.photoAddUrlValue = ''; this.photoAddStoreId = null; }
          }
          this.refreshPhotosTab2();
          break;
        }
        case 'photo-pick-file':
          this.cardEl!.querySelector<HTMLInputElement>('#ph-photo-file-input')?.click();
          break;
        case 'photo-delete': {
          const idx = +(el.getAttribute('data-idx') ?? -1);
          const st = this.editState.get(storeId);
          if (st && idx >= 0) { st.photos.splice(idx, 1); this.refreshPhotosTab2(); }
          break;
        }
        case 'open-lightbox': {
          const url = el.getAttribute('data-url') ?? '';
          if (!url) break;
          const p2 = this.selectedArticle ? this.items.find(x => x.article === this.selectedArticle) : undefined;
          const photos2 = p2 ? this.allPhotos(p2) : [];
          this.openLightbox(url, photos2.length ? photos2 : [url]);
          break;
        }
        case 'close-lightbox':
          this.closeLightbox();
          break;
        case 'lightbox-prev': {
          const lb2 = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
          if (lb2 && this.lightboxPhotos.length > 1) {
            this.lightboxIdx = (this.lightboxIdx - 1 + this.lightboxPhotos.length) % this.lightboxPhotos.length;
            this.showLightboxImage(lb2);
          }
          break;
        }
        case 'lightbox-next': {
          const lb3 = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
          if (lb3 && this.lightboxPhotos.length > 1) {
            this.lightboxIdx = (this.lightboxIdx + 1) % this.lightboxPhotos.length;
            this.showLightboxImage(lb3);
          }
          break;
        }
      }
    });

    // ── Drag & drop photo reorder
    this.cardEl!.addEventListener('dragstart', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (!cell) return;
      this.dragSrcIdx     = +(cell.dataset.dragIdx ?? -1);
      this.dragSrcStoreId = cell.dataset.dragStoreId ?? null;
      (e as DragEvent).dataTransfer!.effectAllowed = 'move';
    });
    this.cardEl!.addEventListener('dragover', e => {
      if (this.dragSrcIdx === null) return;
      e.preventDefault(); // must be unconditional so drop fires even in grid gaps
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (cell) (e as DragEvent).dataTransfer!.dropEffect = 'move';
    });
    this.cardEl!.addEventListener('dragend', () => {
      this.dragSrcIdx = null; this.dragSrcStoreId = null;
    });
    this.cardEl!.addEventListener('drop', e => {
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell[draggable]');
      if (!cell || this.dragSrcIdx === null || !this.dragSrcStoreId) return;
      const dstIdx     = +(cell.dataset.dragIdx ?? -1);
      const dstStoreId = cell.dataset.dragStoreId ?? null;
      if (dstStoreId === this.dragSrcStoreId && dstIdx !== this.dragSrcIdx) {
        const st = this.editState.get(this.dragSrcStoreId);
        if (st) {
          const [moved] = st.photos.splice(this.dragSrcIdx, 1);
          st.photos.splice(dstIdx, 0, moved);
          this.refreshPhotosTab2();
        }
      }
      this.dragSrcIdx = null; this.dragSrcStoreId = null;
    });

    // ── Selection bar
    get('ph-sel-export').addEventListener('click', () => this.exportSelected());
    get('ph-sel-edit').addEventListener('click', () => this.showBulkEditModal());
    get('ph-sel-hide').addEventListener('click', () => this.hideSelected());
    get('ph-sel-all').addEventListener('click', () => this.selectAll());
    get('ph-sel-only').addEventListener('click', () => this.toggleShowOnlySelected());
    get('ph-sel-clear').addEventListener('click', () => this.clearSelection());
    get('ph-import-input').addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files;
      if (f?.length) this.importFromExcel(f);
      (e.target as HTMLInputElement).value = '';
    });
    // ── Topbar import button
    get('ph-import-btn').addEventListener('click', () => get('ph-import-input').click());

    // ── Hidden tab toggle
    get('ph-hidden-tab').addEventListener('click', () => {
      this.showHidden = !this.showHidden;
      const btn = get('ph-hidden-tab');
      btn.classList.toggle('active', this.showHidden);
      const label = get('ph-hidden-tab-label');
      label.textContent = this.showHidden
        ? `← Все товары`
        : `Скрытые${this.hiddenArticles.size > 0 ? ` (${this.hiddenArticles.size})` : ''}`;
      this.selectedArticles.clear();
      this.applyFilters();
      this.renderList(true);
    });
  }

  // ─── Data loading ───────────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    this.setCardEmpty(`<div class="ph-loader">${I.loader('', 18)} Загружаем все данные…</div>`);
    const items = this.el.querySelector<HTMLElement>('#ph-items');
    const spacer = this.el.querySelector<HTMLElement>('#ph-spacer');
    if (spacer) spacer.style.height = '40px';
    if (items) items.innerHTML = `<div class="ph-loader">${I.loader('', 16)}</div>`;

    try {
      // 1. Refresh small caches in parallel
      await Promise.all([
        repricerRulesDb.refresh().catch(() => {}),
        costPriceDb.refresh().catch(() => {}),
      ]);
      const allRules = repricerRulesDb.all();
      this.lockedByMp.clear();
      for (const r of allRules) {
        const code = ((r.vendorCode ?? r.offer_id ?? '') as string).toLowerCase().trim();
        if (!code) continue;
        if (!this.lockedByMp.has(code)) this.lockedByMp.set(code, new Set());
        const rmp = (r.marketplace as string | undefined)?.toLowerCase() as Mp | undefined;
        const validMps: Mp[] = ['ozon', 'wb', 'yandex'];
        if (rmp && validMps.includes(rmp)) {
          this.lockedByMp.get(code)!.add(rmp);
        } else {
          for (const m of validMps) this.lockedByMp.get(code)!.add(m);
        }
      }

      // 2. Stores + products
      const [ozStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores().catch(() => [] as any[]),
        wbDb.getStores().catch(() => [] as any[]),
        yandexDb.getStores().catch(() => [] as any[]),
      ]);
      const allStoreIds = [
        ...(ozStores as any[]).map(s => s.id),
        ...(wbStores as any[]).map(s => s.id),
        ...(ymStores as any[]).map(s => s.id),
      ];
      const ozMap = new Map<string, string>((ozStores as any[]).map(s => [s.id, s.name]));
      const wbMap = new Map<string, string>((wbStores as any[]).map(s => [s.id, s.name]));
      const ymMap = new Map<string, string>((ymStores as any[]).map(s => [s.id, s.name]));

      const [ozProds, wbProds, ymProds] = await Promise.all([
        ozonDb.getProducts().catch(() => [] as any[]),
        wbDb.getProducts().catch(() => [] as any[]),
        yandexDb.getProducts().catch(() => [] as any[]),
      ]);

      // Store raw data for edit/save functionality
      this.ozStores = ozStores as any[];
      this.wbStores = wbStores as any[];
      this.ymStores = ymStores as any[];
      this.ozProds = ozProds as any[];
      this.wbProds = wbProds as any[];
      this.ymProds = ymProds as any[];

      // 3. Загружаем транзакции на максимальный поддерживаемый период (180 дней),
      // потом локально фильтруем по this.period — селектор не дёргает сервер.
      const MAX_DAYS = 180;
      const dateTo   = new Date().toISOString();
      const dateFrom = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString();
      const [transactions, producers, producerProds, producerMaps, fieldDefs] = await Promise.all([
        allStoreIds.length ? mpTransactionsDb.getByStores(allStoreIds, dateFrom, dateTo).catch(() => [] as MpTransaction[]) : Promise.resolve([]),
        producerDb.list().catch(() => [] as Producer[]),
        producerProductDb.list().catch(() => [] as ProducerProduct[]),
        producerMappingDb.list().catch(() => [] as ProducerMapping[]),
        producerFieldDb.list().catch(() => [] as ProducerFieldDef[]),
      ]);
      this.fieldDefNames = new Map(fieldDefs.map(f => [f.id, f.name]));

      // 4. Build the product map
      const map = new Map<string, HubProduct>();
      const buildEntry = (mp: Mp, store_id: string, store_name: string): MpStoreEntry => ({
        mp, store_id, store_name,
        price: null, old_price: null,
        stock_fbs: 0, stock_fbo: 0, stock_total: 0, stock_available: 0,
        status: null, images: [], url: null,
        sales_qty: 0, sales_revenue: 0, returns_qty: 0,
        commission: 0, delivery: 0, services: 0, net_profit: 0,
        description: '', vat: '', barcode: '', characteristics: [],
      });

      const ensure = (raw: string, name?: string, img?: string | null): HubProduct => {
        const key = raw.toLowerCase().trim();
        let p = map.get(key);
        if (!p) {
          p = {
            article: raw, name: name ?? '', image_url: img ?? null,
            brand: null, category: null, barcode: null,
            cost_price: null,
            weight_kg: null, length_cm: null, width_cm: null, height_cm: null,
            mp_entries: [], box_links: [], repricer_rules: [],
            supplier: null, custom_fields: [],
            has_cost: false, has_mp: false, has_repricer: false, has_box: false,
          };
          map.set(key, p);
        }
        if (name && !p.name) p.name = name;
        if (img && !p.image_url) p.image_url = img;
        return p;
      };

      // Indexes for transaction → article matching
      const ozSkuToArticle = new Map<string, string>();   // ozon: product.sku → offer_id
      const wbNmToArticle  = new Map<string, string>();   // wb:   nm_id      → vendor_code
      const ymSkuToArticle = new Map<string, string>();   // yandex: market_sku → offer_id
      const ymOfferIdToArticle = new Map<string, string>(); // sometimes API returns offer_id directly

      // ── Ozon products
      for (const op of ozProds as any[]) {
        const art = String(op.offer_id ?? '').trim();
        if (!art) continue;
        const p = ensure(art, op.name, op.images?.[0] ?? null);
        p.brand    = p.brand    ?? null;
        p.category = p.category ?? (op.category || null);
        p.barcode  = p.barcode  ?? (op.barcode || null);
        const e = buildEntry('ozon', op.store_id, ozMap.get(op.store_id) ?? 'Ozon');
        e.price = op.price ?? null;
        e.old_price = op.old_price || null;
        e.stock_fbs = op.stock_fbs ?? 0;
        e.stock_fbo = op.stock_fbo ?? 0;
        e.stock_total = e.stock_fbs + e.stock_fbo;
        e.stock_available = e.stock_total;
        e.status = OZON_STATUS[op.status] ?? op.status ?? null;
        e.images = op.images ?? [];
        e.url = op.sku ? `https://www.ozon.ru/product/${op.sku}/` : null;
        e.vat = op.vat ?? '';
        e.description = op.description ?? '';
        e.barcode = op.barcode ?? '';
        p.mp_entries.push(e);
        if (op.sku) ozSkuToArticle.set(String(op.sku), art);

        // canonical dims (prefer first non-null)
        if (p.weight_kg == null && op.weight_kg) p.weight_kg = +op.weight_kg;
        if (p.length_cm == null && op.length_cm) p.length_cm = +op.length_cm;
        if (p.width_cm  == null && op.width_cm)  p.width_cm  = +op.width_cm;
        if (p.height_cm == null && op.height_cm) p.height_cm = +op.height_cm;
      }

      // ── WB products
      for (const wp of wbProds as any[]) {
        const art = String(wp.vendor_code ?? '').trim();
        if (!art) continue;
        const p = ensure(art, wp.title, wp.pictures?.[0] ?? null);
        p.brand    = p.brand    ?? (wp.brand || null);
        p.category = p.category ?? (wp.subject || null);
        const e = buildEntry('wb', wp.store_id, wbMap.get(wp.store_id) ?? 'WB');
        // WB: базовая цена — price, реальная цена покупателя — со скидкой
        const wbBase = wp.price ?? null;
        const wbDisc = wp.discount ?? 0;
        if (wbBase != null && wbDisc > 0) {
          e.price     = Math.round(wbBase * (1 - wbDisc / 100));
          e.old_price = wbBase;
        } else {
          e.price = wbBase;
        }
        e.stock_total = wp.stock_total ?? 0;
        e.stock_available = e.stock_total;
        e.status = (wp.stock_total ?? 0) > 0 ? 'В продаже' : 'Нет в наличии';
        e.images = wp.pictures ?? [];
        e.url = wp.nm_id ? `https://www.wildberries.ru/catalog/${wp.nm_id}/detail.aspx` : null;
        e.description = wp.description ?? '';
        e.barcode = wp.barcode ?? '';
        e.characteristics = wp.characteristics ?? [];
        p.mp_entries.push(e);
        if (wp.nm_id) wbNmToArticle.set(String(wp.nm_id), art);

        if (p.weight_kg == null && wp.weight_kg) p.weight_kg = +wp.weight_kg;
        if (p.length_cm == null && wp.length_cm) p.length_cm = +wp.length_cm;
        if (p.width_cm  == null && wp.width_cm)  p.width_cm  = +wp.width_cm;
        if (p.height_cm == null && wp.height_cm) p.height_cm = +wp.height_cm;
      }

      // ── Yandex products
      for (const yp of ymProds as any[]) {
        const art = String(yp.offer_id || yp.vendor_code || '').trim();
        if (!art) continue;
        const p = ensure(art, yp.name, yp.pictures?.[0] ?? null);
        p.brand = p.brand ?? (yp.vendor || null);
        const e = buildEntry('yandex', yp.store_id, ymMap.get(yp.store_id) ?? 'ЯМ');
        e.price = yp.basic_price ?? null;
        e.stock_total     = yp.stock_total ?? 0;
        e.stock_available = yp.stock_available ?? 0;
        e.status = yp.archived
          ? 'В архиве'
          : ((yp.stock_available ?? yp.stock_total ?? 0) > 0 ? 'В продаже' : 'Нет в наличии');
        e.images = yp.pictures ?? [];
        e.url = yp.market_model_id && yp.market_sku
          ? `https://market.yandex.ru/product/${yp.market_model_id}?sku=${yp.market_sku}`
          : (yp.market_sku ? `https://market.yandex.ru/search?text=${yp.market_sku}` : null);
        e.description = yp.description ?? '';
        e.vat = yp.vat ?? '';
        e.barcode = yp.barcode ?? '';
        p.mp_entries.push(e);
        if (yp.market_sku) ymSkuToArticle.set(String(yp.market_sku), art);
        ymOfferIdToArticle.set(art.toLowerCase(), art);

        if (p.weight_kg == null && yp.weight_kg) p.weight_kg = +yp.weight_kg;
        if (p.length_cm == null && yp.length_cm) p.length_cm = +yp.length_cm;
        if (p.width_cm  == null && yp.width_cm)  p.width_cm  = +yp.width_cm;
        if (p.height_cm == null && yp.height_cm) p.height_cm = +yp.height_cm;
      }

      // ── Boxes (group products with custom photos and specs)
      const appCache = (window as any).app?.cache as Map<string, any[]> | undefined;
      for (const box of boxes.get()) {
        const prods = appCache?.get(box.id) ?? [];
        for (const bp of prods) {
          const art = getArticle(bp.data);
          if (!art) continue;
          const p = ensure(art, getName(bp.data), getImage(bp.data));
          if (!p.box_links.some(l => l.box_id === box.id)) {
            p.box_links.push({
              box_id: box.id, box_name: box.name,
              image_url: getImage(bp.data),
              specs: getSpecs(bp.data),
            });
          }
        }
      }

      // ── Cost prices & dimensions (override layer)
      for (const p of map.values()) {
        p.cost_price = costPriceDb.get(p.article);
        const dims = dimensionsDb.get(p.article);
        if (dims) {
          if (dims.weight_g)   p.weight_kg = dims.weight_g / 1000;
          if (dims.length_mm)  p.length_cm = dims.length_mm / 10;
          if (dims.width_mm)   p.width_cm  = dims.width_mm / 10;
          if (dims.height_mm)  p.height_cm = dims.height_mm / 10;
        }
        // custom columns
        const vals = customColumnsDb.getValuesFor(p.article);
        const cols = customColumnsDb.getColumns(null).filter(c => !c.system);
        p.custom_fields = cols
          .map(c => ({ id: c.id, label: c.label, value: vals[c.id] }))
          .filter(f => f.value != null && f.value !== '');
      }

      // ── Repricer rules
      const rules = repricerRulesDb.all();
      for (const r of rules) {
        const k1 = (r.vendorCode ?? '').toLowerCase().trim();
        if (k1 && map.has(k1)) map.get(k1)!.repricer_rules.push(r);
        for (const rp of r.products ?? []) {
          const k2 = (rp.vendorCode ?? '').toLowerCase().trim();
          if (k2 && map.has(k2) && !map.get(k2)!.repricer_rules.includes(r)) {
            map.get(k2)!.repricer_rules.push(r);
          }
        }
      }

      // ── Producers (supplier link)
      const prodById = new Map(producerProds.map(p => [p.id, p]));
      const supById  = new Map(producers.map(p => [p.id, p]));
      for (const m of producerMaps) {
        const k = (m.marketplace_article ?? '').toLowerCase().trim();
        if (!k || !map.has(k)) continue;
        const pprod = prodById.get(m.producer_product_id) ?? null;
        const sup   = pprod ? (supById.get(pprod.producer_id) ?? null) : null;
        map.get(k)!.supplier = { producer: sup, product: pprod, quantity: m.quantity };
      }

      // ── Save raw state for re-aggregation on period change
      this.rawTransactions = transactions as MpTransaction[];
      this.hadTransactions = (transactions as MpTransaction[]).length > 0;
      this.storeIdToMp.clear();
      this.storeSyncedAt.clear();
      for (const s of ozStores as any[]) { this.storeIdToMp.set(s.id, 'ozon');   if (s.synced_at) this.storeSyncedAt.set(s.id, s.synced_at); }
      for (const s of wbStores as any[]) { this.storeIdToMp.set(s.id, 'wb');     if (s.synced_at) this.storeSyncedAt.set(s.id, s.synced_at); }
      for (const s of ymStores as any[]) { this.storeIdToMp.set(s.id, 'yandex'); if (s.synced_at) this.storeSyncedAt.set(s.id, s.synced_at); }
      this.skuMaps.ozon    = ozSkuToArticle;
      this.skuMaps.wb      = wbNmToArticle;
      this.skuMaps.ymSku   = ymSkuToArticle;
      this.skuMaps.ymOffer = ymOfferIdToArticle;

      // ── Compute flags & finalize
      for (const p of map.values()) {
        p.has_cost     = p.cost_price !== null;
        p.has_mp       = p.mp_entries.length > 0;
        p.has_repricer = p.repricer_rules.length > 0;
        p.has_box      = p.box_links.length > 0;
      }

      this.items = [...map.values()].sort((a, b) => a.article.localeCompare(b.article, 'ru'));
      this.aggregateSales();
      this.applyFilters();
      this.renderList(true);
      if (!this.selectedArticle) this.setCardHint();
      else this.selectProduct(this.selectedArticle);
    } catch (e) {
      debug.warn('[ProductsHub] load failed', e);
      if (items) items.innerHTML = `<div class="ph-list-empty">Ошибка загрузки</div>`;
    } finally {
      this.loading = false;
    }
  }

  // ─── Sales/finance aggregation ──────────────────────────────────

  /**
   * Заполняет sales_qty / revenue / commission / net_profit во всех MpStoreEntry
   * из this.rawTransactions, ограниченных текущим периодом this.period.
   * Вызывается после загрузки и при смене периода.
   */
  private aggregateSales(): void {
    // 1. Сбросить аггрегаты на всех entries
    for (const p of this.items) for (const e of p.mp_entries) {
      e.sales_qty = 0; e.sales_revenue = 0; e.returns_qty = 0;
      e.commission = 0; e.delivery = 0; e.services = 0; e.net_profit = 0;
    }

    if (!this.rawTransactions.length) return;

    const cutoff = Date.now() - this.period * 86400_000;

    // 2. Индекс (mp, store_id, article) → entry
    const entryIndex = new Map<string, MpStoreEntry>();
    for (const p of this.items) for (const e of p.mp_entries) {
      entryIndex.set(`${e.mp}:${e.store_id}:${p.article.toLowerCase()}`, e);
    }

    // 3. Lookup статья по SKU из транзакции
    const articleFor = (mp: Mp, sku: string | number | undefined): string | null => {
      if (sku == null || sku === '') return null;
      const s = String(sku);
      if (mp === 'ozon') return this.skuMaps.ozon.get(s) ?? null;
      if (mp === 'wb')   return this.skuMaps.wb.get(s) ?? null;
      // yandex: пробуем market_sku, затем offer_id (в любом регистре)
      return this.skuMaps.ymSku.get(s)
        ?? this.skuMaps.ymOffer.get(s.toLowerCase())
        ?? null;
    };

    // 4. Fallback классификации для старых записей с tx_kind = null
    const kindOf = (tx: MpTransaction): 'sale' | 'return' | 'expense' | 'skip' => {
      const k = tx.tx_kind;
      if (k === 'sale') return 'sale';
      if (k === 'return') return 'return';
      if (k === 'cancel') return 'skip';
      if (k === 'advertising' || k === 'storage' || k === 'penalty' || k === 'service' || k === 'return_svc') return 'expense';
      // Без классификации — по знаку accruals_for_sale
      const r = tx.accruals_for_sale || 0;
      if (r > 0) return 'sale';
      if (r < 0) return 'return';
      return 'expense';
    };

    for (const tx of this.rawTransactions) {
      const txTime = new Date(tx.operation_date).getTime();
      if (!Number.isFinite(txTime) || txTime < cutoff) continue;

      const mp = (tx.marketplace ?? this.storeIdToMp.get(tx.store_id)) as Mp | undefined;
      if (!mp) continue;

      const kind = kindOf(tx);
      if (kind === 'skip') continue;

      const items = tx.items_json ?? [];

      if (items.length === 0) {
        // Сервисные траты без привязки к товару не распределяем по карточкам —
        // они учитываются только в общестоковой аналитике.
        continue;
      }

      const totalQty = items.reduce((s, it) => s + Math.abs(it.quantity ?? 1), 0) || 1;

      for (const it of items) {
        const art = articleFor(mp, it.sku);
        if (!art) continue;
        const e = entryIndex.get(`${mp}:${tx.store_id}:${art.toLowerCase()}`);
        if (!e) continue;

        const qty   = Math.abs(it.quantity ?? 1);
        const share = qty / totalQty;

        if (kind === 'sale') {
          e.sales_qty     += qty;
          e.sales_revenue += tx.accruals_for_sale * share;
          e.commission    += tx.sale_commission   * share;
          e.delivery      += tx.delivery_charge   * share;
          e.services      -= Math.abs(tx.services_total) * share;
          e.net_profit    += tx.amount * share;
        } else if (kind === 'return') {
          e.returns_qty   += qty;
          e.sales_revenue += tx.accruals_for_sale * share; // отрицательное
          e.commission    += tx.sale_commission   * share;
          e.delivery      += (tx.delivery_charge + tx.return_delivery_charge) * share;
          e.services      -= Math.abs(tx.services_total) * share;
          e.net_profit    += tx.amount * share;
        } else {
          // expense — отражаем как минус в services и в net_profit
          e.services      -= Math.abs(tx.services_total || tx.amount) * share;
          e.net_profit    += tx.amount * share;
        }
      }
    }
  }

  /** Пересчёт продаж/финансов при смене периода. Не дёргает сервер. */
  private reaggregateSales(): void {
    this.aggregateSales();
    this.applyFilters();
    this.renderList(false);
    if (this.selectedArticle) {
      const p = this.items.find(x => x.article === this.selectedArticle);
      if (p) this.renderCard(p);
    }
  }

  // ─── Filtering ──────────────────────────────────────────────────

  private applyFilters(): void {
    const { q, mp, no_cost, no_mp, no_repricer, status, stock, price_min, price_max } = this.filters;
    this.filtered = this.items.filter(p => {
      // Hidden filter
      if (!this.showHidden && this.hiddenArticles.has(p.article)) return false;
      if (this.showHidden && !this.hiddenArticles.has(p.article)) return false;
      // Show-only-selected filter
      if (this.showOnlySelected && !this.selectedArticles.has(p.article)) return false;
      if (q && !p.article.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return false;
      if (mp && !p.mp_entries.some(e => e.mp === mp)) return false;
      if (no_cost     && p.has_cost)     return false;
      if (no_mp       && p.has_mp)       return false;
      if (no_repricer && p.has_repricer) return false;
      // Status filter: at least one entry matches
      if (status) {
        const entries = mp ? p.mp_entries.filter(e => e.mp === mp) : p.mp_entries;
        const match = status === 'В архиве'
          ? entries.some(e => e.status && (e.status.includes('архив') || e.status.includes('Архив') || e.status.includes('Скрыт') || e.status === 'disabled'))
          : entries.some(e => e.status === status);
        if (!match) return false;
      }
      // Stock filter — respect active MP filter
      const stockEntries = mp ? p.mp_entries.filter(e => e.mp === mp) : p.mp_entries;
      const totalStock = stockEntries.reduce((s, e) => s + (e.stock_total || 0), 0);
      if (stock === 'zero' && totalStock > 0) return false;
      if (stock === 'pos'  && totalStock === 0) return false;
      // Price filter: use min price across stores (respect MP filter)
      if (price_min != null || price_max != null) {
        const priced = (mp ? p.mp_entries.filter(e => e.mp === mp) : p.mp_entries).filter(e => e.price != null);
        if (!priced.length) return price_min == null; // no price → exclude if min set
        const minP = Math.min(...priced.map(e => e.price!));
        const maxP = Math.max(...priced.map(e => e.price!));
        if (price_min != null && maxP < price_min) return false;
        if (price_max != null && minP > price_max) return false;
      }
      return true;
    });

    // Сортировка
    if (this.sortBy === 'profit') {
      this.filtered.sort((a, b) =>
        b.mp_entries.reduce((s, e) => s + e.net_profit, 0) - a.mp_entries.reduce((s, e) => s + e.net_profit, 0));
    } else if (this.sortBy === 'sales') {
      this.filtered.sort((a, b) =>
        b.mp_entries.reduce((s, e) => s + e.sales_qty, 0) - a.mp_entries.reduce((s, e) => s + e.sales_qty, 0));
    } else if (this.sortBy === 'stock') {
      this.filtered.sort((a, b) =>
        b.mp_entries.reduce((s, e) => s + e.stock_total, 0) - a.mp_entries.reduce((s, e) => s + e.stock_total, 0));
    } else if (this.sortBy === 'margin') {
      const margin = (p: HubProduct) => {
        const priced = p.mp_entries.filter(e => e.price != null);
        const avg = priced.length ? priced.reduce((s, e) => s + (e.price ?? 0), 0) / priced.length : null;
        return (p.cost_price != null && avg != null) ? avg - p.cost_price : -Infinity;
      };
      this.filtered.sort((a, b) => margin(b) - margin(a));
    }
    // 'article' — уже отсортировано при загрузке

    const c = this.el.querySelector('#ph-count');
    if (c) c.textContent = `${this.filtered.length} из ${this.items.length}`;

    // Если активный товар выпал из фильтра — показываем подсказку в списке
    if (this.selectedArticle && !this.filtered.some(p => p.article === this.selectedArticle)) {
      this.setCardHint();
      this.selectedArticle = null;
    }
  }

  // ─── List (virtual) ─────────────────────────────────────────────

  private renderList(reset = false): void {
    const spacer = this.el.querySelector<HTMLElement>('#ph-spacer');
    if (!spacer || !this.listEl) return;
    if (reset) { this.listEl.scrollTop = 0; this.listScrollTop = 0; }
    spacer.style.height = `${this.filtered.length * ROW_H}px`;
    this.listContainerH = this.listEl.clientHeight || 600;
    this.renderListItems();
  }

  private renderListItems(): void {
    const items = this.el.querySelector<HTMLElement>('#ph-items');
    if (!items) return;
    if (this.filtered.length === 0) {
      items.style.top = '0';
      items.innerHTML = `<div class="ph-list-empty">Ничего не найдено</div>`;
      return;
    }
    const start = Math.max(0, Math.floor(this.listScrollTop / ROW_H) - OVERSCAN);
    const end   = Math.min(this.filtered.length, Math.ceil((this.listScrollTop + this.listContainerH) / ROW_H) + OVERSCAN);
    items.style.top = `${start * ROW_H}px`;
    items.innerHTML = this.filtered.slice(start, end).map(p => this.tplListItem(p)).join('');
    this.updateSelectionBar();
  }

  private tplListItem(p: HubProduct): string {
    const active  = p.article === this.selectedArticle;
    const checked = this.selectedArticles.has(p.article);
    const safeArt = esc(p.article).replace(/'/g, '&#39;');
    const thumb = p.image_url
      ? `<img class="ph-row-thumb" src="${esc(p.image_url)}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="ph-row-thumb placeholder">${I.image('', 16)}</div>`;
    const mps = (['ozon','wb','yandex'] as Mp[]).map(mp => {
      const cnt = p.mp_entries.filter(e => e.mp === mp).length;
      if (!cnt) return `<span class="ph-mp-dot" title="Нет на ${MP_FULL[mp]}"></span>`;
      return `<span class="ph-mp-tag mp-${mp}" title="${esc(MP_FULL[mp])}${cnt > 1 ? ` — ${cnt} магазина` : ''}">${MP_LABEL[mp]}${cnt > 1 ? `×${cnt}` : ''}</span>`;
    }).join('');
    const dots: string[] = [];
    if (!p.has_cost)     dots.push('<span class="ph-warn-dot cost"     title="Нет себестоимости"></span>');
    if (!p.has_mp)       dots.push('<span class="ph-warn-dot mp"       title="Нет на маркетплейсах"></span>');
    if (!p.has_repricer) dots.push('<span class="ph-warn-dot repricer" title="Нет правил репрайсера"></span>');
    return `
      <div class="ph-row${active ? ' active' : ''}${checked ? ' checked' : ''}" style="height:${ROW_H}px"
        onclick="window.productsHubModule?.selectProduct('${safeArt}')">
        <div class="ph-checkbox-wrap" onclick="event.stopPropagation();window.productsHubModule?.toggleCheck('${safeArt}')">
          <div class="ph-checkbox${checked ? ' on' : ''}"></div>
        </div>
        ${thumb}
        <div class="ph-row-main">
          <div class="ph-row-line">
            <span class="ph-row-article" title="${esc(p.article)}">${esc(p.article)}</span>
            ${copyButton(p.article, 'Копировать артикул')}
            <span class="ph-warn-dots">${dots.join('')}</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;min-width:0">
            <div class="ph-row-name" style="min-width:0" title="${esc(p.name)}">${p.name ? esc(p.name) : '<i>без названия</i>'}</div>
            ${p.name ? copyButton(p.name, 'Копировать название') : ''}
          </div>
          <div class="ph-row-bottom">
            <div class="ph-row-mps">${mps}</div>
            <div class="ph-row-quick">${(() => {
              const priced = p.mp_entries.filter(e => e.price != null);
              const stock  = p.mp_entries.reduce((s, e) => s + (e.stock_total || 0), 0);
              const prices = priced.map(e => e.price!);
              const minP = prices.length ? Math.min(...prices) : null;
              const maxP = prices.length ? Math.max(...prices) : null;
              const priceStr = minP == null ? '' :
                minP === maxP ? `${Math.round(minP).toLocaleString('ru')} ₽` :
                `${Math.round(minP).toLocaleString('ru')}–${Math.round(maxP!).toLocaleString('ru')} ₽`;
              const stockStr = stock > 0 ? `${stock} шт.` : `<span class="ph-row-no-stock">0 шт.</span>`;
              return [priceStr, stockStr].filter(Boolean).join(' · ');
            })()}</div>
          </div>
        </div>
      </div>`;
  }

  // ─── Select & render card ───────────────────────────────────────

  selectProduct(article: string): void {
    this.selectedArticle = article;
    this.editState.clear();
    this.photoAddStoreId = null;
    if (this.activeTab === 'card-edit' || this.activeTab === 'photos') {
      this.activeTab = 'overview';
    }
    this.renderListItems();
    const p = this.items.find(x => x.article === article);
    if (p) this.renderCard(p);
  }

  setTab(tab: Tab): void {
    this.activeTab = tab;
    const p = this.items.find(x => x.article === this.selectedArticle);
    if (!p) return;
    if (tab === 'card-edit' || tab === 'photos') {
      if (!this.editState.size) this.initEditState(p);
    }
    this.renderCard(p);
    if (tab === 'card-edit') {
      this.loadExtraDataForEdit(p).catch(() => {});
    }
  }

  private setCardEmpty(html: string): void {
    if (this.cardEl) this.cardEl.innerHTML = html;
  }

  private setCardHint(): void {
    this.setCardEmpty(`
      <div class="ph-card-empty">
        <div class="ph-card-empty-icon">${I.package('', 38)}</div>
        <div class="ph-card-empty-title">Выберите товар</div>
        <div class="ph-card-empty-text">Нажмите на любой товар в списке слева, чтобы увидеть подробную информацию.</div>
      </div>`);
  }

  private renderCard(p: HubProduct): void {
    if (!this.cardEl) return;
    this.cardEl.innerHTML = this.tplHead(p)
      + this.tplStats(p)
      + this.tplTabsHead(p)
      + `<div class="ph-tab-content">${this.tplTabContent(p)}</div>`
      + this.tplLightbox();
  }

  private tplLightbox(): string {
    return `
    <div class="ph-lightbox" id="ph-lightbox" style="display:none" role="dialog" aria-modal="true">
      <div class="ph-lb-overlay" data-ph-action="close-lightbox"></div>
      <div class="ph-lb-window">
        <button class="ph-lb-close" data-ph-action="close-lightbox" title="Закрыть (Esc)">✕</button>
        <button class="ph-lb-nav ph-lb-prev" data-ph-action="lightbox-prev" title="Назад (←)">‹</button>
        <img class="ph-lb-img" src="" alt="" onerror="this.style.opacity='.3'">
        <button class="ph-lb-nav ph-lb-next" data-ph-action="lightbox-next" title="Вперёд (→)">›</button>
        <div class="ph-lb-counter"></div>
      </div>
    </div>`;
  }

  private openLightbox(url: string, photos: string[]): void {
    const lb = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
    if (!lb) return;
    this.lightboxPhotos = photos.length ? photos : [url];
    this.lightboxIdx = Math.max(0, this.lightboxPhotos.indexOf(url));
    this.showLightboxImage(lb);
    lb.style.display = '';
  }

  private showLightboxImage(lb: HTMLElement): void {
    const img = lb.querySelector<HTMLImageElement>('.ph-lb-img');
    const counter = lb.querySelector<HTMLElement>('.ph-lb-counter');
    const prev = lb.querySelector<HTMLElement>('.ph-lb-prev');
    const next = lb.querySelector<HTMLElement>('.ph-lb-next');
    if (img) { img.style.opacity = '1'; img.src = this.lightboxPhotos[this.lightboxIdx] ?? ''; }
    if (counter) counter.textContent = this.lightboxPhotos.length > 1
      ? `${this.lightboxIdx + 1} / ${this.lightboxPhotos.length}` : '';
    if (prev) prev.style.visibility = this.lightboxPhotos.length > 1 ? 'visible' : 'hidden';
    if (next) next.style.visibility = this.lightboxPhotos.length > 1 ? 'visible' : 'hidden';
  }

  private closeLightbox(): void {
    const lb = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
    if (lb) lb.style.display = 'none';
  }

  // ─── Card pieces ────────────────────────────────────────────────

  private allPhotos(p: HubProduct): string[] {
    const all = [
      p.image_url,
      ...p.mp_entries.flatMap(e => e.images ?? []),
      ...p.box_links.map(l => l.image_url),
    ].filter((u): u is string => !!u && u.startsWith('http'));
    return [...new Set(all)].slice(0, 24);
  }

  private tplHead(p: HubProduct): string {
    const photos = this.allPhotos(p);
    const main = photos[0] ?? '';
    const gallery = photos.length === 0
      ? `<div class="ph-gallery"><div class="ph-gallery-main" style="display:flex;align-items:center;justify-content:center;color:var(--text3)">${I.image('', 28)}</div></div>`
      : `<div class="ph-gallery">
          <img class="ph-gallery-main" id="ph-gal-main" src="${esc(main)}" loading="lazy"
            data-ph-action="open-lightbox" data-url="${esc(main)}"
            onerror="this.style.opacity='.3'" style="cursor:zoom-in">
          ${photos.length > 1 ? `
            <div class="ph-gallery-strip">${photos.map((u, i) => `
              <img class="ph-gallery-thumb${i === 0 ? ' active' : ''}" src="${esc(u)}" loading="lazy"
                onclick="const m=document.getElementById('ph-gal-main');if(m){m.src='${esc(u)}';m.dataset.url='${esc(u)}';}
                         this.parentElement.querySelectorAll('.ph-gallery-thumb').forEach(t=>t.classList.remove('active'));
                         this.classList.add('active')"
                onerror="this.style.display='none'">`).join('')}</div>` : ''}
        </div>`;

    const warnings: string[] = [];
    if (!p.has_cost)     warnings.push(`<span class="ph-warn cost">${I.alertTriangle('', 11)} нет себестоимости</span>`);
    if (!p.has_mp)       warnings.push(`<span class="ph-warn mp">${I.alertTriangle('', 11)} не на МП</span>`);
    if (!p.has_repricer) warnings.push(`<span class="ph-warn repricer">${I.alertTriangle('', 11)} нет репрайсера</span>`);
    // Проверка устаревших данных (>7 дней без синхронизации)
    const STALE_MS = 7 * 24 * 3600 * 1000;
    const staleStores = p.mp_entries.filter(e => {
      const t = catalogCache.getSyncedAt(e.store_id);
      return !t || (Date.now() - new Date(t).getTime() > STALE_MS);
    });
    if (staleStores.length) {
      warnings.push(`<span class="ph-warn stale">${I.alertTriangle('', 11)} данные устарели · обновите синхронизацию</span>`);
    }

    const meta: string[] = [];
    if (p.category) meta.push(`<span class="ph-meta-chip">Категория<b>${esc(p.category)}</b></span>`);
    if (p.brand)    meta.push(`<span class="ph-meta-chip">Бренд<b>${esc(p.brand)}</b></span>`);
    if (p.barcode)  meta.push(`<span class="ph-meta-chip">Штрихкод<b>${esc(p.barcode)}${copyButton(p.barcode, 'Копировать штрихкод')}</b></span>`);

    return `
      <div class="ph-card-head">
        ${gallery}
        <div class="ph-head-info">
          <div class="ph-head-title${p.name ? '' : ' ph-head-title-empty'}">${p.name ? esc(p.name) : 'Без названия'}${p.name ? copyButton(p.name, 'Копировать название') : ''}</div>
          <div class="ph-head-article">
            <span>${esc(p.article)}</span>
            <button class="ph-head-article-copy" title="Копировать"
              onclick="navigator.clipboard.writeText('${esc(p.article).replace(/'/g,"&#39;")}')">${I.copy('', 12)}</button>
          </div>
          ${meta.length ? `<div class="ph-head-meta">${meta.join('')}</div>` : ''}
          ${warnings.length ? `<div class="ph-head-warnings">${warnings.join('')}</div>` : ''}
          ${p.mp_entries.some(e => e.url) ? `<div class="ph-head-mp-links">${p.mp_entries.filter(e => e.url).map(e =>
            `<a class="ph-mp-link mp-${e.mp}" href="${esc(e.url!)}" target="_blank" rel="noopener noreferrer">
              <span class="ph-mp-link-label">${MP_LABEL[e.mp]}</span>
              <span class="ph-mp-link-store">${esc(e.store_name)}</span>
              ${I.externalLink('', 10)}
            </a>`).join('')}</div>` : ''}
          <div class="ph-head-actions">
            <button class="ph-action" onclick="window.app?.navigateTo('analytics')">${I.chart('', 12)} Аналитика</button>
            <button class="ph-action" onclick="window.app?.navigateTo('repricer')">${I.trendingUp('', 12)} Репрайсер</button>
            <button class="ph-action primary" onclick="window.productsHubModule?.setTab('card-edit')">${I.edit('', 12)} Редактировать</button>
          </div>
        </div>
      </div>`;
  }

  private tplStats(p: HubProduct): string {
    const priced = p.mp_entries.filter(e => e.price != null);
    const avgPrice = priced.length
      ? priced.reduce((s, e) => s + (e.price ?? 0), 0) / priced.length
      : null;
    const margin = (p.cost_price != null && avgPrice != null)
      ? Math.round(avgPrice - p.cost_price) : null;
    const marginPct = (margin != null && avgPrice != null && avgPrice > 0)
      ? Math.round((margin / avgPrice) * 100) : null;
    const totalStock = p.mp_entries.reduce((s, e) => s + (e.stock_total || 0), 0);
    const totalSales30 = p.mp_entries.reduce((s, e) => s + e.sales_qty, 0);
    const totalNet30 = p.mp_entries.reduce((s, e) => s + e.net_profit, 0);

    const stat = (label: string, value: string, sub: string = '', cls = '') =>
      `<div class="ph-stat">
        <div class="ph-stat-label">${label}</div>
        <div class="ph-stat-value ${cls}">${value}</div>
        ${sub ? `<div class="ph-stat-sub">${sub}</div>` : ''}
      </div>`;

    return `<div class="ph-stats">
      ${stat('Себестоимость', pr(p.cost_price), '', p.cost_price == null ? 'muted' : '')}
      ${stat('Средняя цена', pr(avgPrice), priced.length ? `${priced.length} ${priced.length === 1 ? 'магазин' : 'магазинов'}` : '', avgPrice == null ? 'muted' : '')}
      ${stat('Маржа за шт.', margin != null ? prSigned(margin) : '—', marginPct != null ? `${marginPct}% · без комиссий МП` : 'без комиссий МП', margin == null ? 'muted' : margin >= 0 ? 'pos' : 'neg')}
      ${stat(`Прибыль ${this.period}д`, prSigned(totalNet30), `${totalSales30} продаж · остаток ${totalStock}`, totalNet30 === 0 ? 'muted' : totalNet30 > 0 ? 'pos' : 'neg')}
    </div>`;
  }

  private tplTabsHead(_p: HubProduct): string {
    const tab = (id: Tab, label: string, icon: string, badge?: number | string) => `
      <button class="ph-tab${this.activeTab === id ? ' active' : ''}"
        onclick="window.productsHubModule?.setTab('${id}')">
        ${icon}${label}${badge != null ? `<span class="ph-tab-badge">${badge}</span>` : ''}
      </button>`;
    return `<div class="ph-tabs">
      ${tab('overview',   'Обзор',         I.info('', 13))}
      ${tab('finance',    'Финансы',        I.dollarSign('', 13))}
      ${tab('card-edit',  'Редактировать',  I.edit('', 13))}
      ${tab('photos',     'Фото',           I.image('', 13))}
    </div>`;
  }

  private tplTabContent(p: HubProduct): string {
    switch (this.activeTab) {
      case 'overview':   return this.tplOverview(p);
      case 'finance':    return this.tplFinance(p);
      case 'card-edit':  return this.tplCardEdit(p);
      case 'photos':     return this.tplPhotosTab(p);
    }
  }

  // ─── Tab: Overview ──────────────────────────────────────────────

  private tplOverview(p: HubProduct): string {
    const stores = p.mp_entries.length
      ? this.tplStoresTable(p, false)
      : `<div class="ph-empty">Товар не найден ни на одном маркетплейсе</div>`;

    const dimsInfo: Array<{ label: string; value: string }> = [];
    if (p.weight_kg) dimsInfo.push({ label: 'Вес', value: `${p.weight_kg} кг` });
    if (p.length_cm || p.width_cm || p.height_cm) {
      dimsInfo.push({ label: 'Размеры (Д×Ш×В)', value: `${p.length_cm ?? 0}×${p.width_cm ?? 0}×${p.height_cm ?? 0} см` });
    }
    const volume = (p.length_cm && p.width_cm && p.height_cm)
      ? (p.length_cm * p.width_cm * p.height_cm) / 1000 : null;
    if (volume != null) dimsInfo.push({ label: 'Объём', value: `${volume.toFixed(2)} л` });

    const dimsHtml = dimsInfo.length
      ? `<div class="ph-info-grid">${dimsInfo.map(i =>
          `<div class="ph-info-item"><span class="ph-info-item-label">${esc(i.label)}</span><span class="ph-info-item-value">${esc(i.value)}</span></div>`
        ).join('')}</div>`
      : `<div class="ph-empty">Габариты не заполнены</div>`;

    const repHtml = p.repricer_rules.length
      ? p.repricer_rules.map(r => this.tplRule(r)).join('')
      : `<div class="ph-empty">Нет активных правил репрайсера</div>`;

    const supplierHtml = p.supplier && (p.supplier.producer || p.supplier.product)
      ? this.tplSupplier(p.supplier)
      : `<div class="ph-empty">Поставщик не задан</div>`;

    const customHtml = p.custom_fields.length
      ? `<div class="ph-info-grid">${p.custom_fields.map(f =>
          `<div class="ph-info-item"><span class="ph-info-item-label">${esc(f.label)}</span><span class="ph-info-item-value">${esc(String(f.value))}</span></div>`
        ).join('')}</div>`
      : '';

    // Extra product info per store (description, barcode, vat, commission)
    const extraRows = p.mp_entries.map(e => {
      const items: string[] = [];
      if (e.description) items.push(`<span class="ph-extra-key">Описание:</span> <span class="ph-extra-val">${esc(e.description.slice(0, 120))}${e.description.length > 120 ? '…' : ''}</span>`);
      if (e.barcode)     items.push(`<span class="ph-extra-key">Штрихкод:</span> <span class="ph-extra-val">${esc(e.barcode)}</span>`);
      if (e.vat)         items.push(`<span class="ph-extra-key">НДС:</span> <span class="ph-extra-val">${esc(e.vat === '0' || e.vat === 'NO_VAT' ? 'Без НДС' : e.vat === '0.1' || e.vat === 'VAT_10' ? '10%' : e.vat === '0.2' || e.vat === 'VAT_20' ? '20%' : e.vat)}</span>`);
      const commPct = e.sales_revenue > 0 ? Math.abs(e.commission) / e.sales_revenue * 100 : null;
      if (commPct != null) items.push(`<span class="ph-extra-key">Комиссия МП:</span> <span class="ph-extra-val">${commPct.toFixed(1)}%</span>`);
      if (!items.length) return '';
      const mpLabel = e.mp === 'ozon' ? 'OZ' : e.mp === 'wb' ? 'WB' : 'ЯМ';
      return `<div class="ph-extra-row"><span class="cmp-mp-badge cmp-mp-badge--${e.mp}" style="font-size:10px;padding:1px 5px">${mpLabel}</span><span class="ph-extra-store">${esc(e.store_name)}</span><div class="ph-extra-items">${items.join('')}</div></div>`;
    }).filter(Boolean);

    return `
      <div class="ph-section">
        <div class="ph-section-head">${I.store('', 12)} Магазины и цены</div>
        ${stores}
      </div>
      ${extraRows.length ? `<div class="ph-section">
        <div class="ph-section-head">${I.info('', 12)} Данные товара по магазинам</div>
        <div class="ph-extra-list">${extraRows.join('')}</div>
      </div>` : ''}
      <div class="ph-section">
        <div class="ph-section-head">${I.scale('', 12)} Габариты</div>
        ${dimsHtml}
      </div>
      <div class="ph-section">
        <div class="ph-section-head">${I.trendingUp('', 12)} Репрайсер</div>
        ${repHtml}
      </div>
      <div class="ph-section">
        <div class="ph-section-head">${I.users('', 12)} Поставщик</div>
        ${supplierHtml}
      </div>
      ${customHtml ? `<div class="ph-section">
        <div class="ph-section-head">${I.tag('', 12)} Кастомные поля</div>
        ${customHtml}
      </div>` : ''}
    `;
  }

  private tplStoresTable(p: HubProduct, compactSub: boolean): string {
    return `<div class="ph-stores">${p.mp_entries.map(e => {
      const stockText = e.mp === 'ozon'
        ? `FBS ${e.stock_fbs} · FBO ${e.stock_fbo}`
        : e.mp === 'wb'
          ? `Остаток ${e.stock_total}`
          : `Доступно ${e.stock_available} · Всего ${e.stock_total}`;
      const stockLow = (e.stock_total === 0);
      const priceHtml = (e.old_price && e.price && e.old_price > e.price)
        ? `<span class="ph-store-price-old">${pr(e.old_price)}</span>${pr(e.price)}`
        : pr(e.price);
      const salesHtml = e.sales_qty > 0
        ? `<b>${e.sales_qty}</b> шт · ${pr(e.sales_revenue)}`
        : '<span style="color:var(--text3)">нет продаж</span>';
      const subParts: string[] = [];
      if (!compactSub) {
        if (e.images.length) subParts.push(`${e.images.length} фото`);
      }
      return `<div class="ph-store-row">
        <span class="ph-mp-tag mp-${e.mp}">${MP_LABEL[e.mp]}</span>
        <div style="min-width:0">
          <div class="ph-store-name" title="${esc(e.store_name)}">
            ${esc(e.store_name)}${copyButton(e.store_name, 'Копировать название магазина')}
            ${e.status ? `<span class="ph-status-pill ${e.status.includes('продаже') ? 'ok' : e.status.includes('наличии') ? 'danger' : e.status.includes('Архив') || e.status.includes('архиве') || e.status.includes('Скрыт') ? 'warn' : ''}">${esc(e.status)}</span>` : ''}
          </div>
          ${subParts.length ? `<div class="ph-store-sub">${subParts.join(' · ')}</div>` : ''}
        </div>
        <div class="ph-store-stock${stockLow ? ' low' : ''}">${stockText}</div>
        <div class="ph-store-sales">${salesHtml}</div>
        <div class="ph-store-price">${priceHtml}</div>
        ${e.url
          ? `<a class="ph-store-link" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="Открыть на маркетплейсе">${I.externalLink('', 13)}</a>`
          : `<span class="ph-store-link disabled" title="Ссылка недоступна">${I.externalLink('', 13)}</span>`}
      </div>`;
    }).join('')}</div>`;
  }

  // ─── Tab: Finance ───────────────────────────────────────────────

  private tplFinance(p: HubProduct): string {
    const totalQty   = p.mp_entries.reduce((s, e) => s + e.sales_qty, 0);
    const totalRet   = p.mp_entries.reduce((s, e) => s + e.returns_qty, 0);
    const totalRev   = p.mp_entries.reduce((s, e) => s + e.sales_revenue, 0);
    const totalComm  = p.mp_entries.reduce((s, e) => s + e.commission, 0);
    const totalDel   = p.mp_entries.reduce((s, e) => s + e.delivery, 0);
    const totalSvc   = p.mp_entries.reduce((s, e) => s + e.services, 0);
    const totalNet   = p.mp_entries.reduce((s, e) => s + e.net_profit, 0);
    const cogs = (p.cost_price != null) ? -p.cost_price * totalQty : 0;
    const netWithCogs = totalNet + cogs;

    const summary = `
      <div class="ph-sales-block">
        <div class="ph-sales-grid">
          <div class="ph-sales-cell">
            <div class="ph-sales-cell-label">Продаж</div>
            <div class="ph-sales-cell-value">${num(totalQty)}</div>
            <div class="ph-sales-cell-sub">шт. за ${this.period} дней</div>
          </div>
          <div class="ph-sales-cell">
            <div class="ph-sales-cell-label">Возвратов</div>
            <div class="ph-sales-cell-value${totalRet > 0 ? ' neg' : ''}">${num(totalRet)}</div>
            <div class="ph-sales-cell-sub">${totalQty > 0 ? `${Math.round((totalRet / totalQty) * 100)}%` : '—'}</div>
          </div>
          <div class="ph-sales-cell">
            <div class="ph-sales-cell-label">Оборот</div>
            <div class="ph-sales-cell-value">${pr(totalRev)}</div>
            <div class="ph-sales-cell-sub">валовая выручка</div>
          </div>
          <div class="ph-sales-cell">
            <div class="ph-sales-cell-label">Чистая прибыль</div>
            <div class="ph-sales-cell-value ${netWithCogs > 0 ? 'pos' : netWithCogs < 0 ? 'neg' : ''}">${prSigned(netWithCogs)}</div>
            <div class="ph-sales-cell-sub">после себестоимости</div>
          </div>
        </div>
      </div>`;

    const breakdown = `
      <div class="ph-fin-breakdown">
        <div class="ph-fin-row"><span class="ph-fin-row-label">Выручка маркетплейсов</span><span class="ph-fin-row-value">${prSigned(totalRev)}</span></div>
        <div class="ph-fin-row"><span class="ph-fin-row-label">Комиссия МП</span><span class="ph-fin-row-value neg">${prSigned(totalComm)}</span></div>
        <div class="ph-fin-row"><span class="ph-fin-row-label">Логистика</span><span class="ph-fin-row-value neg">${prSigned(totalDel)}</span></div>
        <div class="ph-fin-row"><span class="ph-fin-row-label">Прочие услуги</span><span class="ph-fin-row-value ${totalSvc < 0 ? 'neg' : ''}">${prSigned(totalSvc)}</span></div>
        ${p.cost_price != null ? `<div class="ph-fin-row"><span class="ph-fin-row-label">Себестоимость (${num(totalQty)} × ${pr(p.cost_price)})</span><span class="ph-fin-row-value neg">${prSigned(cogs)}</span></div>` : ''}
        <div class="ph-fin-row total"><span class="ph-fin-row-label">Чистая прибыль</span><span class="ph-fin-row-value ${netWithCogs >= 0 ? 'pos' : 'neg'}">${prSigned(netWithCogs)}</span></div>
      </div>`;

    const perStore = p.mp_entries.filter(e => e.sales_qty || e.returns_qty || e.net_profit).length === 0
      ? `<div class="ph-empty">${this.hadTransactions
            ? `За ${this.period} дней нет продаж этого товара. Попробуйте увеличить период.`
            : `Нет данных о транзакциях. Зайдите в раздел «Аналитика» и синхронизируйте финансы маркетплейсов — после этого здесь появятся продажи, возвраты, комиссии и чистая прибыль.`}</div>`
      : `<div class="ph-stores">${p.mp_entries.filter(e => e.sales_qty || e.returns_qty || e.net_profit).map(e => `
          <div class="ph-store-row" style="grid-template-columns:60px 1fr 100px 110px 100px 36px">
            <span class="ph-mp-tag mp-${e.mp}">${MP_LABEL[e.mp]}</span>
            <div class="ph-store-name" title="${esc(e.store_name)}">${esc(e.store_name)}</div>
            <div class="ph-store-stock"><b>${e.sales_qty}</b> прод.${e.returns_qty ? ` / <span style="color:#f87171">${e.returns_qty} в.</span>` : ''}</div>
            <div class="ph-store-sales">${pr(e.sales_revenue)}</div>
            <div class="ph-store-price ${e.net_profit >= 0 ? '' : ''}" style="color:${e.net_profit >= 0 ? '#4ade80' : '#f87171'}">${prSigned(e.net_profit)}</div>
            <span></span>
          </div>`).join('')}</div>`;

    return `
      <div class="ph-section">
        <div class="ph-section-head">${I.chart('', 12)} Итого за ${this.period} дней</div>
        ${summary}
      </div>
      <div class="ph-section">
        <div class="ph-section-head">${I.dollarSign('', 12)} Структура прибыли</div>
        ${breakdown}
      </div>
      <div class="ph-section">
        <div class="ph-section-head">${I.store('', 12)} По магазинам</div>
        ${perStore}
      </div>
    `;
  }

  // ─── Repricer rule card ─────────────────────────────────────────

  private tplRule(r: RepricerRule): string {
    const mp = r.marketplace?.toLowerCase() as Mp | undefined;
    const active = r.status === 'active';
    return `<div class="ph-rule-card">
      <div class="ph-rule-head">
        ${mp ? `<span class="ph-mp-tag mp-${mp}">${MP_LABEL[mp]}</span>` : ''}
        <span class="ph-rule-title">${RULE_LABELS[r.type] ?? r.type}</span>
        <span class="ph-status-pill ${active ? 'ok' : ''}">${active ? 'Активно' : 'На паузе'}</span>
      </div>
      <div class="ph-rule-fields">
        ${r.minPrice != null ? `<div class="ph-rule-field">Мин<b>${pr(r.minPrice)}</b></div>` : ''}
        ${r.maxPrice != null ? `<div class="ph-rule-field">Макс<b>${pr(r.maxPrice)}</b></div>` : ''}
        ${r.lastAppliedPrice != null ? `<div class="ph-rule-field">Применено<b>${pr(r.lastAppliedPrice)}</b></div>` : ''}
      </div>
    </div>`;
  }

  // ─── Supplier ──────────────────────────────────────────────────

  private tplSupplier(s: SupplierLink): string {
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
    const fields: Array<{ label: string; value: string }> = [];
    if (s.product) {
      if (s.product.internal_id != null) fields.push({ label: 'Внутр. ID', value: '#' + s.product.internal_id });
      if (s.quantity) fields.push({ label: 'Кол-во в упак.', value: String(s.quantity) });
      // Resolve UUID field keys → human-readable names via fieldDefNames map
      for (const [k, v] of Object.entries(s.product.field_values ?? {})) {
        const label = this.fieldDefNames.get(k) ?? (isUuid(k) ? null : k);
        if (!label) continue;
        const val = String(v ?? '').trim();
        if (val) fields.push({ label, value: val });
      }
      if (s.product.comment?.trim()) fields.push({ label: 'Комментарий', value: s.product.comment.trim() });
    }
    if (s.producer?.contacts?.trim()) fields.push({ label: 'Контакты', value: s.producer.contacts.trim() });

    const producerName = s.producer?.name && !isUuid(s.producer.name) ? s.producer.name : (s.producer ? 'Поставщик' : 'Без названия');
    const productName  = s.product?.name  && !isUuid(s.product.name)  ? ` — ${esc(s.product.name)}` : '';
    return `<div class="ph-supplier">
      <div class="ph-supplier-name">
        ${I.users('', 14)} ${esc(producerName)}${productName}
        <button class="ph-supplier-link" onclick="window.app?.navigateTo('producers')" title="Перейти к поставщику">${I.externalLink('', 11)} Открыть</button>
      </div>
      ${fields.length
        ? `<div class="ph-info-grid">${fields.map(f =>
            `<div class="ph-info-item"><span class="ph-info-item-label">${esc(f.label)}</span><span class="ph-info-item-value">${esc(f.value)}</span></div>`
          ).join('')}</div>`
        : ''}
    </div>`;
  }

  // ─── Tab: Card Edit ─────────────────────────────────────────────

  private initEditState(p: HubProduct): void {
    this.editState.clear();
    const art = p.article.toLowerCase();
    const lockedMps = this.lockedByMp.get(art) ?? new Set<Mp>();

    for (const entry of p.mp_entries) {
      const locked = lockedMps.has(entry.mp);
      if (entry.mp === 'ozon') {
        const store = this.ozStores.find((s: any) => s.id === entry.store_id);
        const prod  = this.ozProds.find((x: any) => x.store_id === entry.store_id && String(x.offer_id ?? '').trim().toLowerCase() === art);
        if (!store || !prod) continue;
        // vat pre-loaded from DB; description still needs API call (not synced to DB)
        this.editState.set(entry.store_id, {
          mp: 'ozon',
          name: prod.name ?? '', brand: '', barcode: prod.barcode ?? '',
          description: entry.description,
          vat: entry.vat || prod.vat || '0',
          price: prod.price != null ? String(prod.price) : '',
          old_price: prod.old_price ? String(prod.old_price) : '',
          min_price: prod.min_price ? String(prod.min_price) : '',
          discount: '',
          weight_kg: prod.weight_kg ? String(prod.weight_kg) : (p.weight_kg ? String(p.weight_kg) : ''),
          length_cm: prod.length_cm ? String(prod.length_cm) : (p.length_cm ? String(p.length_cm) : ''),
          width_cm:  prod.width_cm  ? String(prod.width_cm)  : (p.width_cm  ? String(p.width_cm)  : ''),
          height_cm: prod.height_cm ? String(prod.height_cm) : (p.height_cm ? String(p.height_cm) : ''),
          photos: [...(prod.images ?? [])],
          priceLocked: locked, saving: false, saveError: '', saveOk: false,
          extraLoaded: false, extraLoading: false, // description still fetched on-demand
        });
      } else if (entry.mp === 'wb') {
        const store = this.wbStores.find((s: any) => s.id === entry.store_id);
        const prod  = this.wbProds.find((x: any) => x.store_id === entry.store_id &&
          String(x.vendor_code ?? x.nm_id ?? '').trim().toLowerCase() === art);
        if (!store || !prod) continue;
        // description, barcode pre-loaded from DB
        this.editState.set(entry.store_id, {
          mp: 'wb',
          name: prod.title ?? '', brand: prod.brand ?? '',
          barcode: entry.barcode || prod.barcode || '',
          description: entry.description || prod.description || '',
          vat: '',
          price: prod.price != null ? String(prod.price) : '',
          old_price: '', min_price: '',
          discount: prod.discount != null ? String(prod.discount) : '',
          weight_kg: prod.weight_kg ? String(prod.weight_kg) : (p.weight_kg ? String(p.weight_kg) : ''),
          length_cm: prod.length_cm ? String(prod.length_cm) : '', width_cm: prod.width_cm ? String(prod.width_cm) : '',
          height_cm: prod.height_cm ? String(prod.height_cm) : '',
          photos: [...(prod.pictures ?? [])],
          priceLocked: locked, saving: false, saveError: '', saveOk: false,
          extraLoaded: true, extraLoading: false, // description from DB — no API call needed
        });
      } else if (entry.mp === 'yandex') {
        const store = this.ymStores.find((s: any) => s.id === entry.store_id);
        const prod  = this.ymProds.find((x: any) => x.store_id === entry.store_id &&
          String(x.offer_id ?? x.vendor_code ?? '').trim().toLowerCase() === art);
        if (!store || !prod) continue;
        // description, vat, barcode pre-loaded from DB
        this.editState.set(entry.store_id, {
          mp: 'yandex',
          name: prod.name ?? '', brand: prod.vendor ?? '',
          barcode: entry.barcode || prod.barcode || '',
          description: entry.description || prod.description || '',
          vat: entry.vat || prod.vat || '',
          price: prod.basic_price != null ? String(prod.basic_price) : '',
          old_price: '', min_price: '',
          discount: '',
          weight_kg: prod.weight_kg ? String(prod.weight_kg) : (p.weight_kg ? String(p.weight_kg) : ''),
          length_cm: prod.length_cm ? String(prod.length_cm) : '', width_cm: prod.width_cm ? String(prod.width_cm) : '',
          height_cm: prod.height_cm ? String(prod.height_cm) : '',
          photos: [...(prod.pictures ?? [])],
          priceLocked: locked, saving: false, saveError: '', saveOk: false,
          extraLoaded: true, extraLoading: false, // all extra data from DB
        });
      }
    }
  }

  private tplEditSection(entry: MpStoreEntry): string {
    const st = this.editState.get(entry.store_id);
    if (!st) return `<div class="cmp-edit-section"><div class="ph-empty">Магазин не найден — сначала синхронизируйте данные</div></div>`;
    const mp = entry.mp;
    const mpLabel = mp === 'ozon' ? 'OZ' : mp === 'wb' ? 'WB' : 'ЯМ';
    const roIcon = `<span class="cmp-field-ro" title="Нельзя редактировать через API">${I.alertTriangle('', 12)}</span>`;
    const vatOzonOpts = [['0','Без НДС'],['0.1','10%'],['0.2','20%']];
    const vatYmOpts   = [['NO_VAT','Без НДС'],['VAT_10','10%'],['VAT_20','20%']];
    return `
    <div class="cmp-edit-section">
      <div class="cmp-edit-head">
        <span class="cmp-mp-badge cmp-mp-badge--${mp}">${mpLabel}</span>
        <span class="cmp-edit-store">${esc(entry.store_name)}</span>
      </div>
      <div class="cmp-edit-grid">
        <label class="cmp-edit-field cmp-edit-field--wide"><span class="cmp-edit-label">Название</span>
          <input type="text" class="cmp-edit-input" data-ph-field="name" data-store-id="${entry.store_id}" value="${esc(st.name)}" placeholder="—"></label>

        ${mp === 'wb' || mp === 'yandex' ? `<label class="cmp-edit-field"><span class="cmp-edit-label">Бренд</span>
          <input type="text" class="cmp-edit-input" data-ph-field="brand" data-store-id="${entry.store_id}" value="${esc(st.brand)}" placeholder="—"></label>` : ''}
        ${mp === 'ozon' ? `<div class="cmp-edit-field"><span class="cmp-edit-label">Бренд ${roIcon}</span>
          <div class="cmp-edit-ro">${esc(st.brand) || '—'}</div></div>` : ''}

        ${mp === 'ozon' || mp === 'yandex' ? `<label class="cmp-edit-field"><span class="cmp-edit-label">Штрихкод</span>
          <input type="text" class="cmp-edit-input" data-ph-field="barcode" data-store-id="${entry.store_id}" value="${esc(st.barcode)}" placeholder="—"></label>` : ''}
        ${mp === 'wb' ? `<div class="cmp-edit-field"><span class="cmp-edit-label">Штрихкод ${roIcon}</span>
          <div class="cmp-edit-ro">${esc(st.barcode) || '—'}</div></div>` : ''}

        ${mp === 'ozon' ? `<label class="cmp-edit-field"><span class="cmp-edit-label">НДС</span>
          <select class="cmp-edit-input" data-ph-field="vat" data-store-id="${entry.store_id}">
            ${vatOzonOpts.map(([v,l]) => `<option value="${v}" ${st.vat === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>` : ''}
        ${mp === 'yandex' ? `<label class="cmp-edit-field"><span class="cmp-edit-label">НДС</span>
          <select class="cmp-edit-input" data-ph-field="vat" data-store-id="${entry.store_id}">
            ${vatYmOpts.map(([v,l]) => `<option value="${v}" ${st.vat === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>` : ''}

        <label class="cmp-edit-field"><span class="cmp-edit-label">Цена (₽)${st.priceLocked ? ` <span class="cmp-lock-tag" title="Репрайсер">${I.lock('', 12)}</span>` : ''}${mp === 'yandex' ? ` <span class="cmp-field-note" title="Устанавливается на уровне бизнеса — одинакова для всех кампаний">бизнес-уровень</span>` : ''}</span>
          <input type="number" class="cmp-edit-input${st.priceLocked ? ' cmp-edit-input--locked' : ''}"
            data-ph-field="price" data-store-id="${entry.store_id}"
            value="${esc(st.price)}" ${st.priceLocked ? 'readonly data-price-locked="true"' : ''} placeholder="—"></label>
        ${mp === 'ozon' && !st.priceLocked ? `
        <label class="cmp-edit-field"><span class="cmp-edit-label">Старая цена (₽) <span style="color:var(--text3);font-weight:400">зачёркнутая</span></span>
          <input type="number" class="cmp-edit-input" data-ph-field="old_price" data-store-id="${entry.store_id}" value="${esc(st.old_price)}" placeholder="—"></label>
        <label class="cmp-edit-field"><span class="cmp-edit-label">Мин. цена (₽) <span style="color:var(--text3);font-weight:400">для репрайсера</span></span>
          <input type="number" class="cmp-edit-input" data-ph-field="min_price" data-store-id="${entry.store_id}" value="${esc(st.min_price)}" placeholder="—"></label>` : ''}
        ${mp === 'wb' ? `<label class="cmp-edit-field"><span class="cmp-edit-label">Скидка (%)</span>
          <input type="number" min="0" max="99" class="cmp-edit-input" data-ph-field="discount" data-store-id="${entry.store_id}" value="${esc(st.discount)}" placeholder="0"></label>` : ''}

        <label class="cmp-edit-field"><span class="cmp-edit-label">Вес (кг)</span>
          <input type="number" step="0.001" class="cmp-edit-input" data-ph-field="weight_kg" data-store-id="${entry.store_id}" value="${esc(st.weight_kg)}" placeholder="0.000"></label>
        <label class="cmp-edit-field"><span class="cmp-edit-label">Длина (см)</span>
          <input type="number" step="0.1" class="cmp-edit-input" data-ph-field="length_cm" data-store-id="${entry.store_id}" value="${esc(st.length_cm)}" placeholder="0.0"></label>
        <label class="cmp-edit-field"><span class="cmp-edit-label">Ширина (см)</span>
          <input type="number" step="0.1" class="cmp-edit-input" data-ph-field="width_cm" data-store-id="${entry.store_id}" value="${esc(st.width_cm)}" placeholder="0.0"></label>
        <label class="cmp-edit-field"><span class="cmp-edit-label">Высота (см)</span>
          <input type="number" step="0.1" class="cmp-edit-input" data-ph-field="height_cm" data-store-id="${entry.store_id}" value="${esc(st.height_cm)}" placeholder="0.0"></label>

        <label class="cmp-edit-field cmp-edit-field--wide"><span class="cmp-edit-label">Описание${st.extraLoading ? ' <span class="cmp-spinner-sm"></span>' : ''}</span>
          <textarea class="cmp-edit-input cmp-edit-textarea" data-ph-field="description" data-store-id="${entry.store_id}" rows="4" ${st.extraLoading ? 'disabled' : ''} placeholder="—">${esc(st.description)}</textarea></label>

        ${mp === 'wb' && entry.characteristics?.length ? `<div class="cmp-edit-field cmp-edit-field--wide">
          <span class="cmp-edit-label">Характеристики ${roIcon}</span>
          <div class="cmp-edit-chars">${entry.characteristics.map(ch => `<span class="cmp-char-item"><b>${esc(ch.name)}:</b> ${esc(ch.value)}</span>`).join('')}</div>
        </div>` : ''}
      </div>
      ${st.saveOk ? `<div class="cmp-edit-ok">✓ Сохранено</div>` : st.saveError ? `<div class="cmp-edit-error${st.saveError.startsWith('✓') ? ' cmp-edit-pending' : ''}">${esc(st.saveError)}</div>` : ''}
      <div class="cmp-edit-foot">
        <button class="cmp-btn cmp-btn-primary${st.saving ? ' loading' : ''}"
          data-ph-action="save-card" data-store-id="${entry.store_id}" data-mp="${mp}" ${st.saving ? 'disabled' : ''}>
          ${st.saving ? '<span class="cmp-spinner-sm"></span> Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>`;
  }

  /** Compact YM section for secondary campaigns (same business): only price. */
  private tplEditSectionYmCompact(entry: MpStoreEntry, primaryName: string): string {
    const st = this.editState.get(entry.store_id);
    if (!st) return '';
    return `
    <div class="cmp-edit-section cmp-edit-section--compact">
      <div class="cmp-edit-head">
        <span class="cmp-mp-badge cmp-mp-badge--yandex">ЯМ</span>
        <span class="cmp-edit-store">${esc(entry.store_name)}</span>
        <span class="cmp-edit-shared-note">карточка общая с «${esc(primaryName)}»</span>
      </div>
      <div class="cmp-edit-compact-note">Название, описание и фото управляются из раздела «${esc(primaryName)}» выше (общие для всего бизнеса). <span style="color:var(--warn,#fbbf24)">Цена тоже общая для бизнеса — Яндекс Маркет не поддерживает разные цены по кампаниям через API.</span></div>
      <div class="cmp-edit-grid">
        <label class="cmp-edit-field"><span class="cmp-edit-label">Цена (₽)${st.priceLocked ? ` <span class="cmp-lock-tag">${I.lock('', 12)}</span>` : ''}</span>
          <input type="number" class="cmp-edit-input${st.priceLocked ? ' cmp-edit-input--locked' : ''}"
            data-ph-field="price" data-store-id="${entry.store_id}"
            value="${esc(st.price)}" ${st.priceLocked ? 'readonly' : ''} placeholder="—"></label>
      </div>
      ${st.saveError ? `<div class="cmp-edit-error">${esc(st.saveError)}</div>` : ''}
      <div class="cmp-edit-foot">
        <button class="cmp-btn cmp-btn-primary${st.saving ? ' loading' : ''}"
          data-ph-action="save-card" data-store-id="${entry.store_id}" data-mp="yandex" ${st.saving ? 'disabled' : ''}>
          ${st.saving ? '<span class="cmp-spinner-sm"></span> Сохранение…' : 'Сохранить цену'}
        </button>
      </div>
    </div>`;
  }

  private tplCardEdit(p: HubProduct): string {
    if (!this.editState.size) this.initEditState(p);
    if (!p.mp_entries.length) return `<div class="ph-empty">Товар не найден ни на одном маркетплейсе</div>`;

    const syncBar = this.tplSyncBar(p);
    const nonYm = p.mp_entries.filter(e => e.mp !== 'yandex');
    const ymGroups = this.ymBusinessGroups(p.mp_entries.filter(e => e.mp === 'yandex'));

    const sections = [
      ...nonYm.map(e => this.tplEditSection(e)),
      ...ymGroups.flatMap(({ primary, secondary }) => [
        this.tplEditSection(primary),
        ...secondary.map(e => this.tplEditSectionYmCompact(e, primary.store_name)),
      ]),
    ].join('');

    return `
      ${syncBar ? `<div class="ph-section"><div class="ph-section-head">${I.refresh('', 12)} Синхронизация с МП</div><div class="cmp-sync-bar ph-sync-bar">${syncBar}</div></div>` : ''}
      <div class="cmp-tab-card" id="ph-card-edit-content">${sections}</div>`;
  }

  private tplSyncBar(p?: HubProduct): string {
    const productStoreIds = p ? new Set(p.mp_entries.map(e => e.store_id)) : null;
    const all = [
      ...this.ozStores.map((s: any) => ({ id: s.id, name: s.name ?? 'Ozon',   mp: 'ozon',   label: 'OZ' })),
      ...this.wbStores.map((s: any) => ({ id: s.id, name: s.name ?? 'WB',     mp: 'wb',     label: 'WB' })),
      ...this.ymStores.map((s: any) => ({ id: s.id, name: s.name ?? 'ЯМ',     mp: 'yandex', label: 'ЯМ' })),
    ];
    const stores = productStoreIds ? all.filter(s => productStoreIds.has(s.id)) : all;
    if (!stores.length) return '';
    return stores.map(s => {
      const isSyncing = !!this.syncing.get(s.id);
      const err = this.syncErr.get(s.id);
      const date = fmtSyncDate(catalogCache.getSyncedAt(s.id));
      return `<div class="cmp-sync-item">
        <span class="cmp-mp-badge cmp-mp-badge--${s.mp}">${s.label}</span>
        <span class="cmp-sync-name">${esc(s.name)}</span>
        <span class="cmp-sync-date ${err ? 'err' : ''}">${err ? esc(err) : date}</span>
        <button class="cmp-sync-btn" data-ph-action="sync-store" data-store-id="${s.id}" data-mp="${s.mp}" ${isSyncing ? 'disabled' : ''}>
          ${isSyncing ? '<span class="cmp-spinner-sm"></span>' : '↻'} ${isSyncing ? 'Синхр…' : 'Обновить'}
        </button>
      </div>`;
    }).join('');
  }

  // ─── Filter panel ────────────────────────────────────────────────

  private chip(label: string, active: boolean, fAttr: string, val?: string): string {
    const data = val !== undefined ? `data-f="${fAttr}" data-val="${esc(val)}"` : `data-f="${fAttr}"`;
    return `<span class="ph-f-chip${active ? ' on' : ''}" ${data}>${label}</span>`;
  }

  private tplFilterPanel(): string {
    const f = this.filters;
    const s = this.sortBy;
    const activeCount = this.countActiveFilters();
    return `
    <div class="ph-fp-inner">
      <div class="ph-fp-groups">

        <div class="ph-fp-group">
          <div class="ph-fp-label">Маркетплейс</div>
          <div class="ph-fp-chips">
            ${this.chip('Все', f.mp === '', 'mp', '')}
            ${this.chip('Ozon', f.mp === 'ozon', 'mp', 'ozon')}
            ${this.chip('WB', f.mp === 'wb', 'mp', 'wb')}
            ${this.chip('ЯМ', f.mp === 'yandex', 'mp', 'yandex')}
          </div>
        </div>

        <div class="ph-fp-group">
          <div class="ph-fp-label">Статус</div>
          <div class="ph-fp-chips">
            ${this.chip('Все', f.status === '', 'status', '')}
            ${this.chip('В продаже', f.status === 'В продаже', 'status', 'В продаже')}
            ${this.chip('Нет в наличии', f.status === 'Нет в наличии', 'status', 'Нет в наличии')}
            ${this.chip('В архиве / Скрыт', f.status === 'В архиве', 'status', 'В архиве')}
          </div>
        </div>

        <div class="ph-fp-group">
          <div class="ph-fp-label">Остаток</div>
          <div class="ph-fp-chips">
            ${this.chip('Любой', f.stock === 'any', 'stock', 'any')}
            ${this.chip('Только 0', f.stock === 'zero', 'stock', 'zero')}
            ${this.chip('Есть остаток', f.stock === 'pos', 'stock', 'pos')}
          </div>
        </div>

        <div class="ph-fp-group">
          <div class="ph-fp-label">Цена (₽)</div>
          <div class="ph-fp-price">
            <input id="ph-f-pmin" type="number" class="ph-fp-inp" placeholder="от" value="${f.price_min ?? ''}">
            <span class="ph-fp-sep">—</span>
            <input id="ph-f-pmax" type="number" class="ph-fp-inp" placeholder="до" value="${f.price_max ?? ''}">
          </div>
        </div>

        <div class="ph-fp-group">
          <div class="ph-fp-label">Сортировка</div>
          <div class="ph-fp-chips">
            ${this.chip('Артикул А→Я', s === 'article', 'sort', 'article')}
            ${this.chip('Прибыль ↓', s === 'profit', 'sort', 'profit')}
            ${this.chip('Продажи ↓', s === 'sales', 'sort', 'sales')}
            ${this.chip('Остаток ↓', s === 'stock', 'sort', 'stock')}
            ${this.chip('Маржа ↓', s === 'margin', 'sort', 'margin')}
          </div>
        </div>

      </div>

      <div class="ph-fp-divider"></div>

      <div class="ph-fp-groups ph-fp-groups--bottom">
        <div class="ph-fp-group">
          <div class="ph-fp-label">Проблемы</div>
          <div class="ph-fp-chips">
            ${this.chip('Без себестоимости', f.no_cost, 'toggle', 'no_cost')}
            ${this.chip('Нет на МП', f.no_mp, 'toggle', 'no_mp')}
            ${this.chip('Без репрайсера', f.no_repricer, 'toggle', 'no_repricer')}
          </div>
        </div>

        ${activeCount > 0 ? `<button class="ph-f-reset" id="ph-f-reset">✕ Сбросить всё</button>` : ''}
      </div>
    </div>`;
  }

  private bindFilterPanel(): void {
    const panel = this.el.querySelector<HTMLElement>('#ph-filter-panel');
    if (!panel) return;

    // Chip clicks (mp / status / stock / sort / toggle)
    panel.addEventListener('click', e => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.ph-f-chip');
      if (chip) {
        const f = chip.dataset.f!;
        const val = chip.dataset.val ?? '';
        if (f === 'mp')     this.filters.mp     = val as any;
        if (f === 'status') this.filters.status  = val;
        if (f === 'stock')  this.filters.stock   = val as any;
        if (f === 'sort')   this.sortBy          = val as any;
        if (f === 'toggle') {
          const key = val as keyof Filters;
          (this.filters as any)[key] = !(this.filters as any)[key];
        }
        this.applyFilters();
        this.renderList(true);
        this.refreshFilterPanel();
        return;
      }
      if ((e.target as HTMLElement).id === 'ph-f-reset') {
        this.filters = { q: '', mp: '', no_cost: false, no_mp: false, no_repricer: false, status: '', stock: 'any', price_min: null, price_max: null };
        this.sortBy = 'article';
        // clear search input too
        const si = this.el.querySelector<HTMLInputElement>('#ph-search');
        if (si) si.value = '';
        this.applyFilters();
        this.renderList(true);
        this.refreshFilterPanel();
      }
    });

    // Price range inputs (debounced)
    const bindPrice = (id: string, key: 'price_min' | 'price_max') => {
      const inp = panel.querySelector<HTMLInputElement>(`#${id}`);
      if (!inp) return;
      inp.addEventListener('input', () => {
        if (this.priceDebounce) clearTimeout(this.priceDebounce);
        this.priceDebounce = setTimeout(() => {
          const v = inp.value.trim();
          (this.filters as any)[key] = v ? +v : null;
          this.applyFilters();
          this.renderList(true);
          this.updateFilterBadge();
        }, 300);
      });
    };
    bindPrice('ph-f-pmin', 'price_min');
    bindPrice('ph-f-pmax', 'price_max');
  }

  private refreshFilterPanel(): void {
    if (!this.filtersOpen) return;
    const panel = this.el.querySelector<HTMLElement>('#ph-filter-panel');
    if (!panel) return;
    // Preserve price input focus/values before re-render
    const pminVal = this.el.querySelector<HTMLInputElement>('#ph-f-pmin')?.value ?? '';
    const pmaxVal = this.el.querySelector<HTMLInputElement>('#ph-f-pmax')?.value ?? '';
    panel.innerHTML = this.tplFilterPanel();
    this.bindFilterPanel();
    // Restore price values (they may differ from filters while debouncing)
    const pmin = panel.querySelector<HTMLInputElement>('#ph-f-pmin');
    const pmax = panel.querySelector<HTMLInputElement>('#ph-f-pmax');
    if (pmin && pminVal) pmin.value = pminVal;
    if (pmax && pmaxVal) pmax.value = pmaxVal;
    this.updateFilterBadge();
  }

  private countActiveFilters(): number {
    const f = this.filters;
    return [f.mp, f.status, f.stock !== 'any', f.price_min != null, f.price_max != null,
      f.no_cost, f.no_mp, f.no_repricer].filter(Boolean).length;
  }

  private updateFilterBadge(): void {
    const badge = this.el.querySelector<HTMLElement>('#ph-filters-badge');
    if (!badge) return;
    const n = this.countActiveFilters();
    badge.textContent = String(n);
    badge.style.display = n > 0 ? '' : 'none';
  }

  // ─── Tab: Photos ─────────────────────────────────────────────────

  /** Group Yandex mp_entries by business_id. Entries with same business share one card/photos. */
  private ymBusinessGroups(ymEntries: MpStoreEntry[]): Array<{ primary: MpStoreEntry; secondary: MpStoreEntry[] }> {
    const groups = new Map<string, MpStoreEntry[]>();
    for (const e of ymEntries) {
      const store = (this.ymStores as any[]).find(s => s.id === e.store_id);
      const bid = store?.business_id ? String(store.business_id) : e.store_id;
      if (!groups.has(bid)) groups.set(bid, []);
      groups.get(bid)!.push(e);
    }
    return [...groups.values()].map(g => ({ primary: g[0], secondary: g.slice(1) }));
  }

  private tplPhotoSection(entry: MpStoreEntry, primaryStoreId: string, extraNames: string[]): string {
    const st = this.editState.get(primaryStoreId);
    if (!st) return '';
    const mp = entry.mp;
    const mpLabel = mp === 'ozon' ? 'OZ' : mp === 'wb' ? 'WB' : 'ЯМ';
    const photos = st.photos;
    const isAdding = this.photoAddStoreId === primaryStoreId;
    const syncedAt = fmtSyncDate(catalogCache.getSyncedAt(primaryStoreId));
    const storeLabel = [entry.store_name, ...extraNames].join(' · ');
    return `
    <div class="cmp-photo-section">
      <div class="cmp-photo-hdr">
        <span class="cmp-mp-badge cmp-mp-badge--${mp}">${mpLabel}</span>
        <span class="cmp-photo-store">${esc(storeLabel)}</span>
        <span class="cmp-photo-sync">· обновлено ${syncedAt}</span>
        ${extraNames.length ? `<span class="cmp-photo-shared-note">общая карточка</span>` : ''}
        ${st.saving ? '<span class="cmp-spinner-sm"></span>' : ''}
        ${st.saveError ? `<span class="cmp-photo-err">${esc(st.saveError)}</span>` : ''}
      </div>
      <div class="cmp-photo-grid">
        ${photos.length === 0 ? '<div class="cmp-photo-none">Фото нет</div>' : ''}
        ${photos.map((url, idx) => `
          <div class="cmp-photo-cell" draggable="true" data-drag-idx="${idx}" data-drag-store-id="${primaryStoreId}">
            <div class="cmp-photo-wrap" data-ph-action="open-lightbox" data-url="${esc(url)}">
              <img src="${esc(url)}" loading="lazy" alt="">
              <span class="cmp-photo-num">${idx + 1}</span>
            </div>
            <div class="cmp-photo-ctrl">
              <span class="cmp-drag-handle" title="Перетащить">⠿</span>
              <button class="cmp-pbtn cmp-pbtn--del" data-ph-action="photo-delete" data-idx="${idx}" data-store-id="${primaryStoreId}" title="Удалить">✕</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="cmp-photo-acts">
        <button class="cmp-btn cmp-btn-sm" data-ph-action="photo-add-toggle" data-store-id="${primaryStoreId}">+ Добавить</button>
        ${photos.length > 0 ? `
          <button class="cmp-btn cmp-btn-sm cmp-btn-primary${st.saving ? ' loading' : ''}"
            data-ph-action="save-photos" data-store-id="${primaryStoreId}" data-mp="${mp}" ${st.saving ? 'disabled' : ''}>
            ${st.saving ? '<span class="cmp-spinner-sm"></span>' : 'Сохранить фото'}
          </button>` : ''}
      </div>
      ${isAdding ? `
      <div class="cmp-photo-add">
        <div class="cmp-photo-add-tabs">
          <button class="cmp-photo-add-tab ${this.photoAddMode === 'url' ? 'active' : ''}" data-ph-action="photo-mode-url" data-store-id="${primaryStoreId}">По ссылке</button>
          <button class="cmp-photo-add-tab ${this.photoAddMode === 'file' ? 'active' : ''}" data-ph-action="photo-mode-file" data-store-id="${primaryStoreId}">С компьютера</button>
        </div>
        ${this.photoAddMode === 'url' ? `
        <div class="cmp-photo-add-url">
          <input type="url" id="ph-photo-url-input" class="cmp-edit-input" placeholder="https://…" value="${esc(this.photoAddUrlValue)}">
          <button class="cmp-btn cmp-btn-primary" data-ph-action="photo-add-url" data-store-id="${primaryStoreId}">Добавить</button>
        </div>` : `
        <div class="cmp-photo-add-file">
          <input type="file" id="ph-photo-file-input" accept="image/*" multiple style="display:none" data-store-id="${primaryStoreId}">
          <button class="cmp-btn cmp-btn-primary" data-ph-action="photo-pick-file" data-store-id="${primaryStoreId}">Выбрать файлы</button>
          <span class="cmp-photo-file-hint">Загружаются при сохранении</span>
        </div>`}
      </div>` : ''}
    </div>`;
  }

  private tplPhotosTab(p: HubProduct): string {
    if (!this.editState.size) this.initEditState(p);
    if (!p.mp_entries.length) return `<div class="ph-empty">Товар не найден ни на одном маркетплейсе</div>`;

    const nonYm = p.mp_entries.filter(e => e.mp !== 'yandex');
    const ymGroups = this.ymBusinessGroups(p.mp_entries.filter(e => e.mp === 'yandex'));

    const sections = [
      ...nonYm.map(e => this.tplPhotoSection(e, e.store_id, [])),
      ...ymGroups.map(({ primary, secondary }) =>
        this.tplPhotoSection(primary, primary.store_id, secondary.map(e => e.store_name))
      ),
    ].join('');

    return `<div class="cmp-tab-photos" id="ph-photos-content">${sections}</div>`;
  }

  // ─── Refresh helpers ─────────────────────────────────────────────

  private refreshEditTab(): void {
    if (this.activeTab !== 'card-edit' || !this.selectedArticle) return;
    const p = this.items.find(x => x.article === this.selectedArticle);
    const el = this.cardEl?.querySelector<HTMLElement>('#ph-card-edit-content');
    if (!p || !el) return;
    const nonYm = p.mp_entries.filter(e => e.mp !== 'yandex');
    const ymGroups = this.ymBusinessGroups(p.mp_entries.filter(e => e.mp === 'yandex'));
    el.innerHTML = [
      ...nonYm.map(e => this.tplEditSection(e)),
      ...ymGroups.flatMap(({ primary, secondary }) => [
        this.tplEditSection(primary),
        ...secondary.map(e => this.tplEditSectionYmCompact(e, primary.store_name)),
      ]),
    ].join('');
  }

  private refreshPhotosTab2(): void {
    if (this.activeTab !== 'photos' || !this.selectedArticle) return;
    const p = this.items.find(x => x.article === this.selectedArticle);
    if (!p) return;
    const el = this.cardEl?.querySelector<HTMLElement>('#ph-photos-content');
    if (!el) { this.renderCard(p); return; }
    el.outerHTML = this.tplPhotosTab(p);
  }

  // ─── Sync ─────────────────────────────────────────────────────────

  private async doSync(storeId: string, mp: string): Promise<void> {
    this.syncing.set(storeId, true);
    this.syncErr.delete(storeId);
    this.updateSyncBarInCard();
    try {
      if (mp === 'ozon') {
        const s = this.ozStores.find((x: any) => x.id === storeId);
        if (s) await syncOzonStore(s);
      } else if (mp === 'wb') {
        const s = this.wbStores.find((x: any) => x.id === storeId);
        if (s) await syncWbStore(s);
      } else {
        const s = this.ymStores.find((x: any) => x.id === storeId);
        if (s) await syncYmStore(s);
      }
      await this.load();
    } catch (e: unknown) {
      this.syncErr.set(storeId, (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e))?.slice(0, 60) ?? 'Ошибка');
    } finally {
      this.syncing.set(storeId, false);
      this.updateSyncBarInCard();
    }
  }

  private updateSyncBarInCard(): void {
    const el = this.el.querySelector<HTMLElement>('.ph-sync-bar');
    if (!el) return;
    const p = this.selectedArticle ? this.items.find(x => x.article === this.selectedArticle) : undefined;
    el.innerHTML = this.tplSyncBar(p);
  }

  // ─── Save card ────────────────────────────────────────────────────

  private async doSaveCard(article: string, storeId: string, mp: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    const st = this.editState.get(storeId);
    if (!st) return;
    st.saving = true; st.saveError = ''; st.saveOk = false;
    this.refreshEditTab();
    try {
      // Use null for empty fields — 0 would overwrite real marketplace data with zero.
      const dims: Dimensions = {
        weight_g:  st.weight_kg ? Math.round(+st.weight_kg * 1000) : null,
        length_mm: st.length_cm ? Math.round(+st.length_cm * 10)   : null,
        width_mm:  st.width_cm  ? Math.round(+st.width_cm  * 10)   : null,
        height_mm: st.height_cm ? Math.round(+st.height_cm * 10)   : null,
      };

      if (mp === 'ozon') {
        const store = this.ozStores.find((s: any) => s.id === storeId);
        const prod  = this.ozProds.find((x: any) => x.store_id === storeId && String(x.offer_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Магазин или товар не найден — синхронизируйте данные');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const oz = toOzon(dims);
        let typeId = prod.type_id ?? 0;
        let catId  = prod.description_category_id ?? 0;
        if (!typeId || !catId) {
          const info = await ozonApi.getFullProductInfo(article, prod.product_id ?? null, creds);
          typeId = info?.type_id ?? 0;
          catId  = info?.description_category_id ?? 0;
          if (typeId) prod.type_id = typeId;
          if (catId)  prod.description_category_id = catId;
        }
        const item: Record<string, unknown> = { offer_id: article };
        // Only include dimensions if at least one value is set — avoids overwriting with zeros.
        if (oz.weight != null) { item.weight = oz.weight; item.weight_unit = oz.weight_unit; }
        if (oz.depth != null || oz.width != null || oz.height != null) {
          item.depth = oz.depth ?? 0; item.width = oz.width ?? 0; item.height = oz.height ?? 0;
          item.dimension_unit = oz.dimension_unit;
        }
        if (typeId > 0) item.type_id = typeId;
        if (catId  > 0) item.description_category_id = catId;
        if (st.name) item.name = st.name;
        if (st.vat) item.vat = st.vat;
        if (st.extraLoaded && st.description) item.description = st.description;
        await ozonApi.updateProduct(creds, item);
        if (st.barcode && st.barcode !== (prod.barcode ?? '') && prod.sku) {
          await ozonApi.updateBarcode(creds, prod.sku, st.barcode);
        }
        if (!st.priceLocked && st.price) {
          await ozonApi.updatePrices(creds, [{
            offer_id: article,
            price: st.price,
            old_price: st.old_price || st.price,
            min_price: st.min_price || st.price,
          }]);
          const entry = this.items.find(x => x.article.toLowerCase() === article.toLowerCase())
            ?.mp_entries.find(e => e.store_id === storeId);
          if (entry) entry.price = +st.price;
        }
        prod.weight_kg = st.weight_kg ? +st.weight_kg : prod.weight_kg;
        prod.length_cm = st.length_cm ? +st.length_cm : prod.length_cm;
        prod.width_cm  = st.width_cm  ? +st.width_cm  : prod.width_cm;
        prod.height_cm = st.height_cm ? +st.height_cm : prod.height_cm;
        if (st.name) prod.name = st.name;
        if (st.barcode) prod.barcode = st.barcode;

      } else if (mp === 'wb') {
        const store = this.wbStores.find((s: any) => s.id === storeId);
        const prod  = this.wbProds.find((x: any) => x.store_id === storeId &&
          String(x.vendor_code ?? x.nm_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Магазин или товар не найден');
        if (!prod.nm_id) throw new Error('Нет nmID — невозможно сохранить карточку WB');
        const wb = toWb(dims);
        // Only include non-null dims to avoid overwriting existing card data with zeros.
        const wbCardUpdate: Parameters<typeof wbApi.updateCard>[2] = {
          title: st.name || undefined,
          brand: st.brand || undefined,
          description: st.description || undefined,
        };
        if (wb.length != null || wb.width != null || wb.height != null) {
          wbCardUpdate.dimensions = {
            length: wb.length != null ? Math.round(wb.length) : 0,
            width:  wb.width  != null ? Math.round(wb.width)  : 0,
            height: wb.height != null ? Math.round(wb.height) : 0,
          };
        }
        if (wb.weight_kg != null) wbCardUpdate.weightBrutto = wb.weight_kg;
        await wbApi.updateCard(store.api_key, prod.nm_id, wbCardUpdate);
        if (!st.priceLocked && st.price) {
          const discount = st.discount ? Math.round(+st.discount) : 0;
          await updateWbPrices(store.api_key, [{ nmID: prod.nm_id, price: Math.round(+st.price), discount: discount || undefined }]);
          const entry = this.items.find(x => x.article.toLowerCase() === article.toLowerCase())
            ?.mp_entries.find(e => e.store_id === storeId);
          if (entry) {
            // WB entry.price = покупательская цена (со скидкой), entry.old_price = базовая
            const base = +st.price;
            if (discount > 0) {
              entry.old_price = base;
              entry.price = Math.round(base * (1 - discount / 100));
            } else {
              entry.price = base;
              entry.old_price = null;
            }
          }
        }
        prod.weight_kg = st.weight_kg ? +st.weight_kg : prod.weight_kg;
        prod.length_cm = st.length_cm ? +st.length_cm : prod.length_cm;
        prod.width_cm  = st.width_cm  ? +st.width_cm  : prod.width_cm;
        prod.height_cm = st.height_cm ? +st.height_cm : prod.height_cm;
        if (st.name) prod.title = st.name;
        if (st.brand) prod.brand = st.brand;
        if (st.discount) prod.discount = +st.discount;

      } else {
        const store = this.ymStores.find((s: any) => s.id === storeId);
        const prod  = this.ymProds.find((x: any) => x.store_id === storeId &&
          String(x.offer_id ?? x.vendor_code ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Магазин или товар не найден');
        const ym = toYm(dims);
        const offer: Record<string, unknown> = { offerId: article };
        // Only include weightDimensions if at least one value is filled.
        if (ym.length != null || ym.width != null || ym.height != null || ym.weight != null) {
          const wd: Record<string, number> = {};
          if (ym.length != null) wd.length = ym.length;
          if (ym.width  != null) wd.width  = ym.width;
          if (ym.height != null) wd.height = ym.height;
          if (ym.weight != null) wd.weight = ym.weight;
          offer.weightDimensions = wd;
        }
        if (st.name) offer.name = st.name;
        if (st.brand) offer.vendor = st.brand;
        if (st.description) offer.description = st.description;
        if (st.barcode) offer.barcodes = [st.barcode];
        if (st.vat) offer.tax = { vatType: st.vat };
        await yandexApi.updateOffer(store.api_key, store.business_id!, offer);
        // YM price is set at business level — all campaigns in the business share it.
        if (!st.priceLocked && st.price && store.business_id) {
          await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id ?? ''), [{ offerId: article, price: +st.price }]);
          // Update price in all YM entries that share this business
          const bid = store.business_id;
          this.items.find(x => x.article.toLowerCase() === article.toLowerCase())
            ?.mp_entries.filter(e => {
              const s = (this.ymStores as any[]).find(s => s.id === e.store_id);
              return e.mp === 'yandex' && s?.business_id === bid;
            })
            .forEach(e => { e.price = +st.price; });
        }
        prod.weight_kg = st.weight_kg ? +st.weight_kg : prod.weight_kg;
        prod.length_cm = st.length_cm ? +st.length_cm : prod.length_cm;
        prod.width_cm  = st.width_cm  ? +st.width_cm  : prod.width_cm;
        prod.height_cm = st.height_cm ? +st.height_cm : prod.height_cm;
        if (st.name) prod.name = st.name;
        if (st.brand) prod.vendor = st.brand;
      }

      // Update HubProduct dims from first non-null source
      const hub = this.items.find(x => x.article.toLowerCase() === article.toLowerCase());
      if (hub) {
        if (dims.weight_g)  hub.weight_kg = dims.weight_g / 1000;
        if (dims.length_mm) hub.length_cm = dims.length_mm / 10;
        if (dims.width_mm)  hub.width_cm  = dims.width_mm / 10;
        if (dims.height_mm) hub.height_cm = dims.height_mm / 10;
      }
      if (st.extraLoaded) {
        const ck = `${storeId}:${article}`;
        const extra = mp === 'ozon' ? { vat: st.vat } : { description: st.description };
        this.extraDataCache.set(ck, { ...this.extraDataCache.get(ck), ...extra });
      }
      st.saveOk = true;
      // Ozon processes imports asynchronously — changes appear on the marketplace in a few minutes.
      if (mp === 'ozon') {
        st.saveError = '✓ Принято — изменения появятся на Ozon через несколько минут';
        st.saveOk = false;
      }
    } catch (e: unknown) {
      st.saveError = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка сохранения';
    } finally {
      st.saving = false;
      this.refreshEditTab();
    }
  }

  // ─── Save photos ──────────────────────────────────────────────────

  private async doSavePhotos(article: string, storeId: string, mp: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    const st = this.editState.get(storeId);
    if (!st) return;
    st.saving = true; st.saveError = '';
    this.refreshPhotosTab2();

    try {
      const { uploadPhoto, isDataUrl } = await import('@/services/photoUpload');
      for (let i = 0; i < st.photos.length; i++) {
        if (!isDataUrl(st.photos[i])) continue;
        try {
          const blob = await (await fetch(st.photos[i])).blob();
          const file = new File([blob], `photo.${blob.type.split('/')[1] || 'jpg'}`, { type: blob.type });
          st.photos[i] = await uploadPhoto(file, article);
        } catch { /* остаётся data:URL */ }
      }
      const urls = st.photos.filter(u => u.startsWith('http'));
      const pendingLocal = st.photos.filter(isDataUrl);

      if (mp === 'ozon') {
        const store = this.ozStores.find((s: any) => s.id === storeId);
        const prod  = this.ozProds.find((x: any) => x.store_id === storeId && String(x.offer_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Магазин не найден');
        await ozonApi.updateProduct({ client_id: store.client_id, api_key: store.api_key }, { offer_id: article, images: urls });
        prod.images = urls;
      } else if (mp === 'wb') {
        const store = this.wbStores.find((s: any) => s.id === storeId);
        const prod  = this.wbProds.find((x: any) => x.store_id === storeId && String(x.vendor_code ?? x.nm_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod || !prod.nm_id) throw new Error('Нет nmID — невозможно сохранить фото WB');
        await wbApi.updateCard(store.api_key, prod.nm_id, { photos: urls });
        prod.pictures = urls;
      } else {
        const store = this.ymStores.find((s: any) => s.id === storeId);
        const prod  = this.ymProds.find((x: any) => x.store_id === storeId && String(x.offer_id ?? x.vendor_code ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Магазин не найден');
        await yandexApi.updateOffer(store.api_key, store.business_id!, { offerId: article, pictures: urls });
        // Photos are shared at business level — sync to all stores in same business
        const bid = store.business_id;
        const sameBizIds = (this.ymStores as any[]).filter(s => s.business_id === bid).map((s: any) => s.id);
        for (const sid of sameBizIds) {
          const otherProd = (this.ymProds as any[]).find(x => x.store_id === sid &&
            String(x.offer_id ?? x.vendor_code ?? '').trim().toLowerCase() === article.toLowerCase());
          if (otherProd) otherProd.pictures = urls;
          if (sid !== storeId) {
            const otherSt = this.editState.get(sid);
            if (otherSt) otherSt.photos = [...urls];
          }
          catalogCache.setPhotos(sid, article, urls);
        }
      }

      if (mp !== 'yandex') catalogCache.setPhotos(storeId, article, urls);
      st.photos = [...urls, ...pendingLocal];
      if (pendingLocal.length > 0) {
        st.saveError = `${pendingLocal.length} фото не удалось загрузить — попробуйте ещё раз`;
      }
    } catch (e: unknown) {
      st.saveError = (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? 'Ошибка сохранения фото';
    } finally {
      st.saving = false;
      this.refreshPhotosTab2();
    }
  }

  // ─── Extra data loader ────────────────────────────────────────────

  private async loadExtraDataForEdit(p: HubProduct): Promise<void> {
    const art = p.article;
    const pending: Promise<void>[] = [];

    for (const entry of p.mp_entries) {
      const st = this.editState.get(entry.store_id);
      if (!st || st.extraLoaded || st.extraLoading) continue;

      if (entry.mp === 'ozon') {
        // vat already from DB; only description requires API call
        const store = this.ozStores.find((s: any) => s.id === entry.store_id);
        const prod  = this.ozProds.find((x: any) => x.store_id === entry.store_id && String(x.offer_id ?? '').trim().toLowerCase() === art.toLowerCase());
        if (!store || !prod) continue;
        st.extraLoading = true;
        const creds = { client_id: store.client_id, api_key: store.api_key };
        pending.push((async () => {
          try {
            const desc = await ozonApi.getProductDescription(art, prod.product_id ?? null, creds);
            st.description = desc ?? '';
          } catch { /* leave default */ }
          finally { st.extraLoaded = true; st.extraLoading = false; }
        })());
        // WB and Yandex: extraLoaded=true set in initEditState; guard above skips them
      }
    }

    if (!pending.length) return;
    this.refreshEditTab();
    await Promise.all(pending);
    this.refreshEditTab();
  }

  // ─── Help ──────────────────────────────────────────────────────

  private showHelp(): void {
    const h = this.el.querySelector<HTMLElement>('#ph-help');
    if (h) { h.style.display = 'flex'; localStorage.setItem(HELP_KEY, '1'); }
  }
  private hideHelp(): void {
    const h = this.el.querySelector<HTMLElement>('#ph-help');
    if (h) h.style.display = 'none';
  }

  // ─── Multi-select ───────────────────────────────────────────────

  toggleCheck(article: string): void {
    if (this.selectedArticles.has(article)) {
      this.selectedArticles.delete(article);
    } else {
      this.selectedArticles.add(article);
    }
    this.renderListItems();
  }

  selectAll(): void {
    for (const p of this.filtered) this.selectedArticles.add(p.article);
    this.renderListItems();
  }

  clearSelection(): void {
    this.selectedArticles.clear();
    this.showOnlySelected = false;
    this.applyFilters();
    this.renderListItems();
  }

  private updateSelectionBar(): void {
    const bar = this.el.querySelector<HTMLElement>('#ph-selection-bar');
    const cnt = this.el.querySelector<HTMLElement>('#ph-sel-count');
    if (!bar) return;
    const n = this.selectedArticles.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    if (cnt) cnt.textContent = `${n} выбрано`;
    const hideBtn = this.el.querySelector<HTMLElement>('#ph-sel-hide');
    if (hideBtn) {
      hideBtn.innerHTML = this.showHidden
        ? `${I.eye('', 14)} Вернуть`
        : `${I.eyeOff('', 14)} Скрыть`;
    }
    const onlyBtn = this.el.querySelector<HTMLElement>('#ph-sel-only');
    if (onlyBtn) {
      onlyBtn.classList.toggle('active', this.showOnlySelected);
      onlyBtn.title = this.showOnlySelected ? 'Показать все товары' : 'Показать только выбранные';
    }
  }

  private toggleShowOnlySelected(): void {
    this.showOnlySelected = !this.showOnlySelected;
    this.applyFilters();
    this.renderList();
    this.updateSelectionBar();
  }

  // ─── Hide / unhide ──────────────────────────────────────────────

  private saveHiddenToStorage(): void {
    try { localStorage.setItem('ph_hidden_articles', JSON.stringify([...this.hiddenArticles])); } catch {}
  }

  private hideSelected(): void {
    if (this.showHidden) {
      // Restore
      for (const a of this.selectedArticles) this.hiddenArticles.delete(a);
      showToast(`Возвращено: ${this.selectedArticles.size}`, 'success');
    } else {
      for (const a of this.selectedArticles) this.hiddenArticles.add(a);
      showToast(`Скрыто: ${this.selectedArticles.size}`, 'success');
    }
    this.saveHiddenToStorage();
    this.selectedArticles.clear();
    this.updateHiddenTabLabel();
    this.applyFilters();
    this.renderList(true);
  }

  private updateHiddenTabLabel(): void {
    const label = this.el.querySelector<HTMLElement>('#ph-hidden-tab-label');
    if (!label) return;
    label.textContent = this.showHidden
      ? `← Все товары`
      : `Скрытые${this.hiddenArticles.size > 0 ? ` (${this.hiddenArticles.size})` : ''}`;
  }

  // ─── Export to Excel ────────────────────────────────────────────

  // helpers for raw-product lookup by article
  private rawOzProd(article: string): any { return this.ozProds.find((p: any) => String(p.offer_id ?? '').trim() === article); }
  private rawWbProd(article: string): any { return this.wbProds.find((p: any) => String(p.vendor_code ?? '').trim() === article); }
  private rawYmProd(article: string): any { return this.ymProds.find((p: any) => String(p.offer_id ?? p.vendor_code ?? '').trim() === article); }

  private exportSelected(): void {
    const products = this.selectedArticles.size > 0
      ? this.items.filter(p => this.selectedArticles.has(p.article))
      : this.filtered;
    if (!products.length) { showToast('Нет товаров для экспорта', 'error'); return; }

    try {
      const cfLabelSet = new Map<string, string>();
      for (const p of products) for (const cf of p.custom_fields) cfLabelSet.set(cf.id, cf.label);
      const cfIds = [...cfLabelSet.keys()];

      const header = [
        'Артикул', 'Название', 'Бренд', 'Категория', 'Штрихкод',
        'Себестоимость',
        'Вес кг', 'Длина см', 'Ширина см', 'Высота см',
        'Цена ВБ', 'Ст.цена ВБ', 'Остаток ВБ', 'Статус ВБ',
        'Описание ВБ', 'Фото ВБ',
        'Цена Озон', 'Ст.цена Озон', 'Остаток Озон', 'Статус Озон',
        'Описание Озон', 'Фото Озон',
        'Цена Яндекс', 'Ст.цена Яндекс', 'Остаток Яндекс', 'Статус Яндекс',
        'Описание Яндекс', 'Фото Яндекс',
        'Поставщик', 'Артикул поставщика',
        ...cfIds.map(id => cfLabelSet.get(id)!),
      ];

      const mpCols = (mp: Mp, raw: any) => {
        const entries = products[0].mp_entries; // placeholder — per-product below
        void entries;
        return (p: HubProduct) => {
          const ents = p.mp_entries.filter(e => e.mp === mp);
          const price  = ents[0]?.price ?? '';
          const old    = ents[0]?.old_price ?? '';
          const stock  = ents.reduce((s, e) => s + e.stock_total, 0);
          const status = ents[0]?.status ?? '';
          const r = mp === 'ozon'   ? this.rawOzProd(p.article)
                  : mp === 'wb'     ? this.rawWbProd(p.article)
                  :                   this.rawYmProd(p.article);
          void raw;
          const desc   = r?.description ?? '';
          const photos = ((r?.images ?? r?.pictures ?? []) as string[]).join(', ');
          return [price, old, stock || '', status, desc, photos];
        };
      };
      const wbCols  = mpCols('wb',     null);
      const ozCols  = mpCols('ozon',   null);
      const ymCols  = mpCols('yandex', null);

      const rows = products.map(p => {
        const cfVals = cfIds.map(id => p.custom_fields.find(c => c.id === id)?.value ?? '');
        return [
          p.article, p.name, p.brand ?? '', p.category ?? '', p.barcode ?? '',
          p.cost_price ?? '',
          p.weight_kg ?? '', p.length_cm ?? '', p.width_cm ?? '', p.height_cm ?? '',
          ...wbCols(p),
          ...ozCols(p),
          ...ymCols(p),
          p.supplier?.producer?.name ?? '',
          p.supplier?.product?.articles?.[0] ?? '',
          ...cfVals,
        ];
      });

      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      ws['!cols'] = header.map((h, i) => ({
        wch: Math.min(60, Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)) + 2),
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Товары');
      XLSX.writeFile(wb, `товары_${new Date().toISOString().slice(0, 10)}.xlsx`);
      showToast(`Экспортировано: ${products.length} товаров`, 'success');
    } catch (e: unknown) {
      showToast(`Ошибка экспорта: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e}`, 'error');
    }
  }

  // ─── Import from Excel ──────────────────────────────────────────

  /** Известные имена колонки «Артикул» — ищем любое из них. */
  private static readonly ARTICLE_ALIASES = [
    'Артикул', 'артикул', 'Article', 'article', 'SKU', 'sku',
    'Vendor Code', 'VendorCode', 'vendor_code', 'offer_id', 'OfferId',
  ];

  private async importFromExcel(files: FileList): Promise<void> {
    try {
      const buf = await files[0].arrayBuffer();
      const wb  = XLSX.read(buf, { type: 'array' });
      const ws  = wb.Sheets[wb.SheetNames[0]];

      // Читаем как массив строк чтобы найти заголовки
      const raw = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as any[][];
      if (raw.length < 2) { showToast('Файл пустой или не содержит данных', 'error'); return; }

      // Определяем строку с заголовками (первая непустая строка)
      const headerRow = raw[0].map((v: any) => String(v ?? '').trim());

      // Ищем колонку «Артикул» (по любому из псевдонимов)
      const articleColIdx = headerRow.findIndex(h =>
        ProductsHubModule.ARTICLE_ALIASES.some(a => a.toLowerCase() === h.toLowerCase())
      );
      if (articleColIdx < 0) {
        showToast(
          `Не найдена колонка «Артикул» в файле. Обнаруженные колонки: ${headerRow.slice(0,8).join(', ')}`,
          'error',
        );
        return;
      }

      // Проверка на соответствие шаблону SimaDesk
      const knownCols = [
        'Артикул', 'Название', 'Бренд', 'Категория', 'Штрихкод', 'Себестоимость',
        'Вес кг', 'Цена ВБ', 'Цена Озон', 'Цена Яндекс',
      ];
      const matchedKnown = knownCols.filter(k => headerRow.some(h => h === k));
      if (matchedKnown.length < 2) {
        showToast(
          `Файл не соответствует шаблону SimaDesk. Найдены колонки: ${headerRow.slice(0,6).join(', ')}. Используй экспорт из раздела «Товары».`,
          'error',
        );
        return;
      }

      // Строим индекс col name → index
      const colIdx = new Map<string, number>();
      headerRow.forEach((h, i) => colIdx.set(h, i));

      const col  = (row: any[], key: string) => String(row[colIdx.get(key) ?? -1] ?? '').trim();
      const numC = (row: any[], key: string) => { const v = parseFloat(col(row, key).replace(',','.')); return isNaN(v) ? null : v; };
      const strC = (row: any[], key: string) => { const v = col(row, key); return v || null; };

      const dataRows = raw.slice(1).filter(r => r.some((c: any) => c !== '' && c != null));
      if (!dataRows.length) { showToast('В файле нет строк с данными', 'error'); return; }

      let updated = 0;
      let skipped = 0;
      const notFound: string[] = [];
      const syncTasks: Array<() => Promise<void>> = [];

      for (const row of dataRows) {
        const article = String(row[articleColIdx] ?? '').trim();
        if (!article) { skipped++; continue; }

        const p = this.items.find(x => x.article === article);
        if (!p) { notFound.push(article); continue; }

        // Себестоимость
        const cost = numC(row, 'Себестоимость');
        if (cost !== null && cost !== p.cost_price) {
          try { costPriceDb.set(article, cost); } catch {}
          p.cost_price = cost; p.has_cost = true;
        }

        // Общие поля
        const newName   = strC(row, 'Название');
        const newBrand  = strC(row, 'Бренд');
        const newBarcode = strC(row, 'Штрихкод');
        if (newName)    p.name    = newName;
        if (newBrand)   p.brand   = newBrand;
        if (newBarcode) p.barcode = newBarcode;

        // Габариты
        const wkg = numC(row, 'Вес кг');
        const lcm = numC(row, 'Длина см');
        const wcm = numC(row, 'Ширина см');
        const hcm = numC(row, 'Высота см');
        if (wkg !== null) p.weight_kg = wkg;
        if (lcm !== null) p.length_cm = lcm;
        if (wcm !== null) p.width_cm  = wcm;
        if (hcm !== null) p.height_cm = hcm;

        // Цены + описания → синхронизируем с МП
        const patchMp = (mp: Mp, priceKey: string, descKey: string) => {
          const entry = p.mp_entries.find(e => e.mp === mp);
          if (!entry) return;
          const stores: any[] = mp === 'ozon' ? this.ozStores : mp === 'wb' ? this.wbStores : this.ymStores;
          const store = stores.find((s: any) => s.name === entry.store_name);
          if (!store) return;
          const storeId: string = store.id;
          const st = this.editState.get(storeId);
          if (!st) return;
          let dirty = false;
          const np = numC(row, priceKey);
          if (np !== null && String(np) !== st.price) { st.price = String(np); entry.price = np; dirty = true; }
          const nd = strC(row, descKey);
          if (nd && nd !== st.description) { st.description = nd; dirty = true; }
          if (newName   && newName   !== st.name)  { st.name  = newName;   dirty = true; }
          if (newBrand  && newBrand  !== st.brand) { st.brand = newBrand;  dirty = true; }
          if (wkg !== null) { st.weight_kg = String(wkg); dirty = true; }
          if (lcm !== null) { st.length_cm = String(lcm); dirty = true; }
          if (wcm !== null) { st.width_cm  = String(wcm); dirty = true; }
          if (hcm !== null) { st.height_cm = String(hcm); dirty = true; }
          if (dirty) {
            this.editState.set(storeId, st);
            syncTasks.push(() => this.doSaveCard(article, storeId, mp).catch(() => {}));
          }
        };
        patchMp('wb',     'Цена ВБ',     'Описание ВБ');
        patchMp('ozon',   'Цена Озон',   'Описание Озон');
        patchMp('yandex', 'Цена Яндекс', 'Описание Яндекс');

        // Кастомные поля
        for (const cf of p.custom_fields) {
          const val = strC(row, cf.label);
          if (val !== null && val !== String(cf.value ?? '')) {
            try { customColumnsDb.setValue(article, cf.id, val); } catch {}
            cf.value = val;
          }
        }
        updated++;
      }

      this.applyFilters();
      this.renderList();
      if (this.selectedArticle) {
        const pp = this.items.find(x => x.article === this.selectedArticle);
        if (pp) this.renderCard(pp);
      }

      const parts = [`Обновлено: ${updated}`];
      if (notFound.length) parts.push(`не найдено: ${notFound.slice(0, 3).join(', ')}${notFound.length > 3 ? ` +${notFound.length-3}` : ''}`);
      if (skipped)         parts.push(`пропущено пустых: ${skipped}`);
      showToast(parts.join(' · '), 'success');

      if (syncTasks.length) {
        showToast(`Синхронизируем с маркетплейсами (${syncTasks.length} запросов)…`, 'info');
        for (const t of syncTasks) await t();
        showToast('Синхронизация завершена', 'success');
      }
    } catch (e: unknown) {
      showToast(`Ошибка импорта: ${(e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e}`, 'error');
    }
  }

  // ─── Bulk edit modal ────────────────────────────────────────────

  private showBulkEditModal(): void {
    const products = this.selectedArticles.size > 0
      ? this.items.filter(p => this.selectedArticles.has(p.article))
      : [];
    if (!products.length) { showToast('Выбери хотя бы один товар', 'info'); return; }

    const existing = this.el.querySelector('#ph-bulk-modal-bg');
    if (existing) existing.remove();

    const cfLabelSet = new Map<string, string>();
    for (const p of products) for (const cf of p.custom_fields) cfLabelSet.set(cf.id, cf.label);
    const cfIds = [...cfLabelSet.keys()];

    const priceOf = (p: HubProduct, mp: Mp) => String(p.mp_entries.find(x => x.mp === mp)?.price ?? '');
    const descOf  = (p: HubProduct, mp: Mp) => {
      const r = mp === 'ozon' ? this.rawOzProd(p.article) : mp === 'wb' ? this.rawWbProd(p.article) : this.rawYmProd(p.article);
      return r?.description ?? '';
    };
    const photosOf = (p: HubProduct, mp: Mp) => {
      const e = p.mp_entries.find(x => x.mp === mp);
      return e?.images ?? [];
    };

    const thead = `<tr>
      <th>Артикул</th>
      <th>Название</th><th>Бренд</th><th>Штрихкод</th><th>Себестоимость</th>
      <th>Вес кг</th><th>Длина</th><th>Ширина</th><th>Высота</th>
      <th>Цена ВБ</th><th>Описание ВБ</th><th>Фото ВБ</th>
      <th>Цена Озон</th><th>Описание Озон</th><th>Фото Озон</th>
      <th>Цена Яндекс</th><th>Описание Яндекс</th><th>Фото Яндекс</th>
      ${cfIds.map(id => `<th>${esc(cfLabelSet.get(id)!)}</th>`).join('')}
    </tr>`;

    const inp = (article: string, field: string, value: string, type = 'text', wide = false) =>
      `<input class="ph-bulk-input${wide ? ' wide' : ''}" ${type !== 'text' ? `type="${type}"` : ''} data-article="${esc(article)}" data-field="${esc(field)}" value="${esc(value)}" />`;

    const photoCell = (p: HubProduct, mp: Mp) => {
      const photos = photosOf(p, mp);
      const thumbs = photos.slice(0, 3).map(u => `<img src="${esc(u)}" class="ph-bulk-thumb" onerror="this.style.display='none'">`).join('');
      const extra  = photos.length > 3 ? `<span class="ph-bulk-photo-more">+${photos.length - 3}</span>` : '';
      return `<td class="ph-bulk-photo-cell">
        ${thumbs}${extra}
        <button class="ph-bulk-photo-btn" onclick="window.productsHubModule?.selectProduct('${esc(p.article).replace(/'/g,'&#39;')}');document.getElementById('ph-bulk-modal-bg')?.remove()">Изменить</button>
      </td>`;
    };

    const tableRows = products.map(p => {
      const cfCells = cfIds.map(id =>
        `<td>${inp(p.article, `cf:${id}`, String(p.custom_fields.find(c => c.id === id)?.value ?? ''))}</td>`
      ).join('');
      return `<tr>
        <td class="ph-bulk-art">${esc(p.article)}</td>
        <td>${inp(p.article, 'name',       p.name,              'text', true)}</td>
        <td>${inp(p.article, 'brand',      p.brand ?? '')}</td>
        <td>${inp(p.article, 'barcode',    p.barcode ?? '')}</td>
        <td>${inp(p.article, 'cost',       String(p.cost_price ?? ''), 'number')}</td>
        <td>${inp(p.article, 'weight_kg',  String(p.weight_kg ?? ''),  'number')}</td>
        <td>${inp(p.article, 'length_cm',  String(p.length_cm ?? ''),  'number')}</td>
        <td>${inp(p.article, 'width_cm',   String(p.width_cm ?? ''),   'number')}</td>
        <td>${inp(p.article, 'height_cm',  String(p.height_cm ?? ''),  'number')}</td>
        <td>${inp(p.article, 'price:wb',   priceOf(p,'wb'),   'number')}</td>
        <td>${inp(p.article, 'desc:wb',    descOf(p,'wb'),    'text', true)}</td>
        ${photoCell(p, 'wb')}
        <td>${inp(p.article, 'price:ozon', priceOf(p,'ozon'), 'number')}</td>
        <td>${inp(p.article, 'desc:ozon',  descOf(p,'ozon'),  'text', true)}</td>
        ${photoCell(p, 'ozon')}
        <td>${inp(p.article, 'price:yandex', priceOf(p,'yandex'), 'number')}</td>
        <td>${inp(p.article, 'desc:yandex',  descOf(p,'yandex'),  'text', true)}</td>
        ${photoCell(p, 'yandex')}
        ${cfCells}
      </tr>`;
    }).join('');

    const modal = document.createElement('div');
    modal.id = 'ph-bulk-modal-bg';
    modal.className = 'ph-bulk-modal-bg';
    modal.innerHTML = `
      <div class="ph-bulk-modal">
        <div class="ph-bulk-modal-head">
          <span>Редактировать: ${products.length} товаров</span>
          <button class="ph-bulk-close" id="ph-bulk-close">✕</button>
        </div>
        <div class="ph-bulk-table-wrap">
          <table class="ph-bulk-table"><thead>${thead}</thead><tbody>${tableRows}</tbody></table>
        </div>
        <div class="ph-bulk-modal-foot">
          <span class="ph-bulk-note">Цены и описания синхронизируются с маркетплейсами. Фото — через карточку товара.</span>
          <button class="ph-action secondary" id="ph-bulk-cancel">Отмена</button>
          <button class="ph-action primary" id="ph-bulk-save">Сохранить и синхронизировать</button>
        </div>
      </div>`;
    this.el.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#ph-bulk-close')?.addEventListener('click', close);
    modal.querySelector('#ph-bulk-cancel')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    modal.querySelector('#ph-bulk-save')?.addEventListener('click', async () => {
      const saveBtn = modal.querySelector<HTMLButtonElement>('#ph-bulk-save')!;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохраняем…';

      const inputs = modal.querySelectorAll<HTMLInputElement>('.ph-bulk-input');
      const changes: Record<string, Record<string, string>> = {};
      for (const inp2 of inputs) {
        const art = inp2.dataset.article!;
        const field = inp2.dataset.field!;
        if (!changes[art]) changes[art] = {};
        changes[art][field] = inp2.value.trim();
      }

      let saved = 0;
      const syncTasks: Array<() => Promise<void>> = [];

      for (const [article, fields] of Object.entries(changes)) {
        const p = this.items.find(x => x.article === article);
        if (!p) continue;

        const n = (k: string) => { const v = parseFloat(fields[k]?.replace(',','.')); return isNaN(v) ? null : v; };

        if (fields.name)     p.name    = fields.name;
        if (fields.brand)    p.brand   = fields.brand;
        if (fields.barcode)  p.barcode = fields.barcode;
        if (n('cost') !== null) { try { costPriceDb.set(article, n('cost')!); } catch {} p.cost_price = n('cost'); p.has_cost = true; }
        if (n('weight_kg') !== null) p.weight_kg = n('weight_kg');
        if (n('length_cm') !== null) p.length_cm = n('length_cm');
        if (n('width_cm')  !== null) p.width_cm  = n('width_cm');
        if (n('height_cm') !== null) p.height_cm = n('height_cm');

        // Sync price + description per MP
        for (const mp of ['wb','ozon','yandex'] as Mp[]) {
          const entry = p.mp_entries.find(e => e.mp === mp);
          if (!entry) continue;
          const stores: any[] = mp === 'ozon' ? this.ozStores : mp === 'wb' ? this.wbStores : this.ymStores;
          const store = stores.find((s: any) => s.name === entry.store_name);
          if (!store) continue;
          const storeId: string = store.id;
          let st = this.editState.get(storeId);
          if (!st) continue;
          let dirty = false;
          const np = n(`price:${mp}`);
          if (np !== null && String(np) !== st.price) { st.price = String(np); entry.price = np; dirty = true; }
          const desc = fields[`desc:${mp}`];
          if (desc !== undefined && desc !== st.description) { st.description = desc; dirty = true; }
          if (fields.name && fields.name !== st.name) { st.name = fields.name; dirty = true; }
          if (fields.brand && fields.brand !== st.brand) { st.brand = fields.brand; dirty = true; }
          if (n('weight_kg') !== null) { st.weight_kg = String(n('weight_kg')!); dirty = true; }
          if (n('length_cm') !== null) { st.length_cm = String(n('length_cm')!); dirty = true; }
          if (n('width_cm')  !== null) { st.width_cm  = String(n('width_cm')!);  dirty = true; }
          if (n('height_cm') !== null) { st.height_cm = String(n('height_cm')!); dirty = true; }
          if (dirty) {
            this.editState.set(storeId, st);
            syncTasks.push(() => this.doSaveCard(article, storeId, mp).catch(() => {}));
          }
        }

        for (const [field, val] of Object.entries(fields)) {
          if (!field.startsWith('cf:')) continue;
          const cfId = field.slice(3);
          try { customColumnsDb.setValue(article, cfId, val); } catch {}
          const cf = p.custom_fields.find(c => c.id === cfId);
          if (cf) cf.value = val;
        }
        saved++;
      }

      for (const t of syncTasks) await t();

      close();
      this.applyFilters();
      this.renderList();
      if (this.selectedArticle) {
        const pp = this.items.find(x => x.article === this.selectedArticle);
        if (pp) this.renderCard(pp);
      }
      showToast(`Сохранено: ${saved} товаров${syncTasks.length ? `, синхронизировано с МП` : ''}`, 'success');
    });
  }

  // ─── Public AI methods (called from aiPageCapabilities) ─────────────────────

  /** Returns a compact text summary of selected (or all) products for SIMA context. */
  getAiSelectedContext(): string {
    const selected = this.selectedArticles.size > 0
      ? this.items.filter(p => this.selectedArticles.has(p.article))
      : [];
    if (!selected.length) return '';
    const MP_NAMES: Record<string, string> = { wb: 'ВБ', ozon: 'Озон', yandex: 'Яндекс' };
    return selected.map(p => {
      const prices = p.mp_entries
        .filter(e => e.price != null)
        .map(e => `${MP_NAMES[e.mp] ?? e.mp} ${e.price}₽ (${e.store_name})`)
        .join(', ');
      const stocks = p.mp_entries
        .filter(e => e.stock_total > 0)
        .map(e => `${MP_NAMES[e.mp] ?? e.mp} ${e.stock_total}шт`)
        .join(', ');
      return `• ${p.article} «${p.name}»${prices ? ' | цена: ' + prices : ' | цена: не указана'}${stocks ? ' | остаток: ' + stocks : ''}`;
    }).join('\n');
  }

  /** Set price for a specific article on a specific marketplace. Called by SIMA. */
  async aiSetPrice(a: { article: string; mp: string; price: number; store?: string }): Promise<string> {
    const { article, mp, price, store: storeName } = a;
    const p = this.items.find(x => x.article.toLowerCase() === article.toLowerCase()
      || x.article.toLowerCase().includes(article.toLowerCase()));
    if (!p) throw new Error(`Товар с артикулом «${article}» не найден`);
    const normMp = mp.toLowerCase().replace('яндекс', 'yandex').replace('wildberries', 'wb').replace('вб', 'wb').replace('озон', 'ozon');
    const entries = p.mp_entries.filter(e => e.mp === normMp);
    if (!entries.length) throw new Error(`Товар «${p.article}» не представлен на маркетплейсе ${mp}`);
    if (entries.length > 1 && !storeName) {
      const names = entries.map(e => e.store_name).join(', ');
      throw new Error(`Товар «${p.article}» есть в нескольких магазинах: ${names}. Уточни в каком именно.`);
    }
    const entry = storeName
      ? entries.find(e => e.store_name.toLowerCase().includes(storeName.toLowerCase())) ?? entries[0]
      : entries[0];
    if (!this.editState.has(entry.store_id)) this.initEditState(p);
    const st = this.editState.get(entry.store_id);
    if (!st) throw new Error('Не удалось получить данные магазина');
    const oldPrice = entry.price;
    st.price = String(price);
    this.editState.set(entry.store_id, st);
    entry.price = price;
    await this.doSaveCard(p.article, entry.store_id, normMp as any);
    this.renderList();
    if (this.selectedArticle === p.article) this.renderCard(p);
    return `Цена на «${p.article}» в ${entry.store_name} (${mp}) изменена: ${oldPrice ?? '?'}₽ → ${price}₽`;
  }

  /** Apply price delta (absolute or %) to selected (or specified) articles on a marketplace. Called by SIMA. */
  async aiApplyPriceDelta(a: { mp: string; delta: number; percent?: boolean; articles?: string[] }): Promise<string> {
    const { delta, percent, articles: artList } = a;
    const normMp = a.mp.toLowerCase().replace('яндекс', 'yandex').replace('wildberries', 'wb').replace('вб', 'wb').replace('озон', 'ozon');
    const targets = artList?.length
      ? this.items.filter(p => artList.some(a2 => p.article.toLowerCase().includes(a2.toLowerCase())))
      : this.selectedArticles.size > 0
        ? this.items.filter(p => this.selectedArticles.has(p.article))
        : [];
    if (!targets.length) throw new Error('Нет выбранных товаров. Выдели товары в списке или передай список артикулов.');
    let changed = 0;
    const syncTasks: Array<() => Promise<void>> = [];
    for (const p of targets) {
      const entries = p.mp_entries.filter(e => e.mp === normMp && e.price != null);
      for (const entry of entries) {
        if (!this.editState.has(entry.store_id)) this.initEditState(p);
        const st = this.editState.get(entry.store_id);
        if (!st) continue;
        const newPrice = percent
          ? Math.round(entry.price! * (1 + delta / 100))
          : Math.round(entry.price! + delta);
        if (newPrice <= 0) continue;
        st.price = String(newPrice);
        entry.price = newPrice;
        this.editState.set(entry.store_id, st);
        syncTasks.push(() => this.doSaveCard(p.article, entry.store_id, normMp as any).catch(() => {}));
        changed++;
      }
    }
    for (const t of syncTasks) await t();
    this.renderList();
    return `Изменено цен: ${changed} в ${targets.length} товарах на ${a.mp}. Дельта: ${percent ? delta + '%' : delta + '₽'}`;
  }
}
