/**
 * Типы для Wildberries.
 * API docs: https://dev.wildberries.ru/
 */

export interface WbStore {
  id: string;
  company_id?: string | null;
  name: string;
  api_key: string;           // JWT-токен (Authorization: <token>)
  feedback_api_key?: string | null; // отдельный токен со скоупом «Вопросы и отзывы» (для чатов и отзывов), если основной токен без него
  seller_id?: number | null;
  seller_name?: string | null;
  trademark?: string | null;
  tax_rate?: number | null;  // налоговая ставка % (УСН 6%, 15%, ОСН 20% и т.д.)
  tax_model?: string | null; // 'usn6' | 'usn15' | 'osn' | 'patent' | 'npd'
  fulfillment_model?: string | null; // 'FBW' | 'FBS' | 'DBS' | null (смешанный)
  created_at: string;
}

export interface WbProduct {
  store_id: string;
  nm_id: number;             // ID номенклатуры в WB
  imt_id?: number;
  vendor_code: string;       // артикул продавца
  brand?: string;
  title: string;
  subject?: string;
  pictures: string[];
  price?: number | null;
  discount?: number | null;
  stock_total?: number;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  created_at?: string;
  updated_at?: string;
  synced_at?: string;
}

export type WbOrderStatus =
  | 'new'         // 0 — новый
  | 'confirm'     // 1 — на сборке
  | 'complete'    // 2 — в доставке
  | 'cancel'      // 3 — отменён
  | 'arbitration' // 4 — арбитраж
  | 'unknown';

export interface WbOrderItem {
  nm_id: number;
  vendor_code: string;
  name: string;
  count: number;
  price: number;
  currency_code: string;
}

export interface WbOrder {
  id: number;
  srid?: string;        // UUID-идентификатор отправления (совпадает с posting_number в финотчёте)
  status: WbOrderStatus;
  status_raw?: number;
  created_at: string;
  warehouse_name?: string | null;
  delivery_address?: string | null;
  items: WbOrderItem[];
  total: number;
  currency_code: string;
  store_id: string;
  is_zero_order?: boolean;
}
