/**
 * Аналитика SimaDesk.
 *
 * Расчёты — чистые функции в services/ (покрыты тестами): сборка заказов из
 * живых заказов и финотчётов, KPI, ряды, товары, юнит-экономика.
 * Этот модуль — только состояние, загрузка и экран:
 *
 *   ┌ шапка: площадка · магазин · период · обновить · Excel · настройки ┐
 *   ├ вкладки: Обзор · Юнит-экономика · Товары · Заказы                  ┤
 *   ├ одна строка предупреждений (если есть)                            ┤
 *   └ содержимое вкладки                                                ┘
 *
 * Фильтры есть только в шапке и действуют на все вкладки сразу.
 * Внешний интерфейс для ассистента и навигации: show, hide, isDataLoaded,
 * kpi, orders, selectedMp, getAiSummary, selectMp, selectMpAndReload.
 */

import { debug } from '@/utils/debug';
import { mskRange, mskDayKey, mskCalendarRange, CalendarPreset, normalizeMpDate } from '@/utils/mpDate';
import { aiPage } from '@/services/aiPageContext';
import { financeSync } from '@/services/financeSync';
import { costPriceDb } from '@/services/costPriceDb';
import { companyService } from '@/services/companyService';
import { ozonDb } from '@/services/ozonDb';
import { ozonPerformanceApi, PerfCredentials } from '@/services/ozonPerformanceApi';

import {
  Mp, MP_LABEL, MP_SHORT, STATUS_LABEL, Order, KPI, TimeseriesPoint, PeriodPreset, StoreInfo, TaxModel,
  PeriodCost, ManualEntry, SkuPerformance,
} from './types';
import { aggregateOrders, AggregateInput } from './services/orderAggregator';
import { buildCogsResolver } from './services/cogsResolver';
import { computeKPI, computeTimeseries, computeMissingCogs, MissingCogsItem, computeSkuPerformance } from './services/kpiAggregator';
import { loadAllStores, buildProductMap, loadOrders, loadTransactions, QueryProgress } from './services/dataLoader';
import { settingsDb } from './services/settingsDb';
import { computeUnitEconomics, UnitEconResult, UnitEconSettings, UnitAdsInput, StoreTax } from './services/unitEconomics';
import { unitReportText, unitSheets } from './services/unitReport';
import { exportXlsx, exportJson, exportFileName, Sheet } from './services/exporter';

import { Tooltip, drawTimeChart, TimeSpec } from './ui/charts';
import { rub, pct, num, escapeHtml, dateTime, plural } from './ui/format';
import { renderOverview, chartSpec, ChartMetric } from './ui/views/overview';
import { renderUnit, UnitSortKey } from './ui/views/unit';
import { renderProducts, ProductsState, ProductsSort, PRODUCTS_PAGE } from './ui/views/products';
import { renderOrders, renderOrderDrawer, OrdersState, OrdersStatus, ORDERS_PAGE } from './ui/views/orders';
import { renderSettings, SettingsSection } from './ui/views/settings';

import './styles/analytics.css';

type Tab = 'overview' | 'unit' | 'products' | 'orders';
type MpSel = Mp | 'all';

const TABS: Array<[Tab, string]> = [
  ['overview', 'Обзор'], ['unit', 'Юнит-экономика'], ['products', 'Товары'], ['orders', 'Заказы'],
];

const PERIODS: Array<{ group: string; items: Array<[PeriodPreset, string]> }> = [
  { group: 'Календарь', items: [['1', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Эта неделя'], ['prev_week', 'Прошлая неделя'], ['month', 'Этот месяц'], ['prev_month', 'Прошлый месяц']] },
  { group: 'Последние', items: [['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['180', '6 месяцев'], ['365', '12 месяцев']] },
];
const CALENDAR = new Set(['yesterday', 'week', 'prev_week', 'month', 'prev_month']);

function readLS(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writeLS(key: string, v: string): void { try { localStorage.setItem(key, v); } catch { /* приватный режим */ } }

export class AnalyticsModule {
  private container: HTMLElement;
  private root: HTMLElement | null = null;
  private tip: Tooltip | null = null;
  private resizeObs: ResizeObserver | null = null;
  private resizeTimer = 0;
  private searchTimer = 0;

  // ── Фильтры ──
  private mp: MpSel = (() => {
    const v = readLS('an3_mp');
    return v === 'ozon' || v === 'wb' || v === 'yandex' || v === 'all' ? v : 'all';
  })();
  private storeId: string | null = readLS('an3_store') || null;
  private period: PeriodPreset = (readLS('an3_period') as PeriodPreset) || '30';
  private customFrom = '';
  private customTo = '';
  private tab: Tab = ((): Tab => {
    const v = readLS('an3_tab');
    return v === 'unit' || v === 'products' || v === 'orders' ? v : 'overview';
  })();

  // ── Данные ──
  private stores: StoreInfo[] = [];
  private companyId: string | null = null;
  private rawInput: AggregateInput | null = null;
  orders: Order[] = [];
  private periodCosts: PeriodCost[] = [];
  private manualEntries: ManualEntry[] = [];
  kpi: KPI | null = null;
  private ts: TimeseriesPoint[] = [];
  private skus: SkuPerformance[] = [];
  private missingCogs: MissingCogsItem[] = [];
  private byMp: Array<{ mp: Mp; kpi: KPI }> = [];
  private prevKpi: KPI | null = null;
  private prevTs: TimeseriesPoint[] | null = null;
  private prevOrders: Order[] | null = null;

  // ── Загрузка ──
  private requestId = 0;
  private controller: AbortController | null = null;
  private loadedKey = '';
  private loading = false;
  private dataLoaded = false;
  private phase = '';
  private progress: QueryProgress | null = null;
  private error = '';
  private warning = '';
  private updatedAt: Date | null = null;
  private syncedAt: Date | null = null;
  private syncTimes = new Map<string, number>();

  // ── Вкладки ──
  private metric: ChartMetric = 'revenue';
  private productsState: ProductsState = { search: '', sort: 'profit', dir: -1, limit: PRODUCTS_PAGE };
  private ordersState: OrdersState = { status: 'all', search: '', limit: ORDERS_PAGE };
  private openedOrder: string | null = null;
  private settingsOpen = false;
  private settingsSection: SettingsSection = 'tax';
  private ozonStoresRaw: Array<{ id: string; name: string; perf: boolean }> = [];
  private perfStatus = new Map<string, { ok: boolean; text: string }>();
  private perfKeys = new Map<string, { clientId: string; clientSecret: string }>();

  // ── Юнит-экономика ──
  private unitResult: UnitEconResult | null = null;
  private unitKey = '';
  private unitLoading = false;
  private unitError = '';
  private unitSort: { key: UnitSortKey; dir: 1 | -1 } = { key: 'orderedRevenue', dir: -1 };
  private unitRaw: { history: Order[]; ads: UnitAdsInput; fbs: UnitEconResult['fbs']; historyLabel: string; warnings: string[] } | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  // ═══════════════════════ Внешний интерфейс ═══════════════════════

  get isDataLoaded(): boolean { return this.dataLoaded; }
  get selectedMp(): MpSel { return this.mp; }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.mount();
    const cid = companyService.getActiveId();
    if (this.companyId !== cid) {
      this.controller?.abort();
      this.requestId++;
      this.companyId = cid;
      this.dataLoaded = false;
      this.loadedKey = '';
      this.rawInput = null;
      this.kpi = null;
      this.orders = [];
      this.stores = [];
    }
    if (!this.stores.length) {
      this.phase = 'Загружаем магазины…';
      this.render();
      try {
        this.stores = await loadAllStores();
      } catch (e) {
        this.error = 'Не удалось загрузить магазины. ' + (e instanceof Error ? e.message : String(e));
        this.render();
        return;
      }
      if (cid !== companyService.getActiveId()) return;
      this.fixSelection();
    }
    if (!this.dataLoaded || !this.updatedAt || Date.now() - this.updatedAt.getTime() > 5 * 60_000) {
      await this.refresh();
    } else {
      this.registerAi();
      this.render();
    }
  }

  hide(): void {
    this.container.style.display = 'none';
    this.controller?.abort();
    this.requestId++;
    this.loading = false;
    this.unitLoading = false;
    this.tip?.hide();
    aiPage.clear('analytics');
  }

  /** Текстовая сводка для ассистента. */
  getAiSummary(): string {
    if (!this.dataLoaded || !this.kpi) return '';
    const k = this.kpi;
    const lines = [
      `Площадка: ${this.scopeLabel()} · Период: ${this.periodLabel()}`,
      `База расчёта денег — выкупленные заказы с финотчётом маркетплейса.`,
      `Выручка: ${rub(k.revenue)} | Заказано: ${rub(k.ordered_revenue)} | В пути: ${rub(k.in_transit_revenue)} | Ждут расчёта: ${rub(k.awaiting_revenue)}`,
      `Чистая прибыль: ${rub(k.net_profit)} | Маржа: ${pct(k.margin_pct)} | Средний чек: ${rub(k.avg_check)}`,
      `Заказов: ${num(k.orders_total)} (доставлено ${num(k.orders_delivered)}, в пути ${num(k.orders_processing)}, возвратов ${num(k.orders_returned)}, отмен ${num(k.orders_cancelled)}) | Выкуп: ${pct(k.buyout_pct)}`,
      `Комиссии: ${rub(k.commission)} | Логистика: ${rub(k.logistics)} | Услуги: ${rub(k.services)} | Реклама/хранение/штрафы: ${rub(k.period_costs)} | Свои расходы: ${rub(k.manual_costs)} | Себестоимость: ${rub(k.cogs)} | Налоги: ${rub(k.tax)}`,
    ];
    const top = [...this.skus].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    if (top.length) {
      lines.push('Топ-5 товаров по выручке:');
      top.forEach((s, i) => lines.push(`  ${i + 1}. [${MP_SHORT[s.mp]}] ${s.vendor_code} «${s.name}» — ${rub(s.revenue)}, ${num(s.units_sold)} шт, прибыль ${rub(s.net_profit)}, маржа ${pct(s.margin_pct)}`));
    }
    return lines.join('\n');
  }

  selectMp(mp: MpSel): void {
    if (this.mp === mp) return;
    this.mp = mp;
    writeLS('an3_mp', mp);
    this.storeId = null;
    writeLS('an3_store', '');
    this.refresh();
  }

  /** Переключить площадку и дождаться данных (для ассистента). */
  async selectMpAndReload(mp: Mp): Promise<void> {
    if (this.mp !== mp) {
      this.mp = mp;
      writeLS('an3_mp', mp);
      this.storeId = null;
      this.dataLoaded = false;
    }
    if (this.dataLoaded) return;
    const deadline = Date.now() + 20_000;
    while (this.loading && Date.now() < deadline) await new Promise(r => setTimeout(r, 120));
    if (!this.dataLoaded) await this.refresh();
  }

  // ═══════════════════════ Период и выбор ═══════════════════════

  private getRange(): { start: Date; end: Date } {
    if (this.period === 'custom' && this.customFrom && this.customTo) {
      return { start: new Date(`${this.customFrom}T00:00:00.000+03:00`), end: new Date(`${this.customTo}T23:59:59.999+03:00`) };
    }
    if (CALENDAR.has(this.period)) return mskCalendarRange(this.period as CalendarPreset);
    return mskRange(parseInt(this.period) || 30);
  }

  private getPrevRange(): { start: Date; end: Date } {
    const r = this.getRange();
    const len = r.end.getTime() - r.start.getTime();
    return { start: new Date(r.start.getTime() - len - 1), end: new Date(r.start.getTime() - 1) };
  }

  private periodLabel(): string {
    const { start, end } = this.getRange();
    const d = (x: Date) => mskDayKey(x.toISOString()).split('-').reverse().join('.');
    const span = mskDayKey(start.toISOString()) === mskDayKey(end.toISOString()) ? d(start) : `${d(start)} — ${d(end)}`;
    const name = PERIODS.flatMap(g => g.items).find(([v]) => v === this.period)?.[1];
    return name ? `${name.toLowerCase()} (${span})` : span;
  }

  private scopeStores(): StoreInfo[] {
    let pool = this.mp === 'all' ? this.stores : this.stores.filter(s => s.mp === this.mp);
    if (this.storeId) pool = pool.filter(s => s.id === this.storeId);
    return pool;
  }

  private scopeLabel(): string {
    const st = this.stores.find(s => s.id === this.storeId);
    if (st) return `${MP_LABEL[st.mp]} · ${st.name}`;
    return this.mp === 'all' ? 'Все площадки' : MP_LABEL[this.mp];
  }

  /** Сохранённый выбор мог устареть: площадку отключили, магазин удалили. */
  private fixSelection(): void {
    const mps = new Set(this.stores.map(s => s.mp));
    if (this.mp !== 'all' && !mps.has(this.mp)) this.mp = mps.size === 1 ? [...mps][0] : 'all';
    if (this.storeId && !this.scopeStores().some(s => s.id === this.storeId)) this.storeId = null;
    if (this.storeId && !this.stores.some(s => s.id === this.storeId)) this.storeId = null;
  }

  private queryKey(): string {
    const { start, end } = this.getRange();
    return `${companyService.getActiveId()}|${this.mp}|${this.scopeStores().map(s => s.id).sort()}|${start.toISOString()}|${end.toISOString()}`;
  }

  setPeriod(p: string): void {
    if (p === 'custom') {
      this.period = 'custom';
      if (!this.customFrom || !this.customTo) {
        const r = this.getRangeFor('30');
        this.customFrom = mskDayKey(r.start.toISOString());
        this.customTo = mskDayKey(r.end.toISOString());
      }
      this.render();
      this.refresh();
      return;
    }
    this.period = p as PeriodPreset;
    writeLS('an3_period', p);
    this.refresh();
  }

  private getRangeFor(p: string): { start: Date; end: Date } {
    return CALENDAR.has(p) ? mskCalendarRange(p as CalendarPreset) : mskRange(parseInt(p) || 30);
  }

  setCustomDate(which: 'from' | 'to', value: string): void {
    if (which === 'from') this.customFrom = value; else this.customTo = value;
    if (this.customFrom && this.customTo) this.refresh();
  }

  selectStore(id: string): void {
    this.storeId = id || null;
    writeLS('an3_store', id || '');
    this.refresh();
  }

  setTab(t: Tab): void {
    if (this.tab === t) return;
    this.tab = t;
    writeLS('an3_tab', t);
    this.tip?.hide();
    if (t === 'unit') void this.loadUnit();
    this.render();
    this.root?.querySelector('.an-body')?.scrollTo({ top: 0 });
  }

  // ═══════════════════════ Загрузка ═══════════════════════

  /** Финотчёт часто приходит через дни после заказа — берём запас вокруг периода. */
  private settlementRange(start: Date, end: Date): { start: Date; end: Date } {
    const pad = 45 * 86_400_000;
    return { start: new Date(start.getTime() - pad), end: new Date(Math.min(end.getTime() + pad, Date.now())) };
  }

  async refresh(forceSync = false): Promise<void> {
    const id = ++this.requestId;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    this.fixSelection();
    const scope = this.scopeStores();
    const storeIds = new Set(scope.map(s => s.id));
    const key = this.queryKey();
    const { start, end } = this.getRange();
    if (start > end) { this.error = 'Начало периода позже конца'; this.render(); return; }
    if (key !== this.loadedKey) { this.prevKpi = null; this.prevTs = null; this.prevOrders = null; this.openedOrder = null; }

    this.loading = true;
    this.error = '';
    this.warning = '';
    this.progress = null;
    this.phase = 'Обновляем финотчёт маркетплейса…';
    this.render();

    if (!storeIds.size) {
      this.loading = false;
      this.dataLoaded = true;
      this.loadedKey = key;
      this.kpi = null;
      this.render();
      return;
    }

    try {
      const txRange = this.settlementRange(start, end);
      const syncKey = `${key}|finance`;
      const last = this.syncTimes.get(syncKey);
      if (forceSync || !last || Date.now() - last > 10 * 60_000) {
        const failures: string[] = [];
        for (const m of new Set(scope.map(s => s.mp))) {
          const ids = new Set(scope.filter(s => s.mp === m).map(s => s.id));
          try {
            await financeSync.syncSelected(m, ids, txRange.start.toISOString(), txRange.end.toISOString(), controller.signal);
          } catch (e) {
            if (controller.signal.aborted) return;
            failures.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (id !== this.requestId) return;
        if (failures.length) this.warning = `${failures.join(' · ')}. Показаны ранее сохранённые операции.`;
        else this.syncTimes.set(syncKey, Date.now());
      }

      this.phase = 'Загружаем заказы и себестоимость…';
      this.updateProgress();
      const [live, txs, products] = await Promise.all([
        loadOrders(start, end, storeIds, controller.signal, p => {
          if (id !== this.requestId) return;
          this.progress = p;
          this.updateProgress();
        }),
        loadTransactions([...storeIds], txRange.start, txRange.end),
        buildProductMap(storeIds),
        costPriceDb.refresh(),
      ]);
      if (id !== this.requestId || controller.signal.aborted) return;
      const prog = this.progress as QueryProgress | null;
      if (prog && prog.errors > 0) this.warning = `${this.warning} Часть заказов не загрузилась — итоги неполные, нажмите «Обновить».`.trim();

      this.rawInput = { ...live, transactions: txs, stores: scope, products, cogs: buildCogsResolver(), periodStart: start, periodEnd: end };
      this.loadedKey = key;
      this.syncedAt = this.syncTimes.has(syncKey) ? new Date(this.syncTimes.get(syncKey)!) : this.syncedAt;
      this.updatedAt = new Date();
      this.applySnapshot();
      this.dataLoaded = true;
      this.registerAi();
      void this.loadPrev(id, key);
      if (this.tab === 'unit') void this.loadUnit();
    } catch (e) {
      if (id !== this.requestId || controller.signal.aborted) return;
      this.error = 'Не удалось загрузить аналитику. ' + (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === this.requestId) {
        this.loading = false;
        this.render();
      }
    }
  }

  syncFinances(): void { void this.refresh(true); }

  /** Пересчитать всё из уже загруженных данных (после смены налога, себестоимости). */
  private applySnapshot(): void {
    if (!this.rawInput) return;
    const agg = aggregateOrders(this.rawInput);
    this.orders = agg.orders;
    this.periodCosts = agg.periodCosts;
    const known = new Set([...this.rawInput.products.values()].map(p => p.vendor_code.trim().toLowerCase()));
    this.missingCogs = computeMissingCogs(this.orders, known);
    this.recompute();
  }

  private recompute(): void {
    const { start, end } = this.getRange();
    const scopeIds = new Set(this.scopeStores().map(s => s.id));
    this.manualEntries = this.manualFor(start, end, scopeIds);
    this.kpi = computeKPI(this.orders, this.periodCosts, this.manualEntries);
    this.ts = computeTimeseries(this.orders, start, end, this.periodCosts, this.manualEntries);
    this.skus = computeSkuPerformance(this.orders, this.periodCosts, this.manualEntries);
    this.byMp = [];
    if (this.mp === 'all') {
      for (const m of ['ozon', 'wb', 'yandex'] as Mp[]) {
        const o = this.orders.filter(x => x.mp === m);
        if (!o.length) continue;
        const ids = new Set(this.stores.filter(s => s.mp === m).map(s => s.id));
        this.byMp.push({ mp: m, kpi: computeKPI(o, this.periodCosts.filter(c => c.mp === m), this.manualFor(start, end, ids, m)) });
      }
    }
    if (this.unitRaw && this.unitKey === this.loadedKey) this.computeUnit();
  }

  /** Ручные записи, попадающие в период и выбранные магазины. */
  private manualFor(start: Date, end: Date, storeIds: Set<string>, onlyMp?: Mp): ManualEntry[] {
    const from = mskDayKey(start.toISOString()), to = mskDayKey(end.toISOString());
    return settingsDb.manualList().filter(e => {
      const day = e.date.length === 10 ? e.date : mskDayKey(e.date);
      if (!day || day < from || day > to) return false;
      if (e.store_id && !storeIds.has(e.store_id)) return false;
      const mpFilter = onlyMp ?? (this.mp === 'all' ? null : this.mp);
      if (onlyMp && !e.mp && !e.store_id) return false;   // общие расходы не делим по площадкам
      if (e.mp && mpFilter && e.mp !== mpFilter) return false;
      return true;
    });
  }

  /** Прошлый период такой же длины — для сравнения на плитках и графике. */
  private async loadPrev(id: number, key: string): Promise<void> {
    if (!this.rawInput) return;
    const { start, end } = this.getPrevRange();
    const input = this.rawInput;
    try {
      const range = this.settlementRange(start, end);
      const ids = new Set(input.stores.map(s => s.id));
      const [live, transactions] = await Promise.all([
        loadOrders(start, end, ids, this.controller?.signal),
        loadTransactions([...ids], range.start, range.end),
      ]);
      if (id !== this.requestId || key !== this.loadedKey) return;
      const agg = aggregateOrders({ ...input, ...live, transactions, periodStart: start, periodEnd: end });
      const manual = this.manualFor(start, end, ids);
      this.prevOrders = agg.orders;
      this.prevKpi = computeKPI(agg.orders, agg.periodCosts, manual);
      this.prevTs = computeTimeseries(agg.orders, start, end, agg.periodCosts, manual);
      if (this.tab === 'overview') this.render();
    } catch (e) {
      debug.warn('[Analytics] previous period not loaded', e);
    }
  }

  // ═══════════════════════ Юнит-экономика ═══════════════════════

  private liveInRange(live: Pick<AggregateInput, 'ozonPostings' | 'yandexOrders' | 'wbOrders'>, from: Date, to: Date) {
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

  async loadUnit(force = false): Promise<void> {
    if (!this.rawInput || !this.dataLoaded) return;
    const key = this.loadedKey;
    if (!force && this.unitKey === key && (this.unitResult || this.unitLoading)) return;
    const id = this.requestId;
    const input = this.rawInput;
    this.unitKey = key;
    this.unitLoading = true;
    this.unitError = '';
    if (force || !this.unitRaw) this.unitResult = null;
    this.render();
    try {
      const { start, end } = this.getRange();
      const storeIds = new Set(input.stores.map(s => s.id));
      // Опорное окно: 60 дней, закончившиеся за 10 дней до периода — заказы в нём уже закрылись.
      const hEnd = new Date(start.getTime() - 10 * 86_400_000 - 1);
      const hStart = new Date(hEnd.getTime() - 60 * 86_400_000 + 1);
      const txRange = this.settlementRange(hStart, hEnd);

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

      const hist = aggregateOrders({ ...input, ...this.liveInRange(live, hStart, hEnd), transactions: txs, periodStart: hStart, periodEnd: hEnd });

      // FBS: отправления, переданные в доставку в периоде (созданы могли раньше).
      let fbs: UnitEconResult['fbs'] = null;
      if (input.stores.some(s => s.mp === 'ozon')) {
        const list = live.ozonPostings.filter(p => {
          if (p.delivery_scheme !== 'fbs' && p.delivery_scheme !== 'rfbs') return false;
          const handed = p.delivering_date ?? (p.status === 'delivering' || p.status === 'delivered' ? p.shipment_date : null);
          const t = Date.parse(normalizeMpDate(handed ?? ''));
          return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
        });
        fbs = {
          postings: list.length,
          units: list.reduce((s, p) => s + p.products.reduce((a, x) => a + x.quantity, 0), 0),
          revenue: list.reduce((s, p) => s + p.products.reduce((a, x) => a + (parseFloat(x.price) || 0) * x.quantity, 0), 0),
        };
      }

      // Реклама: кабинет Ozon Performance → иначе финотчёт; плюс ручные записи.
      const perfStores = ozStores.filter(s => storeIds.has(s.id) && s.perf_client_id && s.perf_client_secret);
      const ads: UnitAdsInput = { source: 'none', campaigns: [], unassigned: 0 };
      const warnings: string[] = [];
      for (const st of perfStores) {
        try {
          const cred: PerfCredentials = { storeId: st.id, clientId: st.perf_client_id!, clientSecret: st.perf_client_secret! };
          const r = await ozonPerformanceApi.spend(cred, start, end, this.controller?.signal);
          ads.campaigns.push(...r.campaigns);
          ads.source = 'performance';
        } catch (e) {
          warnings.push(`Реклама Ozon (${st.name}) не получена — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const perfIds = new Set(ads.source === 'performance' ? perfStores.map(s => s.id) : []);
      const financeAds = this.periodCosts.filter(c => c.kind === 'advertising' && !perfIds.has(c.store_id)).reduce((s, c) => s + c.amount, 0)
        + this.orders.filter(o => !perfIds.has(o.store_id))
          .reduce((s, o) => s + o.fee_breakdown.filter(f => f.type === 'advertising').reduce((a, f) => a + f.amount, 0), 0);
      const manualAds = this.manualEntries.filter(e => e.type === 'advertising').reduce((s, e) => s + e.amount, 0);
      ads.unassigned = financeAds + manualAds;
      if (ads.source === 'none') ads.source = financeAds > 0 ? 'finance' : manualAds > 0 ? 'manual' : 'none';

      const dm = (d: Date) => mskDayKey(d.toISOString()).split('-').reverse().join('.');
      this.unitRaw = { history: hist.orders, ads, fbs, historyLabel: `за ${dm(hStart)} — ${dm(hEnd)}`, warnings };
      this.computeUnit();
    } catch (e) {
      if (id !== this.requestId) return;
      this.unitError = 'Не удалось посчитать юнит-экономику. ' + (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === this.requestId) {
        this.unitLoading = false;
        if (this.tab === 'unit') this.render();
      }
    }
  }

  private taxByStore(): Record<string, StoreTax> {
    const out: Record<string, StoreTax> = {};
    for (const s of this.rawInput?.stores ?? []) {
      const st = this.stores.find(x => x.id === s.id) ?? s;
      out[s.id] = { model: st.tax_model, rate: st.tax_rate, vat: st.vat_rate ?? 0 };
    }
    return out;
  }

  private computeUnit(): void {
    if (!this.unitRaw) return;
    const r = computeUnitEconomics({
      orders: this.orders, history: this.unitRaw.history, periodCosts: this.periodCosts,
      ads: this.unitRaw.ads, taxByStore: this.taxByStore(), settings: settingsDb.unitSettings(), fbs: this.unitRaw.fbs,
    });
    for (const w of this.unitRaw.warnings) r.nuances.unshift({ level: 'warn', text: w });
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
    }
    settingsDb.saveUnitSettings(patch);
    this.computeUnit();
    this.render();
  }

  setUnitSort(key: UnitSortKey): void {
    this.unitSort = this.unitSort.key === key ? { key, dir: this.unitSort.dir === -1 ? 1 : -1 } : { key, dir: -1 };
    this.render();
  }

  async copyUnitReport(btn?: HTMLElement): Promise<void> {
    if (!this.unitResult) return;
    const text = unitReportText(this.unitResult, `${this.scopeLabel()} · ${this.periodLabel()}`);
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = 'Скопировано ✓'; setTimeout(() => { btn.textContent = t; }, 1500); }
    } catch { window.prompt('Скопируйте отчёт:', text); }
  }

  async exportUnit(kind: 'xlsx' | 'json'): Promise<void> {
    if (!this.unitResult) return;
    const title = `${this.scopeLabel()} · ${this.periodLabel()}`;
    if (kind === 'json') {
      exportJson(exportFileName('unit-economics', 'json'), { title, generated_at: new Date().toISOString(), settings: settingsDb.unitSettings(), ...this.unitResult });
      return;
    }
    await exportXlsx(exportFileName('unit-economics', 'xlsx'), unitSheets(this.unitResult, title));
  }

  // ═══════════════════════ Действия вкладок ═══════════════════════

  setMetric(m: ChartMetric): void { this.metric = m; this.render(); }

  setProductsSearch(v: string): void {
    this.productsState = { ...this.productsState, search: v, limit: PRODUCTS_PAGE };
    this.debouncedRender();
  }
  sortProducts(key: ProductsSort): void {
    const s = this.productsState;
    this.productsState = { ...s, sort: key, dir: s.sort === key ? (s.dir === -1 ? 1 : -1) : -1 };
    this.render();
  }
  showMoreProducts(): void { this.productsState = { ...this.productsState, limit: this.productsState.limit + PRODUCTS_PAGE }; this.render(); }

  setOrdersStatus(s: OrdersStatus): void { this.ordersState = { ...this.ordersState, status: s, limit: ORDERS_PAGE }; this.render(); }
  setOrdersSearch(v: string): void {
    this.ordersState = { ...this.ordersState, search: v, limit: ORDERS_PAGE };
    this.debouncedRender();
  }
  showMoreOrders(): void { this.ordersState = { ...this.ordersState, limit: this.ordersState.limit + ORDERS_PAGE }; this.render(); }

  openOrder(key: string): void { this.openedOrder = key; this.renderOverlay(); }
  closeOrder(): void { this.openedOrder = null; this.renderOverlay(); }

  // ── Настройки ──
  async openSettings(section?: SettingsSection): Promise<void> {
    this.settingsOpen = true;
    if (section) this.settingsSection = section;
    this.renderOverlay();
    try {
      const list = await ozonDb.getStores();
      this.ozonStoresRaw = list.map(s => ({ id: s.id, name: s.name, perf: !!(s.perf_client_id && s.perf_client_secret) }));
      if (this.settingsOpen) this.renderOverlay();
    } catch (e) { debug.warn('[Analytics] ozon stores for settings', e); }
  }
  closeSettings(): void { this.settingsOpen = false; this.renderOverlay(); }
  setSettingsSection(s: SettingsSection): void { this.settingsSection = s; this.renderOverlay(); }
  openCostEditor(): void { void this.openSettings('cogs'); }

  setTax(storeId: string, field: 'model' | 'rate' | 'vat', value: string): void {
    const st = this.stores.find(s => s.id === storeId);
    if (!st) return;
    const model = field === 'model' ? value as TaxModel : st.tax_model;
    const rate = field === 'rate' ? Number(value) / 100 : st.tax_rate;
    const vat = field === 'vat' ? Number(value) / 100 : (st.vat_rate ?? 0);
    if (![rate, vat].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return;
    settingsDb.setStoreTax(storeId, model, rate, vat);
    this.stores = this.stores.map(s => s.id === storeId ? { ...s, tax_model: model, tax_rate: rate, vat_rate: vat } : s);
    if (this.rawInput) this.rawInput = { ...this.rawInput, stores: this.rawInput.stores.map(s => this.stores.find(x => x.id === s.id) ?? s) };
    this.applySnapshot();
    this.render();
  }

  setCostPrice(vendorCode: string, value: string | number): void {
    const price = Number(value);
    if (!vendorCode || !Number.isFinite(price) || price < 0) return;
    costPriceDb.set(vendorCode, price);
    if (this.rawInput) this.rawInput = { ...this.rawInput, cogs: buildCogsResolver() };
    this.applySnapshot();
    this.render();
  }

  addManualEntry(form: HTMLFormElement): void {
    const fd = new FormData(form);
    const amount = parseFloat(String(fd.get('amount') ?? '0'));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const day = String(fd.get('date') || '') || mskDayKey(new Date().toISOString());
    settingsDb.manualAdd({
      type: (fd.get('type') as ManualEntry['type']) ?? 'other_expense',
      amount, amount_native: amount, currency: 'RUB', fx_rate: 1, date: day,
      store_id: this.storeId ?? undefined,
      mp: this.mp === 'all' ? undefined : this.mp,
      description: String(fd.get('description') ?? ''),
    });
    this.recompute();
    this.render();
  }

  deleteManualEntry(id: string): void {
    if (!confirm('Удалить запись?')) return;
    settingsDb.manualDelete(id);
    this.recompute();
    this.render();
  }

  setPerfKey(storeId: string, field: 'clientId' | 'clientSecret', value: string): void {
    const cur = this.perfKeys.get(storeId) ?? { clientId: '', clientSecret: '' };
    cur[field] = value.trim();
    this.perfKeys.set(storeId, cur);
  }

  async savePerfKeys(storeId: string): Promise<void> {
    const keys = this.perfKeys.get(storeId);
    const st = (await ozonDb.getStores().catch(() => [])).find(s => s.id === storeId);
    const clientId = keys?.clientId || st?.perf_client_id || '';
    const clientSecret = keys?.clientSecret || st?.perf_client_secret || '';
    if (!clientId || !clientSecret) {
      this.perfStatus.set(storeId, { ok: false, text: 'Укажите client_id и client_secret' });
      this.renderOverlay();
      return;
    }
    this.perfStatus.set(storeId, { ok: true, text: 'Проверяем…' });
    this.renderOverlay();
    try {
      const n = await ozonPerformanceApi.check({ storeId, clientId, clientSecret });
      await ozonDb.updateStore(storeId, { perf_client_id: clientId, perf_client_secret: clientSecret });
      this.perfStatus.set(storeId, { ok: true, text: `Подключено · кампаний: ${n}` });
      this.ozonStoresRaw = this.ozonStoresRaw.map(x => x.id === storeId ? { ...x, perf: true } : x);
      this.perfKeys.delete(storeId);
      this.unitKey = '';
      if (this.tab === 'unit') void this.loadUnit(true);
    } catch (e) {
      this.perfStatus.set(storeId, { ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    this.renderOverlay();
  }

  async clearPerfKeys(storeId: string): Promise<void> {
    try {
      await ozonDb.updateStore(storeId, { perf_client_id: null, perf_client_secret: null });
      this.perfStatus.set(storeId, { ok: true, text: 'Ключи удалены' });
      this.ozonStoresRaw = this.ozonStoresRaw.map(x => x.id === storeId ? { ...x, perf: false } : x);
      this.unitKey = '';
    } catch (e) {
      this.perfStatus.set(storeId, { ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    this.renderOverlay();
  }

  // ── Excel ──
  async exportCurrent(): Promise<void> {
    if (this.tab === 'unit') return this.exportUnit('xlsx');
    const k = this.kpi;
    if (!k) return;
    const title = `${this.scopeLabel()} · ${this.periodLabel()}`;
    const share = (v: number) => k.revenue ? v / k.revenue * 100 : null;
    const sheets: Sheet[] = [
      {
        name: 'Итоги',
        rows: [
          ['Показатель', 'Сумма, ₽', '% выручки'],
          ['Период', title, null],
          ['Выручка (выкуплено)', k.revenue, 100],
          ['Комиссия маркетплейса', -k.commission, share(k.commission)],
          ['Логистика', -k.logistics, share(k.logistics)],
          ['Услуги по заказам', -k.services, share(k.services)],
          ['Реклама, хранение, штрафы', -k.period_costs, share(k.period_costs)],
          ['Свои расходы', -k.manual_costs, share(k.manual_costs)],
          ['Себестоимость', -k.cogs, share(k.cogs)],
          ['Налоги (вкл. НДС)', -k.tax, share(k.tax)],
          ['Чистая прибыль', k.net_profit, k.margin_pct],
          [],
          ['Заказано за период', k.ordered_revenue, null],
          ['В пути', k.in_transit_revenue, null],
          ['Ждут расчёта', k.awaiting_revenue, null],
          ['Заказов', k.orders_total, null],
          ['Доставлено', k.orders_delivered, null],
          ['Возвратов', k.orders_returned, null],
          ['Отмен', k.orders_cancelled, null],
          ['Выкуп, %', k.buyout_pct, null],
          ['Средний чек', k.avg_check, null],
        ],
        formats: { 1: 'money', 2: 'pct' },
      },
      { name: 'По дням', rows: [['Дата', 'Выручка', 'Расходы', 'Прибыль'], ...this.ts.map(p => [p.date, p.revenue, p.expenses, p.profit])], formats: { 1: 'money', 2: 'money', 3: 'money' } },
      {
        name: 'Товары',
        rows: [['Площадка', 'Артикул', 'Название', 'Продано, шт', 'Возвращено, шт', 'Отменено, шт', 'Выручка', 'Комиссия', 'Логистика', 'Услуги', 'Налоги', 'Себестоимость', 'Общие расходы', 'Прибыль', 'Прибыль/шт', 'Маржа, %'],
          ...this.skus.map(x => [MP_LABEL[x.mp], x.vendor_code, x.name, x.units_sold, x.units_returned, x.units_cancelled, x.revenue, x.commission, x.logistics, x.services, x.tax, x.cogs, x.period_costs + x.manual_costs, x.net_profit, x.profit_per_unit, x.margin_pct])],
        formats: { 6: 'money', 7: 'money', 8: 'money', 9: 'money', 10: 'money', 11: 'money', 12: 'money', 13: 'money', 14: 'money2', 15: 'pct' },
      },
      {
        name: 'Заказы',
        rows: [['Дата', 'Заказ', 'Площадка', 'Магазин', 'Статус', 'Артикулы', 'Шт', 'Выручка', 'Упущено', 'Комиссия', 'Логистика', 'Обр. логистика', 'Услуги', 'Себестоимость', 'Налог', 'Прибыль', 'Перечислено МП', 'Финотчёт'],
          ...this.orders.filter(o => !o.is_orphan).map(o => [dateTime(o.date), o.order_id, MP_LABEL[o.mp], o.store_name, STATUS_LABEL[o.status],
            o.items.map(i => i.vendor_code).join(', '), o.items.reduce((s, i) => s + i.quantity, 0), o.revenue, o.revenue_lost,
            o.commission, o.logistics, o.logistics_return, o.services, o.cogs, o.tax, o.net_profit, o.payout_actual, o.source === 'real' ? 'да' : 'нет'])],
        formats: { 7: 'money', 8: 'money', 9: 'money', 10: 'money', 11: 'money', 12: 'money', 13: 'money', 14: 'money', 15: 'money', 16: 'money' },
      },
    ];
    await exportXlsx(exportFileName('analytics', 'xlsx'), sheets);
  }

  // ═══════════════════════ Экран ═══════════════════════

  private mount(): void {
    if (this.root && this.container.contains(this.root)) return;
    this.container.innerHTML = `
      <div class="an">
        <div class="an-head"></div>
        <div class="an-body"></div>
        <div class="an-overlay"></div>
      </div>`;
    this.root = this.container.querySelector('.an');
    this.tip?.destroy();
    this.tip = new Tooltip(document.body);
    // Подсказки для HTML-графиков (столбцы, сегменты): одна делегированная подписка.
    this.root!.addEventListener('pointermove', (ev) => {
      const t = (ev.target as Element)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!t) { if (!(ev.target as Element)?.closest?.('.an-svg')) this.tip?.hide(); return; }
      this.tip?.show(ev.clientX, ev.clientY, t.dataset.tip ?? '', []);
    });
    this.root!.addEventListener('pointerleave', () => this.tip?.hide());
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || this.container.style.display === 'none') return;
      if (this.openedOrder) this.closeOrder();
      else if (this.settingsOpen) this.closeSettings();
    });
    this.resizeObs = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.drawCharts(), 120);
    });
    this.resizeObs.observe(this.root!);
  }

  private debouncedRender(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.render(), 200);
  }

  render(): void {
    if (!this.root) this.mount();
    const head = this.root!.querySelector<HTMLElement>('.an-head')!;
    const body = this.root!.querySelector<HTMLElement>('.an-body')!;
    // Сохраняем фокус и курсор в поле поиска — перерисовка не должна сбивать ввод.
    const active = document.activeElement as HTMLInputElement | null;
    const keep = active && body.contains(active) && active.classList.contains('an-search')
      ? { cls: 'an-search', pos: active.selectionStart ?? active.value.length } : null;

    head.innerHTML = this.renderHead();
    body.classList.toggle('refreshing', this.loading && !!this.kpi);
    body.innerHTML = this.renderAlerts() + this.renderBody();

    if (keep) {
      const el = body.querySelector<HTMLInputElement>(`.${keep.cls}`);
      if (el) { el.focus(); el.setSelectionRange(keep.pos, keep.pos); }
    }
    this.renderOverlay();
    this.drawCharts();
  }

  private renderHead(): string {
    const mps = (['ozon', 'wb', 'yandex'] as Mp[]).filter(m => this.stores.some(s => s.mp === m));
    const mpBtn = (v: MpSel, label: string) =>
      `<button class="an-seg ${this.mp === v ? 'on' : ''}" onclick="window.analyticsModule?.selectMp('${v}')">${v !== 'all' ? `<span class="an-dot an-mp-${v}"></span>` : ''}${label}</button>`;
    const mpStores = this.mp === 'all' ? [] : this.stores.filter(s => s.mp === this.mp);
    const status = this.loading
      ? `<span class="an-status-line"><span class="an-spinner sm"></span>${escapeHtml(this.phase)}</span>`
      : this.updatedAt ? `<span class="an-status-line" title="${this.syncedAt ? `Финотчёт подтянут ${dateTime(this.syncedAt.toISOString())}` : ''}">обновлено ${this.updatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}</span>` : '';

    return `
      <div class="an-filters">
        <h2 class="an-title">Аналитика</h2>
        ${mps.length > 1 ? `<div class="an-segs">${mpBtn('all', 'Все')}${mps.map(m => mpBtn(m, MP_SHORT[m])).join('')}</div>` : ''}
        ${mpStores.length > 1 ? `
          <select class="an-select" onchange="window.analyticsModule?.selectStore(this.value)" aria-label="Магазин">
            <option value="">Все магазины</option>
            ${mpStores.map(s => `<option value="${escapeHtml(s.id)}" ${this.storeId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>` : ''}
        <select class="an-select" onchange="window.analyticsModule?.setPeriod(this.value)" aria-label="Период">
          ${PERIODS.map(g => `<optgroup label="${g.group}">${g.items.map(([v, l]) => `<option value="${v}" ${this.period === v ? 'selected' : ''}>${l}</option>`).join('')}</optgroup>`).join('')}
          <option value="custom" ${this.period === 'custom' ? 'selected' : ''}>Свой период…</option>
        </select>
        ${this.period === 'custom' ? `
          <input class="an-select" type="date" value="${this.customFrom}" onchange="window.analyticsModule?.setCustomDate('from', this.value)" aria-label="С"/>
          <input class="an-select" type="date" value="${this.customTo}" onchange="window.analyticsModule?.setCustomDate('to', this.value)" aria-label="По"/>` : ''}
        <span class="an-grow"></span>
        ${status}
        <button class="an-btn ghost" onclick="window.analyticsModule?.syncFinances()" ${this.loading ? 'disabled' : ''} title="Подтянуть свежий финотчёт и заказы">Обновить</button>
        <button class="an-btn ghost" onclick="window.analyticsModule?.exportCurrent()" ${this.kpi ? '' : 'disabled'} title="Скачать текущую вкладку в Excel">Excel</button>
        <button class="an-btn ghost" onclick="window.analyticsModule?.openSettings()" title="Налоги, себестоимость, реклама, свои расходы">Настройки${this.missingCogs.length ? ` <span class="an-badge">${this.missingCogs.length}</span>` : ''}</button>
      </div>
      <nav class="an-tabs" role="tablist">
        ${TABS.map(([id, label]) => `<button role="tab" aria-selected="${this.tab === id}" class="an-tab ${this.tab === id ? 'on' : ''}" onclick="window.analyticsModule?.setTab('${id}')">${label}</button>`).join('')}
        <span class="an-grow"></span>
        <span class="an-muted an-scope">${escapeHtml(this.scopeLabel())} · ${escapeHtml(this.periodLabel())}</span>
      </nav>`;
  }

  private updateProgress(): void {
    const el = this.root?.querySelector('.an-status-line');
    if (!el) return;
    const p = this.progress;
    el.innerHTML = `<span class="an-spinner sm"></span>${escapeHtml(this.phase)}${p && p.total ? ` ${p.done}/${p.total}` : ''}`;
    const big = this.root?.querySelector('.an-loading p');
    if (big) big.textContent = `${this.phase}${p && p.total ? ` ${p.done} из ${p.total}` : ''}`;
  }

  private renderAlerts(): string {
    const out: string[] = [];
    if (this.error) out.push(`<div class="an-alert error">${escapeHtml(this.error)}</div>`);
    if (this.warning) out.push(`<div class="an-alert warn">${escapeHtml(this.warning)}</div>`);
    const k = this.kpi;
    if (k && !this.loading && this.tab === 'overview') {
      const base = k.revenue + k.awaiting_revenue;
      if (k.awaiting_orders > 0 && base > 0 && k.awaiting_revenue / base >= 0.5) {
        out.push(`<div class="an-alert info">Финотчёт пришёл только по ${pct(k.source_real_pct, 0)} выкупленных заказов —
          ещё ${rub(k.awaiting_revenue)} ждут расчёта маркетплейса и пока не входят в выручку. Для свежих дней это нормально.</div>`);
      }
      if (this.missingCogs.length) {
        const n = this.missingCogs.length;
        out.push(`<div class="an-alert warn">У ${num(n)} ${plural(n, ['товара', 'товаров', 'товаров'])} не задана себестоимость — прибыль завышена.
          <button class="an-link" onclick="window.analyticsModule?.openCostEditor()">Заполнить →</button></div>`);
      }
    }
    return out.join('');
  }

  private renderBody(): string {
    if (!this.dataLoaded && (this.loading || !this.stores.length) && !this.error) {
      return `<div class="an-loading"><div class="an-spinner"></div><p>${escapeHtml(this.phase || 'Загружаем…')}</p></div>`;
    }
    if (this.dataLoaded && !this.stores.length) {
      return `<div class="an-empty"><h3>Нет подключённых магазинов</h3><p>Подключите Ozon, Wildberries или Яндекс.Маркет в разделе «Маркетплейсы».</p></div>`;
    }
    if (!this.kpi) return this.error ? '' : `<div class="an-loading"><div class="an-spinner"></div><p>${escapeHtml(this.phase)}</p></div>`;

    switch (this.tab) {
      case 'overview':
        return renderOverview({
          kpi: this.kpi, prevKpi: this.prevKpi, ts: this.ts, prevTs: this.prevTs, orders: this.orders,
          prevOrders: this.prevOrders, skus: this.skus, metric: this.metric, allMp: this.mp === 'all', byMp: this.byMp,
        });
      case 'unit':
        if (this.unitKey !== this.loadedKey && !this.unitLoading) { this.unitError = ''; void this.loadUnit(); }
        return renderUnit({
          result: this.unitKey === this.loadedKey ? this.unitResult : null,
          loading: this.unitLoading, error: this.unitError, settings: settingsDb.unitSettings(), sort: this.unitSort,
          isOzon: this.scopeStores().some(s => s.mp === 'ozon'),
          historyLabel: this.unitRaw?.historyLabel ?? 'за 60 дней до периода',
        });
      case 'products': return renderProducts(this.skus, this.productsState);
      case 'orders': return renderOrders(this.orders, this.ordersState);
    }
  }

  private renderOverlay(): void {
    const host = this.root?.querySelector<HTMLElement>('.an-overlay');
    if (!host) return;
    let html = '';
    if (this.openedOrder) {
      const o = this.orders.find(x => (x.order_key ?? x.order_id) === this.openedOrder);
      if (o) html = renderOrderDrawer(o); else this.openedOrder = null;
    } else if (this.settingsOpen) {
      html = renderSettings({
        section: this.settingsSection, stores: this.stores, manual: settingsDb.manualList(),
        missingCogs: this.missingCogs, ozon: this.ozonStoresRaw, perfStatus: this.perfStatus,
      });
    }
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  private drawCharts(): void {
    if (!this.root || !this.kpi || this.tab !== 'overview') return;
    const host = this.root.querySelector<HTMLElement>('[data-chart="main"]');
    if (!host || !this.tip) return;
    const spec: TimeSpec = chartSpec({
      kpi: this.kpi, prevKpi: this.prevKpi, ts: this.ts, prevTs: this.prevTs, orders: this.orders,
      prevOrders: this.prevOrders, skus: this.skus, metric: this.metric, allMp: this.mp === 'all', byMp: this.byMp,
    });
    drawTimeChart(host, spec, this.tip);
  }

  private registerAi(): void {
    if (!this.dataLoaded || !this.kpi) return;
    aiPage.register({ page: 'analytics', title: 'Аналитика', describe: () => this.getAiSummary(), actions: [] });
  }
}

export default AnalyticsModule;
