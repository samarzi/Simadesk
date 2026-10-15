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
import { toWb, toYm, type Dimensions } from '@/services/dimensionsUnit';
import { boxes } from '@/stores/appStore';
import { RULE_LABELS, type RepricerRule } from '@/modules/repricer/types';
import { debug } from '@/utils/debug';
import { dbFetch } from '@/services/dbClient';

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
  store_id: string;       // '' = all stores
  no_cost: boolean;
  no_mp: boolean;
  no_repricer: boolean;
  status: string;         // '' | 'В продаже' | 'Нет в наличии' | 'В архиве'
  stock: 'any' | 'zero' | 'pos';
  price_min: number | null;
  price_max: number | null;
}

type Tab = 'overview' | 'finance' | 'card-edit' | 'photos';

/** Строка серверной сводки продаж (rpc product_sales_summary). */
interface SalesRow {
  store_id: string; marketplace: Mp; sku: string;
  sold: number; returned: number; revenue: number; commission: number; payout: number;
}

/** Итоги товара за период — одна формула для таблицы, карточки и сортировки. */
interface Totals {
  sold: number; returned: number; netUnits: number;
  revenue: number;
  /** Комиссия маркетплейса (положительное = удержание). */
  commission: number;
  /** Логистика, эквайринг и прочие услуги (положительное = удержание). */
  otherFees: number;
  /** Перечислено маркетплейсом: выручка − все удержания. */
  payout: number;
  /** Себестоимость проданных штук; null — не задана. */
  cogs: number | null;
  /** Прибыль = перечислено − себестоимость. null — без себестоимости не считается. */
  profit: number | null;
  margin: number | null;
  stock: number;
  minPrice: number | null; maxPrice: number | null; avgPrice: number | null;
}

type SortKey = 'article' | 'name' | 'price' | 'stock' | 'sold' | 'revenue' | 'fees' | 'cost' | 'profit' | 'margin';

interface EditState {
  mp: 'ozon' | 'wb' | 'yandex';
  name: string; brand: string; barcode: string; description: string; vat: string;
  price: string; old_price: string; min_price: string; discount: string;
  weight_kg: string; length_cm: string; width_cm: string; height_cm: string;
  photos: string[];
  priceLocked: boolean;
  saving: boolean; saveError: string; saveOk: boolean;
  /** Пояснение после сохранения (например, «Ozon ещё обрабатывает»). */
  saveNote: string;
  extraLoaded: boolean; extraLoading: boolean;
  dirtyFields: Set<string>;
}
type PeriodDays = 7 | 30 | 90 | 180;

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const ROW_H     = 60;
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
function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  return b === 1 ? forms[0] : forms[2];
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
  private filters: Filters = { q: '', mp: '', store_id: '', no_cost: false, no_mp: false, no_repricer: false, status: '', stock: 'any', price_min: null, price_max: null };
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
  /** Серверная сводка продаж за период; null — запасной режим (операции на клиенте). */
  private salesRows: SalesRow[] | null = null;
  private allStoreIds: string[] = [];
  // ── Editor UX state
  private collapsedStores = new Set<string>();

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
  // lockedByMp: article (lowercase) → Set of MPs where repricer is active
  private lockedByMp = new Map<string, Set<Mp>>();
  private storeSyncedAt = new Map<string, string>(); // storeId → synced_at from Supabase
  /** Когда товары магазина последний раз приходили из API (max synced_at строк каталога). */
  private productSyncAt = new Map<string, number>();
  private autoSyncing = false;
  private static readonly AUTO_SYNC_MS = 3 * 3600 * 1000;
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

  private readonly onCtrlS = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return;
    if (this.activeTab !== 'card-edit' || !this.selectedArticle) return;
    e.preventDefault();
    this.saveAllDirty();
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
      this.load().then(() => this.autoSyncStale());
      if (!localStorage.getItem(HELP_KEY)) this.showHelp();
    } else {
      this.applyFilters();
      this.renderList();
      this.autoSyncStale();
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
    this.el.className = 'ph-root ph2';
    this.el.style.position = 'relative';
    this.el.innerHTML = `
      <div class="ph2-head">
        <div class="ph2-filters">
          <h2 class="ph2-title">Товары</h2>
          <div class="ph-search">
            <span class="ph-search-icon">${I.search('', 14)}</span>
            <input id="ph-search" placeholder="Артикул или название" autocomplete="off">
          </div>
          <div class="ph2-segs" id="ph2-mp"></div>
          <select id="ph2-store" class="ph-select" title="Магазин" style="display:none"></select>
          <select id="ph-period" class="ph-select" title="Период для продаж и прибыли">
            ${PERIOD_OPTIONS.map(o => `<option value="${o.value}"${this.period === o.value ? ' selected' : ''}>Продажи за ${o.label}</option>`).join('')}
          </select>
          <span class="ph2-grow"></span>
          <span id="ph-count" class="ph-count"></span>
          <button id="ph-filters-btn" class="ph2-btn" title="Статус, цена, репрайсер">
            ${I.filter('', 13)} Фильтры <span id="ph-filters-badge" class="ph-filters-badge" style="display:none">0</span>
          </button>
          <button id="ph-import-btn" class="ph2-icon" title="Импорт из Excel-шаблона">${I.upload('', 14)}</button>
          <input  id="ph-import-input" type="file" accept=".xlsx" style="display:none">
          <button id="ph-hidden-tab" class="ph2-btn" title="Показать скрытые товары">${I.eyeOff('', 13)} <span id="ph-hidden-tab-label">Скрытые</span></button>
          <button id="ph-help-btn" class="ph2-icon" title="Как пользоваться">${I.help('', 15)}</button>
          <button id="ph-reload"   class="ph2-icon" title="Обновить">${I.refresh('', 15)}</button>
        </div>
        <div class="ph2-quick" id="ph2-quick"></div>
      </div>

      <div id="ph-filter-panel" class="ph-filter-panel" style="display:none"></div>

      <div class="ph2-table">
        <div class="ph2-thead" id="ph2-thead"></div>
        <div id="ph-list" class="ph-list ph2-body">
          <div id="ph-spacer" style="width:1px;pointer-events:none"></div>
          <div id="ph-items" style="position:absolute;top:0;left:0;right:0"></div>
        </div>
        <div class="ph2-tfoot sd-island" id="ph2-tfoot" role="status" aria-label="Итого по выбранным товарам"></div>
      </div>

      <div class="ph2-drawer-bg" id="ph2-drawer-bg" style="display:none"></div>
      <aside class="ph2-drawer" id="ph2-drawer" style="display:none" aria-label="Карточка товара">
        <button class="ph2-drawer-close" id="ph2-drawer-close" title="Закрыть (Esc)">✕</button>
        <div id="ph-card" class="ph-card ph2-card"></div>
      </aside>

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
          <div class="ph-help-title">Раздел «Товары»</div>
          <div class="ph-help-body">
            <div><b>Таблица</b> — все товары из ваших магазинов. Сортировка — клик по заголовку колонки. Клик по строке открывает карточку товара справа.</div>
            <div><b>Продажи и деньги</b> — по финансовым отчётам маркетплейсов за выбранный период. <b>Удержания</b> — комиссия, логистика, эквайринг и прочие услуги. <b>Прибыль</b> = перечислено маркетплейсом − себестоимость проданных штук (до налогов, рекламы и общих расходов — полный расчёт в «Аналитике»).</div>
            <div><b>Себестоимость</b> можно ввести прямо в таблице — кликните по ячейке.</div>
            <div><b>Быстрые фильтры</b> под строкой поиска показывают проблемные товары: без себестоимости, без остатка, без продаж.</div>
            <button class="ph-action primary" id="ph-help-ok" style="margin-top:8px;align-self:flex-start">Понятно</button>
          </div>
        </div>
      </div>
    `;

    this.listEl = this.el.querySelector('#ph-list')!;
    this.cardEl = this.el.querySelector('#ph-card')!;
    this.bindEvents();
    this.bindTable();
  }

  // ─── Итоги товара — единая формула ───────────────────────────────

  /** Записи товара с учётом выбранной площадки и магазина. */
  private scopedEntries(p: HubProduct): MpStoreEntry[] {
    return p.mp_entries.filter(e =>
      (!this.filters.mp || e.mp === this.filters.mp) && (!this.filters.store_id || e.store_id === this.filters.store_id));
  }

  private totals(p: HubProduct, entries = this.scopedEntries(p)): Totals {
    let sold = 0, returned = 0, revenue = 0, commission = 0, payout = 0, stock = 0;
    for (const e of entries) {
      sold += e.sales_qty; returned += e.returns_qty; revenue += e.sales_revenue;
      commission += -e.commission; payout += e.net_profit; stock += e.stock_total || 0;
    }
    const otherFees = revenue - commission - payout;
    const netUnits = Math.max(0, sold - returned);
    const cogs = p.cost_price != null ? p.cost_price * netUnits : null;
    const profit = cogs != null ? payout - cogs : null;
    const prices = entries.map(e => e.price).filter((x): x is number => x != null && x > 0);
    return {
      sold, returned, netUnits, revenue, commission, otherFees, payout, cogs, profit,
      margin: profit != null && revenue > 0 ? profit / revenue * 100 : null,
      stock,
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    };
  }

  // ─── Таблица ──────────────────────────────────────────────────────

  private sortKey: SortKey = 'revenue';
  private sortDir: 1 | -1 = -1;
  private totalsCache = new Map<string, Totals>();

  private static readonly COLS: Array<{ key: SortKey | null; label: string; cls: string; title?: string }> = [
    { key: null, label: '', cls: 'c-check' },
    { key: 'name', label: 'Товар', cls: 'c-prod' },
    { key: null, label: 'Площадки', cls: 'c-mps' },
    { key: 'price', label: 'Цена', cls: 'c-num' },
    { key: 'stock', label: 'Остаток', cls: 'c-num' },
    { key: 'sold', label: 'Продано', cls: 'c-num', title: 'Продано и возвращено за период, шт' },
    { key: 'revenue', label: 'Выручка', cls: 'c-num' },
    { key: 'fees', label: 'Удержания', cls: 'c-num', title: 'Комиссия, логистика, эквайринг и прочие услуги маркетплейса' },
    { key: 'cost', label: 'Себест./шт', cls: 'c-num', title: 'Себестоимость единицы — кликните, чтобы изменить' },
    { key: 'profit', label: 'Прибыль', cls: 'c-num', title: 'Перечислено маркетплейсом − себестоимость проданных штук' },
    { key: 'margin', label: 'Маржа', cls: 'c-num', title: 'Прибыль ÷ выручка' },
  ];

  private renderTableHead(): void {
    const head = this.el.querySelector<HTMLElement>('#ph2-thead');
    if (!head) return;
    const allOn = this.filtered.length > 0 && this.filtered.every(p => this.selectedArticles.has(p.article));
    head.innerHTML = `<div class="ph2-tr">${ProductsHubModule.COLS.map(c => {
      if (c.cls === 'c-check') {
        return `<div class="ph2-td c-check"><span class="ph-checkbox${allOn ? ' on' : ''}" data-ph2="check-all" title="Отметить все"></span></div>`;
      }
      const on = c.key && this.sortKey === c.key;
      return `<div class="ph2-td ${c.cls}${c.key ? ' sortable' : ''}${on ? ' on' : ''}" ${c.key ? `data-sort="${c.key}"` : ''} ${c.title ? `title="${esc(c.title)}"` : ''}>
        ${c.label}${on ? (this.sortDir < 0 ? ' ↓' : ' ↑') : ''}</div>`;
    }).join('')}</div>`;
  }

  private renderTableFoot(): void {
    const foot = this.el.querySelector<HTMLElement>('#ph2-tfoot');
    if (!foot) return;
    let sold = 0, returned = 0, revenue = 0, fees = 0, profit = 0, stock = 0, withProfit = 0;
    for (const p of this.filtered) {
      const t = this.totalsOf(p);
      sold += t.sold; returned += t.returned; revenue += t.revenue; fees += t.commission + t.otherFees; stock += t.stock;
      if (t.profit != null) { profit += t.profit; withProfit++; }
    }
    const missing = this.filtered.length - withProfit;
    const stat = (label: string, value: string, cls = '', title = '') =>
      `<div class="ph2-isl-stat ${cls}"${title ? ` title="${esc(title)}"` : ''}><span>${label}</span><b>${value}</b></div>`;
    foot.innerHTML = `
      <div class="ph2-isl-stat ph2-isl-head"><span>Итого</span><b>${num(this.filtered.length)} ${plural(this.filtered.length, ['товар', 'товара', 'товаров'])}</b></div>
      <span class="sd-island-sep"></span>
      ${stat('Остаток', num(stock))}
      ${stat('Продано', `${num(sold)}${returned ? `<small> / −${num(returned)}</small>` : ''}`, '', returned ? `Возвращено ${num(returned)} шт` : '')}
      ${stat('Выручка', pr(revenue))}
      ${stat('Удержания', pr(fees))}
      ${stat('Прибыль', `${pr(profit)}${missing ? '<small>*</small>' : ''}`, profit >= 0 ? 'pos' : 'neg', missing ? `Без ${missing} ${plural(missing, ['товара', 'товаров', 'товаров'])} без себестоимости` : '')}
      ${stat('Маржа', revenue > 0 ? `${(profit / revenue * 100).toFixed(1).replace('.', ',')}%` : '—')}`;
  }

  private totalsOf(p: HubProduct): Totals {
    let t = this.totalsCache.get(p.article);
    if (!t) { t = this.totals(p); this.totalsCache.set(p.article, t); }
    return t;
  }

  private renderMpSegs(): void {
    const box = this.el.querySelector<HTMLElement>('#ph2-mp');
    if (!box) return;
    const mps = (['ozon', 'wb', 'yandex'] as Mp[]).filter(m => this.items.some(p => p.mp_entries.some(e => e.mp === m)));
    if (mps.length < 2) { box.style.display = 'none'; return; }
    box.style.display = '';
    const btn = (v: '' | Mp, label: string) => `<button class="ph2-seg${this.filters.mp === v ? ' on' : ''}" data-ph2-mp="${v}">${v ? `<span class="ph2-dot mp-${v}"></span>` : ''}${label}</button>`;
    box.innerHTML = btn('', 'Все') + mps.map(m => btn(m, MP_FULL[m] === 'Яндекс Маркет' ? 'ЯМ' : MP_FULL[m] === 'Wildberries' ? 'WB' : 'Ozon')).join('');
    const sel = this.el.querySelector<HTMLSelectElement>('#ph2-store');
    if (sel) {
      const stores = new Map<string, string>();
      for (const p of this.items) for (const e of p.mp_entries) if (!this.filters.mp || e.mp === this.filters.mp) stores.set(e.store_id, e.store_name);
      if (stores.size > 1) {
        sel.style.display = '';
        sel.innerHTML = `<option value="">Все магазины</option>${[...stores].sort((a, b) => a[1].localeCompare(b[1], 'ru'))
          .map(([id, n]) => `<option value="${esc(id)}"${this.filters.store_id === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
      } else sel.style.display = 'none';
    }
  }

  private renderQuick(): void {
    const box = this.el.querySelector<HTMLElement>('#ph2-quick');
    if (!box) return;
    const scope = this.items.filter(p => !this.hiddenArticles.has(p.article) && (!this.filters.mp || p.mp_entries.some(e => e.mp === this.filters.mp)));
    const noCost = scope.filter(p => !p.has_cost).length;
    const noStock = scope.filter(p => this.totals(p).stock === 0 && p.has_mp).length;
    const noSales = scope.filter(p => this.totals(p).sold === 0 && p.has_mp).length;
    const chip = (key: string, label: string, n: number, on: boolean, tone = '') =>
      `<button class="ph2-chip ${tone}${on ? ' on' : ''}" data-ph2-quick="${key}">${label} <span>${num(n)}</span></button>`;
    box.innerHTML = `
      <span class="ph2-quick-label">Показать:</span>
      ${chip('all', 'Все', scope.length, !this.filters.no_cost && this.filters.stock === 'any' && !this.quickNoSales)}
      ${chip('no_cost', 'Без себестоимости', noCost, this.filters.no_cost, noCost ? 'warn' : '')}
      ${chip('no_stock', 'Нет остатка', noStock, this.filters.stock === 'zero', noStock ? 'warn' : '')}
      ${chip('no_sales', 'Без продаж за период', noSales, this.quickNoSales)}`;
  }

  private quickNoSales = false;

  private bindTable(): void {
    const head = this.el.querySelector<HTMLElement>('#ph2-thead');
    head?.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-ph2="check-all"]')) {
        const allOn = this.filtered.length > 0 && this.filtered.every(p => this.selectedArticles.has(p.article));
        if (allOn) this.clearSelection(); else this.selectAll();
        this.renderTableHead();
        return;
      }
      const col = t.closest<HTMLElement>('[data-sort]');
      if (!col) return;
      const key = col.dataset.sort as SortKey;
      if (this.sortKey === key) this.sortDir = this.sortDir === -1 ? 1 : -1;
      else { this.sortKey = key; this.sortDir = key === 'name' || key === 'article' ? 1 : -1; }
      this.applyFilters();
      this.renderList(true);
    });
    this.el.querySelector('#ph2-mp')?.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ph2-mp]');
      if (!b) return;
      this.filters.mp = (b.dataset.ph2Mp ?? '') as '' | Mp;
      this.filters.store_id = '';
      this.totalsCache.clear();
      this.applyFilters();
      this.renderList(true);
    });
    this.el.querySelector<HTMLSelectElement>('#ph2-store')?.addEventListener('change', e => {
      this.filters.store_id = (e.target as HTMLSelectElement).value;
      this.totalsCache.clear();
      this.applyFilters();
      this.renderList(true);
    });
    this.el.querySelector('#ph2-quick')?.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ph2-quick]');
      if (!b) return;
      const k = b.dataset.ph2Quick;
      if (k === 'all') { this.filters.no_cost = false; this.filters.stock = 'any'; this.quickNoSales = false; }
      if (k === 'no_cost') this.filters.no_cost = !this.filters.no_cost;
      if (k === 'no_stock') this.filters.stock = this.filters.stock === 'zero' ? 'any' : 'zero';
      if (k === 'no_sales') this.quickNoSales = !this.quickNoSales;
      this.applyFilters();
      this.renderList(true);
    });
    // Себестоимость прямо в таблице
    this.listEl?.addEventListener('click', e => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-ph2-cost]');
      if (!cell || cell.querySelector('input')) return;
      e.stopPropagation();
      const art = cell.dataset.ph2Cost!;
      const p = this.items.find(x => x.article === art);
      cell.innerHTML = `<input class="ph2-cost-inp" type="number" min="0" step="0.01" value="${p?.cost_price ?? ''}" placeholder="₽">`;
      const inp = cell.querySelector<HTMLInputElement>('input')!;
      inp.focus(); inp.select();
      const done = (save: boolean) => {
        if (save && inp.value.trim() !== '') this.saveCostPrice(art, +inp.value);
        else this.renderListItems();
      };
      inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true), { once: true });
      inp.addEventListener('click', ev => ev.stopPropagation());
    });
    this.el.querySelector('#ph2-drawer-close')?.addEventListener('click', () => this.closeCard());
    this.el.querySelector('#ph2-drawer-bg')?.addEventListener('click', () => this.closeCard());
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || this.el.style.display === 'none' || !this.selectedArticle) return;
      const lb = this.cardEl?.querySelector<HTMLElement>('#ph-lightbox');
      if (lb && lb.style.display !== 'none') return;
      this.closeCard();
    });
  }

  /** Сохранить себестоимость из таблицы или карточки. */
  private saveCostPrice(article: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) { this.renderListItems(); return; }
    costPriceDb.set(article, value);
    const p = this.items.find(x => x.article === article);
    if (p) { p.cost_price = value; p.has_cost = true; }
    this.totalsCache.delete(article);
    this.renderListItems();
    this.renderTableFoot();
    this.renderQuick();
    if (p && this.selectedArticle === article) this.renderCard(p);
    showToast(`Себестоимость ${article}: ${pr(value)}`, 'success');
  }

  /** Последнее обновление каталога магазина из любого источника, мс. */
  private lastSyncAt(storeId: string): number | null {
    let ls: string | null = null;
    try { ls = localStorage.getItem(`ph_autosync_${storeId}`); } catch { /* ignore */ }
    const vals = [catalogCache.getSyncedAt(storeId), this.storeSyncedAt.get(storeId), ls]
      .map(v => v ? Date.parse(v) : NaN)
      .concat(this.productSyncAt.get(storeId) ?? NaN)
      .filter(v => isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  }

  /**
   * При входе в раздел каталог магазинов, не обновлявшийся дольше 3 часов,
   * подтягивается из API сам — в фоне, по одному магазину. Раньше это делалось
   * только кнопкой, и карточки показывали «данные устарели».
   */
  private async autoSyncStale(): Promise<void> {
    if (this.autoSyncing || this.loading) return;
    const all: Array<{ s: any; mp: Mp }> = [
      ...this.ozStores.map((s: any) => ({ s, mp: 'ozon' as Mp })),
      ...this.wbStores.map((s: any) => ({ s, mp: 'wb' as Mp })),
      ...this.ymStores.filter((s: any) => s.business_id).map((s: any) => ({ s, mp: 'yandex' as Mp })),
    ];
    const stale = all.filter(({ s }) => {
      if (this.syncing.get(s.id)) return false;
      const t = this.lastSyncAt(s.id);
      return !t || Date.now() - t > ProductsHubModule.AUTO_SYNC_MS;
    });
    if (!stale.length) return;
    this.autoSyncing = true;
    const btn = this.el.querySelector<HTMLElement>('#ph-reload');
    btn?.classList.add('spinning');
    btn?.setAttribute('title', 'Обновляю каталог из маркетплейсов…');
    for (const { s } of stale) this.syncing.set(s.id, true);
    this.refreshOpenCardChrome();
    try {
      for (const { s, mp } of stale) {
        this.syncErr.delete(s.id);
        try {
          if (mp === 'ozon') await syncOzonStore(s);
          else if (mp === 'wb') await syncWbStore(s);
          else await syncYmStore(s);
          try { localStorage.setItem(`ph_autosync_${s.id}`, new Date().toISOString()); } catch { /* ignore */ }
        } catch (e) {
          this.syncErr.set(s.id, (e instanceof Error ? e.message : String(e)).slice(0, 120) || 'ошибка');
        } finally {
          this.syncing.set(s.id, false);
        }
      }
      await this.load({ quiet: true });
    } finally {
      this.autoSyncing = false;
      btn?.classList.remove('spinning');
      btn?.setAttribute('title', 'Обновить');
      this.refreshOpenCardChrome();
    }
  }

  /** Перерисовать блок «Требует внимания» и шапки магазинов в открытой карточке. */
  private refreshOpenCardChrome(): void {
    const p = this.selectedArticle ? this.items.find(x => x.article === this.selectedArticle) : undefined;
    if (!p || !this.cardEl) return;
    const todo = this.cardEl.querySelector<HTMLElement>('.pc-todo');
    const html = this.tplTodo(p);
    if (todo) todo.outerHTML = html || '<span class="pc-todo-slot"></span>';
    else this.cardEl.querySelector('.pc-todo-slot')?.replaceWith(document.createRange().createContextualFragment(html || '<span class="pc-todo-slot"></span>'));
    for (const e of p.mp_entries) {
      const head = this.cardEl.querySelector<HTMLElement>(`[data-section-store="${CSS.escape(e.store_id)}"] .pe-head`);
      if (head) head.outerHTML = this.peHead(e, this.editState.get(e.store_id));
    }
  }

  /** После фоновой перезагрузки данных — обновить открытую карточку, не теряя правок. */
  private refreshOpenCard(): void {
    const p = this.selectedArticle ? this.items.find(x => x.article === this.selectedArticle) : undefined;
    if (!p) return;
    if (!this.hasUnsaved()) this.editState.clear();
    const d = this.el.querySelector<HTMLElement>('#ph2-drawer');
    const top = d?.scrollTop ?? 0;
    this.renderCard(p);
    if (d) d.scrollTop = top;
    if (this.activeTab === 'card-edit') this.loadExtraDataForEdit(p).catch(() => {});
  }

  private hasUnsaved(): boolean {
    return [...this.editState.values()].some(s => s.dirtyFields.size > 0 || s.saving);
  }

  closeCard(): void {
    if (this.hasUnsaved() && !confirm('В карточке есть несохранённые изменения. Закрыть без сохранения?')) return;
    this.selectedArticle = null;
    this.editState.clear();
    const d = this.el.querySelector<HTMLElement>('#ph2-drawer');
    const bg = this.el.querySelector<HTMLElement>('#ph2-drawer-bg');
    if (d) d.style.display = 'none';
    if (bg) bg.style.display = 'none';
    this.el.classList.remove('ph2-card-open');
    this.renderListItems();
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
      try { localStorage.setItem(PERIOD_KEY, String(v)); } catch { /* не критично */ }
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
    document.addEventListener('keydown', this.onCtrlS);
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
        const sid = t.getAttribute('data-store-id')!;
        const field = t.getAttribute('data-ph-field')!;
        const st = this.editState.get(sid);
        if (st) {
          (st as unknown as Record<string, unknown>)[field] = t.value;
          const firstChange = !st.dirtyFields.size;
          st.dirtyFields.add(field);
          st.saveOk = false; st.saveNote = '';
          t.classList.add('pe-dirty');
          // Отметить магазин без полной перерисовки (иначе пропадёт курсор)
          const section = this.cardEl?.querySelector<HTMLElement>(`[data-section-store="${sid}"]`);
          if (section) {
            section.classList.add('dirty');
            const chip = section.querySelector<HTMLElement>('.cmp-edit-dirty-chip');
            if (chip) chip.style.display = '';
            const pv = section.querySelector<HTMLElement>('.pe-preview');
            if (pv && ['price', 'old_price', 'min_price', 'discount'].includes(field)) pv.innerHTML = this.pricePreview(st);
            const cnt = section.querySelector<HTMLElement>('[data-count-for]');
            if (cnt && field === 'description') cnt.textContent = `${t.value.length.toLocaleString('ru')} симв.`;
          }
          if (firstChange) this.updateSaveBar();
        }
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
          st.dirtyFields.add('photos');
        } catch (err: unknown) {
          st.saveError = (err instanceof Error ? err.message : String(err)) ?? 'Ошибка загрузки фото';
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
        case 'save-all':
          this.saveAllDirty();
          break;
        case 'edit-reset': {
          const pr0 = this.items.find(x => x.article === this.selectedArticle);
          if (!pr0) break;
          this.initEditState(pr0, storeId);
          this.refreshEditTab();
          this.loadExtraDataForEdit(pr0).catch(() => {});
          break;
        }
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
            if (st) { st.photos.push(url); st.dirtyFields.add('photos'); this.photoAddUrlValue = ''; this.photoAddStoreId = null; }
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
          if (st && idx >= 0) { st.photos.splice(idx, 1); st.dirtyFields.add('photos'); this.refreshPhotosTab2(); }
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
        // ── Accordion toggle for edit sections
        case 'toggle-section': {
          if (this.collapsedStores.has(storeId)) this.collapsedStores.delete(storeId);
          else this.collapsedStores.add(storeId);
          const body = this.cardEl?.querySelector<HTMLElement>(`[data-section-store="${storeId}"] .cmp-edit-body`);
          const arrow = this.cardEl?.querySelector<HTMLElement>(`[data-section-store="${storeId}"] .cmp-section-arrow`);
          if (body)  body.style.display  = this.collapsedStores.has(storeId) ? 'none' : '';
          if (arrow) arrow.textContent   = this.collapsedStores.has(storeId) ? '▶' : '▼';
          break;
        }
      }
    });

    // ── Перестановка фото: зажать и тащить (мышь и палец)
    this.cardEl!.addEventListener('pointerdown', e => this.photoDragStart(e));

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

  private async load(opts: { quiet?: boolean } = {}): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    const items = this.el.querySelector<HTMLElement>('#ph-items');
    if (!opts.quiet) {
      this.setCardEmpty(`<div class="ph-loader">${I.loader('', 18)} Загружаем все данные…</div>`);
      const spacer = this.el.querySelector<HTMLElement>('#ph-spacer');
      if (spacer) spacer.style.height = '40px';
      if (items) items.innerHTML = `<div class="ph-loader">${I.loader('', 16)}</div>`;
    }

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
      this.productSyncAt.clear();
      for (const r of [...this.ozProds, ...this.wbProds, ...this.ymProds]) {
        const t = r?.synced_at ? Date.parse(r.synced_at) : NaN;
        if (isFinite(t) && t > (this.productSyncAt.get(r.store_id) ?? 0)) this.productSyncAt.set(r.store_id, t);
      }

      // 3. Продажи: сервер сразу суммирует операции по товарам за период
      // (rpc product_sales_summary). Раньше в браузер скачивались все операции
      // за 180 дней с исходным JSON — десятки мегабайт при каждом открытии.
      this.allStoreIds = allStoreIds;
      const [transactions, producers, producerProds, producerMaps, fieldDefs] = await Promise.all([
        this.fetchSales(allStoreIds),
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
      this.rawTransactions = transactions;
      this.hadTransactions = transactions.length > 0 || (this.salesRows?.length ?? 0) > 0;
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
      this.renderList(!opts.quiet);
      if (!this.selectedArticle) this.setCardHint();
      else if (opts.quiet) this.refreshOpenCard();
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
  /**
   * Сводка продаж за текущий период. Возвращает операции только в запасном
   * режиме (функция на сервере ещё не применена) — тогда считаем на клиенте.
   */
  private async fetchSales(storeIds: string[]): Promise<MpTransaction[]> {
    this.salesRows = null;
    if (!storeIds.length) return [];
    const to = new Date();
    const from = new Date(to.getTime() - this.period * 86400_000);
    try {
      const rows = await dbFetch<SalesRow[]>('rpc/product_sales_summary', {
        method: 'POST',
        body: JSON.stringify({ p_store_ids: storeIds, p_from: from.toISOString(), p_to: to.toISOString() }),
      });
      this.salesRows = (rows ?? []).map(r => ({
        ...r, sold: +r.sold || 0, returned: +r.returned || 0, revenue: +r.revenue || 0,
        commission: +r.commission || 0, payout: +r.payout || 0,
      }));
      return [];
    } catch (e) {
      debug.warn('[ProductsHub] sales summary rpc unavailable, falling back to transactions', e);
      const dateFrom = new Date(Date.now() - 180 * 86400_000).toISOString();
      return mpTransactionsDb.getByStores(storeIds, dateFrom, to.toISOString()).catch(() => [] as MpTransaction[]);
    }
  }

  private articleFor(mp: Mp, sku: string | number | undefined): string | null {
    if (sku == null || sku === '') return null;
    const s = String(sku);
    if (mp === 'ozon') return this.skuMaps.ozon.get(s) ?? null;
    if (mp === 'wb')   return this.skuMaps.wb.get(s) ?? null;
    return this.skuMaps.ymSku.get(s) ?? this.skuMaps.ymOffer.get(s.toLowerCase()) ?? null;
  }

  private aggregateSales(): void {
    // 1. Сбросить аггрегаты на всех entries
    for (const p of this.items) for (const e of p.mp_entries) {
      e.sales_qty = 0; e.sales_revenue = 0; e.returns_qty = 0;
      e.commission = 0; e.delivery = 0; e.services = 0; e.net_profit = 0;
    }

    // Сводка с сервера: деньги уже разнесены по SKU.
    // commission/services храним со знаком «минус = удержание», net_profit = перечислено МП.
    if (this.salesRows) {
      const index = new Map<string, MpStoreEntry>();
      for (const p of this.items) for (const e of p.mp_entries) index.set(`${e.mp}:${e.store_id}:${p.article.toLowerCase()}`, e);
      for (const r of this.salesRows) {
        const art = this.articleFor(r.marketplace, r.sku);
        if (!art) continue;
        const e = index.get(`${r.marketplace}:${r.store_id}:${art.toLowerCase()}`);
        if (!e) continue;
        e.sales_qty += r.sold;
        e.returns_qty += r.returned;
        e.sales_revenue += r.revenue;
        e.commission -= r.commission;
        e.services -= r.revenue - r.commission - r.payout;
        e.net_profit += r.payout;
      }
      return;
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

  /** Пересчёт продаж/финансов при смене периода. */
  private async reaggregateSales(): Promise<void> {
    if (this.salesRows) {
      this.rawTransactions = await this.fetchSales(this.allStoreIds);
    }
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
    const { q, mp, store_id, no_cost, no_mp, no_repricer, status, stock, price_min, price_max } = this.filters;
    this.filtered = this.items.filter(p => {
      // Hidden filter
      if (!this.showHidden && this.hiddenArticles.has(p.article)) return false;
      if (this.showHidden && !this.hiddenArticles.has(p.article)) return false;
      // Show-only-selected filter
      if (this.showOnlySelected && !this.selectedArticles.has(p.article)) return false;
      if (q && !p.article.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return false;
      if (mp && !p.mp_entries.some(e => e.mp === mp)) return false;
      if (store_id && !p.mp_entries.some(e => e.store_id === store_id)) return false;
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

    // Быстрый фильтр «без продаж за период»
    this.totalsCache.clear();
    if (this.quickNoSales) this.filtered = this.filtered.filter(p => p.has_mp && this.totalsOf(p).sold === 0);

    // Сортировка по колонке таблицы
    const val = (p: HubProduct): number | string => {
      const t = this.totalsOf(p);
      switch (this.sortKey) {
        case 'name':    return (p.name || p.article).toLowerCase();
        case 'article': return p.article.toLowerCase();
        case 'price':   return t.minPrice ?? -1;
        case 'stock':   return t.stock;
        case 'sold':    return t.sold;
        case 'revenue': return t.revenue;
        case 'fees':    return t.commission + t.otherFees;
        case 'cost':    return p.cost_price ?? -1;
        case 'profit':  return t.profit ?? -Infinity;
        case 'margin':  return t.margin ?? -Infinity;
      }
    };
    const dir = this.sortDir;
    this.filtered.sort((x, y) => {
      const a1 = val(x), b1 = val(y);
      if (typeof a1 === 'string' || typeof b1 === 'string') return String(a1).localeCompare(String(b1), 'ru') * dir;
      return (a1 - b1) * dir || x.article.localeCompare(y.article, 'ru');
    });
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
    this.renderTableHead();
    this.renderListItems();
    this.renderTableFoot();
    this.renderMpSegs();
    this.renderQuick();
  }

  private renderListItems(): void {
    const items = this.el.querySelector<HTMLElement>('#ph-items');
    if (!items) return;
    if (this.filtered.length === 0) {
      items.style.top = '0';
      items.innerHTML = this.loading ? '' : `<div class="ph-list-empty">${this.items.length ? 'Ничего не найдено — измените поиск или фильтры' : 'Товаров пока нет: подключите магазин и синхронизируйте каталог'}</div>`;
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
    const t = this.totalsOf(p);
    const thumb = p.image_url
      ? `<img class="ph2-thumb" src="${esc(p.image_url)}" loading="lazy" onerror="this.style.visibility='hidden'">`
      : `<div class="ph2-thumb empty">${I.image('', 16)}</div>`;
    const mps = (['ozon', 'wb', 'yandex'] as Mp[]).map(mp => {
      const cnt = p.mp_entries.filter(e => e.mp === mp).length;
      return cnt ? `<span class="ph-mp-tag mp-${mp}" title="${esc(MP_FULL[mp])}${cnt > 1 ? ` · ${cnt} магазина` : ''}">${MP_LABEL[mp]}${cnt > 1 ? `×${cnt}` : ''}</span>` : '';
    }).join('');
    const price = t.minPrice == null ? '—'
      : t.minPrice === t.maxPrice ? pr(t.minPrice) : `${Math.round(t.minPrice).toLocaleString('ru')}–${pr(t.maxPrice)}`;
    const fees = t.commission + t.otherFees;
    return `
      <div class="ph2-tr ph2-row${active ? ' active' : ''}${checked ? ' checked' : ''}" style="height:${ROW_H}px"
        onclick="window.productsHubModule?.selectProduct('${safeArt}')">
        <div class="ph2-td c-check" onclick="event.stopPropagation();window.productsHubModule?.toggleCheck('${safeArt}')">
          <span class="ph-checkbox${checked ? ' on' : ''}"></span>
        </div>
        <div class="ph2-td c-prod">
          ${thumb}
          <div class="ph2-prod-text">
            <div class="ph2-prod-name"><span title="${esc(p.name)}">${p.name ? esc(p.name) : '<i>без названия</i>'}</span>${p.name ? copyButton(p.name, 'Копировать название') : ''}</div>
            <div class="ph2-prod-art"><span>${esc(p.article)}</span>${copyButton(p.article, 'Копировать артикул')}</div>
          </div>
        </div>
        <div class="ph2-td c-mps">${mps || '<span class="ph2-muted">нет на МП</span>'}</div>
        <div class="ph2-td c-num">${price}</div>
        <div class="ph2-td c-num ${t.stock === 0 && p.has_mp ? 'neg' : ''}">${num(t.stock)}</div>
        <div class="ph2-td c-num">${t.sold ? num(t.sold) : '<span class="ph2-muted">0</span>'}${t.returned ? `<small> / −${num(t.returned)}</small>` : ''}</div>
        <div class="ph2-td c-num">${t.revenue ? pr(t.revenue) : '<span class="ph2-muted">—</span>'}</div>
        <div class="ph2-td c-num">${fees ? pr(fees) : '<span class="ph2-muted">—</span>'}</div>
        <div class="ph2-td c-num ph2-cost" data-ph2-cost="${esc(p.article)}" title="Кликните, чтобы изменить себестоимость">
          ${p.cost_price != null ? pr(p.cost_price) : '<span class="ph2-addcost">+ указать</span>'}</div>
        <div class="ph2-td c-num ${t.profit == null ? '' : t.profit >= 0 ? 'pos' : 'neg'}">${t.profit == null ? (t.sold ? '<span class="ph2-muted" title="Нет себестоимости">?</span>' : '<span class="ph2-muted">—</span>') : pr(t.profit)}</div>
        <div class="ph2-td c-num">${t.margin == null ? '<span class="ph2-muted">—</span>' : `${t.margin.toFixed(1).replace('.', ',')}%`}</div>
      </div>`;
  }

  // ─── Select & render card ───────────────────────────────────────

  selectProduct(article: string): void {
    if (article !== this.selectedArticle && this.hasUnsaved() && !confirm('В открытой карточке есть несохранённые изменения. Перейти к другому товару без сохранения?')) return;
    this.selectedArticle = article;
    this.editState.clear();
    this.collapsedStores.clear();
    this.photoAddStoreId = null;
    if (this.activeTab === 'card-edit' || this.activeTab === 'photos') {
      this.activeTab = 'overview';
    }
    this.renderListItems();
    const p = this.items.find(x => x.article === article);
    if (!p) return;
    const d = this.el.querySelector<HTMLElement>('#ph2-drawer');
    const bg = this.el.querySelector<HTMLElement>('#ph2-drawer-bg');
    if (d) { d.style.display = ''; d.scrollTop = 0; }
    if (bg) bg.style.display = '';
    this.el.classList.add('ph2-card-open');
    this.renderCard(p);
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
    const d = this.el.querySelector<HTMLElement>('#ph2-drawer');
    if (d && d.style.display === 'none') return;
    this.setCardEmpty(`
      <div class="ph-card-empty">
        <div class="ph-card-empty-icon">${I.package('', 38)}</div>
        <div class="ph-card-empty-title">Выберите товар</div>
        <div class="ph-card-empty-text">Нажмите на товар в таблице, чтобы открыть карточку.</div>
      </div>`);
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

  // ═══ Карточка товара (15.10.2026, с нуля) ═════════════════════════
  //  Шапка: фото, название, артикул/штрихкод, магазины, действия.
  //  «Требует внимания» — что мешает товару, с кнопкой исправить.
  //  Четыре цифры: цена, остаток, продажи, прибыль. Вкладки ниже.

  private renderCard(p: HubProduct): void {
    if (!this.cardEl) return;
    this.cardEl.innerHTML = `<div class="pc">
      ${this.tplHead(p)}
      ${this.tplTodo(p) || '<span class="pc-todo-slot"></span>'}
      ${this.tplStats(p)}
      ${this.tplTabsHead(p)}
      <div class="pc-body">${this.tplTabContent(p)}</div>
    </div>` + this.tplLightbox();
  }

  /** Себестоимость из поля в карточке: сохранить и пересчитать прибыль. */
  async setCost(raw: string): Promise<void> {
    const p = this.items.find(x => x.article === this.selectedArticle);
    if (!p) return;
    const s = String(raw ?? '').trim().replace(',', '.');
    const v = s === '' ? null : parseFloat(s);
    if (v == null || isNaN(v) || v < 0) { showToast('Введите себестоимость числом, например 450', 'warning'); return; }
    if (v === p.cost_price) return;
    try {
      await costPriceDb.set(p.article, v);
    } catch (e) {
      showToast(`Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return;
    }
    p.cost_price = v;
    p.has_cost = true;
    this.totalsCache.delete(p.article);
    this.renderCard(p);
    this.renderListItems();
    this.renderTableFoot();
    this.renderQuick();
    showToast('Себестоимость сохранена', 'success');
  }

  /** Перейти к полю себестоимости и поставить в него курсор. */
  focusCost(): void {
    const inp = this.cardEl?.querySelector<HTMLInputElement>('#pc-cost');
    if (!inp) return;
    inp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => inp.focus(), 150);
  }

  private static vatLabel(v: string): string {
    if (!v) return '';
    if (v === '0' || v === 'NO_VAT' || v === '0.00') return 'Без НДС';
    const m: Record<string, string> = { '0.05': '5%', '0.07': '7%', '0.1': '10%', '0.10': '10%', 'VAT_10': '10%', '0.2': '20%', '0.20': '20%', 'VAT_20': '20%', '0.22': '22%', 'VAT_22': '22%' };
    return m[v] ?? v;
  }

  private tplHead(p: HubProduct): string {
    const photos = this.allPhotos(p);
    const main = photos[0] ?? '';
    const thumbs = photos.slice(1, 4);
    const more = photos.length - 1 - thumbs.length;
    const gallery = main
      ? `<div class="pc-gallery">
          <img class="pc-photo" src="${esc(main)}" alt="" loading="lazy" data-ph-action="open-lightbox" data-url="${esc(main)}" onerror="this.classList.add('broken')">
          ${thumbs.length ? `<div class="pc-thumbs">${thumbs.map((u, i) => `
            <button class="pc-thumb" data-ph-action="open-lightbox" data-url="${esc(u)}" title="Открыть фото">
              <img src="${esc(u)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'">
              ${i === thumbs.length - 1 && more > 0 ? `<span>+${more}</span>` : ''}
            </button>`).join('')}</div>` : ''}
        </div>`
      : `<button class="pc-gallery pc-photo-empty" onclick="window.productsHubModule?.setTab('photos')" title="Добавить фото">
          ${I.image('', 26)}<span>Нет фото</span></button>`;

    const idChip = (label: string, value: string, title: string) =>
      `<span class="pc-id"><span class="pc-id-k">${label}</span><span class="pc-id-v">${esc(value)}</span>${copyButton(value, title)}</span>`;

    const stores = p.mp_entries.map(e => {
      const inner = `<span class="pc-mp pc-mp-${e.mp}">${MP_LABEL[e.mp]}</span>${esc(e.store_name)}`;
      return e.url
        ? `<a class="pc-store-chip" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="Открыть товар на ${MP_FULL[e.mp]}">${inner}${I.externalLink('', 11)}</a>`
        : `<span class="pc-store-chip">${inner}</span>`;
    }).join('');

    return `
      <header class="pc-hero">
        ${gallery}
        <div class="pc-hero-main">
          <h2 class="pc-title">${p.name ? esc(p.name) : '<span class="pc-muted">Без названия</span>'}${p.name ? copyButton(p.name, 'Копировать название') : ''}</h2>
          <div class="pc-ids">
            ${idChip('Артикул', p.article, 'Копировать артикул')}
            ${p.barcode ? idChip('Штрихкод', p.barcode, 'Копировать штрихкод') : ''}
          </div>
          ${p.brand || p.category ? `<div class="pc-sub">${[p.brand ? esc(p.brand) : '', p.category ? esc(p.category) : ''].filter(Boolean).join('<i>·</i>')}</div>` : ''}
          ${stores ? `<div class="pc-stores">${stores}</div>` : '<div class="pc-sub pc-warn-text">Товара нет ни в одном магазине</div>'}
          <div class="pc-actions">
            <button class="pc-btn primary" onclick="window.productsHubModule?.setTab('card-edit')">${I.edit('', 14)} Редактировать</button>
            <button class="pc-btn" onclick="window.app?.navigateTo('repricer')">${I.trendingUp('', 14)} Репрайсер</button>
          </div>
        </div>
      </header>`;
  }

  /** Что мешает товару — коротко и с кнопкой, которая это исправляет. */
  private tplTodo(p: HubProduct): string {
    const photos = this.allPhotos(p);
    const t = this.totals(p, p.mp_entries);
    const items: Array<{ tone: 'warn' | 'info'; text: string; action: string }> = [];
    if (p.cost_price == null) {
      items.push({ tone: 'warn', text: '<b>Не указана себестоимость</b> — без неё не считаются прибыль и маржа',
        action: `<button class="pc-todo-btn" onclick="window.productsHubModule?.focusCost()">Указать</button>` });
    }
    if (p.has_mp && t.stock === 0) {
      items.push({ tone: 'warn', text: '<b>Нет остатка</b> — товар не продаётся, пока не пополните склад',
        action: `<button class="pc-todo-btn" onclick="window.app?.navigateTo('supply')">Поставки</button>` });
    }
    const missing = [
      ['фото', photos.length > 0], ['описание', p.mp_entries.some(e => e.description)], ['бренд', !!p.brand],
      ['штрихкод', !!p.barcode], ['габариты', !!(p.weight_kg && p.length_cm && p.width_cm && p.height_cm)],
    ].filter(([, ok]) => !ok).map(([k]) => k as string);
    if (missing.length && p.has_mp) {
      items.push({ tone: 'info', text: `<b>Карточка неполная</b> — не заполнено: ${missing.join(', ')}`,
        action: `<button class="pc-todo-btn" onclick="window.productsHubModule?.setTab('${missing.length === 1 && missing[0] === 'фото' ? 'photos' : 'card-edit'}')">Заполнить</button>` });
    }
    // Каталог обновляется сам при входе в раздел; здесь — только ход и ошибки
    const syncingNow = p.mp_entries.filter(e => this.syncing.get(e.store_id));
    if (syncingNow.length) {
      items.push({ tone: 'info', text: `Загружаю свежие данные из ${[...new Set(syncingNow.map(e => MP_FULL[e.mp]))].join(', ')}…`, action: '' });
    }
    for (const e of p.mp_entries) {
      const err = this.syncErr.get(e.store_id);
      if (!err || this.syncing.get(e.store_id)) continue;
      items.push({ tone: 'warn', text: `<b>Не удалось обновить «${esc(e.store_name)}»</b> — ${esc(err)}. Проверьте ключ API в настройках магазина`,
        action: `<button class="pc-todo-btn" data-ph-action="sync-store" data-store-id="${esc(e.store_id)}" data-mp="${e.mp}">Повторить</button>` });
    }
    if (!items.length) return '';
    return `<section class="pc-todo" aria-label="Требует внимания">${items.map(i => `
      <div class="pc-todo-row ${i.tone}">
        <span class="pc-todo-ico">${i.tone === 'warn' ? I.alertTriangle('', 14) : I.info('', 14)}</span>
        <span class="pc-todo-text">${i.text}</span>
        ${i.action}
      </div>`).join('')}</section>`;
  }

  private tplStats(p: HubProduct): string {
    const t = this.totals(p, p.mp_entries);
    const tile = (label: string, value: string, sub: string, cls = '') =>
      `<div class="pc-kpi ${cls}"><div class="pc-kpi-k">${label}</div><div class="pc-kpi-v">${value}</div><div class="pc-kpi-s">${sub}</div></div>`;

    const price = t.minPrice == null ? '—'
      : t.minPrice === t.maxPrice ? pr(t.minPrice)
      : `${Math.round(t.minPrice).toLocaleString('ru')} – ${pr(t.maxPrice)}`;
    const old = p.mp_entries.map(e => e.old_price ?? 0).filter(x => t.minPrice != null && x > (t.minPrice ?? 0));
    const priceSub = old.length ? `<s>${pr(Math.max(...old))}</s> до скидки` : `${p.mp_entries.length} ${plural(p.mp_entries.length, ['магазин', 'магазина', 'магазинов'])}`;

    const fbs = p.mp_entries.reduce((s, e) => s + (e.mp === 'ozon' ? e.stock_fbs : 0), 0);
    const fbo = p.mp_entries.reduce((s, e) => s + (e.mp === 'ozon' ? e.stock_fbo : 0), 0);
    const hasOz = p.mp_entries.some(e => e.mp === 'ozon');
    const stockSub = hasOz && p.mp_entries.length === 1 ? `FBO ${num(fbo)} · FBS ${num(fbs)}` : 'шт на всех складах';

    const salesSub = t.sold ? `${pr(t.revenue)}${t.returned ? ` · возвр. ${num(t.returned)}` : ''}` : 'продаж не было';

    const profit = t.profit == null
      ? tile('Прибыль', '—', '<button class="pc-linkbtn" onclick="window.productsHubModule?.focusCost()">укажите себестоимость</button>', 'muted')
      : tile('Прибыль', prSigned(t.profit), t.margin != null ? `маржа ${t.margin.toFixed(1).replace('.', ',')}%` : 'за период', t.profit >= 0 ? 'pos' : 'neg');

    return `<section class="pc-kpis">
      ${tile('Цена', price, priceSub)}
      ${tile('Остаток', `${num(t.stock)} <small>шт</small>`, stockSub, t.stock === 0 ? 'neg' : '')}
      ${tile(`Продано за ${this.period} дн.`, `${num(t.sold)} <small>шт</small>`, salesSub)}
      ${profit}
    </section>`;
  }

  private tplTabsHead(p: HubProduct): string {
    const photos = this.allPhotos(p).length;
    const tab = (id: Tab, label: string, badge = '') =>
      `<button class="pc-tab${this.activeTab === id ? ' on' : ''}" role="tab" aria-selected="${this.activeTab === id}"
        onclick="window.productsHubModule?.setTab('${id}')">${label}${badge ? `<span>${badge}</span>` : ''}</button>`;
    return `<nav class="pc-tabs" role="tablist">
      ${tab('overview', 'Обзор')}
      ${tab('finance', 'Экономика')}
      ${tab('card-edit', 'Редактирование')}
      ${tab('photos', 'Фото', photos ? String(photos) : '')}
    </nav>`;
  }

  private tplTabContent(p: HubProduct): string {
    switch (this.activeTab) {
      case 'overview':   return this.tplOverview(p);
      case 'finance':    return this.tplFinance(p);
      case 'card-edit':  return this.tplCardEdit(p);
      case 'photos':     return this.tplPhotosTab(p);
    }
  }

  // ─── Обзор ──────────────────────────────────────────────────────

  private tplOverview(p: HubProduct): string {
    const sec = (title: string, body: string, extra = '') =>
      `<section class="pc-sec"><div class="pc-sec-h"><h3>${title}</h3>${extra}</div>${body}</section>`;

    // Где продаётся
    const stores = p.mp_entries.length
      ? `<div class="pc-shops">${p.mp_entries.map(e => this.tplShop(e)).join('')}</div>`
      : `<div class="pc-empty">Товар не найден ни в одном магазине. Если он там есть — обновите каталог в «Редактировании».</div>`;

    // Характеристики — всё, что известно о товаре, одной сеткой
    const vat = [...new Set(p.mp_entries.map(e => ProductsHubModule.vatLabel(e.vat)).filter(Boolean))].join(', ');
    const dims = p.length_cm || p.width_cm || p.height_cm ? `${p.length_cm ?? 0} × ${p.width_cm ?? 0} × ${p.height_cm ?? 0} см` : '';
    const volume = p.length_cm && p.width_cm && p.height_cm ? `${(p.length_cm * p.width_cm * p.height_cm / 1000).toFixed(2).replace('.', ',')} л` : '';
    const facts: Array<[string, string]> = [
      ['Бренд', p.brand ? esc(p.brand) : ''],
      ['Категория', p.category ? esc(p.category) : ''],
      ['Штрихкод', p.barcode ? `<span class="pc-mono">${esc(p.barcode)}</span>${copyButton(p.barcode, 'Копировать штрихкод')}` : ''],
      ['НДС', esc(vat)],
      ['Вес', p.weight_kg ? `${String(p.weight_kg).replace('.', ',')} кг` : ''],
      ['Габариты', dims],
      ['Объём', volume],
      ...p.custom_fields.map(f => [esc(f.label), esc(String(f.value ?? ''))] as [string, string]),
    ];
    const factsHtml = `<dl class="pc-facts">${facts.map(([k, v]) =>
      `<div><dt>${k}</dt><dd>${v || '<span class="pc-muted">не указано</span>'}</dd></div>`).join('')}</dl>`;

    // Характеристики WB (если пришли из каталога)
    const chars = p.mp_entries.flatMap(e => e.characteristics ?? []).filter(c => c.name && c.value);
    const charsHtml = chars.length
      ? `<details class="pc-more"><summary>Характеристики маркетплейса · ${chars.length}</summary>
          <dl class="pc-facts">${chars.slice(0, 60).map(c => `<div><dt>${esc(c.name)}</dt><dd>${esc(c.value)}</dd></div>`).join('')}</dl></details>`
      : '';

    // Описание
    const desc = p.mp_entries.map(e => e.description).find(Boolean) ?? '';
    const descHtml = desc
      ? `<div class="pc-desc${desc.length > 360 ? ' clamp' : ''}">${esc(desc)}</div>
         ${desc.length > 360 ? `<button class="pc-linkbtn" onclick="this.previousElementSibling.classList.remove('clamp');this.remove()">Показать полностью</button>` : ''}`
      : `<div class="pc-empty">Описания нет. <button class="pc-linkbtn" onclick="window.productsHubModule?.setTab('card-edit')">Добавить</button></div>`;

    // Репрайсер и поставщик — короткими карточками
    const rep = p.repricer_rules.length
      ? p.repricer_rules.map(r => this.tplRule(r)).join('')
      : `<div class="pc-empty">Цена меняется вручную. <button class="pc-linkbtn" onclick="window.app?.navigateTo('repricer')">Настроить репрайсер</button></div>`;
    const sup = p.supplier && (p.supplier.producer || p.supplier.product)
      ? this.tplSupplier(p.supplier)
      : `<div class="pc-empty">Не привязан. <button class="pc-linkbtn" onclick="window.app?.navigateTo('producers')">Выбрать поставщика</button></div>`;

    return `
      ${sec('Где продаётся', stores)}
      ${sec('О товаре', factsHtml + charsHtml, `<button class="pc-linkbtn" onclick="window.productsHubModule?.setTab('card-edit')">Изменить</button>`)}
      ${sec('Описание', descHtml)}
      <div class="pc-split">
        ${sec('Репрайсер', rep)}
        ${sec('Поставщик', sup)}
      </div>`;
  }

  /** Один магазин: статус, цена, остатки и продажи. */
  private tplShop(e: MpStoreEntry): string {
    const st = e.status ?? '';
    const tone = /продаже/i.test(st) ? 'ok' : /нет в наличии|заблок|ошибка|не прош/i.test(st) ? 'bad' : st ? 'mid' : '';
    const disc = e.old_price && e.price && e.old_price > e.price ? Math.round((1 - e.price / e.old_price) * 100) : 0;
    const stock = e.mp === 'ozon'
      ? [['FBO', e.stock_fbo], ['FBS', e.stock_fbs]]
      : e.mp === 'yandex'
        ? [['Доступно', e.stock_available], ['Всего', e.stock_total]]
        : [['На складах', e.stock_total]];
    return `<article class="pc-shop">
      <div class="pc-shop-top">
        <span class="pc-mp pc-mp-${e.mp}">${MP_LABEL[e.mp]}</span>
        <span class="pc-shop-name" title="${esc(e.store_name)}">${esc(e.store_name)}</span>
        ${st ? `<span class="pc-status ${tone}">${esc(st)}</span>` : ''}
        <span class="pc-grow"></span>
        ${e.url ? `<a class="pc-icon-btn" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="Открыть на ${MP_FULL[e.mp]}">${I.externalLink('', 14)}</a>` : ''}
      </div>
      <div class="pc-shop-grid">
        <div><span>Цена</span><b>${pr(e.price)}</b>${disc ? `<em><s>${pr(e.old_price)}</s> −${disc}%</em>` : ''}</div>
        <div><span>Остаток</span><b class="${e.stock_total === 0 ? 'neg' : ''}">${num(e.stock_total)} шт</b><em>${stock.map(([k, v]) => `${k} ${num(v as number)}`).join(' · ')}</em></div>
        <div><span>Продано за ${this.period} дн.</span><b>${num(e.sales_qty)} шт</b><em>${e.sales_qty ? pr(e.sales_revenue) : 'продаж нет'}${e.returns_qty ? ` · возвр. ${num(e.returns_qty)}` : ''}</em></div>
      </div>
    </article>`;
  }

  // ─── Экономика ──────────────────────────────────────────────────

  private tplFinance(p: HubProduct): string {
    const t = this.totals(p, p.mp_entries);
    const costField = `
      <label class="pc-cost">
        <span class="pc-cost-k">Себестоимость одной штуки</span>
        <span class="pc-cost-in">
          <input id="pc-cost" type="number" inputmode="decimal" min="0" step="1" value="${p.cost_price ?? ''}" placeholder="например, 450"
            onchange="window.productsHubModule?.setCost(this.value)" onkeydown="if(event.key==='Enter'){this.blur()}">
          <span>₽</span>
        </span>
        <span class="pc-cost-s">Закупка, упаковка, доставка до склада. Сохраняется сразу и учитывается везде — в таблице и «Аналитике».</span>
      </label>`;

    if (!t.sold && !t.returned && !t.revenue && !t.payout) {
      return `<section class="pc-sec">${costField}</section>
        <div class="pc-empty big">${this.hadTransactions
          ? `За ${this.period} дней продаж не было — экономику считать не из чего. Выберите период длиннее в шапке раздела.`
          : 'Нет финансовых отчётов маркетплейсов. Откройте «Аналитику» и нажмите «Обновить» — здесь появятся выручка, удержания и прибыль.'}</div>`;
    }

    // На одну проданную штуку
    const units = Math.max(1, t.netUnits || t.sold);
    const per = (v: number) => v / units;
    const unitPrice = per(t.revenue);
    const parts = [
      { k: 'Комиссия', v: per(t.commission), c: 'c1' },
      { k: 'Логистика и услуги', v: per(t.otherFees), c: 'c2' },
      ...(p.cost_price != null ? [{ k: 'Себестоимость', v: p.cost_price, c: 'c3' }] : []),
    ];
    const profitUnit = p.cost_price != null ? unitPrice - parts.reduce((s, x) => s + x.v, 0) : null;
    const scale = Math.max(unitPrice, parts.reduce((s, x) => s + Math.max(0, x.v), 0)) || 1;
    const share = (v: number) => unitPrice > 0 ? `${(v / unitPrice * 100).toFixed(0)}%` : '';
    const segs = [...parts.filter(x => x.v > 0), ...(profitUnit != null && profitUnit > 0 ? [{ k: 'Прибыль', v: profitUnit, c: 'pos' }] : [])];
    const bar = `<div class="pc-bar" role="img" aria-label="Из чего состоит цена">${segs.map(s =>
      `<i class="${s.c}" style="width:${(s.v / scale * 100).toFixed(2)}%" title="${s.k}: ${pr(s.v)} (${share(s.v)})"></i>`).join('')}</div>`;

    const unitRows = `
      <div class="pc-ue-row head"><span>Цена продажи (средняя)</span><b>${pr(unitPrice)}</b><em>100%</em></div>
      ${parts.map(x => `<div class="pc-ue-row"><span><i class="pc-dot ${x.c}"></i>${x.k}</span><b>−${pr(Math.abs(x.v))}</b><em>${share(Math.abs(x.v))}</em></div>`).join('')}
      ${p.cost_price == null ? `<div class="pc-ue-row"><span><i class="pc-dot c3"></i>Себестоимость</span><b><button class="pc-linkbtn" onclick="window.productsHubModule?.focusCost()">указать</button></b><em></em></div>` : ''}
      <div class="pc-ue-row total ${profitUnit == null ? '' : profitUnit >= 0 ? 'pos' : 'neg'}"><span>Прибыль с одной штуки</span><b>${profitUnit == null ? '—' : prSigned(profitUnit)}</b><em>${profitUnit == null ? '' : share(profitUnit)}</em></div>`;

    const line = (k: string, v: number | null, cls = '', signed = true) =>
      `<div class="pc-ue-row ${cls}"><span>${k}</span><b>${v == null ? '—' : signed ? prSigned(v) : pr(v)}</b><em></em></div>`;
    const stores = p.mp_entries.filter(e => e.sales_qty || e.returns_qty || e.sales_revenue);

    return `
      <section class="pc-sec">
        <div class="pc-sec-h"><h3>Из чего состоит цена</h3><span class="pc-muted">на 1 шт · по отчётам за ${this.period} дн.</span></div>
        ${bar}
        <div class="pc-legend">${segs.map(s => `<span><i class="pc-dot ${s.c}"></i>${s.k}</span>`).join('')}</div>
        <div class="pc-ue">${unitRows}</div>
      </section>
      <section class="pc-sec">${costField}</section>
      <section class="pc-sec">
        <div class="pc-sec-h"><h3>Итого за ${this.period} дней</h3><span class="pc-muted">продано ${num(t.sold)} шт${t.returned ? `, возвратов ${num(t.returned)}` : ''}</span></div>
        <div class="pc-ue">
          ${line('Выручка', t.revenue, 'head', false)}
          ${line('Комиссия маркетплейса', -t.commission)}
          ${line('Логистика, эквайринг и прочие услуги', -t.otherFees)}
          ${line('Перечислено маркетплейсом', t.payout, 'sub', false)}
          ${line(t.cogs != null ? `Себестоимость · ${num(t.netUnits)} шт` : 'Себестоимость', t.cogs != null ? -t.cogs : null)}
          ${line('Прибыль', t.profit, `total ${t.profit == null ? '' : t.profit >= 0 ? 'pos' : 'neg'}`)}
        </div>
        <p class="pc-note">До налогов, рекламы из рекламного кабинета и общих расходов. Полный расчёт — в «Аналитике».</p>
      </section>
      ${stores.length > 1 ? `
      <section class="pc-sec">
        <div class="pc-sec-h"><h3>По магазинам</h3></div>
        <div class="pc-table-wrap"><table class="pc-table">
          <thead><tr><th>Магазин</th><th>Продано</th><th>Выручка</th><th>Удержания</th><th>Перечислено</th></tr></thead>
          <tbody>${stores.map(e => `<tr>
            <td><span class="pc-mp pc-mp-${e.mp}">${MP_LABEL[e.mp]}</span> ${esc(e.store_name)}</td>
            <td>${num(e.sales_qty)}${e.returns_qty ? ` <span class="pc-muted">/ −${num(e.returns_qty)}</span>` : ''}</td>
            <td>${pr(e.sales_revenue)}</td>
            <td>${pr(e.sales_revenue - e.net_profit)}</td>
            <td>${pr(e.net_profit)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}`;
  }

  // ─── Правило репрайсера ─────────────────────────────────────────

  private tplRule(r: RepricerRule): string {
    const mp = r.marketplace?.toLowerCase() as Mp | undefined;
    const active = r.status === 'active';
    const f = (k: string, v: number | null | undefined) => v != null ? `<span>${k} <b>${pr(v)}</b></span>` : '';
    return `<div class="pc-mini">
      <div class="pc-mini-top">
        ${mp && MP_LABEL[mp] ? `<span class="pc-mp pc-mp-${mp}">${MP_LABEL[mp]}</span>` : ''}
        <b>${RULE_LABELS[r.type] ?? r.type}</b>
        <span class="pc-status ${active ? 'ok' : 'mid'}">${active ? 'работает' : 'на паузе'}</span>
      </div>
      <div class="pc-mini-f">${f('мин', r.minPrice)}${f('макс', r.maxPrice)}${f('сейчас', r.lastAppliedPrice)}</div>
    </div>`;
  }

  // ─── Поставщик ──────────────────────────────────────────────────

  private tplSupplier(s: SupplierLink): string {
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
    const fields: Array<[string, string]> = [];
    if (s.product) {
      if (s.product.internal_id != null) fields.push(['Внутр. ID', '#' + s.product.internal_id]);
      if (s.quantity) fields.push(['В упаковке', String(s.quantity)]);
      for (const [k, v] of Object.entries(s.product.field_values ?? {})) {
        const label = this.fieldDefNames.get(k) ?? (isUuid(k) ? null : k);
        const val = String(v ?? '').trim();
        if (label && val) fields.push([label, val]);
      }
      if (s.product.comment?.trim()) fields.push(['Комментарий', s.product.comment.trim()]);
    }
    if (s.producer?.contacts?.trim()) fields.push(['Контакты', s.producer.contacts.trim()]);
    const producerName = s.producer?.name && !isUuid(s.producer.name) ? s.producer.name : (s.producer ? 'Поставщик' : 'Без названия');
    const productName = s.product?.name && !isUuid(s.product.name) ? s.product.name : '';
    return `<div class="pc-mini">
      <div class="pc-mini-top">
        <b>${esc(producerName)}</b>${productName ? `<span class="pc-muted">${esc(productName)}</span>` : ''}
        <span class="pc-grow"></span>
        <button class="pc-linkbtn" onclick="window.app?.navigateTo('producers')">Открыть</button>
      </div>
      ${fields.length ? `<dl class="pc-facts tight">${fields.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    </div>`;
  }

  // ─── Tab: Card Edit ─────────────────────────────────────────────

  private initEditState(p: HubProduct, onlyStoreId?: string): void {
    if (!onlyStoreId) this.editState.clear();
    const art = p.article.toLowerCase();
    const lockedMps = this.lockedByMp.get(art) ?? new Set<Mp>();

    for (const entry of p.mp_entries) {
      if (onlyStoreId && entry.store_id !== onlyStoreId) continue;
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
          priceLocked: locked, saving: false, saveError: '', saveOk: false, saveNote: '',
          extraLoaded: false, extraLoading: false, // description still fetched on-demand
          dirtyFields: new Set(),
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
          priceLocked: locked, saving: false, saveError: '', saveOk: false, saveNote: '',
          extraLoaded: true, extraLoading: false, // description from DB — no API call needed
          dirtyFields: new Set(),
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
          priceLocked: locked, saving: false, saveError: '', saveOk: false, saveNote: '',
          extraLoaded: true, extraLoading: false, // all extra data from DB
          dirtyFields: new Set(),
        });
      }
    }
  }

  // ─── Вкладка «Редактирование» (15.10.2026, с нуля) ──────────────────
  //  По магазину — карточка с группами: основное, цена, вес и габариты, описание.
  //  Изменённые поля подсвечены, внизу — общая панель «Сохранить всё».

  private static readonly VAT_OZON: Array<[string, string]> = [['0', 'Без НДС'], ['0.05', '5%'], ['0.07', '7%'], ['0.1', '10%'], ['0.2', '20%'], ['0.22', '22%']];
  private static readonly VAT_YM: Array<[string, string]> = [['NO_VAT', 'Без НДС'], ['VAT_0', '0%'], ['VAT_10', '10%'], ['VAT_20', '20%']];

  private peInput(st: EditState, storeId: string, field: keyof EditState & string, o: { type?: string; step?: string; suffix?: string; ph?: string; ro?: boolean; min?: string; max?: string } = {}): string {
    const v = String((st as unknown as Record<string, unknown>)[field] ?? '');
    return `<span class="pe-input${o.ro ? ' ro' : ''}">
      <input class="pe-in${st.dirtyFields.has(field) ? ' pe-dirty' : ''}" type="${o.type ?? 'text'}" ${o.type === 'number' ? 'inputmode="decimal"' : ''}
        ${o.step ? `step="${o.step}"` : ''} ${o.min ? `min="${o.min}"` : ''} ${o.max ? `max="${o.max}"` : ''}
        data-ph-field="${field}" data-store-id="${esc(storeId)}" value="${esc(v)}" placeholder="${esc(o.ph ?? '')}" ${o.ro ? 'readonly tabindex="-1"' : ''}>
      ${o.suffix ? `<span class="pe-suffix">${o.suffix}</span>` : ''}
    </span>`;
  }

  private peField(label: string, control: string, o: { wide?: boolean; hint?: string } = {}): string {
    return `<label class="pe-field${o.wide ? ' wide' : ''}"><span class="pe-label">${label}</span>${control}${o.hint ? `<span class="pe-hint">${o.hint}</span>` : ''}</label>`;
  }

  private peGroup(title: string, body: string, note = ''): string {
    return `<div class="pe-group"><div class="pe-group-h"><span>${title}</span>${note ? `<em>${note}</em>` : ''}</div><div class="pe-grid">${body}</div></div>`;
  }

  /** Что увидит покупатель — пересчитывается на лету при вводе цены. */
  private pricePreview(st: EditState): string {
    const n = (v: string) => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) && x > 0 ? x : null; };
    const price = n(st.price);
    if (price == null) return 'Укажите цену';
    if (st.mp === 'wb') {
      const d = n(st.discount) ?? 0;
      return d > 0 ? `Цена со скидкой продавца: <b>${pr(Math.round(price * (1 - d / 100)))}</b> · без скидки ${pr(price)} (без учёта СПП)` : `Покупатель увидит <b>${pr(price)}</b> (без учёта СПП)`;
    }
    if (st.mp === 'ozon') {
      const old = n(st.old_price);
      const min = n(st.min_price);
      const disc = old && old > price ? Math.round((1 - price / old) * 100) : 0;
      return `На витрине <b>${pr(price)}</b>${disc ? `, зачёркнуто ${pr(old)} (−${disc}%)` : ''}${min ? ` · акции не опустят ниже ${pr(min)}` : ''}`;
    }
    return `Цена для покупателя <b>${pr(price)}</b> — общая для всех кампаний бизнеса`;
  }

  private peFoot(st: EditState, entry: MpStoreEntry, label = `Сохранить в ${MP_FULL[entry.mp]}`): string {
    const msg = st.saving ? `<span class="pe-msg">${I.loader('', 13)} Сохраняю…${entry.mp === 'ozon' ? ' Ozon проверяет изменения, это до 20 секунд' : ''}</span>`
      : st.saveError ? `<span class="pe-msg err">${I.alertTriangle('', 13)} ${esc(st.saveError)}</span>`
      : st.saveOk ? `<span class="pe-msg ok">${I.check('', 13)} Сохранено${st.saveNote ? `. ${esc(st.saveNote)}` : ''}</span>`
      : st.saveNote ? `<span class="pe-msg">${esc(st.saveNote)}</span>` : '';
    return `<div class="pe-foot">
      ${msg}
      <span class="pc-grow"></span>
      <button class="pc-btn pe-reset" data-ph-action="edit-reset" data-store-id="${esc(entry.store_id)}" ${st.saving ? 'disabled' : ''}>Отменить</button>
      <button class="pc-btn primary" data-ph-action="save-card" data-store-id="${esc(entry.store_id)}" data-mp="${entry.mp}" ${st.saving ? 'disabled' : ''}>
        ${st.saving ? 'Сохраняю…' : label}</button>
    </div>`;
  }

  private peHead(entry: MpStoreEntry, st: EditState | undefined, extra = ''): string {
    const collapsed = this.collapsedStores.has(entry.store_id);
    const syncing = !!this.syncing.get(entry.store_id);
    const at = this.lastSyncAt(entry.store_id);
    return `<header class="pe-head" data-ph-action="toggle-section" data-store-id="${esc(entry.store_id)}">
      <span class="pc-mp pc-mp-${entry.mp}">${MP_LABEL[entry.mp]}</span>
      <b class="pe-store-name">${esc(entry.store_name)}</b>
      ${extra}
      <span class="pe-dirty-chip cmp-edit-dirty-chip"${st && [...st.dirtyFields].some(f => f !== 'photos') ? '' : ' style="display:none"'}>не сохранено</span>
      <span class="pc-grow"></span>
      <span class="pe-synced" title="Когда данные магазина последний раз загружались из ${MP_FULL[entry.mp]}">${syncing ? 'обновляю…' : `данные: ${at ? fmtSyncDate(new Date(at).toISOString()) : 'нет'}`}</span>
      <button class="pe-icon" data-ph-action="sync-store" data-store-id="${esc(entry.store_id)}" data-mp="${entry.mp}" title="Загрузить свежие данные из ${MP_FULL[entry.mp]}" ${syncing ? 'disabled' : ''}>${I.refresh('', 13)}</button>
      <span class="cmp-section-arrow pe-arrow">${collapsed ? '▶' : '▼'}</span>
    </header>`;
  }

  private tplEditSection(entry: MpStoreEntry): string {
    const st = this.editState.get(entry.store_id);
    if (!st) {
      return `<section class="pe-store">${this.peHead(entry, undefined)}
        <div class="pe-body"><div class="pc-empty">Товара нет в загруженном каталоге магазина. Нажмите ${I.refresh('', 12)} справа, чтобы загрузить свежие данные.</div></div></section>`;
    }
    const mp = entry.mp;
    const sid = entry.store_id;
    const collapsed = this.collapsedStores.has(sid);
    const ro = (text: string, why: string) => `<span class="pe-input ro" title="${esc(why)}"><span class="pe-ro">${text ? esc(text) : '—'}</span>${I.lock('', 12)}</span>`;
    const select = (field: 'vat', opts: Array<[string, string]>) => {
      const cur = st[field];
      const all = cur && !opts.some(([v]) => v === cur) ? [...opts, [cur, cur] as [string, string]] : opts;
      return `<span class="pe-input"><select class="pe-in${st.dirtyFields.has(field) ? ' pe-dirty' : ''}" data-ph-field="${field}" data-store-id="${esc(sid)}">
        ${all.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select></span>`;
    };

    const main = [
      this.peField('Название', this.peInput(st, sid, 'name', { ph: 'Название товара' }), { wide: true, hint: mp === 'wb' ? 'WB показывает до 60 символов' : '' }),
      mp === 'ozon'
        ? this.peField('Бренд', ro(st.brand, 'На Ozon бренд — характеристика товара, меняется в личном кабинете'))
        : this.peField('Бренд', this.peInput(st, sid, 'brand', { ph: 'Бренд' })),
      mp === 'wb'
        ? this.peField('Штрихкод', ro(st.barcode, 'Штрихкоды WB меняются в личном кабинете'))
        : this.peField('Штрихкод', this.peInput(st, sid, 'barcode', { ph: '4600000000000' })),
      mp === 'ozon' ? this.peField('НДС', select('vat', ProductsHubModule.VAT_OZON)) : '',
      mp === 'yandex' ? this.peField('НДС', select('vat', ProductsHubModule.VAT_YM)) : '',
    ].join('');

    const lock = st.priceLocked ? `${I.lock('', 12)} цену ведёт репрайсер` : '';
    const price = [
      this.peField(mp === 'wb' ? 'Цена до скидки' : 'Цена', this.peInput(st, sid, 'price', { type: 'number', step: '1', min: '0', suffix: '₽', ro: st.priceLocked })),
      mp === 'ozon' ? this.peField('Зачёркнутая цена', this.peInput(st, sid, 'old_price', { type: 'number', step: '1', min: '0', suffix: '₽', ph: 'нет', ro: st.priceLocked })) : '',
      mp === 'ozon' ? this.peField('Минимальная цена', this.peInput(st, sid, 'min_price', { type: 'number', step: '1', min: '0', suffix: '₽', ph: 'не задана', ro: st.priceLocked }), { hint: 'ниже неё Ozon не опустит цену в акциях' }) : '',
      mp === 'wb' ? this.peField('Скидка продавца', this.peInput(st, sid, 'discount', { type: 'number', step: '1', min: '0', max: '95', suffix: '%', ph: '0', ro: st.priceLocked })) : '',
      `<div class="pe-preview wide" data-preview-store="${esc(sid)}">${this.pricePreview(st)}</div>`,
    ].join('');

    const dims = [
      this.peField('Вес', this.peInput(st, sid, 'weight_kg', { type: 'number', step: '0.001', min: '0', suffix: 'кг', ph: '0,000' })),
      this.peField('Длина', this.peInput(st, sid, 'length_cm', { type: 'number', step: '0.1', min: '0', suffix: 'см', ph: '0' })),
      this.peField('Ширина', this.peInput(st, sid, 'width_cm', { type: 'number', step: '0.1', min: '0', suffix: 'см', ph: '0' })),
      this.peField('Высота', this.peInput(st, sid, 'height_cm', { type: 'number', step: '0.1', min: '0', suffix: 'см', ph: '0' })),
    ].join('');

    const desc = `<label class="pe-field wide">
      <textarea class="pe-in pe-area${st.dirtyFields.has('description') ? ' pe-dirty' : ''}" data-ph-field="description" data-store-id="${esc(sid)}" rows="6"
        ${st.extraLoading ? 'disabled placeholder="Загружаю описание из Ozon…"' : 'placeholder="Опишите товар: материал, размеры, для кого и зачем"'}>${esc(st.description)}</textarea>
      <span class="pe-hint" data-count-for="${esc(sid)}">${st.description.length.toLocaleString('ru')} симв.</span>
    </label>
    ${mp === 'wb' && entry.characteristics?.length ? `<details class="pc-more wide"><summary>Характеристики WB · ${entry.characteristics.length} (меняются в кабинете WB)</summary>
      <dl class="pc-facts">${entry.characteristics.map(c => `<div><dt>${esc(c.name)}</dt><dd>${esc(c.value)}</dd></div>`).join('')}</dl></details>` : ''}`;

    return `
    <section class="pe-store${[...st.dirtyFields].some(f => f !== 'photos') ? ' dirty' : ''}" data-section-store="${esc(sid)}">
      ${this.peHead(entry, st)}
      <div class="cmp-edit-body pe-body"${collapsed ? ' style="display:none"' : ''}>
        ${this.peGroup('Основное', main)}
        ${this.peGroup('Цена', price, lock)}
        ${this.peGroup('Вес и габариты в упаковке', dims)}
        ${this.peGroup('Описание', desc)}
        ${this.peFoot(st, entry)}
      </div>
    </section>`;
  }

  /** Кампания Яндекс Маркета того же бизнеса: карточка общая — здесь только цена. */
  private tplEditSectionYmCompact(entry: MpStoreEntry, primaryName: string): string {
    const st = this.editState.get(entry.store_id);
    if (!st) return '';
    const sid = entry.store_id;
    return `
    <section class="pe-store${st.dirtyFields.size ? ' dirty' : ''}" data-section-store="${esc(sid)}">
      ${this.peHead(entry, st, `<span class="pe-shared">общая карточка с «${esc(primaryName)}»</span>`)}
      <div class="cmp-edit-body pe-body"${this.collapsedStores.has(sid) ? ' style="display:none"' : ''}>
        <p class="pe-note">Название, описание и фото общие для всего бизнеса — меняйте их в «${esc(primaryName)}». Цена тоже общая: Яндекс Маркет не даёт задать разные цены кампаниям через API.</p>
        ${this.peGroup('Цена', this.peField('Цена', this.peInput(st, sid, 'price', { type: 'number', step: '1', min: '0', suffix: '₽', ro: st.priceLocked })))}
        ${this.peFoot(st, entry, 'Сохранить цену')}
      </div>
    </section>`;
  }

  private editSectionsHtml(p: HubProduct): string {
    const nonYm = p.mp_entries.filter(e => e.mp !== 'yandex');
    const ymGroups = this.ymBusinessGroups(p.mp_entries.filter(e => e.mp === 'yandex'));
    return [
      ...nonYm.map(e => this.tplEditSection(e)),
      ...ymGroups.flatMap(({ primary, secondary }) => [
        this.tplEditSection(primary),
        ...secondary.map(e => this.tplEditSectionYmCompact(e, primary.store_name)),
      ]),
    ].join('') + this.tplSaveBar();
  }

  /** Плавающая панель «есть несохранённые изменения». */
  private tplSaveBar(): string {
    const dirty = [...this.editState.entries()].filter(([, s]) => s.dirtyFields.size && [...s.dirtyFields].some(f => f !== 'photos'));
    if (!dirty.length) return '<div class="pe-savebar" id="pe-savebar" hidden></div>';
    const p = this.items.find(x => x.article === this.selectedArticle);
    const names = dirty.map(([sid]) => p?.mp_entries.find(e => e.store_id === sid)?.store_name ?? '').filter(Boolean);
    const saving = dirty.some(([, s]) => s.saving);
    return `<div class="pe-savebar" id="pe-savebar">
      <span>${I.edit('', 14)} Не сохранено: ${esc(names.join(', '))}</span>
      <span class="pc-grow"></span>
      <span class="pe-kbd">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S</span>
      <button class="pc-btn primary" data-ph-action="save-all" ${saving ? 'disabled' : ''}>${saving ? 'Сохраняю…' : dirty.length > 1 ? 'Сохранить всё' : 'Сохранить'}</button>
    </div>`;
  }

  private updateSaveBar(): void {
    const bar = this.cardEl?.querySelector<HTMLElement>('#pe-savebar');
    if (bar) bar.outerHTML = this.tplSaveBar();
  }

  /** Сохранить все магазины с изменениями (кнопка на панели и ⌘S). */
  private saveAllDirty(): void {
    const article = this.selectedArticle;
    if (!article) return;
    for (const [storeId, st] of this.editState) {
      if (st.saving) continue;
      if ([...st.dirtyFields].some(f => f !== 'photos')) this.doSaveCard(article, storeId, st.mp);
    }
  }

  private tplCardEdit(p: HubProduct): string {
    if (!this.editState.size) this.initEditState(p);
    if (!p.mp_entries.length) return `<div class="pc-empty big">Товара нет ни в одном магазине — редактировать нечего.</div>`;
    return `<div class="pe" id="ph-card-edit-content">${this.editSectionsHtml(p)}</div>`;
  }

  // ─── Filter panel ────────────────────────────────────────────────

  private chip(label: string, active: boolean, fAttr: string, val?: string): string {
    const data = val !== undefined ? `data-f="${fAttr}" data-val="${esc(val)}"` : `data-f="${fAttr}"`;
    return `<span class="ph-f-chip${active ? ' on' : ''}" ${data}>${label}</span>`;
  }

  private tplFilterPanel(): string {
    const f = this.filters;
    const activeCount = this.countActiveFilters();
    // Площадка, магазин, остаток, себестоимость и сортировка — в шапке, быстрых
    // фильтрах и заголовках таблицы. Здесь только то, что нужно реже.
    return `
    <div class="ph-fp-inner">
      <div class="ph-fp-groups">
        <div class="ph-fp-group">
          <div class="ph-fp-label">Статус на маркетплейсе</div>
          <div class="ph-fp-chips">
            ${this.chip('Любой', f.status === '', 'status', '')}
            ${this.chip('В продаже', f.status === 'В продаже', 'status', 'В продаже')}
            ${this.chip('Нет в наличии', f.status === 'Нет в наличии', 'status', 'Нет в наличии')}
            ${this.chip('В архиве / скрыт', f.status === 'В архиве', 'status', 'В архиве')}
          </div>
        </div>
        <div class="ph-fp-group">
          <div class="ph-fp-label">Цена, ₽</div>
          <div class="ph-fp-price">
            <input id="ph-f-pmin" type="number" class="ph-fp-inp" placeholder="от" value="${f.price_min ?? ''}">
            <span class="ph-fp-sep">—</span>
            <input id="ph-f-pmax" type="number" class="ph-fp-inp" placeholder="до" value="${f.price_max ?? ''}">
          </div>
        </div>
        <div class="ph-fp-group">
          <div class="ph-fp-label">Ещё</div>
          <div class="ph-fp-chips">
            ${this.chip('Нет на маркетплейсах', f.no_mp, 'toggle', 'no_mp')}
            ${this.chip('Без правил репрайсера', f.no_repricer, 'toggle', 'no_repricer')}
          </div>
        </div>
        ${activeCount > 0 ? `<button class="ph-f-reset" id="ph-f-reset">✕ Сбросить</button>` : ''}
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
        if (f === 'mp')     { this.filters.mp = val as any; this.filters.store_id = ''; }
        if (f === 'store')  this.filters.store_id = val;
        if (f === 'status') this.filters.status  = val;
        if (f === 'stock')  this.filters.stock   = val as any;
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
        // Сбрасываем только фильтры этой панели — площадка, поиск и быстрые фильтры остаются.
        Object.assign(this.filters, { no_mp: false, no_repricer: false, status: '', price_min: null, price_max: null });
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
    return [f.status, f.price_min != null, f.price_max != null, f.no_mp, f.no_repricer].filter(Boolean).length;
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
    const lastAt = this.lastSyncAt(primaryStoreId);
    const syncedAt = fmtSyncDate(lastAt ? new Date(lastAt).toISOString() : null);
    const storeLabel = [entry.store_name, ...extraNames].join(' · ');
    return `
    <div class="cmp-photo-section">
      <div class="cmp-photo-hdr">
        <span class="cmp-mp-badge cmp-mp-badge--${mp}">${mpLabel}</span>
        <span class="cmp-photo-store">${esc(storeLabel)}</span>
        <span class="cmp-photo-sync">· данные: ${syncedAt}</span>
        ${extraNames.length ? `<span class="cmp-photo-shared-note">общая карточка</span>` : ''}
        ${st.dirtyFields.has('photos') ? '<span class="pe-dirty-chip">не сохранено</span>' : ''}
        ${st.saving ? '<span class="cmp-spinner-sm"></span>' : ''}
        ${st.saveError ? `<span class="cmp-photo-err">${esc(st.saveError)}</span>` : ''}
      </div>
      <div class="cmp-photo-grid">
        ${photos.length === 0 ? '<div class="cmp-photo-none">Фото нет</div>' : ''}
        ${photos.map((url, idx) => `
          <div class="cmp-photo-cell" data-drag-idx="${idx}" data-drag-store-id="${primaryStoreId}" title="Зажмите и перетащите, чтобы поменять порядок">
            <div class="cmp-photo-wrap" data-ph-action="open-lightbox" data-url="${esc(url)}">
              <img src="${esc(url)}" loading="lazy" alt="" draggable="false">
              <span class="cmp-photo-num">${idx + 1}</span>
            </div>
            <div class="cmp-photo-ctrl">
              <span class="cmp-drag-handle" title="Перетащить">⠿</span>
              <button class="cmp-pbtn cmp-pbtn--del" data-ph-action="photo-delete" data-idx="${idx}" data-store-id="${primaryStoreId}" title="Удалить">✕</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="cmp-photo-acts">
        <button class="pc-btn" data-ph-action="photo-add-toggle" data-store-id="${primaryStoreId}">${I.plus('', 14)} Добавить фото</button>
        <span class="pe-hint">${photos.length > 1 ? 'Первое фото — главное. Зажмите фото и перетащите, чтобы поменять порядок' : ''}</span>
        <span class="pc-grow"></span>
        ${photos.length > 0 ? `
          <button class="pc-btn primary" data-ph-action="save-photos" data-store-id="${primaryStoreId}" data-mp="${mp}" ${st.saving || !st.dirtyFields.has('photos') ? 'disabled' : ''}>
            ${st.saving ? 'Сохраняю…' : st.dirtyFields.has('photos') ? `Сохранить в ${MP_FULL[mp]}` : 'Сохранено'}
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

  /**
   * Перестановка фото. Раньше было HTML5 drag-and-drop: тащилась сама картинка
   * (ссылка), бросить можно было только точно на другое фото, и до отпускания
   * не было видно, куда встанет. Теперь фото едет за курсором, соседи
   * раздвигаются на лету, а порядок сохраняется при отпускании.
   */
  private photoDragStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.cmp-photo-cell');
    if (!cell || (e.target as HTMLElement).closest('button')) return;
    const grid = cell.parentElement!;
    const storeId = cell.dataset.dragStoreId ?? '';
    const st = this.editState.get(storeId);
    if (!st || st.saving) return;
    const x0 = e.clientX, y0 = e.clientY;
    const drawer = this.el.querySelector<HTMLElement>('#ph2-drawer');
    let ghost: HTMLElement | null = null;
    let dx = 0, dy = 0;
    let raf = 0, lastX = x0, lastY = y0;

    const cells = () => [...grid.querySelectorAll<HTMLElement>('.cmp-photo-cell')];
    const flip = (move: () => void) => {
      const before = new Map(cells().map(c => [c, c.getBoundingClientRect()]));
      move();
      for (const c of cells()) {
        if (c === cell) continue;
        const a = before.get(c); const b = c.getBoundingClientRect();
        if (!a || (a.left === b.left && a.top === b.top)) continue;
        c.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
      }
    };
    const begin = () => {
      const r = cell.getBoundingClientRect();
      dx = x0 - r.left; dy = y0 - r.top;
      ghost = cell.cloneNode(true) as HTMLElement;
      ghost.classList.add('pe-ghost');
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: '0', top: '0' });
      document.body.appendChild(ghost);
      cell.classList.add('pe-placeholder');
      document.body.classList.add('pe-dragging');
    };
    const step = () => {
      raf = 0;
      if (!ghost) return;
      ghost.style.transform = `translate(${lastX - dx}px, ${lastY - dy}px) rotate(2deg) scale(1.04)`;
      // Автопрокрутка у краёв карточки
      if (drawer) {
        const r = drawer.getBoundingClientRect();
        if (lastY < r.top + 60) drawer.scrollTop -= 12;
        else if (lastY > r.bottom - 60) drawer.scrollTop += 12;
      }
      // Ближайшее фото под курсором → встаём перед ним или после
      let best: HTMLElement | null = null, bestD = Infinity;
      for (const c of cells()) {
        if (c === cell) continue;
        const b = c.getBoundingClientRect();
        const d = Math.hypot(lastX - (b.left + b.width / 2), lastY - (b.top + b.height / 2));
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best && bestD < best.getBoundingClientRect().width) {
        const b = best.getBoundingClientRect();
        const after = lastX > b.left + b.width / 2;
        const ref = after ? best.nextElementSibling : best;
        if (ref !== cell && ref !== cell.nextElementSibling) flip(() => grid.insertBefore(cell, ref));
      }
      if (ghost) raf = requestAnimationFrame(step);
    };
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!ghost) {
        if (Math.hypot(lastX - x0, lastY - y0) < 6) return;
        begin();
      }
      ev.preventDefault();
      if (!raf) raf = requestAnimationFrame(step);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      cancelAnimationFrame(raf); raf = 0;
      ghost.remove(); ghost = null;
      cell.classList.remove('pe-placeholder');
      document.body.classList.remove('pe-dragging');
      // Клик после перетаскивания не должен открывать просмотр фото
      const eat = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', eat, { capture: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 60);
      const order = cells().map(c => +(c.dataset.dragIdx ?? -1)).filter(i => i >= 0);
      if (order.some((v, i) => v !== i)) {
        st.photos = order.map(i => st.photos[i]);
        st.dirtyFields.add('photos');
        st.saveError = '';
      }
      this.refreshPhotosTab2();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
    if (this.activeTab !== 'card-edit' || !this.selectedArticle) { this.updateSaveBar(); return; }
    const p = this.items.find(x => x.article === this.selectedArticle);
    const el = this.cardEl?.querySelector<HTMLElement>('#ph-card-edit-content');
    if (!p || !el) return;
    el.innerHTML = this.editSectionsHtml(p);
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
      try { localStorage.setItem(`ph_autosync_${storeId}`, new Date().toISOString()); } catch { /* ignore */ }
      await this.load({ quiet: true });
    } catch (e: unknown) {
      this.syncErr.set(storeId, (e instanceof Error ? e.message : String(e))?.slice(0, 60) ?? 'Ошибка');
    } finally {
      this.syncing.set(storeId, false);
      this.updateSyncBarInCard();
    }
  }

  private updateSyncBarInCard(): void {
    this.refreshOpenCardChrome();
  }

  // ─── Save card ────────────────────────────────────────────────────

  /**
   * Сохранить карточку в магазин. Отправляем ТОЛЬКО изменённые поля:
   * раньше каждое сохранение заново слало цену (а на Ozon ещё и мин. цену = цене)
   * и всю карточку — даже если поменяли одну букву в названии.
   */
  private async doSaveCard(article: string, storeId: string, mp: 'ozon' | 'wb' | 'yandex'): Promise<void> {
    const st = this.editState.get(storeId);
    if (!st || st.saving) return;
    const d = new Set([...st.dirtyFields].filter(f => f !== 'photos'));
    if (!d.size) { st.saveOk = false; st.saveError = ''; st.saveNote = 'Изменений нет'; this.refreshEditTab(); return; }

    const has = (...f: string[]) => f.some(x => d.has(x));
    const numOrNull = (v: string) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
    // Проверка до отправки — понятная ошибка вместо отказа маркетплейса
    const problems: string[] = [];
    if (has('name') && !st.name.trim()) problems.push('название не может быть пустым');
    if (has('price', 'old_price', 'min_price', 'discount')) {
      const price = numOrNull(st.price);
      if (price == null || price <= 0) problems.push('укажите цену больше нуля');
      const old = st.old_price ? numOrNull(st.old_price) : null;
      if (mp === 'ozon' && old != null && price != null && old > 0 && old <= price) problems.push('старая цена должна быть больше текущей (или оставьте поле пустым)');
      const min = st.min_price ? numOrNull(st.min_price) : null;
      if (mp === 'ozon' && min != null && price != null && min > price) problems.push('минимальная цена не может быть больше цены');
      const disc = st.discount ? numOrNull(st.discount) : 0;
      if (mp === 'wb' && (disc == null || disc < 0 || disc > 95)) problems.push('скидка WB — от 0 до 95%');
    }
    for (const f of ['weight_kg', 'length_cm', 'width_cm', 'height_cm'] as const) {
      if (d.has(f) && st[f] && !(numOrNull(st[f])! > 0)) problems.push('вес и габариты — положительные числа');
    }
    if (problems.length) {
      st.saveError = `Не сохранено: ${[...new Set(problems)].join('; ')}`;
      st.saveOk = false; st.saveNote = '';
      this.refreshEditTab();
      return;
    }

    st.saving = true; st.saveError = ''; st.saveOk = false; st.saveNote = '';
    this.refreshEditTab();
    const sentFields = new Set(d);
    try {
      const n = (v: string) => numOrNull(v);
      const dimsDirty = has('weight_kg', 'length_cm', 'width_cm', 'height_cm');
      const dims: Dimensions = {
        weight_g:  st.weight_kg ? Math.round(n(st.weight_kg)! * 1000) : null,
        length_mm: st.length_cm ? Math.round(n(st.length_cm)! * 10)   : null,
        width_mm:  st.width_cm  ? Math.round(n(st.width_cm)!  * 10)   : null,
        height_mm: st.height_cm ? Math.round(n(st.height_cm)! * 10)   : null,
      };
      const hubEntry = () => this.items.find(x => x.article.toLowerCase() === article.toLowerCase())?.mp_entries.find(e => e.store_id === storeId);
      const priceDirty = has('price', 'old_price', 'min_price', 'discount') && !st.priceLocked;

      if (mp === 'ozon') {
        const store = this.ozStores.find((s: any) => s.id === storeId);
        const prod  = this.ozProds.find((x: any) => x.store_id === storeId && String(x.offer_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Товар не найден в каталоге магазина — обновите каталог');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const tasks: number[] = [];

        // Название, НДС, габариты и описание — одной задачей, поверх текущей карточки
        const descDirty = has('description') && st.extraLoaded;
        if (has('name', 'vat') || dimsDirty || descDirty) {
          const t = await ozonApi.updateCardMerged(creds, article, prod.product_id ?? null, {
            ...(has('name') ? { name: st.name.trim() } : {}),
            ...(has('vat') ? { vat: st.vat } : {}),
            ...(descDirty ? { description: st.description } : {}),
            // Новая цена — и в импорт, иначе он может вернуть старую поверх обновления цен
            ...(priceDirty ? { price: String(n(st.price)), old_price: st.old_price ? String(n(st.old_price)) : '0' } : {}),
            ...(dimsDirty ? { weight_g: dims.weight_g, depth_mm: dims.length_mm, width_mm: dims.width_mm, height_mm: dims.height_mm } : {}),
          });
          if (t) tasks.push(t);
        }
        if (has('barcode') && st.barcode && st.barcode !== (prod.barcode ?? '')) {
          if (!prod.sku) throw new Error('У товара ещё нет SKU Ozon — штрихкод можно поменять после модерации');
          await ozonApi.updateBarcode(creds, prod.sku, st.barcode.trim());
          prod.barcode = st.barcode.trim();
        }
        if (priceDirty) {
          await ozonApi.updatePrices(creds, [{
            offer_id: article,
            price: String(n(st.price)),
            old_price: st.old_price ? String(n(st.old_price)) : '0',
            ...(st.min_price ? { min_price: String(n(st.min_price)) } : {}),
          }]);
          const e = hubEntry();
          if (e) { e.price = n(st.price); e.old_price = st.old_price ? n(st.old_price) : null; }
          prod.price = n(st.price); prod.old_price = st.old_price ? n(st.old_price) : null;
          if (st.min_price) prod.min_price = n(st.min_price);
        }
        // Ждём, что Ozon реально принял правки, — ошибки модерации показываем
        let pending = false;
        for (const t of tasks) if (await ozonApi.waitImportTask(creds, t) === 'pending') pending = true;
        if (has('name')) prod.name = st.name.trim();
        if (has('vat')) prod.vat = st.vat;
        if (dimsDirty) {
          prod.weight_kg = st.weight_kg ? n(st.weight_kg) : prod.weight_kg;
          prod.length_cm = st.length_cm ? n(st.length_cm) : prod.length_cm;
          prod.width_cm  = st.width_cm  ? n(st.width_cm)  : prod.width_cm;
          prod.height_cm = st.height_cm ? n(st.height_cm) : prod.height_cm;
        }
        if (pending) st.saveNote = 'Ozon принял изменения и ещё обрабатывает их — на сайте появятся через несколько минут';

      } else if (mp === 'wb') {
        const store = this.wbStores.find((s: any) => s.id === storeId);
        const prod  = this.wbProds.find((x: any) => x.store_id === storeId &&
          String(x.vendor_code ?? x.nm_id ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Товар не найден в каталоге магазина — обновите каталог');
        if (!prod.nm_id) throw new Error('У товара нет nmID — обновите каталог WB');
        if (has('name', 'brand', 'description') || dimsDirty) {
          const upd: Parameters<typeof wbApi.updateCard>[2] = {};
          if (has('name')) upd.title = st.name.trim();
          if (has('brand')) upd.brand = st.brand.trim();
          if (has('description')) upd.description = st.description;
          if (dimsDirty) {
            const wb = toWb(dims);
            if (wb.length != null || wb.width != null || wb.height != null) {
              upd.dimensions = {
                length: wb.length != null ? Math.round(wb.length) : 0,
                width:  wb.width  != null ? Math.round(wb.width)  : 0,
                height: wb.height != null ? Math.round(wb.height) : 0,
              };
            }
            if (wb.weight_kg != null) upd.weightBrutto = wb.weight_kg;
          }
          await wbApi.updateCard(store.api_key, prod.nm_id, upd);
        }
        if (priceDirty) {
          const discount = st.discount ? Math.round(n(st.discount)!) : 0;
          await updateWbPrices(store.api_key, [{ nmID: prod.nm_id, price: Math.round(n(st.price)!), discount }]);
          const e = hubEntry();
          if (e) {
            // WB: entry.price — цена покупателя (со скидкой), entry.old_price — базовая
            const base = Math.round(n(st.price)!);
            e.old_price = discount > 0 ? base : null;
            e.price = discount > 0 ? Math.round(base * (1 - discount / 100)) : base;
          }
          prod.price = n(st.price); prod.discount = discount;
        }
        if (dimsDirty) {
          prod.weight_kg = st.weight_kg ? n(st.weight_kg) : prod.weight_kg;
          prod.length_cm = st.length_cm ? n(st.length_cm) : prod.length_cm;
          prod.width_cm  = st.width_cm  ? n(st.width_cm)  : prod.width_cm;
          prod.height_cm = st.height_cm ? n(st.height_cm) : prod.height_cm;
        }
        if (has('name')) prod.title = st.name.trim();
        if (has('brand')) prod.brand = st.brand.trim();
        if (has('description')) prod.description = st.description;
        st.saveNote = 'WB обновит карточку на сайте в течение нескольких минут';

      } else {
        const store = this.ymStores.find((s: any) => s.id === storeId);
        const prod  = this.ymProds.find((x: any) => x.store_id === storeId &&
          String(x.offer_id ?? x.vendor_code ?? '').trim().toLowerCase() === article.toLowerCase());
        if (!store || !prod) throw new Error('Товар не найден в каталоге магазина — обновите каталог');
        if (!store.business_id) throw new Error('У магазина Яндекс Маркета не указан business_id — переподключите магазин');
        if (has('name', 'brand', 'description', 'barcode', 'vat') || dimsDirty) {
          const offer: Record<string, unknown> = { offerId: article };
          if (dimsDirty) {
            const ym = toYm(dims);
            const wd: Record<string, number> = {};
            if (ym.length != null) wd.length = ym.length;
            if (ym.width  != null) wd.width  = ym.width;
            if (ym.height != null) wd.height = ym.height;
            if (ym.weight != null) wd.weight = ym.weight;
            if (Object.keys(wd).length) offer.weightDimensions = wd;
          }
          if (has('name')) offer.name = st.name.trim();
          if (has('brand')) offer.vendor = st.brand.trim();
          if (has('description')) offer.description = st.description;
          if (has('barcode') && st.barcode) offer.barcodes = [st.barcode.trim()];
          if (has('vat') && st.vat) offer.tax = { vatType: st.vat };
          await yandexApi.updateOffer(store.api_key, store.business_id, offer);
        }
        // Цена в Яндекс Маркете общая для всего бизнеса — обновляем во всех его кампаниях
        if (priceDirty) {
          await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id ?? ''), [{ offerId: article, price: n(st.price)! }]);
          const bid = store.business_id;
          this.items.find(x => x.article.toLowerCase() === article.toLowerCase())
            ?.mp_entries.filter(e => e.mp === 'yandex' && (this.ymStores as any[]).find(s => s.id === e.store_id)?.business_id === bid)
            .forEach(e => { e.price = n(st.price); });
          prod.basic_price = n(st.price);
        }
        if (dimsDirty) {
          prod.weight_kg = st.weight_kg ? n(st.weight_kg) : prod.weight_kg;
          prod.length_cm = st.length_cm ? n(st.length_cm) : prod.length_cm;
          prod.width_cm  = st.width_cm  ? n(st.width_cm)  : prod.width_cm;
          prod.height_cm = st.height_cm ? n(st.height_cm) : prod.height_cm;
        }
        if (has('name')) prod.name = st.name.trim();
        if (has('brand')) prod.vendor = st.brand.trim();
        if (has('description')) prod.description = st.description;
        if (has('barcode')) prod.barcode = st.barcode.trim();
        if (has('vat')) prod.vat = st.vat;
      }

      // Карточка в разделе — сразу с новыми данными
      const hub = this.items.find(x => x.article.toLowerCase() === article.toLowerCase());
      if (hub) {
        if (dimsDirty) {
          if (dims.weight_g)  hub.weight_kg = dims.weight_g / 1000;
          if (dims.length_mm) hub.length_cm = dims.length_mm / 10;
          if (dims.width_mm)  hub.width_cm  = dims.width_mm / 10;
          if (dims.height_mm) hub.height_cm = dims.height_mm / 10;
        }
        if (has('name') && st.name.trim()) hub.name = st.name.trim();
        if (has('barcode') && st.barcode.trim()) hub.barcode = st.barcode.trim();
        const e = hub.mp_entries.find(x => x.store_id === storeId);
        if (e) {
          if (has('description')) e.description = st.description;
          if (has('vat')) e.vat = st.vat;
          if (has('barcode')) e.barcode = st.barcode.trim();
        }
      }
      if (st.extraLoaded) {
        const ck = `${storeId}:${article}`;
        const extra = mp === 'ozon' ? { vat: st.vat } : { description: st.description };
        this.extraDataCache.set(ck, { ...this.extraDataCache.get(ck), ...extra });
      }
      for (const f of sentFields) st.dirtyFields.delete(f);
      st.saveOk = true;
      this.totalsCache.delete(article);
      this.renderListItems();
    } catch (e: unknown) {
      st.saveError = (e instanceof Error ? e.message : String(e)) || 'Ошибка сохранения';
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
        if (!prod.product_id) throw new Error('Нет ID товара Ozon — обновите каталог');
        // Отдельный метод для фото: импорт карточки с одними фото мог затереть остальное
        await ozonApi.importPictures({ client_id: store.client_id, api_key: store.api_key }, prod.product_id, urls);
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
      if (!pendingLocal.length) st.dirtyFields.delete('photos');
      // Главное фото в карточке и таблице — сразу новое
      const hub = this.items.find(x => x.article.toLowerCase() === article.toLowerCase());
      const he = hub?.mp_entries.find(e => e.store_id === storeId);
      if (he) he.images = [...urls];
      if (hub && urls[0]) hub.image_url = urls[0];
      showToast(mp === 'ozon' ? 'Фото отправлены в Ozon — обновятся после обработки' : 'Фото сохранены', 'success');
      if (pendingLocal.length > 0) {
        st.saveError = `${pendingLocal.length} фото не удалось загрузить — попробуйте ещё раз`;
      }
    } catch (e: unknown) {
      st.saveError = (e instanceof Error ? e.message : String(e)) ?? 'Ошибка сохранения фото';
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
    try { localStorage.setItem('ph_hidden_articles', JSON.stringify([...this.hiddenArticles])); } catch { /* не критично */ }
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
      showToast(`Ошибка экспорта: ${(e instanceof Error ? e.message : String(e)) ?? e}`, 'error');
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
          try { costPriceDb.set(article, cost); } catch { /* не критично */ }
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
            try { customColumnsDb.setValue(article, cf.id, val); } catch { /* не критично */ }
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
      showToast(`Ошибка импорта: ${(e instanceof Error ? e.message : String(e)) ?? e}`, 'error');
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
        if (n('cost') !== null) { try { costPriceDb.set(article, n('cost')!); } catch { /* не критично */ } p.cost_price = n('cost'); p.has_cost = true; }
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
          const st = this.editState.get(storeId);
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
          try { customColumnsDb.setValue(article, cfId, val); } catch { /* не критично */ }
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

  /**
   * Применить фильтры из команды Симы.
   * q — поиск по артикулу/названию, mp — маркетплейс, stock — 'pos'/'zero'/'any'.
   * Возвращает текст-сводку: сколько товаров показано.
   */
  aiFilter(a: { q?: string; mp?: string; stock?: 'pos' | 'zero' | 'any'; reset?: boolean }): string {
    if (a.reset) {
      this.filters = { q: '', mp: '', store_id: '', no_cost: false, no_mp: false, no_repricer: false, status: '', stock: 'any', price_min: null, price_max: null };
      const searchEl = this.el.querySelector<HTMLInputElement>('#ph-search');
      if (searchEl) searchEl.value = '';
    } else {
      if (a.q !== undefined) {
        this.filters.q = a.q.toLowerCase().trim();
        const searchEl = this.el.querySelector<HTMLInputElement>('#ph-search');
        if (searchEl) searchEl.value = a.q.trim();
      }
      if (a.mp !== undefined) {
        const normMp = a.mp.toLowerCase()
          .replace(/яндекс.*маркет|ym/g, 'yandex')
          .replace(/wildberries|вб|wb/g, 'wb')
          .replace(/озон/g, 'ozon')
          .replace(/all|все|сброс/g, '') as any;
        this.filters.mp = normMp;
      }
      if (a.stock !== undefined) {
        this.filters.stock = a.stock;
      }
    }
    this.applyFilters();
    this.renderList(true);
    this.updateFilterBadge();

    const total = this.items.length;
    const shown = this.filtered.length;
    const parts: string[] = [];
    if (a.reset) parts.push('Фильтры сброшены');
    if (a.q) parts.push(`поиск «${a.q}»`);
    if (a.mp && a.mp !== '') parts.push(`маркетплейс: ${a.mp}`);
    if (a.stock === 'pos') parts.push('с остатками');
    if (a.stock === 'zero') parts.push('без остатков (OOS)');
    const desc = parts.length ? ` (${parts.join(', ')})` : '';
    return `Показано ${shown} из ${total} товаров${desc}.`;
  }

  /**
   * Открыть карточку товара по артикулу — для перехода из других разделов
   * (аналитика, заказы). Дожидается загрузки списка, ставит поиск по артикулу
   * и выбирает товар. Возвращает false, если такого артикула в каталоге нет.
   */
  async focusArticle(article: string): Promise<boolean> {
    const want = String(article ?? '').trim();
    if (!want) return false;
    const deadline = Date.now() + 20_000;
    while ((this.loading || !this.items.length) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
    }
    const norm = want.toLowerCase();
    const item = this.items.find(x => x.article === want) ?? this.items.find(x => x.article.toLowerCase() === norm);
    this.aiFilter({ q: item?.article ?? want });
    if (!item) return false;
    this.selectProduct(item.article);
    requestAnimationFrame(() => {
      this.el.querySelector('.ph-row.active')?.scrollIntoView({ block: 'nearest' });
    });
    return true;
  }

}
