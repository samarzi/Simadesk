-- Документы редактора: владелец, доступ и «Недавние» на аккаунте.
--
-- 1. owner_id / visibility: документ виден всему кабинету ('company') или
--    только владельцу ('private'). Менять доступ может только владелец.
--    Документы, созданные до миграции (owner_id IS NULL), остаются общими.
-- 2. meta: параметры документа Word (размер и поля страницы, шрифт).
-- 3. docs_recent: «Недавние» и открытые вкладки — у пользователя, а не в
--    браузере, поэтому с другого компьютера видно то же самое.
--
-- Миграция идемпотентна: deploy.sh прогоняет все файлы при каждом выкате.

ALTER TABLE docs_documents ADD COLUMN IF NOT EXISTS owner_id   UUID;
ALTER TABLE docs_documents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'company';
ALTER TABLE docs_documents ADD COLUMN IF NOT EXISTS meta       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE docs_documents ALTER COLUMN owner_id SET DEFAULT auth.uid();

DO $$ BEGIN
  ALTER TABLE docs_documents ADD CONSTRAINT docs_documents_visibility_chk CHECK (visibility IN ('company', 'private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS docs_documents_owner_idx ON docs_documents(owner_id);

-- ── Права ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS docs_select ON docs_documents;
DROP POLICY IF EXISTS docs_insert ON docs_documents;
DROP POLICY IF EXISTS docs_update ON docs_documents;
DROP POLICY IF EXISTS docs_delete ON docs_documents;
DROP POLICY IF EXISTS "company members can manage their docs" ON docs_documents;

CREATE POLICY docs_select ON docs_documents FOR SELECT USING (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  AND (visibility = 'company' OR owner_id IS NULL OR owner_id = auth.uid())
);

CREATE POLICY docs_insert ON docs_documents FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  AND (owner_id IS NULL OR owner_id = auth.uid())
);

CREATE POLICY docs_update ON docs_documents FOR UPDATE USING (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  AND (visibility = 'company' OR owner_id IS NULL OR owner_id = auth.uid())
) WITH CHECK (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  AND (visibility = 'company' OR owner_id = auth.uid())
);

-- Удалить: владелец; общий документ — также владелец/админ кабинета;
-- документы без владельца (старые) — любой участник, как и раньше.
CREATE POLICY docs_delete ON docs_documents FOR DELETE USING (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  AND (
    owner_id IS NULL OR owner_id = auth.uid()
    OR (visibility = 'company' AND company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin')))
  )
);

-- Владельца нельзя подменить, а доступ меняет только владелец.
-- Старый документ без владельца можно «забрать себе», сделав его личным.
CREATE OR REPLACE FUNCTION docs_documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_id IS NULL THEN NEW.owner_id := auth.uid(); END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    IF NOT (OLD.owner_id IS NULL AND NEW.owner_id = auth.uid()) THEN
      NEW.owner_id := OLD.owner_id;
    END IF;
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NEW.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Доступ к документу меняет только его владелец';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS docs_documents_guard ON docs_documents;
CREATE TRIGGER docs_documents_guard BEFORE INSERT OR UPDATE ON docs_documents
  FOR EACH ROW EXECUTE FUNCTION docs_documents_guard();

-- ── Недавние и открытые вкладки пользователя ─────────────────────────────
CREATE TABLE IF NOT EXISTS docs_recent (
  user_id    UUID    NOT NULL DEFAULT auth.uid(),
  company_id UUID    NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_id     TEXT    NOT NULL,
  opened_at  BIGINT  NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  is_open    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, doc_id)
);
CREATE INDEX IF NOT EXISTS docs_recent_user_company_idx ON docs_recent(user_id, company_id, opened_at DESC);

ALTER TABLE docs_recent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS docs_recent_own ON docs_recent;
CREATE POLICY docs_recent_own ON docs_recent FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON docs_recent TO authenticated;

-- Удалённый документ пропадает из «Недавних» у всех
CREATE OR REPLACE FUNCTION docs_recent_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM docs_recent WHERE doc_id = OLD.id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS docs_recent_cleanup ON docs_documents;
CREATE TRIGGER docs_recent_cleanup AFTER DELETE ON docs_documents
  FOR EACH ROW EXECUTE FUNCTION docs_recent_cleanup();

NOTIFY pgrst, 'reload schema';
