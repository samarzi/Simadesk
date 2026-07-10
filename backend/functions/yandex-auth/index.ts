/**
 * Edge Function: Yandex OAuth Auth
 *
 * Flow:
 *   1. Frontend redirects user to Yandex OAuth (implicit flow, response_type=token)
 *   2. Yandex redirects back with #access_token=...
 *   3. Frontend extracts token from hash and POSTs {yandex_token} here
 *   4. We verify via Yandex API, create/update user row, return JWT
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface YandexUserInfo {
  id: string;
  login: string;
  display_name: string;
  real_name: string;
  first_name: string;
  last_name: string;
  default_email: string;
  default_avatar_id: string;
}

async function getYandexUserInfo(token: string): Promise<YandexUserInfo> {
  const res = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!res.ok) throw new Error(`Yandex API error: ${res.status}`);
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const yandexToken = body.yandex_token as string | undefined;
    if (!yandexToken) {
      return new Response(JSON.stringify({ error: 'Missing yandex_token' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const yUser = await getYandexUserInfo(yandexToken);
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

    const { data: existingUser } = await db.from('users')
      .select('id').eq('yandex_id', yandexId).maybeSingle();

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      await db.from('users').update({
        first_name: firstName, last_name: lastName,
        photo_url: photoUrl, last_login_at: new Date().toISOString(),
      }).eq('id', userId);
    } else {
      const { data: authData, error: authError } = await db.auth.admin.createUser({
        email: fakeEmail, email_confirm: true,
        user_metadata: { yandex_id: yandexId, first_name: firstName },
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
        id: userId, yandex_id: yandexId,
        first_name: firstName, last_name: lastName,
        photo_url: photoUrl, last_login_at: new Date().toISOString(),
      });
    }

    const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
      type: 'magiclink', email: fakeEmail, options: { redirectTo: '' },
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
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[yandex-auth] Error:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
