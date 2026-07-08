/** Shared types for the Repricer module family. */

export type Mp = 'wb' | 'ozon' | 'yandex';
export type RuleType = 'target' | 'margin' | 'stock' | 'schedule' | 'formula' | 'mrc';
export type RuleStatus = 'active' | 'paused';

/** Один порог для правила «по остатку». */
export interface StockTier { maxStock: number; price: number }

/** Один период расписания. */
export interface SchedulePeriod {
  days: number[];   // 0=вс, 1=пн … 6=сб
  fromTime: string; // "HH:MM"
  toTime: string;   // "HH:MM"
  price: number;
}

export interface RuleProduct {
  productId: string;
  vendorCode: string;
  productTitle: string;
}

export interface RepricerRule {
  id: string;
  marketplace: Mp;
  storeId: string;
  storeName: string;
  productId: string;
  vendorCode: string;
  productTitle: string;
  products?: RuleProduct[];
  type: RuleType;
  status: RuleStatus;
  targetPrice?: number;
  marginMultiplier?: number;
  minPrice?: number;
  maxPrice?: number;
  // legacy single-tier stock
  stockThreshold?: number;
  highStockPrice?: number;
  lowStockPrice?: number;
  // legacy weekday/weekend schedule
  weekdayPrice?: number;
  weekendPrice?: number;
  // modern multi-tier
  stockTiers?: StockTier[];
  schedulePeriods?: SchedulePeriod[];
  formula?: string;
  // МРЦ
  mrcItems?: MrcItem[];
  /** Серверное состояние мониторинга МРЦ по ячейкам (ключ — MrcItem.key). Пишет и читает
   *  supabase/functions/mrc-scan; клиент — только для отображения paused-бейджа и ручного
   *  снятия паузы (см. MrcGrid/RepricerModule.clearMrcPause). */
  mrcState?: Record<string, MrcCellState>;
  createdAt: string;
  lastAppliedAt?: string;
  lastAppliedPrice?: number;
}

/** Унифицированный товар: один артикул на нескольких МП. */
export interface UnifiedProduct {
  vendorCode: string;
  title: string;
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

export interface PriceLog {
  id: string;
  ruleId: string;
  marketplace: Mp;
  storeId: string;
  storeName: string;
  productId: string;
  productTitle: string;
  oldPrice: number | null;
  newPrice: number;
  appliedAt: string;
  reason: string;
  /** true — эта запись сама является откатом другой записи (не откатывается повторно). */
  isRevert?: boolean;
}

// ── Display constants ─────────────────────────────────────────────────────────

export const MP_COLOR: Record<Mp, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };
export const MP_BG:    Record<Mp, string> = { wb: '#fdf0fb', ozon: '#eef4ff', yandex: '#fff5f3' };
export const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

export const RULE_LABELS: Record<RuleType, string> = {
  target:   'Фиксированная цена',
  margin:   'По марже (×)',
  stock:    'По остатку',
  schedule: 'По расписанию',
  formula:  'Формула',
  mrc:      'По МРЦ',
};

export const RULE_DESCRIPTIONS: Record<RuleType, string> = {
  target:   'Жёстко зафиксированная цена',
  margin:   'Себестоимость × множитель (например ×1.87)',
  stock:    'Разные цены при дефиците и при избытке',
  schedule: 'Цены меняются по дням недели',
  formula:  'Произвольная формула с переменными',
  mrc:      'Поддержание витринной цены (МРЦ) с учётом скидки маркетплейса',
};

// ── Repricer API timeout ──────────────────────────────────────────────────────

export const REPRICER_API_TIMEOUT_MS = 15_000; // 15 сек

// ── localStorage keys ─────────────────────────────────────────────────────────

export const LOG_KEY = 'repricer_log_v3';

// ── МРЦ ────────────────────────────────────────────────────────────────────────

/** Одна ячейка таблицы «товар × маркетплейс» для правила МРЦ. */
export interface MrcItem {
  key: string;          // стабильный идентификатор ячейки (uid())
  mp: Mp;
  storeId: string;
  storeName: string;
  productId: string;
  vendorCode: string;
  productTitle: string;
  mrcPrice: number;      // целевая витринная (МРЦ) цена, ₽
  enabled: boolean;      // включён ли мониторинг/автоприменение для этой ячейки
}

export type MrcScanAction = 'ok' | 'needs_update' | 'adjusted' | 'error';

/** Запись в журнале сканирования МРЦ. */
export interface MrcScanEntry {
  id: string;
  scannedAt: string;
  ruleId: string;
  itemKey: string;
  mp: Mp;
  storeName: string;
  productTitle: string;
  vendorCode: string;
  mrcPrice: number;
  sellerPrice: number;
  buyerPrice: number;
  action: MrcScanAction;
  /** Для action='needs_update' — цена продавца, которую нужно поставить, чтобы витрина совпала с МРЦ.
   *  Для action='adjusted' — фактически применённая цена продавца. */
  newPrice?: number;
  errorMsg?: string;
  /** true — применили новую цену, но витрина после всех итераций не сдвинулась к цели. */
  needsConfirm?: boolean;
  /** Номер итерации адаптивного подбора (0 = первое применение). */
  adjustIteration?: number;
  /** Ошибка проверки точной цены через расширение SimaDesk (если оно установлено). */
  extensionError?: string;
}

/** Реальная витринная цена (с учётом СПП/акций), собранная расширением SimaDesk
 *  с публичной страницы маркетплейса (таблицы wb_buyer_prices / ozon_buyer_prices / yandex_buyer_prices). */
export interface BuyerPriceInfo {
  price: number;
  checkedAt: string;
  marketSku: number | null;
  fresh: boolean;
}

/** Серверное состояние мониторинга одной ячейки МРЦ (supabase/functions/mrc-scan),
 *  хранится в RepricerRule.mrcState по ключу MrcItem.key. */
export interface MrcCellState {
  lastUpdateAt: string | null;
  /** Сколько раз подряд evaluateGate вернул safe_mode (данные не прошли валидацию). */
  consecutiveAnomalies: number;
  /** Сколько раз подряд данные были валидны — используется только для авто-выхода из paused. */
  consecutiveHealthy: number;
  /** true — автоматика остановлена для этой ячейки после нескольких аномалий подряд;
   *  снимается автоматически после MRC_HEALTHY_READS_TO_RESUME здоровых чтений подряд,
   *  либо вручную (см. RepricerModule.clearMrcPause). */
  paused: boolean;
  pausedReason?: string;
  pausedAt?: string;
}

// ── МРЦ: константы ───────────────────────────────────────────────────────────

export const MRC_MAX_CHANGE_PCT             = 0.20;            // ±20% за один цикл
export const MRC_DEVIATION_THRESHOLD        = 0.01;            // 1% — порог отклонения витрины от МРЦ
export const MRC_DEVIATION_MIN_RUB          = 5;               // минимальный порог отклонения в рублях
export const BUYER_PRICE_STALE_MS           = 6 * 3_600_000;  // 6 часов — после этого данные расширения считаются устаревшими
export const MRC_ANALYSIS_TIMEOUT_MS        = 15_000;          // тайм-аут одного запроса к API при анализе
export const WB_MRC_TIMEOUT_MS              = 60_000;          // WB: увеличен из-за rate-limit и ретраев
export const MRC_VERIFY_DELAY_MS            = 60_000;          // интервал между итерациями адаптивного подбора (1 мин)
export const MRC_MAX_ADJUST_ITERATIONS      = 5;               // максимум итераций адаптивного подбора на одно правило
export const MRC_PENDING_VERIFY_MAX_AGE_MS  = 24 * 3_600_000; // verify старше 24 часов — удаляем при старте
export const MRC_MAX_CONSECUTIVE_ANOMALIES  = 3;               // подряд safe_mode на сервере → пауза ячейки
export const MRC_HEALTHY_READS_TO_RESUME    = 3;               // подряд здоровых чтений на сервере → автоматический выход из паузы

// ── МРЦ: localStorage-ключи ─────────────────────────────────────────────────

export const MRC_SCAN_LOG_KEY        = 'repricer_mrc_scan_log_v1';
export const MRC_PENDING_VERIFY_KEY  = 'repricer_mrc_pending_verify_v1';

/** Запись о запланированном (но ещё не выполненном) verify — пережившем перезагрузку страницы. */
export interface PendingVerify {
  ruleId: string;
  itemKey: string;
  entryId: string;
  verifyAt: string; // ISO-дата — когда должен был сработать setTimeout
}
