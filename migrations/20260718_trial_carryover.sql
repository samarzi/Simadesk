-- ── Trial carryover: remaining trial days are added to new subscription ────────
-- Replaces admin_set_subscription so that when a user is still in their free
-- trial, the leftover days are tacked on top of the purchased period.

CREATE OR REPLACE FUNCTION admin_set_subscription(
  p_user_id UUID, p_company_id UUID,
  p_plan_key TEXT, p_price_rub INT, p_months INT DEFAULT 1
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin          platform_admins;
  v_trial          user_trials;
  v_trial_days_left INT := 0;
  v_period_end     TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  -- Check if this user still has time left on their free trial
  SELECT * INTO v_trial
  FROM user_trials
  WHERE user_id = p_user_id
    AND ends_at > now()
    AND is_active = true
  LIMIT 1;

  IF FOUND THEN
    v_trial_days_left := GREATEST(0, EXTRACT(DAY FROM (v_trial.ends_at - now()))::INT);
  END IF;

  v_period_end := now() + (p_months || ' months')::interval + (v_trial_days_left || ' days')::interval;

  INSERT INTO user_subscriptions (user_id, company_id, plan_key, price_rub, status, current_period_start, current_period_end)
  VALUES (p_user_id, p_company_id, p_plan_key, p_price_rub, 'active', now(), v_period_end)
  ON CONFLICT (company_id) DO UPDATE SET
    plan_key             = EXCLUDED.plan_key,
    price_rub            = EXCLUDED.price_rub,
    status               = 'active',
    current_period_start = EXCLUDED.current_period_start,
    current_period_end   = EXCLUDED.current_period_end,
    updated_at           = now();

  -- Deactivate the trial so it isn't double-counted on future upgrades
  IF v_trial_days_left > 0 THEN
    UPDATE user_trials
    SET is_active = false, updated_at = now()
    WHERE user_id = p_user_id AND is_active = true;
  END IF;
END;
$$;
