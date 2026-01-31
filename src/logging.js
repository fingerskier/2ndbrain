import config from './config.js';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Structured logger that writes to both the console and the system_logs
 * database table. Before `init()` is called, logs are console-only.
 */
class Logger {
  constructor() {
    this._pool = null;
    this._minLevel = LOG_LEVELS[config.LOG_LEVEL] ?? LOG_LEVELS.info;
  }

  /**
   * Initialize database logging. Must be called after the pool is ready.
   * @param {import('pg').Pool} pool
   */
  init(pool) {
    this._pool = pool;
  }

  /**
   * Core logging method. Writes to console (always) and to the database
   * (when pool is available). Database write failures are caught and
   * printed to stderr so they never crash the caller.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} source - Component name (e.g. 'telegram', 'claude')
   * @param {string} content - Log message
   */
  async _log(level, source, content) {
    const numericLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (numericLevel < this._minLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[${timestamp}] [${level}] [${source}] ${content}`);

    if (this._pool) {
      try {
        await this._pool.query(
          'INSERT INTO system_logs (level, source, content) VALUES ($1, $2, $3)',
          [level, source, content],
        );
      } catch (err) {
        // Avoid recursive logging -- print directly to stderr
        console.error(`[${timestamp}] [error] [logger] Failed to write log to database:`, err.message);
      }
    }
  }

  /**
   * @param {string} source
   * @param {string} content
   */
  debug(source, content) {
    return this._log('debug', source, content);
  }

  /**
   * @param {string} source
   * @param {string} content
   */
  info(source, content) {
    return this._log('info', source, content);
  }

  /**
   * @param {string} source
   * @param {string} content
   */
  warn(source, content) {
    return this._log('warn', source, content);
  }

  /**
   * @param {string} source
   * @param {string} content
   */
  error(source, content) {
    return this._log('error', source, content);
  }
}

const logger = new Logger();

export { Logger, logger };
export default logger;
