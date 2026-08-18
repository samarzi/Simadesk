-- Убираем мёртвый Telegram-канал WB (последний пост 2022)
DELETE FROM mp_news_channels WHERE channel_slug = 'wbmarketplacenews';
