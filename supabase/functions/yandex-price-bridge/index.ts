// Мост между расширением SimaDesk и таблицей yandex_buyer_prices.
//
// GET  /yandex-price-bridge?action=targets — список товаров Yandex с активными
//      МРЦ-правилами, для которых нужно (пере)узнать реальную цену покупателя
//      (с учётом Буста). Возвращает товары, у которых данных нет вообще или
//      они старше STALE_HOURS.
//
// POST /yandex-price-bridge { action: 'report', market_sku, offer_id, buyer_price, product_title }
//      — сохраняет найденную расширением цену в yandex_buyer_prices.
//
// Вызывается из background.js расширения SimaDesk (без авторизации пользователя,
// апи защищён только тем, что URL/anon-key не публикуются широко).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STALE_HOURS = 3;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const action = url.searchParams.get('action');
      if (action !== 'targets') {
        return json({ error: 'unknown action' }, 400);
      }

      // Активные MRC-правила для Yandex
      const { data: rules, error: rulesErr } = await supabase
        .from('repricer_rules')
        .select('id, data');
      if (rulesErr) throw rulesErr;

      const offerIds = new Set<string>();
      for (const r of rules ?? []) {
        const d = r.data ?? {};
        if (d.type !== 'mrc' || d.status !== 'active' || d.marketplace !== 'yandex') continue;
        const products = Array.isArray(d.products) && d.products.length > 0
          ? d.products
          : [{ productId: d.productId }];
        for (const p of products) {
          if (p.productId) offerIds.add(String(p.productId));
        }
      }

      if (offerIds.size === 0) return json({ targets: [] });

      const { data: products, error: prodErr } = await supabase
        .from('yandex_products')
        .select('offer_id, market_sku, name')
        .in('offer_id', [...offerIds]);
      if (prodErr) throw prodErr;

      const bySku = new Map<number, { offer_id: string; market_sku: number; name: string }>();
      for (const p of products ?? []) {
        if (p.market_sku) bySku.set(p.market_sku, p);
      }

      // Уже свежие данные — отфильтровать
      const skus = [...bySku.keys()];
      const { data: existing } = await supabase
        .from('yandex_buyer_prices')
        .select('market_sku, checked_at')
        .in('market_sku', skus.length > 0 ? skus : [0]);

      const staleBefore = Date.now() - STALE_HOURS * 3600 * 1000;
      const freshSkus = new Set(
        (existing ?? [])
          .filter((e: any) => new Date(e.checked_at).getTime() > staleBefore)
          .map((e: any) => e.market_sku),
      );

      const targets = [...bySku.values()]
        .filter((p) => !freshSkus.has(p.market_sku))
        .map((p) => ({ marketSku: p.market_sku, offerId: p.offer_id, productTitle: p.name }));

      return json({ targets });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      if (body.action !== 'report') return json({ error: 'unknown action' }, 400);

      const { marketSku, offerId, buyerPrice, basePrice, productTitle } = body;
      if (!marketSku || !buyerPrice) return json({ error: 'marketSku and buyerPrice required' }, 400);

      const { error } = await supabase.from('yandex_buyer_prices').upsert({
        market_sku: marketSku,
        offer_id: offerId ?? null,
        buyer_price: buyerPrice,
        base_price: basePrice ?? null,
        product_title: productTitle ?? null,
        checked_at: new Date().toISOString(),
      });
      if (error) throw error;

      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
