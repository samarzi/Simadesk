-- Fix: extend trial for all users whose trial has expired, so storefronts become accessible again.
-- Also grants the platform admin (regstalker05@gmail.com) an indefinite subscription.

-- 1. Extend expired trials by 30 days from now
UPDATE user_trials
SET ends_at = now() + interval '30 days'
WHERE ends_at <= now();

-- 2. Ensure all existing users who never got a trial row get one (14-day trial)
INSERT INTO user_trials (user_id)
SELECT id FROM auth.users
WHERE id NOT IN (SELECT user_id FROM user_trials)
ON CONFLICT DO NOTHING;

-- 3. Grant owner (regstalker05@gmail.com) an active subscription covering all their companies
--    Uses admin_extend_subscription logic but works even if no subscription row exists yet.
DO $$
DECLARE
  v_owner_id   uuid;
  v_company_id uuid;
BEGIN
  SELECT id INTO v_owner_id FROM auth.users WHERE email = 'regstalker05@gmail.com';
  IF v_owner_id IS NULL THEN RETURN; END IF;

  FOR v_company_id IN
    SELECT id FROM companies WHERE created_by = v_owner_id
  LOOP
    INSERT INTO user_subscriptions
      (user_id, company_id, plan_key, price_rub, status, current_period_start, current_period_end)
    VALUES
      (v_owner_id, v_company_id, 'pro', 0, 'active', now(), now() + interval '365 days')
    ON CONFLICT (company_id) DO UPDATE SET
      status               = 'active',
      current_period_end   = now() + interval '365 days',
      updated_at           = now();
  END LOOP;

  -- Also reset trial to give buffer
  UPDATE user_trials
  SET ends_at = now() + interval '365 days'
  WHERE user_id = v_owner_id;
END;
$$;
