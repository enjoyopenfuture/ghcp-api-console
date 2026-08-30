import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  newRequestId,
  nowIso,
  pageResponse,
  type CopilotOauthStatus,
  type DeleteProxyAccountResult,
  type PageResponse,
  type ProxyRequestStatDto,
} from '@ghcp/shared';
import { runMigrations } from './migrations.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
  ProxyStorage,
  RecordRequestStatInput,
} from './storageTypes.js';

interface AccountRow {
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

interface StatRow {
  id: string;
  identity: string;
  gh_login?: string;
  requested_at: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: 0 | 1;
  failure_reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cache_input_tokens?: number;
  cache_write_tokens?: number;
}

export class SqliteStorage implements ProxyStorage {
  private db?: Database.Database;

  constructor(
    private readonly path: string,
    private readonly requestStatsPerAccountLimit: number,
  ) {}

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new BetterSqlite3(this.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    this.db = db;
  }

  async ping(): Promise<void> {
    this.database().prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  async listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const q = query.q?.trim();
    const where = q ? 'WHERE identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const sort = sortColumn(query.sort);
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const total = (this.database()
      .prepare(`SELECT COUNT(*) AS count FROM proxy_accounts ${where}`)
      .get(...args) as { count: number }).count;
    const rows = this.database()
      .prepare(`SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as AccountRow[];
    return pageResponse(rows.map(mapAccountRow), total, page, pageSize);
  }

  async getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
    const row = this.database()
      .prepare('SELECT * FROM proxy_accounts WHERE identity = ?')
      .get(identity) as AccountRow | undefined;
    return row ? mapAccountRow(row) : undefined;
  }

  async deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined> {
    const target = identity.trim();
    if (!target) return undefined;
    return this.database().transaction(() => {
      const exists = this.database().prepare('SELECT 1 FROM proxy_accounts WHERE identity = ?').get(target);
      if (!exists) return undefined;
      const deletedRequestStats = this.database()
        .prepare('DELETE FROM proxy_request_stats WHERE identity = ?')
        .run(target).changes;
      const deletedAccount = this.database()
        .prepare('DELETE FROM proxy_accounts WHERE identity = ?')
        .run(target).changes;
      if (deletedAccount !== 1) throw new Error(`Failed to delete Proxy account "${target}".`);
      return { identity: target, deletedRequestStats };
    })();
  }

  async deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
    const target = ssoUser.trim();
    if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
    return this.database().transaction(() => {
      const accounts = this.database()
        .prepare('SELECT identity FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
        .all(target) as Array<{ identity: string }>;
      const identities = accounts.map((account) => account.identity);
      let deletedRequestStats = 0;
      if (identities.length > 0) {
        const placeholders = identities.map(() => '?').join(', ');
        deletedRequestStats = this.database()
          .prepare(`DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`)
          .run(...identities).changes;
      }
      const deletedAccounts = this.database()
        .prepare('DELETE FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
        .run(target).changes;
      return {
        ssoUser: target,
        matchedAccounts: accounts.length,
        deletedAccounts,
        deletedRequestStats,
      };
    })();
  }

  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    const now = nowIso();
    this.database()
      .prepare(`
        INSERT INTO proxy_accounts (
          identity, sso_user, gh_login, copilot_oauth_status, copilot_oauth_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          sso_user = excluded.sso_user,
          gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
          updated_at = excluded.updated_at
      `)
      .run(
        input.identity,
        input.ssoUser,
        input.ghLogin,
        input.copilotOauthStatus ?? 'missing',
        input.copilotOauthAttemptId,
        now,
        now,
      );
    return (await this.getAccount(input.identity))!;
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const now = nowIso();
    this.database()
      .prepare(`
        INSERT INTO proxy_accounts (
          identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
          copilot_oauth_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          sso_user = excluded.sso_user,
          gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
          copilot_oauth_token = excluded.copilot_oauth_token,
          copilot_oauth_status = 'valid',
          copilot_oauth_updated_at = excluded.copilot_oauth_updated_at,
          copilot_oauth_attempt_id = NULL,
          updated_at = excluded.updated_at
      `)
      .run(input.identity, input.ssoUser, input.ghLogin, input.copilotOauthToken, now, now, now);
    return (await this.getAccount(input.identity))!;
  }

  async saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined> {
    const now = nowIso();
    const result = this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_token = ?, gh_login = COALESCE(?, gh_login),
            copilot_oauth_status = 'valid', copilot_oauth_updated_at = ?,
            copilot_oauth_attempt_id = NULL, updated_at = ?
        WHERE identity = ? AND copilot_oauth_attempt_id = ?
      `)
      .run(copilotOauthToken, ghLogin, now, now, identity, oauthAttemptId);
    return result.changes > 0 ? this.getAccount(identity) : undefined;
  }

  async markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
    this.database()
      .prepare('UPDATE proxy_accounts SET copilot_oauth_status = ?, updated_at = ? WHERE identity = ?')
      .run(status, nowIso(), identity);
  }

  async beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_status = 'refreshing', copilot_oauth_attempt_id = ?, updated_at = ?
        WHERE identity = ?
      `)
      .run(oauthAttemptId, nowIso(), identity).changes > 0;
  }

  async failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_status = 'failed', updated_at = ?
        WHERE identity = ? AND copilot_oauth_attempt_id = ?
      `)
      .run(nowIso(), identity, oauthAttemptId).changes > 0;
  }

  async invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean> {
    const now = nowIso();
    return this.database()
      .prepare(`
        UPDATE proxy_accounts
        SET copilot_oauth_token = NULL, copilot_oauth_status = ?,
            copilot_oauth_updated_at = ?, copilot_oauth_attempt_id = NULL, updated_at = ?
        WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
      `)
      .run(status, now, now, identity, expectedToken).changes > 0;
  }

  async claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return this.database()
      .prepare(`
        INSERT INTO proxy_identity_initializations (
          identity, claim_id, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          claim_id = excluded.claim_id,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
        WHERE proxy_identity_initializations.lease_expires_at <= excluded.updated_at
      `)
      .run(identity, claimId, leaseExpiresAt, now, now).changes > 0;
  }

  async releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
    return this.database()
      .prepare('DELETE FROM proxy_identity_initializations WHERE identity = ? AND claim_id = ?')
      .run(identity, claimId).changes > 0;
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    this.database()
      .prepare(`
        INSERT INTO proxy_request_stats (
          id, identity, gh_login, requested_at, path, model, success, failure_reason,
          input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newRequestId(),
        input.identity,
        input.ghLogin,
        nowIso(),
        input.path,
        input.model,
        input.success ? 1 : 0,
        input.failureReason,
        input.inputTokens,
        input.outputTokens,
        input.cacheTokens,
        input.cacheInputTokens,
        input.cacheWriteTokens,
      );
    this.pruneStats(input.identity);
  }

  async listRequestStats(identity?: string, limit = 100): Promise<ProxyRequestStatDto[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const rows = identity
      ? this.database()
          .prepare('SELECT * FROM proxy_request_stats WHERE identity = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(identity, boundedLimit)
      : this.database()
          .prepare('SELECT * FROM proxy_request_stats ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(boundedLimit);
    return (rows as StatRow[]).map(mapStatRow);
  }

  async pruneAllRequestStats(): Promise<void> {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE id IN (
          SELECT id
          FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY identity
                ORDER BY requested_at DESC, id DESC
              ) AS retention_rank
            FROM proxy_request_stats
          )
          WHERE retention_rank > ?
        )
      `)
      .run(this.requestStatsPerAccountLimit);
  }

  private pruneStats(identity: string): void {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE identity = ?
          AND id NOT IN (
            SELECT id FROM proxy_request_stats
            WHERE identity = ?
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
          )
      `)
      .run(identity, identity, this.requestStatsPerAccountLimit);
  }

  private database(): Database.Database {
    if (!this.db) throw new Error('SQLite storage has not been initialized.');
    return this.db;
  }
}

function mapAccountRow(row: AccountRow): ProxyAccountRecord {
  return {
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    copilotOauthToken: row.copilot_oauth_token ?? undefined,
    copilotOauthStatus: row.copilot_oauth_status,
    copilotOauthUpdatedAt: row.copilot_oauth_updated_at ?? undefined,
    copilotOauthAttemptId: row.copilot_oauth_attempt_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    id: row.id,
    identity: row.identity,
    ghLogin: row.gh_login,
    requestedAt: row.requested_at,
    path: row.path,
    model: row.model,
    success: row.success === 1,
    failureReason: row.failure_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    cacheInputTokens: row.cache_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}

function sortColumn(sort: AccountListQuery['sort']): string {
  switch (sort) {
    case 'identity':
      return 'identity';
    case 'ssoUser':
      return 'sso_user';
    case 'ghLogin':
      return 'gh_login';
    case 'copilotOauthStatus':
      return 'copilot_oauth_status';
    case 'createdAt':
      return 'created_at';
    default:
      return 'updated_at';
  }
}
