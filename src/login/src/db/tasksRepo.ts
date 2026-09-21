import type { LoginAttemptDto, LoginTaskDto, LoginTaskStatus, ManagementQuery, ManagementSummary, PageResponse, SsoType } from '@ghcp/shared';
import { HttpApiError, LIKE_ESCAPE_CLAUSE, likeContains, newTaskId, nowIso, pageResponse } from '@ghcp/shared';
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
  stage?: string;
  stage_updated_at?: string;
  queued_at?: string;
  failure_code?: string;
}

export function createTask(input: {
  identity: string;
  ssoUser: string;
  ghLogin: string;
  oauthAttemptId: string;
  ssoType: SsoType;
  logPath?: string;
}): LoginTaskRecord {
  const existing = getTaskByAttempt(input.oauthAttemptId);
  if (existing) {
    if (existing.oauthAttemptId !== input.oauthAttemptId || existing.identity !== input.identity || existing.ssoUser !== input.ssoUser || existing.ghLogin !== input.ghLogin || existing.ssoType !== input.ssoType) {
      throw new HttpApiError(409, 'attempt_conflict', 'The authorization attempt belongs to a different account mapping.');
    }
    return existing;
  }
  const id = newTaskId();
  const now = nowIso();
  getDb().transaction(() => {
    if (getDb().prepare("SELECT 1 FROM login_tasks WHERE identity = ? AND status IN ('pending', 'running', 'cancelling')").get(input.identity)) {
      throw new HttpApiError(409, 'task_already_active', 'This account already has an active login task.');
    }
    getDb()
      .prepare(`
      INSERT INTO login_tasks (
        id, identity, sso_user, gh_login, oauth_attempt_id, sso_type, status, attempts, log_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `)
      .run(id, input.identity, input.ssoUser, input.ghLogin, input.oauthAttemptId, input.ssoType, input.logPath, now);
    getDb().prepare("UPDATE login_tasks SET queued_at = ?, stage = 'queued', stage_updated_at = ? WHERE id = ?").run(now, now, id);
    getDb().prepare(`
    INSERT INTO login_task_attempts (id, task_id, attempt_number, status, stage, stage_updated_at, queued_at)
    VALUES (?, ?, 1, 'pending', 'queued', ?, ?)
  `).run(input.oauthAttemptId, id, now, now);
  })();
  return getTask(id)!;
}

export function getTask(id: string): LoginTaskRecord | undefined {
  const row = getDb().prepare('SELECT * FROM login_tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function getTaskByAttempt(attemptId: string): LoginTaskRecord | undefined {
  const row = getDb().prepare('SELECT task_id FROM login_task_attempts WHERE id = ?').get(attemptId) as { task_id: string } | undefined;
  const attempt = row ? listAttempts(row.task_id).find((entry) => entry.id === attemptId) : undefined;
  return attempt ? { ...attempt, id: attempt.taskId } : undefined;
}

export function listTasks(limit = 100): LoginTaskRecord[] {
  return (getDb().prepare('SELECT * FROM login_tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]).map(mapRow);
}

export function listTasksPage(query: ManagementQuery = {}, database = getDb()): PageResponse<LoginTaskRecord> {
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const requestedPage = Math.max(1, Math.trunc(query.page ?? 1));
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.ids?.length) { where.push(`id IN (${query.ids.map(() => '?').join(',')})`); args.push(...query.ids); }
  const q = query.q?.trim();
  if (q) {
    where.push(`(id LIKE ? ${LIKE_ESCAPE_CLAUSE} OR identity LIKE ? ${LIKE_ESCAPE_CLAUSE} OR sso_user LIKE ? ${LIKE_ESCAPE_CLAUSE} OR gh_login LIKE ? ${LIKE_ESCAPE_CLAUSE} OR failure_reason LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
    args.push(...Array.from({ length: 5 }, () => likeContains(q)));
  }
  let statuses: string[] | undefined;
  if (query.status) {
    statuses = query.status.split(',');
    if (statuses.some((status) => !['pending', 'running', 'cancelling', 'success', 'failed', 'cancelled'].includes(status))) {
      throw new HttpApiError(400, 'invalid_status', 'Unknown login task status.');
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (query.from) { where.push('created_at >= ?'); args.push(query.from); }
  if (query.to) { where.push('created_at < ?'); args.push(query.to); }
  if (query.identity) { where.push('identity = ?'); args.push(query.identity); }
  if (query.minAttempts !== undefined) { where.push('attempts >= ?'); args.push(query.minAttempts); }
  if (query.failureCode) { where.push('failure_code = ?'); args.push(query.failureCode); }
  if (query.finishedBefore) { where.push('finished_at < ?'); args.push(query.finishedBefore); }
  // Both age filters imply a status of their own, so combining them can only ever match nothing.
  // Say so instead of silently returning an empty page that looks like "no stuck tasks".
  if (query.minWaitSeconds !== undefined && query.minRunSeconds !== undefined) {
    throw new HttpApiError(400, 'invalid_query', 'minWaitSeconds and minRunSeconds cannot be combined: a task is either waiting in the queue or running.');
  }
  const requireStatus = (key: string, allowed: string[]) => {
    if (statuses && !statuses.some((status) => allowed.includes(status))) {
      throw new HttpApiError(400, 'invalid_query', `${key} only matches ${allowed.join('/')} tasks and cannot be combined with status=${statuses.join(',')}.`);
    }
  };
  if (query.minWaitSeconds !== undefined) {
    requireStatus('minWaitSeconds', ['pending']);
    where.push("status = 'pending' AND stage = 'queued' AND queued_at <= ?");
    args.push(new Date((query.asOf ? Date.parse(query.asOf) : Date.now()) - query.minWaitSeconds * 1000).toISOString());
  }
  if (query.minRunSeconds !== undefined) {
    requireStatus('minRunSeconds', ['running', 'cancelling']);
    where.push("status IN ('running', 'cancelling') AND started_at <= ?");
    args.push(new Date((query.asOf ? Date.parse(query.asOf) : Date.now()) - query.minRunSeconds * 1000).toISOString());
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (database.prepare(`SELECT COUNT(*) AS count FROM login_tasks ${whereSql}`).get(...args) as { count: number }).count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const sorts: Record<string, string> = { createdAt: 'created_at', queuedAt: 'queued_at', startedAt: 'started_at', finishedAt: 'finished_at', attempts: 'attempts', status: 'status' };
  const sortKey = query.sort ?? 'createdAt';
  const sort = Object.hasOwn(sorts, sortKey) ? sorts[sortKey] : undefined;
  if (!sort) throw new HttpApiError(400, 'invalid_sort', 'Unknown login task sort field.');
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = database
    .prepare(`SELECT * FROM login_tasks ${whereSql} ORDER BY ${sort} ${dir}, id ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as TaskRow[];
  return pageResponse(rows.map(mapRow), total, page, pageSize);
}

export function reserveRetry(task: LoginTaskRecord, attemptId: string): LoginTaskRecord {
  return getDb().transaction(() => {
    const active = getDb().prepare("SELECT id FROM login_tasks WHERE identity = ? AND status IN ('pending', 'running', 'cancelling')").get(task.identity);
    if (active) throw new HttpApiError(409, 'task_already_active', 'This account already has an active login task.');
    const now = nowIso();
    const result = getDb().prepare(`
      UPDATE login_tasks SET oauth_attempt_id = ?, status = 'pending', stage = 'preparing', stage_updated_at = ?,
        queued_at = ?, started_at = NULL, finished_at = NULL, failure_reason = NULL, failure_code = NULL, log_path = NULL
      WHERE id = ? AND status = 'failed' AND oauth_attempt_id IS ? AND stage IS NOT 'deleting'
    `).run(attemptId, now, now, task.id, task.oauthAttemptId ?? null);
    if (!result.changes) throw new HttpApiError(409, 'task_changed', 'The task changed or is not failed. Refresh before retrying.');
    getDb().prepare(`
      INSERT INTO login_task_attempts (id, task_id, attempt_number, status, stage, stage_updated_at, queued_at)
      SELECT ?, ?, COALESCE(MAX(attempt_number), 0) + 1, 'pending', 'preparing', ?, ?
      FROM login_task_attempts WHERE task_id = ?
    `).run(attemptId, task.id, now, now, task.id);
    return getTask(task.id)!;
  })();
}

export function setStage(id: string, attemptId: string, stage: string): void {
  const now = nowIso();
  getDb().transaction(() => {
    const result = getDb().prepare(`
      UPDATE login_tasks SET stage = ?, stage_updated_at = ?
      WHERE id = ? AND oauth_attempt_id = ? AND status IN ('pending', 'running', 'cancelling')
    `).run(stage, now, id, attemptId);
    if (result.changes) getDb().prepare('UPDATE login_task_attempts SET stage = ?, stage_updated_at = ? WHERE id = ?').run(stage, now, attemptId);
  })();
}

export function markRunning(id: string, logPath: string, attemptId = getTask(id)?.oauthAttemptId): LoginTaskRecord | undefined {
  if (!attemptId) return undefined;
  return getDb().transaction(() => {
    const now = nowIso();
    const result = getDb()
      .prepare(`
      UPDATE login_tasks
      SET status = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL,
          failure_reason = NULL, log_path = ?
      WHERE id = ? AND oauth_attempt_id = ? AND status = 'pending'
    `)
      .run(now, logPath, id, attemptId);
    if (!result.changes) return undefined;
    getDb().prepare("UPDATE login_task_attempts SET status = 'running', started_at = ?, log_path = ? WHERE id = ?").run(now, logPath, attemptId);
    return getTask(id)!;
  })();
}

export function markSuccess(id: string, attemptId = getTask(id)?.oauthAttemptId): LoginTaskRecord | undefined {
  return finishAttempt(id, attemptId, 'success');
}

export function markFailed(id: string, reason: string, attemptId = getTask(id)?.oauthAttemptId, code = 'login_failed'): LoginTaskRecord | undefined {
  return finishAttempt(id, attemptId, 'failed', reason, code);
}

export function requestCancellation(id: string): LoginTaskRecord | undefined {
  getDb().transaction(() => {
    getDb().prepare("UPDATE login_tasks SET status = 'cancelling' WHERE id = ? AND status IN ('pending', 'running')").run(id);
    const task = getTask(id);
    if (task?.status === 'cancelling' && task.oauthAttemptId) {
      getDb().prepare("UPDATE login_task_attempts SET status = 'cancelling' WHERE id = ?").run(task.oauthAttemptId);
    }
  })();
  return getTask(id);
}

export function markCancelled(id: string, attemptId = getTask(id)?.oauthAttemptId): LoginTaskRecord | undefined {
  return finishAttempt(id, attemptId, 'cancelled', 'Cancelled by request.', 'cancelled');
}

function finishAttempt(id: string, attemptId: string | undefined, status: 'success' | 'failed' | 'cancelled', reason?: string, code?: string): LoginTaskRecord | undefined {
  if (!attemptId) return getTask(id);
  getDb().transaction(() => {
    const now = nowIso();
    const result = getDb().prepare(`
      UPDATE login_tasks SET status = ?, finished_at = ?, failure_reason = ?, failure_code = ?, stage = ?, stage_updated_at = ?
      WHERE id = ? AND oauth_attempt_id = ? AND status IN ('pending', 'running', 'cancelling')
    `).run(status, now, reason ?? null, code ?? null, status, now, id, attemptId);
    if (result.changes) getDb().prepare(`
      UPDATE login_task_attempts SET status = ?, finished_at = ?, failure_reason = ?, failure_code = ?, stage = ?, stage_updated_at = ? WHERE id = ?
    `).run(status, now, reason ?? null, code ?? null, status, now, attemptId);
  })();
  return getTask(id);
}

export function listAttempts(id: string): LoginAttemptDto[] {
  const task = getTask(id);
  if (!task) return [];
  const rows = getDb().prepare('SELECT * FROM login_task_attempts WHERE task_id = ? ORDER BY attempt_number DESC').all(id) as Array<{
    id: string; attempt_number: number; status: LoginTaskStatus; stage?: string; stage_updated_at?: string; queued_at: string;
    started_at?: string; finished_at?: string; failure_reason?: string; failure_code?: string; log_path?: string; history_incomplete: number;
  }>;
  return rows.map((row) => ({
    ...task, id: row.id, taskId: id, oauthAttemptId: row.history_incomplete && row.id === `legacy-${id}` ? undefined : row.id, attemptNumber: row.attempt_number,
    status: row.status, stage: row.stage ?? undefined, stageUpdatedAt: row.stage_updated_at ?? undefined, queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined, failureReason: row.failure_reason ?? undefined,
    failureCode: row.failure_code ?? undefined, logPath: row.log_path ?? undefined, historyIncomplete: Boolean(row.history_incomplete),
  }));
}

export function summarizeTasks(): ManagementSummary {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS count FROM login_tasks GROUP BY status').all() as Array<{ status: string; count: number }>;
  return { total: rows.reduce((sum, row) => sum + row.count, 0), counts: Object.fromEntries(rows.map((row) => [row.status, row.count])), updatedAt: nowIso() };
}

export function deleteTask(id: string): 'deleted' | 'not_found' | 'not_allowed' {
  const task = getTask(id);
  if (!task) return 'not_found';
  if (task.status === 'pending' || task.status === 'running' || task.status === 'cancelling') return 'not_allowed';
  return getDb().prepare("DELETE FROM login_tasks WHERE id = ? AND status IN ('success', 'failed', 'cancelled')").run(id).changes
    ? 'deleted' : 'not_allowed';
}

export function claimTaskDeletion(id: string): 'claimed' | 'not_found' | 'not_allowed' {
  if (!getTask(id)) return 'not_found';
  // Remember the stage being overwritten: a failed delete must not erase the diagnostic stage that
  // tells an operator why the task ended up in this state.
  const changed = getDb().prepare(`
    UPDATE login_tasks SET prior_stage = stage, stage = 'deleting' WHERE id = ? AND status IN ('success', 'failed', 'cancelled') AND stage IS NOT 'deleting'
  `).run(id).changes;
  return changed ? 'claimed' : 'not_allowed';
}

export function releaseTaskDeletion(id?: string): void {
  getDb().prepare(`UPDATE login_tasks SET stage = COALESCE(prior_stage, status), prior_stage = NULL WHERE stage = 'deleting' AND status IN ('success', 'failed', 'cancelled')${id ? ' AND id = ?' : ''}`)
    .run(...(id ? [id] : []));
}

export function listUnfinishedTasks(): LoginTaskRecord[] {
  return (getDb().prepare("SELECT * FROM login_tasks WHERE status IN ('pending', 'running', 'cancelling')").all() as TaskRow[]).map(mapRow);
}

export function failLegacyInterruptedTask(id: string): void {
  getDb().transaction(() => {
    const now = nowIso();
    const changed = getDb().prepare(`
    UPDATE login_tasks SET status = 'failed', failure_code = 'service_interrupted',
      failure_reason = 'Legacy task interrupted; start a new authorization from the account.', finished_at = ?
    WHERE id = ? AND oauth_attempt_id IS NULL AND status IN ('pending', 'running', 'cancelling')
  `).run(now, id).changes;
    if (changed) getDb().prepare(`
    UPDATE login_task_attempts SET status = 'failed', stage = 'failed', failure_code = 'service_interrupted',
      failure_reason = 'Legacy task interrupted; start a new authorization from the account.', finished_at = ?
    WHERE task_id = ? AND status IN ('pending', 'running', 'cancelling')
  `).run(now, id);
  })();
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
    failureReason: row.failure_reason ?? undefined,
    logPath: row.log_path ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    stage: row.stage ?? undefined,
    stageUpdatedAt: row.stage_updated_at ?? undefined,
    queuedAt: row.queued_at ?? undefined,
    failureCode: row.failure_code ?? undefined,
  };
}
