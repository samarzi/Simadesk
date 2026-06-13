-- Migration: repricer_rules — правила репрайсера (привязаны к компании)
-- Run in Supabase SQL Editor
-- Раньше правила хранились только в localStorage браузера, поэтому в разных
-- браузерах/устройствах показывались разные наборы правил. Теперь синхронизируются
-- через Supabase, как cost_prices.

CREATE TABLE IF NOT EXISTS repricer_rules (
  id           TEXT PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_repricer_rules_company ON repricer_rules(company_id);

ALTER TABLE repricer_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rr_select_member" ON repricer_rules
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );
CREATE POLICY "rr_insert_member" ON repricer_rules
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );
CREATE POLICY "rr_update_member" ON repricer_rules
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );
CREATE POLICY "rr_delete_member" ON repricer_rules
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );

COMMENT ON TABLE repricer_rules IS 'Правила репрайсера (per-company), синхронизируются между браузерами/устройствами';
