import { debug } from '@/utils/debug';
import { Product } from './types';
import { boxes, boxActions } from './stores/appStore';
import { apiService } from './services/api';
import { idbCache } from './services/idbCache';
import { esc as escHtml, productSuffix, escapeRegex } from './utils/format';
import { customColumnsDb } from './services/customColumnsDb';
import { costPriceDb } from './services/costPriceDb';
import { repricerRulesDb } from './services/repricerRulesDb';
import { HomeDashboardModule } from './modules/HomeDashboardModule';
import { MassActionsModule } from './modules/MassActionsModule';
import { ExportImportModule } from './modules/ExportImportModule';
import { ProductModalModule } from './modules/ProductModalModule';
import { BoxModalsModule } from './modules/BoxModalsModule';
import { BoxMpLinkModule } from './modules/BoxMpLinkModule';
import { TableInteractionsModule } from './modules/TableInteractionsModule';
import { NavigationModule } from './modules/NavigationModule';

export class App {
  /** Главная страница — командный центр и виджеты (см. modules/HomeDashboardModule.ts). */
  private dashboard = new HomeDashboardModule(this);
  /** Массовые операции, синхронизация каталога с МП, mass fill (см. modules/MassActionsModule.ts). */
  private massActions = new MassActionsModule(this);
  /** Экспорт/импорт товаров через xlsx (см. modules/ExportImportModule.ts). */
  private exportImport = new ExportImportModule(this);
  /** Просмотр/редактирование/удаление товара, push на Ozon (см. modules/ProductModalModule.ts). */
  private productModal = new ProductModalModule(this);
  /** CRUD-модалки групп: создание, переименование, настройки, удаление (см. modules/BoxModalsModule.ts). */
  private boxModals = new BoxModalsModule(this);
  /** Привязка/синхронизация групп с Яндекс Маркет, Wildberries, Ozon-каталогом (см. modules/BoxMpLinkModule.ts). */
  private boxMpLink = new BoxMpLinkModule(this);
  /** Drag-and-drop строк/столбцов, ручное добавление товара (см. modules/TableInteractionsModule.ts). */
  private tableInteractions = new TableInteractionsModule(this);
  /** Навигация по страницам и рендер главного дашборда (см. modules/NavigationModule.ts). */
  private navigation = new NavigationModule(this);

  // ── UI state ──────────────────────────────────────────────────────────────
  allProducts: Product[] = [];
  filtered: Product[] = [];
  columns: string[] = [];
  private sortCol: string | null = null;
  private sortDir: 'asc' | 'desc' = 'asc';
  private priceSort: 'asc' | 'desc' | null = null;
  searchQ = '';
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
  columnOrder = new Map<string, string[]>();

  // ── MP presence: артикул (lowercase) → массив магазинов где найден товар
  mpPresence: Map<string, Array<{ mp: 'wb' | 'ozon' | 'yandex'; storeId: string; storeName: string; color: string }>> = new Map();

  // ── Drag-and-drop state ───────────────────────────────────────────────────
  dragFromIdx: number | null = null;
  dragColIdx: number | null = null;

  async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Скопировано: ' + text, 'success', 1500);
    } catch (err) {
      this.toast('Ошибка при копировании', 'error');
    }
  }

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
  pendingDelete: { boxId?: string; col?: string; prodId?: string; art?: string } | null = null;
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
    } catch (e) { debug.warn('[App] swallowed error', e); }
    // Restore visible cols from localStorage
    try {
      const vc = JSON.parse(localStorage.getItem('app_visible_cols') || 'null');
      if (Array.isArray(vc)) this.visibleCols = new Set(vc);
    } catch (e) { debug.warn('[App] swallowed error', e); }
    // Restore column order from localStorage
    try {
      const co = JSON.parse(localStorage.getItem('app_column_order') || '{}');
      for (const [bid, cols] of Object.entries(co)) {
        this.columnOrder.set(bid, cols as string[]);
      }
    } catch (e) { debug.warn('[App] swallowed error', e); }

    const list = document.getElementById('boxes-list');
    if (list) list.innerHTML = this.skeletonBoxes(4);
    // Open IDB (non-blocking, failures are ignored)
    idbCache.open().catch((e) => debug.warn('[App] swallowed error', e));
    // Pre-fill repricer rules cache so product cards show correct rule status
    repricerRulesDb.refresh().catch((e) => debug.warn('[App] swallowed error', e));

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

  async loadBoxCount(boxId: string) {
    try {
      const count = await apiService.getBoxCount(boxId);
      const el = document.getElementById(`bc-${boxId}`);
      if (el) el.textContent = `${count} товар${this.suf(count)}`;
    } catch (e) { debug.warn('[App] swallowed error', e); }
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

  async loadAllProducts() {
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
    this.refreshMpPresence().catch((e) => debug.warn('[App] swallowed error', e));

    // Авто-обновление API-групп если прошло >30 минут с последней синхронизации
    const box = boxes.get().find(b => b.id === id);
    if (box?.mp_source && box.mp_store_id) {
      const lastSync = box.mp_last_sync ? new Date(box.mp_last_sync).getTime() : 0;
      const thirtyMin = 30 * 60 * 1000;
      if (Date.now() - lastSync > thirtyMin) {
        // Фоновое обновление без блокировки UI
        setTimeout(() => this.refreshMpBox(id).catch((e) => debug.warn('[App] swallowed error', e)), 800);
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
      idbCache.set(id, accumulated).catch((e) => debug.warn('[App] swallowed error', e));
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
    }, sig).catch((e) => debug.warn('[App] swallowed error', e));
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
        idbCache.set(b.id, acc).catch((e) => debug.warn('[App] swallowed error', e));
        const el = document.getElementById(`bc-${b.id}`);
        if (el) el.textContent = `${acc.length} товар${this.suf(acc.length)}`;
        // Refresh dashboard again after network data arrives
        if (this.currentPage === 'home') {
          this.renderDashboard();
        }
      }).catch((e) => debug.warn('[App] swallowed error', e));
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
      Promise.all(toSave.map(p => apiService.updateProduct(p.id, { data: p.data }))).catch((e) => debug.warn('[App] swallowed error', e));
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
          } catch (e) { debug.warn('[App] swallowed error', e); }
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
      window.settingsHub?.init?.();
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
          try { ozonMappedCols = new Set(JSON.parse(mappedStr)); } catch (e) { debug.warn('[App] swallowed error', e); }
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
    if (this.selectedProducts.has(id)) {
      this.selectedProducts.delete(id);
    } else {
      this.selectedProducts.add(id);
    }

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

  // ── PRODUCT MODAL (delegates -> modules/ProductModalModule.ts) ───────────

  viewProduct(id: string, mode: 'view' | 'edit' = 'view') { return this.productModal.viewProduct(id, mode); }
  onPhotoUrlInput(inp: HTMLInputElement, idx: number) { return this.productModal.onPhotoUrlInput(inp, idx); }
  async onPhotoFileChosen(input: HTMLInputElement, fieldKey: string, productId: string, idx: number) { return this.productModal.onPhotoFileChosen(input, fieldKey, productId, idx); }
  addNewFieldToEdit() { return this.productModal.addNewFieldToEdit(); }
  /** @deprecated — используй viewProduct(id, 'edit') */
  openEditProduct(id: string) { return this.productModal.openEditProduct(id); }
  async saveProduct(id: string) { return this.productModal.saveProduct(id); }
  async pushProductToOzon(productId: string, data: Record<string, string>, box: import('./types').Box) { return this.productModal.pushProductToOzon(productId, data, box); }
  confirmDeleteProduct(id: string, art: string) { return this.productModal.confirmDeleteProduct(id, art); }
  async deleteProduct(id: string) { return this.productModal.deleteProduct(id); }

  // ── BOX MODALS — CREATE/RENAME/SETTINGS (delegates -> modules/BoxModalsModule.ts) ──

  openNewBoxModal() { return this.boxModals.openNewBoxModal(); }
  async createBox() { return this.boxModals.createBox(); }
  renameBox(id: string, currentName: string) { return this.boxModals.renameBox(id, currentName); }
  openNativeEmojiPicker() { return this.boxModals.openNativeEmojiPicker(); }
  onEmojiInputChange(inp: HTMLInputElement) { return this.boxModals.onEmojiInputChange(inp); }
  selectSticker(emoji: string, _keepOpen?: boolean) { return this.boxModals.selectSticker(emoji, _keepOpen); }
  async doRenameBox(id: string) { return this.boxModals.doRenameBox(id); }
  openBoxSettings(id: string, _tab?: string) { return this.boxModals.openBoxSettings(id, _tab); }
  bsSwitchTab(boxId: string, tab: 'main' | 'marketplaces' | 'columns' | 'products' | 'data'): void { return this.boxModals.bsSwitchTab(boxId, tab); }
  filterBsProducts(query: string): void { return this.boxModals.filterBsProducts(query); }
  resetColumnOrder(boxId: string): void { return this.boxModals.resetColumnOrder(boxId); }
  bsSelectSticker(emoji: string) { return this.boxModals.bsSelectSticker(emoji); }
  async saveBoxSettings(id: string) { return this.boxModals.saveBoxSettings(id); }
  async linkBoxToOzon(boxId: string) { return this.boxModals.linkBoxToOzon(boxId); }
  async unlinkBoxFromOzon(boxId: string) { return this.boxModals.unlinkBoxFromOzon(boxId); }


  // ── LINK/SYNC YM/WB/Ozon (delegates -> modules/BoxMpLinkModule.ts) ────────

  async linkBoxToYM(boxId: string) { return this.boxMpLink.linkBoxToYM(boxId); }
  async unlinkBoxFromYM(boxId: string) { return this.boxMpLink.unlinkBoxFromYM(boxId); }
  async syncLinkedBoxYM(boxId: string) { return this.boxMpLink.syncLinkedBoxYM(boxId); }
  async linkBoxToWB(boxId: string) { return this.boxMpLink.linkBoxToWB(boxId); }
  async unlinkBoxFromWB(boxId: string) { return this.boxMpLink.unlinkBoxFromWB(boxId); }
  async syncLinkedBoxWB(boxId: string) { return this.boxMpLink.syncLinkedBoxWB(boxId); }
  async toggleSyncDisabled(prodId: string, mp: 'ym' | 'wb') { return this.boxMpLink.toggleSyncDisabled(prodId, mp); }
  async syncLinkedBox(boxId: string) { return this.boxMpLink.syncLinkedBox(boxId); }


  // ── BOX MODALS — EDIT/DELETE (delegates -> modules/BoxModalsModule.ts) ────

  editBox(id: string) { return this.boxModals.editBox(id); }
  deleteBoxRow(boxId: string, col: string) { return this.boxModals.deleteBoxRow(boxId, col); }
  async doDeleteBoxRow() { return this.boxModals.doDeleteBoxRow(); }
  deleteProductFromBox(boxId: string, prodId: string, art: string) { return this.boxModals.deleteProductFromBox(boxId, prodId, art); }
  async doDeleteProductFromBox() { return this.boxModals.doDeleteProductFromBox(); }
  deleteBox(id: string, name: string) { return this.boxModals.deleteBox(id, name); }
  async doDeleteBox(id: string) { return this.boxModals.doDeleteBox(id); }


  // ── EXPORT / IMPORT (delegates -> modules/ExportImportModule.ts) ─────────

  openExportModal(onlySelected = false) { return this.exportImport.openExportModal(onlySelected); }
  updateExportCount() { return this.exportImport.updateExportCount(); }
  toggleAllExportCols(on: boolean) { return this.exportImport.toggleAllExportCols(on); }
  toggleAllExportRows(on: boolean) { return this.exportImport.toggleAllExportRows(on); }
  doExport() { return this.exportImport.doExport(); }
  async doExportOriginalOzon() { return this.exportImport.doExportOriginalOzon(); }

  openImportModal() { return this.exportImport.openImportModal(); }
  updateImportHint() { return this.exportImport.updateImportHint(); }
  onFileChosen(inp: HTMLInputElement) { return this.exportImport.onFileChosen(inp); }
  updateImportCount() { return this.exportImport.updateImportCount(); }
  toggleAllCols(on: boolean) { return this.exportImport.toggleAllCols(on); }
  toggleAllRows(on: boolean) { return this.exportImport.toggleAllRows(on); }
  async doImport() { return this.exportImport.doImport(); }
  async confirmImportWithNewColumns(mode: 'all' | 'existing_only') { return this.exportImport.confirmImportWithNewColumns(mode); }

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

  // ── TABLE INTERACTIONS: drag-drop, column reorder, manual add (delegates -> modules/TableInteractionsModule.ts) ──

  onRowDragStart(idx: number) { return this.tableInteractions.onRowDragStart(idx); }
  onRowDragOver(el: HTMLElement, _idx: number) { return this.tableInteractions.onRowDragOver(el, _idx); }
  onRowDragLeave(el: HTMLElement) { return this.tableInteractions.onRowDragLeave(el); }
  onRowDrop(idx: number) { return this.tableInteractions.onRowDrop(idx); }
  onColDragStart(e: DragEvent, idx: number) { return this.tableInteractions.onColDragStart(e, idx); }
  onColDragOver(e: DragEvent, el: HTMLElement) { return this.tableInteractions.onColDragOver(e, el); }
  onColDragLeave(el: HTMLElement) { return this.tableInteractions.onColDragLeave(el); }
  onColDrop(e: DragEvent, toIdx: number) { return this.tableInteractions.onColDrop(e, toIdx); }
  onColDragEnd() { return this.tableInteractions.onColDragEnd(); }
  openAddProductModal() { return this.tableInteractions.openAddProductModal(); }
  async saveNewProduct() { return this.tableInteractions.saveNewProduct(); }


  // ── EXPORT ALL (delegates -> modules/ExportImportModule.ts) ──────────────

  exportAllToExcel() { return this.exportImport.exportAllToExcel(); }
  openExportModalAll() { return this.exportImport.openExportModalAll(); }
  doExportAll() { return this.exportImport.doExportAll(); }

  // ── NAVIGATION & DASHBOARD (delegates -> modules/NavigationModule.ts) ────

  getActiveGroupOffers(): Array<{ offer_id: string; name: string; box_name: string }> { return this.navigation.getActiveGroupOffers(); }
  getActiveGroupName(): string | null { return this.navigation.getActiveGroupName(); }
  toggleMarketplaces() { return this.navigation.toggleMarketplaces(); }
  toggleOrders() { return this.navigation.toggleOrders(); }
  async navigateTo(
    page: 'home' | 'products' | 'analytics' | 'settings-hub' | 'settings' | 'profile' | 'orders' | 'marketplaces'
        | 'ozon' | 'yandex' | 'wb'
        | 'orders-ozon' | 'orders-yandex' | 'orders-wb'
        | 'repricer' | 'stock' | 'catalog'
        | 'sku-audit' | 'reviews' | 'chats' | 'logs' | 'automation' | 'tasks',
    opts: { loadAll?: boolean } = {},
  ) { return this.navigation.navigateTo(page, opts); }


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
