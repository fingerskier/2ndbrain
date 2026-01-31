import { EventEmitter } from 'node:events';

/**
 * Valid lifecycle event names per spec section 13.1.
 * @type {ReadonlyArray<string>}
 */
const LIFECYCLE_EVENTS = Object.freeze([
  'on_message_received',
  'on_pre_claude',
  'on_post_claude',
  'on_pre_send',
  'on_error',
  'on_startup',
  'on_shutdown',
]);

/**
 * Telegram MarkdownV2 special characters that must be escaped.
 *
 * Characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
const MARKDOWN_V2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Maximum length for a single Telegram message.
 */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Soft limit for response text before truncation notice is appended.
 */
const RESPONSE_SOFT_LIMIT = 3500;

/**
 * Application lifecycle hooks system per spec section 13.1.
 *
 * Each event can have multiple async handlers registered. When emitted,
 * handlers execute in registration order. A handler receives the context
 * object and may modify it. If any handler throws or returns
 * `{ abort: true, reason }`, the pipeline aborts immediately and
 * `emit()` returns `{ aborted: true, reason }`.
 *
 * @extends EventEmitter
 */
class LifecycleHooks extends EventEmitter {
  constructor() {
    super();

    /**
     * Map of event name -> ordered array of async handler functions.
     * We maintain our own registry instead of relying solely on
     * EventEmitter listeners so we can run handlers sequentially
     * and support abort semantics.
     * @type {Map<string, Array<(ctx: object) => Promise<object|void>>>}
     */
    this._handlers = new Map();

    for (const event of LIFECYCLE_EVENTS) {
      this._handlers.set(event, []);
    }
  }

  /**
   * Register an async handler for a lifecycle event.
   *
   * @param {string} event - One of the LIFECYCLE_EVENTS names
   * @param {(ctx: object) => Promise<object|void>} handler - Async function
   *   that receives and optionally modifies the context object
   * @returns {LifecycleHooks} this (for chaining)
   * @throws {Error} If the event name is not a valid lifecycle event
   */
  on(event, handler) {
    if (!this._handlers.has(event)) {
      throw new Error(
        `Unknown lifecycle event "${event}". Valid events: ${LIFECYCLE_EVENTS.join(', ')}`,
      );
    }

    if (typeof handler !== 'function') {
      throw new TypeError('Handler must be a function');
    }

    this._handlers.get(event).push(handler);
    return this;
  }

  /**
   * Trigger a lifecycle event, running all registered handlers in order.
   *
   * Each handler receives the current context object. If a handler returns
   * a plain object (other than an abort signal), the context is replaced
   * with the returned value. If a handler returns `{ abort: true, reason }`
   * or throws an error, the pipeline stops immediately.
   *
   * @param {string} event - The lifecycle event to trigger
   * @param {object} context - Mutable context passed through the pipeline
   * @returns {Promise<{ aborted: false, context: object } | { aborted: true, reason: string }>}
   */
  async emit(event, context = {}) {
    const handlers = this._handlers.get(event);

    if (!handlers) {
      throw new Error(
        `Unknown lifecycle event "${event}". Valid events: ${LIFECYCLE_EVENTS.join(', ')}`,
      );
    }

    let ctx = context;

    for (const handler of handlers) {
      try {
        const result = await handler(ctx);

        // Check for explicit abort signal
        if (result && typeof result === 'object' && result.abort === true) {
          const reason = result.reason || 'Aborted by hook handler';
          super.emit('hook:aborted', { event, reason });
          return { aborted: true, reason };
        }

        // Allow handler to replace context by returning a new object
        if (result && typeof result === 'object') {
          ctx = result;
        }
      } catch (err) {
        const reason = err.message || 'Hook handler threw an error';
        super.emit('hook:error', { event, error: err });
        return { aborted: true, reason };
      }
    }

    return { aborted: false, context: ctx };
  }

  /**
   * Remove all handlers for a specific event, or all events if no
   * event name is provided.
   *
   * @param {string} [event] - Optional event name to clear
   */
  clear(event) {
    if (event) {
      if (!this._handlers.has(event)) {
        throw new Error(
          `Unknown lifecycle event "${event}". Valid events: ${LIFECYCLE_EVENTS.join(', ')}`,
        );
      }
      this._handlers.set(event, []);
    } else {
      for (const key of this._handlers.keys()) {
        this._handlers.set(key, []);
      }
    }
  }

  /**
   * Returns the number of handlers registered for a given event.
   *
   * @param {string} event
   * @returns {number}
   */
  handlerCount(event) {
    const handlers = this._handlers.get(event);
    return handlers ? handlers.length : 0;
  }

  /**
   * Register the default lifecycle handlers per spec section 13.1.
   *
   * @param {object} deps - Application dependencies
   * @param {object} deps.logger         - Structured logger instance
   * @param {object} deps.db             - Database query interface ({ query(sql, params) })
   * @param {object} deps.config         - Application configuration object
   * @param {object} deps.rateLimiters   - { telegram: RateLimiter, claude: RateLimiter }
   * @param {object} deps.telegram       - TelegramBot instance
   * @param {object} deps.embeddingsEngine - EmbeddingsEngine instance
   */
  registerDefaults({ logger, db, config, rateLimiters, telegram, embeddingsEngine }) {
    // -------------------------------------------------------------------------
    // on_message_received
    //   1. Log inbound message to system_logs
    //   2. Rate-limit via telegram limiter
    //   3. Validate sender against telegram whitelist
    // -------------------------------------------------------------------------
    this.on('on_message_received', async (ctx) => {
      const userId = ctx.telegram_user_id || ctx.message?.userId || 'unknown';
      const text = ctx.message?.text || '';
      const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;

      logger.info('hooks', `Message received from user ${userId}: ${preview}`);

      // Rate limit check
      try {
        await rateLimiters.telegram.acquire();
      } catch (err) {
        logger.warn('hooks', `Telegram rate limit exceeded for user ${userId}: ${err.message}`);
        return { abort: true, reason: 'Rate limit exceeded. Please wait a moment.' };
      }

      // Telegram whitelist validation
      const allowedUsers = config.TELEGRAM_ALLOWED_USERS
        ? config.TELEGRAM_ALLOWED_USERS.split(',').map((id) => id.trim())
        : [];

      if (allowedUsers.length > 0 && !allowedUsers.includes(String(userId))) {
        logger.warn('hooks', `Unauthorized message from user ${userId}`);
        return { abort: true, reason: `User ${userId} is not in the allowed users list` };
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_pre_claude
    //   1. Inject system prompt with current date/time
    //   2. Assemble conversation context
    // -------------------------------------------------------------------------
    this.on('on_pre_claude', async (ctx) => {
      const now = new Date();
      const dateStr = now.toISOString();
      const localDate = now.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const localTime = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      const dateContext = `Current date and time: ${localDate}, ${localTime} (${dateStr})`;

      // Inject date/time into the system prompt
      if (ctx.systemPrompt) {
        ctx.systemPrompt = `${dateContext}\n\n${ctx.systemPrompt}`;
      } else {
        ctx.systemPrompt = dateContext;
      }

      // Assemble conversation context from recent history if db is available
      if (db && ctx.includeHistory !== false) {
        try {
          const history = await db.query(
            `SELECT role, content FROM conversation_messages
             ORDER BY created_at DESC LIMIT 20`,
          );

          if (history.rows.length > 0) {
            ctx.conversationContext = history.rows.reverse().map((row) => ({
              role: row.role,
              content: row.content,
            }));
          }
        } catch (err) {
          logger.warn('hooks', `Failed to load conversation history: ${err.message}`);
        }
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_post_claude
    //   1. Log duration and cost to system_logs
    //   2. Queue response for embedding if embeddings are enabled
    // -------------------------------------------------------------------------
    this.on('on_post_claude', async (ctx) => {
      const duration = ctx.duration ?? 0;
      const cost = ctx.cost ?? 0;
      const sessionId = ctx.sessionId || 'unknown';

      logger.info(
        'hooks',
        `Claude response: session=${sessionId} duration=${duration}ms cost=$${cost.toFixed(4)}`,
      );

      // Persist cost/duration to system_logs for analytics
      try {
        await db.query(
          `INSERT INTO system_logs (level, source, content)
           VALUES ('info', 'claude', $1)`,
          [`duration=${duration}ms cost=$${cost.toFixed(4)} session=${sessionId}`],
        );
      } catch (err) {
        logger.warn('hooks', `Failed to log Claude metrics: ${err.message}`);
      }

      // Queue for embedding if enabled
      if (embeddingsEngine && embeddingsEngine.isEnabled() && ctx.messageId) {
        try {
          await embeddingsEngine.queueEmbedding('message', ctx.messageId);
          logger.debug('hooks', `Queued embedding for message ${ctx.messageId}`);
        } catch (err) {
          logger.warn('hooks', `Failed to queue embedding: ${err.message}`);
        }
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_pre_send
    //   1. Truncate response > 3500 chars with notice
    //   2. Chunk messages > 4096 chars for Telegram delivery
    //   3. Escape MarkdownV2 special characters
    // -------------------------------------------------------------------------
    this.on('on_pre_send', async (ctx) => {
      let text = ctx.text || '';

      // Response length guard: truncate with notice
      if (text.length > RESPONSE_SOFT_LIMIT) {
        const truncated = text.slice(0, RESPONSE_SOFT_LIMIT);
        text = truncated + '\n\n[Response truncated - original was ' + text.length + ' characters]';
        logger.debug('hooks', `Response truncated from ${ctx.text.length} to ${text.length} chars`);
      }

      // Escape MarkdownV2 special characters
      text = text.replace(MARKDOWN_V2_SPECIAL, '\\$1');

      // Chunk for Telegram's 4096-char limit
      if (text.length > TELEGRAM_MAX_LENGTH) {
        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
          if (remaining.length <= TELEGRAM_MAX_LENGTH) {
            chunks.push(remaining);
            break;
          }

          // Try to split on newline within the limit
          let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
          if (splitAt <= 0) {
            splitAt = remaining.lastIndexOf(' ', TELEGRAM_MAX_LENGTH);
          }
          if (splitAt <= 0) {
            splitAt = TELEGRAM_MAX_LENGTH;
          }

          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).replace(/^\n/, '');
        }

        ctx.chunks = chunks;
        ctx.text = chunks[0];
      } else {
        ctx.text = text;
        ctx.chunks = [text];
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_error
    //   1. Log error to system_logs
    //   2. Notify owner via Telegram
    // -------------------------------------------------------------------------
    this.on('on_error', async (ctx) => {
      const error = ctx.error || {};
      const message = error.message || error.toString?.() || 'Unknown error';
      const source = ctx.source || 'unknown';

      logger.error('hooks', `Error in ${source}: ${message}`);

      // Persist to system_logs
      try {
        await db.query(
          `INSERT INTO system_logs (level, source, content)
           VALUES ('error', $1, $2)`,
          [source, message],
        );
      } catch (dbErr) {
        logger.error('hooks', `Failed to log error to database: ${dbErr.message}`);
      }

      // Notify owner via Telegram
      if (telegram && config.TELEGRAM_ALLOWED_USERS) {
        const ownerIds = config.TELEGRAM_ALLOWED_USERS.split(',').map((id) => id.trim());
        const ownerChatId = ownerIds[0];

        if (ownerChatId) {
          try {
            const escapedSource = source.replace(MARKDOWN_V2_SPECIAL, '\\$1');
            const escapedMessage = message.replace(MARKDOWN_V2_SPECIAL, '\\$1');
            const notification = `*Error in ${escapedSource}:*\n${escapedMessage}`;

            await telegram.sendMessage(ownerChatId, notification);
          } catch (tgErr) {
            logger.error('hooks', `Failed to notify owner via Telegram: ${tgErr.message}`);
          }
        }
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_startup
    //   Log application startup event
    // -------------------------------------------------------------------------
    this.on('on_startup', async (ctx) => {
      const version = ctx.version || 'unknown';
      logger.info('hooks', `Application started (version=${version})`);

      try {
        await db.query(
          `INSERT INTO system_logs (level, source, content)
           VALUES ('info', 'lifecycle', $1)`,
          [`Application started (version=${version})`],
        );
      } catch (err) {
        logger.warn('hooks', `Failed to log startup event: ${err.message}`);
      }

      return ctx;
    });

    // -------------------------------------------------------------------------
    // on_shutdown
    //   Log application shutdown event
    // -------------------------------------------------------------------------
    this.on('on_shutdown', async (ctx) => {
      const reason = ctx.reason || 'normal';
      logger.info('hooks', `Application shutting down (reason=${reason})`);

      try {
        await db.query(
          `INSERT INTO system_logs (level, source, content)
           VALUES ('info', 'lifecycle', $1)`,
          [`Application shutting down (reason=${reason})`],
        );
      } catch (err) {
        logger.warn('hooks', `Failed to log shutdown event: ${err.message}`);
      }

      return ctx;
    });
  }
}

/** Singleton instance shared across the application. */
const hooks = new LifecycleHooks();

export { LifecycleHooks, LIFECYCLE_EVENTS, hooks };
export default hooks;
