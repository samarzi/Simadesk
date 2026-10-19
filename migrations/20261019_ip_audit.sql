BEGIN;

-- Product descriptions are returned by the existing marketplace synchronizers.
ALTER TABLE public.wb_products ADD COLUMN IF NOT EXISTS description text DEFAULT '';
ALTER TABLE public.ozon_products ADD COLUMN IF NOT EXISTS description text DEFAULT '';
ALTER TABLE public.yandex_products ADD COLUMN IF NOT EXISTS description text DEFAULT '';

CREATE TABLE IF NOT EXISTS public.ip_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','completed','failed')),
  scope text NOT NULL DEFAULT 'sample',
  product_keys text[] NOT NULL DEFAULT '{}',
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  prompt_version text NOT NULL DEFAULT 'ip-audit-v1'
);
ALTER TABLE public.ip_audit_runs ADD COLUMN IF NOT EXISTS product_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.ip_audit_runs ADD COLUMN IF NOT EXISTS model_id text NOT NULL DEFAULT 'openai/gpt-4o-mini';
CREATE INDEX IF NOT EXISTS ip_audit_runs_company_idx ON public.ip_audit_runs(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ip_audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.ip_audit_runs(id) ON DELETE CASCADE,
  marketplace text NOT NULL CHECK (marketplace IN ('wb','ozon','yandex')),
  store_id uuid NOT NULL,
  product_id text NOT NULL,
  vendor_code text NOT NULL DEFAULT '',
  product_name text NOT NULL DEFAULT '',
  product_brand text NOT NULL DEFAULT '',
  product_description text NOT NULL DEFAULT '',
  product_url text,
  photo_url text,
  photo_index integer NOT NULL DEFAULT -1,
  fingerprint text NOT NULL,
  risk text NOT NULL DEFAULT 'insufficient' CHECK (risk IN ('high','medium','low','none','insufficient')),
  object_type text NOT NULL DEFAULT '',
  object_name text NOT NULL DEFAULT '',
  rights_holder text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  confidence numeric,
  detected_text text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','needs_review','object_confirmed','not_confirmed','permitted','needs_documents','closed')),
  review_comment text NOT NULL DEFAULT '',
  evidence_url text NOT NULL DEFAULT '',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, marketplace, store_id, product_id, photo_index)
);
-- Добавляем индекс для быстрого поиска по reference_id в details
CREATE INDEX IF NOT EXISTS ip_audit_findings_details_gin ON public.ip_audit_findings USING gin (details);
CREATE INDEX IF NOT EXISTS ip_audit_findings_company_idx ON public.ip_audit_findings(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ip_audit_findings_run_idx ON public.ip_audit_findings(run_id);

CREATE TABLE IF NOT EXISTS public.ip_audit_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  rights_holder text NOT NULL DEFAULT '',
  object_type text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ip_audit_references_company_idx ON public.ip_audit_references(company_id);

ALTER TABLE public.ip_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_audit_references ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ip_audit_runs_company ON public.ip_audit_runs;
CREATE POLICY ip_audit_runs_company ON public.ip_audit_runs FOR ALL TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS ip_audit_findings_company ON public.ip_audit_findings;
CREATE POLICY ip_audit_findings_company ON public.ip_audit_findings FOR ALL TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids())
    AND EXISTS (SELECT 1 FROM public.ip_audit_runs r WHERE r.id = run_id AND r.company_id = ip_audit_findings.company_id));
DROP POLICY IF EXISTS ip_audit_references_company ON public.ip_audit_references;
CREATE POLICY ip_audit_references_company ON public.ip_audit_references FOR ALL TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT, INSERT, UPDATE ON public.ip_audit_runs, public.ip_audit_findings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ip_audit_references TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
