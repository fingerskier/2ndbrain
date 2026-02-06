/**
 * ActionTracker -- records structured bot actions to the bot_actions table
 * for troubleshooting and insight.
 *
 * Actions are fire-and-forget: write failures are logged but never propagate
 * to the caller, so tracking never breaks normal operation.
 */
class ActionTracker {
  /**
   * @param {object} deps
   * @param {object} deps.db - Database interface with query(text, params)
   * @param {object} deps.logger - Logger instance
   */
  constructor({ db, logger }) {
    this._db = db;
    this._logger = logger;
  }

  /**
   * Record a bot action.
   *
   * @param {string} action - Action type (e.g. 'message_received', 'claude_invoked')
   * @param {object} [opts={}]
   * @param {string} [opts.status='ok'] - 'ok' or 'error'
   * @param {string} [opts.source] - Component name (telegram, claude, commands, scheduler)
   * @param {number} [opts.duration] - Duration in milliseconds
   * @param {object} [opts.detail] - Additional metadata (JSONB)
   */
  async track(action, { status = 'ok', source, duration, detail } = {}) {
    try {
      await this._db.query(
        `INSERT INTO bot_actions (action, status, source, duration_ms, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          action,
          status,
          source || null,
          duration != null ? Math.round(duration) : null,
          detail ? JSON.stringify(detail) : null,
        ],
      );
    } catch (err) {
      // Never let tracking failures disrupt normal operation
      this._logger.debug('actions', `Failed to record action "${action}": ${err.message}`);
    }
  }

  /**
   * Convenience: track a message received from Telegram.
   */
  async messageReceived({ chatId, userId, messageId, hasAttachments, textLength }) {
    return this.track('message_received', {
      source: 'telegram',
      detail: { chat_id: chatId, user_id: userId, message_id: messageId, has_attachments: hasAttachments, text_length: textLength },
    });
  }

  /**
   * Convenience: track a Claude invocation.
   */
  async claudeInvoked({ sessionId, cost, duration, toolCallCount, responseLength, mcpFallback }) {
    return this.track('claude_invoked', {
      source: 'claude',
      duration,
      detail: { session_id: sessionId, cost_usd: cost, tool_call_count: toolCallCount, response_length: responseLength, mcp_fallback: mcpFallback || false },
    });
  }

  /**
   * Convenience: track a Claude invocation error.
   */
  async claudeError({ error, duration, isTimeout }) {
    return this.track('claude_invoked', {
      status: 'error',
      source: 'claude',
      duration,
      detail: { error: error, is_timeout: isTimeout || false },
    });
  }

  /**
   * Convenience: track a message sent to Telegram.
   */
  async messageSent({ chatId, chunks, responseLength }) {
    return this.track('message_sent', {
      source: 'telegram',
      detail: { chat_id: chatId, chunks: chunks || 1, response_length: responseLength },
    });
  }

  /**
   * Convenience: track a slash command execution.
   */
  async commandExecuted({ command, chatId }) {
    return this.track('command_executed', {
      source: 'commands',
      detail: { command, chat_id: chatId },
    });
  }

  /**
   * Convenience: track a scheduled task execution.
   */
  async scheduledTaskRun({ taskId, description, duration, status = 'ok', error }) {
    return this.track('scheduled_task_run', {
      status,
      source: 'scheduler',
      duration,
      detail: { task_id: taskId, description, error: error || undefined },
    });
  }

  /**
   * Convenience: track an attachment save.
   */
  async attachmentSaved({ messageId, mimeType, fileSize }) {
    return this.track('attachment_saved', {
      source: 'attachments',
      detail: { message_id: messageId, mime_type: mimeType, file_size: fileSize },
    });
  }
}

export { ActionTracker };
export default ActionTracker;
