/**
 * Edge Runtime main service: Telegram Auth + Yandex Auth router
 *
 * Routes by URL path (edge runtime uses this as the single main-service):
 *   /telegram-auth  — Telegram Login Widget or Mini App auth
 *   /yandex-auth    — Yandex OAuth implicit flow auth
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Login Widget verification (SHA-256 of bot token as key) ──────────────────
async function verifyLoginWidget(
  data: Record<string, unknown>,
  botToken: string,
): Promise<{ ok: boolean; reason?: string }> {
  const hash = data.hash as string | undefined;
  if (!hash) return { ok: false, reason: 'no_hash' };

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'hash') fields[k] = String(v);
  }

  const authDate = parseInt(fields.auth_date || '0', 10);
  if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'auth_date_expired' };

  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const enc = new TextEncoder();
  const botTokenHash = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const secretKey = await crypto.subtle.importKey('raw', botTokenHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', secretKey, enc.encode(checkString));
  const computedHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

  return computedHex === hash ? { ok: true } : { ok: false, reason: 'hash_mismatch' };
}

// ── Mini App initData verification (HMAC of "WebAppData" as key) ─────────────
async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<{ ok: boolean; reason?: string; user?: Record<string, string> }> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'auth_date_expired' };

  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');

  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const rawSecret = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(botToken));
  const secretKey = await crypto.subtle.importKey('raw', rawSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', secretKey, enc.encode(checkString));
  const computedHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

  if (computedHex !== hash) return { ok: false, reason: 'hash_mismatch' };

  // Parse user from JSON-encoded "user" field
  const user: Record<string, string> = {};
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      const u = JSON.parse(userRaw);
      user.id = String(u.id ?? '');
      user.first_name = u.first_name ?? '';
      user.last_name = u.last_name ?? '';
      user.username = u.username ?? '';
      user.photo_url = u.photo_url ?? '';
    } catch { /* ignore */ }
  }

  return { ok: true, user };
}

// ── Shared: upsert user + create session ─────────────────────────────────────
async function processAuth(tgUser: Record<string, string>): Promise<Response> {
  const apiUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  // Admin client — for DB writes and admin auth operations (generateLink, createUser)
  const db = createClient(
    apiUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const telegramId = parseInt(tgUser.id, 10);
  const firstName = tgUser.first_name || '';
  const lastName = tgUser.last_name || null;
  const username = tgUser.username || null;
  const photoUrl = tgUser.photo_url || null;
  const fakeEmail = `tg${telegramId}@stockbase.app`;

  // Find or create user
  const { data: existingUser } = await db.from('users')
    .select('id, profile_source').eq('telegram_id', telegramId).maybeSingle();

  let userId: string;

  if (existingUser) {
    userId = existingUser.id;
    // Only overwrite display fields when TG is the chosen source (or no source set yet)
    const useForDisplay = !existingUser.profile_source || existingUser.profile_source === 'telegram';
    await db.from('users').update({
      telegram_username: username,
      telegram_first_name: firstName,
      telegram_last_name: lastName,
      telegram_photo_url: photoUrl,
      ...(useForDisplay ? { first_name: firstName, last_name: lastName, photo_url: photoUrl } : {}),
      last_login_at: new Date().toISOString(),
    }).eq('id', userId);
  } else {
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: fakeEmail, email_confirm: true,
      user_metadata: { telegram_id: telegramId, first_name: firstName, username },
    });

    if (authError) {
      if (authError.message?.includes('already exists')) {
        const { data: authUser } = await db.auth.admin.getUserByEmail(fakeEmail);
        if (!authUser?.user) throw authError;
        userId = authUser.user.id;
      } else {
        throw authError;
      }
    } else {
      userId = authData.user!.id;
    }

    await db.from('users').insert({
      id: userId, telegram_id: telegramId, telegram_username: username,
      first_name: firstName, last_name: lastName, photo_url: photoUrl,
      telegram_first_name: firstName, telegram_last_name: lastName, telegram_photo_url: photoUrl,
      last_login_at: new Date().toISOString(),
    });
  }

  // Process pending invitations
  if (username) {
    const { data: pendingInvites } = await db
      .from('company_invitations').select('id, company_id, role')
      .eq('telegram_username', username.toLowerCase()).is('used_at', null);

    for (const invite of pendingInvites ?? []) {
      await db.from('company_members').upsert(
        { company_id: invite.company_id, user_id: userId, role: invite.role },
        { onConflict: 'company_id,user_id', ignoreDuplicates: true },
      );
      await db.from('company_invitations')
        .update({ used_at: new Date().toISOString(), used_by: userId }).eq('id', invite.id);
    }
  }

  // Create session via magic link
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: 'magiclink', email: fakeEmail, options: { redirectTo: '' },
  });
  if (linkError) throw linkError;

  // Use direct fetch (not SDK) to avoid any client-side JWT substitution quirks.
  // GoTrue returns hashed_token at top level in v2.174+; SDK wraps it in .properties.
  const hashedToken = linkData.properties?.hashed_token ?? (linkData as any).hashed_token;
  if (!hashedToken) throw new Error('generateLink did not return hashed_token');

  const verifyRes = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ token_hash: hashedToken, type: 'magiclink' }),
  });
  if (!verifyRes.ok) {
    const errText = await verifyRes.text();
    throw new Error(`verify failed ${verifyRes.status}: ${errText}`);
  }
  const sessionJson = await verifyRes.json();
  const accessToken = sessionJson.access_token;
  const refreshToken = sessionJson.refresh_token;
  const expiresIn = sessionJson.expires_in ?? 3600;
  if (!accessToken) throw new Error('verify returned no access_token');

  return new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    user_id: userId, first_name: firstName, username, photo_url: photoUrl,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ── Yandex Auth handler (login + account linking) ─────────────────────────────

interface YandexUserInfo {
  id: string;
  login: string;
  display_name: string;
  first_name: string;
  last_name: string;
  default_email: string;
  default_avatar_id: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

async function handleYandexAuth(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json();
  const yandexToken = body.yandex_token as string | undefined;
  if (!yandexToken) {
    return new Response(JSON.stringify({ error: 'Missing yandex_token' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Detect link mode: caller sends their real user JWT (not anon)
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  const callerPayload = decodeJwtPayload(callerToken);
  const isLinkMode = callerPayload?.role === 'authenticated' && typeof callerPayload?.sub === 'string';
  const existingUserId = isLinkMode ? (callerPayload!.sub as string) : null;

  const yRes = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${yandexToken}` },
  });
  if (!yRes.ok) throw new Error(`Yandex API error: ${yRes.status}`);
  const yUser: YandexUserInfo = await yRes.json();

  const yandexId = parseInt(yUser.id, 10);
  const firstName = yUser.first_name || yUser.display_name || yUser.login;
  const lastName = yUser.last_name || null;
  const photoUrl = yUser.default_avatar_id
    ? `https://avatars.yandex.net/get-yapic/${yUser.default_avatar_id}/islands-200`
    : null;
  const fakeEmail = `ya${yandexId}@simadesk.ru`;

  const apiUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const db = createClient(apiUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── LINK / MERGE MODE: caller is an authenticated user ────────────────────
  if (isLinkMode && existingUserId) {
    const wantsMerge = body.merge === true;

    // Check if this yandex_id is already linked to someone else
    const { data: takenBy } = await db.from('users')
      .select('id').eq('yandex_id', yandexId).maybeSingle();

    if (takenBy && takenBy.id !== existingUserId) {
      if (!wantsMerge) {
        // Ask frontend whether to merge
        return new Response(JSON.stringify({
          error: 'Этот Яндекс аккаунт уже зарегистрирован как отдельный профиль',
          code: 'yandex_conflict',
        }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // ── MERGE: move everything from secondary into primary ──────────────
      const secondaryId = takenBy.id;
      const { error: mergeErr } = await db.rpc('merge_users', {
        p_primary_id: existingUserId,
        p_secondary_id: secondaryId,
      });
      if (mergeErr) throw new Error(`merge_users failed: ${mergeErr.message}`);

      // Delete secondary from auth.users (GoTrue)
      await db.auth.admin.deleteUser(secondaryId);

      return new Response(JSON.stringify({ merged: true, yandex_id: yandexId }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Simple link — no conflict (always save raw Yandex data; respect profile_source for display)
    const { data: linkProfile } = await db.from('users')
      .select('profile_source').eq('id', existingUserId).maybeSingle();
    const useForDisplay = !linkProfile?.profile_source || linkProfile.profile_source === 'yandex';
    await db.from('users').update({
      yandex_id: yandexId,
      yandex_login: yUser.login,
      yandex_first_name: firstName,
      yandex_last_name: lastName,
      yandex_photo_url: photoUrl,
      ...(useForDisplay ? { photo_url: photoUrl } : {}),
      last_login_at: new Date().toISOString(),
    }).eq('id', existingUserId);
    return new Response(JSON.stringify({ linked: true, yandex_id: yandexId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── LOGIN MODE: find or create user by yandex_id ──────────────────────────
  const { data: existingUser } = await db.from('users')
    .select('id').eq('yandex_id', yandexId).maybeSingle();

  let userId: string;
  let sessionEmail: string;  // real GoTrue email for the user

  if (existingUser) {
    userId = existingUser.id;
    // Only overwrite display fields when Yandex is the chosen source (or no source set)
    const { data: existingProfile } = await db.from('users')
      .select('profile_source').eq('id', userId).maybeSingle();
    const useForDisplay = !existingProfile?.profile_source || existingProfile.profile_source === 'yandex';
    await db.from('users').update({
      yandex_login: yUser.login,
      yandex_first_name: firstName,
      yandex_last_name: lastName,
      yandex_photo_url: photoUrl,
      ...(useForDisplay ? { first_name: firstName, last_name: lastName, photo_url: photoUrl } : {}),
      last_login_at: new Date().toISOString(),
    }).eq('id', userId);

    // Use the real GoTrue email (user may have been originally created via TG after merge)
    const { data: authUserData } = await db.auth.admin.getUserById(userId);
    if (!authUserData?.user?.email) throw new Error('GoTrue user not found for id: ' + userId);
    sessionEmail = authUserData.user.email;
  } else {
    // New user — create GoTrue account with Yandex fake email
    const { data: authData, error: authError } = await db.auth.admin.createUser({
      email: fakeEmail, email_confirm: true,
      user_metadata: { yandex_id: yandexId, first_name: firstName },
    });
    if (authError) {
      if (authError.message?.includes('already exists')) {
        const { data: authUser } = await db.auth.admin.getUserByEmail(fakeEmail);
        if (!authUser?.user) throw authError;
        userId = authUser.user.id;
      } else throw authError;
    } else {
      userId = authData.user!.id;
    }
    sessionEmail = fakeEmail;
    await db.from('users').insert({
      id: userId, yandex_id: yandexId,
      yandex_login: yUser.login,
      yandex_first_name: firstName,
      yandex_last_name: lastName,
      yandex_photo_url: photoUrl,
      first_name: firstName, last_name: lastName,
      photo_url: photoUrl, last_login_at: new Date().toISOString(),
    });
  }

  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: 'magiclink', email: sessionEmail, options: { redirectTo: '' },
  });
  if (linkError) throw linkError;

  const hashedToken = linkData.properties?.hashed_token ?? (linkData as any).hashed_token;
  if (!hashedToken) throw new Error('generateLink did not return hashed_token');

  const verifyRes = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ token_hash: hashedToken, type: 'magiclink' }),
  });
  if (!verifyRes.ok) {
    const errText = await verifyRes.text();
    throw new Error(`verify failed ${verifyRes.status}: ${errText}`);
  }
  const sessionJson = await verifyRes.json();
  if (!sessionJson.access_token) throw new Error('verify returned no access_token');

  return new Response(JSON.stringify({
    access_token: sessionJson.access_token,
    refresh_token: sessionJson.refresh_token,
    expires_in: sessionJson.expires_in ?? 3600,
    user_id: userId, first_name: firstName, photo_url: photoUrl,
    username: yUser.login,
    yandex_login: yUser.login,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ── Telegram Bot: helpers ──────────────────────────────────────────────────────

const TG_API = 'https://api.telegram.org';

async function tgSend(token: string, chatId: number, text: string, extra?: Record<string, unknown>): Promise<void> {
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function tgAnswerCb(token: string, cbId: string, text?: string): Promise<void> {
  await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cbId, text: text ?? '' }),
  });
}

// ── Telegram Bot: command handlers ────────────────────────────────────────────

async function handleBotStart(db: any, chatId: number, userId: number, firstName: string): Promise<string> {
  // Find user by telegram_id
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) return `Привет, ${firstName}! 👋\n\nСначала войдите в SimaDesk через Telegram на сайте, затем повторите /start.`;

  // Find or create tg_chat
  const { data: existing } = await db.from('tg_chats')
    .select('id').eq('user_id', user.id).maybeSingle();

  if (!existing) {
    // Get first company
    const { data: member } = await db.from('company_members')
      .select('company_id').eq('user_id', user.id).limit(1).maybeSingle();

    await db.from('tg_chats').insert({
      user_id: user.id, chat_id: chatId,
      company_id: member?.company_id ?? null,
    });

    // Create default notification settings
    if (member?.company_id) {
      await db.from('tg_notification_settings').insert({
        user_id: user.id, company_id: member.company_id,
      }).select().maybeSingle();
    }
  } else {
    await db.from('tg_chats').update({ chat_id: chatId }).eq('id', existing.id);
  }

  return `✅ Чат привязан!\n\nДоступные команды:\n/today — сводка за сегодня\n/orders — заказы в сборке\n/stock — низкие остатки\n/revenue — выручка за 7 дней\n/settings — настройки уведомлений`;
}

async function handleBotToday(db: any, chatId: number, userId: number): Promise<void> {
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Войдите в SimaDesk через Telegram на сайте.'); return; }

  const { data: chat } = await db.from('tg_chats').select('company_id').eq('user_id', user.id).maybeSingle();
  const companyId = chat?.company_id;
  if (!companyId) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Нет привязанной компании.'); return; }

  // Get today's orders from mp_transactions
  const today = new Date().toISOString().slice(0, 10);
  const { data: txs } = await db.from('mp_transactions')
    .select('kind, amount, marketplace')
    .eq('company_id', companyId)
    .gte('created_at', today)
    .lte('created_at', today + 'T23:59:59');

  const orders = txs?.filter((t: any) => t.kind === 'order') ?? [];
  const revenue = txs?.reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0) ?? 0;
  const byMp: Record<string, number> = {};
  for (const o of orders) byMp[o.marketplace ?? '?'] = (byMp[o.marketplace ?? '?'] ?? 0) + 1;

  const mpLines = Object.entries(byMp).map(([mp, cnt]) => `  ${mp.toUpperCase()}: ${cnt}`).join('\n');
  const text = `📊 <b>Сводка за сегодня</b> (${today})\n\n📦 Заказов: <b>${orders.length}</b>\n${mpLines ? mpLines + '\n' : ''}💰 Выручка: <b>${revenue.toLocaleString('ru')} ₽</b>`;

  await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, text);
}

async function handleBotOrders(db: any, chatId: number, userId: number): Promise<void> {
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Войдите в SimaDesk.'); return; }

  const { data: chat } = await db.from('tg_chats').select('company_id').eq('user_id', user.id).maybeSingle();
  const companyId = chat?.company_id;
  if (!companyId) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Нет привязанной компании.'); return; }

  const { data: txs } = await db.from('mp_transactions')
    .select('external_id, product_name, marketplace, amount, created_at')
    .eq('company_id', companyId)
    .eq('kind', 'order')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!txs?.length) {
    await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, '📋 Нет последних заказов.');
    return;
  }

  const lines = txs.map((t: any, i: number) =>
    `${i + 1}. ${t.product_name ?? '—'} (${t.marketplace?.toUpperCase() ?? '?'}) — ${Number(t.amount ?? 0).toLocaleString('ru')} ₽`
  ).join('\n');
  await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, `📋 <b>Последние заказы:</b>\n\n${lines}`);
}

async function handleBotStock(db: any, chatId: number, userId: number): Promise<void> {
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Войдите в SimaDesk.'); return; }

  const { data: settings } = await db.from('tg_notification_settings')
    .select('low_stock_threshold').eq('user_id', user.id).maybeSingle();
  const threshold = settings?.low_stock_threshold ?? 5;

  // Get WB/Ozon/Yandex products with low stock
  const lowStock: Array<{ name: string; stock: number; mp: string }> = [];

  const { data: wbProds } = await db.from('wb_products')
    .select('title, stock_total').lte('stock_total', threshold).gt('stock_total', 0);
  for (const p of wbProds ?? []) lowStock.push({ name: p.title ?? '—', stock: p.stock_total ?? 0, mp: 'WB' });

  const { data: ozProds } = await db.from('ozon_products')
    .select('name, stock_fbs, stock_fbo').or(`stock_fbs.lte.${threshold},stock_fbo.lte.${threshold}`);
  for (const p of ozProds ?? []) {
    const total = (p.stock_fbs ?? 0) + (p.stock_fbo ?? 0);
    if (total > 0 && total <= threshold) lowStock.push({ name: p.name ?? '—', stock: total, mp: 'Ozon' });
  }

  if (lowStock.length === 0) {
    await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, `✅ Все товары в наличии (порог: ${threshold} шт.)`);
    return;
  }

  const lines = lowStock.slice(0, 15).map((p, i) =>
    `${i + 1}. ${p.name.slice(0, 40)} — <b>${p.stock} шт.</b> (${p.mp})`
  ).join('\n');
  const more = lowStock.length > 15 ? `\n… и ещё ${lowStock.length - 15}` : '';
  await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, `⚠️ <b>Низкие остатки</b> (< ${threshold} шт.):\n\n${lines}${more}`);
}

async function handleBotRevenue(db: any, chatId: number, userId: number): Promise<void> {
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Войдите в SimaDesk.'); return; }

  const { data: chat } = await db.from('tg_chats').select('company_id').eq('user_id', user.id).maybeSingle();
  const companyId = chat?.company_id;
  if (!companyId) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Нет привязанной компании.'); return; }

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: txs } = await db.from('mp_transactions')
    .select('kind, amount, marketplace, created_at')
    .eq('company_id', companyId)
    .gte('created_at', weekAgo);

  const byDay: Record<string, number> = {};
  const byMp: Record<string, number> = {};
  for (const t of txs ?? []) {
    const day = t.created_at?.slice(0, 10) ?? '?';
    byDay[day] = (byDay[day] ?? 0) + (Number(t.amount) || 0);
    byMp[t.marketplace ?? '?'] = (byMp[t.marketplace ?? '?'] ?? 0) + (Number(t.amount) || 0);
  }

  const total = Object.values(byDay).reduce((s, v) => s + v, 0);
  const days = Object.entries(byDay).sort().map(([d, v]) => `  ${d}: ${v.toLocaleString('ru')} ₽`).join('\n');
  const mpLines = Object.entries(byMp).map(([mp, v]) => `  ${mp.toUpperCase()}: ${v.toLocaleString('ru')} ₽`).join('\n');

  await tgSend(Deno.env.get('BOT_TOKEN')!, chatId,
    `💰 <b>Выручка за 7 дней</b>\n\nИтого: <b>${total.toLocaleString('ru')} ₽</b>\n\nПо дням:\n${days || '  Нет данных'}\n\nПо МП:\n${mpLines || '  Нет данных'}`);
}

async function handleBotSettings(db: any, chatId: number, userId: number): Promise<void> {
  const { data: user } = await db.from('users').select('id').eq('telegram_id', userId).maybeSingle();
  if (!user) { await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, 'Войдите в SimaDesk.'); return; }

  const { data: s } = await db.from('tg_notification_settings')
    .select('*').eq('user_id', user.id).maybeSingle();

  const on = (v: boolean | null) => v ? '✅' : '❌';
  const text = `⚙️ <b>Настройки уведомлений</b>\n\n` +
    `${on(s?.notify_new_order)} Новые заказы\n` +
    `${on(s?.notify_low_stock)} Низкие остатки (порог: ${s?.low_stock_threshold ?? 5} шт.)\n` +
    `${on(s?.notify_bad_review)} Плохие отзывы (1-2★)\n` +
    `${on(s?.notify_daily_summary)} Ежедневная сводка\n\n` +
    `Настройте в приложении: Настройки → Уведомления`;

  await tgSend(Deno.env.get('BOT_TOKEN')!, chatId, text);
}

// ── Telegram Bot: webhook handler ─────────────────────────────────────────────

async function handleBotWebhook(update: Record<string, unknown>): Promise<Response> {
  const botToken = Deno.env.get('BOT_TOKEN');
  if (!botToken) return new Response('BOT_TOKEN not configured', { status: 500 });

  const msg = update.message as Record<string, unknown> | undefined;
  const cb = update.callback_query as Record<string, unknown> | undefined;

  const apiUrl = Deno.env.get('SUPABASE_URL')!;
  const db = createClient(apiUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Handle callback queries
  if (cb) {
    await tgAnswerCb(botToken, String(cb.id ?? ''));
    return new Response('ok');
  }

  // Handle messages
  if (msg?.text) {
    const chat = msg.chat as Record<string, unknown> | undefined;
    const from = msg.from as Record<string, unknown> | undefined;
    const chatId = Number(chat?.id ?? 0);
    const userId = Number(from?.id ?? 0);
    const firstName = String(from?.first_name ?? '');
    const text = String(msg.text).trim();

    if (!userId) return new Response('ok');

    let reply: string | null = null;

    if (text === '/start' || text === '/start@simadesk_bot') {
      reply = await handleBotStart(db, chatId, userId, firstName);
    } else if (text === '/today' || text === '/today@simadesk_bot') {
      await handleBotToday(db, chatId, userId);
    } else if (text === '/orders' || text === '/orders@simadesk_bot') {
      await handleBotOrders(db, chatId, userId);
    } else if (text === '/stock' || text === '/stock@simadesk_bot') {
      await handleBotStock(db, chatId, userId);
    } else if (text === '/revenue' || text === '/revenue@simadesk_bot') {
      await handleBotRevenue(db, chatId, userId);
    } else if (text === '/settings' || text === '/settings@simadesk_bot') {
      await handleBotSettings(db, chatId, userId);
    } else if (text === '/help') {
      reply = 'Команды:\n/start — привязать чат\n/today — сводка\n/orders — заказы\n/stock — остатки\n/revenue — выручка\n/settings — настройки';
    }

    if (reply) await tgSend(botToken, chatId, reply);
  }

  return new Response('ok');
}

// ── TTS Edge proxy (delegates to tts-server Python container) ─────────────────

const TTS_SERVER = 'http://tts-server:8765/synthesize';

async function handleTtsEdge(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  let body: string;
  try { body = await req.text(); } catch {
    return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const upstream = await fetch(TTS_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const audio = await upstream.arrayBuffer();
    if (!upstream.ok || audio.byteLength === 0) {
      return new Response(JSON.stringify({ error: 'tts_error' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(audio, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.byteLength), 'Cache-Control': 'no-store' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'error';
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// ── ЮKassa payment handler ────────────────────────────────────────────────────
async function handleYookassaPay(req: Request, url: URL): Promise<Response> {
  const shopId  = Deno.env.get('YOOKASSA_SHOP_ID');
  const secret  = Deno.env.get('YOOKASSA_SECRET_KEY');
  const jsonRes = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  if (!shopId || !secret) return jsonRes({ error: 'ЮKassa не настроена на сервере' }, 503);

  const subPath = url.pathname.replace(/^.*yookassa-pay/, '').replace(/^\/+/, '');

  // GET /yookassa-pay/status?payment_id=XX — check payment status
  if (req.method === 'GET' && subPath === 'status') {
    const paymentId = url.searchParams.get('payment_id');
    if (!paymentId) return jsonRes({ error: 'no payment_id' }, 400);
    const r = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: { Authorization: 'Basic ' + btoa(`${shopId}:${secret}`) },
    });
    if (!r.ok) return jsonRes({ error: 'ЮKassa error' }, 502);
    const p = await r.json();
    return jsonRes({ status: p.status, paid: p.paid });
  }

  // POST /yookassa-pay/webhook — ЮKassa notification
  if (req.method === 'POST' && subPath === 'webhook') {
    let event: any;
    try { event = await req.json(); } catch { return jsonRes({ error: 'bad json' }, 400); }
    if (event?.type === 'notification' && event.object?.status === 'succeeded') {
      const obj = event.object;
      const { company_id, plan_key, price_rub } = obj.metadata ?? {};
      if (company_id && plan_key) {
        const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const now = new Date();
        const end = new Date(now); end.setMonth(end.getMonth() + 1);
        await db.from('user_subscriptions').upsert({
          company_id, plan_key, status: 'active',
          price_rub: Number(price_rub) || 0, monthly_revenue: 0,
          current_period_start: now.toISOString(),
          current_period_end: end.toISOString(),
          yookassa_payment_id: obj.id,
        }, { onConflict: 'company_id' });
      }
    }
    return jsonRes({ ok: true });
  }

  // POST /yookassa-pay — create payment
  if (req.method !== 'POST') return jsonRes({ error: 'Method Not Allowed' }, 405);
  const authHeader = req.headers.get('authorization') ?? '';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: { user }, error: authErr } = await db.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authErr || !user) return jsonRes({ error: 'Не авторизован' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return jsonRes({ error: 'bad json' }, 400); }
  const { company_id, plan_key, price_rub, return_url } = body;
  if (!company_id || !plan_key || !price_rub || !return_url) return jsonRes({ error: 'Не переданы параметры' }, 400);

  const ykRes = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${shopId}:${secret}`),
      'Idempotence-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: { value: Number(price_rub).toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url },
      description: `SimaDesk — тариф ${plan_key} · ${Number(price_rub).toLocaleString('ru')} ₽/мес`,
      metadata: { company_id, plan_key, user_id: user.id, price_rub },
    }),
  });
  if (!ykRes.ok) { console.error('YK error:', await ykRes.text()); return jsonRes({ error: 'Ошибка создания платежа' }, 502); }
  const payment = await ykRes.json();
  return jsonRes({ payment_id: payment.id, confirmation_url: payment.confirmation?.confirmation_url });
}

// ── MP News Fetch handler ────────────────────────────────────────────────────

// Каналы загружаются из БД — не хардкодим
type TgChannel = { mp: string; slug: string; label: string };

function extractTgMessages(html: string, channelSlug: string): Array<{ text: string; url: string; date: string }> {
  const results: Array<{ text: string; url: string; date: string }> = [];
  // Находим блоки сообщений
  const msgRegex = /<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const msgs = html.match(msgRegex) ?? [];

  for (const block of msgs) {
    // Извлекаем текст (без HTML-тегов)
    const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) continue;
    const rawText = textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    if (!rawText || rawText.length < 30) continue;

    // Извлекаем дату
    const dateMatch = block.match(/datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString();

    // Извлекаем ссылку на пост
    const urlMatch = block.match(/href="(https:\/\/t\.me\/[^"]+\/\d+)"/);
    const url = urlMatch ? urlMatch[1] : `https://t.me/${channelSlug}`;

    results.push({ text: rawText, url, date });
  }

  // Если regex не нашёл блоки — пробуем простой экстракт текстов
  if (!results.length) {
    const simpleText = /<div[^>]+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const simpleDates = html.match(/datetime="([^"]+)"/g) ?? [];
    const simpleUrls = html.match(/href="(https:\/\/t\.me\/[^"]+\/\d+)"/g) ?? [];
    let i = 0;
    let m: RegExpExecArray | null;
    while ((m = simpleText.exec(html)) !== null) {
      const rawText = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      if (rawText.length < 30) continue;
      const date = simpleDates[i]?.match(/datetime="([^"]+)"/)?.[1] ?? new Date().toISOString();
      const url  = simpleUrls[i]?.match(/href="([^"]+)"/)?.[1] ?? `https://t.me/${channelSlug}`;
      results.push({ text: rawText, url, date });
      i++;
    }
  }

  return results;
}

async function aiSummarize(text: string, mp: string, orKey: string): Promise<{ title: string; summary: string; is_important: boolean } | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}` },
      body: JSON.stringify({
        model: 'google/gemini-flash-1.5',
        max_tokens: 250,
        messages: [{
          role: 'user',
          content: `Ты фильтр и аналитик для продавцов на маркетплейсах (${mp}).

СНАЧАЛА ПРОВЕРЬ — это реклама/спам/нерелевантный контент?
Признаки спама/рекламы: призывы купить курсы или подписки, реклама сторонних сервисов, конкурсы, поздравления, мотивационные цитаты, самореклама канала, юмор без практической ценности.
Если ЭТО СПАМ/РЕКЛАМА — верни: {"skip":true}

Если это РЕАЛЬНАЯ НОВОСТЬ для продавца — верни JSON:
{"title":"Краткий заголовок до 80 символов","summary":"1-2 предложения: что изменилось и что это значит для продавца","is_important":true/false}
is_important=true если: изменение комиссий/тарифов, логистики, правил работы, штрафов, требований к товарам, технических изменений платформы, крупных программ поддержки.
is_important=false если: общие советы, статистика без изменений, мелкие обновления.

Текст:\n${text.slice(0, 1200)}`
        }],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    const parsed = JSON.parse(jsonMatch);
    if (parsed.skip) return null;
    if (!parsed.title || !parsed.summary) return null;
    return { title: String(parsed.title).slice(0, 120), summary: String(parsed.summary).slice(0, 400), is_important: !!parsed.is_important };
  } catch { return null; }
}

/** Общая логика обновления памяти Симы — вызывается из news-fetch и из отдельного endpoint. */
async function runBrainUpdate(db: ReturnType<typeof createClient>, orKey: string, sinceDays: number): Promise<{ updated: number; total_news: number; error?: string }> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data: news } = await db.from('mp_news')
    .select('id, mp, title, summary, is_important, published_at')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(120);

  if (!news?.length) return { updated: 0, total_news: 0 };

  const { data: existing } = await db.from('sima_memory').select('mp,category,title,keywords,updated_at');

  const newsText = (news as any[])
    .map((n: any) => `[${String(n.id).slice(0, 8)} | ${n.mp.toUpperCase()} | ${n.published_at.slice(0, 10)}${n.is_important ? ' ⚠' : ''}] ${n.title}: ${n.summary}`)
    .join('\n');

  const existingText = existing?.length
    ? (existing as any[]).map((e: any) => `mp=${e.mp} cat=${e.category} title="${e.title}" kw=[${(e.keywords ?? []).join(',')}] upd=${e.updated_at?.slice(0, 10)}`).join('\n')
    : '(пусто)';

  const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-flash-1.5',
      max_tokens: 6000,
      messages: [
        {
          role: 'system',
          content: `Ты — система формирования памяти AI-ассистента «Сима» для работы с маркетплейсами.
Анализируй новости и формируй/обновляй записи структурированных знаний.

Правила полей:
- mp: "wb" | "ozon" | "yandex" | "general" (general = касается всех МП)
- category: "fees" (комиссии/тарифы) | "logistics" (доставка/склад/хранение) | "requirements" (правила/маркировка/запреты) | "promotions" (акции/реклама) | "tech" (API/кабинет/обновления) | "payments" (выплаты/штрафы/финансы) | "other"
- title: 3-7 слов, конкретная тема, уникальная в рамках mp+category
- content: актуальное знание в Markdown. Конкретные цифры, даты. 3-10 предложений.
- keywords: 6-12 слов/фраз для поиска (русские), включая синонимы
- source_news_ids: первые 8 символов UUID из которых извлечена информация

Создавай ТОЛЬКО записи с конкретными фактами. Если тема уже есть — обнови (тот же mp+category+title).
Отвечай ТОЛЬКО валидным JSON-массивом без markdown-обёртки.`,
        },
        {
          role: 'user',
          content: `СУЩЕСТВУЮЩАЯ ПАМЯТЬ:\n${existingText}\n\nНОВОСТИ (${(news as any[]).length} шт, за ${sinceDays} дн):\n${newsText}\n\nСформируй JSON-массив записей памяти для обновления/создания.`,
        },
      ],
    }),
  });

  if (!aiRes.ok) return { updated: 0, total_news: (news as any[]).length, error: `OpenRouter ${aiRes.status}` };
  const aiJson = await aiRes.json();
  const content: string = aiJson.choices?.[0]?.message?.content ?? '';
  const arrMatch = content.match(/\[[\s\S]*\]/);
  if (!arrMatch) return { updated: 0, total_news: (news as any[]).length, error: 'AI не вернул JSON' };

  let entries: any[];
  try { entries = JSON.parse(arrMatch[0]); } catch { return { updated: 0, total_news: (news as any[]).length, error: 'JSON parse failed' }; }

  let updated = 0;
  for (const e of entries) {
    if (!e.mp || !e.category || !e.title || !e.content) continue;
    await db.from('sima_memory').upsert({
      mp: String(e.mp).slice(0, 20),
      category: String(e.category).slice(0, 40),
      title: String(e.title).slice(0, 120),
      content: String(e.content).slice(0, 4000),
      keywords: Array.isArray(e.keywords) ? e.keywords.slice(0, 15).map((k: any) => String(k).slice(0, 50)) : [],
      source_news_ids: Array.isArray(e.source_news_ids) ? e.source_news_ids.slice(0, 20) : [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'mp,category,title' });
    updated++;
  }

  return { updated, total_news: (news as any[]).length };
}

async function handleSimaBrainUpdate(req: Request): Promise<Response> {
  const jsonRes = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 20) return jsonRes({ error: 'Unauthorized' }, 401);

  const orKey = Deno.env.get('OPENROUTER_KEY');
  if (!orKey) return jsonRes({ error: 'OPENROUTER_KEY not configured' }, 503);

  const body = await req.json().catch(() => ({}));
  const sinceDays: number = Math.min(Number(body.since_days ?? 30), 90);

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const result = await runBrainUpdate(db, orKey, sinceDays);
  return jsonRes({ ok: !result.error, ...result });
}

async function handleMpNewsFetch(req: Request): Promise<Response> {
  const jsonRes = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Защита: CRON_SECRET (для ручного запуска из админки), JWT, или pg-cron (внутренний вызов)
  const secret = Deno.env.get('CRON_SECRET');
  const cronOk = !secret || req.headers.get('x-cron-secret') === secret;
  const authHeader = req.headers.get('authorization') || '';
  const jwtOk = authHeader.startsWith('Bearer ') && authHeader.length > 20;
  const pgCronOk = req.headers.get('x-cron-source') === 'pg-cron';
  if (!cronOk && !jwtOk && !pgCronOk) {
    return jsonRes({ error: 'Unauthorized' }, 401);
  }

  const orKey = Deno.env.get('OPENROUTER_KEY');
  if (!orKey) return jsonRes({ error: 'OPENROUTER_KEY not configured' }, 503);

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Загружаем каналы из БД
  const { data: channelsData, error: chErr } = await db
    .from('mp_news_channels')
    .select('mp, channel_slug, label')
    .eq('enabled', true);

  if (chErr) return jsonRes({ error: `DB channels error: ${chErr.message}` }, 500);
  const channels: TgChannel[] = (channelsData ?? []).map((r: Record<string, string>) => ({
    mp: r.mp,
    slug: r.channel_slug,
    label: r.label || r.mp,
  }));
  if (!channels.length) return jsonRes({ ok: true, saved: [], errors: ['No channels configured'], ts: new Date().toISOString() });

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString(); // последние 30 дней
  const saved: string[] = [];
  const errors: string[] = [];

  const tgProxy = Deno.env.get('TG_PROXY_URL'); // прокси для Telegram (если не заблокирован)

  for (const ch of channels) {
    try {
      // ── Telegram-источник (прямой scraping или через прокси) ───────────────
      const tgUrl = tgProxy
        ? `${tgProxy.replace(/\/$/, '')}/${ch.slug}`
        : `https://t.me/s/${ch.slug}`;
      const ctrl = new AbortController();
      const tmo = setTimeout(() => ctrl.abort(), 12_000);
      let pageRes: Response;
      try {
        pageRes = await fetch(tgUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimaDesk/1.0)' },
          signal: ctrl.signal,
        });
      } catch (fe: unknown) {
        clearTimeout(tmo);
        const msg = fe instanceof Error ? fe.message : 'fetch error';
        errors.push(`${ch.mp} (${ch.slug}): ${msg.includes('abort') ? 'timeout — Telegram заблокирован на этом VPS. Настрой TG_PROXY_URL в .env' : msg}`);
        continue;
      }
      clearTimeout(tmo);
      if (!pageRes.ok) { errors.push(`${ch.mp}: HTTP ${pageRes.status}`); continue; }
      const html = await pageRes.text();
      const messages = extractTgMessages(html, ch.slug);

      // Только свежие
      const fresh = messages.filter(m => m.date > since).slice(0, 8);

      for (const msg of fresh) {
        // Проверяем дубли
        const { data: existing } = await db.from('mp_news').select('id').eq('source_url', msg.url).maybeSingle();
        if (existing) continue;

        const ai = await aiSummarize(msg.text, ch.label, orKey);
        if (!ai) continue;

        await db.from('mp_news').insert({
          mp: ch.mp,
          title: ai.title,
          summary: ai.summary,
          raw_text: msg.text.slice(0, 2000),
          source_url: msg.url,
          is_important: ai.is_important,
          published_at: msg.date,
        });
        saved.push(`${ch.mp}: ${ai.title}`);

        // Небольшая пауза между AI-запросами
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e: unknown) {
      errors.push(`${ch.mp}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  // Автоматически обновляем мозг Симы если были новые статьи
  if (saved.length > 0 && orKey) {
    runBrainUpdate(db, orKey, 7).catch(() => { /* non-critical */ });
  }

  return jsonRes({ ok: true, saved, errors, ts: new Date().toISOString() });
}

// ── Main handler (router) ─────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/+/, '');
  const sub = path.replace(/^telegram-auth\//, '');

  // Route to mp-news-fetch handler
  if (sub === 'mp-news-fetch' || path === 'mp-news-fetch') {
    try { return await handleMpNewsFetch(req); }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Route to sima-brain-update handler
  if (sub === 'sima-brain-update' || path === 'sima-brain-update') {
    try { return await handleSimaBrainUpdate(req); }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Route to tts-edge handler
  if (sub === 'tts-edge' || path === 'tts-edge') {
    try { return await handleTtsEdge(req); }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Route to yookassa-pay handler
  if (path.includes('yookassa-pay') || sub.includes('yookassa-pay')) {
    try { return await handleYookassaPay(req, url); }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'error';
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Route to yandex-auth handler
  if (sub === 'yandex-auth' || path === 'yandex-auth') {
    try {
      return await handleYandexAuth(req);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[yandex-auth] Error:', message);
      return new Response(JSON.stringify({ error: message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Default: telegram-auth OR telegram-bot webhook
  // Edge runtime only routes to the main service — we differentiate by body content.
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const botToken = Deno.env.get('BOT_TOKEN');
    if (!botToken) {
      return new Response(JSON.stringify({ error: 'BOT_TOKEN not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Telegram Bot webhook (has "message" or "callback_query") ────────────
    if (body.message || body.callback_query) {
      try {
        return await handleBotWebhook(body);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[telegram-bot] Error:', message);
        return new Response('ok'); // Always return 200 to Telegram to prevent retries
      }
    }

    // ── Mini App path ─────────────────────────────────────────────────────────
    if (body.init_data && typeof body.init_data === 'string') {
      const result = await verifyInitData(body.init_data, botToken);
      if (!result.ok) {
        return new Response(JSON.stringify({ error: 'Invalid initData', reason: result.reason }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return await processAuth(result.user!);
    }

    // ── Login Widget path ─────────────────────────────────────────────────────
    const telegramData: Record<string, unknown> = body.telegram_data;
    if (!telegramData || typeof telegramData !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing telegram_data' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const verification = await verifyLoginWidget(telegramData, botToken);
    if (!verification.ok) {
      return new Response(JSON.stringify({ error: 'Invalid Telegram auth data', reason: verification.reason }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tgUser: Record<string, string> = {};
    for (const [k, v] of Object.entries(telegramData)) tgUser[k] = String(v);
    return await processAuth(tgUser);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[telegram-auth] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
