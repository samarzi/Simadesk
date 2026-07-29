-- Extra product fields: description, vat, barcode, characteristics
-- Filled during marketplace sync; shown and (where supported) editable in Товары section.

-- ── Ozon ─────────────────────────────────────────────────────────────────────
alter table ozon_products
  add column if not exists vat         text    default '',
  add column if not exists description text    default '';

-- ── WB ───────────────────────────────────────────────────────────────────────
alter table wb_products
  add column if not exists description    text    default '',
  add column if not exists characteristics jsonb   default '[]',
  add column if not exists barcode        text    default '';

-- ── Yandex Market ─────────────────────────────────────────────────────────────
alter table yandex_products
  add column if not exists description text default '',
  add column if not exists vat         text default '',
  add column if not exists barcode     text default '';
