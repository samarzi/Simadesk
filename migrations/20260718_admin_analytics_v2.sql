-- ── Optimized admin_get_analytics (single-pass revenue query) ────────────────
-- Previous version called get_company_monthly_revenue() per company → N×3 queries → timeout
-- New version: one CTE over analytics_orders_cache grouped by company

CREATE OR REPLACE FUNCTION admin_get_analytics()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN json_build_object(

    -- Users registered per day (last 30 days)
    'users_by_day', (
      SELECT COALESCE(json_agg(json_build_object('date', d::text, 'count', c) ORDER BY d), '[]'::json)
      FROM (
        SELECT DATE(created_at) AS d, COUNT(*) AS c
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(created_at)
      ) t
    ),

    -- Companies created per day (last 30 days)
    'companies_by_day', (
      SELECT COALESCE(json_agg(json_build_object('date', d::text, 'count', c) ORDER BY d), '[]'::json)
      FROM (
        SELECT DATE(created_at) AS d, COUNT(*) AS c
        FROM companies
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(created_at)
      ) t
    ),

    -- Top 10 companies by revenue — single scan over analytics_orders_cache
    'revenue_by_company', (
      WITH all_stores AS (
        SELECT id::text AS store_id, company_id FROM ozon_stores
        UNION ALL
        SELECT id::text AS store_id, company_id FROM wb_stores
        UNION ALL
        SELECT id::text AS store_id, company_id FROM yandex_stores
      ),
      rev AS (
        SELECT
          s.company_id,
          COALESCE(SUM(
            (prod->>'price')::NUMERIC * COALESCE((prod->>'quantity')::INT, 1)
          ), 0)::BIGINT AS revenue
        FROM analytics_orders_cache aoc
        JOIN all_stores s ON s.store_id = aoc.store_id
        CROSS JOIN LATERAL jsonb_array_elements(aoc.data) AS ord
        CROSS JOIN LATERAL jsonb_array_elements(ord->'products') AS prod
        WHERE aoc.chunk_to >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY s.company_id
      )
      SELECT COALESCE(
        json_agg(json_build_object('name', c.name, 'revenue', r.revenue) ORDER BY r.revenue DESC),
        '[]'::json
      )
      FROM rev r
      JOIN companies c ON c.id = r.company_id
      WHERE r.revenue > 0
      LIMIT 10
    ),

    -- Plan distribution
    'plans_dist', (
      SELECT COALESCE(json_agg(json_build_object('plan', plan_key, 'count', c)), '[]'::json)
      FROM (
        SELECT plan_key, COUNT(*) AS c
        FROM user_subscriptions
        WHERE status = 'active'
        GROUP BY plan_key
        ORDER BY c DESC
      ) t
    ),

    -- Admin list
    'admins', (
      SELECT COALESCE(json_agg(json_build_object(
        'user_id',          pa.user_id,
        'role',             pa.role,
        'created_at',       pa.created_at,
        'first_name',       u.first_name,
        'last_name',        u.last_name,
        'telegram_username',u.telegram_username
      ) ORDER BY pa.created_at), '[]'::json)
      FROM platform_admins pa
      JOIN users u ON u.id = pa.user_id
    ),

    'total_users',     (SELECT COUNT(*)::INT FROM users),
    'total_companies', (SELECT COUNT(*)::INT FROM companies),

    -- Total revenue — same single scan, no per-company calls
    'total_revenue', (
      WITH all_stores AS (
        SELECT id::text AS store_id, company_id FROM ozon_stores
        UNION ALL
        SELECT id::text AS store_id, company_id FROM wb_stores
        UNION ALL
        SELECT id::text AS store_id, company_id FROM yandex_stores
      )
      SELECT COALESCE(SUM(
        (prod->>'price')::NUMERIC * COALESCE((prod->>'quantity')::INT, 1)
      ), 0)::BIGINT
      FROM analytics_orders_cache aoc
      JOIN all_stores s ON s.store_id = aoc.store_id
      CROSS JOIN LATERAL jsonb_array_elements(aoc.data) AS ord
      CROSS JOIN LATERAL jsonb_array_elements(ord->'products') AS prod
      WHERE aoc.chunk_to >= CURRENT_DATE - INTERVAL '30 days'
    )

  );
END;
$$;
