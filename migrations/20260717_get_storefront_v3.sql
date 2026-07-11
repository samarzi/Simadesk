-- get_storefront v3:
--   • product.category: wb.subject | ozon.category | yandex.category_name
--   • settings: show_price_filter, show_brand_filter, show_category_filter
--   • groups with vendor_codes list

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
BEGIN
  SELECT
    company_id,
    jsonb_build_object(
      'store_name',           store_name,
      'tagline',              tagline,
      'telegram',             telegram,
      'whatsapp',             whatsapp,
      'website',              website,
      'slug',                 slug,
      'logo_url',             logo_url,
      'show_price_filter',    COALESCE(show_price_filter, true),
      'show_brand_filter',    COALESCE(show_brand_filter, false),
      'show_category_filter', COALESCE(show_category_filter, false)
    )
  INTO v_company_id, v_settings
  FROM storefront_settings
  WHERE slug = p_slug AND is_enabled = true;

  IF v_company_id IS NULL THEN RETURN NULL; END IF;

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

  -- ── Products (with per-MP deduplication and categories) ──────────────────

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
      COALESCE(p.vendor_code, '')                                               AS vendor_code,
      COALESCE(p.brand, '')                                                     AS brand,
      COALESCE(p.subject, '')                                                   AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      ''::text                                                                  AS ozon_sku
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
      discount, vendor_code, brand, category, custom_url, custom_price,
      sort_order, is_hidden, ozon_sku
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
      COALESCE(p.offer_id, '')                                                  AS vendor_code,
      ''                                                                        AS brand,
      COALESCE(p.category, '')                                                  AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      COALESCE(p.sku::text, '')                                                 AS ozon_sku
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
      discount, vendor_code, brand, category, custom_url, custom_price,
      sort_order, is_hidden, ozon_sku
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
      COALESCE(p.vendor_code, '')                                               AS vendor_code,
      COALESCE(p.vendor, '')                                                    AS brand,
      COALESCE(p.category_name, '')                                             AS category,
      COALESCE(ov.custom_url, '')                                               AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                AS sort_order,
      COALESCE(ov.is_hidden, false)                                             AS is_hidden,
      ''::text                                                                  AS ozon_sku
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
      discount, vendor_code, brand, category, custom_url, custom_price,
      sort_order, is_hidden, ozon_sku
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
    LIMIT 300
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
      'custom_price',    a.custom_price
    ) ORDER BY a.sort_order, a.vendor_code, a.source
  ), '[]'::jsonb)
  INTO v_products
  FROM all_products a
  JOIN top_groups g
    ON (CASE WHEN a.vendor_code = '' THEN (a.source || ':' || a.source_id) ELSE a.vendor_code END) = g.gk;

  RETURN jsonb_build_object(
    'settings', v_settings,
    'banners',  COALESCE(v_banners,  '[]'::jsonb),
    'groups',   COALESCE(v_groups,   '[]'::jsonb),
    'products', COALESCE(v_products, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_storefront(text) TO anon;
