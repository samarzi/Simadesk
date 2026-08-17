-- action_log: полный аудиторный журнал действий пользователей в системе.
-- Заменяет localStorage как основное хранилище; клиент продолжает кешировать последние 2000 записей.
CREATE TABLE IF NOT EXISTS action_log (
  id          TEXT PRIMARY KEY,              -- crypto.randomUUID() с клиента
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     TEXT,                          -- Supabase auth UUID пользователя
  user_name   TEXT,                          -- отображаемое имя (display_name / username / first_name)
  category    TEXT NOT NULL,                 -- product | price | group | import | rule | settings | sync | ai | undo | other
  action      TEXT NOT NULL,                 -- короткое описание действия
  details     TEXT NOT NULL DEFAULT '',      -- подробности
  related_id  TEXT,                          -- id оригинальной записи (для undo-события)
  request_text TEXT,                         -- исходный запрос пользователя (AI-действия)
  group_key   TEXT,                          -- для группировки в дерево
  undone      BOOLEAN NOT NULL DEFAULT FALSE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE action_log ENABLE ROW LEVEL SECURITY;

-- Участники компании видят весь журнал своей компании
CREATE POLICY "action_log_company_read" ON action_log
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Запись — только от своего имени в рамках своей компании
CREATE POLICY "action_log_company_insert" ON action_log
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Обновление (пометка undone) — только своих записей
CREATE POLICY "action_log_own_update" ON action_log
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE INDEX IF NOT EXISTS action_log_company_ts_idx
  ON action_log (company_id, ts DESC);

CREATE INDEX IF NOT EXISTS action_log_user_idx
  ON action_log (company_id, user_id, ts DESC);

CREATE INDEX IF NOT EXISTS action_log_category_idx
  ON action_log (company_id, category, ts DESC);

CREATE INDEX IF NOT EXISTS action_log_group_key_idx
  ON action_log (group_key) WHERE group_key IS NOT NULL;
