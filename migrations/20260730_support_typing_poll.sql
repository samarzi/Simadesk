-- ═══════════════════════════════════════════════════════════════════════════════
-- ПОДДЕРЖКА: индикатор «собеседник печатает» + единый опрос чата.
--
-- ЗАЧЕМ:
--   1. Раньше клиент делал два запроса (сообщения + статус чата), причём статус
--      проверялся раз в 5 циклов. Из-за этого закрытие диалога и новые ответы
--      расходились во времени, а ошибка любого из запросов гасилась молча.
--      support_poll() отдаёт всё за один вызов: сообщения, статус, печатает ли
--      собеседник.
--   2. Индикатор набора нужен и для живого оператора, и для AI-ответчика
--      (он работает в браузере админа, поэтому «печатает» приходится передавать
--      через базу, а не локально).
--
-- ЗАПУСК: применяется автоматически через scripts/deploy.sh.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS support_typing (
  chat_id    uuid NOT NULL REFERENCES support_chats(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'admin')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, role)
);

-- ── Отметить «я печатаю» ──────────────────────────────────────────────────────
-- Роль определяется сервером по auth.uid(), клиент её не выбирает.

CREATE OR REPLACE FUNCTION support_set_typing(p_chat_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid()) THEN
    v_role := 'user';
  ELSIF EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    v_role := 'admin';
  ELSE
    RETURN;
  END IF;

  INSERT INTO support_typing (chat_id, role, updated_at)
  VALUES (p_chat_id, v_role, now())
  ON CONFLICT (chat_id, role) DO UPDATE SET updated_at = now();
END;
$$;

-- ── Снять отметку (сообщение отправлено / поле очищено) ───────────────────────

CREATE OR REPLACE FUNCTION support_clear_typing(p_chat_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid()) THEN
    v_role := 'user';
  ELSIF EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid()) THEN
    v_role := 'admin';
  ELSE
    RETURN;
  END IF;

  DELETE FROM support_typing WHERE chat_id = p_chat_id AND role = v_role;
END;
$$;

-- ── Единый опрос ──────────────────────────────────────────────────────────────
-- Возвращает: новые сообщения после p_after, статус чата и печатает ли
-- собеседник (отметка свежее 6 секунд — дольше держать нельзя, иначе индикатор
-- «залипает», если вкладка собеседника закрылась).

CREATE OR REPLACE FUNCTION support_poll(p_chat_id uuid, p_after timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_is_owner boolean;
  v_is_admin boolean;
  v_my_role  text;
  v_status   text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM support_chats WHERE id = p_chat_id AND user_id = auth.uid())
    INTO v_is_owner;
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid())
    INTO v_is_admin;

  IF NOT v_is_owner AND NOT v_is_admin THEN
    RAISE EXCEPTION 'Нет доступа к этому чату';
  END IF;

  v_my_role := CASE WHEN v_is_owner THEN 'user' ELSE 'admin' END;

  SELECT status INTO v_status FROM support_chats WHERE id = p_chat_id;

  RETURN jsonb_build_object(
    -- NULL статус = чат удалён/завершён оператором (он удаляет строку)
    'status', COALESCE(v_status, 'closed'),
    'peer_typing', EXISTS (
      SELECT 1 FROM support_typing t
      WHERE t.chat_id = p_chat_id
        AND t.role <> v_my_role
        AND t.updated_at > now() - interval '6 seconds'
    ),
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_role', m.sender_role, 'content', m.content,
        'attachments', m.attachments, 'created_at', m.created_at
      ) ORDER BY m.created_at)
      FROM support_chat_messages m
      WHERE m.chat_id = p_chat_id AND (p_after IS NULL OR m.created_at > p_after)
    ), '[]'::jsonb)
  );
END;
$$;

-- Отправка сообщения снимает собственную отметку набора
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

  DELETE FROM support_typing WHERE chat_id = p_chat_id AND role = 'user';

  RETURN jsonb_build_object('id', v_id, 'created_at', v_created);
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

  DELETE FROM support_typing WHERE chat_id = p_chat_id AND role = 'admin';

  RETURN jsonb_build_object('id', v_id, 'created_at', v_created);
END;
$$;

GRANT EXECUTE ON FUNCTION support_set_typing(uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION support_clear_typing(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION support_poll(uuid, timestamptz)     TO authenticated;
