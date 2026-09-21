import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import {
  newRequestId,
  nowIso,
  pageResponse,
  type CopilotOauthStatus,
  type DeleteProxyAccountResult,
  type PageResponse,
  type ProxyRequestStatDto,
  type ManagementQuery,
  type ManagementSummary,
} from '@ghcp/shared';
import { runMysqlMigrations, validateMysqlTables } from './mysqlMigrations.js';
import { managementSql } from './managementQueries.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
  ProxyStorage,
  RecordRequestStatInput,
} from './storageTypes.js';

interface AccountRow extends RowDataPacket {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  copilot_oauth_token: string | null;
  copilot_oauth_status: CopilotOauthStatus;
  copilot_oauth_updated_at: string | null;
  copilot_oauth_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StatRow extends RowDataPacket {
  id: string;
  identity: string;
  gh_login: string | null;
  requested_at: string;
  path: ProxyRequestStatDto['path'];
  model: string | null;
  success: number | boolean;
  failure_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  cache_input_tokens: number | null;
  cache_write_tokens: number | null;
}

export class MysqlStorage implements ProxyStorage {
  async withReadSnapshot<T>(read: (reader: Pick<ProxyStorage, 'listAccounts' | 'listRequestStatsPage'>) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      return await read({
        listAccounts: (query) => this.listAccounts(query, connection),
        listRequestStatsPage: (query) => this.listRequestStatsPage(query, connection),
      });
    } finally {
      try { await connection.rollback(); } finally { connection.release(); }
    }
  }

  constructor(
    private readonly pool: Pool,
    private readonly requestStatsPerAccountLimit: number,
    private readonly autoMigrate = true,
  ) { }

  async initialize(): Promise<void> {
    if (this.autoMigrate) {
      await runMysqlMigrations(this.pool);
    } else {
      await validateMysqlTables(this.pool);
    }
    await this.ping();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listAccounts(query: AccountListQuery = {}, connection: Pick<Pool, 'execute'> = this.pool): Promise<PageResponse<ProxyAccountRecord>> {
    let page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const { where, args, order } = managementSql('accounts', query, mysqlTimestamp);
    const [countRows] = await connection.execute<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM proxy_accounts ${where}`,
      args,
    );
    const total = Number(countRows[0]?.count ?? 0);
    page = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const [rows] = await connection.execute<AccountRow[]>(
      `SELECT * FROM proxy_accounts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    return pageResponse(rows.map(mapAccountRow), total, page, pageSize);
  }

  async summarizeAccounts(): Promise<ManagementSummary> {
    const [rows] = await this.pool.execute<Array<RowDataPacket & { status: string; count: number }>>(
      'SELECT copilot_oauth_status AS status, COUNT(*) AS count FROM proxy_accounts GROUP BY copilot_oauth_status',
    );
    return { total: rows.reduce((total, row) => total + Number(row.count), 0), counts: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])), updatedAt: nowIso() };
  }

  async getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
    const [rows] = await this.pool.execute<AccountRow[]>(
      'SELECT * FROM proxy_accounts WHERE identity = ?',
      [identity],
    );
    return rows[0] ? mapAccountRow(rows[0]) : undefined;
  }

  async deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined> {
    const target = identity.trim();
    if (!target) return undefined;
    return this.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM proxy_accounts WHERE identity = ? FOR UPDATE',
        [target],
      );
      if (rows.length === 0) return undefined;
      const [statsResult] = await connection.execute<ResultSetHeader>(
        'DELETE FROM proxy_request_stats WHERE identity = ?',
        [target],
      );
      const [accountResult] = await connection.execute<ResultSetHeader>(
        'DELETE FROM proxy_accounts WHERE identity = ?',
        [target],
      );
      if (accountResult.affectedRows !== 1) throw new Error(`Failed to delete Proxy account "${target}".`);
      return { identity: target, deletedRequestStats: statsResult.affectedRows };
    });
  }

  async deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
    const target = ssoUser.trim();
    if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
    return this.transaction(async (connection) => {
      const [accounts] = await connection.execute<Array<RowDataPacket & { identity: string }>>(
        'SELECT identity FROM proxy_accounts WHERE LOWER(sso_user) = LOWER(?) FOR UPDATE',
        [target],
      );
      const identities = accounts.map((account) => account.identity);
      let deletedRequestStats = 0;
      if (identities.length > 0) {
        const placeholders = identities.map(() => '?').join(', ');
        const [statsResult] = await connection.execute<ResultSetHeader>(
          `DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`,
          identities,
        );
        deletedRequestStats = statsResult.affectedRows;
      }
      const [accountResult] = await connection.execute<ResultSetHeader>(
        'DELETE FROM proxy_accounts WHERE LOWER(sso_user) = LOWER(?)',
        [target],
      );
      return {
        ssoUser: target,
        matchedAccounts: accounts.length,
        deletedAccounts: accountResult.affectedRows,
        deletedRequestStats,
      };
    });
  }

  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    const now = mysqlTimestamp(nowIso());
    await this.pool.execute(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_status, copilot_oauth_attempt_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        sso_user = VALUES(sso_user),
        gh_login = COALESCE(VALUES(gh_login), gh_login),
        updated_at = VALUES(updated_at)
    `, [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      input.copilotOauthStatus ?? 'missing',
      input.copilotOauthAttemptId ?? null,
      now,
      now,
    ]);
    return (await this.getAccount(input.identity))!;
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const now = mysqlTimestamp(nowIso());
    await this.pool.execute(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
        copilot_oauth_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        sso_user = VALUES(sso_user),
        gh_login = COALESCE(VALUES(gh_login), gh_login),
        copilot_oauth_token = VALUES(copilot_oauth_token),
        copilot_oauth_status = 'valid',
        copilot_oauth_updated_at = VALUES(copilot_oauth_updated_at),
        copilot_oauth_attempt_id = NULL,
        updated_at = VALUES(updated_at)
    `, [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      input.copilotOauthToken,
      now,
      now,
      now,
    ]);
    return (await this.getAccount(input.identity))!;
  }

  async saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined> {
    const now = mysqlTimestamp(nowIso());
    // The status guard makes "cancel wins": once Login marked the attempt failed, a token that
    // arrives late for the same attempt is refused instead of silently reviving it.
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = ?, gh_login = COALESCE(?, gh_login),
          copilot_oauth_status = 'valid', copilot_oauth_updated_at = ?,
          copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ? AND copilot_oauth_status = 'refreshing'
    `, [copilotOauthToken, ghLogin ?? null, now, now, identity, oauthAttemptId]);
    return result.affectedRows > 0 ? this.getAccount(identity) : undefined;
  }

  async markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
    await this.pool.execute(
      'UPDATE proxy_accounts SET copilot_oauth_status = ?, updated_at = ? WHERE identity = ?',
      [status, mysqlTimestamp(nowIso()), identity],
    );
  }

  async beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, expectedAttemptId?: string | null): Promise<boolean> {
    // `<=>` is MySQL's NULL-safe equality, so `null` matches an account without an attempt.
    const guard = expectedAttemptId === undefined ? '' : ' AND copilot_oauth_attempt_id <=> ?';
    const args = expectedAttemptId === undefined ? [] : [expectedAttemptId];
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'refreshing', copilot_oauth_attempt_id = ?, updated_at = ?
      WHERE identity = ? ${guard}
    `, [oauthAttemptId, mysqlTimestamp(nowIso()), identity, ...args]);
    return result.affectedRows > 0;
  }

  async failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'failed', updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ?
    `, [mysqlTimestamp(nowIso()), identity, oauthAttemptId]);
    return result.affectedRows > 0;
  }

  async invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean> {
    const now = mysqlTimestamp(nowIso());
    const [result] = await this.pool.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = NULL, copilot_oauth_status = ?,
          copilot_oauth_updated_at = ?, copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
    `, [status, now, now, identity, expectedToken]);
    return result.affectedRows > 0;
  }

  async claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const now = mysqlTimestamp(nowIso());
    const leaseExpiresAt = mysqlTimestamp(new Date(Date.now() + leaseSeconds * 1000).toISOString());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [inserted] = await this.pool.execute<ResultSetHeader>(`
          INSERT IGNORE INTO proxy_identity_initializations (
            identity, claim_id, lease_expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `, [identity, claimId, leaseExpiresAt, now, now]);
        if (inserted.affectedRows === 1) return true;
        const [updated] = await this.pool.execute<ResultSetHeader>(`
          UPDATE proxy_identity_initializations
          SET claim_id = ?, lease_expires_at = ?, updated_at = ?
          WHERE identity = ? AND lease_expires_at <= ?
        `, [claimId, leaseExpiresAt, now, identity, now]);
        return updated.affectedRows === 1;
      } catch (err) {
        if (!isRetryableMysqlLockError(err) || attempt === 2) throw err;
        await sleep((attempt + 1) * 10);
      }
    }
    return false;
  }

  async releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM proxy_identity_initializations WHERE identity = ? AND claim_id = ?',
      [identity, claimId],
    );
    return result.affectedRows > 0;
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    await this.pool.execute(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      newRequestId(),
      input.identity,
      input.ghLogin ?? null,
      mysqlTimestamp(nowIso()),
      input.path,
      input.model ?? null,
      input.success ? 1 : 0,
      input.failureReason ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheTokens ?? null,
      input.cacheInputTokens ?? null,
      input.cacheWriteTokens ?? null,
    ]);
    await this.pruneStats(input.identity);
  }

  async listRequestStats(identity?: string, limit = 100): Promise<ProxyRequestStatDto[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const [rows] = identity
      ? await this.pool.execute<StatRow[]>(
        'SELECT * FROM proxy_request_stats WHERE identity = ? ORDER BY requested_at DESC, id DESC LIMIT ?',
        [identity, boundedLimit],
      )
      : await this.pool.execute<StatRow[]>(
        'SELECT * FROM proxy_request_stats ORDER BY requested_at DESC, id DESC LIMIT ?',
        [boundedLimit],
      );
    return rows.map(mapStatRow);
  }

  async listRequestStatsPage(query: ManagementQuery = {}, connection: Pick<Pool, 'execute'> = this.pool): Promise<PageResponse<ProxyRequestStatDto>> {
    const { where, args, order } = managementSql('requests', query, mysqlTimestamp);
    const [counts] = await connection.execute<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) AS count FROM proxy_request_stats ${where}`, args);
    const total = Number(counts[0]?.count ?? 0);
    const pageSize = Math.max(1, Math.min(query.pageSize ?? 25, 100));
    const page = Math.min(Math.max(1, query.page ?? 1), Math.max(1, Math.ceil(total / pageSize)));
    const [rows] = await connection.execute<StatRow[]>(`SELECT * FROM proxy_request_stats ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize]);
    return pageResponse(rows.map(mapStatRow), total, page, pageSize);
  }

  async pruneAllRequestStats(): Promise<void> {
    await this.pool.execute(`
      DELETE stats
      FROM proxy_request_stats AS stats
      JOIN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY identity
              ORDER BY requested_at DESC, id DESC
            ) AS retention_rank
          FROM proxy_request_stats
        ) AS ranked_stats
        WHERE retention_rank > ?
      ) AS stale_stats ON stale_stats.id = stats.id
    `, [this.requestStatsPerAccountLimit]);
  }

  private async pruneStats(identity: string): Promise<void> {
    await this.pool.execute(`
      DELETE FROM proxy_request_stats
      WHERE identity = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM proxy_request_stats
            WHERE identity = ?
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
          ) AS retained_proxy_request_stats
        )
    `, [identity, identity, this.requestStatsPerAccountLimit]);
  }

  /**
   * Runs `operation` in one transaction. Deadlocks and lock-wait timeouts roll back and retry a
   * bounded number of times: every caller performs a single idempotent unit of work, so replaying
   * the callback on a fresh transaction is safe and beats surfacing a transient InnoDB error.
   */
  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (err) {
        // A broken connection also fails the rollback; the original error is the one worth reporting.
        await connection.rollback().catch(() => undefined);
        if (!isRetryableMysqlLockError(err) || attempt === 2) throw err;
        await sleep((attempt + 1) * 25);
      } finally {
        connection.release();
      }
    }
  }
}

function mapAccountRow(row: AccountRow): ProxyAccountRecord {
  return {
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    copilotOauthToken: row.copilot_oauth_token ?? undefined,
    copilotOauthStatus: row.copilot_oauth_status,
    copilotOauthUpdatedAt: mysqlTimestampToIso(row.copilot_oauth_updated_at),
    copilotOauthAttemptId: row.copilot_oauth_attempt_id ?? undefined,
    createdAt: mysqlTimestampToIso(row.created_at)!,
    updatedAt: mysqlTimestampToIso(row.updated_at)!,
  };
}

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    id: row.id,
    identity: row.identity,
    ghLogin: row.gh_login ?? undefined,
    requestedAt: mysqlTimestampToIso(row.requested_at)!,
    path: row.path,
    model: row.model ?? undefined,
    success: row.success === 1 || row.success === true,
    failureReason: row.failure_reason ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheTokens: row.cache_tokens ?? undefined,
    cacheInputTokens: row.cache_input_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
  };
}

function mysqlTimestamp(value: string): string {
  return value.slice(0, 23).replace('T', ' ');
}

function mysqlTimestampToIso(value: string | null): string | undefined {
  if (!value) return undefined;
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}

function isRetryableMysqlLockError(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) return false;
  return err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
