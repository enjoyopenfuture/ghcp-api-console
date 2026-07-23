import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

test('adds OAuth attempt IDs to existing login task databases idempotently', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE login_tasks (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      sso_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      log_path TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    INSERT INTO login_tasks (
      id, identity, sso_user, gh_login, sso_type, created_at
    ) VALUES ('legacy-task', 'alice', 'alice', 'alice_octo', 'custom', '2026-01-01T00:00:00.000Z');
  `);

  runMigrations(db);
  runMigrations(db);

  const columns = db.prepare('PRAGMA table_info(login_tasks)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'oauth_attempt_id'), true);
  assert.deepEqual(
    db.prepare('SELECT id, oauth_attempt_id FROM login_tasks').get(),
    { id: 'legacy-task', oauth_attempt_id: null },
  );
  db.close();
});
