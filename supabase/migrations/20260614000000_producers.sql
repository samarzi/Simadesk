-- ============================================================================
-- SimaDesk — раздел «Производители» (универсальный, для любых товаров)
-- Аналог ChairProd: справочник поставщиков + их товары + связки с МП +
-- автоматическая генерация заявок/документов поставки.
-- ============================================================================

-- ─── Производители / поставщики ─────────────────────────────────────────────
create table if not exists producers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  name            text not null,
  prefix          text default '',
  -- режим работы: 'consignment' (реализация) | 'supply' (поставка) | 'both'
  workflow        text not null default 'consignment',
  -- тип Excel-вывода: 'new' (создать новый) | 'template' (заполнить шаблон)
  output_type     text not null default 'new',
  template_url    text,                          -- ссылка на загруженный xlsx в Supabase Storage
  template_config jsonb,                         -- { article_column, name_column, qty_column, start_row }
  output_config   jsonb,                         -- { show_article, show_name, qty_column }
  contacts        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists producers_company_idx on producers (company_id);

-- ─── Кастомные поля товара (универсальные, применяются ко всем товарам) ──
create table if not exists producer_field_defs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  name            text not null,
  field_type      text not null default 'mixed',  -- text | number | mixed | dropdown
  dropdown_options jsonb,                          -- string[]
  is_locked       boolean not null default false,
  show_in_filters boolean not null default false,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);

create unique index if not exists producer_field_defs_company_name_idx
  on producer_field_defs (company_id, name);

-- ─── Товары производителей ──────────────────────────────────────────────────
create table if not exists producer_products (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  producer_id   uuid not null references producers(id) on delete cascade,
  name          text not null,
  articles      text[] not null default '{}',     -- основной + до 4 доп. артикулов
  field_values  jsonb not null default '{}',      -- { field_def_id: value }
  comment       text,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists producer_products_company_idx
  on producer_products (company_id);
create index if not exists producer_products_producer_idx
  on producer_products (producer_id);
create index if not exists producer_products_articles_gin
  on producer_products using gin (articles);

-- ─── Связки артикул маркетплейса → товар производителя ──────────────────────
create table if not exists producer_mappings (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  marketplace_article text not null,
  producer_product_id uuid not null references producer_products(id) on delete cascade,
  quantity            numeric not null default 1,
  created_at          timestamptz not null default now()
);

create index if not exists producer_mappings_company_idx
  on producer_mappings (company_id);
create index if not exists producer_mappings_article_idx
  on producer_mappings (company_id, marketplace_article);

-- ─── Заказы для отработки (реализация) ──────────────────────────────────────
-- Можно добавлять вручную или импортом xlsx. Не зависит от orders маркетплейсов
-- (хотя в будущем можно сделать перенос).
create table if not exists producer_orders (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  external_id         text,                                -- посторонний id заказа (опционально)
  marketplace_article text not null,
  product_name        text not null default '',
  quantity            integer not null default 1,
  status              text not null default 'new',         -- new | accepted | done | cancelled
  source              text,                                -- 'manual' | 'xlsx' | 'ozon' и т.п.
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists producer_orders_company_idx
  on producer_orders (company_id);
create index if not exists producer_orders_status_idx
  on producer_orders (company_id, status);

-- ─── История сгенерированных документов ─────────────────────────────────────
create table if not exists producer_documents (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  producer_id uuid references producers(id) on delete set null,
  doc_type    text not null,                                -- 'consignment' | 'supply' | 'template'
  file_url    text,                                         -- ссылка в Storage (если выгружали)
  file_name   text,
  items       jsonb not null default '[]',                  -- snapshot позиций
  order_ids   uuid[] default '{}',                          -- ссылки на producer_orders (если consignment)
  total_qty   numeric default 0,
  created_at  timestamptz not null default now()
);

create index if not exists producer_documents_company_idx
  on producer_documents (company_id);

-- ─── RLS: доступ только участникам компании ─────────────────────────────────
alter table producers           enable row level security;
alter table producer_field_defs enable row level security;
alter table producer_products   enable row level security;
alter table producer_mappings   enable row level security;
alter table producer_orders     enable row level security;
alter table producer_documents  enable row level security;

-- helper: проверка членства в компании
-- (используется тот же подход, что и в остальных таблицах SimaDesk —
--  через таблицу company_members)
do $$
begin
  -- producers
  drop policy if exists producers_company_member on producers;
  create policy producers_company_member on producers for all
    using (
      exists (select 1 from company_members cm
              where cm.company_id = producers.company_id
                and cm.user_id = auth.uid())
    )
    with check (
      exists (select 1 from company_members cm
              where cm.company_id = producers.company_id
                and cm.user_id = auth.uid())
    );

  drop policy if exists producer_field_defs_company_member on producer_field_defs;
  create policy producer_field_defs_company_member on producer_field_defs for all
    using (exists (select 1 from company_members cm where cm.company_id = producer_field_defs.company_id and cm.user_id = auth.uid()))
    with check (exists (select 1 from company_members cm where cm.company_id = producer_field_defs.company_id and cm.user_id = auth.uid()));

  drop policy if exists producer_products_company_member on producer_products;
  create policy producer_products_company_member on producer_products for all
    using (exists (select 1 from company_members cm where cm.company_id = producer_products.company_id and cm.user_id = auth.uid()))
    with check (exists (select 1 from company_members cm where cm.company_id = producer_products.company_id and cm.user_id = auth.uid()));

  drop policy if exists producer_mappings_company_member on producer_mappings;
  create policy producer_mappings_company_member on producer_mappings for all
    using (exists (select 1 from company_members cm where cm.company_id = producer_mappings.company_id and cm.user_id = auth.uid()))
    with check (exists (select 1 from company_members cm where cm.company_id = producer_mappings.company_id and cm.user_id = auth.uid()));

  drop policy if exists producer_orders_company_member on producer_orders;
  create policy producer_orders_company_member on producer_orders for all
    using (exists (select 1 from company_members cm where cm.company_id = producer_orders.company_id and cm.user_id = auth.uid()))
    with check (exists (select 1 from company_members cm where cm.company_id = producer_orders.company_id and cm.user_id = auth.uid()));

  drop policy if exists producer_documents_company_member on producer_documents;
  create policy producer_documents_company_member on producer_documents for all
    using (exists (select 1 from company_members cm where cm.company_id = producer_documents.company_id and cm.user_id = auth.uid()))
    with check (exists (select 1 from company_members cm where cm.company_id = producer_documents.company_id and cm.user_id = auth.uid()));
end $$;

-- ─── Триггеры на updated_at ─────────────────────────────────────────────────
create or replace function producers_touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end;
$$ language plpgsql;

drop trigger if exists producers_set_updated_at on producers;
create trigger producers_set_updated_at
  before update on producers
  for each row execute function producers_touch_updated_at();

drop trigger if exists producer_products_set_updated_at on producer_products;
create trigger producer_products_set_updated_at
  before update on producer_products
  for each row execute function producers_touch_updated_at();

drop trigger if exists producer_orders_set_updated_at on producer_orders;
create trigger producer_orders_set_updated_at
  before update on producer_orders
  for each row execute function producers_touch_updated_at();
