-- Invite links: join a company via a shareable URL token

CREATE TABLE IF NOT EXISTS company_invite_links (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'manager'
                          CHECK (role IN ('admin', 'manager', 'viewer')),
  token       text        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz,
  max_uses    integer,
  use_count   integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_invite_links_token      ON company_invite_links(token);
CREATE INDEX IF NOT EXISTS idx_invite_links_company_id ON company_invite_links(company_id);

ALTER TABLE company_invite_links ENABLE ROW LEVEL SECURITY;

-- Owners/admins can view and manage invite links for their companies
CREATE POLICY "invite_links_manage" ON company_invite_links
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- RPC function: authenticated user claims an invite link and joins the company
CREATE OR REPLACE FUNCTION claim_invite_link(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link  company_invite_links%ROWTYPE;
  v_uid   uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  SELECT * INTO v_link
  FROM company_invite_links
  WHERE token = p_token AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_link');
  END IF;

  IF v_link.expires_at IS NOT NULL AND v_link.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'link_expired');
  END IF;

  IF v_link.max_uses IS NOT NULL AND v_link.use_count >= v_link.max_uses THEN
    RETURN jsonb_build_object('error', 'link_exhausted');
  END IF;

  -- Add user to company; ignore if already a member
  INSERT INTO company_members (company_id, user_id, role)
  VALUES (v_link.company_id, v_uid, v_link.role)
  ON CONFLICT (company_id, user_id) DO NOTHING;

  UPDATE company_invite_links
  SET use_count = use_count + 1
  WHERE id = v_link.id;

  RETURN jsonb_build_object(
    'success',    true,
    'company_id', v_link.company_id,
    'role',       v_link.role
  );
END;
$$;
