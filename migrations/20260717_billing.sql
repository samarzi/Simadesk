-- ── Billing: trials, subscriptions, promo codes ──────────────────────────────

-- Trial periods (one per user, created on first login)
CREATE TABLE IF NOT EXISTS user_trials (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_trials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user sees own trial" ON user_trials FOR SELECT USING (auth.uid() = user_id);

-- Subscriptions (one per company)
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_key             TEXT NOT NULL, -- 'free'|'starter'|'business'|'pro'|'max'
  monthly_revenue      BIGINT DEFAULT 0,   -- оборот в рублях за посл. 30 дней
  price_rub            INTEGER DEFAULT 0,  -- цена тарифа в рублях
  status               TEXT NOT NULL DEFAULT 'active', -- 'active'|'cancelled'|'expired'
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  promo_code           TEXT,
  promo_discount_rub   INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id)
);

ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user sees own subs" ON user_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user updates own subs" ON user_subscriptions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "user inserts own subs" ON user_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT UNIQUE NOT NULL,
  discount_percent INTEGER DEFAULT 0,
  discount_rub     INTEGER DEFAULT 0,
  description      TEXT,
  valid_until      TIMESTAMPTZ,
  max_uses         INTEGER,
  use_count        INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
-- Anyone can read active codes (to validate), only service_role can write
CREATE POLICY "anyone reads active promos" ON promo_codes FOR SELECT USING (is_active = true);

-- ── RPC: ensure trial exists for user (called on first app load) ──────────────
CREATE OR REPLACE FUNCTION ensure_user_trial(p_user_id UUID)
RETURNS user_trials LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_trial user_trials;
BEGIN
  INSERT INTO user_trials (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_trial FROM user_trials WHERE user_id = p_user_id;
  RETURN v_trial;
END;
$$;

-- ── RPC: get company monthly revenue from orders (last 30 days) ──────────────
CREATE OR REPLACE FUNCTION get_company_monthly_revenue(p_company_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total BIGINT := 0;
  v_since TIMESTAMPTZ := now() - interval '30 days';
BEGIN
  -- Ozon orders
  SELECT COALESCE(SUM((data->>'price')::NUMERIC), 0) INTO v_total
  FROM ozon_orders
  WHERE company_id = p_company_id AND created_at >= v_since;

  -- WB orders (добавляем к итогу)
  v_total := v_total + COALESCE((
    SELECT SUM((data->>'totalPrice')::NUMERIC)
    FROM wb_orders
    WHERE company_id = p_company_id AND created_at >= v_since
  ), 0);

  -- Yandex orders
  v_total := v_total + COALESCE((
    SELECT SUM((data->>'total')::NUMERIC)
    FROM yandex_orders
    WHERE company_id = p_company_id AND created_at >= v_since
  ), 0);

  RETURN v_total;
END;
$$;

-- ── RPC: validate and apply promo code ───────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_promo_code(p_code TEXT, p_company_id UUID, p_user_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_promo promo_codes;
  v_sub   user_subscriptions;
BEGIN
  SELECT * INTO v_promo FROM promo_codes
  WHERE UPPER(code) = UPPER(p_code) AND is_active = true
    AND (valid_until IS NULL OR valid_until > now())
    AND (max_uses IS NULL OR use_count < max_uses);

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Промокод не найден или истёк');
  END IF;

  -- Apply to subscription if exists
  UPDATE user_subscriptions
  SET promo_code = v_promo.code,
      promo_discount_rub = v_promo.discount_rub,
      updated_at = now()
  WHERE company_id = p_company_id AND user_id = p_user_id;

  -- Increment use count
  UPDATE promo_codes SET use_count = use_count + 1 WHERE id = v_promo.id;

  RETURN json_build_object(
    'ok', true,
    'discount_rub', v_promo.discount_rub,
    'discount_percent', v_promo.discount_percent,
    'description', v_promo.description
  );
END;
$$;
