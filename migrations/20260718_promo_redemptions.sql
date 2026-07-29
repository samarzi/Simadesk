-- ── Promo redemptions: track WHO used each code, WHEN, and with what discount ──

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id       UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  user_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  company_id     UUID REFERENCES companies(id) ON DELETE SET NULL,
  discount_rub   INTEGER DEFAULT 0,
  discount_percent INTEGER DEFAULT 0,
  redeemed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo ON promo_redemptions(promo_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user  ON promo_redemptions(user_id);

ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;

-- ── Rebuild apply_promo_code: prevent double-use per company + record redemption ─
CREATE OR REPLACE FUNCTION apply_promo_code(p_code TEXT, p_company_id UUID, p_user_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promo promo_codes;
  v_already BOOLEAN;
BEGIN
  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(p_code) AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses);

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или истёк');
  END IF;

  -- Prevent the same company from redeeming the same code twice
  SELECT EXISTS(
    SELECT 1 FROM promo_redemptions
    WHERE promo_id = v_promo.id AND company_id = p_company_id
  ) INTO v_already;

  IF v_already THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод уже применён для этой компании');
  END IF;

  -- Apply to subscription if exists
  UPDATE user_subscriptions
  SET promo_code = v_promo.code,
      promo_discount_rub = v_promo.discount_rub,
      updated_at = now()
  WHERE company_id = p_company_id AND user_id = p_user_id;

  -- Record redemption + increment counter
  INSERT INTO promo_redemptions (promo_id, code, user_id, company_id, discount_rub, discount_percent)
  VALUES (v_promo.id, v_promo.code, p_user_id, p_company_id, v_promo.discount_rub, v_promo.discount_percent);

  UPDATE promo_codes SET use_count = use_count + 1 WHERE id = v_promo.id;

  RETURN json_build_object(
    'ok', true,
    'discount_rub', v_promo.discount_rub,
    'discount_percent', v_promo.discount_percent,
    'description', v_promo.description
  );
END;
$$;

-- ── Admin: list redemptions for a specific promo (or all recent) ──────────────
CREATE OR REPLACE FUNCTION admin_get_promo_redemptions(p_promo_id UUID DEFAULT NULL, p_limit INT DEFAULT 100)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.redeemed_at DESC), '[]'::json) FROM (
      SELECT
        pr.id, pr.code, pr.discount_rub, pr.discount_percent, pr.redeemed_at,
        pr.user_id, pr.company_id,
        u.first_name, u.last_name, u.telegram_username, u.photo_url,
        c.name AS company_name
      FROM promo_redemptions pr
      LEFT JOIN users u ON u.id = pr.user_id
      LEFT JOIN companies c ON c.id = pr.company_id
      WHERE p_promo_id IS NULL OR pr.promo_id = p_promo_id
      ORDER BY pr.redeemed_at DESC
      LIMIT p_limit
    ) r
  );
END;
$$;

-- ── Rebuild admin_get_promos to include redemption count + last use ───────────
DROP FUNCTION IF EXISTS admin_get_promos();
CREATE OR REPLACE FUNCTION admin_get_promos()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_admin platform_admins;
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Access denied'; END IF;
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.created_at DESC), '[]'::json) FROM (
      SELECT
        pc.id, pc.code, pc.discount_rub, pc.discount_percent, pc.description,
        pc.valid_until, pc.max_uses, pc.use_count, pc.is_active, pc.created_at,
        (SELECT COUNT(*) FROM promo_redemptions pr WHERE pr.promo_id = pc.id) AS redemption_count,
        (SELECT MAX(redeemed_at) FROM promo_redemptions pr WHERE pr.promo_id = pc.id) AS last_used_at
      FROM promo_codes pc
      ORDER BY pc.created_at DESC
    ) p
  );
END;
$$;
