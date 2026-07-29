-- ── Platform admins ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'admin', -- 'superadmin'|'admin'|'support'|'billing'
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin reads own row" ON platform_admins FOR SELECT USING (auth.uid() = user_id);

-- ── RPC: check if current user is admin ───────────────────────────────────────
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row platform_admins;
BEGIN
  SELECT * INTO v_row FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RETURN json_build_object('is_admin', false); END IF;
  RETURN json_build_object('is_admin', true, 'role', v_row.role);
END;
$$;

-- ── RPC: get all users (admin only) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_users(p_search TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_result JSON;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT json_build_object(
    'total', (
      SELECT COUNT(*) FROM users
      WHERE p_search = '' OR
        LOWER(first_name || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(telegram_username,'')) LIKE LOWER('%' || p_search || '%')
    ),
    'users', (
      SELECT json_agg(row_to_json(u)) FROM (
        SELECT
          u.id, u.first_name, u.last_name, u.telegram_username, u.photo_url,
          u.created_at, u.last_login_at, u.banned_until,
          ut.ends_at AS trial_ends_at,
          (SELECT json_agg(json_build_object('company_id', cm.company_id, 'role', cm.role, 'name', c.name))
           FROM company_members cm JOIN companies c ON c.id = cm.company_id
           WHERE cm.user_id = u.id LIMIT 5) AS companies,
          (SELECT json_build_object('plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status)
           FROM user_subscriptions us WHERE us.user_id = u.id AND us.status = 'active' LIMIT 1) AS subscription,
          (SELECT COUNT(*) FROM company_members cm2 WHERE cm2.user_id = u.id) AS company_count
        FROM users u
        LEFT JOIN user_trials ut ON ut.user_id = u.id
        WHERE p_search = '' OR
          LOWER(u.first_name || ' ' || COALESCE(u.last_name,'') || ' ' || COALESCE(u.telegram_username,'')) LIKE LOWER('%' || p_search || '%')
        ORDER BY u.created_at DESC
        LIMIT p_limit OFFSET p_offset
      ) u
    )
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ── RPC: get all companies (admin only) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_companies(p_search TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN (
    SELECT json_build_object(
      'total', (SELECT COUNT(*) FROM companies WHERE p_search = '' OR LOWER(name) LIKE LOWER('%' || p_search || '%')),
      'companies', (
        SELECT json_agg(row_to_json(c)) FROM (
          SELECT
            co.id, co.name, co.legal_name, co.type, co.inn, co.color, co.logo_url, co.created_at,
            owner_u.first_name AS owner_first_name,
            owner_u.last_name  AS owner_last_name,
            owner_u.telegram_username AS owner_username,
            (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = co.id) AS member_count,
            (SELECT json_build_object('plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status, 'monthly_revenue', us.monthly_revenue)
             FROM user_subscriptions us WHERE us.company_id = co.id LIMIT 1) AS subscription
          FROM companies co
          LEFT JOIN users owner_u ON owner_u.id = co.created_by
          WHERE p_search = '' OR LOWER(co.name) LIKE LOWER('%' || p_search || '%')
          ORDER BY co.created_at DESC
          LIMIT p_limit OFFSET p_offset
        ) c
      )
    )
  );
END;
$$;

-- ── RPC: get platform stats (admin only) ──────────────────────────────────────
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
    'banned_users',    (SELECT COUNT(*) FROM users WHERE banned_until > now())
  );
END;
$$;

-- ── RPC: ban / unban user (admin only) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_ban_user(p_target_user_id UUID, p_until TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  UPDATE users SET banned_until = p_until WHERE id = p_target_user_id;
END;
$$;

-- ── RPC: manually set subscription ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_set_subscription(
  p_user_id UUID, p_company_id UUID,
  p_plan_key TEXT, p_price_rub INT, p_months INT DEFAULT 1
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  INSERT INTO user_subscriptions (user_id, company_id, plan_key, price_rub, status, current_period_start, current_period_end)
  VALUES (p_user_id, p_company_id, p_plan_key, p_price_rub, 'active', now(), now() + (p_months || ' months')::interval)
  ON CONFLICT (company_id) DO UPDATE SET
    plan_key = EXCLUDED.plan_key,
    price_rub = EXCLUDED.price_rub,
    status = 'active',
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    updated_at = now();
END;
$$;

-- ── RPC: create promo code (admin only) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_create_promo(
  p_code TEXT, p_discount_rub INT DEFAULT 0,
  p_discount_percent INT DEFAULT 0,
  p_description TEXT DEFAULT '',
  p_valid_until TIMESTAMPTZ DEFAULT NULL,
  p_max_uses INT DEFAULT NULL
)
RETURNS promo_codes LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_promo promo_codes;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  INSERT INTO promo_codes (code, discount_rub, discount_percent, description, valid_until, max_uses)
  VALUES (UPPER(p_code), p_discount_rub, p_discount_percent, p_description, p_valid_until, p_max_uses)
  RETURNING * INTO v_promo;
  RETURN v_promo;
END;
$$;

-- ── RPC: get all promo codes (admin only) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_promos()
RETURNS SETOF promo_codes LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  RETURN QUERY SELECT * FROM promo_codes ORDER BY created_at DESC;
END;
$$;

-- ── RPC: toggle promo active state ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_toggle_promo(p_promo_id UUID, p_active BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  UPDATE promo_codes SET is_active = p_active WHERE id = p_promo_id;
END;
$$;

-- ── RPC: extend user trial ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_extend_trial(p_target_user_id UUID, p_days INT DEFAULT 14)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  INSERT INTO user_trials (user_id, ends_at)
  VALUES (p_target_user_id, now() + (p_days || ' days')::interval)
  ON CONFLICT (user_id) DO UPDATE SET ends_at = now() + (p_days || ' days')::interval;
END;
$$;
