/**
 * Conversation manager (spec section 6).
 *
 * Persists all conversation turns to the conversation_messages table,
 * manages Claude CLI sessions, and controls history size through
 * auto-compaction.
 */
class ConversationManager {
  /**
   * @param {object} options
   * @param {object} options.db - Database pool or query interface (must expose .query())
   * @param {object} options.logger - Structured logger instance
   * @param {object} options.config - Application configuration object
   */
  constructor({ db, logger, config }) {
    this.db = db;
    this.logger = logger;
    this.config = config;

    /** @type {string|null} Active Claude CLI session ID */
    this.currentSessionId = null;
  }

  /**
   * Save a conversation message to the database.
   *
   * @param {string} role - Message role: 'user', 'assistant', 'system', or 'summary'
   * @param {string} content - Message text content
   * @param {object} [metadata=null] - Optional JSONB metadata (tool calls, attachments, cost, etc.)
   * @returns {Promise<object>} The inserted row
   */
  async saveMessage(role, content, metadata = null) {
    const result = await this.db.query(
      `INSERT INTO conversation_messages (session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [this.currentSessionId, role, content, metadata ? JSON.stringify(metadata) : null],
    );

    this.logger.debug(
      'conversation',
      `Saved ${role} message (session=${this.currentSessionId || 'none'}, length=${content.length})`,
    );

    return result.rows[0];
  }

  /**
   * Fetch recent conversation messages.
   *
   * @param {number} [limit] - Maximum number of messages to return.
   *   Defaults to HISTORY_COMPACT_THRESHOLD from config.
   * @returns {Promise<Array<object>>} Messages ordered oldest-first
   */
  async getHistory(limit) {
    const effectiveLimit = limit ?? this.config.HISTORY_COMPACT_THRESHOLD;

    const result = await this.db.query(
      `SELECT id, created_at, session_id, role, content, metadata
       FROM conversation_messages
       ORDER BY created_at DESC
       LIMIT $1`,
      [effectiveLimit],
    );

    // Return in chronological order (oldest first)
    return result.rows.reverse();
  }

  /**
   * Get the total number of conversation messages.
   *
   * @returns {Promise<number>}
   */
  async getMessageCount() {
    const result = await this.db.query('SELECT COUNT(*)::int AS count FROM conversation_messages');
    return result.rows[0].count;
  }

  /**
   * Get the timestamp of the most recent conversation message.
   *
   * @returns {Promise<string|null>} ISO timestamp string, or null if no messages exist
   */
  async getLastActivity() {
    const result = await this.db.query(
      'SELECT created_at FROM conversation_messages ORDER BY created_at DESC LIMIT 1',
    );
    return result.rows[0]?.created_at?.toISOString() ?? null;
  }

  /**
   * Start a new conversation session.
   *
   * Sets currentSessionId to null so the next Claude invocation will
   * create a fresh session. The previous session remains in the database.
   */
  newSession() {
    this.logger.info('conversation', `Starting new session (previous=${this.currentSessionId || 'none'})`);
    this.currentSessionId = null;
  }

  /**
   * Update the current session ID (typically called after receiving
   * the session_id from a Claude CLI result).
   *
   * @param {string} id - The Claude CLI session ID
   */
  setSessionId(id) {
    this.currentSessionId = id;
    this.logger.debug('conversation', `Session ID set to ${id}`);
  }

  /**
   * Auto-compact conversation history when it exceeds the configured threshold.
   *
   * Compaction only runs when no Claude subprocess is active (prevents race
   * conditions). Old messages are summarized via Claude and replaced with a
   * single summary message, keeping the 20 most recent messages intact.
   *
   * @param {object} claudeBridge - ClaudeBridge instance (used to check activity and summarize)
   * @returns {Promise<boolean>} True if compaction was performed
   */
  async compact(claudeBridge) {
    // Guard: do not compact while Claude is processing a request
    if (claudeBridge.isActive()) {
      this.logger.debug('conversation', 'Skipping compaction: Claude subprocess is active');
      return false;
    }

    const count = await this.getMessageCount();
    const threshold = this.config.HISTORY_COMPACT_THRESHOLD;

    if (count <= threshold) {
      this.logger.debug('conversation', `No compaction needed (${count}/${threshold} messages)`);
      return false;
    }

    this.logger.info('conversation', `Starting compaction (${count} messages, threshold=${threshold})`);

    const keepRecent = 20;
    const removeCount = count - keepRecent;

    try {
      // Fetch the oldest messages that will be summarized
      const oldMessages = await this.db.query(
        `SELECT id, created_at, role, content
         FROM conversation_messages
         ORDER BY created_at ASC
         LIMIT $1`,
        [removeCount],
      );

      if (oldMessages.rows.length === 0) {
        return false;
      }

      // Format old messages for the summarization prompt
      const formatted = oldMessages.rows
        .map((msg) => `[${msg.role}] (${msg.created_at.toISOString()}): ${msg.content}`)
        .join('\n\n');

      const summarizationPrompt =
        'Summarize the following conversation history into a concise context summary. ' +
        'Preserve key facts, decisions, ongoing topics, and any important context. ' +
        'Use bullet points for clarity. This summary will replace the original messages ' +
        'to keep conversation history manageable.';

      // Use the Claude bridge to generate a summary
      const result = await claudeBridge.invoke(
        `${summarizationPrompt}\n\n---\n\n${formatted}`,
        null, // New session for the summary task
        'You are a conversation summarizer. Produce a concise, factual summary.',
      );

      if (!result.text) {
        this.logger.warn('conversation', 'Compaction aborted: empty summary from Claude');
        return false;
      }

      // Collect IDs of messages to delete
      const idsToDelete = oldMessages.rows.map((msg) => msg.id);

      // Insert the summary message
      await this.db.query(
        `INSERT INTO conversation_messages (session_id, role, content, metadata)
         VALUES ($1, 'summary', $2, $3)`,
        [
          this.currentSessionId,
          result.text,
          JSON.stringify({
            compacted_count: idsToDelete.length,
            compacted_at: new Date().toISOString(),
            summary_cost_usd: result.cost,
          }),
        ],
      );

      // Delete the original old messages
      await this.db.query(
        'DELETE FROM conversation_messages WHERE id = ANY($1::int[])',
        [idsToDelete],
      );

      this.logger.info(
        'conversation',
        `Compaction complete: ${idsToDelete.length} messages replaced with summary`,
      );

      return true;
    } catch (err) {
      this.logger.error('conversation', `Compaction failed: ${err.message}`);
      return false;
    }
  }
}

export { ConversationManager };
export default ConversationManager;
