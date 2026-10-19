BEGIN;

ALTER TABLE public.ip_audit_runs ALTER COLUMN model_id SET DEFAULT 'auto';

-- Automated jobs share the same explicit Auto mode as interactive AI tools.
INSERT INTO public.site_content (key, title, content, updated_at) VALUES
  ('ai_support_model', 'Модель ИИ поддержки', 'auto', now()),
  ('ai_news_model', 'Модель обработки новостей', 'auto', now()),
  ('ai_memory_model', 'Модель обновления знаний', 'auto', now())
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
