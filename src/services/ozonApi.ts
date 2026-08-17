import { debug } from '@/utils/debug';
import { OzonStore, OzonProduct, OzonWarehouse } from '@/types/ozon';
import { fromOzon } from './dimensionsUnit';

const PROXY = '/ozon-api';
type Creds = Pick<OzonStore, 'client_id' | 'api_key'>;

// ── Ozon API response shape interfaces ──────────────────────────────────────
// These describe only the fields we actually read; additional fields are ignored.

interface OzonProductListItem {
  product_id: number;
  offer_id: string;
}
interface OzonProductListResp {
  result?: { items?: OzonProductListItem[]; last_id?: string };
}

interface OzonPriceItem {
  offer_id: string;
  price?: { price?: string; old_price?: string; min_price?: string; marketing_price?: string };
  selling_price?: string;
  visibility?: string;
}
interface OzonPriceListResp {
  result?: { items?: OzonPriceItem[]; last_id?: string };
  items?: OzonPriceItem[];
  last_id?: string;
}

interface OzonStockEntry { type: string; present: number }
interface OzonStockItem {
  offer_id: string;
  sku?: number;
  fbo_sku?: number;
  fbs_sku?: number;
  product_id?: number;
  stocks?: OzonStockEntry[];
}
interface OzonStocksResp {
  items?: OzonStockItem[];
  result?: { items?: OzonStockItem[] };
  cursor?: string;
}

interface OzonInfoRawItem {
  id?: number;
  offer_id?: string;
  name?: string;
  images?: unknown[];
  barcodes?: string[];
  barcode?: string;
  status?: string | Record<string, string | undefined>;
  state?: string;
  is_archived?: boolean;
  is_autoarchived?: boolean;
  is_fbo_visible?: boolean;
  is_fbs_visible?: boolean;
  sku?: number;
  fbo_sku?: number;
  fbs_sku?: number;
  sources?: unknown[];
  price?: string;
  old_price?: string;
  min_price?: string;
  type_id?: number;
  description_category_id?: number;
  weight?: number;
  package_weight?: number;
  weight_unit?: string;
  depth?: number;
  package_depth?: number;
  width?: number;
  package_width?: number;
  height?: number;
  package_height?: number;
  dimension_unit?: string;
  dimensions?: { depth?: number; width?: number; height?: number; dimension_unit?: string };
  vat?: string | number;
  attributes?: unknown[];
  [key: string]: unknown;
}
interface OzonInfoListResp {
  items?: OzonInfoRawItem[];
  result?: { items?: OzonInfoRawItem[] };
}

interface OzonImportPriceResult {
  offer_id?: string;
  updated?: boolean;
  errors?: Array<{ code?: string; message?: string }>;
}
interface OzonImportPricesResp {
  result?: OzonImportPriceResult[];
}

interface OzonCategoryAttrItem { id: number; name: string }
interface OzonCategoryAttrResp { result?: OzonCategoryAttrItem[] }

interface OzonWarehouseResp { result?: OzonWarehouse[] }

/** Extract a human-readable message from an unknown catch value. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Statuses worth retrying (rate-limit, server overload)
const RETRYABLE = new Set([429, 500, 502, 503]);

async function ozonGet<T>(
  endpoint: string,
  creds: Creds,
  retries = 3,
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
      await sleep(delay);
    }
    const res = await fetch(`${PROXY}${endpoint}`, {
      method: 'GET',
      headers: {
        'Client-Id': creds.client_id,
        'Api-Key': creds.api_key,
      },
    });
    if (res.ok) return res.json() as Promise<T>;
    const text = await res.text();
    console.error(`[Ozon] ${endpoint} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`Ozon ${res.status} (${endpoint}): ${text.slice(0, 150)}`);
    if (!RETRYABLE.has(res.status)) throw lastErr;
  }
  throw lastErr;
}

async function ozonPost<T>(
  endpoint: string,
  body: unknown,
  creds: Creds,
  retries = 5,
  quiet = false,
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s, 8s, 16s
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
      await sleep(delay);
    }
    const res = await fetch(`${PROXY}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': creds.client_id,
        'Api-Key': creds.api_key,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 204 || !ct.includes('application/json')) return undefined as T;
      return res.json() as Promise<T>;
    }
    const text = await res.text();
    if (!quiet) console.error(`[Ozon] ${endpoint} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`Ozon ${res.status} (${endpoint}): ${text.slice(0, 150)}`);
    if (!RETRYABLE.has(res.status)) throw lastErr;
  }
  throw lastErr;
}

// ── Return type from getProductInfo ─────────────────────────────────────────
export interface OzonProductInfo {
  product_id: number;
  sku: number;                 // Ozon internal FBO/FBS SKU
  name: string;
  images: string[];
  barcode: string;
  status: string;
  price: number;
  old_price: number;
  min_price: number;
  marketing_price: number;
  fbs: number;
  fbo: number;
  type_id: number;
  description_category_id: number;
  vat?: string;
  weight?: number | null;
  weight_unit?: string;
  depth?: number | null;
  width?: number | null;
  height?: number | null;
  dimension_unit?: string;
}

export interface OzonChat {
  chat_id: string;
  chat_status: string;       // 'Opened' | 'Closed' | 'AllClosed'...
  chat_type: string;         // 'Buyer_Seller' | 'Seller_Support'...
  unread_count: number;
  last_message_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OzonChatMessage {
  message_id: string;
  created_at: string;
  user_type: string;   // 'Buyer' | 'Seller' | 'CustomerSupport'...
  text: string;
  attachments?: { name: string; url: string }[];
  is_read?: boolean;
  orderNumber?: string;
}

// Ozon присылает вложения внутри m.data как markdown-картинки (![](url)) или просто как URL —
// вытаскиваем их в attachments, а не показываем как текст сообщения.
const MD_IMAGE_RE = /^!\[([^\]]*)\]\((\S+)\)$/;
const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i;

function parseOzonMessageData(data: unknown[]): { text: string; attachments: { name: string; url: string }[] } {
  const textLines: string[] = [];
  const attachments: { name: string; url: string }[] = [];
  for (const item of data) {
    if (typeof item !== 'string') continue;
    const mdMatch = item.match(MD_IMAGE_RE);
    if (mdMatch) {
      const url = mdMatch[2];
      attachments.push({ name: mdMatch[1] || url.split('/').pop() || 'Фото', url });
      continue;
    }
    if (IMAGE_URL_RE.test(item) && /^https?:\/\//.test(item)) {
      attachments.push({ name: item.split('/').pop() || 'Фото', url: item });
      continue;
    }
    if (item) textLines.push(item);
  }
  return { text: textLines.join('\n'), attachments };
}

export interface OzonReview {
  uuid: string;
  created_at: string;
  rating: number;
  text: string;
  author_name: string;
  product_name: string;
  product_photo: string;
  product_sku?: string;
  order_id?: string;
  review_photos?: string[];
  review_video?: string;
  pros?: string;
  cons?: string;
  answer_text: string | null;
  status: string;
}

// ── Diagnostic: test a single endpoint and return raw result ─────────────────
export interface OzonDiagResult {
  endpoint: string;
  status: number | null;
  ok: boolean;
  body: string;
  error?: string;
}

export async function ozonDiagnose(creds: Creds): Promise<OzonDiagResult[]> {
  const results: OzonDiagResult[] = [];

  // Test 1: list (should work)
  try {
    const r1 = await fetch(`${PROXY}/v3/product/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': creds.client_id, 'Api-Key': creds.api_key },
      body: JSON.stringify({ filter: {}, limit: 1 }),
    });
    const b1 = await r1.text();
    results.push({ endpoint: '/v3/product/list', status: r1.status, ok: r1.ok, body: b1.slice(0, 300) });
  } catch (e: unknown) {
    results.push({ endpoint: '/v3/product/list', status: null, ok: false, body: '', error: errMsg(e) });
  }

  // Test 2: product info list v3
  try {
    const r2 = await fetch(`${PROXY}/v3/product/info/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': creds.client_id, 'Api-Key': creds.api_key },
      body: JSON.stringify({ offer_id: ['test-probe'] }),
    });
    const b2 = await r2.text();
    results.push({ endpoint: '/v3/product/info/list', status: r2.status, ok: r2.ok, body: b2.slice(0, 300) });
  } catch (e: unknown) {
    results.push({ endpoint: '/v3/product/info/list', status: null, ok: false, body: '', error: errMsg(e) });
  }

  // Test 3: prices v5
  try {
    const r3 = await fetch(`${PROXY}/v5/product/info/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': creds.client_id, 'Api-Key': creds.api_key },
      body: JSON.stringify({ filter: {}, limit: 1 }),
    });
    const b3 = await r3.text();
    results.push({ endpoint: '/v5/product/info/prices', status: r3.status, ok: r3.ok, body: b3.slice(0, 300) });
  } catch (e: unknown) {
    results.push({ endpoint: '/v5/product/info/prices', status: null, ok: false, body: '', error: errMsg(e) });
  }

  // Test 4: stocks v4
  try {
    const r4 = await fetch(`${PROXY}/v4/product/info/stocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': creds.client_id, 'Api-Key': creds.api_key },
      body: JSON.stringify({ filter: {}, limit: 1 }),
    });
    const b4 = await r4.text();
    results.push({ endpoint: '/v4/product/info/stocks', status: r4.status, ok: r4.ok, body: b4.slice(0, 300) });
  } catch (e: unknown) {
    results.push({ endpoint: '/v4/product/info/stocks', status: null, ok: false, body: '', error: errMsg(e) });
  }

  return results;
}

export const ozonApi = {

  // ── Step 1: get all product IDs (pagination via last_id) ──────────────────
  async getAllProductIds(creds: Creds): Promise<Array<{ product_id: number; offer_id: string }>> {
    const items: Array<{ product_id: number; offer_id: string }> = [];
    let lastId = '';
    let page = 0;
    do {
      if (page > 0) await sleep(300);
      const body: Record<string, unknown> = { filter: { visibility: 'ALL' }, limit: 1000 };
      if (lastId) body.last_id = lastId;
      const resp = await ozonPost<OzonProductListResp>('/v3/product/list', body, creds);
      const batch: OzonProductListItem[] = resp.result?.items ?? [];
      items.push(...batch);
      lastId = batch.length === 1000 ? (resp.result?.last_id ?? '') : '';
      page++;
    } while (lastId);
    return items;
  },

  // ── Step 2: fetch product info via /v3/product/info/list ────────────────────
  // Accepts items with both product_id and offer_id (from /v3/product/list).
  // Uses product_id for the request (v3 doesn't filter by offer_id correctly).
  // Returns a map keyed by offer_id.
  async getProductInfo(
    idList: Array<{ product_id: number; offer_id: string }>,
    creds: Creds,
    onProgress?: (done: number, total: number) => void,
    signal?: { aborted: boolean },
  ): Promise<Map<string, OzonProductInfo>> {
    const map = new Map<string, OzonProductInfo>();
    const CHUNK = 50;
    const total = idList.length;
    // Build a lookup so we can map product_id back to offer_id
    const pidToOfferId = new Map(idList.map(i => [i.product_id, i.offer_id]));
    // Collect ALL SKU variants (sku, fbo_sku, fbs_sku) → offer_id during iteration
    const allSkuPairs: Array<[string, string]> = [];

    for (let i = 0; i < idList.length; i += CHUNK) {
      if (signal?.aborted) break;
      if (i > 0) await sleep(1000);
      const chunk = idList.slice(i, i + CHUNK);
      const productIds = chunk.map(c => c.product_id);

      // Retry up to 3 times on 500 (rate-limit)
      let text = '';
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(5000 * attempt); // 5s, 10s
        res = await fetch(`${PROXY}/v3/product/info/list`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Client-Id': creds.client_id,
            'Api-Key': creds.api_key,
          },
          body: JSON.stringify({ product_id: productIds }),
        });
        text = await res.text();
        if (res.ok || res.status === 400) break;
        console.warn(`[Ozon] info/list chunk ${i}: HTTP ${res.status}, attempt ${attempt + 1}/3`);
      }

      if (!res!.ok) {
        console.warn(`[Ozon] v3/product/info/list chunk ${i}: HTTP ${res!.status} (после 3 попыток)`, text.slice(0, 150));
        onProgress?.(Math.min(i + CHUNK, total), total);
        continue;
      }

      try {
        const resp = JSON.parse(text);
        if (i === 0) {
          // Log raw response structure to debug field names and data location
          debug.log(`[Ozon] info/list chunk 0 raw:`, text.slice(0, 600));
          // Log first item's full keys to find SKU field
          try {
            const firstItem = (JSON.parse(text).items || [])[0];
            if (firstItem) {
              debug.log(`[Ozon] info/list item keys:`, Object.keys(firstItem));
              debug.log(`[Ozon] info/list item sku fields:`, {
                sku: firstItem.sku, fbo_sku: firstItem.fbo_sku, fbs_sku: firstItem.fbs_sku,
                sources: firstItem.sources?.slice?.(0, 2),
              });
              debug.log(`[Ozon] info/list item dims:`, {
                weight: firstItem.weight, weight_unit: firstItem.weight_unit,
                depth: firstItem.depth, width: firstItem.width, height: firstItem.height,
                dimension_unit: firstItem.dimension_unit,
              });
            }
          } catch (e) { debug.warn('[ozonApi] swallowed error', e); }
        }
        // v3 returns items at top level: { items: [...] }  (no "result" wrapper)
        const resp2 = resp as OzonInfoListResp;
        const items: OzonInfoRawItem[] = resp2.items ?? resp2.result?.items ?? [];
        debug.log(`[Ozon] info/list chunk ${i}: ${items.length} items из ${chunk.length}`);
        for (const item of items) {
          // offer_id is in the item; fallback to pidToOfferId map
          const offerId: string = item.offer_id || (item.id ? pidToOfferId.get(item.id) : undefined) || '';
          if (!offerId) continue;

          // v3: images are direct URL strings
          const imgRaw: unknown[] = item.images ?? [];
          const images = imgRaw.filter((img): img is string => typeof img === 'string' && !!img).slice(0, 5);

          // v3: barcodes is an array
          const barcode = Array.isArray(item.barcodes) ? (item.barcodes[0] || '') : (item.barcode || '');

          // v3: determine status from multiple fields
          let status = 'processed';
          if (item.is_archived || item.is_autoarchived) {
            status = 'archived';
          } else {
            // Try to get moderation/state status
            let rawStatus = '';
            if (typeof item.status === 'string' && item.status) rawStatus = item.status.toLowerCase();
            else if (item.status && typeof item.status === 'object') rawStatus = String(item.status['state'] ?? '').toLowerCase();
            else if (typeof item.state === 'string' && item.state) rawStatus = item.state.toLowerCase();

            if (rawStatus === 'failed_moderation' || rawStatus === 'moderating' ||
                rawStatus === 'not_moderated' || rawStatus === 'banned' || rawStatus === 'blocked' ||
                rawStatus === 'price_error' || rawStatus === 'sold_out' || rawStatus === 'expired') {
              status = rawStatus;
            } else {
              // Product passed moderation — check visibility
              const fboVis = item.is_fbo_visible;
              const fbsVis = item.is_fbs_visible;
              if (fboVis === false && fbsVis === false) {
                // Not visible on any channel → seller hid it (disabled/ready for sale)
                status = 'disabled';
              } else {
                // At least one channel visible → actively selling
                status = 'processed';
              }
            }
          }

          // v3: no stocks in this endpoint — they come from overlayStocks
          const fbs = 0;
          const fbo = 0;

          // Ozon internal SKU: item.sku, item.fbo_sku, item.fbs_sku
          const itemSku = item.sku || item.fbo_sku || item.fbs_sku || 0;
          // Collect ALL SKU variants for the cache
          for (const s of [item.sku, item.fbo_sku, item.fbs_sku, item.id]) {
            if (s) allSkuPairs.push([String(s), offerId]);
          }

          map.set(offerId, {
            product_id: item.id || 0,
            sku: itemSku,
            name: item.name || '',
            images,
            barcode,
            status,
            price: parseFloat(item.price || '0') || 0,
            old_price: parseFloat(item.old_price || '0') || 0,
            min_price: parseFloat(item.min_price || '0') || 0,
            marketing_price: 0,
            fbs,
            fbo,
            type_id: item.type_id || 0,
            description_category_id: item.description_category_id || 0,
            vat: item.vat != null ? String(item.vat) : undefined,
            weight: item.weight ?? item.package_weight ?? null,
            weight_unit: item.weight_unit || 'g',
            depth: item.depth ?? item.package_depth ?? item.dimensions?.depth ?? null,
            width: item.width ?? item.package_width ?? item.dimensions?.width ?? null,
            height: item.height ?? item.package_height ?? item.dimensions?.height ?? null,
            dimension_unit: item.dimension_unit || item.dimensions?.dimension_unit || 'mm',
          });
        }
      } catch (e) {
        console.warn(`[Ozon] v3/product/info/list chunk ${i}: JSON parse failed`, e);
      }

      onProgress?.(Math.min(i + CHUNK, total), total);
    }

    // ── Batch-save ALL Ozon SKU variants → offer_id for analytics mapping ──
    // Finance transactions use FBO or FBS SKU depending on delivery scheme,
    // but ozon_products.sku stores only ONE. This localStorage cache fills the gap.
    try {
      const skuCache: Record<string, string> = JSON.parse(localStorage.getItem('ozon_sku_map_v1') || '{}');
      for (const [sku, offerId] of allSkuPairs) {
        skuCache[sku] = offerId;
      }
      localStorage.setItem('ozon_sku_map_v1', JSON.stringify(skuCache));
      debug.log(`[Ozon] ozon_sku_map_v1: ${Object.keys(skuCache).length} total SKU→offer_id mappings cached (${allSkuPairs.length} from this sync)`);
    } catch (e) { debug.warn('[ozonApi] swallowed error', e); }

    return map;
  },

  // ── Step 2b: overlay accurate prices from /v5/product/info/prices ───────────
  // Patches the map in-place with current price/old_price/min_price values.
  async overlayPrices(
    map: Map<string, OzonProductInfo>,
    creds: Creds,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    let lastId = '';
    let fetched = 0;
    do {
      const body: Record<string, unknown> = { filter: { visibility: 'ALL' }, limit: 1000 };
      if (lastId) body.last_id = lastId;
      let resp: any;
      try {
        resp = await ozonPost<OzonPriceListResp>('/v5/product/info/prices', body, creds);
      } catch (e: unknown) {
        console.error('[Ozon] overlayPrices /v5/product/info/prices error:', errMsg(e));
        break;
      }
      const items: OzonPriceItem[] = resp.result?.items ?? [];
      for (const item of items) {
        const entry = map.get(item.offer_id);
        if (entry) {
          entry.price = parseFloat(item.price?.price || item.selling_price || '0') || entry.price;
          entry.old_price = parseFloat(item.price?.old_price || '0') || entry.old_price;
          entry.min_price = parseFloat(item.price?.min_price || '0') || entry.min_price;
          const mp = parseFloat(item.price?.marketing_price || '0');
          if (mp > 0) entry.marketing_price = mp;

          // /v5 also returns visibility — use it to refine status
          // Only override if status is already "processed" or "disabled" (not archived/moderation)
          const vis: string = (item.visibility || '').toUpperCase();
          if (entry.status === 'processed' || entry.status === 'disabled') {
            if (vis === 'VISIBLE') entry.status = 'processed';
            else if (vis === 'INVISIBLE') entry.status = 'disabled';
          }
        }
      }
      fetched += items.length;
      onProgress?.(fetched, fetched); // we don't know total upfront
      lastId = items.length === 1000 ? (resp.result?.last_id || '') : '';
      if (lastId) await sleep(400);
    } while (lastId);
  },

  // ── Step 2c: overlay accurate stocks from /v4/product/info/stocks ───────────
  async overlayStocks(
    map: Map<string, OzonProductInfo>,
    creds: Creds,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    let cursor = '';
    let fetched = 0;
    const stocksSkuPairs: Array<[string, string]> = [];
    do {
      const body: Record<string, unknown> = { filter: { visibility: 'ALL' }, limit: 1000 };
      if (cursor) body.cursor = cursor;
      let resp: any;
      try {
        resp = await ozonPost<OzonStocksResp>('/v4/product/info/stocks', body, creds);
      } catch (e: unknown) {
        console.error('[Ozon] overlayStocks /v4/product/info/stocks error:', errMsg(e));
        break;
      }
      // API v4 returns {items, total, cursor} at top level
      const items: OzonStockItem[] = resp.items ?? resp.result?.items ?? [];
      for (const item of items) {
        const entry = map.get(item.offer_id);
        if (entry) {
          const stocks: OzonStockEntry[] = item.stocks ?? [];
          const fbs = stocks.find(s => s.type === 'fbs')?.present ?? entry.fbs;
          const fbo = stocks.find(s => s.type === 'fbo')?.present ?? entry.fbo;
          entry.fbs = fbs;
          entry.fbo = fbo;
          const itemSku = item.sku || item.fbo_sku || item.fbs_sku || 0;
          if (itemSku && (!entry.sku || entry.sku === 0)) {
            entry.sku = itemSku;
          }
        }
        if (item.offer_id) {
          for (const s of [item.sku, item.fbo_sku, item.fbs_sku, item.product_id]) {
            if (s) stocksSkuPairs.push([String(s), item.offer_id]);
          }
        }
      }
      fetched += items.length;
      onProgress?.(fetched, fetched);
      const nextCursor: string = resp.cursor ?? resp.result?.cursor ?? '';
      if (items.length < 1000 || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
      await sleep(400);
    } while (true);
    // Batch-save SKU variants from stocks endpoint
    if (stocksSkuPairs.length) {
      try {
        const skuCache: Record<string, string> = JSON.parse(localStorage.getItem('ozon_sku_map_v1') || '{}');
        for (const [sku, offerId] of stocksSkuPairs) skuCache[sku] = offerId;
        localStorage.setItem('ozon_sku_map_v1', JSON.stringify(skuCache));
        debug.log(`[Ozon] ozon_sku_map_v1: updated with ${stocksSkuPairs.length} SKUs from stocks`);
      } catch (e) { debug.warn('[ozonApi] swallowed error', e); }
    }
  },

  /**
   * Резолв финансовых SKU → offer_id через /v3/product/info/list.
   * Принимает список SKU (number), возвращает Map<sku_string, offer_id>.
   * Используется в аналитике когда FBO/FBS SKU из транзакций не маппятся на товары.
   */
  async resolveSkus(
    skus: number[],
    creds: Creds,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const CHUNK = 50;
    for (let i = 0; i < skus.length; i += CHUNK) {
      const chunk = skus.slice(i, i + CHUNK);
      try {
        // v3/product/info/list принимает product_id, sku, или offer_id
        const resp = await ozonPost<OzonInfoListResp>('/v3/product/info/list', { sku: chunk }, creds);
        const items: OzonInfoRawItem[] = resp?.items ?? resp?.result?.items ?? [];
        for (const item of items) {
          const offerId: string = item.offer_id || '';
          if (!offerId) continue;
          // Маппим все варианты SKU на offer_id
          for (const s of [item.sku, item.fbo_sku, item.fbs_sku, item.id]) {
            if (s) result.set(String(s), offerId);
          }
        }
        debug.log(`[Ozon] resolveSkus chunk ${i}: ${items.length} items resolved from ${chunk.length} SKUs`);
      } catch (e) {
        console.warn(`[Ozon] resolveSkus chunk ${i}:`, errMsg(e).slice(0, 150));
      }
      if (i + CHUNK < skus.length) await sleep(1000);
    }
    // Сохраняем в кэш
    if (result.size > 0) {
      try {
        const skuCache: Record<string, string> = JSON.parse(localStorage.getItem('ozon_sku_map_v1') || '{}');
        for (const [sku, offerId] of result) skuCache[sku] = offerId;
        localStorage.setItem('ozon_sku_map_v1', JSON.stringify(skuCache));
        debug.log(`[Ozon] resolveSkus: resolved ${result.size} SKU mappings, cache now ${Object.keys(skuCache).length}`);
      } catch (e) { debug.warn('[ozonApi] swallowed error', e); }
    }
    return result;
  },

  // ── Fetch seller prices (price/old_price) for specific offer_ids ──────────
  async getSellerPrices(
    offerIds: string[],
    creds: Creds,
  ): Promise<Map<string, { sellerPrice: number; oldPrice: number }>> {
    const result = new Map<string, { sellerPrice: number; oldPrice: number }>();
    if (!offerIds.length) return result;
    const CHUNK = 1000;
    for (let i = 0; i < offerIds.length; i += CHUNK) {
      const chunk = offerIds.slice(i, i + CHUNK);
      // Paginate within each chunk — Ozon may return fewer items per page even when filtering by offer_id
      let lastId = '';
      let page = 0;
      do {
        const body: Record<string, unknown> = { filter: { offer_id: chunk, visibility: 'ALL' }, limit: Math.min(chunk.length, 1000) };
        if (lastId) body.last_id = lastId;
        const resp = await ozonPost<OzonPriceListResp>('/v5/product/info/prices', body, creds);
        const items: OzonPriceItem[] = resp.items ?? resp.result?.items ?? [];
        for (const item of items) {
          const sellerPrice = parseFloat(item.price?.price || '0') || 0;
          // old_price — перечёркнутая цена на странице Ozon (база для визуальной скидки).
          const oldPrice = parseFloat(item.price?.old_price || '0') || 0;
          if (item.offer_id && sellerPrice > 0) {
            const entry = { sellerPrice, oldPrice };
            result.set(item.offer_id, entry);
            result.set(item.offer_id.toLowerCase(), entry);
          }
        }
        // Stop when we've received all expected items or no more pages
        const nextLastId: string = resp.last_id ?? resp.result?.last_id ?? '';
        if (items.length < chunk.length || !nextLastId || nextLastId === lastId || result.size >= chunk.length) break;
        lastId = nextLastId;
        page++;
        if (page > 20) break; // safety guard
        await sleep(300);
      } while (true);
      if (i + CHUNK < offerIds.length) await sleep(400);
    }
    return result;
  },

  // ── Check credentials ────────────────────────────────────────────────────
  checkToken: async (creds: Creds): Promise<void> => {
    await ozonPost<OzonProductListResp>('/v3/product/list', { filter: {}, limit: 1 }, creds);
  },

  // ── Update prices ─────────────────────────────────────────────────────────
  async updatePrices(creds: Creds, prices: Array<{
    offer_id: string;
    price: string;
    old_price?: string;
    min_price?: string;
    auto_action_enabled?: 'ENABLED' | 'DISABLED';
  }>): Promise<void> {
    for (let i = 0; i < prices.length; i += 100) {
      const resp = await ozonPost<OzonImportPricesResp>('/v1/product/import/prices', { prices: prices.slice(i, i + 100) }, creds);
      const items: OzonImportPriceResult[] = resp?.result ?? [];
      const failed = items.filter(r => r.updated === false && r.errors?.length);
      if (failed.length) {
        const details = failed.map(r => {
          const errs = (r.errors ?? []).map((e: any) =>
            e?.code ? `${e.code}${e.message ? ': ' + e.message : ''}` : JSON.stringify(e)
          ).join(', ');
          return `${r.offer_id}: ${errs}`;
        }).join('; ');
        console.error('[Ozon updatePrices] Failed items:', details);
        throw new Error(`Ozon не принял цены: ${details.slice(0, 300)}`);
      }
    }
  },

  // ── Warehouses ────────────────────────────────────────────────────────────
  async getWarehouses(creds: Creds): Promise<OzonWarehouse[]> {
    const resp = await ozonPost<OzonWarehouseResp>('/v2/warehouse/list', {}, creds);
    return resp.result ?? [];
  },

  // ── Archive / Unarchive ───────────────────────────────────────────────────
  // items: array of Ozon internal product_id numbers
  async archiveProducts(creds: Creds, productIds: number[]): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      await ozonPost('/v1/product/archive', {
        items: productIds.slice(i, i + CHUNK).map(id => ({ product_id: id })),
      }, creds);
    }
  },

  async unarchiveProducts(creds: Creds, productIds: number[]): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      await ozonPost('/v1/product/unarchive', {
        items: productIds.slice(i, i + CHUNK).map(id => ({ product_id: id })),
      }, creds);
    }
  },

  // ── Update Stocks (FBS) ────────────────────────────────────────────────────
  /**
   * POST /v2/products/stocks — обновление остатков FBS.
   * @param stocks массив { offer_id, stock, warehouse_id }
   */
  async updateStocks(
    creds: Creds,
    stocks: Array<{ offer_id: string; stock: number; warehouse_id?: number }>,
  ): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < stocks.length; i += CHUNK) {
      await ozonPost('/v2/products/stocks', {
        stocks: stocks.slice(i, i + CHUNK).map(s => ({
          offer_id: s.offer_id,
          stock: s.stock,
          warehouse_id: s.warehouse_id ?? 0,
        })),
      }, creds);
    }
  },

  // ── Create Products ────────────────────────────────────────────────────────
  /**
   * POST /v3/product/import — создание новых товаров.
   * @param items массив товаров с полными атрибутами
   */
  async createProducts(
    creds: Creds,
    items: Array<{
      offer_id: string;
      name: string;
      description?: string;
      category_id: number;
      price: string;
      old_price?: string;
      vat: string;
      height: number;
      width: number;
      depth: number;
      dimension_unit: string;
      weight: number;
      weight_unit: string;
      images: string[];
      attributes?: Array<{ complex_id?: number; id: number; values: Array<{ dictionary_value_id?: number; value?: string }> }>;
      barcode?: string;
    }>,
  ): Promise<{ task_id: number }> {
    const resp = await ozonPost<any>('/v3/product/import', { items }, creds);
    return { task_id: resp.result?.task_id ?? 0 };
  },

  /**
   * POST /v1/product/import/info — статус импорта товаров.
   */
  async getImportStatus(creds: Creds, taskId: number): Promise<any> {
    return ozonPost('/v1/product/import/info', { task_id: taskId }, creds);
  },

  // ── Upload Images ──────────────────────────────────────────────────────────
  /**
   * POST /v1/product/pictures/import — загрузка фотографий.
   * @param items массив { product_id, images: ['http://...'] }
   */
  async uploadImages(
    creds: Creds,
    items: Array<{ product_id: number; images: string[] }>,
  ): Promise<void> {
    await ozonPost('/v1/product/pictures/import', { items }, creds);
  },

  // ── Category Tree ──────────────────────────────────────────────────────────
  /**
   * POST /v1/description-category/tree — дерево категорий Ozon.
   */
  async getCategoryTree(creds: Creds, language = 'DEFAULT'): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/description-category/tree', { language }, creds);
    return resp.result ?? [];
  },

  /**
   * POST /v1/description-category/attribute — атрибуты категории.
   */
  async getCategoryAttributes(
    creds: Creds,
    categoryId: number,
    language = 'DEFAULT',
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/description-category/attribute', {
      description_category_id: categoryId,
      language,
      type_id: 0,
    }, creds);
    return resp.result ?? [];
  },

  // ── Analytics ──────────────────────────────────────────────────────────────
  /**
   * POST /v1/analytics/data — детальная аналитика (просмотры, конверсия).
   */
  async getAnalytics(
    creds: Creds,
    dateFrom: string,
    dateTo: string,
    metrics: string[] = ['hits_view', 'hits_tocart', 'ordered_units', 'revenue'],
    dimension: string[] = ['sku'],
  ): Promise<any> {
    return ozonPost('/v1/analytics/data', {
      date_from: dateFrom,
      date_to: dateTo,
      metrics,
      dimension,
      filters: [],
      sort: [{ key: 'hits_view', order: 'DESC' }],
      limit: 1000,
      offset: 0,
    }, creds);
  },

  // ── Promotions ─────────────────────────────────────────────────────────────
  /**
   * POST /v1/product/info/discounted — товары в акциях.
   */
  async getPromotedProducts(creds: Creds): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/product/info/discounted', { discount_type: 'ALL' }, creds);
    return resp.result?.items ?? [];
  },

  /**
   * POST /v1/product/promote — участие в промо-акции.
   */
  async promoteProducts(
    creds: Creds,
    products: Array<{ product_id: number; discount: number }>,
  ): Promise<void> {
    await ozonPost('/v1/product/promote', { products }, creds);
  },

  // ── Visibility ────────────────────────────────────────────────────────────
  // visibility: 'VISIBLE' | 'INVISIBLE'
  async setVisibility(creds: Creds, items: Array<{ product_id: number; visibility: 'VISIBLE' | 'INVISIBLE' }>): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < items.length; i += CHUNK) {
      await ozonPost('/v1/product/visibility/set', {
        items: items.slice(i, i + CHUNK),
      }, creds);
    }
  },

  // ── Get attribute names for a category via /v1/description-category/attribute ──
  // Returns a Map<attributeId, attributeName> for the given category.
  async getCategoryAttributeNames(
    categoryId: number,
    creds: Creds,
    typeId?: number,
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (!categoryId || categoryId <= 0) return map;
    try {
      const body: any = {
        description_category_id: categoryId,
        language: 'RU',
        attribute_type: 'ALL',
      };
      if (typeId && typeId > 0) body.type_id = typeId;
      const resp = await ozonPost<OzonCategoryAttrResp>('/v1/description-category/attribute', body, creds);
      const items: OzonCategoryAttrItem[] = resp.result ?? [];
      for (const item of items) {
        if (item.id && item.name) map.set(item.id, item.name);
      }
    } catch {
      // fallback to built-in dictionary
    }
    return map;
  },

  // ── Get full product attributes via /v4/product/info/attributes ───────────
  // Returns rich attribute data including all category-specific fields.
  async getProductAttributes(
    offerId: string,
    creds: Creds,
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v4/product/info/attributes', {
      filter: { offer_id: [offerId], visibility: 'ALL' },
      limit: 1,
      sort_dir: 'ASC',
    }, creds);
    return resp.result || [];
  },

  // ── Update product attributes via /v1/product/attributes/update ──────────
  // attributes: array of { id, complex_id, values: [{ dictionary_value_id, value }] }
  async updateAttributes(
    creds: Creds,
    items: Array<{ offer_id: string; attributes: any[] }>,
  ): Promise<void> {
    await ozonPost('/v1/product/attributes/update', { items }, creds);
  },

  // ── Get full product info (single) via /v3/product/info/list ─────────────
  async getFullProductInfo(
    offerId: string,
    productId: number | null,
    creds: Creds,
  ): Promise<OzonInfoRawItem | null> {
    const body = productId ? { product_id: [productId] } : { offer_id: [offerId] };
    const resp = await ozonPost<OzonInfoListResp>('/v3/product/info/list', body, creds);
    const items: OzonInfoRawItem[] = resp.items ?? resp.result?.items ?? [];
    return items[0] ?? null;
  },

  // ── Get product description via /v1/product/info/description ─────────────
  async getProductDescription(
    offerId: string,
    productId: number | null,
    creds: Creds,
  ): Promise<string> {
    try {
      const body = productId ? { product_id: productId } : { offer_id: offerId };
      const resp = await ozonPost<any>('/v1/product/info/description', body, creds);
      return resp.result?.description || resp.description || '';
    } catch {
      return '';
    }
  },

  // ── Update product via /v3/product/import ───────────────────────────────
  // /v3/product/update не существует в API Ozon (возвращает 404).
  // Используем /v3/product/import напрямую.
  // attributes: [] означает "не менять атрибуты" для уже существующего товара.
  async updateProduct(
    creds: Creds,
    item: Record<string, unknown>,
  ): Promise<void> {
    const payload = { ...item };
    // Do NOT force attributes:[] — sending an empty array wipes all product attributes on Ozon.
    // Attributes are only sent when explicitly provided (e.g. during full product creation).
    const resp = await ozonPost<any>('/v3/product/import', { items: [payload] }, creds);
    // import возвращает { result: { task_id } } — задача принята, ошибок нет
    const taskErrors: any[] = resp?.result?.errors ?? resp?.errors ?? [];
    if (taskErrors.length) {
      throw new Error(taskErrors.map((e: any) => e.message ?? e.error ?? JSON.stringify(e)).join('; '));
    }
  },

  // ── Update product barcode via /v1/product/update/barcodes ───────────────
  async updateBarcode(creds: Creds, sku: number, barcode: string): Promise<void> {
    const resp = await ozonPost<any>('/v1/product/update/barcodes', {
      barcodes: [{ sku, barcode }],
    }, creds);
    const errors: any[] = resp?.errors ?? [];
    if (errors.length) throw new Error(errors.map((e: any) => e.error ?? e.message ?? JSON.stringify(e)).join('; '));
  },

  // ── Reviews ──────────────────────────────────────────────────────────────
  /**
   * Ozon Review List API (требует Seller Premium):
   *   POST /v1/review/list
   *   { limit: 1..100, sort_dir: "ASC"|"DESC", status: "ALL"|"PROCESSED"|"UNPROCESSED", last_id: "" }
   *
   * Возвращает: { reviews: [], last_id, has_next }
   * Пагинация cursor-based: передаём last_id из предыдущего ответа.
   */
  async getReviews(
    creds: Creds,
    opts: { status?: 'ALL' | 'NOT_ANSWERED'; page?: number; page_size?: number } = {},
    _signal?: AbortSignal,
  ): Promise<{ reviews: OzonReview[]; total: number }> {
    // Маппинг старого "NOT_ANSWERED" → новый "UNPROCESSED"
    const apiStatus = opts.status === 'NOT_ANSWERED' ? 'UNPROCESSED' : (opts.status ?? 'ALL');
    const limit = Math.min(100, Math.max(20, opts.page_size ?? 100));

    const allReviews: any[] = [];
    let lastId = '';
    const MAX_PAGES = 10; // защита от бесконечного цикла

    for (let i = 0; i < MAX_PAGES; i++) {
      const body: any = {
        limit,
        sort_dir: 'DESC',
        status: apiStatus,
      };
      if (lastId) body.last_id = lastId;

      const resp = await ozonPost<any>('/v1/review/list', body, creds).catch((err: any) => {
        const msg = String((err instanceof Error ? err.message : String(err)) ?? '');
        if (msg.includes('subscription') || msg.includes('PermissionDenied') || msg.includes('403') || msg.includes('Forbidden') || msg.includes('not available')) {
          throw new Error('Ozon Review API: доступ запрещён сервером Ozon.\n\nПричины: 1) ваш тариф не включает API отзывов (нужен Premium Pro); 2) API-ключ создан ДО подключения тарифа — пересоздайте его в seller.ozon.ru → Настройки → API-ключи; 3) Premium ещё не активирован полностью (обычно до 24ч).\n\nТочный ответ Ozon: "not available with existing subscription".');
        }
        throw err;
      });

      const pageReviews = resp.reviews ?? [];
      allReviews.push(...pageReviews);

      // Cursor-based: останавливаемся когда нет следующей страницы
      if (!resp.has_next || !resp.last_id || resp.last_id === lastId || pageReviews.length === 0) break;
      lastId = resp.last_id;
    }

    const reviews: OzonReview[] = allReviews.map((r: any) => ({
      uuid: r.uuid,
      created_at: r.created_at,
      rating: r.rating ?? 0,
      text: r.text ?? '',
      author_name: r.author?.name ?? 'Покупатель',
      product_name: r.product_info?.sku_name ?? r.product_info?.name ?? '',
      product_photo: r.product_info?.photo_url ?? r.product_info?.image ?? '',
      product_sku: r.product_info?.sku ? String(r.product_info.sku) : (r.product_info?.offer_id ?? ''),
      order_id: r.order_number ?? r.order_id ?? '',
      review_photos: Array.isArray(r.photos)
        ? r.photos.map((p: any) => p.url ?? p.photo_url ?? p).filter(Boolean)
        : [],
      review_video: r.video?.url ?? r.videos?.[0]?.url ?? '',
      pros: r.advantages ?? r.pros ?? '',
      cons: r.disadvantages ?? r.cons ?? '',
      // У Ozon ответ может прийти в разных полях — проверяем оба варианта
      answer_text: r.comments?.[0]?.text ?? r.answer?.text ?? null,
      // status: UNPROCESSED / PROCESSED — используется как маркер «отвечен»
      status: r.status,
    }));
    return { reviews, total: reviews.length };
  },

  /**
   * Ozon Review Comment Create API:
   *   POST /v1/review/comment/create
   *   { review_uuid, text, mark_review_as_processed: true }
   *
   * ⚠ Без mark_review_as_processed=true отзыв остаётся в статусе UNPROCESSED
   * и при перезагрузке выглядит как «без ответа».
   */
  async replyReview(
    creds: Creds,
    reviewUuid: string,
    text: string,
  ): Promise<void> {
    await ozonPost('/v1/review/comment/create', {
      review_uuid: reviewUuid,
      text,
      mark_review_as_processed: true,   // КЛЮЧЕВОЕ: меняет статус отзыва на PROCESSED
    }, creds);
  },

  // ── Чаты с покупателями ───────────────────────────────────────────────────
  // Документация: https://docs.ozon.ru/api/seller/#operation/ChatAPI_ChatList

  /** POST /v3/chat/list — список чатов (по умолчанию все, кроме закрытых ботом). */
  async getChatList(
    creds: Creds,
    opts: { onlyUnread?: boolean; limit?: number } = {},
  ): Promise<OzonChat[]> {
    const limit = Math.min(1000, Math.max(1, opts.limit ?? 100));
    const allChats: any[] = [];
    let cursor = '';
    const MAX_PAGES = 10;

    for (let i = 0; i < MAX_PAGES; i++) {
      const body: any = {
        limit,
        filter: opts.onlyUnread ? { unread_only: true } : {},
      };
      if (cursor) body.cursor = cursor;

      const resp = await ozonPost<any>('/v3/chat/list', body, creds);
      const batch: any[] = resp.chats ?? [];
      allChats.push(...batch);

      if (!resp.has_next || !resp.cursor || resp.cursor === cursor || batch.length === 0) break;
      cursor = resp.cursor;
    }

    return allChats.map((c: any): OzonChat => ({
      chat_id: c.chat?.chat_id ?? c.chat_id,
      chat_status: c.chat?.chat_status ?? c.chat_status,
      chat_type: c.chat?.chat_type ?? c.chat_type,
      unread_count: c.unread_count ?? 0,
      last_message_id: c.last_message_id,
      created_at: c.chat?.created_at ?? c.created_at,
      updated_at: c.chat?.updated_at ?? c.updated_at,
    }));
  },

  /** POST /v3/chat/history — история сообщений чата (последние сначала). */
  async getChatHistory(
    creds: Creds,
    chatId: string,
    limit = 100,
  ): Promise<OzonChatMessage[]> {
    const resp = await ozonPost<any>('/v3/chat/history', {
      chat_id: chatId,
      limit: Math.min(1000, Math.max(1, limit)),
      direction: 'Backward',
    }, creds);

    const messages: any[] = resp.messages ?? resp.result?.messages ?? [];
    return messages.map((m: any): OzonChatMessage => {
      const { text, attachments } = Array.isArray(m.data)
        ? parseOzonMessageData(m.data)
        : { text: m.data ?? '', attachments: [] };
      return {
        message_id: m.message_id,
        created_at: m.created_at,
        user_type: m.user?.type ?? 'Unknown',
        text,
        attachments: attachments.length ? attachments : undefined,
        is_read: m.is_read,
        orderNumber: m.context?.order_number || undefined,
      };
    }).reverse(); // от старых к новым
  },

  /**
   * Скачать файл вложения чата (api-seller.ozon.ru/v2/chat/file/...) с авторизацией.
   * Браузер не может приложить заголовки Client-Id/Api-Key к <img src>, поэтому
   * картинку нужно скачать через fetch и показать как blob-URL.
   */
  async fetchChatFile(creds: Creds, fileUrl: string): Promise<Blob> {
    const proxied = fileUrl.replace(/^https?:\/\/api-seller\.ozon\.ru/, PROXY);
    const res = await fetch(proxied, {
      headers: { 'Client-Id': creds.client_id, 'Api-Key': creds.api_key },
    });
    if (!res.ok) throw new Error(`Ozon chat file ${res.status}`);
    return res.blob();
  },

  /** POST /v1/chat/send/message — отправить текстовое сообщение в чат. */
  async sendChatMessage(creds: Creds, chatId: string, text: string): Promise<void> {
    await ozonPost('/v1/chat/send/message', {
      chat_id: chatId,
      text,
    }, creds);
  },

  /** POST /v1/chat/send/file — отправить файл (изображение/документ) в чат. */
  async sendChatFile(creds: Creds, chatId: string, file: { name: string; base64: string }): Promise<void> {
    await ozonPost('/v1/chat/send/file', {
      chat_id: chatId,
      base64_content: file.base64,
      name: file.name,
    }, creds);
  },

  /** POST /v2/chat/read — отметить сообщения чата прочитанными. */
  async markChatRead(creds: Creds, chatId: string, fromMessageId?: string): Promise<void> {
    const body: any = { chat_id: chatId };
    if (fromMessageId) body.from_message_id = fromMessageId;
    await ozonPost('/v2/chat/read', body, creds, 1, true).catch((e) => debug.warn('[ozonApi] swallowed error', e));
  },

  /**
   * Убрать товары из всех активных акций Ozon.

   * productIds — внутренние Ozon product_id (не offer_id).
   */
  async removeProductsFromAllPromos(creds: Creds, productIds: number[]): Promise<void> {
    if (!productIds.length) return;
    let actions: any[] = [];
    try {
      const resp = await ozonGet<any>('/v1/actions', creds);
      actions = resp.result ?? resp.actions ?? [];
    } catch (e: unknown) {
      console.warn('[Ozon MRC] /v1/actions error:', errMsg(e));
      return;
    }
    // Ozon отдаёт все акции; убираем товар из каждой (ошибки игнорируем — товар может не участвовать)
    await Promise.allSettled(
      actions
        .filter((a: any) => a.action_id != null)
        .map((a: any) =>
          ozonPost('/v1/actions/products/deactivate', {
            action_id: a.action_id,
            product_ids: productIds,
          }, creds).catch((e) => debug.warn('[ozonApi] swallowed error', e)),
        ),
    );
  },

  // ── Supply Management (FBO поставки) ───────────────────────────────────────

  /**
   * POST /v1/supply-order/create — создать поставку FBO.
   */
  async createSupply(
    creds: Creds,
    warehouseId: number,
    name?: string,
  ): Promise<{ supplyId: string }> {
    const body: any = { warehouse_id: warehouseId };
    if (name) body.name = name;
    const resp = await ozonPost<any>('/v1/supply-order/create', body, creds);
    return { supplyId: resp?.result?.supply_order_id ?? resp?.supply_order_id ?? '' };
  },

  /**
   * POST /v1/supply-order/items/add — добавить товары в поставку.
   */
  async addProductsToSupply(
    creds: Creds,
    supplyId: string,
    items: Array<{ sku: number; quantity: number }>,
  ): Promise<void> {
    await ozonPost('/v1/supply-order/items/add', {
      supply_order_id: supplyId,
      items: items.map(i => ({ sku: i.sku, quantity: i.quantity })),
    }, creds);
  },

  /**
   * POST /v1/supply-order/barcode — получить штрихкоды поставки (PDF).
   */
  async getSupplyBarcodes(
    creds: Creds,
    supplyId: string,
  ): Promise<Blob> {
    const res = await fetch(`${PROXY}/v1/supply-order/barcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': creds.client_id,
        'Api-Key': creds.api_key,
        'Accept': 'application/pdf',
      },
      body: JSON.stringify({ supply_order_id: supplyId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ozon ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  },

  /**
   * POST /v1/supply-order/submit — отправить поставку (перевести в статус "отправлено").
   */
  async sendSupply(
    creds: Creds,
    supplyId: string,
  ): Promise<void> {
    await ozonPost('/v1/supply-order/submit', { supply_order_id: supplyId }, creds);
  },

  /**
   * POST /v1/supply-order/list — список поставок.
   */
  async getSupplies(
    creds: Creds,
    status?: 'draft' | 'awaiting_deliver' | 'delivering' | 'delivered' | 'cancelled',
  ): Promise<any[]> {
    const all: any[] = [];
    const limit = 100;
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      const body: any = { limit, offset };
      if (status) body.status = status;
      const resp = await ozonPost<any>('/v1/supply-order/list', body, creds);
      const chunk: any[] = resp?.result?.supply_orders ?? resp?.supply_orders ?? [];
      all.push(...chunk);
      if (chunk.length < limit) break;
      offset += limit;
    }
    return all;
  },

  /**
   * POST /v1/supply-order/get — детали поставки.
   */
  async getSupplyDetails(
    creds: Creds,
    supplyId: string,
  ): Promise<any> {
    const resp = await ozonPost<any>('/v1/supply-order/get', { supply_order_id: supplyId }, creds);
    return resp?.result ?? resp;
  },

  /**
   * POST /v1/supply-order/cancel — отменить поставку.
   */
  async cancelSupply(
    creds: Creds,
    supplyId: string,
  ): Promise<void> {
    await ozonPost('/v1/supply-order/cancel', { supply_order_id: supplyId }, creds);
  },

  // ── Analytics (Аналитика) ──────────────────────────────────────────────────

  /**
   * POST /v1/analytics/data — детальная аналитика Ozon.
   */
  async getAnalyticsData(
    creds: Creds,
    params: {
      dateFrom: string;
      dateTo: string;
      metrics: string[];
      dimensions?: string[];
      filters?: Array<{ key: string; value: string }>;
      limit?: number;
    },
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/analytics/data', params, creds);
    return resp?.result?.data ?? resp?.data ?? [];
  },

  /**
   * POST /v2/products/info/statistics — статистика по конкретному товару.
   */
  async getProductStatistics(
    creds: Creds,
    productIds: number[],
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v2/products/info/statistics', {
      product_ids: productIds,
    }, creds);
    return resp?.result?.products ?? resp?.products ?? [];
  },

  /**
   * POST /v1/analytics/stock_on_warehouses — динамика остатков по складам.
   */
  async getStocksDynamics(
    creds: Creds,
    params: {
      productIds: number[];
      dateFrom: string;
      dateTo: string;
      warehouseIds?: number[];
    },
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/analytics/stock_on_warehouses', {
      product_ids: params.productIds,
      date_from: params.dateFrom,
      date_to: params.dateTo,
      warehouse_ids: params.warehouseIds,
    }, creds);
    return resp?.result ?? resp?.data ?? [];
  },

  // ── Advertising (Реклама) ──────────────────────────────────────────────────

  /**
   * POST /v1/actions/candidates — товары доступные для участия в акциях.
   */
  async getPromotionCandidates(
    creds: Creds,
    actionId: number,
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v1/actions/candidates', { action_id: actionId }, creds);
    return resp?.result?.products ?? resp?.products ?? [];
  },

  /**
   * GET /v1/actions — список доступных акций Ozon.
   */
  async getPromotions(creds: Creds): Promise<any[]> {
    const resp = await ozonGet<any>('/v1/actions', creds);
    return resp?.result ?? resp?.actions ?? [];
  },

  /**
   * POST /v1/actions/products — товары в акции и потенциальные участники.
   */
  async getPromoProducts(
    creds: Creds,
    actionId: number,
  ): Promise<{ activated: any[]; available: any[] }> {
    const activated: any[] = [];
    const available: any[] = [];
    const limit = 100;
    let offset = 0;
    while (true) {
      const resp = await ozonPost<any>('/v1/actions/products', { action_id: actionId, limit, offset }, creds);
      const act: any[] = resp?.result?.activated_products ?? [];
      const avl: any[] = resp?.result?.products ?? [];
      activated.push(...act);
      available.push(...avl);
      if (act.length < limit && avl.length < limit) break;
      offset += limit;
    }
    return { activated, available };
  },

  /**
   * POST /v1/actions/products/activate — добавить товары в акцию.
   */
  async activatePromoProducts(
    creds: Creds,
    actionId: number,
    products: Array<{ id: number; price: number }>,
  ): Promise<void> {
    await ozonPost('/v1/actions/products/activate', { action_id: actionId, products }, creds);
  },

  /**
   * POST /v1/actions/products/deactivate — убрать товары из акции.
   */
  async deactivatePromoProducts(
    creds: Creds,
    actionId: number,
    productIds: number[],
  ): Promise<void> {
    await ozonPost('/v1/actions/products/deactivate', { action_id: actionId, product_ids: productIds }, creds);
  },

  // ── Returns (Возвраты) ─────────────────────────────────────────────────────

  /**
   * POST /v3/returns/company/fbo — получить возвраты FBO.
   */
  async getFboReturns(
    creds: Creds,
    params: {
      limit?: number;
      offset?: number;
      filter?: {
        status?: string;
        posting_number?: string;
      };
    } = {},
  ): Promise<any[]> {
    const resp = await ozonPost<any>('/v3/returns/company/fbo', {
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      filter: params.filter ?? {},
    }, creds);
    return resp?.result?.returns ?? resp?.returns ?? [];
  },

  /**
   * POST /v2/returns/company/fbs — получить возвраты FBS.
   */
  async getFbsReturns(
    creds: Creds,
    params: {
      limit?: number;
      last_id?: string;
      filter?: {
        status?: string;
        posting_number?: string;
      };
    } = {},
  ): Promise<{ returns: any[]; last_id: string; has_next: boolean }> {
    const resp = await ozonPost<any>('/v2/returns/company/fbs', {
      limit: params.limit ?? 100,
      last_id: params.last_id ?? '',
      filter: params.filter ?? {},
    }, creds);
    return {
      returns: resp?.result?.returns ?? resp?.returns ?? [],
      last_id: resp?.result?.last_id ?? resp?.last_id ?? '',
      has_next: resp?.result?.has_next ?? resp?.has_next ?? false,
    };
  },

  // ── Content Management (Управление контентом) ──────────────────────────────

  /**
   * POST /v1/product/pictures/import — загрузить изображения для товара.
   */
  async uploadProductImages(
    creds: Creds,
    productId: number,
    images: Array<{ file_name: string; url: string }>,
  ): Promise<void> {
    await ozonPost('/v1/product/pictures/import', {
      product_id: productId,
      images,
    }, creds);
  },

  /**
   * POST /v1/product/import/pictures — массовая загрузка изображений.
   */
  async bulkUploadImages(
    creds: Creds,
    items: Array<{ product_id: number; images: Array<{ file_name: string; url: string }> }>,
  ): Promise<void> {
    await ozonPost('/v1/product/import/pictures', { items }, creds);
  },

  /**
   * POST /v1/product/info/description — получить Rich-контент товара.
   */
  async getRichProductDescription(
    creds: Creds,
    productId: number,
    offerId?: string,
  ): Promise<any> {
    const resp = await ozonPost<any>('/v1/product/info/description', {
      product_id: productId,
      offer_id: offerId,
    }, creds);
    return resp?.result ?? resp;
  },

  /**
   * POST /v1/product/update/description — обновить описание товара.
   */
  async updateProductDescription(
    creds: Creds,
    productId: number,
    description: string,
  ): Promise<void> {
    await ozonPost('/v1/product/update/description', {
      product_id: productId,
      description,
    }, creds);
  },
};

/** Получить актуальные остатки напрямую из API для конкретного магазина. */
export async function fetchOzonStocks(
  store: OzonStore,
): Promise<{ offer_id: string; fbs: number; fbo: number }[]> {
  const creds = { client_id: store.client_id, api_key: store.api_key };
  const result: { offer_id: string; fbs: number; fbo: number }[] = [];
  let cursor = '';
  do {
    const body: Record<string, unknown> = { filter: { visibility: 'ALL' }, limit: 1000 };
    if (cursor) body.cursor = cursor;
    let resp: any;
    try {
      resp = await ozonPost<OzonStocksResp>('/v4/product/info/stocks', body, creds);
    } catch (e) {
      console.error('[Ozon] fetchOzonStocks API error:', e);
      break;
    }
    // API v4 returns {items, total, cursor} at top level (not nested under result)
    const items: OzonStockItem[] = resp.items ?? resp.result?.items ?? [];
    for (const item of items) {
      const stocks: any[] = item.stocks || [];
      result.push({
        offer_id: item.offer_id,
        fbs: stocks.find((s: any) => s.type === 'fbs')?.present ?? 0,
        fbo: stocks.find((s: any) => s.type === 'fbo')?.present ?? 0,
      });
    }
    const nextCursor: string = resp.cursor ?? resp.result?.cursor ?? '';
    if (items.length < 1000 || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(400);
  } while (true);
  return result;
}

/** Обновить FBS-остатки на складе Ozon. */
export async function updateOzonFbsStock(
  store: OzonStore,
  items: { offer_id: string; stock: number; warehouse_id: number }[],
): Promise<{ offer_id: string; updated: boolean; errors: string[] }[]> {
  const creds = { client_id: store.client_id, api_key: store.api_key };
  const CHUNK = 100;
  const out: { offer_id: string; updated: boolean; errors: string[] }[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const resp = await ozonPost<any>('/v1/products/stocks', { stocks: items.slice(i, i + CHUNK) }, creds);
    for (const r of resp.result ?? []) {
      out.push({ offer_id: r.offer_id, updated: r.updated ?? false, errors: r.errors ?? [] });
    }
  }
  return out;
}

export async function fetchAllOzonProducts(
  store: OzonStore,
): Promise<Omit<OzonProduct, 'id'>[]> {
  const creds = { client_id: store.client_id, api_key: store.api_key };
  const ids = await ozonApi.getAllProductIds(creds);
  if (!ids.length) return [];
  const map = await ozonApi.getProductInfo(ids, creds);
  await ozonApi.overlayPrices(map, creds);
  await ozonApi.overlayStocks(map, creds);
  const now = new Date().toISOString();
  return Array.from(map.entries()).map(([offerId, info]) => {
    const dims = fromOzon({
      weight: info.weight, weight_unit: info.weight_unit,
      depth: info.depth, width: info.width, height: info.height,
      dimension_unit: info.dimension_unit,
    });
    return {
      store_id: store.id,
      offer_id: offerId,
      product_id: info.product_id,
      sku: info.sku || null,
      name: info.name,
      price: info.price,
      old_price: info.old_price,
      min_price: info.min_price,
      marketing_price: info.marketing_price > 0 ? info.marketing_price : null,
      stock_fbs: info.fbs,
      stock_fbo: info.fbo,
      category: '',
      images: info.images,
      barcode: info.barcode,
      status: info.status,
      synced_at: now,
      type_id: info.type_id || 0,
      description_category_id: info.description_category_id || 0,
      vat: info.vat ?? '',
      weight_kg: dims.weight_g != null ? +(dims.weight_g / 1000).toFixed(3) : null,
      length_cm: dims.length_mm != null ? +(dims.length_mm / 10).toFixed(1) : null,
      width_cm:  dims.width_mm  != null ? +(dims.width_mm  / 10).toFixed(1) : null,
      height_cm: dims.height_mm != null ? +(dims.height_mm / 10).toFixed(1) : null,
    };
  });
}

// ── Ozon Performance Advertising API (performance.ozon.ru) ─────────────────
// Proxied via /ozon-perf/ → performance.ozon.ru (separate domain from Seller API)

const PERF_PROXY = '/ozon-perf';

async function ozonPerfFetch<T>(
  method: string,
  endpoint: string,
  clientId: string,
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
  retries = 3,
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (attempt > 0) await sleep(Math.min(2000 * Math.pow(2, attempt - 1), 16000));
    const res = await fetch(`${PERF_PROXY}${endpoint}`, {
      method, signal,
      headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 204 || !ct.includes('application/json')) return undefined as T;
      return res.json() as Promise<T>;
    }
    const text = await res.text();
    console.error(`[OzonPerf] ${endpoint} → ${res.status}:`, text.slice(0, 300));
    lastErr = new Error(`Ozon Performance ${res.status} (${endpoint}): ${text.slice(0, 150)}`);
    if (!RETRYABLE.has(res.status)) throw lastErr;
  }
  throw lastErr;
}

export const ozonPerfApi = {
  /**
   * GET /api/1/campaign — список Performance-кампаний.
   */
  async getCampaigns(clientId: string, apiKey: string): Promise<any[]> {
    try {
      const resp = await ozonPerfFetch<any>('GET', '/api/1/campaign', clientId, apiKey);
      return resp?.list ?? resp?.items ?? [];
    } catch (err: any) {
      console.error('[ozonPerfApi] getCampaigns failed:', err?.message);
      return [];
    }
  },

  /**
   * POST /api/1/statistics/campaign — статистика кампаний за период.
   */
  async getStats(
    clientId: string,
    apiKey: string,
    params: { campaigns: string[]; dateFrom: string; dateTo: string },
  ): Promise<any[]> {
    try {
      const resp = await ozonPerfFetch<any>('POST', '/api/1/statistics/campaign', clientId, apiKey, params);
      const list: any[] = resp?.list ?? [];
      return list.map((entry: any) => {
        const rows: any[] = entry.statisticsDataByDate ?? [];
        return {
          ...entry.campaign,
          moneySpent: rows.reduce((s, r) => s + (r.moneySpent ?? 0), 0),
          clicks:     rows.reduce((s, r) => s + (r.clicks     ?? 0), 0),
          views:      rows.reduce((s, r) => s + (r.views ?? r.impressions ?? 0), 0),
          orders:     rows.reduce((s, r) => s + (r.orders     ?? 0), 0),
        };
      });
    } catch (err: any) {
      console.error('[ozonPerfApi] getStats failed:', err?.message);
      return [];
    }
  },

  /**
   * PATCH /api/1/campaign/{id} — пауза/запуск кампании.
   */
  async toggleCampaign(clientId: string, apiKey: string, campaignId: string, activate: boolean): Promise<void> {
    const action = activate ? 'activate' : 'deactivate';
    await ozonPerfFetch('POST', `/api/1/campaign/${campaignId}/${action}`, clientId, apiKey);
  },

  /**
   * GET /api/1/campaign/{id}/objects — объявления внутри кампании (SKU + ставки).
   */
  async getCampaignObjects(clientId: string, apiKey: string, campaignId: string): Promise<any[]> {
    try {
      const resp = await ozonPerfFetch<any>('GET', `/api/1/campaign/${campaignId}/objects`, clientId, apiKey);
      return resp?.list ?? resp?.objects ?? [];
    } catch (err: any) {
      console.error('[ozonPerfApi] getCampaignObjects failed:', err?.message);
      return [];
    }
  },

  /**
   * GET /api/1/budget — баланс Performance-кабинета.
   */
  async getBalance(clientId: string, apiKey: string): Promise<number> {
    try {
      const resp = await ozonPerfFetch<any>('GET', '/api/1/budget', clientId, apiKey);
      return resp?.money ?? resp?.balance ?? 0;
    } catch (err: any) {
      console.error('[ozonPerfApi] getBalance failed:', err?.message);
      return 0;
    }
  },
};
