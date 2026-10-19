BEGIN;

-- Добавляем GIN индекс для поиска по details (reference_id, match_score, search_sources)
CREATE INDEX IF NOT EXISTS ip_audit_findings_details_gin ON public.ip_audit_findings USING gin (details);

NOTIFY pgrst, 'reload schema';
COMMIT;
