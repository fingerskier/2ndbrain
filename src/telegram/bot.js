import { EventEmitter } from 'node:events';
import https from 'node:https';
import hooks from '../hooks/lifecycle.js';
import logger from '../logging.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4_000;

/**
 * Escape special characters for Telegram MarkdownV2 format.
 *
 * Characters that must be escaped:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdownV2(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Telegram Bot adapter using the Bot API via native HTTPS.
 *
 * Connects to Telegram via long-polling (getUpdates). Handles inbound
 * messages, access control, attachment extraction, and outbound message
 * sending with MarkdownV2 formatting and chunking.
 *
 * @extends EventEmitter
 */
class TelegramBot extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.token - Telegram Bot API token
   * @param {string[]} config.allowedUsers - Array of allowed Telegram user ID strings
   */
  constructor(config) {
    super();

    if (!config.token) {
      throw new Error('Telegram bot token is required');
    }

    /** @type {string} */
    this._token = config.token;

    /** @type {Set<string>} Allowed user IDs stored as strings for consistent comparison */
    this._allowedUsers = new Set(
      (config.allowedUsers || []).map((id) => String(id)),
    );

    /** @type {number} Offset for getUpdates long-polling */
    this._offset = 0;

    /** @type {boolean} Whether polling is active */
    this._polling = false;

    /** @type {AbortController|null} Controller to cancel in-flight polling request */
    this._abortController = null;

    /** @type {Map<string, ReturnType<typeof setInterval>>} Active typing intervals by chatId */
    this._typingIntervals = new Map();
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Start long-polling for updates from the Telegram API.
   */
  startPolling() {
    if (this._polling) {
      return;
    }

    this._polling = true;
    logger.info('telegram', 'Long-polling started');
    this._poll();
  }

  /**
   * Stop long-polling.
   */
  stopPolling() {
    this._polling = false;

    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // Clear all typing intervals
    for (const [, interval] of this._typingIntervals) {
      clearInterval(interval);
    }
    this._typingIntervals.clear();

    logger.info('telegram', 'Long-polling stopped');
  }

  /**
   * Internal polling loop. Calls getUpdates with a long-poll timeout,
   * processes each update, then recurses.
   * @private
   */
  async _poll() {
    while (this._polling) {
      try {
        const updates = await this._apiCall('getUpdates', {
          offset: this._offset,
          timeout: 30,
          allowed_updates: ['message'],
        });

        if (!this._polling) break;

        if (Array.isArray(updates)) {
          for (const update of updates) {
            this._offset = update.update_id + 1;
            await this._handleUpdate(update);
          }
        }
      } catch (err) {
        if (!this._polling) break;

        logger.error('telegram', `Polling error: ${err.message}`);
        this.emit('error', err);

        // Back off before retrying
        await this._sleep(5_000);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling
  // ---------------------------------------------------------------------------

  /**
   * Process a single Telegram update object.
   * @param {object} update
   * @private
   */
  async _handleUpdate(update) {
    const message = update.message;
    if (!message) return;

    const userId = String(message.from?.id ?? '');
    const chatId = String(message.chat?.id ?? '');
    const messageId = message.message_id;

    // Access control: silently drop messages from non-whitelisted users
    if (!this._allowedUsers.has(userId)) {
      logger.warn(
        'telegram',
        `Dropped message from unauthorized user ${userId} in chat ${chatId}`,
      );
      return;
    }

    // Extract text content
    const text = message.text || message.caption || '';

    // Extract attachments
    const attachments = this._extractAttachments(message);

    const parsed = { chatId, userId, text, attachments, messageId };

    // Run on_message_received lifecycle hook
    const hookResult = await hooks.emit('on_message_received', {
      message: parsed,
      telegram_user_id: userId,
      timestamp: Date.now(),
    });

    if (hookResult.aborted) {
      logger.info(
        'telegram',
        `Message processing aborted by hook: ${hookResult.reason}`,
      );
      return;
    }

    this.emit('message', parsed);
  }

  /**
   * Extract attachment metadata from a Telegram message.
   *
   * @param {object} message - Raw Telegram message object
   * @returns {Array<{type: string, fileId: string, mimeType: string}>}
   * @private
   */
  _extractAttachments(message) {
    const attachments = [];

    // Photo: array of PhotoSize, take the largest (last)
    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({
        type: 'photo',
        fileId: largest.file_id,
        mimeType: 'image/jpeg',
      });
    }

    // Document
    if (message.document) {
      attachments.push({
        type: 'document',
        fileId: message.document.file_id,
        mimeType: message.document.mime_type || 'application/octet-stream',
      });
    }

    // Audio
    if (message.audio) {
      attachments.push({
        type: 'audio',
        fileId: message.audio.file_id,
        mimeType: message.audio.mime_type || 'audio/mpeg',
      });
    }

    // Video
    if (message.video) {
      attachments.push({
        type: 'video',
        fileId: message.video.file_id,
        mimeType: message.video.mime_type || 'video/mp4',
      });
    }

    // Voice
    if (message.voice) {
      attachments.push({
        type: 'voice',
        fileId: message.voice.file_id,
        mimeType: message.voice.mime_type || 'audio/ogg',
      });
    }

    return attachments;
  }

  // ---------------------------------------------------------------------------
  // Outbound messaging
  // ---------------------------------------------------------------------------

  /**
   * Send a text message to a chat. Automatically chunks messages that
   * exceed Telegram's 4096-character limit. Uses MarkdownV2 parse mode.
   *
   * @param {string} chatId
   * @param {string} text
   * @param {object} [options]
   * @param {number} [options.reply_to_message_id] - Message ID to reply to
   * @param {string} [options.parse_mode] - Override parse mode (default MarkdownV2)
   * @returns {Promise<object[]>} Array of sent message results
   */
  async sendMessage(chatId, text, options = {}) {
    const parseMode = options.parse_mode ?? 'MarkdownV2';
    const chunks = this._chunkText(text, MAX_MESSAGE_LENGTH);
    const results = [];

    for (let i = 0; i < chunks.length; i++) {
      const body = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: parseMode,
      };

      // Only attach reply_to on the first chunk
      if (i === 0 && options.reply_to_message_id) {
        body.reply_to_message_id = options.reply_to_message_id;
      }

      try {
        const result = await this._apiCall('sendMessage', body);
        results.push(result);
      } catch (err) {
        logger.error(
          'telegram',
          `Failed to send message chunk ${i + 1}/${chunks.length} to ${chatId}: ${err.message}`,
        );
        this.emit('error', err);

        // If MarkdownV2 fails, retry the chunk as plain text
        if (parseMode === 'MarkdownV2') {
          try {
            const fallback = await this._apiCall('sendMessage', {
              chat_id: chatId,
              text: chunks[i],
            });
            results.push(fallback);
          } catch (fallbackErr) {
            logger.error(
              'telegram',
              `Fallback plain-text send also failed: ${fallbackErr.message}`,
            );
            this.emit('error', fallbackErr);
          }
        }
      }
    }

    return results;
  }

  /**
   * Send a "typing" chat action indicator. Optionally starts a repeating
   * interval that refreshes every 4 seconds (Telegram typing indicator
   * expires after ~5s).
   *
   * @param {string} chatId
   * @param {boolean} [repeat=false] - If true, repeat every 4s until stopTyping() is called
   * @returns {Promise<void>}
   */
  async sendTyping(chatId, repeat = false) {
    try {
      await this._apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch (err) {
      logger.debug('telegram', `Failed to send typing indicator: ${err.message}`);
    }

    if (repeat && !this._typingIntervals.has(chatId)) {
      const interval = setInterval(async () => {
        try {
          await this._apiCall('sendChatAction', {
            chat_id: chatId,
            action: 'typing',
          });
        } catch {
          // Silently ignore typing refresh failures
        }
      }, TYPING_INTERVAL_MS);

      this._typingIntervals.set(chatId, interval);
    }
  }

  /**
   * Stop the repeating typing indicator for a chat.
   *
   * @param {string} chatId
   */
  stopTyping(chatId) {
    const interval = this._typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this._typingIntervals.delete(chatId);
    }
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------

  /**
   * Get the download URL for a file by its file_id.
   *
   * @param {string} fileId
   * @returns {Promise<string>} Full download URL
   */
  async _getFileUrl(fileId) {
    const file = await this._apiCall('getFile', { file_id: fileId });
    return `${TELEGRAM_API_BASE}/file/bot${this._token}/${file.file_path}`;
  }

  /**
   * Download a file from Telegram servers by file_id.
   *
   * @param {string} fileId
   * @returns {Promise<Buffer>} File contents as a Buffer
   */
  async downloadFile(fileId) {
    const url = await this._getFileUrl(fileId);
    return this._httpsGet(url);
  }

  // ---------------------------------------------------------------------------
  // HTTPS helpers
  // ---------------------------------------------------------------------------

  /**
   * Make a POST request to the Telegram Bot API.
   *
   * @param {string} method - API method name (e.g. 'sendMessage')
   * @param {object} body - JSON request body
   * @returns {Promise<object>} The `result` field from the API response
   * @private
   */
  _apiCall(method, body = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(`/bot${this._token}/${method}`, TELEGRAM_API_BASE);

      const options = {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const data = JSON.parse(raw);

            if (data.ok) {
              resolve(data.result);
            } else {
              const err = new Error(
                `Telegram API error: ${data.description || 'Unknown error'} (${data.error_code || 'N/A'})`,
              );
              err.code = data.error_code;
              reject(err);
            }
          } catch (parseErr) {
            reject(new Error(`Failed to parse Telegram API response: ${parseErr.message}`));
          }
        });
      });

      req.on('error', reject);

      // Support aborting in-flight requests (used during polling shutdown)
      if (this._abortController) {
        const signal = this._abortController.signal;
        if (signal.aborted) {
          req.destroy();
          reject(new Error('Request aborted'));
          return;
        }
        signal.addEventListener('abort', () => req.destroy(), { once: true });
      }

      req.write(payload);
      req.end();
    });
  }

  /**
   * Perform an HTTPS GET request and return the response body as a Buffer.
   *
   * @param {string} url
   * @returns {Promise<Buffer>}
   * @private
   */
  _httpsGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        // Follow redirects (Telegram may redirect file downloads)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._httpsGet(res.headers.location).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} when downloading file`));
          res.resume(); // Drain response
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Split text into chunks that fit within Telegram's message size limit.
   * Tries to split on newline boundaries for cleaner output.
   *
   * @param {string} text
   * @param {number} maxLen
   * @returns {string[]}
   * @private
   */
  _chunkText(text, maxLen) {
    if (text.length <= maxLen) {
      return [text];
    }

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to find a newline to split on within the limit
      let splitAt = remaining.lastIndexOf('\n', maxLen);

      // Fall back to splitting at a space
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(' ', maxLen);
      }

      // Last resort: hard split
      if (splitAt <= 0) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
    }

    return chunks;
  }

  /**
   * Utility sleep for back-off delays.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { TelegramBot, escapeMarkdownV2 };
export default TelegramBot;
