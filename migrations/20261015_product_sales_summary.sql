-- Сводка продаж по товарам для раздела «Товары».
-- Раньше раздел скачивал в браузер все финансовые операции за 180 дней
-- (с исходным JSON каждой — десятки мегабайт) и суммировал их на клиенте.
-- Теперь сервер отдаёт по одной строке на (магазин, SKU) за выбранный период.
--
-- Деньги делятся между позициями операции пропорционально количеству.
--   revenue    — выручка (accruals_for_sale)
--   commission — комиссия маркетплейса (положительное = удержание)
--   payout     — сколько маркетплейс перечислил (amount): выручка минус все удержания
-- Удержания «логистика и услуги» = revenue − commission − payout.
--
-- SECURITY INVOKER: действует политика доступа mp_transactions (своя компания).
-- Идемпотентно: deploy.sh применяет файл при каждом деплое.

CREATE OR REPLACE FUNCTION product_sales_summary(p_store_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  store_id uuid,
  marketplace text,
  sku text,
  sold numeric,
  returned numeric,
  revenue numeric,
  commission numeric,
  payout numeric
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH x AS (
    SELECT t.store_id, t.marketplace, t.tx_kind,
           COALESCE(t.accruals_for_sale, 0) AS a,
           COALESCE(t.sale_commission, 0)   AS c,
           COALESCE(t.amount, 0)            AS m,
           NULLIF(e->>'sku', '')            AS sku,
           GREATEST(ABS(COALESCE(NULLIF(e->>'quantity', '')::numeric, 1)), 0) AS q,
           SUM(GREATEST(ABS(COALESCE(NULLIF(e->>'quantity', '')::numeric, 1)), 0)) OVER (PARTITION BY t.id) AS tq
    FROM mp_transactions t
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.items_json) = 'array' THEN t.items_json ELSE '[]'::jsonb END
    ) e
    WHERE t.store_id = ANY(p_store_ids)
      AND t.operation_date >= p_from
      AND t.operation_date <= p_to
      AND COALESCE(t.tx_kind, '') NOT IN ('payout', 'transfer')
  )
  SELECT store_id, marketplace, sku,
         SUM(CASE WHEN tx_kind = 'sale'   THEN q ELSE 0 END),
         SUM(CASE WHEN tx_kind = 'return' THEN q ELSE 0 END),
         SUM(a * q / NULLIF(tq, 0)),
         SUM(-c * q / NULLIF(tq, 0)),
         SUM(m * q / NULLIF(tq, 0))
  FROM x
  WHERE sku IS NOT NULL
  GROUP BY store_id, marketplace, sku
$$;

GRANT EXECUTE ON FUNCTION product_sales_summary(uuid[], timestamptz, timestamptz) TO authenticated;
-- Функции в Postgres по умолчанию доступны всем (PUBLIC). Вызов без входа
-- данных не раскрыл бы (политика mp_transactions), но закрываем его явно.
REVOKE EXECUTE ON FUNCTION product_sales_summary(uuid[], timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION product_sales_summary(uuid[], timestamptz, timestamptz) TO authenticated;
