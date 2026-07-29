-- ── Promo: check without applying + fix apply to handle duration ──────────────

-- 1. check_promo_code: validates code and returns full info without applying it
CREATE OR REPLACE FUNCTION check_promo_code(p_code TEXT, p_company_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promo         promo_codes;
  v_sub           user_subscriptions;
  v_companies_used INT;
  v_apply_from    TIMESTAMPTZ;
  v_apply_to      TIMESTAMPTZ;
  v_deferred      BOOLEAN := false;
BEGIN
  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(TRIM(p_code))
    AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses);

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или недействителен');
  END IF;

  IF v_promo.max_companies IS NOT NULL THEN
    SELECT COUNT(DISTINCT company_id) INTO v_companies_used
    FROM promo_redemptions WHERE promo_code_id = v_promo.id;
    IF v_companies_used >= v_promo.max_companies THEN
      RETURN json_build_object('ok', false, 'error', 'Промокод достиг лимита использований');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM promo_redemptions WHERE promo_code_id = v_promo.id AND company_id = p_company_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Этот промокод уже применён к данной компании');
  END IF;

  -- Determine when promo activates
  SELECT * INTO v_sub FROM user_subscriptions
  WHERE company_id = p_company_id AND status = 'active'
    AND current_period_end IS NOT NULL AND current_period_end > now();

  IF FOUND THEN
    -- Has active subscription — promo starts after it ends
    v_apply_from := v_sub.current_period_end;
    v_deferred := true;
  ELSE
    v_apply_from := now();
    v_deferred := false;
  END IF;

  IF v_promo.duration_months IS NOT NULL THEN
    v_apply_to := v_apply_from + (v_promo.duration_months || ' months')::INTERVAL;
  END IF;

  RETURN json_build_object(
    'ok',              true,
    'code',            v_promo.code,
    'discount_rub',    v_promo.discount_rub,
    'discount_percent',v_promo.discount_percent,
    'description',     v_promo.description,
    'valid_until',     v_promo.valid_until,
    'duration_months', v_promo.duration_months,
    'apply_from',      v_apply_from,
    'apply_to',        v_apply_to,
    'deferred',        v_deferred
  );
END;
$$;
GRANT EXECUTE ON FUNCTION check_promo_code(TEXT, UUID) TO authenticated;

-- 2. Updated apply_promo_code: handles duration_months + no p_user_id param
CREATE OR REPLACE FUNCTION apply_promo_code(p_code TEXT, p_company_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promo          promo_codes;
  v_sub            user_subscriptions;
  v_user_id        UUID;
  v_companies_used INT;
  v_apply_from     TIMESTAMPTZ;
  v_apply_to       TIMESTAMPTZ;
  v_deferred       BOOLEAN := false;
BEGIN
  v_user_id := auth.uid();

  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(TRIM(p_code))
    AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses);

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или недействителен');
  END IF;

  IF v_promo.max_companies IS NOT NULL THEN
    SELECT COUNT(DISTINCT company_id) INTO v_companies_used
    FROM promo_redemptions WHERE promo_code_id = v_promo.id;
    IF v_companies_used >= v_promo.max_companies THEN
      RETURN json_build_object('ok', false, 'error', 'Промокод достиг лимита использований по компаниям');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM promo_redemptions WHERE promo_code_id = v_promo.id AND company_id = p_company_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Этот промокод уже применён к данной компании');
  END IF;

  -- Determine start of promo period
  SELECT * INTO v_sub FROM user_subscriptions
  WHERE company_id = p_company_id AND status = 'active'
    AND current_period_end IS NOT NULL AND current_period_end > now();

  IF FOUND THEN
    v_apply_from := v_sub.current_period_end;
    v_deferred := true;
  ELSE
    v_apply_from := now();
    v_deferred := false;
  END IF;

  IF v_promo.duration_months IS NOT NULL THEN
    v_apply_to := v_apply_from + (v_promo.duration_months || ' months')::INTERVAL;
  END IF;

  -- Apply to subscription
  IF FOUND THEN
    -- Active sub exists: add discount and/or extend period after it ends
    UPDATE user_subscriptions SET
      promo_code         = v_promo.code,
      promo_discount_rub = v_promo.discount_rub,
      -- If duration_months: extend current_period_end by that many months
      current_period_end = CASE
        WHEN v_promo.duration_months IS NOT NULL
        THEN current_period_end + (v_promo.duration_months || ' months')::INTERVAL
        ELSE current_period_end
      END,
      updated_at = now()
    WHERE company_id = p_company_id;
  ELSE
    -- No active sub: create one if duration_months given (free subscription period)
    IF v_promo.duration_months IS NOT NULL THEN
      INSERT INTO user_subscriptions
        (user_id, company_id, plan_key, monthly_revenue, price_rub, status,
         current_period_start, current_period_end, promo_code, promo_discount_rub)
      VALUES
        (v_user_id, p_company_id, 'free', 0, 0, 'active',
         v_apply_from, v_apply_to, v_promo.code, v_promo.discount_rub)
      ON CONFLICT (company_id) DO UPDATE SET
        promo_code         = v_promo.code,
        promo_discount_rub = v_promo.discount_rub,
        current_period_end = v_apply_to,
        status             = 'active',
        updated_at         = now();
    ELSE
      -- Discount-only promo, upsert subscription row with discount recorded
      INSERT INTO user_subscriptions
        (user_id, company_id, plan_key, monthly_revenue, price_rub, status, promo_code, promo_discount_rub)
      VALUES
        (v_user_id, p_company_id, 'free', 0, 0, 'active', v_promo.code, v_promo.discount_rub)
      ON CONFLICT (company_id) DO UPDATE SET
        promo_code         = v_promo.code,
        promo_discount_rub = v_promo.discount_rub,
        updated_at         = now();
    END IF;
  END IF;

  -- Record redemption and increment counter
  INSERT INTO promo_redemptions (promo_code_id, user_id, company_id)
  VALUES (v_promo.id, v_user_id, p_company_id)
  ON CONFLICT DO NOTHING;

  UPDATE promo_codes SET use_count = use_count + 1 WHERE id = v_promo.id;

  RETURN json_build_object(
    'ok',              true,
    'discount_rub',    v_promo.discount_rub,
    'discount_percent',v_promo.discount_percent,
    'duration_months', v_promo.duration_months,
    'description',     v_promo.description,
    'apply_from',      v_apply_from,
    'apply_to',        v_apply_to,
    'deferred',        v_deferred
  );
END;
$$;
GRANT EXECUTE ON FUNCTION apply_promo_code(TEXT, UUID) TO authenticated;
