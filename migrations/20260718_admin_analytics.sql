-- ── Grant admin role RPC (superadmin only) ───────────────────────────────────
CREATE OR REPLACE FUNCTION admin_grant_role(p_target_user_id UUID, p_role TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  IF v_admin.role != 'superadmin' THEN RAISE EXCEPTION 'Only superadmin can grant roles'; END IF;
  INSERT INTO platform_admins (user_id, role, created_by)
  VALUES (p_target_user_id, p_role, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET role = p_role;
END;
$$;

-- ── Revoke admin role (superadmin only) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_revoke_role(p_target_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND OR v_admin.role != 'superadmin' THEN RAISE EXCEPTION 'Only superadmin can revoke roles'; END IF;
  DELETE FROM platform_admins WHERE user_id = p_target_user_id AND user_id != auth.uid();
END;
$$;

-- ── Admin analytics time-series ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_analytics()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN json_build_object(
    -- Users registered per day (last 30 days)
    'users_by_day', (
      SELECT COALESCE(json_agg(json_build_object('date', d::text, 'count', c) ORDER BY d), '[]')
      FROM (
        SELECT DATE(created_at) AS d, COUNT(*) AS c
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(created_at)
      ) t
    ),
    -- Companies created per day (last 30 days)
    'companies_by_day', (
      SELECT COALESCE(json_agg(json_build_object('date', d::text, 'count', c) ORDER BY d), '[]')
      FROM (
        SELECT DATE(created_at) AS d, COUNT(*) AS c
        FROM companies
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(created_at)
      ) t
    ),
    -- Top 10 companies by revenue (from analytics cache)
    'revenue_by_company', (
      SELECT COALESCE(json_agg(json_build_object('name', name, 'revenue', revenue) ORDER BY revenue DESC), '[]')
      FROM (
        SELECT c.name, get_company_monthly_revenue(c.id) AS revenue
        FROM companies c
        ORDER BY revenue DESC LIMIT 10
      ) t WHERE revenue > 0
    ),
    -- Plan distribution
    'plans_dist', (
      SELECT COALESCE(json_agg(json_build_object('plan', plan_key, 'count', c)), '[]')
      FROM (
        SELECT plan_key, COUNT(*) AS c
        FROM user_subscriptions WHERE status = 'active'
        GROUP BY plan_key ORDER BY c DESC
      ) t
    ),
    -- Admin list
    'admins', (
      SELECT COALESCE(json_agg(json_build_object(
        'user_id', pa.user_id, 'role', pa.role, 'created_at', pa.created_at,
        'first_name', u.first_name, 'last_name', u.last_name, 'telegram_username', u.telegram_username
      )), '[]')
      FROM platform_admins pa
      JOIN users u ON u.id = pa.user_id
      ORDER BY pa.created_at
    ),
    -- Total cumulative users (for summary)
    'total_users', (SELECT COUNT(*) FROM users),
    'total_companies', (SELECT COUNT(*) FROM companies),
    'total_revenue', (
      SELECT COALESCE(SUM(get_company_monthly_revenue(id)), 0) FROM companies
    )
  );
END;
$$;
