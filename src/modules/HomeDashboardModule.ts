import { authService } from '../services/authService';
import { esc as escHtml } from '../utils/format';
import type { App } from '../App';
import {
  WIDGETS, loadLayout, saveLayout, resetLayout, resetDims,
  renderWidgetGrid, renderWidgetPicker,
  setWidgetDims, clampDims,
} from './HomeWidgets';

/**
 * Главная страница — командный центр с live-данными по заказам и виджетами.
 * Извлечён из App.ts (часть декомпозиции God Object).
 *
 * Обращается к состоянию/методам App через `this.app` (Facade): App.ts хранит
 * тонкие методы-делегаты с теми же именами, чтобы `onclick="window.app.*"`
 * в шаблонах продолжал работать без изменений.
 */
export class HomeDashboardModule {
  constructor(private app: App) {}

  private dashboardRefreshTimer: number | null = null;
  private homeEditMode = false;

  /** Полностью обновлённая Главная — командный центр с live-данными. */
  renderDashboard(): void {
    const content = document.getElementById('main-content');
    if (!content) return;

    const layout = loadLayout();
    const editMode = this.homeEditMode;

    content.innerHTML = `
      ${editMode ? `<style>
        @keyframes widget-wobble {
          0%,100%{transform:rotate(0deg) scale(1)}
          25%{transform:rotate(-0.22deg) scale(1.001)}
          75%{transform:rotate(0.22deg) scale(1.001)}
        }
        .cmd-widget.wobble{animation:widget-wobble 1.1s ease-in-out infinite;cursor:grab}
        .cmd-widget.wobble:active{cursor:grabbing}
        .cmd-widget.dragging{opacity:0.4;animation:none !important;transform:rotate(1.5deg) scale(0.97);box-shadow:0 16px 48px rgba(0,0,0,.28);z-index:99}
        .cmd-widget.drag-target{outline:2.5px dashed var(--accent);outline-offset:4px;background:color-mix(in srgb,var(--accent) 8%,var(--card));transform:scale(1.015)}
      </style>` : ''}
      <div class="cmd-wrap">

        <!-- ── Шапка дашборда ────────────────────────────────────────── -->
        <div class="cmd-header">
          <div>
            <div class="cmd-greeting">${this.greeting()}</div>
            <div class="cmd-subtitle">Командный центр · обновляется каждые 30 сек</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="cmd-edit-btn ${editMode ? 'active' : ''}" onclick="window.app.toggleHomeEdit()" title="${editMode ? 'Готово' : 'Настроить виджеты'}">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M9.5 2L12 4.5M2 12l1-3 7-7 2.5 2.5-7 7-3 1z"/></svg>
              <span>${editMode ? 'Готово' : 'Настроить'}</span>
            </button>
            <button class="cmd-refresh-btn" id="cmd-refresh-btn" onclick="window.app.refreshDashboard()" title="Обновить">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
                <path d="M13 7A6 6 0 1 1 7.5 1.1M13 1v4H9"/>
              </svg>
              <span id="cmd-last-update">только что</span>
            </button>
          </div>
        </div>

        ${editMode ? `
          <div class="cmd-edit-banner">
            <div style="flex:1">
              <div style="font-weight:600;font-size:13px">Режим настройки виджетов</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Перетаскивай виджеты для перестановки · растяни уголок ↘ для изменения размера · ✕ — убрать</div>
            </div>
            <button class="btn btn-primary" onclick="window.app.openWidgetPicker()" style="padding:6px 14px;font-size:12px">+ Виджет</button>
            <button class="btn" onclick="window.app.resetWidgetLayout()" style="padding:6px 14px;font-size:12px">Сбросить</button>
          </div>
        ` : ''}

        <!-- ── Сетка виджетов ──────────────────────────────────────────── -->
        <div class="cmd-widgets-grid ${editMode ? 'edit-mode' : ''}" id="cmd-widgets-grid">
          ${renderWidgetGrid(layout, editMode)}
        </div>

      </div>
    `;

    // Старт авто-обновления
    this.populateLiveCommandCenter().catch(err => console.error('[Home] live:', err));
    if (this.dashboardRefreshTimer) clearInterval(this.dashboardRefreshTimer);
    this.dashboardRefreshTimer = window.setInterval(() => {
      if (this.app.currentPage !== 'home') {
        clearInterval(this.dashboardRefreshTimer!);
        this.dashboardRefreshTimer = null;
        return;
      }
      this.populateLiveCommandCenter().catch(() => {});
    }, 30000);
  }

  private greeting(): string {
    const h = new Date().getHours();
    let g = '';
    if (h < 5)  g = 'Доброй ночи';
    else if (h < 12) g = 'Доброе утро';
    else if (h < 18) g = 'Добрый день';
    else g = 'Добрый вечер';

    const user = authService.getUser();
    if (user) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
      if (name) g += `, ${name}`;
    }
    return g;
  }

  refreshDashboard(): void {
    this.populateLiveCommandCenter().catch(() => {});
  }

  // ── Widget management ────────────────────────────────────────────
  toggleHomeEdit(): void {
    this.homeEditMode = !this.homeEditMode;
    this.renderDashboard();
  }

  removeWidget(id: string): void {
    const layout = loadLayout().filter(x => x !== id);
    saveLayout(layout);
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
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= layout.length) return;
    [layout[idx], layout[newIdx]] = [layout[newIdx], layout[idx]];
    saveLayout(layout);
    this.renderDashboard();
  }

  resetWidgetLayout(): void {
    if (!confirm('Сбросить раскладку виджетов к стандартной?')) return;
    resetLayout();
    resetDims();
    this.renderDashboard();
  }

  // ── Widget drag-and-drop (Live-swap как в iOS) ───────────────────
  private _dragWidgetId: string | null = null;
  private _dragLastSwap = 0;

  onWidgetDragStart(e: DragEvent, id: string): void {
    this._dragWidgetId = id;
    const el = e.currentTarget as HTMLElement;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      const ghost = document.createElement('div');
      ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => { ghost.remove(); });
    }
    requestAnimationFrame(() => el.classList.add('dragging'));
  }

  /** FLIP-drag: фиксируем позиции → переставляем → анимируем обратный сдвиг */
  onWidgetDragOver(e: DragEvent, el: HTMLElement, targetId: string): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const srcId = this._dragWidgetId;
    if (!srcId || srcId === targetId) return;

    // Throttle 160мс
    const now = Date.now();
    if (now - this._dragLastSwap < 160) return;
    this._dragLastSwap = now;

    const grid = document.getElementById('cmd-widgets-grid');
    if (!grid) return;
    const srcEl = grid.querySelector<HTMLElement>(`[data-widget-id="${srcId}"]`);
    const tgtEl = grid.querySelector<HTMLElement>(`[data-widget-id="${targetId}"]`);
    if (!srcEl || !tgtEl) return;

    // FLIP Step 1: запоминаем позиции до перестановки
    const widgets = Array.from(grid.querySelectorAll<HTMLElement>('.cmd-widget'));
    const beforeRects = new Map<string, DOMRect>();
    widgets.forEach(w => { const wid = w.dataset.widgetId; if (wid) beforeRects.set(wid, w.getBoundingClientRect()); });

    // Обновляем layout
    const layout = loadLayout();
    const si = layout.indexOf(srcId);
    let ti = layout.indexOf(targetId);
    if (si === -1 || ti === -1) return;
    layout.splice(si, 1);
    ti = layout.indexOf(targetId);
    const tgtRect = el.getBoundingClientRect();
    const insertBefore = (e.clientX - tgtRect.left) < tgtRect.width / 2;
    layout.splice(insertBefore ? ti : ti + 1, 0, srcId);
    saveLayout(layout);

    // DOM перестановка
    if (insertBefore) grid.insertBefore(srcEl, tgtEl);
    else tgtEl.after(srcEl);
    srcEl.classList.add('dragging');

    // FLIP Step 2: вычисляем дельту и применяем обратный transform + анимацию
    widgets.forEach(w => {
      const wid = w.dataset.widgetId;
      if (!wid || w === srcEl) return;
      const oldR = beforeRects.get(wid);
      const newR = w.getBoundingClientRect();
      if (!oldR) return;
      const dx = oldR.left - newR.left;
      const dy = oldR.top  - newR.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      w.style.transition = 'none';
      w.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        w.style.transition = 'transform 0.25s cubic-bezier(.4,0,.2,1)';
        w.style.transform = '';
      }));
    });
  }

  onWidgetDragLeave(_el: HTMLElement): void { /* no-op */ }

  onWidgetDragEnd(): void {
    const grid = document.getElementById('cmd-widgets-grid');
    if (grid) {
      grid.querySelectorAll<HTMLElement>('.cmd-widget').forEach(w => {
        w.classList.remove('dragging', 'drag-target');
        w.style.transform = '';
        w.style.transition = '';
      });
    }
    this._dragWidgetId = null;
    this.renderDashboard();
  }

  onWidgetDrop(e: DragEvent, _targetId: string): void {
    e.preventDefault();
    this.onWidgetDragEnd();
  }

  // ── Widget resize (drag-to-resize handle) ────────────────────────
  private _resizeState: {
    id: string; startX: number; startY: number;
    startCw: number; startRh: number; cellW: number; cellH: number;
  } | null = null;

  onWidgetResizeStart(e: MouseEvent | TouchEvent, id: string): void {
    e.preventDefault();
    e.stopPropagation();
    const widget = document.querySelector(`[data-widget-id="${id}"]`) as HTMLElement;
    const grid = document.getElementById('cmd-widgets-grid');
    if (!widget || !grid) return;

    const gridStyle = getComputedStyle(grid);
    const colCount = 4;
    const gap = parseFloat(gridStyle.gap) || 12;
    const cellW = (grid.clientWidth - gap * (colCount - 1)) / colCount;
    const cellH = 110; // должно совпадать с grid-auto-rows в CSS

    const isTouch = 'touches' in e;
    const startX = isTouch ? e.touches[0].clientX : e.clientX;
    const startY = isTouch ? e.touches[0].clientY : e.clientY;
    const startCw = parseInt(widget.dataset.cw || '1');
    const startRh = parseInt(widget.dataset.rh || '1');

    this._resizeState = { id, startX, startY, startCw, startRh, cellW, cellH };
    widget.classList.add('resizing');

    const onMove = (ev: MouseEvent | TouchEvent) => this.onWidgetResizeMove(ev);
    const onEnd = () => this.onWidgetResizeEnd(onMove, onEnd);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  }

  private onWidgetResizeMove(e: MouseEvent | TouchEvent): void {
    const st = this._resizeState;
    if (!st) return;
    if ('touches' in e) e.preventDefault();
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const dx = x - st.startX;
    const dy = y - st.startY;
    const newCw = st.startCw + Math.round(dx / (st.cellW + 12));
    const newRh = st.startRh + Math.round(dy / (st.cellH + 12));
    const clamped = clampDims(st.id, newCw, newRh);
    const widget = document.querySelector(`[data-widget-id="${st.id}"]`) as HTMLElement;
    if (!widget) return;
    // Меняем CSS классы в реальном времени
    widget.className = widget.className.replace(/cmd-widget-cw\d/g, '').replace(/cmd-widget-rh\d/g, '');
    widget.classList.add(`cmd-widget-cw${clamped.cw}`, `cmd-widget-rh${clamped.rh}`);
    widget.dataset.cw = String(clamped.cw);
    widget.dataset.rh = String(clamped.rh);
  }

  private onWidgetResizeEnd(onMove: (e: any) => void, onEnd: () => void): void {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);
    const st = this._resizeState;
    if (!st) return;
    const widget = document.querySelector(`[data-widget-id="${st.id}"]`) as HTMLElement | null;
    if (widget) {
      widget.classList.remove('resizing');
      const cw = parseInt(widget.dataset.cw || String(st.startCw));
      const rh = parseInt(widget.dataset.rh || String(st.startRh));
      setWidgetDims(st.id, clampDims(st.id, cw, rh));
    }
    this._resizeState = null;
  }

  openWidgetPicker(): void {
    const layout = loadLayout();
    this.app.openModalLg(
      'Виджеты дашборда',
      `Нажми на виджет чтобы добавить его · всего ${Object.keys(WIDGETS).length} виджетов`,
      `<div style="padding:4px 2px">${renderWidgetPicker(layout)}</div>`,
      `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>`
    );
  }

  private _liveDataCache: any = null;
  private _liveDataCacheTime = 0;
  private _liveDataFetching = false;

  /**
   * Подтянуть данные заказов из всех МП и заполнить виджеты Главной.
   * Кэширует результат на 25 сек — повторный вызов мгновенный.
   */
  private async populateLiveCommandCenter(): Promise<void> {
    // Если данные свежие (< 25 сек) — используем кэш мгновенно
    if (this._liveDataCache && Date.now() - this._liveDataCacheTime < 25000) {
      this._applyLiveData(this._liveDataCache);
      return;
    }
    // Защита от параллельных запросов
    if (this._liveDataFetching) return;
    this._liveDataFetching = true;

    const btn = document.getElementById('cmd-refresh-btn');
    btn?.classList.add('spinning');

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
    const dd = (d: Date) => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    const ymFrom = dd(since30);
    const ymTo = dd(now);
    const wbFrom = sinceIso.slice(0, 19);

    type UOrder = {
      mp: 'ozon' | 'yandex' | 'wb';
      id: string;
      status: string;
      isNew: boolean;
      isShip: boolean;          // надо отгрузить сегодня
      created: Date;
      total: number;
      productName: string;
      storeId: string;
      storeName: string;
      storeColor: string;
      storeIdx: number;
    };
    const all: UOrder[] = [];

    interface StoreCard {
      mp: 'ozon' | 'yandex' | 'wb';
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
      lastActivity: Date | null;
      connected: boolean;
    }
    const storeCards: StoreCard[] = [];

    const [ozStores, ymStores, wbStores] = await Promise.all([
      ozonDb.getStores().catch(() => []),
      yandexDb.getStores().catch(() => []),
      wbDb.getStores().catch(() => []),
    ]);

    if (ozStores.length + ymStores.length + wbStores.length === 0) {
      // Нет магазинов
      const html = `
        <div class="cmd-empty-state">
          <div class="cmd-empty-icon">🔌</div>
          <div class="cmd-empty-title">Магазины не подключены</div>
          <div class="cmd-empty-sub">Подключи Ozon, Яндекс Маркет или Wildberries — и здесь появится вся важная инфа в реальном времени.</div>
          <button class="btn btn-primary" onclick="window.app.navigateTo('marketplaces')" style="margin-top:16px">Подключить →</button>
        </div>`;
      document.getElementById('cmd-stores-grid')!.innerHTML = html;
      document.getElementById('cmd-live-feed')!.innerHTML = '';
      document.getElementById('cmd-actions-list')!.innerHTML = '';
      ['today','new','ship','payouts'].forEach(k => {
        const v = document.querySelector<HTMLElement>(`#cmd-kpi-${k} .cmd-kpi-val`);
        if (v) v.textContent = '0';
      });
      btn?.classList.remove('spinning');
      return;
    }

    // Цвета для магазинов (по индексу внутри МП)
    const ozColors = ['#4ade80','#60a5fa','#f472b6','#fb923c','#a78bfa','#34d399'];
    const ymColors = ['#fc3f1d','#fb923c','#ef4444','#dc2626'];
    const wbColors = ['#cb11ab','#9333ea','#a855f7','#c026d3'];

    const orderPromises: Promise<void>[] = [];

    ozStores.forEach((store, idx) => {
      const card: StoreCard = {
        mp: 'ozon', mpName: 'Ozon', mpColor: '#005bff',
        storeId: store.id, storeName: store.name,
        revenue30: 0, revenueToday: 0, orders30: 0, ordersToday: 0,
        newCount: 0, shipUrgent: 0, lastActivity: null, connected: false,
      };
      storeCards.push(card);
      orderPromises.push((async () => {
        try {
          const creds = { client_id: store.client_id, api_key: store.api_key };
          // Fetch FBS + FBO in parallel; ignore whichever fails (FBO-only stores have no FBS, etc.)
          type OzPost = Awaited<ReturnType<typeof ozonOrdersApi.getFboPostings>>;
          const [fbsPosts, fboPosts]: [OzPost, OzPost] = await Promise.all([
            fetchAllPagesByCursor(
              (lim, cursor, sig) => ozonOrdersApi.getFbsPostings(creds, sinceIso, toIso, null, lim, cursor, sig),
              50,
            ).catch(() => [] as OzPost),
            fetchAllPages(
              (lim, off, sig) => ozonOrdersApi.getFboPostings(creds, sinceIso, toIso, lim, off as number, sig),
              50,
            ).catch(() => [] as OzPost),
          ]);
          const posts = [...fbsPosts, ...fboPosts];
          card.connected = true;
          for (const p of posts) {
            if (p.status === 'cancelled') continue;
            const total = p.products.reduce((s, pr) => s + (parseFloat(pr.price) || 0) * pr.quantity, 0);
            const created = new Date(p.created_at || p.in_process_at || '');
            const ship = p.shipment_date ? new Date(p.shipment_date) : null;
            const isToday = created.getTime() >= todayStart.getTime();
            const isNew = p.status === 'awaiting_packaging';
            const isShip = (p.status === 'awaiting_packaging' || p.status === 'awaiting_deliver') &&
                           ship !== null && ship.getTime() <= now.getTime() + 86_400_000;
            card.revenue30 += total;
            card.orders30++;
            if (isToday) { card.revenueToday += total; card.ordersToday++; }
            if (isNew) card.newCount++;
            if (isShip) card.shipUrgent++;
            if (!card.lastActivity || created > card.lastActivity) card.lastActivity = created;
            all.push({
              mp: 'ozon', id: p.posting_number, status: p.status,
              isNew, isShip, created, total,
              productName: p.products[0]?.name ?? p.products[0]?.offer_id ?? '',
              storeId: store.id, storeName: store.name, storeColor: ozColors[idx % ozColors.length],
              storeIdx: idx,
            });
          }
        } catch (err: any) {
          console.warn('[Home] Ozon:', err?.message ?? err);
        }
      })());
    });

    ymStores.forEach((store, idx) => {
      const card: StoreCard = {
        mp: 'yandex', mpName: 'Яндекс Маркет', mpColor: '#fc3f1d',
        storeId: store.id, storeName: store.name,
        revenue30: 0, revenueToday: 0, orders30: 0, ordersToday: 0,
        newCount: 0, shipUrgent: 0, lastActivity: null, connected: false,
      };
      storeCards.push(card);
      orderPromises.push((async () => {
        try {
          const orders = await fetchAllYandexOrders(store, ymFrom, ymTo);
          card.connected = true;
          for (const o of orders) {
            if (o.status === 'CANCELLED') continue;
            const created = new Date(o.creation_date);
            const isToday = created.getTime() >= todayStart.getTime();
            const isNew = o.status === 'PROCESSING';
            card.revenue30 += o.total;
            card.orders30++;
            if (isToday) { card.revenueToday += o.total; card.ordersToday++; }
            if (isNew) { card.newCount++; card.shipUrgent++; }
            if (!card.lastActivity || created > card.lastActivity) card.lastActivity = created;
            all.push({
              mp: 'yandex', id: String(o.id), status: o.status,
              isNew, isShip: isNew, created, total: o.total,
              productName: o.items[0]?.name ?? '',
              storeId: store.id, storeName: store.name, storeColor: ymColors[idx % ymColors.length],
              storeIdx: idx,
            });
          }
        } catch (err: any) {
          console.warn('[Home] YM:', err?.message ?? err);
        }
      })());
    });

    wbStores.forEach((store, idx) => {
      const card: StoreCard = {
        mp: 'wb', mpName: 'Wildberries', mpColor: '#cb11ab',
        storeId: store.id, storeName: store.name,
        revenue30: 0, revenueToday: 0, orders30: 0, ordersToday: 0,
        newCount: 0, shipUrgent: 0, lastActivity: null, connected: false,
      };
      storeCards.push(card);
      orderPromises.push((async () => {
        if (isWbCoolingDown()) {
          // Fast-skip пока WB rate-limit активен. Карточка останется как есть.
          return;
        }
        try {
          const orders = await fetchAllWbOrders(store, wbFrom);
          card.connected = true;
          for (const o of orders) {
            if (o.status === 'cancel') continue;
            const created = new Date(o.created_at);
            const isToday = created.getTime() >= todayStart.getTime();
            const isNew = o.status === 'new';
            card.revenue30 += o.total;
            card.orders30++;
            if (isToday) { card.revenueToday += o.total; card.ordersToday++; }
            if (isNew) { card.newCount++; card.shipUrgent++; }
            if (!card.lastActivity || created > card.lastActivity) card.lastActivity = created;
            all.push({
              mp: 'wb', id: String(o.id), status: o.status,
              isNew, isShip: isNew, created, total: o.total,
              productName: o.items[0]?.name ?? '',
              storeId: store.id, storeName: store.name, storeColor: wbColors[idx % wbColors.length],
              storeIdx: idx,
            });
          }
        } catch (err: any) {
          console.warn('[Home] WB:', err?.message ?? err);
        }
      })());
    });

    await Promise.all(orderPromises);

    // ── Расчёт суммарных KPI ──────────────────────────────────────
    const todayRevenue = all.filter(o => o.created >= todayStart).reduce((s, o) => s + o.total, 0);
    const newCount = all.filter(o => o.isNew).length;
    const shipCount = all.filter(o => o.isShip).length;
    // Ожидаемая выплата ≈ выручка за 30 дней - примерные комиссии
    // (Точные балансы получить через единый API не получится — Ozon не отдаёт, YM/WB тоже)
    // Берём грубую оценку: 85% от 30-дневной выручки
    const totalRev30 = storeCards.reduce((s, c) => s + c.revenue30, 0);
    const pendingPayouts = Math.round(totalRev30 * 0.85);

    const setKpi = (id: string, val: string, color?: string) => {
      const valEl = document.querySelector<HTMLElement>(`#cmd-kpi-${id} .cmd-kpi-val`);
      if (valEl) {
        valEl.textContent = val;
        if (color) valEl.style.color = color;
      }
    };
    setKpi('today',   Math.round(todayRevenue).toLocaleString('ru') + ' ₽', todayRevenue > 0 ? '#16a34a' : undefined);
    setKpi('new',     newCount.toLocaleString('ru'), newCount > 0 ? '#ea580c' : 'var(--muted)');
    setKpi('ship',    shipCount.toLocaleString('ru'), shipCount > 0 ? '#dc2626' : 'var(--muted)');
    setKpi('payouts', pendingPayouts.toLocaleString('ru') + ' ₽', '#005bff');

    // ── Магазины и финансы ────────────────────────────────────────
    const grid = document.getElementById('cmd-stores-grid');
    const sfFooter = document.getElementById('sf-footer') as HTMLElement | null;
    if (grid) {
      if (storeCards.length === 0) {
        grid.innerHTML = '<div class="sf-loading">Нет подключённых магазинов</div>';
        if (sfFooter) sfFooter.style.display = 'none';
      } else {
        const totalRev  = storeCards.reduce((s, c) => s + c.revenue30,   0);
        const totalOrd  = storeCards.reduce((s, c) => s + c.orders30,    0);
        const totalNew  = storeCards.reduce((s, c) => s + c.newCount,    0);
        const totalShip = storeCards.reduce((s, c) => s + c.shipUrgent,  0);

        grid.innerHTML = storeCards.map(c => {
          const lastAgo = c.lastActivity ? this.timeAgo(c.lastActivity) : 'нет данных';
          const statusCls = c.connected
            ? (c.lastActivity && c.lastActivity.getTime() > now.getTime() - 7 * 86_400_000 ? 'live' : 'idle')
            : 'off';
          const dest = c.mp === 'ozon' ? 'orders-ozon' : c.mp === 'yandex' ? 'orders-yandex' : 'orders-wb';
          return `
            <div class="sf-row" style="--c:${c.mpColor}" onclick="window.app.navigateTo('${dest}')"
              title="${escHtml(c.storeName)} · ${lastAgo}">
              <span class="sf-dot"></span>
              <span class="sf-name">${escHtml(c.storeName)}</span>
              <span class="sf-mp">${c.mpName}</span>
              <span class="sf-rev">${Math.round(c.revenue30).toLocaleString('ru')} ₽</span>
              <span class="sf-orders">${c.orders30} зак.</span>
              <span class="sf-tags">
                ${c.newCount    > 0 ? `<span class="sf-badge sf-new">+${c.newCount}</span>` : ''}
                ${c.shipUrgent > 0 ? `<span class="sf-badge sf-urg">⏰${c.shipUrgent}</span>` : ''}
                ${c.ordersToday > 0 ? `<span class="sf-badge sf-today" title="Сегодня">▲${c.ordersToday}</span>` : ''}
              </span>
              <span class="sf-status ${statusCls}" title="${c.connected ? 'Активен · ' + lastAgo : 'Нет ответа'}"></span>
            </div>`;
        }).join('');

        if (sfFooter) {
          sfFooter.style.display = '';
          sfFooter.innerHTML = `
            <span class="sf-footer-label">Итого 30 дн.</span>
            <span class="sf-footer-rev">${Math.round(totalRev).toLocaleString('ru')} ₽</span>
            <span class="sf-footer-ord">${totalOrd} зак.</span>
            ${totalShip > 0 ? `<span class="sf-footer-badge sf-urg">⏰ ${totalShip}</span>` : ''}
            ${totalNew  > 0 ? `<span class="sf-footer-badge sf-new">+${totalNew} новых</span>` : ''}
          `;
        }
      }
    }

    // ── Live-лента (последние 12 заказов) ─────────────────────────
    const recent = [...all].sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, 12);
    const feed = document.getElementById('cmd-live-feed');
    if (feed) {
      feed.innerHTML = recent.length === 0
        ? '<div class="cmd-empty-small">Нет заказов за 30 дней</div>'
        : recent.map(o => `
          <div class="cmd-feed-item" onclick="window.app.navigateTo('orders')">
            <div class="cmd-feed-time" title="${o.created.toLocaleString('ru')}">${this.timeAgo(o.created)}</div>
            <div class="cmd-feed-dot" style="background:${o.storeColor}"></div>
            <div class="cmd-feed-info">
              <div class="cmd-feed-name">${escHtml(o.productName || o.id)}</div>
              <div class="cmd-feed-meta">
                <span class="cmd-feed-mp cmd-feed-mp-${o.mp}">${o.mp === 'ozon' ? 'OZ' : o.mp === 'yandex' ? 'ЯМ' : 'WB'}</span>
                ${escHtml(o.storeName)}
                ${o.isNew ? ' · <span style="color:#ea580c;font-weight:700">НОВЫЙ</span>' : ''}
              </div>
            </div>
            <div class="cmd-feed-amount">${Math.round(o.total).toLocaleString('ru')} ₽</div>
          </div>
        `).join('');
    }

    // ── Список требующих действий (срочное) ───────────────────────
    const urgent = all.filter(o => o.isShip).sort((a, b) => a.created.getTime() - b.created.getTime()).slice(0, 8);
    const actions = document.getElementById('cmd-actions-list');
    if (actions) {
      actions.innerHTML = urgent.length === 0
        ? '<div class="cmd-empty-small" style="color:#16a34a">✓ Все заказы в работе</div>'
        : `
          <div class="cmd-urgent-summary">
            ⚡ <b>${urgent.length}</b> заказ${urgent.length === 1 ? '' : urgent.length < 5 ? 'а' : 'ов'} требуют отгрузки
          </div>
          ${urgent.map(o => `
            <div class="cmd-action-item" onclick="window.app.navigateTo('orders-${o.mp === 'ozon' ? 'ozon' : o.mp === 'yandex' ? 'yandex' : 'wb'}')">
              <span class="cmd-feed-mp cmd-feed-mp-${o.mp}">${o.mp === 'ozon' ? 'OZ' : o.mp === 'yandex' ? 'ЯМ' : 'WB'}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(o.productName || o.id)}</div>
                <div style="font-size:10px;color:var(--text3);margin-top:2px">${escHtml(o.storeName)} · создан ${this.timeAgo(o.created)}</div>
              </div>
              <div style="font-size:12px;font-weight:700;white-space:nowrap">${Math.round(o.total).toLocaleString('ru')} ₽</div>
            </div>
          `).join('')}
          <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="window.app.navigateTo('orders')">Перейти ко всем заказам →</button>
        `;
    }

    // ── Extra widgets ─────────────────────────────────────────────

    // Units 30 + средний чек
    const totalUnits30 = all.length; // each entry is one item line
    const totalOrders30 = new Set(all.map(o => `${o.mp}-${o.id}`)).size;
    const avgCheck = totalOrders30 > 0 ? totalRev30 / totalOrders30 : 0;
    const setKpiVal = (id: string, val: string, color?: string) => {
      const el = document.querySelector<HTMLElement>(`#${id} .cmd-kpi-val`);
      if (el) { el.textContent = val; if (color) el.style.color = color; }
    };
    setKpiVal('cmd-kpi-units30', totalUnits30.toLocaleString('ru'), totalUnits30 > 0 ? '#7c3aed' : undefined);
    setKpiVal('cmd-kpi-avgcheck', Math.round(avgCheck).toLocaleString('ru') + ' ₽', avgCheck > 0 ? '#0891b2' : undefined);

    // MP-share donut
    const mpShareEl = document.getElementById('cmd-mp-share');
    if (mpShareEl) {
      const byMp = new Map<string, { rev: number; orders: number; color: string; name: string }>();
      for (const c of storeCards) {
        const cur = byMp.get(c.mp) ?? { rev: 0, orders: 0, color: c.mpColor, name: c.mpName };
        cur.rev += c.revenue30;
        cur.orders += c.orders30;
        byMp.set(c.mp, cur);
      }
      const total = [...byMp.values()].reduce((s, v) => s + v.rev, 0);
      const rows = [...byMp.entries()];
      mpShareEl.innerHTML = rows.length === 0
        ? '<div class="cmd-empty-small">Нет данных</div>'
        : `<div style="padding:12px 14px">
            ${rows.map(([_, v]) => {
              const pct = total > 0 ? (v.rev / total) * 100 : 0;
              return `
                <div style="margin-bottom:10px">
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                    <span style="font-weight:600">${escHtml(v.name)} · ${v.orders} зак.</span>
                    <span style="color:var(--muted)">${pct.toFixed(1)}%</span>
                  </div>
                  <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${v.color}"></div>
                  </div>
                  <div style="font-size:11px;color:var(--muted);margin-top:3px">${Math.round(v.rev).toLocaleString('ru')} ₽</div>
                </div>
              `;
            }).join('')}
           </div>`;
    }

    // Revenue 7d sparkline
    const rev7dEl = document.getElementById('cmd-revenue-7d');
    if (rev7dEl) {
      const days = 7;
      const buckets: { date: Date; revenue: number }[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
        buckets.push({ date: d, revenue: 0 });
      }
      const startMs = buckets[0].date.getTime();
      for (const o of all) {
        const ms = o.created.getTime();
        if (ms < startMs) continue;
        const dayIdx = Math.min(days - 1, Math.floor((ms - startMs) / 86_400_000));
        if (dayIdx >= 0) buckets[dayIdx].revenue += o.total;
      }
      const max = Math.max(...buckets.map(b => b.revenue), 1);
      const total7d = buckets.reduce((s, b) => s + b.revenue, 0);
      rev7dEl.innerHTML = `
        <div style="font-size:18px;font-weight:700;margin-bottom:2px">${Math.round(total7d).toLocaleString('ru')} ₽</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Всего за 7 дней</div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:80px">
          ${buckets.map(b => `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${b.date.toLocaleDateString('ru')} · ${Math.round(b.revenue).toLocaleString('ru')} ₽">
              <div style="flex:1;width:100%;display:flex;align-items:flex-end">
                <div style="width:100%;background:#005bff;border-radius:4px 4px 0 0;height:${(b.revenue / max) * 100}%;min-height:2px;transition:height .3s"></div>
              </div>
              <div style="font-size:9px;color:var(--muted)">${String(b.date.getDate()).padStart(2,'0')}.${String(b.date.getMonth()+1).padStart(2,'0')}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Top products
    const topEl = document.getElementById('cmd-top-products');
    if (topEl) {
      const byProduct = new Map<string, { name: string; revenue: number; count: number; mp: string }>();
      for (const o of all) {
        const key = `${o.mp}|${o.productName || o.id}`;
        const cur = byProduct.get(key) ?? { name: o.productName || o.id, revenue: 0, count: 0, mp: o.mp };
        cur.revenue += o.total;
        cur.count += 1;
        byProduct.set(key, cur);
      }
      const top = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
      topEl.innerHTML = top.length === 0
        ? '<div class="cmd-empty-small">Нет продаж за 30 дней</div>'
        : `<div style="padding:8px 14px 14px">
            ${top.map((p, i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:14px;font-weight:700;color:var(--muted);width:18px">${i + 1}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</div>
                  <div style="font-size:10px;color:var(--muted);margin-top:1px">${p.count} зак. · ${p.mp === 'ozon' ? 'OZ' : p.mp === 'yandex' ? 'ЯМ' : 'WB'}</div>
                </div>
                <div style="font-size:12px;font-weight:700;white-space:nowrap">${Math.round(p.revenue).toLocaleString('ru')} ₽</div>
              </div>
            `).join('')}
           </div>`;
    }

    // Update timestamp
    const ts = document.getElementById('cmd-last-update');
    if (ts) ts.textContent = 'только что';
    btn?.classList.remove('spinning');
    this._liveDataFetching = false;
    this._liveDataCache = true; // Mark cache as valid
    this._liveDataCacheTime = Date.now();
    // Cycle "X сек назад" каждые 10 сек
    setTimeout(() => {
      const el = document.getElementById('cmd-last-update');
      if (el && this.app.currentPage === 'home') el.textContent = '10 сек назад';
    }, 10000);
  }

  /** Применяет кэшированные live-данные (KPI обновление без сетевых запросов) */
  private _applyLiveData(_cache: any): void {
    // Cache для KPI не нужен отдельно — полный рефреш происходит каждые 30 сек,
    // а кэш предотвращает дублирование при быстрых перерендерах
    const ts = document.getElementById('cmd-last-update');
    if (ts) {
      const sec = Math.floor((Date.now() - this._liveDataCacheTime) / 1000);
      ts.textContent = sec < 5 ? 'только что' : `${sec} сек назад`;
    }
  }

  private timeAgo(d: Date): string {
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
    this.app.navigateTo('products');
    this.app.activeBoxId = boxId;
    const addBtn = document.getElementById('add-product-btn');
    if (addBtn) addBtn.style.display = 'flex';
    this.app.renderBoxes();

    // Load the box if not cached
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
