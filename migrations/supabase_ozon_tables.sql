-- Запустите этот SQL в Supabase → SQL Editor

-- Таблица магазинов Ozon
CREATE TABLE IF NOT EXISTS ozon_stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  client_id  text NOT NULL,
  api_key    text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Таблица товаров (синхронизированных с Ozon)
CREATE TABLE IF NOT EXISTS ozon_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES ozon_stores(id) ON DELETE CASCADE,
  offer_id    text NOT NULL,        -- артикул
  product_id  bigint,               -- внутренний ID Ozon
  name        text    DEFAULT '',
  price       numeric DEFAULT 0,
  old_price   numeric DEFAULT 0,
  min_price   numeric DEFAULT 0,
  stock_fbs   integer DEFAULT 0,
  stock_fbo   integer DEFAULT 0,
  category    text    DEFAULT '',
  images      text[]  DEFAULT '{}',
  barcode     text    DEFAULT '',
  status      text    DEFAULT '',
  synced_at   timestamptz DEFAULT now(),

  -- уникальность: один артикул на магазин
  CONSTRAINT ozon_products_store_offer_uq UNIQUE (store_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_ozon_products_offer_id ON ozon_products(offer_id);
CREATE INDEX IF NOT EXISTS idx_ozon_products_store_id ON ozon_products(store_id);

-- Row Level Security (для anon-ключа)
ALTER TABLE ozon_stores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ozon_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all" ON ozon_stores   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON ozon_products FOR ALL TO anon USING (true) WITH CHECK (true);
