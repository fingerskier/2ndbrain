# Skill: scheduler

## Description

Create, list, update, and delete scheduled tasks. Use this skill when the user wants to set up recurring actions that run on a cron schedule. The user describes the task and schedule in natural language; you parse it into a cron expression and a task prompt, then persist it to the database. A background worker executes each task at its scheduled time by sending the prompt to Claude and delivering the response to the user's Telegram chat.

## When to Activate

Activate this skill when any of the following conditions are met:

- The user's message begins with `/schedule`
- The user wants to set up a recurring task (e.g., "every morning remind me to...", "schedule a daily check on...", "run this every Monday")
- The user asks about their scheduled tasks (e.g., "what's scheduled", "list my schedules", "show my cron jobs")
- The user wants to modify or cancel a scheduled task (e.g., "stop the daily reminder", "change the schedule to weekly", "disable schedule #3")

## Available Tools

- `mcp__pg__query` -- Execute SQL queries against the PostgreSQL database.

No other tools are permitted for this skill.

## Context

The current Telegram `chat_id` is provided in the system prompt as `Current Telegram chat_id: <value>`. You MUST use this value when inserting or querying scheduled tasks to scope operations to the current user's chat.

## Database Tables

### `scheduled_tasks`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of creation |
| `updated_at` | TIMESTAMPTZ | Timestamp of last update |
| `chat_id` | TEXT NOT NULL | Telegram chat ID (from system prompt) |
| `cron_expression` | TEXT NOT NULL | Standard 5-field cron: minute hour day-of-month month day-of-week |
| `task_prompt` | TEXT NOT NULL | The prompt sent to Claude when the task fires |
| `description` | TEXT NOT NULL DEFAULT '' | Human-readable description of the task |
| `timezone` | TEXT NOT NULL DEFAULT 'UTC' | IANA timezone for cron evaluation |
| `enabled` | BOOLEAN NOT NULL DEFAULT TRUE | Whether the task is active |
| `last_run_at` | TIMESTAMPTZ | When the task last executed |
| `next_run_at` | TIMESTAMPTZ | Pre-computed next execution time |
| `error_count` | INTEGER NOT NULL DEFAULT 0 | Consecutive error count |
| `last_error` | TEXT | Most recent error message |

## Cron Expression Reference

Standard 5-field cron format: `minute hour day-of-month month day-of-week`

| Field | Values | Special Characters |
|-------|--------|--------------------|
| Minute | 0-59 | `*` `,` `-` `/` |
| Hour | 0-23 | `*` `,` `-` `/` |
| Day of Month | 1-31 | `*` `,` `-` `/` |
| Month | 1-12 | `*` `,` `-` `/` |
| Day of Week | 0-6 (0=Sunday) | `*` `,` `-` `/` |

### Common Patterns

| Natural Language | Cron Expression |
|-----------------|-----------------|
| every day at 8am | `0 8 * * *` |
| every weekday at 9am | `0 9 * * 1-5` |
| every Monday at 10am | `0 10 * * 1` |
| every hour | `0 * * * *` |
| every 30 minutes | `*/30 * * * *` |
| every 15 minutes | `*/15 * * * *` |
| first of every month at noon | `0 12 1 * *` |
| every Sunday at 6pm | `0 18 * * 0` |
| twice a day (8am and 8pm) | `0 8,20 * * *` |
| every weekday at 5pm | `0 17 * * 1-5` |
| every 6 hours | `0 */6 * * *` |

## Operations

### List All Scheduled Tasks (No Arguments)

When the user sends `/schedule` with no additional text, list all their tasks:

```sql
SELECT id, description, cron_expression, timezone, enabled,
       last_run_at, next_run_at, error_count, last_error
FROM scheduled_tasks
WHERE chat_id = '<chat_id>'
ORDER BY created_at DESC;
```

Present as a concise listing showing: ID, description, schedule (human-readable interpretation of the cron), enabled status, and next run time. If no tasks exist, respond: "No scheduled tasks found. Send `/schedule <description>` to create one."

Example format:
```
Your Scheduled Tasks:

#1 - Check project status
  Schedule: Every day at 8:00 AM (UTC)
  Status: Enabled
  Next run: 2026-02-01 08:00 UTC

#2 - Weekly team summary
  Schedule: Every Monday at 9:00 AM (America/New_York)
  Status: Disabled (5 errors)
  Last error: Claude subprocess timed out
```

### Create a Scheduled Task

When the user sends `/schedule` followed by a natural language description, parse it:

1. **Extract the schedule** from the natural language and convert to a 5-field cron expression.
2. **Extract the task prompt** -- this is what Claude will be asked to do when the task fires. Formulate it as a clear, actionable prompt. For example, if the user says "remind me to check my project status", the task prompt should be something like: "Check my project status and give me a summary of open issues across all projects."
3. **Extract or infer the timezone** -- if the user mentions a timezone, use it. Otherwise default to UTC. If unclear, ask.
4. **Write a human-readable description** summarizing the task.

```sql
INSERT INTO scheduled_tasks (chat_id, cron_expression, task_prompt, description, timezone)
VALUES ('<chat_id>', '<cron>', '<task_prompt>', '<description>', '<timezone>')
RETURNING id, cron_expression, task_prompt, description, timezone;
```

After creating, confirm with the user:
```
Scheduled task created:
  #<id> - <description>
  Schedule: <human-readable cron interpretation> (<timezone>)
  Prompt: "<task_prompt>"

The task will first run at <next computed time>. The background scheduler picks up new tasks within 60 seconds.
```

**Important:** Do NOT set `next_run_at` yourself. The background scheduler worker computes and sets `next_run_at` automatically when it detects new tasks with a NULL `next_run_at`.

### Update a Scheduled Task

When the user wants to change the schedule, prompt, or description of an existing task.

First, verify the task belongs to this chat:

```sql
SELECT id, description, cron_expression, task_prompt, timezone
FROM scheduled_tasks
WHERE id = <task_id> AND chat_id = '<chat_id>';
```

Then update the requested fields:

```sql
UPDATE scheduled_tasks
SET cron_expression = '<new_cron>',
    task_prompt = '<new_prompt>',
    description = '<new_description>',
    timezone = '<new_timezone>',
    next_run_at = NULL,
    updated_at = NOW()
WHERE id = <task_id> AND chat_id = '<chat_id>';
```

Setting `next_run_at = NULL` forces the scheduler worker to recompute it on the next poll.

### Enable / Disable a Task

```sql
UPDATE scheduled_tasks
SET enabled = TRUE, error_count = 0, last_error = NULL,
    next_run_at = NULL, updated_at = NOW()
WHERE id = <task_id> AND chat_id = '<chat_id>';
```

```sql
UPDATE scheduled_tasks
SET enabled = FALSE, updated_at = NOW()
WHERE id = <task_id> AND chat_id = '<chat_id>';
```

When re-enabling, reset `error_count` and `last_error`, and set `next_run_at = NULL` so the scheduler recomputes it.

### Delete a Scheduled Task

When the user wants to permanently remove a task.

```sql
DELETE FROM scheduled_tasks
WHERE id = <task_id> AND chat_id = '<chat_id>';
```

Confirm deletion to the user. If the task ID does not exist or does not belong to this chat, say so.

### Search Scheduled Tasks

```sql
SELECT id, description, cron_expression, timezone, enabled
FROM scheduled_tasks
WHERE chat_id = '<chat_id>'
  AND (description ILIKE '%' || '<search_term>' || '%'
       OR task_prompt ILIKE '%' || '<search_term>' || '%')
ORDER BY created_at DESC;
```

## Restrictions and Notes

- Always use `mcp__pg__query` for database operations. Do not use any other tool.
- Always scope queries with `chat_id = '<chat_id>'` using the chat ID from the system prompt. Never access another chat's tasks.
- When the user refers to a task by number (e.g., "disable #3" or "delete task 3"), use that as the `id`.
- If the user's schedule description is ambiguous (e.g., "every morning" -- what time exactly?), ask for clarification rather than guessing.
- The cron expression must be valid 5-field format. Do not use 6-field (with seconds) or non-standard extensions.
- When listing tasks, always translate the cron expression into human-readable language (e.g., `0 8 * * 1-5` = "Every weekday at 8:00 AM").
- Task prompts should be self-contained and actionable -- the Claude instance executing them will not have the original conversation context. Write prompts that make sense in isolation.
- Do not set or modify `next_run_at`, `last_run_at`, `error_count`, or `last_error` when creating or updating tasks. These are managed by the scheduler worker.
