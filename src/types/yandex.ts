/**
 * Типы для Яндекс Маркета.
 * API docs: https://yandex.ru/dev/market/partner-api/doc/ru
 */

export interface YandexStore {
  id: string;
  company_id?: string | null;
  name: string;
  api_key: string;             // Api-Key токен из кабинета продавца
  business_id: number | null;  // ID бизнеса (для нового API заказов)
  campaign_id: number | null;  // ID магазина-кампании
  placement_type?: 'FBS' | 'FBY' | 'DBS' | 'LAAS';
  tax_rate?: number | null;    // налоговая ставка %
  tax_model?: string | null;   // 'usn6' | 'usn15' | 'osn' | 'patent' | 'npd'
  fulfillment_model?: string | null; // 'FBY' | 'FBS' | 'DBS' | null (смешанный)
  created_at: string;
}

export type YandexOrderStatus =
  | 'CANCELLED'
  | 'DELIVERED'
  | 'DELIVERY'
  | 'PARTIALLY_DELIVERED'
  | 'PARTIALLY_RETURNED'
  | 'PICKUP'
  | 'PROCESSING'
  | 'RESERVED'
  | 'RETURNED'
  | 'UNPAID';

export interface YandexOrderItem {
  offer_id: string;
  name: string;
  count: number;
  price: number;
  currency_code: string;
}

export interface YandexOrder {
  id: number;
  status: YandexOrderStatus;
  substatus?: string | null;
  creation_date: string;          // ISO
  delivery_date?: string | null;
  items: YandexOrderItem[];
  total: number;
  currency_code: string;
  store_id: string;
  delivery_type?: string;         // DELIVERY / PICKUP / DIGITAL
  delivery_region?: string | null;
  buyer_total?: number | null;
}

/** Товар (offer) в кабинете Я.Маркета. */
export interface YandexProduct {
  store_id: string;
  offer_id: string;             // SKU продавца
  name: string;
  vendor?: string;              // бренд
  vendor_code?: string;         // артикул производителя
  pictures: string[];
  basic_price?: number | null;
  basic_currency?: string;
  market_sku?: number | null;   // SKU маркета
  market_model_id?: number | null; // ID модели маркета (для ссылки на карточку)
  category_id?: number | null;
  category_name?: string;
  archived?: boolean;
  stock_total?: number;         // суммарный остаток
  stock_available?: number;     // FIT + AVAILABLE
  synced_at?: string;
  // Габариты (заполняются при синхронизации через getOfferMappings)
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?:  number | null;
  height_cm?: number | null;
}
