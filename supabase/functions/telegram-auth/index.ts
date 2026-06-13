/**
 * Supabase Edge Function: Telegram Auth
 *
 * Verifies Telegram Login Widget data (HMAC-SHA256),
 * creates or finds the user in Supabase auth + users table,
 * and returns a Supabase session (access_token + refresh_token).
 *
 * Deploy: supabase functions deploy telegram-auth
 * Env vars needed in Supabase dashboard:
 *   BOT_TOKEN  — your Telegram bot token from @BotFather
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Telegram signature verification ───────────────────────────────────────────
async function verifyTelegramAuth(
  data: Record<string, unknown>,
  botToken: string,
): Promise<{ ok: boolean; reason?: string; debug?: Record<string, unknown> }> {
  const hash = data.hash as string | undefined;
  if (!hash) return { ok: false, reason: 'no_hash' };

  // Build fields without hash, ensuring all values are strings
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'hash') fields[k] = String(v);
  }

  // auth_date must be within 24 hours
  const authDate = parseInt(fields.auth_date || '0', 10);
  const ageSecs = Date.now() / 1000 - authDate;
  if (ageSecs > 86400) {
    return { ok: false, reason: 'auth_date_expired', debug: { ageSecs, authDate } };
  }

  // Build check string: sorted "key=value" pairs joined with \n
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const enc = new TextEncoder();

  // For Login Widget: secret = SHA-256(bot_token), then HMAC-SHA256(secret, check_string)
  const botTokenHash = await crypto.subtle.digest('SHA-256', enc.encode(botToken));

  const secretKey = await crypto.subtle.importKey(
    'raw',
    botTokenHash,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', secretKey, enc.encode(checkString));

  const computedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const ok = computedHex === hash;
  return ok
    ? { ok: true }
    : { ok: false, reason: 'hash_mismatch', debug: { computedHex, receivedHash: hash, checkString } };
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const telegramData: Record<string, unknown> = body.telegram_data;

    if (!telegramData || typeof telegramData !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing telegram_data' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const botToken = Deno.env.get('BOT_TOKEN');
    if (!botToken) {
      return new Response(JSON.stringify({ error: 'BOT_TOKEN not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify Telegram signature
    const verification = await verifyTelegramAuth(telegramData, botToken);
    if (!verification.ok) {
      console.error('[telegram-auth] Verification failed:', verification.reason, verification.debug);
      return new Response(
        JSON.stringify({ error: 'Invalid Telegram auth data', reason: verification.reason, debug: verification.debug }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Init Supabase admin client (service role — full access, no RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const telegramId = parseInt(String(telegramData.id), 10);
    const firstName = String(telegramData.first_name || '');
    const lastName = telegramData.last_name ? String(telegramData.last_name) : null;
    const username = telegramData.username ? String(telegramData.username) : null;
    const photoUrl = telegramData.photo_url ? String(telegramData.photo_url) : null;

    // ── Find existing user by telegram_id ─────────────────────
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;

      // Update profile data + last_login
      await supabase
        .from('users')
        .update({
          telegram_username: username,
          first_name: firstName,
          last_name: lastName,
          photo_url: photoUrl,
          last_login_at: new Date().toISOString(),
        })
        .eq('id', userId);
    } else {
      // ── Create new Supabase auth user ──────────────────────────
      // We use a deterministic fake email to make Supabase auth happy
      const fakeEmail = `tg${telegramId}@stockbase.app`;

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: fakeEmail,
        email_confirm: true,
        user_metadata: {
          telegram_id: telegramId,
          first_name: firstName,
          username: username,
        },
      });

      if (authError) {
        // If user already exists in auth but not in our users table (edge case)
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

      // Create user profile row
      await supabase.from('users').insert({
        id: userId,
        telegram_id: telegramId,
        telegram_username: username,
        first_name: firstName,
        last_name: lastName,
        photo_url: photoUrl,
        last_login_at: new Date().toISOString(),
      });
    }

    // ── Process pending username-based invitations ─────────────
    if (username) {
      const { data: pendingInvites } = await supabase
        .from('company_invitations')
        .select('id, company_id, role')
        .eq('telegram_username', username.toLowerCase())
        .is('used_at', null);

      for (const invite of pendingInvites ?? []) {
        // Upsert: ignore if already a member
        await supabase.from('company_members').upsert(
          { company_id: invite.company_id, user_id: userId, role: invite.role },
          { onConflict: 'company_id,user_id', ignoreDuplicates: true },
        );
        await supabase
          .from('company_invitations')
          .update({ used_at: new Date().toISOString(), used_by: userId })
          .eq('id', invite.id);
      }
    }

    // ── Create a Supabase session for this user ────────────────
    // generateLink gives us a one-time magic link; we exchange it immediately
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: `tg${telegramId}@stockbase.app`,
      options: { redirectTo: '' },
    });

    if (linkError) throw linkError;

    // Extract the token from the magic link and exchange it for a full session
    const linkUrl = new URL(linkData.properties.action_link);
    const token = linkUrl.searchParams.get('token') || linkUrl.hash.match(/access_token=([^&]+)/)?.[1];

    // Alternatively: use verifyOtp with the token_hash
    const tokenHash = linkData.properties.hashed_token;

    const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });

    if (sessionError || !sessionData.session) {
      throw sessionError || new Error('Failed to create session');
    }

    return new Response(
      JSON.stringify({
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_in: sessionData.session.expires_in,
        user_id: userId,
        first_name: firstName,
        username: username,
        photo_url: photoUrl,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[telegram-auth] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
