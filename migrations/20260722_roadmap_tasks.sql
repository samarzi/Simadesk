-- Roadmap tasks — задачи дорожной карты, управляемые из админ-панели
CREATE TABLE IF NOT EXISTS roadmap_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quadrant TEXT NOT NULL DEFAULT 'important_not_urgent'
    CHECK (quadrant IN ('urgent_important', 'important_not_urgent', 'urgent_not_important', 'not_urgent_not_important')),
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done', 'deleted')),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: только admin/superadmin
ALTER TABLE roadmap_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roadmap_admin_all" ON roadmap_tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = auth.uid()
      AND user_roles.role IN ('admin', 'superadmin')
    )
  );

-- Seed: начальные задачи
INSERT INTO roadmap_tasks (title, description, quadrant, status, sort_order) VALUES
('Sentry (Error Tracking)', 'Мониторинг ошибок в production. @sentry/browser, DSN в .env, captureException в catch-блоках.', 'urgent_important', 'todo', 1),
('Приглашение участников по ссылке', 'UI: Настройки компании → Участники → Пригласить. Таблица company_invites уже есть.', 'urgent_important', 'todo', 2),
('Unit-экономика per SKU', 'Детальный вид: выручка − себестоимость − комиссия − логистика = прибыль. financeSync уже есть.', 'urgent_important', 'todo', 3),
('Разбить App.ts на модули', '1971 строка → views/ + components/. Целевой размер App.ts: 300-500 строк.', 'important_not_urgent', 'todo', 4),
('Тесты 60% покрытие', '19 тестов → 60% на сервисах. Приоритет: priceFormulas, API, financeSync, authService.', 'important_not_urgent', 'todo', 5),
('Автобиддер WB', '4 стратегии ставок. API готов (adv/v1), нужен UI + cron каждые 30 мин.', 'important_not_urgent', 'todo', 6),
('P&L дашборд', 'Выручка − расходы = прибыль. Графики, периоды, экспорт XLSX.', 'important_not_urgent', 'todo', 7),
('Массовое редактирование', 'Чекбоксы, панель действий, массовое изменение цены, batch-обновление на МП.', 'important_not_urgent', 'todo', 8),
('REST API для интеграций', 'Товары, заказы, аналитика, цены. JWT, rate limiting, Swagger.', 'not_urgent_not_important', 'todo', 9),
('Telegram Mini App', 'Мобильный доступ: дашборд, FBS-заказы, уведомления.', 'important_not_urgent', 'todo', 10);
