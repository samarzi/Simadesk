-- Tasks v2: subtasks, assignee, flag-based priority
-- Run after the original add_tasks.sql migration

-- Add new columns
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id uuid;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

-- Update priority check constraint: old 5-level → new flag colors
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;

-- Migrate old priority values to new flag colors
UPDATE tasks SET priority = 'red'    WHERE priority = 'urgent';
UPDATE tasks SET priority = 'yellow' WHERE priority = 'high';
UPDATE tasks SET priority = 'blue'   WHERE priority = 'medium';
UPDATE tasks SET priority = 'none'   WHERE priority IN ('low', 'none');

-- Now add the new constraint
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
  CHECK (priority IN ('none','blue','yellow','red'));
