-- Migration: add YM and WB link fields to boxes table
-- Run in Supabase SQL editor: https://supabase.com/dashboard/project/rdqwzojrsmbdxiczqjci/sql

ALTER TABLE boxes
  ADD COLUMN IF NOT EXISTS ym_linked     BOOLEAN  DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ym_sku_field  TEXT     DEFAULT 'Артикул*',
  ADD COLUMN IF NOT EXISTS wb_linked     BOOLEAN  DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wb_sku_field  TEXT     DEFAULT 'Артикул*';

COMMENT ON COLUMN boxes.ym_linked    IS 'Яндекс Маркет: группа привязана к синхронизации';
COMMENT ON COLUMN boxes.ym_sku_field IS 'Яндекс Маркет: поле артикула для сверки';
COMMENT ON COLUMN boxes.wb_linked    IS 'WB: группа привязана к синхронизации';
COMMENT ON COLUMN boxes.wb_sku_field IS 'WB: поле артикула для сверки';
