/**
 * DocsModule — единый редактор документов (Word + Excel).
 * До 20 документов в localStorage (FIFO при переполнении).
 * Excel: многолистовость, цвета ячеек, ширины/высоты из xlsx.
 */

import * as XLSX from 'xlsx';
import { type AiPageCapability, type AiActionResult } from '@/services/aiPageContext';
import { debug } from '@/utils/debug';
import { selectionCtx } from '@/services/selectionContext';

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

const STORAGE_KEY = 'docs_v1';
const RECENT_KEY  = 'docs_recent_v1';
const MAX_DOCS    = 20;
const MAX_RECENT  = 10;
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
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSheetIdx: number = 0;
  private xlVirtData: CellData[][] | null = null;
  private isFullscreen: boolean = false;
  private recent: Array<{id:string;title:string;type:DocType;updated_at:number;content?:string}> = [];
  private xlLastSel: { r1: number; c1: number; r2: number; c2: number; docId: string; sheetIdx: number } | null = null;
  private xlUndoStack: Array<{data: CellData[][], docId: string, sheetIdx: number, r: number, c: number}> = [];
  private xlRedoStack: Array<{data: CellData[][], docId: string, sheetIdx: number, r: number, c: number}> = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.load();
  }

  show(): void { this.root.style.display = ''; this.render(); }
  hide(): void { this.flushSave(); this.root.style.display = 'none'; }

  /** Создать новый документ из ассистента (кросс-страничное глобальное действие). */
  aiCreateDoc(type: DocType, title?: string): string {
    this.createDoc(type);
    if (title && this.activeId) {
      const doc = this.docs.find(d => d.id === this.activeId);
      if (doc) { doc.title = title.trim() || doc.title; this.save(); this.render(); }
    }
    return `Создан новый ${type === 'excel' ? 'Excel' : 'Word'}-документ${title ? ` «${title}»` : ''}.`;
  }

  // ── Storage ────────────────────────────────────────────────────────────────
  private load(): void {
    try { const raw = localStorage.getItem(STORAGE_KEY); this.docs = raw ? JSON.parse(raw) : []; }
    catch { this.docs = []; }
    try { const raw = localStorage.getItem(RECENT_KEY); this.recent = raw ? JSON.parse(raw) : []; }
    catch { this.recent = []; }
    if (!this.activeId && this.docs.length) this.activeId = this.docs[0].id;
  }

  private save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.docs)); }
    catch (e) { debug.warn('[DocsModule] save failed', e); }
  }

  private saveRecent(): void {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent)); }
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
    this.saveTimer = setTimeout(() => { this.save(); this.saveTimer = null; }, 500);
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
    if (!skipConfirm && !confirm(`Закрыть «${doc.title}»?\nДокумент будет удалён из редактора.`)) return;
    this.touchRecent(doc);
    this.docs.splice(idx, 1);
    if (this.activeId === id) { this.activeId = this.docs[0]?.id ?? null; this.activeSheetIdx = 0; }
    this.save();
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
        const sz = font.sz;
        if (sz && sz !== 11) parts.push(`font-size:${Math.round(sz * 1.33)}px`);
        const fname = font.name;
        if (fname && fname !== 'Calibri') parts.push(`font-family:"${fname}",sans-serif`);
        // Font color — skip near-black (invisible on dark bg)
        const hex = toHex(font.color?.rgb);
        if (hex) {
          const lum = 0.299 * parseInt(hex.slice(0,2),16) + 0.587 * parseInt(hex.slice(2,4),16) + 0.114 * parseInt(hex.slice(4,6),16);
          if (lum >= 60) parts.push(`color:#${hex}`);
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
            ],
            includeDefaultStyleMap: true,
          };
          const result = await mammoth.convertToHtml({ arrayBuffer: buf }, opts);
          this.addDoc({ id: this.newId(), type: 'word', title: bare, content: result.value, updated_at: now });
        } catch (err) {
          alert('Не удалось прочитать .docx: ' + (err as Error).message);
        }
        return;
      }

      if (ext === 'doc') {
        try {
          const buf = await file.arrayBuffer();
          const text = await this.docxToText(buf);
          this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.esc(text).replace(/\n/g, '<br>'), updated_at: now });
        } catch {
          alert('Формат .doc не поддерживается. Пересохрани как .docx или .html.');
        }
        return;
      }

      alert(`Неизвестный формат: .${ext}\nПоддерживаются: xlsx, xls, csv, html, txt, docx`);
    } catch (e) {
      debug.warn('[DocsModule] import failed', e);
      alert('Ошибка при импорте: ' + (e as Error).message);
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
        const wb = XLSX.utils.book_new();
        ec.sheets.forEach(sh => {
          const values = this.trimEmpty(sh.data).map(r => r.map(c => c.v));
          const ws = XLSX.utils.aoa_to_sheet(values);
          XLSX.utils.book_append_sheet(wb, ws, sh.name);
        });
        XLSX.writeFile(wb, `${doc.title}.xlsx`);
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
    return `<div class="docs-word-toolbar">
      <button class="dw-tool" data-cmd="undo" title="Отменить (Ctrl+Z)">↶</button>
      <button class="dw-tool" data-cmd="redo" title="Повторить (Ctrl+Y)">↷</button>
      <div class="dw-sep"></div>
      <select class="dw-select" data-block-sel title="Стиль">
        <option value="p">Обычный</option><option value="h1">Заголовок 1</option>
        <option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option>
        <option value="blockquote">Цитата</option><option value="pre">Код</option>
      </select>
      <select class="dw-select" data-size-sel title="Размер">
        <option value="">Размер</option><option value="1">Мелкий</option>
        <option value="3">Обычный</option><option value="5">Крупный</option><option value="7">Очень крупный</option>
      </select>
      <div class="dw-sep"></div>
      <button class="dw-tool" data-cmd="bold" title="Жирный"><b>B</b></button>
      <button class="dw-tool" data-cmd="italic" title="Курсив"><i>I</i></button>
      <button class="dw-tool" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
      <button class="dw-tool" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>
      <label class="dw-color" title="Цвет текста"><span>A</span><input type="color" data-color></label>
      <label class="dw-color dw-hi" title="Заливка"><span>H</span><input type="color" data-hilite></label>
      <div class="dw-sep"></div>
      <button class="dw-tool" data-cmd="justifyLeft" title="По левому краю">⇤</button>
      <button class="dw-tool" data-cmd="justifyCenter" title="По центру">≡</button>
      <button class="dw-tool" data-cmd="justifyRight" title="По правому краю">⇥</button>
      <div class="dw-sep"></div>
      <button class="dw-tool" data-cmd="insertUnorderedList" title="Маркированный список">•</button>
      <button class="dw-tool" data-cmd="insertOrderedList" title="Нумерованный список">1.</button>
      <button class="dw-tool" data-cmd="outdent" title="Уменьшить отступ">⇤|</button>
      <button class="dw-tool" data-cmd="indent" title="Увеличить отступ">|⇥</button>
      <div class="dw-sep"></div>
      <button class="dw-tool" data-link title="Ссылка">🔗</button>
      <button class="dw-tool" data-cmd="removeFormat" title="Убрать форматирование">✕</button>
    </div>
    <div class="docs-word-scroll">
      <div class="docs-word-editor" id="docs-word-editor" contenteditable="true" spellcheck="true" data-placeholder="Начните печатать…">${doc.content || ''}</div>
    </div>`;
  }

  private bindWord(doc: DocItem): void {
    const editor = this.root.querySelector<HTMLElement>('#docs-word-editor');
    if (!editor) return;
    const commit = () => this.updateContent(doc.id, editor.innerHTML);
    editor.addEventListener('input', commit);
    this.root.querySelectorAll<HTMLButtonElement>('.dw-tool').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        editor.focus();
        const cmd = btn.dataset.cmd;
        if (cmd) document.execCommand(cmd, false);
        else if (btn.dataset.link !== undefined) {
          const url = prompt('URL ссылки:', 'https://');
          if (url) document.execCommand('createLink', false, url);
        }
        commit();
      });
    });
    const blockSel = this.root.querySelector<HTMLSelectElement>('[data-block-sel]');
    blockSel?.addEventListener('change', () => { editor.focus(); if (blockSel.value) document.execCommand('formatBlock', false, blockSel.value); blockSel.value=''; commit(); });
    const sizeSel = this.root.querySelector<HTMLSelectElement>('[data-size-sel]');
    sizeSel?.addEventListener('change', () => { editor.focus(); if (sizeSel.value) document.execCommand('fontSize', false, sizeSel.value); sizeSel.value=''; commit(); });
    this.root.querySelector<HTMLInputElement>('[data-color]')?.addEventListener('input', e => { editor.focus(); document.execCommand('foreColor', false, (e.target as HTMLInputElement).value); commit(); });
    this.root.querySelector<HTMLInputElement>('[data-hilite]')?.addEventListener('input', e => { editor.focus(); const v=(e.target as HTMLInputElement).value; document.execCommand('hiliteColor',false,v)||document.execCommand('backColor',false,v); commit(); });
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
        <button class="dx-btn" data-xf-cmd="undo" title="Отменить (Ctrl+Z)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>
        </button>
        <button class="dx-btn" data-xf-cmd="redo" title="Повторить (Ctrl+Y)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7l3 2.7"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <select class="dx-sel" data-xf-font title="Шрифт">
          <option value="">Шрифт</option>
          <option value="'DM Sans',sans-serif">DM Sans</option><option value="Arial,sans-serif">Arial</option>
          <option value="Helvetica,sans-serif">Helvetica</option><option value="'Times New Roman',serif">Times New Roman</option>
          <option value="Georgia,serif">Georgia</option><option value="'Courier New',monospace">Courier New</option>
          <option value="Calibri,sans-serif">Calibri</option><option value="Cambria,serif">Cambria</option>
          <option value="Verdana,sans-serif">Verdana</option><option value="Tahoma,sans-serif">Tahoma</option>
        </select>
        <select class="dx-sel dx-sel-sm" data-xf-size title="Размер шрифта">
          <option value="">Размер</option>
          <option value="10px">10</option><option value="11px">11</option><option value="12px">12</option>
          <option value="13px">13</option><option value="14px">14</option><option value="16px">16</option>
          <option value="18px">18</option><option value="20px">20</option><option value="24px">24</option>
        </select>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xf="bold" title="Жирный (Ctrl/⌘+B)"><b>B</b></button>
        <button class="dx-btn" data-xf="italic" title="Курсив (Ctrl/⌘+I)"><i>I</i></button>
        <button class="dx-btn" data-xf="underline" title="Подчёркнутый (Ctrl/⌘+U)"><u>U</u></button>
        <button class="dx-btn" data-xf="strike" title="Зачёркнутый"><s>S</s></button>
        <label class="dx-btn dx-color" title="Цвет текста"><span>A</span><input type="color" data-xf-color></label>
        <label class="dx-btn dx-color dx-color-bg" title="Заливка ячейки"><span>▉</span><input type="color" data-xf-bg></label>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa-align="left" title="По левому краю">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
        </button>
        <button class="dx-btn" data-xa-align="center" title="По центру">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>
        </button>
        <button class="dx-btn" data-xa-align="right" title="По правому краю">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <select class="dx-sel dx-sel-sm" data-xf-border title="Границы">
          <option value="">Границы</option><option value="all">Все</option><option value="outer">По периметру</option>
          <option value="top">Сверху</option><option value="bottom">Снизу</option>
          <option value="left">Слева</option><option value="right">Справа</option><option value="none">Убрать</option>
        </select>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xf-num="general" title="Общий">Общий</button>
        <button class="dx-btn" data-xf-num="number" title="Числовой">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>
        </button>
        <button class="dx-btn" data-xf-num="currency" title="Денежный (₽)">₽</button>
        <button class="dx-btn" data-xf-num="percent" title="Процент (%)">%</button>
        <button class="dx-btn" data-xf-num="date" title="Дата">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa="sort-asc" title="Сортировать А→Я">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 12h9M3 18h5M17 8l4-4 4 4M21 4v16"/></svg>
        </button>
        <button class="dx-btn" data-xa="sort-desc" title="Сортировать Я→А">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h5M3 12h9M3 18h13M17 16l4 4 4-4M21 4v16"/></svg>
        </button>
      </div>
      <div class="dx-sep"></div>
      <div class="dx-group">
        <button class="dx-btn" data-xa="find" title="Найти / Заменить (Ctrl/⌘+F)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button class="dx-btn dx-danger" data-xa="clear" title="Очистить таблицу">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
      <div class="docs-excel-status" id="docs-xl-status">A1</div>
    </div>
    <div class="docs-formula-bar">
      <div class="dx-cell-ref" id="docs-cell-ref">A1</div>
      <div class="dx-fx-btn" title="Функции">fx</div>
      <input class="dx-formula-inp" id="docs-formula-inp" type="text" placeholder="Введите значение или формулу (=SUM(A1:A5))">
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
    const syncDomToData = () => {
      if (!vd) return;
      body.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach(tr => {
        const r = +(tr.dataset.row!);
        if (isNaN(r) || r < 0 || r >= vd.length) return;
        tr.querySelectorAll<HTMLTableCellElement>('td[data-r]').forEach(td => {
          const c = +(td.dataset.c!);
          if (isNaN(c) || c < 0 || c >= vd[r].length) return;
          const v = td.dataset.formula ?? td.innerText;
          const s = td.style.cssText.trim() || undefined;
          vd[r][c] = s ? { v, s } : { v };
        });
      });
    };

    const grid = (): CellData[][] => {
      if (vd) { syncDomToData(); return vd; }
      const rows: CellData[][] = [];
      body.querySelectorAll<HTMLTableRowElement>('tr').forEach(tr => {
        const row: CellData[] = [];
        tr.querySelectorAll<HTMLTableCellElement>('td').forEach(td => {
          const v = td.dataset.formula ?? td.innerText;
          const s = td.style.cssText.trim() || undefined;
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
      applySel(); syncFormulaBar();
      body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    };

    // Sheet tab switching
    this.root.querySelectorAll<HTMLElement>('.dx-sheet-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        commit();
        this.activeSheetIdx = +(tab.dataset.sheetIdx ?? '0');
        this.render();
      });
    });

    const clearSel = () => {
      body.querySelectorAll('td.dx-selected').forEach(td => td.classList.remove('dx-selected'));
      this.root.querySelectorAll('th.dx-hdr-selected').forEach(th => th.classList.remove('dx-hdr-selected'));
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
      if (isFullRow) for (let r = r1; r <= r2; r++) this.root.querySelector(`th.dx-rowhdr[data-row-hdr="${r}"]`)?.classList.add('dx-hdr-selected');
      if (isFullCol) for (let c = c1; c <= c2; c++) this.root.querySelector(`th.dx-colhdr[data-col="${c}"]`)?.classList.add('dx-hdr-selected');
      updateStats(r1, c1, r2, c2);
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
    const syncFormulaBar = () => {
      const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR}"][data-c="${curC}"]`);
      if (cellRef) cellRef.textContent = `${this.colLetter(curC)}${curR+1}`;
      if (formulaBar) formulaBar.value = td?.dataset.formula ?? td?.innerText ?? '';
    };

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

      if (isMod(e) && e.key === 'f') { e.preventDefault(); (this as any)._openFindPanel?.(); return; }
      if (isMod(e) && e.key === 'h') { e.preventDefault(); (this as any)._openFindPanel?.(); return; }
      if (isMod(e) && e.key === 'z') { e.preventDefault(); doUndo(); return; }
      if (isMod(e) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); doRedo(); return; }
      if (isMod(e)) {
        if (e.key === 'b' || e.key === 'B') { e.preventDefault(); selectedCells().forEach(c => { c.style.fontWeight = c.style.fontWeight === 'bold' ? '' : 'bold'; }); saveGrid(grid()); return; }
        if (e.key === 'i' || e.key === 'I') { e.preventDefault(); selectedCells().forEach(c => { c.style.fontStyle = c.style.fontStyle === 'italic' ? '' : 'italic'; }); saveGrid(grid()); return; }
        if (e.key === 'u' || e.key === 'U') { e.preventDefault(); selectedCells().forEach(c => { c.style.textDecoration = c.style.textDecoration.includes('underline') ? '' : 'underline'; }); saveGrid(grid()); return; }
        return;
      }

      switch (e.key) {
        case 'ArrowUp':    e.preventDefault(); navigateTo(curR - 1, curC, e.shiftKey); return;
        case 'ArrowDown':  e.preventDefault(); navigateTo(curR + 1, curC, e.shiftKey); return;
        case 'ArrowLeft':  e.preventDefault(); navigateTo(curR, curC - 1, e.shiftKey); return;
        case 'ArrowRight': e.preventDefault(); navigateTo(curR, curC + 1, e.shiftKey); return;
        case 'Tab':    e.preventDefault(); navigateTo(curR, curC + (e.shiftKey ? -1 : 1)); return;
        case 'Enter':
        case 'F2':     e.preventDefault(); enterEdit(curR, curC); return;
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          pushUndo();
          const r1 = Math.min(selStart.r, selEnd?.r ?? curR), r2 = Math.max(selStart.r, selEnd?.r ?? curR);
          const c1 = Math.min(selStart.c, selEnd?.c ?? curC), c2 = Math.max(selStart.c, selEnd?.c ?? curC);
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
            const td = body.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`);
            if (td) { td.innerText = ''; delete td.dataset.formula; }
          }
          saveGrid(grid()); return;
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
      if (editMode) return; // let browser handle paste inside edit cell
      const active = document.activeElement as HTMLElement | null;
      if (active && !this.root.contains(active) && active !== document.body) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text || !text.includes('\t')) return;
      e.preventDefault();
      pushUndo();
      text.split(/\r?\n/).forEach((line, dr) => {
        line.split('\t').forEach((val, dc) => {
          const cell = body.querySelector<HTMLTableCellElement>(`td[data-r="${curR + dr}"][data-c="${curC + dc}"]`);
          if (cell) cell.innerText = val;
        });
      });
      saveGrid(grid());
    };
    document.addEventListener('paste', onPaste);
    (this as any)._xlPasteHandler?.();
    (this as any)._xlPasteHandler = () => document.removeEventListener('paste', onPaste);

    // Column resize
    this.root.querySelectorAll<HTMLElement>('.dx-col-resize').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const colIdx=+handle.dataset.colR!;
        const th=handle.parentElement as HTMLElement;
        const startX=e.clientX, startW=th.offsetWidth;
        handle.classList.add('active');
        const onMove=(ev: MouseEvent)=>{
          const w=Math.max(40,startW+(ev.clientX-startX));
          th.style.minWidth=th.style.width=w+'px';
          this.root.querySelectorAll<HTMLElement>(`td[data-c="${colIdx}"]`).forEach(td=>{td.style.minWidth=td.style.width=w+'px';});
        };
        const onUp=()=>{handle.classList.remove('active');document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
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
        commit();
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-xf-cmd]').forEach(btn => {
      btn.addEventListener('mousedown',e=>e.preventDefault());
      btn.addEventListener('click',()=>{document.execCommand(btn.dataset.xfCmd!);commit();});
    });

    this.root.querySelector<HTMLSelectElement>('[data-xf-font]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement;
      if(sel.value) selectedCells().forEach(c=>c.style.fontFamily=sel.value);
      sel.value=''; commit();
    });
    this.root.querySelector<HTMLSelectElement>('[data-xf-size]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement;
      if(sel.value) selectedCells().forEach(c=>c.style.fontSize=sel.value);
      sel.value=''; commit();
    });
    this.root.querySelector<HTMLInputElement>('[data-xf-color]')?.addEventListener('input',e=>{
      selectedCells().forEach(c=>c.style.color=(e.target as HTMLInputElement).value); commit();
    });
    this.root.querySelector<HTMLInputElement>('[data-xf-bg]')?.addEventListener('input',e=>{
      selectedCells().forEach(c=>c.style.background=(e.target as HTMLInputElement).value); commit();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-xa-align]').forEach(btn=>{
      btn.addEventListener('click',()=>{selectedCells().forEach(c=>c.style.textAlign=btn.dataset.xaAlign!);commit();});
    });
    this.root.querySelector<HTMLSelectElement>('[data-xf-border]')?.addEventListener('change',e=>{
      const sel=e.target as HTMLSelectElement; if(!sel.value) return;
      const bd='2px solid #333';
      selectedCells().forEach(c=>{
        if(sel.value==='all'||sel.value==='outer') c.style.border=bd;
        else if(sel.value==='top') c.style.borderTop=bd;
        else if(sel.value==='bottom') c.style.borderBottom=bd;
        else if(sel.value==='left') c.style.borderLeft=bd;
        else if(sel.value==='right') c.style.borderRight=bd;
        else if(sel.value==='none') c.style.border='';
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
      btn.addEventListener('click',()=>{
        const act=btn.dataset.xa!, rows=grid();
        if(act==='clear'){
          if(confirm('Очистить текущий лист?')){saveGrid(rows.map(r=>r.map(()=>({v:''} as CellData))));this.render();}
          return;
        }
        if(act==='find'){(this as any)._openFindPanel?.();return;}
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
      });
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
          const onUp=()=>{handle.classList.remove('active');document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
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
        const wrapEl = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
        if (wrapEl) {
          const rowTop = r * XL_VX_ROW_H;
          const rowBot = rowTop + XL_VX_ROW_H;
          const { scrollTop, clientHeight } = wrapEl;
          if (rowTop < scrollTop + 40 || rowBot > scrollTop + clientHeight - 40) {
            wrapEl.scrollTop = Math.max(0, rowTop - clientHeight / 2);
          }
        }
        // After potential re-render, try to highlight the DOM row
        requestAnimationFrame(() => {
          const tr = body.querySelector<HTMLElement>(`tr[data-row="${r}"]`);
          if (tr) {
            tr.scrollIntoView({ block: 'nearest' });
            tr.classList.add('dx-row-cur');
          }
        });
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
      const wrap = this.root.querySelector<HTMLElement>('#docs-excel-wrap');
      const sheet = this.parseExcelContent(doc.content).sheets[this.activeSheetIdx];
      const vColW = sheet.colWidths ?? [];
      const vRowH = sheet.rowHeights ?? [];
      const vCols = vd[0]?.length ?? 1;
      let lastStart = 0;
      const updateWindow = (startR: number) => {
        lastStart = startR;
        const endR = Math.min(vd.length, startR + XL_VX_PAGE + 2 * XL_VX_BUF);
        const topH = startR * XL_VX_ROW_H;
        const botH = Math.max(0, vd.length - endR) * XL_VX_ROW_H;
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
      wrap?.addEventListener('scroll', () => {
        const newStart = Math.max(0, Math.floor(wrap.scrollTop / XL_VX_ROW_H) - XL_VX_BUF);
        if (Math.abs(newStart - lastStart) < XL_VX_BUF) return;
        syncDomToData();
        updateWindow(newStart);
        applySel();
      });
    }
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
        this.flushSave(); this.activeId=id; this.activeSheetIdx=0; this.render();
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
    const allDocsInfo = this.docs.length > 1
      ? `\n\n📂 Все открытые документы (${this.docs.length}):\n` +
        this.docs.map((d, i) => `  ${i+1}. id="${d.id}" «${d.title}» [${d.type}]`).join('\n') +
        '\n\nДля операций по нескольким документам используй действия multi_replace/multi_count с параметром docIds.'
      : '';
    const doc = this.aiDoc();
    if (!doc) return 'Нет открытого документа. Пользователь может создать Word или Excel.' + allDocsInfo;
    if (doc.type === 'word') {
      const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      return `Открыт Word-документ «${doc.title}». Текста ~${text.length} симв.\nНачало: "${text.slice(0, 400)}"`;
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
    return `Открыта таблица «${docRef.title}», лист «${sheet.name}» (всего листов: ${ec.sheets.length}).
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
    return {
      page: 'docs',
      title: 'Редактор',
      describe: () => this.aiDescribe(),
      suggestions: [
        { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
        { label: '✨ Улучшить дизайн', prompt: 'Улучши дизайн текущей таблицы' },
        { label: '🔎 Что в таблице?', prompt: 'Проанализируй открытую таблицу: что за данные, какие колонки' },
        { label: '🔁 Замена', prompt: 'Помоги заменить текст в таблице' },
      ],
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
          description: 'Заменить текст в открытом Word-документе.',
          args: '{ find: string, replaceWith: string, caseSensitive?: boolean }',
          run: (a) => this.aiWordReplace(a),
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
  private evalFormula(formula: string, rows: CellData[][], _depth = 0): string {
    if(_depth>20) return '#REC';
    if(!formula.startsWith('=')) return formula;
    let expr=formula.slice(1);

    const cellVal=(r:number,c:number):number=>{
      const cell=rows[r]?.[c]; const raw=cell?.v??'';
      if(raw.startsWith('=')){const n=parseFloat(this.evalFormula(raw,rows,_depth+1));return isNaN(n)?0:n;}
      const n=parseFloat(String(raw).replace(',','.')); return isNaN(n)?0:n;
    };

    expr=expr.replace(/\bIF\s*\(([^()]+),([^()]+),([^()]*)\)/gi,(_m,cond,tv,fv)=>{
      try{
        const cc=cond.trim().replace(/([A-Z]+)(\d+)/gi,(_r:string,col:string,row:string)=>String(cellVal(+row-1,this.letterToCol(col))));
        // Whitelist: only numbers, comparison/logical/arithmetic operators and parens
        if(!/^[\d.+\-*/()<>=!&|\s]+$/.test(cc)) return '#ERR';
        // eslint-disable-next-line no-new-func
        return Function('"use strict";return('+cc+')')() ? tv.trim() : (fv??'').trim();
      }catch{return '#ERR';}
    });
    expr=expr.replace(/\bIFERROR\s*\(([^()]+),([^()]*)\)/gi,(_m,val,errVal)=>{
      const v=val.trim(); return(v.startsWith('#')||v==='NaN'||v==='Infinity')?errVal.trim():v;
    });
    expr=expr.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/gi,(_m,c1,r1,c2,r2)=>{
      const cn1=this.letterToCol(c1),cn2=this.letterToCol(c2),rn1=+r1-1,rn2=+r2-1;
      const vals:number[]=[];
      for(let r=Math.min(rn1,rn2);r<=Math.max(rn1,rn2);r++)
        for(let c=Math.min(cn1,cn2);c<=Math.max(cn1,cn2);c++) vals.push(cellVal(r,c));
      return vals.join(',');
    });
    expr=expr.replace(/([A-Z]+)(\d+)/gi,(_m,col,row)=>String(cellVal(+row-1,this.letterToCol(col))));

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
    applyFn('ROUND',a=>Math.round(a[0]??0));
    applyFn('SQRT',a=>Math.sqrt(a[0]??0));
    applyFn('POWER',a=>Math.pow(a[0]??0,a[1]??2));
    applyFn('MOD',a=>(a[1]!=null&&a[1]!==0)?a[0]%a[1]:0);
    applyFn('INT',a=>Math.floor(a[0]??0));

    if(!/^[\d+\-*/().\s,eE]+$/.test(expr)) return '#ERR';
    try{
      // eslint-disable-next-line no-new-func
      const val=Function('"use strict";return('+expr+')')();
      if(typeof val!=='number'||!isFinite(val)) return '#ERR';
      return String(Math.round(val*1e10)/1e10);
    }catch{return '#ERR';}
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

  private escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  private esc(s: string): string {
    return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]!));
  }
}
