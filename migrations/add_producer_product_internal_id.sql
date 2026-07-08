-- Добавляем внутренний 5-значный числовой ID для товаров производителей
ALTER TABLE producer_products
  ADD COLUMN IF NOT EXISTS internal_id integer;

-- Заполняем существующие товары уникальными случайными 5-значными ID
DO $$
DECLARE
  r   RECORD;
  new_id integer;
  used  integer[] := ARRAY[]::integer[];
BEGIN
  -- Собираем уже имеющиеся значения (на случай повторного запуска)
  SELECT ARRAY_AGG(internal_id) INTO used
  FROM producer_products
  WHERE internal_id IS NOT NULL;

  IF used IS NULL THEN used := ARRAY[]::integer[]; END IF;

  FOR r IN SELECT id FROM producer_products WHERE internal_id IS NULL ORDER BY created_at LOOP
    LOOP
      new_id := 10000 + floor(random() * 90000)::int;
      EXIT WHEN NOT (new_id = ANY(used));
    END LOOP;
    used := array_append(used, new_id);
    UPDATE producer_products SET internal_id = new_id WHERE id = r.id;
  END LOOP;
END $$;

-- Уникальный индекс — гарантирует что дубли невозможны на уровне БД
CREATE UNIQUE INDEX IF NOT EXISTS idx_producer_products_internal_id
  ON producer_products (internal_id)
  WHERE internal_id IS NOT NULL;
