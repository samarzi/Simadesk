-- Indexes for mp_transactions to prevent statement timeout on large stores.
-- Without these, historical queries (year+ of data) hit Postgres timeout.

create index if not exists mp_transactions_store_date_idx
  on mp_transactions (store_id, operation_date desc);

create index if not exists mp_transactions_store_date_asc_idx
  on mp_transactions (store_id, operation_date asc);
