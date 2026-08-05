/**
 * Типы для управления поставками FBO/FBY
 */

export type SupplyStatus = 
  | 'draft'              // Черновик
  | 'created'            // Создана
  | 'awaiting_deliver'   // Ожидает отправки
  | 'delivering'         // В пути
  | 'delivered'          // Доставлена
  | 'accepted'           // Принята на склад
  | 'cancelled';         // Отменена

export interface BaseSupply {
  id: string;
  marketplace: 'ozon' | 'wb' | 'yandex';
  name: string;
  status: SupplyStatus;
  createdAt: string;
  updatedAt?: string;
  closedAt?: string;
}

export interface OzonSupply extends BaseSupply {
  marketplace: 'ozon';
  supplyOrderId: string;
  warehouseId: number;
  warehouseName?: string;
  items?: OzonSupplyItem[];
}

export interface OzonSupplyItem {
  sku: number;
  quantity: number;
  productId?: number;
  offerId?: string;
  name?: string;
}

export interface WbSupply extends BaseSupply {
  marketplace: 'wb';
  done: boolean;
  scanDt?: string;
  orderIds: number[];
  orderCount: number;
}

export interface YandexShipment extends BaseSupply {
  marketplace: 'yandex';
  shipmentId: number;
  externalId?: string;
  planIntervalFrom: string;
  planIntervalTo: string;
  orderIds?: number[];
}

export type Supply = OzonSupply | WbSupply | YandexShipment;

export interface SupplyItem {
  sku: string;
  name: string;
  quantity: number;
  barcode?: string;
  price?: number;
}

export interface SupplyCreationParams {
  marketplace: 'ozon' | 'wb' | 'yandex';
  name: string;
  warehouseId?: number; // Для Ozon
  planDates?: {         // Для Яндекс
    from: string;
    to: string;
  };
}

export interface SupplyBarcodeData {
  supplyId: string;
  barcodes: Array<{
    boxNumber: number;
    barcode: string;
    items: Array<{
      sku: string;
      quantity: number;
    }>;
  }>;
}

export interface SupplyStats {
  total: number;
  byStatus: Record<SupplyStatus, number>;
  byMarketplace: Record<'ozon' | 'wb' | 'yandex', number>;
  totalItems: number;
  lastCreated?: string;
}
