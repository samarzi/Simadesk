-- Память Симы: структурированные знания о маркетплейсах
-- Формируется автоматически из новостей + редактируется в Admin → Мозг

CREATE TABLE IF NOT EXISTS sima_memory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mp           TEXT NOT NULL DEFAULT 'general', -- 'wb','ozon','yandex','general'
  category     TEXT NOT NULL DEFAULT 'other',   -- 'fees','logistics','requirements','promotions','tech','payments','other'
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  keywords     TEXT[] DEFAULT '{}',
  source_news_ids uuid[] DEFAULT '{}',
  updated_at   TIMESTAMPTZ DEFAULT now(),
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Уникальность по тройке: один топик на одну категорию одного МП
CREATE UNIQUE INDEX IF NOT EXISTS sima_memory_mp_cat_title ON sima_memory(mp, category, title);
CREATE INDEX IF NOT EXISTS sima_memory_mp_idx ON sima_memory(mp);
CREATE INDEX IF NOT EXISTS sima_memory_cat_idx ON sima_memory(category);

ALTER TABLE sima_memory ENABLE ROW LEVEL SECURITY;
-- Аутентифицированные пользователи читают и управляют памятью из AdminModule
CREATE POLICY "sima_memory_read"   ON sima_memory FOR SELECT TO authenticated USING (true);
CREATE POLICY "sima_memory_insert" ON sima_memory FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "sima_memory_update" ON sima_memory FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "sima_memory_delete" ON sima_memory FOR DELETE TO authenticated USING (true);
-- Service role (edge function) обходит RLS автоматически
