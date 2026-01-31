import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

// Load .env from project root
dotenvConfig({ path: ENV_PATH });

const env = process.env;

const config = {
  // Required
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_ALLOWED_USERS: env.TELEGRAM_ALLOWED_USERS || '',
  DATABASE_URL: env.DATABASE_URL || '',

  // Claude Bridge
  CLAUDE_MODEL: env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  CLAUDE_THINKING: env.CLAUDE_THINKING || 'true',
  CLAUDE_TIMEOUT: parseInt(env.CLAUDE_TIMEOUT, 10) || 120000,
  CLAUDE_MAX_BUDGET: env.CLAUDE_MAX_BUDGET || '',

  // Storage
  DATA_DIR: env.DATA_DIR || path.join(os.homedir(), 'data'),

  // MCP
  MCP_CONFIG_PATH: env.MCP_CONFIG_PATH || path.join(os.homedir(), '.claude', 'mcp.json'),
  MCP_TOOLS_WHITELIST: env.MCP_TOOLS_WHITELIST || '*',
  COMMANDS_WHITELIST: env.COMMANDS_WHITELIST || '',

  // Security
  FILE_EDIT_PATHS: env.FILE_EDIT_PATHS || '',

  // Rate Limiting
  RATE_LIMIT_CLAUDE: parseInt(env.RATE_LIMIT_CLAUDE, 10) || 10,
  RATE_LIMIT_TELEGRAM: parseInt(env.RATE_LIMIT_TELEGRAM, 10) || 30,

  // Conversation
  HISTORY_COMPACT_THRESHOLD: parseInt(env.HISTORY_COMPACT_THRESHOLD, 10) || 100,

  // Logging
  LOG_LEVEL: env.LOG_LEVEL || 'info',

  // Web Admin
  WEB_PORT: parseInt(env.WEB_PORT, 10) || 3000,
  WEB_BIND: env.WEB_BIND || '127.0.0.1',
  AUTO_OPEN_BROWSER: env.AUTO_OPEN_BROWSER || 'true',

  // Embeddings
  EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER || '',
  EMBEDDING_API_KEY: env.EMBEDDING_API_KEY || '',
  EMBEDDING_MODEL: env.EMBEDDING_MODEL || 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS || '',
  EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL || '',
};

// Ensure DATABASE_URL includes a database name (default: 2ndbrain)
if (config.DATABASE_URL) {
  try {
    const url = new URL(config.DATABASE_URL);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/2ndbrain';
      config.DATABASE_URL = url.toString();
    }
  } catch {
    // leave as-is if URL parsing fails
  }
}

const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'DATABASE_URL'];

/**
 * Validates that all required configuration variables are present and non-empty.
 * Returns an object with `valid` boolean and `missing` array of variable names.
 */
function validateConfig() {
  const missing = REQUIRED_VARS.filter((key) => !config[key]);
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Returns true if this appears to be a first run -- either the .env file
 * does not exist or required configuration variables are missing.
 */
function isFirstRun() {
  if (!fs.existsSync(ENV_PATH)) {
    return true;
  }
  const { valid } = validateConfig();
  return !valid;
}

export { config, validateConfig, isFirstRun, PROJECT_ROOT, ENV_PATH };
export default config;
