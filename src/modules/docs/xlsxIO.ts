/**
 * Чтение и запись .xlsx без потери оформления.
 *
 * Раньше импорт шёл через SheetJS (который не отдаёт стили целиком) плюс
 * ручной разбор XML, а экспорт — через самописный генератор styles.xml.
 * Оба пути теряли разное, поэтому файл после «открыл → сохранил» выглядел
 * иначе: пропадали белый текст, чёрная заливка, тип рамок, перенос,
 * отступы, закрепление, скрытые строки, шрифт книги, картинки и диаграммы,
 * а пустые строки и колонки слева/сверху вообще вырезались.
 *
 * Теперь и чтение, и запись идут через ExcelJS — он понимает модель стилей
 * Excel полностью. Чего ExcelJS не умеет (диаграммы, шрифт книги по
 * умолчанию, своя индексная палитра), дочитываем и дописываем прямо в zip.
 */

import {
  type CellData, type ChartKind, type ChartSeries, type ChartSpec, type ExcelContent, type FloatImage,
  type MergeRange, type SheetData,
  colCharsToPx, colPxToChars, colLetter, parseRangeRef, rangeToRef, uid, XL_PX_PER_PT,
} from './model';
import { excelToX, xToCss, cssToX, xToExcel, type ColorResolver } from './xlStyle';
import { dateToSerial } from '@/utils/numFormat';
import { toExcelFormula } from '@/utils/formula';
import { isSafeImageSrc } from '@/utils/docImage';

export const MAX_IMPORT_ROWS = 20000;
const EMU_PER_PX = 9525;

// ── Палитры ─────────────────────────────────────────────────────────────────

/** Устаревшая индексная палитра Excel (ECMA-376, §18.8.27). */
export const XL_INDEXED_COLORS: string[] = [
  '000000','ffffff','ff0000','00ff00','0000ff','ffff00','ff00ff','00ffff',
  '000000','ffffff','ff0000','00ff00','0000ff','ffff00','ff00ff','00ffff',
  '800000','008000','000080','808000','800080','008080','c0c0c0','808080',
  '9999ff','993366','ffffcc','ccffff','660066','ff8080','0066cc','ccccff',
  '000080','ff00ff','ffff00','00ffff','800080','800000','008080','0000ff',
  '00ccff','ccffff','ccffcc','ffff99','99ccff','ff99cc','cc99ff','ffcc99',
  '3366ff','33cccc','99cc00','ffcc00','ff9900','ff6600','666699','969696',
  '003366','339966','003300','333300','993300','993366','333399','333333',
];

/** Цвета темы Office по умолчанию — если в файле темы нет. */
const DEFAULT_THEME = ['ffffff', '000000', 'e7e6e6', '44546a', '4472c4', 'ed7d31', 'a5a5a5', 'ffc000', '5b9bd5', '70ad47', '0563c1', '954f72'];

/**
 * Палитра темы. Порядок индексов theme="N" не совпадает с порядком в XML:
 * там dk1, lt1, dk2, lt2, а индексы идут 0=lt1, 1=dk1, 2=lt2, 3=dk2.
 */
export function readThemeColors(xml: string | undefined): string[] {
  const colors = [...DEFAULT_THEME];
  if (!xml) return colors;
  const slots = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  slots.forEach((slot, i) => {
    const srgb = xml.match(new RegExp(`<a:${slot}[^>]*>\\s*<a:srgbClr val="([0-9A-Fa-f]{6})"`));
    if (srgb) { colors[i] = srgb[1].toLowerCase(); return; }
    const sys = xml.match(new RegExp(`<a:${slot}[^>]*>\\s*<a:sysClr[^>]+lastClr="([0-9A-Fa-f]{6})"`));
    if (sys) colors[i] = sys[1].toLowerCase();
  });
  return colors;
}

/** Оттенок Excel (tint) к цвету (ECMA-376 §18.8.3, через HSL). */
export function tintHex(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const s = max === min ? 0 : l <= 0.5 ? (max - min) / (2 * l) : (max - min) / (2 - 2 * l);
  const h = max === min ? 0 : max === r ? ((g - b) / (max - min) + 6) % 6 / 6 : max === g ? ((b - r) / (max - min) + 2) / 6 : ((r - g) / (max - min) + 4) / 6;
  l = tint >= 0 ? l + (1 - l) * tint : l * (1 + tint);
  l = Math.max(0, Math.min(1, l));
  const hue2rgb = (p: number, q: number, t: number) => { if (t < 0) t++; if (t > 1) t--; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < .5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const nr = s ? hue2rgb(p, q, h + 1 / 3) : l, ng = s ? hue2rgb(p, q, h) : l, nb = s ? hue2rgb(p, q, h - 1 / 3) : l;
  return [nr, ng, nb].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

export function makeColorResolver(theme: string[], indexed: string[]): ColorResolver {
  return (c: any) => {
    if (!c) return null;
    const tinted = (hex: string) => '#' + (c.tint ? tintHex(hex, +c.tint) : hex);
    if (typeof c.argb === 'string') {
      const h = c.argb.length === 8 ? c.argb.slice(2) : c.argb;
      return /^[0-9a-f]{6}$/i.test(h) ? tinted(h.toLowerCase()) : null;
    }
    if (c.theme != null) { const base = theme[+c.theme]; return base ? tinted(base) : null; }
    if (c.indexed != null) {
      const i = +c.indexed;
      if (i === 64 || i === 65) return null;       // «авто» — системный цвет
      const hex = indexed[i] ?? XL_INDEXED_COLORS[i];
      return hex ? tinted(hex) : null;
    }
    return null;
  };
}

// ── Пути внутри zip ─────────────────────────────────────────────────────────

/** Целевой путь связи относительно файла-источника. */
function resolveTarget(fromFile: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = fromFile.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') base.pop();
    else if (part !== '.') base.push(part);
  }
  return base.join('/');
}

function relsPath(file: string): string {
  const parts = file.split('/');
  const name = parts.pop();
  return [...parts, '_rels', `${name}.rels`].join('/');
}

function parseRels(xml: string | null): Array<{ id: string; type: string; target: string }> {
  if (!xml) return [];
  const out: Array<{ id: string; type: string; target: string }> = [];
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1];
    const id = a.match(/\bId="([^"]+)"/)?.[1], type = a.match(/\bType="([^"]+)"/)?.[1], target = a.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) out.push({ id, type: type ?? '', target });
  }
  return out;
}

/** Порядок листов книги → путь к XML листа. */
async function sheetPaths(zip: any): Promise<string[]> {
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const rels = parseRels(await zip.file('xl/_rels/workbook.xml.rels')?.async('string') ?? null);
  if (!wbXml) return [];
  const ids: string[] = [];
  const re = /<sheet\b[^>]*?r:id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wbXml)) !== null) ids.push(m[1]);
  return ids.map(id => {
    const t = rels.find(r => r.id === id)?.target;
    return t ? resolveTarget('xl/workbook.xml', t) : '';
  });
}

// ── Чтение ──────────────────────────────────────────────────────────────────

const xmlUnesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Диаграммы листа: drawing → chart XML → наша ChartSpec. */
async function readCharts(zip: any, sheetFile: string, toPx: AnchorToPx): Promise<ChartSpec[]> {
  if (!sheetFile) return [];
  const sheetRels = parseRels(await zip.file(relsPath(sheetFile))?.async('string') ?? null);
  const out: ChartSpec[] = [];
  for (const rel of sheetRels.filter(r => /\/drawing$/.test(r.type))) {
    const drawingFile = resolveTarget(sheetFile, rel.target);
    const dxml: string | undefined = await zip.file(drawingFile)?.async('string');
    if (!dxml) continue;
    const drels = parseRels(await zip.file(relsPath(drawingFile))?.async('string') ?? null);
    const anchorRe = /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g;
    let am: RegExpExecArray | null;
    while ((am = anchorRe.exec(dxml)) !== null) {
      const a = am[0];
      const chartRid = a.match(/<c:chart\b[^>]*r:id="([^"]+)"/)?.[1];
      if (!chartRid) continue;
      const chartRel = drels.find(r => r.id === chartRid);
      if (!chartRel) continue;
      const cxml: string | undefined = await zip.file(resolveTarget(drawingFile, chartRel.target))?.async('string');
      if (!cxml) continue;
      const pos = anchorPos(a, toPx);
      const spec = parseChartXml(cxml);
      if (spec) out.push({ ...spec, ...pos });
    }
  }
  return out;
}

type AnchorToPx = (col: number, colOffEmu: number, row: number, rowOffEmu: number) => { x: number; y: number };

/** Позиция и размер объекта из якоря рисунка. */
function anchorPos(a: string, toPx: AnchorToPx): { r: number; c: number; dx: number; dy: number; w: number; h: number } {
  const num = (block: string | undefined, tag: string) => +(block?.match(new RegExp(`<xdr:${tag}>(-?\\d+)</xdr:${tag}>`))?.[1] ?? 0);
  const from = a.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/)?.[1];
  const to = a.match(/<xdr:to>([\s\S]*?)<\/xdr:to>/)?.[1];
  const ext = a.match(/<xdr:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  const c = num(from, 'col'), r = num(from, 'row');
  const dx = Math.round(num(from, 'colOff') / EMU_PER_PX), dy = Math.round(num(from, 'rowOff') / EMU_PER_PX);
  let w = 480, h = 288;
  if (to) {
    const p1 = toPx(c, num(from, 'colOff'), r, num(from, 'rowOff'));
    const p2 = toPx(num(to, 'col'), num(to, 'colOff'), num(to, 'row'), num(to, 'rowOff'));
    w = Math.max(40, Math.round(p2.x - p1.x)); h = Math.max(30, Math.round(p2.y - p1.y));
  } else if (ext) {
    w = Math.round(+ext[1] / EMU_PER_PX); h = Math.round(+ext[2] / EMU_PER_PX);
  }
  return { r, c, dx, dy, w, h };
}

/** Разобрать chartN.xml: тип, заголовок, ряды со ссылками на ячейки. */
export function parseChartXml(xml: string): Omit<ChartSpec, 'r' | 'c' | 'w' | 'h'> | null {
  const plot = xml.match(/<c:plotArea>([\s\S]*?)<\/c:plotArea>/)?.[1] ?? '';
  const typeM = plot.match(/<c:(barChart|bar3DChart|lineChart|line3DChart|pieChart|pie3DChart|doughnutChart|areaChart|area3DChart|scatterChart)>([\s\S]*?)<\/c:\1>/);
  if (!typeM) return null;
  const tag = typeM[1], body = typeM[2];
  let kind: ChartKind;
  if (tag.startsWith('bar')) kind = /<c:barDir val="bar"/.test(body) ? 'bar' : 'col';
  else if (tag.startsWith('line')) kind = 'line';
  else if (tag.startsWith('pie')) kind = 'pie';
  else if (tag === 'doughnutChart') kind = 'doughnut';
  else if (tag.startsWith('area')) kind = 'area';
  else kind = 'scatter';
  const stacked = /<c:grouping val="(stacked|percentStacked)"/.test(body);

  const titleBlock = xml.match(/<c:chart>[\s\S]*?<c:title>([\s\S]*?)<\/c:title>/)?.[1];
  const title = titleBlock ? xmlUnesc([...titleBlock.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]).join('')) : undefined;

  const series: ChartSeries[] = [];
  const serRe = /<c:ser>([\s\S]*?)<\/c:ser>/g;
  let sm: RegExpExecArray | null;
  while ((sm = serRe.exec(body)) !== null) {
    const s = sm[1];
    const ref = (block: string | undefined) => block?.match(/<c:f>([\s\S]*?)<\/c:f>/)?.[1];
    const txBlock = s.match(/<c:tx>([\s\S]*?)<\/c:tx>/)?.[1];
    const catBlock = s.match(/<c:(?:cat|xVal)>([\s\S]*?)<\/c:(?:cat|xVal)>/)?.[1];
    const valBlock = s.match(/<c:(?:val|yVal)>([\s\S]*?)<\/c:(?:val|yVal)>/)?.[1];
    const valRef = ref(valBlock);
    if (!valRef) continue;
    const color = s.match(/<c:spPr>[\s\S]*?<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
    const nameRef = ref(txBlock);
    const nameLit = txBlock?.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1];
    series.push({
      valRef: xmlUnesc(valRef),
      ...(catBlock && ref(catBlock) ? { catRef: xmlUnesc(ref(catBlock)!) } : {}),
      ...(nameRef ? { nameRef: xmlUnesc(nameRef) } : nameLit ? { name: xmlUnesc(nameLit) } : {}),
      ...(color ? { color: '#' + color.toLowerCase() } : {}),
    });
  }
  if (!series.length) return null;
  const legend = /<c:legend>/.test(xml);
  return { id: uid('ch'), kind, ...(title ? { title } : {}), series, legend, ...(stacked ? { stacked } : {}) };
}

/** Значение ячейки ExcelJS → наша модель. */
function cellFromExcel(cell: any, colorOf: ColorResolver, defFont?: { name: string; size: number }): CellData {
  const out: CellData = { v: '' };
  const v = cell.value;
  const nf: string | undefined = cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : undefined;
  if (nf) out.nf = nf;

  const setPlain = (val: unknown) => {
    if (val == null) return;
    if (typeof val === 'number') { out.v = String(val); out.t = 'n'; return; }
    if (typeof val === 'boolean') { out.v = val ? 'ИСТИНА' : 'ЛОЖЬ'; out.t = 'b'; return; }
    if (val instanceof Date) {
      out.v = String(dateToSerial(val)); out.t = 'n';
      if (!out.nf) out.nf = 'dd.mm.yyyy';
      return;
    }
    out.v = String(val);
  };

  if (v == null) { /* пустая, но может быть со стилем */ }
  else if (typeof v === 'object' && !(v instanceof Date)) {
    if ('formula' in v || 'sharedFormula' in v) {
      const f = cell.formula ?? v.formula;
      if (f) out.v = '=' + String(f);
      else setPlain(v.result);
    } else if (Array.isArray(v.richText)) {
      out.v = v.richText.map((r: any) => r.text ?? '').join('');
      out.rt = v.richText.map((r: any) => {
        const x = r.font ? excelToX({ font: r.font }, colorOf, defFont) : {};
        const s = xToCss(x);
        return s ? { text: String(r.text ?? ''), s } : { text: String(r.text ?? '') };
      });
    } else if ('hyperlink' in v) {
      out.v = typeof v.text === 'object' && v.text?.richText
        ? v.text.richText.map((r: any) => r.text).join('') : String(v.text ?? v.hyperlink ?? '');
      out.link = String(v.hyperlink);
    } else if ('error' in v) {
      out.v = String(v.error);
      delete out.nf;
    } else {
      setPlain(String(v.text ?? ''));
    }
  } else {
    setPlain(v);
  }

  if (cell.note) {
    const n = cell.note;
    const text = typeof n === 'string' ? n : Array.isArray(n?.texts) ? n.texts.map((t: any) => t.text ?? '').join('') : '';
    if (text) out.note = text;
  }
  const css = xToCss(excelToX(cell.style, colorOf, defFont));
  if (css) out.s = css;
  return out;
}

function u8ToDataUrl(bytes: Uint8Array, ext: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Прочитать .xlsx в модель книги. */
export async function readXlsx(buf: ArrayBuffer, opts: { maxRows?: number } = {}): Promise<ExcelContent> {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import('exceljs'), import('jszip')]);
  const wb = new (ExcelJS as any).Workbook();
  await wb.xlsx.load(buf);
  const zip = await (JSZip as any).loadAsync(buf);

  const themeXml: string | undefined = wb._themes?.theme1
    ?? await zip.file('xl/theme/theme1.xml')?.async('string');
  const stylesXml: string = await zip.file('xl/styles.xml')?.async('string') ?? '';
  const indexed: string[] = [];
  const idxBlock = stylesXml.match(/<indexedColors>([\s\S]*?)<\/indexedColors>/);
  if (idxBlock) for (const m of idxBlock[1].matchAll(/<rgbColor[^>]*rgb="([0-9A-Fa-f]{6,8})"/g))
    indexed.push((m[1].length === 8 ? m[1].slice(2) : m[1]).toLowerCase());
  const colorOf = makeColorResolver(readThemeColors(themeXml), indexed);

  // Шрифт книги: первый <font> в styles.xml — им Excel рисует всё «без стиля»
  const f0 = stylesXml.match(/<fonts[^>]*>\s*<font>([\s\S]*?)<\/font>/)?.[1] ?? '';
  const font = {
    name: f0.match(/<name val="([^"]+)"/)?.[1] ?? 'Calibri',
    size: +(f0.match(/<sz val="([\d.]+)"/)?.[1] ?? 11),
  };

  const paths = await sheetPaths(zip);
  const sheets: SheetData[] = [];
  const worksheets: any[] = wb.worksheets;

  for (let si = 0; si < worksheets.length; si++) {
    const ws = worksheets[si];
    const merges: MergeRange[] = [];
    for (const ref of (ws.model?.merges ?? []) as string[]) {
      const m = parseRangeRef(ref);
      if (m) merges.push(m);
    }

    // Размер — от A1 до последней строки/колонки, где есть данные, стиль,
    // объединение или своя ширина. Пустые строки и колонки в начале
    // сохраняются: раньше лист сдвигался к первой непустой ячейке.
    let rows = Math.max(ws.rowCount || 0, ...merges.map(m => m.r2 + 1), 1);
    let cols = Math.max(ws.columnCount || 0, ...merges.map(m => m.c2 + 1), 1);
    const truncated = rows > maxRows;
    if (truncated) rows = maxRows;
    cols = Math.min(cols, 16384);

    const data: CellData[][] = [];
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r);
      const out: CellData[] = [];
      for (let c = 1; c <= cols; c++) {
        const cell = row.findCell ? row.findCell(c) : row.getCell(c);
        out.push(cell ? cellFromExcel(cell, colorOf, font) : { v: '' });
      }
      data.push(out);
    }

    const colWidths: (number | null)[] = [];
    const hiddenCols: number[] = [];
    for (let c = 1; c <= cols; c++) {
      const col = ws.getColumn(c);
      colWidths.push(col.width ? colCharsToPx(col.width) : null);
      if (col.hidden) hiddenCols.push(c - 1);
    }
    const rowHeights: (number | null)[] = [];
    const hiddenRows: number[] = [];
    for (let r = 1; r <= rows; r++) {
      const row = ws.findRow ? ws.findRow(r) : ws.getRow(r);
      rowHeights.push(row?.height ? Math.round(row.height * XL_PX_PER_PT) : null);
      if (row?.hidden) hiddenRows.push(r - 1);
    }

    const sheet: SheetData = { name: ws.name, data, colWidths, rowHeights };
    if (merges.length) sheet.merges = merges;
    if (truncated) sheet.truncated = true;
    if (hiddenRows.length) sheet.hiddenRows = hiddenRows;
    if (hiddenCols.length) sheet.hiddenCols = hiddenCols;
    if (ws.state && ws.state !== 'visible') sheet.hidden = true;

    const view = ws.views?.[0];
    if (view) {
      if (view.state === 'frozen' && (view.xSplit || view.ySplit))
        sheet.freeze = { rows: view.ySplit || 0, cols: view.xSplit || 0 };
      if (view.showGridLines === false) sheet.showGrid = false;
      if (view.zoomScale && view.zoomScale !== 100) sheet.zoom = view.zoomScale;
    }
    const af = ws.autoFilter;
    if (af) sheet.autoFilter = typeof af === 'string' ? af : (af.from && af.to ? `${typeof af.from === 'string' ? af.from : colLetter(af.from.column - 1) + af.from.row}:${typeof af.to === 'string' ? af.to : colLetter(af.to.column - 1) + af.to.row}` : undefined);
    if (!sheet.autoFilter) delete sheet.autoFilter;
    const tab = ws.properties?.tabColor ? colorOf(ws.properties.tabColor) : null;
    if (tab) sheet.tabColor = tab;
    if (ws.properties?.defaultColWidth) sheet.defColW = colCharsToPx(ws.properties.defaultColWidth);
    if (ws.properties?.defaultRowHeight && ws.properties.defaultRowHeight !== 15)
      sheet.defRowH = Math.round(ws.properties.defaultRowHeight * XL_PX_PER_PT);

    // То, что редактор не показывает, но обязан вернуть в файл
    const xl: Record<string, unknown> = {};
    if (ws.model?.conditionalFormattings?.length) xl.cf = ws.model.conditionalFormattings;
    const dv = ws.dataValidations?.model;
    if (dv && Object.keys(dv).length) xl.dv = dv;
    if (ws.pageSetup) xl.pageSetup = ws.pageSetup;
    if (ws.headerFooter && Object.values(ws.headerFooter).some(v => v)) xl.headerFooter = ws.headerFooter;
    if (Object.keys(xl).length) sheet.xl = JSON.parse(JSON.stringify(xl));

    // Позиция объектов рисунка в пикселях
    const colPx = (c: number) => sheet.colWidths?.[c] ?? sheet.defColW ?? 64;
    const rowPx = (r: number) => sheet.rowHeights?.[r] ?? sheet.defRowH ?? 20;
    const toPx: AnchorToPx = (c, cOff, r, rOff) => {
      let x = 0, y = 0;
      for (let i = 0; i < c; i++) x += colPx(i);
      for (let i = 0; i < r; i++) y += rowPx(i);
      return { x: x + cOff / EMU_PER_PX, y: y + rOff / EMU_PER_PX };
    };

    // Картинки
    const images: FloatImage[] = [];
    for (const img of ws.getImages?.() ?? []) {
      const media = wb.getImage?.(+img.imageId);
      if (!media?.buffer) continue;
      const src = u8ToDataUrl(new Uint8Array(media.buffer), media.extension ?? 'png');
      const tl = img.range?.tl, br = img.range?.br, ext = img.range?.ext;
      if (!tl) continue;
      const c = Math.floor(tl.nativeCol ?? tl.col ?? 0), r = Math.floor(tl.nativeRow ?? tl.row ?? 0);
      const dx = Math.round((tl.nativeColOff ?? 0) / EMU_PER_PX), dy = Math.round((tl.nativeRowOff ?? 0) / EMU_PER_PX);
      let w = 200, h = 150;
      if (ext?.width) { w = Math.round(ext.width); h = Math.round(ext.height); }
      else if (br) {
        const p1 = toPx(c, tl.nativeColOff ?? 0, r, tl.nativeRowOff ?? 0);
        const p2 = toPx(Math.floor(br.nativeCol ?? br.col ?? c + 3), br.nativeColOff ?? 0, Math.floor(br.nativeRow ?? br.row ?? r + 7), br.nativeRowOff ?? 0);
        w = Math.max(10, Math.round(p2.x - p1.x)); h = Math.max(10, Math.round(p2.y - p1.y));
      }
      images.push({ id: uid('img'), src, r, c, dx, dy, w, h });
    }
    if (images.length) sheet.images = images;

    const charts = await readCharts(zip, paths[si] ?? '', toPx).catch(() => []);
    if (charts.length) sheet.charts = charts;

    sheets.push(sheet);
  }
  if (!sheets.length) sheets.push({ name: 'Лист1', data: [[{ v: '' }]] });
  return { sheets, font };
}

// ── Запись ──────────────────────────────────────────────────────────────────

export interface WriteHelpers {
  /** Посчитанное значение формулы — кладётся в файл кэшем результата. */
  formulaResult(sheetIdx: number, r: number, c: number): string;
  /** Значения диапазона для кэша диаграммы. */
  rangeValues(ref: string, sheetIdx: number): string[];
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function dataUrlToBytes(src: string): { bytes: Uint8Array; ext: string } | null {
  const m = src.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);
  if (!m) return null;
  let ext = m[1].toLowerCase();
  if (ext === 'jpg') ext = 'jpeg';
  if (!['png', 'jpeg', 'gif'].includes(ext)) return null;
  const bin = atob(m[2].replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ext };
}

/** Последняя строка/колонка, где есть хоть что-то (значение, стиль, объединение). */
function usedExtent(sh: SheetData): { rows: number; cols: number } {
  let rows = 0, cols = 0;
  sh.data.forEach((row, r) => row.forEach((c, ci) => {
    if (c && (c.v || c.s || c.nf || c.img || c.note || c.link)) { if (r + 1 > rows) rows = r + 1; if (ci + 1 > cols) cols = ci + 1; }
  }));
  for (const m of sh.merges ?? []) { rows = Math.max(rows, m.r2 + 1); cols = Math.max(cols, m.c2 + 1); }
  return { rows, cols };
}

/** Собрать .xlsx из модели книги. */
export async function writeXlsx(ec: ExcelContent, help: WriteHelpers): Promise<Blob> {
  const bytes = await writeXlsxBytes(ec, help);
  return new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** То же, но байтами — удобно для проверки в тестах и для отправки на сервер. */
export async function writeXlsxBytes(ec: ExcelContent, help: WriteHelpers): Promise<Uint8Array> {
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import('exceljs'), import('jszip')]);
  const wb = new (ExcelJS as any).Workbook();
  wb.creator = 'SimaDesk';
  wb.calcProperties = { fullCalcOnLoad: true };
  const defFont = ec.font ?? { name: 'Calibri', size: 11 };

  ec.sheets.forEach((sh, si) => {
    const ws = wb.addWorksheet(sh.name.slice(0, 31) || `Лист${si + 1}`, {
      state: sh.hidden ? 'hidden' : 'visible',
      properties: {
        ...(sh.tabColor ? { tabColor: { argb: 'FF' + sh.tabColor.replace('#', '').toUpperCase() } } : {}),
        ...(sh.defRowH ? { defaultRowHeight: +(sh.defRowH / XL_PX_PER_PT).toFixed(2) } : {}),
        ...(sh.defColW ? { defaultColWidth: colPxToChars(sh.defColW) } : {}),
      },
      views: [{
        ...(sh.freeze && (sh.freeze.rows || sh.freeze.cols)
          ? { state: 'frozen', xSplit: sh.freeze.cols, ySplit: sh.freeze.rows, topLeftCell: `${colLetter(sh.freeze.cols)}${sh.freeze.rows + 1}` }
          : { state: 'normal' }),
        showGridLines: sh.showGrid !== false,
        ...(sh.zoom ? { zoomScale: sh.zoom } : {}),
      }],
    });

    const { rows, cols } = usedExtent(sh);
    (sh.colWidths ?? []).forEach((w, c) => { if (w) ws.getColumn(c + 1).width = colPxToChars(w); });
    for (const c of sh.hiddenCols ?? []) ws.getColumn(c + 1).hidden = true;
    (sh.rowHeights ?? []).forEach((h, r) => { if (h) ws.getRow(r + 1).height = +(h / XL_PX_PER_PT).toFixed(2); });
    for (const r of sh.hiddenRows ?? []) ws.getRow(r + 1).hidden = true;

    const inCellImages: Array<{ r: number; c: number; src: string; w?: number; h?: number }> = [];
    for (let r = 0; r < rows; r++) {
      const row = sh.data[r] ?? [];
      for (let c = 0; c < cols; c++) {
        const cell = row[c];
        if (!cell || !(cell.v || cell.s || cell.nf || cell.note || cell.link || cell.img)) continue;
        const xc = ws.getCell(r + 1, c + 1);
        const v = cell.v ?? '';
        if (v.startsWith('=')) {
          const res = help.formulaResult(si, r, c);
          const n = Number(res);
          const result = res === '' ? undefined
            : res.startsWith('#') ? { error: res }
            : !isNaN(n) && isFinite(n) && res.trim() !== '' ? n
            : res === 'ИСТИНА' ? true : res === 'ЛОЖЬ' ? false : res;
          xc.value = { formula: toExcelFormula(v), ...(result !== undefined ? { result } : {}) };
        } else if (cell.t === 'n' && v !== '' && isFinite(Number(v))) {
          xc.value = Number(v);
        } else if (cell.t === 'b') {
          xc.value = /^(1|true|истина)$/i.test(v);
        } else if (v) {
          if (cell.rt?.length && cell.rt.map(x => x.text).join('') === v) {
            xc.value = { richText: cell.rt.map(run => ({ text: run.text, ...(run.s ? { font: xToExcel(cssToX(run.s), defFont).font } : {}) })) };
          } else if (/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/.test(v)) {
            xc.value = { error: v };
          } else {
            xc.value = v;
          }
          if (cell.link) xc.value = { text: v, hyperlink: cell.link };
        }
        xc.style = xToExcel(cssToX(cell.s), defFont);
        if (cell.nf) xc.numFmt = cell.nf;
        if (cell.note) xc.note = cell.note;
        if (cell.img && isSafeImageSrc(cell.img)) inCellImages.push({ r, c, src: cell.img, w: cell.imgW, h: cell.imgH });
      }
    }

    for (const m of sh.merges ?? []) {
      if (m.r1 === m.r2 && m.c1 === m.c2) continue;
      try { ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1); } catch { /* пересечение — пропускаем */ }
    }
    if (sh.autoFilter) ws.autoFilter = sh.autoFilter;

    const xl = (sh.xl ?? {}) as any;
    if (Array.isArray(xl.cf)) for (const cf of xl.cf) { try { ws.addConditionalFormatting(cf); } catch { /* ignore */ } }
    if (xl.dv && typeof xl.dv === 'object') {
      for (const [addr, rule] of Object.entries(xl.dv)) { try { ws.dataValidations.add(addr, rule); } catch { /* ignore */ } }
    }
    if (xl.pageSetup) { try { Object.assign(ws.pageSetup, xl.pageSetup); } catch { /* ignore */ } }
    if (xl.headerFooter) { try { Object.assign(ws.headerFooter, xl.headerFooter); } catch { /* ignore */ } }

    // Картинки: плавающие и «в ячейке» (вторые становятся плавающими в её углу)
    const addPic = (src: string, c: number, r: number, dx: number, dy: number, w: number, h: number) => {
      const bin = dataUrlToBytes(src);
      if (!bin) return;
      const id = wb.addImage({ buffer: bin.bytes, extension: bin.ext });
      const colW = (sh.colWidths?.[c] ?? sh.defColW ?? 64) || 64;
      const rowH = (sh.rowHeights?.[r] ?? sh.defRowH ?? 20) || 20;
      ws.addImage(id, { tl: { col: c + Math.min(0.99, dx / colW), row: r + Math.min(0.99, dy / rowH) }, ext: { width: w, height: h }, editAs: 'oneCell' });
    };
    for (const im of sh.images ?? []) addPic(im.src, im.c, im.r, im.dx ?? 0, im.dy ?? 0, im.w, im.h);
    for (const im of inCellImages) addPic(im.src, im.c, im.r, 2, 2, im.w ?? 120, im.h ?? 90);
  });

  const buf: ArrayBuffer = await wb.xlsx.writeBuffer();
  const zip = await (JSZip as any).loadAsync(buf);

  // Шрифт книги: ExcelJS всегда пишет Calibri 11 первым шрифтом — подменяем
  if (defFont.name !== 'Calibri' || defFont.size !== 11) {
    const st: string | undefined = await zip.file('xl/styles.xml')?.async('string');
    if (st) {
      zip.file('xl/styles.xml', st.replace(/(<fonts[^>]*>\s*<font>)([\s\S]*?)(<\/font>)/, (_m, a, body, z) =>
        a + body.replace(/<sz val="[^"]*"\/>/, `<sz val="${defFont.size}"/>`).replace(/<name val="[^"]*"\/>/, `<name val="${xmlEsc(defFont.name)}"/>`) + z));
    }
  }

  if (ec.sheets.some(s => s.charts?.length)) await writeCharts(zip, ec, help);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// ── Диаграммы в файл ────────────────────────────────────────────────────────

const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E', '636363', '997300'];

/** Ссылка ряда в абсолютном виде с именем листа: Лист1!$B$2:$B$9. */
export function absRef(ref: string, defSheet: string): string {
  let sheet = defSheet, addr = ref.trim();
  const m = addr.match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
  if (m) { sheet = (m[1] ?? m[2]).replace(/''/g, "'"); addr = m[3]; }
  const rg = parseRangeRef(addr.replace(/\$/g, ''));
  if (!rg) return ref;
  const a = `$${colLetter(rg.c1)}$${rg.r1 + 1}`, b = `$${colLetter(rg.c2)}$${rg.r2 + 1}`;
  const q = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return `${q}!${a}${a === b ? '' : ':' + b}`;
}

function chartXml(ch: ChartSpec, sheetName: string, sheetIdx: number, help: WriteHelpers): string {
  const isPie = ch.kind === 'pie' || ch.kind === 'doughnut';
  const isScatter = ch.kind === 'scatter';
  const strCache = (vals: string[]) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const numCache = (vals: string[]) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => {
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) && String(v).trim() !== '' ? `<c:pt idx="${i}"><c:v>${n}</c:v></c:pt>` : '';
  }).join('')}</c:numCache>`;

  const ser = ch.series.map((s, i) => {
    const color = (s.color ?? '#' + PALETTE[i % PALETTE.length]).replace('#', '').toUpperCase();
    const tx = s.nameRef
      ? `<c:tx><c:strRef><c:f>${xmlEsc(absRef(s.nameRef, sheetName))}</c:f>${strCache(help.rangeValues(s.nameRef, sheetIdx).slice(0, 1))}</c:strRef></c:tx>`
      : s.name ? `<c:tx><c:v>${xmlEsc(s.name)}</c:v></c:tx>` : '';
    const spPr = isPie ? '' : ch.kind === 'line' || isScatter
      ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
      : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
    const catVals = s.catRef ? help.rangeValues(s.catRef, sheetIdx) : [];
    const valVals = help.rangeValues(s.valRef, sheetIdx);
    const catNumeric = catVals.length > 0 && catVals.every(v => v.trim() !== '' && isFinite(Number(v.replace(',', '.'))));
    const cat = s.catRef
      ? (isScatter
          ? `<c:xVal><c:numRef><c:f>${xmlEsc(absRef(s.catRef, sheetName))}</c:f>${numCache(catVals)}</c:numRef></c:xVal>`
          : catNumeric
            ? `<c:cat><c:numRef><c:f>${xmlEsc(absRef(s.catRef, sheetName))}</c:f>${numCache(catVals)}</c:numRef></c:cat>`
            : `<c:cat><c:strRef><c:f>${xmlEsc(absRef(s.catRef, sheetName))}</c:f>${strCache(catVals)}</c:strRef></c:cat>`)
      : '';
    const valTag = isScatter ? 'yVal' : 'val';
    const val = `<c:${valTag}><c:numRef><c:f>${xmlEsc(absRef(s.valRef, sheetName))}</c:f>${numCache(valVals)}</c:numRef></c:${valTag}>`;
    const marker = ch.kind === 'line' ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : isScatter ? '<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>' : '';
    const invert = ch.kind === 'col' || ch.kind === 'bar' ? '<c:invertIfNegative val="0"/>' : '';
    const smooth = ch.kind === 'line' || isScatter ? '<c:smooth val="0"/>' : '';
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${spPr}${invert}${marker}${cat}${val}${smooth}</c:ser>`;
  }).join('');

  const grouping = ch.stacked ? 'stacked' : (ch.kind === 'line' ? 'standard' : 'clustered');
  const axIds = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  let plot: string;
  switch (ch.kind) {
    case 'col': case 'bar':
      plot = `<c:barChart><c:barDir val="${ch.kind}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="150"/>${ch.stacked ? '<c:overlap val="100"/>' : ''}${axIds}</c:barChart>`;
      break;
    case 'line':
      plot = `<c:lineChart><c:grouping val="${ch.stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${axIds}</c:lineChart>`;
      break;
    case 'area':
      plot = `<c:areaChart><c:grouping val="${ch.stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>${ser}${axIds}</c:areaChart>`;
      break;
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
      break;
    default:
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}${axIds}</c:scatterChart>`;
  }
  const catAxPos = ch.kind === 'bar' ? 'l' : 'b';
  const valAxPos = ch.kind === 'bar' ? 'b' : 'l';
  const axes = isPie ? '' : isScatter
    ? `<c:valAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
      + `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
    : `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catAxPos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valAxPos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;

  const title = ch.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0"/></a:pPr><a:r><a:rPr lang="ru-RU" sz="1400" b="0"/><a:t>${xmlEsc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = ch.legend === false ? '' : `<c:legend><c:legendPos val="${isPie ? 'r' : 'b'}"/><c:overlay val="0"/></c:legend>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}

/** Точка листа в пикселях → ячейка + смещение (для якоря «to»). */
function pxToAnchor(sh: SheetData, x: number, y: number): { col: number; colOff: number; row: number; rowOff: number } {
  const colPx = (c: number) => sh.colWidths?.[c] ?? sh.defColW ?? 64;
  const rowPx = (r: number) => sh.rowHeights?.[r] ?? sh.defRowH ?? 20;
  let col = 0, acc = 0;
  while (acc + colPx(col) <= x && col < 16383) { acc += colPx(col); col++; }
  const colOff = Math.round((x - acc) * EMU_PER_PX);
  let row = 0; acc = 0;
  while (acc + rowPx(row) <= y && row < 1048575) { acc += rowPx(row); row++; }
  const rowOff = Math.round((y - acc) * EMU_PER_PX);
  return { col, colOff, row, rowOff };
}

async function writeCharts(zip: any, ec: ExcelContent, help: WriteHelpers): Promise<void> {
  const paths = await sheetPaths(zip);
  let ctypes: string = await zip.file('[Content_Types].xml').async('string');
  const existingCharts = Object.keys(zip.files).filter((f: string) => /^xl\/charts\/chart\d+\.xml$/.test(f)).length;
  let chartN = existingCharts;
  let drawingN = Object.keys(zip.files).filter((f: string) => /^xl\/drawings\/drawing\d+\.xml$/.test(f)).length;

  for (let si = 0; si < ec.sheets.length; si++) {
    const sh = ec.sheets[si];
    if (!sh.charts?.length) continue;
    const sheetFile = paths[si];
    if (!sheetFile) continue;
    const sheetRelsFile = relsPath(sheetFile);
    let sheetRelsXml: string = await zip.file(sheetRelsFile)?.async('string')
      ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const sheetRels = parseRels(sheetRelsXml);
    const drawRel = sheetRels.find(r => /\/drawing$/.test(r.type));

    let drawingFile: string;
    let drawingXml: string;
    if (drawRel) {
      drawingFile = resolveTarget(sheetFile, drawRel.target);
      drawingXml = await zip.file(drawingFile).async('string');
    } else {
      drawingN++;
      drawingFile = `xl/drawings/drawing${drawingN}.xml`;
      drawingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>';
      const rid = `rId${sheetRels.length + 100}`;
      sheetRelsXml = sheetRelsXml.replace('</Relationships>',
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingN}.xml"/></Relationships>`);
      zip.file(sheetRelsFile, sheetRelsXml);
      let sheetXml: string = await zip.file(sheetFile).async('string');
      const tag = `<drawing r:id="${rid}"/>`;
      const before = sheetXml.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
      sheetXml = before >= 0 ? sheetXml.slice(0, before) + tag + sheetXml.slice(before) : sheetXml.replace('</worksheet>', tag + '</worksheet>');
      if (!/xmlns:r=/.test(sheetXml.slice(0, 600)))
        sheetXml = sheetXml.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      zip.file(sheetFile, sheetXml);
      ctypes = ctypes.replace('</Types>', `<Override PartName="/${drawingFile}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    }

    const drawingRelsFile = relsPath(drawingFile);
    let drawingRelsXml: string = await zip.file(drawingRelsFile)?.async('string')
      ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    let relSeq = parseRels(drawingRelsXml).length + 50;
    let shapeId = 1000 + si * 100;
    let anchors = '';

    for (const ch of sh.charts) {
      chartN++;
      const chartFile = `xl/charts/chart${chartN}.xml`;
      zip.file(chartFile, chartXml(ch, sh.name, si, help));
      ctypes = ctypes.replace('</Types>', `<Override PartName="/${chartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      const rid = `rId${++relSeq}`;
      drawingRelsXml = drawingRelsXml.replace('</Relationships>',
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartN}.xml"/></Relationships>`);

      const colPx = (c: number) => sh.colWidths?.[c] ?? sh.defColW ?? 64;
      const rowPx = (r: number) => sh.rowHeights?.[r] ?? sh.defRowH ?? 20;
      let x0 = ch.dx ?? 0, y0 = ch.dy ?? 0;
      for (let i = 0; i < ch.c; i++) x0 += colPx(i);
      for (let i = 0; i < ch.r; i++) y0 += rowPx(i);
      const to = pxToAnchor(sh, x0 + ch.w, y0 + ch.h);
      shapeId++;
      anchors += `<xdr:twoCellAnchor editAs="oneCell">`
        + `<xdr:from><xdr:col>${ch.c}</xdr:col><xdr:colOff>${Math.round((ch.dx ?? 0) * EMU_PER_PX)}</xdr:colOff><xdr:row>${ch.r}</xdr:row><xdr:rowOff>${Math.round((ch.dy ?? 0) * EMU_PER_PX)}</xdr:rowOff></xdr:from>`
        + `<xdr:to><xdr:col>${to.col}</xdr:col><xdr:colOff>${to.colOff}</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>${to.rowOff}</xdr:rowOff></xdr:to>`
        + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="Диаграмма ${shapeId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
        + `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
        + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic>`
        + `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
    }
    drawingXml = drawingXml.replace('</xdr:wsDr>', anchors + '</xdr:wsDr>');
    zip.file(drawingFile, drawingXml);
    zip.file(drawingRelsFile, drawingRelsXml);
  }
  zip.file('[Content_Types].xml', ctypes);
}

/** Диапазон модели в виде «A1:F20» по фактическому заполнению листа. */
export function usedRangeRef(sh: SheetData): string {
  const { rows, cols } = usedExtent(sh);
  return rangeToRef({ r1: 0, c1: 0, r2: Math.max(0, rows - 1), c2: Math.max(0, cols - 1) });
}
