# Skill: system-ops

## Description

Check system health, uptime, memory usage, disk space, and database status. This skill provides **read-only** system diagnostics. It answers questions about how the system is running, surfaces recent errors, and reports resource usage.

## READ-ONLY RESTRICTION

**THIS SKILL IS STRICTLY READ-ONLY.** You must NEVER use this skill to:

- Restart, reboot, or shut down the system or any service
- Kill or stop any process
- Modify any system configuration
- Delete any files or data
- Run any command that changes system state

Restart, reboot, and shutdown operations are handled exclusively by slash commands (`/restart`, `/reboot`, `/stop`) with confirmation prompts. If the user asks you to restart or reboot through conversation, direct them to use the appropriate slash command instead.

## When to Activate

Activate this skill automatically when the user asks about system health or status. Common triggers include:

- "How's the system?" or "Is everything running?"
- "Check disk space" or "How much storage is left?"
- "Memory usage" or "How much RAM is being used?"
- "System uptime" or "How long has the system been running?"
- "Are there any errors?" or "Check for recent problems"
- "Database status" or "Is the database OK?"
- "System health" or "Give me a health check"

## Available Tools

- **Bash** -- Execute read-only shell commands. Only the following commands are permitted:
  - `uptime` -- System uptime
  - `free -h` -- Memory usage
  - `df -h` -- Disk usage
  - `pg_isready` -- PostgreSQL connection check

- **`mcp__pg__query`** -- Execute read-only SQL queries against the PostgreSQL database.

No other tools are permitted for this skill.

## Database Tables (Read-Only Access)

### `system_logs`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of the log entry |
| `level` | TEXT | Log level: `'debug'`, `'info'`, `'warn'`, `'error'` |
| `source` | TEXT | Component name (e.g., `'telegram'`, `'claude'`, `'process'`) |
| `content` | TEXT | Log message content |

### `conversation_messages` (Read-Only Access)

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Auto-incrementing identifier |
| `created_at` | TIMESTAMPTZ | Timestamp of the message |
| `session_id` | TEXT | Claude CLI session ID |
| `role` | TEXT | Message role: `'user'`, `'assistant'`, `'system'`, `'summary'` |
| `content` | TEXT | Message content |

## Operations

### System Uptime

Report how long the system has been running.

```bash
uptime
```

Present the output in a human-readable way (e.g., "The system has been running for 3 days, 4 hours").

### Memory Usage

Check current RAM usage.

```bash
free -h
```

Summarize the key figures: total memory, used memory, available memory. Flag if available memory is critically low (under 10% of total).

### Disk Usage

Check available disk space.

```bash
df -h
```

Focus on the root filesystem and any mounted data partitions. Flag if any partition is above 90% usage.

### Database Status

Check whether PostgreSQL is accepting connections.

```bash
pg_isready
```

Also check the conversation message count as a basic activity indicator:

```sql
SELECT COUNT(*) AS total_messages FROM conversation_messages;
```

And check the most recent conversation activity:

```sql
SELECT created_at AS last_activity
FROM conversation_messages
ORDER BY created_at DESC
LIMIT 1;
```

### Recent Errors

Retrieve the most recent error log entries.

```sql
SELECT created_at, source, content
FROM system_logs
WHERE level = 'error'
ORDER BY created_at DESC
LIMIT 5;
```

If no errors are found, report that clearly: "No recent errors found."

For a broader view including warnings:

```sql
SELECT created_at, level, source, content
FROM system_logs
WHERE level IN ('error', 'warn')
ORDER BY created_at DESC
LIMIT 10;
```

### Full Health Summary

When the user asks for a general health check, run all of the above operations and present a consolidated summary covering:

1. System uptime
2. Memory usage (total / used / available)
3. Disk usage (used / available / percent)
4. Database status (connected / message count / last activity)
5. Recent errors (count and brief summary, or "none")

## Restrictions and Notes

- **READ-ONLY ONLY.** Never run commands that modify system state. No `sudo`, no `kill`, no `systemctl restart`, no `rm`, no writes of any kind.
- Only use the four whitelisted Bash commands: `uptime`, `free -h`, `df -h`, `pg_isready`. Do not execute any other shell commands through this skill.
- Only run SELECT queries against the database. Never INSERT, UPDATE, DELETE, or DROP.
- If the user asks to restart, reboot, or shut down the system, respond: "I can only check system status. To restart or reboot, please use the `/restart` or `/reboot` slash commands."
- Present diagnostic information in a clear, summarized format. Avoid dumping raw command output -- interpret it for the user.
- If any check fails (e.g., `pg_isready` returns an error), report the failure clearly and suggest next steps (e.g., "The database appears to be down. You may want to check the PostgreSQL service.").
