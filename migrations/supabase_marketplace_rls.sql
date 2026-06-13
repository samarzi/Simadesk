-- ============================================================
-- MIGRATION: Таблицы и RLS для всех маркетплейсов
-- Запустить в Supabase Dashboard → SQL Editor
-- ============================================================

-- user_company_ids() — используется во всех политиках
CREATE OR REPLACE FUNCTION user_company_ids()
RETURNS SETOF UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM company_members WHERE user_id = auth.uid();
$$;

-- ── wb_products ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_products (
  store_id     UUID        NOT NULL REFERENCES wb_stores(id) ON DELETE CASCADE,
  nm_id        BIGINT      NOT NULL,
  imt_id       BIGINT,
  vendor_code  TEXT        NOT NULL DEFAULT '',
  brand        TEXT        DEFAULT '',
  title        TEXT        NOT NULL DEFAULT '',
  subject      TEXT        DEFAULT '',
  pictures     TEXT[]      DEFAULT '{}',
  price        NUMERIC     DEFAULT NULL,
  discount     NUMERIC     DEFAULT NULL,
  stock_total  INTEGER     DEFAULT 0,
  synced_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT wb_products_store_nm_uq UNIQUE (store_id, nm_id)
);
CREATE INDEX IF NOT EXISTS idx_wb_products_store_id ON wb_products(store_id);

-- ── yandex_products ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS yandex_products (
  store_id        UUID        NOT NULL REFERENCES yandex_stores(id) ON DELETE CASCADE,
  offer_id        TEXT        NOT NULL,
  name            TEXT        NOT NULL DEFAULT '',
  vendor          TEXT        DEFAULT '',
  vendor_code     TEXT        DEFAULT '',
  pictures        TEXT[]      DEFAULT '{}',
  basic_price     NUMERIC     DEFAULT NULL,
  basic_currency  TEXT        DEFAULT 'RUR',
  market_sku      BIGINT      DEFAULT NULL,
  category_id     BIGINT      DEFAULT NULL,
  archived        BOOLEAN     DEFAULT FALSE,
  stock_total     INTEGER     DEFAULT 0,
  stock_available INTEGER     DEFAULT 0,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT yandex_products_store_offer_uq UNIQUE (store_id, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_yandex_products_store_id ON yandex_products(store_id);

-- ── RLS ozon_stores ───────────────────────────────────────────
ALTER TABLE ozon_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all"           ON ozon_stores;
DROP POLICY IF EXISTS "ozon_stores_select" ON ozon_stores;
DROP POLICY IF EXISTS "ozon_stores_insert" ON ozon_stores;
DROP POLICY IF EXISTS "ozon_stores_update" ON ozon_stores;
DROP POLICY IF EXISTS "ozon_stores_delete" ON ozon_stores;
CREATE POLICY "ozon_stores_select" ON ozon_stores FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "ozon_stores_insert" ON ozon_stores FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "ozon_stores_update" ON ozon_stores FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "ozon_stores_delete" ON ozon_stores FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- ── RLS ozon_products ─────────────────────────────────────────
ALTER TABLE ozon_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all"             ON ozon_products;
DROP POLICY IF EXISTS "ozon_products_select" ON ozon_products;
DROP POLICY IF EXISTS "ozon_products_insert" ON ozon_products;
DROP POLICY IF EXISTS "ozon_products_update" ON ozon_products;
DROP POLICY IF EXISTS "ozon_products_delete" ON ozon_products;
CREATE POLICY "ozon_products_select" ON ozon_products FOR SELECT USING (store_id IN (SELECT id FROM ozon_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "ozon_products_insert" ON ozon_products FOR INSERT WITH CHECK (store_id IN (SELECT id FROM ozon_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "ozon_products_update" ON ozon_products FOR UPDATE USING (store_id IN (SELECT id FROM ozon_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "ozon_products_delete" ON ozon_products FOR DELETE USING (store_id IN (SELECT id FROM ozon_stores WHERE company_id IN (SELECT user_company_ids())));

-- ── RLS wb_stores ─────────────────────────────────────────────
ALTER TABLE wb_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all"        ON wb_stores;
DROP POLICY IF EXISTS "wb_stores_select" ON wb_stores;
DROP POLICY IF EXISTS "wb_stores_insert" ON wb_stores;
DROP POLICY IF EXISTS "wb_stores_update" ON wb_stores;
DROP POLICY IF EXISTS "wb_stores_delete" ON wb_stores;
CREATE POLICY "wb_stores_select" ON wb_stores FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "wb_stores_insert" ON wb_stores FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "wb_stores_update" ON wb_stores FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "wb_stores_delete" ON wb_stores FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- ── RLS wb_products ───────────────────────────────────────────
ALTER TABLE wb_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wb_products_select" ON wb_products FOR SELECT USING (store_id IN (SELECT id FROM wb_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "wb_products_insert" ON wb_products FOR INSERT WITH CHECK (store_id IN (SELECT id FROM wb_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "wb_products_update" ON wb_products FOR UPDATE USING (store_id IN (SELECT id FROM wb_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "wb_products_delete" ON wb_products FOR DELETE USING (store_id IN (SELECT id FROM wb_stores WHERE company_id IN (SELECT user_company_ids())));

-- ── RLS yandex_stores ─────────────────────────────────────────
ALTER TABLE yandex_stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all"            ON yandex_stores;
DROP POLICY IF EXISTS "yandex_stores_select" ON yandex_stores;
DROP POLICY IF EXISTS "yandex_stores_insert" ON yandex_stores;
DROP POLICY IF EXISTS "yandex_stores_update" ON yandex_stores;
DROP POLICY IF EXISTS "yandex_stores_delete" ON yandex_stores;
CREATE POLICY "yandex_stores_select" ON yandex_stores FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "yandex_stores_insert" ON yandex_stores FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "yandex_stores_update" ON yandex_stores FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "yandex_stores_delete" ON yandex_stores FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- ── RLS yandex_products ───────────────────────────────────────
ALTER TABLE yandex_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "yandex_products_select" ON yandex_products FOR SELECT USING (store_id IN (SELECT id FROM yandex_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "yandex_products_insert" ON yandex_products FOR INSERT WITH CHECK (store_id IN (SELECT id FROM yandex_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "yandex_products_update" ON yandex_products FOR UPDATE USING (store_id IN (SELECT id FROM yandex_stores WHERE company_id IN (SELECT user_company_ids())));
CREATE POLICY "yandex_products_delete" ON yandex_products FOR DELETE USING (store_id IN (SELECT id FROM yandex_stores WHERE company_id IN (SELECT user_company_ids())));
