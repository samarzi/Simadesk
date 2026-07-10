-- Add Yandex OAuth support to users table
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS yandex_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS users_yandex_id_key ON public.users (yandex_id)
  WHERE yandex_id IS NOT NULL;
