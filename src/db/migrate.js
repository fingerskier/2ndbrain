import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

/**
 * Ensure the schema_migrations tracking table exists.
 */
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Retrieve the set of already-applied migration names.
 * @returns {Promise<Set<string>>}
 */
async function getAppliedMigrations() {
  const result = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
  return new Set(result.rows.map((row) => row.name));
}

/**
 * Read all .sql migration files from the migrations directory, sorted by filename.
 * @returns {string[]} Sorted array of filenames
 */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Run all pending database migrations inside individual transactions.
 * Each migration that has not yet been recorded in schema_migrations
 * is executed and tracked.
 *
 * @returns {Promise<string[]>} List of migration names that were applied
 */
async function migrate() {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = getMigrationFiles();
  const newlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      console.log(`[${new Date().toISOString()}] [info] [migrate] Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[${new Date().toISOString()}] [error] [migrate] Failed to apply migration ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) {
    console.log(`[${new Date().toISOString()}] [info] [migrate] No pending migrations.`);
  } else {
    console.log(`[${new Date().toISOString()}] [info] [migrate] Applied ${newlyApplied.length} migration(s).`);
  }

  return newlyApplied;
}

export { migrate, getAppliedMigrations, getMigrationFiles, ensureMigrationsTable };
export default migrate;
