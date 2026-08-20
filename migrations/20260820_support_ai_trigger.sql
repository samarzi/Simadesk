-- Серверный AI для поддержки: вызывает Edge Function при каждом сообщении от клиента.
-- Это позволяет AI отвечать без открытой вкладки админ-панели.
--
-- Требует pg_net (уже установлен для MRC-сканера).

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Функция-триггер: вызывает support-ai edge function при INSERT пользовательского сообщения.
CREATE OR REPLACE FUNCTION public.notify_support_ai()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  IF NEW.sender_role = 'user' THEN
    PERFORM net.http_post(
      url     := 'http://nginx:80/functions/v1/support-ai',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkcXd6b2pyc21iZHhpY3pxamNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0OTAwNjEsImV4cCI6MjA5MzA2NjA2MX0.lw9aXynPfMo0hy6J_E3BBlqd6W4MTIVM3BrVdjkBaNE'
      ),
      body    := jsonb_build_object('chat_id', NEW.chat_id::text)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Привязываем триггер к таблице сообщений поддержки.
DROP TRIGGER IF EXISTS support_ai_trigger ON public.support_chat_messages;
CREATE TRIGGER support_ai_trigger
  AFTER INSERT ON public.support_chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_support_ai();
