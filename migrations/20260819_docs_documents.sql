CREATE TABLE IF NOT EXISTS docs_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'word',
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  updated_at  BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS docs_documents_company_id_idx ON docs_documents(company_id);

ALTER TABLE docs_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_select ON docs_documents FOR SELECT
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY docs_insert ON docs_documents FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY docs_update ON docs_documents FOR UPDATE
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));

CREATE POLICY docs_delete ON docs_documents FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM company_members WHERE user_id = auth.uid()
  ));
