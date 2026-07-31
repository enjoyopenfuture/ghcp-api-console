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

    CREATE TABLE IF NOT EXISTS login_runtime_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 20),
      auth_timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK (auth_timeout_ms BETWEEN 5000 AND 600000),
      auth_debug_logs INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_logs IN (0, 1)),
      auth_debug_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (auth_debug_artifacts IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;

    INSERT OR IGNORE INTO login_runtime_settings (
      id, concurrency, auth_timeout_ms, auth_debug_logs, auth_debug_artifacts, version, updated_at
    ) VALUES (
      1, 1, 60000, 0, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  `);
  addColumnIfMissing(db, 'login_tasks', 'oauth_attempt_id', 'TEXT');
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
