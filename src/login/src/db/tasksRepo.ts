import type { LoginTaskDto, LoginTaskStatus, PageResponse, SsoType } from '@ghcp/shared';
import { newTaskId, nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';

export interface LoginTaskRecord extends LoginTaskDto {
  ssoType: SsoType;
}

interface TaskRow {
  id: string;
  identity: string;
  sso_user: string;
  gh_login: string | null;
  oauth_attempt_id: string | null;
  sso_type: SsoType;
  status: LoginTaskStatus;
  attempts: number;
  failure_reason?: string;
  log_path?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

export function createTask(input: {
  identity: string;
  ssoUser: string;
  ghLogin: string;
  oauthAttemptId: string;
  ssoType: SsoType;
  logPath?: string;
}): LoginTaskRecord {
  const id = newTaskId();
  const now = nowIso();
  getDb()
    .prepare(`
      INSERT INTO login_tasks (
        id, identity, sso_user, gh_login, oauth_attempt_id, sso_type, status, attempts, log_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `)
    .run(id, input.identity, input.ssoUser, input.ghLogin, input.oauthAttemptId, input.ssoType, input.logPath, now);
  return getTask(id)!;
}

export function getTask(id: string): LoginTaskRecord | undefined {
  const row = getDb().prepare('SELECT * FROM login_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listTasks(limit = 100): LoginTaskRecord[] {
  return (getDb().prepare('SELECT * FROM login_tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]).map(mapRow);
}

export function listTasksPage(query: { q?: string; status?: LoginTaskStatus; page?: number; pageSize?: number } = {}): PageResponse<LoginTaskRecord> {
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const requestedPage = Math.max(1, Math.trunc(query.page ?? 1));
  const where: string[] = [];
  const args: unknown[] = [];
  const q = query.q?.trim();
  if (q) {
    where.push('(id LIKE ? OR identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ? OR failure_reason LIKE ?)');
    args.push(...Array.from({ length: 5 }, () => `%${q}%`));
  }
  if (query.status) {
    where.push('status = ?');
    args.push(query.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM login_tasks ${whereSql}`).get(...args) as { count: number }).count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const rows = getDb()
    .prepare(`SELECT * FROM login_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as TaskRow[];
  return pageResponse(rows.map(mapRow), total, page, pageSize);
}

export function markRunning(id: string, logPath: string): LoginTaskRecord {
  getDb()
    .prepare(`
      UPDATE login_tasks
      SET status = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL,
          failure_reason = NULL, log_path = ?
      WHERE id = ?
    `)
    .run(nowIso(), logPath, id);
  return getTask(id)!;
}

export function markSuccess(id: string): LoginTaskRecord {
  getDb().prepare("UPDATE login_tasks SET status = 'success', finished_at = ?, failure_reason = NULL WHERE id = ?").run(nowIso(), id);
  return getTask(id)!;
}

export function markFailed(id: string, reason: string): LoginTaskRecord {
  getDb()
    .prepare("UPDATE login_tasks SET status = 'failed', finished_at = ?, failure_reason = ? WHERE id = ?")
    .run(nowIso(), reason, id);
  return getTask(id)!;
}

export function markCancelled(id: string): LoginTaskRecord | undefined {
  const task = getTask(id);
  if (!task || task.status === 'success' || task.status === 'failed') return task;
  getDb()
    .prepare("UPDATE login_tasks SET status = 'cancelled', finished_at = ?, failure_reason = 'Cancelled by request.' WHERE id = ?")
    .run(nowIso(), id);
  return getTask(id);
}

export function deleteTask(id: string): 'deleted' | 'not_found' | 'not_allowed' {
  const task = getTask(id);
  if (!task) return 'not_found';
  if (task.status === 'pending' || task.status === 'running') return 'not_allowed';
  getDb().prepare('DELETE FROM login_tasks WHERE id = ?').run(id);
  return 'deleted';
}

export function recoverInterruptedTasks(): void {
  getDb()
    .prepare("UPDATE login_tasks SET status = 'failed', finished_at = ?, failure_reason = 'Login service restarted before task completed.' WHERE status IN ('pending', 'running')")
    .run(nowIso());
}

function mapRow(row: TaskRow): LoginTaskRecord {
  return {
    id: row.id,
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    oauthAttemptId: row.oauth_attempt_id ?? undefined,
    ssoType: row.sso_type,
    status: row.status,
    attempts: row.attempts,
    failureReason: row.failure_reason,
    logPath: row.log_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
