-- Yandex profile data + profile source selector
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS yandex_login       TEXT,
  ADD COLUMN IF NOT EXISTS yandex_first_name  TEXT,
  ADD COLUMN IF NOT EXISTS yandex_last_name   TEXT,
  ADD COLUMN IF NOT EXISTS yandex_photo_url   TEXT,
  ADD COLUMN IF NOT EXISTS telegram_first_name TEXT,
  ADD COLUMN IF NOT EXISTS telegram_last_name  TEXT,
  ADD COLUMN IF NOT EXISTS telegram_photo_url  TEXT,
  ADD COLUMN IF NOT EXISTS profile_source      TEXT DEFAULT NULL;

-- Allow authenticated users to update their own profile fields
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='users' AND policyname='Users can update own profile'
  ) THEN
    CREATE POLICY "Users can update own profile"
      ON public.users FOR UPDATE
      USING (auth.uid() = id);
  END IF;
END $$;
