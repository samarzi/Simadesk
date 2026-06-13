/**
 * Netlify Edge Function — прокси к API маркетплейсов.
 * Удаляет Origin/Referer перед отправкой запроса, чтобы API не считал его CORS-запросом.
 * Edge Functions запускаются ДО redirect-правил, поэтому конфликтов нет.
 */

const ROUTES: Record<string, string> = {
  '/ozon-api':       'https://api-seller.ozon.ru',
  '/yandex-api':     'https://api.partner.market.yandex.ru',
  '/wb-content':     'https://content-api.wildberries.ru',
  '/wb-marketplace': 'https://marketplace-api.wildberries.ru',
  '/wb-stats':       'https://statistics-api.wildberries.ru',
  '/wb-common':      'https://common-api.wildberries.ru',
  '/wb-feedback':    'https://feedbacks-api.wildberries.ru',
  '/wb-buyer-chat':  'https://buyer-chat-api.wildberries.ru',
};

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  let targetBase: string | null = null;
  let pathSuffix = url.pathname;

  for (const [prefix, target] of Object.entries(ROUTES)) {
    if (url.pathname.startsWith(prefix + '/') || url.pathname === prefix) {
      targetBase = target;
      pathSuffix = url.pathname.slice(prefix.length);
      break;
    }
  }

  if (!targetBase) {
    return new Response('Not found', { status: 404 });
  }

  const targetUrl = targetBase + pathSuffix + url.search;

  const headers = new Headers(request.headers);
  // Убираем CORS-заголовки, чтобы API не считал запрос браузерным кросс-доменным
  headers.delete('origin');
  headers.delete('referer');
  headers.delete('host');

  const isBodyless = request.method === 'GET' || request.method === 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method:  request.method,
      headers,
      body:    isBodyless ? undefined : request.body,
      // @ts-ignore — Deno/Edge не клонирует тело повторно
      duplex:  isBodyless ? undefined : 'half',
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'proxy_error', detail: String(err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Возвращаем ответ как есть; CORS-заголовки не нужны — ответ "видит" только Edge
  return new Response(upstream.body, {
    status:  upstream.status,
    headers: upstream.headers,
  });
};

export const config = {
  path: [
    '/ozon-api/*',
    '/yandex-api/*',
    '/wb-content/*',
    '/wb-marketplace/*',
    '/wb-stats/*',
    '/wb-common/*',
    '/wb-feedback/*',
    '/wb-buyer-chat/*',
  ],
};
