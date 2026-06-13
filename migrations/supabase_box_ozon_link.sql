-- Migration: add Ozon link fields to boxes table
-- Run this in Supabase SQL editor

ALTER TABLE boxes
  ADD COLUMN IF NOT EXISTS ozon_store_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ozon_sku_field TEXT DEFAULT 'Артикул*';

-- Index for fast lookup of linked boxes
CREATE INDEX IF NOT EXISTS idx_boxes_ozon_store_id ON boxes(ozon_store_id)
  WHERE ozon_store_id IS NOT NULL;

COMMENT ON COLUMN boxes.ozon_store_id IS 'ID магазина Ozon (ozon_stores.id) к которому привязана группа';
COMMENT ON COLUMN boxes.ozon_sku_field IS 'Поле артикула для сверки товаров при связке с Ozon';
