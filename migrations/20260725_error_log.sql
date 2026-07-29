-- error_log: клиентские необработанные ошибки для диагностики
CREATE TABLE IF NOT EXISTS error_log (
  id          BIGSERIAL PRIMARY KEY,
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  user_email  TEXT,
  message     TEXT NOT NULL,
  source      TEXT,
  stack       TEXT,
  url         TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Только INSERT для аутентифицированных пользователей, никакого SELECT/UPDATE/DELETE
ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insert_own_errors" ON error_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Автоочистка записей старше 30 дней через pg_cron (если доступен)
-- Если pg_cron не установлен — удаляйте вручную: DELETE FROM error_log WHERE occurred_at < now() - interval '30 days';

-- Индекс для аналитики по компании
CREATE INDEX IF NOT EXISTS error_log_company_id_idx ON error_log (company_id, occurred_at DESC);
