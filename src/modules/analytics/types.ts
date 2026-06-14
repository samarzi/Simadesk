/**
 * Типы новой Аналитики.
 * Единая модель Order = заказ с маркетплейса + связанные финансовые транзакции из mp_transactions.
 */

export type Mp = 'ozon' | 'wb' | 'yandex';

export const MP_LABEL: Record<Mp, string> = { ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс.Маркет' };
export const MP_SHORT: Record<Mp, string> = { ozon: 'Ozon', wb: 'WB', yandex: 'ЯМ' };
export const MP_COLOR: Record<Mp, string> = { ozon: '#4d9fff', wb: '#cb11ab', yandex: '#ffcc00' };

/** Универсальный статус заказа поверх МП-специфики. */
export type OrderStatus =
  | 'processing'      // в обработке / на сборке / новый
  | 'in_delivery'    // в доставке / в пути
  | 'delivered'      // доставлен / выкуплен
  | 'returned'       // возврат после доставки
  | 'cancelled'      // отменён до доставки
  | 'unknown';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  processing:  'В обработке',
  in_delivery: 'В доставке',
  delivered:   'Доставлен',
  returned:    'Возврат',
  cancelled:   'Отменён',
  unknown:     '—',
};

export const STATUS_COLOR: Record<OrderStatus, string> = {
  processing:  '#fbbf24',
  in_delivery: '#60a5fa',
  delivered:   '#22c55e',
  returned:    '#f87171',
  cancelled:   '#94a3b8',
  unknown:     '#64748b',
};

/** Откуда взяты цифры. Зелёный = реальный финотчёт МП. */
export type SourceQuality = 'real' | 'estimated' | 'missing';

export interface OrderItem {
  /** Артикул продавца (vendor_code / offer_id) — основной идентификатор для COGS. */
  vendor_code: string;
  /** SKU маркетплейса (внутренний — nm_id для WB, product_id/sku для Ozon, marketSku для ЯМ). Может быть пустым. */
  mp_sku: string;
  name: string;
  image?: string;
  quantity: number;
  /** Цена за единицу (после скидок, как клиент заплатил). */
  price: number;
  /** Выручка = price × quantity. */
  revenue: number;
  /** Себестоимость единицы (RUB, в базовой валюте). null = себестоимость не задана. */
  cost_price: number | null;
  /** COGS по позиции = cost_price × quantity (если есть). */
  cogs: number;
  /** Прибыль по позиции после распределения комиссии/логистики пропорционально выручке. */
  net_profit: number;
}

/** Удержание МП по типу — пришло из mp_transaction.services[] (если МП раскрывает разбивку). */
export interface FeeBreakdown {
  type: 'commission' | 'logistics' | 'logistics_return' | 'storage' | 'advertising' | 'penalty' | 'acquiring' | 'service' | 'other';
  label: string;
  amount: number;
}

export interface Order {
  /** Уникальный ключ: posting_number для Ozon/WB, id для ЯМ. */
  order_id: string;
  /** Дата заказа (ISO). */
  date: string;
  mp: Mp;
  store_id: string;
  store_name: string;
  status: OrderStatus;
  /** Сырой статус МП — для тултипа. */
  status_raw: string;
  items: OrderItem[];

  // ── Финансы (per-order, в RUB) ──
  revenue: number;
  /** Комиссия — реальная из финотчёта или 0 если ещё не пришла. */
  commission: number;
  /** Логистика прямая. */
  logistics: number;
  /** Логистика обратная (возвраты). */
  logistics_return: number;
  /** Все остальные удержания (хранение, штрафы, эквайринг, реклама и т.п.). */
  services: number;
  /** Разбивка удержаний по типу (для карточки заказа). */
  fee_breakdown: FeeBreakdown[];
  /** Сумма себестоимости товаров в заказе (Σ item.cogs). */
  cogs: number;
  /** Налог по заказу (рассчитан исходя из tax_model магазина). */
  tax: number;
  /** Чистая прибыль = revenue − commission − logistics − logistics_return − services − cogs − tax. */
  net_profit: number;
  /** Фактически выплачено (Σ tx.amount по этому posting). */
  payout_actual: number;

  /** Откуда взяты финансовые цифры. */
  source: SourceQuality;
  /** Сколько SKU в заказе без заданной себестоимости. */
  missing_cogs_count: number;
  /** Сырые транзакции связанные с этим заказом — для аудит-истории. */
  tx_ids: string[];
}

/** Свёрнутая аналитика по периоду. */
export interface KPI {
  // Доходы
  revenue: number;          // выручка нетто (revenue − returnsRevenue)
  revenue_gross: number;    // gross — без вычета возвратов
  returns_revenue: number;  // сумма возвратов
  // Расходы
  commission: number;
  logistics: number;
  services: number;
  cogs: number;
  tax: number;
  total_expenses: number;
  // Прибыль
  net_profit: number;
  margin_pct: number;        // net_profit / revenue × 100
  // Объёмы
  orders_delivered: number;
  orders_processing: number;
  orders_returned: number;
  orders_cancelled: number;
  units_sold: number;
  avg_check: number;
  // Качество данных
  source_real_pct: number;   // % заказов с реальными финданными
  missing_cogs_orders: number; // заказов с хотя бы одним SKU без себестоимости
}

export interface TimeseriesPoint {
  date: string;       // YYYY-MM-DD
  revenue: number;
  expenses: number;
  profit: number;
}

export interface SkuPerformance {
  vendor_code: string;
  mp: Mp;
  name: string;
  image?: string;
  units_sold: number;
  revenue: number;
  commission: number;
  logistics: number;
  cogs: number;
  net_profit: number;
  margin_pct: number;
  /** Кол-во заказов в которых встречался SKU. */
  orders_count: number;
}

/** Тип ручной записи расхода. */
export type ManualEntryType = 'advertising' | 'salary' | 'rent' | 'purchase' | 'tax' | 'other_expense' | 'other_income';

export interface ManualEntry {
  id: string;
  type: ManualEntryType;
  amount: number;            // в базовой валюте RUB
  currency: string;          // исходная валюта (для FX)
  amount_native: number;
  fx_rate: number;
  date: string;              // ISO
  mp?: Mp;
  store_id?: string;
  description: string;
  created_at: string;
}

export type TaxModel = 'usn6' | 'usn15' | 'osn' | 'npd' | 'patent' | 'none';

export const TAX_LABEL: Record<TaxModel, string> = {
  usn6:   'УСН 6%',
  usn15:  'УСН 15%',
  osn:    'ОСНО',
  npd:    'НПД',
  patent: 'Патент',
  none:   'Без налога',
};

/** Per-store настройки налога — переопределяют те что в ozon_stores/wb_stores/yandex_stores. */
export interface StoreTaxOverride {
  model: TaxModel;
  rate: number;              // 0.06 для 6%
}

export interface AnalyticsSettings {
  base_currency: string;
  fx_rates: Record<string, number>;
  /** Налог per-store (переопределяет stores.tax_model/rate). */
  store_tax: Record<string, StoreTaxOverride>;
  /** Глобальный fallback налог если store-настройки нет. */
  default_tax_model: TaxModel;
  default_tax_rate: number;
}

export interface StoreInfo {
  id: string;
  name: string;
  mp: Mp;
  tax_model: TaxModel;
  tax_rate: number;
  fulfillment: string | null;
  created_at?: string; // ISO — дата добавления магазина в систему
}

/** Один диапазон дат. */
export interface DateRange {
  start: Date;
  end: Date;
}

/** Период с пресетами. */
export type PeriodPreset = '7' | '30' | '90' | '180' | '365' | 'all' | 'custom';
