-- Отдельный токен WB со скоупом «Вопросы и отзывы» (для чатов и отзывов),
-- на случай если основной токен создан без этой категории.
ALTER TABLE wb_stores ADD COLUMN IF NOT EXISTS feedback_api_key text DEFAULT NULL;
