export interface OzonStore {
  id: string;
  company_id?: string | null;
  name: string;
  client_id: string;
  api_key: string;
  tax_rate?: number | null;  // налоговая ставка %
  tax_model?: string | null; // 'usn6' | 'usn15' | 'osn' | 'patent' | 'npd'
  fulfillment_model?: string | null; // 'FBO' | 'FBS' | 'rFBS' | null (смешанный)
  created_at: string;
}

export interface OzonProduct {
  id: string;
  store_id: string;
  offer_id: string;
  product_id: number | null;
  sku: number | null;          // Ozon internal FBO/FBS SKU (для маппинга транзакций)
  name: string;
  price: number;
  old_price: number;
  min_price: number;
  marketing_price?: number | null;  // цена на витрине Ozon с учётом акций самого Ozon
  stock_fbs: number;
  stock_fbo: number;
  category: string;
  images: string[];
  barcode: string;
  status: string;
  synced_at: string;
  type_id?: number;
  description_category_id?: number;
  // Дополнительные поля (заполняются при синхронизации)
  vat?: string;
  description?: string;
  // Габариты (заполняются при синхронизации через getProductInfo)
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?:  number | null;
  height_cm?: number | null;
}

export interface OzonProductGroup {
  offer_id: string;
  name: string;
  images: string[];
  category: string;
  stores: Map<string, OzonProduct>;
}

export interface OzonWarehouse {
  warehouse_id: number;
  name: string;
}

export type DeliveryScheme = 'fbo' | 'fbs' | 'rfbs';

export type OzonPostingStatus =
  | 'awaiting_packaging'
  | 'awaiting_deliver'
  | 'delivering'
  | 'delivered'
  | 'cancelled'
  | 'arbitration'
  | 'not_accepted'
  | 'sent_by_seller';

export interface OzonPostingProduct {
  offer_id: string;
  name: string;
  quantity: number;
  price: string;
  currency_code: string;
}

export interface OzonPosting {
  posting_number: string;
  status: OzonPostingStatus;
  delivery_scheme: DeliveryScheme;
  created_at: string;
  shipment_date: string | null;
  products: OzonPostingProduct[];
  store_id: string;
  // Опциональные поля
  in_process_at?: string | null;
  delivering_date?: string | null;
  warehouse_id?: number | null;
  customer_address?: string | null;
  tracking_number?: string | null;
  region?: string | null;
}

export interface OzonReturn {
  id: number;
  status: string;
  posting_number: string;
  created_at: string;
  products: OzonPostingProduct[];
  reason_name?: string;
}

export interface OrderFilters {
  status: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}
