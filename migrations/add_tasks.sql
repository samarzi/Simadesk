-- ============================================================================
-- Tasks & Reminders tables for TaskManager module
-- Run against Supabase via SQL editor or CLI migration
-- ============================================================================

-- ── Tasks ────────────────────────────────────────────────────────────────────

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  title       text not null default '',
  description text not null default '',
  status      text not null default 'todo'
                check (status in ('todo','in_progress','done')),
  priority    text not null default 'none'
                check (priority in ('none','low','medium','high','urgent')),
  due_date    date,                          -- YYYY-MM-DD, nullable
  due_time    time without time zone,        -- HH:MM, nullable
  all_day     boolean not null default true,
  tags        text not null default '',      -- comma-separated
  sort_order  int not null default 0,
  completed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Auto-update updated_at
create or replace function update_tasks_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function update_tasks_updated_at();

-- Index for fast company lookups
create index if not exists idx_tasks_company on tasks(company_id);
create index if not exists idx_tasks_due     on tasks(company_id, due_date);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table tasks enable row level security;

create policy "tasks_select" on tasks for select using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "tasks_insert" on tasks for insert with check (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "tasks_update" on tasks for update using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "tasks_delete" on tasks for delete using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

-- ── Reminders ────────────────────────────────────────────────────────────────

create table if not exists reminders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  task_id     uuid references tasks(id) on delete set null,
  title       text not null default '',
  remind_at   timestamptz not null,
  repeat      text not null default 'none'
                check (repeat in ('none','daily','weekly','monthly')),
  dismissed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_reminders_company on reminders(company_id);
create index if not exists idx_reminders_due     on reminders(company_id, remind_at);

alter table reminders enable row level security;

create policy "reminders_select" on reminders for select using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "reminders_insert" on reminders for insert with check (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "reminders_update" on reminders for update using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);

create policy "reminders_delete" on reminders for delete using (
  company_id in (
    select cm.company_id from company_members cm
    where cm.user_id = auth.uid()
  )
);
