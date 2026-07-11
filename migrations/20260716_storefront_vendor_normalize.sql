-- Normalize vendor_code grouping: use lower(trim(...)) for DISTINCT ON and top_groups
-- so "ABC-001" and "abc-001" from different stores/MPs are treated as the same group
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
BEGIN
  SELECT ss.company_id,
         jsonb_build_object(
           'store_name', ss.store_name,
           'tagline',    ss.tagline,
           'telegram',   ss.telegram,
           'whatsapp',   ss.whatsapp,
           'phone',      ss.phone,
           'website',    ss.website,
           'slug',       ss.slug,
           'logo_url',   c.logo_url
         )
  INTO v_company_id, v_settings
  FROM storefront_settings ss
  LEFT JOIN companies c ON c.id = ss.company_id
  WHERE ss.slug = p_slug AND ss.is_enabled = true;

  IF v_company_id IS NULL THEN RETURN NULL; END IF;

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
      NULL::text                                                                AS description,
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
      discount, vendor_code, brand, description, custom_url, custom_price,
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
      lower(trim(COALESCE(p.offer_id, '')))                                     AS vendor_code,
      ''                                                                        AS brand,
      NULL::text                                                                AS description,
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
      discount, vendor_code, brand, description, custom_url, custom_price,
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
      lower(trim(COALESCE(p.vendor_code, '')))                                  AS vendor_code,
      COALESCE(p.vendor, '')                                                    AS brand,
      NULL::text                                                                AS description,
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
      discount, vendor_code, brand, description, custom_url, custom_price,
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
      'description',     a.description,
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
    'products', COALESCE(v_products, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_storefront(text) TO anon;
