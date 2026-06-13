-- Детальный лог изменений цен и таблица ошибок API для серверного MRC-репрайсера.

create table if not exists repricer_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  rule_id text,
  marketplace text not null,
  store_name text,
  product_id text,
  vendor_code text,
  product_title text,
  old_seller_price numeric,
  new_seller_price numeric,
  old_buyer_price numeric,
  verified_buyer_price numeric,
  target_mrc_price numeric,
  action text not null,
  api_request jsonb,
  api_response jsonb,
  success boolean not null default true,
  error text
);

create index if not exists repricer_events_created_at_idx on repricer_events (created_at desc);
create index if not exists repricer_events_rule_id_idx on repricer_events (rule_id);

create table if not exists repricer_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  marketplace text not null,
  product_id text,
  request jsonb,
  response jsonb,
  http_status int,
  error text
);

create index if not exists repricer_errors_created_at_idx on repricer_errors (created_at desc);

alter table repricer_events enable row level security;
alter table repricer_errors enable row level security;

create policy "service role full access repricer_events" on repricer_events
  for all using (true) with check (true);

create policy "service role full access repricer_errors" on repricer_errors
  for all using (true) with check (true);
