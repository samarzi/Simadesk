/** Типы «Управления карточками» — общие с разделом «Товары». */

export type Mp = 'ozon' | 'wb' | 'yandex';

export interface BulkEntry {
  mp: Mp;
  store_id: string;
  store_name: string;
  price: number | null;
  old_price: number | null;
  status: string | null;
  vat: string;
}

export interface BulkProduct {
  article: string;
  name: string;
  cost_price: number | null;
  mp_entries: BulkEntry[];
}

/** Изменения карточки для отправки в магазин: только заданные поля. */
export interface CardChanges {
  name?: string; brand?: string; barcode?: string; description?: string; vat?: string;
  price?: number; old_price?: number | null; min_price?: number | null; discount?: number;
  weight_kg?: number | null; length_cm?: number | null; width_cm?: number | null; height_cm?: number | null;
}

export interface PriceRow { article: string; price: number; old_price?: number | null; min_price?: number | null; discount?: number }

/** Что «Управлению карточками» нужно от раздела «Товары». */
export interface BulkHost {
  rawProd(mp: Mp, storeId: string, article: string): any;
  isPriceLocked(article: string, mp: Mp): boolean;
  pushCardChanges(article: string, storeId: string, mp: Mp, ch: CardChanges): Promise<string>;
  pushPricesBatch(storeId: string, mp: Mp, rows: PriceRow[]): Promise<Map<string, string | null>>;
  pushArchive(storeId: string, mp: Mp, articles: string[], archived: boolean): Promise<Map<string, string | null>>;
  setCostValue(article: string, value: number): Promise<void>;
  afterBulk(): void;
}
