-- Исправление RLS-политик для mp_news_channels и mp_news
-- Проблема: политика write блокировала запись из фронта (authenticated пользователи)

-- ── mp_news_channels: управляется из админ-панели ────────────────────────────
-- Удаляем старую запрещающую политику
DROP POLICY IF EXISTS "mp_news_channels_write" ON mp_news_channels;

-- Аутентифицированные пользователи могут управлять каналами
CREATE POLICY "mp_news_channels_insert" ON mp_news_channels
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "mp_news_channels_update" ON mp_news_channels
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "mp_news_channels_delete" ON mp_news_channels
  FOR DELETE TO authenticated USING (true);

-- ── mp_news: вставляет edge function (service_role), удаляет admin ────────────
-- Удаляем старую запрещающую политику на вставку
DROP POLICY IF EXISTS "mp_news_insert_service" ON mp_news;

-- Edge function использует service_role — он обходит RLS автоматически.
-- Аутентифицированные пользователи могут удалять (кнопка "Очистить" в админ-панели)
CREATE POLICY "mp_news_delete_auth" ON mp_news
  FOR DELETE TO authenticated USING (true);
