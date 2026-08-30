import Database from 'better-sqlite3';
import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';
import { runMysqlMigrations } from '../../src/proxy/src/db/mysqlMigrations.js';

interface SqliteAccountRow {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  copilot_oauth_token: string | null;
  copilot_oauth_status: string;
  copilot_oauth_updated_at: string | null;
  copilot_oauth_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteStatRow {
  id: string;
  identity: string;
  gh_login: string | null;
  requested_at: string;
  path: string;
  model: string | null;
  success: number;
  failure_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  cache_input_tokens: number | null;
  cache_write_tokens: number | null;
}

export interface MigrationOptions {
  sqlitePath: string;
  mysqlUrl: string;
  dryRun?: boolean;
  progress?: (message: string) => void;
}

export interface MigrationResult {
  accounts: number;
  requestStats: number;
  dryRun: boolean;
}

const REQUIRED_ACCOUNT_COLUMNS = [
  'identity',
  'sso_user',
  'gh_login',
  'copilot_oauth_token',
  'copilot_oauth_status',
  'copilot_oauth_updated_at',
  'copilot_oauth_attempt_id',
  'created_at',
  'updated_at',
];

const REQUIRED_STAT_COLUMNS = [
  'id',
  'identity',
  'gh_login',
  'requested_at',
  'path',
  'model',
  'success',
  'failure_reason',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'cache_input_tokens',
  'cache_write_tokens',
];
const COPY_BATCH_SIZE = 500;

export async function migrateSqliteToMysql(options: MigrationOptions): Promise<MigrationResult> {
  const progress = options.progress ?? (() => undefined);
  const source = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  const pool = createPool({
    uri: options.mysqlUrl,
    connectionLimit: 2,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  try {
    validateSqliteSchema(source);
    const accounts = source.prepare('SELECT * FROM proxy_accounts ORDER BY identity').all() as SqliteAccountRow[];
    const requestStats = source
      .prepare('SELECT * FROM proxy_request_stats ORDER BY requested_at, id')
      .all() as SqliteStatRow[];
    progress(`Source preflight: ${accounts.length} account(s), ${requestStats.length} request stat(s).`);

    await requireMysql8(pool);
    if (options.dryRun) {
      const target = await inspectTarget(pool);
      progress(target.exists
        ? `Target preflight: ${target.accounts} account(s), ${target.requestStats} request stat(s).`
        : 'Target preflight: Proxy tables do not exist yet; the migration will create them.');
      return { accounts: accounts.length, requestStats: requestStats.length, dryRun: true };
    }

    await runMysqlMigrations(pool);
    const target = await inspectTarget(pool);
    if (!target.exists) throw new Error('MySQL schema initialization did not create the Proxy tables.');
    if (target.accounts !== 0 || target.requestStats !== 0) {
      throw new Error(
        `Refusing to migrate into a non-empty MySQL target `
        + `(${target.accounts} account(s), ${target.requestStats} request stat(s)).`,
      );
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await copyAccounts(connection, accounts, progress);
      await copyRequestStats(connection, requestStats, progress);
      await verifyTargetCounts(connection, accounts.length, requestStats.length);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    progress(`Migration complete: ${accounts.length} account(s), ${requestStats.length} request stat(s).`);
    return { accounts: accounts.length, requestStats: requestStats.length, dryRun: false };
  } finally {
    source.close();
    await pool.end();
  }
}

function validateSqliteSchema(db: Database.Database): void {
  requireSqliteColumns(db, 'proxy_accounts', REQUIRED_ACCOUNT_COLUMNS);
  requireSqliteColumns(db, 'proxy_request_stats', REQUIRED_STAT_COLUMNS);
}

function requireSqliteColumns(db: Database.Database, table: string, required: string[]): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) throw new Error(`Source SQLite table "${table}" does not exist.`);
  const names = new Set(columns.map((column) => column.name));
  const missing = required.filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Source SQLite table "${table}" is missing column(s): ${missing.join(', ')}. `
      + 'Start the current Proxy once in SQLite mode to apply schema migrations before upgrading.',
    );
  }
}

async function requireMysql8(pool: Pool): Promise<void> {
  const [rows] = await pool.query<Array<RowDataPacket & { version: string }>>(
    'SELECT VERSION() AS version',
  );
  const version = rows[0]?.version ?? '';
  if (!/^8\./.test(version)) throw new Error(`MySQL 8.x is required; target reported version "${version}".`);
}

async function inspectTarget(pool: Pool): Promise<{ exists: boolean; accounts: number; requestStats: number }> {
  const [tables] = await pool.query<Array<RowDataPacket & { name: string }>>(`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('proxy_accounts', 'proxy_request_stats')
  `);
  const names = new Set(tables.map((row) => row.name));
  if (!names.has('proxy_accounts') || !names.has('proxy_request_stats')) {
    return { exists: false, accounts: 0, requestStats: 0 };
  }
  const [accountRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    'SELECT COUNT(*) AS count FROM proxy_accounts',
  );
  const [statRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    'SELECT COUNT(*) AS count FROM proxy_request_stats',
  );
  return {
    exists: true,
    accounts: Number(accountRows[0]?.count ?? 0),
    requestStats: Number(statRows[0]?.count ?? 0),
  };
}

async function copyAccounts(
  connection: PoolConnection,
  rows: SqliteAccountRow[],
  progress: (message: string) => void,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COPY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COPY_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap((row) => [
      row.identity,
      row.sso_user,
      row.gh_login,
      row.copilot_oauth_token,
      row.copilot_oauth_status,
      mysqlTimestamp(row.copilot_oauth_updated_at),
      row.copilot_oauth_attempt_id,
      mysqlTimestamp(row.created_at),
      mysqlTimestamp(row.updated_at),
    ]);
    await connection.query(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
        copilot_oauth_updated_at, copilot_oauth_attempt_id, created_at, updated_at
      ) VALUES ${placeholders}
    `, values);
    progress(`Copied ${Math.min(offset + batch.length, rows.length)}/${rows.length} accounts.`);
  }
}

async function copyRequestStats(
  connection: PoolConnection,
  rows: SqliteStatRow[],
  progress: (message: string) => void,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COPY_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COPY_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap((row) => [
      row.id,
      row.identity,
      row.gh_login,
      mysqlTimestamp(row.requested_at),
      row.path,
      row.model,
      row.success,
      row.failure_reason,
      row.input_tokens,
      row.output_tokens,
      row.cache_tokens,
      row.cache_input_tokens,
      row.cache_write_tokens,
    ]);
    await connection.query(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens
      ) VALUES ${placeholders}
    `, values);
    progress(`Copied ${Math.min(offset + batch.length, rows.length)}/${rows.length} request stats.`);
  }
}

async function verifyTargetCounts(
  connection: PoolConnection,
  expectedAccounts: number,
  expectedRequestStats: number,
): Promise<void> {
  const [accountRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
    'SELECT COUNT(*) AS count FROM proxy_accounts',
  );
  const [statRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
    'SELECT COUNT(*) AS count FROM proxy_request_stats',
  );
  const actualAccounts = Number(accountRows[0]?.count ?? -1);
  const actualRequestStats = Number(statRows[0]?.count ?? -1);
  if (actualAccounts !== expectedAccounts || actualRequestStats !== expectedRequestStats) {
    throw new Error(
      `Target verification failed: expected ${expectedAccounts}/${expectedRequestStats} account/stat rows, `
      + `found ${actualAccounts}/${actualRequestStats}.`,
    );
  }
}

function mysqlTimestamp(value: string | null): string | null {
  return value ? value.slice(0, 23).replace('T', ' ') : null;
}
