/**
 * Word (.docx) ↔ HTML редактора.
 *
 * Импорт раньше шёл через mammoth: он намеренно выбрасывает оформление
 * (шрифты, размеры, цвета, выравнивание, интервалы, рамки таблиц) и пустые
 * абзацы — документ открывался «другим», а пустые строки исчезали. Здесь
 * разбираем OOXML сами: стили документа разворачиваются по цепочке
 * docDefaults → стиль абзаца → стиль символа → прямое оформление и кладутся
 * в HTML явными inline-стилями. Экспорт читает те же стили обратно, поэтому
 * «открыл → сохранил» возвращает тот же вид.
 *
 * Экспорт раньше писал страницу Letter (американский формат) вместо A4,
 * терял текст без оформления на верхнем уровне, сливал вложенные списки
 * в один уровень и ломал таблицы с объединёнными ячейками.
 */

import type { WordMeta } from './model';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const EMU_PER_PX = 9525;

/** A4, поля как у русского Word по умолчанию: 2 / 1,5 / 2 / 3 см. */
export const DEFAULT_PAGE = { w: 11906, h: 16838, top: 1134, right: 850, bottom: 1134, left: 1701 };
export const DEFAULT_FONT = { name: 'Calibri', size: 11 };
export const twipToPx = (t: number) => t / 15;          // 1440 twip = 96 px
export const pxToTwip = (p: number) => Math.round(p * 15);

// ═══════════════════════════ Импорт ═══════════════════════════

type Props = Record<string, string>;

interface StyleDef { type: string; basedOn?: string; name: string; pPr?: Element; rPr?: Element; tblPr?: Element; }

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

function kids(el: Element | null | undefined, local: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) if (el.children[i].localName === local) out.push(el.children[i]);
  return out;
}
const kid = (el: Element | null | undefined, local: string) => kids(el, local)[0] ?? null;
function wattr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W_NS, name) ?? el.getAttribute('w:' + name) ?? el.getAttribute(name);
}
function safeHref(href: string | undefined): string | undefined {
  return href && /^(https?:|mailto:|tel:|#)/i.test(href) ? href : undefined;
}
/** Логическое свойство: <w:b/> = да, <w:b w:val="0"/> = нет. */
function onOff(el: Element | null): boolean | undefined {
  if (!el) return undefined;
  const v = wattr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escHtml(s).replace(/"/g, '&quot;');

/** Свойства символа OOXML → CSS. */
function rPrToCss(rPr: Element | null, theme: { minor: string; major: string }, out: Props): void {
  if (!rPr) return;
  const fonts = kid(rPr, 'rFonts');
  if (fonts) {
    const f = wattr(fonts, 'ascii') ?? wattr(fonts, 'hAnsi') ?? wattr(fonts, 'cs');
    const th = wattr(fonts, 'asciiTheme') ?? wattr(fonts, 'hAnsiTheme');
    if (f) out['font-family'] = f;
    else if (th) out['font-family'] = /major/i.test(th) ? theme.major : theme.minor;
  }
  const sz = kid(rPr, 'sz');
  if (sz) { const v = +(wattr(sz, 'val') ?? 0); if (v) out['font-size'] = `${v / 2}pt`; }
  const b = onOff(kid(rPr, 'b')); if (b !== undefined) out['font-weight'] = b ? 'bold' : 'normal';
  const i = onOff(kid(rPr, 'i')); if (i !== undefined) out['font-style'] = i ? 'italic' : 'normal';
  const u = kid(rPr, 'u');
  const deco: string[] = [];
  const prevDeco = out['text-decoration'] ?? '';
  let underline = /underline/.test(prevDeco), strike = /line-through/.test(prevDeco);
  if (u) underline = (wattr(u, 'val') ?? 'single') !== 'none';
  const st = onOff(kid(rPr, 'strike')) ?? onOff(kid(rPr, 'dstrike'));
  if (st !== undefined) strike = st;
  if (underline) deco.push('underline');
  if (strike) deco.push('line-through');
  if (u || st !== undefined) out['text-decoration'] = deco.join(' ') || 'none';
  if (u && wattr(u, 'val') === 'double') out['text-decoration-style'] = 'double';
  const color = kid(rPr, 'color');
  if (color) { const v = wattr(color, 'val'); if (v && v !== 'auto' && /^[0-9a-f]{6}$/i.test(v)) out['color'] = '#' + v.toLowerCase(); }
  const hl = kid(rPr, 'highlight');
  if (hl) { const v = wattr(hl, 'val') ?? ''; if (HIGHLIGHT[v]) out['background-color'] = HIGHLIGHT[v]; }
  const shd = kid(rPr, 'shd');
  if (shd) { const f = wattr(shd, 'fill'); if (f && f !== 'auto' && /^[0-9a-f]{6}$/i.test(f)) out['background-color'] = '#' + f.toLowerCase(); }
  const va = kid(rPr, 'vertAlign');
  if (va) { const v = wattr(va, 'val'); if (v === 'superscript') out['vertical-align'] = 'super'; else if (v === 'subscript') out['vertical-align'] = 'sub'; }
  if (onOff(kid(rPr, 'caps'))) out['text-transform'] = 'uppercase';
  if (onOff(kid(rPr, 'smallCaps'))) out['font-variant'] = 'small-caps';
  const sp = kid(rPr, 'spacing');
  if (sp) { const v = +(wattr(sp, 'val') ?? 0); if (v) out['letter-spacing'] = `${v / 20}pt`; }
}

/** Свойства абзаца OOXML → CSS. */
function pPrToCss(pPr: Element | null, out: Props): void {
  if (!pPr) return;
  const jc = kid(pPr, 'jc');
  if (jc) {
    const v = wattr(jc, 'val');
    out['text-align'] = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' || v === 'distribute' ? 'justify' : 'left';
  }
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = wattr(sp, 'before'), after = wattr(sp, 'after'), line = wattr(sp, 'line'), rule = wattr(sp, 'lineRule');
    if (before !== null && wattr(sp, 'beforeAutospacing') !== '1') out['margin-top'] = `${+before / 20}pt`;
    if (after !== null && wattr(sp, 'afterAutospacing') !== '1') out['margin-bottom'] = `${+after / 20}pt`;
    if (line !== null) {
      if (!rule || rule === 'auto') out['line-height'] = String(Math.round((+line / 240) * 100) / 100);
      else out['line-height'] = `${+line / 20}pt`;
    }
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = wattr(ind, 'left') ?? wattr(ind, 'start');
    const right = wattr(ind, 'right') ?? wattr(ind, 'end');
    const first = wattr(ind, 'firstLine'), hanging = wattr(ind, 'hanging');
    if (left !== null) out['margin-left'] = `${+left / 20}pt`;
    if (right !== null && +right) out['margin-right'] = `${+right / 20}pt`;
    if (first !== null && +first) out['text-indent'] = `${+first / 20}pt`;
    if (hanging !== null && +hanging) out['text-indent'] = `-${+hanging / 20}pt`;
  }
  const shd = kid(pPr, 'shd');
  if (shd) { const f = wattr(shd, 'fill'); if (f && f !== 'auto' && /^[0-9a-f]{6}$/i.test(f)) out['background-color'] = '#' + f.toLowerCase(); }
  const bdr = kid(pPr, 'pBdr');
  if (bdr) for (const side of ['top', 'bottom', 'left', 'right']) {
    const b = kid(bdr, side);
    if (b && wattr(b, 'val') !== 'none' && wattr(b, 'val') !== 'nil') {
      const w = Math.max(1, Math.round((+(wattr(b, 'sz') ?? 4) / 8) * 1.33));
      const c = wattr(b, 'color');
      out[`border-${side}`] = `${w}px ${wattr(b, 'val') === 'double' ? 'double' : 'solid'} ${c && c !== 'auto' ? '#' + c : '#000'}`;
    }
  }
}

function cssText(p: Props): string {
  return Object.entries(p).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}:${v}`).join(';');
}

/** Значения по умолчанию, которые редактор и так показывает, — не засоряют HTML. */
function stripDefaults(p: Props, base: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(p)) if (base[k] !== v) out[k] = v;
  if (out['font-weight'] === 'normal' && !base['font-weight']) delete out['font-weight'];
  if (out['font-style'] === 'normal' && !base['font-style']) delete out['font-style'];
  if (out['text-decoration'] === 'none' && !base['text-decoration']) delete out['text-decoration'];
  return out;
}

export interface DocxReadResult { html: string; meta: WordMeta }

/** Прочитать .docx в HTML редактора. */
export async function readDocx(buf: ArrayBuffer): Promise<DocxReadResult> {
  const { default: JSZip } = await import('jszip');
  const zip = await (JSZip as any).loadAsync(buf);
  const text = async (p: string): Promise<string | null> => (await zip.file(p)?.async('string')) ?? null;
  const parse = (xml: string | null) => xml ? new DOMParser().parseFromString(xml, 'application/xml') : null;

  const docXml = parse(await text('word/document.xml'));
  if (!docXml) throw new Error('В файле нет word/document.xml — это не документ Word');
  const stylesXml = parse(await text('word/styles.xml'));
  const numXml = parse(await text('word/numbering.xml'));
  const relsXml = parse(await text('word/_rels/document.xml.rels'));
  const themeXml = await text('word/theme/theme1.xml');

  const theme = {
    minor: themeXml?.match(/<a:minorFont>\s*<a:latin typeface="([^"]+)"/)?.[1] ?? 'Calibri',
    major: themeXml?.match(/<a:majorFont>\s*<a:latin typeface="([^"]+)"/)?.[1] ?? 'Calibri Light',
  };

  // Связи: картинки и ссылки
  const rels = new Map<string, { target: string; mode?: string }>();
  relsXml?.querySelectorAll('Relationship').forEach(r => rels.set(r.getAttribute('Id') ?? '', { target: r.getAttribute('Target') ?? '', mode: r.getAttribute('TargetMode') ?? undefined }));
  const media = new Map<string, string>();
  const mediaOf = async (rid: string): Promise<string | null> => {
    if (media.has(rid)) return media.get(rid)!;
    const rel = rels.get(rid);
    if (!rel) return null;
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : 'word/' + rel.target.replace(/^\.\//, '');
    const f = zip.file(path);
    if (!f) return null;
    const b64: string = await f.async('base64');
    const ext = path.split('.').pop()!.toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'webp' ? 'image/webp' : '';
    if (!mime) return null;          // emf/wmf браузер не покажет
    const url = `data:${mime};base64,${b64}`;
    media.set(rid, url);
    return url;
  };

  // Стили
  const styles = new Map<string, StyleDef>();
  let defaultPStyle = 'Normal', defaultTStyle = '';
  stylesXml?.documentElement && kids(stylesXml.documentElement, 'style').forEach(st => {
    const id = wattr(st, 'styleId') ?? '';
    const type = wattr(st, 'type') ?? 'paragraph';
    if (wattr(st, 'default') === '1' && type === 'paragraph') defaultPStyle = id;
    if (wattr(st, 'default') === '1' && type === 'table') defaultTStyle = id;
    styles.set(id, {
      type, name: (wattr(kid(st, 'name'), 'val') ?? id).toLowerCase(),
      basedOn: wattr(kid(st, 'basedOn'), 'val') ?? undefined,
      pPr: kid(st, 'pPr') ?? undefined, rPr: kid(st, 'rPr') ?? undefined, tblPr: kid(st, 'tblPr') ?? undefined,
    });
  });
  const docDefaults = stylesXml?.documentElement ? kid(stylesXml.documentElement, 'docDefaults') : null;
  const defR = kid(kid(docDefaults, 'rPrDefault'), 'rPr');
  const defP = kid(kid(docDefaults, 'pPrDefault'), 'pPr');

  /** Цепочка стилей от базового к конкретному. */
  const chain = (id: string | null | undefined): StyleDef[] => {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id ?? '';
    while (cur && styles.has(cur) && !seen.has(cur)) { seen.add(cur); const s = styles.get(cur)!; out.unshift(s); cur = s.basedOn ?? ''; }
    return out;
  };

  // Базовые свойства документа — шрифт по умолчанию
  const baseRun: Props = {};
  rPrToCss(defR, theme, baseRun);
  for (const s of chain(defaultPStyle)) rPrToCss(s.rPr ?? null, theme, baseRun);
  const font = {
    name: (baseRun['font-family'] ?? theme.minor).replace(/['"]/g, ''),
    size: parseFloat(baseRun['font-size'] ?? '') || 10,
  };
  // То, что редактор выставляет сам, в каждом абзаце не повторяем
  const editorBaseRun: Props = { 'font-family': font.name, 'font-size': `${font.size}pt` };

  // Нумерация: numId → abstractNum → уровни
  const absNums = new Map<string, Map<number, { fmt: string; start: number; text: string }>>();
  const nums = new Map<string, string>();
  if (numXml?.documentElement) {
    kids(numXml.documentElement, 'abstractNum').forEach(an => {
      const lv = new Map<number, { fmt: string; start: number; text: string }>();
      kids(an, 'lvl').forEach(l => lv.set(+(wattr(l, 'ilvl') ?? 0), {
        fmt: wattr(kid(l, 'numFmt'), 'val') ?? 'decimal',
        start: +(wattr(kid(l, 'start'), 'val') ?? 1),
        text: wattr(kid(l, 'lvlText'), 'val') ?? '',
      }));
      absNums.set(wattr(an, 'abstractNumId') ?? '', lv);
    });
    kids(numXml.documentElement, 'num').forEach(n => nums.set(wattr(n, 'numId') ?? '', wattr(kid(n, 'abstractNumId'), 'val') ?? ''));
  }
  const listLevel = (numId: string, ilvl: number) => absNums.get(nums.get(numId) ?? '')?.get(ilvl) ?? { fmt: 'bullet', start: 1, text: '•' };

  // ── Тело ──
  const body = kid(docXml.documentElement, 'body');
  if (!body) throw new Error('Пустой документ');

  // Секция (последняя) — размер и поля страницы
  const sect = kid(body, 'sectPr');
  const pg = { ...DEFAULT_PAGE };
  if (sect) {
    const sz = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
    if (sz) { pg.w = +(wattr(sz, 'w') ?? pg.w); pg.h = +(wattr(sz, 'h') ?? pg.h); }
    if (mar) for (const k of ['top', 'right', 'bottom', 'left'] as const) { const v = wattr(mar, k); if (v !== null) pg[k] = Math.abs(+v); }
  }
  const landscape = pg.w > pg.h;

  /** Обработать последовательность элементов тела/ячейки. */
  const blocks = async (container: Element): Promise<string> => {
    let html = '';
    // Открытые списки: стек уровней
    const listStack: Array<{ tag: 'ul' | 'ol'; numId: string; lvl: number }> = [];
    const closeLists = (toLevel = -1) => {
      while (listStack.length && listStack[listStack.length - 1].lvl > toLevel) {
        html += `</li></${listStack.pop()!.tag}>`;
      }
    };
    for (const el of Array.from(container.children)) {
      const name = el.localName;
      if (name === 'p') {
        const pPr = kid(el, 'pPr');
        const numPr = kid(pPr, 'numPr');
        const styleId = wattr(kid(pPr, 'pStyle'), 'val') ?? defaultPStyle;
        const sChain = chain(styleId);
        // Нумерация может прийти из стиля абзаца
        let numId = wattr(kid(numPr, 'numId'), 'val');
        let ilvl = +(wattr(kid(numPr, 'ilvl'), 'val') ?? 0);
        if (!numId) for (const s of sChain) { const np = kid(s.pPr ?? null, 'numPr'); if (np) { numId = wattr(kid(np, 'numId'), 'val') ?? numId; ilvl = +(wattr(kid(np, 'ilvl'), 'val') ?? ilvl); } }
        const isList = !!numId && numId !== '0';

        const pCss: Props = {};
        pPrToCss(defP, pCss);
        for (const s of sChain) pPrToCss(s.pPr ?? null, pCss);
        pPrToCss(pPr, pCss);
        const runBase: Props = { ...baseRun };
        for (const s of sChain) rPrToCss(s.rPr ?? null, theme, runBase);
        // Свойства символа самого абзаца (знак абзаца) влияют на пустые абзацы
        const markCss: Props = { ...runBase };
        rPrToCss(kid(pPr, 'rPr'), theme, markCss);

        const content = await inline(el, runBase);
        const isEmpty = !content.replace(/<br>/g, '').trim();
        const pageBreakBefore = onOff(kid(pPr, 'pageBreakBefore'));

        const sName = sChain.length ? sChain[sChain.length - 1].name : '';
        const h = sName.match(/^heading (\d)$/);
        let tag = h ? `h${Math.min(6, +h[1])}` : 'p';
        let cls = '';
        if (sName === 'title') { tag = 'h1'; cls = 'doc-title'; }
        else if (sName === 'quote' || sName === 'intense quote') tag = 'blockquote';

        // Шрифт абзаца — по символам знака абзаца, если в нём нет текста
        const blockCss: Props = { ...pCss };
        const mark = stripDefaults(markCss, editorBaseRun);
        for (const k of ['font-family', 'font-size', 'color', 'font-weight', 'font-style']) if (mark[k]) blockCss[k] = mark[k];
        if (isList) { delete blockCss['margin-left']; delete blockCss['text-indent']; }
        const style = cssText(blockCss);
        const inner = isEmpty ? '<br>' : content;

        if (pageBreakBefore) html += '<hr class="dw-pb">';
        if (isList) {
          const lv = listLevel(numId!, ilvl);
          const ltag: 'ul' | 'ol' = lv.fmt === 'bullet' || lv.fmt === 'none' ? 'ul' : 'ol';
          const top = listStack[listStack.length - 1];
          if (top && top.lvl === ilvl && (top.numId !== numId || top.tag !== ltag)) closeLists(ilvl - 1);
          const cur = listStack[listStack.length - 1];
          if (cur && cur.lvl === ilvl) html += '</li>';
          else if (cur && cur.lvl > ilvl) { closeLists(ilvl); html += '</li>'; }
          if (!listStack.length || listStack[listStack.length - 1].lvl < ilvl) {
            const typeAttr = ltag === 'ol' ? ({ lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' } as Record<string, string>)[lv.fmt] : undefined;
            const startAttr = ltag === 'ol' && lv.start !== 1 ? ` start="${lv.start}"` : '';
            const ulStyle = ltag === 'ul' && lv.text && !['•', '', '·'].includes(lv.text) ? ` style="list-style-type:'${lv.text.replace(/'/g, '')} '"` : '';
            html += `<${ltag}${typeAttr ? ` type="${typeAttr}"` : ''}${startAttr}${ulStyle}>`;
            listStack.push({ tag: ltag, numId: numId!, lvl: ilvl });
          }
          html += `<li${style ? ` style="${escAttr(style)}"` : ''}>${inner}`;
          continue;
        }
        closeLists();
        const open = `<${tag}${cls ? ` class="${cls}"` : ''}${style ? ` style="${escAttr(style)}"` : ''}>`;
        // Разрыв страницы внутри абзаца: <hr> в <p> HTML не допускает —
        // делим абзац на части вокруг разрыва
        const parts = inner.split('<hr class="dw-pb">');
        parts.forEach((part, i) => {
          if (i) html += '<hr class="dw-pb">';
          if (parts.length === 1 || part.replace(/<br>/g, '').trim()) html += `${open}${part || '<br>'}</${tag}>`;
        });
      } else if (name === 'tbl') {
        closeLists();
        html += await table(el);
      } else if (name === 'sdt') {
        closeLists();
        const c = kid(el, 'sdtContent');
        if (c) html += await blocks(c);
      } else if (name === 'customXml' || name === 'ins') {
        html += await blocks(el);
      }
    }
    closeLists();
    return html;
  };

  /** Содержимое абзаца: прогоны, ссылки, картинки, разрывы. */
  const inline = async (p: Element, runBase: Props): Promise<string> => {
    let out = '';
    const walk = async (node: Element, link?: string): Promise<void> => {
      for (const el of Array.from(node.children)) {
        const n = el.localName;
        if (n === 'r') out += await run(el, runBase, link);
        else if (n === 'hyperlink') {
          const rid = el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? el.getAttribute('r:id');
          const anchor = wattr(el, 'anchor');
          const href = safeHref(rid ? rels.get(rid)?.target : anchor ? '#' + anchor : undefined);
          await walk(el, href);
        }
        else if (n === 'ins' || n === 'smartTag' || n === 'customXml' || n === 'fldSimple' || n === 'bdo' || n === 'dir') await walk(el, link);
        else if (n === 'sdt') { const c = kid(el, 'sdtContent'); if (c) await walk(c, link); }
      }
    };
    await walk(p);
    return out;
  };

  const run = async (r: Element, runBase: Props, link?: string): Promise<string> => {
    const rPr = kid(r, 'rPr');
    const css: Props = { ...runBase };
    const rStyle = wattr(kid(rPr, 'rStyle'), 'val');
    for (const s of chain(rStyle)) rPrToCss(s.rPr ?? null, theme, css);
    rPrToCss(rPr, theme, css);
    let content = '';
    for (const el of Array.from(r.children)) {
      const n = el.localName;
      if (n === 't') content += escHtml(el.textContent ?? '');
      else if (n === 'tab' || n === 'ptab') content += '\t';
      else if (n === 'br' || n === 'cr') content += wattr(el, 'type') === 'page' ? '<hr class="dw-pb">' : '<br>';
      else if (n === 'noBreakHyphen') content += '‑';
      else if (n === 'softHyphen') content += '­';
      else if (n === 'sym') { const ch = wattr(el, 'char'); if (ch) content += String.fromCharCode(parseInt(ch, 16) & 0xffff || 0x2022); }
      else if (n === 'drawing' || n === 'pict' || n === 'object') {
        const blip = el.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
        const rid = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? blip?.getAttribute('r:embed')
          ?? (el.getElementsByTagName('v:imagedata')[0]?.getAttribute('r:id') ?? null);
        if (!rid) continue;
        const src = await mediaOf(rid);
        if (!src) continue;
        const ext = el.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
        const w = ext ? Math.round(+(ext.getAttribute('cx') ?? 0) / EMU_PER_PX) : 0;
        const h = ext ? Math.round(+(ext.getAttribute('cy') ?? 0) / EMU_PER_PX) : 0;
        const alt = el.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')[0]?.getAttribute('descr') ?? '';
        content += `<img src="${src}" alt="${escAttr(alt)}"${w && h ? ` style="width:${w}px;height:${h}px"` : ''}>`;
      }
    }
    if (!content) return '';
    const st = cssText(stripDefaults(css, editorBaseRun));
    let html = st ? `<span style="${escAttr(st)}">${content}</span>` : content;
    if (link) html = `<a href="${escAttr(link)}">${html}</a>`;
    return html;
  };

  /** Таблица: ширины колонок, объединения, заливка и рамки ячеек. */
  const table = async (tbl: Element): Promise<string> => {
    const tblPr = kid(tbl, 'tblPr');
    const tStyle = wattr(kid(tblPr, 'tblStyle'), 'val') ?? defaultTStyle;
    const tChain = chain(tStyle);
    let borders: Element | null = null;
    for (const s of tChain) { const b = kid(s.tblPr ?? null, 'tblBorders'); if (b) borders = b; }
    const own = kid(tblPr, 'tblBorders'); if (own) borders = own;
    const hasBorder = !!borders && ['top', 'left', 'insideH', 'insideV', 'bottom', 'right'].some(sd => { const b = kid(borders, sd); return b && !['none', 'nil'].includes(wattr(b, 'val') ?? ''); });
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(g => twipToPx(+(wattr(g, 'w') ?? 0)));
    const jc = wattr(kid(tblPr, 'jc'), 'val');
    const rows = kids(tbl, 'tr');
    // Сетка ячеек с учётом gridSpan и vMerge
    type Cell = { el: Element; col: number; span: number; rowspan: number; skip: boolean };
    const matrix: Cell[][] = [];
    rows.forEach((tr, ri) => {
      let col = +(wattr(kid(kid(tr, 'trPr'), 'gridBefore'), 'val') ?? 0);
      const row: Cell[] = [];
      kids(tr, 'tc').forEach(tc => {
        const tcPr = kid(tc, 'tcPr');
        const span = +(wattr(kid(tcPr, 'gridSpan'), 'val') ?? 1);
        const vm = kid(tcPr, 'vMerge');
        const cont = vm && (wattr(vm, 'val') ?? 'continue') === 'continue';
        const cell: Cell = { el: tc, col, span, rowspan: 1, skip: !!cont };
        if (cont) {
          for (let up = ri - 1; up >= 0; up--) {
            const above = matrix[up].find(c => c.col === col);
            if (above && !above.skip) { above.rowspan++; break; }
            if (!above) break;
          }
        }
        row.push(cell);
        col += span;
      });
      matrix.push(row);
    });
    let html = `<table${hasBorder ? '' : ' class="dw-noborder"'} style="${jc === 'center' ? 'margin-left:auto;margin-right:auto;' : ''}${grid.length ? `width:${Math.round(grid.reduce((a, b) => a + b, 0))}px` : 'width:100%'}">`;
    if (grid.length) html += `<colgroup>${grid.map(w => `<col style="width:${Math.round(w)}px">`).join('')}</colgroup>`;
    for (let ri = 0; ri < rows.length; ri++) {
      const trPr = kid(rows[ri], 'trPr');
      const hgt = kid(trPr, 'trHeight');
      html += `<tr${hgt ? ` style="height:${Math.round(twipToPx(+(wattr(hgt, 'val') ?? 0)))}px"` : ''}>`;
      for (const cell of matrix[ri]) {
        if (cell.skip) continue;
        const tcPr = kid(cell.el, 'tcPr');
        const css: Props = {};
        const shd = kid(tcPr, 'shd');
        const fill = wattr(shd, 'fill');
        if (fill && fill !== 'auto' && /^[0-9a-f]{6}$/i.test(fill)) css['background-color'] = '#' + fill.toLowerCase();
        const va = wattr(kid(tcPr, 'vAlign'), 'val');
        if (va === 'center') css['vertical-align'] = 'middle'; else if (va === 'bottom') css['vertical-align'] = 'bottom';
        const tcB = kid(tcPr, 'tcBorders');
        if (tcB) for (const side of ['top', 'left', 'bottom', 'right']) {
          const b = kid(tcB, side) ?? kid(tcB, side === 'left' ? 'start' : side === 'right' ? 'end' : side);
          if (!b) continue;
          const v = wattr(b, 'val');
          if (v === 'none' || v === 'nil') css[`border-${side}`] = 'none';
          else { const c = wattr(b, 'color'); css[`border-${side}`] = `${Math.max(1, Math.round(+(wattr(b, 'sz') ?? 4) / 6))}px solid ${c && c !== 'auto' ? '#' + c : '#000'}`; }
        }
        const inner = await blocks(cell.el);
        const attrs = (cell.span > 1 ? ` colspan="${cell.span}"` : '') + (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '');
        const st = cssText(css);
        html += `<td${attrs}${st ? ` style="${escAttr(st)}"` : ''}>${inner || '<p><br></p>'}</td>`;
      }
      html += '</tr>';
    }
    return html + '</table>';
  };

  let html = await blocks(body);
  html = html.replace(/<p([^>]*)><hr class="dw-pb"><\/p>/g, '<hr class="dw-pb">');
  return {
    html: html || '<p><br></p>',
    meta: { page: { ...pg, ...(landscape ? { landscape: true } : {}) }, font },
  };
}

// ═══════════════════════════ Экспорт ═══════════════════════════

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cssHex(css: string | undefined | null): string | null {
  if (!css) return null;
  const v = css.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'inherit' || v === 'initial') return null;
  const rgb = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (rgb) { if (rgb[4] !== undefined && +rgb[4] < 0.1) return null; return [rgb[1], rgb[2], rgb[3]].map(n => (+n).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  const h6 = v.match(/^#([0-9a-f]{6})$/); if (h6) return h6[1].toUpperCase();
  const h3 = v.match(/^#([0-9a-f]{3})$/); if (h3) return h3[1].split('').map(c => c + c).join('').toUpperCase();
  const named: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500', purple: '800080', gray: '808080', grey: '808080' };
  return named[v] ?? null;
}

/** Размер CSS → пункты. */
function toPt(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  if (/pt$/.test(v)) return n;
  if (/px$/.test(v)) return n * 0.75;
  if (/cm$/.test(v)) return n * 28.3465;
  if (/mm$/.test(v)) return n * 2.83465;
  if (/in$/.test(v)) return n * 72;
  if (/em$/.test(v)) return n * 11;
  return n * 0.75;
}

const HL_BY_HEX = new Map(Object.entries(HIGHLIGHT).map(([k, v]) => [v.slice(1).toUpperCase(), k]));

interface RP { bold?: boolean; italic?: boolean; under?: string; strike?: boolean; sz?: number; color?: string; bg?: string; font?: string; va?: 'superscript' | 'subscript'; caps?: boolean; }

export interface DocxWriteOpts { meta?: WordMeta; title?: string }

/** Собрать .docx из HTML редактора. */
export async function writeDocx(html: string, opts: DocxWriteOpts = {}): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new (JSZip as any)();
  const page = { ...DEFAULT_PAGE, ...(opts.meta?.page ?? {}) };
  const font = opts.meta?.font ?? DEFAULT_FONT;
  const { xml: bodyXml, images, links, numXml, numIds } = htmlToWordXml(html, page);

  const sectPr = `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"${page.w > page.h ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${page.top}" w:right="${page.right}" w:bottom="${page.bottom}" w:left="${page.left}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"><w:body>${bodyXml}${sectPr}</w:body></w:document>`;

  const F = xmlEsc(font.name);
  const sz = Math.round(font.size * 2);
  // Стили совпадают с тем, как редактор рисует эти элементы (docs-editor.css)
  const hStyle = (n: number, size: number, color: string, extra = '') =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${n === 1 ? 240 : 40}" w:after="0"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${extra}</w:rPr></w:style>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${F}" w:hAnsi="${F}" w:cs="${F}" w:eastAsia="${F}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="ru-RU" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${hStyle(1, 32, '2F5496')}${hStyle(2, 26, '2F5496')}${hStyle(3, 24, '1F3763')}${hStyle(4, 22, '2F5496', '<w:i/><w:iCs/>')}${hStyle(5, 22, '2F5496')}${hStyle(6, 22, '1F3763')}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="160"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...new Set(images.map(i => i.ext))].map(e => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${images.map(i => `<Relationship Id="${i.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${i.name}"/>`).join('')}${links.map(l => `<Relationship Id="${l.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(l.url)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(opts.title ?? '')}</dc:title><dc:creator>SimaDesk</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('docProps/core.xml', core);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/numbering.xml', numXml);
  zip.file('word/_rels/document.xml.rels', docRels);
  images.forEach(i => zip.file(`word/media/${i.name}`, i.bytes));
  void numIds;
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** HTML → тело WordprocessingML + ресурсы. */
export function htmlToWordXml(html: string, page = DEFAULT_PAGE): {
  xml: string;
  images: Array<{ rid: string; name: string; ext: string; bytes: Uint8Array }>;
  links: Array<{ rid: string; url: string }>;
  numXml: string;
  numIds: number;
} {
  const dom = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const body = dom.body;
  const ex = xmlEsc;
  const textWidthPx = twipToPx(page.w - page.left - page.right);

  const images: Array<{ rid: string; name: string; ext: string; bytes: Uint8Array }> = [];
  const links: Array<{ rid: string; url: string }> = [];
  let ridSeq = 2;
  const nextRid = () => `rId${++ridSeq}`;
  const linkMap = new Map<string, string>();
  const addLink = (url: string) => { const hit = linkMap.get(url); if (hit) return hit; const rid = nextRid(); links.push({ rid, url }); linkMap.set(url, rid); return rid; };

  // Нумерация: у каждого списка — свой экземпляр, иначе нумерация
  // продолжалась бы через весь документ, а не начиналась с 1
  const abstracts: string[] = [];
  const numDefs: string[] = [];
  let numSeq = 0;
  const FMT: Record<string, string> = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman' };
  const newNum = (ordered: boolean, type: string | null, start: number): number => {
    const id = ++numSeq;
    const fmt = ordered ? FMT[type ?? '1'] ?? 'decimal' : 'bullet';
    const bullets = ['•', 'o', '▪'];
    abstracts.push(`<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) =>
      `<w:lvl w:ilvl="${i}"><w:start w:val="${i === 0 ? start : 1}"/><w:numFmt w:val="${ordered ? (i === 0 ? fmt : ['lowerLetter', 'lowerRoman'][(i - 1) % 2] ?? 'decimal') : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${i + 1}.` : bullets[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${!ordered ? `<w:rPr><w:rFonts w:ascii="${i % 3 === 1 ? 'Courier New' : i % 3 === 2 ? 'Wingdings' : 'Symbol'}" w:hAnsi="${i % 3 === 1 ? 'Courier New' : 'Symbol'}" w:hint="default"/></w:rPr>` : ''}</w:lvl>`).join('')}</w:abstractNum>`);
    numDefs.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`);
    return id;
  };

  const dataUriToBytes = (uri: string): { bytes: Uint8Array; ext: string } | null => {
    const m = uri.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) return null;
    let ext = m[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!['png', 'jpg', 'gif', 'bmp'].includes(ext)) return null;
    try {
      const bin = atob(m[2].replace(/\s/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, ext };
    } catch { return null; }
  };
  const imageSize = (b: Uint8Array): { w: number; h: number } | null => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        i += 2 + ((b[i + 2] << 8) | b[i + 3]);
      }
    }
    return null;
  };
  let picSeq = 0;
  const imageRun = (img: HTMLImageElement, maxW = textWidthPx): string => {
    const decoded = dataUriToBytes(img.getAttribute('src') || '');
    if (!decoded) return '';
    const nat = imageSize(decoded.bytes) ?? { w: 400, h: 300 };
    const aw = parseFloat(img.style?.width || img.getAttribute('width') || '') || 0;
    const ah = parseFloat(img.style?.height || img.getAttribute('height') || '') || 0;
    let w = aw || nat.w, h = ah || (aw ? Math.round(aw * nat.h / nat.w) : nat.h);
    if (w > maxW) { h = Math.round(h * maxW / w); w = Math.round(maxW); }
    const rid = nextRid();
    const idx = ++picSeq;
    const name = `image${idx}.${decoded.ext}`;
    images.push({ rid, name, ext: decoded.ext, bytes: decoded.bytes });
    const cx = Math.round(w * EMU_PER_PX), cy = Math.round(h * EMU_PER_PX);
    const alt = ex(img.getAttribute('alt') || `Изображение ${idx}`);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${idx}" name="Рисунок ${idx}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${idx}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  const merge = (a: RP, b: RP): RP => ({ ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) });
  const rpFromEl = (el: Element): RP => {
    const rp: RP = {};
    const tag = el.tagName.toLowerCase();
    const st = (el as HTMLElement).style;
    if (tag === 'b' || tag === 'strong') rp.bold = true;
    if (tag === 'i' || tag === 'em') rp.italic = true;
    if (tag === 'u' || tag === 'ins') rp.under = 'single';
    if (tag === 's' || tag === 'strike' || tag === 'del') rp.strike = true;
    if (tag === 'mark') rp.bg = 'FFFF00';
    if (tag === 'sup') rp.va = 'superscript';
    if (tag === 'sub') rp.va = 'subscript';
    if (tag === 'code' || tag === 'kbd') rp.font = 'Consolas';
    if (tag === 'font') {
      const c = cssHex(el.getAttribute('color')); if (c) rp.color = c;
      const f = el.getAttribute('face'); if (f) rp.font = f.split(',')[0].trim().replace(/['"]/g, '');
    }
    if (!st) return rp;
    const fw = st.fontWeight;
    if (fw === 'bold' || parseInt(fw) >= 600) rp.bold = true; else if (fw === 'normal' || (parseInt(fw) > 0 && parseInt(fw) < 600)) rp.bold = false;
    if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') rp.italic = true; else if (st.fontStyle === 'normal') rp.italic = false;
    const td = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
    if (td.includes('underline')) rp.under = (st.textDecorationStyle === 'double' || td.includes('double')) ? 'double' : 'single';
    if (td.includes('line-through')) rp.strike = true;
    if (/\bnone\b/.test(td)) { rp.under = 'none'; rp.strike = false; }
    if (st.fontSize) { const pt = toPt(st.fontSize); if (pt && pt > 0) rp.sz = Math.round(pt * 2); }
    if (st.color) { const h = cssHex(st.color); if (h) rp.color = h; }
    if (st.backgroundColor) { const h = cssHex(st.backgroundColor); if (h && h !== 'FFFFFF') rp.bg = h; }
    if (st.fontFamily) { const n = st.fontFamily.split(',')[0].trim().replace(/['"]/g, ''); if (n) rp.font = n; }
    if (st.verticalAlign === 'super') rp.va = 'superscript';
    if (st.verticalAlign === 'sub') rp.va = 'subscript';
    if (st.textTransform === 'uppercase') rp.caps = true;
    return rp;
  };
  const rprXml = (rp: RP, linkStyle = false): string => {
    let x = '';
    if (linkStyle) x += '<w:rStyle w:val="Hyperlink"/>';
    if (rp.font) x += `<w:rFonts w:ascii="${ex(rp.font)}" w:hAnsi="${ex(rp.font)}" w:cs="${ex(rp.font)}" w:eastAsia="${ex(rp.font)}"/>`;
    if (rp.bold) x += '<w:b/><w:bCs/>'; else if (rp.bold === false) x += '<w:b w:val="0"/><w:bCs w:val="0"/>';
    if (rp.italic) x += '<w:i/><w:iCs/>'; else if (rp.italic === false) x += '<w:i w:val="0"/><w:iCs w:val="0"/>';
    if (rp.caps) x += '<w:caps/>';
    if (rp.strike) x += '<w:strike/>';
    if (rp.color) x += `<w:color w:val="${rp.color}"/>`;
    if (rp.sz) x += `<w:sz w:val="${rp.sz}"/><w:szCs w:val="${rp.sz}"/>`;
    if (rp.bg) { const hl = HL_BY_HEX.get(rp.bg); x += hl ? `<w:highlight w:val="${hl}"/>` : `<w:shd w:val="clear" w:color="auto" w:fill="${rp.bg}"/>`; }
    if (rp.under && rp.under !== 'none') x += `<w:u w:val="${rp.under}"/>`; else if (rp.under === 'none') x += '<w:u w:val="none"/>';
    if (rp.va) x += `<w:vertAlign w:val="${rp.va}"/>`;
    return x ? `<w:rPr>${x}</w:rPr>` : '';
  };

  /** Текст → прогоны: табуляции и переводы строк Word хранит отдельными узлами. */
  const textRuns = (t: string, rp: RP, link: boolean): string => {
    let out = '';
    const parts = t.split(/(\t|\n)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\t') out += `<w:r>${rprXml(rp, link)}<w:tab/></w:r>`;
      else if (p === '\n') out += `<w:r>${rprXml(rp, link)}<w:br/></w:r>`;
      else out += `<w:r>${rprXml(rp, link)}<w:t xml:space="preserve">${ex(p)}</w:t></w:r>`;
    }
    return out;
  };

  const preserveWs = (n: Node): boolean => {
    for (let e: Element | null = n.parentElement; e; e = e.parentElement) {
      if (e.tagName === 'PRE') return true;
      const ws = (e as HTMLElement).style?.whiteSpace;
      if (ws && /pre/.test(ws)) return true;
    }
    return false;
  };

  const runs = (node: Node, rp: RP, link = false): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      let t = node.textContent ?? '';
      if (!preserveWs(node)) t = t.replace(/[\r\n]+/g, ' ');
      return t ? textRuns(t, rp, link) : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '<w:r><w:br/></w:r>';
    if (tag === 'script' || tag === 'style') return '';
    if (tag === 'img') return imageRun(el as HTMLImageElement);
    if (tag === 'hr' && el.classList.contains('dw-pb')) return '<w:r><w:br w:type="page"/></w:r>';
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const inner = Array.from(el.childNodes).map(c => runs(c, merge(rp, rpFromEl(el)), true)).join('');
      if (!inner) return '';
      if (!/^(https?:|mailto:|tel:|ftp:)/i.test(href)) return inner;
      return `<w:hyperlink r:id="${addLink(href)}" w:history="1">${inner}</w:hyperlink>`;
    }
    const merged = merge(rp, rpFromEl(el));
    return Array.from(el.childNodes).map(c => runs(c, merged, link)).join('');
  };

  const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'article', 'section', 'header', 'footer', 'main', 'nav', 'aside', 'li', 'address', 'figure', 'figcaption', 'ul', 'ol', 'table', 'hr', 'center']);
  const isBlockEl = (n: Node) => n.nodeType === Node.ELEMENT_NODE && BLOCK.has((n as Element).tagName.toLowerCase());

  const pprXml = (el: Element | null, o: { style?: string; num?: { id: number; lvl: number }; extraInd?: number } = {}): string => {
    let pp = '';
    if (o.style) pp += `<w:pStyle w:val="${o.style}"/>`;
    if (o.num) pp += `<w:numPr><w:ilvl w:val="${o.num.lvl}"/><w:numId w:val="${o.num.id}"/></w:numPr>`;
    const st = (el as HTMLElement | null)?.style;
    if (st) {
      const bbord = st.borderBottom || st.borderBottomStyle;
      if (bbord && !/none/.test(bbord)) {
        const c = cssHex(st.borderBottomColor) ?? '000000';
        pp += `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${c}"/></w:pBdr>`;
      }
      const bg = cssHex(st.backgroundColor);
      if (bg && bg !== 'FFFFFF') pp += `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`;
      const before = toPt(st.marginTop), after = toPt(st.marginBottom);
      const lh = st.lineHeight;
      let lineAttr = '';
      if (lh && lh !== 'normal') {
        if (/^[\d.]+$/.test(lh)) lineAttr = ` w:line="${Math.round(parseFloat(lh) * 240)}" w:lineRule="auto"`;
        else if (/%$/.test(lh)) lineAttr = ` w:line="${Math.round(parseFloat(lh) * 2.4)}" w:lineRule="auto"`;
        else { const pt = toPt(lh); if (pt) lineAttr = ` w:line="${Math.round(pt * 20)}" w:lineRule="exact"`; }
      }
      if (before !== null || after !== null || lineAttr) {
        pp += `<w:spacing${before !== null ? ` w:before="${Math.round(before * 20)}"` : ''}${after !== null ? ` w:after="${Math.round(after * 20)}"` : ''}${lineAttr}/>`;
      }
      const ml = toPt(st.marginLeft) ?? toPt(st.paddingLeft);
      const mr = toPt(st.marginRight);
      const ti = toPt(st.textIndent);
      if ((ml !== null && ml > 0) || (mr !== null && mr > 0) || ti || o.extraInd) {
        const left = Math.round(((ml ?? 0) * 20) + (o.extraInd ?? 0));
        pp += `<w:ind${left ? ` w:left="${left}"` : ''}${mr ? ` w:right="${Math.round(mr * 20)}"` : ''}${ti ? (ti > 0 ? ` w:firstLine="${Math.round(ti * 20)}"` : ` w:hanging="${Math.round(-ti * 20)}"`) : ''}/>`;
      }
      const al = st.textAlign || (el?.getAttribute('align') ?? '');
      if (al === 'center') pp += '<w:jc w:val="center"/>';
      else if (al === 'right' || al === 'end') pp += '<w:jc w:val="right"/>';
      else if (al === 'justify') pp += '<w:jc w:val="both"/>';
    } else if (o.extraInd) pp += `<w:ind w:left="${o.extraInd}"/>`;
    return pp ? `<w:pPr>${pp}</w:pPr>` : '';
  };

  let out = '';
  /** Строчное содержимое, накопленное на верхнем уровне без блока-обёртки. */
  let pending: Node[] = [];
  const flushInline = (rp: RP) => {
    if (!pending.length) return;
    const r = pending.map(n => runs(n, rp)).join('');
    const hasText = pending.some(n => (n.textContent ?? '').trim() || (n as Element).tagName === 'IMG');
    pending = [];
    if (hasText) out += `<w:p>${r}</w:p>`;
  };

  const blockEl = (el: Element, rp: RP, list?: { id: number; lvl: number }, ctx: { inTable?: boolean } = {}): void => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'table') { out += table(el, rp); if (!ctx.inTable) out += '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'; return; }
    if (tag === 'hr') {
      out += el.classList.contains('dw-pb') || el.classList.contains('docx-page-break')
        ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
        : '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
      return;
    }
    if (el.classList.contains('docx-page-break')) { out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; return; }
    if (tag === 'ul' || tag === 'ol') {
      const lvl = list ? list.lvl + 1 : 0;
      const id = list && lvl > 0 && list.id ? list.id : 0;
      const numId = id || newNum(tag === 'ol', el.getAttribute('type'), +(el.getAttribute('start') ?? 1) || 1);
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() !== 'li') { blockEl(li, rp, { id: numId, lvl }, ctx); continue; }
        listItem(li, merge(rp, rpFromEl(el)), { id: numId, lvl: Math.min(lvl, 8) }, ctx);
      }
      return;
    }
    const elRP = merge(rp, rpFromEl(el));
    const kids = Array.from(el.childNodes);
    if (kids.some(isBlockEl)) {
      // Контейнер: строчные куски между блоками — отдельными абзацами
      let buf: Node[] = [];
      const flush = () => {
        if (!buf.length) return;
        const r = buf.map(n => runs(n, elRP)).join('');
        if (buf.some(n => (n.textContent ?? '').trim() || (n as Element).tagName === 'IMG' || (n as Element).tagName === 'BR'))
          out += `<w:p>${pprXml(el, { num: list })}${r}</w:p>`;
        buf = [];
      };
      for (const k of kids) {
        if (isBlockEl(k)) { flush(); blockEl(k as Element, elRP, list, ctx); }
        else buf.push(k);
      }
      flush();
      return;
    }
    const m = /^h([1-6])$/.exec(tag);
    let style: string | undefined;
    if (el.classList.contains('doc-title')) style = 'Title';
    else if (m) style = `Heading${m[1]}`;
    else if (tag === 'blockquote') style = 'Quote';
    else if (tag === 'pre') style = 'Code';
    else if (list) style = 'ListParagraph';
    let r = kids.map(c => runs(c, elRP)).join('');
    // Пустой абзац остаётся пустым абзацем — раньше «пустые строки» терялись
    if (!r && kids.length === 1 && (kids[0] as Element).tagName === 'BR') r = '';
    if (tag === 'pre') {
      r = (el.textContent ?? '').split('\n').map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + textRuns(line, elRP, false)).join('');
    }
    out += `<w:p>${pprXml(el, { style, num: list })}${r}</w:p>`;
  };

  const listItem = (li: Element, rp: RP, list: { id: number; lvl: number }, ctx: { inTable?: boolean }) => {
    const liRP = merge(rp, rpFromEl(li));
    const kids = Array.from(li.childNodes);
    let buf: Node[] = [];
    let first = true;
    const flush = () => {
      const r = buf.map(n => runs(n, liRP)).join('');
      if (buf.length || first) {
        out += `<w:p>${pprXml(li, { style: 'ListParagraph', num: first ? list : undefined, extraInd: first ? 0 : 720 * (list.lvl + 1) })}${r}</w:p>`;
        first = false;
      }
      buf = [];
    };
    for (const k of kids) {
      const t = (k as Element).tagName?.toLowerCase();
      if (t === 'ul' || t === 'ol') { if (buf.length || first) flush(); blockEl(k as Element, liRP, list, ctx); }
      else if (isBlockEl(k) && t !== 'li') {
        if (buf.length) flush();
        if (first) {
          // Первый абзац пункта несёт номер
          const sub = k as Element;
          const r = Array.from(sub.childNodes).map(c => runs(c, merge(liRP, rpFromEl(sub)))).join('');
          out += `<w:p>${pprXml(sub, { style: 'ListParagraph', num: list })}${r}</w:p>`;
          first = false;
        } else blockEl(k as Element, liRP, undefined, ctx);
      }
      else buf.push(k);
    }
    if (buf.length || first) flush();
  };

  const table = (tableEl: Element, rp: RP): string => {
    const noBorder = tableEl.classList.contains('dw-noborder');
    const trs = Array.from(tableEl.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'));
    // Сетка занятости: rowspan/colspan → gridSpan/vMerge
    type Slot = { el: HTMLTableCellElement; start: boolean; span: number } | null;
    const grid: Slot[][] = [];
    let cols = 0;
    trs.forEach((tr, ri) => {
      grid[ri] = grid[ri] ?? [];
      let ci = 0;
      for (const td of Array.from(tr.children) as HTMLTableCellElement[]) {
        if (!/^(TD|TH)$/.test(td.tagName)) continue;
        while (grid[ri][ci]) ci++;
        const cs = Math.max(1, td.colSpan || 1), rs = Math.max(1, td.rowSpan || 1);
        for (let dr = 0; dr < rs; dr++) {
          const row = grid[ri + dr] ?? (grid[ri + dr] = []);
          row[ci] = { el: td, start: dr === 0, span: cs };
          for (let dc = 1; dc < cs; dc++) row[ci + dc] = null;
        }
        ci += cs;
        cols = Math.max(cols, ci);
      }
    });
    // Ширины колонок: из <col>, затем из ячеек первой строки, иначе поровну
    const widths: number[] = new Array(cols).fill(0);
    const colEls = Array.from(tableEl.querySelectorAll(':scope > colgroup > col')) as HTMLElement[];
    colEls.forEach((c, i) => { if (i < cols) widths[i] = parseFloat(c.style.width) || 0; });
    if (!widths.some(Boolean) && grid[0]) {
      grid[0].forEach((slot, i) => { if (slot?.start && slot.span === 1) widths[i] = parseFloat(slot.el.style.width) || 0; });
    }
    const tableW = parseFloat((tableEl as HTMLElement).style.width) || 0;
    const totalPx = /%$/.test((tableEl as HTMLElement).style.width) ? textWidthPx * tableW / 100 : tableW || textWidthPx;
    const known = widths.reduce((a, b) => a + b, 0);
    const unknown = widths.filter(w => !w).length;
    for (let i = 0; i < cols; i++) if (!widths[i]) widths[i] = unknown ? Math.max(20, (totalPx - known) / unknown) : totalPx / Math.max(1, cols);
    const tw = widths.map(w => pxToTwip(w));
    const center = (tableEl as HTMLElement).style.marginLeft === 'auto';
    const brd = noBorder ? '' : '<w:tblStyle w:val="TableGrid"/>';
    let x = `<w:tbl><w:tblPr>${brd}<w:tblW w:w="${tw.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${center ? '<w:jc w:val="center"/>' : ''}<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${tw.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    grid.forEach((row, ri) => {
      const tr = trs[ri] as HTMLElement | undefined;
      const h = tr ? parseFloat(tr.style.height) : 0;
      const isHead = tr?.parentElement?.tagName === 'THEAD';
      x += `<w:tr>${h || isHead ? `<w:trPr>${h ? `<w:trHeight w:val="${pxToTwip(h)}"/>` : ''}${isHead ? '<w:tblHeader/>' : ''}</w:trPr>` : ''}`;
      for (let ci = 0; ci < cols; ci++) {
        const slot = row[ci];
        if (slot === null) continue;                     // покрыто colspan
        if (!slot) { x += `<w:tc><w:tcPr><w:tcW w:w="${tw[ci]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; continue; }
        const td = slot.el;
        const span = slot.span;
        const w = tw.slice(ci, ci + span).reduce((a, b) => a + b, 0);
        let tcPr = `<w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}`;
        if ((td.rowSpan || 1) > 1 || !slot.start) tcPr += slot.start ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
        const bdrs: string[] = [];
        for (const side of ['top', 'left', 'bottom', 'right'] as const) {
          const css = td.style.getPropertyValue(`border-${side}`);
          if (!css) continue;
          if (/none|hidden/.test(css)) bdrs.push(`<w:${side} w:val="nil"/>`);
          else { const c = cssHex(td.style.getPropertyValue(`border-${side}-color`)) ?? '000000'; const wpx = parseFloat(css) || 1; bdrs.push(`<w:${side} w:val="${/double/.test(css) ? 'double' : /dashed/.test(css) ? 'dashed' : /dotted/.test(css) ? 'dotted' : 'single'}" w:sz="${Math.max(2, Math.round(wpx * 6))}" w:space="0" w:color="${c}"/>`); }
        }
        if (bdrs.length) tcPr += `<w:tcBorders>${bdrs.join('')}</w:tcBorders>`;
        const bg = cssHex(td.style.backgroundColor);
        if (bg && bg !== 'FFFFFF') tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`;
        const va = td.style.verticalAlign;
        if (va === 'middle') tcPr += '<w:vAlign w:val="center"/>'; else if (va === 'bottom') tcPr += '<w:vAlign w:val="bottom"/>';
        let inner = '';
        if (slot.start) {
          const saved = out; out = '';
          const cellRP = merge(rp, td.tagName === 'TH' ? { bold: true } : {});
          const kids = Array.from(td.childNodes);
          if (kids.some(isBlockEl)) {
            let buf: Node[] = [];
            const flush = () => { if (buf.some(n => (n.textContent ?? '').trim() || (n as Element).tagName === 'IMG')) out += `<w:p>${pprXml(td)}${buf.map(n => runs(n, merge(cellRP, rpFromEl(td)))).join('')}</w:p>`; buf = []; };
            for (const k of kids) { if (isBlockEl(k)) { flush(); blockEl(k as Element, merge(cellRP, rpFromEl(td)), undefined, { inTable: true }); } else buf.push(k); }
            flush();
          } else {
            out += `<w:p>${pprXml(td)}${kids.map(n => runs(n, merge(cellRP, rpFromEl(td)))).join('')}</w:p>`;
          }
          inner = out || '<w:p/>';
          out = saved;
        } else inner = '<w:p/>';
        x += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${inner}</w:tc>`;
      }
      x += '</w:tr>';
    });
    return x + '</w:tbl>';
  };

  for (const node of Array.from(body.childNodes)) {
    if (isBlockEl(node)) { flushInline({}); blockEl(node as Element, {}); }
    else pending.push(node);
  }
  flushInline({});

  const numXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstracts.join('')}${numDefs.join('')}</w:numbering>`;
  return { xml: out || '<w:p/>', images, links, numXml, numIds: numSeq };
}
