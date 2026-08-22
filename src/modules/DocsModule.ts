/**
 * DocsModule — единый редактор документов (Word + Excel).
 * Документы хранятся в Supabase (docs_documents), localStorage используется как кеш.
 * Excel: многолистовость, цвета ячеек, ширины/высоты из xlsx.
 */

import * as XLSX from 'xlsx';
import { aiPage, type AiPageCapability, type AiActionResult } from '@/services/aiPageContext';
import { debug } from '@/utils/debug';
import { selectionCtx } from '@/services/selectionContext';
import { dbFetch } from '@/services/dbClient';
import { companyService } from '@/services/companyService';
import { showToast } from '@/utils/toast';
import {
  formatCellValue, parseUserNumber, isDateFormat,
  dateToSerial, PRESET_FORMATS,
  type CellType,
} from '@/utils/numFormat';
import { createEvaluator, FUNCTION_NAMES, type Evaluator } from '@/utils/formula';

type DocType = 'word' | 'excel';

interface CellData {
  /**
   * Сырое значение ячейки — то, что хранится, а не то, что видно.
   * Число — машинной строкой («1234.5»), дата — ISO, формула — с «=» в начале.
   * Форматирование к нему применяется только на отрисовке.
   */
  v: string;
  s?: string;   // inline style cssText
  t?: CellType; // 'n' | 's' | 'd' | 'b'; отсутствие = текст
  nf?: string;  // код числового формата Excel («#,##0.00», «dd.mm.yyyy»)
}

interface MergeRange { r1: number; c1: number; r2: number; c2: number; }

interface SheetData {
  name: string;
  data: CellData[][];
  colWidths?: (number | null)[];
  rowHeights?: (number | null)[];
  merges?: MergeRange[];
  truncated?: boolean;
}

interface ExcelContent {
  sheets: SheetData[];
}

interface DocItem {
  id: string;
  type: DocType;
  title: string;
  content: string;
  updated_at: number;
}

const STORAGE_KEY  = 'docs_v2';    // v2 = company-scoped
const RECENT_KEY   = 'docs_recent_v2';
const ACTIVE_KEY   = 'docs_active_v2';
const MAX_DOCS     = 20;
const MAX_RECENT   = 10;
const XL_ROWS = 50;
const XL_COLS = 26;
const MAX_IMPORT_ROWS = 5000;  // hard cap on rows parsed from xlsx
const XL_VX_THRESH = 250;      // row count above which virtual scroll activates
const XL_VX_PAGE   = 100;      // visible rows per virtual window
const XL_VX_BUF    = 30;       // buffer rows above/below viewport
const XL_VX_ROW_H  = 24;       // assumed row height (px) for spacer math
/** Пикселей на «ширину нуля» — единицу ширины колонки в OOXML (Calibri 11). */
const XL_PX_PER_CH = 7;
/** Пикселей на пункт: высота строки в OOXML измеряется в пунктах. */
const XL_PX_PER_PT = 4 / 3;

export class DocsModule {
  private root!: HTMLElement;
  private docs: DocItem[] = [];
  private activeId: string | null = null;
  private loadedCompanyId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSheetIdx: number = 0;
  private xlVirtData: CellData[][] | null = null;
  private xlVirtMerges: MergeRange[] | null = null;
  private isFullscreen: boolean = false;
  private recent: Array<{id:string;title:string;type:DocType;updated_at:number;content?:string}> = [];
  private xlLastSel: { r1: number; c1: number; r2: number; c2: number; docId: string; sheetIdx: number } | null = null;
  private xlUndoStack: Array<{data: CellData[][], docId: string, sheetIdx: number, r: number, c: number}> = [];
  private xlRedoStack: Array<{data: CellData[][], docId: string, sheetIdx: number, r: number, c: number}> = [];
  private xlFreezeRow  = false;
  private xlFreezeCol  = false;
  private xlFilterOn   = false;
  private xlFilterState: Record<number, Set<string>> = {};
  private xlSheetScroll: Record<string, Record<number, {top: number; left: number}>> = {};
  /** Кэш вычислителя формул: пересоздаётся, когда меняются данные листа. */
  private fxRows: CellData[][] | null = null;
  private fxEval: Evaluator | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.loadedCompanyId = companyService.getActiveId();
    this.load();
    window.addEventListener('beforeunload', () => this.flushSave());
    this.syncFromDb();
  }

  show(): void {
    this.root.style.display = '';
    const cid = companyService.getActiveId();
    if (cid !== this.loadedCompanyId) {
      // Company switched — reset local state and reload for the new company
      this.flushSave();
      this.docs = [];
      this.recent = [];
      this.activeId = null;
      this.activeSheetIdx = 0;
      this.loadedCompanyId = cid;
      this.load();
      this.syncFromDb();
    }
    this.render();
  }
  hide(): void { this.flushSave(); this.root.style.display = 'none'; document.getElementById('dx-fill-handle')?.remove(); }

  /** Публичный геттер: id активного документа (для внешних вызовов после aiCreateDoc). */
  get activeDocId(): string | null { return this.activeId; }

  /** Создать новый документ из ассистента (кросс-страничное глобальное действие). */
  aiCreateDoc(type: DocType, title?: string): string {
    this.createDoc(type);
    if (title && this.activeId) {
      const doc = this.docs.find(d => d.id === this.activeId);
      if (doc) { doc.title = title.trim() || doc.title; this.save(); this.render(); }
    }
    return `Создан новый ${type === 'excel' ? 'Excel' : 'Word'}-документ${title ? ` «${title}»` : ''}.`;
  }

  // ── Storage (company-scoped keys) ─────────────────────────────────────────
  private sk(): string { const c = companyService.getActiveId(); return c ? `${STORAGE_KEY}_${c}` : STORAGE_KEY; }
  private rk(): string { const c = companyService.getActiveId(); return c ? `${RECENT_KEY}_${c}` : RECENT_KEY; }
  private ak(): string { const c = companyService.getActiveId(); return c ? `${ACTIVE_KEY}_${c}` : ACTIVE_KEY; }

  private load(): void {
    try { const raw = localStorage.getItem(this.sk()); this.docs = raw ? JSON.parse(raw) : []; }
    catch { this.docs = []; }
    try { const raw = localStorage.getItem(this.rk()); this.recent = raw ? JSON.parse(raw) : []; }
    catch { this.recent = []; }
    const savedActive = localStorage.getItem(this.ak());
    if (savedActive && this.docs.some(d => d.id === savedActive)) {
      this.activeId = savedActive;
    } else if (!this.activeId && this.docs.length) {
      this.activeId = this.docs[0].id;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.sk(), JSON.stringify(this.docs));
      if (this.activeId) localStorage.setItem(this.ak(), this.activeId);
    } catch (e) {
      debug.warn('[DocsModule] save failed', e);
      try {
        // Oversized docs: save with empty content so metadata is preserved;
        // their content will be restored from DB on next syncFromDb.
        const slim = this.docs.map(d => ({ ...d, content: d.content.length > 50000 ? '' : d.content }));
        localStorage.setItem(this.sk(), JSON.stringify(slim));
        // Push oversized docs to DB so their content isn't permanently lost.
        for (const doc of this.docs) {
          if (doc.content.length > 50000) this.saveDocToDb(doc);
        }
      } catch { /* ignore */ }
    }
  }

  /** Sync all docs from Supabase, merge with local cache (DB wins on conflict). */
  private async syncFromDb(): Promise<void> {
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    try {
      const rows = await dbFetch<DocItem[]>(`docs_documents?company_id=eq.${companyId}&select=id,type,title,content,updated_at&order=updated_at.desc`);
      if (!Array.isArray(rows) || !rows.length) return;
      let changed = false;
      for (const row of rows) {
        const local = this.docs.find(d => d.id === row.id);
        if (!local) {
          this.docs.push(row);
          changed = true;
        } else if (row.updated_at > local.updated_at || (row.content && !local.content)) {
          Object.assign(local, row);
          changed = true;
        }
      }
      if (changed) {
        this.docs.sort((a, b) => b.updated_at - a.updated_at);
        if (!this.activeId && this.docs.length) this.activeId = this.docs[0].id;
        this.save();
        this.render();
      }
    } catch (e) {
      debug.warn('[DocsModule] syncFromDb failed', e);
    }
  }

  /** Upsert a single doc to Supabase. Fire-and-forget. */
  private saveDocToDb(doc: DocItem): void {
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    dbFetch<unknown>(`docs_documents`, {
      method: 'POST',
      body: JSON.stringify({ id: doc.id, company_id: companyId, type: doc.type, title: doc.title, content: doc.content, updated_at: doc.updated_at }),
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    }).catch(e => debug.warn('[DocsModule] saveDocToDb failed', e));
  }

  /** Delete a doc from Supabase. Fire-and-forget. */
  private deleteDocFromDb(id: string): void {
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    dbFetch<unknown>(`docs_documents?id=eq.${id}&company_id=eq.${companyId}`, { method: 'DELETE' })
      .catch(e => debug.warn('[DocsModule] deleteDocFromDb failed', e));
  }

  private saveRecent(): void {
    try { localStorage.setItem(this.rk(), JSON.stringify(this.recent)); }
    catch { /* ignore */ }
  }

  private touchRecent(doc: DocItem): void {
    this.recent = this.recent.filter(r => r.id !== doc.id);
    this.recent.unshift({ id: doc.id, title: doc.title, type: doc.type, updated_at: doc.updated_at, content: doc.content });
    if (this.recent.length > MAX_RECENT) this.recent = this.recent.slice(0, MAX_RECENT);
    this.saveRecent();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
      if (this.activeId) {
        const doc = this.docs.find(d => d.id === this.activeId);
        if (doc) this.saveDocToDb(doc);
      }
    }, 800);
  }

  private flushSave(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.save(); }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────
  private addDoc(doc: DocItem): void {
    this.docs.unshift(doc);
    if (this.docs.length > MAX_DOCS) {
      this.docs.sort((a, b) => b.updated_at - a.updated_at);
      this.docs = this.docs.slice(0, MAX_DOCS);
    }
    this.activeId = doc.id;
    this.activeSheetIdx = 0;
    this.touchRecent(doc);
    this.save();
    this.saveDocToDb(doc);
    this.render();
  }

  private createDoc(type: DocType): void {
    const now = Date.now();
    const wordN = this.docs.filter(d => d.type === 'word').length + 1;
    const excelN = this.docs.filter(d => d.type === 'excel').length + 1;
    this.addDoc({
      id: this.newId(), type,
      title: type === 'word' ? `Документ ${wordN}` : `Таблица ${excelN}`,
      content: type === 'word' ? '' : this.emptyExcel(),
      updated_at: now,
    });
  }

  private deleteDoc(id: string, skipConfirm = false): void {
    const idx = this.docs.findIndex(d => d.id === id);
    if (idx === -1) return;
    const doc = this.docs[idx];
    if (!skipConfirm && !confirm(`Закрыть «${doc.title}»?\nДокумент будет закрыт.`)) return;
    this.touchRecent(doc);
    this.docs.splice(idx, 1);
    if (this.activeId === id) { this.activeId = this.docs[0]?.id ?? null; this.activeSheetIdx = 0; }
    this.save();
    this.deleteDocFromDb(id);
    this.render();
  }

  private renameDoc(id: string, title: string): void {
    const doc = this.docs.find(d => d.id === id);
    if (!doc) return;
    doc.title = title.trim() || doc.title;
    doc.updated_at = Date.now();
    this.scheduleSave();
  }

  private updateContent(id: string, content: string): void {
    this.invalidateFormulas();
    const doc = this.docs.find(d => d.id === id);
    if (!doc) return;
    doc.content = content;
    doc.updated_at = Date.now();
    this.touchRecent(doc);
    this.scheduleSave();
  }

  private newId(): string { return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  private emptyExcel(): string {
    return JSON.stringify({
      sheets: [{ name: 'Лист 1', data: Array.from({ length: XL_ROWS }, () => Array.from({ length: XL_COLS }, () => ({ v: '' } as CellData))) }]
    } as ExcelContent);
  }

  // ── Excel content parsing ──────────────────────────────────────────────────
  private parseExcelContent(content: string): ExcelContent {
    try {
      const p = JSON.parse(content);
      // New format: { sheets: [...] }
      if (p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.sheets)) {
        return {
          sheets: p.sheets.map((s: any) => ({
            name: s.name || 'Лист 1',
            data: this.normalizeCellGrid(s.data || []),
            colWidths: s.colWidths,
            rowHeights: s.rowHeights,
            merges: s.merges,
          }))
        };
      }
      // Legacy format: CellData[][] (single sheet)
      if (Array.isArray(p)) {
        return { sheets: [{ name: 'Лист 1', data: this.normalizeCellGrid(p) }] };
      }
    } catch {}
    return JSON.parse(this.emptyExcel());
  }

  private normalizeCellGrid(p: any[][]): CellData[][] {
    const TYPES = new Set(['n', 's', 'd', 'b']);
    return (p || []).map(row => (row || []).map((cell: unknown) => {
      if (typeof cell === 'string') return { v: cell };
      if (cell && typeof cell === 'object' && 'v' in cell) {
        const c = cell as { v?: unknown; s?: unknown; t?: unknown; nf?: unknown };
        const out: CellData = { v: String(c.v ?? '') };
        if (typeof c.s === 'string' && c.s) out.s = c.s;
        // Тип и числовой формат обязаны переживать сохранение: без них
        // число после перезагрузки снова становится текстом, а денежный
        // формат теряется — ровно та потеря, ради которой всё затевалось.
        if (typeof c.t === 'string' && TYPES.has(c.t)) out.t = c.t as CellType;
        if (typeof c.nf === 'string' && c.nf) out.nf = c.nf;
        return out;
      }
      return { v: '' };
    }));
  }

  // ── SheetJS style → CSS ────────────────────────────────────────────────────
  // ── OOXML full-style reader ────────────────────────────────────────────────
  // Builds a Map<cellAddr, cssString> by reading raw sheet XML + wb.Styles tables.
  // This gives accurate font/fill/alignment/borders — SheetJS CE's cell.s is incomplete.

  /** Read theme color palette (12 slots) from xl/theme/theme1.xml */
  private xlReadThemeColors(wb: any): string[] {
    const colors: string[] = new Array(12).fill('');
    if (!wb.files) return colors;
    const entry = wb.files['xl/theme/theme1.xml'] ?? wb.files['xl/theme/Theme1.xml'];
    if (!entry) return colors;
    const xml = new TextDecoder().decode(entry.content as Uint8Array);
    const slots = ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
    slots.forEach((slot, i) => {
      const srgb = xml.match(new RegExp(`<a:${slot}[^>]*>\\s*<a:srgbClr val="([0-9A-Fa-f]{6})"`));
      if (srgb) { colors[i] = srgb[1].toLowerCase(); return; }
      const sys = xml.match(new RegExp(`<a:${slot}[^>]*>\\s*<a:sysClr[^>]+lastClr="([0-9A-Fa-f]{6})"`));
      if (sys) colors[i] = sys[1].toLowerCase();
    });
    return colors;
  }

  /** Apply Excel tint/shade to a 6-char hex color (ECMA-376 §18.8.3). */
  private xlTintHex(hex: string, tint: number): string {
    const r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let l = (max+min)/2;
    const s = max === min ? 0 : l <= 0.5 ? (max-min)/(2*l) : (max-min)/(2-2*l);
    const h = max === min ? 0 : max === r ? ((g-b)/(max-min)+6)%6/6 : max === g ? ((b-r)/(max-min)+2)/6 : ((r-g)/(max-min)+4)/6;
    l = tint >= 0 ? l + (1-l)*tint : l*(1+tint);
    l = Math.max(0, Math.min(1, l));
    const hue2rgb = (p: number, q: number, t: number) => { if(t<0)t++;if(t>1)t--;if(t<1/6)return p+(q-p)*6*t;if(t<.5)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p; };
    const q = l < .5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    const nr = s ? hue2rgb(p,q,h+1/3) : l, ng = s ? hue2rgb(p,q,h) : l, nb = s ? hue2rgb(p,q,h-1/3) : l;
    return [nr,ng,nb].map(x => Math.round(x*255).toString(16).padStart(2,'0')).join('');
  }

  /** Resolve OOXML color object {rgb?, theme?, tint?, indexed?} → 6-char hex or null */
  private xlResolveColor(colorObj: any, themeColors: string[]): string | null {
    if (!colorObj) return null;
    if (colorObj.rgb && typeof colorObj.rgb === 'string') {
      const raw = colorObj.rgb;
      const h = raw.length === 8 ? raw.slice(2) : raw;
      if (h.length !== 6) return null;
      const hex = h.toLowerCase();
      const tint = colorObj.tint ? +colorObj.tint : 0;
      return tint ? this.xlTintHex(hex, tint) : hex;
    }
    if (colorObj.theme != null) {
      const base = themeColors[+colorObj.theme] ?? '';
      if (!base) return null;
      const tint = colorObj.tint ? +colorObj.tint : 0;
      return tint ? this.xlTintHex(base, tint) : base;
    }
    return null;
  }

  private xlBuildStyleMap(wb: any, sheetFilePath: string): Map<string, string> {
    const S = wb.Styles;
    if (!S || !wb.files || !sheetFilePath) return new Map();

    const themeColors = this.xlReadThemeColors(wb);

    // Pre-compute CellXf index → CSS string
    const xfCSS: string[] = (S.CellXf || []).map((xf: any) => {
      if (!xf) return '';
      const parts: string[] = [];

      // Background fill
      const fill = S.Fills?.[+xf.fillId];
      if (fill?.patternType === 'solid') {
        const hex = this.xlResolveColor(fill.fgColor, themeColors);
        if (hex && !/^f{6}$/i.test(hex) && !/^0{6}$/.test(hex)) {
          parts.push(`background-color:#${hex}`);
        }
      }

      // Font
      const font = S.Fonts?.[+xf.fontId];
      if (font) {
        if (font.bold)      parts.push('font-weight:bold');
        if (font.italic)    parts.push('font-style:italic');
        if (font.underline) parts.push('text-decoration:underline');
        if (font.strike)    parts.push('text-decoration:line-through');
        const sz = font.sz;
        if (sz) parts.push(`font-size:${Math.round(sz * 1.333)}px`);
        const fname = font.name;
        if (fname) parts.push(`font-family:"${fname}",sans-serif`);
        const hex = this.xlResolveColor(font.color, themeColors);
        if (hex) {
          const lum = 0.299 * parseInt(hex.slice(0,2),16) + 0.587 * parseInt(hex.slice(2,4),16) + 0.114 * parseInt(hex.slice(4,6),16);
          if (lum < 220) parts.push(`color:#${hex}`);
        }
      }

      // Alignment
      const al = xf.alignment;
      if (al) {
        if (al.horizontal === 'center') parts.push('text-align:center');
        else if (al.horizontal === 'right') parts.push('text-align:right');
        if (al.vertical === 'top') parts.push('vertical-align:top');
        else if (al.vertical === 'center') parts.push('vertical-align:middle');
      }

      // Borders
      const border = S.Borders?.[+xf.borderId];
      if (border) {
        for (const side of ['left','right','top','bottom'] as const) {
          const b = border[side];
          if (b?.style && b.style !== 'none' && b.style !== 'hair') {
            const bHex = this.xlResolveColor(b.color, themeColors) ?? '000000';
            const w = (b.style === 'medium' || b.style === 'thick') ? 2 : 1;
            parts.push(`border-${side}:${w}px solid #${bHex}`);
          }
        }
      }

      return parts.join(';');
    });

    // Parse cell style indices from raw sheet XML: <c r="A1" s="3" ...>
    const fileEntry = wb.files[sheetFilePath];
    if (!fileEntry) return new Map();
    const xml = new TextDecoder('utf-8').decode(fileEntry.content as Uint8Array);

    const cellStyleMap = new Map<string, string>();
    const re = /<c\s+([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      const rM = attrs.match(/\br="([A-Z]+\d+)"/);
      const sM = attrs.match(/\bs="(\d+)"/);
      if (rM && sM) {
        const css = xfCSS[parseInt(sM[1])] ?? '';
        if (css) cellStyleMap.set(rM[1], css);
      }
    }
    return cellStyleMap;
  }

  // Resolve SheetNames → xl/worksheets/*.xml paths via workbook.xml.rels
  private xlGetSheetPaths(wb: any): string[] {
    if (!wb.files) return wb.SheetNames.map((_: any, i: number) => `xl/worksheets/sheet${i+1}.xml`);

    const relsEntry = wb.files['xl/_rels/workbook.xml.rels'];
    const wbEntry   = wb.files['xl/workbook.xml'];
    if (!relsEntry || !wbEntry) {
      return wb.SheetNames.map((_: any, i: number) => `xl/worksheets/sheet${i+1}.xml`);
    }

    const relsXml = new TextDecoder().decode(relsEntry.content as Uint8Array);
    const wbXml   = new TextDecoder().decode(wbEntry.content as Uint8Array);

    // rId → absolute path inside zip
    const rIdToPath = new Map<string, string>();
    const relRe = /Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(relsXml)) !== null) {
      // Target is relative to xl/  (rels file is at xl/_rels/)
      const target = m[2].replace(/^\.\.\//, '');
      rIdToPath.set(m[1], `xl/${target}`);
    }

    // Workbook sheet order → rId
    const sheetRIds: string[] = [];
    const shRe = /<sheet\s[^>]*?r:id="([^"]+)"/g;
    while ((m = shRe.exec(wbXml)) !== null) sheetRIds.push(m[1]);

    return sheetRIds.map(rId => rIdToPath.get(rId) ?? '');
  }

  /**
   * Ячейка SheetJS → наша модель.
   *
   * Ключевой момент: берём СЫРОЕ значение (`cell.v`), а не отформатированное
   * (`cell.w`). Иначе число 1234.5 с денежным форматом приезжает строкой
   * «1 234,50 ₽» — и ломает и SUM, и сортировку, и обратный экспорт.
   *
   * Даты остаются серийными числами с датным форматом — ровно так, как их
   * хранит сам Excel; преобразование к виду делает formatCellValue.
   */
  private xlCellFromSheetJS(cell: any): CellData {
    if (!cell) return { v: '' };

    // Формула важнее значения: сохраняем её, кэшированный результат отбрасываем —
    // он всё равно будет пересчитан.
    if (cell.f) {
      const out: CellData = { v: '=' + String(cell.f) };
      if (cell.z && cell.z !== 'General') out.nf = String(cell.z);
      return out;
    }

    if (cell.v == null) return { v: '' };

    const out: CellData = { v: '' };
    if (cell.z && cell.z !== 'General') out.nf = String(cell.z);

    switch (cell.t) {
      case 'n':
        out.v = String(cell.v);
        out.t = 'n';
        break;
      case 'd': {
        // cellDates:false обычно этого не даёт, но подстрахуемся
        const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
        if (!isNaN(d.getTime())) {
          out.v = String(dateToSerial(d));
          out.t = 'n';
          if (!out.nf) out.nf = 'dd.mm.yyyy';
        } else {
          out.v = String(cell.v);
        }
        break;
      }
      case 'b':
        out.v = cell.v ? 'ИСТИНА' : 'ЛОЖЬ';
        out.t = 'b';
        break;
      case 'e':
        // Ошибка вычисления — показываем как есть, форматировать нечего
        out.v = String(cell.w ?? cell.v);
        delete out.nf;
        break;
      default:
        out.v = String(cell.v);
        break;
    }
    return out;
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  private async importFile(file: File): Promise<void> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bare = name.replace(/\.[^.]+$/, '');
    const now = Date.now();

    try {
      if (ext === 'xlsx' || ext === 'xls') {
        const buf = await file.arrayBuffer();
        // bookFiles — сырой XML для полного разбора стилей;
        // cellNF — коды числовых форматов в cell.z;
        // cellFormula — формулы в cell.f;
        // cellDates:false — даты остаются серийными числами, формат разберём сами.
        const wb = XLSX.read(buf, {
          type: 'array',
          cellStyles: true,
          bookFiles: true,
          cellNF: true,
          cellFormula: true,
          cellDates: false,
          sheetRows: MAX_IMPORT_ROWS + 1,
        });

        // Map each sheet index → xl/worksheets/sheetN.xml path
        const sheetPaths = this.xlGetSheetPaths(wb);

        const sheets: SheetData[] = wb.SheetNames.map((sheetName: string, sheetIdx: number) => {
          const ws = wb.Sheets[sheetName];
          if (!ws['!ref']) return { name: sheetName, data: [[{ v: '' }]] };

          // Full style map: cell address → CSS string (from raw OOXML)
          const styleMap = this.xlBuildStyleMap(wb, sheetPaths[sheetIdx] ?? '');

          const range = XLSX.utils.decode_range(ws['!ref']);
          const data: CellData[][] = [];

          for (let r = range.s.r; r <= range.e.r; r++) {
            const row: CellData[] = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = ws[addr];
              const s = styleMap.get(addr) ?? '';
              row.push({ ...this.xlCellFromSheetJS(cell), ...(s ? { s } : {}) });
            }
            data.push(row);
          }

          // Column widths (wpx preferred)
          // Ширины: «width» — исходная величина из файла, wpx — производная,
          // которую SheetJS считает по своему MDW. Берём исходную, иначе
          // колонки сужаются на каждом круге импорт→экспорт.
          const xlCols = ws['!cols'] || [];
          const colWidths: (number | null)[] = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            const ci = xlCols[c];
            colWidths.push(
              ci?.width ? Math.round(ci.width * XL_PX_PER_CH)
              : ci?.wpx ? Math.round(ci.wpx)
              : null);
          }

          // Высоты: hpt — пункты из файла, hpx — пересчёт SheetJS
          const xlRows = ws['!rows'] || [];
          const rowHeights: (number | null)[] = [];
          for (let r = range.s.r; r <= range.e.r; r++) {
            const ri = xlRows[r];
            rowHeights.push(
              ri?.hpt ? Math.round(ri.hpt * XL_PX_PER_PT)
              : ri?.hpx ? Math.round(ri.hpx)
              : null);
          }

          // Merged cells
          const merges: MergeRange[] = (ws['!merges'] ?? []).map((m: any) => ({
            r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c
          }));

          const truncated = data.length > MAX_IMPORT_ROWS;
          if (truncated) data.length = MAX_IMPORT_ROWS;
          return { name: sheetName, data, colWidths, rowHeights, ...(merges.length ? { merges } : {}), ...(truncated ? { truncated: true as const } : {}) };
        });

        this.addDoc({ id: this.newId(), type: 'excel', title: bare, content: JSON.stringify({ sheets }), updated_at: now });
        return;
      }

      if (ext === 'csv') {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, defval: '' }) as any[][];
        const maxCols = Math.max(1, ...rawRows.map(r => r.length));
        const data: CellData[][] = rawRows.map(r => {
          while (r.length < maxCols) r.push('');
          return r.map((v: unknown) => ({ v: v == null ? '' : String(v) }));
        });
        if (!data.length) data.push([{ v: '' }]);
        this.addDoc({ id: this.newId(), type: 'excel', title: bare, content: JSON.stringify({ sheets: [{ name: 'Sheet1', data }] }), updated_at: now });
        return;
      }

      if (ext === 'html' || ext === 'htm') {
        const txt = await file.text();
        const body = txt.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? txt;
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: body, updated_at: now });
        return;
      }

      if (ext === 'txt' || ext === 'md') {
        const txt = await file.text();
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.esc(txt).replace(/\n/g, '<br>'), updated_at: now });
        return;
      }

      if (ext === 'docx') {
        try {
          // @ts-ignore
          const mammoth = (await import('mammoth/mammoth.browser')).default;
          const buf = await file.arrayBuffer();
          const opts = {
            styleMap: [
              "p[style-name='Title'] => h1.doc-title:fresh",
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
              "p[style-name='Heading 4'] => h4:fresh",
              "p[style-name='Quote'] => blockquote:fresh",
              "p[style-name='Intense Quote'] => blockquote.intense:fresh",
              "b => strong", "i => em", "u => u", "strike => s",
              "p[style-name='Centered'] => p.doc-center:fresh",
              "br[type='page'] => div.docx-page-break:fresh",
            ],
            includeDefaultStyleMap: true,
          };
          const result = await mammoth.convertToHtml({ arrayBuffer: buf }, opts);
          this.addDoc({ id: this.newId(), type: 'word', title: bare, content: result.value, updated_at: now });
        } catch (err) {
          showToast('Не удалось прочитать .docx: ' + (err as Error).message, 'error');
        }
        return;
      }

      if (ext === 'doc') {
        try {
          const buf = await file.arrayBuffer();
          const text = await this.docxToText(buf);
          this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.esc(text).replace(/\n/g, '<br>'), updated_at: now });
        } catch {
          showToast('Формат .doc не поддерживается. Пересохрани как .docx или .html.', 'error');
        }
        return;
      }

      showToast(`Неизвестный формат: .${ext}. Поддерживаются: xlsx, xls, csv, html, txt, docx`, 'error');
    } catch (e) {
      debug.warn('[DocsModule] import failed', e);
      showToast('Ошибка при импорте: ' + (e as Error).message, 'error');
    }
  }

  private async docxToText(buf: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buf);
    const xml = await this.unzipEntry(bytes, 'word/document.xml');
    if (!xml) throw new Error('document.xml not found');
    const parts: string[] = [];
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:p[^\/>]*\/?>/g;
    let m;
    while ((m = re.exec(xml))) { if (m[1] != null) parts.push(m[1]); else parts.push('\n'); }
    return parts.join('').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  }

  private async unzipEntry(zip: Uint8Array, path: string): Promise<string | null> {
    const sig = [0x50,0x4b,0x03,0x04];
    for (let i = 0; i < zip.length - 30; i++) {
      if (zip[i]===sig[0]&&zip[i+1]===sig[1]&&zip[i+2]===sig[2]&&zip[i+3]===sig[3]) {
        const dv = new DataView(zip.buffer, zip.byteOffset + i, 30);
        const method = dv.getUint16(8,true), compressed = dv.getUint32(18,true);
        const uncompressed = dv.getUint32(22,true);
        const nameLen = dv.getUint16(26,true), extraLen = dv.getUint16(28,true);
        const name = new TextDecoder().decode(zip.slice(i+30,i+30+nameLen));
        const dataStart = i + 30 + nameLen + extraLen;
        if (name === path) {
          const data = zip.slice(dataStart, dataStart + compressed);
          if (method === 0) return new TextDecoder('utf-8').decode(data);
          if (method === 8) {
            const ds = new (window as any).DecompressionStream('deflate-raw');
            const stream = new Response(new Blob([data])).body!.pipeThrough(ds);
            return new TextDecoder('utf-8').decode(new Uint8Array(await new Response(stream).arrayBuffer()));
          }
        }
        i = dataStart + compressed - 1; void uncompressed;
      }
    }
    return null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  private exportDoc(doc: DocItem, format: string): void {
    if (doc.type === 'excel') {
      const ec = this.parseExcelContent(doc.content);
      if (format === 'xlsx') {
        this.exportExcelXlsx(doc, ec).catch(e => showToast('Ошибка экспорта: ' + e.message, 'error'));
        return;
      } else if (format === 'csv') {
        const sh = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
        // В CSV кладём то, что видит пользователь: серийный номер даты
        // или «1234.5» вместо «1 234,50 ₽» никому не полезны.
        const trimmedCsv = this.trimEmpty(sh.data);
        const values = trimmedCsv.map(r => r.map(c =>
          c.v.startsWith('=')
            ? this.evalFormula(c.v, trimmedCsv)
            : formatCellValue(c.v, c.t, c.nf)));
        const ws = XLSX.utils.aoa_to_sheet(values);
        const csv = XLSX.utils.sheet_to_csv(ws);
        this.download(`${doc.title}.csv`, new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8' }));
      }
      return;
    }
    if (format === 'html') {
      this.download(`${doc.title}.html`, new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${this.esc(doc.title)}</title></head><body>${doc.content}</body></html>`], { type: 'text/html;charset=utf-8' }));
    } else if (format === 'docx') {
      this.exportWordDocx(doc).catch(err => showToast('Ошибка экспорта .docx: ' + err.message, 'error'));
    } else if (format === 'txt') {
      const div = document.createElement('div'); div.innerHTML = doc.content;
      this.download(`${doc.title}.txt`, new Blob([div.innerText], { type: 'text/plain;charset=utf-8' }));
    }
  }

  /** Export Word document as proper .docx (OOXML) using JSZip. */
  private async exportWordDocx(doc: DocItem): Promise<void> {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();

    const { xml: bodyXml, images, links } = this.htmlBodyToWordXml(doc.content);

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  mc:Ignorable="w14">
  <w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr/><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
</w:styles>`;

    const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="hybridMultilevel"/>
    ${[0,1,2,3,4,5,6,7,8].map(i => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720*(i+1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="hybridMultilevel"/>
    ${[0,1,2,3,4,5,6,7,8].map(i => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i+1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720*(i+1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
${[...new Set(images.map(i => i.ext))].map(e =>
  `  <Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('\n')}
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${images.map(i => `  <Relationship Id="${i.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${i.name}"/>`).join('\n')}
${links.map(l => `  <Relationship Id="${l.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${l.url.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}" TargetMode="External"/>`).join('\n')}
</Relationships>`;

    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rootRels);
    zip.file('word/document.xml', docXml);
    zip.file('word/styles.xml', stylesXml);
    zip.file('word/numbering.xml', numberingXml);
    zip.file('word/_rels/document.xml.rels', docRels);
    images.forEach(i => zip.file(`word/media/${i.name}`, i.bytes));

    const blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    this.download(`${doc.title}.docx`, blob);
  }

  /** Convert HTML string to WordprocessingML body content (w:p, w:tbl, etc.). */
  private htmlBodyToWordXml(html: string): {
    xml: string;
    images: Array<{ rid:string; name:string; ext:string; bytes:Uint8Array }>;
    links: Array<{ rid:string; url:string }>;
  } {
    const parser = new DOMParser();
    const dom = parser.parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
    const body = dom.body;

    const ex = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const cssHex = (css: string): string | null => {
      if (!css || css === 'transparent' || css === 'inherit') return null;
      const rgb = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (rgb) {
        // Skip near-transparent rgba
        const alpha = css.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/i);
        if (alpha && parseFloat(alpha[1]) < 0.1) return null;
        return [rgb[1],rgb[2],rgb[3]].map(n => (+n).toString(16).padStart(2,'0')).join('').toUpperCase();
      }
      const h6 = css.match(/^#([0-9a-f]{6})$/i); if (h6) return h6[1].toUpperCase();
      const h3 = css.match(/^#([0-9a-f]{3})$/i); if (h3) { const v=h3[1]; return (v[0]+v[0]+v[1]+v[1]+v[2]+v[2]).toUpperCase(); }
      // Named colors
      const named: Record<string,string> = {black:'000000',white:'FFFFFF',red:'FF0000',green:'008000',blue:'0000FF',yellow:'FFFF00',orange:'FFA500',purple:'800080',gray:'808080',grey:'808080'};
      const lower = css.toLowerCase().trim();
      return named[lower] ?? null;
    };

    // ── Ресурсы документа: картинки и ссылки получают r:id ───────────────
    // styles.xml = rId1, numbering.xml = rId2, поэтому свои начинаем с rId3.
    const images: Array<{ rid:string; name:string; ext:string; bytes:Uint8Array }> = [];
    const links: Array<{ rid:string; url:string }> = [];
    let ridSeq = 2;
    const nextRid = () => `rId${++ridSeq}`;

    const linkMap = new Map<string,string>();
    const addLink = (url: string): string => {
      const hit = linkMap.get(url);
      if (hit) return hit;
      const rid = nextRid();
      links.push({ rid, url });
      linkMap.set(url, rid);
      return rid;
    };

    /** data:-URI → байты. Внешние URL пропускаем: скачать их мы не можем. */
    const dataUriToBytes = (uri: string): { bytes: Uint8Array; ext: string } | null => {
      const m = uri.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);
      if (!m) return null;
      let ext = m[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      if (ext === 'svg+xml') return null; // Word не вставляет SVG как растр
      try {
        const bin = atob(m[2].replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, ext };
      } catch { return null; }
    };

    /** Размер картинки из заголовка файла — атрибутам в HTML доверять нельзя. */
    const imageSize = (b: Uint8Array): { w:number; h:number } | null => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      // PNG: ширина и высота в IHDR
      if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50)
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
      // GIF: в заголовке, little-endian
      if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
        return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
      // JPEG: ищем маркер SOFn
      if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
        let i = 2;
        while (i < b.length - 9) {
          if (b[i] !== 0xFF) { i++; continue; }
          const mk = b[i + 1];
          if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC)
            return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
          i += 2 + ((b[i + 2] << 8) | b[i + 3]);
        }
      }
      return null;
    };

    const EMU_PER_PX = 9525;          // 96 dpi
    const MAX_IMG_PX = 600;           // ширина текстового поля A4 с полями 2.54см

    const imageRun = (img: HTMLImageElement): string => {
      const src = img.getAttribute('src') || '';
      const decoded = dataUriToBytes(src);
      if (!decoded) return '';       // внешнюю ссылку встроить нечем

      const nat = imageSize(decoded.bytes) ?? { w: 400, h: 300 };
      // Явно заданный размер уважаем, иначе берём натуральный
      const attrW = parseFloat(img.getAttribute('width') || img.style?.width || '') || 0;
      const attrH = parseFloat(img.getAttribute('height') || img.style?.height || '') || 0;
      let w = attrW || nat.w;
      let h = attrH || (attrW ? Math.round(attrW * nat.h / nat.w) : nat.h);
      if (w > MAX_IMG_PX) { h = Math.round(h * MAX_IMG_PX / w); w = MAX_IMG_PX; }

      const rid = nextRid();
      const idx = images.length + 1;
      images.push({ rid, name: `image${idx}.${decoded.ext}`, ext: decoded.ext, bytes: decoded.bytes });

      const cx = Math.round(w * EMU_PER_PX), cy = Math.round(h * EMU_PER_PX);
      const alt = ex(img.getAttribute('alt') || `Изображение ${idx}`);
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
        + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
        + `<wp:docPr id="${idx}" name="Picture ${idx}" descr="${alt}"/>`
        + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
        + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
        + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
        + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
        + `<pic:nvPicPr><pic:cNvPr id="${idx}" name="${images[idx-1].name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
        + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    };

    interface RP { bold?:boolean; italic?:boolean; under?:boolean; strike?:boolean; sz?:number; color?:string; bg?:string; font?:string; }

    // b wins over undefined; if both defined, b (child/more specific) wins
    const mergeRP = (a: RP, b: RP): RP => ({
      bold:   b.bold   ?? a.bold,
      italic: b.italic ?? a.italic,
      under:  b.under  ?? a.under,
      strike: b.strike ?? a.strike,
      sz:     b.sz     ?? a.sz,
      color:  b.color  ?? a.color,
      bg:     b.bg     ?? a.bg,
      font:   b.font   ?? a.font,
    });

    const rpFromEl = (el: Element): RP => {
      const rp: RP = {};
      const tag = el.tagName.toLowerCase();
      const st  = (el as HTMLElement).style;
      if (tag==='b'||tag==='strong') rp.bold=true;
      if (tag==='i'||tag==='em')     rp.italic=true;
      if (tag==='u')                 rp.under=true;
      if (tag==='s'||tag==='strike'||tag==='del') rp.strike=true;
      if (tag==='mark') rp.bg='FFFF00';
      const fw=st?.fontWeight; if(fw==='bold'||parseInt(fw)>=700) rp.bold=true;
      const fi=st?.fontStyle;  if(fi==='italic'||fi==='oblique') rp.italic=true;
      const td=st?.textDecoration||'';
      if(td.includes('underline'))    rp.under=true;
      if(td.includes('line-through')) rp.strike=true;
      if(st?.fontSize) { const px=parseFloat(st.fontSize); if(!isNaN(px) && px>0) rp.sz=Math.round(px*1.5); }
      if(st?.color) { const h=cssHex(st.color); if(h) rp.color=h; }
      if(st?.backgroundColor) { const h=cssHex(st.backgroundColor); if(h && h!=='FFFFFF') rp.bg=h; }
      if(st?.fontFamily) { const n=st.fontFamily.split(',')[0].trim().replace(/['"]/g,''); if(n) rp.font=n; }
      return rp;
    };

    const rprXml = (rp: RP): string => {
      let x='';
      if(rp.font)   x+=`<w:rFonts w:ascii="${ex(rp.font)}" w:hAnsi="${ex(rp.font)}" w:cs="${ex(rp.font)}"/>`;
      if(rp.sz)     x+=`<w:sz w:val="${rp.sz}"/><w:szCs w:val="${rp.sz}"/>`;
      if(rp.bold)   x+='<w:b/><w:bCs/>';
      if(rp.italic) x+='<w:i/><w:iCs/>';
      if(rp.under)  x+='<w:u w:val="single"/>';
      if(rp.strike) x+='<w:strike/>';
      if(rp.color && rp.color!=='000000') x+=`<w:color w:val="${rp.color}"/>`;
      if(rp.bg)     x+=`<w:highlight w:val="none"/><w:shd w:val="clear" w:color="auto" w:fill="${rp.bg}"/>`;
      return x ? `<w:rPr>${x}</w:rPr>` : '';
    };

    // Collect inline runs from a node tree, inheriting rp from parent
    const collectRuns = (node: Node, rp: RP): string => {
      if (node.nodeType===Node.TEXT_NODE) {
        // Normalize newlines that are just HTML source formatting, not meaningful whitespace
        const raw = node.textContent ?? '';
        const t = raw.replace(/[\r\n]/g, ' ');
        if (!t) return '';
        return `<w:r>${rprXml(rp)}<w:t xml:space="preserve">${ex(t)}</w:t></w:r>`;
      }
      if (node.nodeType!==Node.ELEMENT_NODE) return '';
      const el=node as Element; const tag=el.tagName.toLowerCase();
      if (tag==='br') return '<w:r><w:br/></w:r>';
      if (tag==='script'||tag==='style') return '';
      if (tag==='img') return imageRun(el as HTMLImageElement);

      // Ссылка — отдельный контейнер с r:id, иначе в Word остаётся
      // только текст, а адрес пропадает
      if (tag==='a') {
        const href=(el as HTMLAnchorElement).getAttribute('href')||'';
        const inner=Array.from(el.childNodes)
          .map(c=>collectRuns(c, mergeRP(rp, mergeRP({color:'0563C1',under:true}, rpFromEl(el)))))
          .join('');
        if(!inner) return '';
        if(!/^(https?:|mailto:|tel:|ftp:)/i.test(href)) return inner;
        const rid=addLink(href);
        return `<w:hyperlink r:id="${rid}">${inner}</w:hyperlink>`;
      }

      if (tag==='sub') return Array.from(el.childNodes).map(c=>collectRuns(c,mergeRP(rp,rpFromEl(el)))).join('')
        .replace(/<w:rPr>/g,'<w:rPr><w:vertAlign w:val="subscript"/>')
        .replace(/<w:r>(?!<w:rPr>)/g,'<w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr>');
      if (tag==='sup') return Array.from(el.childNodes).map(c=>collectRuns(c,mergeRP(rp,rpFromEl(el)))).join('')
        .replace(/<w:rPr>/g,'<w:rPr><w:vertAlign w:val="superscript"/>')
        .replace(/<w:r>(?!<w:rPr>)/g,'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>');

      // Don't recurse into block-like elements that escaped into inline context
      const merged=mergeRP(rp, rpFromEl(el));
      return Array.from(el.childNodes).map(c=>collectRuns(c,merged)).join('');
    };

    const BLOCK_TAGS = new Set(['p','div','h1','h2','h3','h4','h5','h6','blockquote','pre','article','section','header','footer','main','nav','aside','li','address','figure','figcaption']);

    // Build paragraph properties XML including paragraph-level background
    const pprXml = (el: Element, bgHex: string|null, lstStyle?: 'bullet'|'num', lvl=0): string => {
      let pp='';
      const tag=el.tagName.toLowerCase();
      const st=(el as HTMLElement).style;
      const m=/^h([1-6])$/.exec(tag);
      if(m && !lstStyle) pp+=`<w:pStyle w:val="Heading${m[1]}"/>`;
      if(lstStyle) {
        const numId=lstStyle==='bullet'?'1':'2';
        if(!m) pp+=`<w:pStyle w:val="ListParagraph"/>`;
        pp+=`<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
      }
      const align=st?.textAlign;
      if(align==='center') pp+='<w:jc w:val="center"/>';
      else if(align==='right') pp+='<w:jc w:val="right"/>';
      else if(align==='justify') pp+='<w:jc w:val="both"/>';
      // Paragraph background (full paragraph shading — more faithful than run shading)
      if(bgHex && bgHex!=='FFFFFF') pp+=`<w:shd w:val="clear" w:color="auto" w:fill="${bgHex}"/>`;
      // Paragraph spacing — honour margin-bottom/top
      const mbPx = parseFloat(st?.marginBottom||'0'); const mtPx = parseFloat(st?.marginTop||'0');
      if(mbPx>0||mtPx>0) pp+=`<w:spacing w:before="${Math.round(mtPx*15)}" w:after="${Math.round(mbPx*15)}"/>`;
      return pp ? `<w:pPr>${pp}</w:pPr>` : '';
    };

    // Check if a node is only br / whitespace
    const isEmptyBlock = (el: Element): boolean => {
      const kids = Array.from(el.childNodes);
      if(kids.length===0) return true;
      return kids.every(k => {
        if(k.nodeType===Node.TEXT_NODE) return !(k.textContent??'').trim();
        if(k.nodeType===Node.ELEMENT_NODE) return (k as Element).tagName.toLowerCase()==='br';
        return true;
      });
    };

    let out = '';

    // inheritedRP: styles from ancestor block elements (colour, font, etc.)
    const processBlock = (node: Node, inheritedRP: RP = {}, lstStyle?: 'bullet'|'num', lvl=0): void => {
      if (node.nodeType===Node.TEXT_NODE) {
        const t=(node.textContent??'').replace(/[\r\n]/g,' ');
        if(t.trim()) {
          const rpr = rprXml(inheritedRP);
          out+=`<w:p>${rpr?`<w:r>${rpr}<w:t xml:space="preserve">${ex(t)}</w:t></w:r>`:''}</w:p>`;
        }
        return;
      }
      if (node.nodeType!==Node.ELEMENT_NODE) return;
      const el=node as Element; const tag=el.tagName.toLowerCase();

      if(tag==='table') { out+=processTable(el, inheritedRP); return; }
      if(tag==='ul') { Array.from(el.childNodes).forEach(c=>processBlock(c, inheritedRP,'bullet',lvl)); return; }
      if(tag==='ol') { Array.from(el.childNodes).forEach(c=>processBlock(c, inheritedRP,'num',lvl)); return; }

      if(BLOCK_TAGS.has(tag)) {
        // Merge this element's own props into inherited for children
        const elRP = rpFromEl(el);
        const childRP = mergeRP(inheritedRP, elRP);

        // Detect paragraph background at this block level
        const bgCss=(el as HTMLElement).style?.backgroundColor;
        const bgHex=bgCss?cssHex(bgCss):null;
        // Effective bg = own or inherited (rough: only own for paragraph shading)
        const effectiveBg = (bgHex && bgHex!=='FFFFFF') ? bgHex : null;

        const kids=Array.from(el.childNodes);
        const hasBlock=kids.some(c=>{
          if(c.nodeType!==Node.ELEMENT_NODE) return false;
          const ct=(c as Element).tagName.toLowerCase();
          return BLOCK_TAGS.has(ct)||ct==='table'||ct==='ul'||ct==='ol';
        });

        if(hasBlock) {
          // Container element — recurse, passing our merged props down
          kids.forEach(c=>processBlock(c, childRP, lstStyle, lvl));
          return;
        }

        // Leaf block → emit paragraph
        if(isEmptyBlock(el)) { out+='<w:p/>'; return; }

        const pp=pprXml(el, effectiveBg, lstStyle, lvl);
        // Start collectRuns with childRP so parent-inherited styles apply to runs
        const runs=collectRuns(el, childRP);
        out+=`<w:p>${pp}${runs}</w:p>`;
        return;
      }

      // Bare <br> or inline at body level
      if(tag==='br') { out+='<w:p/>'; return; }
      const runs=collectRuns(el, inheritedRP);
      if(runs) out+=`<w:p>${runs}</w:p>`;
    };

    const processTable = (table: Element, inheritedRP: RP): string => {
      const borders='<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>';
      let txml=`<w:tbl><w:tblPr>${borders}<w:tblW w:w="0" w:type="auto"/></w:tblPr>`;
      table.querySelectorAll(':scope > * tr, :scope > tr').forEach(tr=>{
        txml+='<w:tr>';
        tr.querySelectorAll(':scope > td, :scope > th').forEach(td=>{
          const isHdr=td.tagName.toLowerCase()==='th';
          const bgCss=(td as HTMLElement).style?.backgroundColor;
          const bgHex=bgCss?cssHex(bgCss):null;
          const bgTd=bgHex&&bgHex!=='FFFFFF'?bgHex:null;
          const tcPr=bgTd?`<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${bgTd}"/></w:tcPr>`:'';
          const cellRP=mergeRP(inheritedRP, isHdr?{bold:true}:{});
          // Collect sub-blocks inside cell
          let cellXml='';
          const cellKids=Array.from(td.childNodes);
          const hasCellBlock=cellKids.some(c=>{
            if(c.nodeType!==Node.ELEMENT_NODE)return false;
            const ct=(c as Element).tagName.toLowerCase();
            return BLOCK_TAGS.has(ct)||ct==='table'||ct==='ul'||ct==='ol';
          });
          if(hasCellBlock) {
            const savedOut=out; out='';
            cellKids.forEach(c=>processBlock(c,cellRP));
            cellXml=out||'<w:p/>';
            out=savedOut;
          } else {
            cellXml=`<w:p>${collectRuns(td,cellRP)}</w:p>`;
          }
          txml+=`<w:tc>${tcPr}${cellXml}</w:tc>`;
        });
        txml+='</w:tr>';
      });
      return txml+'</w:tbl>';
    };

    Array.from(body.childNodes).forEach(c=>processBlock(c, {}));
    return { xml: out || '<w:p/>', images, links };
  }

  // ── Excel OOXML Export via JSZip (SheetJS CE cannot write cell styles) ────
  private async exportExcelXlsx(doc: DocItem, ec: ExcelContent): Promise<void> {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const ex = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // ── CSS → normalised style properties ──────────────────────────────────
    interface XFont { name?:string; sz?:number; bold?:boolean; italic?:boolean; under?:boolean; strike?:boolean; color?:string; }
    interface XAlign { h?:string; v?:string; }
    interface XStyle { font?:XFont; fillColor?:string; border?: { left?:[string,string]; right?:[string,string]; top?:[string,string]; bottom?:[string,string] }; align?:XAlign; }

    const parseCssToXl = (css: string): XStyle => {
      if (!css) return {};
      const props: Record<string,string> = {};
      css.split(';').forEach(p => { const i=p.indexOf(':'); if(i<0) return; const k=p.slice(0,i).trim().toLowerCase(),v=p.slice(i+1).trim(); if(k) props[k]=v; });
      const toArgb = (v: string): string|null => {
        const h6=v.match(/^#([0-9a-f]{6})$/i); if(h6) return 'FF'+h6[1].toUpperCase();
        const h3=v.match(/^#([0-9a-f]{3})$/i); if(h3){const c=h3[1];return 'FF'+(c[0]+c[0]+c[1]+c[1]+c[2]+c[2]).toUpperCase();}
        const rgb=v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i); if(rgb) return 'FF'+[rgb[1],rgb[2],rgb[3]].map(n=>(+n).toString(16).padStart(2,'0')).join('').toUpperCase();
        return null;
      };
      const parseBorder = (v: string): [string,string]|undefined => {
        if(!v||v==='none'||/^0\s/.test(v)) return undefined;
        const cm=v.match(/#([0-9a-f]{6})/i);
        const w=parseFloat(v);
        const style = w>=2?'medium':w>=1?'thin':'hair';
        return [style, 'FF'+(cm?cm[1].toUpperCase():'000000')];
      };
      const st: XStyle = {};
      for(const [k,v] of Object.entries(props)) {
        switch(k) {
          case 'background-color': case 'background': { const c=toArgb(v.split(/\s+/)[0]); if(c&&c!=='FFFFFFFF'&&c!=='FF000000') { st.fillColor=c; } break; }
          case 'color':           { const c=toArgb(v); if(c) { st.font??={}; st.font.color=c; } break; }
          case 'font-weight':     if(v==='bold'||+v>=700){st.font??={};st.font.bold=true;} break;
          case 'font-style':      if(v==='italic'){st.font??={};st.font.italic=true;} break;
          case 'text-decoration': if(v.includes('underline')){st.font??={};st.font.under=true;} if(v.includes('line-through')){st.font??={};st.font.strike=true;} break;
          case 'font-size':       { const px=parseFloat(v); if(!isNaN(px)&&px>0){st.font??={};st.font.sz=Math.max(6,Math.round(px/1.333));} break; }
          case 'font-family':     { const n=v.split(',')[0].trim().replace(/['"]/g,''); if(n){st.font??={};st.font.name=n;} break; }
          case 'text-align':      { const h=v==='justify'?'distributed':v; if(['left','center','right','distributed'].includes(h)){st.align??={};st.align.h=h;} break; }
          case 'vertical-align':  { const vv=v==='middle'?'center':v; if(['top','center','bottom'].includes(vv)){st.align??={};st.align.v=vv;} break; }
          case 'border':          { const b=parseBorder(v); if(b){st.border??={};st.border.left=st.border.right=st.border.top=st.border.bottom=b;} break; }
          case 'border-left':     { const b=parseBorder(v); if(b){st.border??={};st.border.left=b;} break; }
          case 'border-right':    { const b=parseBorder(v); if(b){st.border??={};st.border.right=b;} break; }
          case 'border-top':      { const b=parseBorder(v); if(b){st.border??={};st.border.top=b;} break; }
          case 'border-bottom':   { const b=parseBorder(v); if(b){st.border??={};st.border.bottom=b;} break; }
        }
      }
      return st;
    };

    // ── Deduplicate fonts / fills / borders → indices ───────────────────────
    const fonts: XFont[] = [{ name:'Calibri', sz:11 }]; // 0 = default
    const fills: Array<string|null> = [null, null];      // 0=none, 1=gray125 (OOXML required)
    const borders: Array<XStyle['border']|null> = [null];// 0 = no border
    const fntMap = new Map<string,number>([['',0]]);
    const fllMap = new Map<string,number>([['',0]]);
    const brdMap = new Map<string,number>([['',0]]);

    const addFont = (f?: XFont): number => { const k=JSON.stringify(f||{}); if(fntMap.has(k)) return fntMap.get(k)!; const i=fonts.length; fonts.push(f||{}); fntMap.set(k,i); return i; };
    const addFill = (c?: string): number => { if(!c) return 0; if(fllMap.has(c)) return fllMap.get(c)!; const i=fills.length; fills.push(c); fllMap.set(c,i); return i; };
    const addBorder = (b?: XStyle['border']): number => { const k=JSON.stringify(b||null); if(brdMap.has(k)) return brdMap.get(k)!; const i=borders.length; borders.push(b||null); brdMap.set(k,i); return i; };

    // Числовые форматы: встроенные id 0…163 зарезервированы, свои начинаем со 164
    const numFmts: string[] = [];
    const nfMap = new Map<string,number>();
    const addNumFmt = (code?: string): number => {
      if(!code || code === 'General') return 0;
      const hit = nfMap.get(code);
      if(hit != null) return hit;
      const id = 164 + numFmts.length;
      numFmts.push(code); nfMap.set(code, id); return id;
    };

    // cellXfs: index 0 = default (no style)
    interface XF { fId:number; lId:number; bId:number; nId:number; align?:XAlign; }
    const xfs: XF[] = [{ fId:0, lId:0, bId:0, nId:0 }];
    const xfMap = new Map<string,number>([['|',0]]);

    // Стиль ячейки в xlsx — это пара «оформление + числовой формат»,
    // поэтому ключом дедупликации служат оба.
    const getXfIdx = (css: string|undefined, nf?: string): number => {
      const key = (css||'') + '|' + (nf||'');
      const hit = xfMap.get(key);
      if(hit != null) return hit;
      const st = parseCssToXl(css||'');
      const xf: XF = {
        fId: addFont(st.font),
        lId: addFill(st.fillColor),
        bId: addBorder(st.border),
        nId: addNumFmt(nf),
        ...(st.align?{align:st.align}:{}),
      };
      const idx = xfs.length; xfs.push(xf); xfMap.set(key,idx); return idx;
    };

    // Предпроход: наполняем таблицы стилей в детерминированном порядке
    ec.sheets.forEach(sh => sh.data.forEach(row => row.forEach(cell => {
      if(cell.s || cell.nf) getXfIdx(cell.s, cell.nf);
    })));

    // ── Build styles.xml ────────────────────────────────────────────────────
    const fntXml = (f: XFont) => {
      // Скобки обязательны: тернарник связывает слабее «+», без них
      // жирный шрифт съедал курсив, подчёркивание и зачёркивание.
      let x = (f.bold?'<b/>':'') + (f.italic?'<i/>':'') + (f.under?'<u/>':'') + (f.strike?'<strike/>':'');
      if(f.color) x+=`<color rgb="${f.color}"/>`;
      x+=`<sz val="${f.sz??11}"/><name val="${ex(f.name??'Calibri')}"/>`;
      return `<font>${x}</font>`;
    };
    const fillXml = (c: string|null, i: number) => {
      if(i===0) return '<fill><patternFill patternType="none"/></fill>';
      if(i===1) return '<fill><patternFill patternType="gray125"/></fill>';
      if(!c)    return '<fill><patternFill patternType="none"/></fill>';
      return `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`;
    };
    const brdSide = (b?: [string,string], tag='left') => b ? `<${tag} style="${b[0]}"><color rgb="${b[1]}"/></${tag}>` : `<${tag}/>`;
    const brdXml = (b: XStyle['border']|null) => b
      ? `<border>${brdSide(b.left,'left')}${brdSide(b.right,'right')}${brdSide(b.top,'top')}${brdSide(b.bottom,'bottom')}<diagonal/></border>`
      : '<border><left/><right/><top/><bottom/><diagonal/></border>';
    const xfXml  = (xf: XF, base=false) => {
      const app = base?'':' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"'
        + (xf.nId?' applyNumberFormat="1"':'');
      const al = xf.align ? `<alignment${xf.align.h?` horizontal="${xf.align.h}"`:''}${xf.align.v?` vertical="${xf.align.v}"`:''}/>` : '';
      return `<xf numFmtId="${xf.nId}" fontId="${xf.fId}" fillId="${xf.lId}" borderId="${xf.bId}" xfId="0"${app}>${al}</xf>`;
    };
    const numFmtsXml = numFmts.length
      ? `<numFmts count="${numFmts.length}">${numFmts.map((code,i)=>`<numFmt numFmtId="${164+i}" formatCode="${ex(code)}"/>`).join('')}</numFmts>`
      : '';

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmtsXml}<fonts count="${fonts.length}">${fonts.map(fntXml).join('')}</fonts>
<fills count="${fills.length}">${fills.map((c,i)=>fillXml(c,i)).join('')}</fills>
<borders count="${borders.length}">${borders.map(brdXml).join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.map((xf,i)=>xfXml(xf,i===0)).join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    // ── Build worksheets ────────────────────────────────────────────────────
    const colLtr = (n: number): string => {
      let s=''; n++;
      while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}
      return s;
    };

    const sheetXmls: string[] = [];
    ec.sheets.forEach(sh => {
      const trimmed = this.trimEmpty(sh.data);
      const numCols = trimmed.reduce((m,r)=>Math.max(m,r.length),0);
      const colWidths = sh.colWidths??[];
      const rowHeights = sh.rowHeights??[];

      // <cols>
      // Ширина в OOXML измеряется в «ширинах нуля» шрифта по умолчанию.
      // XL_PX_PER_CH — тот же коэффициент, что и при импорте, иначе колонки
      // ужимаются на каждом круге экспорт→импорт.
      let colsXml='';
      if(colWidths.some(w=>w!=null)) {
        const parts=colWidths.slice(0,numCols).map((w,i)=>w?`<col min="${i+1}" max="${i+1}" width="${(w/XL_PX_PER_CH).toFixed(2)}" customWidth="1"/>`:null).filter(Boolean);
        if(parts.length) colsXml=`<cols>${parts.join('')}</cols>`;
      }

      // <sheetData>
      let rowsXml='';
      trimmed.forEach((row,rIdx)=>{
        // ht задаётся в пунктах, а мы храним пиксели — без перевода строки
        // раздувались бы в полтора раза на каждом экспорте.
        const h=rowHeights[rIdx];
        const rowAttr=h?` ht="${(h/XL_PX_PER_PT).toFixed(2)}" customHeight="1"`:'';
        let cells='';
        row.forEach((cell,cIdx)=>{
          const ref=colLtr(cIdx)+(rIdx+1);
          const sIdx=getXfIdx(cell.s, cell.nf);
          const sAttr=sIdx?` s="${sIdx}"`:' s="0"';
          const v=cell.v??'';
          if(!v&&!sIdx) return;
          if(!v) { cells+=`<c r="${ref}"${sAttr}/>`; return; }

          if(v.startsWith('=')) {
            // Формулу отдаём вместе с посчитанным значением: без кэша Excel
            // покажет пустую ячейку, пока пользователь не нажмёт пересчёт.
            const calc=this.evalFormula(v, trimmed);
            const cn=Number(calc);
            if(calc!=='' && !calc.startsWith('#') && !isNaN(cn) && isFinite(cn))
              cells+=`<c r="${ref}"${sAttr}><f>${ex(v.slice(1))}</f><v>${cn}</v></c>`;
            else
              cells+=`<c r="${ref}" t="str"${sAttr}><f>${ex(v.slice(1))}</f><v>${ex(calc)}</v></c>`;
            return;
          }

          // Число пишем числом — тогда Excel считает по нему, а не показывает
          // предупреждение «число сохранено как текст».
          if(cell.t==='n') {
            const n=Number(v);
            if(!isNaN(n) && isFinite(n)) { cells+=`<c r="${ref}"${sAttr}><v>${n}</v></c>`; return; }
          }
          if(cell.t==='b') {
            cells+=`<c r="${ref}" t="b"${sAttr}><v>${/^(1|true|истина)$/i.test(v)?1:0}</v></c>`;
            return;
          }
          cells+=`<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${ex(v)}</t></is></c>`;
        });
        if(cells||h!=null) rowsXml+=`<row r="${rIdx+1}"${rowAttr}>${cells}</row>`;
      });

      // <mergeCells>
      let mergesXml='';
      const validMerges=(sh.merges??[]).filter(m=>m.r2<trimmed.length&&m.c2<numCols);
      if(validMerges.length) mergesXml=`<mergeCells count="${validMerges.length}">${validMerges.map(m=>`<mergeCell ref="${colLtr(m.c1)}${m.r1+1}:${colLtr(m.c2)}${m.r2+1}"/>`).join('')}</mergeCells>`;

      sheetXmls.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView tabSelected="0" workbookViewId="0"/></sheetViews>
${colsXml}<sheetData>${rowsXml}</sheetData>${mergesXml}
</worksheet>`);
    });

    // ── Workbook, Content Types, Relationships ──────────────────────────────
    const wbXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${ec.sheets.map((sh,i)=>`<sheet name="${ex(sh.name)}" sheetId="${i+1}" r:id="rId${i+2}"/>`).join('')}</sheets>
</workbook>`;
    const ctXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${ec.sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`;
    const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const wbRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${ec.sheets.map((_,i)=>`<Relationship Id="rId${i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}
</Relationships>`;

    zip.file('[Content_Types].xml', ctXml);
    zip.file('_rels/.rels', rootRels);
    zip.file('xl/workbook.xml', wbXml);
    zip.file('xl/styles.xml', stylesXml);
    zip.file('xl/_rels/workbook.xml.rels', wbRels);
    sheetXmls.forEach((xml,i) => zip.file(`xl/worksheets/sheet${i+1}.xml`, xml));

    const blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
    });
    this.download(`${doc.title}.xlsx`, blob);
  }

  private trimEmpty(rows: CellData[][]): CellData[][] {
    let lastRow = rows.length;
    while (lastRow > 0 && rows[lastRow-1].every(c => !c.v)) lastRow--;
    let lastCol = 0;
    for (let r = 0; r < lastRow; r++) for (let c = rows[r].length-1; c >= 0; c--) { if (rows[r][c].v) { if (c+1>lastCol) lastCol=c+1; break; } }
    return rows.slice(0, lastRow).map(r => r.slice(0, Math.max(1, lastCol)));
  }

  private download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  private render(): void {
    this.invalidateFormulas();
    document.getElementById('dx-fill-handle')?.remove();
    const active = this.docs.find(d => d.id === this.activeId) ?? null;
    this.root.innerHTML = `
      <div class="docs-shell${this.isFullscreen ? ' docs-fullscreen' : ''}">
        <div class="docs-fs-bar">
          <button class="docs-fs-back-btn" id="docs-fs-back">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            Назад
          </button>
          <div class="docs-fs-tabs-wrap">${this.renderTabs()}</div>
          <div class="docs-fs-spacer"></div>
          <button class="docs-fs-sima-btn" id="docs-fs-sima">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none"><rect x="3" y="10" width="2.5" height="4" rx="1.2" fill="rgba(200,160,255,0.9)"/><rect x="7" y="7" width="2.5" height="10" rx="1.2" fill="rgba(200,160,255,0.9)"/><rect x="11" y="4" width="2.5" height="16" rx="1.2" fill="rgba(200,160,255,0.9)"/><rect x="15" y="7" width="2.5" height="10" rx="1.2" fill="rgba(200,160,255,0.9)"/><rect x="19" y="10" width="2.5" height="4" rx="1.2" fill="rgba(200,160,255,0.9)"/></svg>
            Сима
          </button>
        </div>
        <div class="docs-topbar">
          <div class="docs-tabs" id="docs-tabs">${this.renderTabs()}</div>
          <div class="docs-newbtns">
            ${this.recent.length > 0 ? `
            <div class="docs-recent-wrap" id="docs-recent-wrap">
              <button class="docs-newbtn" id="docs-recent-toggle" title="Недавние файлы">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Недавние
              </button>
              <div class="docs-recent-popup" id="docs-recent-popup">
                <div class="docs-recent-head"><span>Недавние</span><span class="docs-recent-note" title="История хранится только в браузере этого компьютера">⚠ Только на этом ПК</span></div>
                ${this.renderRecentRows()}
              </div>
            </div>` : ''}
            <button class="docs-newbtn" id="docs-open-file" title="Открыть файл">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Открыть
            </button>
            <button class="docs-newbtn" id="docs-new-word" title="Новый Word">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
              Word
            </button>
            <button class="docs-newbtn" id="docs-new-excel" title="Новый Excel">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
              Excel
            </button>
            <input type="file" id="docs-file-input" accept=".xlsx,.xls,.csv,.html,.htm,.txt,.md,.docx" style="display:none">
          </div>
        </div>
        <div class="docs-body" id="docs-body">
          ${active ? this.renderEditor(active) : this.renderEmpty()}
        </div>
      </div>
    `;
    this.bindTopbar();
    if (active) this.bindEditor(active);
  }

  private renderTabs(): string {
    if (!this.docs.length) return '<div class="docs-hint">Нет открытых документов</div>';
    return this.docs.map(d => {
      const active = d.id === this.activeId ? 'active' : '';
      const icon = d.type === 'word'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>';
      return `<div class="docs-tab ${active}" data-id="${d.id}">
        <span class="docs-tab-ic">${icon}</span>
        <span class="docs-tab-title">${this.esc(d.title)}</span>
        <button class="docs-tab-close" data-close="${d.id}" title="Закрыть">×</button>
      </div>`;
    }).join('');
  }

  private renderRecentRows(): string {
    const rows = this.recent.map(r => {
      const alreadyOpen = this.docs.some(d => d.id === r.id);
      const icon = r.type === 'word'
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>';
      const date = new Date(r.updated_at).toLocaleDateString('ru-RU', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
      return `<div class="docs-recent-row${alreadyOpen?' docs-recent-open':''}" data-recent-id="${r.id}" data-recent-type="${r.type}" title="${alreadyOpen?'Переключиться':'Открыть'}">
        <span class="docs-recent-ic">${icon}</span>
        <span class="docs-recent-info">
          <span class="docs-recent-title">${this.esc(r.title)}</span>
          <span class="docs-recent-date">${date}</span>
        </span>
        ${alreadyOpen ? '<span class="docs-recent-badge">открыт</span>' : ''}
        <button class="docs-recent-del" data-del-recent="${r.id}" title="Удалить из недавних">×</button>
      </div>`;
    }).join('');
    return `<div class="docs-recent-list">${rows}</div>`;
  }

  private removeRecent(id: string): void {
    this.recent = this.recent.filter(r => r.id !== id);
    this.saveRecent();
    this.render();
  }

  private renderEmpty(): string {
    const recentHtml = this.recent.length > 0 ? `
      <div class="docs-recent">
        <div class="docs-recent-head">
          <span>Недавние</span>
          <span class="docs-recent-note" title="История хранится только в браузере этого компьютера">⚠ Только на этом ПК</span>
        </div>
        ${this.renderRecentRows()}
      </div>` : '';
    return `<div class="docs-empty">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
      <div class="docs-empty-title">Нет открытых документов</div>
      <div class="docs-empty-sub">Создайте новый или откройте файл сверху.<br>Автосохраняются последние ${MAX_DOCS} документов.</div>
      ${recentHtml}
    </div>`;
  }

  private renderEditor(doc: DocItem): string {
    const editor = doc.type === 'word' ? this.renderWord(doc) : this.renderExcel(doc);
    const exportMenu = doc.type === 'word'
      ? `<option value="docx">Word (.docx)</option><option value="html">HTML</option><option value="txt">Текст</option>`
      : `<option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option>`;
    return `<div class="docs-editor-wrap">
      <div class="docs-editor-head">
        <input class="docs-title-inp" id="docs-title-inp" value="${this.esc(doc.title)}" data-id="${doc.id}">
        <div class="docs-editor-actions">
          <span class="docs-badge">${doc.type === 'word' ? 'Word' : 'Excel'}</span>
          <select class="docs-export-sel" id="docs-export-sel"><option value="">Экспорт…</option>${exportMenu}</select>
          <button class="docs-fs-expand-btn" id="docs-fs-btn" title="Полный экран">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3"/></svg>
          </button>
          <button class="docs-icon-btn" id="docs-delete-btn" title="Удалить">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
      ${editor}
    </div>`;
  }

  // ── Word ───────────────────────────────────────────────────────────────────
  private renderWord(doc: DocItem): string {
    const T = (cmd: string, title: string, content: string) =>
      `<button class="dw-tool" data-cmd="${cmd}" title="${title}">${content}</button>`;
    const SVG = (d: string, w = 14) =>
      `<svg viewBox="0 0 16 16" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.6">${d}</svg>`;
    return `
    <div class="docs-word-toolbar">
      <div class="dw-group">
        <button class="dw-tool" data-cmd="undo" title="Отменить (Ctrl+Z)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>
        </button>
        <button class="dw-tool" data-cmd="redo" title="Повторить (Ctrl+Y)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7l3 2.7"/></svg>
        </button>
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        <select class="dw-select dw-font-sel" data-cmd-font title="Шрифт">
          <option value="">Шрифт</option>
          <option value="Calibri, sans-serif">Calibri</option>
          <option value="Arial, sans-serif">Arial</option>
          <option value="'Times New Roman', serif">Times New Roman</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="Verdana, sans-serif">Verdana</option>
          <option value="'Courier New', monospace">Courier New</option>
          <option value="'DM Sans', sans-serif">DM Sans</option>
        </select>
        <select class="dw-select dw-ptsize-sel" data-cmd-size title="Размер (пт)">
          <option value="">Размер</option>
          <option value="8pt">8</option><option value="9pt">9</option>
          <option value="10pt">10</option><option value="11pt">11</option>
          <option value="12pt">12</option><option value="14pt">14</option>
          <option value="16pt">16</option><option value="18pt">18</option>
          <option value="20pt">20</option><option value="24pt">24</option>
          <option value="28pt">28</option><option value="36pt">36</option>
          <option value="48pt">48</option><option value="72pt">72</option>
        </select>
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        <button class="dw-tool dw-b" data-cmd="bold" title="Жирный (Ctrl+B)"><b style="font-size:13px;font-family:serif">B</b></button>
        <button class="dw-tool dw-i" data-cmd="italic" title="Курсив (Ctrl+I)"><i style="font-size:13px;font-family:serif;font-style:italic">I</i></button>
        <button class="dw-tool dw-u" data-cmd="underline" title="Подчёркнутый (Ctrl+U)"><u style="font-size:13px;font-family:serif">U</u></button>
        <button class="dw-tool" data-cmd="strikeThrough" title="Зачёркнутый"><s style="font-size:13px;font-family:serif">S</s></button>
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        <label class="dw-color-lbl" title="Цвет текста">
          <div class="dw-color-ic"><span style="font-size:12px;font-family:serif;font-weight:700;line-height:1">A</span><span class="dw-fg-bar"></span></div>
          <input type="color" data-color value="#111111">
        </label>
        <label class="dw-color-lbl" title="Выделение текста">
          <div class="dw-color-ic"><span style="font-size:11px;line-height:1">H</span><span class="dw-hi-bar"></span></div>
          <input type="color" data-hilite value="#ffff00">
        </label>
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        ${T('justifyLeft','По левому краю', SVG('<line x1="1" y1="4" x2="15" y2="4"/><line x1="1" y1="8" x2="11" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/>'))}
        ${T('justifyCenter','По центру', SVG('<line x1="1" y1="4" x2="15" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/>'))}
        ${T('justifyRight','По правому краю', SVG('<line x1="1" y1="4" x2="15" y2="4"/><line x1="5" y1="8" x2="15" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/>'))}
        ${T('justifyFull','По ширине', SVG('<line x1="1" y1="4" x2="15" y2="4"/><line x1="1" y1="8" x2="15" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/>'))}
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        ${T('insertUnorderedList','Маркированный список', SVG('<circle cx="3" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="3" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="3" cy="13" r="1.5" fill="currentColor" stroke="none"/><line x1="6" y1="5" x2="15" y2="5"/><line x1="6" y1="9" x2="15" y2="9"/><line x1="6" y1="13" x2="15" y2="13"/>'))}
        ${T('insertOrderedList','Нумерованный список', SVG('<text x="0" y="6" fill="currentColor" stroke="none" font-size="5" font-family="sans-serif">1.</text><text x="0" y="10" fill="currentColor" stroke="none" font-size="5" font-family="sans-serif">2.</text><text x="0" y="14" fill="currentColor" stroke="none" font-size="5" font-family="sans-serif">3.</text><line x1="7" y1="5" x2="15" y2="5"/><line x1="7" y1="9" x2="15" y2="9"/><line x1="7" y1="13" x2="15" y2="13"/>'))}
        ${T('outdent','Уменьшить отступ', SVG('<line x1="1" y1="3" x2="15" y2="3"/><line x1="5" y1="7" x2="15" y2="7"/><line x1="5" y1="11" x2="15" y2="11"/><line x1="1" y1="15" x2="15" y2="15"/><polyline points="3,6 1,8 3,10"/>'))}
        ${T('indent','Увеличить отступ', SVG('<line x1="1" y1="3" x2="15" y2="3"/><line x1="5" y1="7" x2="15" y2="7"/><line x1="5" y1="11" x2="15" y2="11"/><line x1="1" y1="15" x2="15" y2="15"/><polyline points="1,6 3,8 1,10"/>'))}
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        <select class="dw-select dw-style-sel" data-block-sel title="Стиль абзаца">
          <option value="p">Обычный</option>
          <option value="h1">Заголовок 1</option>
          <option value="h2">Заголовок 2</option>
          <option value="h3">Заголовок 3</option>
          <option value="h4">Заголовок 4</option>
          <option value="blockquote">Цитата</option>
          <option value="pre">Код</option>
        </select>
      </div>
      <div class="dw-sep"></div>
      <div class="dw-group">
        <button class="dw-tool" data-link title="Добавить ссылку">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
        </button>
        <button class="dw-tool" data-cmd="removeFormat" title="Очистить форматирование">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><path d="M9.5 2.5h11l-3 6h-5"/><line x1="3" y1="22" x2="12" y2="22"/></svg>
        </button>
      </div>
    </div>
    <div class="docs-word-scroll">
      <div class="docs-word-pages" id="docs-word-pages">
        <div class="docs-word-page" contenteditable="true" spellcheck="true" data-placeholder="Начните печатать…">${doc.content || ''}</div>
      </div>
    </div>`;
  }

  // Distribute block-level children across separate page divs.
  // Each .docs-word-page is a self-contained white A4 box; pages after the first
  // are created dynamically. Called once after initial render.
  private reflowWordPages(pagesDiv: HTMLElement): void {
    // offsetTop is from the page's border-top. With 96px top-padding,
    // content starts at ~96px. Page height is 1123px, bottom padding 96px,
    // so content bottom is at 1027px. Move any child whose top >= 1027px to next page.
    const THRESHOLD = 1027;
    let pageIdx = 0;

    while (pageIdx < 200) {
      const pages = Array.from(pagesDiv.querySelectorAll<HTMLElement>('.docs-word-page'));
      if (pageIdx >= pages.length) break;

      const currentPage = pages[pageIdx];
      const children = Array.from(currentPage.children) as HTMLElement[];

      // Need at least 2 children to split (always keep one on current page)
      if (children.length <= 1) { pageIdx++; continue; }

      let overflowIdx = -1;
      for (let i = 1; i < children.length; i++) {
        if (children[i].offsetTop >= THRESHOLD) { overflowIdx = i; break; }
      }

      if (overflowIdx === -1) { pageIdx++; continue; }

      // Get or create next page
      let nextPage = pages[pageIdx + 1];
      if (!nextPage) {
        nextPage = document.createElement('div');
        nextPage.className = 'docs-word-page';
        nextPage.contentEditable = 'true';
        nextPage.setAttribute('spellcheck', 'true');
        pagesDiv.appendChild(nextPage);
      }

      // Prepend overflowing children to next page
      const anchor = nextPage.firstChild;
      for (const child of children.slice(overflowIdx)) {
        nextPage.insertBefore(child, anchor);
      }

      pageIdx++;
    }
  }

  private bindWord(doc: DocItem): void {
    const pagesDiv = this.root.querySelector<HTMLElement>('#docs-word-pages');
    if (!pagesDiv) return;

    // Track whichever page was last focused so toolbar commands target it
    let activeEditor: HTMLElement | null = null;
    const getEd = (): HTMLElement =>
      activeEditor || pagesDiv.querySelector<HTMLElement>('.docs-word-page')!;

    pagesDiv.addEventListener('focusin', e => {
      const page = (e.target as HTMLElement).closest<HTMLElement>('.docs-word-page');
      if (page) activeEditor = page;
    });

    // Collect content from all pages for persistence
    const commit = () => {
      const pages = pagesDiv.querySelectorAll('.docs-word-page');
      const html = Array.from(pages).map(p => p.innerHTML).join('');
      this.updateContent(doc.id, html);
    };
    pagesDiv.addEventListener('input', commit);

    // Apply CSS-based font size to selection via span
    const applyFontSize = (sizePt: string) => {
      const ed = getEd();
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('fontSize', false, '7');
      ed.querySelectorAll<HTMLElement>('font[size="7"]').forEach(el => {
        const span = document.createElement('span');
        span.style.fontSize = sizePt;
        span.innerHTML = el.innerHTML;
        el.replaceWith(span);
      });
    };

    this.root.querySelectorAll<HTMLButtonElement>('.dw-tool').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        const ed = getEd();
        ed.focus();
        const cmd = btn.dataset.cmd;
        if (cmd) {
          document.execCommand('styleWithCSS', false, 'true');
          document.execCommand(cmd, false);
        } else if (btn.dataset.link !== undefined) {
          const url = prompt('URL ссылки:', 'https://');
          if (url) document.execCommand('createLink', false, url);
        }
        commit();
      });
    });

    const blockSel = this.root.querySelector<HTMLSelectElement>('[data-block-sel]');
    blockSel?.addEventListener('change', () => {
      const ed = getEd();
      ed.focus();
      if (blockSel.value) document.execCommand('formatBlock', false, blockSel.value);
      blockSel.value = 'p';
      commit();
    });

    const fontSel = this.root.querySelector<HTMLSelectElement>('[data-cmd-font]');
    fontSel?.addEventListener('change', () => {
      if (!fontSel.value) return;
      const ed = getEd();
      ed.focus();
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('fontName', false, fontSel.value);
      fontSel.value = '';
      commit();
    });

    const ptSel = this.root.querySelector<HTMLSelectElement>('[data-cmd-size]');
    ptSel?.addEventListener('change', () => {
      if (!ptSel.value) return;
      const ed = getEd();
      ed.focus();
      applyFontSize(ptSel.value);
      ptSel.value = '';
      commit();
    });

    this.root.querySelector<HTMLInputElement>('[data-color]')?.addEventListener('input', e => {
      const ed = getEd();
      ed.focus();
      const v = (e.target as HTMLInputElement).value;
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, v);
      const bar = this.root.querySelector<HTMLElement>('.dw-fg-bar');
      if (bar) bar.style.background = v;
      commit();
    });

    this.root.querySelector<HTMLInputElement>('[data-hilite]')?.addEventListener('input', e => {
      const ed = getEd();
      ed.focus();
      const v = (e.target as HTMLInputElement).value;
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('hiliteColor', false, v) || document.execCommand('backColor', false, v);
      const bar = this.root.querySelector<HTMLElement>('.dw-hi-bar');
      if (bar) bar.style.background = v;
      commit();
    });

    // Distribute content into separate page divs after initial layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.reflowWordPages(pagesDiv));
    });
  }

  // ── Excel ──────────────────────────────────────────────────────────────────
  private renderExcel(doc: DocItem): string {
    const ec = this.parseExcelContent(doc.content);
    if (this.activeSheetIdx >= ec.sheets.length) this.activeSheetIdx = 0;
    const sheet = ec.sheets[this.activeSheetIdx];
    const rows = sheet.data;
    const colWidths = sheet.colWidths ?? [];
    const rowHeights = sheet.rowHeights ?? [];
    const isVirt = rows.length > XL_VX_THRESH;
    if (isVirt) { this.xlVirtData = rows; this.xlVirtMerges = sheet.merges ?? null; }
    else { this.xlVirtData = null; this.xlVirtMerges = null; }
    const cols = rows[0]?.length ?? XL_COLS;
    const colHeaders = Array.from({ length: cols }, (_, i) => this.colLetter(i));

    const sheetTabs = ec.sheets.length > 1
      ? `<div class="dx-sheet-tabs">${ec.sheets.map((s, i) =>
          `<div class="dx-sheet-tab${i === this.activeSheetIdx ? ' active' : ''}" data-sheet-idx="${i}">${this.esc(s.name)}</div>`
        ).join('')}</div>`
      : '';

    return `${sheet.truncated ? `<div class="dx-truncated-warn">⚠ Файл содержит больше ${MAX_IMPORT_ROWS.toLocaleString('ru-RU')} строк — загружены первые ${MAX_IMPORT_ROWS.toLocaleString('ru-RU')}</div>` : ''}
    <div class="docs-excel-toolbar">
      <div class="dx-group">
        <button class="dx-btn" data-xa="undo" title="Отменить (Ctrl+Z)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>
        </button>
        <button class="dx-btn" data-xa="redo" title="Повторить (Ctrl+Y)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7l3 2.7"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <select class="dx-sel dx-sel-font" data-xf-font title="Шрифт">
          <option value="">Шрифт</option>
          <option value="'DM Sans',sans-serif">DM Sans</option><option value="Arial,sans-serif">Arial</option>
          <option value="Helvetica,sans-serif">Helvetica</option><option value="'Times New Roman',serif">Times New Roman</option>
          <option value="Georgia,serif">Georgia</option><option value="'Courier New',monospace">Courier New</option>
          <option value="Calibri,sans-serif">Calibri</option><option value="Cambria,serif">Cambria</option>
          <option value="Verdana,sans-serif">Verdana</option><option value="Tahoma,sans-serif">Tahoma</option>
        </select>
        <select class="dx-sel dx-sel-size" data-xf-size title="Размер шрифта">
          <option value="">Пт</option>
          <option value="10px">10</option><option value="11px">11</option><option value="12px">12</option>
          <option value="13px">13</option><option value="14px">14</option><option value="16px">16</option>
          <option value="18px">18</option><option value="20px">20</option><option value="24px">24</option>
          <option value="28px">28</option><option value="36px">36</option>
        </select>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xf="bold" title="Жирный (Ctrl/⌘+B)"><b style="font-size:13px">B</b></button>
        <button class="dx-btn" data-xf="italic" title="Курсив (Ctrl/⌘+I)"><i style="font-size:13px;font-style:italic">I</i></button>
        <button class="dx-btn" data-xf="underline" title="Подчёркнутый (Ctrl/⌘+U)"><u style="font-size:13px">U</u></button>
        <button class="dx-btn" data-xf="strike" title="Зачёркнутый"><s style="font-size:13px">S</s></button>
        <label class="dx-btn dx-color" title="Цвет текста">
          <span style="display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:none">
            <b style="font-size:12px;line-height:1.1;font-family:serif">A</b>
            <span id="dx-color-bar" style="width:13px;height:3px;background:#111111;border-radius:1px"></span>
          </span>
          <input type="color" data-xf-color value="#111111">
        </label>
        <label class="dx-btn dx-color dx-color-bg" title="Заливка ячейки">
          <span style="display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:none">
            <span style="font-size:13px;line-height:1.1">🪣</span>
            <span id="dx-bg-bar" style="width:13px;height:3px;background:#ffd700;border-radius:1px"></span>
          </span>
          <input type="color" data-xf-bg value="#ffd700">
        </label>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa-align="left" title="По левому краю">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="1" y1="4" x2="15" y2="4"/><line x1="1" y1="8" x2="11" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/></svg>
        </button>
        <button class="dx-btn" data-xa-align="center" title="По центру">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="1" y1="4" x2="15" y2="4"/><line x1="3" y1="8" x2="13" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/></svg>
        </button>
        <button class="dx-btn" data-xa-align="right" title="По правому краю">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="1" y1="4" x2="15" y2="4"/><line x1="5" y1="8" x2="15" y2="8"/><line x1="1" y1="12" x2="15" y2="12"/></svg>
        </button>
        <button class="dx-btn" data-xa="wrap" title="Перенос текста">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="1" y1="4" x2="15" y2="4"/><path d="M1 8h10a2 2 0 010 4H6"/><polyline points="8,10 6,12 8,14"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <select class="dx-sel dx-sel-border" data-xf-border title="Границы">
          <option value="">⊞ Границы</option><option value="all">Все ячейки</option><option value="outer">По периметру</option>
          <option value="thick">Толстые (периметр)</option>
          <option value="top">Сверху</option><option value="bottom">Снизу</option>
          <option value="left">Слева</option><option value="right">Справа</option><option value="none">Убрать</option>
        </select>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xf-num="general" title="Общий формат" style="font-size:11px">Общий</button>
        <button class="dx-btn" data-xf-num="number" title="Числовой" style="font-size:11px;font-family:monospace">123</button>
        <button class="dx-btn" data-xf-num="currency" title="Денежный (₽)" style="font-size:13px">₽</button>
        <button class="dx-btn" data-xf-num="percent" title="Процент (%)" style="font-size:13px">%</button>
        <button class="dx-btn" data-xf-num="date" title="Дата">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="3" width="14" height="12" rx="2"/><line x1="5" y1="1" x2="5" y2="5"/><line x1="11" y1="1" x2="11" y2="5"/><line x1="1" y1="7" x2="15" y2="7"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa="sort-asc" title="Сортировать А→Я (по активной колонке)">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="2" y1="4" x2="10" y2="4"/><line x1="2" y1="8" x2="8" y2="8"/><line x1="2" y1="12" x2="6" y2="12"/><polyline points="13,2 13,14"/><polyline points="10,11 13,14 16,11"/></svg>
        </button>
        <button class="dx-btn" data-xa="sort-desc" title="Сортировать Я→А (по активной колонке)">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="2" y1="4" x2="6" y2="4"/><line x1="2" y1="8" x2="8" y2="8"/><line x1="2" y1="12" x2="10" y2="12"/><polyline points="13,2 13,14"/><polyline points="10,5 13,2 16,5"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn${this.xlFreezeRow?' dx-active':''}" data-xa="freeze-row" title="Закрепить первую строку данных">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="14" height="4" rx="1" fill="currentColor" opacity=".35"/><line x1="1" y1="5" x2="15" y2="5" stroke-width="2.2"/><line x1="3" y1="9" x2="13" y2="9"/><line x1="3" y1="13" x2="13" y2="13"/></svg>
        </button>
        <button class="dx-btn${this.xlFreezeCol?' dx-active':''}" data-xa="freeze-col" title="Закрепить первый столбец">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="4" height="14" rx="1" fill="currentColor" opacity=".35"/><line x1="5" y1="1" x2="5" y2="15" stroke-width="2.2"/><line x1="9" y1="3" x2="9" y2="13"/><line x1="13" y1="3" x2="13" y2="13"/></svg>
        </button>
        <button class="dx-btn${this.xlFilterOn?' dx-active':''}" data-xa="autofilter" title="Автофильтр (фильтрация строк)">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="1,3 15,3 9.5,9.5 9.5,14 6.5,14 6.5,9.5" fill="currentColor" opacity=".25" stroke="currentColor"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa="find" title="Найти / Заменить (Ctrl/⌘+F)">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="15" y2="15"/></svg>
        </button>
        <button class="dx-btn dx-danger" data-xa="clear" title="Очистить текущий лист">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 4h12M6 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M13 4l-.8 9a1 1 0 01-1 .9H4.8a1 1 0 01-1-.9L3 4"/></svg>
        </button>
      </div>
      <div class="docs-excel-status" id="docs-xl-status">A1</div>
    </div>
    <div class="docs-formula-bar">
      <div class="dx-cell-ref" id="docs-cell-ref" contenteditable="false" spellcheck="false" title="Адрес ячейки (кликни для перехода)">A1</div>
      <div class="dx-fx-icon" title="Вставить функцию">fx</div>
      <input class="dx-formula-inp" id="docs-formula-inp" type="text" placeholder="Значение или формула  (=СУММ(A1:A5), =B2*C2 ...)">
    </div>
    <div class="docs-excel-wrap" id="docs-excel-wrap" tabindex="0">
      <table class="docs-excel">
        <thead>
          <tr>
            <th class="dx-corner" title="Выделить всё"></th>
            ${colHeaders.map((l, i) => {
              const w = colWidths[i];
              const wStyle = w ? ` style="min-width:${w}px;width:${w}px"` : '';
              return `<th class="dx-colhdr" data-col="${i}"${wStyle}>
                <span class="dx-hdr-label">${l}</span>
                <div class="dx-hdr-actions">
                  <button class="dx-hdr-btn" data-col-add="${i}" title="Добавить столбец справа">+</button>
                  <button class="dx-hdr-btn dx-danger" data-col-del="${i}" title="Удалить столбец">−</button>
                </div>
                <div class="dx-col-resize" data-col-r="${i}"></div>
              </th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody id="docs-excel-body">
          ${(() => {
            const mergeInfo = this.buildMergeInfo(sheet.merges);
            const renderRow = (row: CellData[], r: number) => {
              const h = rowHeights[r];
              const hStyle = h ? ` style="height:${h}px"` : '';
              return `<tr data-row="${r}"${hStyle}>
                <th class="dx-rowhdr" data-row-hdr="${r}">
                  <span class="dx-hdr-label">${r + 1}</span>
                  <div class="dx-hdr-actions dx-hdr-actions-row">
                    <button class="dx-hdr-btn" data-row-add="${r}" title="Добавить строку ниже">+</button>
                    <button class="dx-hdr-btn dx-danger" data-row-del="${r}" title="Удалить строку">−</button>
                  </div>
                  <div class="dx-row-resize" data-row-r="${r}"></div>
                </th>
                ${row.map((cell, c) => {
                  const cw = colWidths[c];
                  const cwStyle = cw ? `min-width:${cw}px;width:${cw}px;` : '';
                  return this.renderCell(rows, r, c, cell, cwStyle, mergeInfo);
                }).join('')}
              </tr>`;
            };
            if (!isVirt) return rows.map(renderRow).join('');
            const endR = Math.min(rows.length, XL_VX_PAGE + XL_VX_BUF);
            const botH = Math.max(0, rows.length - endR) * XL_VX_ROW_H;
            return rows.slice(0, endR).map(renderRow).join('')
              + (botH > 0 ? `<tr class="vx-spacer" style="height:${botH}px"><td colspan="${cols + 1}" style="padding:0;border:0;pointer-events:none"></td></tr>` : '');
          })()}
        </tbody>
      </table>
    </div>
    ${sheetTabs}`;
  }

  // ── Excel binding ──────────────────────────────────────────────────────────
  private bindExcel(doc: DocItem): void {
    const body = this.root.querySelector<HTMLElement>('#docs-excel-body');
    const status = this.root.querySelector<HTMLElement>('#docs-xl-status');
    if (!body) return;

    let curR = 0, curC = 0;
    let selStart: { r: number; c: number } | null = null;
    let selEnd: { r: number; c: number } | null = null;
    let dragging = false;
    let editMode = false;
    let editTd: HTMLTableCellElement | null = null;
    let editOrigCell: CellData = { v: '' };

    const getEC = (): ExcelContent => this.parseExcelContent(doc.content);
    const getSheet = (): SheetData => {
      const ec = getEC();
      return ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    };

    // Snapshot currently visible DOM cells back into xlVirtData
    const vd = this.xlVirtData;
    const vdMerges = this.xlVirtMerges;

    // Virtual-scroll helpers — assigned later in the `if (vd)` block
    let vxUpdateWindow: ((startR: number) => void) | null = null;
    let vxCumH: number[] | null = null;
    let vxWrap: HTMLElement | null = null;
    let vxLastStart = 0, vxLastEnd = 0;

    // Read only formatting styles from a cell — exclude layout props (width/height)
    // that come from column/row resizing and must NOT be stored in cell.s
    const LAYOUT_PROPS = new Set(['width','min-width','max-width','height','min-height','max-height']);
    const cellStyle = (td: HTMLTableCellElement): string | undefined => {
      const filtered = td.style.cssText
        .split(';')
        .filter(p => { const prop = p.split(':')[0].trim().toLowerCase(); return prop && !LAYOUT_PROPS.has(prop); })
        .join(';').trim();
      return filtered || undefined;
    };

    const syncDomToData = () => {
      if (!vd) return;
      body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr => {
        const r = +(tr.dataset.row!);
        if (isNaN(r) || r < 0 || r >= vd.length) return;
        tr.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach(td => {
          const c = +(td.dataset.c!);
          if (isNaN(c) || c < 0 || c >= vd[r].length) return;
          vd[r][c] = this.cellFromTd(td, cellStyle(td));
        });
      });
    };

    const grid = (): CellData[][] => {
      if (vd) { syncDomToData(); return vd; }
      const rows: CellData[][] = [];
      body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr => {
        const row: CellData[] = [];
        tr.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach(td => {
          row.push(this.cellFromTd(td, cellStyle(td)));
        });
        rows.push(row);
      });
      return rows;
    };

    const saveGrid = (data: CellData[][]) => {
      const ec = getEC();
      ec.sheets[this.activeSheetIdx] = { ...getSheet(), data };
      this.updateContent(doc.id, JSON.stringify(ec));
    };

    const commit = () => saveGrid(grid());

    const pushUndo = () => {
      this.xlUndoStack.push({ data: JSON.parse(JSON.stringify(grid())), docId: doc.id, sheetIdx: this.activeSheetIdx, r: curR, c: curC });
      if (this.xlUndoStack.length > 100) this.xlUndoStack.shift();
      this.xlRedoStack = [];
    };
    const restoreGridSnap = (snap: {data: CellData[][], docId: string, sheetIdx: number, r: number, c: number}) => {
      if (snap.docId !== doc.id || snap.sheetIdx !== this.activeSheetIdx) {
        // Different doc/sheet — just update content and re-render
        const snapDoc = this.docs.find(d => d.id === snap.docId);
        if (snapDoc) {
          const ec = this.parseExcelContent(snapDoc.content);
          ec.sheets[snap.sheetIdx] = { ...(ec.sheets[snap.sheetIdx] ?? { name: 'Sheet1' }), data: snap.data };
          this.updateContent(snap.docId, JSON.stringify(ec));
          if (snap.docId === this.activeId) this.render();
        }
        return;
      }
      if (vd) snap.data.forEach((row, ri) => row.forEach((cell, ci) => { if (vd[ri]) vd[ri][ci] = { ...cell }; }));
      snap.data.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${ri}"][data-c="${ci}"]`);
          if (!td) return;
          this.applyCellToTd(td, cell, snap.data);
          td.style.cssText = cell.s ?? '';
        });
      });
      saveGrid(snap.data);
      curR = snap.r; curC = snap.c;
      selStart = { r: snap.r, c: snap.c }; selEnd = { r: snap.r, c: snap.c };
      applySel(); syncFormulaBar();
    };
    const doUndo = () => {
      if (!this.xlUndoStack.length) return;
      this.xlRedoStack.push({ data: JSON.parse(JSON.stringify(grid())), docId: doc.id, sheetIdx: this.activeSheetIdx, r: curR, c: curC });
      restoreGridSnap(this.xlUndoStack.pop()!);
    };
    const doRedo = () => {
      if (!this.xlRedoStack.length) return;
      this.xlUndoStack.push({ data: JSON.parse(JSON.stringify(grid())), docId: doc.id, sheetIdx: this.activeSheetIdx, r: curR, c: curC });
      restoreGridSnap(this.xlRedoStack.pop()!);
    };
    const getMaxRows = () => vd ? vd.length : body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').length;
    const getMaxCols = () => vd ? (vd[0]?.length ?? 0) : (body.querySelector<HTMLTableRowElement>('tr[data-row]')?.querySelectorAll('td').length ?? 0);
    const navigateTo = (r: number, c: number, extendSel = false) => {
      r = Math.max(0, Math.min(r, getMaxRows() - 1));
      c = Math.max(0, Math.min(c, getMaxCols() - 1));
      curR = r; curC = c;
      if (extendSel && selStart) { selEnd = { r, c }; }
      else { selStart = { r, c }; selEnd = { r, c }; }
      // Virtual scroll: if target row is outside the current window, update the window first
      if (vd && vxUpdateWindow && vxCumH && vxWrap) {
        const inDom = !!body.querySelector(`td[data-r="${r}"]`);
        if (!inDom) {
          syncDomToData();
          const newStart = Math.max(0, r - XL_VX_BUF);
          vxUpdateWindow(newStart);
          // Scroll so the target row is centered
          vxWrap.scrollTop = Math.max(0, vxCumH[r] - vxWrap.clientHeight / 2);
        } else {
          body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      } else {
        body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      applySel(); syncFormulaBar();
    };
    const exitEdit = (doCommit = true, revert = false) => {
      if (!editMode || !editTd) return;
      const td = editTd;
      editMode = false; editTd = null;
      td.contentEditable = 'false';
      td.classList.remove('dx-editing');
      if (revert) {
        this.applyCellToTd(td, editOrigCell, grid());
      } else {
        // Разбираем ввод: число/дата/процент получают тип и формат,
        // текст остаётся текстом. Формат ячейки при этом сохраняется.
        const parsed = this.interpretInput(td.innerText, editOrigCell.nf, editOrigCell.t);
        if (editOrigCell.s) parsed.s = editOrigCell.s;
        this.applyCellToTd(td, parsed, grid());
        if (doCommit) saveGrid(grid());
      }
      syncFormulaBar();
    };
    // Список берём из движка, чтобы подсказки не расходились с реальностью
    const AC_FUNS = FUNCTION_NAMES;
    const enterEdit = (r: number, c: number, initChar = '') => {
      if (editMode) exitEdit(true);
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
      if (!td) return;
      editMode = true; editTd = td;
      editOrigCell = this.cellFromTd(td, cellStyle(td));
      td.contentEditable = 'true';
      td.classList.add('dx-editing');
      // В режиме правки Excel показывает сырое значение, а не оформленное:
      // «1 234,50 ₽» → «1234.5», формула → сам текст формулы
      if (!initChar && td.innerText !== editOrigCell.v) td.innerText = editOrigCell.v;
      if (initChar) { pushUndo(); td.innerText = initChar; delete td.dataset.formula; delete td.dataset.raw; }
      td.focus();
      const range = document.createRange(), sel = window.getSelection();
      range.selectNodeContents(td); range.collapse(false);
      sel?.removeAllRanges(); sel?.addRange(range);
      syncFormulaBar();
      // Formula autocomplete
      const showAC = () => {
        document.querySelector('.dx-ac-drop')?.remove();
        const txt = (td.dataset.formula ?? td.innerText).toUpperCase();
        if (!txt.startsWith('=')) return;
        const lastToken = txt.slice(1).replace(/.*[^A-Z]/,'');
        if (!lastToken || lastToken.length < 2) return;
        const matches = AC_FUNS.filter(f => f.startsWith(lastToken) && f !== lastToken);
        if (!matches.length) return;
        const drop = document.createElement('div');
        drop.className = 'dx-ac-drop';
        const rect_ = td.getBoundingClientRect();
        drop.style.cssText = `left:${rect_.left}px;top:${rect_.bottom+2}px;min-width:${Math.max(160,rect_.width)}px`;
        drop.innerHTML = matches.slice(0,8).map(f=>`<div class="dx-ac-item" data-fn="${f}"><span class="dx-ac-hi">${f.slice(0,lastToken.length)}</span>${f.slice(lastToken.length)}</div>`).join('');
        document.body.appendChild(drop);
        drop.querySelectorAll<HTMLElement>('.dx-ac-item').forEach(item => {
          item.addEventListener('mousedown', ev => {
            ev.preventDefault();
            const fn_ = item.dataset.fn!;
            const cur_ = td.innerText;
            const withoutLast = cur_.slice(0,-lastToken.length);
            td.innerText = withoutLast + fn_ + '(';
            const r2 = document.createRange(); r2.selectNodeContents(td); r2.collapse(false);
            window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(r2);
            drop.remove();
          });
        });
      };
      td.addEventListener('input', showAC);
      td.addEventListener('blur', () => { setTimeout(()=>document.querySelector('.dx-ac-drop')?.remove(),120); });
    };

    // Sheet tab switching — save/restore scroll position per sheet
    this.root.querySelectorAll<HTMLElement>('.dx-sheet-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const wrapEl_ = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
        if (wrapEl_) {
          if (!this.xlSheetScroll[doc.id]) this.xlSheetScroll[doc.id] = {};
          this.xlSheetScroll[doc.id][this.activeSheetIdx] = { top: wrapEl_.scrollTop, left: wrapEl_.scrollLeft };
        }
        commit();
        this.activeSheetIdx = +(tab.dataset.sheetIdx ?? '0');
        this.render();
      });
    });

    const clearSel = () => {
      body.querySelectorAll('td.dx-selected,td.dx-cur').forEach(td => { td.classList.remove('dx-selected'); td.classList.remove('dx-cur'); });
      this.root.querySelectorAll('th.dx-hdr-selected').forEach(th => th.classList.remove('dx-hdr-selected'));
      document.getElementById('dx-fill-handle')?.remove();
    };

    // ── AutoFill: серийное заполнение ──────────────────────────────────────────
    // Определяет паттерн из массива значений и возвращает следующее значение
    const AF_DAYS_RU   = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
    const AF_DAYS_SH   = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const AF_MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const AF_MONTHS_SH = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const AF_Q         = ['Q1','Q2','Q3','Q4'];

    const afCycleNext = (val: string, lists: string[][]): string | null => {
      const low = val.trim().toLowerCase();
      for (const list of lists) {
        const idx = list.findIndex(x => x.toLowerCase() === low);
        if (idx !== -1) return list[(idx + 1) % list.length];
      }
      return null;
    };

    const afNextValue = (vals: string[], step: number): string => {
      if (vals.length === 0) return '';

      // Цикличные списки (дни, месяцы, кварталы)
      const cycleLists = [AF_DAYS_RU, AF_DAYS_SH, AF_MONTHS_RU, AF_MONTHS_SH, AF_Q];
      if (vals.length === 1) {
        const cycleNext = afCycleNext(vals[0], cycleLists);
        if (cycleNext !== null) return cycleNext;
      } else {
        // Проверяем, что все значения из одного цикличного списка
        for (const list of cycleLists) {
          const indices = vals.map(v => list.findIndex(x => x.toLowerCase() === v.trim().toLowerCase()));
          if (indices.every(i => i !== -1)) {
            const lastIdx = indices[indices.length - 1];
            return list[(lastIdx + 1) % list.length];
          }
        }
      }

      // Числа: арифметическая прогрессия
      const nums = vals.map(v => parseFloat(v.replace(',', '.')));
      if (nums.every(n => !isNaN(n))) {
        if (nums.length === 1) return String(nums[0] + step);
        const diff = nums[nums.length - 1] - nums[nums.length - 2];
        const next = nums[nums.length - 1] + diff;
        // Сохраняем кол-во десятичных знаков
        const decimals = Math.max(...vals.map(v => (v.split('.')[1] ?? '').length));
        return decimals > 0 ? next.toFixed(decimals) : String(next);
      }

      // Текст + число в конце: "Квартал 1" → "Квартал 2"
      const textNumRe = /^(.*?)(\d+)(\D*)$/;
      const firstMatch = vals[0].match(textNumRe);
      if (firstMatch) {
        const prefix = firstMatch[1], suffix = firstMatch[3];
        const tailNums = vals.map(v => { const m = v.match(textNumRe); return m ? parseInt(m[2]) : NaN; });
        if (tailNums.every(n => !isNaN(n))) {
          if (tailNums.length === 1) return `${prefix}${tailNums[0] + step}${suffix}`;
          const diff = tailNums[tailNums.length - 1] - tailNums[tailNums.length - 2];
          return `${prefix}${tailNums[tailNums.length - 1] + diff}${suffix}`;
        }
      }

      // Даты ISO / dd.mm.yyyy
      const parseDate = (s: string): Date | null => {
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
        if (iso.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
        const m = s.match(dmy);
        if (m) { const d = new Date(+m[3], +m[2]-1, +m[1]); return isNaN(d.getTime()) ? null : d; }
        return null;
      };
      const formatDate = (d: Date, fmt: string): string => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fmt)) return d.toISOString().slice(0,10);
        const dd = String(d.getDate()).padStart(2,'0'), mm = String(d.getMonth()+1).padStart(2,'0');
        return `${dd}.${mm}.${d.getFullYear()}`;
      };
      const dates = vals.map(v => parseDate(v));
      if (dates.every(d => d !== null)) {
        const dts = dates as Date[];
        if (dts.length === 1) {
          const nd = new Date(dts[0]); nd.setDate(nd.getDate() + step); return formatDate(nd, vals[0]);
        }
        const diffMs = dts[dts.length-1].getTime() - dts[dts.length-2].getTime();
        const nd = new Date(dts[dts.length-1].getTime() + diffMs); return formatDate(nd, vals[0]);
      }

      // Процент: "10%" → "11%"
      const pctRe = /^(-?\d+(?:[.,]\d+)?)%$/;
      const pcts = vals.map(v => { const m = v.match(pctRe); return m ? parseFloat(m[1].replace(',','.')) : NaN; });
      if (pcts.every(n => !isNaN(n))) {
        if (pcts.length === 1) return `${pcts[0] + step}%`;
        const diff = pcts[pcts.length-1] - pcts[pcts.length-2];
        return `${pcts[pcts.length-1] + diff}%`;
      }

      // Просто повторяем последнее значение
      return vals[vals.length - 1];
    };

    // Выполнить автозаполнение: src — исходный диапазон, target — куда заполнять, direction: 'right'|'down'|'left'|'up'
    const doAutoFill = (
      srcR1: number, srcC1: number, srcR2: number, srcC2: number,
      tgtR1: number, tgtC1: number, tgtR2: number, tgtC2: number,
      direction: 'right' | 'down' | 'left' | 'up',
    ) => {
      pushUndo();
      const rows = grid();
      if (direction === 'down' || direction === 'up') {
        // Заполняем по каждому столбцу
        for (let c = srcC1; c <= srcC2; c++) {
          const srcVals: string[] = [];
          for (let r = srcR1; r <= srcR2; r++) srcVals.push(rows[r]?.[c]?.v ?? '');
          if (direction === 'down') {
            const history = [...srcVals];
            for (let r = tgtR1; r <= tgtR2; r++) {
              const nextVal = afNextValue(history.slice(-Math.max(srcVals.length, 2)), 1);
              if (rows[r]) rows[r][c] = { ...rows[r][c], v: nextVal };
              const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td) { delete td.dataset.formula; td.innerText = nextVal; }
              history.push(nextVal);
            }
          } else {
            // up — считаем обратную прогрессию
            const history = [...srcVals].reverse();
            for (let r = tgtR2; r >= tgtR1; r--) {
              const nextVal = afNextValue(history.slice(-Math.max(srcVals.length, 2)), -1);
              if (rows[r]) rows[r][c] = { ...rows[r][c], v: nextVal };
              const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td) { delete td.dataset.formula; td.innerText = nextVal; }
              history.push(nextVal);
            }
          }
        }
      } else {
        // Заполняем по каждой строке
        for (let r = srcR1; r <= srcR2; r++) {
          const srcVals: string[] = [];
          for (let c = srcC1; c <= srcC2; c++) srcVals.push(rows[r]?.[c]?.v ?? '');
          if (direction === 'right') {
            const history = [...srcVals];
            for (let c = tgtC1; c <= tgtC2; c++) {
              const nextVal = afNextValue(history.slice(-Math.max(srcVals.length, 2)), 1);
              if (rows[r]) rows[r][c] = { ...rows[r][c], v: nextVal };
              const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td) { delete td.dataset.formula; td.innerText = nextVal; }
              history.push(nextVal);
            }
          } else {
            // left
            const history = [...srcVals].reverse();
            for (let c = tgtC2; c >= tgtC1; c--) {
              const nextVal = afNextValue(history.slice(-Math.max(srcVals.length, 2)), -1);
              if (rows[r]) rows[r][c] = { ...rows[r][c], v: nextVal };
              const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td) { delete td.dataset.formula; td.innerText = nextVal; }
              history.push(nextVal);
            }
          }
        }
      }
      saveGrid(rows);
      selStart = { r: Math.min(srcR1, tgtR1), c: Math.min(srcC1, tgtC1) };
      selEnd   = { r: Math.max(srcR2, tgtR2), c: Math.max(srcC2, tgtC2) };
      applySel();
    };

    // Показывает/перемещает маркер заполнения (синяя точка в правом нижнем углу)
    const updateFillHandle = () => {
      if (!selStart || !selEnd) return;
      const r2 = Math.max(selStart.r, selEnd.r);
      const c2 = Math.max(selStart.c, selEnd.c);
      const lastTd = body.querySelector<HTMLTableCellElement>(`td[data-r="${r2}"][data-c="${c2}"]`);
      if (!lastTd) { document.getElementById('dx-fill-handle')?.remove(); return; }
      let handle = document.getElementById('dx-fill-handle');
      if (!handle) {
        handle = document.createElement('div');
        handle.id = 'dx-fill-handle';
        document.body.appendChild(handle);
      }
      const rect = lastTd.getBoundingClientRect();
      handle.style.left = `${rect.right + window.scrollX - 4}px`;
      handle.style.top  = `${rect.bottom + window.scrollY - 4}px`;

      // AutoFill drag
      handle.onmousedown = (e: MouseEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (!selStart || !selEnd) return;
        const srcR1 = Math.min(selStart.r, selEnd.r), srcR2 = Math.max(selStart.r, selEnd.r);
        const srcC1 = Math.min(selStart.c, selEnd.c), srcC2 = Math.max(selStart.c, selEnd.c);

        let afPreviewEls: HTMLElement[] = [];
        const clearPreview = () => { afPreviewEls.forEach(el => el.classList.remove('dx-autofill-preview')); afPreviewEls = []; };

        const onMove = (me: MouseEvent) => {
          clearPreview();
          const target = document.elementFromPoint(me.clientX, me.clientY)?.closest('td') as HTMLTableCellElement | null;
          if (!target) return;
          const tr = +(target.dataset.r ?? '-1'), tc = +(target.dataset.c ?? '-1');
          if (tr < 0 || tc < 0) return;

          // Определяем направление
          let direction: 'right'|'down'|'left'|'up';
          const dr = tr - srcR2, dc = tc - srcC2;
          const ul_r = srcR1 - tr, ul_c = srcC1 - tc;
          if (Math.abs(dr) >= Math.abs(dc) && tr >= srcR2)        direction = 'down';
          else if (Math.abs(ul_r) >= Math.abs(ul_c) && tr <= srcR1) direction = 'up';
          else if (dc >= 0)                                          direction = 'right';
          else                                                       direction = 'left';

          // Подсветить превью
          if (direction === 'down') {
            for (let r = srcR2+1; r <= tr; r++) for (let c = srcC1; c <= srcC2; c++) {
              const el = body.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (el) { el.classList.add('dx-autofill-preview'); afPreviewEls.push(el); }
            }
          } else if (direction === 'up') {
            for (let r = tr; r < srcR1; r++) for (let c = srcC1; c <= srcC2; c++) {
              const el = body.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (el) { el.classList.add('dx-autofill-preview'); afPreviewEls.push(el); }
            }
          } else if (direction === 'right') {
            for (let r = srcR1; r <= srcR2; r++) for (let c = srcC2+1; c <= tc; c++) {
              const el = body.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (el) { el.classList.add('dx-autofill-preview'); afPreviewEls.push(el); }
            }
          } else {
            for (let r = srcR1; r <= srcR2; r++) for (let c = tc; c < srcC1; c++) {
              const el = body.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (el) { el.classList.add('dx-autofill-preview'); afPreviewEls.push(el); }
            }
          }
        };

        const onUp = (ue: MouseEvent) => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          clearPreview();
          const target = document.elementFromPoint(ue.clientX, ue.clientY)?.closest('td') as HTMLTableCellElement | null;
          if (!target) return;
          const tr = +(target.dataset.r ?? '-1'), tc = +(target.dataset.c ?? '-1');
          if (tr < 0 || tc < 0) return;

          const dr = tr - srcR2, dc = tc - srcC2;
          const ul_r = srcR1 - tr, ul_c = srcC1 - tc;
          let direction: 'right'|'down'|'left'|'up';
          if (Math.abs(dr) >= Math.abs(dc) && tr >= srcR2)        direction = 'down';
          else if (Math.abs(ul_r) >= Math.abs(ul_c) && tr <= srcR1) direction = 'up';
          else if (dc >= 0)                                          direction = 'right';
          else                                                       direction = 'left';

          if (direction === 'down'  && tr > srcR2)  doAutoFill(srcR1,srcC1,srcR2,srcC2, srcR2+1,srcC1,tr,srcC2,  direction);
          else if (direction === 'up'   && tr < srcR1)  doAutoFill(srcR1,srcC1,srcR2,srcC2, tr,srcC1,srcR1-1,srcC2,direction);
          else if (direction === 'right'&& tc > srcC2)  doAutoFill(srcR1,srcC1,srcR2,srcC2, srcR1,srcC2+1,srcR2,tc,  direction);
          else if (direction === 'left' && tc < srcC1)  doAutoFill(srcR1,srcC1,srcR2,srcC2, srcR1,tc,srcR2,srcC1-1,direction);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
    };

    const applySel = () => {
      clearSel();
      if (!selStart || !selEnd) return;
      const r1 = Math.min(selStart.r, selEnd.r), r2 = Math.max(selStart.r, selEnd.r);
      const c1 = Math.min(selStart.c, selEnd.c), c2 = Math.max(selStart.c, selEnd.c);
      // Use virtual data length when available (virtual scroll renders only a window of rows)
      const totalRows = vd ? vd.length : body.querySelectorAll<HTMLTableRowElement>('tr').length;
      const totalCols = vd ? (vd[0]?.length ?? 0) : (body.querySelector<HTMLTableRowElement>('tr')?.querySelectorAll('td').length ?? 0);
      const isFullRow = c1 === 0 && c2 >= totalCols - 1;
      const isFullCol = r1 === 0 && r2 >= totalRows - 1;
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.classList.add('dx-selected');
      }
      // Active cell cursor
      body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`)?.classList.add('dx-cur');
      if (isFullRow) for (let r = r1; r <= r2; r++) this.root.querySelector(`th.dx-rowhdr[data-row-hdr="${r}"]`)?.classList.add('dx-hdr-selected');
      if (isFullCol) for (let c = c1; c <= c2; c++) this.root.querySelector(`th.dx-colhdr[data-col="${c}"]`)?.classList.add('dx-hdr-selected');
      updateStats(r1, c1, r2, c2);
      updateFillHandle();
      // Highlight active column/row headers
      this.root.querySelectorAll<HTMLElement>('.dx-colhdr.dx-hdr-cur,.dx-rowhdr.dx-hdr-cur').forEach(el => el.classList.remove('dx-hdr-cur'));
      this.root.querySelector<HTMLElement>(`th.dx-colhdr[data-col="${curC}"]`)?.classList.add('dx-hdr-cur');
      body.querySelector<HTMLElement>(`th.dx-rowhdr[data-row-hdr="${curR}"]`)?.classList.add('dx-hdr-cur');
      // Publish selection context for Sima
      this.xlLastSel = { r1, c1, r2, c2, docId: doc.id, sheetIdx: this.activeSheetIdx };
      const totalCells = (r2 - r1 + 1) * (c2 - c1 + 1);
      const rangeStr = `${this.colLetter(c1)}${r1+1}${r1!==r2||c1!==c2 ? ':'+this.colLetter(c2)+(r2+1) : ''}`;
      const previewCells: string[] = [];
      for (let r = r1; r <= Math.min(r2, r1 + 9); r++) {
        for (let c = c1; c <= c2; c++) {
          const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
          const v = td?.innerText.trim() || '';
          previewCells.push(`${this.colLetter(c)}${r+1}: ${v || '—'}`);
          if (previewCells.length >= 20) break;
        }
        if (previewCells.length >= 20) break;
      }
      selectionCtx.set({
        type: 'excel-cells',
        label: `${rangeStr}${totalCells > 1 ? ` (${totalCells} яч.)` : ''} · «${doc.title}»`,
        prompt: `[КОНТЕКСТ: выделено в Excel]\nДокумент: «${doc.title}»\nДиапазон: ${rangeStr} (${totalCells} ячеек)\nСодержимое:\n${previewCells.join('\n')}${totalCells > previewCells.length ? `\n... ещё ${totalCells - previewCells.length} ячеек` : ''}`,
        data: { docId: doc.id, sheetIdx: this.activeSheetIdx, range: { r1, c1, r2, c2 } },
      });
    };

    const updateStats = (r1: number, c1: number, r2: number, c2: number) => {
      if (!status) return;
      const range = `${this.colLetter(c1)}${r1+1}${(r1!==r2||c1!==c2)?':'+this.colLetter(c2)+(r2+1):''}`;
      let count=0, numCount=0, sum=0, min=Infinity, max=-Infinity;
      for (let r=r1;r<=r2;r++) for (let c=c1;c<=c2;c++) {
        const v=(body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.innerText??'').trim();
        if(v) count++;
        const n=parseFloat(v.replace(',','.').replace(/[^\d.-]/g,''));
        if(!isNaN(n)&&v!==''){numCount++;sum+=n;if(n<min)min=n;if(n>max)max=n;}
      }
      if(r1===r2&&c1===c2){status.textContent=range;}
      else{
        const parts=[range,`Ячеек: ${count}`];
        if(numCount>0){
          parts.push(`Сумма: ${sum.toLocaleString('ru-RU',{maximumFractionDigits:2})}`);
          parts.push(`Ср: ${(sum/numCount).toLocaleString('ru-RU',{maximumFractionDigits:2})}`);
          parts.push(`Мин: ${min}`); parts.push(`Макс: ${max}`);
        }
        status.textContent=parts.join(' │ ');
      }
    };

    const formulaBar = this.root.querySelector<HTMLInputElement>('#docs-formula-inp');
    const cellRef = this.root.querySelector<HTMLElement>('#docs-cell-ref');

    // ── Toolbar state sync ────────────────────────────────────────────────────
    const updateToolbarState = () => {
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`);
      if (!td) return;
      const cs = td.style;
      // Bold / Italic / Underline / Strike
      this.root.querySelector('[data-xf="bold"]')?.classList.toggle('dx-active', cs.fontWeight === 'bold');
      this.root.querySelector('[data-xf="italic"]')?.classList.toggle('dx-active', cs.fontStyle === 'italic');
      this.root.querySelector('[data-xf="underline"]')?.classList.toggle('dx-active', cs.textDecoration.includes('underline'));
      this.root.querySelector('[data-xf="strike"]')?.classList.toggle('dx-active', cs.textDecoration.includes('line-through'));
      // Wrap text
      this.root.querySelector('[data-xa="wrap"]')?.classList.toggle('dx-active', cs.whiteSpace === 'normal');
      // Alignment
      const align = cs.textAlign || '';
      this.root.querySelectorAll('[data-xa-align]').forEach(btn => {
        (btn as HTMLElement).classList.toggle('dx-active', (btn as HTMLElement).dataset.xaAlign === align);
      });
      // Color bar indicators
      const colorBar = this.root.querySelector<HTMLElement>('#dx-color-bar');
      if (colorBar) colorBar.style.background = cs.color || '#111111';
      const bgBar = this.root.querySelector<HTMLElement>('#dx-bg-bar');
      if (bgBar) bgBar.style.background = cs.background || '#ffff00';
      // Font selector (try to match current family)
      const fontSel = this.root.querySelector<HTMLSelectElement>('[data-xf-font]');
      if (fontSel && cs.fontFamily) {
        const match = Array.from(fontSel.options).find(o => o.value && cs.fontFamily.includes(o.value.split(',')[0].replace(/'/g, '')));
        fontSel.value = match?.value ?? '';
      }
      // Size selector
      const sizeSel = this.root.querySelector<HTMLSelectElement>('[data-xf-size]');
      if (sizeSel && cs.fontSize) {
        const match = Array.from(sizeSel.options).find(o => o.value === cs.fontSize);
        sizeSel.value = match?.value ?? '';
      }
    };

    const syncFormulaBar = () => {
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`);
      if (cellRef && document.activeElement !== cellRef) cellRef.textContent = `${this.colLetter(curC)}${curR+1}`;
      if (formulaBar) formulaBar.value = td?.dataset.formula ?? td?.innerText ?? '';
      updateToolbarState();
    };

    // ── Name Box navigation ───────────────────────────────────────────────────
    if (cellRef) {
      cellRef.addEventListener('click', () => {
        cellRef.contentEditable = 'true';
        cellRef.focus();
        const range = document.createRange();
        range.selectNodeContents(cellRef);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      });
      cellRef.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          cellRef.contentEditable = 'false';
          cellRef.textContent = `${this.colLetter(curC)}${curR + 1}`;
          wrap?.focus();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const text = (cellRef.textContent ?? '').trim().toUpperCase();
          cellRef.contentEditable = 'false';
          const m = text.match(/^([A-Z]+)(\d+)$/);
          if (m) {
            const newC = this.letterToCol(m[1]);
            const newR = parseInt(m[2]) - 1;
            if (newC >= 0 && newR >= 0) navigateTo(newR, newC);
          } else {
            cellRef.textContent = `${this.colLetter(curC)}${curR + 1}`;
          }
          wrap?.focus();
        }
      });
      cellRef.addEventListener('blur', () => {
        cellRef.contentEditable = 'false';
        cellRef.textContent = `${this.colLetter(curC)}${curR + 1}`;
      });
    }

    formulaBar?.addEventListener('focus', () => { exitEdit(false); });
    formulaBar?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { formulaBar.blur(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const val = formulaBar.value;
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`);
      if (!td) return;
      pushUndo();
      if (val.startsWith('=')) { td.dataset.formula = val; td.innerText = this.evalFormula(val, grid()); }
      else { delete td.dataset.formula; td.innerText = val; }
      saveGrid(grid());
      formulaBar.blur();
      navigateTo(curR + 1, curC);
    });

    body.addEventListener('input', () => {
      const td = document.activeElement as HTMLElement|null;
      if (td && td.tagName === 'TD') delete (td as HTMLTableCellElement).dataset.formula;
      syncFormulaBar();
    });

    const wrap = this.root.querySelector<HTMLElement>('#docs-excel-wrap');

    // Auto-scroll state
    let scrollRaf = 0;
    const stopAutoScroll = () => { cancelAnimationFrame(scrollRaf); scrollRaf = 0; };
    const startAutoScroll = (dy: number, dx: number) => {
      stopAutoScroll();
      const step = () => {
        if (!dragging || !wrap) return;
        wrap.scrollTop += dy;
        wrap.scrollLeft += dx;
        scrollRaf = requestAnimationFrame(step);
      };
      scrollRaf = requestAnimationFrame(step);
    };

    body.addEventListener('mousedown', (e) => {
      const td = (e.target as HTMLElement).closest('td') as HTMLTableCellElement | null; if (!td) return;
      const r = +(td.getAttribute('data-r') ?? '0'), c = +(td.getAttribute('data-c') ?? '0');
      if (editMode) {
        if (td !== editTd) exitEdit(true);
        else return; // clicking inside the cell being edited — allow default
      }
      e.preventDefault();
      curR = r; curC = c;
      selStart = { r, c }; selEnd = { r, c }; dragging = true;
      applySel(); syncFormulaBar();
      wrap?.focus({ preventScroll: true });
    });
    body.addEventListener('mousemove', (e) => {
      if(!dragging||!selStart) return;
      // Auto-scroll when near wrap edges
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        const zone = 40;
        const dy = e.clientY < rect.top + zone ? -8 : e.clientY > rect.bottom - zone ? 8 : 0;
        const dx = e.clientX < rect.left + zone ? -8 : e.clientX > rect.right - zone ? 8 : 0;
        if (dy || dx) { startAutoScroll(dy, dx); } else { stopAutoScroll(); }
      }
      const td=(e.target as HTMLElement).closest('td'); if(!td) return;
      const r=+(td.getAttribute('data-r')??'0'), c=+(td.getAttribute('data-c')??'0');
      if(r!==selEnd?.r||c!==selEnd?.c){
        selEnd={r,c};
        if(r!==selStart.r||c!==selStart.c){(document.activeElement as HTMLElement|null)?.blur();applySel();}
      }
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; stopAutoScroll(); if (selStart && selEnd) applySel(); }
    });

    // Column hover highlight
    let hoverCol = -1;
    const applyColHover = (c: number) => {
      if (c === hoverCol) return;
      if (hoverCol >= 0) body.querySelectorAll<HTMLElement>(`td.dx-col-hover`).forEach(td => td.classList.remove('dx-col-hover'));
      hoverCol = c;
      if (c >= 0) body.querySelectorAll<HTMLElement>(`td[data-c="${c}"]`).forEach(td => td.classList.add('dx-col-hover'));
    };
    body.addEventListener('mouseover', (e) => {
      const td = (e.target as HTMLElement).closest('td'); if (!td) return;
      const c = +(td.getAttribute('data-c') ?? '-1');
      applyColHover(c);
    });
    body.addEventListener('mouseleave', () => applyColHover(-1));

    body.addEventListener('dblclick', (e) => {
      const td = (e.target as HTMLElement).closest('td'); if (!td) return;
      const r = +(td.getAttribute('data-r') ?? '0'), c = +(td.getAttribute('data-c') ?? '0');
      enterEdit(r, c);
    });

    // Row/column/all selection by header click
    this.root.querySelectorAll<HTMLElement>('th.dx-colhdr').forEach(th => {
      th.addEventListener('click', (e) => {
        if((e.target as HTMLElement).closest('.dx-hdr-actions,.dx-col-resize')) return;
        const c=+(th.dataset.col??'0');
        const totalRows = vd ? vd.length : body.querySelectorAll<HTMLTableRowElement>('tr').length;
        selStart={r:0,c}; selEnd={r:totalRows-1,c}; applySel();
      });
    });
    this.root.querySelector<HTMLElement>('th.dx-corner')?.addEventListener('click', () => {
      const totalRows = vd ? vd.length : body.querySelectorAll<HTMLTableRowElement>('tr').length;
      const totalCols=body.querySelector<HTMLTableRowElement>('tr')?.querySelectorAll('td').length??0;
      selStart={r:0,c:0}; selEnd={r:totalRows-1,c:totalCols-1}; applySel();
    });

    // Keyboard — (Ctrl on Win/Linux, Cmd on Mac)
    const isMod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
    const onKey = (e: KeyboardEvent) => {
      if (this.root.style.display === 'none') return;
      const active = document.activeElement as HTMLElement | null;
      const inExternal = active && !this.root.contains(active) &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (inExternal) return;
      // Formula bar handles its own keys
      if (active === formulaBar) return;

      if (editMode) {
        // In edit mode: only intercept navigation/escape keys
        switch (e.key) {
          case 'Escape': e.preventDefault(); exitEdit(false, true); return;
          case 'Enter':
            if (!e.shiftKey) { e.preventDefault(); const nextR = curR + 1; exitEdit(true); navigateTo(nextR, curC); }
            return;
          case 'Tab':
            e.preventDefault(); { const nextC = curC + (e.shiftKey ? -1 : 1); exitEdit(true); navigateTo(curR, nextC); }
            return;
        }
        return; // let typing, arrows, etc. work inside the cell
      }

      // ── Selection mode ──────────────────────────────────────────────────────
      if (!selStart) return;

      if (isMod(e) && e.key === 'c') {
        e.preventDefault();
        const r1=Math.min(selStart?.r??curR,selEnd?.r??curR), r2=Math.max(selStart?.r??curR,selEnd?.r??curR);
        const c1=Math.min(selStart?.c??curC,selEnd?.c??curC), c2=Math.max(selStart?.c??curC,selEnd?.c??curC);
        const lines: string[] = [];
        for (let r=r1;r<=r2;r++) {
          const row: string[] = [];
          for (let c=c1;c<=c2;c++) {
            if (vd) { row.push(vd[r]?.[c]?.v ?? ''); }
            else { const td_=body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`); row.push(td_?.dataset.formula ?? td_?.innerText ?? ''); }
          }
          lines.push(row.join('\t'));
        }
        navigator.clipboard.writeText(lines.join('\n')).catch(()=>{});
        return;
      }
      if (isMod(e) && e.key === 'f') { e.preventDefault(); (this as any)._openFindPanel?.(); return; }
      if (isMod(e) && e.key === 'h') { e.preventDefault(); (this as any)._openFindPanel?.(); return; }
      if (isMod(e) && e.key === 'z') { e.preventDefault(); doUndo(); return; }
      if (isMod(e) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); doRedo(); return; }
      if (isMod(e)) {
        if (e.key === 'b' || e.key === 'B') { e.preventDefault(); selectedCells().forEach(c => { c.style.fontWeight = c.style.fontWeight === 'bold' ? '' : 'bold'; }); saveGrid(grid()); return; }
        if (e.key === 'i' || e.key === 'I') { e.preventDefault(); selectedCells().forEach(c => { c.style.fontStyle = c.style.fontStyle === 'italic' ? '' : 'italic'; }); saveGrid(grid()); return; }
        if (e.key === 'u' || e.key === 'U') { e.preventDefault(); selectedCells().forEach(c => { c.style.textDecoration = c.style.textDecoration.includes('underline') ? '' : 'underline'; }); saveGrid(grid()); return; }
        // Ctrl+Home → A1, Ctrl+End → last used cell
        if (e.key === 'Home') { e.preventDefault(); navigateTo(0, 0, e.shiftKey); return; }
        if (e.key === 'End') {
          e.preventDefault();
          const data = vd ?? grid();
          let lastR = 0, lastC = 0;
          for (let ri = 0; ri < data.length; ri++) for (let ci = 0; ci < data[ri].length; ci++) {
            if ((data[ri][ci].v ?? '').trim()) { if (ri > lastR || (ri === lastR && ci > lastC)) { lastR = ri; lastC = ci; } }
          }
          navigateTo(lastR, lastC, e.shiftKey); return;
        }
        // Ctrl+Arrow → jump to next data block boundary
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
          const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
          const data = vd;
          if (data) {
            const maxR = data.length - 1, maxC = (data[0]?.length ?? 1) - 1;
            const getV = (ri: number, ci: number) => (data[ri]?.[ci]?.v ?? '').trim();
            const curEmpty = !getV(curR, curC);
            let nr = curR + dr, nc = curC + dc;
            if (curEmpty) {
              while (nr >= 0 && nr <= maxR && nc >= 0 && nc <= maxC && !getV(nr, nc)) { nr += dr; nc += dc; }
            } else {
              while (nr >= 0 && nr <= maxR && nc >= 0 && nc <= maxC && getV(nr, nc)) { nr += dr; nc += dc; }
              if (getV(nr - dr, nc - dc)) { nr -= dr; nc -= dc; }
            }
            navigateTo(Math.max(0, Math.min(maxR, nr)), Math.max(0, Math.min(maxC, nc)), e.shiftKey);
          } else {
            navigateTo(dr < 0 ? 0 : dr > 0 ? getMaxRows()-1 : curR, dc < 0 ? 0 : dc > 0 ? getMaxCols()-1 : curC, e.shiftKey);
          }
          return;
        }
        return;
      }

      if (isMod(e) && e.key === 'a') {
        e.preventDefault();
        const maxR = getMaxRows() - 1, maxC = getMaxCols() - 1;
        selStart = {r:0, c:0}; selEnd = {r:maxR, c:maxC}; applySel(); return;
      }
      switch (e.key) {
        case 'ArrowUp':    e.preventDefault(); navigateTo(curR - 1, curC, e.shiftKey); return;
        case 'ArrowDown':  e.preventDefault(); navigateTo(curR + 1, curC, e.shiftKey); return;
        case 'ArrowLeft':  e.preventDefault(); navigateTo(curR, curC - 1, e.shiftKey); return;
        case 'ArrowRight': e.preventDefault(); navigateTo(curR, curC + 1, e.shiftKey); return;
        case 'Tab':    e.preventDefault(); navigateTo(curR, curC + (e.shiftKey ? -1 : 1)); return;
        case 'PageDown': {
          e.preventDefault();
          const wrapPg = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
          const pageRows = wrapPg ? Math.floor(wrapPg.clientHeight / XL_VX_ROW_H) : 20;
          navigateTo(Math.min(getMaxRows()-1, curR + pageRows), curC, e.shiftKey); return;
        }
        case 'PageUp': {
          e.preventDefault();
          const wrapPg = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
          const pageRows = wrapPg ? Math.floor(wrapPg.clientHeight / XL_VX_ROW_H) : 20;
          navigateTo(Math.max(0, curR - pageRows), curC, e.shiftKey); return;
        }
        case 'Enter':
        case 'F2':     e.preventDefault(); enterEdit(curR, curC); return;
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          pushUndo();
          const r1 = Math.min(selStart.r, selEnd?.r ?? curR), r2 = Math.max(selStart.r, selEnd?.r ?? curR);
          const c1 = Math.min(selStart.c, selEnd?.c ?? curC), c2 = Math.max(selStart.c, selEnd?.c ?? curC);
          if (vd) {
            syncDomToData();
            for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
              if (vd[r]?.[c]) vd[r][c] = { v: '', s: vd[r][c].s };
              const td_ = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td_) { td_.innerText = ''; delete td_.dataset.formula; }
            }
            saveGrid(vd);
          } else {
            for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
              const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
              if (td) { td.innerText = ''; delete td.dataset.formula; }
            }
            saveGrid(grid());
          }
          return;
        }
        default:
          if (e.key.length === 1) { e.preventDefault(); enterEdit(curR, curC, e.key); }
      }
    };
    document.addEventListener('keydown', onKey);
    (this as any)._xlKeyHandler?.();
    (this as any)._xlKeyHandler = () => document.removeEventListener('keydown', onKey);

    // Paste (document-level so it works even when no cell has focus)
    const onPaste = (e: ClipboardEvent) => {
      if (this.root.style.display === 'none') return;
      if (editMode) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && !this.root.contains(active) && active !== document.body) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      pushUndo();
      if (vd) {
        // Virtual scroll: write directly to vd (works regardless of viewport)
        syncDomToData();
        text.split(/\r?\n/).forEach((line, dr) => {
          line.split('\t').forEach((val, dc) => {
            const tr_ = curR + dr, tc_ = curC + dc;
            if (tr_ < vd.length && tc_ < (vd[0]?.length ?? 0)) {
              vd[tr_][tc_] = { ...vd[tr_][tc_], v: val };
              const td_ = body.querySelector<HTMLTableCellElement>(`td[data-r="${tr_}"][data-c="${tc_}"]`);
              if (td_) td_.innerText = val;
            }
          });
        });
        saveGrid(vd);
      } else {
        text.split(/\r?\n/).forEach((line, dr) => {
          line.split('\t').forEach((val, dc) => {
            const cell = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR + dr}"][data-c="${curC + dc}"]`);
            if (cell) cell.innerText = val;
          });
        });
        saveGrid(grid());
      }
    };
    document.addEventListener('paste', onPaste);
    (this as any)._xlPasteHandler?.();
    (this as any)._xlPasteHandler = () => document.removeEventListener('paste', onPaste);

    // Column resize
    this.root.querySelectorAll<HTMLElement>('.dx-col-resize').forEach(handle => {
      // Double-click → auto-fit column width to content
      handle.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        const colIdx = +handle.dataset.colR!;
        const th_ = handle.parentElement as HTMLElement;
        let maxW = 50;
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;padding:3px 8px;font-size:13px;font-family:inherit';
        document.body.appendChild(probe);
        (vd ?? grid()).forEach((row, r) => {
          const cell = row[colIdx]; if (!cell) return;
          probe.style.fontWeight = cell.s?.includes('bold') ? 'bold' : '';
          probe.textContent = cell.v ?? '';
          maxW = Math.max(maxW, probe.offsetWidth + 2);
          if (r === 0) maxW = Math.max(maxW, probe.offsetWidth + 16); // header padding
        });
        document.body.removeChild(probe);
        maxW = Math.min(maxW, 400);
        th_.style.minWidth = th_.style.width = maxW + 'px';
        this.root.querySelectorAll<HTMLElement>(`td[data-c="${colIdx}"]`).forEach(td_ => { td_.style.minWidth = td_.style.width = maxW + 'px'; });
        const ec = getEC(); const sh = getSheet();
        const cws: (number|null)[] = sh.colWidths ? [...sh.colWidths] : Array.from({length: sh.data[0]?.length ?? 0}, () => null);
        while (cws.length <= colIdx) cws.push(null);
        cws[colIdx] = maxW;
        ec.sheets[this.activeSheetIdx] = { ...sh, colWidths: cws };
        this.updateContent(doc.id, JSON.stringify(ec));
      });
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const colIdx=+handle.dataset.colR!;
        const th=handle.parentElement as HTMLElement;
        const startX=e.clientX, startW=th.offsetWidth;
        handle.classList.add('active');
        const onMove=(ev: MouseEvent)=>{
          const w=Math.max(40,startW+(ev.clientX-startX));
          th.style.minWidth=th.style.width=w+'px';
          // Set width on TDs only for live visual feedback — NOT stored in cell.s (filtered by cellStyle())
          this.root.querySelectorAll<HTMLElement>(`td[data-c="${colIdx}"]`).forEach(td=>{td.style.minWidth=td.style.width=w+'px';});
        };
        const onUp=()=>{
          handle.classList.remove('active');
          document.removeEventListener('mousemove',onMove);
          document.removeEventListener('mouseup',onUp);
          // Persist column width in the data model
          const w = th.offsetWidth;
          const ec = getEC(); const sh = getSheet();
          const cws: (number|null)[] = sh.colWidths ? [...sh.colWidths] : Array.from({length: sh.data[0]?.length ?? 0}, () => null);
          while (cws.length <= colIdx) cws.push(null);
          cws[colIdx] = w;
          ec.sheets[this.activeSheetIdx] = { ...sh, colWidths: cws };
          this.updateContent(doc.id, JSON.stringify(ec));
        };
        document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
      });
    });

    const curCell=()=>body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`);
    const selectedCells=():HTMLTableCellElement[]=>{
      if(!selStart||!selEnd) return [curCell()].filter(Boolean) as HTMLTableCellElement[];
      const r1=Math.min(selStart.r,selEnd.r),r2=Math.max(selStart.r,selEnd.r);
      const c1=Math.min(selStart.c,selEnd.c),c2=Math.max(selStart.c,selEnd.c);
      const out:HTMLTableCellElement[]=[];
      for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++){
        const td=body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
        if(td) out.push(td);
      }
      return out;
    };

    // B/I/U/S
    this.root.querySelectorAll<HTMLButtonElement>('[data-xf]').forEach(btn => {
      btn.addEventListener('mousedown',e=>e.preventDefault());
      btn.addEventListener('click',()=>{
        const cells=selectedCells(); if(!cells.length) return;
        const fmt=btn.dataset.xf!;
        const first=cells[0];
        const isBold=first.style.fontWeight==='bold', isItalic=first.style.fontStyle==='italic';
        const isUnder=first.style.textDecoration.includes('underline'), isStrike=first.style.textDecoration.includes('line-through');
        cells.forEach(cell=>{
          if(fmt==='bold') cell.style.fontWeight=isBold?'':'bold';
          else if(fmt==='italic') cell.style.fontStyle=isItalic?'':'italic';
          else if(fmt==='underline') cell.style.textDecoration=isUnder?'':'underline';
          else if(fmt==='strike') cell.style.textDecoration=isStrike?'':'line-through';
        });
        commit(); updateToolbarState();
      });
    });

    this.root.querySelector<HTMLSelectElement>('[data-xf-font]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement;
      if(sel.value) selectedCells().forEach(c=>c.style.fontFamily=sel.value);
      sel.value=''; commit(); updateToolbarState();
    });
    this.root.querySelector<HTMLSelectElement>('[data-xf-size]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement;
      if(sel.value) selectedCells().forEach(c=>c.style.fontSize=sel.value);
      sel.value=''; commit(); updateToolbarState();
    });
    this.root.querySelector<HTMLInputElement>('[data-xf-color]')?.addEventListener('input',e=>{
      const hex=(e.target as HTMLInputElement).value;
      selectedCells().forEach(c=>c.style.color=hex);
      const bar=this.root.querySelector<HTMLElement>('#dx-color-bar'); if(bar) bar.style.background=hex;
      commit();
    });
    this.root.querySelector<HTMLInputElement>('[data-xf-bg]')?.addEventListener('input',e=>{
      const hex=(e.target as HTMLInputElement).value;
      selectedCells().forEach(c=>c.style.background=hex);
      const bar=this.root.querySelector<HTMLElement>('#dx-bg-bar'); if(bar) bar.style.background=hex;
      commit();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-xa-align]').forEach(btn=>{
      btn.addEventListener('mousedown',e=>e.preventDefault());
      btn.addEventListener('click',()=>{selectedCells().forEach(c=>c.style.textAlign=btn.dataset.xaAlign!);commit();updateToolbarState();});
    });
    this.root.querySelector<HTMLSelectElement>('[data-xf-border]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement; if(!sel.value) return;
      const thin='1px solid #333', thick='2.5px solid #111';
      selectedCells().forEach(c=>{
        const v=sel.value;
        if(v==='all') c.style.border=thin;
        else if(v==='outer') c.style.border=thin;
        else if(v==='thick') c.style.border=thick;
        else if(v==='top') c.style.borderTop=thin;
        else if(v==='bottom') c.style.borderBottom=thin;
        else if(v==='left') c.style.borderLeft=thin;
        else if(v==='right') c.style.borderRight=thin;
        else if(v==='none') c.style.border='';
      });
      sel.value=''; commit();
    });
    // Числовой формат — слой отображения над значением, а не замена текста.
    // Меняем только data-nf и перерисовываем; сырое число остаётся нетронутым,
    // поэтому SUM, сортировка и экспорт продолжают видеть число.
    this.root.querySelectorAll<HTMLButtonElement>('[data-xf-num]').forEach(btn=>{
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click',()=>{
        const cells=selectedCells(); if(!cells.length) return;
        const preset=btn.dataset.xfNum!;
        const code=PRESET_FORMATS[preset] ?? 'General';
        pushUndo();
        const rows=grid();
        cells.forEach(td=>{
          const cur=this.cellFromTd(td, cellStyle(td));
          // Текст, который выглядит как число, при навешивании числового
          // формата становится числом — так же ведёт себя Excel.
          if(code!=='General' && code!=='@' && cur.t!=='n' && !cur.v.startsWith('=')){
            const n=parseUserNumber(cur.v);
            if(n!==null){ cur.v=String(n); cur.t='n'; }
          }
          if(code==='General') delete cur.nf; else cur.nf=code;
          if(code==='@'){ delete cur.t; delete cur.nf; }
          this.applyCellToTd(td, cur, rows);
        });
        commit(); updateToolbarState();
      });
    });

    // Toolbar actions
    this.root.querySelectorAll<HTMLButtonElement>('.dx-btn[data-xa]').forEach(btn=>{
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click',()=>{
        const act=btn.dataset.xa!, rows=grid();
        if(act==='undo'){doUndo();return;}
        if(act==='redo'){doRedo();return;}
        if(act==='clear'){
          if(confirm('Очистить текущий лист?')){saveGrid(rows.map(r=>r.map(()=>({v:''} as CellData))));this.render();}
          return;
        }
        if(act==='find'){(this as any)._openFindPanel?.();return;}
        if(act==='wrap'){
          const cells=selectedCells(); if(!cells.length) return;
          const first=cells[0];
          const isWrapped = first.style.whiteSpace==='normal';
          cells.forEach(c=>{
            if(isWrapped){ c.style.whiteSpace=''; c.style.overflow=''; }
            else{ c.style.whiteSpace='normal'; c.style.overflow='visible'; }
          });
          commit(); updateToolbarState(); return;
        }
        if(act==='sort-asc'||act==='sort-desc'){
          const c=curC, dir=act==='sort-asc'?1:-1;
          const header=rows[0], rest=rows.slice(1);
          rest.sort((a,b)=>{
            const av=a[c]?.v??'', bv=b[c]?.v??'';
            const an=parseFloat(av), bn=parseFloat(bv);
            if(!isNaN(an)&&!isNaN(bn)) return(an-bn)*dir;
            return av.localeCompare(bv,'ru')*dir;
          });
          saveGrid([header,...rest]); this.render(); return;
        }
        if(act==='freeze-row'){
          this.xlFreezeRow=!this.xlFreezeRow;
          btn.classList.toggle('dx-active',this.xlFreezeRow);
          this.root.querySelector('#docs-excel-wrap')?.classList.toggle('dx-freeze-row',this.xlFreezeRow);
          return;
        }
        if(act==='freeze-col'){
          this.xlFreezeCol=!this.xlFreezeCol;
          btn.classList.toggle('dx-active',this.xlFreezeCol);
          this.root.querySelector('#docs-excel-wrap')?.classList.toggle('dx-freeze-col',this.xlFreezeCol);
          return;
        }
        if(act==='autofilter'){
          this.xlFilterOn=!this.xlFilterOn;
          this.xlFilterState={};
          btn.classList.toggle('dx-active',this.xlFilterOn);
          if(this.xlFilterOn){
            // Inject filter arrows into column headers (row 0 = header row)
            this.root.querySelectorAll<HTMLElement>('th.dx-colhdr').forEach(th=>{
              if(th.querySelector('.dx-filter-btn')) return;
              const ci=+(th.dataset.col??'0');
              const fb=document.createElement('button');
              fb.className='dx-filter-btn'; fb.dataset.filterCol=String(ci); fb.title='Фильтр'; fb.textContent='▾';
              th.appendChild(fb);
              fb.addEventListener('click',(ev)=>{ev.stopPropagation();this.openFilterDropdown(ci,fb,vd??grid(),body,()=>{
                body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr=>{
                  const r=+(tr.dataset.row??'0'); if(r===0){tr.style.display='';return;}
                  let show=true;
                  for(const [cis,allowed] of Object.entries(this.xlFilterState)){
                    const col=+cis;
                    const val=vd?vd[r]?.[col]?.v??'':tr.querySelector<HTMLTableCellElement>(`td[data-c="${col}"]`)?.innerText??'';
                    if(allowed.size>0&&!allowed.has(val)){show=false;break;}
                  }
                  tr.style.display=show?'':'none';
                });
              });});
            });
          } else {
            this.root.querySelectorAll('.dx-filter-btn').forEach(fb=>fb.remove());
            document.querySelector('.dx-filter-dropdown')?.remove();
            body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr=>{tr.style.display='';});
          }
          return;
        }
      });
    });

    // ── Right-click context menu ──────────────────────────────────────────────
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const td = (e.target as HTMLElement).closest('td') as HTMLTableCellElement | null;
      if (!td) return;
      const r = +(td.getAttribute('data-r') ?? '0');
      const c = +(td.getAttribute('data-c') ?? '0');
      // Focus that cell if not already selected
      if (curR !== r || curC !== c) { curR = r; curC = c; selStart = {r,c}; selEnd = {r,c}; applySel(); syncFormulaBar(); }
      document.querySelector('.dx-ctx-menu')?.remove();
      const hasSel = selStart && selEnd && (selStart.r !== selEnd.r || selStart.c !== selEnd.c);
      const menu = document.createElement('div');
      menu.className = 'dx-ctx-menu';
      menu.style.cssText = `left:${Math.min(e.clientX, window.innerWidth - 220)}px;top:${Math.min(e.clientY, window.innerHeight - 280)}px`;
      const items: Array<{ label?: string; icon?: string; action?: string; danger?: boolean; sep?: boolean; disabled?: boolean }> = [
        { icon: '⎘', label: 'Копировать (Ctrl+C)', action: 'copy' },
        { icon: '⎗', label: 'Вставить (Ctrl+V)', action: 'paste-ctx' },
        { sep: true },
        { icon: '↑', label: 'Вставить строку выше', action: 'ins-row-above' },
        { icon: '↓', label: 'Вставить строку ниже', action: 'ins-row-below' },
        { icon: '←', label: 'Вставить столбец слева', action: 'ins-col-left' },
        { icon: '→', label: 'Вставить столбец справа', action: 'ins-col-right' },
        { sep: true },
        { icon: '✕', label: 'Удалить строку', action: 'del-row', danger: true },
        { icon: '✕', label: 'Удалить столбец', action: 'del-col', danger: true },
        { sep: true },
        { icon: '⌫', label: hasSel ? 'Очистить выделенные' : 'Очистить ячейку', action: 'clear-cells' },
        { icon: '◻', label: 'Убрать форматирование', action: 'clear-fmt' },
        { sep: true },
        { icon: '⤢', label: 'Выделить всю строку', action: 'sel-row' },
        { icon: '⤡', label: 'Выделить весь столбец', action: 'sel-col' },
      ];
      menu.innerHTML = items.map(it => {
        if (it.sep) return '<div class="dx-ctx-sep"></div>';
        return `<div class="dx-ctx-item${it.danger ? ' dx-ctx-danger' : ''}${it.disabled ? ' dx-ctx-disabled' : ''}" data-ctx="${it.action}">
          <span class="dx-ctx-icon">${it.icon ?? ''}</span>${it.label}
        </div>`;
      }).join('');
      document.body.appendChild(menu);
      menu.addEventListener('click', (ev) => {
        const tgt = (ev.target as HTMLElement).closest('[data-ctx]') as HTMLElement | null;
        if (!tgt) return;
        menu.remove();
        const act = tgt.dataset.ctx!;
        const rowsNow = grid();
        const totalCols2 = rowsNow[0]?.length ?? 0;
        if (act === 'copy') {
          const cr1=Math.min(selStart?.r??r,selEnd?.r??r), cr2=Math.max(selStart?.r??r,selEnd?.r??r);
          const cc1=Math.min(selStart?.c??c,selEnd?.c??c), cc2=Math.max(selStart?.c??c,selEnd?.c??c);
          const lines: string[] = [];
          for (let ri=cr1;ri<=cr2;ri++) { const row_: string[]=[]; for(let ci=cc1;ci<=cc2;ci++) { row_.push(vd?vd[ri]?.[ci]?.v??'':rowsNow[ri]?.[ci]?.v??''); } lines.push(row_.join('\t')); }
          navigator.clipboard.writeText(lines.join('\n')).catch(()=>{});
        }
        else if (act === 'paste-ctx') {
          navigator.clipboard.readText().then(text => {
            if (!text) return;
            pushUndo();
            if (vd) {
              syncDomToData();
              text.split(/\r?\n/).forEach((line, dr) => { line.split('\t').forEach((val, dc) => { const tr_=r+dr,tc_=c+dc; if(tr_<vd.length&&tc_<(vd[0]?.length??0)){vd[tr_][tc_]={...vd[tr_][tc_],v:val};const td_=body.querySelector<HTMLTableCellElement>(`td[data-r="${tr_}"][data-c="${tc_}"]`);if(td_)td_.innerText=val;} }); });
              saveGrid(vd);
            } else {
              text.split(/\r?\n/).forEach((line, dr) => { line.split('\t').forEach((val, dc) => { const cell_=body.querySelector<HTMLTableCellElement>(`td[data-r="${r+dr}"][data-c="${c+dc}"]`);if(cell_)cell_.innerText=val; }); });
              saveGrid(grid());
            }
          }).catch(()=>{});
        }
        else if (act === 'ins-row-above') { pushUndo(); rowsNow.splice(r, 0, Array.from({length: totalCols2}, ()=>({v:''}as CellData))); saveGrid(rowsNow); this.render(); }
        else if (act === 'ins-row-below') { pushUndo(); rowsNow.splice(r + 1, 0, Array.from({length: totalCols2}, ()=>({v:''}as CellData))); saveGrid(rowsNow); this.render(); }
        else if (act === 'ins-col-left') { pushUndo(); rowsNow.forEach(row => row.splice(c, 0, {v:''})); saveGrid(rowsNow); this.render(); }
        else if (act === 'ins-col-right') { pushUndo(); rowsNow.forEach(row => row.splice(c + 1, 0, {v:''})); saveGrid(rowsNow); this.render(); }
        else if (act === 'del-row') { pushUndo(); if (rowsNow.length > 1) { rowsNow.splice(r, 1); saveGrid(rowsNow); this.render(); } }
        else if (act === 'del-col') { pushUndo(); if (totalCols2 > 1) { rowsNow.forEach(row => row.splice(c, 1)); saveGrid(rowsNow); this.render(); } }
        else if (act === 'clear-cells') {
          const r1 = selStart ? Math.min(selStart.r, selEnd!.r) : r;
          const r2 = selStart ? Math.max(selStart.r, selEnd!.r) : r;
          const c1 = selStart ? Math.min(selStart.c, selEnd!.c) : c;
          const c2 = selStart ? Math.max(selStart.c, selEnd!.c) : c;
          pushUndo();
          if (vd) {
            syncDomToData();
            for (let ri=r1;ri<=r2;ri++) for (let ci=c1;ci<=c2;ci++) { if(vd[ri]?.[ci]) vd[ri][ci]={v:'',s:vd[ri][ci].s}; }
            saveGrid(vd);
          } else {
            for (let ri=r1;ri<=r2;ri++) for (let ci=c1;ci<=c2;ci++) { const td2=body.querySelector<HTMLTableCellElement>(`td[data-r="${ri}"][data-c="${ci}"]`);if(td2){td2.innerText='';delete td2.dataset.formula;} }
            saveGrid(grid());
          }
        }
        else if (act === 'clear-fmt') {
          pushUndo();
          selectedCells().forEach(td2 => { td2.style.cssText = ''; });
          if (!hasSel) { const td2 = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`); if(td2) td2.style.cssText=''; }
          saveGrid(grid());
        }
        else if (act === 'sel-row') { const totalC = (vd??grid())[0]?.length??0; selStart={r,c:0}; selEnd={r,c:totalC-1}; applySel(); }
        else if (act === 'sel-col') { const totalR = (vd??grid()).length; selStart={r:0,c}; selEnd={r:totalR-1,c}; applySel(); }
      });
      const closeMenu = () => { document.querySelector('.dx-ctx-menu')?.remove(); document.removeEventListener('click', closeMenu, true); };
      setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
    });

    // Col add/del
    this.root.querySelectorAll<HTMLButtonElement>('[data-col-add]').forEach(btn=>{
      btn.addEventListener('click',e=>{e.stopPropagation();const c=+btn.dataset.colAdd!;const rows=grid();rows.forEach(r=>r.splice(c+1,0,{v:''}));saveGrid(rows);this.render();});
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-col-del]').forEach(btn=>{
      btn.addEventListener('click',e=>{e.stopPropagation();const c=+btn.dataset.colDel!;const rows=grid();if((rows[0]?.length??0)<=1)return;rows.forEach(r=>r.splice(c,1));saveGrid(rows);this.render();});
    });
    // bindRowOps: row-level handlers — called initially AND after each virtual scroll update
    const bindRowOps = () => {
      body.querySelectorAll<HTMLElement>('th.dx-rowhdr').forEach(th => {
        th.addEventListener('click', (e) => {
          if((e.target as HTMLElement).closest('.dx-hdr-actions,.dx-row-resize')) return;
          const r=+(th.dataset.rowHdr??'0');
          const totalCols = (vd??grid())[0]?.length??0;
          selStart={r,c:0}; selEnd={r,c:totalCols-1}; applySel();
        });
      });
      body.querySelectorAll<HTMLElement>('.dx-row-resize').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault(); e.stopPropagation();
          const rowIdx=+handle.dataset.rowR!;
          const tr=body.querySelector<HTMLElement>(`tr[data-row="${rowIdx}"]`); if(!tr) return;
          const startY=e.clientY, startH=tr.offsetHeight;
          handle.classList.add('active');
          const onMove=(ev: MouseEvent)=>{tr.style.height=Math.max(22,startH+(ev.clientY-startY))+'px';};
          const onUp=()=>{
            handle.classList.remove('active');
            document.removeEventListener('mousemove',onMove);
            document.removeEventListener('mouseup',onUp);
            // Persist row height in the data model
            const h = Math.max(22, parseInt(tr.style.height) || tr.offsetHeight);
            const ec = getEC(); const sh = getSheet();
            const rhs: (number|null)[] = sh.rowHeights ? [...sh.rowHeights] : Array.from({length: sh.data.length}, () => null);
            while (rhs.length <= rowIdx) rhs.push(null);
            rhs[rowIdx] = h;
            ec.sheets[this.activeSheetIdx] = { ...sh, rowHeights: rhs };
            this.updateContent(doc.id, JSON.stringify(ec));
          };
          document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
        });
      });
      body.querySelectorAll<HTMLButtonElement>('[data-row-add]').forEach(btn=>{
        btn.addEventListener('click',e=>{e.stopPropagation();const r=+btn.dataset.rowAdd!;const rows=grid();const nc=rows[0]?.length??1;rows.splice(r+1,0,Array.from({length:nc},()=>({v:''}as CellData)));saveGrid(rows);this.render();});
      });
      body.querySelectorAll<HTMLButtonElement>('[data-row-del]').forEach(btn=>{
        btn.addEventListener('click',e=>{e.stopPropagation();const r=+btn.dataset.rowDel!;const rows=grid();if(rows.length<=1)return;rows.splice(r,1);saveGrid(rows);this.render();});
      });
    };
    bindRowOps();

    // ── Find & Replace panel (modal, rendered in document.body) ──────────────
    const bindFindPanel = () => {
      document.getElementById('dx-fp-portal')?.remove();

      const panel = document.createElement('div');
      panel.id = 'dx-fp-portal';
      panel.innerHTML = `
        <div class="fpr-dialog" id="fpr-dialog">
          <div class="fpr-header">
            <span class="fpr-title">Поиск и замена</span>
            <div class="fpr-header-nav">
              <button class="fpr-nav" id="fpr-prev" title="Предыдущее (Shift+Enter)">↑</button>
              <button class="fpr-nav" id="fpr-next" title="Следующее (Enter)">↓</button>
              <span class="fpr-cnt" id="fpr-cnt"></span>
            </div>
            <button class="fpr-x" id="fpr-close" title="Закрыть (Esc)">✕</button>
          </div>
          <div class="fpr-body">
            <div class="fpr-row">
              <label class="fpr-label">Найти</label>
              <input class="fpr-input" id="fpr-q" type="text" placeholder="текст; другой текст; ещё один" autocomplete="off">
            </div>
            <div class="fpr-hint">Несколько значений — через <b>;</b> (например: <i>столы; стулики</i>)</div>
            <div class="fpr-row">
              <label class="fpr-label">Заменить</label>
              <input class="fpr-input" id="fpr-r" type="text" placeholder="Новое значение…" autocomplete="off">
              <button class="fpr-btn" id="fpr-one">Одно</button>
              <button class="fpr-btn fpr-btn-accent" id="fpr-all">Все</button>
            </div>
            <div class="fpr-opts">
              <label class="fpr-opt"><input type="checkbox" id="fpr-case"><span>Регистр</span></label>
              <label class="fpr-opt"><input type="checkbox" id="fpr-whole"><span>Вся ячейка</span></label>
            </div>
            <div class="fpr-log-wrap">
              <div class="fpr-log-head" id="fpr-log-head" style="display:none">
                <span id="fpr-log-title"></span>
              </div>
              <div class="fpr-log" id="fpr-log"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(panel);

      // Prevent any mousedown inside the dialog from bubbling to the spreadsheet
      panel.querySelector('#fpr-dialog')!.addEventListener('mousedown', e => e.stopPropagation());

      const qEl   = panel.querySelector<HTMLInputElement>('#fpr-q')!;
      const rEl   = panel.querySelector<HTMLInputElement>('#fpr-r')!;
      const csEl  = panel.querySelector<HTMLInputElement>('#fpr-case')!;
      const wcEl  = panel.querySelector<HTMLInputElement>('#fpr-whole')!;
      const cntEl = panel.querySelector<HTMLElement>('#fpr-cnt')!;
      const logEl = panel.querySelector<HTMLElement>('#fpr-log')!;
      const logHead = panel.querySelector<HTMLElement>('#fpr-log-head')!;
      const logTitle = panel.querySelector<HTMLElement>('#fpr-log-title')!;

      // Parse multi-value search: "столы; стулики" → ["столы", "стулики"]
      const getNeedles = (): string[] =>
        qEl.value.split(';').map(s => s.trim()).filter(s => s.length > 0);

      let matchList: Array<{r: number; c: number; v: string}> = [];
      let matchCur = -1;

      const isMatch = (val: string, needle: string): boolean => {
        const a = csEl.checked ? val : val.toLowerCase();
        const b = csEl.checked ? needle : needle.toLowerCase();
        return wcEl.checked ? a === b : a.includes(b);
      };
      const cellMatchesAny = (val: string, needles: string[]): boolean =>
        needles.some(n => isMatch(val, n));

      const allRowIndices = (): number[] =>
        vd ? Array.from({length: vd.length}, (_, i) => i)
           : Array.from(body.querySelectorAll<HTMLElement>('tr[data-row]')).map(tr => +(tr.dataset.row!));

      const getCellValue = (r: number, c: number): string => {
        if (vd) return vd[r]?.[c]?.v ?? '';
        return body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.innerText ?? '';
      };

      const clearHighlight = () => {
        body.querySelectorAll('td.dx-find-hit, td.dx-find-cur, tr.dx-row-cur')
          .forEach(el => el.classList.remove('dx-find-hit', 'dx-find-cur', 'dx-row-cur'));
      };

      const highlightVisible = (needles: string[]) => {
        body.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach(td => {
          if (cellMatchesAny(td.innerText, needles)) td.classList.add('dx-find-hit');
        });
      };

      // Scroll the wrap container so row r is visible (works with virtual scroll)
      const scrollWrapToRow = (r: number) => {
        navigateTo(r, curC);
      };

      const updateLog = (needles: string[]) => {
        if (!matchList.length || !needles.length) {
          logHead.style.display = 'none';
          logEl.innerHTML = '';
          return;
        }
        logHead.style.display = '';
        logTitle.textContent = `Найдено: ${matchList.length} ячеек`;
        const rows = matchList.map((m, idx) => {
          const colLetter = this.colLetter(m.c);
          const isCur = idx === matchCur;
          return `<div class="fpr-log-row${isCur ? ' fpr-log-cur' : ''}" data-mi="${idx}">
            <span class="fpr-log-addr">${colLetter}${m.r + 1}</span>
            <span class="fpr-log-val">${this.esc(String(m.v).slice(0, 60))}${m.v.length > 60 ? '…' : ''}</span>
          </div>`;
        }).join('');
        logEl.innerHTML = rows;
        // Scroll current item into view inside the log
        const curRow = logEl.querySelector<HTMLElement>('.fpr-log-cur');
        curRow?.scrollIntoView({ block: 'nearest' });
        // Click on log row → navigate
        logEl.querySelectorAll<HTMLElement>('.fpr-log-row').forEach(el => {
          el.addEventListener('click', () => {
            const mi = +(el.dataset.mi ?? '0');
            matchCur = mi;
            clearHighlight();
            highlightVisible(needles);
            scrollWrapToRow(matchList[matchCur].r);
            cntEl.textContent = `${matchCur + 1} / ${matchList.length}`;
            updateLog(needles);
          });
        });
      };

      const applyFilter = () => {
        const needles = getNeedles();
        clearHighlight();
        matchList = [];
        if (needles.length) {
          for (const r of allRowIndices()) {
            const totalCols = vd ? (vd[r]?.length ?? 0) : (body.querySelector(`tr[data-row="${r}"]`)?.querySelectorAll('td').length ?? 0);
            for (let c = 0; c < totalCols; c++) {
              const v = getCellValue(r, c);
              if (cellMatchesAny(v, needles)) matchList.push({ r, c, v });
            }
          }
        }
        matchCur = matchList.length > 0 ? 0 : -1;
        if (needles.length) highlightVisible(needles);
        cntEl.textContent = needles.length ? `${matchList.length} ячеек` : '';
        if (matchCur >= 0) scrollWrapToRow(matchList[matchCur].r);
        updateLog(needles);
      };

      const navigate = (dir: 1 | -1) => {
        if (!matchList.length) return;
        matchCur = (matchCur + dir + matchList.length) % matchList.length;
        clearHighlight();
        highlightVisible(getNeedles());
        scrollWrapToRow(matchList[matchCur].r);
        cntEl.textContent = `${matchCur + 1} / ${matchList.length}`;
        updateLog(getNeedles());
        // highlight the specific current cell
        requestAnimationFrame(() => {
          const m = matchList[matchCur];
          body.querySelector<HTMLElement>(`td[data-r="${m.r}"][data-c="${m.c}"]`)?.classList.add('dx-find-cur');
        });
      };

      // Apply a replacement to a single value (all matching needles → replacement)
      const doReplaceVal = (v: string, needles: string[], replacement: string): string => {
        if (wcEl.checked) {
          return cellMatchesAny(v, needles) ? replacement : v;
        }
        let result = v;
        for (const n of needles) {
          const re = new RegExp(this.escRe(n), csEl.checked ? 'g' : 'gi');
          result = result.replace(re, replacement);
        }
        return result;
      };

      const setCellVal = (r: number, c: number, newVal: string) => {
        if (vd) {
          if (vd[r]?.[c] !== undefined) vd[r][c] = { ...vd[r][c], v: newVal };
          const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
          if (td) td.innerText = newVal;
        } else {
          const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
          if (td) td.innerText = newVal;
        }
      };

      const replaceOne = () => {
        const needles = getNeedles(); if (!needles.length) return;
        if (matchCur < 0 || matchCur >= matchList.length) { applyFilter(); return; }
        const { r, c, v } = matchList[matchCur];
        const newVal = doReplaceVal(v, needles, rEl.value);
        setCellVal(r, c, newVal);
        saveGrid(grid());
        applyFilter();
      };

      const replaceAll = () => {
        const needles = getNeedles(); if (!needles.length) return;
        let count = 0;
        const toReplace = [...matchList];
        for (const { r, c, v } of toReplace) {
          const newVal = doReplaceVal(v, needles, rEl.value);
          if (newVal !== v) { setCellVal(r, c, newVal); count++; }
        }
        saveGrid(grid());
        clearHighlight(); matchList = []; matchCur = -1;
        cntEl.textContent = `Заменено: ${count}`;
        logHead.style.display = '';
        logTitle.textContent = `Заменено: ${count} ячеек`;
        logEl.innerHTML = '';
      };

      const openPanel = () => {
        panel.style.display = 'flex';
        document.removeEventListener('keydown', onKey);
        setTimeout(() => qEl.focus(), 0);
      };
      const closePanel = () => {
        panel.style.display = 'none';
        document.removeEventListener('keydown', onKey);
        document.addEventListener('keydown', onKey);
        clearHighlight();
        qEl.value = ''; rEl.value = ''; cntEl.textContent = '';
        matchList = []; matchCur = -1;
        logEl.innerHTML = ''; logHead.style.display = 'none';
      };

      let filterTimer: ReturnType<typeof setTimeout> | null = null;
      qEl.addEventListener('input', () => {
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(applyFilter, 200);
      });
      csEl.addEventListener('change', applyFilter);
      wcEl.addEventListener('change', applyFilter);

      panel.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
        else if (e.key === 'Enter' && e.target === qEl) {
          e.preventDefault(); navigate(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Enter' && e.target === rEl) {
          e.preventDefault(); replaceOne();
        }
      });

      panel.querySelector('#fpr-prev')!.addEventListener('click', () => navigate(-1));
      panel.querySelector('#fpr-next')!.addEventListener('click', () => navigate(1));
      panel.querySelector('#fpr-one')!.addEventListener('click', replaceOne);
      panel.querySelector('#fpr-all')!.addEventListener('click', replaceAll);
      panel.querySelector('#fpr-close')!.addEventListener('click', closePanel);

      (this as any)._xlKeyHandler = () => { document.removeEventListener('keydown', onKey); panel.remove(); };
      (this as any)._openFindPanel = openPanel;
    };
    bindFindPanel();

    // Virtual scroll: slide the rendered window as user scrolls
    if (vd) {
      const wrapEl = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
      const sheet = this.parseExcelContent(doc.content).sheets[this.activeSheetIdx];
      const vColW = sheet.colWidths ?? [];
      const vRowH = sheet.rowHeights ?? [];
      const vCols = vd[0]?.length ?? 1;

      // Build cumulative height index: vCumH[i] = top px of row i (supports custom row heights)
      const vCumH_: number[] = new Array(vd.length + 1);
      vCumH_[0] = 0;
      for (let i = 0; i < vd.length; i++) vCumH_[i + 1] = vCumH_[i] + (vRowH[i] ?? XL_VX_ROW_H);
      const totalVH = vCumH_[vd.length];

      // Binary search: which row is at a given scrollTop
      const rowAtScroll = (scrollY: number): number => {
        let lo = 0, hi = vd.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (vCumH_[m] <= scrollY) lo = m + 1; else hi = m; }
        return Math.max(0, lo - 1);
      };

      const updateWindow = (startR: number) => {
        vxLastStart = startR;
        const endR = Math.min(vd.length, startR + XL_VX_PAGE + 2 * XL_VX_BUF);
        vxLastEnd = endR;
        const topH = vCumH_[startR];
        const botH = totalVH - vCumH_[endR];
        const span = vCols + 1;
        const vxMergeInfo = this.buildMergeInfo(vdMerges ?? undefined);
        let html = '';
        if (topH > 0) html += `<tr class="vx-spacer" style="height:${topH}px"><td colspan="${span}" style="padding:0;border:0;pointer-events:none"></td></tr>`;
        for (let r = startR; r < endR; r++) {
          const h = vRowH[r]; const hStyle = h ? ` style="height:${h}px"` : '';
          html += `<tr data-row="${r}"${hStyle}><th class="dx-rowhdr" data-row-hdr="${r}"><span class="dx-hdr-label">${r+1}</span><div class="dx-hdr-actions dx-hdr-actions-row"><button class="dx-hdr-btn" data-row-add="${r}" title="Добавить строку ниже">+</button><button class="dx-hdr-btn dx-danger" data-row-del="${r}" title="Удалить строку">−</button></div><div class="dx-row-resize" data-row-r="${r}"></div></th>${vd[r].map((cell,c)=>{const cw=vColW[c];return this.renderCell(vd,r,c,cell,cw?`min-width:${cw}px;width:${cw}px;`:'',vxMergeInfo);}).join('')}</tr>`;
        }
        if (botH > 0) html += `<tr class="vx-spacer" style="height:${botH}px"><td colspan="${span}" style="padding:0;border:0;pointer-events:none"></td></tr>`;
        body.innerHTML = html;
        bindRowOps();
      };

      // Expose to navigateTo (declared before this block)
      vxUpdateWindow = updateWindow;
      vxCumH = vCumH_;
      vxWrap = wrapEl;

      // Re-applies active autofilter to newly rendered rows
      const reapplyFilter = () => {
        if (!this.xlFilterOn || !Object.keys(this.xlFilterState).length) return;
        body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr => {
          const rowIdx = +(tr.dataset.row ?? '0');
          if (rowIdx === 0) { tr.style.display = ''; return; }
          let show = true;
          for (const [cis, allowed] of Object.entries(this.xlFilterState)) {
            const ci = +cis;
            const val = vd[rowIdx]?.[ci]?.v ?? '';
            if (allowed.size > 0 && !allowed.has(val)) { show = false; break; }
          }
          tr.style.display = show ? '' : 'none';
        });
      };

      let scrollRaf = 0;
      wrapEl?.addEventListener('scroll', () => {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = requestAnimationFrame(() => {
          const scrollTop = wrapEl.scrollTop;
          const viewRow = rowAtScroll(scrollTop);
          const newStart = Math.max(0, viewRow - XL_VX_BUF);
          // Always update if the viewport is outside the currently rendered row range
          const outOfRange = viewRow < vxLastStart || viewRow >= vxLastEnd;
          if (!outOfRange && Math.abs(newStart - vxLastStart) < XL_VX_BUF) return;
          syncDomToData();
          updateWindow(newStart);
          reapplyFilter();
          applySel();
        });
      });
    }

    // Restore scroll position for this sheet (after switching tabs)
    const savedScroll = this.xlSheetScroll[doc.id]?.[this.activeSheetIdx];
    if (savedScroll) {
      const wrapRestore = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
      if (wrapRestore) requestAnimationFrame(() => { wrapRestore.scrollTop = savedScroll.top; wrapRestore.scrollLeft = savedScroll.left; });
    }

    // Apply freeze/filter state that was active before re-render
    if (this.xlFreezeRow) this.root.querySelector('#docs-excel-wrap')?.classList.add('dx-freeze-row');
    if (this.xlFreezeCol) this.root.querySelector('#docs-excel-wrap')?.classList.add('dx-freeze-col');
  }


  // ── Topbar & editor binding ────────────────────────────────────────────────
  private bindTopbar(): void {
    this.root.querySelector('#docs-new-word')?.addEventListener('click',()=>this.createDoc('word'));
    this.root.querySelector('#docs-new-excel')?.addEventListener('click',()=>this.createDoc('excel'));
    const fileInp=this.root.querySelector<HTMLInputElement>('#docs-file-input');
    this.root.querySelector('#docs-open-file')?.addEventListener('click',()=>fileInp?.click());
    fileInp?.addEventListener('change',async()=>{const f=fileInp.files?.[0];if(f)await this.importFile(f);fileInp.value='';});
    this.root.querySelector('#docs-fs-back')?.addEventListener('click',()=>{
      this.isFullscreen=false;
      this.root.querySelector('.docs-shell')?.classList.remove('docs-fullscreen');
    });
    this.root.querySelector('#docs-fs-sima')?.addEventListener('click',(e)=>{
      e.stopPropagation();
      (window as any).sdAssistantModule?.openPanel();
    });
    const recentWrap = this.root.querySelector<HTMLElement>('#docs-recent-wrap');
    this.root.querySelector('#docs-recent-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      recentWrap?.classList.toggle('open');
    });
    if (recentWrap) {
      const closeOnOutside = (e: Event) => {
        const wrap = this.root.querySelector('#docs-recent-wrap');
        if (!wrap) { document.removeEventListener('click', closeOnOutside); return; }
        if (!wrap.contains(e.target as Node)) {
          wrap.classList.remove('open');
          document.removeEventListener('click', closeOnOutside);
        }
      };
      document.addEventListener('click', closeOnOutside);
    }
    this.root.querySelectorAll<HTMLElement>('.docs-recent-row').forEach(el=>{
      el.addEventListener('click',(e)=>{
        e.stopPropagation();
        const id = el.dataset.recentId!;
        const type = el.dataset.recentType as DocType;
        recentWrap?.classList.remove('open');
        if (this.docs.some(d => d.id === id)) {
          this.activeId = id; this.activeSheetIdx = 0; this.render(); return;
        }
        const rec = this.recent.find(r => r.id === id);
        if (!rec) return;
        const newDoc: DocItem = { id, type, title: rec.title, content: rec.content ?? (type === 'word' ? '' : this.emptyExcel()), updated_at: rec.updated_at };
        this.addDoc(newDoc);
      });
    });
    this.root.querySelectorAll<HTMLElement>('.docs-recent-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeRecent(btn.dataset.delRecent!);
      });
    });
    this.root.querySelectorAll<HTMLElement>('.docs-tab').forEach(el=>{
      const id=el.dataset.id!;
      el.addEventListener('click',e=>{
        if((e.target as HTMLElement).dataset.close) return;
        this.flushSave(); this.activeId=id; localStorage.setItem(ACTIVE_KEY, id); this.activeSheetIdx=0; this.render();
      });
    });
    this.root.querySelectorAll<HTMLElement>('.docs-tab-close').forEach(el=>{
      el.addEventListener('click',e=>{e.stopPropagation();this.deleteDoc(el.dataset.close!);});
    });
  }

  private bindEditor(doc: DocItem): void {
    const titleInp=this.root.querySelector<HTMLInputElement>('#docs-title-inp');
    titleInp?.addEventListener('input',()=>this.renameDoc(doc.id,titleInp.value));
    this.root.querySelector('#docs-delete-btn')?.addEventListener('click',()=>{if(confirm(`Удалить «${doc.title}»? Это действие нельзя отменить.`))this.deleteDoc(doc.id,true);});
    const exportSel=this.root.querySelector<HTMLSelectElement>('#docs-export-sel');
    exportSel?.addEventListener('change',()=>{if(exportSel.value){this.exportDoc(doc,exportSel.value);exportSel.value='';}});
    this.root.querySelector('#docs-fs-btn')?.addEventListener('click',()=>{
      this.isFullscreen=!this.isFullscreen;
      this.root.querySelector('.docs-shell')?.classList.toggle('docs-fullscreen',this.isFullscreen);
      aiPage.register(this.getAiCapability());
    });
    if(doc.type==='word') this.bindWord(doc);
    else this.bindExcel(doc);
  }

  // ── Merge helpers ──────────────────────────────────────────────────────────
  private buildMergeInfo(merges?: MergeRange[]): { spans: Map<string, [number,number]>; covered: Set<string> } {
    const spans = new Map<string, [number,number]>(); // "r,c" → [rowspan, colspan]
    const covered = new Set<string>();
    for (const m of merges ?? []) {
      spans.set(`${m.r1},${m.c1}`, [m.r2 - m.r1 + 1, m.c2 - m.c1 + 1]);
      for (let rr = m.r1; rr <= m.r2; rr++) {
        for (let cc = m.c1; cc <= m.c2; cc++) {
          if (rr !== m.r1 || cc !== m.c1) covered.add(`${rr},${cc}`);
        }
      }
    }
    return { spans, covered };
  }

  // ── Cell rendering ─────────────────────────────────────────────────────────
  private renderCell(rows: CellData[][], r: number, c: number, cell: CellData, extraStyle = '',
    mergeInfo?: { spans: Map<string, [number,number]>; covered: Set<string> }): string {
    if (mergeInfo?.covered.has(`${r},${c}`)) return '';
    const span = mergeInfo?.spans.get(`${r},${c}`);
    const spanAttrs = span ? ` rowspan="${span[0]}" colspan="${span[1]}"` : '';
    const v = cell.v ?? '';

    // Формула: сырой текст живёт в data-formula, в ячейке — вычисленный результат
    const isFormula = v.startsWith('=');
    const raw = isFormula ? this.evalFormula(v, rows) : v;
    const type: CellType | undefined = isFormula
      ? (raw !== '' && !isNaN(Number(raw)) ? 'n' : undefined)
      : cell.t;

    const display = this.esc(formatCellValue(raw, type, cell.nf));

    // Excel выравнивает числа вправо, если автор не задал выравнивание явно
    const hasAlign = /text-align\s*:/.test(cell.s ?? '') || /text-align\s*:/.test(extraStyle);
    const autoAlign = (type === 'n' && !hasAlign) ? 'text-align:right' : '';

    const combined = [extraStyle, cell.s || '', autoAlign].filter(Boolean).join(';');
    const styleAttr = combined ? ` style="${this.esc(combined)}"` : '';

    const meta =
      (isFormula ? ` data-formula="${this.esc(v)}"` : '') +
      (cell.nf ? ` data-nf="${this.esc(cell.nf)}"` : '') +
      (cell.t ? ` data-t="${cell.t}"` : '') +
      // data-raw нужен только когда показанное отличается от хранимого,
      // иначе grid() прочитает обратно уже отформатированный текст
      (!isFormula && display !== this.esc(v) ? ` data-raw="${this.esc(v)}"` : '');

    return `<td data-r="${r}" data-c="${c}"${spanAttrs}${styleAttr}${meta}>${display}</td>`;
  }

  /** Пересчитать текст и мета-атрибуты ячейки в DOM из модели. */
  private applyCellToTd(td: HTMLTableCellElement, cell: CellData, rows: CellData[][]): void {
    const v = cell.v ?? '';
    const isFormula = v.startsWith('=');
    const raw = isFormula ? this.evalFormula(v, rows) : v;
    const type: CellType | undefined = isFormula
      ? (raw !== '' && !isNaN(Number(raw)) ? 'n' : undefined)
      : cell.t;

    if (isFormula) td.dataset.formula = v; else delete td.dataset.formula;
    if (cell.nf) td.dataset.nf = cell.nf; else delete td.dataset.nf;
    if (cell.t) td.dataset.t = cell.t; else delete td.dataset.t;

    const display = formatCellValue(raw, type, cell.nf);
    td.innerText = display;
    if (!isFormula && display !== v) td.dataset.raw = v; else delete td.dataset.raw;
  }

  /**
   * Разобрать то, что пользователь напечатал в ячейку, в модель.
   * Ведёт себя как Excel: распознаёт числа, проценты и даты, а формат
   * подхватывает из ячейки, если пользователь его уже задавал.
   */
  private interpretInput(text: string, prevNf?: string, prevType?: CellType): CellData {
    const t = text.trim();
    if (!t) return { v: '' };

    // Формула — сохраняем как есть, формат результата остаётся прежним
    if (t.startsWith('=')) return prevNf ? { v: t, nf: prevNf } : { v: t };

    // Дата в привычных записях → серийный номер Excel + датный формат
    const dm = t.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
    const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm || iso) {
      const [y, mo, d] = dm
        ? [+dm[3] < 100 ? 2000 + +dm[3] : +dm[3], +dm[2], +dm[1]]
        : [+iso![1], +iso![2], +iso![3]];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (!isNaN(dt.getTime())) {
          return {
            v: String(dateToSerial(dt)),
            t: 'n',
            nf: prevNf && isDateFormat(prevNf) ? prevNf : 'dd.mm.yyyy',
          };
        }
      }
    }

    const n = parseUserNumber(t);
    if (n !== null) {
      const out: CellData = { v: String(n), t: 'n' };
      if (t.endsWith('%')) out.nf = prevNf && prevNf.includes('%') ? prevNf : '0.00%';
      else if (prevNf && !isDateFormat(prevNf)) out.nf = prevNf;
      else if (prevNf && isDateFormat(prevNf) && prevType === 'n') out.nf = prevNf;
      return out;
    }

    // Текст. Числовой формат к нему неприменим — снимаем, чтобы
    // «1 234,50 ₽» не превратилось обратно в число при следующем рендере.
    return { v: t };
  }

  /** Прочитать ячейку из DOM обратно в модель, не потеряв сырое значение. */
  private cellFromTd(td: HTMLTableCellElement, style?: string): CellData {
    const v = td.dataset.formula ?? td.dataset.raw ?? td.innerText;
    const out: CellData = { v };
    if (style) out.s = style;
    if (td.dataset.t) out.t = td.dataset.t as CellType;
    if (td.dataset.nf) out.nf = td.dataset.nf;
    return out;
  }

  private colLetter(n: number): string {
    let s=''; n+=1;
    while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}
    return s;
  }

  private letterToCol(l: string): number {
    let n=0; for(const ch of l.toUpperCase()) n=n*26+(ch.charCodeAt(0)-64); return n-1;
  }

  // ── AI: возможности страницы для ассистента ─────────────────────────────────

  /** Активный документ или null. */
  private aiDoc(): DocItem | null {
    return this.docs.find(d => d.id === this.activeId) ?? null;
  }

  /** Активный лист Excel (или null для Word/пустого). */
  private aiSheet(): { ec: ExcelContent; sheet: SheetData; doc: DocItem } | null {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') return null;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    return sheet ? { ec, sheet, doc } : null;
  }

  /** Индексы колонок, похожих на артикулы/коды (по заголовкам в строке 1). */
  private aiArticleCols(sheet: SheetData): number[] {
    const kw = ['артикул', 'sku', 'offer', 'vendor', 'код', 'штрихкод', 'barcode', 'nm_id', 'nmid'];
    const header = sheet.data[0] ?? [];
    const out: number[] = [];
    header.forEach((c, i) => {
      const h = (c.v || '').toLowerCase();
      if (kw.some(k => h.includes(k))) out.push(i);
    });
    return out;
  }

  /** Разрешить ссылку на колонку: буква ("B") или имя заголовка ("Артикул"). → индекс или -1. */
  private aiResolveCol(sheet: SheetData, ref: string): number {
    const r = String(ref).trim();
    if (/^[A-Za-z]+$/.test(r)) {
      const idx = this.letterToCol(r);
      if (idx >= 0 && idx < (sheet.data[0]?.length ?? 0)) return idx;
    }
    const header = sheet.data[0] ?? [];
    const low = r.toLowerCase();
    const exact = header.findIndex(c => (c.v || '').trim().toLowerCase() === low);
    if (exact >= 0) return exact;
    return header.findIndex(c => (c.v || '').trim().toLowerCase().includes(low));
  }

  private aiPersist(doc: DocItem, ec: ExcelContent): void {
    this.updateContent(doc.id, JSON.stringify(ec));
    this.render();
  }

  // ── Чтение данных для ассистента ───────────────────────────────────────────
  // describe() показывает лишь первые 30 строк — на таблице в тысячи строк
  // модель физически не видит данные и начинает выдумывать. Эти действия
  // дают ей запрашивать нужный срез самостоятельно.

  /** Отображаемое значение ячейки: формулы посчитаны, форматы применены. */
  private aiCellText(sheet: SheetData, r: number, c: number): string {
    const cell = sheet.data[r]?.[c];
    if (!cell) return '';
    const v = cell.v ?? '';
    if (v.startsWith('=')) return this.evalFormula(v, sheet.data);
    return formatCellValue(v, cell.t, cell.nf);
  }

  /** Числовое значение ячейки или null, если это не число. */
  private aiCellNum(sheet: SheetData, r: number, c: number): number | null {
    const cell = sheet.data[r]?.[c];
    if (!cell) return null;
    const raw = cell.v?.startsWith('=')
      ? this.evalFormula(cell.v, sheet.data)
      : (cell.v ?? '');
    if (raw.trim() === '') return null;
    const n = parseUserNumber(raw);
    return n ?? null;
  }

  /** Лист по имени, иначе активный. */
  private aiSheetNamed(name?: string): { ec: ExcelContent; sheet: SheetData; doc: DocItem } {
    const s = this.aiSheet();
    if (!s) throw new Error('Нет открытой таблицы');
    if (!name) return s;
    const found = s.ec.sheets.find(sh => sh.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Error(`Лист «${name}» не найден. Есть: ${s.ec.sheets.map(x => x.name).join(', ')}`);
    return { ...s, sheet: found };
  }

  /** Индексы строк с данными (без шапки, без полностью пустых). */
  private aiDataRows(sheet: SheetData): number[] {
    const out: number[] = [];
    for (let r = 1; r < sheet.data.length; r++) {
      if (sheet.data[r].some(c => (c.v || '').trim())) out.push(r);
    }
    return out;
  }

  /**
   * Условия отбора: { "Город": "Мадрид", "Цена": ">100" }.
   * Синтаксис критериев тот же, что в СУММЕСЛИ — включая > < <> и маски *?.
   */
  private aiBuildFilter(sheet: SheetData, where?: Record<string, string>): (r: number) => boolean {
    if (!where || !Object.keys(where).length) return () => true;
    const tests: Array<{ c: number; pred: (v: string) => boolean }> = [];
    for (const [key, crit] of Object.entries(where)) {
      const c = this.aiResolveCol(sheet, key);
      if (c < 0) throw new Error(`Колонка «${key}» не найдена`);
      tests.push({ c, pred: this.aiCriteria(String(crit)) });
    }
    return (r: number) => tests.every(t => t.pred(this.aiCellText(sheet, r, t.c)));
  }

  /** «>100», «<>абв», «Мадрид», «А*» → предикат по тексту ячейки. */
  private aiCriteria(crit: string): (v: string) => boolean {
    const raw = crit.trim();
    const m = raw.match(/^(<=|>=|<>|=|<|>)(.*)$/);
    if (m) {
      const op = m[1], operand = m[2].trim();
      const on = parseUserNumber(operand);
      return (v: string) => {
        if (on !== null) {
          const vn = parseUserNumber(v);
          if (vn === null) return op === '<>';
          switch (op) {
            case '>': return vn > on;  case '>=': return vn >= on;
            case '<': return vn < on;  case '<=': return vn <= on;
            case '<>': return vn !== on; default: return vn === on;
          }
        }
        const a = v.trim().toLowerCase(), b = operand.toLowerCase();
        switch (op) {
          case '<>': return a !== b;
          case '>': return a > b;  case '>=': return a >= b;
          case '<': return a < b;  case '<=': return a <= b;
          default: return a === b;
        }
      };
    }
    if (/[*?]/.test(raw)) {
      const rx = new RegExp('^' + raw.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return (v: string) => rx.test(v.trim());
    }
    return (v: string) => v.trim().toLowerCase() === raw.toLowerCase();
  }

  /** Прочитать прямоугольный диапазон как текст. */
  private aiExcelReadRange(a: { range: string; sheet?: string }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const m = String(a?.range ?? '').trim().toUpperCase()
      .match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (!m) throw new Error('Диапазон нужен в виде A1:D20');
    const c1 = this.letterToCol(m[1]), r1 = +m[2] - 1;
    const c2 = m[3] ? this.letterToCol(m[3]) : c1;
    const r2 = m[4] ? +m[4] - 1 : r1;

    const maxRows = 500;
    const rows: string[] = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2) && rows.length < maxRows; r++) {
      const cells: string[] = [];
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        cells.push(`${this.colLetter(c)}${r + 1}=${this.aiCellText(sheet, r, c) || '—'}`);
      }
      rows.push('  ' + cells.join(' | '));
    }
    const total = Math.abs(r2 - r1) + 1;
    return `Лист «${sheet.name}», диапазон ${a.range} (${total} строк):\n${rows.join('\n')}`
      + (total > maxRows ? `\n  …показаны первые ${maxRows}` : '');
  }

  /** Отобрать строки по условиям и вернуть нужные колонки. */
  private aiExcelQuery(a: {
    where?: Record<string, string>; columns?: string[];
    limit?: number; sheet?: string; sortBy?: string; desc?: boolean;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const filter = this.aiBuildFilter(sheet, a?.where);

    const cols = a?.columns?.length
      ? a.columns.map(ref => {
          const c = this.aiResolveCol(sheet, ref);
          if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
          return c;
        })
      : header.map((_, i) => i);

    let hits = this.aiDataRows(sheet).filter(filter);

    if (a?.sortBy) {
      const sc = this.aiResolveCol(sheet, a.sortBy);
      if (sc < 0) throw new Error(`Колонка сортировки «${a.sortBy}» не найдена`);
      const dir = a.desc ? -1 : 1;
      hits.sort((x, y) => {
        const xn = this.aiCellNum(sheet, x, sc), yn = this.aiCellNum(sheet, y, sc);
        if (xn !== null && yn !== null) return (xn - yn) * dir;
        return this.aiCellText(sheet, x, sc).localeCompare(this.aiCellText(sheet, y, sc), 'ru') * dir;
      });
    }

    const total = hits.length;
    const limit = Math.min(a?.limit ?? 50, 200);
    hits = hits.slice(0, limit);

    const head = cols.map(c => `${this.colLetter(c)}«${(header[c]?.v || '').trim()}»`).join(' | ');
    const lines = hits.map(r =>
      `  стр.${r + 1}: ` + cols.map(c => this.aiCellText(sheet, r, c) || '—').join(' | '));

    return `Лист «${sheet.name}»: найдено ${total} строк${total > limit ? `, показаны первые ${limit}` : ''}.\n`
      + `Колонки: ${head}\n${lines.join('\n') || '  (совпадений нет)'}`;
  }

  /** Агрегаты, при необходимости с группировкой. */
  private aiExcelAggregate(a: {
    op: string; column?: string; groupBy?: string;
    where?: Record<string, string>; sheet?: string; limit?: number;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const op = String(a?.op ?? 'sum').toLowerCase();
    const OPS = ['sum', 'avg', 'average', 'count', 'min', 'max', 'countdistinct'];
    if (!OPS.includes(op)) throw new Error(`Операция «${a?.op}» неизвестна. Доступны: ${OPS.join(', ')}`);

    const needsValue = op !== 'count' && op !== 'countdistinct';
    let vc = -1;
    if (a?.column) {
      vc = this.aiResolveCol(sheet, a.column);
      if (vc < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    } else if (needsValue) {
      throw new Error(`Для «${op}» нужна колонка со значениями (column)`);
    }

    const filter = this.aiBuildFilter(sheet, a?.where);
    const rows = this.aiDataRows(sheet).filter(filter);

    const compute = (list: number[], texts: string[]): string => {
      switch (op) {
        case 'sum': return this.aiNum(list.reduce((s, v) => s + v, 0));
        case 'avg': case 'average':
          return list.length ? this.aiNum(list.reduce((s, v) => s + v, 0) / list.length) : '—';
        case 'min': return list.length ? this.aiNum(Math.min(...list)) : '—';
        case 'max': return list.length ? this.aiNum(Math.max(...list)) : '—';
        case 'countdistinct': return String(new Set(texts.filter(t => t.trim())).size);
        default: return String(texts.length);
      }
    };

    const collect = (rs: number[]) => ({
      nums: vc >= 0 ? rs.map(r => this.aiCellNum(sheet, r, vc)).filter((n): n is number => n !== null) : [],
      texts: rs.map(r => vc >= 0 ? this.aiCellText(sheet, r, vc) : 'x'),
    });

    const filterNote = a?.where ? ` при условии ${JSON.stringify(a.where)}` : '';

    if (!a?.groupBy) {
      const { nums, texts } = collect(rows);
      const label = a?.column ? ` по «${(sheet.data[0]?.[vc]?.v || '').trim()}»` : '';
      return `Лист «${sheet.name}»: ${op.toUpperCase()}${label}${filterNote} = ${compute(nums, texts)} (строк: ${rows.length})`;
    }

    const gc = this.aiResolveCol(sheet, a.groupBy);
    if (gc < 0) throw new Error(`Колонка группировки «${a.groupBy}» не найдена`);

    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const key = this.aiCellText(sheet, r, gc).trim() || '(пусто)';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }

    const limit = Math.min(a?.limit ?? 50, 200);
    const lines = [...groups.entries()]
      .map(([key, rs]) => {
        const { nums, texts } = collect(rs);
        return { key, n: rs.length, val: compute(nums, texts) };
      })
      .sort((x, y) => {
        const xn = parseFloat(x.val), yn = parseFloat(y.val);
        return (!isNaN(xn) && !isNaN(yn)) ? yn - xn : y.n - x.n;
      })
      .slice(0, limit)
      .map(g => `  ${g.key}: ${g.val} (строк: ${g.n})`);

    return `Лист «${sheet.name}»: ${op.toUpperCase()}`
      + (a.column ? ` по «${(sheet.data[0]?.[vc]?.v || '').trim()}»` : '')
      + ` с группировкой по «${a.groupBy}»${filterNote}\n`
      + `Групп: ${groups.size}${groups.size > limit ? `, показаны первые ${limit}` : ''}\n`
      + lines.join('\n');
  }

  /** Округлить до вменяемого вида для показа модели. */
  private aiNum(n: number): string {
    if (!isFinite(n)) return '—';
    const r = Math.round(n * 100) / 100;
    return String(r);
  }

  /** Найти текст в таблице, вернуть адреса. */
  private aiExcelFind(a: {
    query: string; columns?: string[]; exact?: boolean; limit?: number; sheet?: string;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const q = String(a?.query ?? '').trim();
    if (!q) throw new Error('Не указано, что искать');
    const low = q.toLowerCase();

    const header = sheet.data[0] ?? [];
    const cols = a?.columns?.length
      ? a.columns.map(ref => {
          const c = this.aiResolveCol(sheet, ref);
          if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
          return c;
        })
      : header.map((_, i) => i);

    const limit = Math.min(a?.limit ?? 50, 200);
    const hits: string[] = [];
    let total = 0;

    for (let r = 0; r < sheet.data.length; r++) {
      for (const c of cols) {
        const txt = this.aiCellText(sheet, r, c);
        if (!txt) continue;
        const match = a?.exact ? txt.trim().toLowerCase() === low : txt.toLowerCase().includes(low);
        if (!match) continue;
        total++;
        if (hits.length < limit) {
          hits.push(`  ${this.colLetter(c)}${r + 1} (стр.${r + 1}, «${(header[c]?.v || '').trim()}»): ${txt}`);
        }
      }
    }

    return `Лист «${sheet.name}»: «${q}» встречается ${total} раз${total > limit ? `, показаны первые ${limit}` : ''}.\n`
      + (hits.join('\n') || '  (не найдено)');
  }

  /** Проверки качества данных — дубли, пустоты, нечисловые значения. */
  private aiExcelValidate(a: {
    duplicates?: string[]; required?: string[]; numeric?: string[];
    positive?: string[]; sheet?: string;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const rows = this.aiDataRows(sheet);
    const out: string[] = [];
    const LIST = 20;

    const resolve = (ref: string) => {
      const c = this.aiResolveCol(sheet, ref);
      if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
      return c;
    };
    const title = (c: number) => `${this.colLetter(c)}«${(header[c]?.v || '').trim()}»`;

    for (const ref of a?.duplicates ?? []) {
      const c = resolve(ref);
      const seen = new Map<string, number[]>();
      for (const r of rows) {
        const v = this.aiCellText(sheet, r, c).trim().toLowerCase();
        if (!v) continue;
        (seen.get(v) ?? seen.set(v, []).get(v)!).push(r + 1);
      }
      const dups = [...seen.entries()].filter(([, rs]) => rs.length > 1);
      out.push(dups.length
        ? `Дубли в ${title(c)}: ${dups.length} значений повторяются\n`
          + dups.slice(0, LIST).map(([v, rs]) => `    «${v}» — строки ${rs.join(', ')}`).join('\n')
          + (dups.length > LIST ? `\n    …ещё ${dups.length - LIST}` : '')
        : `Дубли в ${title(c)}: не найдено`);
    }

    for (const ref of a?.required ?? []) {
      const c = resolve(ref);
      const empty = rows.filter(r => !this.aiCellText(sheet, r, c).trim());
      out.push(empty.length
        ? `Пустые в ${title(c)}: ${empty.length} строк — ${empty.slice(0, LIST).map(r => r + 1).join(', ')}`
          + (empty.length > LIST ? ` …ещё ${empty.length - LIST}` : '')
        : `Пустые в ${title(c)}: нет`);
    }

    for (const ref of a?.numeric ?? []) {
      const c = resolve(ref);
      const bad = rows.filter(r => {
        const t = this.aiCellText(sheet, r, c).trim();
        return t !== '' && this.aiCellNum(sheet, r, c) === null;
      });
      out.push(bad.length
        ? `Нечисловые в ${title(c)}: ${bad.length} строк — `
          + bad.slice(0, LIST).map(r => `стр.${r + 1}="${this.aiCellText(sheet, r, c)}"`).join(', ')
          + (bad.length > LIST ? ` …ещё ${bad.length - LIST}` : '')
        : `Нечисловые в ${title(c)}: нет`);
    }

    for (const ref of a?.positive ?? []) {
      const c = resolve(ref);
      const bad = rows.filter(r => { const n = this.aiCellNum(sheet, r, c); return n !== null && n <= 0; });
      out.push(bad.length
        ? `Неположительные в ${title(c)}: ${bad.length} строк — `
          + bad.slice(0, LIST).map(r => `стр.${r + 1}=${this.aiCellText(sheet, r, c)}`).join(', ')
          + (bad.length > LIST ? ` …ещё ${bad.length - LIST}` : '')
        : `Неположительные в ${title(c)}: нет`);
    }

    if (!out.length) return 'Не указано, что проверять. Доступно: duplicates, required, numeric, positive.';
    return `Проверка листа «${sheet.name}» (${rows.length} строк данных):\n` + out.join('\n');
  }

  /** Схема листа: заголовки, типы, заполненность — дёшево по токенам. */
  private aiExcelSchema(a?: { sheet?: string }): string {
    const { ec, sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const rows = this.aiDataRows(sheet);
    const sample = rows.slice(0, 3);

    const cols = header.map((h, c) => {
      const filled = rows.filter(r => this.aiCellText(sheet, r, c).trim()).length;
      const numeric = rows.filter(r => this.aiCellNum(sheet, r, c) !== null).length;
      const uniq = new Set(rows.map(r => this.aiCellText(sheet, r, c).trim()).filter(Boolean)).size;
      const kind = numeric > filled * 0.8 ? 'число' : uniq <= Math.max(20, rows.length * 0.05) ? 'категория' : 'текст';
      const ex = sample.map(r => this.aiCellText(sheet, r, c)).filter(Boolean).slice(0, 2);
      return `  ${this.colLetter(c)} «${(h.v || '').trim() || '(без имени)'}» — ${kind}, `
        + `заполнено ${filled}/${rows.length}, уникальных ${uniq}`
        + (ex.length ? `, напр.: ${ex.map(e => `«${e}»`).join(', ')}` : '');
    });

    return `Лист «${sheet.name}» (из ${ec.sheets.length}): ${rows.length} строк данных × ${header.length} колонок.\n`
      + `Колонки:\n${cols.join('\n')}\n`
      + `Для выборки строк — excel_query, для итогов — excel_aggregate, для поиска — excel_find.`;
  }

  /** describe() — текущее состояние открытого документа для модели. */
  private aiDescribe(): string {
    const fsFocus = this.isFullscreen
      ? '[РЕЖИМ: Полный экран редактора. Пользователь работает с документом. Фокусируйся только на нём — давай советы, подсказки и действия именно по этому файлу. Ты можешь отвечать на вопросы об API (остатки, заказы, аналитика WB/Ozon) если пользователь явно спросит, но сам не переключайся на другие разделы.]\n\n'
      : '';

    // Обзор намеренно краткий. Раньше сюда сваливались 30 строк данных и
    // частотный анализ всех колонок — тысячи токенов на каждый вызов, а
    // ответить по таблице в 5000 строк всё равно было нельзя. Теперь модель
    // получает карту документов и берёт данные через excel_query/aggregate.
    const docList = this.docs.length
      ? `\n\n📂 Документы (${this.docs.length}):\n` + this.docs.map((d, i) => {
          const active = d.id === this.activeId ? ' ← АКТИВНЫЙ' : '';
          let extra = '';
          if (d.type === 'excel') {
            try {
              const ec = this.parseExcelContent(d.content);
              extra = ' — листы: ' + ec.sheets.map(sh => {
                const rows = sh.data.filter(r => r.some(c => (c.v || '').trim())).length;
                return `«${sh.name}» (${Math.max(0, rows - 1)}×${sh.data[0]?.length ?? 0})`;
              }).join(', ');
            } catch { /* повреждённое содержимое не должно ронять обзор */ }
          } else {
            const len = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
            extra = ` — ~${len} симв.`;
          }
          return `  ${i + 1}. id="${d.id}" «${d.title}» [${d.type}]${active}${extra}`;
        }).join('\n')
      : '';

    const doc = this.aiDoc();
    if (!doc) return fsFocus + 'Нет открытого документа. Пользователь может создать Word или Excel.' + docList;

    if (doc.type === 'word') {
      const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const headings = [...doc.content.matchAll(/<(h[1-6])[^>]*>(.*?)<\/h[1-6]>/gi)]
        .map(m => `  ${m[1].toUpperCase()}: ${m[2].replace(/<[^>]+>/g, '').trim()}`)
        .slice(0, 12).join('\n');
      return fsFocus + `Открыт Word-документ «${doc.title}»: ${words} слов, ${text.length} символов.`
        + (headings ? `\nЗаголовки:\n${headings}` : '')
        + `\nНачало: "${text.slice(0, 600)}"${text.length > 600 ? '…' : ''}`
        + `\nДля структуры вызови word_outline, для точечной правки — word_edit_paragraph.`
        + docList;
    }

    const s = this.aiSheet();
    if (!s) return fsFocus + `Открыт документ «${doc.title}», но лист пуст.` + docList;
    const { ec, sheet } = s;
    const artCols = this.aiArticleCols(sheet);

    let schema: string;
    try {
      schema = this.aiExcelSchema();
    } catch {
      schema = `Лист «${sheet.name}»: ${sheet.data.length} строк.`;
    }

    const sheetsInfo = ec.sheets.length > 1
      ? `\nВсе листы: ${ec.sheets.map(sh => `«${sh.name}»`).join(', ')} (активный — «${sheet.name}»)`
      : '';
    const styled = sheet.data.some(r => r.some(c => c.s));

    return fsFocus + `Открыта таблица «${doc.title}».\n${schema}${sheetsInfo}\n`
      + `Колонки-артикулы (по умолчанию НЕ трогать при заменах): `
      + `${artCols.length ? artCols.map(i => this.colLetter(i)).join(', ') : 'не обнаружены'}\n`
      + `Оформление: ${styled ? 'в ячейках есть стили' : 'без оформления'}\n`
      + `ВАЖНО: конкретных значений здесь нет. Чтобы ответить по данным — вызови `
      + `excel_query (отбор строк), excel_aggregate (суммы, средние, группировки), `
      + `excel_find (поиск) или excel_read_range. Не выдумывай цифры и не считай по памяти.`
      + docList;
  }

  /** Публичная точка: капабилити текущей страницы редактора для ассистента. */
  getAiCapability(): AiPageCapability {
    const isWord = this.aiDoc()?.type === 'word';
    const fsSuggestions = isWord ? [
      { label: '📋 Структура', prompt: 'Покажи структуру документа: какие в нём абзацы и заголовки' },
      { label: '✍️ Дополни текст', prompt: 'Предложи продолжение для этого текста и допиши его в конец' },
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в документе' },
      { label: '🔁 Замена текста', prompt: 'Помоги заменить текст в документе' },
    ] : [
      { label: '🔎 Что в документе?', prompt: 'Проанализируй открытый документ: что за данные, структура, ключевые значения' },
      { label: '📊 Сводка по данным', prompt: 'Посчитай итоги по открытой таблице: суммы и средние по числовым колонкам, разбивка по основной категории' },
      { label: '🧹 Проверить данные', prompt: 'Проверь таблицу на ошибки: дубли артикулов, пустые обязательные поля, нечисловые значения в числовых колонках' },
      { label: '✨ Улучшить дизайн', prompt: 'Улучши оформление текущей таблицы' },
    ];
    const normalSuggestions = isWord ? [
      { label: '➕ Новый Word', prompt: 'Создай новый Word-документ' },
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в открытом документе' },
      { label: '🔎 Анализ текста', prompt: 'Проанализируй содержимое документа: о чём он, основные темы' },
      { label: '🔁 Замена', prompt: 'Помоги заменить текст в документе' },
    ] : [
      { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
      { label: '🔎 Что в таблице?', prompt: 'Проанализируй открытую таблицу: что за данные, какие колонки' },
      { label: '📊 Посчитать итоги', prompt: 'Посчитай итоги по открытой таблице с разбивкой по основной категории' },
      { label: '🧹 Проверить данные', prompt: 'Проверь таблицу на дубли и пропуски' },
    ];
    return {
      page: 'docs',
      title: this.isFullscreen ? `Редактор (${this.aiDoc()?.title ?? 'документ'})` : 'Редактор',
      describe: () => this.aiDescribe(),
      suggestions: this.isFullscreen ? fsSuggestions : normalSuggestions,
      actions: [
        {
          name: 'excel_replace',
          description: 'Заменить текст в ячейках таблицы. По умолчанию колонки-артикулы пропускаются. exceptColumns — доп. колонки (буквы или имена заголовков), которые не трогать.',
          args: '{ find: string, replaceWith: string, exceptColumns?: string[], caseSensitive?: boolean }',
          run: (a) => this.aiExcelReplace(a),
        },
        {
          name: 'excel_set_cell',
          description: 'Записать значение в конкретную ячейку.',
          args: '{ cell: "B3", value: string }',
          run: (a) => this.aiExcelSetCell(a),
        },
        {
          name: 'excel_style_column',
          description: 'Оформить всю колонку (буква или имя заголовка): жирный, курсив, фон, цвет текста, выравнивание.',
          args: '{ column: "A"|"Название", bold?: boolean, italic?: boolean, bg?: "#hex", color?: "#hex", align?: "left"|"center"|"right" }',
          run: (a) => this.aiExcelStyleColumn(a),
        },
        {
          name: 'excel_improve_design',
          description: 'Автоматически улучшить оформление таблицы: выделить строку-заголовок, добавить чередование строк и аккуратные цвета. Используй когда просят «улучши дизайн».',
          args: '{ accent?: "#hex" }',
          run: (a) => this.aiExcelImproveDesign(a),
        },
        {
          name: 'word_replace',
          description: 'Заменить текст в открытом Word-документе. Используй когда пользователь просит «замени», «поменяй», «исправь» текст в документе.',
          args: '{ find: string, replaceWith: string, caseSensitive?: boolean }',
          run: (a) => this.aiWordReplace(a),
        },
        {
          name: 'word_count',
          description: 'Подсчитать статистику Word-документа: количество слов, символов, абзацев. Используй когда спрашивают «сколько слов», «статистика документа», «размер текста».',
          args: '{}',
          run: () => this.aiWordCount(),
        },
        {
          name: 'word_set_content',
          description: 'Установить или дополнить содержимое Word-документа. html — готовый HTML-текст. text — обычный текст (будет преобразован в HTML). append — если true, добавить в конец, не заменяя. Используй когда просят «напиши», «заполни», «добавь текст», «вставь содержимое».',
          args: '{ html?: string, text?: string, append?: boolean }',
          run: (a) => this.aiWordSetContent(a),
        },
        {
          name: 'word_clear_formatting',
          description: 'Убрать всё форматирование из Word-документа: стили, цвета, жирность, курсив. Структурные теги (абзацы, заголовки) сохраняются. Используй когда просят «убери форматирование», «сними стили», «сделай обычный текст».',
          args: '{}',
          run: () => this.aiWordClearFormatting(),
        },
        {
          name: 'word_heading',
          description: 'Применить стиль заголовка к абзацу документа. text — текст абзаца, который нужно сделать заголовком (если не указан — первый абзац). level — уровень заголовка 1–6. Используй когда просят «сделай заголовком», «оформи как H1/H2».',
          args: '{ text?: string, level?: number }',
          run: (a) => this.aiWordHeading(a),
        },
        {
          name: 'excel_insert_column',
          description: 'Вставить новую пустую колонку в таблицу. after — буква или имя заголовка колонки, ПОСЛЕ которой вставить (напр. "D"). before — буква или имя, ПЕРЕД которой вставить. header — текст заголовка новой колонки (первая строка). Используй когда просят «добавь колонку», «вставь столбец», «создай новый ряд».',
          args: '{ after?: "D"|"Название", before?: "E"|"Цена", header?: string }',
          run: (a) => this.aiExcelInsertColumn(a),
        },
        {
          name: 'excel_add_to_column',
          description: 'Прибавить (или вычесть) число ко всем числовым ячейкам в указанной колонке. Используй когда просят «добавить X рублей к ценам», «увеличить цены на X%», «уменьшить стоимость на Y». delta — число (отрицательное для вычитания). percent — true если delta в процентах (напр. 10 = +10%). rows — конкретные строки (1-based) или "all" (по умолчанию). skipHeader — пропускать первую строку-заголовок (по умолчанию true). round — округление до N знаков после запятой (по умолчанию 2).',
          args: '{ column: "D"|"Цена", delta: number, percent?: boolean, rows?: number[]|"all", skipHeader?: boolean, round?: number }',
          run: (a) => this.aiExcelAddToColumn(a),
        },
        {
          name: 'excel_clear_cells',
          description: `Очистить ТОЛЬКО ячейки, чьи значения соответствуют заданному критерию.
ВАЖНО: НИКОГДА не очищай весь столбец целиком без value_filter — это сотрёт описания и другие данные!
Параметры: column — буква или имя заголовка (обязательно), value_filter — строка-регулярное выражение, которому должно соответствовать содержимое ячейки (по умолчанию "." = всё). Для артикулов используй фильтр типа "^[A-Za-z0-9\\\\-_/]+$" (короткие коды без пробелов). rows — конкретные номера строк (1-based), "all" = все строки с данными. cells — отдельные ячейки. preview_only = true — только показывает что будет очищено, не трогая данные.`,
          args: '{ column?: "B"|"Артикул", rows?: number[]|"all", cells?: string[], value_filter?: string, preview_only?: boolean }',
          run: (a) => this.aiExcelClearCells(a),
        },
        {
          name: 'multi_replace',
          description: 'Заменить текст сразу в нескольких документах. docIds — массив id документов (из describe()) или "all" для всех открытых. find — что искать. replaceWith — на что заменять. Использовать когда пользователь говорит «во всех файлах», «в 1 и 2 файле», «во всех таблицах».',
          args: '{ docIds: string[]|"all", find: string, replaceWith: string, caseSensitive?: boolean }',
          run: (a) => this.aiMultiReplace(a),
        },
        {
          name: 'multi_count',
          description: 'Подсчитать количество вхождений текста во всех или выбранных документах. Возвращает результат по каждому документу. Использовать когда спрашивают «сколько раз встречается», «посчитай во всех файлах».',
          args: '{ docIds: string[]|"all", find: string, caseSensitive?: boolean }',
          run: (a) => this.aiMultiCount(a),
        },
        {
          name: 'excel_style_range',
          description: 'Применить форматирование к явно заданному диапазону ячеек. Использовать когда пользователь говорит «закрась все ячейки», «весь лист», «колонку A», «строки 1-5», «диапазон A1:D10» — т.е. указывает конкретный диапазон или весь лист. range — "all" для всего листа, или Excel-диапазон вида "A1:Z100".',
          args: '{ range: "all"|"A1:Z100", bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean, color?: "#hex", bg?: "#hex", align?: "left"|"center"|"right" }',
          run: (a) => this.aiStyleRange(a),
        },
        {
          name: 'excel_style_selection',
          description: 'Применить форматирование к выделенным ячейкам. Использовать когда пользователь говорит «эти ячейки», «выделенные», «сделай их красными/жирными» и т.п. — то есть ссылается на текущий выбор. Не требует указания диапазона — берёт из контекста выделения.',
          args: '{ bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean, color?: "#hex", bg?: "#hex", align?: "left"|"center"|"right" }',
          run: (a) => this.aiStyleSelection(a),
        },
        {
          name: 'excel_clear_selection',
          description: 'Очистить содержимое выделенных ячеек (удалить значения, оставить стили). Использовать когда говорят «удали что внутри», «очисти эти ячейки», «убери содержимое».',
          args: '{}',
          run: () => this.aiClearSelection(),
        },
        {
          name: 'excel_fill_selection',
          description: 'Заполнить все выделенные ячейки одним значением. Использовать когда говорят «поставь везде X», «заполни выделенное значением».',
          args: '{ value: string }',
          run: (a) => this.aiFillSelection(a),
        },
        {
          name: 'excel_clear_style_selection',
          description: 'Убрать форматирование (стили) у выделенных ячеек, оставить только значения.',
          args: '{}',
          run: () => this.aiClearStyleSelection(),
        },
        // ── Управление документами ──────────────────────────────────────────
        {
          name: 'docs_create',
          description: 'Создать новый документ Excel или Word. type — "excel" или "word". title — название документа (необязательно). Использовать когда просят «создай новую таблицу», «открой новый Word».',
          args: '{ type: "excel"|"word", title?: string }',
          run: (a) => this.aiDocsCreate(a),
        },
        {
          name: 'docs_delete',
          description: 'Удалить один или несколько документов. docIds — массив id или "all" для всех. names — массив названий (если id неизвестны). Использовать когда просят «удали этот файл», «закрой все документы», «удали Таблицу 1 и Таблицу 2». ВНИМАНИЕ: действие необратимо — не требует подтверждения, выполняет сразу.',
          args: '{ docIds?: string[]|"all", names?: string[] }',
          run: (a) => this.aiDocsDelete(a),
        },
        {
          name: 'docs_rename',
          description: 'Переименовать один или несколько документов. renames — массив объектов с id или name (текущее) и newName (новое). Использовать когда просят «переименуй», «назови иначе», «смени заголовок файла».',
          args: '{ renames: Array<{ id?: string, name?: string, newName: string }> }',
          run: (a) => this.aiDocsRename(a),
        },
        {
          name: 'docs_switch',
          description: 'Переключиться на другой открытый документ. Использовать когда просят «перейди к файлу X», «открой Таблицу 2», «переключись на документ».',
          args: '{ id?: string, name?: string }',
          run: (a) => this.aiDocsSwitch(a),
        },
        {
          name: 'docs_clear_content',
          description: 'Очистить всё содержимое документов (все ячейки Excel или весь текст Word). docIds — массив id или "all" для всех. Использовать когда просят «очисти всё», «сотри всё во всех файлах», «обнули таблицы».',
          args: '{ docIds: string[]|"all" }',
          run: (a) => this.aiDocsClearContent(a),
        },
        // ── Управление диапазонами ──────────────────────────────────────────
        {
          name: 'excel_set_range',
          description: 'Записать значения сразу в диапазон ячеек. range — диапазон вида "A1:C3". values — двумерный массив строк (строки × столбцы). Использовать когда нужно заполнить прямоугольный блок ячеек.',
          args: '{ range: "A1:C3", values: string[][] }',
          run: (a) => this.aiExcelSetRange(a),
        },
        {
          name: 'excel_delete_rows',
          description: 'Удалить строки по номерам (1-based) или по условию. rows — конкретные номера строк. column+value_filter — удалить строки, где колонка соответствует регулярному выражению. skipHeader — пропускать строку 1 (по умолчанию true). Использовать когда просят «удали строки 3 и 5», «удали пустые строки», «удали строки где цена 0».',
          args: '{ rows?: number[], column?: string, value_filter?: string, skipHeader?: boolean }',
          run: (a) => this.aiExcelDeleteRows(a),
        },
        {
          name: 'excel_insert_rows',
          description: 'Вставить пустые строки в таблицу. at — номер строки (1-based), перед которой вставить. count — количество строк (по умолчанию 1). Использовать когда просят «вставь строку после заголовка», «добавь 3 пустые строки».',
          args: '{ at: number, count?: number }',
          run: (a) => this.aiExcelInsertRows(a),
        },
        {
          name: 'excel_sort_sheet',
          description: 'Отсортировать строки таблицы по колонке. column — буква или имя заголовка. order — "asc" (по возрастанию) или "desc" (по убыванию). hasHeader — есть ли строка-заголовок (по умолчанию true). numeric — сортировать как числа (по умолчанию auto-detect). Использовать когда просят «отсортируй по цене», «упорядочи по убыванию».',
          args: '{ column: "A"|"Цена", order?: "asc"|"desc", hasHeader?: boolean, numeric?: boolean }',
          run: (a) => this.aiExcelSortSheet(a),
        },
        {
          name: 'excel_formula_column',
          description: 'Заполнить колонку формулами по шаблону. column — буква или имя. formula — шаблон формулы, где {r} — номер строки (напр. "=B{r}*C{r}" или "=СУММ(A{r}:E{r})"). fromRow — начать с этой строки 1-based (по умолчанию 2 = после заголовка). toRow — до этой строки (по умолчанию последняя строка с данными+1). Использовать когда просят «добавь формулу умножения», «посчитай сумму по строкам».',
          args: '{ column: "D"|"Итого", formula: "=B{r}*C{r}", fromRow?: number, toRow?: number }',
          run: (a) => this.aiExcelFormulaColumn(a),
        },
        // ── Управление листами ──────────────────────────────────────────────
        {
          name: 'excel_add_sheet',
          description: 'Добавить новый лист в текущую Excel-таблицу. name — название листа (необязательно). Использовать когда просят «добавь новый лист», «создай вкладку».',
          args: '{ name?: string }',
          run: (a) => this.aiExcelAddSheet(a),
        },
        {
          name: 'excel_rename_sheet',
          description: 'Переименовать лист. from — текущее название (по умолчанию активный лист). to — новое название. Использовать когда просят «переименуй лист», «назови вкладку».',
          args: '{ from?: string, to: string }',
          run: (a) => this.aiExcelRenameSheet(a),
        },
        {
          name: 'excel_delete_sheet',
          description: 'Удалить лист из таблицы. name — название листа (по умолчанию активный). Нельзя удалить последний лист. Использовать когда просят «удали этот лист», «убери вкладку».',
          args: '{ name?: string }',
          run: (a) => this.aiExcelDeleteSheet(a),
        },
        {
          name: 'excel_copy_sheet',
          description: 'Скопировать лист внутри той же таблицы. from — название исходного листа (по умолчанию активный). newName — название копии. Использовать когда просят «скопируй лист», «продублируй вкладку».',
          args: '{ from?: string, newName?: string }',
          run: (a) => this.aiExcelCopySheet(a),
        },

        // ── Чтение и анализ ───────────────────────────────────────────────
        // Обзор документа в describe() умышленно краткий: эти действия
        // позволяют запросить именно нужный срез вместо догадок по образцу.
        {
          name: 'excel_schema',
          description: 'Схема листа: какие колонки, их тип (число/категория/текст), заполненность, уникальность, примеры значений. Дёшево по объёму. Вызывать ПЕРВЫМ, когда нужно понять структуру таблицы перед выборкой или расчётом.',
          args: '{ sheet?: string }',
          run: (a) => this.aiExcelSchema(a),
        },
        {
          name: 'excel_query',
          description: 'Выбрать строки по условиям и показать нужные колонки. where — {"Колонка":"критерий"}, критерий как в СУММЕСЛИ: точное значение, ">100", "<>нет", маска "А*". columns — какие колонки показать. sortBy/desc — сортировка. Использовать для «покажи заказы из Мадрида», «какие товары дороже 1000».',
          args: '{ where?: object, columns?: string[], sortBy?: string, desc?: boolean, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelQuery(a),
        },
        {
          name: 'excel_aggregate',
          description: 'Посчитать итог: op = sum|avg|count|min|max|countdistinct. column — по какой колонке считать (не нужна для count). groupBy — разбить по колонке. where — предварительный отбор. Использовать для «сколько всего», «сумма по городам», «средняя цена», «сколько уникальных артикулов». НЕ считай в уме по образцу строк — вызывай это.',
          args: '{ op: string, column?: string, groupBy?: string, where?: object, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelAggregate(a),
        },
        {
          name: 'excel_find',
          description: 'Найти текст в таблице и получить адреса ячеек и номера строк. columns — где искать (по умолчанию везде), exact — точное совпадение вместо вхождения. Использовать для «где встречается X», «в какой строке Y».',
          args: '{ query: string, columns?: string[], exact?: boolean, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelFind(a),
        },
        {
          name: 'excel_read_range',
          description: 'Прочитать конкретный диапазон, например A1:D20. Использовать когда пользователь называет диапазон явно или нужно посмотреть кусок листа целиком.',
          args: '{ range: string, sheet?: string }',
          run: (a) => this.aiExcelReadRange(a),
        },
        {
          name: 'excel_validate',
          description: 'Проверить качество данных: duplicates — колонки на дубли, required — колонки, где не должно быть пустот, numeric — где должны быть только числа, positive — где числа должны быть больше нуля. Использовать для «найди дубли артикулов», «проверь таблицу на ошибки», «где пустые цены».',
          args: '{ duplicates?: string[], required?: string[], numeric?: string[], positive?: string[], sheet?: string }',
          run: (a) => this.aiExcelValidate(a),
        },

        // ── Точечное редактирование Word ──────────────────────────────────
        // Раньше правка сводилась к word_set_content, который переписывает
        // документ целиком и стирает оформление.
        {
          name: 'word_outline',
          description: 'Структура Word-документа: пронумерованный список абзацев с их типом и началом текста. Вызывать ПЕРЕД точечной правкой, чтобы узнать номер нужного абзаца.',
          args: '{ limit?: number }',
          run: () => this.aiWordOutline(),
        },
        {
          name: 'word_edit_paragraph',
          description: 'Заменить содержимое одного абзаца по его номеру из word_outline. Оформление остальных абзацев не трогается. Использовать для «перепиши третий абзац», «поправь заголовок».',
          args: '{ index: number, text?: string, html?: string }',
          run: (a) => this.aiWordEditParagraph(a),
        },
        {
          name: 'word_insert',
          description: 'Вставить новый фрагмент. position: end (по умолчанию), start или after — тогда нужен afterIndex из word_outline. Использовать для «добавь абзац», «вставь раздел после второго».',
          args: '{ text?: string, html?: string, position?: string, afterIndex?: number }',
          run: (a) => this.aiWordInsert(a),
        },
        {
          name: 'word_delete_paragraph',
          description: 'Удалить абзац по номеру из word_outline.',
          args: '{ index: number }',
          run: (a) => this.aiWordDeleteParagraph(a),
        },
        {
          name: 'word_insert_table',
          description: 'Вставить таблицу. rows — массив массивов строк, первая строка считается шапкой, если headers не false. Использовать для «сделай таблицу», «оформи это таблицей».',
          args: '{ rows: string[][], headers?: boolean, position?: string, afterIndex?: number }',
          run: (a) => this.aiWordInsertTable(a),
        },
        {
          name: 'word_style_text',
          description: 'Оформить все вхождения текста: bold, italic, underline, color (#RRGGBB), bg, size (пункты). Использовать для «выдели красным слово X», «сделай жирным все упоминания Y».',
          args: '{ find: string, bold?: boolean, italic?: boolean, underline?: boolean, color?: string, bg?: string, size?: number, caseSensitive?: boolean }',
          run: (a) => this.aiWordStyleText(a),
        },
      ],
    };
  }

  // ── AI action implementations ───────────────────────────────────────────────

  /** Сохранить снимок листа в стек undo (вызывается перед AI-изменениями). */
  private pushXlUndo(docId: string, sheetIdx: number, r = 0, c = 0): void {
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) return;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) return;
    this.xlUndoStack.push({ data: JSON.parse(JSON.stringify(sheet.data)), docId, sheetIdx, r, c });
    if (this.xlUndoStack.length > 100) this.xlUndoStack.shift();
    this.xlRedoStack = [];
  }

  /** Результат AI-действия со снимком «до» для отката (kind='docs'). */
  private docsResult(docId: string, before: string, summary: string, label: string): AiActionResult {
    return { summary, undo: { kind: 'docs', payload: { docId, before }, label } };
  }

  /** Восстановить документ из снимка (обработчик отката 'docs'). */
  aiUndoRestore(payload: { docId: string; before: string }): void {
    if (!payload?.docId) return;
    this.updateContent(payload.docId, payload.before ?? '');
    if (this.root.style.display !== 'none') this.render();
  }

  private aiExcelReplace(a: { find: string; replaceWith: string; exceptColumns?: string[]; caseSensitive?: boolean }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    const repl = a.replaceWith ?? '';

    const skip = new Set<number>(this.aiArticleCols(sheet));
    const skippedNames: string[] = this.aiArticleCols(sheet).map(i => this.colLetter(i));
    for (const ref of (a.exceptColumns ?? [])) {
      const idx = this.aiResolveCol(sheet, ref);
      if (idx >= 0) { skip.add(idx); skippedNames.push(this.colLetter(idx)); }
    }

    const flags = a.caseSensitive ? 'g' : 'gi';
    const re = new RegExp(this.escRe(a.find), flags);
    let count = 0;
    for (const row of sheet.data) {
      for (let c = 0; c < row.length; c++) {
        if (skip.has(c)) continue;
        const cell = row[c];
        if (cell?.v && re.test(cell.v)) {
          re.lastIndex = 0;
          const next = cell.v.replace(re, repl);
          if (next !== cell.v) { cell.v = next; count++; }
        }
        re.lastIndex = 0;
      }
    }
    this.aiPersist(doc, ec);
    const skipStr = skippedNames.length ? ` Пропущены колонки: ${[...new Set(skippedNames)].join(', ')}.` : '';
    return this.docsResult(doc.id, before, `Заменено вхождений: ${count} («${a.find}» → «${repl}»).${skipStr}`, 'Отменить замену');
  }

  private aiExcelSetCell(a: { cell: string; value: string }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const m = String(a?.cell ?? '').trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!m) throw new Error('Некорректная ячейка (ожидается формат "B3")');
    const c = this.letterToCol(m[1]);
    const r = +m[2] - 1;
    if (r < 0 || c < 0) throw new Error('Ячейка вне диапазона');
    while (sheet.data.length <= r) sheet.data.push([]);
    const row = sheet.data[r];
    while (row.length <= c) row.push({ v: '' });
    row[c] = { ...row[c], v: String(a.value ?? '') };
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Ячейка ${m[1].toUpperCase()}${m[2]} = «${a.value ?? ''}».`, 'Отменить изменение ячейки');
  }

  private aiExcelStyleColumn(a: { column: string; bold?: boolean; italic?: boolean; bg?: string; color?: string; align?: string }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const idx = this.aiResolveCol(sheet, a?.column ?? '');
    if (idx < 0) throw new Error(`Колонка «${a?.column}» не найдена`);
    const css: string[] = [];
    if (a.bold) css.push('font-weight:bold');
    if (a.italic) css.push('font-style:italic');
    if (a.bg && /^#[0-9a-fA-F]{3,8}$/.test(a.bg)) css.push(`background:${a.bg}`);
    if (a.color && /^#[0-9a-fA-F]{3,8}$/.test(a.color)) css.push(`color:${a.color}`);
    if (a.align && ['left', 'center', 'right'].includes(a.align)) css.push(`text-align:${a.align}`);
    if (!css.length) throw new Error('Не заданы параметры оформления');
    const style = css.join(';') + ';';
    let n = 0;
    for (const row of sheet.data) {
      while (row.length <= idx) row.push({ v: '' });
      row[idx] = { ...row[idx], s: ((row[idx].s ?? '') + ';' + style).replace(/;+/g, ';').replace(/^;/, '') };
      n++;
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Оформлена колонка ${this.colLetter(idx)} (${n} ячеек).`, 'Отменить оформление');
  }

  private aiStyleRange(a: { range: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; color?: string; bg?: string; align?: 'left' | 'center' | 'right' }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Нет активного Excel-документа');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const css: string[] = [];
    if (a.bold !== undefined)          css.push(`font-weight:${a.bold ? 'bold' : 'normal'}`);
    if (a.italic !== undefined)        css.push(`font-style:${a.italic ? 'italic' : 'normal'}`);
    if (a.underline !== undefined)     css.push(`text-decoration:${a.underline ? 'underline' : 'none'}`);
    if (a.strikethrough !== undefined) css.push(`text-decoration:${a.strikethrough ? 'line-through' : 'none'}`);
    if (a.color && /^#[0-9a-fA-F]{3,8}$/.test(a.color)) css.push(`color:${a.color}`);
    if (a.bg && /^#[0-9a-fA-F]{3,8}$/.test(a.bg))       css.push(`background:${a.bg}`);
    if (a.align && ['left','center','right'].includes(a.align)) css.push(`text-align:${a.align}`);
    if (!css.length) throw new Error('Не заданы параметры оформления');
    const addStyle = css.join(';') + ';';
    let r1 = 0, c1 = 0, r2: number, c2: number;
    if (!a.range || a.range === 'all') {
      r2 = Math.max(sheet.data.length - 1, 0);
      c2 = Math.max(...sheet.data.map(row => row.length), 1) - 1;
    } else {
      const m = a.range.toUpperCase().match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if (!m) throw new Error(`Неверный формат диапазона: ${a.range}. Пример: "A1:D10" или "all"`);
      c1 = this.letterToCol(m[1]); r1 = parseInt(m[2]) - 1;
      c2 = m[3] ? this.letterToCol(m[3]) : c1;
      r2 = m[4] ? parseInt(m[4]) - 1 : r1;
    }
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      if (!sheet.data[r]) sheet.data[r] = [];
      for (let c = c1; c <= c2; c++) {
        while (sheet.data[r].length <= c) sheet.data[r].push({ v: '' });
        const cell = sheet.data[r][c] ?? { v: '' };
        sheet.data[r][c] = { ...cell, s: ((cell.s ?? '') + ';' + addStyle).replace(/;+/g, ';').replace(/^;/, '') };
        count++;
      }
    }
    this.aiPersist(doc, ec);
    const rangeStr = a.range === 'all' ? 'весь лист' : `${this.colLetter(c1)}${r1+1}:${this.colLetter(c2)}${r2+1}`;
    return this.docsResult(doc.id, before, `Применено оформление к ${count} ячейкам (${rangeStr}).`, 'Отменить оформление');
  }

  private aiStyleSelection(a: { bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; color?: string; bg?: string; align?: 'left' | 'center' | 'right' }): AiActionResult {
    if (!this.xlLastSel) throw new Error('Нет активного выделения ячеек. Сначала выдели ячейки в таблице.');
    const { r1, c1, r2, c2, docId, sheetIdx } = this.xlLastSel;
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) throw new Error('Документ не найден');
    this.pushXlUndo(docId, sheetIdx);
    const before = doc.content;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');
    const css: string[] = [];
    if (a.bold !== undefined)         css.push(`font-weight:${a.bold ? 'bold' : 'normal'}`);
    if (a.italic !== undefined)       css.push(`font-style:${a.italic ? 'italic' : 'normal'}`);
    if (a.underline !== undefined)    css.push(`text-decoration:${a.underline ? 'underline' : 'none'}`);
    if (a.strikethrough !== undefined) css.push(`text-decoration:${a.strikethrough ? 'line-through' : 'none'}`);
    if (a.color && /^#[0-9a-fA-F]{3,8}$/.test(a.color)) css.push(`color:${a.color}`);
    if (a.bg && /^#[0-9a-fA-F]{3,8}$/.test(a.bg))       css.push(`background:${a.bg}`);
    if (a.align && ['left','center','right'].includes(a.align)) css.push(`text-align:${a.align}`);
    if (!css.length) throw new Error('Не заданы параметры оформления');
    const addStyle = css.join(';') + ';';
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      if (!sheet.data[r]) sheet.data[r] = [];
      for (let c = c1; c <= c2; c++) {
        while (sheet.data[r].length <= c) sheet.data[r].push({ v: '' });
        const cell = sheet.data[r][c] ?? { v: '' };
        sheet.data[r][c] = { ...cell, s: ((cell.s ?? '') + ';' + addStyle).replace(/;+/g, ';').replace(/^;/, '') };
        count++;
      }
    }
    this.aiPersist(doc, ec);
    const rangeStr = `${this.colLetter(c1)}${r1+1}:${this.colLetter(c2)}${r2+1}`;
    return this.docsResult(doc.id, before, `Применено оформление к ${count} ячейкам (${rangeStr}).`, 'Отменить оформление');
  }

  private aiClearSelection(): AiActionResult {
    if (!this.xlLastSel) throw new Error('Нет активного выделения ячеек. Сначала выдели ячейки в таблице.');
    const { r1, c1, r2, c2, docId, sheetIdx } = this.xlLastSel;
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) throw new Error('Документ не найден');
    this.pushXlUndo(docId, sheetIdx);
    const before = doc.content;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      if (!sheet.data[r]) continue;
      for (let c = c1; c <= c2; c++) {
        if (sheet.data[r][c]) { sheet.data[r][c] = { v: '' }; count++; }
      }
    }
    this.aiPersist(doc, ec);
    const rangeStr = `${this.colLetter(c1)}${r1+1}:${this.colLetter(c2)}${r2+1}`;
    return this.docsResult(doc.id, before, `Очищено ${count} ячеек (${rangeStr}).`, 'Отменить очистку');
  }

  private aiFillSelection(a: { value: string }): AiActionResult {
    if (!this.xlLastSel) throw new Error('Нет активного выделения ячеек. Сначала выдели ячейки в таблице.');
    const { r1, c1, r2, c2, docId, sheetIdx } = this.xlLastSel;
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) throw new Error('Документ не найден');
    this.pushXlUndo(docId, sheetIdx);
    const before = doc.content;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');
    const val = String(a?.value ?? '');
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      if (!sheet.data[r]) sheet.data[r] = [];
      for (let c = c1; c <= c2; c++) {
        while (sheet.data[r].length <= c) sheet.data[r].push({ v: '' });
        sheet.data[r][c] = { ...sheet.data[r][c], v: val };
        count++;
      }
    }
    this.aiPersist(doc, ec);
    const rangeStr = `${this.colLetter(c1)}${r1+1}:${this.colLetter(c2)}${r2+1}`;
    return this.docsResult(doc.id, before, `Заполнено ${count} ячеек значением «${val}» (${rangeStr}).`, 'Отменить заполнение');
  }

  private aiClearStyleSelection(): AiActionResult {
    if (!this.xlLastSel) throw new Error('Нет активного выделения ячеек. Сначала выдели ячейки в таблице.');
    const { r1, c1, r2, c2, docId, sheetIdx } = this.xlLastSel;
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) throw new Error('Документ не найден');
    this.pushXlUndo(docId, sheetIdx);
    const before = doc.content;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');
    let count = 0;
    for (let r = r1; r <= r2; r++) {
      if (!sheet.data[r]) continue;
      for (let c = c1; c <= c2; c++) {
        if (sheet.data[r][c]) { sheet.data[r][c] = { v: sheet.data[r][c].v }; count++; }
      }
    }
    this.aiPersist(doc, ec);
    const rangeStr = `${this.colLetter(c1)}${r1+1}:${this.colLetter(c2)}${r2+1}`;
    return this.docsResult(doc.id, before, `Снято оформление с ${count} ячеек (${rangeStr}).`, 'Отменить сброс стилей');
  }

  private aiExcelImproveDesign(a: { accent?: string }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const accent = (a?.accent && /^#[0-9a-fA-F]{3,8}$/.test(a.accent)) ? a.accent : '#2563eb';
    const headerStyle = `background:${accent};color:#ffffff;font-weight:bold;text-align:center;`;
    const zebra = `background:rgba(37,99,235,0.06);`;
    sheet.data.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (r === 0) cell.s = headerStyle;
        else cell.s = (r % 2 === 0) ? zebra : '';
        row[c] = cell;
      });
    });
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Дизайн обновлён: выделена строка-заголовок (${accent}), добавлено чередование строк. Затронуто ${sheet.data.length} строк.`, 'Отменить дизайн');
  }

  /** Публичный метод для прямой записи ячейки Excel по docId (используется в export_analytics_report). */
  aiExcelCommand(docId: string, _cmd: 'set_cell', args: { row: number; col: number; value: string | number }): void {
    const doc = this.docs.find(d => d.id === docId);
    if (!doc || doc.type !== 'excel') return;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[0];
    if (!sheet) return;
    while (sheet.data.length <= args.row) sheet.data.push([]);
    const row = sheet.data[args.row];
    while (row.length <= args.col) row.push({ v: '' });
    row[args.col] = { v: String(args.value ?? '') };
    this.updateContent(docId, JSON.stringify(ec));
    if (this.root.style.display !== 'none') this.render();
  }

  private aiWordCount(): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, '').length;
    const paragraphs = (doc.content.match(/<(p|h[1-6])\b/gi) ?? []).length;
    return { summary: `📊 «${doc.title}»: **${words} слов**, ${chars} символов (без пробелов: ${charsNoSpace}), ~${paragraphs} абзацев.` };
  }

  private aiWordSetContent(a: { html?: string; text?: string; append?: boolean }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    let html = (a?.html ?? '').trim();
    if (!html && a?.text) {
      html = a.text.split(/\n\n+/).map(p => `<p>${this.esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
    }
    if (!html) throw new Error('Не указано содержимое (html или text)');
    const result = a?.append ? before + html : html;
    this.updateContent(doc.id, result);
    // Try to update the live contenteditable directly (avoids full DOM rebuild)
    const page = this.root.querySelector<HTMLElement>('.docs-word-page');
    if (page) {
      page.innerHTML = result;
    } else {
      this.render();
    }
    const wordCount = result.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return this.docsResult(doc.id, before, `Документ обновлён (~${wordCount} слов).`, 'Отменить изменение содержимого');
  }

  private aiWordClearFormatting(): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    const result = doc.content
      .replace(/ style="[^"]*"/gi, '')
      .replace(/ color="[^"]*"/gi, '')
      .replace(/ face="[^"]*"/gi, '')
      .replace(/ size="[^"]*"/gi, '')
      .replace(/<\/?(font|span)\b[^>]*>/gi, '')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
      .replace(/<(s|strike)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<mark>([\s\S]*?)<\/mark>/gi, '$1');
    this.updateContent(doc.id, result);
    this.render();
    return this.docsResult(doc.id, before, 'Форматирование очищено: убраны стили, цвета, жирность, курсив.', 'Отменить очистку форматирования');
  }

  // ── Точечное редактирование Word ───────────────────────────────────────────
  // Работаем через DOM, а не регулярками: строковая замена по HTML ломается
  // на вложенных тегах и съедает оформление.

  /** Разобрать содержимое активного Word-документа в DOM. */
  private aiWordDom(): { doc: DocItem; body: HTMLElement; before: string } {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><body>${doc.content}</body></html>`, 'text/html');
    return { doc, body: parsed.body, before: doc.content };
  }

  /** Блоки верхнего уровня — то, что пользователь называет «абзацами». */
  private aiWordBlocks(body: HTMLElement): HTMLElement[] {
    const TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','UL','OL','TABLE','DIV']);
    const out: HTMLElement[] = [];
    Array.from(body.children).forEach(el => {
      if (TAGS.has(el.tagName)) out.push(el as HTMLElement);
    });
    return out;
  }

  private aiWordSave(doc: DocItem, body: HTMLElement, before: string, summary: string, label: string): AiActionResult {
    this.updateContent(doc.id, body.innerHTML);
    this.render();
    return this.docsResult(doc.id, before, summary, label);
  }

  private aiWordOutline(): string {
    const { body } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    if (!blocks.length) return 'Документ пуст — абзацев нет.';
    const KIND: Record<string, string> = {
      P: 'абзац', H1: 'заголовок 1', H2: 'заголовок 2', H3: 'заголовок 3',
      H4: 'заголовок 4', H5: 'заголовок 5', H6: 'заголовок 6',
      BLOCKQUOTE: 'цитата', PRE: 'код', UL: 'список', OL: 'нум. список',
      TABLE: 'таблица', DIV: 'блок',
    };
    const lines = blocks.slice(0, 200).map((el, i) => {
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const kind = KIND[el.tagName] ?? el.tagName.toLowerCase();
      const extra = el.tagName === 'TABLE'
        ? ` (${el.querySelectorAll('tr').length} строк)`
        : (el.tagName === 'UL' || el.tagName === 'OL') ? ` (${el.querySelectorAll('li').length} пунктов)` : '';
      return `  ${i + 1}. [${kind}]${extra} ${txt.slice(0, 90)}${txt.length > 90 ? '…' : ''}`;
    });
    return `Структура документа (${blocks.length} блоков):\n${lines.join('\n')}`
      + (blocks.length > 200 ? '\n  …показаны первые 200' : '')
      + '\nНомера из этого списка передавай в word_edit_paragraph / word_delete_paragraph / afterIndex.';
  }

  /** Проверить номер абзаца и вернуть сам элемент. */
  private aiWordBlockAt(blocks: HTMLElement[], index: unknown): HTMLElement {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 1 || i > blocks.length) {
      throw new Error(`Номер абзаца ${index} вне диапазона 1…${blocks.length}. Сначала вызови word_outline.`);
    }
    return blocks[i - 1];
  }

  /** HTML из аргументов действия: html как есть, text — с экранированием. */
  private aiWordFragment(a: { text?: string; html?: string }): string {
    if (a?.html) return a.html;
    if (a?.text == null || a.text === '') throw new Error('Нужен text или html');
    return a.text.split(/\n{2,}/)
      .map(par => `<p>${this.esc(par).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  private aiWordEditParagraph(a: { index: number; text?: string; html?: string }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    const el = this.aiWordBlockAt(blocks, a?.index);
    const wasText = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

    if (a?.html) {
      el.innerHTML = a.html;
    } else {
      if (a?.text == null) throw new Error('Нужен text или html');
      // Меняем только текст, сохраняя тег и стиль абзаца
      el.textContent = a.text;
    }

    return this.aiWordSave(doc, body, before,
      `Абзац ${a.index} («${wasText}…») заменён.`, 'Отменить правку абзаца');
  }

  private aiWordInsert(a: { text?: string; html?: string; position?: string; afterIndex?: number }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const frag = this.aiWordFragment(a);
    const pos = (a?.position ?? 'end').toLowerCase();

    if (pos === 'start') {
      body.insertAdjacentHTML('afterbegin', frag);
    } else if (pos === 'after') {
      const blocks = this.aiWordBlocks(body);
      const el = this.aiWordBlockAt(blocks, a?.afterIndex);
      el.insertAdjacentHTML('afterend', frag);
    } else {
      body.insertAdjacentHTML('beforeend', frag);
    }

    const where = pos === 'start' ? 'в начало' : pos === 'after' ? `после абзаца ${a?.afterIndex}` : 'в конец';
    return this.aiWordSave(doc, body, before, `Фрагмент вставлен ${where}.`, 'Отменить вставку');
  }

  private aiWordDeleteParagraph(a: { index: number }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    const el = this.aiWordBlockAt(blocks, a?.index);
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    el.remove();
    return this.aiWordSave(doc, body, before,
      `Абзац ${a.index} («${txt}…») удалён.`, 'Вернуть абзац');
  }

  private aiWordInsertTable(a: {
    rows: string[][]; headers?: boolean; position?: string; afterIndex?: number;
  }): AiActionResult {
    const rows = a?.rows;
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) {
      throw new Error('rows должен быть массивом массивов строк, например [["A","B"],["1","2"]]');
    }
    const withHeader = a?.headers !== false;
    const cellStyle = 'border:1px solid #999;padding:6px';
    const html =
      `<table style="border-collapse:collapse;width:100%">` +
      rows.map((row, ri) => {
        const isHdr = withHeader && ri === 0;
        const tag = isHdr ? 'th' : 'td';
        const st = isHdr ? `${cellStyle};background-color:#F2F2F2;font-weight:bold` : cellStyle;
        return `<tr>${row.map(v => `<${tag} style="${st}">${this.esc(String(v ?? ''))}</${tag}>`).join('')}</tr>`;
      }).join('') +
      `</table>`;

    return this.aiWordInsert({
      html, position: a?.position, afterIndex: a?.afterIndex,
    });
  }

  private aiWordStyleText(a: {
    find: string; bold?: boolean; italic?: boolean; underline?: boolean;
    color?: string; bg?: string; size?: number; caseSensitive?: boolean;
  }): AiActionResult {
    const needle = String(a?.find ?? '');
    if (!needle) throw new Error('Не указано, какой текст оформить (find)');

    const css: string[] = [];
    if (a.bold) css.push('font-weight:bold');
    if (a.italic) css.push('font-style:italic');
    if (a.underline) css.push('text-decoration:underline');
    if (a.color) css.push(`color:${a.color}`);
    if (a.bg) css.push(`background-color:${a.bg}`);
    if (a.size) css.push(`font-size:${a.size}pt`);
    if (!css.length) throw new Error('Не указано ни одного оформления');

    const { doc, body, before } = this.aiWordDom();
    const style = css.join(';');
    let count = 0;

    // Обходим только текстовые узлы — так разметка вокруг остаётся целой
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const hay = a.caseSensitive ? t.data : t.data.toLowerCase();
      const nee = a.caseSensitive ? needle : needle.toLowerCase();
      if (hay.includes(nee)) targets.push(t);
    }

    for (const node of targets) {
      const parts: Array<{ text: string; hit: boolean }> = [];
      let rest = node.data;
      for (;;) {
        const hay = a.caseSensitive ? rest : rest.toLowerCase();
        const nee = a.caseSensitive ? needle : needle.toLowerCase();
        const i = hay.indexOf(nee);
        if (i < 0) { if (rest) parts.push({ text: rest, hit: false }); break; }
        if (i > 0) parts.push({ text: rest.slice(0, i), hit: false });
        parts.push({ text: rest.slice(i, i + needle.length), hit: true });
        rest = rest.slice(i + needle.length);
      }

      const frag = body.ownerDocument.createDocumentFragment();
      for (const p of parts) {
        if (p.hit) {
          const span = body.ownerDocument.createElement('span');
          span.setAttribute('style', style);
          span.textContent = p.text;
          frag.appendChild(span);
          count++;
        } else {
          frag.appendChild(body.ownerDocument.createTextNode(p.text));
        }
      }
      node.parentNode?.replaceChild(frag, node);
    }

    if (!count) throw new Error(`Текст «${needle}» в документе не найден`);
    return this.aiWordSave(doc, body, before,
      `Оформлено вхождений: ${count}.`, 'Отменить оформление');
  }

  private aiWordHeading(a: { text?: string; level?: number }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    const level = Math.min(Math.max(a?.level ?? 1, 1), 6);
    const tag = `h${level}`;
    let result = doc.content;
    let count = 0;
    if (a?.text) {
      const re = new RegExp(`<p([^>]*)>([^<]*${this.escRe(a.text)}[^<]*)<\/p>`, 'gi');
      result = result.replace(re, (_m, attrs, inner) => { count++; return `<${tag}${attrs}>${inner}</${tag}>`; });
      if (!count) throw new Error(`Абзац с текстом «${a.text}» не найден`);
    } else {
      result = result.replace(/<p([^>]*)>([\s\S]*?)<\/p>/i, (_m, attrs, inner) => { count++; return `<${tag}${attrs}>${inner}</${tag}>`; });
      if (!count) throw new Error('Нет абзацев для преобразования в заголовок');
    }
    this.updateContent(doc.id, result);
    this.render();
    return this.docsResult(doc.id, before, `Применён «Заголовок ${level}» к ${count} абзацу(-ам).`, 'Отменить заголовок');
  }

  private aiWordReplace(a: { find: string; replaceWith: string; caseSensitive?: boolean }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    const re = new RegExp(this.escRe(a.find), a.caseSensitive ? 'g' : 'gi');
    const before = doc.content;
    // Заменяем только в текстовых узлах (между тегами), не ломая разметку/атрибуты.
    const after = before.replace(/>([^<]+)</g, (_m, text) => '>' + text.replace(re, a.replaceWith ?? '') + '<');
    const count = (before.match(re) || []).length;
    this.updateContent(doc.id, after);
    this.render();
    return this.docsResult(doc.id, before, `В документе заменено ~${count} вхождений («${a.find}» → «${a.replaceWith ?? ''}»).`, 'Отменить замену');
  }

  private aiExcelInsertColumn(a: { after?: string; before?: string; header?: string }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;

    let insertAt: number;
    if (a?.after != null) {
      const ci = this.aiResolveCol(sheet, String(a.after));
      if (ci < 0) throw new Error(`Колонка «${a.after}» не найдена`);
      insertAt = ci + 1;
    } else if (a?.before != null) {
      const ci = this.aiResolveCol(sheet, String(a.before));
      if (ci < 0) throw new Error(`Колонка «${a.before}» не найдена`);
      insertAt = ci;
    } else {
      // append at end
      const maxCols = Math.max(...sheet.data.map(r => r.length), 0);
      insertAt = maxCols;
    }

    for (let ri = 0; ri < sheet.data.length; ri++) {
      const row = sheet.data[ri];
      const cell: CellData = { v: ri === 0 && a?.header ? a.header : '' };
      if (insertAt >= row.length) {
        while (row.length < insertAt) row.push({ v: '' });
        row.push(cell);
      } else {
        row.splice(insertAt, 0, cell);
      }
    }

    if (sheet.colWidths) sheet.colWidths.splice(insertAt, 0, null);

    this.aiPersist(doc, ec);
    const letter = this.colLetter(insertAt);
    return this.docsResult(
      doc.id, before,
      `Вставлена новая колонка ${letter}${a?.header ? ` «${a.header}»` : ''}.`,
      'Отменить вставку колонки',
    );
  }

  private aiExcelAddToColumn(a: {
    column: string; delta: number; percent?: boolean;
    rows?: number[] | 'all'; skipHeader?: boolean; round?: number;
  }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;

    const ci = this.aiResolveCol(sheet, String(a?.column ?? ''));
    if (ci < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    const delta = Number(a?.delta ?? 0);
    if (isNaN(delta)) throw new Error('delta должна быть числом');
    const roundTo = a?.round ?? 2;
    const skipHeader = a?.skipHeader !== false;
    const startRow = skipHeader ? 1 : 0;

    const targetRows: number[] = (!a?.rows || a.rows === 'all')
      ? Array.from({ length: Math.max(0, sheet.data.length - startRow) }, (_, i) => i + startRow)
      : (a.rows as number[]).map(r => r - 1);

    let changed = 0;
    for (const ri of targetRows) {
      const row = sheet.data[ri];
      if (!row || ci >= row.length) continue;
      const cell = row[ci];
      const raw = String(cell?.v ?? '').trim();
      if (!raw) continue;
      // Parse: handle comma thousands separators and dot/comma decimal
      const cleaned = raw.replace(/,(?=\d{3})/g, '').replace(',', '.');
      const num = parseFloat(cleaned);
      if (isNaN(num)) continue;
      const newVal = a?.percent
        ? num * (1 + delta / 100)
        : num + delta;
      const rounded = Math.round(newVal * Math.pow(10, roundTo)) / Math.pow(10, roundTo);
      row[ci] = { ...cell, v: String(rounded) };
      changed++;
    }

    if (!changed) {
      return { summary: `В колонке «${a.column}» не найдено числовых ячеек для изменения.` };
    }

    this.aiPersist(doc, ec);
    const op = a?.percent ? `${delta > 0 ? '+' : ''}${delta}%` : `${delta > 0 ? '+' : ''}${delta}`;
    return this.docsResult(
      doc.id, before,
      `Колонка «${a.column}»: изменено ${changed} ячеек (${op}).`,
      'Отменить изменение чисел',
    );
  }

  private aiExcelClearCells(a: {
    column?: string; rows?: number[] | 'all'; cells?: string[];
    value_filter?: string; preview_only?: boolean;
  }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;

    // Compile value_filter regex (default: match non-empty)
    let filterRe: RegExp | null = null;
    if (a?.value_filter) {
      try { filterRe = new RegExp(a.value_filter); }
      catch { throw new Error(`Неверный value_filter: ${a.value_filter}`); }
    }

    const matchesFilter = (v: string) => {
      const trimmed = v.trim();
      if (!trimmed) return false; // никогда не очищаем пустые ячейки
      if (!filterRe) return true; // без фильтра — очищаем всё непустое
      return filterRe.test(trimmed);
    };

    const cleared: string[] = [];

    if (a?.cells?.length) {
      for (const ref of a.cells) {
        const m = String(ref).match(/^([A-Za-z]+)(\d+)$/);
        if (!m) continue;
        const ci = this.letterToCol(m[1]);
        const ri = parseInt(m[2], 10) - 1;
        if (ri >= 0 && ri < sheet.data.length && ci >= 0 && ci < (sheet.data[ri]?.length ?? 0)) {
          const v = sheet.data[ri][ci]?.v ?? '';
          if (matchesFilter(v)) {
            if (!a.preview_only) sheet.data[ri][ci] = { v: '' };
            cleared.push(`${this.colLetter(ci)}${ri + 1}="${v}"`);
          }
        }
      }
    } else if (a?.column != null) {
      const ci = this.aiResolveCol(sheet, String(a.column));
      if (ci < 0) throw new Error(`Колонка «${a.column}» не найдена`);
      const startRow = 1;
      const endRow = sheet.data.length;
      const targetRows = !a.rows || a.rows === 'all'
        ? Array.from({ length: endRow - startRow }, (_, i) => i + startRow)
        : (a.rows as number[]).map(r => r - 1);
      for (const ri of targetRows) {
        if (ri >= startRow && ri < endRow && ci < (sheet.data[ri]?.length ?? 0)) {
          const v = sheet.data[ri][ci]?.v ?? '';
          if (matchesFilter(v)) {
            if (!a.preview_only) sheet.data[ri][ci] = { v: '' };
            cleared.push(`${this.colLetter(ci)}${ri + 1}="${v}"`);
          }
        }
      }
    } else {
      throw new Error('Укажи column или cells');
    }

    if (a.preview_only) {
      return { summary: `Будет очищено ${cleared.length} ячеек: ${cleared.slice(0, 10).join(', ')}${cleared.length > 10 ? ` ... и ещё ${cleared.length - 10}` : ''}` };
    }

    if (!cleared.length) {
      return { summary: 'Ни одна ячейка не подошла под фильтр — ничего не изменено.' };
    }

    this.aiPersist(doc, ec);
    return this.docsResult(
      doc.id, before,
      `Очищено ${cleared.length} ячеек по фильтру: ${cleared.slice(0, 6).join(', ')}${cleared.length > 6 ? ` ... и ещё ${cleared.length - 6}` : ''}.`,
      'Отменить очистку',
    );
  }

  /** Формульный движок: SUM/AVG/MIN/MAX/COUNT/IF/IFERROR и арифметика */
  private openFilterDropdown(colIdx: number, btn: HTMLElement, data: CellData[][], _body: HTMLElement, onApply: () => void): void {
    document.querySelector('.dx-filter-dropdown')?.remove();
    const vals = new Map<string, number>();
    for (let r = 1; r < data.length; r++) {
      const v = data[r]?.[colIdx]?.v ?? '';
      vals.set(v, (vals.get(v) ?? 0) + 1);
    }
    const current = this.xlFilterState[colIdx] ?? new Set<string>();
    const allChecked = current.size === 0;
    const sorted = [...vals.entries()].sort((a,b) => a[0].localeCompare(b[0], 'ru'));
    const drop = document.createElement('div');
    drop.className = 'dx-filter-dropdown';
    const rect = btn.getBoundingClientRect();
    drop.style.cssText = `left:${Math.min(rect.left, window.innerWidth-240)}px;top:${rect.bottom+2}px`;
    drop.innerHTML = `
      <div class="dx-filter-head">Фильтр по столбцу</div>
      <div class="dx-filter-search"><input class="dx-filter-q" type="text" placeholder="Поиск…"></div>
      <label class="dx-filter-row"><input type="checkbox" class="dx-fall" ${allChecked?'checked':''}><span>(Выбрать всё)</span></label>
      <div class="dx-filter-list">${sorted.map(([v,cnt])=>`<label class="dx-filter-row" data-v="${this.esc(v)}"><input type="checkbox" class="dx-fval" data-val="${this.esc(v)}" ${allChecked||current.has(v)?'checked':''}><span>${this.esc(v)||'(пусто)'}</span><small>${cnt}</small></label>`).join('')}</div>
      <div class="dx-filter-footer"><button class="dx-filter-ok">Применить</button><button class="dx-filter-cancel">Отмена</button></div>`;
    document.body.appendChild(drop);
    const allChk = drop.querySelector<HTMLInputElement>('.dx-fall')!;
    const valChks = () => [...drop.querySelectorAll<HTMLInputElement>('.dx-fval')];
    allChk.addEventListener('change', () => valChks().forEach(c => { if ((c.closest('label') as HTMLElement).style.display !== 'none') c.checked = allChk.checked; }));
    valChks().forEach(c => c.addEventListener('change', () => { allChk.checked = valChks().filter(ch => (ch.closest('label') as HTMLElement).style.display !== 'none').every(ch => ch.checked); }));
    drop.querySelector<HTMLInputElement>('.dx-filter-q')!.addEventListener('input', e => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      drop.querySelectorAll<HTMLElement>('.dx-filter-list label').forEach(lbl => { lbl.style.display = !q || (lbl.dataset.v ?? '').toLowerCase().includes(q) ? '' : 'none'; });
    });
    drop.querySelector('.dx-filter-ok')!.addEventListener('click', () => {
      const checked = valChks().filter(c => c.checked).map(c => c.dataset.val ?? '');
      const total = valChks().length;
      if (checked.length === total) { delete this.xlFilterState[colIdx]; }
      else { this.xlFilterState[colIdx] = new Set(checked); }
      onApply(); drop.remove();
    });
    drop.querySelector('.dx-filter-cancel')!.addEventListener('click', () => drop.remove());
    setTimeout(() => document.addEventListener('click', (e) => { if (!drop.contains(e.target as Node)) drop.remove(); }, {once: true}), 10);
  }

  /**
   * Вычислить формулу по данным листа.
   *
   * Разбор делегирован src/utils/formula.ts: там честный токенизатор и
   * рекурсивный спуск, поэтому работают вложенные вызовы вроде
   * =IF(A1>0,SUM(B1:B5),0), которые прежний разбор регулярками не тянул.
   *
   * Вычислитель кэшируется на набор строк: за один проход отрисовки лист
   * обходится один раз, а не пересчитывается заново для каждой ячейки.
   */
  private evalFormula(formula: string, rows: CellData[][]): string {
    return this.evaluatorFor(rows).evalToString(formula);
  }

  /** Вычислитель для набора строк; переиспользуется в пределах отрисовки. */
  private evaluatorFor(rows: CellData[][]): Evaluator {
    if (this.fxRows === rows && this.fxEval) return this.fxEval;
    this.fxRows = rows;
    this.fxEval = createEvaluator({
      raw: (r, c) => rows[r]?.[c]?.v ?? '',
      isNumeric: (r, c) => rows[r]?.[c]?.t === 'n',
    });
    return this.fxEval;
  }

  /** Сбросить кэш формул — данные изменились. */
  private invalidateFormulas(): void {
    this.fxRows = null;
    this.fxEval = null;
  }



  private aiMultiReplace(a: { docIds: string[] | 'all'; find: string; replaceWith: string; caseSensitive?: boolean }): AiActionResult {
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    const repl = a.replaceWith ?? '';
    const targets = a.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Не найдены указанные документы. Вызови describe() чтобы увидеть список открытых документов.');
    const flags = a.caseSensitive ? 'g' : 'gi';
    const snapshots: Array<{ docId: string; before: string }> = [];
    const lines: string[] = [];
    for (const doc of targets) {
      const before = doc.content;
      snapshots.push({ docId: doc.id, before });
      if (doc.type === 'word') {
        const re = new RegExp(this.escRe(a.find), flags);
        const count = (before.match(re) || []).length;
        const after = before.replace(/>([^<]+)</g, (_m, text) => '>' + text.replace(new RegExp(this.escRe(a.find), flags), repl) + '<');
        this.updateContent(doc.id, after);
        lines.push(`«${doc.title}» (Word): заменено ~${count}`);
      } else {
        let ec: ExcelContent;
        try { ec = JSON.parse(doc.content); } catch { lines.push(`«${doc.title}» (Excel): ошибка разбора`); continue; }
        const re = new RegExp(this.escRe(a.find), flags);
        let count = 0;
        for (const sheet of ec.sheets ?? []) {
          for (const row of sheet.data ?? []) {
            for (const cell of row) {
              if (cell?.v && re.test(cell.v)) {
                re.lastIndex = 0;
                const next = cell.v.replace(re, repl);
                if (next !== cell.v) { cell.v = next; count++; }
              }
              re.lastIndex = 0;
            }
          }
        }
        this.updateContent(doc.id, JSON.stringify(ec));
        lines.push(`«${doc.title}» (Excel): заменено ${count}`);
      }
    }
    this.render();
    return {
      summary: `Замена «${a.find}» → «${repl}» в ${targets.length} документах:\n` + lines.join('\n'),
      undo: { kind: 'docs_multi', payload: { snapshots }, label: 'Отменить замену во всех' },
    };
  }

  private aiMultiCount(a: { docIds: string[] | 'all'; find: string; caseSensitive?: boolean }): AiActionResult {
    if (!a?.find) throw new Error('Не указано, что искать (find)');
    const targets = a.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Не найдены указанные документы. Вызови describe() чтобы увидеть список открытых документов.');
    const flags = a.caseSensitive ? 'g' : 'gi';
    const lines: string[] = [];
    let total = 0;
    for (const doc of targets) {
      if (doc.type === 'word') {
        const text = doc.content.replace(/<[^>]+>/g, ' ');
        const re = new RegExp(this.escRe(a.find), flags);
        const count = (text.match(re) || []).length;
        total += count;
        lines.push(`«${doc.title}» (Word): ${count}`);
      } else {
        let ec: ExcelContent;
        try { ec = JSON.parse(doc.content); } catch { lines.push(`«${doc.title}» (Excel): ошибка разбора`); continue; }
        const re = new RegExp(this.escRe(a.find), flags);
        let count = 0;
        for (const sheet of ec.sheets ?? []) {
          for (const row of sheet.data ?? []) {
            for (const cell of row) {
              if (cell?.v) {
                const m = cell.v.match(re);
                if (m) count += m.length;
                re.lastIndex = 0;
              }
            }
          }
        }
        total += count;
        lines.push(`«${doc.title}» (Excel): ${count}`);
      }
    }
    return { summary: `Вхождений «${a.find}» в ${targets.length} документах (всего ${total}):\n` + lines.join('\n') };
  }

  aiUndoRestoreMulti(payload: { snapshots: Array<{ docId: string; before: string }> }): void {
    if (!payload?.snapshots) return;
    for (const { docId, before } of payload.snapshots) {
      this.updateContent(docId, before ?? '');
    }
    if (this.root.style.display !== 'none') this.render();
  }

  // ── Docs management AI actions ──────────────────────────────────────────────

  private aiDocsCreate(a: { type: 'excel' | 'word'; title?: string }): AiActionResult {
    const type = a?.type === 'word' ? 'word' : 'excel';
    const now = Date.now();
    const n = this.docs.filter(d => d.type === type).length + 1;
    const defaultTitle = type === 'word' ? `Документ ${n}` : `Таблица ${n}`;
    const title = (a?.title ?? '').trim() || defaultTitle;
    const doc: DocItem = {
      id: this.newId(), type,
      title,
      content: type === 'word' ? '' : this.emptyExcel(),
      updated_at: now,
    };
    this.addDoc(doc);
    return { summary: `Создан ${type === 'word' ? 'Word-документ' : 'Excel-файл'} «${title}» (id="${doc.id}").` };
  }

  /** Разрешить ссылки на документы в аргументах действия. Общая для показа и выполнения. */
  private aiResolveDocs(a: { docIds?: string[] | 'all'; names?: string[] }): DocItem[] {
    if (a?.docIds === 'all') return [...this.docs];
    if (Array.isArray(a?.docIds) && a.docIds.length > 0)
      return this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (Array.isArray(a?.names) && a.names.length > 0) {
      const lows = a.names.map(n => n.trim().toLowerCase());
      return this.docs.filter(d => lows.some(l => d.title.trim().toLowerCase().includes(l)));
    }
    return [];
  }

  /**
   * Что произойдёт, если выполнить разрушающее действие — текст карточки
   * подтверждения. Считаем по реальным данным, чтобы пользователь видел
   * «будет удалено 47 строк», а не общую фразу.
   *
   * Возвращает null, если действие не разрушающее или посчитать не вышло.
   */
  aiPreviewDestructive(name: string, args: any): string | null {
    const a = args ?? {};
    try {
      switch (name) {
        case 'docs_delete': {
          const t = this.aiResolveDocs(a);
          if (!t.length) return null;
          return `Будут удалены документы (${t.length}): ${t.map(d => `«${d.title}»`).join(', ')}.\n`
            + 'Удаление документа необратимо — отменить нельзя.';
        }
        case 'docs_clear_content': {
          const t = this.aiResolveDocs(a);
          if (!t.length) return null;
          return `Будет стёрто всё содержимое документов (${t.length}): `
            + `${t.map(d => `«${d.title}»`).join(', ')}.\nСами документы останутся, но станут пустыми.`;
        }
        case 'excel_delete_sheet': {
          const s = this.aiSheet();
          if (!s) return null;
          const target = a.name
            ? s.ec.sheets.find(sh => sh.name.toLowerCase() === String(a.name).trim().toLowerCase())
            : s.sheet;
          if (!target) return null;
          const rows = target.data.filter(r => r.some(c => (c.v || '').trim())).length;
          return `Будет удалён лист «${target.name}» вместе с данными (${rows} заполненных строк).\n`
            + `Останется листов: ${s.ec.sheets.length - 1}.`;
        }
        case 'excel_delete_rows': {
          const s = this.aiSheet();
          if (!s) return null;
          const n = this.aiCountRowsToDelete(s.sheet, a);
          if (n == null) return null;
          return `Будет удалено строк: ${n} из листа «${s.sheet.name}».`;
        }
        case 'multi_replace': {
          const t = this.aiResolveDocs(a);
          const docs = t.length ? t : this.docs;
          const find = String(a.find ?? '');
          if (!find) return null;
          let hits = 0, touched = 0;
          for (const d of docs) {
            const hay = a.caseSensitive ? d.content : d.content.toLowerCase();
            const nee = a.caseSensitive ? find : find.toLowerCase();
            const c = hay.split(nee).length - 1;
            if (c > 0) { hits += c; touched++; }
          }
          return `Замена «${find}» → «${a.replaceWith ?? ''}» затронет `
            + `${hits} вхождений в ${touched} документах.`;
        }
        case 'word_set_content': {
          const doc = this.aiDoc();
          if (!doc || doc.type !== 'word') return null;
          if (a.append) return null;   // дописывание в конец ничего не рушит
          const len = doc.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
          return `Содержимое документа «${doc.title}» будет полностью заменено.\n`
            + `Текущий текст (${len} символов) и всё его оформление будут потеряны.`;
        }
        default: return null;
      }
    } catch {
      return null;
    }
  }

  /** Сколько строк попадёт под excel_delete_rows — по тем же правилам, что и удаление. */
  private aiCountRowsToDelete(sheet: SheetData, a: any): number | null {
    if (Array.isArray(a?.rows) && a.rows.length) {
      return a.rows.filter((r: number) => r >= 1 && r <= sheet.data.length).length;
    }
    if (a?.column && a?.value_filter != null) {
      const c = this.aiResolveCol(sheet, String(a.column));
      if (c < 0) return null;
      const pred = this.aiCriteria(String(a.value_filter));
      const start = a.skipHeader === false ? 0 : 1;
      let n = 0;
      for (let r = start; r < sheet.data.length; r++) {
        if (pred(this.aiCellText(sheet, r, c))) n++;
      }
      return n;
    }
    return null;
  }

  private aiDocsDelete(a: { docIds?: string[] | 'all'; names?: string[] }): AiActionResult {
    const targets = this.aiResolveDocs(a);
    if (!targets.length) throw new Error('Документы не найдены. Проверь id или названия через describe().');
    const names = targets.map(d => `«${d.title}»`).join(', ');
    for (const doc of targets) {
      this.touchRecent(doc);
      const idx = this.docs.indexOf(doc);
      if (idx >= 0) this.docs.splice(idx, 1);
    }
    if (targets.some(d => d.id === this.activeId)) {
      this.activeId = this.docs[0]?.id ?? null;
      this.activeSheetIdx = 0;
    }
    this.save();
    this.render();
    return { summary: `Удалено документов: ${targets.length} — ${names}.` };
  }

  private aiDocsRename(a: { renames: Array<{ id?: string; name?: string; newName: string }> }): AiActionResult {
    if (!Array.isArray(a?.renames) || !a.renames.length) throw new Error('Не указаны документы для переименования (renames).');
    const done: string[] = [];
    const notFound: string[] = [];
    for (const r of a.renames) {
      const newName = (r.newName ?? '').trim();
      if (!newName) continue;
      let doc: DocItem | undefined;
      if (r.id) {
        doc = this.docs.find(d => d.id === r.id);
      } else if (r.name) {
        const low = r.name.trim().toLowerCase();
        doc = this.docs.find(d => d.title.trim().toLowerCase().includes(low));
      }
      if (!doc) { notFound.push(r.name ?? r.id ?? '?'); continue; }
      const old = doc.title;
      doc.title = newName;
      doc.updated_at = Date.now();
      done.push(`«${old}» → «${newName}»`);
    }
    if (done.length > 0) {
      this.save();
      this.render();
    }
    const notFoundStr = notFound.length ? ` Не найдены: ${notFound.join(', ')}.` : '';
    if (!done.length) throw new Error(`Ни один документ не переименован.${notFoundStr}`);
    return { summary: `Переименовано: ${done.join(', ')}.${notFoundStr}` };
  }

  private aiDocsSwitch(a: { id?: string; name?: string }): AiActionResult {
    let doc: DocItem | undefined;
    if (a?.id) {
      doc = this.docs.find(d => d.id === a.id);
    } else if (a?.name) {
      const low = a.name.trim().toLowerCase();
      doc = this.docs.find(d => d.title.trim().toLowerCase().includes(low));
    }
    if (!doc) throw new Error('Документ не найден. Проверь id или название через describe().');
    this.activeId = doc.id;
    this.activeSheetIdx = 0;
    this.render();
    return { summary: `Переключено на документ «${doc.title}».` };
  }

  private aiDocsClearContent(a: { docIds: string[] | 'all' }): AiActionResult {
    const targets = a?.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Документы не найдены. Проверь id через describe().');
    const snapshots = targets.map(d => ({ docId: d.id, before: d.content }));
    for (const doc of targets) {
      if (doc.type === 'word') {
        this.updateContent(doc.id, '');
      } else {
        const ec = this.parseExcelContent(doc.content);
        for (const sh of ec.sheets) {
          sh.data = sh.data.map(row => row.map(() => ({ v: '' } as CellData)));
        }
        this.updateContent(doc.id, JSON.stringify(ec));
      }
    }
    this.render();
    return {
      summary: `Очищено документов: ${targets.length} — ${targets.map(d => `«${d.title}»`).join(', ')}.`,
      undo: { kind: 'docs_multi', payload: { snapshots }, label: 'Отменить очистку' },
    };
  }

  // ── Range / rows AI actions ─────────────────────────────────────────────────

  private aiExcelSetRange(a: { range: string; values: string[][] }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    if (!a?.range) throw new Error('Не указан диапазон (range)');
    const m = String(a.range).trim().match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
    if (!m) throw new Error('Некорректный диапазон — ожидается формат "A1:C3"');
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const c1 = this.letterToCol(m[1]), r1 = +m[2] - 1;
    const c2 = this.letterToCol(m[3]), r2 = +m[4] - 1;
    const vals = a.values ?? [];
    let filled = 0;
    for (let r = r1; r <= r2; r++) {
      while (sheet.data.length <= r) sheet.data.push([]);
      const row = sheet.data[r];
      for (let c = c1; c <= c2; c++) {
        while (row.length <= c) row.push({ v: '' });
        const vr = r - r1, vc = c - c1;
        const val = vals[vr]?.[vc] ?? '';
        row[c] = { ...row[c], v: String(val) };
        filled++;
      }
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Диапазон ${a.range}: заполнено ${filled} ячеек.`, 'Отменить заполнение диапазона');
  }

  private aiExcelDeleteRows(a: { rows?: number[]; column?: string; value_filter?: string; skipHeader?: boolean }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const skip = a?.skipHeader !== false;

    let toDelete: Set<number>;

    if (Array.isArray(a?.rows) && a.rows.length > 0) {
      toDelete = new Set(a.rows.map(r => r - 1));
    } else if (a?.column) {
      const colIdx = this.aiResolveCol(sheet, a.column);
      if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
      const re = a.value_filter ? new RegExp(a.value_filter, 'i') : /./;
      toDelete = new Set<number>();
      sheet.data.forEach((row, ri) => {
        if (skip && ri === 0) return;
        const v = (row[colIdx]?.v ?? '').trim();
        if (re.test(v)) toDelete.add(ri);
      });
    } else {
      // Delete empty rows by default
      toDelete = new Set<number>();
      sheet.data.forEach((row, ri) => {
        if (skip && ri === 0) return;
        if (row.every(c => !(c.v ?? '').trim())) toDelete.add(ri);
      });
    }

    const countBefore = sheet.data.length;
    sheet.data = sheet.data.filter((_, ri) => !toDelete.has(ri));
    const deleted = countBefore - sheet.data.length;
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Удалено строк: ${deleted}.`, 'Отменить удаление строк');
  }

  private aiExcelInsertRows(a: { at: number; count?: number }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    const at = Math.max(0, (a?.at ?? 1) - 1);
    const count = Math.max(1, Math.min(a?.count ?? 1, 100));
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const cols = sheet.data[0]?.length ?? XL_COLS;
    const empty = () => Array.from({ length: cols }, () => ({ v: '' } as CellData));
    const newRows = Array.from({ length: count }, empty);
    sheet.data.splice(at, 0, ...newRows);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Вставлено ${count} пустых строк перед строкой ${a.at}.`, 'Отменить вставку строк');
  }

  private aiExcelSortSheet(a: { column: string; order?: string; hasHeader?: boolean; numeric?: boolean }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    if (!a?.column) throw new Error('Не указана колонка для сортировки (column)');
    const colIdx = this.aiResolveCol(sheet, a.column);
    if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const hasHeader = a.hasHeader !== false;
    const desc = (a.order ?? 'asc') === 'desc';
    const header = hasHeader ? sheet.data[0] : null;
    let dataRows = hasHeader ? sheet.data.slice(1) : [...sheet.data];

    const toNum = (v: string) => parseFloat(v.replace(/[^\d.,\-]/g, '').replace(',', '.'));
    const autoNumeric = a.numeric ?? dataRows.some(r => !isNaN(toNum((r[colIdx]?.v ?? '').trim())));

    dataRows.sort((ra, rb) => {
      const va = (ra[colIdx]?.v ?? '').trim();
      const vb = (rb[colIdx]?.v ?? '').trim();
      let cmp: number;
      if (autoNumeric) {
        const na = toNum(va), nb = toNum(vb);
        cmp = (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb);
      } else {
        cmp = va.localeCompare(vb, 'ru');
      }
      return desc ? -cmp : cmp;
    });

    sheet.data = header ? [header, ...dataRows] : dataRows;
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Таблица отсортирована по «${a.column}» ${desc ? 'по убыванию' : 'по возрастанию'} (${dataRows.length} строк).`, 'Отменить сортировку');
  }

  private aiExcelFormulaColumn(a: { column: string; formula: string; fromRow?: number; toRow?: number }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    if (!a?.column) throw new Error('Не указана колонка (column)');
    if (!a?.formula) throw new Error('Не указан шаблон формулы (formula)');
    const colIdx = this.aiResolveCol(sheet, a.column);
    if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const dataRows = sheet.data.slice(1).filter(r => r.some(c => (c.v||'').trim())).length;
    const fromRow = (a.fromRow ?? 2) - 1;
    const toRow = (a.toRow ?? dataRows + 1) - 1;
    let filled = 0;
    for (let r = fromRow; r <= toRow && r < sheet.data.length; r++) {
      const row = sheet.data[r];
      while (row.length <= colIdx) row.push({ v: '' });
      const formula = a.formula.replace(/\{r\}/g, String(r + 1));
      row[colIdx] = { ...row[colIdx], v: formula };
      filled++;
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Формула «${a.formula}» заполнена в ${filled} ячеек колонки «${a.column}».`, 'Отменить формулы');
  }

  // ── Sheet management AI actions ─────────────────────────────────────────────

  private aiExcelAddSheet(a: { name?: string }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    const n = ec.sheets.length + 1;
    const name = (a?.name ?? '').trim() || `Лист ${n}`;
    if (ec.sheets.some(sh => sh.name === name)) throw new Error(`Лист «${name}» уже существует`);
    ec.sheets.push({
      name,
      data: Array.from({ length: XL_ROWS }, () => Array.from({ length: XL_COLS }, () => ({ v: '' } as CellData))),
    });
    this.activeSheetIdx = ec.sheets.length - 1;
    this.updateContent(doc.id, JSON.stringify(ec));
    this.render();
    return { summary: `Добавлен лист «${name}» (всего листов: ${ec.sheets.length}).` };
  }

  private aiExcelRenameSheet(a: { from?: string; to: string }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    if (!(a?.to ?? '').trim()) throw new Error('Не указано новое название листа (to)');
    const ec = this.parseExcelContent(doc.content);
    let sh: SheetData | undefined;
    if (a?.from) {
      sh = ec.sheets.find(s => s.name === a.from);
      if (!sh) throw new Error(`Лист «${a.from}» не найден`);
    } else {
      sh = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    }
    const old = sh.name;
    sh.name = a.to.trim();
    this.updateContent(doc.id, JSON.stringify(ec));
    this.render();
    return { summary: `Лист «${old}» переименован в «${sh.name}».` };
  }

  private aiExcelDeleteSheet(a: { name?: string }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    if (ec.sheets.length <= 1) throw new Error('Нельзя удалить последний лист');
    let idx: number;
    if (a?.name) {
      idx = ec.sheets.findIndex(s => s.name === a.name);
      if (idx < 0) throw new Error(`Лист «${a.name}» не найден`);
    } else {
      idx = this.activeSheetIdx;
    }
    const name = ec.sheets[idx].name;
    ec.sheets.splice(idx, 1);
    if (this.activeSheetIdx >= ec.sheets.length) this.activeSheetIdx = ec.sheets.length - 1;
    this.updateContent(doc.id, JSON.stringify(ec));
    this.render();
    return { summary: `Лист «${name}» удалён. Осталось листов: ${ec.sheets.length}.` };
  }

  private aiExcelCopySheet(a: { from?: string; newName?: string }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    let src: SheetData;
    if (a?.from) {
      const found = ec.sheets.find(s => s.name === a.from);
      if (!found) throw new Error(`Лист «${a.from}» не найден`);
      src = found;
    } else {
      src = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    }
    const baseName = (a?.newName ?? '').trim() || `${src.name} (копия)`;
    let name = baseName;
    let attempt = 2;
    while (ec.sheets.some(s => s.name === name)) name = `${baseName} ${attempt++}`;
    const copy: SheetData = JSON.parse(JSON.stringify(src));
    copy.name = name;
    ec.sheets.push(copy);
    this.activeSheetIdx = ec.sheets.length - 1;
    this.updateContent(doc.id, JSON.stringify(ec));
    this.render();
    return { summary: `Лист «${src.name}» скопирован как «${name}».` };
  }

  private escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  private esc(s: string): string {
    return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]!));
  }
}
