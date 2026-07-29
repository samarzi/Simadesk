-- ── Fix 1: grant execute on get_company_monthly_revenue (was missing → revenue always 0) ──
GRANT EXECUTE ON FUNCTION get_company_monthly_revenue(UUID) TO authenticated;

-- ── Fix 2: apply_promo_code with FOR UPDATE lock to prevent double-use race condition ──
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

  -- Lock the promo row to prevent concurrent double-use
  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(TRIM(p_code))
    AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или недействителен');
  END IF;

  -- Re-check use_count after lock (guards against race)
  IF v_promo.max_uses IS NOT NULL AND v_promo.use_count >= v_promo.max_uses THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод исчерпал лимит использований');
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

  IF FOUND THEN
    UPDATE user_subscriptions SET
      promo_code         = v_promo.code,
      promo_discount_rub = v_promo.discount_rub,
      current_period_end = CASE
        WHEN v_promo.duration_months IS NOT NULL
        THEN current_period_end + (v_promo.duration_months || ' months')::INTERVAL
        ELSE current_period_end
      END,
      updated_at = now()
    WHERE company_id = p_company_id;
  ELSE
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

-- ── Fix 3: admin_delete_promo — hard delete a promo code ─────────────────────
CREATE OR REPLACE FUNCTION admin_delete_promo(p_promo_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_code TEXT;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT code INTO v_code FROM promo_codes WHERE id = p_promo_id;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'error', 'Промокод не найден'); END IF;

  DELETE FROM promo_redemptions WHERE promo_code_id = p_promo_id;
  DELETE FROM promo_codes WHERE id = p_promo_id;

  RETURN json_build_object('ok', true, 'code', v_code);
END;
$$;
GRANT EXECUTE ON FUNCTION admin_delete_promo(UUID) TO authenticated;

-- ── Fix 4: admin_get_users — include trial days_left and trial_ends_at ────────
CREATE OR REPLACE FUNCTION admin_get_users(p_search TEXT DEFAULT '', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_result JSON;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  SELECT json_build_object(
    'total', (
      SELECT COUNT(*) FROM users
      WHERE p_search = '' OR
        LOWER(first_name || ' ' || COALESCE(last_name,'') || ' ' || COALESCE(telegram_username,'')) LIKE LOWER('%' || p_search || '%')
    ),
    'users', (
      SELECT json_agg(row_to_json(u)) FROM (
        SELECT
          u.id, u.first_name, u.last_name, u.telegram_username, u.photo_url,
          u.created_at, u.last_login_at, u.banned_until,
          ut.ends_at AS trial_ends_at,
          CASE
            WHEN ut.ends_at IS NOT NULL AND ut.ends_at > now()
            THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (ut.ends_at - now())) / 86400))::INT
            ELSE 0
          END AS trial_days_left,
          (SELECT pa.role FROM platform_admins pa WHERE pa.user_id = u.id LIMIT 1) AS admin_role,
          (SELECT json_agg(json_build_object('company_id', cm.company_id, 'role', cm.role, 'name', c.name))
           FROM company_members cm JOIN companies c ON c.id = cm.company_id
           WHERE cm.user_id = u.id LIMIT 5) AS companies,
          (SELECT json_build_object('plan_key', us.plan_key, 'price_rub', us.price_rub, 'status', us.status)
           FROM user_subscriptions us WHERE us.user_id = u.id AND us.status = 'active' LIMIT 1) AS subscription,
          (SELECT COUNT(*) FROM company_members cm2 WHERE cm2.user_id = u.id) AS company_count
        FROM users u
        LEFT JOIN user_trials ut ON ut.user_id = u.id
        WHERE p_search = '' OR
          LOWER(u.first_name || ' ' || COALESCE(u.last_name,'') || ' ' || COALESCE(u.telegram_username,'')) LIKE LOWER('%' || p_search || '%')
        ORDER BY u.created_at DESC
        LIMIT p_limit OFFSET p_offset
      ) u
    )
  ) INTO v_result;
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_get_users(TEXT, INT, INT) TO authenticated;
