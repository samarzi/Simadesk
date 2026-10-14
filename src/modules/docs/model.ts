/**
 * Модель документа редактора: книга Excel и её листы.
 *
 * Модель — единственный источник правды. Таблица в DOM только рисует её;
 * раньше всё было наоборот (лист собирался обратно из <td>), и любая
 * операция, которой не было в DOM (строки за пределами виртуального окна,
 * объединения, ширины), терялась или портила соседние данные.
 */

import type { CellType } from '@/utils/numFormat';

export type DocType = 'word' | 'excel';

/** Кусок форматированного текста внутри ячейки (часть слова жирным и т.п.). */
export interface RichRun {
  text: string;
  /** CSS шрифта куска — те же свойства, что у ячейки. */
  s?: string;
}

export interface CellData {
  /**
   * Сырое значение ячейки — то, что хранится, а не то, что видно.
   * Число — машинной строкой («1234.5»), дата — серийным номером Excel,
   * формула — с «=» в начале. Форматирование применяется только на отрисовке.
   */
  v: string;
  /** Оформление ячейки — каноническая CSS-строка (см. xlStyle.ts). */
  s?: string;
  t?: CellType; // 'n' | 's' | 'd' | 'b'; отсутствие = текст
  nf?: string;  // код числового формата Excel («#,##0.00», «dd.mm.yyyy»)
  /** Картинка в ячейке — data:URL (или https-ссылка). */
  img?: string;
  imgW?: number;
  imgH?: number;
  /** Гиперссылка. */
  link?: string;
  /** Примечание к ячейке. */
  note?: string;
  /** Форматированный текст; действителен, пока v совпадает с его текстом. */
  rt?: RichRun[];
}

export interface MergeRange { r1: number; c1: number; r2: number; c2: number; }

/** Плавающая картинка листа (как в Excel — поверх сетки, с привязкой к ячейке). */
export interface FloatImage {
  id: string;
  src: string;
  /** Левый верхний угол: ячейка + смещение внутри неё в px. */
  r: number; c: number; dx?: number; dy?: number;
  w: number; h: number;
}

export type ChartKind = 'col' | 'bar' | 'line' | 'pie' | 'doughnut' | 'area' | 'scatter';

export interface ChartSeries {
  /** Имя ряда — текст или ссылка «Лист!$B$1». */
  name?: string;
  nameRef?: string;
  /** Подписи категорий — ссылка на диапазон. */
  catRef?: string;
  /** Значения — ссылка на диапазон. */
  valRef: string;
  color?: string;
}

export interface ChartSpec {
  id: string;
  kind: ChartKind;
  title?: string;
  series: ChartSeries[];
  /** Привязка к листу, как у картинки. */
  r: number; c: number; dx?: number; dy?: number;
  w: number; h: number;
  legend?: boolean;
  stacked?: boolean;
}

export interface SheetData {
  name: string;
  data: CellData[][];
  colWidths?: (number | null)[];
  rowHeights?: (number | null)[];
  merges?: MergeRange[];
  truncated?: boolean;
  /** Импорт ограничил число колонок защитным лимитом. */
  truncatedCols?: boolean;
  hidden?: boolean;
  hiddenRows?: number[];
  hiddenCols?: number[];
  /** Закреплённые области: сколько строк сверху и колонок слева. */
  freeze?: { rows: number; cols: number };
  /** Диапазон автофильтра, «A1:F200». */
  autoFilter?: string;
  tabColor?: string;
  showGrid?: boolean;
  zoom?: number;
  /** Ширина колонки / высота строки по умолчанию, px. */
  defColW?: number;
  defRowH?: number;
  images?: FloatImage[];
  charts?: ChartSpec[];
  /** Отбор автофильтра: номер колонки → разрешённые значения (как показаны). */
  filter?: Record<string, string[]>;
  /**
   * То, что редактор не показывает, но обязан вернуть в файл без потерь:
   * условное форматирование, проверка данных, параметры печати.
   */
  xl?: Record<string, unknown>;
  /** Палитра стилей — только в сериализованном виде. */
  styles?: string[];
}

export interface ExcelContent {
  sheets: SheetData[];
  /** Шрифт книги по умолчанию (Calibri 11 у нового файла Excel). */
  font?: { name: string; size: number };
}

export interface WordMeta {
  /** Размер и поля страницы в twip (1/20 пункта) — как в .docx. */
  page?: { w: number; h: number; top: number; right: number; bottom: number; left: number; landscape?: boolean };
  /** Шрифт документа по умолчанию. */
  font?: { name: string; size: number };
}

export interface DocItem {
  id: string;
  type: DocType;
  title: string;
  content: string;
  updated_at: number;
  /** Владелец (id пользователя). Пусто — документ создан до появления доступа. */
  owner_id?: string | null;
  /** Кому виден: всей компании или только владельцу. */
  visibility?: 'company' | 'private';
  meta?: WordMeta;
}

export const XL_ROWS = 100;
export const XL_COLS = 26;

/** Ширина «нуля» Calibri 11 — единица ширины колонки OOXML. */
export const XL_MDW = 7;
/** Пикселей на пункт: высота строки в OOXML измеряется в пунктах. */
export const XL_PX_PER_PT = 4 / 3;
export const XL_DEF_COL_PX = 64;   // 8.43 символа — колонка Excel по умолчанию
export const XL_DEF_ROW_PX = 20;   // 15 pt

/** Ширина колонки OOXML (в символах) → пиксели, как считает сам Excel. */
export function colCharsToPx(w: number): number { return Math.round(w * XL_MDW + 5); }
export function colPxToChars(px: number): number { return Math.max(0, Math.round(((px - 5) / XL_MDW) * 100) / 100); }

export function colLetter(n: number): string {
  let s = ''; n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function letterToCol(l: string): number {
  let n = 0; for (const ch of l.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1;
}

/** «B3» → {r:2,c:1}; null, если адрес неверный. */
export function parseCellRef(ref: string): { r: number; c: number } | null {
  const m = String(ref).trim().toUpperCase().replace(/\$/g, '').match(/^([A-Z]{1,3})(\d{1,7})$/);
  if (!m) return null;
  return { r: +m[2] - 1, c: letterToCol(m[1]) };
}

/** «A1:C5» / «B2» → прямоугольник (упорядоченный). */
export function parseRangeRef(ref: string): MergeRange | null {
  const [a, b] = String(ref).trim().split(':');
  const p = parseCellRef(a);
  if (!p) return null;
  const q = b ? parseCellRef(b) : p;
  if (!q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

export function rangeToRef(m: MergeRange): string {
  const a = `${colLetter(m.c1)}${m.r1 + 1}`, b = `${colLetter(m.c2)}${m.r2 + 1}`;
  return a === b ? a : `${a}:${b}`;
}

export function emptyCell(): CellData { return { v: '' }; }

/** Дорастить лист до rows×cols (данные хранятся прямоугольником). */
export function ensureSize(sheet: SheetData, rows: number, cols: number): void {
  const curCols = Math.max(cols, sheet.data[0]?.length ?? 0);
  for (const row of sheet.data) while (row.length < curCols) row.push(emptyCell());
  while (sheet.data.length < rows) sheet.data.push(Array.from({ length: curCols }, emptyCell));
}

/** Есть ли в ячейке что-то, кроме пустоты (значение, стиль, картинка…). */
export function cellHasContent(c: CellData | undefined): boolean {
  return !!c && (!!c.v || !!c.s || !!c.img || !!c.nf || !!c.note || !!c.link);
}

/** Новая пустая книга: один лист, привычная сетка. */
export function newWorkbook(): ExcelContent {
  return {
    sheets: [{ name: 'Лист1', data: Array.from({ length: XL_ROWS }, () => Array.from({ length: XL_COLS }, emptyCell)) }],
  };
}

export function uid(prefix = 'o'): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
