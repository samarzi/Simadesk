-- Add dimension columns to all three product tables
-- These are populated during catalog/product sync from marketplace APIs

ALTER TABLE ozon_products
  ADD COLUMN IF NOT EXISTS weight_kg numeric(10,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS length_cm numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS width_cm  numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS height_cm numeric(10,1) DEFAULT NULL;

ALTER TABLE wb_products
  ADD COLUMN IF NOT EXISTS weight_kg numeric(10,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS length_cm numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS width_cm  numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS height_cm numeric(10,1) DEFAULT NULL;

ALTER TABLE yandex_products
  ADD COLUMN IF NOT EXISTS weight_kg numeric(10,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS length_cm numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS width_cm  numeric(10,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS height_cm numeric(10,1) DEFAULT NULL;
