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

type DocType = 'word' | 'excel';

interface CellData {
  v: string;   // value or formula text
  s?: string;  // inline style cssText
}

interface SheetData {
  name: string;
  data: CellData[][];
  colWidths?: (number | null)[];
  rowHeights?: (number | null)[];
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

export class DocsModule {
  private root!: HTMLElement;
  private docs: DocItem[] = [];
  private activeId: string | null = null;
  private loadedCompanyId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSheetIdx: number = 0;
  private xlVirtData: CellData[][] | null = null;
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
        const slim = this.docs.map(d => ({ ...d, content: d.content.length > 50000 ? d.content.slice(0, 50000) : d.content }));
        localStorage.setItem(this.sk(), JSON.stringify(slim));
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
        } else if (row.updated_at > local.updated_at) {
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
    return (p || []).map(row => (row || []).map((cell: unknown) => {
      if (typeof cell === 'string') return { v: cell };
      if (cell && typeof cell === 'object' && 'v' in cell) {
        const c = cell as { v?: unknown; s?: unknown };
        return { v: String(c.v ?? ''), s: typeof c.s === 'string' && c.s ? c.s : undefined };
      }
      return { v: '' };
    }));
  }

  // ── SheetJS style → CSS ────────────────────────────────────────────────────
  // ── OOXML full-style reader ────────────────────────────────────────────────
  // Builds a Map<cellAddr, cssString> by reading raw sheet XML + wb.Styles tables.
  // This gives accurate font/fill/alignment — SheetJS CE's cell.s is incomplete.
  private xlBuildStyleMap(wb: any, sheetFilePath: string): Map<string, string> {
    const S = wb.Styles;
    if (!S || !wb.files || !sheetFilePath) return new Map();

    const toHex = (rgb: unknown): string | null => {
      if (!rgb || typeof rgb !== 'string') return null;
      const h = rgb.length === 8 ? rgb.slice(2) : rgb;
      return h.length === 6 ? h.toLowerCase() : null;
    };

    // Pre-compute CellXf index → CSS string
    const xfCSS: string[] = (S.CellXf || []).map((xf: any) => {
      if (!xf) return '';
      const parts: string[] = [];

      // Background fill
      const fill = S.Fills?.[+xf.fillId];
      if (fill?.patternType === 'solid' && fill.fgColor?.rgb) {
        const hex = toHex(fill.fgColor.rgb);
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
        // Always import font size (including default 11pt)
        if (sz) parts.push(`font-size:${Math.round(sz * 1.333)}px`);
        const fname = font.name;
        // Always import font family (including Calibri)
        if (fname) parts.push(`font-family:"${fname}",sans-serif`);
        // Skip only near-white colors (invisible on white cell background)
        const hex = toHex(font.color?.rgb);
        if (hex) {
          const lum = 0.299 * parseInt(hex.slice(0,2),16) + 0.587 * parseInt(hex.slice(2,4),16) + 0.114 * parseInt(hex.slice(4,6),16);
          if (lum < 220) parts.push(`color:#${hex}`);
        }
      }

      // Alignment — wrapText intentionally NOT applied:
      // HTML table rows expand to fit wrapped content; we clip instead (like default Excel).
      // Full value is visible in the formula bar when the cell is selected.
      const al = xf.alignment;
      if (al) {
        if (al.horizontal === 'center') parts.push('text-align:center');
        else if (al.horizontal === 'right') parts.push('text-align:right');
        if (al.vertical === 'top') parts.push('vertical-align:top');
        else if (al.vertical === 'center') parts.push('vertical-align:middle');
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

  // ── Import ─────────────────────────────────────────────────────────────────
  private async importFile(file: File): Promise<void> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bare = name.replace(/\.[^.]+$/, '');
    const now = Date.now();

    try {
      if (ext === 'xlsx' || ext === 'xls') {
        const buf = await file.arrayBuffer();
        // bookFiles:true exposes raw XML so we can read full style indices
        const wb = XLSX.read(buf, { type: 'array', cellStyles: true, bookFiles: true, sheetRows: MAX_IMPORT_ROWS + 1 });

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
              const v = cell ? (cell.w ?? (cell.v == null ? '' : String(cell.v))) : '';
              const s = styleMap.get(addr) ?? '';
              row.push(s ? { v, s } : { v });
            }
            data.push(row);
          }

          // Column widths (wpx preferred)
          const xlCols = ws['!cols'] || [];
          const colWidths: (number | null)[] = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            const ci = xlCols[c];
            colWidths.push(ci?.wpx ? Math.round(ci.wpx) : ci?.width ? Math.round(ci.width * 7) : null);
          }

          // Row heights (hpx preferred)
          const xlRows = ws['!rows'] || [];
          const rowHeights: (number | null)[] = [];
          for (let r = range.s.r; r <= range.e.r; r++) {
            const ri = xlRows[r];
            rowHeights.push(ri?.hpx ? Math.round(ri.hpx) : ri?.hpt ? Math.round(ri.hpt * 1.33) : null);
          }

          const truncated = data.length > MAX_IMPORT_ROWS;
          if (truncated) data.length = MAX_IMPORT_ROWS;
          return { name: sheetName, data, colWidths, rowHeights, ...(truncated ? { truncated: true as const } : {}) };
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

  // ── CSS → SheetJS style object (for xlsx export) ──────────────────────────
  private cssToXlsxStyle(css: string): any {
    if (!css) return null;
    const props: Record<string, string> = {};
    css.split(';').forEach(p => {
      const colon = p.indexOf(':');
      if (colon < 0) return;
      const k = p.slice(0, colon).trim().toLowerCase();
      const v = p.slice(colon + 1).trim();
      if (k) props[k] = v;
    });

    const parseColor = (val: string): string | null => {
      const hex6 = val.match(/^#([0-9a-f]{6})$/i);
      if (hex6) return hex6[1].toUpperCase();
      const rgb = val.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
      if (rgb) return [rgb[1], rgb[2], rgb[3]]
        .map(n => parseInt(n).toString(16).padStart(2, '0')).join('').toUpperCase();
      return null;
    };

    const style: any = {};
    const font: any = {};
    let fill: any = null;
    const alignment: any = {};
    const border: any = {};

    for (const [prop, rawVal] of Object.entries(props)) {
      const val = rawVal.trim();
      switch (prop) {
        case 'background-color':
        case 'background': {
          const rgb = parseColor(val.split(/\s+/)[0]);
          if (rgb) fill = { patternType: 'solid', fgColor: { rgb } };
          break;
        }
        case 'color': {
          const rgb = parseColor(val);
          if (rgb) font.color = { rgb };
          break;
        }
        case 'font-weight':
          if (val === 'bold' || parseInt(val) >= 700) font.bold = true;
          break;
        case 'font-style':
          if (val === 'italic') font.italic = true;
          break;
        case 'text-decoration':
          if (val.includes('underline')) font.underline = true;
          if (val.includes('line-through')) font.strike = true;
          break;
        case 'font-size': {
          const px = parseFloat(val);
          if (!isNaN(px)) font.sz = Math.max(6, Math.round(px / 1.333));
          break;
        }
        case 'font-family': {
          const name = val.split(',')[0].trim().replace(/['"]/g, '');
          if (name) font.name = name;
          break;
        }
        case 'text-align':
          if (['left','center','right','justify'].includes(val)) alignment.horizontal = val;
          break;
        case 'vertical-align':
          if (val === 'middle') alignment.vertical = 'center';
          else if (val === 'top' || val === 'bottom') alignment.vertical = val;
          break;
        case 'border': {
          if (val && val !== 'none' && !val.startsWith('0')) {
            const cm = val.match(/#([0-9a-f]{6})/i);
            const clr = cm ? cm[1].toUpperCase() : '000000';
            const brd = { style: 'thin', color: { rgb: clr } };
            border.top = border.bottom = border.left = border.right = brd;
          }
          break;
        }
        case 'border-top': case 'border-bottom': case 'border-left': case 'border-right': {
          if (val && val !== 'none' && !val.startsWith('0')) {
            const cm = val.match(/#([0-9a-f]{6})/i);
            const clr = cm ? cm[1].toUpperCase() : '000000';
            const side = prop.replace('border-', '') as 'top'|'bottom'|'left'|'right';
            border[side] = { style: 'thin', color: { rgb: clr } };
          }
          break;
        }
      }
    }

    if (Object.keys(font).length) style.font = font;
    if (fill) style.fill = fill;
    if (Object.keys(alignment).length) style.alignment = alignment;
    if (Object.keys(border).length) style.border = border;
    return Object.keys(style).length ? style : null;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  private exportDoc(doc: DocItem, format: string): void {
    if (doc.type === 'excel') {
      const ec = this.parseExcelContent(doc.content);
      if (format === 'xlsx') {
        const wb = XLSX.utils.book_new();
        ec.sheets.forEach(sh => {
          const trimmed = this.trimEmpty(sh.data);
          const values = trimmed.map(r => r.map(c => c.v));
          const ws = XLSX.utils.aoa_to_sheet(values);

          // Apply cell styles
          trimmed.forEach((row, r) => {
            row.forEach((cell, c) => {
              if (!cell.s) return;
              const addr = XLSX.utils.encode_cell({ r, c });
              if (!ws[addr]) return;
              const xlStyle = this.cssToXlsxStyle(cell.s);
              if (xlStyle) ws[addr].s = xlStyle;
            });
          });

          // Column widths
          if (sh.colWidths?.some(w => w != null)) {
            ws['!cols'] = (sh.colWidths ?? []).map(w => w ? { wpx: w } : {});
          }

          // Row heights
          if (sh.rowHeights?.some(h => h != null)) {
            ws['!rows'] = (sh.rowHeights ?? []).slice(0, trimmed.length).map(h => h ? { hpx: h } : {});
          }

          XLSX.utils.book_append_sheet(wb, ws, sh.name);
        });
        XLSX.writeFile(wb, `${doc.title}.xlsx`, { cellStyles: true });
      } else if (format === 'csv') {
        const sh = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
        const values = this.trimEmpty(sh.data).map(r => r.map(c => c.v));
        const ws = XLSX.utils.aoa_to_sheet(values);
        const csv = XLSX.utils.sheet_to_csv(ws);
        this.download(`${doc.title}.csv`, new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8' }));
      }
      return;
    }
    if (format === 'html') {
      this.download(`${doc.title}.html`, new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${this.esc(doc.title)}</title></head><body>${doc.content}</body></html>`], { type: 'text/html;charset=utf-8' }));
    } else if (format === 'doc') {
      this.download(`${doc.title}.doc`, new Blob([`<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset="utf-8"></head><body>${doc.content}</body></html>`], { type: 'application/msword' }));
    } else if (format === 'txt') {
      const div = document.createElement('div'); div.innerHTML = doc.content;
      this.download(`${doc.title}.txt`, new Blob([div.innerText], { type: 'text/plain;charset=utf-8' }));
    }
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
      ? `<option value="html">HTML</option><option value="doc">Word (.doc)</option><option value="txt">Текст</option>`
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
      <div class="docs-word-editor" id="docs-word-editor" contenteditable="true" spellcheck="true" data-placeholder="Начните печатать…">${doc.content || ''}</div>
    </div>`;
  }

  // Insert visual page separators between block elements at every PAGE_H px.
  // Separators are stripped before saving so they never pollute the stored HTML.
  private setupPageSeparators(editor: HTMLElement): void {
    const PAGE_H = 1123;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      if (busy) return;
      busy = true;
      editor.querySelectorAll('.dw-pg-sep').forEach(el => el.remove());

      const children = Array.from(editor.children) as HTMLElement[];
      let curPage = 0;
      for (const el of children) {
        const elPage = Math.floor(el.offsetTop / PAGE_H);
        if (elPage > curPage) {
          for (let p = curPage + 1; p <= elPage; p++) {
            const sep = document.createElement('div');
            sep.className = 'dw-pg-sep';
            sep.contentEditable = 'false';
            el.parentNode!.insertBefore(sep, el);
          }
          curPage = elPage;
        }
      }
      setTimeout(() => { busy = false; }, 400);
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 200);
    };

    schedule();
    new ResizeObserver(() => { if (!busy) schedule(); }).observe(editor);
    editor.addEventListener('input', schedule);
  }

  private bindWord(doc: DocItem): void {
    const editor = this.root.querySelector<HTMLElement>('#docs-word-editor');
    if (!editor) return;

    // Strip page separators before saving — they must never be persisted
    const commit = () => {
      const clone = editor.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.dw-pg-sep').forEach(el => el.remove());
      this.updateContent(doc.id, clone.innerHTML);
    };
    editor.addEventListener('input', commit);

    // Apply CSS-based font size to selection via span
    const applyFontSize = (sizePt: string) => {
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('fontSize', false, '7');
      editor.querySelectorAll<HTMLElement>('font[size="7"]').forEach(el => {
        const span = document.createElement('span');
        span.style.fontSize = sizePt;
        span.innerHTML = el.innerHTML;
        el.replaceWith(span);
      });
    };

    this.root.querySelectorAll<HTMLButtonElement>('.dw-tool').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        editor.focus();
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
      editor.focus();
      if (blockSel.value) document.execCommand('formatBlock', false, blockSel.value);
      blockSel.value = 'p';
      commit();
    });

    const fontSel = this.root.querySelector<HTMLSelectElement>('[data-cmd-font]');
    fontSel?.addEventListener('change', () => {
      if (!fontSel.value) return;
      editor.focus();
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('fontName', false, fontSel.value);
      fontSel.value = '';
      commit();
    });

    const ptSel = this.root.querySelector<HTMLSelectElement>('[data-cmd-size]');
    ptSel?.addEventListener('change', () => {
      if (!ptSel.value) return;
      editor.focus();
      applyFontSize(ptSel.value);
      ptSel.value = '';
      commit();
    });

    this.root.querySelector<HTMLInputElement>('[data-color]')?.addEventListener('input', e => {
      editor.focus();
      const v = (e.target as HTMLInputElement).value;
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, v);
      const bar = this.root.querySelector<HTMLElement>('.dw-fg-bar');
      if (bar) bar.style.background = v;
      commit();
    });

    this.root.querySelector<HTMLInputElement>('[data-hilite]')?.addEventListener('input', e => {
      editor.focus();
      const v = (e.target as HTMLInputElement).value;
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('hiliteColor', false, v) || document.execCommand('backColor', false, v);
      const bar = this.root.querySelector<HTMLElement>('.dw-hi-bar');
      if (bar) bar.style.background = v;
      commit();
    });

    this.setupPageSeparators(editor);
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
    if (isVirt) { this.xlVirtData = rows; }
    else { this.xlVirtData = null; }
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
                  return this.renderCell(rows, r, c, cell, cwStyle);
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
    let editOrigVal = '';

    const getEC = (): ExcelContent => this.parseExcelContent(doc.content);
    const getSheet = (): SheetData => {
      const ec = getEC();
      return ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    };

    // Snapshot currently visible DOM cells back into xlVirtData
    const vd = this.xlVirtData;

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
          const v = td.dataset.formula ?? td.innerText;
          const s = cellStyle(td);
          vd[r][c] = s ? { v, s } : { v };
        });
      });
    };

    const grid = (): CellData[][] => {
      if (vd) { syncDomToData(); return vd; }
      const rows: CellData[][] = [];
      body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr => {
        const row: CellData[] = [];
        tr.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach(td => {
          const v = td.dataset.formula ?? td.innerText;
          const s = cellStyle(td);
          row.push(s ? { v, s } : { v });
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
          if (cell.v.startsWith('=')) { td.dataset.formula = cell.v; td.innerText = this.evalFormula(cell.v, snap.data); }
          else { delete td.dataset.formula; td.innerText = cell.v; }
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
        if (editOrigVal.startsWith('=')) { td.dataset.formula = editOrigVal; td.innerText = this.evalFormula(editOrigVal, grid()); }
        else { delete td.dataset.formula; td.innerText = editOrigVal; }
      } else {
        const txt = td.innerText;
        if (txt.startsWith('=')) { td.dataset.formula = txt; td.innerText = this.evalFormula(txt, grid()); }
        else delete td.dataset.formula;
        if (doCommit) saveGrid(grid());
      }
      syncFormulaBar();
    };
    const AC_FUNS = ['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','COUNTBLANK','COUNTIF','SUMIF','VLOOKUP','IF','IFERROR','ABS','ROUND','FLOOR','CEILING','SQRT','INT','POWER','MOD','CONCATENATE','LEN','LEFT','RIGHT','MID','TRIM','UPPER','LOWER','TEXT','AND','OR','NOT'];
    const enterEdit = (r: number, c: number, initChar = '') => {
      if (editMode) exitEdit(true);
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
      if (!td) return;
      editMode = true; editTd = td;
      editOrigVal = td.dataset.formula ?? td.innerText;
      td.contentEditable = 'true';
      td.classList.add('dx-editing');
      if (initChar) { pushUndo(); td.innerText = initChar; delete td.dataset.formula; }
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-xf-num]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const cell=curCell(); if(!cell) return;
        const val=cell.innerText.trim(), fmt=btn.dataset.xfNum!;
        const n=parseFloat(val.replace(',','.').replace(/[^\d.-]/g,''));
        if(isNaN(n)&&fmt!=='date'&&fmt!=='general') return;
        if(fmt==='general') cell.innerText=val;
        else if(fmt==='number') cell.innerText=n.toLocaleString('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2});
        else if(fmt==='currency') cell.innerText=n.toLocaleString('ru-RU',{style:'currency',currency:'RUB'});
        else if(fmt==='percent') cell.innerText=n.toLocaleString('ru-RU',{style:'percent',maximumFractionDigits:2});
        else if(fmt==='date'){const d=new Date(val);if(!isNaN(d.getTime()))cell.innerText=d.toLocaleDateString('ru-RU');}
        commit();
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
        let html = '';
        if (topH > 0) html += `<tr class="vx-spacer" style="height:${topH}px"><td colspan="${span}" style="padding:0;border:0;pointer-events:none"></td></tr>`;
        for (let r = startR; r < endR; r++) {
          const h = vRowH[r]; const hStyle = h ? ` style="height:${h}px"` : '';
          html += `<tr data-row="${r}"${hStyle}><th class="dx-rowhdr" data-row-hdr="${r}"><span class="dx-hdr-label">${r+1}</span><div class="dx-hdr-actions dx-hdr-actions-row"><button class="dx-hdr-btn" data-row-add="${r}" title="Добавить строку ниже">+</button><button class="dx-hdr-btn dx-danger" data-row-del="${r}" title="Удалить строку">−</button></div><div class="dx-row-resize" data-row-r="${r}"></div></th>${vd[r].map((cell,c)=>{const cw=vColW[c];return this.renderCell(vd,r,c,cell,cw?`min-width:${cw}px;width:${cw}px;`:'');}).join('')}</tr>`;
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

  // ── Cell rendering ─────────────────────────────────────────────────────────
  private renderCell(rows: CellData[][], r: number, c: number, cell: CellData, extraStyle = ''): string {
    const v = cell.v ?? '';
    const combined = [extraStyle, cell.s || ''].filter(Boolean).join(';');
    const styleAttr = combined ? ` style="${this.esc(combined)}"` : '';
    if (v.startsWith('=')) {
      const result = this.evalFormula(v, rows);
      return `<td data-r="${r}" data-c="${c}" data-formula="${this.esc(v)}"${styleAttr}>${this.esc(result)}</td>`;
    }
    return `<td data-r="${r}" data-c="${c}"${styleAttr}>${this.esc(v)}</td>`;
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

  /** describe() — текущее состояние открытого документа для модели. */
  private aiDescribe(): string {
    const fsFocus = this.isFullscreen
      ? '[РЕЖИМ: Полный экран редактора. Пользователь работает с документом. Фокусируйся только на нём — давай советы, подсказки и действия именно по этому файлу. Ты можешь отвечать на вопросы об API (остатки, заказы, аналитика WB/Ozon) если пользователь явно спросит, но сам не переключайся на другие разделы.]\n\n'
      : '';
    const allDocsInfo = this.docs.length > 0
      ? `\n\n📂 Все открытые документы (${this.docs.length}):\n` +
        this.docs.map((d, i) => {
          let extra = '';
          if (d.type === 'excel') {
            try {
              const ec = this.parseExcelContent(d.content);
              const sheets = ec.sheets.map(sh => {
                const cols = sh.data[0]?.length ?? 0;
                const dataRows = sh.data.slice(1).filter(r => r.some(c => (c.v||'').trim())).length;
                const hdrs = (sh.data[0] ?? []).map((c, ci) => `${this.colLetter(ci)}="${(c.v||'').trim()||'(пусто)'}"`).slice(0, 8).join(', ');
                return `    Лист «${sh.name}»: ${dataRows} стр × ${cols} кол. | Заголовки: ${hdrs}`;
              }).join('\n');
              extra = '\n' + sheets;
            } catch { extra = ''; }
          } else {
            const len = d.content.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().length;
            extra = ` (~${len} симв.)`;
          }
          const active = d.id === this.activeId ? ' ← АКТИВНЫЙ' : '';
          return `  ${i+1}. id="${d.id}" «${d.title}» [${d.type}]${active}${extra}`;
        }).join('\n') +
        '\n\nДля операций по нескольким документам: multi_replace/multi_count/docs_delete/docs_rename/docs_clear_content с параметром docIds.'
      : '';
    const doc = this.aiDoc();
    if (!doc) return fsFocus + 'Нет открытого документа. Пользователь может создать Word или Excel.' + allDocsInfo;
    if (doc.type === 'word') {
      const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const paragraphs = (doc.content.match(/<(p|h[1-6])\b/gi) ?? []).length;
      const headingMatches = [...doc.content.matchAll(/<(h[1-6])[^>]*>(.*?)<\/h[1-6]>/gi)];
      const headings = headingMatches
        .map(m => `  ${m[1].toUpperCase()}: ${m[2].replace(/<[^>]+>/g, '').trim()}`)
        .slice(0, 10).join('\n');
      return fsFocus + `Открыт Word-документ «${doc.title}».
Статистика: ${words} слов, ${text.length} символов, ~${paragraphs} абзацев.${headings ? '\nЗаголовки в документе:\n' + headings : ''}
Содержимое (первые 1500 симв): "${text.slice(0, 1500)}"${text.length > 1500 ? '\n...(текст обрезан)' : ''}` + allDocsInfo;
    }
    const s = this.aiSheet();
    if (!s) return `Открыт документ «${doc.title}», но лист пуст.`;
    const { ec, sheet, doc: docRef } = s;
    const data = sheet.data;
    const cols = data[0]?.length ?? 0;
    const headers = (data[0] ?? []).map((c, i) => `${this.colLetter(i)}="${(c.v || '').trim() || '(пусто)'}"`);
    const artCols = this.aiArticleCols(sheet);

    // Только непустые строки (данные)
    const dataRows = data.slice(1).filter(row => row.some(c => (c.v || '').trim()));

    // Все данные до 30 строк (не только 5)
    const sample = dataRows.slice(0, 30).map((row, ri) =>
      `  строка ${ri + 2}: ` + row.slice(0, cols).map((c, ci) => `${this.colLetter(ci)}=${(c.v || '').trim() || '—'}`).join(' | '),
    ).join('\n');

    // Частотный анализ текстовых колонок — чтобы ИИ знал сколько «Мадрид» и т.д.
    const freqParts: string[] = [];
    (data[0] ?? []).forEach((hdr, ci) => {
      if (artCols.includes(ci)) return; // артикулы не анализируем
      const hName = (hdr.v || '').trim();
      if (!hName) return;
      const vals: Record<string, number> = {};
      dataRows.forEach(row => {
        const v = (row[ci]?.v || '').trim();
        if (v) vals[v] = (vals[v] || 0) + 1;
      });
      const uniq = Object.keys(vals).length;
      if (uniq === 0 || uniq > 200) return; // слишком много уникальных — числа/коды
      const top = Object.entries(vals).sort((a, b) => b[1] - a[1]).slice(0, 8);
      freqParts.push(`  Колонка ${this.colLetter(ci)} «${hName}» (${uniq} уник.): ${top.map(([v, n]) => `"${v}"×${n}`).join(', ')}${uniq > 8 ? ' ...' : ''}`);
    });

    // Список листов
    const sheetsInfo = ec.sheets.length > 1
      ? `\nВсе листы: ${ec.sheets.map(sh => `«${sh.name}» (${sh.data.filter(r => r.some(c => (c.v||'').trim())).length} строк)`).join(', ')}`
      : '';

    const styled = data.some(r => r.some(c => c.s));
    return fsFocus + `Открыта таблица «${docRef.title}», лист «${sheet.name}» (всего листов: ${ec.sheets.length}).
Заполненных строк данных: ${dataRows.length} (строки 2…${dataRows.length + 1}) × ${cols} колонок.
Заголовки (строка 1): ${headers.join(', ')}
Колонки-артикулы (по умолчанию НЕ трогать при заменах): ${artCols.length ? artCols.map(i => this.colLetter(i)).join(', ') : 'не обнаружены'}
Оформление: ${styled ? 'в ячейках есть стили' : 'без оформления'}${sheetsInfo}
${freqParts.length ? 'Частота значений по колонкам:\n' + freqParts.join('\n') : ''}
Данные (до 30 строк):
${sample || '  (нет строк)'}${dataRows.length > 30 ? `\n  ... ещё ${dataRows.length - 30} строк` : ''}${allDocsInfo}`;
  }

  /** Публичная точка: капабилити текущей страницы редактора для ассистента. */
  getAiCapability(): AiPageCapability {
    const isWord = this.aiDoc()?.type === 'word';
    const fsSuggestions = isWord ? [
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в документе' },
      { label: '🔁 Замена текста', prompt: 'Помоги заменить текст в документе' },
      { label: '✨ Убрать форматирование', prompt: 'Убери все стили и форматирование из документа' },
      { label: '✍️ Дополни текст', prompt: 'Предложи продолжение для этого текста' },
    ] : [
      { label: '🔎 Что в документе?', prompt: 'Проанализируй открытый документ: что за данные, структура, ключевые значения' },
      { label: '✨ Улучшить дизайн', prompt: 'Улучши оформление текущей таблицы' },
      { label: '🔁 Замена текста', prompt: 'Помоги заменить текст в таблице' },
      { label: '📊 Сводка по данным', prompt: 'Дай краткую сводку по данным в открытой таблице' },
    ];
    const normalSuggestions = isWord ? [
      { label: '➕ Новый Word', prompt: 'Создай новый Word-документ' },
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в открытом документе' },
      { label: '🔎 Анализ текста', prompt: 'Проанализируй содержимое документа: о чём он, основные темы' },
      { label: '🔁 Замена', prompt: 'Помоги заменить текст в документе' },
    ] : [
      { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
      { label: '✨ Улучшить дизайн', prompt: 'Улучши дизайн текущей таблицы' },
      { label: '🔎 Что в таблице?', prompt: 'Проанализируй открытую таблицу: что за данные, какие колонки' },
      { label: '🔁 Замена', prompt: 'Помоги заменить текст в таблице' },
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
    this.render();
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

  private evalFormula(formula: string, rows: CellData[][], _depth = 0): string {
    if(_depth>20) return '#REC';
    if(!formula.startsWith('=')) return formula;
    let expr=formula.slice(1);

    const cellVal=(r:number,c:number):number=>{
      const cell=rows[r]?.[c]; const raw=cell?.v??'';
      if(raw.startsWith('=')){const n=parseFloat(this.evalFormula(raw,rows,_depth+1));return isNaN(n)?0:n;}
      const n=parseFloat(String(raw).replace(',','.')); return isNaN(n)?0:n;
    };
    const cellStr=(r:number,c:number):string=>{
      const cell=rows[r]?.[c]; const raw=cell?.v??'';
      if(raw.startsWith('=')) return this.evalFormula(raw,rows,_depth+1);
      return raw;
    };
    const unquote=(s:string)=>s.replace(/^["']|["']$/g,'');
    const parseRef=(s:string)=>{
      const m=s.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
      return m?{r:+m[2]-1,c:this.letterToCol(m[1])}:null;
    };

    // ── VLOOKUP(lookup, table_range, col_index, [exact]) ──────────────────────
    expr=expr.replace(/\bVLOOKUP\s*\(([^()]+)\)/gi,(_m,args)=>{
      try{
        const pts=args.split(',').map((s:string)=>s.trim()); if(pts.length<3) return '#N/A';
        const lookupVal=unquote(pts[0]); const rangeM=pts[1].match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i); if(!rangeM) return '#N/A';
        const c1n=this.letterToCol(rangeM[1]),r1n=+rangeM[2]-1,r2n=+rangeM[4]-1;
        const colOffset=parseInt(pts[2])-1;
        const exact=pts[3]?.trim()!=='FALSE';
        const lNum=parseFloat(lookupVal);
        for(let r=r1n;r<=r2n;r++){
          const v=cellStr(r,c1n);
          const match=exact?(v===lookupVal||(parseFloat(v)===lNum&&!isNaN(lNum))):v.toLowerCase().includes(lookupVal.toLowerCase());
          if(match) return cellStr(r,c1n+colOffset);
        }
        return '#N/A';
      }catch{return '#N/A';}
    });

    // ── COUNTIF(range, criteria) ──────────────────────────────────────────────
    expr=expr.replace(/\bCOUNTIF\s*\(([^()]+)\)/gi,(_m,args)=>{
      try{
        const pts=args.split(',').map((s:string)=>s.trim()); if(pts.length<2) return '0';
        const rm=pts[0].match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i); if(!rm) return '0';
        const c1n=this.letterToCol(rm[1]),r1n=+rm[2]-1,c2n=this.letterToCol(rm[3]),r2n=+rm[4]-1;
        const crit=unquote(pts[1]); const opM=crit.match(/^([><=!]{1,2})(.*)/);
        let cnt=0;
        for(let r=r1n;r<=r2n;r++) for(let c=c1n;c<=c2n;c++){
          const v=cellStr(r,c); const n=parseFloat(v); const cn=parseFloat(opM?opM[2]:crit);
          if(opM){const op=opM[1];if(op==='>'&&n>cn)cnt++;else if(op==='>='&&n>=cn)cnt++;else if(op==='<'&&n<cn)cnt++;else if(op==='<='&&n<=cn)cnt++;else if((op==='<>'||op==='!=')&&v!==opM[2])cnt++;else if(op==='='&&v===opM[2])cnt++;}
          else if(v===crit||(parseFloat(v)===parseFloat(crit)&&!isNaN(parseFloat(crit))))cnt++;
        }
        return String(cnt);
      }catch{return '0';}
    });

    // ── SUMIF(range, criteria, sum_range) ─────────────────────────────────────
    expr=expr.replace(/\bSUMIF\s*\(([^()]+)\)/gi,(_m,args)=>{
      try{
        const pts=args.split(',').map((s:string)=>s.trim()); if(pts.length<3) return '0';
        const rm=pts[0].match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i); if(!rm) return '0';
        const c1n=this.letterToCol(rm[1]),r1n=+rm[2]-1,r2n=+rm[4]-1;
        const rm2=pts[2].match(/([A-Z]+)(\d+)/i); if(!rm2) return '0';
        const sumC=this.letterToCol(rm2[1]);
        const crit=unquote(pts[1]); const opM=crit.match(/^([><=!]{1,2})(.*)/);
        let sum=0;
        for(let r=r1n;r<=r2n;r++){
          const v=cellStr(r,c1n); const n=parseFloat(v); const cn=parseFloat(opM?opM[2]:crit);
          let match=false;
          if(opM){const op=opM[1];if(op==='>'&&n>cn)match=true;else if(op==='>='&&n>=cn)match=true;else if(op==='<'&&n<cn)match=true;else if(op==='<='&&n<=cn)match=true;else if((op==='<>'||op==='!=')&&v!==opM[2])match=true;else if(op==='='&&v===opM[2])match=true;}
          else if(v===crit||(parseFloat(v)===parseFloat(crit)&&!isNaN(parseFloat(crit))))match=true;
          if(match) sum+=cellVal(r,sumC);
        }
        return String(sum);
      }catch{return '0';}
    });

    // ── COUNTA, COUNTBLANK ────────────────────────────────────────────────────
    expr=expr.replace(/\bCOUNTA\s*\(([^()]+)\)/gi,(_m,args)=>{
      const rm=args.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i); if(!rm) return '0';
      const c1n=this.letterToCol(rm[1]),r1n=+rm[2]-1,c2n=this.letterToCol(rm[3]),r2n=+rm[4]-1;
      let cnt=0; for(let r=r1n;r<=r2n;r++) for(let c=c1n;c<=c2n;c++) if(cellStr(r,c).trim()) cnt++;
      return String(cnt);
    });
    expr=expr.replace(/\bCOUNTBLANK\s*\(([^()]+)\)/gi,(_m,args)=>{
      const rm=args.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i); if(!rm) return '0';
      const c1n=this.letterToCol(rm[1]),r1n=+rm[2]-1,c2n=this.letterToCol(rm[3]),r2n=+rm[4]-1;
      let cnt=0; for(let r=r1n;r<=r2n;r++) for(let c=c1n;c<=c2n;c++) if(!cellStr(r,c).trim()) cnt++;
      return String(cnt);
    });

    // ── Text functions ────────────────────────────────────────────────────────
    const resolveStr=(s:string)=>{ const ref=parseRef(s.trim()); return ref?cellStr(ref.r,ref.c):unquote(s.trim()); };
    expr=expr.replace(/\bUPPER\s*\(([^()]*)\)/gi,(_m,a)=>resolveStr(a).toUpperCase());
    expr=expr.replace(/\bLOWER\s*\(([^()]*)\)/gi,(_m,a)=>resolveStr(a).toLowerCase());
    expr=expr.replace(/\bTRIM\s*\(([^()]*)\)/gi,(_m,a)=>resolveStr(a).trim().replace(/\s+/g,' '));
    expr=expr.replace(/\bLEN\s*\(([^()]*)\)/gi,(_m,a)=>String(resolveStr(a).length));
    expr=expr.replace(/\bLEFT\s*\(([^()]*)\)/gi,(_m,args)=>{
      const pts=args.split(','); return resolveStr(pts[0]).slice(0,parseInt(pts[1]?.trim()??'1'));
    });
    expr=expr.replace(/\bRIGHT\s*\(([^()]*)\)/gi,(_m,args)=>{
      const pts=args.split(','); return resolveStr(pts[0]).slice(-parseInt(pts[1]?.trim()??'1'));
    });
    expr=expr.replace(/\bMID\s*\(([^()]*)\)/gi,(_m,args)=>{
      const pts=args.split(','); const s=resolveStr(pts[0]); const st=parseInt(pts[1]?.trim()??'1')-1; const ln=parseInt(pts[2]?.trim()??'1'); return s.slice(st,st+ln);
    });
    expr=expr.replace(/\bTEXT\s*\(([^()]*)\)/gi,(_m,args)=>{
      const pts=args.split(','); const n_=parseFloat(resolveStr(pts[0])); const fmt_=unquote(pts[1]?.trim()??'');
      if(isNaN(n_)) return resolveStr(pts[0]);
      const dec=(fmt_.match(/\.([0#]+)/)?.[1]?.length)??0;
      if(fmt_.includes('%')) return (n_*100).toFixed(dec)+'%';
      return n_.toFixed(dec);
    });
    expr=expr.replace(/\bCONCATENATE\s*\(([^()]*)\)/gi,(_m,args)=>args.split(',').map((s:string)=>resolveStr(s)).join(''));

    // ── & string concatenation: "A"&"B" or A1&B1 ─────────────────────────────
    // Replace "str"&... patterns before cell-ref expansion
    expr=expr.replace(/"([^"]*)"&"([^"]*)"/g,(_m,a_,b_)=>'"'+(a_+b_)+'"');

    // ── IF / IFERROR ──────────────────────────────────────────────────────────
    expr=expr.replace(/\bIF\s*\(([^()]+),([^()]+),([^()]*)\)/gi,(_m,cond,tv,fv)=>{
      try{
        const cc=cond.trim().replace(/([A-Z]+)(\d+)/gi,(_r:string,col:string,row:string)=>String(cellVal(+row-1,this.letterToCol(col))));
        if(!/^[\d.+\-*/()<>=!&|\s]+$/.test(cc)) return '#ERR';
        // eslint-disable-next-line no-new-func
        return Function('"use strict";return('+cc+')')() ? unquote(tv.trim()) : unquote((fv??'').trim());
      }catch{return '#ERR';}
    });
    expr=expr.replace(/\bIFERROR\s*\(([^()]+),([^()]*)\)/gi,(_m,val,errVal)=>{
      const v=val.trim(); return(v.startsWith('#')||v==='NaN'||v==='Infinity')?unquote(errVal.trim()):v;
    });

    // ── Range → comma-separated values ───────────────────────────────────────
    expr=expr.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/gi,(_m,c1,r1,c2,r2)=>{
      const cn1=this.letterToCol(c1),cn2=this.letterToCol(c2),rn1=+r1-1,rn2=+r2-1;
      const vals:number[]=[];
      for(let r=Math.min(rn1,rn2);r<=Math.max(rn1,rn2);r++)
        for(let c=Math.min(cn1,cn2);c<=Math.max(cn1,cn2);c++) vals.push(cellVal(r,c));
      return vals.join(',');
    });
    expr=expr.replace(/([A-Z]+)(\d+)/gi,(_m,col,row)=>String(cellVal(+row-1,this.letterToCol(col))));

    // ── AND / OR / NOT ────────────────────────────────────────────────────────
    expr=expr.replace(/\bAND\s*\(([^()]*)\)/gi,(_m,args)=>args.split(',').map((s:string)=>parseFloat(s.trim())).every((n:number)=>n!==0)?'1':'0');
    expr=expr.replace(/\bOR\s*\(([^()]*)\)/gi,(_m,args)=>args.split(',').map((s:string)=>parseFloat(s.trim())).some((n:number)=>n!==0)?'1':'0');
    expr=expr.replace(/\bNOT\s*\(([^()]*)\)/gi,(_m,a)=>parseFloat(a.trim())===0?'1':'0');

    const applyFn=(name:string,fn:(a:number[])=>number)=>{
      const re=new RegExp(`${name}\\s*\\(([^()]*)\\)`,'gi');
      let prev='';
      while(prev!==expr){prev=expr;expr=expr.replace(re,(_m,args)=>{
        const list=String(args).split(',').map((s:string)=>parseFloat(s.trim())).filter((n:number)=>!isNaN(n));
        return String(fn(list));
      });}
    };
    applyFn('SUM',a=>a.reduce((s,v)=>s+v,0));
    applyFn('AVERAGE',a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0);
    applyFn('AVG',a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0);
    applyFn('MIN',a=>a.length?Math.min(...a):0);
    applyFn('MAX',a=>a.length?Math.max(...a):0);
    applyFn('COUNT',a=>a.length);
    applyFn('ABS',a=>Math.abs(a[0]??0));
    applyFn('ROUND',a=>a[1]!=null?Math.round((a[0]??0)*Math.pow(10,a[1]))/Math.pow(10,a[1]):Math.round(a[0]??0));
    applyFn('SQRT',a=>Math.sqrt(a[0]??0));
    applyFn('POWER',a=>Math.pow(a[0]??0,a[1]??2));
    applyFn('MOD',a=>(a[1]!=null&&a[1]!==0)?a[0]%a[1]:0);
    applyFn('INT',a=>Math.floor(a[0]??0));
    applyFn('FLOOR',a=>a[1]?Math.floor((a[0]??0)/a[1])*a[1]:Math.floor(a[0]??0));
    applyFn('CEILING',a=>a[1]?Math.ceil((a[0]??0)/a[1])*a[1]:Math.ceil(a[0]??0));

    // Strip remaining string literals
    expr=expr.replace(/"[^"]*"/g,'0');

    if(!/^[\d+\-*/().\s,eE]+$/.test(expr)){
      // Return as string result (text functions produced it)
      return expr.startsWith('#')?expr:expr;
    }
    try{
      // eslint-disable-next-line no-new-func
      const val=Function('"use strict";return('+expr+')')();
      if(typeof val!=='number'||!isFinite(val)) return String(val??'');
      return String(Math.round(val*1e10)/1e10);
    }catch{return expr;}
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

  private aiDocsDelete(a: { docIds?: string[] | 'all'; names?: string[] }): AiActionResult {
    let targets: DocItem[] = [];
    if (a?.docIds === 'all') {
      targets = [...this.docs];
    } else if (Array.isArray(a?.docIds) && a.docIds.length > 0) {
      targets = this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    } else if (Array.isArray(a?.names) && a.names.length > 0) {
      const lows = a.names.map(n => n.trim().toLowerCase());
      targets = this.docs.filter(d => lows.some(l => d.title.trim().toLowerCase().includes(l)));
    }
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
