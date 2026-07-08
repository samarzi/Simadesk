-- Уникальный индекс — гарантирует что дубли связок (артикул МП + товар производителя)
-- невозможны на уровне БД, даже при гонке двух одновременных запросов на создание
CREATE UNIQUE INDEX IF NOT EXISTS idx_producer_mappings_unique
  ON producer_mappings (company_id, marketplace_article, producer_product_id);
