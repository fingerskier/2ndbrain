# 2ndbrain Specification

**Version:** 0.5.0
**Status:** RFC
**Date:** 2026-01-30


## 1. Overview

**2ndbrain** is an always-on Node.js service that bridges Telegram messaging to Claude AI. It runs on a local network device (e.g. Raspberry Pi 5) and provides a single owner with a persistent, private AI assistant accessible via Telegram, with a local web interface for configuration and monitoring.

The service spawns `claude-cli` as a subprocess to handle AI interactions, maintains conversation history in PostgreSQL, supports slash commands for system control, and enforces access through independent whitelists for Telegram users, local commands, MCP tools, and admin features.

Running `npx 2ndbrain` starts both the background service and the web admin interface, automatically opening the browser. On first run the browser opens to the Settings page for initial configuration; on subsequent runs it opens to the Dashboard.

The service includes a personal knowledge platform with a knowledge graph, vector embeddings, journaling, and project management -- all accessible through natural conversation.


## 2. Architecture

```
+------------------+       +------------------+       +------------------+
|    Telegram      | <---> |  Command Router  | ----> | Slash Command    |
|    Bot Adapter   |       |                  |       | Handlers         |
| (long-polling)   |       +--------+---------+       +------------------+
+------------------+                |
                                    | conversational messages
                                    v
                           +--------+---------+
                           |  Claude Bridge   |
                           | (claude-cli      |
                           |  subprocess)     |
                           +--------+---------+
                                    |
                              +-----+-----+
                              |           |
                              v           v
                    +---------+--+  +-----+---------+
                    | MCP Tool   |  | Conversation  |
                    | Layer      |  | Manager       |
                    | (pg, cmds) |  | (history,     |
                    +-----+------+  |  compaction)  |
                          |         +-----+---------+
                          |               |
                          v               v
                    +-----+---------------+------+
                    |       PostgreSQL            |
                    |       Database              |
                    +---+---+---+---+---+---+----+
                        |   |   |   |   |   |
  +---------------------+   |   |   |   |   +-------------------+
  |             +-----------+   |   |   +----------+            |
  v             v               v   v              v            v
+------+  +---------+  +----------+ +--------+ +-------+ +----------+
|Attach|  |Knowledge|  |Embeddings| |Projects| |Journal| |System    |
|ments |  |Graph    |  |Engine    | |& Issues| |       | |Logs      |
+------+  +---------+  +----------+ +--------+ +-------+ +----------+

+------------------+
| Web Admin        |
| Server (Express) |
| - Dashboard      |
| - Settings       |
| - Logs           |
+------------------+
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **Telegram Bot Adapter** | Long-polling listener via Telegram Bot API. Receives messages and attachments, sends responses, manages "Typing" indicator. |
| **Command Router** | Parses incoming messages. Routes `/` prefixed messages to slash command handlers; all others to the Claude Bridge. |
| **Claude Bridge** | Spawns `claude-cli` as a child process with conversation context. Passes MCP configuration and tool whitelist. Captures stdout response. |
| **MCP Tool Layer** | Locally-registered MCP servers available to Claude. Includes PostgreSQL MCP, `embed_query` tool, and whitelisted local shell commands. |
| **Conversation Manager** | Persists conversation turns to `conversation_messages`. Handles auto-compaction when history exceeds a threshold. |
| **Database Layer** | PostgreSQL connection pool. Schema migrations. |
| **Process Manager** | Startup sequence, graceful shutdown (SIGTERM/SIGINT), restart, health checks, error notification to owner, rate limiting. |
| **Attachment Store** | Saves received Telegram file attachments to `~/data/attachments/YYYY/MM/DD/{uuid}.{ext}`. Attachments are also included in the conversation context sent to Claude (e.g., images as vision input). |
| **Web Admin Server** | Express HTTP server for dashboard, settings, and log viewing. Always starts with the service. Auto-opens the default browser on launch (Settings page on first run; Dashboard on subsequent runs). LAN-only binding. |
| **Knowledge Platform** | Knowledge graph (nodes & edges), journal, project management (projects, specifications, issues), and embeddings engine (pgvector-backed semantic search). |


## 3. Telegram Bot Adapter

The adapter connects to Telegram via long-polling and handles all message I/O.

| Property | Value |
|----------|-------|
| Polling method | Long-polling (`getUpdates`) -- no public URL required |
| Supported inbound types | text, photo, document, audio, video, voice (attachments are stored and forwarded to Claude as conversation context) |
| Response format | Markdown (Telegram MarkdownV2) |
| Max message length | 4096 characters; longer responses chunked into multiple messages |
| Typing indicator | Sent before Claude invocation; refreshed every 4s on long responses |
| Reply behavior | Bot sends each response as a reply to the triggering user message (`reply_to_message_id`). Provides visual threading in the Telegram UI, but conversation history remains flat (single linear context). |

**Access control:** Only whitelisted Telegram user IDs may interact with the bot. Messages from non-whitelisted users are silently dropped and logged (see §14).

See also: §4 (Command Router), §8 (Attachment Store), §14 (Security Model), §18 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`)


## 4. Command Router

Parses incoming messages and routes them:
- Messages prefixed with `/` are dispatched to slash command handlers
- All other messages are forwarded to the Claude Bridge (§5)

### Slash Commands

| Command | Args | Description | Response |
|---------|------|-------------|----------|
| `/status` | none | System status summary | Uptime, memory usage, message count, last activity |
| `/health` | none | Health check | OK / degraded / error with component details |
| `/stop` | none | Graceful shutdown | Confirmation message, then process exit |
| `/restart` | none | Process restart | Confirmation prompt; on confirm, restart process |
| `/reboot` | none | OS reboot | Confirmation prompt; on confirm, `sudo reboot` |
| `/new` | none | Start new conversation session | Confirmation; old session preserved in logs |
| `/help` | none | List available commands | Command list with descriptions |

`/restart` and `/reboot` require explicit confirmation reply before execution (see §14.4). `/new` starts a fresh Claude session; the previous session remains accessible in logs and search.

See also: §5 (Claude Bridge), §14.4 (Dangerous Operations)


## 5. Claude Bridge

Spawns `claude -p` (print mode) as a child process for each conversational message. The CLI manages its own conversation context via sessions; 2ndbrain tracks the `session_id` for continuations.

### Invocation Pattern

```bash
# First message (new session):
claude -p \
  --output-format stream-json --verbose \
  --model $CLAUDE_MODEL \
  --system-prompt "$SYSTEM_PROMPT" \
  --mcp-config $MCP_CONFIG_PATH \
  --allowed-tools "$MCP_TOOLS_WHITELIST" \
  [--max-budget-usd $CLAUDE_MAX_BUDGET] \
  "$user_message"

# Continuation (existing session):
claude -p \
  --output-format stream-json --verbose \
  --resume $SESSION_ID \
  "$user_message"
```

For long messages or messages with special characters, pipe via stdin:
```bash
echo "$user_message" | claude -p --resume $SESSION_ID
```

### Behavior

- **Streaming output:** `stream-json` format emits `{"type":"assistant",...}` chunks during generation (used to refresh the Telegram typing indicator) and a final `{"type":"result",...}` object containing `session_id`, `total_cost_usd`, and token usage.
- **Session management:** The `session_id` from the result object is stored and passed back via `--resume` on subsequent messages. See §6 for session lifecycle.
- **System prompt:** Assembled by the `on_pre_claude` lifecycle hook (§13.1). Includes current date/time, user preferences, and skill instructions.
- **MCP configuration:** `--mcp-config` points to the runtime MCP config file. The CLI also loads MCP servers from `~/.claude/settings.json`.
- **Tool whitelist:** `--allowed-tools` enforces `MCP_TOOLS_WHITELIST` at the CLI level.
- **Cost control:** `--max-budget-usd` caps cost per invocation (optional, see `CLAUDE_MAX_BUDGET` in §18).
- **stderr** monitored for errors.
- **Process timeout** enforced by killing the subprocess after `CLAUDE_TIMEOUT` ms.

See also: §6 (Conversation Manager -- session lifecycle), §7 (MCP Tool Layer), §12 (Claude Skills), §13 (Claude Hooks), §18 (`CLAUDE_MODEL`, `CLAUDE_TIMEOUT`, `CLAUDE_MAX_BUDGET`)


## 6. Conversation Manager

Persists all conversation turns to the `conversation_messages` table, manages Claude CLI sessions, and controls history size through auto-compaction.

### Session Management

The Claude CLI manages its own conversation context internally via sessions. 2ndbrain tracks the active `session_id` and passes it back to the CLI via `--resume` (see §5).

**Session lifecycle:**
- **New session** is created when: the service starts for the first time, the user sends `/new`, or the previous session encounters an unrecoverable error.
- **Active session** continues via `--resume $SESSION_ID` on each subsequent message.
- **Session ID** is captured from the `session_id` field in the CLI's JSON result object and stored in the `conversation_messages` table.

### Persistence

Every user message and assistant response is stored with role, content, `session_id`, and metadata (tool calls, attachments, `telegram_message_id` for reply threading). The `conversation_messages` table serves as a log and search index; the CLI manages the actual conversation context used for generation.

### Auto-Compaction

Compaction runs only when no Claude subprocess is active (prevents race conditions).

When `conversation_messages` count exceeds `HISTORY_COMPACT_THRESHOLD`:

1. Select the oldest N messages (where N = threshold - 20, keeping the 20 most recent verbatim)
2. Send the old messages to Claude with a summarization prompt
3. Insert a single `role='summary'` message with the condensed context
4. Archive or delete the original old messages
5. Log the compaction event

See also: §17.1 (`conversation_messages` table), §18 (`HISTORY_COMPACT_THRESHOLD`)


## 7. MCP Tool Layer

Locally-registered MCP servers and tools available to the Claude subprocess.

### PostgreSQL MCP Server

Provides the `mcp__pg__query` tool for Claude to execute SQL queries against the database. Used by the knowledge, journal, project-manage, recall, and system-ops skills (§12).

### `embed_query` MCP Tool

A lightweight MCP tool registered alongside the PostgreSQL MCP server. It accepts `{ text: "search query" }` and returns `{ vector: [0.123, ...], dimensions: 1536 }` by calling the configured embedding provider API. This allows the Claude subprocess to vectorize search queries without direct API access.

Available only when `EMBEDDING_PROVIDER` is configured.

### Whitelisted Shell Commands

Claude can execute shell commands matching patterns in `COMMANDS_WHITELIST`. Command execution is enforced by the `validate-command.sh` subprocess hook (§13.2).

### Tool Whitelist

`MCP_TOOLS_WHITELIST` controls which MCP tools are available to Claude. Set to `*` for all tools, or a comma-separated list of tool names.

See also: §12 (Claude Skills), §13.2 (Command Whitelist Enforcement), §14 (Security Model), §18 (`MCP_CONFIG_PATH`, `COMMANDS_WHITELIST`, `MCP_TOOLS_WHITELIST`)


## 8. Attachment Store

Handles Telegram file attachments received by the bot.

### Storage

Files are saved to `$DATA_DIR/attachments/YYYY/MM/DD/{uuid}.{ext}`, where `$DATA_DIR` defaults to `~/data`.

### Flow

1. Telegram adapter receives a message with an attachment
2. File is downloaded via Telegram Bot API using `telegram_file_id`
3. File is saved to the date-organized directory structure
4. A record is inserted into the `attachments` table with file metadata
5. Attachment data is included in the conversation context sent to Claude (images are sent as vision input)

See also: §3 (Telegram Bot Adapter), §17.2 (`attachments` table), §18 (`DATA_DIR`)


## 9. Web Admin Server

Express HTTP server for configuration and monitoring. Always starts alongside the background service as part of `npx 2ndbrain`.

### Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Dashboard: system status overview, recent activity, quick actions |
| `/settings` | GET/POST | View and update environment configuration (first-run landing page when no configuration exists) |
| `/logs` | GET | Activity log viewer with filtering |
| `/health` | GET | JSON health check endpoint |

### Browser Auto-Open

On launch, auto-opens the default browser to the web UI:
- **First run** (no configuration file or missing required env vars): opens to `/settings` so the user can configure the service
- **Subsequent runs** (configuration present): opens to `/` (Dashboard)

Set `AUTO_OPEN_BROWSER=false` for headless/systemd deployments.

### Access Control

- Binds to `WEB_BIND` address (default `127.0.0.1`, LAN-only)
- No authentication required; access is restricted by network binding
- Authentication can be added later if remote access is needed

See also: §14 (Security Model), §18 (`WEB_PORT`, `WEB_BIND`, `AUTO_OPEN_BROWSER`)


## 10. Process Manager

Manages the service lifecycle: startup, shutdown, restart, health checks, error notification, and rate limiting.

### Startup Sequence

1. Load environment variables
2. Validate required config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `DATABASE_URL`)
3. Connect to PostgreSQL, run pending migrations from `db/migrations/*.sql` (numbered files, e.g. `001_initial_schema.sql`; applied migrations tracked in a `schema_migrations` table)
4. Resolve embedding configuration if `EMBEDDING_PROVIDER` is set (see §11.4)
5. Verify `claude-cli` is available (`claude --version`)
6. Start web admin server on `WEB_BIND`:`WEB_PORT`
7. Start Telegram long-polling
8. Log startup, set process signal handlers
9. Auto-open browser (unless `AUTO_OPEN_BROWSER=false` or running under systemd/no-TTY):
   - **First run** (no `.env` file or missing required config): open `http://{WEB_BIND}:{WEB_PORT}/settings`
   - **Subsequent runs**: open `http://{WEB_BIND}:{WEB_PORT}/`

### Graceful Shutdown

On SIGTERM or SIGINT:
1. Flush pending outgoing messages
2. Close database connections
3. Log shutdown event
4. Exit process

### Error Notification

Component errors are pushed to the owner via Telegram message. See §15 for the full error handling matrix.

### Rate Limiting

Configurable limits prevent runaway API usage:
- `RATE_LIMIT_CLAUDE`: max Claude calls per minute (default: 10)
- `RATE_LIMIT_TELEGRAM`: max Telegram sends per minute (default: 30)

Requests exceeding limits are queued. Users are notified if queue depth exceeds a threshold.

### System Logging

Structured operational logs are written to the `system_logs` table with level (`debug`, `info`, `warn`, `error`), source component, and content.

See also: §9 (Web Admin Server), §15 (Error Handling), §17.1 (`system_logs` table), §18 (rate limit and log variables)


## 11. Knowledge Platform

2ndbrain's personal knowledge features: a knowledge graph, journal, project management, and vector embeddings for semantic search.

### 11.1 Knowledge Graph

Entity relationship storage using nodes and edges.

- **Nodes** represent concepts, people, places, ideas -- anything worth tracking
- **Edges** represent named, directed relationships between nodes (e.g., "works at", "related to", "depends on")
- Unique constraint on `(source_id, target_id, name)` prevents duplicate edges
- Full-text search across node `name` and `note` fields
- New nodes are automatically queued for embedding generation when embeddings are enabled

See also: §12 (`knowledge` skill), §17.3 (`knowledge_nodes`, `knowledge_edges` tables)

### 11.2 Journal

Personal note and journal entries for reflection and recall.

- Free-form text entries stored with timestamps
- Searchable by text content and date range
- New entries are automatically queued for embedding generation when embeddings are enabled

See also: §12 (`journal` skill), §17.5 (`journal` table)

### 11.3 Project Management

Lightweight project tracking with hierarchical issues and specifications.

- **Projects** are named containers
- **Issues** track tasks, bugs, and blockers with completion status. Support `parent_id` for sub-task hierarchies.
- **Specifications** document requirements, architecture decisions, and API contracts. Support `parent_id` for nested specs.

See also: §12 (`project-manage` skill), §17.4 (`projects`, `specifications`, `issues` tables)

### 11.4 Embeddings Engine

pgvector-backed semantic search over all knowledge platform records.

**Activation:** Embeddings are enabled when `EMBEDDING_PROVIDER` is set. When unset, embeddings are disabled (no pgvector required, `embedding_config` and `embeddings` tables are not created). All features gracefully degrade to text-based search.

**`embed_query` MCP tool:** Registered alongside the PostgreSQL MCP server (§7). Accepts `{ text: "search query" }` and returns `{ vector: [...], dimensions: N }` by calling the configured embedding provider API.

#### Configuration Resolution (runs at startup step 4)

1. **Resolve dimensions:**
   - If `EMBEDDING_DIMENSIONS` is set, use that value.
   - Else look up model defaults: `text-embedding-3-small` = 1536, `text-embedding-3-large` = 3072, `text-embedding-ada-002` = 1536.
   - If the model is unknown and `EMBEDDING_DIMENSIONS` is not set, **fail startup** with a clear error.

2. **First-time setup** (no `embedding_config` row):
   - `CREATE EXTENSION IF NOT EXISTS vector`
   - Create `embedding_config` and `embeddings` tables with the resolved dimension
   - Create the HNSW index
   - Insert the config row

3. **Model switch** (`embedding_config` row exists but provider, model, or dimensions differ):
   - Log warning: *"Embedding model changed from {old} to {new}. All existing embeddings will be dropped and re-generated."*
   - Drop the HNSW index
   - `ALTER TABLE embeddings DROP COLUMN vector`
   - `ALTER TABLE embeddings ADD COLUMN vector VECTOR(${new_dimensions})`
   - Recreate the HNSW index
   - Update the `embedding_config` row
   - Queue all existing rows (`vector IS NULL`) for background re-embedding

4. **No change** (config matches): no action needed.

The background re-embedding worker processes `NULL`-vector rows progressively after startup. Semantic search returns partial results during re-embedding; text fallback covers the gap.

For new entities, embeddings are automatically generated on-save when all embedding environment variables are properly defined (`EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`). No manual step is required; disabling is implicit when `EMBEDDING_PROVIDER` is unset.

See also: §7 (`embed_query` MCP tool), §12 (`recall` skill), §17.6 (`embedding_config`, `embeddings` tables), §18 (embedding variables)


## 12. Claude Skills

2ndbrain configures a set of custom skills for the Claude subprocess via `SKILL.md` files in the runtime working directory. These skills enable the AI assistant to perform structured operations against the PostgreSQL database and host system on behalf of the owner through natural conversation.

### 12.1 Skill File Layout

```
$DATA_DIR/claude-runtime/.claude/skills/
  journal/SKILL.md
  knowledge/SKILL.md
  project-manage/SKILL.md
  recall/SKILL.md
  system-ops/SKILL.md
```

The runtime skill directory is passed to `claude-cli` via the `--project` flag (or equivalent working directory configuration).

### 12.2 Skill Definitions

Each skill is defined as a `SKILL.md` file containing natural-language instructions for Claude. The SQL patterns documented below describe the operations each skill's prompt instructs Claude to perform via `mcp__pg__query`. The `SKILL.md` files are prompts, not executable code.

#### `journal` -- Personal Journal

| Property | Value |
|----------|-------|
| Name | `journal` |
| Description | Create and search personal journal entries. Use when the user wants to note something, reflect, or recall past entries. |
| Invocation | User sends message with `/journal` preamble, or automatic (Claude detects intent: "note to self", "I want to remember", "what did I write about X") |
| Allowed tools | PostgreSQL MCP (`mcp__pg__query`) |
| Tables | `journal`, `embeddings` |

**Behaviors:**
- **Create entry:** `INSERT INTO journal (note) VALUES ($1)` with the user's note content
- **Search entries:** `SELECT * FROM journal WHERE note ILIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT 10`
- **Date-filtered recall:** `SELECT * FROM journal WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at DESC`
- **Post-create:** Queue for embedding: `INSERT INTO embeddings (entity_type, entity_id) VALUES ('journal', $1) ON CONFLICT DO NOTHING`. No-op when embeddings are disabled (table does not exist).

#### `knowledge` -- Knowledge Graph Operations

| Property | Value |
|----------|-------|
| Name | `knowledge` |
| Description | Manage personal knowledge graph. Create nodes (concepts, people, places, ideas), connect them with named relationships, and query the graph. |
| Invocation | User sends message with `/knowledge` preamble, or automatic (Claude detects entity mentions, relationship descriptions, or "how is X related to Y" queries) |
| Allowed tools | PostgreSQL MCP (`mcp__pg__query`) |
| Tables | `knowledge_nodes`, `knowledge_edges`, `embeddings` |

**Behaviors:**
- **Create node:** `INSERT INTO knowledge_nodes (name, note) VALUES ($1, $2) RETURNING id`
- **Create edge:** `INSERT INTO knowledge_edges (source_id, target_id, name) VALUES ($1, $2, $3) ON CONFLICT (source_id, target_id, name) DO NOTHING`
- **Query by name:** `SELECT * FROM knowledge_nodes WHERE name ILIKE '%' || $1 || '%'`
- **Traverse edges:** `SELECT kn.name, ke.name AS relationship FROM knowledge_edges ke JOIN knowledge_nodes kn ON kn.id = ke.target_id WHERE ke.source_id = $1`
- **Full-text search:** Search across both `name` and `note` fields
- **Post-create:** Queue for embedding: `INSERT INTO embeddings (entity_type, entity_id) VALUES ('node', $1) ON CONFLICT DO NOTHING`. No-op when embeddings are disabled (table does not exist).

#### `project-manage` -- Project and Issue Tracking

| Property | Value |
|----------|-------|
| Name | `project-manage` |
| Description | Manage projects, specifications, and issues. Create projects, add tasks, track progress, mark items complete. |
| Invocation | User sends message with `/project` preamble, or automatic (Claude detects task/project mentions: "I need to do X", "add a task for Y", "what's the status of project Z") |
| Allowed tools | PostgreSQL MCP (`mcp__pg__query`) |
| Tables | `projects`, `specifications`, `issues` |

**Behaviors:**
- **Create project:** `INSERT INTO projects (name) VALUES ($1) RETURNING id`
- **Create issue:** `INSERT INTO issues (project_id, parent_id, note) VALUES ($1, $2, $3) RETURNING id`
- **Create spec:** `INSERT INTO specifications (project_id, parent_id, note) VALUES ($1, $2, $3) RETURNING id`
- **Mark complete:** `UPDATE issues SET completed = TRUE, updated_at = NOW() WHERE id = $1`
- **Status summary:** Aggregate open/closed issue counts per project
- **Sub-task hierarchy:** Support `parent_id` for nested issues and specifications

#### `recall` -- Semantic Memory Search

| Property | Value |
|----------|-------|
| Name | `recall` |
| Description | Search across all personal data using natural language. Searches journal entries, knowledge graph, projects, issues, and conversation history. |
| Invocation | Automatic (Claude detects recall intent: "find", "remember", "what was", "search for") |
| Allowed tools | PostgreSQL MCP (`mcp__pg__query`), `embed_query` MCP tool |
| Tables | `embedding_config`, `embeddings` + all entity tables via join |

**Behaviors:**

1. **Check availability:** `SELECT dimensions FROM embedding_config WHERE id = 1`
2. **If semantic search is available:**
   - Call the `embed_query` MCP tool with the user's search text to obtain a query vector
   - Execute: `SELECT entity_type, entity_id, 1 - (vector <=> $1::vector) AS similarity FROM embeddings WHERE vector IS NOT NULL ORDER BY vector <=> $1::vector LIMIT 10`
   - Join results back to source tables based on `entity_type` to retrieve full content
3. **If semantic search is unavailable** (table missing, no config row, or `embed_query` fails):
   - Fall back to `ILIKE` text search across `journal.note`, `knowledge_nodes.name`, `knowledge_nodes.note`, `issues.note`, `specifications.note`
   - Note to user: "Using text search (semantic search unavailable)"
4. **Source attribution:** Present results with context ("From your journal on Jan 15...", "From project X, issue #3...")

**Dependency:** Semantic search requires `EMBEDDING_PROVIDER` to be configured (see §11.4). Text fallback always operates.

#### `system-ops` -- System Health Queries

| Property | Value |
|----------|-------|
| Name | `system-ops` |
| Description | Check system health, uptime, memory usage, and database status. Read-only system queries. |
| Invocation | Automatic (Claude detects health queries: "how's the system", "check disk space", "is everything running") |
| Allowed tools | Bash (`uptime`, `free`, `df`, `pg_isready`) |
| Tables | `system_logs`, `conversation_messages` (read-only) |

**Behaviors:**
- **Uptime:** `uptime`
- **Memory:** `free -h`
- **Disk:** `df -h $DATA_DIR`
- **Database status:** `pg_isready` and `SELECT COUNT(*) FROM conversation_messages`
- **Recent errors:** `SELECT * FROM system_logs WHERE level = 'error' ORDER BY created_at DESC LIMIT 5`

**Restrictions:** This skill provides read-only system access only. It does NOT support restart, reboot, shutdown, or any mutating operations. Those remain exclusive to slash commands with confirmation prompts (§4).


## 13. Claude Hooks

2ndbrain uses hooks at two levels: application lifecycle hooks within the Node.js service, and Claude subprocess hooks configured in the runtime `.claude/settings.json`.

### 13.1 Application Lifecycle Hooks

The 2ndbrain service implements an internal event pipeline. Each hook receives a context object and can modify it or abort the pipeline.

| Event | When | Context | Purpose |
|-------|------|---------|---------|
| `on_message_received` | Telegram message arrives, before routing | `{ message, telegram_user_id, timestamp }` | Log to `system_logs`, check rate limits, validate whitelist |
| `on_pre_claude` | Before spawning `claude-cli` subprocess | `{ conversation_history, system_prompt, mcp_config, skills_dir }` | Inject system prompt with current date/time and user preferences; assemble conversation context from `conversation_messages`; set `--mcp-config` path and tool whitelist |
| `on_post_claude` | After `claude-cli` returns stdout | `{ response, tool_calls, duration_ms }` | Log to `system_logs`; if embeddings enabled, queue response for embedding generation; extract entities for knowledge graph (auto-capture) |
| `on_pre_send` | Before sending response to Telegram | `{ text, parse_mode }` | Chunk messages exceeding 4096 chars; escape MarkdownV2 special characters; validate formatting |
| `on_error` | Any component error | `{ error, source, context }` | Notify owner via Telegram (per §15); log to `system_logs`; trigger retry logic if applicable |
| `on_startup` | Service startup complete | `{ timestamp, config }` | Verify all components healthy; log startup event; notify owner if recovering from a crash |
| `on_shutdown` | Graceful shutdown initiated | `{ signal, timestamp }` | Flush pending messages; close DB connections; log shutdown event |

**Hook registration:** Hooks are registered as async functions in the service's event emitter. Multiple handlers per event are supported and execute in registration order. A handler can abort the pipeline by throwing or returning `{ abort: true, reason: "..." }`.

```js
// Example hook registration pattern
bot.on('on_pre_claude', async (ctx) => {
  ctx.system_prompt += `\nCurrent time: ${new Date().toISOString()}`;
  return ctx;
});
```

### 13.2 Claude Subprocess Hooks

These hooks are configured in the runtime `.claude/settings.json` file that `claude-cli` reads when spawned. They run inside the Claude subprocess context.

#### Command Whitelist Enforcement

| Property | Value |
|----------|-------|
| Event | `PreToolUse` |
| Matcher | `Bash` |
| Type | `command` |
| Script | `$DATA_DIR/claude-runtime/hooks/validate-command.sh` |

**Behavior:**
- Reads `tool_input.command` from stdin JSON
- Checks against `COMMANDS_WHITELIST` patterns
- **Blocks** (exit code 2): `sudo` (except whitelisted), `rm -rf`, `shutdown`, `reboot`, `kill`, `pkill`, writing to system directories, network configuration changes, package installation, file writes outside `~` and `FILE_EDIT_PATHS` (see §14.5)
- **Allows** (exit code 0): commands matching whitelist patterns, read-only system queries from `system-ops` skill, file writes within `~` or `FILE_EDIT_PATHS`
- **Logging:** All blocked attempts are logged to `system_logs` via a PostgreSQL insert

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$DATA_DIR/claude-runtime/hooks/validate-command.sh"
          }
        ]
      }
    ]
  }
}
```

#### Auto Knowledge Capture (v2 -- deferred)

| Property | Value |
|----------|-------|
| Event | `PostToolUse` |
| Matcher | `Bash\|mcp__pg__.*` |
| Type | `command` |
| Script | `$DATA_DIR/claude-runtime/hooks/auto-capture.sh` |

**Status:** Deferred to v2. In v1, knowledge graph entries are created explicitly via the `/knowledge` preamble or Claude's automatic intent detection (see §12.2).

**Planned behavior (v2):**
- Checks `EMBEDDING_PROVIDER` env var; if empty, exits 0 immediately (embeddings disabled)
- Fires after successful tool executions (bash commands and DB queries)
- Reads `tool_response` from stdin JSON
- Queues substantive outputs for embedding generation (skips trivial outputs like row counts)
- Rate-limited: max 10 captures per minute to avoid flooding the embeddings queue
- Non-blocking: exits 0 regardless of capture success

#### Response Length Guard

Implemented as a Node.js check in the `on_pre_send` application lifecycle hook (§13.1), not as a Claude subprocess hook.

**Behavior:**
- After receiving the Claude response, the `on_pre_send` hook checks `text.length`
- If the response exceeds 3500 characters, re-invokes Claude with a condensation prompt: "Condense the following to under 3500 characters, using bullet points and brief sentences."
- If condensation also exceeds the limit, falls through to the Telegram adapter's chunking logic (§3)
- This avoids the cost and latency of a prompt-type subprocess hook on every response

### 13.3 Runtime Hook File Layout

```
$DATA_DIR/claude-runtime/
  .claude/
    settings.json          # Subprocess hooks configuration (§13.2)
    skills/                # Skill definitions (§12.2)
      journal/SKILL.md
      knowledge/SKILL.md
      project-manage/SKILL.md
      recall/SKILL.md
      system-ops/SKILL.md
  hooks/
    validate-command.sh    # Command whitelist enforcement
    auto-capture.sh        # Post-tool knowledge capture
```


## 14. Security Model

### 14.1 Whitelist Architecture

2ndbrain uses four independent whitelists, each governing a separate access domain:

| Whitelist | Scope | Configuration |
|-----------|-------|---------------|
| **Telegram** | Which Telegram user IDs can interact with the bot | `TELEGRAM_ALLOWED_USERS` env var (comma-separated IDs) |
| **Commands** | Which local shell commands Claude can execute | `COMMANDS_WHITELIST` env var (command patterns) |
| **MCP Tools** | Which MCP tools are available to Claude | `MCP_TOOLS_WHITELIST` env var (`*` or comma-separated names) |
| **Admin** | Who can access the web admin interface | Network binding via `WEB_BIND` (default `127.0.0.1`, LAN-only) |

### 14.2 Unauthorized Access Behavior

- Messages from non-whitelisted Telegram users: **silent drop + log the attempt** (no response sent)
- Non-whitelisted command execution attempts: **blocked, logged, owner notified**

### 14.3 Secrets Management

All secrets stored in `.env` file (excluded from version control):

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `DATABASE_URL` | PostgreSQL connection string |
| `CLAUDE_API_KEY` | Claude API key (if needed beyond CLI auth) |

### 14.4 Dangerous Operations

- `/reboot` requires explicit confirmation reply before execution
- `/restart` requires confirmation reply
- Local command execution is limited to whitelisted patterns only

### 14.5 File System Access

Claude may edit files on the host within defined boundaries:

| Scope | Access | Enforcement |
|-------|--------|-------------|
| **Home directory** (`~`) | Read and write permitted | Always allowed |
| **Whitelisted paths** | Read and write permitted | Paths listed in `FILE_EDIT_PATHS` env var (comma-separated absolute paths) |
| **All other paths** | Requires explicit user permission | Claude requests confirmation via Telegram before each write; user must approve |
| **System directories** (`/etc`, `/usr`, `/boot`, `/sys`, `/proc`) and other users' home directories | **Always blocked** | Rejected by `validate-command.sh` hook (§13.2) regardless of user confirmation |

Path enforcement is applied by the `validate-command.sh` subprocess hook (§13.2) which inspects file-write targets in `tool_input.command` before execution.


## 15. Error Handling

| Failure | Behavior |
|---------|----------|
| Claude CLI unreachable / crashes | Retry with exponential backoff (3 attempts). After all retries fail, notify owner via Telegram: "Claude is unavailable." |
| PostgreSQL down | Buffer incoming messages in memory (bounded queue). Retry DB connection with backoff. Notify owner if DB is down for >60s. |
| Telegram API unreachable | Buffer outgoing messages. Retry with backoff. Log errors. |
| Uncaught exception | Log the error, notify owner via Telegram, attempt graceful restart. |
| Claude timeout | Kill the subprocess after `CLAUDE_TIMEOUT` ms. Respond to user: "Response timed out, please try again." |
| Rate limit exceeded | Queue the request. Notify user if queue depth exceeds a threshold. |
| Claude CLI not found at startup | Fail startup with error: "claude not found. Install Claude Code: https://claude.ai/code" |


## 16. Deployment

### Target Platform
- Raspberry Pi 5 (ARM64, Debian/Ubuntu)
- Eventually any Linux host with Node.js

### Prerequisites
- Node.js >= 20
- PostgreSQL >= 15
- `claude-cli` installed and authenticated
- pgvector extension (required when `EMBEDDING_PROVIDER` is set)

### Installation
```bash
npx 2ndbrain
```

Requires adding a `bin` field to `package.json`:
```json
{
  "bin": {
    "2ndbrain": "./src/index.js"
  }
}
```

### Boot Configuration (Linux)

systemd service unit template:

```ini
[Unit]
Description=2ndbrain Telegram-Claude bridge
After=network.target postgresql.service

[Service]
Type=simple
User={SYSTEM_USER}
EnvironmentFile=/home/{SYSTEM_USER}/.env
Environment=AUTO_OPEN_BROWSER=false
ExecStart=/usr/bin/npx 2ndbrain
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

See §10 for the full startup sequence.


## 17. Data Model

### 17.1 Conversation & Logging

```sql
CREATE TABLE conversation_messages (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id  TEXT,                     -- Claude CLI session ID (links to --resume)
  role        TEXT NOT NULL,            -- 'user', 'assistant', 'system', 'summary'
  content     TEXT NOT NULL,
  metadata    JSONB                     -- tool calls, attachments, telegram_message_id (used for reply_to_message_id on responses), cost_usd, etc.
);

CREATE TABLE system_logs (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level       TEXT NOT NULL DEFAULT 'info',  -- 'debug', 'info', 'warn', 'error'
  source      TEXT,                          -- component name (e.g. 'telegram', 'claude', 'process')
  content     TEXT NOT NULL
);
```

### 17.2 Attachments

```sql
CREATE TABLE attachments (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_id        INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  telegram_file_id  TEXT,
  mime_type         TEXT,
  file_path         TEXT NOT NULL,    -- relative to ~/data (e.g. attachments/2026/01/30/abc123.jpg)
  file_size         INTEGER
);
```

### 17.3 Knowledge Graph

```sql
CREATE TABLE knowledge_nodes (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE knowledge_edges (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_id   INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  UNIQUE(source_id, target_id, name)
);
```

### 17.4 Project Management

```sql
CREATE TABLE projects (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL
);

CREATE TABLE specifications (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES specifications(id) ON DELETE SET NULL,
  note        TEXT NOT NULL
);

CREATE TABLE issues (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  parent_id   INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  note        TEXT NOT NULL,
  completed   BOOLEAN NOT NULL DEFAULT FALSE
);
```

### 17.5 Journal

```sql
CREATE TABLE journal (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT NOT NULL
);
```

### 17.6 Embeddings

```sql
-- Embedding configuration (single row, tracks active model)
CREATE TABLE embedding_config (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider    TEXT NOT NULL,            -- 'openai' (extensible to any OpenAI-compatible API)
  model       TEXT NOT NULL,            -- e.g. 'text-embedding-3-small'
  dimensions  INTEGER NOT NULL,         -- e.g. 1536
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector embeddings (requires pgvector extension)
-- NOTE: The VECTOR dimension is set dynamically at migration time based on
-- EMBEDDING_DIMENSIONS env var or the model's default. Example shown with 1536.
CREATE TABLE embeddings (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type TEXT NOT NULL,          -- 'message', 'node', 'journal', 'issue', etc.
  entity_id   INTEGER NOT NULL,
  vector      VECTOR(${dimensions}),  -- dynamic: 1536, 3072, etc. depending on model
  UNIQUE(entity_type, entity_id)
);

-- HNSW index for fast approximate nearest neighbor search (cosine distance)
CREATE INDEX idx_embeddings_vector
  ON embeddings USING hnsw (vector vector_cosine_ops);
```


## 18. Configuration Reference

| Variable | Required | Default | Component | Description |
|----------|----------|---------|-----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | -- | §3 Telegram | Telegram Bot API token |
| `TELEGRAM_ALLOWED_USERS` | yes | -- | §3 Telegram | Comma-separated Telegram user IDs |
| `DATABASE_URL` | yes | -- | §17 Database | PostgreSQL connection string |
| `CLAUDE_MODEL` | no | `claude-sonnet-4-20250514` | §5 Claude Bridge | Claude model for `claude-cli` |
| `CLAUDE_THINKING` | no | `true` | §5 Claude Bridge | Enable extended thinking |
| `CLAUDE_TIMEOUT` | no | `120000` | §5 Claude Bridge | Claude subprocess timeout (ms) |
| `CLAUDE_MAX_BUDGET` | no | *(none)* | §5 Claude Bridge | Max cost per Claude invocation in USD (e.g. `0.50`) |
| `DATA_DIR` | no | `~/data` | §8 Attachments | Attachment and runtime storage root directory |
| `COMMANDS_WHITELIST` | no | *(none)* | §7 MCP Tools | Allowed shell command patterns (comma-separated) |
| `MCP_TOOLS_WHITELIST` | no | `*` | §7 MCP Tools | Allowed MCP tool names (`*` = all) |
| `FILE_EDIT_PATHS` | no | *(empty)* | §14 Security | Additional directories Claude may edit (comma-separated absolute paths). Home directory is always allowed. |
| `MCP_CONFIG_PATH` | no | `~/.claude/mcp.json` | §7 MCP Tools | Path to MCP server configuration |
| `RATE_LIMIT_CLAUDE` | no | `10` | §10 Process | Max Claude calls per minute |
| `RATE_LIMIT_TELEGRAM` | no | `30` | §10 Process | Max Telegram sends per minute |
| `HISTORY_COMPACT_THRESHOLD` | no | `100` | §6 Conversation | Message count before auto-compaction |
| `LOG_LEVEL` | no | `info` | §10 Process | Minimum log level (debug/info/warn/error) |
| `WEB_PORT` | no | `3000` | §9 Web Admin | Web admin server port |
| `WEB_BIND` | no | `127.0.0.1` | §9 Web Admin | Web admin bind address |

| `AUTO_OPEN_BROWSER` | no | `true` | §9 Web Admin | Auto-open browser to web UI on launch. Set to `false` for headless/systemd deployments. |
| `EMBEDDING_PROVIDER` | no | *(empty)* | §11 Knowledge | Embedding provider: `"openai"` or empty to disable. Extensible to any OpenAI-compatible API via `EMBEDDING_BASE_URL`. |
| `EMBEDDING_API_KEY` | no | *(empty)* | §11 Knowledge | API key for the embedding provider |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | §11 Knowledge | Model name passed to the provider API |
| `EMBEDDING_DIMENSIONS` | no | *(empty)* | §11 Knowledge | Override output dimensions (empty = model default). OpenAI v3 models support truncation. |
| `EMBEDDING_BASE_URL` | no | *(empty)* | §11 Knowledge | Override API base URL (empty = `https://api.openai.com/v1`). Use for proxies or compatible providers. |
