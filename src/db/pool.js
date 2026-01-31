import pg from 'pg';
import config from '../config.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

// Emit errors on idle clients so they don't crash the process
pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] [error] [db/pool] Unexpected idle client error:`, err.message);
});

/**
 * Ensure the target database exists, creating it if necessary.
 * Connects to the 'postgres' maintenance database to check/create.
 */
async function ensureDatabase() {
  try {
    const url = new URL(config.DATABASE_URL);
    const dbName = url.pathname.slice(1); // strip leading '/'
    if (!dbName) return;

    // Build a maintenance URL pointing at the 'postgres' system database
    const maintenanceUrl = new URL(config.DATABASE_URL);
    maintenanceUrl.pathname = '/postgres';

    const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await client.connect();

    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );

    if (result.rows.length === 0) {
      // Use double-quoted identifier to handle special characters in name
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[${new Date().toISOString()}] [info] [db/pool] Created database "${dbName}".`);
    }

    await client.end();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [error] [db/pool] ensureDatabase failed: ${err.message}`);
  }
}

/**
 * Execute a parameterized SQL query against the pool.
 * @param {string} text - SQL query string
 * @param {Array} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Gracefully close all connections in the pool.
 */
async function close() {
  await pool.end();
}

export { pool, query, close, ensureDatabase };
export default pool;
