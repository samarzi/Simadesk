BEGIN;

-- Здесь нет содержимого документа: только идентификатор, чтобы старый
-- браузер с несохранённой вкладкой не создал удалённый документ заново.
CREATE TABLE IF NOT EXISTS public.docs_deleted_ids (
  id TEXT PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.docs_deleted_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.docs_deleted_ids FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.docs_permanent_delete_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.docs_deleted_ids(id, company_id) VALUES (OLD.id, OLD.company_id)
    ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.docs_recent WHERE doc_id = OLD.id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.docs_permanent_delete_cleanup() FROM PUBLIC;
DROP TRIGGER IF EXISTS docs_permanent_delete_cleanup ON public.docs_documents;
CREATE TRIGGER docs_permanent_delete_cleanup AFTER DELETE ON public.docs_documents
  FOR EACH ROW EXECUTE FUNCTION public.docs_permanent_delete_cleanup();

CREATE OR REPLACE FUNCTION public.docs_reject_deleted_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.docs_deleted_ids WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'Документ уже удалён навсегда' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.docs_reject_deleted_id() FROM PUBLIC;
DROP TRIGGER IF EXISTS docs_reject_deleted_id ON public.docs_documents;
CREATE TRIGGER docs_reject_deleted_id BEFORE INSERT ON public.docs_documents
  FOR EACH ROW EXECUTE FUNCTION public.docs_reject_deleted_id();

-- Вызывается с правами пользователя: существующая RLS разрешает удаление
-- владельцу документа и администраторам кабинета для общих документов.
CREATE OR REPLACE FUNCTION public.docs_delete_permanently(p_id TEXT, p_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE removed_id TEXT;
BEGIN
  DELETE FROM public.docs_documents WHERE id = p_id AND company_id = p_company_id
    RETURNING id INTO removed_id;
  IF removed_id IS NULL THEN
    RAISE EXCEPTION 'Документ не найден или у вас нет права его удалить' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('deleted', true);
END $$;
REVOKE ALL ON FUNCTION public.docs_delete_permanently(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.docs_delete_permanently(TEXT, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
