-- ── Plan configs (editable prices) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_configs (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  price_rub   INT  NOT NULL DEFAULT 0,
  revenue_min BIGINT NOT NULL DEFAULT 0,
  revenue_max BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plan_configs (key, label, price_rub, revenue_min, revenue_max) VALUES
  ('free',     'Бесплатно', 0,    0,           100000),
  ('starter',  'Старт',     990,  100000,      500000),
  ('business', 'Бизнес',    2490, 500000,      2000000),
  ('pro',      'Про',       4990, 2000000,     10000000),
  ('max',      'Макс',      9990, 10000000,    NULL)
ON CONFLICT (key) DO NOTHING;

-- RPC: get plan configs (public)
CREATE OR REPLACE FUNCTION get_plan_configs()
RETURNS SETOF plan_configs LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM plan_configs ORDER BY revenue_min ASC;
$$;

-- RPC: update plan price (admin only)
CREATE OR REPLACE FUNCTION admin_update_plan(
  p_key TEXT, p_price_rub INT,
  p_revenue_min BIGINT DEFAULT NULL, p_revenue_max BIGINT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  UPDATE plan_configs
  SET price_rub   = p_price_rub,
      revenue_min = COALESCE(p_revenue_min, revenue_min),
      revenue_max = p_revenue_max,  -- allow setting null (no upper bound)
      updated_at  = now()
  WHERE key = p_key;
END;
$$;

-- ── Admin: delete company ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_delete_company(p_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND OR v_admin.role NOT IN ('superadmin','admin') THEN RAISE EXCEPTION 'Access denied'; END IF;
  -- Cascade: members, subscriptions, invitations are FK ON DELETE CASCADE or set null
  DELETE FROM company_members      WHERE company_id = p_company_id;
  DELETE FROM company_invitations  WHERE company_id = p_company_id;
  DELETE FROM company_invite_links WHERE company_id = p_company_id;
  DELETE FROM user_subscriptions   WHERE company_id = p_company_id;
  DELETE FROM support_tickets      WHERE company_id = p_company_id;
  DELETE FROM companies            WHERE id = p_company_id;
END;
$$;

-- ── Admin: search users (for picker autocomplete) ─────────────────────────────
CREATE OR REPLACE FUNCTION admin_search_users(p_q TEXT DEFAULT '', p_limit INT DEFAULT 20)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(u)), '[]'::json) FROM (
      SELECT u.id, u.first_name, u.last_name, u.telegram_username, u.photo_url,
        (SELECT COUNT(*) FROM company_members cm WHERE cm.user_id = u.id) AS company_count
      FROM users u
      WHERE p_q = '' OR
        LOWER(u.first_name || ' ' || COALESCE(u.last_name,'') || ' ' || COALESCE(u.telegram_username,''))
        LIKE LOWER('%' || p_q || '%')
      ORDER BY u.first_name
      LIMIT p_limit
    ) u
  );
END;
$$;

-- ── Admin: search companies (for picker autocomplete) ────────────────────────
CREATE OR REPLACE FUNCTION admin_search_companies(p_q TEXT DEFAULT '', p_limit INT DEFAULT 20)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
      SELECT co.id, co.name, co.logo_url, co.color,
        u.first_name AS owner_first_name, u.last_name AS owner_last_name,
        (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = co.id) AS member_count
      FROM companies co
      LEFT JOIN users u ON u.id = co.created_by
      WHERE p_q = '' OR LOWER(co.name) LIKE LOWER('%' || p_q || '%')
      ORDER BY co.name
      LIMIT p_limit
    ) c
  );
END;
$$;

-- ── Rebuild admin_get_companies to include revenue from analytics ─────────────
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
        SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
          SELECT
            co.id, co.name, co.legal_name, co.type, co.inn, co.color, co.logo_url, co.created_at,
            owner_u.first_name AS owner_first_name,
            owner_u.last_name  AS owner_last_name,
            owner_u.telegram_username AS owner_username,
            owner_u.id AS owner_id,
            (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = co.id) AS member_count,
            get_company_monthly_revenue(co.id) AS monthly_revenue,
            (SELECT json_build_object('plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status)
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
