-- Автоматический сбор новостей каждые 6 часов через pg_cron + pg_net
-- Требует расширений: pg_cron, pg_net
--
-- Проверить:  SELECT * FROM cron.job WHERE jobname = 'mp-news-fetch-6h';
-- Отключить: SELECT cron.unschedule('mp-news-fetch-6h');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Идемпотентность
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mp-news-fetch-6h') THEN
    PERFORM cron.unschedule('mp-news-fetch-6h');
  END IF;
END;
$$;

SELECT cron.schedule(
  'mp-news-fetch-6h',
  '0 */6 * * *',
  $$
    SELECT net.http_post(
      url     := 'http://nginx:80/functions/v1/telegram-auth/mp-news-fetch',
      headers := '{"Content-Type":"application/json","x-cron-source":"pg-cron"}'::jsonb,
      body    := '{}'::jsonb
    );
  $$
);
