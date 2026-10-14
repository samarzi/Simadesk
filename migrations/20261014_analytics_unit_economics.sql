-- Аналитика: история себестоимости и ключи Ozon Performance.
-- Миграция идемпотентна: deploy.sh применяет все файлы при каждом деплое.

-- ── 1. История себестоимости ────────────────────────────────────────────────
-- Раньше себестоимость хранилась одним числом: изменение сегодня переписывало
-- прибыль всех прошлых месяцев. Теперь каждое изменение сохраняется с датой,
-- и заказ берёт себестоимость, действовавшую на дату заказа.
CREATE TABLE IF NOT EXISTS cost_price_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_code TEXT NOT NULL,
  cost        NUMERIC(12,2) NOT NULL CHECK (cost >= 0),
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cph_company_vendor
  ON cost_price_history(company_id, lower(vendor_code), valid_from);

ALTER TABLE cost_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cph_select_member" ON cost_price_history;
CREATE POLICY "cph_select_member" ON cost_price_history
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "cph_insert_member" ON cost_price_history;
CREATE POLICY "cph_insert_member" ON cost_price_history
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );

DROP POLICY IF EXISTS "cph_delete_member" ON cost_price_history;
CREATE POLICY "cph_delete_member" ON cost_price_history
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin','manager')
    )
  );

GRANT SELECT, INSERT, DELETE ON cost_price_history TO authenticated;

-- Каждое изменение cost_prices пишется в историю автоматически.
CREATE OR REPLACE FUNCTION log_cost_price_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.cost IS DISTINCT FROM OLD.cost THEN
    INSERT INTO cost_price_history(company_id, vendor_code, cost, valid_from)
    VALUES (NEW.company_id, NEW.vendor_code, NEW.cost, NOW());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cost_price_history ON cost_prices;
CREATE TRIGGER trg_cost_price_history
  AFTER INSERT OR UPDATE OF cost ON cost_prices
  FOR EACH ROW EXECUTE FUNCTION log_cost_price_history();

-- Стартовая точка: текущая себестоимость действует «с начала времён»,
-- чтобы старые заказы не остались без себестоимости.
INSERT INTO cost_price_history(company_id, vendor_code, cost, valid_from)
SELECT cp.company_id, cp.vendor_code, cp.cost, '2000-01-01T00:00:00Z'
FROM cost_prices cp
WHERE NOT EXISTS (
  SELECT 1 FROM cost_price_history h
  WHERE h.company_id = cp.company_id AND lower(h.vendor_code) = lower(cp.vendor_code)
);

-- ── 2. Ключи Ozon Performance (рекламный кабинет) ──────────────────────────
-- Performance API авторизуется отдельными client_id/client_secret из
-- кабинета performance.ozon.ru, а не ключами Seller API.
ALTER TABLE ozon_stores ADD COLUMN IF NOT EXISTS perf_client_id TEXT;
ALTER TABLE ozon_stores ADD COLUMN IF NOT EXISTS perf_client_secret TEXT;
