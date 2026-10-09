/**
 * Оформление ячейки: одна каноническая CSS-строка ↔ структурный стиль Excel.
 *
 * Почему это отдельный модуль. Раньше импорт переводил стиль Excel в CSS
 * одним способом, экспорт разбирал CSS обратно другим, а кнопки панели
 * писали третье (`background:`, `13px`, `border:1px solid #333`). Половина
 * свойств терялась по дороге: белый текст, чёрная заливка, пунктирные рамки,
 * перенос, отступ, вертикальное выравнивание. Файл после экспорта выглядел
 * иначе, чем до импорта.
 *
 * Теперь всё оформление проходит через XStyle — зеркало модели стилей Excel.
 * В хранилище лежит CSS (так он сразу годится для показа и совместим со
 * старыми документами), но пишется и читается только здесь, а то, чего нет
 * в обычном CSS (двойное подчёркивание бухгалтерского вида, тип рамки
 * «штрих-пунктир», поворот текста), едет в собственных свойствах `--xl-*`.
 */

export type BorderStyle =
  | 'thin' | 'medium' | 'thick' | 'double' | 'hair' | 'dotted' | 'dashed'
  | 'mediumDashed' | 'dashDot' | 'mediumDashDot' | 'dashDotDot' | 'mediumDashDotDot' | 'slantDashDot';

export interface XBorder { style: BorderStyle; color?: string }

export interface XStyle {
  font?: {
    name?: string;
    size?: number;               // пункты
    bold?: boolean;
    italic?: boolean;
    underline?: 'single' | 'double' | 'singleAccounting' | 'doubleAccounting';
    strike?: boolean;
    color?: string;              // #rrggbb
    vertAlign?: 'superscript' | 'subscript';
  };
  /** Сплошная заливка, #rrggbb. */
  fill?: string;
  /** Узорная заливка (не сплошная) — сохраняется ради точного возврата в файл. */
  pattern?: { type: string; fg?: string; bg?: string };
  border?: { left?: XBorder; right?: XBorder; top?: XBorder; bottom?: XBorder };
  align?: {
    h?: 'left' | 'center' | 'right' | 'justify' | 'fill' | 'centerContinuous' | 'distributed' | 'general';
    v?: 'top' | 'middle' | 'bottom' | 'justify' | 'distributed';
    wrap?: boolean;
    indent?: number;
    rotate?: number;
    shrink?: boolean;
  };
}

const SIDES = ['left', 'right', 'top', 'bottom'] as const;
type Side = typeof SIDES[number];
const SIDE_TAG: Record<Side, string> = { left: 'bl', right: 'br', top: 'bt', bottom: 'bb' };

// ── Цвета ──────────────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', silver: 'c0c0c0', navy: '000080',
  maroon: '800000', olive: '808000', teal: '008080', lime: '00ff00', aqua: '00ffff', fuchsia: 'ff00ff',
};

/** Любая запись цвета CSS → «#rrggbb» или null (прозрачный/неизвестный). */
export function normColor(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'none' || s === 'currentcolor') return null;
  let m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return '#' + m[1];
  m = s.match(/^#([0-9a-f]{8})$/);              // #rrggbbaa
  if (m) return '#' + m[1].slice(0, 6);
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return '#' + m[1].split('').map(ch => ch + ch).join('');
  m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    if (m[4] !== undefined) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a < 0.1) return null;
    }
    return '#' + [m[1], m[2], m[3]].map(n => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
  }
  return NAMED[s] ? '#' + NAMED[s] : null;
}

// ── Разбор CSS ─────────────────────────────────────────────────────────────

/** «a:b;c:d» → {a:'b', c:'d'} (ключи в нижнем регистре, порядок сохраняется). */
export function cssProps(css: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!css) return out;
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    let k = part.slice(0, i).trim().toLowerCase();
    let v = part.slice(i + 1).trim();
    // background — сокращённая запись заливки: пусть перекрывает предыдущую
    if (k === 'background') { k = 'background-color'; v = v.split(/\s+/)[0]; }
    if (k) out[k] = v;
  }
  return out;
}

function parseSize(v: string): number | undefined {
  const n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return undefined;
  if (/pt\s*$/i.test(v)) return n;
  if (/px\s*$/i.test(v)) {
    // Старые документы хранили px = round(pt × 1.333): ищем целый кегль,
    // который давал именно этот px (15px → 11pt, а не 11,5)
    const base = Math.round(n * 0.75);
    for (const pt of [base, base - 1, base + 1]) if (pt > 0 && Math.round(pt * 1.333) === Math.round(n)) return pt;
    return Math.round(n * 0.75 * 2) / 2;
  }
  if (/em\s*$/i.test(v)) return Math.round(n * 11 * 2) / 2;
  return n;
}

/** CSS-ширина/стиль рамки → тип рамки Excel. */
function borderFromCss(v: string, tag?: string): XBorder | undefined {
  const s = v.trim().toLowerCase();
  if (!s || s === 'none' || s === '0' || /^0(px)?\s/.test(s) || /\bnone\b/.test(s) || /\bhidden\b/.test(s)) return undefined;
  const w = parseFloat(s) || (/\bthick\b/.test(s) ? 3 : /\bmedium\b/.test(s) ? 2 : 1);
  const kind = /\bdouble\b/.test(s) ? 'double' : /\bdotted\b/.test(s) ? 'dotted' : /\bdashed\b/.test(s) ? 'dashed' : 'solid';
  const colorTok = s.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b(?=\s*$)/);
  const color = normColor(colorTok?.[0] ?? '') ?? '#000000';
  let style: BorderStyle;
  if (kind === 'double') style = 'double';
  else if (kind === 'dotted') style = 'dotted';
  else if (kind === 'dashed') style = w >= 2 ? 'mediumDashed' : 'dashed';
  else style = w >= 2.5 ? 'thick' : w >= 1.5 ? 'medium' : 'thin';
  if (tag && /^(thin|medium|thick|double|hair|dotted|dashed|mediumDashed|dashDot|mediumDashDot|dashDotDot|mediumDashDotDot|slantDashDot)$/.test(tag))
    style = tag as BorderStyle;
  return { style, color };
}

/** Тип рамки Excel → CSS (ширина, вид) и признак, нужен ли уточняющий тег. */
function borderToCss(b: XBorder): { css: string; tag?: string } {
  const color = b.color ?? '#000000';
  switch (b.style) {
    case 'thin':   return { css: `1px solid ${color}` };
    case 'medium': return { css: `2px solid ${color}` };
    case 'thick':  return { css: `3px solid ${color}` };
    case 'double': return { css: `3px double ${color}` };
    case 'dotted': return { css: `1px dotted ${color}` };
    case 'dashed': return { css: `1px dashed ${color}` };
    case 'mediumDashed': return { css: `2px dashed ${color}` };
    case 'hair':   return { css: `1px dotted ${color}`, tag: 'hair' };
    case 'dashDot': case 'dashDotDot': case 'slantDashDot':
      return { css: `1px dashed ${color}`, tag: b.style };
    case 'mediumDashDot': case 'mediumDashDotDot':
      return { css: `2px dashed ${color}`, tag: b.style };
    default: return { css: `1px solid ${color}` };
  }
}

/** Каноническая или старая CSS-строка ячейки → XStyle. */
export function cssToX(css: string | undefined): XStyle {
  const p = cssProps(css);
  const x: XStyle = {};
  const font: NonNullable<XStyle['font']> = {};
  const align: NonNullable<XStyle['align']> = {};

  const ff = p['font-family'];
  if (ff) { const n = ff.split(',')[0].trim().replace(/^['"]|['"]$/g, ''); if (n) font.name = n; }
  if (p['font-size']) { const sz = parseSize(p['font-size']); if (sz) font.size = sz; }
  const fw = p['font-weight'];
  if (fw && (fw === 'bold' || fw === 'bolder' || parseInt(fw) >= 600)) font.bold = true;
  if (p['font-style'] === 'italic' || p['font-style'] === 'oblique') font.italic = true;
  const td = (p['text-decoration'] ?? '') + ' ' + (p['text-decoration-line'] ?? '');
  if (/underline/.test(td)) {
    font.underline = /double/.test(td) || p['text-decoration-style'] === 'double' ? 'double' : 'single';
    const u = p['--xl-u'];
    if (u === 'singleAccounting' || u === 'doubleAccounting') font.underline = u;
  }
  if (/line-through/.test(td)) font.strike = true;
  const col = normColor(p['color']);
  if (col) font.color = col;
  const va = p['--xl-va'];
  if (va === 'superscript' || va === 'subscript') font.vertAlign = va;
  if (Object.keys(font).length) x.font = font;

  const bg = normColor(p['background-color'] ?? (p['background'] ? p['background'].split(/\s+/)[0] : undefined));
  if (bg) x.fill = bg;
  if (p['--xl-pat']) {
    x.pattern = { type: p['--xl-pat'] };
    const pf = normColor(p['--xl-pat-fg']); if (pf) x.pattern.fg = pf;
    const pb = normColor(p['--xl-pat-bg']); if (pb) x.pattern.bg = pb;
  }

  const border: NonNullable<XStyle['border']> = {};
  if (p['border']) { const b = borderFromCss(p['border']); if (b) for (const s of SIDES) border[s] = { ...b }; }
  for (const s of SIDES) {
    const v = p[`border-${s}`];
    if (v === undefined) continue;
    const b = borderFromCss(v, p[`--xl-${SIDE_TAG[s]}`]);
    if (b) border[s] = b; else delete border[s];
  }
  if (Object.keys(border).length) x.border = border;

  const ta = p['text-align'];
  if (ta === 'left' || ta === 'center' || ta === 'right' || ta === 'justify') align.h = ta;
  if (ta === 'start') align.h = 'left';
  if (ta === 'end') align.h = 'right';
  const xh = p['--xl-h'];
  if (xh === 'fill' || xh === 'centerContinuous' || xh === 'distributed' || xh === 'general') align.h = xh;
  const vv = p['vertical-align'];
  if (vv === 'top' || vv === 'bottom') align.v = vv;
  if (vv === 'middle' || vv === 'center') align.v = 'middle';
  const xv = p['--xl-v'];
  if (xv === 'justify' || xv === 'distributed') align.v = xv;
  const ws = p['white-space'];
  if (ws === 'pre-wrap' || ws === 'normal' || ws === 'pre-line' || ws === 'break-spaces') align.wrap = true;
  const ind = parseInt(p['--xl-indent'] ?? '');
  if (ind > 0) align.indent = ind;
  const rot = parseInt(p['--xl-rot'] ?? '');
  if (!isNaN(rot) && rot !== 0) align.rotate = rot;
  if (p['--xl-shrink'] === '1') align.shrink = true;
  if (Object.keys(align).length) x.align = align;

  return x;
}

/** XStyle → каноническая CSS-строка для хранения. Пустой стиль → ''. */
export function xToCss(x: XStyle): string {
  const out: string[] = [];
  const f = x.font;
  if (f) {
    if (f.name) out.push(`font-family:"${f.name.replace(/"/g, '')}"`);
    if (f.size) out.push(`font-size:${f.size}pt`);
    if (f.bold) out.push('font-weight:bold');
    if (f.italic) out.push('font-style:italic');
    const deco = [f.underline ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) out.push(`text-decoration:${deco}`);
    if (f.underline === 'double' || f.underline === 'doubleAccounting') out.push('text-decoration-style:double');
    if (f.underline === 'singleAccounting' || f.underline === 'doubleAccounting') out.push(`--xl-u:${f.underline}`);
    if (f.color) out.push(`color:${f.color}`);
    if (f.vertAlign) out.push(`--xl-va:${f.vertAlign}`);
  }
  if (x.fill) out.push(`background-color:${x.fill}`);
  if (x.pattern) {
    out.push(`--xl-pat:${x.pattern.type}`);
    if (x.pattern.fg) out.push(`--xl-pat-fg:${x.pattern.fg}`);
    if (x.pattern.bg) out.push(`--xl-pat-bg:${x.pattern.bg}`);
  }
  if (x.border) {
    for (const s of SIDES) {
      const b = x.border[s];
      if (!b) continue;
      const { css, tag } = borderToCss(b);
      out.push(`border-${s}:${css}`);
      if (tag) out.push(`--xl-${SIDE_TAG[s]}:${tag}`);
    }
  }
  const a = x.align;
  if (a) {
    if (a.h === 'left' || a.h === 'center' || a.h === 'right' || a.h === 'justify') out.push(`text-align:${a.h}`);
    else if (a.h === 'centerContinuous') out.push('text-align:center', '--xl-h:centerContinuous');
    else if (a.h === 'distributed') out.push('text-align:justify', '--xl-h:distributed');
    else if (a.h === 'fill') out.push('text-align:left', '--xl-h:fill');
    if (a.v === 'top' || a.v === 'bottom') out.push(`vertical-align:${a.v}`);
    else if (a.v === 'middle') out.push('vertical-align:middle');
    else if (a.v === 'justify' || a.v === 'distributed') out.push('vertical-align:top', `--xl-v:${a.v}`);
    if (a.wrap) out.push('white-space:pre-wrap');
    if (a.indent) out.push(`--xl-indent:${a.indent}`);
    if (a.rotate) out.push(`--xl-rot:${a.rotate}`);
    if (a.shrink) out.push('--xl-shrink:1');
  }
  return out.join(';');
}

/** Привести любую (в т.ч. старую) CSS-строку ячейки к канонической. */
export function normalizeCss(css: string | undefined): string {
  if (!css) return '';
  return xToCss(cssToX(css));
}

/** Изменить стиль ячейки через структурную модель и вернуть новую CSS-строку. */
export function editCss(css: string | undefined, mutate: (x: XStyle) => void): string | undefined {
  const x = cssToX(css);
  mutate(x);
  if (x.font && !Object.values(x.font).some(v => v !== undefined && v !== false)) delete x.font;
  if (x.align && !Object.values(x.align).some(v => v !== undefined && v !== false && v !== 0)) delete x.align;
  if (x.border && !Object.values(x.border).some(Boolean)) delete x.border;
  const out = xToCss(x);
  return out || undefined;
}

// ── Отображение ────────────────────────────────────────────────────────────

const renderCache = new Map<string, string>();

/**
 * CSS для показа ячейки. Отличается от хранимого тем, что `--xl-*` здесь
 * превращаются в видимые свойства: отступ — в padding, вертикальный текст —
 * в writing-mode, узорная заливка — в близкий сплошной цвет.
 */
export function renderCss(css: string | undefined): string {
  if (!css) return '';
  const hit = renderCache.get(css);
  if (hit !== undefined) return hit;
  const x = cssToX(css);
  const out: string[] = [];
  const f = x.font;
  if (f) {
    if (f.name) out.push(`font-family:"${f.name}",Calibri,Arial,sans-serif`);
    if (f.size) out.push(`font-size:${f.size}pt`);
    if (f.bold) out.push('font-weight:700');
    if (f.italic) out.push('font-style:italic');
    const deco = [f.underline ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) out.push(`text-decoration:${deco}`);
    if (f.underline === 'double' || f.underline === 'doubleAccounting') out.push('text-decoration-style:double');
    if (f.color) out.push(`color:${f.color}`);
  }
  const bg = x.fill ?? x.pattern?.fg ?? x.pattern?.bg;
  if (bg) out.push(`background-color:${bg}`);
  if (x.border) for (const s of SIDES) {
    const b = x.border[s];
    if (b) out.push(`border-${s}:${borderToCss(b).css}`);
  }
  const a = x.align;
  if (a) {
    if (a.h === 'left' || a.h === 'fill') out.push('text-align:left');
    else if (a.h === 'center' || a.h === 'centerContinuous') out.push('text-align:center');
    else if (a.h === 'right') out.push('text-align:right');
    else if (a.h === 'justify' || a.h === 'distributed') out.push('text-align:justify');
    if (a.v === 'top' || a.v === 'justify' || a.v === 'distributed') out.push('vertical-align:top');
    else if (a.v === 'middle') out.push('vertical-align:middle');
    else if (a.v === 'bottom') out.push('vertical-align:bottom');
    if (a.wrap) out.push('white-space:pre-wrap', 'word-break:break-word');
    if (a.indent) {
      const pad = 3 + a.indent * 9;
      out.push(a.h === 'right' ? `padding-right:${pad}px` : `padding-left:${pad}px`);
    }
    if (a.rotate === 255) out.push('writing-mode:vertical-rl', 'text-orientation:upright');
  }
  const res = out.join(';');
  if (renderCache.size > 5000) renderCache.clear();
  renderCache.set(css, res);
  return res;
}

/** Явно ли задано горизонтальное выравнивание (иначе числа прижимаются вправо). */
export function hasHAlign(css: string | undefined): boolean {
  const h = cssToX(css).align?.h;
  return !!h && h !== 'general';
}

// ── ExcelJS ↔ XStyle ───────────────────────────────────────────────────────

/** Как разрешать цвета ExcelJS ({argb} / {theme,tint} / {indexed}). */
export type ColorResolver = (c: any) => string | null;

/** Стиль ячейки ExcelJS → XStyle. defFont — шрифт книги: совпадающее не храним. */
export function excelToX(st: any, resolve: ColorResolver, defFont?: { name: string; size: number }): XStyle {
  const x: XStyle = {};
  if (!st) return x;
  const f = st.font;
  if (f) {
    const font: NonNullable<XStyle['font']> = {};
    if (f.name && f.name !== defFont?.name) font.name = f.name;
    if (f.size && f.size !== defFont?.size) font.size = f.size;
    if (f.bold) font.bold = true;
    if (f.italic) font.italic = true;
    if (f.underline && f.underline !== 'none') {
      font.underline = f.underline === true ? 'single'
        : (['single', 'double', 'singleAccounting', 'doubleAccounting'].includes(f.underline) ? f.underline : 'single');
    }
    if (f.strike) font.strike = true;
    const c = f.color ? resolve(f.color) : null;
    if (c) font.color = c;
    if (f.vertAlign === 'superscript' || f.vertAlign === 'subscript') font.vertAlign = f.vertAlign;
    if (Object.keys(font).length) x.font = font;
  }
  const fl = st.fill;
  if (fl) {
    if (fl.type === 'pattern' && fl.pattern && fl.pattern !== 'none') {
      const fg = fl.fgColor ? resolve(fl.fgColor) : null;
      const bg = fl.bgColor ? resolve(fl.bgColor) : null;
      if (fl.pattern === 'solid') { if (fg) x.fill = fg; }
      else x.pattern = { type: fl.pattern, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}) };
    } else if (fl.type === 'gradient' && Array.isArray(fl.stops) && fl.stops.length) {
      // Градиент не воспроизводим — берём первый цвет, чтобы ячейка не стала белой
      const c = resolve(fl.stops[0].color);
      if (c) x.fill = c;
    }
  }
  const b = st.border;
  if (b) {
    const border: NonNullable<XStyle['border']> = {};
    for (const s of SIDES) {
      const side = b[s];
      if (side?.style) border[s] = { style: side.style, color: (side.color ? resolve(side.color) : null) ?? '#000000' };
    }
    if (Object.keys(border).length) x.border = border;
  }
  const a = st.alignment;
  if (a) {
    const align: NonNullable<XStyle['align']> = {};
    if (a.horizontal && a.horizontal !== 'general') align.h = a.horizontal;
    if (a.vertical) align.v = a.vertical === 'center' || a.vertical === 'middle' ? 'middle' : a.vertical;
    if (a.wrapText) align.wrap = true;
    if (a.indent) align.indent = a.indent;
    if (a.textRotation) align.rotate = a.textRotation === 'vertical' ? 255 : +a.textRotation;
    if (a.shrinkToFit) align.shrink = true;
    // Excel по умолчанию прижимает к низу — это значение не храним
    if (align.v === 'bottom') delete align.v;
    if (Object.keys(align).length) x.align = align;
  }
  return x;
}

const argb = (hex: string) => 'FF' + hex.replace('#', '').toUpperCase();

/** XStyle → стиль ExcelJS. Шрифт книги подставляется туда, где свой не задан. */
export function xToExcel(x: XStyle, defFont: { name: string; size: number }): any {
  const st: any = {};
  const f = x.font ?? {};
  st.font = {
    name: f.name ?? defFont.name,
    size: f.size ?? defFont.size,
    ...(f.bold ? { bold: true } : {}),
    ...(f.italic ? { italic: true } : {}),
    ...(f.underline ? { underline: f.underline } : {}),
    ...(f.strike ? { strike: true } : {}),
    ...(f.color ? { color: { argb: argb(f.color) } } : {}),
    ...(f.vertAlign ? { vertAlign: f.vertAlign } : {}),
  };
  if (x.fill) st.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(x.fill) }, bgColor: { indexed: 64 } };
  else if (x.pattern) {
    st.fill = {
      type: 'pattern', pattern: x.pattern.type,
      ...(x.pattern.fg ? { fgColor: { argb: argb(x.pattern.fg) } } : {}),
      ...(x.pattern.bg ? { bgColor: { argb: argb(x.pattern.bg) } } : {}),
    };
  }
  if (x.border) {
    st.border = {};
    for (const s of SIDES) {
      const b = x.border[s];
      if (b) st.border[s] = { style: b.style, color: { argb: argb(b.color ?? '#000000') } };
    }
  }
  if (x.align) {
    const a = x.align;
    st.alignment = {
      ...(a.h && a.h !== 'general' ? { horizontal: a.h } : {}),
      ...(a.v ? { vertical: a.v === 'middle' ? 'middle' : a.v } : {}),
      ...(a.wrap ? { wrapText: true } : {}),
      ...(a.indent ? { indent: a.indent } : {}),
      ...(a.rotate ? { textRotation: a.rotate === 255 ? 'vertical' : a.rotate } : {}),
      ...(a.shrink ? { shrinkToFit: true } : {}),
    };
  }
  return st;
}
