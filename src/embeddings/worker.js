import { generateEmbedding } from '../mcp/embed-server.js';

/**
 * Mapping of entity types to the SQL query that retrieves the text content
 * to be embedded for a given entity_id.
 */
const ENTITY_TEXT_SOURCES = {
  message: {
    query: 'SELECT content AS text FROM conversation_messages WHERE id = $1',
  },
  node: {
    query: `SELECT name || COALESCE(' ' || note, '') AS text FROM knowledge_nodes WHERE id = $1`,
  },
  journal: {
    query: 'SELECT note AS text FROM journal WHERE id = $1',
  },
  issue: {
    query: 'SELECT note AS text FROM issues WHERE id = $1',
  },
  spec: {
    query: 'SELECT note AS text FROM specifications WHERE id = $1',
  },
};

/** Maximum rows to process in a single iteration. */
const BATCH_SIZE = 10;

/** Milliseconds between processing iterations. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Background embedding worker -- periodically processes rows in the
 * embeddings table that have a NULL vector, generates the embedding via
 * the configured API, and stores the result (spec section 11.4).
 */
class EmbeddingWorker {
  /**
   * @param {object} deps
   * @param {object} deps.db     - Database query interface ({ query(sql, params) }).
   * @param {object} deps.config - Application configuration.
   * @param {object} deps.logger - Logger instance.
   */
  constructor({ db, config, logger }) {
    this.db = db;
    this.config = config;
    this.logger = logger;

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;

    /** Whether the worker loop is active. */
    this._running = false;

    /** Guard to prevent overlapping iterations. */
    this._processing = false;
  }

  /**
   * Start the periodic embedding worker loop.
   * Processes up to {@link BATCH_SIZE} NULL-vector rows every
   * {@link POLL_INTERVAL_MS} milliseconds.
   */
  start() {
    if (this._running) {
      return;
    }

    this._running = true;
    this.logger.info('embedding-worker', 'Starting background embedding worker.');
    this._scheduleNext();
  }

  /**
   * Stop the worker loop gracefully.  Any in-flight iteration will finish
   * before the loop fully halts.
   */
  stop() {
    this._running = false;

    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    this.logger.info('embedding-worker', 'Embedding worker stopped.');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

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

      try {
        this._processing = true;
        await this._processQueue();
      } catch (err) {
        this.logger.error(
          'embedding-worker',
          `Unexpected error in worker loop: ${err.message}`,
        );
      } finally {
        this._processing = false;
        this._scheduleNext();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Fetch and process a batch of rows with NULL vectors.
   */
  async _processQueue() {
    const result = await this.db.query(
      `SELECT id, entity_type, entity_id
       FROM embeddings
       WHERE vector IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (result.rows.length === 0) {
      return;
    }

    this.logger.debug(
      'embedding-worker',
      `Processing ${result.rows.length} pending embedding(s).`,
    );

    for (const row of result.rows) {
      try {
        await this._processRow(row);
      } catch (err) {
        // Log the failure and continue with the next row
        this.logger.error(
          'embedding-worker',
          `Failed to generate embedding for ${row.entity_type}:${row.entity_id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Process a single embedding row: look up the source text, call the
   * embedding API, and store the resulting vector.
   *
   * @param {{ id: number, entity_type: string, entity_id: number }} row
   */
  async _processRow(row) {
    const { id, entity_type: entityType, entity_id: entityId } = row;

    // Resolve the query for this entity type
    const source = ENTITY_TEXT_SOURCES[entityType];
    if (!source) {
      this.logger.warn(
        'embedding-worker',
        `Unknown entity type "${entityType}" for embedding ${id}; skipping.`,
      );
      return;
    }

    // Fetch the text content from the source table
    const textResult = await this.db.query(source.query, [entityId]);

    if (textResult.rows.length === 0) {
      this.logger.warn(
        'embedding-worker',
        `Source entity ${entityType}:${entityId} not found; removing orphaned embedding row ${id}.`,
      );
      await this.db.query('DELETE FROM embeddings WHERE id = $1', [id]);
      return;
    }

    const text = textResult.rows[0].text;
    if (!text || text.trim().length === 0) {
      this.logger.debug(
        'embedding-worker',
        `Empty text for ${entityType}:${entityId}; skipping embedding generation.`,
      );
      return;
    }

    // Generate the embedding vector via the configured API
    const { vector } = await generateEmbedding(text, this.config);

    // Format as a pgvector literal: [0.123,0.456,...]
    const vectorLiteral = `[${vector.join(',')}]`;

    // Update the row with the computed vector
    await this.db.query(
      `UPDATE embeddings
       SET vector = $1::vector, updated_at = NOW()
       WHERE id = $2`,
      [vectorLiteral, id],
    );

    this.logger.debug(
      'embedding-worker',
      `Generated embedding for ${entityType}:${entityId} (${vector.length} dimensions).`,
    );
  }
}

export { EmbeddingWorker };
export default EmbeddingWorker;
