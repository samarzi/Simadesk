-- Add scheduled_date to tasks: when the user plans to work on the task (vs due_date = deadline)
alter table tasks add column if not exists scheduled_date date;
create index if not exists idx_tasks_scheduled on tasks(company_id, scheduled_date);
