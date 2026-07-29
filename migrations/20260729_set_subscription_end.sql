-- Allow admin to set an exact subscription end date (can be past to deactivate early)
CREATE OR REPLACE FUNCTION admin_set_subscription_end(
  p_company_id UUID,
  p_end_date   TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin    platform_admins;
  v_owner_id UUID;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT COALESCE(
    (SELECT user_id FROM user_subscriptions WHERE company_id = p_company_id LIMIT 1),
    (SELECT created_by FROM companies WHERE id = p_company_id)
  ) INTO v_owner_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id;
  END IF;

  INSERT INTO user_subscriptions
    (user_id, company_id, plan_key, price_rub, status, current_period_start, current_period_end)
  VALUES
    (v_owner_id, p_company_id, 'starter', 0, 'active', now(), p_end_date)
  ON CONFLICT (company_id) DO UPDATE SET
    status             = CASE WHEN p_end_date > now() THEN 'active' ELSE 'expired' END,
    current_period_end = p_end_date,
    updated_at         = now();
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_subscription_end(UUID, TIMESTAMPTZ) TO authenticated;
