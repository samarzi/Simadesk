-- ═══════════════════════════════════════════════════════════════════════════════
-- ПОДДЕРЖКА: полное пересоздание RPC живого чата (идемпотентно).
--
-- ЗАЧЕМ: в базе могли остаться старые версии функций, которые ссылались на
-- несуществующую таблицу admin_users. Такая функция падает с ошибкой
-- 'relation "admin_users" does not exist', клиент ловит ошибку молча — и админка
-- показывает «Нет чатов», хотя сообщения пользователей лежат в базе.
--
-- ЧТО ИСПРАВЛЕНО:
--   1. Все проверки прав — через platform_admins (реальная таблица админов).
--   2. JOIN users → LEFT JOIN users. Раньше чат пользователя, у которого нет
--      строки в public.users (вход не через Telegram/Яндекс, удалённый профиль),
--      просто не попадал в список админки — сообщения «пропадали».
--   3. Имя пользователя всегда непустое (COALESCE), чтобы админка не падала.
--   4. Добавлена support_debug_status() — быстрая диагностика из UI/SQL.
--
-- ЗАПУСК: Supabase → SQL Editor → New query → вставить целиком → Run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Таблицы (на случай, если базовая миграция не применялась) ─────────────────

CREATE TABLE IF NOT EXISTS support_chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason      text NOT NULL DEFAULT 'question',
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS support_chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL REFERENCES support_chats(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('user', 'admin')),
  content     text NOT NULL DEFAULT '',
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_chats_user_id_idx        ON support_chats(user_id);
CREATE INDEX IF NOT EXISTS support_chats_status_idx         ON support_chats(status);
CREATE INDEX IF NOT EXISTS support_chats_created_idx        ON support_chats(created_at DESC);
CREATE INDEX IF NOT EXISTS support_chat_msgs_chat_created_idx ON support_chat_messages(chat_id, created_at);

-- ── Снос старых версий ────────────────────────────────────────────────────────
-- У send_support_message / admin_send_support_message меняется тип возврата
-- (void → jsonb, чтобы клиент получал id и время вставленного сообщения).
-- CREATE OR REPLACE такого не умеет — сначала удаляем.

DROP FUNCTION IF EXISTS send_support_message(uuid, text, jsonb);
DROP FUNCTION IF EXISTS admin_send_support_message(uuid, text, jsonb);
DROP FUNCTION IF EXISTS create_support_chat(text);

-- ── Пользовательские RPC ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_support_chat(p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_chat_id uuid; v_company_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Не авторизован'; END IF;

  SELECT id INTO v_company_id FROM companies WHERE created_by = auth.uid() ORDER BY created_at LIMIT 1;

  UPDATE support_chats SET status = 'closed', closed_at = now()
  WHERE user_id = auth.uid() AND status = 'open';

  INSERT INTO support_chats (company_id, user_id, reason)
  VALUES (v_company_id, auth.uid(), COALESCE(NULLIF(p_reason, ''), 'question'))
  RETURNING id INTO v_chat_id;

  RETURN to_jsonb(v_chat_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION get_my_support_chat()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text; v_owner uuid; v_id uuid; v_created timestamptz;
BEGIN
  SELECT status, user_id INTO v_status, v_owner FROM support_chats WHERE id = p_chat_id;

  IF v_status IS NULL THEN RAISE EXCEPTION 'Чат не найден'; END IF;
  IF v_owner <> auth.uid() THEN RAISE EXCEPTION 'Нет доступа к этому чату'; END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'Диалог уже завершён'; END IF;

  INSERT INTO support_chat_messages (chat_id, sender_role, content, attachments)
  VALUES (p_chat_id, 'user', COALESCE(p_content, ''), COALESCE(p_attachments, '[]'::jsonb))
  RETURNING id, created_at INTO v_id, v_created;

  RETURN jsonb_build_object('id', v_id, 'created_at', v_created);
END;
$$;

CREATE OR REPLACE FUNCTION get_support_messages_since(p_chat_id uuid, p_after timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid())
    AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Нет доступа к этому чату';
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
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE support_chats SET status = 'closed', closed_at = now()
  WHERE id = p_chat_id AND user_id = auth.uid();
END;
$$;

-- ── Админские RPC ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_get_support_chats(p_status text DEFAULT 'open')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Нет прав администратора';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', c.id, 'reason', c.reason, 'status', c.status,
      'created_at', c.created_at, 'closed_at', c.closed_at,
      -- LEFT JOIN: чат обязан быть виден даже без профиля в public.users
      'first_name', COALESCE(NULLIF(u.first_name, ''), 'Пользователь'),
      'last_name', u.last_name,
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
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN companies comp ON comp.id = c.company_id
    WHERE p_status = 'all' OR c.status = p_status
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION admin_get_support_chat(p_chat_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Нет прав администратора';
  END IF;

  SELECT jsonb_build_object(
    'id', c.id, 'reason', c.reason, 'status', c.status, 'created_at', c.created_at,
    'first_name', COALESCE(NULLIF(u.first_name, ''), 'Пользователь'),
    'last_name', u.last_name,
    'telegram_username', u.telegram_username, 'company_name', comp.name,
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_role', m.sender_role, 'content', m.content,
        'attachments', m.attachments, 'created_at', m.created_at
      ) ORDER BY m.created_at)
      FROM support_chat_messages m WHERE m.chat_id = c.id
    ), '[]'::jsonb)
  ) INTO v_result FROM support_chats c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN companies comp ON comp.id = c.company_id
  WHERE c.id = p_chat_id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION admin_send_support_message(p_chat_id uuid, p_content text, p_attachments jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_created timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Нет прав администратора';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id) THEN
    RAISE EXCEPTION 'Чат не найден';
  END IF;

  INSERT INTO support_chat_messages (chat_id, sender_role, content, attachments)
  VALUES (p_chat_id, 'admin', COALESCE(p_content, ''), COALESCE(p_attachments, '[]'::jsonb))
  RETURNING id, created_at INTO v_id, v_created;

  RETURN jsonb_build_object('id', v_id, 'created_at', v_created);
END;
$$;

CREATE OR REPLACE FUNCTION admin_close_support_chat(p_chat_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Нет прав администратора';
  END IF;
  DELETE FROM support_chat_messages WHERE chat_id = p_chat_id;
  DELETE FROM support_chats WHERE id = p_chat_id;
END;
$$;

-- ── Диагностика ───────────────────────────────────────────────────────────────
-- Возвращает: админ ли текущий пользователь, сколько всего чатов и сообщений.
-- Помогает за секунду понять «сообщения не дошли» или «админка их не видит».

CREATE OR REPLACE FUNCTION support_debug_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN jsonb_build_object(
    'uid', auth.uid(),
    'is_admin', EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()),
    'my_open_chats', (SELECT COUNT(*) FROM support_chats WHERE user_id = auth.uid() AND status = 'open'),
    'total_chats', (SELECT COUNT(*) FROM support_chats),
    'total_open_chats', (SELECT COUNT(*) FROM support_chats WHERE status = 'open'),
    'total_messages', (SELECT COUNT(*) FROM support_chat_messages),
    'orphan_chats', (SELECT COUNT(*) FROM support_chats c WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id))
  );
END;
$$;

-- ── Права ─────────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION create_support_chat(text)                     TO authenticated;
GRANT EXECUTE ON FUNCTION send_support_message(uuid, text, jsonb)       TO authenticated;
GRANT EXECUTE ON FUNCTION admin_send_support_message(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_support_chat()                         TO authenticated;
GRANT EXECUTE ON FUNCTION get_support_messages_since(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION close_my_support_chat(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_support_chats(text)                 TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_support_chat(uuid)                  TO authenticated;
GRANT EXECUTE ON FUNCTION admin_close_support_chat(uuid)                TO authenticated;
GRANT EXECUTE ON FUNCTION support_debug_status()                        TO authenticated;
