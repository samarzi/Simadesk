-- ============================================================
-- MIGRATION: Fix companies INSERT policy + auto-set created_by
-- Запустить в Supabase Dashboard → SQL Editor
-- ============================================================

-- Шаг 1: Исправить политику INSERT на companies
-- Старая: created_by = auth.uid() — ломается если клиент не передаёт created_by
-- Новая: любой авторизованный пользователь может создать компанию
DROP POLICY IF EXISTS "companies_insert" ON companies;

CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Шаг 2: Триггер — автоматически ставит created_by = auth.uid() при INSERT
CREATE OR REPLACE FUNCTION set_company_created_by()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by = auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_created_by ON companies;
CREATE TRIGGER trg_companies_created_by
  BEFORE INSERT ON companies
  FOR EACH ROW EXECUTE FUNCTION set_company_created_by();
