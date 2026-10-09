/**
 * Мелкие кирпичики интерфейса редактора: всплывающее меню, палитра цветов,
 * диалог. Всё рисуется в document.body и убирается за собой — раньше
 * выпадашки копились в DOM при каждом пересоздании редактора.
 */

export const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;          // сочетание клавиш справа
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  sep?: boolean;
  sub?: MenuItem[];
}

let openMenus: HTMLElement[] = [];

export function closeMenus(): void {
  openMenus.forEach(m => m.remove());
  openMenus = [];
}

/** Показать меню у точки (x,y) или под элементом. */
export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, opts: { keep?: boolean } = {}): HTMLElement {
  if (!opts.keep) closeMenus();
  const menu = document.createElement('div');
  menu.className = 'xm-menu';
  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="xm-sep"></div>';
    return `<div class="xm-item${it.danger ? ' xm-danger' : ''}${it.disabled ? ' xm-disabled' : ''}${it.sub ? ' xm-has-sub' : ''}" data-i="${i}">
      <span class="xm-ic">${it.checked ? '✓' : it.icon ?? ''}</span><span class="xm-lbl">${esc(it.label ?? '')}</span>
      ${it.hint ? `<span class="xm-hint">${esc(it.hint)}</span>` : ''}${it.sub ? '<span class="xm-arrow">›</span>' : ''}
    </div>`;
  }).join('');
  document.body.appendChild(menu);
  openMenus.push(menu);

  const r = at instanceof HTMLElement ? at.getBoundingClientRect() : null;
  const x = r ? r.left : (at as { x: number }).x;
  const y = r ? r.bottom + 2 : (at as { y: number }).y;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
  menu.style.top = Math.max(4, y + mh > window.innerHeight - 4 ? Math.max(4, (r ? r.top : y) - mh - 2) : y) + 'px';

  menu.addEventListener('mousedown', e => e.preventDefault());
  menu.querySelectorAll<HTMLElement>('.xm-item').forEach(el => {
    const it = items[+el.dataset.i!];
    if (it.sub) {
      el.addEventListener('mouseenter', () => {
        // закрыть другие подменю этого уровня
        const idx = openMenus.indexOf(menu);
        openMenus.slice(idx + 1).forEach(m => m.remove());
        openMenus = openMenus.slice(0, idx + 1);
        const rr = el.getBoundingClientRect();
        showMenu(it.sub!, { x: rr.right - 2, y: rr.top - 4 }, { keep: true });
      });
      return;
    }
    el.addEventListener('mouseenter', () => {
      const idx = openMenus.indexOf(menu);
      openMenus.slice(idx + 1).forEach(m => m.remove());
      openMenus = openMenus.slice(0, idx + 1);
    });
    el.addEventListener('click', () => {
      if (it.disabled) return;
      closeMenus();
      it.action?.();
    });
  });
  setTimeout(() => {
    const away = (e: Event) => {
      if (openMenus.some(m => m.contains(e.target as Node))) return;
      closeMenus();
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', escKey, true);
    };
    const escKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', escKey, true); }
    };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escKey, true);
  }, 0);
  return menu;
}

/** Цвета темы Office + стандартные — как в палитре Excel. */
const THEME_ROWS = [
  ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'],
  ['#f2f2f2', '#7f7f7f', '#d0cece', '#d6dce4', '#d9e2f3', '#fbe5d5', '#ededed', '#fff2cc', '#deebf6', '#e2efd9'],
  ['#d8d8d8', '#595959', '#aeabab', '#adb9ca', '#b4c6e7', '#f7cbac', '#dbdbdb', '#fee599', '#bdd7ee', '#c5e0b3'],
  ['#bfbfbf', '#3f3f3f', '#757070', '#8496b0', '#8eaadb', '#f4b183', '#c9c9c9', '#ffd965', '#9cc3e5', '#a8d08d'],
  ['#a5a5a5', '#262626', '#3a3838', '#323f4f', '#2f5496', '#c55a11', '#7b7b7b', '#bf9000', '#2e75b5', '#538135'],
  ['#7f7f7f', '#0c0c0c', '#171616', '#222a35', '#1f3864', '#833c0b', '#525252', '#7f6000', '#1e4e79', '#375623'],
];
const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];

/** Палитра цветов под кнопкой. onPick(null) — «нет цвета/авто». */
export function showColorPicker(anchor: HTMLElement, opts: { noneLabel: string; onPick: (hex: string | null) => void }): void {
  closeMenus();
  const pop = document.createElement('div');
  pop.className = 'xm-menu xm-colors';
  pop.innerHTML = `
    <div class="xm-color-none" data-none>${esc(opts.noneLabel)}</div>
    <div class="xm-color-title">Цвета темы</div>
    ${THEME_ROWS.map(row => `<div class="xm-color-row">${row.map(c => `<button class="xm-sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>`).join('')}
    <div class="xm-color-title">Стандартные цвета</div>
    <div class="xm-color-row">${STANDARD.map(c => `<button class="xm-sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
    <label class="xm-color-more">Другие цвета… <input type="color" value="#4472c4"></label>`;
  document.body.appendChild(pop);
  openMenus.push(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 4) + 'px';
  pop.style.top = (r.bottom + 2) + 'px';
  pop.addEventListener('mousedown', e => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault(); });
  pop.querySelector('[data-none]')!.addEventListener('click', () => { closeMenus(); opts.onPick(null); });
  pop.querySelectorAll<HTMLElement>('[data-c]').forEach(b => b.addEventListener('click', () => { closeMenus(); opts.onPick(b.dataset.c!); }));
  const inp = pop.querySelector<HTMLInputElement>('input[type=color]')!;
  inp.addEventListener('change', () => { closeMenus(); opts.onPick(inp.value); });
  setTimeout(() => {
    const away = (e: Event) => {
      if (pop.contains(e.target as Node)) return;
      closeMenus(); document.removeEventListener('mousedown', away, true);
    };
    document.addEventListener('mousedown', away, true);
  }, 0);
}

export interface DialogOpts {
  title: string;
  body: string;
  okLabel?: string;
  cancelLabel?: string;
  wide?: boolean;
  onOk?: (root: HTMLElement) => boolean | void;   // false — не закрывать
  onMount?: (root: HTMLElement, close: () => void) => void;
}

/** Модальный диалог в стиле Office. */
export function showDialog(o: DialogOpts): () => void {
  closeMenus();
  const back = document.createElement('div');
  back.className = 'xd-back';
  back.innerHTML = `<div class="xd-dlg${o.wide ? ' xd-wide' : ''}" role="dialog">
    <div class="xd-head"><span>${esc(o.title)}</span><button class="xd-x" data-x>✕</button></div>
    <div class="xd-body">${o.body}</div>
    <div class="xd-foot">
      ${o.onOk ? `<button class="xd-btn xd-primary" data-ok>${esc(o.okLabel ?? 'ОК')}</button>` : ''}
      <button class="xd-btn" data-x>${esc(o.cancelLabel ?? (o.onOk ? 'Отмена' : 'Закрыть'))}</button>
    </div></div>`;
  document.body.appendChild(back);
  const dlg = back.querySelector<HTMLElement>('.xd-dlg')!;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const ok = () => { if (o.onOk?.(dlg) === false) return; close(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && o.onOk && !(e.target as HTMLElement).matches('textarea')) { e.preventDefault(); e.stopPropagation(); ok(); }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  back.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', close));
  back.querySelector('[data-ok]')?.addEventListener('click', ok);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  o.onMount?.(dlg, close);
  setTimeout(() => dlg.querySelector<HTMLElement>('input,select,textarea')?.focus(), 0);
  return close;
}

/** Короткий запрос строки (замена prompt(), который блокирует вкладку). */
export function askText(title: string, label: string, value: string, onOk: (v: string) => void): void {
  showDialog({
    title,
    body: `<label class="xd-field"><span>${esc(label)}</span><input class="xd-inp" value="${esc(value)}"></label>`,
    onOk: root => {
      const v = root.querySelector<HTMLInputElement>('input')!.value;
      onOk(v);
    },
    onMount: root => { const i = root.querySelector<HTMLInputElement>('input'); setTimeout(() => i?.select(), 0); },
  });
}

/** SVG-иконки панели (16×16, обводка текущим цветом). */
const S = (d: string, extra = '') => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
export const IC = {
  undo: S('<path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5H10a3.5 3.5 0 010 7H7"/>'),
  redo: S('<path d="M10.5 3.5l3 3-3 3"/><path d="M13.5 6.5H6a3.5 3.5 0 000 7h3"/>'),
  paste: S('<rect x="3" y="3" width="10" height="11.5" rx="1.2"/><path d="M6 3V2h4v1"/><path d="M6 7h4M6 9.5h4M6 12h2.5"/>'),
  cut: S('<circle cx="4.5" cy="12" r="1.8"/><circle cx="11.5" cy="12" r="1.8"/><path d="M5.8 10.6L11 2.5M10.2 10.6L5 2.5"/>'),
  copy: S('<rect x="5" y="5" width="8.5" height="9" rx="1.2"/><path d="M3 11V3.2C3 2.5 3.5 2 4.2 2H10"/>'),
  painter: S('<rect x="3" y="2" width="9" height="4" rx="1"/><path d="M12 4h1.5v3.5H8V10"/><rect x="7" y="10" width="2" height="4.5" rx=".6"/>'),
  bold: '<b style="font:700 14px Georgia,serif">Ж</b>',
  italic: '<i style="font:italic 600 14px Georgia,serif">К</i>',
  underline: '<u style="font:600 14px Georgia,serif">Ч</u>',
  strike: '<s style="font:600 13px Georgia,serif">abc</s>',
  growFont: '<span style="font:600 13px Arial">A<sup style="font-size:9px">▲</sup></span>',
  shrinkFont: '<span style="font:600 11px Arial">A<sup style="font-size:8px">▼</sup></span>',
  borders: S('<rect x="2.5" y="2.5" width="11" height="11"/><path d="M8 2.5v11M2.5 8h11" stroke-dasharray="1 1.5"/>'),
  fill: S('<path d="M3 8.5L8 3.5l5 5-4.2 4.2a1 1 0 01-1.4 0L3 8.5z"/><path d="M5.5 1.8L8 3.5"/><path d="M13.5 10.5s1.2 1.5 1.2 2.3a1.2 1.2 0 01-2.4 0c0-.8 1.2-2.3 1.2-2.3z" fill="currentColor"/>'),
  fontColor: '<span style="font:700 14px Georgia,serif;line-height:1">A</span>',
  alTop: S('<path d="M2.5 2.5h11"/><path d="M8 13.5V5M5.5 7.5L8 5l2.5 2.5"/>'),
  alMid: S('<path d="M2.5 8h11"/><path d="M8 2v4M6.5 4.5L8 6l1.5-1.5M8 14v-4M6.5 11.5L8 10l1.5 1.5"/>'),
  alBot: S('<path d="M2.5 13.5h11"/><path d="M8 2.5V11M5.5 8.5L8 11l2.5-2.5"/>'),
  alLeft: S('<path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7"/>'),
  alCenter: S('<path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7"/>'),
  alRight: S('<path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7"/>'),
  wrap: S('<path d="M2.5 3.5h11M2.5 8h9a2 2 0 010 4H8"/><path d="M9.5 10.5L8 12l1.5 1.5M2.5 12.5h3"/>'),
  merge: S('<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M5 8h6M6.5 6.5L5 8l1.5 1.5M9.5 6.5L11 8l-1.5 1.5"/>'),
  indentInc: S('<path d="M2.5 3h11M7 6.5h6.5M7 9.5h6.5M2.5 13h11M2.5 6.5L5 8l-2.5 1.5"/>'),
  indentDec: S('<path d="M2.5 3h11M7 6.5h6.5M7 9.5h6.5M2.5 13h11M5 6.5L2.5 8 5 9.5"/>'),
  sum: '<span style="font:600 15px Georgia,serif">Σ</span>',
  sortAsc: S('<path d="M4.5 2.5v11M2.5 11.5l2 2 2-2"/><path d="M9 3h4.5M9 7h3.3M9 11h2"/>'),
  sortDesc: S('<path d="M4.5 2.5v11M2.5 11.5l2 2 2-2"/><path d="M9 3h2M9 7h3.3M9 11h4.5"/>'),
  filter: S('<path d="M2 3h12L9.5 8.5v4.5l-3-1.5v-3L2 3z"/>'),
  find: S('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  clear: S('<path d="M9.5 2.5l4 4-6.5 6.5H3.5V10l6-7.5z"/><path d="M7 13h6.5"/>'),
  insRow: S('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 8h11M8 5v6"/>'),
  delRow: S('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>'),
  format: S('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.5h11M6.5 2.5v11"/>'),
  image: S('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.3"/><path d="M2 12l3.8-3.5 3 2.6 2.2-2 3 2.6"/>'),
  chartCol: S('<path d="M2 14h12"/><rect x="3" y="8" width="2.5" height="6"/><rect x="7" y="4" width="2.5" height="10"/><rect x="11" y="6" width="2.5" height="8"/>'),
  chartLine: S('<path d="M2 14h12M2 2v12"/><path d="M3 11l3-4 3 2 4-6"/>'),
  chartPie: S('<circle cx="8" cy="8" r="6"/><path d="M8 2v6l5 3"/>'),
  link: S('<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.3-1.3a2.5 2.5 0 013.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 01-3.5-3.5L5.5 8"/>'),
  note: S('<path d="M3 2.5h10v8l-3 3H3z"/><path d="M10 13.5v-3h3M5.5 6h5M5.5 8.5h3"/>'),
  table: S('<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6h12M2 9.5h12M6 6v7.5M10 6v7.5"/>'),
  freeze: S('<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 6h12M6 2v12" stroke-width="2"/>'),
  grid: S('<path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12"/>'),
  fx: '<i style="font:italic 600 13px Georgia,serif">fx</i>',
  dup: S('<rect x="2" y="5" width="9" height="9" rx="1"/><path d="M5 5V2.5h8.5V11H11"/>'),
  chevron: '<svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  pct: '<span style="font:600 13px Arial">%</span>',
  rub: '<span style="font:600 13px Arial">₽</span>',
  thousands: '<span style="font:600 11px Arial">000</span>',
  decInc: '<span style="font:600 10px Arial;letter-spacing:-.5px">←,0<br>,00</span>',
  decDec: '<span style="font:600 10px Arial;letter-spacing:-.5px">,00<br>→,0</span>',
  dedup: S('<rect x="2" y="2.5" width="8" height="4" rx=".8"/><rect x="2" y="9.5" width="8" height="4" rx=".8"/><path d="M11.5 10l3 3M14.5 10l-3 3"/>'),
};
