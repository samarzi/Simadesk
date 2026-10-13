-- Кэш заказов должен разделяться не только по магазину и месяцу, но и по МП.
-- Иначе одинаковый store_id (или старые записи после миграции) мог отдавать
-- чужой формат заказа, а upsert не обновлял строку надёжно.

delete from analytics_orders_cache a
using analytics_orders_cache b
where a.store_id = b.store_id
  and a.mp = b.mp
  and a.chunk_from = b.chunk_from
  and a.chunk_to = b.chunk_to
  and (a.cached_at, a.id) < (b.cached_at, b.id);

alter table analytics_orders_cache
  drop constraint if exists analytics_orders_cache_store_id_chunk_from_chunk_to_key;

alter table analytics_orders_cache
  add constraint analytics_orders_cache_store_mp_chunk_key
  unique (store_id, mp, chunk_from, chunk_to);

create index if not exists analytics_orders_cache_store_mp_idx
  on analytics_orders_cache (store_id, mp, chunk_from, chunk_to);
