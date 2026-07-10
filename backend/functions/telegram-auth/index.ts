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

// ── Main handler (router) ─────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/+/, '');

  // Route to yandex-auth handler
  if (path === 'yandex-auth') {
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

  // Default: telegram-auth
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
