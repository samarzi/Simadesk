CREATE OR REPLACE FUNCTION get_company_monthly_revenue(p_company_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total        NUMERIC := 0;
  v_latest_chunk DATE;
  v_window_start DATE;
BEGIN
  SELECT MAX(aoc.chunk_to) INTO v_latest_chunk
  FROM analytics_orders_cache aoc
  WHERE aoc.store_id IN (
    SELECT id::TEXT FROM ozon_stores   WHERE company_id = p_company_id
    UNION ALL
    SELECT id::TEXT FROM wb_stores     WHERE company_id = p_company_id
    UNION ALL
    SELECT id::TEXT FROM yandex_stores WHERE company_id = p_company_id
  );

  IF v_latest_chunk IS NULL THEN RETURN 0; END IF;
  v_window_start := v_latest_chunk - 30;

  SELECT COALESCE(SUM(
    (elem->>'price')::NUMERIC * COALESCE((elem->>'quantity')::NUMERIC, 1)
  ), 0) INTO v_total
  FROM analytics_orders_cache aoc
  JOIN ozon_stores os ON os.id::TEXT = aoc.store_id
  CROSS JOIN LATERAL jsonb_array_elements(aoc.data) AS ord(o)
  CROSS JOIN LATERAL jsonb_array_elements(ord.o->'products') AS prod(elem)
  WHERE os.company_id = p_company_id
    AND aoc.chunk_from >= v_window_start
    AND (ord.o->>'status') NOT IN ('cancelled', 'returned');

  v_total := v_total + COALESCE((
    SELECT SUM(
      COALESCE(
        NULLIF(ord.o->>'finishedPrice', '')::NUMERIC,
        NULLIF(ord.o->>'priceWithDisc', '')::NUMERIC,
        NULLIF(ord.o->>'totalPrice', '')::NUMERIC / 100.0,
        0
      )
    )
    FROM analytics_orders_cache aoc
    JOIN wb_stores ws ON ws.id::TEXT = aoc.store_id
    CROSS JOIN LATERAL jsonb_array_elements(aoc.data) AS ord(o)
    WHERE ws.company_id = p_company_id
      AND aoc.chunk_from >= v_window_start
      AND (ord.o->>'isCancel') IS DISTINCT FROM 'true'
      AND (ord.o->>'cancel_dt') IS NULL
  ), 0);

  v_total := v_total + COALESCE((
    SELECT SUM(COALESCE(NULLIF(it.elem->>'buyerTotal','')::NUMERIC, 0))
    FROM analytics_orders_cache aoc
    JOIN yandex_stores ys ON ys.id::TEXT = aoc.store_id
    CROSS JOIN LATERAL jsonb_array_elements(aoc.data) AS ord(o)
    CROSS JOIN LATERAL jsonb_array_elements(ord.o->'items') AS it(elem)
    WHERE ys.company_id = p_company_id
      AND aoc.chunk_from >= v_window_start
      AND (ord.o->>'status') NOT IN ('CANCELLED', 'CANCELLED_IN_DELIVERY', 'RETURNED', 'CANCELLATION_REQUESTED')
  ), 0);

  RETURN v_total::BIGINT;
END;
$$;

GRANT EXECUTE ON FUNCTION get_company_monthly_revenue(UUID) TO authenticated;
NOTIFY pgrst, 'reload schema';
