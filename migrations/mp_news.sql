-- MP News: новости маркетплейсов для Симы
-- Источник: Telegram-каналы, настраиваются в админ-панели.

CREATE TABLE IF NOT EXISTS mp_news (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mp            TEXT NOT NULL,        -- 'wb' | 'ozon' | 'yandex' | 'general'
  title         TEXT NOT NULL,        -- Заголовок (AI-суммаризация)
  summary       TEXT NOT NULL,        -- Краткое содержание (1-2 предложения)
  raw_text      TEXT,                 -- Оригинальный текст из канала
  source_url    TEXT,                 -- Ссылка на пост в Telegram
  is_important  BOOLEAN DEFAULT false, -- AI пометил как важное для продавца
  published_at  TIMESTAMPTZ NOT NULL, -- Дата публикации в канале
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mp_news_published_at_idx ON mp_news (published_at DESC);
CREATE INDEX IF NOT EXISTS mp_news_mp_idx ON mp_news (mp);
-- Предотвращаем дубли по source_url
CREATE UNIQUE INDEX IF NOT EXISTS mp_news_source_url_uidx ON mp_news (source_url) WHERE source_url IS NOT NULL;

-- Разрешаем анонимным пользователям читать новости (публичные данные)
ALTER TABLE mp_news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mp_news_read_all"     ON mp_news FOR SELECT USING (true);
CREATE POLICY "mp_news_insert_service" ON mp_news FOR INSERT WITH CHECK (false);

-- ── Каналы для сбора новостей (управляются в админ-панели) ───────────────────
CREATE TABLE IF NOT EXISTS mp_news_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mp           TEXT NOT NULL,          -- 'wb' | 'ozon' | 'yandex' | 'general'
  channel_slug TEXT NOT NULL,          -- @username без @, например: wbmarketplacenews
  label        TEXT,                   -- Человекочитаемое название
  enabled      BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mp_news_channels_slug_uidx ON mp_news_channels (channel_slug);

ALTER TABLE mp_news_channels ENABLE ROW LEVEL SECURITY;
-- Читают все (нужно фронту для отображения статуса)
CREATE POLICY "mp_news_channels_read"   ON mp_news_channels FOR SELECT USING (true);
-- Запись только service_role
CREATE POLICY "mp_news_channels_write"  ON mp_news_channels FOR ALL WITH CHECK (false);
