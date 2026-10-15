/**
 * Табличный редактор — интерфейс в духе Excel поверх модели книги.
 *
 * Устройство:
 *  • Модель (ExcelContent) — единственный источник правды. Любое действие
 *    меняет модель и перерисовывает видимое окно; из DOM ничего обратно
 *    не читается (раньше таблица собиралась из <td>, и всё, чего не было
 *    в видимой части, терялось).
 *  • Рисуется только окно строк вокруг прокрутки плюс закреплённые строки,
 *    поэтому лист на десятки тысяч строк открывается мгновенно.
 *  • Ввод — во всплывающем поле над ячейкой, как в Excel: стиль ячейки при
 *    правке не ломается, формулы можно набирать кликом по ячейкам.
 */

import { validationIndexFor } from './validation';
import {
  type CellData, type ChartKind, type ChartSpec, type ExcelContent, type FloatImage, type MergeRange, type SheetData,
  colLetter, letterToCol, parseRangeRef, rangeToRef, ensureSize, emptyCell, uid, XL_DEF_COL_PX, XL_DEF_ROW_PX,
} from './model';
import { renderCss, hasHAlign, editCss, cssToX, type XStyle, type BorderStyle } from './xlStyle';
import {
  shiftSheet, mergeRange, unmergeRange, mergesIn, expandToMerges, copyBlock, pasteBlock, parseTsv, blockToTsv,
  clearRange, sortRows, currentRegion, looksLikeHeader, fillSeries, nextSheetName, uniqueSheetName, renameSheet,
  cloneSheet, type ClipBlock, type PasteMode,
} from './sheetOps';
import { renderChartSvg, CHART_COLORS, type ChartData } from './charts';
import { showMenu, showColorPicker, showDialog, askText, closeMenus, esc, IC, type MenuItem } from './ui';
import {
  formatCellValue, parseUserNumber, isDateFormat, dateToSerial, generalNumber, PRESET_FORMATS,
} from '@/utils/numFormat';
import { FUNCTION_NAMES, isErr, offsetFormula, type Evaluator, type Scalar } from '@/utils/formula';
import { isSafeImageSrc } from '@/utils/docImage';

export interface SheetHost {
  docId(): string;
  docTitle(): string;
  book(): ExcelContent;
  sheetIdx(): number;
  setSheetIdx(i: number): void;
  /** Снимок для отмены — вызывается ДО изменения модели. */
  beginChange(): void;
  /** Сохранить модель после изменения. */
  commit(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  evaluator(sheetIdx: number): Evaluator;
  publishSelection(sheetIdx: number, rg: MergeRange, label: string, prompt: string): void;
  prepareImage(src: string, maxW: number): Promise<{ dataUrl: string; w?: number; h?: number }>;
  fileToDataUrl(f: File): Promise<string>;
  toast(msg: string, kind?: 'info' | 'error' | 'success'): void;
}

const HDR_H = 22;
const BUF_ROWS = 30;
const DEF_FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Segoe UI', 'Courier New', 'Consolas', 'Trebuchet MS', 'Garamond', 'Century Gothic', 'Roboto', 'Open Sans', 'PT Sans', 'PT Serif'];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Буфер обмена общий для всех таблиц: копировать можно между документами. */
let CLIP: { block: ClipBlock; text: string; cut?: { docId: string; sheet: number; rg: MergeRange } } | null = null;

/**
 * Разобрать ввод пользователя как это делает Excel: числа, проценты,
 * деньги, даты, логические; «'» в начале — принудительно текст.
 */
export function interpretInput(text: string, prev: CellData | undefined): CellData {
  const keep: CellData = { v: '' };
  if (prev?.s) keep.s = prev.s;
  if (prev?.link) keep.link = prev.link;
  if (prev?.note) keep.note = prev.note;
  if (prev?.img) { keep.img = prev.img; if (prev.imgW) keep.imgW = prev.imgW; if (prev.imgH) keep.imgH = prev.imgH; }
  const prevNf = prev?.nf;
  const t = text.replace(/\r/g, '');
  if (!t.trim()) return { ...keep, ...(prevNf ? { nf: prevNf } : {}) };

  if (t.startsWith("'")) return { ...keep, v: t.slice(1) };
  if (t.startsWith('=') && t.length > 1) return { ...keep, v: t, ...(prevNf ? { nf: prevNf } : {}) };
  if (prevNf === '@') return { ...keep, v: t, nf: '@' };

  const s = t.trim();
  if (/^(истина|true)$/i.test(s)) return { ...keep, v: 'ИСТИНА', t: 'b' };
  if (/^(ложь|false)$/i.test(s)) return { ...keep, v: 'ЛОЖЬ', t: 'b' };

  // Дата: 15.01.2026, 15/01/26, 2026-01-15, 15.01 (текущий год); с временем
  const dm = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if ((dm && (dm[3] || s.includes('.'))) || iso) {
    const y = iso ? +iso[1] : dm![3] ? (+dm![3] < 100 ? 2000 + +dm![3] : +dm![3]) : new Date().getFullYear();
    const mo = iso ? +iso[2] : +dm![2];
    const d = iso ? +iso[3] : +dm![1];
    const hh = +(iso ? iso[4] : dm![4]) || 0, mi = +(iso ? iso[5] : dm![5]) || 0, ss = +(iso ? iso[6] : dm![6]) || 0;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
      if (dt.getUTCDate() === d) {
        const hasTime = !!(iso ? iso[4] : dm![4]);
        const nf = prevNf && isDateFormat(prevNf) ? prevNf : hasTime ? 'dd.mm.yyyy hh:mm' : 'dd.mm.yyyy';
        return { ...keep, v: String(dateToSerial(dt)), t: 'n', nf };
      }
    }
  }
  // Время: 9:30, 18:05:10
  const tm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (tm && +tm[1] < 24 && +tm[2] < 60) {
    const v = (+tm[1] * 3600 + +tm[2] * 60 + (+tm[3] || 0)) / 86400;
    return { ...keep, v: String(v), t: 'n', nf: prevNf && isDateFormat(prevNf) ? prevNf : tm[3] ? 'hh:mm:ss' : 'hh:mm' };
  }

  const n = parseUserNumber(s);
  if (n !== null) {
    const out: CellData = { ...keep, v: String(n), t: 'n' };
    if (s.endsWith('%')) out.nf = prevNf && prevNf.includes('%') ? prevNf : (/[.,]\d/.test(s) ? '0.00%' : '0%');
    else if (/₽|руб/i.test(s)) out.nf = prevNf && /₽/.test(prevNf) ? prevNf : '#,##0.00\\ "₽"';
    else if (/^\$/.test(s)) out.nf = '"$"#,##0.00';
    else if (/€/.test(s)) out.nf = '#,##0.00\\ "€"';
    else if (prevNf && !isDateFormat(prevNf)) out.nf = prevNf;
    else if (/\d\s\d{3}/.test(s)) out.nf = /[.,]\d+$/.test(s) ? '#,##0.00' : '#,##0';
    return out;
  }
  return { ...keep, v: t };
}

/** Текст для поля правки: формула как есть, число — по-русски, дата — датой. */
export function editText(cell: CellData | undefined): string {
  if (!cell) return '';
  const v = cell.v ?? '';
  if (!v || v.startsWith('=')) return v;
  if (cell.t === 'n') {
    const n = Number(v);
    if (!isFinite(n)) return v;
    if (cell.nf && isDateFormat(cell.nf)) {
      const hasDate = /[dy]/i.test(cell.nf.replace(/"[^"]*"/g, ''));
      const hasTime = /h|s/i.test(cell.nf.replace(/"[^"]*"/g, ''));
      return formatCellValue(v, 'n', hasDate && hasTime ? 'dd.mm.yyyy hh:mm:ss' : hasDate ? 'dd.mm.yyyy' : 'hh:mm:ss');
    }
    if (cell.nf && cell.nf.includes('%')) return generalNumber(n * 100) + '%';
    return generalNumber(n);
  }
  if (cell.t === 'b') return v;
  return v;
}

/** Значение вычислителя → текст для показа (без числового формата). */
function scalarText(v: Scalar): string {
  if (isErr(v)) return v.err;
  if (typeof v === 'boolean') return v ? 'ИСТИНА' : 'ЛОЖЬ';
  if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10);
  return v;
}

interface EditState {
  r: number; c: number;
  ta: HTMLTextAreaElement;
  orig: string;
  /** enter — начали набирать поверх: стрелки завершают ввод; edit — F2/двойной клик. */
  mode: 'enter' | 'edit';
  viaBar: boolean;
  /** Лист, на котором начата правка (при наборе формулы можно уйти на другой). */
  sheet: number;
}

export class SheetEditor {
  private host: SheetHost;
  private root: HTMLElement;
  private sel: MergeRange = { r1: 0, c1: 0, r2: 0, c2: 0 };
  private cur = { r: 0, c: 0 };
  private anchor = { r: 0, c: 0 };
  private edit: EditState | null = null;
  private dispRows = 100;
  private dispCols = 26;
  private rowTop: number[] = [0];
  private colLeft: number[] = [0];
  private rowHdrW = 46;
  private winStart = 0;
  private winEnd = 0;
  private zoom = 1;
  private showFormulas = false;
  private painter: { block: ClipBlock; sticky: boolean } | null = null;
  private selObj: { kind: 'chart' | 'image'; id: string } | null = null;
  private ribbonTab = 'home';
  private tdMap = new Map<string, HTMLTableCellElement>();
  private disposers: Array<() => void> = [];
  private cutMarquee = false;
  private hiddenFilterRows = new Set<number>();
  /** Последняя применённая заливка/цвет — кнопка повторяет их, как в Excel. */
  private lastFill = '#ffff00';
  private lastColor = '#ff0000';

  // DOM
  private elRibbon!: HTMLElement;
  private elName!: HTMLInputElement;
  private elFx!: HTMLTextAreaElement;
  private elScroll!: HTMLElement;
  private elZoom!: HTMLElement;
  private elTable!: HTMLTableElement;
  private elCols!: HTMLElement;
  private elHead!: HTMLElement;
  private elBody!: HTMLElement;
  private elLayer!: HTMLElement;
  private elTabs!: HTMLElement;
  private elStatus!: HTMLElement;
  private elFill: HTMLElement | null = null;
  /** Невидимое поле, которое держит фокус: в него приходит ввод с клавиатуры, IME и диктовки. */
  private elSink!: HTMLTextAreaElement;

  constructor(host: SheetHost, root: HTMLElement, opts: { selection?: MergeRange } = {}) {
    this.host = host;
    this.root = root;
    if (opts.selection) {
      this.sel = { ...opts.selection };
      this.cur = { r: opts.selection.r1, c: opts.selection.c1 };
      this.anchor = { ...this.cur };
    }
    this.mount();
  }

  // ═══════════════════════════ Доступ к модели ═══════════════════════════

  /** Вернуть фокус сетке (невидимому полю у активной ячейки). */
  focusGrid(): void {
    if (!this.elSink) return;
    const td = this.findTdCovering(this.cur.r, this.cur.c);
    if (td) { const rc = this.tdRect(td); this.elSink.style.left = rc.x + 'px'; this.elSink.style.top = rc.y + 'px'; }
    this.elSink.focus({ preventScroll: true });
  }

  private book(): ExcelContent { return this.host.book(); }
  private si(): number { return Math.min(this.host.sheetIdx(), this.book().sheets.length - 1); }
  private sheet(): SheetData { return this.book().sheets[this.si()]; }
  private cell(r: number, c: number): CellData | undefined { return this.sheet().data[r]?.[c]; }

  /** Изменить модель с отменой и сохранением. */
  private change(fn: () => void, opts: { full?: boolean } = {}): void {
    this.host.beginChange();
    fn();
    this.host.commit();
    if (opts.full) this.renderAll(); else this.renderGrid();
  }

  private selRange(): MergeRange { return { ...this.sel }; }

  get selection(): MergeRange { return this.selRange(); }

  /** Перерисовать после внешнего изменения книги (ассистент, отмена). */
  refresh(): void {
    const sh = this.sheet();
    if (!sh) return;
    this.renderAll();
  }

  destroy(): void {
    this.cancelEdit();
    this.disposers.forEach(d => d());
    this.disposers = [];
    closeMenus();
    this.elFill?.remove();
  }

  // ═══════════════════════════ Каркас ═══════════════════════════

  private mount(): void {
    this.root.innerHTML = `
      <div class="xl-app">
        <div class="xl-ribbon" data-ribbon></div>
        <div class="xl-fbar">
          <input class="xl-name" data-name spellcheck="false" title="Имя: адрес ячейки или диапазона. Введите A1, B2:D9 или Лист!A1 и нажмите Enter">
          <div class="xl-fbar-btns">
            <button class="xl-fx" data-fxbtn title="Вставить функцию (Shift+F3)">${IC.fx}</button>
          </div>
          <textarea class="xl-fx-inp" data-fx rows="1" spellcheck="false" placeholder="Значение или формула: =СУММ(A1:A5)"></textarea>
        </div>
        <div class="xl-scroll" data-scroll tabindex="0">
          <div class="xl-zoom" data-zoom>
            <table class="xl-grid" data-table><colgroup data-cols></colgroup><thead data-head></thead><tbody data-body></tbody></table>
            <div class="xl-layer" data-layer><textarea class="xl-sink" data-sink tabindex="-1" aria-label="Ввод в ячейку" autocomplete="off" spellcheck="false"></textarea></div>
          </div>
        </div>
        <div class="xl-bottom">
          <div class="xl-tabs" data-tabs></div>
          <div class="xl-status" data-status></div>
        </div>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s)!;
    this.elRibbon = q('[data-ribbon]');
    this.elName = q<HTMLInputElement>('[data-name]');
    this.elFx = q<HTMLTextAreaElement>('[data-fx]');
    this.elScroll = q('[data-scroll]');
    this.elZoom = q('[data-zoom]');
    this.elTable = q<HTMLTableElement>('[data-table]');
    this.elCols = q('[data-cols]');
    this.elHead = q('[data-head]');
    this.elBody = q('[data-body]');
    this.elLayer = q('[data-layer]');
    this.elTabs = q('[data-tabs]');
    this.elStatus = q('[data-status]');
    this.elSink = q<HTMLTextAreaElement>('[data-sink]');
    this.elSink.addEventListener('input', () => {
      // Текст пришёл не нажатием клавиши (метод ввода, диктовка) — начинаем ввод с него
      const v = this.elSink.value;
      this.elSink.value = '';
      if (v && !this.edit) this.startEdit(this.cur.r, this.cur.c, { initial: v, mode: 'enter' });
    });

    this.zoom = (this.sheet()?.zoom ?? 100) / 100;
    this.bindGrid();
    this.bindFormulaBar();
    this.renderAll();
    requestAnimationFrame(() => this.focusGrid());
  }

  renderAll(): void {
    this.renderRibbon();
    this.renderGrid(true);
    this.renderTabs();
  }

  // ═══════════════════════════ Геометрия ═══════════════════════════

  private colW(c: number): number {
    const sh = this.sheet();
    if (sh.hiddenCols?.includes(c)) return 0;
    return sh.colWidths?.[c] ?? sh.defColW ?? XL_DEF_COL_PX;
  }
  private rowH(r: number): number {
    const sh = this.sheet();
    if (sh.hiddenRows?.includes(r) || this.hiddenFilterRows.has(r)) return 0;
    return sh.rowHeights?.[r] ?? sh.defRowH ?? XL_DEF_ROW_PX;
  }
  private isRowHidden(r: number): boolean { return this.rowH(r) === 0; }
  private isColHidden(c: number): boolean { return this.colW(c) === 0; }

  private computeGeometry(): void {
    const sh = this.sheet();
    const dataCols = Math.max(0, ...sh.data.map(r => r.length));
    this.dispRows = Math.max(this.dispRows, sh.data.length + 30, 60, (sh.freeze?.rows ?? 0) + 30, this.sel.r2 + 30);
    this.dispCols = Math.max(this.dispCols, dataCols + 3, 26, (sh.freeze?.cols ?? 0) + 10, this.sel.c2 + 5,
      ...(sh.colWidths ? [sh.colWidths.length] : []));
    this.dispRows = Math.min(this.dispRows, 1048576);
    this.dispCols = Math.min(this.dispCols, 16384);
    this.hiddenFilterRows = this.computeFilterHidden();
    this.rowTop = new Array(this.dispRows + 1);
    this.rowTop[0] = 0;
    for (let r = 0; r < this.dispRows; r++) this.rowTop[r + 1] = this.rowTop[r] + this.rowH(r);
    this.colLeft = new Array(this.dispCols + 1);
    this.colLeft[0] = 0;
    for (let c = 0; c < this.dispCols; c++) this.colLeft[c + 1] = this.colLeft[c] + this.colW(c);
    this.rowHdrW = Math.max(40, String(this.dispRows).length * 8 + 14);
  }

  /** Индекс строки, которой принадлежит вертикальная координата (px от верха данных). */
  private rowAtY(y: number): number {
    let lo = 0, hi = this.dispRows;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.rowTop[m + 1] <= y) lo = m + 1; else hi = m; }
    return Math.min(lo, this.dispRows - 1);
  }

  // ═══════════════════════════ Отрисовка сетки ═══════════════════════════

  private renderGrid(_full = false): void {
    if (this.edit) this.positionEditor();
    this.computeGeometry();
    const sh = this.sheet();
    const fc = Math.min(sh.freeze?.cols ?? 0, this.dispCols);
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    this.elTable.style.fontFamily = `"${font.name}",Calibri,Arial,sans-serif`;
    this.elTable.style.fontSize = `${font.size}pt`;
    this.elZoom.style.zoom = String(this.zoom);
    this.root.querySelector('.xl-app')?.classList.toggle('xl-nogrid', sh.showGrid === false);

    // Колонки
    let colsHtml = `<col style="width:${this.rowHdrW}px">`;
    let headHtml = `<tr><th class="xl-corner" style="width:${this.rowHdrW}px" title="Выделить всё"></th>`;
    const fLeft = (c: number) => this.rowHdrW + this.colLeft[c];
    for (let c = 0; c < this.dispCols; c++) {
      const w = this.colW(c);
      if (!w) continue;
      colsHtml += `<col style="width:${w}px">`;
      const sticky = c < fc ? ` style="left:${fLeft(c)}px" ` : '';
      const nextHidden = c + 1 < this.dispCols && this.isColHidden(c + 1);
      headHtml += `<th class="xl-ch${c < fc ? ' xl-fc' : ''}${nextHidden ? ' xl-hid-after' : ''}" data-c="${c}"${sticky}>${colLetter(c)}<span class="xl-rs-c" data-rs-c="${c}"></span></th>`;
    }
    headHtml += '</tr>';
    this.elCols.innerHTML = colsHtml;
    this.elHead.innerHTML = headHtml;
    this.elTable.style.width = (this.rowHdrW + this.colLeft[this.dispCols]) + 'px';

    this.renderBody(true);
    this.renderObjects();
    this.syncFormulaBar();
    this.renderStatus();
  }

  /** Перерисовать окно строк вокруг текущей прокрутки. */
  private renderBody(force = false): void {
    const sh = this.sheet();
    const fr = Math.min(sh.freeze?.rows ?? 0, this.dispRows);
    const fc = Math.min(sh.freeze?.cols ?? 0, this.dispCols);
    const view = this.elScroll.clientHeight / this.zoom || 600;
    const top = Math.max(0, this.elScroll.scrollTop / this.zoom - HDR_H);
    const frH = this.rowTop[fr];
    let first = this.rowAtY(top + frH);
    first = Math.max(fr, first);
    const last = this.rowAtY(top + frH + view);
    // Окно с запасом; если прокрутили к концу — дорастить сетку
    if (last >= this.dispRows - 10 && this.dispRows < 1048576) {
      this.dispRows += 200;
      this.computeGeometry();
    }
    const start = Math.max(fr, first - BUF_ROWS);
    const end = Math.min(this.dispRows, last + BUF_ROWS + 1);
    if (!force && start >= this.winStart && end <= this.winEnd && this.winEnd > this.winStart) return;
    this.winStart = Math.max(fr, first - BUF_ROWS * 2);
    this.winEnd = Math.min(this.dispRows, last + BUF_ROWS * 2 + 1);

    const rows: number[] = [];
    for (let r = 0; r < fr; r++) if (!this.isRowHidden(r)) rows.push(r);
    const frozenCount = rows.length;
    for (let r = this.winStart; r < this.winEnd; r++) if (!this.isRowHidden(r)) rows.push(r);

    // Объединения, попадающие в окно: якорь — первая видимая ячейка
    const span = new Map<string, { rs: number; cs: number; r: number; c: number }>();
    const covered = new Set<string>();
    const sections: Array<number[]> = [rows.slice(0, frozenCount), rows.slice(frozenCount)];
    for (const m of sh.merges ?? []) {
      for (const sec of sections) {
        const rr = sec.filter(r => r >= m.r1 && r <= m.r2);
        if (!rr.length) continue;
        const cc: number[] = [];
        for (let c = m.c1; c <= Math.min(m.c2, this.dispCols - 1); c++) if (!this.isColHidden(c)) cc.push(c);
        if (!cc.length) continue;
        span.set(rr[0] + ',' + cc[0], { rs: rr.length, cs: cc.length, r: m.r1, c: m.c1 });
        for (const r of rr) for (const c of cc) if (r !== rr[0] || c !== cc[0]) covered.add(r + ',' + c);
      }
    }

    const ev = this.host.evaluator(this.si());
    const fLeft = (c: number) => this.rowHdrW + this.colLeft[c];
    const fTop = (r: number) => HDR_H + this.rowTop[r];
    const af = sh.autoFilter ? parseRangeRef(sh.autoFilter) : null;
    let html = '';
    const rowHtml = (r: number, frozen: boolean) => {
      const h = this.rowH(r);
      const custom = sh.rowHeights?.[r] != null;
      let s = `<tr data-r="${r}" style="height:${h}px">`;
      const rhSticky = frozen ? `top:${fTop(r)}px;` : '';
      const nextHidden = r + 1 < this.dispRows && this.isRowHidden(r + 1);
      s += `<th class="xl-rh${frozen ? ' xl-fr' : ''}${nextHidden ? ' xl-hid-after' : ''}" data-r="${r}" style="${rhSticky}">${r + 1}<span class="xl-rs-r" data-rs-r="${r}"></span></th>`;
      for (let c = 0; c < this.dispCols; c++) {
        if (this.isColHidden(c)) continue;
        const key = r + ',' + c;
        if (covered.has(key)) continue;
        const sp = span.get(key);
        s += this.cellHtml(ev, sh, sp ? sp.r : r, sp ? sp.c : c, {
          rs: sp?.rs, cs: sp?.cs,
          stickyTop: frozen ? fTop(r) : undefined,
          stickyLeft: c < fc ? fLeft(c) : undefined,
          clipH: custom ? h : undefined,
          filterBtn: !!af && r === af.r1 && c >= af.c1 && c <= af.c2,
          dispC: c,
        });
      }
      return s + '</tr>';
    };
    for (let i = 0; i < frozenCount; i++) html += rowHtml(rows[i], true);
    const gapTop = this.rowTop[this.winStart] - this.rowTop[fr];
    if (gapTop > 0) html += `<tr class="xl-sp" style="height:${gapTop}px"><td colspan="${this.dispCols + 1}"></td></tr>`;
    for (let i = frozenCount; i < rows.length; i++) html += rowHtml(rows[i], false);
    const gapBot = this.rowTop[this.dispRows] - this.rowTop[this.winEnd];
    if (gapBot > 0) html += `<tr class="xl-sp" style="height:${gapBot}px"><td colspan="${this.dispCols + 1}"></td></tr>`;
    this.elBody.innerHTML = html;

    this.tdMap.clear();
    this.elBody.querySelectorAll<HTMLTableCellElement>('td[data-c]').forEach(td => this.tdMap.set(td.dataset.r + ',' + td.dataset.c, td));
    this.applySelection();
  }

  private cellHtml(ev: Evaluator, sh: SheetData, r: number, c: number, o: {
    rs?: number; cs?: number; stickyTop?: number; stickyLeft?: number; clipH?: number; filterBtn?: boolean; dispC: number;
  }): string {
    const cell = sh.data[r]?.[c];
    let style = cell?.s ? renderCss(cell.s) : '';
    const cls: string[] = [];
    if (o.stickyTop !== undefined) { style += `;top:${o.stickyTop}px`; cls.push('xl-fr'); }
    if (o.stickyLeft !== undefined) { style += `;left:${o.stickyLeft}px`; cls.push('xl-fc'); }
    let content = '';
    let title = '';
    if (cell) {
      const v = cell.v ?? '';
      let kind: 'num' | 'text' | 'err' | 'bool' = 'text';
      let text = '';
      if (this.showFormulas && v.startsWith('=')) text = v;
      else if (v.startsWith('=')) {
        const val = ev.cellValue(r, c);
        if (isErr(val)) { kind = 'err'; text = val.err; }
        else if (typeof val === 'number') { kind = 'num'; text = formatCellValue(String(val), 'n', cell.nf); }
        else if (typeof val === 'boolean') { kind = 'bool'; text = val ? 'ИСТИНА' : 'ЛОЖЬ'; }
        else text = String(val);
      } else if (v) {
        if (cell.t === 'n') { kind = 'num'; text = formatCellValue(v, 'n', cell.nf); }
        else if (cell.t === 'b') { kind = 'bool'; text = v; }
        else if (/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/.test(v)) { kind = 'err'; text = v; }
        else text = cell.nf && cell.nf !== '@' ? formatCellValue(v, cell.t, cell.nf) : v;
      }
      if (kind === 'num' && !hasHAlign(cell.s)) cls.push('xl-num');
      if ((kind === 'err' || kind === 'bool') && !hasHAlign(cell.s)) cls.push('xl-ctr');
      if (kind === 'num' && cell.nf && /\[(red|красный)\]/i.test(cell.nf) && Number(v) < 0) style += ';color:#c00000';

      if (cell.rt?.length && cell.rt.map(x => x.text).join('') === v && !this.showFormulas) {
        content = cell.rt.map(run => run.s ? `<span style="${esc(renderCss(run.s))}">${esc(run.text)}</span>` : esc(run.text)).join('');
      } else {
        content = esc(text);
      }
      if (cell.link && text) { content = `<span class="xl-link">${content}</span>`; title = cell.link; }
      if (cell.img && isSafeImageSrc(cell.img)) {
        const sz = cell.imgW && cell.imgH ? ` style="width:${cell.imgW}px;height:${cell.imgH}px"` : '';
        content = `<img class="xl-cimg" src="${esc(cell.img)}" alt=""${sz} draggable="false">` + content;
      }
      if (cell.note) { cls.push('xl-has-note'); title = cell.note; }
      // Текст «вылезает» на пустых соседей справа, как в Excel
      const wrap = cell.s && /white-space:pre-wrap/.test(cell.s);
      if (kind === 'text' && text && !wrap && !o.cs) {
        const right = sh.data[r]?.[c + 1];
        if (!right || (!right.v && !right.img)) cls.push('xl-ovf');
      }
      if (o.clipH && content) content = `<div class="xl-clip" style="max-height:${o.clipH}px">${content}</div>`;
    }
    if (o.filterBtn) {
      const active = !!this.sheet().filter?.[String(c)];
      content += `<button class="xl-fbtn${active ? ' on' : ''}" data-fbtn="${c}" title="Фильтр">${active ? IC.filter : '▾'}</button>`;
      cls.push('xl-has-fbtn');
    }
    const validation = this.validationAt(sh, r, c);
    if (validation?.type === 'list') {
      content += `<button class="xl-dv-btn" data-dv="${r},${c}" title="Открыть список">▾</button>`;
      cls.push('xl-has-dv');
    }
    const spanA = (o.rs && o.rs > 1 ? ` rowspan="${o.rs}"` : '') + (o.cs && o.cs > 1 ? ` colspan="${o.cs}"` : '');
    return `<td data-r="${r}" data-c="${c}"${spanA}${cls.length ? ` class="${cls.join(' ')}"` : ''}${style ? ` style="${esc(style)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${content}</td>`;
  }

  /** Правило проверки данных для ячейки — через индекс, без перебора всех правил. */
  private validationAt(sh: SheetData, r: number, c: number): any | null {
    return validationIndexFor((sh.xl as any)?.dv)?.at(r, c) ?? null;
  }

  private validationValues(rule: any): string[] {
    const formula = String(rule?.formulae?.[0] ?? '').trim();
    if (!formula) return [];
    if ((formula.startsWith('"') && formula.endsWith('"')) || (formula.startsWith("'") && formula.endsWith("'"))) {
      return formula.slice(1, -1).split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
    }
    // Список может быть ссылкой на диапазон другого листа: Лист1!$A$1:$A$20.
    const bang = formula.lastIndexOf('!');
    const sheetName = bang >= 0 ? formula.slice(0, bang).replace(/^'|'$/g, '') : this.sheet().name;
    const ref = (bang >= 0 ? formula.slice(bang + 1) : formula).replace(/\$/g, '');
    const rg = parseRangeRef(ref);
    const target = this.book().sheets.find(s => s.name === sheetName) ?? this.sheet();
    if (!rg || !target) return [formula.replace(/^=/, '')].filter(Boolean);
    const values: string[] = [];
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const value = target.data[r]?.[c]?.v?.trim();
      if (value && !values.includes(value)) values.push(value);
    }
    return values;
  }

  private openValidationMenu(r: number, c: number, anchor: HTMLElement): void {
    const rule = this.validationAt(this.sheet(), r, c);
    const values = rule ? this.validationValues(rule) : [];
    if (!values.length) return;
    showMenu([
      ...(this.cell(r, c)?.v ? [{ label: 'Очистить значение', action: () => this.change(() => { this.sheet().data[r][c] = interpretInput('', this.cell(r, c)); }) }] : []),
      ...values.map(value => ({ label: value, checked: this.cell(r, c)?.v === value, action: () => this.change(() => { this.sheet().data[r][c] = interpretInput(value, this.cell(r, c)); }) })),
    ], anchor);
  }

  // ═══════════════════════════ Выделение ═══════════════════════════

  private setSel(rg: MergeRange, cur?: { r: number; c: number }, opts: { scroll?: boolean; keepAnchor?: boolean } = {}): void {
    const sh = this.sheet();
    const norm = { r1: Math.max(0, Math.min(rg.r1, rg.r2)), c1: Math.max(0, Math.min(rg.c1, rg.c2)), r2: Math.max(rg.r1, rg.r2), c2: Math.max(rg.c1, rg.c2) };
    this.sel = expandToMerges(sh, norm);
    if (cur) this.cur = { ...cur };
    if (!opts.keepAnchor) this.anchor = { ...this.cur };
    if (this.sel.r2 >= this.dispRows - 5 || this.sel.c2 >= this.dispCols - 2) this.renderGrid(true);
    this.applySelection();
    if (opts.scroll !== false) this.scrollIntoView(this.cur.r, this.cur.c);
    this.syncFormulaBar();
    this.renderStatus();
    this.updateRibbonState();
    this.publishSelection();
    if (document.activeElement === this.elSink) this.focusGrid();
  }

  private selectCell(r: number, c: number, extend = false): void {
    r = Math.max(0, Math.min(r, 1048575)); c = Math.max(0, Math.min(c, 16383));
    if (extend) {
      this.setSel({ r1: this.anchor.r, c1: this.anchor.c, r2: r, c2: c }, this.anchor, { keepAnchor: true });
      this.scrollIntoView(r, c);
    } else {
      const m = mergesIn(this.sheet(), { r1: r, c1: c, r2: r, c2: c })[0];
      this.setSel(m ? { ...m } : { r1: r, c1: c, r2: r, c2: c }, m ? { r: m.r1, c: m.c1 } : { r, c });
    }
  }

  private applySelection(): void {
    this.elBody.querySelectorAll('.xl-sel,.xl-act,.xl-sbt,.xl-sbb,.xl-sbl,.xl-sbr').forEach(el =>
      el.classList.remove('xl-sel', 'xl-act', 'xl-sbt', 'xl-sbb', 'xl-sbl', 'xl-sbr'));
    this.elHead.querySelectorAll('.xl-hsel,.xl-hfull').forEach(el => el.classList.remove('xl-hsel', 'xl-hfull'));
    this.elBody.querySelectorAll('.xl-hsel,.xl-hfull').forEach(el => el.classList.remove('xl-hsel', 'xl-hfull'));
    const s = this.sel;
    const multi = s.r1 !== s.r2 || s.c1 !== s.c2;
    for (const [key, td] of this.tdMap) {
      const i = key.indexOf(',');
      const r = +key.slice(0, i), c = +key.slice(i + 1);
      const rs = td.rowSpan || 1, cs = td.colSpan || 1;
      const m = rs > 1 || cs > 1 ? mergesIn(this.sheet(), { r1: r, c1: c, r2: r, c2: c })[0] : null;
      const r2 = m ? m.r2 : r, c2 = m ? m.c2 : c;
      if (r2 < s.r1 || r > s.r2 || c2 < s.c1 || c > s.c2) continue;
      if (r === this.cur.r && c === this.cur.c) td.classList.add('xl-act');
      else if (multi) td.classList.add('xl-sel');
      if (r <= s.r1) td.classList.add('xl-sbt');
      if (r2 >= s.r2) td.classList.add('xl-sbb');
      if (c <= s.c1) td.classList.add('xl-sbl');
      if (c2 >= s.c2) td.classList.add('xl-sbr');
    }
    const fullCols = s.r1 === 0 && s.r2 >= this.dispRows - 1;
    const fullRows = s.c1 === 0 && s.c2 >= this.dispCols - 1;
    this.elHead.querySelectorAll<HTMLElement>('th.xl-ch').forEach(th => {
      const c = +th.dataset.c!;
      if (c >= s.c1 && c <= s.c2) th.classList.add(fullCols ? 'xl-hfull' : 'xl-hsel');
    });
    this.elBody.querySelectorAll<HTMLElement>('th.xl-rh').forEach(th => {
      const r = +th.dataset.r!;
      if (r >= s.r1 && r <= s.r2) th.classList.add(fullRows ? 'xl-hfull' : 'xl-hsel');
    });
    this.placeFillHandle();
  }

  private placeFillHandle(): void {
    this.elFill?.remove();
    this.elFill = null;
    if (this.edit) return;
    const s = this.sel;
    const td = this.findTdCovering(s.r2, s.c2);
    if (!td) return;
    const rc = this.tdRect(td);
    const h = document.createElement('div');
    h.className = 'xl-fillh';
    h.style.left = (rc.x + rc.w - 4) + 'px';
    h.style.top = (rc.y + rc.h - 4) + 'px';
    h.title = 'Протяните, чтобы заполнить';
    this.elLayer.appendChild(h);
    this.elFill = h;
    h.addEventListener('mousedown', e => this.startFillDrag(e));
    h.addEventListener('dblclick', e => { e.preventDefault(); this.fillDownToRegion(); });
  }

  /** Ячейка DOM, которая показывает (r,c) — с учётом объединений. */
  private findTdCovering(r: number, c: number): HTMLTableCellElement | null {
    const direct = this.tdMap.get(r + ',' + c);
    if (direct) return direct;
    const m = mergesIn(this.sheet(), { r1: r, c1: c, r2: r, c2: c })[0];
    if (m) {
      for (let rr = m.r1; rr <= m.r2; rr++) for (let cc = m.c1; cc <= m.c2; cc++) {
        const td = this.tdMap.get(rr + ',' + cc); if (td) return td;
      }
    }
    return null;
  }

  /** Прямоугольник ячейки в координатах слоя (без учёта масштаба). */
  private tdRect(td: HTMLElement): { x: number; y: number; w: number; h: number } {
    const a = td.getBoundingClientRect(), b = this.elZoom.getBoundingClientRect();
    const z = this.zoom || 1;
    return { x: (a.left - b.left) / z, y: (a.top - b.top) / z, w: a.width / z, h: a.height / z };
  }

  private scrollIntoView(r: number, c: number): void {
    const sh = this.sheet();
    const fr = sh.freeze?.rows ?? 0, fc = sh.freeze?.cols ?? 0;
    const z = this.zoom;
    const sc = this.elScroll;
    if (r >= fr) {
      const top = (HDR_H + this.rowTop[r]) * z, bottom = (HDR_H + this.rowTop[Math.min(r + 1, this.dispRows)]) * z;
      const frozenH = (HDR_H + this.rowTop[fr]) * z;
      if (top - frozenH < sc.scrollTop + 0) sc.scrollTop = Math.max(0, top - frozenH);
      else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight + 2;
    }
    if (c >= fc) {
      const left = (this.rowHdrW + this.colLeft[c]) * z, right = (this.rowHdrW + this.colLeft[Math.min(c + 1, this.dispCols)]) * z;
      const frozenW = (this.rowHdrW + this.colLeft[fc]) * z;
      if (left - frozenW < sc.scrollLeft) sc.scrollLeft = Math.max(0, left - frozenW);
      else if (right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = right - sc.clientWidth + 2;
    }
    this.renderBody();
  }

  private publishSelection(): void {
    const s = this.sel, sh = this.sheet();
    const ref = rangeToRef(s);
    const cells = (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
    const lines: string[] = [];
    const ev = this.host.evaluator(this.si());
    outer: for (let r = s.r1; r <= Math.min(s.r2, s.r1 + 9); r++) for (let c = s.c1; c <= s.c2; c++) {
      lines.push(`${colLetter(c)}${r + 1}: ${this.displayText(ev, r, c) || '—'}`);
      if (lines.length >= 20) break outer;
    }
    const label = `${sh.name}!${ref}${cells > 1 ? ` (${cells} яч.)` : ''} · «${this.host.docTitle()}»`;
    const prompt = `[КОНТЕКСТ: выделено в Excel]\nДокумент: «${this.host.docTitle()}», лист «${sh.name}»\nДиапазон: ${ref} (${cells} ячеек)\nСодержимое:\n${lines.join('\n')}${cells > lines.length ? `\n... ещё ${cells - lines.length} ячеек` : ''}`;
    this.host.publishSelection(this.si(), s, label, prompt);
  }

  private displayText(ev: Evaluator, r: number, c: number): string {
    const cell = this.cell(r, c);
    if (!cell || !cell.v) return '';
    if (cell.v.startsWith('=')) {
      const v = ev.cellValue(r, c);
      if (typeof v === 'number') return formatCellValue(String(v), 'n', cell.nf);
      return scalarText(v);
    }
    return formatCellValue(cell.v, cell.t, cell.nf);
  }

  private numericValue(ev: Evaluator, r: number, c: number): number | null {
    const cell = this.cell(r, c);
    if (!cell || !cell.v) return null;
    if (cell.v.startsWith('=')) { const v = ev.cellValue(r, c); return typeof v === 'number' ? v : null; }
    if (cell.t === 'n') { const n = Number(cell.v); return isFinite(n) ? n : null; }
    return null;
  }

  private renderStatus(): void {
    const s = this.sel;
    const cells = (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
    let parts: string[] = [];
    if (cells > 1) {
      const ev = this.host.evaluator(this.si());
      let count = 0, nums = 0, sum = 0, min = Infinity, max = -Infinity;
      const r2 = Math.min(s.r2, this.sheet().data.length - 1);
      let budget = 300000;
      for (let r = s.r1; r <= r2 && budget > 0; r++) {
        if (this.isRowHidden(r)) continue;
        for (let c = s.c1; c <= s.c2 && budget-- > 0; c++) {
          const cell = this.cell(r, c);
          if (!cell?.v) continue;
          count++;
          const n = this.numericValue(ev, r, c);
          if (n !== null) { nums++; sum += n; if (n < min) min = n; if (n > max) max = n; }
        }
      }
      const f = (n: number) => generalNumber(Math.round(n * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/, ' ');
      if (nums) parts = [`Среднее: ${f(sum / nums)}`, `Количество: ${count}`, `Сумма: ${f(sum)}`, `Мин: ${f(min)}`, `Макс: ${f(max)}`];
      else if (count) parts = [`Количество: ${count}`];
    }
    const zoomPct = Math.round(this.zoom * 100);
    this.elStatus.innerHTML = `<span class="xl-st-info">${parts.map(esc).join('<i></i>')}</span>
      <span class="xl-zoomctl"><button data-zoom-step="-10" title="Уменьшить">−</button><button data-zoom-menu>${zoomPct}%</button><button data-zoom-step="10" title="Увеличить">+</button></span>`;
    this.elStatus.querySelectorAll<HTMLElement>('[data-zoom-step]').forEach(b => b.addEventListener('click', () => this.setZoom(zoomPct + +b.dataset.zoomStep!)));
    this.elStatus.querySelector<HTMLElement>('[data-zoom-menu]')?.addEventListener('click', e => {
      showMenu([50, 75, 90, 100, 110, 125, 150, 200].map(z => ({ label: z + '%', checked: z === zoomPct, action: () => this.setZoom(z) })), e.currentTarget as HTMLElement);
    });
  }

  private setZoom(pct: number): void {
    pct = Math.max(25, Math.min(400, Math.round(pct)));
    this.zoom = pct / 100;
    const sh = this.sheet();
    if (pct === 100) delete sh.zoom; else sh.zoom = pct;
    this.renderGrid(true);
  }

  // ═══════════════════════════ Строка формул ═══════════════════════════

  private syncFormulaBar(): void {
    if (document.activeElement !== this.elName) {
      const s = this.sel;
      const single = s.r1 === s.r2 && s.c1 === s.c2 || mergesIn(this.sheet(), s).some(m => m.r1 === s.r1 && m.c1 === s.c1 && m.r2 === s.r2 && m.c2 === s.c2);
      this.elName.value = single ? `${colLetter(this.cur.c)}${this.cur.r + 1}` : `${colLetter(this.cur.c)}${this.cur.r + 1}`;
      if (!single) this.elName.title = rangeToRef(s);
    }
    if (this.edit) { if (!this.edit.viaBar) this.elFx.value = this.edit.ta.value; }
    else this.elFx.value = editText(this.cell(this.cur.r, this.cur.c));
    this.autoGrowFx();
  }

  private autoGrowFx(): void {
    this.elFx.style.height = 'auto';
    this.elFx.style.height = Math.min(120, Math.max(26, this.elFx.scrollHeight)) + 'px';
  }

  private bindFormulaBar(): void {
    const name = this.elName;
    name.addEventListener('focus', () => { this.commitEdit(); name.select(); });
    name.addEventListener('keydown', e => {
      if (e.key === 'Escape') { name.blur(); this.syncFormulaBar(); this.focusGrid(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.gotoRef(name.value.trim());
      this.focusGrid();
    });
    name.addEventListener('blur', () => this.syncFormulaBar());

    const fx = this.elFx;
    fx.addEventListener('focus', () => {
      if (!this.edit) this.startEdit(this.cur.r, this.cur.c, { viaBar: true });
    });
    fx.addEventListener('input', () => {
      if (!this.edit) this.startEdit(this.cur.r, this.cur.c, { viaBar: true });
      if (this.edit) { this.edit.ta.value = fx.value; this.fitEditor(); }
      this.autoGrowFx();
      this.showAutocomplete(fx);
    });
    fx.addEventListener('keydown', e => this.editKeydown(e, fx));
    this.root.querySelector('[data-fxbtn]')!.addEventListener('click', () => this.openFunctionDialog());
  }

  /** Перейти по адресу из поля «Имя»: A1, B2:D9, Лист2!A1. */
  gotoRef(text: string): void {
    let ref = text.trim();
    if (!ref) return;
    const m = ref.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
    if (m) {
      const name = (m[1] ?? m[2]).replace(/''/g, "'");
      const idx = this.book().sheets.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
      if (idx < 0) { this.host.toast(`Лист «${name}» не найден`, 'error'); return; }
      if (idx !== this.si()) this.switchSheet(idx);
      ref = m[3];
    }
    const rg = parseRangeRef(ref.replace(/\$/g, ''));
    if (!rg) { this.host.toast('Неверный адрес. Пример: A1 или B2:D10', 'error'); return; }
    this.setSel(rg, { r: rg.r1, c: rg.c1 });
  }

  // ═══════════════════════════ Ввод в ячейку ═══════════════════════════

  startEdit(r: number, c: number, o: { initial?: string; mode?: 'enter' | 'edit'; viaBar?: boolean } = {}): void {
    if (this.edit) this.commitEdit();
    const m = mergesIn(this.sheet(), { r1: r, c1: c, r2: r, c2: c })[0];
    if (m) { r = m.r1; c = m.c1; }
    this.scrollIntoView(r, c);
    const ta = document.createElement('textarea');
    ta.className = 'xl-editor';
    ta.spellcheck = false;
    const cell = this.cell(r, c);
    const orig = editText(cell);
    ta.value = o.initial ?? orig;
    const x = cssToX(cell?.s);
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    ta.style.fontFamily = `"${x.font?.name ?? font.name}",Calibri,Arial,sans-serif`;
    ta.style.fontSize = `${x.font?.size ?? font.size}pt`;
    if (x.font?.bold) ta.style.fontWeight = '700';
    if (x.font?.italic) ta.style.fontStyle = 'italic';
    if (x.font?.color) ta.style.color = x.font.color;
    if (x.fill) ta.style.background = x.fill;
    const h = x.align?.h;
    if (h === 'center' || h === 'right') ta.style.textAlign = h;
    this.edit = { r, c, ta, orig, mode: o.mode ?? (o.initial !== undefined ? 'enter' : 'edit'), viaBar: !!o.viaBar, sheet: this.si() };
    this.elFill?.remove(); this.elFill = null;
    this.elLayer.appendChild(ta);
    this.positionEditor();
    ta.addEventListener('input', () => {
      this.elFx.value = ta.value; this.autoGrowFx();
      this.fitEditor();
      this.showAutocomplete(ta);
    });
    ta.addEventListener('keydown', e => this.editKeydown(e, ta));
    ta.addEventListener('blur', () => setTimeout(() => document.querySelector('.xl-ac')?.remove(), 150));
    if (!o.viaBar) {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    } else {
      this.elFx.value = ta.value;
    }
    this.root.querySelector('.xl-app')?.classList.add('xl-editing');
  }

  private positionEditor(): void {
    const e = this.edit;
    if (!e) return;
    if (e.sheet !== this.si()) { e.ta.style.display = 'none'; return; }
    e.ta.style.display = '';
    const td = this.findTdCovering(e.r, e.c);
    if (!td) {
      // Ячейка вне окна — ставим по модели
      const x = this.rowHdrW + this.colLeft[e.c], y = HDR_H + this.rowTop[e.r];
      Object.assign(e.ta.style, { left: x + 'px', top: y + 'px', minWidth: this.colW(e.c) + 'px', minHeight: this.rowH(e.r) + 'px' });
    } else {
      const rc = this.tdRect(td);
      Object.assign(e.ta.style, { left: rc.x + 'px', top: rc.y + 'px', minWidth: rc.w + 'px', minHeight: rc.h + 'px', width: rc.w + 'px', height: rc.h + 'px' });
    }
    this.fitEditor();
  }

  private fitEditor(): void {
    const ta = this.edit?.ta;
    if (!ta) return;
    ta.style.width = '0px';
    ta.style.width = Math.min(640, Math.max(parseFloat(ta.style.minWidth) || 60, ta.scrollWidth + 4)) + 'px';
    ta.style.height = '0px';
    ta.style.height = Math.max(parseFloat(ta.style.minHeight) || 20, ta.scrollHeight) + 'px';
  }

  /** Набирается формула и курсор стоит там, где уместна ссылка — клик по ячейке вставит её. */
  private pointModeActive(): boolean {
    const e = this.edit;
    if (!e) return false;
    const el = e.viaBar ? this.elFx : e.ta;
    const v = el.value;
    if (!v.startsWith('=')) return false;
    const before = v.slice(0, el.selectionStart ?? v.length);
    return /[=(,;+\-*/^&<>:]\s*$/.test(before) || /(\$?[A-Za-z]{1,3}\$?\d+)(:\$?[A-Za-z]{1,3}\$?\d+)?$/.test(before) && !!this.pointRefSpan;
  }

  /** Диапазон текста, который сейчас занят вставленной кликом ссылкой. */
  private pointRefSpan: { start: number; end: number } | null = null;

  private insertPointRef(rg: MergeRange): void {
    const e = this.edit;
    if (!e) return;
    const el = e.viaBar ? this.elFx : e.ta;
    let ref = rangeToRef(rg);
    if (this.si() !== e.sheet) {
      const n = this.sheet().name;
      ref = (/^[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`) + '!' + ref;
    }
    const v = el.value;
    let start = el.selectionStart ?? v.length;
    const end = el.selectionEnd ?? start;
    if (this.pointRefSpan && this.pointRefSpan.end === start) start = this.pointRefSpan.start;
    el.value = v.slice(0, start) + ref + v.slice(end);
    const pos = start + ref.length;
    el.setSelectionRange(pos, pos);
    this.pointRefSpan = { start, end: pos };
    if (e.viaBar) e.ta.value = el.value; else this.elFx.value = el.value;
    this.fitEditor();
    el.focus();
  }

  private editKeydown(e: KeyboardEvent, el: HTMLTextAreaElement): void {
    if (!this.edit) {
      if (el === this.elFx && e.key === 'Escape') { el.blur(); this.focusGrid(); }
      return;
    }
    const ac = document.querySelector<HTMLElement>('.xl-ac');
    if (ac && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab' || (e.key === 'Enter' && ac.querySelector('.on')))) {
      const items = [...ac.querySelectorAll<HTMLElement>('.xl-ac-i')];
      let i = items.findIndex(x => x.classList.contains('on'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[i]?.classList.remove('on');
        i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
        items[i]?.classList.add('on');
        return;
      }
      const pick = items[Math.max(0, i)];
      if (pick) { e.preventDefault(); pick.dispatchEvent(new MouseEvent('mousedown')); return; }
    }
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Alt') {
      if (!(e.key.startsWith('Arrow') && this.pointRefSpan)) this.pointRefSpan = null;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); this.cancelEdit(); this.focusGrid(); return;
      case 'Enter':
        if (e.altKey) { e.preventDefault(); this.insertAtCaret(el, '\n'); return; }
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) { this.commitEdit({ fillSelection: true }); return; }
        this.commitEdit();
        this.moveAfterEnter(e.shiftKey ? -1 : 1, 0);
        return;
      case 'Tab':
        e.preventDefault();
        this.commitEdit();
        this.moveAfterEnter(0, e.shiftKey ? -1 : 1);
        return;
      case 'F4': {
        e.preventDefault();
        this.toggleAbsRef(el);
        return;
      }
    }
    if (this.edit.mode === 'enter' && !this.edit.viaBar && e.key.startsWith('Arrow') && !e.altKey) {
      // Режим «ввод»: стрелки завершают ввод, а в формуле — выбирают ссылку
      const dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (this.edit.ta.value.startsWith('=') && (this.pointModeActive() || this.pointRefSpan)) {
        e.preventDefault();
        const base = this.pointRefSpan ? this.lastPointCell ?? { r: this.edit.r, c: this.edit.c } : { r: this.edit.r, c: this.edit.c };
        const r = Math.max(0, base.r + dr), c = Math.max(0, base.c + dc);
        this.lastPointCell = { r, c };
        this.insertPointRef({ r1: r, c1: c, r2: r, c2: c });
        return;
      }
      e.preventDefault();
      this.commitEdit();
      this.selectCell(this.cur.r + dr, this.cur.c + dc);
      return;
    }
  }
  private lastPointCell: { r: number; c: number } | null = null;

  private insertAtCaret(el: HTMLTextAreaElement, text: string): void {
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.setSelectionRange(s + text.length, s + text.length);
    el.dispatchEvent(new Event('input'));
  }

  /** F4: A1 → $A$1 → A$1 → $A1 → A1 для ссылки под курсором. */
  private toggleAbsRef(el: HTMLTextAreaElement): void {
    const v = el.value, pos = el.selectionStart;
    const re = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v)) !== null) {
      if (pos >= m.index && pos <= m.index + m[0].length) {
        const p = m[0].match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/)!;
        const state = (p[1] ? 2 : 0) + (p[3] ? 1 : 0);
        const next = [[true, true], [false, true], [true, false], [false, false]][state === 0 ? 0 : state === 3 ? 1 : state === 1 ? 2 : 3];
        const rep = `${next[0] ? '$' : ''}${p[2]}${next[1] ? '$' : ''}${p[4]}`;
        el.value = v.slice(0, m.index) + rep + v.slice(m.index + m[0].length);
        el.setSelectionRange(m.index + rep.length, m.index + rep.length);
        el.dispatchEvent(new Event('input'));
        return;
      }
    }
  }

  private moveAfterEnter(dr: number, dc: number): void {
    const s = this.sel;
    const multi = s.r1 !== s.r2 || s.c1 !== s.c2;
    if (!multi) { this.selectCell(this.cur.r + dr, this.cur.c + dc); return; }
    // Внутри выделения Enter ходит по нему, не сбрасывая
    let { r, c } = this.cur;
    if (dr) { r += dr; if (r > s.r2) { r = s.r1; c = c + 1 > s.c2 ? s.c1 : c + 1; } if (r < s.r1) { r = s.r2; c = c - 1 < s.c1 ? s.c2 : c - 1; } }
    if (dc) { c += dc; if (c > s.c2) { c = s.c1; r = r + 1 > s.r2 ? s.r1 : r + 1; } if (c < s.c1) { c = s.c2; r = r - 1 < s.r1 ? s.r2 : r - 1; } }
    this.cur = { r, c };
    this.applySelection(); this.syncFormulaBar(); this.scrollIntoView(r, c);
  }

  commitEdit(o: { fillSelection?: boolean } = {}): void {
    const e = this.edit;
    if (!e) return;
    const text = e.viaBar ? this.elFx.value : e.ta.value;
    this.edit = null;
    e.ta.remove();
    document.querySelector('.xl-ac')?.remove();
    this.root.querySelector('.xl-app')?.classList.remove('xl-editing');
    this.pointRefSpan = null; this.lastPointCell = null;
    if (this.si() !== e.sheet) this.switchSheet(e.sheet, { keepEdit: true });
    if (!e.viaBar || document.activeElement === document.body) this.focusGrid();
    if (text === e.orig && !o.fillSelection) { this.placeFillHandle(); return; }
    const book = this.book();
    const sh = book.sheets[e.sheet];
    this.host.beginChange();
    const targets: Array<{ r: number; c: number }> = o.fillSelection
      ? (() => { const out: Array<{ r: number; c: number }> = []; for (let r = this.sel.r1; r <= this.sel.r2; r++) for (let c = this.sel.c1; c <= this.sel.c2; c++) out.push({ r, c }); return out; })()
      : [{ r: e.r, c: e.c }];
    for (const t of targets) {
      ensureSize(sh, t.r + 1, t.c + 1);
      let v = text;
      if (o.fillSelection && v.startsWith('=')) v = offsetFormula(v, t.r - e.r, t.c - e.c);
      const next = interpretInput(v, sh.data[t.r][t.c]);
      // Формула с запятой в аргументах: «=ОКРУГЛ(A1,2)» — оставляем как ввели
      sh.data[t.r][t.c] = next;
    }
    // Вводу URL — ссылка, как в Excel
    const only = sh.data[e.r][e.c];
    if (/^https?:\/\/\S+$/i.test(only.v) && !only.link) only.link = only.v;
    this.host.commit();
    this.renderGrid();
  }

  cancelEdit(): void {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    e.ta.remove();
    document.querySelector('.xl-ac')?.remove();
    this.root.querySelector('.xl-app')?.classList.remove('xl-editing');
    this.pointRefSpan = null; this.lastPointCell = null;
    if (this.si() !== e.sheet) this.switchSheet(e.sheet);
    this.syncFormulaBar();
    this.placeFillHandle();
    this.focusGrid();
  }

  private showAutocomplete(el: HTMLTextAreaElement): void {
    document.querySelector('.xl-ac')?.remove();
    const v = el.value;
    if (!v.startsWith('=')) return;
    const before = v.slice(0, el.selectionStart ?? v.length);
    const tok = before.match(/([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9.]*)$/)?.[1];
    if (!tok || tok.length < 1 || /^\$?[A-Za-z]{1,3}\d+$/.test(tok)) return;
    const up = tok.toUpperCase();
    const RU = Object.entries(RU_HINTS);
    const list = [
      ...FUNCTION_NAMES.filter(f => f.startsWith(up)).map(f => ({ name: f, hint: FN_HINTS[f] ?? '' })),
      ...RU.filter(([ru]) => ru.startsWith(up)).map(([ru, en]) => ({ name: ru, hint: FN_HINTS[en] ?? '' })),
    ].slice(0, 10);
    if (!list.length || (list.length === 1 && list[0].name === up)) return;
    const box = document.createElement('div');
    box.className = 'xl-ac';
    box.innerHTML = list.map((f, i) => `<div class="xl-ac-i${i === 0 ? ' on' : ''}" data-f="${f.name}"><b>${esc(f.name)}</b><span>${esc(f.hint)}</span></div>`).join('');
    document.body.appendChild(box);
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.top = (r.bottom + 2) + 'px';
    box.querySelectorAll<HTMLElement>('.xl-ac-i').forEach(it => it.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const pos = el.selectionStart ?? v.length;
      const start = pos - tok.length;
      el.value = v.slice(0, start) + it.dataset.f + '(' + v.slice(pos);
      const np = start + it.dataset.f!.length + 1;
      el.setSelectionRange(np, np);
      box.remove();
      el.dispatchEvent(new Event('input'));
      el.focus();
    }));
  }

  // ═══════════════════════════ Мышь ═══════════════════════════

  private bindGrid(): void {
    const sc = this.elScroll;
    let raf = 0;
    sc.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        this.renderBody();
        // Справа кончилась сетка — добавить колонок
        if (sc.scrollLeft + sc.clientWidth > sc.scrollWidth - 200 && this.dispCols < 16384) {
          this.dispCols += 10; this.renderGrid(true);
        }
      });
    });

    this.elZoom.addEventListener('mousedown', e => this.onMouseDown(e));
    this.elZoom.addEventListener('dblclick', e => {
      const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-c]');
      if (td) { e.preventDefault(); this.startEdit(+td.dataset.r!, +td.dataset.c!, { mode: 'edit' }); return; }
      const rsC = (e.target as HTMLElement).closest<HTMLElement>('[data-rs-c]');
      if (rsC) { this.autoFitCols(+rsC.dataset.rsC!); return; }
      const rsR = (e.target as HTMLElement).closest<HTMLElement>('[data-rs-r]');
      if (rsR) { this.autoFitRows(+rsR.dataset.rsR!); return; }
      const obj = (e.target as HTMLElement).closest<HTMLElement>('[data-obj]');
      if (obj && obj.dataset.kind === 'chart') this.openChartDialog(obj.dataset.obj!);
    });
    this.elZoom.addEventListener('contextmenu', e => this.onContextMenu(e));
    this.elZoom.addEventListener('click', e => {
      const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-c]');
      if (td && (e.ctrlKey || e.metaKey)) {
        const link = this.cell(+td.dataset.r!, +td.dataset.c!)?.link;
        if (link && /^(https?:|mailto:)/i.test(link)) window.open(link, '_blank', 'noopener');
      }
    });

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    this.root.addEventListener('keydown', onKey);
    const onCopy = (e: ClipboardEvent) => { if (this.ownsFocus()) this.onCopy(e, false); };
    const onCut = (e: ClipboardEvent) => { if (this.ownsFocus()) this.onCopy(e, true); };
    const onPaste = (e: ClipboardEvent) => { if (this.ownsFocus()) this.onPaste(e); };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.renderBody()) : null;
    ro?.observe(sc);
    this.disposers.push(
      () => document.removeEventListener('copy', onCopy),
      () => document.removeEventListener('cut', onCut),
      () => document.removeEventListener('paste', onPaste),
      () => ro?.disconnect(),
    );
  }

  /** Фокус внутри сетки (а не в поле ввода) — буфер обмена наш. */
  private ownsFocus(): boolean {
    const a = document.activeElement;
    if (!a || !this.root.isConnected) return false;
    if (this.edit) return false;
    return a === this.elScroll || a === this.elSink || (this.elScroll.contains(a) && !(a as HTMLElement).matches('textarea,input'));
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 2) {
      // Правый клик внутри выделения его не сбрасывает
      const td = (e.target as HTMLElement).closest<HTMLElement>('td[data-c]');
      if (td) {
        const r = +td.dataset.r!, c = +td.dataset.c!;
        const s = this.sel;
        if (!(r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2)) { this.commitEdit(); this.selectCell(r, c); }
      }
      const s = this.sel;
      const ch = (e.target as HTMLElement).closest<HTMLElement>('th.xl-ch');
      if (ch) { const c = +ch.dataset.c!; if (!(s.r1 === 0 && s.r2 >= this.dispRows - 1 && c >= s.c1 && c <= s.c2)) this.setSel({ r1: 0, c1: c, r2: this.dispRows - 1, c2: c }, { r: 0, c }, { scroll: false }); }
      const rh = (e.target as HTMLElement).closest<HTMLElement>('th.xl-rh');
      if (rh) { const r = +rh.dataset.r!; if (!(s.c1 === 0 && s.c2 >= this.dispCols - 1 && r >= s.r1 && r <= s.r2)) this.setSel({ r1: r, c1: 0, r2: r, c2: this.dispCols - 1 }, { r, c: 0 }, { scroll: false }); }
      return;
    }
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    closeMenus();

    // Объекты (диаграммы, картинки)
    const obj = t.closest<HTMLElement>('[data-obj]');
    if (obj) { e.preventDefault(); this.startObjectDrag(e, obj); return; }
    if (this.selObj) { this.selObj = null; this.renderObjects(); }

    if (t.closest('.xl-fillh')) return;
    const dvBtn = t.closest<HTMLElement>('[data-dv]');
    if (dvBtn) {
      e.preventDefault();
      e.stopPropagation();
      const [r, c] = dvBtn.dataset.dv!.split(',').map(Number);
      this.selectCell(r, c);
      this.openValidationMenu(r, c, dvBtn);
      return;
    }
    const fbtn = t.closest<HTMLElement>('[data-fbtn]');
    if (fbtn) { e.preventDefault(); e.stopPropagation(); this.openFilterMenu(+fbtn.dataset.fbtn!, fbtn); return; }

    const rsC = t.closest<HTMLElement>('[data-rs-c]');
    if (rsC) { e.preventDefault(); this.startResize(e, 'col', +rsC.dataset.rsC!); return; }
    const rsR = t.closest<HTMLElement>('[data-rs-r]');
    if (rsR) { e.preventDefault(); this.startResize(e, 'row', +rsR.dataset.rsR!); return; }

    if (t.closest('.xl-corner')) { e.preventDefault(); this.commitEdit(); this.selectAll(); this.focusGrid(); return; }

    const ch = t.closest<HTMLElement>('th.xl-ch');
    if (ch) {
      e.preventDefault();
      const c = +ch.dataset.c!;
      if (this.edit && this.pointModeActive()) { this.insertPointRef({ r1: 0, c1: c, r2: 1048575, c2: c }); return; }
      this.commitEdit();
      const startC = e.shiftKey ? this.anchor.c : c;
      if (!e.shiftKey) this.cur = { r: 0, c };
      const apply = (cc: number) => this.setSel({ r1: 0, c1: Math.min(startC, cc), r2: this.dispRows - 1, c2: Math.max(startC, cc) }, { r: 0, c: e.shiftKey ? this.cur.c : startC }, { scroll: false, keepAnchor: true });
      this.anchor = { r: 0, c: startC };
      apply(c);
      this.dragTrack(ev => { const h = (ev.target as HTMLElement).closest<HTMLElement>('th.xl-ch'); if (h) apply(+h.dataset.c!); });
      this.focusGrid();
      return;
    }
    const rh = t.closest<HTMLElement>('th.xl-rh');
    if (rh) {
      e.preventDefault();
      const r = +rh.dataset.r!;
      if (this.edit && this.pointModeActive()) { this.insertPointRef({ r1: r, c1: 0, r2: r, c2: 16383 }); return; }
      this.commitEdit();
      const startR = e.shiftKey ? this.anchor.r : r;
      const apply = (rr: number) => this.setSel({ r1: Math.min(startR, rr), c1: 0, r2: Math.max(startR, rr), c2: this.dispCols - 1 }, { r: e.shiftKey ? this.cur.r : startR, c: 0 }, { scroll: false, keepAnchor: true });
      this.anchor = { r: startR, c: 0 };
      apply(r);
      this.dragTrack(ev => { const h = (ev.target as HTMLElement).closest<HTMLElement>('th.xl-rh'); if (h) apply(+h.dataset.r!); });
      this.focusGrid();
      return;
    }

    const td = t.closest<HTMLElement>('td[data-c]');
    if (!td) return;
    const r = +td.dataset.r!, c = +td.dataset.c!;

    // Набор формулы: клик по ячейке вставляет ссылку
    if (this.edit && (this.pointModeActive() || this.pointRefSpan)) {
      e.preventDefault();
      const r0 = r, c0 = c;
      this.lastPointCell = { r, c };
      this.insertPointRef({ r1: r, c1: c, r2: r, c2: c });
      this.dragTrack(ev => {
        const tt = (ev.target as HTMLElement).closest<HTMLElement>('td[data-c]');
        if (!tt) return;
        const rr = +tt.dataset.r!, cc = +tt.dataset.c!;
        this.insertPointRef({ r1: Math.min(r0, rr), c1: Math.min(c0, cc), r2: Math.max(r0, rr), c2: Math.max(c0, cc) });
      });
      return;
    }
    if (this.edit && this.edit.r === r && this.edit.c === c) return;
    e.preventDefault();
    this.commitEdit();

    if (this.painter) {
      const target = { r1: r, c1: c, r2: r, c2: c };
      this.dragTrack(ev => {
        const tt = (ev.target as HTMLElement).closest<HTMLElement>('td[data-c]');
        if (tt) { target.r2 = +tt.dataset.r!; target.c2 = +tt.dataset.c!; this.setSel({ r1: r, c1: c, r2: target.r2, c2: target.c2 }, { r, c }, { scroll: false }); }
      }, () => this.applyPainter({ r1: Math.min(r, target.r2), c1: Math.min(c, target.c2), r2: Math.max(r, target.r2), c2: Math.max(c, target.c2) }));
      return;
    }

    if (e.shiftKey) this.selectCell(r, c, true);
    else this.selectCell(r, c);
    this.focusGrid();
    const startAnchor = { ...this.anchor };
    this.dragTrack(ev => {
      const tt = (ev.target as HTMLElement).closest<HTMLElement>('td[data-c]');
      if (!tt) return;
      const rr = +tt.dataset.r!, cc = +tt.dataset.c!;
      this.setSel({ r1: startAnchor.r, c1: startAnchor.c, r2: rr, c2: cc }, startAnchor, { scroll: false, keepAnchor: true });
    });
  }

  /** Протяжка мышью с автопрокруткой у краёв. */
  private dragTrack(onMove: (e: MouseEvent) => void, onUp?: () => void): void {
    let auto = 0, last: MouseEvent | null = null;
    const step = () => {
      if (!last) return;
      const rc = this.elScroll.getBoundingClientRect();
      const dy = last.clientY < rc.top + 24 ? -18 : last.clientY > rc.bottom - 18 ? 18 : 0;
      const dx = last.clientX < rc.left + 30 ? -18 : last.clientX > rc.right - 18 ? 18 : 0;
      if (dx || dy) {
        this.elScroll.scrollTop += dy; this.elScroll.scrollLeft += dx;
        const el = document.elementFromPoint(Math.max(rc.left + 50, Math.min(last.clientX, rc.right - 20)), Math.max(rc.top + 30, Math.min(last.clientY, rc.bottom - 20)));
        if (el) onMove({ ...last, target: el } as unknown as MouseEvent);
      }
      auto = requestAnimationFrame(step);
    };
    const move = (e: MouseEvent) => { last = e; onMove(e); if (!auto) auto = requestAnimationFrame(step); };
    const up = () => {
      cancelAnimationFrame(auto); auto = 0; last = null;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      onUp?.();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private selectAll(): void {
    const sh = this.sheet();
    const region = currentRegion(sh, this.cur.r, this.cur.c);
    const s = this.sel;
    const isRegion = s.r1 === region.r1 && s.c1 === region.c1 && s.r2 === region.r2 && s.c2 === region.c2;
    const hasData = !!sh.data[this.cur.r]?.[this.cur.c]?.v;
    if (hasData && !isRegion && (region.r1 !== region.r2 || region.c1 !== region.c2)) this.setSel(region, this.cur, { scroll: false });
    else this.setSel({ r1: 0, c1: 0, r2: this.dispRows - 1, c2: this.dispCols - 1 }, this.cur, { scroll: false });
  }

  private startResize(e: MouseEvent, axis: 'col' | 'row', idx: number): void {
    const sh = this.sheet();
    const sel = this.sel;
    const fullSel = axis === 'col' ? (sel.r1 === 0 && sel.r2 >= this.dispRows - 1 && idx >= sel.c1 && idx <= sel.c2)
      : (sel.c1 === 0 && sel.c2 >= this.dispCols - 1 && idx >= sel.r1 && idx <= sel.r2);
    const targets = fullSel ? Array.from({ length: (axis === 'col' ? sel.c2 - sel.c1 : sel.r2 - sel.r1) + 1 }, (_, i) => (axis === 'col' ? sel.c1 : sel.r1) + i) : [idx];
    const start = axis === 'col' ? e.clientX : e.clientY;
    const base = axis === 'col' ? this.colW(idx) : this.rowH(idx);
    const guide = document.createElement('div');
    guide.className = axis === 'col' ? 'xl-guide-v' : 'xl-guide-h';
    this.elLayer.appendChild(guide);
    const tip = document.createElement('div');
    tip.className = 'xl-tip';
    document.body.appendChild(tip);
    let size = base;
    const pos0 = axis === 'col' ? this.rowHdrW + this.colLeft[idx] : HDR_H + this.rowTop[idx];
    const move = (ev: MouseEvent) => {
      const d = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / this.zoom;
      size = Math.max(axis === 'col' ? 0 : 0, Math.round(base + d));
      if (axis === 'col') guide.style.left = (pos0 + size) + 'px'; else guide.style.top = (pos0 + size) + 'px';
      tip.textContent = axis === 'col'
        ? `Ширина: ${(Math.max(0, (size - 5) / 7)).toFixed(2)} (${size} пикс.)`
        : `Высота: ${(size * 0.75).toFixed(2)} (${size} пикс.)`;
      tip.style.left = (ev.clientX + 12) + 'px'; tip.style.top = (ev.clientY + 12) + 'px';
    };
    move(e);
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      guide.remove(); tip.remove();
      if (size === base) return;
      this.change(() => {
        for (const i of targets) {
          if (axis === 'col') {
            const arr = sh.colWidths ? [...sh.colWidths] : [];
            while (arr.length <= i) arr.push(null);
            if (size <= 2) { sh.hiddenCols = [...new Set([...(sh.hiddenCols ?? []), i])]; }
            else { arr[i] = size; sh.hiddenCols = sh.hiddenCols?.filter(x => x !== i); }
            sh.colWidths = arr;
          } else {
            const arr = sh.rowHeights ? [...sh.rowHeights] : [];
            while (arr.length <= i) arr.push(null);
            if (size <= 2) { sh.hiddenRows = [...new Set([...(sh.hiddenRows ?? []), i])]; }
            else { arr[i] = size; sh.hiddenRows = sh.hiddenRows?.filter(x => x !== i); }
            sh.rowHeights = arr;
          }
        }
      }, { full: true });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /** Автоподбор ширины: по самому длинному показанному значению. */
  autoFitCols(c: number): void {
    const s = this.sel;
    const cols = s.r1 === 0 && s.r2 >= this.dispRows - 1 && c >= s.c1 && c <= s.c2 ? Array.from({ length: s.c2 - s.c1 + 1 }, (_, i) => s.c1 + i) : [c];
    const sh = this.sheet();
    const ev = this.host.evaluator(this.si());
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    document.body.appendChild(probe);
    const widths = cols.map(cc => {
      let max = 0;
      const rows = Math.min(sh.data.length, 5000);
      for (let r = 0; r < rows; r++) {
        const cell = sh.data[r]?.[cc];
        if (!cell?.v) continue;
        if (mergesIn(sh, { r1: r, c1: cc, r2: r, c2: cc }).some(m => m.c1 !== m.c2)) continue;
        const x = cssToX(cell.s);
        probe.style.font = `${x.font?.italic ? 'italic ' : ''}${x.font?.bold ? '700 ' : ''}${x.font?.size ?? font.size}pt "${x.font?.name ?? font.name}",Calibri,Arial`;
        probe.textContent = this.displayText(ev, r, cc).split('\n').reduce((a, b) => b.length > a.length ? b : a, '');
        max = Math.max(max, probe.offsetWidth + 10 + (x.align?.indent ?? 0) * 9);
      }
      return max ? Math.min(800, Math.max(24, Math.ceil(max))) : null;
    });
    probe.remove();
    this.change(() => {
      const arr = sh.colWidths ? [...sh.colWidths] : [];
      cols.forEach((cc, i) => { while (arr.length <= cc) arr.push(null); if (widths[i]) arr[cc] = widths[i]; });
      sh.colWidths = arr;
    }, { full: true });
  }

  /** Автоподбор высоты: снять заданную высоту — строка подстроится под текст. */
  autoFitRows(r: number): void {
    const s = this.sel;
    const rows = s.c1 === 0 && s.c2 >= this.dispCols - 1 && r >= s.r1 && r <= s.r2 ? Array.from({ length: s.r2 - s.r1 + 1 }, (_, i) => s.r1 + i) : [r];
    const sh = this.sheet();
    this.change(() => {
      if (!sh.rowHeights) return;
      const arr = [...sh.rowHeights];
      for (const rr of rows) if (rr < arr.length) arr[rr] = null;
      sh.rowHeights = arr;
    }, { full: true });
    // Строки с переносом текста: меряем фактическую высоту и фиксируем
    requestAnimationFrame(() => {
      const fix: Array<[number, number]> = [];
      for (const rr of rows) {
        const tr = this.elBody.querySelector<HTMLElement>(`tr[data-r="${rr}"]`);
        if (tr && tr.offsetHeight > (sh.defRowH ?? XL_DEF_ROW_PX) + 1) fix.push([rr, tr.offsetHeight]);
      }
      if (!fix.length) return;
      const arr = sh.rowHeights ? [...sh.rowHeights] : [];
      for (const [rr, h] of fix) { while (arr.length <= rr) arr.push(null); arr[rr] = h; }
      sh.rowHeights = arr;
      this.host.commit();
      this.renderGrid(true);
    });
  }

  // ── Маркер заполнения ──────────────────────────────────────────────────

  private startFillDrag(e: MouseEvent): void {
    e.preventDefault(); e.stopPropagation();
    const src = { ...this.sel };
    let target: MergeRange = { ...src };
    const preview = document.createElement('div');
    preview.className = 'xl-fill-preview';
    this.elLayer.appendChild(preview);
    const show = () => {
      const a = this.findTdCovering(target.r1, target.c1), b = this.findTdCovering(target.r2, target.c2);
      if (!a || !b) return;
      const ra = this.tdRect(a), rb = this.tdRect(b);
      Object.assign(preview.style, { left: ra.x + 'px', top: ra.y + 'px', width: (rb.x + rb.w - ra.x) + 'px', height: (rb.y + rb.h - ra.y) + 'px' });
    };
    this.dragTrack(ev => {
      const tt = (ev.target as HTMLElement).closest<HTMLElement>('td[data-c]');
      if (!tt) return;
      const r = +tt.dataset.r!, c = +tt.dataset.c!;
      const dDown = r - src.r2, dUp = src.r1 - r, dRight = c - src.c2, dLeft = src.c1 - c;
      const vert = Math.max(dDown, dUp), hor = Math.max(dRight, dLeft);
      if (vert <= 0 && hor <= 0) target = { ...src };
      else if (vert >= hor) target = dDown > 0 ? { ...src, r2: r } : { ...src, r1: r };
      else target = dRight > 0 ? { ...src, c2: c } : { ...src, c1: c };
      show();
    }, () => {
      preview.remove();
      if (target.r1 === src.r1 && target.r2 === src.r2 && target.c1 === src.c1 && target.c2 === src.c2) return;
      this.autoFill(src, target);
    });
  }

  /** Автозаполнение из src на target (target содержит src). */
  autoFill(src: MergeRange, target: MergeRange): void {
    const sh = this.sheet();
    this.change(() => {
      ensureSize(sh, target.r2 + 1, target.c2 + 1);
      if (target.r2 > src.r2 || target.r1 < src.r1) {
        const down = target.r2 > src.r2;
        const n = down ? target.r2 - src.r2 : src.r1 - target.r1;
        for (let c = src.c1; c <= src.c2; c++) {
          const sample: CellData[] = [];
          for (let r = src.r1; r <= src.r2; r++) sample.push(sh.data[r][c]);
          const out = fillSeries(sample, n, { dr: 1, dc: 0 }, !down);
          out.forEach((cell, k) => { sh.data[down ? src.r2 + 1 + k : src.r1 - 1 - k][c] = cell; });
        }
      } else {
        const right = target.c2 > src.c2;
        const n = right ? target.c2 - src.c2 : src.c1 - target.c1;
        for (let r = src.r1; r <= src.r2; r++) {
          const sample = sh.data[r].slice(src.c1, src.c2 + 1);
          const out = fillSeries(sample, n, { dr: 0, dc: 1 }, !right);
          out.forEach((cell, k) => { sh.data[r][right ? src.c2 + 1 + k : src.c1 - 1 - k] = cell; });
        }
      }
    });
    this.setSel(target, this.cur);
  }

  /** Двойной клик по маркеру: заполнить вниз до конца соседней колонки с данными. */
  private fillDownToRegion(): void {
    const sh = this.sheet(), s = this.sel;
    const probeCol = s.c1 > 0 && sh.data[s.r2 + 1]?.[s.c1 - 1]?.v ? s.c1 - 1 : s.c2 + 1;
    let end = s.r2;
    while (sh.data[end + 1]?.[probeCol]?.v) end++;
    if (end > s.r2) this.autoFill(s, { ...s, r2: end });
  }

  // ═══════════════════════════ Клавиатура ═══════════════════════════

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t !== this.elScroll && !this.elScroll.contains(t)) return;
    if (this.edit || (t !== this.elSink && t.matches('textarea,input,select'))) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const sh = this.sheet();

    if (this.selObj && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); this.deleteSelectedObject(); return; }

    const nav = (dr: number, dc: number) => {
      e.preventDefault();
      let { r, c } = e.shiftKey ? this.extendEnd() : this.cur;
      if (mod) {
        ({ r, c } = this.jump(r, c, dr, dc));
      } else {
        r += dr; c += dc;
        while (dr && r > 0 && r < this.dispRows - 1 && this.isRowHidden(r)) r += dr;
        while (dc && c > 0 && c < this.dispCols - 1 && this.isColHidden(c)) c += dc;
        // Шаг из объединения — сразу за его границу
        const m = mergesIn(sh, { r1: this.cur.r, c1: this.cur.c, r2: this.cur.r, c2: this.cur.c })[0];
        if (m && !e.shiftKey) { if (dr > 0) r = m.r2 + 1; if (dc > 0) c = m.c2 + 1; }
      }
      if (e.shiftKey) this.extendTo(Math.max(0, r), Math.max(0, c));
      else this.selectCell(r, c);
    };

    if (mod && !e.altKey) {
      const key = k.toLowerCase();
      switch (true) {
        case key === 'z' && !e.shiftKey: case key === 'я' && !e.shiftKey: e.preventDefault(); this.host.undo(); return;
        case key === 'y': case key === 'н': case (key === 'z' || key === 'я') && e.shiftKey: e.preventDefault(); this.host.redo(); return;
        case key === 'b': case key === 'и': e.preventDefault(); this.toggleFont('bold'); return;
        case key === 'i': case key === 'ш': e.preventDefault(); this.toggleFont('italic'); return;
        case key === 'u': case key === 'г': e.preventDefault(); this.toggleFont('underline'); return;
        case key === '5': e.preventDefault(); this.toggleFont('strike'); return;
        case key === 'a': case key === 'ф': e.preventDefault(); this.selectAll(); return;
        case key === 'd': case key === 'в': e.preventDefault(); this.fillDir('down'); return;
        case key === 'r': case key === 'к': e.preventDefault(); this.fillDir('right'); return;
        case key === 'f': case key === 'а': e.preventDefault(); this.openFind(false); return;
        case key === 'h': case key === 'р': e.preventDefault(); this.openFind(true); return;
        case key === 'k': case key === 'л': e.preventDefault(); this.editLink(); return;
        case key === '1': e.preventDefault(); this.openFormatDialog(); return;
        case key === '`': case key === 'ё': e.preventDefault(); this.showFormulas = !this.showFormulas; this.renderAll(); return;
        case key === ';' && !e.shiftKey: case key === 'ж' && !e.shiftKey: e.preventDefault(); this.insertNow('date'); return;
        case (key === ';' || key === ':' || key === 'ж') && e.shiftKey: e.preventDefault(); this.insertNow('time'); return;
        case key === ' ': e.preventDefault(); this.setSel({ r1: 0, c1: this.sel.c1, r2: this.dispRows - 1, c2: this.sel.c2 }, this.cur, { scroll: false }); return;
        case key === '-': e.preventDefault(); this.deleteCellsSmart(); return;
        case key === '+' || key === '=' && e.shiftKey: e.preventDefault(); this.insertCellsSmart(); return;
        case key === 'l' && e.shiftKey: case key === 'д' && e.shiftKey: e.preventDefault(); this.toggleFilter(); return;
        case k === 'PageDown': e.preventDefault(); if (this.si() < this.book().sheets.length - 1) this.switchSheet(this.si() + 1); return;
        case k === 'PageUp': e.preventDefault(); if (this.si() > 0) this.switchSheet(this.si() - 1); return;
        case k === 'Home': e.preventDefault(); if (e.shiftKey) this.extendTo(0, 0); else this.selectCell(0, 0); return;
        case k === 'End': {
          e.preventDefault();
          const r = Math.max(0, sh.data.length - 1);
          let c = 0;
          for (const row of sh.data) for (let i = row.length - 1; i >= 0; i--) if (row[i]?.v) { c = Math.max(c, i); break; }
          let lr = 0;
          for (let i = sh.data.length - 1; i >= 0; i--) if (sh.data[i].some(x => x.v)) { lr = i; break; }
          void r;
          if (e.shiftKey) this.extendTo(lr, c); else this.selectCell(lr, c);
          return;
        }
        case k === 'ArrowUp': nav(-1, 0); return;
        case k === 'ArrowDown': nav(1, 0); return;
        case k === 'ArrowLeft': nav(0, -1); return;
        case k === 'ArrowRight': nav(0, 1); return;
      }
      return;
    }
    if (e.altKey && (k === '=' || k === '+')) { e.preventDefault(); this.autoSum('SUM'); return; }
    if (e.shiftKey && k === ' ') { e.preventDefault(); this.setSel({ r1: this.sel.r1, c1: 0, r2: this.sel.r2, c2: this.dispCols - 1 }, this.cur, { scroll: false }); return; }
    if (e.shiftKey && k === 'F11') { e.preventDefault(); this.addSheet(); return; }
    if (e.shiftKey && k === 'F3') { e.preventDefault(); this.openFunctionDialog(); return; }

    switch (k) {
      case 'ArrowUp': nav(-1, 0); return;
      case 'ArrowDown': nav(1, 0); return;
      case 'ArrowLeft': nav(0, -1); return;
      case 'ArrowRight': nav(0, 1); return;
      case 'Tab': e.preventDefault(); this.moveAfterEnter(0, e.shiftKey ? -1 : 1); return;
      case 'Enter': e.preventDefault(); this.moveAfterEnter(e.shiftKey ? -1 : 1, 0); return;
      case 'Home': e.preventDefault(); if (e.shiftKey) this.extendTo(this.cur.r, 0); else this.selectCell(this.cur.r, 0); return;
      case 'PageDown': case 'PageUp': {
        e.preventDefault();
        const page = Math.max(5, Math.floor(this.elScroll.clientHeight / this.zoom / XL_DEF_ROW_PX) - 2);
        const r = Math.max(0, this.cur.r + (k === 'PageDown' ? page : -page));
        if (e.shiftKey) this.extendTo(r, this.cur.c); else this.selectCell(r, this.cur.c);
        return;
      }
      case 'F2': e.preventDefault(); this.startEdit(this.cur.r, this.cur.c, { mode: 'edit' }); return;
      case 'Delete': e.preventDefault(); this.clear('contents'); return;
      case 'Backspace': e.preventDefault(); this.startEdit(this.cur.r, this.cur.c, { initial: '', mode: 'enter' }); return;
      case 'Escape':
        if (this.painter) { this.painter = null; this.updateRibbonState(); }
        if (this.cutMarquee) { this.cutMarquee = false; CLIP = null; this.elBody.classList.remove('xl-cutting'); }
        return;
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault();
      this.startEdit(this.cur.r, this.cur.c, { initial: k, mode: 'enter' });
    }
  }

  /** Подвижный конец выделения (противоположный якорю). */
  private extendEnd(): { r: number; c: number } {
    const s = this.sel;
    return { r: this.anchor.r === s.r1 ? s.r2 : s.r1, c: this.anchor.c === s.c1 ? s.c2 : s.c1 };
  }
  private extendTo(r: number, c: number): void {
    this.setSel({ r1: this.anchor.r, c1: this.anchor.c, r2: r, c2: c }, this.cur, { keepAnchor: true, scroll: false });
    this.scrollIntoView(r, c);
  }

  /** Ctrl+стрелка: к краю блока данных. */
  private jump(r: number, c: number, dr: number, dc: number): { r: number; c: number } {
    const sh = this.sheet();
    const maxR = Math.max(sh.data.length - 1, 0), maxC = Math.max((sh.data[0]?.length ?? 1) - 1, 0);
    const has = (rr: number, cc: number) => !!sh.data[rr]?.[cc]?.v;
    const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= maxR && cc <= maxC;
    let nr = r + dr, nc = c + dc;
    if (!inside(nr, nc)) return { r: dr > 0 ? Math.max(r, maxR) : dr < 0 ? 0 : r, c: dc > 0 ? Math.max(c, maxC) : dc < 0 ? 0 : c };
    if (has(r, c) && has(nr, nc)) {
      while (inside(nr + dr, nc + dc) && has(nr + dr, nc + dc)) { nr += dr; nc += dc; }
      return { r: nr, c: nc };
    }
    while (inside(nr, nc) && !has(nr, nc)) { nr += dr; nc += dc; }
    if (!inside(nr, nc)) return { r: dr > 0 ? maxR : dr < 0 ? 0 : r, c: dc > 0 ? maxC : dc < 0 ? 0 : c };
    return { r: nr, c: nc };
  }

  private insertNow(kind: 'date' | 'time'): void {
    const d = new Date();
    const sh = this.sheet();
    const { r, c } = this.cur;
    this.change(() => {
      ensureSize(sh, r + 1, c + 1);
      const cell = sh.data[r][c];
      if (kind === 'date') sh.data[r][c] = { ...cell, v: String(dateToSerial(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())))), t: 'n', nf: cell.nf && isDateFormat(cell.nf) ? cell.nf : 'dd.mm.yyyy' };
      else sh.data[r][c] = { ...cell, v: String((d.getHours() * 3600 + d.getMinutes() * 60) / 86400), t: 'n', nf: 'hh:mm' };
    });
  }

  // ═══════════════════════════ Буфер обмена ═══════════════════════════

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    e.preventDefault();
    this.copySelection(cut, e.clipboardData);
  }

  /** Скопировать выделение: TSV + HTML (для Excel/Google) + свой формат (формулы, стили). */
  copySelection(cut = false, dt?: DataTransfer | null): void {
    const sh = this.sheet(), s = this.sel;
    const r2 = Math.min(s.r2, Math.max(sh.data.length - 1, s.r1)), c2 = Math.min(s.c2, Math.max((sh.data[0]?.length ?? 1) - 1, s.c1));
    const rg = { ...s, r2, c2 };
    ensureSize(sh, rg.r2 + 1, rg.c2 + 1);
    const block = copyBlock(sh, rg);
    const ev = this.host.evaluator(this.si());
    const texts: string[][] = [];
    let html = '<table>';
    for (let r = rg.r1; r <= rg.r2; r++) {
      if (this.isRowHidden(r)) continue;
      const row: string[] = [];
      html += '<tr>';
      for (let c = rg.c1; c <= rg.c2; c++) {
        const t = this.displayText(ev, r, c);
        row.push(t);
        const cell = sh.data[r][c];
        html += `<td style="${esc(renderCss(cell.s))}">${esc(t)}</td>`;
      }
      texts.push(row);
      html += '</tr>';
    }
    html += '</table>';
    const text = blockToTsv(texts);
    CLIP = { block, text, ...(cut ? { cut: { docId: this.host.docId(), sheet: this.si(), rg } } : {}) };
    this.cutMarquee = cut;
    this.elBody.classList.toggle('xl-cutting', cut);
    if (dt) {
      dt.setData('text/plain', text);
      dt.setData('text/html', `<meta name="simadesk-clip" content="1">${html}`);
    } else {
      navigator.clipboard?.writeText(text).catch(() => { /* без прав — внутренний буфер всё равно есть */ });
    }
    this.host.toast(cut ? 'Вырезано — выберите ячейку и вставьте' : `Скопировано: ${rangeToRef(rg)}`, 'info');
  }

  private onPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const dt = e.clipboardData;
    const file = Array.from(dt?.items ?? []).find(it => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
    if (file) { this.host.fileToDataUrl(file).then(src => this.insertImage(src)); return; }
    const text = dt?.getData('text/plain') ?? '';
    const html = dt?.getData('text/html') ?? '';
    this.pasteFrom(text, html, 'all');
  }

  /** Вставка: свой буфер (с формулами и стилями), таблица из HTML или TSV. */
  pasteFrom(text: string, html: string, mode: PasteMode): void {
    const sh = this.sheet();
    const { r1, c1 } = this.sel;
    const own = CLIP && (text === CLIP.text || (!text && !html) || html.includes('simadesk-clip'));
    let block: ClipBlock | null = null;
    if (own && CLIP) block = CLIP.block;
    else if (html && /<table/i.test(html)) block = this.blockFromHtml(html);
    if (!block && text) {
      const rows = parseTsv(text);
      block = { cells: rows.map(r => r.map(v => interpretInput(v, undefined))), merges: [], srcR: 0, srcC: 0 };
    }
    if (!block) return;
    const cut = own && CLIP?.cut ? CLIP.cut : null;
    const ev = this.host.evaluator(this.si());
    this.change(() => {
      if (cut && cut.docId === this.host.docId()) {
        const src = this.book().sheets[cut.sheet];
        if (src) clearRange(src, cut.rg, 'all');
      }
      const placed = pasteBlock(sh, block!, r1, c1, mode, this.sel, (cell, r, c) => {
        const v = ev.cellValue(r, c);
        const out: CellData = { v: scalarText(v), ...(cell.s ? { s: cell.s } : {}), ...(cell.nf ? { nf: cell.nf } : {}) };
        if (typeof v === 'number') out.t = 'n';
        return out;
      });
      this.sel = placed;
    }, { full: true });
    if (cut) { CLIP = null; this.cutMarquee = false; this.elBody.classList.remove('xl-cutting'); }
    this.setSel(this.sel, { r: this.sel.r1, c: this.sel.c1 });
  }

  /** Таблица из HTML буфера (Excel, Google Таблицы, сайты) — значения и простое оформление. */
  private blockFromHtml(html: string): ClipBlock | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    // Классы Excel → стили из <style>
    const classCss = new Map<string, string>();
    doc.querySelectorAll('style').forEach(st => {
      for (const m of (st.textContent ?? '').matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) classCss.set(m[1], m[2]);
    });
    const cells: CellData[][] = [];
    const merges: MergeRange[] = [];
    const occupied = new Set<string>();
    table.querySelectorAll('tr').forEach((tr, ri) => {
      const row: CellData[] = cells[ri] ?? (cells[ri] = []);
      let ci = 0;
      tr.querySelectorAll('td,th').forEach(td => {
        while (occupied.has(ri + ',' + ci)) ci++;
        const el = td as HTMLElement;
        const css = [...el.classList].map(c => classCss.get(c) ?? '').join(';') + ';' + (el.getAttribute('style') ?? '');
        const x = cssToX(css.replace(/mso-[^;]+;?/g, ''));
        if (td.tagName === 'TH' || el.querySelector('b,strong')) { x.font = { ...(x.font ?? {}), bold: true }; }
        const text = (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ');
        const cell = interpretInput(text.trim() === '' ? '' : text, undefined);
        const s = editCss(undefined, xx => Object.assign(xx, x));
        if (s) cell.s = s;
        const a = el.querySelector('a[href]');
        if (a) cell.link = a.getAttribute('href') ?? undefined;
        row[ci] = cell;
        const rs = +(el.getAttribute('rowspan') ?? 1), cs = +(el.getAttribute('colspan') ?? 1);
        if (rs > 1 || cs > 1) merges.push({ r1: ri, c1: ci, r2: ri + rs - 1, c2: ci + cs - 1 });
        for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
          occupied.add((ri + dr) + ',' + (ci + dc));
          if (dr || dc) { const rr = cells[ri + dr] ?? (cells[ri + dr] = []); rr[ci + dc] = { v: '', ...(cell.s ? { s: cell.s } : {}) }; }
        }
        ci += cs;
      });
    });
    const w = Math.max(...cells.map(r => r.length));
    for (const r of cells) for (let i = 0; i < w; i++) if (!r[i]) r[i] = emptyCell();
    return cells.length ? { cells, merges, srcR: 0, srcC: 0 } : null;
  }

  // ═══════════════════════════ Оформление ═══════════════════════════

  /** Применить изменение стиля ко всем ячейкам выделения. */
  styleSelection(mutate: (x: XStyle, r: number, c: number) => void, rg: MergeRange = this.sel): void {
    const sh = this.sheet();
    const r2 = Math.min(rg.r2, Math.max(rg.r1, sh.data.length + 200));
    const c2 = Math.min(rg.c2, Math.max(rg.c1, (sh.data[0]?.length ?? 0) + 50));
    this.change(() => {
      ensureSize(sh, r2 + 1, c2 + 1);
      for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= c2; c++) {
        const cell = sh.data[r][c];
        const s = editCss(cell.s, x => mutate(x, r, c));
        if (s) cell.s = s; else delete cell.s;
      }
    });
    this.updateRibbonState();
  }

  private curX(): XStyle { return cssToX(this.cell(this.cur.r, this.cur.c)?.s); }

  toggleFont(prop: 'bold' | 'italic' | 'underline' | 'strike'): void {
    const on = !(prop === 'underline' ? this.curX().font?.underline : this.curX().font?.[prop]);
    this.styleSelection(x => {
      x.font = { ...(x.font ?? {}) };
      if (prop === 'underline') { if (on) x.font.underline = 'single'; else delete x.font.underline; }
      else if (on) x.font[prop] = true; else delete x.font[prop];
    });
  }

  setFont(patch: { name?: string; size?: number; color?: string | null }): void {
    this.styleSelection(x => {
      x.font = { ...(x.font ?? {}) };
      if (patch.name !== undefined) x.font.name = patch.name;
      if (patch.size !== undefined) x.font.size = patch.size;
      if (patch.color !== undefined) { if (patch.color) x.font.color = patch.color; else delete x.font.color; }
    });
  }

  private stepFontSize(dir: 1 | -1): void {
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    this.styleSelection(x => {
      const cur = x.font?.size ?? font.size;
      const next = dir > 0 ? FONT_SIZES.find(s => s > cur) ?? cur + 2 : [...FONT_SIZES].reverse().find(s => s < cur) ?? Math.max(1, cur - 1);
      x.font = { ...(x.font ?? {}), size: next };
    });
  }

  setFill(hex: string | null): void {
    this.styleSelection(x => { if (hex) { x.fill = hex; delete x.pattern; } else { delete x.fill; delete x.pattern; } });
  }

  setAlign(patch: Partial<NonNullable<XStyle['align']>>): void {
    this.styleSelection(x => {
      x.align = { ...(x.align ?? {}), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (x.align as Record<string, unknown>)[k];
    });
  }

  private toggleAlignH(h: 'left' | 'center' | 'right'): void {
    const cur = this.curX().align?.h;
    this.setAlign({ h: cur === h ? undefined : h });
  }

  private stepIndent(d: 1 | -1): void {
    this.styleSelection(x => {
      const n = Math.max(0, Math.min(15, (x.align?.indent ?? 0) + d));
      x.align = { ...(x.align ?? {}), indent: n || undefined };
      if (!n) delete x.align.indent;
      if (n && (!x.align.h || x.align.h === 'center')) x.align.h = 'left';
    });
  }

  /** Рамки: тип как в меню Excel. */
  setBorders(kind: 'all' | 'outer' | 'thickOuter' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none' | 'doubleBottom' | 'thickBottom', style: BorderStyle = 'thin', color = '#000000'): void {
    const s = this.sel;
    const b = (st: BorderStyle = style) => ({ style: st, color });
    this.styleSelection((x, r, c) => {
      const brd = { ...(x.border ?? {}) };
      const top = r === s.r1, bottom = r === s.r2, left = c === s.c1, right = c === s.c2;
      switch (kind) {
        case 'none': delete x.border; return;
        case 'all': brd.top = b(); brd.bottom = b(); brd.left = b(); brd.right = b(); break;
        case 'inner':
          if (!top) brd.top = b(); if (!bottom) brd.bottom = b(); if (!left) brd.left = b(); if (!right) brd.right = b(); break;
        case 'outer': case 'thickOuter': {
          const st = kind === 'thickOuter' ? 'medium' : style;
          if (top) brd.top = b(st); if (bottom) brd.bottom = b(st); if (left) brd.left = b(st); if (right) brd.right = b(st); break;
        }
        case 'top': if (top) brd.top = b(); break;
        case 'bottom': if (bottom) brd.bottom = b(); break;
        case 'left': if (left) brd.left = b(); break;
        case 'right': if (right) brd.right = b(); break;
        case 'doubleBottom': if (bottom) brd.bottom = b('double'); break;
        case 'thickBottom': if (bottom) brd.bottom = b('medium'); break;
      }
      x.border = brd;
    });
  }

  setNumFormat(code: string | null): void {
    const sh = this.sheet(), s = this.sel;
    this.change(() => {
      const r2 = Math.min(s.r2, sh.data.length + 200), c2 = Math.min(s.c2, (sh.data[0]?.length ?? 0) + 50);
      ensureSize(sh, r2 + 1, c2 + 1);
      for (let r = s.r1; r <= r2; r++) for (let c = s.c1; c <= c2; c++) {
        const cell = sh.data[r][c];
        if (!code || code === 'General') { delete cell.nf; continue; }
        cell.nf = code;
        if (code === '@') { if (cell.t === 'n') delete cell.t; continue; }
        // Текст, похожий на число, при числовом формате становится числом — как в Excel
        if (cell.t !== 'n' && cell.v && !cell.v.startsWith('=')) {
          const n = parseUserNumber(cell.v);
          if (n !== null) { cell.v = String(n); cell.t = 'n'; }
        }
      }
    });
  }

  /** Добавить/убрать знак после запятой (как кнопки «,0» в Excel). */
  stepDecimals(d: 1 | -1): void {
    const cell = this.cell(this.cur.r, this.cur.c);
    let code = cell?.nf ?? 'General';
    if (code === 'General' || !code) {
      const v = Number(cell?.v);
      const decs = isFinite(v) ? (String(v).split('.')[1]?.length ?? 0) : 0;
      code = decs ? '0.' + '0'.repeat(decs) : '0';
    }
    const next = code.replace(/(0+)(\.(0+))?(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/, (_m, int, _d, dec) => {
      const n = Math.max(0, (dec?.length ?? 0) + d);
      return int + (n ? '.' + '0'.repeat(n) : '');
    });
    this.setNumFormat(next === code && d > 0 ? code + '.0' : next);
  }

  toggleWrap(): void {
    const on = !this.curX().align?.wrap;
    this.setAlign({ wrap: on || undefined });
  }

  // ── Формат по образцу ──────────────────────────────────────────────────

  private startPainter(sticky: boolean): void {
    const sh = this.sheet();
    this.painter = { block: copyBlock(sh, this.sel), sticky };
    this.updateRibbonState();
    this.host.toast('Выделите ячейки, к которым применить формат' + (sticky ? ' (Esc — закончить)' : ''), 'info');
  }

  private applyPainter(rg: MergeRange): void {
    const p = this.painter;
    if (!p) return;
    const sh = this.sheet();
    this.change(() => { pasteBlock(sh, p.block, rg.r1, rg.c1, 'formats', rg); });
    if (!p.sticky) this.painter = null;
    this.updateRibbonState();
  }

  // ── Объединение ───────────────────────────────────────────────────────

  merge(mode: 'center' | 'all' | 'across' | 'unmerge'): void {
    const sh = this.sheet(), s = this.sel;
    if (mode === 'unmerge') { this.change(() => unmergeRange(sh, s)); return; }
    if (s.r1 === s.r2 && s.c1 === s.c2) {
      const m = mergesIn(sh, s)[0];
      if (m) { this.change(() => unmergeRange(sh, m)); }
      return;
    }
    const isMerged = mergesIn(sh, s).some(m => m.r1 === s.r1 && m.c1 === s.c1 && m.r2 === s.r2 && m.c2 === s.c2);
    if (isMerged && mode === 'center') { this.change(() => unmergeRange(sh, s)); return; }
    let filled = 0;
    for (let r = s.r1; r <= Math.min(s.r2, sh.data.length - 1); r++) for (let c = s.c1; c <= s.c2; c++) if (sh.data[r]?.[c]?.v) filled++;
    const go = () => {
      this.change(() => {
        mergeRange(sh, s, mode === 'across' ? 'across' : 'all');
        if (mode === 'center') {
          const cell = sh.data[s.r1][s.c1];
          const st = editCss(cell.s, x => { x.align = { ...(x.align ?? {}), h: 'center' }; });
          if (st) cell.s = st;
        }
      });
    };
    if (filled > 1 && mode !== 'across') {
      showDialog({
        title: 'Объединение ячеек',
        body: '<p class="xd-p">При объединении ячеек сохраняется только значение из левой верхней ячейки, а остальные значения будут потеряны.</p>',
        okLabel: 'Объединить', onOk: () => { go(); },
      });
    } else go();
  }

  // ═══════════════════════════ Строки и колонки ═══════════════════════════

  insertRows(where: 'above' | 'below', count?: number): void {
    const s = this.sel;
    const n = count ?? (s.r2 - s.r1 + 1);
    const at = where === 'above' ? s.r1 : s.r2 + 1;
    this.change(() => {
      shiftSheet(this.book(), this.si(), 'row', at, n);
      // Новая строка наследует оформление соседней — как в Excel
      const sh = this.sheet();
      const from = where === 'above' ? at + n : at - 1;
      if (from >= 0 && sh.data[from]) for (let i = 0; i < n; i++) sh.data[at + i] = sh.data[from].map(c => ({ v: '', ...(c.s ? { s: c.s } : {}), ...(c.nf ? { nf: c.nf } : {}) }));
    }, { full: true });
    this.setSel({ r1: at, c1: s.c1, r2: at + n - 1, c2: s.c2 }, { r: at, c: this.cur.c });
  }

  insertCols(where: 'left' | 'right', count?: number): void {
    const s = this.sel;
    const n = count ?? (s.c2 - s.c1 + 1);
    const at = where === 'left' ? s.c1 : s.c2 + 1;
    this.change(() => {
      shiftSheet(this.book(), this.si(), 'col', at, n);
      const sh = this.sheet();
      const from = where === 'left' ? at + n : at - 1;
      if (from >= 0) for (const row of sh.data) for (let i = 0; i < n; i++) { const c = row[from]; if (c?.s) row[at + i] = { v: '', s: c.s, ...(c.nf ? { nf: c.nf } : {}) }; }
      if (sh.colWidths?.[from]) for (let i = 0; i < n; i++) sh.colWidths[at + i] = sh.colWidths[from];
    }, { full: true });
    this.setSel({ r1: s.r1, c1: at, r2: s.r2, c2: at + n - 1 }, { r: this.cur.r, c: at });
  }

  deleteRows(): void {
    const s = this.sel;
    this.change(() => shiftSheet(this.book(), this.si(), 'row', s.r1, -(Math.min(s.r2, this.sheet().data.length + 1000) - s.r1 + 1)), { full: true });
    this.selectCell(s.r1, this.cur.c);
  }

  deleteCols(): void {
    const s = this.sel;
    this.change(() => shiftSheet(this.book(), this.si(), 'col', s.c1, -(Math.min(s.c2, (this.sheet().data[0]?.length ?? 0) + 100) - s.c1 + 1)), { full: true });
    this.selectCell(this.cur.r, s.c1);
  }

  /** Ctrl+- : строки/колонки целиком, если выделены заголовками, иначе спросить. */
  private deleteCellsSmart(): void {
    const s = this.sel;
    if (s.c1 === 0 && s.c2 >= this.dispCols - 1) return this.deleteRows();
    if (s.r1 === 0 && s.r2 >= this.dispRows - 1) return this.deleteCols();
    showMenu([
      { label: 'Удалить строки целиком', action: () => this.deleteRows() },
      { label: 'Удалить столбцы целиком', action: () => this.deleteCols() },
    ], this.cellScreenPoint());
  }
  private insertCellsSmart(): void {
    const s = this.sel;
    if (s.c1 === 0 && s.c2 >= this.dispCols - 1) return this.insertRows('above');
    if (s.r1 === 0 && s.r2 >= this.dispRows - 1) return this.insertCols('left');
    showMenu([
      { label: 'Вставить строки выше', action: () => this.insertRows('above') },
      { label: 'Вставить столбцы слева', action: () => this.insertCols('left') },
    ], this.cellScreenPoint());
  }
  private cellScreenPoint(): { x: number; y: number } {
    const td = this.findTdCovering(this.cur.r, this.cur.c);
    const r = td?.getBoundingClientRect();
    return r ? { x: r.left, y: r.bottom } : { x: 200, y: 200 };
  }

  hideRowsCols(axis: 'row' | 'col', hide: boolean): void {
    const sh = this.sheet(), s = this.sel;
    this.change(() => {
      if (axis === 'row') {
        const set = new Set(sh.hiddenRows ?? []);
        const lo = hide ? s.r1 : Math.max(0, s.r1 - 1), hi = hide ? s.r2 : s.r2 + 1;
        for (let r = lo; r <= Math.min(hi, sh.data.length + 1000); r++) { if (hide) set.add(r); else set.delete(r); }
        sh.hiddenRows = set.size ? [...set].sort((a, b) => a - b) : undefined;
      } else {
        const set = new Set(sh.hiddenCols ?? []);
        const lo = hide ? s.c1 : Math.max(0, s.c1 - 1), hi = hide ? s.c2 : s.c2 + 1;
        for (let c = lo; c <= Math.min(hi, 16383); c++) { if (hide) set.add(c); else set.delete(c); }
        sh.hiddenCols = set.size ? [...set].sort((a, b) => a - b) : undefined;
      }
    }, { full: true });
  }

  private askSize(axis: 'row' | 'col'): void {
    const cur = axis === 'col' ? this.colW(this.cur.c) : this.rowH(this.cur.r);
    const shown = axis === 'col' ? ((cur - 5) / 7).toFixed(2) : (cur * 0.75).toFixed(2);
    askText(axis === 'col' ? 'Ширина столбца' : 'Высота строки', axis === 'col' ? 'Ширина (в символах, как в Excel):' : 'Высота (в пунктах):', shown, v => {
      const n = parseFloat(v.replace(',', '.'));
      if (!isFinite(n) || n < 0) return;
      const px = axis === 'col' ? Math.round(n * 7 + 5) : Math.round(n / 0.75);
      const sh = this.sheet(), s = this.sel;
      this.change(() => {
        if (axis === 'col') {
          const arr = sh.colWidths ? [...sh.colWidths] : [];
          for (let c = s.c1; c <= Math.min(s.c2, 16383); c++) { while (arr.length <= c) arr.push(null); arr[c] = px; }
          sh.colWidths = arr;
        } else {
          const arr = sh.rowHeights ? [...sh.rowHeights] : [];
          for (let r = s.r1; r <= Math.min(s.r2, sh.data.length + 1000); r++) { while (arr.length <= r) arr.push(null); arr[r] = px; }
          sh.rowHeights = arr;
        }
      }, { full: true });
    });
  }

  // ═══════════════════════════ Правка ═══════════════════════════

  clear(what: 'all' | 'contents' | 'formats'): void {
    const sh = this.sheet();
    this.change(() => clearRange(sh, this.sel, what));
  }

  private fillDir(dir: 'down' | 'right'): void {
    const s = this.sel;
    if (dir === 'down') {
      if (s.r1 === s.r2) { if (s.r1 === 0) return; this.autoFillCopy({ ...s, r1: s.r1 - 1, r2: s.r1 - 1 }, s); return; }
      this.autoFillCopy({ ...s, r2: s.r1 }, { ...s, r1: s.r1 + 1 });
    } else {
      if (s.c1 === s.c2) { if (s.c1 === 0) return; this.autoFillCopy({ ...s, c1: s.c1 - 1, c2: s.c1 - 1 }, s); return; }
      this.autoFillCopy({ ...s, c2: s.c1 }, { ...s, c1: s.c1 + 1 });
    }
  }

  /** Ctrl+D / Ctrl+R: копия (не прогрессия), формулы со сдвигом ссылок. */
  private autoFillCopy(src: MergeRange, target: MergeRange): void {
    const sh = this.sheet();
    this.change(() => {
      ensureSize(sh, target.r2 + 1, target.c2 + 1);
      const blk = copyBlock(sh, src);
      pasteBlock(sh, blk, target.r1, target.c1, 'all', target);
    });
  }

  /** Автосумма: формула под/справа от выделения или в активной ячейке. */
  autoSum(fn: 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN'): void {
    const sh = this.sheet(), s = this.sel;
    const ev = this.host.evaluator(this.si());
    const isNum = (r: number, c: number) => this.numericValue(ev, r, c) !== null;
    if (s.r1 === s.r2 && s.c1 === s.c2) {
      // Одна ячейка: ищем числа сверху, затем слева
      const { r, c } = this.cur;
      let top = r - 1;
      while (top >= 0 && !isNum(top, c) && sh.data[top]?.[c]?.v) top--;
      const end = r - 1;
      let start = end;
      while (start >= 0 && isNum(start, c)) start--;
      let ref = '';
      if (end >= 0 && start < end) ref = `${colLetter(c)}${start + 2}:${colLetter(c)}${end + 1}`;
      else {
        const e2 = c - 1;
        let s2 = e2;
        while (s2 >= 0 && isNum(r, s2)) s2--;
        if (e2 >= 0 && s2 < e2) ref = `${colLetter(s2 + 1)}${r + 1}:${colLetter(e2)}${r + 1}`;
      }
      void top;
      this.startEdit(r, c, { initial: `=${fn}(${ref})`, mode: 'edit' });
      const ta = this.edit?.ta;
      if (ta && !ref) { const p = ta.value.length - 1; ta.setSelectionRange(p, p); }
      return;
    }
    // Диапазон: итог под каждой колонкой (или справа, если выделена одна строка)
    this.change(() => {
      if (s.r1 === s.r2) {
        const c = s.c2 + 1;
        ensureSize(sh, s.r1 + 1, c + 1);
        sh.data[s.r1][c] = { ...sh.data[s.r1][c], v: `=${fn}(${colLetter(s.c1)}${s.r1 + 1}:${colLetter(s.c2)}${s.r1 + 1})` };
      } else {
        const r = s.r2 + 1;
        ensureSize(sh, r + 1, s.c2 + 1);
        for (let c = s.c1; c <= s.c2; c++) {
          let any = false;
          for (let rr = s.r1; rr <= s.r2; rr++) if (isNum(rr, c)) { any = true; break; }
          if (!any) continue;
          sh.data[r][c] = { ...sh.data[r][c], v: `=${fn}(${colLetter(c)}${s.r1 + 1}:${colLetter(c)}${s.r2 + 1})` };
        }
      }
    });
  }

  // ── Сортировка и фильтр ───────────────────────────────────────────────

  /** Диапазон для сортировки: выделение или текущая область. */
  private sortTarget(): { rg: MergeRange; header: boolean } {
    const sh = this.sheet(), s = this.sel;
    if (sh.autoFilter) {
      const af = parseRangeRef(sh.autoFilter);
      if (af && this.cur.r >= af.r1 && this.cur.r <= af.r2) return { rg: { ...af, r2: Math.max(af.r2, this.lastDataRow(af)) }, header: true };
    }
    let rg = s.r1 !== s.r2 || s.c1 !== s.c2 ? { ...s } : currentRegion(sh, this.cur.r, this.cur.c);
    rg = { ...rg, r2: Math.min(rg.r2, sh.data.length - 1), c2: Math.min(rg.c2, (sh.data[0]?.length ?? 1) - 1) };
    return { rg, header: looksLikeHeader(sh, rg) };
  }

  private lastDataRow(af: MergeRange): number {
    const sh = this.sheet();
    let r = af.r2;
    while (r + 1 < sh.data.length && sh.data[r + 1].slice(af.c1, af.c2 + 1).some(c => c.v)) r++;
    return r;
  }

  sort(desc: boolean, keys?: Array<{ col: number; desc?: boolean }>, rgIn?: MergeRange, headerIn?: boolean): void {
    const sh = this.sheet();
    const { rg, header } = rgIn ? { rg: rgIn, header: !!headerIn } : this.sortTarget();
    const body = { ...rg, r1: rg.r1 + (header ? 1 : 0) };
    if (body.r2 <= body.r1) return;
    if (mergesIn(sh, body).length) { this.host.toast('Нельзя сортировать диапазон с объединёнными ячейками', 'error'); return; }
    const ev = this.host.evaluator(this.si());
    this.change(() => sortRows(sh, body, keys ?? [{ col: this.cur.c, desc }], (r, c) => ({ text: this.displayText(ev, r, c), num: this.numericValue(ev, r, c) })));
  }

  toggleFilter(): void {
    const sh = this.sheet();
    if (sh.autoFilter) {
      this.change(() => { delete sh.autoFilter; delete sh.filter; }, { full: true });
      return;
    }
    const { rg } = this.sortTarget();
    this.change(() => { sh.autoFilter = rangeToRef(rg); delete sh.filter; }, { full: true });
  }

  private computeFilterHidden(): Set<number> {
    const sh = this.sheet();
    const out = new Set<number>();
    if (!sh.autoFilter || !sh.filter || !Object.keys(sh.filter).length) return out;
    const af = parseRangeRef(sh.autoFilter);
    if (!af) return out;
    const ev = this.host.evaluator(this.si());
    const last = this.lastDataRow(af);
    for (let r = af.r1 + 1; r <= last; r++) {
      for (const [col, allowed] of Object.entries(sh.filter)) {
        const t = this.displayText(ev, r, +col);
        if (!allowed.includes(t)) { out.add(r); break; }
      }
    }
    return out;
  }

  private openFilterMenu(col: number, btn: HTMLElement): void {
    const sh = this.sheet();
    const af = parseRangeRef(sh.autoFilter ?? '');
    if (!af) return;
    const ev = this.host.evaluator(this.si());
    const last = this.lastDataRow(af);
    const values = new Map<string, number>();
    for (let r = af.r1 + 1; r <= last; r++) { const t = this.displayText(ev, r, col); values.set(t, (values.get(t) ?? 0) + 1); }
    const sorted = [...values.keys()].sort((a, b) => compareForList(a, b));
    const cur = sh.filter?.[String(col)];
    const pop = document.createElement('div');
    pop.className = 'xm-menu xl-filter';
    pop.innerHTML = `
      <div class="xm-item" data-sort="asc"><span class="xm-ic">${IC.sortAsc}</span>Сортировка от А до Я</div>
      <div class="xm-item" data-sort="desc"><span class="xm-ic">${IC.sortDesc}</span>Сортировка от Я до А</div>
      <div class="xm-sep"></div>
      <div class="xm-item${cur ? '' : ' xm-disabled'}" data-clear>Удалить фильтр из «${esc(this.displayText(ev, af.r1, col) || colLetter(col))}»</div>
      <input class="xl-filter-q" placeholder="Поиск">
      <div class="xl-filter-list">
        <label><input type="checkbox" data-all ${!cur ? 'checked' : ''}> (Выделить всё)</label>
        ${sorted.map(v => `<label><input type="checkbox" data-v="${esc(v)}" ${!cur || cur.includes(v) ? 'checked' : ''}> ${esc(v || '(Пустые)')}</label>`).join('')}
      </div>
      <div class="xl-filter-foot"><button class="xd-btn xd-primary" data-ok>ОК</button><button class="xd-btn" data-cancel>Отмена</button></div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 270) + 'px';
    pop.style.top = (r.bottom + 2) + 'px';
    const close = () => { pop.remove(); document.removeEventListener('mousedown', away, true); };
    const away = (e: Event) => { if (!pop.contains(e.target as Node)) close(); };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    const boxes = () => [...pop.querySelectorAll<HTMLInputElement>('input[data-v]')];
    pop.querySelector<HTMLInputElement>('[data-all]')!.addEventListener('change', e => {
      const on = (e.target as HTMLInputElement).checked;
      boxes().forEach(b => { if ((b.parentElement as HTMLElement).style.display !== 'none') b.checked = on; });
    });
    pop.querySelector<HTMLInputElement>('.xl-filter-q')!.addEventListener('input', e => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      boxes().forEach(b => { (b.parentElement as HTMLElement).style.display = !q || b.dataset.v!.toLowerCase().includes(q) ? '' : 'none'; });
    });
    pop.querySelectorAll<HTMLElement>('[data-sort]').forEach(it => it.addEventListener('click', () => {
      close();
      this.sort(it.dataset.sort === 'desc', [{ col, desc: it.dataset.sort === 'desc' }], { ...af, r2: last }, true);
    }));
    pop.querySelector('[data-clear]')!.addEventListener('click', () => {
      close();
      this.change(() => { if (sh.filter) { delete sh.filter[String(col)]; if (!Object.keys(sh.filter).length) delete sh.filter; } }, { full: true });
    });
    pop.querySelector('[data-cancel]')!.addEventListener('click', close);
    pop.querySelector('[data-ok]')!.addEventListener('click', () => {
      const allowed = boxes().filter(b => b.checked).map(b => b.dataset.v!);
      close();
      this.change(() => {
        sh.filter = { ...(sh.filter ?? {}) };
        if (allowed.length === sorted.length) delete sh.filter[String(col)];
        else sh.filter[String(col)] = allowed;
        if (!Object.keys(sh.filter).length) delete sh.filter;
      }, { full: true });
    });
  }

  removeDuplicates(): void {
    const sh = this.sheet();
    const { rg, header } = this.sortTarget();
    const ev = this.host.evaluator(this.si());
    const cols = Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => rg.c1 + i);
    showDialog({
      title: 'Удалить дубликаты',
      body: `<p class="xd-p">Диапазон ${rangeToRef(rg)}${header ? ' (с заголовками)' : ''}. Отметьте столбцы, по которым искать повторы:</p>
        <div class="xd-checks">${cols.map(c => `<label><input type="checkbox" data-col="${c}" checked> ${esc(header ? (this.displayText(ev, rg.r1, c) || 'Столбец ' + colLetter(c)) : 'Столбец ' + colLetter(c))}</label>`).join('')}</div>`,
      okLabel: 'Удалить',
      onOk: root => {
        const keyCols = [...root.querySelectorAll<HTMLInputElement>('[data-col]')].filter(b => b.checked).map(b => +b.dataset.col!);
        if (!keyCols.length) return false;
        const seen = new Set<string>();
        const keep: CellData[][] = [];
        let removed = 0;
        const start = rg.r1 + (header ? 1 : 0);
        for (let r = start; r <= rg.r2; r++) {
          const key = keyCols.map(c => this.displayText(ev, r, c).toLowerCase()).join('\u0001');
          if (seen.has(key)) { removed++; continue; }
          seen.add(key);
          keep.push(sh.data[r].slice(rg.c1, rg.c2 + 1));
        }
        this.change(() => {
          for (let i = 0; i <= rg.r2 - start; i++) {
            const row = keep[i];
            for (let c = rg.c1; c <= rg.c2; c++) sh.data[start + i][c] = row ? row[c - rg.c1] : emptyCell();
          }
        });
        this.host.toast(removed ? `Удалено повторяющихся строк: ${removed}. Осталось уникальных: ${keep.length}` : 'Повторяющихся значений не найдено', 'info');
      },
    });
  }

  // ── Закрепление ───────────────────────────────────────────────────────

  freeze(kind: 'panes' | 'row' | 'col' | 'none'): void {
    const sh = this.sheet();
    this.change(() => {
      if (kind === 'none') delete sh.freeze;
      else if (kind === 'row') sh.freeze = { rows: 1, cols: 0 };
      else if (kind === 'col') sh.freeze = { rows: 0, cols: 1 };
      else {
        const { r, c } = this.cur;
        if (!r && !c) delete sh.freeze; else sh.freeze = { rows: r, cols: c };
      }
    }, { full: true });
  }

  // ═══════════════════════════ Листы ═══════════════════════════

  switchSheet(i: number, o: { keepEdit?: boolean } = {}): void {
    if (!o.keepEdit && this.edit && !this.pointModeActive()) this.commitEdit();
    if (i === this.si()) return;
    this.host.setSheetIdx(i);
    this.selObj = null;
    this.dispRows = 100; this.dispCols = 26;
    this.winStart = this.winEnd = 0;
    this.zoom = (this.sheet().zoom ?? 100) / 100;
    this.elScroll.scrollTop = 0; this.elScroll.scrollLeft = 0;
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 }; this.cur = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 };
    this.renderAll();
    if (this.edit) this.positionEditor();
    this.publishSelection();
  }

  addSheet(after = this.si()): void {
    const book = this.book();
    this.change(() => {
      const name = nextSheetName(book);
      book.sheets.splice(after + 1, 0, { name, data: Array.from({ length: 100 }, () => Array.from({ length: 26 }, emptyCell)) });
    }, { full: true });
    this.switchSheet(after + 1);
  }

  private renameSheetUi(i: number): void {
    const tab = this.elTabs.querySelector<HTMLElement>(`[data-sheet="${i}"] .xl-tab-name`);
    if (!tab) return;
    const old = this.book().sheets[i].name;
    tab.contentEditable = 'true';
    tab.focus();
    const rng = document.createRange(); rng.selectNodeContents(tab);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(rng);
    const done = (save: boolean) => {
      tab.contentEditable = 'false';
      tab.removeEventListener('blur', onBlur);
      const v = (tab.textContent ?? '').trim();
      if (!save || !v || v === old) { tab.textContent = old; return; }
      if (/[\\/?*[\]:]/.test(v) || v.length > 31) { this.host.toast('Имя листа: до 31 символа, без \\ / ? * [ ] :', 'error'); tab.textContent = old; return; }
      if (this.book().sheets.some((s, j) => j !== i && s.name.toLowerCase() === v.toLowerCase())) { this.host.toast('Лист с таким именем уже есть', 'error'); tab.textContent = old; return; }
      this.change(() => renameSheet(this.book(), i, v), { full: true });
    };
    const onBlur = () => done(true);
    tab.addEventListener('blur', onBlur);
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); tab.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); tab.removeEventListener('blur', onBlur); done(false); this.focusGrid(); }
      e.stopPropagation();
    });
  }

  private deleteSheet(i: number): void {
    const book = this.book();
    if (book.sheets.filter(s => !s.hidden).length <= 1) { this.host.toast('В книге должен остаться хотя бы один видимый лист', 'error'); return; }
    const sh = book.sheets[i];
    const hasData = sh.data.some(r => r.some(c => c.v));
    const go = () => {
      this.change(() => { book.sheets.splice(i, 1); }, { full: true });
      this.host.setSheetIdx(Math.max(0, Math.min(i, book.sheets.length - 1)));
      this.switchSheetForce();
    };
    if (hasData) showDialog({ title: 'Удаление листа', body: `<p class="xd-p">Лист «${esc(sh.name)}» будет удалён вместе с данными. Отменить можно через Ctrl+Z.</p>`, okLabel: 'Удалить', onOk: () => { go(); } });
    else go();
  }

  private switchSheetForce(): void {
    this.dispRows = 100; this.dispCols = 26; this.winStart = this.winEnd = 0;
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 }; this.cur = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 };
    this.zoom = (this.sheet().zoom ?? 100) / 100;
    this.renderAll();
  }

  private moveSheet(i: number, to: number): void {
    const book = this.book();
    if (to < 0 || to >= book.sheets.length) return;
    this.change(() => { const [s] = book.sheets.splice(i, 1); book.sheets.splice(to, 0, s); }, { full: true });
    this.host.setSheetIdx(to);
    this.renderAll();
  }

  private renderTabs(): void {
    const book = this.book();
    const cur = this.si();
    this.elTabs.innerHTML = `
      <button class="xl-tab-add" data-add-sheet title="Новый лист (Shift+F11)">+</button>
      <div class="xl-tab-list">${book.sheets.map((s, i) => s.hidden ? '' : `
        <div class="xl-tab${i === cur ? ' on' : ''}" data-sheet="${i}" title="${esc(s.name)}"${s.tabColor ? ` style="--tab:${s.tabColor}"` : ''}>
          <span class="xl-tab-name">${esc(s.name)}</span>
        </div>`).join('')}</div>`;
    this.elTabs.querySelector('[data-add-sheet]')!.addEventListener('click', () => this.addSheet(book.sheets.length - 1));
    this.elTabs.querySelectorAll<HTMLElement>('[data-sheet]').forEach(tab => {
      const i = +tab.dataset.sheet!;
      tab.addEventListener('mousedown', e => {
        if (e.button !== 0 || (e.target as HTMLElement).isContentEditable) return;
        if (this.edit && this.pointModeActive()) { e.preventDefault(); this.switchSheet(i, { keepEdit: true }); return; }
        this.switchSheet(i);
      });
      tab.addEventListener('dblclick', () => this.renameSheetUi(i));
      tab.addEventListener('contextmenu', e => {
        e.preventDefault();
        const hidden = book.sheets.filter(s => s.hidden);
        showMenu([
          { label: 'Вставить лист', action: () => this.addSheet(i) },
          { label: 'Удалить', danger: true, action: () => this.deleteSheet(i) },
          { label: 'Переименовать', action: () => this.renameSheetUi(i) },
          { label: 'Создать копию', action: () => this.change(() => book.sheets.splice(i + 1, 0, cloneSheet(book.sheets[i], uniqueSheetName(book, book.sheets[i].name + ' (2)'))), { full: true }) },
          { label: 'Переместить влево', disabled: i === 0, action: () => this.moveSheet(i, i - 1) },
          { label: 'Переместить вправо', disabled: i === book.sheets.length - 1, action: () => this.moveSheet(i, i + 1) },
          { sep: true },
          { label: 'Цвет ярлычка…', action: () => showColorPicker(tab, { noneLabel: 'Нет цвета', onPick: hex => this.change(() => { if (hex) book.sheets[i].tabColor = hex; else delete book.sheets[i].tabColor; }, { full: true }) }) },
          { label: 'Скрыть', action: () => {
            if (book.sheets.filter(s => !s.hidden).length <= 1) { this.host.toast('Нельзя скрыть единственный видимый лист', 'error'); return; }
            this.change(() => { book.sheets[i].hidden = true; }, { full: true });
            const vis = book.sheets.findIndex(s => !s.hidden);
            this.host.setSheetIdx(vis); this.switchSheetForce();
          } },
          { label: 'Показать…', disabled: !hidden.length, sub: hidden.length ? hidden.map(s => ({ label: s.name, action: () => this.change(() => { delete s.hidden; }, { full: true }) })) : undefined },
        ], { x: e.clientX, y: e.clientY - 4 });
      });
    });
    this.elTabs.querySelector('.xl-tab.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  // ═══════════════════════════ Объекты: диаграммы и картинки ═══════════════════════════

  private objPos(o: { r: number; c: number; dx?: number; dy?: number }): { x: number; y: number } {
    const r = Math.min(o.r, this.dispRows), c = Math.min(o.c, this.dispCols);
    return { x: this.rowHdrW + (this.colLeft[c] ?? 0) + (o.dx ?? 0), y: HDR_H + (this.rowTop[r] ?? 0) + (o.dy ?? 0) };
  }

  /** Данные диаграммы по ссылкам рядов. */
  chartData(ch: ChartSpec): ChartData {
    const book = this.book();
    const si = this.si();
    const values = (ref: string | undefined): Scalar[] => {
      if (!ref) return [];
      const ev = this.host.evaluator(si);
      const v = ev.evaluate('=' + ref);
      return Array.isArray(v) ? v : [v];
    };
    const series = ch.series.map((s, i) => {
      const vals = values(s.valRef).map(v => typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null));
      const name = s.name ?? (s.nameRef ? String(scalarText(values(s.nameRef)[0] ?? '')) : `Ряд ${i + 1}`);
      const xs = ch.kind === 'scatter' && s.catRef ? values(s.catRef).map(v => typeof v === 'number' ? v : null) : undefined;
      return { name, values: vals, color: s.color ?? CHART_COLORS[i % CHART_COLORS.length], ...(xs ? { xs } : {}) };
    });
    const cats = ch.series[0]?.catRef ? values(ch.series[0].catRef).map(v => {
      if (typeof v === 'number') {
        // Даты-подписи показываем датами
        const ref = ch.series[0].catRef!;
        const p = parseRangeRef(ref.replace(/^.*!/, '').replace(/\$/g, ''));
        const nf = p ? book.sheets[si].data[p.r1]?.[p.c1]?.nf : undefined;
        return nf && isDateFormat(nf) ? formatCellValue(String(v), 'n', nf) : generalNumber(v);
      }
      return scalarText(v);
    }) : series[0]?.values.map((_, i) => String(i + 1)) ?? [];
    return { categories: cats, series };
  }

  private renderObjects(): void {
    this.elLayer.querySelectorAll('[data-obj]').forEach(el => el.remove());
    const sh = this.sheet();
    for (const ch of sh.charts ?? []) {
      const p = this.objPos(ch);
      const el = document.createElement('div');
      el.className = 'xl-obj xl-chart' + (this.selObj?.id === ch.id ? ' on' : '');
      el.dataset.obj = ch.id; el.dataset.kind = 'chart';
      Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px', width: ch.w + 'px', height: ch.h + 'px' });
      try { el.innerHTML = renderChartSvg(ch, this.chartData(ch)); }
      catch { el.innerHTML = '<div class="xl-chart-err">Диаграмма: не удалось прочитать данные</div>'; }
      if (this.selObj?.id === ch.id) el.insertAdjacentHTML('beforeend', '<span class="xl-obj-h" data-resize="1"></span>');
      this.elLayer.appendChild(el);
    }
    for (const im of sh.images ?? []) {
      const p = this.objPos(im);
      const el = document.createElement('div');
      el.className = 'xl-obj xl-img' + (this.selObj?.id === im.id ? ' on' : '');
      el.dataset.obj = im.id; el.dataset.kind = 'image';
      Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px', width: im.w + 'px', height: im.h + 'px' });
      el.innerHTML = isSafeImageSrc(im.src) || /^data:image\//.test(im.src) ? `<img src="${esc(im.src)}" alt="" draggable="false">` : '<div class="xl-chart-err">Картинка</div>';
      if (this.selObj?.id === im.id) el.insertAdjacentHTML('beforeend', '<span class="xl-obj-h" data-resize="1"></span>');
      this.elLayer.appendChild(el);
    }
  }

  private findObj(id: string): ChartSpec | FloatImage | undefined {
    const sh = this.sheet();
    return sh.charts?.find(c => c.id === id) ?? sh.images?.find(i => i.id === id);
  }

  private startObjectDrag(e: MouseEvent, el: HTMLElement): void {
    this.commitEdit();
    const id = el.dataset.obj!;
    const kind = el.dataset.kind as 'chart' | 'image';
    const o = this.findObj(id);
    if (!o) return;
    const resize = !!(e.target as HTMLElement).closest('[data-resize]');
    this.selObj = { kind, id };
    this.renderObjects();
    const target = this.elLayer.querySelector<HTMLElement>(`[data-obj="${id}"]`)!;
    const sx = e.clientX, sy = e.clientY;
    const p0 = this.objPos(o);
    const w0 = o.w, h0 = o.h;
    let moved = false;
    let nx = p0.x, ny = p0.y, nw = w0, nh = h0;
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - sx) / this.zoom, dy = (ev.clientY - sy) / this.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (resize) {
        const ratio = kind === 'image' && ev.shiftKey ? w0 / h0 : 0;
        nw = Math.max(40, w0 + dx); nh = Math.max(30, ratio ? nw / ratio : h0 + dy);
        target.style.width = nw + 'px'; target.style.height = nh + 'px';
      } else {
        nx = Math.max(this.rowHdrW, p0.x + dx); ny = Math.max(HDR_H, p0.y + dy);
        target.style.left = nx + 'px'; target.style.top = ny + 'px';
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (!moved) { this.focusGrid(); return; }
      this.change(() => {
        if (resize) { o.w = Math.round(nw); o.h = Math.round(nh); }
        else {
          // Привязка к ячейке под левым верхним углом
          const lx = nx - this.rowHdrW, ly = ny - HDR_H;
          let c = 0; while (c < this.dispCols - 1 && this.colLeft[c + 1] <= lx) c++;
          const r = this.rowAtY(ly);
          o.c = c; o.r = r; o.dx = Math.round(lx - this.colLeft[c]); o.dy = Math.round(ly - this.rowTop[r]);
        }
      });
      this.renderObjects();
      this.focusGrid();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private deleteSelectedObject(): void {
    const so = this.selObj;
    if (!so) return;
    const sh = this.sheet();
    this.change(() => {
      if (so.kind === 'chart') sh.charts = sh.charts?.filter(c => c.id !== so.id);
      else sh.images = sh.images?.filter(i => i.id !== so.id);
      if (!sh.charts?.length) delete sh.charts;
      if (!sh.images?.length) delete sh.images;
    });
    this.selObj = null;
    this.renderObjects();
  }

  /** Вставить диаграмму по выделению: первая строка — имена рядов, первая колонка — подписи. */
  insertChart(kind: ChartKind): void {
    const sh = this.sheet();
    let rg = this.sel;
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2) rg = currentRegion(sh, this.cur.r, this.cur.c);
    rg = { ...rg, r2: Math.min(rg.r2, sh.data.length - 1), c2: Math.min(rg.c2, (sh.data[0]?.length ?? 1) - 1) };
    if (rg.r2 <= rg.r1 && rg.c2 <= rg.c1) { this.host.toast('Выделите данные для диаграммы (подписи и числа)', 'error'); return; }
    const spec = buildChartFromRange(sh, rg, kind, this.host.evaluator(this.si()));
    if (!spec) { this.host.toast('В выделении нет чисел для диаграммы', 'error'); return; }
    spec.r = rg.r1; spec.c = Math.min(rg.c2 + 2, this.dispCols - 1);
    this.change(() => { (sh.charts ??= []).push(spec); });
    this.selObj = { kind: 'chart', id: spec.id };
    this.renderObjects();
  }

  private openChartDialog(id: string): void {
    const ch = this.sheet().charts?.find(c => c.id === id);
    if (!ch) return;
    const kinds: Array<[ChartKind, string]> = [['col', 'Гистограмма'], ['bar', 'Линейчатая'], ['line', 'График'], ['area', 'С областями'], ['pie', 'Круговая'], ['doughnut', 'Кольцевая'], ['scatter', 'Точечная']];
    showDialog({
      title: 'Диаграмма',
      body: `
        <label class="xd-field"><span>Название</span><input class="xd-inp" data-title value="${esc(ch.title ?? '')}"></label>
        <label class="xd-field"><span>Тип</span><select class="xd-inp" data-kind>${kinds.map(([k, n]) => `<option value="${k}"${k === ch.kind ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="xd-check"><input type="checkbox" data-legend ${ch.legend !== false ? 'checked' : ''}> Легенда</label>
        <label class="xd-check"><input type="checkbox" data-stacked ${ch.stacked ? 'checked' : ''}> С накоплением</label>
        <div class="xd-sub">Ряды данных</div>
        ${ch.series.map((s, i) => `<div class="xd-row">
          <input class="xd-inp" data-sname="${i}" value="${esc(s.name ?? s.nameRef ?? '')}" placeholder="Имя ряда">
          <input class="xd-inp" data-sval="${i}" value="${esc(s.valRef)}" placeholder="Значения: B2:B10">
          <input class="xd-inp" data-scat="${i}" value="${esc(s.catRef ?? '')}" placeholder="Подписи: A2:A10">
        </div>`).join('')}`,
      wide: true,
      okLabel: 'Применить',
      onOk: root => {
        const g = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
        this.change(() => {
          ch.title = g<HTMLInputElement>('[data-title]').value.trim() || undefined;
          ch.kind = g<HTMLSelectElement>('[data-kind]').value as ChartKind;
          ch.legend = g<HTMLInputElement>('[data-legend]').checked;
          ch.stacked = g<HTMLInputElement>('[data-stacked]').checked || undefined;
          ch.series = ch.series.map((s, i) => {
            const name = g<HTMLInputElement>(`[data-sname="${i}"]`).value.trim();
            const isRef = /^('?[^']+'?!)?\$?[A-Za-z]{1,3}\$?\d+$/.test(name);
            return {
              ...s,
              valRef: g<HTMLInputElement>(`[data-sval="${i}"]`).value.trim() || s.valRef,
              catRef: g<HTMLInputElement>(`[data-scat="${i}"]`).value.trim() || undefined,
              name: isRef ? undefined : name || undefined,
              nameRef: isRef ? name : undefined,
            };
          });
        });
        this.renderObjects();
      },
    });
  }

  async insertImage(src: string): Promise<void> {
    try {
      const pic = await this.host.prepareImage(src, 900);
      const sh = this.sheet();
      const w = Math.min(pic.w ?? 320, 480), h = pic.w && pic.h ? Math.round(w * pic.h / pic.w) : 240;
      const img: FloatImage = { id: uid('img'), src: pic.dataUrl, r: this.cur.r, c: this.cur.c, dx: 2, dy: 2, w, h };
      this.change(() => { (sh.images ??= []).push(img); });
      this.selObj = { kind: 'image', id: img.id };
      this.renderObjects();
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : 'Не удалось вставить картинку', 'error');
    }
  }

  private pickImage(): void {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (f) this.insertImage(await this.host.fileToDataUrl(f));
    });
    inp.click();
  }

  // ═══════════════════════════ Ссылки и примечания ═══════════════════════════

  editLink(): void {
    const { r, c } = this.cur;
    const cell = this.cell(r, c);
    showDialog({
      title: 'Гиперссылка',
      body: `<label class="xd-field"><span>Текст</span><input class="xd-inp" data-text value="${esc(cell?.v && !cell.v.startsWith('=') ? cell.v : '')}"></label>
        <label class="xd-field"><span>Адрес</span><input class="xd-inp" data-url value="${esc(cell?.link ?? 'https://')}" placeholder="https://…"></label>`,
      okLabel: 'ОК',
      onOk: root => {
        const text = root.querySelector<HTMLInputElement>('[data-text]')!.value;
        const url = root.querySelector<HTMLInputElement>('[data-url]')!.value.trim();
        const sh = this.sheet();
        this.change(() => {
          ensureSize(sh, r + 1, c + 1);
          const cur = sh.data[r][c];
          const next: CellData = { ...cur, v: text || url };
          delete next.t;
          if (url && url !== 'https://') next.link = url; else delete next.link;
          sh.data[r][c] = next;
        });
      },
    });
  }

  editNote(): void {
    const { r, c } = this.cur;
    const cell = this.cell(r, c);
    showDialog({
      title: 'Примечание к ячейке ' + colLetter(c) + (r + 1),
      body: `<textarea class="xd-inp xd-area" data-note rows="5">${esc(cell?.note ?? '')}</textarea>`,
      okLabel: 'Сохранить',
      onOk: root => {
        const note = root.querySelector<HTMLTextAreaElement>('[data-note]')!.value.trim();
        const sh = this.sheet();
        this.change(() => { ensureSize(sh, r + 1, c + 1); if (note) sh.data[r][c].note = note; else delete sh.data[r][c].note; });
      },
    });
  }

  // ═══════════════════════════ Поиск и замена ═══════════════════════════

  openFind(replace: boolean): void {
    let hits: Array<{ s: number; r: number; c: number }> = [];
    let idx = -1;
    showDialog({
      title: 'Найти и заменить',
      wide: true,
      body: `
        <label class="xd-field"><span>Найти</span><input class="xd-inp" data-q></label>
        <label class="xd-field" data-repl-row style="${replace ? '' : 'display:none'}"><span>Заменить на</span><input class="xd-inp" data-r></label>
        <div class="xd-row xd-opts">
          <label class="xd-check"><input type="checkbox" data-case> Учитывать регистр</label>
          <label class="xd-check"><input type="checkbox" data-whole> Ячейка целиком</label>
          <label class="xd-check"><input type="checkbox" data-all> Во всей книге</label>
          <label class="xd-check"><input type="checkbox" data-formulas> Искать в формулах</label>
        </div>
        <div class="xd-row"><button class="xd-btn" data-next>Найти далее</button><button class="xd-btn" data-findall>Найти все</button>
          <button class="xd-btn" data-one style="${replace ? '' : 'display:none'}">Заменить</button><button class="xd-btn" data-replall style="${replace ? '' : 'display:none'}">Заменить все</button>
          <button class="xd-btn" data-toggle>${replace ? 'Только поиск' : 'Заменить…'}</button></div>
        <div class="xd-found" data-found></div>`,
      onMount: (root) => {
        const g = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
        const q = g<HTMLInputElement>('[data-q]');
        const book = this.book();
        const match = (text: string) => {
          const needle = q.value;
          if (!needle) return false;
          const cs = g<HTMLInputElement>('[data-case]').checked;
          const a = cs ? text : text.toLowerCase(), b = cs ? needle : needle.toLowerCase();
          if (g<HTMLInputElement>('[data-whole]').checked) return a === b;
          if (/[*?]/.test(b)) return new RegExp('^.*' + b.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '.*$', cs ? '' : 'i').test(text);
          return a.includes(b);
        };
        const textOf = (s: number, r: number, c: number) => {
          const cell = book.sheets[s].data[r]?.[c];
          if (!cell?.v) return '';
          if (g<HTMLInputElement>('[data-formulas]').checked || !cell.v.startsWith('=')) return cell.v;
          const ev = this.host.evaluator(s);
          const v = ev.cellValue(r, c);
          return typeof v === 'number' ? formatCellValue(String(v), 'n', cell.nf) : scalarText(v);
        };
        const search = () => {
          hits = [];
          const sheets = g<HTMLInputElement>('[data-all]').checked ? book.sheets.map((_, i) => i) : [this.si()];
          for (const s of sheets) book.sheets[s].data.forEach((row, r) => row.forEach((_cell, c) => { if (match(textOf(s, r, c))) hits.push({ s, r, c }); }));
          idx = -1;
        };
        const go = (h: { s: number; r: number; c: number }) => {
          if (h.s !== this.si()) this.switchSheet(h.s);
          this.selectCell(h.r, h.c);
        };
        const found = g<HTMLElement>('[data-found]');
        const showList = () => {
          found.innerHTML = hits.length
            ? `<div class="xd-found-head">Найдено ячеек: ${hits.length}</div>` + hits.slice(0, 300).map((h, i) => `<div class="xd-found-row" data-h="${i}"><b>${esc(book.sheets[h.s].name)}!${colLetter(h.c)}${h.r + 1}</b><span>${esc(textOf(h.s, h.r, h.c).slice(0, 80))}</span></div>`).join('')
            : '<div class="xd-found-head">Ничего не найдено</div>';
          found.querySelectorAll<HTMLElement>('[data-h]').forEach(el => el.addEventListener('click', () => { idx = +el.dataset.h!; go(hits[idx]); }));
        };
        g('[data-next]').addEventListener('click', () => {
          search();
          if (!hits.length) { found.innerHTML = '<div class="xd-found-head">Ничего не найдено</div>'; return; }
          const after = hits.findIndex(h => h.s === this.si() && (h.r > this.cur.r || (h.r === this.cur.r && h.c > this.cur.c)));
          idx = after >= 0 ? after : 0;
          go(hits[idx]);
          found.innerHTML = `<div class="xd-found-head">${idx + 1} из ${hits.length}</div>`;
        });
        g('[data-findall]').addEventListener('click', () => { search(); showList(); });
        const replaceIn = (h: { s: number; r: number; c: number }) => {
          const cell = book.sheets[h.s].data[h.r][h.c];
          const rep = g<HTMLInputElement>('[data-r]').value;
          if (g<HTMLInputElement>('[data-whole]').checked) { book.sheets[h.s].data[h.r][h.c] = interpretInput(rep, cell); return; }
          const cs = g<HTMLInputElement>('[data-case]').checked;
          const re = new RegExp(q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
          const nv = cell.v.replace(re, rep);
          if (nv !== cell.v) book.sheets[h.s].data[h.r][h.c] = cell.v.startsWith('=') ? { ...cell, v: nv } : interpretInput(nv, cell);
        };
        g('[data-one]').addEventListener('click', () => {
          search();
          const h = hits.find(x => x.s === this.si() && x.r === this.cur.r && x.c === this.cur.c) ?? hits[0];
          if (!h) { found.innerHTML = '<div class="xd-found-head">Ничего не найдено</div>'; return; }
          this.change(() => replaceIn(h));
          search();
          const nx = hits[0];
          if (nx) go(nx);
          found.innerHTML = `<div class="xd-found-head">Заменено. Осталось: ${hits.length}</div>`;
        });
        g('[data-replall]').addEventListener('click', () => {
          search();
          const n = hits.length;
          if (!n) { found.innerHTML = '<div class="xd-found-head">Ничего не найдено</div>'; return; }
          this.change(() => hits.forEach(replaceIn), { full: true });
          found.innerHTML = `<div class="xd-found-head">Выполнено замен: ${n}</div>`;
        });
        g('[data-toggle]').addEventListener('click', () => {
          const on = g<HTMLElement>('[data-repl-row]').style.display === 'none';
          g<HTMLElement>('[data-repl-row]').style.display = on ? '' : 'none';
          g<HTMLElement>('[data-one]').style.display = on ? '' : 'none';
          g<HTMLElement>('[data-replall]').style.display = on ? '' : 'none';
          g<HTMLElement>('[data-toggle]').textContent = on ? 'Только поиск' : 'Заменить…';
        });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); g('[data-next]').click(); } });
      },
    });
  }

  // ═══════════════════════════ Диалоги ═══════════════════════════

  openFunctionDialog(): void {
    const cats: Record<string, string[]> = {
      'Часто используемые': ['SUM', 'AVERAGE', 'IF', 'COUNT', 'MAX', 'MIN', 'VLOOKUP', 'SUMIF', 'COUNTIF', 'ROUND', 'IFERROR', 'CONCAT'],
      'Математические': ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ', 'PRODUCT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MROUND', 'CEILING', 'FLOOR', 'INT', 'TRUNC', 'ABS', 'SQRT', 'POWER', 'MOD', 'QUOTIENT', 'SIGN', 'EXP', 'LN', 'LOG', 'LOG10', 'PI', 'RAND', 'RANDBETWEEN', 'EVEN', 'ODD', 'SUBTOTAL'],
      'Статистические': ['AVERAGE', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'MAX', 'MAXIFS', 'MIN', 'MINIFS', 'MEDIAN', 'MODE', 'LARGE', 'SMALL', 'RANK', 'STDEV', 'STDEV.S', 'STDEV.P', 'VAR', 'VAR.S', 'VAR.P', 'PERCENTILE', 'QUARTILE'],
      'Логические': ['IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'XOR'],
      'Ссылки и массивы': ['VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'CHOOSE', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'HYPERLINK'],
      'Текстовые': ['CONCAT', 'CONCATENATE', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'PROPER', 'SUBSTITUTE', 'REPLACE', 'FIND', 'SEARCH', 'EXACT', 'REPT', 'TEXT', 'VALUE', 'CHAR', 'CODE', 'CLEAN'],
      'Дата и время': ['TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'WEEKNUM', 'DAYS', 'EDATE', 'EOMONTH', 'DATEDIF', 'NETWORKDAYS'],
      'Проверка свойств': ['ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISERROR', 'ISNA', 'ISLOGICAL', 'ISEVEN', 'ISODD', 'NA', 'N', 'T'],
    };
    const ruOf = (en: string) => Object.entries(RU_HINTS).find(([, e]) => e === en)?.[0];
    showDialog({
      title: 'Вставка функции',
      wide: true,
      body: `<input class="xd-inp" data-q placeholder="Поиск функции: сумм, впр, дата…">
        <div class="xd-fn"><div class="xd-fn-cats">${Object.keys(cats).map((c, i) => `<div class="xd-fn-cat${i === 0 ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</div>`).join('')}</div>
        <div class="xd-fn-list" data-list></div></div>
        <div class="xd-fn-desc" data-desc></div>`,
      okLabel: 'Вставить',
      onMount: (root, close) => {
        const list = root.querySelector<HTMLElement>('[data-list]')!;
        const desc = root.querySelector<HTMLElement>('[data-desc]')!;
        let picked = '';
        const fill = (names: string[]) => {
          list.innerHTML = names.map((n, i) => `<div class="xd-fn-i${i === 0 ? ' on' : ''}" data-fn="${n}"><b>${n}</b>${ruOf(n) ? `<span>${ruOf(n)}</span>` : ''}</div>`).join('');
          picked = names[0] ?? '';
          desc.textContent = picked ? `${picked}${FN_HINTS[picked] ?? ''}` : '';
          list.querySelectorAll<HTMLElement>('[data-fn]').forEach(el => {
            el.addEventListener('click', () => { list.querySelectorAll('.on').forEach(x => x.classList.remove('on')); el.classList.add('on'); picked = el.dataset.fn!; desc.textContent = `${picked}${FN_HINTS[picked] ?? ''}`; });
            el.addEventListener('dblclick', () => { insert(); close(); });
          });
        };
        const insert = () => {
          if (!picked) return;
          const { r, c } = this.cur;
          if (this.edit) { const el = this.edit.viaBar ? this.elFx : this.edit.ta; this.insertAtCaret(el, picked + '('); }
          else this.startEdit(r, c, { initial: `=${picked}(`, mode: 'edit' });
        };
        root.querySelectorAll<HTMLElement>('[data-cat]').forEach(el => el.addEventListener('click', () => {
          root.querySelectorAll('.xd-fn-cat.on').forEach(x => x.classList.remove('on')); el.classList.add('on'); fill(cats[el.dataset.cat!]);
        }));
        root.querySelector<HTMLInputElement>('[data-q]')!.addEventListener('input', e => {
          const qv = (e.target as HTMLInputElement).value.trim().toUpperCase();
          if (!qv) { fill(cats['Часто используемые']); return; }
          const set = new Set<string>();
          FUNCTION_NAMES.forEach(f => { if (f.includes(qv)) set.add(f); });
          Object.entries(RU_HINTS).forEach(([ru, en]) => { if (ru.includes(qv)) set.add(en); });
          fill([...set]);
        });
        fill(cats['Часто используемые']);
        const okBtn = root.querySelector<HTMLElement>('[data-ok]');
        okBtn?.addEventListener('click', insert, { capture: true });
      },
      onOk: () => { /* вставка — в обработчике выше */ },
    });
  }

  /** Формат ячеек (Ctrl+1): число, выравнивание, шрифт. */
  openFormatDialog(): void {
    const cell = this.cell(this.cur.r, this.cur.c);
    const x = this.curX();
    const nf = cell?.nf ?? 'General';
    const catOf = (code: string) => code === 'General' ? 'general' : code === '@' ? 'text' : code.includes('%') ? 'percent' : isDateFormat(code) ? (/h/i.test(code) && !/[dy]/i.test(code) ? 'time' : 'date') : /₽|"\$"|€|\[\$/.test(code) ? 'currency' : /[0#]/.test(code) ? 'number' : 'custom';
    const decimals = (code: string) => code.match(/\.(0+)/)?.[1].length ?? 0;
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    const sample = this.numericValue(this.host.evaluator(this.si()), this.cur.r, this.cur.c) ?? 1234.5;
    showDialog({
      title: 'Формат ячеек',
      wide: true,
      body: `
        <div class="xd-tabs"><span class="on" data-tab="num">Число</span><span data-tab="align">Выравнивание</span><span data-tab="font">Шрифт</span></div>
        <div data-pane="num">
          <div class="xd-row">
            <select class="xd-inp" data-cat size="8" style="width:170px">
              ${[['general', 'Общий'], ['number', 'Числовой'], ['currency', 'Денежный'], ['date', 'Дата'], ['time', 'Время'], ['percent', 'Процентный'], ['text', 'Текстовый'], ['custom', '(все форматы)']].map(([k, n]) => `<option value="${k}"${catOf(nf) === k ? ' selected' : ''}>${n}</option>`).join('')}
            </select>
            <div class="xd-col">
              <div class="xd-sample">Образец: <b data-sample></b></div>
              <label class="xd-field" data-dec-row><span>Число десятичных знаков</span><input class="xd-inp" type="number" min="0" max="10" data-dec value="${decimals(nf)}"></label>
              <label class="xd-check" data-sep-row><input type="checkbox" data-sep ${/#,##/.test(nf) ? 'checked' : ''}> Разделитель групп разрядов ( )</label>
              <label class="xd-field" data-cur-row><span>Обозначение</span><select class="xd-inp" data-cur><option value="₽">₽ Российский рубль</option><option value="$">$ Доллар США</option><option value="€">€ Евро</option><option value="">Нет</option></select></label>
              <label class="xd-field" data-date-row><span>Тип</span><select class="xd-inp" data-datefmt>
                ${['dd.mm.yyyy', 'd mmmm yyyy', 'dd.mm.yy', 'mmmm yyyy', 'dd.mm.yyyy hh:mm', 'dddd, d mmmm yyyy'].map(f => `<option${f === nf ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
              <label class="xd-field" data-time-row><span>Тип</span><select class="xd-inp" data-timefmt>${['hh:mm', 'hh:mm:ss', 'h:mm AM/PM', '[h]:mm'].map(f => `<option${f === nf ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
              <label class="xd-field" data-custom-row><span>Код формата</span><input class="xd-inp" data-code value="${esc(nf)}"></label>
            </div>
          </div>
        </div>
        <div data-pane="align" style="display:none">
          <label class="xd-field"><span>По горизонтали</span><select class="xd-inp" data-h>${[['', 'обычное'], ['left', 'по левому краю (отступ)'], ['center', 'по центру'], ['right', 'по правому краю'], ['justify', 'по ширине'], ['centerContinuous', 'по центру выделения'], ['fill', 'с заполнением']].map(([k, n]) => `<option value="${k}"${(x.align?.h ?? '') === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="xd-field"><span>По вертикали</span><select class="xd-inp" data-v>${[['bottom', 'по нижнему краю'], ['middle', 'по центру'], ['top', 'по верхнему краю']].map(([k, n]) => `<option value="${k}"${(x.align?.v ?? 'bottom') === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="xd-field"><span>Отступ</span><input class="xd-inp" type="number" min="0" max="15" data-indent value="${x.align?.indent ?? 0}"></label>
          <label class="xd-check"><input type="checkbox" data-wrap ${x.align?.wrap ? 'checked' : ''}> Переносить по словам</label>
          <label class="xd-check"><input type="checkbox" data-shrink ${x.align?.shrink ? 'checked' : ''}> Автоподбор ширины</label>
          <label class="xd-field"><span>Ориентация (градусы, 255 — вертикально)</span><input class="xd-inp" type="number" min="-90" max="255" data-rot value="${x.align?.rotate ?? 0}"></label>
        </div>
        <div data-pane="font" style="display:none">
          <label class="xd-field"><span>Шрифт</span><input class="xd-inp" data-fname list="xl-fonts" value="${esc(x.font?.name ?? font.name)}"><datalist id="xl-fonts">${DEF_FONTS.map(f => `<option>${f}</option>`).join('')}</datalist></label>
          <label class="xd-field"><span>Размер</span><input class="xd-inp" type="number" min="1" max="409" step="0.5" data-fsize value="${x.font?.size ?? font.size}"></label>
          <div class="xd-row">
            <label class="xd-check"><input type="checkbox" data-fb ${x.font?.bold ? 'checked' : ''}> Полужирный</label>
            <label class="xd-check"><input type="checkbox" data-fi ${x.font?.italic ? 'checked' : ''}> Курсив</label>
            <label class="xd-check"><input type="checkbox" data-fs ${x.font?.strike ? 'checked' : ''}> Зачёркнутый</label>
          </div>
          <label class="xd-field"><span>Подчёркивание</span><select class="xd-inp" data-fu>${[['', 'Нет'], ['single', 'Одинарное'], ['double', 'Двойное'], ['singleAccounting', 'Одинарное по значению'], ['doubleAccounting', 'Двойное по значению']].map(([k, n]) => `<option value="${k}"${(x.font?.underline ?? '') === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="xd-field"><span>Цвет</span><input class="xd-inp" type="color" data-fc value="${x.font?.color ?? '#000000'}"></label>
          <div class="xd-row">
            <label class="xd-check"><input type="checkbox" data-sup ${x.font?.vertAlign === 'superscript' ? 'checked' : ''}> Надстрочный</label>
            <label class="xd-check"><input type="checkbox" data-sub ${x.font?.vertAlign === 'subscript' ? 'checked' : ''}> Подстрочный</label>
          </div>
        </div>`,
      onMount: root => {
        const g = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
        root.querySelectorAll<HTMLElement>('[data-tab]').forEach(t => t.addEventListener('click', () => {
          root.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === t));
          root.querySelectorAll<HTMLElement>('[data-pane]').forEach(p => p.style.display = p.dataset.pane === t.dataset.tab ? '' : 'none');
        }));
        const update = () => {
          const cat = g<HTMLSelectElement>('[data-cat]').value;
          const show = (sel: string, on: boolean) => { g<HTMLElement>(sel).style.display = on ? '' : 'none'; };
          show('[data-dec-row]', ['number', 'currency', 'percent'].includes(cat));
          show('[data-sep-row]', cat === 'number');
          show('[data-cur-row]', cat === 'currency');
          show('[data-date-row]', cat === 'date');
          show('[data-time-row]', cat === 'time');
          show('[data-custom-row]', cat === 'custom');
          const code = buildCode();
          if (cat !== 'custom') g<HTMLInputElement>('[data-code]').value = code;
          g<HTMLElement>('[data-sample]').textContent = code === '@' ? String(sample) : formatCellValue(String(sample), 'n', code);
        };
        const buildCode = (): string => {
          const cat = g<HTMLSelectElement>('[data-cat]').value;
          const d = Math.max(0, Math.min(10, +g<HTMLInputElement>('[data-dec]').value || 0));
          const dec = d ? '.' + '0'.repeat(d) : '';
          switch (cat) {
            case 'general': return 'General';
            case 'number': return (g<HTMLInputElement>('[data-sep]').checked ? '#,##0' : '0') + dec;
            case 'currency': { const s = g<HTMLSelectElement>('[data-cur]').value; return s === '$' ? `"$"#,##0${dec}` : s ? `#,##0${dec}\\ "${s}"` : `#,##0${dec}`; }
            case 'percent': return '0' + dec + '%';
            case 'date': return g<HTMLSelectElement>('[data-datefmt]').value;
            case 'time': return g<HTMLSelectElement>('[data-timefmt]').value;
            case 'text': return '@';
            default: return g<HTMLInputElement>('[data-code]').value || 'General';
          }
        };
        root.querySelectorAll('[data-pane="num"] input, [data-pane="num"] select').forEach(el => el.addEventListener('input', update));
        g('[data-cat]').addEventListener('change', update);
        update();
        (root as HTMLElement & { _code?: () => string })._code = buildCode;
      },
      onOk: root => {
        const g = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
        const code = (root as HTMLElement & { _code?: () => string })._code?.() ?? 'General';
        if (code !== (cell?.nf ?? 'General')) this.setNumFormat(code);
        const h = g<HTMLSelectElement>('[data-h]').value, v = g<HTMLSelectElement>('[data-v]').value;
        const indent = +g<HTMLInputElement>('[data-indent]').value || 0;
        const rot = +g<HTMLInputElement>('[data-rot]').value || 0;
        this.styleSelection(xx => {
          xx.align = {
            ...(h ? { h: h as NonNullable<XStyle['align']>['h'] } : {}),
            ...(v && v !== 'bottom' ? { v: v as NonNullable<XStyle['align']>['v'] } : {}),
            ...(g<HTMLInputElement>('[data-wrap]').checked ? { wrap: true } : {}),
            ...(indent ? { indent } : {}),
            ...(rot ? { rotate: rot } : {}),
            ...(g<HTMLInputElement>('[data-shrink]').checked ? { shrink: true } : {}),
          };
          const name = g<HTMLInputElement>('[data-fname]').value.trim();
          const size = parseFloat(g<HTMLInputElement>('[data-fsize]').value);
          const u = g<HTMLSelectElement>('[data-fu]').value;
          const color = g<HTMLInputElement>('[data-fc]').value;
          xx.font = {
            ...(name && name !== font.name ? { name } : {}),
            ...(size && size !== font.size ? { size } : {}),
            ...(g<HTMLInputElement>('[data-fb]').checked ? { bold: true } : {}),
            ...(g<HTMLInputElement>('[data-fi]').checked ? { italic: true } : {}),
            ...(g<HTMLInputElement>('[data-fs]').checked ? { strike: true } : {}),
            ...(u ? { underline: u as NonNullable<XStyle['font']>['underline'] } : {}),
            ...(color && color !== '#000000' ? { color } : (x.font?.color && color !== '#000000' ? { color: x.font.color } : {})),
            ...(g<HTMLInputElement>('[data-sup]').checked ? { vertAlign: 'superscript' as const } : g<HTMLInputElement>('[data-sub]').checked ? { vertAlign: 'subscript' as const } : {}),
          };
        });
      },
    });
  }

  /** «Форматировать как таблицу»: шапка, чередование строк, фильтр. */
  formatAsTable(accent = '#4472c4'): void {
    const sh = this.sheet();
    let rg = this.sel;
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2) rg = currentRegion(sh, this.cur.r, this.cur.c);
    const light = mixWhite(accent, 0.82);
    this.change(() => {
      ensureSize(sh, rg.r2 + 1, rg.c2 + 1);
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
        const cell = sh.data[r][c];
        const s = editCss(cell.s, x => {
          const thin = { style: 'thin' as BorderStyle, color: mixWhite(accent, 0.4) };
          if (r === rg.r1) { x.fill = accent; x.font = { ...(x.font ?? {}), bold: true, color: '#ffffff' }; }
          else if ((r - rg.r1) % 2 === 0) x.fill = light;
          else delete x.fill;
          x.border = { ...(x.border ?? {}), bottom: thin, top: r === rg.r1 ? thin : x.border?.top };
        });
        if (s) cell.s = s;
      }
      sh.autoFilter = rangeToRef(rg);
    }, { full: true });
  }

  // ═══════════════════════════ Контекстное меню ═══════════════════════════

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const t = e.target as HTMLElement;
    const obj = t.closest<HTMLElement>('[data-obj]');
    if (obj) {
      this.selObj = { kind: obj.dataset.kind as 'chart' | 'image', id: obj.dataset.obj! };
      this.renderObjects();
      showMenu([
        ...(obj.dataset.kind === 'chart' ? [{ label: 'Изменить диаграмму…', action: () => this.openChartDialog(obj.dataset.obj!) }] : []),
        { label: 'Удалить', danger: true, action: () => this.deleteSelectedObject() },
      ], { x: e.clientX, y: e.clientY });
      return;
    }
    const isCol = !!t.closest('th.xl-ch'), isRow = !!t.closest('th.xl-rh');
    const clipboard: MenuItem[] = [
      { label: 'Вырезать', icon: IC.cut, hint: 'Ctrl+X', action: () => this.copySelection(true) },
      { label: 'Копировать', icon: IC.copy, hint: 'Ctrl+C', action: () => this.copySelection(false) },
      { label: 'Вставить', icon: IC.paste, hint: 'Ctrl+V', action: () => this.pasteFromSystem('all') },
      { label: 'Специальная вставка', sub: [
        { label: 'Значения', action: () => this.pasteFromSystem('values') },
        { label: 'Форматы', action: () => this.pasteFromSystem('formats') },
        { label: 'Формулы', action: () => this.pasteFromSystem('formulas') },
      ] },
      { sep: true },
    ];
    let items: MenuItem[];
    if (isCol) {
      items = [...clipboard,
        { label: 'Вставить столбцы', action: () => this.insertCols('left') },
        { label: 'Удалить столбцы', danger: true, action: () => this.deleteCols() },
        { label: 'Очистить содержимое', action: () => this.clear('contents') },
        { sep: true },
        { label: 'Ширина столбца…', action: () => this.askSize('col') },
        { label: 'Автоподбор ширины', action: () => this.autoFitCols(this.cur.c) },
        { label: 'Скрыть', action: () => this.hideRowsCols('col', true) },
        { label: 'Показать', action: () => this.hideRowsCols('col', false) },
      ];
    } else if (isRow) {
      items = [...clipboard,
        { label: 'Вставить строки', action: () => this.insertRows('above') },
        { label: 'Удалить строки', danger: true, action: () => this.deleteRows() },
        { label: 'Очистить содержимое', action: () => this.clear('contents') },
        { sep: true },
        { label: 'Высота строки…', action: () => this.askSize('row') },
        { label: 'Автоподбор высоты', action: () => this.autoFitRows(this.cur.r) },
        { label: 'Скрыть', action: () => this.hideRowsCols('row', true) },
        { label: 'Показать', action: () => this.hideRowsCols('row', false) },
      ];
    } else {
      const cell = this.cell(this.cur.r, this.cur.c);
      items = [...clipboard,
        { label: 'Вставить…', sub: [
          { label: 'Строки выше', action: () => this.insertRows('above') },
          { label: 'Строки ниже', action: () => this.insertRows('below') },
          { label: 'Столбцы слева', action: () => this.insertCols('left') },
          { label: 'Столбцы справа', action: () => this.insertCols('right') },
        ] },
        { label: 'Удалить…', sub: [
          { label: 'Строки', danger: true, action: () => this.deleteRows() },
          { label: 'Столбцы', danger: true, action: () => this.deleteCols() },
        ] },
        { label: 'Очистить содержимое', hint: 'Delete', action: () => this.clear('contents') },
        { sep: true },
        { label: 'Сортировка', sub: [
          { label: 'От А до Я (по возрастанию)', action: () => this.sort(false) },
          { label: 'От Я до А (по убыванию)', action: () => this.sort(true) },
          { label: 'Настраиваемая сортировка…', action: () => this.openSortDialog() },
        ] },
        { label: 'Фильтр', sub: [
          { label: this.sheet().autoFilter ? 'Убрать фильтр' : 'Включить фильтр', action: () => this.toggleFilter() },
          { label: 'Фильтр по значению ячейки', action: () => this.filterBySelected() },
        ] },
        { sep: true },
        { label: cell?.note ? 'Изменить примечание' : 'Вставить примечание', icon: IC.note, action: () => this.editNote() },
        ...(cell?.note ? [{ label: 'Удалить примечание', action: () => { const sh = this.sheet(); this.change(() => { delete sh.data[this.cur.r][this.cur.c].note; }); } }] : []),
        { label: 'Формат ячеек…', icon: IC.format, hint: 'Ctrl+1', action: () => this.openFormatDialog() },
        { label: cell?.link ? 'Изменить ссылку' : 'Ссылка', icon: IC.link, hint: 'Ctrl+K', action: () => this.editLink() },
        ...(cell?.link ? [{ label: 'Открыть ссылку', action: () => { const href = cell.link; if (href && /^(https?:|mailto:|tel:)/i.test(href)) window.open(href, '_blank', 'noopener'); } }, { label: 'Удалить ссылку', action: () => { const sh = this.sheet(); this.change(() => { delete sh.data[this.cur.r][this.cur.c].link; }); } }] : []),
      ];
    }
    showMenu(items, { x: e.clientX, y: e.clientY });
  }

  /** Вставка из системного буфера по команде меню (без события paste). */
  private async pasteFromSystem(mode: PasteMode): Promise<void> {
    let text = '', html = '';
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
        if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
    } catch {
      try { text = await navigator.clipboard.readText(); } catch { /* нет прав — пробуем свой буфер */ }
    }
    if (!text && !html && !CLIP) { this.host.toast('Нет доступа к буферу обмена — используйте Ctrl+V', 'info'); return; }
    this.pasteFrom(text, html, mode);
  }

  private filterBySelected(): void {
    const sh = this.sheet();
    if (!sh.autoFilter) {
      const { rg } = this.sortTarget();
      sh.autoFilter = rangeToRef(rg);
    }
    const t = this.displayText(this.host.evaluator(this.si()), this.cur.r, this.cur.c);
    this.change(() => { sh.filter = { ...(sh.filter ?? {}), [String(this.cur.c)]: [t] }; }, { full: true });
  }

  openSortDialog(): void {
    const { rg, header } = this.sortTarget();
    const ev = this.host.evaluator(this.si());
    const colName = (c: number) => header ? (this.displayText(ev, rg.r1, c) || `Столбец ${colLetter(c)}`) : `Столбец ${colLetter(c)}`;
    const opts = Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => rg.c1 + i).map(c => `<option value="${c}">${esc(colName(c))}</option>`).join('');
    const row = (i: number) => `<div class="xd-row" data-key="${i}"><span class="xd-lbl">${i === 0 ? 'Сортировать по' : 'Затем по'}</span><select class="xd-inp" data-col>${i ? '<option value="">—</option>' : ''}${opts}</select><select class="xd-inp" data-dir><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></div>`;
    showDialog({
      title: 'Сортировка',
      body: `<p class="xd-p">Диапазон ${rangeToRef(rg)}</p><label class="xd-check"><input type="checkbox" data-hdr ${header ? 'checked' : ''}> Мои данные содержат заголовки</label>${row(0)}${row(1)}${row(2)}`,
      okLabel: 'Сортировать',
      onMount: root => { const s = root.querySelector<HTMLSelectElement>('[data-key="0"] [data-col]'); if (s) s.value = String(Math.max(rg.c1, Math.min(rg.c2, this.cur.c))); },
      onOk: root => {
        const keys = [...root.querySelectorAll<HTMLElement>('[data-key]')].map(el => ({
          col: el.querySelector<HTMLSelectElement>('[data-col]')!.value,
          desc: el.querySelector<HTMLSelectElement>('[data-dir]')!.value === 'desc',
        })).filter(k => k.col !== '').map(k => ({ col: +k.col, desc: k.desc }));
        this.sort(false, keys, rg, root.querySelector<HTMLInputElement>('[data-hdr]')!.checked);
      },
    });
  }

  // ═══════════════════════════ Лента ═══════════════════════════

  private renderRibbon(): void {
    const tabs: Array<[string, string]> = [['home', 'Главная'], ['insert', 'Вставка'], ['formulas', 'Формулы'], ['data', 'Данные'], ['view', 'Вид']];
    const B = (act: string, icon: string, title: string, extra = '') => `<button class="xr-btn" data-act="${act}" title="${esc(title)}"${extra}>${icon}</button>`;
    const BL = (act: string, icon: string, label: string, title = label) => `<button class="xr-btn xr-lbl" data-act="${act}" title="${esc(title)}">${icon}<span>${esc(label)}</span></button>`;
    const DD = (act: string, icon: string, title: string, label = '') => `<button class="xr-btn xr-dd${label ? ' xr-lbl' : ''}" data-dd="${act}" title="${esc(title)}">${icon}${label ? `<span>${esc(label)}</span>` : ''}${IC.chevron}</button>`;
    const SPLIT = (act: string, icon: string, title: string, bar = '') => `<span class="xr-split"><button class="xr-btn" data-act="${act}" title="${esc(title)}">${icon}${bar}</button><button class="xr-btn xr-arrow" data-dd="${act}" title="${esc(title)}">${IC.chevron}</button></span>`;
    const G = (label: string, inner: string) => `<div class="xr-group" title="${label}"><div class="xr-items">${inner}</div><div class="xr-glabel">${label}</div></div>`;
    const font = this.book().font ?? { name: 'Calibri', size: 11 };

    let panel = '';
    switch (this.ribbonTab) {
      case 'home':
        panel =
          G('Буфер обмена', `${DD('paste', IC.paste, 'Вставить (Ctrl+V)', 'Вставить')}<div class="xr-col">${B('cut', IC.cut, 'Вырезать (Ctrl+X)')}${B('copy', IC.copy, 'Копировать (Ctrl+C)')}${B('painter', IC.painter, 'Формат по образцу (двойной клик — несколько раз)')}</div>`) +
          G('Шрифт', `<div class="xr-col2">
              <div class="xr-row"><select class="xr-sel xr-font" data-sel="font" title="Шрифт">${DEF_FONTS.map(f => `<option value="${f}">${f}</option>`).join('')}</select>
              <select class="xr-sel xr-size" data-sel="size" title="Размер шрифта">${FONT_SIZES.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
              </div>
              <div class="xr-row">${B('bold', IC.bold, 'Полужирный (Ctrl+B)')}${B('italic', IC.italic, 'Курсив (Ctrl+I)')}${B('underline', IC.underline, 'Подчёркнутый (Ctrl+U)')}${B('strike', IC.strike, 'Зачёркнутый (Ctrl+5)')}
              ${B('grow', IC.growFont, 'Увеличить размер шрифта')}${B('shrink', IC.shrinkFont, 'Уменьшить размер шрифта')}</div></div>`) +
          G('Оформление', `<div class="xr-col2"><div class="xr-row">${SPLIT('fill', IC.fill, 'Цвет заливки', `<i class="xr-bar" style="background:${this.lastFill}"></i>`)}${SPLIT('color', IC.fontColor, 'Цвет шрифта', `<i class="xr-bar" style="background:${this.lastColor}"></i>`)}</div><div class="xr-row">${SPLIT('borders', IC.borders, 'Границы')}</div></div>`) +
          G('Выравнивание', `<div class="xr-col2"><div class="xr-row">${B('alTop', IC.alTop, 'По верхнему краю')}${B('alMid', IC.alMid, 'По середине')}${B('alBot', IC.alBot, 'По нижнему краю')}<span class="xr-sep"></span>${B('wrap', IC.wrap, 'Перенос текста')}</div>
              <div class="xr-row">${B('alLeft', IC.alLeft, 'По левому краю')}${B('alCenter', IC.alCenter, 'По центру')}${B('alRight', IC.alRight, 'По правому краю')}${B('indDec', IC.indentDec, 'Уменьшить отступ')}${B('indInc', IC.indentInc, 'Увеличить отступ')}<span class="xr-sep"></span>${SPLIT('merge', IC.merge, 'Объединить и поместить в центре')}</div></div>`) +
          G('Число', `<div class="xr-col2"><div class="xr-row"><select class="xr-sel xr-nf" data-sel="nf" title="Числовой формат">
              <option value="General">Общий</option><option value="#,##0.00">Числовой</option><option value="#,##0.00\\ &quot;₽&quot;">Денежный</option>
              <option value="dd.mm.yyyy">Краткая дата</option><option value="d mmmm yyyy">Длинная дата</option><option value="hh:mm:ss">Время</option>
              <option value="0.00%">Процентный</option><option value="@">Текстовый</option><option value="__more">Другие форматы…</option></select></div>
              <div class="xr-row">${B('rub', IC.rub, 'Денежный формат (₽)')}${B('pct', IC.pct, 'Процентный формат')}${B('thousands', IC.thousands, 'Формат с разделителями')}${B('decInc', IC.decInc, 'Увеличить разрядность')}${B('decDec', IC.decDec, 'Уменьшить разрядность')}</div></div>`) +
          G('Ячейки', `<div class="xr-stack">${DD('insCells', IC.insRow, 'Вставить строки или столбцы', 'Вставить')}${DD('delCells', IC.delRow, 'Удалить строки или столбцы', 'Удалить')}${DD('formatCells', IC.format, 'Формат: размеры, скрытие, лист', 'Формат')}</div>`) +
          G('Редактирование', `<div class="xr-col2"><div class="xr-row">${SPLIT('sum', IC.sum, 'Автосумма (Alt+=)')}${DD('clear', IC.clear, 'Очистить')}</div><div class="xr-row">${DD('sort', IC.sortAsc, 'Сортировка и фильтр')}${B('find', IC.find, 'Найти и заменить (Ctrl+F)')}</div></div>`);
        break;
      case 'insert':
        panel =
          G('Таблицы', BL('asTable', IC.table, 'Форматировать как таблицу')) +
          G('Иллюстрации', BL('image', IC.image, 'Рисунок', 'Вставить картинку из файла')) +
          G('Диаграммы', `${BL('chart:col', IC.chartCol, 'Гистограмма')}${BL('chart:line', IC.chartLine, 'График')}${BL('chart:pie', IC.chartPie, 'Круговая')}${DD('charts', IC.chartCol, 'Другие диаграммы', 'Ещё')}`) +
          G('Ссылки', `${BL('link', IC.link, 'Ссылка', 'Гиперссылка (Ctrl+K)')}${BL('note', IC.note, 'Примечание')}`);
        break;
      case 'formulas':
        panel =
          G('Библиотека функций', `${BL('fx', IC.fx, 'Вставить функцию', 'Вставить функцию (Shift+F3)')}${SPLIT('sum', IC.sum, 'Автосумма (Alt+=)')}` +
            ['Логические', 'Текстовые', 'Дата и время', 'Ссылки и массивы', 'Математические', 'Статистические'].map(c => DD('fncat:' + c, '', c, c)).join('')) +
          G('Зависимости', BL('showFormulas', IC.fx, this.showFormulas ? 'Скрыть формулы' : 'Показать формулы', 'Показать формулы (Ctrl+`)'));
        break;
      case 'data':
        panel =
          G('Сортировка и фильтр', `${BL('sortAsc', IC.sortAsc, 'А→Я')}${BL('sortDesc', IC.sortDesc, 'Я→А')}${BL('sortDlg', IC.sortAsc, 'Сортировка…')}${BL('filter', IC.filter, this.sheet().autoFilter ? 'Убрать фильтр' : 'Фильтр', 'Фильтр (Ctrl+Shift+L)')}${BL('filterClear', IC.clear, 'Очистить фильтр')}`) +
          G('Работа с данными', `${BL('dedup', IC.dedup, 'Удалить дубликаты')}${BL('textToCols', IC.format, 'Текст по столбцам')}`);
        break;
      case 'view':
        panel =
          G('Окно', `${DD('freeze', IC.freeze, 'Закрепить области', 'Закрепить области')}`) +
          G('Показать', `<label class="xr-check"><input type="checkbox" data-chk="grid" ${this.sheet().showGrid !== false ? 'checked' : ''}> Сетка</label><label class="xr-check"><input type="checkbox" data-chk="formulas" ${this.showFormulas ? 'checked' : ''}> Формулы</label>`) +
          G('Масштаб', `${BL('zoom100', '<b style="font:600 11px Arial">100%</b>', 'Масштаб 100%')}${DD('zoom', '', 'Масштаб', 'Масштаб')}`);
        break;
    }
    this.elRibbon.innerHTML = `
      <div class="xr-tabs">${tabs.map(([k, n]) => `<span class="xr-tab${k === this.ribbonTab ? ' on' : ''}" data-rtab="${k}">${n}</span>`).join('')}
        <span class="xr-tabs-right">${B('undo', IC.undo, 'Отменить (Ctrl+Z)')}${B('redo', IC.redo, 'Вернуть (Ctrl+Y)')}</span></div>
      <div class="xr-panel">${panel}</div>`;
    void font;
    this.bindRibbon();
    this.updateRibbonState();
  }

  private bindRibbon(): void {
    const R = this.elRibbon;
    R.addEventListener('mousedown', e => {
      const el = e.target as HTMLElement;
      if (!el.closest('select,input')) e.preventDefault();   // фокус остаётся в сетке
    });
    R.querySelectorAll<HTMLElement>('[data-rtab]').forEach(t => t.addEventListener('click', () => { this.ribbonTab = t.dataset.rtab!; this.renderRibbon(); }));
    R.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', e => { this.commitEdit(); this.ribbonAction(b.dataset.act!, b, e as MouseEvent); }));
    R.querySelectorAll<HTMLElement>('[data-act="painter"]').forEach(b => b.addEventListener('dblclick', () => this.startPainter(true)));
    R.querySelectorAll<HTMLElement>('[data-dd]').forEach(b => b.addEventListener('click', () => { this.commitEdit(); this.ribbonDropdown(b.dataset.dd!, b); }));
    R.querySelectorAll<HTMLSelectElement>('[data-sel]').forEach(s => s.addEventListener('change', () => {
      const v = s.value;
      if (s.dataset.sel === 'font') this.setFont({ name: v });
      else if (s.dataset.sel === 'size') this.setFont({ size: +v });
      else if (s.dataset.sel === 'nf') { if (v === '__more') this.openFormatDialog(); else this.setNumFormat(v); }
      this.focusGrid();
    }));
    R.querySelectorAll<HTMLInputElement>('[data-chk]').forEach(c => c.addEventListener('change', () => {
      if (c.dataset.chk === 'grid') { const sh = this.sheet(); this.change(() => { if (c.checked) delete sh.showGrid; else sh.showGrid = false; }, { full: true }); }
      else { this.showFormulas = c.checked; this.renderGrid(true); }
    }));
  }

  private ribbonAction(act: string, btn: HTMLElement, e: MouseEvent): void {
    const s = this.sheet();
    switch (act) {
      case 'undo': this.host.undo(); break;
      case 'redo': this.host.redo(); break;
      case 'cut': this.copySelection(true); break;
      case 'copy': this.copySelection(false); break;
      case 'painter': if (e.detail <= 1) { if (this.painter) { this.painter = null; this.updateRibbonState(); } else this.startPainter(false); } break;
      case 'bold': case 'italic': case 'underline': case 'strike': this.toggleFont(act); break;
      case 'grow': this.stepFontSize(1); break;
      case 'shrink': this.stepFontSize(-1); break;
      case 'borders': this.setBorders('all'); break;
      case 'fill': this.setFill(this.lastFill); break;
      case 'color': this.setFont({ color: this.lastColor }); break;
      case 'alTop': this.setAlign({ v: this.curX().align?.v === 'top' ? undefined : 'top' }); break;
      case 'alMid': this.setAlign({ v: this.curX().align?.v === 'middle' ? undefined : 'middle' }); break;
      case 'alBot': this.setAlign({ v: undefined }); break;
      case 'alLeft': this.toggleAlignH('left'); break;
      case 'alCenter': this.toggleAlignH('center'); break;
      case 'alRight': this.toggleAlignH('right'); break;
      case 'indInc': this.stepIndent(1); break;
      case 'indDec': this.stepIndent(-1); break;
      case 'wrap': this.toggleWrap(); break;
      case 'merge': this.merge('center'); break;
      case 'rub': this.setNumFormat(PRESET_FORMATS.currency); break;
      case 'pct': this.setNumFormat('0%'); break;
      case 'thousands': this.setNumFormat('#,##0.00'); break;
      case 'decInc': this.stepDecimals(1); break;
      case 'decDec': this.stepDecimals(-1); break;
      case 'sum': this.autoSum('SUM'); break;
      case 'find': this.openFind(false); break;
      case 'asTable': showColorPicker(btn, { noneLabel: 'Синий (по умолчанию)', onPick: hex => this.formatAsTable(hex ?? '#4472c4') }); break;
      case 'image': this.pickImage(); break;
      case 'link': this.editLink(); break;
      case 'note': this.editNote(); break;
      case 'fx': this.openFunctionDialog(); break;
      case 'showFormulas': this.showFormulas = !this.showFormulas; this.renderAll(); break;
      case 'sortAsc': this.sort(false); break;
      case 'sortDesc': this.sort(true); break;
      case 'sortDlg': this.openSortDialog(); break;
      case 'filter': this.toggleFilter(); break;
      case 'filterClear': if (s.filter) this.change(() => { delete s.filter; }, { full: true }); break;
      case 'dedup': this.removeDuplicates(); break;
      case 'textToCols': this.textToColumns(); break;
      case 'zoom100': this.setZoom(100); break;
      default:
        if (act.startsWith('chart:')) this.insertChart(act.slice(6) as ChartKind);
    }
    if (!['find', 'fx', 'link', 'note', 'sortDlg', 'dedup', 'textToCols'].includes(act)) this.focusGrid();
  }

  private ribbonDropdown(act: string, btn: HTMLElement): void {
    const fnMenu = (names: string[]): MenuItem[] => names.map(n => ({ label: n + (Object.entries(RU_HINTS).find(([, e]) => e === n)?.[0] ? ' · ' + Object.entries(RU_HINTS).find(([, e]) => e === n)![0] : ''), action: () => this.startEdit(this.cur.r, this.cur.c, { initial: `=${n}(`, mode: 'edit' }) }));
    switch (act) {
      case 'paste': showMenu([
        { label: 'Вставить', hint: 'Ctrl+V', action: () => this.pasteFromSystem('all') },
        { label: 'Вставить значения', action: () => this.pasteFromSystem('values') },
        { label: 'Вставить форматирование', action: () => this.pasteFromSystem('formats') },
        { label: 'Вставить формулы', action: () => this.pasteFromSystem('formulas') },
      ], btn); return;
      case 'borders': {
        const st = (style: BorderStyle, label: string): MenuItem => ({ label, action: () => this.setBorders('outer', style) });
        showMenu([
          { label: 'Нижняя граница', action: () => this.setBorders('bottom') },
          { label: 'Верхняя граница', action: () => this.setBorders('top') },
          { label: 'Левая граница', action: () => this.setBorders('left') },
          { label: 'Правая граница', action: () => this.setBorders('right') },
          { sep: true },
          { label: 'Нет границы', action: () => this.setBorders('none') },
          { label: 'Все границы', action: () => this.setBorders('all') },
          { label: 'Внешние границы', action: () => this.setBorders('outer') },
          { label: 'Внутренние границы', action: () => this.setBorders('inner') },
          { label: 'Толстая внешняя граница', action: () => this.setBorders('thickOuter') },
          { label: 'Двойная нижняя граница', action: () => this.setBorders('doubleBottom') },
          { label: 'Толстая нижняя граница', action: () => this.setBorders('thickBottom') },
          { sep: true },
          { label: 'Вид линии (внешняя граница)', sub: [st('thin', 'Тонкая'), st('medium', 'Средняя'), st('thick', 'Толстая'), st('dashed', 'Пунктир'), st('dotted', 'Точки'), st('double', 'Двойная'), st('dashDot', 'Штрих-пунктир')] },
          { label: 'Цвет линии…', action: () => showColorPicker(btn, { noneLabel: 'Авто (чёрный)', onPick: hex => this.setBorders('all', 'thin', hex ?? '#000000') }) },
        ], btn); return;
      }
      case 'fill': showColorPicker(btn, { noneLabel: 'Нет заливки', onPick: hex => { if (hex) this.lastFill = hex; this.setFill(hex); this.renderRibbon(); } }); return;
      case 'color': showColorPicker(btn, { noneLabel: 'Авто', onPick: hex => { if (hex) this.lastColor = hex; this.setFont({ color: hex }); this.renderRibbon(); } }); return;
      case 'merge': showMenu([
        { label: 'Объединить и поместить в центре', action: () => this.merge('center') },
        { label: 'Объединить по строкам', action: () => this.merge('across') },
        { label: 'Объединить ячейки', action: () => this.merge('all') },
        { label: 'Отменить объединение ячеек', action: () => this.merge('unmerge') },
      ], btn); return;
      case 'insCells': showMenu([
        { label: 'Вставить строки на лист', action: () => this.insertRows('above') },
        { label: 'Вставить строки ниже', action: () => this.insertRows('below') },
        { label: 'Вставить столбцы на лист', action: () => this.insertCols('left') },
        { label: 'Вставить столбцы справа', action: () => this.insertCols('right') },
        { label: 'Вставить лист', action: () => this.addSheet() },
      ], btn); return;
      case 'delCells': showMenu([
        { label: 'Удалить строки с листа', danger: true, action: () => this.deleteRows() },
        { label: 'Удалить столбцы с листа', danger: true, action: () => this.deleteCols() },
        { label: 'Удалить лист', danger: true, action: () => this.deleteSheet(this.si()) },
      ], btn); return;
      case 'formatCells': showMenu([
        { label: 'Высота строки…', action: () => this.askSize('row') },
        { label: 'Автоподбор высоты строки', action: () => this.autoFitRows(this.cur.r) },
        { label: 'Ширина столбца…', action: () => this.askSize('col') },
        { label: 'Автоподбор ширины столбца', action: () => this.autoFitCols(this.cur.c) },
        { sep: true },
        { label: 'Скрыть или отобразить', sub: [
          { label: 'Скрыть строки', action: () => this.hideRowsCols('row', true) },
          { label: 'Скрыть столбцы', action: () => this.hideRowsCols('col', true) },
          { label: 'Отобразить строки', action: () => this.hideRowsCols('row', false) },
          { label: 'Отобразить столбцы', action: () => this.hideRowsCols('col', false) },
        ] },
        { sep: true },
        { label: 'Переименовать лист', action: () => this.renameSheetUi(this.si()) },
        { label: 'Цвет ярлычка…', action: () => showColorPicker(btn, { noneLabel: 'Нет цвета', onPick: hex => { const sh = this.sheet(); this.change(() => { if (hex) sh.tabColor = hex; else delete sh.tabColor; }, { full: true }); } }) },
        { sep: true },
        { label: 'Формат ячеек…', hint: 'Ctrl+1', action: () => this.openFormatDialog() },
      ], btn); return;
      case 'sum': showMenu([
        { label: 'Сумма', action: () => this.autoSum('SUM') },
        { label: 'Среднее', action: () => this.autoSum('AVERAGE') },
        { label: 'Число', action: () => this.autoSum('COUNT') },
        { label: 'Максимум', action: () => this.autoSum('MAX') },
        { label: 'Минимум', action: () => this.autoSum('MIN') },
        { sep: true },
        { label: 'Другие функции…', action: () => this.openFunctionDialog() },
      ], btn); return;
      case 'clear': showMenu([
        { label: 'Очистить всё', action: () => this.clear('all') },
        { label: 'Очистить форматы', action: () => this.clear('formats') },
        { label: 'Очистить содержимое', hint: 'Delete', action: () => this.clear('contents') },
        { label: 'Очистить примечания', action: () => { const sh = this.sheet(), s = this.sel; this.change(() => { for (let r = s.r1; r <= Math.min(s.r2, sh.data.length - 1); r++) for (let c = s.c1; c <= Math.min(s.c2, sh.data[r].length - 1); c++) delete sh.data[r][c].note; }); } },
        { label: 'Удалить гиперссылки', action: () => { const sh = this.sheet(), s = this.sel; this.change(() => { for (let r = s.r1; r <= Math.min(s.r2, sh.data.length - 1); r++) for (let c = s.c1; c <= Math.min(s.c2, sh.data[r].length - 1); c++) delete sh.data[r][c].link; }); } },
      ], btn); return;
      case 'sort': showMenu([
        { label: 'Сортировка от А до Я', icon: IC.sortAsc, action: () => this.sort(false) },
        { label: 'Сортировка от Я до А', icon: IC.sortDesc, action: () => this.sort(true) },
        { label: 'Настраиваемая сортировка…', action: () => this.openSortDialog() },
        { sep: true },
        { label: this.sheet().autoFilter ? 'Убрать фильтр' : 'Фильтр', icon: IC.filter, hint: 'Ctrl+Shift+L', action: () => this.toggleFilter() },
        { label: 'Очистить фильтр', disabled: !this.sheet().filter, action: () => { const sh = this.sheet(); this.change(() => { delete sh.filter; }, { full: true }); } },
      ], btn); return;
      case 'charts': showMenu(([['col', 'Гистограмма'], ['bar', 'Линейчатая'], ['line', 'График'], ['area', 'С областями'], ['pie', 'Круговая'], ['doughnut', 'Кольцевая'], ['scatter', 'Точечная']] as Array<[ChartKind, string]>).map(([k, n]) => ({ label: n, action: () => this.insertChart(k) })), btn); return;
      case 'freeze': showMenu([
        { label: 'Закрепить области', hint: 'выше и левее курсора', action: () => this.freeze('panes') },
        { label: 'Закрепить верхнюю строку', action: () => this.freeze('row') },
        { label: 'Закрепить первый столбец', action: () => this.freeze('col') },
        { label: 'Снять закрепление областей', disabled: !this.sheet().freeze, action: () => this.freeze('none') },
      ], btn); return;
      case 'zoom': showMenu([50, 75, 90, 100, 110, 125, 150, 200].map(z => ({ label: z + '%', checked: Math.round(this.zoom * 100) === z, action: () => this.setZoom(z) })), btn); return;
    }
    if (act.startsWith('fncat:')) {
      const cat = act.slice(6);
      const groups: Record<string, string[]> = {
        'Логические': ['IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'XOR'],
        'Текстовые': ['CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'PROPER', 'SUBSTITUTE', 'REPLACE', 'FIND', 'SEARCH', 'TEXT', 'VALUE'],
        'Дата и время': ['TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'WEEKNUM', 'EDATE', 'EOMONTH', 'DATEDIF', 'NETWORKDAYS'],
        'Ссылки и массивы': ['VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'CHOOSE', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS'],
        'Математические': ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'ABS', 'MOD', 'POWER', 'SQRT', 'SUBTOTAL'],
        'Статистические': ['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'MAX', 'MIN', 'MEDIAN', 'LARGE', 'SMALL', 'RANK'],
      };
      showMenu(fnMenu(groups[cat] ?? []), btn);
    }
  }

  /** Подсветить в ленте состояние активной ячейки (Ж/К/Ч, выравнивание, шрифт). */
  private updateRibbonState(): void {
    const x = this.curX();
    const font = this.book().font ?? { name: 'Calibri', size: 11 };
    const on = (act: string, v: boolean) => this.elRibbon.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.classList.toggle('on', v));
    on('bold', !!x.font?.bold); on('italic', !!x.font?.italic); on('underline', !!x.font?.underline); on('strike', !!x.font?.strike);
    on('alLeft', x.align?.h === 'left'); on('alCenter', x.align?.h === 'center'); on('alRight', x.align?.h === 'right');
    on('alTop', x.align?.v === 'top'); on('alMid', x.align?.v === 'middle'); on('alBot', !x.align?.v || x.align.v === 'bottom');
    on('wrap', !!x.align?.wrap);
    on('painter', !!this.painter);
    on('merge', mergesIn(this.sheet(), { r1: this.cur.r, c1: this.cur.c, r2: this.cur.r, c2: this.cur.c }).length > 0);
    const fs = this.elRibbon.querySelector<HTMLSelectElement>('[data-sel="font"]');
    if (fs) {
      const name = x.font?.name ?? font.name;
      if (![...fs.options].some(o => o.value === name)) fs.insertAdjacentHTML('afterbegin', `<option value="${esc(name)}">${esc(name)}</option>`);
      fs.value = name;
    }
    const ss = this.elRibbon.querySelector<HTMLSelectElement>('[data-sel="size"]');
    if (ss) {
      const size = String(x.font?.size ?? font.size);
      if (![...ss.options].some(o => o.value === size)) ss.insertAdjacentHTML('afterbegin', `<option value="${size}">${size}</option>`);
      ss.value = size;
    }
    const nfs = this.elRibbon.querySelector<HTMLSelectElement>('[data-sel="nf"]');
    if (nfs) {
      const nf = this.cell(this.cur.r, this.cur.c)?.nf ?? 'General';
      nfs.value = [...nfs.options].some(o => o.value === nf) ? nf : (nf === 'General' ? 'General' : '__more');
      if (nfs.value === '__more' && nf !== 'General') {
        const label = isDateFormat(nf) ? 'Дата/время' : nf.includes('%') ? 'Процентный' : /₽|\$|€/.test(nf) ? 'Денежный' : 'Числовой';
        nfs.options[nfs.options.length - 1].textContent = label;
      } else nfs.options[nfs.options.length - 1].textContent = 'Другие форматы…';
    }
    const undoBtn = this.elRibbon.querySelector<HTMLButtonElement>('[data-act="undo"]');
    const redoBtn = this.elRibbon.querySelector<HTMLButtonElement>('[data-act="redo"]');
    if (undoBtn) undoBtn.disabled = !this.host.canUndo();
    if (redoBtn) redoBtn.disabled = !this.host.canRedo();
  }

  /** «Текст по столбцам»: разбить текст выделенной колонки по разделителю. */
  private textToColumns(): void {
    const s = this.sel;
    if (s.c1 !== s.c2) { this.host.toast('Выделите один столбец с текстом', 'error'); return; }
    showDialog({
      title: 'Текст по столбцам',
      body: `<p class="xd-p">Разделить текст столбца ${colLetter(s.c1)} на несколько столбцов.</p>
        <label class="xd-field"><span>Разделитель</span><select class="xd-inp" data-sep><option value=";">Точка с запятой ;</option><option value=",">Запятая ,</option><option value="\t">Табуляция</option><option value=" ">Пробел</option><option value="|">Вертикальная черта |</option><option value="custom">Другой…</option></select></label>
        <label class="xd-field"><span>Другой разделитель</span><input class="xd-inp" data-custom maxlength="5"></label>`,
      okLabel: 'Готово',
      onOk: root => {
        let sep = root.querySelector<HTMLSelectElement>('[data-sep]')!.value;
        if (sep === 'custom') sep = root.querySelector<HTMLInputElement>('[data-custom]')!.value || ';';
        const sh = this.sheet();
        this.change(() => {
          const r2 = Math.min(s.r2, sh.data.length - 1);
          for (let r = s.r1; r <= r2; r++) {
            const v = sh.data[r][s.c1]?.v ?? '';
            if (!v || v.startsWith('=')) continue;
            const parts = v.split(sep);
            ensureSize(sh, r + 1, s.c1 + parts.length);
            parts.forEach((p, i) => { sh.data[r][s.c1 + i] = interpretInput(p.trim(), sh.data[r][s.c1 + i]); });
          }
        }, { full: true });
      },
    });
  }
}

// ═══════════════════════════ Вспомогательное ═══════════════════════════

function compareForList(a: string, b: string): number {
  const na = parseUserNumber(a), nb = parseUserNumber(b);
  if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, 'ru', { numeric: true });
}

function mixWhite(hex: string, k: number): string {
  const h = hex.replace('#', '');
  const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, '0');
  return '#' + ch(0) + ch(2) + ch(4);
}

/** Собрать описание диаграммы по прямоугольнику данных листа. */
export function buildChartFromRange(sh: SheetData, rg: MergeRange, kind: ChartKind, ev: Evaluator, title?: string): ChartSpec | null {
  const isNum = (r: number, c: number) => {
    const cell = sh.data[r]?.[c];
    if (!cell?.v) return false;
    if (cell.v.startsWith('=')) return typeof ev.cellValue(r, c) === 'number';
    return cell.t === 'n' || parseUserNumber(cell.v) !== null;
  };
  const rows = rg.r2 - rg.r1 + 1, cols = rg.c2 - rg.c1 + 1;
  // Первая колонка — подписи, если в ней не числа (или это даты)
  let catCol = true;
  for (let r = rg.r1 + 1; r <= rg.r2; r++) if (isNum(r, rg.c1) && !isDateFormat(sh.data[r]?.[rg.c1]?.nf ?? '')) { catCol = false; break; }
  if (cols === 1) catCol = false;
  // Первая строка — заголовки, если в ней нет чисел
  let headRow = false;
  for (let c = rg.c1 + (catCol ? 1 : 0); c <= rg.c2; c++) if (sh.data[rg.r1]?.[c]?.v && !isNum(rg.r1, c)) { headRow = true; break; }
  if (rows === 1) headRow = false;
  const r0 = rg.r1 + (headRow ? 1 : 0);
  const series: ChartSpec['series'] = [];
  for (let c = rg.c1 + (catCol ? 1 : 0); c <= rg.c2; c++) {
    let any = false;
    for (let r = r0; r <= rg.r2; r++) if (isNum(r, c)) { any = true; break; }
    if (!any) continue;
    series.push({
      valRef: `${colLetter(c)}${r0 + 1}:${colLetter(c)}${rg.r2 + 1}`,
      ...(catCol ? { catRef: `${colLetter(rg.c1)}${r0 + 1}:${colLetter(rg.c1)}${rg.r2 + 1}` } : {}),
      ...(headRow ? { nameRef: `${colLetter(c)}${rg.r1 + 1}` } : {}),
    });
    if (kind === 'pie' || kind === 'doughnut') break;
  }
  if (!series.length) return null;
  const autoTitle = title ?? (series.length === 1 && headRow ? (sh.data[rg.r1]?.[letterToCol(series[0].valRef.match(/^[A-Z]+/)![0])]?.v ?? undefined) : undefined);
  return {
    id: uid('ch'), kind, ...(autoTitle ? { title: autoTitle } : {}), series,
    r: rg.r1, c: rg.c2 + 2, w: 480, h: 288, legend: series.length > 1 || kind === 'pie' || kind === 'doughnut',
  };
}

/** Подсказки по аргументам функций (видны в автодополнении и диалоге). */
const FN_HINTS: Record<string, string> = {
  SUM: '(число1; [число2]; …) — сумма', AVERAGE: '(число1; …) — среднее', COUNT: '(значение1; …) — количество чисел',
  COUNTA: '(значение1; …) — непустые', MAX: '(число1; …) — максимум', MIN: '(число1; …) — минимум',
  IF: '(условие; если_истина; [если_ложь])', IFERROR: '(значение; если_ошибка)', IFS: '(условие1; значение1; …)',
  VLOOKUP: '(искомое; таблица; номер_столбца; [интервальный_просмотр])', HLOOKUP: '(искомое; таблица; номер_строки; [интервальный])',
  XLOOKUP: '(искомое; где_искать; что_вернуть; [если_нет])', INDEX: '(массив; строка; [столбец])', MATCH: '(искомое; массив)',
  SUMIF: '(диапазон; критерий; [диапазон_суммирования])', SUMIFS: '(диапазон_суммирования; диапазон1; критерий1; …)',
  COUNTIF: '(диапазон; критерий)', COUNTIFS: '(диапазон1; критерий1; …)', AVERAGEIF: '(диапазон; критерий; [диапазон_усреднения])',
  ROUND: '(число; разрядов)', ROUNDUP: '(число; разрядов)', ROUNDDOWN: '(число; разрядов)', CONCAT: '(текст1; …)',
  TEXTJOIN: '(разделитель; пропускать_пустые; текст1; …)', LEFT: '(текст; [количество])', RIGHT: '(текст; [количество])',
  MID: '(текст; начало; количество)', LEN: '(текст)', TRIM: '(текст)', SUBSTITUTE: '(текст; старый; новый; [номер])',
  TODAY: '() — сегодняшняя дата', NOW: '() — дата и время', DATE: '(год; месяц; день)', DATEDIF: '(начало; конец; "d"|"m"|"y")',
  TEXT: '(значение; формат)', VALUE: '(текст)', AND: '(логическое1; …)', OR: '(логическое1; …)', NOT: '(логическое)',
  SUBTOTAL: '(номер_функции; ссылка1; …)', LARGE: '(массив; k)', SMALL: '(массив; k)', RANK: '(число; ссылка; [порядок])',
  SUMPRODUCT: '(массив1; [массив2]; …)', MEDIAN: '(число1; …)', PRODUCT: '(число1; …)', ABS: '(число)', MOD: '(число; делитель)',
  EOMONTH: '(дата; месяцев)', EDATE: '(дата; месяцев)', NETWORKDAYS: '(начало; конец; [праздники])', WEEKDAY: '(дата)',
};

/** Русские имена функций для подсказок (ключ — как пишут в русском Excel). */
const RU_HINTS: Record<string, string> = {
  'СУММ': 'SUM', 'СРЗНАЧ': 'AVERAGE', 'СЧЁТ': 'COUNT', 'СЧЁТЗ': 'COUNTA', 'МАКС': 'MAX', 'МИН': 'MIN', 'ЕСЛИ': 'IF',
  'ЕСЛИОШИБКА': 'IFERROR', 'ВПР': 'VLOOKUP', 'ГПР': 'HLOOKUP', 'ИНДЕКС': 'INDEX', 'ПОИСКПОЗ': 'MATCH', 'СУММЕСЛИ': 'SUMIF',
  'СУММЕСЛИМН': 'SUMIFS', 'СЧЁТЕСЛИ': 'COUNTIF', 'СЧЁТЕСЛИМН': 'COUNTIFS', 'ОКРУГЛ': 'ROUND', 'ОКРУГЛВВЕРХ': 'ROUNDUP',
  'ОКРУГЛВНИЗ': 'ROUNDDOWN', 'СЦЕП': 'CONCAT', 'СЦЕПИТЬ': 'CONCATENATE', 'ЛЕВСИМВ': 'LEFT', 'ПРАВСИМВ': 'RIGHT', 'ПСТР': 'MID',
  'ДЛСТР': 'LEN', 'СЖПРОБЕЛЫ': 'TRIM', 'ПОДСТАВИТЬ': 'SUBSTITUTE', 'СЕГОДНЯ': 'TODAY', 'ТДАТА': 'NOW', 'ДАТА': 'DATE',
  'ТЕКСТ': 'TEXT', 'И': 'AND', 'ИЛИ': 'OR', 'НЕ': 'NOT', 'ПРОМЕЖУТОЧНЫЕ.ИТОГИ': 'SUBTOTAL', 'НАИБОЛЬШИЙ': 'LARGE',
  'НАИМЕНЬШИЙ': 'SMALL', 'РАНГ': 'RANK', 'СУММПРОИЗВ': 'SUMPRODUCT', 'МЕДИАНА': 'MEDIAN', 'ОСТАТ': 'MOD', 'КОНМЕСЯЦА': 'EOMONTH',
  'ДАТАМЕС': 'EDATE', 'ДЕНЬНЕД': 'WEEKDAY', 'РАЗНДАТ': 'DATEDIF', 'ЗНАЧЕН': 'VALUE', 'ПРОСМОТРX': 'XLOOKUP', 'СРЗНАЧЕСЛИ': 'AVERAGEIF',
  'ГОД': 'YEAR', 'МЕСЯЦ': 'MONTH', 'ДЕНЬ': 'DAY', 'ОБЪЕДИНИТЬ': 'TEXTJOIN', 'ПРОПИСН': 'UPPER', 'СТРОЧН': 'LOWER',
};
