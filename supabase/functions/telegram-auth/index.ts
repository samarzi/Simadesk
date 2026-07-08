/**
 * Supabase Edge Function: Telegram Auth
 *
 * Supports two auth flows:
 *   1. Telegram Login Widget  → body.telegram_data (object)
 *   2. Telegram Mini App      → body.init_data (URL-encoded string)
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
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
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
  const { data: existingUser } = await supabase.from('users').select('id').eq('telegram_id', telegramId).maybeSingle();

  let userId: string;

  if (existingUser) {
    userId = existingUser.id;
    await supabase.from('users').update({
      telegram_username: username, first_name: firstName, last_name: lastName,
      photo_url: photoUrl, last_login_at: new Date().toISOString(),
    }).eq('id', userId);
  } else {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: fakeEmail, email_confirm: true,
      user_metadata: { telegram_id: telegramId, first_name: firstName, username },
    });

    if (authError) {
      if (authError.message?.includes('already exists')) {
        const { data: authUser } = await supabase.auth.admin.getUserByEmail(fakeEmail);
        if (!authUser?.user) throw authError;
        userId = authUser.user.id;
      } else {
        throw authError;
      }
    } else {
      userId = authData.user!.id;
    }

    await supabase.from('users').insert({
      id: userId, telegram_id: telegramId, telegram_username: username,
      first_name: firstName, last_name: lastName, photo_url: photoUrl,
      last_login_at: new Date().toISOString(),
    });
  }

  // Process pending invitations
  if (username) {
    const { data: pendingInvites } = await supabase
      .from('company_invitations').select('id, company_id, role')
      .eq('telegram_username', username.toLowerCase()).is('used_at', null);

    for (const invite of pendingInvites ?? []) {
      await supabase.from('company_members').upsert(
        { company_id: invite.company_id, user_id: userId, role: invite.role },
        { onConflict: 'company_id,user_id', ignoreDuplicates: true },
      );
      await supabase.from('company_invitations')
        .update({ used_at: new Date().toISOString(), used_by: userId }).eq('id', invite.id);
    }
  }

  // Create session via magic link
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink', email: fakeEmail, options: { redirectTo: '' },
  });
  if (linkError) throw linkError;

  const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token, type: 'magiclink',
  });
  if (sessionError || !sessionData.session) throw sessionError || new Error('Failed to create session');

  return new Response(JSON.stringify({
    access_token: sessionData.session.access_token,
    refresh_token: sessionData.session.refresh_token,
    expires_in: sessionData.session.expires_in,
    user_id: userId, first_name: firstName, username, photo_url: photoUrl,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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
