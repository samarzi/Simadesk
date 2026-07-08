-- Добавляем UPDATE policy для analytics_orders_cache.
-- Нужна для upsert через Prefer: resolution=merge-duplicates (saveMonth в orderSyncService).

create policy "analytics_cache_update" on analytics_orders_cache
  for update using (
    store_id in (
      select id::text from ozon_stores    where company_id in (select user_company_ids())
      union all
      select id::text from wb_stores      where company_id in (select user_company_ids())
      union all
      select id::text from yandex_stores  where company_id in (select user_company_ids())
    )
  );
