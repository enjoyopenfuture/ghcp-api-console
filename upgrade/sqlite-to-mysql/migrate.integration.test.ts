import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { runMigrations } from '../../src/proxy/src/db/migrations.js';
import { migrateSqliteToMysql } from './migrate.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;

test('copies current SQLite data and refuses a non-empty target', {
  skip: mysqlUrl ? false : 'Set MYSQL_TEST_URL to run the migration integration test.',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ghcp-proxy-upgrade-'));
  const sqlitePath = join(directory, 'proxy.sqlite');
  const source = new Database(sqlitePath);
  runMigrations(source);
  source.prepare(`
    INSERT INTO proxy_accounts (
      identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
      copilot_oauth_updated_at, copilot_oauth_attempt_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Alice',
    'alice',
    'alice_octo',
    'sensitive-test-token',
    'valid',
    '2026-08-27T10:00:00.000Z',
    null,
    '2026-08-27T09:00:00.000Z',
    '2026-08-27T10:00:00.000Z',
  );
  source.prepare(`
    INSERT INTO proxy_request_stats (
      id, identity, requested_at, path, success, input_tokens
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('request-1', 'Alice', '2026-08-27T10:01:00.000Z', '/v1/models', 1, 42);
  source.close();

  const pool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 2,
    timezone: 'Z',
    dateStrings: true,
  });
  try {
    await clearTarget(pool);
    const dryRun = await migrateSqliteToMysql({ sqlitePath, mysqlUrl: mysqlUrl!, dryRun: true });
    assert.deepEqual(dryRun, { accounts: 1, requestStats: 1, dryRun: true });

    const result = await migrateSqliteToMysql({ sqlitePath, mysqlUrl: mysqlUrl! });
    assert.deepEqual(result, { accounts: 1, requestStats: 1, dryRun: false });

    const [accounts] = await pool.query<Array<RowDataPacket & {
      identity: string;
      copilot_oauth_token: string;
    }>>('SELECT identity, copilot_oauth_token FROM proxy_accounts');
    assert.deepEqual(accounts, [{ identity: 'Alice', copilot_oauth_token: 'sensitive-test-token' }]);
    const [stats] = await pool.query<Array<RowDataPacket & { input_tokens: number }>>(
      'SELECT input_tokens FROM proxy_request_stats',
    );
    assert.equal(Number(stats[0]?.input_tokens), 42);

    await assert.rejects(
      migrateSqliteToMysql({ sqlitePath, mysqlUrl: mysqlUrl! }),
      /Refusing to migrate into a non-empty MySQL target/,
    );

    const unchanged = new Database(sqlitePath, { readonly: true });
    assert.equal(
      (unchanged.prepare('SELECT COUNT(*) AS count FROM proxy_accounts').get() as { count: number }).count,
      1,
    );
    unchanged.close();
  } finally {
    await clearTarget(pool).catch(() => undefined);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

async function clearTarget(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query('DELETE FROM proxy_identity_initializations');
  await pool.query('DELETE FROM proxy_request_stats');
  await pool.query('DELETE FROM proxy_accounts');
}
