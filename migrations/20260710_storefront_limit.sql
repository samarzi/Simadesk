-- Limit get_storefront products to 500 to prevent 16MB+ responses stalling the storefront.
-- Stores with 10k+ products cause browser timeouts; show top 500 sorted by sort_order then title.
CREATE OR REPLACE FUNCTION get_storefront(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_company_id uuid;
  v_settings jsonb;
  v_products jsonb;
  v_banners jsonb;
BEGIN
  SELECT company_id,
         jsonb_build_object(
           'store_name', store_name,
           'tagline',    tagline,
           'telegram',   telegram,
           'whatsapp',   whatsapp,
           'website',    website,
           'slug',       slug
         )
  INTO v_company_id, v_settings
  FROM storefront_settings
  WHERE slug = p_slug AND is_enabled = true;

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

  -- Wildberries: deduplicate by vendor_code (or source_id if empty), cheapest price wins
  WITH wb_visible AS (
    SELECT
      'wb'::text                                                                          AS source,
      p.nm_id::text                                                                       AS source_id,
      NULL::text                                                                          AS market_model_id,
      p.title,
      p.pictures                                                                          AS images,
      ROUND(p.price * (1 - COALESCE(p.discount,0)::numeric / 100))::numeric             AS price,
      p.price                                                                             AS original_price,
      COALESCE(p.discount, 0)                                                             AS discount,
      COALESCE(p.vendor_code, '')                                                         AS vendor_code,
      COALESCE(p.brand, '')                                                               AS brand,
      NULL::text                                                                          AS description,
      COALESCE(ov.custom_url, '')                                                         AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                          AS sort_order,
      COALESCE(ov.is_hidden, false)                                                       AS is_hidden
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
      discount, vendor_code, brand, description, custom_url, custom_price, sort_order, is_hidden
    FROM wb_visible
    ORDER BY
      CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END,
      price ASC,
      COALESCE(array_length(images, 1), 0) DESC NULLS LAST
  ),
  -- Ozon: deduplicate by vendor_code (offer_id), cheapest price wins
  oz_visible AS (
    SELECT
      'ozon'::text                                                                        AS source,
      p.product_id::text                                                                  AS source_id,
      NULL::text                                                                          AS market_model_id,
      p.name                                                                              AS title,
      p.images,
      p.price::numeric                                                                    AS price,
      COALESCE(NULLIF(p.old_price, 0), p.price)::numeric                                 AS original_price,
      CASE WHEN p.old_price > p.price
           THEN ROUND((1 - p.price::numeric / NULLIF(p.old_price,0)) * 100)
           ELSE 0 END                                                                     AS discount,
      COALESCE(p.offer_id, '')                                                            AS vendor_code,
      ''                                                                                  AS brand,
      NULL::text                                                                          AS description,
      COALESCE(ov.custom_url, '')                                                         AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                          AS sort_order,
      COALESCE(ov.is_hidden, false)                                                       AS is_hidden
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
      discount, vendor_code, brand, description, custom_url, custom_price, sort_order, is_hidden
    FROM oz_visible
    ORDER BY
      CASE WHEN vendor_code = '' THEN source_id ELSE vendor_code END,
      price ASC,
      COALESCE(array_length(images, 1), 0) DESC NULLS LAST
  ),
  -- Yandex Market: deduplicate by vendor_code, cheapest price wins
  ya_visible AS (
    SELECT
      'yandex'::text                                                                      AS source,
      p.market_sku::text                                                                  AS source_id,
      p.market_model_id::text                                                             AS market_model_id,
      p.name                                                                              AS title,
      p.pictures                                                                          AS images,
      p.basic_price::numeric                                                              AS price,
      p.basic_price::numeric                                                              AS original_price,
      0                                                                                   AS discount,
      COALESCE(p.vendor_code, '')                                                         AS vendor_code,
      COALESCE(p.vendor, '')                                                              AS brand,
      NULL::text                                                                          AS description,
      COALESCE(ov.custom_url, '')                                                         AS custom_url,
      ov.custom_price,
      COALESCE(ov.sort_order, 0)                                                          AS sort_order,
      COALESCE(ov.is_hidden, false)                                                       AS is_hidden
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
      discount, vendor_code, brand, description, custom_url, custom_price, sort_order, is_hidden
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
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'source',          source,
      'source_id',       source_id,
      'market_model_id', market_model_id,
      'title',           title,
      'images',          images,
      'price',           price,
      'original_price',  original_price,
      'discount',        discount,
      'vendor_code',     vendor_code,
      'brand',           brand,
      'description',     description,
      'custom_url',      custom_url,
      'custom_price',    custom_price
    )
  ), '[]'::jsonb)
  INTO v_products
  FROM (
    SELECT * FROM all_products
    ORDER BY sort_order ASC, title
    LIMIT 500
  ) limited;

  RETURN jsonb_build_object(
    'settings', v_settings,
    'banners',  COALESCE(v_banners,  '[]'::jsonb),
    'products', COALESCE(v_products, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_storefront(text) TO anon;
