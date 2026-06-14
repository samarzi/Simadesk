-- Реальные цены покупателя (без скидки по Ozon Карте) для товаров Ozon,
-- собираемые расширением SimaDesk с публичных страниц ozon.ru.

create table if not exists ozon_buyer_prices (
  product_id bigint primary key,
  offer_id text,
  buyer_price numeric not null,
  product_title text,
  checked_at timestamptz not null default now()
);

create index if not exists ozon_buyer_prices_checked_at_idx on ozon_buyer_prices (checked_at desc);

alter table ozon_buyer_prices enable row level security;

create policy "service role full access ozon_buyer_prices" on ozon_buyer_prices
  for all using (true) with check (true);
