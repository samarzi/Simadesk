/**
 * Netlify Function: mrc-scan
 *
 * Серверный сканер МРЦ — запускается внешним cron (cron-job.org и т.п.)
 * каждые N минут. Читает все активные MRC-правила из Supabase,
 * получает текущие цены с маркетплейсов и корректирует их при отклонении > 2 ₽.
 *
 * Аутентификация: заголовок X-Cron-Secret должен совпадать с env MRC_CRON_SECRET.
 * Использует SUPA_SERVICE_KEY (service role) — обходит RLS, видит все компании.
 *
 * Настройка в Netlify Dashboard → Environment variables:
 *   SUPA_URL          = https://rdqwzojrsmbdxiczqjci.supabase.co
 *   SUPA_SERVICE_KEY  = <service_role key из Supabase>
 *   MRC_CRON_SECRET   = <любая случайная строка>
 *
 * Внешний cron: POST https://sabatov.netlify.app/.netlify/functions/mrc-scan
 *               Header: X-Cron-Secret: <your secret>
 *               Interval: every 15 minutes
 */

const SUPA_URL         = process.env.SUPA_URL         ?? process.env.VITE_SUPA_URL ?? '';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY ?? '';
const CRON_SECRET      = process.env.MRC_CRON_SECRET  ?? '';

const WB_PRICES_BASE  = 'https://discounts-prices-api.wildberries.ru';
const OZON_BASE       = 'https://api-seller.ozon.ru';
const YM_BASE         = 'https://api.partner.market.yandex.ru';

// ── Supabase helpers ──────────────────────────────────────────────────────────

function supaHeaders(): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPA_SERVICE_KEY,
    'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
    'Prefer':        'return=representation',
  };
}

async function supaGet<T>(table: string, query: string): Promise<T[]> {
  const url = `${SUPA_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T[]>;
}

async function supaUpsert(table: string, rows: object[]): Promise<void> {
  if (!rows.length) return;
  const url = `${SUPA_URL}/rest/v1/${table}?on_conflict=id`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...supaHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${res.status} ${await res.text()}`);
}

// ── Price math ────────────────────────────────────────────────────────────────

function computeRequiredSellerPrice(
  mrcPrice: number, sellerPrice: number, buyerPrice: number,
): number {
  if (sellerPrice > 0 && buyerPrice > 0) return Math.ceil(mrcPrice * sellerPrice / buyerPrice);
  return Math.ceil(mrcPrice * 1.15);
}

function needsUpdate(buyerPrice: number, mrcPrice: number): boolean {
  return Math.abs(buyerPrice - mrcPrice) > 2;
}

// ── Ozon ──────────────────────────────────────────────────────────────────────

async function ozonPost<T>(path: string, body: object, clientId: string, apiKey: string): Promise<T> {
  const res = await fetch(`${OZON_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ozon ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function getOzonPrices(
  offerIds: string[], clientId: string, apiKey: string,
): Promise<Map<string, { marketingPrice: number; sellerPrice: number }>> {
  const result = new Map<string, { marketingPrice: number; sellerPrice: number }>();
  const resp = await ozonPost<any>('/v5/product/info/prices',
    { filter: { offer_id: offerIds, visibility: 'ALL' }, limit: offerIds.length },
    clientId, apiKey);
  for (const item of resp?.items ?? resp?.result?.items ?? []) {
    const sellerPrice  = parseFloat(item.price?.price ?? '0') || 0;
    const rawMkt       = item.price?.marketing_price ?? item.price?.marketing_seller_price;
    const marketingPrice = rawMkt ? (parseFloat(String(rawMkt)) || sellerPrice) : sellerPrice;
    if (item.offer_id && sellerPrice > 0) {
      const entry = { marketingPrice, sellerPrice };
      result.set(item.offer_id, entry);
      result.set(item.offer_id.toLowerCase(), entry);
    }
  }
  return result;
}

async function updateOzonPrices(
  prices: Array<{ offer_id: string; price: string; min_price: string }>,
  clientId: string, apiKey: string,
): Promise<void> {
  for (let i = 0; i < prices.length; i += 100) {
    await ozonPost('/v1/product/import/prices', { prices: prices.slice(i, i + 100) }, clientId, apiKey);
  }
}

// ── Wildberries ───────────────────────────────────────────────────────────────

async function getWbPrices(
  nmIds: number[], apiKey: string,
): Promise<Map<number, { price: number; discount: number; priceWithDisc: number }>> {
  const result = new Map<number, { price: number; discount: number; priceWithDisc: number }>();
  const res = await fetch(`${WB_PRICES_BASE}/api/v2/list/goods/filter?filterNmIds=${nmIds.join(',')}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) throw new Error(`WB prices: ${res.status}`);
  const data = await res.json();
  for (const item of data?.data?.listGoods ?? []) {
    const p = item.sizes?.[0] ?? item;
    const price = Number(item.price ?? p.price ?? 0);
    const discount = Number(item.discount ?? p.discount ?? 0);
    const priceWithDisc = Math.ceil(price * (1 - discount / 100));
    if (price > 0) result.set(Number(item.nmID ?? item.nmId), { price, discount, priceWithDisc });
  }
  return result;
}

async function updateWbPrices(
  updates: Array<{ nmID: number; price: number; discount: number }>, apiKey: string,
): Promise<void> {
  const body = { data: updates.map(u => ({ nmID: u.nmID, price: u.price, discount: u.discount })) };
  const res = await fetch(`${WB_PRICES_BASE}/api/v2/upload/task`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`WB update prices: ${res.status}`);
}

// ── Яндекс Маркет ─────────────────────────────────────────────────────────────

async function ymGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${YM_BASE}${path}`, {
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`YM ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function ymPost<T>(path: string, body: object, apiKey: string): Promise<T> {
  const res = await fetch(`${YM_BASE}${path}`, {
    method:  'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YM ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function getYmBusinessId(campaignId: number, apiKey: string): Promise<number> {
  const data = await ymGet<any>(`/campaigns/${campaignId}`, apiKey);
  return data?.campaign?.business?.id ?? 0;
}

async function getYmOfferPrices(
  campaignId: number, apiKey: string,
): Promise<Map<string, { price: number; discountBase?: number }>> {
  const result = new Map<string, { price: number; discountBase?: number }>();
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = `/campaigns/${campaignId}/offer-prices?pageSize=200${pageToken ? `&page_token=${pageToken}` : ''}`;
    const data = await ymGet<any>(url, apiKey);
    for (const o of data?.result?.offers ?? []) {
      if (o.id && o.price?.value) {
        result.set(o.id, { price: o.price.value, discountBase: o.price.discountBase });
      }
    }
    pageToken = data?.result?.paging?.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return result;
}

async function updateYmOfferPrices(
  businessId: number,
  offers: Array<{ offerId: string; price: number; oldPrice?: number }>,
  apiKey: string,
): Promise<void> {
  const body = {
    offerMappings: offers.map(o => {
      const discountPct = o.oldPrice ? (o.oldPrice - o.price) / o.oldPrice * 100 : 0;
      const validDiscount = discountPct >= 5 && discountPct <= 99;
      return {
        offer: {
          offerId: o.offerId,
          basicPrice: {
            value: o.price, currencyId: 'RUR',
            ...(validDiscount ? { discountBase: o.oldPrice } : {}),
          },
        },
      };
    }),
  };
  await ymPost(`/businesses/${businessId}/offer-mappings/update`, body, apiKey);
}

// ── Scan logic ────────────────────────────────────────────────────────────────

interface ScanResult {
  marketplace: string;
  storeId: string;
  offerId: string;
  vendorCode: string;
  mrcPrice: number;
  buyerPrice: number;
  sellerPrice: number;
  action: 'ok' | 'adjusted' | 'error';
  newPrice?: number;
  error?: string;
}

async function scanAll(): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  // Load all active MRC rules across all companies
  const rulesRows = await supaGet<{ id: string; company_id: string; data: any }>(
    'repricer_rules',
    'select=id,company_id,data',
  );
  const mrcRules = rulesRows
    .map(r => ({ ...r.data, id: r.id, company_id: r.company_id }))
    .filter((r: any) => r.status === 'active' && r.type === 'mrc' && r.mrcPrice > 0);

  if (!mrcRules.length) return results;

  // Group by store per marketplace to batch API calls
  const byOzon = new Map<string, { storeId: string; clientId: string; apiKey: string; rules: any[] }>();
  const byWb   = new Map<string, { storeId: string; apiKey: string; rules: any[] }>();
  const byYm   = new Map<string, { storeId: string; campaignId: number; apiKey: string; rules: any[] }>();

  // Load stores for all companies mentioned in rules
  const companyIds = [...new Set(mrcRules.map((r: any) => r.company_id))];

  for (const cid of companyIds) {
    const [ozonStores, wbStores, ymStores] = await Promise.all([
      supaGet<any>('ozon_stores', `company_id=eq.${cid}&select=id,client_id,api_key`),
      supaGet<any>('wb_stores',   `company_id=eq.${cid}&select=id,api_key`),
      supaGet<any>('yandex_stores', `company_id=eq.${cid}&select=id,api_key,campaign_id`),
    ]);
    for (const s of ozonStores) byOzon.set(s.id, { storeId: s.id, clientId: s.client_id, apiKey: s.api_key, rules: [] });
    for (const s of wbStores)   byWb.set(s.id,   { storeId: s.id, apiKey: s.api_key, rules: [] });
    for (const s of ymStores)   byYm.set(s.id,   { storeId: s.id, campaignId: s.campaign_id, apiKey: s.api_key, rules: [] });
  }

  for (const rule of mrcRules) {
    if (rule.marketplace === 'ozon'   && byOzon.has(rule.storeId)) byOzon.get(rule.storeId)!.rules.push(rule);
    if (rule.marketplace === 'wb'     && byWb.has(rule.storeId))   byWb.get(rule.storeId)!.rules.push(rule);
    if (rule.marketplace === 'yandex' && byYm.has(rule.storeId))   byYm.get(rule.storeId)!.rules.push(rule);
  }

  // ── Ozon ────────────────────────────────────────────────────────────────────
  for (const { storeId, clientId, apiKey, rules } of byOzon.values()) {
    if (!rules.length) continue;
    const allProds = rules.flatMap((r: any) => (r.products ?? []).map((p: any) => ({ rule: r, prod: p })));
    const offerIds = [...new Set(allProds.map((x: any) => x.prod.productId as string))];
    try {
      const priceMap = await getOzonPrices(offerIds, clientId, apiKey);
      const updates: Array<{ offer_id: string; price: string; min_price: string }> = [];
      for (const { rule, prod } of allProds) {
        const d = priceMap.get(prod.productId) ?? priceMap.get((prod.productId as string).toLowerCase());
        if (!d) { results.push({ marketplace: 'ozon', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: 'Товар не найден' }); continue; }
        const { marketingPrice: buyerPrice, sellerPrice } = d;
        const mrcPrice = rule.mrcPrice as number;
        if (needsUpdate(buyerPrice, mrcPrice)) {
          const required = computeRequiredSellerPrice(mrcPrice, sellerPrice, buyerPrice);
          const newSeller = rule.maxPrice ? Math.min(required, rule.maxPrice) : required;
          updates.push({ offer_id: prod.productId, price: String(newSeller), min_price: String(mrcPrice) });
          results.push({ marketplace: 'ozon', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice, action: 'adjusted', newPrice: newSeller });
        } else {
          results.push({ marketplace: 'ozon', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice, action: 'ok' });
        }
      }
      if (updates.length) await updateOzonPrices(updates, clientId, apiKey);
    } catch (e: any) {
      for (const { rule, prod } of allProds) results.push({ marketplace: 'ozon', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: String(e?.message).slice(0, 120) });
    }
  }

  // ── WB ──────────────────────────────────────────────────────────────────────
  for (const { storeId, apiKey, rules } of byWb.values()) {
    if (!rules.length) continue;
    const allProds = rules.flatMap((r: any) => (r.products ?? []).map((p: any) => ({ rule: r, prod: p })));
    const nmIds = [...new Set(allProds.map((x: any) => Number(x.prod.productId)).filter(n => n > 0))];
    try {
      const priceMap = await getWbPrices(nmIds, apiKey);
      const updates: Array<{ nmID: number; price: number; discount: number }> = [];
      for (const { rule, prod } of allProds) {
        const d = priceMap.get(Number(prod.productId));
        if (!d) { results.push({ marketplace: 'wb', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: 'Товар не найден' }); continue; }
        const { price: sellerPrice, discount, priceWithDisc: buyerPrice } = d;
        const mrcPrice = rule.mrcPrice as number;
        if (needsUpdate(buyerPrice, mrcPrice)) {
          const ratio = 1 - discount / 100;
          const required = ratio > 0 ? Math.ceil(mrcPrice / ratio) : computeRequiredSellerPrice(mrcPrice, sellerPrice, buyerPrice);
          const newSeller = rule.maxPrice ? Math.min(required, rule.maxPrice) : required;
          updates.push({ nmID: Number(prod.productId), price: newSeller, discount });
          results.push({ marketplace: 'wb', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice, action: 'adjusted', newPrice: newSeller });
        } else {
          results.push({ marketplace: 'wb', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice, action: 'ok' });
        }
      }
      if (updates.length) await updateWbPrices(updates, apiKey);
    } catch (e: any) {
      for (const { rule, prod } of allProds) results.push({ marketplace: 'wb', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: String(e?.message).slice(0, 120) });
    }
  }

  // ── Яндекс Маркет ───────────────────────────────────────────────────────────
  for (const { storeId, campaignId, apiKey, rules } of byYm.values()) {
    if (!rules.length || !campaignId) continue;
    const allProds = rules.flatMap((r: any) => (r.products ?? []).map((p: any) => ({ rule: r, prod: p })));
    try {
      const [priceMap, businessId] = await Promise.all([
        getYmOfferPrices(campaignId, apiKey),
        getYmBusinessId(campaignId, apiKey),
      ]);
      if (!businessId) throw new Error('Не удалось получить businessId');
      const updates: Array<{ offerId: string; price: number; oldPrice?: number }> = [];
      for (const { rule, prod } of allProds) {
        const d = priceMap.get(prod.productId);
        const catalogPrice = d?.discountBase ?? 0;
        const buyerPrice   = d?.price ?? catalogPrice;
        if (!buyerPrice) { results.push({ marketplace: 'yandex', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: 'Цена не найдена' }); continue; }
        const mrcPrice = rule.mrcPrice as number;
        if (needsUpdate(buyerPrice, mrcPrice)) {
          const required = computeRequiredSellerPrice(mrcPrice, catalogPrice || buyerPrice, buyerPrice);
          const newCatalog = rule.maxPrice ? Math.min(required, rule.maxPrice) : required;
          updates.push({ offerId: prod.productId, price: newCatalog, oldPrice: catalogPrice || undefined });
          results.push({ marketplace: 'yandex', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice: catalogPrice, action: 'adjusted', newPrice: newCatalog });
        } else {
          results.push({ marketplace: 'yandex', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice, buyerPrice, sellerPrice: catalogPrice, action: 'ok' });
        }
      }
      if (updates.length) await updateYmOfferPrices(businessId, updates, apiKey);
    } catch (e: any) {
      for (const { rule, prod } of allProds) results.push({ marketplace: 'yandex', storeId, offerId: prod.productId, vendorCode: prod.vendorCode, mrcPrice: rule.mrcPrice, buyerPrice: 0, sellerPrice: 0, action: 'error', error: String(e?.message).slice(0, 120) });
    }
  }

  return results;
}

// ── Netlify handler ───────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  // Auth check
  const secret = event.headers?.['x-cron-secret'] ?? event.queryStringParameters?.secret ?? '';
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!SUPA_URL || !SUPA_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing SUPA_URL or SUPA_SERVICE_KEY env vars' }) };
  }

  const startedAt = new Date().toISOString();
  try {
    const results = await scanAll();
    const adjusted = results.filter(r => r.action === 'adjusted').length;
    const errors   = results.filter(r => r.action === 'error').length;
    const ok       = results.filter(r => r.action === 'ok').length;

    // Persist scan events to repricer_events table (if it exists)
    if (results.length) {
      const rows = results.map(r => ({
        id:          crypto.randomUUID(),
        created_at:  startedAt,
        event_type:  'mrc_scan',
        marketplace: r.marketplace,
        store_id:    r.storeId,
        offer_id:    r.offerId,
        vendor_code: r.vendorCode,
        mrc_price:   r.mrcPrice,
        buyer_price: r.buyerPrice,
        seller_price: r.sellerPrice,
        new_price:   r.newPrice ?? null,
        action:      r.action,
        error_msg:   r.error ?? null,
      }));
      await supaUpsert('repricer_events', rows).catch(() => {/* table may not exist yet */});
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startedAt, total: results.length, adjusted, ok, errors, results }),
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e?.message ?? 'Unknown error', startedAt }),
    };
  }
};
