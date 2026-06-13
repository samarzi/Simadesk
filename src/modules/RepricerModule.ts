/**
 * RepricerModule — управление правилами ценообразования.
 * WB, Ozon, Яндекс Маркет. Несколько магазинов на каждом МП.
 */

import { debug } from '@/utils/debug';
import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { updateWbPrices, fetchWbCurrentPrices, fetchAllWbOrders, isWbCoolingDown, wbCooldownRemaining } from '@/services/wbApi';
import { ozonApi } from '@/services/ozonApi';
import { helpBtn } from '@/services/helpModal';
import { yandexApi } from '@/services/yandexApi';
import { costPriceDb } from '@/services/costPriceDb';
import { repricerRulesDb } from '@/services/repricerRulesDb';
import { ozonOrdersApi, fetchAllPages, fetchAllPagesByCursor, calcPostingTotal } from '@/services/ozonOrdersApi';
import { fetchAllYandexOrders } from '@/services/yandexApi';
import { companyService } from '@/services/companyService';
import { detectSimaDeskExtension } from '@/services/extensionDetect';
import { supaFetch } from '@/services/supabaseClient';
import { WbProduct, WbStore } from '@/types/wb';
import { OzonProduct, OzonStore } from '@/types/ozon';
import { YandexProduct, YandexStore } from '@/types/yandex';
import * as XLSX from 'xlsx';
import '@/styles/repricer.css';

// ── Аналитика продаж ──────────────────────────────────────────────────────
/** Нормализованный заказ для аналитики */
interface SalesOrder {
  date: string;       // ISO
  revenue: number;    // ₽
  mp: Mp;
  storeId: string;
  storeName: string;
}

interface SalesHeatmapCell { revenue: number; count: number }
interface SalesAnalytics {
  heatmap: SalesHeatmapCell[][];   // [dayOfWeek 0=вс..6=сб][hour 0..23]
  totalRevenue: number;
  totalOrders: number;
  byDay: number[];                  // выручка по дням (0=вс..6=сб)
  byHour: number[];                 // выручка по часам (0..23)
}

const ANALYTICS_CACHE_KEY = 'repricer_orders_cache_v2';

type Mp = 'wb' | 'ozon' | 'yandex';
type RuleType = 'target' | 'margin' | 'stock' | 'schedule' | 'formula' | 'mrc';
type RuleStatus = 'active' | 'paused';

/** Один порог для правила «по остатку»: «если остаток ≤ X — цена Y» */
interface StockTier { maxStock: number; price: number }

/** Один период расписания: «по дням недели + в диапазоне времени — цена X» */
interface SchedulePeriod {
  days: number[];     // 0=вс, 1=пн, …, 6=сб
  fromTime: string;   // "HH:MM"
  toTime: string;     // "HH:MM"
  price: number;
}

interface RuleProduct {
  productId: string;
  vendorCode: string;
  productTitle: string;
}

export interface RepricerRule {
  id: string;
  marketplace: Mp;
  storeId: string;
  storeName: string;
  productId: string;       // nmId for wb, offer_id for ozon/yandex (первый товар / legacy)
  vendorCode: string;
  productTitle: string;
  /** Несколько товаров в одном правиле. Если пуст — используется productId/vendorCode/productTitle. */
  products?: RuleProduct[];
  type: RuleType;
  status: RuleStatus;
  targetPrice?: number;
  marginMultiplier?: number;
  minPrice?: number;
  maxPrice?: number;
  // legacy single-tier (для обратной совместимости)
  stockThreshold?: number;
  highStockPrice?: number;
  lowStockPrice?: number;
  // legacy weekday/weekend (для обратной совместимости)
  weekdayPrice?: number;
  weekendPrice?: number;
  // новые многоуровневые настройки
  stockTiers?: StockTier[];
  schedulePeriods?: SchedulePeriod[];
  formula?: string;        // напр. "cost_price * 1.87 + 191"
  mrcPrice?: number;       // МРЦ — минимальная розничная цена производителя
  mrcBuffer?: number;      // % скрытой скидки маркетплейса (СПП/карта/промо), система завышает цену так, чтобы после неё покупатель видел МРЦ
  createdAt: string;
  lastAppliedAt?: string;
  lastAppliedPrice?: number;
}

/** Получить все товары правила (обратная совместимость). */
function ruleProducts(r: RepricerRule): RuleProduct[] {
  if (r.products && r.products.length > 0) return r.products;
  return [{ productId: r.productId, vendorCode: r.vendorCode, productTitle: r.productTitle }];
}

/** Унифицированный товар: один артикул может присутствовать в нескольких МП. */
interface UnifiedProduct {
  vendorCode: string;
  title: string;            // наиболее полное название из доступных МП
  variants: Array<{
    mp: Mp;
    storeId: string;
    storeName: string;
    productId: string;
    title: string;
    price: number | null;
    stock: number;
  }>;
}

interface PriceLog {
  id: string;
  ruleId: string;
  marketplace: Mp;
  storeName: string;
  productTitle: string;
  oldPrice: number | null;
  newPrice: number;
  appliedAt: string;
  reason: string;
}

const MP_COLOR: Record<Mp, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };
const MP_BG:    Record<Mp, string> = { wb: '#fdf0fb', ozon: '#eef4ff', yandex: '#fff5f3' };
const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

const RULE_LABELS: Record<RuleType, string> = {
  target: 'Фиксированная цена',
  margin: 'По марже (×)',
  stock: 'По остатку',
  schedule: 'По расписанию',
  formula: 'Формула',
  mrc: 'По МРЦ',
};

const RULE_DESCRIPTIONS: Record<RuleType, string> = {
  target:   'Жёстко зафиксированная цена',
  margin:   'Себестоимость × множитель (например ×1.87)',
  stock:    'Разные цены при дефиците и при избытке',
  schedule: 'Цены меняются по дням недели',
  formula:  'Произвольная формула с переменными',
  mrc:      'Поддержание МРЦ производителя с учётом скидки маркетплейса',
};

/** Безопасный вычислитель формул — без eval, только числа и базовые операции. */
function evalFormula(expr: string, vars: Record<string, number>): number | null {
  if (!expr.trim()) return null;
  try {
    // Подставляем переменные сначала (cost_price, stock, etc.)
    let s = expr;
    for (const [name, val] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\b${name}\\b`, 'g'), String(val));
    }
    // Запрещаем всё кроме цифр, точек, операторов, скобок, пробелов
    if (!/^[\d.+\-*/()\s]+$/.test(s)) return null;
    // Function вместо eval — изолированный scope без доступа к window
    const result = Function(`"use strict"; return (${s})`)();
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// ── МРЦ: константы ────────────────────────────────────────────────────────────
/** Минимальное время между изменениями цены одного товара. */
const PRODUCT_COOLDOWN_MS = 3_600_000;       // 1 час
/** Максимальное изменение цены продавца за один цикл. */
const MAX_CHANGE_PCT      = 0.20;            // ±20%
/** Отклонение витринной цены от МРЦ, начиная с которого действуем. */
const DEVIATION_THRESHOLD = 0.01;           // 1%
/** Вес нового наблюдения в EMA самообучающегося коэффициента. */
const FACTOR_ALPHA        = 0.30;           // ~10 циклов до конвергенции
/** Макс. возраст данных yandex_buyer_prices, собранных расширением. */
const YANDEX_SHOWCASE_STALE_MS = 6 * 3600 * 1000; // 6 часов

/**
 * Состояние МРЦ для одного товара — хранится между сканами в localStorage.
 * discountFactor = EMA( showcasePrice / sellerPrice ) — сколько МП реально
 * показывает от нашей цены.  Используется для уточнения расчёта при следующем цикле.
 */
interface MrcProductState {
  discountFactor:    number;
  lastUpdateAt:      string | null;  // ISO — когда последний раз меняли цену
  lastSellerPrice:   number;
  lastShowcasePrice: number;
}

/**
 * Вычисляет новую цену продавца чтобы витринная цена стала равна МРЦ.
 *   ratio      = mrcPrice / showcasePrice
 *   new_seller = ceil( currentSeller × ratio )
 * Ограничение ±20% — не даём системе резко «прыгать» за один цикл.
 */
function computeNewSellerPrice(
  mrcPrice: number,
  currentSellerPrice: number,
  showcasePrice: number,
): number {
  const ratio   = mrcPrice / showcasePrice;
  const raw     = Math.ceil(currentSellerPrice * ratio);
  const maxDiff = Math.ceil(currentSellerPrice * MAX_CHANGE_PCT);
  return Math.min(currentSellerPrice + maxDiff, Math.max(currentSellerPrice - maxDiff, raw));
}

/**
 * Целевая витринная цена с учётом mrcBuffer — % скидки, которую маркетплейс
 * добавляет сверх показанной нам цены (СПП на WB, скидка по карте/Premium на
 * Ozon, скидка лояльности на ЯМ и т.п.) и которую мы не можем измерить через
 * API. Продавец вводит этот % "на глаз" по своей карточке товара. Решаем
 * обратную задачу: какую цену нужно показать ДО этой скидки маркетплейса,
 * чтобы ПОСЛЕ неё покупатель увидел ровно mrcPrice.
 *   target * (1 - buffer/100) = mrcPrice  =>  target = mrcPrice / (1 - buffer/100)
 */
export function mrcEffectiveTarget(rule: RepricerRule): number {
  const mrcPrice = rule.mrcPrice ?? 0;
  const buffer = rule.mrcBuffer ?? 0;
  if (buffer <= 0 || buffer >= 100) return mrcPrice;
  return Math.round(mrcPrice / (1 - buffer / 100));
}

/**
 * WB: цена покупателя = sellerPrice × (1 − discountPercent/100).
 * Чтобы покупатель увидел ровно targetShowcase, поднимаем sellerPrice так,
 * чтобы после применения скидки продавца получился targetShowcase.
 * Этот sellerPrice уже учитывает скидку — повторно делить его на
 * (1 - discount/100) перед отправкой в WB API нельзя (задвоит скидку).
 */
export function wbSellerPriceForMrc(targetShowcase: number, discountPercent: number): number {
  const ratio = 1 - discountPercent / 100;
  return ratio > 0 ? Math.ceil(targetShowcase / ratio) : Math.ceil(targetShowcase * 1.15);
}

/** Витринная цена отклонилась от МРЦ больше чем на 1%? */
function mrcShowcaseDeviated(showcasePrice: number, mrcPrice: number): boolean {
  if (mrcPrice <= 0 || showcasePrice <= 0) return false;
  return Math.abs(showcasePrice - mrcPrice) / mrcPrice > DEVIATION_THRESHOLD;
}

/**
 * Реальные цены покупателя на Яндекс Маркете (с учётом Буста), собранные
 * расширением SimaDesk и сохранённые в таблицу yandex_buyer_prices.
 * Возвращает Map offer_id -> buyer_price (только свежие данные, ≤6ч).
 */
interface YandexBuyerPriceInfo {
  price: number;
  checkedAt: string;
  marketSku: number | null;
  fresh: boolean; // данные собраны ≤ YANDEX_SHOWCASE_STALE_MS назад
}

async function fetchYandexBuyerPrices(offerIds: string[]): Promise<Map<string, YandexBuyerPriceInfo>> {
  const showcaseMap = new Map<string, YandexBuyerPriceInfo>();
  if (offerIds.length === 0) return showcaseMap;
  try {
    const inList = offerIds.map(id => `"${id}"`).join(',');
    const rows = await supaFetch<Array<{ offer_id: string; buyer_price: number; checked_at: string; market_sku: number | null }>>(
      `yandex_buyer_prices?select=offer_id,buyer_price,checked_at,market_sku&offer_id=in.(${inList})`,
    );
    const staleBefore = Date.now() - YANDEX_SHOWCASE_STALE_MS;
    for (const row of rows ?? []) {
      if (!row.offer_id || !row.buyer_price) continue;
      showcaseMap.set(row.offer_id, {
        price: Number(row.buyer_price),
        checkedAt: row.checked_at,
        marketSku: row.market_sku ?? null,
        fresh: new Date(row.checked_at).getTime() >= staleBefore,
      });
    }
  } catch (e) {
    console.warn('[YM MRC scan] fetchYandexBuyerPrices error:', e);
  }
  return showcaseMap;
}

/** Товар ещё в кулдауне (прошло < 1 ч с последнего изменения цены)? */
function isMrcProductCooling(state: MrcProductState): boolean {
  if (!state.lastUpdateAt) return false;
  return Date.now() - new Date(state.lastUpdateAt).getTime() < PRODUCT_COOLDOWN_MS;
}

/** Обновить EMA коэффициента скидки МП (showcasePrice / sellerPrice). */
function updateDiscountFactor(
  state: MrcProductState,
  showcasePrice: number,
  sellerPrice: number,
): void {
  if (sellerPrice <= 0 || showcasePrice <= 0) return;
  const observed     = showcasePrice / sellerPrice;
  const prev         = state.discountFactor > 0 ? state.discountFactor : observed;
  state.discountFactor   = FACTOR_ALPHA * observed + (1 - FACTOR_ALPHA) * prev;
  state.lastSellerPrice  = sellerPrice;
  state.lastShowcasePrice = showcasePrice;
}

interface MrcScanEntry {
  id: string;
  scannedAt: string;
  marketplace: Mp;
  storeName: string;
  productTitle: string;
  vendorCode: string;
  mrcPrice: number;
  sellerPrice: number;
  /** Публичная витринная цена — источник истины для МРЦ. */
  buyerPrice: number;       // = showcasePrice (поле оставлено для совместимости с UI)
  discountAmount: number;   // sellerPrice - buyerPrice
  discountPercent: number;  // discountAmount / sellerPrice * 100
  discountFactor: number;   // EMA: buyerPrice / sellerPrice
  action: 'adjusted' | 'ok' | 'error' | 'cooldown' | 'skipped';
  newPrice?: number;
  /** Цена, которую нужно выставить в ЛК продавца, чтобы витринная цена = МРЦ (даже если сейчас всё ок). */
  recommendedPrice?: number;
  errorMsg?: string;
  /** Когда последний раз меняли цену продавца этого товара (ISO) — независимо от текущего скана. */
  lastUpdateAt?: string | null;
  /** ЯМ: реальная цена покупателя (с Бустом/Плюсом), собранная расширением — для информации. */
  extBuyerPrice?: number | null;
  /** ЯМ: когда расширение последний раз проверяло цену (ISO). */
  extCheckedAt?: string | null;
  /** ЯМ: market_sku товара — для ссылки на страницу Маркета. */
  extMarketSku?: number | null;
}

interface MrcScanConfig {
  enabled: boolean;
  intervalHours: number;
}

/**
 * Результат анализа цены покупателя для одного товара/магазина — используется
 * кнопкой «Анализ цены на маркетплейсах» в форме правила МРЦ (до сохранения правила).
 */
interface MrcAnalysisEntry {
  mp: Mp;
  storeId: string;
  storeName: string;
  productId: string;
  vendorCode: string;
  productTitle: string;
  /** Текущая цена продавца (которая стоит в ЛК сейчас). */
  sellerPrice: number;
  /** Текущая цена покупателя без карты/кошелька МП (обычная оплата любой картой). */
  buyerPrice: number;
  /** МРЦ, указанная для этого артикула в форме. */
  mrcPrice: number;
  /** Целевая витринная цена с учётом mrcBuffer. */
  targetShowcase: number;
  /** Рекомендуемая цена для ЛК продавца, чтобы покупатель увидел targetShowcase. */
  recommendedPrice: number;
  status: 'ok' | 'needs_update' | 'error';
  errorMsg?: string;
  /** WB: текущая скидка (%) — сохраняется при обновлении цены. */
  wbDiscount?: number;
  /** Ozon: numeric product_id — нужен для удаления из акций перед сменой цены. */
  ozonProductId?: number | null;
  /** ЯМ: campaign_id магазина. */
  ymCampaignId?: number;
}

const LOG_KEY               = 'repricer_log_v3';
const MRC_SCAN_CFG_KEY      = 'repricer_mrc_scan_cfg_v1';
const MRC_SCAN_LOG_KEY      = 'repricer_mrc_scan_log_v1';
const MRC_PRODUCT_STATE_KEY = 'repricer_mrc_state_v1';

function loadLog(): PriceLog[] { try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]'); } catch { return []; } }
function saveLog(l: PriceLog[]): void { localStorage.setItem(LOG_KEY, JSON.stringify(l.slice(0, 500))); }
function uid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export class RepricerModule {
  private container: HTMLElement;
  private rules: RepricerRule[] = [];
  private log: PriceLog[] = [];

  private wbProducts:    WbProduct[]     = [];
  private ozonProducts:  OzonProduct[]   = [];
  private ymProducts:    YandexProduct[] = [];
  private wbStores:      WbStore[]       = [];
  private ozonStores:    OzonStore[]     = [];
  private ymStores:      YandexStore[]   = [];

  private tab: 'rules' | 'log' | 'costs' | 'analytics' = 'rules';

  // ── Sales analytics ───────────────────────────────────────────────────
  private analyticsOrders: SalesOrder[] = [];
  private analyticsLoading = false;
  private analyticsLoaded = false;
  private analyticsDays = 90;
  private analyticsCachedAt: number | null = null;
  private analyticsSubTab: 'heatmap' | 'days' | 'hours' | 'tips' = 'heatmap';
  private analyticsFilterMps: Set<Mp> = new Set();   // мульти-выбор маркетплейсов
  private analyticsFilterStoreId = '';
  private analyticsErrors: Array<{ mp: string; store: string; error: string }> = [];

  // ── Cost-prices manager ───────────────────────────────────────────
  private costsSearch = '';
  private costsMpFilter: '' | Mp = '';
  private costsSelected = new Set<string>();      // vendorCode (нормализован)
  private costsBulkValue: number | '' = '';
  /** Lowercased vendor_code/sku из исторических транзакций МП.
   *  Используется чтобы помечать orphan-артикулы как "архив" (был в продажах)
   *  vs "удалён" (нигде не встречался). Грузится один раз при открытии таба. */
  private soldVendorCodes: Set<string> | null = null;
  private soldVendorCodesLoading = false;
  private editId: string | null = null;
  private showForm = false;
  private form: Partial<RepricerRule> = {};
  private formError = '';
  // Выбранные магазины в форме (до выбора товара)
  private formStoreIds = new Set<string>();
  // Список выбранных товаров для правила (мульти-выбор)
  private formProducts: RuleProduct[] = [];
  private applying = new Set<string>();
  private applyErrors = new Map<string, string>(); // ruleId → error message

  // ── MRC auto-scan ──────────────────────────────────────────────────────────
  private mrcScanEnabled = false;
  private mrcScanIntervalHours = 1;
  private mrcLastScanAt: string | null = null;
  private mrcScanning = false;
  private mrcScanLog: MrcScanEntry[] = [];
  private mrcScanTimer: ReturnType<typeof setInterval> | null = null;
  private mrcCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Свёрнута ли панель МРЦ-контроля (сохраняется между сессиями). */
  private mrcPanelCollapsed: boolean = localStorage.getItem('rpr_mrc_collapsed') === '1';
  /** Состояние МРЦ по каждому товару: ключ = `${marketplace}:${storeId}:${productId}` */
  private mrcProductStates: Map<string, MrcProductState> = new Map();

  // ── Per-product MRC prices (заполняются в форме при МРЦ + несколько товаров) ──
  private formProductMrcPrices: Map<string, number> = new Map(); // vendorCode → mrcPrice
  private mrcFillPrice: number | '' = '';

  // ── Анализ цены покупателя в форме МРЦ (кнопка «Анализ цены на маркетплейсах») ──
  private mrcAnalysisResults: MrcAnalysisEntry[] = [];
  private mrcAnalyzing = false;
  private mrcApplyingAnalysis = false;
  private mrcAnalysisError = '';

  // ── Расширение SimaDesk (нужно для сбора реальной цены покупателя на Яндекс Маркете) ──
  private extensionConnected: boolean | null = null; // null = проверка не завершена

  // ── Per-store formulas (для типа formula: каждый магазин = своя формула) ──
  private formStoreFormulas: Map<string, string> = new Map(); // storeId → formula

  // ── Rules list filter / search ──────────────────────────────────────────────
  private rulesSearch = '';
  private rulesTypeFilter: '' | RuleType = '';

  // ── Product picker (выбор товаров из всех МП с дедупликацией по артикулу) ──
  private pickerOpen = false;
  private pickerSelected = new Set<string>();      // ключи UnifiedProduct.vendorCode
  private pickerSearch = '';
  private pickerSelectedMps  = new Set<Mp>();      // выбранные маркетплейсы (кнопки)
  private pickerSelectedStores = new Set<string>(); // выбранные магазины (кнопки)
  private pickerStockFilter: 'all' | 'in' | 'out' = 'all';

  constructor(container: HTMLElement) { this.container = container; }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    await repricerRulesDb.refresh();
    this.rules = repricerRulesDb.all();
    this.log   = loadLog();
    this.loadMrcScanConfig();

    const [[wbS, wbP], [ozS, ozP], [ymS, ymP]] = await Promise.all([
      Promise.all([wbDb.getStores(), wbDb.getProducts()]).catch(() => [[], []] as [WbStore[], WbProduct[]]),
      Promise.all([ozonDb.getStores(), ozonDb.getProducts()]).catch(() => [[], []] as [OzonStore[], OzonProduct[]]),
      Promise.all([yandexDb.getStores(), yandexDb.getProducts()]).catch(() => [[], []] as [YandexStore[], YandexProduct[]]),
    ]);
    this.wbStores = wbS as WbStore[]; this.wbProducts = wbP as WbProduct[];
    this.ozonStores = ozS as OzonStore[]; this.ozonProducts = ozP as OzonProduct[];
    this.ymStores = ymS as YandexStore[]; this.ymProducts = ymP as YandexProduct[];

    if (this.mrcScanEnabled) this.startAutoScan();
    this.render();

    detectSimaDeskExtension().then((ok) => {
      this.extensionConnected = ok;
      this.render();
    });
  }

  hide(): void {
    this.container.style.display = 'none';
    this.stopAutoScan();
    this.stopCountdown();
  }

  setTab(t: 'rules' | 'log' | 'costs' | 'analytics'): void {
    this.tab = t;
    if (t === 'analytics' && !this.analyticsLoaded && !this.analyticsLoading) {
      this.loadAnalytics();
    } else {
      if (t === 'costs') {
        // Актуализируем себестоимости с сервера при открытии вкладки
        costPriceDb.refresh().then(() => this.render()).catch(() => this.render());
        // Параллельно подгружаем "историю продаж" — для пометки архив/удалён
        this.loadSoldVendorCodes();
      } else {
        this.render();
      }
    }
  }

  setAnalyticsSubTab(t: 'heatmap' | 'days' | 'hours' | 'tips'): void {
    this.analyticsSubTab = t;
    this.render();
  }

  setAnalyticsDays(days: number): void {
    this.analyticsDays = days;
    this.analyticsLoaded = false;
    this.analyticsOrders = [];
    this.loadAnalytics();
  }

  setAnalyticsFilterMp(mp: string): void {
    if (!mp) {
      this.analyticsFilterMps.clear();
    } else {
      const m = mp as Mp;
      if (this.analyticsFilterMps.has(m)) this.analyticsFilterMps.delete(m);
      else this.analyticsFilterMps.add(m);
    }
    this.analyticsFilterStoreId = '';
    this.render();
  }

  setAnalyticsFilterStore(storeId: string): void {
    this.analyticsFilterStoreId = storeId;
    this.render();
  }

  private get filteredOrders(): SalesOrder[] {
    let orders = this.analyticsOrders;
    if (this.analyticsFilterMps.size > 0) orders = orders.filter(o => this.analyticsFilterMps.has(o.mp));
    if (this.analyticsFilterStoreId) orders = orders.filter(o => o.storeId === this.analyticsFilterStoreId);
    return orders;
  }

  private computeAnalytics(orders: SalesOrder[]): SalesAnalytics {
    const heatmap: SalesHeatmapCell[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ revenue: 0, count: 0 }))
    );
    const byDay:  number[] = new Array(7).fill(0);
    const byHour: number[] = new Array(24).fill(0);
    let totalRevenue = 0, totalOrders = 0;

    for (const o of orders) {
      const d = new Date(o.date);
      if (isNaN(d.getTime())) continue;
      const day  = d.getDay();
      const hour = d.getHours();
      heatmap[day][hour].revenue += o.revenue;
      heatmap[day][hour].count  += 1;
      byDay[day]  += o.revenue;
      byHour[hour] += o.revenue;
      totalRevenue += o.revenue;
      totalOrders  += 1;
    }
    return { heatmap, totalRevenue, totalOrders, byDay, byHour };
  }

  /** Объединяет товары всех МП по артикулу (vendorCode). */
  private buildUnifiedProducts(): UnifiedProduct[] {
    const map = new Map<string, UnifiedProduct>();
    const key = (s: string) => s.trim().toLowerCase();

    for (const p of this.wbProducts) {
      const code = p.vendor_code || String(p.nm_id);
      const k = key(code);
      if (!k) continue;
      const v = map.get(k) ?? { vendorCode: code, title: p.title || code, variants: [] };
      v.variants.push({
        mp: 'wb',
        storeId: p.store_id,
        storeName: this.wbStores.find(s => s.id === p.store_id)?.name ?? '',
        productId: String(p.nm_id),
        title: p.title || code,
        price: p.price ?? null,
        stock: p.stock_total ?? 0,
      });
      if (!v.title || v.title.length < (p.title?.length ?? 0)) v.title = p.title || v.title;
      map.set(k, v);
    }
    for (const p of this.ozonProducts) {
      const code = p.offer_id;
      const k = key(code);
      if (!k) continue;
      const v = map.get(k) ?? { vendorCode: code, title: p.name || code, variants: [] };
      v.variants.push({
        mp: 'ozon',
        storeId: p.store_id,
        storeName: this.ozonStores.find(s => s.id === p.store_id)?.name ?? '',
        productId: p.offer_id,
        title: p.name || code,
        price: p.price ?? null,
        stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0),
      });
      if (!v.title || v.title.length < (p.name?.length ?? 0)) v.title = p.name || v.title;
      map.set(k, v);
    }
    for (const p of this.ymProducts) {
      const code = p.vendor_code || p.offer_id;
      const k = key(code);
      if (!k) continue;
      const v = map.get(k) ?? { vendorCode: code, title: p.name || code, variants: [] };
      v.variants.push({
        mp: 'yandex',
        storeId: p.store_id,
        storeName: this.ymStores.find(s => s.id === p.store_id)?.name ?? '',
        productId: p.offer_id,
        title: p.name || code,
        price: p.basic_price ?? null,
        stock: p.stock_total ?? 0,
      });
      if (!v.title || v.title.length < (p.name?.length ?? 0)) v.title = p.name || v.title;
      map.set(k, v);
    }

    return [...map.values()].sort((a, b) => a.vendorCode.localeCompare(b.vendorCode));
  }

  /** Отфильтрованный список юнифицированных товаров для пикера.
   *  Базовый фильтр — formStoreIds (магазины выбранные в форме).
   *  Дополнительные фильтры пикера — pickerSelectedMps, pickerSelectedStores.
   */
  private get pickerFiltered(): UnifiedProduct[] {
    const all = this.buildUnifiedProducts();
    const q = this.pickerSearch.toLowerCase().trim();
    return all.filter(p => {
      // Базовый фильтр: только товары из выбранных в форме магазинов
      if (this.formStoreIds.size > 0 && !p.variants.some(v => this.formStoreIds.has(v.storeId))) return false;
      // Дополнительные фильтры пикера
      if (this.pickerSelectedMps.size > 0 && !p.variants.some(v => this.pickerSelectedMps.has(v.mp))) return false;
      if (this.pickerSelectedStores.size > 0 && !p.variants.some(v => this.pickerSelectedStores.has(v.storeId))) return false;
      if (this.pickerStockFilter !== 'all') {
        const totalStock = p.variants.reduce((s, v) => s + v.stock, 0);
        if (this.pickerStockFilter === 'in' && totalStock === 0) return false;
        if (this.pickerStockFilter === 'out' && totalStock > 0) return false;
      }
      if (q) {
        const hay = `${p.vendorCode} ${p.title}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  togglePickerMp(mp: Mp): void {
    if (this.pickerSelectedMps.has(mp)) this.pickerSelectedMps.delete(mp);
    else this.pickerSelectedMps.add(mp);
    this.pickerSelectedStores.clear(); // сбрасываем магазины при смене МП-фильтра
    this.renderPickerOnly();
  }

  togglePickerStore(storeId: string): void {
    if (this.pickerSelectedStores.has(storeId)) this.pickerSelectedStores.delete(storeId);
    else this.pickerSelectedStores.add(storeId);
    this.renderPickerOnly();
  }

  clearPickerStores(): void {
    this.pickerSelectedStores.clear();
    this.renderPickerOnly();
  }

  clearPickerMps(): void {
    this.pickerSelectedMps.clear();
    this.pickerSelectedStores.clear();
    this.renderPickerOnly();
  }

  /** Магазины, показываемые в пикере с учётом выбранных МП (или все если МП не выбраны). */
  private storesForPicker(): Array<{ id: string; name: string; mp: Mp }> {
    const mps = this.pickerSelectedMps;
    const all: Array<{ id: string; name: string; mp: Mp }> = [
      ...this.wbStores.map(s    => ({ ...s, mp: 'wb'     as Mp })),
      ...this.ozonStores.map(s  => ({ ...s, mp: 'ozon'   as Mp })),
      ...this.ymStores.map(s    => ({ ...s, mp: 'yandex' as Mp })),
    ];
    if (mps.size === 0) return all;
    return all.filter(s => mps.has(s.mp));
  }

  openAddForm(): void {
    this.editId = null;
    this.form = { type: 'target', status: 'active' };
    this.formStoreIds.clear();
    this.formProducts = [];
    this.formProductMrcPrices = new Map();
    this.formStoreFormulas = new Map();
    this.mrcFillPrice = '';
    this.mrcAnalysisResults = []; this.mrcAnalysisError = ''; this.mrcAnalyzing = false;
    this.showForm = true; this.formError = '';
    this.tab = 'rules';
    this.render();
  }

  openEditForm(id: string): void {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) return;
    this.editId = id; this.form = { ...rule };
    this.formStoreIds.clear();
    if (rule.storeId) this.formStoreIds.add(rule.storeId);
    this.formProducts = ruleProducts(rule).map(p => ({ ...p }));
    this.formProductMrcPrices = new Map();
    this.formStoreFormulas = new Map();
    this.mrcAnalysisResults = []; this.mrcAnalysisError = ''; this.mrcAnalyzing = false;
    // При редактировании формулы — загружаем формулу для магазина
    if (rule.type === 'formula' && rule.storeId && rule.formula) {
      this.formStoreFormulas.set(rule.storeId, rule.formula);
    }
    this.mrcFillPrice = '';
    this.showForm = true; this.formError = '';
    this.render();
  }

  closeForm(): void {
    this.showForm = false; this.formError = '';
    this.formStoreIds.clear(); this.formProducts = [];
    this.formProductMrcPrices = new Map();
    this.formStoreFormulas = new Map();
    this.mrcFillPrice = '';
    this.mrcAnalysisResults = []; this.mrcAnalysisError = ''; this.mrcAnalyzing = false;
    this.render();
  }

  updateProductMrcPrice(vendorCode: string, price: number): void {
    if (price > 0) this.formProductMrcPrices.set(vendorCode, price);
    else this.formProductMrcPrices.delete(vendorCode);
  }

  setMrcFillPrice(v: number): void { this.mrcFillPrice = v > 0 ? v : ''; }

  applyMrcFillAll(): void {
    if (!this.mrcFillPrice) return;
    const price = this.mrcFillPrice as number;
    for (const p of this.formProducts) this.formProductMrcPrices.set(p.vendorCode, price);
    this.form.mrcPrice = price;
    this.mrcFillPrice = price;
    this.render();
  }

  updateStoreFormula(storeId: string, formula: string): void {
    this.formStoreFormulas.set(storeId, formula);
  }

  // ── Анализ цены покупателя на маркетплейсах (форма МРЦ) ─────────────────────

  /** Товары для анализа: выбранные в форме (formProducts) или один текущий. */
  private analysisProducts(): RuleProduct[] {
    if (this.formProducts.length > 0) return this.formProducts;
    if (this.form.vendorCode && this.form.productId) {
      return [{ productId: this.form.productId, vendorCode: this.form.vendorCode, productTitle: this.form.productTitle ?? this.form.productId }];
    }
    return [];
  }

  /** Целевая витринная цена с учётом mrcBuffer, указанного в форме. */
  private formTargetShowcase(mrcPrice: number): number {
    const buffer = this.form.mrcBuffer ?? 0;
    if (buffer <= 0 || buffer >= 100) return mrcPrice;
    return Math.round(mrcPrice / (1 - buffer / 100));
  }

  /** Лёгкая перерисовка только блока анализа цены, без потери формы. */
  private renderMrcAnalysisHost(): void {
    const host = document.getElementById('rpr-mrc-analysis-host');
    if (host) host.innerHTML = this.renderMrcAnalysis();
  }

  /**
   * Собирает текущие цены покупателя (без карты/кошелька МП — обычная оплата любой картой)
   * по всем магазинам/маркетплейсам, где присутствует выбранный артикул, сравнивает с МРЦ,
   * указанной в форме, и рассчитывает цену, которую нужно выставить в ЛК продавца.
   */
  async analyzeMrcPrices(): Promise<void> {
    if (this.mrcAnalyzing) return;
    const products = this.analysisProducts();
    if (products.length === 0) {
      this.mrcAnalysisError = 'Сначала выберите товар(ы)';
      this.renderMrcAnalysisHost();
      return;
    }
    const hasAnyMrc = products.some(p => (this.formProductMrcPrices.get(p.vendorCode) || this.form.mrcPrice || 0) > 0);
    if (!hasAnyMrc) {
      this.mrcAnalysisError = 'Укажите МРЦ перед анализом';
      this.renderMrcAnalysisHost();
      return;
    }

    this.mrcAnalyzing = true;
    this.mrcAnalysisError = '';
    this.mrcAnalysisResults = [];
    this.renderMrcAnalysisHost();

    const unified = this.buildUnifiedProducts();

    for (const prod of products) {
      const mrcPrice = this.formProductMrcPrices.get(prod.vendorCode) || this.form.mrcPrice || 0;
      if (!mrcPrice) continue;
      const targetShowcase = this.formTargetShowcase(mrcPrice);
      const u = unified.find(p => p.vendorCode.trim().toLowerCase() === prod.vendorCode.trim().toLowerCase());
      const variants = u?.variants ?? [];

      if (variants.length === 0) {
        this.mrcAnalysisResults.push({
          mp: this.form.marketplace ?? 'wb', storeId: '', storeName: '', productId: prod.productId,
          vendorCode: prod.vendorCode, productTitle: prod.productTitle,
          sellerPrice: 0, buyerPrice: 0, mrcPrice, targetShowcase, recommendedPrice: 0,
          status: 'error', errorMsg: 'Товар не найден ни в одном магазине',
        });
        this.renderMrcAnalysisHost();
        continue;
      }

      for (const v of variants) {
        try {
          if (v.mp === 'wb') {
            const store = this.wbStores.find(s => s.id === v.storeId);
            if (!store) throw new Error('Магазин WB не найден');
            const priceMap = await fetchWbCurrentPrices(store.api_key, [Number(v.productId)]);
            const d = priceMap.get(Number(v.productId));
            if (!d) throw new Error('Цена не найдена в WB API');
            const sellerPrice = d.price;
            const buyerPrice = d.priceWithDisc;
            const recommendedPrice = computeNewSellerPrice(targetShowcase, sellerPrice, buyerPrice);
            this.mrcAnalysisResults.push({
              mp: 'wb', storeId: v.storeId, storeName: v.storeName, productId: v.productId,
              vendorCode: prod.vendorCode, productTitle: prod.productTitle,
              sellerPrice, buyerPrice, mrcPrice, targetShowcase, recommendedPrice,
              status: mrcShowcaseDeviated(buyerPrice, targetShowcase) ? 'needs_update' : 'ok',
              wbDiscount: d.discount,
            });
          } else if (v.mp === 'ozon') {
            const store = this.ozonStores.find(s => s.id === v.storeId);
            if (!store) throw new Error('Магазин Ozon не найден');
            const priceMap = await ozonApi.getMarketingPrices([v.productId], { client_id: store.client_id, api_key: store.api_key });
            const d = priceMap.get(v.productId) ?? priceMap.get(v.productId.toLowerCase());
            if (!d) throw new Error('Цена не найдена в Ozon API');
            const sellerPrice = d.sellerPrice;
            const buyerPrice = d.marketingPrice;
            const recommendedPrice = computeNewSellerPrice(targetShowcase, sellerPrice, buyerPrice);
            const cachedProd = this.ozonProducts.find(p => p.offer_id === v.productId && p.store_id === v.storeId);
            this.mrcAnalysisResults.push({
              mp: 'ozon', storeId: v.storeId, storeName: v.storeName, productId: v.productId,
              vendorCode: prod.vendorCode, productTitle: prod.productTitle,
              sellerPrice, buyerPrice, mrcPrice, targetShowcase, recommendedPrice,
              status: mrcShowcaseDeviated(buyerPrice, targetShowcase) ? 'needs_update' : 'ok',
              ozonProductId: cachedProd?.product_id ?? null,
            });
          } else {
            const store = this.ymStores.find(s => s.id === v.storeId);
            if (!store?.campaign_id) throw new Error('Магазин ЯМ или campaign_id не найден');
            const priceMap = await yandexApi.getOfferPrices(store.api_key, String(store.campaign_id));
            const d = priceMap.get(v.productId);
            if (!d) throw new Error('Цена не найдена в ЯМ API');
            const sellerPrice = d.discountBase && d.discountBase > 0 ? d.discountBase : d.price;
            const buyerPrice = d.price;
            const recommendedPrice = computeNewSellerPrice(targetShowcase, sellerPrice, buyerPrice);
            this.mrcAnalysisResults.push({
              mp: 'yandex', storeId: v.storeId, storeName: v.storeName, productId: v.productId,
              vendorCode: prod.vendorCode, productTitle: prod.productTitle,
              sellerPrice, buyerPrice, mrcPrice, targetShowcase, recommendedPrice,
              status: mrcShowcaseDeviated(buyerPrice, targetShowcase) ? 'needs_update' : 'ok',
              ymCampaignId: store.campaign_id,
            });
          }
        } catch (e: any) {
          this.mrcAnalysisResults.push({
            mp: v.mp, storeId: v.storeId, storeName: v.storeName, productId: v.productId,
            vendorCode: prod.vendorCode, productTitle: prod.productTitle,
            sellerPrice: 0, buyerPrice: 0, mrcPrice, targetShowcase, recommendedPrice: 0,
            status: 'error', errorMsg: e?.message?.slice(0, 150) ?? 'Ошибка',
          });
        }
        this.renderMrcAnalysisHost();
      }
    }

    this.mrcAnalyzing = false;
    this.renderMrcAnalysisHost();
  }

  /**
   * Выставляет рекомендованные цены в ЛК продавца на всех маркетплейсах, где витринная
   * цена отклонилась от МРЦ. После применения цена покупателя (за вычетом скидки МП)
   * станет равна МРЦ, указанной в форме.
   */
  async applyMrcAnalysis(): Promise<void> {
    if (this.mrcApplyingAnalysis) return;
    const toApply = this.mrcAnalysisResults.filter(r => r.status === 'needs_update' && r.recommendedPrice > 0);
    if (toApply.length === 0) return;

    this.mrcApplyingAnalysis = true;
    this.renderMrcAnalysisHost();

    for (const entry of toApply) {
      try {
        if (entry.mp === 'wb') {
          const store = this.wbStores.find(s => s.id === entry.storeId);
          if (!store) throw new Error('Магазин WB не найден');
          await updateWbPrices(store.api_key, [{ nmID: Number(entry.productId), price: entry.recommendedPrice, discount: entry.wbDiscount ?? 0 }]);
        } else if (entry.mp === 'ozon') {
          const store = this.ozonStores.find(s => s.id === entry.storeId);
          if (!store) throw new Error('Магазин Ozon не найден');
          const creds = { client_id: store.client_id, api_key: store.api_key };
          if (entry.ozonProductId) {
            try { await ozonApi.removeProductsFromAllPromos(creds, [entry.ozonProductId]); } catch { /* не критично */ }
          }
          const minP = Math.max(1, entry.recommendedPrice - 1);
          await ozonApi.updatePrices(creds, [{
            offer_id: entry.productId, price: String(entry.recommendedPrice),
            min_price: String(minP), auto_action_enabled: 'DISABLED',
          }]);
        } else {
          const store = this.ymStores.find(s => s.id === entry.storeId);
          if (!store?.campaign_id) throw new Error('Магазин ЯМ не найден');
          try {
            const businessId = await yandexApi.getBusinessId(store.api_key, store.campaign_id);
            if (businessId) await yandexApi.removeOffersFromAllPromos(store.api_key, businessId, [entry.productId]);
          } catch { /* не критично */ }
          await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), [{
            offerId: entry.productId, price: entry.recommendedPrice, clearDiscountBase: true,
          }]);
        }
        entry.status = 'ok';
        entry.sellerPrice = entry.recommendedPrice;
        entry.buyerPrice = entry.targetShowcase;
      } catch (e: any) {
        entry.errorMsg = e?.message?.slice(0, 150) ?? 'Ошибка применения';
      }
      this.renderMrcAnalysisHost();
    }

    this.mrcApplyingAnalysis = false;
    this.renderMrcAnalysisHost();
  }

  /** HTML блока анализа цены: кнопка + таблица результатов. */
  private renderMrcAnalysis(): string {
    const results = this.mrcAnalysisResults;
    const btn = `
      <button onclick="window.repricerModule.analyzeMrcPrices()" ${this.mrcAnalyzing ? 'disabled' : ''}
        style="padding:8px 16px;border:1px solid #2563eb;background:${this.mrcAnalyzing ? 'var(--bg3)' : 'color-mix(in srgb,#2563eb 10%,transparent)'};
          color:#2563eb;border-radius:8px;cursor:${this.mrcAnalyzing ? 'default' : 'pointer'};font-size:12.5px;font-weight:700">
        ${this.mrcAnalyzing ? '⏳ Анализирую цены на маркетплейсах…' : '🔍 Анализ цены на маркетплейсах'}
      </button>
    `;

    if (this.mrcAnalysisError) {
      return `${btn}<div style="margin-top:8px;font-size:12px;color:#dc2626">${this.esc(this.mrcAnalysisError)}</div>`;
    }
    if (results.length === 0 && !this.mrcAnalyzing) return btn;

    const needsUpdate = results.filter(r => r.status === 'needs_update');

    const rows = results.map(r => {
      const statusBadge = r.status === 'ok'
        ? `<span style="color:#16a34a;font-weight:700">✓ соответствует МРЦ</span>`
        : r.status === 'error'
          ? `<span style="color:#dc2626" title="${this.esc(r.errorMsg ?? '')}">⚠ ${this.esc(r.errorMsg ?? 'ошибка')}</span>`
          : `<span style="color:#f59e0b;font-weight:700">требует изменения</span>`;
      return `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap">
            <span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[r.mp]};color:${MP_COLOR[r.mp]}">${MP_LABEL[r.mp]}</span>
            ${this.esc(r.storeName)}
          </td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:right">${r.buyerPrice ? r.buyerPrice.toLocaleString('ru') + ' ₽' : '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:right">
            ${r.mrcPrice.toLocaleString('ru')} ₽
            ${r.targetShowcase !== r.mrcPrice ? `<div style="font-size:10px;color:var(--text2)">цель ${r.targetShowcase.toLocaleString('ru')} ₽</div>` : ''}
          </td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:right">${r.sellerPrice ? r.sellerPrice.toLocaleString('ru') + ' ₽' : '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:right;font-weight:700">${r.status === 'needs_update' ? r.recommendedPrice.toLocaleString('ru') + ' ₽' : '—'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid var(--border)">${statusBadge}</td>
        </tr>
      `;
    }).join('');

    return `
      ${btn}
      <div style="margin-top:10px;overflow-x:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--bg2)">
              <th style="padding:6px 10px;text-align:left;font-weight:600;color:var(--text2)">Магазин</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;color:var(--text2)" title="Цена, за которую маркетплейс продаёт товар клиенту сейчас — без карты/кошелька МП, любой картой">Цена покупателя сейчас</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;color:var(--text2)">МРЦ</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;color:var(--text2)">Цена в ЛК сейчас</th>
              <th style="padding:6px 10px;text-align:right;font-weight:600;color:var(--text2)" title="Цена, которую нужно поставить в ЛК продавца, чтобы после скидки маркетплейса покупатель увидел МРЦ">Поставить в ЛК</th>
              <th style="padding:6px 10px;text-align:left;font-weight:600;color:var(--text2)">Статус</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${needsUpdate.length > 0 ? `
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button onclick="window.repricerModule.applyMrcAnalysis()" ${this.mrcApplyingAnalysis ? 'disabled' : ''}
            style="padding:8px 16px;border:none;background:#059669;color:#fff;border-radius:8px;cursor:${this.mrcApplyingAnalysis ? 'default' : 'pointer'};font-size:12.5px;font-weight:700">
            ${this.mrcApplyingAnalysis ? '⏳ Применяю…' : `Поставить рекомендованные цены в ЛК (${needsUpdate.length})`}
          </button>
          <span style="font-size:11px;color:var(--text2)">
            Цена в ЛК будет изменена так, чтобы после скидки маркетплейса покупатель увидел МРЦ — выше вашей текущей цены ровно на % скидки маркетплейса.
          </span>
        </div>
      ` : (results.length > 0 && !this.mrcAnalyzing) ? `
        <div style="margin-top:8px;font-size:12px;color:#16a34a;font-weight:600">✓ Цены покупателя уже соответствуют МРЦ — ничего менять не нужно</div>
      ` : ''}
    `;
  }

  setRulesSearch(q: string): void {
    this.rulesSearch = q;
    const host = document.getElementById('rpr-rules-host');
    if (host) host.innerHTML = this.renderRulesInner();
  }

  setRulesTypeFilter(t: string): void {
    this.rulesTypeFilter = t as any;
    this.render();
  }

  toggleFormStore(storeId: string): void {
    if (this.formStoreIds.has(storeId)) this.formStoreIds.delete(storeId);
    else this.formStoreIds.add(storeId);
    // Сбросить выбранный товар если магазины изменились
    delete this.form.productId;
    delete this.form.vendorCode;
    delete this.form.productTitle;
    delete this.form.storeId;
    delete this.form.storeName;
    delete this.form.marketplace;
    this.render();
  }

  updateForm(key: string, value: any): void {
    (this.form as any)[key] = value;
    if (key === 'marketplace') {
      delete this.form.productId;
      this.form.productTitle = ''; this.form.vendorCode = '';
      this.form.storeId = ''; this.form.storeName = '';
    }
    if (key === 'productId') {
      const mp = this.form.marketplace ?? 'wb';
      if (mp === 'wb') {
        const p = this.wbProducts.find(p => String(p.nm_id) === String(value));
        if (p) {
          this.form.productTitle = p.title; this.form.vendorCode = p.vendor_code;
          this.form.storeId = p.store_id;
          this.form.storeName = this.wbStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      } else if (mp === 'ozon') {
        const p = this.ozonProducts.find(p => p.offer_id === value);
        if (p) {
          this.form.productTitle = p.name; this.form.vendorCode = p.offer_id;
          this.form.storeId = p.store_id;
          this.form.storeName = this.ozonStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      } else {
        const p = this.ymProducts.find(p => p.offer_id === value);
        if (p) {
          this.form.productTitle = p.name; this.form.vendorCode = p.vendor_code ?? p.offer_id;
          this.form.storeId = p.store_id;
          this.form.storeName = this.ymStores.find(s => s.id === p.store_id)?.name ?? '';
        }
      }
    }
    // Числовые поля используют onchange — полная перерисовка не нужна,
    // обновляем только расчётную цену (margin-тип) без потери фокуса
    const numKeys = new Set(['targetPrice','minPrice','maxPrice','marginMultiplier','mrcPrice','mrcBuffer']);
    if (numKeys.has(key)) {
      const calcEl = document.getElementById('ri-calc-price');
      if (calcEl && this.form.type === 'margin') {
        const f = this.form;
        const cost = costPriceDb.get(f.vendorCode ?? '');
        calcEl.textContent = cost != null && f.marginMultiplier
          ? `${Math.round(cost * f.marginMultiplier).toLocaleString('ru')} ₽` : '—';
      }
      if (this.form.type === 'formula') this.updateFormulaPreview();
      return;
    }
    this.render();
  }

  saveForm(): void {
    const f = this.form;
    const mp = (f.marketplace ?? 'wb') as Mp;
    if (this.formProducts.length === 0 && !f.productId) { this.formError = 'Выберите товар'; this.render(); return; }
    if (!f.type) { this.formError = 'Выберите тип правила'; this.render(); return; }
    if (f.type === 'target'   && !f.targetPrice)                                  { this.formError = 'Укажите целевую цену'; this.render(); return; }
    if (f.type === 'margin') {
      if (!f.marginMultiplier) { this.formError = 'Укажите множитель'; this.render(); return; }
      // Проверяем себестоимость для всех товаров
      const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
      if (missing.length > 0) {
        this.formError = `⚠ Не задана себестоимость для: ${missing.map(p => p.vendorCode).join(', ')}. Перейдите во вкладку «Себестоимости».`;
        this.render(); return;
      }
    }
    if (f.type === 'stock') {
      const tiers = f.stockTiers ?? [];
      if (tiers.length === 0 || tiers.some(t => !isFinite(t.maxStock) || !isFinite(t.price))) {
        this.formError = 'Добавьте хотя бы один порог с корректными значениями'; this.render(); return;
      }
    }
    if (f.type === 'schedule') {
      const periods = f.schedulePeriods ?? [];
      if (periods.length === 0 || periods.some(p => p.days.length === 0 || !isFinite(p.price))) {
        this.formError = 'Добавьте хотя бы один период с днями и ценой'; this.render(); return;
      }
    }
    if (f.type === 'mrc') {
      if (this.formProducts.length > 1) {
        // При нескольких товарах — каждый может иметь свою цену ИЛИ общую f.mrcPrice
        const missingPrice = this.formProducts.filter(p =>
          !this.formProductMrcPrices.get(p.vendorCode) && !(f.mrcPrice && f.mrcPrice > 0)
        );
        if (missingPrice.length > 0) { this.formError = 'Укажите МРЦ хотя бы в поле «Общая МРЦ» или для каждого артикула отдельно'; this.render(); return; }
      } else {
        if (!f.mrcPrice || f.mrcPrice <= 0) { this.formError = 'Укажите МРЦ (цена покупателя на маркетплейсе)'; this.render(); return; }
      }
    }
    if (f.type === 'formula') {
      if (!f.formula?.trim()) { this.formError = 'Введите формулу'; this.render(); return; }
      if (/\bcost_price\b/.test(f.formula)) {
        const missing = this.formProducts.filter(p => costPriceDb.get(p.vendorCode) == null);
        if (missing.length > 0) {
          this.formError = `⚠ Формула использует cost_price, но себестоимость не задана для: ${missing.map(p => p.vendorCode).join(', ')}.`;
          this.render(); return;
        }
      }
      const cost = costPriceDb.get(f.vendorCode ?? '') ?? 0;
      const test = evalFormula(f.formula, { cost_price: cost, stock: 0, margin: f.marginMultiplier ?? 1 });
      if (test == null) { this.formError = 'Формула некорректна — проверьте синтаксис'; this.render(); return; }
    }

    const now = new Date().toISOString();

    // Собираем products — список всех выбранных товаров
    const products: RuleProduct[] = this.formProducts.length > 0
      ? [...this.formProducts]
      : [{ productId: f.productId!, vendorCode: f.vendorCode ?? '', productTitle: f.productTitle ?? f.productId! }];

    const baseRule = {
      productId: products[0].productId,
      vendorCode: products[0].vendorCode,
      productTitle: products[0].productTitle,
      products: products.length > 1 ? products : undefined,
      type: f.type! as RuleType,
      status: (f.status ?? 'active') as RuleStatus,
      targetPrice: f.targetPrice, marginMultiplier: f.marginMultiplier,
      minPrice: f.minPrice, maxPrice: f.maxPrice,
      stockTiers: f.stockTiers,
      schedulePeriods: f.schedulePeriods,
      formula: f.formula,
      mrcPrice: f.mrcPrice,
      mrcBuffer: f.mrcBuffer,
    };

    if (this.editId) {
      // Редактирование — обновляем одно правило
      const rule: RepricerRule = {
        ...baseRule,
        id: this.editId,
        marketplace: mp,
        storeId: f.storeId ?? '',
        storeName: f.storeName ?? '',
        createdAt: this.rules.find(r => r.id === this.editId)?.createdAt ?? now,
      };
      const idx = this.rules.findIndex(r => r.id === this.editId);
      if (idx >= 0) this.rules[idx] = rule;
    } else {
      // Создание — одно правило на магазин из formStoreIds, со ВСЕМИ товарами внутри
      const allStores: Array<{ id: string; name: string; mp: Mp }> = [
        ...this.wbStores.map(s    => ({ id: s.id, name: s.name, mp: 'wb'     as Mp })),
        ...this.ozonStores.map(s  => ({ id: s.id, name: s.name, mp: 'ozon'   as Mp })),
        ...this.ymStores.map(s    => ({ id: s.id, name: s.name, mp: 'yandex' as Mp })),
      ];

      let targetStores = allStores.filter(s => this.formStoreIds.has(s.id));

      // МРЦ: если явно не выбраны магазины — автоматически берём все, где есть хоть один из артикулов
      if (f.type === 'mrc' && targetStores.length === 0) {
        const vendorCodes = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
        const autoStoreIds = new Set<string>();
        for (const p of this.wbProducts)   { if (vendorCodes.has((p.vendor_code||'').toLowerCase()) || vendorCodes.has(String(p.nm_id))) autoStoreIds.add(p.store_id); }
        for (const p of this.ozonProducts) { if (vendorCodes.has(p.offer_id.toLowerCase())) autoStoreIds.add(p.store_id); }
        for (const p of this.ymProducts)   { if (vendorCodes.has((p.vendor_code||p.offer_id).toLowerCase())) autoStoreIds.add(p.store_id); }
        targetStores = allStores.filter(s => autoStoreIds.has(s.id));
      }

      if (targetStores.length === 0) {
        targetStores.push({ id: f.storeId ?? '', name: f.storeName ?? '', mp });
      }
      for (const store of targetStores) {
        // Резолвим productId для каждого товара в этом магазине
        const resolvedProducts: RuleProduct[] = products.map(prod => {
          let pid = prod.productId;
          if (store.mp === 'wb') {
            const p = this.wbProducts.find(p => (p.vendor_code === prod.vendorCode || String(p.nm_id) === prod.vendorCode) && p.store_id === store.id);
            if (p) pid = String(p.nm_id);
          } else if (store.mp === 'ozon') {
            const p = this.ozonProducts.find(p => p.offer_id === prod.vendorCode && p.store_id === store.id);
            if (p) pid = p.offer_id;
          } else {
            const p = this.ymProducts.find(p => (p.vendor_code === prod.vendorCode || p.offer_id === prod.vendorCode) && p.store_id === store.id);
            if (p) pid = p.offer_id;
          }
          return { ...prod, productId: pid };
        });

        if (f.type === 'mrc') {
          // МРЦ: одно правило на каждый артикул со своей ценой
          for (const prod of resolvedProducts) {
            const mrcPriceForProd = this.formProductMrcPrices.get(prod.vendorCode) || f.mrcPrice;
            const rule: RepricerRule = {
              ...baseRule,
              id: uid(),
              marketplace: store.mp,
              storeId: store.id,
              storeName: store.name,
              productId: prod.productId,
              vendorCode: prod.vendorCode,
              productTitle: prod.productTitle,
              products: undefined,
              mrcPrice: mrcPriceForProd,
              createdAt: now,
            };
            this.rules.unshift(rule);
          }
        } else if (f.type === 'formula') {
          // Формула: одно правило на магазин, у каждого магазина своя формула
          const storeFormula = this.formStoreFormulas.get(store.id) || f.formula || '';
          const rule: RepricerRule = {
            ...baseRule,
            id: uid(),
            marketplace: store.mp,
            storeId: store.id,
            storeName: store.name,
            productId: resolvedProducts[0].productId,
            vendorCode: resolvedProducts[0].vendorCode,
            productTitle: resolvedProducts[0].productTitle,
            products: resolvedProducts.length > 1 ? resolvedProducts : undefined,
            formula: storeFormula,
            createdAt: now,
          };
          this.rules.unshift(rule);
        } else {
          const rule: RepricerRule = {
            ...baseRule,
            id: uid(),
            marketplace: store.mp,
            storeId: store.id,
            storeName: store.name,
            productId: resolvedProducts[0].productId,
            vendorCode: resolvedProducts[0].vendorCode,
            productTitle: resolvedProducts[0].productTitle,
            products: resolvedProducts.length > 1 ? resolvedProducts : undefined,
            createdAt: now,
          };
          this.rules.unshift(rule);
        }
      }
    }

    repricerRulesDb.saveMany(this.rules);
    this.showForm = false; this.formError = '';
    this.formStoreIds.clear();
    this.formProducts = [];
    this.render();
  }

  deleteRule(id: string): void {
    this.rules = this.rules.filter(r => r.id !== id);
    repricerRulesDb.remove(id); this.render();
  }

  toggleStatus(id: string): void {
    const r = this.rules.find(r => r.id === id);
    if (r) { r.status = r.status === 'active' ? 'paused' : 'active'; repricerRulesDb.save(r); }
    this.render();
  }

  private computePrice(rule: RepricerRule): number | null {
    const stock = this.getStock(rule);
    const cost = costPriceDb.get(rule.vendorCode);
    const clamp = (p: number) => {
      if (rule.minPrice && p < rule.minPrice) return rule.minPrice;
      if (rule.maxPrice && p > rule.maxPrice) return rule.maxPrice;
      return p;
    };
    switch (rule.type) {
      case 'target': return rule.targetPrice ?? null;
      case 'margin': {
        if (cost == null || !rule.marginMultiplier) return null;
        return clamp(Math.round(cost * rule.marginMultiplier));
      }
      case 'stock': {
        // Multi-tier: ищем первый порог где stock ≤ maxStock (отсортировано по возрастанию)
        if (rule.stockTiers && rule.stockTiers.length > 0) {
          const tiers = [...rule.stockTiers].sort((a, b) => a.maxStock - b.maxStock);
          for (const t of tiers) if (stock <= t.maxStock) return clamp(t.price);
          return null;
        }
        // Legacy single-tier
        return stock <= (rule.stockThreshold ?? 10) ? (rule.highStockPrice ?? null) : (rule.lowStockPrice ?? null);
      }
      case 'schedule': {
        // Multi-period: проверяем все периоды
        if (rule.schedulePeriods && rule.schedulePeriods.length > 0) {
          const now = new Date();
          const day = now.getDay();
          const curMin = now.getHours() * 60 + now.getMinutes();
          for (const period of rule.schedulePeriods) {
            if (!period.days.includes(day)) continue;
            const [fh, fm] = (period.fromTime || '00:00').split(':').map(Number);
            const [th, tm] = (period.toTime || '23:59').split(':').map(Number);
            const fromMin = fh * 60 + fm;
            const toMin = th * 60 + tm;
            if (curMin >= fromMin && curMin <= toMin) return clamp(period.price);
          }
          return null;
        }
        // Legacy weekday/weekend
        const d = new Date().getDay();
        return (d === 0 || d === 6) ? (rule.weekendPrice ?? null) : (rule.weekdayPrice ?? null);
      }
      case 'formula': {
        if (!rule.formula) return null;
        // cost_price берётся из costPriceDb автоматически
        if (cost == null && /\bcost_price\b/.test(rule.formula)) return null;
        const result = evalFormula(rule.formula, {
          cost_price: cost ?? 0,
          stock,
          margin: rule.marginMultiplier ?? 1,
        });
        if (result == null) return null;
        return clamp(Math.round(result));
      }
      case 'mrc': {
        // Статическое отображение в таблице правил: показываем МРЦ.
        // Реальная цена продавца считается динамически при сканировании.
        if (!rule.mrcPrice) return null;
        return clamp(rule.mrcPrice);
      }
    }
  }

  // ── PRODUCT PICKER METHODS ─────────────────────────────────────────────
  openProductPicker(): void {
    this.pickerOpen = true;
    this.pickerSelected.clear();
    this.pickerSearch = '';
    this.pickerSelectedMps.clear();
    this.pickerSelectedStores.clear();
    this.pickerStockFilter = 'all';
    // Подхватываем все товары из formProducts
    for (const p of this.formProducts) {
      this.pickerSelected.add(p.vendorCode.toLowerCase());
    }
    this.render();
  }

  closeProductPicker(): void {
    this.pickerOpen = false;
    this.render();
  }

  setPickerSearch(q: string): void { this.pickerSearch = q; this.renderPickerOnly(); }
  setPickerStock(s: string): void { this.pickerStockFilter = s as any; this.renderPickerOnly(); }

  togglePickerItem(vendorCode: string): void {
    const k = vendorCode.toLowerCase();
    if (this.pickerSelected.has(k)) this.pickerSelected.delete(k);
    else this.pickerSelected.add(k);
    this.renderPickerOnly();
  }

  togglePickerAll(): void {
    const filtered = this.pickerFiltered;
    const allSelected = filtered.every(p => this.pickerSelected.has(p.vendorCode.toLowerCase()));
    if (allSelected) filtered.forEach(p => this.pickerSelected.delete(p.vendorCode.toLowerCase()));
    else filtered.forEach(p => this.pickerSelected.add(p.vendorCode.toLowerCase()));
    this.renderPickerOnly();
  }

  applyPickerSelection(): void {
    const all = this.buildUnifiedProducts();
    const selected = all.filter(p => this.pickerSelected.has(p.vendorCode.toLowerCase()));
    if (selected.length === 0) { this.closeProductPicker(); return; }

    // Для МРЦ — автоматически выбираем ВСЕ магазины всех маркетплейсов, где есть товар
    if (this.form.type === 'mrc' && this.formStoreIds.size === 0) {
      for (const p of selected) {
        for (const v of p.variants) this.formStoreIds.add(v.storeId);
      }
    }

    if (selected.length === 1) {
      // Один товар → подставляем в форму
      const p = selected[0];
      const candidates = p.variants.filter(v => this.formStoreIds.has(v.storeId));
      const v = candidates[0] ?? p.variants[0];
      this.form.marketplace = v.mp;
      this.form.productId = v.productId;
      this.form.vendorCode = p.vendorCode;
      this.form.productTitle = p.title;
      this.form.storeId = v.storeId;
      this.form.storeName = v.storeName;
      this.formProducts = [{ productId: v.productId, vendorCode: p.vendorCode, productTitle: p.title }];
    } else {
      // Несколько товаров → добавляем все в список формы
      this.formProducts = selected.map(p => {
        const candidates = p.variants.filter(v => this.formStoreIds.has(v.storeId));
        const v = candidates[0] ?? p.variants[0];
        return { productId: v.productId, vendorCode: p.vendorCode, productTitle: p.title };
      });
      const first = selected[0];
      const fv = first.variants.filter(v => this.formStoreIds.has(v.storeId))[0] ?? first.variants[0];
      this.form.marketplace = fv.mp;
      this.form.productId = fv.productId;
      this.form.vendorCode = first.vendorCode;
      this.form.productTitle = first.title;
      this.form.storeId = fv.storeId;
      this.form.storeName = fv.storeName;
    }
    this.pickerOpen = false;
    this.render();
  }

  /** Удалить товар из списка формы */
  removeFormProduct(vendorCode: string): void {
    this.formProducts = this.formProducts.filter(p => p.vendorCode !== vendorCode);
    if (this.formProducts.length === 0) {
      delete this.form.productId;
      delete this.form.vendorCode;
      delete this.form.productTitle;
    } else if (this.form.vendorCode === vendorCode) {
      // Если удалили текущий "основной" — берём первый из списка
      const f = this.formProducts[0];
      this.form.productId = f.productId;
      this.form.vendorCode = f.vendorCode;
      this.form.productTitle = f.productTitle;
    }
    this.render();
  }

  /** Лёгкая перерисовка только содержимого пикера без потери фокуса на поиске */
  private renderPickerOnly(): void {
    const host = document.getElementById('rp-picker-host');
    if (!host) return;
    const active = document.activeElement as HTMLInputElement | null;
    const wasSearch = active?.type === 'search';
    const selStart = wasSearch ? active!.selectionStart : null;
    const selEnd   = wasSearch ? active!.selectionEnd   : null;
    host.innerHTML = this.renderPicker();
    if (wasSearch) {
      const inp = host.querySelector('input[type="search"]') as HTMLInputElement | null;
      if (inp) {
        inp.focus();
        if (selStart !== null && selEnd !== null) inp.setSelectionRange(selStart, selEnd);
      }
    }
  }

  /** HTML пикера. Возвращает только инкапсулированный <div>. */
  private renderPicker(): string {
    const list = this.pickerFiltered;
    const allCount = this.buildUnifiedProducts().length;
    const allSelected = list.length > 0 && list.every(p => this.pickerSelected.has(p.vendorCode.toLowerCase()));
    const pickerStores = this.storesForPicker();

    // Количество выбранных товаров
    void this.pickerSelected.size;

    const mpChip = (mp: Mp, label: string) => {
      const on = this.pickerSelectedMps.has(mp);
      return `<button onclick="window.repricerModule.togglePickerMp('${mp}')"
        style="padding:5px 13px;border:1.5px solid ${on ? MP_COLOR[mp] : 'var(--border)'};
          background:${on ? MP_BG[mp] : 'var(--bg)'};color:${on ? MP_COLOR[mp] : 'var(--text2)'};
          border-radius:20px;cursor:pointer;font-size:12px;font-weight:${on ? '700' : '500'};transition:all .12s">
        ${on ? '✓ ' : ''}${label}
      </button>`;
    };

    const storeChip = (s: { id: string; name: string; mp: Mp }) => {
      const on = this.pickerSelectedStores.has(s.id);
      return `<button onclick="window.repricerModule.togglePickerStore('${this.esc(s.id)}')" title="${this.esc(s.name)}"
        style="padding:5px 13px;border:1.5px solid ${on ? MP_COLOR[s.mp] : 'var(--border)'};
          background:${on ? MP_BG[s.mp] : 'var(--bg)'};color:${on ? MP_COLOR[s.mp] : 'var(--text2)'};
          border-radius:20px;cursor:pointer;font-size:12px;font-weight:${on ? '700' : '500'};
          max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all .12s">
        ${on ? '✓ ' : ''}${this.esc(s.name)}
      </button>`;
    };

    return `
      <!-- ПОИСК + ОСТАТОК -->
      <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <input type="search" placeholder="Поиск по артикулу или названию…" value="${this.esc(this.pickerSearch)}"
          oninput="window.repricerModule.setPickerSearch(this.value)"
          style="flex:1;min-width:180px;padding:7px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:13px">
        <select onchange="window.repricerModule.setPickerStock(this.value)"
          style="padding:7px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
          <option value="all" ${this.pickerStockFilter === 'all' ? 'selected' : ''}>Любой остаток</option>
          <option value="in"  ${this.pickerStockFilter === 'in'  ? 'selected' : ''}>В наличии</option>
          <option value="out" ${this.pickerStockFilter === 'out' ? 'selected' : ''}>Закончился</option>
        </select>
        <button onclick="window.repricerModule.togglePickerAll()"
          style="padding:7px 14px;border:1px solid var(--accent);background:${allSelected ? 'var(--accent)' : 'transparent'};color:${allSelected ? '#000' : 'var(--accent)'};border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
          ${allSelected ? '✓ Снять все' : 'Выбрать все'}
        </button>
      </div>

      <!-- МАРКЕТПЛЕЙСЫ (кнопки-чипы) -->
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg2)">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:7px">
          Маркетплейс
          ${this.pickerSelectedMps.size > 0 ? `<button onclick="window.repricerModule.clearPickerMps()" style="margin-left:8px;font-size:10px;color:var(--text2);background:none;border:none;cursor:pointer;text-decoration:underline">сбросить</button>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${this.wbStores.length > 0 ? mpChip('wb', 'Wildberries') : ''}
          ${this.ozonStores.length > 0 ? mpChip('ozon', 'Ozon') : ''}
          ${this.ymStores.length > 0 ? mpChip('yandex', 'Я.Маркет') : ''}
          ${(this.wbStores.length === 0 && this.ozonStores.length === 0 && this.ymStores.length === 0)
            ? '<span style="font-size:12px;color:var(--text2)">Нет подключённых магазинов</span>' : ''}
        </div>
      </div>

      <!-- МАГАЗИНЫ (кнопки-чипы, сгруппированы по МП) -->
      ${pickerStores.length > 0 ? `
        <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">
              Магазин (правила создадутся для выбранных)
            </div>
            ${this.pickerSelectedStores.size > 0 ? `
              <button onclick="window.repricerModule.clearPickerStores()"
                style="font-size:10px;color:var(--text2);background:none;border:none;cursor:pointer;text-decoration:underline">Сбросить (${this.pickerSelectedStores.size})</button>
            ` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${pickerStores.map(s => storeChip(s)).join('')}
          </div>
          ${this.pickerSelectedStores.size === 0 ? `
            <div style="margin-top:6px;font-size:10.5px;color:var(--text2)">
              💡 Не выбраны = правила создадутся для всех магазинов выбранного МП
            </div>
          ` : `
            <div style="margin-top:6px;font-size:10.5px;color:#059669;font-weight:600">
              ✓ Правила создадутся только для выбранных магазинов (${this.pickerSelectedStores.size} шт)
            </div>
          `}
        </div>
      ` : ''}

      <!-- СТАТИСТИКА -->
      <div style="padding:7px 16px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;background:var(--bg2)">
        <span>Показано <b style="color:var(--text)">${list.length}</b> из ${allCount}</span>
        <span>Выбрано товаров: <b style="color:var(--accent)">${this.pickerSelected.size}</b></span>
      </div>

      <!-- СПИСОК ТОВАРОВ -->
      <div style="flex:1;overflow-y:auto;min-height:0;padding-bottom:90px">
        ${list.length === 0 ? `
          <div style="padding:40px;text-align:center;color:var(--text2);font-size:13px">
            Ничего не найдено · попробуйте изменить фильтры
          </div>
        ` : list.map(p => {
          const sel = this.pickerSelected.has(p.vendorCode.toLowerCase());
          const totalStock = p.variants.reduce((s,v) => s+v.stock, 0);
          const prices = p.variants.filter(v => v.price != null).map(v => v.price!);
          const minP = prices.length ? Math.min(...prices) : null;
          const maxP = prices.length ? Math.max(...prices) : null;
          // Показываем только варианты из выбранных магазинов (или все)
          const visVariants = this.pickerSelectedStores.size > 0
            ? p.variants.filter(v => this.pickerSelectedStores.has(v.storeId))
            : this.pickerSelectedMps.size > 0
              ? p.variants.filter(v => this.pickerSelectedMps.has(v.mp))
              : p.variants;
          return `
            <div onclick="window.repricerModule.togglePickerItem('${this.esc(p.vendorCode)}')"
              style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);cursor:pointer;
                background:${sel ? 'color-mix(in srgb,var(--accent) 8%,transparent)' : 'transparent'};transition:background .1s">
              <div style="width:20px;height:20px;border:1.5px solid ${sel ? 'var(--accent)' : 'var(--border)'};border-radius:5px;
                background:${sel ? 'var(--accent)' : 'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center">
                ${sel ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#000" stroke-width="2"><path d="M2 6l3 3 5-6"/></svg>' : ''}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(p.title)}</div>
                <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">
                  <span style="font-family:monospace;font-size:10.5px;color:var(--text2);background:var(--bg3);padding:1px 6px;border-radius:4px">${this.esc(p.vendorCode)}</span>
                  ${visVariants.map(v => `
                    <span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[v.mp]};color:${MP_COLOR[v.mp]}">
                      ${MP_LABEL[v.mp]}${v.storeName ? ' · ' + this.esc(v.storeName) : ''}
                    </span>
                  `).join('')}
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:13px;font-weight:700;color:${minP ? 'var(--text)' : 'var(--text2)'}">
                  ${minP != null && maxP != null ? (minP === maxP ? `${minP.toLocaleString('ru')} ₽` : `${minP.toLocaleString('ru')}–${maxP.toLocaleString('ru')} ₽`) : '—'}
                </div>
                <div style="font-size:11px;color:${totalStock > 0 ? '#16a34a' : '#dc2626'};margin-top:2px">${totalStock} шт</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- ФУТЕР -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg2)">
        <div style="font-size:12px;color:var(--text2)">
          ${this.pickerSelected.size > 1
            ? `<b style="color:#059669">${this.pickerSelected.size} товаров</b> будут добавлены в одно правило`
            : this.pickerSelected.size === 1
              ? 'Товар будет выбран в форме'
              : 'Выберите один или несколько товаров'}
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="window.repricerModule.closeProductPicker()"
            style="padding:8px 18px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:13px">Отмена</button>
          <button onclick="window.repricerModule.applyPickerSelection()" ${this.pickerSelected.size === 0 ? 'disabled' : ''}
            style="padding:8px 20px;border:none;background:#059669;color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;opacity:${this.pickerSelected.size === 0 ? '.5' : '1'}">
            ${this.pickerSelected.size > 1 ? `Добавить ${this.pickerSelected.size} товаров` : 'Выбрать'}
          </button>
        </div>
      </div>
    `;
  }

  private esc(s: string): string {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Быстрая вставка в textarea формулы
  insertFormulaToken(token: string): void {
    const ta = document.getElementById('ri-formula') as HTMLTextAreaElement | null;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const newVal = ta.value.slice(0, start) + token + ta.value.slice(end);
    ta.value = newVal;
    this.form.formula = newVal;
    ta.focus();
    const pos = start + token.length;
    ta.setSelectionRange(pos, pos);
    this.updateFormulaPreview();
  }

  updateFormula(value: string): void {
    this.form.formula = value;
    this.updateFormulaPreview();
  }

  private updateFormulaPreview(): void {
    const el = document.getElementById('ri-formula-preview');
    if (!el) return;
    const f = this.form;
    const cost = costPriceDb.get(f.vendorCode ?? '') ?? 0;
    const result = evalFormula(f.formula ?? '', {
      cost_price: cost,
      stock: 0,
      margin: f.marginMultiplier ?? 1,
    });
    if (result == null) {
      el.innerHTML = '<span style="color:var(--text2)">— (укажите корректную формулу)</span>';
    } else {
      el.innerHTML = `<span style="color:#16a34a;font-weight:700">${Math.round(result).toLocaleString('ru')} ₽</span>
        <span style="color:var(--text2);font-size:11px;margin-left:6px">при cost_price=${cost}, margin=${f.marginMultiplier ?? 1}</span>`;
    }
  }

  private getStock(rule: RepricerRule): number {
    if (rule.marketplace === 'wb') return this.wbProducts.find(p => String(p.nm_id) === rule.productId)?.stock_total ?? 0;
    if (rule.marketplace === 'ozon') {
      const p = this.ozonProducts.find(p => p.offer_id === rule.productId);
      return (p?.stock_fbs ?? 0) + (p?.stock_fbo ?? 0);
    }
    return this.ymProducts.find(p => p.offer_id === rule.productId)?.stock_total ?? 0;
  }

  /** Фото товара (первая картинка из карточки маркетплейса), если найдена в кэше. */
  private getProductImage(rule: RepricerRule): string | null {
    if (rule.marketplace === 'wb') {
      const p = this.wbProducts.find(p => String(p.nm_id) === rule.productId && p.store_id === rule.storeId);
      return p?.pictures?.[0] ?? null;
    }
    if (rule.marketplace === 'ozon') {
      const p = this.ozonProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId);
      return p?.images?.[0] ?? null;
    }
    const p = this.ymProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId);
    return p?.pictures?.[0] ?? null;
  }

  /** Реальная цена товара на маркетплейсе сейчас (из последней синхронизации каталога). */
  private getCurrentPrice(rule: RepricerRule): number | null {
    if (rule.marketplace === 'wb') {
      return this.wbProducts.find(p => String(p.nm_id) === rule.productId && p.store_id === rule.storeId)?.price ?? null;
    }
    if (rule.marketplace === 'ozon') {
      return this.ozonProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId)?.price ?? null;
    }
    return this.ymProducts.find(p => p.offer_id === rule.productId && p.store_id === rule.storeId)?.basic_price ?? null;
  }

  async applyRule(id: string): Promise<void> {
    const rule = this.rules.find(r => r.id === id);
    if (!rule || this.applying.has(id)) return;
    this.applying.add(id); this.render();

    const products = ruleProducts(rule);

    try {
      for (const prod of products) {
        // Вычисляем цену для каждого товара (себестоимость может отличаться)
        const newPrice = this.computePriceForProduct(rule, prod);
        if (!newPrice) continue;

        if (rule.marketplace === 'wb') {
          const store = this.wbStores.find(s => s.id === rule.storeId);
          if (!store) throw new Error('Магазин WB не найден');
          const wbProd = this.wbProducts.find(p => String(p.nm_id) === prod.productId && p.store_id === rule.storeId);
          // МРЦ на WB: computePriceForProduct() уже поднял цену с учётом скидки продавца
          // (sellerPrice = targetShowcase / (1 - discount/100)), поэтому здесь применяем
          // newPrice как есть — повторное деление на (1 - discount/100) задвоило бы скидку.
          const discount = rule.type === 'mrc' ? (wbProd?.discount ?? 0) : 0;
          const wbPrice = newPrice;
          await updateWbPrices(store.api_key, [{ nmID: Number(prod.productId), price: wbPrice, discount }]);
          // Обновляем in-memory кеш
          if (wbProd) wbProd.price = wbPrice;
        } else if (rule.marketplace === 'ozon') {
          const store = this.ozonStores.find(s => s.id === rule.storeId);
          if (!store) throw new Error('Магазин Ozon не найден');
          const creds = { client_id: store.client_id, api_key: store.api_key };
          const p = this.ozonProducts.find(p => p.offer_id === prod.productId);
          let ozonPrice = newPrice;
          let ozonRefOldPrice: number | null = null;

          if (rule.type === 'mrc' && rule.mrcPrice) {
            // МРЦ на Ozon: сначала убираем из акций, затем ставим цену.
            ozonPrice = mrcEffectiveTarget(rule);
            if (p?.product_id) {
              try {
                await ozonApi.removeProductsFromAllPromos(creds, [p.product_id]);
              } catch (e: any) {
                console.warn('[Ozon MRC] removeFromPromos error:', e?.message);
              }
            }
            // old_price для МРЦ не отправляем — зачёркнутая цена может запустить автоакции
          } else {
            // Для обычных правил оставляем old_price для визуального "до скидки"
            if (p?.old_price && p.old_price > ozonPrice) ozonRefOldPrice = p.old_price;
            else if (p?.price && p.price > ozonPrice) ozonRefOldPrice = p.price;
          }

          const rawMinP = rule.type === 'mrc' && rule.mrcPrice
            ? Math.max(1, ozonPrice - 1)
            : (rule.minPrice ?? Math.round(ozonPrice * 0.8));
          const minP = rawMinP >= ozonPrice ? Math.max(1, ozonPrice - 1) : rawMinP;
          const safeOldPrice = (ozonRefOldPrice ?? 0) > ozonPrice ? ozonRefOldPrice! : 0;
          await ozonApi.updatePrices(
            creds,
            [{
              offer_id: prod.productId,
              price: String(ozonPrice),
              ...(safeOldPrice > 0 ? { old_price: String(safeOldPrice) } : {}),
              min_price: String(minP),
              auto_action_enabled: rule.type === 'mrc' ? 'DISABLED' : 'ENABLED',
            }],
          );
          if (p) p.price = ozonPrice;
        } else {
          const store = this.ymStores.find(s => s.id === rule.storeId);
          if (!store?.campaign_id) throw new Error('Магазин ЯМ или campaign_id не найден');
          const ymProd = this.ymProducts.find(p => p.offer_id === prod.productId && p.store_id === store.id);

          let ymSellerPrice: number;

          if (rule.type === 'mrc') {
            // МРЦ: сначала убираем из промо (блокирующий вызов), потом ставим цену.
            // Если делать async — ЯМ может успеть применить промо-цену поверх basicPrice.
            ymSellerPrice = newPrice;
            try {
              const businessId = await yandexApi.getBusinessId(store.api_key, store.campaign_id);
              if (businessId) {
                await yandexApi.removeOffersFromAllPromos(store.api_key, businessId, [prod.productId]);
              }
            } catch (e: any) {
              console.warn('[YM MRC] removeFromPromos error:', e?.message);
            }
          } else {
            // Для остальных типов правил пробуем скорректировать на коэффициент скидки ЯМ
            let ymCatalogPrice = ymProd?.basic_price ?? 0;
            let ymSetPrice     = ymCatalogPrice; // цена которую мы ставили раньше
            try {
              const priceMap = await yandexApi.getOfferPrices(store.api_key, String(store.campaign_id));
              const d = priceMap.get(prod.productId);
              if (d?.price && d.price > 0)       ymSetPrice     = d.price;
              if (d?.discountBase && d.discountBase > 0) ymCatalogPrice = d.discountBase;
            } catch { /* fallback на basic_price */ }
            ymSellerPrice = newPrice;
            if (ymCatalogPrice > 0 && ymSetPrice > 0 && ymCatalogPrice > ymSetPrice) {
              ymSellerPrice = Math.ceil(newPrice * ymCatalogPrice / ymSetPrice);
            }
          }

          await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), [{
            offerId: prod.productId,
            price: ymSellerPrice,
            ...(rule.type === 'mrc'
              ? { clearDiscountBase: true }
              : { oldPrice: ymProd?.basic_price || undefined }),
          }]);
          if (ymProd) ymProd.basic_price = ymSellerPrice;
        }

        const oldPrice =
          rule.marketplace === 'wb'    ? (this.wbProducts.find(p => String(p.nm_id) === prod.productId)?.price ?? null) :
          rule.marketplace === 'ozon'  ? (this.ozonProducts.find(p => p.offer_id === prod.productId)?.price ?? null) :
                                         (this.ymProducts.find(p => p.offer_id === prod.productId)?.basic_price ?? null);

        const entry: PriceLog = {
          id: uid(), ruleId: id, marketplace: rule.marketplace,
          storeName: rule.storeName, productTitle: prod.productTitle,
          oldPrice, newPrice, appliedAt: new Date().toISOString(), reason: RULE_LABELS[rule.type],
        };
        this.log.unshift(entry); saveLog(this.log);
      }
      rule.lastAppliedAt = new Date().toISOString();
      repricerRulesDb.save(rule);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      console.error('[Repricer] applyRule:', msg);
      this.applyErrors.set(id,
        msg.includes('429') ? 'WB: слишком много запросов — подождите несколько минут и повторите' :
        msg.includes('LOCKED') ? 'ЯМ: в настройках магазина отключено изменение цен через API (LOCKED)' :
        msg
      );
      setTimeout(() => { this.applyErrors.delete(id); this.render(); }, 8000);
    }
    this.applying.delete(id); this.render();
  }

  /** Вычислить цену для конкретного товара в правиле. */
  private computePriceForProduct(rule: RepricerRule, prod: RuleProduct): number | null {
    const stock = this.getStockForProduct(rule, prod);
    const cost = costPriceDb.get(prod.vendorCode);
    const clamp = (p: number) => {
      if (rule.minPrice && p < rule.minPrice) return rule.minPrice;
      if (rule.maxPrice && p > rule.maxPrice) return rule.maxPrice;
      return p;
    };
    switch (rule.type) {
      case 'target': return rule.targetPrice ?? null;
      case 'margin': {
        if (cost == null || !rule.marginMultiplier) return null;
        return clamp(Math.round(cost * rule.marginMultiplier));
      }
      case 'stock': {
        if (rule.stockTiers && rule.stockTiers.length > 0) {
          const sorted = [...rule.stockTiers].sort((a, b) => a.maxStock - b.maxStock);
          for (const t of sorted) { if (stock <= t.maxStock) return clamp(t.price); }
          return clamp(sorted[sorted.length - 1].price);
        }
        if (rule.stockThreshold != null) {
          return stock <= rule.stockThreshold ? clamp(rule.lowStockPrice ?? 0) : clamp(rule.highStockPrice ?? 0);
        }
        return null;
      }
      case 'schedule': {
        const day = new Date().getDay();
        if (rule.schedulePeriods && rule.schedulePeriods.length > 0) {
          const match = rule.schedulePeriods.find(p => p.days.includes(day));
          if (match) return clamp(match.price);
        }
        const wd = [1,2,3,4,5].includes(day);
        return wd ? (rule.weekdayPrice ?? null) : (rule.weekendPrice ?? null);
      }
      case 'formula': {
        if (!rule.formula) return null;
        const result = evalFormula(rule.formula, { cost_price: cost ?? 0, stock, margin: rule.marginMultiplier ?? 1 });
        if (result == null) return null;
        return clamp(Math.round(result));
      }
      case 'mrc': {
        if (!rule.mrcPrice) return null;
        const targetShowcase = mrcEffectiveTarget(rule);
        // WB: цена покупателя = sellerPrice × (1 − discount/100)
        // Чтобы покупатель видел именно targetShowcase → нужно поднять sellerPrice
        if (rule.marketplace === 'wb') {
          const wbProd = this.wbProducts.find(p => String(p.nm_id) === prod.productId && p.store_id === rule.storeId);
          const discount = wbProd?.discount ?? 0;
          return clamp(wbSellerPriceForMrc(targetShowcase, discount));
        }
        return clamp(targetShowcase);
      }
    }
  }

  /** Получить остаток для конкретного товара. */
  private getStockForProduct(rule: RepricerRule, prod: RuleProduct): number {
    if (rule.marketplace === 'wb') {
      return this.wbProducts.find(p => String(p.nm_id) === prod.productId)?.stock_total ?? 0;
    } else if (rule.marketplace === 'ozon') {
      const p = this.ozonProducts.find(p => p.offer_id === prod.productId);
      return (p?.stock_fbs ?? 0) + (p?.stock_fbo ?? 0);
    } else {
      return this.ymProducts.find(p => p.offer_id === prod.productId)?.stock_total ?? 0;
    }
  }

  async applyAll(): Promise<void> {
    const active = this.rules.filter(r => r.status === 'active' && !this.applying.has(r.id));
    for (const r of active) await this.applyRule(r.id);
  }

  // ── MRC Auto-Scan ──────────────────────────────────────────────────────────

  private loadMrcScanConfig(): void {
    try {
      const raw = localStorage.getItem(MRC_SCAN_CFG_KEY);
      if (raw) {
        const cfg: MrcScanConfig = JSON.parse(raw);
        this.mrcScanEnabled       = cfg.enabled ?? false;
        this.mrcScanIntervalHours = cfg.intervalHours ?? 1;
      }
      const logRaw = localStorage.getItem(MRC_SCAN_LOG_KEY);
      this.mrcScanLog = logRaw ? JSON.parse(logRaw) : [];
      const last = this.mrcScanLog[0]?.scannedAt ?? null;
      this.mrcLastScanAt = last;
    } catch { /* ignore */ }
    this.loadMrcProductStates();
  }

  private saveMrcScanConfig(): void {
    const cfg: MrcScanConfig = { enabled: this.mrcScanEnabled, intervalHours: this.mrcScanIntervalHours };
    localStorage.setItem(MRC_SCAN_CFG_KEY, JSON.stringify(cfg));
  }

  private saveMrcScanLog(): void {
    localStorage.setItem(MRC_SCAN_LOG_KEY, JSON.stringify(this.mrcScanLog.slice(0, 200)));
  }

  private loadMrcProductStates(): void {
    try {
      const raw = localStorage.getItem(MRC_PRODUCT_STATE_KEY);
      if (raw) {
        const obj: Record<string, MrcProductState> = JSON.parse(raw);
        this.mrcProductStates = new Map(Object.entries(obj));
      }
    } catch { /* ignore */ }
  }

  private saveMrcProductStates(): void {
    try {
      const obj: Record<string, MrcProductState> = {};
      for (const [k, v] of this.mrcProductStates) obj[k] = v;
      localStorage.setItem(MRC_PRODUCT_STATE_KEY, JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  /** Получить (или создать) состояние для конкретного товара. */
  private getMrcState(marketplace: Mp, storeId: string, productId: string): MrcProductState {
    const key = `${marketplace}:${storeId}:${productId}`;
    if (!this.mrcProductStates.has(key)) {
      this.mrcProductStates.set(key, {
        discountFactor: 1, lastUpdateAt: null, lastSellerPrice: 0, lastShowcasePrice: 0,
      });
    }
    return this.mrcProductStates.get(key)!;
  }

  toggleMrcPanel(): void {
    this.mrcPanelCollapsed = !this.mrcPanelCollapsed;
    localStorage.setItem('rpr_mrc_collapsed', this.mrcPanelCollapsed ? '1' : '0');
    this.render();
  }

  toggleMrcAutoScan(): void {
    this.mrcScanEnabled = !this.mrcScanEnabled;
    this.saveMrcScanConfig();
    if (this.mrcScanEnabled) this.startAutoScan();
    else this.stopAutoScan();
    this.render();
  }

  setMrcScanInterval(hours: number): void {
    this.mrcScanIntervalHours = hours;
    this.saveMrcScanConfig();
    if (this.mrcScanEnabled) {
      this.stopAutoScan();
      this.startAutoScan();
    }
    this.render();
  }

  private startAutoScan(): void {
    this.stopAutoScan();
    const ms = this.mrcScanIntervalHours * 60 * 60 * 1000;
    this.mrcScanTimer = setInterval(() => { this.runMrcScan(); }, ms);
  }

  private stopAutoScan(): void {
    if (this.mrcScanTimer != null) { clearInterval(this.mrcScanTimer); this.mrcScanTimer = null; }
  }

  private startCountdown(): void {
    if (this.mrcCountdownTimer != null) return;
    this.mrcCountdownTimer = setInterval(() => {
      const el = document.getElementById('rpr-mrc-countdown');
      if (!el) { this.stopCountdown(); return; }
      if (!this.mrcScanEnabled || !this.mrcLastScanAt || this.mrcScanning) {
        el.textContent = this.mrcScanning ? 'идёт проверка…' : '—';
        return;
      }
      const nextMs = new Date(this.mrcLastScanAt).getTime() + this.mrcScanIntervalHours * 3600000 - Date.now();
      if (nextMs <= 0) { el.textContent = 'сейчас…'; return; }
      const h = Math.floor(nextMs / 3600000);
      const m = Math.floor((nextMs % 3600000) / 60000);
      const s = Math.floor((nextMs % 60000) / 1000);
      el.textContent = h > 0
        ? `${h}ч ${String(m).padStart(2,'0')}м ${String(s).padStart(2,'0')}с`
        : `${m}:${String(s).padStart(2,'0')}`;
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.mrcCountdownTimer != null) { clearInterval(this.mrcCountdownTimer); this.mrcCountdownTimer = null; }
  }

  async runMrcScan(interactive = false): Promise<void> {
    if (this.mrcScanning) return;
    const mrcRules = this.rules.filter(r => r.status === 'active' && r.type === 'mrc');
    if (mrcRules.length === 0) return;

    this.mrcScanning = true;
    this.render();

    const nowIso = new Date().toISOString();
    const newEntries: MrcScanEntry[] = [];
    // Применение цен откладывается до подтверждения пользователем (если interactive)
    const pendingApplies: Array<() => Promise<void>> = [];
    // Если пользователь откажется — откатываем отметку кулдауна, чтобы при следующей
    // проверке снова предложить изменить цену, а не молчать "кулдаун"
    const cooldownTouches: Array<{ state: MrcProductState; prev: string | null }> = [];

    // ── Ozon ──────────────────────────────────────────────────────────────────
    const byOzonStore = new Map<string, RepricerRule[]>();
    for (const r of mrcRules) {
      if (r.marketplace !== 'ozon') continue;
      const list = byOzonStore.get(r.storeId) ?? [];
      list.push(r); byOzonStore.set(r.storeId, list);
    }

    for (const [storeId, rules] of byOzonStore) {
      const store = this.ozonStores.find(s => s.id === storeId);
      if (!store) continue;
      const creds = { client_id: store.client_id, api_key: store.api_key };

      const allProds: Array<{ rule: RepricerRule; prod: RuleProduct }> = [];
      for (const rule of rules) for (const prod of ruleProducts(rule)) allProds.push({ rule, prod });
      const offerIds = [...new Set(allProds.map(x => x.prod.productId))];

      let priceMap = new Map<string, { marketingPrice: number; sellerPrice: number; oldPrice: number }>();
      try {
        priceMap = await ozonApi.getMarketingPrices(offerIds, creds);
      } catch (e: any) {
        for (const { rule, prod } of allProds) newEntries.push({
          id: uid(), scannedAt: nowIso, marketplace: 'ozon', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice: rule.mrcPrice ?? 0, sellerPrice: 0, buyerPrice: 0,
          discountAmount: 0, discountPercent: 0, discountFactor: 1, action: 'error',
          errorMsg: e?.message?.slice(0, 120) ?? 'Ошибка API',
        });
        continue;
      }

      const priceUpdates: Array<{ offer_id: string; price: string; old_price?: string; min_price: string; auto_action_enabled: 'DISABLED' }> = [];
      for (const { rule, prod } of allProds) {
        let apiData: { marketingPrice: number; sellerPrice: number; oldPrice: number } | undefined =
          priceMap.get(prod.productId) ?? priceMap.get(prod.productId.toLowerCase());
        if (!apiData) {
          const cached = this.ozonProducts.find(p =>
            p.store_id === storeId && (
              p.offer_id === prod.productId ||
              p.offer_id.toLowerCase() === prod.productId.toLowerCase()
            )
          );
          if (cached && cached.price > 0) {
            apiData = { marketingPrice: cached.price, sellerPrice: cached.price, oldPrice: cached.old_price ?? 0 };
          } else {
            newEntries.push({
              id: uid(), scannedAt: nowIso, marketplace: 'ozon', storeName: rule.storeName,
              productTitle: prod.productTitle, vendorCode: prod.vendorCode,
              mrcPrice: rule.mrcPrice ?? 0, sellerPrice: 0, buyerPrice: 0,
              discountAmount: 0, discountPercent: 0, discountFactor: 1, action: 'error',
              errorMsg: `Товар не найден (offer_id: ${prod.productId})`,
            });
            continue;
          }
        }

        // marketing_price = публичная витринная цена Ozon (без персональных скидок: Ozon Карта, Premium).
        // Покупатель с Ozon Картой/Premium увидит цену ещё ниже marketingPrice — этого Ozon API
        // не отдаёт, поэтому компенсируем через mrcBuffer (% скидки сверх marketing_price,
        // targetShowcase = mrcPrice / (1 - mrcBuffer/100)).
        const showcasePrice = apiData.marketingPrice;
        const sellerPrice   = apiData.sellerPrice;
        const mrcPrice      = rule.mrcPrice ?? 0;
        const targetShowcase = mrcEffectiveTarget(rule);

        const state = this.getMrcState('ozon', storeId, prod.productId);
        updateDiscountFactor(state, showcasePrice, sellerPrice);

        const discountAmount  = Math.max(0, sellerPrice - showcasePrice);
        const discountPercent = sellerPrice > 0 ? Math.round(discountAmount / sellerPrice * 1000) / 10 : 0;

        if (!mrcShowcaseDeviated(showcasePrice, targetShowcase)) {
          // ≤ 1% отклонения — всё в порядке
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'ozon', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'ok', recommendedPrice: sellerPrice,
            lastUpdateAt: state.lastUpdateAt });
          continue;
        }

        if (isMrcProductCooling(state)) {
          // Цену меняли < 1 часа назад — ждём следующего цикла
          const recPrice = (() => {
            let p = computeNewSellerPrice(targetShowcase, sellerPrice, showcasePrice);
            return rule.maxPrice ? Math.min(p, rule.maxPrice) : p;
          })();
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'ozon', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'cooldown', recommendedPrice: recPrice,
            lastUpdateAt: state.lastUpdateAt,
            errorMsg: `Кулдаун: последнее изменение ${state.lastUpdateAt?.slice(11, 16)}` });
          continue;
        }

        // Ozon сам пересчитывает marketing_price от нашей цены продавца с переменным % —
        // этот % меняется от скана к скану (то выше, то ниже). Поэтому не ставим
        // price = targetShowcase напрямую (тогда marketing_price снова уедет от МРЦ),
        // а как и для WB — корректируем seller price пропорционально текущему отклонению.
        // auto_action_enabled: DISABLED отключает участие в акциях продавца.
        let newSeller = computeNewSellerPrice(targetShowcase, sellerPrice, showcasePrice);
        if (rule.maxPrice) newSeller = Math.min(newSeller, rule.maxPrice);

        const refOld = (apiData.oldPrice && apiData.oldPrice > sellerPrice) ? apiData.oldPrice : sellerPrice;
        // Ozon требует old_price > price строго.
        const safeRefOld = refOld > newSeller ? refOld : 0;
        // Ozon требует min_price < price строго.
        const safeMinP = Math.max(1, newSeller - 1);
        priceUpdates.push({
          offer_id: prod.productId,
          price: String(newSeller),
          ...(safeRefOld > 0 ? { old_price: String(safeRefOld) } : {}),
          min_price: String(safeMinP),
          auto_action_enabled: 'DISABLED',
        });
        cooldownTouches.push({ state, prev: state.lastUpdateAt });
        state.lastUpdateAt = nowIso;
        newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'ozon', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
          discountFactor: state.discountFactor, action: 'adjusted', newPrice: newSeller,
          recommendedPrice: newSeller, lastUpdateAt: state.lastUpdateAt });
      }
      if (priceUpdates.length > 0) {
        pendingApplies.push(async () => {
          try {
            await ozonApi.updatePrices(creds, priceUpdates);
            for (const upd of priceUpdates) {
              const p = this.ozonProducts.find(p => p.offer_id === upd.offer_id && p.store_id === storeId);
              if (p) p.price = Number(upd.price);
            }
          } catch (e: any) {
            for (const entry of newEntries) {
              if (entry.action === 'adjusted' && entry.marketplace === 'ozon' && entry.storeName === store.name && entry.scannedAt === nowIso) {
                entry.action = 'error'; entry.errorMsg = e?.message?.slice(0, 120) ?? 'Ошибка API'; delete entry.newPrice;
              }
            }
          }
        });
      }
    }

    // ── WB ────────────────────────────────────────────────────────────────────
    const byWbStore = new Map<string, RepricerRule[]>();
    for (const r of mrcRules) {
      if (r.marketplace !== 'wb') continue;
      const list = byWbStore.get(r.storeId) ?? [];
      list.push(r); byWbStore.set(r.storeId, list);
    }

    for (const [storeId, rules] of byWbStore) {
      const store = this.wbStores.find(s => s.id === storeId);
      if (!store) continue;

      const allProds: Array<{ rule: RepricerRule; prod: RuleProduct }> = [];
      for (const rule of rules) for (const prod of ruleProducts(rule)) allProds.push({ rule, prod });
      const nmIds = [...new Set(allProds.map(x => Number(x.prod.productId)))].filter(n => n > 0);

      let wbPriceMap = new Map<number, { price: number; discount: number; priceWithDisc: number }>();
      if (isWbCoolingDown('wb-prices')) {
        const sec = wbCooldownRemaining('wb-prices');
        for (const { rule, prod } of allProds) newEntries.push({
          id: uid(), scannedAt: nowIso, marketplace: 'wb', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice: rule.mrcPrice ?? 0, sellerPrice: 0, buyerPrice: 0,
          discountAmount: 0, discountPercent: 0, discountFactor: 1, action: 'error',
          errorMsg: `WB rate-limit — подождите ещё ${sec} сек.`,
        });
        continue;
      }
      try {
        wbPriceMap = await fetchWbCurrentPrices(store.api_key, nmIds);
      } catch (e: any) {
        for (const { rule, prod } of allProds) newEntries.push({
          id: uid(), scannedAt: nowIso, marketplace: 'wb', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice: rule.mrcPrice ?? 0, sellerPrice: 0, buyerPrice: 0,
          discountAmount: 0, discountPercent: 0, discountFactor: 1, action: 'error',
          errorMsg: e?.message?.slice(0, 120) ?? 'Ошибка API',
        });
        continue;
      }

      const wbUpdates: Array<{ nmID: number; price: number; discount?: number }> = [];
      for (const { rule, prod } of allProds) {
        const nmID = Number(prod.productId);
        const data   = wbPriceMap.get(nmID);
        const cached = this.wbProducts.find(p => String(p.nm_id) === prod.productId && p.store_id === storeId);
        const sellerPrice = data?.price ?? cached?.price ?? 0;
        const discount    = data?.discount ?? cached?.discount ?? 0;
        if (!sellerPrice) continue;

        // priceWithDisc = price × (1 − discount%) — витринная цена БЕЗ СПП.
        // СПП (скидку постоянного покупателя, финансирует сам WB) seller API не отдаёт
        // и публичная card.wb.ru сейчас закрыта анти-бот защитой — поэтому реальную
        // цену покупателя узнать программно нельзя. Чтобы покупатель в итоге видел
        // ровно mrcPrice, ориентируемся на mrcBuffer — % СПП, который продавец видит
        // вручную на витрине: targetShowcase = mrcPrice / (1 - mrcBuffer/100).
        const showcasePrice = data?.priceWithDisc ?? Math.ceil(sellerPrice * (1 - discount / 100));
        const mrcPrice      = rule.mrcPrice ?? 0;
        const targetShowcase = mrcEffectiveTarget(rule);

        const state = this.getMrcState('wb', storeId, prod.productId);
        updateDiscountFactor(state, showcasePrice, sellerPrice);

        const discountAmount  = Math.max(0, sellerPrice - showcasePrice);
        const discountPercent = sellerPrice > 0 ? Math.round(discountAmount / sellerPrice * 1000) / 10 : 0;

        if (!mrcShowcaseDeviated(showcasePrice, targetShowcase)) {
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'wb', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'ok', recommendedPrice: sellerPrice,
            lastUpdateAt: state.lastUpdateAt });
          continue;
        }

        if (isMrcProductCooling(state)) {
          const recPrice = (() => {
            let p = computeNewSellerPrice(targetShowcase, sellerPrice, showcasePrice);
            return rule.maxPrice ? Math.min(p, rule.maxPrice) : p;
          })();
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'wb', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'cooldown', recommendedPrice: recPrice,
            lastUpdateAt: state.lastUpdateAt,
            errorMsg: `Кулдаун: последнее изменение ${state.lastUpdateAt?.slice(11, 16)}` });
          continue;
        }

        let newSeller = computeNewSellerPrice(targetShowcase, sellerPrice, showcasePrice);
        if (rule.maxPrice) newSeller = Math.min(newSeller, rule.maxPrice);

        wbUpdates.push({ nmID, price: newSeller, discount });
        cooldownTouches.push({ state, prev: state.lastUpdateAt });
        state.lastUpdateAt = nowIso;
        newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'wb', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice, sellerPrice, buyerPrice: showcasePrice, discountAmount, discountPercent,
          discountFactor: state.discountFactor, action: 'adjusted', newPrice: newSeller,
          recommendedPrice: newSeller, lastUpdateAt: state.lastUpdateAt });
      }
      if (wbUpdates.length > 0) {
        pendingApplies.push(async () => {
          try {
            await updateWbPrices(store.api_key, wbUpdates);
            for (const upd of wbUpdates) {
              const p = this.wbProducts.find(p => p.nm_id === upd.nmID && p.store_id === storeId);
              if (p) p.price = upd.price;
            }
          } catch (e: any) {
            for (const entry of newEntries) {
              if (entry.action === 'adjusted' && entry.marketplace === 'wb' && entry.storeName === store.name && entry.scannedAt === nowIso) {
                entry.action = 'error'; entry.errorMsg = e?.message?.slice(0, 120) ?? 'Ошибка API'; delete entry.newPrice;
              }
            }
          }
        });
      }
    }

    // ── Яндекс Маркет ─────────────────────────────────────────────────────────
    const byYmStore = new Map<string, RepricerRule[]>();
    for (const r of mrcRules) {
      if (r.marketplace !== 'yandex') continue;
      const list = byYmStore.get(r.storeId) ?? [];
      list.push(r); byYmStore.set(r.storeId, list);
    }

    for (const [storeId, rules] of byYmStore) {
      const store = this.ymStores.find(s => s.id === storeId);
      if (!store?.campaign_id) continue;

      const allProds: Array<{ rule: RepricerRule; prod: RuleProduct }> = [];
      for (const rule of rules) for (const prod of ruleProducts(rule)) allProds.push({ rule, prod });

      let ymPriceMap = new Map<string, { price: number; discountBase?: number }>();
      try {
        ymPriceMap = await yandexApi.getOfferPrices(store.api_key, String(store.campaign_id));
      } catch {
        // Fallback на локальный кэш — YM цена из сохранённых товаров
      }

      // Реальная цена покупателя с Бустом/кешбэком Плюса — только для информации в логе,
      // на решение об изменении цены не влияет (МРЦ должна выполняться для цены ПРОДАВЦА
      // со своей скидкой, без учёта скидок, финансируемых самим Маркетом).
      const showcaseMap = await fetchYandexBuyerPrices(allProds.map(({ prod }) => prod.productId));

      const ymUpdates: Array<{ offerId: string; price: number; oldPrice?: number }> = [];
      for (const { rule, prod } of allProds) {
        const data   = ymPriceMap.get(prod.productId);
        const cached = this.ymProducts.find(p => p.offer_id === prod.productId && p.store_id === storeId);

        const currentSetPrice = data?.price ?? cached?.basic_price ?? 0;
        if (!currentSetPrice) continue;

        const mrcPrice = rule.mrcPrice ?? 0;
        const targetShowcase = mrcEffectiveTarget(rule);
        const state    = this.getMrcState('yandex', storeId, prod.productId);

        // Рекомендуемая цена в ЛК продавца, чтобы выйти точно на МРЦ (ограничена maxPrice).
        const recommendedPrice = rule.maxPrice ? Math.min(targetShowcase, rule.maxPrice) : targetShowcase;

        // Реальная цена покупателя (с Бустом/кешбэком Плюса), собранная расширением — для информации в логе,
        // на решение об изменении цены не влияет (МРЦ должна выполняться для цены ПРОДАВЦА
        // со своей скидкой, без учёта скидок, финансируемых самим Маркетом).
        const extInfo = showcaseMap.get(prod.productId);
        const buyerPrice = extInfo?.price ?? currentSetPrice;
        const discountAmount  = Math.max(0, currentSetPrice - buyerPrice);
        const discountPercent = currentSetPrice > 0 ? Math.round(discountAmount / currentSetPrice * 1000) / 10 : 0;
        updateDiscountFactor(state, currentSetPrice, currentSetPrice); // factor ≈ 1 — своя цена сравнивается сама с собой

        const extFields = {
          extBuyerPrice: extInfo?.price ?? null,
          extCheckedAt: extInfo?.checkedAt ?? null,
          extMarketSku: extInfo?.marketSku ?? null,
        };

        if (!mrcShowcaseDeviated(currentSetPrice, targetShowcase)) {
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'yandex', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice: currentSetPrice, buyerPrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'ok', recommendedPrice: currentSetPrice,
            lastUpdateAt: state.lastUpdateAt, ...extFields });
          continue;
        }

        if (isMrcProductCooling(state)) {
          newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'yandex', storeName: rule.storeName,
            productTitle: prod.productTitle, vendorCode: prod.vendorCode,
            mrcPrice, sellerPrice: currentSetPrice, buyerPrice, discountAmount, discountPercent,
            discountFactor: state.discountFactor, action: 'cooldown', recommendedPrice,
            lastUpdateAt: state.lastUpdateAt, ...extFields,
            errorMsg: `Кулдаун: последнее изменение ${state.lastUpdateAt?.slice(11, 16)}` });
          continue;
        }

        // Цена продавца сама и есть «витрина» в этом сравнении — выставляем targetShowcase
        // напрямую (ограничено maxPrice), плавный ±20% шаг здесь не нужен.
        const newSeller = recommendedPrice;

        ymUpdates.push({ offerId: prod.productId, price: newSeller, oldPrice: undefined });
        cooldownTouches.push({ state, prev: state.lastUpdateAt });
        state.lastUpdateAt = nowIso;
        newEntries.push({ id: uid(), scannedAt: nowIso, marketplace: 'yandex', storeName: rule.storeName,
          productTitle: prod.productTitle, vendorCode: prod.vendorCode,
          mrcPrice, sellerPrice: currentSetPrice, buyerPrice, discountAmount, discountPercent,
          discountFactor: state.discountFactor,
          action: 'adjusted', newPrice: newSeller, recommendedPrice: newSeller,
          lastUpdateAt: state.lastUpdateAt, ...extFields });
      }
      if (ymUpdates.length > 0) {
        pendingApplies.push(async () => {
          try {
            await yandexApi.updateOfferPrices(store.api_key, String(store.campaign_id), ymUpdates);
            for (const upd of ymUpdates) {
              const p = this.ymProducts.find(p => p.offer_id === upd.offerId && p.store_id === storeId);
              if (p && p.basic_price != null) p.basic_price = upd.price;
            }
          } catch (e: any) {
            for (const entry of newEntries) {
              if (entry.action === 'adjusted' && entry.marketplace === 'yandex' && entry.storeName === store.name && entry.scannedAt === nowIso) {
                entry.action = 'error'; entry.errorMsg = e?.message?.slice(0, 120) ?? 'Ошибка API'; delete entry.newPrice;
              }
            }
          }
        });
      }

      // Каждый скан держим все МРЦ-товары вне акций ЯМ — Маркет может сам подключать
      // товары к новым акциям между сканами, поэтому одноразового удаления недостаточно.
      const allOfferIds = allProds.map(({ prod }) => prod.productId);
      if (allOfferIds.length > 0) {
        yandexApi.getBusinessId(store.api_key, store.campaign_id).then(businessId => {
          if (businessId) {
            yandexApi.removeOffersFromAllPromos(store.api_key, businessId, allOfferIds)
              .then(() => debug.log('[YM MRC scan] Товары вне промо:', allOfferIds))
              .catch(e => console.warn('[YM MRC scan] removeFromPromos error:', e?.message));
          }
        }).catch((e) => debug.warn('[RepricerModule] swallowed error', e));
      }
    }

    // Применяем найденные изменения цен — при ручной проверке сначала спрашиваем подтверждение
    const toAdjust = newEntries.filter(e => e.action === 'adjusted');
    let applyPrices = true;
    if (interactive && toAdjust.length > 0) {
      const lines = toAdjust.map(e =>
        `${MP_LABEL[e.marketplace]} · ${e.vendorCode}: ${e.sellerPrice.toLocaleString('ru')} ₽ → ${(e.newPrice ?? 0).toLocaleString('ru')} ₽ (МРЦ ${e.mrcPrice.toLocaleString('ru')} ₽)`
      );
      const shown = lines.slice(0, 15).join('\n');
      const more = lines.length > 15 ? `\n…и ещё ${lines.length - 15}` : '';
      applyPrices = confirm(
        `Текущая цена покупателя у ${toAdjust.length} товар(ов) отличается от указанной МРЦ:\n\n${shown}${more}\n\nИзменить цену продавца, чтобы цена покупателя стала равна МРЦ?`
      );
    }
    if (applyPrices) {
      for (const apply of pendingApplies) await apply();
    } else {
      for (const e of toAdjust) { e.action = 'skipped'; delete e.newPrice; }
      // Откатываем отметку кулдауна — следующая проверка снова предложит изменить цену
      for (const t of cooldownTouches) t.state.lastUpdateAt = t.prev;
    }

    // Сохраняем лог и состояния товаров
    this.mrcScanLog = [...newEntries, ...this.mrcScanLog];
    this.mrcLastScanAt = nowIso;
    this.saveMrcScanLog();
    this.saveMrcProductStates();

    // Сбрасываем авто-таймер чтобы следующий цикл считался от этого момента
    if (this.mrcScanEnabled) this.startAutoScan();

    this.mrcScanning = false;
    this.render();
  }

  /** Круглая иконка-бейдж расширения (пазл) на цветном фоне. */
  private extIcon(color: string, bg: string): string {
    return `
      <span style="flex-shrink:0;width:30px;height:30px;border-radius:9px;background:${bg};
        display:flex;align-items:center;justify-content:center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.944.945.944 2.464 0 3.408l-1.611 1.611a.987.987 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-3.41 0l-1.567-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568a2.402 2.402 0 0 1 0-3.408L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.611-1.61a2.404 2.404 0 0 1 3.408 0l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>
        </svg>
      </span>
    `;
  }

  private renderExtensionWarning(): string {
    const yandexMrcRules = this.rules.filter(r => r.status === 'active' && r.type === 'mrc' && r.marketplace === 'yandex');
    if (yandexMrcRules.length === 0) return '';

    // ── Проверка ещё не завершена ───────────────────────────────────────────
    if (this.extensionConnected === null) {
      return `
        <div style="margin:0 0 14px;padding:10px 16px;border-radius:12px;
          border:1px solid var(--border);background:var(--bg2);
          display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text2)">
          ${this.extIcon('var(--text3)', 'var(--bg3)')}
          Проверяю статус расширения SimaDesk…
        </div>
      `;
    }

    // ── Расширение не найдено ────────────────────────────────────────────────
    if (this.extensionConnected === false) {
      return `
        <div style="margin:0 0 14px;padding:12px 16px;border-radius:12px;
          border:1px solid rgba(220,38,38,.3);background:color-mix(in srgb,#dc2626 8%,transparent);
          display:flex;align-items:center;gap:12px">
          ${this.extIcon('#dc2626', 'rgba(220,38,38,.12)')}
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:2px">Расширение SimaDesk не найдено</div>
            <div style="font-size:11.5px;color:var(--text2);line-height:1.5">
              Данные витрины Яндекс Маркета (с Бустом/Плюсом) для лога МРЦ не собираются.
              На решение об изменении цены это не влияет — оно работает без расширения.
            </div>
          </div>
          <button onclick="window.app.navigateTo('settings')"
            style="padding:6px 14px;border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;
              white-space:nowrap;background:#dc2626;color:#fff;flex-shrink:0">
            Настройки
          </button>
        </div>
      `;
    }

    // ── Расширение найдено — показываем когда последний раз собирало данные ───
    let freshestAt: string | null = null;
    for (const e of this.mrcScanLog) {
      if (e.marketplace !== 'yandex' || !e.extCheckedAt) continue;
      if (!freshestAt || new Date(e.extCheckedAt).getTime() > new Date(freshestAt).getTime()) freshestAt = e.extCheckedAt;
    }
    const freshAgoMs = freshestAt ? Date.now() - new Date(freshestAt).getTime() : null;
    const isStale = freshAgoMs === null || freshAgoMs > YANDEX_SHOWCASE_STALE_MS;
    const accent = isStale ? '#f59e0b' : '#16a34a';

    return `
      <div style="margin:0 0 14px;padding:10px 16px;border-radius:12px;
        border:1px solid color-mix(in srgb,${accent} 30%,transparent);
        background:color-mix(in srgb,${accent} 6%,transparent);
        display:flex;align-items:center;gap:12px;font-size:12px;flex-wrap:wrap">
        ${this.extIcon(accent, `color-mix(in srgb,${accent} 14%,transparent)`)}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:${isStale ? '#92400e' : '#15803d'}">Расширение SimaDesk установлено и работает</div>
          <div style="color:var(--text2);font-size:11.5px;margin-top:1px">
            ${freshestAt
              ? `Данные витрины Яндекс Маркета собраны ${this.formatDateTime(freshestAt)}${isStale ? ' <b style="color:#92400e">— устарели, ждём обновления</b>' : ''}`
              : 'Данные витрины Яндекс Маркета пока не собраны — расширение собирает их в фоне примерно раз в 20 минут'}
          </div>
        </div>
      </div>
    `;
  }

  /** Форматирует ISO-дату в "12 июн, 14:30". */
  private formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private renderMrcScanPanel(): string {
    const mrcRules = this.rules.filter(r => r.status === 'active' && r.type === 'mrc');
    if (mrcRules.length === 0) return '';

    const lastScan = this.mrcLastScanAt
      ? new Date(this.mrcLastScanAt).toLocaleString('ru', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
      : null;

    // Записи последнего сканирования
    const recent = this.mrcLastScanAt
      ? this.mrcScanLog.filter(e => e.scannedAt === this.mrcLastScanAt)
      : [];
    const adjusted = recent.filter(e => e.action === 'adjusted');
    const errorCount = recent.filter(e => e.action === 'error').length;

    // Начальное значение таймера
    const initCountdown = (() => {
      if (!this.mrcScanEnabled || !this.mrcLastScanAt) return '—';
      const ms = new Date(this.mrcLastScanAt).getTime() + this.mrcScanIntervalHours * 3600000 - Date.now();
      if (ms <= 0) return 'сейчас…';
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
      return h > 0 ? `${h}ч ${String(m).padStart(2,'0')}м ${String(s).padStart(2,'0')}с` : `${m}:${String(s).padStart(2,'0')}`;
    })();

    const collapsed = this.mrcPanelCollapsed;

    return `
      <div style="margin:0 0 14px;border:1.5px solid ${this.mrcScanEnabled ? '#f59e0b' : 'var(--border)'};
        border-radius:12px;overflow:hidden;background:var(--bg)">

        <!-- Шапка -->
        <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;
          background:${this.mrcScanEnabled ? 'color-mix(in srgb,#f59e0b 8%,transparent)' : 'var(--bg2)'};
          ${collapsed ? '' : 'border-bottom:1px solid var(--border);'}flex-wrap:wrap;gap:8px;cursor:pointer"
          onclick="window.repricerModule.toggleMrcPanel()">

          <button title="${collapsed ? 'Развернуть' : 'Свернуть'}"
            style="flex-shrink:0;width:22px;height:22px;border:1px solid var(--border);background:var(--bg);
              border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text2)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
              style="transform:rotate(${collapsed ? '-90' : '0'}deg);transition:transform .15s"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px">
              ${this.mrcScanning
                ? '<span style="color:#f59e0b">⏳ Проверяю цены…</span>'
                : `<span>МРЦ-контроль</span><span style="font-size:11px;font-weight:500;color:var(--text2)">${mrcRules.length} ${mrcRules.length===1?'правило':'правил'}</span>`}
            </div>
            <div style="font-size:11px;color:var(--text2);margin-top:3px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              ${lastScan ? `<span>Последняя: <b>${lastScan}</b>${adjusted.length>0?` · <span style="color:#f59e0b;font-weight:600">↑ ${adjusted.length} скорр.</span>`:' · норма'}${errorCount>0?` · <span style="color:#dc2626">${errorCount} ошибок</span>`:''}</span>` : '<span>Ещё не запускалось</span>'}
              ${this.mrcScanEnabled ? `
                <span style="display:flex;align-items:center;gap:5px;padding:2px 8px;border-radius:20px;
                  background:color-mix(in srgb,#f59e0b 12%,transparent);border:1px solid color-mix(in srgb,#f59e0b 30%,transparent)">
                  <span style="font-size:10px;color:var(--text2)">след. через</span>
                  <b id="rpr-mrc-countdown" style="font-size:11px;color:#f59e0b;font-variant-numeric:tabular-nums">${initCountdown}</b>
                </span>` : ''}
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap" onclick="event.stopPropagation()">
            <select onchange="window.repricerModule.setMrcScanInterval(+this.value)"
              style="padding:5px 8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px">
              ${[0.5,1,2,4,6,12,24].map(h => `<option value="${h}" ${this.mrcScanIntervalHours===h?'selected':''}>каждые ${h<1?'30 мин':h===1?'1 час':h+' ч'}</option>`).join('')}
            </select>
            <button onclick="window.repricerModule.runMrcScan(true)" ${this.mrcScanning?'disabled':''}
              style="padding:6px 13px;border:1px solid var(--border);background:var(--bg);color:var(--text);
                border-radius:7px;cursor:pointer;font-size:12px;white-space:nowrap;opacity:${this.mrcScanning?.5:1}"
              title="Запустить сейчас и сбросить таймер">
              ${this.mrcScanning ? '⏳' : '▶'} Проверить
            </button>
            <button onclick="window.repricerModule.toggleMrcAutoScan()"
              style="padding:6px 14px;border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;
                background:${this.mrcScanEnabled?'#f59e0b':'var(--bg3)'};color:${this.mrcScanEnabled?'#000':'var(--text2)'}">
              ${this.mrcScanEnabled ? '● Авто' : '○ Авто'}
            </button>
          </div>
        </div>

        ${collapsed ? '' : `${adjusted.length > 0 ? `
          <!-- Блок изменений -->
          <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:color-mix(in srgb,#f59e0b 5%,transparent)">
            <div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:8px;text-transform:uppercase;letter-spacing:.4px">
              Скорректировано цен: ${adjusted.length}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${adjusted.map(e => {
                const mpColor = MP_COLOR[e.marketplace];
                const mpBg = MP_BG[e.marketplace];
                return `
                  <div style="border-radius:8px;border:1px solid color-mix(in srgb,#f59e0b 30%,transparent);
                    background:var(--bg);padding:8px 12px;font-size:12px;line-height:1.6">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
                      <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${mpBg};color:${mpColor}">${MP_LABEL[e.marketplace]}</span>
                      <span style="font-weight:600;color:var(--text)">${this.esc(e.productTitle)}</span>
                      <span style="font-size:10px;color:var(--text2);font-family:monospace">${this.esc(e.vendorCode)}</span>
                    </div>
                    <div style="color:var(--text2);font-size:11.5px">
                      Обнаружена цена витрины: <b style="color:${e.discountPercent>0?'#dc2626':'var(--text)'}">${e.buyerPrice.toLocaleString('ru')} ₽</b>
                      ${e.discountPercent > 0 ? `(скидка <b>${e.discountPercent}%</b> от цены продавца)` : ''}
                      &nbsp;·&nbsp; МРЦ: <b>${e.mrcPrice.toLocaleString('ru')} ₽</b>
                      <br>
                      Текущая цена продавца:
                      <span style="text-decoration:line-through;color:var(--text3)">${e.sellerPrice.toLocaleString('ru')} ₽</span>
                      &nbsp;→&nbsp;
                      <b style="color:#16a34a">установлена ${(e.newPrice??0).toLocaleString('ru')} ₽</b>
                      &nbsp;·&nbsp;
                      <span>В ЛК ${MP_LABEL[e.marketplace]} укажите цену продавца: <b>${(e.recommendedPrice ?? e.newPrice ?? 0).toLocaleString('ru')} ₽</b>, чтобы покупатель видел ${e.mrcPrice.toLocaleString('ru')} ₽</span>
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>
        ` : ''}

        ${recent.length > 0 ? `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:11.5px">
              <thead>
                <tr style="background:var(--bg2)">
                  <th style="padding:5px 12px;text-align:left;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)">МП · Товар</th>
                  <th style="padding:5px 12px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)">МРЦ (цель)</th>
                  <th style="padding:5px 12px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)">Цена в кабинете</th>
                  <th style="padding:5px 12px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)" title="Цена, которую видит покупатель, и скидка от цены продавца">Витрина / скидка</th>
                  <th style="padding:5px 12px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)" title="Какую цену указать в ЛК продавца, чтобы покупатель видел МРЦ">Указать в ЛК</th>
                  <th style="padding:5px 12px;text-align:left;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border)">Результат</th>
                </tr>
              </thead>
              <tbody>
                ${recent.map(e => {
                  const mpColor = MP_COLOR[e.marketplace];
                  const mpBg = MP_BG[e.marketplace];

                  const recommended = e.recommendedPrice ?? e.newPrice ?? e.sellerPrice;
                  const lastUpdTxt = e.lastUpdateAt ? this.formatDateTime(e.lastUpdateAt) : 'не менялась';

                  // Для Яндекса доп. строка с данными расширения (реальная цена покупателя с Бустом/Плюсом)
                  let extLine = '';
                  if (e.marketplace === 'yandex') {
                    if (e.extBuyerPrice != null && e.extCheckedAt) {
                      const ageMs = Date.now() - new Date(e.extCheckedAt).getTime();
                      const fresh = ageMs <= YANDEX_SHOWCASE_STALE_MS;
                      const link = e.extMarketSku
                        ? `<a href="https://market.yandex.ru/product/${e.extMarketSku}" target="_blank" rel="noopener" style="color:#f59e0b;text-decoration:underline">открыть на Маркете</a>`
                        : '';
                      extLine = `<div style="font-size:10px;color:var(--text2);margin-top:2px">
                        Расширение: цена покупателя (с Бустом/Плюсом) <b style="color:${fresh?'var(--text)':'var(--text3)'}">${e.extBuyerPrice.toLocaleString('ru')} ₽</b>
                        · собрано ${this.formatDateTime(e.extCheckedAt)}${fresh ? '' : ' <span style="color:#f59e0b">(устарело)</span>'}
                        ${link ? ` · ${link}` : ''}
                      </div>`;
                    } else {
                      extLine = `<div style="font-size:10px;color:var(--text3);margin-top:2px">Расширение: данных пока нет</div>`;
                    }
                  }

                  return `
                    <tr style="border-bottom:1px solid var(--border)">
                      <td style="padding:6px 12px;max-width:260px">
                        <div style="display:flex;align-items:center;gap:6px">
                          <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${mpBg};color:${mpColor};white-space:nowrap">${MP_LABEL[e.marketplace]}</span>
                          <span style="font-weight:600;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(e.productTitle)}</span>
                        </div>
                        <div style="font-size:10px;color:var(--text2);font-family:monospace;margin-top:1px;padding-left:2px">${this.esc(e.vendorCode)}</div>
                        ${extLine}
                      </td>
                      <td style="padding:6px 12px;text-align:right;font-weight:700;color:var(--text)">${e.mrcPrice.toLocaleString('ru')} ₽</td>
                      <td style="padding:6px 12px;text-align:right">
                        <div style="font-weight:700;color:var(--text)">${e.sellerPrice > 0 ? e.sellerPrice.toLocaleString('ru') + ' ₽' : '—'}</div>
                        <div style="font-size:10px;color:var(--text2);margin-top:1px">обновлена: ${lastUpdTxt}</div>
                      </td>
                      <td style="padding:6px 12px;text-align:right">
                        ${e.action==='error' ? '<span style="color:#dc2626;font-size:10px">нет данных (ошибка API)</span>'
                          : e.buyerPrice > 0
                            ? `<div style="font-weight:700;color:var(--text)">${e.buyerPrice.toLocaleString('ru')} ₽</div>
                               <div style="font-size:10px;color:${e.discountPercent>0?'#dc2626':'var(--text2)'};margin-top:1px">${e.discountPercent>0?`скидка ${e.discountPercent}%`:'без скидки'}</div>`
                            : '—'}
                      </td>
                      <td style="padding:6px 12px;text-align:right;font-weight:700;color:var(--text)">
                        ${e.action==='error' ? '—' : `${recommended.toLocaleString('ru')} ₽`}
                      </td>
                      <td style="padding:6px 12px;text-align:left">
                        ${e.action==='adjusted' && e.newPrice
                          ? `<span style="color:#16a34a;font-weight:700">↑ изменено</span>
                             <div style="font-size:10px;color:var(--text2);margin-top:1px">${e.sellerPrice.toLocaleString('ru')} → ${e.newPrice.toLocaleString('ru')} ₽</div>`
                          : e.action==='skipped'
                            ? `<span style="color:#f59e0b;font-weight:700">⏸ не изменено</span>
                               <div style="font-size:10px;color:var(--text2);margin-top:1px">отклонено при проверке</div>`
                          : e.action==='error'
                            ? `<span style="color:#dc2626;font-weight:700">✗ ошибка</span>
                               <div style="font-size:10px;color:#dc2626;margin-top:1px">${this.esc(e.errorMsg??'')}</div>`
                            : e.action==='cooldown'
                              ? `<span style="color:var(--text2);font-weight:700">⏳ кулдаун</span>
                                 <div style="font-size:10px;color:var(--text2);margin-top:1px">${this.esc(e.errorMsg??'')}</div>`
                              : `<span style="color:#16a34a;font-weight:700">✓ соответствует МРЦ</span>`}
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : !this.mrcScanning ? `
          <div style="padding:14px 16px;font-size:12px;color:var(--text2)">
            Нажмите <b>▶ Проверить</b> — система запросит цены у каждого маркетплейса,
            сравнит вашу текущую цену со скидкой с МРЦ и подскажет, какую цену указать в ЛК,
            а при отклонении сама скорректирует цену продавца.
          </div>
        ` : ''}`}
      </div>
    `;
  }

  render(): void {
    const activeCount = this.rules.filter(r => r.status === 'active').length;
    const costsCount  = costPriceDb.all().length;
    const products    = this.buildUnifiedProducts();
    const withoutCost = products.filter(p => costPriceDb.get(p.vendorCode) == null).length;

    // ── ЭКРАН СОЗДАНИЯ / РЕДАКТИРОВАНИЯ ПРАВИЛА ──
    if (this.showForm) {
      this.container.innerHTML = `
        <div class="rpr">
          <div class="rpr-header">
            <div class="rpr-header-left">
              <button onclick="window.repricerModule.closeForm()"
                style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px 5px 7px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                Назад
              </button>
              <span class="rpr-logo-text" style="margin-left:4px">${this.editId ? 'Редактировать правило' : 'Новое правило'}</span>
            </div>
            <div class="rpr-header-actions">
              ${helpBtn('repricer')}
            </div>
          </div>
          <div class="rpr-body">
            ${this.renderForm()}
          </div>
        </div>
      `;
      this.stopCountdown();
      return;
    }

    // ── ОСНОВНОЙ ЭКРАН (СПИСОК ПРАВИЛ / ИСТОРИЯ / ...) ──
    const TAB_CFG = [
      { id: 'rules',     label: 'Правила',      count: this.rules.length, violet: false },
      { id: 'analytics', label: 'Аналитика',    count: null, violet: true },
      { id: 'costs',     label: 'Себестоимости',count: costsCount, violet: false, warn: withoutCost > 0 },
      { id: 'log',       label: 'История',      count: this.log.length, violet: false },
    ] as const;

    this.container.innerHTML = `
      <div class="rpr">

        <!-- HEADER -->
        <div class="rpr-header">
          <div class="rpr-header-left">
            <div class="rpr-logo-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
            </div>
            <span class="rpr-logo-text">Репрайсер</span>
            ${activeCount > 0 ? `<span class="rpr-badge">${activeCount} активных</span>` : ''}
            ${withoutCost > 0 ? `<span style="padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;background:rgba(251,191,36,.12);color:#f59e0b;letter-spacing:.2px">⚠ ${withoutCost} без cost</span>` : ''}
          </div>
          <div class="rpr-header-actions">
            ${helpBtn('repricer')}
            ${activeCount > 0 ? `
              <button class="rpr-btn rpr-btn-outline" onclick="window.repricerModule.applyAll()" ${this.applying.size > 0 ? 'disabled' : ''}>
                ${this.applying.size > 0
                  ? `<span style="display:inline-flex;align-items:center;gap:5px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>Применяем…</span>`
                  : `▶ Применить все`}
              </button>
            ` : ''}
            ${this.tab === 'rules' ? `
              <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.openAddForm()">
                + Правило
              </button>` : ''}
          </div>
        </div>

        <!-- TABS -->
        <div class="rpr-tabs">
          ${TAB_CFG.map(t => {
            const isActive = this.tab === t.id;
            return `<button class="rpr-tab${isActive ? ' active' : ''}${t.violet ? ' violet' : ''}"
              onclick="window.repricerModule.setTab('${t.id}')">
              ${t.label}
              ${t.count != null ? `<span class="rpr-tab-badge">${t.count}</span>` : ''}
              ${'warn' in t && t.warn && !isActive ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-left:3px;vertical-align:middle"></span>` : ''}
            </button>`;
          }).join('')}
        </div>

        <div class="rpr-body">
          ${this.tab === 'rules' ? this.renderExtensionWarning() + this.renderMrcScanPanel() + this.renderRules()
          : this.tab === 'costs' ? this.renderCosts()
          : this.tab === 'analytics' ? this.renderAnalyticsTab()
          : this.renderLog()}
        </div>
      </div>
    `;
    if (this.tab === 'rules' && this.mrcScanEnabled) {
      this.stopCountdown();
      this.startCountdown();
    } else {
      this.stopCountdown();
    }
  }

  private renderForm(): string {
    const f = this.form;
    const productSelected = this.formProducts.length > 0 || (!!f.productId && !!f.vendorCode);
    const prodCount = this.formProducts.length;

    // Магазины для отображения в карточке товара
    const allStores: Array<{ id: string; name: string; mp: Mp }> = [
      ...this.wbStores.map(s    => ({ id: s.id, name: s.name, mp: 'wb'     as Mp })),
      ...this.ozonStores.map(s  => ({ id: s.id, name: s.name, mp: 'ozon'   as Mp })),
      ...this.ymStores.map(s    => ({ id: s.id, name: s.name, mp: 'yandex' as Mp })),
    ];

    return `
      <div style="padding:16px 24px">

        <!-- ШАГ 1: ТИП ПРАВИЛА -->
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:10px">
            Шаг 1 — Тип правила
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
            ${(Object.keys(RULE_LABELS) as RuleType[]).map(rt => {
              const isActive = (f.type ?? 'target') === rt;
              return `
                <button onclick="window.repricerModule.updateForm('type','${rt}')"
                  style="padding:10px;border:1.5px solid ${isActive?'#059669':'var(--border)'};
                    background:${isActive?'#05966915':'var(--bg)'};border-radius:10px;cursor:pointer;text-align:left;transition:all .15s">
                  <div style="font-size:12px;font-weight:700;color:${isActive?'#059669':'var(--text)'};margin-bottom:2px">${RULE_LABELS[rt]}</div>
                  <div style="font-size:10px;color:var(--text2);line-height:1.3">${RULE_DESCRIPTIONS[rt]}</div>
                </button>`;
            }).join('')}
          </div>
        </div>

        <!-- ШАГ 2: ТОВАР И МАГАЗИНЫ -->
        <div style="background:var(--bg2);border:1.5px solid ${productSelected?'#059669':'var(--border)'};border-radius:12px;padding:14px;margin-bottom:12px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${productSelected?'#059669':'var(--text2)'};margin-bottom:8px">
            Шаг 2 — Товар и магазины
          </div>
          ${productSelected ? `
            <div style="display:flex;align-items:flex-start;gap:12px">
              <div style="flex:1;min-width:0">
                <!-- Список выбранных товаров -->
                <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:6px;max-height:180px;overflow-y:auto">
                  ${this.formProducts.map(p => `
                    <div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:5px 10px">
                      <span style="flex:1;font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.esc(p.productTitle)}</span>
                      <span style="font-family:monospace;font-size:10px;color:var(--text2);flex-shrink:0">${this.esc(p.vendorCode)}</span>
                      ${prodCount > 1 ? `<button onclick="window.repricerModule.removeFormProduct('${this.esc(p.vendorCode)}')"
                        style="width:20px;height:20px;border:none;background:#fee2e2;color:#dc2626;border-radius:5px;cursor:pointer;font-size:11px;flex-shrink:0;line-height:1" title="Убрать">✕</button>` : ''}
                    </div>
                  `).join('')}
                </div>
                ${prodCount > 1 ? `<div style="font-size:11px;color:#059669;font-weight:600">📦 ${prodCount} товаров в одном правиле</div>` : ''}
                <!-- Магазины -->
                <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
                  ${this.formStoreIds.size > 0
                    ? [...this.formStoreIds].map(sid => {
                        const st = allStores.find(s => s.id === sid);
                        return st ? `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[st.mp]};color:${MP_COLOR[st.mp]}">${MP_LABEL[st.mp]} · ${this.esc(st.name)}</span>` : '';
                      }).join('')
                    : `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:${MP_BG[(f.marketplace??'wb') as Mp]};color:${MP_COLOR[(f.marketplace??'wb') as Mp]}">${MP_LABEL[(f.marketplace??'wb') as Mp]} · ${this.esc(f.storeName||'')}</span>`
                  }
                </div>
              </div>
              <button onclick="window.repricerModule.openProductPicker()"
                style="padding:7px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;cursor:pointer;font-size:11px;flex-shrink:0">
                ↻ ${prodCount > 1 ? 'Изменить' : 'Сменить'}
              </button>
            </div>
          ` : `
            <button onclick="window.repricerModule.openProductPicker()"
              style="width:100%;padding:14px;border:2px dashed var(--accent);background:var(--bg);color:var(--accent);
                border-radius:10px;cursor:pointer;font-size:13px;font-weight:500;
                display:flex;align-items:center;justify-content:center;gap:8px">
              <span style="font-size:18px">📦</span>
              <span>Выбрать товар и магазины</span>
            </button>
          `}
        </div>

        <!-- ШАГ 3: ПАРАМЕТРЫ -->
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;opacity:${productSelected?1:.45};${!productSelected?'pointer-events:none':''}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Шаг 3 — Параметры ${!productSelected ? '<span style="font-weight:400;text-transform:none;font-size:11px">· сначала выберите товар</span>' : ''}</div>
            <select onchange="window.repricerModule.updateForm('status',this.value)"
              style="padding:4px 8px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:11px">
              <option value="active" ${f.status==='active'?'selected':''}>● Активно</option>
              <option value="paused" ${f.status==='paused'?'selected':''}>○ Пауза</option>
            </select>
          </div>
          ${this.renderFormFields()}
        </div>

        ${this.formError ? `<div style="font-size:13px;color:#dc2626;padding:10px 14px;background:#dc262610;border:1px solid #dc262630;border-radius:8px;margin-bottom:10px">⚠ ${this.formError}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="window.repricerModule.closeForm()"
            style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;font-size:13px">
            Отмена
          </button>
          <button onclick="window.repricerModule.saveForm()" ${!productSelected?'disabled':''}
            style="padding:8px 20px;border-radius:8px;border:none;background:${productSelected?'#059669':'#94a3b8'};
              color:#fff;cursor:${productSelected?'pointer':'default'};font-size:13px;font-weight:700">
            ${this.editId
              ? '✓ Сохранить'
              : (f.type === 'mrc' && prodCount > 1
                ? `✓ Создать ${prodCount} правил МРЦ (по одному на артикул)`
                : (prodCount > 1 ? `✓ Создать правило (${prodCount} товаров)` : '✓ Создать правило'))}
          </button>
        </div>
      </div>

      <!-- PRODUCT PICKER OVERLAY -->
      ${this.pickerOpen ? `
        <div style="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px"
          onclick="if(event.target===this)window.repricerModule.closeProductPicker()">
          <div style="background:var(--bg);border-radius:14px;width:100%;max-width:820px;max-height:88vh;display:flex;flex-direction:column;
            box-shadow:0 24px 64px rgba(0,0,0,.4);overflow:hidden">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-size:16px;font-weight:700;color:var(--text)">Выбор товара</div>
                <div style="font-size:11px;color:var(--text2);margin-top:2px">
                  Товары из выбранных магазинов · одинаковый артикул = одна позиция
                </div>
              </div>
              <button onclick="window.repricerModule.closeProductPicker()" title="Закрыть"
                style="width:32px;height:32px;border:none;background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:14px">✕</button>
            </div>
            <div id="rp-picker-host" style="flex:1;display:flex;flex-direction:column;min-height:0">
              ${this.renderPicker()}
            </div>
          </div>
        </div>
      ` : ''}
    `;
  }

  private numInput(key: string, label: string, val: any, ph = ''): string {
    // onchange (не oninput) — срабатывает только при потере фокуса или Enter,
    // что не вызывает перерисовку формы при каждом нажатии клавиши
    return `<div>
      <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
      <input type="number" id="ri-${key}" value="${val ?? ''}" placeholder="${ph}"
        onchange="window.repricerModule.updateForm('${key}',+this.value)"
        style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;
          background:var(--bg);color:var(--text-1);font-size:13px;box-sizing:border-box">
    </div>`;
  }

  private renderFormFields(): string {
    const f = this.form;
    if (f.type === 'target') return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:14px">
        ${this.numInput('targetPrice','Целевая цена, ₽',f.targetPrice,'9 990')}
        ${this.numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
        ${this.numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
      </div>`;
    if (f.type === 'margin') {
      const cost = costPriceDb.get(f.vendorCode ?? '');
      const calc = cost != null && f.marginMultiplier ? Math.round(cost * f.marginMultiplier) : null;
      return `
      <div style="background:${cost != null ? 'color-mix(in srgb,#16a34a 6%,transparent)' : 'color-mix(in srgb,#f59e0b 8%,transparent)'};
        border:1px solid ${cost != null ? 'color-mix(in srgb,#16a34a 30%,transparent)' : 'color-mix(in srgb,#f59e0b 30%,transparent)'};
        border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;line-height:1.5;color:var(--text)">
        ${cost != null
          ? `✓ Себестоимость для <b>${this.esc(f.vendorCode ?? '')}</b> взята из БД: <b style="color:#16a34a">${cost.toLocaleString('ru')} ₽</b>`
          : `⚠ Себестоимость для <b>${this.esc(f.vendorCode ?? '—')}</b> не задана. <a href="#" onclick="event.preventDefault();window.repricerModule.setTab('costs')" style="color:#f59e0b;font-weight:600">Перейти в «Себестоимости» →</a>`}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:14px">
        ${this.numInput('marginMultiplier','Множитель (напр. 2.5)',f.marginMultiplier,'2.5')}
        ${this.numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
        ${this.numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
      </div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:12px">
        Расчётная цена: <b id="ri-calc-price">${calc != null ? `${calc.toLocaleString('ru')} ₽` : '—'}</b>
      </div>`;
    }
    if (f.type === 'stock') {
      // Если ещё нет tiers — мигрируем из legacy полей или создаём один пустой
      if (!f.stockTiers || f.stockTiers.length === 0) {
        if (f.stockThreshold && f.highStockPrice && f.lowStockPrice) {
          f.stockTiers = [
            { maxStock: f.stockThreshold, price: f.highStockPrice },
            { maxStock: 99999, price: f.lowStockPrice },
          ];
        } else {
          f.stockTiers = [{ maxStock: 10, price: 0 }];
        }
      }
      return `
      <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;background:color-mix(in srgb,#005bff 6%,transparent);
        border:1px solid color-mix(in srgb,#005bff 22%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5">
        💡 Правила проверяются <b>по порядку сверху вниз</b>. Берётся первый порог, под который попадает остаток.
        <br>Пример: «≤ 5 шт → 15 000 ₽», «≤ 20 шт → 12 000 ₽», «∞ → 9 990 ₽» — чем меньше остаток, тем выше цена.
      </div>
      <div id="ri-stock-tiers" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">
        ${f.stockTiers.map((t, i) => `
          <div style="display:grid;grid-template-columns:50px 1fr 1fr 36px;gap:8px;align-items:center;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <div style="text-align:center;font-size:11px;color:var(--text2);font-weight:700">${i + 1}</div>
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Если остаток ≤</div>
              <input type="number" value="${t.maxStock}" min="0" step="1"
                onchange="window.repricerModule.updateStockTier(${i},'maxStock',+this.value)"
                style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:13px">
            </div>
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Цена, ₽</div>
              <input type="number" value="${t.price}" min="0" step="1"
                onchange="window.repricerModule.updateStockTier(${i},'price',+this.value)"
                style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:13px">
            </div>
            <button onclick="window.repricerModule.removeStockTier(${i})" title="Удалить"
              style="width:32px;height:32px;border:1px solid #dc262644;background:#dc262615;color:#dc2626;border-radius:6px;cursor:pointer">✕</button>
          </div>
        `).join('')}
      </div>
      <button onclick="window.repricerModule.addStockTier()"
        style="padding:7px 14px;border:1px dashed var(--accent);background:transparent;color:var(--accent);border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:10px">
        + Добавить порог
      </button>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px">
        ${this.numInput('minPrice','Глобальный мин., ₽',f.minPrice,'')}
        ${this.numInput('maxPrice','Глобальный макс., ₽',f.maxPrice,'')}
      </div>`;
    }
    if (f.type === 'schedule') {
      if (!f.schedulePeriods || f.schedulePeriods.length === 0) {
        // Миграция из legacy weekday/weekend
        const ps: SchedulePeriod[] = [];
        if (f.weekdayPrice) ps.push({ days: [1,2,3,4,5], fromTime: '00:00', toTime: '23:59', price: f.weekdayPrice });
        if (f.weekendPrice) ps.push({ days: [0,6], fromTime: '00:00', toTime: '23:59', price: f.weekendPrice });
        f.schedulePeriods = ps.length ? ps : [{ days: [1,2,3,4,5], fromTime: '09:00', toTime: '18:00', price: 0 }];
      }
      const DAYS = ['вс','пн','вт','ср','чт','пт','сб'];
      return `
      <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;background:color-mix(in srgb,#7c3aed 8%,transparent);
        border:1px solid color-mix(in srgb,#7c3aed 22%,transparent);border-radius:8px;padding:10px 12px;line-height:1.5">
        💡 Каждый период — это «когда → какая цена». Можно настроить разные цены на разное время дня и дни недели.
        <br>Пример: «Будни 09:00–18:00 → 12 000 ₽», «Будни 18:00–23:59 → 9 990 ₽», «Выходные → 14 990 ₽».
      </div>
      <div id="ri-schedule-periods" style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px">
        ${f.schedulePeriods.map((p, i) => `
          <div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:11px;font-weight:700;color:var(--text)">Период #${i + 1}</div>
              <button onclick="window.repricerModule.removeSchedulePeriod(${i})" title="Удалить"
                style="width:26px;height:26px;border:1px solid #dc262644;background:#dc262615;color:#dc2626;border-radius:5px;cursor:pointer;font-size:11px">✕</button>
            </div>
            <div style="font-size:10px;color:var(--text2);margin-bottom:4px">Дни недели</div>
            <div style="display:flex;gap:3px;margin-bottom:10px">
              ${DAYS.map((d, di) => {
                const isOn = p.days.includes(di);
                return `<button onclick="window.repricerModule.toggleScheduleDay(${i},${di})"
                  style="flex:1;padding:6px 4px;border:1.5px solid ${isOn ? '#7c3aed' : 'var(--border)'};
                    background:${isOn ? '#7c3aed' : 'var(--bg2)'};color:${isOn ? '#fff' : 'var(--text2)'};
                    border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase">${d}</button>`;
              }).join('')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:8px;align-items:end">
              <div>
                <div style="font-size:10px;color:var(--text2);margin-bottom:3px">С</div>
                <input type="time" value="${p.fromTime}"
                  onchange="window.repricerModule.updateSchedulePeriod(${i},'fromTime',this.value)"
                  style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
              </div>
              <div>
                <div style="font-size:10px;color:var(--text2);margin-bottom:3px">До</div>
                <input type="time" value="${p.toTime}"
                  onchange="window.repricerModule.updateSchedulePeriod(${i},'toTime',this.value)"
                  style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
              </div>
              <div>
                <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Цена в этот период, ₽</div>
                <input type="number" value="${p.price}" min="0" step="1" placeholder="9 990"
                  onchange="window.repricerModule.updateSchedulePeriod(${i},'price',+this.value)"
                  style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:6px;font-size:13px">
              </div>
            </div>
          </div>
        `).join('')}
      </div>
      <button onclick="window.repricerModule.addSchedulePeriod()"
        style="padding:7px 14px;border:1px dashed #7c3aed;background:transparent;color:#7c3aed;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;margin-bottom:10px">
        + Добавить период
      </button>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px">
        ${this.numInput('minPrice','Глобальный мин., ₽',f.minPrice,'')}
        ${this.numInput('maxPrice','Глобальный макс., ₽',f.maxPrice,'')}
      </div>`;
    }
    if (f.type === 'mrc') {
      const isMulti = this.formProducts.length > 1;
      return `
        <div style="background:color-mix(in srgb,#f59e0b 7%,transparent);border:1px solid color-mix(in srgb,#f59e0b 30%,transparent);
          border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.7;color:var(--text)">
          Укажите МРЦ — цену, которую <b>покупатель должен видеть</b> на маркетплейсе.<br>
          Система каждый час проверяет реальную цену покупателя и автоматически поднимает вашу цену продавца
          так, чтобы после скидки маркетплейса покупатель видел ровно вашу МРЦ.<br>
          <span style="color:var(--text2);font-size:11px">База — Москва. Ozon даёт скидку 32% → ваша цена поднимается до нужного уровня, покупатель видит МРЦ. WB — аналогично.</span>
          ${isMulti ? `<br><b style="color:#f59e0b;font-size:11px">Для каждого артикула создаётся отдельное правило со своей МРЦ.</b>` : ''}
        </div>

        ${isMulti ? `
          <!-- БЫСТРОЕ ЗАПОЛНЕНИЕ -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:10px 12px;
            background:var(--bg);border:1px solid var(--border);border-radius:9px">
            <span style="font-size:11px;color:var(--text2);white-space:nowrap;font-weight:600">Одна МРЦ для всех:</span>
            <input type="number" placeholder="9 990" min="1" step="1"
              value="${this.mrcFillPrice ?? ''}"
              oninput="window.repricerModule.setMrcFillPrice(+this.value)"
              style="flex:1;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:7px;font-size:13px">
            <button onclick="window.repricerModule.applyMrcFillAll()"
              style="padding:6px 16px;border:none;background:#f59e0b;color:#000;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
              Заполнить все ↓
            </button>
          </div>

          <!-- ПО-АРТИКУЛЬНО -->
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:6px">
            МРЦ по каждому артикулу, ₽
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:14px">
            ${this.formProducts.map(p => {
              const perPrice = this.formProductMrcPrices.get(p.vendorCode);
              const filled = perPrice != null && perPrice > 0;
              return `
                <div style="display:grid;grid-template-columns:1fr auto 140px;gap:10px;align-items:center;
                  background:var(--bg);border:1px solid ${filled ? 'color-mix(in srgb,#f59e0b 40%,transparent)' : 'var(--border)'};
                  border-radius:8px;padding:8px 12px">
                  <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                    title="${this.esc(p.productTitle)}">${this.esc(p.productTitle)}</div>
                  <div style="font-size:10px;font-family:monospace;color:var(--text2);white-space:nowrap">${this.esc(p.vendorCode)}</div>
                  <input type="number" value="${perPrice ?? ''}" placeholder="МРЦ ₽" min="1" step="1"
                    onchange="window.repricerModule.updateProductMrcPrice('${this.esc(p.vendorCode)}', +this.value)"
                    style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:7px;font-size:13px;box-sizing:border-box">
                </div>`;
            }).join('')}
          </div>
        ` : `
          <div style="margin-bottom:6px">
            ${this.numInput('mrcPrice', 'МРЦ — цена покупателя, ₽', f.mrcPrice, '9 990')}
          </div>
        `}

        <div style="margin-bottom:6px">
          ${this.numInput('mrcBuffer', '% скрытой скидки маркетплейса', f.mrcBuffer, '0')}
          <div style="font-size:11px;color:var(--text2);margin-top:4px;line-height:1.5">
            <b>Обычно оставьте 0.</b> Для WB и Ozon система держит МРЦ по «первому» уровню скидки
            (на WB — цена «без WB Кошелька», на Ozon — «обычная» цена marketing_price), а эти значения
            API отдаёт точно — буфер не нужен. Поле имеет смысл только если на витрине ваш товар
            всё равно показывается дешевле МРЦ из-за <b>дополнительной</b> скидки, которую API не отдаёт
            вообще (например, скидка лояльности ЯМ поверх базовой цены).<br>
            Откройте карточку товара на витрине и посмотрите, на сколько % "обычная" цена
            (без оплаты картой/кошельком маркетплейса) ниже цены, которую держит система.
            Укажите этот % здесь — система будет завышать цену так, чтобы ПОСЛЕ скидки
            маркетплейса покупатель видел ровно МРЦ (${f.mrcPrice || 0} ₽).<br>
            Если скидка не наблюдается — оставьте 0.
          </div>
        </div>

        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">
            Проверка цены на маркетплейсах
          </div>
          <div style="font-size:11.5px;color:var(--text2);margin-bottom:8px;line-height:1.5">
            Соберёт текущую цену, за которую маркетплейсы продают этот товар клиенту сейчас
            (без карты/кошелька МП — обычная оплата любой картой), по всем магазинам, где он есть,
            и покажет, какую цену нужно поставить в ЛК, чтобы покупатель видел указанную МРЦ.
          </div>
          <div id="rpr-mrc-analysis-host">${this.renderMrcAnalysis()}</div>
        </div>
      `;
    }
    if (f.type === 'formula') {
      // Собираем список магазинов из выбранных товаров/formStoreIds
      const allStoresFlat: Array<{ id: string; name: string; mp: Mp }> = [
        ...this.wbStores.map(s   => ({ id: s.id, name: s.name, mp: 'wb'     as Mp })),
        ...this.ozonStores.map(s => ({ id: s.id, name: s.name, mp: 'ozon'   as Mp })),
        ...this.ymStores.map(s   => ({ id: s.id, name: s.name, mp: 'yandex' as Mp })),
      ];
      const formulaStores = allStoresFlat.filter(s => this.formStoreIds.has(s.id));
      // Если редактирование и магазин один — добавляем его в список
      if (formulaStores.length === 0 && f.storeId) {
        const st = allStoresFlat.find(s => s.id === f.storeId);
        if (st) formulaStores.push(st);
      }

      const varBtn = (t: string) => `<button onclick="window.repricerModule.insertFormulaToken('${t}')"
        style="padding:5px 9px;border:1px solid #059669;background:#05966910;color:#059669;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;font-family:monospace">${t}</button>`;
      const opBtn  = (t: string, disp?: string) => `<button onclick="window.repricerModule.insertFormulaToken('${t}')"
        style="padding:5px 9px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;font-family:monospace">${disp ?? t}</button>`;

      return `
        <div style="background:color-mix(in srgb,#059669 6%,transparent);border:1px solid color-mix(in srgb,#059669 22%,transparent);
          border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.7;color:var(--text)">
          Формула рассчитывает цену из переменных: <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">cost_price</code> (себестоимость из БД),
          <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">stock</code> (остаток), <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">margin</code> (множитель).<br>
          <b>Для каждого магазина пишется своя формула</b> — разные наценки для WB и Ozon задаются отдельно.
        </div>

        <!-- Быстрая вставка -->
        <div style="margin-bottom:12px">
          <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Переменные и операции</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
            ${varBtn('cost_price')} ${varBtn('stock')} ${varBtn('margin')}
            <span style="width:1px;height:20px;background:var(--border);margin:0 2px"></span>
            ${opBtn('+')} ${opBtn('-')} ${opBtn('*','×')} ${opBtn('/','÷')} ${opBtn('(')} ${opBtn(')')}
            <span style="width:1px;height:20px;background:var(--border);margin:0 2px"></span>
            ${['1','2','3'].map(n => opBtn(n)).join('')}<span style="font-size:11px;color:var(--text3)">…</span>
          </div>
        </div>

        ${formulaStores.length === 0 ? `
          <div style="padding:20px;text-align:center;background:var(--bg2);border:1px dashed var(--border);border-radius:10px;color:var(--text2);font-size:13px">
            Сначала выберите товары (шаг 2) — магазины подтянутся автоматически
          </div>
        ` : `
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:8px">
            Формула для каждого магазина
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
            ${formulaStores.map(store => {
              const storeFormula = this.formStoreFormulas.get(store.id) ?? (formulaStores.length === 1 ? (f.formula ?? '') : '');
              const cost = (() => {
                const anyProd = this.formProducts[0];
                return anyProd ? costPriceDb.get(anyProd.vendorCode) : null;
              })();
              const preview = storeFormula ? evalFormula(storeFormula, { cost_price: cost ?? 0, stock: 0, margin: f.marginMultiplier ?? 1 }) : null;
              return `
                <div style="background:var(--bg);border:1px solid ${storeFormula ? 'color-mix(in srgb,#059669 40%,transparent)' : 'var(--border)'};border-radius:10px;padding:12px">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                    <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:${MP_BG[store.mp]};color:${MP_COLOR[store.mp]}">${MP_LABEL[store.mp]}</span>
                    <span style="font-size:12px;font-weight:600;color:var(--text)">${this.esc(store.name)}</span>
                    ${cost != null ? `<span style="font-size:10px;color:var(--text2);margin-left:auto">cost_price = <b style="color:#16a34a">${cost.toLocaleString('ru')} ₽</b></span>` : `<span style="font-size:10px;color:#f59e0b;margin-left:auto">⚠ cost_price не задан</span>`}
                  </div>
                  <textarea rows="2" placeholder="cost_price * 2"
                    oninput="window.repricerModule.updateStoreFormula('${this.esc(store.id)}', this.value)"
                    style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg2);color:var(--text);
                      font-family:monospace;font-size:14px;resize:vertical;box-sizing:border-box;outline:none">${this.esc(storeFormula)}</textarea>
                  ${preview != null ? `
                    <div style="margin-top:5px;font-size:11px;color:var(--text2)">
                      Результат: <b style="color:#16a34a">${Math.round(preview).toLocaleString('ru')} ₽</b>
                      <span style="opacity:.6">(при cost_price=${cost ?? 0})</span>
                    </div>` : storeFormula ? `<div style="margin-top:5px;font-size:11px;color:#dc2626">⚠ Формула некорректна</div>` : ''}
                </div>`;
            }).join('')}
          </div>
        `}

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
          ${this.numInput('marginMultiplier','margin (доп. множитель)',f.marginMultiplier,'1.87')}
          ${this.numInput('minPrice','Мин. цена, ₽',f.minPrice,'')}
          ${this.numInput('maxPrice','Макс. цена, ₽',f.maxPrice,'')}
        </div>
      `;
    }
    return '';
  }

  // ── Stock tiers management ────────────────────────────────────
  updateStockTier(idx: number, key: 'maxStock' | 'price', value: number): void {
    if (!this.form.stockTiers) this.form.stockTiers = [];
    this.form.stockTiers[idx] = { ...this.form.stockTiers[idx], [key]: value };
  }
  addStockTier(): void {
    if (!this.form.stockTiers) this.form.stockTiers = [];
    const last = this.form.stockTiers[this.form.stockTiers.length - 1];
    this.form.stockTiers.push({ maxStock: (last?.maxStock ?? 10) * 2, price: last?.price ?? 0 });
    this.render();
  }
  removeStockTier(idx: number): void {
    if (this.form.stockTiers) this.form.stockTiers.splice(idx, 1);
    this.render();
  }

  // ── Schedule periods management ────────────────────────────────
  updateSchedulePeriod(idx: number, key: 'fromTime' | 'toTime' | 'price', value: string | number): void {
    if (!this.form.schedulePeriods) this.form.schedulePeriods = [];
    (this.form.schedulePeriods[idx] as any)[key] = value;
  }
  toggleScheduleDay(periodIdx: number, day: number): void {
    if (!this.form.schedulePeriods) return;
    const p = this.form.schedulePeriods[periodIdx];
    if (!p) return;
    const i = p.days.indexOf(day);
    if (i >= 0) p.days.splice(i, 1);
    else p.days.push(day);
    p.days.sort();
    this.render();
  }
  addSchedulePeriod(): void {
    if (!this.form.schedulePeriods) this.form.schedulePeriods = [];
    this.form.schedulePeriods.push({ days: [1,2,3,4,5], fromTime: '09:00', toTime: '18:00', price: 0 });
    this.render();
  }
  removeSchedulePeriod(idx: number): void {
    if (this.form.schedulePeriods) this.form.schedulePeriods.splice(idx, 1);
    this.render();
  }

  private renderRules(): string {
    return `
      <!-- ФИЛЬТРЫ + ПОИСК -->
      <div style="padding:10px 16px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="search" placeholder="Поиск по артикулу, названию, магазину…" value="${this.esc(this.rulesSearch)}"
          oninput="window.repricerModule.setRulesSearch(this.value)"
          style="flex:1;min-width:200px;padding:6px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${(['', ...Object.keys(RULE_LABELS)] as Array<'' | RuleType>).map(rt => {
            const isActive = this.rulesTypeFilter === rt;
            const label = rt === '' ? 'Все' : RULE_LABELS[rt];
            const count = rt === '' ? this.rules.length : this.rules.filter(r => r.type === rt).length;
            if (count === 0 && rt !== '') return '';
            return `<button onclick="window.repricerModule.setRulesTypeFilter('${rt}')"
              style="padding:5px 11px;border:1.5px solid ${isActive ? 'var(--accent)' : 'var(--border)'};
                background:${isActive ? 'var(--accent)' : 'transparent'};color:${isActive ? '#000' : 'var(--text2)'};
                border-radius:20px;cursor:pointer;font-size:11px;font-weight:${isActive ? '700' : '500'};white-space:nowrap">
              ${label}${count > 0 ? ` <span style="opacity:.7">${count}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
      </div>
      <!-- СПИСОК -->
      <div id="rpr-rules-host">${this.renderRulesInner()}</div>
    `;
  }

  /** Только содержимое списка — обновляется при поиске без полного ре-рендера */
  private renderRulesInner(): string {
    const q = this.rulesSearch.toLowerCase().trim();
    const filtered = this.rules.filter(r => {
      if (this.rulesTypeFilter && r.type !== this.rulesTypeFilter) return false;
      if (q) {
        const hay = [r.productTitle, r.vendorCode, r.storeName,
          ...ruleProducts(r).map(p => `${p.vendorCode} ${p.productTitle}`)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (this.rules.length === 0) return `
      <div class="rpr-empty">
        <div class="rpr-empty-icon">⚙</div>
        <h3>Нет правил</h3>
        <p>Создайте правило — система будет автоматически поддерживать нужные цены</p>
        <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.openAddForm()" style="margin-top:6px">
          + Создать первое правило
        </button>
      </div>`;

    if (filtered.length === 0) return `
      <div style="padding:40px;text-align:center;color:var(--text2);font-size:13px">
        Ничего не найдено · измените фильтр или поиск
      </div>`;

    // Группируем по артикулу — один товар может иметь правила сразу на нескольких
    // маркетплейсах (WB/Ozon/ЯМ), показываем их в одной карточке, а не отдельными строками.
    const groups = new Map<string, RepricerRule[]>();
    const order: string[] = [];
    for (const r of filtered) {
      const key = r.vendorCode || r.productTitle || r.id;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push(r);
    }

    return `
      <div style="display:flex;flex-direction:column;gap:8px;padding:10px 16px">
        ${order.map(key => this.renderArticleCard(groups.get(key)!)).join('')}
      </div>
    `;
  }

  /** Карточка одного артикула со всеми его правилами (по всем маркетплейсам). */
  private renderArticleCard(rules: RepricerRule[]): string {
    const first = rules[0];
    const image = rules.map(r => this.getProductImage(r)).find(Boolean) ?? null;
    const title = rules.map(r => r.productTitle).sort((a, b) => b.length - a.length)[0] || first.productTitle;

    return `
      <div class="rpr-article-card">
        <div class="rpr-article-header">
          ${image
            ? `<img src="${this.esc(image)}" alt="" style="width:34px;height:34px;border-radius:7px;object-fit:cover;flex-shrink:0;border:1px solid var(--border);background:var(--bg3)">`
            : `<div style="width:34px;height:34px;border-radius:7px;flex-shrink:0;border:1px solid var(--border);background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">📦</div>`}
          <div style="min-width:0;flex:1">
            <div class="rpr-article-title" title="${this.esc(title)}">${this.esc(title)}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
              ${first.vendorCode ? `<span class="rpr-article-code">${this.esc(first.vendorCode)}</span>` : ''}
              <span style="font-size:10.5px;color:var(--text3)">${rules.length} ${rules.length === 1 ? 'правило' : 'правила'}</span>
            </div>
          </div>
        </div>
        <div>
          ${rules.map(r => this.renderRuleLine(r)).join('')}
        </div>
      </div>
    `;
  }

  /** Одна компактная строка-правило внутри карточки артикула. */
  private renderRuleLine(r: RepricerRule): string {
    const price = this.computePrice(r);
    const isApplying = this.applying.has(r.id);
    const applyErr = this.applyErrors.get(r.id);
    const last = r.lastAppliedAt
      ? new Date(r.lastAppliedAt).toLocaleDateString('ru',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
      : null;
    const mpClass = `rpr-mp rpr-mp-${r.marketplace}`;

    // Для МРЦ — показываем МРЦ-цену (целевую), а не sellerPrice
    const displayPrice = r.type === 'mrc' && r.mrcPrice ? r.mrcPrice : price;
    const priceLabel   = r.type === 'mrc' ? 'цель' : 'цель';

    // Реальная цена на маркетплейсе сейчас (из последней синхронизации каталога)
    const currentPrice = this.getCurrentPrice(r);
    const matches = r.type !== 'mrc' && displayPrice != null && currentPrice != null
      ? Math.abs(currentPrice - displayPrice) <= 1
      : null;

    return `
      <div class="rpr-rule-line" style="opacity:${r.status === 'paused' ? '.55' : '1'}">
        <span class="${mpClass}">${MP_LABEL[r.marketplace]}</span>
        <span class="rpr-type">${RULE_LABELS[r.type]}</span>
        <span style="font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">${this.esc(r.storeName)}</span>

        <div style="margin-left:auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <div style="text-align:right;min-width:64px">
            ${currentPrice != null
              ? `<span style="font-size:13px;font-weight:800;color:var(--text)">${currentPrice.toLocaleString('ru')} ₽</span>`
              : `<span class="rpr-price-none">—</span>`}
            <div style="font-size:9.5px;color:var(--text3);margin-top:1px">сейчас</div>
          </div>
          <div style="text-align:right;min-width:70px">
            ${displayPrice
              ? `<span class="rpr-price" style="font-size:13px">${displayPrice.toLocaleString('ru')} ₽</span>
                 ${matches === true ? ' <span title="Совпадает с текущей ценой" style="color:#22c55e">✓</span>' : ''}
                 ${matches === false ? ' <span title="Не совпадает с текущей ценой — правило ещё не применено" style="color:#f59e0b">≠</span>' : ''}
                 <div style="font-size:9.5px;color:var(--text3);margin-top:1px">${priceLabel}</div>`
              : `<span class="rpr-price-none">—</span>`}
          </div>
          <div style="text-align:right;min-width:60px">
            ${last
              ? `<div style="font-size:11px;color:var(--text)">${last}</div>`
              : `<span style="color:var(--text3);font-size:11px">—</span>`}
          </div>
          <button class="rpr-status ${r.status === 'active' ? 'rpr-status-active' : 'rpr-status-paused'}"
            onclick="window.repricerModule.toggleStatus('${r.id}')">
            ${r.status === 'active' ? '● Вкл' : '○ Пауза'}
          </button>
          <div style="display:flex;align-items:center;gap:5px">
            ${r.status === 'active' && (displayPrice || r.type === 'mrc') ? `
              <button onclick="window.repricerModule.applyRule('${r.id}')" ${isApplying ? 'disabled' : ''} title="Применить сейчас"
                style="padding:5px 11px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                  background:#22c55e;color:#000;opacity:${isApplying ? .6 : 1}">
                ${isApplying ? '…' : '▶'}
              </button>
            ` : ''}
            <button onclick="window.repricerModule.openEditForm('${r.id}')" title="Редактировать"
              style="padding:5px 9px;border-radius:7px;border:1px solid var(--border);cursor:pointer;font-size:13px;background:var(--bg);color:var(--text)">✎</button>
            <button onclick="if(confirm('Удалить правило?'))window.repricerModule.deleteRule('${r.id}')" title="Удалить"
              style="padding:5px 9px;border-radius:7px;border:1px solid rgba(239,68,68,.3);cursor:pointer;font-size:13px;background:rgba(239,68,68,.07);color:#ef4444">✕</button>
          </div>
        </div>
        ${applyErr ? `<div style="width:100%;font-size:10px;color:#dc2626;text-align:right;margin-top:3px;line-height:1.3">${this.esc(applyErr)}</div>` : ''}
      </div>
    `;
  }

  private renderLog(): string {
    if (this.log.length === 0) return `
      <div class="rpr-empty">
        <div class="rpr-empty-icon">📋</div>
        <h3>История пуста</h3>
        <p>Здесь появятся записи когда правила начнут применяться к ценам</p>
      </div>
    `;
    return `
      <table class="rpr-table">
        <thead>
          <tr>
            <th>Товар</th>
            <th>Причина</th>
            <th class="num">Было</th>
            <th class="num">Стало</th>
            <th class="num">Дата</th>
          </tr>
        </thead>
        <tbody>
          ${this.log.map(l => `
            <tr>
              <td>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
                  <span class="rpr-mp rpr-mp-${l.marketplace}">${MP_LABEL[l.marketplace]}</span>
                  <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${this.esc(l.productTitle)}</span>
                </div>
                <div style="font-size:10.5px;color:var(--text3)">${this.esc(l.storeName)}</div>
              </td>
              <td style="color:var(--text2);font-size:11.5px">${this.esc(l.reason)}</td>
              <td class="num" style="color:var(--text2)">${l.oldPrice != null ? l.oldPrice.toLocaleString('ru') + ' ₽' : '—'}</td>
              <td class="num" style="font-weight:700;color:#22c55e;font-size:14px">${l.newPrice.toLocaleString('ru')} ₽</td>
              <td class="num" style="font-size:10.5px;color:var(--text3)">
                ${new Date(l.appliedAt).toLocaleDateString('ru',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  ВКЛАДКА «СЕБЕСТОИМОСТИ» — управление cost_price для всех товаров
  // ════════════════════════════════════════════════════════════════════════

  private renderCosts(): string {
    const products = this.buildUnifiedProducts();
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const orphanEntries = costPriceDb.all().filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()));

    type Row = { vendorCode: string; title: string; variants: any[]; orphan: boolean };
    const allRows: Row[] = [
      ...products.map(p => ({ vendorCode: p.vendorCode, title: p.title, variants: p.variants, orphan: false })),
      ...orphanEntries.map(e => ({ vendorCode: e.vendorCode, title: '', variants: [], orphan: true })),
    ];

    const q = this.costsSearch.toLowerCase().trim();
    const filtered = allRows.filter(r => {
      if (this.costsMpFilter && !r.orphan && !r.variants.some((v: any) => v.mp === this.costsMpFilter)) return false;
      if (this.costsMpFilter && r.orphan) return false;
      if (q && !`${r.vendorCode} ${r.title}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const catalogCount = products.length;
    const withCost = products.filter(p => costPriceDb.get(p.vendorCode) != null).length;
    const withoutCost = catalogCount - withCost;
    const allFilteredSelected = filtered.length > 0 && filtered.every(r => this.costsSelected.has(r.vendorCode.toLowerCase()));

    const pct = catalogCount > 0 ? Math.round(withCost / catalogCount * 100) : 0;

    return `
      <!-- ШАПКА -->
      <div style="padding:16px 20px;background:var(--bg);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:3px">Себестоимости товаров</div>
            <div style="font-size:11px;color:var(--text2)">
              Используется в правилах <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">По марже</code> и <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">Формула</code> как переменная <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">cost_price</code>
            </div>
          </div>
          <div style="display:flex;gap:7px;flex-shrink:0">
            <button class="rpr-btn rpr-btn-ghost" onclick="window.repricerModule.exportCostsTemplate()">
              ↓ xlsx
            </button>
            <label class="rpr-btn rpr-btn-ghost" style="cursor:pointer">
              ↑ Импорт
              <input type="file" accept=".xlsx,.xls" style="display:none" onchange="window.repricerModule.importCostsFile(this)">
            </label>
          </div>
        </div>

        <!-- KPI + прогресс-бар -->
        <div class="rpr-stats">
          <div class="rpr-stat">
            <div class="rpr-stat-label">В каталоге</div>
            <div class="rpr-stat-val">${catalogCount}</div>
          </div>
          <div class="rpr-stat">
            <div class="rpr-stat-label" style="color:#22c55e">С cost_price</div>
            <div class="rpr-stat-val green">${withCost}</div>
          </div>
          <div class="rpr-stat ${withoutCost > 0 ? '' : ''}" style="${withoutCost > 0 ? 'border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.04)' : ''}">
            <div class="rpr-stat-label" style="${withoutCost > 0 ? 'color:#ef4444' : ''}">Без cost_price</div>
            <div class="rpr-stat-val ${withoutCost > 0 ? 'red' : ''}">${withoutCost}</div>
          </div>
          ${(() => {
            // Разбивка orphan'ов на архив / удалён, если данные уже загружены
            if (!this.soldVendorCodes) {
              return `
                <div class="rpr-stat" style="border-color:rgba(245,158,11,.2);background:rgba(245,158,11,.04)">
                  <div class="rpr-stat-label" style="color:#f59e0b">Вне каталога</div>
                  <div class="rpr-stat-val amber">${orphanEntries.length}</div>
                  <div style="font-size:9px;color:var(--text3);margin-top:3px">проверяем…</div>
                </div>`;
            }
            const sold = this.soldVendorCodes;
            const archived = orphanEntries.filter(e => sold.has(e.vendorCode.trim().toLowerCase())).length;
            const deleted  = orphanEntries.length - archived;
            return `
              <div class="rpr-stat" style="border-color:rgba(245,158,11,.2);background:rgba(245,158,11,.04)">
                <div class="rpr-stat-label" style="color:#f59e0b">Архив</div>
                <div class="rpr-stat-val amber">${archived}</div>
                <div style="font-size:9.5px;color:var(--text3);margin-top:3px">был в продажах</div>
              </div>
              ${deleted > 0 ? `
                <div class="rpr-stat" style="border-color:rgba(239,68,68,.2);background:rgba(239,68,68,.04)">
                  <div class="rpr-stat-label" style="color:#ef4444">Удалён</div>
                  <div class="rpr-stat-val red">${deleted}</div>
                  <button onclick="window.repricerModule.deleteAllDeletedCosts()"
                    style="margin-top:4px;padding:2px 8px;border:1px solid rgba(239,68,68,.3);background:transparent;color:#ef4444;border-radius:4px;cursor:pointer;font-size:9.5px;font-family:inherit;font-weight:600">
                    Удалить все →
                  </button>
                </div>
              ` : ''}
            `;
          })()}
        </div>

        <!-- Прогресс-бар заполненности -->
        ${catalogCount > 0 ? `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-bottom:4px">
              <span>Заполненность себестоимости</span>
              <span style="font-weight:700;color:${pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'}">${pct}%</span>
            </div>
            <div style="height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444'};border-radius:3px;transition:width .5s"></div>
            </div>
          </div>
        ` : ''}
      </div>

      <!-- РУЧНОЙ ВВОД -->
      <div style="padding:10px 20px;background:var(--bg2);border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
          <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);white-space:nowrap">Добавить вручную:</span>
          <input type="text" id="rp-manual-vc" placeholder="Артикул"
            onkeydown="if(event.key==='Enter')window.repricerModule.addCostManual()"
            style="flex:2;min-width:140px;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;font-family:monospace;outline:none">
          <input type="number" id="rp-manual-cost" placeholder="Себестоимость ₽" min="0" step="1"
            onkeydown="if(event.key==='Enter')window.repricerModule.addCostManual()"
            style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;font-size:12px;outline:none">
          <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.addCostManual()">Сохранить</button>
          <span style="font-size:10.5px;color:var(--text3)">Для архивных артикулов и размеров вне каталога</span>
        </div>
      </div>

      <!-- ФИЛЬТРЫ + МАССОВАЯ ОПЕРАЦИЯ -->
      <div style="display:flex;align-items:center;gap:7px;padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap">
        <input class="rpr-search" type="search" placeholder="Поиск по артикулу или названию…"
          value="${this.esc(this.costsSearch)}"
          oninput="window.repricerModule.setCostsSearch(this.value)">
        <select class="rpr-select" onchange="window.repricerModule.setCostsMp(this.value)">
          <option value=""     ${this.costsMpFilter === ''       ? 'selected' : ''}>Все МП</option>
          <option value="wb"   ${this.costsMpFilter === 'wb'     ? 'selected' : ''}>WB</option>
          <option value="ozon" ${this.costsMpFilter === 'ozon'   ? 'selected' : ''}>Ozon</option>
          <option value="yandex"${this.costsMpFilter === 'yandex'? 'selected' : ''}>ЯМ</option>
        </select>
        <button class="rpr-btn ${allFilteredSelected ? 'rpr-btn-green' : 'rpr-btn-ghost'}"
          onclick="window.repricerModule.toggleCostsAll()">
          ${allFilteredSelected ? '✓ Снять все' : `Выбрать (${filtered.length})`}
        </button>
        ${this.costsSelected.size > 0 ? `
          <div style="display:flex;gap:6px;align-items:center;padding:5px 10px;background:rgba(212,240,0,.06);border:1px solid rgba(212,240,0,.2);border-radius:8px">
            <span style="font-size:11px;color:var(--text2)">${this.costsSelected.size} шт → </span>
            <input type="number" id="rp-bulk-cost" placeholder="₽" min="0" step="1" value="${this.costsBulkValue}"
              style="width:75px;padding:4px 7px;border:1px solid var(--border);background:var(--bg3);color:var(--text);border-radius:5px;font-size:12px;font-family:inherit;outline:none">
            <button class="rpr-btn rpr-btn-green" style="padding:4px 10px;font-size:11px"
              onclick="window.repricerModule.applyCostsBulk()">Применить</button>
          </div>
        ` : ''}
        <span style="font-size:11px;color:var(--text3);margin-left:auto">${filtered.length} из ${allRows.length}</span>
      </div>

      <!-- ТАБЛИЦА -->
      <div style="overflow:auto">
        ${filtered.length === 0 ? `
          <div class="rpr-empty">
            <div class="rpr-empty-icon">🔍</div>
            <h3>Ничего не найдено</h3>
            <p>Попробуй изменить фильтр. Если каталог пуст — <a href="#" onclick="event.preventDefault();window.app?.navigateTo('marketplaces')" style="color:var(--accent)">синхронизируй магазины</a>.</p>
          </div>
        ` : `
          <table class="rpr-table">
            <thead>
              <tr>
                <th style="width:36px;padding:9px 16px"></th>
                <th>Артикул</th>
                <th>Название / статус</th>
                <th style="text-align:center">МП</th>
                <th class="num">Цена МП</th>
                <th class="num" style="min-width:160px">Себестоимость, ₽</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map(r => {
                const sel  = this.costsSelected.has(r.vendorCode.toLowerCase());
                const cost = costPriceDb.get(r.vendorCode);
                const prices = r.variants.filter((v: any) => v.price != null).map((v: any) => v.price as number);
                const minP = prices.length ? Math.min(...prices) : null;
                const maxP = prices.length ? Math.max(...prices) : null;
                return `
                  <tr style="${sel ? 'background:rgba(212,240,0,.04)' : r.orphan ? 'background:rgba(245,158,11,.03)' : ''}">
                    <td style="padding:7px 16px">
                      <div onclick="window.repricerModule.toggleCostsRow('${this.esc(r.vendorCode)}')"
                        class="rpr-check ${sel ? 'checked' : ''}">
                        ${sel ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="black" stroke-width="2.2"><path d="M2 6l3 3 5-6"/></svg>' : ''}
                      </div>
                    </td>
                    <td style="font-family:monospace;font-size:11.5px">${this.esc(r.vendorCode)}</td>
                    <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text2)">
                      ${r.orphan
                        ? (() => {
                            // Если данные ещё грузятся — показываем нейтральный лейбл
                            if (!this.soldVendorCodes) {
                              return `<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(120,120,120,.1);color:var(--text3);font-weight:700;letter-spacing:.3px">проверяем…</span>`;
                            }
                            const wasSold = this.soldVendorCodes.has(r.vendorCode.trim().toLowerCase());
                            return wasSold
                              ? `<span title="Артикул когда-то продавался, но снят с продажи на МП" style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(245,158,11,.12);color:#f59e0b;font-weight:700;letter-spacing:.3px">📦 архив</span>`
                              : `<span title="Артикул нигде не встречался в продажах — можно удалить" style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,.12);color:#ef4444;font-weight:700;letter-spacing:.3px">🗑 удалён</span>`;
                          })()
                        : this.esc(r.title)
                      }
                    </td>
                    <td style="text-align:center">
                      <div style="display:flex;justify-content:center;gap:2px">
                        ${r.orphan
                          ? (() => {
                              if (!this.soldVendorCodes) return `<span style="font-size:9px;color:var(--text3)">—</span>`;
                              const wasSold = this.soldVendorCodes.has(r.vendorCode.trim().toLowerCase());
                              return wasSold
                                ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,.1);color:#f59e0b">был в продажах</span>`
                                : `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.08);color:#ef4444">не продавался</span>`;
                            })()
                          : r.variants.map((v: any) => `<span class="rpr-mp rpr-mp-${v.mp}">${MP_LABEL[v.mp as Mp]}</span>`).join('')
                        }
                      </div>
                    </td>
                    <td class="num" style="color:var(--text2);font-size:11.5px">
                      ${!r.orphan && minP != null && maxP != null ? (minP === maxP ? `${minP.toLocaleString('ru')} ₽` : `${minP.toLocaleString('ru')}–${maxP.toLocaleString('ru')}`) : '—'}
                    </td>
                    <td style="padding:7px 16px">
                      <div style="display:flex;justify-content:flex-end;align-items:center;gap:5px">
                        <input type="number" min="0" step="1" value="${cost ?? ''}" placeholder="не задана"
                          onchange="window.repricerModule.setCost('${this.esc(r.vendorCode)}',+this.value)"
                          class="rpr-cost-input ${cost != null ? 'has-value' : 'missing'}">
                        ${r.orphan ? `
                          <button onclick="if(confirm('Удалить запись?'))window.repricerModule.setCost('${this.esc(r.vendorCode)}',NaN)" title="Удалить"
                            style="width:22px;height:22px;border:1px solid rgba(245,158,11,.3);border-radius:4px;background:transparent;
                              cursor:pointer;color:#f59e0b;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0">✕</button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  АНАЛИТИКА ПРОДАЖ
  // ════════════════════════════════════════════════════════════════════════

  async loadAnalytics(): Promise<void> {
    const cid = companyService.getActiveId() ?? 'none';
    const cacheKey = `${ANALYTICS_CACHE_KEY}_${cid}`;
    // Проверяем кеш (свежий = менее 1 часа, тот же период, та же компания)
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.days === this.analyticsDays && Date.now() - cached.ts < 3_600_000) {
          this.analyticsOrders = cached.orders ?? [];
          this.analyticsCachedAt = cached.ts;
          this.analyticsLoaded = true;
          this.analyticsLoading = false;
          this.render();
          return;
        }
      }
    } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }

    this.analyticsLoading = true;
    this.analyticsErrors = [];
    this.render();

    const orders: SalesOrder[] = [];
    const dateFrom = new Date(Date.now() - this.analyticsDays * 86400_000);
    const nowDate  = new Date();

    // WB: "YYYY-MM-DDTHH:MM:SS" без Z (московское время/локальное)
    const wbSince  = dateFrom.toISOString().slice(0, 19);

    // Ozon: полный ISO с Z
    const since    = dateFrom.toISOString();
    const to       = nowDate.toISOString();

    // YM: DD-MM-YYYY (именно такой формат принимает /orders)
    const fmtDDMMYYYY = (d: Date) =>
      `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    const ymFrom = fmtDDMMYYYY(dateFrom);
    const ymTo   = fmtDDMMYYYY(nowDate);

    // ── WB ───────────────────────────────────────────────────────
    for (const store of this.wbStores) {
      try {
        const wbOrders = await fetchAllWbOrders(store, wbSince);
        let added = 0;
        for (const o of wbOrders) {
          if (!o.created_at || o.status === 'cancel') continue;
          // Фильтруем вручную по дате — WB Stats API возвращает всё с dateFrom до сейчас
          const orderDate = new Date(o.created_at);
          if (isNaN(orderDate.getTime()) || orderDate < dateFrom) continue;
          orders.push({ date: o.created_at, revenue: o.total ?? 0, mp: 'wb', storeId: store.id, storeName: store.name });
          added++;
        }
        console.info(`[Analytics] WB ${store.name}: ${added} заказов за ${this.analyticsDays}д`);
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? '');
        console.warn('[Analytics] WB store', store.name, msg);
        const friendly = msg.includes('401') || msg.includes('403') || msg.includes('доступ') || msg.includes('key')
          ? 'Нет доступа — создайте токен WB со скоупом «Статистика» в seller.wildberries.ru → Доступ к API'
          : msg.slice(0, 150) || 'Неизвестная ошибка';
        this.analyticsErrors.push({ mp: 'WB', store: store.name, error: friendly });
      }
    }

    // ── Ozon (FBO + FBS) ─────────────────────────────────────────
    for (const store of this.ozonStores) {
      try {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        let added = 0;
        // FBO (offset-based pagination)
        const fboList = await fetchAllPages(
          (limit, offset, sig) => ozonOrdersApi.getFboPostings(creds, since, to, limit, offset as number, sig),
          50,
        );
        for (const p of fboList) {
          if (!p.created_at) continue;
          const rev = calcPostingTotal(p.products);
          if (rev <= 0) continue;
          orders.push({ date: p.created_at, revenue: rev, mp: 'ozon', storeId: store.id, storeName: store.name });
          added++;
        }
        // FBS (cursor-based)
        const fbsList = await fetchAllPagesByCursor(
          (limit, cursor, sig) => ozonOrdersApi.getFbsPostings(creds, since, to, null, limit, cursor, sig),
          50,
        );
        for (const p of fbsList) {
          if (!p.created_at || p.status === 'cancelled') continue;
          const rev = calcPostingTotal(p.products);
          if (rev <= 0) continue;
          orders.push({ date: p.created_at, revenue: rev, mp: 'ozon', storeId: store.id, storeName: store.name });
          added++;
        }
        console.info(`[Analytics] Ozon ${store.name}: ${added} заказов за ${this.analyticsDays}д`);
      } catch (e) { console.warn('[Analytics] Ozon store', store.name, e); }
    }

    // ── Яндекс Маркет ────────────────────────────────────────────
    for (const store of this.ymStores) {
      try {
        const ymOrders = await fetchAllYandexOrders(store, ymFrom, ymTo);
        let added = 0;
        for (const o of ymOrders) {
          if (!o.creation_date || o.status === 'CANCELLED') continue;
          const orderDate = new Date(o.creation_date);
          if (isNaN(orderDate.getTime()) || orderDate < dateFrom) continue;
          const revenue = o.total > 0
            ? o.total
            : (o.items ?? []).reduce((s: number, it: any) =>
                s + (Number(it.price ?? 0) * (Number(it.count) || 1)), 0);
          if (revenue <= 0) continue;
          orders.push({ date: o.creation_date, revenue, mp: 'yandex', storeId: store.id, storeName: store.name });
          added++;
        }
        console.info(`[Analytics] YM ${store.name}: ${added} заказов за ${this.analyticsDays}д`);
      } catch (e) { console.warn('[Analytics] YM store', store.name, e); }
    }

    this.analyticsOrders = orders;
    this.analyticsCachedAt = Date.now();
    this.analyticsLoaded = true;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ orders, ts: Date.now(), days: this.analyticsDays }));
    } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
    this.analyticsLoading = false;
    this.render();
  }

  private renderAnalyticsTab(): string {
    if (this.analyticsLoading) return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-2);padding:40px">
        <div style="font-size:36px;animation:spin 1.5s linear infinite">⏳</div>
        <div style="font-size:15px;font-weight:600;color:var(--text)">Загружаем заказы из маркетплейсов…</div>
        <div style="font-size:12px;opacity:.6">Запрашиваем WB, Ozon и Яндекс Маркет за ${this.analyticsDays} дней</div>
      </div>`;

    if (!this.analyticsLoaded) return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-2);padding:40px">
        <div style="font-size:48px">📊</div>
        <div style="font-size:17px;font-weight:600;color:var(--text)">Аналитика продаж по времени</div>
        <div style="font-size:13px;color:var(--text-2);text-align:center;max-width:380px;line-height:1.6">
          Загружает заказы напрямую из WB, Ozon и Яндекс Маркет и показывает:<br>
          • в какой день и час продажи выше всего<br>
          • тепловую карту продаж (дни × часы)<br>
          • когда поднять, а когда снизить цену
        </div>
        <button onclick="window.repricerModule.loadAnalytics()"
          style="padding:12px 28px;border:none;background:#7c3aed;color:#fff;border-radius:10px;cursor:pointer;font-size:14px;font-weight:700">
          📊 Загрузить аналитику
        </button>
        ${this.wbStores.length + this.ozonStores.length + this.ymStores.length === 0 ? `
          <div style="font-size:12px;color:#f59e0b;background:#fef3c7;padding:10px 16px;border-radius:8px;max-width:360px;text-align:center">
            ⚠ Нет подключённых магазинов. Сначала добавьте WB / Ozon / Яндекс Маркет в разделе «Маркетплейсы».
          </div>` : ''}
      </div>`;

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const filtered = this.filteredOrders;
    const a = this.computeAnalytics(filtered);
    const noData = a.totalOrders === 0;

    // Все магазины для фильтра с учётом выбранного МП
    // Если выбраны конкретные МП — показываем только их магазины, иначе все
    const allStoresAnnotated = [
      ...this.wbStores.map(s => ({ ...s, mp: 'wb' as Mp })),
      ...this.ozonStores.map(s => ({ ...s, mp: 'ozon' as Mp })),
      ...this.ymStores.map(s => ({ ...s, mp: 'yandex' as Mp })),
    ];
    const filterStores = this.analyticsFilterMps.size > 0
      ? allStoresAnnotated.filter(s => this.analyticsFilterMps.has(s.mp))
      : allStoresAnnotated;

    const cachedStr = this.analyticsCachedAt
      ? `· кеш от ${new Date(this.analyticsCachedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`
      : '';

    return `
      <!-- ШАПКА -->
      <div style="padding:14px 20px;background:var(--bg);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text)">Аналитика продаж по времени</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:1px">
              Последние ${this.analyticsDays} дней · ${this.analyticsOrders.length} заказов всего ${cachedStr}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${[30,60,90,180].map(d => `
              <button onclick="window.repricerModule.setAnalyticsDays(${d})"
                style="padding:4px 10px;border:1px solid ${this.analyticsDays===d?'#7c3aed':'var(--border)'};
                  background:${this.analyticsDays===d?'#7c3aed15':'transparent'};
                  color:${this.analyticsDays===d?'#7c3aed':'var(--text-2)'};
                  border-radius:6px;cursor:pointer;font-size:11px;font-weight:${this.analyticsDays===d?'700':'400'}">
                ${d}д
              </button>`).join('')}
            <button onclick="window.repricerModule.analyticsForceReload()"
              style="padding:4px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text-2);border-radius:6px;cursor:pointer;font-size:11px">
              ↻ Обновить
            </button>
          </div>
        </div>

        <!-- ФИЛЬТР ПО МП -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          ${[
            { mp: '', label: 'Все МП', count: this.analyticsOrders.length },
            { mp: 'wb', label: 'WB', count: this.analyticsOrders.filter(o=>o.mp==='wb').length },
            { mp: 'ozon', label: 'Ozon', count: this.analyticsOrders.filter(o=>o.mp==='ozon').length },
            { mp: 'yandex', label: 'ЯМ', count: this.analyticsOrders.filter(o=>o.mp==='yandex').length },
          ].filter(x => x.mp === '' || x.count > 0).map(x => {
            const on = x.mp === ''
              ? this.analyticsFilterMps.size === 0
              : this.analyticsFilterMps.has(x.mp as Mp);
            const color = x.mp === 'wb' ? '#cb11ab' : x.mp === 'ozon' ? '#005bff' : x.mp === 'yandex' ? '#fc3f1d' : '#7c3aed';
            return `<button onclick="window.repricerModule.setAnalyticsFilterMp('${x.mp}')"
              title="${x.mp ? 'Нажмите несколько МП — данные суммируются' : 'Показать все маркетплейсы'}"
              style="padding:5px 13px;border:1.5px solid ${on ? color : 'var(--border)'};
                background:${on ? color + '18' : 'transparent'};color:${on ? color : 'var(--text-2)'};
                border-radius:20px;cursor:pointer;font-size:12px;font-weight:${on?'700':'400'}">
              ${on ? '✓ ' : ''}${x.label}
              <span style="font-size:10px;opacity:.7">(${x.count})</span>
            </button>`;
          }).join('')}
        </div>

        <!-- ФИЛЬТР ПО МАГАЗИНУ -->
        ${filterStores.length > 1 ? `
          <div style="display:flex;gap:5px;flex-wrap:wrap">
            <button onclick="window.repricerModule.setAnalyticsFilterStore('')"
              style="padding:4px 11px;border:1.5px solid ${!this.analyticsFilterStoreId?'#7c3aed':'var(--border)'};
                background:${!this.analyticsFilterStoreId?'#7c3aed18':'transparent'};
                color:${!this.analyticsFilterStoreId?'#7c3aed':'var(--text-2)'};
                border-radius:20px;cursor:pointer;font-size:11px;font-weight:${!this.analyticsFilterStoreId?'700':'400'}">
              Все магазины
            </button>
            ${filterStores.map(s => {
              const on = this.analyticsFilterStoreId === s.id;
              const col = MP_COLOR[s.mp];
              return `<button onclick="window.repricerModule.setAnalyticsFilterStore('${s.id}')"
                style="padding:4px 11px;border:1.5px solid ${on?col:'var(--border)'};
                  background:${on?MP_BG[s.mp]:'transparent'};color:${on?col:'var(--text-2)'};
                  border-radius:20px;cursor:pointer;font-size:11px;font-weight:${on?'700':'400'};
                  max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${on?'✓ ':''}${this.esc(s.name)}
              </button>`;
            }).join('')}
          </div>` : ''}

        <!-- KPI -->
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:12px">
          ${[
            { label: 'Заказов', val: a.totalOrders > 0 ? a.totalOrders.toLocaleString('ru') : '—', color: '#005bff' },
            { label: 'Выручка', val: a.totalRevenue > 0 ? a.totalRevenue.toLocaleString('ru') + ' ₽' : '—', color: '#059669' },
            { label: 'Лучший день', val: noData ? '—' : DAYS_RU[a.byDay.indexOf(Math.max(...a.byDay))], color: '#7c3aed' },
            { label: 'Пик (час)', val: noData ? '—' : a.byHour.indexOf(Math.max(...a.byHour)) + ':00', color: '#f59e0b' },
          ].map(k => `
            <div style="padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:10px">
              <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">${k.label}</div>
              <div style="font-size:18px;font-weight:800;color:${k.color}">${k.val}</div>
            </div>`).join('')}
        </div>
      </div>

      ${this.analyticsErrors.length > 0 ? `
        <div style="margin:12px 20px 0;padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b55;border-radius:10px;font-size:12px">
          <div style="font-weight:700;color:#92400e;margin-bottom:6px">⚠ Ошибки загрузки (данные могут быть неполными):</div>
          ${this.analyticsErrors.map(e => `
            <div style="color:#78350f;margin-bottom:4px;line-height:1.5">
              <b>${e.mp} · ${e.store}:</b> ${e.error}
            </div>`).join('')}
        </div>
      ` : ''}

      ${noData ? `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 40px;gap:12px;color:var(--text-2);text-align:center">
          <div style="font-size:36px">📭</div>
          <div style="font-size:15px;font-weight:600;color:var(--text)">Нет заказов за выбранный период</div>
          <div style="font-size:12px;opacity:.7;max-width:340px;line-height:1.6">
            Попробуйте увеличить период анализа или проверьте правильность API-ключей в разделе «Маркетплейсы»
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
            <button onclick="window.repricerModule.setAnalyticsDays(180)"
              style="padding:7px 16px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer;font-size:12px">
              📅 Расширить до 180 дней
            </button>
            <button onclick="window.repricerModule.analyticsForceReload()"
              style="padding:7px 16px;border:none;background:#7c3aed;color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
              ↻ Перезагрузить
            </button>
          </div>
        </div>
      ` : `
        <!-- SUB-TABS -->
        <div style="display:flex;gap:0;padding:0 20px;background:var(--bg2);border-bottom:1px solid var(--border)">
          ${(['heatmap','days','hours','tips'] as const).map(st => {
            const labels = { heatmap:'🔥 Тепловая карта', days:'📅 По дням', hours:'🕐 По часам', tips:'💡 Советы и правила' };
            const on = this.analyticsSubTab === st;
            return `<button onclick="window.repricerModule.setAnalyticsSubTab('${st}')"
              style="padding:9px 14px;border:none;cursor:pointer;background:transparent;font-size:12px;
                font-weight:${on?'700':'400'};color:${on?'#7c3aed':'var(--text-2)'};
                border-bottom:2px solid ${on?'#7c3aed':'transparent'};margin-bottom:-2px;white-space:nowrap">
              ${labels[st]}
            </button>`;
          }).join('')}
        </div>
        <div style="padding:20px 20px;overflow:auto">
          ${this.analyticsSubTab === 'heatmap' ? this.renderSalesHeatmap(a)
          : this.analyticsSubTab === 'days' ? this.renderSalesByDay(a)
          : this.analyticsSubTab === 'hours' ? this.renderSalesByHour(a)
          : this.renderSalesTips(a)}
        </div>
      `}
    `;
  }

  analyticsForceReload(): void {
    const cid = companyService.getActiveId() ?? 'none';
    localStorage.removeItem(`${ANALYTICS_CACHE_KEY}_${cid}`);
    this.analyticsLoaded = false;
    this.analyticsOrders = [];
    this.analyticsCachedAt = null;
    this.loadAnalytics();
  }

  private renderSalesHeatmap(a: SalesAnalytics): string {
    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

    // Найдём максимальное значение для нормализации цвета
    let maxRev = 0;
    for (let d = 0; d < 7; d++)
      for (let h = 0; h < 24; h++)
        if (a.heatmap[d][h].revenue > maxRev) maxRev = a.heatmap[d][h].revenue;

    const cellColor = (rev: number) => {
      if (maxRev === 0 || rev === 0) return 'var(--bg2)';
      const ratio = rev / maxRev;
      if (ratio < 0.15) return '#f0fdf4';
      if (ratio < 0.3)  return '#bbf7d0';
      if (ratio < 0.5)  return '#4ade80';
      if (ratio < 0.7)  return '#16a34a';
      if (ratio < 0.85) return '#15803d';
      return '#14532d';
    };
    const textColor = (rev: number) => {
      if (maxRev === 0 || rev === 0) return 'transparent';
      return rev / maxRev > 0.5 ? '#fff' : '#15803d';
    };

    return `
      <div style="margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Тепловая карта продаж</div>
        <div style="font-size:11px;color:var(--text-2)">Каждая ячейка — выручка за час в конкретный день недели. Чем темнее — тем больше продаж.</div>
      </div>

      <!-- ЛЕГЕНДА -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px;font-size:10px;color:var(--text-2)">
        <span>Мало</span>
        ${['#f0fdf4','#bbf7d0','#4ade80','#16a34a','#15803d','#14532d'].map(c =>
          `<div style="width:20px;height:14px;background:${c};border-radius:3px"></div>`).join('')}
        <span>Много</span>
      </div>

      <div style="overflow-x:auto">
        <table style="border-collapse:separate;border-spacing:3px;font-size:10px">
          <thead>
            <tr>
              <th style="width:32px;text-align:right;padding:0 6px 4px;color:var(--text-2);font-weight:600"></th>
              ${Array.from({length:24},(_,h)=>`<th style="width:34px;text-align:center;padding:0 0 4px;color:var(--text-2);font-weight:500">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${DAYS_RU.map((day, d) => `
              <tr>
                <td style="text-align:right;padding:0 8px 0 0;color:var(--text-2);font-weight:600;white-space:nowrap;font-size:11px">${day}</td>
                ${Array.from({length:24},(_,h) => {
                  const cell = a.heatmap[d][h];
                  const bg = cellColor(cell.revenue);
                  const tc = textColor(cell.revenue);
                  const title = cell.revenue > 0
                    ? `${day} ${h}:00 — ${cell.revenue.toLocaleString('ru')} ₽ (${cell.count} заказов)`
                    : `${day} ${h}:00 — нет продаж`;
                  return `<td title="${title}"
                    style="width:34px;height:28px;background:${bg};border-radius:4px;text-align:center;vertical-align:middle;cursor:default">
                    <span style="font-size:9px;color:${tc};font-weight:600">${cell.count > 0 ? cell.count : ''}</span>
                  </td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top:12px;font-size:11px;color:var(--text-2)">
        Цифры в ячейках = количество заказов. Наведите курсор для суммы выручки.
      </div>
    `;
  }

  private renderSalesByDay(a: SalesAnalytics): string {
    const DAYS_RU = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
    const maxRev = Math.max(...a.byDay);
    const avg    = a.byDay.reduce((s, v) => s + v, 0) / 7;
    const sorted = a.byDay.map((rev, d) => ({ d, rev })).sort((a, b) => b.rev - a.rev);

    return `
      <div style="margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Продажи по дням недели</div>
        <div style="font-size:11px;color:var(--text-2)">Средняя выручка: ${Math.round(avg).toLocaleString('ru')} ₽/день</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;max-width:600px">
        ${sorted.map(({ d, rev }) => {
          const pct = maxRev > 0 ? Math.round(rev / maxRev * 100) : 0;
          const aboveAvg = avg > 0 ? (rev - avg) / avg : 0;
          const badge = aboveAvg > 0.3 ? `<span style="background:#dcfce7;color:#16a34a;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;margin-left:6px">▲ +${Math.round(aboveAvg*100)}%</span>`
                      : aboveAvg < -0.3 ? `<span style="background:#fee2e2;color:#dc2626;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;margin-left:6px">▼ ${Math.round(aboveAvg*100)}%</span>`
                      : '';
          return `
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:80px;font-size:12px;font-weight:600;color:var(--text);flex-shrink:0">${DAYS_RU[d]}</div>
              <div style="flex:1;background:var(--bg2);border-radius:6px;height:26px;overflow:hidden;position:relative">
                <div style="height:100%;width:${pct}%;background:${pct>60?'#7c3aed':pct>30?'#a78bfa':'#ddd6fe'};border-radius:6px;transition:width .3s"></div>
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:700;color:${pct>40?'#fff':'var(--text)'}">
                  ${rev > 0 ? rev.toLocaleString('ru') + ' ₽' : '—'}
                </span>
              </div>
              ${badge}
            </div>`;
        }).join('')}
      </div>
      <div style="margin-top:20px;padding:14px;background:color-mix(in srgb,#7c3aed 8%,var(--bg2));border:1px solid color-mix(in srgb,#7c3aed 25%,var(--border));border-radius:10px;font-size:12px;color:var(--text);line-height:1.6">
        💡 <b>Совет:</b> В дни с высокими продажами (▲) цену можно поднять — спрос не снизится.
        В слабые дни (▼) — временно снизьте цену чтобы подстегнуть продажи.
        <br>Используйте правило <b>«По расписанию»</b> чтобы автоматизировать это.
        <br><br>
        <button onclick="window.repricerModule.createScheduleFromAnalytics()"
          style="padding:7px 16px;border:none;background:#7c3aed;color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
          ✦ Создать правило по расписанию
        </button>
      </div>
    `;
  }

  private renderSalesByHour(a: SalesAnalytics): string {
    const maxRev = Math.max(...a.byHour);
    const avg    = a.byHour.reduce((s, v) => s + v, 0) / 24;

    // Группируем по периодам дня
    const periods = [
      { label: 'Ночь',     hours: [0,1,2,3,4,5],     color: '#1e1b4b', bg: '#ede9fe' },
      { label: 'Утро',     hours: [6,7,8,9,10,11],   color: '#0369a1', bg: '#e0f2fe' },
      { label: 'День',     hours: [12,13,14,15,16,17],color: '#d97706', bg: '#fef3c7' },
      { label: 'Вечер',    hours: [18,19,20,21,22,23],color: '#dc2626', bg: '#fee2e2' },
    ];

    return `
      <div style="margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">Продажи по часам</div>
        <div style="font-size:11px;color:var(--text-2)">Средняя выручка: ${Math.round(avg).toLocaleString('ru')} ₽/час</div>
      </div>

      <!-- Гистограмма по часам -->
      <div style="display:flex;align-items:flex-end;gap:3px;height:120px;margin-bottom:6px;overflow-x:auto;padding-bottom:4px">
        ${a.byHour.map((rev, h) => {
          const pct = maxRev > 0 ? rev / maxRev * 100 : 0;
          const aboveAvg = avg > 0 && rev > avg * 1.3;
          return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:24px" title="${h}:00 — ${rev.toLocaleString('ru')} ₽">
            <div style="width:100%;background:${aboveAvg?'#7c3aed':'#a78bfa'};height:${pct}%;border-radius:3px 3px 0 0;min-height:${rev>0?2:0}px;transition:height .3s"></div>
            <span style="font-size:9px;color:var(--text-2)">${h}</span>
          </div>`;
        }).join('')}
      </div>

      <!-- По периодам дня -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:20px">
        ${periods.map(p => {
          const periodRev = p.hours.reduce((s, h) => s + a.byHour[h], 0);
          const periodPct = a.totalRevenue > 0 ? Math.round(periodRev / a.totalRevenue * 100) : 0;
          const bestHour = p.hours.reduce((best, h) => a.byHour[h] > a.byHour[best] ? h : best, p.hours[0]);
          return `
            <div style="padding:14px;background:${p.bg};border-radius:10px">
              <div style="font-size:12px;font-weight:700;color:${p.color};margin-bottom:6px">${p.label} (${p.hours[0]}:00–${p.hours[p.hours.length-1]+1}:00)</div>
              <div style="font-size:20px;font-weight:800;color:${p.color}">${periodPct}%</div>
              <div style="font-size:10px;color:${p.color};opacity:.8;margin-top:3px">${periodRev.toLocaleString('ru')} ₽ выручки</div>
              <div style="font-size:10px;color:${p.color};opacity:.7;margin-top:4px">Пик: ${bestHour}:00–${bestHour+1}:00</div>
            </div>`;
        }).join('')}
      </div>

      <div style="margin-top:20px;padding:14px;background:color-mix(in srgb,#7c3aed 8%,var(--bg2));border:1px solid color-mix(in srgb,#7c3aed 25%,var(--border));border-radius:10px;font-size:12px;color:var(--text);line-height:1.6">
        💡 <b>Совет:</b> Установите повышенную цену в часы пик, сниженную — в «мёртвые» часы.
        <br><br>
        <button onclick="window.repricerModule.createScheduleFromAnalytics()"
          style="padding:7px 16px;border:none;background:#7c3aed;color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">
          ✦ Создать правило по расписанию
        </button>
      </div>
    `;
  }

  private renderSalesTips(a: SalesAnalytics): string {
    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const DAYS_FULL = ['воскресенье','понедельник','вторник','среду','четверг','пятницу','субботу'];

    const avgDay  = a.byDay.reduce((s,v)=>s+v,0) / 7;
    const avgHour = a.byHour.reduce((s,v)=>s+v,0) / 24;

    const peakDays  = a.byDay.map((r,d)=>({d,r})).filter(x => avgDay > 0 && x.r > avgDay * 1.3).sort((a,b)=>b.r-a.r);
    const weakDays  = a.byDay.map((r,d)=>({d,r})).filter(x => avgDay > 0 && x.r < avgDay * 0.7 && x.r > 0).sort((a,b)=>a.r-b.r);
    const peakHours = a.byHour.map((r,h)=>({h,r})).filter(x => avgHour > 0 && x.r > avgHour * 1.5).sort((a,b)=>b.r-a.r).slice(0,5);
    const deadHours = a.byHour.map((r,h)=>({h,r})).filter(x => x.r === 0 || (avgHour > 0 && x.r < avgHour * 0.3)).slice(0,6);

    const tip = (icon: string, title: string, body: string, color: string, action?: string) => `
      <div style="padding:16px;background:var(--bg);border:1px solid var(--border);border-left:4px solid ${color};border-radius:10px">
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px">${icon} ${title}</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">${body}</div>
        ${action ? `<div style="margin-top:10px">${action}</div>` : ''}
      </div>`;

    const scheduleBtn = `<button onclick="window.repricerModule.createScheduleFromAnalytics()"
      style="padding:6px 14px;border:none;background:#7c3aed;color:#fff;border-radius:7px;cursor:pointer;font-size:11px;font-weight:600">
      ✦ Создать правило по расписанию
    </button>`;

    const tips: string[] = [];

    if (peakDays.length > 0) {
      const dayNames = peakDays.map(x => DAYS_RU[x.d]).join(', ');
      const maxPct = Math.round((peakDays[0].r - avgDay) / avgDay * 100);
      tips.push(tip('📈', `Поднимайте цену в ${dayNames}`,
        `В эти дни выручка на <b style="color:#059669">+${maxPct}%</b> выше среднего. Спрос высокий — клиенты купят по более высокой цене. Рекомендуем поднять цену на 5–15%.`,
        '#059669', scheduleBtn));
    }

    if (weakDays.length > 0) {
      const dayNames = weakDays.map(x => DAYS_FULL[x.d]).join(', ');
      tips.push(tip('📉', `Снижайте цену в ${dayNames}`,
        `В эти дни спрос слабее. Временное снижение цены на 5–10% поможет стимулировать продажи и не терять оборачиваемость.`,
        '#dc2626', scheduleBtn));
    }

    if (peakHours.length > 0) {
      const hourList = peakHours.map(x => `${x.h}:00`).join(', ');
      tips.push(tip('🕐', `Часы пик: ${hourList}`,
        `В эти часы происходит наибольшее количество покупок. Убедитесь, что в это время у вас стоит <b>целевая цена</b> (не занижена акциями).`,
        '#7c3aed'));
    }

    if (deadHours.length > 0) {
      const hourList = deadHours.map(x => `${x.h}:00`).join(', ');
      tips.push(tip('😴', `Мёртвые часы: ${hourList}`,
        `В эти часы покупок почти нет. Можно ставить минимально допустимую цену — это повысит позиции в поиске без потери прибыли (всё равно не купят).`,
        '#64748b'));
    }

    tips.push(tip('⚖️', 'Как использовать аналитику для ценообразования',
      `<b>Стратегия пик/спад:</b><br>
      • Пиковые дни/часы → цена +5–15% от базовой<br>
      • Средние периоды → базовая цена<br>
      • Слабые периоды → цена −5–10% от базовой<br><br>
      Создайте правило <b>«По расписанию»</b> с тремя периодами — и система будет менять цену автоматически.`,
      '#005bff', scheduleBtn));

    return `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:680px">
        ${tips.length ? tips.join('') : `<div style="color:var(--text-2);font-size:13px">Недостаточно данных для рекомендаций. Попробуйте увеличить период анализа.</div>`}
      </div>`;
  }

  /** Открывает форму нового правила «По расписанию», предзаполненную на основе аналитики */
  createScheduleFromAnalytics(): void {
    const a = this.analyticsLoaded ? this.computeAnalytics(this.filteredOrders) : null;
    const avgDay  = a ? a.byDay.reduce((s,v)=>s+v,0) / 7 : 0;
    const avgHour = a ? a.byHour.reduce((s,v)=>s+v,0) / 24 : 0;

    // Находим пиковые и слабые дни
    const peakDays = a ? a.byDay.map((r,d)=>({d,r})).filter(x=>x.r>avgDay*1.3).map(x=>x.d) : [1,2,3,4,5];
    const weakDays = a ? a.byDay.map((r,d)=>({d,r})).filter(x=>x.r<avgDay*0.7).map(x=>x.d) : [0,6];
    const midDays  = [0,1,2,3,4,5,6].filter(d => !peakDays.includes(d) && !weakDays.includes(d));

    // Пиковые часы
    const peakHourStart = a ? a.byHour.reduce((best,r,h) => r > a.byHour[best] ? h : best, 0) : 11;
    const peakHourFrom  = `${String(Math.max(0, peakHourStart - 2)).padStart(2,'0')}:00`;
    const peakHourTo    = `${String(Math.min(23, peakHourStart + 3)).padStart(2,'0')}:00`;

    // Создаём базовые периоды
    const periods: SchedulePeriod[] = [];
    if (peakDays.length > 0) {
      periods.push({ days: peakDays, fromTime: peakHourFrom, toTime: peakHourTo, price: 0 });
    }
    if (midDays.length > 0 || peakDays.length === 0) {
      periods.push({ days: midDays.length > 0 ? midDays : [1,2,3,4,5], fromTime: '00:00', toTime: '23:59', price: 0 });
    }
    if (weakDays.length > 0) {
      periods.push({ days: weakDays, fromTime: '00:00', toTime: '23:59', price: 0 });
    }
    if (periods.length === 0) {
      periods.push({ days: [1,2,3,4,5], fromTime: '09:00', toTime: '18:00', price: 0 });
    }

    // Открываем форму
    this.editId = null;
    this.form = {
      type: 'schedule',
      status: 'active',
      schedulePeriods: periods,
    };
    void avgHour; // suppress unused
    this.formProducts = [];
    this.showForm = true;
    this.formError = '';
    this.tab = 'rules';
    this.render();

    // Скроллим к форме
    setTimeout(() => this.container.scrollTop = 0, 50);
  }

  setCostsSearch(q: string): void { this.costsSearch = q; this.render(); }
  setCostsMp(mp: string): void { this.costsMpFilter = mp as any; this.render(); }
  toggleCostsRow(vendorCode: string): void {
    const k = vendorCode.toLowerCase();
    if (this.costsSelected.has(k)) this.costsSelected.delete(k);
    else this.costsSelected.add(k);
    this.render();
  }
  toggleCostsAll(): void {
    const products = this.buildUnifiedProducts();
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const orphans = costPriceDb.all().filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()));
    const q = this.costsSearch.toLowerCase().trim();
    const filtered = [
      ...products.filter(p => {
        if (this.costsMpFilter && !p.variants.some(v => v.mp === this.costsMpFilter)) return false;
        if (q && !`${p.vendorCode} ${p.title}`.toLowerCase().includes(q)) return false;
        return true;
      }),
      ...(this.costsMpFilter ? [] : orphans.filter(e => !q || e.vendorCode.toLowerCase().includes(q))),
    ];
    const allSelected = filtered.every(r => this.costsSelected.has(r.vendorCode.toLowerCase()));
    if (allSelected) filtered.forEach(r => this.costsSelected.delete(r.vendorCode.toLowerCase()));
    else filtered.forEach(r => this.costsSelected.add(r.vendorCode.toLowerCase()));
    this.render();
  }

  /** Подгружает Set всех vendor_code/sku когда-либо встреченных в mp_transactions
   *  для определения статуса orphan-артикулов: архив vs удалён. */
  private async loadSoldVendorCodes(): Promise<void> {
    if (this.soldVendorCodes || this.soldVendorCodesLoading) return;
    this.soldVendorCodesLoading = true;
    try {
      const { supaFetch } = await import('@/services/supabaseClient');
      const { companyService } = await import('@/services/companyService');
      const cid = companyService.getActiveId();
      if (!cid) { this.soldVendorCodes = new Set(); this.soldVendorCodesLoading = false; return; }

      const allStoreIds = [
        ...this.wbStores.map(s => s.id),
        ...this.ozonStores.map(s => s.id),
        ...this.ymStores.map(s => s.id),
      ];
      if (allStoreIds.length === 0) { this.soldVendorCodes = new Set(); this.soldVendorCodesLoading = false; return; }

      const ids = allStoreIds.map(id => `"${id}"`).join(',');
      // Берём только items_json — экономим трафик. До 50k записей.
      const rows = await supaFetch<Array<{ items_json: Array<{ sku?: any; vendor_code?: any }> | null }>>(
        `mp_transactions?store_id=in.(${ids})&select=items_json&items_json=not.is.null&limit=50000`,
      );

      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.items_json) continue;
        for (const it of row.items_json) {
          const sku = String(it.sku ?? it.vendor_code ?? '').trim().toLowerCase();
          if (sku) seen.add(sku);
        }
      }
      this.soldVendorCodes = seen;
      console.info(`[Repricer] sold vendor_codes loaded: ${seen.size} unique`);
    } catch (e: any) {
      console.warn('[Repricer] loadSoldVendorCodes failed:', e?.message ?? e);
      this.soldVendorCodes = new Set(); // не показываем ошибку — fallback на "архив"
    }
    this.soldVendorCodesLoading = false;
    if (this.tab === 'costs') this.render();
  }

  /** Удалить все cost_price-записи, которые помечены как "удалён"
   *  (нет в каталоге И никогда не встречались в продажах). */
  deleteAllDeletedCosts(): void {
    if (!this.soldVendorCodes) return;
    const sold = this.soldVendorCodes;
    const products = this.buildUnifiedProducts();
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const toDelete = costPriceDb.all().filter(e => {
      const k = e.vendorCode.trim().toLowerCase();
      return !catalogKeys.has(k) && !sold.has(k);
    });
    if (toDelete.length === 0) return;
    if (!confirm(`Удалить ${toDelete.length} записей себестоимости для артикулов, которые нигде не встречаются?`)) return;
    for (const e of toDelete) costPriceDb.remove(e.vendorCode);
    this.render();
    try { (window as any).app?.toast?.(`🗑 Удалено ${toDelete.length} записей`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Сохранить себестоимость одного товара */
  setCost(vendorCode: string, cost: number): void {
    if (!isFinite(cost) || cost < 0) { costPriceDb.remove(vendorCode); }
    else { costPriceDb.set(vendorCode, cost); }
    this.render();
  }

  /** Добавить себестоимость вручную (для артикулов не в каталоге) */
  addCostManual(): void {
    const vcInput = document.getElementById('rp-manual-vc') as HTMLInputElement | null;
    const costInput = document.getElementById('rp-manual-cost') as HTMLInputElement | null;
    const vc = vcInput?.value?.trim() ?? '';
    const cost = parseFloat(costInput?.value ?? '');
    if (!vc) {
      if (vcInput) { vcInput.style.border = '1.5px solid #ef4444'; setTimeout(() => { if (vcInput) vcInput.style.border = ''; }, 1500); }
      return;
    }
    if (!isFinite(cost) || cost < 0) {
      if (costInput) { costInput.style.border = '1.5px solid #ef4444'; setTimeout(() => { if (costInput) costInput.style.border = ''; }, 1500); }
      return;
    }
    costPriceDb.set(vc, cost);
    if (vcInput) vcInput.value = '';
    if (costInput) costInput.value = '';
    this.render();
    try { (window as any).app?.toast?.(`✓ Себестоимость ${cost.toLocaleString('ru')} ₽ сохранена для «${vc}»`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Применить массовое значение ко всем выбранным */
  applyCostsBulk(): void {
    const inp = document.getElementById('rp-bulk-cost') as HTMLInputElement | null;
    const val = parseFloat(inp?.value ?? '');
    if (!isFinite(val) || val < 0) { alert('Введите корректное значение'); return; }
    const codes = [...this.costsSelected];
    const products = this.buildUnifiedProducts();
    // Каталожные артикулы
    const catalogCodes = products.filter(p => codes.includes(p.vendorCode.toLowerCase())).map(p => p.vendorCode);
    // Orphan-артикулы (вне каталога) — используем vendorCode как есть из costPriceDb
    const catalogKeys = new Set(products.map(p => p.vendorCode.trim().toLowerCase()));
    const orphanCodes = costPriceDb.all()
      .filter(e => !catalogKeys.has(e.vendorCode.trim().toLowerCase()) && codes.includes(e.vendorCode.toLowerCase()))
      .map(e => e.vendorCode);
    const realCodes = [...catalogCodes, ...orphanCodes];
    const saved = costPriceDb.setMany(realCodes, val);
    this.costsBulkValue = val;
    this.render();
    try { (window as any).app?.toast?.(`✓ Установлено ${val.toLocaleString('ru')} ₽ для ${saved} товара(ов)`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Скачать xlsx с артикулами и пустым полем cost */
  exportCostsTemplate(): void {
    const products = this.buildUnifiedProducts();
    const rows: any[][] = [
      ['Артикул', 'Название', 'Себестоимость, ₽'],
    ];
    for (const p of products) {
      const cost = costPriceDb.get(p.vendorCode);
      rows.push([p.vendorCode, p.title, cost ?? '']);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 50 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Себестоимость');
    const fname = `cost_prices_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    try { (window as any).app?.toast?.(`📥 Скачан шаблон с ${products.length} товарами`, 'success'); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
  }

  /** Импорт xlsx-файла с себестоимостью */
  importCostsFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const buf = e.target!.result as ArrayBuffer;
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null });
        if (rows.length < 2) { alert('Файл пуст или не содержит данных.'); return; }
        // Найти колонки: артикул и cost
        const headers = (rows[0] as any[]).map(h => String(h ?? '').toLowerCase().trim());
        const artCol = headers.findIndex(h => h.includes('артикул') || h === 'sku' || h.includes('vendor'));
        const costCol = headers.findIndex(h => h.includes('себестоим') || h === 'cost' || h.includes('cost_price'));
        if (artCol === -1 || costCol === -1) {
          alert('Не найдены колонки «Артикул» и «Себестоимость». Скачайте шаблон.');
          return;
        }
        const items: Array<{ vendorCode: string; cost: number }> = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i] as any[];
          if (!r) continue;
          const vc = String(r[artCol] ?? '').trim();
          const cost = parseFloat(String(r[costCol] ?? '').replace(',', '.'));
          if (!vc || !isFinite(cost) || cost < 0) continue;
          items.push({ vendorCode: vc, cost });
        }
        const { saved, skipped } = costPriceDb.bulkSet(items);
        try { (window as any).app?.toast?.(`✓ Импортировано: ${saved}. Пропущено: ${skipped}.`, 'success', 4000); } catch (e) { debug.warn('[RepricerModule] swallowed error', e); }
        this.render();
      } catch (err: any) {
        alert('Ошибка чтения файла: ' + (err?.message ?? err));
      }
      input.value = '';
    };
    reader.readAsArrayBuffer(file);
  }
}
