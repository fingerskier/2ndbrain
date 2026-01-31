import express from 'express';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve project root (two directories up from src/web/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

// ---------------------------------------------------------------------------
// Settings field definitions -- drives both the form UI and save logic
// ---------------------------------------------------------------------------

const SETTINGS_FIELDS = [
  {
    section: 'Telegram',
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', required: true, secret: true, hint: 'Telegram Bot API token from @BotFather' },
      { key: 'TELEGRAM_ALLOWED_USERS', label: 'Allowed Users', required: true, hint: 'Comma-separated Telegram user IDs' },
    ],
  },
  {
    section: 'Database',
    fields: [
      { key: 'DATABASE_URL', label: 'Database URL', required: true, secret: true, hint: 'PostgreSQL connection string (e.g. postgresql://user:pass@localhost/2ndbrain)' },
    ],
  },
  {
    section: 'Claude',
    fields: [
      { key: 'CLAUDE_MODEL', label: 'Model', hint: 'Default: claude-sonnet-4-20250514' },
      { key: 'CLAUDE_THINKING', label: 'Thinking', hint: 'Enable extended thinking (true/false)' },
      { key: 'CLAUDE_TIMEOUT', label: 'Timeout (ms)', hint: 'Default: 120000' },
      { key: 'CLAUDE_MAX_BUDGET', label: 'Max Budget (USD)', hint: 'Max cost per invocation (e.g. 0.50)' },
    ],
  },
  {
    section: 'Storage',
    fields: [
      { key: 'DATA_DIR', label: 'Data Directory', hint: 'Default: ~/data' },
    ],
  },
  {
    section: 'Security',
    fields: [
      { key: 'COMMANDS_WHITELIST', label: 'Commands Whitelist', hint: 'Allowed shell command patterns (comma-separated)' },
      { key: 'MCP_TOOLS_WHITELIST', label: 'MCP Tools Whitelist', hint: 'Allowed MCP tool names (* = all)' },
      { key: 'FILE_EDIT_PATHS', label: 'File Edit Paths', hint: 'Additional writable directories (comma-separated absolute paths)' },
    ],
  },
  {
    section: 'Rate Limits',
    fields: [
      { key: 'RATE_LIMIT_CLAUDE', label: 'Claude Rate Limit', hint: 'Max Claude calls per minute (default: 10)' },
      { key: 'RATE_LIMIT_TELEGRAM', label: 'Telegram Rate Limit', hint: 'Max Telegram sends per minute (default: 30)' },
    ],
  },
  {
    section: 'Conversation',
    fields: [
      { key: 'HISTORY_COMPACT_THRESHOLD', label: 'Compact Threshold', hint: 'Message count before auto-compaction (default: 100)' },
    ],
  },
  {
    section: 'Logging',
    fields: [
      { key: 'LOG_LEVEL', label: 'Log Level', hint: 'debug, info, warn, error (default: info)' },
    ],
  },
  {
    section: 'Web Admin',
    fields: [
      { key: 'WEB_PORT', label: 'Port', hint: 'Default: 3000' },
      { key: 'WEB_BIND', label: 'Bind Address', hint: 'Default: 127.0.0.1' },
      { key: 'AUTO_OPEN_BROWSER', label: 'Auto Open Browser', hint: 'true/false (default: true)' },
    ],
  },
  {
    section: 'Embeddings',
    fields: [
      { key: 'EMBEDDING_PROVIDER', label: 'Provider', hint: '"openai" or empty to disable' },
      { key: 'EMBEDDING_API_KEY', label: 'API Key', secret: true, hint: 'API key for the embedding provider' },
      { key: 'EMBEDDING_MODEL', label: 'Model', hint: 'Default: text-embedding-3-small' },
      { key: 'EMBEDDING_DIMENSIONS', label: 'Dimensions', hint: 'Override output dimensions (empty = model default)' },
      { key: 'EMBEDDING_BASE_URL', label: 'Base URL', hint: 'Override API base URL (empty = provider default)' },
    ],
  },
];

// ---------------------------------------------------------------------------
// WebServer
// ---------------------------------------------------------------------------

class WebServer {
  /**
   * @param {object}  opts
   * @param {object}  opts.config - Application configuration object
   * @param {object}  opts.db     - Database interface with query(text, params)
   * @param {object}  opts.logger - Logger instance with info/warn/error methods
   */
  constructor({ config, db, logger }) {
    this._config = config;
    this._db = db;
    this._logger = logger;
    this._server = null;
    this._app = null;
    this._envPath = config.ENV_PATH || DEFAULT_ENV_PATH;
  }

  /**
   * Create the Express app, bind routes, and start listening.
   * @returns {Promise<import('node:http').Server>} The HTTP server instance
   */
  async start() {
    const app = express();
    this._app = app;

    // Body parsing
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // Routes
    app.get('/', (req, res) => this._handleDashboard(req, res));
    app.get('/settings', (req, res) => this._handleSettings(req, res));
    app.post('/settings', (req, res) => this._handleSaveSettings(req, res));
    app.get('/logs', (req, res) => this._handleLogs(req, res));
    app.get('/health', (req, res) => this._handleHealth(req, res));

    // Start listening
    const server = createServer(app);
    this._server = server;

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._config.WEB_PORT, this._config.WEB_BIND, () => {
        server.removeListener('error', reject);
        this._logger.info(
          'web',
          `Admin server listening on http://${this._config.WEB_BIND}:${this._config.WEB_PORT}`,
        );
        resolve(server);
      });
    });
  }

  /**
   * Gracefully close the HTTP server.
   */
  async stop() {
    if (!this._server) return;
    return new Promise((resolve, reject) => {
      this._server.close((err) => {
        this._server = null;
        if (err) {
          reject(err);
        } else {
          this._logger.info('web', 'Admin server stopped');
          resolve();
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // Route handlers
  // -----------------------------------------------------------------------

  async _handleDashboard(_req, res) {
    const data = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      messageCount: 0,
      recentMessages: [],
      activeSessionId: null,
      embeddingStatus: this._config.EMBEDDING_PROVIDER ? 'enabled' : 'disabled',
      recentErrors: [],
      dbAvailable: true,
    };

    try {
      const countRes = await this._db.query(
        'SELECT COUNT(*)::int AS count FROM conversation_messages',
      );
      data.messageCount = countRes.rows[0]?.count ?? 0;
    } catch {
      data.dbAvailable = false;
    }

    if (data.dbAvailable) {
      try {
        const recent = await this._db.query(
          `SELECT id, created_at, session_id, role,
                  LEFT(content, 200) AS content
             FROM conversation_messages
            ORDER BY created_at DESC
            LIMIT 10`,
        );
        data.recentMessages = recent.rows;
      } catch { /* query failed, leave empty */ }

      try {
        const session = await this._db.query(
          `SELECT session_id FROM conversation_messages
            WHERE session_id IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
        );
        data.activeSessionId = session.rows[0]?.session_id ?? null;
      } catch { /* leave null */ }

      try {
        const errors = await this._db.query(
          `SELECT id, created_at, level, source, content
             FROM system_logs
            WHERE level = 'error'
            ORDER BY created_at DESC
            LIMIT 5`,
        );
        data.recentErrors = errors.rows;
      } catch { /* leave empty */ }
    }

    res.send(dashboardHTML(data));
  }

  async _handleSettings(req, res) {
    const message = req.query.saved === '1'
      ? { type: 'success', text: 'Settings saved. Restart the service for changes to take effect.' }
      : null;

    res.send(settingsHTML(this._config, message));
  }

  async _handleSaveSettings(req, res) {
    try {
      const body = req.body;
      const values = {};

      for (const section of SETTINGS_FIELDS) {
        for (const field of section.fields) {
          const formValue = body[field.key];
          if (formValue === undefined) continue;

          // For secret fields, empty submission means "keep existing value"
          if (field.secret && formValue === '') continue;

          values[field.key] = formValue;
        }
      }

      this._writeEnvFile(values);
      this._logger.info('web', 'Settings updated via web admin');
      res.redirect('/settings?saved=1');
    } catch (err) {
      this._logger.error('web', `Failed to save settings: ${err.message}`);
      res.status(500).send(
        layoutHTML('Error', `<h1>Failed to Save Settings</h1><p>${esc(err.message)}</p>`),
      );
    }
  }

  async _handleLogs(req, res) {
    const level = req.query.level || '';
    let logs = [];

    try {
      const validLevels = ['debug', 'info', 'warn', 'error'];
      let sql = 'SELECT id, created_at, level, source, content FROM system_logs';
      const params = [];

      if (level && validLevels.includes(level)) {
        sql += ' WHERE level = $1';
        params.push(level);
      }

      sql += ' ORDER BY created_at DESC LIMIT 100';
      const result = await this._db.query(sql, params);
      logs = result.rows;
    } catch { /* database unavailable, show empty */ }

    res.send(logsHTML(logs, level));
  }

  async _handleHealth(_req, res) {
    const health = {
      status: 'ok',
      components: {
        database: 'ok',
        telegram: 'unknown',
        claude: 'unknown',
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };

    try {
      await this._db.query('SELECT 1');
    } catch {
      health.components.database = 'error';
    }

    // Derive overall status from component states
    const states = Object.values(health.components);
    if (states.includes('error')) {
      health.status = states.every((s) => s === 'error') ? 'error' : 'degraded';
    }

    const httpStatus = health.status === 'error' ? 503 : 200;
    res.status(httpStatus).json(health);
  }

  // -----------------------------------------------------------------------
  // .env file helpers
  // -----------------------------------------------------------------------

  _readEnvFile() {
    try {
      return fs.readFileSync(this._envPath, 'utf-8');
    } catch {
      return '';
    }
  }

  _writeEnvFile(values) {
    const content = this._readEnvFile();
    const lines = content.split('\n');
    const written = new Set();

    // Pass 1: update existing key=value lines in place
    const updated = lines.map((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (match && match[1] in values) {
        written.add(match[1]);
        return fmtEnvLine(match[1], values[match[1]]);
      }
      return line;
    });

    // Pass 2: append any new keys that were not already in the file
    for (const [key, value] of Object.entries(values)) {
      if (!written.has(key)) {
        updated.push(fmtEnvLine(key, value));
      }
    }

    let result = updated.join('\n');
    if (!result.endsWith('\n')) result += '\n';

    fs.writeFileSync(this._envPath, result, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** HTML-escape a string to prevent XSS. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a .env line, quoting the value when needed. */
function fmtEnvLine(key, value) {
  if (value === '' || value === undefined || value === null) {
    return `${key}=`;
  }
  // Quote values containing whitespace, quotes, hashes, or dollar signs
  if (/[\s"'#$\\]/.test(value)) {
    return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return `${key}=${value}`;
}

/** Format seconds into a human-readable uptime string. */
function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  parts.push(`${h}h`, `${m}m`, `${s}s`);
  return parts.join(' ');
}

/** Format bytes into a human-readable size string. */
function fmtBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

/** Format a timestamp for display (UTC, no milliseconds). */
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Mask a secret value for display, showing only partial bookends. */
function maskValue(value) {
  if (!value) return '(not set)';
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 8, 20)) + s.slice(-4);
}

// ---------------------------------------------------------------------------
// HTML template functions
// ---------------------------------------------------------------------------

/**
 * Base page layout. Wraps content in a full HTML document with navigation,
 * dark-theme CSS, and responsive structure.
 */
function layoutHTML(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} - 2ndbrain</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    line-height: 1.6;
    min-height: 100vh;
  }

  /* --- Navigation --- */
  nav {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 0.75rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  nav .brand {
    font-weight: 700;
    font-size: 1.1rem;
    color: #f0f6fc;
    text-decoration: none;
  }
  nav a { color: #58a6ff; text-decoration: none; font-size: 0.9rem; }
  nav a:hover { text-decoration: underline; }

  /* --- Layout --- */
  .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
  h1 { color: #f0f6fc; margin-bottom: 1rem; font-size: 1.5rem; }
  h2 { color: #f0f6fc; margin: 1.5rem 0 0.75rem; font-size: 1.2rem; }

  /* --- Cards & grid --- */
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .stat-label {
    font-size: 0.78rem;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .stat-value {
    font-size: 1.35rem;
    font-weight: 600;
    color: #f0f6fc;
    word-break: break-all;
  }
  .stat-value.small { font-size: 0.9rem; }

  /* --- Table --- */
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid #30363d;
    color: #8b949e;
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
  }
  td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }
  tr:hover td { background: rgba(88,166,255,0.04); }

  /* --- Role colours --- */
  .role-user      { color: #58a6ff; }
  .role-assistant  { color: #3fb950; }
  .role-system     { color: #d29922; }
  .role-summary    { color: #8b949e; }

  /* --- Level colours --- */
  .level-debug { color: #8b949e; }
  .level-info  { color: #58a6ff; }
  .level-warn  { color: #d29922; }
  .level-error { color: #f85149; }

  /* --- Badges --- */
  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-ok       { background: rgba(63,185,80,0.15);  color: #3fb950; }
  .badge-error    { background: rgba(248,81,73,0.15);  color: #f85149; }
  .badge-warn     { background: rgba(210,153,34,0.15); color: #d29922; }
  .badge-disabled { background: rgba(139,148,158,0.15);color: #8b949e; }

  /* --- Settings form --- */
  .form-section { margin-bottom: 1.5rem; }
  .form-section h3 {
    color: #f0f6fc;
    font-size: 1rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #21262d;
  }
  .form-group {
    margin-bottom: 0.75rem;
    display: grid;
    grid-template-columns: 220px 1fr;
    align-items: start;
    gap: 0.75rem;
  }
  label {
    font-size: 0.88rem;
    color: #c9d1d9;
    padding-top: 0.4rem;
  }
  label .required { color: #f85149; }
  label .hint {
    display: block;
    font-size: 0.74rem;
    color: #8b949e;
    margin-top: 0.15rem;
  }
  input[type="text"],
  input[type="password"] {
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 4px;
    color: #c9d1d9;
    font-size: 0.88rem;
    font-family: inherit;
  }
  input:focus {
    outline: none;
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88,166,255,0.2);
  }
  .secret-current {
    font-size: 0.78rem;
    color: #8b949e;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    margin-bottom: 0.25rem;
  }
  button[type="submit"] {
    background: #238636;
    color: #fff;
    border: none;
    padding: 0.6rem 1.5rem;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    margin-top: 1rem;
  }
  button[type="submit"]:hover { background: #2ea043; }

  /* --- Alerts --- */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.88rem;
  }
  .alert-success {
    background: rgba(63,185,80,0.1);
    border: 1px solid rgba(63,185,80,0.3);
    color: #3fb950;
  }
  .alert-error {
    background: rgba(248,81,73,0.1);
    border: 1px solid rgba(248,81,73,0.3);
    color: #f85149;
  }

  /* --- Log viewer --- */
  .log-filters {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .log-filters a {
    padding: 0.3rem 0.75rem;
    border-radius: 4px;
    font-size: 0.84rem;
    text-decoration: none;
    color: #c9d1d9;
    background: #21262d;
    border: 1px solid #30363d;
  }
  .log-filters a.active {
    background: #388bfd;
    color: #fff;
    border-color: #388bfd;
  }
  .log-filters a:hover { border-color: #58a6ff; }
  .log-entry {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.8rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid #21262d;
    display: grid;
    grid-template-columns: 175px 52px 110px 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .log-time   { color: #8b949e; }
  .log-source { color: #d2a8ff; }
  .log-content { color: #c9d1d9; word-break: break-word; white-space: pre-wrap; }

  /* --- Misc --- */
  .muted   { color: #8b949e; }
  .empty   { color: #8b949e; text-align: center; padding: 2rem; }
  .db-warn {
    background: rgba(210,153,34,0.1);
    border: 1px solid rgba(210,153,34,0.25);
    color: #d29922;
    padding: 0.6rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.88rem;
  }

  @media (max-width: 768px) {
    .form-group { grid-template-columns: 1fr; gap: 0.25rem; }
    .log-entry  { grid-template-columns: 1fr; gap: 0.15rem; }
    .grid       { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<nav>
  <a class="brand" href="/">2ndbrain</a>
  <a href="/">Dashboard</a>
  <a href="/settings">Settings</a>
  <a href="/logs">Logs</a>
</nav>
<div class="container">
${content}
</div>
</body>
</html>`;
}

/**
 * Dashboard page showing system status, recent messages, and errors.
 */
function dashboardHTML(data) {
  const mem = data.memory;

  // -- Stats grid ----------------------------------------------------------
  const stats = `
  <div class="grid">
    <div class="card">
      <div class="stat-label">Uptime</div>
      <div class="stat-value">${esc(fmtUptime(data.uptime))}</div>
    </div>
    <div class="card">
      <div class="stat-label">Memory (RSS)</div>
      <div class="stat-value">${fmtBytes(mem.rss)}</div>
    </div>
    <div class="card">
      <div class="stat-label">Heap Used</div>
      <div class="stat-value">${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}</div>
    </div>
    <div class="card">
      <div class="stat-label">Messages</div>
      <div class="stat-value">${data.messageCount}</div>
    </div>
    <div class="card">
      <div class="stat-label">Active Session</div>
      <div class="stat-value small">${data.activeSessionId ? esc(data.activeSessionId) : '<span class="muted">none</span>'}</div>
    </div>
    <div class="card">
      <div class="stat-label">Embeddings</div>
      <div class="stat-value">
        <span class="badge ${data.embeddingStatus === 'enabled' ? 'badge-ok' : 'badge-disabled'}">${data.embeddingStatus}</span>
      </div>
    </div>
  </div>`;

  // -- DB warning ----------------------------------------------------------
  const dbWarn = data.dbAvailable
    ? ''
    : '<div class="db-warn">Database is unavailable. Dashboard data may be incomplete.</div>';

  // -- Recent messages -----------------------------------------------------
  let messagesSection;
  if (data.recentMessages.length > 0) {
    const rows = data.recentMessages.map((msg) => `
      <tr>
        <td style="white-space:nowrap;">${fmtTime(msg.created_at)}</td>
        <td><span class="role-${esc(msg.role)}">${esc(msg.role)}</span></td>
        <td>${esc(msg.content || '')}</td>
      </tr>`).join('');

    messagesSection = `
    <h2>Recent Messages</h2>
    <div class="card" style="overflow-x:auto;">
      <table>
        <thead><tr><th>Time</th><th>Role</th><th>Content</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } else {
    messagesSection = `
    <h2>Recent Messages</h2>
    <div class="card"><p class="empty">No messages yet.</p></div>`;
  }

  // -- Recent errors -------------------------------------------------------
  let errorsSection = '';
  if (data.recentErrors.length > 0) {
    const rows = data.recentErrors.map((log) => `
      <tr>
        <td style="white-space:nowrap;">${fmtTime(log.created_at)}</td>
        <td>${esc(log.source || '')}</td>
        <td>${esc(log.content)}</td>
      </tr>`).join('');

    errorsSection = `
    <h2>Recent Errors</h2>
    <div class="card" style="overflow-x:auto;">
      <table>
        <thead><tr><th>Time</th><th>Source</th><th>Content</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  return layoutHTML('Dashboard', `
    <h1>Dashboard</h1>
    ${dbWarn}
    ${stats}
    ${messagesSection}
    ${errorsSection}
  `);
}

/**
 * Settings page with a form for every configurable env var.
 * Secret fields are shown as password inputs with a masked current-value hint.
 */
function settingsHTML(config, message) {
  const alert = message
    ? `<div class="alert alert-${esc(message.type)}">${esc(message.text)}</div>`
    : '';

  const sections = SETTINGS_FIELDS.map((section) => {
    const fields = section.fields.map((field) => {
      const value = config[field.key] ?? '';
      let inputArea;

      if (field.secret) {
        const status = value
          ? `Current: ${esc(maskValue(String(value)))}`
          : '(not set)';
        inputArea = `
          <div>
            <div class="secret-current">${status}</div>
            <input type="password" name="${esc(field.key)}"
                   value="" placeholder="Enter new value to change"
                   autocomplete="off" />
          </div>`;
      } else {
        inputArea = `<input type="text" name="${esc(field.key)}"
                            value="${esc(String(value))}" />`;
      }

      return `
      <div class="form-group">
        <label>
          ${esc(field.label)}${field.required ? ' <span class="required">*</span>' : ''}
          ${field.hint ? `<span class="hint">${esc(field.hint)}</span>` : ''}
        </label>
        ${inputArea}
      </div>`;
    }).join('');

    return `
    <div class="form-section">
      <h3>${esc(section.section)}</h3>
      ${fields}
    </div>`;
  }).join('');

  return layoutHTML('Settings', `
    <h1>Settings</h1>
    ${alert}
    <form method="POST" action="/settings">
      ${sections}
      <button type="submit">Save Settings</button>
    </form>
  `);
}

/**
 * Log viewer page with level filtering.
 */
function logsHTML(logs, activeLevel) {
  const levels = ['', 'debug', 'info', 'warn', 'error'];
  const filters = levels.map((lvl) => {
    const label = lvl ? lvl.charAt(0).toUpperCase() + lvl.slice(1) : 'All';
    const href = lvl ? `/logs?level=${lvl}` : '/logs';
    const cls = activeLevel === lvl ? ' active' : '';
    return `<a href="${href}" class="${cls}">${label}</a>`;
  }).join('');

  let body;
  if (logs.length > 0) {
    body = logs.map((log) => `
      <div class="log-entry">
        <span class="log-time">${fmtTime(log.created_at)}</span>
        <span class="level-${esc(log.level)}">${esc(log.level)}</span>
        <span class="log-source">${esc(log.source || '')}</span>
        <span class="log-content">${esc(log.content)}</span>
      </div>`).join('');
  } else {
    body = '<p class="empty">No log entries found.</p>';
  }

  return layoutHTML('Logs', `
    <h1>Logs</h1>
    <div class="log-filters">${filters}</div>
    <div class="card">${body}</div>
  `);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { WebServer };
export default WebServer;
