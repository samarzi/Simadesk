-- Добавляем колонки налогового режима во все таблицы магазинов
ALTER TABLE wb_stores ADD COLUMN IF NOT EXISTS tax_rate numeric DEFAULT NULL;
ALTER TABLE wb_stores ADD COLUMN IF NOT EXISTS tax_model text DEFAULT NULL;

ALTER TABLE ozon_stores ADD COLUMN IF NOT EXISTS tax_rate numeric DEFAULT NULL;
ALTER TABLE ozon_stores ADD COLUMN IF NOT EXISTS tax_model text DEFAULT NULL;

ALTER TABLE yandex_stores ADD COLUMN IF NOT EXISTS tax_rate numeric DEFAULT NULL;
ALTER TABLE yandex_stores ADD COLUMN IF NOT EXISTS tax_model text DEFAULT NULL;
