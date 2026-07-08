/**
 * ProducersModule — справочник производителей/поставщиков и работа с ними.
 *
 * Аналог системы ChairProd, переосмысленный универсально (для любых товаров,
 * не только мебели) и встроенный в дизайн SimaDesk.
 *
 * Табы:
 *   • Поставщики        — CRUD производителей с режимом работы и шаблоном
 *   • Каталог товаров   — товары производителей с кастомными полями
 *   • Связки            — артикул маркетплейса ↔ товар производителя
 *   • Заказы → Заявки   — для «реализации»: заказы группируются и генерится файл
 *   • Поставка          — для «поставки»: ручной выбор товаров + кол-во → документ
 *   • История           — сохранённые документы
 */

import * as XLSX from 'xlsx';
import { esc } from '@/utils/format';
import { copyButton } from '@/utils/copyButton';
import {
  producerDb, producerFieldDb, producerProductDb, producerMappingDb,
  producerOrderDb, producerDocDb,
  Producer, ProducerFieldDef, ProducerProduct, ProducerMapping,
  ProducerOrder, ProducerWorkflow, ProducerOutputType,
  TemplateConfig, OutputConfig,
} from '@/services/producerDb';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { orderSyncService } from '@/services/orderSyncService';
import { costPriceDb } from '@/services/costPriceDb';
import { costProducerLinks } from '@/services/costProducerLinks';

type Tab = 'producers' | 'products' | 'mappings' | 'consignment' | 'supply' | 'history';

const WORKFLOW_LABEL: Record<ProducerWorkflow, string> = {
  consignment: 'Реализация',
  supply:      'Поставка',
  both:        'Оба режима',
};
const OUTPUT_LABEL: Record<ProducerOutputType, string> = {
  new:      'Создать новый файл',
  template: 'Заполнить шаблон',
};

// ── Excel helpers ────────────────────────────────────────────────────────────

function colLetterToNumber(col: string): number {
  let r = 0;
  for (let i = 0; i < col.length; i++) {
    r = r * 26 + (col.toUpperCase().charCodeAt(i) - 64);
  }
  return r;
}

/** Загрузить ExcelJS из CDN по требованию (аналогично ExportImportModule). */
function ensureExcelJS(): Promise<any> {
  const w = window as any;
  if (w.ExcelJS) return Promise.resolve(w.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    s.onload = () => resolve(w.ExcelJS);
    s.onerror = () => reject(new Error('Не удалось загрузить ExcelJS из CDN'));
    document.head.appendChild(s);
  });
}

/** Запустить скачивание Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Auto-suggest matching helpers (module-level so chunks don't recreate closures) ──
function normStr(s: string): string { return s.toLowerCase().replace(/[\s\-_/.,;:!?'"()]+/g, ''); }
// Нормализация названия как в chairprod: lowercase, убрать «»"'.,() и схлопнуть пробелы
function normName(s: string): string {
  return (s ?? '').toLowerCase().replace(/[«»"'`.,()]/g, '').replace(/\s+/g, ' ').trim();
}
function tokenize(s: string): Set<string> {
  const tokens = s.toLowerCase().split(/[\s\-_/.,;:!?'"()+]+/).filter(t => t.length >= 2);
  return new Set(tokens);
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// Как в chairprod: любое пересечение = true (используется для кодов и категорий)
function setOverlaps(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (b.has(t)) return true;
  return false;
}
function extractCodes(s: string): Set<string> {
  const norm = normName(s).replace(/[_/]/g, ' ');
  const codes = new Set<string>();
  const re = /[a-zа-яё]+-?\d+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    const code = m[0].replace(/[-\s]/g, '');
    if (code.length >= 3) codes.add(code);
  }
  return codes;
}
// Поиск слов из словаря как подстрок нормализованного названия (как в chairprod wordSet)
function wordSetMatch(s: string, dict: string[]): Set<string> {
  const norm = normName(s);
  const found = new Set<string>();
  for (const w of dict) if (norm.includes(w)) found.add(w);
  return found;
}
const COLOR_WORDS_LIST = [
  'белый', 'чёрный', 'черный', 'серый', 'бежевый', 'коричневый', 'венге', 'дуб', 'сонома',
  'крафт', 'графит', 'антрацит', 'орех', 'ясень', 'зелёный', 'зеленый', 'синий', 'красный',
  'розовый', 'фиолетовый', 'голубой', 'жёлтый', 'желтый', 'оранжевый', 'золотой', 'серебристый',
  'дымчатый', 'глянец', 'матовый', 'мокко', 'кашемир', 'индиго', 'капучино', 'молочный', 'милк',
  'натуральный', 'береза', 'сосна', 'white', 'black', 'grey', 'gray', 'brown', 'beige', 'blue', 'green', 'red',
];
const CATEGORY_WORDS_LIST = [
  'тумба', 'стол', 'шкаф', 'кровать', 'комод', 'стеллаж', 'полка', 'диван', 'кресло',
  'пенал', 'витрина', 'зеркало', 'банкетка', 'стул', 'табурет', 'вешалка', 'подставка',
  'тахта', 'пуф', 'трюмо', 'консоль', 'этажерка', 'антресоль', 'гардероб', 'сервант', 'буфет',
  'оттоманка', 'кушетка', 'угловой', 'раскладной', 'трансформер',
];

interface DocItem { article: string; name: string; quantity: number; }

interface MappingImportReportRow {
  article: string;            // артикул МП
  mpKnown: boolean;            // найден в каталоге МП (this.mpArticles)
  art: string;                 // артикул производителя из файла
  producerNameRaw: string;     // производитель из файла (если указан)
  status: 'created' | 'exists' | 'no_product' | 'stopped';
  matchedProduct: string;      // название найденного товара производителя
  matchedProducerName: string; // производитель найденного товара
  ambiguous: boolean;          // найдено больше одного подходящего товара
  comment: string;
}

// ── Консигнация: метаданные в поле notes ──────────────────────────────────────
// Формат: JSON {"sn":"StoreName","si":"storeId","sc":"FBS","ms":"awaiting_packaging"}
// notes = null → ручной/старый заказ

type InternalStage = '' | 'processing' | 'delivery' | 'problem';
interface OrderMeta { sn?: string; si?: string; sc?: string; ms?: string; is?: InternalStage; on?: string }

function parseOrderMeta(notes: string | null): OrderMeta {
  if (!notes || notes[0] !== '{') return {};
  try { return JSON.parse(notes) as OrderMeta; } catch { return {}; }
}

function encodeOrderMeta(m: OrderMeta): string { return JSON.stringify(m); }

const MP_STATUS_LABEL: Record<string, string> = {
  // Ozon
  awaiting_packaging: 'Ожидает сборки',
  awaiting_deliver:   'Готов к отгрузке',
  delivering:         'Доставляется',
  delivered:          'Доставлен',
  cancelled:          'Отменён',
  sent_by_seller:     'У перевозчика',
  not_accepted:       'Не принят',
  // WB
  new:         'Новый',
  confirm:     'На сборке',
  complete:    'В доставке',
  cancel:      'Отменён',
  arbitration: 'Арбитраж',
  // YM
  PROCESSING:           'В обработке',
  DELIVERY:             'Доставляется',
  PICKUP:               'В пункте выдачи',
  DELIVERED:            'Доставлен',
  CANCELLED:            'Отменён',
  RESERVED:             'Зарезервирован',
  RETURNED:             'Возвращён',
};

const MP_STATUS_CSS: Record<string, { bg: string; color: string }> = {
  awaiting_packaging: { bg: '#451a03', color: '#fbbf24' },
  awaiting_deliver:   { bg: '#14401a', color: '#86efac' },
  delivering:         { bg: '#1e3a5f', color: '#93c5fd' },
  sent_by_seller:     { bg: '#1e3a5f', color: '#93c5fd' },
  delivered:          { bg: '#1c3545', color: '#38bdf8' },
  cancelled:          { bg: '#27272a', color: '#6b7280' },
  not_accepted:       { bg: '#27272a', color: '#6b7280' },
  arbitration:        { bg: '#4c1d95', color: '#c4b5fd' },
  new:                { bg: '#451a03', color: '#fbbf24' },
  confirm:            { bg: '#14401a', color: '#86efac' },
  complete:           { bg: '#1e3a5f', color: '#93c5fd' },
  cancel:             { bg: '#27272a', color: '#6b7280' },
  PROCESSING:         { bg: '#451a03', color: '#fbbf24' },
  DELIVERY:           { bg: '#1e3a5f', color: '#93c5fd' },
  PICKUP:             { bg: '#14401a', color: '#86efac' },
  DELIVERED:          { bg: '#1c3545', color: '#38bdf8' },
  CANCELLED:          { bg: '#27272a', color: '#6b7280' },
  RETURNED:           { bg: '#27272a', color: '#6b7280' },
  RESERVED:           { bg: '#451a03', color: '#fbbf24' },
};

const SCHEME_STYLE: Record<string, { bg: string; color: string }> = {
  FBS: { bg: 'rgba(74,222,128,.15)',  color: '#4ade80' },
  DBS: { bg: 'rgba(251,146,60,.15)', color: '#fb923c' },
  FBO: { bg: 'rgba(96,165,250,.15)', color: '#60a5fa' },
  FBY: { bg: 'rgba(96,165,250,.15)', color: '#60a5fa' },
};

const MP_LABEL: Record<string, string> = { ozon: 'Ozon', wb: 'WB', ym: 'ЯМ' };
const MP_COLOR: Record<string, string> = { ozon: '#005bff', wb: '#a020f0', ym: '#ff0000', manual: '#6b7280' };

/** Сгенерировать новый xlsx-файл (без шаблона). */
function generateNewFile(items: DocItem[], cfg: OutputConfig | null, sheetName: string): Blob {
  const showA = cfg?.show_article ?? true;
  const showN = cfg?.show_name ?? true;
  const headers: string[] = [];
  if (showA) headers.push('Артикул');
  if (showN) headers.push('Наименование');
  headers.push('Количество');
  const rows: any[][] = [headers];
  for (const it of items) {
    const r: any[] = [];
    if (showA) r.push(it.article);
    if (showN) r.push(it.name);
    r.push(it.quantity);
    rows.push(r);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = headers.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.slice(1).map(r => String(r[i] ?? '').length));
    return { wch: Math.min(maxLen + 2, 50) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Заполнить шаблон производителя. Шаблон скачивается по url, в нём только
 *  обновляется колонка количества для строк с совпадающими артикулами. */
async function fillTemplate(
  templateUrl: string, cfg: TemplateConfig, items: DocItem[],
): Promise<Blob> {
  const ExcelJS = await ensureExcelJS();
  const resp = await fetch(templateUrl);
  if (!resp.ok) throw new Error('Не удалось скачать шаблон');
  const buf = await resp.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets[0];
  const articleCol = colLetterToNumber(cfg.article_column || 'A');
  const qtyCol     = colLetterToNumber(cfg.qty_column     || 'C');
  const startRow   = cfg.start_row || 2;

  const index = new Map<string, number>();
  sheet.eachRow({ includeEmpty: true }, (row: any, rowNumber: number) => {
    if (rowNumber < startRow) return;
    const raw = String(row.getCell(articleCol).value ?? '').trim();
    if (!raw) return;
    const upper = raw.toUpperCase();
    index.set(upper, rowNumber);
    const stripped = upper.replace(/^0+/, '');
    if (stripped && stripped !== upper) index.set(stripped, rowNumber);
  });

  for (const it of items) {
    const k = it.article.toUpperCase();
    const ks = k.replace(/^0+/, '');
    const rowN = index.get(k) ?? index.get(ks);
    if (rowN !== undefined) sheet.getRow(rowN).getCell(qtyCol).value = it.quantity;
  }
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ── SVG icons ───────────────────────────────────────────────────────────────

const IC = {
  factory: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20V8l5 3V8l5 3V8l5 3V4h3v16"/><path d="M2 20h20"/><path d="M6 16h2M11 16h2M16 16h2"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11 2l1.5 1.5L4.5 11.5 2 12l.5-2.5z"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4h9l-.7 8.5a1 1 0 01-1 .9H4.2a1 1 0 01-1-.9L2.5 4z"/><line x1="1" y1="4" x2="13" y2="4"/><path d="M5 4V2.5a1 1 0 011-1h2a1 1 0 011 1V4"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 1v9M3 7l4 4 4-4M2 12h10"/></svg>`,
};

/** Перетаскиваемый разделитель колонки — ставится внутри <th style="position:relative">. */
function colResizer(): string {
  return `<span onmousedown="window.producersModule._startColResize(event,this)" class="col-resizer" style="position:absolute;top:0;right:-4px;bottom:0;width:8px;cursor:col-resize;z-index:2" onclick="event.stopPropagation()"></span>`;
}

// ── Module ──────────────────────────────────────────────────────────────────

export class ProducersModule {
  private el: HTMLElement;
  private visible = false;
  private tab: Tab = 'products';

  private producers: Producer[] = [];
  private fields:    ProducerFieldDef[] = [];
  private products:  ProducerProduct[] = [];
  private mappings:  ProducerMapping[] = [];
  private orders:    ProducerOrder[] = [];

  // Products tab state
  private productProducerFilter = '';
  private productSearch = '';
  private productSelected = new Set<string>();
  private productArchived = false;
  private productShowFilters = false;
  private productFieldFilters: Record<string, { type: 'range'; min: string; max: string } | { type: 'select'; selected: Set<string> }> = {};
  private productsLoading = false;
  private _searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // General loading overlay
  private loadingMsg = '';

  // Mappings tab state
  private mappingSearch = '';
  private mappingSubtab: 'pending' | 'linked' = 'pending';
  private mpArticles: Array<{ article: string; name: string }> = []; // загруженные артикулы маркетплейса
  private _lastImportReport: MappingImportReportRow[] = []; // для скачивания подробного отчёта после импорта связок
  private mpSuggestions: Map<string, Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain' | 'manual'; score: number }>> = new Map();
  private mappingSelectedKeys = new Set<string>(); // `${article}__${productId}`
  private mappingKeyQty = new Map<string, number>(); // qty per selected key
  private mappingCreating = false;
  private mappingProducerFilter = '';
  private mappingConfidenceFilter: 'all' | 'exact' | 'model' | 'uncertain' | 'none' = 'all';
  private mappingOnlyOrdered = false;
  private lastAutoSuggestBatch = new Set<string>(); // артикулы из последней авто-связки (для undo)
  private mappingPage = 0; // пагинация pending-вкладки
  private mappingUnknownPrefixFilter = false; // фильтр «Не опознанные»
  private mappingPrefixFilter = ''; // выбранный префикс производителя
  private mappingVisibleCount = 50;       // pagination for pending tab
  private mappingLinkedVisibleCount = 50; // pagination for linked tab
  private _mappingLinkedScrollTop = 0;
  private autoSuggestLoading = false;

  // Inline edit state (linked tab)
  private mappingEditingArticle: string | null = null;
  private mappingEditAddProductId = '';
  private mappingEditAddProductLabel = '';
  private mappingEditAddQty = 1;

  // Linked subtab state
  private linkedSelected = new Set<string>(); // хранит marketplace_article

  // Consignment
  private orderSelected = new Set<string>();
  private consignmentOnlyMapped = false;
  private consignmentSearch = '';
  private consignmentStatusTab: InternalStage = '';
  private consignmentSourceFilter = ''; // "ozon"|"wb"|"ym" — фильтр по маркетплейсу
  private consignmentStoreFilter = '';  // "storeId" — фильтр по конкретному магазину
  private consignmentVisibleCount = 100; // пагинация таблицы заказов
  private _importProgress: { done: number; total: number; currentLabel: string; errors: number } | null = null;

  // SmartImport state
  private smartImportStep: 0 | 1 | 2 = 0;
  private smartImportFile: File | null = null;
  private smartImportMapping: Record<string, string> = {};
  private smartImportPreview: { toCreate: any[]; toUpdate: any[]; skip: number; skipNoName?: number; ambiguous?: number } = { toCreate: [], toUpdate: [], skip: 0 };
  private smartImportProducerId = '';
  private smartUnmappedAction: Record<string, 'create' | 'ignore'> = {};
  private smartMatchMode: 'article' | 'name' | 'both' = 'both';

  // Supply
  private supplyProducerId = '';
  private supplySearch = '';
  private supplyQty: Record<string, number> = {};

  constructor(el: HTMLElement) {
    this.el = el;
    (window as any).producersModule = this;
    // Один passive-обработчик на весь документ: убирает фокус с number-инпутов при скролле,
    // не блокируя поток скролла и не создавая сотни non-passive слушателей на каждый рендер.
    if (!(window as any).__numWheelBlurAdded) {
      (window as any).__numWheelBlurAdded = true;
      document.addEventListener('wheel', (e) => {
        const t = e.target as HTMLInputElement;
        if (t?.type === 'number') t.blur();
      }, { passive: true, capture: true });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  show(): void {
    this.el.style.display = '';
    this.visible = true;
    this.boot();
  }
  hide(): void {
    this.el.style.display = 'none';
    this.visible = false;
  }

  private async boot(): Promise<void> {
    this.render(true);
    // Восстанавливаем каталог артикулов МП из localStorage
    try {
      const stored = localStorage.getItem('prod_mp_articles');
      if (stored) this.mpArticles = JSON.parse(stored);
    } catch {}
    try {
      await producerFieldDb.ensureSystemFields();
      await Promise.all([this.loadProducers(), this.loadFields()]);
      await Promise.all([this.loadProducts(), this.loadMappings(), this.loadOrders()]);
    } catch (e: any) {
      this.toast(e?.message ?? 'Ошибка загрузки', 'error');
    }
    this.render();
  }

  private toast(text: string, kind: 'success' | 'error' | 'info' = 'info'): void {
    const app = (window as any).app;
    if (app?.toast) { app.toast(text, kind); return; }
    /* fallback */ console.log(`[producers] ${kind}: ${text}`);
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  private async loadProducers(): Promise<void> { this.producers = await producerDb.list(); }
  private async loadFields(): Promise<void>    { this.fields = await producerFieldDb.list(); }
  private async loadMappings(): Promise<void>  { this.mappings = await producerMappingDb.list(); }
  private async loadOrders(): Promise<void>    { this.orders = await producerOrderDb.list(); }

  private async loadProducts(): Promise<void> {
    this.productsLoading = true;
    this._showTbodySpinner();
    try {
      this.products = await producerProductDb.list(undefined, this.productArchived);
      // Auto-migrate products that don't have internal_id yet (background, non-blocking)
      this._assignMissingInternalIds();
    } finally {
      this.productsLoading = false;
    }
  }

  /** Генерирует уникальный 5-значный внутренний ID, не совпадающий ни с одним существующим. */
  private _generateInternalId(): number {
    const used = new Set(this.products.map(p => p.internal_id).filter((x): x is number => x != null));
    let id: number;
    do { id = 10000 + Math.floor(Math.random() * 90000); } while (used.has(id));
    used.add(id);
    return id;
  }

  /** Назначает internal_id товарам у которых его нет. Работает в фоне без блокировки UI. */
  private async _assignMissingInternalIds(): Promise<void> {
    const missing = this.products.filter(p => p.internal_id == null);
    if (missing.length === 0) return;
    const used = new Set(this.products.map(p => p.internal_id).filter((x): x is number => x != null));
    const assign = (p: ProducerProduct): number => {
      let id: number;
      do { id = 10000 + Math.floor(Math.random() * 90000); } while (used.has(id));
      used.add(id);
      p.internal_id = id;
      return id;
    };
    // Patch local state immediately so catalog shows IDs right away
    for (const p of missing) assign(p);
    this._patchProductTbody();
    // Persist in batches of 20 parallel requests
    const BATCH = 20;
    for (let i = 0; i < missing.length; i += BATCH) {
      await Promise.all(
        missing.slice(i, i + BATCH).map(p =>
          producerProductDb.update(p.id, { internal_id: p.internal_id } as any).catch(() => {}),
        ),
      );
    }
  }

  private _showTbodySpinner(): void {
    if (!this.visible || this.tab !== 'products') return;
    const tbody = this.el.querySelector('tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="99" style="padding:40px;text-align:center;color:var(--text-2)">
        <span style="display:inline-block;width:20px;height:20px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px"></span>
        Загрузка товаров…
      </td></tr>`;
    }
  }

  private _buildProductRow(p: ProducerProduct, producersById: Map<string, Producer>): string {
    const prod = producersById.get(p.producer_id);
    const checked = this.productSelected.has(p.id);
    return `<tr data-pid="${p.id}" onclick="window.producersModule._onProductRowClick(event,'${p.id}')" style="border-bottom:1px solid var(--line);background:${checked?'rgba(59,130,246,.1)':'transparent'};cursor:pointer">
      <td style="padding:7px 10px"><input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleProductSel('${p.id}')"></td>
      <td style="padding:6px 10px;font-family:monospace;font-size:11px;color:#6366f1;letter-spacing:.5px;white-space:nowrap">${p.internal_id != null ? `<span style="display:inline-flex;align-items:center;gap:4px;min-width:0">${p.internal_id}${copyButton(p.internal_id, 'Копировать ID')}</span>` : '—'}</td>
      <td style="padding:8px 10px;color:var(--text-2);max-width:0">${prod?.name ? `<span style="display:flex;align-items:center;gap:4px;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0" title="${esc(prod.name)}">${esc(prod.name)}</span><span style="flex-shrink:0">${copyButton(prod.name, 'Копировать название поставщика')}</span></span>` : '—'}</td>
      <td style="padding:8px 10px;font-family:monospace;font-size:11px;max-width:0">${p.articles.length ? `<span style="display:flex;align-items:center;gap:4px;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0" title="${esc(p.articles.join(', '))}">${esc(p.articles[0])}</span>${p.articles.length>1?`<span style="flex-shrink:0;color:var(--text-2);font-size:10px">+${p.articles.length-1}</span>`:''}<span style="flex-shrink:0">${copyButton(p.articles[0], 'Копировать артикул')}</span></span>` : '<span style="color:var(--text-2);font-style:italic">—</span>'}</td>
      <td style="padding:8px 10px;max-width:0"><span style="display:flex;align-items:center;gap:4px;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0" title="${esc(p.name)}">${esc(p.name)}</span><span style="flex-shrink:0">${copyButton(p.name, 'Копировать название')}</span></span></td>
      ${this.fields.map(f => `<td style="padding:8px 10px;color:var(--text-2);white-space:nowrap">${esc(p.field_values?.[f.id] ?? '—')}</td>`).join('')}
      <td style="padding:6px 10px;text-align:right">
        <button class="btn" onclick="event.stopPropagation();window.producersModule.deleteProduct('${p.id}')" style="padding:4px 8px;font-size:11px;color:#ef4444">${IC.trash}</button>
      </td>
    </tr>`;
  }

  /** Клик по строке товара открывает форму редактирования — кроме кликов по чекбоксу, кнопкам и кнопке копирования. */
  _onProductRowClick(e: MouseEvent, id: string): void {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, .copy-btn')) return;
    this.openProductForm(id);
  }

  /** Тащит правую границу <th>, делая колонку растягиваемой. */
  _startColResize(e: MouseEvent, handle: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const th = handle.parentElement as HTMLElement;
    const table = th.closest('table') as HTMLTableElement | null;
    if (table) table.style.tableLayout = 'fixed';
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    const onMove = (ev: MouseEvent) => {
      th.style.width = Math.max(40, startWidth + (ev.clientX - startX)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Виртуальный скролл таблицы товаров ──────────────────────────────────
  // Рендерим в DOM только строки, попадающие в видимую область (+ запас),
  // а высоту до/после имитируем одной строкой-спейсером. Это держит DOM
  // плоским независимо от того, 100 товаров в каталоге или 100000 —
  // нет деградации скролла/фильтрации на больших каталогах.

  private _vFiltered: ProducerProduct[] = [];
  private _vRowH = 34; // уточняется измерением фактической строки после первого рендера
  private _vRaf: number | null = null;

  private _scheduleVUpdate(): void {
    if (this._vRaf != null) return;
    this._vRaf = requestAnimationFrame(() => { this._vRaf = null; this._renderVisibleRows(); });
  }

  /** Вызывается один раз после вставки разметки таблицы товаров в DOM. */
  private _initVirtualTable(): void {
    const scrollEl = this.el.querySelector<HTMLElement>('[data-prod-scroll]');
    if (!scrollEl) return;
    if (!(scrollEl as any)._vBound) {
      (scrollEl as any)._vBound = true;
      scrollEl.addEventListener('scroll', () => this._scheduleVUpdate(), { passive: true });
      window.addEventListener('resize', () => this._scheduleVUpdate(), { passive: true });
    }
    this._renderVisibleRows();
  }

  /** Перерисовывает только строки, попадающие в окно прокрутки (+overscan). */
  private _renderVisibleRows(): void {
    const scrollEl = this.el.querySelector<HTMLElement>('[data-prod-scroll]');
    const tbody = this.el.querySelector('tbody');
    if (!scrollEl || !tbody) return;
    const filtered = this._vFiltered;
    const total = filtered.length;
    this._updateProductCounter(total);
    if (total === 0) { tbody.innerHTML = ''; return; }

    const sampleRow = tbody.querySelector<HTMLElement>('tr[data-pid]');
    if (sampleRow) this._vRowH = sampleRow.offsetHeight || this._vRowH;
    const rowH = this._vRowH;

    const overscan = 10;
    const start = Math.max(0, Math.floor(scrollEl.scrollTop / rowH) - overscan);
    const end = Math.min(total, Math.ceil((scrollEl.scrollTop + scrollEl.clientHeight) / rowH) + overscan);

    const topH = start * rowH;
    const bottomH = (total - end) * rowH;
    const producersById = new Map(this.producers.map(p => [p.id, p]));
    const rowsHtml = filtered.slice(start, end).map(p => this._buildProductRow(p, producersById)).join('');
    tbody.innerHTML =
      (topH > 0 ? `<tr aria-hidden="true"><td colspan="99" style="padding:0;border:none;height:${topH}px"></td></tr>` : '') +
      rowsHtml +
      (bottomH > 0 ? `<tr aria-hidden="true"><td colspan="99" style="padding:0;border:none;height:${bottomH}px"></td></tr>` : '');
  }

  private _updateProductCounter(total: number): void {
    const el = this.el.querySelector<HTMLElement>('[data-prod-counter]');
    if (el) el.textContent = `${total} позиций`;
  }

  /** Обновляет tbody при поиске/фильтре без полного перерендера шапки. */
  _patchProductTbody(): void {
    const scrollEl = this.el.querySelector<HTMLElement>('[data-prod-scroll]');
    if (!scrollEl) { this.render(); return; }
    this._vFiltered = this.filteredProducts();
    scrollEl.scrollTop = 0;
    this._renderVisibleRows();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  setTab(t: Tab): void { this.tab = t; this.render(); }

  private render(loading = false): void {
    if (!this.visible) return;
    const spinnerHtml = (msg: string) => `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text-2)">
        <span style="display:block;width:32px;height:32px;border:3px solid rgba(255,255,255,.1);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite"></span>
        <span style="font-size:13px">${msg}</span>
      </div>`;
    this.el.innerHTML = `
      <div class="producers-root" style="display:flex;flex-direction:column;height:100%;padding:16px 18px 90px;gap:14px">
        ${this.renderHeader()}
        ${loading
          ? spinnerHtml('Загрузка данных…')
          : this.loadingMsg
            ? spinnerHtml(this.loadingMsg)
            : this.renderTab()}
      </div>
    `;
  }


  private renderHeader(): string {
    const tabs: Array<{ key: Tab; label: string; count?: number }> = [
      { key: 'products',    label: 'Каталог товаров', count: this.products.length },
      { key: 'mappings',    label: 'Связки',          count: this.mappings.length },
      { key: 'consignment', label: 'Заказы → Заявки', count: this.orders.filter(o => o.status !== 'cancelled' && o.status !== 'done').length },
      { key: 'supply',      label: 'Поставка' },
      { key: 'history',     label: 'История' },
    ];
    // «Поставщики» открывается кнопкой внутри «Каталог товаров», поэтому подсвечиваем
    // вкладку каталога активной и пока находимся в этом вложенном экране.
    const activeTab = this.tab === 'producers' ? 'products' : this.tab;
    return `
      <div style="display:flex;align-items:center;gap:14px;flex-shrink:0">
        <h2 style="margin:0;font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px">
          <span style="color:var(--accent)">${IC.factory}</span>
          Производители
        </h2>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tabs.map(t => {
            const active = activeTab === t.key;
            return `<button class="btn" onclick="window.producersModule.setTab('${t.key}')"
              style="font-size:12px;padding:6px 11px;border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};
                background:${active ? 'var(--accent)' : 'transparent'};
                color:${active ? '#0a0a0a' : 'var(--text-1)'};border-radius:7px">
              ${t.label}${t.count !== undefined ? ` <span style="opacity:.7">${t.count}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  private renderTab(): string {
    switch (this.tab) {
      case 'producers':   return this.renderProducersTab();
      case 'products':    return this.renderProductsTab();
      case 'mappings':    return this.renderMappingsTab();
      case 'consignment': return this.renderConsignmentTab();
      case 'supply':      return this.renderSupplyTab();
      case 'history':     return this.renderHistoryTab();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 1: PRODUCERS
  // ════════════════════════════════════════════════════════════════════════

  private renderProducersTab(): string {
    return `
      <div style="display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <button class="btn" onclick="window.producersModule.setTab('products')"
            style="padding:7px 11px;font-size:11px;display:inline-flex;align-items:center;gap:6px">
            ← Назад к каталогу
          </button>
          <span style="color:var(--text-2);font-size:13px">${this.producers.length} поставщиков</span>
          <button class="btn" onclick="window.producersModule.openProducerForm()"
            style="background:var(--accent);color:#0a0a0a;border:none;padding:7px 14px;border-radius:7px;font-size:12px;display:inline-flex;align-items:center;gap:6px">
            ${IC.plus} Добавить
          </button>
        </div>

        ${this.producers.length === 0 ? `
          <div style="border:1px dashed var(--line);border-radius:10px;padding:36px;text-align:center;color:var(--text-2);font-size:13px">
            Поставщиков пока нет. Добавьте первого.
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${this.producers.map(p => `
              <div style="border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:14px;background:var(--bg-2)">
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span style="font-weight:600;color:var(--text-1);font-size:14px">${esc(p.name)}</span>${copyButton(p.name, 'Копировать название')}
                    ${p.prefix ? `<span style="font-size:10px;background:#1e3a5f;color:#93c5fd;padding:2px 7px;border-radius:10px">Префикс: ${esc(p.prefix)}</span>` : ''}
                    <span style="font-size:10px;background:#3b0a6a;color:#c4a3ed;padding:2px 7px;border-radius:10px">${WORKFLOW_LABEL[p.workflow]}</span>
                    <span style="font-size:10px;background:rgba(59,130,246,.12);color:#93c5fd;padding:2px 7px;border-radius:10px">${OUTPUT_LABEL[p.output_type]}</span>
                  </div>
                  ${p.contacts ? `<div style="font-size:11px;color:var(--text-2);margin-top:4px">${esc(p.contacts)}</div>` : ''}
                  ${p.output_type === 'template' && p.template_url ? `<div style="font-size:10px;color:var(--text-2);margin-top:4px;font-family:monospace">шаблон загружен</div>` : ''}
                </div>
                <div style="display:flex;gap:6px">
                  <button class="btn" onclick="window.producersModule.openProducerForm('${p.id}')" style="padding:5px 10px;font-size:11px">${IC.edit} Изменить</button>
                  <button class="btn" onclick="window.producersModule.deleteProducer('${p.id}')" style="padding:5px 10px;font-size:11px;color:#ef4444">${IC.trash}</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  openProducerForm(id?: string, onSaved?: () => void): void {
    const p = id ? this.producers.find(x => x.id === id) : null;
    const form = {
      id: p?.id ?? '',
      name: p?.name ?? '',
      prefix: p?.prefix ?? '',
      workflow: p?.workflow ?? 'consignment',
      output_type: p?.output_type ?? 'new',
      template_url: p?.template_url ?? '',
      template_config: p?.template_config ?? { article_column: 'A', name_column: 'B', qty_column: 'C', start_row: 2 },
      output_config: p?.output_config ?? { show_article: true, show_name: true, qty_column: 'C' },
      contacts: p?.contacts ?? '',
    };
    this.showModal(p ? 'Изменить поставщика' : 'Новый поставщик', this.producerFormHtml(form), async () => {
      // collect form values
      const root = document.getElementById('producer-form')!;
      const getV = (n: string) => (root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.value ?? '';
      const getC = (n: string) => (root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.checked ?? false;
      const name = getV('name').trim();
      if (!name) { this.toast('Укажите название', 'error'); return false; }
      const workflow = getV('workflow') as ProducerWorkflow;
      const output_type = getV('output_type') as ProducerOutputType;
      const payload = {
        name, prefix: getV('prefix').trim(), workflow, output_type,
        template_url: form.template_url || null,
        template_config: output_type === 'template' ? {
          article_column: getV('tcfg_article') || 'A',
          name_column:    getV('tcfg_name')    || 'B',
          qty_column:     getV('tcfg_qty')     || 'C',
          start_row:      Number(getV('tcfg_start') || 2),
        } : null,
        output_config: output_type === 'new' ? {
          show_article: getC('ocfg_show_article'),
          show_name:    getC('ocfg_show_name'),
          qty_column:   getV('ocfg_qty') || 'C',
        } : null,
        contacts: getV('contacts').trim() || null,
      };
      try {
        if (p) { await producerDb.update(p.id, payload); this.toast('Сохранено', 'success'); }
        else { await producerDb.create(payload as any); this.toast('Поставщик добавлен', 'success'); }
        await this.loadProducers();
        if (onSaved) { onSaved(); } else { this.render(); }
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  private producerFormHtml(f: any): string {
    return `
      <form id="producer-form" style="display:flex;flex-direction:column;gap:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Название *
            <input name="name" value="${esc(f.name)}" placeholder="Например: ООО Меховщик"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Префикс артикула (опционально)
            <input name="prefix" value="${esc(f.prefix)}" placeholder="Например MX_"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
          </label>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Режим работы
            <select name="workflow" onchange="document.getElementById('producer-form').dispatchEvent(new Event('refresh-cfg'))"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
              <option value="consignment" ${f.workflow==='consignment'?'selected':''}>Реализация (заказ → заявка)</option>
              <option value="supply" ${f.workflow==='supply'?'selected':''}>Поставка (ручной выбор → документ)</option>
              <option value="both" ${f.workflow==='both'?'selected':''}>Оба режима</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Тип Excel
            <select name="output_type" onchange="window.producersModule.refreshProducerCfg()"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
              <option value="new" ${f.output_type==='new'?'selected':''}>Создать новый файл</option>
              <option value="template" ${f.output_type==='template'?'selected':''}>Заполнить шаблон</option>
            </select>
          </label>
        </div>

        <div id="producer-cfg-block">
          ${this.producerCfgBlock(f)}
        </div>

        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Контакты (опционально)
          <textarea name="contacts" rows="2" placeholder="Телефон, email, менеджер"
            style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-family:inherit;resize:vertical">${esc(f.contacts)}</textarea>
        </label>
      </form>
    `;
  }

  private producerCfgBlock(f: any): string {
    const outputType = (document.querySelector('[name="output_type"]') as HTMLSelectElement)?.value ?? f.output_type;
    if (outputType === 'template') {
      return `
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);font-weight:600">Шаблон Excel</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="file" accept=".xlsx,.xls" onchange="window.producersModule.uploadTemplateFile(this)"
              style="font-size:11px;color:var(--text-2)">
            ${f.template_url ? `<span style="font-size:10px;color:#93c5fd">шаблон загружен</span>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:8px">
            <label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text-2)">
              Кол. артикула
              <input name="tcfg_article" value="${esc(f.template_config?.article_column ?? 'A')}"
                style="padding:6px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
            </label>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text-2)">
              Кол. названия
              <input name="tcfg_name" value="${esc(f.template_config?.name_column ?? 'B')}"
                style="padding:6px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
            </label>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text-2)">
              Кол. количества
              <input name="tcfg_qty" value="${esc(f.template_config?.qty_column ?? 'C')}"
                style="padding:6px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
            </label>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text-2)">
              Стартовая строка
              <input name="tcfg_start" type="number" min="1" value="${f.template_config?.start_row ?? 2}"
                style="padding:6px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
            </label>
          </div>
        </div>
      `;
    }
    // new file
    return `
      <div style="border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);font-weight:600">Колонки нового файла</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" name="ocfg_show_article" ${f.output_config?.show_article ?? true ? 'checked' : ''}>
            Выводить артикул
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" name="ocfg_show_name" ${f.output_config?.show_name ?? true ? 'checked' : ''}>
            Выводить название
          </label>
          <label style="display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text-2)">
            Кол. количества
            <input name="ocfg_qty" value="${esc(f.output_config?.qty_column ?? 'C')}"
              style="padding:6px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);width:80px">
          </label>
        </div>
      </div>
    `;
  }

  refreshProducerCfg(): void {
    const block = document.getElementById('producer-cfg-block');
    if (!block) return;
    // current form values — preserve current input
    const root = document.getElementById('producer-form')!;
    const get = (n: string) => (root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.value;
    const getC = (n: string) => (root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.checked;
    const f = {
      output_type: get('output_type') ?? 'new',
      template_url: '', // not lost — re-attach upload separately
      template_config: {
        article_column: get('tcfg_article') ?? 'A',
        name_column:    get('tcfg_name')    ?? 'B',
        qty_column:     get('tcfg_qty')     ?? 'C',
        start_row:      Number(get('tcfg_start') ?? 2),
      },
      output_config: {
        show_article: getC('ocfg_show_article') ?? true,
        show_name:    getC('ocfg_show_name')    ?? true,
        qty_column:   get('ocfg_qty') ?? 'C',
      },
    };
    block.innerHTML = this.producerCfgBlock(f);
  }

  /** Загружает шаблон в Supabase Storage. Bucket 'producer-templates' должен существовать. */
  async uploadTemplateFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    if (!f) return;
    try {
      // Используем DataURL вместо upload — храним base64 в template_url напрямую,
      // т.к. отдельного Storage bucket пока нет. Файлы небольшие (xlsx-шаблоны).
      const reader = new FileReader();
      const dataUrl: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(f);
      });
      // прячем в скрытом поле и показываем подтверждение
      (window as any).__producerTemplateDataUrl = dataUrl;
      this.toast(`Шаблон «${f.name}» подготовлен. Сохраните форму.`, 'success');
    } catch (e: any) {
      this.toast(e?.message ?? 'Ошибка загрузки', 'error');
    }
  }

  async deleteProducer(id: string): Promise<void> {
    if (!confirm('Удалить поставщика и все его товары?')) return;
    try {
      await producerDb.remove(id);
      this.toast('Удалено', 'success');
      await Promise.all([this.loadProducers(), this.loadProducts(), this.loadMappings()]);
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 2: PRODUCTS — справочник с кастомными полями
  // ════════════════════════════════════════════════════════════════════════

  private renderProductsTab(): string {
    const filtered = this.filteredProducts();
    this._vFiltered = filtered;
    const filterFields = this.fields.filter(f => f.show_in_filters);
    const activeFilters = Object.keys(this.productFieldFilters).length;
    const allChecked = filtered.length > 0 && filtered.every(p => this.productSelected.has(p.id));
    // Запускаем виртуальный рендер строк после того как HTML разметка вставлена в DOM
    setTimeout(() => this._initVirtualTable(), 0);
    return `
      <div style="display:flex;flex-direction:column;gap:10px;flex:1;overflow:hidden">
        ${this.renderProducerStrip()}

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="prod-search" placeholder="🔍 Поиск по ID, артикулу, названию…"
            value="${esc(this.productSearch)}"
            oninput="window.producersModule.setProductSearch(this.value)"
            style="flex:1;min-width:220px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px">

          ${filterFields.length > 0 ? `
            <button class="btn" onclick="window.producersModule.toggleProductFilters()"
              style="padding:7px 11px;font-size:11px;background:${this.productShowFilters?'#1e3a5f':'transparent'};color:${this.productShowFilters?'#93c5fd':'var(--text-1)'};border:1px solid ${this.productShowFilters?'#3b82f6':'var(--line)'};border-radius:6px">
              Фильтры${activeFilters>0?` <span style="background:#3b82f6;color:#fff;padding:1px 5px;border-radius:8px;font-size:10px">${activeFilters}</span>`:''}
            </button>` : ''}

          <button class="btn" onclick="window.producersModule.toggleArchive()"
            style="padding:7px 11px;font-size:11px;background:${this.productArchived?'rgba(217,119,6,.2)':'transparent'};color:${this.productArchived?'#fbbf24':'var(--text-1)'};border:1px solid ${this.productArchived?'#d97706':'var(--line)'};border-radius:6px">
            📦 ${this.productArchived?'Архив':'Активные'}
          </button>

          <span data-prod-counter style="font-size:11px;color:var(--text-2)">${filtered.length} позиций</span>
          <div style="flex:1"></div>

          <button class="btn" onclick="window.producersModule.setTab('producers')" style="padding:7px 11px;font-size:11px;display:inline-flex;align-items:center;gap:6px">
            ${IC.factory} Поставщики <span style="opacity:.7">${this.producers.length}</span>
          </button>
          <button class="btn" onclick="window.producersModule.openFieldsModal()" style="padding:7px 11px;font-size:11px">⚙ Поля</button>
          <button class="btn" onclick="window.producersModule.downloadProductTemplate()" style="padding:7px 11px;font-size:11px">📋 Шаблон</button>
          <button class="btn" onclick="window.producersModule.openSmartImport()" style="padding:7px 11px;font-size:11px">📥 Импорт</button>
          <button class="btn" onclick="window.producersModule.openProductExport()" style="padding:7px 11px;font-size:11px">📤 Экспорт</button>
          <button class="btn" onclick="window.producersModule.openProductForm()"
            style="background:var(--accent);color:#0a0a0a;border:none;padding:7px 14px;border-radius:7px;font-size:12px;display:inline-flex;align-items:center;gap:6px">
            ${IC.plus} Добавить
          </button>
        </div>

        ${this.productShowFilters && filterFields.length > 0 ? this.renderFieldFilters(filterFields) : ''}

        <div data-prod-scroll style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
          ${filtered.length === 0 && !this.productsLoading ? `
            <div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">
              ${this.products.length === 0 ? 'Товаров нет. Добавьте первый или импортируйте.' : 'Ничего не найдено'}
            </div>
          ` : `
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              <thead style="background:var(--bg-2);position:sticky;top:0;z-index:5">
                <tr>
                  <th style="width:32px;padding:9px 10px;border-bottom:1px solid var(--line)">
                    <input type="checkbox" ${allChecked?'checked':''} onchange="window.producersModule.toggleAllProducts(this.checked)">
                  </th>
                  <th style="position:relative;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:#6366f1;letter-spacing:.5px;white-space:nowrap">ID${colResizer()}</th>
                  <th style="position:relative;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Поставщик${colResizer()}</th>
                  <th style="position:relative;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Артикулы${colResizer()}</th>
                  <th style="position:relative;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Наименование${colResizer()}</th>
                  ${this.fields.map(f => `<th style="position:relative;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:${f.is_locked?'#93c5fd':'var(--text-2)'};letter-spacing:.5px;white-space:nowrap">${esc(f.name)}${colResizer()}</th>`).join('')}
                  <th style="width:60px;border-bottom:1px solid var(--line)"></th>
                </tr>
              </thead>
              <tbody>
                <tr><td colspan="99" style="padding:24px;text-align:center;color:var(--text-2)">
                  <span style="display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px"></span>
                  ${this.productsLoading ? 'Загрузка…' : 'Отрисовка…'}
                </td></tr>
              </tbody>
            </table>
          `}
        </div>

        ${this.productSelected.size > 0 ? this.renderProductSelBar() : ''}
      </div>
    `;
  }

  /** Полоска производителей с % качества (заполненность кастомных полей). */
  private renderProducerStrip(): string {
    if (this.producers.length === 0) return '';
    const total = this.products.length;
    const expectedFields = this.fields.filter(f => !f.is_locked).length;
    const qualityFor = (pid: string): number => {
      const prods = this.products.filter(x => x.producer_id === pid);
      if (prods.length === 0 || expectedFields === 0) return 100;
      let filled = 0;
      for (const p of prods) for (const f of this.fields) {
        if (f.is_locked) continue;
        if ((p.field_values?.[f.id] ?? '').toString().trim()) filled++;
      }
      return Math.round(filled / (prods.length * expectedFields) * 100);
    };
    return `
      <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px">
        <button onclick="window.producersModule.setProductProducerFilter('')"
          style="flex-shrink:0;border:1px solid ${this.productProducerFilter===''?'#3b82f6':'var(--line)'};background:${this.productProducerFilter===''?'#1e3a5f':'var(--bg-2)'};color:var(--text-1);border-radius:10px;padding:8px 12px;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;min-width:90px">
          <span style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2)">Все</span>
          <span style="font-size:13px;font-weight:600">${total}</span>
        </button>
        ${this.producers.map(pr => {
          const cnt = this.products.filter(x => x.producer_id === pr.id).length;
          const q = qualityFor(pr.id);
          const qcolor = q >= 80 ? '#22c55e' : q >= 50 ? '#fbbf24' : '#ef4444';
          const active = this.productProducerFilter === pr.id;
          return `<button onclick="window.producersModule.setProductProducerFilter('${pr.id}')"
            style="flex-shrink:0;border:1px solid ${active?'#3b82f6':'var(--line)'};background:${active?'#1e3a5f':'var(--bg-2)'};color:var(--text-1);border-radius:10px;padding:8px 12px;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;min-width:150px;text-align:left;gap:3px">
            <span style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);max-width:140px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(pr.name)}</span>
            <span style="font-size:13px;font-weight:600">${cnt}</span>
            ${expectedFields > 0 ? `
              <div style="width:100%;display:flex;align-items:center;gap:4px">
                <div style="flex:1;height:3px;background:#27272a;border-radius:2px;overflow:hidden">
                  <div style="height:100%;width:${q}%;background:${qcolor};border-radius:2px"></div>
                </div>
                <span style="font-size:9px;color:${qcolor};font-weight:600">${q}%</span>
              </div>` : ''}
          </button>`;
        }).join('')}
      </div>
    `;
  }

  /** Панель фильтров по кастомным полям (показывается, если есть поля с show_in_filters). */
  private renderFieldFilters(fields: ProducerFieldDef[]): string {
    return `
      <div style="border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:var(--bg-2);display:flex;flex-wrap:wrap;gap:18px">
        ${fields.map(f => {
          const fv = this.productFieldFilters[f.id];
          if (f.field_type === 'number') {
            const r = fv?.type === 'range' ? fv : { min: '', max: '' };
            return `<div style="display:flex;flex-direction:column;gap:4px;min-width:170px">
              <span style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:${r.min||r.max?'#93c5fd':'var(--text-2)'};font-weight:600">${esc(f.name)}</span>
              <div style="display:flex;gap:5px;align-items:center">
                <input type="number" placeholder="от" value="${esc(r.min)}" oninput="window.producersModule.setFieldFilterRange('${f.id}','min',this.value)"
                  style="width:70px;padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-1);color:var(--text-1);font-size:11px">
                <span style="color:var(--text-2)">—</span>
                <input type="number" placeholder="до" value="${esc(r.max)}" oninput="window.producersModule.setFieldFilterRange('${f.id}','max',this.value)"
                  style="width:70px;padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-1);color:var(--text-1);font-size:11px">
              </div>
            </div>`;
          }
          let options: string[];
          if (f.field_type === 'dropdown' && f.dropdown_options) options = f.dropdown_options;
          else {
            const set = new Set<string>();
            this.products.forEach(p => { const v = (p.field_values?.[f.id] ?? '').trim(); if (v) set.add(v); });
            options = Array.from(set).sort();
          }
          if (options.length === 0) return '';
          const sel = fv?.type === 'select' ? fv.selected : new Set<string>();
          return `<div style="display:flex;flex-direction:column;gap:4px">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:${sel.size?'#93c5fd':'var(--text-2)'};font-weight:600">${esc(f.name)}${sel.size?` (${sel.size})`:''}</span>
            <div style="display:flex;flex-wrap:wrap;gap:4px;max-width:380px">
              ${options.map(o => {
                const on = sel.has(o.toLowerCase());
                return `<button onclick="window.producersModule.toggleFieldFilterOpt('${f.id}', ${JSON.stringify(o).replace(/"/g,'&quot;')})"
                  style="font-size:11px;padding:3px 9px;border-radius:10px;border:1px solid ${on?'#3b82f6':'var(--line)'};background:${on?'#1e3a5f':'var(--bg-1)'};color:${on?'#fff':'var(--text-2)'};cursor:pointer">${esc(o)}</button>`;
              }).join('')}
            </div>
          </div>`;
        }).join('')}
        ${Object.keys(this.productFieldFilters).length>0?`<button onclick="window.producersModule.clearFieldFilters()" style="align-self:flex-end;font-size:11px;color:#ef4444;background:none;border:none;cursor:pointer">× Сбросить все</button>`:''}
      </div>
    `;
  }

  /** Плавающая панель массовых действий. */
  private renderProductSelBar(): string {
    return `
      <div data-sel-bar style="position:fixed;bottom:calc(90px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);z-index:150;
        background:#1a1a1d;border:1px solid #3b82f6;border-radius:14px;padding:10px 16px;
        display:flex;gap:10px;align-items:center;box-shadow:0 20px 60px rgba(59,130,246,.3);white-space:nowrap">
        <span style="background:#3b82f6;color:#fff;border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${this.productSelected.size}</span>
        <span style="color:#fff;font-size:12px">выбрано</span>
        <div style="width:1px;height:18px;background:#3f3f46"></div>
        <button onclick="window.producersModule.openBulkEdit()" style="background:var(--accent);color:#0a0a0a;border:none;padding:6px 11px;border-radius:7px;font-size:11px;cursor:pointer">✎ Редактировать</button>
        <button onclick="window.producersModule.openChangeProducerModal()" style="background:#27272a;color:#fff;border:none;padding:6px 11px;border-radius:7px;font-size:11px;cursor:pointer">🏭 Сменить произв.</button>
        <button onclick="window.producersModule.bulkArchive()" style="background:#27272a;color:#fbbf24;border:none;padding:6px 11px;border-radius:7px;font-size:11px;cursor:pointer">${this.productArchived?'↩ Восстановить':'📦 В архив'}</button>
        <button onclick="window.producersModule.bulkDeleteProducts()" style="background:#450a0a;color:#fca5a5;border:none;padding:6px 11px;border-radius:7px;font-size:11px;cursor:pointer">🗑 Удалить</button>
        <div style="width:1px;height:18px;background:#3f3f46"></div>
        <button onclick="window.producersModule.clearProductSel()" style="background:none;color:var(--text-2);border:none;font-size:11px;cursor:pointer">Снять</button>
      </div>
    `;
  }

  setProductSearch(v: string): void {
    this.productSearch = v;
    if (this._searchDebounce) clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => { this._patchProductTbody(); }, 200);
  }
  setProductProducerFilter(v: string): void { this.productProducerFilter = v; this.render(); }

  private filteredProducts(): ProducerProduct[] {
    let list = this.products;
    if (this.productProducerFilter) list = list.filter(p => p.producer_id === this.productProducerFilter);
    const q = this.productSearch.toLowerCase().trim();
    if (q) list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.articles.some(a => a.toLowerCase().includes(q)) ||
      (p.internal_id != null && String(p.internal_id).includes(q)) ||
      p.id.includes(q),
    );
    for (const [fid, fv] of Object.entries(this.productFieldFilters)) {
      if (fv.type === 'range') {
        list = list.filter(p => {
          const raw = p.field_values?.[fid] ?? '';
          const n = Number(raw);
          if (raw === '' || isNaN(n)) return false;
          if (fv.min !== '' && n < Number(fv.min)) return false;
          if (fv.max !== '' && n > Number(fv.max)) return false;
          return true;
        });
      } else {
        list = list.filter(p => fv.selected.has((p.field_values?.[fid] ?? '').toLowerCase()));
      }
    }
    return list;
  }

  /** Возвращает следующий свободный артикул для поставщика по шаблону PREFIX0001. */
  _generateArticle(producerId: string): string {
    const producer = this.producers.find(x => x.id === producerId);
    const prefix = producer?.prefix?.trim() ?? '';
    if (!prefix) return '';
    const existing = this.products
      .filter(x => x.producer_id === producerId)
      .flatMap(x => x.articles);
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$', 'i');
    let max = 0;
    for (const a of existing) {
      const m = a.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return prefix + String(max + 1).padStart(4, '0');
  }

  _clickAutoArticle(): void {
    const sel = document.querySelector<HTMLSelectElement>('#product-form [name="producer_id"]');
    const inp = document.querySelector<HTMLInputElement>('#product-form [name="article"]');
    if (!sel || !inp) return;
    const g = this._generateArticle(sel.value);
    if (g) { inp.value = g; inp.dataset.auto = '1'; }
    else this.toast('У поставщика не задан префикс', 'info');
  }

  /** Вызывается из формы при смене поставщика — обновляет авто-артикул если поле пустое или авто. */
  _onProducerChangeInForm(): void {
    const sel = document.querySelector<HTMLSelectElement>('#product-form [name="producer_id"]');
    const inp = document.querySelector<HTMLInputElement>('#product-form [name="article"]');
    if (!sel || !inp) return;
    const gen = this._generateArticle(sel.value);
    if (!inp.value || inp.dataset.auto === '1') {
      inp.value = gen;
      inp.dataset.auto = '1';
    }
  }

  openProductForm(id?: string): void {
    if (this.producers.length === 0) { this.toast('Сначала добавьте поставщика', 'info'); return; }
    const p = id ? this.products.find(x => x.id === id) : null;
    const defaultProducerId = p?.producer_id ?? this.producers[0].id;
    const autoArticle = !p ? this._generateArticle(defaultProducerId) : '';
    const f = {
      isNew: !p,
      producer_id: defaultProducerId,
      name: p?.name ?? '',
      articles: p?.articles?.length ? [...p.articles] : [autoArticle],
      field_values: { ...(p?.field_values ?? {}) } as Record<string, string>,
      comment: p?.comment ?? '',
    };
    this.showModal(p ? 'Редактировать товар' : 'Новый товар', this.productFormHtml(f), async () => {
      const root = document.getElementById('product-form')!;
      const get = (n: string) => (root.querySelector(`[name="${n}"]`) as HTMLInputElement)?.value ?? '';
      const articles = Array.from(root.querySelectorAll<HTMLInputElement>('[name="article"]'))
        .map(i => i.value.trim()).filter(Boolean);
      const fv: Record<string, string> = {};
      for (const fld of this.fields) {
        const v = (root.querySelector(`[name="fv_${fld.id}"]`) as HTMLInputElement | HTMLSelectElement)?.value ?? '';
        if (v.trim()) fv[fld.id] = v;
      }
      const name = get('name').trim();
      const producer_id = get('producer_id');
      if (!name) { this.toast('Укажите название', 'error'); return false; }
      const payload: Record<string, unknown> = {
        producer_id, name, articles, field_values: fv,
        comment: get('comment').trim() || null, is_archived: false,
      };
      if (!p) payload.internal_id = this._generateInternalId();
      try {
        if (p) { await producerProductDb.update(p.id, payload as any); this.toast('Сохранено', 'success'); }
        else   { await producerProductDb.create(payload as any); this.toast('Товар добавлен', 'success'); }
        await this.loadProducts();
        this.render();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  private productFormHtml(f: any): string {
    return `
      <form id="product-form" style="display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto;padding-right:6px">
        <div style="border:1px solid #1e3a5f;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;background:rgba(30,58,95,.1)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#93c5fd;font-weight:600">★ Обязательные поля</div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Поставщик *
            <select name="producer_id" onchange="window.producersModule._onProducerChangeInForm()"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
              ${this.producers.map(p => `<option value="${p.id}" ${p.id===f.producer_id?'selected':''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Наименование *
            <input name="name" value="${esc(f.name)}" placeholder="Полное имя товара"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
          </label>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span style="font-size:11px;color:var(--text-2)">Артикулы поставщика <span style="color:var(--text-2);font-style:italic">(необязательно)</span></span>
            <div id="prod-articles" style="display:flex;flex-direction:column;gap:5px">
              ${f.articles.map((a: string, i: number) => `
                <div style="display:flex;gap:6px;align-items:center">
                  <span style="font-size:10px;color:var(--text-2);width:18px">#${i+1}</span>
                  <input name="article" value="${esc(a)}"
                    ${i === 0 && f.isNew ? 'data-auto="1"' : ''}
                    ${i === 0 ? 'oninput="this.dataset.auto=\'0\'"' : ''}
                    placeholder="${i===0?'Основной артикул':'Дополнительный'}"
                    style="flex:1;padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
                  ${i === 0
                    ? '<button type="button" title="Авто-артикул по префиксу поставщика" onclick="window.producersModule._clickAutoArticle()" style="flex-shrink:0;padding:5px 9px;border:1px solid rgba(99,102,241,.4);border-radius:5px;background:rgba(99,102,241,.12);color:#a5b4fc;font-size:11px;cursor:pointer;white-space:nowrap">✦ Авто</button>'
                    : '<button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px">×</button>'}
                </div>
              `).join('')}
            </div>
            <button type="button" onclick="window.producersModule.addArticleField()" style="align-self:flex-start;background:none;border:1px dashed var(--line);color:var(--text-2);padding:4px 10px;border-radius:5px;font-size:11px;cursor:pointer">+ Артикул</button>
          </div>
        </div>

        ${this.fields.length > 0 ? `
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);font-weight:600">Дополнительные характеристики</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${this.fields.map(fld => this.renderFieldInput(fld, f.field_values[fld.id] ?? '')).join('')}
          </div>
        </div>` : ''}

        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Комментарий
          <textarea name="comment" rows="2"
            style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-family:inherit;resize:vertical">${esc(f.comment)}</textarea>
        </label>
      </form>
    `;
  }

  private renderFieldInput(f: ProducerFieldDef, v: string): string {
    const base = `padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px;width:100%`;
    if (f.field_type === 'dropdown' && f.dropdown_options) {
      return `<label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text-2)">
        ${esc(f.name)}${f.is_locked ? ' *' : ''}
        <select name="fv_${f.id}" style="${base}">
          <option value="">— не выбрано —</option>
          ${f.dropdown_options.map(o => `<option value="${esc(o)}" ${v===o?'selected':''}>${esc(o)}</option>`).join('')}
        </select>
      </label>`;
    }
    const type = f.field_type === 'number' ? 'number' : 'text';
    return `<label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text-2)">
      ${esc(f.name)}${f.is_locked ? ' *' : ''}
      <input type="${type}" name="fv_${f.id}" value="${esc(v)}" style="${base}">
    </label>`;
  }

  addArticleField(): void {
    const container = document.getElementById('prod-articles');
    if (!container) return;
    const n = container.children.length + 1;
    if (n > 5) { this.toast('Не более 5 артикулов', 'info'); return; }
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:6px;align-items:center';
    div.innerHTML = `
      <span style="font-size:10px;color:var(--text-2);width:18px">#${n}</span>
      <input name="article" placeholder="Дополнительный"
        style="flex:1;padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
      <button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px">×</button>
    `;
    container.appendChild(div);
  }

  async deleteProduct(id: string): Promise<void> {
    if (!confirm('Удалить товар?')) return;
    try {
      await producerProductDb.remove(id);
      await this.loadProducts();
      this.render();
      this.toast('Удалено', 'success');
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ── Fields modal ──────────────────────────────────────────────────────────

  openFieldsModal(): void {
    this.showModal('Настройка полей товаров', this.fieldsModalHtml(), null,
      { saveText: 'Закрыть', cancelText: '' });
  }

  private fieldsModalHtml(): string {
    const TYPE_LABEL: Record<string, string> = {
      text: 'Только текст', number: 'Только число', mixed: 'Текст + число', dropdown: 'Список вариантов',
    };
    return `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:11px;color:var(--text-2)">
          Поля применяются ко всем товарам. Перетаскивайте за <span style="color:var(--text-1);font-weight:600">⋮⋮</span> для смены порядка. «Себестоимость» — системное.
        </div>
        <div id="fields-list" style="display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto">
          ${this.fields.map(f => `
            <div data-fid="${f.id}" draggable="${!f.is_locked}"
              ondragstart="window.producersModule.onFieldDragStart(event, '${f.id}')"
              ondragover="event.preventDefault()"
              ondrop="window.producersModule.onFieldDrop(event, '${f.id}')"
              style="display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);${!f.is_locked?'cursor:grab':''}">
              ${!f.is_locked ? `<span style="color:var(--text-2);font-size:14px;user-select:none">⋮⋮</span>` : ''}
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:500">${esc(f.name)}</div>
                <div style="font-size:10px;color:var(--text-2)">${TYPE_LABEL[f.field_type] || f.field_type}${f.dropdown_options ? ` · ${f.dropdown_options.length} вариантов`:''}</div>
              </div>
              ${!f.is_locked ? `
                <label style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--text-2);cursor:pointer">
                  <input type="checkbox" ${f.show_in_filters?'checked':''} onchange="window.producersModule.toggleFieldFilter('${f.id}', this.checked)">
                  в фильтрах
                </label>
                <button class="btn" onclick="window.producersModule.editField('${f.id}')" style="padding:3px 8px;font-size:11px">${IC.edit}</button>
                <button class="btn" onclick="window.producersModule.deleteField('${f.id}')" style="padding:3px 8px;font-size:11px;color:#ef4444">${IC.trash}</button>
              ` : `<span style="font-size:10px;background:#1e3a5f;color:#93c5fd;padding:2px 7px;border-radius:10px">системное</span>`}
            </div>
          `).join('')}
        </div>

        <div style="border-top:1px solid var(--line);padding-top:10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);margin-bottom:8px">Добавить новое поле</div>
          <div style="display:grid;grid-template-columns:1.4fr 1fr 90px;gap:8px;align-items:end">
            <input id="new-field-name" placeholder="Название (Вес, Цвет, Размер…)"
              style="padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
            <select id="new-field-type"
              style="padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
              <option value="mixed">Текст + число</option>
              <option value="text">Только текст</option>
              <option value="number">Только число</option>
              <option value="dropdown">Список вариантов</option>
            </select>
            <button class="btn" onclick="window.producersModule.addField()"
              style="background:var(--accent);color:#0a0a0a;border:none;padding:7px 11px;border-radius:5px;font-size:11px">Добавить</button>
          </div>
          <div style="font-size:10px;color:var(--text-2);margin-top:6px">
            Для «Список вариантов» введите варианты через запятую в названии после двоеточия, например: <code>Цвет: красный, синий, зелёный</code>
          </div>
        </div>
      </div>
    `;
  }

  private __fieldDragId: string | null = null;
  onFieldDragStart(_e: DragEvent, id: string): void { this.__fieldDragId = id; }
  async onFieldDrop(_e: DragEvent, targetId: string): Promise<void> {
    const fromId = this.__fieldDragId;
    this.__fieldDragId = null;
    if (!fromId || fromId === targetId) return;
    const ids = this.fields.map(f => f.id);
    const from = ids.indexOf(fromId);
    const to   = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    try {
      // Persist new sort_order: 10, 20, 30, ... (lock Себестоимость stays at -100)
      let idx = 0;
      for (const id of ids) {
        const fld = this.fields.find(f => f.id === id);
        if (!fld || fld.is_locked) continue;
        await producerFieldDb.update(id, { sort_order: (++idx) * 10 });
      }
      await this.loadFields();
      this.toast('Порядок сохранён', 'success');
      this.openFieldsModal();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  async toggleFieldFilter(id: string, on: boolean): Promise<void> {
    try {
      await producerFieldDb.update(id, { show_in_filters: on });
      await this.loadFields();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  editField(id: string): void {
    const f = this.fields.find(x => x.id === id);
    if (!f || f.is_locked) return;
    const html = `
      <form id="edit-field-form" style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Название
          <input name="name" value="${esc(f.name)}" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Тип
          <select name="type" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
            <option value="mixed" ${f.field_type==='mixed'?'selected':''}>Текст + число</option>
            <option value="text" ${f.field_type==='text'?'selected':''}>Только текст</option>
            <option value="number" ${f.field_type==='number'?'selected':''}>Только число</option>
            <option value="dropdown" ${f.field_type==='dropdown'?'selected':''}>Список вариантов</option>
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Варианты (через запятую, только для dropdown)
          <input name="opts" value="${esc((f.dropdown_options??[]).join(', '))}" placeholder="красный, синий, зелёный"
            style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
        <label style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text-1);cursor:pointer">
          <input type="checkbox" name="filter" ${f.show_in_filters?'checked':''}> Показывать в фильтрах
        </label>
      </form>
    `;
    this.showModal(`Поле «${f.name}»`, html, async () => {
      const root = document.getElementById('edit-field-form')!;
      const name = (root.querySelector('[name="name"]') as HTMLInputElement).value.trim();
      const type = (root.querySelector('[name="type"]') as HTMLSelectElement).value as any;
      const optsRaw = (root.querySelector('[name="opts"]') as HTMLInputElement).value.trim();
      const filter = (root.querySelector('[name="filter"]') as HTMLInputElement).checked;
      const opts = type === 'dropdown' ? optsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
      if (!name) { this.toast('Укажите название', 'error'); return false; }
      if (type === 'dropdown' && (!opts || opts.length < 2)) { this.toast('Минимум 2 варианта', 'error'); return false; }
      try {
        await producerFieldDb.update(id, { name, field_type: type, dropdown_options: opts, show_in_filters: filter });
        await this.loadFields();
        this.toast('Сохранено', 'success');
        this.openFieldsModal();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  async addField(): Promise<void> {
    const rawName = (document.getElementById('new-field-name') as HTMLInputElement)?.value.trim() ?? '';
    const type = (document.getElementById('new-field-type') as HTMLSelectElement)?.value ?? 'mixed';
    if (!rawName) { this.toast('Укажите название', 'error'); return; }
    let name = rawName, options: string[] | null = null;
    if (type === 'dropdown' && rawName.includes(':')) {
      const [n, opts] = rawName.split(':');
      name = n.trim();
      options = opts.split(',').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) { this.toast('Нужно минимум 2 варианта', 'error'); return; }
    } else if (type === 'dropdown') {
      this.toast('Для dropdown укажите варианты: «Название: вар1, вар2, вар3»', 'error'); return;
    }
    try {
      await producerFieldDb.create({
        name, field_type: type as any, dropdown_options: options,
        is_locked: false, show_in_filters: false, sort_order: (this.fields.length + 1) * 10,
      });
      await this.loadFields();
      this.toast('Поле добавлено', 'success');
      this.openFieldsModal();
    } catch (e: any) {
      console.error('[addField]', e);
      this.toast(e?.message ?? 'Ошибка создания поля', 'error');
    }
  }

  async deleteField(id: string): Promise<void> {
    if (!confirm('Удалить поле? Данные в нём будут потеряны.')) return;
    try {
      await producerFieldDb.remove(id);
      await this.loadFields();
      this.toast('Удалено', 'success');
      this.openFieldsModal();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 3: MAPPINGS — артикул маркетплейса ↔ товар производителя
  // ════════════════════════════════════════════════════════════════════════

  // Confidence chip style helper
  private confStyle(c: string): { bg: string; text: string; label: string } {
    const map: Record<string, { bg: string; text: string; label: string }> = {
      exact:     { bg: '#052e16', text: '#4ade80', label: 'Точный' },
      model:     { bg: '#451a03', text: '#fb923c', label: 'Похожие' },
      uncertain: { bg: '#450a0a', text: '#f87171', label: 'Неточно' },
      manual:    { bg: '#1e3a5f', text: '#93c5fd', label: 'Вручную' },
    };
    return map[c] ?? map.uncertain;
  }

  /** Возвращает pending-список с учётом всех активных фильтров (поиск, префикс, производитель).
   *  Используется в рендере, авто-связке и массовых действиях. */
  private _filteredPendingList(withProducerFilter = true): Array<{ article: string; name: string }> {
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const orderedSet = new Set(this.orders.map(o => o.marketplace_article));
    let list = this.mpArticles.filter(a => !mappedSet.has(a.article));
    if (this.mappingOnlyOrdered) list = list.filter(it => orderedSet.has(it.article));

    const q = this.mappingSearch.toLowerCase();
    if (q) list = list.filter(it => it.article.toLowerCase().includes(q) || it.name.toLowerCase().includes(q));

    if (this.mappingUnknownPrefixFilter) {
      const mfrsWithPrefix = this.producers.filter(p => p.prefix?.trim());
      list = list.filter(it =>
        !mfrsWithPrefix.some(p => it.article.toLowerCase().startsWith(p.prefix.trim().toLowerCase()))
      );
    } else if (this.mappingPrefixFilter) {
      const pfx = this.mappingPrefixFilter.toLowerCase();
      list = list.filter(it => it.article.toLowerCase().startsWith(pfx));
    }

    if (withProducerFilter && this.mappingProducerFilter) {
      list = list.filter(it => {
        const sugs = this.mpSuggestions.get(it.article) ?? [];
        return sugs.some(s => {
          const pp = this.products.find(p => p.id === s.productId);
          return pp?.producer_id === this.mappingProducerFilter;
        });
      });
    }

    return list;
  }

  private renderMappingsTab(): string {
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const orderedSet = new Set(this.orders.map(o => o.marketplace_article));
    const allPending = this.mpArticles.filter(a => !mappedSet.has(a.article));
    const pending = this.mappingOnlyOrdered ? allPending.filter(it => orderedSet.has(it.article)) : allPending;
    const linked = [...new Set(this.mappings.map(m => m.marketplace_article))];
    const orderedPendingCount = allPending.filter(it => orderedSet.has(it.article)).length;

    // Confidence counts for stats bar
    const confCounts = { exact: 0, model: 0, uncertain: 0, none: 0 };
    if (this.mpSuggestions.size > 0) {
      for (const it of pending) {
        const sugs = this.mpSuggestions.get(it.article) ?? [];
        if (sugs.length === 0) { confCounts.none++; continue; }
        const best = sugs.reduce((a, b) => {
          const order = { exact: 0, model: 1, manual: 1, uncertain: 2 };
          return (order[a.confidence as keyof typeof order] ?? 2) <= (order[b.confidence as keyof typeof order] ?? 2) ? a : b;
        });
        const k = (best.confidence === 'manual' ? 'model' : best.confidence) as 'exact' | 'model' | 'uncertain';
        confCounts[k]++;
      }
    }

    const hasSuggestions = this.mpSuggestions.size > 0;

    // Producers visible in suggestions
    const producersWithSuggestions = new Set<string>();
    for (const [, sugs] of this.mpSuggestions) for (const s of sugs) {
      const pp = this.products.find(p => p.id === s.productId);
      if (pp) producersWithSuggestions.add(pp.producer_id);
    }

    return `
      <div style="display:flex;flex-direction:column;gap:8px;flex:1;overflow:hidden">

        <!-- Toolbar -->
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input value="${esc(this.mappingSearch)}" placeholder="🔍 Артикул или название…"
            oninput="window.producersModule.setMappingSearch(this.value)"
            style="width:220px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px">
          <button class="btn" onclick="window.producersModule.openMpArticlesImport()" style="padding:6px 11px;font-size:11px">📥 Артикулы МП</button>
          ${this.mpArticles.length > 0 ? `
            <button id="auto-suggest-btn" class="btn" onclick="window.producersModule.runAutoSuggest()"
              ${this.autoSuggestLoading ? 'disabled' : ''}
              style="padding:6px 11px;font-size:11px;display:flex;align-items:center;gap:6px;${this.autoSuggestLoading ? 'opacity:.7;cursor:not-allowed' : ''}">
              ${this.autoSuggestLoading
                ? `<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0"></span> Подбираю…`
                : '🔗 Авто-связка'}
            </button>
          ` : ''}
          <button onclick="window.producersModule.toggleMappingOnlyOrdered()"
            style="padding:6px 11px;font-size:11px;border:1px solid ${this.mappingOnlyOrdered?'rgba(59,130,246,.4)':'var(--line)'};
              background:${this.mappingOnlyOrdered?'rgba(59,130,246,.15)':'transparent'};color:${this.mappingOnlyOrdered?'#93c5fd':'var(--text-2)'};
              border-radius:6px;cursor:pointer">📋 Заказанные (${orderedPendingCount})</button>
          <div style="flex:1"></div>
          ${this.lastAutoSuggestBatch.size > 0 ? `
            <button onclick="window.producersModule.undoAutoSuggest()"
              style="padding:6px 10px;font-size:11px;border:1px solid rgba(251,191,36,.3);background:transparent;color:#fbbf24;border-radius:6px;cursor:pointer">↺ Отмена</button>
          ` : ''}
        </div>

        <!-- Stats bar -->
        <div style="display:flex;align-items:center;gap:12px;padding:7px 12px;border-radius:8px;font-size:11px;background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.15)">
          <span style="color:var(--text-2)">В каталоге: <b style="color:var(--text-1)">${this.mpArticles.length}</b></span>
          <span style="color:#fbbf24">Ожидают: <b>${pending.length}</b></span>
          <span style="color:#4ade80">Связано: <b>${linked.length}</b></span>
          ${hasSuggestions ? `
            <span style="width:1px;height:12px;background:var(--line)"></span>
            <span style="color:#4ade80">🟢 <b>${confCounts.exact}</b></span>
            <span style="color:#fb923c">🟡 <b>${confCounts.model}</b></span>
            <span style="color:#f87171">🔴 <b>${confCounts.uncertain}</b></span>
            <span style="color:var(--text-2)">— <b>${confCounts.none}</b></span>
          ` : ''}
          <div style="flex:1"></div>
          <span data-mapping-sel-count style="color:#4ade80;font-weight:500;display:${this.mappingSelectedKeys.size > 0 && !this.mappingCreating ? '' : 'none'}">Выбрано: ${this.mappingSelectedKeys.size}</span>
          <button data-mapping-create-btn onclick="window.producersModule.createMappingsBulk()"
            ${this.mappingCreating ? 'disabled' : ''}
            style="padding:4px 12px;background:var(--accent);color:#0a0a0a;border:none;border-radius:5px;font-size:11px;cursor:${this.mappingCreating?'default':'pointer'};font-weight:500;display:${this.mappingSelectedKeys.size > 0 || this.mappingCreating ? 'flex' : 'none'};align-items:center;gap:6px;opacity:${this.mappingCreating?'.7':'1'}">
            ${this.mappingCreating
              ? `<span style="display:inline-block;width:11px;height:11px;border:2px solid rgba(0,0,0,.3);border-top-color:#000;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0"></span> Сохраняю…`
              : `✓ Создать (${this.mappingSelectedKeys.size})`}
          </button>
        </div>

        <!-- Confidence + manufacturer filters (after auto-suggest) -->
        ${hasSuggestions ? `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:7px;border:1px solid var(--line);background:var(--bg-2)">
              <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-right:2px">Совпадение:</span>
              ${[
                { k: 'all', label: 'Все', color: 'var(--text-2)', bg: 'transparent' },
                { k: 'exact', label: `🟢 ${confCounts.exact}`, color: '#4ade80', bg: '#052e16' },
                { k: 'model', label: `🟡 ${confCounts.model}`, color: '#fb923c', bg: '#451a03' },
                { k: 'uncertain', label: `🔴 ${confCounts.uncertain}`, color: '#f87171', bg: '#450a0a' },
                { k: 'none', label: `— ${confCounts.none}`, color: 'var(--text-2)', bg: 'var(--bg-1)' },
              ].map(({ k, label, color, bg }) => {
                const active = this.mappingConfidenceFilter === k;
                return `<button onclick="window.producersModule.setMappingConfFilter('${k}')"
                  style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;font-weight:500;
                    border:1px solid ${active?color+'40':'transparent'};
                    background:${active?bg:'transparent'};color:${active?color:'var(--text-2)'}">${label}</button>`;
              }).join('')}
            </div>
            <div style="flex:1"></div>
            <button onclick="window.producersModule.bulkPickAllExact()"
              style="padding:4px 10px;font-size:11px;border-radius:5px;cursor:pointer;background:#052e16;color:#4ade80;border:1px solid #4ade8040">🟢 Все точные</button>
            <button onclick="window.producersModule.bulkPickFirst()"
              style="padding:4px 10px;font-size:11px;border-radius:5px;cursor:pointer;background:#052e16;color:#4ade80;border:1px solid #16653480">✓ Первые</button>
            <button onclick="window.producersModule.bulkDeselectUncertain()"
              style="padding:4px 10px;font-size:11px;border-radius:5px;cursor:pointer;background:#450a0a;color:#f87171;border:1px solid #f8717140">🔴 Убрать неточные</button>
            <button onclick="window.producersModule.clearMappingSelection()"
              style="padding:4px 10px;font-size:11px;border-radius:5px;cursor:pointer;background:var(--bg-2);color:var(--text-2);border:1px solid var(--line)">✕ Снять все</button>
          </div>
        ` : ''}

        <!-- Prefix groups filter -->
        ${(() => {
          const mfrsWithPrefix = this.producers.filter(p => p.prefix?.trim());
          if (mfrsWithPrefix.length === 0 || this.mpArticles.length === 0) return '';
          const baseList = this.mappingSubtab === 'pending'
            ? this.mpArticles.filter(a => !new Set(this.mappings.map(m => m.marketplace_article)).has(a.article))
            : this.mpArticles.filter(a => new Set(this.mappings.map(m => m.marketplace_article)).has(a.article));
          const groups = mfrsWithPrefix.map(p => {
            const pfx = p.prefix.trim().toLowerCase();
            const count = baseList.filter(a => a.article.toLowerCase().startsWith(pfx)).length;
            return { prefix: p.prefix.trim(), name: p.name, count };
          }).filter(g => g.count > 0);
          const unknownCount = baseList.filter(a =>
            !mfrsWithPrefix.some(p => a.article.toLowerCase().startsWith(p.prefix.trim().toLowerCase()))
          ).length;
          if (groups.length === 0 && unknownCount === 0) return '';
          const isUnknown = this.mappingUnknownPrefixFilter;
          const selPfx = this.mappingPrefixFilter;
          return `
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:5px 8px;border-radius:7px;border:1px solid var(--line);background:var(--bg-2)">
              <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-right:2px;flex-shrink:0">Производитель:</span>
              <button onclick="window.producersModule.setMappingPrefixFilter('')"
                style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;
                  border:1px solid ${!selPfx && !isUnknown ? 'rgba(99,102,241,.5)' : 'transparent'};
                  background:${!selPfx && !isUnknown ? 'rgba(99,102,241,.15)' : 'transparent'};
                  color:${!selPfx && !isUnknown ? '#a5b4fc' : 'var(--text-2)'}">
                Все (${baseList.length})
              </button>
              ${groups.map(g => {
                const active = selPfx === g.prefix && !isUnknown;
                return `<button onclick="window.producersModule.setMappingPrefixFilter(${esc(JSON.stringify(g.prefix))})"
                  style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;
                    border:1px solid ${active ? 'rgba(59,130,246,.4)' : 'transparent'};
                    background:${active ? 'rgba(59,130,246,.15)' : 'transparent'};
                    color:${active ? '#93c5fd' : 'var(--text-2)'}">
                  ${esc(g.name)} (${g.count})
                </button>`;
              }).join('')}
              ${unknownCount > 0 ? `
                <button onclick="window.producersModule.toggleMappingUnknownPrefix()"
                  style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;
                    border:1px solid ${isUnknown ? 'rgba(251,191,36,.4)' : 'transparent'};
                    background:${isUnknown ? 'rgba(251,191,36,.1)' : 'transparent'};
                    color:${isUnknown ? '#fbbf24' : 'var(--text-2)'}">
                  Не опознанные (${unknownCount})
                </button>
              ` : ''}
            </div>
          `;
        })()}

        <!-- Underline tabs -->
        <div style="display:flex;border-bottom:1px solid var(--line);gap:0">
          <button onclick="window.producersModule.setMappingSubtab('pending')"
            style="padding:8px 16px;font-size:13px;font-weight:500;border:none;background:transparent;cursor:pointer;
              border-bottom:2px solid ${this.mappingSubtab==='pending'?'#3b82f6':'transparent'};
              color:${this.mappingSubtab==='pending'?'var(--text-1)':'var(--text-2)'};margin-bottom:-1px">
            Ожидают связки
            <span style="margin-left:6px;font-size:10px;padding:1px 7px;border-radius:20px;
              background:${this.mappingSubtab==='pending'?'rgba(59,130,246,.2)':'var(--bg-2)'};
              color:${this.mappingSubtab==='pending'?'#93c5fd':'var(--text-2)'}">${pending.length}</span>
          </button>
          <button onclick="window.producersModule.setMappingSubtab('linked')"
            style="padding:8px 16px;font-size:13px;font-weight:500;border:none;background:transparent;cursor:pointer;
              border-bottom:2px solid ${this.mappingSubtab==='linked'?'#4ade80':'transparent'};
              color:${this.mappingSubtab==='linked'?'var(--text-1)':'var(--text-2)'};margin-bottom:-1px">
            Связаны
            <span style="margin-left:6px;font-size:10px;padding:1px 7px;border-radius:20px;
              background:${this.mappingSubtab==='linked'?'rgba(74,222,128,.15)':'var(--bg-2)'};
              color:${this.mappingSubtab==='linked'?'#4ade80':'var(--text-2)'}">${linked.length}</span>
          </button>
        </div>

        ${this.mappingSubtab === 'pending'
          ? this.renderPendingMappings(pending)
          : this.renderLinkedMappings()}
      </div>
    `;
  }

  private _getSortedFilteredPendingList(): Array<{ article: string; name: string }> {
    let list = this._filteredPendingList();
    if (this.mappingConfidenceFilter !== 'all') {
      list = list.filter(it => {
        const sugs = this.mpSuggestions.get(it.article) ?? [];
        if (sugs.length === 0) return this.mappingConfidenceFilter === 'none';
        const bestC = sugs.reduce((a, b) => {
          const order = { exact: 0, model: 1, manual: 1, uncertain: 2 };
          return (order[a.confidence as keyof typeof order] ?? 2) <= (order[b.confidence as keyof typeof order] ?? 2) ? a : b;
        }).confidence;
        return bestC === this.mappingConfidenceFilter || (bestC === 'manual' && this.mappingConfidenceFilter === 'model');
      });
    }
    if (this.mpSuggestions.size > 0) {
      const confOrder: Record<string, number> = { exact: 0, model: 1, manual: 1, uncertain: 2 };
      list = [...list].sort((a, b) => {
        const sa = this.mpSuggestions.get(a.article) ?? [];
        const sb = this.mpSuggestions.get(b.article) ?? [];
        const ca = sa.length === 0 ? 3 : Math.min(...sa.map(s => confOrder[s.confidence] ?? 2));
        const cb = sb.length === 0 ? 3 : Math.min(...sb.map(s => confOrder[s.confidence] ?? 2));
        return ca - cb;
      });
    }
    return list;
  }

  private renderPendingMappings(pending: Array<{ article: string; name: string }>): string {
    if (this.mpArticles.length === 0) {
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;border:1px dashed var(--line);border-radius:10px;padding:40px">
        <div style="font-size:34px;opacity:.3">📦</div>
        <div style="font-size:13px;color:var(--text-2);max-width:340px;text-align:center">
          Загрузите артикулы из маркетплейсов или импортируйте вручную.
        </div>
        <button onclick="window.producersModule.openMpArticlesImport()"
          style="padding:9px 16px;background:var(--accent);color:#0a0a0a;border:none;border-radius:7px;font-size:12px;cursor:pointer">📥 Загрузить артикулы МП</button>
      </div>`;
    }

    const list = this._getSortedFilteredPendingList();
    const visible = list.slice(0, this.mappingVisibleCount);
    const hasMore = list.length > this.mappingVisibleCount;

    const productsById = new Map(this.products.map(p => [p.id, p]));
    const producersById = new Map(this.producers.map(p => [p.id, p]));

    return `
      <div id="pm-pending-list" onscroll="window.producersModule._onPendingScroll(this)"
        style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg-1)">
        ${list.length === 0
          ? `<div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">${pending.length === 0 ? '🎉 Все артикулы связаны' : 'Нет артикулов по фильтру'}</div>`
          : visible.map(it => this.renderPendingRow(it, productsById, producersById)).join('')}
        ${hasMore ? `<div class="pm-pending-more" style="padding:8px;text-align:center;color:var(--text-2);font-size:11px">↓</div>` : ''}
      </div>
    `;
  }

  private renderPendingRow(
    it: { article: string; name: string },
    productsById: Map<string, ProducerProduct>,
    producersById: Map<string, Producer>,
  ): string {
    const sugs = this.mpSuggestions.get(it.article) ?? [];
    // esc(JSON.stringify(...)) is needed because JSON.stringify wraps in "..." which breaks HTML attributes delimited by "..."
    const htmlArt = esc(JSON.stringify(it.article));

    return `
      <div style="display:flex;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line)">
        <div style="width:38%;min-width:0;flex-shrink:0">
          <code style="font-size:12px;color:var(--text-1);display:inline-flex;align-items:center;gap:4px;font-family:monospace">${esc(it.article)}${copyButton(it.article, 'Копировать артикул')}</code>
          ${it.name ? `<div style="font-size:11px;color:var(--text-2);margin-top:2px;display:flex;align-items:center;gap:4px;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(it.name)}</span>${copyButton(it.name, 'Копировать название')}</div>` : ''}
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
          ${sugs.length === 0
            ? (this.mpSuggestions.size === 0
              ? `<div style="font-size:11px;color:var(--text-2);font-style:italic;padding:2px 0">нажмите «Авто-связка» или найдите вручную</div>`
              : `<div style="font-size:11px;color:var(--text-2);font-style:italic;padding:2px 0">Нет предложений</div>`)
            : sugs.map(s => {
              const pp = productsById.get(s.productId);
              if (!pp) return '';
              const pr = producersById.get(pp.producer_id);
              const key = `${it.article}__${s.productId}`;
              const checked = this.mappingSelectedKeys.has(key);
              const cs = this.confStyle(s.confidence);
              const qty = this.mappingKeyQty.get(key) ?? 1;
              return `
                <div style="display:flex;align-items:center;gap:4px">
                  <label style="display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;cursor:pointer;flex:1;min-width:0;
                    background:${checked?'rgba(59,130,246,.12)':'transparent'};
                    border:1px solid ${checked?'rgba(59,130,246,.3)':'transparent'}">
                    <input type="checkbox" ${checked?'checked':''} class="w4h4"
                      onchange="window.producersModule.toggleMappingKey(${esc(JSON.stringify(key))})">
                    <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;flex-shrink:0;letter-spacing:.3px;background:${cs.bg};color:${cs.text}">${cs.label}</span>
                    <span style="font-size:10px;color:var(--text-2);flex-shrink:0;min-width:80px;text-transform:uppercase;letter-spacing:.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pr?.name??'')}</span>
                    <code style="font-size:10px;color:var(--text-2);flex-shrink:0;font-family:monospace">${esc(pp.articles[0]??'')}</code>
                    <span style="font-size:11px;color:var(--text-1);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pp.name)}</span>
                  </label>
                  <label style="display:flex;align-items:center;gap:3px;flex-shrink:0">
                    <span style="font-size:10px;color:var(--text-2)">×</span>
                    <input type="number" min="1" step="1" value="${qty}"
                      oninput="window.producersModule.setMappingKeyQty(${esc(JSON.stringify(key))},+this.value||1)"
                      style="width:48px;padding:3px 5px;border:1px solid var(--line);border-radius:4px;background:var(--bg-2);color:var(--text-1);font-size:11px;text-align:center">
                  </label>
                </div>
              `;
            }).join('')}
          <div style="position:relative;margin-top:4px">
            <input placeholder="Найти вручную (артикул или название)…" autocomplete="off"
              oninput="window.producersModule._manualSearchInput(this,${htmlArt})"
              onblur="window.producersModule._manualSearchBlur(this)"
              style="width:100%;box-sizing:border-box;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:11px">
            <div style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:2px;z-index:200;border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:180px;background:var(--bg-1);box-shadow:0 4px 16px rgba(0,0,0,.4)"></div>
          </div>
        </div>
      </div>
    `;
  }

  _manualSearchInput(input: HTMLInputElement, article: string): void {
    const drop = input.nextElementSibling as HTMLElement;
    if (!drop) return;
    const q = input.value.toLowerCase().trim();
    if (!q) { drop.style.display = 'none'; drop.innerHTML = ''; return; }
    const matched = this.products
      .filter(p => p.name.toLowerCase().includes(q) || p.articles.some(a => a.toLowerCase().includes(q)))
      .slice(0, 30);
    const htmlArt = esc(JSON.stringify(article));
    drop.innerHTML = matched.length === 0
      ? `<div style="padding:12px;text-align:center;font-size:11px;color:var(--text-2)">Ничего не найдено</div>`
      : matched.map(p => {
          const pr = this.producers.find(x => x.id === p.producer_id);
          return `
            <div onmousedown="window.producersModule.pickManualInline(${esc(JSON.stringify(p.id))},${htmlArt})"
              style="padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:8px;align-items:center"
              onmouseenter="this.style.background='var(--bg-2)'" onmouseleave="this.style.background='transparent'">
              <code style="font-size:10px;color:var(--text-2);min-width:56px;flex-shrink:0">${esc(p.articles[0]??'')}</code>
              <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
              <span style="font-size:10px;color:var(--text-2);flex-shrink:0">${esc(pr?.name??'')}</span>
            </div>
          `;
        }).join('');
    drop.style.display = 'block';
  }

  _manualSearchBlur(input: HTMLInputElement): void {
    const drop = input.nextElementSibling as HTMLElement;
    setTimeout(() => { if (drop) drop.style.display = 'none'; }, 160);
  }

  private renderLinkedMappings(): string {
    const q = this.mappingSearch.toLowerCase();

    // Build set of unique linked articles
    const mappedArticles = [...new Set(this.mappings.map(m => m.marketplace_article))];
    let linkedArticles = mappedArticles;
    if (q) {
      linkedArticles = linkedArticles.filter(art => {
        if (art.toLowerCase().includes(q)) return true;
        const mps = this.mappings.filter(m => m.marketplace_article === art);
        return mps.some(m => {
          const pp = this.products.find(p => p.id === m.producer_product_id);
          return pp && (pp.name.toLowerCase().includes(q) || pp.articles.some(a => a.toLowerCase().includes(q)));
        });
      });
    }
    if (this.mappingProducerFilter) {
      linkedArticles = linkedArticles.filter(art => {
        const mps = this.mappings.filter(m => m.marketplace_article === art);
        return mps.some(m => {
          const pp = this.products.find(p => p.id === m.producer_product_id);
          return pp?.producer_id === this.mappingProducerFilter;
        });
      });
    }

    // Prefix group filter
    if (this.mappingUnknownPrefixFilter) {
      const mfrsWithPrefix = this.producers.filter(p => p.prefix?.trim());
      linkedArticles = linkedArticles.filter(art =>
        !mfrsWithPrefix.some(p => art.toLowerCase().startsWith(p.prefix.trim().toLowerCase()))
      );
    } else if (this.mappingPrefixFilter) {
      const pfx = this.mappingPrefixFilter.toLowerCase();
      linkedArticles = linkedArticles.filter(art => art.toLowerCase().startsWith(pfx));
    }

    // Unique producers in linked mappings
    const linkedProducerIds = new Set<string>();
    for (const m of this.mappings) {
      const pp = this.products.find(p => p.id === m.producer_product_id);
      if (pp) linkedProducerIds.add(pp.producer_id);
    }
    const linkedProducers = [...linkedProducerIds].map(id => this.producers.find(p => p.id === id)).filter(Boolean) as typeof this.producers;

    const visibleArticles = linkedArticles.slice(0, this.mappingLinkedVisibleCount);
    const hasMore = linkedArticles.length > this.mappingLinkedVisibleCount;

    return `
      <!-- Linked filters + bulk actions -->
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${linkedProducers.length > 1 ? `
          <div style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:7px;border:1px solid var(--line);background:var(--bg-2)">
            <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-right:2px">Производитель:</span>
            <button onclick="window.producersModule.setMappingProducerFilter('')"
              style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid ${!this.mappingProducerFilter?'var(--text-2)40':'transparent'};background:${!this.mappingProducerFilter?'var(--bg-1)':'transparent'};color:${!this.mappingProducerFilter?'var(--text-1)':'var(--text-2)'}">Все</button>
            ${linkedProducers.map(pr => {
              const active = this.mappingProducerFilter === pr.id;
              return `<button onclick="window.producersModule.setMappingProducerFilter('${pr.id}')"
                style="padding:3px 9px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid ${active?'rgba(59,130,246,.4)':'transparent'};background:${active?'rgba(59,130,246,.15)':'transparent'};color:${active?'#93c5fd':'var(--text-2)'}">${esc(pr.name)}</button>`;
            }).join('')}
          </div>
        ` : ''}
        <div style="flex:1"></div>
        <button onclick="window.producersModule.openMappingsImport()"
          style="padding:4px 10px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-2);cursor:pointer">📥 Импорт</button>
        ${linkedArticles.length > 0 ? `
          <button onclick="window.producersModule.openMappingsExport()"
            style="padding:4px 10px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-2);cursor:pointer">📤 Экспорт</button>
          <button onclick="window.producersModule.openTemplateExport()"
            style="padding:4px 10px;font-size:11px;border:1px solid rgba(99,102,241,.4);border-radius:5px;background:rgba(99,102,241,.1);color:#a5b4fc;cursor:pointer">📋 В шаблон</button>
          <button onclick="window.producersModule.selectAllLinked()"
            style="padding:4px 10px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-2);cursor:pointer">
            ${this.linkedSelected.size === linkedArticles.length && linkedArticles.length > 0 ? '☐ Снять все' : '☑ Выделить все'}
          </button>
        ` : ''}
        ${this.linkedSelected.size > 0 ? `
          <div style="display:flex;gap:4px;align-items:center;padding:4px 10px;border-radius:6px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2)">
            <span style="font-size:11px;color:#93c5fd;font-weight:500;margin-right:4px">Выбрано: ${this.linkedSelected.size}</span>
            <button onclick="window.producersModule.bulkDeleteLinkedMappings()"
              style="padding:3px 9px;font-size:11px;border-radius:4px;cursor:pointer;background:#450a0a;color:#f87171;border:1px solid #7f1d1d">✕ Удалить связки</button>
            <button onclick="window.producersModule.bulkDeleteLinkedFromCatalog()"
              style="padding:3px 9px;font-size:11px;border-radius:4px;cursor:pointer;background:var(--bg-2);color:var(--text-2);border:1px solid var(--line)">🗑 Из каталога</button>
          </div>
        ` : ''}
      </div>

      <!-- Cards -->
      <div id="pm-linked-list"
        style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg-1)">
        ${linkedArticles.length === 0
          ? `<div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">${this.mappings.length === 0 ? 'Связок нет' : 'Нет по фильтру'}</div>`
          : visibleArticles.map(article => {
            const maps = this.mappings.filter(m => m.marketplace_article === article);
            const checked = this.linkedSelected.has(article);
            const isEditing = this.mappingEditingArticle === article;
            const safeArt = esc(article).replace(/'/g, "\\'");

            return `
              <div style="display:flex;gap:12px;padding:11px 14px;border-bottom:1px solid var(--line);background:${checked?'rgba(59,130,246,.06)':isEditing?'rgba(212,240,0,.03)':'transparent'}">
                <!-- Checkbox -->
                <div style="display:flex;align-items:flex-start;padding-top:2px;flex-shrink:0">
                  <input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleLinkedSel('${safeArt}')"
                    style="cursor:pointer;accent-color:#3b82f6">
                </div>

                <!-- Article -->
                <div style="width:35%;min-width:0;flex-shrink:0">
                  <code style="font-size:12px;color:${isEditing?'var(--accent)':'var(--text-1)'};font-family:monospace;display:inline-flex;align-items:center;gap:4px">${esc(article)}${copyButton(article, 'Копировать артикул')}</code>
                </div>

                <!-- Components -->
                <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
                  ${maps.map(m => {
                    const p = this.products.find(x => x.id === m.producer_product_id);
                    const pr = this.producers.find(x => x.id === p?.producer_id);
                    return `
                      <div style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:5px;background:rgba(74,222,128,.05)">
                        <span style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.3px;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">${esc(pr?.name??'')}</span>
                        <code style="font-size:10px;color:var(--text-2);font-family:monospace;flex-shrink:0">${esc(p?.articles?.[0]??'')}</code>
                        <span style="flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p?.name??'—')}</span>
                        ${p?.name ? copyButton(p.name, 'Копировать название') : ''}
                        <label style="display:flex;align-items:center;gap:3px;flex-shrink:0">
                          <span style="font-size:10px;color:var(--text-2)">×</span>
                          <input type="number" min="1" step="1" value="${m.quantity}"
                            onchange="window.producersModule.updateMappingQty('${m.id}',+this.value||1)"
                            style="width:48px;padding:2px 5px;border:1px solid var(--line);border-radius:4px;background:var(--bg-2);color:var(--text-1);font-size:11px;text-align:center">
                        </label>
                        ${isEditing ? `
                          <button onclick="window.producersModule.deleteMapping('${m.id}')"
                            style="flex-shrink:0;width:18px;height:18px;border:none;background:none;color:var(--text-2);cursor:pointer;font-size:12px;border-radius:3px;padding:0;display:flex;align-items:center;justify-content:center"
                            onmouseenter="this.style.color='#f87171';this.style.background='rgba(239,68,68,.15)'"
                            onmouseleave="this.style.color='var(--text-2)';this.style.background='none'"
                            title="Удалить компонент">✕</button>
                        ` : ''}
                      </div>
                    `;
                  }).join('')}

                  <!-- Add component form (edit mode) -->
                  ${isEditing ? `
                    <div style="display:flex;gap:5px;align-items:center;margin-top:4px;flex-wrap:wrap">
                      <div style="position:relative;flex:1;min-width:180px">
                        <input placeholder="Найти товар (артикул или название)…" autocomplete="off"
                          value="${esc(this.mappingEditAddProductLabel)}"
                          oninput="window.producersModule._editAddSearchInput(this)"
                          onblur="window.producersModule._editAddSearchBlur(this)"
                          style="width:100%;box-sizing:border-box;padding:4px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:11px">
                        <div style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:2px;z-index:200;border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:180px;background:var(--bg-1);box-shadow:0 4px 16px rgba(0,0,0,.4)"></div>
                      </div>
                      <input type="number" min="1" step="1" value="${this.mappingEditAddQty}" placeholder="Кол-во"
                        oninput="window.producersModule.mappingEditAddQty=+this.value||1"
                        style="width:64px;padding:4px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:11px">
                      <button onclick="window.producersModule._inlineAddMapping('${safeArt}')"
                        style="padding:4px 12px;background:var(--accent);color:#0a0a0a;border:none;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap">+ Добавить</button>
                    </div>
                  ` : ''}
                </div>

                <!-- Edit + delete buttons -->
                <div style="display:flex;flex-direction:column;gap:3px;align-items:center;flex-shrink:0">
                  <button onclick="window.producersModule.setMappingEditingArticle('${safeArt}')"
                    style="width:26px;height:26px;border:none;border-radius:5px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;
                      background:${isEditing?'rgba(59,130,246,.15)':'transparent'};color:${isEditing?'#93c5fd':'var(--text-2)'}"
                    onmouseenter="if(!${isEditing}){this.style.color='var(--text-1)'}" onmouseleave="if(!${isEditing}){this.style.color='var(--text-2)'}"
                    title="${isEditing?'Закрыть':'Редактировать'}">✎</button>
                </div>
              </div>
            `;
          }).join('')}
        ${hasMore ? `
          <div style="padding:12px;text-align:center">
            <button onclick="window.producersModule.showMoreLinked()"
              style="padding:6px 20px;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-2);cursor:pointer">
              Показать ещё (${linkedArticles.length - this.mappingLinkedVisibleCount} осталось)
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  showMoreLinked(): void {
    this.mappingLinkedVisibleCount += 50;
    const el = document.getElementById('pm-linked-list');
    const savedScroll = el ? el.scrollTop : 0;
    this.render();
    requestAnimationFrame(() => {
      const c = document.getElementById('pm-linked-list');
      if (c) c.scrollTop = savedScroll;
    });
  }

  setMappingSearch(v: string): void { this.mappingSearch = v; this.mappingVisibleCount = 50; this.render(); }

  /** Ручной подбор товара для артикула МП — не создаёт связку сразу, а добавляет товар
   *  в список предложений (как при авто-связке), чтобы можно было выбрать несколько
   *  вариантов и подтвердить их разом кнопкой «Создать». Так же, как в chairprod. */
  pickManualInline(productId: string, article: string): void {
    const listEl = document.getElementById('pm-pending-list');
    const savedScroll = listEl ? listEl.scrollTop : 0;
    const existing = this.mpSuggestions.get(article) ?? [];
    const key = `${article}__${productId}`;
    if (!existing.some(s => s.productId === productId)) {
      this.mpSuggestions.set(article, [...existing, { productId, confidence: 'manual', score: 1 }]);
    }
    this.mappingSelectedKeys.add(key);
    this.toast('Добавлено в предложения — нажмите «Создать», чтобы сохранить связку', 'info');
    this.render();
    requestAnimationFrame(() => {
      const c = document.getElementById('pm-pending-list');
      if (c) c.scrollTop = savedScroll;
    });
  }

  async updateMappingQty(mappingId: string, qty: number): Promise<void> {
    const rounded = Math.max(1, Math.round(qty || 1));
    const m = this.mappings.find(x => x.id === mappingId);
    if (!m) return;
    m.quantity = rounded;
    await producerMappingDb.update(mappingId, { quantity: rounded });
  }

  setMappingEditingArticle(article: string): void {
    this.mappingEditingArticle = this.mappingEditingArticle === article ? null : article;
    this.mappingEditAddProductId = '';
    this.mappingEditAddProductLabel = '';
    this.mappingEditAddQty = 1;
    this.render();
  }

  _editAddSearchInput(input: HTMLInputElement): void {
    const drop = input.nextElementSibling as HTMLElement;
    if (!drop) return;
    const q = input.value.toLowerCase().trim();
    if (!q) { drop.style.display = 'none'; drop.innerHTML = ''; return; }
    const matched = this.products
      .filter(p => p.name.toLowerCase().includes(q) || p.articles.some(a => a.toLowerCase().includes(q)))
      .slice(0, 30);
    drop.innerHTML = matched.length === 0
      ? `<div style="padding:12px;text-align:center;font-size:11px;color:var(--text-2)">Ничего не найдено</div>`
      : matched.map(p => {
          const pr = this.producers.find(x => x.id === p.producer_id);
          return `
            <div onmousedown="window.producersModule.pickEditAddProduct(${esc(JSON.stringify(p.id))})"
              style="padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:8px;align-items:center"
              onmouseenter="this.style.background='var(--bg-2)'" onmouseleave="this.style.background='transparent'">
              <code style="font-size:10px;color:var(--text-2);min-width:56px;flex-shrink:0">${esc(p.articles[0]??'')}</code>
              <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
              <span style="font-size:10px;color:var(--text-2);flex-shrink:0">${esc(pr?.name??'')}</span>
            </div>
          `;
        }).join('');
    drop.style.display = 'block';
  }

  _editAddSearchBlur(input: HTMLInputElement): void {
    const drop = input.nextElementSibling as HTMLElement;
    setTimeout(() => { if (drop) drop.style.display = 'none'; }, 160);
  }

  pickEditAddProduct(productId: string): void {
    const p = this.products.find(x => x.id === productId);
    if (!p) return;
    this.mappingEditAddProductId = productId;
    this.mappingEditAddProductLabel = `${p.articles[0] ?? ''} — ${p.name}`;
    this.render();
  }

  async _inlineAddMapping(article: string): Promise<void> {
    const productId = this.mappingEditAddProductId;
    const qty = this.mappingEditAddQty || 1;
    if (!productId) { this.toast('Выберите товар', 'error'); return; }
    try {
      // Если этот товар производителя уже привязан к артикулу (например нужно 2 одинаковые полки в комплекте) —
      // не создаём вторую строку (упрётся в уникальный индекс), а увеличиваем количество в существующей.
      const existing = this.mappings.find(m => m.marketplace_article === article && m.producer_product_id === productId);
      if (existing) {
        await producerMappingDb.update(existing.id, { quantity: existing.quantity + qty });
        this.toast(`Товар уже был в связке — количество увеличено до ${existing.quantity + qty}`, 'success');
      } else {
        await producerMappingDb.create({ marketplace_article: article, producer_product_id: productId, quantity: qty });
        this.toast('Добавлено', 'success');
      }
      await this.loadMappings();
      this.mappingEditAddProductId = '';
      this.mappingEditAddProductLabel = '';
      this.mappingEditAddQty = 1;
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  openMappingForm(): void {
    if (this.products.length === 0) { this.toast('Сначала добавьте товары производителя', 'info'); return; }
    const productOptions = this.products.map(p => {
      const pr = this.producers.find(x => x.id === p.producer_id);
      return `<option value="${p.id}">[${esc(pr?.name??'')}] ${esc(p.articles[0]??'')} — ${esc(p.name)}</option>`;
    }).join('');
    const componentRow = (idx: number) => `
      <div data-comp-row style="display:grid;grid-template-columns:1fr 90px 30px;gap:6px;align-items:center">
        <select name="comp_product" style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
          ${productOptions}
        </select>
        <input name="comp_qty" type="number" min="1" step="1" value="1" title="Количество в 1 шт заказа"
          style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
        ${idx > 0 ? `<button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px">×</button>` : '<span></span>'}
      </div>
    `;
    const html = `
      <form id="mapping-form" style="display:flex;flex-direction:column;gap:12px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Артикул маркетплейса *
          <input name="mp_article" placeholder="Например WB-12345"
            style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-size:11px;color:var(--text-2);font-weight:500">Компоненты у производителя (можно несколько)</span>
            <button type="button" onclick="window.producersModule.addMappingComponent()" style="font-size:11px;padding:3px 9px;background:transparent;color:#3b82f6;border:1px dashed var(--line);border-radius:5px;cursor:pointer">+ Компонент</button>
          </div>
          <div id="mapping-components" style="display:flex;flex-direction:column;gap:6px">
            ${componentRow(0)}
          </div>
          <div style="font-size:10px;color:var(--text-2);margin-top:6px">
            💡 Один артикул маркетплейса может собираться из нескольких компонентов производителя — каждый со своим количеством.
          </div>
        </div>
      </form>
    `;
    this.showModal('Новая связка', html, async () => {
      const root = document.getElementById('mapping-form')!;
      const article = (root.querySelector('[name="mp_article"]') as HTMLInputElement).value.trim();
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-comp-row]'));
      const componentsRaw = rows.map(row => ({
        product_id: (row.querySelector('[name="comp_product"]') as HTMLSelectElement).value,
        qty: Number((row.querySelector('[name="comp_qty"]') as HTMLInputElement).value) || 1,
      })).filter(c => c.product_id);
      // Объединяем повторяющиеся строки одного и того же товара (например 2 одинаковые полки в комплекте)
      // в одну с суммой количества — иначе вторая вставка упрётся в уникальный индекс БД.
      const qtyByProduct = new Map<string, number>();
      for (const c of componentsRaw) qtyByProduct.set(c.product_id, (qtyByProduct.get(c.product_id) ?? 0) + c.qty);
      const components = [...qtyByProduct.entries()].map(([product_id, qty]) => ({ product_id, qty }));
      if (!article) { this.toast('Укажите артикул', 'error'); return false; }
      if (components.length === 0) { this.toast('Добавьте хотя бы один компонент', 'error'); return false; }
      try {
        let ok = 0;
        for (const c of components) {
          try {
            await producerMappingDb.create({ marketplace_article: article, producer_product_id: c.product_id, quantity: c.qty });
            ok++;
          } catch {}
        }
        await this.loadMappings();
        this.toast(`Создано связок: ${ok}`, 'success');
        this.render();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  addMappingComponent(): void {
    const container = document.getElementById('mapping-components');
    if (!container) return;
    const idx = container.children.length;
    const productOptions = this.products.map(p => {
      const pr = this.producers.find(x => x.id === p.producer_id);
      return `<option value="${p.id}">[${esc(pr?.name??'')}] ${esc(p.articles[0]??'')} — ${esc(p.name)}</option>`;
    }).join('');
    const div = document.createElement('div');
    div.setAttribute('data-comp-row', '');
    div.style.cssText = 'display:grid;grid-template-columns:1fr 90px 30px;gap:6px;align-items:center';
    div.innerHTML = `
      <select name="comp_product" style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">${productOptions}</select>
      <input name="comp_qty" type="number" min="1" step="1" value="1"
        style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
      <button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px">×</button>
    `;
    container.appendChild(div);
    void idx;
  }

  async deleteMapping(id: string): Promise<void> {
    try {
      await producerMappingDb.remove(id);
      await this.loadMappings();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 4: CONSIGNMENT — заказы → заявки производителям
  // ════════════════════════════════════════════════════════════════════════

  private renderConsignmentTab(): string {
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const getIs = (o: ProducerOrder): InternalStage => (parseOrderMeta(o.notes).is ?? '') as InternalStage;
    const activeOrders = this.orders.filter(o => o.status !== 'cancelled' && o.status !== 'done');

    const cntNew        = activeOrders.filter(o => !getIs(o)).length;
    const cntProcessing = activeOrders.filter(o => getIs(o) === 'processing').length;
    const cntDelivery   = activeOrders.filter(o => getIs(o) === 'delivery').length;
    const cntProblem    = activeOrders.filter(o => getIs(o) === 'problem').length;

    // Красный пульт для «В обработке» — есть хотя бы один без связки
    const processingNoMap = activeOrders.filter(o => getIs(o) === 'processing' && !mappedSet.has(o.marketplace_article)).length;

    const filtered = this.filteredOrders();

    // Уникальные комбинации маркетплейс+магазин для фильтра
    const storeOptions = Array.from(
      new Map(
        activeOrders
          .filter(o => o.source && o.source !== 'manual')
          .map(o => {
            const meta = parseOrderMeta(o.notes);
            const key = `${o.source}|${meta.si ?? ''}`;
            return [key, { mp: o.source!, storeId: meta.si ?? '', storeName: meta.sn ?? (MP_LABEL[o.source!] ?? o.source!), mpLabel: MP_LABEL[o.source!] ?? o.source! }];
          }),
      ).values(),
    );

    const STAGE_STYLE: Record<InternalStage, { bg: string; color: string; label: string }> = {
      '':           { bg: 'transparent', color: 'var(--text-2)', label: 'Новые' },
      processing:   { bg: 'rgba(59,130,246,.15)', color: '#93c5fd', label: 'В обработке' },
      delivery:     { bg: 'rgba(74,222,128,.15)', color: '#4ade80', label: 'В доставке' },
      problem:      { bg: 'rgba(239,68,68,.15)', color: '#f87171', label: 'Проблемы' },
    };

    const statCard = (label: string, count: number, tab: InternalStage, alertCount = 0) => {
      const isActive = this.consignmentStatusTab === tab;
      const hasAlert = alertCount > 0;
      return `<button onclick="window.producersModule.setConsignmentStatusTab('${tab}')"
        style="flex:1;min-width:110px;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;transition:all .15s;
          border:1px solid ${isActive ? 'rgba(99,102,241,.5)' : hasAlert ? 'rgba(239,68,68,.4)' : 'var(--line)'};
          background:${isActive ? 'rgba(99,102,241,.1)' : hasAlert ? 'rgba(239,68,68,.07)' : 'var(--bg-2)'}">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:20px;font-weight:700;color:${hasAlert ? '#f87171' : 'var(--text-1)'}">${count.toLocaleString('ru')}</span>
          ${hasAlert ? `<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(239,68,68,.2);color:#f87171">⚠ ${alertCount} без связки</span>` : ''}
        </div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px">${label}</div>
      </button>`;
    };

    return `
      <div style="display:flex;gap:14px;flex:1;overflow:hidden">
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;min-width:0">

          <!-- Карточки внутренних статусов -->
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${statCard('Новые', cntNew, '')}
            ${statCard('В обработке', cntProcessing, 'processing', processingNoMap)}
            ${statCard('В доставке', cntDelivery, 'delivery')}
            ${statCard('Проблемы', cntProblem, 'problem')}
          </div>

          <!-- Прогресс загрузки из МП -->
          ${this._importProgress ? `<div id="consignment-import-progress">${this._renderImportProgress()}</div>` : ''}

          <!-- Плашка выбранных заказов (всегда в DOM, скрыта если 0) -->
          <div id="order-selection-bar" style="display:${this.orderSelected.size > 0 ? 'flex' : 'none'};align-items:center;gap:8px;padding:8px 12px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:8px">
            <span class="sel-count" style="font-size:12px;font-weight:500">Выбрано: ${this.orderSelected.size}</span>
            <div style="flex:1"></div>
            <button onclick="window.producersModule.openAddToStageModal()" class="btn"
              style="padding:5px 14px;font-size:11px;background:rgba(99,102,241,.8);color:#fff;border-color:transparent">Добавить</button>
            <button onclick="window.producersModule.generateConsignment()" class="btn"
              style="padding:5px 11px;font-size:11px">${IC.download} Сформировать заявки</button>
            <button onclick="window.producersModule.clearOrderSelection()" class="btn"
              style="padding:5px 8px;font-size:11px">✕</button>
          </div>

          <!-- Панель фильтров -->
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="position:relative;flex:1;min-width:200px">
              <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text-2);font-size:12px">🔍</span>
              <input
                value="${esc(this.consignmentSearch)}"
                oninput="window.producersModule.setConsignmentSearch(this.value)"
                placeholder="Номер заказа, артикул, товар…"
                style="width:100%;height:34px;padding:0 10px 0 28px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px;box-sizing:border-box">
            </div>
            <span style="font-size:11px;color:var(--text-2)">${filtered.length} заказов</span>
            <div style="flex:1"></div>
            <button class="btn" onclick="window.producersModule.importOrdersFromMp()" style="padding:6px 11px;font-size:11px">🔄 Из МП</button>
            <button class="btn" onclick="window.producersModule.openOrderForm()" style="padding:6px 11px;font-size:11px">${IC.plus} Новый</button>
            <button class="btn" onclick="window.producersModule.openOrderImport()" style="padding:6px 11px;font-size:11px">↑ Импорт xlsx</button>
          </div>

          <!-- Фильтр по магазинам -->
          ${storeOptions.length > 1 ? `
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
            <button onclick="window.producersModule.setConsignmentSourceFilter('');window.producersModule.setConsignmentStoreFilter('')"
              style="padding:3px 10px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid ${!this.consignmentSourceFilter && !this.consignmentStoreFilter ? 'rgba(99,102,241,.5)' : 'var(--line)'};background:${!this.consignmentSourceFilter && !this.consignmentStoreFilter ? 'rgba(99,102,241,.1)' : 'transparent'};color:${!this.consignmentSourceFilter && !this.consignmentStoreFilter ? '#a5b4fc' : 'var(--text-2)'}">Все</button>
            ${storeOptions.map(opt => {
              const isMpOnly = this.consignmentSourceFilter === opt.mp && !this.consignmentStoreFilter;
              const isStore  = this.consignmentStoreFilter === opt.storeId;
              const active = isStore || (isMpOnly && !opt.storeId);
              const mpCol = MP_COLOR[opt.mp] ?? '#6b7280';
              const wbNote = opt.mp === 'wb' ? ' ⚡' : '';
              return `<button onclick="window.producersModule.setConsignmentStoreFilter('${opt.storeId}')"
                style="padding:3px 10px;border-radius:6px;font-size:11px;cursor:pointer;
                  border:1px solid ${active ? 'rgba(99,102,241,.4)' : 'var(--line)'};
                  background:${active ? 'rgba(99,102,241,.1)' : 'transparent'};
                  color:${active ? '#a5b4fc' : 'var(--text-2)'}">
                <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${mpCol};margin-right:4px;vertical-align:middle"></span>${esc(opt.storeName)}${wbNote}
              </button>`;
            }).join('')}
          </div>` : ''}

          <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
            ${filtered.length === 0 ? `
              <div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px">
                ${this.orders.length === 0 ? 'Заказов нет. Добавьте вручную или импортируйте xlsx.' : 'Ничего не найдено'}
                ${(this.consignmentSearch || this.consignmentSourceFilter) ? `
                  <button onclick="window.producersModule.setConsignmentSearch('');window.producersModule.setConsignmentSourceFilter('')"
                    style="font-size:11px;color:#60a5fa;background:none;border:none;cursor:pointer">Сбросить фильтры</button>` : ''}
              </div>
            ` : `
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <thead style="background:var(--bg-2);position:sticky;top:0">
                  <tr>
                    <th style="width:30px;padding:8px 10px;border-bottom:1px solid var(--line)">
                      <input type="checkbox" onchange="window.producersModule.toggleAllOrders(this.checked)">
                    </th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Источник</th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Артикул МП</th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Компоненты производителя</th>
                    <th style="text-align:center;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Кол-во</th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Статус МП</th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Этап</th>
                  </tr>
                </thead>
                <tbody id="orders-tbody">
                  ${filtered.slice(0, this.consignmentVisibleCount).map(o => {
                    const maps = this.mappings.filter(m => m.marketplace_article === o.marketplace_article);
                    const checked = this.orderSelected.has(o.id);
                    const meta = parseOrderMeta(o.notes);
                    const internalStage = (meta.is ?? '') as InternalStage;
                    const stageSt = STAGE_STYLE[internalStage] ?? STAGE_STYLE[''];
                    const mpCol   = MP_COLOR[o.source ?? ''] ?? '#6b7280';
                    const mpLbl   = MP_LABEL[o.source ?? ''] ?? (o.source ?? '—');
                    const stLbl   = meta.sn ?? '';
                    const orderNum = meta.on ?? '';
                    const scheme  = meta.sc ?? '';
                    const schemeStyle = SCHEME_STYLE[scheme];
                    const mpStatus  = meta.ms ?? '';
                    const mpStLbl   = MP_STATUS_LABEL[mpStatus] ?? mpStatus ?? '—';
                    const mpStStyle = MP_STATUS_CSS[mpStatus] ?? { bg: '#27272a', color: '#6b7280' };
                    const isWbUrgent = o.source === 'wb' && mpStatus === 'new';
                    return `
                      <tr data-order-id="${esc(o.id)}" ${isWbUrgent ? 'data-wb-urgent="1"' : ''} style="border-bottom:1px solid var(--line);background:${checked?'rgba(59,130,246,.08)':isWbUrgent?'rgba(251,191,36,.04)':'transparent'}">
                        <td style="padding:7px 10px"><input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleOrder('${o.id}')"></td>
                        <td style="padding:6px 10px;white-space:nowrap">
                          <div style="display:flex;flex-direction:column;gap:3px">
                            <div style="display:flex;align-items:center;gap:5px">
                              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${mpCol};flex-shrink:0"></span>
                              <span style="font-size:11px;font-weight:500;color:var(--text-1)">${esc(mpLbl)}</span>
                              ${scheme && schemeStyle ? `<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:${schemeStyle.bg};color:${schemeStyle.color}">${esc(scheme)}</span>` : ''}
                            </div>
                            ${stLbl ? `<span style="font-size:10px;color:var(--text-2);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(stLbl)}</span>` : ''}
                            ${orderNum ? `<span style="font-size:10px;color:var(--text-2);font-family:monospace">${esc(orderNum)}</span>` : ''}
                            ${isWbUrgent ? `<span style="font-size:9px;color:#fbbf24">⚡ подтв. до 48ч</span>` : ''}
                          </div>
                        </td>
                        <td style="padding:7px 10px;font-family:monospace">
                          <span style="display:inline-flex;align-items:center;gap:4px">${esc(o.marketplace_article)}${copyButton(o.marketplace_article, 'Копировать артикул')}</span>
                          <div style="font-size:10px;color:var(--text-2);font-family:inherit;display:flex;align-items:center;gap:4px">${esc(o.product_name)}${o.product_name ? copyButton(o.product_name, 'Копировать название') : ''}</div>
                        </td>
                        <td style="padding:7px 10px">
                          ${maps.length > 0 ? maps.map(map => {
                            const pp = this.products.find(p => p.id === map.producer_product_id);
                            const pr = pp ? this.producers.find(x => x.id === pp.producer_id) : null;
                            if (!pp) return '';
                            return `<div style="display:flex;gap:6px;align-items:center;padding:2px 0">
                              <code style="font-size:10px;color:var(--text-2)">${esc(pp.articles[0]??'')}</code>
                              <span style="font-size:11px">${esc(pp.name)}</span>${copyButton(pp.name, 'Копировать название')}
                              ${map.quantity !== 1 ? `<span style="font-size:10px;color:#fb923c">×${map.quantity}</span>` : ''}
                              ${pr ? `<span style="font-size:10px;color:var(--text-2);margin-left:auto">${esc(pr.name)}</span>` : ''}
                            </div>`;
                          }).join('') : `<span style="color:#fb923c">⚠ нет связки</span>`}
                        </td>
                        <td style="padding:7px 10px;text-align:center;font-weight:500">${o.quantity}</td>
                        <td style="padding:7px 10px;white-space:nowrap">
                          <span style="font-size:10px;padding:2px 7px;border-radius:8px;background:${mpStStyle.bg};color:${mpStStyle.color}">
                            ${esc(mpStLbl)}
                          </span>
                        </td>
                        <td style="padding:6px 10px;white-space:nowrap">
                          <select onchange="window.producersModule.moveOrderInternal('${o.id}',this.value)"
                            style="font-size:10px;padding:3px 6px;border-radius:6px;border:1px solid var(--line);background:${stageSt.bg};color:${stageSt.color};cursor:pointer">
                            <option value="" ${internalStage===''?'selected':''}>Новые</option>
                            <option value="processing" ${internalStage==='processing'?'selected':''}>В обработке</option>
                            <option value="delivery" ${internalStage==='delivery'?'selected':''}>В доставке</option>
                            <option value="problem" ${internalStage==='problem'?'selected':''}>Проблемы</option>
                          </select>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
              ${filtered.length > this.consignmentVisibleCount ? `
                <div style="padding:10px;text-align:center">
                  <button class="btn" onclick="window.producersModule.showMoreOrders()"
                    style="padding:6px 18px;font-size:11px">
                    Показать ещё (${filtered.length - this.consignmentVisibleCount} осталось)
                  </button>
                </div>` : ''}
            `}
          </div>
        </div>

        <div style="width:310px;display:flex;flex-direction:column;gap:10px">
          <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-2);flex:1;overflow:auto">
            <div style="font-size:12px;font-weight:600;margin-bottom:10px">Заявки к формированию</div>
            ${this.renderConsignmentPreview()}
          </div>
          <button onclick="window.producersModule.generateConsignment()"
            style="background:var(--accent);color:#0a0a0a;border:none;padding:11px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500">
            ${IC.download} Сформировать заявки (${this.orderSelected.size})
          </button>
        </div>
      </div>
    `;
  }

  private renderConsignmentPreview(): string {
    if (this.orderSelected.size === 0) {
      return `<div style="font-size:11px;color:var(--text-2)">Выделите заказы слева, чтобы увидеть заявки</div>`;
    }
    // Группируем по производителю — агрегируем ВСЕ компоненты на один артикул МП
    const byProd = new Map<string, Map<string, DocItem>>();
    for (const o of this.orders) {
      if (!this.orderSelected.has(o.id)) continue;
      const maps = this.mappings.filter(m => m.marketplace_article === o.marketplace_article);
      for (const map of maps) {
        const pp = this.products.find(p => p.id === map.producer_product_id);
        if (!pp) continue;
        const pr = this.producers.find(x => x.id === pp.producer_id);
        if (!pr) continue;
        if (!byProd.has(pr.id)) byProd.set(pr.id, new Map());
        const items = byProd.get(pr.id)!;
        const qty = map.quantity * o.quantity;
        const key = pp.articles[0] || pp.id;
        const existing = items.get(key);
        if (existing) existing.quantity += qty;
        else items.set(key, { article: key, name: pp.name, quantity: qty });
      }
    }
    if (byProd.size === 0) return `<div style="font-size:11px;color:#fb923c">Выбранные заказы не имеют связок</div>`;
    return Array.from(byProd.entries()).map(([prId, items]) => {
      const pr = this.producers.find(x => x.id === prId);
      return `
        <div style="border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;margin-bottom:5px">${esc(pr?.name ?? '')}</div>
          ${Array.from(items.values()).map(it => `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:2px 0">
              <span style="display:inline-flex;align-items:center;gap:4px;font-family:monospace;color:var(--text-2)">${esc(it.article)}${copyButton(it.article, 'Копировать артикул')}</span>
              <span style="font-weight:500">×${it.quantity}</span>
            </div>
          `).join('')}
        </div>
      `;
    }).join('');
  }

  toggleOrder(id: string): void {
    if (this.orderSelected.has(id)) this.orderSelected.delete(id);
    else this.orderSelected.add(id);
    // DOM-патч: не делаем полный ре-рендер, только обновляем конкретную строку и плашку
    const row = document.querySelector<HTMLTableRowElement>(`tr[data-order-id="${CSS.escape(id)}"]`);
    if (row) {
      const checked = this.orderSelected.has(id);
      const cb = row.querySelector('input[type=checkbox]') as HTMLInputElement;
      if (cb) cb.checked = checked;
      const isWbUrgent = row.dataset.wbUrgent === '1';
      row.style.background = checked ? 'rgba(59,130,246,.08)' : isWbUrgent ? 'rgba(251,191,36,.04)' : 'transparent';
    }
    this._patchOrderSelectionBar();
  }

  toggleAllOrders(on: boolean): void {
    if (on) {
      this.orderSelected = new Set(this.filteredOrders().map(o => o.id));
    } else {
      this.orderSelected = new Set();
    }
    document.querySelectorAll<HTMLTableRowElement>('tr[data-order-id]').forEach(row => {
      const rid = row.dataset.orderId!;
      const checked = this.orderSelected.has(rid);
      const cb = row.querySelector('input[type=checkbox]') as HTMLInputElement;
      if (cb) cb.checked = checked;
      const isWbUrgent = row.dataset.wbUrgent === '1';
      row.style.background = checked ? 'rgba(59,130,246,.08)' : isWbUrgent ? 'rgba(251,191,36,.04)' : 'transparent';
    });
    this._patchOrderSelectionBar();
  }

  clearOrderSelection(): void {
    this.orderSelected = new Set();
    document.querySelectorAll<HTMLTableRowElement>('tr[data-order-id]').forEach(row => {
      const cb = row.querySelector('input[type=checkbox]') as HTMLInputElement;
      if (cb) cb.checked = false;
      const isWbUrgent = row.dataset.wbUrgent === '1';
      row.style.background = isWbUrgent ? 'rgba(251,191,36,.04)' : 'transparent';
    });
    this._patchOrderSelectionBar();
  }

  private _patchOrderSelectionBar(): void {
    const bar = document.getElementById('order-selection-bar');
    const n = this.orderSelected.size;
    if (!bar) return;
    bar.style.display = n > 0 ? 'flex' : 'none';
    const countEl = bar.querySelector('.sel-count');
    if (countEl) countEl.textContent = `Выбрано: ${n}`;
  }

  openOrderForm(): void {
    const html = `
      <form id="order-form" style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Артикул маркетплейса *
          <input name="article" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Название (опционально)
          <input name="pname" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Количество
          <input name="qty" type="number" min="1" value="1" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        </label>
      </form>
    `;
    this.showModal('Новый заказ', html, async () => {
      const root = document.getElementById('order-form')!;
      const article = (root.querySelector('[name="article"]') as HTMLInputElement).value.trim();
      const pname = (root.querySelector('[name="pname"]') as HTMLInputElement).value.trim();
      const qty = Number((root.querySelector('[name="qty"]') as HTMLInputElement).value) || 1;
      if (!article) { this.toast('Укажите артикул', 'error'); return false; }
      try {
        await producerOrderDb.create({
          external_id: null, marketplace_article: article, product_name: pname, quantity: qty,
          status: 'new', source: 'manual', notes: null,
        });
        await this.loadOrders();
        this.render();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  openOrderImport(): void {
    const html = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">
          Импорт заказов из xlsx. Файл должен содержать колонки: <b>Артикул</b>, <b>Количество</b>,
          опционально <b>Название</b>.
        </div>
        <input type="file" accept=".xlsx,.xls" id="orders-import-file"
          style="padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
      </div>
    `;
    this.showModal('Импорт заказов', html, async () => {
      const fileInput = document.getElementById('orders-import-file') as HTMLInputElement;
      const f = fileInput?.files?.[0];
      if (!f) { this.toast('Выберите файл', 'error'); return false; }
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        const orders = rows.map(r => {
          const article = String(r['Артикул'] ?? r['article'] ?? r['SKU'] ?? r['Artikul'] ?? '').trim();
          const qty = Number(r['Количество'] ?? r['qty'] ?? r['Кол-во'] ?? 1) || 1;
          const name = String(r['Название'] ?? r['name'] ?? '').trim();
          return article ? {
            external_id: null, marketplace_article: article, product_name: name,
            quantity: qty, status: 'new' as const, source: 'xlsx', notes: null,
          } : null;
        }).filter(Boolean) as any[];
        if (orders.length === 0) { this.toast('Не найдено заказов в файле', 'error'); return false; }
        await producerOrderDb.createBulk(orders);
        await this.loadOrders();
        this.render();
        this.toast(`Импортировано ${orders.length} заказов`, 'success');
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  async deleteOrder(id: string): Promise<void> {
    try {
      await producerOrderDb.remove(id);
      this.orderSelected.delete(id);
      await this.loadOrders();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  async generateConsignment(): Promise<void> {
    if (this.orderSelected.size === 0) { this.toast('Выделите заказы', 'info'); return; }
    // Группируем по производителю
    const byProd = new Map<string, { producer: Producer; items: Map<string, DocItem>; orderIds: string[] }>();
    for (const o of this.orders) {
      if (!this.orderSelected.has(o.id)) continue;
      const maps = this.mappings.filter(m => m.marketplace_article === o.marketplace_article);
      for (const map of maps) {
        const pp = this.products.find(p => p.id === map.producer_product_id);
        if (!pp) continue;
        const pr = this.producers.find(x => x.id === pp.producer_id);
        if (!pr) continue;
        if (!byProd.has(pr.id)) byProd.set(pr.id, { producer: pr, items: new Map(), orderIds: [] });
        const grp = byProd.get(pr.id)!;
        if (!grp.orderIds.includes(o.id)) grp.orderIds.push(o.id);
        const qty = map.quantity * o.quantity;
        const key = pp.articles[0] || pp.id;
        const existing = grp.items.get(key);
        if (existing) existing.quantity += qty;
        else grp.items.set(key, { article: key, name: pp.name, quantity: qty });
      }
    }
    if (byProd.size === 0) { this.toast('Нет связок для выбранных заказов', 'error'); return; }
    let generated = 0;
    const dateStr = new Date().toISOString().slice(0, 10);
    for (const [, grp] of byProd) {
      const items = Array.from(grp.items.values());
      const total = items.reduce((s, it) => s + it.quantity, 0);
      try {
        let blob: Blob;
        if (grp.producer.output_type === 'template' && grp.producer.template_url && grp.producer.template_config) {
          blob = await fillTemplate(grp.producer.template_url, grp.producer.template_config, items);
        } else {
          blob = generateNewFile(items, grp.producer.output_config, grp.producer.name);
        }
        const fileName = `${grp.producer.name}_${dateStr}.xlsx`;
        downloadBlob(blob, fileName);
        await producerDocDb.create({
          producer_id: grp.producer.id, doc_type: 'consignment',
          file_url: null, file_name: fileName,
          items, order_ids: grp.orderIds, total_qty: total,
        });
        generated++;
      } catch (e: any) {
        this.toast(`Ошибка генерации для ${grp.producer.name}: ${e?.message}`, 'error');
      }
    }
    if (generated > 0) {
      // Автоматически переводим все затронутые заказы в «В доставке»
      const allOrderIds = new Set<string>();
      for (const [, grp] of byProd) grp.orderIds.forEach(id => allOrderIds.add(id));
      for (const id of allOrderIds) {
        const order = this.orders.find(o => o.id === id);
        if (!order) continue;
        const meta = parseOrderMeta(order.notes);
        meta.is = 'delivery';
        order.notes = encodeOrderMeta(meta);
        producerOrderDb.updateNotes(id, order.notes).catch(() => {});
      }
      this.toast(`Сформировано ${generated} файлов`, 'success');
      this.orderSelected = new Set();
      this.render();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 5: SUPPLY — ручной поиск + кол-во → документ поставки
  // ════════════════════════════════════════════════════════════════════════

  private renderSupplyTab(): string {
    const supplyProducers = this.producers.filter(p => p.workflow === 'supply' || p.workflow === 'both');
    if (!this.supplyProducerId && supplyProducers.length > 0) this.supplyProducerId = supplyProducers[0].id;

    if (supplyProducers.length === 0) {
      return `<div style="padding:40px;text-align:center;color:var(--text-2)">
        Нет поставщиков в режиме «Поставка». Создайте поставщика с режимом «Поставка» или «Оба режима» во вкладке «Поставщики».
      </div>`;
    }

    const prodList = this.products.filter(p => p.producer_id === this.supplyProducerId);
    const q = this.supplySearch.toLowerCase().trim();
    const filtered = q
      ? prodList.filter(p => p.name.toLowerCase().includes(q) || p.articles.some(a => a.toLowerCase().includes(q)))
      : prodList;

    const totalSelected = filtered.reduce((s, p) => s + (this.supplyQty[p.id] || 0), 0);

    return `
      <div style="display:flex;gap:14px;flex:1;overflow:hidden">
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select onchange="window.producersModule.setSupplyProducer(this.value)"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px">
              ${supplyProducers.map(p => `<option value="${p.id}" ${p.id===this.supplyProducerId?'selected':''}>${esc(p.name)}</option>`).join('')}
            </select>
            <input value="${esc(this.supplySearch)}" placeholder="Поиск по артикулу / названию"
              oninput="window.producersModule.setSupplySearch(this.value)"
              style="flex:1;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px">
          </div>

          <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
            ${filtered.length === 0 ? `
              <div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">
                ${prodList.length === 0 ? 'У этого поставщика нет товаров. Добавьте их во вкладке «Каталог».' : 'Ничего не найдено'}
              </div>
            ` : `
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <thead style="background:var(--bg-2);position:sticky;top:0">
                  <tr>
                    <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Артикул</th>
                    <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Наименование</th>
                    <th style="text-align:center;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);width:120px">Кол-во к поставке</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map(p => `
                    <tr style="border-bottom:1px solid var(--line);background:${this.supplyQty[p.id]?'rgba(34,197,94,.07)':'transparent'}">
                      <td style="padding:8px 10px;font-family:monospace"><span style="display:inline-flex;align-items:center;gap:4px">${esc(p.articles[0] ?? '')}${p.articles[0] ? copyButton(p.articles[0], 'Копировать артикул') : ''}</span></td>
                      <td style="padding:8px 10px"><span style="display:inline-flex;align-items:center;gap:4px">${esc(p.name)}${copyButton(p.name, 'Копировать название')}</span></td>
                      <td style="padding:6px 10px;text-align:center">
                        <input type="number" min="0" value="${this.supplyQty[p.id] || ''}" placeholder="0"
                          oninput="window.producersModule.setSupplyQty('${p.id}', this.value)"
                          style="width:80px;padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);text-align:center">
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>

        <div style="width:300px;display:flex;flex-direction:column;gap:10px">
          <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-2);flex:1;overflow:auto">
            <div style="font-size:12px;font-weight:600;margin-bottom:10px">К поставке</div>
            ${totalSelected === 0 ? `<div style="font-size:11px;color:var(--text-2)">Укажите количество в таблице</div>` : `
              <div style="font-size:11px;color:var(--text-2);margin-bottom:8px">Всего позиций: ${Object.values(this.supplyQty).filter(q=>q>0).length}, штук: ${totalSelected}</div>
              ${prodList.filter(p => this.supplyQty[p.id] > 0).map(p => `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--line)">
                  <span style="display:inline-flex;align-items:center;gap:4px;font-family:monospace;color:var(--text-2);max-width:60%;overflow:hidden;text-overflow:ellipsis">${esc(p.articles[0]??'')}${p.articles[0] ? copyButton(p.articles[0], 'Копировать артикул') : ''}</span>
                  <span style="font-weight:500">×${this.supplyQty[p.id]}</span>
                </div>
              `).join('')}
            `}
          </div>
          <button onclick="window.producersModule.generateSupply()"
            style="background:var(--accent);color:#0a0a0a;border:none;padding:11px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500"
            ${totalSelected===0?'disabled':''}>
            ${IC.download} Сформировать документ поставки
          </button>
        </div>
      </div>
    `;
  }

  setSupplyProducer(id: string): void { this.supplyProducerId = id; this.supplyQty = {}; this.render(); }
  setSupplySearch(v: string): void { this.supplySearch = v; this.render(); }
  setSupplyQty(id: string, v: string): void {
    const n = Number(v);
    if (!n || n <= 0) delete this.supplyQty[id];
    else this.supplyQty[id] = n;
    // не перерисовываем целиком — обновим только sidebar preview
    const sidebar = this.el.querySelector('[style*="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-2);flex:1"]');
    if (sidebar) this.render();
  }

  async generateSupply(): Promise<void> {
    const producer = this.producers.find(p => p.id === this.supplyProducerId);
    if (!producer) return;
    const items: DocItem[] = [];
    for (const p of this.products) {
      if (p.producer_id !== producer.id) continue;
      const qty = this.supplyQty[p.id];
      if (!qty || qty <= 0) continue;
      items.push({ article: p.articles[0] ?? '', name: p.name, quantity: qty });
    }
    if (items.length === 0) { this.toast('Не указаны количества', 'info'); return; }
    try {
      const blob = producer.output_type === 'template' && producer.template_url && producer.template_config
        ? await fillTemplate(producer.template_url, producer.template_config, items)
        : generateNewFile(items, producer.output_config, producer.name);
      const fileName = `Поставка_${producer.name}_${new Date().toISOString().slice(0,10)}.xlsx`;
      downloadBlob(blob, fileName);
      await producerDocDb.create({
        producer_id: producer.id, doc_type: 'supply',
        file_url: null, file_name: fileName,
        items, order_ids: [], total_qty: items.reduce((s,it)=>s+it.quantity,0),
      });
      this.toast('Документ поставки сформирован', 'success');
      this.supplyQty = {};
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TAB 6: HISTORY
  // ════════════════════════════════════════════════════════════════════════

  private historyLoaded = false;
  private history: any[] = [];

  async redownloadDocument(id: string): Promise<void> {
    const doc = this.history.find((d: any) => d.id === id);
    if (!doc) { this.toast('Документ не найден', 'error'); return; }
    const producer = this.producers.find(p => p.id === doc.producer_id);
    if (!producer) { this.toast('Поставщик не найден', 'error'); return; }
    try {
      let blob: Blob;
      if (producer.output_type === 'template' && producer.template_url && producer.template_config) {
        blob = await fillTemplate(producer.template_url, producer.template_config, doc.items);
      } else {
        blob = generateNewFile(doc.items, producer.output_config, producer.name);
      }
      downloadBlob(blob, doc.file_name ?? `${producer.name}.xlsx`);
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка при скачивании', 'error'); }
  }

  private renderHistoryTab(): string {
    if (!this.historyLoaded) {
      producerDocDb.list().then(d => { this.history = d; this.historyLoaded = true; this.render(); });
      return `<div style="padding:40px;text-align:center;color:var(--text-2)">Загрузка истории…</div>`;
    }
    if (this.history.length === 0) {
      return `<div style="padding:40px;text-align:center;color:var(--text-2)">История пуста</div>`;
    }
    return `
      <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead style="background:var(--bg-2);position:sticky;top:0">
            <tr>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Дата</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Тип</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Файл</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Позиций</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Всего шт.</th>
              <th style="width:40px;border-bottom:1px solid var(--line)"></th>
            </tr>
          </thead>
          <tbody>
            ${this.history.map((d: any) => `
              <tr style="border-bottom:1px solid var(--line)">
                <td style="padding:8px 10px;color:var(--text-2);font-size:11px">${new Date(d.created_at).toLocaleString('ru')}</td>
                <td style="padding:8px 10px"><span style="font-size:10px;background:${d.doc_type==='supply'?'#3b0a6a':'#1e3a5f'};color:#fff;padding:2px 7px;border-radius:10px">${d.doc_type === 'supply' ? 'Поставка' : 'Реализация'}</span></td>
                <td style="padding:8px 10px;font-family:monospace;font-size:11px"><span style="display:inline-flex;align-items:center;gap:4px">${esc(d.file_name ?? '')}${d.file_name ? copyButton(d.file_name, 'Копировать имя файла') : ''}</span></td>
                <td style="padding:8px 10px">${d.items?.length ?? 0}</td>
                <td style="padding:8px 10px">${d.total_qty ?? 0}</td>
                <td style="padding:6px 10px;text-align:right">
                  ${d.producer_id ? `<button class="btn" title="Скачать повторно"
                    onclick="window.producersModule.redownloadDocument('${d.id}')"
                    style="padding:3px 8px;font-size:11px">${IC.download}</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ════════════════════════════════════════════════════════════════════════
  // SHARED MODAL
  // ════════════════════════════════════════════════════════════════════════

  private showModal(
    title: string, body: string,
    onSave: (() => Promise<boolean>) | null,
    opts: { saveText?: string; cancelText?: string } = {},
  ): void {
    const saveText = opts.saveText ?? 'Сохранить';
    const cancelText = opts.cancelText ?? 'Отмена';
    const existing = document.getElementById('producers-modal');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'producers-modal';
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    root.onclick = (e) => { if (e.target === root) root.remove(); };
    root.innerHTML = `
      <div style="background:var(--bg-1);border:1px solid var(--line);border-radius:12px;max-width:680px;width:100%;max-height:90vh;overflow:auto;display:flex;flex-direction:column">
        <div style="padding:14px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0;font-size:14px;font-weight:600">${esc(title)}</h3>
          <button onclick="document.getElementById('producers-modal').remove()" style="background:none;border:none;color:var(--text-2);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <div style="padding:16px 18px;flex:1;overflow:auto">${body}</div>
        <div style="padding:12px 18px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px">
          ${cancelText ? `<button id="producers-modal-cancel" class="btn" style="padding:7px 14px;font-size:12px">${esc(cancelText)}</button>` : ''}
          <button id="producers-modal-save" class="btn" style="background:var(--accent);color:#0a0a0a;border:none;padding:7px 14px;border-radius:7px;font-size:12px">${esc(saveText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.getElementById('producers-modal-cancel')?.addEventListener('click', () => root.remove());
    let submitting = false;
    document.getElementById('producers-modal-save')!.addEventListener('click', async () => {
      if (!onSave) { root.remove(); return; }
      if (submitting) return; // защита от дублей при повторном/случайном клике во время сохранения
      submitting = true;
      const btn = document.getElementById('producers-modal-save') as HTMLButtonElement | null;
      if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.style.cursor = 'default'; }
      try {
        const ok = await onSave();
        if (ok) { root.remove(); return; }
      } finally {
        submitting = false;
        if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = 'pointer'; }
      }
    });
  }

  /** Оверлей с прогресс-баром и кнопкой «Стоп» для длительных последовательных операций (импорт/удаление/экспорт пачками). */
  private showProgressOverlay(title: string): { update: (done: number, total: number) => void; close: () => void; cancelled: () => boolean } {
    document.getElementById('producers-progress-overlay')?.remove();
    const root = document.createElement('div');
    root.id = 'producers-progress-overlay';
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
    root.innerHTML = `
      <div style="background:var(--bg-1);border:1px solid var(--line);border-radius:12px;max-width:380px;width:100%;padding:22px 24px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="display:inline-block;width:16px;height:16px;border:2px solid rgba(59,130,246,.25);border-top-color:#3b82f6;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0"></span>
          <h3 style="margin:0;font-size:13px;font-weight:600;flex:1">${esc(title)}</h3>
        </div>
        <div style="width:100%;height:7px;border-radius:4px;background:var(--bg-2);overflow:hidden">
          <div data-bar style="height:100%;width:0%;background:#3b82f6;transition:width .12s ease"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div data-text style="font-size:12px;color:var(--text-2)">Подготовка…</div>
          <button data-stop style="padding:4px 10px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);cursor:pointer;flex-shrink:0">⏹ Стоп</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const bar = root.querySelector('[data-bar]') as HTMLElement;
    const text = root.querySelector('[data-text]') as HTMLElement;
    const stopBtn = root.querySelector('[data-stop]') as HTMLButtonElement;
    let stopRequested = false;
    stopBtn.addEventListener('click', () => {
      stopRequested = true;
      stopBtn.disabled = true;
      stopBtn.textContent = 'Останавливается…';
      stopBtn.style.opacity = '0.6';
    });
    return {
      update(done: number, total: number) {
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        bar.style.width = `${pct}%`;
        text.textContent = `${done} из ${total} (${pct}%)`;
      },
      close() { root.remove(); },
      cancelled() { return stopRequested; },
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTS — bulk operations, filters, archive
  // ════════════════════════════════════════════════════════════════════════

  toggleProductSel(id: string): void {
    if (this.productSelected.has(id)) this.productSelected.delete(id);
    else this.productSelected.add(id);
    // Patch row in-place — no full re-render
    const row = this.el.querySelector<HTMLElement>(`tr[data-pid="${id}"]`);
    const cb = row?.querySelector<HTMLInputElement>('input[type=checkbox]');
    const checked = this.productSelected.has(id);
    if (row) row.style.background = checked ? 'rgba(59,130,246,.1)' : 'transparent';
    if (cb) cb.checked = checked;
    this._updateProductSelBar();
  }
  toggleAllProducts(on: boolean): void {
    const filtered = this.filteredProducts(); // ALL — not sliced
    if (on) for (const p of filtered) this.productSelected.add(p.id);
    else this.productSelected.clear();
    // Patch all visible rows in-place
    for (const tr of this.el.querySelectorAll<HTMLElement>('tr[data-pid]')) {
      const pid = tr.dataset.pid!;
      const checked = this.productSelected.has(pid);
      tr.style.background = checked ? 'rgba(59,130,246,.1)' : 'transparent';
      const cb = tr.querySelector<HTMLInputElement>('input[type=checkbox]');
      if (cb) cb.checked = checked;
    }
    this._updateProductSelBar();
  }
  clearProductSel(): void { this.productSelected = new Set(); this.render(); }

  /** Обновляет панель выбора без полного перерендера. */
  private _updateProductSelBar(): void {
    const existing = this.el.querySelector<HTMLElement>('[data-sel-bar]');
    if (this.productSelected.size > 0) {
      const html = this.renderProductSelBar();
      if (existing) existing.outerHTML = html;
      else {
        const root = this.el.querySelector<HTMLElement>('.producers-root');
        if (root) root.insertAdjacentHTML('beforeend', html);
      }
    } else {
      existing?.remove();
    }
  }

  toggleProductFilters(): void { this.productShowFilters = !this.productShowFilters; this.render(); }

  async toggleArchive(): Promise<void> {
    this.productArchived = !this.productArchived;
    this.productSelected = new Set();
    await this.loadProducts();
    this.render();
  }

  setFieldFilterRange(fid: string, key: 'min' | 'max', value: string): void {
    const cur = this.productFieldFilters[fid];
    const r = cur?.type === 'range' ? cur : { type: 'range' as const, min: '', max: '' };
    r[key] = value;
    if (!r.min && !r.max) delete this.productFieldFilters[fid];
    else this.productFieldFilters[fid] = r;
  }
  toggleFieldFilterOpt(fid: string, opt: string): void {
    const cur = this.productFieldFilters[fid];
    const sel = cur?.type === 'select' ? new Set(cur.selected) : new Set<string>();
    const k = opt.toLowerCase();
    if (sel.has(k)) sel.delete(k); else sel.add(k);
    if (sel.size === 0) delete this.productFieldFilters[fid];
    else this.productFieldFilters[fid] = { type: 'select', selected: sel };
    this.render();
  }
  clearFieldFilters(): void { this.productFieldFilters = {}; this.render(); }

  async bulkArchive(): Promise<void> {
    const ids = [...this.productSelected];
    if (ids.length === 0) return;
    try {
      await producerProductDb.bulkArchive(ids, !this.productArchived);
      this.toast(this.productArchived ? `Восстановлено ${ids.length}` : `В архив: ${ids.length}`, 'success');
      this.productSelected = new Set();
      await this.loadProducts();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  async bulkDeleteProducts(): Promise<void> {
    const ids = [...this.productSelected];
    if (ids.length === 0) return;
    if (!confirm(`Удалить ${ids.length} товар(ов)? Это действие необратимо.`)) return;
    try {
      await producerProductDb.bulkDelete(ids);
      this.toast(`Удалено: ${ids.length}`, 'success');
      this.productSelected = new Set();
      await this.loadProducts();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  openChangeProducerModal(): void {
    const ids = [...this.productSelected];
    if (ids.length === 0) return;
    const html = `
      <form id="chg-prod-form" style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">Переместить ${ids.length} товар(ов) к другому поставщику.</div>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
          Новый поставщик
          <select name="pid" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
            <option value="">— выберите —</option>
            ${this.producers.map(pr => `<option value="${pr.id}">${esc(pr.name)}</option>`).join('')}
          </select>
        </label>
      </form>
    `;
    this.showModal('Сменить поставщика', html, async () => {
      const root = document.getElementById('chg-prod-form')!;
      const pid = (root.querySelector('[name="pid"]') as HTMLSelectElement).value;
      if (!pid) { this.toast('Выберите поставщика', 'error'); return false; }
      try {
        for (const id of ids) await producerProductDb.update(id, { producer_id: pid });
        this.toast(`Перемещено ${ids.length}`, 'success');
        this.productSelected = new Set();
        await this.loadProducts();
        this.render();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); return false; }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTS — import / export / template
  // ════════════════════════════════════════════════════════════════════════

  /** Скачать пустой шаблон импорта со всеми кастомными колонками. */
  downloadProductTemplate(): void {
    const headers = ['Поставщик', 'Артикул', 'Доп. артикул 1', 'Доп. артикул 2', 'Наименование', ...this.fields.map(f => f.name), 'Комментарий'];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'Шаблон_товары_производителей.xlsx');
    this.toast('Шаблон скачан', 'success');
  }

  openProductImport(): void {
    const html = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">
          Загрузите xlsx со списком товаров. Обязательные колонки: <b>Поставщик</b> (название или id),
          <b>Артикул</b>, <b>Наименование</b>. Любые другие колонки сопоставляются с кастомными полями
          по точному совпадению заголовка.
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="window.producersModule.downloadProductTemplate()" style="font-size:11px;padding:6px 11px;background:transparent;color:var(--text-1);border:1px solid var(--line);border-radius:5px;cursor:pointer">📋 Скачать шаблон</button>
        </div>
        <input type="file" accept=".xlsx,.xls" id="prod-import-file"
          style="padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        <div id="prod-import-preview" style="font-size:11px;color:var(--text-2);max-height:200px;overflow:auto"></div>
      </div>
    `;
    this.showModal('Импорт товаров', html, async () => {
      const f = (document.getElementById('prod-import-file') as HTMLInputElement)?.files?.[0];
      if (!f) { this.toast('Выберите файл', 'error'); return false; }
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        if (rows.length === 0) { this.toast('Файл пуст', 'error'); return false; }

        // Карта производителей по имени (lowercase) и id
        const prodByName = new Map<string, string>();
        for (const pr of this.producers) prodByName.set(pr.name.toLowerCase(), pr.id);
        // Карта полей по имени
        const fieldByName = new Map<string, string>();
        for (const fld of this.fields) fieldByName.set(fld.name.toLowerCase(), fld.id);

        const toCreate: Array<Omit<ProducerProduct, 'id' | 'company_id' | 'created_at' | 'updated_at'>> = [];
        // Локальный счётчик занятых internal_id — учитывает уже сгенерированные в этом батче
        const usedImportIds = new Set(this.products.map(p => p.internal_id).filter((x): x is number => x != null));
        const genImportId = (): number => {
          let id: number;
          do { id = 10000 + Math.floor(Math.random() * 90000); } while (usedImportIds.has(id));
          usedImportIds.add(id);
          return id;
        };
        let skipped = 0;
        for (const row of rows) {
          const prRaw = String(row['Поставщик'] ?? row['Производитель'] ?? '').trim();
          let producer_id = '';
          if (prRaw) {
            producer_id = prodByName.get(prRaw.toLowerCase()) ?? '';
            if (!producer_id && this.producers.some(p => p.id === prRaw)) producer_id = prRaw;
          }
          if (!producer_id) producer_id = this.producers[0]?.id ?? '';
          if (!producer_id) { skipped++; continue; }
          const name = String(row['Наименование'] ?? row['Название'] ?? row['name'] ?? '').trim();
          const articles: string[] = [];
          for (const k of ['Артикул', 'Артикул 1', 'Артикул*', 'Доп. артикул 1', 'Доп. артикул 2', 'Доп. артикул 3', 'Доп. артикул 4']) {
            const v = String(row[k] ?? '').trim();
            if (v) articles.push(v);
          }
          if (!name) { skipped++; continue; }
          const field_values: Record<string, string> = {};
          for (const [colName, val] of Object.entries(row)) {
            const fid = fieldByName.get(String(colName).toLowerCase());
            if (fid && String(val).trim()) field_values[fid] = String(val).trim();
          }
          toCreate.push({
            producer_id, name, articles, field_values,
            comment: String(row['Комментарий'] ?? '').trim() || null,
            is_archived: false, internal_id: genImportId(),
          });
        }
        if (toCreate.length === 0) { this.toast('Не найдено корректных строк', 'error'); return false; }
        for (const p of toCreate) await producerProductDb.create(p);
        await this.loadProducts();
        this.toast(`Импортировано: ${toCreate.length}${skipped?`, пропущено: ${skipped}`:''}`, 'success');
        this.render();
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка импорта', 'error'); return false; }
    });
  }

  openProductExport(): void {
    const selected = this.productSelected.size > 0;
    const candidates = selected
      ? this.products.filter(p => this.productSelected.has(p.id))
      : this.filteredProducts();
    const baseCols: Array<{ key: string; label: string }> = [
      { key: 'internal_id', label: 'ID' },
      { key: 'producer',    label: 'Поставщик' },
      { key: 'articles',    label: 'Артикулы' },
      { key: 'name',        label: 'Наименование' },
      ...this.fields.map(f => ({ key: `field_${f.id}`, label: f.name })),
      { key: 'comment', label: 'Комментарий' },
    ];
    const html = `
      <form id="prod-exp-form" style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-2)">
          Будет экспортировано <b style="color:var(--text-1)">${candidates.length}</b> позиций
          ${selected ? `<span style="color:#3b82f6">(из выборки)</span>` : ''}.
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:10px;text-transform:uppercase;color:var(--text-2);margin-bottom:6px">
            <span>Колонки</span>
            <span><a onclick="document.querySelectorAll('#prod-exp-form input[type=checkbox]').forEach(c=>c.checked=true)" style="color:#3b82f6;cursor:pointer">все</a>
            · <a onclick="document.querySelectorAll('#prod-exp-form input[type=checkbox]').forEach(c=>c.checked=false)" style="color:#3b82f6;cursor:pointer">снять</a></span>
          </div>
          <div style="border:1px solid var(--line);border-radius:6px;padding:10px;max-height:250px;overflow:auto;display:flex;flex-direction:column;gap:5px">
            ${baseCols.map(c => `
              <label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:3px 4px;border-radius:4px">
                <input type="checkbox" name="col" value="${c.key}" checked> ${esc(c.label)}
              </label>
            `).join('')}
          </div>
        </div>
      </form>
    `;
    this.showModal('Экспорт каталога в xlsx', html, async () => {
      const root = document.getElementById('prod-exp-form')!;
      const picked = new Set(Array.from(root.querySelectorAll<HTMLInputElement>('[name="col"]:checked')).map(c => c.value));
      if (picked.size === 0) { this.toast('Выберите колонки', 'error'); return false; }
      const cols = baseCols.filter(c => picked.has(c.key));
      const headers = cols.map(c => c.label);
      const prodMapExp = new Map(this.producers.map(x => [x.id, x]));
      const data = candidates.map(p => cols.map(c => {
        if (c.key === 'internal_id') return p.internal_id ?? '';
        if (c.key === 'producer') return prodMapExp.get(p.producer_id)?.name ?? '';
        if (c.key === 'articles') return p.articles.join(', ');
        if (c.key === 'name')     return p.name;
        if (c.key === 'comment')  return p.comment ?? '';
        if (c.key.startsWith('field_')) return p.field_values?.[c.key.slice(6)] ?? '';
        return '';
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      ws['!cols'] = headers.map((h, i) => {
        const max = Math.max(h.length, ...data.map(r => String(r[i] ?? '').length));
        return { wch: Math.min(max + 2, 40) };
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Товары');
      const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `Товары_${new Date().toISOString().slice(0,10)}.xlsx`);
      this.toast(`Экспортировано: ${candidates.length}`, 'success');
      return true;
    });
  }

  /** Найти id произвольного поля по части названия (регистронезависимо). */
  private _fieldIdByName(...patterns: RegExp[]): string | undefined {
    const f = this.fields.find(f => patterns.some(re => re.test(f.name)));
    return f?.id;
  }

  /**
   * Синхронизировать себестоимость из товара производителя в costPriceDb.
   * Вызывается при создании/обновлении связки.
   */
  private _syncCostFromMapping(marketplaceArticle: string, producerProductId: string): void {
    const product = this.products.find(p => p.id === producerProductId);
    if (!product) return;
    const costFieldId = this._fieldIdByName(/себестоимост/i);
    if (!costFieldId) return;
    const rawVal = product.field_values?.[costFieldId];
    if (!rawVal) return;
    const cost = parseFloat(String(rawVal).replace(',', '.'));
    if (!isFinite(cost) || cost <= 0) return;

    const producer = this.producers.find(p => p.id === product.producer_id);
    const producerName = producer?.name ?? product.name;

    costPriceDb.set(marketplaceArticle, cost);
    costProducerLinks.link(marketplaceArticle, producerProductId, producerName, cost);
  }

  /** Числовое значение произвольного поля товара (с учётом запятой как разделителя). */
  private _fieldNum(p: ProducerProduct | undefined, fieldId: string | undefined): number {
    if (!p || !fieldId) return 0;
    const raw = p.field_values?.[fieldId];
    if (!raw) return 0;
    const n = parseFloat(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  /** Импорт связок из xlsx (формат — как у «Экспорт связок»): Артикул МП, Производитель,
   *  Артикулы производителя (через запятую, если позиций несколько). Поставщик и его товары
   *  с такими артикулами должны уже существовать в каталоге этой компании. */
  openMappingsImport(): void {
    const html = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">
          Загрузите xlsx со связками. Обязательные колонки: <b>Артикул МП</b> и <b>Артикулы производителя</b>.
          Если к одному артикулу МП несколько товаров — перечислите через <b>;</b> (например: <code>П001; П002×2; П003</code>).
          Формат <code>АРТИКУЛ×N</code> задаёт количество (поддерживается и латинская <code>x</code>).
          Колонка <b>Производитель</b> опциональна. Товары с такими артикулами должны уже быть в каталоге.
          После импорта появится отчёт с возможностью скачать подробную таблицу.
        </div>
        <input type="file" accept=".xlsx,.xls" id="map-import-file"
          style="padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        <div id="map-import-preview" style="font-size:11px;color:var(--text-2);max-height:200px;overflow:auto"></div>
      </div>
    `;
    this.showModal('Импорт связок из xlsx', html, async () => {
      const f = (document.getElementById('map-import-file') as HTMLInputElement)?.files?.[0];
      if (!f) { this.toast('Выберите файл', 'error'); return false; }
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        if (rows.length === 0) { this.toast('Файл пуст', 'error'); return false; }

        const prodByName = new Map<string, Producer>();
        for (const pr of this.producers) prodByName.set(pr.name.trim().toLowerCase(), pr);
        const knownMpArticles = new Set(this.mpArticles.map(a => a.article));
        const existingKeys = new Set(this.mappings.map(m => `${m.marketplace_article}::${m.producer_product_id}`));

        // Разворачиваем строки файла в плоский список задач (1 задача = 1 артикул производителя),
        // чтобы прогресс-бар и отчёт отражали реальный объём работы.
        const tasks: Array<{ article: string; producer?: Producer; producerNameRaw: string; art: string; qty: number }> = [];
        for (const row of rows) {
          const article = String(row['Артикул МП'] ?? row['Артикул маркетплейса'] ?? '').trim();
          const producerNameRaw = String(row['Производитель'] ?? row['Поставщик'] ?? '').trim();
          const articlesRaw = String(row['Артикулы производителя'] ?? row['Артикул производителя'] ?? '').trim();
          if (!article || !articlesRaw) continue;
          // Производитель может быть через ";" (новый формат) или через ","
          const producerFirst = producerNameRaw.split(/[;,]/)[0].trim();
          const producer = producerFirst ? prodByName.get(producerFirst.toLowerCase()) : undefined;
          // Артикулы разделены ";" (новый формат) или "," (старый)
          for (const part of articlesRaw.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
            // Поддержка формата "АРТИКУЛ×N" или "АРТИКУЛ x N"
            const qtyMatch = part.match(/^(.+?)[×x](\d+(?:[.,]\d+)?)$/i);
            const art = qtyMatch ? qtyMatch[1].trim() : part;
            const qty = qtyMatch ? parseFloat(qtyMatch[2].replace(',', '.')) : 1;
            tasks.push({ article, producer, producerNameRaw, art, qty: qty > 0 ? qty : 1 });
          }
        }
        if (tasks.length === 0) { this.toast('Не найдено строк для импорта', 'error'); return false; }

        // ── Классификация (быстро, синхронно, без сети) ──
        const report: MappingImportReportRow[] = [];
        const toCreate: Array<{ marketplace_article: string; producer_product_id: string; quantity: number; _row: MappingImportReportRow }> = [];
        for (const { article, producer, producerNameRaw, art, qty } of tasks) {
          const mpKnown = knownMpArticles.size === 0 || knownMpArticles.has(article);
          const candidates = this.products.filter(p =>
            (!producer || p.producer_id === producer.id) && p.articles.some(a => a.toLowerCase() === art.toLowerCase()));
          if (candidates.length === 0) {
            report.push({ article, mpKnown, art, producerNameRaw, status: 'no_product', matchedProduct: '', matchedProducerName: '', ambiguous: false, comment: 'Товар производителя с таким артикулом не найден в каталоге' });
            continue;
          }
          const product = candidates[0];
          const matchedProducerName = this.producers.find(pr => pr.id === product.producer_id)?.name ?? '';
          const key = `${article}::${product.id}`;
          const row: MappingImportReportRow = {
            article, mpKnown, art, producerNameRaw,
            status: existingKeys.has(key) ? 'exists' : 'created',
            matchedProduct: product.name, matchedProducerName,
            ambiguous: candidates.length > 1,
            comment: candidates.length > 1 ? `Найдено ${candidates.length} подходящих товаров, взят первый` : '',
          };
          report.push(row);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            toCreate.push({ marketplace_article: article, producer_product_id: product.id, quantity: qty, _row: row });
          }
        }

        // ── Загрузка пачками с возможностью остановки ──
        const progress = this.showProgressOverlay('Импорт связок…');
        const CHUNK = 300;
        let lastError: any = null;
        let stopped = false;
        let processedUpTo = 0;
        try {
          for (let i = 0; i < toCreate.length; i += CHUNK) {
            if (progress.cancelled()) { stopped = true; break; }
            const chunk = toCreate.slice(i, i + CHUNK);
            try {
              await producerMappingDb.bulkCreate(chunk.map(c => ({ marketplace_article: c.marketplace_article, producer_product_id: c.producer_product_id, quantity: c.quantity })));
            } catch {
              // Чанк не прошёл целиком (например, гонка/повтор клика) — догружаем по одной, чтобы понять какие именно
              for (const c of chunk) {
                try {
                  await producerMappingDb.create({ marketplace_article: c.marketplace_article, producer_product_id: c.producer_product_id, quantity: c.quantity });
                } catch (e2: any) {
                  if (String(e2?.message ?? '').includes('23505')) { c._row.status = 'exists'; }
                  else { lastError = e2; c._row.status = 'no_product'; c._row.comment = e2?.message ?? 'Ошибка записи'; }
                }
              }
            }
            processedUpTo = i + chunk.length;
            progress.update(processedUpTo, toCreate.length);
          }
        } finally { progress.close(); }

        // Если остановили раньше времени — то, что не успели отправить, помечаем как «остановлено»
        if (stopped) {
          for (let i = processedUpTo; i < toCreate.length; i++) {
            toCreate[i]._row.status = 'stopped';
            toCreate[i]._row.comment = 'Импорт остановлен пользователем до обработки этой строки';
          }
        }

        this._lastImportReport = report;

        // Обновляем состояние даже при частичной остановке/ошибке — чтобы повторная попытка не дублировала уже созданное
        await this.loadMappings();
        this.render();

        const created = report.filter(r => r.status === 'created').length;
        const exists = report.filter(r => r.status === 'exists').length;
        const noProduct = report.filter(r => r.status === 'no_product').length;
        const ambiguousCount = report.filter(r => r.ambiguous).length;
        const mpUnknown = report.filter(r => !r.mpKnown).length;

        const summaryRows: Array<[string, string]> = [
          ['Создано новых связок', String(created)],
          ['Уже существовало', String(exists)],
          ['Товар производителя не найден', String(noProduct)],
          ['Неоднозначных (взят первый)', String(ambiguousCount)],
          ['Артикул МП не найден в каталоге МП', String(mpUnknown)],
        ];
        const resultHtml = `
          <div style="display:flex;flex-direction:column;gap:10px">
            ${stopped ? `<div style="padding:8px 10px;border-radius:6px;background:rgba(245,158,11,.12);color:#f59e0b;font-size:12px">Импорт остановлен пользователем — обработана часть файла.</div>` : ''}
            <table style="width:100%;font-size:12px;border-collapse:collapse">
              ${summaryRows.map(([label, val]) => `
                <tr style="border-bottom:1px solid var(--line)">
                  <td style="padding:5px 0;color:var(--text-2)">${esc(label)}</td>
                  <td style="padding:5px 0;text-align:right;font-weight:600">${esc(val)}</td>
                </tr>`).join('')}
            </table>
            <div style="font-size:11px;color:var(--text-2)">
              Всего позиций в файле: ${tasks.length}. «Артикул МП не найден в каталоге МП» — не блокирует создание связки,
              просто означает что этот артикул ещё не загружен в каталог маркетплейса в этой системе.
            </div>
            <button onclick="window.producersModule.downloadMappingsImportReport()"
              style="padding:8px 14px;font-size:12px;border:1px solid var(--line);border-radius:7px;background:var(--bg-2);color:var(--text-1);cursor:pointer;align-self:flex-start">
              📄 Скачать подробный отчёт (xlsx)
            </button>
          </div>
        `;
        this.showModal('Результат импорта связок', resultHtml, null, { saveText: 'Закрыть', cancelText: '' });

        if (lastError && created === 0) { this.toast(lastError?.message ?? 'Ошибка импорта', 'error'); }
        return true;
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка импорта', 'error'); return false; }
    }, { saveText: 'Импортировать' });
  }

  downloadMappingsImportReport(): void {
    const report = this._lastImportReport;
    if (report.length === 0) { this.toast('Нет данных отчёта', 'info'); return; }
    const statusLabel: Record<MappingImportReportRow['status'], string> = {
      created: 'Создано', exists: 'Уже было', no_product: 'Товар не найден', stopped: 'Остановлено (не обработано)',
    };
    const headers = ['Артикул МП', 'Есть в каталоге МП', 'Артикул производителя', 'Производитель (из файла)', 'Статус', 'Найденный товар', 'Производитель найденного товара', 'Комментарий'];
    const data = report.map(r => [
      r.article, r.mpKnown ? 'Да' : 'Нет', r.art, r.producerNameRaw, statusLabel[r.status], r.matchedProduct, r.matchedProducerName, r.comment,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws['!cols'] = headers.map((h, i) => ({ wch: Math.min(Math.max(h.length, ...data.map(row => String(row[i] ?? '').length)) + 2, 45) }));
    const wbOut = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbOut, ws, 'Отчёт импорта');
    const out = XLSX.write(wbOut, { type: 'array', bookType: 'xlsx' });
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Отчёт_импорта_связок_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async openMappingsExport(): Promise<void> {
    const selected = this.linkedSelected.size > 0;
    const allLinked = [...new Set(this.mappings.map(m => m.marketplace_article))];
    const articles = selected ? allLinked.filter(a => this.linkedSelected.has(a)) : allLinked;
    if (articles.length === 0) { this.toast('Нет связок для экспорта', 'info'); return; }

    const weightFieldId   = this._fieldIdByName(/вес/i);
    const lengthFieldId   = this._fieldIdByName(/длина\s*упаковки/i);
    const widthFieldId    = this._fieldIdByName(/ширина\s*упаковки/i);
    const heightFieldId   = this._fieldIdByName(/высота\s*упаковки/i);
    const volumeFieldId   = this._fieldIdByName(/объ[её]м/i);
    const packagesFieldId = this._fieldIdByName(/кол-?во\s*упаковок/i);
    const categoryFieldId = this._fieldIdByName(/категор/i);
    const costFieldId     = this._fieldIdByName(/себестоимост/i);

    const recognizedIds = new Set([weightFieldId, lengthFieldId, widthFieldId, heightFieldId, volumeFieldId, packagesFieldId, categoryFieldId, costFieldId].filter(Boolean));
    const otherFields = this.fields.filter(f => !recognizedIds.has(f.id));

    const baseCols: Array<{ key: string; label: string }> = [
      { key: 'article',    label: 'Артикул МП' },
      { key: 'producer',   label: 'Производитель' },
      { key: 'products',   label: 'Товары (состав связки)' },
      { key: 'articles',   label: 'Артикулы производителя' },
      { key: 'qty',         label: 'Кол-во позиций' },
      { key: 'weight',     label: 'Вес, кг' },
      { key: 'length',     label: 'Длина упаковки, мм' },
      { key: 'width',      label: 'Ширина упаковки, мм' },
      { key: 'height',     label: 'Высота упаковки, мм' },
      { key: 'volume',     label: 'Объём, м³' },
      { key: 'packages',   label: 'Кол-во упаковок' },
      ...(costFieldId ? [{ key: 'cost', label: 'Себестоимость' }] : []),
      ...(categoryFieldId ? [{ key: 'category', label: 'Категория' }] : []),
      ...otherFields.map(f => ({ key: `field_${f.id}`, label: f.name })),
    ];

    type Row = { article: string; producer: string; producerIds: Set<string>; products: string; articles: string; qty: number;
      weight: number; length: number; width: number; height: number; volume: number; packages: number;
      cost: number; category: string; fields: Record<string, string> };

    // Индексы вместо .find()/.filter() в цикле — иначе построение строк превращается в O(articles × mappings × products)
    // и при больших каталогах ощутимо подвешивает интерфейс.
    const mappingsByArticle = new Map<string, typeof this.mappings>();
    for (const m of this.mappings) {
      const arr = mappingsByArticle.get(m.marketplace_article);
      if (arr) arr.push(m); else mappingsByArticle.set(m.marketplace_article, [m]);
    }
    const productsById = new Map(this.products.map(p => [p.id, p]));
    const producersById = new Map(this.producers.map(p => [p.id, p]));

    const buildRow = (article: string): Row => {
      const maps = mappingsByArticle.get(article) ?? [];
      const positions = maps.map(m => ({ product: productsById.get(m.producer_product_id), qty: m.quantity || 1 }));

      const producerIdSet = new Set(positions.map(pos => pos.product?.producer_id ?? '').filter(Boolean));
      const producerNames = [...producerIdSet].map(id => producersById.get(id)?.name ?? '').filter(Boolean).join('; ');

      const productsStr = positions.map(pos => `${pos.product?.name ?? '—'}${pos.qty !== 1 ? ` ×${pos.qty}` : ''}`).join('; ');
      const articlesStr = positions.map(pos => {
        const art = pos.product?.articles?.[0] ?? '';
        if (!art) return '';
        return pos.qty !== 1 ? `${art}×${pos.qty}` : art;
      }).filter(Boolean).join('; ');

      const weight   = positions.reduce((s, pos) => s + this._fieldNum(pos.product, weightFieldId) * pos.qty, 0);
      const length   = positions.reduce((s, pos) => s + this._fieldNum(pos.product, lengthFieldId) * pos.qty, 0);
      const width    = Math.max(0, ...positions.map(pos => this._fieldNum(pos.product, widthFieldId)));
      const height   = Math.max(0, ...positions.map(pos => this._fieldNum(pos.product, heightFieldId)));
      const volume   = positions.reduce((s, pos) => s + this._fieldNum(pos.product, volumeFieldId) * pos.qty, 0);
      const packages = positions.reduce((s, pos) => s + this._fieldNum(pos.product, packagesFieldId) * pos.qty, 0);
      const cost     = positions.reduce((s, pos) => s + this._fieldNum(pos.product, costFieldId) * pos.qty, 0);
      const category = categoryFieldId
        ? [...new Set(positions.map(pos => pos.product?.field_values?.[categoryFieldId]).filter(Boolean))].join(', ')
        : '';

      const fields: Record<string, string> = {};
      for (const f of otherFields) {
        const vals = [...new Set(positions.map(pos => pos.product?.field_values?.[f.id]).filter(Boolean))];
        fields[f.id] = vals.join('; ');
      }

      return {
        article, producer: producerNames, producerIds: producerIdSet, products: productsStr, articles: articlesStr,
        qty: positions.reduce((s, pos) => s + pos.qty, 0),
        weight, length, width, height, volume, packages, cost, category, fields,
      };
    };

    // Для небольших выгрузок строим всё сразу; для больших — пачками с прогрессом и кнопкой «Стоп»
    const rows: Row[] = [];
    const EXPORT_CHUNK = 300;
    let exportStopped = false;
    const buildProgress = articles.length > EXPORT_CHUNK ? this.showProgressOverlay('Подготовка экспорта…') : null;
    try {
      for (let i = 0; i < articles.length; i += EXPORT_CHUNK) {
        if (buildProgress?.cancelled()) { exportStopped = true; break; }
        for (const article of articles.slice(i, i + EXPORT_CHUNK)) rows.push(buildRow(article));
        if (buildProgress) {
          buildProgress.update(Math.min(i + EXPORT_CHUNK, articles.length), articles.length);
          await new Promise(r => setTimeout(r, 0)); // отдаём ход браузеру — даёт UI обновиться и обработать клик «Стоп»
        }
      }
    } finally { buildProgress?.close(); }
    if (exportStopped) this.toast(`Остановлено: подготовлено ${rows.length} из ${articles.length}`, 'info');

    // Производители присутствующие в этом наборе строк
    const exportProducers = this.producers.filter(pr => rows.some(r => r.producerIds.has(pr.id)));

    const html = `
      <form id="map-exp-form" style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:12px;color:var(--text-2)">
          Всего: <b style="color:var(--text-1)">${rows.length}</b> связок
          ${selected ? `<span style="color:#3b82f6">(из выборки)</span>` : ''}.
          ${exportStopped ? `<span style="color:#f59e0b">Подготовка была остановлена раньше времени.</span>` : ''}
        </div>
        ${!selected && exportProducers.length > 1 ? `
        <div>
          <div style="font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px;margin-bottom:6px">Производители</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px">
            ${exportProducers.map(pr => `
              <label style="display:flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--line);border-radius:5px;cursor:pointer;font-size:12px;background:var(--bg-2)">
                <input type="checkbox" name="pr" value="${pr.id}" checked> ${esc(pr.name)}
              </label>
            `).join('')}
          </div>
        </div>
        ` : ''}
        <div>
          <div style="display:flex;justify-content:space-between;font-size:10px;text-transform:uppercase;color:var(--text-2);margin-bottom:6px">
            <span>Колонки</span>
            <span><a onclick="document.querySelectorAll('#map-exp-form input[type=checkbox]').forEach(c=>c.checked=true)" style="color:#3b82f6;cursor:pointer">все</a>
            · <a onclick="document.querySelectorAll('#map-exp-form input[type=checkbox]').forEach(c=>c.checked=false)" style="color:#3b82f6;cursor:pointer">снять</a></span>
          </div>
          <div style="border:1px solid var(--line);border-radius:6px;padding:10px;max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:5px">
            ${baseCols.map(c => `
              <label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;padding:3px 4px;border-radius:4px">
                <input type="checkbox" name="col" value="${c.key}" checked> ${esc(c.label)}
              </label>
            `).join('')}
          </div>
        </div>
      </form>
    `;

    this.showModal('Экспорт связок в xlsx', html, async () => {
      const root = document.getElementById('map-exp-form')!;
      const picked = new Set(Array.from(root.querySelectorAll<HTMLInputElement>('[name="col"]:checked')).map(c => c.value));
      if (picked.size === 0) { this.toast('Выберите колонки', 'error'); return false; }
      const selectedProducers = new Set(Array.from(root.querySelectorAll<HTMLInputElement>('[name="pr"]:checked')).map(c => c.value));
      const filteredRows = selectedProducers.size > 0
        ? rows.filter(r => [...r.producerIds].some(id => selectedProducers.has(id)))
        : rows;
      if (filteredRows.length === 0) { this.toast('Нет строк по выбранным производителям', 'error'); return false; }
      const cols = baseCols.filter(c => picked.has(c.key));
      const headers = cols.map(c => c.label);
      const data = filteredRows.map(r => cols.map(c => {
        if (c.key === 'article')  return r.article;
        if (c.key === 'producer') return r.producer;
        if (c.key === 'products') return r.products;
        if (c.key === 'articles') return r.articles;
        if (c.key === 'qty')      return r.qty;
        if (c.key === 'weight')   return r.weight ? Math.round(r.weight * 1000) / 1000 : '';
        if (c.key === 'length')   return r.length || '';
        if (c.key === 'width')    return r.width || '';
        if (c.key === 'height')   return r.height || '';
        if (c.key === 'volume')   return r.volume ? Math.round(r.volume * 10000) / 10000 : '';
        if (c.key === 'packages') return r.packages || '';
        if (c.key === 'cost')     return r.cost ? Math.round(r.cost * 100) / 100 : '';
        if (c.key === 'category') return r.category;
        if (c.key.startsWith('field_')) return r.fields[c.key.slice(6)] ?? '';
        return '';
      }));
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      ws['!cols'] = headers.map((h, i) => {
        const max = Math.max(h.length, ...data.map(row => String(row[i] ?? '').length));
        return { wch: Math.min(max + 2, 45) };
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Связки');
      const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `Связки_${new Date().toISOString().slice(0,10)}.xlsx`);
      this.toast(`Экспортировано: ${filteredRows.length}`, 'success');
      return true;
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // TEMPLATE EXPORT — экспорт связок в произвольный xlsx-шаблон
  // ════════════════════════════════════════════════════════════════════════

  private static readonly TPL_NUMERIC_KEYS = new Set([
    'qty_total','packages','weight','length_mm','width_mm','height_mm',
    'length_cm','width_cm','height_cm','volume','cost',
  ]);

  /** Список полей системы, которые можно вставить в шаблон. */
  private _tplSourceCols(): Array<{ key: string; label: string; isNumeric?: boolean }> {
    return [
      { key: 'mp_article',            label: 'Артикул МП' },
      { key: 'mp_name',               label: 'Название с маркетплейса' },
      { key: 'producer_article',      label: 'Артикул производителя (1-й)' },
      { key: 'producer_articles_all', label: 'Артикулы производителя (все через ; )' },
      { key: 'internal_id',           label: 'Внутренний ID товара' },
      { key: 'product_name',          label: 'Название товара (1-й)' },
      { key: 'product_names_all',     label: 'Названия товаров (все через ; )' },
      { key: 'producer_name',         label: 'Производитель' },
      { key: 'category',              label: 'Категория' },
      { key: 'qty_total',             label: 'Количество (итого)',  isNumeric: true },
      { key: 'packages',              label: 'Кол-во упаковок',    isNumeric: true },
      { key: 'weight',                label: 'Вес, кг',            isNumeric: true },
      { key: 'length_mm',             label: 'Длина, мм',          isNumeric: true },
      { key: 'width_mm',              label: 'Ширина, мм',         isNumeric: true },
      { key: 'height_mm',             label: 'Высота, мм',         isNumeric: true },
      { key: 'length_cm',             label: 'Длина, см',          isNumeric: true },
      { key: 'width_cm',              label: 'Ширина, см',         isNumeric: true },
      { key: 'height_cm',             label: 'Высота, см',         isNumeric: true },
      { key: 'volume',                label: 'Объём, м³',          isNumeric: true },
      { key: 'cost',                  label: 'Себестоимость',      isNumeric: true },
      ...this.fields.map(f => ({ key: `field_${f.id}`, label: f.name, isNumeric: true })),
    ];
  }

  /** Авто-матч заголовка шаблона → ключ поля системы. */
  private _tplAutoMatch(header: string): string {
    const h = header.toLowerCase();
    // Нормализованный заголовок: убираем единицы в скобках и лишние пробелы
    const hNorm = h.replace(/\s*\([^)]*\)\s*/g, ' ').trim().replace(/\s+/g, ' ');

    // Кастомные поля — проверяем ПЕРВЫМИ, до keyword-логики
    for (const f of this.fields) {
      const fn = f.name.toLowerCase().trim();
      if (fn === h || fn === hNorm) return `field_${f.id}`;
    }

    if (/внутренн.*ид|внутренн.*id|internal.*id/i.test(h)) return 'internal_id';
    if (/наим|назван.*товар|product.*name/i.test(h)) return 'product_name';
    if (/арт.*ozon|ozon.*арт/i.test(h)) return 'mp_article';
    if (/арт.*wb|wb.*арт|wildber/i.test(h)) return 'mp_article';
    if (/арт.*янд|янд.*арт|яндекс.*арт|market.*арт/i.test(h)) return 'mp_article';
    if (/арт.*мп|мп.*арт/i.test(h)) return 'mp_article';
    if (/производ/i.test(h)) return 'producer_name';
    if (/категор/i.test(h)) return 'category';
    if (/себестоим|cost.price/i.test(h)) return 'cost';
    if (/кол.*упак|упак.*кол/i.test(h)) return 'packages';
    if (/вес|weight/i.test(h)) return 'weight';
    if (/кол.*в.*кор|кол.*короб/i.test(h)) return 'qty_total';
    if (/длин/i.test(h) && /см/i.test(h)) return 'length_cm';
    if (/ширин/i.test(h) && /см/i.test(h)) return 'width_cm';
    if (/высот/i.test(h) && /см/i.test(h)) return 'height_cm';
    if (/длин/i.test(h)) return 'length_mm';
    if (/ширин/i.test(h)) return 'width_mm';
    if (/высот/i.test(h)) return 'height_mm';
    if (/объ[её]м|volume/i.test(h)) return 'volume';
    return '';
  }

  openTemplateExport(): void {
    const selected = this.linkedSelected.size > 0;
    const allLinked = [...new Set(this.mappings.map(m => m.marketplace_article))];
    const baseArticles = selected ? allLinked.filter(a => this.linkedSelected.has(a)) : allLinked;
    if (baseArticles.length === 0) { this.toast('Нет связок для экспорта', 'info'); return; }

    // Производители для фильтра (только когда нет ручного выбора позиций)
    const tplExportProducers = selected ? [] : this.producers.filter(pr =>
      baseArticles.some(art => this.mappings.filter(m => m.marketplace_article === art)
        .some(m => this.products.find(p => p.id === m.producer_product_id)?.producer_id === pr.id))
    );

    const html = `
      <div id="tpl-exp-wrap" style="display:flex;flex-direction:column;gap:14px">
        <div style="font-size:12px;color:var(--text-2)">
          Загрузите .xlsx шаблон. Система прочитает заголовки первой строки и предложит авто-маппинг полей.
          Одно поле системы можно назначить на несколько колонок шаблона.
          ${selected ? `<span style="color:#3b82f6">Выбрано позиций: ${baseArticles.length}.</span>` : `Всего: <b>${baseArticles.length}</b> артикулов.`}
        </div>
        ${!selected && tplExportProducers.length > 1 ? `
        <div>
          <div style="font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px;margin-bottom:6px">Производители</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px">
            ${tplExportProducers.map(pr => `
              <label style="display:flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--line);border-radius:5px;cursor:pointer;font-size:12px;background:var(--bg-2)">
                <input type="checkbox" name="tpl-pr" value="${pr.id}" checked> ${esc(pr.name)}
              </label>
            `).join('')}
          </div>
        </div>
        ` : ''}
        <label style="display:flex;flex-direction:column;gap:6px">
          <span style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Шаблон (.xlsx)</span>
          <input type="file" accept=".xlsx,.xls" id="tpl-exp-file"
            onchange="window.producersModule._onTplFileLoad(this)"
            style="font-size:12px;color:var(--text-1)">
        </label>
        <div id="tpl-exp-mapping" style="display:none;flex-direction:column;gap:6px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:10px;text-transform:uppercase;
            letter-spacing:.5px;color:var(--text-2);padding:0 4px">
            <span>Заголовок в шаблоне</span><span>Поле системы</span>
          </div>
          <div id="tpl-exp-rows" style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto;
            border:1px solid var(--line);border-radius:6px;padding:8px"></div>
        </div>
      </div>
    `;

    (window as any).__tplExpBaseArticles = baseArticles;
    (window as any).__tplExpSelected = selected;
    (window as any).__tplExpWb = null;

    this.showModal('Экспорт в шаблон', html, async () => {
      return this._doTplExport();
    }, { saveText: 'Экспортировать' });
  }

  async _onTplFileLoad(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellStyles: true });
      (window as any).__tplExpWb = wb;
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
      const headers = ((raw[0] as unknown as string[]) ?? []).map(h => String(h ?? '').trim());

      const sourceCols = this._tplSourceCols();
      const numericKeys = new Set([...ProducersModule.TPL_NUMERIC_KEYS, ...this.fields.map(f => `field_${f.id}`)]);
      const selOpts = `<option value="">— Не заполнять —</option>` +
        sourceCols.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
      const aggOpts = `
        <option value="sum">Сумма</option>
        <option value="all">Все через «; »</option>
        <option value="max">Максимальное</option>
        <option value="min">Минимальное</option>
        <option value="avg">Среднее</option>
      `;

      const rowsHtml = headers.map((h, i) => {
        if (!h) return '';
        const auto = this._tplAutoMatch(h);
        const isNumAuto = auto ? numericKeys.has(auto) : false;
        const opts = selOpts.replace(
          auto ? `value="${esc(auto)}"` : '___never___',
          `value="${esc(auto)}" selected`,
        );
        const isMatched = !!auto;
        return `
          <div style="display:grid;grid-template-columns:1fr 1.2fr auto;gap:6px;align-items:center;padding:5px 6px;
            border-radius:5px;background:${isMatched ? 'rgba(74,222,128,.05)' : 'transparent'};
            border:1px solid ${isMatched ? 'rgba(74,222,128,.15)' : 'var(--line)'}">
            <span style="font-size:12px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${esc(h)}">
              ${isMatched ? '<span style="color:#4ade80;margin-right:4px">✓</span>' : ''}${esc(h)}
            </span>
            <select name="tplmap" data-col="${i}"
              onchange="window.producersModule._onTplMapChange(this)"
              style="padding:4px 7px;border:1px solid var(--line);border-radius:5px;
                background:var(--bg-2);color:var(--text-1);font-size:11px;width:100%">
              ${opts}
            </select>
            <select name="tplagg" data-col="${i}"
              style="padding:4px 7px;border:1px solid var(--line);border-radius:5px;
                background:var(--bg-2);color:var(--text-1);font-size:11px;
                display:${isNumAuto ? 'block' : 'none'}">
              ${aggOpts}
            </select>
          </div>
        `;
      }).join('');

      const mapWrap = document.getElementById('tpl-exp-mapping')!;
      const rowsEl  = document.getElementById('tpl-exp-rows')!;
      rowsEl.innerHTML = rowsHtml || '<div style="color:var(--text-2);font-size:12px;padding:8px">Заголовки не найдены</div>';
      mapWrap.style.display = 'flex';
    } catch (e: any) {
      this.toast('Ошибка чтения файла: ' + (e?.message ?? e), 'error');
    }
  }

  _onTplMapChange(sel: HTMLSelectElement): void {
    const col = sel.dataset.col;
    const numericKeys = new Set([...ProducersModule.TPL_NUMERIC_KEYS, ...this.fields.map(f => `field_${f.id}`)]);
    const aggSel = document.querySelector<HTMLSelectElement>(`[name="tplagg"][data-col="${col}"]`);
    if (aggSel) aggSel.style.display = numericKeys.has(sel.value) ? 'block' : 'none';
  }

  private async _doTplExport(): Promise<boolean> {
    const wb: ReturnType<typeof XLSX.read> | null = (window as any).__tplExpWb;
    const baseArticles: string[] = (window as any).__tplExpBaseArticles ?? [];
    const isSelected: boolean = (window as any).__tplExpSelected ?? false;
    if (!wb) { this.toast('Сначала загрузите шаблон', 'error'); return false; }

    // Фильтр по производителям (только если позиции не выбраны вручную)
    let articles = baseArticles;
    if (!isSelected) {
      const checkedPr = new Set(
        Array.from(document.querySelectorAll<HTMLInputElement>('[name="tpl-pr"]:checked')).map(c => c.value)
      );
      if (checkedPr.size > 0) {
        const productsById = new Map(this.products.map(p => [p.id, p]));
        articles = baseArticles.filter(art =>
          this.mappings.filter(m => m.marketplace_article === art)
            .some(m => checkedPr.has(productsById.get(m.producer_product_id)?.producer_id ?? ''))
        );
      }
    }
    if (articles.length === 0) { this.toast('Нет строк по выбранным производителям', 'error'); return false; }

    // Читаем маппинг: colIndex → { key, agg }
    const selects = document.querySelectorAll<HTMLSelectElement>('[name="tplmap"]');
    const colMap = new Map<number, { key: string; agg: string }>();
    for (const sel of selects) {
      const col = Number(sel.dataset.col);
      if (!sel.value) continue;
      const aggSel = document.querySelector<HTMLSelectElement>(`[name="tplagg"][data-col="${col}"]`);
      const agg = aggSel?.value || 'sum';
      colMap.set(col, { key: sel.value, agg });
    }
    if (colMap.size === 0) { this.toast('Не выбрано ни одного поля', 'error'); return false; }

    // Читаем заголовочную строку из шаблона (сохраняем её)
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const allRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][];
    const headerRow = allRows[0] ?? [];
    const totalCols = Math.max(headerRow.length, ...colMap.keys()) + 1;

    // Строим индексы
    const mappingsByArticle = new Map<string, typeof this.mappings>();
    for (const m of this.mappings) {
      const arr = mappingsByArticle.get(m.marketplace_article);
      if (arr) arr.push(m); else mappingsByArticle.set(m.marketplace_article, [m]);
    }
    const productsById  = new Map(this.products.map(p => [p.id, p]));
    const producersById = new Map(this.producers.map(p => [p.id, p]));

    const weightFieldId   = this._fieldIdByName(/вес/i);
    const lengthFieldId   = this._fieldIdByName(/длина\s*упаковки/i);
    const widthFieldId    = this._fieldIdByName(/ширина\s*упаковки/i);
    const heightFieldId   = this._fieldIdByName(/высота\s*упаковки/i);
    const volumeFieldId   = this._fieldIdByName(/объ[её]м/i);
    const packagesFieldId = this._fieldIdByName(/кол-?во\s*упаковок/i);
    const categoryFieldId = this._fieldIdByName(/категор/i);
    const costFieldId     = this._fieldIdByName(/себестоимост/i);
    const mpNameMap       = new Map(this.mpArticles.map(a => [a.article, a.name]));

    // Возвращает массив сырых числовых значений для числовых полей (до агрегации)
    const pkg = packagesFieldId ?? null, wgt = weightFieldId ?? null,
          len = lengthFieldId ?? null,  wid = widthFieldId ?? null,
          hgt = heightFieldId ?? null,  vol = volumeFieldId ?? null,
          cst = costFieldId   ?? null;
    const getRaw = (pos: Array<{ product: any; qty: number }>, key: string): number[] => {
      const n = (fid: string | null, p: { product: any; qty: number }) =>
        fid ? this._fieldNum(p.product, fid) : 0;
      switch (key) {
        case 'qty_total':  return [pos.reduce((s, p) => s + p.qty, 0)];
        case 'packages':   return pos.map(p => n(pkg, p) * p.qty).filter(v => v > 0);
        case 'weight':     return pos.map(p => n(wgt, p) * p.qty).filter(v => v > 0);
        case 'length_mm':  return pos.map(p => n(len, p)).filter(v => v > 0);
        case 'width_mm':   return pos.map(p => n(wid, p)).filter(v => v > 0);
        case 'height_mm':  return pos.map(p => n(hgt, p)).filter(v => v > 0);
        case 'length_cm':  return pos.map(p => n(len, p) / 10).filter(v => v > 0);
        case 'width_cm':   return pos.map(p => n(wid, p) / 10).filter(v => v > 0);
        case 'height_cm':  return pos.map(p => n(hgt, p) / 10).filter(v => v > 0);
        case 'volume':     return pos.map(p => n(vol, p) * p.qty).filter(v => v > 0);
        case 'cost':       return pos.map(p => n(cst, p)).filter(v => v > 0);
        default: {
          if (key.startsWith('field_')) {
            const fid = key.slice(6);
            return pos.map(p => parseFloat(String(p.product?.field_values?.[fid] ?? '').replace(',', '.'))).filter(v => !isNaN(v) && v > 0);
          }
          return [];
        }
      }
    };

    const applyAgg = (vals: number[], agg: string): string | number => {
      if (!vals.length) return '';
      const r = (v: number) => Math.round(v * 10000) / 10000;
      switch (agg) {
        case 'all': return vals.map(v => r(v)).join('; ');
        case 'max': return r(Math.max(...vals));
        case 'min': return r(Math.min(...vals));
        case 'avg': return r(vals.reduce((s, v) => s + v, 0) / vals.length);
        default:    return r(vals.reduce((s, v) => s + v, 0)); // sum
      }
    };

    const numericKeys = new Set([...ProducersModule.TPL_NUMERIC_KEYS, ...this.fields.map(f => `field_${f.id}`)]);

    const getValue = (article: string, key: string, agg: string): string | number => {
      const maps = mappingsByArticle.get(article) ?? [];
      const pos  = maps.map(m => ({ product: productsById.get(m.producer_product_id), qty: m.quantity || 1 }));
      const first = pos[0];

      // Числовые поля — применяем агрегацию
      if (numericKeys.has(key)) return applyAgg(getRaw(pos, key), agg);

      switch (key) {
        case 'mp_article':            return article;
        case 'mp_name':               return mpNameMap.get(article) ?? '';
        case 'producer_article':      return first?.product?.articles?.[0] ?? '';
        case 'producer_articles_all': return pos.map(p => p.product?.articles?.[0]).filter(Boolean).join('; ');
        case 'internal_id':           return first?.product?.internal_id ?? '';
        case 'product_name':          return first?.product?.name ?? '';
        case 'product_names_all':     return pos.map(p => p.product?.name).filter(Boolean).join('; ');
        case 'producer_name':         return [...new Set(pos.map(p => producersById.get(p.product?.producer_id ?? '')?.name ?? '').filter(Boolean))].join('; ');
        case 'category':              return categoryFieldId ? [...new Set(pos.map(p => p.product?.field_values?.[categoryFieldId]).filter(Boolean))].join(', ') : '';
        default:                      return '';
      }
    };

    // Строим строки данных
    const dataRows: (string | number)[][] = articles.map(article => {
      const row: (string | number)[] = Array(totalCols).fill('');
      for (const [colIdx, { key, agg }] of colMap) {
        row[colIdx] = getValue(article, key, agg);
      }
      return row;
    });

    // Пишем данные прямо в ячейки оригинального листа начиная со строки 2
    // (строка 1 — заголовок шаблона, её не трогаем — сохраняется дизайн)
    for (let r = 0; r < dataRows.length; r++) {
      for (let c = 0; c < dataRows[r].length; c++) {
        const v = dataRows[r][c];
        if (v === '' || v === undefined) continue;
        const addr = XLSX.utils.encode_cell({ r: r + 1, c });
        ws[addr] = { v, t: typeof v === 'number' ? 'n' : 's' };
      }
    }
    // Расширяем диапазон листа чтобы включить добавленные строки
    const origRange = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
    origRange.e.r = Math.max(origRange.e.r, dataRows.length);
    origRange.e.c = Math.max(origRange.e.c, totalCols - 1);
    ws['!ref'] = XLSX.utils.encode_range(origRange);

    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Экспорт_шаблон_${new Date().toISOString().slice(0,10)}.xlsx`);
    this.toast(`Экспортировано: ${articles.length}`, 'success');
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════
  // MAPPINGS — sub-tabs, import MP articles, auto-suggest, bulk create
  // ════════════════════════════════════════════════════════════════════════

  setMappingSubtab(t: 'pending' | 'linked'): void { this.mappingSubtab = t; this.render(); }
  setMappingConfFilter(k: string): void { this.mappingConfidenceFilter = k as any; this.mappingVisibleCount = 50; this.render(); }
  setMappingProducerFilter(v: string): void { this.mappingProducerFilter = v; this.mappingVisibleCount = 50; this.mappingLinkedVisibleCount = 50; this.render(); }

  toggleMappingKey(key: string): void {
    const listEl = document.getElementById('pm-pending-list');
    const savedScroll = listEl?.scrollTop ?? 0;

    if (this.mappingSelectedKeys.has(key)) {
      this.mappingSelectedKeys.delete(key);
      this.mappingKeyQty.delete(key);
    } else {
      this.mappingSelectedKeys.add(key);
      if (!this.mappingKeyQty.has(key)) this.mappingKeyQty.set(key, 1);
    }
    this.render();
    requestAnimationFrame(() => {
      const c = document.getElementById('pm-pending-list');
      if (c) c.scrollTop = savedScroll;
    });
  }

  setMappingKeyQty(key: string, qty: number): void {
    this.mappingKeyQty.set(key, Math.max(1, Math.round(qty || 1)));
  }

  bulkPickAllExact(): void {
    const visible = new Set(this._filteredPendingList().map(it => it.article));
    for (const [article, sugs] of this.mpSuggestions) {
      if (!visible.has(article)) continue;
      for (const s of sugs) if (s.confidence === 'exact') this.mappingSelectedKeys.add(`${article}__${s.productId}`);
    }
    this.render();
  }

  bulkPickFirst(): void {
    const visible = new Set(this._filteredPendingList().map(it => it.article));
    for (const [article, sugs] of this.mpSuggestions) {
      if (!visible.has(article)) continue;
      if (sugs.length > 0) this.mappingSelectedKeys.add(`${article}__${sugs[0].productId}`);
    }
    this.render();
  }

  bulkDeselectUncertain(): void {
    const visible = new Set(this._filteredPendingList().map(it => it.article));
    for (const [article, sugs] of this.mpSuggestions) {
      if (!visible.has(article)) continue;
      for (const s of sugs) if (s.confidence === 'uncertain') this.mappingSelectedKeys.delete(`${article}__${s.productId}`);
    }
    this.render();
  }

  clearMappingSelection(): void {
    const visible = new Set(this._filteredPendingList().map(it => it.article));
    for (const article of visible) {
      for (const key of [...this.mappingSelectedKeys]) {
        if (key.startsWith(`${article}__`)) this.mappingSelectedKeys.delete(key);
      }
    }
    this.render();
  }

  loadMoreMappings(): void {
    this.mappingVisibleCount += 50;
    this.render();
  }

  loadMoreLinkedMappings(): void {
    this.mappingLinkedVisibleCount += 50;
    this.render();
  }

  _onPendingScroll(el: HTMLElement): void {
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 150) return;
    const list = this._getSortedFilteredPendingList();
    if (this.mappingVisibleCount >= list.length) return;

    const start = this.mappingVisibleCount;
    this.mappingVisibleCount += 50;
    const newItems = list.slice(start, this.mappingVisibleCount);

    // Remove the ↓ indicator before appending
    el.querySelector('.pm-pending-more')?.remove();

    const productsById = new Map(this.products.map(p => [p.id, p]));
    const producersById = new Map(this.producers.map(p => [p.id, p]));
    el.insertAdjacentHTML('beforeend', newItems.map(it => this.renderPendingRow(it, productsById, producersById)).join(''));

    if (list.length > this.mappingVisibleCount) {
      el.insertAdjacentHTML('beforeend', `<div class="pm-pending-more" style="padding:8px;text-align:center;color:var(--text-2);font-size:11px">↓</div>`);
    }
  }

  _onLinkedScroll(el: HTMLElement): void {
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 150) return;
    this._mappingLinkedScrollTop = el.scrollTop;
    this.mappingLinkedVisibleCount += 50;
    this.render();
    requestAnimationFrame(() => {
      const c = document.getElementById('pm-linked-list');
      if (c) c.scrollTop = this._mappingLinkedScrollTop;
    });
  }

  openMpArticlesImport(): void {
    const html = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden" id="mp-imp-tabs">
          <button data-tab="mp" onclick="window.producersModule._mpImpTab('mp')"
            style="flex:1;padding:8px 12px;border:none;background:var(--accent);color:#0a0a0a;cursor:pointer;font-size:12px">
            🏪 Из маркетплейсов
          </button>
          <button data-tab="file" onclick="window.producersModule._mpImpTab('file')"
            style="flex:1;padding:8px 12px;border:none;background:transparent;color:var(--text-1);cursor:pointer;font-size:12px;border-left:1px solid var(--line)">
            📄 xlsx / вставка
          </button>
        </div>

        <div id="mp-imp-panel-mp" style="display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-2)">
            Загружает артикулы из кэша подключённых магазинов WB, Ozon, Яндекс.Маркет.
            Данные обновляются при синхронизации каждого маркетплейса.
          </div>
          <div id="mp-stores-list" style="display:flex;flex-direction:column;gap:6px">
            <div style="color:var(--text-2);font-size:12px">Загрузка магазинов…</div>
          </div>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button onclick="window.producersModule._loadMpStores()"
              style="font-size:11px;padding:6px 12px;background:transparent;color:var(--text-1);border:1px solid var(--line);border-radius:5px;cursor:pointer">
              🔄 Обновить список
            </button>
            <button id="mp-load-selected" onclick="window.producersModule._loadFromSelectedStores()"
              style="font-size:11px;padding:6px 14px;background:var(--accent);color:#0a0a0a;border:none;border-radius:5px;cursor:pointer">
              Загрузить артикулы
            </button>
          </div>
        </div>

        <div id="mp-imp-panel-file" style="display:none;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--text-2)">
            Поддерживается xlsx (колонки <b>Артикул</b>, опц. <b>Название</b>)
            или текстовая вставка — по одному артикулу на строку.
          </div>
          <input type="file" accept=".xlsx,.xls" id="mp-imp-file"
            style="padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
          <div style="font-size:11px;color:var(--text-2)">— или —</div>
          <textarea id="mp-imp-paste" placeholder="Вставьте артикулы по одному на строку…" rows="5"
            style="padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-family:monospace;resize:vertical"></textarea>
        </div>

        <div id="mp-imp-status" style="font-size:11px;color:var(--text-2)">
          ${this.mpArticles.length > 0 ? `Уже в каталоге: ${this.mpArticles.length} артикулов` : ''}
        </div>
      </div>
    `;
    this.showModal('Артикулы маркетплейса', html, async () => {
      const filePanel = document.getElementById('mp-imp-panel-file');
      const isFilePanelVisible = filePanel && filePanel.style.display !== 'none';

      if (!isFilePanelVisible) {
        // MP panel — articles are loaded via button, modal can just close
        return true;
      }

      const f = (document.getElementById('mp-imp-file') as HTMLInputElement)?.files?.[0];
      const paste = (document.getElementById('mp-imp-paste') as HTMLTextAreaElement)?.value ?? '';
      let added: Array<{ article: string; name: string }> = [];
      if (f) {
        const buf = await f.arrayBuffer();
        const wb2 = XLSX.read(buf, { type: 'array' });
        const sheet = wb2.Sheets[wb2.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        added = rows.map(r => ({
          article: String(r['Артикул'] ?? r['article'] ?? r['SKU'] ?? Object.values(r)[0] ?? '').trim(),
          name: String(r['Название'] ?? r['Наименование'] ?? r['name'] ?? '').trim(),
        })).filter(x => x.article);
      } else if (paste.trim()) {
        added = paste.split('\n').map(line => ({ article: line.trim(), name: '' })).filter(x => x.article);
      }
      if (added.length === 0) { this.toast('Не найдено артикулов', 'error'); return false; }
      const existing = new Map(this.mpArticles.map(x => [x.article, x]));
      for (const x of added) existing.set(x.article, { ...existing.get(x.article), ...x });
      this.mpArticles = [...existing.values()];
      localStorage.setItem('prod_mp_articles', JSON.stringify(this.mpArticles));
      this.mpSuggestions = new Map();
      this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
      this.toast(`Загружено артикулов: ${added.length}`, 'success');
      this.render();
      return true;
    }, { saveText: 'Закрыть' });
    setTimeout(() => this._loadMpStores(), 80);
  }

  _mpImpTab(tab: 'mp' | 'file'): void {
    const mp = document.getElementById('mp-imp-panel-mp');
    const file = document.getElementById('mp-imp-panel-file');
    const tabs = document.querySelectorAll<HTMLButtonElement>('#mp-imp-tabs button');
    if (!mp || !file) return;
    mp.style.display = tab === 'mp' ? 'flex' : 'none';
    file.style.display = tab === 'file' ? 'flex' : 'none';
    tabs.forEach(b => {
      const isActive = b.dataset.tab === tab;
      b.style.background = isActive ? 'var(--accent)' : 'transparent';
      b.style.color = isActive ? '#fff' : 'var(--text-1)';
    });
  }

  async _loadMpStores(): Promise<void> {
    const list = document.getElementById('mp-stores-list');
    if (!list) return;
    list.innerHTML = `<div style="color:var(--text-2);font-size:12px">Загрузка…</div>`;
    try {
      const [ozonStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores(), wbDb.getStores(), yandexDb.getStores(),
      ]);
      const rows: string[] = [];
      for (const s of ozonStores) rows.push(`
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" data-mp="ozon" data-id="${s.id}" checked>
          <span style="font-size:10px;background:#005bff;color:#fff;padding:1px 6px;border-radius:10px">Ozon</span>
          ${esc(s.name ?? `Магазин ${s.client_id}`)}
        </label>`);
      for (const s of wbStores) rows.push(`
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" data-mp="wb" data-id="${s.id}" checked>
          <span style="font-size:10px;background:#7c3aed;color:#fff;padding:1px 6px;border-radius:10px">WB</span>
          ${esc(s.name ?? `Магазин ${s.id}`)}
        </label>`);
      for (const s of ymStores) rows.push(`
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" data-mp="ym" data-id="${s.id}" checked>
          <span style="font-size:10px;background:#f59e0b;color:#000;padding:1px 6px;border-radius:10px">ЯМ</span>
          ${esc(s.name ?? `Магазин ${s.id}`)}
        </label>`);
      list.innerHTML = rows.length > 0
        ? rows.join('')
        : `<div style="color:var(--text-2);font-size:12px">Нет подключённых магазинов. Добавьте их в разделах WB, Ozon, ЯМ.</div>`;
    } catch (e: any) {
      list.innerHTML = `<div style="color:#ef4444;font-size:12px">${esc(e?.message ?? 'Ошибка загрузки')}</div>`;
    }
  }

  async _loadFromSelectedStores(): Promise<void> {
    const btn = document.getElementById('mp-load-selected') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Загружаю…'; }
    try {
      const checkboxes = document.querySelectorAll<HTMLInputElement>('#mp-stores-list input[type=checkbox]:checked');
      const ozonIds = [...checkboxes].filter(c => c.dataset.mp === 'ozon').map(c => c.dataset.id!);
      const wbIds = [...checkboxes].filter(c => c.dataset.mp === 'wb').map(c => c.dataset.id!);
      const ymIds = [...checkboxes].filter(c => c.dataset.mp === 'ym').map(c => c.dataset.id!);

      if (ozonIds.length === 0 && wbIds.length === 0 && ymIds.length === 0) {
        this.toast('Выберите хотя бы один магазин', 'info'); return;
      }

      const added: Array<{ article: string; name: string }> = [];
      if (ozonIds.length > 0) {
        const prods = await ozonDb.getProducts();
        for (const p of prods) if (ozonIds.includes(p.store_id) && p.offer_id) added.push({ article: p.offer_id, name: p.name ?? '' });
      }
      if (wbIds.length > 0) {
        const prods = await wbDb.getProducts();
        for (const p of prods) if (wbIds.includes(p.store_id) && p.vendor_code) added.push({ article: p.vendor_code, name: p.title ?? '' });
      }
      if (ymIds.length > 0) {
        const prods = await yandexDb.getProducts();
        for (const p of prods) if (ymIds.includes(p.store_id) && p.offer_id) added.push({ article: p.offer_id, name: p.name ?? '' });
      }

      if (added.length === 0) {
        const status = document.getElementById('mp-imp-status');
        if (status) status.textContent = 'Нет товаров в выбранных магазинах. Сначала синхронизируйте данные в разделах маркетплейсов.';
        return;
      }

      const existing = new Map(this.mpArticles.map(x => [x.article, x]));
      for (const x of added) existing.set(x.article, { ...existing.get(x.article), ...x });
      this.mpArticles = [...existing.values()];
      localStorage.setItem('prod_mp_articles', JSON.stringify(this.mpArticles));
      this.mpSuggestions = new Map();
      this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
      this.toast(`Загружено ${added.length} артикулов`, 'success');
      document.getElementById('producers-modal')?.remove();
      this.render();
    } catch (e: any) {
      this.toast(e?.message ?? 'Ошибка загрузки', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Загрузить артикулы'; }
    }
  }

  /** Простая авто-связка: ищем товар, у которого артикул совпадает с артикулом МП,
   *  иначе ищем по подстроке в наименовании. */
  private _autoSuggestState: {
    pending: Array<{ article: string; name: string }>;
    sugMap: Map<string, Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain' | 'manual'; score: number }>>;
    idx: number;
    /** Токены товаров, вычисленные один раз до начала обхода. */
    productsCache: Array<{
      id: string;
      normName: string;
      normArticles: string[];
      toks: Set<string>;
      codes: Set<string>;
      colors: Set<string>;
      cats: Set<string>;
      producerNorm: string;
    }>;
    /** normArticle → productId для O(1) точного совпадения. */
    exactIndex: Map<string, string>;
  } | null = null;

  runAutoSuggest(): void {
    if (this.mpArticles.length === 0) { this.toast('Сначала импортируйте артикулы', 'info'); return; }
    if (this.autoSuggestLoading) return;
    this.autoSuggestLoading = true;
    this.render();

    // Учитываем активный фильтр по префиксу/поиску, но не по производителю
    // (подсказки ещё не вычислены, фильтр по производителю применяется после)
    const pending = this._filteredPendingList(false);

    // Предвычисляем токены всех товаров один раз — главная оптимизация скорости
    const productsCache = this.products.map(p => {
      const toks  = tokenize(p.name);
      const arts  = p.articles.filter(Boolean);
      const codes = extractCodes(arts.join(' ') + ' ' + p.name);
      return {
        id:           p.id,
        normName:     normName(p.name),
        normArticles: arts.map(a => normStr(a)),
        toks,
        codes,
        colors:       wordSetMatch(p.name, COLOR_WORDS_LIST),
        cats:         wordSetMatch(p.name, CATEGORY_WORDS_LIST),
        producerNorm: normStr(this.producers.find(pr => pr.id === p.producer_id)?.name ?? ''),
      };
    });

    // Инвертированный индекс: normArticle → productId для O(1) точных совпадений
    const exactIndex = new Map<string, string>();
    for (const p of productsCache) {
      for (const na of p.normArticles) {
        if (!exactIndex.has(na)) exactIndex.set(na, p.id);
      }
    }

    this._autoSuggestState = { pending, sugMap: new Map(), idx: 0, productsCache, exactIndex };
    // Yield to browser so spinner renders before the chunked loop starts
    setTimeout(() => this._runAutoSuggestChunk(), 20);
  }

  /** Обрабатывает пачку ожидающих артикулов и отдаёт управление браузеру между пачками.
   * Токены товаров предвычислены в runAutoSuggest() — повторных вычислений нет. */
  private _runAutoSuggestChunk(): void {
    const state = this._autoSuggestState;
    if (!state) return;
    const CHUNK = 100; // безопасно увеличить т.к. тяжёлые вычисления вынесены из цикла
    const end = Math.min(state.idx + CHUNK, state.pending.length);

    for (let i = state.idx; i < end; i++) {
      const item = state.pending[i];
      const matches: Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain'; score: number }> = [];
      const aN      = normStr(item.article);
      const iToks   = tokenize(item.name);
      const iCodes  = extractCodes(item.article + ' ' + item.name);
      const iColors = wordSetMatch(item.name, COLOR_WORDS_LIST);
      const iCats   = wordSetMatch(item.name, CATEGORY_WORDS_LIST);
      const iNorm   = normName(item.name);

      // Шаг 1: точное совпадение артикула через O(1) индекс
      const exactId = state.exactIndex.get(aN);
      if (exactId) matches.push({ productId: exactId, confidence: 'exact', score: 1 });

      // Шаг 1.5: MP-артикул содержит артикул производителя как подстроку
      // (например "олмеко_П00436284" содержит "п00436284" → exact)
      const subExactIds = new Set<string>();
      if (!exactId) {
        for (const p of state.productsCache) {
          for (const na of p.normArticles) {
            if (na.length >= 5 && aN.includes(na)) {
              matches.push({ productId: p.id, confidence: 'exact', score: 1 });
              subExactIds.add(p.id);
              break;
            }
            // Короткий артикул производителя (3–4 символа): должен быть отдельным сегментом
            // MP-артикула (разделитель _ - пробел), а не числовым суффиксом.
            // "росток_венеция1_171" → сегменты ['росток','венеция1','171'] → '171' есть ✓
            // "119286" → сегменты ['119286'] → '286' нет ✗ (ложное срабатывание)
            if (na.length >= 2 && na.length < 5 && aN.endsWith(na)) {
              const rawSegments = item.article.toLowerCase().split(/[_\-\s.]+/);
              const isSegment = rawSegments.includes(na) || rawSegments.some(s => normStr(s) === na);
              if (isSegment) {
                const hasNameTokens = iToks.size > 0 && p.toks.size > 0;
                const nameOverlap = hasNameTokens && (jaccard(iToks, p.toks) > 0 || setOverlaps(iColors, p.colors));
                // Проверка по производителю: первый сегмент MP-артикула должен
                // совпадать с именем производителя товара (ив_урбан_21 ≠ Росток).
                // Если первый сегмент короткий (<2) или производитель неизвестен — пропускаем проверку.
                const firstSeg = normStr(rawSegments[0] ?? '');
                const pNorm = p.producerNorm;
                const producerOk = firstSeg.length < 2 || !pNorm
                  || pNorm.includes(firstSeg) || firstSeg.includes(pNorm);
                const conf = (!hasNameTokens || nameOverlap) && producerOk ? 'exact' : 'model';
                matches.push({ productId: p.id, confidence: conf, score: conf === 'exact' ? 0.95 : 0.8 });
                subExactIds.add(p.id);
                break;
              }
            }
          }
        }
      }

      if (iNorm) {
        for (const p of state.productsCache) {
          if (p.id === exactId || subExactIds.has(p.id)) continue;

          // Точное совпадение названий → model (как в chairprod)
          if (p.normName === iNorm) {
            matches.push({ productId: p.id, confidence: 'model', score: 1 });
            continue;
          }

          // Артикул производителя содержит MP-артикул (обратная подстрока) → model
          const artRevMatch = p.normArticles.some(na => na.length >= 4 && na.includes(aN));
          if (artRevMatch) {
            matches.push({ productId: p.id, confidence: 'model', score: 0.9 });
            continue;
          }

          const codeMatch    = setOverlaps(iCodes, p.codes) ? 1 : 0;
          const tokenScore   = jaccard(iToks, p.toks);
          const colorScore   = jaccard(iColors, p.colors);
          const categoryMatch = setOverlaps(iCats, p.cats) ? 1 : 0;

          const score = tokenScore * 0.35 + codeMatch * 0.35 + colorScore * 0.15 + categoryMatch * 0.15;
          if (score >= 0.35) {
            matches.push({ productId: p.id, confidence: score >= 0.65 ? 'model' : 'uncertain', score });
          }
        }
      } else if (subExactIds.size === 0) {
        // Если названия нет и подстрока не нашла — фоллбек на код
        for (const p of state.productsCache) {
          if (p.id === exactId) continue;
          if (setOverlaps(iCodes, p.codes)) matches.push({ productId: p.id, confidence: 'uncertain', score: 0.4 });
        }
      }
      matches.sort((a, b) => b.score - a.score);
      state.sugMap.set(item.article, matches.slice(0, 5));
    }
    state.idx = end;

    if (state.idx < state.pending.length) {
      const btn = document.getElementById('auto-suggest-btn');
      if (btn) {
        btn.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0"></span> Подбираю… ${state.idx}/${state.pending.length}`;
      }
      setTimeout(() => this._runAutoSuggestChunk(), 0);
      return;
    }

    // Сохраняем вручную добавленные предложения (через «Найти вручную») — авто-связка их не должна стирать
    for (const [article, oldSugs] of this.mpSuggestions) {
      const newSugs = state.sugMap.get(article);
      if (!newSugs) continue;
      const manualOnes = oldSugs.filter(s => s.confidence === 'manual');
      if (manualOnes.length === 0) continue;
      const existingIds = new Set(newSugs.map(s => s.productId));
      const toAdd = manualOnes.filter(s => !existingIds.has(s.productId));
      if (toAdd.length > 0) state.sugMap.set(article, [...newSugs, ...toAdd]);
    }

    this.mpSuggestions = state.sugMap;
    this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
    for (const [art, sugs] of state.sugMap) {
      if (sugs[0]?.confidence === 'exact') this.mappingSelectedKeys.add(`${art}__${sugs[0].productId}`);
      for (const s of sugs) if (s.confidence === 'manual') this.mappingSelectedKeys.add(`${art}__${s.productId}`);
    }
    const found = [...state.sugMap.values()].filter(v => v.length > 0).length;
    this.autoSuggestLoading = false;
    this._autoSuggestState = null;
    this.toast(`Авто-связка: найдено вариантов для ${found} из ${state.pending.length}`, 'success');
    this.render();
  }

  async createMappingsBulk(): Promise<void> {
    const keys = [...this.mappingSelectedKeys];
    if (keys.length === 0 || this.mappingCreating) return;
    this.mappingCreating = true;
    this.render();
    try {
      let ok = 0;
      for (const k of keys) {
        // Safe split: productId is after the LAST '__' separator
        const sep = k.lastIndexOf('__');
        if (sep < 0) continue;
        const article = k.slice(0, sep);
        const pid = k.slice(sep + 2);
        const qty = this.mappingKeyQty.get(k) ?? 1;
        try {
          const existing = this.mappings.find(m => m.marketplace_article === article && m.producer_product_id === pid);
          if (existing) {
            await producerMappingDb.update(existing.id, { quantity: qty });
          } else {
            await producerMappingDb.create({ marketplace_article: article, producer_product_id: pid, quantity: qty });
          }
          this._syncCostFromMapping(article, pid);
          ok++;
        } catch {}
      }
      this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
      this.mappingKeyQty = new Map();
      await this.loadMappings();
      this.toast(`Создано связок: ${ok}`, 'success');
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
    finally {
      this.mappingCreating = false;
      this.render();
    }
  }

  /** Ручной подбор товара производителя для конкретного артикула МП. */
  openManualPick(article: string): void {
    const html = `
      <form id="manual-pick-form" style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">Подбор товара производителя для артикула:
          <code style="color:var(--text-1)">${esc(article)}</code></div>
        <input id="manual-pick-search" placeholder="🔍 Поиск по артикулу или названию"
          style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px"
          oninput="window.producersModule.filterManualPick(this.value)">
        <div id="manual-pick-list" style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:6px"></div>
      </form>
    `;
    this.showModal(`Ручной подбор для «${article}»`, html, null, { saveText: 'Закрыть', cancelText: '' });
    this.filterManualPick('');
    (window as any).__manualPickArticle = article;
  }

  filterManualPick(q: string): void {
    const list = document.getElementById('manual-pick-list');
    if (!list) return;
    const qn = q.toLowerCase();
    const matched = (qn ? this.products.filter(p =>
      p.name.toLowerCase().includes(qn) ||
      p.articles.some(a => a.toLowerCase().includes(qn))
    ) : this.products.slice(0, 50));
    list.innerHTML = matched.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text-2);font-size:12px">Ничего не найдено</div>` : matched.map(p => {
      const pr = this.producers.find(x => x.id === p.producer_id);
      return `
        <div onclick="window.producersModule.pickManual('${p.id}')" style="padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:10px;align-items:center">
          <code style="font-size:11px;color:var(--text-2)">${esc(p.articles[0]??'')}</code>
          <span style="flex:1;font-size:12px">${esc(p.name)}</span>
          <span style="font-size:10px;color:var(--text-2)">${esc(pr?.name??'')}</span>
        </div>
      `;
    }).join('');
  }

  async pickManual(productId: string): Promise<void> {
    const article = (window as any).__manualPickArticle;
    if (!article) return;
    try {
      await producerMappingDb.create({ marketplace_article: article, producer_product_id: productId, quantity: 1 });
      this._syncCostFromMapping(article, productId);
      await this.loadMappings();
      document.getElementById('producers-modal')?.remove();
      this.toast('Связка создана', 'success');
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // BULK EDIT — Excel-like grid for selected products
  // ════════════════════════════════════════════════════════════════════════

  private bulkEdits: Record<string, string> = {}; // `${pid}__${fieldKey}` → value

  openBulkEdit(): void {
    const ids = [...this.productSelected];
    if (ids.length === 0) return;
    const items = this.products.filter(p => ids.includes(p.id));
    this.bulkEdits = {};
    const cols: Array<{ key: string; label: string; type: string }> = [
      { key: 'name', label: 'Наименование', type: 'text' },
      ...this.fields.map(f => ({ key: f.id, label: f.name, type: f.field_type })),
    ];

    const root = document.createElement('div');
    root.id = 'producers-modal';
    root.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:20px';
    root.innerHTML = `
      <div style="background:var(--bg-1);border:1px solid var(--line);border-radius:14px;width:95vw;height:88vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:14px;font-weight:600">📊 Массовое редактирование</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">
              <span id="bulk-info">${items.length} позиций · 0 изменений</span>
            </div>
          </div>
          <button onclick="document.getElementById('producers-modal').remove()" style="background:none;border:none;color:var(--text-2);font-size:22px;cursor:pointer">×</button>
        </div>

        <div style="flex:1;overflow:auto" id="bulk-grid-wrap">
          <table id="bulk-grid" style="width:100%;font-size:12px;border-collapse:collapse">
            <thead style="position:sticky;top:0;z-index:5;background:var(--bg-2)">
              <tr>
                <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);width:160px;position:sticky;left:0;background:var(--bg-2);z-index:6">Артикул · Поставщик</th>
                ${cols.map(c => `
                  <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);min-width:200px">
                    <div style="font-size:10px;text-transform:uppercase;color:var(--text-2);font-weight:600;margin-bottom:4px">${esc(c.label)}</div>
                    <div style="display:flex;gap:4px">
                      <input id="mass-${c.key}" placeholder="заполнить колонку…" style="flex:1;padding:3px 7px;border:1px solid var(--line);border-radius:4px;background:var(--bg-1);color:var(--text-1);font-size:11px">
                      <button onclick="window.producersModule.bulkFillColumn('${c.key}','${c.type}')" style="padding:3px 8px;font-size:10px;background:var(--accent);color:#0a0a0a;border:none;border-radius:4px;cursor:pointer">OK</button>
                    </div>
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${items.map((p, ri) => {
                const pr = this.producers.find(x => x.id === p.producer_id);
                return `
                <tr style="background:${ri%2===0?'rgba(255,255,255,.02)':'transparent'};border-bottom:1px solid var(--line)">
                  <td style="padding:7px 10px;position:sticky;left:0;background:var(--bg-1);font-family:monospace;font-size:11px;border-right:1px solid var(--line)">
                    <div style="color:var(--text-1)">${esc(p.articles[0]??'—')}</div>
                    <div style="font-size:10px;color:var(--text-2);font-family:inherit">${esc(pr?.name??'')}</div>
                  </td>
                  ${cols.map(c => {
                    const v = c.key === 'name' ? p.name : (p.field_values?.[c.key] ?? '');
                    if (c.type === 'dropdown') {
                      const fld = this.fields.find(x => x.id === c.key);
                      const opts = fld?.dropdown_options ?? [];
                      return `<td style="padding:0;border-right:1px solid var(--line)">
                        <select onchange="window.producersModule.bulkSetCell('${p.id}','${c.key}',this.value)"
                          style="width:100%;background:transparent;border:none;padding:6px 8px;color:var(--text-1);font-size:12px;outline:none">
                          <option value="">—</option>
                          ${opts.map(o => `<option value="${esc(o)}" ${v===o?'selected':''}>${esc(o)}</option>`).join('')}
                        </select>
                      </td>`;
                    }
                    return `<td style="padding:0;border-right:1px solid var(--line)">
                      <input type="${c.type==='number'?'number':'text'}" value="${esc(String(v))}"
                        oninput="window.producersModule.bulkSetCell('${p.id}','${c.key}',this.value)"
                        style="width:100%;background:transparent;border:none;padding:6px 8px;color:var(--text-1);font-size:12px;outline:none">
                    </td>`;
                  }).join('')}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div style="padding:12px 20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:11px;color:var(--text-2)">💡 Используйте поля над колонками для массового заполнения. Изменённые ячейки помечаются.</div>
          <div style="display:flex;gap:8px">
            <button onclick="document.getElementById('producers-modal').remove()" class="btn" style="padding:7px 14px;font-size:12px">Отмена</button>
            <button id="bulk-save" onclick="window.producersModule.saveBulkEdit()" style="background:var(--accent);color:#0a0a0a;border:none;padding:7px 14px;border-radius:7px;font-size:12px;cursor:pointer">Сохранить</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
  }

  bulkSetCell(pid: string, key: string, value: string): void {
    this.bulkEdits[`${pid}__${key}`] = value;
    const cell = document.querySelector(`[data-cell="${pid}__${key}"]`);
    if (cell) (cell as HTMLElement).style.background = 'rgba(245,158,11,.15)';
    const cnt = Object.keys(this.bulkEdits).length;
    const info = document.getElementById('bulk-info');
    if (info) info.textContent = info.textContent!.replace(/\d+ изменений/, `${cnt} изменений`);
  }

  bulkFillColumn(key: string, type: string): void {
    const input = document.getElementById(`mass-${key}`) as HTMLInputElement;
    if (!input) return;
    const value = input.value;
    const ids = [...this.productSelected];
    for (const pid of ids) this.bulkEdits[`${pid}__${key}`] = value;
    // re-render row cells
    const root = document.getElementById('bulk-grid');
    if (root) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`tbody tr`).forEach(tr => {
        const cells = tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
        const colIdx = (key === 'name' ? 0 : this.fields.findIndex(f => f.id === key) + 1);
        const cell = cells[colIdx];
        if (cell) (cell as any).value = value;
      });
    }
    void type;
    const info = document.getElementById('bulk-info');
    if (info) info.textContent = `${ids.length} позиций · ${Object.keys(this.bulkEdits).length} изменений`;
  }

  async saveBulkEdit(): Promise<void> {
    const entries = Object.entries(this.bulkEdits);
    if (entries.length === 0) { document.getElementById('producers-modal')?.remove(); return; }
    const btn = document.getElementById('bulk-save') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняю…'; }
    try {
      const updates = new Map<string, { name?: string; field_values: Record<string, string> }>();
      for (const [k, v] of entries) {
        const [pid, key] = k.split('__');
        const u = updates.get(pid) ?? { field_values: {} };
        if (key === 'name') u.name = v;
        else u.field_values[key] = v;
        updates.set(pid, u);
      }
      for (const [pid, u] of updates) {
        const cur = this.products.find(p => p.id === pid);
        if (!cur) continue;
        const fv = { ...(cur.field_values ?? {}), ...u.field_values };
        const patch: any = { field_values: fv };
        if (u.name !== undefined) patch.name = u.name;
        await producerProductDb.update(pid, patch);
      }
      this.toast(`Сохранено: ${updates.size}`, 'success');
      this.bulkEdits = {};
      this.productSelected = new Set();
      await this.loadProducts();
      document.getElementById('producers-modal')?.remove();
      this.render();
    } catch (e: any) {
      this.toast(e?.message ?? 'Ошибка сохранения', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PENDING TAB — дополнительные кнопки массовых действий
  // ════════════════════════════════════════════════════════════════════════

  /** Для каждого артикула выбирает первое предложение независимо от уровня. */
  pickFirstAll(): void {
    for (const [article, sugs] of this.mpSuggestions) {
      if (sugs.length > 0) this.mappingSelectedKeys.add(`${article}__${sugs[0].productId}`);
    }
    this.render();
  }

  /** Снимает все выбранные с confidence === 'uncertain'. */
  unpickUncertain(): void {
    for (const key of [...this.mappingSelectedKeys]) {
      const [article, productId] = key.split('__');
      const sugs = this.mpSuggestions.get(article) ?? [];
      const sug = sugs.find(s => s.productId === productId);
      if (sug?.confidence === 'uncertain') this.mappingSelectedKeys.delete(key);
    }
    this.render();
  }

  /** Очищает все выбранные ключи маппинга. */
  clearMappingKeys(): void {
    this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
    this.render();
  }

  /** Устанавливает фильтр по конкретному префиксу производителя. */
  setMappingPrefixFilter(prefix: string): void {
    this.mappingPrefixFilter = prefix;
    this.mappingUnknownPrefixFilter = false;
    this.mappingVisibleCount = 50;
    this.mappingLinkedVisibleCount = 50;
    this.render();
  }

  /** Переключает фильтр «Не опознанные». */
  toggleMappingUnknownPrefix(): void {
    this.mappingUnknownPrefixFilter = !this.mappingUnknownPrefixFilter;
    if (this.mappingUnknownPrefixFilter) this.mappingPrefixFilter = '';
    this.mappingPage = 0;
    this.mappingVisibleCount = 50;
    this.mappingLinkedVisibleCount = 50;
    this.render();
  }

  /** Показать следующую страницу pending. */
  showMoreMapping(): void {
    this.mappingPage++;
    this.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  // LINKED TAB — массовые действия, редактирование
  // ════════════════════════════════════════════════════════════════════════

  toggleLinkedSel(article: string): void {
    if (this.linkedSelected.has(article)) this.linkedSelected.delete(article);
    else this.linkedSelected.add(article);
    this.render();
  }

  selectAllLinked(): void {
    const q = this.mappingSearch.toLowerCase();
    let list = this.mappings;
    if (q) list = list.filter(m => m.marketplace_article.toLowerCase().includes(q) ||
      this.products.find(p => p.id === m.producer_product_id)?.name.toLowerCase().includes(q));
    for (const m of list) this.linkedSelected.add(m.marketplace_article);
    this.render();
  }

  clearLinkedSel(): void {
    this.linkedSelected = new Set();
    this.render();
  }

  async bulkDeleteLinkedMappings(): Promise<void> {
    if (this.linkedSelected.size === 0) return;
    if (!confirm(`Удалить связки для ${this.linkedSelected.size} артикул(ов)?`)) return;
    const toDelete = this.mappings.filter(m => this.linkedSelected.has(m.marketplace_article));
    const progress = this.showProgressOverlay('Удаление связок…');
    const CHUNK = 200;
    let processedUpTo = 0, stopped = false;
    try {
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        if (progress.cancelled()) { stopped = true; break; }
        const chunk = toDelete.slice(i, i + CHUNK);
        await producerMappingDb.bulkRemove(chunk.map(m => m.id));
        processedUpTo = i + chunk.length;
        progress.update(processedUpTo, toDelete.length);
      }
      this.linkedSelected = new Set();
      await this.loadMappings();
      this.toast(stopped ? `Остановлено: удалено ${processedUpTo} из ${toDelete.length}` : `Удалено связок: ${toDelete.length}`, stopped ? 'info' : 'success');
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
    finally { progress.close(); }
  }

  async bulkDeleteLinkedFromCatalog(): Promise<void> {
    if (this.linkedSelected.size === 0) return;
    if (!confirm(`Удалить связки и убрать ${this.linkedSelected.size} артикул(ов) из каталога?`)) return;
    const toDelete = this.mappings.filter(m => this.linkedSelected.has(m.marketplace_article));
    const progress = this.showProgressOverlay('Удаление связок…');
    const CHUNK = 200;
    let processedUpTo = 0, stopped = false;
    try {
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        if (progress.cancelled()) { stopped = true; break; }
        const chunk = toDelete.slice(i, i + CHUNK);
        await producerMappingDb.bulkRemove(chunk.map(m => m.id));
        processedUpTo = i + chunk.length;
        progress.update(processedUpTo, toDelete.length);
      }
      // Из каталога МП убираем только те артикулы, у которых ВСЕ связки уже удалены —
      // чтобы при остановке на середине не потерять артикул с недоудалёнными связками
      const remainingArticles = new Set(toDelete.slice(processedUpTo).map(m => m.marketplace_article));
      const safeToRemove = new Set(toDelete.slice(0, processedUpTo).map(m => m.marketplace_article).filter(a => !remainingArticles.has(a)));
      this.mpArticles = this.mpArticles.filter(a => !safeToRemove.has(a.article));
      localStorage.setItem('prod_mp_articles', JSON.stringify(this.mpArticles));
      this.linkedSelected = new Set();
      await this.loadMappings();
      this.toast(stopped ? `Остановлено: обработано ${processedUpTo} из ${toDelete.length}` : 'Удалено из каталога', stopped ? 'info' : 'success');
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
    finally { progress.close(); }
  }

  openMappingEditModal(article: string): void {
    const currentMappings = this.mappings.filter(m => m.marketplace_article === article);
    const productOptions = this.products.map(p => {
      const pr = this.producers.find(x => x.id === p.producer_id);
      return `<option value="${p.id}">[${esc(pr?.name ?? '')}] ${esc(p.articles[0] ?? '')} — ${esc(p.name)}</option>`;
    }).join('');

    const html = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:11px;color:var(--text-2)">Текущие компоненты:</div>
        <div id="mapping-edit-list" style="display:flex;flex-direction:column;gap:6px">
          ${currentMappings.length === 0
            ? `<div style="font-size:11px;color:var(--text-2);padding:8px">Нет компонентов</div>`
            : currentMappings.map(m => {
              const pp = this.products.find(p => p.id === m.producer_product_id);
              return `
                <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2)">
                  <code style="font-size:11px;color:var(--text-2)">${esc(pp?.articles[0] ?? '')}</code>
                  <span style="flex:1;font-size:12px">${esc(pp?.name ?? '—')}</span>
                  <span style="font-size:11px;color:var(--text-2)">×${m.quantity}</span>
                  <button onclick="window.producersModule._deleteMappingFromEdit('${m.id}','${esc(article)}')"
                    style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0 4px">×</button>
                </div>
              `;
            }).join('')}
        </div>
        <div style="border-top:1px solid var(--line);padding-top:10px">
          <div style="font-size:11px;color:var(--text-2);margin-bottom:8px">Добавить компонент:</div>
          <div style="display:grid;grid-template-columns:1fr 90px auto;gap:6px;align-items:center">
            <select id="mapping-edit-product" style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
              ${productOptions}
            </select>
            <input id="mapping-edit-qty" type="number" min="1" step="1" value="1"
              style="padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
            <button onclick="window.producersModule._addMappingFromEdit('${esc(article)}')"
              style="padding:6px 12px;background:var(--accent);color:#0a0a0a;border:none;border-radius:5px;font-size:12px;cursor:pointer">+ Добавить</button>
          </div>
        </div>
      </div>
    `;
    this.showModal(`Связка для «${article}»`, html, null, { saveText: 'Закрыть', cancelText: '' });
  }

  async _deleteMappingFromEdit(mappingId: string, article: string): Promise<void> {
    try {
      await producerMappingDb.remove(mappingId);
      await this.loadMappings();
      this.toast('Удалено', 'success');
      this.openMappingEditModal(article);
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  async _addMappingFromEdit(article: string): Promise<void> {
    const productId = (document.getElementById('mapping-edit-product') as HTMLSelectElement)?.value;
    const qty = Number((document.getElementById('mapping-edit-qty') as HTMLInputElement)?.value) || 1;
    if (!productId) { this.toast('Выберите товар', 'error'); return; }
    try {
      await producerMappingDb.create({ marketplace_article: article, producer_product_id: productId, quantity: qty });
      await this.loadMappings();
      this.toast('Добавлено', 'success');
      this.openMappingEditModal(article);
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // CONSIGNMENT — статусная машина заказов
  // ════════════════════════════════════════════════════════════════════════

  async updateOrderStatus(id: string, status: string): Promise<void> {
    try {
      await producerOrderDb.updateStatus([id], status as ProducerOrder['status']);
      await this.loadOrders();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  async bulkUpdateOrderStatus(status: string): Promise<void> {
    const ids = [...this.orderSelected];
    if (ids.length === 0) return;
    try {
      await producerOrderDb.updateStatus(ids, status as ProducerOrder['status']);
      await this.loadOrders();
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
  }

  private _renderImportProgress(): string {
    const p = this._importProgress!;
    const pct = p.total > 0 ? Math.round(p.done / p.total * 100) : 0;
    return `
      <div style="padding:10px 14px;border-radius:8px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.25);display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;font-weight:500;color:var(--text-1)">
            <span style="display:inline-block;width:10px;height:10px;border:2px solid rgba(129,140,248,.3);border-top-color:#818cf8;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px"></span>
            Загружаю заказы из маркетплейсов…
          </span>
          <span style="font-size:11px;color:var(--text-2)">${p.done}/${p.total}${p.errors > 0 ? ` · <span style="color:#f87171">⚠ ${p.errors} ошибок</span>` : ''}</span>
        </div>
        <div style="height:4px;border-radius:2px;background:rgba(255,255,255,.07)">
          <div style="height:100%;border-radius:2px;background:#818cf8;width:${pct}%;transition:width .15s"></div>
        </div>
        ${p.currentLabel ? `<div style="font-size:10px;color:var(--text-2)">${esc(p.currentLabel)}</div>` : ''}
      </div>
    `;
  }

  /**
   * Импортирует FBS/DBS заказы из WB/Ozon/ЯМ за последние 30 дней.
   * Метаданные (магазин, схема, статус МП) сохраняются в поле notes как JSON.
   * FBO (Ozon) и FBY (Яндекс) не импортируются — они не требуют участия продавца в отгрузке.
   */
  async importOrdersFromMp(): Promise<void> {
    this._importProgress = { done: 0, total: 1, currentLabel: 'Подготовка…', errors: 0 };
    this.render();
    try {
      // Загружаем список магазинов для определения схем и названий
      const [ozStores, wbStores, ymStores] = await Promise.all([
        ozonDb.getStores().catch(() => [] as any[]),
        wbDb.getStores().catch(() => [] as any[]),
        yandexDb.getStores().catch(() => [] as any[]),
      ]);

      const ozStoreMap = new Map(ozStores.map((s: any) => [s.id, s]));
      const wbStoreMap = new Map(wbStores.map((s: any) => [s.id, s]));
      const ymStoreMap = new Map(ymStores.map((s: any) => [s.id, s]));

      const end   = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const { ozonPostings, yandexOrders, wbOrders } = await orderSyncService.queryOrders(
        null, start, end, undefined,
        (p) => {
          this._importProgress = { done: p.done, total: p.total, currentLabel: p.currentLabel, errors: p.errors };
          const el = document.getElementById('consignment-import-progress');
          if (el) el.innerHTML = this._renderImportProgress();
        },
      );

      const existingExtIds = new Set(this.orders.map(o => o.external_id).filter(Boolean));
      const toCreate: Array<Omit<ProducerOrder, 'id' | 'company_id' | 'created_at' | 'updated_at'>> = [];

      // ── Ozon: только FBS и RFBS/DBS (не FBO) ────────────────────────────
      for (const posting of ozonPostings) {
        const scheme = posting.delivery_scheme;
        if (scheme === 'fbo') continue; // FBO — Ozon сам отгружает, нам не нужно

        const schemeLabel = scheme === 'rfbs' ? 'DBS' : 'FBS';
        const store = ozStoreMap.get(posting.store_id);
        const storeName = (store as any)?.name ?? 'Ozon';

        const internalStatus = ((): ProducerOrder['status'] => {
          if (posting.status === 'cancelled' || posting.status === 'not_accepted') return 'cancelled';
          if (posting.status === 'delivered') return 'done';
          if (posting.status === 'awaiting_packaging') return 'new';
          return 'accepted'; // awaiting_deliver, delivering, sent_by_seller
        })();

        for (const prod of posting.products) {
          const extId = `ozon_${posting.posting_number}_${prod.offer_id}`;
          if (existingExtIds.has(extId)) continue;
          toCreate.push({
            external_id:         extId,
            marketplace_article: prod.offer_id,
            product_name:        prod.name,
            quantity:            prod.quantity,
            status:              internalStatus,
            source:              'ozon',
            notes:               encodeOrderMeta({ sn: storeName, si: posting.store_id, sc: schemeLabel, ms: posting.status, on: posting.posting_number }),
          });
        }
      }

      // ── WB: все заказы FBS (WB забирает у продавца) ─────────────────────
      for (const order of wbOrders) {
        const store = wbStoreMap.get(order.store_id);
        const storeName = (store as any)?.name ?? 'WB';
        const mpStatus = String(order.status ?? 'new');

        const internalStatus = ((): ProducerOrder['status'] => {
          if (mpStatus === 'cancel' || mpStatus === 'cancel_client') return 'cancelled';
          if (mpStatus === 'complete') return 'accepted'; // уже у WB, в доставке
          if (mpStatus === 'new') return 'new';
          return 'accepted'; // confirm = на сборке
        })();

        for (const item of order.items) {
          const extId = `wb_${order.id}_${item.vendor_code}`;
          if (existingExtIds.has(extId)) continue;
          toCreate.push({
            external_id:         extId,
            marketplace_article: item.vendor_code,
            product_name:        item.name ?? '',
            quantity:            item.count,
            status:              internalStatus,
            source:              'wb',
            notes:               encodeOrderMeta({ sn: storeName, si: order.store_id, sc: 'FBS', ms: mpStatus, on: String(order.id) }),
          });
        }
      }

      // ── Yandex: только FBS и DBS (не FBY) ────────────────────────────────
      for (const order of yandexOrders) {
        const store = ymStoreMap.get(order.store_id);
        const placementType = (store as any)?.placement_type ?? 'FBS';
        if (placementType === 'FBY') continue; // FBY — ЯМ сам отгружает

        const schemeLabel = placementType === 'DBS' ? 'DBS' : 'FBS';
        const storeName = (store as any)?.name ?? 'ЯМ';
        const mpStatus = String(order.status ?? 'PROCESSING');

        const internalStatus = ((): ProducerOrder['status'] => {
          if (mpStatus === 'CANCELLED' || mpStatus === 'RETURNED' || mpStatus === 'PARTIALLY_RETURNED') return 'cancelled';
          if (mpStatus === 'DELIVERED' || mpStatus === 'PARTIALLY_DELIVERED') return 'done';
          if (mpStatus === 'PROCESSING') return 'new';
          return 'accepted'; // DELIVERY, PICKUP
        })();

        for (const item of order.items) {
          const extId = `ym_${order.id}_${item.offer_id}`;
          if (existingExtIds.has(extId)) continue;
          toCreate.push({
            external_id:         extId,
            marketplace_article: item.offer_id,
            product_name:        item.name ?? '',
            quantity:            item.count,
            status:              internalStatus,
            source:              'ym',
            notes:               encodeOrderMeta({ sn: storeName, si: order.store_id, sc: schemeLabel, ms: mpStatus, on: String(order.id) }),
          });
        }
      }

      const errors = this._importProgress?.errors ?? 0;
      this._importProgress = null;

      if (toCreate.length === 0) {
        await this.loadOrders();
        this.render();
        const msg = errors > 0
          ? `Новых заказов нет. Ошибок: ${errors} (проверьте токены МП)`
          : 'Новых заказов нет — всё актуально';
        this.toast(msg, errors > 0 ? 'error' : 'info');
        return;
      }

      await producerOrderDb.createBulk(toCreate);
      await this.loadOrders();
      this.render();
      const ozonCnt = toCreate.filter(o => o.source === 'ozon').length;
      const wbCnt   = toCreate.filter(o => o.source === 'wb').length;
      const ymCnt   = toCreate.filter(o => o.source === 'ym').length;
      const parts   = [ozonCnt && `Ozon: ${ozonCnt}`, wbCnt && `WB: ${wbCnt}`, ymCnt && `ЯМ: ${ymCnt}`].filter(Boolean);
      this.toast(`Загружено ${toCreate.length} заказов (${parts.join(', ')})${errors > 0 ? ` · ⚠ ошибок: ${errors}` : ''}`, 'success');
    } catch (e: any) {
      this._importProgress = null;
      this.render();
      this.toast(e?.message ?? 'Ошибка загрузки заказов из МП', 'error');
    }
  }

  toggleConsignmentOnlyMapped(): void {
    this.consignmentOnlyMapped = !this.consignmentOnlyMapped;
    this.render();
  }

  setConsignmentStatusTab(v: InternalStage): void {
    this.consignmentStatusTab = v;
    this.consignmentVisibleCount = 100;
    this.render();
  }

  showMoreOrders(): void {
    this.consignmentVisibleCount += 100;
    this.render();
  }

  async moveOrderInternal(id: string, stage: string): Promise<void> {
    const order = this.orders.find(o => o.id === id);
    if (!order) return;
    const meta = parseOrderMeta(order.notes);
    meta.is = (stage as InternalStage) || undefined;
    const notes = encodeOrderMeta(meta);
    order.notes = notes;
    this.render();
    await producerOrderDb.updateNotes(id, notes);
  }

  openAddToStageModal(): void {
    const n = this.orderSelected.size;
    if (n === 0) return;
    const html = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="font-size:13px;color:var(--text-2)">Выбрано заказов: <b style="color:var(--text-1)">${n}</b></div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:4px">Переместить в статус:</div>
        <div style="display:flex;flex-direction:column;gap:6px" id="stage-options">
          ${[
            { v: 'processing', label: 'В обработке', bg: 'rgba(59,130,246,.15)', color: '#93c5fd' },
            { v: 'delivery',   label: 'В доставке',   bg: 'rgba(74,222,128,.15)', color: '#4ade80' },
            { v: 'problem',    label: 'Проблемы',      bg: 'rgba(239,68,68,.15)',  color: '#f87171' },
            { v: '',           label: 'Новые',          bg: 'var(--bg-2)',          color: 'var(--text-2)' },
          ].map(s => `
            <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);cursor:pointer;background:${s.bg}">
              <input type="radio" name="stage" value="${s.v}" ${s.v === 'processing' ? 'checked' : ''}>
              <span style="font-size:12px;font-weight:500;color:${s.color}">${s.label}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
    this.showModal('Добавить', html, async () => {
      const checked = document.querySelector<HTMLInputElement>('#stage-options input[type=radio]:checked');
      const stage = (checked?.value ?? 'processing') as InternalStage;
      const ids = [...this.orderSelected];
      for (const id of ids) {
        const order = this.orders.find(o => o.id === id);
        if (!order) continue;
        const meta = parseOrderMeta(order.notes);
        meta.is = stage || undefined;
        const notes = encodeOrderMeta(meta);
        order.notes = notes;
        await producerOrderDb.updateNotes(id, notes);
      }
      this.orderSelected = new Set();
      this.render();
      this.toast(`Перемещено ${ids.length} заказов`, 'success');
      return true;
    });
  }

  setConsignmentSearch(v: string): void {
    this.consignmentSearch = v;
    this._patchConsignmentTbody();
  }

  setConsignmentSourceFilter(v: string): void {
    this.consignmentSourceFilter = v;
    this.consignmentStoreFilter = ''; // сброс стор-фильтра при смене маркетплейса
    this.render();
  }

  setConsignmentStoreFilter(v: string): void {
    this.consignmentStoreFilter = v;
    // Синхронизируем source-фильтр с маркетплейсом выбранного магазина
    if (v) {
      const order = this.orders.find(o => parseOrderMeta(o.notes).si === v);
      this.consignmentSourceFilter = order?.source ?? '';
    }
    this.render();
  }

  private _patchConsignmentTbody(): void {
    this.render();
  }

  private filteredOrders(): ProducerOrder[] {
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const getIs = (o: ProducerOrder): InternalStage => (parseOrderMeta(o.notes).is ?? '') as InternalStage;
    // Показываем только активные (не доставлены и не отменены с МП стороны)
    let list = this.orders.filter(o => o.status !== 'cancelled' && o.status !== 'done');
    // Фильтр по внутреннему этапу
    list = list.filter(o => getIs(o) === this.consignmentStatusTab);
    if (this.consignmentStoreFilter) {
      list = list.filter(o => parseOrderMeta(o.notes).si === this.consignmentStoreFilter);
    } else if (this.consignmentSourceFilter) {
      list = list.filter(o => (o.source ?? 'manual') === this.consignmentSourceFilter);
    }
    if (this.consignmentOnlyMapped) {
      list = list.filter(o => mappedSet.has(o.marketplace_article));
    }
    const q = this.consignmentSearch.toLowerCase().trim();
    if (q) {
      list = list.filter(o => {
        const on = parseOrderMeta(o.notes).on ?? '';
        return o.marketplace_article.toLowerCase().includes(q) ||
          o.product_name.toLowerCase().includes(q) ||
          (o.external_id ?? '').toLowerCase().includes(q) ||
          on.toLowerCase().includes(q);
      });
    }
    return list;
  }

  // ════════════════════════════════════════════════════════════════════════
  // MP ARTICLES — очистка каталога
  // ════════════════════════════════════════════════════════════════════════

  clearMpArticles(): void {
    if (!confirm('Очистить каталог артикулов МП?')) return;
    this.mpArticles = [];
    this.mpSuggestions = new Map();
    this.mappingSelectedKeys = new Set(); this.mappingKeyQty = new Map();
    this.mappingPage = 0;
    localStorage.removeItem('prod_mp_articles');
    this.toast('Каталог очищен', 'success');
    this.render();
  }

  // ════════════════════════════════════════════════════════════════════════
  // SMART IMPORT — 3-шаговый мастер импорта товаров
  // ════════════════════════════════════════════════════════════════════════

  private readonly SMART_FIELD_ALIASES: Record<string, string[]> = {
    producer: ['поставщик', 'производитель', 'supplier', 'producer', 'vendor'],
    article:  ['артикул', 'артикул 1', 'sku', 'article', 'artikul', 'код'],
    name:     ['наименование', 'название', 'name', 'товар', 'product'],
    cost:     ['себестоимость', 'цена закупки', 'закупочная цена', 'cost', 'purchase price'],
  };

  // Нормализует заголовок/название поля для сопоставления: убирает регистр, ё→е,
  // схлопывает повторные пробелы/дефисы, чтобы "Кол-во упаковок" == "кол - во  упаковок".
  private _normalizeHeader(s: string): string {
    return s.trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s-]+/g, ' ');
  }

  openSmartImport(): void {
    this.smartImportStep = 0;
    this.smartImportFile = null;
    this.smartImportMapping = {};
    this.smartImportPreview = { toCreate: [], toUpdate: [], skip: 0 };
    this.smartImportProducerId = this.producers[0]?.id ?? '';
    this.smartMatchMode = 'both';
    (window as any).__smartImportHeaders = undefined;
    (window as any).__smartImportRows = undefined;
    this.smartUnmappedAction = {};
    this._renderSmartImportModal();
  }

  private _renderSmartImportModal(): void {
    const existing = document.getElementById('producers-modal');

    const steps = ['Выбор файла', 'Предпросмотр', 'Готово'];
    const stepBar = steps.map((s, i) => `
      <div style="display:flex;align-items:center;gap:6px;${i <= this.smartImportStep ? 'color:var(--accent)' : 'color:var(--text-2)'}">
        <div style="width:22px;height:22px;border-radius:50%;border:2px solid ${i <= this.smartImportStep ? 'var(--accent)' : 'var(--line)'};
          display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;
          background:${i === this.smartImportStep ? 'var(--accent)' : 'transparent'};
          color:${i === this.smartImportStep ? '#fff' : 'inherit'}">${i + 1}</div>
        <span style="font-size:11px">${s}</span>
        ${i < steps.length - 1 ? '<div style="width:30px;height:1px;background:var(--line)"></div>' : ''}
      </div>
    `).join('');

    let body = '';
    if (this.smartImportStep === 0) body = this._smartImportStep0Html();
    else if (this.smartImportStep === 1) body = this._smartImportStep1Html();
    else body = this._smartImportStep2Html();

    // Если модал уже открыт — обновляем только содержимое, не пересоздаём DOM
    if (existing) {
      const stepBarEl = existing.querySelector('#smart-import-stepbar');
      if (stepBarEl) stepBarEl.innerHTML = stepBar;
      const bodyEl = existing.querySelector('#smart-import-body');
      if (bodyEl) { bodyEl.innerHTML = body; return; }
      existing.remove();
    }

    const root = document.createElement('div');
    root.id = 'producers-modal';
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    root.onclick = (e) => { if (e.target === root) root.remove(); };
    root.innerHTML = `
      <div style="background:var(--bg-1);border:1px solid var(--line);border-radius:12px;max-width:700px;width:100%;max-height:90vh;overflow:auto;display:flex;flex-direction:column">
        <div style="padding:14px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3 style="margin:0;font-size:14px;font-weight:600">Импорт товаров</h3>
            <div id="smart-import-stepbar" style="display:flex;gap:8px;align-items:center;margin-top:8px">${stepBar}</div>
          </div>
          <button onclick="document.getElementById('producers-modal').remove()"
            style="background:none;border:none;color:var(--text-2);font-size:22px;cursor:pointer;line-height:1">×</button>
        </div>
        <div id="smart-import-body" style="padding:16px 18px;flex:1;overflow:auto">${body}</div>
      </div>
    `;
    document.body.appendChild(root);
  }

  private _smartImportStep0Html(): string {
    const headers = (window as any).__smartImportHeaders as string[] | undefined;

    const makeSelect = (fieldKey: string, label: string, required = false) => {
      if (!headers) return '';
      const alias = this.SMART_FIELD_ALIASES[fieldKey] ?? [];
      const autoIdx = headers.findIndex(h => alias.some(a => h.toLowerCase().includes(a)));
      const current = this.smartImportMapping[fieldKey] ?? (autoIdx >= 0 ? headers[autoIdx] : '');
      return `
        <tr>
          <td style="padding:6px 10px;font-size:12px;color:var(--text-1)">${label}${required ? ' *' : ''}</td>
          <td style="padding:6px 10px">
            <select onchange="window.producersModule._smartSetMapping('${fieldKey}', this.value)"
              style="width:100%;padding:5px 8px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1);font-size:12px">
              <option value="">— Не использовать —</option>
              ${headers.map(h => `<option value="${esc(h)}" ${current === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
            </select>
          </td>
        </tr>
      `;
    };

    const fieldRows = this.fields.filter(f => !f.is_locked).map(f => makeSelect(`field_${f.id}`, f.name)).join('');

    const producerBlock = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="font-size:11px;color:var(--text-2)">Поставщик по умолчанию</div>
        <div style="display:flex;gap:8px;align-items:center">
          ${this.producers.length > 0 ? `
            <select onchange="window.producersModule._smartSetProducer(this.value)"
              style="flex:1;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
              ${this.producers.map(p => `<option value="${p.id}" ${p.id === this.smartImportProducerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          ` : `
            <div style="flex:1;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-2);font-size:12px">
              Нет поставщиков — создайте нового →
            </div>
          `}
          <button onclick="window.producersModule._smartOpenProducerForm()"
            style="padding:7px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px;cursor:pointer;white-space:nowrap">
            + Создать нового
          </button>
        </div>
        <div style="font-size:10px;color:var(--text-2)">Используется если в файле нет колонки «Поставщик»</div>
      </div>
    `;

    const noProducers = this.producers.length === 0;

    return `
      <div style="display:flex;flex-direction:column;gap:14px">
        <input type="file" id="smart-import-file" accept=".xlsx,.xls" style="display:none"
          onchange="window.producersModule._smartFileChange(this)">
        <div style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--text-2)">
          Файл Excel (.xlsx)
          ${noProducers ? `
            <div style="border:2px dashed var(--line);border-radius:8px;padding:24px;text-align:center;opacity:.45;cursor:not-allowed">
              <div style="font-size:24px;margin-bottom:6px">🔒</div>
              <div style="font-size:12px;color:var(--text-2)">Сначала создайте поставщика</div>
            </div>
          ` : `
            <div id="smart-drop-zone" style="border:2px dashed var(--line);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s"
              onclick="document.getElementById('smart-import-file').click()"
              ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
              ondragleave="this.style.borderColor='var(--line)'"
              ondrop="event.preventDefault();window.producersModule._smartDropFile(event)">
              <div style="font-size:24px;margin-bottom:6px">📂</div>
              <div style="font-size:12px;color:var(--text-1)">${this.smartImportFile ? esc(this.smartImportFile.name) : 'Перетащите файл или нажмите для выбора'}</div>
            </div>
          `}
        </div>

        ${producerBlock}

        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="font-size:11px;color:var(--text-2)">Искать совпадение по</div>
          <div style="display:flex;gap:6px">
            ${([
              ['article', 'Артикулу'],
              ['name', 'Названию'],
              ['both', 'Артикулу и названию'],
            ] as const).map(([mode, label]) => `
              <button onclick="window.producersModule._smartSetMatchMode('${mode}')"
                style="flex:1;padding:7px 10px;border:1px solid ${this.smartMatchMode === mode ? 'var(--accent)' : 'var(--line)'};
                  border-radius:6px;background:${this.smartMatchMode === mode ? 'var(--accent)' : 'var(--bg-2)'};
                  color:${this.smartMatchMode === mode ? '#0a0a0a' : 'var(--text-1)'};font-size:12px;cursor:pointer;font-weight:${this.smartMatchMode === mode ? '600' : '400'}">
                ${label}
              </button>
            `).join('')}
          </div>
          <div style="font-size:10px;color:var(--text-2)">«Артикулу и названию» — сначала ищет по артикулу, если не нашёл — по названию</div>
        </div>

        ${headers && headers.length > 0 ? (() => {
          // Вычисляем незадействованные колонки
          const mappedCols = new Set(Object.values(this.smartImportMapping).filter(Boolean));
          const unmappedCols = headers.filter(h => h && !mappedCols.has(h));
          return `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Маппинг колонок</div>
            <table style="width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:6px;overflow:hidden">
              <thead style="background:var(--bg-2)">
                <tr>
                  <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:var(--text-2);border-bottom:1px solid var(--line)">Поле в системе</th>
                  <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:var(--text-2);border-bottom:1px solid var(--line)">Колонка в Excel</th>
                </tr>
              </thead>
              <tbody>
                ${makeSelect('producer', 'Производитель')}
                ${makeSelect('article', 'Артикул 1', true)}
                ${makeSelect('name', 'Наименование', true)}
                ${makeSelect('cost', 'Себестоимость')}
                ${fieldRows}
              </tbody>
            </table>
          </div>

          <div id="smart-unmapped-section">${unmappedCols.length > 0 ? this._smartUnmappedHtml(unmappedCols) : ''}</div>

          <div style="display:flex;justify-content:flex-end">
            <button id="smart-analyze-btn" onclick="window.producersModule._smartAnalyze()"
              ${noProducers ? 'disabled' : ''}
              style="background:var(--accent);color:#0a0a0a;border:none;padding:8px 18px;border-radius:7px;font-size:13px;cursor:pointer;font-weight:500;display:inline-flex;align-items:center;gap:6px;${noProducers ? 'opacity:.4;cursor:not-allowed' : ''}">
              Анализировать →
            </button>
          </div>
          `;
        })() : ''}
      </div>
    `;
  }

  _smartOpenProducerForm(): void {
    this.openProducerForm(undefined, () => {
      // После сохранения — выбираем только что созданного и возвращаемся в импорт
      this.smartImportProducerId = this.producers[this.producers.length - 1]?.id ?? '';
      this._renderSmartImportModal();
    });
  }

  private _smartImportStep1Html(): string {
    const { toCreate, toUpdate, skip, skipNoName = 0, ambiguous = 0 } = this.smartImportPreview;
    const total = toCreate.length + toUpdate.length + skip + ambiguous;
    const skipReasons = [
      skipNoName > 0 ? `${skipNoName} без наименования` : '',
      (skip - skipNoName) > 0 ? `${skip - skipNoName} без изменений` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:repeat(${ambiguous > 0 ? 5 : 4},1fr);gap:10px">
          ${[
            ['Новых', toCreate.length, '#4ade80'],
            ['Обновить', toUpdate.length, '#fbbf24'],
            ['Пропущено', skip, 'var(--text-2)'],
            ...(ambiguous > 0 ? [['Неоднозначно', ambiguous, '#f87171']] as const : []),
            ['Всего', total, 'var(--accent)'],
          ].map(([label, count, color]) => `
            <div style="border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center;background:var(--bg-2)">
              <div style="font-size:22px;font-weight:700;color:${color}">${count}</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:2px">${label}</div>
            </div>
          `).join('')}
        </div>
        ${ambiguous > 0 ? `
          <div style="padding:8px 12px;border-radius:6px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);font-size:11px;color:#f87171">
            ⚠️ ${ambiguous} строк не тронуты: в базе несколько товаров с одинаковым артикулом или названием — не получается однозначно понять, какой именно обновлять.
            Эти позиции нужно сопоставить вручную (например, проверить и сделать артикулы уникальными в карточках товаров).
          </div>
        ` : ''}
        ${skip > 0 && skipReasons ? `
          <div style="padding:8px 12px;border-radius:6px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);font-size:11px;color:#fbbf24">
            Пропущено: ${skipReasons}
            ${skipNoName > 0 ? '<br><span style="color:var(--text-2)">→ Проверьте маппинг колонки «Наименование»</span>' : ''}
          </div>
        ` : ''}

        ${toCreate.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
              Новые товары (первые ${Math.min(20, toCreate.length)})
            </div>
            <div style="border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:260px">
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <thead style="background:var(--bg-2);position:sticky;top:0">
                  <tr>
                    <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:10px;color:var(--text-2)">Артикул</th>
                    <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:10px;color:var(--text-2)">Наименование</th>
                  </tr>
                </thead>
                <tbody>
                  ${toCreate.slice(0, 20).map(p => `
                    <tr style="border-bottom:1px solid var(--line)">
                      <td style="padding:6px 10px;font-family:monospace">${esc(p.articles?.[0] ?? '')}</td>
                      <td style="padding:6px 10px">${esc(p.name)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        <div style="display:flex;justify-content:space-between">
          <button onclick="window.producersModule._smartBack()"
            style="padding:8px 16px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--text-1);font-size:12px;cursor:pointer">
            ← Назад
          </button>
          <button id="smart-import-btn" onclick="window.producersModule._smartImport()"
            style="background:var(--accent);color:#0a0a0a;border:none;padding:8px 18px;border-radius:7px;font-size:13px;cursor:pointer;font-weight:500;display:inline-flex;align-items:center;gap:6px"
            ${toCreate.length + toUpdate.length === 0 ? 'disabled' : ''}>
            Импортировать ${toCreate.length + toUpdate.length} →
          </button>
        </div>
      </div>
    `;
  }

  private _smartImportStep2Html(): string {
    const { toCreate, toUpdate } = this.smartImportPreview;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px">
        <div style="font-size:56px">✓</div>
        <div style="font-size:16px;font-weight:600;color:var(--text-1)">Импорт завершён!</div>
        <div style="font-size:13px;color:var(--text-2)">
          Создано: <b style="color:#4ade80">${toCreate.length}</b> · Обновлено: <b style="color:#fbbf24">${toUpdate.length}</b>
        </div>
        <button onclick="document.getElementById('producers-modal').remove()"
          style="background:var(--accent);color:#0a0a0a;border:none;padding:9px 20px;border-radius:7px;font-size:13px;cursor:pointer;margin-top:8px">
          Закрыть
        </button>
      </div>
    `;
  }

  _smartSetProducer(id: string): void {
    this.smartImportProducerId = id;
  }

  _smartSetMatchMode(mode: 'article' | 'name' | 'both'): void {
    this.smartMatchMode = mode;
    this._renderSmartImportModal();
  }

  _smartSetMapping(field: string, col: string): void {
    if (col) this.smartImportMapping[field] = col;
    else delete this.smartImportMapping[field];
    // Обновляем только секцию незадействованных колонок, не весь модал
    this._updateSmartUnmappedSection();
  }

  _smartSetUnmapped(idx: number, action: 'create' | 'ignore'): void {
    const col = ((window as any).__smartUnmappedCols as string[] ?? [])[idx];
    if (!col) return;
    this.smartUnmappedAction[col] = action;
    const createBtn = document.querySelector(`[data-ui="${idx}-create"]`) as HTMLElement | null;
    const ignoreBtn = document.querySelector(`[data-ui="${idx}-ignore"]`) as HTMLElement | null;
    if (createBtn) {
      createBtn.style.background = action === 'create' ? 'rgba(74,222,128,.15)' : 'var(--bg-2)';
      createBtn.style.color = action === 'create' ? '#4ade80' : 'var(--text-2)';
      createBtn.style.borderColor = action === 'create' ? 'rgba(74,222,128,.4)' : 'var(--line)';
    }
    if (ignoreBtn) {
      ignoreBtn.style.background = action === 'ignore' ? 'rgba(251,191,36,.1)' : 'var(--bg-2)';
      ignoreBtn.style.color = action === 'ignore' ? '#fbbf24' : 'var(--text-2)';
      ignoreBtn.style.borderColor = action === 'ignore' ? 'rgba(251,191,36,.3)' : 'var(--line)';
    }
  }

  private _updateSmartUnmappedSection(): void {
    const section = document.getElementById('smart-unmapped-section');
    if (!section) return;
    const headers: string[] = (window as any).__smartImportHeaders ?? [];
    const mappedCols = new Set(Object.values(this.smartImportMapping).filter(Boolean));
    const unmappedCols = headers.filter(h => h && !mappedCols.has(h));
    if (unmappedCols.length === 0) { section.innerHTML = ''; return; }
    section.innerHTML = this._smartUnmappedHtml(unmappedCols);
  }

  private _smartUnmappedHtml(unmappedCols: string[]): string {
    (window as any).__smartUnmappedCols = unmappedCols;
    return `
      <div style="margin-top:4px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;padding:8px 10px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:6px 6px 0 0;color:#fbbf24">
          Незадействованные колонки (${unmappedCols.length})
          <span style="font-size:10px;font-weight:400;opacity:.8;margin-left:6px">— не привязаны ни к одному полю</span>
        </div>
        <div style="border:1px solid rgba(251,191,36,.2);border-top:none;border-radius:0 0 6px 6px;overflow:hidden">
          ${unmappedCols.map((col, i) => {
            const action = this.smartUnmappedAction[col];
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:${i < unmappedCols.length - 1 ? '1px solid var(--line)' : 'none'};background:var(--bg-1)">
                <code style="flex:1;font-size:12px;color:var(--text-1)">«${esc(col)}»</code>
                <div style="display:flex;gap:6px">
                  <button data-ui="${i}-create"
                    onclick="window.producersModule._smartSetUnmapped(${i},'create')"
                    style="padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s;
                      background:${action==='create'?'rgba(74,222,128,.15)':'var(--bg-2)'};
                      color:${action==='create'?'#4ade80':'var(--text-2)'};
                      border:1px solid ${action==='create'?'rgba(74,222,128,.4)':'var(--line)'}">
                    + Создать поле
                  </button>
                  <button data-ui="${i}-ignore"
                    onclick="window.producersModule._smartSetUnmapped(${i},'ignore')"
                    style="padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s;
                      background:${action==='ignore'?'rgba(251,191,36,.1)':'var(--bg-2)'};
                      color:${action==='ignore'?'#fbbf24':'var(--text-2)'};
                      border:1px solid ${action==='ignore'?'rgba(251,191,36,.3)':'var(--line)'}">
                    Игнорировать
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  _smartDropFile(event: DragEvent): void {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const fakeInput = { files: [file] } as unknown as HTMLInputElement;
    this._smartFileChange(fakeInput);
  }

  async _smartFileChange(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    this.smartImportFile = file;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
      if (rows.length === 0) { this.toast('Файл пуст', 'error'); return; }
      const headers = Object.keys(rows[0]);
      (window as any).__smartImportHeaders = headers;
      (window as any).__smartImportRows = rows;

      // Авто-маппинг
      this.smartImportMapping = {};
      for (const [field, aliases] of Object.entries(this.SMART_FIELD_ALIASES)) {
        const match = headers.find(h => aliases.some(a => h.toLowerCase().includes(a)));
        if (match) this.smartImportMapping[field] = match;
      }
      for (const f of this.fields) {
        const fNorm = this._normalizeHeader(f.name);
        const match = headers.find(h => this._normalizeHeader(h) === fNorm);
        if (match) this.smartImportMapping[`field_${f.id}`] = match;
      }
    } catch (e: any) {
      this.toast(e?.message ?? 'Ошибка чтения файла', 'error');
      return;
    }
    this._renderSmartImportModal();
  }

  async _smartAnalyze(): Promise<void> {
    if (!this.smartImportProducerId) { this.toast('Сначала создайте поставщика', 'error'); return; }
    const analyzeBtn = document.getElementById('smart-analyze-btn') as HTMLButtonElement | null;
    if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.innerHTML = `<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(0,0,0,.2);border-top-color:#0a0a0a;border-radius:50%;animation:spin .7s linear infinite"></span>Анализирую…`; }
    const rows: any[] = (window as any).__smartImportRows ?? [];
    if (rows.length === 0) { this.toast('Загрузите файл', 'error'); return; }

    // Создаём новые поля для незадействованных колонок, отмеченных как 'create'
    const headers: string[] = (window as any).__smartImportHeaders ?? [];
    const mappedCols = new Set(Object.values(this.smartImportMapping).filter(Boolean));
    const unmappedCols = headers.filter(h => h && !mappedCols.has(h));
    const toCreateFields = unmappedCols.filter(col => this.smartUnmappedAction[col] === 'create');

    if (toCreateFields.length > 0) {
      try {
        for (const colName of toCreateFields) {
          const exists = this.fields.find(f => f.name.toLowerCase() === colName.toLowerCase());
          if (!exists) {
            await producerFieldDb.create({ name: colName, field_type: 'text', dropdown_options: null, is_locked: false, show_in_filters: false, sort_order: this.fields.length });
          }
        }
        await this.loadFields();
        // Добавляем новые поля в маппинг чтобы они читались через стандартный field_* путь
        for (const colName of toCreateFields) {
          const f = this.fields.find(fd => fd.name.toLowerCase() === colName.toLowerCase());
          if (f) this.smartImportMapping[`field_${f.id}`] = colName;
        }
      } catch (e: any) { this.toast(e?.message ?? 'Ошибка создания полей', 'error'); return; }
    }

    const prodByName = new Map<string, string>();
    for (const pr of this.producers) prodByName.set(pr.name.toLowerCase(), pr.id);
    const fieldByName = new Map<string, string>();
    for (const f of this.fields) fieldByName.set(this._normalizeHeader(f.name), f.id);

    // Артикулы в этой базе не гарантированно уникальны (один артикул может быть
    // присвоен десяткам разных товаров как заглушка) — поэтому индексируем
    // СПИСКАМИ совпадений, а не одним товаром, и используем составной ключ
    // артикул+название как первичный, однозначный способ сопоставления.
    const existingByArticle = new Map<string, ProducerProduct[]>();
    const existingByName = new Map<string, ProducerProduct[]>();
    const existingByArticleAndName = new Map<string, ProducerProduct>();
    for (const p of this.products) {
      const nameKey = p.name.trim().toLowerCase();
      if (nameKey) {
        const arr = existingByName.get(nameKey);
        if (arr) arr.push(p); else existingByName.set(nameKey, [p]);
      }
      for (const a of p.articles) {
        const artKey = a.trim().toLowerCase();
        if (!artKey) continue;
        const arr = existingByArticle.get(artKey);
        if (arr) arr.push(p); else existingByArticle.set(artKey, [p]);
        if (nameKey) existingByArticleAndName.set(`${artKey}|${nameKey}`, p);
      }
    }

    const m = this.smartImportMapping;
    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    let skip = 0;
    let skipNoName = 0;
    let ambiguous = 0;
    const usedIds = new Set(this.products.map(p => p.internal_id).filter((x): x is number => x != null));
    const nextId = (): number => {
      let id: number;
      do { id = 10000 + Math.floor(Math.random() * 90000); } while (usedIds.has(id));
      usedIds.add(id);
      return id;
    };

    for (const row of rows) {
      const artRaw = m['article'] ? String(row[m['article']] ?? '').trim() : '';
      const nameRaw = m['name'] ? String(row[m['name']] ?? '').trim() : '';
      if (!nameRaw) { skip++; skipNoName++; continue; }

      let producerId = this.smartImportProducerId;
      if (m['producer']) {
        const prRaw = String(row[m['producer']] ?? '').trim();
        if (prRaw) producerId = prodByName.get(prRaw.toLowerCase()) ?? producerId;
      }

      const field_values: Record<string, string> = {};
      for (const [key, col] of Object.entries(m)) {
        if (!key.startsWith('field_') || !col) continue;
        const fid = key.slice(6);
        const val = String(row[col] ?? '').trim();
        if (val) field_values[fid] = val;
      }
      if (m['cost']) {
        const costFid = this.fields.find(f => f.is_locked)?.id;
        if (costFid) {
          const v = String(row[m['cost']] ?? '').trim();
          if (v) field_values[costFid] = v;
        }
      }
      for (const colName of toCreateFields) {
        const fid = fieldByName.get(colName.toLowerCase());
        if (fid) {
          const val = String(row[colName] ?? '').trim();
          if (val) field_values[fid] = val;
        }
      }

      const articles = artRaw ? [artRaw] : [];
      const artKey = artRaw.toLowerCase();
      const nameKey = nameRaw.toLowerCase();

      // 1. Составной ключ артикул+название — однозначен всегда, проверяем первым.
      let existing: ProducerProduct | null = (artRaw ? existingByArticleAndName.get(`${artKey}|${nameKey}`) : null) ?? null;
      let wasAmbiguous = false;

      if (!existing && this.smartMatchMode !== 'name' && artRaw) {
        const candidates = existingByArticle.get(artKey);
        if (candidates && candidates.length === 1) existing = candidates[0];
        else if (candidates && candidates.length > 1) wasAmbiguous = true;
      }
      if (!existing && this.smartMatchMode !== 'article') {
        const candidates = existingByName.get(nameKey);
        if (candidates && candidates.length === 1) existing = candidates[0];
        else if (candidates && candidates.length > 1) wasAmbiguous = true;
      }

      if (!existing && wasAmbiguous) {
        // Несколько товаров одновременно подходят под артикул/название —
        // не угадываем какой именно, чтобы не перезаписать чужие данные.
        ambiguous++;
        continue;
      }

      if (existing) {
        const mergedArticles = artRaw && !existing.articles.some(a => a.trim().toLowerCase() === artRaw.toLowerCase())
          ? [...existing.articles, artRaw]
          : existing.articles;
        const merged = { ...existing.field_values, ...field_values };
        const changed = existing.name !== nameRaw
          || mergedArticles.length !== existing.articles.length
          || JSON.stringify(existing.field_values) !== JSON.stringify(merged);
        if (changed) toUpdate.push({ id: existing.id, name: nameRaw, articles: mergedArticles, producer_id: producerId, field_values: merged, comment: null, is_archived: false });
        else skip++;
      } else {
        toCreate.push({ name: nameRaw, articles, producer_id: producerId, field_values, comment: null, is_archived: false, internal_id: nextId() });
      }
    }

    this.smartImportPreview = { toCreate, toUpdate, skip, skipNoName, ambiguous };
    this.smartImportStep = 1;
    this._renderSmartImportModal();
  }

  async _smartImport(): Promise<void> {
    const { toCreate, toUpdate } = this.smartImportPreview;
    const total = toCreate.length + toUpdate.length;
    const CHUNK = 500;
    const PARALLEL = 8;
    const btn = document.getElementById('smart-import-btn') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px"></span>Импортирую (${total})…`; }
    try {
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        await producerProductDb.bulkCreate(toCreate.slice(i, i + CHUNK));
        if (btn) btn.innerHTML = `<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px"></span>Создаю ${Math.min(i+CHUNK, toCreate.length)}/${toCreate.length}…`;
      }
      for (let i = 0; i < toUpdate.length; i += PARALLEL) {
        await Promise.all(toUpdate.slice(i, i + PARALLEL).map(p =>
          producerProductDb.update(p.id, { name: p.name, articles: p.articles, field_values: p.field_values }),
        ));
        if (btn) btn.innerHTML = `<span style="display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px"></span>Обновляю ${Math.min(i+PARALLEL, toUpdate.length)}/${toUpdate.length}…`;
      }
      await this.loadProducts();
      this.smartImportStep = 2;
      this._renderSmartImportModal();
      this.render();
    } catch (e: any) {
      if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
      this.toast(e?.message ?? 'Ошибка импорта', 'error');
    }
  }

  _smartBack(): void {
    this.smartImportStep = 0;
    this._renderSmartImportModal();
  }
}
