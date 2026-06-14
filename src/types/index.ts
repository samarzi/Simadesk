/** Все страницы/разделы приложения, доступные через navigateTo(). */
export type AppPage =
  | 'home' | 'products' | 'analytics' | 'settings-hub' | 'settings' | 'profile' | 'orders' | 'marketplaces'
  | 'ozon' | 'yandex' | 'wb'
  | 'orders-ozon' | 'orders-yandex' | 'orders-wb'
  | 'repricer' | 'stock' | 'catalog' | 'producers'
  | 'sku-audit' | 'reviews' | 'chats' | 'logs' | 'automation' | 'tasks';

export interface Box {
  id: string;
  name: string;
  sticker: string;
  created_at: string;
  /** ID магазина Ozon к которому привязана эта группа (null = не привязана) */
  ozon_store_id?: string | null;
  /** Артикул-поле для сверки при связке (по умолчанию "Артикул*") */
  ozon_sku_field?: string | null;
  /** Предпочтительный магазин для синхронизации данных (цены, названия и т.д.) */
  ozon_preferred_store_id?: string | null;
  /** Я.Маркет: группа привязана к синхронизации (true) */
  ym_linked?: boolean | null;
  /** Я.Маркет: поле артикула для сверки */
  ym_sku_field?: string | null;
  /** WB: группа привязана к синхронизации (true) */
  wb_linked?: boolean | null;
  /** WB: поле артикула для сверки */
  wb_sku_field?: string | null;
  /** Источник автосинхронизации: 'ozon' | 'ym' (null = ручная группа, создана вручную/xlsx) */
  mp_source?: 'ozon' | 'ym' | null;
  /** ID магазина маркетплейса (для нахождения группы при повторной синхронизации) */
  mp_store_id?: string | null;
  /** Дата последней автосинхронизации */
  mp_last_sync?: string | null;
}

export interface Sheet {
  id: string;
  box_id: string;
  filename: string;
  columns: string[];
  imported_at: string;
  template_headers?: any[][];
  template_file_b64?: string;
}

export interface Product {
  id: string;
  box_id: string;
  sheet_id: string;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface ImportPreview {
  columns: string[];
  rows: any[][];
  selectedColumns: Set<string>;
  selectedRows: Set<number>;
}

export interface FilterState {
  priceFrom?: number;
  priceTo?: number;
  sortBy?: 'asc' | 'desc';
  dynamicFilters: Record<string, Set<string>>;
}

export interface AppState {
  boxes: Box[];
  currentBox: Box | null;
  products: Product[];
  filteredProducts: Product[];
  viewMode: 'table' | 'cards';
  searchQuery: string;
  filters: FilterState;
  loading: boolean;
  error: string | null;
}

export interface PaginationState {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface VirtualListConfig {
  itemHeight: number;
  containerHeight: number;
  overscan: number;
  threshold: number;
}
