import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { costPriceDb } from '@/services/costPriceDb';
import { customColumnsDb } from '@/services/customColumnsDb';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import { dimensionsDb } from '@/services/dimensionsDb';
import { mpTransactionsDb, type MpTransaction } from '@/services/mpTransactionsDb';
import { producerDb, producerProductDb, producerMappingDb, type Producer, type ProducerProduct, type ProducerMapping } from '@/services/producerDb';
import { boxes } from '@/stores/appStore';
import { RULE_LABELS } from '@/modules/repricer/types';
import type { RepricerRule } from '@/modules/repricer/types';

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
  no_box: boolean;
}

type Tab = 'overview' | 'stores' | 'finance' | 'groups';
type PeriodDays = 7 | 30 | 90 | 180;

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const ROW_H     = 70;
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
  private filters: Filters = { q: '', mp: '', no_cost: false, no_mp: false, no_repricer: false, no_box: false };
  private loading = false;
  private listScrollTop = 0;
  private listContainerH = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listEl: HTMLElement | null = null;
  private cardEl: HTMLElement | null = null;
  private period: PeriodDays = DEFAULT_PERIOD;
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

  constructor(private el: HTMLElement) {
    const saved = +(localStorage.getItem(PERIOD_KEY) ?? '0') as PeriodDays;
    if (PERIOD_OPTIONS.some(o => o.value === saved)) this.period = saved;
  }

  show(): void {
    this.el.style.display = 'flex';
    if (!this.listEl) {
      this.renderShell();
      this.load();
      if (!localStorage.getItem(HELP_KEY)) this.showHelp();
    } else {
      this.applyFilters();
      this.renderList();
    }
  }

  hide(): void { this.el.style.display = 'none'; }

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

        <select id="ph-mp" class="ph-select">
          <option value="">Все площадки</option>
          <option value="ozon">Ozon</option>
          <option value="wb">Wildberries</option>
          <option value="yandex">Яндекс Маркет</option>
        </select>

        <button id="f-no-cost"     class="ph-chip">Без себест.</button>
        <button id="f-no-mp"       class="ph-chip">Нет на МП</button>
        <button id="f-no-repricer" class="ph-chip">Без репрайсера</button>
        <button id="f-no-box"      class="ph-chip">Без группы</button>

        <select id="ph-period" class="ph-select" title="Период анализа продаж и финансов">
          ${PERIOD_OPTIONS.map(o => `<option value="${o.value}"${this.period === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>

        <span id="ph-count" class="ph-count"></span>
        <button id="ph-help-btn" class="ph-iconbtn" title="Как пользоваться">${I.help('', 15)}</button>
        <button id="ph-reload"   class="ph-iconbtn" title="Обновить">${I.refresh('', 15)}</button>
      </div>

      <div class="ph-body">
        <div class="ph-list-wrap">
          <div id="ph-list" class="ph-list">
            <div id="ph-spacer" style="width:1px;pointer-events:none"></div>
            <div id="ph-items" style="position:absolute;top:0;left:0;right:0"></div>
          </div>
        </div>
        <div id="ph-card" class="ph-card"></div>
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

    get<HTMLSelectElement>('ph-mp').addEventListener('change', e => {
      this.filters.mp = (e.target as HTMLSelectElement).value as any;
      this.applyFilters();
      this.renderList(true);
    });

    get<HTMLSelectElement>('ph-period').addEventListener('change', e => {
      const v = +(e.target as HTMLSelectElement).value as PeriodDays;
      if (!PERIOD_OPTIONS.some(o => o.value === v)) return;
      this.period = v;
      try { localStorage.setItem(PERIOD_KEY, String(v)); } catch {}
      this.reaggregateSales();
    });

    const tog = (id: string, key: keyof Filters) => {
      const btn = get<HTMLButtonElement>(id);
      btn.addEventListener('click', () => {
        (this.filters as any)[key] = !(this.filters as any)[key];
        btn.classList.toggle('on', !!(this.filters as any)[key]);
        this.applyFilters();
        this.renderList(true);
      });
    };
    tog('f-no-cost', 'no_cost');
    tog('f-no-mp', 'no_mp');
    tog('f-no-repricer', 'no_repricer');
    tog('f-no-box', 'no_box');

    get('ph-reload').addEventListener('click', () => this.load());
    get('ph-help-btn').addEventListener('click', () => this.showHelp());
    get('ph-help-close').addEventListener('click', () => this.hideHelp());
    get('ph-help-ok').addEventListener('click', () => this.hideHelp());
    get('ph-help').addEventListener('click', e => { if (e.target === get('ph-help')) this.hideHelp(); });

    this.listEl!.addEventListener('scroll', () => {
      this.listScrollTop = this.listEl!.scrollTop;
      this.renderListItems();
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

      // 3. Загружаем транзакции на максимальный поддерживаемый период (180 дней),
      // потом локально фильтруем по this.period — селектор не дёргает сервер.
      const MAX_DAYS = 180;
      const dateTo   = new Date().toISOString();
      const dateFrom = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString();
      const [transactions, producers, producerProds, producerMaps] = await Promise.all([
        allStoreIds.length ? mpTransactionsDb.getByStores(allStoreIds, dateFrom, dateTo).catch(() => [] as MpTransaction[]) : Promise.resolve([]),
        producerDb.list().catch(() => [] as Producer[]),
        producerProductDb.list().catch(() => [] as ProducerProduct[]),
        producerMappingDb.list().catch(() => [] as ProducerMapping[]),
      ]);

      // 4. Build the product map
      const map = new Map<string, HubProduct>();
      const buildEntry = (mp: Mp, store_id: string, store_name: string): MpStoreEntry => ({
        mp, store_id, store_name,
        price: null, old_price: null,
        stock_fbs: 0, stock_fbo: 0, stock_total: 0, stock_available: 0,
        status: null, images: [], url: null,
        sales_qty: 0, sales_revenue: 0, returns_qty: 0,
        commission: 0, delivery: 0, services: 0, net_profit: 0,
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
        e.price = wp.price ?? null;
        e.stock_total = wp.stock_total ?? 0;
        e.stock_available = e.stock_total;
        e.status = wp.discount ? `Скидка ${wp.discount}%` : null;
        e.images = wp.pictures ?? [];
        e.url = wp.nm_id ? `https://www.wildberries.ru/catalog/${wp.nm_id}/detail.aspx` : null;
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
        e.status = yp.archived ? 'В архиве' : null;
        e.images = yp.pictures ?? [];
        e.url = yp.market_model_id && yp.market_sku
          ? `https://market.yandex.ru/product/${yp.market_model_id}?sku=${yp.market_sku}`
          : (yp.market_sku ? `https://market.yandex.ru/search?text=${yp.market_sku}` : null);
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
      for (const s of ozStores as any[]) this.storeIdToMp.set(s.id, 'ozon');
      for (const s of wbStores as any[]) this.storeIdToMp.set(s.id, 'wb');
      for (const s of ymStores as any[]) this.storeIdToMp.set(s.id, 'yandex');
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
      console.warn('[ProductsHub] load failed', e);
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
    if (this.selectedArticle) {
      const p = this.items.find(x => x.article === this.selectedArticle);
      if (p) this.renderCard(p);
    }
  }

  // ─── Filtering ──────────────────────────────────────────────────

  private applyFilters(): void {
    const { q, mp, no_cost, no_mp, no_repricer, no_box } = this.filters;
    this.filtered = this.items.filter(p => {
      if (q && !p.article.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return false;
      if (mp && !p.mp_entries.some(e => e.mp === mp)) return false;
      if (no_cost     && p.has_cost)     return false;
      if (no_mp       && p.has_mp)       return false;
      if (no_repricer && p.has_repricer) return false;
      if (no_box      && p.has_box)      return false;
      return true;
    });
    const c = this.el.querySelector('#ph-count');
    if (c) c.textContent = `${this.filtered.length} из ${this.items.length}`;
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
  }

  private tplListItem(p: HubProduct): string {
    const active = p.article === this.selectedArticle;
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
    if (!p.has_box)      dots.push('<span class="ph-warn-dot box"      title="Нет в группах товаров"></span>');
    return `
      <div class="ph-row${active ? ' active' : ''}" style="height:${ROW_H}px"
        onclick="window.productsHubModule?.selectProduct('${esc(p.article).replace(/'/g, '&#39;')}')">
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
          <div class="ph-row-mps">${mps}</div>
        </div>
      </div>`;
  }

  // ─── Select & render card ───────────────────────────────────────

  selectProduct(article: string): void {
    this.selectedArticle = article;
    this.renderListItems();
    const p = this.items.find(x => x.article === article);
    if (p) this.renderCard(p);
  }

  setTab(tab: Tab): void {
    this.activeTab = tab;
    const p = this.items.find(x => x.article === this.selectedArticle);
    if (p) this.renderCard(p);
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
      + `<div class="ph-tab-content">${this.tplTabContent(p)}</div>`;
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
            onclick="window.open(this.src,'_blank')" onerror="this.style.opacity='.3'">
          ${photos.length > 1 ? `
            <div class="ph-gallery-strip">${photos.map((u, i) => `
              <img class="ph-gallery-thumb${i === 0 ? ' active' : ''}" src="${esc(u)}" loading="lazy"
                onclick="document.getElementById('ph-gal-main').src='${esc(u)}';
                         this.parentElement.querySelectorAll('.ph-gallery-thumb').forEach(t=>t.classList.remove('active'));
                         this.classList.add('active')"
                onerror="this.style.display='none'">`).join('')}</div>` : ''}
        </div>`;

    const warnings: string[] = [];
    if (!p.has_cost)     warnings.push(`<span class="ph-warn cost">${I.alertTriangle('', 11)} нет себестоимости</span>`);
    if (!p.has_mp)       warnings.push(`<span class="ph-warn mp">${I.alertTriangle('', 11)} не на МП</span>`);
    if (!p.has_repricer) warnings.push(`<span class="ph-warn repricer">${I.alertTriangle('', 11)} нет репрайсера</span>`);
    if (!p.has_box)      warnings.push(`<span class="ph-warn box">${I.alertTriangle('', 11)} нет в группах</span>`);

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
          <div class="ph-head-actions">
            <button class="ph-action" onclick="window.app?.navigateTo('analytics')">${I.chart('', 12)} Аналитика</button>
            <button class="ph-action" onclick="window.app?.navigateTo('repricer')">${I.trendingUp('', 12)} Репрайсер</button>
            <button class="ph-action" onclick="window.app?.navigateTo('catalog-mp')">${I.store('', 12)} Каталог МП</button>
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
      ${stat('Маржа за шт.', margin != null ? prSigned(margin) : '—', marginPct != null ? `${marginPct}%` : '', margin == null ? 'muted' : margin >= 0 ? 'pos' : 'neg')}
      ${stat(`Прибыль ${this.period}д`, prSigned(totalNet30), `${totalSales30} продаж · остаток ${totalStock}`, totalNet30 === 0 ? 'muted' : totalNet30 > 0 ? 'pos' : 'neg')}
    </div>`;
  }

  private tplTabsHead(p: HubProduct): string {
    const tab = (id: Tab, label: string, icon: string, badge?: number | string) => `
      <button class="ph-tab${this.activeTab === id ? ' active' : ''}"
        onclick="window.productsHubModule?.setTab('${id}')">
        ${icon}${label}${badge != null ? `<span class="ph-tab-badge">${badge}</span>` : ''}
      </button>`;
    return `<div class="ph-tabs">
      ${tab('overview', 'Обзор', I.info('', 13))}
      ${tab('stores',   'Магазины', I.store('', 13), p.mp_entries.length || '')}
      ${tab('finance',  'Финансы', I.dollarSign('', 13))}
      ${tab('groups',   'Группы', I.layers('', 13), p.box_links.length || '')}
    </div>`;
  }

  private tplTabContent(p: HubProduct): string {
    switch (this.activeTab) {
      case 'overview': return this.tplOverview(p);
      case 'stores':   return this.tplStores(p);
      case 'finance':  return this.tplFinance(p);
      case 'groups':   return this.tplGroups(p);
    }
  }

  // ─── Tab: Overview ──────────────────────────────────────────────

  private tplOverview(p: HubProduct): string {
    const stores = p.mp_entries.length
      ? this.tplStoresTable(p, true)
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

    return `
      <div class="ph-section">
        <div class="ph-section-head">${I.store('', 12)} Магазины и цены</div>
        ${stores}
      </div>
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

  // ─── Tab: Stores ────────────────────────────────────────────────

  private tplStores(p: HubProduct): string {
    if (!p.mp_entries.length) return `<div class="ph-empty">Товар не найден ни на одном маркетплейсе</div>`;
    return `<div class="ph-section">${this.tplStoresTable(p, false)}</div>`;
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
            ${e.status ? `<span class="ph-status-pill ${e.status.includes('продаже') ? 'ok' : e.status.includes('Архив') || e.status.includes('Скрыт') ? 'warn' : ''}">${esc(e.status)}</span>` : ''}
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
        <div class="ph-fin-row"><span class="ph-fin-row-label">Себестоимость (${num(totalQty)} × ${pr(p.cost_price)})</span><span class="ph-fin-row-value neg">${prSigned(cogs)}</span></div>
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

  // ─── Tab: Groups ────────────────────────────────────────────────

  private tplGroups(p: HubProduct): string {
    const groups = p.box_links.length
      ? p.box_links.map(bl => `
          <div class="ph-group-card">
            <div class="ph-group-head">
              ${bl.image_url ? `<img src="${esc(bl.image_url)}" loading="lazy" onerror="this.style.display='none'">` : ''}
              <div class="ph-group-title">${esc(bl.box_name)}</div>
            </div>
            ${Object.keys(bl.specs).length === 0
              ? `<div class="ph-empty">Характеристики не заполнены</div>`
              : `<div class="ph-group-specs">${Object.entries(bl.specs).slice(0, 24).map(([k, v]) =>
                  `<div class="ph-group-spec" title="${esc(k)}: ${esc(String(v))}">${esc(k)}:<b>${esc(String(v))}</b></div>`
                ).join('')}</div>`}
          </div>`).join('')
      : `<div class="ph-empty">Товар не добавлен ни в одну группу</div>`;
    return `<div class="ph-section">
      <div class="ph-section-head">${I.layers('', 12)} Группы товаров</div>
      ${groups}
    </div>`;
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
    const fields: Array<{ label: string; value: string }> = [];
    if (s.product) {
      if (s.product.internal_id != null) fields.push({ label: 'Внутр. ID', value: '#' + s.product.internal_id });
      if (s.quantity) fields.push({ label: 'Кол-во в упак.', value: String(s.quantity) });
      for (const [k, v] of Object.entries(s.product.field_values ?? {})) {
        if (v && String(v).trim()) fields.push({ label: k, value: String(v) });
      }
    }
    return `<div class="ph-supplier">
      <div class="ph-supplier-name">${I.users('', 14)} ${esc(s.producer?.name ?? 'Без названия')}${s.product ? ` — ${esc(s.product.name)}` : ''}</div>
      ${fields.length
        ? `<div class="ph-info-grid">${fields.map(f =>
            `<div class="ph-info-item"><span class="ph-info-item-label">${esc(f.label)}</span><span class="ph-info-item-value">${esc(f.value)}</span></div>`
          ).join('')}</div>`
        : ''}
    </div>`;
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
}
