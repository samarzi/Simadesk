-- repricer_price_log: история применения правил ценообразования
-- Заменяет localStorage-only хранение; 200-записей cap остаётся на клиенте,
-- но сервер хранит полную историю для аналитики и аудита.
CREATE TABLE IF NOT EXISTS repricer_price_log (
  id           TEXT PRIMARY KEY,
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_id      TEXT NOT NULL,
  marketplace  TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  store_name   TEXT,
  product_id   TEXT NOT NULL,
  product_title TEXT,
  old_price    NUMERIC,
  new_price    NUMERIC NOT NULL,
  reason       TEXT,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE repricer_price_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_own_log" ON repricer_price_log
  FOR ALL TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS repricer_price_log_company_applied_idx
  ON repricer_price_log (company_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS repricer_price_log_rule_idx
  ON repricer_price_log (rule_id, applied_at DESC);
