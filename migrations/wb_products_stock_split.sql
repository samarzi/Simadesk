-- Разделение остатков WB на FBW (склад WB) и FBS (свой склад продавца).
--
-- До этого stock_total заполнялся из статистики /api/v1/supplier/stocks,
-- которая отдаёт ТОЛЬКО остатки на складах WB (FBW). При этом UI показывал
-- это значение в редактируемом FBS-поле, а запись шла в PUT /api/v3/stocks/{id}
-- (свой склад) — то есть читали и писали разные пулы остатков.
--
-- Теперь:
--   stock_fbw   — остатки на складах WB (из statistics API)
--   stock_fbs   — остатки на своих складах (из marketplace API v3)
--   stock_total — сумма обоих

ALTER TABLE wb_products ADD COLUMN IF NOT EXISTS stock_fbs  integer NOT NULL DEFAULT 0;
ALTER TABLE wb_products ADD COLUMN IF NOT EXISTS stock_fbw  integer NOT NULL DEFAULT 0;

-- Первичное заполнение: до разделения всё, что лежало в stock_total, было FBW.
UPDATE wb_products SET stock_fbw = COALESCE(stock_total, 0)
WHERE stock_fbw = 0 AND COALESCE(stock_total, 0) > 0;
