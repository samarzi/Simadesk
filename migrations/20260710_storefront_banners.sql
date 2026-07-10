-- Таблица баннеров для SimaStore
CREATE TABLE IF NOT EXISTS storefront_banners (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL,
  image_url text NOT NULL,
  link_url text NOT NULL DEFAULT '/',
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sf_banners_co ON storefront_banners(company_id, is_active, sort_order);

-- Обновить get_storefront функцию чтобы включала баннеры
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
           'tagline', tagline,
           'telegram', telegram,
           'whatsapp', whatsapp,
           'website', website,
           'slug', slug
         )
  INTO v_company_id, v_settings
  FROM storefront_settings
  WHERE slug = p_slug AND is_enabled = true;

  IF v_company_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Баннеры
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'image_url', image_url,
      'link_url', link_url,
      'sort_order', sort_order
    ) ORDER BY sort_order, created_at
  ), '[]'::jsonb)
  INTO v_banners
  FROM storefront_banners
  WHERE company_id = v_company_id AND is_active = true;

  -- Товары из всех маркетплейсов (WB + Ozon + Yandex)
  WITH wb AS (
    SELECT
      'wb'::text AS source,
      p.nm_id::text AS source_id,
      p.title,
      CASE WHEN array_length(p.pictures, 1) > 0 THEN p.pictures[1] ELSE NULL END AS image,
      p.pictures AS images,
      ROUND(p.price * (1 - COALESCE(p.discount, 0)::numeric / 100))::numeric AS price,
      p.price AS original_price,
      COALESCE(p.discount, 0) AS discount,
      COALESCE(p.stock_total, 0) AS stock,
      COALESCE(p.vendor_code, '') AS vendor_code,
      COALESCE(p.brand, '') AS brand,
      NULL::text AS description,
      COALESCE(ov.custom_url, '') AS custom_url,
      COALESCE(ov.sort_order, 0) AS sort_order,
      COALESCE(ov.is_hidden, false) AS is_hidden
    FROM wb_stores s
    JOIN wb_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'wb' AND ov.source_id = p.nm_id::text
    WHERE s.company_id = v_company_id
  ),
  oz AS (
    SELECT
      'ozon'::text AS source,
      p.product_id::text AS source_id,
      p.name AS title,
      CASE WHEN array_length(p.images, 1) > 0 THEN p.images[1] ELSE NULL END AS image,
      p.images,
      p.price::numeric,
      COALESCE(NULLIF(p.old_price, 0), p.price)::numeric AS original_price,
      CASE WHEN p.old_price > p.price THEN ROUND((1 - p.price::numeric/NULLIF(p.old_price,0)) * 100) ELSE 0 END AS discount,
      COALESCE(p.stock_fbs, 0) + COALESCE(p.stock_fbo, 0) AS stock,
      COALESCE(p.offer_id, '') AS vendor_code,
      '' AS brand,
      NULL::text AS description,
      COALESCE(ov.custom_url, '') AS custom_url,
      COALESCE(ov.sort_order, 0) AS sort_order,
      COALESCE(ov.is_hidden, false) AS is_hidden
    FROM ozon_stores s
    JOIN ozon_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'ozon' AND ov.source_id = p.product_id::text
    WHERE s.company_id = v_company_id
  ),
  ya AS (
    SELECT
      'yandex'::text AS source,
      p.market_sku::text AS source_id,
      p.name AS title,
      CASE WHEN array_length(p.pictures, 1) > 0 THEN p.pictures[1] ELSE NULL END AS image,
      p.pictures AS images,
      p.basic_price::numeric AS price,
      p.basic_price::numeric AS original_price,
      0 AS discount,
      COALESCE(p.stock_total, 0) AS stock,
      COALESCE(p.vendor_code, '') AS vendor_code,
      COALESCE(p.vendor, '') AS brand,
      NULL::text AS description,
      COALESCE(ov.custom_url, '') AS custom_url,
      COALESCE(ov.sort_order, 0) AS sort_order,
      COALESCE(ov.is_hidden, false) AS is_hidden
    FROM yandex_stores s
    JOIN yandex_products p ON p.store_id = s.id
    LEFT JOIN storefront_product_overrides ov
      ON ov.company_id = v_company_id AND ov.source = 'yandex' AND ov.source_id = p.market_sku::text
    WHERE s.company_id = v_company_id AND NOT COALESCE(p.archived, false)
  ),
  all_products AS (
    SELECT * FROM wb
    UNION ALL SELECT * FROM oz
    UNION ALL SELECT * FROM ya
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'source', source,
      'source_id', source_id,
      'title', title,
      'image', image,
      'images', images,
      'price', price,
      'original_price', original_price,
      'discount', discount,
      'stock', stock,
      'vendor_code', vendor_code,
      'brand', brand,
      'description', description,
      'custom_url', custom_url
    ) ORDER BY sort_order, title
  ), '[]'::jsonb)
  INTO v_products
  FROM all_products
  WHERE NOT is_hidden AND title IS NOT NULL AND title != '';

  RETURN jsonb_build_object(
    'settings', v_settings,
    'banners', COALESCE(v_banners, '[]'::jsonb),
    'products', COALESCE(v_products, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_storefront(text) TO anon;
