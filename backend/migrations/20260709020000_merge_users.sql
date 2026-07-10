-- Merge secondary user account into primary.
-- Moves all company memberships, created companies, and invitation records.
-- Must be called from an admin context (edge function with service role).
CREATE OR REPLACE FUNCTION public.merge_users(p_primary_id uuid, p_secondary_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF p_primary_id = p_secondary_id THEN
    RETURN;
  END IF;

  -- Transfer company memberships (skip if primary already member of same company)
  INSERT INTO company_members (company_id, user_id, role, joined_at, joined_via_link_id)
  SELECT company_id, p_primary_id, role, joined_at, joined_via_link_id
  FROM company_members
  WHERE user_id = p_secondary_id
  ON CONFLICT (company_id, user_id) DO NOTHING;

  DELETE FROM company_members WHERE user_id = p_secondary_id;

  -- Transfer company ownership
  UPDATE companies SET created_by = p_primary_id WHERE created_by = p_secondary_id;

  -- Transfer invitation references
  UPDATE company_invitations SET invited_by = p_primary_id WHERE invited_by = p_secondary_id;
  UPDATE company_invitations SET used_by   = p_primary_id WHERE used_by   = p_secondary_id;

  -- Copy yandex_id to primary if not already set
  UPDATE users
  SET yandex_id = (SELECT yandex_id FROM users WHERE id = p_secondary_id)
  WHERE id = p_primary_id AND yandex_id IS NULL;

  -- Copy telegram_id/username to primary if not already set
  UPDATE users
  SET telegram_id       = (SELECT telegram_id       FROM users WHERE id = p_secondary_id),
      telegram_username = (SELECT telegram_username FROM users WHERE id = p_secondary_id)
  WHERE id = p_primary_id AND telegram_id IS NULL;

  -- Remove secondary profile
  DELETE FROM users WHERE id = p_secondary_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_users(uuid, uuid) TO service_role;
