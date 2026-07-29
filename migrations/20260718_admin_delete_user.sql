-- ── Rebuild admin_get_users: include admin_role field ────────────────────────
CREATE OR REPLACE FUNCTION admin_get_users(p_search TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_result JSON;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT json_build_object(
    'total', (
      SELECT COUNT(*) FROM users
      WHERE p_search = '' OR
        LOWER(first_name || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(telegram_username,'')) LIKE LOWER('%' || p_search || '%')
    ),
    'users', (
      SELECT json_agg(row_to_json(u)) FROM (
        SELECT
          u.id, u.first_name, u.last_name, u.telegram_username, u.photo_url,
          u.created_at, u.last_login_at, u.banned_until,
          ut.ends_at AS trial_ends_at,
          (SELECT pa.role FROM platform_admins pa WHERE pa.user_id = u.id LIMIT 1) AS admin_role,
          (SELECT json_agg(json_build_object('company_id', cm.company_id, 'role', cm.role, 'name', c.name))
           FROM company_members cm JOIN companies c ON c.id = cm.company_id
           WHERE cm.user_id = u.id LIMIT 5) AS companies,
          (SELECT json_build_object('plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status)
           FROM user_subscriptions us WHERE us.user_id = u.id AND us.status = 'active' LIMIT 1) AS subscription,
          (SELECT COUNT(*) FROM company_members cm2 WHERE cm2.user_id = u.id) AS company_count
        FROM users u
        LEFT JOIN user_trials ut ON ut.user_id = u.id
        WHERE p_search = '' OR
          LOWER(u.first_name || ' ' || COALESCE(u.last_name,'') || ' ' || COALESCE(u.telegram_username,'')) LIKE LOWER('%' || p_search || '%')
        ORDER BY u.created_at DESC
        LIMIT p_limit OFFSET p_offset
      ) u
    )
  ) INTO v_result;
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_get_users(TEXT,INT,INT) TO authenticated;

-- ── admin_delete_user: hard-delete user and all app data ─────────────────────
CREATE OR REPLACE FUNCTION admin_delete_user(p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_is_superadmin BOOLEAN;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND OR v_admin.role NOT IN ('superadmin','admin') THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Prevent deleting the platform owner
  SELECT (role = 'superadmin') INTO v_is_superadmin
  FROM platform_admins WHERE user_id = p_user_id;
  IF v_is_superadmin IS TRUE THEN
    RAISE EXCEPTION 'Нельзя удалить создателя платформы';
  END IF;

  -- Revoke admin roles
  DELETE FROM platform_admins    WHERE user_id = p_user_id;
  -- Remove company memberships (does NOT delete their owned companies — admin_delete_company for that)
  DELETE FROM company_members    WHERE user_id = p_user_id;
  -- Remove subscriptions
  DELETE FROM user_subscriptions WHERE user_id = p_user_id;
  -- Remove support tickets
  DELETE FROM support_tickets    WHERE user_id = p_user_id;
  -- Remove the profile row
  DELETE FROM users              WHERE id = p_user_id;
  -- Note: auth.users entry is NOT deleted here (requires admin API call).
  -- The user can no longer log in because their profile is gone.
END;
$$;
GRANT EXECUTE ON FUNCTION admin_delete_user(UUID) TO authenticated;

-- ── site_content: editable page content managed from admin panel ──────────────
CREATE TABLE IF NOT EXISTS site_content (
  key         TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id)
);

-- Default keys
INSERT INTO site_content (key, title, content) VALUES
  ('privacy_policy',   'Политика конфиденциальности', ''),
  ('legal_requisites', 'Реквизиты и правовая информация', ''),
  ('offer',            'Публичная оферта', '')
ON CONFLICT (key) DO NOTHING;

-- RLS: anyone can read, only platform admins can write
ALTER TABLE site_content ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_content_read ON site_content;
DROP POLICY IF EXISTS site_content_write ON site_content;
CREATE POLICY site_content_read  ON site_content FOR SELECT USING (true);
CREATE POLICY site_content_write ON site_content FOR ALL
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()));

-- RPC: read all site content (public)
CREATE OR REPLACE FUNCTION get_site_content()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
    SELECT key, title, content, updated_at FROM site_content ORDER BY key
  ) c);
END;
$$;
GRANT EXECUTE ON FUNCTION get_site_content() TO anon, authenticated;

-- RPC: save site content (admin only)
CREATE OR REPLACE FUNCTION admin_save_site_content(p_key TEXT, p_title TEXT, p_content TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  INSERT INTO site_content (key, title, content, updated_at, updated_by)
  VALUES (p_key, p_title, p_content, now(), auth.uid())
  ON CONFLICT (key) DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    updated_at = now(),
    updated_by = auth.uid();
END;
$$;
GRANT EXECUTE ON FUNCTION admin_save_site_content(TEXT,TEXT,TEXT) TO authenticated;
