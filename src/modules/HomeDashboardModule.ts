import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { authService } from '../services/authService';
import { esc as escHtml } from '../utils/format';
import type { App } from '../App';
import {
  WIDGETS, KPIS, loadLayout, saveLayout, resetLayout, resetDims,
  renderWidgetGrid, renderWidgetPicker,
  setWidgetDims, clampDims,
} from './HomeWidgets';

/**
 * Главная страница — командный центр с live-данными по заказам и виджетами.
 *
 * Поток данных (важно для производительности):
 *   1. `fetchRawData()` — ОДИН сетевой заход по всем МП → «сырые» заказы + карточки магазинов.
 *   2. Результат кэшируется на `CACHE_TTL` мс (кэш НЕ зависит от фильтра).
 *   3. `buildDashData()` — фильтрует сырые данные по текущему глобальному фильтру
 *      (маркетплейс/магазин) и считает агрегаты для виджетов. Чистая функция, без сети.
 *   4. `renderDashboardData(data)` — заливка DOM.
 *
 * Смена фильтра, правка/drag/resize виджетов — всё работает по кэшу синхронно,
 * без повторных сетевых запросов → нет «залипшей загрузки» и лагов.
 */

const CACHE_TTL = 60_000; // 60 сек актуальности кэша сырых данных

/**
 * Максимум времени, которое дашборд ждёт ОДИН магазин за один цикл обновления.
 * Общие retry-хелперы (wbApi/ozonOrdersApi/yandexApi) при 429 могут ретраить
 * с экспоненциальной паузой до нескольких минут — это уместно для фоновой
 * синхронизации, но не для дашборда, который обновляется каждые 30 сек и не
 * должен ждать один зависший магазин, пока остальные давно ответили.
 */
const DASH_FETCH_TIMEOUT_MS = 10_000;

function makeTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

type Mp = 'ozon' | 'yandex' | 'wb';

interface UOrder {
  mp: Mp;
  storeId: string;
  id: string;
  status: string;
  isNew: boolean;
  isShip: boolean;
  isCancelled: boolean;
  created: Date;
  total: number;
  productName: string;
  storeName: string;
  storeColor: string;
}

interface StoreCard {
  mp: Mp;
  mpName: string;
  mpColor: string;
  storeId: string;
  storeName: string;
  revenue30: number;
  revenueToday: number;
  orders30: number;
  ordersToday: number;
  newCount: number;
  shipUrgent: number;
  cancels: number;
  lastActivity: Date | null;
  connected: boolean;
}

/** Сырые данные — результат сетевого захода, НЕ зависят от фильтра. */
interface RawData {
  hasStores: boolean;
  storeCards: StoreCard[];
  allOrders: UOrder[];
}

/** Агрегаты для виджетов — результат фильтрации RawData текущим DashFilter. */
interface DashData {
  storeCards: StoreCard[];
  kpi: Record<string, number>;
  daily: { dates: Date[]; revenue: number[]; orders: number[]; units: number[]; cancels: number[] };
  daily30: { dates: Date[]; revenue: number[] };
  returns14: { dates: Date[]; counts: number[] };
  byHour: number[];      // 24
  byWeekday: number[];   // 7 (Пн..Вс)
  status: { label: string; count: number; color: string }[];
  mpShare: { name: string; color: string; rev: number; orders: number }[];
  feed: UOrder[];
  urgent: UOrder[];
  top: { name: string; rev: number; count: number; mp: string }[];
  priceBuckets: { label: string; short: string; count: number }[];
}

/** Глобальный фильтр дашборда — общий переключатель «маркетплейс + магазин». */
interface DashFilter {
  mp: 'all' | Mp;
  storeId: string;   // 'all' | конкретный id
  storeName: string; // кэш имени для мгновенного отображения до перезагрузки данных
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('ru');
const fmtRub = (n: number) => `${fmtInt(n)} ₽`;
/** Сокращённая сумма для центра доната — большие числа не вылезают за круг. */
const fmtCompactRub = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)} млн ₽`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)} тыс ₽`;
  return fmtRub(n);
};

/**
 * Парсит дату заказа. Яндекс Маркет отдаёт `ДД-ММ-ГГГГ[ ЧЧ:ММ:СС]`,
 * который `new Date()` не понимает (→ Invalid Date). Ozon/WB отдают ISO.
 */
function parseOrderDate(raw: string): Date {
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(raw);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  return new Date(raw);
}

// ── Persist фильтра (по компании, как раскладка/размеры виджетов) ─────────────
const FILTER_KEY = 'home_dashboard_filter_v1';
function companyFilterKey(): string {
  const cid = localStorage.getItem('active_company_id');
  return cid ? `${FILTER_KEY}_${cid}` : FILTER_KEY;
}
function loadFilter(): DashFilter {
  try {
    const raw = localStorage.getItem(companyFilterKey());
    if (raw) {
      const f = JSON.parse(raw);
      if (f && typeof f.mp === 'string' && typeof f.storeId === 'string') {
        return { mp: f.mp, storeId: f.storeId, storeName: f.storeName ?? '' };
      }
    }
  } catch { /* ignore */ }
  return { mp: 'all', storeId: 'all', storeName: '' };
}
function saveFilter(f: DashFilter): void {
  localStorage.setItem(companyFilterKey(), JSON.stringify(f));
}

export class HomeDashboardModule {
  constructor(private app: App) {}

  private dashboardRefreshTimer: number | null = null;
  private homeEditMode = false;
  private _filter: DashFilter = loadFilter();

  private _raw: RawData | null = null;
  private _rawTime = 0;
  private _fetching = false;

  // ── Рендер оболочки ─────────────────────────────────────────────
  renderDashboard(): void {
    const content = document.getElementById('main-content');
    if (!content) return;

    const layout = loadLayout();
    const editMode = this.homeEditMode;
    const scope = this.scopeLabel();

    content.innerHTML = `
      <div class="cmd-wrap">
        <div class="cmd-header">
          <div>
            <div class="cmd-greeting">${this.greeting()}</div>
            <div class="cmd-subtitle">${I.radio('', 12)} Командный центр · обновление каждые 30 сек</div>
          </div>
          <div class="cmd-header-actions">
            <button class="cmd-edit-btn ${editMode ? 'active' : ''}" onclick="window.app.toggleHomeEdit()">
              ${editMode
                ? `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5l3 3 6-7"/></svg><span>Готово</span>`
                : `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2L12 4.5M2 12l1-3 7-7 2.5 2.5-7 7-3 1z"/></svg><span>Настроить</span>`}
            </button>
            <button class="cmd-refresh-btn" id="cmd-refresh-btn" onclick="window.app.refreshDashboard()" title="Обновить">
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7A6 6 0 1 1 7.5 1.1M13 1v4H9"/></svg>
              <span id="cmd-last-update">обновить</span>
            </button>
          </div>
        </div>

        ${this.renderFilterBarSkeleton()}

        ${editMode ? `
          <div class="cmd-edit-banner">
            <div class="cmd-edit-banner-txt">
              <div class="cmd-edit-banner-title">Режим настройки</div>
              <div class="cmd-edit-banner-sub">Перетаскивай виджеты · тяни за уголок ↘ для размера · ✕ убирает</div>
            </div>
            <button class="btn btn-primary cmd-edit-add" onclick="window.app.openWidgetPicker()">+ Виджет</button>
            <button class="btn cmd-edit-reset" onclick="window.app.resetWidgetLayout()">Сбросить</button>
          </div>
        ` : ''}

        <div class="cmd-widgets-grid ${editMode ? 'edit-mode' : ''}" id="cmd-widgets-grid">
          ${renderWidgetGrid(layout, editMode, scope)}
        </div>
      </div>
    `;

    // Мгновенно заливаем из кэша, если он свежий — иначе грузим
    this.populate().catch(err => debug.warn('[Home] populate', err));

    if (this.dashboardRefreshTimer) clearInterval(this.dashboardRefreshTimer);
    this.dashboardRefreshTimer = window.setInterval(() => {
      if (this.app.currentPage !== 'home') {
        clearInterval(this.dashboardRefreshTimer!);
        this.dashboardRefreshTimer = null;
        return;
      }
      // Не форсируем сеть: populate() сам решит по CACHE_TTL, нужна ли свежая загрузка.
      // Иначе тик каждые 30с бьёт по WB stats (лимит ~1 запрос/мин) → 429.
      this.populate().catch(e => debug.warn('[Home] tick', e));
    }, 30_000);
  }

  private greeting(): string {
    const h = new Date().getHours();
    const g = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
    const user = authService.getUser();
    const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : '';
    return name ? `${g}, ${name}` : g;
  }

  refreshDashboard(): void {
    this._rawTime = 0;
    this.populate().catch(e => debug.warn('[Home] refresh', e));
  }

  // ── Глобальный фильтр «маркетплейс + магазин» ────────────────────
  private mpLabel(mp: 'all' | Mp): string {
    return mp === 'ozon' ? 'Ozon' : mp === 'yandex' ? 'Яндекс Маркет' : mp === 'wb' ? 'Wildberries' : 'Все МП';
  }

  private scopeLabel(): string {
    const f = this._filter;
    if (f.storeId !== 'all' && f.storeName) return `${this.mpLabel(f.mp)} · ${f.storeName}`;
    if (f.mp !== 'all') return `${this.mpLabel(f.mp)} · все магазины`;
    return 'Все МП · все магазины';
  }

  private renderFilterBarSkeleton(): string {
    const f = this._filter;
    const mpOptions = (['all', 'ozon', 'yandex', 'wb'] as const)
      .map(mp => `<option value="${mp}" ${f.mp === mp ? 'selected' : ''}>${mp === 'all' ? 'Все маркетплейсы' : this.mpLabel(mp)}</option>`)
      .join('');
    const storeOptions = `<option value="all" ${f.storeId === 'all' ? 'selected' : ''}>Все магазины</option>`
      + (f.storeId !== 'all' ? `<option value="${f.storeId}" selected>${escHtml(f.storeName || '…')}</option>` : '');
    const hasActiveFilter = f.mp !== 'all' || f.storeId !== 'all';
    return `<div class="cmd-filter-bar" id="cmd-filter-bar">
      <div class="cmd-filter-group">
        ${I.globe('', 13)}
        <select class="cmd-filter-select" id="cmd-filter-mp" onchange="window.app.onDashFilterMpChange(this.value)">${mpOptions}</select>
      </div>
      <div class="cmd-filter-group">
        ${I.store('', 13)}
        <select class="cmd-filter-select" id="cmd-filter-store" onchange="window.app.onDashFilterStoreChange(this.value, this.options[this.selectedIndex].text)">${storeOptions}</select>
      </div>
      ${hasActiveFilter ? `<button class="cmd-filter-clear" onclick="window.app.resetDashboardFilter()">✕ Сбросить фильтр</button>` : ''}
    </div>`;
  }

  /** Перестраивает <select> магазинов реальным списком после загрузки сырых данных. */
  private paintFilterBar(storeCards: StoreCard[]): void {
    const storeSel = document.getElementById('cmd-filter-store') as HTMLSelectElement | null;
    if (!storeSel) return;
    const f = this._filter;
    const relevant = f.mp === 'all' ? storeCards : storeCards.filter(c => c.mp === f.mp);

    // Если ранее выбранный магазин исчез (отключили/сменился фильтр МП) — сброс на «все»
    if (f.storeId !== 'all' && !relevant.some(c => c.storeId === f.storeId)) {
      this._filter = { ...f, storeId: 'all', storeName: '' };
      saveFilter(this._filter);
    }

    const options = ['<option value="all">Все магазины</option>']
      .concat(relevant.map(c => `<option value="${c.storeId}" ${c.storeId === this._filter.storeId ? 'selected' : ''}>${escHtml(c.storeName)}${f.mp === 'all' ? ' · ' + c.mpName : ''}</option>`));
    storeSel.innerHTML = options.join('');
  }

  onDashFilterMpChange(mp: string): void {
    this._filter = { mp: mp as 'all' | Mp, storeId: 'all', storeName: '' };
    saveFilter(this._filter);
    this.renderDashboard();
  }

  onDashFilterStoreChange(storeId: string, storeName: string): void {
    this._filter = { ...this._filter, storeId, storeName: storeId === 'all' ? '' : storeName };
    saveFilter(this._filter);
    this.renderDashboard();
  }

  resetDashboardFilter(): void {
    this._filter = { mp: 'all', storeId: 'all', storeName: '' };
    saveFilter(this._filter);
    this.renderDashboard();
  }

  // ── Управление виджетами ────────────────────────────────────────
  toggleHomeEdit(): void {
    this.homeEditMode = !this.homeEditMode;
    this.renderDashboard();
  }
  removeWidget(id: string): void {
    saveLayout(loadLayout().filter(x => x !== id));
    this.renderDashboard();
  }
  addWidget(id: string): void {
    if (!WIDGETS[id]) return;
    const layout = loadLayout();
    if (layout.includes(id)) return;
    layout.push(id);
    saveLayout(layout);
    this.app.closeModal();
    this.renderDashboard();
  }
  moveWidget(id: string, dir: -1 | 1): void {
    const layout = loadLayout();
    const idx = layout.indexOf(id);
    if (idx === -1) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= layout.length) return;
    [layout[idx], layout[ni]] = [layout[ni], layout[idx]];
    saveLayout(layout);
    this.renderDashboard();
  }
  resetWidgetLayout(): void {
    if (!confirm('Сбросить раскладку виджетов к стандартной?')) return;
    resetLayout();
    resetDims();
    this.renderDashboard();
  }
  openWidgetPicker(): void {
    const layout = loadLayout();
    this.app.openModalLg(
      'Виджеты дашборда',
      `Нажми на виджет, чтобы добавить · всего ${Object.keys(WIDGETS).length} виджетов`,
      renderWidgetPicker(layout),
      `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>`,
    );
  }

  // ── Drag-and-drop (pointer-based: клон плавно следует за курсором,
  //    остальные виджеты подстраиваются FLIP-анимацией) ────────────
  private _dragId: string | null = null;
  private _dragClone: HTMLElement | null = null;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _lastSwapAt = 0;
  private _dragMoveHandler: ((e: PointerEvent) => void) | null = null;
  private _dragUpHandler: ((e: PointerEvent) => void) | null = null;

  onWidgetPointerDown(e: PointerEvent, id: string): void {
    const target = e.target as HTMLElement;
    if (target.closest('.cmd-widget-resize, .cmd-widget-remove')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
    if (!el) return;
    e.preventDefault();

    this._dragId = id;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;

    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLElement;
    clone.className = `cmd-widget-clone ${el.className}`;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;pointer-events:none;z-index:1000;animation:none;`;
    document.body.appendChild(clone);
    requestAnimationFrame(() => { clone.style.transform = 'scale(1.03) rotate(1deg)'; });
    this._dragClone = clone;

    el.classList.add('placeholder');

    this._dragMoveHandler = (ev: PointerEvent) => this.onWidgetPointerMove(ev);
    this._dragUpHandler = (ev: PointerEvent) => this.onWidgetPointerUp(ev);
    document.addEventListener('pointermove', this._dragMoveHandler);
    document.addEventListener('pointerup', this._dragUpHandler);
    document.addEventListener('pointercancel', this._dragUpHandler);
  }

  private onWidgetPointerMove(e: PointerEvent): void {
    const clone = this._dragClone;
    const srcId = this._dragId;
    if (!clone || !srcId) return;

    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;
    clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.03) rotate(1deg)`;

    const now = Date.now();
    if (now - this._lastSwapAt < 130) return;

    const grid = document.getElementById('cmd-widgets-grid');
    if (!grid) return;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const targetEl = under?.closest<HTMLElement>('.cmd-widget');
    const targetId = targetEl?.dataset.widgetId;
    if (!targetEl || !targetId || targetId === srcId) return;

    const srcEl = grid.querySelector<HTMLElement>(`[data-widget-id="${srcId}"]`);
    if (!srcEl) return;
    this._lastSwapAt = now;

    // FLIP: снимаем позиции до перестановки
    const widgets = Array.from(grid.querySelectorAll<HTMLElement>('.cmd-widget'));
    const before = new Map<string, DOMRect>();
    widgets.forEach(w => { const wid = w.dataset.widgetId; if (wid) before.set(wid, w.getBoundingClientRect()); });

    const layout = loadLayout();
    const si = layout.indexOf(srcId);
    if (si === -1 || layout.indexOf(targetId) === -1) return;
    layout.splice(si, 1);
    const ti = layout.indexOf(targetId);
    const targetRect = targetEl.getBoundingClientRect();
    const insertBefore = (e.clientX - targetRect.left) < targetRect.width / 2;
    layout.splice(insertBefore ? ti : ti + 1, 0, srcId);
    saveLayout(layout);

    if (insertBefore) grid.insertBefore(srcEl, targetEl);
    else targetEl.after(srcEl);

    // FLIP: анимируем плавный сдвиг остальных. Форсируем синхронный reflow
    // (чтение offsetHeight) вместо двойного requestAnimationFrame — так каждая
    // перестановка детерминированно перекрывает предыдущую анимацию на том же
    // элементе, без гонки между отложенными rAF-коллбэками от разных свапов
    // (именно она давала «резкие» скачки при быстрой перетаскивании).
    widgets.forEach(w => {
      const wid = w.dataset.widgetId;
      if (!wid || w === srcEl) return;
      const oldR = before.get(wid);
      const newR = w.getBoundingClientRect();
      if (!oldR) return;
      const ddx = oldR.left - newR.left;
      const ddy = oldR.top - newR.top;
      if (Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return;
      w.style.transition = 'none';
      w.style.transform = `translate(${ddx}px,${ddy}px)`;
      void w.offsetHeight; // форсируем reflow — браузер фиксирует «прыжок» перед стартом transition
      w.style.transition = 'transform .3s cubic-bezier(.22,.61,.36,1)';
      w.style.transform = '';
    });
  }

  private onWidgetPointerUp(_e: PointerEvent): void {
    if (this._dragMoveHandler) document.removeEventListener('pointermove', this._dragMoveHandler);
    if (this._dragUpHandler) {
      document.removeEventListener('pointerup', this._dragUpHandler);
      document.removeEventListener('pointercancel', this._dragUpHandler);
    }

    const srcId = this._dragId;
    const clone = this._dragClone;
    const grid = document.getElementById('cmd-widgets-grid');
    const srcEl = srcId ? grid?.querySelector<HTMLElement>(`[data-widget-id="${srcId}"]`) : null;

    if (clone && srcEl) {
      // Клон плавно «влетает» в финальный слот виджета, затем убирается
      const finalRect = srcEl.getBoundingClientRect();
      clone.style.transition = 'left .22s cubic-bezier(.4,0,.2,1), top .22s cubic-bezier(.4,0,.2,1), transform .22s cubic-bezier(.4,0,.2,1)';
      clone.style.left = `${finalRect.left}px`;
      clone.style.top = `${finalRect.top}px`;
      clone.style.transform = 'scale(1) rotate(0deg)';
      setTimeout(() => clone.remove(), 230);
    } else {
      clone?.remove();
    }

    srcEl?.classList.remove('placeholder');
    this._dragId = null;
    this._dragClone = null;
    this._dragMoveHandler = null;
    this._dragUpHandler = null;

    // Раскладка уже сохранена по ходу перетаскивания — просто перезаливаем
    // данные из кэша (мгновенно, без сети) в новые позиции.
    if (this._raw) this.applyFilterAndRender(this._raw);
  }

  // ── Resize виджетов ─────────────────────────────────────────────
  private _resize: { id: string; startX: number; startY: number; startCw: number; startRh: number; cellW: number; cellH: number } | null = null;

  onWidgetResizeStart(e: MouseEvent | TouchEvent, id: string): void {
    e.preventDefault();
    e.stopPropagation();
    const widget = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
    const grid = document.getElementById('cmd-widgets-grid');
    if (!widget || !grid) return;

    const gStyle = getComputedStyle(grid);
    const cols = (gStyle.gridTemplateColumns.split(' ').length) || 4;
    const gap = parseFloat(gStyle.gap) || 14;
    const cellW = (grid.clientWidth - gap * (cols - 1)) / cols;
    const cellH = 116;

    const isTouch = 'touches' in e;
    const startX = isTouch ? e.touches[0].clientX : e.clientX;
    const startY = isTouch ? e.touches[0].clientY : e.clientY;

    this._resize = {
      id, startX, startY,
      startCw: parseInt(widget.dataset.cw || '1'),
      startRh: parseInt(widget.dataset.rh || '1'),
      cellW, cellH,
    };
    widget.classList.add('resizing');

    const onMove = (ev: MouseEvent | TouchEvent) => this.onResizeMove(ev);
    const onEnd = () => this.onResizeEnd(onMove, onEnd);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  }

  private onResizeMove(e: MouseEvent | TouchEvent): void {
    const st = this._resize;
    if (!st) return;
    if ('touches' in e) e.preventDefault();
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const newCw = st.startCw + Math.round((x - st.startX) / (st.cellW + 14));
    const newRh = st.startRh + Math.round((y - st.startY) / (st.cellH + 14));
    const c = clampDims(st.id, newCw, newRh);
    const widget = document.querySelector<HTMLElement>(`[data-widget-id="${st.id}"]`);
    if (!widget) return;
    if (widget.dataset.cw === String(c.cw) && widget.dataset.rh === String(c.rh)) return;
    widget.className = widget.className.replace(/cmd-widget-cw\d/g, '').replace(/cmd-widget-rh\d/g, '').replace(/\s+/g, ' ');
    widget.classList.add(`cmd-widget-cw${c.cw}`, `cmd-widget-rh${c.rh}`);
    widget.dataset.cw = String(c.cw);
    widget.dataset.rh = String(c.rh);
  }

  private onResizeEnd(onMove: (e: any) => void, onEnd: () => void): void {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);
    const st = this._resize;
    if (!st) return;
    const widget = document.querySelector<HTMLElement>(`[data-widget-id="${st.id}"]`);
    if (widget) {
      widget.classList.remove('resizing');
      const cw = parseInt(widget.dataset.cw || String(st.startCw));
      const rh = parseInt(widget.dataset.rh || String(st.startRh));
      setWidgetDims(st.id, clampDims(st.id, cw, rh));
    }
    this._resize = null;
    // Перезаливаем данные (графики зависят от размера) без сети
    if (this._raw) this.applyFilterAndRender(this._raw);
  }

  // ── Загрузка + заливка ──────────────────────────────────────────
  private async populate(): Promise<void> {
    // Свежий кэш → мгновенная заливка без сети
    if (this._raw && Date.now() - this._rawTime < CACHE_TTL) {
      this.applyFilterAndRender(this._raw);
      this.stampUpdated();
      return;
    }
    if (this._fetching) return;
    this._fetching = true;
    const btn = document.getElementById('cmd-refresh-btn');
    btn?.classList.add('spinning');
    try {
      const raw = await this.fetchRawData();
      this._raw = raw;
      this._rawTime = Date.now();
      if (this.app.currentPage === 'home') {
        this.applyFilterAndRender(raw);
        this.stampUpdated();
      }
    } catch (err) {
      debug.warn('[Home] fetch failed', err);
    } finally {
      btn?.classList.remove('spinning');
      this._fetching = false;
    }
  }

  /** Применяет текущий глобальный фильтр к сырым данным и заливает виджеты. */
  private applyFilterAndRender(raw: RawData): void {
    if (!raw.hasStores) { this.renderEmpty(); return; }
    const f = this._filter;
    const match = (mp: Mp, storeId: string) =>
      (f.mp === 'all' || mp === f.mp) && (f.storeId === 'all' || storeId === f.storeId);
    const storeCards = raw.storeCards.filter(c => match(c.mp, c.storeId));
    const allOrders = raw.allOrders.filter(o => match(o.mp, o.storeId));
    const data = this.buildDashData(storeCards, allOrders);
    this.renderDashboardData(data);
    this.paintFilterBar(raw.storeCards);
  }

  private stampUpdated(): void {
    const el = document.getElementById('cmd-last-update');
    if (!el) return;
    const sec = Math.floor((Date.now() - this._rawTime) / 1000);
    el.textContent = sec < 5 ? 'только что' : `${sec} сек назад`;
  }

  /** Единый сетевой заход по всем МП → сырые заказы + карточки магазинов (без фильтра). */
  private async fetchRawData(): Promise<RawData> {
    const { ozonDb } = await import('../services/ozonDb');
    const { yandexDb } = await import('../services/yandexDb');
    const { wbDb } = await import('../services/wbDb');
    const { ozonOrdersApi, fetchAllPagesByCursor, fetchAllPages } = await import('../services/ozonOrdersApi');
    const { fetchAllYandexOrders } = await import('../services/yandexApi');
    const { fetchAllWbOrders, isWbCoolingDown } = await import('../services/wbApi');

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const since30 = new Date(now.getTime() - 30 * 86_400_000);
    const sinceIso = since30.toISOString();
    const toIso = now.toISOString();
    const dd = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const ymFrom = dd(since30), ymTo = dd(now);
    const wbFrom = sinceIso.slice(0, 19);

    const all: UOrder[] = [];
    const storeCards: StoreCard[] = [];

    const ozColors = ['#3b82f6', '#0ea5e9', '#6366f1', '#8b5cf6'];
    const ymColors = ['#fc3f1d', '#fb923c', '#ef4444'];
    const wbColors = ['#cb11ab', '#a855f7', '#c026d3'];

    const [ozStores, ymStores, wbStores] = await Promise.all([
      ozonDb.getStores().catch(() => []),
      yandexDb.getStores().catch(() => []),
      wbDb.getStores().catch(() => []),
    ]);

    const hasStores = ozStores.length + ymStores.length + wbStores.length > 0;
    if (!hasStores) return { hasStores: false, storeCards: [], allOrders: [] };

    const jobs: Promise<void>[] = [];

    const pushCard = (mp: Mp, mpName: string, mpColor: string, storeId: string, storeName: string): StoreCard => {
      const card: StoreCard = {
        mp, mpName, mpColor, storeId, storeName,
        revenue30: 0, revenueToday: 0, orders30: 0, ordersToday: 0,
        newCount: 0, shipUrgent: 0, cancels: 0, lastActivity: null, connected: false,
      };
      storeCards.push(card);
      return card;
    };
    const record = (card: StoreCard, o: UOrder): void => {
      if (o.isCancelled) { card.cancels++; all.push(o); return; }
      card.revenue30 += o.total; card.orders30++;
      if (o.created >= todayStart) { card.revenueToday += o.total; card.ordersToday++; }
      if (o.isNew) card.newCount++;
      if (o.isShip) card.shipUrgent++;
      if (!card.lastActivity || o.created > card.lastActivity) card.lastActivity = o.created;
      all.push(o);
    };

    ozStores.forEach((store, idx) => {
      const color = ozColors[idx % ozColors.length];
      const card = pushCard('ozon', 'Ozon', color, store.id, store.name);
      jobs.push((async () => {
        const { signal, clear } = makeTimeoutSignal(DASH_FETCH_TIMEOUT_MS);
        try {
          const creds = { client_id: store.client_id, api_key: store.api_key };
          type OzPost = Awaited<ReturnType<typeof ozonOrdersApi.getFboPostings>>;
          const [fbs, fbo]: [OzPost, OzPost] = await Promise.all([
            fetchAllPagesByCursor((lim, cursor, sig) => ozonOrdersApi.getFbsPostings(creds, sinceIso, toIso, null, lim, cursor, sig), 50, signal).catch(() => [] as OzPost),
            fetchAllPages((lim, off, sig) => ozonOrdersApi.getFboPostings(creds, sinceIso, toIso, lim, off as number, sig), 50, signal).catch(() => [] as OzPost),
          ]);
          card.connected = true;
          for (const p of [...fbs, ...fbo]) {
            const total = p.products.reduce((s, pr) => s + (parseFloat(pr.price) || 0) * pr.quantity, 0);
            const created = new Date(p.created_at || p.in_process_at || '');
            const ship = p.shipment_date ? new Date(p.shipment_date) : null;
            record(card, {
              mp: 'ozon', storeId: store.id, id: p.posting_number, status: p.status,
              isCancelled: p.status === 'cancelled',
              isNew: p.status === 'awaiting_packaging',
              // Если дедлайн отгрузки неизвестен (Ozon не всегда отдаёт shipment_date,
              // особенно по FBO) — считаем заказ срочным, а не молча прячем его из счётчика.
              isShip: (p.status === 'awaiting_packaging' || p.status === 'awaiting_deliver') && (!ship || ship.getTime() <= now.getTime() + 86_400_000),
              created, total,
              productName: p.products[0]?.name ?? p.products[0]?.offer_id ?? '',
              storeName: store.name, storeColor: color,
            });
          }
        } catch (e: unknown) { debug.warn('[Home] Ozon', (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e); }
        finally { clear(); }
      })());
    });

    ymStores.forEach((store, idx) => {
      const color = ymColors[idx % ymColors.length];
      const card = pushCard('yandex', 'Яндекс Маркет', color, store.id, store.name);
      jobs.push((async () => {
        const { signal, clear } = makeTimeoutSignal(DASH_FETCH_TIMEOUT_MS);
        try {
          const orders = await fetchAllYandexOrders(store, ymFrom, ymTo, signal);
          card.connected = true;
          for (const o of orders) {
            const created = parseOrderDate(o.creation_date);
            const isNew = o.status === 'PROCESSING';
            record(card, {
              mp: 'yandex', storeId: store.id, id: String(o.id), status: o.status,
              isCancelled: o.status === 'CANCELLED', isNew, isShip: isNew,
              created, total: o.total, productName: o.items[0]?.name ?? '',
              storeName: store.name, storeColor: color,
            });
          }
        } catch (e: unknown) { debug.warn('[Home] YM', (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e); }
        finally { clear(); }
      })());
    });

    wbStores.forEach((store, idx) => {
      const color = wbColors[idx % wbColors.length];
      const card = pushCard('wb', 'Wildberries', color, store.id, store.name);
      jobs.push((async () => {
        if (isWbCoolingDown()) return;
        const { signal, clear } = makeTimeoutSignal(DASH_FETCH_TIMEOUT_MS);
        try {
          const orders = await fetchAllWbOrders(store, wbFrom, signal);
          card.connected = true;
          for (const o of orders) {
            const created = new Date(o.created_at);
            const isNew = o.status === 'new';
            record(card, {
              mp: 'wb', storeId: store.id, id: String(o.id), status: o.status,
              isCancelled: o.status === 'cancel', isNew, isShip: isNew,
              created, total: o.total, productName: o.items[0]?.name ?? '',
              storeName: store.name, storeColor: color,
            });
          }
        } catch (e: unknown) { debug.warn('[Home] WB', (e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e); }
        finally { clear(); }
      })());
    });

    await Promise.all(jobs);
    return { hasStores: true, storeCards, allOrders: all };
  }

  /** Считает агрегаты для виджетов из уже отфильтрованных карточек/заказов. Без сети. */
  private buildDashData(storeCards: StoreCard[], allOrders: UOrder[]): DashData {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const all = allOrders;

    // ── Агрегаты ──
    const live = all.filter(o => !o.isCancelled);
    const kpi: Record<string, number> = {
      'k-rev-today':    live.filter(o => o.created >= todayStart).reduce((s, o) => s + o.total, 0),
      'k-rev-30':       storeCards.reduce((s, c) => s + c.revenue30, 0),
      'k-orders-today': new Set(live.filter(o => o.created >= todayStart).map(o => `${o.mp}-${o.id}`)).size,
      'k-orders-30':    new Set(live.map(o => `${o.mp}-${o.id}`)).size,
      'k-new':          live.filter(o => o.isNew).length,
      'k-ship':         live.filter(o => o.isShip).length,
      'k-units':        live.length,
      'k-cancels':      all.filter(o => o.isCancelled).length,
    };
    kpi['k-avg'] = kpi['k-orders-30'] > 0 ? kpi['k-rev-30'] / kpi['k-orders-30'] : 0;
    kpi['k-payouts'] = Math.round(kpi['k-rev-30'] * 0.85);
    kpi['k-stores-active'] = storeCards.filter(c => c.connected).length;
    kpi['k-cancel-rate'] = (kpi['k-cancels'] + kpi['k-orders-30']) > 0
      ? (kpi['k-cancels'] / (kpi['k-cancels'] + kpi['k-orders-30'])) * 100 : 0;
    kpi['k-max-order'] = live.reduce((m, o) => Math.max(m, o.total), 0);
    kpi['k-unique-sku'] = new Set(live.map(o => o.productName || o.id)).size;

    // Дневные бакеты (7 дней)
    const days = 7;
    const dates: Date[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      dates.push(d);
    }
    const start7 = dates[0].getTime();
    const revenue = new Array(days).fill(0), orders = new Array(days).fill(0), units = new Array(days).fill(0), cancels = new Array(days).fill(0);
    for (const o of all) {
      const idx = Math.floor((o.created.getTime() - start7) / 86_400_000);
      if (idx < 0 || idx >= days) continue;
      if (o.isCancelled) { cancels[idx]++; continue; }
      revenue[idx] += o.total; orders[idx]++; units[idx]++;
    }

    // Дневные бакеты (30 дней) — для подробного графика выручки
    const days30 = 30;
    const dates30: Date[] = [];
    for (let i = days30 - 1; i >= 0; i--) {
      const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      dates30.push(d);
    }
    const start30 = dates30[0].getTime();
    const revenue30arr = new Array(days30).fill(0);
    for (const o of live) {
      const idx = Math.floor((o.created.getTime() - start30) / 86_400_000);
      if (idx >= 0 && idx < days30) revenue30arr[idx] += o.total;
    }

    // Отмены 14 дней
    const rd = 14;
    const rDates: Date[] = [];
    for (let i = rd - 1; i >= 0; i--) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); rDates.push(d); }
    const rStart = rDates[0].getTime();
    const rCounts = new Array(rd).fill(0);
    for (const o of all) {
      if (!o.isCancelled) continue;
      const idx = Math.floor((o.created.getTime() - rStart) / 86_400_000);
      if (idx >= 0 && idx < rd) rCounts[idx]++;
    }

    // По часам / дням недели
    const byHour = new Array(24).fill(0);
    const byWeekday = new Array(7).fill(0); // 0=Пн
    for (const o of live) {
      if (isNaN(o.created.getTime())) continue;
      byHour[o.created.getHours()]++;
      byWeekday[(o.created.getDay() + 6) % 7]++;
    }

    // Статусы
    const status = [
      { label: 'Новые', count: kpi['k-new'], color: '#ea580c' },
      { label: 'К отгрузке', count: live.filter(o => o.isShip && !o.isNew).length, color: '#dc2626' },
      { label: 'В работе', count: live.filter(o => !o.isNew && !o.isShip).length, color: '#0891b2' },
      { label: 'Отменённые', count: kpi['k-cancels'], color: '#94a3b8' },
    ].filter(s => s.count > 0);

    // Доли МП
    const mpMap = new Map<string, { name: string; color: string; rev: number; orders: number }>();
    for (const c of storeCards) {
      const cur = mpMap.get(c.mp) ?? { name: c.mpName, color: c.mpColor, rev: 0, orders: 0 };
      cur.rev += c.revenue30; cur.orders += c.orders30;
      mpMap.set(c.mp, cur);
    }
    const mpShare = [...mpMap.values()].filter(v => v.rev > 0 || v.orders > 0).sort((a, b) => b.rev - a.rev);

    // Лента / срочное / топ
    const feed = [...all].sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, 20);
    const urgent = live.filter(o => o.isShip).sort((a, b) => a.created.getTime() - b.created.getTime()).slice(0, 12);

    const prodMap = new Map<string, { name: string; rev: number; count: number; mp: string }>();
    for (const o of live) {
      const key = `${o.mp}|${o.productName || o.id}`;
      const cur = prodMap.get(key) ?? { name: o.productName || o.id, rev: 0, count: 0, mp: o.mp };
      cur.rev += o.total; cur.count++;
      prodMap.set(key, cur);
    }
    const top = [...prodMap.values()].sort((a, b) => b.rev - a.rev).slice(0, 8);

    // Распределение заказов по сумме
    const bucketDefs = [
      { label: 'До 1 000 ₽', short: '<1к', max: 1000 },
      { label: '1 000–3 000 ₽', short: '1–3к', max: 3000 },
      { label: '3 000–5 000 ₽', short: '3–5к', max: 5000 },
      { label: '5 000–10 000 ₽', short: '5–10к', max: 10_000 },
      { label: 'Свыше 10 000 ₽', short: '>10к', max: Infinity },
    ];
    const priceBuckets = bucketDefs.map(b => ({ label: b.label, short: b.short, count: 0 }));
    for (const o of live) {
      const idx = bucketDefs.findIndex(b => o.total <= b.max);
      priceBuckets[idx === -1 ? bucketDefs.length - 1 : idx].count++;
    }

    return {
      storeCards, kpi,
      daily: { dates, revenue, orders, units, cancels },
      daily30: { dates: dates30, revenue: revenue30arr },
      returns14: { dates: rDates, counts: rCounts },
      byHour, byWeekday, status, mpShare, feed, urgent, top, priceBuckets,
    };
  }

  // ── Заливка DOM (без сети) ──────────────────────────────────────
  private renderDashboardData(d: DashData): void {
    // Счётчики
    const money: Record<string, boolean> = { 'k-rev-today': true, 'k-rev-30': true, 'k-avg': true, 'k-payouts': true, 'k-max-order': true };
    const percent: Record<string, boolean> = { 'k-cancel-rate': true };
    const seriesFor: Record<string, number[] | null> = {
      'k-rev-today': d.daily.revenue, 'k-rev-30': d.daily.revenue,
      'k-orders-today': d.daily.orders, 'k-orders-30': d.daily.orders,
      'k-units': d.daily.units, 'k-cancels': d.daily.cancels,
      'k-new': null, 'k-ship': null, 'k-avg': null, 'k-payouts': null,
      'k-stores-active': null, 'k-cancel-rate': null, 'k-max-order': null, 'k-unique-sku': null,
    };
    for (const cfg of KPIS) {
      const v = d.kpi[cfg.id] ?? 0;
      const disp = percent[cfg.id] ? `${v.toFixed(1)}%` : money[cfg.id] ? fmtRub(v) : fmtInt(v);
      this.paintKpi(cfg.elemId, disp, seriesFor[cfg.id] ?? null, cfg.color);
    }

    this.paintStores(d);
    this.paintFeed(d);
    this.paintUrgent(d);
    this.paintRev7d(d);
    this.paintRev30d(d);
    this.paintMpShare(d);
    this.paintTop(d);
    this.paintMpCompare(d);
    this.paintHours(d);
    this.paintWeekday(d);
    this.paintStatus(d);
    this.paintReturns(d);
    this.paintAovTrend(d);
    this.paintPriceBuckets(d);
  }

  private renderEmpty(): void {
    const grid = document.getElementById('cmd-widgets-grid');
    if (!grid) return;
    grid.innerHTML = `
      <div class="cmd-empty-state">
        <div class="cmd-empty-icon">${I.plug('', 30)}</div>
        <div class="cmd-empty-title">Магазины не подключены</div>
        <div class="cmd-empty-sub">Подключи Ozon, Яндекс Маркет или Wildberries — и здесь появятся live-виджеты: выручка, заказы, графики.</div>
        <button class="btn btn-primary" onclick="window.app.navigateTo('marketplaces')" style="margin-top:16px">Подключить магазин →</button>
      </div>`;
  }

  // ── Painters ────────────────────────────────────────────────────
  private paintKpi(elemId: string, value: string, series: number[] | null, _color: string): void {
    const valEl = document.getElementById(`${elemId}-val`);
    if (valEl) valEl.textContent = value;

    const trendEl = document.getElementById(`${elemId}-trend`);
    if (trendEl) {
      if (series && series.length >= 2 && series.some(v => v > 0)) {
        const cur = series[series.length - 1], prev = series[series.length - 2];
        let pct = 0, dir: 'up' | 'down' | 'flat' = 'flat';
        if (prev > 0) { pct = ((cur - prev) / prev) * 100; dir = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat'; }
        else if (cur > 0) { dir = 'up'; pct = 100; }
        const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '';
        trendEl.className = `cmd-kpi-trend ${dir}`;
        trendEl.textContent = `${arrow}${Math.abs(Math.round(pct))}%`;
      } else {
        trendEl.textContent = '';
      }
    }

    const sparkEl = document.getElementById(`${elemId}-spark`);
    if (sparkEl) {
      if (series && series.length >= 2 && series.some(v => v > 0)) {
        const max = Math.max(...series, 1);
        const bars = series.slice(-14).map(v => {
          const h = Math.max(2, (v / max) * 100);
          return `<div class="cmd-kpi-bar" style="height:${h}%"></div>`;
        });
        sparkEl.innerHTML = bars.join('');
      } else {
        sparkEl.innerHTML = '';
      }
    }
  }

  private paintStores(d: DashData): void {
    const grid = document.getElementById('dw-stores');
    const footer = document.getElementById('dw-stores-footer') as HTMLElement | null;
    if (!grid) return;
    const now = Date.now();
    if (d.storeCards.length === 0) { grid.innerHTML = '<div class="sf-loading">Нет магазинов по текущему фильтру</div>'; if (footer) footer.style.display = 'none'; return; }

    grid.innerHTML = d.storeCards.map(c => {
      const ago = c.lastActivity ? this.timeAgo(c.lastActivity) : 'нет данных';
      const cls = c.connected ? (c.lastActivity && c.lastActivity.getTime() > now - 7 * 86_400_000 ? 'live' : 'idle') : 'off';
      const dest = c.mp === 'ozon' ? 'orders-ozon' : c.mp === 'yandex' ? 'orders-yandex' : 'orders-wb';
      return `<div class="sf-row" style="--c:${c.mpColor}" onclick="window.app.navigateTo('${dest}')" title="${escHtml(c.storeName)} · ${ago}">
        <span class="sf-dot"></span>
        <span class="sf-name">${escHtml(c.storeName)}</span>
        <span class="sf-mp">${c.mpName}</span>
        <span class="sf-rev">${fmtRub(c.revenue30)}</span>
        <span class="sf-orders">${c.orders30} зак.</span>
        <span class="sf-tags">
          ${c.newCount > 0 ? `<span class="sf-badge sf-new">+${c.newCount}</span>` : ''}
          ${c.shipUrgent > 0 ? `<span class="sf-badge sf-urg">${c.shipUrgent}⏰</span>` : ''}
          ${c.ordersToday > 0 ? `<span class="sf-badge sf-today">▲${c.ordersToday}</span>` : ''}
        </span>
        <span class="sf-status ${cls}"></span>
      </div>`;
    }).join('');

    if (footer) {
      const rev = d.storeCards.reduce((s, c) => s + c.revenue30, 0);
      const ord = d.storeCards.reduce((s, c) => s + c.orders30, 0);
      const ship = d.storeCards.reduce((s, c) => s + c.shipUrgent, 0);
      const nw = d.storeCards.reduce((s, c) => s + c.newCount, 0);
      footer.style.display = '';
      footer.innerHTML = `<span class="sf-footer-label">Итого 30 дн.</span>
        <span class="sf-footer-rev">${fmtRub(rev)}</span>
        <span class="sf-footer-ord">${ord} зак.</span>
        ${ship > 0 ? `<span class="sf-footer-badge sf-urg">${ship}⏰</span>` : ''}
        ${nw > 0 ? `<span class="sf-footer-badge sf-new">+${nw}</span>` : ''}`;
    }
  }

  private paintFeed(d: DashData): void {
    const el = document.getElementById('dw-feed');
    if (!el) return;
    el.innerHTML = d.feed.length === 0
      ? '<div class="cmd-empty-small">Нет заказов за 30 дней</div>'
      : d.feed.map(o => `<div class="cmd-feed-item" onclick="window.app.navigateTo('orders-${o.mp}')">
          <div class="cmd-feed-time" title="${o.created.toLocaleString('ru')}">${this.timeAgo(o.created)}</div>
          <div class="cmd-feed-dot" style="background:${o.storeColor}"></div>
          <div class="cmd-feed-info">
            <div class="cmd-feed-name">${escHtml(o.productName || o.id)}</div>
            <div class="cmd-feed-meta"><span class="cmd-feed-mp cmd-feed-mp-${o.mp}">${this.mpTag(o.mp)}</span>${escHtml(o.storeName)}
              ${o.isCancelled ? ' · <span class="cmd-tag-cancel">отменён</span>' : o.isNew ? ' · <span class="cmd-tag-new-inline">новый</span>' : ''}</div>
          </div>
          <div class="cmd-feed-amount">${fmtRub(o.total)}</div>
        </div>`).join('');
  }

  private paintUrgent(d: DashData): void {
    const el = document.getElementById('dw-urgent');
    if (!el) return;
    if (d.urgent.length === 0) { el.innerHTML = '<div class="cmd-empty-small cmd-ok">✓ Все заказы в работе</div>'; return; }
    const word = d.urgent.length === 1 ? 'заказ' : d.urgent.length < 5 ? 'заказа' : 'заказов';
    el.innerHTML = `<div class="cmd-urgent-summary">${I.zap('', 15)} <b>${d.urgent.length}</b> ${word} требуют отгрузки</div>
      ${d.urgent.map(o => `<div class="cmd-action-item" onclick="window.app.navigateTo('orders-${o.mp}')">
        <span class="cmd-feed-mp cmd-feed-mp-${o.mp}">${this.mpTag(o.mp)}</span>
        <div class="cmd-action-info"><div class="cmd-action-name">${escHtml(o.productName || o.id)}</div>
          <div class="cmd-action-sub">${escHtml(o.storeName)} · ${this.timeAgo(o.created)}</div></div>
        <div class="cmd-action-amount">${fmtRub(o.total)}</div>
      </div>`).join('')}
      <button class="btn btn-primary cmd-widget-cta" onclick="window.app.navigateTo('orders')">Ко всем заказам →</button>`;
  }

  private paintRev7d(d: DashData): void {
    const el = document.getElementById('dw-rev7d');
    if (!el) return;
    const b = d.daily.revenue;
    const total = b.reduce((s, v) => s + v, 0);
    el.innerHTML = `<div class="cmd-chart-total"><span class="cmd-chart-total-v">${fmtRub(total)}</span><span class="cmd-chart-total-l">за 7 дней</span></div>
      ${this.barChart(b, d.daily.dates.map(x => `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}`), '#16a34a', v => fmtRub(v))}`;
  }

  private paintMpShare(d: DashData): void {
    const el = document.getElementById('dw-mpshare');
    if (!el) return;
    if (d.mpShare.length === 0) { el.innerHTML = '<div class="cmd-empty-small">Нет данных</div>'; return; }
    const total = d.mpShare.reduce((s, v) => s + v.rev, 0) || 1;
    el.innerHTML = this.donut(
      d.mpShare.map(v => ({ label: v.name, value: v.rev, color: v.color, sub: `${v.orders} зак.` })),
      fmtCompactRub(total), 'выручка 30д');
  }

  private paintStatus(d: DashData): void {
    const el = document.getElementById('dw-status');
    if (!el) return;
    if (d.status.length === 0) { el.innerHTML = '<div class="cmd-empty-small">Нет заказов</div>'; return; }
    const total = d.status.reduce((s, v) => s + v.count, 0) || 1;
    el.innerHTML = this.donut(
      d.status.map(s => ({ label: s.label, value: s.count, color: s.color, sub: `${Math.round(s.count / total * 100)}%` })),
      String(total), 'всего');
  }

  private paintTop(d: DashData): void {
    const el = document.getElementById('dw-top');
    if (!el) return;
    if (d.top.length === 0) { el.innerHTML = '<div class="cmd-empty-small">Нет продаж за 30 дней</div>'; return; }
    const max = Math.max(...d.top.map(p => p.rev), 1);
    el.innerHTML = d.top.map((p, i) => `<div class="cmd-top-row">
      <div class="cmd-top-rank cmd-top-rank-${i < 3 ? i + 1 : 'n'}">${i + 1}</div>
      <div class="cmd-top-body">
        <div class="cmd-top-name">${escHtml(p.name)}</div>
        <div class="cmd-top-bar"><div style="width:${(p.rev / max) * 100}%"></div></div>
      </div>
      <div class="cmd-top-meta"><div class="cmd-top-rev">${fmtRub(p.rev)}</div><div class="cmd-top-cnt">${p.count} шт · ${this.mpTag(p.mp)}</div></div>
    </div>`).join('');
  }

  private paintMpCompare(d: DashData): void {
    const el = document.getElementById('dw-mpcompare');
    if (!el) return;
    if (d.mpShare.length === 0) { el.innerHTML = '<div class="cmd-empty-small">Нет данных</div>'; return; }
    const max = Math.max(...d.mpShare.map(v => v.rev), 1);
    el.innerHTML = `<div class="cmd-cmp-list">${d.mpShare.map(v => `
      <div class="cmd-cmp-row">
        <span class="cmd-cmp-name" style="color:${v.color}">${escHtml(v.name)}</span>
        <div class="cmd-cmp-bar"><div style="width:${(v.rev / max) * 100}%;background:${v.color}"></div></div>
        <span class="cmd-cmp-rev">${fmtRub(v.rev)}</span>
        <span class="cmd-cmp-ord">${v.orders} зак.</span>
      </div>`).join('')}</div>`;
  }

  private paintHours(d: DashData): void {
    const el = document.getElementById('dw-hours');
    if (!el) return;
    if (d.byHour.every(v => v === 0)) { el.innerHTML = '<div class="cmd-empty-small">Нет заказов</div>'; return; }
    const peak = d.byHour.indexOf(Math.max(...d.byHour));
    const labels = d.byHour.map((_, h) => (h % 6 === 0 ? `${h}` : ''));
    el.innerHTML = `<div class="cmd-chart-note">Пик заказов: <b>${peak}:00–${peak + 1}:00</b></div>${this.barChart(d.byHour, labels, '#7c3aed', v => `${v} зак.`, true)}`;
  }

  private paintWeekday(d: DashData): void {
    const el = document.getElementById('dw-weekday');
    if (!el) return;
    if (d.byWeekday.every(v => v === 0)) { el.innerHTML = '<div class="cmd-empty-small">Нет заказов</div>'; return; }
    el.innerHTML = this.barChart(d.byWeekday, ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], '#0891b2', v => `${v} зак.`);
  }

  private paintReturns(d: DashData): void {
    const el = document.getElementById('dw-returns');
    if (!el) return;
    const total = d.returns14.counts.reduce((s, v) => s + v, 0);
    const labels = d.returns14.dates.map((x, i) => (i % 3 === 0 ? `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}` : ''));
    el.innerHTML = `<div class="cmd-chart-note">Всего отмен: <b>${total}</b> за 14 дней</div>${this.barChart(d.returns14.counts, labels, '#ef4444', v => `${v} отмен`, true)}`;
  }

  private paintRev30d(d: DashData): void {
    const el = document.getElementById('dw-rev30d');
    if (!el) return;
    const total = d.daily30.revenue.reduce((s, v) => s + v, 0);
    const labels = d.daily30.dates.map((x, i) => (i % 5 === 0 ? `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}` : ''));
    el.innerHTML = `<div class="cmd-chart-total"><span class="cmd-chart-total-v">${fmtRub(total)}</span><span class="cmd-chart-total-l">за 30 дней</span></div>
      ${this.barChart(d.daily30.revenue, labels, '#16a34a', v => fmtRub(v), true)}`;
  }

  private paintAovTrend(d: DashData): void {
    const el = document.getElementById('dw-aov');
    if (!el) return;
    const avg = d.daily.revenue.map((rev, i) => d.daily.orders[i] > 0 ? rev / d.daily.orders[i] : 0);
    if (avg.every(v => v === 0)) { el.innerHTML = '<div class="cmd-empty-small">Нет данных</div>'; return; }
    const labels = d.daily.dates.map(x => `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}`);
    el.innerHTML = this.barChart(avg, labels, '#0891b2', v => fmtRub(v));
  }

  private paintPriceBuckets(d: DashData): void {
    const el = document.getElementById('dw-buckets');
    if (!el) return;
    const total = d.priceBuckets.reduce((s, b) => s + b.count, 0);
    if (total === 0) { el.innerHTML = '<div class="cmd-empty-small">Нет заказов за 30 дней</div>'; return; }
    el.innerHTML = this.barChart(
      d.priceBuckets.map(b => b.count),
      d.priceBuckets.map(b => b.short),
      '#f59e0b',
      (_v, i) => `${d.priceBuckets[i].label}: ${d.priceBuckets[i].count} зак.`,
    );
  }

  // ── Мини-компоненты графиков ────────────────────────────────────
  private barChart(vals: number[], labels: string[], color: string, tip: (v: number, i: number) => string, thin = false): string {
    const max = Math.max(...vals, 1);
    const grad = `linear-gradient(180deg, color-mix(in srgb, ${color} 55%, white) 0%, ${color} 100%)`;
    return `<div class="cmd-bars ${thin ? 'cmd-bars-thin' : ''}">
      ${vals.map((v, i) => `<div class="cmd-bar-col" title="${labels[i] || i}: ${tip(v, i)}">
        <div class="cmd-bar-track"><div class="cmd-bar-fill" style="height:${(v / max) * 100}%;background:${grad}"></div></div>
        ${labels[i] ? `<div class="cmd-bar-lbl">${labels[i]}</div>` : (thin ? '' : '<div class="cmd-bar-lbl">&nbsp;</div>')}
      </div>`).join('')}
    </div>`;
  }

  private donut(segs: { label: string; value: number; color: string; sub?: string }[], centerVal: string, centerLbl: string): string {
    const total = segs.reduce((s, v) => s + v.value, 0) || 1;
    let acc = 0;
    const stops = segs.map(s => {
      const from = (acc / total) * 360;
      acc += s.value;
      const to = (acc / total) * 360;
      return `${s.color} ${from}deg ${to}deg`;
    }).join(', ');
    const valCls = centerVal.length > 8 ? 'cmd-donut-v cmd-donut-v-sm' : 'cmd-donut-v';
    return `<div class="cmd-donut-wrap">
      <div class="cmd-donut" style="background:conic-gradient(${stops})">
        <div class="cmd-donut-hole"><span class="${valCls}">${centerVal}</span><span class="cmd-donut-l">${centerLbl}</span></div>
      </div>
      <div class="cmd-donut-legend">${segs.map(s => `<div class="cmd-donut-li">
        <span class="cmd-donut-sw" style="background:${s.color}"></span>
        <span class="cmd-donut-name">${escHtml(s.label)}</span>
        <span class="cmd-donut-val">${s.sub ?? fmtInt(s.value)}</span>
      </div>`).join('')}</div>
    </div>`;
  }

  private mpTag(mp: string): string {
    return mp === 'ozon' ? 'OZ' : mp === 'yandex' ? 'ЯМ' : 'WB';
  }

  private timeAgo(d: Date): string {
    if (isNaN(d.getTime())) return '—';
    const ms = Date.now() - d.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч назад`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days} дн. назад`;
    return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
  }

  async viewProductFromDash(productId: string, boxId: string) {
    this.app.navigateTo('home');
    this.app.activeBoxId = boxId;
    const addBtn = document.getElementById('add-product-btn');
    if (addBtn) addBtn.style.display = 'flex';
    this.app.renderBoxes();

    if (!this.app.cache.has(boxId)) {
      await this.app.loadBoxProducts();
    } else {
      this.app.allProducts = this.app.cache.get(boxId)!;
      this.app.buildColumns();
      this.app.applyFilters();
      this.app.updateResultStat();
      const exportBtn = document.getElementById('export-btn');
      if (exportBtn && this.app.allProducts.length) exportBtn.style.display = 'flex';
    }
    this.app.viewProduct(productId);
  }
}
