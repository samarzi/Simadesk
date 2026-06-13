-- ============================================================
-- MIGRATION: Automation reports — результаты выполнения автоматизации
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_reports (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  script_type text NOT NULL CHECK (script_type IN ('yandex-warehouses', 'yandex-tariffs', 'ozon-warehouses')),
  warehouse_name text,
  mode        text,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz DEFAULT now(),
  total_cities int NOT NULL DEFAULT 0,
  filled      int NOT NULL DEFAULT 0,
  already_set int NOT NULL DEFAULT 0,
  not_found   int NOT NULL DEFAULT 0,
  errors      int NOT NULL DEFAULT 0,
  details     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_reports_company
  ON automation_reports(company_id, script_type);

ALTER TABLE automation_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automation_reports_select"
  ON automation_reports FOR SELECT
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "automation_reports_insert"
  ON automation_reports FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));
