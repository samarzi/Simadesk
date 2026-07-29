-- RPC function to send Telegram notifications
-- Called from frontend when events happen (new order, low stock, bad review)

CREATE OR REPLACE FUNCTION tg_send_notification(
  p_event TEXT,
  p_company_id UUID,
  p_data JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chat RECORD;
  v_settings RECORD;
  v_text TEXT;
  v_bot_token TEXT;
BEGIN
  -- Get bot token from env (set via docker-compose)
  v_bot_token := current_setting('app.settings.bot_token', true);

  -- If not set in postgres settings, try to get from environment
  IF v_bot_token IS NULL OR v_bot_token = '' THEN
    RAISE NOTICE 'BOT_TOKEN not configured in postgres settings';
    RETURN;
  END IF;

  -- Find all chats for this company
  FOR v_chat IN
    SELECT tc.chat_id, tc.user_id
    FROM tg_chats tc
    WHERE tc.company_id = p_company_id
  LOOP
    -- Check user's notification settings
    SELECT * INTO v_settings
    FROM tg_notification_settings
    WHERE user_id = v_chat.user_id AND company_id = p_company_id;

    -- Skip if settings not found or notifications disabled
    IF v_settings IS NULL THEN CONTINUE; END IF;

    -- Build message based on event type
    v_text := NULL;

    IF p_event = 'new_order' AND v_settings.notify_new_order THEN
      v_text := '📦 <b>Новый заказ!</b>' || E'\n\n'
        || 'Товар: ' || COALESCE(p_data->>'product', '—') || E'\n'
        || 'МП: ' || UPPER(COALESCE(p_data->>'marketplace', '?')) || E'\n'
        || 'Сумма: ' || COALESCE(p_data->>'amount', '—') || ' ₽';

    ELSIF p_event = 'low_stock' AND v_settings.notify_low_stock THEN
      v_text := '⚠️ <b>Низкий остаток!</b>' || E'\n\n'
        || 'Товар: ' || COALESCE(p_data->>'name', '—') || E'\n'
        || 'Остаток: ' || COALESCE(p_data->>'stock', '?') || ' шт.' || E'\n'
        || 'МП: ' || UPPER(COALESCE(p_data->>'marketplace', '?'));

    ELSIF p_event = 'bad_review' AND v_settings.notify_bad_review THEN
      v_text := '⭐ <b>Плохой отзыв!</b>' || E'\n\n'
        || 'Товар: ' || COALESCE(p_data->>'product', '—') || E'\n'
        || 'Рейтинг: ' || COALESCE(p_data->>'rating', '?') || '★' || E'\n'
        || 'Автор: ' || COALESCE(p_data->>'author', '—') || E'\n'
        || 'Текст: ' || LEFT(COALESCE(p_data->>'text', '—'), 200);

    END IF;

    -- Send if we have text
    IF v_text IS NOT NULL AND v_text != '' THEN
      PERFORM net.http_post(
        url := 'https://api.telegram.org/bot' || v_bot_token || '/sendMessage',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := json_build_object(
          'chat_id', v_chat.chat_id,
          'text', v_text,
          'parse_mode', 'HTML'
        )::text
      );
    END IF;
  END LOOP;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION tg_send_notification TO authenticated;
