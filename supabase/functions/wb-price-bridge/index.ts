// Мост между расширением SimaDesk и таблицей wb_buyer_prices.
//
// GET  /wb-price-bridge?action=targets — список товаров Wildberries с активными
//      МРЦ-правилами, для которых нужно (пере)узнать реальную цену покупателя
//      (с учётом СПП). Возвращает товары, у которых данных нет вообще или
//      они старше STALE_HOURS.
//
// POST /wb-price-bridge { action: 'report', nmId, vendorCode, buyerPrice, productTitle }
//      — сохраняет найденную расширением цену в wb_buyer_prices.
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

      // Активные MRC-правила для WB
      const { data: rules, error: rulesErr } = await supabase
        .from('repricer_rules')
        .select('id, data');
      if (rulesErr) throw rulesErr;

      const nmIds = new Set<number>();
      for (const r of rules ?? []) {
        const d = r.data ?? {};
        if (d.type !== 'mrc' || d.status !== 'active' || d.marketplace !== 'wb') continue;
        const products = Array.isArray(d.products) && d.products.length > 0
          ? d.products
          : [{ productId: d.productId }];
        for (const p of products) {
          const nmId = Number(p.productId);
          if (nmId > 0) nmIds.add(nmId);
        }
      }

      if (nmIds.size === 0) return json({ targets: [] });

      const { data: products, error: prodErr } = await supabase
        .from('wb_products')
        .select('nm_id, vendor_code, title')
        .in('nm_id', [...nmIds]);
      if (prodErr) throw prodErr;

      const byNm = new Map<number, { nm_id: number; vendor_code: string; title: string }>();
      for (const p of products ?? []) {
        byNm.set(p.nm_id, p);
      }

      // Уже свежие данные — отфильтровать
      const ids = [...nmIds];
      const { data: existing } = await supabase
        .from('wb_buyer_prices')
        .select('nm_id, checked_at')
        .in('nm_id', ids.length > 0 ? ids : [0]);

      const staleBefore = Date.now() - STALE_HOURS * 3600 * 1000;
      const freshIds = new Set(
        (existing ?? [])
          .filter((e: any) => new Date(e.checked_at).getTime() > staleBefore)
          .map((e: any) => e.nm_id),
      );

      const targets = ids
        .filter((nmId) => !freshIds.has(nmId))
        .map((nmId) => {
          const p = byNm.get(nmId);
          return { nmId, vendorCode: p?.vendor_code ?? null, productTitle: p?.title ?? null };
        });

      return json({ targets });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      if (body.action !== 'report') return json({ error: 'unknown action' }, 400);

      const { nmId, vendorCode, buyerPrice, productTitle } = body;
      if (!nmId || !buyerPrice) return json({ error: 'nmId and buyerPrice required' }, 400);

      const { error } = await supabase.from('wb_buyer_prices').upsert({
        nm_id: nmId,
        vendor_code: vendorCode ?? null,
        buyer_price: buyerPrice,
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
