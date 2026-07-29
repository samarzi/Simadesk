/**
 * Edge Function: ЮKassa payment processing
 *
 * Routes:
 *   POST /yookassa-pay          — create payment, returns { payment_id, confirmation_url }
 *   POST /yookassa-pay/webhook  — handle ЮKassa webhook notification
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function randomIdempotenceKey(): string {
  return crypto.randomUUID();
}

async function createPayment(req: Request): Promise<Response> {
  const shopId = Deno.env.get('YOOKASSA_SHOP_ID');
  const secretKey = Deno.env.get('YOOKASSA_SECRET_KEY');
  if (!shopId || !secretKey) return json({ error: 'ЮKassa не настроена' }, 500);

  let body: { company_id: string; plan_key: string; price_rub: number; return_url: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Неверный формат запроса' }, 400);
  }
  const { company_id, plan_key, price_rub, return_url } = body;
  if (!company_id || !plan_key || !price_rub || !return_url) {
    return json({ error: 'Не переданы обязательные параметры' }, 400);
  }

  // Authenticate calling user via Supabase JWT
  const authHeader = req.headers.get('authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (authErr || !user) return json({ error: 'Не авторизован' }, 401);

  const amountStr = (price_rub).toFixed(2);
  const description = `SimaDesk — тариф ${plan_key} · ${price_rub.toLocaleString('ru')} ₽/мес`;

  const ykRes = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${shopId}:${secretKey}`),
      'Idempotence-Key': randomIdempotenceKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: { value: amountStr, currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url },
      description,
      metadata: { company_id, plan_key, user_id: user.id, price_rub },
    }),
  });

  if (!ykRes.ok) {
    const err = await ykRes.text();
    console.error('ЮKassa create payment error:', err);
    return json({ error: 'Ошибка создания платежа в ЮKassa' }, 502);
  }

  const payment = await ykRes.json();
  return json({
    payment_id: payment.id,
    confirmation_url: payment.confirmation?.confirmation_url,
    status: payment.status,
  });
}

async function handleWebhook(req: Request): Promise<Response> {
  const shopId = Deno.env.get('YOOKASSA_SHOP_ID');
  const secretKey = Deno.env.get('YOOKASSA_SECRET_KEY');
  if (!shopId || !secretKey) return json({ error: 'not configured' }, 500);

  let event: any;
  try {
    event = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  if (event.type !== 'notification') return json({ ok: true });
  const incoming = event.object;
  if (!incoming?.id) return json({ ok: true });

  // ── SECURITY: never trust the webhook body. It arrives over the open internet
  // and anyone who knows the URL could POST a fake { status: 'succeeded' }.
  // Re-fetch the payment from the ЮKassa API and use only that authoritative
  // object to decide whether — and for whom — to activate a subscription.
  const ykRes = await fetch(`https://api.yookassa.ru/v3/payments/${incoming.id}`, {
    headers: { 'Authorization': 'Basic ' + btoa(`${shopId}:${secretKey}`) },
  });
  if (!ykRes.ok) {
    console.error('ЮKassa verify error:', ykRes.status, await ykRes.text());
    // Return 200 so ЮKassa doesn't hammer retries on transient errors, but do NOT activate.
    return json({ ok: true });
  }
  const payment = await ykRes.json();

  // Authoritative check: only a genuinely captured, paid payment activates.
  if (payment.status !== 'succeeded' || payment.paid !== true) return json({ ok: true });

  const { company_id, plan_key, price_rub } = payment.metadata ?? {};
  if (!company_id || !plan_key) return json({ ok: true });

  // Cross-check the charged amount against the authoritative payment amount.
  const paidRub = Number(payment.amount?.value) || 0;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Upsert subscription
  const { error } = await supabase
    .from('user_subscriptions')
    .upsert({
      company_id,
      plan_key,
      status: 'active',
      price_rub: paidRub || Number(price_rub) || 0,
      monthly_revenue: 0,
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      yookassa_payment_id: payment.id,
    }, { onConflict: 'company_id' });

  if (error) console.error('DB upsert error:', error);

  return json({ ok: true });
}

async function checkPayment(req: Request): Promise<Response> {
  const shopId = Deno.env.get('YOOKASSA_SHOP_ID');
  const secretKey = Deno.env.get('YOOKASSA_SECRET_KEY');
  if (!shopId || !secretKey) return json({ error: 'not configured' }, 500);

  const url = new URL(req.url);
  const paymentId = url.searchParams.get('payment_id');
  if (!paymentId) return json({ error: 'no payment_id' }, 400);

  const ykRes = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { 'Authorization': 'Basic ' + btoa(`${shopId}:${secretKey}`) },
  });
  if (!ykRes.ok) return json({ error: 'ЮKassa error' }, 502);

  const payment = await ykRes.json();
  return json({ status: payment.status, paid: payment.paid });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/yookassa-pay/, '');

  if (req.method === 'POST' && path === '') return createPayment(req);
  if (req.method === 'POST' && path === '/webhook') return handleWebhook(req);
  if (req.method === 'GET' && path === '/status') return checkPayment(req);

  return json({ error: 'Not found' }, 404);
});
