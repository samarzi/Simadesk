-- Migration: add legal_name to companies
-- Разделяет "рабочее название" и "юридическое название"
-- Запустить в Supabase SQL Editor если таблица companies уже создана

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS legal_name TEXT DEFAULT NULL;

COMMENT ON COLUMN companies.name       IS 'Рабочее название (любое удобное, не обязательно юридическое)';
COMMENT ON COLUMN companies.legal_name IS 'Юридическое название (ООО Ромашка / ИП Иванов и т.д.)';
