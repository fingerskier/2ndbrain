# 2ndbrain

A personal, always-on AI assistant that lives on your local network. **2ndbrain** bridges Telegram to Claude via a Node.js service, giving you a private conversational AI with persistent memory, a knowledge platform, and full access to local tools — all from your phone.

You set it up on a device on your LAN (e.g. a Raspberry Pi 5), and you — and only you — interact with it by chatting over Telegram.


## How It Works

```
Telegram  ──long-polling──▸  2ndbrain  ──subprocess──▸  Claude CLI
                                │                          │
                                │                     MCP tools
                                │                     (postgres, embeddings,
                                │                      shell commands)
                                │
                           PostgreSQL
                         (history, knowledge,
                          projects, journal,
                          embeddings)
```

1. Messages arrive from Telegram via long-polling (no public URL required)
2. Slash commands are routed to built-in handlers; everything else goes to Claude
3. Claude is spawned as a subprocess with access to MCP tools (database, semantic search, whitelisted shell commands)
4. Responses stream back through Telegram with a typing indicator
5. All conversations are persisted in PostgreSQL for recall and search


## Integrations

| Integration | Role |
|---|---|
| **Telegram Bot API** | Messaging interface — long-polling, attachments (photos, docs, audio, video, voice), typing indicators |
| **Claude CLI** | Conversational AI — spawned as subprocess with streaming JSON, thinking mode, session continuity |
| **PostgreSQL + pgvector** | Persistent storage — conversation history, knowledge graph, projects, journal, vector embeddings with HNSW indexing |
| **Model Context Protocol (MCP)** | Tool framework — gives Claude direct access to the database (`pg` server) and a custom `embed_query` tool for semantic search |
| **OpenAI Embeddings API** | Vector embeddings — optional provider for semantic search (configurable model and dimensions) |
| **Express** | Web admin dashboard — settings, environment config, activity logs (LAN-only) |


## Features

### Conversation
- Persistent conversation history with session tracking
- Auto-compaction when history exceeds a configurable threshold
- Rate limiting for both Claude calls and Telegram sends
- Attachment storage (photos, documents, audio, video, voice) in `~/data`

### Skills (Claude-managed via MCP)

| Skill | Description |
|---|---|
| **Knowledge Graph** | Entities and relationships with full-text search and embedding queue |
| **Journal** | Timestamped personal notes with semantic search |
| **Project Management** | Projects with specifications and issues, completion tracking |
| **Scheduler** | Recurring tasks via cron expressions with timezone support |
| **Recall** | Unified semantic search across journal, knowledge, projects, and history |
| **System Ops** | Read-only diagnostics — memory, disk, uptime, database status, logs |

### Slash Commands

| Command | Action |
|---|---|
| `/status` | Current system status |
| `/health` | Health check across all subsystems |
| `/restart` | Restart the service |
| `/reboot` | Reboot the host |
| `/stop` | Graceful shutdown |
| `/new` | Start a new conversation session |
| `/help` | List available commands |

### Security
- Whitelisted Telegram users (multi-layered)
- Whitelisted MCP tools and shell commands
- Configurable file-edit path restrictions
- LAN-only web admin interface

### Lifecycle Hooks
Custom scripts that run at startup, shutdown, pre/post Claude invocation, and on errors.


## Setup

1. Ensure **PostgreSQL** is running with the `pgvector` extension
2. Ensure **claude-cli** is installed and configured
3. Create a `.env` file at `~/.2ndbrain/.env` (see Configuration below)
4. Start the service: `npx 2ndbrain`
5. (Optional) Configure to start on boot via systemd or similar


## Configuration

All configuration lives in `~/.2ndbrain/.env`:

| Category | Key Variables |
|---|---|
| **Required** | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `DATABASE_URL` |
| **Claude** | `CLAUDE_MODEL`, `CLAUDE_THINKING`, `CLAUDE_TIMEOUT`, `CLAUDE_MAX_BUDGET` |
| **MCP** | `MCP_CONFIG_PATH`, `MCP_TOOLS_WHITELIST`, `COMMANDS_WHITELIST` |
| **Embeddings** | `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` |
| **Rate Limits** | `RATE_LIMIT_CLAUDE` (default 10/min), `RATE_LIMIT_TELEGRAM` (default 30/min) |
| **Web Admin** | `WEB_PORT`, `WEB_BIND`, `AUTO_OPEN_BROWSER` |
| **Storage** | `DATA_DIR` (default `~/data`) |
| **Conversation** | `HISTORY_COMPACT_THRESHOLD` (default 100) |
| **Security** | `FILE_EDIT_PATHS` |
| **Logging** | `LOG_LEVEL` |


## Data Schema

- **Projects** (id, created, updated, name)
  - Specifications (id, created, updated, project_id, note)
  - Issues (id, created, updated, note, completed)
- **Knowledge Graph**
  - Nodes (id, created, updated, name, note)
  - Edges (id, created, updated, node1_id, node2_id, name)
- **Journal** (id, created, updated, note)
- **Conversation Messages** (id, created, updated, user_id, message_id, content, session_id)
- **System Logs** (id, timestamp, content, level)
- **Attachments** (id, created, updated, file_path, metadata)
- **Scheduled Tasks** (id, cron_expression, timezone, next_run, error tracking)
- **Embeddings** (id, created, updated, entity_type, vector)
