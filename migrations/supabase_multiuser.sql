-- ============================================================
-- MIGRATION: Multi-user system (Telegram auth + Companies)
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. USERS TABLE (linked to Supabase auth.users)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_id  BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  first_name   TEXT NOT NULL DEFAULT '',
  last_name    TEXT,
  photo_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- ──────────────────────────────────────────────────────────────
-- 2. COMPANIES TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,                  -- рабочее название (любое удобное)
  legal_name    TEXT,                           -- юридическое название (ООО/ИП и т.д.)
  type          TEXT CHECK (type IN ('ip', 'ooo', 'self_employed', 'individual')),
  inn           TEXT,
  kpp           TEXT,                     -- only for ООО
  ogrn          TEXT,
  legal_address TEXT,
  bank_account  TEXT,
  bik           TEXT,
  bank_name     TEXT,
  corr_account  TEXT,
  email         TEXT,
  phone         TEXT,
  logo_url      TEXT,
  color         TEXT NOT NULL DEFAULT '#005bff',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ──────────────────────────────────────────────────────────────
-- 3. COMPANY MEMBERS (user ↔ company binding with roles)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'viewer')) DEFAULT 'owner',
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cm_user_id       ON company_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cm_company_id    ON company_members(company_id);

-- ──────────────────────────────────────────────────────────────
-- 4. INVITATIONS (for future team invite system)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  role        TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')) DEFAULT 'manager',
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
-- 5. ADD company_id TO EXISTING TABLES
-- ──────────────────────────────────────────────────────────────
ALTER TABLE boxes    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE sheets   ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Index for fast company lookups
CREATE INDEX IF NOT EXISTS idx_boxes_company_id    ON boxes(company_id);
CREATE INDEX IF NOT EXISTS idx_sheets_company_id   ON sheets(company_id);

-- ──────────────────────────────────────────────────────────────
-- 6. ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sheets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;

-- ── users RLS ──────────────────────────────────────────────────
-- User can read/update only their own profile
CREATE POLICY "users_select_own" ON users
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid());

-- ── companies RLS ──────────────────────────────────────────────
-- Helper: returns company_ids for current user
-- Using inline subquery for compatibility

CREATE POLICY "companies_select_member" ON companies
  FOR SELECT USING (
    id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "companies_insert_auth" ON companies
  FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "companies_update_admin" ON companies
  FOR UPDATE USING (
    id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "companies_delete_owner" ON companies
  FOR DELETE USING (
    id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

-- ── company_members RLS ───────────────────────────────────────
CREATE POLICY "cm_select_member" ON company_members
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Owner/admin can add members; anyone can join via invite (handled in edge function)
CREATE POLICY "cm_insert_admin" ON company_members
  FOR INSERT WITH CHECK (
    -- Inserting yourself as owner when creating company
    (user_id = auth.uid() AND role = 'owner')
    OR
    -- Admin/owner adding someone else
    (company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    ))
  );

CREATE POLICY "cm_delete_admin" ON company_members
  FOR DELETE USING (
    -- Can remove yourself
    user_id = auth.uid()
    OR
    -- Owner/admin can remove others
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- ── invitations RLS ───────────────────────────────────────────
CREATE POLICY "inv_select" ON company_invitations
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
    OR token IS NOT NULL  -- anyone with token can read (for join flow)
  );

CREATE POLICY "inv_insert_admin" ON company_invitations
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- ── boxes RLS ─────────────────────────────────────────────────
CREATE POLICY "boxes_company_select" ON boxes
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "boxes_company_insert" ON boxes
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "boxes_company_update" ON boxes
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "boxes_company_delete" ON boxes
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'manager')
    )
  );

-- ── sheets RLS ────────────────────────────────────────────────
CREATE POLICY "sheets_company_select" ON sheets
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "sheets_company_insert" ON sheets
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "sheets_company_delete" ON sheets
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- ── products RLS (via boxes.company_id) ───────────────────────
CREATE POLICY "products_company_select" ON products
  FOR SELECT USING (
    box_id IN (
      SELECT b.id FROM boxes b
      JOIN company_members cm ON cm.company_id = b.company_id
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY "products_company_insert" ON products
  FOR INSERT WITH CHECK (
    box_id IN (
      SELECT b.id FROM boxes b
      JOIN company_members cm ON cm.company_id = b.company_id
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY "products_company_update" ON products
  FOR UPDATE USING (
    box_id IN (
      SELECT b.id FROM boxes b
      JOIN company_members cm ON cm.company_id = b.company_id
      WHERE cm.user_id = auth.uid()
    )
  );

CREATE POLICY "products_company_delete" ON products
  FOR DELETE USING (
    box_id IN (
      SELECT b.id FROM boxes b
      JOIN company_members cm ON cm.company_id = b.company_id
      WHERE cm.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────
-- 7. USEFUL VIEWS
-- ──────────────────────────────────────────────────────────────

-- View: current user's companies with their role
CREATE OR REPLACE VIEW my_companies AS
  SELECT
    c.*,
    cm.role,
    cm.joined_at
  FROM companies c
  JOIN company_members cm ON cm.company_id = c.id
  WHERE cm.user_id = auth.uid();

-- ──────────────────────────────────────────────────────────────
-- 8. COMMENTS
-- ──────────────────────────────────────────────────────────────
COMMENT ON TABLE users               IS 'Telegram-авторизованные пользователи, привязаны к auth.users';
COMMENT ON TABLE companies           IS 'Компании (рабочие пространства) — основная единица изоляции данных';
COMMENT ON TABLE company_members     IS 'Участники компаний с ролями (owner/admin/manager/viewer)';
COMMENT ON TABLE company_invitations IS 'Приглашения в компанию по одноразовому токену';
COMMENT ON COLUMN companies.color    IS 'HEX цвет метки компании для переключателя';

-- ──────────────────────────────────────────────────────────────
-- 9. Дополнительные поля users (display_name)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT NULL;
COMMENT ON COLUMN users.display_name IS 'Кастомное отображаемое имя (если пользователь хочет отличное от TG)';
