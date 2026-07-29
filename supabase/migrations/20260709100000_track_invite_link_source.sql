-- Track which invite link a member used to join
ALTER TABLE company_members
  ADD COLUMN IF NOT EXISTS joined_via_link_id uuid REFERENCES company_invite_links(id) ON DELETE SET NULL;

-- Update claim_invite_link to record the source link
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

  INSERT INTO company_members (company_id, user_id, role, joined_via_link_id)
  VALUES (v_link.company_id, v_uid, v_link.role, v_link.id)
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
