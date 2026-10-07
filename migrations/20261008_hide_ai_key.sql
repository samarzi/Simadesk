-- Безопасность: ключ OpenRouter компании больше не уходит в браузер.
-- get_site_content() была открыта даже без входа (anon) и отдавала все записи
-- site_content, включая ai_openrouter_key, — любой мог забрать ключ.
-- Теперь секретные записи видят только администраторы платформы.
-- Имя файла позже 20260718_admin_delete_user.sql: deploy.sh применяет все миграции
-- по порядку, и эта должна идти последней, чтобы перекрыть старое определение.
CREATE OR REPLACE FUNCTION get_site_content()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN (SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json) FROM (
    SELECT key, title, content, updated_at FROM site_content
    WHERE key NOT IN ('ai_openrouter_key')
       OR EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid())
    ORDER BY key
  ) c);
END;
$$;
GRANT EXECUTE ON FUNCTION get_site_content() TO anon, authenticated;
