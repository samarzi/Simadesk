-- Migration: cost_prices — себестоимости товаров (привязаны к компании)
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS cost_prices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_code  TEXT NOT NULL,
  cost         NUMERIC(12,2) NOT NULL CHECK (cost >= 0),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE(company_id, vendor_code)
);

CREATE INDEX IF NOT EXISTS idx_cost_prices_company ON cost_prices(company_id);
CREATE INDEX IF NOT EXISTS idx_cost_prices_vendor  ON cost_prices(company_id, lower(vendor_code));

ALTER TABLE cost_prices ENABLE ROW LEVEL SECURITY;

-- Member может читать
CREATE POLICY "cp_select_member" ON cost_prices
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );
-- Member может писать (owner/admin/manager)
CREATE POLICY "cp_insert_member" ON cost_prices
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );
CREATE POLICY "cp_update_member" ON cost_prices
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );
CREATE POLICY "cp_delete_member" ON cost_prices
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );

COMMENT ON TABLE cost_prices IS 'Себестоимости товаров по артикулам (per-company)';
