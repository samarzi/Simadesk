-- FBS warehouse ID for Yandex stores (fallback when /warehouses API returns empty)
ALTER TABLE yandex_stores ADD COLUMN IF NOT EXISTS fbs_warehouse_id BIGINT;
