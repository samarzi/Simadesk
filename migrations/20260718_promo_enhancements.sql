-- ── Promo code enhancements ───────────────────────────────────────────────────
-- Add duration (how long the discount lasts after use) and max_companies fields

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS duration_months INT DEFAULT NULL;
  -- NULL = бессрочно (discount never expires after first use)
  -- 1,3,6,12 = discount valid for N months from application date

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_companies INT DEFAULT NULL;
  -- NULL = unlimited companies
  -- N = only N unique companies can use this code

-- ── Update admin_create_promo to accept new fields ──────────────────────────
CREATE OR REPLACE FUNCTION admin_create_promo(
  p_code             TEXT,
  p_discount_rub     INT     DEFAULT 0,
  p_discount_percent INT     DEFAULT 0,
  p_description      TEXT    DEFAULT '',
  p_valid_until      TIMESTAMPTZ DEFAULT NULL,
  p_max_uses         INT     DEFAULT NULL,
  p_duration_months  INT     DEFAULT NULL,
  p_max_companies    INT     DEFAULT NULL
)
RETURNS promo_codes LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
  v_promo promo_codes;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  INSERT INTO promo_codes (code, discount_rub, discount_percent, description, valid_until, max_uses, duration_months, max_companies)
  VALUES (UPPER(TRIM(p_code)), p_discount_rub, p_discount_percent, p_description, p_valid_until, p_max_uses, p_duration_months, p_max_companies)
  RETURNING * INTO v_promo;

  RETURN v_promo;
END;
$$;
GRANT EXECUTE ON FUNCTION admin_create_promo(TEXT,INT,INT,TEXT,TIMESTAMPTZ,INT,INT,INT) TO authenticated;

-- ── Update admin_get_promos to include new fields ───────────────────────────
CREATE OR REPLACE FUNCTION admin_get_promos()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;

  RETURN (
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.created_at DESC), '[]'::json)
    FROM (
      SELECT
        pc.id, pc.code, pc.discount_rub, pc.discount_percent, pc.description,
        pc.valid_until, pc.max_uses, pc.use_count, pc.is_active, pc.created_at,
        pc.duration_months, pc.max_companies,
        COUNT(pr.id) AS redemption_count,
        MAX(pr.redeemed_at) AS last_used_at
      FROM promo_codes pc
      LEFT JOIN promo_redemptions pr ON pr.promo_code_id = pc.id
      GROUP BY pc.id
    ) p
  );
END;
$$;
GRANT EXECUTE ON FUNCTION admin_get_promos() TO authenticated;

-- ── Update apply_promo_code to check max_companies constraint ───────────────
CREATE OR REPLACE FUNCTION apply_promo_code(p_code TEXT, p_company_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promo    promo_codes;
  v_user_id  UUID;
  v_companies_used INT;
BEGIN
  v_user_id := auth.uid();

  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(p_code)
    AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses);

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или недействителен');
  END IF;

  -- Check max_companies constraint
  IF v_promo.max_companies IS NOT NULL THEN
    SELECT COUNT(DISTINCT pr.company_id) INTO v_companies_used
    FROM promo_redemptions pr WHERE pr.promo_code_id = v_promo.id;
    IF v_companies_used >= v_promo.max_companies THEN
      RETURN json_build_object('ok', false, 'error', 'Промокод достиг лимита использований по компаниям');
    END IF;
  END IF;

  -- Check if this company already used it
  IF EXISTS (SELECT 1 FROM promo_redemptions WHERE promo_code_id = v_promo.id AND company_id = p_company_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Этот промокод уже применён к данной компании');
  END IF;

  -- Apply discount to subscription
  UPDATE user_subscriptions SET
    promo_code        = v_promo.code,
    promo_discount_rub = v_promo.discount_rub,
    updated_at        = now()
  WHERE company_id = p_company_id;

  -- Record redemption
  INSERT INTO promo_redemptions (promo_code_id, user_id, company_id)
  VALUES (v_promo.id, v_user_id, p_company_id)
  ON CONFLICT DO NOTHING;

  -- Increment counter
  UPDATE promo_codes SET use_count = use_count + 1 WHERE id = v_promo.id;

  RETURN json_build_object(
    'ok', true,
    'discount_rub', v_promo.discount_rub,
    'discount_percent', v_promo.discount_percent,
    'duration_months', v_promo.duration_months,
    'description', v_promo.description
  );
END;
$$;
GRANT EXECUTE ON FUNCTION apply_promo_code(TEXT, UUID) TO authenticated;
