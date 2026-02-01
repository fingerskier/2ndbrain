# Performance Audit Report

**Project:** 2ndbrain v0.5.0
**Date:** 2026-02-01
**Scope:** Full source code review (~5,600 LOC across 18 JS files + 1 bash script)

---

## Executive Summary

2ndbrain is a single-user personal assistant running on low-power hardware (e.g., Raspberry Pi 5). Performance requirements are modest -- the system processes one message at a time and serves a single web admin user. Most performance issues identified are relevant for long-running uptime (days/weeks), not peak throughput. The most impactful findings are synchronous file I/O blocking the event loop, sequential embedding processing, and missing caching for repeated database queries.

**Overall Assessment:** The performance profile is acceptable for the intended use case. The issues below are ordered by impact and should be addressed as the system scales or as uptime requirements increase.

| Priority | Count |
|----------|-------|
| High     | 3     |
| Medium   | 7     |
| Low      | 6     |

---

## High Priority

### PERF-01: Synchronous File I/O Blocks Event Loop

**File:** `src/attachments/store.js:102, 105`

```javascript
fs.mkdirSync(absoluteDir, { recursive: true });  // line 102
fs.writeFileSync(absolutePath, fileBuffer);       // line 105
```

Attachment saving uses synchronous `mkdirSync` and `writeFileSync`. These block the entire Node.js event loop for the duration of the disk operation. On an SD card (common for Raspberry Pi), a large file write could block for hundreds of milliseconds, during which:

- Telegram long-polling cannot process new updates
- The web admin panel becomes unresponsive
- Typing indicator refreshes are delayed
- Rate limiter drain timers are delayed

Additional synchronous file operations that block during startup (acceptable but worth noting):
- `src/index.js:61-93` -- `setupRuntimeFiles()` uses `mkdirSync`, `copyFileSync`, `chmodSync`
- `src/config.js:15-23` -- `.env` migration and directory creation
- `src/mcp/config.js:26-27, 49, 69` -- MCP config file writes

**Impact:** Event loop stalls proportional to file size and disk speed.

**Recommendation:** Replace `mkdirSync`/`writeFileSync` with `fs.promises.mkdir`/`fs.promises.writeFile` in the attachment store. Startup file operations can remain synchronous since they run before the event loop serves requests.

### PERF-02: Sequential Embedding Processing

**File:** `src/embeddings/worker.js:168-178`

```javascript
for (const row of result.rows) {
  try {
    await this._processRow(row);  // sequential
  } catch (err) { ... }
}
```

Each embedding is processed sequentially: fetch source text from DB, call OpenAI API, write vector back to DB. With OpenAI API latency of ~200-500ms per call and a batch size of 10, processing takes 2-5 seconds per batch with a 5-second poll interval.

For a backlog of 1,000 messages, embedding takes ~8-17 minutes. For 10,000 messages (e.g., after a model switch that nullifies all vectors), it takes ~1.5-3 hours.

**Impact:** Slow embedding generation after initial setup or model changes.

**Recommendation:** Process embeddings concurrently within each batch using `Promise.allSettled()` with a concurrency limit of 3-5. This would reduce per-batch time to ~400-1000ms:

```javascript
const CONCURRENCY = 5;
for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
  const batch = result.rows.slice(i, i + CONCURRENCY);
  await Promise.allSettled(batch.map(row => this._processRow(row)));
}
```

### PERF-03: Per-Log Database INSERT

**File:** `src/logging.js:42-52`

```javascript
if (this._pool) {
  try {
    await this._pool.query(
      'INSERT INTO system_logs (level, source, content) VALUES ($1, $2, $3)',
      [level, source, content],
    );
  } catch (err) { ... }
}
```

Every log statement issues a separate `INSERT` query to PostgreSQL. The logger methods (`debug`, `info`, `warn`, `error`) return the promise from `_log`, but callers do not await them -- meaning log writes are fire-and-forget but still consume database connections from the pool.

During heavy logging (e.g., debug level with embedding worker processing), this could saturate the connection pool (default 10 connections in pg) and delay actual application queries.

**Impact:** Database connection pool contention under heavy logging. Each log adds ~1-5ms of database overhead.

**Recommendation:** Implement batched log writing -- queue log entries in memory and flush to the database in a single multi-row INSERT every N seconds or every M entries:

```javascript
// Example: batch insert every 5 seconds or 50 entries
INSERT INTO system_logs (level, source, content) VALUES
  ($1, $2, $3), ($4, $5, $6), ...
```

---

## Medium Priority

### PERF-04: Array.reverse() on Every History Fetch

**Files:** `src/claude/conversation.js:67`, `src/hooks/lifecycle.js:256`

```javascript
// conversation.js:58-67
const result = await this.db.query(
  `SELECT ... FROM conversation_messages ORDER BY created_at DESC LIMIT $1`,
  [effectiveLimit],
);
return result.rows.reverse();
```

The query sorts `DESC` to get the N most recent rows, then reverses the array in JavaScript to get chronological order. With the default threshold of 100 messages, this creates and copies a 100-element array on every call.

The same pattern appears in `lifecycle.js:250-256` where 20 rows are fetched DESC and reversed.

**Impact:** Minor -- O(n) array copy per call. Negligible for current sizes but wasteful.

**Recommendation:** Use a subquery to get the correct order from SQL:

```sql
SELECT * FROM (
  SELECT ... FROM conversation_messages ORDER BY created_at DESC LIMIT $1
) sub ORDER BY created_at ASC
```

### PERF-05: No Caching for Dashboard and Health Queries

**File:** `src/web/server.js:172-228, 289-319`

The dashboard handler issues 4 database queries per page load:
1. `COUNT(*) FROM conversation_messages` (line 185)
2. `SELECT ... FROM conversation_messages ORDER BY ... LIMIT 10` (line 197)
3. `SELECT session_id ... LIMIT 1` (line 208)
4. `SELECT ... FROM system_logs WHERE level = 'error' LIMIT 5` (line 217)

The health endpoint issues `SELECT 1` on every request (line 302).

The database page handler issues 4 queries including `pg_total_relation_size` (line 358-369) which scans system catalogs.

**Impact:** Unnecessary database load if the dashboard is auto-refreshed or monitored.

**Recommendation:** Add simple in-memory TTL caching (30-60 seconds) for dashboard stats and health checks. Example:

```javascript
class Cache {
  constructor(ttlMs = 30000) { ... }
  get(key) { ... }
  set(key, value) { ... }
}
```

### PERF-06: Array.shift() in Rate Limiter Hot Path

**File:** `src/rate-limiter.js:30-32`

```javascript
while (this._timestamps.length > 0 && this._timestamps[0] <= cutoff) {
  this._timestamps.shift();  // O(n) per call
}
```

`Array.shift()` is O(n) because it copies all remaining elements forward. With `maxPerMinute` of 10-30, the array is small and the cost is negligible. However, if rate limits are increased significantly, this becomes a hot path.

**Impact:** Negligible at current scale. O(n^2) total cost over a sliding window cycle.

**Recommendation:** Track the window start index instead of shifting, and reset the array when the index passes halfway:

```javascript
_prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (this._startIdx < this._timestamps.length && this._timestamps[this._startIdx] <= cutoff) {
    this._startIdx++;
  }
  if (this._startIdx > this._timestamps.length / 2) {
    this._timestamps = this._timestamps.slice(this._startIdx);
    this._startIdx = 0;
  }
}
```

### PERF-07: No Connection Pool Configuration

**File:** `src/db/pool.js:6-8`

```javascript
const pool = new Pool({
  connectionString: config.DATABASE_URL,
});
```

The pg pool uses default settings: `max: 10` connections, `idleTimeoutMillis: 10000`, `connectionTimeoutMillis: 0` (infinite). For a single-user bot on a Raspberry Pi:

- 10 connections is likely excessive for PostgreSQL's memory overhead (~10MB each)
- Infinite connection timeout means a query will wait forever if the pool is exhausted
- No `statement_timeout` to catch runaway queries

**Impact:** Excessive memory usage on constrained hardware; potential hangs on pool exhaustion.

**Recommendation:** Configure the pool explicitly:

```javascript
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
```

### PERF-08: `execSync` Blocks Event Loop During Startup

**File:** `src/index.js:103`

```javascript
const version = execSync('claude --version', {
  timeout: 10_000,
  encoding: 'utf-8',
}).trim();
```

`execSync` blocks the entire event loop for up to 10 seconds. During startup this is less critical since no requests are being served, but if `claude` is slow to respond (e.g., network lookup, first-time `npx` download), the web admin panel won't start until this completes.

**Impact:** Startup delay of up to 10 seconds if `claude --version` is slow.

**Recommendation:** Use async `execFile` or `spawn` with a promise wrapper. This allows the web server to start serving the settings page in parallel.

### PERF-09: String Concatenation in HTTP Response Handlers

**File:** `src/mcp/embed-server.js:48-49`

```javascript
let data = '';
res.on('data', (chunk) => { data += chunk; });
```

String concatenation in a loop creates intermediate strings that must be garbage collected. For typical embedding API responses (~5-20KB), this is negligible. For larger responses, using an array and join would be more efficient.

The same pattern appears in `src/telegram/bot.js` for the API call response, but there it correctly uses `Buffer.concat` (line 420).

**Impact:** Minor -- only affects embedding API responses.

**Recommendation:** Use the array-and-join pattern for consistency:

```javascript
const chunks = [];
res.on('data', (chunk) => chunks.push(chunk));
res.on('end', () => {
  const data = Buffer.concat(chunks).toString('utf-8');
  ...
});
```

### PERF-10: Unbounded Rate Limiter Queue

**File:** `src/rate-limiter.js:87-89`

```javascript
return new Promise((resolve) => {
  this._queue.push({ resolve });
  this._scheduleDrain();
});
```

The rate limiter queue grows without bound. If messages arrive faster than the rate limit allows, the queue accumulates promises. Each queued promise holds a reference to its closure, preventing garbage collection.

At 10 calls/minute for Claude, a burst of 100 messages would queue 90 promises, each waiting up to 9 minutes. For Telegram at 30/minute, the queue drains faster but is still unbounded.

**Impact:** Memory growth during sustained bursts. Each queued item is small (~100 bytes), so 100 items is ~10KB -- negligible. But in degenerate cases (e.g., bot added to a group chat receiving hundreds of messages), the queue could grow significantly.

**Recommendation:** Add a maximum queue depth with a rejection behavior:

```javascript
if (this._queue.length >= MAX_QUEUE_DEPTH) {
  return Promise.reject(new Error('Rate limit queue full'));
}
```

---

## Low Priority

### PERF-11: nextCronDate Scans Up to 527,040 Minutes

**File:** `src/scheduler/worker.js:26-48`

```javascript
for (let i = 0; i < MAX_SCAN_MINUTES; i++) {  // MAX_SCAN_MINUTES = 527,040
  if (matcher.match(candidate)) {
    return new Date(candidate.getTime());
  }
  candidate.setMinutes(candidate.getMinutes() + 1);
}
```

For each scheduled task, the worst case scans ~366 days of minutes (527,040 iterations) to find the next match. For well-formed cron expressions this completes quickly (usually < 60 iterations), but a pathological expression like `0 0 31 2 *` (Feb 31) would scan all 527K minutes before returning null.

Additionally, a new `cron.schedule()` task object is created just to access the matcher (line 28-31), which is wasteful.

**Impact:** Occasional CPU spike during scheduler initialization if tasks have unusual expressions.

**Recommendation:** Consider using a dedicated cron-parsing library that computes next-run analytically rather than by minute-scanning.

### PERF-12: Dashboard Queries Not Parallelized

**File:** `src/web/server.js:184-226`

The dashboard handler runs 4 sequential database queries with `await` between each. These queries are independent and could run concurrently:

```javascript
const [countRes, recent, session, errors] = await Promise.all([
  this._db.query('SELECT COUNT(*)::int ...'),
  this._db.query('SELECT ... FROM conversation_messages ... LIMIT 10'),
  this._db.query('SELECT session_id ... LIMIT 1'),
  this._db.query('SELECT ... FROM system_logs ... LIMIT 5'),
]);
```

**Impact:** Dashboard page load takes ~4x the single-query latency instead of ~1x.

**Recommendation:** Use `Promise.all` or `Promise.allSettled` for independent queries.

### PERF-13: Lifecycle Hook Conversation History Fetch is Redundant

**File:** `src/hooks/lifecycle.js:248-264`

The `on_pre_claude` hook fetches the 20 most recent conversation messages and attaches them to the context as `conversationContext`. However, this context doesn't appear to be used by the Claude bridge invocation at `src/index.js:198-202` -- the bridge only receives `text`, `sessionId`, and `systemPrompt`. The conversation context is fetched and then discarded.

**Impact:** Unnecessary database query and memory allocation on every message.

**Recommendation:** Remove the conversation history fetch from the hook if it's not consumed downstream. If it's intended for future use, add a feature flag to skip it.

### PERF-14: Compaction Loads All Old Messages Into Memory

**File:** `src/claude/conversation.js:146-161`

```javascript
const oldMessages = await this.db.query(
  `SELECT id, created_at, role, content FROM conversation_messages
   ORDER BY created_at ASC LIMIT $1`,
  [removeCount],
);
```

With a threshold of 100 and `keepRecent` of 20, compaction loads up to 80 messages into memory. With an average message size of ~500 bytes, this is ~40KB -- negligible. However, if the threshold is increased to 1000 or messages are very long, this could consume significant memory.

The messages are then formatted into a single string and sent to Claude for summarization (line 159-161), which could produce a very large prompt.

**Impact:** Memory spike proportional to `HISTORY_COMPACT_THRESHOLD * avg_message_size`.

**Recommendation:** For large thresholds, consider streaming or chunked summarization.

### PERF-15: Typing Indicator Interval Overhead

**File:** `src/telegram/bot.js:331-344`

Each active typing indicator creates a `setInterval` that fires every 4 seconds, making an HTTPS request to Telegram. While only one conversation is active at a time (single user), the interval continues even if the Claude response is assembling quickly.

**Impact:** Unnecessary network traffic (~1 request/4 seconds during processing). Negligible bandwidth but adds noise to logs and consumes a connection slot.

**Recommendation:** Consider using a single pending-typing flag checked by the poll loop instead of per-chat intervals.

### PERF-16: Web Admin HTML Templates Regenerated Per Request

**File:** `src/web/server.js:595-1255`

All HTML templates (`layoutHTML`, `dashboardHTML`, `settingsHTML`, `logsHTML`, `databaseHTML`) are generated from scratch on every request via string concatenation. The CSS (~280 lines) is inlined in every page response.

For a single-user admin panel, this is acceptable. The CSS is ~5KB and the templates are simple string concatenation.

**Impact:** Negligible for single-user access. ~5KB overhead per page from repeated CSS.

**Recommendation:** Optional: Extract CSS to a static file served with cache headers. This would also enable browser caching.

---

## Architecture Notes

### What Works Well

1. **Single-threaded simplicity** -- The application avoids concurrency complexity by processing one message at a time through the Claude bridge. This eliminates most race condition classes.

2. **Event-driven lifecycle hooks** -- The hook pipeline cleanly separates concerns without adding overhead. Sequential handler execution prevents ordering bugs.

3. **Rate limiter design** -- The sliding-window rate limiter with queuing is an effective pattern that backpressures callers without dropping requests.

4. **Minimal dependencies** -- Only 5 runtime dependencies (express, pg, node-cron, dotenv, open), which minimizes supply chain risk and keeps the bundle small.

5. **Background workers with overlap guards** -- Both the embedding worker and scheduler worker use `_processing` flags to prevent overlapping iterations, which is appropriate for the polling pattern.

### Scaling Considerations

If the application were to scale beyond single-user:

1. **Database queries should be indexed** -- The `conversation_messages` table is queried by `created_at DESC` frequently. Ensure a B-tree index exists on `created_at`.

2. **Connection pooling** would need to be properly sized per concurrent user.

3. **The Claude bridge is single-process** -- Only one Claude subprocess runs at a time. Multiple users would need a queue or multiple bridge instances.

4. **The scheduler checks `claudeBridge.isActive()`** before running tasks (line 183). This means scheduled tasks are delayed while any user message is being processed. For multi-user, the scheduler would need its own bridge instance.

---

*End of Performance Audit Report*
