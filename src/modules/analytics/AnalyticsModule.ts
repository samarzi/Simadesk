/**
 * AnalyticsModule v2 — оркестратор.
 * Источник истины по финансам: mp_transactions (точные цифры от МП).
 * Источник истины по статусам: live-заказы (Ozon/WB/ЯМ API).
 * Себестоимость — costPriceDb (вручную). Налог — settings + store.
 */

import { debug } from '@/utils/debug';
import { I } from '@/utils/icons';
import { mskRange, mskDayKey, mskCalendarRange, CalendarPreset, normalizeMpDate } from '@/utils/mpDate';
import { aiPage } from '@/services/aiPageContext';
import { Mp, MP_LABEL, MP_COLOR, STATUS_LABEL, Order, KPI, TimeseriesPoint, PeriodPreset, StoreInfo, TaxModel, PeriodCost, ManualEntry } from './types';
import { aggregateOrders, AggregateInput } from './services/orderAggregator';
import { buildCogsResolver } from './services/cogsResolver';
import { computeKPI, computeTimeseries, computeMissingCogs, MissingCogsItem, computeSkuPerformance } from './services/kpiAggregator';
import { loadAllStores, buildProductMap, loadOrders, loadTransactions, QueryProgress } from './services/dataLoader';
import { settingsDb } from './services/settingsDb';
import { financeSync } from '@/services/financeSync';
import { orderSyncService, OrderSyncStatus } from '@/services/orderSyncService';
import { costPriceDb } from '@/services/costPriceDb';
import { companyService } from '@/services/companyService';
import { ozonDb } from '@/services/ozonDb';
import { ozonPerformanceApi, PerfCredentials } from '@/services/ozonPerformanceApi';
import { computeUnitEconomics, UnitEconResult, UnitEconSettings, UnitAdsInput, StoreTax } from './services/unitEconomics';
import { exportXlsx, exportJson, exportFileName, Sheet } from './services/exporter';
import { renderUnitTab, unitReportText, unitSheets, UnitSortKey } from './tabs/UnitTab';

import { renderSummaryTab, clearSummaryCache } from './tabs/SummaryTab';
import { renderOrdersTab, OrdersFilters, clearOrdersCache } from './tabs/OrdersTab';
import { renderProductsTab, ProductsFilters, clearProductsCache } from './tabs/ProductsTab';
import { renderActivityTab, ActivitySubTab } from './tabs/ActivityTab';
import { renderBalanceTab, StoreBalance } from './tabs/BalanceTab';
import { renderDetail, DetailKey, isDetailKey } from './tabs/details';
import { renderOrderDrawer } from './components/OrderDetailDrawer';
import { renderSettingsDrawer } from './components/SettingsDrawer';
import { fmtNum } from './components/format';

import './styles/analytics.css';

function escapeHtmlJson(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Tab = 'summary' | 'unit' | 'orders' | 'products' | 'activity' | 'balance';
type MpSel = Mp | 'all';

export class AnalyticsModule {
  private container: HTMLElement;
  private tab: Tab = 'summary';
  /** Открытая страница детализации KPI. null = обычная вкладка. */
  private detail: DetailKey | null = null;

  private period: PeriodPreset = '30';
  private customFrom = '';
  private customTo = '';

  private stores: StoreInfo[] = [];
  /** Выбранный магазин (один или «все» = null). Single-select внутри МП. */
  private selectedStore: string | null = null;
  /** @deprecated use selectedStore */
  private selectedStores = new Set<string>();
  /** Активный маркетплейс или 'all' — сводный отчёт по всем площадкам. */
  private selectedMp: MpSel = (() => {
    try {
      const saved = localStorage.getItem('an2_selected_mp');
      if (saved === 'ozon' || saved === 'wb' || saved === 'yandex' || saved === 'all') return saved;
    } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
    return 'ozon';
  })();

  private orders: Order[] = [];
  /** Расходы МП без привязки к заказу: реклама, хранение, штрафы. */
  private periodCosts: PeriodCost[] = [];
  private manualEntries: ManualEntry[] = [];
  private prevOrders: Order[] = [];
  private kpi: KPI | null = null;
  private prevKpi: KPI | null = null;
  private ts: TimeseriesPoint[] = [];

  private requestId = 0;
  private controller: AbortController | null = null;
  private loadedKey = '';
  private loadError = '';
  private loadWarning = '';
  private phase = 'Подготавливаем магазины…';
  private updatedAt: Date | null = null;
  private syncedAt: Date | null = null;
  private syncTimes = new Map<string, number>();
  private rawInput: AggregateInput | null = null;
  private companyId: string | null = null;
  private loading = false;
  private syncing = false;
  private dataLoaded = false;

  // ── Прогресс загрузки ────────────────────────────────────────────────
  private _loadProgress: QueryProgress | null = null;
  private _loadSummary: QueryProgress | null = null;
  private _loadStart = 0;
  private _loadElapsedMs = 0;
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

  // ── Юнит-экономика ───────────────────────────────────────────────────
  private unitResult: UnitEconResult | null = null;
  private unitKey = '';
  private unitLoading = false;
  private unitError = '';
  private unitUpdatedAt: Date | null = null;
  private unitSort: { key: UnitSortKey; dir: 1 | -1 } = { key: 'orderedRevenue', dir: -1 };
  /** Сырые данные для пересчёта без новой загрузки (смена настроек). */
  private unitRaw: {
    history: Order[]; ads: UnitAdsInput; fbs: UnitEconResult['fbs']; historyLabel: string;
  } | null = null;
  /** Статус проверки ключей Performance по магазину. */
  private perfStatus = new Map<string, { ok: boolean; text: string }>();
  private perfKeys = new Map<string, { clientId: string; clientSecret: string }>();

  constructor(container: HTMLElement) {
    this.container = container;
    // Подписываемся на статус фонового синка — обновляем бейдж в шапке
    orderSyncService.onStatus(s => {
      this._syncStatus = s;
      // Фоновый кэш заказов не должен пересоздавать открытый экран.
      this.updateStatus();
    });
  }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    const companyId = companyService.getActiveId();
    if (this.companyId !== companyId) {
      this.controller?.abort();
      this.requestId++;
      this.companyId = companyId;
      this.dataLoaded = false;
      this.loadedKey = '';
      this.orders = [];
      this.kpi = this.prevKpi = null;
      this.rawInput = null;
      this._balances = [];
      this._balanceLoaded = false;
    }
    if (this.loading) return;
    if (!this.dataLoaded) {
      this.loading = true;
      this.phase = 'Подготавливаем магазины…';
      this.render();
      try {
        this.stores = await loadAllStores();
        if (companyId !== companyService.getActiveId()) return;
        if (this.selectedMp !== 'all' && !this.stores.some(s => s.mp === this.selectedMp) && this.stores.length) this.selectedMp = this.stores[0].mp;
        this.ensureStoreSelection();
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : String(e);
        this.loading = false;
        this.render();
        return;
      }
      this.loading = false;
      await this.refresh();
    } else {
      this._registerAiPage();
      if (!this.updatedAt || Date.now() - this.updatedAt.getTime() > 5 * 60_000) await this.refresh();
      else this.render();
    }
  }

  hide(): void {
    this.container.style.display = 'none';
    this.controller?.abort();
    this.requestId++;
    this.loading = this.syncing = false;
    aiPage.clear('analytics');
  }

  get isDataLoaded(): boolean { return this.dataLoaded; }

  /** Текстовый дамп аналитики для AI-ассистента. */
  getAiSummary(): string {
    if (!this.dataLoaded || !this.kpi) return '';
    const k = this.kpi;
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн ₽`
      : n >= 1_000 ? `${(n / 1_000).toFixed(0)} тыс ₽`
      : `${Math.round(n)} ₽`;

    const lines: string[] = [
      `Период: ${this._periodLabel()}`,
      `База расчёта денег — выкупленные заказы с финотчётом МП.`,
      `Выручка (выкуплено): ${fmt(k.revenue)} | Заказано за период: ${fmt(k.ordered_revenue)} | Ещё в пути: ${fmt(k.in_transit_revenue)} | Ждут расчёта МП: ${fmt(k.awaiting_revenue)}`,
      `Заказов доставлено: ${k.orders_delivered} (из них рассчитано ${k.orders_settled}) | В обработке: ${k.orders_processing} | Возвратов: ${k.orders_returned} | Отмен: ${k.orders_cancelled} | Выкуп: ${k.buyout_pct.toFixed(1)}%`,
      `Маржа: ${k.margin_pct.toFixed(1)}% | Чистая прибыль: ${fmt(k.net_profit)} | Ср. чек: ${fmt(k.avg_check)}`,
      `Комиссии МП: ${fmt(k.commission)} | Логистика: ${fmt(k.logistics)} | Услуги по заказам: ${fmt(k.services)} | Реклама/хранение/штрафы: ${fmt(k.period_costs)} | Свои расходы: ${fmt(k.manual_costs)} | Налог: ${fmt(k.tax)} | Себестоимость: ${fmt(k.cogs)}`,
      `Упущено: возвраты ${fmt(k.returns_revenue)}, отмены ${fmt(k.cancelled_revenue)}`,
    ];

    // Топ-5 товаров по выручке
    try {
      const skus = computeSkuPerformance(this.orders).sort((a: any, b: any) => b.revenue - a.revenue).slice(0, 5);
      if (skus.length) {
        lines.push('Топ-5 товаров по выручке:');
        skus.forEach((s: any, i: number) => {
          lines.push(`  ${i + 1}. [${s.mp}] ${s.vendor_code} "${s.name}" — ${fmt(s.revenue)}, ${s.units_sold} шт, маржа ${s.margin_pct.toFixed(1)}%`);
        });
      }
    } catch { /* ignore */ }

    return lines.join('\n');
  }

  private _periodLabel(): string {
    const labels: Record<string, string> = {
      '1': 'сегодня', 'yesterday': 'вчера', 'week': 'эта неделя', 'prev_week': 'прошлая неделя',
      'month': 'этот месяц', 'prev_month': 'прошлый месяц',
      '7': '7 дней', '30': '30 дней', '90': '90 дней',
      '180': '6 месяцев', '365': '12 месяцев', 'all': 'всё время',
    };
    const { start, end } = this.getRange();
    const d = (x: Date) => new Date(x.getTime() + 3 * 3600_000).toISOString().slice(0, 10).split('-').reverse().join('.');
    const span = mskDayKey(start.toISOString()) === mskDayKey(end.toISOString()) ? d(start) : `${d(start)} — ${d(end)}`;
    if (this.period === 'custom' && this.customFrom && this.customTo) return span;
    return `${labels[this.period] ?? this.period} (${span})`;
  }

  private _registerAiPage(): void {
    if (!this.dataLoaded || !this.kpi) return;
    aiPage.register({
      page: 'analytics',
      title: 'Аналитика',
      describe: () => this.getAiSummary(),
      actions: [],
    });
  }

  // ── Период ────────────────────────────────────────────────────────────
  private getRange(): { start: Date; end: Date } {
    if (this.period === 'custom' && this.customFrom && this.customTo) {
      const start = new Date(this.customFrom + 'T00:00:00.000+03:00');
      const end   = new Date(this.customTo   + 'T23:59:59.999+03:00');
      return { start, end };
    }
    if (this.period === 'all') {
      const { end } = mskRange(1);
      const start = this._allFrom
        ? new Date(this._allFrom)
        : new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1));
      start.setUTCHours(0, 0, 0, 0);
      return { start, end };
    }
    if (['yesterday', 'week', 'prev_week', 'month', 'prev_month'].includes(this.period)) {
      return mskCalendarRange(this.period as CalendarPreset);
    }
    // Границы — московские сутки: площадки отчитываются по Москве, и продавец
    // мыслит так же. По UTC «сегодня» начиналось бы в 03:00 по Москве.
    return mskRange(parseInt(this.period) || 30);
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
    let pool = this.selectedMp === 'all' ? this.stores : this.stores.filter(s => s.mp === this.selectedMp);
    if (this.selectedStore) pool = pool.filter(s => s.id === this.selectedStore);
    return new Set(pool.map(s => s.id));
  }

  /** Выбранный магазин должен принадлежать выбранной площадке; null — все магазины. */
  private ensureStoreSelection(): void {
    if (this.selectedMp === 'all') { this.selectedStore = null; return; }
    const mpStores = this.stores.filter(s => s.mp === this.selectedMp);
    if (this.selectedStore && !mpStores.some(s => s.id === this.selectedStore)) this.selectedStore = null;
  }

  /** Финотчёт часто появляется через несколько дней после даты заказа. Берём
   * запас вокруг периода, а агрегатор сам отсекает orphan-расходы за его
   * пределами. Это устраняет ложные «ожидание расчёта» на границах месяца. */
  private getSettlementRange(start: Date, end: Date): { start: Date; end: Date } {
    const pad = 45 * 86400_000;
    return { start: new Date(start.getTime() - pad), end: new Date(end.getTime() + pad) };
  }

  private queryKey(): string {
    const { start, end } = this.getRange();
    return `${companyService.getActiveId()}|${this.selectedMp}|${[...this.getFilteredStoreIds()].sort()}|${start.toISOString()}|${end.toISOString()}`;
  }

  // Все результаты публикуются одним снимком. Старый запрос не может изменить новый срез.
  async refresh(forceSync = false): Promise<void> {
    const id = ++this.requestId;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const storeIds = this.getFilteredStoreIds();
    const mp = this.selectedMp;
    const key = this.queryKey();
    const { start, end } = this.getRange();
    if (start > end) { this.loadError = 'Начало периода должно быть раньше окончания'; this.loading = false; this.render(); return; }
    if (key !== this.loadedKey) {
      this.dataLoaded = false;
      this.prevKpi = null;
      this.prevOrders = [];
      this.openedOrderId = null;
    }
    this.loading = true;
    this.loadError = this.loadWarning = '';
    this.phase = 'Обновляем финансовый отчёт магазина…';
    this._loadProgress = null;
    this._loadStart = Date.now();
    this.render();
    try {
      const txRange = this.getSettlementRange(start, end);
      // Не запрашиваем будущие операции и не синхронизируем посторонние магазины.
      txRange.end = new Date(Math.min(txRange.end.getTime(), Date.now()));
      if (txRange.end < txRange.start) txRange.end = txRange.start;
      const syncKey = `${key}|finance`;
      const lastSync = this.syncTimes.get(syncKey);
      if (storeIds.size && (forceSync || !lastSync || Date.now() - lastSync > 10 * 60_000)) {
        try {
          // В сводном режиме синхронизируем каждую площадку своими магазинами.
          const mps = mp === 'all' ? [...new Set(this.stores.filter(s => storeIds.has(s.id)).map(s => s.mp))] : [mp];
          for (const m of mps) {
            const ids = new Set([...storeIds].filter(id => this.stores.find(s => s.id === id)?.mp === m));
            await financeSync.syncSelected(m, ids, txRange.start.toISOString(), txRange.end.toISOString(), controller.signal);
          }
          if (id !== this.requestId) return;
          this.syncTimes.set(syncKey, Date.now());
        } catch (e) {
          if (controller.signal.aborted) return;
          this.loadWarning = 'Финотчёт не обновлён. Показаны сохранённые операции. ' + (e instanceof Error ? e.message : String(e));
        }
      }
      if (id !== this.requestId) return;
      this.phase = 'Загружаем заказы и себестоимость…';
      this.updateStatus();
      const [liveOrders, txs, products] = await Promise.all([
        loadOrders(start, end, storeIds, controller.signal, p => {
          if (id !== this.requestId) return;
          this._loadProgress = p;
          this.updateStatus();
        }),
        loadTransactions([...storeIds], txRange.start, txRange.end),
        buildProductMap(storeIds),
        costPriceDb.refresh(),
      ]);
      if (id !== this.requestId || controller.signal.aborted) return;
      // Прогресс меняется из колбэка — TS не видит этого и сужает тип до null.
      const progress = this._loadProgress as QueryProgress | null;
      if (progress && progress.errors > 0) {
        this.loadWarning += ' Часть заказов не загружена. Итоги неполные; повторите обновление.';
      }
      this.rawInput = { ...liveOrders, transactions: txs, stores: this.stores.filter(s => storeIds.has(s.id)),
        products, cogs: buildCogsResolver(), periodStart: start, periodEnd: end };
      this.loadedKey = key;
      this.syncedAt = this.syncTimes.has(syncKey) ? new Date(this.syncTimes.get(syncKey)!) : null;
      this.updatedAt = new Date();
      this.applySnapshot();
      this.dataLoaded = true;
      this._loadElapsedMs = Date.now() - this._loadStart;
      this._loadSummary = this._loadProgress;
      this._registerAiPage();
    } catch (e) {
      if (id !== this.requestId || controller.signal.aborted) return;
      this.loadError = 'Не удалось загрузить аналитику. ' + (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === this.requestId) {
        this.loading = this.syncing = false;
        this.render();
      }
    }
  }

  private applySnapshot(): void {
    if (!this.rawInput) return;
    const agg = aggregateOrders(this.rawInput);
    this.orders = agg.orders;
    this.periodCosts = agg.periodCosts;
    this.knownVendorCodes = new Set([...this.rawInput.products.values()].map(p => p.vendor_code.trim().toLowerCase()));
    this.missingCogs = computeMissingCogs(this.orders, this.knownVendorCodes);
    this._recomputeWithManual(false);
    clearOrdersCache();
    clearProductsCache();
  }

  /** Ручные расходы пользователя, попадающие в период и в выбранные магазины. */
  private _manualFor(start: Date, end: Date, storeIds: Set<string>): ManualEntry[] {
    const from = mskDayKey(start.toISOString());
    const to = mskDayKey(end.toISOString());
    return settingsDb.manualList().filter(e => {
      const day = e.date.length === 10 ? e.date : mskDayKey(e.date);
      if (!day || day < from || day > to) return false;
      // Запись без привязки к магазину считаем общей для выбранного среза
      if (e.store_id && !storeIds.has(e.store_id)) return false;
      if (e.mp && this.selectedMp !== 'all' && e.mp !== this.selectedMp) return false;
      return true;
    });
  }

  async comparePeriod(): Promise<void> {
    if (!this.rawInput || this.loading || !this.dataLoaded) return;
    const id = this.requestId;
    const key = this.loadedKey;
    const { start, end } = this.getPrevRange();
    const stores = this.rawInput.stores;
    const storeIds = new Set(stores.map(s => s.id));
    this.loading = true;
    this.phase = 'Загружаем предыдущий период…';
    this.render();
    try {
      const range = this.getSettlementRange(start, end);
      const [liveOrders, transactions] = await Promise.all([
        loadOrders(start, end, storeIds, this.controller?.signal), loadTransactions([...storeIds], range.start, range.end),
      ]);
      if (id !== this.requestId || key !== this.loadedKey) return;
      const agg = aggregateOrders({ ...this.rawInput, ...liveOrders, transactions, periodStart: start, periodEnd: end });
      this.prevOrders = agg.orders;
      this.prevKpi = computeKPI(agg.orders, agg.periodCosts, this._manualFor(start, end, storeIds));
      clearSummaryCache();
    } catch (e) {
      if (id === this.requestId) this.loadWarning = 'Не удалось загрузить сравнение: ' + String(e);
    } finally {
      if (id === this.requestId) { this.loading = false; this.render(); }
    }
  }

  async syncFinances(): Promise<void> { await this.refresh(true); }

  // ── Публичные методы (биндятся к window.analyticsModule) ─────────────

  setTab(t: Tab): void {
    if (this.tab === t && !this.detail) return;
    this.detail = null;
    this.tab = t;
    // Тап-active класс в шапке — обновляем точечно, body перерисовываем
    const tabs = this.container.querySelectorAll<HTMLElement>('.an2-tab');
    tabs.forEach(el => {
      const isActive = el.getAttribute('onclick')?.includes(`'${t}'`);
      el.classList.toggle('active', !!isActive);
    });
    if (t === 'balance' && !this._balanceLoaded) this._loadBalances();
    if (t === 'unit') void this.loadUnit();
    this._scheduleBodyOnly();
  }

  // ── Юнит-экономика ───────────────────────────────────────────────────

  /** Отбор живых заказов по дате создания (aggregateOrders сам их не фильтрует). */
  private _liveInRange(
    live: { ozonPostings: AggregateInput['ozonPostings']; yandexOrders: AggregateInput['yandexOrders']; wbOrders: AggregateInput['wbOrders'] },
    from: Date, to: Date,
  ) {
    const ok = (raw: string | null | undefined) => {
      const t = Date.parse(normalizeMpDate(raw ?? ''));
      return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
    };
    return {
      ozonPostings: live.ozonPostings.filter(p => ok(p.created_at || p.in_process_at)),
      yandexOrders: live.yandexOrders.filter(o => ok(o.creation_date)),
      wbOrders: live.wbOrders.filter(o => ok(o.created_at)),
    };
  }

  /** Загрузить историю, рекламу и FBS-отгрузки и посчитать юнит-экономику. */
  async loadUnit(force = false): Promise<void> {
    if (!this.rawInput || !this.dataLoaded) return;
    const key = this.loadedKey;
    if (!force && this.unitKey === key && (this.unitResult || this.unitLoading)) return;
    const id = this.requestId;
    const input = this.rawInput;
    this.unitKey = key;
    this.unitLoading = true;
    this.unitError = '';
    if (force) this.unitResult = null;
    this._scheduleBodyOnly();
    try {
      const { start, end } = this.getRange();
      const storeIds = new Set(input.stores.map(s => s.id));
      // Опорное окно: 60 дней, закончившиеся за 10 дней до периода — заказы в нём
      // уже успели доехать, выкупиться или вернуться.
      const hEnd = new Date(start.getTime() - 10 * 86_400_000 - 1);
      const hStart = new Date(hEnd.getTime() - 60 * 86_400_000 + 1);
      const txRange = this.getSettlementRange(hStart, hEnd);
      txRange.end = new Date(Math.min(txRange.end.getTime(), Date.now()));

      // Финотчёт за опорное окно — синкаем не чаще раза в час.
      const syncKey = `${key}|unit-history`;
      const last = this.syncTimes.get(syncKey);
      if (!last || Date.now() - last > 3600_000) {
        try {
          for (const m of new Set(input.stores.map(s => s.mp))) {
            const ids = new Set(input.stores.filter(s => s.mp === m).map(s => s.id));
            await financeSync.syncSelected(m, ids, txRange.start.toISOString(), txRange.end.toISOString(), this.controller?.signal);
          }
          this.syncTimes.set(syncKey, Date.now());
        } catch (e) { debug.warn('[Analytics] unit history sync failed', e); }
      }
      if (id !== this.requestId || key !== this.loadedKey) return;

      const [live, txs, ozStores] = await Promise.all([
        loadOrders(hStart, end, storeIds, this.controller?.signal),
        loadTransactions([...storeIds], txRange.start, txRange.end),
        input.stores.some(s => s.mp === 'ozon') ? ozonDb.getStores().catch(() => []) : Promise.resolve([]),
      ]);
      if (id !== this.requestId || key !== this.loadedKey) return;

      const hist = aggregateOrders({
        ...input, ...this._liveInRange(live, hStart, hEnd), transactions: txs,
        periodStart: hStart, periodEnd: hEnd,
      });

      // FBS: отправления, переданные в доставку в периоде (созданы могли раньше).
      let fbs: UnitEconResult['fbs'] = null;
      const fbsList = live.ozonPostings.filter(p => {
        if (p.delivery_scheme !== 'fbs' && p.delivery_scheme !== 'rfbs') return false;
        const handed = p.delivering_date
          ?? (p.status === 'delivering' || p.status === 'delivered' ? p.shipment_date : null);
        const t = Date.parse(normalizeMpDate(handed ?? ''));
        return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
      });
      if (input.stores.some(s => s.mp === 'ozon')) {
        fbs = {
          postings: fbsList.length,
          units: fbsList.reduce((s, p) => s + p.products.reduce((a, x) => a + x.quantity, 0), 0),
          revenue: fbsList.reduce((s, p) => s + p.products.reduce((a, x) => a + (parseFloat(x.price) || 0) * x.quantity, 0), 0),
        };
      }

      // Реклама: Performance API для Ozon-магазинов с ключами, иначе финотчёт; плюс ручные записи.
      const perfStores = ozStores.filter(s => storeIds.has(s.id) && s.perf_client_id && s.perf_client_secret);
      const ads: UnitAdsInput = { source: 'none', campaigns: [], unassigned: 0 };
      const adWarnings: string[] = [];
      for (const st of perfStores) {
        try {
          const cred: PerfCredentials = { storeId: st.id, clientId: st.perf_client_id!, clientSecret: st.perf_client_secret! };
          const r = await ozonPerformanceApi.spend(cred, start, end, this.controller?.signal);
          ads.campaigns.push(...r.campaigns);
          ads.source = 'performance';
        } catch (e) {
          adWarnings.push(`${st.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const perfIds = new Set(ads.source === 'performance' ? perfStores.map(s => s.id) : []);
      const financeAds = this.periodCosts.filter(c => c.kind === 'advertising' && !perfIds.has(c.store_id))
        .reduce((s, c) => s + c.amount, 0)
        + this.orders.filter(o => !perfIds.has(o.store_id))
          .reduce((s, o) => s + o.fee_breakdown.filter(f => f.type === 'advertising').reduce((a, f) => a + f.amount, 0), 0);
      const manualAds = this.manualEntries.filter(e => e.type === 'advertising').reduce((s, e) => s + e.amount, 0);
      ads.unassigned = financeAds + manualAds;
      if (ads.source === 'none') ads.source = financeAds > 0 ? 'finance' : manualAds > 0 ? 'manual' : 'none';

      const dm = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10).split('-').reverse().join('.');
      this.unitRaw = { history: hist.orders, ads, fbs, historyLabel: `за ${dm(hStart)} — ${dm(hEnd)}` };
      this._computeUnit(adWarnings);
      this.unitUpdatedAt = new Date();
    } catch (e) {
      if (id !== this.requestId) return;
      this.unitError = 'Не удалось посчитать юнит-экономику. ' + (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === this.requestId) {
        this.unitLoading = false;
        this._scheduleBodyOnly();
      }
    }
  }

  private _taxByStore(): Record<string, StoreTax> {
    const out: Record<string, StoreTax> = {};
    for (const s of this.rawInput?.stores ?? []) {
      const st = this.stores.find(x => x.id === s.id) ?? s;
      out[s.id] = { model: st.tax_model, rate: st.tax_rate, vat: st.vat_rate ?? 0 };
    }
    return out;
  }

  private _computeUnit(extraWarnings: string[] = []): void {
    if (!this.unitRaw) return;
    const r = computeUnitEconomics({
      orders: this.orders,
      history: this.unitRaw.history,
      periodCosts: this.periodCosts,
      ads: this.unitRaw.ads,
      taxByStore: this._taxByStore(),
      settings: settingsDb.unitSettings(),
      fbs: this.unitRaw.fbs,
    });
    for (const w of extraWarnings) r.nuances.unshift({ level: 'warn', text: `Реклама Ozon не получена — ${w}` });
    this.unitResult = r;
  }

  setUnitSetting(key: keyof UnitEconSettings, value: string | boolean): void {
    const patch: Partial<UnitEconSettings> = {};
    if (key === 'buyoutMode') patch.buyoutMode = value === 'manual' ? 'manual' : 'auto';
    else if (key === 'includeFacts') patch.includeFacts = !!value;
    else if (key === 'scenarioCost') {
      const n = parseFloat(String(value));
      patch.scenarioCost = String(value).trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
    } else if (key === 'buyoutPct') {
      const n = parseFloat(String(value));
      if (!Number.isFinite(n) || n <= 0 || n > 100) return;
      patch.buyoutPct = n;
    } else if (key === 'minSample') {
      const n = parseInt(String(value));
      if (!Number.isFinite(n) || n < 1) return;
      patch.minSample = n;
    }
    settingsDb.saveUnitSettings(patch);
    this._computeUnit();
    this._scheduleBodyOnly();
  }

  setUnitSort(key: UnitSortKey): void {
    this.unitSort = this.unitSort.key === key ? { key, dir: this.unitSort.dir === -1 ? 1 : -1 } : { key, dir: -1 };
    this._scheduleBodyOnly();
  }

  private _scopeLabel(): string {
    const store = this.stores.find(s => s.id === this.selectedStore);
    if (store) return `${MP_LABEL[store.mp]} · ${store.name}`;
    return this.selectedMp === 'all' ? 'все площадки' : MP_LABEL[this.selectedMp];
  }

  async copyUnitReport(btn?: HTMLElement): Promise<void> {
    if (!this.unitResult) return;
    const text = unitReportText(this.unitResult, `${this._scopeLabel()} · ${this._periodLabel()}`);
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => { btn.textContent = t; }, 1500); }
    } catch {
      window.prompt('Скопируйте отчёт:', text);
    }
  }

  async exportUnit(kind: 'xlsx' | 'json'): Promise<void> {
    if (!this.unitResult) return;
    const title = `${this._scopeLabel()} · ${this._periodLabel()}`;
    if (kind === 'json') {
      exportJson(exportFileName('unit-economics', 'json'), { title, generated_at: new Date().toISOString(), settings: settingsDb.unitSettings(), ...this.unitResult });
      return;
    }
    await exportXlsx(exportFileName('unit-economics', 'xlsx'), unitSheets(this.unitResult, title));
  }

  /** Выгрузить текущую вкладку в Excel. */
  async exportCurrent(): Promise<void> {
    if (this.tab === 'unit') return this.exportUnit('xlsx');
    if (!this.kpi) return;
    const k = this.kpi;
    const title = `${this._scopeLabel()} · ${this._periodLabel()}`;
    const sheets: Sheet[] = [];
    sheets.push({
      name: 'P&L',
      rows: [
        ['Статья', 'Сумма, ₽', '% выручки'],
        ['Период', title, null],
        ['Выручка (выкуплено)', k.revenue, 100],
        ['Комиссия МП', -k.commission, k.revenue ? k.commission / k.revenue * 100 : null],
        ['Логистика', -k.logistics, k.revenue ? k.logistics / k.revenue * 100 : null],
        ['Услуги по заказам', -k.services, k.revenue ? k.services / k.revenue * 100 : null],
        ['Реклама, хранение, штрафы', -k.period_costs, k.revenue ? k.period_costs / k.revenue * 100 : null],
        ['Свои расходы', -k.manual_costs, k.revenue ? k.manual_costs / k.revenue * 100 : null],
        ['Себестоимость', -k.cogs, k.revenue ? k.cogs / k.revenue * 100 : null],
        ['Налог (вкл. НДС)', -k.tax, k.revenue ? k.tax / k.revenue * 100 : null],
        ['  в т.ч. НДС', -k.vat, null],
        ['  в т.ч. налог с прибыли', -k.profit_tax, null],
        ['Чистая прибыль', k.net_profit, k.margin_pct],
        [],
        ['Заказано за период', k.ordered_revenue, null],
        ['В пути', k.in_transit_revenue, null],
        ['Ждут расчёта МП', k.awaiting_revenue, null],
        ['Упущено: возвраты', k.returns_revenue, null],
        ['Упущено: отмены', k.cancelled_revenue, null],
        ['Заказов доставлено', k.orders_delivered, null],
        ['Возвратов', k.orders_returned, null],
        ['Отмен', k.orders_cancelled, null],
        ['Выкуп, %', k.buyout_pct, null],
        ['Средний чек', k.avg_check, null],
        ['Единиц продано', k.units_sold, null],
      ],
      formats: { 1: 'money', 2: 'pct' },
    });
    if (k.period_costs_breakdown.length) {
      sheets.push({ name: 'Расходы периода', rows: [['Категория', 'Сумма, ₽'], ...k.period_costs_breakdown.map(b => [b.label, b.amount])], formats: { 1: 'money' } });
    }
    sheets.push({ name: 'По дням', rows: [['Дата', 'Выручка', 'Расходы', 'Прибыль'], ...this.ts.map(p => [p.date, p.revenue, p.expenses, p.profit])], formats: { 1: 'money', 2: 'money', 3: 'money' } });
    const skus = computeSkuPerformance(this.orders, this.periodCosts, this.manualEntries);
    sheets.push({
      name: 'Товары',
      rows: [['МП', 'Артикул', 'Название', 'Продано, шт', 'Возвращено, шт', 'Отменено, шт', 'Выручка', 'Комиссия', 'Логистика', 'Услуги', 'Налог', 'Себестоимость', 'Общие расходы', 'Прибыль', 'Прибыль/шт', 'Маржа, %', '% возвратов'],
        ...skus.map(x => [MP_LABEL[x.mp], x.vendor_code, x.name, x.units_sold, x.units_returned, x.units_cancelled, x.revenue, x.commission, x.logistics, x.services, x.tax, x.cogs, x.period_costs + x.manual_costs, x.net_profit, x.profit_per_unit, x.margin_pct, x.return_rate_pct])],
      formats: { 6: 'money', 7: 'money', 8: 'money', 9: 'money', 10: 'money', 11: 'money', 12: 'money', 13: 'money', 14: 'money2', 15: 'pct', 16: 'pct' },
    });
    sheets.push({
      name: 'Заказы',
      rows: [['Дата', 'Заказ', 'МП', 'Магазин', 'Статус', 'Товары', 'Шт', 'Выручка', 'Упущено', 'Комиссия', 'Логистика', 'Обр. логистика', 'Услуги', 'Себестоимость', 'Налог', 'Прибыль', 'Выплата МП', 'Финотчёт'],
        ...this.orders.filter(o => !o.is_orphan).map(o => [mskDayKey(o.date), o.order_id, MP_LABEL[o.mp], o.store_name, STATUS_LABEL[o.status],
          o.items.map(i => i.vendor_code).join(', '), o.items.reduce((s, i) => s + i.quantity, 0), o.revenue, o.revenue_lost,
          o.commission, o.logistics, o.logistics_return, o.services, o.cogs, o.tax, o.net_profit, o.payout_actual, o.source === 'real' ? 'да' : 'нет'])],
      formats: { 7: 'money', 8: 'money', 9: 'money', 10: 'money', 11: 'money', 12: 'money', 13: 'money', 14: 'money', 15: 'money', 16: 'money' },
    });
    await exportXlsx(exportFileName('analytics', 'xlsx'), sheets);
  }

  // ── Ключи Ozon Performance ───────────────────────────────────────────

  setPerfKey(storeId: string, field: 'clientId' | 'clientSecret', value: string): void {
    const cur = this.perfKeys.get(storeId) ?? { clientId: '', clientSecret: '' };
    cur[field] = value.trim();
    this.perfKeys.set(storeId, cur);
  }

  async savePerfKeys(storeId: string): Promise<void> {
    const keys = this.perfKeys.get(storeId);
    const stores = await ozonDb.getStores().catch(() => []);
    const st = stores.find(s => s.id === storeId);
    const clientId = keys?.clientId || st?.perf_client_id || '';
    const clientSecret = keys?.clientSecret || st?.perf_client_secret || '';
    if (!clientId || !clientSecret) {
      this.perfStatus.set(storeId, { ok: false, text: 'Укажите client_id и client_secret' });
      this.render();
      return;
    }
    this.perfStatus.set(storeId, { ok: true, text: 'Проверяем…' });
    this.render();
    try {
      const n = await ozonPerformanceApi.check({ storeId, clientId, clientSecret });
      await ozonDb.updateStore(storeId, { perf_client_id: clientId, perf_client_secret: clientSecret });
      this.perfStatus.set(storeId, { ok: true, text: `Подключено · кампаний: ${n}` });
      this._ozonStoresRaw = this._ozonStoresRaw.map(x => x.id === storeId ? { ...x, perf: true } : x);
      this.perfKeys.delete(storeId);
      this.unitKey = '';
      if (this.tab === 'unit') void this.loadUnit(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.perfStatus.set(storeId, {
        ok: false,
        text: msg.includes('perf_client') ? 'Не сохранено: на сервере не применена миграция 20261014_analytics_unit_economics.sql' : msg,
      });
    }
    this.render();
  }

  async clearPerfKeys(storeId: string): Promise<void> {
    try {
      await ozonDb.updateStore(storeId, { perf_client_id: null, perf_client_secret: null });
      this.perfStatus.set(storeId, { ok: true, text: 'Ключи удалены' });
      this._ozonStoresRaw = this._ozonStoresRaw.map(x => x.id === storeId ? { ...x, perf: false } : x);
      this.unitKey = '';
    } catch (e) {
      this.perfStatus.set(storeId, { ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    this.render();
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
  /** Выбрать магазин; пустой id — все магазины площадки. */
  selectStore(id: string): void {
    const next = id || null;
    if (this.selectedStore === next) return;
    this.selectedStore = next;
    this._allState = 'idle';
    this._allFrom  = null;
    this.refresh();
  }

  /** @deprecated use selectStore */
  toggleStore(id: string): void { this.selectStore(id); }

  toggleMp(mp: Mp): void { this.selectMp(mp); }

  /** Площадка или 'all' — сводный отчёт по всем подключённым площадкам. */
  selectMp(mp: Mp | 'all'): void {
    if (this.selectedMp === mp) return;
    this.selectedMp = mp;
    try { localStorage.setItem('an2_selected_mp', mp); } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
    this.selectedStore = null;
    this.ensureStoreSelection();
    this.selectedStores.clear();
    this._allState = 'idle';
    this._allFrom  = null;
    this.refresh();
  }

  /** Переключить маркетплейс и ДОЖДАТЬСЯ перезагрузки данных.
   *  Нужно для AI: selectMp() не ждёт refresh(), из-за чего ассистент читал
   *  сводку по прошлому маркетплейсу. */
  async selectMpAndReload(mp: Mp): Promise<void> {
    if (this.selectedMp !== mp) {
      this.selectedMp = mp;
      try { localStorage.setItem('an2_selected_mp', mp); } catch (e) { debug.warn('[AnalyticsModule] swallowed error', e); }
      this.selectedStore = null;
      this.ensureStoreSelection();
      this.selectedStores.clear();
      this._allState = 'idle';
      this._allFrom  = null;
      this.dataLoaded = false;
    }
    if (this.dataLoaded) return;
    // Если загрузка уже идёт — дождаться её завершения, refresh() сам вернётся сразу
    const deadline = Date.now() + 20_000;
    while (this.loading && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 120));
    }
    if (!this.dataLoaded) await this.refresh();
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
    if (key === 'search') this.productsFilters.limit = undefined;
    this._scheduleBodyOnly();
  }

  sortProducts(key: ProductsFilters['sort']): void {
    const f = this.productsFilters;
    this.productsFilters = { ...f, sort: key, dir: f.sort === key ? ((f.dir ?? -1) === -1 ? 1 : -1) : -1 };
    this._scheduleBodyOnly();
  }

  showMoreProducts(): void {
    this.productsFilters = { ...this.productsFilters, limit: (this.productsFilters.limit ?? 200) + 200 };
    this._scheduleBodyOnly();
  }

  setActivitySubTab(t: ActivitySubTab): void {
    this.activitySubTab = t;
    this._scheduleBodyOnly();
  }

  /** Открыть подробный разбор KPI-карточки (выручка, маржа, расходы и т.д.). */
  openDetail(key: string): void {
    if (!isDetailKey(key)) return;
    this.detail = key;
    this.tab = 'summary';
    this._scheduleBodyOnly();
    // Прокручиваем наверх — страница детализации начинается со своей шапки
    Promise.resolve().then(() => {
      this.container.querySelector<HTMLElement>('.an2-body')?.scrollTo({ top: 0 });
    });
  }

  /** Вернуться из детализации в «Сводку». */
  closeDetail(): void {
    if (!this.detail) return;
    this.detail = null;
    this._scheduleBodyOnly();
  }

  /** Показать попап с объяснением методологии KPI-карточки. */
  showKpiTooltip(event: MouseEvent, text: string): void {
    const id = 'an2-kpi-tooltip-popup';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'an2-kpi-tooltip-popup';
      el.innerHTML = `<button class="an2-kpi-tooltip-close" onclick="document.getElementById('${id}')?.remove()">&times;</button><p class="an2-kpi-tooltip-text"></p>`;
      document.body.appendChild(el);
      document.addEventListener('click', (e) => {
        const popup = document.getElementById(id);
        if (popup && !popup.contains(e.target as Node)) popup.remove();
      }, { once: true, capture: true });
    }
    el.querySelector<HTMLElement>('.an2-kpi-tooltip-text')!.textContent = text;
    // Позиционируем под кнопкой
    const btn = event.currentTarget as HTMLElement;
    const r = btn.getBoundingClientRect();
    const popupW = 280;
    let left = r.left + r.width / 2 - popupW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
    el.style.left  = `${left}px`;
    el.style.top   = `${r.bottom + 8 + window.scrollY}px`;
    el.style.width = `${popupW}px`;
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
    const order = this.orders.find(o => (o.order_key ?? o.order_id) === orderId);
    if (!order) return;
    try {
      const { dbFetch } = await import('@/services/dbClient');
      const txs = await dbFetch<any[]>(
        `mp_transactions?store_id=eq.${encodeURIComponent(order.store_id)}&posting_number=eq.${encodeURIComponent(order.order_id)}&order=operation_date.asc`,
      );
      // Открываем во всплывающем окне
      const w = window.open('', '_blank', 'width=900,height=700');
      if (!w) { alert('Разрешите всплывающие окна для просмотра JSON'); return; }
      const summary = {
        order_id: order.order_id,
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
      alert('Ошибка загрузки JSON: ' + ((e instanceof Error ? e.message : String(e)) ?? e));
    }
  }

  openOrdersFiltered(filter: string): void {
    this.detail = null;
    this.tab = 'orders';
    if (filter === 'delivered' || filter === 'returned' || filter === 'cancelled' || filter === 'processing') {
      this.ordersFilters = { ...this.ordersFilters, status: filter as any, page: 0 };
    } else {
      // commission/logistics → просто перейти на вкладку заказов, без фильтра
      this.ordersFilters = { ...this.ordersFilters, status: 'all', page: 0 };
    }
    this.render();
  }

  /** Ozon-магазины с полями ключей рекламы — для настроек. */
  private _ozonStoresRaw: Array<{ id: string; name: string; perf: boolean }> = [];

  async openSettings(): Promise<void> {
    this.settingsOpen = true;
    this.render();
    try {
      const list = await ozonDb.getStores();
      this._ozonStoresRaw = list.map(s => ({ id: s.id, name: s.name, perf: !!(s.perf_client_id && s.perf_client_secret) }));
      if (this.settingsOpen) this.render();
    } catch (e) { debug.warn('[Analytics] ozon stores for settings', e); }
  }
  closeSettings(): void { this.settingsOpen = false; this.render(); }

  openCogsHint(): void {
    alert('Себестоимость задаётся в модуле «Репрайсер» → «Себестоимости» — или прямо здесь в блоке «без себестоимости».');
  }

  /** Быстрое сохранение себестоимости прямо из сводки (без перехода в Репрайсер). */
  setCostPrice(vendorCode: string, price: number): void {
    if (!vendorCode || !isFinite(price) || price < 0) return;
    costPriceDb.set(vendorCode, price);
    if (this.rawInput) this.rawInput = { ...this.rawInput, cogs: buildCogsResolver() };
    this.applySnapshot();
  }

  setTax(storeId: string, field: 'model' | 'rate' | 'vat', value: string): void {
    const store = this.stores.find(s => s.id === storeId);
    if (!store) return;
    const model = field === 'model' ? value as TaxModel : store.tax_model;
    const rate = field === 'rate' ? Number(value) / 100 : store.tax_rate;
    const vat = field === 'vat' ? Number(value) / 100 : (store.vat_rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1 || !Number.isFinite(vat) || vat < 0 || vat > 1) return;
    settingsDb.setStoreTax(storeId, model, rate, vat);
    this.stores = this.stores.map(s => s.id === storeId ? { ...s, tax_model: model, tax_rate: rate, vat_rate: vat } : s);
    this.unitKey = '';
    if (this.rawInput) this.rawInput = { ...this.rawInput, stores: this.stores };
    this.applySnapshot();
  }
  async clearTax(storeId: string): Promise<void> {
    settingsDb.clearStoreTax(storeId);
    this.stores = await loadAllStores();
    if (this.rawInput) this.rawInput = { ...this.rawInput, stores: this.stores };
    this.applySnapshot();
  }
  setFx(cur: string, val: string): void {
    settingsDb.setFx(cur, parseFloat(val) || 0);
    this.render();
  }

  addManualEntry(ev: Event): void {
    const form = ev.target as HTMLFormElement;
    const fd = new FormData(form);
    const amount = parseFloat(String(fd.get('amount') ?? '0'));
    if (!Number.isFinite(amount) || amount <= 0) return;
    settingsDb.manualAdd({
      type: (fd.get('type') as any) ?? 'other_expense',
      amount, amount_native: amount, currency: 'RUB', fx_rate: 1,
      date: new Date().toISOString(),
      store_id: this.selectedStore ?? undefined,
      mp: this.selectedMp === 'all' ? undefined : this.selectedMp,
      description: String(fd.get('description') ?? ''),
    });
    form.reset();
    this._recomputeWithManual();
  }
  deleteManualEntry(id: string): void {
    if (!confirm('Удалить запись?')) return;
    settingsDb.manualDelete(id);
    this._recomputeWithManual();
  }

  /** Пересчитать KPI после правки ручных расходов — без перезагрузки заказов. */
  private _recomputeWithManual(paint = true): void {
    if (this.rawInput) {
      const { start, end } = this.getRange();
      const manual = this._manualFor(start, end, this.getFilteredStoreIds());
      this.manualEntries = manual;
      this.kpi = computeKPI(this.orders, this.periodCosts, manual);
      this.ts  = computeTimeseries(this.orders, start, end, this.periodCosts, manual);
      clearSummaryCache();
      clearProductsCache();
      if (this.unitRaw && this.unitKey === this.loadedKey) this._computeUnit();
    }
    if (paint) this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────

  /** Полный ре-рендер (заголовок + тело + дроуеры). */
  render(): void {
    this._pendingFull = true;
    this._scheduleRaf();
  }

  /** Изменяет только уже существующие элементы статуса. Во время загрузки
   * не пересобираем весь DOM: это убирает мерцание карточек и сброс скролла. */
  private updateStatus(): void {
    const phase = this.container.querySelector<HTMLElement>('.an2-load-prog-label');
    if (phase) phase.textContent = this.phase;
    const meta = this.container.querySelector<HTMLElement>('.an2-live-load-status');
    if (meta) meta.textContent = this._loadProgress
      ? `${this._loadProgress.done} из ${this._loadProgress.total} источников`
      : this.phase;
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
        ${this.settingsOpen ? renderSettingsDrawer(this.stores, settingsDb.manualList(), undefined, { ozon: this._ozonStoresRaw, status: this.perfStatus }) : ''}
      </div>
    `;
    // Сбрасываем body-html cache, чтобы следующий _paintBody действительно перерисовался
    this._lastBodyHtml = '';
    this._lastViewKey = `${this.tab}|${this.detail ?? ''}|${this.activitySubTab}`;
    if (this._freshTimer) clearTimeout(this._freshTimer);
    this._freshTimer = window.setTimeout(() => {
      this._freshTimer = 0;
      this.container.querySelector<HTMLElement>('.an2-body')?.classList.remove('an2-fresh');
    }, 700);
  }

  /** Обновляет только .an2-body без пересоздания шапки/дроуеров.
   *  Оптимизация: skip innerHTML если контент идентичный — браузер всё равно
   *  делает reflow/parse даже на "тот же" HTML. Экономит 50-200мс на body-repaint. */
  private _paintBody(): void {
    const root = this.container.querySelector<HTMLElement>('.an2');
    const body = this.container.querySelector<HTMLElement>('.an2-body');
    if (!root || !body) { this._paintFull(); return; }
    const busy = this.loading || this.syncing;

    // Вступительная анимация карточек проигрывается только когда пользователь
    // реально сменил экран. Раньше класс висел всегда, а `innerHTML` пересоздаёт
    // узлы при каждой перерисовке — и карточки заново «въезжали» на каждый тик
    // прогресса синка, на каждый ввод в поиске, на каждый фильтр. Это и был
    // тот самый дёрганый дашборд.
    const viewKey = `${this.tab}|${this.detail ?? ''}|${this.activitySubTab}`;
    const viewChanged = viewKey !== this._lastViewKey;
    this._lastViewKey = viewKey;

    const newClass = `an2-body${busy ? ' is-loading' : ''}${viewChanged ? ' an2-fresh' : ''}`;
    const newHtml  = this._tabContent();

    if (body.className === newClass && this._lastBodyHtml === newHtml) {
      // Контент идентичен — пропускаем DOM-операцию полностью.
      return;
    }
    body.className = newClass;
    body.innerHTML = newHtml;
    this._lastBodyHtml = newHtml;

    // Снимаем разрешение на анимацию, как только она отыграла: следующий
    // перерисовыв этого же экрана пройдёт уже без въезда.
    if (viewChanged) {
      if (this._freshTimer) clearTimeout(this._freshTimer);
      this._freshTimer = window.setTimeout(() => {
        this._freshTimer = 0;
        this.container.querySelector<HTMLElement>('.an2-body')?.classList.remove('an2-fresh');
      }, 700);
    }
  }
  private _lastBodyHtml = '';
  private _lastViewKey = '';
  private _freshTimer = 0;

  private renderHeader(): string {
    const calendar: Array<[PeriodPreset, string]> = [
      ['1', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя'], ['prev_week', 'Пр. неделя'], ['month', 'Месяц'], ['prev_month', 'Пр. месяц'],
    ];
    const rolling: Array<[PeriodPreset, string]> = [
      ['7', '7д'], ['30', '30д'], ['90', '90д'], ['180', '6м'], ['365', '12м'], ['all', 'С начала'],
    ];
    const periodBtn = ([v, l]: [PeriodPreset, string]) => `
      <button class="an2-period-btn ${this.period === v ? 'active' : ''}" onclick="window.analyticsModule?.setPeriod('${v}')">${l}</button>`;

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
          ${tabBtn('unit',     'Юнит-экономика')}
          ${tabBtn('orders',   'Заказы',  this.orders.length || undefined)}
          ${tabBtn('products', 'Товары')}
          ${tabBtn('activity', 'Активность')}
          ${tabBtn('balance',  'Баланс')}
        </div>

        <div class="an2-period">
          ${calendar.map(periodBtn).join('')}
          <span class="an2-period-group">${rolling.map(periodBtn).join('')}</span>
          <button class="an2-period-btn ${this.period === 'custom' ? 'active' : ''}" onclick="window.analyticsModule?.setPeriod('custom')">…</button>
        </div>
        ${this.period === 'custom' ? `
          <div class="an2-period-custom">
            <input type="date" value="${this.customFrom}" onchange="window.analyticsModule?.setCustomDate('from', this.value)"/>
            <span style="color:var(--text3)">—</span>
            <input type="date" value="${this.customTo}" onchange="window.analyticsModule?.setCustomDate('to', this.value)"/>
          </div>
        ` : ''}

        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          ${this.stores.length && new Set(this.stores.map(s => s.mp)).size > 1 ? `
            <button class="an2-filter-chip ${this.selectedMp === 'all' ? 'on' : ''}" onclick="window.analyticsModule?.selectMp('all')" title="Сводный отчёт по всем площадкам и магазинам">
              Все площадки
            </button>` : ''}
          ${mps.filter(mp => !this.stores.length || this.stores.some(s => s.mp === mp)).map(mp => `
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

        <button class="an2-btn ghost" onclick="window.analyticsModule?.exportCurrent()" title="Скачать текущий отчёт в Excel" ${this.dataLoaded ? '' : 'disabled'}>Excel</button>

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

    // Когда последний раз подтягивали финотчёт для этого среза
    if (!this.loading && this.syncedAt) {
      const t = this.syncedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      parts.push(`<span class="an2-load-meta" title="Финансовый отчёт маркетплейса обновлён в ${t} по Москве">финотчёт ${t}</span>`);
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

  /** Чипы выбора магазина: «Все магазины» или один. */
  private _renderStoreSelector(): string {
    if (this.selectedMp === 'all') return '';
    const mpStores = this.stores.filter(s => s.mp === this.selectedMp);
    if (mpStores.length <= 1) return ''; // 0 или 1 магазин — фильтр не нужен
    return `
      <div class="an2-store-selector" title="Выберите магазин для анализа">
        <button class="an2-filter-chip ${this.selectedStore == null ? 'on' : ''}" onclick="window.analyticsModule?.selectStore('')">Все магазины</button>
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
    // an2-fresh — разрешение на вступительную анимацию. При полной отрисовке
    // экран собирается заново, поэтому она уместна; снимается таймером ниже.
    const status = this.loadError || this.loadWarning
      ? `<div class="an2-data-message ${this.loadError ? 'error' : 'warning'}">${escapeHtmlJson(this.loadError || this.loadWarning)}</div>`
      : '';
    return `<div class="an2-body${busy && this.dataLoaded ? ' is-loading' : ''} an2-fresh">${status}${this._tabContent()}</div>`;
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
    if (this.detail) {
      const store = this.stores.find(s => s.id === this.selectedStore);
      return renderDetail(this.detail, {
        kpi: this.kpi,
        prevKpi: this.prevKpi,
        orders: this.orders,
        ts: this.ts,
        periodLabel: this._periodLabel(),
        mp: this.selectedMp === 'all' ? (store?.mp ?? 'ozon') : this.selectedMp,
        storeName: store?.name ?? (this.selectedMp === 'all' ? 'Все площадки' : MP_LABEL[this.selectedMp]),
      });
    }
    switch (this.tab) {
      case 'summary':  return renderSummaryTab(this.kpi, this.orders, this.ts, this.prevKpi, this.missingCogs, this.periodCosts, this.manualEntries);
      case 'orders':   return renderOrdersTab(this.orders, this.ordersFilters);
      case 'products': return renderProductsTab(this.orders, this.productsFilters, this.periodCosts, this.manualEntries);
      case 'activity': return renderActivityTab(this.orders, this.activitySubTab);
      case 'unit': {
        if (this.unitKey !== this.loadedKey) { this.unitError = ''; void this.loadUnit(); }
        const scopeStores = this.rawInput?.stores ?? [];
        return renderUnitTab({
          result: this.unitKey === this.loadedKey ? this.unitResult : null,
          loading: this.unitLoading,
          error: this.unitError,
          settings: settingsDb.unitSettings(),
          periodLabel: `${this._scopeLabel()} · ${this._periodLabel()}`,
          updatedAt: this.unitUpdatedAt,
          sort: this.unitSort,
          perfConnected: this.unitRaw?.ads.source === 'performance',
          isOzon: scopeStores.some(s => s.mp === 'ozon'),
          historyLabel: this.unitRaw?.historyLabel ?? 'за 60 дней до периода',
        });
      }
      default: return '';
    }
  }

  private renderLoader(): string {
    const p = this._loadProgress;

    if (!p || p.total === 0) {
      return `
        <div class="an2-loader">
          <div class="an2-loader-ring"></div>
          <div class="an2-loader-text an2-live-load-status">${this.phase}</div>
        </div>
      `;
    }

    const pct = Math.min(100, Math.round((p.done / p.total) * 100));
    const hasErrors = p.errors > 0;
    return `
      <div class="an2-loader">
        <div class="an2-loader-ring"></div>
        <div class="an2-load-prog">
          <div class="an2-load-prog-label">${this.phase}</div>
          <div class="an2-load-prog-bar-wrap">
            <div class="an2-load-prog-bar" style="width:${pct}%"></div>
          </div>
          <div class="an2-load-prog-stats">
            <span class="an2-load-prog-done">${p.done} / ${p.total} мес.</span>
            ${p.cached  > 0 ? `<span class="an2-load-prog-cached">⚡ ${p.cached} из кэша</span>` : ''}
            ${p.fetched > 0 ? `<span class="an2-load-prog-api">↓ ${p.fetched} из API</span>` : ''}
            ${hasErrors     ? `<span class="an2-load-prog-err">⚠ ${p.errors} ошибок</span>` : ''}
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
    const mpNames: Record<string, string> = { ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс.Маркет' };
    const available = (['ozon', 'wb', 'yandex'] as const).filter(mp =>
      this.stores.some(s => s.mp === mp)
    );
    const buttons = available
      .map(mp => `<button class="an2-switch-mp-btn" onclick="window.analyticsModule?.selectMp('${mp}')">${mpNames[mp]}</button>`)
      .join('');
    return `
      <div class="an2-empty">
        <div class="emoji">${I.store()}</div>
        <h3>Нет магазинов для «${this.selectedMp === 'all' ? 'всех площадок' : mpNames[this.selectedMp]}»</h3>
        <p>У тебя нет подключённых магазинов на этом маркетплейсе. Переключись на другой:</p>
        ${buttons ? `<div class="an2-switch-mp-btns">${buttons}</div>` : ''}
      </div>
    `;
  }

  private renderOpenOrder(): string {
    const o = this.orders.find(x => (x.order_key ?? x.order_id) === this.openedOrderId)
           ?? this.prevOrders.find(x => (x.order_key ?? x.order_id) === this.openedOrderId);
    if (!o) {
      this.openedOrderId = null;
      return '';
    }
    return renderOrderDrawer(o);
  }
}

// Default export для совместимости с динамическим импортом из main.ts
export default AnalyticsModule;
