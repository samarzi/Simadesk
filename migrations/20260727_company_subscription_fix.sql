-- ── Fix subscription model: per-company access control ──────────────────────

-- 1. Update RLS: allow any company member to see their company's subscription
--    (only owner can edit, but members need to see status for UI purposes)
DROP POLICY IF EXISTS "user sees own subs" ON user_subscriptions;
DROP POLICY IF EXISTS "company members see subs" ON user_subscriptions;
CREATE POLICY "company members see subs" ON user_subscriptions
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM company_members cm
      WHERE cm.company_id = user_subscriptions.company_id
        AND cm.user_id = auth.uid()
    )
  );

-- Keep write policies owner-only
DROP POLICY IF EXISTS "user updates own subs" ON user_subscriptions;
DROP POLICY IF EXISTS "user inserts own subs" ON user_subscriptions;
CREATE POLICY "owner updates own subs" ON user_subscriptions
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner inserts own subs" ON user_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 2. Update get_storefront: require active subscription OR owner in trial
CREATE OR REPLACE FUNCTION get_storefront(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_company_id uuid;
  v_settings   jsonb;
  v_products   jsonb;
  v_banners    jsonb;
  v_groups     jsonb;
  v_variants   jsonb;
  v_owner_id   uuid;
  v_has_access boolean;
BEGIN
  SELECT ss.company_id,
         jsonb_build_object(
           'store_name',           ss.store_name,
           'tagline',              ss.tagline,
           'telegram',             ss.telegram,
           'whatsapp',             ss.whatsapp,
           'phone',                ss.phone,
           'website',              ss.website,
           'slug',                 ss.slug,
           'logo_url',             c.logo_url,
           'show_price_filter',    COALESCE(ss.show_price_filter, true),
           'show_brand_filter',    COALESCE(ss.show_brand_filter, false),
           'show_category_filter', COALESCE(ss.show_category_filter, false),
           'show_stock',           COALESCE(ss.show_stock, false),
           'hide_out_of_stock',    COALESCE(ss.hide_out_of_stock, false)
         )
  INTO v_company_id, v_settings
  FROM storefront_settings ss
  LEFT JOIN companies c ON c.id = ss.company_id
  WHERE ss.slug = p_slug AND ss.is_enabled = true;

  IF v_company_id IS NULL THEN RETURN NULL; END IF;

  -- ── Access check: active subscription OR owner trial ──────────────────────
  SELECT created_by INTO v_owner_id FROM companies WHERE id = v_company_id;

  SELECT (
    EXISTS(
      SELECT 1 FROM user_subscriptions
      WHERE company_id = v_company_id
        AND status = 'active'
        AND (current_period_end IS NULL OR current_period_end > now())
    )
    OR EXISTS(
      SELECT 1 FROM user_trials
      WHERE user_id = v_owner_id AND ends_at > now()
    )
  ) INTO v_has_access;

  IF NOT v_has_access THEN RETURN NULL; END IF;
  -- ─────────────────────────────────────────────────────────────────────────

  -- ── Banners ──────────────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',         id,
      'title',      COALESCE(title, ''),
      'image_url',  image_url,
      'link_url',   link_url,
      'sort_order', sort_order
    ) ORDER BY sort_order, created_at
  ), '[]'::jsonb)
  INTO v_banners
  FROM storefront_banners
  WHERE company_id = v_company_id AND is_active = true;

  -- ── Groups ───────────────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           g.id,
      'name',         g.name,
      'cover_url',    COALESCE(g.cover_url, ''),
      'sort_order',   g.sort_order,
      'vendor_codes', COALESCE((
        SELECT jsonb_agg(gi.vendor_code)
        FROM storefront_group_items gi
        WHERE gi.group_id = g.id
      ), '[]'::jsonb)
    ) ORDER BY g.sort_order, g.created_at
  ), '[]'::jsonb)
  INTO v_groups
  FROM storefront_groups g
  WHERE g.company_id = v_company_id;

  -- ── Variants ─────────────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',vg.id,'sort_order',vg.sort_order,'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('vendor_code',vi.vendor_code,'label',vi.label,'color',vi.color,'sort_order',vi.sort_order) ORDER BY vi.sort_order) FROM storefront_variant_items vi WHERE vi.variant_group_id=vg.id),'[]'::jsonb)) ORDER BY vg.sort_order),'[]'::jsonb)
  INTO v_variants FROM storefront_variant_groups vg WHERE vg.company_id = v_company_id;

  -- ── Products ─────────────────────────────────────────────────────────────
  WITH wb_visible AS (
    SELECT
      'wb'::text                                                                AS source,
      p.nm_id::text                                                             AS source_id,
      NULL::text                                                                AS market_model_id,
      p.title,
      p.pictures                                                                AS images,
      ROUND(p.price * (1 - COALESCE(p.discount,0)::numeric / 100))::numeric   AS price,
      p.price                                                                   AS original_price,
      COALESCE(p.discount, 0)                                                   AS discount,
      lower(trim(COALESCE(p.vendor_code, '')))                                  AS vendor_code,
      COALESCE(p.brand, '')                                                     AS brand,
      COALESCE(p.subject, '')                                                   AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.custom_title, '')                                             AS custom_title,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      ''::text                                                                  AS ozon_sku,
      COALESCE(p.stock_total, 0)::int                                           AS stock,
      p.weight_kg,
      p.length_cm,
      p.width_cm,
      p.height_cm
    FROM wb_stores s
    JOIN wb_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'wb' AND ov.source_id = p.nm_id::text
    WHERE s.company_id = v_company_id
      AND NOT COALESCE(ov.is_hidden, false)
      AND p.title IS NOT NULL AND p.title != ''
  ),
  wb AS (
    SELECT DISTINCT ON (CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END)
      source, source_id, market_model_id, title, images, price, original_price,
      discount, vendor_code, brand, category, custom_url, custom_price, custom_title,
      sort_order, is_hidden, ozon_sku, stock, weight_kg, length_cm, width_cm, height_cm
    FROM wb_visible
    ORDER BY
      CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END,
      price ASC,
      COALESCE(array_length(images, 1), 0) DESC NULLS LAST
  ),

  oz_visible AS (
    SELECT
      'ozon'::text                                                              AS source,
      p.product_id::text                                                        AS source_id,
      NULL::text                                                                AS market_model_id,
      p.name                                                                    AS title,
      p.images,
      p.price::numeric                                                          AS price,
      COALESCE(NULLIF(p.old_price, 0), p.price)::numeric                       AS original_price,
      CASE WHEN p.old_price > p.price
           THEN ROUND((1 - p.price::numeric / NULLIF(p.old_price,0)) * 100)
           ELSE 0 END                                                           AS discount,
      lower(trim(COALESCE(p.offer_id, '')))                                     AS vendor_code,
      ''                                                                        AS brand,
      COALESCE(p.category, '')                                                  AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.custom_title, '')                                             AS custom_title,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      COALESCE(p.sku::text, '')                                                 AS ozon_sku,
      (COALESCE(p.stock_fbs,0)+COALESCE(p.stock_fbo,0))::int                   AS stock,
      p.weight_kg,
      p.length_cm,
      p.width_cm,
      p.height_cm
    FROM ozon_stores s
    JOIN ozon_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'ozon' AND ov.source_id = p.product_id::text
    WHERE s.company_id = v_company_id
      AND NOT COALESCE(ov.is_hidden, false)
      AND p.name IS NOT NULL AND p.name != ''
  ),
  oz AS (
    SELECT DISTINCT ON (CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END)
      source, source_id, market_model_id, title, images, price, original_price,
      discount, vendor_code, brand, category, custom_url, custom_price, custom_title,
      sort_order, is_hidden, ozon_sku, stock, weight_kg, length_cm, width_cm, height_cm
    FROM oz_visible
    ORDER BY
      CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END,
      price ASC,
      COALESCE(array_length(images, 1), 0) DESC NULLS LAST
  ),

  ya_visible AS (
    SELECT
      'yandex'::text                                                            AS source,
      p.market_sku::text                                                        AS source_id,
      p.market_model_id::text                                                   AS market_model_id,
      p.name                                                                    AS title,
      p.pictures                                                                AS images,
      p.basic_price::numeric                                                    AS price,
      p.basic_price::numeric                                                    AS original_price,
      0                                                                         AS discount,
      lower(trim(COALESCE(NULLIF(trim(COALESCE(p.vendor_code,'')), ''), p.offer_id, ''))) AS vendor_code,
      COALESCE(p.vendor, '')                                                    AS brand,
      COALESCE(p.category_name, '')                                             AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.custom_title, '')                                             AS custom_title,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      ''::text                                                                  AS ozon_sku,
      COALESCE(p.stock_available, p.stock_total, 0)::int                        AS stock,
      p.weight_kg,
      p.length_cm,
      p.width_cm,
      p.height_cm
    FROM yandex_stores s
    JOIN yandex_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'yandex' AND ov.source_id = p.market_sku::text
    WHERE s.company_id = v_company_id
      AND NOT COALESCE(p.archived, false)
      AND NOT COALESCE(ov.is_hidden, false)
      AND p.name IS NOT NULL AND p.name != ''
  ),
  ya AS (
    SELECT DISTINCT ON (CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END)
      source, source_id, market_model_id, title, images, price, original_price,
      discount, vendor_code, brand, category, custom_url, custom_price, custom_title,
      sort_order, is_hidden, ozon_sku, stock, weight_kg, length_cm, width_cm, height_cm
    FROM ya_visible
    ORDER BY
      CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END,
      price ASC,
      COALESCE(array_length(images, 1), 0) DESC NULLS LAST
  ),

  all_products AS (
    SELECT * FROM wb
    UNION ALL SELECT * FROM oz
    UNION ALL SELECT * FROM ya
  ),

  top_groups AS (
    SELECT DISTINCT
      CASE WHEN vendor_code = '' THEN (source || ':' || source_id) ELSE vendor_code END AS gk
    FROM all_products
    ORDER BY gk
  )

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'source',          a.source,
      'source_id',       a.source_id,
      'market_model_id', a.market_model_id,
      'ozon_sku',        NULLIF(a.ozon_sku, ''),
      'title',           a.title,
      'images',          a.images,
      'price',           a.price,
      'original_price',  a.original_price,
      'discount',        a.discount,
      'vendor_code',     a.vendor_code,
      'brand',           a.brand,
      'category',        a.category,
      'custom_url',      a.custom_url,
      'custom_price',    a.custom_price,
      'custom_title',    a.custom_title,
      'stock',           a.stock,
      'weight_kg',       a.weight_kg,
      'length_cm',       a.length_cm,
      'width_cm',        a.width_cm,
      'height_cm',       a.height_cm
    ) ORDER BY a.sort_order, a.vendor_code, a.source
  ), '[]'::jsonb)
  INTO v_products
  FROM all_products a
  JOIN top_groups g
    ON (CASE WHEN a.vendor_code = '' THEN (a.source || ':' || a.source_id) ELSE a.vendor_code END) = g.gk;

  RETURN jsonb_build_object(
    'settings',  v_settings,
    'banners',   COALESCE(v_banners,   '[]'::jsonb),
    'groups',    COALESCE(v_groups,    '[]'::jsonb),
    'variants',  COALESCE(v_variants,  '[]'::jsonb),
    'products',  COALESCE(v_products,  '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_storefront(text) TO anon;

-- 3. Admin: get companies that have at least one marketplace API configured
--    Sorted: active subs first → trial → expired; then by sub end date desc
CREATE OR REPLACE FUNCTION admin_get_companies_with_api(
  p_search TEXT DEFAULT '',
  p_limit  INT  DEFAULT 100
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN (
    SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
    FROM (
      SELECT
        co.id,
        co.name,
        co.color,
        co.logo_url,
        co.created_at,
        owner_u.id               AS owner_id,
        owner_u.first_name       AS owner_first_name,
        owner_u.last_name        AS owner_last_name,
        owner_u.telegram_username AS owner_username,
        (SELECT COUNT(*) FROM company_members cm WHERE cm.company_id = co.id) AS member_count,
        -- Which APIs are connected
        EXISTS(SELECT 1 FROM ozon_stores    os WHERE os.company_id = co.id) AS has_ozon,
        EXISTS(SELECT 1 FROM wb_stores      ws WHERE ws.company_id = co.id) AS has_wb,
        EXISTS(SELECT 1 FROM yandex_stores  ys WHERE ys.company_id = co.id) AS has_yandex,
        -- Subscription for this company
        (SELECT json_build_object(
          'id',                  us.id,
          'plan_key',            us.plan_key,
          'price_rub',           us.price_rub,
          'status',              us.status,
          'current_period_start',us.current_period_start,
          'current_period_end',  us.current_period_end
        ) FROM user_subscriptions us WHERE us.company_id = co.id LIMIT 1) AS subscription,
        -- Owner trial
        (SELECT ut.ends_at FROM user_trials ut WHERE ut.user_id = owner_u.id) AS owner_trial_ends_at,
        -- Monthly revenue
        COALESCE(us2.monthly_revenue, 0) AS monthly_revenue
      FROM companies co
      LEFT JOIN users owner_u ON owner_u.id = co.created_by
      LEFT JOIN user_subscriptions us2 ON us2.company_id = co.id
      WHERE (
        EXISTS(SELECT 1 FROM ozon_stores   os WHERE os.company_id = co.id) OR
        EXISTS(SELECT 1 FROM wb_stores     ws WHERE ws.company_id = co.id) OR
        EXISTS(SELECT 1 FROM yandex_stores ys WHERE ys.company_id = co.id)
      )
      AND (
        p_search = ''
        OR LOWER(co.name) LIKE LOWER('%' || p_search || '%')
        OR LOWER(COALESCE(owner_u.first_name,'') || ' ' || COALESCE(owner_u.last_name,'')) LIKE LOWER('%' || p_search || '%')
        OR LOWER(COALESCE(owner_u.telegram_username,'')) LIKE LOWER('%' || p_search || '%')
      )
      ORDER BY
        -- active subscription first
        CASE WHEN us2.status = 'active' AND (us2.current_period_end IS NULL OR us2.current_period_end > now()) THEN 0
             WHEN (SELECT ends_at FROM user_trials WHERE user_id = owner_u.id AND ends_at > now() LIMIT 1) IS NOT NULL THEN 1
             ELSE 2 END,
        -- within active: soonest expiry first (most urgent)
        us2.current_period_end ASC NULLS LAST
      LIMIT p_limit
    ) r
  );
END;
$$;

-- 4. Admin: extend a company's subscription by N days
--    If no subscription exists → creates one (starter, 0 ₽) for N days
--    If active → adds days to current end; if expired → restarts from now
CREATE OR REPLACE FUNCTION admin_extend_subscription(
  p_company_id UUID,
  p_days       INT DEFAULT 30
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin    platform_admins;
  v_owner_id UUID;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT COALESCE(
    (SELECT user_id FROM user_subscriptions WHERE company_id = p_company_id LIMIT 1),
    (SELECT created_by FROM companies WHERE id = p_company_id)
  ) INTO v_owner_id;

  INSERT INTO user_subscriptions
    (user_id, company_id, plan_key, price_rub, status, current_period_start, current_period_end)
  VALUES
    (v_owner_id, p_company_id, 'starter', 0, 'active', now(),
     now() + (p_days || ' days')::interval)
  ON CONFLICT (company_id) DO UPDATE SET
    status               = 'active',
    current_period_end   = GREATEST(COALESCE(user_subscriptions.current_period_end, now()), now())
                           + (p_days || ' days')::interval,
    updated_at           = now();
END;
$$;
