/**
 * producerDb — CRUD для раздела «Производители».
 * Все таблицы привязаны к company_id и защищены RLS.
 */

import { supaFetch, supaFetchAll } from './supabaseClient';
import { companyService } from './companyService';

// ── Types ────────────────────────────────────────────────────────────────────

export type ProducerWorkflow = 'consignment' | 'supply' | 'both';
export type ProducerOutputType = 'new' | 'template';

export interface TemplateConfig {
  article_column: string;   // например 'A'
  name_column: string;
  qty_column: string;
  start_row: number;
}
export interface OutputConfig {
  show_article: boolean;
  show_name: boolean;
  qty_column: string;       // например 'C'
}

export interface Producer {
  id: string;
  company_id: string;
  name: string;
  prefix: string;
  workflow: ProducerWorkflow;
  output_type: ProducerOutputType;
  template_url: string | null;
  template_config: TemplateConfig | null;
  output_config: OutputConfig | null;
  contacts: string | null;
  created_at: string;
  updated_at: string;
}

export type ProducerFieldType = 'text' | 'number' | 'mixed' | 'dropdown';

export interface ProducerFieldDef {
  id: string;
  company_id: string;
  name: string;
  field_type: ProducerFieldType;
  dropdown_options: string[] | null;
  is_locked: boolean;
  show_in_filters: boolean;
  sort_order: number;
  created_at: string;
}

export interface ProducerProduct {
  id: string;
  company_id: string;
  producer_id: string;
  name: string;
  articles: string[];
  internal_id: number | null;
  field_values: Record<string, string>;
  comment: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProducerMapping {
  id: string;
  company_id: string;
  marketplace_article: string;
  producer_product_id: string;
  quantity: number;
  created_at: string;
}

export interface ProducerOrder {
  id: string;
  company_id: string;
  external_id: string | null;
  marketplace_article: string;
  product_name: string;
  quantity: number;
  status: 'new' | 'accepted' | 'done' | 'cancelled';
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProducerDocument {
  id: string;
  company_id: string;
  producer_id: string | null;
  doc_type: 'consignment' | 'supply' | 'template';
  file_url: string | null;
  file_name: string | null;
  items: Array<{ article: string; name: string; quantity: number }>;
  order_ids: string[];
  total_qty: number;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cid(): string {
  const id = companyService.getActiveId();
  if (!id) throw new Error('Не выбрана компания');
  return id;
}
function first<T>(r: T | T[]): T { return Array.isArray(r) ? r[0] : r; }

// ── Producers ───────────────────────────────────────────────────────────────

export const producerDb = {
  async list(): Promise<Producer[]> {
    return supaFetch<Producer[]>(
      `producers?company_id=eq.${cid()}&order=name.asc`,
      { method: 'GET' },
    );
  },

  async create(p: Omit<Producer, 'id' | 'company_id' | 'created_at' | 'updated_at'>): Promise<Producer> {
    const r = await supaFetch<Producer | Producer[]>('producers', {
      method: 'POST',
      body: JSON.stringify({ ...p, company_id: cid() }),
    });
    return first(r);
  },

  async update(id: string, patch: Partial<Producer>): Promise<Producer> {
    const r = await supaFetch<Producer | Producer[]>(
      `producers?id=eq.${id}&company_id=eq.${cid()}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return first(r);
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producers?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },
};

// ── Field defs ──────────────────────────────────────────────────────────────

export const producerFieldDb = {
  async list(): Promise<ProducerFieldDef[]> {
    return supaFetch<ProducerFieldDef[]>(
      `producer_field_defs?company_id=eq.${cid()}&order=sort_order.asc`,
      { method: 'GET' },
    );
  },

  async create(f: Omit<ProducerFieldDef, 'id' | 'company_id' | 'created_at'>): Promise<ProducerFieldDef> {
    const r = await supaFetch<ProducerFieldDef | ProducerFieldDef[]>('producer_field_defs', {
      method: 'POST',
      body: JSON.stringify({ ...f, company_id: cid() }),
    });
    return first(r);
  },

  async update(id: string, patch: Partial<ProducerFieldDef>): Promise<ProducerFieldDef> {
    const r = await supaFetch<ProducerFieldDef | ProducerFieldDef[]>(
      `producer_field_defs?id=eq.${id}&company_id=eq.${cid()}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return first(r);
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producer_field_defs?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },

  /** Гарантирует наличие системного поля «Себестоимость». */
  async ensureSystemFields(): Promise<void> {
    const existing = await this.list();
    if (!existing.some(f => f.name === 'Себестоимость')) {
      await this.create({
        name: 'Себестоимость',
        field_type: 'number',
        dropdown_options: null,
        is_locked: true,
        show_in_filters: false,
        sort_order: -100,
      });
    }
  },
};

// ── Products ────────────────────────────────────────────────────────────────

export const producerProductDb = {
  async list(producer_id?: string, archived = false): Promise<ProducerProduct[]> {
    let q = `producer_products?company_id=eq.${cid()}&is_archived=eq.${archived}&order=created_at.desc`;
    if (producer_id) q += `&producer_id=eq.${producer_id}`;
    return supaFetchAll<ProducerProduct>(q);
  },

  async create(p: Omit<ProducerProduct, 'id' | 'company_id' | 'created_at' | 'updated_at'>): Promise<ProducerProduct> {
    const r = await supaFetch<ProducerProduct | ProducerProduct[]>('producer_products', {
      method: 'POST',
      body: JSON.stringify({ ...p, company_id: cid() }),
    });
    return first(r);
  },

  /** Создаёт много товаров одним запросом (для импорта). */
  async bulkCreate(products: Array<Omit<ProducerProduct, 'id' | 'company_id' | 'created_at' | 'updated_at'>>): Promise<void> {
    if (products.length === 0) return;
    const payload = products.map(p => ({ ...p, company_id: cid() }));
    await supaFetch('producer_products', { method: 'POST', body: JSON.stringify(payload) });
  },

  async update(id: string, patch: Partial<ProducerProduct>): Promise<ProducerProduct> {
    const r = await supaFetch<ProducerProduct | ProducerProduct[]>(
      `producer_products?id=eq.${id}&company_id=eq.${cid()}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return first(r);
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producer_products?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },

  async bulkArchive(ids: string[], archived: boolean): Promise<void> {
    if (ids.length === 0) return;
    const filter = `id=in.(${ids.join(',')})&company_id=eq.${cid()}`;
    await supaFetch(`producer_products?${filter}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_archived: archived }),
    });
  },

  async bulkDelete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const filter = `id=in.(${chunk.join(',')})&company_id=eq.${cid()}`;
      await supaFetch(`producer_products?${filter}`, { method: 'DELETE' });
    }
  },
};

// ── Mappings ────────────────────────────────────────────────────────────────

export const producerMappingDb = {
  async list(): Promise<ProducerMapping[]> {
    return supaFetchAll<ProducerMapping>(
      `producer_mappings?company_id=eq.${cid()}&order=created_at.desc`,
    );
  },

  async create(m: Omit<ProducerMapping, 'id' | 'company_id' | 'created_at'>): Promise<ProducerMapping> {
    const r = await supaFetch<ProducerMapping | ProducerMapping[]>('producer_mappings', {
      method: 'POST',
      body: JSON.stringify({ ...m, company_id: cid() }),
    });
    return first(r);
  },

  async update(id: string, patch: Partial<Omit<ProducerMapping, 'id' | 'company_id' | 'created_at'>>): Promise<ProducerMapping> {
    const r = await supaFetch<ProducerMapping | ProducerMapping[]>(
      `producer_mappings?id=eq.${id}&company_id=eq.${cid()}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    return first(r);
  },

  /** Создаёт много связок одним запросом на чанк (для импорта — кратно быстрее, чем по одной). */
  async bulkCreate(mappings: Array<Omit<ProducerMapping, 'id' | 'company_id' | 'created_at'>>): Promise<void> {
    if (mappings.length === 0) return;
    const CHUNK = 300;
    const company_id = cid();
    for (let i = 0; i < mappings.length; i += CHUNK) {
      const payload = mappings.slice(i, i + CHUNK).map(m => ({ ...m, company_id }));
      await supaFetch('producer_mappings', { method: 'POST', body: JSON.stringify(payload) });
    }
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producer_mappings?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },

  /** Удаляет много связок чанками по id (кратно быстрее, чем по одной). */
  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const filter = `id=in.(${chunk.join(',')})&company_id=eq.${cid()}`;
      await supaFetch(`producer_mappings?${filter}`, { method: 'DELETE' });
    }
  },

  async removeByArticle(article: string): Promise<void> {
    await supaFetch(
      `producer_mappings?marketplace_article=eq.${encodeURIComponent(article)}&company_id=eq.${cid()}`,
      { method: 'DELETE' },
    );
  },
};

// ── Orders ──────────────────────────────────────────────────────────────────

export const producerOrderDb = {
  async list(status?: ProducerOrder['status']): Promise<ProducerOrder[]> {
    let q = `producer_orders?company_id=eq.${cid()}&order=created_at.desc`;
    if (status) q += `&status=eq.${status}`;
    return supaFetchAll<ProducerOrder>(q);
  },

  async create(o: Omit<ProducerOrder, 'id' | 'company_id' | 'created_at' | 'updated_at'>): Promise<ProducerOrder> {
    const r = await supaFetch<ProducerOrder | ProducerOrder[]>('producer_orders', {
      method: 'POST',
      body: JSON.stringify({ ...o, company_id: cid() }),
    });
    return first(r);
  },

  async createBulk(orders: Array<Omit<ProducerOrder, 'id' | 'company_id' | 'created_at' | 'updated_at'>>): Promise<void> {
    if (orders.length === 0) return;
    const payload = orders.map(o => ({ ...o, company_id: cid() }));
    await supaFetch('producer_orders', { method: 'POST', body: JSON.stringify(payload) });
  },

  async updateStatus(ids: string[], status: ProducerOrder['status']): Promise<void> {
    if (ids.length === 0) return;
    const filter = `id=in.(${ids.join(',')})&company_id=eq.${cid()}`;
    await supaFetch(`producer_orders?${filter}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  async updateNotes(id: string, notes: string): Promise<void> {
    await supaFetch(`producer_orders?id=eq.${id}&company_id=eq.${cid()}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producer_orders?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },
};

// ── Documents history ──────────────────────────────────────────────────────

export const producerDocDb = {
  async list(): Promise<ProducerDocument[]> {
    return supaFetch<ProducerDocument[]>(
      `producer_documents?company_id=eq.${cid()}&order=created_at.desc&limit=200`,
      { method: 'GET' },
    );
  },

  async create(d: Omit<ProducerDocument, 'id' | 'company_id' | 'created_at'>): Promise<ProducerDocument> {
    const r = await supaFetch<ProducerDocument | ProducerDocument[]>('producer_documents', {
      method: 'POST',
      body: JSON.stringify({ ...d, company_id: cid() }),
    });
    return first(r);
  },

  async remove(id: string): Promise<void> {
    await supaFetch(`producer_documents?id=eq.${id}&company_id=eq.${cid()}`, { method: 'DELETE' });
  },
};
