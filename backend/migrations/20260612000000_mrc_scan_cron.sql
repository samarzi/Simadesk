-- Периодический запуск Edge Function mrc-scan (МРЦ: WB / Ozon / Яндекс.Маркет)
-- через pg_cron + pg_net, чтобы коррекция цен работала независимо от того,
-- открыта ли вкладка SimaDesk.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select
  cron.schedule(
    'mrc-scan-every-20-min',
    '*/20 * * * *',
    $$
    select net.http_post(
      url := 'http://nginx:80/functions/v1/mrc-scan',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkcXd6b2pyc21iZHhpY3pxamNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0OTAwNjEsImV4cCI6MjA5MzA2NjA2MX0.lw9aXynPfMo0hy6J_E3BBlqd6W4MTIVM3BrVdjkBaNE'
      ),
      body := '{}'::jsonb
    );
    $$
  );
