-- 002_scheduled_tasks.sql
-- Scheduled tasks table for the /schedule feature (cron-based task execution)

CREATE TABLE scheduled_tasks (
  id              SERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chat_id         TEXT NOT NULL,                -- Telegram chat ID for delivering results
  cron_expression TEXT NOT NULL,                -- Standard 5-field cron: min hour dom month dow
  task_prompt     TEXT NOT NULL,                -- Prompt sent to Claude when the task fires
  description     TEXT NOT NULL DEFAULT '',     -- Human-readable description
  timezone        TEXT NOT NULL DEFAULT 'UTC',  -- IANA timezone (e.g. 'America/New_York')
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  error_count     INTEGER NOT NULL DEFAULT 0,   -- Consecutive error count for backoff
  last_error      TEXT                          -- Last error message, if any
);

CREATE INDEX idx_scheduled_tasks_next_run
  ON scheduled_tasks (next_run_at)
  WHERE enabled = TRUE;

CREATE INDEX idx_scheduled_tasks_chat_id
  ON scheduled_tasks (chat_id);
