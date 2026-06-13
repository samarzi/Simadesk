-- Migration: добавляем поля автосинхронизации товаров в boxes
-- Run in Supabase SQL Editor

ALTER TABLE boxes
  ADD COLUMN IF NOT EXISTS mp_source      TEXT,        -- 'ozon' | 'ym' — откуда синхронизировано
  ADD COLUMN IF NOT EXISTS mp_store_id    TEXT,        -- ID магазина в маркетплейсе
  ADD COLUMN IF NOT EXISTS mp_last_sync   TIMESTAMPTZ; -- когда последний раз синхронизировалось

COMMENT ON COLUMN boxes.mp_source    IS 'Источник автосинхронизации: ozon | ym (null = ручная группа)';
COMMENT ON COLUMN boxes.mp_store_id  IS 'ID магазина маркетплейса для автосинхронизации';
COMMENT ON COLUMN boxes.mp_last_sync IS 'Дата последней автосинхронизации';
