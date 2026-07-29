/**
 * AnalyticsModule v2 — оркестратор.
 * Источник истины по финансам: mp_transactions (точные цифры от МП).
 * Источник истины по статусам: live-заказы (Ozon/WB/ЯМ API).
 * Себестоимость — costPriceDb (вручную). Налог — settings + store.
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { Mp, MP_LABEL, MP_COLOR, Order, KPI, TimeseriesPoint, PeriodPreset, StoreInfo, TaxModel } from './types';
import { aggregateOrders, ProductMap } from './services/orderAggregator';
import { buildCogsResolver } from './services/cogsResolver';
import { computeKPI, computeTimeseries, computeMissingCogs, MissingCogsItem } from './services/kpiAggregator';
import { loadAllStores, buildProductMap, loadOrders, loadTransactions, QueryProgress } from './services/dataLoader';
import { settingsDb } from './services/settingsDb';
import { financeSync } from '@/services/financeSync';
import { orderSyncService, OrderSyncStatus } from '@/services/orderSyncService';
import { costPriceDb } from '@/services/costPriceDb';

import { renderSummaryTab, clearSummaryCache } from './tabs/SummaryTab';
import { renderOrdersTab, OrdersFilters, clearOrdersCache } from './tabs/OrdersTab';
import { renderProductsTab, ProductsFilters, clearProductsCache } from './tabs/ProductsTab';
import { renderActivityTab, ActivitySubTab } from './tabs/ActivityTab';
import { renderBalanceTab, StoreBalance } from './tabs/BalanceTab';
import { renderOrderDrawer } from './components/OrderDetailDrawer';
import { renderSettingsDrawer } from './components/SettingsDrawer';
import { fmtNum } from './components/format';

import './styles/analytics.css';

function escapeHtmlJson(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Tab = 'summary' | 'orders' | 'products' | 'activity' | 'balance';

export class AnalyticsModule {
  private container: HTMLElement;
  private tab: Tab = 'summary';

  private period: PeriodPreset = '30';
  private customFrom = '';
  private customTo = '';

  private stores: StoreInfo[] = [];
  /** Выбранный магазин (один или «все» = null). Single-select внутри МП. */
  private selectedStore: string | null = null;
  /** @deprecated use selectedStore */
  private selectedStores = new Set<string>();
  /** Активный маркетплейс. Всегда ровно один — «все МП» больше нельзя. */
  private selectedMp: Mp = (() => {
    try {
      const saved = localStorage.getItem('an2_selected_mp');
      if (saved === 'ozon' || saved === 'wb' || saved === 'yandex') return saved;
    } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
    return 'ozon';
  })();

  private orders: Order[] = [];
  private prevOrders: Order[] = [];
  private kpi: KPI | null = null;
  private prevKpi: KPI | null = null;
  private ts: TimeseriesPoint[] = [];

  private loading = false;
  private syncing = false;
  private dataLoaded = false;

  // ── Прогресс загрузки ────────────────────────────────────────────────
  private _loadProgress: QueryProgress | null = null;
  private _loadSummary: QueryProgress | null = null;
  private _loadStart = 0;
  private _loadElapsedMs = 0;
  private _loadTimer = 0;
  private _syncStatus: OrderSyncStatus = orderSyncService.status;

  // ── «С начала» — поиск даты и подтверждение ─────────────────────────
  /** idle → seeking → confirming → syncing → loaded */
  private _allState: 'idle' | 'seeking' | 'confirming' | 'syncing' | 'loaded' = 'idle';
  private _allFrom: Date | null = null;
  /** Текущий прогресс синхронизации (показывается во время 'syncing'). */
  private _allSyncMsg  = '';
  private _allSyncStep = 0;
  private _allSyncTotal = 0;
  /** Авто-синхронизация: per-period antispam (ключ = period+stores hash → timestamp).
   *  Не дёргаем sync чаще раза в 10 минут для одного и того же среза. */
  /** Один срез синкаем максимум один раз за сессию — защита от рекурсии. */
  private _autoSyncTriedThisSession = new Set<string>();
  /** Активен ли фоновый авто-sync прямо сейчас. */
  private _autoSyncing = false;
  private missingCogs: MissingCogsItem[] = [];
  /** Lowercased vendor_code'ы из каталога — для фильтрации missing COGS. */
  private knownVendorCodes: Set<string> = new Set();

  // ── Render performance ───────────────────────────────────────────────
  /** RAF handle — batches rapid render() calls into one frame. */
  private _raf = 0;
  /** Pending full render flag (vs body-only). */
  private _pendingFull = true;
  /** Debounce timer for search input. */
  private _searchTimer = 0;

  private ordersFilters: OrdersFilters = { status: 'all', mp: 'all', search: '', page: 0 };
  private productsFilters: ProductsFilters = { sort: 'profit', search: '' };
  private activitySubTab: ActivitySubTab = 'heatmap';

  // ── Balance tab ──────────────────────────────────────────────────────
  private _balances: StoreBalance[] = [];
  private _balanceLoaded = false;

  private openedOrderId: string | null = null;
  private settingsOpen = false;

  constructor(container: HTMLElement) {
    this.container = container;
    // Подписываемся на статус фонового синка — обновляем бейдж в шапке
    orderSyncService.onStatus(s => {
      this._syncStatus = s;
      if (!this.loading) this._scheduleBodyOnly();
    });
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    if (!this.dataLoaded) {
      this.stores = await loadAllStores();
      this.render();
      this.refresh();
    } else {
      this.render();
    }
  }

  hide(): void { this.container.style.display = 'none'; }

  // ── Период ────────────────────────────────────────────────────────────
  private getRange(): { start: Date; end: Date } {
    if (this.period === 'custom' && this.customFrom && this.customTo) {
      const start = new Date(this.customFrom + 'T00:00:00.000Z');
      const end   = new Date(this.customTo   + 'T23:59:59.999Z');
      return { start, end };
    }
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    if (this.period === 'all') {
      const start = this._allFrom
        ? new Date(this._allFrom)
        : new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
      start.setUTCHours(0, 0, 0, 0);
      return { start, end };
    }
    const days = parseInt(this.period) || 30;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    return { start, end };
  }

  private getPrevRange(): { start: Date; end: Date } {
    const r = this.getRange();
    const duration = r.end.getTime() - r.start.getTime();
    return {
      start: new Date(r.start.getTime() - duration - 1),
      end: new Date(r.start.getTime() - 1),
    };
  }

  private getFilteredStoreIds(): Set<string> {
    let pool = this.stores.filter(s => s.mp === this.selectedMp);
    if (this.selectedStore) pool = pool.filter(s => s.id === this.selectedStore);
    return new Set(pool.map(s => s.id));
  }

  // ── Загрузка данных ──────────────────────────────────────────────────
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this._loadProgress = null;
    this._loadStart = Date.now();
    // Таймер обновляет отображение прошедшего времени каждые 500мс
    if (this._loadTimer) clearInterval(this._loadTimer);
    this._loadTimer = window.setInterval(() => {
      if (this.loading && !this.dataLoaded) this._scheduleBodyOnly();
      else { clearInterval(this._loadTimer); this._loadTimer = 0; }
    }, 500);
    this.render();
    try {
      const storeIds = this.getFilteredStoreIds();
      const { start, end } = this.getRange();
      // Ждём актуальных данных из Supabase перед построением резолвера.
      // Без await — кэш может быть пустым если аналитика открыта сразу после входа.
      await costPriceDb.refresh();
      const cogs = buildCogsResolver();
      const products = await buildProductMap();

      // Колбэк прогресса: дебаунс через rAF чтобы не флудить ре-рендерами
      let _rafProgress = 0;
      const onProgress = (p: QueryProgress) => {
        this._loadProgress = p;
        if (!_rafProgress) {
          _rafProgress = requestAnimationFrame(() => {
            _rafProgress = 0;
            if (this.loading && !this.dataLoaded) this._scheduleBodyOnly();
          });
        }
      };

      const [liveOrders, txs] = await Promise.all([
        loadOrders(start, end, storeIds, undefined, onProgress),
        loadTransactions([...storeIds], start, end),
      ]);

      const filteredStores = this.stores.filter(s => storeIds.has(s.id));
      this.orders = aggregateOrders({
        ozonPostings: liveOrders.ozonPostings,
        yandexOrders: liveOrders.yandexOrders,
        wbOrders: liveOrders.wbOrders,
        transactions: txs,
        stores: filteredStores,
        products,
        cogs,
      });
      this.kpi = computeKPI(this.orders);
      this.ts  = computeTimeseries(this.orders, start, end);
      // Каталожные vendor_code (нормализованные) — чтобы missing COGS показывал только
      // те артикулы, которые пользователь реально может найти в Репрайсере.
      const knownVc = new Set<string>();
      for (const info of products.values()) {
        const vc = info.vendor_code?.trim().toLowerCase();
        if (vc) knownVc.add(vc);
      }
      this.knownVendorCodes = knownVc;
      this.missingCogs = computeMissingCogs(this.orders, knownVc);
      this.dataLoaded = true;
      this._loadElapsedMs = Date.now() - this._loadStart;
      this._loadSummary   = this._loadProgress ? Object.assign({}, this._loadProgress) : null;
      // Новые данные → инвалидируем все кеши вкладок
      clearSummaryCache();
      clearOrdersCache();
      clearProductsCache();
      this.render();

      // Сравнение с прошлым периодом — фоновая загрузка
      this.loadPrev(filteredStores, products, cogs);

      // Авто-синхронизация финотчёта если покрытие низкое (< 60%)
      // и в этом срезе давно не синкали (> 10 минут).
      this._maybeAutoSync(start, end, storeIds);
    } catch (e: unknown) {
      console.error('[Analytics] refresh:', e);
    } finally {
      this.loading = false;
      if (this._loadTimer) { clearInterval(this._loadTimer); this._loadTimer = 0; }
      this.render();
    }
  }

  private async loadPrev(stores: StoreInfo[], products: ProductMap, cogs: ReturnType<typeof buildCogsResolver>): Promise<void> {
    try {
      const { start, end } = this.getPrevRange();
      const storeIds = new Set(stores.map(s => s.id));
      const [liveOrders, txs] = await Promise.all([
        loadOrders(start, end, storeIds),
        loadTransactions([...storeIds], start, end),
      ]);
      this.prevOrders = aggregateOrders({
        ozonPostings: liveOrders.ozonPostings,
        yandexOrders: liveOrders.yandexOrders,
        wbOrders: liveOrders.wbOrders,
        transactions: txs, stores, products, cogs,
      });
      this.prevKpi = computeKPI(this.prevOrders);
      clearSummaryCache();
      this.render();
    } catch (e) { console.warn('[Analytics] prev:', e); }
  }

  /** Авто-фоновая синхронизация финотчёта, если покрытие низкое.
   *  Не блокирует UI, не показывает loader — только маленький badge "syncing".
   *  Защиты:
   *   - не запускается для периодов > 90 дней (слишком тяжёлый sync, ловит таймауты)
   *   - анти-спам: один срез синкаем не чаще раза в 30 минут (cache в localStorage,
   *     не теряется при reload — главная причина прошлого зацикливания)
   *   - флаг _autoSyncTriedThisSession — попытка только один раз за сессию для каждого среза
   */
  private async _maybeAutoSync(start: Date, end: Date, storeIds: Set<string>): Promise<void> {
    if (this._autoSyncing || this.syncing) return;
    if (!this.kpi) return;
    if (storeIds.size === 0) return; // no stores for selected MP → nothing to sync

    // Allow auto-sync when orders.length === 0 (new user, or all API calls failed).
    // Finance sync creates orphan-transactions which produce orders even without live API.
    const coverage = this.orders.length > 0 ? this.kpi.source_real_pct : 0;
    if (this.orders.length > 0 && coverage >= 60) return;

    const spanDays = (end.getTime() - start.getTime()) / 86400_000;
    if (spanDays > 90) {
      console.info(`[Analytics] auto-sync skipped: period too long (${Math.round(spanDays)}d > 90d). Use manual "↻ Sync" button.`);
      return;
    }

    const key = `${start.toISOString().slice(0,10)}_${end.toISOString().slice(0,10)}_${[...storeIds].sort().join(',')}`;

    // Анти-спам в памяти: один раз за сессию
    if (this._autoSyncTriedThisSession.has(key)) return;
    this._autoSyncTriedThisSession.add(key);

    // Анти-спам в localStorage: 30 мин
    try {
      const lsKey = 'an2_autosync_v1';
      const cache: Record<string, number> = JSON.parse(localStorage.getItem(lsKey) ?? '{}');
      const last = cache[key] ?? 0;
      if (Date.now() - last < 30 * 60 * 1000) {
        console.info(`[Analytics] auto-sync skipped: synced recently (${Math.round((Date.now() - last) / 60000)} min ago)`);
        return;
      }
      cache[key] = Date.now();
      // GC: оставляем только последние 50 записей
      const entries = Object.entries(cache).sort((a, b) => b[1] - a[1]).slice(0, 50);
      localStorage.setItem(lsKey, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }

    this._autoSyncing = true;
    this.render();
    try {
      console.info(`[Analytics] auto-sync: coverage ${coverage.toFixed(0)}% — pulling finance reports for ${start.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}`);
      await financeSync.syncAll(start.toISOString(), end.toISOString());
      this._autoSyncing = false;
      // Перезагружаем заказы/tx, но БЕЗ повторного auto-sync (помечено в кеше выше)
      await this.refresh();
    } catch (e) {
      console.warn('[Analytics] auto-sync failed:', e);
      this._autoSyncing = false;
      this.render();
    }
  }

  async syncFinances(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.render();
    try {
      const { start, end } = this.getRange();
      await financeSync.syncAll(start.toISOString(), end.toISOString());
      await this.refresh();
    } catch (e) {
      console.error('[Analytics] sync:', e);
    } finally {
      this.syncing = false;
      this.render();
    }
  }

  // ── Публичные методы (биндятся к window.analyticsModule) ─────────────

  setTab(t: Tab): void {
    if (this.tab === t) return;
    this.tab = t;
    // Тап-active класс в шапке — обновляем точечно, body перерисовываем
    const tabs = this.container.querySelectorAll<HTMLElement>('.an2-tab');
    tabs.forEach(el => {
      const isActive = el.getAttribute('onclick')?.includes(`'${t}'`);
      el.classList.toggle('active', !!isActive);
    });
    if (t === 'balance' && !this._balanceLoaded) this._loadBalances();
    this._scheduleBodyOnly();
  }

  private async _loadBalances(): Promise<void> {
    const { ozonDb } = await import('@/services/ozonDb');
    const { wbDb }   = await import('@/services/wbDb');
    const { ozonFinanceApi } = await import('@/services/ozonFinanceApi');
    const { wbFinanceApi }   = await import('@/services/wbFinanceApi');

    const [ozStores, wbStores] = await Promise.all([
      ozonDb.getStores().catch(() => []),
      wbDb.getStores().catch(()   => []),
    ]);

    // Инициализируем — все в состоянии loading
    this._balances = [
      ...ozStores.map(s => ({ storeId: s.id, storeName: s.name, mp: 'ozon' as const, loading: true, error: null })),
      ...wbStores.map(s => ({ storeId: s.id, storeName: s.name, mp: 'wb'   as const, loading: true, error: null })),
    ];
    this._scheduleBodyOnly();

    // Загружаем параллельно
    const updates = await Promise.all([
      ...ozStores.map(async (s): Promise<StoreBalance> => {
        try {
          const t = await ozonFinanceApi.fetchTreasuryTotals({ client_id: s.client_id, api_key: s.api_key });
          return { storeId: s.id, storeName: s.name, mp: 'ozon', loading: false, error: null, ...t };
        } catch (e: any) {
          return { storeId: s.id, storeName: s.name, mp: 'ozon', loading: false, error: e?.message ?? 'Ошибка' };
        }
      }),
      ...wbStores.map(async (s): Promise<StoreBalance> => {
        try {
          const r = await wbFinanceApi.fetchWeeklyAccruals(s.api_key);
          return { storeId: s.id, storeName: s.name, mp: 'wb', loading: false, error: null, ...r };
        } catch (e: any) {
          return { storeId: s.id, storeName: s.name, mp: 'wb', loading: false, error: e?.message ?? 'Ошибка' };
        }
      }),
    ]);

    this._balances = updates;
    this._balanceLoaded = true;
    this._scheduleBodyOnly();
  }

  /** Сбросить кеш баланса и перезагрузить. */
  refreshBalances(): void {
    this._balanceLoaded = false;
    this._balances = [];
    this._loadBalances();
  }

  setPeriod(p: string): void {
    if (p !== 'all') {
      // Сбрасываем состояние «С начала» при переходе на другой период
      this._allState = 'idle';
      this._allFrom  = null;
    }
    this.period = p as PeriodPreset;
    if (p === 'all') {
      if (this._allState === 'idle') {
        this._seekAllFrom(); // ищем дату — не вызываем refresh сразу
      } else if (this._allState === 'loaded') {
        this.refresh();
      } else {
        this.render(); // 'seeking' или 'confirming' — просто рендерим текущее состояние
      }
      return;
    }
    if (p !== 'custom') this.refresh();
    else this.render();
  }

  /** Ищем самую раннюю дату для «С начала»: min(store.created_at, first transaction). */
  private async _seekAllFrom(): Promise<void> {
    this._allState = 'seeking';
    this.render();
    try {
      const store = this.stores.find(s => s.id === this.selectedStore);
      let earliest: Date | null = null;

      // 1. Дата создания магазина
      if (store?.created_at) {
        const d = new Date(store.created_at);
        if (!isNaN(d.getTime())) earliest = d;
      }

      // 2. Дата первой транзакции
      const storeIds = [...this.getFilteredStoreIds()];
      const { mpTransactionsDb } = await import('@/services/mpTransactionsDb');
      for (const id of storeIds) {
        try {
          const txDate = await mpTransactionsDb.getEarliestDate(id);
          if (txDate) {
            const d = new Date(txDate);
            if (!isNaN(d.getTime()) && (!earliest || d < earliest)) earliest = d;
          }
        } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
      }

      if (earliest) { earliest.setUTCHours(0, 0, 0, 0); }
      this._allFrom  = earliest;
      this._allState = 'confirming';
    } catch (e) {
      console.warn('[Analytics] _seekAllFrom:', e);
      this._allState = 'confirming'; // покажем диалог с дефолтной датой
    }
    this.render();
  }

  /** Пользователь подтвердил загрузку истории — запускаем полный синк финотчёта. */
  async confirmAllPeriodLoad(): Promise<void> {
    if (!this._allFrom) { this._allState = 'loaded'; this.refresh(); return; }

    this._allState = 'syncing';
    this._allSyncMsg  = 'Начинаем синхронизацию…';
    this._allSyncStep = 0;
    this.render();

    const start = new Date(this._allFrom);
    const end   = new Date();
    end.setUTCHours(23, 59, 59, 999);

    // Батчи по 90 дней — финансовые отчёты МП обычно доступны за 3+ года
    const BATCH_MS = 90 * 86_400_000;
    const batches: Array<{ s: Date; e: Date }> = [];
    let s = new Date(start);
    while (s < end) {
      const e = new Date(Math.min(s.getTime() + BATCH_MS, end.getTime()));
      batches.push({ s: new Date(s), e });
      s = new Date(e.getTime() + 1);
    }
    this._allSyncTotal = batches.length;

    for (let i = 0; i < batches.length; i++) {
      const { s: bs, e: be } = batches[i];
      this._allSyncStep = i + 1;
      const label = bs.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      this._allSyncMsg = `Синхронизируем ${label}…`;
      this.render();
      try {
        await financeSync.syncAll(bs.toISOString(), be.toISOString());
      } catch (e) {
        console.warn('[Analytics] syncAll batch failed:', e);
      }
    }

    // После синка перечитываем реальную дату начала из mp_transactions
    // (до синка таблица была пустой и дата была неточной)
    this._allSyncMsg = 'Определяем период…';
    this.render();
    try {
      const { mpTransactionsDb } = await import('@/services/mpTransactionsDb');
      const storeIds = [...this.getFilteredStoreIds()];
      let earliest: Date | null = null;
      for (const id of storeIds) {
        const txDate = await mpTransactionsDb.getEarliestDate(id).catch(() => null);
        if (txDate) {
          const d = new Date(txDate);
          if (!isNaN(d.getTime()) && (!earliest || d < earliest)) earliest = d;
        }
      }
      if (earliest) {
        earliest.setUTCHours(0, 0, 0, 0);
        this._allFrom = earliest;
      }
    } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }

    this._allState    = 'loaded';
    this._allSyncMsg  = '';
    this._allSyncStep = 0;
    this._allSyncTotal = 0;
    this.dataLoaded   = false;
    await this.refresh();
  }

  /** Пользователь отменил — возвращаем на 30д. */
  cancelAllPeriod(): void {
    this._allState = 'idle';
    this._allFrom  = null;
    this.period    = '30';
    this.refresh();
  }

  setCustomDate(which: 'from' | 'to', val: string): void {
    if (which === 'from') this.customFrom = val; else this.customTo = val;
    if (this.customFrom && this.customTo) this.refresh();
  }

  /** Выбрать магазин (обязательный single-select). Повторный клик игнорируется — магазин всегда должен быть выбран. */
  selectStore(id: string): void {
    if (!id || this.selectedStore === id) return;
    this.selectedStore = id;
    this._allState = 'idle';
    this._allFrom  = null;
    this.refresh();
  }

  /** @deprecated use selectStore */
  toggleStore(id: string): void { this.selectStore(id); }

  toggleMp(mp: Mp): void { this.selectMp(mp); }

  /** Single-select: маркетплейсы не пересекаются. Всегда ровно один активен.
   *  Параметр 'all' игнорируем — режима «все МП» больше нет. */
  selectMp(mp: Mp | 'all'): void {
    if (mp === 'all') return;
    if (this.selectedMp === mp) return;
    this.selectedMp = mp;
    try { localStorage.setItem('an2_selected_mp', mp); } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
    this.selectedStore = null;
    this.selectedStores.clear();
    this._allState = 'idle';
    this._allFrom  = null;
    this.refresh();
  }

  setOrdersFilter(key: keyof OrdersFilters, value: string | number): void {
    (this.ordersFilters as any)[key] = key === 'page' ? Number(value) : value;
    if (key !== 'page') this.ordersFilters.page = 0;
    if (key === 'search') {
      // Debounce: не ре-рендерим на каждый символ — только через 220мс после паузы
      if (this._searchTimer) clearTimeout(this._searchTimer);
      this._searchTimer = window.setTimeout(() => {
        this._searchTimer = 0;
        this._scheduleBodyOnly();
      }, 220);
      return;
    }
    this._scheduleBodyOnly();
  }

  setProductsFilter(key: keyof ProductsFilters, value: string): void {
    (this.productsFilters as any)[key] = value;
    this._scheduleBodyOnly();
  }

  setActivitySubTab(t: ActivitySubTab): void {
    this.activitySubTab = t;
    this._scheduleBodyOnly();
  }

  openOrder(id: string): void {
    this.openedOrderId = id;
    this._mountOrderDrawer();
  }

  closeOrderDrawer(): void {
    this.openedOrderId = null;
    this._unmountOrderDrawer();
  }

  /** Монтирует drawer как отдельный DOM-узел рядом с .an2, не трогая body/header/chart.
   *  Это кардинально дешевле полного render() — нет реcборки тысяч строк OrdersTab. */
  private _mountOrderDrawer(): void {
    const root = this.container.querySelector<HTMLElement>('.an2');
    if (!root) { this.render(); return; }
    // Удаляем старый если есть
    root.querySelector('.an2-order-drawer-host')?.remove();
    // Вставляем новый
    const html = this.renderOpenOrder();
    if (!html) return;
    const host = document.createElement('div');
    host.className = 'an2-order-drawer-host';
    host.innerHTML = html;
    root.appendChild(host);
  }

  private _unmountOrderDrawer(): void {
    this.container.querySelector('.an2-order-drawer-host')?.remove();
  }

  /** Показать JSON всех финансовых транзакций по заказу — для диагностики. */
  async showOrderTxJson(orderId: string): Promise<void> {
    const order = this.orders.find(o => o.order_id === orderId);
    if (!order) return;
    try {
      const { dbFetch } = await import('@/services/dbClient');
      const txs = await dbFetch<any[]>(
        `mp_transactions?posting_number=eq.${encodeURIComponent(orderId)}&order=operation_date.asc`,
      );
      // Открываем во всплывающем окне
      const w = window.open('', '_blank', 'width=900,height=700');
      if (!w) { alert('Разрешите всплывающие окна для просмотра JSON'); return; }
      const summary = {
        order_id: orderId,
        marketplace: order.mp,
        status: order.status,
        tx_count: txs.length,
        totals_computed_by_analytics: {
          revenue: order.revenue,
          commission: order.commission,
          logistics: order.logistics,
          logistics_return: order.logistics_return,
          services: order.services,
          cogs: order.cogs,
          tax: order.tax,
          net_profit: order.net_profit,
        },
        totals_from_raw_tx: {
          accruals_for_sale: txs.reduce((s, t) => s + (t.accruals_for_sale || 0), 0),
          sale_commission_signed: txs.reduce((s, t) => s + (t.sale_commission || 0), 0),
          delivery_charge_signed: txs.reduce((s, t) => s + (t.delivery_charge || 0), 0),
          return_delivery_charge_signed: txs.reduce((s, t) => s + (t.return_delivery_charge || 0), 0),
          services_total_signed: txs.reduce((s, t) => s + (t.services_total || 0), 0),
          amount_paid_signed: txs.reduce((s, t) => s + (t.amount || 0), 0),
        },
        transactions: txs,
      };
      w.document.write(`
        <html><head><title>TX JSON · ${orderId}</title>
        <style>
          body{margin:0;padding:16px;background:#0d1117;color:#c9d1d9;font:12px/1.5 ui-monospace,SF Mono,Menlo,monospace}
          h2{color:#7ee787;margin:0 0 12px;font-size:14px}
          pre{margin:0;white-space:pre-wrap;word-break:break-word}
          .k{color:#79c0ff}.s{color:#a5d6ff}.n{color:#ff7b72}.b{color:#ffa657}
        </style></head><body>
        <h2>${I.chart()} Транзакции по заказу ${orderId}</h2>
        <pre>${escapeHtmlJson(JSON.stringify(summary, null, 2))}</pre>
        </body></html>
      `);
      w.document.close();
    } catch (e: unknown) {
      alert('Ошибка загрузки JSON: ' + ((e instanceof Error ? (e instanceof Error ? e.message : String(e)) : String(e)) ?? e));
    }
  }

  openOrdersFiltered(filter: string): void {
    this.tab = 'orders';
    if (filter === 'delivered' || filter === 'returned' || filter === 'cancelled' || filter === 'processing') {
      this.ordersFilters = { ...this.ordersFilters, status: filter as any, page: 0 };
    } else {
      // commission/logistics → просто перейти на вкладку заказов, без фильтра
      this.ordersFilters = { ...this.ordersFilters, status: 'all', page: 0 };
    }
    this.render();
  }

  openSettings(): void { this.settingsOpen = true; this.render(); }
  closeSettings(): void { this.settingsOpen = false; this.render(); }

  openCogsHint(): void {
    alert('Себестоимость задаётся в модуле «Репрайсер» → «Себестоимости» — или прямо здесь в блоке «без себестоимости».');
  }

  /** Быстрое сохранение себестоимости прямо из сводки (без перехода в Репрайсер). */
  setCostPrice(vendorCode: string, price: number): void {
    if (!vendorCode || !isFinite(price) || price < 0) return;
    costPriceDb.set(vendorCode, price);
    // Локально применяем cost к заказам — артикул сразу исчезает из списка missing
    // и KPI пересчитывается без полного refresh.
    this.orders = this.orders.map(o => {
      let cogsDelta = 0;
      const newItems = o.items.map(it => {
        if (it.vendor_code === vendorCode && it.cost_price == null) {
          const itemCogs = price * it.quantity;
          cogsDelta += itemCogs;
          return { ...it, cost_price: price, cogs: itemCogs, net_profit: it.revenue - itemCogs };
        }
        return it;
      });
      if (cogsDelta === 0) return o;
      const newCogs = o.cogs + cogsDelta;
      return {
        ...o,
        items: newItems,
        cogs: newCogs,
        net_profit: o.revenue - (o.commission + o.logistics + o.logistics_return + o.services + newCogs + o.tax),
      };
    });
    this.missingCogs = computeMissingCogs(this.orders, this.knownVendorCodes);
    this.kpi = computeKPI(this.orders);
    clearSummaryCache();
    clearOrdersCache();
    clearProductsCache();
    this.render();
    try { window.app?.toast?.(`✓ Себестоимость ${price.toLocaleString('ru')} ₽ сохранена для «${vendorCode}»`, 'success'); } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
  }

  setTax(storeId: string, field: 'model' | 'rate', value: string): void {
    const cur = settingsDb.taxFor(storeId);
    if (field === 'model') settingsDb.setStoreTax(storeId, value as TaxModel, cur.rate);
    else                   settingsDb.setStoreTax(storeId, cur.model, parseFloat(value) / 100);
    this.stores = this.stores.map(s => s.id === storeId
      ? { ...s, ...settingsDb.taxFor(storeId) }
      : s);
    this.render();
  }
  clearTax(storeId: string): void {
    settingsDb.clearStoreTax(storeId);
    loadAllStores().then(s => { this.stores = s; this.render(); });
  }
  setFx(cur: string, val: string): void {
    settingsDb.setFx(cur, parseFloat(val) || 0);
    this.render();
  }

  addManualEntry(ev: Event): void {
    const form = ev.target as HTMLFormElement;
    const fd = new FormData(form);
    const amount = parseFloat(String(fd.get('amount') ?? '0'));
    if (!amount) return;
    settingsDb.manualAdd({
      type: (fd.get('type') as any) ?? 'other_expense',
      amount, amount_native: amount, currency: 'RUB', fx_rate: 1,
      date: new Date().toISOString(),
      description: String(fd.get('description') ?? ''),
    });
    form.reset();
    this.render();
  }
  deleteManualEntry(id: string): void {
    if (!confirm('Удалить запись?')) return;
    settingsDb.manualDelete(id);
    this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────

  /** Полный ре-рендер (заголовок + тело + дроуеры). */
  render(): void {
    this._pendingFull = true;
    this._scheduleRaf();
  }

  /** Только тело (без перерисовки шапки) — для фильтров/поиска. */
  private _scheduleBodyOnly(): void {
    if (!this._pendingFull) this._scheduleRaf();
    else this.render(); // если уже ждём full — пусть full и выполнится
  }

  private _scheduleRaf(): void {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._pendingFull) {
        this._pendingFull = false;
        this._paintFull();
      } else {
        this._paintBody();
      }
    });
  }

  private _paintFull(): void {
    const busy = this.loading || this.syncing;
    const drawerHtml = this.openedOrderId ? this.renderOpenOrder() : '';
    this.container.innerHTML = `
      <div class="an2" style="position:relative">
        ${busy && this.dataLoaded ? '<div class="an2-topbar"></div>' : ''}
        ${this.renderHeader()}
        ${this.renderBody()}
        ${drawerHtml ? `<div class="an2-order-drawer-host">${drawerHtml}</div>` : ''}
        ${this.settingsOpen ? renderSettingsDrawer(this.stores, settingsDb.manualList()) : ''}
      </div>
    `;
    // Сбрасываем body-html cache, чтобы следующий _paintBody действительно перерисовался
    this._lastBodyHtml = '';
  }

  /** Обновляет только .an2-body без пересоздания шапки/дроуеров.
   *  Оптимизация: skip innerHTML если контент идентичный — браузер всё равно
   *  делает reflow/parse даже на "тот же" HTML. Экономит 50-200мс на body-repaint. */
  private _paintBody(): void {
    const root = this.container.querySelector<HTMLElement>('.an2');
    const body = this.container.querySelector<HTMLElement>('.an2-body');
    if (!root || !body) { this._paintFull(); return; }
    const busy = this.loading || this.syncing;
    const newClass = `an2-body${busy ? ' is-loading' : ''}`;
    const newHtml  = this._tabContent();

    if (body.className === newClass && this._lastBodyHtml === newHtml) {
      // Контент идентичен — пропускаем DOM-операцию полностью.
      return;
    }
    body.className = newClass;
    body.innerHTML = newHtml;
    this._lastBodyHtml = newHtml;
  }
  private _lastBodyHtml = '';

  private renderHeader(): string {
    const periods: Array<[PeriodPreset, string]> = [
      ['7', '7д'], ['30', '30д'], ['90', '90д'], ['180', '6м'], ['365', '12м'], ['all', 'С начала'],
    ];

    const mps: Mp[] = ['ozon', 'wb', 'yandex'];

    const tabBtn = (id: Tab, label: string, count?: number) => `
      <button class="an2-tab ${this.tab === id ? 'active' : ''}" onclick="window.analyticsModule?.setTab('${id}')">
        ${label}
        ${count != null ? `<span class="an2-tab-count">${fmtNum(count)}</span>` : ''}
      </button>
    `;

    return `
      <div class="an2-head">
        <div class="an2-title">
          <span class="an2-title-dot ${this.loading || this.syncing ? 'busy' : ''}"></span>Аналитика
        </div>

        <div class="an2-tabs">
          ${tabBtn('summary',  'Сводка')}
          ${tabBtn('orders',   'Заказы',  this.orders.length || undefined)}
          ${tabBtn('products', 'Товары')}
          ${tabBtn('activity', 'Активность')}
          ${tabBtn('balance',  'Баланс')}
        </div>

        <div class="an2-period">
          ${periods.map(([v, l]) => `
            <button class="an2-period-btn ${this.period === v ? 'active' : ''}" onclick="window.analyticsModule?.setPeriod('${v}')">${l}</button>
          `).join('')}
          <button class="an2-period-btn ${this.period === 'custom' ? 'active' : ''}" onclick="window.analyticsModule?.setPeriod('custom')">…</button>
        </div>
        ${this.period === 'custom' ? `
          <div class="an2-period-custom">
            <input type="date" value="${this.customFrom}" onchange="window.analyticsModule?.setCustomDate('from', this.value)"/>
            <span style="color:var(--text3)">—</span>
            <input type="date" value="${this.customTo}" onchange="window.analyticsModule?.setCustomDate('to', this.value)"/>
          </div>
        ` : ''}

        <div style="display:flex;gap:4px;align-items:center" title="Аналитика по одному маркетплейсу за раз — данные не смешиваются">
          ${mps.map(mp => `
            <button class="an2-filter-chip ${this.selectedMp === mp ? 'on' : ''}" onclick="window.analyticsModule?.selectMp('${mp}')" title="Только ${MP_LABEL[mp]}">
              <span class="dot" style="background:${MP_COLOR[mp]}"></span>${MP_LABEL[mp]}
            </button>
          `).join('')}
        </div>

        ${this._renderStoreSelector()}

        <div class="an2-spacer"></div>

        ${this._renderLoadMeta()}

        ${(() => {
          const busy = this.syncing || this._autoSyncing || this.loading;
          const label = (this.syncing || this._autoSyncing) ? 'Синхронизируется…' : this.loading ? 'Загружается…' : 'Обновить';
          const title = (this.syncing || this._autoSyncing)
            ? 'Идёт синхронизация финотчёта из маркетплейса…'
            : this.loading ? 'Загружаем данные…'
            : 'Подтянуть финотчёт из маркетплейса и обновить аналитику';
          return `
            <button class="an2-update-btn${busy ? ' busy' : ''}"
              onclick="${busy ? '' : 'window.analyticsModule?.syncFinances()'}"
              title="${title}"
              ${busy ? 'disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="${busy ? 'spin' : ''}"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              <span>${label}</span>
            </button>
          `;
        })()}

        <button class="an2-icon-btn" onclick="window.analyticsModule?.openSettings()" title="Настройки">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        </button>
      </div>
    `;
  }

  /** Мета-чип справа в шапке: статус последней загрузки + фоновый синк. */
  private _renderLoadMeta(): string {
    const parts: string[] = [];

    // Статистика последней загрузки
    if (!this.loading && this._loadSummary && this._loadElapsedMs > 0) {
      const s = this._loadSummary;
      const secs = (this._loadElapsedMs / 1000).toFixed(this._loadElapsedMs < 10000 ? 1 : 0);
      if (s.cached > 0 || s.fetched > 0) {
        const bits: string[] = [];
        if (s.cached  > 0) bits.push(`⚡ ${s.cached} кэш`);
        if (s.fetched > 0) bits.push(`↓ ${s.fetched} API`);
        if (s.errors  > 0) bits.push(`⚠ ${s.errors} ошибок`);
        parts.push(`<span class="an2-load-meta" title="Загружено за ${secs} сек">${bits.join(' · ')} · ${secs}с</span>`);
      }
    }

    // Фоновая синхронизация заказов
    if (this._syncStatus.syncing) {
      const { syncedStores, totalStores, currentStore } = this._syncStatus;
      const label = currentStore ? currentStore : `${syncedStores}/${totalStores}`;
      parts.push(`
        <span class="an2-sync-badge" title="Фоновый синк: кэшируем заказы для быстрой аналитики">
          <span class="an2-sync-badge-dot"></span>Синк: ${label}
        </span>
      `);
    }

    return parts.join('');
  }

  /** Чипы выбора магазина (обязательный single-select, без «Все»). */
  private _renderStoreSelector(): string {
    const mpStores = this.stores.filter(s => s.mp === this.selectedMp);
    if (mpStores.length <= 1) return ''; // 0 или 1 магазин — фильтр не нужен
    // Авто-выбор первого магазина если ничего не выбрано
    if (!this.selectedStore || !mpStores.find(s => s.id === this.selectedStore)) {
      Promise.resolve().then(() => {
        if (!this.selectedStore || !this.stores.find(s => s.id === this.selectedStore && s.mp === this.selectedMp)) {
          this.selectedStore = mpStores[0].id;
          this.refresh();
        }
      });
    }
    return `
      <div class="an2-store-selector" title="Выберите магазин для анализа">
        ${mpStores.map(s => `
          <button
            class="an2-filter-chip ${this.selectedStore === s.id ? 'on' : ''}"
            onclick="window.analyticsModule?.selectStore('${s.id}')"
            title="${s.name}"
          >${s.name}</button>
        `).join('')}
      </div>
    `;
  }

  private renderBody(): string {
    const busy = this.loading || this.syncing;
    return `<div class="an2-body${busy ? ' is-loading' : ''}">${this._tabContent()}</div>`;
  }

  private _tabContent(): string {
    // Balance tab doesn't depend on analytics data — render independently
    if (this.tab === 'balance') return renderBalanceTab(this._balances);

    if (this.period === 'all') {
      if (this._allState === 'seeking' || this._allState === 'confirming') return this._renderAllConfirm();
      if (this._allState === 'syncing') return this._renderAllSyncing();
    }
    if (this.loading && !this.dataLoaded) return this.renderLoader();
    if (!this.dataLoaded || !this.kpi)    return this.renderEmpty();
    // Data loaded but no stores for selected MP → guide user to switch MP tab
    if (this.getFilteredStoreIds().size === 0) return this.renderNoStoresForMp();
    return this.renderTab();
  }

  private _renderAllConfirm(): string {
    if (this._allState === 'seeking') {
      return `
        <div class="an2-all-confirm">
          <div class="an2-loader-ring" style="width:32px;height:32px;margin:0 auto 16px"></div>
          <p style="color:var(--text2);margin:0">Ищем начало истории магазина…</p>
        </div>`;
    }

    const store = this.stores.find(s => s.id === this.selectedStore);
    const storeName = store?.name ?? 'магазина';

    const from = this._allFrom;
    const fromStr = from
      ? from.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      : 'неизвестной даты';
    const days = from ? Math.round((Date.now() - from.getTime()) / 86_400_000) : 0;

    return `
      <div class="an2-all-confirm">
        <div class="an2-all-confirm-icon">${I.package()}</div>
        <h3>Загрузить всю историю «${storeName}»?</h3>
        <p>
          Найдена дата начала: <strong>${fromStr}</strong>
          ${days ? `<span class="an2-all-confirm-days">${days} дней</span>` : ''}
        </p>
        <p class="an2-all-confirm-hint">
          Первая загрузка может занять несколько минут.<br>
          После этого данные сохранятся в базе — все периоды будут открываться мгновенно.
        </p>
        <div class="an2-all-confirm-btns">
          <button class="an2-btn primary" onclick="window.analyticsModule?.confirmAllPeriodLoad()">
            Загрузить историю
          </button>
          <button class="an2-btn ghost" onclick="window.analyticsModule?.cancelAllPeriod()">
            Отмена
          </button>
        </div>
      </div>
    `;
  }

  private _renderAllSyncing(): string {
    const total = this._allSyncTotal;
    const step  = this._allSyncStep;
    const pct   = total > 0 ? Math.round((step / total) * 100) : 0;
    return `
      <div class="an2-all-confirm">
        <div class="an2-loader-ring" style="width:40px;height:40px;margin:0 auto 16px"></div>
        <h3 style="margin:0 0 8px">Загружаем историю…</h3>
        <p style="margin:0 0 4px;color:var(--text2)">${this._allSyncMsg}</p>
        <p style="margin:0 0 12px;font-size:12px;color:var(--text3)">Шаг ${step} из ${total} &bull; ${pct}%</p>
        <div class="an2-sync-bar"><div class="an2-sync-bar-fill" style="width:${pct}%"></div></div>
        <p class="an2-all-confirm-hint">Не закрывайте страницу. После завершения все периоды будут открываться мгновенно.</p>
      </div>
    `;
  }

  private renderTab(): string {
    if (this.tab === 'balance') return renderBalanceTab(this._balances);
    if (!this.kpi) return this.renderEmpty();
    switch (this.tab) {
      case 'summary':  return renderSummaryTab(this.kpi, this.orders, this.ts, this.prevKpi, this.missingCogs);
      case 'orders':   return renderOrdersTab(this.orders, this.ordersFilters);
      case 'products': return renderProductsTab(this.orders, this.productsFilters);
      case 'activity': return renderActivityTab(this.orders, this.activitySubTab);
    }
  }

  private renderLoader(): string {
    const elapsed  = (Date.now() - this._loadStart) / 1000;
    const elapsedS = elapsed < 1 ? '' : `${elapsed.toFixed(elapsed < 10 ? 1 : 0)} с`;
    const p = this._loadProgress;

    if (!p || p.total === 0) {
      // Пустой прогресс — показываем описание фазы по времени
      const phase =
        elapsed < 3  ? 'Читаем кэш…' :
        elapsed < 10 ? 'Загружаем из маркетплейсов…' :
        elapsed < 20 ? 'Это займёт немного времени…' :
                       'Почти готово…';
      return `
        <div class="an2-loader">
          <div class="an2-loader-ring"></div>
          <div class="an2-loader-text">${phase}</div>
          ${elapsedS ? `<div class="an2-loader-elapsed">${elapsedS}</div>` : ''}
        </div>
      `;
    }

    const pct = Math.min(100, Math.round((p.done / p.total) * 100));
    const hasErrors = p.errors > 0;
    return `
      <div class="an2-loader">
        <div class="an2-loader-ring"></div>
        <div class="an2-load-prog">
          <div class="an2-load-prog-label">${p.currentLabel || 'Загружаем…'}</div>
          <div class="an2-load-prog-bar-wrap">
            <div class="an2-load-prog-bar" style="width:${pct}%"></div>
          </div>
          <div class="an2-load-prog-stats">
            <span class="an2-load-prog-done">${p.done} / ${p.total} мес.</span>
            ${p.cached  > 0 ? `<span class="an2-load-prog-cached">⚡ ${p.cached} из кэша</span>` : ''}
            ${p.fetched > 0 ? `<span class="an2-load-prog-api">↓ ${p.fetched} из API</span>` : ''}
            ${hasErrors     ? `<span class="an2-load-prog-err">⚠ ${p.errors} ошибок</span>` : ''}
            ${elapsedS      ? `<span class="an2-load-prog-time">${elapsedS}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  private renderEmpty(): string {
    if (this.stores.length === 0) {
      return `
        <div class="an2-empty">
          <div class="emoji">${I.store()}</div>
          <h3>Нет подключённых магазинов</h3>
          <p>Чтобы видеть аналитику — подключи хотя бы один магазин Ozon / WB / Я.Маркет в разделе «Маркетплейсы».</p>
        </div>
      `;
    }
    return `
      <div class="an2-empty">
        <div class="emoji">${I.chart()}</div>
        <h3>Нет заказов за период</h3>
        <p>Попробуй сменить период или нажать «Подтянуть финотчёт».</p>
      </div>
    `;
  }

  private renderNoStoresForMp(): string {
    const mpNames: Record<string, string> = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };
    const available = (['ozon', 'wb', 'ym'] as const).filter(mp =>
      this.stores.some(s => s.mp === mp)
    );
    const buttons = available
      .map(mp => `<button class="an2-switch-mp-btn" onclick="window.analyticsModule?.selectMp('${mp}')">${mpNames[mp]}</button>`)
      .join('');
    return `
      <div class="an2-empty">
        <div class="emoji">${I.store()}</div>
        <h3>Нет магазинов для «${mpNames[this.selectedMp] ?? this.selectedMp}»</h3>
        <p>У тебя нет подключённых магазинов на этом маркетплейсе. Переключись на другой:</p>
        ${buttons ? `<div class="an2-switch-mp-btns">${buttons}</div>` : ''}
      </div>
    `;
  }

  private renderOpenOrder(): string {
    const o = this.orders.find(x => x.order_id === this.openedOrderId)
           ?? this.prevOrders.find(x => x.order_id === this.openedOrderId);
    if (!o) {
      this.openedOrderId = null;
      return '';
    }
    return renderOrderDrawer(o);
  }
}

// Default export для совместимости с динамическим импортом из main.ts
export default AnalyticsModule;
