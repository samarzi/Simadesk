-- ── Filter toggles on storefront_settings ──────────────────────────────────
ALTER TABLE storefront_settings
  ADD COLUMN IF NOT EXISTS show_price_filter    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_brand_filter    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS show_category_filter BOOLEAN DEFAULT FALSE;

-- ── Yandex category name (seller-specified, from offer.category API field) ──
ALTER TABLE yandex_products ADD COLUMN IF NOT EXISTS category_name TEXT DEFAULT '';

-- ── Manual groups / collections ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storefront_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL,
  name        TEXT        NOT NULL DEFAULT '',
  cover_url   TEXT        DEFAULT '',
  sort_order  INTEGER     DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sfg_company ON storefront_groups(company_id);

CREATE TABLE IF NOT EXISTS storefront_group_items (
  group_id    UUID  NOT NULL REFERENCES storefront_groups(id) ON DELETE CASCADE,
  vendor_code TEXT  NOT NULL,
  PRIMARY KEY (group_id, vendor_code)
);

CREATE INDEX IF NOT EXISTS idx_sfgi_vc ON storefront_group_items(vendor_code);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE storefront_groups      ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_group_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sfg_all"  ON storefront_groups;
DROP POLICY IF EXISTS "sfgi_all" ON storefront_group_items;

CREATE POLICY "sfg_all" ON storefront_groups
  FOR ALL USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "sfgi_all" ON storefront_group_items
  FOR ALL USING (group_id IN (
    SELECT id FROM storefront_groups WHERE company_id IN (SELECT user_company_ids())
  ));
