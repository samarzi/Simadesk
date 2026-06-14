-- Реальные цены покупателя (с учётом СПП) для товаров Wildberries,
-- собираемые расширением SimaDesk с публичных страниц wildberries.ru.

create table if not exists wb_buyer_prices (
  nm_id bigint primary key,
  vendor_code text,
  buyer_price numeric not null,
  product_title text,
  checked_at timestamptz not null default now()
);

create index if not exists wb_buyer_prices_checked_at_idx on wb_buyer_prices (checked_at desc);

alter table wb_buyer_prices enable row level security;

create policy "service role full access wb_buyer_prices" on wb_buyer_prices
  for all using (true) with check (true);
