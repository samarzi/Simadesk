import { dbFetch } from './dbClient';
import { companyService } from './companyService';

export interface StorefrontSettings {
  company_id: string;
  is_enabled: boolean;
  slug: string;
  store_name: string;
  tagline: string;
  telegram: string;
  whatsapp: string;
  website: string;
  created_at?: string;
  updated_at?: string;
}

export interface StorefrontProduct {
  source: 'wb' | 'ozon' | 'yandex';
  source_id: string;
  title: string;
  image: string | null;
  price: number;
  original_price: number;
  discount: number;
  stock: number;
  vendor_code: string;
  brand: string;
  is_hidden: boolean;
  custom_url: string;
  custom_price: number | null;
  sort_order: number;
}

export interface StorefrontBanner {
  id: string;
  company_id: string;
  image_url: string;
  link_url: string;
  sort_order: number;
  is_active: boolean;
  created_at?: string;
}

export const storefrontDb = {
  async get(companyId: string): Promise<StorefrontSettings | null> {
    const rows = await dbFetch<StorefrontSettings[]>(
      `storefront_settings?company_id=eq.${companyId}&limit=1`,
    );
    return rows?.[0] ?? null;
  },

  async save(settings: Partial<StorefrontSettings> & { company_id: string }): Promise<void> {
    await dbFetch('storefront_settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
  },

  async checkSlugAvailable(slug: string, excludeCompanyId?: string): Promise<boolean> {
    const rows = await dbFetch<any[]>(
      `storefront_settings?slug=eq.${encodeURIComponent(slug)}&select=company_id&limit=1`,
    );
    if (!rows || rows.length === 0) return true;
    if (excludeCompanyId && rows[0].company_id === excludeCompanyId) return true;
    return false;
  },

  async getProducts(companyId: string): Promise<StorefrontProduct[]> {
    const [wb, ozon, yandex] = await Promise.allSettled([
      dbFetch<any[]>(
        `wb_stores?company_id=eq.${companyId}&select=id,name,wb_products(nm_id,title,pictures,price,discount,stock_total,vendor_code,brand)`,
      ),
      dbFetch<any[]>(
        `ozon_stores?company_id=eq.${companyId}&select=id,name,ozon_products(product_id,name,images,price,old_price,stock_fbs,stock_fbo,offer_id)`,
      ),
      dbFetch<any[]>(
        `yandex_stores?company_id=eq.${companyId}&select=id,name,yandex_products(market_sku,name,pictures,basic_price,stock_total,vendor_code,vendor,archived)`,
      ),
    ]);

    const products: StorefrontProduct[] = [];

    if (wb.status === 'fulfilled' && wb.value) {
      for (const store of wb.value) {
        for (const p of (store.wb_products ?? [])) {
          products.push({
            source: 'wb',
            source_id: String(p.nm_id),
            title: p.title ?? '',
            image: Array.isArray(p.pictures) && p.pictures[0] ? p.pictures[0] : null,
            price: Math.round(p.price * (1 - (p.discount || 0) / 100)),
            original_price: p.price,
            discount: p.discount || 0,
            stock: p.stock_total || 0,
            vendor_code: p.vendor_code ?? '',
            brand: p.brand ?? '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
          });
        }
      }
    }

    if (ozon.status === 'fulfilled' && ozon.value) {
      for (const store of ozon.value) {
        for (const p of (store.ozon_products ?? [])) {
          const oldPrice = p.old_price || 0;
          products.push({
            source: 'ozon',
            source_id: String(p.product_id),
            title: p.name ?? '',
            image: Array.isArray(p.images) && p.images[0] ? p.images[0] : null,
            price: p.price,
            original_price: oldPrice > 0 ? oldPrice : p.price,
            discount: oldPrice > 0 && oldPrice > p.price ? Math.round((1 - p.price / oldPrice) * 100) : 0,
            stock: (p.stock_fbs || 0) + (p.stock_fbo || 0),
            vendor_code: p.offer_id ?? '',
            brand: '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
          });
        }
      }
    }

    if (yandex.status === 'fulfilled' && yandex.value) {
      for (const store of yandex.value) {
        for (const p of (store.yandex_products ?? [])) {
          if (p.archived) continue;
          products.push({
            source: 'yandex',
            source_id: String(p.market_sku),
            title: p.name ?? '',
            image: Array.isArray(p.pictures) && p.pictures[0] ? p.pictures[0] : null,
            price: p.basic_price,
            original_price: p.basic_price,
            discount: 0,
            stock: p.stock_total || 0,
            vendor_code: p.vendor_code ?? '',
            brand: p.vendor ?? '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
          });
        }
      }
    }

    return products;
  },

  async getOverrides(companyId: string): Promise<Map<string, { is_hidden: boolean; custom_url: string; sort_order: number; custom_price: number | null }>> {
    const rows = await dbFetch<any[]>(
      `storefront_product_overrides?company_id=eq.${companyId}&select=source,source_id,is_hidden,custom_url,sort_order,custom_price`,
    );
    const map = new Map<string, any>();
    for (const r of (rows ?? [])) {
      map.set(`${r.source}:${r.source_id}`, r);
    }
    return map;
  },

  async setOverride(
    companyId: string,
    source: string,
    sourceId: string,
    data: { is_hidden?: boolean; custom_url?: string; sort_order?: number; custom_price?: number | null },
  ): Promise<void> {
    await dbFetch('storefront_product_overrides', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, source, source_id: sourceId, ...data }),
    }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
  },

  // ── Banners ────────────────────────────────────────────────────────────────

  async getBanners(companyId: string): Promise<StorefrontBanner[]> {
    const rows = await dbFetch<StorefrontBanner[]>(
      `storefront_banners?company_id=eq.${companyId}&order=sort_order.asc,created_at.asc`,
    );
    return rows ?? [];
  },

  async addBanner(companyId: string, imageUrl: string, linkUrl: string, sortOrder = 0): Promise<void> {
    await dbFetch('storefront_banners', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        image_url: imageUrl,
        link_url: linkUrl || '/',
        sort_order: sortOrder,
        is_active: true,
      }),
    }, { 'Prefer': 'return=minimal' });
  },

  async deleteBanner(id: string): Promise<void> {
    await dbFetch(`storefront_banners?id=eq.${id}`, { method: 'DELETE' });
  },

  async updateBannerOrder(items: { id: string; sort_order: number }[]): Promise<void> {
    await Promise.all(items.map(({ id, sort_order }) =>
      dbFetch(`storefront_banners?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sort_order }),
      }, { 'Prefer': 'return=minimal' }),
    ));
  },

  async toggleBannerActive(id: string, isActive: boolean): Promise<void> {
    await dbFetch(`storefront_banners?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: isActive }),
    }, { 'Prefer': 'return=minimal' });
  },

  buildBuyUrl(source: 'wb' | 'ozon' | 'yandex', sourceId: string): string {
    switch (source) {
      case 'wb':     return `https://www.wildberries.ru/catalog/${sourceId}/detail.aspx`;
      case 'ozon':   return `https://www.ozon.ru/product/${sourceId}/`;
      case 'yandex': return `https://market.yandex.ru/product/${sourceId}`;
    }
  },

  slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[а-яёА-ЯЁ]/g, c => ({ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }[c] ?? c))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  },

  companyId(): string | null {
    return companyService.getActiveId();
  },
};
