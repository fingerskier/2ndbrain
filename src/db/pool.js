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

export { pool, query, close };
export default pool;
