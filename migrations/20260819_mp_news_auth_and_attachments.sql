-- [1] Добавляем INSERT/UPDATE RLS для mp_news (ручное добавление из админ-панели)
DROP POLICY IF EXISTS "mp_news_insert_auth" ON mp_news;
CREATE POLICY "mp_news_insert_auth" ON mp_news
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "mp_news_update_auth" ON mp_news;
CREATE POLICY "mp_news_update_auth" ON mp_news
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- [2] Таблица вложений к новостям (фото/видео)
CREATE TABLE IF NOT EXISTS mp_news_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  news_id     uuid NOT NULL REFERENCES mp_news(id) ON DELETE CASCADE,
  file_url    TEXT NOT NULL,
  file_type   TEXT NOT NULL DEFAULT 'image',  -- 'image' | 'video'
  file_name   TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mp_news_attachments_news_id_idx ON mp_news_attachments (news_id);

ALTER TABLE mp_news_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mp_news_attachments_read"   ON mp_news_attachments;
DROP POLICY IF EXISTS "mp_news_attachments_insert" ON mp_news_attachments;
DROP POLICY IF EXISTS "mp_news_attachments_delete" ON mp_news_attachments;

CREATE POLICY "mp_news_attachments_read" ON mp_news_attachments
  FOR SELECT USING (true);

CREATE POLICY "mp_news_attachments_insert" ON mp_news_attachments
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "mp_news_attachments_delete" ON mp_news_attachments
  FOR DELETE TO authenticated USING (true);

-- [3] Storage bucket для медиафайлов новостей (создаётся через storage schema)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mp-news-media',
  'mp-news-media',
  true,
  52428800,  -- 50MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm']
)
ON CONFLICT (id) DO NOTHING;

-- RLS для storage bucket
DROP POLICY IF EXISTS "mp_news_media_read"   ON storage.objects;
DROP POLICY IF EXISTS "mp_news_media_insert" ON storage.objects;
DROP POLICY IF EXISTS "mp_news_media_delete" ON storage.objects;

CREATE POLICY "mp_news_media_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'mp-news-media');

CREATE POLICY "mp_news_media_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'mp-news-media');

CREATE POLICY "mp_news_media_delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'mp-news-media');
