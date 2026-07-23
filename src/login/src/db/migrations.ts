import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_tasks (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      oauth_attempt_id TEXT,
      sso_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      log_path TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_login_tasks_status_created_at
      ON login_tasks(status, created_at);
  `);
  addColumnIfMissing(db, 'login_tasks', 'oauth_attempt_id', 'TEXT');
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
