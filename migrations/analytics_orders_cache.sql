-- Analytics raw orders cache: stores raw API responses per store per 30-day chunk.
-- Chunks where end_date < today - 7 are "settled" (orders won't change) and are cached forever.
-- This avoids re-fetching historical data from slow marketplace APIs on every analytics open.

create table if not exists analytics_orders_cache (
  id         bigserial primary key,
  store_id   text        not null,
  mp         text        not null,  -- 'ozon' | 'wb' | 'yandex'
  chunk_from date        not null,
  chunk_to   date        not null,
  data       jsonb       not null,  -- raw API response array (OzonPosting[] | WbOrder[] | YandexOrder[])
  cached_at  timestamptz not null default now(),
  unique (store_id, chunk_from, chunk_to)
);

-- Index for fast range lookups
create index if not exists analytics_orders_cache_store_idx
  on analytics_orders_cache (store_id, chunk_from, chunk_to);

alter table analytics_orders_cache enable row level security;

-- Users can access cache entries only for their own company's stores
create policy "analytics_cache_select" on analytics_orders_cache
  for select using (
    store_id in (
      select id::text from ozon_stores    where company_id in (select user_company_ids())
      union all
      select id::text from wb_stores      where company_id in (select user_company_ids())
      union all
      select id::text from yandex_stores  where company_id in (select user_company_ids())
    )
  );

create policy "analytics_cache_insert" on analytics_orders_cache
  for insert with check (
    store_id in (
      select id::text from ozon_stores    where company_id in (select user_company_ids())
      union all
      select id::text from wb_stores      where company_id in (select user_company_ids())
      union all
      select id::text from yandex_stores  where company_id in (select user_company_ids())
    )
  );

create policy "analytics_cache_delete" on analytics_orders_cache
  for delete using (
    store_id in (
      select id::text from ozon_stores    where company_id in (select user_company_ids())
      union all
      select id::text from wb_stores      where company_id in (select user_company_ids())
      union all
      select id::text from yandex_stores  where company_id in (select user_company_ids())
    )
  );
