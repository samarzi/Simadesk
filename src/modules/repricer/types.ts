/** Shared types for the Repricer module family. */

export type Mp = 'wb' | 'ozon' | 'yandex';
export type RuleType = 'target' | 'margin' | 'stock' | 'schedule' | 'formula';
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
  storeName: string;
  productTitle: string;
  oldPrice: number | null;
  newPrice: number;
  appliedAt: string;
  reason: string;
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
};

export const RULE_DESCRIPTIONS: Record<RuleType, string> = {
  target:   'Жёстко зафиксированная цена',
  margin:   'Себестоимость × множитель (например ×1.87)',
  stock:    'Разные цены при дефиците и при избытке',
  schedule: 'Цены меняются по дням недели',
  formula:  'Произвольная формула с переменными',
};

// ── Repricer API timeout ──────────────────────────────────────────────────────

export const REPRICER_API_TIMEOUT_MS = 15_000; // 15 сек

// ── localStorage keys ─────────────────────────────────────────────────────────

export const LOG_KEY = 'repricer_log_v3';
