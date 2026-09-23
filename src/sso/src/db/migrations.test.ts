import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

test('adds Copilot seat status to existing EMU import plan rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sso_emu_import_plan_rows (
        plan_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        sso_user TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        password_for_login TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, row_index)
      );
      INSERT INTO sso_emu_import_plan_rows (
        plan_id, row_index, sso_user, status, detail, password_for_login, created_at, updated_at
      ) VALUES ('legacy-plan', 1, 'alice', 'created', 'legacy', 'plaintext-secret', 'now', 'now');
    `);

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(sso_emu_import_plan_rows)').all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === 'copilot_seat_status'), true);
    assert.equal(columns.some((column) => column.name === 'copilot_seat_pending_cancellation_date'), true);
    assert.equal(columns.some((column) => column.name === 'password_for_login'), false);
    const settings = db.prepare('SELECT * FROM sso_runtime_settings WHERE id = 1').get() as Record<string, unknown>;
    assert.equal(settings.max_sso_users, null);
    assert.equal(settings.user_prefix, 'user');
    assert.equal(settings.email_domain, 'customsso.com');
    assert.equal(settings.bulk_sync_concurrency, 3);
    assert.equal(settings.scim_request_delay_ms, 250);
    assert.equal(settings.scim_max_retries, 3);
    assert.equal(settings.scim_retry_base_delay_ms, 1000);
    assert.equal(settings.version, 1);

    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sso_runtime_settings').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('migrates seat dates without guessing old user states or replaying legacy previews', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec(`
      ALTER TABLE sso_users DROP COLUMN copilot_seat_pending_cancellation_date;
      ALTER TABLE sso_emu_import_plan_rows DROP COLUMN copilot_seat_pending_cancellation_date;
      INSERT INTO sso_users (sso_user, password_hash, salt, email, copilot_seat_status, created_at, updated_at)
        VALUES ('alice', 'original-hash', 'original-salt', 'alice@example.test', 'unassigned', 'created', 'updated');
      INSERT INTO sso_emu_import_plans (id, status, created_at, updated_at)
        VALUES ('legacy', 'planned', 'created', 'updated'), ('history', 'applied', 'created', 'updated');
      INSERT INTO sso_emu_import_plan_rows (plan_id, row_index, sso_user, status, detail, action, created_at, updated_at)
        VALUES ('legacy', 1, 'alice', 'pending_update', 'old preview', 'update', 'created', 'updated'),
               ('history', 1, 'bob', 'updated', 'old result', NULL, 'created', 'updated');
    `);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT password_hash, copilot_seat_status, copilot_seat_pending_cancellation_date FROM sso_users').get(), {
      password_hash: 'original-hash', copilot_seat_status: 'unassigned', copilot_seat_pending_cancellation_date: null,
    });
    const preview = db.prepare("SELECT status, detail FROM sso_emu_import_plan_rows WHERE plan_id = 'legacy'").get() as { status: string; detail: string };
    assert.equal(preview.status, 'conflict');
    assert.match(preview.detail, /Preview again/);
    assert.deepEqual(db.prepare("SELECT status, detail FROM sso_emu_import_plan_rows WHERE plan_id = 'history'").get(), {
      status: 'updated', detail: 'old result',
    });
    db.exec("UPDATE sso_emu_import_plan_rows SET status = 'pending_update', copilot_seat_pending_cancellation_date = '2026-10-01' WHERE plan_id = 'legacy'");
    runMigrations(db);
    assert.deepEqual(db.prepare("SELECT status, copilot_seat_pending_cancellation_date FROM sso_emu_import_plan_rows WHERE plan_id = 'legacy'").get(), {
      status: 'pending_update', copilot_seat_pending_cancellation_date: '2026-10-01',
    });
  } finally {
    db.close();
  }
});
