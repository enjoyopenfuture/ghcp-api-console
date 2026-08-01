import type { CopilotSeatOperation, CopilotSeatStatus, EmuStatus, PageResponse, SsoUserDto } from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';
import { readMaxSsoUsers } from './runtimeSettingsRepo.js';

export interface SsoUserRecord extends SsoUserDto {
  passwordHash: string;
  salt: string;
}

interface UserRow {
  sso_user: string;
  password_hash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  gh_login?: string;
  gh_scim_id?: string;
  emu_status: EmuStatus;
  copilot_seat_status: CopilotSeatStatus;
  copilot_seat_last_operation?: CopilotSeatOperation;
  copilot_seat_last_error?: string;
  copilot_seat_updated_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UserListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'ssoUser' | 'email' | 'role' | 'emuStatus' | 'createdAt';
  dir?: 'asc' | 'desc';
}

export class SsoUserLimitReachedError extends Error {
  constructor(
    readonly current: number,
    readonly limit: number,
  ) {
    super(`SSO user limit of ${limit} has been reached (${current} users currently exist).`);
    this.name = 'SsoUserLimitReachedError';
  }
}

export function listUsers(query: UserListQuery = {}): PageResponse<SsoUserDto> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const sort = sortColumn(query.sort);
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const where = q ? 'WHERE sso_user LIKE ? OR email LIKE ? OR gh_login LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM sso_users ${where}`).get(...args) as { count: number }).count;
  const rows = getDb()
    .prepare(`SELECT * FROM sso_users ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as UserRow[];
  return pageResponse(rows.map(mapRow).map(toDto), total, page, pageSize);
}

export function listAllUsers(): SsoUserRecord[] {
  return (getDb().prepare('SELECT * FROM sso_users ORDER BY sso_user ASC').all() as UserRow[]).map(mapRow);
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM sso_users').get() as { count: number }).count;
}

export function getUser(ssoUser: string): SsoUserRecord | undefined {
  const row = getDb().prepare('SELECT * FROM sso_users WHERE lower(sso_user) = lower(?)').get(ssoUser) as UserRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function getUserByGhLogin(ghLogin: string): SsoUserRecord | undefined {
  const trimmed = ghLogin.trim();
  if (!trimmed) return undefined;
  const row = getDb().prepare('SELECT * FROM sso_users WHERE gh_login = ? COLLATE NOCASE').get(trimmed) as UserRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function createUser(input: {
  ssoUser: string;
  passwordHash: string;
  salt: string;
  email: string;
  role?: 'user' | 'admin';
}): SsoUserRecord {
  const db = getDb();
  return db.transaction(() => {
    const current = countUsers();
    const limit = readMaxSsoUsers(db);
    if (limit !== null && current >= limit) {
      throw new SsoUserLimitReachedError(current, limit);
    }
    const now = nowIso();
    db.prepare(`
        INSERT INTO sso_users (sso_user, password_hash, salt, email, role, emu_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'not_synced', ?, ?)
      `)
      .run(input.ssoUser, input.passwordHash, input.salt, input.email, input.role ?? 'user', now, now);
    const created = getUser(input.ssoUser);
    if (!created) throw new Error(`Failed to read newly created SSO user "${input.ssoUser}".`);
    return created;
  }).immediate();
}

export function updateUser(ssoUser: string, patch: Partial<Pick<SsoUserRecord, 'email' | 'role' | 'passwordHash' | 'salt'>>): SsoUserRecord | undefined {
  const current = getUser(ssoUser);
  if (!current) return undefined;
  getDb()
    .prepare(`
      UPDATE sso_users
      SET email = ?, role = ?, password_hash = ?, salt = ?, updated_at = ?
      WHERE lower(sso_user) = lower(?)
    `)
    .run(
      patch.email ?? current.email,
      patch.role ?? current.role,
      patch.passwordHash ?? current.passwordHash,
      patch.salt ?? current.salt,
      nowIso(),
      ssoUser,
    );
  return getUser(ssoUser);
}

export function updateEmu(ssoUser: string, patch: { ghLogin?: string; ghScimId?: string; emuStatus: EmuStatus }): SsoUserRecord {
  getDb()
    .prepare(`
      UPDATE sso_users
      SET gh_login = ?, gh_scim_id = ?, emu_status = ?, updated_at = ?
      WHERE lower(sso_user) = lower(?)
    `)
    .run(patch.ghLogin, patch.ghScimId, patch.emuStatus, nowIso(), ssoUser);
  const user = getUser(ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

export function updateCopilotSeat(
  ssoUser: string,
  patch: {
    status: CopilotSeatStatus;
    lastOperation: CopilotSeatOperation;
    lastError?: string;
  },
): SsoUserRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      UPDATE sso_users
      SET copilot_seat_status = ?, copilot_seat_last_operation = ?, copilot_seat_last_error = ?,
          copilot_seat_updated_at = ?, updated_at = ?
      WHERE lower(sso_user) = lower(?)
    `)
    .run(patch.status, patch.lastOperation, patch.lastError ?? null, now, now, ssoUser);
  const user = getUser(ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

export function updateCopilotSeatFromGitHub(ssoUser: string, status: 'assigned' | 'unassigned'): SsoUserRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      UPDATE sso_users
      SET copilot_seat_status = ?, copilot_seat_last_operation = NULL, copilot_seat_last_error = NULL,
          copilot_seat_updated_at = ?, updated_at = ?
      WHERE lower(sso_user) = lower(?)
    `)
    .run(status, now, now, ssoUser);
  const user = getUser(ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

export function deleteUser(ssoUser: string): boolean {
  const result = getDb().prepare('DELETE FROM sso_users WHERE lower(sso_user) = lower(?)').run(ssoUser);
  return result.changes > 0;
}

export function toDto(user: SsoUserRecord): SsoUserDto {
  return {
    ssoUser: user.ssoUser,
    email: user.email,
    role: user.role,
    ghLogin: user.ghLogin,
    ghScimId: user.ghScimId,
    emuStatus: user.emuStatus,
    copilotSeatStatus: user.copilotSeatStatus,
    copilotSeatLastOperation: user.copilotSeatLastOperation,
    copilotSeatLastError: user.copilotSeatLastError,
    copilotSeatUpdatedAt: user.copilotSeatUpdatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function mapRow(row: UserRow): SsoUserRecord {
  return {
    ssoUser: row.sso_user,
    passwordHash: row.password_hash,
    salt: row.salt,
    email: row.email,
    role: row.role,
    ghLogin: row.gh_login,
    ghScimId: row.gh_scim_id,
    emuStatus: row.emu_status,
    copilotSeatStatus: row.copilot_seat_status ?? 'unknown',
    copilotSeatLastOperation: row.copilot_seat_last_operation,
    copilotSeatLastError: row.copilot_seat_last_error,
    copilotSeatUpdatedAt: row.copilot_seat_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sortColumn(sort: UserListQuery['sort']): string {
  switch (sort) {
    case 'email':
      return 'email';
    case 'role':
      return 'role';
    case 'emuStatus':
      return 'emu_status';
    case 'createdAt':
      return 'created_at';
    default:
      return 'sso_user';
  }
}
