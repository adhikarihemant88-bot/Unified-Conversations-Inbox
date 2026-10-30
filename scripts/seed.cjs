const { Pool } = require('pg');
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (existsSync('.env')) process.loadEnvFile('.env');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const n of [1, 2]) {
      await c.query('INSERT INTO locations VALUES ($1,$2) ON CONFLICT DO NOTHING', [`loc_${n}`, `Demo location ${n}`]);
      await c.query('INSERT INTO agents VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [`agent_${n}`, `loc_${n}`, createHash('sha256').update(`demo-agent-${n}-token`).digest('hex')]);
    }
    const id = '00000000-0000-4000-8000-000000000001';
    await c.query('INSERT INTO contacts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, 'loc_1', 'Demo customer']);
    for (const [kind, value] of [['phone', '+919876543210'], ['email', 'customer@example.com']]) {
      await c.query('INSERT INTO contact_identities VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', ['loc_1', id, kind, value]);
    }
    await c.query('COMMIT');
    console.log('Demo seed complete. Agent tokens: demo-agent-1-token / demo-agent-2-token');
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
})().catch(() => { console.error('Seed failed. Run migrations first and check connectivity.'); process.exitCode = 1; }).finally(() => pool.end());
