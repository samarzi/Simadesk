-- Task comments & attachments
-- v3: comments visible with author info, file attachments via Supabase Storage

-- ── Comments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL,            -- user_id from company_members
  body        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_comments_select" ON task_comments
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

CREATE POLICY "task_comments_insert" ON task_comments
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

CREATE POLICY "task_comments_delete" ON task_comments
  FOR DELETE USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

-- ── Attachments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  file_size   bigint NOT NULL DEFAULT 0,
  mime_type   text NOT NULL DEFAULT 'application/octet-stream',
  storage_path text NOT NULL,           -- path in Supabase Storage bucket
  uploaded_by uuid NOT NULL,            -- user_id
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE task_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_attachments_select" ON task_attachments
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

CREATE POLICY "task_attachments_insert" ON task_attachments
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

CREATE POLICY "task_attachments_delete" ON task_attachments
  FOR DELETE USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

-- ── Storage bucket (run manually in Supabase dashboard if needed) ───────────
-- INSERT INTO storage.buckets (id, name, public) VALUES ('task-files', 'task-files', false)
-- ON CONFLICT DO NOTHING;
--
-- CREATE POLICY "task_files_select" ON storage.objects FOR SELECT
--   USING (bucket_id = 'task-files' AND auth.role() = 'authenticated');
-- CREATE POLICY "task_files_insert" ON storage.objects FOR INSERT
--   WITH CHECK (bucket_id = 'task-files' AND auth.role() = 'authenticated');
-- CREATE POLICY "task_files_delete" ON storage.objects FOR DELETE
--   USING (bucket_id = 'task-files' AND auth.role() = 'authenticated');
