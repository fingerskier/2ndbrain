/**
 * Embeddings engine -- manages pgvector-backed semantic search infrastructure.
 *
 * Handles startup configuration resolution per spec section 11.4:
 *   1. Resolve dimensions from env var or model defaults
 *   2. First-time setup: create extension, tables, index
 *   3. Model switch: drop/recreate vector column, queue re-embedding
 *   4. No change: skip
 *
 * Only creates pgvector tables when EMBEDDING_PROVIDER is set.
 */

/**
 * Default vector dimensions for known OpenAI embedding models.
 */
const MODEL_DIMENSION_DEFAULTS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

class EmbeddingsEngine {
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
    this._dimensions = null;
  }

  /**
   * Returns true when the embedding provider is configured.
   *
   * @returns {boolean}
   */
  isEnabled() {
    return Boolean(this.config.EMBEDDING_PROVIDER);
  }

  /**
   * Run startup configuration resolution.
   *
   * 1. Resolve dimensions: from EMBEDDING_DIMENSIONS env var, or model
   *    defaults (text-embedding-3-small=1536, text-embedding-3-large=3072,
   *    text-embedding-ada-002=1536).  Fails startup if the model is unknown
   *    and no explicit dimension is provided.
   * 2. First-time setup: CREATE EXTENSION IF NOT EXISTS vector, create
   *    embedding_config and embeddings tables, create HNSW index, insert
   *    config row.
   * 3. Model switch: log warning, drop+recreate vector column with new
   *    dimensions, recreate index, update config.  All existing rows become
   *    NULL-vector and are re-embedded by the background worker.
   * 4. No change: skip.
   */
  async initialize() {
    if (!this.isEnabled()) {
      this.logger.info('embeddings', 'Embedding provider not configured; embeddings disabled.');
      return;
    }

    const provider = this.config.EMBEDDING_PROVIDER;
    const model = this.config.EMBEDDING_MODEL || 'text-embedding-3-small';
    const dimensions = this._resolveDimensions(model);
    this._dimensions = dimensions;

    this.logger.info(
      'embeddings',
      `Initializing embeddings: provider=${provider} model=${model} dimensions=${dimensions}`,
    );

    // Ensure the pgvector extension is available
    await this.db.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Check whether the embedding_config table already exists
    const tableCheck = await this.db.query(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name   = 'embedding_config'
       ) AS table_exists`,
    );

    if (!tableCheck.rows[0].table_exists) {
      await this._firstTimeSetup(provider, model, dimensions);
      return;
    }

    // Table exists -- check for an existing config row
    const configRow = await this.db.query(
      'SELECT provider, model, dimensions FROM embedding_config WHERE id = 1',
    );

    if (configRow.rows.length === 0) {
      // Table present but empty -- treat as first-time setup
      await this._firstTimeSetup(provider, model, dimensions);
      return;
    }

    const current = configRow.rows[0];

    if (
      current.provider === provider &&
      current.model === model &&
      current.dimensions === dimensions
    ) {
      // Configuration unchanged
      this.logger.info('embeddings', 'Embedding configuration unchanged.');
      return;
    }

    // Configuration differs -- perform model switch
    await this._handleModelSwitch(current, { provider, model, dimensions });
  }

  /**
   * Queue an entity for background embedding generation.
   * Inserts a row with a NULL vector; the background worker will fill it in.
   *
   * @param {string} entityType - Entity type (e.g. 'message', 'node', 'journal', 'issue').
   * @param {number} entityId   - Primary key of the source entity.
   */
  async queueEmbedding(entityType, entityId) {
    if (!this.isEnabled()) {
      return;
    }

    await this.db.query(
      `INSERT INTO embeddings (entity_type, entity_id)
       VALUES ($1, $2)
       ON CONFLICT (entity_type, entity_id) DO NOTHING`,
      [entityType, entityId],
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the target vector dimensions from the EMBEDDING_DIMENSIONS env var
   * or the known model defaults.
   *
   * @param {string} model - Embedding model name.
   * @returns {number} Resolved dimension count.
   * @throws {Error} When dimensions cannot be determined.
   */
  _resolveDimensions(model) {
    if (this.config.EMBEDDING_DIMENSIONS) {
      const dim = parseInt(this.config.EMBEDDING_DIMENSIONS, 10);
      if (Number.isNaN(dim) || dim <= 0) {
        throw new Error(
          `Invalid EMBEDDING_DIMENSIONS value: "${this.config.EMBEDDING_DIMENSIONS}"`,
        );
      }
      return dim;
    }

    const defaultDim = MODEL_DIMENSION_DEFAULTS[model];
    if (!defaultDim) {
      throw new Error(
        `Unknown embedding model "${model}" and EMBEDDING_DIMENSIONS is not set. ` +
        `Set EMBEDDING_DIMENSIONS explicitly or use a known model: ` +
        `${Object.keys(MODEL_DIMENSION_DEFAULTS).join(', ')}`,
      );
    }

    return defaultDim;
  }

  /**
   * First-time setup: create the embedding_config and embeddings tables,
   * the HNSW index, and the initial config row.
   *
   * @param {string} provider   - Embedding provider name.
   * @param {string} model      - Embedding model name.
   * @param {number} dimensions - Vector dimension count.
   */
  async _firstTimeSetup(provider, model, dimensions) {
    this.logger.info('embeddings', 'First-time embedding setup: creating tables and index.');

    // Create the single-row configuration table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS embedding_config (
        id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        dimensions  INTEGER NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Create the embeddings table with the resolved vector dimension.
    // NOTE: The dimension is a validated integer, not user input; string
    // interpolation in the DDL statement is safe here because parameterized
    // DDL is not supported by PostgreSQL for column type definitions.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id          SERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        entity_type TEXT NOT NULL,
        entity_id   INTEGER NOT NULL,
        vector      VECTOR(${dimensions}),
        UNIQUE(entity_type, entity_id)
      )
    `);

    // HNSW index for fast approximate nearest-neighbor search (cosine distance)
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_vector
      ON embeddings USING hnsw (vector vector_cosine_ops)
    `);

    // Insert (or update) the config row
    await this.db.query(
      `INSERT INTO embedding_config (provider, model, dimensions)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET provider = $1, model = $2, dimensions = $3, updated_at = NOW()`,
      [provider, model, dimensions],
    );

    this.logger.info('embeddings', 'Embedding tables and index created successfully.');
  }

  /**
   * Handle a model configuration change.
   *
   * Drops the existing vector column and HNSW index, recreates them with the
   * new dimension, and updates the config row.  All existing embedding rows
   * are left with a NULL vector so the background worker re-generates them.
   *
   * @param {object} oldConfig - Previous { provider, model, dimensions }.
   * @param {object} newConfig - New { provider, model, dimensions }.
   */
  async _handleModelSwitch(oldConfig, newConfig) {
    this.logger.warn(
      'embeddings',
      `Embedding model changed from ${oldConfig.provider}/${oldConfig.model} ` +
      `(${oldConfig.dimensions}d) to ${newConfig.provider}/${newConfig.model} ` +
      `(${newConfig.dimensions}d). All existing embeddings will be dropped and re-generated.`,
    );

    // Drop the HNSW index
    await this.db.query('DROP INDEX IF EXISTS idx_embeddings_vector');

    // Drop and recreate the vector column with the new dimension
    await this.db.query('ALTER TABLE embeddings DROP COLUMN vector');
    await this.db.query(
      `ALTER TABLE embeddings ADD COLUMN vector VECTOR(${newConfig.dimensions})`,
    );

    // Recreate the HNSW index
    await this.db.query(`
      CREATE INDEX idx_embeddings_vector
      ON embeddings USING hnsw (vector vector_cosine_ops)
    `);

    // Update the config row
    await this.db.query(
      `UPDATE embedding_config
       SET provider = $1, model = $2, dimensions = $3, updated_at = NOW()
       WHERE id = 1`,
      [newConfig.provider, newConfig.model, newConfig.dimensions],
    );

    this.logger.info(
      'embeddings',
      'Model switch complete. All embeddings queued for re-generation.',
    );
  }
}

export { EmbeddingsEngine };
export default EmbeddingsEngine;
