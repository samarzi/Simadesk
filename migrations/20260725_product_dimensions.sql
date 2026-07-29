-- product_dimensions — эталонные габариты товаров (вес+размеры) в Ozon-единицах (мм, г).
-- Заменяет localStorage-хранилище dimensions_v1_<company_id> для синхронизации между устройствами.

CREATE TABLE IF NOT EXISTS product_dimensions (
  vendor_code  TEXT        NOT NULL,
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  weight_g     FLOAT,
  length_mm    FLOAT,
  width_mm     FLOAT,
  height_mm    FLOAT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_code, company_id)
);

-- Index for bulk lookups by company
CREATE INDEX IF NOT EXISTS product_dimensions_company_idx ON product_dimensions (company_id);

-- RLS: users can only see/edit their own company's data
ALTER TABLE product_dimensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company members can select" ON product_dimensions
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "company members can insert" ON product_dimensions
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "company members can update" ON product_dimensions
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "company members can delete" ON product_dimensions
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );
