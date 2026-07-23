import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

test('rebuilds legacy accounts without carrying old tokens and is idempotent', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE proxy_accounts (
      identity TEXT PRIMARY KEY,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      gh_token TEXT,
      gh_token_status TEXT NOT NULL DEFAULT 'missing',
      gh_token_updated_at TEXT,
      copilot_token TEXT,
      copilot_api TEXT,
      copilot_token_expires_at TEXT,
      copilot_token_status TEXT NOT NULL DEFAULT 'missing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE proxy_request_stats (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      gh_login TEXT,
      requested_at TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      success INTEGER NOT NULL,
      failure_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER
    );
    INSERT INTO proxy_accounts VALUES (
      'alice', 'alice', 'alice_octo', 'legacy-gh-token', 'valid', '2026-01-01T00:00:00.000Z',
      'legacy-copilot-token', 'https://api.githubcopilot.com', '2026-01-01T01:00:00.000Z', 'valid',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO proxy_request_stats (
      id, identity, requested_at, path, success
    ) VALUES ('request-1', 'alice', '2026-01-01T00:00:00.000Z', '/v1/models', 1);
  `);

  runMigrations(db);

  const columns = db.prepare('PRAGMA table_info(proxy_accounts)').all() as Array<{ name: string }>;
  assert.deepEqual(columns.map((column) => column.name), [
    'identity',
    'sso_user',
    'gh_login',
    'copilot_oauth_token',
    'copilot_oauth_status',
    'copilot_oauth_updated_at',
    'copilot_oauth_attempt_id',
    'created_at',
    'updated_at',
  ]);
  assert.deepEqual(
    db.prepare(`
      SELECT identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status, copilot_oauth_updated_at
      FROM proxy_accounts
    `).get(),
    {
      identity: 'alice',
      sso_user: 'alice',
      gh_login: 'alice_octo',
      copilot_oauth_token: null,
      copilot_oauth_status: 'missing',
      copilot_oauth_updated_at: null,
    },
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM proxy_request_stats').get() as { count: number }).count, 1);

  db.prepare(`
    UPDATE proxy_accounts
    SET copilot_oauth_token = 'new-oauth-token', copilot_oauth_status = 'valid'
    WHERE identity = 'alice'
  `).run();
  runMigrations(db);
  assert.deepEqual(
    db.prepare('SELECT copilot_oauth_token, copilot_oauth_status FROM proxy_accounts WHERE identity = ?').get('alice'),
    { copilot_oauth_token: 'new-oauth-token', copilot_oauth_status: 'valid' },
  );
  db.close();
});
