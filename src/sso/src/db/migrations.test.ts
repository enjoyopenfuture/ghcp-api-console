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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, row_index)
      );
    `);

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(sso_emu_import_plan_rows)').all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === 'copilot_seat_status'), true);
  } finally {
    db.close();
  }
});
