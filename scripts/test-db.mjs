import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

let postgres;
let directory;
try {
  if (!process.env.TEST_DATABASE_URL) {
    const socket = createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    directory = await mkdtemp(join(tmpdir(), 'inbox-test-'));
    postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'postgres', password: 'test-only', persistent: true,
      postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
    await postgres.initialise(); await postgres.start();
    process.env.TEST_DATABASE_URL = `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`;
    console.log('Disposable PostgreSQL started. No application database is used.');
  }
  const child = spawn(process.execPath, ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'test/jest-e2e.json', '--runInBand', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} catch (error) {
  console.error('Integration tests could not run:', error.message); process.exitCode = 1;
} finally {
  if (postgres) await postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}
