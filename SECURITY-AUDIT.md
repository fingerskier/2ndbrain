# Security & Reliability Audit Report

**Project:** 2ndbrain v0.5.0
**Date:** 2026-02-01
**Scope:** Full source code review (~5,600 LOC across 18 JS files + 1 bash script)

---

## Executive Summary

2ndbrain is a Node.js service bridging Telegram to Claude CLI, with a PostgreSQL backend and an Express-based admin panel. The architecture follows a defense-in-depth approach with Telegram user whitelisting, command whitelisting, and rate limiting. However, several gaps remain -- the most critical being the unauthenticated web admin panel that can modify all credentials and system configuration.

| Severity | Count |
|----------|-------|
| Critical | 2     |
| High     | 6     |
| Medium   | 8     |
| Low      | 6     |

---

## Critical

### SEC-01: Unauthenticated Web Admin Panel

**Files:** `src/web/server.js:124-131`

All web admin routes are served without any authentication:

```
app.get('/',          ... _handleDashboard)
app.get('/settings',  ... _handleSettings)
app.post('/settings', ... _handleSaveSettings)
app.post('/database/migrate', ... _handleRunMigrations)
```

The settings page allows reading masked versions of, and writing new values for: `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `EMBEDDING_API_KEY`, and all other configuration. The database page allows running arbitrary schema migrations.

While the default bind address is `127.0.0.1`, nothing prevents a user from setting `WEB_BIND=0.0.0.0` (there is even a UI field for it at `src/web/server.js:76`), which exposes the entire admin panel to the network.

**Impact:** Full account takeover. An attacker on the local network (or remotely if `WEB_BIND` is `0.0.0.0`) can replace the Telegram bot token, database URL, or embedding API key with attacker-controlled values.

**Recommendation:** Add authentication to the web admin panel (token-based, password, or at minimum an admin secret in the `.env`). If the panel must remain open, hard-enforce `127.0.0.1` binding and do not expose it as a configurable option.

### SEC-02: No CSRF Protection on State-Changing Endpoints

**Files:** `src/web/server.js:127, 131`

`POST /settings` and `POST /database/migrate` have no CSRF token validation. Since the admin panel has no authentication, any page a local user visits can submit a form to `http://localhost:3000/settings` and overwrite credentials.

**Impact:** A malicious website visited in the same browser can silently reconfigure the entire application.

**Recommendation:** Add CSRF tokens to all POST forms. Even with authentication, CSRF protection is necessary.

---

## High

### SEC-03: Database Credentials Visible in Process Arguments

**File:** `src/mcp/config.js:35`

```javascript
args: ['-y', '@modelcontextprotocol/server-postgres', config.DATABASE_URL],
```

The full `DATABASE_URL` (including username and password) is passed as a command-line argument to the MCP postgres server spawned by `npx`. Command-line arguments are visible to all users on the system via `ps aux`.

**Impact:** Any local user can read database credentials from the process listing.

**Recommendation:** Pass the connection string via an environment variable in the child process `env` option, not via `args`.

### SEC-04: Error Messages Leak Internal Details to Telegram Users

**File:** `src/index.js:261-263`

```javascript
const userMessage = isTimeout
  ? 'Response timed out, please try again.'
  : `Sorry, an error occurred: ${err.message}`;
```

Non-timeout error messages are forwarded verbatim to the Telegram user. `err.message` can contain database connection strings, file paths, stack traces from child process stderr, or other internal details.

**Impact:** Information disclosure. Even though the Telegram user is whitelisted, the messages traverse Telegram's servers.

**Recommendation:** Send a generic error message to users and log the full error internally. If the detail is useful, provide a reference ID that can be looked up in the logs.

### SEC-05: `sudo reboot` Execution After Single-Factor Confirmation

**File:** `src/telegram/commands.js:233`

```javascript
execSync('sudo reboot', { timeout: 10_000 });
```

The `/reboot` command executes `sudo reboot` after a single "YES" reply within 60 seconds. The confirmation flow relies solely on the Telegram user whitelist -- if the bot token is compromised (e.g., via SEC-01), an attacker can reboot the host.

**Impact:** Denial of service / physical disruption of the host system.

**Recommendation:** Consider removing the reboot command entirely, or require a secondary authentication factor (e.g., a passphrase, TOTP code, or physical button press).

### SEC-06: Validate Command Hook Can Be Bypassed via Whitelist Patterns

**File:** `hooks/validate-command.sh:278-280`

Whitelisted commands bypass all subsequent security checks, including dangerous-command blocking and write-target inspection. If `COMMANDS_WHITELIST` contains an overly broad pattern (e.g., `*`), all commands including `sudo`, `rm -rf /`, and arbitrary writes become allowed.

Additionally, the glob matching at line 134-140 checks the command prefix, but compound commands like `echo hello; rm -rf /` would be checked against the whitelist as the full string, not the individual subcommands. The dangerous-command check at lines 287-333 does inspect for embedded dangerous commands using grep patterns, but the whitelist check (Rule 1) runs first and exits 0 before those checks.

**Impact:** A permissive whitelist pattern bypasses all safety checks.

**Recommendation:** Always run the dangerous-command checks (Rule 2) regardless of whitelist match. The whitelist should only skip Rule 4/5 (read-only and default allow), not the unconditional block rules.

### SEC-07: Missing Security Headers on Web Admin

**File:** `src/web/server.js:116-148`

The Express server sets no security headers:

- No `Content-Security-Policy` (allows inline scripts, external resource loading)
- No `X-Frame-Options` (clickjacking possible)
- No `X-Content-Type-Options: nosniff`
- No `Strict-Transport-Security`
- No `Referrer-Policy`

The admin panel contains inline `onclick` handlers (line 1032) which would need CSP allowances, but the absence of CSP entirely is worse.

**Impact:** The admin panel is vulnerable to clickjacking and content injection attacks.

**Recommendation:** Add a security headers middleware. At minimum: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a restrictive `Content-Security-Policy`.

### SEC-08: Full Process Environment Passed to Claude Subprocess

**File:** `src/claude/bridge.js:47`

```javascript
env: { ...process.env },
```

The entire process environment -- including `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `EMBEDDING_API_KEY`, and any other secrets -- is passed to the Claude CLI subprocess. Claude CLI can access these via its MCP tools or tool-use capabilities.

**Impact:** If Claude's sandboxing is incomplete or a tool allows environment variable access, all application secrets are exposed.

**Recommendation:** Construct a minimal environment for the Claude subprocess containing only required variables (PATH, HOME, etc.).

---

## Medium

### SEC-09: Unvalidated Query Parameter Rendered in HTML

**File:** `src/web/server.js:339-340`

```javascript
} else if (req.query.error) {
  data.message = { type: 'error', text: req.query.error };
}
```

The `error` query parameter from `/database?error=...` is set as the message text. It is later rendered through `esc()` at line 1114, so XSS is prevented. However, this pattern of reflecting user-controlled input is fragile -- if any template path omits the `esc()` call, it becomes an XSS vector.

**Recommendation:** Validate and sanitize the error parameter, or use a flash message stored server-side.

### SEC-10: No Rate Limiting on Web Admin Endpoints

**File:** `src/web/server.js:116-148`

While Telegram and Claude rate limiters exist, the web admin endpoints have none. An attacker could:
- Rapidly POST to `/settings` to cause disk I/O (`.env` writes)
- Repeatedly POST to `/database/migrate` to trigger migration attempts
- Flood `/health` which issues a `SELECT 1` on every request

**Recommendation:** Add basic rate limiting to web admin routes.

### SEC-11: Database CREATE Statement Uses String Interpolation

**File:** `src/embeddings/engine.js:224, 271`

```javascript
await this.db.query(`CREATE TABLE IF NOT EXISTS embeddings (
  ...
  vector VECTOR(${dimensions}),
  ...
)`);
```

The `dimensions` value is interpolated directly into SQL DDL. While the code validates it is a positive integer at `src/embeddings/engine.js:169-174`, this validation happens in the same class. If `_resolveDimensions` is called with `EMBEDDING_DIMENSIONS` containing a non-numeric value that passes `parseInt` (e.g., `"100; DROP TABLE users--"`), `parseInt` would return `100` and the injection would fail. However, this pattern is inherently risky.

**Impact:** Low given current validation, but defense-in-depth is missing.

**Recommendation:** Add an explicit integer range check (e.g., `dim > 0 && dim <= 10000`) before interpolation into DDL.

### SEC-12: `ensureDatabase` Uses Unsanitized Database Name in DDL

**File:** `src/db/pool.js:39`

```javascript
await client.query(`CREATE DATABASE "${dbName}"`);
```

The database name is extracted from the URL pathname and used in a `CREATE DATABASE` statement with double-quote escaping. If the URL contains a database name with double quotes (e.g., `postgresql://.../"test"--drop`), the escaping could be bypassed. In practice this is unlikely since the user controls the `.env` file.

**Impact:** Low -- self-inflicted SQL injection via config file.

**Recommendation:** Use `pg_catalog.quote_ident()` or validate the database name against `[a-zA-Z0-9_-]+`.

### SEC-13: Telegram Bot Token in URLs and Logs

**Files:** `src/telegram/bot.js:401, 372`

```javascript
const url = new URL(`/bot${this._token}/${method}`, TELEGRAM_API_BASE);
```

The bot token is embedded in every API URL. If an error occurs during an HTTP request and the URL is logged, the token is exposed. The `_getFileUrl` method at line 372 also constructs download URLs containing the token. While the logger appears to not log full URLs directly, any unexpected error that includes the request URL would leak the token.

**Recommendation:** Never log full Telegram API URLs. Mask the token portion in error messages.

### SEC-14: Sensitive Data Stored in Logs Table

**File:** `src/logging.js:44-47`

All log entries, including those containing user messages and error details, are persisted to the `system_logs` database table. The web admin logs page (`/logs`) displays these without any redaction. User messages may contain personal information, and error logs may contain credentials or tokens.

**Recommendation:** Implement log-level content filtering, redact known secret patterns, and consider adding access controls to the logs page.

### SEC-15: Command Validation Script Has Sed-Based JSON Parsing Fallback

**File:** `hooks/validate-command.sh:38-42`

When `jq` is not installed, command extraction falls back to `sed`:

```bash
COMMAND=$(printf '%s' "$INPUT" \
  | tr '\n' ' ' \
  | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//' \
  | sed 's/"[[:space:]]*[,}].*//' \
  | sed 's/\\"/"/g; s/\\\\/\\/g')
```

This fallback cannot correctly handle all JSON edge cases (e.g., nested quotes, unicode escapes, multi-line commands). A specially crafted command string could cause incorrect extraction, potentially allowing the wrong string to be validated.

**Recommendation:** Require `jq` as a dependency, or use Node.js for JSON parsing instead of bash.

### SEC-16: Relative Path Assumption in Command Validator

**File:** `hooks/validate-command.sh:176`

```bash
"."*|[^/]*) return 0 ;;  # Relative paths resolve under cwd (within home)
```

The validator assumes relative paths resolve within the home directory. However, Claude CLI's working directory is configurable via the `--cwd` flag or by the runtime directory. If the working directory is set to `/`, relative paths like `../etc/passwd` would resolve outside home.

**Impact:** Depends on Claude CLI's working directory configuration.

**Recommendation:** Resolve relative paths to absolute before validation, using the actual working directory.

---

## Low

### SEC-17: No Input Length Validation

**File:** `src/index.js:152`

User messages from Telegram are saved to the database and forwarded to Claude without any length validation. Telegram allows messages up to 4096 characters, but captions and forwarded messages could be longer. Extremely large messages could cause:
- Database storage bloat
- Claude CLI buffer overflow or timeout
- Memory pressure during compaction (all messages loaded into memory)

**Recommendation:** Enforce a maximum message length (e.g., 10,000 chars) before processing.

### SEC-18: `_executeConfirmed` Not Awaited

**File:** `src/telegram/commands.js:200`

```javascript
this._executeConfirmed(chatId, command);
return true;
```

The async `_executeConfirmed` method is called without `await`, making it fire-and-forget. If it throws after the `return true`, the error is an unhandled promise rejection. The method has its own try/catch (line 212-248), but any error in `this._sendPlain` within the catch block would be unhandled.

**Recommendation:** Await the call, or add `.catch()` to handle edge cases.

### SEC-19: Attachment MIME Type Derived from Untrusted Source

**File:** `src/attachments/store.js:43-45`

```javascript
function extFromMime(mimeType) {
  if (!mimeType) return 'bin';
  return MIME_TO_EXT[mimeType] || mimeType.split('/').pop() || 'bin';
}
```

The MIME type comes from Telegram's message data (client-provided). The fallback `mimeType.split('/').pop()` could produce unexpected extensions from crafted MIME types. While files are stored with UUID names (mitigating path-based attacks), the extension could confuse downstream consumers.

**Recommendation:** Use a strict whitelist of allowed MIME types. Reject or default unknown types.

### SEC-20: Unhandled Rejection Handler Only Logs

**File:** `src/index.js:552-554`

```javascript
process.on('unhandledRejection', (reason) => {
  logger.error('process', `Unhandled rejection: ${reason}`);
});
```

Unhandled promise rejections are logged but do not trigger the `on_error` hook, shutdown, or user notification. In Node.js 15+, unhandled rejections terminate the process by default, but this handler prevents that. Silent failures accumulate.

**Recommendation:** Either call `shutdown()` on unhandled rejections (as done for uncaught exceptions) or at minimum emit the `on_error` hook.

### SEC-21: Conversation Compaction Is Not Transactional

**File:** `src/claude/conversation.js:145-203`

Compaction performs three sequential database operations (INSERT summary, then DELETE old messages) without wrapping them in a transaction. If the process crashes between the INSERT and DELETE, duplicate data accumulates. If it crashes after DELETE but before INSERT completes, messages are lost.

**Recommendation:** Wrap the INSERT and DELETE in a database transaction.

### SEC-22: Web Admin `.env` File Write Has No Locking

**File:** `src/web/server.js:416-442`

The `_writeEnvFile` method reads and rewrites the `.env` file without file locking. Concurrent POST requests to `/settings` could produce corrupted output. While unlikely with a single-user admin panel, it's a correctness issue.

**Recommendation:** Use a file lock or serialize writes through an in-memory queue.

---

## Positive Findings

The following security practices are well-implemented:

- **Parameterized SQL queries** throughout -- SQL injection risk is minimal (`$1, $2, $3` pattern used consistently)
- **HTML escaping** via `esc()` function applied consistently in all template outputs
- **UUID-based attachment filenames** prevent path traversal and name collision
- **Telegram user whitelist** provides a strong first layer of access control
- **Secrets masked in UI** with `maskValue()` / `maskDatabaseUrl()`
- **Bot token validated** before starting Telegram polling
- **Dangerous command blocking** is comprehensive (sudo, rm -rf, shutdown, kill, network config, package managers)
- **File write path validation** blocks writes to system directories unconditionally
- **Rate limiting** on both Claude and Telegram prevents resource exhaustion
- **Embed MCP server** binds to `127.0.0.1` only
- **Signal handling** with graceful shutdown on SIGTERM/SIGINT

---

## Failure Points & Reliability

### FP-01: No Retry Logic for Telegram API Calls

**File:** `src/telegram/bot.js:398-453`

`_apiCall` makes a single HTTPS request with no retry on transient failures (network timeouts, 429 rate limits, 500 server errors). The polling loop at line 131-133 has a fixed 5-second backoff with no exponential backoff.

**Impact:** Temporary Telegram API outages cause message loss.

### FP-02: No Timeout on File Downloads

**File:** `src/telegram/bot.js:463-484`

`_httpsGet` has no timeout. A stalled download from Telegram's file servers blocks the message handler indefinitely, preventing all other message processing.

### FP-03: Session ID Race Condition on Concurrent Messages

**File:** `src/claude/conversation.js:20-21, 109-111`

`currentSessionId` is a mutable instance variable with no synchronization. If two Telegram messages arrive in rapid succession, the first may start a Claude invocation (which takes seconds to minutes), and the second may overwrite `currentSessionId` before the first completes.

**Impact:** Messages saved with incorrect session IDs, corrupted conversation threading.

### FP-04: Embedding Worker Duplicate Processing

**File:** `src/embeddings/worker.js:150-157`

The worker SELECTs rows with `vector IS NULL` and then updates them after processing. Between the SELECT and UPDATE, no row lock is held. If two workers were running (e.g., after a hot restart), both could process the same row.

**Impact:** Wasted API calls and potential database constraint violations.

### FP-05: Claude Subprocess Zombie After SIGTERM

**File:** `src/claude/bridge.js:281-287`

The `kill()` method sends `SIGTERM` and immediately sets `activeProcess = null`. If the child process ignores SIGTERM, no SIGKILL follow-up occurs. The process becomes a zombie.

**Impact:** Resource leak, potential blocking of future invocations.

### FP-06: Scheduler Task Has No Execution Timeout

**File:** `src/scheduler/worker.js:243-316`

`_executeTask` calls `claudeBridge.invoke()` which has a configurable timeout (default 120s). However, the scheduler worker itself has no per-task timeout. If the Claude timeout fails to trigger (e.g., due to a hung process that partially responds), the task blocks the scheduler indefinitely.

### FP-07: Database Connection Loss Not Detected

**File:** `src/db/pool.js:11-13`

The pool's error handler only logs to console. There is no mechanism to notify the application that the database has become unavailable. The health endpoint checks with `SELECT 1` on each request, but background workers (embedding worker, scheduler) will fail silently and retry every poll interval without alerting the user.

### FP-08: Compaction During Active Processing Can Lose Context

**File:** `src/claude/conversation.js:124-129`

Compaction checks `claudeBridge.isActive()` before starting, but the compaction itself takes significant time (it invokes Claude for summarization). A new user message could arrive and start processing while compaction is running, causing both to use Claude simultaneously.

---

*End of Security & Reliability Audit Report*
