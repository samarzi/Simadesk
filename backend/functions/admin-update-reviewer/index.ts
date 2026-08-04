/**
 * Edge Function: admin-update-reviewer
 *
 * Управление email/password-аккаунтами (проверяющие / разработчики).
 * Доступно только платформенным администраторам.
 *
 * GET  /admin-update-reviewer          — список email-аккаунтов
 * POST /admin-update-reviewer          — изменить email и/или пароль
 *   Body: { user_id: string, email?: string, password?: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function checkAdmin(authHeader: string, supabaseUrl: string, serviceRoleKey: string) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: { user }, error } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  );
  if (error || !user) return null;
  const { data } = await supabase
    .from('platform_admins')
    .select('role')
    .eq('user_id', user.id)
    .single();
  return data ? user : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('authorization') ?? '';

  const caller = await checkAdmin(authHeader, supabaseUrl, serviceRoleKey);
  if (!caller) return json({ error: 'Unauthorized' }, 401);

  // GET — список email/password аккаунтов
  if (req.method === 'GET') {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=100`, {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
    });
    if (!res.ok) return json({ error: 'Не удалось загрузить пользователей' }, 500);
    const data = await res.json();
    // Только аккаунты с email, без telegram_id/yandex_id в метаданных
    const users: Array<{ id: string; email: string; created_at: string }> =
      (data.users ?? [])
        .filter((u: any) => u.email && !u.email.match(/^(tg|ya)\d+@/))
        .map((u: any) => ({ id: u.id, email: u.email, created_at: u.created_at }));
    return json({ users });
  }

  // POST — изменить email/пароль
  if (req.method === 'POST') {
    let body: { user_id: string; email?: string; password?: string };
    try { body = await req.json(); } catch {
      return json({ error: 'Неверный формат запроса' }, 400);
    }
    const { user_id, email, password } = body;
    if (!user_id) return json({ error: 'user_id обязателен' }, 400);
    if (!email && !password) return json({ error: 'Укажите email и/или password' }, 400);

    const patch: Record<string, string> = {};
    if (email) patch.email = email;
    if (password) patch.password = password;

    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return json({ error: err.message ?? 'Ошибка обновления' }, res.status);
    }
    const updated = await res.json();
    return json({ ok: true, email: updated.email });
  }

  return json({ error: 'Method not allowed' }, 405);
});
