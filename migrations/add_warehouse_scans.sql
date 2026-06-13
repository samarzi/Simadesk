-- ============================================================
-- MIGRATION: Warehouse scans — сохранение результатов сканирования складов
-- ============================================================

CREATE TABLE IF NOT EXISTS warehouse_scans (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  name        text NOT NULL,
  platform    text NOT NULL CHECK (platform IN ('yandex', 'ozon')),
  url         text NOT NULL,
  warehouses  jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_scans_company
  ON warehouse_scans(company_id, platform);

ALTER TABLE warehouse_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "warehouse_scans_select"
  ON warehouse_scans FOR SELECT
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "warehouse_scans_insert"
  ON warehouse_scans FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "warehouse_scans_delete"
  ON warehouse_scans FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));
