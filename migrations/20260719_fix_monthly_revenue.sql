-- Fix get_company_monthly_revenue: read from mp_transactions (real data)
-- instead of analytics_orders_cache (only populated after manual analytics sync)
CREATE OR REPLACE FUNCTION get_company_monthly_revenue(p_company_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (
    SELECT COALESCE(SUM(accruals_for_sale), 0)::BIGINT
    FROM mp_transactions
    WHERE company_id = p_company_id
      AND operation_date >= NOW() - INTERVAL '30 days'
      AND accruals_for_sale > 0
  );
END;
$$;
