/**
 * Операции над моделью книги — без DOM, чтобы их можно было проверить тестом
 * и вызвать одинаково из интерфейса и из ассистента.
 *
 * Каждая операция сдвигает ВСЁ, что привязано к строкам и колонкам: данные,
 * ширины/высоты, объединения, скрытые строки, закрепление, автофильтр,
 * картинки, диаграммы и ссылки в формулах на всех листах. Раньше вставка
 * строки двигала только значения — объединения и ширины оставались на
 * месте и «съезжали» относительно данных, а формулы начинали считать не то.
 */

import {
  type CellData, type ExcelContent, type MergeRange, type SheetData,
  emptyCell, ensureSize, parseRangeRef, rangeToRef,
} from './model';
import { offsetFormula, shiftFormulaRefs, renameSheetInFormula } from '@/utils/formula';
import { parseUserNumber, isDateFormat } from '@/utils/numFormat';

export type Axis = 'row' | 'col';

const cloneCell = (c: CellData | undefined): CellData => {
  if (!c) return emptyCell();
  const out: CellData = { ...c };
  if (c.rt) out.rt = c.rt.map(r => ({ ...r }));
  return out;
};

function shiftList(list: number[] | undefined, at: number, count: number): number[] | undefined {
  if (!list?.length) return list;
  const out: number[] = [];
  for (const v of list) {
    if (count > 0) out.push(v >= at ? v + count : v);
    else if (v < at) out.push(v);
    else if (v >= at - count) out.push(v + count);
  }
  return out.length ? out : undefined;
}

function shiftArray<T>(arr: (T | null)[] | undefined, at: number, count: number): (T | null)[] | undefined {
  if (!arr) return arr;
  const out = [...arr];
  if (count > 0) { if (at <= out.length) out.splice(at, 0, ...Array.from({ length: count }, () => null)); }
  else out.splice(at, -count);
  return out;
}

/** Сдвиг одной координаты: null — объект попал в удалённую полосу. */
function shiftIdx(v: number, at: number, count: number): number | null {
  if (count > 0) return v >= at ? v + count : v;
  const del = -count;
  if (v < at) return v;
  if (v >= at + del) return v - del;
  return null;
}

/**
 * Вставить (count > 0) или удалить (count < 0) строки/колонки на листе.
 * at — индекс первой вставляемой/удаляемой полосы.
 */
export function shiftSheet(book: ExcelContent, sheetIdx: number, axis: Axis, at: number, count: number): void {
  if (!count) return;
  const sh = book.sheets[sheetIdx];
  const width = Math.max(1, ...sh.data.map(r => r.length));

  if (axis === 'row') {
    if (count > 0) sh.data.splice(Math.min(at, sh.data.length), 0, ...Array.from({ length: count }, () => Array.from({ length: width }, emptyCell)));
    else sh.data.splice(at, -count);
    if (!sh.data.length) sh.data.push(Array.from({ length: width }, emptyCell));
    sh.rowHeights = shiftArray(sh.rowHeights, at, count);
    sh.hiddenRows = shiftList(sh.hiddenRows, at, count);
    if (sh.freeze && sh.freeze.rows > at) sh.freeze = { ...sh.freeze, rows: Math.max(0, sh.freeze.rows + Math.max(count, at - sh.freeze.rows)) };
  } else {
    for (const row of sh.data) {
      if (count > 0) { while (row.length < at) row.push(emptyCell()); row.splice(at, 0, ...Array.from({ length: count }, emptyCell)); }
      else row.splice(at, -count);
      if (!row.length) row.push(emptyCell());
    }
    sh.colWidths = shiftArray(sh.colWidths, at, count);
    sh.hiddenCols = shiftList(sh.hiddenCols, at, count);
    if (sh.freeze && sh.freeze.cols > at) sh.freeze = { ...sh.freeze, cols: Math.max(0, sh.freeze.cols + Math.max(count, at - sh.freeze.cols)) };
  }

  // Объединения: сдвиг, растяжение при вставке внутрь, усечение при удалении
  if (sh.merges?.length) {
    const out: MergeRange[] = [];
    for (const m of sh.merges) {
      const lo = axis === 'row' ? m.r1 : m.c1, hi = axis === 'row' ? m.r2 : m.c2;
      let nlo: number, nhi: number;
      if (count > 0) {
        nlo = lo >= at ? lo + count : lo;
        nhi = hi >= at ? hi + count : hi;
      } else {
        const del = -count, end = at + del - 1;
        if (lo >= at && hi <= end) continue;                    // целиком удалено
        nlo = lo < at ? lo : lo > end ? lo - del : at;
        nhi = hi < at ? hi : hi > end ? hi - del : at - 1;
        if (nhi < nlo) continue;
      }
      const mm = axis === 'row' ? { ...m, r1: nlo, r2: nhi } : { ...m, c1: nlo, c2: nhi };
      if (mm.r1 !== mm.r2 || mm.c1 !== mm.c2) out.push(mm);
    }
    sh.merges = out.length ? out : undefined;
  }

  // Автофильтр
  if (sh.autoFilter) {
    const rg = parseRangeRef(sh.autoFilter);
    if (rg) {
      const lo = axis === 'row' ? rg.r1 : rg.c1, hi = axis === 'row' ? rg.r2 : rg.c2;
      const nlo = shiftIdx(lo, at, count) ?? at, nhi = shiftIdx(hi, at, count) ?? Math.max(nlo, at - 1);
      sh.autoFilter = nhi >= nlo ? rangeToRef(axis === 'row' ? { ...rg, r1: nlo, r2: nhi } : { ...rg, c1: nlo, c2: nhi }) : undefined;
    }
  }

  // Плавающие объекты
  const moveObj = <T extends { r: number; c: number }>(list: T[] | undefined): T[] | undefined => {
    if (!list?.length) return list;
    return list.map(o => {
      const v = axis === 'row' ? o.r : o.c;
      const nv = shiftIdx(v, at, count) ?? at;
      return axis === 'row' ? { ...o, r: nv } : { ...o, c: nv };
    });
  };
  sh.images = moveObj(sh.images);
  sh.charts = moveObj(sh.charts)?.map(ch => ({
    ...ch,
    series: ch.series.map(s => ({
      ...s,
      valRef: shiftRef(s.valRef, sh.name, axis, at, count),
      ...(s.catRef ? { catRef: shiftRef(s.catRef, sh.name, axis, at, count) } : {}),
      ...(s.nameRef ? { nameRef: shiftRef(s.nameRef, sh.name, axis, at, count) } : {}),
    })),
  }));

  // Формулы на ВСЕХ листах: ссылки на изменённый лист сдвигаются
  const op = { axis, at, count };
  const low = sh.name.toLowerCase();
  book.sheets.forEach((other, oi) => {
    const onThis = oi === sheetIdx;
    for (const row of other.data) for (const cell of row) {
      if (!cell.v || cell.v[0] !== '=') continue;
      const nv = shiftFormulaRefs(cell.v, op, onThis, n => n.toLowerCase() === low);
      if (nv !== cell.v) cell.v = nv;
    }
    // Ссылки диаграмм других листов на этот лист
    if (!onThis && other.charts?.length) {
      other.charts = other.charts.map(ch => ({
        ...ch,
        series: ch.series.map(s => ({
          ...s,
          valRef: refOnSheet(s.valRef, sh.name) ? shiftRef(s.valRef, sh.name, axis, at, count) : s.valRef,
          ...(s.catRef ? { catRef: refOnSheet(s.catRef, sh.name) ? shiftRef(s.catRef, sh.name, axis, at, count) : s.catRef } : {}),
        })),
      }));
    }
  });
}

function refOnSheet(ref: string, sheet: string): boolean {
  const m = ref.match(/^(?:'((?:[^']|'')+)'|([^!]+))!/);
  return !!m && (m[1] ?? m[2]).replace(/''/g, "'").toLowerCase() === sheet.toLowerCase();
}

/** Сдвиг ссылки диаграммы («B2:B9» или «Лист!$B$2:$B$9»). */
function shiftRef(ref: string, sheetName: string, axis: Axis, at: number, count: number): string {
  const hasSheet = /!/.test(ref);
  const f = shiftFormulaRefs('=' + ref, { axis, at, count }, !hasSheet, n => n.toLowerCase() === sheetName.toLowerCase());
  return f.slice(1);
}

// ── Объединение ячеек ────────────────────────────────────────────────────

/** Объединения, пересекающиеся с диапазоном. */
export function mergesIn(sh: SheetData, rg: MergeRange): MergeRange[] {
  return (sh.merges ?? []).filter(m => !(m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2));
}

/** Расширить диапазон, чтобы объединения не резались пополам (как делает Excel). */
export function expandToMerges(sh: SheetData, rg: MergeRange): MergeRange {
  let out = { ...rg };
  for (let guard = 0; guard < 10; guard++) {
    let grown = false;
    for (const m of mergesIn(sh, out)) {
      const next = { r1: Math.min(out.r1, m.r1), c1: Math.min(out.c1, m.c1), r2: Math.max(out.r2, m.r2), c2: Math.max(out.c2, m.c2) };
      if (next.r1 !== out.r1 || next.c1 !== out.c1 || next.r2 !== out.r2 || next.c2 !== out.c2) { out = next; grown = true; }
    }
    if (!grown) break;
  }
  return out;
}

/**
 * Объединить диапазон. mode: 'all' — в одну ячейку, 'across' — построчно.
 * Значение остаётся только в левой верхней ячейке, как в Excel.
 * Возвращает true, если какие-то значения были отброшены.
 */
export function mergeRange(sh: SheetData, rg: MergeRange, mode: 'all' | 'across' = 'all'): boolean {
  ensureSize(sh, rg.r2 + 1, rg.c2 + 1);
  sh.merges = (sh.merges ?? []).filter(m => m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2);
  let lost = false;
  const blocks: MergeRange[] = mode === 'across'
    ? Array.from({ length: rg.r2 - rg.r1 + 1 }, (_, i) => ({ r1: rg.r1 + i, r2: rg.r1 + i, c1: rg.c1, c2: rg.c2 }))
    : [rg];
  for (const b of blocks) {
    if (b.r1 === b.r2 && b.c1 === b.c2) continue;
    for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) {
      if (r === b.r1 && c === b.c1) continue;
      const cell = sh.data[r][c];
      if (cell.v || cell.img) lost = true;
      sh.data[r][c] = { v: '', ...(cell.s ? { s: cell.s } : {}) };
    }
    sh.merges.push({ ...b });
  }
  if (!sh.merges.length) delete sh.merges;
  return lost;
}

export function unmergeRange(sh: SheetData, rg: MergeRange): void {
  if (!sh.merges) return;
  sh.merges = sh.merges.filter(m => m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2);
  if (!sh.merges.length) delete sh.merges;
}

// ── Копирование / вставка ───────────────────────────────────────────────

export interface ClipBlock {
  cells: CellData[][];
  merges: MergeRange[];          // относительно левого верхнего угла блока
  colWidths?: (number | null)[];
  /** Откуда скопировано — для сдвига относительных ссылок в формулах. */
  srcR: number; srcC: number;
}

export function copyBlock(sh: SheetData, rg: MergeRange): ClipBlock {
  const cells: CellData[][] = [];
  for (let r = rg.r1; r <= rg.r2; r++) {
    const row: CellData[] = [];
    for (let c = rg.c1; c <= rg.c2; c++) row.push(cloneCell(sh.data[r]?.[c]));
    cells.push(row);
  }
  const merges = mergesIn(sh, rg)
    .filter(m => m.r1 >= rg.r1 && m.r2 <= rg.r2 && m.c1 >= rg.c1 && m.c2 <= rg.c2)
    .map(m => ({ r1: m.r1 - rg.r1, c1: m.c1 - rg.c1, r2: m.r2 - rg.r1, c2: m.c2 - rg.c1 }));
  return { cells, merges, srcR: rg.r1, srcC: rg.c1 };
}

export type PasteMode = 'all' | 'values' | 'formats' | 'formulas';

/**
 * Вставить блок в (r,c). Если выделение больше блока и кратно ему — блок
 * размножается, как в Excel. Возвращает занятый прямоугольник.
 */
export function pasteBlock(sh: SheetData, blk: ClipBlock, r0: number, c0: number, mode: PasteMode = 'all',
  target?: MergeRange, valueOf?: (cell: CellData, r: number, c: number) => CellData): MergeRange {
  const bh = blk.cells.length, bw = blk.cells[0]?.length ?? 0;
  if (!bh || !bw) return { r1: r0, c1: c0, r2: r0, c2: c0 };
  let reps = 1, repsC = 1;
  if (target) {
    const th = target.r2 - target.r1 + 1, tw = target.c2 - target.c1 + 1;
    if (th % bh === 0 && tw % bw === 0) { reps = th / bh; repsC = tw / bw; }
  }
  const H = bh * reps, W = bw * repsC;
  ensureSize(sh, r0 + H, c0 + W);
  unmergeRange(sh, { r1: r0, c1: c0, r2: r0 + H - 1, c2: c0 + W - 1 });
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const src = blk.cells[i % bh][j % bw];
    const r = r0 + i, c = c0 + j;
    const cur = sh.data[r][c];
    let next: CellData;
    if (mode === 'formats') {
      next = { ...cur };
      if (src.s) next.s = src.s; else delete next.s;
      if (src.nf) next.nf = src.nf; else delete next.nf;
    } else {
      next = cloneCell(src);
      if (src.v.startsWith('=')) {
        if (mode === 'values' && valueOf) next = valueOf(src, blk.srcR + (i % bh), blk.srcC + (j % bw));
        else next.v = offsetFormula(src.v, r - (blk.srcR + (i % bh)), c - (blk.srcC + (j % bw)));
      }
      if (mode === 'values' || mode === 'formulas') {
        // Только значения: оформление ячейки-получателя остаётся
        if (cur.s) next.s = cur.s; else delete next.s;
        if (mode === 'values' && !next.v.startsWith('=')) { /* nf источника нужен для чисел */ }
      }
    }
    sh.data[r][c] = next;
  }
  if (mode !== 'values') {
    for (let ri = 0; ri < reps; ri++) for (let ci = 0; ci < repsC; ci++) {
      for (const m of blk.merges) {
        (sh.merges ??= []).push({ r1: r0 + ri * bh + m.r1, c1: c0 + ci * bw + m.c1, r2: r0 + ri * bh + m.r2, c2: c0 + ci * bw + m.c2 });
      }
    }
  }
  return { r1: r0, c1: c0, r2: r0 + H - 1, c2: c0 + W - 1 };
}

/** Текст из буфера (Excel/Google кладут TSV) → блок ячеек с распознанными числами. */
export function blockFromText(text: string, interpret: (s: string) => CellData): ClipBlock {
  const rows = parseTsv(text);
  return { cells: rows.map(r => r.map(v => interpret(v))), merges: [], srcR: 0, srcC: 0 };
}

/** TSV с учётом кавычек (многострочные ячейки Excel приходят в кавычках). */
export function parseTsv(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
      continue;
    }
    if (ch === '"' && cur === '') { q = true; continue; }
    if (ch === '\t') { row.push(cur); cur = ''; continue; }
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += ch;
  }
  row.push(cur); rows.push(row);
  const w = Math.max(...rows.map(r => r.length));
  for (const r of rows) while (r.length < w) r.push('');
  return rows;
}

/** Блок → TSV для системного буфера (кавычки там, где нужны). */
export function blockToTsv(values: string[][]): string {
  return values.map(r => r.map(v => /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join('\t')).join('\r\n');
}

// ── Очистка ─────────────────────────────────────────────────────────────

export function clearRange(sh: SheetData, rg: MergeRange, what: 'all' | 'contents' | 'formats'): void {
  for (let r = rg.r1; r <= Math.min(rg.r2, sh.data.length - 1); r++) {
    const row = sh.data[r];
    for (let c = rg.c1; c <= Math.min(rg.c2, row.length - 1); c++) {
      const cell = row[c];
      if (what === 'all') row[c] = emptyCell();
      else if (what === 'contents') row[c] = { v: '', ...(cell.s ? { s: cell.s } : {}), ...(cell.nf ? { nf: cell.nf } : {}) };
      else { const n = { ...cell }; delete n.s; delete n.nf; delete n.rt; if (n.t === 'n' && !n.v) delete n.t; row[c] = n; }
    }
  }
  if (what !== 'contents') unmergeRange(sh, rg);
}

// ── Сортировка ──────────────────────────────────────────────────────────

/** Сравнение значений как в Excel: числа < текст < логические; пустые всегда в конце. */
export function compareCells(a: string, b: string, numA: number | null, numB: number | null): number {
  const ea = a.trim() === '', eb = b.trim() === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (numA !== null && numB !== null) return numA - numB;
  if (numA !== null) return -1;
  if (numB !== null) return 1;
  return a.localeCompare(b, 'ru', { sensitivity: 'base', numeric: true });
}

/**
 * Отсортировать строки диапазона по одной или нескольким колонкам.
 * value(r,c) — значение для сравнения (формулы уже посчитаны).
 */
export function sortRows(sh: SheetData, rg: MergeRange, keys: Array<{ col: number; desc?: boolean }>,
  value: (r: number, c: number) => { text: string; num: number | null }): void {
  const idx: number[] = [];
  for (let r = rg.r1; r <= rg.r2; r++) idx.push(r);
  const vals = new Map<string, { text: string; num: number | null }>();
  const get = (r: number, c: number) => {
    const k = r + ':' + c;
    let v = vals.get(k);
    if (!v) { v = value(r, c); vals.set(k, v); }
    return v;
  };
  idx.sort((x, y) => {
    for (const k of keys) {
      const a = get(x, k.col), b = get(y, k.col);
      let d = compareCells(a.text, b.text, a.num, b.num);
      const empty = a.text.trim() === '' || b.text.trim() === '';
      if (k.desc && !empty) d = -d;               // пустые остаются внизу и при обратной сортировке
      if (d) return d;
    }
    return x - y;
  });
  const rows = idx.map(r => sh.data[r].slice(rg.c1, rg.c2 + 1).map(cloneCell));
  const heights = idx.map(r => sh.rowHeights?.[r] ?? null);
  rows.forEach((cells, i) => {
    const r = rg.r1 + i;
    const dr = r - idx[i];
    cells.forEach((cell, j) => {
      // Формула переезжает вместе со строкой — относительные ссылки
      // на свою же строку должны указывать на неё и после сортировки
      if (cell.v.startsWith('=') && dr) cell.v = offsetFormula(cell.v, dr, 0);
      sh.data[r][rg.c1 + j] = cell;
    });
    if (sh.rowHeights && rg.c1 === 0) sh.rowHeights[r] = heights[i];
  });
}

/**
 * Текущая область вокруг ячейки (Ctrl+A / сортировка без выделения):
 * прямоугольник, ограниченный пустыми строками и колонками.
 */
export function currentRegion(sh: SheetData, r: number, c: number): MergeRange {
  const filled = (rr: number, cc: number) => !!sh.data[rr]?.[cc]?.v;
  let rg = { r1: r, c1: c, r2: r, c2: c };
  for (let guard = 0; guard < 200; guard++) {
    const before = JSON.stringify(rg);
    const rowFilled = (rr: number) => { for (let cc = Math.max(0, rg.c1 - 1); cc <= rg.c2 + 1; cc++) if (filled(rr, cc)) return true; return false; };
    const colFilled = (cc: number) => { for (let rr = Math.max(0, rg.r1 - 1); rr <= rg.r2 + 1; rr++) if (filled(rr, cc)) return true; return false; };
    if (rg.r1 > 0 && rowFilled(rg.r1 - 1)) rg.r1--;
    if (rg.r2 + 1 < sh.data.length && rowFilled(rg.r2 + 1)) rg.r2++;
    if (rg.c1 > 0 && colFilled(rg.c1 - 1)) rg.c1--;
    if (rg.c2 + 1 < (sh.data[0]?.length ?? 0) && colFilled(rg.c2 + 1)) rg.c2++;
    if (JSON.stringify(rg) === before) break;
  }
  rg = expandToMerges(sh, rg);
  return rg;
}

/** Похожа ли первая строка диапазона на шапку (текст над числами). */
export function looksLikeHeader(sh: SheetData, rg: MergeRange): boolean {
  if (rg.r2 <= rg.r1) return false;
  const first = sh.data[rg.r1]?.slice(rg.c1, rg.c2 + 1) ?? [];
  const second = sh.data[rg.r1 + 1]?.slice(rg.c1, rg.c2 + 1) ?? [];
  const textHead = first.every(c => !c.v || (c.t !== 'n' && parseUserNumber(c.v) === null));
  const bold = first.some(c => /font-weight:bold/.test(c.s ?? ''));
  const numBelow = second.some(c => c.t === 'n' || (c.v && parseUserNumber(c.v) !== null));
  return textHead && (bold || numBelow || first.some(c => c.v) && second.some(c => c.v));
}

// ── Автозаполнение ───────────────────────────────────────────────────────

const CYCLES = [
  ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'],
  ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'],
  ['Q1', 'Q2', 'Q3', 'Q4'],
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
];

/**
 * Значения для автозаполнения по образцу src (по одной оси).
 * Числа и даты (серийные) продолжают прогрессию, «Товар 1» → «Товар 2»,
 * дни и месяцы идут по кругу, формулы сдвигают ссылки, остальное повторяется.
 */
export function fillSeries(src: CellData[], n: number, step: { dr: number; dc: number }, backward = false): CellData[] {
  const out: CellData[] = [];
  if (!src.length) return out;
  const L = src.length;
  const nums = src.map(c => (c.t === 'n' && c.v !== '' ? Number(c.v) : null));
  const allNum = nums.every(v => v !== null && isFinite(v));
  const textNum = src.map(c => c.t !== 'n' ? c.v.match(/^(.*?)(\d+)(\D*)$/) : null);
  const allTextNum = !allNum && textNum.every(m => m) && textNum.every(m => m![1] === textNum[0]![1] && m![3] === textNum[0]![3]);
  const cycle = CYCLES.find(list => src.every(c => list.some(x => x.toLowerCase() === c.v.trim().toLowerCase())));

  for (let k = 1; k <= n; k++) {
    // Образец повторяется по кругу; прогрессия считается по всему образцу
    const base = backward ? src[(L - (k % L)) % L] : src[(k - 1) % L];
    let cell: CellData = cloneCell(base);
    if (base.v.startsWith('=')) {
      // Расстояние от ячейки-образца до заполняемой — на него и сдвигаются ссылки
      const off = (backward ? -1 : 1) * Math.ceil(k / L) * L;
      cell.v = offsetFormula(base.v, step.dr * off, step.dc * off);
    } else if (allNum) {
      const vals = nums as number[];
      // Одно число Excel копирует, а одну дату — продолжает по дням
      const d = L > 1 ? (vals[L - 1] - vals[0]) / (L - 1) : (isDateFormat(src[0].nf ?? '') ? 1 : 0);
      const v = backward ? vals[0] - d * k : vals[L - 1] + d * k;
      cell = { ...cloneCell(src[backward ? 0 : L - 1]), v: String(Math.round(v * 1e10) / 1e10), t: 'n' };
    } else if (allTextNum) {
      const vals = textNum.map(m => +m![2]);
      const d = L > 1 ? (vals[L - 1] - vals[0]) / (L - 1) : 1;
      const v = Math.round(backward ? vals[0] - d * k : vals[L - 1] + d * k);
      const m0 = textNum[backward ? 0 : L - 1]!;
      cell = { ...cloneCell(src[backward ? 0 : L - 1]), v: `${m0[1]}${Math.max(0, v)}${m0[3]}` };
    } else if (cycle) {
      const pos = src.map(c => cycle.findIndex(x => x.toLowerCase() === c.v.trim().toLowerCase()));
      const d = L > 1 ? (pos[L - 1] - pos[0]) / (L - 1) : 1;
      const p = Math.round(backward ? pos[0] - d * k : pos[L - 1] + d * k);
      const word = cycle[((p % cycle.length) + cycle.length) % cycle.length];
      const ref = src[0].v.trim();
      cell = { ...cloneCell(src[backward ? 0 : L - 1]), v: ref === ref.toUpperCase() ? word.toUpperCase() : ref === ref.toLowerCase() ? word.toLowerCase() : word };
    }
    out.push(cell);
  }
  return out;
}

// ── Листы ───────────────────────────────────────────────────────────────

export function uniqueSheetName(book: ExcelContent, base: string): string {
  const taken = new Set(book.sheets.map(s => s.name.toLowerCase()));
  const clean = base.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Лист';
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 1000; i++) {
    const n = `${clean.slice(0, 27)} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return clean + Date.now();
}

export function nextSheetName(book: ExcelContent): string {
  for (let i = book.sheets.length + 1; i < 1000; i++) {
    const n = `Лист${i}`;
    if (!book.sheets.some(s => s.name.toLowerCase() === n.toLowerCase())) return n;
  }
  return 'Лист' + Date.now();
}

/** Переименовать лист вместе со ссылками на него в формулах всей книги. */
export function renameSheet(book: ExcelContent, idx: number, to: string): void {
  const from = book.sheets[idx].name;
  book.sheets[idx].name = to;
  for (const sh of book.sheets) {
    for (const row of sh.data) for (const cell of row) {
      if (cell.v.startsWith('=')) cell.v = renameSheetInFormula(cell.v, from, to);
    }
    for (const ch of sh.charts ?? []) for (const s of ch.series) {
      for (const key of ['valRef', 'catRef', 'nameRef'] as const) {
        const ref = s[key];
        if (ref && /!/.test(ref)) s[key] = renameSheetInFormula('=' + ref, from, to).slice(1);
      }
    }
  }
}

export function cloneSheet(sh: SheetData, name: string): SheetData {
  const copy: SheetData = JSON.parse(JSON.stringify(sh));
  copy.name = name;
  return copy;
}
