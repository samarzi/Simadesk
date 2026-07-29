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
  phone?: string;
  website: string;
  logo_url?: string | null;
  show_price_filter: boolean;
  show_brand_filter: boolean;
  show_category_filter: boolean;
  show_stock: boolean;
  hide_out_of_stock: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface StorefrontGroup {
  id: string;
  company_id: string;
  name: string;
  cover_url: string;
  sort_order: number;
  vendor_codes?: string[];
  created_at?: string;
}

export interface StorefrontVariantItem {
  vendor_code: string;
  label: string;
  color: string;
  sort_order: number;
}

export interface StorefrontVariantGroup {
  id: string;
  company_id?: string;
  sort_order: number;
  items: StorefrontVariantItem[];
  created_at?: string;
}

export interface StorefrontProduct {
  source: 'wb' | 'ozon' | 'yandex';
  source_id: string;
  title: string;
  image: string | null;
  images: string[];
  price: number;
  original_price: number;
  discount: number;
  vendor_code: string;
  brand: string;
  category: string;
  is_hidden: boolean;
  custom_url: string;
  custom_price: number | null;
  sort_order: number;
  ozon_sku: number | null;
  yandex_market_model_id: number | null;
  stock: number;
  custom_title?: string;
}

export interface StorefrontBanner {
  id: string;
  company_id: string;
  title?: string;
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
        `wb_stores?company_id=eq.${companyId}&select=id,wb_products(nm_id,title,pictures,price,discount,vendor_code,brand,subject,stock_total)`,
      ),
      dbFetch<any[]>(
        `ozon_stores?company_id=eq.${companyId}&select=id,ozon_products(product_id,sku,name,images,price,old_price,offer_id,category,stock_fbs,stock_fbo)`,
      ),
      dbFetch<any[]>(
        `yandex_stores?company_id=eq.${companyId}&select=id,yandex_products(market_sku,market_model_id,name,pictures,basic_price,offer_id,vendor_code,vendor,archived,category_name,stock_total,stock_available)`,
      ),
    ]);

    const products: StorefrontProduct[] = [];

    if (wb.status === 'fulfilled' && wb.value) {
      for (const store of wb.value) {
        for (const p of (store.wb_products ?? [])) {
          const pics: string[] = Array.isArray(p.pictures) ? p.pictures.filter(Boolean) : [];
          products.push({
            source: 'wb',
            source_id: String(p.nm_id),
            title: p.title ?? '',
            image: pics[0] ?? null,
            images: pics,
            price: Math.round(p.price * (1 - (p.discount || 0) / 100)),
            original_price: p.price,
            discount: p.discount || 0,
            vendor_code: p.vendor_code ?? '',
            brand: p.brand ?? '',
            category: p.subject ?? '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
            ozon_sku: null,
            yandex_market_model_id: null,
            stock: p.stock_total ?? 0,
          });
        }
      }
    }

    if (ozon.status === 'fulfilled' && ozon.value) {
      for (const store of ozon.value) {
        for (const p of (store.ozon_products ?? [])) {
          const pics: string[] = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
          const oldPrice = p.old_price || 0;
          products.push({
            source: 'ozon',
            source_id: String(p.product_id),
            title: p.name ?? '',
            image: pics[0] ?? null,
            images: pics,
            price: p.price,
            original_price: oldPrice > 0 ? oldPrice : p.price,
            discount: oldPrice > 0 && oldPrice > p.price ? Math.round((1 - p.price / oldPrice) * 100) : 0,
            vendor_code: p.offer_id ?? '',
            brand: '',
            category: p.category ?? '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
            ozon_sku: p.sku ? Number(p.sku) : null,
            yandex_market_model_id: null,
            stock: (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0),
          });
        }
      }
    }

    if (yandex.status === 'fulfilled' && yandex.value) {
      for (const store of yandex.value) {
        for (const p of (store.yandex_products ?? [])) {
          if (p.archived) continue;
          const pics: string[] = Array.isArray(p.pictures) ? p.pictures.filter(Boolean) : [];
          products.push({
            source: 'yandex',
            source_id: String(p.market_sku),
            title: p.name ?? '',
            image: pics[0] ?? null,
            images: pics,
            price: p.basic_price,
            original_price: p.basic_price,
            discount: 0,
            vendor_code: (p.vendor_code && p.vendor_code.trim()) || p.offer_id || '',
            brand: p.vendor ?? '',
            category: p.category_name ?? '',
            is_hidden: false,
            custom_url: '',
            custom_price: null,
            sort_order: 0,
            ozon_sku: null,
            yandex_market_model_id: p.market_model_id ? Number(p.market_model_id) : null,
            stock: p.stock_available ?? p.stock_total ?? 0,
          });
        }
      }
    }

    return products;
  },

  async getOverrides(companyId: string): Promise<Map<string, { is_hidden: boolean; custom_url: string; sort_order: number; custom_price: number | null; custom_title: string }>> {
    const rows = await dbFetch<any[]>(
      `storefront_product_overrides?company_id=eq.${companyId}&select=source,source_id,is_hidden,custom_url,sort_order,custom_price,custom_title`,
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
    data: { is_hidden?: boolean; custom_url?: string; sort_order?: number; custom_price?: number | null; custom_title?: string },
  ): Promise<void> {
    await dbFetch('storefront_product_overrides', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, source, source_id: sourceId, ...data }),
    }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
  },

  async uploadGroupImage(file: File, companyId: string): Promise<string> {
    return storefrontDb._uploadStorageFile(file, `${companyId}/groups/${Date.now()}`);
  },

  async uploadLogoImage(file: File, companyId: string): Promise<string> {
    return storefrontDb._uploadStorageFile(file, `${companyId}/logo`);
  },

  async _uploadStorageFile(file: File, pathNoExt: string): Promise<string> {
    const { authService } = await import('./authService');
    const token = authService.getAccessToken();
    const apiUrl = import.meta.env.VITE_API_URL as string;
    const apiKey = import.meta.env.VITE_API_KEY as string;
    const rawExt = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const safeExt = ['jpg','jpeg','png','webp','gif'].includes(rawExt) ? rawExt : 'jpg';
    const path = `${pathNoExt}.${safeExt}`;
    const res = await fetch(`${apiUrl}/storage/v1/object/storefront-banners/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token ?? apiKey}`,
        'apikey': apiKey,
        'Content-Type': file.type || 'image/jpeg',
        'x-upsert': 'true',
      },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { message?: string }).message || `Upload failed: ${res.status}`);
    }
    return `${apiUrl}/storage/v1/object/public/storefront-banners/${path}`;
  },

  // ── Banners ────────────────────────────────────────────────────────────────

  async getBanners(companyId: string): Promise<StorefrontBanner[]> {
    const rows = await dbFetch<StorefrontBanner[]>(
      `storefront_banners?company_id=eq.${companyId}&order=sort_order.asc,created_at.asc`,
    );
    return rows ?? [];
  },

  async addBanner(companyId: string, imageUrl: string, linkUrl: string, sortOrder = 0, title = ''): Promise<void> {
    await dbFetch('storefront_banners', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        title: title || null,
        image_url: imageUrl,
        link_url: linkUrl || '/',
        sort_order: sortOrder,
        is_active: true,
      }),
    }, { 'Prefer': 'return=minimal' });
  },

  async updateBanner(id: string, data: { title?: string; image_url?: string; link_url?: string }): Promise<void> {
    await dbFetch(`storefront_banners?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
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

  async uploadBannerImage(file: File, companyId: string): Promise<string> {
    const { authService } = await import('./authService');
    const token = authService.getAccessToken();
    const apiUrl = import.meta.env.VITE_API_URL as string;
    const apiKey = import.meta.env.VITE_API_KEY as string;
    const rawExt = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const safeExt = ['jpg','jpeg','png','webp','gif'].includes(rawExt) ? rawExt : 'jpg';
    const path = `${companyId}/${Date.now()}.${safeExt}`;
    const res = await fetch(`${apiUrl}/storage/v1/object/storefront-banners/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token ?? apiKey}`,
        'apikey': apiKey,
        'Content-Type': file.type || 'image/jpeg',
        'x-upsert': 'true',
      },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { message?: string }).message || `Upload failed: ${res.status}`);
    }
    return `${apiUrl}/storage/v1/object/public/storefront-banners/${path}`;
  },

  // ── Groups ────────────────────────────────────────────────────────────────

  async getGroups(companyId: string): Promise<StorefrontGroup[]> {
    const rows = await dbFetch<StorefrontGroup[]>(
      `storefront_groups?company_id=eq.${companyId}&order=sort_order.asc,created_at.asc`,
    );
    return rows ?? [];
  },

  async addGroup(companyId: string, name: string, coverUrl = '', sortOrder = 0): Promise<StorefrontGroup> {
    const rows = await dbFetch<StorefrontGroup[]>('storefront_groups', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, name, cover_url: coverUrl, sort_order: sortOrder }),
    }, { 'Prefer': 'return=representation' });
    return rows[0];
  },

  async updateGroup(id: string, data: { name?: string; cover_url?: string }): Promise<void> {
    await dbFetch(`storefront_groups?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { 'Prefer': 'return=minimal' });
  },

  async deleteGroup(id: string): Promise<void> {
    await dbFetch(`storefront_groups?id=eq.${id}`, { method: 'DELETE' });
  },

  async updateGroupOrder(items: { id: string; sort_order: number }[]): Promise<void> {
    await Promise.all(items.map(({ id, sort_order }) =>
      dbFetch(`storefront_groups?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ sort_order }),
      }, { 'Prefer': 'return=minimal' }),
    ));
  },

  async getGroupItems(groupId: string): Promise<string[]> {
    const rows = await dbFetch<{ vendor_code: string }[]>(
      `storefront_group_items?group_id=eq.${groupId}&select=vendor_code`,
    );
    return (rows ?? []).map(r => r.vendor_code);
  },

  async setProductGroup(companyId: string, vendorCode: string, groupId: string | null): Promise<void> {
    // Remove from any current group belonging to this company
    const groups = await dbFetch<{ id: string }[]>(
      `storefront_groups?company_id=eq.${companyId}&select=id`,
    );
    const ids = (groups ?? []).map(g => g.id);
    if (ids.length > 0) {
      await dbFetch(
        `storefront_group_items?group_id=in.(${ids.join(',')})&vendor_code=eq.${encodeURIComponent(vendorCode)}`,
        { method: 'DELETE' },
      );
    }
    if (groupId) {
      await dbFetch('storefront_group_items', {
        method: 'POST',
        body: JSON.stringify({ group_id: groupId, vendor_code: vendorCode }),
      }, { 'Prefer': 'return=minimal' });
    }
  },

  async getAllGroupItems(companyId: string): Promise<Map<string, string>> {
    const groups = await dbFetch<{ id: string }[]>(
      `storefront_groups?company_id=eq.${companyId}&select=id`,
    );
    const ids = (groups ?? []).map(g => g.id);
    if (!ids.length) return new Map();
    const rows = await dbFetch<{ group_id: string; vendor_code: string }[]>(
      `storefront_group_items?group_id=in.(${ids.join(',')})&select=group_id,vendor_code`,
    );
    const map = new Map<string, string>(); // vendor_code → group_id
    for (const r of (rows ?? [])) map.set(r.vendor_code, r.group_id);
    return map;
  },

  // ── Variant Groups ────────────────────────────────────────────────────────

  async getVariantGroups(companyId: string): Promise<StorefrontVariantGroup[]> {
    const groups = await dbFetch<StorefrontVariantGroup[]>(
      `storefront_variant_groups?company_id=eq.${companyId}&order=sort_order.asc,created_at.asc`,
    );
    if (!groups?.length) return [];
    const ids = groups.map(g => g.id);
    const items = await dbFetch<(StorefrontVariantItem & { variant_group_id: string })[]>(
      `storefront_variant_items?variant_group_id=in.(${ids.join(',')})&order=sort_order.asc`,
    );
    const byGroup = new Map<string, StorefrontVariantItem[]>();
    for (const it of (items ?? [])) {
      if (!byGroup.has(it.variant_group_id)) byGroup.set(it.variant_group_id, []);
      byGroup.get(it.variant_group_id)!.push(it);
    }
    return groups.map(g => ({ ...g, items: byGroup.get(g.id) ?? [] }));
  },

  async addVariantGroup(companyId: string, items: StorefrontVariantItem[], sortOrder = 0): Promise<string> {
    const rows = await dbFetch<{ id: string }[]>('storefront_variant_groups', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, sort_order: sortOrder }),
    }, { 'Prefer': 'return=representation' });
    const gid = rows[0].id;
    if (items.length) {
      await dbFetch('storefront_variant_items', {
        method: 'POST',
        body: JSON.stringify(items.map((it, i) => ({ variant_group_id: gid, vendor_code: it.vendor_code, label: it.label, color: it.color, sort_order: i }))),
      }, { 'Prefer': 'return=minimal' });
    }
    return gid;
  },

  async updateVariantGroup(groupId: string, items: StorefrontVariantItem[]): Promise<void> {
    await dbFetch(`storefront_variant_items?variant_group_id=eq.${groupId}`, { method: 'DELETE' });
    if (items.length) {
      await dbFetch('storefront_variant_items', {
        method: 'POST',
        body: JSON.stringify(items.map((it, i) => ({ variant_group_id: groupId, vendor_code: it.vendor_code, label: it.label, color: it.color, sort_order: i }))),
      }, { 'Prefer': 'return=minimal' });
    }
  },

  async deleteVariantGroup(id: string): Promise<void> {
    await dbFetch(`storefront_variant_groups?id=eq.${id}`, { method: 'DELETE' });
  },

  buildBuyUrl(p: StorefrontProduct): string {
    if (p.source === 'wb')     return `https://www.wildberries.ru/catalog/${p.source_id}/detail.aspx`;
    if (p.source === 'ozon')   return p.ozon_sku ? `https://www.ozon.ru/product/${p.ozon_sku}/` : `https://www.ozon.ru/product/${p.source_id}/`;
    if (p.source === 'yandex') {
      if (p.yandex_market_model_id) return `https://market.yandex.ru/product/${p.yandex_market_model_id}?sku=${p.source_id}`;
      return `https://market.yandex.ru/search?text=${p.source_id}`;
    }
    return '#';
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
