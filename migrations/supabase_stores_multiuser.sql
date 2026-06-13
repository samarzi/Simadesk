-- ============================================================
-- MIGRATION: Add company_id to all marketplace store tables
-- + create wb_stores / yandex_stores in Supabase
-- Запустить в Supabase Dashboard → SQL Editor
-- ============================================================

-- ── 1. ozon_stores — добавить company_id ──────────────────────
ALTER TABLE ozon_stores
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ozon_stores_company_id ON ozon_stores(company_id);

-- ── 2. wb_stores ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_stores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  api_key      TEXT NOT NULL,
  seller_id    BIGINT,
  seller_name  TEXT,
  trademark    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wb_stores_company_id ON wb_stores(company_id);

-- ── 3. yandex_stores ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS yandex_stores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID REFERENCES companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  business_id    BIGINT,
  campaign_id    BIGINT,
  placement_type TEXT CHECK (placement_type IN ('FBS','FBY','DBS','LAAS')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yandex_stores_company_id ON yandex_stores(company_id);

-- ── 4. RLS выключен глобально — политики не нужны ─────────────
-- (когда включим RLS обратно — добавим политики здесь)
