/**
 * Supabase Edge Function — прокси к WB API.
 * Запускается на Deno Deploy (IP не совпадают с Netlify, WB не блокирует).
 * WB API ключ передаётся в заголовке Authorization.
 * Supabase anon key передаётся в заголовке apikey (для доступа к функции).
 *
 * Deploy: supabase functions deploy wb-proxy --no-verify-jwt --project-ref rdqwzojrsmbdxiczqjci
 */

const WB_HOSTS: Record<string, string> = {
  'wb-content':     'https://content-api.wildberries.ru',
  'wb-marketplace': 'https://marketplace-api.wildberries.ru',
  'wb-stats':       'https://statistics-api.wildberries.ru',
  'wb-common':      'https://common-api.wildberries.ru',
  'wb-feedback':    'https://feedbacks-api.wildberries.ru',
  'wb-buyer-chat':  'https://buyer-chat-api.wildberries.ru',
  'wb-prices':      'https://discounts-prices-api.wildberries.ru',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, accept',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // Path: /functions/v1/wb-proxy/wb-stats/api/v1/supplier/stocks
  // Split and find WB prefix segment
  const segments = url.pathname.split('/').filter(Boolean);

  let targetBase: string | null = null;
  let suffixSegments: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (WB_HOSTS[segments[i]]) {
      targetBase = WB_HOSTS[segments[i]];
      suffixSegments = segments.slice(i + 1);
      break;
    }
  }

  if (!targetBase) {
    return new Response(
      JSON.stringify({ error: 'Unknown WB prefix. Use wb-content, wb-marketplace, wb-stats, wb-common, wb-feedback, wb-buyer-chat, or wb-prices.' }),
      { status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const pathSuffix = suffixSegments.length > 0 ? '/' + suffixSegments.join('/') : '';
  const targetUrl = targetBase + pathSuffix + url.search;

  // Forward only the headers WB API needs — strip origin/referer/host/apikey
  const forwardHeaders = new Headers();
  const auth = req.headers.get('authorization');
  if (auth) forwardHeaders.set('Authorization', auth);
  const ct = req.headers.get('content-type');
  if (ct) forwardHeaders.set('Content-Type', ct);
  forwardHeaders.set('Accept', 'application/json');

  const isBodyless = req.method === 'GET' || req.method === 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: isBodyless ? undefined : req.body,
      // @ts-ignore — duplex needed for streaming body
      duplex: isBodyless ? undefined : 'half',
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'proxy_error', detail: String(err) }),
      { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const responseHeaders = new Headers(corsHeaders);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'access-control-allow-origin' && lower !== 'access-control-allow-headers') {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
