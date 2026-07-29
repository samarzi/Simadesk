-- ── Fix 1: Add banned_until to public.users ──────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ DEFAULT NULL;

-- ── Fix 2: get_company_monthly_revenue — use analytics_orders_cache ──────────
CREATE OR REPLACE FUNCTION get_company_monthly_revenue(p_company_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ozon   BIGINT := 0;
  v_wb     BIGINT := 0;
  v_yandex BIGINT := 0;
BEGIN
  -- Ozon revenue: price * quantity from cache chunks covering last 30 days
  SELECT COALESCE(SUM((prod->>'price')::NUMERIC * COALESCE((prod->>'quantity')::INT, 1)), 0)
  INTO v_ozon
  FROM analytics_orders_cache aoc
  JOIN ozon_stores os ON os.id::text = aoc.store_id,
    jsonb_array_elements(aoc.data) AS ord,
    jsonb_array_elements(ord->'products') AS prod
  WHERE os.company_id = p_company_id
    AND aoc.mp = 'ozon'
    AND aoc.chunk_to >= CURRENT_DATE - INTERVAL '30 days';

  -- WB revenue
  SELECT COALESCE(SUM((prod->>'price')::NUMERIC * COALESCE((prod->>'quantity')::INT, 1)), 0)
  INTO v_wb
  FROM analytics_orders_cache aoc
  JOIN wb_stores ws ON ws.id::text = aoc.store_id,
    jsonb_array_elements(aoc.data) AS ord,
    jsonb_array_elements(ord->'products') AS prod
  WHERE ws.company_id = p_company_id
    AND aoc.mp = 'wb'
    AND aoc.chunk_to >= CURRENT_DATE - INTERVAL '30 days';

  -- Yandex revenue
  SELECT COALESCE(SUM((prod->>'price')::NUMERIC * COALESCE((prod->>'quantity')::INT, 1)), 0)
  INTO v_yandex
  FROM analytics_orders_cache aoc
  JOIN yandex_stores ys ON ys.id::text = aoc.store_id,
    jsonb_array_elements(aoc.data) AS ord,
    jsonb_array_elements(ord->'products') AS prod
  WHERE ys.company_id = p_company_id
    AND aoc.mp = 'yandex'
    AND aoc.chunk_to >= CURRENT_DATE - INTERVAL '30 days';

  RETURN v_ozon + v_wb + v_yandex;
END;
$$;

-- ── Fix 3: Rebuild admin RPCs to use fixed users table ────────────────────────
CREATE OR REPLACE FUNCTION admin_get_users(p_search TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN (SELECT json_build_object(
    'total', (
      SELECT COUNT(*) FROM users
      WHERE p_search = '' OR
        LOWER(first_name || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(telegram_username,''))
        LIKE LOWER('%' || p_search || '%')
    ),
    'users', (
      SELECT COALESCE(json_agg(row_to_json(u)), '[]'::json) FROM (
        SELECT
          u.id, u.first_name, u.last_name, u.telegram_username, u.photo_url,
          u.created_at, u.last_login_at, u.banned_until,
          ut.ends_at AS trial_ends_at,
          (SELECT json_agg(json_build_object(
             'company_id', cm.company_id, 'role', cm.role, 'name', c.name))
           FROM company_members cm JOIN companies c ON c.id = cm.company_id
           WHERE cm.user_id = u.id LIMIT 5) AS companies,
          (SELECT json_build_object(
             'plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status)
           FROM user_subscriptions us
           WHERE us.user_id = u.id AND us.status = 'active' LIMIT 1) AS subscription,
          (SELECT COUNT(*) FROM company_members cm2 WHERE cm2.user_id = u.id) AS company_count
        FROM users u
        LEFT JOIN user_trials ut ON ut.user_id = u.id
        WHERE p_search = '' OR
          LOWER(u.first_name || ' ' || COALESCE(u.last_name,'') || ' ' ||
                COALESCE(u.telegram_username,''))
          LIKE LOWER('%' || p_search || '%')
        ORDER BY u.created_at DESC
        LIMIT p_limit OFFSET p_offset
      ) u
    )
  ));
END;
$$;

CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN json_build_object(
    'total_users',     (SELECT COUNT(*) FROM users),
    'new_users_7d',    (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '7 days'),
    'new_users_30d',   (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '30 days'),
    'total_companies', (SELECT COUNT(*) FROM companies),
    'active_subs',     (SELECT COUNT(*) FROM user_subscriptions WHERE status = 'active'),
    'trial_users',     (SELECT COUNT(*) FROM user_trials WHERE ends_at > now()),
    'mrr',             (SELECT COALESCE(SUM(price_rub), 0) FROM user_subscriptions WHERE status = 'active'),
    'banned_users',    (SELECT COUNT(*) FROM users WHERE banned_until IS NOT NULL AND banned_until > now())
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_ban_user(p_target_user_id UUID, p_until TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  UPDATE users SET banned_until = p_until WHERE id = p_target_user_id;
END;
$$;

-- ── Fix 4: Support ticket system ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  subject     TEXT NOT NULL DEFAULT 'Обращение в поддержку',
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'answered' | 'closed'
  admin_reply TEXT,
  replied_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own tickets" ON support_tickets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users create tickets"  ON support_tickets FOR INSERT WITH CHECK (auth.uid() = user_id);

-- RPC: user creates a ticket
CREATE OR REPLACE FUNCTION create_support_ticket(
  p_message TEXT,
  p_subject TEXT DEFAULT 'Обращение в поддержку',
  p_company_id UUID DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO support_tickets (user_id, company_id, subject, message)
  VALUES (auth.uid(), p_company_id, p_subject, p_message)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- RPC: admin reads all tickets
CREATE OR REPLACE FUNCTION admin_get_tickets(p_status TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN (SELECT json_build_object(
    'total', (SELECT COUNT(*) FROM support_tickets WHERE p_status = '' OR status = p_status),
    'tickets', (
      SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
        SELECT
          st.id, st.subject, st.message, st.status, st.admin_reply,
          st.created_at, st.replied_at,
          u.first_name, u.last_name, u.telegram_username, u.photo_url,
          c.name AS company_name
        FROM support_tickets st
        JOIN users u ON u.id = st.user_id
        LEFT JOIN companies c ON c.id = st.company_id
        WHERE p_status = '' OR st.status = p_status
        ORDER BY st.created_at DESC
        LIMIT p_limit OFFSET p_offset
      ) t
    )
  ));
END;
$$;

-- RPC: admin replies to ticket
CREATE OR REPLACE FUNCTION admin_reply_ticket(
  p_ticket_id UUID,
  p_reply TEXT,
  p_status TEXT DEFAULT 'answered'
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  UPDATE support_tickets
  SET admin_reply = p_reply, status = p_status, replied_at = now(), updated_at = now()
  WHERE id = p_ticket_id;
END;
$$;

-- RPC: user reads own tickets
CREATE OR REPLACE FUNCTION get_my_tickets()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::json)
    FROM (
      SELECT id, subject, message, status, admin_reply, created_at, replied_at
      FROM support_tickets WHERE user_id = auth.uid()
    ) t
  );
END;
$$;

-- Update stats to include tickets count
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN json_build_object(
    'total_users',     (SELECT COUNT(*) FROM users),
    'new_users_7d',    (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '7 days'),
    'new_users_30d',   (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '30 days'),
    'total_companies', (SELECT COUNT(*) FROM companies),
    'active_subs',     (SELECT COUNT(*) FROM user_subscriptions WHERE status = 'active'),
    'trial_users',     (SELECT COUNT(*) FROM user_trials WHERE ends_at > now()),
    'mrr',             (SELECT COALESCE(SUM(price_rub), 0) FROM user_subscriptions WHERE status = 'active'),
    'banned_users',    (SELECT COUNT(*) FROM users WHERE banned_until IS NOT NULL AND banned_until > now()),
    'open_tickets',    (SELECT COUNT(*) FROM support_tickets WHERE status = 'open')
  );
END;
$$;
