-- Таблица уведомлений пользователей
-- Поддерживает: персональные (user_id = uid) и broadcast (user_id IS NULL)

CREATE TABLE IF NOT EXISTS user_notifications (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT         NOT NULL DEFAULT 'info',
  title       TEXT         NOT NULL,
  body        TEXT,
  icon        TEXT         NOT NULL DEFAULT '🔔',
  read        BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata    JSONB        NOT NULL DEFAULT '{}',
  sender_id   UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_notif_user   ON user_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notif_time   ON user_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notif_unread ON user_notifications(user_id, read) WHERE read = false;

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- Пользователи читают свои + broadcasts
CREATE POLICY "notif_select" ON user_notifications FOR SELECT
  USING (user_id = auth.uid() OR user_id IS NULL);

-- Пользователи могут помечать прочитанными
CREATE POLICY "notif_update_read" ON user_notifications FOR UPDATE
  USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (true);

-- Удаление только своих
CREATE POLICY "notif_delete_own" ON user_notifications FOR DELETE
  USING (user_id = auth.uid());

-- Admins: полный доступ через service_role (Edge Functions)
-- INSERT делается через Edge Function admin-send-notification с service_role
