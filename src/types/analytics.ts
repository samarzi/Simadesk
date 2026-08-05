/**
 * Типы для модуля аналитики маркетплейсов
 */

export interface BaseAnalytics {
  period: {
    from: string; // YYYY-MM-DD
    to: string;
  };
  marketplace: 'ozon' | 'wb' | 'yandex';
}

export interface ProductAnalytics extends BaseAnalytics {
  offerId: string;
  productName: string;
  sku?: string;
  
  // Метрики трафика
  views: number;           // Просмотры
  uniqueViews?: number;    // Уникальные просмотры
  clicks: number;          // Клики
  addToCart: number;       // Добавления в корзину
  addToFavorites?: number; // Добавления в избранное
  
  // Метрики продаж
  orders: number;          // Заказов
  orderedUnits: number;    // Единиц заказано
  revenue: number;         // Выручка
  
  // Конверсии
  ctr: number;             // Click-through rate (%)
  cartConversion: number;  // Views → Cart (%)
  orderConversion: number; // Clicks → Orders (%)
  
  // Средние значения
  avgPrice: number;
  avgOrderValue?: number;
  
  // Дополнительно
  returns?: number;
  returnRate?: number;
  rating?: number;
  reviewCount?: number;
}

export interface OzonAnalyticsRaw {
  dimensions: Array<{ id: string; value: string }>;
  metrics: Array<{ id: string; value: number }>;
}

export interface WbSalesAnalyticsRaw {
  date: string;
  lastChangeDate: string;
  supplierArticle: string;
  techSize: string;
  barcode: string;
  totalPrice: number;
  discountPercent: number;
  isSupply: boolean;
  isRealization: boolean;
  promoCodeDiscount: number;
  warehouseName: string;
  countryName: string;
  oblastOkrugName: string;
  regionName: string;
  incomeID: number;
  saleID: string;
  odid: number;
  spp: number;
  forPay: number;
  finishedPrice: number;
  priceWithDisc: number;
  nmId: number;
  subject: string;
  category: string;
  brand: string;
  IsStorno: number;
  gNumber: string;
  sticker: string;
}

export interface YandexSkuStats {
  shopSku: string;
  offerName?: string;
  clicks: number;
  shows: number;
  orders: number;
  revenue?: number;
  ctr?: number;
  conversionRate?: number;
}

export interface MarketplaceComparison {
  marketplace: 'ozon' | 'wb' | 'yandex';
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  conversionRate: number;
  topProducts: Array<{
    offerId: string;
    name: string;
    revenue: number;
    orders: number;
  }>;
}

export interface AnalyticsDashboard {
  period: {
    from: string;
    to: string;
  };
  summary: {
    totalRevenue: number;
    totalOrders: number;
    totalViews: number;
    avgConversion: number;
  };
  byMarketplace: MarketplaceComparison[];
  topProducts: ProductAnalytics[];
  worstProducts: ProductAnalytics[];
}
