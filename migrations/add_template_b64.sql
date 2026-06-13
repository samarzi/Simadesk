-- Миграция для сохранения бинарного шаблона Ozon в Base64
ALTER TABLE sheets
  ADD COLUMN IF NOT EXISTS template_file_b64 TEXT DEFAULT NULL;

COMMENT ON COLUMN sheets.template_file_b64 IS 'Сохраненный оригинальный бинарный файл шаблона в формате Base64, для экспорта со 100% сохранением стилей (ExcelJS).';
