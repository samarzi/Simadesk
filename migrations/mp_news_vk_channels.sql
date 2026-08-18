-- Добавляем VK-каналы как источники новостей (Telegram заблокирован на российских VPS)
-- Slug-ы начинаются с "vk:" — edge function читает через VK API
-- Требуется: VK_SERVICE_TOKEN в .env на VPS (бесплатный сервисный ключ VK-приложения)

-- Убираем мёртвый Telegram-канал WB (последний пост 2022)
DELETE FROM mp_news_channels WHERE channel_slug = 'wbmarketplacenews';

-- Добавляем активные VK-сообщества маркетплейсов
-- vk.ru/wbsellerofficial  — официальный аккаунт WB для продавцов
-- vk.ru/ozon              — официальная страница Ozon
-- vk.ru/postavshchiki_wb  — сообщество поставщиков и селлеров WB
INSERT INTO mp_news_channels (mp, channel_slug, label, enabled) VALUES
  ('wb',     'vk:wbsellerofficial',  'Wildberries для продавцов (VK)',   true),
  ('wb',     'vk:postavshchiki_wb',  'Поставщики и селлеры WB (VK)',     true),
  ('ozon',   'vk:ozon',              'Ozon официальный (VK)',             true)
ON CONFLICT (channel_slug) DO NOTHING;
