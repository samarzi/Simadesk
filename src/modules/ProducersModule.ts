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

interface DocItem { article: string; name: string; quantity: number; }

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

// ── Module ──────────────────────────────────────────────────────────────────

export class ProducersModule {
  private el: HTMLElement;
  private visible = false;
  private tab: Tab = 'producers';

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

  // Mappings tab state
  private mappingSearch = '';
  private mappingSubtab: 'pending' | 'linked' = 'pending';
  private mpArticles: Array<{ article: string; name: string }> = []; // загруженные артикулы маркетплейса
  private mpSuggestions: Map<string, Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain'; score: number }>> = new Map();
  private mappingSelectedKeys = new Set<string>(); // `${article}__${productId}`
  private mappingProducerFilter = '';
  private mappingConfidenceFilter: 'all' | 'exact' | 'model' | 'uncertain' | 'none' = 'all';
  private mappingOnlyOrdered = false;
  private lastAutoSuggestBatch = new Set<string>(); // артикулы из последней авто-связки (для undo)

  // Consignment
  private orderSelected = new Set<string>();

  // Supply
  private supplyProducerId = '';
  private supplySearch = '';
  private supplyQty: Record<string, number> = {};

  constructor(el: HTMLElement) {
    this.el = el;
    (window as any).producersModule = this;
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
  private async loadProducts(): Promise<void>  { this.products = await producerProductDb.list(undefined, this.productArchived); }
  private async loadMappings(): Promise<void>  { this.mappings = await producerMappingDb.list(); }
  private async loadOrders(): Promise<void>    { this.orders = await producerOrderDb.list(); }

  // ── Render ────────────────────────────────────────────────────────────────

  setTab(t: Tab): void { this.tab = t; this.render(); }

  private render(loading = false): void {
    if (!this.visible) return;
    this.el.innerHTML = `
      <div class="producers-root" style="display:flex;flex-direction:column;height:100%;padding:16px 18px;gap:14px">
        ${this.renderHeader()}
        ${loading
          ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-2)">Загрузка…</div>`
          : this.renderTab()}
      </div>
    `;
  }

  private renderHeader(): string {
    const tabs: Array<{ key: Tab; label: string; count?: number }> = [
      { key: 'producers',   label: 'Поставщики',     count: this.producers.length },
      { key: 'products',    label: 'Каталог товаров', count: this.products.length },
      { key: 'mappings',    label: 'Связки',          count: this.mappings.length },
      { key: 'consignment', label: 'Заказы → Заявки', count: this.orders.filter(o => o.status === 'accepted' || o.status === 'new').length },
      { key: 'supply',      label: 'Поставка' },
      { key: 'history',     label: 'История' },
    ];
    return `
      <div style="display:flex;align-items:center;gap:14px;flex-shrink:0">
        <h2 style="margin:0;font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px">
          <span style="color:var(--accent)">${IC.factory}</span>
          Производители
        </h2>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tabs.map(t => {
            const active = this.tab === t.key;
            return `<button class="btn" onclick="window.producersModule.setTab('${t.key}')"
              style="font-size:12px;padding:6px 11px;border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};
                background:${active ? 'var(--accent)' : 'transparent'};
                color:${active ? '#fff' : 'var(--text-1)'};border-radius:7px">
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
          <span style="color:var(--text-2);font-size:13px">${this.producers.length} поставщиков</span>
          <button class="btn" onclick="window.producersModule.openProducerForm()"
            style="background:var(--accent);color:#fff;border:none;padding:7px 14px;border-radius:7px;font-size:12px;display:inline-flex;align-items:center;gap:6px">
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
                    <span style="font-weight:600;color:var(--text-1);font-size:14px">${esc(p.name)}</span>
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

  openProducerForm(id?: string): void {
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
        this.render();
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
    const filterFields = this.fields.filter(f => f.show_in_filters);
    const activeFilters = Object.keys(this.productFieldFilters).length;
    const allChecked = filtered.length > 0 && filtered.every(p => this.productSelected.has(p.id));
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

          <span style="font-size:11px;color:var(--text-2)">${filtered.length} позиций</span>
          <div style="flex:1"></div>

          <button class="btn" onclick="window.producersModule.openFieldsModal()" style="padding:7px 11px;font-size:11px">⚙ Поля</button>
          <button class="btn" onclick="window.producersModule.downloadProductTemplate()" style="padding:7px 11px;font-size:11px">📋 Шаблон</button>
          <button class="btn" onclick="window.producersModule.openProductImport()" style="padding:7px 11px;font-size:11px">📥 Импорт</button>
          <button class="btn" onclick="window.producersModule.openProductExport()" style="padding:7px 11px;font-size:11px">📤 Экспорт</button>
          <button class="btn" onclick="window.producersModule.openProductForm()"
            style="background:var(--accent);color:#fff;border:none;padding:7px 14px;border-radius:7px;font-size:12px;display:inline-flex;align-items:center;gap:6px">
            ${IC.plus} Добавить
          </button>
        </div>

        ${this.productShowFilters && filterFields.length > 0 ? this.renderFieldFilters(filterFields) : ''}

        <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
          ${filtered.length === 0 ? `
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
                  <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Поставщик</th>
                  <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Артикулы</th>
                  <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);letter-spacing:.5px">Наименование</th>
                  ${this.fields.map(f => `<th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:${f.is_locked?'#93c5fd':'var(--text-2)'};letter-spacing:.5px;white-space:nowrap">${esc(f.name)}</th>`).join('')}
                  <th style="width:80px;border-bottom:1px solid var(--line)"></th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map(p => {
                  const prod = this.producers.find(pp => pp.id === p.producer_id);
                  const checked = this.productSelected.has(p.id);
                  return `
                    <tr style="border-bottom:1px solid var(--line);background:${checked?'rgba(59,130,246,.1)':'transparent'}">
                      <td style="padding:7px 10px"><input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleProductSel('${p.id}')"></td>
                      <td style="padding:8px 10px;color:var(--text-2)">${esc(prod?.name ?? '—')}</td>
                      <td style="padding:8px 10px;font-family:monospace;font-size:11px">${p.articles.slice(0,3).map(a => esc(a)).join('<br>')}</td>
                      <td style="padding:8px 10px">${esc(p.name)}</td>
                      ${this.fields.map(f => `<td style="padding:8px 10px;color:var(--text-2);white-space:nowrap">${esc(p.field_values?.[f.id] ?? '—')}</td>`).join('')}
                      <td style="padding:6px 10px;text-align:right">
                        <button class="btn" onclick="window.producersModule.openProductForm('${p.id}')" style="padding:4px 8px;font-size:11px">${IC.edit}</button>
                        <button class="btn" onclick="window.producersModule.deleteProduct('${p.id}')" style="padding:4px 8px;font-size:11px;color:#ef4444">${IC.trash}</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </div>
        <div style="font-size:11px;color:var(--text-2)">Показано ${filtered.length} из ${this.products.length}</div>

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
      <div style="position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:50;
        background:#1a1a1d;border:1px solid #3b82f6;border-radius:14px;padding:10px 16px;
        display:flex;gap:10px;align-items:center;box-shadow:0 20px 60px rgba(59,130,246,.3)">
        <span style="background:#3b82f6;color:#fff;border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${this.productSelected.size}</span>
        <span style="color:#fff;font-size:12px">выбрано</span>
        <div style="width:1px;height:18px;background:#3f3f46"></div>
        <button onclick="window.producersModule.openBulkEdit()" style="background:var(--accent);color:#fff;border:none;padding:6px 11px;border-radius:7px;font-size:11px;cursor:pointer">✎ Редактировать</button>
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
    // частичное обновление — не перерисовываем всю шапку
    const tbody = this.el.querySelector('tbody');
    if (tbody) this.render();
  }
  setProductProducerFilter(v: string): void { this.productProducerFilter = v; this.render(); }

  private filteredProducts(): ProducerProduct[] {
    let list = this.products;
    if (this.productProducerFilter) list = list.filter(p => p.producer_id === this.productProducerFilter);
    const q = this.productSearch.toLowerCase().trim();
    if (q) list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.articles.some(a => a.toLowerCase().includes(q)) ||
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

  openProductForm(id?: string): void {
    if (this.producers.length === 0) { this.toast('Сначала добавьте поставщика', 'info'); return; }
    const p = id ? this.products.find(x => x.id === id) : null;
    const f = {
      producer_id: p?.producer_id ?? this.producers[0].id,
      name: p?.name ?? '',
      articles: p?.articles?.length ? [...p.articles] : [''],
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
      if (articles.length === 0) { this.toast('Нужен хотя бы один артикул', 'error'); return false; }
      const payload = {
        producer_id, name, articles, field_values: fv,
        comment: get('comment').trim() || null, is_archived: false,
      };
      try {
        if (p) { await producerProductDb.update(p.id, payload); this.toast('Сохранено', 'success'); }
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
            <select name="producer_id" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
              ${this.producers.map(p => `<option value="${p.id}" ${p.id===f.producer_id?'selected':''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-2)">
            Наименование *
            <input name="name" value="${esc(f.name)}" placeholder="Полное имя товара"
              style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
          </label>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span style="font-size:11px;color:var(--text-2)">Артикулы * (основной + до 4 доп.)</span>
            <div id="prod-articles" style="display:flex;flex-direction:column;gap:5px">
              ${f.articles.map((a: string, i: number) => `
                <div style="display:flex;gap:6px;align-items:center">
                  <span style="font-size:10px;color:var(--text-2);width:18px">#${i+1}</span>
                  <input name="article" value="${esc(a)}"
                    placeholder="${i===0?'Основной артикул':'Дополнительный'}"
                    style="flex:1;padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--bg-2);color:var(--text-1)">
                  ${i>0 ? `<button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px">×</button>` : ''}
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
              style="background:var(--accent);color:#fff;border:none;padding:7px 11px;border-radius:5px;font-size:11px">Добавить</button>
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
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
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

  private renderMappingsTab(): string {
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const pending = this.mpArticles.filter(a => !mappedSet.has(a.article));
    const linked = this.mappings;

    return `
      <div style="display:flex;flex-direction:column;gap:10px;flex:1;overflow:hidden">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:3px">
            <button onclick="window.producersModule.setMappingSubtab('pending')"
              style="padding:6px 12px;border-radius:5px;border:none;cursor:pointer;font-size:12px;background:${this.mappingSubtab==='pending'?'var(--accent)':'transparent'};color:${this.mappingSubtab==='pending'?'#fff':'var(--text-1)'}">
              Ожидают связки <span style="opacity:.7">${pending.length}</span>
            </button>
            <button onclick="window.producersModule.setMappingSubtab('linked')"
              style="padding:6px 12px;border-radius:5px;border:none;cursor:pointer;font-size:12px;background:${this.mappingSubtab==='linked'?'var(--accent)':'transparent'};color:${this.mappingSubtab==='linked'?'#fff':'var(--text-1)'}">
              Связаны <span style="opacity:.7">${linked.length}</span>
            </button>
          </div>

          <input value="${esc(this.mappingSearch)}" placeholder="🔍 Артикул или название…"
            oninput="window.producersModule.setMappingSearch(this.value)"
            style="flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:12px">

          ${this.mappingSubtab === 'pending' ? `
            <button class="btn" onclick="window.producersModule.openMpArticlesImport()" style="padding:7px 11px;font-size:11px">📥 Артикулы МП</button>
            <button class="btn" onclick="window.producersModule.runAutoSuggest()" style="padding:7px 11px;font-size:11px">🔗 Авто-связка</button>
            ${this.lastAutoSuggestBatch.size > 0 ? `
              <button class="btn" onclick="window.producersModule.undoAutoSuggest()" title="Отменить последнюю авто-связку"
                style="padding:7px 9px;font-size:11px;color:#fbbf24">↩ Отмена</button>
            ` : ''}
            ${this.mpArticles.length > 0 ? `
              <button onclick="window.producersModule.toggleMappingOnlyOrdered()"
                style="padding:7px 11px;font-size:11px;border:1px solid ${this.mappingOnlyOrdered?'var(--accent)':'var(--line)'};
                  background:${this.mappingOnlyOrdered?'rgba(59,130,246,.15)':'transparent'};color:${this.mappingOnlyOrdered?'#93c5fd':'var(--text-1)'};
                  border-radius:6px;cursor:pointer">📋 Только заказанные</button>
            ` : ''}
          ` : ''}
          <button class="btn" onclick="window.producersModule.openMappingForm()"
            style="background:var(--accent);color:#fff;border:none;padding:7px 12px;border-radius:7px;font-size:11px">
            + Вручную
          </button>
        </div>

        ${this.mappingSubtab === 'pending'
          ? this.renderPendingMappings(pending)
          : this.renderLinkedMappings()}
      </div>
    `;
  }

  /** Список артикулов маркетплейса, для которых нет связки. С авто-подбором и пакетным созданием. */
  private renderPendingMappings(pending: Array<{ article: string; name: string }>): string {
    if (this.mpArticles.length === 0) {
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;border:1px dashed var(--line);border-radius:10px;padding:40px">
        <div style="font-size:34px;opacity:.3">📦</div>
        <div style="font-size:13px;color:var(--text-2);max-width:340px;text-align:center">
          Загрузите артикулы из подключённых маркетплейсов или импортируйте вручную (xlsx/вставка).
        </div>
        <button class="btn" onclick="window.producersModule.openMpArticlesImport()"
          style="background:var(--accent);color:#fff;border:none;padding:9px 16px;border-radius:7px;font-size:12px">📥 Загрузить артикулы МП</button>
      </div>`;
    }

    // Filter: only ordered
    const orderedSet = new Set(this.orders.map(o => o.marketplace_article));
    let list = this.mappingOnlyOrdered
      ? pending.filter(it => orderedSet.has(it.article))
      : pending;

    // Apply search/filter
    const q = this.mappingSearch.toLowerCase();
    if (q) list = list.filter(it => it.article.toLowerCase().includes(q) || it.name.toLowerCase().includes(q));
    if (this.mappingProducerFilter) {
      list = list.filter(it => {
        const sugs = this.mpSuggestions.get(it.article) ?? [];
        return sugs.some(s => {
          const pp = this.products.find(p => p.id === s.productId);
          return pp?.producer_id === this.mappingProducerFilter;
        });
      });
    }
    if (this.mappingConfidenceFilter !== 'all') {
      list = list.filter(it => {
        const sugs = this.mpSuggestions.get(it.article) ?? [];
        if (sugs.length === 0) return this.mappingConfidenceFilter === 'none';
        return sugs.some(s => s.confidence === this.mappingConfidenceFilter);
      });
    }

    // Prefix pills from producers that have a prefix set
    const prefixProducers = this.producers.filter(p => p.prefix);
    const activePrefixPill = this.mappingProducerFilter
      ? (this.producers.find(p => p.id === this.mappingProducerFilter)?.prefix ?? null)
      : null;

    const producersWithSuggestions = new Set<string>();
    for (const [, sugs] of this.mpSuggestions) for (const s of sugs) {
      const pp = this.products.find(p => p.id === s.productId);
      if (pp) producersWithSuggestions.add(pp.producer_id);
    }

    return `
      ${this.mpSuggestions.size > 0 ? `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;gap:3px;background:var(--bg-2);border:1px solid var(--line);border-radius:7px;padding:3px;font-size:11px">
            ${[
              ['all', 'Все'],
              ['exact', '🟢 Точные'],
              ['model', '🟡 По модели'],
              ['uncertain', '🔴 Неточные'],
              ['none', '— Без вариантов'],
            ].map(([k, l]) => `<button onclick="window.producersModule.setMappingConfFilter('${k}')"
              style="padding:4px 9px;border:none;border-radius:5px;background:${this.mappingConfidenceFilter===k?'var(--accent)':'transparent'};color:${this.mappingConfidenceFilter===k?'#fff':'var(--text-1)'};cursor:pointer;font-size:11px">${l}</button>`).join('')}
          </div>
          ${producersWithSuggestions.size > 1 ? `
            <select onchange="window.producersModule.setMappingProducerFilter(this.value)"
              style="padding:5px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:11px">
              <option value="">Все производители</option>
              ${[...producersWithSuggestions].map(prId => {
                const pr = this.producers.find(p => p.id === prId);
                return pr ? `<option value="${pr.id}" ${this.mappingProducerFilter===pr.id?'selected':''}>${esc(pr.name)}</option>` : '';
              }).join('')}
            </select>
          ` : ''}
          <div style="flex:1"></div>
          <button onclick="window.producersModule.bulkPickAllExact()" style="font-size:11px;padding:5px 11px;background:rgba(59,130,246,.12);color:#93c5fd;border:1px solid rgba(59,130,246,.3);border-radius:5px;cursor:pointer">★ Отметить все точные</button>
          ${this.mappingSelectedKeys.size > 0 ? `
            <button onclick="window.producersModule.createMappingsBulk()" style="font-size:12px;padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:7px;cursor:pointer;font-weight:500">
              Создать связки (${this.mappingSelectedKeys.size})
            </button>
          ` : ''}
        </div>
      ` : ''}

      <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
        ${list.length === 0 ? `<div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">Ничего не найдено</div>` : `
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead style="background:var(--bg-2);position:sticky;top:0;z-index:5">
              <tr>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2);width:30%">Артикул МП · название</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Варианты товаров производителя</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(it => this.renderPendingRow(it)).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;
  }

  private renderPendingRow(it: { article: string; name: string }): string {
    const sugs = this.mpSuggestions.get(it.article) ?? [];
    return `
      <tr style="border-bottom:1px solid var(--line);vertical-align:top">
        <td style="padding:9px 10px">
          <div style="font-family:monospace;font-size:12px">${esc(it.article)}</div>
          ${it.name ? `<div style="font-size:11px;color:var(--text-2);margin-top:3px">${esc(it.name)}</div>` : ''}
        </td>
        <td style="padding:7px 10px">
          ${sugs.length === 0 ? `
            <div style="display:flex;gap:8px;align-items:center">
              <span style="color:var(--text-2);font-size:11px">— нет вариантов —</span>
              <button onclick="window.producersModule.openManualPick('${esc(it.article).replace(/'/g,"\\'")}')"
                style="font-size:11px;padding:3px 10px;background:transparent;color:#3b82f6;border:1px solid var(--line);border-radius:5px;cursor:pointer">Подобрать вручную</button>
            </div>
          ` : `
            <div style="display:flex;flex-direction:column;gap:4px">
              ${sugs.map(s => {
                const pp = this.products.find(p => p.id === s.productId);
                if (!pp) return '';
                const pr = this.producers.find(x => x.id === pp.producer_id);
                const key = `${it.article}__${s.productId}`;
                const checked = this.mappingSelectedKeys.has(key);
                const confColor = s.confidence === 'exact' ? '#4ade80' : s.confidence === 'model' ? '#fbbf24' : '#f87171';
                const confLabel = s.confidence === 'exact' ? '🟢' : s.confidence === 'model' ? '🟡' : '🔴';
                return `
                  <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;background:${checked?'rgba(59,130,246,.1)':'transparent'};cursor:pointer">
                    <input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleMappingKey('${esc(key).replace(/'/g,"\\'")}')">
                    <span style="font-size:11px;color:${confColor}">${confLabel}</span>
                    <code style="font-size:11px;color:var(--text-2)">${esc(pp.articles[0]??'')}</code>
                    <span style="font-size:11px">${esc(pp.name)}</span>
                    <span style="font-size:10px;color:var(--text-2);margin-left:auto">${esc(pr?.name??'')}</span>
                  </label>
                `;
              }).join('')}
              <button onclick="window.producersModule.openManualPick('${esc(it.article).replace(/'/g,"\\'")}')"
                style="align-self:flex-start;font-size:10px;padding:3px 9px;background:transparent;color:#3b82f6;border:1px dashed var(--line);border-radius:5px;cursor:pointer">+ Подобрать ещё</button>
            </div>
          `}
        </td>
      </tr>
    `;
  }

  private renderLinkedMappings(): string {
    const q = this.mappingSearch.toLowerCase();
    let list = this.mappings;
    if (q) list = list.filter(m => {
      if (m.marketplace_article.toLowerCase().includes(q)) return true;
      const pp = this.products.find(p => p.id === m.producer_product_id);
      return pp && (pp.name.toLowerCase().includes(q) || pp.articles.some(a => a.toLowerCase().includes(q)));
    });
    if (this.mappingProducerFilter) {
      list = list.filter(m => {
        const pp = this.products.find(p => p.id === m.producer_product_id);
        return pp?.producer_id === this.mappingProducerFilter;
      });
    }

    const linkedProducers = new Set(this.mappings.map(m => {
      const pp = this.products.find(p => p.id === m.producer_product_id);
      return pp?.producer_id;
    }).filter(Boolean) as string[]);

    return `
      ${linkedProducers.size > 1 ? `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select onchange="window.producersModule.setMappingProducerFilter(this.value)"
            style="padding:5px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-size:11px">
            <option value="">Все производители</option>
            ${[...linkedProducers].map(prId => {
              const pr = this.producers.find(p => p.id === prId);
              return pr ? `<option value="${pr.id}" ${this.mappingProducerFilter===pr.id?'selected':''}>${esc(pr.name)}</option>` : '';
            }).join('')}
          </select>
        </div>
      ` : ''}

      <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
        ${list.length === 0 ? `<div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">Связок нет</div>` : `
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead style="background:var(--bg-2);position:sticky;top:0;z-index:5">
              <tr>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Артикул МП</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Товар производителя</th>
                <th style="text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Поставщик</th>
                <th style="text-align:center;padding:9px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Кол-во</th>
                <th style="width:60px;border-bottom:1px solid var(--line)"></th>
              </tr>
            </thead>
            <tbody>
              ${list.map(m => {
                const p = this.products.find(x => x.id === m.producer_product_id);
                const pr = this.producers.find(x => x.id === p?.producer_id);
                return `
                  <tr style="border-bottom:1px solid var(--line)">
                    <td style="padding:8px 10px;font-family:monospace">${esc(m.marketplace_article)}</td>
                    <td style="padding:8px 10px">
                      <div>${esc(p?.name ?? '—')}</div>
                      <div style="font-size:10px;color:var(--text-2);font-family:monospace">${esc(p?.articles?.[0] ?? '')}</div>
                    </td>
                    <td style="padding:8px 10px;color:var(--text-2)">${esc(pr?.name ?? '—')}</td>
                    <td style="padding:8px 10px;text-align:center">×${m.quantity}</td>
                    <td style="padding:6px 10px;text-align:right">
                      <button class="btn" onclick="window.producersModule.deleteMapping('${m.id}')" style="padding:4px 8px;font-size:11px;color:#ef4444">${IC.trash}</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;
  }

  setMappingSearch(v: string): void { this.mappingSearch = v; this.render(); }

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
        <input name="comp_qty" type="number" min="0.01" step="0.01" value="1" title="Количество в 1 шт заказа"
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
      const components = rows.map(row => ({
        product_id: (row.querySelector('[name="comp_product"]') as HTMLSelectElement).value,
        qty: Number((row.querySelector('[name="comp_qty"]') as HTMLInputElement).value) || 1,
      })).filter(c => c.product_id);
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
      <input name="comp_qty" type="number" min="0.01" step="0.01" value="1"
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
    const active = this.orders.filter(o => o.status !== 'cancelled' && o.status !== 'done');
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const noMap   = active.filter(o => !mappedSet.has(o.marketplace_article));

    return `
      <div style="display:flex;gap:14px;flex:1;overflow:hidden">
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600">Заказы для отработки</span>
            <span style="font-size:11px;color:var(--text-2)">${active.length} активных</span>
            ${noMap.length > 0 ? `<span style="font-size:10px;background:#451a03;color:#fb923c;padding:2px 8px;border-radius:10px">⚠ ${noMap.length} без связки</span>` : ''}
            <div style="flex:1"></div>
            <button class="btn" onclick="window.producersModule.openOrderForm()" style="padding:6px 11px;font-size:11px">${IC.plus} Добавить</button>
            <button class="btn" onclick="window.producersModule.openOrderImport()" style="padding:6px 11px;font-size:11px">↑ Импорт xlsx</button>
          </div>
          <div style="flex:1;overflow:auto;border:1px solid var(--line);border-radius:8px">
            ${active.length === 0 ? `
              <div style="padding:40px;text-align:center;color:var(--text-2);font-size:13px">
                Заказов нет. Добавьте вручную или импортируйте xlsx.
              </div>
            ` : `
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <thead style="background:var(--bg-2);position:sticky;top:0">
                  <tr>
                    <th style="width:30px;padding:8px 10px;border-bottom:1px solid var(--line)">
                      <input type="checkbox" onchange="window.producersModule.toggleAllOrders(this.checked)">
                    </th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Артикул МП</th>
                    <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Компоненты производителя</th>
                    <th style="text-align:center;padding:8px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;color:var(--text-2)">Кол-во</th>
                    <th style="width:60px;border-bottom:1px solid var(--line)"></th>
                  </tr>
                </thead>
                <tbody>
                  ${active.map(o => {
                    const maps = this.mappings.filter(m => m.marketplace_article === o.marketplace_article);
                    const checked = this.orderSelected.has(o.id);
                    return `
                      <tr style="border-bottom:1px solid var(--line);background:${checked?'rgba(59,130,246,.08)':'transparent'}">
                        <td style="padding:7px 10px"><input type="checkbox" ${checked?'checked':''} onchange="window.producersModule.toggleOrder('${o.id}')"></td>
                        <td style="padding:7px 10px;font-family:monospace">${esc(o.marketplace_article)}<div style="font-size:10px;color:var(--text-2);font-family:inherit">${esc(o.product_name)}</div></td>
                        <td style="padding:7px 10px">
                          ${maps.length > 0 ? maps.map(map => {
                            const pp = this.products.find(p => p.id === map.producer_product_id);
                            const pr = pp ? this.producers.find(x => x.id === pp.producer_id) : null;
                            if (!pp) return '';
                            return `<div style="display:flex;gap:6px;align-items:center;padding:2px 0">
                              <code style="font-size:10px;color:var(--text-2)">${esc(pp.articles[0]??'')}</code>
                              <span style="font-size:11px">${esc(pp.name)}</span>
                              ${map.quantity !== 1 ? `<span style="font-size:10px;color:#fb923c">×${map.quantity}</span>` : ''}
                              ${pr ? `<span style="font-size:10px;color:var(--text-2);margin-left:auto">${esc(pr.name)}</span>` : ''}
                            </div>`;
                          }).join('') : `<span style="color:#fb923c">⚠ нет связки</span>`}
                        </td>
                        <td style="padding:7px 10px;text-align:center;font-weight:500">${o.quantity}</td>
                        <td style="padding:5px 10px;text-align:right">
                          <button class="btn" onclick="window.producersModule.deleteOrder('${o.id}')" style="padding:3px 7px;font-size:11px;color:#ef4444">${IC.trash}</button>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>

        <div style="width:330px;display:flex;flex-direction:column;gap:10px">
          <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-2);flex:1;overflow:auto">
            <div style="font-size:12px;font-weight:600;margin-bottom:10px">Заявки к формированию</div>
            ${this.renderConsignmentPreview()}
          </div>
          <button onclick="window.producersModule.generateConsignment()"
            style="background:var(--accent);color:#fff;border:none;padding:11px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500">
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
            <div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0">
              <span style="font-family:monospace;color:var(--text-2)">${esc(it.article)}</span>
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
    this.render();
  }
  toggleAllOrders(on: boolean): void {
    if (on) {
      const active = this.orders.filter(o => o.status !== 'cancelled' && o.status !== 'done');
      this.orderSelected = new Set(active.map(o => o.id));
    } else this.orderSelected = new Set();
    this.render();
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
                      <td style="padding:8px 10px;font-family:monospace">${esc(p.articles[0] ?? '')}</td>
                      <td style="padding:8px 10px">${esc(p.name)}</td>
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
                <div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid var(--line)">
                  <span style="font-family:monospace;color:var(--text-2);max-width:60%;overflow:hidden;text-overflow:ellipsis">${esc(p.articles[0]??'')}</span>
                  <span style="font-weight:500">×${this.supplyQty[p.id]}</span>
                </div>
              `).join('')}
            `}
          </div>
          <button onclick="window.producersModule.generateSupply()"
            style="background:var(--accent);color:#fff;border:none;padding:11px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500"
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
            </tr>
          </thead>
          <tbody>
            ${this.history.map((d: any) => `
              <tr style="border-bottom:1px solid var(--line)">
                <td style="padding:8px 10px;color:var(--text-2);font-size:11px">${new Date(d.created_at).toLocaleString('ru')}</td>
                <td style="padding:8px 10px"><span style="font-size:10px;background:${d.doc_type==='supply'?'#3b0a6a':'#1e3a5f'};color:#fff;padding:2px 7px;border-radius:10px">${d.doc_type === 'supply' ? 'Поставка' : 'Реализация'}</span></td>
                <td style="padding:8px 10px;font-family:monospace;font-size:11px">${esc(d.file_name ?? '')}</td>
                <td style="padding:8px 10px">${d.items?.length ?? 0}</td>
                <td style="padding:8px 10px">${d.total_qty ?? 0}</td>
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
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
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
          <button id="producers-modal-save" class="btn" style="background:var(--accent);color:#fff;border:none;padding:7px 14px;border-radius:7px;font-size:12px">${esc(saveText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.getElementById('producers-modal-cancel')?.addEventListener('click', () => root.remove());
    document.getElementById('producers-modal-save')!.addEventListener('click', async () => {
      if (!onSave) { root.remove(); return; }
      const ok = await onSave();
      if (ok) root.remove();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTS — bulk operations, filters, archive
  // ════════════════════════════════════════════════════════════════════════

  toggleProductSel(id: string): void {
    if (this.productSelected.has(id)) this.productSelected.delete(id);
    else this.productSelected.add(id);
    this.render();
  }
  toggleAllProducts(on: boolean): void {
    const visible = this.filteredProducts();
    if (on) for (const p of visible) this.productSelected.add(p.id);
    else for (const p of visible) this.productSelected.delete(p.id);
    this.render();
  }
  clearProductSel(): void { this.productSelected = new Set(); this.render(); }

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
          if (articles.length === 0 || !name) { skipped++; continue; }
          const field_values: Record<string, string> = {};
          for (const [colName, val] of Object.entries(row)) {
            const fid = fieldByName.get(String(colName).toLowerCase());
            if (fid && String(val).trim()) field_values[fid] = String(val).trim();
          }
          toCreate.push({
            producer_id, name, articles, field_values,
            comment: String(row['Комментарий'] ?? '').trim() || null,
            is_archived: false,
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
      { key: 'producer', label: 'Поставщик' },
      { key: 'articles', label: 'Артикулы' },
      { key: 'name',     label: 'Наименование' },
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
      const data = candidates.map(p => cols.map(c => {
        if (c.key === 'producer') return this.producers.find(x => x.id === p.producer_id)?.name ?? '';
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

  // ════════════════════════════════════════════════════════════════════════
  // MAPPINGS — sub-tabs, import MP articles, auto-suggest, bulk create
  // ════════════════════════════════════════════════════════════════════════

  setMappingSubtab(t: 'pending' | 'linked'): void { this.mappingSubtab = t; this.render(); }
  setMappingConfFilter(k: string): void { this.mappingConfidenceFilter = k as any; this.render(); }
  setMappingProducerFilter(v: string): void { this.mappingProducerFilter = v; this.render(); }

  toggleMappingKey(key: string): void {
    if (this.mappingSelectedKeys.has(key)) this.mappingSelectedKeys.delete(key);
    else this.mappingSelectedKeys.add(key);
    this.render();
  }

  bulkPickAllExact(): void {
    for (const [article, sugs] of this.mpSuggestions) {
      for (const s of sugs) if (s.confidence === 'exact') this.mappingSelectedKeys.add(`${article}__${s.productId}`);
    }
    this.render();
  }

  openMpArticlesImport(): void {
    const html = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--text-2)">
          Загрузите список артикулов маркетплейса. Поддерживается xlsx (колонки <b>Артикул</b>, опц. <b>Название</b>)
          или текстовая вставка — по одному артикулу на строку.
        </div>
        <input type="file" accept=".xlsx,.xls" id="mp-imp-file"
          style="padding:8px;border:1px dashed var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1)">
        <div style="font-size:11px;color:var(--text-2)">— или —</div>
        <textarea id="mp-imp-paste" placeholder="Вставьте артикулы по одному на строку…" rows="6"
          style="padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg-2);color:var(--text-1);font-family:monospace;resize:vertical"></textarea>
      </div>
    `;
    this.showModal('Импорт артикулов маркетплейса', html, async () => {
      const f = (document.getElementById('mp-imp-file') as HTMLInputElement)?.files?.[0];
      const paste = (document.getElementById('mp-imp-paste') as HTMLTextAreaElement)?.value ?? '';
      let added: Array<{ article: string; name: string }> = [];
      if (f) {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
        added = rows.map(r => ({
          article: String(r['Артикул'] ?? r['article'] ?? r['SKU'] ?? Object.values(r)[0] ?? '').trim(),
          name: String(r['Название'] ?? r['Наименование'] ?? r['name'] ?? '').trim(),
        })).filter(x => x.article);
      } else if (paste.trim()) {
        added = paste.split('\n').map(line => ({ article: line.trim(), name: '' })).filter(x => x.article);
      }
      if (added.length === 0) { this.toast('Не найдено артикулов', 'error'); return false; }
      // merge
      const existing = new Map(this.mpArticles.map(x => [x.article, x]));
      for (const x of added) existing.set(x.article, { ...existing.get(x.article), ...x });
      this.mpArticles = [...existing.values()];
      this.mpSuggestions = new Map();
      this.mappingSelectedKeys = new Set();
      this.toast(`Загружено артикулов: ${added.length}`, 'success');
      this.render();
      return true;
    });
  }

  /** Простая авто-связка: ищем товар, у которого артикул совпадает с артикулом МП,
   *  иначе ищем по подстроке в наименовании. */
  runAutoSuggest(): void {
    if (this.mpArticles.length === 0) { this.toast('Сначала импортируйте артикулы', 'info'); return; }
    const mappedSet = new Set(this.mappings.map(m => m.marketplace_article));
    const pending = this.mpArticles.filter(a => !mappedSet.has(a.article));
    const norm = (s: string) => s.toLowerCase().replace(/[\s\-_/.,;:!?'"()]+/g, '');
    const sugMap = new Map<string, Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain'; score: number }>>();
    for (const item of pending) {
      const matches: Array<{ productId: string; confidence: 'exact' | 'model' | 'uncertain'; score: number }> = [];
      const aN = norm(item.article);
      const iName = item.name.toLowerCase();
      for (const p of this.products) {
        // exact: артикул совпал
        if (p.articles.some(a => norm(a) === aN)) {
          matches.push({ productId: p.id, confidence: 'exact', score: 100 });
          continue;
        }
        // model: артикул МП содержит артикул производителя (или наоборот) полностью
        if (p.articles.some(a => { const n = norm(a); return n.length >= 4 && (aN.includes(n) || n.includes(aN)); })) {
          matches.push({ productId: p.id, confidence: 'model', score: 60 });
          continue;
        }
        // uncertain: совпадение в названии
        if (iName && p.name.toLowerCase().includes(iName.split(' ')[0])) {
          matches.push({ productId: p.id, confidence: 'uncertain', score: 30 });
        }
      }
      matches.sort((a, b) => b.score - a.score);
      sugMap.set(item.article, matches.slice(0, 5));
    }
    this.mpSuggestions = sugMap;
    // авто-предвыбор первой точки совпадения
    this.mappingSelectedKeys = new Set();
    for (const [art, sugs] of sugMap) {
      if (sugs[0]?.confidence === 'exact') this.mappingSelectedKeys.add(`${art}__${sugs[0].productId}`);
    }
    const found = [...sugMap.values()].filter(v => v.length > 0).length;
    this.toast(`Авто-связка: найдено вариантов для ${found} из ${pending.length}`, 'success');
    this.render();
  }

  async createMappingsBulk(): Promise<void> {
    const keys = [...this.mappingSelectedKeys];
    if (keys.length === 0) return;
    try {
      let ok = 0;
      for (const k of keys) {
        const [article, pid] = k.split('__');
        try {
          await producerMappingDb.create({ marketplace_article: article, producer_product_id: pid, quantity: 1 });
          ok++;
        } catch {}
      }
      this.mappingSelectedKeys = new Set();
      await this.loadMappings();
      this.toast(`Создано связок: ${ok}`, 'success');
      this.render();
    } catch (e: any) { this.toast(e?.message ?? 'Ошибка', 'error'); }
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
    root.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px';
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
                      <button onclick="window.producersModule.bulkFillColumn('${c.key}','${c.type}')" style="padding:3px 8px;font-size:10px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer">OK</button>
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
            <button id="bulk-save" onclick="window.producersModule.saveBulkEdit()" style="background:var(--accent);color:#fff;border:none;padding:7px 14px;border-radius:7px;font-size:12px;cursor:pointer">Сохранить</button>
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
}
