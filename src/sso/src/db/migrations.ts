import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sso_users (
      sso_user TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      gh_login TEXT,
      gh_scim_id TEXT,
      emu_status TEXT NOT NULL DEFAULT 'not_synced',
      copilot_seat_status TEXT NOT NULL DEFAULT 'unknown',
      copilot_seat_last_operation TEXT,
      copilot_seat_last_error TEXT,
      copilot_seat_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sso_budget_cache (
      period_key TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit_type TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sso_emu_import_plans (
      id TEXT PRIMARY KEY,
      sso_user TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sso_emu_import_plan_rows (
      plan_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      sso_user TEXT NOT NULL,
      email TEXT,
      gh_login TEXT,
      gh_scim_id TEXT,
      emu_status TEXT,
      copilot_seat_status TEXT,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      password_for_login TEXT,
      action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, row_index),
      FOREIGN KEY (plan_id) REFERENCES sso_emu_import_plans(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sso_emu_import_plan_rows_status
      ON sso_emu_import_plan_rows (plan_id, status, row_index);
  `);
  addColumnIfMissing(db, 'sso_emu_import_plan_rows', 'copilot_seat_status', 'TEXT');
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
