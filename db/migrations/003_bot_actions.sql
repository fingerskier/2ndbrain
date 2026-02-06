-- 003_bot_actions.sql
-- Structured bot action tracking for troubleshooting and insight

CREATE TABLE bot_actions (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action      TEXT NOT NULL,           -- e.g. message_received, claude_invoked, command_executed, message_sent, scheduled_task_run, error
  status      TEXT NOT NULL DEFAULT 'ok',  -- ok, error
  source      TEXT,                    -- component: telegram, claude, commands, scheduler, attachments
  duration_ms INTEGER,                 -- how long the action took (if applicable)
  detail      JSONB                    -- action-specific metadata
);

CREATE INDEX idx_bot_actions_created ON bot_actions (created_at DESC);
CREATE INDEX idx_bot_actions_action  ON bot_actions (action);
CREATE INDEX idx_bot_actions_status  ON bot_actions (status) WHERE status = 'error';
