import type { CopilotOauthStatus, DeleteProxyAccountResult, PageResponse, ProxyAccountDto } from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';

export interface ProxyAccountRecord {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  copilotOauthAttemptId?: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface AccountListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'copilotOauthStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export function listAccounts(query: AccountListQuery = {}): PageResponse<ProxyAccountRecord> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const where = q ? 'WHERE identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const sort = sortColumn(query.sort);
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM proxy_accounts ${where}`).get(...args) as { count: number }).count;
  const rows = getDb()
    .prepare(`SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as AccountRow[];
  return pageResponse(rows.map(mapRow), total, page, pageSize);
}

export function getAccount(identity: string): ProxyAccountRecord | undefined {
  const row = getDb().prepare('SELECT * FROM proxy_accounts WHERE identity = ?').get(identity) as AccountRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function deleteAccount(identity: string): DeleteProxyAccountResult | undefined {
  const target = identity.trim();
  if (!target) return undefined;
  return getDb().transaction(() => {
    const exists = getDb().prepare('SELECT 1 FROM proxy_accounts WHERE identity = ?').get(target);
    if (!exists) return undefined;
    const deletedRequestStats = getDb()
      .prepare('DELETE FROM proxy_request_stats WHERE identity = ?')
      .run(target).changes;
    const deletedAccount = getDb()
      .prepare('DELETE FROM proxy_accounts WHERE identity = ?')
      .run(target).changes;
    if (deletedAccount !== 1) throw new Error(`Failed to delete Proxy account "${target}".`);
    return { identity: target, deletedRequestStats };
  })();
}

export function deleteAccountsBySsoUser(ssoUser: string): DeleteAccountsBySsoUserResult {
  const target = ssoUser.trim();
  if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
  return getDb().transaction(() => {
    const accounts = getDb()
      .prepare('SELECT identity FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
      .all(target) as Array<{ identity: string }>;
    const identities = accounts.map((account) => account.identity);
    let deletedRequestStats = 0;
    if (identities.length > 0) {
      const placeholders = identities.map(() => '?').join(', ');
      deletedRequestStats = getDb()
        .prepare(`DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`)
        .run(...identities).changes;
    }
    const deletedAccounts = getDb()
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

export function createAccount(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus?: CopilotOauthStatus;
  copilotOauthAttemptId?: string;
}): ProxyAccountRecord {
  const now = nowIso();
  getDb()
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
  return getAccount(input.identity)!;
}

export function importCopilotOauthToken(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
}): ProxyAccountRecord {
  const now = nowIso();
  getDb()
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
  return getAccount(input.identity)!;
}

export function saveCopilotOauthToken(
  identity: string,
  oauthAttemptId: string,
  copilotOauthToken: string,
  ghLogin?: string,
): ProxyAccountRecord | undefined {
  const now = nowIso();
  const result = getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = ?, gh_login = COALESCE(?, gh_login),
          copilot_oauth_status = 'valid', copilot_oauth_updated_at = ?,
          copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ?
    `)
    .run(copilotOauthToken, ghLogin, now, now, identity, oauthAttemptId);
  return result.changes > 0 ? getAccount(identity) : undefined;
}

export function markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): void {
  getDb()
    .prepare('UPDATE proxy_accounts SET copilot_oauth_status = ?, updated_at = ? WHERE identity = ?')
    .run(status, nowIso(), identity);
}

export function beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): boolean {
  return getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'refreshing', copilot_oauth_attempt_id = ?, updated_at = ?
      WHERE identity = ?
    `)
    .run(oauthAttemptId, nowIso(), identity).changes > 0;
}

export function failCopilotOauthAuthorization(
  identity: string,
  oauthAttemptId: string,
): boolean {
  return getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'failed', updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ?
    `)
    .run(nowIso(), identity, oauthAttemptId).changes > 0;
}

export function invalidateCopilotOauthToken(
  identity: string,
  expectedToken: string,
  status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
): boolean {
  const now = nowIso();
  return getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = NULL, copilot_oauth_status = ?,
          copilot_oauth_updated_at = ?, copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
    `)
    .run(status, now, now, identity, expectedToken).changes > 0;
}

export function toAccountDto(account: ProxyAccountRecord): ProxyAccountDto {
  return {
    identity: account.identity,
    ssoUser: account.ssoUser,
    ghLogin: account.ghLogin,
    copilotOauthStatus: account.copilotOauthStatus,
    copilotOauthUpdatedAt: account.copilotOauthUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function mapRow(row: AccountRow): ProxyAccountRecord {
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
