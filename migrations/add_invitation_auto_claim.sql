-- Migration: автоматическое принятие приглашений по telegram_username при входе пользователя
-- Run in Supabase SQL Editor

-- 1) Добавляем колонку telegram_username в company_invitations (если ещё нет)
ALTER TABLE company_invitations
  ADD COLUMN IF NOT EXISTS telegram_username TEXT;

CREATE INDEX IF NOT EXISTS idx_inv_telegram_username
  ON company_invitations(LOWER(telegram_username))
  WHERE telegram_username IS NOT NULL AND used_at IS NULL;

-- 2) Функция: при создании/обновлении users — проверяем pending-инвайты
CREATE OR REPLACE FUNCTION claim_pending_invitations()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
BEGIN
  IF NEW.telegram_username IS NULL OR NEW.telegram_username = '' THEN
    RETURN NEW;
  END IF;

  -- Все pending-инвайты с совпадающим telegram_username
  FOR inv IN
    SELECT id, company_id, role
    FROM company_invitations
    WHERE LOWER(telegram_username) = LOWER(NEW.telegram_username)
      AND used_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
  LOOP
    -- Добавляем в members (если ещё не там)
    INSERT INTO company_members (company_id, user_id, role, invited_by, joined_at)
    VALUES (inv.company_id, NEW.id, inv.role, NULL, NOW())
    ON CONFLICT (company_id, user_id) DO NOTHING;

    -- Помечаем инвайт как использованный
    UPDATE company_invitations
    SET used_at = NOW(), used_by = NEW.id
    WHERE id = inv.id;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_claim_invitations ON users;
CREATE TRIGGER trg_users_claim_invitations
  AFTER INSERT OR UPDATE OF telegram_username ON users
  FOR EACH ROW EXECUTE FUNCTION claim_pending_invitations();

COMMENT ON FUNCTION claim_pending_invitations IS
  'При создании пользователя авто-принимает все pending-инвайты с совпадающим telegram_username';
