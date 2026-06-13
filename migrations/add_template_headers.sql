-- Миграция: добавление поля для сохранения оригинальных заголовков шаблонов
-- Запустите этот SQL-код в редактоre SQL Supabase (SQL Editor)

ALTER TABLE sheets
  ADD COLUMN IF NOT EXISTS template_headers JSONB DEFAULT NULL;

COMMENT ON COLUMN sheets.template_headers IS 'Сохраненные верхние строки (метаданные) оригинального шаблона, используемые для точного обратного экспорта.';
