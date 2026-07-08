-- Add type_id and description_category_id to ozon_products
-- Required for /v3/product/import fallback when saving product card dimensions/attributes

ALTER TABLE ozon_products
  ADD COLUMN IF NOT EXISTS type_id                 integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS description_category_id integer DEFAULT NULL;
