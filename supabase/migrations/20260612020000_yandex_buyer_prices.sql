-- Реальные цены покупателя (с учётом Буста) для товаров Yandex Market,
-- собираемые локальным watcher-скриптом (Playwright) с публичных страниц market.yandex.ru.

create table if not exists yandex_buyer_prices (
  market_sku bigint primary key,
  offer_id text,
  buyer_price numeric not null,
  base_price numeric,
  product_title text,
  checked_at timestamptz not null default now()
);

create index if not exists yandex_buyer_prices_checked_at_idx on yandex_buyer_prices (checked_at desc);

alter table yandex_buyer_prices enable row level security;

create policy "service role full access yandex_buyer_prices" on yandex_buyer_prices
  for all using (true) with check (true);
