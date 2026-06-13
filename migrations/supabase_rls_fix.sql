-- ============================================================
-- MIGRATION: Fix RLS infinite recursion in company_members
-- Запустить ВМЕСТО supabase_multiuser.sql (полная замена политик)
-- ============================================================

-- Шаг 1: Убрать все старые рекурсивные политики
DROP POLICY IF EXISTS "cm_select_member"    ON company_members;
DROP POLICY IF EXISTS "cm_insert_admin"     ON company_members;
DROP POLICY IF EXISTS "cm_delete_admin"     ON company_members;
DROP POLICY IF EXISTS "boxes_company_select" ON boxes;
DROP POLICY IF EXISTS "boxes_company_insert" ON boxes;
DROP POLICY IF EXISTS "boxes_company_update" ON boxes;
DROP POLICY IF EXISTS "boxes_company_delete" ON boxes;
DROP POLICY IF EXISTS "sheets_company_select" ON sheets;
DROP POLICY IF EXISTS "sheets_company_insert" ON sheets;
DROP POLICY IF EXISTS "sheets_company_delete" ON sheets;
DROP POLICY IF EXISTS "products_company_select" ON products;
DROP POLICY IF EXISTS "products_company_insert" ON products;
DROP POLICY IF EXISTS "products_company_update" ON products;
DROP POLICY IF EXISTS "products_company_delete" ON products;
DROP POLICY IF EXISTS "companies_select_member" ON companies;
DROP POLICY IF EXISTS "companies_insert_auth"   ON companies;
DROP POLICY IF EXISTS "companies_update_admin"  ON companies;
DROP POLICY IF EXISTS "companies_delete_owner"  ON companies;
DROP POLICY IF EXISTS "inv_select"       ON company_invitations;
DROP POLICY IF EXISTS "inv_insert_admin" ON company_invitations;

-- Шаг 2: SECURITY DEFINER функция — обходит RLS при вызове из политик
-- Возвращает список company_id текущего пользователя БЕЗ рекурсии
CREATE OR REPLACE FUNCTION user_company_ids()
RETURNS SETOF UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM company_members WHERE user_id = auth.uid();
$$;

-- Шаг 3: Пересоздать политики с использованием функции (нет рекурсии)

-- ── company_members ────────────────────────────────────────────
CREATE POLICY "cm_select" ON company_members
  FOR SELECT USING (
    company_id IN (SELECT user_company_ids())
  );

CREATE POLICY "cm_insert" ON company_members
  FOR INSERT WITH CHECK (
    -- Сам себя добавляю как owner при создании компании
    (user_id = auth.uid() AND role = 'owner')
    OR
    -- Админ/owner добавляет кого-то ещё
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "cm_delete" ON company_members
  FOR DELETE USING (
    user_id = auth.uid()
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );

-- ── companies ──────────────────────────────────────────────────
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (id IN (SELECT user_company_ids()));

CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role = 'owner'
    )
  );

-- ── boxes ──────────────────────────────────────────────────────
CREATE POLICY "boxes_select" ON boxes
  FOR SELECT USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "boxes_insert" ON boxes
  FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));

CREATE POLICY "boxes_update" ON boxes
  FOR UPDATE USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "boxes_delete" ON boxes
  FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- ── sheets ─────────────────────────────────────────────────────
CREATE POLICY "sheets_select" ON sheets
  FOR SELECT USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "sheets_insert" ON sheets
  FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));

CREATE POLICY "sheets_delete" ON sheets
  FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- ── products (через boxes) ─────────────────────────────────────
CREATE POLICY "products_select" ON products
  FOR SELECT USING (
    box_id IN (SELECT id FROM boxes WHERE company_id IN (SELECT user_company_ids()))
  );

CREATE POLICY "products_insert" ON products
  FOR INSERT WITH CHECK (
    box_id IN (SELECT id FROM boxes WHERE company_id IN (SELECT user_company_ids()))
  );

CREATE POLICY "products_update" ON products
  FOR UPDATE USING (
    box_id IN (SELECT id FROM boxes WHERE company_id IN (SELECT user_company_ids()))
  );

CREATE POLICY "products_delete" ON products
  FOR DELETE USING (
    box_id IN (SELECT id FROM boxes WHERE company_id IN (SELECT user_company_ids()))
  );

-- ── company_invitations ────────────────────────────────────────
CREATE POLICY "inv_select" ON company_invitations
  FOR SELECT USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "inv_insert" ON company_invitations
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );

-- ── my_companies view (пересоздать) ───────────────────────────
-- DROP сначала — иначе CREATE OR REPLACE не может изменить структуру колонок
DROP VIEW IF EXISTS my_companies;

CREATE VIEW my_companies AS
  SELECT
    c.id, c.name, c.legal_name, c.type,
    c.inn, c.kpp, c.ogrn, c.legal_address,
    c.bank_account, c.bik, c.bank_name, c.corr_account,
    c.email, c.phone, c.logo_url, c.color,
    c.created_at, c.created_by,
    cm.role, cm.joined_at
  FROM companies c
  JOIN company_members cm ON cm.company_id = c.id
  WHERE cm.user_id = auth.uid();
