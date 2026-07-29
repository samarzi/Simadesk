-- Add yookassa_payment_id to user_subscriptions
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS yookassa_payment_id TEXT;
