/**
 * Supabase Edge Function — серверный скан и коррекция цен по правилам МРЦ
 * (WB / Ozon / Яндекс.Маркет), независимо от того, открыта ли вкладка SimaDesk.
 *
 * Логика — портированная копия MRC-блока из src/modules/RepricerModule.ts.
 * Состояние (discountFactor, lastUpdateAt и т.п.) хранится прямо в
 * repricer_rules.data.mrcState — отдельная таблица не нужна.
 *
 * Подробный лог каждого изменения цены пишется в repricer_events,
 * ошибки API — в repricer_errors (см. supabase/migrations).
 *
 * Запускается по расписанию через pg_cron (см. supabase/migrations).
 * Требует авторизации (Authorization: Bearer <anon|service_role key>) — pg_cron
 * передаёт ключ через pg_net.http_post.
 * Deploy: supabase functions deploy mrc-scan --project-ref rdqwzojrsmbdxiczqjci
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ── Константы (как в RepricerModule.ts) ─────────────────────────────────────
const PRODUCT_COOLDOWN_MS = 3_600_000; // 1 час между корректировками одного товара
const MAX_CHANGE_PCT      = 0.20;      // не двигаем цену больше чем на ±20% за цикл
const DEVIATION_THRESHOLD = 0.01;      // 1% — порог отклонения витрины от МРЦ
const FACTOR_ALPHA        = 0.30;      // EMA для discountFactor

const WB_CHUNK_SIZE   = 20;            // сколько nmID запрашивать за один вызов list/goods/filter
const WB_CARD_DEST    = '-1257786';    // регион (Москва) для расчёта цены покупателя card.wb.ru с учётом СПП
const OZON_CHUNK_SIZE = 1000;          // лимит offer_id за один вызов v5/product/info/prices
const VERIFY_DELAY_MS = 5000;          // пауза перед повторной проверкой цены после корректировки
const YANDEX_SHOWCASE_STALE_MS = 6 * 3600 * 1000; // макс. возраст данных yandex_buyer_prices, собранных расширением

interface MrcState {
  discountFactor: number;
  lastUpdateAt: string | null;
  lastSellerPrice: number;
  lastShowcasePrice: number;
}

function emptyState(): MrcState {
  return { discountFactor: 1, lastUpdateAt: null, lastSellerPrice: 0, lastShowcasePrice: 0 };
}

function mrcEffectiveTarget(mrcPrice: number, mrcBuffer?: number): number {
  const buffer = mrcBuffer ?? 0;
  if (buffer <= 0 || buffer >= 100) return mrcPrice;
  return Math.round(mrcPrice / (1 - buffer / 100));
}

function computeNewSellerPrice(target: number, currentSeller: number, showcase: number): number {
  const ratio   = target / showcase;
  const raw     = Math.ceil(currentSeller * ratio);
  const maxDiff = Math.ceil(currentSeller * MAX_CHANGE_PCT);
  return Math.min(currentSeller + maxDiff, Math.max(currentSeller - maxDiff, raw));
}

function deviated(showcase: number, target: number): boolean {
  if (target <= 0 || showcase <= 0) return false;
  return Math.abs(showcase - target) / target > DEVIATION_THRESHOLD;
}

function isCooling(lastUpdateAt: string | null): boolean {
  if (!lastUpdateAt) return false;
  return Date.now() - new Date(lastUpdateAt).getTime() < PRODUCT_COOLDOWN_MS;
}

function updateFactor(state: MrcState, showcase: number, seller: number): void {
  if (seller <= 0 || showcase <= 0) return;
  const observed = showcase / seller;
  const prev     = state.discountFactor > 0 ? state.discountFactor : observed;
  state.discountFactor    = FACTOR_ALPHA * observed + (1 - FACTOR_ALPHA) * prev;
  state.lastSellerPrice    = seller;
  state.lastShowcasePrice  = showcase;
}

interface RuleProduct { productId: string; vendorCode: string; productTitle: string; }
function ruleProducts(d: any): RuleProduct[] {
  if (Array.isArray(d.products) && d.products.length > 0) return d.products;
  return [{ productId: d.productId, vendorCode: d.vendorCode, productTitle: d.productTitle }];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Логирование (repricer_events / repricer_errors) ─────────────────────────
async function logEvent(supabase: any, ev: Record<string, any>): Promise<void> {
  try {
    await supabase.from('repricer_events').insert(ev);
  } catch {
    // лог не должен валить основной сканер
  }
}

async function logError(supabase: any, err: Record<string, any>): Promise<void> {
  try {
    await supabase.from('repricer_errors').insert(err);
  } catch {
    // лог не должен валить основной сканер
  }
}

// ── WB ───────────────────────────────────────────────────────────────────────
async function fetchWbGoods(
  apiKey: string,
  nmIds: number[],
  supabase: any,
): Promise<Map<number, { price: number; discount: number; discountedPrice: number }>> {
  const priceMap = new Map<number, { price: number; discount: number; discountedPrice: number }>();

  for (let i = 0; i < nmIds.length; i += WB_CHUNK_SIZE) {
    const chunk = nmIds.slice(i, i + WB_CHUNK_SIZE);
    const params = new URLSearchParams({ limit: '1000', filterNmID: chunk.join(',') });
    const url = `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?${params}`;

    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch(url, { headers: { Authorization: apiKey } });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
    }
    if (!resp) continue;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await logError(supabase, {
        marketplace: 'wb',
        product_id: chunk.join(','),
        request: { filterNmID: chunk },
        response: { body: text.slice(0, 500) },
        http_status: resp.status,
        error: 'list/goods/filter failed',
      });
      continue;
    }

    const data = await resp.json();
    const items: any[] = data?.data?.listGoods ?? [];
    for (const item of items) {
      const nmID = Number(item.nmID);
      const price = Number(item.sizes?.[0]?.price ?? 0);
      const discount = Number(item.discount ?? 0);
      const discountedPrice = Number(item.sizes?.[0]?.discountedPrice ?? 0) || Math.ceil(price * (1 - discount / 100));
      if (nmID > 0 && price > 0) priceMap.set(nmID, { price, discount, discountedPrice });
    }
  }

  return priceMap;
}

/**
 * Реальная цена для покупателя с учётом СПП (скидки постоянного покупателя WB).
 * Публичный эндпоинт карточки товара (используется самим сайтом wildberries.ru,
 * не требует авторизации). price.basic — цена до СПП (= "без WB Кошелька" из
 * продавецкой API), price.product — итоговая цена, которую видит покупатель.
 */
async function fetchWbBuyerPrices(
  nmIds: number[],
  supabase: any,
): Promise<Map<number, { basic: number; product: number }>> {
  const result = new Map<number, { basic: number; product: number }>();

  for (let i = 0; i < nmIds.length; i += WB_CHUNK_SIZE) {
    const chunk = nmIds.slice(i, i + WB_CHUNK_SIZE);
    const url = `https://card.wb.ru/cards/v4/list?appType=1&curr=rub&dest=${WB_CARD_DEST}&spp=30&nm=${chunk.join(';')}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        await logError(supabase, {
          marketplace: 'wb', product_id: chunk.join(','),
          request: { url }, response: null, http_status: resp.status,
          error: 'card.wb.ru/cards/v4/list failed',
        });
        continue;
      }
      const data = await resp.json();
      const products: any[] = data?.products ?? [];
      for (const p of products) {
        const size = p.sizes?.[0];
        const basic = Number(size?.price?.basic ?? 0) / 100;
        const product = Number(size?.price?.product ?? 0) / 100;
        if (p.id && product > 0) result.set(Number(p.id), { basic, product });
      }
    } catch (e: any) {
      await logError(supabase, {
        marketplace: 'wb', product_id: chunk.join(','),
        request: { url }, response: null, http_status: null,
        error: e?.message ?? String(e),
      });
    }
  }

  return result;
}

async function uploadWbPrices(
  apiKey: string,
  updates: Array<{ nmID: number; price: number; discount?: number }>,
  store: any,
  supabase: any,
  log: any[],
): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < updates.length; i += 1000) {
    const batch = updates.slice(i, i + 1000);
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch('https://discounts-prices-api.wildberries.ru/api/v2/upload/task', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: batch }),
      });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
    if (!resp) { ok = false; continue; }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      ok = false;
      log.push({ mp: 'wb', store: store.name, error: `upload ${resp.status}: ${text.slice(0, 200)}` });
      await logError(supabase, {
        marketplace: 'wb',
        product_id: batch.map(b => b.nmID).join(','),
        request: { data: batch },
        response: { body: text.slice(0, 500) },
        http_status: resp.status,
        error: 'upload/task failed',
      });
    }
  }
  return ok;
}

async function processWb(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = new Map<string, any[]>();
  for (const r of rules) {
    const list = byStore.get(r.data.storeId) ?? [];
    list.push(r); byStore.set(r.data.storeId, list);
  }

  for (const [storeId, storeRules] of byStore) {
    const { data: store } = await supabase.from('wb_stores').select('api_key, name').eq('id', storeId).single();
    if (!store?.api_key) { log.push({ mp: 'wb', storeId, error: 'store not found' }); continue; }

    const allItems: Array<{ rule: any; prod: RuleProduct }> = [];
    for (const rule of storeRules) for (const prod of ruleProducts(rule.data)) allItems.push({ rule, prod });
    const nmIds = [...new Set(allItems.map(x => Number(x.prod.productId)))].filter(n => n > 0);
    if (nmIds.length === 0) continue;

    const priceMap = await fetchWbGoods(store.api_key, nmIds, supabase);
    const buyerPriceMap = await fetchWbBuyerPrices(nmIds, supabase);

    const updates: Array<{ nmID: number; price: number; discount?: number }> = [];
    // запоминаем контекст для пост-проверки (Block 6) и для отметки кулдауна только при успехе
    const adjustedCtx = new Map<number, { rule: any; prod: RuleProduct; target: number; oldSeller: number; oldShowcase: number; newSeller: number; state: MrcState; mrcState: Record<string, MrcState> }>();

    for (const { rule, prod } of allItems) {
      const nmID = Number(prod.productId);
      const data = priceMap.get(nmID);
      if (!data || !data.price) {
        await logError(supabase, {
          marketplace: 'wb', product_id: prod.productId,
          request: { filterNmID: [nmID] }, response: null, http_status: null,
          error: 'no price data returned for nmID',
        });
        continue;
      }

      const mrcPrice = rule.data.mrcPrice ?? 0;
      const target   = mrcEffectiveTarget(mrcPrice, rule.data.mrcBuffer);
      // Реальная цена покупателя (с учётом СПП), если доступна с card.wb.ru —
      // иначе fallback на discountedPrice ("без WB Кошелька") из продавецкой API.
      const buyerData  = buyerPriceMap.get(nmID);
      const showcase   = buyerData?.product ?? data.discountedPrice;
      const priceSource = buyerData?.product ? 'card.wb.ru (с СПП)' : 'discountedPrice';
      const seller     = data.price;

      const mrcState: Record<string, MrcState> = rule.data.mrcState ?? {};
      const state = mrcState[prod.productId] ?? emptyState();
      updateFactor(state, showcase, seller);

      if (!deviated(showcase, target) || isCooling(state.lastUpdateAt)) {
        mrcState[prod.productId] = state;
        rule.data.mrcState = mrcState;
        log.push({ mp: 'wb', store: store.name, nmID, mrcPrice, showcase, priceSource, action: deviated(showcase, target) ? 'cooldown' : 'ok' });
        continue;
      }

      let newSeller = computeNewSellerPrice(target, seller, showcase);
      if (rule.data.maxPrice) newSeller = Math.min(newSeller, rule.data.maxPrice);

      updates.push({ nmID, price: newSeller, discount: data.discount });
      adjustedCtx.set(nmID, { rule, prod, target, oldSeller: seller, oldShowcase: showcase, newSeller, state, mrcState });
      mrcState[prod.productId] = state;
      rule.data.mrcState = mrcState;
      log.push({ mp: 'wb', store: store.name, nmID, mrcPrice, showcase, priceSource, oldSeller: seller, newSeller, action: 'adjusted' });
    }

    if (updates.length > 0) {
      const ok = await uploadWbPrices(store.api_key, updates, store, supabase, log);

      for (const { rule, prod, target, oldSeller, oldShowcase, newSeller, state, mrcState } of adjustedCtx.values()) {
        // Кулдаун выставляем только при успешной загрузке — иначе цена не изменилась,
        // и следующая попытка не должна ждать час из-за чужого 429.
        if (ok) {
          state.lastUpdateAt = new Date().toISOString();
          mrcState[prod.productId] = state;
          rule.data.mrcState = mrcState;
          rule.data.lastAppliedAt = new Date().toISOString();
        }
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'wb', store_name: store.name,
          product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
          old_seller_price: oldSeller, new_seller_price: newSeller, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { nmID: Number(prod.productId), price: newSeller },
          api_response: { ok },
          success: ok, error: ok ? null : 'upload/task failed',
        });
      }

      // Block 6: пост-проверка — что реально увидел покупатель после коррекции
      if (ok) {
        await sleep(VERIFY_DELAY_MS);
        const verifyMap = await fetchWbGoods(store.api_key, [...adjustedCtx.keys()], supabase);
        const verifyBuyerMap = await fetchWbBuyerPrices([...adjustedCtx.keys()], supabase);
        const followUps: Array<{ nmID: number; price: number; discount?: number }> = [];

        for (const [nmID, ctx] of adjustedCtx) {
          const { rule, prod, target, newSeller } = ctx;
          const verified = verifyMap.get(nmID);
          const verifiedBuyer = verifyBuyerMap.get(nmID);
          const verifiedShowcase = verifiedBuyer?.product ?? verified?.discountedPrice ?? 0;
          const stillDeviated = deviated(verifiedShowcase, target);

          log.push({ mp: 'wb', store: store.name, nmID, mrcPrice: rule.data.mrcPrice, verifiedShowcase, target, action: stillDeviated ? 'verify_adjusted' : 'verify_ok' });
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'wb', store_name: store.name,
            product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
            old_seller_price: newSeller, new_seller_price: null, old_buyer_price: null,
            verified_buyer_price: verifiedShowcase, target_mrc_price: target,
            action: stillDeviated ? 'verify_adjusted' : 'verify_ok',
            api_request: null, api_response: { discountedPrice: verifiedShowcase }, success: !stillDeviated,
            error: stillDeviated ? 'buyer price still deviates from MRC after adjustment' : null,
          });

          if (stillDeviated && verified && verified.price > 0) {
            let correction = computeNewSellerPrice(target, newSeller, verifiedShowcase);
            if (rule.data.maxPrice) correction = Math.min(correction, rule.data.maxPrice);
            if (correction !== newSeller) {
              followUps.push({ nmID, price: correction, discount: verified.discount });
              const mrcState: Record<string, MrcState> = rule.data.mrcState ?? {};
              const state = mrcState[prod.productId] ?? emptyState();
              updateFactor(state, verifiedShowcase, newSeller);
              mrcState[prod.productId] = state;
              rule.data.mrcState = mrcState;

              await logEvent(supabase, {
                rule_id: rule.id, marketplace: 'wb', store_name: store.name,
                product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
                old_seller_price: newSeller, new_seller_price: correction, old_buyer_price: verifiedShowcase,
                target_mrc_price: target, action: 'verify_correction',
                api_request: { nmID, price: correction }, api_response: null, success: true, error: null,
              });
            }
          }
        }

        if (followUps.length > 0) {
          await uploadWbPrices(store.api_key, followUps, store, supabase, log);
        }
      }
    }

    for (const rule of storeRules) {
      await supabase.from('repricer_rules').update({ data: rule.data }).eq('id', rule.id);
    }
  }
}

// ── Ozon ─────────────────────────────────────────────────────────────────────
async function fetchOzonPrices(
  headers: Record<string, string>,
  offerIds: string[],
  store: any,
  supabase: any,
): Promise<Map<string, { price: number; oldPrice: number; marketingPrice: number }>> {
  const priceMap = new Map<string, { price: number; oldPrice: number; marketingPrice: number }>();

  for (let i = 0; i < offerIds.length; i += OZON_CHUNK_SIZE) {
    const chunk = offerIds.slice(i, i + OZON_CHUNK_SIZE);
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { offer_id: chunk, visibility: 'ALL' }, limit: chunk.length }),
      });
      if (resp.status !== 429) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
    if (!resp) continue;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await logError(supabase, {
        marketplace: 'ozon', product_id: chunk.join(','),
        request: { filter: { offer_id: chunk } }, response: { body: text.slice(0, 500) },
        http_status: resp.status, error: 'info/prices failed',
      });
      continue;
    }

    const respJson = await resp.json();
    const items: any[] = respJson.items || respJson.result?.items || [];
    for (const item of items) {
      const price = parseFloat(item.price?.price || '0') || 0;
      const oldPrice = parseFloat(item.price?.old_price || '0') || 0;
      const rawMarketing = item.price?.marketing_price ?? item.price?.marketing_seller_price;
      const marketingPrice = (rawMarketing ? parseFloat(String(rawMarketing)) : 0) || price;
      if (item.offer_id && price > 0) priceMap.set(item.offer_id, { price, oldPrice, marketingPrice });
    }
  }

  return priceMap;
}

async function processOzon(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = new Map<string, any[]>();
  for (const r of rules) {
    const list = byStore.get(r.data.storeId) ?? [];
    list.push(r); byStore.set(r.data.storeId, list);
  }

  for (const [storeId, storeRules] of byStore) {
    const { data: store } = await supabase.from('ozon_stores').select('client_id, api_key, name').eq('id', storeId).single();
    if (!store?.api_key) { log.push({ mp: 'ozon', storeId, error: 'store not found' }); continue; }

    const headers = { 'Content-Type': 'application/json', 'Client-Id': store.client_id, 'Api-Key': store.api_key };

    const allItems: Array<{ rule: any; prod: RuleProduct }> = [];
    for (const rule of storeRules) for (const prod of ruleProducts(rule.data)) allItems.push({ rule, prod });
    const offerIds = [...new Set(allItems.map(x => x.prod.productId))];
    if (offerIds.length === 0) continue;

    const priceMap = await fetchOzonPrices(headers, offerIds, store, supabase);

    const updates: Array<{ offer_id: string; price: string; old_price?: string; min_price: string; auto_action_enabled: 'DISABLED' }> = [];
    const adjustedCtx = new Map<string, { rule: any; prod: RuleProduct; target: number; oldSeller: number; oldShowcase: number; newSeller: number }>();

    for (const { rule, prod } of allItems) {
      const data = priceMap.get(prod.productId);
      if (!data) {
        await logError(supabase, {
          marketplace: 'ozon', product_id: prod.productId,
          request: { offer_id: prod.productId }, response: null, http_status: null,
          error: 'no price data returned for offer_id',
        });
        continue;
      }

      const mrcPrice = rule.data.mrcPrice ?? 0;
      const target   = mrcEffectiveTarget(mrcPrice, rule.data.mrcBuffer);
      const showcase = data.marketingPrice;
      const seller   = data.price;

      const mrcState: Record<string, MrcState> = rule.data.mrcState ?? {};
      const state = mrcState[prod.productId] ?? emptyState();
      updateFactor(state, showcase, seller);

      if (!deviated(showcase, target) || isCooling(state.lastUpdateAt)) {
        mrcState[prod.productId] = state;
        rule.data.mrcState = mrcState;
        log.push({ mp: 'ozon', store: store.name, offerId: prod.productId, mrcPrice, showcase, action: deviated(showcase, target) ? 'cooldown' : 'ok' });
        continue;
      }

      let newSeller = computeNewSellerPrice(target, seller, showcase);
      if (rule.data.maxPrice) newSeller = Math.min(newSeller, rule.data.maxPrice);

      const refOld = (data.oldPrice && data.oldPrice > seller) ? data.oldPrice : seller;
      const safeRefOld = refOld > newSeller ? refOld : 0;
      const safeMinP = Math.max(1, newSeller - 1);

      updates.push({
        offer_id: prod.productId,
        price: String(newSeller),
        ...(safeRefOld > 0 ? { old_price: String(safeRefOld) } : {}),
        min_price: String(safeMinP),
        auto_action_enabled: 'DISABLED',
      });
      adjustedCtx.set(prod.productId, { rule, prod, target, oldSeller: seller, oldShowcase: showcase, newSeller });
      state.lastUpdateAt = new Date().toISOString();
      mrcState[prod.productId] = state;
      rule.data.mrcState = mrcState;
      rule.data.lastAppliedAt = new Date().toISOString();
      log.push({ mp: 'ozon', store: store.name, offerId: prod.productId, mrcPrice, showcase, oldSeller: seller, newSeller, action: 'adjusted' });
    }

    let uploadOk = true;
    if (updates.length > 0) {
      for (let i = 0; i < updates.length; i += 100) {
        const batch = updates.slice(i, i + 100);
        let resp: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          resp = await fetch('https://api-seller.ozon.ru/v1/product/import/prices', {
            method: 'POST', headers,
            body: JSON.stringify({ prices: batch }),
          });
          if (resp.status !== 429) break;
          await sleep(1000 * Math.pow(2, attempt));
        }
        if (!resp || !resp.ok) {
          uploadOk = false;
          const text = resp ? await resp.text().catch(() => '') : '';
          log.push({ mp: 'ozon', store: store.name, error: `import ${resp?.status}: ${text.slice(0, 200)}` });
          await logError(supabase, {
            marketplace: 'ozon', product_id: batch.map(b => b.offer_id).join(','),
            request: { prices: batch }, response: { body: text.slice(0, 500) },
            http_status: resp?.status ?? null, error: 'import/prices failed',
          });
        }
      }

      for (const { rule, prod, target, oldSeller, oldShowcase, newSeller } of adjustedCtx.values()) {
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'ozon', store_name: store.name,
          product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
          old_seller_price: oldSeller, new_seller_price: newSeller, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { offer_id: prod.productId, price: String(newSeller) },
          api_response: { ok: uploadOk }, success: uploadOk, error: uploadOk ? null : 'import/prices failed',
        });
      }

      // Block 6: пост-проверка
      if (uploadOk) {
        await sleep(VERIFY_DELAY_MS);
        const verifyMap = await fetchOzonPrices(headers, [...adjustedCtx.keys()], store, supabase);

        for (const [offerId, ctx] of adjustedCtx) {
          const { rule, prod, target, newSeller } = ctx;
          const verified = verifyMap.get(offerId);
          const verifiedShowcase = verified?.marketingPrice ?? 0;
          const stillDeviated = deviated(verifiedShowcase, target);

          log.push({ mp: 'ozon', store: store.name, offerId, mrcPrice: rule.data.mrcPrice, verifiedShowcase, target, action: stillDeviated ? 'verify_adjusted' : 'verify_ok' });
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'ozon', store_name: store.name,
            product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
            old_seller_price: newSeller, new_seller_price: null, old_buyer_price: null,
            verified_buyer_price: verifiedShowcase, target_mrc_price: target,
            action: stillDeviated ? 'verify_adjusted' : 'verify_ok',
            api_request: null, api_response: { marketing_price: verifiedShowcase }, success: !stillDeviated,
            error: stillDeviated ? 'buyer price still deviates from MRC after adjustment' : null,
          });

          if (stillDeviated && verified && verified.price > 0) {
            let correction = computeNewSellerPrice(target, newSeller, verifiedShowcase);
            if (rule.data.maxPrice) correction = Math.min(correction, rule.data.maxPrice);
            if (correction !== newSeller) {
              const refOld = (verified.oldPrice && verified.oldPrice > newSeller) ? verified.oldPrice : newSeller;
              const safeRefOld = refOld > correction ? refOld : 0;
              const safeMinP = Math.max(1, correction - 1);
              const followResp = await fetch('https://api-seller.ozon.ru/v1/product/import/prices', {
                method: 'POST', headers,
                body: JSON.stringify({ prices: [{
                  offer_id: offerId, price: String(correction),
                  ...(safeRefOld > 0 ? { old_price: String(safeRefOld) } : {}),
                  min_price: String(safeMinP), auto_action_enabled: 'DISABLED',
                }] }),
              }).catch(() => null);

              const mrcState: Record<string, MrcState> = rule.data.mrcState ?? {};
              const state = mrcState[prod.productId] ?? emptyState();
              updateFactor(state, verifiedShowcase, newSeller);
              mrcState[prod.productId] = state;
              rule.data.mrcState = mrcState;

              await logEvent(supabase, {
                rule_id: rule.id, marketplace: 'ozon', store_name: store.name,
                product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
                old_seller_price: newSeller, new_seller_price: correction, old_buyer_price: verifiedShowcase,
                target_mrc_price: target, action: 'verify_correction',
                api_request: { offer_id: offerId, price: String(correction) },
                api_response: { ok: !!followResp?.ok }, success: !!followResp?.ok, error: followResp?.ok ? null : 'follow-up import/prices failed',
              });
            }
          }
        }
      }
    }

    for (const rule of storeRules) {
      await supabase.from('repricer_rules').update({ data: rule.data }).eq('id', rule.id);
    }
  }
}

// ── Яндекс Маркет ────────────────────────────────────────────────────────────
async function fetchYandexPrices(
  headers: Record<string, string>,
  campaignId: string,
  store: any,
  supabase: any,
  offerIds?: string[],
): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();

  try {
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ pageSize: '200' });
      if (pageToken) params.set('page_token', pageToken);
      const resp = await fetch(`https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/offer-prices?${params}`, {
        method: offerIds ? 'POST' : 'GET',
        headers,
        ...(offerIds ? { body: JSON.stringify({ offerIds }) } : {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        await logError(supabase, {
          marketplace: 'yandex', product_id: offerIds?.join(',') ?? null,
          request: { campaignId, offerIds }, response: { body: text.slice(0, 500) },
          http_status: resp.status, error: 'offer-prices failed',
        });
        break;
      }
      const respJson = await resp.json();
      const items: any[] = respJson.result?.offers ?? [];
      for (const item of items) {
        const offerId = item.id ?? item.offerId ?? '';
        const price = Number(item.price?.value ?? 0);
        if (offerId && price > 0) priceMap.set(offerId, price);
      }
      pageToken = respJson.result?.paging?.nextPageToken;
      if (!pageToken || items.length === 0) break;
    }
  } catch (e: any) {
    await logError(supabase, {
      marketplace: 'yandex', product_id: offerIds?.join(',') ?? null,
      request: { campaignId, offerIds }, response: null, http_status: null,
      error: e?.message ?? String(e),
    });
  }

  return priceMap;
}

// Реальная цена покупателя (с учётом Буста), собранная расширением SimaDesk
// с публичных страниц market.yandex.ru — см. extension/content/yandex-price-*.js
// и supabase/functions/yandex-price-bridge.
async function fetchYandexBuyerPrices(offerIds: string[], supabase: any): Promise<Map<string, number>> {
  const showcaseMap = new Map<string, number>();
  if (offerIds.length === 0) return showcaseMap;

  const { data } = await supabase
    .from('yandex_buyer_prices')
    .select('offer_id, buyer_price, checked_at')
    .in('offer_id', offerIds);

  const staleBefore = Date.now() - YANDEX_SHOWCASE_STALE_MS;
  for (const row of data ?? []) {
    if (!row.offer_id || !row.buyer_price) continue;
    if (new Date(row.checked_at).getTime() < staleBefore) continue;
    showcaseMap.set(row.offer_id, Number(row.buyer_price));
  }
  return showcaseMap;
}

async function processYandex(supabase: any, rules: any[], log: any[]): Promise<void> {
  const byStore = new Map<string, any[]>();
  for (const r of rules) {
    const list = byStore.get(r.data.storeId) ?? [];
    list.push(r); byStore.set(r.data.storeId, list);
  }

  for (const [storeId, storeRules] of byStore) {
    const { data: store } = await supabase.from('yandex_stores').select('api_key, campaign_id, business_id, name').eq('id', storeId).single();
    if (!store?.api_key || !store.campaign_id) { log.push({ mp: 'yandex', storeId, error: 'store not found' }); continue; }

    const headers = { 'Api-Key': store.api_key, 'Content-Type': 'application/json', Accept: 'application/json' };

    const allItems: Array<{ rule: any; prod: RuleProduct }> = [];
    for (const rule of storeRules) for (const prod of ruleProducts(rule.data)) allItems.push({ rule, prod });
    if (allItems.length === 0) continue;

    const priceMap = await fetchYandexPrices(headers, store.campaign_id, store, supabase);
    const showcaseMap = await fetchYandexBuyerPrices(allItems.map(({ prod }) => prod.productId), supabase);

    const updates: Array<{ offerId: string; price: number }> = [];
    const adjustedCtx = new Map<string, { rule: any; prod: RuleProduct; target: number; oldPrice: number; oldShowcase: number; newPrice: number }>();

    for (const { rule, prod } of allItems) {
      const currentSetPrice = priceMap.get(prod.productId) ?? 0;
      if (!currentSetPrice) {
        await logError(supabase, {
          marketplace: 'yandex', product_id: prod.productId,
          request: { campaignId: store.campaign_id }, response: null, http_status: null,
          error: 'no price data returned for offerId',
        });
        continue;
      }

      const mrcPrice = rule.data.mrcPrice ?? 0;
      const target   = mrcEffectiveTarget(mrcPrice, rule.data.mrcBuffer);
      // Цена покупателя с Бустом/кешбэком Плюса — только для информации в логе.
      // МРЦ должна выполняться для цены ПРОДАВЦА со своей скидкой (без скидок,
      // финансируемых самим Маркетом), поэтому решение принимаем по currentSetPrice.
      const showcase = showcaseMap.get(prod.productId) ?? currentSetPrice;

      const mrcState: Record<string, MrcState> = rule.data.mrcState ?? {};
      const state = mrcState[prod.productId] ?? emptyState();
      updateFactor(state, currentSetPrice, currentSetPrice);

      if (!deviated(currentSetPrice, target) || isCooling(state.lastUpdateAt)) {
        mrcState[prod.productId] = state;
        rule.data.mrcState = mrcState;
        log.push({ mp: 'yandex', store: store.name, offerId: prod.productId, mrcPrice, currentSetPrice, showcase, action: deviated(currentSetPrice, target) ? 'cooldown' : 'ok' });
        continue;
      }

      // Цена продавца сама и есть «витрина» в этом сравнении — ставим target напрямую.
      let newPrice = target;
      if (rule.data.maxPrice) newPrice = Math.min(newPrice, rule.data.maxPrice);

      updates.push({ offerId: prod.productId, price: newPrice });
      adjustedCtx.set(prod.productId, { rule, prod, target, oldPrice: currentSetPrice, oldShowcase: showcase, newPrice });
      state.lastUpdateAt = new Date().toISOString();
      mrcState[prod.productId] = state;
      rule.data.mrcState = mrcState;
      rule.data.lastAppliedAt = new Date().toISOString();
      log.push({ mp: 'yandex', store: store.name, offerId: prod.productId, mrcPrice, currentSetPrice, showcase, newPrice, action: 'adjusted' });
    }

    let updateOk = true;
    if (updates.length > 0) {
      const mappingsBody = {
        offerMappings: updates.map(o => ({ offer: { offerId: o.offerId, basicPrice: { value: o.price, currencyId: 'RUR' } } })),
      };
      const pricesBody = {
        offers: updates.map(o => ({ offerId: o.offerId, price: { value: o.price, currencyId: 'RUR' } })),
      };

      const [mappingsResp, pricesResp] = await Promise.all([
        fetch(`https://api.partner.market.yandex.ru/v2/businesses/${store.business_id}/offer-mappings/update`, {
          method: 'POST', headers, body: JSON.stringify(mappingsBody),
        }).catch((e) => { log.push({ mp: 'yandex', store: store.name, error: `mappings: ${e?.message}` }); return null; }),
        fetch(`https://api.partner.market.yandex.ru/v2/businesses/${store.business_id}/offer-prices/updates`, {
          method: 'POST', headers, body: JSON.stringify(pricesBody),
        }).catch((e) => { log.push({ mp: 'yandex', store: store.name, error: `prices: ${e?.message}` }); return null; }),
      ]);

      updateOk = !!mappingsResp?.ok && !!pricesResp?.ok;
      if (!pricesResp?.ok) {
        const text = pricesResp ? await pricesResp.text().catch(() => '') : '';
        await logError(supabase, {
          marketplace: 'yandex', product_id: updates.map(u => u.offerId).join(','),
          request: pricesBody, response: { body: text.slice(0, 500) },
          http_status: pricesResp?.status ?? null, error: 'offer-prices/updates failed',
        });
      }

      for (const { rule, prod, target, oldPrice, oldShowcase, newPrice } of adjustedCtx.values()) {
        await logEvent(supabase, {
          rule_id: rule.id, marketplace: 'yandex', store_name: store.name,
          product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
          old_seller_price: oldPrice, new_seller_price: newPrice, old_buyer_price: oldShowcase,
          target_mrc_price: target, action: 'adjusted',
          api_request: { offerId: prod.productId, price: newPrice },
          api_response: { ok: updateOk }, success: updateOk, error: updateOk ? null : 'offer-prices/updates failed',
        });
      }

      // Block 6: пост-проверка
      if (updateOk) {
        await sleep(VERIFY_DELAY_MS);
        const verifyMap = await fetchYandexPrices(headers, store.campaign_id, store, supabase, [...adjustedCtx.keys()]);

        for (const [offerId, ctx] of adjustedCtx) {
          const { rule, prod, target, oldShowcase, newPrice } = ctx;
          const verifiedPrice = verifyMap.get(offerId) ?? 0;
          const stillDeviated = deviated(verifiedPrice, target);

          log.push({ mp: 'yandex', store: store.name, offerId, mrcPrice: rule.data.mrcPrice, verifiedPrice, target, action: stillDeviated ? 'verify_adjusted' : 'verify_ok' });
          await logEvent(supabase, {
            rule_id: rule.id, marketplace: 'yandex', store_name: store.name,
            product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
            old_seller_price: newPrice, new_seller_price: null, old_buyer_price: oldShowcase,
            verified_buyer_price: verifiedPrice, target_mrc_price: target,
            action: stillDeviated ? 'verify_adjusted' : 'verify_ok',
            api_request: null, api_response: { price: verifiedPrice }, success: !stillDeviated,
            error: stillDeviated ? 'price.value still deviates from MRC after adjustment' : null,
          });

          if (stillDeviated && verifiedPrice > 0) {
            let correction = target;
            if (rule.data.maxPrice) correction = Math.min(correction, rule.data.maxPrice);
            if (correction !== newPrice) {
              const followResp = await fetch(`https://api.partner.market.yandex.ru/v2/businesses/${store.business_id}/offer-prices/updates`, {
                method: 'POST', headers,
                body: JSON.stringify({ offers: [{ offerId, price: { value: correction, currencyId: 'RUR' } }] }),
              }).catch(() => null);

              await logEvent(supabase, {
                rule_id: rule.id, marketplace: 'yandex', store_name: store.name,
                product_id: prod.productId, vendor_code: prod.vendorCode, product_title: prod.productTitle,
                old_seller_price: newPrice, new_seller_price: correction, old_buyer_price: verifiedPrice,
                target_mrc_price: target, action: 'verify_correction',
                api_request: { offerId, price: correction },
                api_response: { ok: !!followResp?.ok }, success: !!followResp?.ok, error: followResp?.ok ? null : 'follow-up offer-prices/updates failed',
              });
            }
          }
        }
      }
    }

    // Каждый цикл держим все МРЦ-товары вне акций ЯМ
    if (allItems.length > 0 && store.business_id) {
      try {
        const resp = await fetch(`https://api.partner.market.yandex.ru/businesses/${store.business_id}/promos`, {
          method: 'POST', headers, body: JSON.stringify({ statuses: ['ACTIVE', 'UPCOMING'] }),
        });
        const respJson = await resp.json();
        const promos: any[] = respJson?.promos ?? [];
        const offerIds = allItems.map(({ prod }) => prod.productId);
        await Promise.allSettled(promos.map((promo: any) =>
          fetch(`https://api.partner.market.yandex.ru/businesses/${store.business_id}/promos/offers/delete`, {
            method: 'POST', headers, body: JSON.stringify({ promoId: promo.id, deleteAllOffers: false, offerIds }),
          }),
        ));
      } catch (e: any) {
        log.push({ mp: 'yandex', store: store.name, error: `removeFromPromos: ${e?.message}` });
      }
    }

    for (const rule of storeRules) {
      await supabase.from('repricer_rules').update({ data: rule.data }).eq('id', rule.id);
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPA_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(SUPA_URL, SUPA_KEY);

  const log: any[] = [];

  try {
    const { data: rules, error } = await supabase.from('repricer_rules').select('id, data');
    if (error) throw error;

    const mrcRules = (rules ?? []).filter((r: any) => r.data?.type === 'mrc' && r.data?.status === 'active');

    await processOzon(supabase, mrcRules.filter((r: any) => r.data.marketplace === 'ozon'), log);
    await sleep(300);
    await processWb(supabase, mrcRules.filter((r: any) => r.data.marketplace === 'wb'), log);
    await sleep(300);
    await processYandex(supabase, mrcRules.filter((r: any) => r.data.marketplace === 'yandex'), log);

    return new Response(JSON.stringify({ ok: true, processed: mrcRules.length, log }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e), log }), {
      status: 500,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
