/**
 * Текстовый редактор в духе Word.
 *
 * Раньше документ резался на отдельные «страницы» — отдельные
 * contenteditable-блоки: нельзя было выделить текст через границу страниц,
 * набранное не перетекало дальше, а отмена работала только внутри одной
 * страницы. Теперь документ — одна редактируемая страница размера из
 * настроек (A4 по умолчанию) с полями, а границы страниц показаны линией.
 *
 * Отмена — своя, по снимкам: часть правок (таблицы, отступы, интервалы)
 * делается прямой правкой DOM, которую встроенная отмена браузера не видит.
 */

import type { WordMeta } from './model';
import { DEFAULT_PAGE, DEFAULT_FONT, twipToPx } from './docxIO';
import { showMenu, showColorPicker, showDialog, closeMenus, esc, IC, type MenuItem } from './ui';

export interface WordHost {
  docId(): string;
  title(): string;
  html(): string;
  setHtml(html: string): void;
  meta(): WordMeta;
  setMeta(m: WordMeta): void;
  toast(msg: string, kind?: 'info' | 'error' | 'success'): void;
  prepareImage(src: string, maxW: number, maxDisplay: number): Promise<{ dataUrl: string; w?: number; h?: number }>;
  fileToDataUrl(f: File): Promise<string>;
}

const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Segoe UI', 'Courier New', 'Consolas', 'Trebuchet MS', 'Garamond', 'Century Gothic', 'Roboto', 'Open Sans', 'PT Sans', 'PT Serif'];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div';

const PAGE_SIZES: Record<string, { w: number; h: number; label: string }> = {
  A4: { w: 11906, h: 16838, label: 'A4 (21 × 29,7 см)' },
  A5: { w: 8391, h: 11906, label: 'A5 (14,8 × 21 см)' },
  A3: { w: 16838, h: 23811, label: 'A3 (29,7 × 42 см)' },
  Letter: { w: 12240, h: 15840, label: 'Letter (21,6 × 27,9 см)' },
};
const MARGINS: Record<string, { top: number; right: number; bottom: number; left: number; label: string }> = {
  ru: { top: 1134, right: 850, bottom: 1134, left: 1701, label: 'Обычные (ГОСТ): 2 / 1,5 / 2 / 3 см' },
  normal: { top: 1440, right: 1440, bottom: 1440, left: 1440, label: 'Обычные: 2,54 см' },
  narrow: { top: 720, right: 720, bottom: 720, left: 720, label: 'Узкие: 1,27 см' },
  moderate: { top: 1440, right: 1080, bottom: 1440, left: 1080, label: 'Средние: 2,54 / 1,91 см' },
  wide: { top: 1440, right: 2880, bottom: 1440, left: 2880, label: 'Широкие: 2,54 / 5,08 см' },
};

/** Разрешённые теги и свойства при вставке из буфера (Word, сайты, Google Docs). */
const ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SUB', 'SUP', 'SPAN', 'A', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'COLGROUP', 'COL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'CODE', 'IMG', 'HR', 'MARK', 'FONT']);
const ALLOWED_CSS = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'font-size', 'font-family', 'text-align', 'line-height', 'margin-left', 'margin-top', 'margin-bottom', 'text-indent', 'vertical-align', 'width', 'height', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right'];

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Word кладёт в буфер условные комментарии и <o:p>
  const walk = (node: Element) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === Node.COMMENT_NODE) { ch.remove(); continue; }
      if (ch.nodeType !== Node.ELEMENT_NODE) continue;
      const el = ch as HTMLElement;
      const tag = el.tagName;
      if (/^(SCRIPT|STYLE|META|LINK|TITLE|XML|O:P|IFRAME|OBJECT|EMBED|svg)$/i.test(tag) || tag.includes(':')) { el.remove(); continue; }
      walk(el);
      if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
        const hasBlock = Array.from(el.children).some(c => /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR)$/.test(c.tagName));
        if (hasBlock) { el.replaceWith(...Array.from(el.childNodes)); continue; }
        const p = doc.createElement('p');
        p.innerHTML = el.innerHTML;
        if (el.getAttribute('style')) p.setAttribute('style', el.getAttribute('style')!);
        el.replaceWith(p);
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) { el.replaceWith(...Array.from(el.childNodes)); continue; }
      const keep: Record<string, string> = {};
      if (tag === 'A') { const h = el.getAttribute('href'); if (h && /^(https?:|mailto:|tel:|#)/i.test(h)) keep.href = h; }
      if (tag === 'IMG') { const s = el.getAttribute('src') ?? ''; if (/^(data:image\/(png|jpe?g|gif|webp);|https:)/i.test(s)) keep.src = s; else { el.remove(); continue; } }
      if (tag === 'TD' || tag === 'TH') { for (const a of ['colspan', 'rowspan']) { const v = el.getAttribute(a); if (v) keep[a] = v; } }
      if (tag === 'OL') { for (const a of ['type', 'start']) { const v = el.getAttribute(a); if (v) keep[a] = v; } }
      if (tag === 'FONT') { const c = el.getAttribute('color'), f = el.getAttribute('face'); if (c) keep.color = c; if (f) keep.face = f; }
      const st = el.style;
      const css: string[] = [];
      for (const p of ALLOWED_CSS) {
        const v = st.getPropertyValue(p);
        if (!v || /^(initial|inherit|normal|auto|windowtext)$/i.test(v) || /mso-/i.test(v)) continue;
        if (p === 'font-family') { css.push(`font-family:${v.split(',')[0].trim()}`); continue; }
        css.push(`${p}:${v}`);
      }
      for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
      for (const [k, v] of Object.entries(keep)) el.setAttribute(k, v);
      if (css.length) el.setAttribute('style', css.join(';'));
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/**
 * Страница показывает пробелы и табуляции как есть (white-space: pre-wrap —
 * так в Word). HTML от ассистента или старых документов бывает «красиво»
 * отформатирован переносами и отступами между тегами — они превратились бы
 * в пустые строки. Убираем такую разметочную пустоту.
 */
export function normalizeWhitespace(root: HTMLElement): void {
  const BLOCKS = /^(P|DIV|H[1-6]|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|BLOCKQUOTE|PRE|HR|COLGROUP|COL)$/;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const kill: Text[] = [];
  for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
    if (n.parentElement?.closest('pre')) continue;
    if (!/\n/.test(n.data)) continue;
    const prev = n.previousSibling as Element | null, next = n.nextSibling as Element | null;
    const parent = n.parentElement;
    const betweenBlocks = (!prev || BLOCKS.test(prev.nodeName)) || (!next || BLOCKS.test(next.nodeName)) || (parent && /^(UL|OL|TABLE|THEAD|TBODY|TR|COLGROUP)$/.test(parent.tagName)) || parent === root;
    if (!n.data.trim() && betweenBlocks) { kill.push(n); continue; }
    n.data = n.data.replace(/\s*\n\s*/g, ' ');
  }
  kill.forEach(n => n.remove());
}

export class WordEditor {
  private host: WordHost;
  private root: HTMLElement;
  private page!: HTMLElement;
  private wrap!: HTMLElement;
  private ribbon!: HTMLElement;
  private status!: HTMLElement;
  private tab = 'home';
  private undo: Array<{ html: string; caret: number }> = [];
  private redo: Array<{ html: string; caret: number }> = [];
  private snapTimer = 0;
  private saveTimer = 0;
  private zoom = 1;
  private painter: { css: string } | null = null;
  private savedRange: Range | null = null;
  private lastColor = '#c00000';
  private lastHilite = '#ffff00';
  private disposers: Array<() => void> = [];

  constructor(host: WordHost, root: HTMLElement) {
    this.host = host;
    this.root = root;
    this.mount();
  }

  destroy(): void {
    this.flush();
    this.disposers.forEach(d => d());
    closeMenus();
  }

  /** Сохранить незаписанное немедленно. */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = 0; this.host.setHtml(this.cleanHtml()); }
  }

  /** Обновить содержимое после внешней правки (ассистент, отмена). */
  refresh(): void {
    this.page.innerHTML = this.host.html() || '<p><br></p>';
    normalizeWhitespace(this.page);
    this.applyPage();
    this.updateStatus();
  }

  private meta(): Required<Pick<WordMeta, 'page' | 'font'>> {
    const m = this.host.meta() ?? {};
    return { page: { ...DEFAULT_PAGE, ...(m.page ?? {}) }, font: m.font ?? DEFAULT_FONT };
  }

  private mount(): void {
    this.root.innerHTML = `
      <div class="dw-app">
        <div class="dw-ribbon" data-ribbon></div>
        <div class="dw-scroll" data-scroll>
          <div class="dw-pagewrap" data-wrap>
            <div class="dw-page" contenteditable="true" spellcheck="true" data-page data-placeholder="Начните печатать…"></div>
          </div>
        </div>
        <div class="dw-statusbar" data-status></div>
      </div>`;
    this.ribbon = this.root.querySelector('[data-ribbon]')!;
    this.wrap = this.root.querySelector('[data-wrap]')!;
    this.page = this.root.querySelector('[data-page]')!;
    this.page.innerHTML = this.host.html() || '<p><br></p>';
    normalizeWhitespace(this.page);
    this.applyPage();
    this.renderRibbon();
    this.bind();
    this.pushUndo(true);
    this.updateStatus();
  }

  private applyPage(): void {
    const { page, font } = this.meta();
    const w = twipToPx(page.w), h = twipToPx(page.h);
    Object.assign(this.page.style, {
      width: w + 'px',
      minHeight: h + 'px',
      padding: `${twipToPx(page.top)}px ${twipToPx(page.right)}px ${twipToPx(page.bottom)}px ${twipToPx(page.left)}px`,
      fontFamily: `"${font.name}",Calibri,Arial,sans-serif`,
      fontSize: `${font.size}pt`,
    });
    this.page.style.setProperty('--pg-h', h + 'px');
    this.wrap.style.width = w + 'px';
    this.wrap.style.zoom = String(this.zoom);
  }

  // ═══════════════════════════ События ═══════════════════════════

  private bind(): void {
    const p = this.page;
    p.addEventListener('focus', () => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* старые браузеры */ } });
    p.addEventListener('input', () => this.changed());
    p.addEventListener('keydown', e => this.onKey(e));
    p.addEventListener('paste', e => this.onPaste(e));
    p.addEventListener('drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type.startsWith('image/')) { e.preventDefault(); this.host.fileToDataUrl(f).then(src => this.insertImage(src)); }
    });
    p.addEventListener('mouseup', () => { if (this.painter) this.applyPainter(); this.updateState(); });
    p.addEventListener('keyup', () => this.updateState());
    p.addEventListener('contextmenu', e => this.onContextMenu(e));
    p.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('a');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.getAttribute('href') ?? '', '_blank', 'noopener'); }
    });
    const sel = () => {
      const s = window.getSelection();
      if (s?.rangeCount && this.page.contains(s.anchorNode)) this.savedRange = s.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', sel);
    this.disposers.push(() => document.removeEventListener('selectionchange', sel));
  }

  private changed(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; this.host.setHtml(this.cleanHtml()); }, 400);
    clearTimeout(this.snapTimer);
    this.snapTimer = window.setTimeout(() => this.pushUndo(), 600);
    this.updateStatus();
  }

  /** HTML для хранения: без служебных отметок редактора. */
  private cleanHtml(): string {
    const h = this.page.innerHTML;
    return h === '<p><br></p>' ? '' : h;
  }

  /** Записать правку, сделанную напрямую в DOM. */
  private commit(): void {
    this.pushUndo();
    clearTimeout(this.saveTimer); this.saveTimer = 0;
    this.host.setHtml(this.cleanHtml());
    this.updateStatus();
    this.updateState();
  }

  // ── Отмена ────────────────────────────────────────────────────────────

  private caretOffset(): number {
    const s = window.getSelection();
    if (!s?.rangeCount || !this.page.contains(s.anchorNode)) return -1;
    const r = s.getRangeAt(0).cloneRange();
    r.selectNodeContents(this.page);
    r.setEnd(s.anchorNode!, s.anchorOffset);
    return r.toString().length;
  }

  private setCaret(offset: number): void {
    if (offset < 0) return;
    const tw = document.createTreeWalker(this.page, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const len = (n.textContent ?? '').length;
      if (left <= len) {
        const r = document.createRange(); r.setStart(n, left); r.collapse(true);
        const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        return;
      }
      left -= len;
    }
  }

  private pushUndo(initial = false): void {
    clearTimeout(this.snapTimer);
    const html = this.page.innerHTML;
    const last = this.undo[this.undo.length - 1];
    if (last && last.html === html) return;
    this.undo.push({ html, caret: initial ? 0 : this.caretOffset() });
    if (this.undo.length > 150) this.undo.shift();
    if (!initial) this.redo = [];
    this.updateUndoButtons();
  }

  doUndo(): void {
    this.pushUndo();
    if (this.undo.length < 2) return;
    const cur = this.undo.pop()!;
    this.redo.push(cur);
    const prev = this.undo[this.undo.length - 1];
    this.page.innerHTML = prev.html;
    this.setCaret(prev.caret);
    this.host.setHtml(this.cleanHtml());
    this.updateStatus(); this.updateUndoButtons();
  }

  doRedo(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(next);
    this.page.innerHTML = next.html;
    this.setCaret(next.caret);
    this.host.setHtml(this.cleanHtml());
    this.updateStatus(); this.updateUndoButtons();
  }

  private updateUndoButtons(): void {
    const u = this.ribbon.querySelector<HTMLButtonElement>('[data-act="undo"]');
    const r = this.ribbon.querySelector<HTMLButtonElement>('[data-act="redo"]');
    if (u) u.disabled = this.undo.length < 2 && !this.snapTimer;
    if (r) r.disabled = !this.redo.length;
  }

  // ── Клавиатура ────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && (k === 'z' || k === 'я') && !e.shiftKey) { e.preventDefault(); this.doUndo(); return; }
    if (mod && (k === 'y' || k === 'н' || ((k === 'z' || k === 'я') && e.shiftKey))) { e.preventDefault(); this.doRedo(); return; }
    if (mod && (k === 'b' || k === 'и')) { e.preventDefault(); this.exec('bold'); return; }
    if (mod && (k === 'i' || k === 'ш')) { e.preventDefault(); this.exec('italic'); return; }
    if (mod && (k === 'u' || k === 'г')) { e.preventDefault(); this.exec('underline'); return; }
    if (mod && (k === 'k' || k === 'л')) { e.preventDefault(); this.insertLink(); return; }
    if (mod && (k === 'f' || k === 'а')) { e.preventDefault(); this.openFind(false); return; }
    if (mod && (k === 'h' || k === 'р')) { e.preventDefault(); this.openFind(true); return; }
    if (mod && (k === 'e' || k === 'у')) { e.preventDefault(); this.exec('justifyCenter'); return; }
    if (mod && (k === 'l' || k === 'д')) { e.preventDefault(); this.exec('justifyLeft'); return; }
    if (mod && (k === 'r' || k === 'к')) { e.preventDefault(); this.exec('justifyRight'); return; }
    if (mod && (k === 'j' || k === 'о')) { e.preventDefault(); this.exec('justifyFull'); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.insertPageBreak(); return; }
    if (mod && e.key === ']') { e.preventDefault(); this.stepSize(1); return; }
    if (mod && e.key === '[') { e.preventDefault(); this.stepSize(-1); return; }
    if (e.key === 'Tab') {
      const cell = this.currentCell();
      if (cell) { e.preventDefault(); this.moveCell(cell, e.shiftKey ? -1 : 1); return; }
      const li = this.currentBlock()?.closest('li');
      if (li) { e.preventDefault(); this.exec(e.shiftKey ? 'outdent' : 'indent'); return; }
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
      return;
    }
    if (/^(Enter|Backspace|Delete| |\.|,)$/.test(e.key)) this.pushUndoSoon();
  }

  private pushUndoSoon(): void { setTimeout(() => this.pushUndo(), 0); }

  private onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    if (!dt) return;
    const file = Array.from(dt.items).find(it => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
    if (file) { e.preventDefault(); this.host.fileToDataUrl(file).then(src => this.insertImage(src)); return; }
    const html = dt.getData('text/html');
    e.preventDefault();
    this.pushUndo();
    if (html && !(this as { plainPaste?: boolean }).plainPaste) {
      document.execCommand('insertHTML', false, sanitizeHtml(html));
    } else {
      const text = dt.getData('text/plain');
      const parts = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
      if (parts.length > 1) document.execCommand('insertHTML', false, parts.map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''));
      else document.execCommand('insertText', false, text);
    }
    this.commit();
  }

  // ═══════════════════════════ Команды ═══════════════════════════

  private restoreSelection(): void {
    const s = window.getSelection();
    if (s && s.rangeCount && this.page.contains(s.anchorNode)) return;
    this.page.focus({ preventScroll: true });
    if (this.savedRange) { s?.removeAllRanges(); s?.addRange(this.savedRange); }
  }

  exec(cmd: string, val?: string): void {
    this.restoreSelection();
    this.pushUndo();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, val);
    this.commit();
  }

  /** Обернуть выделение в span со стилем (размер шрифта и т.п.). */
  private styleSelection(css: Record<string, string>): void {
    this.restoreSelection();
    this.pushUndo();
    document.execCommand('styleWithCSS', false, 'true');
    // fontSize=7 помечает выделение, затем заменяем на свои значения
    document.execCommand('fontSize', false, '7');
    this.page.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"], span[style*="-webkit-xxx-large"]').forEach(el => {
      const span = document.createElement('span');
      const prev = el.getAttribute('style')?.replace(/font-size:[^;]+;?/g, '') ?? '';
      span.setAttribute('style', prev);
      for (const [k, v] of Object.entries(css)) span.style.setProperty(k, v);
      span.innerHTML = el.innerHTML;
      el.replaceWith(span);
    });
    // Вложенные размеры внутри нового span больше не нужны
    if (css['font-size']) this.page.querySelectorAll<HTMLElement>('span[style] span[style*="font-size"]').forEach(inner => {
      const outer = inner.parentElement?.closest('span[style*="font-size"]') as HTMLElement | null;
      if (outer && outer.style.fontSize === css['font-size']) inner.style.removeProperty('font-size');
    });
    this.commit();
  }

  private stepSize(dir: 1 | -1): void {
    const cur = this.currentFontSize() ?? this.meta().font.size;
    const next = dir > 0 ? SIZES.find(s => s > cur) ?? cur + 2 : [...SIZES].reverse().find(s => s < cur) ?? Math.max(1, cur - 1);
    this.styleSelection({ 'font-size': `${next}pt` });
  }

  private currentFontSize(): number | null {
    const node = window.getSelection()?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    if (!el || !this.page.contains(el)) return null;
    const px = parseFloat(getComputedStyle(el).fontSize);
    return px ? Math.round(px * 0.75 * 2) / 2 : null;
  }

  /** Блоки (абзацы), задетые выделением. */
  private selectedBlocks(): HTMLElement[] {
    const s = window.getSelection();
    if (!s?.rangeCount) return [];
    const r = s.getRangeAt(0);
    const out: HTMLElement[] = [];
    const all = Array.from(this.page.querySelectorAll<HTMLElement>(BLOCK_SEL)).filter(b => !b.querySelector(BLOCK_SEL) || b.tagName === 'LI');
    for (const b of all) if (r.intersectsNode(b)) out.push(b);
    if (!out.length) { const b = this.currentBlock(); if (b) out.push(b); }
    return out;
  }

  private currentBlock(): HTMLElement | null {
    const node = window.getSelection()?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    const b = el?.closest<HTMLElement>(BLOCK_SEL) ?? null;
    return b && this.page.contains(b) && b !== this.page ? b : null;
  }

  private currentCell(): HTMLTableCellElement | null {
    const node = window.getSelection()?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    const td = el?.closest<HTMLTableCellElement>('td,th') ?? null;
    return td && this.page.contains(td) ? td : null;
  }

  private setBlockStyle(css: Record<string, string | null>): void {
    this.restoreSelection();
    this.pushUndo();
    for (const b of this.selectedBlocks()) for (const [k, v] of Object.entries(css)) { if (v === null) b.style.removeProperty(k); else b.style.setProperty(k, v); }
    this.commit();
  }

  /** Отступ абзаца (для списков — уровень списка). */
  private indent(dir: 1 | -1): void {
    const blocks = this.selectedBlocks();
    if (blocks.some(b => b.tagName === 'LI')) { this.exec(dir > 0 ? 'indent' : 'outdent'); return; }
    this.pushUndo();
    for (const b of blocks) {
      const cur = parseFloat(b.style.marginLeft) || 0;
      const pt = b.style.marginLeft.endsWith('px') ? cur * 0.75 : cur;
      const next = Math.max(0, pt + dir * 36);
      if (next) b.style.marginLeft = `${next}pt`; else b.style.removeProperty('margin-left');
    }
    this.commit();
  }

  private setParaStyle(kind: string): void {
    this.restoreSelection();
    this.pushUndo();
    const map: Record<string, string> = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', title: 'h1', quote: 'blockquote', code: 'pre', nospace: 'p' };
    document.execCommand('formatBlock', false, map[kind] ?? 'p');
    for (const b of this.selectedBlocks()) {
      b.classList.toggle('doc-title', kind === 'title');
      if (!b.classList.length) b.removeAttribute('class');
      if (kind === 'nospace') { b.style.marginBottom = '0pt'; b.style.lineHeight = '1'; }
    }
    this.commit();
  }

  private insertHtml(html: string): void {
    this.restoreSelection();
    this.pushUndo();
    document.execCommand('insertHTML', false, html);
    this.commit();
  }

  private insertPageBreak(): void { this.insertHtml('<hr class="dw-pb"><p><br></p>'); }

  private insertLink(): void {
    this.restoreSelection();
    const range = this.savedRange?.cloneRange();
    const text = range?.toString() ?? '';
    const a = (window.getSelection()?.anchorNode?.parentElement)?.closest('a');
    showDialog({
      title: 'Гиперссылка',
      body: `<label class="xd-field"><span>Текст</span><input class="xd-inp" data-text value="${esc(a?.textContent ?? text)}"></label>
        <label class="xd-field"><span>Адрес</span><input class="xd-inp" data-url value="${esc(a?.getAttribute('href') ?? 'https://')}"></label>`,
      okLabel: 'Вставить',
      onOk: root => {
        const t = root.querySelector<HTMLInputElement>('[data-text]')!.value;
        const url = root.querySelector<HTMLInputElement>('[data-url]')!.value.trim();
        if (!url || url === 'https://') return;
        this.page.focus();
        const s = window.getSelection();
        if (range) { s?.removeAllRanges(); s?.addRange(range); }
        this.pushUndo();
        if (a) { a.setAttribute('href', url); a.textContent = t || url; }
        else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(t || url)}</a>`);
        this.commit();
      },
    });
  }

  async insertImage(src: string): Promise<void> {
    try {
      const textW = twipToPx(this.meta().page.w - this.meta().page.left - this.meta().page.right);
      const pic = await this.host.prepareImage(src, 1600, Math.min(textW, 600));
      const size = pic.w && pic.h ? ` style="width:${pic.w}px;height:${pic.h}px"` : '';
      this.insertHtml(`<img src="${esc(pic.dataUrl)}" alt=""${size}>`);
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : 'Не удалось вставить картинку', 'error');
    }
  }

  private pickImage(): void {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', async () => { const f = inp.files?.[0]; if (f) this.insertImage(await this.host.fileToDataUrl(f)); });
    inp.click();
  }

  // ── Таблицы ───────────────────────────────────────────────────────────

  insertTable(rows: number, cols: number): void {
    const textW = twipToPx(this.meta().page.w - this.meta().page.left - this.meta().page.right);
    const cw = Math.floor(textW / cols);
    const html = `<table style="width:${cw * cols}px"><colgroup>${Array.from({ length: cols }, () => `<col style="width:${cw}px">`).join('')}</colgroup>`
      + Array.from({ length: rows }, () => `<tr>${Array.from({ length: cols }, () => '<td><br></td>').join('')}</tr>`).join('') + '</table><p><br></p>';
    this.insertHtml(html);
  }

  private moveCell(td: HTMLTableCellElement, dir: 1 | -1): void {
    const table = td.closest('table')!;
    const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th'));
    let i = cells.indexOf(td) + dir;
    if (i >= cells.length) { this.tableOp('rowBelow'); i = cells.length; }
    const next = Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th'))[Math.max(0, i)];
    if (!next) return;
    const r = document.createRange(); r.selectNodeContents(next);
    const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
  }

  tableOp(op: 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'delRow' | 'delCol' | 'delTable' | 'borders' | 'fill'): void {
    const td = this.currentCell();
    if (!td) { this.host.toast('Поставьте курсор в ячейку таблицы', 'info'); return; }
    const tr = td.parentElement as HTMLTableRowElement;
    const table = td.closest('table') as HTMLTableElement;
    this.pushUndo();
    const ci = Array.from(tr.children).indexOf(td);
    switch (op) {
      case 'rowAbove': case 'rowBelow': {
        const nr = document.createElement('tr');
        for (const c of Array.from(tr.children)) { const n = document.createElement(c.tagName.toLowerCase()); n.innerHTML = '<br>'; if ((c as HTMLElement).style.cssText) n.setAttribute('style', (c as HTMLElement).style.cssText); if ((c as HTMLTableCellElement).colSpan > 1) n.setAttribute('colspan', String((c as HTMLTableCellElement).colSpan)); nr.appendChild(n); }
        tr.parentElement!.insertBefore(nr, op === 'rowAbove' ? tr : tr.nextSibling);
        break;
      }
      case 'colLeft': case 'colRight':
        for (const row of Array.from(table.rows)) {
          const ref = row.children[Math.min(ci, row.children.length - 1)];
          const n = document.createElement(ref?.tagName.toLowerCase() === 'th' ? 'th' : 'td'); n.innerHTML = '<br>';
          if (ref) row.insertBefore(n, op === 'colLeft' ? ref : ref.nextSibling); else row.appendChild(n);
        }
        table.querySelector('colgroup')?.remove();
        break;
      case 'delRow': if (table.rows.length > 1) tr.remove(); else table.remove(); break;
      case 'delCol':
        if (tr.children.length <= 1) { table.remove(); break; }
        for (const row of Array.from(table.rows)) row.children[Math.min(ci, row.children.length - 1)]?.remove();
        table.querySelector('colgroup')?.remove();
        break;
      case 'delTable': table.remove(); break;
      case 'borders': table.classList.toggle('dw-noborder'); if (!table.classList.length) table.removeAttribute('class'); break;
      case 'fill': {
        showColorPicker(this.ribbon.querySelector('[data-act="t:fill"]') ?? td, { noneLabel: 'Нет заливки', onPick: hex => {
          this.pushUndo();
          const cells = this.selectedCells(table) ;
          (cells.length ? cells : [td]).forEach(c => { if (hex) c.style.backgroundColor = hex; else c.style.removeProperty('background-color'); });
          this.commit();
        } });
        return;
      }
    }
    this.commit();
  }

  private selectedCells(table: HTMLTableElement): HTMLTableCellElement[] {
    const s = window.getSelection();
    if (!s?.rangeCount) return [];
    const r = s.getRangeAt(0);
    return Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th')).filter(c => r.intersectsNode(c));
  }

  // ── Формат по образцу ─────────────────────────────────────────────────

  private startPainter(): void {
    const node = window.getSelection()?.anchorNode;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    if (!el || !this.page.contains(el)) return;
    const cs = getComputedStyle(el);
    const css = [
      `font-family:${cs.fontFamily.split(',')[0]}`, `font-size:${Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2}pt`,
      `font-weight:${+cs.fontWeight >= 600 ? 'bold' : 'normal'}`, `font-style:${cs.fontStyle}`,
      `text-decoration:${cs.textDecorationLine}`, `color:${cs.color}`,
      ...(cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ? [`background-color:${cs.backgroundColor}`] : []),
    ].join(';');
    this.painter = { css };
    this.updateState();
    this.host.toast('Выделите текст, к которому применить формат', 'info');
  }

  private applyPainter(): void {
    const p = this.painter;
    const s = window.getSelection();
    if (!p || !s?.rangeCount || s.isCollapsed) return;
    this.painter = null;
    const css: Record<string, string> = {};
    for (const part of p.css.split(';')) { const i = part.indexOf(':'); if (i > 0) css[part.slice(0, i)] = part.slice(i + 1); }
    this.styleSelection(css);
  }

  // ── Поиск ─────────────────────────────────────────────────────────────

  openFind(replace: boolean): void {
    showDialog({
      title: replace ? 'Найти и заменить' : 'Найти',
      body: `<label class="xd-field"><span>Найти</span><input class="xd-inp" data-q></label>
        <label class="xd-field"><span>Заменить на</span><input class="xd-inp" data-r></label>
        <label class="xd-check"><input type="checkbox" data-case> Учитывать регистр</label>
        <div class="xd-row"><button class="xd-btn" data-next>Найти далее</button><button class="xd-btn" data-one>Заменить</button><button class="xd-btn" data-all>Заменить все</button></div>
        <div class="xd-found" data-found></div>`,
      onMount: root => {
        const q = root.querySelector<HTMLInputElement>('[data-q]')!;
        const rep = root.querySelector<HTMLInputElement>('[data-r]')!;
        const cs = root.querySelector<HTMLInputElement>('[data-case]')!;
        const found = root.querySelector<HTMLElement>('[data-found]')!;
        const sel = window.getSelection()?.toString();
        if (sel && sel.length < 80) q.value = sel;
        let lastNode: Text | null = null, lastIdx = -1;
        const matches = (): Array<{ node: Text; idx: number }> => {
          const needle = cs.checked ? q.value : q.value.toLowerCase();
          if (!needle) return [];
          const out: Array<{ node: Text; idx: number }> = [];
          const tw = document.createTreeWalker(this.page, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
            const hay = cs.checked ? n.data : n.data.toLowerCase();
            let i = hay.indexOf(needle);
            while (i >= 0) { out.push({ node: n, idx: i }); i = hay.indexOf(needle, i + needle.length); }
          }
          return out;
        };
        const select = (m: { node: Text; idx: number }) => {
          const r = document.createRange(); r.setStart(m.node, m.idx); r.setEnd(m.node, m.idx + q.value.length);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
          m.node.parentElement?.scrollIntoView?.({ block: 'center' });
          lastNode = m.node; lastIdx = m.idx;
        };
        root.querySelector('[data-next]')!.addEventListener('click', () => {
          const all = matches();
          if (!all.length) { found.innerHTML = '<div class="xd-found-head">Ничего не найдено</div>'; return; }
          let i = all.findIndex(m => m.node === lastNode && m.idx > lastIdx);
          if (i < 0) { const pos = lastNode ? all.findIndex(m => (lastNode!.compareDocumentPosition(m.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : 0; i = pos < 0 ? 0 : pos; }
          select(all[i]);
          found.innerHTML = `<div class="xd-found-head">${i + 1} из ${all.length}</div>`;
        });
        root.querySelector('[data-one]')!.addEventListener('click', () => {
          const s = window.getSelection();
          if (s?.rangeCount && s.toString().toLowerCase() === q.value.toLowerCase() && this.page.contains(s.anchorNode)) {
            this.pushUndo();
            const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(rep.value));
            this.commit();
          }
          (root.querySelector('[data-next]') as HTMLElement).click();
        });
        root.querySelector('[data-all]')!.addEventListener('click', () => {
          const all = matches();
          if (!all.length) { found.innerHTML = '<div class="xd-found-head">Ничего не найдено</div>'; return; }
          this.pushUndo();
          // С конца, чтобы индексы в одном узле не сбивались
          for (const m of all.reverse()) m.node.data = m.node.data.slice(0, m.idx) + rep.value + m.node.data.slice(m.idx + q.value.length);
          this.commit();
          found.innerHTML = `<div class="xd-found-head">Выполнено замен: ${all.length}</div>`;
        });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); (root.querySelector('[data-next]') as HTMLElement).click(); } });
        if (!replace) { (rep.parentElement as HTMLElement).style.display = 'none'; (root.querySelector('[data-one]') as HTMLElement).style.display = 'none'; (root.querySelector('[data-all]') as HTMLElement).style.display = 'none'; }
      },
    });
  }

  // ── Макет страницы ────────────────────────────────────────────────────

  private setPage(patch: Partial<NonNullable<WordMeta['page']>>): void {
    const m = this.host.meta() ?? {};
    const page = { ...DEFAULT_PAGE, ...(m.page ?? {}), ...patch };
    this.host.setMeta({ ...m, page });
    this.applyPage();
    this.updateStatus();
  }

  private customMargins(): void {
    const pg = this.meta().page;
    const cm = (t: number) => (t / 567).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
    showDialog({
      title: 'Поля страницы (см)',
      body: `<div class="xd-row">${(['top', 'bottom', 'left', 'right'] as const).map(k => `<label class="xd-field"><span>${{ top: 'Верхнее', bottom: 'Нижнее', left: 'Левое', right: 'Правое' }[k]}</span><input class="xd-inp" data-m="${k}" value="${cm(pg[k])}"></label>`).join('')}</div>`,
      onOk: root => {
        const patch: Record<string, number> = {};
        root.querySelectorAll<HTMLInputElement>('[data-m]').forEach(i => { const v = parseFloat(i.value.replace(',', '.')); if (isFinite(v) && v >= 0) patch[i.dataset.m!] = Math.round(v * 567); });
        this.setPage(patch);
      },
    });
  }

  private docFontDialog(): void {
    const f = this.meta().font;
    showDialog({
      title: 'Шрифт документа по умолчанию',
      body: `<label class="xd-field"><span>Шрифт</span><select class="xd-inp" data-f>${FONTS.map(x => `<option${x === f.name ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="xd-field"><span>Размер, пт</span><input class="xd-inp" type="number" min="6" max="72" step="0.5" data-s value="${f.size}"></label>`,
      onOk: root => {
        const name = root.querySelector<HTMLSelectElement>('[data-f]')!.value;
        const size = parseFloat(root.querySelector<HTMLInputElement>('[data-s]')!.value) || f.size;
        const m = this.host.meta() ?? {};
        this.host.setMeta({ ...m, font: { name, size } });
        this.applyPage();
      },
    });
  }

  // ═══════════════════════════ Лента ═══════════════════════════

  private renderRibbon(): void {
    const B = (act: string, icon: string, title: string) => `<button class="xr-btn" data-act="${act}" title="${esc(title)}">${icon}</button>`;
    const BL = (act: string, icon: string, label: string, title = label) => `<button class="xr-btn xr-lbl" data-act="${act}" title="${esc(title)}">${icon}<span>${esc(label)}</span></button>`;
    const DD = (act: string, icon: string, title: string, label = '') => `<button class="xr-btn xr-dd${label ? ' xr-lbl' : ''}" data-dd="${act}" title="${esc(title)}">${icon}${label ? `<span>${esc(label)}</span>` : ''}${IC.chevron}</button>`;
    const SPLIT = (act: string, icon: string, title: string, bar = '') => `<span class="xr-split"><button class="xr-btn" data-act="${act}" title="${esc(title)}">${icon}${bar}</button><button class="xr-btn xr-arrow" data-dd="${act}" title="${esc(title)}">${IC.chevron}</button></span>`;
    const G = (label: string, inner: string) => `<div class="xr-group"><div class="xr-items">${inner}</div><div class="xr-glabel">${label}</div></div>`;
    const tabs: Array<[string, string]> = [['home', 'Главная'], ['insert', 'Вставка'], ['layout', 'Макет'], ['table', 'Таблица']];
    const W = {
      bullets: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="3" cy="4" r="1.1" fill="currentColor"/><circle cx="3" cy="8" r="1.1" fill="currentColor"/><circle cx="3" cy="12" r="1.1" fill="currentColor"/><path d="M6 4h8M6 8h8M6 12h8"/></svg>',
      numbers: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><text x="0.5" y="5.5" font-size="5" fill="currentColor" stroke="none">1</text><text x="0.5" y="9.5" font-size="5" fill="currentColor" stroke="none">2</text><text x="0.5" y="13.5" font-size="5" fill="currentColor" stroke="none">3</text><path d="M6 4h8M6 8h8M6 12h8"/></svg>',
      justify: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11"/></svg>',
      spacing: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 4h7M7 8h7M7 12h7M3 2.5v11M1.5 4L3 2.5 4.5 4M1.5 12L3 13.5 4.5 12"/></svg>',
      sup: '<span style="font:600 12px Arial">x<sup style="font-size:8px">2</sup></span>',
      sub: '<span style="font:600 12px Arial">x<sub style="font-size:8px">2</sub></span>',
      hilite: '<span style="font:700 12px Arial;background:#ff0;padding:0 2px;color:#000">ab</span>',
      pb: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 1.5v4h10v-4M3 14.5v-4h10v4"/><path d="M1 8h2M5 8h2M9 8h2M13 8h2" /></svg>',
      hr: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 8h13"/></svg>',
      margins: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="1.5" width="11" height="13" rx="1"/><rect x="5" y="4" width="6" height="8" stroke-dasharray="1 1"/></svg>',
      orient: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="4.5" width="12" height="8" rx="1"/><rect x="5" y="1.5" width="6" height="12" rx="1" stroke-dasharray="1 1"/></svg>',
      size: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.5" y="1.5" width="9" height="13" rx="1"/><path d="M6 5h4M6 8h4"/></svg>',
      font: '<span style="font:600 13px Georgia">Aa</span>',
      date: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="3" width="13" height="11" rx="1.5"/><path d="M1.5 6.5h13M5 1.5v3M11 1.5v3"/></svg>',
    };
    let panel = '';
    switch (this.tab) {
      case 'home':
        panel =
          G('Буфер обмена', `${DD('paste', IC.paste, 'Вставить', 'Вставить')}<div class="xr-col">${B('cut', IC.cut, 'Вырезать (Ctrl+X)')}${B('copy', IC.copy, 'Копировать (Ctrl+C)')}${B('painter', IC.painter, 'Формат по образцу')}</div>`) +
          G('Шрифт', `<div class="xr-col2"><div class="xr-row"><select class="xr-sel xr-font" data-sel="font" title="Шрифт">${FONTS.map(f => `<option value="${f}">${f}</option>`).join('')}</select>
            <select class="xr-sel xr-size" data-sel="size" title="Размер">${SIZES.map(s => `<option value="${s}">${String(s).replace('.', ',')}</option>`).join('')}</select>${B('grow', IC.growFont, 'Увеличить размер (Ctrl+])')}${B('shrink', IC.shrinkFont, 'Уменьшить размер (Ctrl+[)')}${B('clearfmt', IC.clear, 'Очистить форматирование')}</div>
            <div class="xr-row">${B('bold', IC.bold, 'Полужирный (Ctrl+B)')}${B('italic', IC.italic, 'Курсив (Ctrl+I)')}${B('underline', IC.underline, 'Подчёркнутый (Ctrl+U)')}${B('strikeThrough', IC.strike, 'Зачёркнутый')}${B('subscript', W.sub, 'Подстрочный')}${B('superscript', W.sup, 'Надстрочный')}<span class="xr-sep"></span>
            ${SPLIT('hilite', W.hilite, 'Цвет выделения текста', `<i class="xr-bar" style="background:${this.lastHilite}"></i>`)}${SPLIT('color', IC.fontColor, 'Цвет текста', `<i class="xr-bar" style="background:${this.lastColor}"></i>`)}</div></div>`) +
          G('Абзац', `<div class="xr-col2"><div class="xr-row">${B('insertUnorderedList', W.bullets, 'Маркированный список')}${B('insertOrderedList', W.numbers, 'Нумерованный список')}${B('outdent', IC.indentDec, 'Уменьшить отступ')}${B('indent', IC.indentInc, 'Увеличить отступ')}</div>
            <div class="xr-row">${B('justifyLeft', IC.alLeft, 'По левому краю (Ctrl+L)')}${B('justifyCenter', IC.alCenter, 'По центру (Ctrl+E)')}${B('justifyRight', IC.alRight, 'По правому краю (Ctrl+R)')}${B('justifyFull', W.justify, 'По ширине (Ctrl+J)')}${DD('spacing', W.spacing, 'Интервал')}</div></div>`) +
          G('Стили', `<select class="xr-sel" data-sel="style" style="width:150px" title="Стиль абзаца"><option value="p">Обычный</option><option value="nospace">Без интервала</option><option value="title">Название</option><option value="h1">Заголовок 1</option><option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option><option value="h4">Заголовок 4</option><option value="quote">Цитата</option><option value="code">Код</option></select>`) +
          G('Редактирование', `<div class="xr-col">${BL('find', IC.find, 'Найти', 'Найти (Ctrl+F)')}</div><div class="xr-col">${BL('replace', IC.clear, 'Заменить', 'Заменить (Ctrl+H)')}</div>`);
        break;
      case 'insert':
        panel =
          G('Страницы', `${BL('pb', W.pb, 'Разрыв страницы', 'Разрыв страницы (Ctrl+Enter)')}${BL('hr', W.hr, 'Линия')}`) +
          G('Таблицы', DD('table', IC.table, 'Таблица', 'Таблица')) +
          G('Иллюстрации', BL('image', IC.image, 'Рисунок')) +
          G('Ссылки', BL('link', IC.link, 'Ссылка', 'Ссылка (Ctrl+K)')) +
          G('Текст', BL('date', W.date, 'Дата и время'));
        break;
      case 'layout':
        panel =
          G('Параметры страницы', `${DD('margins', W.margins, 'Поля', 'Поля')}${DD('orient', W.orient, 'Ориентация', 'Ориентация')}${DD('pgsize', W.size, 'Размер', 'Размер')}`) +
          G('Документ', BL('docfont', W.font, 'Шрифт документа'));
        break;
      case 'table':
        panel =
          G('Строки и столбцы', `${BL('t:rowAbove', IC.insRow, 'Вставить сверху')}${BL('t:rowBelow', IC.insRow, 'Вставить снизу')}${BL('t:colLeft', IC.insRow, 'Вставить слева')}${BL('t:colRight', IC.insRow, 'Вставить справа')}`) +
          G('Удаление', `${BL('t:delRow', IC.delRow, 'Удалить строку')}${BL('t:delCol', IC.delRow, 'Удалить столбец')}${BL('t:delTable', IC.delRow, 'Удалить таблицу')}`) +
          G('Оформление', `${BL('t:borders', IC.borders, 'Границы вкл/выкл')}${BL('t:fill', IC.fill, 'Заливка ячеек')}`);
        break;
    }
    this.ribbon.innerHTML = `<div class="xr-tabs">${tabs.map(([k, n]) => `<span class="xr-tab${k === this.tab ? ' on' : ''}" data-tab="${k}">${n}</span>`).join('')}
      <span class="xr-tabs-right">${B('undo', IC.undo, 'Отменить (Ctrl+Z)')}${B('redo', IC.redo, 'Вернуть (Ctrl+Y)')}</span></div><div class="xr-panel">${panel}</div>`;
    this.bindRibbon();
    const f = this.meta().font;
    const fs = this.ribbon.querySelector<HTMLSelectElement>('[data-sel="font"]');
    if (fs) { if (![...fs.options].some(o => o.value === f.name)) fs.insertAdjacentHTML('afterbegin', `<option value="${esc(f.name)}">${esc(f.name)}</option>`); fs.value = f.name; }
    const ss = this.ribbon.querySelector<HTMLSelectElement>('[data-sel="size"]');
    if (ss) { const v = String(f.size); if (![...ss.options].some(o => o.value === v)) ss.insertAdjacentHTML('afterbegin', `<option value="${v}">${v}</option>`); ss.value = v; }
    this.updateState();
    this.updateUndoButtons();
  }

  private bindRibbon(): void {
    const R = this.ribbon;
    R.addEventListener('mousedown', e => { if (!(e.target as HTMLElement).closest('select,input')) e.preventDefault(); });
    R.querySelectorAll<HTMLElement>('[data-tab]').forEach(t => t.addEventListener('click', () => { this.tab = t.dataset.tab!; this.renderRibbon(); }));
    R.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => this.action(b.dataset.act!, b)));
    R.querySelectorAll<HTMLElement>('[data-dd]').forEach(b => b.addEventListener('click', () => this.dropdown(b.dataset.dd!, b)));
    R.querySelectorAll<HTMLSelectElement>('[data-sel]').forEach(s => s.addEventListener('change', () => {
      if (s.dataset.sel === 'font') { this.exec('fontName', s.value); }
      else if (s.dataset.sel === 'size') this.styleSelection({ 'font-size': `${s.value}pt` });
      else if (s.dataset.sel === 'style') this.setParaStyle(s.value);
    }));
  }

  private action(act: string, btn: HTMLElement): void {
    if (act.startsWith('t:')) { this.restoreSelection(); this.tableOp(act.slice(2) as Parameters<WordEditor['tableOp']>[0]); return; }
    switch (act) {
      case 'undo': this.doUndo(); return;
      case 'redo': this.doRedo(); return;
      case 'cut': this.exec('cut'); return;
      case 'copy': this.restoreSelection(); document.execCommand('copy'); return;
      case 'painter': if (this.painter) { this.painter = null; this.updateState(); } else { this.restoreSelection(); this.startPainter(); } return;
      case 'grow': this.stepSize(1); return;
      case 'shrink': this.stepSize(-1); return;
      case 'clearfmt': this.exec('removeFormat'); this.setBlockStyle({ 'line-height': null, 'margin-left': null, 'text-indent': null, 'background-color': null }); return;
      case 'hilite': this.exec('hiliteColor', this.lastHilite); return;
      case 'color': this.exec('foreColor', this.lastColor); return;
      case 'indent': this.indent(1); return;
      case 'outdent': this.indent(-1); return;
      case 'find': this.openFind(false); return;
      case 'replace': this.openFind(true); return;
      case 'pb': this.insertPageBreak(); return;
      case 'hr': this.insertHtml('<hr><p><br></p>'); return;
      case 'image': this.pickImage(); return;
      case 'link': this.insertLink(); return;
      case 'date': { const d = new Date(); this.insertHtml(esc(d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }))); return; }
      case 'docfont': this.docFontDialog(); return;
      default: this.exec(act);
    }
    void btn;
  }

  private dropdown(act: string, btn: HTMLElement): void {
    switch (act) {
      case 'paste': showMenu([
        { label: 'Вставить', hint: 'Ctrl+V', action: () => this.host.toast('Нажмите Ctrl+V (⌘+V) — браузер не даёт вставлять кнопкой без разрешения', 'info') },
        { label: 'Вставить только текст', action: async () => {
          try { const t = await navigator.clipboard.readText(); this.restoreSelection(); this.pushUndo(); document.execCommand('insertText', false, t); this.commit(); }
          catch { this.host.toast('Нет доступа к буферу — нажмите Ctrl+Shift+V', 'info'); }
        } },
      ], btn); return;
      case 'hilite': showColorPicker(btn, { noneLabel: 'Нет цвета', onPick: hex => { if (hex) this.lastHilite = hex; this.exec('hiliteColor', hex ?? 'transparent'); this.renderRibbon(); } }); return;
      case 'color': showColorPicker(btn, { noneLabel: 'Авто', onPick: hex => { if (hex) this.lastColor = hex; this.exec('foreColor', hex ?? '#000000'); this.renderRibbon(); } }); return;
      case 'spacing': showMenu([
        ...['1', '1.08', '1.15', '1.5', '2', '2.5', '3'].map(v => ({ label: v.replace('.', ','), action: () => this.setBlockStyle({ 'line-height': v }) })),
        { sep: true },
        { label: 'Добавить интервал перед абзацем', action: () => this.setBlockStyle({ 'margin-top': '12pt' }) },
        { label: 'Удалить интервал перед абзацем', action: () => this.setBlockStyle({ 'margin-top': '0pt' }) },
        { label: 'Добавить интервал после абзаца', action: () => this.setBlockStyle({ 'margin-bottom': '8pt' }) },
        { label: 'Удалить интервал после абзаца', action: () => this.setBlockStyle({ 'margin-bottom': '0pt' }) },
        { sep: true },
        { label: 'Красная строка 1,25 см', action: () => this.setBlockStyle({ 'text-indent': '35.45pt' }) },
        { label: 'Без красной строки', action: () => this.setBlockStyle({ 'text-indent': null }) },
      ], btn); return;
      case 'table': {
        closeMenus();
        const pop = document.createElement('div');
        pop.className = 'xm-menu';
        pop.style.padding = '8px';
        pop.innerHTML = `<div style="font-size:12px;margin-bottom:6px" data-l>Таблица</div><div style="display:grid;grid-template-columns:repeat(10,16px);gap:2px" data-grid>${Array.from({ length: 80 }, (_, i) => `<div data-i="${i}" style="width:16px;height:16px;border:1px solid #c6c6c6;cursor:pointer"></div>`).join('')}</div>
          <div class="xm-sep"></div><div class="xm-item" data-custom>Вставить таблицу…</div>`;
        document.body.appendChild(pop);
        const r = btn.getBoundingClientRect();
        pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 2) + 'px';
        pop.addEventListener('mousedown', e => e.preventDefault());
        const cells = Array.from(pop.querySelectorAll<HTMLElement>('[data-i]'));
        pop.querySelector('[data-grid]')!.addEventListener('mousemove', e => {
          const i = +((e.target as HTMLElement).dataset.i ?? -1);
          if (i < 0) return;
          const rr = Math.floor(i / 10), cc = i % 10;
          cells.forEach((c, j) => { c.style.background = Math.floor(j / 10) <= rr && j % 10 <= cc ? '#cfdcf0' : ''; });
          pop.querySelector('[data-l]')!.textContent = `Таблица ${cc + 1}×${rr + 1}`;
        });
        pop.querySelector('[data-grid]')!.addEventListener('click', e => {
          const i = +((e.target as HTMLElement).dataset.i ?? -1);
          if (i < 0) return;
          pop.remove();
          this.insertTable(Math.floor(i / 10) + 1, (i % 10) + 1);
        });
        pop.querySelector('[data-custom]')!.addEventListener('click', () => {
          pop.remove();
          showDialog({
            title: 'Вставка таблицы',
            body: '<div class="xd-row"><label class="xd-field"><span>Столбцов</span><input class="xd-inp" type="number" min="1" max="63" value="3" data-c></label><label class="xd-field"><span>Строк</span><input class="xd-inp" type="number" min="1" max="500" value="3" data-r></label></div>',
            onOk: root => this.insertTable(Math.max(1, +root.querySelector<HTMLInputElement>('[data-r]')!.value || 1), Math.max(1, Math.min(63, +root.querySelector<HTMLInputElement>('[data-c]')!.value || 1))),
          });
        });
        setTimeout(() => {
          const away = (e: Event) => { if (!pop.contains(e.target as Node)) { pop.remove(); document.removeEventListener('mousedown', away, true); } };
          document.addEventListener('mousedown', away, true);
        }, 0);
        return;
      }
      case 'margins': showMenu([
        ...Object.values(MARGINS).map(m => ({ label: m.label, action: () => this.setPage({ top: m.top, right: m.right, bottom: m.bottom, left: m.left }) })),
        { sep: true }, { label: 'Настраиваемые поля…', action: () => this.customMargins() },
      ], btn); return;
      case 'orient': {
        const pg = this.meta().page;
        const land = pg.w > pg.h;
        showMenu([
          { label: 'Книжная', checked: !land, action: () => { if (land) this.setPage({ w: pg.h, h: pg.w, landscape: undefined }); } },
          { label: 'Альбомная', checked: land, action: () => { if (!land) this.setPage({ w: pg.h, h: pg.w, landscape: true }); } },
        ], btn); return;
      }
      case 'pgsize': {
        const pg = this.meta().page;
        const land = pg.w > pg.h;
        showMenu(Object.values(PAGE_SIZES).map(s => ({
          label: s.label, checked: Math.min(pg.w, pg.h) === s.w && Math.max(pg.w, pg.h) === s.h,
          action: () => this.setPage(land ? { w: s.h, h: s.w } : { w: s.w, h: s.h }),
        })) as MenuItem[], btn); return;
      }
    }
  }

  private updateState(): void {
    const on = (act: string, v: boolean) => this.ribbon.querySelectorAll(`[data-act="${act}"]`).forEach(b => b.classList.toggle('on', v));
    const q = (c: string) => { try { return document.queryCommandState(c); } catch { return false; } };
    if (document.activeElement === this.page || this.page.contains(window.getSelection()?.anchorNode ?? null)) {
      ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'].forEach(c => on(c, q(c)));
      const fs = this.ribbon.querySelector<HTMLSelectElement>('[data-sel="font"]');
      if (fs) {
        let name = '';
        try { name = String(document.queryCommandValue('fontName') ?? '').split(',')[0].replace(/['"]/g, '').trim(); } catch { /* ignore */ }
        if (name) { if (![...fs.options].some(o => o.value === name)) fs.insertAdjacentHTML('afterbegin', `<option value="${esc(name)}">${esc(name)}</option>`); fs.value = name; }
      }
      const ss = this.ribbon.querySelector<HTMLSelectElement>('[data-sel="size"]');
      const size = this.currentFontSize();
      if (ss && size) { const v = String(size); if (![...ss.options].some(o => o.value === v)) ss.insertAdjacentHTML('afterbegin', `<option value="${v}">${v.replace('.', ',')}</option>`); ss.value = v; }
      const st = this.ribbon.querySelector<HTMLSelectElement>('[data-sel="style"]');
      const b = this.currentBlock();
      if (st && b) {
        const t = b.tagName.toLowerCase();
        st.value = b.classList.contains('doc-title') ? 'title' : t === 'blockquote' ? 'quote' : t === 'pre' ? 'code' : /^h[1-4]$/.test(t) ? t : 'p';
      }
    }
    on('painter', !!this.painter);
    const inTable = !!this.currentCell();
    const tt = this.ribbon.querySelector<HTMLElement>('[data-tab="table"]');
    if (tt) tt.style.display = inTable || this.tab === 'table' ? '' : 'none';
  }

  private onContextMenu(e: MouseEvent): void {
    const td = (e.target as HTMLElement).closest('td,th');
    const a = (e.target as HTMLElement).closest('a');
    const items: MenuItem[] = [
      { label: 'Вырезать', icon: IC.cut, hint: 'Ctrl+X', action: () => this.exec('cut') },
      { label: 'Копировать', icon: IC.copy, hint: 'Ctrl+C', action: () => { this.restoreSelection(); document.execCommand('copy'); } },
      { sep: true },
      ...(td ? [
        { label: 'Вставить строку выше', action: () => this.tableOp('rowAbove') },
        { label: 'Вставить строку ниже', action: () => this.tableOp('rowBelow') },
        { label: 'Вставить столбец слева', action: () => this.tableOp('colLeft') },
        { label: 'Вставить столбец справа', action: () => this.tableOp('colRight') },
        { label: 'Удалить строку', danger: true, action: () => this.tableOp('delRow') },
        { label: 'Удалить столбец', danger: true, action: () => this.tableOp('delCol') },
        { label: 'Удалить таблицу', danger: true, action: () => this.tableOp('delTable') },
        { label: 'Границы вкл/выкл', action: () => this.tableOp('borders') },
        { sep: true },
      ] as MenuItem[] : []),
      ...(a ? [{ label: 'Открыть ссылку', action: () => window.open(a.getAttribute('href') ?? '', '_blank', 'noopener') }, { label: 'Удалить ссылку', action: () => { this.pushUndo(); a.replaceWith(...Array.from(a.childNodes)); this.commit(); } }] : [{ label: 'Ссылка…', icon: IC.link, action: () => this.insertLink() }]),
      { label: 'Абзац: интервал 1,5', action: () => this.setBlockStyle({ 'line-height': '1.5' }) },
      { label: 'Очистить форматирование', action: () => this.exec('removeFormat') },
    ];
    if (td || a) { e.preventDefault(); showMenu(items, { x: e.clientX, y: e.clientY }); }
  }

  private updateStatus(): void {
    if (!this.status) this.status = this.root.querySelector('[data-status]')!;
    const text = this.page.innerText.replace(/\s+/g, ' ').trim();
    const words = text ? text.split(' ').length : 0;
    const pgH = twipToPx(this.meta().page.h);
    const pages = Math.max(1, Math.ceil((this.page.scrollHeight - 2) / pgH));
    const z = Math.round(this.zoom * 100);
    this.status.innerHTML = `<span>Страниц: ${pages}</span><span>Слов: ${words}</span><span>Символов: ${text.length}</span>
      <span class="dw-st-right"><button data-z="-10">−</button><span>${z}%</span><button data-z="10">+</button></span>`;
    this.status.querySelectorAll<HTMLElement>('[data-z]').forEach(b => b.addEventListener('click', () => {
      this.zoom = Math.max(0.5, Math.min(2, Math.round((this.zoom + +b.dataset.z! / 100) * 10) / 10));
      this.applyPage(); this.updateStatus();
    }));
  }
}
