// SIMA Connect: действия SimaDesk для ассистента SIMA OS (стандарт —
// SimaInfra/SIMA-CONNECT.md). Только чтение: продажи и остатки из базы SimaDesk.
//
// Кто спрашивает: SIMA OS присылает общий id человека (X-Sima-User). SimaDesk
// спрашивает у Платформы его Telegram / Яндекс и находит своего пользователя —
// отдельная привязка аккаунтов не нужна.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SITE = 'https://simadesk.ru';
const MP: Record<string, string> = { ozon: 'Ozon', wb: 'Wildberries', yandex: 'Яндекс Маркет' };

// deno-lint-ignore no-explicit-any
type Admin = ReturnType<typeof createClient<any, any, any>>;
type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  confirm: boolean;
  run: (admin: Admin, companyIds: string[], args: Record<string, unknown>) => Promise<unknown>;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function authorized(req: Request): boolean {
  const secret = Deno.env.get('SIMA_CONNECT_SECRET');
  return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`;
}

async function companiesOf(admin: Admin, simaUserId: string): Promise<string[] | null> {
  const platformUrl = Deno.env.get('SIMA_PLATFORM_URL');
  const platformKey = Deno.env.get('SIMA_PLATFORM_KEY');
  if (!platformUrl || !platformKey || !/^[0-9a-f-]{36}$/i.test(simaUserId)) return null;
  const res = await fetch(`${platformUrl.replace(/\/$/, '')}/api/v1/users/${simaUserId}`, {
    headers: { Authorization: `Bearer ${platformKey}` },
  });
  if (!res.ok) return null;
  const { identities } = await res.json() as { identities: { provider: string; provider_user_id: string }[] };
  const tg = identities.find((i) => i.provider === 'telegram')?.provider_user_id;
  const ya = identities.find((i) => i.provider === 'yandex')?.provider_user_id;

  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = (data?.users ?? []).find((u) => {
    const m = (u.user_metadata ?? {}) as Record<string, unknown>;
    return (tg && String(m.telegram_id ?? '') === tg) || (ya && String(m.yandex_id ?? '') === ya);
  });
  if (!user) return null;
  const { data: members } = await admin.from('company_members').select('company_id').eq('user_id', user.id);
  return (members ?? []).map((m: { company_id: string }) => m.company_id);
}

function moscowDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 3 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

async function sales(admin: Admin, companyIds: string[], args: Record<string, unknown>) {
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 31);
  const from = moscowDate(days - 1);
  const { data } = await admin
    .from('mp_transactions')
    .select('marketplace, tx_kind, accruals_for_sale, amount, operation_date')
    .in('company_id', companyIds)
    .gte('operation_date', `${from}T00:00:00+03:00`)
    .limit(10000);
  const { data: last } = await admin
    .from('mp_transactions').select('operation_date').in('company_id', companyIds)
    .order('operation_date', { ascending: false }).limit(1);
  const by: Record<string, { sales: number; revenue: number; returns: number; payout: number }> = {};
  for (const r of (data ?? []) as { marketplace: string; tx_kind: string; accruals_for_sale: number | null; amount: number | null }[]) {
    const k = MP[r.marketplace] ?? r.marketplace;
    by[k] ??= { sales: 0, revenue: 0, returns: 0, payout: 0 };
    if (r.tx_kind === 'sale') { by[k].sales++; by[k].revenue += Number(r.accruals_for_sale ?? 0); }
    if (r.tx_kind === 'return') by[k].returns++;
    by[k].payout += Number(r.amount ?? 0);
  }
  for (const v of Object.values(by)) { v.revenue = Math.round(v.revenue); v.payout = Math.round(v.payout); }
  return {
    period: `${from} — ${moscowDate(0)}`,
    by_marketplace: by,
    data_synced_until: (last?.[0] as { operation_date?: string } | undefined)?.operation_date?.slice(0, 10) ?? null,
    note: 'Суммы в рублях. Если data_synced_until давно — данные в SimaDesk давно не обновлялись.',
    open: SITE,
  };
}

async function lowStock(admin: Admin, companyIds: string[], args: Record<string, unknown>) {
  const threshold = Math.min(Math.max(Number(args.threshold) || 3, 0), 100);
  const [{ data: oz }, { data: wb }] = await Promise.all([
    admin.from('ozon_stores').select('id').in('company_id', companyIds),
    admin.from('wb_stores').select('id').in('company_id', companyIds),
  ]);
  const ozIds = (oz ?? []).map((s: { id: string }) => s.id);
  const wbIds = (wb ?? []).map((s: { id: string }) => s.id);
  // «Заканчиваются» — остаток от 1 до порога. Нулевые считаем отдельно: среди них
  // много давно неактивных карточек, и списком они только мешают.
  const out: { marketplace: string; name: string; article: string; stock: number }[] = [];
  let outOfStock = 0;
  if (ozIds.length) {
    const { data } = await admin.from('ozon_products').select('name, offer_id, stock_fbs, stock_fbo, status').in('store_id', ozIds).limit(5000);
    for (const p of (data ?? []) as { name: string; offer_id: string; stock_fbs: number | null; stock_fbo: number | null }[]) {
      const stock = (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0);
      if (stock === 0) outOfStock++;
      else if (stock <= threshold) out.push({ marketplace: 'Ozon', name: p.name, article: p.offer_id, stock });
    }
  }
  if (wbIds.length) {
    const { data } = await admin.from('wb_products').select('title, vendor_code, stock_total').in('store_id', wbIds).limit(5000);
    for (const p of (data ?? []) as { title: string; vendor_code: string; stock_total: number | null }[]) {
      const stock = p.stock_total ?? 0;
      if (stock === 0) outOfStock++;
      else if (stock <= threshold) out.push({ marketplace: 'Wildberries', name: p.title, article: p.vendor_code, stock });
    }
  }
  out.sort((a, b) => a.stock - b.stock);
  return { threshold, running_low: out.length, items: out.slice(0, 20), out_of_stock_count: outOfStock, open: SITE };
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS: Tool[] = [
  {
    name: 'simadesk_sales',
    description: 'Продажи на маркетплейсах (Ozon, Wildberries, Яндекс Маркет) из SimaDesk за последние N дней: число продаж, выручка, возвраты, итог к выплате, и до какой даты данные синхронизированы.',
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31, description: 'За сколько дней, по умолчанию 7' } }, additionalProperties: false },
    confirm: false,
    run: sales,
  },
  {
    name: 'simadesk_low_stock',
    description: 'Товары на Ozon и Wildberries, которые заканчиваются (остаток от 1 до порога), и сколько карточек без остатка вовсе.',
    parameters: { type: 'object', properties: { threshold: { type: 'integer', minimum: 0, maximum: 100, description: 'Порог остатка, по умолчанию 3' } }, additionalProperties: false },
    confirm: false,
    run: lowStock,
  },
  {
    name: 'simadesk_digest',
    description: 'Короткая сводка SimaDesk для утреннего сообщения.',
    parameters: noArgs,
    confirm: false,
    run: async (admin, ids) => {
      const [s, l] = await Promise.all([sales(admin, ids, { days: 1 }), lowStock(admin, ids, { threshold: 3 })]);
      return { yesterday_and_today: s.by_marketplace, data_synced_until: s.data_synced_until, running_low: l.running_low };
    },
  },
];

export async function handleSimaConnect(req: Request, sub: string): Promise<Response> {
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
  if (sub === 'api/sima/manifest') {
    return json({
      product: 'simadesk',
      name: 'SimaDesk',
      url: SITE,
      tools: TOOLS.map(({ name, description, parameters, confirm }) => ({ name, description, parameters, confirm })),
      digest: 'simadesk_digest',
    });
  }
  const name = sub.replace(/^api\/sima\/tools\//, '');
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return json({ ok: false, error: `Нет действия ${name}` }, 404);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const companyIds = await companiesOf(admin, req.headers.get('x-sima-user') ?? '');
  if (!companyIds || companyIds.length === 0) {
    return json({
      ok: false,
      connected: false,
      error: `SimaDesk не подключён: войди на ${SITE} тем же Telegram или Яндексом и подключи магазин.`,
      url: SITE,
    });
  }
  const body = await req.json().catch(() => ({})) as { args?: Record<string, unknown> };
  try {
    return json({ ok: true, result: await tool.run(admin, companyIds, body.args ?? {}) });
  } catch (err) {
    console.error('[sima-connect]', name, err);
    return json({ ok: false, error: 'SimaDesk не смог выполнить действие' }, 500);
  }
}
