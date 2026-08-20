-- Таблица настроек Симы: промты, правила, инструкции — редактируются в админ-панели
CREATE TABLE IF NOT EXISTS sima_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,   -- уникальный ключ секции
  title       TEXT NOT NULL,          -- Название секции
  description TEXT,                   -- Подсказка для редактора
  value       TEXT NOT NULL DEFAULT '',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sima_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sima_config_read"   ON sima_config;
DROP POLICY IF EXISTS "sima_config_insert" ON sima_config;
DROP POLICY IF EXISTS "sima_config_update" ON sima_config;
DROP POLICY IF EXISTS "sima_config_delete" ON sima_config;

-- Читают авторизованные (конфиг — не публичный)
CREATE POLICY "sima_config_read"   ON sima_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "sima_config_insert" ON sima_config FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "sima_config_update" ON sima_config FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "sima_config_delete" ON sima_config FOR DELETE TO authenticated USING (true);

-- Стартовые записи (пустые — заполняются из кода как дефолт если не переопределены)
INSERT INTO sima_config (key, title, description, value, is_active) VALUES
(
  'persona',
  'Персона',
  'Кто такая Сима: имя, роль, стиль общения. Этот блок идёт первым в системный промт.',
  '',
  true
),
(
  'extra_rules',
  'Дополнительные правила',
  'Правила поведения добавляются в конец системного промта. Можно ограничить темы, добавить запреты, изменить стиль ответов.',
  '',
  true
),
(
  'extra_knowledge',
  'Дополнительные знания',
  'Дополнительные данные о вашем бизнесе, специфике работы, особых условиях — Сима будет использовать в ответах.',
  '',
  true
),
(
  'system_prompt_override',
  'Полный системный промт (перезапись)',
  'Если заполнено — полностью заменяет встроенный промт. Оставь пустым чтобы использовать дефолтный. Кнопка «Загрузить дефолт» заполнит текущий встроенный промт.',
  '',
  false
)
ON CONFLICT (key) DO NOTHING;

-- Триггер updated_at
CREATE OR REPLACE FUNCTION update_sima_config_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS sima_config_updated_at ON sima_config;
CREATE TRIGGER sima_config_updated_at
  BEFORE UPDATE ON sima_config
  FOR EACH ROW EXECUTE FUNCTION update_sima_config_updated_at();
