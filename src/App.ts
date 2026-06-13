import * as XLSX from 'xlsx';
import { Product } from './types';
import { boxes, boxActions } from './stores/appStore';
import { apiService } from './services/api';
import { idbCache } from './services/idbCache';
import { esc as escHtml, productSuffix, escapeRegex, extractFirstEmoji, parsePhotoUrls } from './utils/format';
import { customColumnsDb } from './services/customColumnsDb';
import { costPriceDb } from './services/costPriceDb';
import { dimensionsDb } from './services/dimensionsDb';
import { repricerRulesDb } from './services/repricerRulesDb';
import { HomeDashboardModule } from './modules/HomeDashboardModule';
import { MassActionsModule } from './modules/MassActionsModule';

export class App {
  /** Главная страница — командный центр и виджеты (см. modules/HomeDashboardModule.ts). */
  private dashboard = new HomeDashboardModule(this);
  /** Массовые операции, синхронизация каталога с МП, mass fill (см. modules/MassActionsModule.ts). */
  private massActions = new MassActionsModule(this);

  // ── UI state ──────────────────────────────────────────────────────────────
  allProducts: Product[] = [];
  filtered: Product[] = [];
  columns: string[] = [];
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';
  private priceSort: 'asc' | 'desc' | null = null;
  private searchQ = '';
  activeBoxId: string | null = null;
  private loadToken = 0;
  viewMode: 'table' | 'cards' = 'table';
  currentPage: 'home' | 'products' | 'orders' | 'ozon' = 'home';

  // ── Скрытые строки (товары) ───────────────────────────────────────────────
  // Map<boxId, Set<productId>>
  hiddenRows = new Map<string, Set<string>>();
  private showHiddenRows = false;

  // ── Видимые столбцы таблицы ───────────────────────────────────────────────
  // null = показывать все; иначе — Set столбцов которые видны
  visibleCols: Set<string> | null = null;
  private columnOrder = new Map<string, string[]>();

  // ── MP presence: артикул (lowercase) → массив магазинов где найден товар
  private mpPresence: Map<string, Array<{ mp: 'wb' | 'ozon' | 'yandex'; storeId: string; storeName: string; color: string }>> = new Map();

  // ── Drag-and-drop state ───────────────────────────────────────────────────
  private dragFromIdx: number | null = null;
  private dragColIdx: number | null = null;

  async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Скопировано: ' + text, 'success', 1500);
    } catch (err) {
      this.toast('Ошибка при копировании', 'error');
    }
  }

  // ── Import state ──────────────────────────────────────────────────────────
  private parsedImport: { filename: string; headers: string[]; rows: any[][]; format: string; templateHeaders?: any[][]; template_file_b64?: string } | null = null;
  private importCtx: {
    boxId: string;
    selColIdxs: Set<number>;
    selRowIdxs: Set<number>;
    filename: string;
    headers: string[];
    rows: any[][];
    templateHeaders?: any[][];
    template_file_b64?: string;
    artIdx: number;
    existingArts: Set<string>;
    btn: HTMLButtonElement | null;
  } | null = null;

  // ── Selection state ───────────────────────────────────────────────────────
  selectedProducts: Set<string> = new Set();

  // ── Cache ─────────────────────────────────────────────────────────────────
  cache = new Map<string, Product[]>();

  // ── Virtual table ─────────────────────────────────────────────────────────
  private vt: {
    el: HTMLElement | null;
    colKey: string;
    cols: string[];
    hasPhoto: boolean;
    rowH: number;
  } = { el: null, colKey: '', cols: [], hasPhoto: false, rowH: 48 };

  // ── Misc ──────────────────────────────────────────────────────────────────
  private pendingDelete: { boxId?: string; col?: string; prodId?: string; art?: string } | null = null;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  async init() {
    // Restore hidden rows from localStorage
    try {
      const hr = JSON.parse(localStorage.getItem('app_hidden_rows') || '{}');
      for (const [bid, ids] of Object.entries(hr)) {
        this.hiddenRows.set(bid, new Set(ids as string[]));
      }
    } catch {}
    // Restore visible cols from localStorage
    try {
      const vc = JSON.parse(localStorage.getItem('app_visible_cols') || 'null');
      if (Array.isArray(vc)) this.visibleCols = new Set(vc);
    } catch {}
    // Restore column order from localStorage
    try {
      const co = JSON.parse(localStorage.getItem('app_column_order') || '{}');
      for (const [bid, cols] of Object.entries(co)) {
        this.columnOrder.set(bid, cols as string[]);
      }
    } catch {}

    const list = document.getElementById('boxes-list');
    if (list) list.innerHTML = this.skeletonBoxes(4);
    // Open IDB (non-blocking, failures are ignored)
    idbCache.open().catch(() => {});
    // Pre-fill repricer rules cache so product cards show correct rule status
    repricerRulesDb.refresh().catch(() => {});

    try {
      await boxActions.loadBoxes();
      this.renderBoxes();
      // Restore all boxes from IDB into memory cache, then refresh from network
      this.warmCacheFromIdb();
    } catch (e: any) {
      if (list) list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--red)">Ошибка подключения к БД.</div>';
      this.toast('Ошибка БД: ' + e.message, 'error', 6000);
    }

    // ── Reactive store: auto re-render on future box changes ────────────────
    // Placed AFTER loadBoxes to avoid replacing skeleton UI during initial load.
    // subscribe() fires listener immediately, so first render is handled above.
    boxes.subscribe(() => {
      this.renderBoxes();
      if (this.currentPage === 'home') this.renderDashboard();
    });

    const searchInp = document.getElementById('search-inp') as HTMLInputElement;
    if (searchInp) searchInp.addEventListener('input', e => this.onSearch((e.target as HTMLInputElement).value));

    document.getElementById('overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('overlay')) this.closeModal();
    });

    const backdrop = document.getElementById('ms-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => this.closeMobileSheets());

    const lastPage = (localStorage.getItem('last_page') as any) ?? 'home';
    await this.navigateTo(lastPage, { loadAll: lastPage === 'products' });
    // Восстанавливаем выбранную группу товаров после обновления страницы
    if (lastPage === 'products') {
      const lastBoxId = localStorage.getItem('last_box_id');
      if (lastBoxId && boxes.get().some(b => b.id === lastBoxId)) {
        await this.selectBox(lastBoxId);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITY — delegates to src/utils/format.ts (pure, testable functions)
  // ─────────────────────────────────────────────────────────────────────────

  esc(s: unknown): string { return escHtml(s); }
  private suf(n: number): string { return productSuffix(n); }
  private escapeRegex(s: string): string { return escapeRegex(s); }
  private extractFirstEmoji(s: string): string { return extractFirstEmoji(s); }

  toast(msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'info', ms = 3000) {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut .2s ease forwards';
      setTimeout(() => el.remove(), 200);
    }, ms);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SKELETON LOADERS
  // ─────────────────────────────────────────────────────────────────────────

  private skeletonCards(count = 8): string {
    let s = '<div class="cards-wrap">';
    for (let i = 0; i < count; i++) {
      s += `<div class="sk-card">
        <div class="sk sk-photo"></div>
        <div class="sk-body">
          <div class="sk sk-row short"></div>
          <div class="sk sk-row mid"></div>
          <div class="sk sk-row tall short"></div>
        </div>
      </div>`;
    }
    return s + '</div>';
  }

  private skeletonTable(rows = 10): string {
    let s = '<div class="table-wrap"><div style="padding:0">';
    for (let i = 0; i < rows; i++) {
      s += `<div class="sk-table-row">
        <div class="sk"></div>
        <div class="sk"></div>
        <div class="sk"></div>
        <div class="sk" style="flex:.6"></div>
      </div>`;
    }
    return s + '</div></div>';
  }

  private skeletonBoxes(count = 4): string {
    let s = '';
    for (let i = 0; i < count; i++) {
      s += `<div class="box-item" style="cursor:default;pointer-events:none">
        <div class="sk" style="width:20px;height:20px;border-radius:5px"></div>
        <div class="box-meta" style="display:flex;flex-direction:column;gap:5px">
          <div class="sk" style="height:11px;width:${60 + Math.random() * 30}%"></div>
          <div class="sk" style="height:9px;width:40%"></div>
        </div>
      </div>`;
    }
    return s;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODAL
  // ─────────────────────────────────────────────────────────────────────────

  openModal(title: string, sub: string, body: string, foot: string, large = false) {
    const modal = document.getElementById('modal');
    if (modal) {
      modal.classList.toggle('modal-lg', large);
    }
    const titleEl = document.getElementById('modal-title');
    const subEl = document.getElementById('modal-sub');
    const bodyEl = document.getElementById('modal-body');
    const footEl = document.getElementById('modal-foot');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.innerHTML = sub || '';
    if (bodyEl) bodyEl.innerHTML = body;
    if (footEl) footEl.innerHTML = foot;
    document.getElementById('overlay')?.classList.add('on');
  }

  openModalLg(title: string, sub: string, body: string, foot: string) {
    this.openModal(title, sub, body, foot, true);
  }

  closeModal() {
    document.getElementById('overlay')?.classList.remove('on');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOXES
  // ─────────────────────────────────────────────────────────────────────────

  renderBoxes() {
    const el = document.getElementById('boxes-list');
    if (!el) return;
    const boxList = boxes.get();

    if (!boxList.length) {
      el.innerHTML = `
        <div style="padding:16px 14px;font-size:12px;color:var(--text3);line-height:1.6;text-align:center">
          Нет магазинов<br>
          <span style="font-size:11px">Нажмите «Синхр. с МП» чтобы подключить маркетплейс</span>
        </div>`;
      this.renderMobileBoxes();
      return;
    }

    // Группируем по источнику
    const ozonBoxes   = boxList.filter(b => b.mp_source === 'ozon');
    const ymBoxes     = boxList.filter(b => b.mp_source === 'ym');
    const wbBoxes     = boxList.filter(b => (b.mp_source as string) === 'wb');
    const manualBoxes = boxList.filter(b => !b.mp_source);

    const mpColor: Record<string, string> = {
      ozon: '#005bff', ym: '#f4a000', wb: '#cb11ab', manual: 'var(--muted)',
    };

    const renderBox = (b: import('./types').Box) => {
      const isActive = b.id === this.activeBoxId;
      const lastSync = b.mp_last_sync
        ? new Date(b.mp_last_sync).toLocaleDateString('ru', { day: '2-digit', month: '2-digit' })
        : null;

      // FBO/FBS/DBS из названия или метаданных
      const nameLower = b.name.toLowerCase();
      const fulfillment = nameLower.includes('fbo') || nameLower.includes('фбо') ? 'FBO'
        : nameLower.includes('fbs') || nameLower.includes('фбс') ? 'FBS'
        : nameLower.includes('dbs') || nameLower.includes('дбс') ? 'DBS'
        : null;

      const fulfillmentBadge = fulfillment
        ? `<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--bg3);color:var(--muted);font-weight:600;margin-left:4px">${fulfillment}</span>`
        : '';

      // Очищаем технический префикс из имени (🟠 Ozon:, 🟡 ЯМ:)
      const displayName = b.name
        .replace(/^🟠\s*(Ozon:|Озон:)\s*/i, '')
        .replace(/^🟡\s*(ЯМ:|Яндекс Маркет:)\s*/i, '')
        .replace(/^🟣\s*(WB:|Wildberries:)\s*/i, '')
        .trim();

      const syncInfo = b.mp_source && lastSync
        ? `<span style="font-size:9px;color:var(--muted)">обновлено ${lastSync}</span>`
        : '';

      return `
        <div class="box-item ${isActive ? 'active' : ''}"
             onclick="window.app.selectBox('${b.id}')"
             onmouseenter="window.app.preloadBox('${b.id}')"
             style="padding-left:10px">
          <div class="box-meta" style="min-width:0;flex:1">
            <div class="box-name" style="display:flex;align-items:center;gap:2px;flex-wrap:nowrap">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(displayName)}</span>
              ${fulfillmentBadge}
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <div class="box-count" id="bc-${b.id}" style="font-size:10px">загрузка...</div>
              ${syncInfo}
            </div>
          </div>
          ${b.mp_source
            ? `<button class="oz-tab-btn" style="opacity:.5;flex-shrink:0" title="Обновить из МП"
                onclick="event.stopPropagation();window.app.refreshMpBox('${b.id}')">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" width="12" height="12"><path d="M12 7A5 5 0 1 1 7 2"/><polyline points="12 2 12 5.5 8.5 5.5"/></svg>
               </button>`
            : `<button class="oz-tab-btn" style="opacity:.4;flex-shrink:0" title="Настройки группы"
                onclick="event.stopPropagation();window.app.openBoxSettings('${b.id}')">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" width="11" height="11"><circle cx="7" cy="7" r="2"/><path d="M11 7c0-.3-.1-.6-.1-.8l1.2-.9-.6-1.7-1.4.5a3.5 3.5 0 0 0-1.5-.9L8.4 2H5.6l-.2 1.2A3.5 3.5 0 0 0 3.9 4L2.5 3.6 1.9 5.3l1.2.9c-.1.2-.1.5-.1.8s0 .6.1.8l-1.2.9.6 1.7 1.4-.5c.4.4.9.7 1.5.9l.2 1.2h2.8l.2-1.2c.6-.2 1.1-.5 1.5-.9l1.4.5.6-1.7-1.2-.9c.1-.2.1-.5.1-.8z"/></svg>
               </button>`
          }
        </div>`;
    };

    const renderSection = (label: string, color: string, icon: string, items: import('./types').Box[]) => {
      if (!items.length) return '';
      return `
        <div style="padding:8px 14px 2px;display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;font-weight:700;color:${color};letter-spacing:.3px;text-transform:uppercase">${icon} ${label}</span>
          <div style="flex:1;height:1px;background:var(--border);opacity:.5"></div>
        </div>
        ${items.map(renderBox).join('')}
      `;
    };

    el.innerHTML = [
      renderSection('Ozon', mpColor.ozon, '🟠', ozonBoxes),
      renderSection('Яндекс Маркет', mpColor.ym, '🟡', ymBoxes),
      renderSection('Wildberries', mpColor.wb, '🟣', wbBoxes),
      manualBoxes.length ? renderSection('Ручные', mpColor.manual, '📦', manualBoxes) : '',
    ].join('');

    boxList.forEach(b => this.loadBoxCount(b.id));
    const navAll = document.getElementById('nav-all');
    if (navAll) navAll.classList.toggle('active', !this.activeBoxId);
    this.updateSettingsButtonVisibility();
    this.renderMobileBoxes();
    this.renderGroupsBar();
  }

  /** Быстрое обновление API-группы без открытия диалога */
  async refreshMpBox(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.mp_source || !box.mp_store_id) return;

    const btn = document.querySelector<HTMLButtonElement>(`[onclick*="refreshMpBox('${boxId}')"]`);
    if (btn) { btn.style.animation = 'spin 1s linear infinite'; btn.disabled = true; }

    try {
      const { syncOzonStore, syncYandexStore, syncWbStore } = await import('./services/mpCatalogSync');
      const progress = (p: { stage: string }) => {
        const countEl = document.getElementById(`bc-${boxId}`);
        if (countEl) countEl.textContent = p.stage;
      };
      if (box.mp_source === 'ozon') {
        const { ozonDb } = await import('./services/ozonDb');
        const stores = await ozonDb.getStores();
        const store = (stores as any[]).find((s: any) => s.id === box.mp_store_id);
        if (store) await syncOzonStore(store, progress);
      } else if (box.mp_source === 'ym') {
        const { yandexDb } = await import('./services/yandexDb');
        const stores = await yandexDb.getStores();
        const store = (stores as any[]).find((s: any) => s.id === box.mp_store_id);
        if (store) await syncYandexStore(store, progress);
      } else if ((box.mp_source as string) === 'wb') {
        const { wbDb } = await import('./services/wbDb');
        const stores = await wbDb.getStores();
        const store = (stores as any[]).find((s: any) => s.id === box.mp_store_id);
        if (store) await syncWbStore(store, progress);
      }
      await boxActions.loadBoxes();
      this.renderBoxes();
      if (this.activeBoxId === boxId) {
        this.cache.delete(boxId);
        await this.selectBox(boxId);
      }
      this.toast('✅ Обновлено', 'success', 3000);
    } catch (e: any) {
      this.toast('Ошибка обновления: ' + e.message, 'error');
    } finally {
      if (btn) { btn.style.animation = ''; btn.disabled = false; }
    }
  }

  /** Показ/скрытие кнопки Настройки в зависимости от активной группы. */
  private updateSettingsButtonVisibility(): void {
    const btn = document.querySelector<HTMLElement>('.settings-btn');
    if (!btn) return;
    btn.style.display = this.activeBoxId ? '' : 'none';
  }

  private async loadBoxCount(boxId: string) {
    try {
      const count = await apiService.getBoxCount(boxId);
      const el = document.getElementById(`bc-${boxId}`);
      if (el) el.textContent = `${count} товар${this.suf(count)}`;
    } catch {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRODUCT LOADING & SELECTION
  // ─────────────────────────────────────────────────────────────────────────

  async setView(_view: 'all') {
    if (this.currentPage !== 'products') {
      this.navigateTo('products');
    }
    this.activeBoxId = null;
    localStorage.removeItem('last_box_id');
    this.searchQ = '';
    const inp = document.getElementById('search-inp') as HTMLInputElement;
    if (inp) inp.value = '';
    document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('on'));
    document.getElementById('mn-all')?.classList.add('on');
    // hide add-product-btn since no box selected
    const addBtn = document.getElementById('add-product-btn');
    if (addBtn) addBtn.style.display = 'none';
    this.renderBoxes();
    this.closeMobileSheets();
    await this.loadAllProducts();
  }

  private async loadAllProducts() {
    const token = ++this.loadToken;

    // Fast path: all boxes already cached
    const allBoxes = boxes.get();
    if (allBoxes.length > 0 && allBoxes.every(b => this.cache.has(b.id))) {
      this.allProducts = allBoxes.flatMap(b => this.cache.get(b.id)!);
      this.buildColumns();
      this.applyFilters();
      this.updateResultStat();
      return;
    }

    const content = document.getElementById('main-content');
    if (content) content.innerHTML = this.viewMode === 'cards' ? this.skeletonCards(8) : this.skeletonTable(10);
    try {
      // Fetch uncached boxes in parallel, use cache for the rest
      const results = await Promise.all(
        allBoxes.map(b => {
          if (this.cache.has(b.id)) return Promise.resolve(this.cache.get(b.id)!);
          return apiService.getProductsByBox(b.id).then(prods => {
            this.cache.set(b.id, prods || []);
            return prods || [];
          });
        })
      );
      if (token !== this.loadToken) return;
      this.allProducts = results.flat();
      this.buildColumns();
      this.applyFilters();
      this.updateResultStat();
      this.renderGroupsBar();
    } catch (e: any) {
      if (content) content.innerHTML = `<div class="empty"><div class="empty-title">Ошибка загрузки</div><div class="empty-sub">${this.esc(e.message)}</div></div>`;
    }
  }

  async selectBox(id: string) {
    if (this.currentPage !== 'products') {
      this.navigateTo('products');
    }
    this.activeBoxId = id;
    localStorage.setItem('last_box_id', id);
    this.searchQ = '';
    const inp = document.getElementById('search-inp') as HTMLInputElement;
    if (inp) inp.value = '';
    document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('on'));
    const addBtn = document.getElementById('add-product-btn');
    if (addBtn) addBtn.style.display = 'flex';
    this.renderBoxes();
    this.closeMobileSheets();
    await this.loadBoxProducts();
    this.refreshMpPresence().catch(() => {});

    // Авто-обновление API-групп если прошло >30 минут с последней синхронизации
    const box = boxes.get().find(b => b.id === id);
    if (box?.mp_source && box.mp_store_id) {
      const lastSync = box.mp_last_sync ? new Date(box.mp_last_sync).getTime() : 0;
      const thirtyMin = 30 * 60 * 1000;
      if (Date.now() - lastSync > thirtyMin) {
        // Фоновое обновление без блокировки UI
        setTimeout(() => this.refreshMpBox(id).catch(() => {}), 800);
      }
    }
  }

  /** Загружает все товары МП и строит карту присутствия по артикулу. */
  async refreshMpPresence(): Promise<void> {
    try {
      const { ozonDb } = await import('./services/ozonDb');
      const { yandexDb } = await import('./services/yandexDb');
      const { wbDb } = await import('./services/wbDb');
      const [ozStores, ymStores, wbStores, ozProds, ymProds, wbProds] = await Promise.all([
        ozonDb.getStores().catch(() => []),
        yandexDb.getStores().catch(() => []),
        wbDb.getStores().catch(() => []),
        ozonDb.getProducts().catch(() => []),
        yandexDb.getProducts().catch(() => []),
        wbDb.getProducts().catch(() => []),
      ]);
      const ozStoreMap = new Map(ozStores.map(s => [s.id, s.name]));
      const ymStoreMap = new Map(ymStores.map(s => [s.id, s.name]));
      const wbStoreMap = new Map(wbStores.map(s => [s.id, s.name]));
      const map = new Map<string, Array<{ mp: 'wb'|'ozon'|'yandex'; storeId: string; storeName: string; color: string }>>();
      const add = (sku: string, mp: 'wb'|'ozon'|'yandex', storeId: string, storeName: string, color: string) => {
        const k = sku.toLowerCase().trim();
        if (!k) return;
        if (!map.has(k)) map.set(k, []);
        const arr = map.get(k)!;
        if (!arr.some(x => x.mp === mp && x.storeId === storeId)) {
          arr.push({ mp, storeId, storeName, color });
        }
      };
      for (const p of ozProds) add(p.offer_id, 'ozon', p.store_id, ozStoreMap.get(p.store_id) ?? 'Ozon', '#005bff');
      for (const p of ymProds) add(p.offer_id || (p as any).vendor_code, 'yandex', p.store_id, ymStoreMap.get(p.store_id) ?? 'ЯМ', '#fc3f1d');
      for (const p of wbProds) add((p as any).vendor_code, 'wb', p.store_id, wbStoreMap.get(p.store_id) ?? 'WB', '#cb11ab');
      this.mpPresence = map;
      // Триггерим перерисовку таблицы если она открыта
      if (this.currentPage === 'products' || this.currentPage === 'home') this.applyFilters();
    } catch (e) {
      console.warn('[refreshMpPresence]', e);
    }
  }

  /** Возвращает массив магазинов где найден товар по его артикулу. */
  getMpPresenceFor(p: Product): Array<{ mp: 'wb'|'ozon'|'yandex'; storeId: string; storeName: string; color: string }> {
    const d = p.data || {};
    const fields = ['Артикул*', 'Артикул', 'Артикул продавца', 'Ваш SKU *'];
    for (const f of fields) {
      const v = String(d[f] ?? '').trim().toLowerCase();
      if (v && this.mpPresence.has(v)) return this.mpPresence.get(v)!;
    }
    return [];
  }

  async loadBoxProducts() {
    const token = ++this.loadToken;
    const id = this.activeBoxId!;

    // Instant render from cache
    if (this.cache.has(id)) {
      this.allProducts = this.cache.get(id)!;
      this.buildColumns();
      this.applyFilters();
      this.updateResultStat();
      return;
    }

    const content = document.getElementById('main-content');
    if (content) content.innerHTML = this.viewMode === 'cards' ? this.skeletonCards(8) : this.skeletonTable(10);

    const sig = { cancelled: false };
    let accumulated: Product[] = [];

    const handleBatch = (batch: Product[]) => {
      if (token !== this.loadToken) { sig.cancelled = true; return; }
      accumulated = accumulated.concat(batch);
      this.allProducts = accumulated;
      this.buildColumns();
      this.applyFilters();
      this.updateResultStat();
    };

    try {
      await apiService.streamProducts(id, handleBatch, sig);
      if (token !== this.loadToken) return;
      this.cache.set(id, accumulated);
      idbCache.set(id, accumulated).catch(() => {});
      this.renderGroupsBar();
    } catch (e: any) {
      if (token !== this.loadToken) return;
      if (content) content.innerHTML = `<div class="empty"><div class="empty-title">Ошибка загрузки</div><div class="empty-sub">${this.esc(e.message)}</div></div>`;
    }
  }

  // Preload a box on hover — fires in background, populates cache early
  preloadBox(id: string) {
    if (this.cache.has(id)) return;
    const sig = { cancelled: false };
    let acc: Product[] = [];
    apiService.streamProducts(id, batch => {
      acc = acc.concat(batch);
      if (!this.cache.has(id)) {
        this.cache.set(id, acc);
        const el = document.getElementById(`bc-${id}`);
        if (el) el.textContent = `${acc.length} товар${this.suf(acc.length)}`;
      }
    }, sig).catch(() => {});
  }

  // Load IDB cache into memory, then silently refresh all boxes from network
  private async warmCacheFromIdb() {
    const allBoxes = boxes.get();

    // Phase 1: populate memory cache from IDB (instant disk read)
    await Promise.all(allBoxes.map(async b => {
      const cached = await idbCache.get(b.id);
      if (cached && !this.cache.has(b.id)) {
        this.cache.set(b.id, cached);
        const el = document.getElementById(`bc-${b.id}`);
        if (el) el.textContent = `${cached.length} товар${this.suf(cached.length)}`;
      }
    }));

    // Re-render dashboard with fresh data if we're still on the home page
    if (this.currentPage === 'home') {
      this.renderDashboard();
    }

    // Phase 2: refresh from network in background (stale-while-revalidate)
    allBoxes.forEach(b => {
      const sig = { cancelled: false };
      let acc: Product[] = [];
      apiService.streamProducts(b.id, batch => {
        acc = acc.concat(batch);
      }, sig).then(() => {
        if (acc.length === 0) return;
        this.cache.set(b.id, acc);
        idbCache.set(b.id, acc).catch(() => {});
        const el = document.getElementById(`bc-${b.id}`);
        if (el) el.textContent = `${acc.length} товар${this.suf(acc.length)}`;
        // Refresh dashboard again after network data arrives
        if (this.currentPage === 'home') {
          this.renderDashboard();
        }
      }).catch(() => {});
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COLUMNS & DYNAMIC FILTERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Мигрирует устаревшие «Дополнительное фото N» → единое поле «Ссылки на дополнительные фото».
   *  Изменённые продукты сохраняются в БД в фоне (fire-and-forget). */
  private migratePhotoColumns() {
    const RE = /^Дополнительное фото\s?\d*$/i;
    const toSave: Product[] = [];
    for (const p of this.allProducts) {
      const d = p.data;
      if (!d) continue;
      const oldKeys = Object.keys(d).filter(k => RE.test(k));
      if (!oldKeys.length) continue;
      // Собираем URL из старых полей
      const oldUrls = oldKeys
        .sort((a, b) => {
          const na = parseInt(a.replace(/\D/g, '') || '0');
          const nb = parseInt(b.replace(/\D/g, '') || '0');
          return na - nb;
        })
        .map(k => String(d[k] || '').trim())
        .filter(u => u.startsWith('http'));
      // Объединяем с уже существующими
      const existing = String(d['Ссылки на дополнительные фото'] || '');
      const existingUrls = existing.split(/[\n;,]+/).map(s => s.trim()).filter(u => u.startsWith('http'));
      const merged = [...new Set([...existingUrls, ...oldUrls])];
      if (merged.length) d['Ссылки на дополнительные фото'] = merged.join('\n');
      // Удаляем старые ключи
      for (const k of oldKeys) delete d[k];
      toSave.push(p);
    }
    // Сохраняем в БД в фоне
    if (toSave.length) {
      Promise.all(toSave.map(p => apiService.updateProduct(p.id, { data: p.data }))).catch(() => {});
    }
  }

  buildColumns() {
    this.migratePhotoColumns();
    const cols = new Set<string>();
    this.allProducts.forEach(p => {
      Object.keys(p.data || {}).forEach(k => {
        if (!k.startsWith('_') && !/^Дополнительное фото\s?\d*$/i.test(k)) cols.add(k);
      });
    });

    // Кастомные колонки (системные + текущей группы или всех — если viewAll)
    // Добавляем в общий Set чтобы они участвовали в reorder наравне с остальными.
    let customLabels: string[] = [];
    if (this.showCustomCols) {
      const customCols = customColumnsDb.getColumns(this.activeBoxId).filter(c => c.show_in_table);
      customLabels = customCols.map(c => `★ ${c.label}`);
      for (const lbl of customLabels) cols.add(lbl);
    }

    // По дефолту важные столбцы идут в начале независимо от маркетплейса.
    // Включаем варианты имён от Ozon, ЯМ и WB.
    const priority = [
      // Фото — всегда первый столбец
      'Ссылка на главное фото*', 'Ссылки на дополнительные фото', 'Ссылки на фото 360',
      // Артикул — Ozon / ЯМ / WB
      'Артикул*', 'Артикул',
      // Название — Ozon / ЯМ / WB
      'Название товара', 'Название товара *',
      // Кастомные столбцы пользователя
      ...customLabels,
      // Цены
      'Цена, руб.*', 'Цена *', 'Цена до скидки, руб.', 'Зачёркнутая цена', 'Себестоимость',
      // Основные атрибуты
      'Тип*', 'Бренд*', 'Бренд *',
      'Цвет товара', 'Цвет для фильтра', 'Название цвета', 'Название цвета от производителя',
      'Описание товара *', 'Описание',
      'Штрихкод *', 'Баркод',
      // WB
      'Артикул WB', 'Артикул продавца',
    ];
    let baseCols = [...priority.filter(c => cols.has(c)), ...[...cols].filter(c => !priority.includes(c))];

    if (this.activeBoxId) {
      const order = this.columnOrder.get(this.activeBoxId);
      if (order) {
        const ordered = order.filter(c => cols.has(c));
        // New custom cols not yet in the saved columnOrder → insert at the FRONT
        const newCustom = customLabels.filter(lbl => !order.includes(lbl));
        const rest = baseCols.filter(c => !ordered.includes(c) && !newCustom.includes(c));
        baseCols = [...newCustom, ...ordered, ...rest];
        // Persist the updated order immediately so the position sticks
        if (newCustom.length > 0) {
          const updatedOrder = [...newCustom, ...ordered, ...rest];
          this.columnOrder.set(this.activeBoxId, updatedOrder);
          try {
            const co: Record<string, string[]> = {};
            for (const [bid, cls] of this.columnOrder) co[bid] = cls;
            localStorage.setItem('app_column_order', JSON.stringify(co));
          } catch {}
        }
      }
    }

    this.columns = baseCols;
    this.buildDynamicFilters();
  }

  /** Состояние видимости блока кастомных колонок (как фильтры — сворачивается). */
  private showCustomCols = true;

  /** Вызывается из SettingsHub после добавления/удаления колонки — обновляет таблицу. */
  buildColumnsAndRefresh(): void {
    this.buildColumns();
    this.applyFilters();
  }

  /** Получить активную группу (для SettingsHub). */
  getActiveBox() {
    if (!this.activeBoxId) return null;
    return boxes.get().find(b => b.id === this.activeBoxId) ?? null;
  }

  /** Сохранить название и эмодзи из SettingsHub (без модалки). */
  async saveBoxNameFromHub(boxId: string): Promise<void> {
    const name = (document.getElementById('sh-group-name') as HTMLInputElement)?.value?.trim();
    const sticker = (document.getElementById('sh-group-emoji') as HTMLInputElement)?.value?.trim() || '📦';
    if (!name) { this.toast('Введите название группы', 'error'); return; }
    try {
      await apiService.updateBox(boxId, { name, sticker });
      boxActions.updateBox(boxId, { name, sticker });
      this.renderBoxes();
      this.toast('Название сохранено ✓', 'success');
      (window as any).settingsHub?.init?.();
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  toggleCustomCols(): void {
    this.showCustomCols = !this.showCustomCols;
    this.buildColumns();
    this.applyFilters();
  }

  /** Получить артикул товара из любого из возможных полей (Артикул*, Артикул, Артикул продавца, Ваш SKU *). */
  private getProductArt(p: Product): string {
    const fields = ['Артикул*', 'Артикул', 'Артикул продавца', 'Ваш SKU *'];
    for (const f of fields) {
      const v = String(p.data?.[f] ?? '').trim();
      if (v) return v;
    }
    return '';
  }

  /** Получить значение кастомной колонки для товара (если label начинается с ★). */
  private getCustomColumnValue(p: Product, label: string): string {
    if (!label.startsWith('★ ')) return '';
    const cleanLabel = label.slice(2);
    const col = customColumnsDb.getColumns(this.activeBoxId).find(c => c.label === cleanLabel);
    if (!col) return '';
    const offerId = this.getProductArt(p);
    if (!offerId) return '';
    let v: any = customColumnsDb.getValuesFor(offerId)[col.id];
    // Fallback: для «Себестоимость» ищем в costPriceDb по артикулу
    if ((v == null || v === '') && cleanLabel.toLowerCase().includes('себе')) {
      const cost = costPriceDb.get(offerId);
      if (cost != null) v = cost;
    }
    if (v == null || v === '') return '';
    return col.data_type === 'number' && isFinite(Number(v))
      ? Number(v).toLocaleString('ru') + (cleanLabel.toLowerCase().includes('себе') || cleanLabel.toLowerCase().includes('цен') ? ' ₽' : '')
      : String(v);
  }

  /** Числовое значение кастомной колонки (для фильтров/сортировки). */
  private getCustomColumnNumber(p: Product, label: string): number | null {
    if (!label.startsWith('★ ')) return null;
    const cleanLabel = label.slice(2);
    const col = customColumnsDb.getColumns(this.activeBoxId).find(c => c.label === cleanLabel);
    if (!col || col.data_type !== 'number') return null;
    const offerId = this.getProductArt(p);
    if (!offerId) return null;
    let v: any = customColumnsDb.getValuesFor(offerId)[col.id];
    // Fallback: для «Себестоимость» ищем в costPriceDb
    if ((v == null || v === '') && cleanLabel.toLowerCase().includes('себе')) {
      const cost = costPriceDb.get(offerId);
      if (cost != null) return cost;
    }
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  private buildDynamicFilters() {
    const el = document.getElementById('dynamic-filters');
    const mobileEl = document.getElementById('mobile-dynamic-filters');
    const noiseKeys = ['Цена, руб.*', 'Цена до скидки, руб.', '№', 'Артикул*', 'Название товара', 'Аннотация', 'Rich-контент JSON', '#Хештеги'];
    const dropCols = this.columns.filter(col => {
      if (noiseKeys.includes(col)) return false;
      const vals = new Set(this.allProducts.map(p => p.data[col]).filter(Boolean));
      return vals.size > 0 && vals.size <= 30;
    }).slice(0, 6);

    const html = dropCols.map(col => {
      const vals = [...new Set(this.allProducts.map(p => p.data[col]).filter(Boolean))].sort();
      return `<div class="filter-section">
        <div class="filter-title" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="window.app.clearColumnFilter('${this.esc(col)}')">
          ${this.esc(col.replace('*', ''))}
          <span style="font-size:10px;color:var(--text3);opacity:0.5">✕</span>
        </div>
        <div class="check-list">
          ${vals.map(v => `<div class="chk" data-col="${this.esc(col)}" data-val="${this.esc(v)}" onclick="window.app.toggleChk(this)">
            <div class="chk-box"><div class="chk-tick"></div></div>
            <span class="chk-label">${this.esc(v)}</span>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('');

    if (el) el.innerHTML = html;
    if (mobileEl) mobileEl.innerHTML = html;
  }

  clearColumnFilter(col: string) {
    document.querySelectorAll(`.chk[data-col="${col}"]`).forEach(el => el.classList.remove('on'));
    this.applyFilters();
  }

  toggleChk(el: HTMLElement) {
    el.classList.toggle('on');
    this.applyFilters();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FILTERING & SORTING
  // ─────────────────────────────────────────────────────────────────────────

  applyFilters() {
    const pf = parseFloat((document.getElementById('f-price-from') as HTMLInputElement)?.value) || null;
    const pt = parseFloat((document.getElementById('f-price-to') as HTMLInputElement)?.value) || null;
    const q = this.searchQ.toLowerCase().trim();

    const chkFilters: Record<string, Set<string>> = {};
    document.querySelectorAll('.chk.on').forEach(el => {
      const col = (el as HTMLElement).dataset.col!;
      const val = (el as HTMLElement).dataset.val!;
      if (!chkFilters[col]) chkFilters[col] = new Set();
      chkFilters[col].add(val);
    });

    // Скрытые строки (если режим «не показывать скрытые»)
    const hiddenSet = this.activeBoxId ? (this.hiddenRows.get(this.activeBoxId) ?? new Set<string>()) : new Set<string>();

    // Фильтр по цене себестоимости (★)
    const cf = parseFloat((document.getElementById('f-cost-from') as HTMLInputElement)?.value) || null;
    const ct = parseFloat((document.getElementById('f-cost-to') as HTMLInputElement)?.value) || null;

    let data = this.allProducts.filter(p => {
      // Фильтр скрытых строк
      if (!this.showHiddenRows && hiddenSet.has(p.id)) return false;

      const d = p.data || {};
      const price = parseFloat(d['Цена, руб.*']) || 0;
      if (pf && price < pf) return false;
      if (pt && price > pt) return false;

      // Фильтр по себестоимости — даже если колонка скрыта
      if (cf != null || ct != null) {
        const cost = this.getCustomColumnNumber(p, '★ Себестоимость');
        if (cf != null && (cost == null || cost < cf)) return false;
        if (ct != null && (cost == null || cost > ct)) return false;
      }

      for (const [col, vals] of Object.entries(chkFilters)) {
        const pv = String(d[col] || '');
        const pvArr = pv.split(';').map(s => s.trim());
        if (![...vals].some(v => pvArr.includes(v))) return false;
      }
      if (q) {
        // Поиск по полям товара + кастомным колонкам (даже если скрыты)
        const haystack = Object.values(d).join(' ').toLowerCase();
        const offerId = String(d['Артикул*'] ?? '').trim();
        let customHaystack = '';
        if (offerId) {
          const vals = customColumnsDb.getValuesFor(offerId);
          customHaystack = Object.values(vals).map(v => String(v)).join(' ').toLowerCase();
        }
        if (!haystack.includes(q) && !customHaystack.includes(q)) return false;
      }
      return true;
    });

    if (this.priceSort) {
      data.sort((a, b) => {
        const ap = parseFloat(a.data['Цена, руб.*']) || 0;
        const bp = parseFloat(b.data['Цена, руб.*']) || 0;
        return this.priceSort === 'asc' ? ap - bp : bp - ap;
      });
    }
    if (this.sortCol) {
      const col = this.sortCol;
      const dir = this.sortDir;
      const isCustom = col.startsWith('★ ');
      const valueFor = (p: Product): string => {
        if (isCustom) {
          const cleanLabel = col.slice(2);
          const cc = customColumnsDb.getColumns().find(c => c.label === cleanLabel);
          if (!cc) return '';
          const off = String(p.data?.['Артикул*'] ?? '').trim();
          const v = customColumnsDb.getValuesFor(off)[cc.id];
          return v == null ? '' : String(v);
        }
        return String(p.data?.[col] ?? '');
      };
      data.sort((a, b) => {
        const av = valueFor(a);
        const bv = valueFor(b);
        const numA = parseFloat(av), numB = parseFloat(bv);
        const isNum = !isNaN(numA) && !isNaN(numB);
        if (isNum) return dir === 'asc' ? numA - numB : numB - numA;
        return dir === 'asc'
          ? String(av).localeCompare(String(bv), 'ru')
          : String(bv).localeCompare(String(av), 'ru');
      });
    }

    this.filtered = data;
    this.updateResultStat();
    this.renderProducts();
  }

  toggleSort(dir: 'asc' | 'desc') {
    this.priceSort = this.priceSort === dir ? null : dir;
    document.getElementById('sort-asc')?.classList.toggle('on', this.priceSort === 'asc');
    document.getElementById('sort-desc')?.classList.toggle('on', this.priceSort === 'desc');
    document.getElementById('m-sort-asc')?.classList.toggle('on', this.priceSort === 'asc');
    document.getElementById('m-sort-desc')?.classList.toggle('on', this.priceSort === 'desc');
    this.applyFilters();
  }

  toggleCostSort(dir: 'asc' | 'desc') {
    if (this.sortCol === '★ Себестоимость' && this.sortDir === dir) {
      this.sortCol = null; this.sortDir = 'asc';
    } else {
      this.sortCol = '★ Себестоимость';
      this.sortDir = dir;
    }
    document.getElementById('cost-sort-asc')?.classList.toggle('on', this.sortCol === '★ Себестоимость' && this.sortDir === 'asc');
    document.getElementById('cost-sort-desc')?.classList.toggle('on', this.sortCol === '★ Себестоимость' && this.sortDir === 'desc');
    this.applyFilters();
  }

  sortByCol(col: string) {
    if (this.sortCol === col) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortCol = col;
      this.sortDir = 'asc';
    }
    this.applyFilters();
  }

  toggleFilterPanel() {
    const panel = document.getElementById('filter-panel');
    const btn = document.getElementById('filter-toggle-btn');
    panel?.classList.toggle('collapsed');
    btn?.classList.toggle('collapsed');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ROW HIDING
  // ─────────────────────────────────────────────────────────────────────────

  /** Скрыть/показать конкретный товар в основной таблице */
  toggleHideProduct(id: string) {
    if (!this.activeBoxId) return;
    if (!this.hiddenRows.has(this.activeBoxId)) this.hiddenRows.set(this.activeBoxId, new Set());
    const set = this.hiddenRows.get(this.activeBoxId)!;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.saveHiddenRows();
    this.applyFilters();
  }

  /** Переключить режим «показывать скрытые» */
  toggleShowHidden() {
    this.showHiddenRows = !this.showHiddenRows;
    this.applyFilters();
  }

  private saveHiddenRows() {
    const obj: Record<string, string[]> = {};
    for (const [bid, set] of this.hiddenRows) obj[bid] = [...set];
    localStorage.setItem('app_hidden_rows', JSON.stringify(obj));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COLUMN VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────

  /** Открыть модальное окно настройки видимых столбцов */
  /** Единый менеджер колонок — кастомные поля + видимость столбцов из данных */
  openColPickerModal() {
    const customCols = customColumnsDb.getColumns(this.activeBoxId);
    const dataCols   = this.columns.filter(c => !App.SKIP_COLS.has(c));

    // ── Секция 1: Кастомные поля ────────────────────────────────────────────
    const customRows = customCols.map(c => {
      const isSystem = c.system;
      const typeLabel = c.data_type === 'number' ? '🔢' : '📝';
      return `
        <div class="sh-col-row" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)"
          draggable="${!isSystem}"
          data-col-id="${this.esc(c.id)}"
          ondragstart="window.app.onColDragStart(event,${customCols.indexOf(c)})"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="event.preventDefault();this.classList.remove('drag-over');window.app.onColDrop(event,${customCols.indexOf(c)})">
          <div style="cursor:${isSystem ? 'default' : 'grab'};font-size:14px;flex-shrink:0;color:var(--muted)" title="${isSystem ? 'Системная колонка' : 'Перетащить для изменения порядка'}">
            ${isSystem ? '🔒' : '⠿'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${this.esc(c.label)}</div>
            <div style="font-size:10px;color:var(--muted)">${typeLabel} ${c.data_type === 'number' ? 'Число' : 'Текст'}${isSystem ? ' · Системная' : ' · Пользовательская'}</div>
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);cursor:pointer;flex-shrink:0">
            <input type="checkbox" ${c.show_in_table ? 'checked' : ''} style="accent-color:#005bff"
              onchange="window.app.toggleCustomColumnVisibility('${this.esc(c.id)}',this.checked)">
            В таблице
          </label>
          ${!isSystem ? `
            <button onclick="window.app.deleteCustomColumn('${this.esc(c.id)}','${this.esc(c.label).replace(/'/g, '&#39;')}')"
              style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;flex-shrink:0;padding:0 2px" title="Удалить">✕</button>
          ` : '<div style="width:20px"></div>'}
        </div>`;
    }).join('');

    const addColForm = `
      <div style="padding:12px;background:var(--bg2);border-top:1px solid var(--border)">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Добавить кастомный ряд</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <input id="cm-label" class="form-input" placeholder="Название поля" style="flex:1;min-width:140px">
          <select id="cm-type" class="form-select" style="width:100px">
            <option value="text">Текст</option>
            <option value="number">Число</option>
          </select>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="cm-show" checked style="accent-color:#005bff"> В таблице
          </label>
          <button class="btn btn-primary" style="font-size:12px;padding:5px 12px"
            onclick="window.app.addCustomColumnFromModal()">+ Создать</button>
        </div>
      </div>`;

    // ── Секция 2: Данные из МП/xlsx ─────────────────────────────────────────
    const dataRows = dataCols.map((c, idx) => {
      const vis = this.visibleCols === null || this.visibleCols.has(c);
      return `
        <div class="col-pick-row" style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--border)"
          draggable="true"
          ondragstart="window.app.onColDragStart(event,${idx})"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="event.preventDefault();this.classList.remove('drag-over');window.app.onColDrop(event,${idx})">
          <div style="cursor:grab;font-size:12px;color:var(--muted);flex-shrink:0">⠿</div>
          <label style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0">
            <input type="checkbox" class="col-pick-chk" data-col="${this.esc(c)}" ${vis ? 'checked' : ''} style="accent-color:#005bff;flex-shrink:0">
            <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(c.replace('*', ''))}</span>
          </label>
        </div>`;
    }).join('');

    const body = `
      <div style="display:flex;flex-direction:column;gap:0">

        <!-- Кастомные поля -->
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:10px 12px 6px;background:var(--bg2);border-bottom:1px solid var(--border)">
            Кастомные поля (Себестоимость + пользовательские)
          </div>
          <div id="custom-cols-list">
            ${customRows || '<div style="padding:12px;font-size:12px;color:var(--muted)">Нет кастомных полей</div>'}
          </div>
          ${addColForm}
        </div>

        <!-- Столбцы из данных МП/xlsx -->
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:10px 12px 6px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
            <span>Столбцы из данных товаров (МП / xlsx)</span>
            <div style="display:flex;gap:6px">
              <button class="btn" style="font-size:10px;padding:2px 8px" onclick="window.app.colPickAll(true)">Все</button>
              <button class="btn" style="font-size:10px;padding:2px 8px" onclick="window.app.colPickAll(false)">Снять</button>
            </div>
          </div>
          <div id="data-cols-list" style="max-height:280px;overflow-y:auto">
            ${dataRows || '<div style="padding:12px;font-size:12px;color:var(--muted)">Нет данных — сначала синхронизируйте товары</div>'}
          </div>
        </div>

      </div>`;

    this.openModalLg('Управление столбцами', '', body,
      `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>
       <button class="btn btn-primary" onclick="window.app.applyColPicker()">Применить</button>`
    );
  }

  addCustomColumnFromModal() {
    const labelEl  = document.getElementById('cm-label')  as HTMLInputElement;
    const typeEl   = document.getElementById('cm-type')   as HTMLSelectElement;
    const showEl   = document.getElementById('cm-show')   as HTMLInputElement;
    const label    = labelEl?.value?.trim();
    if (!label) { labelEl?.focus(); this.toast('Введите название', 'error'); return; }
    customColumnsDb.addColumn({
      label,
      data_type: (typeEl?.value || 'text') as 'text' | 'number',
      show_in_table: showEl?.checked ?? true,
      box_id: this.activeBoxId || null,
    });
    this.buildColumnsAndRefresh();
    // Перерендерим модал с новой колонкой
    this.openColPickerModal();
    this.toast(`Поле «${label}» создано`, 'success', 2000);
  }

  /** Удалить кастомную колонку (роутится через app, т.к. customColumnsDb не в window) */
  deleteCustomColumn(id: string, label: string) {
    if (!confirm(`Удалить колонку «${label}»?`)) return;
    customColumnsDb.deleteColumn(id);
    this.buildColumnsAndRefresh();
    this.openColPickerModal();
  }

  /** Переключить видимость кастомной колонки в таблице */
  toggleCustomColumnVisibility(id: string, show: boolean) {
    customColumnsDb.updateColumn(id, { show_in_table: show });
    this.buildColumnsAndRefresh();
  }

  colPickAll(checked: boolean) {
    document.querySelectorAll<HTMLInputElement>('.col-pick-chk').forEach(chk => { chk.checked = checked; });
  }

  applyColPicker() {
    const selected: string[] = [];
    document.querySelectorAll<HTMLInputElement>('.col-pick-chk:checked').forEach(chk => {
      const col = chk.dataset.col;
      if (col) selected.push(col);
    });
    // null = все видны (если выбраны все); иначе — Set
    const allCols = this.columns.filter(c => !App.SKIP_COLS.has(c));
    if (selected.length === allCols.length) {
      this.visibleCols = null;
    } else {
      this.visibleCols = new Set(selected);
    }
    localStorage.setItem('app_visible_cols', JSON.stringify(selected.length === allCols.length ? null : selected));
    this.closeModal();
    // Force rebuild table (columns changed)
    this.vt.colKey = '';
    this.renderProducts();
  }

  syncMobileFilters(key: string, val: string) {
    const desktopId = key === 'price-from' ? 'f-price-from' : 'f-price-to';
    const inp = document.getElementById(desktopId) as HTMLInputElement;
    if (inp) inp.value = val;
    this.applyFilters();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW MODE
  // ─────────────────────────────────────────────────────────────────────────

  setViewMode(mode: 'table' | 'cards') {
    this.viewMode = mode;
    document.getElementById('tab-table')?.classList.toggle('on', mode === 'table');
    document.getElementById('tab-cards')?.classList.toggle('on', mode === 'cards');
    this.renderProducts();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDERING PRODUCTS
  // ─────────────────────────────────────────────────────────────────────────

  updateResultStat() {
    const total = this.filtered.length;
    const box = boxes.get().find(b => b.id === this.activeBoxId);
    const statEl = document.getElementById('result-stat');
    const metaEl = document.getElementById('result-meta');
    if (statEl) statEl.textContent = `${total} товар${this.suf(total)}`;

    const hiddenCount = this.activeBoxId ? (this.hiddenRows.get(this.activeBoxId)?.size ?? 0) : 0;
    const hiddenHint = hiddenCount > 0
      ? ` · <button class="btn-link-sm ${this.showHiddenRows ? 'on' : ''}" onclick="window.app.toggleShowHidden()">${this.showHiddenRows ? '👁 Скрыто показано' : `👁 Скрыто: ${hiddenCount}`}</button>`
      : '';

    // Индикаторы синхронизации
    const ozSynced = this.filtered.filter(p => p.data?.['_ozon_synced_at']).length;
    const ymSynced = this.filtered.filter(p => p.data?.['_ym_synced_at']).length;
    const wbSynced = this.filtered.filter(p => p.data?.['_wb_synced_at']).length;
    const maxSynced = Math.max(ozSynced, ymSynced, wbSynced);
    const syncHint = total > 0 && maxSynced > 0
      ? ` · <span class="sync-pill" title="Товаров синхронизировано с маркетплейсами">
          <span class="sync-pill-dot ${maxSynced === total ? 'full' : 'partial'}"></span>
          ${ozSynced > 0 ? `<span style="color:#005bff;font-weight:600" title="Ozon">Ozon: ${ozSynced}</span>` : ''}
          ${ymSynced > 0 ? `<span style="color:#fc3f1d;font-weight:600;margin-left:4px" title="Яндекс Маркет">ЯМ: ${ymSynced}</span>` : ''}
          ${wbSynced > 0 ? `<span style="color:#cb11ab;font-weight:600;margin-left:4px" title="WB">WB: ${wbSynced}</span>` : ''}
        </span>`
      : '';

    if (metaEl) metaEl.innerHTML = (box ? `в группе «${box.name}»` : (!this.activeBoxId && total > 0 ? 'все группы' : '')) + syncHint + hiddenHint;

    // Toggle export buttons
    const exportBtn = document.getElementById('export-btn');
    const exportAllBtn = document.getElementById('export-all-btn');
    if (exportBtn && exportAllBtn) {
      const hasData = this.allProducts.length > 0;
      const isProdPage = this.currentPage === 'products';
      exportBtn.style.display = (hasData && this.activeBoxId && isProdPage) ? 'flex' : 'none';
      exportAllBtn.style.display = (hasData && !this.activeBoxId && isProdPage) ? 'flex' : 'none';
    }
  }

  private renderEmpty() {
    const content = document.getElementById('main-content');
    if (content) content.innerHTML = `<div class="empty">
      <div class="empty-icon">📦</div>
      <div class="empty-title">Выберите группу</div>
      <div class="empty-sub">Нажмите на группу в сайдбаре или используйте глобальный поиск</div>
    </div>`;
    const statEl = document.getElementById('result-stat');
    const metaEl = document.getElementById('result-meta');
    if (statEl) statEl.textContent = '— товаров';
    if (metaEl) metaEl.textContent = '';
  }

  renderProducts() {
    const content = document.getElementById('main-content');
    if (!content) return;

    // Кнопки toolbar
    const colBtn = document.getElementById('col-picker-btn');
    if (colBtn) colBtn.style.display = (this.allProducts.length > 0 && this.viewMode === 'table') ? '' : 'none';
    const xlsxBtn = document.getElementById('xlsx-import-btn');
    if (xlsxBtn) xlsxBtn.style.display = this.activeBoxId ? '' : 'none';
    // Убираем старую кнопку mass-fill если осталась
    const massFillBtn = document.getElementById('mass-fill-btn');
    if (massFillBtn) massFillBtn.style.display = 'none';

    if (!this.allProducts.length) {
      const box = this.activeBoxId ? boxes.get().find(b => b.id === this.activeBoxId) : null;
      const isMpBox = !!box?.mp_source;
      content.innerHTML = `<div class="empty">
        <div class="empty-icon">${isMpBox ? '🔄' : '📋'}</div>
        <div class="empty-title">${isMpBox ? 'Загружаем товары...' : 'Нет товаров'}</div>
        <div class="empty-sub">${isMpBox
          ? 'Идёт синхронизация с маркетплейсом'
          : 'Нажмите «Синхронизировать с МП» чтобы подключить маркетплейс, или используйте xlsx-добавку для WB'}</div>
        ${isMpBox
          ? `<button class="btn btn-primary" onclick="window.app.refreshMpBox('${box!.id}')" style="margin-top:4px">↻ Обновить из МП</button>`
          : `<button class="btn btn-primary" onclick="window.app.openMpSyncModal()" style="margin-top:4px">🔄 Синхронизировать с МП</button>`}
      </div>`;
      return;
    }
    if (!this.filtered.length) {
      content.innerHTML = `<div class="empty">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">Ничего не найдено</div>
        <div class="empty-sub">Попробуйте изменить фильтры или поисковый запрос</div>
      </div>`;
      return;
    }
    if (this.viewMode === 'cards') this.renderCards(content);
    else this.renderTable(content);
  }

  static readonly SKIP_COLS = new Set([
    'Ссылка на главное фото*', 'Ссылки на дополнительные фото', 'Ссылки на фото 360',
    'Артикул фото', 'Образец цвета', '#Хештеги', 'Rich-контент JSON', 'Ошибка', 'Предупреждение'
  ]);

  private renderTable(content: HTMLElement) {
    // Применяем выбор столбцов (+ скрываем устаревшие «Дополнительное фото N»)
    const allCols = this.columns.filter(c => !App.SKIP_COLS.has(c) && !/^Дополнительное фото/i.test(c));
    const cols = this.visibleCols ? allCols.filter(c => this.visibleCols!.has(c)) : allCols;
    const hasPhoto = this.filtered.some(p => p.data?.['Ссылка на главное фото*']);
    const colKey = cols.join('|') + (hasPhoto ? '|photo' : '') + (this.visibleCols ? '|vc' : '');
    // Rebuild DOM only when columns change or container is gone
    const needRebuild = !this.vt.el || !content.contains(this.vt.el) || this.vt.colKey !== colKey;

    if (needRebuild) {
      this.vt.el = null;
      const sortCls = (c: string) => this.sortCol === c ? (this.sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
      content.innerHTML = `<div class="table-wrap" style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div id="vt-scroll" style="flex:1;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead style="position:sticky;top:0;z-index:2;background:var(--bg2)">
              <tr>
                <th style="width:50px;min-width:50px;padding:0 0 0 10px;text-align:center">
                  <div class="chk ${this.selectedProducts.size === this.filtered.length && this.filtered.length > 0 ? 'on' : ''}" onclick="window.app.toggleAllSelection()" style="margin:0 auto;padding:4px">
                    <div class="chk-box"><div class="chk-tick"></div></div>
                  </div>
                </th>
                ${hasPhoto ? '<th style="width:auto;min-width:90px;text-align:left;padding-left:6px;font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;font-weight:600">Магазины</th>' : ''}
                ${cols.map(c => {
                  const isCustom = c.startsWith('★ ');
                  const isCost = c === '★ Себестоимость';
                  const dotColor = isCost ? '#4ade80' : '#7c3aed';
                  const label = isCustom
                    ? `<span style="display:inline-flex;align-items:center;gap:4px"><span style="color:${dotColor};font-size:9px" title="${isCost ? 'Себестоимость (связано с Репрайсером)' : 'Кастомная колонка из «Настройки»'}">●</span>${this.esc(c.slice(2))}</span>`
                    : this.esc(c.replace('*', ''));
                  return `<th onclick="window.app.sortByCol('${this.esc(c)}')" class="${sortCls(c)}">${label}</th>`;
                }).join('')}
                <th style="width:64px;min-width:64px"></th>
              </tr>
            </thead>
            <tbody id="vt-tbody">
              <tr id="vt-top" style="height:0"></tr>
              <tr id="vt-bot" style="height:0"></tr>
            </tbody>
          </table>
          <div style="height:100px;flex-shrink:0"></div>
        </div>
      </div>`;

      const scrollEl = document.getElementById('vt-scroll') as HTMLElement;
      this.vt.el = scrollEl;
      this.vt.colKey = colKey;
      this.vt.cols = cols;
      this.vt.hasPhoto = hasPhoto;
      scrollEl.addEventListener('scroll', () => this.vtPaint(), { passive: true });
    } else {
      // Columns same — update sort classes in header without rebuilding
      const ths = this.vt.el!.querySelectorAll('thead th');
      const offset = hasPhoto ? 1 : 0;
      cols.forEach((c, i) => {
        const th = ths[i + offset] as HTMLElement | undefined;
        if (th) th.className = this.sortCol === c ? (this.sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
      });
    }

    if (this.vt.el) this.vt.el.scrollTop = 0;
    this.vtPaint();
  }

  vtPaint() {
    const scrollEl = this.vt.el;
    if (!scrollEl) return;

    const rows = this.filtered;
    const ROW_H = this.vt.rowH;
    const BUFFER = 15;
    const scrollTop = scrollEl.scrollTop;
    const h = scrollEl.clientHeight || 600;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    const endIdx = Math.min(rows.length, Math.ceil((scrollTop + h) / ROW_H) + BUFFER);

    const topRow = document.getElementById('vt-top') as HTMLTableRowElement;
    const botRow = document.getElementById('vt-bot') as HTMLTableRowElement;
    const tbody = document.getElementById('vt-tbody') as HTMLTableSectionElement;
    if (!topRow || !botRow || !tbody) return;

    topRow.style.height = `${startIdx * ROW_H}px`;
    botRow.style.height = `${Math.max(0, rows.length - endIdx) * ROW_H + 100}px`;

    // Remove old data rows between spacers
    let node = topRow.nextSibling;
    while (node && node !== botRow) {
      const next = node.nextSibling;
      tbody.removeChild(node);
      node = next;
    }

    const cols = this.vt.cols;
    const hasPhoto = this.vt.hasPhoto;
    const q = this.searchQ;

    const hiddenSet = this.activeBoxId ? (this.hiddenRows.get(this.activeBoxId) ?? new Set<string>()) : new Set<string>();

    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      const p = rows[i];
      const d = p.data || {};
      const isHidden = hiddenSet.has(p.id);
      const tr = document.createElement('tr');
      tr.style.height = `${ROW_H}px`;
      tr.style.cursor = 'pointer';
      if (isHidden) tr.style.opacity = '0.45';
      tr.setAttribute('onclick', `window.app.viewProduct('${p.id}')`);
      tr.setAttribute('draggable', 'true');
      tr.setAttribute('ondragstart', `window.app.onRowDragStart(${i})`);
      tr.setAttribute('ondragover', `event.preventDefault();window.app.onRowDragOver(this,${i})`);
      tr.setAttribute('ondragleave', `window.app.onRowDragLeave(this)`);
      tr.setAttribute('ondrop', `event.preventDefault();window.app.onRowDrop(${i})`);

      // ── Ozon-синхронизация ────────────────────────────────────────────────
      const isSynced   = !!d['_ozon_synced_at'];
      const ozonStatus = String(d['_ozon_status'] || '');
      const ozonFbs    = d['_ozon_fbs'];
      const ozonFbo    = d['_ozon_fbo'];
      const syncedAt   = d['_ozon_synced_at'] ? new Date(d['_ozon_synced_at'] as string)
        .toLocaleString('ru', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      // ── YM/WB синхронизация ───────────────────────────────────────────────
      const isYmSynced      = !!d['_ym_synced_at'];
      const isWbSynced      = !!d['_wb_synced_at'];
      const ymSyncDisabled  = !!d['_ym_sync_disabled'];
      const wbSyncDisabled  = !!d['_wb_sync_disabled'];

      // Цвет статуса Ozon
      const ozColor = ozonStatus === 'processed' ? '#4ade80'
        : ozonStatus === 'disabled'          ? '#94a3b8'
        : ozonStatus === 'archived'          ? '#94a3b8'
        : ozonStatus === 'moderating'        ? '#fbbf24'
        : ozonStatus === 'failed_moderation' ? '#f87171'
        : ozonStatus === 'price_error'       ? '#fb923c'
        : ozonStatus === 'banned'            ? '#f87171'
        : '#005bff';

      const ozStatusLabel: Record<string, string> = {
        processed: 'Продаётся', disabled: 'Скрыт', archived: 'В архиве',
        moderating: 'Модерация', failed_moderation: 'Откл.', price_error: 'Ошибка цены',
        banned: 'Заблокирован',
      };

      const isSelected = this.selectedProducts.has(p.id);

      // Подсветка строки если синхронизирована или выделена
      if (isSelected) {
        tr.style.background = 'var(--bg3)';
      } else if (isSynced) {
        tr.style.borderLeft = `3px solid ${ozColor}`;
        // Сделали фон строки более прозрачным, чтобы выделялись конкретные ячейки
        tr.style.background = `color-mix(in srgb,${ozColor} 1.5%,transparent)`;
      }

      // Определяем какие именно колонки синхронизируются с Ozon
      let ozonMappedCols = new Set<string>();
      if (isSynced) {
        const mappedStr = d['_ozon_mapped_cols'] as string | undefined;
        if (mappedStr) {
          try { ozonMappedCols = new Set(JSON.parse(mappedStr)); } catch {}
        } else {
          // Fallback для товаров синхронизированных до этого обновления
          ozonMappedCols = new Set(['Цена, руб.*', 'Цена до скидки, руб.', 'Мин. цена, руб.', 'Название товара', 'Штрихкод', 'Бренд*', 'Ширина упаковки, мм*', 'Высота упаковки, мм*', 'Длина упаковки, мм*', 'Вес в упаковке, г*']);
        }
      }

      let html = '';
      
      // Чекбокс выделения
      html += `<td style="padding:0 0 0 10px;text-align:center;width:50px">
        <div class="chk ${isSelected ? 'on' : ''}" onclick="event.stopPropagation(); window.app.toggleProductSelection('${p.id}')" style="margin:0 auto;padding:4px">
          <div class="chk-box"><div class="chk-tick"></div></div>
        </div>
      </td>`;

      if (hasPhoto) {
        const photo = d['Ссылка на главное фото*'] || '';
        const presence = this.getMpPresenceFor(p);
        const isSynced = presence.length > 0;
        const tooltipText = isSynced
          ? `Найден в ${presence.length} магазин${presence.length === 1 ? 'е' : presence.length < 5 ? 'ах' : 'ах'}:\n` +
            presence.map(x => `• ${x.storeName} (${x.mp.toUpperCase()})`).join('\n')
          : 'Не найден ни в одном магазине';
        html += `<td style="padding:4px 6px;width:auto;min-width:90px;vertical-align:middle">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="position:relative;flex-shrink:0" title="${this.esc(tooltipText)}">
              ${photo
                ? `<img src="${this.esc(photo)}" style="width:38px;height:38px;object-fit:cover;border-radius:5px;border:1px solid var(--border);display:block;background:var(--bg4)" loading="lazy" onerror="this.style.opacity='.2'">`
                : `<div style="width:38px;height:38px;border-radius:5px;background:var(--bg4);border:1px solid var(--border)"></div>`
              }
              ${isSynced ? `
                <div style="position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;
                  background:#16a34a;border:2px solid var(--bg2);display:flex;align-items:center;justify-content:center;
                  font-size:8px;color:#fff;font-weight:900">✓</div>
              ` : ''}
            </div>
            ${isSynced ? `
              <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
                ${presence.slice(0, 3).map(x => `
                  <div style="display:flex;align-items:center;gap:3px;font-size:9px"
                    title="${this.esc(x.storeName + ' · ' + x.mp.toUpperCase())}">
                    <span style="width:5px;height:5px;border-radius:50%;background:${x.color};flex-shrink:0"></span>
                    <span style="color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${this.esc(x.storeName)}</span>
                  </div>
                `).join('')}
                ${presence.length > 3 ? `<div style="font-size:9px;color:var(--text3)">+${presence.length - 3}</div>` : ''}
              </div>
            ` : ''}
          </div>
        </td>`;
      }

      // Tooltip for Ozon status dot (used in Артикул* and Цена columns)
      const ozTip = isSynced
        ? `Синхронизировано с Ozon · ${ozStatusLabel[ozonStatus] || ozonStatus}${syncedAt ? ' · ' + syncedAt : ''}`
        : '';

      for (const c of cols) {
        if (c.startsWith('_ozon_')) continue;

        // Кастомные колонки — читаем из customColumnsDb, не из data
        let rawV: string;
        if (c.startsWith('★ ')) {
          rawV = this.getCustomColumnValue(p, c);
        } else {
          rawV = String(d[c] ?? '');
        }
        let v = this.esc(rawV);
        if (q && v.toLowerCase().includes(q.toLowerCase())) {
          v = v.replace(new RegExp(this.escapeRegex(q), 'gi'), m => `<mark>${m}</mark>`);
        }
        // Кастомные колонки — особое оформление
        if (c.startsWith('★ ')) {
          const isEmpty = !rawV;
          const isCostCol = c === '★ Себестоимость';
          const tintColor = isCostCol ? '#4ade80' : '#7c3aed';
          html += `<td style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:200px;background:color-mix(in srgb,${tintColor} 7%,transparent);border-left:1px solid color-mix(in srgb,${tintColor} 18%,transparent);font-weight:${isEmpty ? '400' : '600'};color:${isEmpty ? 'var(--muted)' : 'var(--text)'};font-style:${isEmpty ? 'italic' : 'normal'}">${v || '— не заполнено —'}</td>`;
          continue;
        }

        let cls = '';
        let prefix = '';
        let suffix = '';

        if (c === 'Артикул*') {
          cls = 'td-art';
          const artVal = String(d[c] ?? '');
          suffix = `<button class="copy-btn" title="Копировать артикул" onclick="event.stopPropagation();window.app.copyToClipboard('${this.esc(artVal)}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1"/><path d="M3.5 10.5V3.5h7"/></svg>
          </button>`;
          // Точки магазинов у артикула
          if (isSynced) {
            const ozonModule = (window as any).ozonModule;
            const ozonByOfferId = ozonModule?.groups || new Map();
            const group = ozonByOfferId.get(artVal);
            if (group && group.stores && group.stores.size > 0) {
              const dots = [...group.stores.keys()].map(sid => {
                const sName = ozonModule.stores?.find((s:any)=>s.id === sid)?.name || sid;
                const col = ozonModule.color(sid);
                return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${col};margin-right:2px;flex-shrink:0;vertical-align:middle" title="Товар есть в магазине: ${this.esc(sName)}"></span>`;
              }).join('');
              prefix = `<div style="display:inline-flex;align-items:center;margin-right:5px;gap:1px">${dots}</div>`;
            } else {
              prefix = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${ozColor};margin-right:5px;flex-shrink:0;vertical-align:middle" title="${this.esc(ozTip)}"></span>`;
            }
          }
        } else if (c === 'Название товара') {
          cls = 'td-name';
        } else if (c === 'Цена, руб.*') {
          cls = 'td-price';
          if (isSynced) {
            // Улучшенное выделение цены: ярко синий цвет + заметная плашка Ozon
            const stockInfo = (ozonFbs !== undefined || ozonFbo !== undefined)
              ? `FBS: ${ozonFbs ?? '?'} · FBO: ${ozonFbo ?? '?'}` : '';
            const tip = `Цена синхронизирована с Ozon · ${ozStatusLabel[ozonStatus] || ozonStatus}${stockInfo ? ' · ' + stockInfo : ''}${syncedAt ? ' · ' + syncedAt : ''}\nПри изменении цена обновится везде!`;
            
            v = `<strong style="color:#005bff;font-size:1.1em">${v}</strong>`;
            suffix = `<span style="margin-left:8px;font-size:10px;padding:3px 6px;border-radius:4px;background:#005bff;color:#fff;font-weight:700;white-space:nowrap;vertical-align:middle" title="${this.esc(tip)}">Ozon ↕</span>`;
          }
        }

        // Если ЭТА КОНКРЕТНАЯ колонка привязана к Ozon - подсвечиваем саму ячейку
        let cellStyle = `overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:200px`;
        if (ozonMappedCols.has(c)) {
           // Нежный синий фон ячейки, чтобы точно было видно, что именно это поле синхронизируется
           cellStyle += `;background:color-mix(in srgb,#005bff 8%,transparent);border-right:1px solid color-mix(in srgb,#005bff 15%,transparent);border-left:1px solid color-mix(in srgb,#005bff 15%,transparent)`;
           // Для остальных полей (кроме цены, где уже есть плашка) добавим микро-иконку
           if (c !== 'Цена, руб.*' && v) {
              suffix += `<span style="margin-left:4px;font-size:8px;color:#005bff;opacity:0.6;vertical-align:top" title="Синхронизируется с Ozon">☁</span>`;
           }
        }

        html += `<td class="${cls}" style="${cellStyle}">${prefix}${v || '—'}${suffix}</td>`;
      }

      // Кнопки: скрыть/показать + открыть
      const eyeTitle = isHidden ? 'Показать в таблице' : 'Скрыть из таблицы';
      const eyeIcon = isHidden
        ? `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:12px;height:12px"><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="7" cy="7" r="1.5"/><path d="M2 2l10 10" stroke-width="1.6"/></svg>`
        : `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:12px;height:12px"><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="7" cy="7" r="1.5"/></svg>`;
      // Индикаторы синхронизации (ЯМ/WB синхр. отключена)
      const box = boxes.get().find(b => b.id === p.box_id);
      const syncBadges = [
        isYmSynced || box?.ym_linked ? `<span
          title="${ymSyncDisabled ? 'Синхронизация ЯМ ОТКЛЮЧЕНА · нажмите чтобы включить' : 'Синхронизировано с ЯМ · нажмите чтобы отключить'}"
          onclick="event.stopPropagation();window.app.toggleSyncDisabled('${p.id}','ym')"
          style="cursor:pointer;font-size:9px;padding:1px 5px;border-radius:4px;font-weight:600;
            background:${ymSyncDisabled ? 'var(--bg4)' : 'color-mix(in srgb,#fc3f1d 12%,transparent)'};
            color:${ymSyncDisabled ? 'var(--text3)' : '#fc3f1d'};
            text-decoration:${ymSyncDisabled ? 'line-through' : 'none'};
            border:1px solid ${ymSyncDisabled ? 'var(--border)' : 'color-mix(in srgb,#fc3f1d 30%,transparent)'}">
          ЯМ</span>` : '',
        isWbSynced || box?.wb_linked ? `<span
          title="${wbSyncDisabled ? 'Синхронизация WB ОТКЛЮЧЕНА · нажмите чтобы включить' : 'Синхронизировано с WB · нажмите чтобы отключить'}"
          onclick="event.stopPropagation();window.app.toggleSyncDisabled('${p.id}','wb')"
          style="cursor:pointer;font-size:9px;padding:1px 5px;border-radius:4px;font-weight:600;
            background:${wbSyncDisabled ? 'var(--bg4)' : 'color-mix(in srgb,#cb11ab 12%,transparent)'};
            color:${wbSyncDisabled ? 'var(--text3)' : '#cb11ab'};
            text-decoration:${wbSyncDisabled ? 'line-through' : 'none'};
            border:1px solid ${wbSyncDisabled ? 'var(--border)' : 'color-mix(in srgb,#cb11ab 30%,transparent)'}">
          WB</span>` : '',
      ].filter(Boolean).join('');

      html += `<td style="width:${syncBadges ? 90 : 64}px;vertical-align:middle;padding:0 6px">
        <div style="display:flex;gap:3px;align-items:center;justify-content:flex-end;flex-wrap:wrap">
          ${syncBadges}
          <button class="btn" style="padding:3px 6px;font-size:11px;color:var(--muted)" title="${eyeTitle}"
            onclick="event.stopPropagation();window.app.toggleHideProduct('${p.id}')">${eyeIcon}</button>
          <button class="btn" style="padding:3px 6px;font-size:11px"
            onclick="event.stopPropagation();window.app.viewProduct('${p.id}')">→</button>
        </div>
      </td>`;
      tr.innerHTML = html;
      frag.appendChild(tr);
    }
    botRow.before(frag);
  }

  renderCards(content: HTMLElement) {
    const mainCols = ['Цвет товара', 'Цвет для фильтра', 'Название цвета', 'Тип*', 'Материал корпуса', 'Бренд*', 'Бренд *', 'Пол *', 'Размер в сетке *'];
    content.innerHTML = `<div class="cards-wrap">${this.filtered.map(p => {
      const d = p.data || {};
      const name = d['Название товара'] || d['Название товара *'] || '—';
      const art  = d['Артикул*'] || d['Артикул'] || '';
      const price = d['Цена, руб.*'] || d['Цена *'];
      const photo = d['Ссылка на главное фото*'] || '';
      const attrs = mainCols.filter(c => d[c]);
      
      const isSynced = !!d['_ozon_synced_at'];
      let ozonPriceHtml = '';
      if (price) {
        if (isSynced) {
          ozonPriceHtml = `<div class="card-price" style="color:#005bff;font-weight:800;font-size:1.15rem;display:flex;align-items:center;gap:6px;">
            ${Number(price).toLocaleString('ru')} ₽ 
            <span style="font-size:10px;padding:3px 6px;background:#005bff;color:#fff;border-radius:4px;line-height:1">Ozon ↕</span>
          </div>`;
        } else {
          ozonPriceHtml = `<div class="card-price">${Number(price).toLocaleString('ru')} ₽</div>`;
        }
      }

      const isSelected = this.selectedProducts.has(p.id);

      return `<div class="card ${isSelected ? 'selected' : ''}" onclick="window.app.viewProduct('${p.id}')">
        ${photo
          ? `<img class="card-photo" src="${this.esc(photo)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''
        }
        <div class="card-photo-placeholder" style="${photo ? 'display:none' : ''}">📦</div>
        <div class="card-body">
          <div style="position:absolute;top:10px;right:14px;z-index:2">
             <div class="chk ${isSelected ? 'on' : ''}" onclick="event.stopPropagation(); window.app.toggleProductSelection('${p.id}')" style="background:var(--bg);border-radius:4px;padding:2px">
               <div class="chk-box"><div class="chk-tick"></div></div>
             </div>
          </div>
          <div class="card-art">
            ${isSynced ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#005bff;margin-right:6px;vertical-align:middle" title="Синхронизировано с Ozon"></span>` : ''}
            ${this.esc(art)}
          </div>
          <div class="card-name">${this.esc(name)}</div>
          ${ozonPriceHtml}
          <div class="card-attrs">${attrs.slice(0, 3).map(c => `<span class="badge">${this.esc(String(d[c]))}</span>`).join('')}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  // ── Selection Methods ─────────────────────────────────────────────────────

  toggleProductSelection(id: string) {
    console.log('Toggling selection for product:', id);
    if (this.selectedProducts.has(id)) {
      this.selectedProducts.delete(id);
    } else {
      this.selectedProducts.add(id);
    }
    console.log('Current selection size:', this.selectedProducts.size);
    
    // ВАЖНО: В режиме карточек нужна полная перерисовка, в режиме таблицы - виртуальная
    if (this.viewMode === 'cards') {
      this.renderProducts();
    } else {
      this.vtPaint();
    }
    this.renderActionBar();
  }

  toggleAllSelection() {
    const allSelected = this.selectedProducts.size === this.filtered.length && this.filtered.length > 0;
    if (allSelected) {
      this.selectedProducts.clear();
    } else {
      this.filtered.forEach(p => this.selectedProducts.add(p.id));
    }
    
    if (this.viewMode === 'cards') {
      this.renderProducts();
    } else {
      this.vtPaint();
    }
    this.renderActionBar();
  }

  renderActionBar() {
    let bar = document.getElementById('action-bar');
    if (this.selectedProducts.size === 0) {
      if (bar) bar.style.display = 'none';
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'action-bar';
      bar.style.cssText = `
        position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
        background: var(--bg2); border: 1px solid var(--border); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2); padding: 12px 20px;
        display: flex; align-items: center; gap: 16px; z-index: 1100;
        animation: slideUp 0.2s ease-out;
      `;
      document.body.appendChild(bar);
    }

    const selectedProds = this.allProducts.filter(p => this.selectedProducts.has(p.id));
    let hasHidden = false;
    let hasVisible = false;
    selectedProds.forEach(p => {
      const isHidden = this.hiddenRows.get(p.box_id)?.has(p.id);
      if (isHidden) hasHidden = true;
      else hasVisible = true;
    });

    bar.style.display = 'flex';
    bar.innerHTML = `
      <div style="font-weight:600;font-size:14px;color:var(--text)">Выбрано: ${this.selectedProducts.size}</div>
      <div style="width:1px;height:24px;background:var(--border)"></div>
      <button class="btn btn-primary" onclick="window.app.openMassEditModal()">Редактировать</button>
      <button class="btn" onclick="window.app.openExportModal(true)">Экспорт</button>
      ${hasVisible ? `<button class="btn" onclick="window.app.massHideProducts(true)">👁 Скрыть</button>` : ''}
      ${hasHidden ? `<button class="btn" onclick="window.app.massHideProducts(false)">👁 Показать</button>` : ''}
      <button class="btn" onclick="window.app.massMoveProducts()">Переместить</button>
      <button class="btn" onclick="window.app.massDeleteProducts()" style="color:var(--red)">Удалить</button>
      <button class="btn" onclick="window.app.selectedProducts.clear(); window.app.renderActionBar(); window.app.renderDashboard()" style="margin-left:auto;border:none;background:transparent">✕ Снять</button>
    `;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────────────────────────────────────────

  onSearch(v: string) {
    this.searchQ = v;
    // Debounce: wait 280ms after last keystroke before filtering
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      if (!this.activeBoxId && v) {
        this.searchGlobal(v);
        return;
      }
      if (!this.activeBoxId && !v) { this.renderEmpty(); return; }
      this.applyFilters();
    }, 280);
  }

  private async searchGlobal(q: string) {
    if (!q) { this.renderEmpty(); return; }
    const content = document.getElementById('main-content');
    if (content) content.innerHTML = this.viewMode === 'cards' ? this.skeletonCards(8) : this.skeletonTable(10);
    try {
      // Optimization: use cached data when available instead of fetching all from server
      const allBoxes = boxes.get();
      const allCached = allBoxes.length > 0 && allBoxes.every(b => this.cache.has(b.id));
      if (allCached) {
        this.allProducts = allBoxes.flatMap(b => this.cache.get(b.id)!);
      } else {
        const all = await apiService.getAllProducts();
        this.allProducts = all || [];
      }
      this.buildColumns();
      this.applyFilters();
      const metaEl = document.getElementById('result-meta');
      if (metaEl) metaEl.textContent = 'по всем группам';
    } catch (e: any) { this.toast(e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRODUCT MODAL (VIEW / EDIT / DELETE / EXPORT)
  // ─────────────────────────────────────────────────────────────────────────

  /** Единый метод просмотра и редактирования товара */
  viewProduct(id: string, mode: 'view' | 'edit' = 'view') {
    const p = this.allProducts.find(x => x.id === id) || this.filtered.find(x => x.id === id);
    if (!p) return;
    const d = p.data || {};
    const art  = String(d['Артикул*'] || d['Артикул'] || id);
    const name = String(d['Название товара*'] || d['Название товара'] || 'Товар');

    // ── Фото ──────────────────────────────────────────────────────────────────
    const mainPhoto = String(d['Ссылка на главное фото*'] || '');
    const extraRaw  = String(d['Ссылки на дополнительные фото'] || '');
    const allPhotos = [
      ...(mainPhoto ? [mainPhoto] : []),
      ...parsePhotoUrls(extraRaw).filter((u: string) => u.startsWith('http')),
      ...Object.entries(d)
        .filter(([k]) => /^Дополнительное фото/.test(k))
        .map(([,v]) => String(v)).filter(v => v.startsWith('http')),
    ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);

    const galleryHtml = allPhotos.length ? `
      <div style="margin-bottom:12px">
        <img id="gallery-main-img" src="${this.esc(allPhotos[0])}" loading="lazy"
          style="width:100%;max-height:280px;object-fit:contain;border-radius:10px;cursor:pointer;background:var(--bg2)"
          onclick="window.open(this.src,'_blank')"
          onerror="this.style.opacity='.2'">
        ${allPhotos.length > 1 ? `
          <div style="display:flex;gap:5px;overflow-x:auto;padding-top:8px;scrollbar-width:thin">
            ${allPhotos.map((url, i) => `
              <img src="${this.esc(url)}" loading="lazy"
                style="width:52px;height:52px;object-fit:cover;border-radius:6px;cursor:pointer;flex-shrink:0;
                       border:2px solid ${i === 0 ? 'var(--accent)' : 'transparent'};transition:border-color .15s"
                onclick="document.getElementById('gallery-main-img').src='${this.esc(url)}';
                         document.querySelectorAll('.gthumb').forEach(t=>t.style.borderColor='transparent');
                         this.style.borderColor='var(--accent)'"
                class="gthumb" onerror="this.style.display='none'">
            `).join('')}
          </div>` : ''}
      </div>` : '';

    // ── Репрайсер ─────────────────────────────────────────────────────────────
    const repricerRules: any[] = repricerRulesDb.all();
    const matchedRules = repricerRules.filter((r: any) =>
      r.status === 'active' && (
        r.vendorCode?.toLowerCase() === art.toLowerCase() ||
        r.productId?.toLowerCase() === art.toLowerCase()
      )
    );
    const hasRepricer = matchedRules.length > 0;

    // ── FBO определение ───────────────────────────────────────────────────────
    const box = this.activeBoxId ? (window as any).boxes?.get().find((b: any) => b.id === this.activeBoxId) : null;
    const boxName = (box?.name || '').toLowerCase();
    const isFBO = boxName.includes('fbo') || boxName.includes('фбо') || boxName.includes('fby') || boxName.includes('фбу');

    // ── МП-присутствие ────────────────────────────────────────────────────────
    const mpInfo = (this.mpPresence as any)?.get(art.toLowerCase()) || [];
    const mpBadges = mpInfo.length ? `
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
        ${mpInfo.map((info: any) => `
          <div style="display:flex;align-items:center;gap:4px;padding:3px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;font-size:10px">
            <span>${info.mp === 'ozon' ? '🟠' : info.mp === 'ym' || info.mp === 'yandex' ? '🟡' : '🟣'}</span>
            <span style="font-weight:600">${this.esc(info.storeName || info.mp)}</span>
            ${info.fulfillment ? `<span style="opacity:.6">${info.fulfillment}</span>` : ''}
          </div>`).join('')}
      </div>` : '';

    // ── Сортировка полей ──────────────────────────────────────────────────────
    const HIDDEN = new Set([
      'Ссылка на главное фото*','Ссылки на дополнительные фото','Ссылки на фото 360',
      'Артикул фото','Образец цвета','#Хештеги','Rich-контент JSON','Аннотация','Описание',
      'Ошибка','Предупреждение',
    ]);
    const READONLY_FIELDS = new Set(['Артикул*','Артикул','SKU на Маркете','ID категории ЯМ']);
    const STOCK_FIELDS = new Set<string>(); // stock columns removed from sync

    // Парсим attr meta для словарных подсказок
    let attrMeta: Record<string, any> = {};
    try { if (d['_ozon_attr_meta']) attrMeta = JSON.parse(String(d['_ozon_attr_meta'])); } catch {}

    const isMpSynced = !!(d['_ozon_store_id'] || d['_ym_store_id']);
    const mpLabel = d['_ozon_store_id'] ? 'Ozon' : d['_ym_store_id'] ? 'Яндекс Маркет' : '';

    const price = String(d['Цена, руб.*'] || d['Цена *'] || d['Цена, руб.'] || '');

    // Фильтруем служебные поля (начинаются с _) и технические поля из HIDDEN
    const PHOTO_FIELD_KEYS = new Set([
      'Ссылка на главное фото*','Ссылки на дополнительные фото','Ссылки на фото 360','Образец цвета',
    ]);
    const INTERNAL_PREFIXES = ['_ozon_', '_ym_', '_wb_'];
    const isInternal = (k: string) => INTERNAL_PREFIXES.some(p => k.startsWith(p));

    const visEntries = Object.entries(d).filter(([k, v]) => {
      if (isInternal(k)) return false;
      if (HIDDEN.has(k)) return false;
      if (PHOTO_FIELD_KEYS.has(k)) return false; // Фото показаны в галерее отдельно
      if (k.startsWith('Дополнительное фото')) return false; // тоже в галерее
      return v !== '' && v != null;
    });

    const descText = String(d['Описание'] || d['Аннотация'] || '');

    // ── VIEW MODE ─────────────────────────────────────────────────────────────
    if (mode === 'view') {
      const costVal = costPriceDb.get(art);
      const repricerSection = `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">💰 Репрайсер</div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Себестоимость</div>
              <div style="font-size:17px;font-weight:800;color:${costVal != null ? 'var(--text)' : 'var(--muted)'};font-family:'Syne',sans-serif">
                ${costVal != null ? costVal.toLocaleString('ru') + ' ₽' : '— не задана'}
              </div>
            </div>
            ${costVal != null && price ? `
              <div>
                <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Наценка</div>
                <div style="font-size:17px;font-weight:800;color:var(--text);font-family:'Syne',sans-serif">
                  ×${(Number(price) / costVal).toFixed(2)}
                  <span style="font-size:11px;font-weight:500;color:var(--muted);margin-left:3px">
                    (+${Math.round(Number(price) - costVal).toLocaleString('ru')} ₽)
                  </span>
                </div>
              </div>` : ''}
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Правила</div>
              ${hasRepricer
                ? `<div style="font-size:12px;font-weight:600;color:#16a34a">✓ ${matchedRules.map((r:any)=>this.esc(r.storeName||r.marketplace)).join(', ')}</div>`
                : `<div style="font-size:12px;color:var(--muted)">не настроен</div>`}
            </div>
          </div>
          ${costVal == null ? `<div style="font-size:11px;color:#f59e0b;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">⚠ Себестоимость не задана — репрайсер не сможет рассчитать цену</div>` : ''}
        </div>`;

      const fboBanner = isFBO ? `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:11px;color:var(--muted)">
          <span>🏭</span> FBO — остатки управляются маркетплейсом
        </div>` : '';

      // Разбиваем на секции для лучшей читаемости
      const MAIN_VIEW = new Set(['Артикул*','Артикул','Название товара*','Название товара','Цена, руб.*','Цена, руб.','Цена *','Старая цена, руб.','Штрихкод','Бренд','Бренд*','Предмет','Категория','NM ID']);
      const mainViewEntries = visEntries.filter(([k]) => MAIN_VIEW.has(k));
      const extraViewEntries = visEntries.filter(([k]) => !MAIN_VIEW.has(k) && k !== 'Описание' && k !== 'Аннотация');

      const renderSection = (entries: Array<[string, any]>) => entries.map(([k, v]) => `
        <div class="detail-item">
          <div class="dk">${this.esc(k.replace('*',''))}</div>
          <div class="dv" style="user-select:text">${this.esc(String(v))}</div>
        </div>`).join('');

      const dims = dimensionsDb.get(art);
      const fmtG = (g: number|null) => g != null ? `${g} г · ${(g/1000).toFixed(3).replace(/\.?0+$/,'')} кг` : '—';
      const fmtMm = (mm: number|null) => mm != null ? `${mm} мм` : '—';
      const fmtCm = (mm: number|null) => mm != null ? `${(mm/10).toFixed(1).replace('.0','')} см` : '—';
      const dimsSection = dims && (dims.weight_g != null || dims.length_mm != null) ? `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📦 Габариты и вес</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px">
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Вес</div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">${fmtG(dims.weight_g)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Размеры Д×Ш×В</div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">${fmtMm(dims.length_mm)} × ${fmtMm(dims.width_mm)} × ${fmtMm(dims.height_mm)}</div>
            </div>
          </div>
          <div style="font-size:10px;color:var(--muted);padding-top:6px;border-top:1px solid var(--border)">
            WB / ЯМ (см + кг): ${fmtCm(dims.length_mm)} × ${fmtCm(dims.width_mm)} × ${fmtCm(dims.height_mm)} · ${dims.weight_g != null ? (dims.weight_g/1000).toFixed(3).replace(/\.?0+$/,'') + ' кг' : '—'}
          </div>
        </div>
      ` : `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">📦 Габариты и вес</div>
          <div style="font-size:12px;color:var(--muted)">Не задано — нажми «Редактировать» чтобы указать вес и размеры</div>
        </div>
      `;
      const body = `
        ${repricerSection}${dimsSection}${fboBanner}${galleryHtml}${mpBadges}
        ${price ? `<div style="font-size:24px;font-weight:700;color:${hasRepricer ? '#16a34a' : 'var(--accent)'};margin-bottom:12px;font-family:'Syne',sans-serif">
          ${Number(price).toLocaleString('ru')} ₽
          ${hasRepricer ? `<span style="font-size:11px;font-weight:500;opacity:.7;margin-left:6px">репрайсер</span>` : ''}
        </div>` : ''}
        ${mainViewEntries.length ? `<div class="detail-grid">${renderSection(mainViewEntries)}</div>` : ''}
        ${extraViewEntries.length ? `
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px">Характеристики</div>
          <div class="detail-grid">${renderSection(extraViewEntries)}</div>` : ''}
        ${descText ? `<div class="divider" style="margin:12px 0"></div>
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Описание</div>
          <div style="font-size:12.5px;color:var(--text2);line-height:1.6;user-select:text">${this.esc(descText)}</div>` : ''}
        ${visEntries.length === 0 && !descText ? '<div style="color:var(--muted);font-size:13px;padding:8px 0">Нет данных</div>' : ''}
      `;

      this.openModalLg(name,
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <code style="font-size:12px;background:var(--bg2);padding:2px 6px;border-radius:4px">${this.esc(art)}</code>
          <button class="copy-btn" onclick="window.app.copyToClipboard('${this.esc(art)}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1"/><path d="M3.5 10.5V3.5h7"/></svg>
          </button>
        </div>`,
        body,
        `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>
         <button class="btn" onclick="window.app.exportSingleProduct('${id}')">↓ xlsx</button>
         <button class="btn btn-danger" onclick="window.app.confirmDeleteProduct('${id}','${this.esc(art)}')">✕</button>
         <button class="btn btn-primary" onclick="window.app.viewProduct('${id}','edit')" style="margin-left:auto">✎ Редактировать</button>`
      );
      return;
    }

    // ── EDIT MODE ─────────────────────────────────────────────────────────────
    // Скрытые служебные поля сохраняем как hidden inputs
    const hiddenInputs = Object.entries(d)
      .filter(([k]) => k.startsWith('_ozon_') || k.startsWith('_ym_') || k.startsWith('_wb_'))
      .map(([k,v]) => `<input type="hidden" class="edit-inp" data-key="${this.esc(k)}" value="${this.esc(String(v??''))}">`)
      .join('');

    // Категоризация полей
    const MAIN_FIELDS  = ['Артикул*','Артикул','Название товара*','Название товара',
      'Цена, руб.*','Цена *','Цена, руб.','Старая цена, руб.','Мин. цена, руб.',
      'Штрихкод','Бренд','Бренд*','Предмет','Категория','НДС, %'];
    const PHOTO_KEYS   = new Set(['Ссылка на главное фото*','Ссылки на дополнительные фото',
      'Ссылки на фото 360','Образец цвета']);
    const DESC_KEYS    = new Set(['Описание','Аннотация','Rich-контент JSON']);
    const STOCK_KEYS   = new Set(['NM ID','SKU на Маркете','ID категории ЯМ']);

    const mainEntries  = visEntries.filter(([k]) => MAIN_FIELDS.includes(k) || STOCK_KEYS.has(k));
    const descEntries  = visEntries.filter(([k]) => DESC_KEYS.has(k));
    const extraEntries = visEntries.filter(([k]) =>
      !MAIN_FIELDS.includes(k) && !PHOTO_KEYS.has(k) && !k.startsWith('Дополнительное фото') &&
      !DESC_KEYS.has(k) && !STOCK_KEYS.has(k) && !(k.includes('фото') && !MAIN_FIELDS.includes(k))
    );

    const renderField = (k: string, v: any): string => {
      const isReadonly      = READONLY_FIELDS.has(k);
      const isStockField    = STOCK_FIELDS.has(k);
      const isPriceField    = k.toLowerCase().includes('цена');
      const isRepricerLocked = isPriceField && hasRepricer;
      const isFboLocked     = isStockField && isFBO;
      const locked          = isReadonly || isRepricerLocked || isFboLocked;
      const isDictAttr      = attrMeta[k]?.dictionary_value_id !== undefined;
      const isDesc          = DESC_KEYS.has(k);

      let inputHtml: string;
      if (locked) {
        const reason = isRepricerLocked ? '💚 репрайсер' : isFboLocked ? '🏭 FBO' : 'только чтение';
        inputHtml = `<div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;padding:5px 8px;background:${isRepricerLocked ? '#16a34a10' : 'var(--bg3)'};border-radius:6px;border:1px solid ${isRepricerLocked ? '#16a34a30' : 'var(--border)'};font-size:12px;color:var(--text2)">${this.esc(String(v??''))}</div>
          <span style="font-size:10px;color:var(--muted)">${reason}</span>
        </div><input type="hidden" class="edit-inp" data-key="${this.esc(k)}" value="${this.esc(String(v??''))}">`;
      } else if (isDesc) {
        inputHtml = `<textarea class="edit-inp" data-key="${this.esc(k)}" rows="4"
          style="width:100%;resize:vertical;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
          >${this.esc(String(v??''))}</textarea>`;
      } else {
        inputHtml = `<input class="edit-inp" data-key="${this.esc(k)}" value="${this.esc(String(v??''))}"
          style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
          ${isDictAttr ? 'title="Словарный атрибут маркетплейса — вводите точное значение"' : ''}>`;
      }

      const syncDot  = isMpSynced && !locked ? `<span style="width:5px;height:5px;border-radius:50%;background:#005bff;display:inline-block;margin-left:4px" title="Синхронизируется с ${mpLabel}"></span>` : '';
      const dictBadge = isDictAttr && !locked ? `<span style="font-size:9px;padding:1px 3px;border-radius:3px;background:var(--bg3);color:var(--muted);margin-left:3px">dict</span>` : '';

      return `<div style="display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:start;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2);padding-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(k)}">
          ${this.esc(k.replace('*',''))}${syncDot}${dictBadge}
        </div>
        <div>${inputHtml}</div>
      </div>`;
    };

    // Фото-секция с загрузкой с ПК
    const photoSection = (() => {
      // Собираем фото: главное + доп. (из единого поля «Ссылки на дополнительные фото»)
      const photoFields: Array<{key: string; url: string; slot: number}> = [];
      const mainPh = String(d['Ссылка на главное фото*'] || '');
      photoFields.push({ key: 'Ссылка на главное фото*', url: mainPh, slot: 0 });

      const extraRaw = String(d['Ссылки на дополнительные фото'] || '');
      const extraUrls = extraRaw.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
      // Показываем существующие + 3 пустых слота для добавления
      const totalExtra = Math.max(extraUrls.length + 3, 5);
      for (let i = 0; i < totalExtra; i++) {
        photoFields.push({
          key: `_extra_photo_${i}`,
          url: extraUrls[i] || '',
          slot: i + 1,
        });
      }

      return `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
            Фото
            <span style="font-size:10px;font-weight:400;color:var(--muted)">(загрузить с ПК или вставить URL)</span>
          </div>
          <div id="edit-photos-grid" style="display:flex;flex-direction:column;gap:6px">
            ${photoFields.map((pf, idx) => `
              <div class="edit-photo-row" style="display:flex;align-items:center;gap:8px" data-photo-idx="${idx}">
                <div style="width:44px;height:44px;border-radius:6px;background:var(--bg3);flex-shrink:0;overflow:hidden;border:1px solid var(--border)">
                  ${pf.url ? `<img src="${this.esc(pf.url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:16px;color:var(--muted)">${idx === 0 ? '🖼' : '+'}</div>`}
                </div>
                <input class="edit-photo-inp" data-photo-slot="${idx}" value="${this.esc(pf.url)}"
                  placeholder="${idx === 0 ? 'Главное фото — URL' : `Доп. фото ${idx} — URL`}"
                  style="flex:1;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
                  oninput="window.app.onPhotoUrlInput(this, ${idx})">
                <label style="cursor:pointer;flex-shrink:0" title="Загрузить с ПК">
                  <input type="file" accept="image/*" style="display:none" onchange="window.app.onPhotoFileChosen(this, '${idx === 0 ? 'Ссылка на главное фото*' : 'Ссылки на дополнительные фото'}', '${id}', ${idx})">
                  <div class="btn" style="padding:5px 8px;font-size:11px;gap:4px;pointer-events:none">
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:12px;height:12px"><path d="M7 1v8M4 5l3-4 3 4"/><path d="M2 11h10"/></svg>
                    с ПК
                  </div>
                </label>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    })();

    const syncBanner = isMpSynced ? `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:color-mix(in srgb,#005bff 8%,transparent);border:1px solid color-mix(in srgb,#005bff 25%,transparent);border-radius:8px;margin-bottom:12px;font-size:12px">
        <svg viewBox="0 0 14 14" fill="none" stroke="#005bff" stroke-width="1.4" stroke-linecap="round" style="width:13px;height:13px;flex-shrink:0"><path d="M12 7A5 5 0 1 1 7 2"/><polyline points="12 2 12 5.5 8.5 5.5"/></svg>
        <span style="color:#005bff;font-weight:600">Синхр. с ${mpLabel}</span>
        <span style="color:var(--muted);font-size:11px">— изменения отправятся на маркетплейс</span>
      </div>` : '';

    const section = (title: string, fields: Array<[string, any]>, icon: string) => {
      if (!fields.length) return '';
      return `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${icon} ${title}</div>
          ${fields.map(([k,v]) => renderField(k, v)).join('')}
        </div>`;
    };

    const addFieldSection = `
      <div style="margin-top:10px;padding:8px 0">
        <div id="edit-add-field" style="display:none;gap:8px;align-items:flex-end;margin-bottom:8px">
          <div style="flex:1">
            <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Название поля</div>
            <input id="new-field-name" class="form-input" style="font-size:12px" placeholder="Например: Состав, Страна производства...">
          </div>
          <div style="width:100px">
            <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Значение</div>
            <input id="new-field-value" class="form-input" style="font-size:12px" placeholder="Значение">
          </div>
          <button class="btn btn-primary" style="font-size:12px;padding:5px 10px;white-space:nowrap"
            onclick="window.app.addNewFieldToEdit()">✓ Добавить</button>
          <button class="btn" style="font-size:12px;padding:5px 8px"
            onclick="document.getElementById('edit-add-field').style.display='none'">✕</button>
        </div>
        <div id="extra-fields-container"></div>
        <button class="btn" style="font-size:11px;gap:4px;color:var(--accent);border-color:var(--accent)"
          onclick="const el=document.getElementById('edit-add-field');el.style.display=el.style.display==='none'?'flex':'none';document.getElementById('new-field-name')?.focus()">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:11px;height:11px"><path d="M7 1v12M1 7h12"/></svg>
          Добавить новое поле
        </button>
      </div>`;

    const costForEdit = costPriceDb.get(art);
    const repricerEditSection = `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">💰 Репрайсер</div>
        <div style="display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text2);padding-top:2px">Себестоимость</div>
          <div style="display:flex;align-items:center;gap:6px">
            <input id="edit-cost-price" data-article="${this.esc(art)}" type="number" min="0" step="0.01"
              value="${costForEdit ?? ''}" placeholder="Не задана"
              style="width:130px;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
            <span style="font-size:11px;color:var(--muted)">₽</span>
          </div>
        </div>
        <div style="padding:6px 0;font-size:11px;color:${hasRepricer ? '#16a34a' : 'var(--muted)'}">
          ${hasRepricer
            ? `✓ Репрайсер активен: <b>${matchedRules.map((r:any)=>this.esc(r.storeName||r.marketplace)).join(', ')}</b>`
            : `Репрайсер не настроен · <a href="#" onclick="event.preventDefault();window.app.closeModal();window.app.navigateTo('repricer')" style="color:var(--accent)">настроить →</a>`}
        </div>
      </div>`;

    const dimsForEdit = dimensionsDb.get(art);
    const dimsEditSection = `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📦 Габариты и вес (Ozon: мм + г)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Вес, г</div>
            <input id="dim-weight" type="number" min="0" step="1" value="${dimsForEdit?.weight_g ?? ''}" placeholder="напр. 350"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Длина, мм</div>
            <input id="dim-length" type="number" min="0" step="1" value="${dimsForEdit?.length_mm ?? ''}" placeholder="напр. 250"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Ширина, мм</div>
            <input id="dim-width" type="number" min="0" step="1" value="${dimsForEdit?.width_mm ?? ''}" placeholder="напр. 180"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Высота, мм</div>
            <input id="dim-height" type="number" min="0" step="1" value="${dimsForEdit?.height_mm ?? ''}" placeholder="напр. 80"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">
          WB и ЯМ используют см + кг — конвертация автоматическая при синхронизации.
        </div>
      </div>
    `;
    const editBody = `
      ${syncBanner}${hiddenInputs}
      ${photoSection}
      ${repricerEditSection}
      ${dimsEditSection}
      ${section('Основные данные', mainEntries, '📋')}
      ${section('Характеристики', extraEntries, '🏷')}
      ${section('Описание', descEntries, '📝')}
      ${addFieldSection}
    `;

    this.openModalLg(name,
      `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <code style="font-size:12px;background:var(--bg2);padding:2px 6px;border-radius:4px">${this.esc(art)}</code>
        <span style="font-size:11px;color:#005bff;font-weight:600">— редактирование</span>
      </div>`,
      editBody,
      `<button class="btn" onclick="window.app.viewProduct('${id}','view')">✗ Отмена</button>
       <button class="btn btn-primary" onclick="window.app.saveProduct('${id}')" style="margin-left:auto">💾 Сохранить</button>`
    );
  }

  /** Обновить превью фото при изменении URL */
  onPhotoUrlInput(inp: HTMLInputElement, idx: number) {
    const row = inp.closest('.edit-photo-row');
    if (!row) return;
    const imgWrap = row.querySelector('div');
    if (!imgWrap) return;
    const url = inp.value.trim();
    imgWrap.innerHTML = url
      ? `<img src="${this.esc(url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`
      : `<div style="display:flex;align-items:center;justify-content:height:100%;font-size:16px;color:var(--muted)">${idx === 0 ? '🖼' : '+'}</div>`;
  }

  /** Загрузка фото с ПК */
  async onPhotoFileChosen(input: HTMLInputElement, _fieldKey: string, productId: string, _idx: number) {
    const file = input.files?.[0];
    if (!file) return;
    const row = input.closest('.edit-photo-row') as HTMLElement;
    if (row) row.style.opacity = '0.5';
    try {
      const { uploadPhoto } = await import('./services/photoUpload');
      const url = await uploadPhoto(file, productId);
      // Обновляем поле URL
      const urlInput = row?.querySelector<HTMLInputElement>('.edit-inp[data-key]');
      if (urlInput) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input'));
      }
      // Обновляем превью
      const imgWrap = row?.querySelector('div');
      if (imgWrap) {
        imgWrap.innerHTML = `<img src="${this.esc(url)}" style="width:100%;height:100%;object-fit:cover">`;
      }
      if (url.startsWith('data:')) {
        this.toast('⚠ Storage недоступен — фото сохранено локально. Для синхронизации с МП нужен URL.', 'info', 5000);
      } else {
        this.toast('✅ Фото загружено', 'success', 2000);
      }
    } catch (e: any) {
      this.toast('Ошибка загрузки фото: ' + e.message, 'error');
    } finally {
      if (row) row.style.opacity = '1';
    }
  }

  /** Добавить новое кастомное поле из редактора */
  addNewFieldToEdit() {
    const nameEl  = document.getElementById('new-field-name')  as HTMLInputElement;
    const valueEl = document.getElementById('new-field-value') as HTMLInputElement;
    const name  = nameEl?.value?.trim();
    const value = valueEl?.value?.trim() ?? '';
    if (!name) { nameEl?.focus(); return; }

    const container = document.getElementById('extra-fields-container');
    if (!container) return;

    const div = document.createElement('div');
    div.style.cssText = 'display:grid;grid-template-columns:140px 1fr 28px;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)';
    div.innerHTML = `
      <div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(name)}</div>
      <input class="edit-inp" data-key="${this.esc(name)}" value="${this.esc(value)}"
        style="font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
      <button onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px">✕</button>
    `;
    container.appendChild(div);

    nameEl.value  = '';
    valueEl.value = '';
    nameEl.focus();
  }

  /** @deprecated — используй viewProduct(id, 'edit') */
  openEditProduct(id: string) { this.viewProduct(id, 'edit'); }
  async saveProduct(id: string) {
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('.edit-inp, .edit-sel');
    const data: Record<string, string> = {};
    inputs.forEach(inp => { if (inp.dataset.key) data[inp.dataset.key] = inp.value; });

    // Сохраняем предыдущие данные ДО обновления (нужны для diff при push на МП)
    const p = this.allProducts.find(x => x.id === id);
    const prevData: Record<string, any> = { ...(p?.data || {}) };

    // Сохраняем себестоимость если поле заполнено
    const costInp = document.getElementById('edit-cost-price') as HTMLInputElement | null;
    if (costInp) {
      const costArt = costInp.dataset.article ?? '';
      const rawVal = costInp.value.trim();
      if (costArt) {
        if (rawVal === '') {
          costPriceDb.remove(costArt);
        } else {
          const num = parseFloat(rawVal);
          if (!isNaN(num) && num >= 0) costPriceDb.set(costArt, num);
        }
      }
    }

    // Сохраняем габариты
    const dimW  = +(document.getElementById('dim-weight') as HTMLInputElement)?.value || 0;
    const dimL  = +(document.getElementById('dim-length') as HTMLInputElement)?.value || 0;
    const dimWd = +(document.getElementById('dim-width')  as HTMLInputElement)?.value || 0;
    const dimH  = +(document.getElementById('dim-height') as HTMLInputElement)?.value || 0;
    const artKey = String(data['Артикул*'] || data['Артикул'] || p?.data?.['Артикул*'] || p?.data?.['Артикул'] || '');
    if (artKey) {
      const hasDims = dimW > 0 || dimL > 0 || dimWd > 0 || dimH > 0;
      if (hasDims) {
        dimensionsDb.set(artKey, {
          weight_g: dimW > 0 ? Math.round(dimW) : null,
          length_mm: dimL > 0 ? Math.round(dimL) : null,
          width_mm: dimWd > 0 ? Math.round(dimWd) : null,
          height_mm: dimH > 0 ? Math.round(dimH) : null,
        });
      } else {
        dimensionsDb.remove(artKey);
      }
    }

    try {
      await apiService.updateProduct(id, { data });
      if (p) p.data = data;
      this.toast('Сохранено', 'success');
      this.closeModal();
      this.applyFilters();

      // ── Push на маркетплейс ─────────────────────────────────────────────
      const box = boxes.get().find(b => b.id === this.activeBoxId);
      const isMpSynced = !!(data['_ozon_store_id'] || data['_ym_store_id']);

      if (isMpSynced) {
        // Новые авто-синхронизированные группы — полный push всех атрибутов
        this.toast('⏳ Отправляем изменения на маркетплейс...', 'info', 2000);
        import('./services/mpProductPush').then(async ({ pushProductChanges }) => {
          try {
            const res = await pushProductChanges(data, prevData);
            if (!res) return;
            if (res.ok) {
              this.toast(`✅ Изменения сохранены на ${res.mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}`, 'success', 4000);
            } else {
              const errMsg = res.errors.slice(0, 2).join(' | ');
              this.toast(`⚠ МП: ${errMsg}`, 'error', 6000);
            }
          } catch (e: any) {
            this.toast(`⚠ Ошибка push на МП: ${e.message?.slice(0, 80)}`, 'error', 6000);
          }
        });
      } else if (box?.ozon_store_id) {
        // Старые группы с ручной привязкой Ozon — только цена+название
        this.pushProductToOzon(id, data, box).catch(() => {});
      }
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  /**
   * Push a single product's changes to Ozon API.
   * Called automatically after saveProduct() if the box is linked to Ozon.
   */
  async pushProductToOzon(
    _productId: string,
    data: Record<string, string>,
    box: import('./types').Box,
  ): Promise<void> {
    const ozonModule = (window as any).ozonModule;
    const store = ozonModule?.stores?.find((s: any) => s.id === box.ozon_store_id);
    if (!store) return;

    const skuField = box.ozon_sku_field || 'Артикул*';
    const offerId = String(data[skuField] || '').trim();
    if (!offerId) return;

    const price    = data['Цена, руб.*'];
    const oldPrice = data['Цена до скидки, руб.'];
    const name     = data['Название товара'];

    // Обновляем цену если изменилась
    if (price) {
      try {
        const { ozonApi } = await import('./services/ozonApi');
        await ozonApi.updatePrices(store, [{
          offer_id: offerId,
          price,
          old_price: oldPrice || undefined,
        }]);
        this.toast(`Цена обновлена в Ozon (${offerId})`, 'success', 2500);
      } catch (e: any) {
        this.toast(`Ozon: не удалось обновить цену — ${e.message.slice(0, 60)}`, 'error');
      }
    }

    // Обновляем название если изменилось
    if (name) {
      try {
        const { ozonApi } = await import('./services/ozonApi');
        const fullInfo = await ozonApi.getFullProductInfo(offerId, null, store);
        if (fullInfo) {
          await ozonApi.updateProduct(store, {
            ...fullInfo,
            name,
            offer_id: offerId,
            price: price || String(fullInfo.price || '0'),
          });
        }
      } catch {
        // название — некритично, продолжаем
      }
    }
  }

  confirmDeleteProduct(id: string, art: string) {
    this.openModal('Удалить товар?', `Артикул: ${art}`,
      `<p style="color:var(--text2);font-size:13.5px">Это действие нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.viewProduct('${id}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.deleteProduct('${id}')">Удалить</button>`
    );
  }

  async deleteProduct(id: string) {
    try {
      await apiService.deleteProduct(id);
      this.allProducts = this.allProducts.filter(p => p.id !== id);
      if (this.activeBoxId) {
        this.cache.set(this.activeBoxId, this.allProducts);
        idbCache.set(this.activeBoxId, this.allProducts).catch(() => {});
      }
      this.toast('Товар удалён', 'success');
      this.closeModal();
      this.buildColumns();
      this.applyFilters();
      if (this.activeBoxId) this.loadBoxCount(this.activeBoxId);
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — CREATE
  // ─────────────────────────────────────────────────────────────────────────

  openNewBoxModal() {
    this.openModal('Новая группа', 'Назовите группу для ваших товаров',
      `<div class="form-row">
        <div class="form-label">Название группы</div>
        <input class="form-input" id="new-box-name" placeholder="Например: Кровати май, Комоды 2025…" autofocus>
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.createBox()">Создать</button>`
    );
    setTimeout(() => (document.getElementById('new-box-name') as HTMLInputElement)?.focus(), 50);
  }

  async createBox() {
    const nameEl = document.getElementById('new-box-name') as HTMLInputElement;
    const name = nameEl?.value?.trim();
    if (!name) { this.toast('Введите название', 'error'); return; }
    try {
      const box = await apiService.createBox({ name, sticker: '📦' });
      boxActions.addBox(box);
      this.renderBoxes();
      this.closeModal();
      this.toast(`Группа «${name}» создана`, 'success');
      await this.selectBox(box.id);
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — RENAME (with emoji picker)
  // ─────────────────────────────────────────────────────────────────────────

  renameBox(id: string, currentName: string) {
    const box = boxes.get().find(b => b.id === id);
    const current = box?.sticker || '📦';
    const isApple = /iPhone|iPad|Mac/.test(navigator.userAgent);
    const isWin   = /Win/.test(navigator.userAgent);
    const shortcut = isApple ? '⌃⌘Space' : isWin ? 'Win + .' : 'системный выбор эмодзи';

    this.openModal('Настройки группы', '',
      `<div style="display:flex;gap:12px;align-items:flex-start">
        <!-- Эмодзи -->
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div id="rb-emoji-display"
            style="width:56px;height:56px;border-radius:12px;background:var(--bg2);border:2px solid var(--border);
                   display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;user-select:none"
            onclick="window.app.openNativeEmojiPicker()"
            title="Нажмите чтобы выбрать эмодзи устройства">${this.esc(current)}</div>
          <button class="btn" style="font-size:10px;padding:3px 8px;gap:3px" onclick="window.app.openNativeEmojiPicker()">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:10px;height:10px"><circle cx="7" cy="7" r="5.5"/><path d="M4.5 8.5s.8 1.5 2.5 1.5 2.5-1.5 2.5-1.5M5 5.5h.01M9 5.5h.01"/></svg>
            Выбрать
          </button>
          <!-- Скрытый input для нативного picker -->
          <input id="rb-emoji-inp" type="text" inputmode="text" maxlength="6"
            style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"
            value="${this.esc(current)}"
            oninput="window.app.onEmojiInputChange(this)">
        </div>
        <!-- Название -->
        <div style="flex:1">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600">Название группы</div>
          <input class="form-input" id="rename-inp" value="${this.esc(currentName)}" placeholder="Кровати, Комоды…">
          <div style="font-size:10px;color:var(--muted);margin-top:6px">
            Для выбора эмодзи нажмите кнопку слева или используйте <b>${shortcut}</b>
          </div>
        </div>
      </div>
      <span id="sticker-display" style="display:none">${this.esc(current)}</span>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doRenameBox('${id}')">Сохранить</button>`
    );
    setTimeout(() => {
      const inp = document.getElementById('rename-inp') as HTMLInputElement;
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  }

  /** Открыть нативный эмодзи-пикер устройства */
  openNativeEmojiPicker() {
    const inp = document.getElementById('rb-emoji-inp') as HTMLInputElement;
    if (!inp) return;
    // Делаем input видимым и фокусируемым, затем скрываем обратно
    inp.style.cssText = 'position:fixed;bottom:50%;left:50%;width:40px;height:40px;opacity:.01;font-size:24px;border:none;outline:none;z-index:9999';
    inp.focus();
    // На большинстве устройств это не триггерит picker, поэтому используем clipboard trick
    // Лучший кросс-браузерный способ — просто сфокусировать и сказать пользователю нажать шортат
    setTimeout(() => {
      inp.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px';
    }, 3000);
  }

  onEmojiInputChange(inp: HTMLInputElement) {
    const emoji = this.extractFirstEmoji(inp.value.trim());
    if (emoji) {
      inp.value = emoji;
      this.selectSticker(emoji, true);
      // Обновляем отображение
      const display = document.getElementById('rb-emoji-display');
      if (display) display.textContent = emoji;
    }
    else if (inp.value.trim() === '') {
      inp.value = '📦'; this.selectSticker('📦', true);
      const display = document.getElementById('rb-emoji-display');
      if (display) display.textContent = '📦';
    }
  }

  selectSticker(emoji: string, _keepOpen?: boolean) {
    const display = document.getElementById('sticker-display');
    if (display) display.textContent = emoji;
    const emojiInp = document.getElementById('rb-emoji-inp') as HTMLInputElement;
    if (emojiInp && emojiInp.value !== emoji) emojiInp.value = emoji;
    document.querySelectorAll('.rb-quick-btn').forEach(b => {
      (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.emoji === emoji);
    });
  }

  async doRenameBox(id: string) {
    const inp = document.getElementById('rename-inp') as HTMLInputElement;
    if (!inp) return;
    const name = inp.value.trim();
    if (!name) { this.toast('Введите название', 'error'); return; }
    const sticker = document.getElementById('sticker-display')?.textContent?.trim() || '📦';
    try {
      await apiService.updateBox(id, { name, sticker });
      boxActions.updateBox(id, { name, sticker });
      this.renderBoxes();
      this.closeModal();
      this.toast('Название и стикер обновлены', 'success');
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — SETTINGS (единая панель настроек группы)
  // ─────────────────────────────────────────────────────────────────────────

  /** legacy, unused */
  private _bsActiveTabLegacy: string = 'main'; private get _bsActiveTab() { return this._bsActiveTabLegacy; } private set _bsActiveTab(v: string) { this._bsActiveTabLegacy = v; }

  openBoxSettings(id: string, _tab?: string) {
    const box = boxes.get().find(b => b.id === id);
    if (!box) return;

    // API-синхронизированная группа — упрощённый просмотр
    if (box.mp_source) {
      const mpLabel = box.mp_source === 'ozon' ? '🟠 Ozon' : box.mp_source === 'ym' ? '🟡 Яндекс Маркет' : '🟣 WB';
      const lastSync = box.mp_last_sync
        ? new Date(box.mp_last_sync).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
        : 'ещё не синхронизировано';
      this.openModal(
        'Магазин', box.name,
        `<div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Источник</div>
              <div style="font-size:13px;font-weight:600">${mpLabel}</div>
            </div>
            <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Последнее обновление</div>
              <div style="font-size:12px;font-weight:600">${lastSync}</div>
            </div>
          </div>
          <div style="padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">ID магазина</div>
            <div style="font-size:11px;font-family:monospace;color:var(--text2)">${this.esc(box.mp_store_id || '—')}</div>
          </div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;padding:8px 0">
            Эта группа управляется автоматически через API маркетплейса. Для обновления данных нажмите «↻ Обновить».
          </div>
        </div>`,
        `<button class="btn btn-danger" onclick="window.app.deleteBox('${id}','${this.esc(box.name)}')">Удалить</button>
         <button class="btn" onclick="window.app.closeModal()">Закрыть</button>
         <button class="btn btn-primary" onclick="window.app.closeModal();window.app.refreshMpBox('${id}')">↻ Обновить</button>`
      );
      return;
    }

    // Ручная группа — компактные настройки
    const quick = ['📦','🎁','🛒','🛍️','📁','🗂️','📋','💼','🏠','🚚','🌟','💎','🔥','🎯','🎨','📱','💻','🎮','⚽','🍔'];
    const current = box.sticker || '📦';
    this.openModal(
      'Настройки группы', '',
      `<div style="display:flex;flex-direction:column;gap:12px">
        <div class="rb-row">
          <div class="rb-emoji-wrap">
            <input class="rb-emoji-input" id="bs-emoji-inp" maxlength="6" value="${this.esc(current)}"
              oninput="window.app.onEmojiInputChange(this)" inputmode="text">
            <span class="rb-emoji-tag">Тап</span>
          </div>
          <div class="rb-name-wrap">
            <div class="rb-name-label">Название</div>
            <input class="rb-name-inp" id="rename-inp" value="${this.esc(box.name)}" placeholder="Название группы">
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${quick.map(e => `<button class="rb-quick-btn ${current === e ? 'active' : ''}" onclick="window.app.selectSticker('${e}')">${e}</button>`).join('')}
        </div>
      </div>`,
      `<button class="btn btn-danger" style="margin-right:auto" onclick="window.app.deleteBox('${id}','${this.esc(box.name)}')">Удалить</button>
       <button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doRenameBox('${id}')">Сохранить</button>`
    );
    setTimeout(() => {
      const inp = document.getElementById('rename-inp') as HTMLInputElement;
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  }

  /** Переключение вкладок в модале настроек */
  bsSwitchTab(boxId: string, tab: 'main' | 'marketplaces' | 'columns' | 'products' | 'data'): void {
    this._bsActiveTab = tab;
    this.openBoxSettings(boxId);
  }

  /** Фильтр товаров по поиску на вкладке «Товары» */
  filterBsProducts(query: string): void {
    const q = query.toLowerCase().trim();
    document.querySelectorAll<HTMLElement>('#bs-products-list > div').forEach(row => {
      const txt = row.textContent?.toLowerCase() || '';
      row.style.display = !q || txt.includes(q) ? '' : 'none';
    });
  }

  /** Сбросить пользовательский порядок столбцов */
  resetColumnOrder(boxId: string): void {
    this.columnOrder.delete(boxId);
    try {
      const co: Record<string, string[]> = {};
      for (const [bid, cls] of this.columnOrder) co[bid] = cls;
      localStorage.setItem('app_column_order', JSON.stringify(co));
    } catch {}
    this.toast('Порядок столбцов сброшен', 'success');
    this.buildColumns();
    this.openBoxSettings(boxId);
  }

  /** @deprecated */
 bsSelectSticker(emoji: string) {
    const display = document.getElementById('bs-sticker-display');
    if (display) display.textContent = emoji;
    const inp = document.getElementById('bs-emoji-inp') as HTMLInputElement;
    if (inp && inp.value !== emoji) inp.value = emoji;
    document.querySelectorAll('#bs-quick .rb-quick-btn').forEach(b => {
      (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.emoji === emoji);
    });
  }

  // Сохранить настройки группы (название + стикер + столбцы)
  async saveBoxSettings(id: string) {
    const nameInp = document.getElementById('bs-name-inp') as HTMLInputElement;
    const name = nameInp?.value?.trim();
    if (!name) { this.toast('Введите название', 'error'); return; }
    const sticker = document.getElementById('bs-sticker-display')?.textContent?.trim() || '📦';

    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Сохраняю…'; }

    try {
      const prefStoreInp = document.getElementById('bs-pref-store') as HTMLSelectElement;
      const ozon_preferred_store_id = prefStoreInp?.value || null;
      let showedWarning = false;
      
      try {
        await apiService.updateBox(id, { name, sticker, ozon_preferred_store_id });
        boxActions.updateBox(id, { name, sticker, ozon_preferred_store_id });
      } catch (err: any) {
        // Если ошибка 400 (вероятно, не добавлена колонка в БД), пробуем обновить без нее
        if (err.message?.includes('400') || err.message?.includes('column "ozon_preferred_store_id" does not exist')) {
           console.warn('Column ozon_preferred_store_id missing in DB, skipping field update');
           await apiService.updateBox(id, { name, sticker });
           boxActions.updateBox(id, { name, sticker });
           this.toast('Настройки сохранены (без выбора магазина — нужно добавить колонку в БД)', 'warning');
           showedWarning = true;
        } else {
           throw err;
        }
      }

      // Применяем настройки столбцов
      this.applyColPicker();
      this.renderBoxes();
      this.closeModal();
      if (!showedWarning) {
        this.toast('Настройки сохранены', 'success');
      }
    } catch (e: any) {
      this.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    }
  }

  // Связать группу со всеми магазинами Ozon
  async linkBoxToOzon(boxId: string) {
    const skuField = (document.getElementById('bs-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const btn = document.querySelector<HTMLButtonElement>('#modal-body .btn-primary, #sh-ozon-link-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Связываю…'; }
    try {
      const prefStoreId = (document.getElementById('bs-pref-store') as HTMLSelectElement)?.value || null;
      await apiService.linkBoxToOzon(boxId, 'all', skuField, prefStoreId);
      boxActions.updateBox(boxId, { ozon_store_id: 'all', ozon_sku_field: skuField, ozon_preferred_store_id: prefStoreId });
      this.toast('Группа привязана ко всем магазинам Ozon ✓', 'success');
      this.closeModal();
      this.renderBoxes();
      (window as any).settingsHub?.init?.();
      setTimeout(() => this.syncLinkedBox(boxId), 300);
    } catch (e: any) {
      this.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Связать'; }
    }
  }

  // Отвязать группу от Ozon
  async unlinkBoxFromOzon(boxId: string) {
    try {
      await apiService.linkBoxToOzon(boxId, null);
      boxActions.updateBox(boxId, { ozon_store_id: null, ozon_sku_field: null });
      this.toast('Группа отвязана от Ozon', 'success');
      this.closeModal();
      this.renderBoxes();
      (window as any).settingsHub?.init?.();
    } catch (e: any) {
      this.toast('Ошибка: ' + e.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINK/SYNC: Яндекс Маркет
  // ─────────────────────────────────────────────────────────────────────────

  async linkBoxToYM(boxId: string) {
    const skuField = (document.getElementById('bs-ym-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const updates = { ym_linked: true, ym_sku_field: skuField };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.toast('Группа привязана к Яндекс Маркет', 'success');
    this.closeModal();
    this.renderBoxes();
    (window as any).settingsHub?.init?.();
    setTimeout(() => this.syncLinkedBoxYM(boxId), 300);
  }

  async unlinkBoxFromYM(boxId: string) {
    const updates = { ym_linked: false, ym_sku_field: null };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.toast('Группа отвязана от Яндекс Маркет', 'success');
    this.closeModal();
    this.renderBoxes();
    (window as any).settingsHub?.init?.();
  }

  async syncLinkedBoxYM(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.ym_linked) { this.toast('Группа не привязана к Яндекс Маркет', 'error'); return; }
    this.closeModal();
    this.toast('Синхронизация с Я.Маркет…', 'info', 2000);
    try {
      const { yandexDb } = await import('./services/yandexDb');
      const ymProducts = await yandexDb.getProducts();
      if (ymProducts.length === 0) {
        this.toast('Нет товаров ЯМ. Сначала выполните синхронизацию в разделе Яндекс Маркет.', 'error', 5000);
        return;
      }
      // Индекс по offer_id
      const ymByOfferId = new Map<string, typeof ymProducts[0][]>();
      for (const p of ymProducts) {
        const key = p.offer_id.toLowerCase().trim();
        if (!ymByOfferId.has(key)) ymByOfferId.set(key, []);
        ymByOfferId.get(key)!.push(p);
      }
      const ymStores: Array<{ id: string; name: string }> = (window as any).yandexModule?.stores || [];
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.ym_sku_field || 'Артикул*';

      type SyncStatus = 'matched' | 'not_found' | 'no_sku' | 'skipped';
      interface SyncResult { sku: string; name: string; status: SyncStatus; updatedFields: string[]; storeNames: string[] }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        // Проверяем флаг "синхронизация отключена"
        if (prod.data?.['_ym_sync_disabled']) {
          results.push({ sku: String(prod.data?.[skuField] || '—'), name: String(prod.data?.['Название товара'] || ''), status: 'skipped', updatedFields: [], storeNames: [] });
          continue;
        }
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);
        if (!sku) { results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], storeNames: [] }); continue; }

        const ymGroup = ymByOfferId.get(sku.toLowerCase());
        if (!ymGroup || ymGroup.length === 0) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], storeNames: [] });
          continue;
        }

        // Берём первый (или из предпочтительного магазина)
        const src = ymGroup[0];
        const storeNames = [...new Set(ymGroup.map(p => ymStores.find(s => s.id === p.store_id)?.name || p.store_id))];
        const updatedData: Record<string, any> = { ...prod.data };
        const changed: string[] = [];

        const maybeSet = (field: string, val: any) => {
          if (val != null && val !== '' && String(val) !== String(prod.data?.[field] ?? '')) {
            updatedData[field] = val;
            changed.push(field);
          }
        };
        maybeSet('Название товара', src.name);
        if (src.basic_price && src.basic_price > 0) maybeSet('Цена, руб.*', src.basic_price);
        if (src.stock_total != null) maybeSet('Остаток', src.stock_total);
        if (src.vendor) maybeSet('Бренд*', src.vendor);
        if (src.vendor_code) maybeSet('Артикул производителя', src.vendor_code);
        updatedData['_ym_synced_at'] = new Date().toISOString();

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changed, storeNames });
      }

      this.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      if (this.activeBoxId === boxId) await this.loadBoxProducts();
      this.showMpSyncReport(results, box.name || boxId, 'Яндекс Маркет', '#fc3f1d');
    } catch (e: any) {
      this.toast('Ошибка синхронизации ЯМ: ' + e.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINK/SYNC: Wildberries
  // ─────────────────────────────────────────────────────────────────────────

  async linkBoxToWB(boxId: string) {
    const skuField = (document.getElementById('bs-wb-sku-field') as HTMLSelectElement)?.value || 'Артикул*';
    const updates = { wb_linked: true, wb_sku_field: skuField };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.toast('Группа привязана к Wildberries', 'success');
    this.closeModal();
    this.renderBoxes();
    (window as any).settingsHub?.init?.();
    setTimeout(() => this.syncLinkedBoxWB(boxId), 300);
  }

  async unlinkBoxFromWB(boxId: string) {
    const updates = { wb_linked: false, wb_sku_field: null };
    boxActions.updateBox(boxId, updates);
    this.saveBoxMeta(boxId, updates);
    this.toast('Группа отвязана от Wildberries', 'success');
    this.closeModal();
    this.renderBoxes();
    (window as any).settingsHub?.init?.();
  }

  async syncLinkedBoxWB(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.wb_linked) { this.toast('Группа не привязана к Wildberries', 'error'); return; }
    this.closeModal();
    this.toast('Синхронизация с WB…', 'info', 2000);
    try {
      const { wbDb } = await import('./services/wbDb');
      const wbProducts = await wbDb.getProducts();
      if (wbProducts.length === 0) {
        this.toast('Нет товаров WB. Сначала выполните синхронизацию в разделе Wildberries.', 'error', 5000);
        return;
      }
      // Индекс по vendor_code
      const wbByCode = new Map<string, typeof wbProducts[0][]>();
      for (const p of wbProducts) {
        const key = (p.vendor_code || '').toLowerCase().trim();
        if (!key) continue;
        if (!wbByCode.has(key)) wbByCode.set(key, []);
        wbByCode.get(key)!.push(p);
      }
      const wbStores: Array<{ id: string; name: string }> = (window as any).wbModule?.stores || [];
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.wb_sku_field || 'Артикул*';

      type SyncStatus = 'matched' | 'not_found' | 'no_sku' | 'skipped';
      interface SyncResult { sku: string; name: string; status: SyncStatus; updatedFields: string[]; storeNames: string[] }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        if (prod.data?.['_wb_sync_disabled']) {
          results.push({ sku: String(prod.data?.[skuField] || '—'), name: String(prod.data?.['Название товара'] || ''), status: 'skipped', updatedFields: [], storeNames: [] });
          continue;
        }
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);
        if (!sku) { results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], storeNames: [] }); continue; }

        const wbGroup = wbByCode.get(sku.toLowerCase());
        if (!wbGroup || wbGroup.length === 0) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], storeNames: [] });
          continue;
        }

        const src = wbGroup[0];
        const storeNames = [...new Set(wbGroup.map(p => wbStores.find(s => s.id === p.store_id)?.name || p.store_id))];
        const updatedData: Record<string, any> = { ...prod.data };
        const changed: string[] = [];

        const maybeSet = (field: string, val: any) => {
          if (val != null && val !== '' && String(val) !== String(prod.data?.[field] ?? '')) {
            updatedData[field] = val;
            changed.push(field);
          }
        };
        maybeSet('Название товара', src.title);
        if (src.price && src.price > 0) maybeSet('Цена, руб.*', src.price);
        if (src.stock_total != null) maybeSet('Остаток', src.stock_total);
        if (src.brand) maybeSet('Бренд*', src.brand);
        if (src.subject) maybeSet('Категория', src.subject);
        updatedData['_wb_synced_at'] = new Date().toISOString();
        updatedData['_wb_nm_id'] = src.nm_id;

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changed, storeNames });
      }

      this.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      if (this.activeBoxId === boxId) await this.loadBoxProducts();
      this.showMpSyncReport(results, box.name || boxId, 'Wildberries', '#cb11ab');
    } catch (e: any) {
      this.toast('Ошибка синхронизации WB: ' + e.message, 'error');
    }
  }

  /** Сохранить метаданные группы (ym_linked, wb_linked и т.д.) в Supabase.
   *  Если колонки ещё не добавлены в БД — сохраняем в localStorage как fallback. */
  private saveBoxMeta(boxId: string, updates: Partial<import('./types/index').Box>) {
    apiService.updateBox(boxId, updates).catch(_e => {
      // Fallback: сохраняем ym/wb линковку в localStorage до применения миграции
      const LS_KEY = 'box_meta_fallback';
      try {
        const store: Record<string, any> = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        store[boxId] = { ...(store[boxId] || {}), ...updates };
        localStorage.setItem(LS_KEY, JSON.stringify(store));
      } catch {}
    });
    // Применяем к локальному стору немедленно
    boxActions.updateBox(boxId, updates as any);
  }

  /** Получить YM/WB метаданные из localStorage (fallback до применения миграции). */
  getBoxMetaFallback(boxId: string): Partial<import('./types/index').Box> {
    try {
      const store = JSON.parse(localStorage.getItem('box_meta_fallback') || '{}');
      return store[boxId] || {};
    } catch { return {}; }
  }

  /** Переключить флаг «синхронизация ЯМ/WB отключена» для конкретного товара. */
  async toggleSyncDisabled(prodId: string, mp: 'ym' | 'wb') {
    const prod = this.allProducts.find(p => p.id === prodId);
    if (!prod) return;
    const flag = `_${mp}_sync_disabled`;
    const current = !!prod.data?.[flag];
    const updatedData = { ...prod.data, [flag]: !current };
    await apiService.updateProduct(prodId, { data: updatedData });
    prod.data = updatedData;
    this.applyFilters(); // перерисовать
    this.toast(`Синхронизация ${mp === 'ym' ? 'ЯМ' : 'WB'} для товара ${!current ? 'отключена' : 'включена'}`, 'info', 1500);
  }

  /** Унифицированный отчёт синхронизации для ЯМ/WB. */
  private showMpSyncReport(
    results: Array<{ sku: string; name: string; status: 'matched' | 'not_found' | 'no_sku' | 'skipped'; updatedFields: string[]; storeNames: string[] }>,
    boxName: string,
    mpName: string,
    mpColor: string,
  ) {
    const matched   = results.filter(r => r.status === 'matched');
    const notFound  = results.filter(r => r.status === 'not_found');
    const noSku     = results.filter(r => r.status === 'no_sku');
    const skipped   = results.filter(r => r.status === 'skipped');
    const changed   = matched.filter(r => r.updatedFields.length > 0);
    const unchanged = matched.filter(r => r.updatedFields.length === 0);

    // Подсчёт по магазинам
    const storeCountMap = new Map<string, number>();
    for (const r of matched) {
      for (const s of r.storeNames) storeCountMap.set(s, (storeCountMap.get(s) || 0) + 1);
    }

    const statsHtml = `
      <div style="display:grid;grid-template-columns:repeat(${skipped.length > 0 ? 5 : 4},1fr);gap:10px;margin-bottom:20px">
        <div style="background:var(--green-dim);border:1px solid rgba(68,221,136,0.25);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${matched.length}</div>
          <div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Найдено</div>
        </div>
        <div style="background:color-mix(in srgb,${mpColor} 10%,transparent);border:1px solid color-mix(in srgb,${mpColor} 25%,transparent);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${mpColor}">${changed.length}</div>
          <div style="font-size:10px;color:${mpColor};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Обновлено</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text2)">${unchanged.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Без изменений</div>
        </div>
        <div style="background:${notFound.length > 0 ? 'var(--red-dim)' : 'var(--bg3)'};border:1px solid ${notFound.length > 0 ? 'rgba(255,68,68,0.25)' : 'var(--border)'};border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'}">${notFound.length}</div>
          <div style="font-size:10px;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Не найдено</div>
        </div>
        ${skipped.length > 0 ? `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text3)">${skipped.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Пропущено</div>
        </div>` : ''}
      </div>
      ${noSku.length > 0 ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">+ ${noSku.length} строк без артикула</div>` : ''}
      ${storeCountMap.size > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">По магазинам</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${[...storeCountMap.entries()].map(([s, c]) => `
              <span style="padding:4px 10px;background:color-mix(in srgb,${mpColor} 10%,transparent);border:1px solid color-mix(in srgb,${mpColor} 25%,transparent);border-radius:20px;font-size:11px;color:${mpColor}">
                ${this.esc(s)} <strong>${c}</strong>
              </span>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;

    const tableRows = results.map(r => {
      const statusIcon = r.status === 'matched'
        ? (r.updatedFields.length > 0
          ? `<span style="color:var(--accent);font-size:11px;white-space:nowrap">✓ обновлён</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">= без изм.</span>`)
        : r.status === 'not_found'
          ? `<span style="color:var(--red);font-size:11px;white-space:nowrap">✕ не найден</span>`
          : r.status === 'skipped'
            ? `<span style="color:var(--text3);font-size:11px;white-space:nowrap">⏸ пропущен</span>`
            : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">— нет арт.</span>`;
      const borderStyle = r.status === 'matched' && r.updatedFields.length > 0
        ? `border-left:2px solid var(--accent);`
        : r.status === 'not_found' ? `border-left:2px solid var(--red);opacity:.65;` : '';
      return `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);${borderStyle}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div>
              <code style="font-size:11px;color:var(--text3);background:var(--bg3);padding:1px 6px;border-radius:4px">${this.esc(r.sku)}</code>
              <span style="font-size:12px;color:var(--text);margin-left:8px">${this.esc(r.name.slice(0,60))}</span>
              ${r.updatedFields.length > 0 ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${r.updatedFields.map(f => `<span style="padding:1px 5px;background:color-mix(in srgb,${mpColor} 8%,transparent);border-radius:3px;color:${mpColor}">${this.esc(f.replace('*',''))}</span>`).join(' ')}</div>` : ''}
            </div>
            <div style="flex-shrink:0">${statusIcon}</div>
          </div>
        </div>`;
    }).join('');

    this.openModalLg(
      `Синхронизация ${mpName} — ${this.esc(boxName)}`,
      `${matched.length} из ${results.length} строк найдено`,
      `${statsHtml}<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:360px;overflow-y:auto">${tableRows || '<div style="padding:16px;text-align:center;color:var(--text3)">Нет данных</div>'}</div>`,
      `<button class="btn btn-primary" onclick="window.app.closeModal()">Готово</button>`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYNC: Группа ↔ весь пункт Ozon (все магазины, по артикулу)
  // ─────────────────────────────────────────────────────────────────────────

  async syncLinkedBox(boxId: string) {
    const box = boxes.get().find(b => b.id === boxId);
    if (!box?.ozon_store_id) { this.toast('Группа не привязана к Ozon', 'error'); return; }

    const ozonModule = (window as any).ozonModule;
    if (!ozonModule?.products?.length) {
      this.toast('Нет данных Ozon. Сначала синхронизируйте магазины в разделе Ozon.', 'error');
      return;
    }

    try {
      // ── Все товары Ozon сгруппированные по offer_id (все магазины) ─────────
      const ozonGroups: Map<string, any> = ozonModule.groups || new Map();
      const ozonByOfferId = new Map<string, any>();

      if (ozonGroups.size > 0) {
        for (const [offerId, group] of ozonGroups) {
          ozonByOfferId.set(offerId.trim().toLowerCase(), group);
        }
      } else {
        // Fallback: группируем products вручную
        for (const p of ozonModule.products) {
          const key = (p.offer_id || '').trim().toLowerCase();
          if (!ozonByOfferId.has(key)) {
            ozonByOfferId.set(key, {
              offer_id: p.offer_id,
              name: p.name,
              images: p.images || [],
              category: p.category || '',
              stores: new Map(),
            });
          }
          ozonByOfferId.get(key).stores.set(p.store_id, p);
        }
      }

      // ── Загружаем товары группы ────────────────────────────────────────────
      const groupProducts = await apiService.getProductsByBox(boxId);
      const skuField = box.ozon_sku_field || 'Артикул*';
      const { applyOzonData, buildColumnMap } = await import('./utils/columnMapper');

      // Маппинг столбцов один раз для всей группы
      const sampleCols = groupProducts[0] ? Object.keys(groupProducts[0].data || {}) : [];
      const colMap = buildColumnMap(sampleCols);

      // ── Результаты ────────────────────────────────────────────────────────
      type SyncStatus = 'matched' | 'not_found' | 'no_sku';
      interface SyncResult {
        sku: string; name: string; status: SyncStatus;
        updatedFields: string[]; ozonStores: string[];
        oldValues: Record<string, string>; newValues: Record<string, string>;
      }
      const results: SyncResult[] = [];

      for (const prod of groupProducts) {
        const sku = String(prod.data?.[skuField] || '').trim();
        const prodName = String(prod.data?.['Название товара'] || sku);

        if (!sku) {
          results.push({ sku: '—', name: prodName, status: 'no_sku', updatedFields: [], ozonStores: [], oldValues: {}, newValues: {} });
          continue;
        }

        const ozonGroup = ozonByOfferId.get(sku.toLowerCase());
        if (!ozonGroup) {
          results.push({ sku, name: prodName, status: 'not_found', updatedFields: [], ozonStores: [], oldValues: {}, newValues: {} });
          continue;
        }

        const storesMap: Map<string, any> = ozonGroup.stores || new Map();
        const allProducts = [...storesMap.values()];
        const storeNames = [...storesMap.keys()].map(sid =>
          ozonModule.stores?.find((s: any) => s.id === sid)?.name || sid
        );

        // Подбираем данные из предпочтительного магазина, если он задан и товар там есть
        let targetProduct = box.ozon_preferred_store_id ? storesMap.get(box.ozon_preferred_store_id) : null;
        
        // Если в предпочтительном нет товара или в нем цена 0 — пытаемся найти другой магазин с ценой > 0
        if (!targetProduct || !targetProduct.price) {
          const productWithPrice = allProducts.find(p => (p.price || 0) > 0);
          if (productWithPrice) {
            targetProduct = productWithPrice;
          } else if (!targetProduct) {
            // Если совсем ничего не нашли с ценой, но есть хоть какой-то — берем первый
            targetProduct = allProducts[0];
          }
        }

        const ozonFlat: Record<string, string | number> = {
          name:      ozonGroup.name || targetProduct?.name || '',
          barcode:   targetProduct?.barcode   || '',
          category:  ozonGroup.category   || targetProduct?.category || '',
          status:    targetProduct?.status    || '',
          stock_fbs: [...storesMap.values()].reduce((s, p) => s + (p.stock_fbs || 0), 0),
          stock_fbo: [...storesMap.values()].reduce((s, p) => s + (p.stock_fbo || 0), 0),
        };

        // Если цена есть и она > 0 — добавляем в плоский объект для обновления
        if (targetProduct && (targetProduct.price || 0) > 0) {
          ozonFlat.price = targetProduct.price;
          ozonFlat.old_price = targetProduct.old_price || 0;
          ozonFlat.min_price = targetProduct.min_price || 0;
        }

        // Запоминаем старые значения
        const oldValues: Record<string, string> = {};
        const newValues: Record<string, string> = {};
        for (const [ozonField, localCol] of colMap) {
          if (localCol && ozonFlat[ozonField] !== undefined) {
            oldValues[localCol] = String(prod.data?.[localCol] ?? '');
            newValues[localCol] = String(ozonFlat[ozonField]);
          }
        }

        const { data: updatedData, mappedFields } = applyOzonData(prod.data || {}, ozonFlat, skuField);
        updatedData['_ozon_synced_at'] = new Date().toISOString();
        updatedData['_ozon_store_id']  = box.ozon_store_id!;

        // Запоминаем какие конкретно колонки привязались, чтобы подсветить их в UI
        const mappedLocalCols = mappedFields.map(mf => mf.split(' → ')[1]).filter(Boolean);
        updatedData['_ozon_mapped_cols'] = JSON.stringify(mappedLocalCols);

        const changedFields = mappedFields
          .filter(mf => {
            const localCol = mf.split(' → ')[1];
            return localCol && oldValues[localCol] !== newValues[localCol];
          })
          .map(mf => mf.split(' → ')[1])
          .filter(Boolean);

        await apiService.updateProduct(prod.id, { data: updatedData });
        results.push({ sku, name: prodName, status: 'matched', updatedFields: changedFields, ozonStores: storeNames, oldValues, newValues });
      }

      this.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      if (this.activeBoxId === boxId) await this.loadBoxProducts();

      this.showSyncReport(results, colMap, box.name || boxId);

    } catch (e: any) {
      this.toast('Ошибка синхронизации: ' + e.message, 'error');
    }
  }

  // ── Детальный отчёт синхронизации ─────────────────────────────────────────

  private showSyncReport(
    results: Array<{
      sku: string; name: string;
      status: 'matched' | 'not_found' | 'no_sku';
      updatedFields: string[]; ozonStores: string[];
      oldValues: Record<string, string>; newValues: Record<string, string>;
    }>,
    colMap: Map<string, string>,
    boxName: string,
  ) {
    const matched   = results.filter(r => r.status === 'matched');
    const notFound  = results.filter(r => r.status === 'not_found');
    const noSku     = results.filter(r => r.status === 'no_sku');
    const changed   = matched.filter(r => r.updatedFields.length > 0);
    const unchanged = matched.filter(r => r.updatedFields.length === 0);

    const fieldCounts = new Map<string, number>();
    for (const r of changed) {
      for (const f of r.updatedFields) {
        fieldCounts.set(f, (fieldCounts.get(f) || 0) + 1);
      }
    }

    const statsHtml = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
        <div style="background:var(--green-dim);border:1px solid rgba(68,221,136,0.25);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${matched.length}</div>
          <div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Найдено</div>
        </div>
        <div style="background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--accent)">${changed.length}</div>
          <div style="font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Обновлено</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--text2)">${unchanged.length}</div>
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Без изменений</div>
        </div>
        <div style="background:${notFound.length > 0 ? 'var(--red-dim)' : 'var(--bg3)'};border:1px solid ${notFound.length > 0 ? 'rgba(255,68,68,0.25)' : 'var(--border)'};border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'}">${notFound.length}</div>
          <div style="font-size:10px;color:${notFound.length > 0 ? 'var(--red)' : 'var(--text3)'};text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Не найдено</div>
        </div>
      </div>
      ${noSku.length > 0 ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">+ ${noSku.length} строк без артикула (пропущены)</div>` : ''}
    `;

    const fieldsHtml = fieldCounts.size > 0 ? `
      <div style="margin-bottom:16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">Обновлённые поля</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${[...fieldCounts.entries()].sort((a,b) => b[1]-a[1]).map(([field, count]) => `
            <span style="padding:4px 10px;background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:20px;font-size:11px;color:var(--accent)">
              ${this.esc(field.replace('*',''))} <strong>${count}</strong>
            </span>
          `).join('')}
        </div>
      </div>
    ` : '';

    const tableRows = results.map(r => {
      const statusIcon = r.status === 'matched'
        ? (r.updatedFields.length > 0
          ? `<span style="color:var(--accent);font-size:11px;font-weight:600;white-space:nowrap">✓ обновлён</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">= без изменений</span>`)
        : r.status === 'not_found'
          ? `<span style="color:var(--red);font-size:11px;white-space:nowrap">✕ нет в Ozon</span>`
          : `<span style="color:var(--text3);font-size:11px;white-space:nowrap">— нет артикула</span>`;

      const changesHtml = r.updatedFields.length > 0
        ? r.updatedFields.map(f => {
            const oldV = String(r.oldValues[f] || '—').slice(0, 25);
            const newV = String(r.newValues[f] || '—').slice(0, 25);
            return `<div style="font-size:10px;color:var(--text2);margin-top:2px">
              <span style="color:var(--text3)">${this.esc(f.replace('*',''))}: </span>
              <span style="text-decoration:line-through;color:var(--text3)">${this.esc(oldV)}</span>
              <span style="color:var(--accent);margin-left:4px">→ ${this.esc(newV)}</span>
            </div>`;
          }).join('')
        : '';

      const storesHtml = r.ozonStores.length > 0
        ? `<div style="margin-top:3px">${r.ozonStores.map(s =>
            `<span style="padding:1px 6px;background:color-mix(in srgb,#005bff 10%,transparent);border-radius:3px;color:#005bff;font-size:10px;margin-right:3px">${this.esc(s)}</span>`
          ).join('')}</div>`
        : '';

      const borderStyle = r.status === 'matched' && r.updatedFields.length > 0
        ? 'border-left:2px solid var(--accent);'
        : r.status === 'not_found'
          ? 'border-left:2px solid var(--red);opacity:.65;'
          : '';

      return `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border);${borderStyle}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <code style="font-size:11px;color:var(--text3);flex-shrink:0;background:var(--bg3);padding:1px 6px;border-radius:4px">${this.esc(r.sku)}</code>
                <span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">${this.esc(r.name.slice(0,60))}</span>
              </div>
              ${storesHtml}
              ${changesHtml}
            </div>
            <div style="flex-shrink:0;padding-top:1px">${statusIcon}</div>
          </div>
        </div>
      `;
    }).join('');

    const mappingRows = [...colMap.entries()]
      .filter(([, local]) => local)
      .map(([ozon, local]) => `
        <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px">
          <code style="color:#005bff;background:color-mix(in srgb,#005bff 8%,transparent);padding:2px 6px;border-radius:4px;flex-shrink:0">${this.esc(ozon)}</code>
          <span style="color:var(--text3)">→</span>
          <span style="color:var(--text2)">${this.esc(local.replace('*',''))}</span>
        </div>
      `).join('');

    const body = `
      ${statsHtml}
      ${fieldsHtml}
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px">
        Результат по строкам (${results.length} строк в группе)
      </div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:340px;overflow-y:auto;margin-bottom:16px">
        ${tableRows || '<div style="padding:16px;text-align:center;color:var(--text3)">Нет данных</div>'}
      </div>
      ${colMap.size > 0 ? `
        <details>
          <summary style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);cursor:pointer;user-select:none;margin-bottom:4px">
            Маппинг столбцов (${colMap.size} полей)
          </summary>
          <div style="margin-top:8px;padding:10px 12px;background:var(--bg3);border-radius:8px">${mappingRows}</div>
        </details>
      ` : ''}
    `;

    this.openModalLg(
      `Синхронизация — ${this.esc(boxName)}`,
      `${matched.length} из ${results.length} строк найдено в Ozon`,
      body,
      `<button class="btn btn-primary" onclick="window.app.closeModal()">Готово</button>`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — EDIT (columns + products)
  // ─────────────────────────────────────────────────────────────────────────

  /** Legacy alias: старый editBox теперь открывает единое окно настроек */
  editBox(id: string) { this.openBoxSettings(id); }

  deleteBoxRow(boxId: string, col: string) {
    this.pendingDelete = { boxId, col };
    this.openModal('Удалить столбец?', `«${this.esc(col.replace('*', ''))}»`,
      `<p style="font-size:13px;color:var(--text2);line-height:1.6">Столбец будет удалён у всех товаров.<br>Это нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.openBoxSettings('${boxId}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteBoxRow()">Удалить</button>`
    );
  }

  async doDeleteBoxRow() {
    const { boxId, col } = this.pendingDelete || {};
    if (!boxId || !col) return;
    this.pendingDelete = null;
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      const prods = await apiService.getProductsByBox(boxId);
      for (const p of (prods || [])) {
        const data = p.data || {};
        if (data[col] !== undefined) {
          delete data[col];
          await apiService.updateProduct(p.id, { data });
        }
      }
      this.toast('Столбец удалён', 'success');
      this.closeModal();
      if (this.activeBoxId === boxId) {
        await this.loadBoxProducts();
        const order = this.columnOrder.get(boxId);
        if (order) {
          this.columnOrder.set(boxId, order.filter(c => c !== col));
          const co: Record<string, string[]> = {};
          for (const [bid, cl] of this.columnOrder) co[bid] = cl;
          localStorage.setItem('app_column_order', JSON.stringify(co));
        }
        this.openBoxSettings(boxId);
      }
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  deleteProductFromBox(boxId: string, prodId: string, art: string) {
    this.pendingDelete = { boxId, prodId, art };
    this.openModal('Удалить товар?', `Артикул: ${this.esc(art)}`,
      `<p style="font-size:13px;color:var(--text2)">Это действие нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.openBoxSettings('${boxId}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteProductFromBox()">Удалить</button>`
    );
  }

async doDeleteProductFromBox() {
    const { boxId, prodId } = this.pendingDelete || {};
    if (!boxId || !prodId) return;
    this.pendingDelete = null;
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      await apiService.deleteProduct(prodId);
      this.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      this.toast('Товар удалён', 'success');
      this.closeModal();
      if (this.activeBoxId === boxId) await this.loadBoxProducts();
      this.loadBoxCount(boxId);
      // Открываем настройки заново, чтобы пользователь видел обновлённый список
      this.openBoxSettings(boxId);
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BOX MODALS — DELETE
  // ─────────────────────────────────────────────────────────────────────────

  deleteBox(id: string, name: string) {
    this.openModal('Удалить группу?', `«${name}»`,
      `<div style="background:var(--red-dim);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:14px 16px;margin-bottom:4px">
        <div style="font-size:13px;color:var(--red);font-weight:500;margin-bottom:6px">⚠ Внимание — это нельзя отменить</div>
        <div style="font-size:12.5px;color:var(--text2);line-height:1.6">Будут удалены все товары и листы внутри группы «${this.esc(name)}».</div>
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.doDeleteBox('${id}')">Удалить группу</button>`
    );
  }

  async doDeleteBox(id: string) {
    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-danger');
    if (btn) { btn.disabled = true; btn.textContent = 'Удаляю...'; }
    try {
      await apiService.deleteProductsByBox(id);
      const sheets = await apiService.getSheetsByBox(id);
      for (const s of (sheets || [])) await apiService.deleteSheet(s.id);
      await apiService.deleteBox(id);
      this.cache.delete(id);
      idbCache.remove(id).catch(() => {});
      boxActions.removeBox(id);
      if (this.activeBoxId === id) {
        this.activeBoxId = null;
        localStorage.removeItem('last_box_id');
        this.selectedProducts.clear();
        this.renderActionBar();
        this.renderProducts();
        this.allProducts = [];
        this.filtered = [];
        const addBtn = document.getElementById('add-product-btn');
        if (addBtn) addBtn.style.display = 'none';
        this.navigateTo('home');
      }
      this.renderBoxes();
      this.closeModal();
      this.toast('Группа удалена', 'success');
    } catch (e: any) { this.toast('Ошибка: ' + e.message, 'error'); }
  }

  private async ensureExcelJS(): Promise<any> {
    if ((window as any).ExcelJS) return (window as any).ExcelJS;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload = () => resolve((window as any).ExcelJS);
      s.onerror = () => reject(new Error('Не удалось загрузить библиотеку ExcelJS из CDN'));
      document.head.appendChild(s);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────────────────────────────────

  openExportModal(onlySelected = false) {
    if (!this.activeBoxId) { this.toast('Сначала выберите группу', 'error'); return; }
    const box = boxes.get().find(b => b.id === this.activeBoxId);
    let prods = this.filtered.length ? this.filtered : this.allProducts;
    if (onlySelected && this.selectedProducts.size > 0) {
      prods = prods.filter(p => this.selectedProducts.has(p.id));
    }
    if (!prods.length) { this.toast('Нет товаров для экспорта', 'error'); return; }
    if (!prods.length) { this.toast('Нет товаров для экспорта', 'error'); return; }
    const allCols = this.columns;

    this.openModalLg(`Экспорт — ${this.esc(box?.name || '')}`, `${prods.length} товаров доступно`,
      `<div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(false)">Снять</button>
        </div>
      </div>
      <div id="export-col-sel" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:160px;overflow-y:auto;padding-right:4px">
        ${allCols.map(c => `
          <div class="chk on" data-ecol="${this.esc(c)}" onclick="this.classList.toggle('on');window.app.updateExportCount()">
            <div class="chk-box"><div class="chk-tick"></div></div>
            <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(c)}">${this.esc(c.replace('*', ''))}</span>
          </div>
        `).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для экспорта</div>
        <div style="display:flex;gap:6px">
          ${onlySelected ? '' : `<button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(false)">Снять</button>`}
        </div>
      </div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Цена</th>
          </tr></thead>
          <tbody id="export-row-body">
            ${prods.map(p => {
              const d = p.data || {};
              return `<tr class="exp-row on" data-prod-id="${p.id}" onclick="this.classList.toggle('on');window.app.updateExportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${this.esc(d['Артикул*'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(d['Название товара'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--accent);white-space:nowrap">${d['Цена, руб.*'] ? Number(d['Цена, руб.*']).toLocaleString('ru') + ' ₽' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="export-count-lbl"></div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" style="background:#005bff;border-color:#005bff" onclick="window.app.doExportOriginalOzon()">↓ В шаблоне Ozon</button>
       <button class="btn btn-primary" onclick="window.app.doExport()">↓ Обычный xlsx</button>`
    );

    setTimeout(() => {
      const tbody = document.getElementById('export-row-body');
      if (tbody) {
        tbody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
        tbody.addEventListener('mouseout', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
      }
      this.updateExportCount();
    }, 50);
  }

  updateExportCount() {
    const selCols = document.querySelectorAll('#export-col-sel .chk.on').length;
    const selRows = document.querySelectorAll('#export-row-body .exp-row.on').length;
    const lbl = document.getElementById('export-count-lbl');
    if (lbl) lbl.textContent = `Будет экспортировано: ${selRows} позиций × ${selCols} столбцов`;
    document.querySelectorAll<HTMLElement>('#export-row-body .exp-row').forEach(tr => {
      const box = tr.querySelector<HTMLElement>('.chk-box');
      const tick = tr.querySelector<HTMLElement>('.chk-tick');
      if (box && tick) {
        if (tr.classList.contains('on')) { box.style.background = 'var(--accent)'; box.style.borderColor = 'var(--accent)'; tick.style.display = 'block'; }
        else { box.style.background = 'var(--bg3)'; box.style.borderColor = ''; tick.style.display = 'none'; }
      }
    });
  }

  toggleAllExportCols(on: boolean) {
    document.querySelectorAll('#export-col-sel .chk').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateExportCount();
  }

  toggleAllExportRows(on: boolean) {
    document.querySelectorAll('#export-row-body .exp-row').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateExportCount();
  }

  doExport() {
    const selCols = [...document.querySelectorAll<HTMLElement>('#export-col-sel .chk.on')].map(el => el.dataset.ecol!);
    const selIds = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selCols.length || !selIds.size) { this.toast('Выберите столбцы и позиции', 'error'); return; }
    const prods = (this.filtered.length ? this.filtered : this.allProducts).filter(p => selIds.has(p.id));
    const box = boxes.get().find(b => b.id === this.activeBoxId);
    const wsData = [selCols, ...prods.map(p => selCols.map(c => p.data[c] ?? ''))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = selCols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const fname = `${box?.name || 'export'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.toast(`Файл ${fname} скачан`, 'success');
    this.closeModal();
  }

  async doExportOriginalOzon() {
    const selIds = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selIds.size) { this.toast('Выберите позиции для экспорта', 'error'); return; }

    if (!this.activeBoxId) { this.toast('Не выбрана группа', 'error'); return; }
    const box = boxes.get().find(b => b.id === this.activeBoxId);

    try {
      // Ищем импорты для текущей группы, чтобы достать оригинальный шаблон
      const sheets = await apiService.getSheetsByBox(this.activeBoxId);
      // Ищем последний импорт, у которого есть сохраненные template_headers
      const sheetWithHeaders = sheets.reverse().find(s => s.template_headers && s.template_headers.length > 0);

      if (!sheetWithHeaders || !sheetWithHeaders.template_headers) {
        this.toast('Оригинальный шаблон Ozon для этой группы не найден. Импортируйте шаблон заново.', 'error');
        return;
      }

      const prods = (this.filtered.length ? this.filtered : this.allProducts).filter(p => selIds.has(p.id));
      const fname = `${box?.name || 'export'}_ozon_original_${new Date().toISOString().slice(0, 10)}.xlsx`;

      if (sheetWithHeaders.template_file_b64) {
          try {
            this.toast('Подготовка шаблона (ExcelJS)...', 'info');
          
          const ExcelJS = await this.ensureExcelJS();

         // ИСПОЛЬЗУЕМ НАДЕЖНЫЙ СПОСОБ ДЕКОДИРОВАНИЯ
         const b64 = sheetWithHeaders.template_file_b64.replace(/\s/g, '');
         console.log('Decoding Base64 template, length:', b64.length);
         const binaryString = atob(b64);
         const bytes = new Uint8Array(binaryString.length);
         for (let i = 0; i < binaryString.length; i++) {
             bytes[i] = binaryString.charCodeAt(i);
         }
         console.log('Uint8Array created, size:', bytes.length);
         
         const workbook = new ExcelJS.Workbook();
         // Передаем Uint8Array напрямую - это более стабильно в браузерах
         await workbook.xlsx.load(bytes);
         console.log('ExcelJS workbook loaded successfully');
         
         const ws = workbook.getWorksheet('Шаблон') || workbook.worksheets[0];
         if (!ws) throw new Error('Лист "Шаблон" не найден в оригинальном файле');
         
         // Авто-детект строки заголовков в шаблоне
         let headerRowNumber = 2;
         for (let r = 1; r <= 10; r++) {
            const row = ws.getRow(r);
            let found = false;
            row.eachCell({ includeEmpty: true }, (cell: import('exceljs').Cell) => {
               if (String(cell.value || '').includes('Артикул')) found = true;
            });
            if (found) { headerRowNumber = r; break; }
         }
         const headerRow = ws.getRow(headerRowNumber);
         const techRow = ws.getRow(headerRowNumber + 1);
         const columnCount = ws.actualColumnCount || ws.columnCount;
         const columnNames: string[] = [];
         const techKeys: string[] = [];
         for (let i = 1; i <= columnCount; i++) {
             const hVal = headerRow.getCell(i).value;
             const tVal = techRow.getCell(i).value;
             columnNames[i] = hVal ? String(hVal).trim() : '';
             techKeys[i] = tVal ? String(tVal).trim() : '';
         }

         const startDataRow = headerRowNumber + 3;
         
          const templateRow = ws.getRow(startDataRow);
          
           // Очистка старых данных перед записью новых (хирургическая, только значения)
           const maxRows = Math.max(ws.actualRowCount || 0, startDataRow + prods.length + 10);
           for (let r = startDataRow; r <= maxRows; r++) {
              const row = ws.getRow(r);
              row.eachCell({ includeEmpty: true }, (cell: import('exceljs').Cell) => {
                 cell.value = null;
              });
           }
           const originalViews = [...(ws.views || [])];
           const originalAutoFilter = ws.autoFilter;

          prods.forEach((p, idx) => {
             const rowNumber = startDataRow + idx;
             const row = ws.getRow(rowNumber);
             row.height = templateRow.height;
             
             for (let i = 1; i <= columnCount; i++) {
                const colName = columnNames[i];
                const techKey = techKeys[i];
                const val = (colName && p.data[colName] !== undefined) ? p.data[colName] 
                          : (techKey && p.data[techKey] !== undefined) ? p.data[techKey] 
                          : '';
                
                const cell = row.getCell(i);
                const tplCell = templateRow.getCell(i);
                
                cell.value = val;
                cell.style = tplCell.style;
                if (tplCell.dataValidation) {
                   cell.dataValidation = tplCell.dataValidation;
                }
             }
          });

          ws.views = originalViews;
          if (originalAutoFilter) ws.autoFilter = originalAutoFilter;
         
         const outBuffer = await workbook.xlsx.writeBuffer();
         const blob = new Blob([outBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
         const url = URL.createObjectURL(blob);
         const a = document.createElement('a');
         a.href = url;
         a.download = fname;
         a.click();
         URL.revokeObjectURL(url);
         
         this.toast(`Файл ${fname} скачан (с оригинальными стилями)`, 'success');
         this.closeModal();
            return;
         } catch (e: any) {
            console.error('ExcelJS OOM or Error:', e);
            this.toast('ExcelJS не справился, использую стандартный метод...', 'info');
         }
      }
      
      // РЕЗЕРВНЫЙ ВАРИАНТ (Если Base64 недоступен, например для старых импортов)
      const templateHeaders = sheetWithHeaders.template_headers; // any[][]
      const columnNamesRow = templateHeaders.length > 1 ? templateHeaders[1] : templateHeaders[0];
      const columnNames = columnNamesRow.map((c: any) => c ? String(c).trim() : null);
      
      const wsData: any[][] = [...templateHeaders];
      
      for (const p of prods) {
        const rowData = columnNames.map(colName => {
          if (!colName) return '';
          return p.data[colName] ?? '';
        });
        wsData.push(rowData);
      }
      
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = columnNames.map(c => ({ wch: Math.min(Math.max((c || '').length + 2, 12), 40) }));
      XLSX.utils.book_append_sheet(wb, ws, 'Шаблон');
      XLSX.writeFile(wb, fname);
      this.toast(`Файл ${fname} скачан`, 'success');
      this.closeModal();
    } catch (e: any) {
      console.error(e);
      this.toast('Ошибка выгрузки: ' + String(e.stack || e.message || e), 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMPORT
  // ─────────────────────────────────────────────────────────────────────────

  openImportModal() {
    const boxOptions = boxes.get().map(b => `<option value="${b.id}">${this.esc(b.sticker || '')} ${this.esc(b.name)}</option>`).join('');
    this.parsedImport = null;

    this.openModalLg('Импорт xlsx', 'Загрузите .xlsx — выберите формат и столбцы для импорта',
      `<div class="form-row">
        <div class="form-label">Формат файла</div>
        <select class="form-select" id="import-format" onchange="window.app.updateImportHint()">
          <option value="ozon">Ozon шаблон (строки 1,3,4 игнорируются, заголовки из строки 2)</option>
          <option value="yandex">Яндекс Маркет шаблон (лист «Данные о товарах», заголовки строка 4, данные с 8-й)</option>
          <option value="wb">WB шаблон (лист «Товары», заголовки строка 3, данные с 5-й)</option>
          <option value="system">Системный формат (заголовки из строки 1, данные со строки 2)</option>
        </select>
      </div>
      <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-inp').click()">
        <input type="file" id="file-inp" accept=".xlsx,.xls" onchange="window.app.onFileChosen(this)" style="display:none">
        <div class="upload-icon">⬆</div>
        <div class="upload-text">Перетащите .xlsx сюда или нажмите</div>
        <div class="upload-hint" id="import-hint">Строки 1, 3, 4 игнорируются · Заголовки из строки 2 · Данные с 5-й строки</div>
      </div>
      <div id="file-preview"></div>
      <div class="form-row" style="margin-top:14px">
        <div class="form-label">Группа для импорта</div>
        ${boxOptions
          ? `<select class="form-select" id="import-box-sel">${boxOptions}</select>`
          : `<div style="font-size:12px;color:var(--red)">Сначала создайте группу</div>`
        }
      </div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" id="import-btn" onclick="window.app.doImport()" disabled>Импортировать</button>`
    );

    if (this.activeBoxId) {
      setTimeout(() => {
        const sel = document.getElementById('import-box-sel') as HTMLSelectElement;
        if (sel) sel.value = this.activeBoxId!;
      }, 30);
    }
    this.setupDragDrop();
  }

  updateImportHint() {
    const format = (document.getElementById('import-format') as HTMLSelectElement)?.value || 'ozon';
    const hint = document.getElementById('import-hint');
    const text = format === 'ozon'
      ? 'Строки 1, 3, 4 игнорируются · Заголовки из строки 2 · Данные с 5-й строки'
      : format === 'yandex'
        ? 'Поддерживаются оба формата ЯМ: шаблон категории (лист «Данные о товарах») и экспорт (лист «Товары») · Служебные столбцы (ошибки, PARAM_NAMES) исключаются автоматически · Фото разбиваются на главное + дополнительные'
        : format === 'wb'
          ? 'Лист «Товары» · Заголовки из строки 3 · Данные с 5-й строки · «Артикул продавца» → Артикул · «Наименование» → Название товара · Фото (через «;») разбиваются автоматически'
          : 'Заголовки из строки 1 · Данные со строки 2';
    if (hint) hint.textContent = text;
  }

  private setupDragDrop() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag');
      const f = e.dataTransfer?.files[0];
      if (f) this.processFile(f);
    });
  }

  onFileChosen(inp: HTMLInputElement) {
    if (inp.files?.[0]) this.processFile(inp.files[0]);
  }

  private processFile(file: File) {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const buffer = e.target!.result as ArrayBuffer;
        const wb = XLSX.read(buffer, { type: 'array' });
        const format = (document.getElementById('import-format') as HTMLSelectElement)?.value || 'ozon';
        let headers: (string | null)[], rows: any[][], templateHeaders: any[][] | undefined, template_file_b64: string | undefined;

        // Служебные столбцы ЯМ — не содержат данных товара
        const YM_SERVICE_COLS = new Set([
          'Критичные ошибки', 'Некритичные ошибки', 'Качество карточки',
          'Рекомендации по заполнению', 'CSKU на Маркете', 'Дата дополнения карточки',
          'PARAM_NAMES', 'PARAM_IDS',
        ]);

        // Сохраняем оригинальный файл в base64 для экспорта обратно в шаблон
        const saveB64 = () => {
          const u8 = new Uint8Array(buffer);
          let bin = '';
          const ch = 8192;
          for (let i = 0; i < u8.byteLength; i += ch) bin += String.fromCharCode.apply(null, u8.subarray(i, i + ch) as any);
          return btoa(bin);
        };

        // Разбивает колонку с фото (разделитель sep) → mainPhoto + доп. фото
        const splitPhotos = (hdrs: (string | null)[], rws: any[][], sep: string) => {
          const idx = hdrs.indexOf('Ссылка на главное фото*');
          if (idx === -1 || hdrs.includes('Ссылки на дополнительные фото')) return rws;
          hdrs.push('Ссылки на дополнительные фото');
          const extraIdx = hdrs.length - 1;
          return rws.map(row => {
            const urls = String(row[idx] || '').split(sep).map((u: string) => u.trim()).filter((u: string) => u.startsWith('http'));
            const r = [...row];
            r[idx] = urls[0] || '';
            r[extraIdx] = urls.slice(1).join('\n');
            return r;
          });
        };

        if (format === 'yandex') {
          // Поддерживаем оба формата ЯМ:
          // 1) Шаблон категории — лист «Данные о товарах», строка 4 = заголовки, строки 5-7 служебные, данные с 8-й
          // 2) Экспорт / упрощённый — лист «Товары», строка 1 = заголовки, данные со 2-й
          const sheetName = wb.SheetNames.find(n => /данные\s*о\s*товар/i.test(n))
            ?? wb.SheetNames.find(n => /товар/i.test(n))
            ?? wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Авто-детект строки заголовков
          let headIdx = -1;
          let dataOffset = 1;

          // Сначала ищем «Ваш SKU» — признак шаблона загрузки (заголовки в строке 4+)
          for (let i = 0; i < Math.min(raw.length, 10); i++) {
            if ((raw[i] || []).some((c: any) => String(c ?? '').includes('Ваш SKU'))) {
              headIdx = i;
              dataOffset = 4; // пропускаем: коды параметров + пустая строка + описания
              break;
            }
          }

          // Иначе ищем любую строку с «Артикул» (экспорт / упрощённый формат)
          if (headIdx === -1) {
            for (let i = 0; i < Math.min(raw.length, 5); i++) {
              const row = raw[i] || [];
              const hasArt = row.some((c: any) => {
                const s = String(c ?? '').trim();
                return s === 'Артикул' || s === 'Ваш SKU *' || s === 'Артикул производителя';
              });
              if (hasArt) { headIdx = i; dataOffset = 1; break; }
            }
          }
          if (headIdx === -1) { headIdx = 0; dataOffset = 1; }

          headers = (raw[headIdx] || []).map((h: any) => {
            if (!h) return null;
            const s = String(h).trim();
            if (YM_SERVICE_COLS.has(s)) return null;
            if (s === 'Ваш SKU *' || s === 'Ваш SKU') return 'Артикул';
            if (s === 'Ссылка на изображение *') return 'Ссылка на главное фото*';
            if (s === 'Цена *') return 'Цена, руб.*';
            if (s === 'Название товара *') return 'Название товара *'; // уже норм
            return s;
          });

          rows = raw.slice(headIdx + dataOffset).filter((r: any[]) => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + dataOffset);
          rows = splitPhotos(headers, rows, ',');
          template_file_b64 = saveB64();

        } else if (format === 'wb') {
          // WB шаблон: лист «Товары», строки 1-2 = группировка разделов, строка 3 = заголовки, строка 4 = описания, данные с 5-й
          const sheetName = wb.SheetNames.find(n => /^товар/i.test(n)) ?? wb.SheetNames[0];
          const ws = wb.Sheets[sheetName];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Авто-детект: ищем строку с «Артикул продавца»
          let headIdx = 2; // обычно строка 3 (0-indexed: 2)
          for (let i = 0; i < Math.min(raw.length, 7); i++) {
            if ((raw[i] || []).some((c: any) => String(c ?? '').includes('Артикул продавца'))) {
              headIdx = i;
              break;
            }
          }

          headers = (raw[headIdx] || []).map((h: any) => {
            if (!h) return null;
            const s = String(h).trim();
            if (s === 'Артикул продавца') return 'Артикул';
            if (s === 'Наименование') return 'Название товара *';
            if (s === 'Фото') return 'Ссылка на главное фото*';
            if (s === 'Группа') return null; // порядковый номер, не нужен
            return s;
          });

          // dataOffset = 2: пропускаем строку описаний (строка 4)
          rows = raw.slice(headIdx + 2).filter((r: any[]) => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + 2);
          rows = splitPhotos(headers, rows, ';');
          template_file_b64 = saveB64();

        } else if (format === 'ozon') {
          const ws = wb.Sheets['Шаблон'] || wb.Sheets[wb.SheetNames[0]];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];

          // Улучшенный авто-детект: ищем строку, где есть "Артикул" (обычно 2-я или 3-я)
          let headIdx = -1;
          for (let i = 0; i < Math.min(raw.length, 10); i++) {
            if ((raw[i] || []).some(c => String(c || '').includes('Артикул'))) {
              headIdx = i;
              break;
            }
          }

          if (headIdx === -1) {
            this.toast('Это не похоже на шаблон Ozon (не найден столбец Артикул)', 'warning');
            headIdx = 1; // fallback
          }

          headers = (raw[headIdx] || []).map((h: any) => h ? String(h).trim() : null);
          // Данные обычно начинаются через 3 строки после заголовка (Заголовки -> Ключи -> Примеры -> Данные)
          rows = raw.slice(headIdx + 3).filter(r => r.some((c: any) => c !== null && c !== ''));
          templateHeaders = raw.slice(0, headIdx + 3);

          // СОХРАНЯЕМ ОРИГИНАЛЬНЫЙ ФАЙЛ
          const uint8Array = new Uint8Array(buffer);
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < uint8Array.byteLength; i += chunk) {
            binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunk) as any);
          }
          template_file_b64 = btoa(binary);

        } else {
          const ws = wb.Sheets['Шаблон'] || wb.Sheets[wb.SheetNames[0]];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as any[][];
          headers = (raw[0] || []).map((h: any) => h ? String(h).trim() : null);
          rows = raw.slice(1).filter(r => r.some((c: any) => c !== null && c !== ''));
        }

        if (!headers.filter(Boolean).length || !rows.length) { this.toast('Не удалось прочитать файл', 'error'); return; }
        this.parsedImport = { filename: file.name, headers: headers as string[], rows, format, templateHeaders, template_file_b64 };
        this.renderImportPreview();
      } catch (err: any) { this.toast('Ошибка: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
  }

  private renderImportPreview() {
    if (!this.parsedImport) return;
    const { filename, headers, rows } = this.parsedImport;
    const nonNull = headers.map((h, i) => ({ h, i })).filter(x => x.h);
    const preview = document.getElementById('file-preview');
    if (!preview) return;

    preview.innerHTML = `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:12px;color:var(--text2)">✓ <strong style="color:var(--text)">${this.esc(filename)}</strong></span>
          <span style="font-size:11px;color:var(--text3)">${nonNull.length} столбцов · ${rows.length} товаров</span>
        </div>
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для импорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllCols(false)">Снять</button>
        </div>
      </div>
      <div id="col-selector" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:200px;overflow-y:auto;padding-right:4px">
        ${nonNull.map(({ h, i }) => {
          const isArt = h.includes('Артикул');
          // Считаем импорт "первым", если в текущей группе еще нет товаров
          const isFirstImport = this.allProducts.length === 0;
          const disabled = isArt || isFirstImport;
          return `
            <div class="chk on ${disabled ? 'disabled' : ''}" data-col-idx="${i}" 
                 ${disabled ? 'style="opacity:0.6;cursor:not-allowed"' : 'onclick="this.classList.toggle(\'on\');window.app.updateImportCount()"'} 
                 title="${disabled ? 'Обязательный столбец' : ''}">
              <div class="chk-box"><div class="chk-tick"></div></div>
              <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(h.replace('*', ''))}</span>
            </div>
          `;
        }).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для импорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllRows(false)">Снять</button>
        </div>
      </div>
      <div id="row-selector" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="position:sticky;top:0;z-index:1">
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Цена</th>
          </tr></thead>
          <tbody id="row-sel-body">
            ${rows.map((row, ri) => {
              const artIdx = headers.findIndex(h => h && h.includes('Артикул'));
              const nameIdx = headers.findIndex(h => h && h.includes('Название товара'));
              const priceIdx = headers.findIndex(h => h && h.includes('Цена, руб'));
              const art = artIdx >= 0 ? (row[artIdx] || '') : '';
              const name = nameIdx >= 0 ? (row[nameIdx] || '') : '';
              const price = priceIdx >= 0 ? (row[priceIdx] || '') : '';
              return `<tr class="row-sel-item on" data-row-idx="${ri}" onclick="this.classList.toggle('on');window.app.updateImportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${this.esc(String(art))}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(String(name))}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--accent);white-space:nowrap">${price ? Number(price).toLocaleString('ru') + ' ₽' : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="import-count-label"></div>
    `;

    const rowBody = document.getElementById('row-sel-body');
    if (rowBody) {
      rowBody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
      rowBody.addEventListener('mouseout', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
    }
    this.updateImportCount();
    const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
    if (importBtn) importBtn.disabled = false;
  }

  updateImportCount() {
    const selCols = document.querySelectorAll('#col-selector .chk.on').length;
    const selRows = document.querySelectorAll('#row-sel-body .row-sel-item.on').length;
    const lbl = document.getElementById('import-count-label');
    if (lbl) lbl.textContent = `Будет импортировано: ${selRows} позиций × ${selCols} столбцов`;
    document.querySelectorAll<HTMLElement>('#row-sel-body .row-sel-item').forEach(tr => {
      const box = tr.querySelector<HTMLElement>('.chk-box');
      const tick = tr.querySelector<HTMLElement>('.chk-tick');
      if (box && tick) {
        if (tr.classList.contains('on')) { box.style.background = 'var(--accent)'; box.style.borderColor = 'var(--accent)'; tick.style.display = 'block'; }
        else { box.style.background = 'var(--bg3)'; box.style.borderColor = ''; tick.style.display = 'none'; }
      }
    });
  }

  toggleAllCols(on: boolean) {
    document.querySelectorAll('#col-selector .chk').forEach(el => {
      if (!el.classList.contains('disabled')) {
        on ? el.classList.add('on') : el.classList.remove('on');
      }
    });
    this.updateImportCount();
  }

  toggleAllRows(on: boolean) {
    document.querySelectorAll('#row-sel-body .row-sel-item').forEach(el => on ? el.classList.add('on') : el.classList.remove('on'));
    this.updateImportCount();
  }

  async doImport() {
    if (!this.parsedImport) return;
    const boxSel = document.getElementById('import-box-sel') as HTMLSelectElement;
    if (!boxSel) { this.toast('Выберите группу', 'error'); return; }
    const boxId = boxSel.value;

    const selColIdxs = new Set([...document.querySelectorAll<HTMLElement>('#col-selector .chk.on')].map(el => parseInt(el.dataset.colIdx!)));
    const selRowIdxs = new Set([...document.querySelectorAll<HTMLElement>('#row-sel-body .row-sel-item.on')].map(el => parseInt(el.dataset.rowIdx!)));
    if (!selColIdxs.size) { this.toast('Выберите хотя бы один столбец', 'error'); return; }
    if (!selRowIdxs.size) { this.toast('Выберите хотя бы одну позицию', 'error'); return; }

    const btn = document.getElementById('import-btn') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Проверяю дубли...'; }

    try {
      const { filename, headers, rows } = this.parsedImport;
      const artIdx = headers.findIndex(h => h && h.includes('Артикул'));
      const existing = await apiService.getProductsByBox(boxId);
      const existingArts = new Set((existing || []).map(p => String(p.data?.['Артикул*'] || '').trim()).filter(Boolean));

      this.importCtx = { boxId, selColIdxs, selRowIdxs, filename, headers, rows, templateHeaders: this.parsedImport.templateHeaders, template_file_b64: this.parsedImport.template_file_b64, artIdx, existingArts, btn };

      const existingColumns = new Set<string>();
      (existing || []).forEach(p => {
        Object.keys(p.data || {}).forEach(k => {
          if (!k.startsWith('_')) existingColumns.add(k);
        });
      });
      const newColumns = headers.filter((h, i) => h && selColIdxs.has(i) && !existingColumns.has(h));

      if (newColumns.length > 0 && existing.length > 0) {
        if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
        this.openModal('Новые столбцы обнаружены', `В шаблоне есть ${newColumns.length} новых столбцов`,
          `<div style="background:var(--accent-dim);border:1px solid rgba(212,240,0,0.3);border-radius:8px;padding:14px 16px;margin-bottom:14px">
            <div style="font-size:12.5px;color:var(--text2);margin-bottom:8px">Новые столбцы:</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${newColumns.map(c => `<span style="font-family:monospace;font-size:11px;padding:2px 8px;background:var(--bg4);border:1px solid var(--border2);border-radius:4px;color:var(--text)">${this.esc(c.replace('*', ''))}</span>`).join('')}</div>
          </div>
          <div style="font-size:12.5px;color:var(--text2);margin-bottom:12px">Что делать с новыми столбцами?</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn" style="justify-content:flex-start" onclick="window.app.confirmImportWithNewColumns('all')">
              <span style="color:var(--accent)">✓</span> Импортировать все столбцы (новые и старые)
            </button>
            <button class="btn" style="justify-content:flex-start" onclick="window.app.confirmImportWithNewColumns('existing_only')">
              <span style="color:var(--text3)">○</span> Только столбцы которые были ранее
            </button>
          </div>`,
          `<button class="btn" onclick="window.app.closeModal()">Отмена</button>`
        );
        return;
      }

      await this.performImport(boxId, filename, headers, rows, selColIdxs, selRowIdxs, artIdx, existingArts, btn, 'all');
    } catch (e: any) {
      this.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
    }
  }

  async confirmImportWithNewColumns(mode: 'all' | 'existing_only') {
    const ctx = this.importCtx;
    if (!ctx) return;
    this.closeModal();
    await this.performImport(ctx.boxId, ctx.filename, ctx.headers, ctx.rows, ctx.selColIdxs, ctx.selRowIdxs, ctx.artIdx, ctx.existingArts, ctx.btn, mode);
  }

  private async performImport(
    boxId: string, filename: string, headers: string[], rows: any[][],
    selColIdxs: Set<number>, selRowIdxs: Set<number>, artIdx: number,
    existingArts: Set<string>, btn: HTMLButtonElement | null, mode: 'all' | 'existing_only'
  ) {
    const templateHeaders = this.importCtx?.templateHeaders;
    // Existing columns for 'existing_only' mode
    let allowedCols: Set<string> | null = null;
    if (mode === 'existing_only') {
      const existing = await apiService.getProductsByBox(boxId);
      const cols = new Set<string>();
      (existing || []).forEach(p => {
        Object.keys(p.data || {}).forEach(k => {
          if (!k.startsWith('_')) cols.add(k);
        });
      });
      allowedCols = cols;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Импортирую...'; }

    try {
      // Create sheet record
      const selHeaders = headers.filter((h, i) => h && selColIdxs.has(i));
      const template_file_b64 = this.importCtx?.template_file_b64;
      void await apiService.createSheet({ box_id: boxId, filename, columns: selHeaders, template_headers: templateHeaders, template_file_b64 });

      const selectedRows = rows.filter((_, ri) => selRowIdxs.has(ri));

      // Check duplicates
      const newRows: any[] = [];
      const updateRows: any[] = [];
      for (const row of selectedRows) {
        const art = artIdx >= 0 ? String(row[artIdx] || '').trim() : '';
        const data: Record<string, any> = {};
        headers.forEach((h, i) => {
          if (!h || !selColIdxs.has(i)) return;
          if (allowedCols && !allowedCols.has(h)) return;
          data[h] = row[i] ?? '';
        });
        if (art && existingArts.has(art)) updateRows.push({ art, data });
        // Артикулы не из группы — не добавляем, считаем пропущенными
      }

      void selectedRows.length; // skipped count computed below
      const unknownCount = selectedRows.filter(row => {
        const art2 = artIdx >= 0 ? String(row[artIdx] || '').trim() : '';
        return art2 && !existingArts.has(art2);
      }).length;

      // Обновляем только существующие товары
      if (updateRows.length > 0) {
        const msg = `${updateRows.length} товаров найдено в группе. Обновить их данные?`;
        if (confirm(msg)) {
          const existing = await apiService.getProductsByBox(boxId);
          for (const { art, data } of updateRows) {
            const prod = existing.find(p => String(p.data?.['Артикул*'] || '').trim() === art);
            if (prod) await apiService.updateProduct(prod.id, { data });
          }
        }
      }

      // Предупреждение о пропущенных
      if (unknownCount > 0) {
        setTimeout(() => {
          this.toast(
            `⚠ ${unknownCount} артикул(ов) из файла не найдено в группе — пропущены и не добавлены. xlsx-добавка дополняет только существующие товары.`,
            'info', 8000
          );
        }, 500);
      }

      this.toast(`Импортировано: ${newRows.length} новых, ${updateRows.length} обновлено`, 'success', 4000);
      this.cache.delete(boxId);
      idbCache.remove(boxId).catch(() => {});
      // Сбрасываем сохранённый порядок столбцов — при следующем рендере применится новый приоритет
      this.columnOrder.delete(boxId);

      // Автоскрытие пустых столбцов: импортируем все (для экспорта обратно в шаблон),
      // но скрываем в таблице те, где у всех товаров пустые значения
      if (this.activeBoxId === boxId) {
        const importedHeaders = headers.filter((h, i) => h && selColIdxs.has(i)) as string[];
        const emptyCols = new Set(importedHeaders.filter(h => {
          const colIdx = headers.indexOf(h);
          return selectedRows.every(row => {
            const v = row[colIdx];
            return v === null || v === undefined || String(v).trim() === '';
          });
        }));
        if (emptyCols.size > 0) {
          const visibleSet = new Set(importedHeaders.filter(h => !emptyCols.has(h)));
          this.visibleCols = visibleSet.size > 0 ? visibleSet : null;
          try { localStorage.setItem(`vis_cols_${boxId}`, JSON.stringify([...visibleSet])); } catch {}
        }
      }
      try {
        const co: Record<string, string[]> = {};
        for (const [bid, cls] of this.columnOrder) co[bid] = cls;
        localStorage.setItem('app_column_order', JSON.stringify(co));
      } catch {}
      this.closeModal();
      this.loadBoxCount(boxId);
      if (this.activeBoxId === boxId) await this.loadBoxProducts();
    } catch (e: any) {
      this.toast('Ошибка импорта: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Импортировать'; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MOBILE
  // ─────────────────────────────────────────────────────────────────────────

  openMobileSheet(type: 'boxes' | 'filters') {
    this.closeMobileSheets();
    if (type === 'boxes') this.renderMobileBoxes();
    document.getElementById(`sheet-${type}`)?.classList.add('open');
    document.getElementById('ms-backdrop')?.classList.add('on');
  }

  closeMobileSheets() {
    document.querySelectorAll('.mobile-sheet').forEach(s => s.classList.remove('open'));
    document.getElementById('ms-backdrop')?.classList.remove('on');
  }

  private renderMobileBoxes() {
    const el = document.getElementById('mobile-boxes-list');
    if (!el) return;
    const boxList = boxes.get();
    el.innerHTML = boxList.map(b => `
      <div class="box-item ${b.id === this.activeBoxId ? 'active' : ''}" onclick="window.app.selectBox('${b.id}')" onmouseenter="window.app.preloadBox('${b.id}')">
        <div class="box-emoji" style="font-size:24px;width:32px">${this.esc(b.sticker || '📦')}</div>
        <div class="box-meta">
          <div class="box-name" style="font-size:15px;font-weight:500">${this.esc(b.name)}</div>
          <div class="box-count" id="mbc-${b.id}" style="font-size:12px;margin-top:2px">...</div>
        </div>
        <div class="box-actions" style="display:flex;gap:4px">
          <button class="box-action-btn" style="width:32px;height:32px;font-size:14px;background:var(--bg4)" onclick="event.stopPropagation();window.app.renameBox('${b.id}','${this.esc(b.name)}')">✎</button>
          <button class="box-action-btn" style="width:32px;height:32px;font-size:14px;background:var(--bg4)" onclick="event.stopPropagation();window.app.deleteBox('${b.id}','${this.esc(b.name)}')">✕</button>
        </div>
      </div>
    `).join('');
  }

  private renderGroupsBar() {
    const bar = document.getElementById('groups-bar');
    const list = document.getElementById('groups-bar-list');
    if (!bar || !list) return;

    const boxList = boxes.get();
    const mpColor: Record<string, string> = {
      ozon: '#005bff', ym: '#f4a000', wb: '#cb11ab',
    };

    const allChip = `<div class="group-chip ${!this.activeBoxId ? 'active' : ''}" onclick="window.app.setView('all')">
      Все товары
    </div>`;

    const chips = boxList.map(b => {
      const isActive = b.id === this.activeBoxId;
      const color = b.mp_source ? (mpColor[b.mp_source] || 'var(--muted)') : 'var(--muted)';
      const displayName = b.name
        .replace(/^🟠\s*(Ozon:|Озон:)\s*/i, '')
        .replace(/^🟡\s*(ЯМ:|Яндекс Маркет:)\s*/i, '')
        .replace(/^🟣\s*(WB:|Wildberries:)\s*/i, '')
        .trim();
      const count = this.cache.has(b.id) ? this.cache.get(b.id)!.length : null;
      const countHtml = count !== null ? `<span class="gc-count">${count}</span>` : '';
      return `<div class="group-chip ${isActive ? 'active' : ''}" onclick="window.app.selectBox('${b.id}')">
        <span class="gc-dot" style="background:${color}"></span>
        ${this.esc(displayName)}
        ${countHtml}
      </div>`;
    }).join('');

    list.innerHTML = allChip + chips;

    // Show/hide inline add-product button
    const addInlineBtn = document.getElementById('add-product-inline-btn');
    if (addInlineBtn) addInlineBtn.style.display = this.activeBoxId ? 'flex' : 'none';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 1: DRAG-AND-DROP ROW REORDERING
  // ─────────────────────────────────────────────────────────────────────────

  onRowDragStart(idx: number) {
    this.dragFromIdx = idx;
  }

  onRowDragOver(el: HTMLElement, _idx: number) {
    // Remove indicator from all rows
    document.querySelectorAll('#vt-tbody tr').forEach(tr => (tr as HTMLElement).classList.remove('vt-drag-over'));
    el.classList.add('vt-drag-over');
  }

  onRowDragLeave(el: HTMLElement) {
    el.classList.remove('vt-drag-over');
  }

  onRowDrop(idx: number) {
    document.querySelectorAll('#vt-tbody tr').forEach(tr => (tr as HTMLElement).classList.remove('vt-drag-over'));
    if (this.dragFromIdx === null || this.dragFromIdx === idx) {
      this.dragFromIdx = null;
      return;
    }
    const from = this.dragFromIdx;
    const to = idx;
    this.dragFromIdx = null;

    // Reorder in filtered array
    const item = this.filtered.splice(from, 1)[0];
    this.filtered.splice(to, 0, item);

    // Sync back to allProducts by reordering within allProducts
    // Rebuild allProducts to match filtered order (filtered is a subset)
    const filteredIds = new Set(this.filtered.map(p => p.id));
    const notFiltered = this.allProducts.filter(p => !filteredIds.has(p.id));
    this.allProducts = [...this.filtered, ...notFiltered];

    if (this.activeBoxId) {
      this.cache.set(this.activeBoxId, this.allProducts);
      idbCache.set(this.activeBoxId, this.allProducts).catch(() => {});
    }

    this.applyFilters();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 2: COLUMN REORDERING (in settings)
  // ─────────────────────────────────────────────────────────────────────────

  onColDragStart(e: DragEvent, idx: number) {
    this.dragColIdx = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
    (e.target as HTMLElement).classList.add('dragging');
  }

  onColDragOver(e: DragEvent, el: HTMLElement) {
    e.preventDefault();
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over'));
    el.classList.add('drag-over');
  }

  onColDragLeave(el: HTMLElement) {
    el.classList.remove('drag-over');
  }

  onColDrop(e: DragEvent, toIdx: number) {
    e.preventDefault();
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over', 'dragging'));

    const fromIdx = this.dragColIdx;
    this.dragColIdx = null;
    if (fromIdx === null || fromIdx === toIdx) return;

    // Реорганизуем this.columns (только те, что не в SKIP_COLS)
    const validCols = this.columns.filter(c => !App.SKIP_COLS.has(c));
    const item = validCols.splice(fromIdx, 1)[0];
    validCols.splice(toIdx, 0, item);

    // Сохраняем новый порядок для текущей группы
    if (this.activeBoxId) {
      this.columnOrder.set(this.activeBoxId, validCols);
      const co: Record<string, string[]> = {};
      for (const [bid, cols] of this.columnOrder) co[bid] = cols;
      localStorage.setItem('app_column_order', JSON.stringify(co));
    }

    // Перестраиваем полный список столбцов
    this.buildColumns();

    // Обновляем UI настроек (перерендерим модал)
    if (this.activeBoxId) {
      this.openBoxSettings(this.activeBoxId);
    }
  }

  onColDragEnd() {
    document.querySelectorAll('.col-pick-row').forEach(r => r.classList.remove('drag-over', 'dragging'));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 2: MANUAL PRODUCT ADDITION
  // ─────────────────────────────────────────────────────────────────────────

  openAddProductModal() {
    if (!this.activeBoxId) {
      this.toast('Сначала выберите группу', 'error');
      return;
    }

    const defaultFields = ['Артикул*', 'Название товара', 'Цена, руб.*', 'Тип*', 'Цвет товара'];
    const fields = this.columns.length > 0 ? this.columns.slice(0, 20) : defaultFields;

    const body = `<table class="edit-table">${fields.map(k => `
      <tr>
        <td>${this.esc(k.replace('*', ''))}${k.endsWith('*') ? '<span style="color:var(--accent)">*</span>' : ''}</td>
        <td><input class="edit-inp" data-key="${this.esc(k)}" placeholder="${this.esc(k.replace('*', ''))}"></td>
      </tr>
    `).join('')}</table>`;

    this.openModalLg('Добавить товар', 'Заполните поля нового товара', body,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.saveNewProduct()">+ Добавить</button>`
    );
  }

  async saveNewProduct() {
    if (!this.activeBoxId) {
      this.toast('Нет активной группы', 'error');
      return;
    }

    const inputs = document.querySelectorAll<HTMLInputElement>('.edit-inp');
    const data: Record<string, string> = {};
    inputs.forEach(inp => {
      if (inp.dataset.key) data[inp.dataset.key] = inp.value;
    });

    const art = data['Артикул*'];
    if (!art || !art.trim()) {
      this.toast('Введите Артикул*', 'error');
      return;
    }

    const btn = document.querySelector<HTMLButtonElement>('#modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Добавляю...'; }

    try {
      const sheets = await apiService.getSheetsByBox(this.activeBoxId);
      if (!sheets || sheets.length === 0) {
        this.toast('Сначала импортируйте шаблон', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '+ Добавить'; }
        return;
      }
      const sheetId = sheets[0].id;

      const newProd = await apiService.createProduct({
        box_id: this.activeBoxId,
        sheet_id: sheetId,
        data
      });

      this.allProducts.unshift(newProd);
      this.cache.set(this.activeBoxId, this.allProducts);
      idbCache.set(this.activeBoxId, this.allProducts).catch(() => {});

      this.buildColumns();
      this.applyFilters();
      this.loadBoxCount(this.activeBoxId);

      this.toast('Товар добавлен', 'success');
      this.closeModal();
    } catch (e: any) {
      this.toast('Ошибка: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '+ Добавить'; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 3: EXPORT ALL TO EXCEL
  // ─────────────────────────────────────────────────────────────────────────

  exportAllToExcel() {
    // Берём все товары из allProducts (уже загружены в «Все товары»)
    const prods = this.allProducts;
    if (!prods.length) {
      this.toast('Нет данных для экспорта', 'error');
      return;
    }

    // Собираем все ключи по всем товарам, исключая служебные поля
    const colSet = new Set<string>();
    prods.forEach(p => {
      Object.keys(p.data || {}).forEach(k => {
        if (!k.startsWith('_')) colSet.add(k);
      });
    });
    const cols = [...colSet];

    const rows: (string | number | undefined)[][] = [cols];
    for (const p of prods) {
      rows.push(cols.map(c => p.data[c] ?? ''));
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = cols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');

    const today = new Date().toISOString().slice(0, 10);
    const fname = `simadesk_all_${today}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.toast(`Скачано ${prods.length} товаров → ${fname}`, 'success');
  }

  openExportModalAll() {
    const prods = this.filtered.length ? this.filtered : this.allProducts;
    if (!prods.length) { this.toast('Нет товаров для экспорта', 'error'); return; }

    // Собираем все уникальные колонки по всем товарам
    const colSet = new Set<string>();
    prods.forEach(p => Object.keys(p.data || {}).forEach(k => { if (!k.startsWith('_')) colSet.add(k); }));
    const allCols = [...colSet];

    this.openModalLg('Экспорт — Все товары', `${prods.length} товаров`,
      `<div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите столбцы для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportCols(false)">Снять</button>
        </div>
      </div>
      <div id="export-col-sel" style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:16px;max-height:140px;overflow-y:auto;padding-right:4px">
        ${allCols.map(c => `
          <div class="chk on" data-ecol="${this.esc(c)}" onclick="this.classList.toggle('on');window.app.updateExportCount()">
            <div class="chk-box"><div class="chk-tick"></div></div>
            <span class="chk-label" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this.esc(c)}">${this.esc(c.replace('*',''))}</span>
          </div>`).join('')}
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;color:var(--text2);font-weight:500">Выберите позиции для экспорта</div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(true)">Все</button>
          <button class="btn" style="padding:4px 10px;font-size:11px" onclick="window.app.toggleAllExportRows(false)">Снять</button>
        </div>
      </div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:36px;padding:8px 10px;background:var(--bg4);border-bottom:1px solid var(--border)"></th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Артикул</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border)">Название</th>
            <th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text3);letter-spacing:.8px;text-transform:uppercase;background:var(--bg4);border-bottom:1px solid var(--border);white-space:nowrap">Группа</th>
          </tr></thead>
          <tbody id="export-row-body">
            ${prods.map(p => {
              const d = p.data || {};
              const boxName = boxes.get().find(b => b.id === p.box_id)?.name ?? '—';
              return `<tr class="exp-row on" data-prod-id="${p.id}" onclick="this.classList.toggle('on');window.app.updateExportCount()" style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                <td style="padding:8px 10px;text-align:center"><div class="chk-box" style="margin:0 auto"><div class="chk-tick"></div></div></td>
                <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${this.esc(d['Артикул*'] || d['Артикул'] || '')}</td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(d['Название товара'] || d['Название товара*'] || '')}</td>
                <td style="padding:8px 10px;font-size:11px;color:var(--muted);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">${this.esc(boxName)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:11.5px;color:var(--text3)" id="export-count-lbl"></div>`,
      `<button class="btn" onclick="window.app.closeModal()">Отмена</button>
       <button class="btn btn-primary" onclick="window.app.doExportAll()">↓ Скачать xlsx</button>`
    );

    setTimeout(() => {
      const tbody = document.getElementById('export-row-body');
      if (tbody) {
        tbody.addEventListener('mouseover', e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = 'var(--bg3)'; });
        tbody.addEventListener('mouseout',  e => { const tr = (e.target as HTMLElement).closest('tr'); if (tr) (tr as HTMLElement).style.background = ''; });
      }
      this.updateExportCount();
    }, 50);
  }

  doExportAll() {
    const selCols = [...document.querySelectorAll<HTMLElement>('#export-col-sel .chk.on')].map(el => el.dataset.ecol!);
    const selIds  = new Set([...document.querySelectorAll<HTMLElement>('#export-row-body .exp-row.on')].map(el => el.dataset.prodId!));
    if (!selCols.length || !selIds.size) { this.toast('Выберите столбцы и позиции', 'error'); return; }

    const prods = (this.filtered.length ? this.filtered : this.allProducts).filter(p => selIds.has(p.id));
    const wsData = [selCols, ...prods.map(p => selCols.map(c => p.data[c] ?? ''))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = selCols.map(c => ({ wch: Math.min(Math.max(c.length + 2, 12), 40) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const fname = `simadesk_all_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    this.toast(`Файл ${fname} скачан`, 'success');
    this.closeModal();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE 4: NAVIGATION & DASHBOARD
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить артикулы товаров активной группы.
   * Используется в SettingsHub для импорта/экспорта шаблонов.
   * Если активной группы нет — возвращает пустой массив.
   */
  getActiveGroupOffers(): Array<{ offer_id: string; name: string; box_name: string }> {
    const out: Array<{ offer_id: string; name: string; box_name: string }> = [];
    const allBoxes = boxes.get();
    const targetBoxes = this.activeBoxId
      ? allBoxes.filter(b => b.id === this.activeBoxId)
      : allBoxes;
    for (const box of targetBoxes) {
      const prods = this.cache.get(box.id) ?? [];
      for (const p of prods) {
        const offer = String(p.data?.['Артикул*'] ?? '').trim();
        if (!offer) continue;
        const name = String(p.data?.['Название товара'] ?? p.data?.['Название'] ?? '').trim();
        out.push({ offer_id: offer, name, box_name: box.name });
      }
    }
    return out;
  }

  /** Имя активной группы (для UI шаблона). */
  getActiveGroupName(): string | null {
    if (!this.activeBoxId) return null;
    const b = boxes.get().find(b => b.id === this.activeBoxId);
    return b?.name ?? null;
  }

  toggleMarketplaces() {
    const navGroupMarketplaces = document.getElementById('nav-group-marketplaces');
    const navMarketplaces = document.getElementById('nav-marketplaces');
    if (navGroupMarketplaces && navMarketplaces) {
      const isHidden = navGroupMarketplaces.style.display === 'none';
      navGroupMarketplaces.style.display = isHidden ? '' : 'none';
      navMarketplaces.classList.toggle('active', isHidden);
    }
  }

  toggleOrders() {
    const navGroupOrders = document.getElementById('nav-group-orders');
    const navOrders = document.getElementById('nav-orders');
    if (navGroupOrders && navOrders) {
      const isHidden = navGroupOrders.style.display === 'none';
      navGroupOrders.style.display = isHidden ? '' : 'none';
      navOrders.classList.toggle('active', isHidden);
    }
  }

  /** Скрыть все маркетплейс/orders секции. */
  private hideAllMarketplaceSections(): void {
    const ids = [
      'ozon-content', 'yandex-content', 'wb-content',
      'orders-section', 'orders-ozon-section', 'orders-yandex-section', 'orders-wb-section',
      'marketplaces-dashboard', 'analytics-section', 'settings-hub-section',
      'profile-section', 'settings-section',
      'repricer-section',
      'sku-audit-section', 'reviews-section', 'chats-section', 'logs-section', 'automation-section',
      'catalog-section',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const w: any = window;
    w.ozonModule?.hide();
    w.yandexModule?.hide();
    w.wbModule?.hide();
    w.ozonOrdersModule?.hide();
    w.yandexOrdersModule?.hide();
    w.wbOrdersModule?.hide();
    w.allOrdersModule?.hide();
    w.marketplacesDashboard?.hide();
    w.analyticsModule?.hide();
    w.settingsHub?.hide();
    w.profileModule?.hide();
    w.settingsModule?.hide();
    w.seoModule?.hide();
    w.repricerModule?.hide();
    w.skuAuditModule?.hide();
    w.reviewsModule?.hide();
    w.chatsModule?.hide();
    w.logsModule?.hide();
    w.automationModule?.hide();
    w.taskManagerModule?.hide();
    w.stockModule?.hide();
    w.catalogMpModule?.hide();
  }

  /** Сбросить active-классы у всех nav/dock элементов. */
  private resetNavActive(): void {
    // Dock items
    const dock = document.getElementById('app-dock');
    if (dock) {
      dock.querySelectorAll('.dock-item.active').forEach(el => el.classList.remove('active'));
    }
    // Legacy nav elements
    const ids = [
      'nav-home','nav-products','nav-analytics','nav-settings-hub','nav-settings','nav-orders','nav-marketplaces',
      'nav-ozon','nav-yandex','nav-wb',
      'nav-orders-ozon','nav-orders-yandex','nav-orders-wb',
      'nav-repricer',
      'nav-sku-audit','nav-reviews','nav-chats','nav-logs','nav-automation','nav-tasks','nav-stock','nav-catalog',
    ];
    for (const id of ids) {
      document.getElementById(id)?.classList.remove('active');
    }
  }

  async navigateTo(
    page: 'home' | 'products' | 'analytics' | 'settings-hub' | 'settings' | 'profile' | 'orders' | 'marketplaces'
        | 'ozon' | 'yandex' | 'wb'
        | 'orders-ozon' | 'orders-yandex' | 'orders-wb'
        | 'repricer' | 'stock' | 'catalog'
        | 'sku-audit' | 'reviews' | 'chats' | 'logs' | 'automation' | 'tasks',
    { loadAll = false }: { loadAll?: boolean } = {},
  ) {
    this.currentPage = page as any;
    localStorage.setItem('last_page', page);

    const topbarEl             = document.querySelector<HTMLElement>('.topbar');
    const content              = document.querySelector<HTMLElement>('.content');
    const sideboxes            = document.getElementById('sidebar-boxes-section');
    const w: any = window;

    const isModulePage =
      page === 'marketplaces' || page === 'ozon' || page === 'yandex' || page === 'wb' ||
      page === 'orders' || page === 'orders-ozon' || page === 'orders-yandex' || page === 'orders-wb' ||
      page === 'analytics' || page === 'settings-hub' || page === 'settings' || page === 'profile' ||
      page === 'repricer' ||
      page === 'sku-audit' || page === 'reviews' || page === 'chats' || page === 'logs' || page === 'automation' ||
      page === 'tasks' || page === 'stock' || page === 'catalog';

    const groupsBar = document.getElementById('groups-bar');

    if (isModulePage) {
      this.hideAllMarketplaceSections();
      this.resetNavActive();
      if (content) content.style.display = 'none';
      if (topbarEl) topbarEl.style.display = 'none';
      if (sideboxes) sideboxes.style.display = 'none';
      if (groupsBar) groupsBar.style.display = 'none';

      // Highlight dock item for marketplace sub-pages
      const isMarketplacesPage = page === 'marketplaces' || page === 'ozon' || page === 'yandex' || page === 'wb';
      const isOrdersPage = page.startsWith('orders');
      if (isMarketplacesPage) document.getElementById('nav-marketplaces')?.classList.add('active');
      if (isOrdersPage) document.getElementById('nav-orders')?.classList.add('active');

      switch (page) {
        case 'analytics':
          document.getElementById('nav-analytics')?.classList.add('active');
          w.analyticsModule?.show();
          break;
        case 'settings-hub':
          // Legacy — redirect to profile
          document.getElementById('nav-settings')?.classList.add('active');
          w.profileModule?.show();
          break;
        case 'profile':
          w.profileModule?.show();
          break;
        case 'settings':
          document.getElementById('nav-settings')?.classList.add('active');
          w.settingsModule?.show();
          break;
        case 'marketplaces':
          w.marketplacesDashboard?.show();
          break;
        case 'ozon':
          document.getElementById('nav-ozon')?.classList.add('active');
          w.ozonModule?.show();
          break;
        case 'yandex':
          document.getElementById('nav-yandex')?.classList.add('active');
          w.yandexModule?.show();
          break;
        case 'wb':
          document.getElementById('nav-wb')?.classList.add('active');
          w.wbModule?.show();
          break;
        case 'orders':
          w.allOrdersModule?.show();
          break;
        case 'orders-ozon':
          document.getElementById('nav-orders-ozon')?.classList.add('active');
          w.ozonOrdersModule?.show();
          break;
        case 'orders-yandex':
          document.getElementById('nav-orders-yandex')?.classList.add('active');
          w.yandexOrdersModule?.show();
          break;
        case 'orders-wb':
          document.getElementById('nav-orders-wb')?.classList.add('active');
          w.wbOrdersModule?.show();
          break;
        case 'repricer':
          document.getElementById('nav-repricer')?.classList.add('active');
          w.repricerModule?.show();
          break;
        case 'sku-audit':
          document.getElementById('nav-sku-audit')?.classList.add('active');
          w.skuAuditModule?.show();
          break;
        case 'reviews':
          document.getElementById('nav-reviews')?.classList.add('active');
          w.reviewsModule?.show();
          break;
        case 'chats':
          document.getElementById('nav-chats')?.classList.add('active');
          w.chatsModule?.show();
          break;
        case 'logs':
          document.getElementById('nav-logs')?.classList.add('active');
          w.logsModule?.show();
          break;
        case 'automation':
          document.getElementById('nav-automation')?.classList.add('active');
          w.automationModule?.show();
          break;
        case 'tasks':
          document.getElementById('nav-tasks')?.classList.add('active');
          w.taskManagerModule?.show();
          break;
        case 'stock':
          document.getElementById('nav-stock')?.classList.add('active');
          w.stockModule?.show();
          break;
        case 'catalog':
          document.getElementById('nav-catalog')?.classList.add('active');
          w.catalogMpModule?.show();
          break;
      }
      return;
    }

    // ── home / products: показываем стандартный layout ─────────────────────
    this.hideAllMarketplaceSections();
    if (topbarEl) topbarEl.style.display = '';

    this.resetNavActive();
    document.getElementById('nav-home')?.classList.toggle('active', page === 'home');
    document.getElementById('nav-products')?.classList.toggle('active', page === 'products');
    (window as any).ensureDockExpandedForPage?.(page);

    const sb = document.getElementById('sidebar-boxes-section');
    const filterPanel = document.getElementById('filter-panel');
    const tableHeader = document.querySelector<HTMLElement>('.table-header');
    const tb = document.querySelector<HTMLElement>('.topbar');
    const cnt = document.querySelector<HTMLElement>('.content');

    if (page === 'home') {
      if (sb) sb.style.display = 'none';
      if (filterPanel) filterPanel.style.display = 'none';
      if (tableHeader) tableHeader.style.display = 'none';
      if (tb) tb.style.display = 'none';
      if (cnt) cnt.style.display = '';
      if (groupsBar) groupsBar.style.display = 'none';
      this.renderDashboard();
      this.updateResultStat();
    } else {
      if (sb) sb.style.display = 'none';
      if (filterPanel) filterPanel.style.display = '';
      if (tableHeader) tableHeader.style.display = '';
      if (tb) tb.style.display = '';
      if (cnt) cnt.style.display = '';
      if (groupsBar) groupsBar.style.display = 'flex';
      this.renderBoxes();
      if (loadAll) {
        // Coming from nav button: reset box selection and show ALL products
        this.activeBoxId = null;
        this.searchQ = '';
        const inp = document.getElementById('search-inp') as HTMLInputElement;
        if (inp) inp.value = '';
        const addBtn = document.getElementById('add-product-btn');
        if (addBtn) addBtn.style.display = 'none';
        this.renderBoxes();
        this.loadAllProducts();
      }
      // When called from selectBox/setView, those methods handle loading themselves
    }
  }

  // ── HOME DASHBOARD (delegates -> modules/HomeDashboardModule.ts) ─────────

  renderDashboard(): void { this.dashboard.renderDashboard(); }
  refreshDashboard(): void { this.dashboard.refreshDashboard(); }
  toggleHomeEdit(): void { this.dashboard.toggleHomeEdit(); }
  removeWidget(id: string): void { this.dashboard.removeWidget(id); }
  addWidget(id: string): void { this.dashboard.addWidget(id); }
  moveWidget(id: string, dir: -1 | 1): void { this.dashboard.moveWidget(id, dir); }
  resetWidgetLayout(): void { this.dashboard.resetWidgetLayout(); }
  onWidgetDragStart(e: DragEvent, id: string): void { this.dashboard.onWidgetDragStart(e, id); }
  onWidgetDragOver(e: DragEvent, el: HTMLElement, targetId: string): void { this.dashboard.onWidgetDragOver(e, el, targetId); }
  onWidgetDragLeave(el: HTMLElement): void { this.dashboard.onWidgetDragLeave(el); }
  onWidgetDragEnd(): void { this.dashboard.onWidgetDragEnd(); }
  onWidgetDrop(e: DragEvent, targetId: string): void { this.dashboard.onWidgetDrop(e, targetId); }
  onWidgetResizeStart(e: MouseEvent | TouchEvent, id: string): void { this.dashboard.onWidgetResizeStart(e, id); }
  openWidgetPicker(): void { this.dashboard.openWidgetPicker(); }
  async viewProductFromDash(productId: string, boxId: string) { return this.dashboard.viewProductFromDash(productId, boxId); }

  // ── MASS ACTIONS (delegates -> modules/MassActionsModule.ts) ─────────────

  massDeleteProducts(): void { this.massActions.massDeleteProducts(); }
  async doMassDelete() { return this.massActions.doMassDelete(); }
  massHideProducts(hide: boolean): void { this.massActions.massHideProducts(hide); }
  massMoveProducts(): void { this.massActions.massMoveProducts(); }
  async doMassMove() { return this.massActions.doMassMove(); }
  openMassEditModal(): void { this.massActions.openMassEditModal(); }
  async doMassEditSave() { return this.massActions.doMassEditSave(); }

  // ── MP CATALOG SYNC (delegates -> modules/MassActionsModule.ts) ───────────

  async openMpSyncModal() { return this.massActions.openMpSyncModal(); }
  async runMpSync(source: 'ozon' | 'ym' | 'wb', storeId: string, btn: HTMLButtonElement) { return this.massActions.runMpSync(source, storeId, btn); }
  async clearWbCooldownAndSync(source: 'ozon' | 'ym' | 'wb', storeId: string, btn: HTMLButtonElement) { return this.massActions.clearWbCooldownAndSync(source, storeId, btn); }


  // ─────────────────────────────────────────────────────────────────────────
  // ДОБАВИТЬ НОВЫЙ РЯД (кастомное поле)
  // ─────────────────────────────────────────────────────────────────────────

  openAddFieldModal() {
    // Открываем unified column manager с фокусом на форме добавления
    this.openColPickerModal();
    setTimeout(() => {
      (document.getElementById('cm-label') as HTMLInputElement)?.focus();
    }, 100);
  }

  // ── МАССОВОЕ ЗАПОЛНЕНИЕ КОЛОНКИ (delegates -> modules/MassActionsModule.ts) ─

  openMassFillModal(): void { this.massActions.openMassFillModal(); }
  async applyMassFill() { return this.massActions.applyMassFill(); }
}
