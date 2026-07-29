import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'
import type { Plugin } from 'vite'
import { createHmac, createHash } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

// ── Local dev auth handler (mirrors Supabase Edge Function) ────────────────────
// Runs inside Vite dev server — no extra port needed.
// In production the request goes to Supabase Edge Function instead.
function localAuthPlugin(env: Record<string, string>): Plugin {
  const API_URL  = env.VITE_API_URL;
  const API_KEY  = env.VITE_API_KEY;
  const BOT_TOKEN = env.BOT_TOKEN || env.VITE_BOT_TOKEN_DEV || '';

  async function verifyTelegramWidget(data: Record<string, string>): Promise<boolean> {
    const { hash, ...fields } = data;
    if (!hash) return false;
    const authDate = parseInt(fields.auth_date || '0', 10);
    if (Date.now() / 1000 - authDate > 86400) return false;
    const checkString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
    const secretKey = createHash('sha256').update(BOT_TOKEN).digest();
    const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex');
    return hmac === hash;
  }

  function verifyTelegramMiniApp(initData: string): Record<string, string> | null {
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (!hash) return null;
      params.delete('hash');
      const checkArr: string[] = [];
      params.forEach((v, k) => checkArr.push(`${k}=${v}`));
      checkArr.sort();
      const checkString = checkArr.join('\n');
      const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex');
      if (hmac !== hash) return null;
      const userRaw = params.get('user');
      return userRaw ? JSON.parse(userRaw) : null;
    } catch { return null; }
  }

  async function findOrCreateSupabaseUser(telegramUser: {
    id: number; first_name?: string; last_name?: string;
    username?: string; photo_url?: string;
  }): Promise<{ access_token: string; refresh_token: string; user_id: string } | null> {
    const serviceKey = env.SERVICE_ROLE_KEY || '';
    if (!serviceKey) {
      // No service role key in dev — return mock session
      return {
        access_token:  `dev_${telegramUser.id}_${Date.now()}`,
        refresh_token: `dev_refresh_${telegramUser.id}`,
        user_id: `dev-user-${telegramUser.id}`,
      };
    }

    const adminHeaders = {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer': 'return=representation',
    };

    // Find existing user
    const existingRes = await fetch(
      `${API_URL}/rest/v1/users?telegram_id=eq.${telegramUser.id}&select=id`,
      { headers: adminHeaders }
    );
    const existing = await existingRes.json().catch(() => []);
    if (!existingRes.ok) console.error('[dev-auth] find user failed:', existingRes.status, existing);

    let userId: string;

    if (Array.isArray(existing) && existing.length > 0) {
      userId = existing[0].id;
      await fetch(`${API_URL}/rest/v1/users?id=eq.${userId}`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({ last_login_at: new Date().toISOString() }),
      });
    } else {
      // Create auth user
      const fakeEmail = `tg${telegramUser.id}@simadesk.app`;
      const authFetch = await fetch(`${API_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { ...adminHeaders, 'apikey': serviceKey },
        body: JSON.stringify({
          email: fakeEmail, email_confirm: true,
          user_metadata: { telegram_id: telegramUser.id, first_name: telegramUser.first_name },
        }),
      });
      const authRes = await authFetch.json().catch(() => null);
      if (!authFetch.ok) console.error('[dev-auth] create auth user failed:', authFetch.status, authRes);

      if (!authRes?.id) return null;
      userId = authRes.id;

      const insRes = await fetch(`${API_URL}/rest/v1/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          id: userId,
          telegram_id: telegramUser.id,
          telegram_username: telegramUser.username ?? null,
          first_name: telegramUser.first_name ?? '',
          last_name: telegramUser.last_name ?? null,
          photo_url: telegramUser.photo_url ?? null,
          last_login_at: new Date().toISOString(),
        }),
      });
      if (!insRes.ok) console.error('[dev-auth] insert users row failed:', insRes.status, await insRes.text().catch(() => ''));
    }

    // Generate magic link and exchange for session
    const linkFetch = await fetch(`${API_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { ...adminHeaders, 'apikey': serviceKey },
      body: JSON.stringify({ type: 'magiclink', email: `tg${telegramUser.id}@simadesk.app` }),
    });
    const linkRes = await linkFetch.json().catch(() => null);
    if (!linkFetch.ok) console.error('[dev-auth] generate_link failed:', linkFetch.status, linkRes);

    // Сырой REST-ответ GoTrue отдаёт hashed_token в корне объекта, БЕЗ обёртки
    // properties — в отличие от server SDK (используется в проде в
    // backend/functions/telegram-auth), который сам оборачивает ответ в
    // { properties: {...} }. Смотрим оба варианта на случай будущих изменений API.
    const hashedToken = linkRes?.hashed_token ?? linkRes?.properties?.hashed_token;
    if (!hashedToken) {
      console.error('[dev-auth] generate_link ok but no hashed_token, body was:', JSON.stringify(linkRes));
      return null;
    }

    const sessFetch = await fetch(`${API_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
      body: JSON.stringify({ token_hash: hashedToken, type: 'magiclink' }),
    });
    const sessRes = await sessFetch.json().catch(() => null);
    if (!sessFetch.ok) console.error('[dev-auth] verify failed:', sessFetch.status, sessRes);

    if (!sessRes?.access_token) {
      console.error('[dev-auth] verify ok but no access_token, body was:', JSON.stringify(sessRes));
      return null;
    }

    return {
      access_token:  sessRes.access_token,
      refresh_token: sessRes.refresh_token,
      user_id: userId,
    };
  }

  return {
    name: 'local-auth-handler',
    configureServer(server) {
      server.middlewares.use(
        '/api/auth/telegram',
        async (req: IncomingMessage, res: ServerResponse) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'application/json');

          if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
          if (req.method !== 'POST')    { res.statusCode = 405; res.end('{"error":"Method not allowed"}'); return; }

          let body = '';
          for await (const chunk of req) body += chunk;
          const payload = JSON.parse(body || '{}');

          let telegramUser: Record<string, any> | null = null;

          // Support both Telegram Login Widget and Mini App (initData)
          if (payload.telegram_data) {
            const isValid = BOT_TOKEN
              ? await verifyTelegramWidget(payload.telegram_data)
              : true; // skip verify in dev if no token
            if (!isValid) { res.statusCode = 401; res.end('{"error":"Invalid signature"}'); return; }
            telegramUser = payload.telegram_data;
          } else if (payload.init_data) {
            const user = BOT_TOKEN
              ? verifyTelegramMiniApp(payload.init_data)
              : JSON.parse(new URLSearchParams(payload.init_data).get('user') || 'null');
            if (!user) { res.statusCode = 401; res.end('{"error":"Invalid initData"}'); return; }
            telegramUser = user;
          } else {
            res.statusCode = 400; res.end('{"error":"Missing telegram_data or init_data"}'); return;
          }

          const session = await findOrCreateSupabaseUser({
            id: parseInt(telegramUser.id, 10),
            first_name: telegramUser.first_name,
            last_name: telegramUser.last_name,
            username: telegramUser.username,
            photo_url: telegramUser.photo_url,
          });

          if (!session) { res.statusCode = 500; res.end('{"error":"Session creation failed"}'); return; }

          res.end(JSON.stringify({
            ...session,
            first_name: telegramUser.first_name || '',
            username: telegramUser.username || null,
            photo_url: telegramUser.photo_url || null,
          }));
        }
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    resolve: {
      alias: { '@': resolve(__dirname, 'src') },
    },
    plugins: [
      localAuthPlugin(env),
    ],
    server: {
      port: 3000,
      open: true,
      proxy: {
        '/ozon-api': {
          target: 'https://api-seller.ozon.ru',
          changeOrigin: true, secure: true,
          rewrite: (path) => path.replace(/^\/ozon-api/, ''),
          headers: { 'User-Agent': 'okhttp/4.9.2', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        },
        '/yandex-api': {
          target: 'https://api.partner.market.yandex.ru',
          changeOrigin: true, secure: true,
          rewrite: (path) => path.replace(/^\/yandex-api/, ''),
          configure: (proxy: any) => {
            proxy.on('proxyReq', (proxyReq: any) => {
              proxyReq.removeHeader('origin'); proxyReq.removeHeader('referer');
              proxyReq.setHeader('User-Agent', 'SimaDesk/1.0');
            });
          },
          headers: { 'Accept': 'application/json' },
        },
        '/wb-content':     { target: 'https://content-api.wildberries.ru',    changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-content/, ''),     configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-marketplace': { target: 'https://marketplace-api.wildberries.ru', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-marketplace/, ''), configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-stats':       { target: 'https://statistics-api.wildberries.ru', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-stats/, ''),       configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-common':      { target: 'https://common-api.wildberries.ru',     changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-common/, ''),      configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-adv':         { target: 'https://advert-api.wildberries.ru',   changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-adv/, ''),        configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-search':      { target: 'https://search.wb.ru',                  changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-search/, ''),       configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-prices':      { target: 'https://discounts-prices-api.wildberries.ru', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-prices/, ''), configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-feedback':    { target: 'https://feedbacks-api.wildberries.ru',       changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-feedback/, ''),    configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-buyer-chat':  { target: 'https://buyer-chat-api.wildberries.ru',      changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-buyer-chat/, ''),  configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
        '/wb-card':        { target: 'https://card.wb.ru',                         changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/wb-card/, ''),        configure: (proxy: any) => { proxy.on('proxyReq', (r: any) => { r.removeHeader('origin'); r.removeHeader('referer'); }); } },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        input: {
          main:       resolve(__dirname, 'index.html'),
          storefront: resolve(__dirname, 'storefront.html'),
          info:       resolve(__dirname, 'info.html'),
          legal:      resolve(__dirname, 'legal.html'),
          privacy:    resolve(__dirname, 'privacy.html'),
          offer:      resolve(__dirname, 'offer.html'),
        },
        output: { manualChunks: { xlsx: ['xlsx'] } },
      },
    },
    publicDir: 'public',
    define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version) },
    test: {
      environment: 'jsdom', globals: true,
      setupFiles: ['src/tests/setup.ts'],
      include: ['src/tests/**/*.test.ts'],
      coverage: { reporter: ['text', 'html'], include: ['src/**/*.ts'], exclude: ['src/tests/**', 'src/types/**', 'src/styles/**'] },
    },
  };
});
