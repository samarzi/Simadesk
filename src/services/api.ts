import { Box, Sheet, Product } from '@/types';
import { debug } from '@/utils/debug';
import { dbFetch, dbFetchAll, getAuthHeaders, REST_URL } from './dbClient';
import { companyService } from './companyService';

class ApiService {
  private loadingCount = 0;
  private loadingListeners: ((loading: boolean) => void)[] = [];

  onLoadingChange(listener: (loading: boolean) => void) {
    this.loadingListeners.push(listener);
  }

  private setLoading(isLoading: boolean) {
    if (isLoading) this.loadingCount++;
    else this.loadingCount = Math.max(0, this.loadingCount - 1);
    const isLoadingNow = this.loadingCount > 0;
    this.loadingListeners.forEach(l => l(isLoadingNow));
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    this.setLoading(true);
    debug.api(options.method || 'GET', endpoint, options.body);
    try {
      return await dbFetch<T>(endpoint, options);
    } finally {
      this.setLoading(false);
    }
  }

  async fetchAll<T>(endpoint: string): Promise<T[]> {
    return dbFetchAll<T>(endpoint);
  }

  private cid(): string | null {
    return companyService.getActiveId();
  }

  // ── Boxes ──────────────────────────────────────────────────────────────────

  async getBoxes(): Promise<Box[]> {
    const cid = this.cid();
    if (!cid) return [];
    return this.request<Box[]>(`boxes?company_id=eq.${cid}&select=*&order=created_at.asc`);
  }

  async createBox(box: Omit<Box, 'id' | 'created_at'>): Promise<Box> {
    const cid = this.cid();
    const result = await this.request<Box[]>('boxes', {
      method: 'POST',
      body: JSON.stringify({ ...box, company_id: cid }),
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async updateBox(id: string, updates: Partial<Box>): Promise<Box> {
    const result = await this.request<Box[]>(`boxes?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async deleteBox(id: string): Promise<void> {
    await this.request(`boxes?id=eq.${id}`, { method: 'DELETE' });
  }

  async linkBoxToOzon(
    boxId: string,
    ozonStoreId: string | null,
    skuField = 'Артикул*',
    preferredStoreId: string | null = null,
  ): Promise<void> {
    await this.request(`boxes?id=eq.${boxId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ozon_store_id: ozonStoreId,
        ozon_sku_field: ozonStoreId ? skuField : null,
        ozon_preferred_store_id: ozonStoreId ? preferredStoreId : null,
      }),
    });
  }

  async getBoxCount(boxId: string): Promise<number> {
    const response = await fetch(
      `${REST_URL}/products?box_id=eq.${boxId}&select=id&limit=0`,
      { headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' } },
    );
    const count = response.headers.get('content-range')?.split('/')[1];
    return parseInt(count || '0');
  }

  // ── Products ───────────────────────────────────────────────────────────────

  async getProductsByBox(boxId: string): Promise<Product[]> {
    return this.fetchAll<Product>(`products?box_id=eq.${boxId}&select=*&order=created_at.asc`);
  }

  async streamProducts(
    boxId: string,
    onBatch: (batch: Product[]) => void,
    signal?: { cancelled: boolean },
  ): Promise<void> {
    const base = `products?box_id=eq.${boxId}&select=*&order=created_at.asc`;
    const limit = 1000;

    const [firstPage, countResp] = await Promise.all([
      this.request<Product[]>(`${base}&limit=${limit}&offset=0`),
      fetch(`${REST_URL}/${base}&limit=0`, {
        headers: { ...getAuthHeaders(), 'Prefer': 'count=exact' },
      }),
    ]);

    if (signal?.cancelled) return;
    onBatch(firstPage || []);

    const countStr = countResp.headers.get('content-range')?.split('/')[1];
    const total = parseInt(countStr || '0') || (firstPage || []).length;
    if (total <= limit) return;

    const pageCount = Math.ceil(total / limit);
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) =>
        this.request<Product[]>(`${base}&limit=${limit}&offset=${(i + 1) * limit}`),
      ),
    );
    if (signal?.cancelled) return;
    onBatch((rest as Product[][]).flat());
  }

  async getAllProducts(): Promise<Product[]> {
    const cid = this.cid();
    if (!cid) return [];
    // Products filtered via boxes that belong to this company
    return this.fetchAll<Product>(
      `products?select=*,boxes!inner(company_id)&boxes.company_id=eq.${cid}`,
    );
  }

  async createProduct(product: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product> {
    const result = await this.request<Product[]>('products', {
      method: 'POST',
      body: JSON.stringify(product),
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async createProductsBatch(prods: Omit<Product, 'id' | 'created_at' | 'updated_at'>[]): Promise<void> {
    for (let i = 0; i < prods.length; i += 100) {
      await this.request('products', {
        method: 'POST',
        body: JSON.stringify(prods.slice(i, i + 100)),
      });
    }
  }

  async updateProduct(id: string, updates: Partial<Product>): Promise<Product> {
    const result = await this.request<Product[]>(`products?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async deleteProduct(id: string): Promise<void> {
    await this.request(`products?id=eq.${id}`, { method: 'DELETE' });
  }

  async deleteProductsByBox(boxId: string): Promise<void> {
    await this.request(`products?box_id=eq.${boxId}`, { method: 'DELETE' });
  }

  async deleteProductsBySheet(sheetId: string): Promise<void> {
    await this.request(`products?sheet_id=eq.${sheetId}`, { method: 'DELETE' });
  }

  // ── Sheets ─────────────────────────────────────────────────────────────────

  async getSheetsByBox(boxId: string): Promise<Sheet[]> {
    return this.request<Sheet[]>(`sheets?box_id=eq.${boxId}&select=*&order=imported_at.asc`);
  }

  async createSheet(sheet: Omit<Sheet, 'id' | 'imported_at'>): Promise<Sheet> {
    const cid = this.cid();
    const result = await this.request<Sheet[]>('sheets', {
      method: 'POST',
      body: JSON.stringify({ ...sheet, company_id: cid }),
    });
    return Array.isArray(result) ? result[0] : result;
  }

  async deleteSheet(id: string): Promise<void> {
    await this.request(`sheets?id=eq.${id}`, { method: 'DELETE' });
  }
}

export const apiService = new ApiService();
