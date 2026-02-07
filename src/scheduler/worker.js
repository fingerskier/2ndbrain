import cron from 'node-cron';

/** Milliseconds between processing iterations (1 minute). */
const POLL_INTERVAL_MS = 60_000;

/** Maximum tasks to execute per poll cycle. */
const MAX_TASKS_PER_TICK = 3;

/** Consecutive errors before auto-disabling a task. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Maximum minutes to scan forward when computing next run (366 days). */
const MAX_SCAN_MINUTES = 366 * 24 * 60;

/**
 * Compute the next Date after `from` that matches the cron expression.
 *
 * Uses node-cron's internal timeMatcher to check each minute. Scans up
 * to ~366 days forward before giving up.
 *
 * @param {string} cronExpression - 5-field cron expression
 * @param {Date} from - Start searching from this date (exclusive)
 * @param {string} [timezone='UTC'] - IANA timezone for evaluation
 * @returns {Date|null} Next matching date, or null if none found
 */
function nextCronDate(cronExpression, from, timezone = 'UTC') {
  // Create a temporary task just to access the timeMatcher
  const task = cron.schedule(cronExpression, () => {}, {
    scheduled: false,
    timezone,
  });

  const matcher = task.timeMatcher;

  // Start from the next whole minute after `from`
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (matcher.match(candidate)) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Background scheduler worker -- periodically checks for scheduled tasks
 * whose next_run_at has passed, executes them via the Claude bridge,
 * and delivers results to the user's Telegram chat.
 *
 * Follows the EmbeddingWorker pattern (§11.4): setTimeout-based polling
 * loop with overlap guard.
 */
class SchedulerWorker {
  /**
   * @param {object} deps
   * @param {object} deps.db            - Database query interface ({ query(sql, params) })
   * @param {object} deps.config        - Application configuration
   * @param {object} deps.logger        - Logger instance
   * @param {import('../claude/bridge.js').ClaudeBridge} deps.claudeBridge - Claude SDK bridge
   * @param {import('../telegram/bot.js').TelegramBot} deps.bot - Telegram bot instance
   * @param {object} deps.rateLimiters  - { claude: RateLimiter, ... }
   */
  constructor({ db, config, logger, claudeBridge, bot, rateLimiters, actionTracker = null }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.claudeBridge = claudeBridge;
    this.bot = bot;
    this.rateLimiters = rateLimiters;
    this.actionTracker = actionTracker;

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;

    /** Whether the worker loop is active. */
    this._running = false;

    /** Guard to prevent overlapping iterations. */
    this._processing = false;
  }

  /**
   * Start the periodic scheduler worker loop.
   * Initializes next_run_at for any tasks that need it, then begins polling.
   */
  async start() {
    if (this._running) {
      return;
    }

    this._running = true;
    this.logger.info('scheduler', 'Starting background scheduler worker.');

    try {
      await this._initializeNextRuns();
    } catch (err) {
      this.logger.error('scheduler', `Failed to initialize next runs: ${err.message}`);
    }

    this._scheduleNext();
  }

  /**
   * Stop the worker loop gracefully. Any in-flight iteration will finish
   * before the loop fully halts.
   */
  stop() {
    this._running = false;

    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    this.logger.info('scheduler', 'Scheduler worker stopped.');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * On startup, compute next_run_at for tasks that have NULL or past values.
   * Tasks missed during downtime skip ahead to the next valid time (no
   * retroactive execution).
   */
  async _initializeNextRuns() {
    const result = await this.db.query(
      `SELECT id, cron_expression, timezone
       FROM scheduled_tasks
       WHERE enabled = TRUE
         AND (next_run_at IS NULL OR next_run_at < NOW())`,
    );

    if (result.rows.length === 0) {
      return;
    }

    this.logger.info('scheduler', `Recomputing next_run_at for ${result.rows.length} task(s).`);

    for (const row of result.rows) {
      try {
        if (!cron.validate(row.cron_expression)) {
          this.logger.warn('scheduler', `Invalid cron expression for task ${row.id}: "${row.cron_expression}"; skipping.`);
          continue;
        }

        const nextRun = nextCronDate(row.cron_expression, new Date(), row.timezone);
        if (nextRun) {
          await this.db.query(
            'UPDATE scheduled_tasks SET next_run_at = $1, updated_at = NOW() WHERE id = $2',
            [nextRun.toISOString(), row.id],
          );
        }
      } catch (err) {
        this.logger.warn('scheduler', `Failed to compute next_run_at for task ${row.id}: ${err.message}`);
      }
    }
  }

  /**
   * Schedule the next processing iteration after POLL_INTERVAL_MS.
   */
  _scheduleNext() {
    if (!this._running) {
      return;
    }

    this._timer = setTimeout(async () => {
      this._timer = null;

      // Skip if the previous iteration is still running
      if (this._processing) {
        this._scheduleNext();
        return;
      }

      // Skip if Claude is busy with a user message
      if (this.claudeBridge.isActive()) {
        this.logger.debug('scheduler', 'Skipping tick: Claude query is active.');
        this._scheduleNext();
        return;
      }

      try {
        this._processing = true;
        await this._processQueue();
      } catch (err) {
        this.logger.error('scheduler', `Unexpected error in worker loop: ${err.message}`);
      } finally {
        this._processing = false;
        this._scheduleNext();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Fetch and execute tasks whose next_run_at has passed.
   */
  async _processQueue() {
    const result = await this.db.query(
      `SELECT id, chat_id, cron_expression, task_prompt, description, timezone, error_count
       FROM scheduled_tasks
       WHERE enabled = TRUE
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT $1`,
      [MAX_TASKS_PER_TICK],
    );

    if (result.rows.length === 0) {
      return;
    }

    this.logger.info('scheduler', `Processing ${result.rows.length} scheduled task(s).`);

    for (const row of result.rows) {
      // Re-check if Claude became active between tasks
      if (this.claudeBridge.isActive()) {
        this.logger.debug('scheduler', 'Pausing task execution: Claude became active.');
        break;
      }

      try {
        await this._executeTask(row);
      } catch (err) {
        this.logger.error('scheduler', `Failed to execute task ${row.id}: ${err.message}`);
      }
    }
  }

  /**
   * Execute a single scheduled task: invoke Claude, send the response,
   * and update next_run_at.
   *
   * @param {object} row - Database row from scheduled_tasks
   */
  async _executeTask(row) {
    const { id, chat_id, cron_expression, task_prompt, description, timezone, error_count } = row;
    const taskStart = Date.now();

    try {
      // Respect the Claude rate limiter
      await this.rateLimiters.claude.acquire();

      // Show typing indicator
      await this.bot.sendTyping(chat_id);

      // Invoke Claude with a fresh session
      const systemPrompt = `You are executing a scheduled task. Task description: ${description}. Provide a helpful, concise response.`;
      const result = await this.claudeBridge.invoke(task_prompt, null, systemPrompt);

      // Deliver the response
      const responseText = result.text || 'Scheduled task completed (no output).';
      const header = `[Scheduled: ${description}]\n\n`;
      await this.bot.sendMessage(chat_id, header + responseText, {
        parse_mode: undefined,
      });

      // Compute the next run time
      const nextRun = nextCronDate(cron_expression, new Date(), timezone);

      await this.db.query(
        `UPDATE scheduled_tasks
         SET last_run_at = NOW(),
             next_run_at = $1,
             error_count = 0,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [nextRun ? nextRun.toISOString() : null, id],
      );

      this.logger.info('scheduler', `Task ${id} ("${description}") executed. Next run: ${nextRun?.toISOString() || 'none'}`);

      // Track successful scheduled task execution
      if (this.actionTracker) {
        await this.actionTracker.scheduledTaskRun({
          taskId: id,
          description,
          duration: Date.now() - taskStart,
        });
      }
    } catch (err) {
      // Record the error and possibly auto-disable
      const newErrorCount = error_count + 1;
      const shouldDisable = newErrorCount >= MAX_CONSECUTIVE_ERRORS;

      // Still compute next_run_at so a re-enabled task doesn't fire immediately
      let nextRun = null;
      try {
        nextRun = nextCronDate(cron_expression, new Date(), timezone);
      } catch { /* ignore parse errors during error handling */ }

      await this.db.query(
        `UPDATE scheduled_tasks
         SET error_count = $1,
             last_error = $2,
             enabled = $3,
             next_run_at = $4,
             updated_at = NOW()
         WHERE id = $5`,
        [newErrorCount, err.message, !shouldDisable, nextRun ? nextRun.toISOString() : null, id],
      );

      if (shouldDisable) {
        this.logger.warn('scheduler', `Task ${id} auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.`);

        // Notify the user
        try {
          await this.bot.sendMessage(
            chat_id,
            `Your scheduled task "${description}" has been disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive failures.\n\nLast error: ${err.message}\n\nUse /schedule to re-enable it.`,
            { parse_mode: undefined },
          );
        } catch { /* best-effort notification */ }
      }

      // Track failed scheduled task execution
      if (this.actionTracker) {
        await this.actionTracker.scheduledTaskRun({
          taskId: id,
          description,
          duration: Date.now() - taskStart,
          status: 'error',
          error: err.message,
        });
      }

      throw err;
    }
  }
}

export { SchedulerWorker, nextCronDate };
export default SchedulerWorker;
