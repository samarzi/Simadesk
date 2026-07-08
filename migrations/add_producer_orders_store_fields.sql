-- Add store/scheme/mp_status fields to producer_orders
ALTER TABLE producer_orders
  ADD COLUMN IF NOT EXISTS store_id   text,
  ADD COLUMN IF NOT EXISTS store_name text,
  ADD COLUMN IF NOT EXISTS scheme     text,
  ADD COLUMN IF NOT EXISTS mp_status  text;
