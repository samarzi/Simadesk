-- Live support chat tables
CREATE TABLE IF NOT EXISTS support_chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason      text NOT NULL DEFAULT 'question',
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS support_chats_user_id_idx   ON support_chats(user_id);
CREATE INDEX IF NOT EXISTS support_chats_status_idx    ON support_chats(status);
CREATE INDEX IF NOT EXISTS support_chats_created_idx   ON support_chats(created_at DESC);

CREATE TABLE IF NOT EXISTS support_chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL REFERENCES support_chats(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('user', 'admin')),
  content     text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_chat_msgs_chat_created_idx ON support_chat_messages(chat_id, created_at);

-- ── User RPCs ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_support_chat(p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_chat_id uuid; v_company_id uuid;
BEGIN
  SELECT id INTO v_company_id FROM companies WHERE created_by = auth.uid() ORDER BY created_at LIMIT 1;
  -- Close any existing open chats for this user
  UPDATE support_chats SET status = 'closed', closed_at = now()
  WHERE user_id = auth.uid() AND status = 'open';
  INSERT INTO support_chats (company_id, user_id, reason)
  VALUES (v_company_id, auth.uid(), p_reason)
  RETURNING id INTO v_chat_id;
  RETURN to_jsonb(v_chat_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION get_my_support_chat()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_chat_id uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_chat_id FROM support_chats
  WHERE user_id = auth.uid() AND status = 'open'
  ORDER BY created_at DESC LIMIT 1;
  IF v_chat_id IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
    'id', c.id, 'reason', c.reason, 'status', c.status, 'created_at', c.created_at,
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_role', m.sender_role, 'content', m.content,
        'attachments', m.attachments, 'created_at', m.created_at
      ) ORDER BY m.created_at)
      FROM support_chat_messages m WHERE m.chat_id = c.id
    ), '[]'::jsonb)
  ) INTO v_result FROM support_chats c WHERE c.id = v_chat_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION send_support_message(p_chat_id uuid, p_content text, p_attachments jsonb DEFAULT '[]')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid() AND status = 'open') THEN
    RAISE EXCEPTION 'Chat not found or closed';
  END IF;
  INSERT INTO support_chat_messages (chat_id, sender_role, content, attachments)
  VALUES (p_chat_id, 'user', p_content, p_attachments);
END;
$$;

CREATE OR REPLACE FUNCTION get_support_messages_since(p_chat_id uuid, p_after timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid())
    AND NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'sender_role', m.sender_role, 'content', m.content,
      'attachments', m.attachments, 'created_at', m.created_at
    ) ORDER BY m.created_at)
    FROM support_chat_messages m
    WHERE m.chat_id = p_chat_id AND (p_after IS NULL OR m.created_at > p_after)
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION close_my_support_chat(p_chat_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE support_chats SET status = 'closed', closed_at = now()
  WHERE id = p_chat_id AND user_id = auth.uid();
END;
$$;

-- ── Admin RPCs ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_get_support_chats(p_status text DEFAULT 'open')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', c.id, 'reason', c.reason, 'status', c.status,
      'created_at', c.created_at, 'closed_at', c.closed_at,
      'first_name', u.first_name, 'last_name', u.last_name,
      'telegram_username', u.telegram_username,
      'company_name', comp.name,
      'last_message', (SELECT content FROM support_chat_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1),
      'last_message_role', (SELECT sender_role FROM support_chat_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1),
      'last_message_at', (SELECT created_at FROM support_chat_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1),
      'unread_count', (
        SELECT COUNT(*) FROM support_chat_messages
        WHERE chat_id = c.id AND sender_role = 'user'
          AND created_at > COALESCE((
            SELECT MAX(created_at) FROM support_chat_messages WHERE chat_id = c.id AND sender_role = 'admin'
          ), '2000-01-01'::timestamptz)
      )
    ) ORDER BY COALESCE((SELECT MAX(created_at) FROM support_chat_messages WHERE chat_id = c.id), c.created_at) DESC)
    FROM support_chats c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN companies comp ON comp.id = c.company_id
    WHERE p_status = 'all' OR c.status = p_status
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION admin_get_support_chat(p_chat_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  SELECT jsonb_build_object(
    'id', c.id, 'reason', c.reason, 'status', c.status, 'created_at', c.created_at,
    'first_name', u.first_name, 'last_name', u.last_name,
    'telegram_username', u.telegram_username, 'company_name', comp.name,
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_role', m.sender_role, 'content', m.content,
        'attachments', m.attachments, 'created_at', m.created_at
      ) ORDER BY m.created_at)
      FROM support_chat_messages m WHERE m.chat_id = c.id
    ), '[]'::jsonb)
  ) INTO v_result FROM support_chats c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN companies comp ON comp.id = c.company_id
  WHERE c.id = p_chat_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION admin_send_support_message(p_chat_id uuid, p_content text, p_attachments jsonb DEFAULT '[]')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  INSERT INTO support_chat_messages (chat_id, sender_role, content, attachments)
  VALUES (p_chat_id, 'admin', p_content, p_attachments);
END;
$$;

CREATE OR REPLACE FUNCTION admin_close_support_chat(p_chat_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  DELETE FROM support_chat_messages WHERE chat_id = p_chat_id;
  DELETE FROM support_chats WHERE id = p_chat_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_support_chat(text)                         TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_support_chat()                             TO authenticated;
GRANT EXECUTE ON FUNCTION send_support_message(uuid, text, jsonb)           TO authenticated;
GRANT EXECUTE ON FUNCTION get_support_messages_since(uuid, timestamptz)     TO authenticated;
GRANT EXECUTE ON FUNCTION close_my_support_chat(uuid)                       TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_support_chats(text)                     TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_support_chat(uuid)                      TO authenticated;
GRANT EXECUTE ON FUNCTION admin_send_support_message(uuid, text, jsonb)     TO authenticated;
GRANT EXECUTE ON FUNCTION admin_close_support_chat(uuid)                    TO authenticated;
