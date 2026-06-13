-- v4: Add end_time column to tasks for time range support
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_time text DEFAULT NULL;
