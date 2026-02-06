import { execSync } from 'node:child_process';
import { escapeMarkdownV2 } from './bot.js';

/** How long a confirmation remains valid (ms). */
const CONFIRMATION_TTL_MS = 60_000;

/**
 * Commands that are forwarded to Claude instead of handled by the router.
 * The corresponding Claude skill activates on the `/command` prefix.
 * @type {Set<string>}
 */
const PASSTHROUGH_COMMANDS = new Set(['/project', '/journal', '/knowledge', '/schedule']);

/**
 * Descriptions shown by the /help command.
 * @type {Record<string, string>}
 */
const COMMAND_DESCRIPTIONS = {
  '/status': 'System status -- uptime, memory, message count, last activity',
  '/health': 'Health check -- component status (db, telegram, claude)',
  '/stop': 'Graceful shutdown of the service',
  '/restart': 'Restart the service process',
  '/reboot': 'Reboot the host operating system',
  '/new': 'Start a new conversation session',
  '/project': 'Manage projects, specs, and issues (handled by Claude)',
  '/journal': 'Record and search journal entries (handled by Claude)',
  '/knowledge': 'Manage knowledge graph (handled by Claude)',
  '/schedule': 'Create, list, or manage scheduled tasks (handled by Claude)',
  '/help': 'List available commands',
};

/**
 * Routes slash commands to their respective handlers and manages
 * the confirmation flow for dangerous operations.
 */
class CommandRouter {
  /**
   * @param {object} deps
   * @param {import('./bot.js').TelegramBot} deps.bot - Telegram bot instance
   * @param {import('../logging.js').Logger} deps.logger - Logger instance
   * @param {object} deps.conversationManager - Conversation manager with resetSession()
   * @param {object} deps.processInfo - Runtime info provider
   * @param {number} deps.processInfo.startTime - Timestamp (ms) when the service started
   * @param {() => Promise<number>} deps.processInfo.getMessageCount - Async fn returning total message count
   * @param {() => Promise<object>} deps.processInfo.getHealthStatus - Async fn returning component health
   */
  constructor({ bot, logger, conversationManager, processInfo, actionTracker = null }) {
    /** @type {import('./bot.js').TelegramBot} */
    this._bot = bot;

    /** @type {import('../logging.js').Logger} */
    this._logger = logger;

    /** @type {object} */
    this._conversationManager = conversationManager;

    /** @type {object} */
    this._processInfo = processInfo;

    /** @type {import('../actions/tracker.js').ActionTracker|null} */
    this._actionTracker = actionTracker;

    /**
     * Pending confirmations keyed by chatId.
     * @type {Map<string, { command: string, timestamp: number }>}
     */
    this._pendingConfirmations = new Map();
  }

  /**
   * Check whether the given text is a slash command.
   *
   * @param {string} text
   * @returns {boolean}
   */
  isCommand(text) {
    return typeof text === 'string' && text.startsWith('/');
  }

  /**
   * Route an inbound message to the appropriate command handler.
   * If the message is a "YES" reply to a pending confirmation, that
   * confirmation is executed instead.
   *
   * @param {object} message
   * @param {string} message.chatId
   * @param {string} message.userId
   * @param {string} message.text
   * @param {number} message.messageId
   * @returns {Promise<boolean>} true if the message was handled as a command or confirmation
   */
  async route(message) {
    const { chatId, text, messageId } = message;
    const trimmed = (text || '').trim();

    // Check for pending confirmation reply
    if (this._checkConfirmation(chatId, trimmed)) {
      return true;
    }

    if (!this.isCommand(trimmed)) {
      return false;
    }

    // Extract the command name (everything up to the first space or @)
    const command = trimmed.split(/[\s@]/)[0].toLowerCase();

    // Skill-managed commands pass through to Claude
    if (PASSTHROUGH_COMMANDS.has(command)) {
      return false;
    }

    const replyOpts = { reply_to_message_id: messageId, parse_mode: undefined };

    try {
      switch (command) {
        case '/status':
          await this._handleStatus(chatId, replyOpts);
          break;
        case '/health':
          await this._handleHealth(chatId, replyOpts);
          break;
        case '/stop':
          await this._handleStop(chatId, replyOpts);
          break;
        case '/restart':
          await this._handleRestart(chatId, replyOpts);
          break;
        case '/reboot':
          await this._handleReboot(chatId, replyOpts);
          break;
        case '/new':
          await this._handleNew(chatId, replyOpts);
          break;
        case '/help':
          await this._handleHelp(chatId, replyOpts);
          break;
        default:
          await this._bot.sendMessage(
            chatId,
            escapeMarkdownV2(`Unknown command: ${command}\nType /help for available commands.`),
            replyOpts,
          );
          break;
      }
      // Track command execution
      if (this._actionTracker) {
        await this._actionTracker.commandExecuted({ command, chatId });
      }
    } catch (err) {
      this._logger.error('commands', `Error handling ${command}: ${err.message}`);
      await this._sendPlain(chatId, `Error executing ${command}: ${err.message}`, replyOpts);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Confirmation flow
  // ---------------------------------------------------------------------------

  /**
   * Request confirmation from the user for a dangerous operation.
   *
   * @param {string} chatId
   * @param {string} command - The command that requires confirmation
   * @param {string} prompt - Message to send asking for confirmation
   * @param {object} replyOpts
   * @private
   */
  async _requestConfirmation(chatId, command, prompt, replyOpts) {
    this._pendingConfirmations.set(chatId, {
      command,
      timestamp: Date.now(),
    });

    await this._sendPlain(chatId, prompt, replyOpts);
  }

  /**
   * Check whether an incoming message is a "YES" confirmation for a
   * pending dangerous command. Expired confirmations are cleaned up.
   *
   * @param {string} chatId
   * @param {string} text
   * @returns {boolean} true if a confirmation was matched and executed
   * @private
   */
  _checkConfirmation(chatId, text) {
    const pending = this._pendingConfirmations.get(chatId);
    if (!pending) return false;

    // Clean up expired confirmations
    if (Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
      this._pendingConfirmations.delete(chatId);
      return false;
    }

    if (text.toUpperCase() !== 'YES') {
      return false;
    }

    this._pendingConfirmations.delete(chatId);
    const { command } = pending;

    // Execute the confirmed command asynchronously
    this._executeConfirmed(chatId, command);
    return true;
  }

  /**
   * Execute a command that has been confirmed by the user.
   *
   * @param {string} chatId
   * @param {string} command
   * @private
   */
  async _executeConfirmed(chatId, command) {
    try {
      switch (command) {
        case '/stop':
          await this._sendPlain(chatId, 'Shutting down...');
          this._logger.info('commands', 'Graceful shutdown initiated via /stop');
          // Allow message to send before exiting
          setTimeout(() => process.exit(0), 500);
          break;

        case '/restart':
          await this._sendPlain(chatId, 'Restarting...');
          this._logger.info('commands', 'Process restart initiated via /restart');
          // Exit with a restart-indicating code; process manager (systemd) should restart
          setTimeout(() => process.exit(0), 500);
          break;

        case '/reboot':
          await this._sendPlain(chatId, 'Rebooting host system...');
          this._logger.info('commands', 'OS reboot initiated via /reboot');
          setTimeout(() => {
            try {
              execSync('sudo reboot', { timeout: 10_000 });
            } catch (err) {
              this._logger.error('commands', `Reboot failed: ${err.message}`);
              this._sendPlain(chatId, `Reboot failed: ${err.message}`).catch(() => {});
            }
          }, 500);
          break;

        default:
          this._logger.warn('commands', `Unknown confirmed command: ${command}`);
          break;
      }
    } catch (err) {
      this._logger.error('commands', `Failed to execute confirmed ${command}: ${err.message}`);
      await this._sendPlain(chatId, `Failed to execute ${command}: ${err.message}`).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  /**
   * /status -- System status summary.
   * @private
   */
  async _handleStatus(chatId, replyOpts) {
    const uptimeMs = Date.now() - this._processInfo.startTime;
    const uptime = this._formatUptime(uptimeMs);
    const mem = process.memoryUsage();

    let messageCount = 'N/A';
    try {
      messageCount = String(await this._processInfo.getMessageCount());
    } catch {
      // Fall through with N/A
    }

    const lines = [
      'System Status',
      '',
      `Uptime: ${uptime}`,
      `Memory (RSS): ${this._formatBytes(mem.rss)}`,
      `Memory (Heap Used): ${this._formatBytes(mem.heapUsed)} / ${this._formatBytes(mem.heapTotal)}`,
      `Messages: ${messageCount}`,
      `Last Activity: ${new Date().toISOString()}`,
      `Node.js: ${process.version}`,
      `PID: ${process.pid}`,
    ];

    await this._sendPlain(chatId, lines.join('\n'), replyOpts);
  }

  /**
   * /health -- Component health check.
   * @private
   */
  async _handleHealth(chatId, replyOpts) {
    let health;
    try {
      health = await this._processInfo.getHealthStatus();
    } catch (err) {
      await this._sendPlain(
        chatId,
        `Health check failed: ${err.message}`,
        replyOpts,
      );
      return;
    }

    const { status, components } = health;
    const statusEmoji = status === 'ok' ? 'OK' : status === 'degraded' ? 'DEGRADED' : 'ERROR';

    const lines = [`Health: ${statusEmoji}`, ''];

    if (components) {
      for (const [name, detail] of Object.entries(components)) {
        const componentStatus = detail.ok ? 'ok' : 'error';
        const info = detail.message ? ` -- ${detail.message}` : '';
        lines.push(`  ${name}: ${componentStatus}${info}`);
      }
    }

    await this._sendPlain(chatId, lines.join('\n'), replyOpts);
  }

  /**
   * /stop -- Graceful shutdown with confirmation.
   * @private
   */
  async _handleStop(chatId, replyOpts) {
    await this._requestConfirmation(
      chatId,
      '/stop',
      'Are you sure you want to stop the service? Reply YES to confirm.',
      replyOpts,
    );
  }

  /**
   * /restart -- Process restart with confirmation.
   * @private
   */
  async _handleRestart(chatId, replyOpts) {
    await this._requestConfirmation(
      chatId,
      '/restart',
      'Are you sure you want to restart the service? Reply YES to confirm.',
      replyOpts,
    );
  }

  /**
   * /reboot -- OS reboot with confirmation.
   * @private
   */
  async _handleReboot(chatId, replyOpts) {
    await this._requestConfirmation(
      chatId,
      '/reboot',
      'Are you sure you want to reboot the host system? Reply YES to confirm.',
      replyOpts,
    );
  }

  /**
   * /new -- Start a new conversation session.
   * @private
   */
  async _handleNew(chatId, replyOpts) {
    try {
      if (this._conversationManager && typeof this._conversationManager.newSession === 'function') {
        this._conversationManager.newSession();
      }

      this._logger.info('commands', 'New conversation session started via /new');
      await this._sendPlain(
        chatId,
        'New conversation session started. Previous session is preserved in logs.',
        replyOpts,
      );
    } catch (err) {
      this._logger.error('commands', `Failed to start new session: ${err.message}`);
      await this._sendPlain(
        chatId,
        `Failed to start new session: ${err.message}`,
        replyOpts,
      );
    }
  }

  /**
   * /help -- List all available commands.
   * @private
   */
  async _handleHelp(chatId, replyOpts) {
    const lines = ['Available Commands', ''];

    for (const [cmd, desc] of Object.entries(COMMAND_DESCRIPTIONS)) {
      lines.push(`${cmd} -- ${desc}`);
    }

    await this._sendPlain(chatId, lines.join('\n'), replyOpts);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Send a plain-text message (no MarkdownV2 parsing).
   *
   * @param {string} chatId
   * @param {string} text
   * @param {object} [replyOpts]
   * @returns {Promise<object[]>}
   * @private
   */
  async _sendPlain(chatId, text, replyOpts = {}) {
    return this._bot.sendMessage(chatId, text, {
      ...replyOpts,
      parse_mode: undefined,
    });
  }

  /**
   * Format a duration in milliseconds to a human-readable string.
   *
   * @param {number} ms
   * @returns {string} e.g. "2d 5h 23m 12s"
   * @private
   */
  _formatUptime(ms) {
    const seconds = Math.floor(ms / 1_000) % 60;
    const minutes = Math.floor(ms / 60_000) % 60;
    const hours = Math.floor(ms / 3_600_000) % 24;
    const days = Math.floor(ms / 86_400_000);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }

  /**
   * Format a byte count to a human-readable string.
   *
   * @param {number} bytes
   * @returns {string} e.g. "12.34 MB"
   * @private
   */
  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }
}

export { CommandRouter, COMMAND_DESCRIPTIONS, PASSTHROUGH_COMMANDS };
export default CommandRouter;
