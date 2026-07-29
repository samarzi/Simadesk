-- Telegram bot notification tables

-- Привязка Telegram чатов к пользователям
CREATE TABLE IF NOT EXISTS tg_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  company_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

-- Настройки уведомлений
CREATE TABLE IF NOT EXISTS tg_notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id UUID,
  notify_new_order BOOLEAN DEFAULT true,
  notify_low_stock BOOLEAN DEFAULT true,
  notify_bad_review BOOLEAN DEFAULT true,
  notify_daily_summary BOOLEAN DEFAULT false,
  low_stock_threshold INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

-- RLS policies
ALTER TABLE tg_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_notification_settings ENABLE ROW LEVEL SECURITY;

-- Users can read/write their own chats
CREATE POLICY "tg_chats_own" ON tg_chats
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "tg_notif_settings_own" ON tg_notification_settings
  FOR ALL USING (user_id = auth.uid());

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tg_chats_user ON tg_chats(user_id);
CREATE INDEX IF NOT EXISTS idx_tg_chats_chat_id ON tg_chats(chat_id);
CREATE INDEX IF NOT EXISTS idx_tg_notif_user ON tg_notification_settings(user_id);
