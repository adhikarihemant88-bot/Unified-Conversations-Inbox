const { Pool } = require('pg');
const { existsSync, readFileSync } = require('node:fs');
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (existsSync('.env')) process.loadEnvFile('.env');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inbox-migrations', 0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
    const name = '001_init';
    if (!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) {
      await client.query(readFileSync('db/001_init.sql', 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
    console.log('Migrations complete');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
})().catch(() => { console.error('Migration failed. Check database connectivity and permissions.'); process.exitCode = 1; }).finally(() => pool.end());
