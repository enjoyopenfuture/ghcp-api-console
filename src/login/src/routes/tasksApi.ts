import { Router } from 'express';
import { apiError, csvExport, HttpApiError, readLoginCredentials, readManagementQuery, withSqliteReadSnapshot, type CreateLoginTaskRequest } from '@ghcp/shared';
import { getTask, getTaskByAttempt, listAttempts, listTasks, listTasksPage, summarizeTasks } from '../db/tasksRepo.js';
import { loginQueue } from '../tasks/queue.js';
import { retryTask } from '../tasks/retry.js';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolveAttemptLog } from '../tasks/taskLogs.js';
import { deleteLoginTask } from '../tasks/delete.js';
import { getDb } from '../db/connection.js';

export const tasksApiRouter = Router();
tasksApiRouter.get('/tasks/summary', (_req, res) => res.json(summarizeTasks()));
tasksApiRouter.get('/queue', (_req, res) => res.json(loginQueue.snapshot()));
tasksApiRouter.get('/tasks/by-attempt/:attemptId', (req, res) => {
  const task = getTaskByAttempt(req.params.attemptId);
  if (!task) { res.status(404).json(apiError('task_not_found', 'No task was accepted for this authorization attempt.')); return; }
  res.json(task);
});
tasksApiRouter.route('/tasks/export').get(exportTasks()).post(exportTasks());
function exportTasks() {
  return csvExport('login-tasks',
    ['id', 'identity', 'ssoUser', 'ghLogin', 'status', 'stage', 'attempts', 'failure', 'createdAt', 'startedAt', 'finishedAt'],
    async (query) => listTasksPage(query),
    (task) => [task.id, task.identity, task.ssoUser, task.ghLogin, task.status, task.stage, task.attempts, task.failureReason, task.createdAt, task.startedAt, task.finishedAt],
    (_query, consume) => withSqliteReadSnapshot(getDb(), (database) => consume(async (query) => listTasksPage(query, database))),
  );
}

tasksApiRouter.get('/tasks/:id/attempts/:attemptId/log', async (req, res) => {
  const attempt = listAttempts(req.params.id).find((entry) => entry.id === req.params.attemptId);
  if (!attempt?.logPath || attempt.historyIncomplete) {
    res.status(404).json(apiError('log_unavailable', 'An isolated log is not available for this attempt.'));
    return;
  }
  try {
    const file = await resolveAttemptLog(attempt);
    if (!file) throw new HttpApiError(404, 'log_unavailable', 'This log has been removed.');
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.download === '1') {
      res.type('text/plain').attachment(`login-${attempt.id}.log`);
      await pipeline(createReadStream(file), res);
    } else {
      const handle = await open(file, 'r');
      try {
        const bytes = Buffer.alloc(20_001);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        res.json({ content: bytes.subarray(0, Math.min(bytesRead, 20_000)).toString('utf8'), truncated: bytesRead > 20_000 });
      } finally { await handle.close(); }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json(apiError('log_unavailable', 'This log has been removed.'));
      return;
    }
    throw err;
  }
});

tasksApiRouter.get('/tasks/:id/attempts', (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  res.json(listAttempts(req.params.id).map(({ logPath: _logPath, ...attempt }) => attempt));
});

tasksApiRouter.get('/tasks', (req, res) => {
  if (Object.keys(req.query).some((key) => key !== 'limit')) {
    try {
      res.json(listTasksPage(readManagementQuery(req.query)));
    } catch (err) {
      res.status(err instanceof HttpApiError ? err.status : 500)
        .json(apiError(err instanceof HttpApiError ? err.code : 'task_query_failed', err instanceof Error ? err.message : String(err)));
    }
    return;
  }
  const limit = Number(req.query.limit ?? 100);
  res.json(listTasks(Number.isInteger(limit) && limit > 0 ? limit : 100));
});

tasksApiRouter.post('/tasks', (req, res) => {
  const parsed = readCreateTask(req.body);
  if (!parsed.ok) {
    res.status(400).json(apiError('invalid_login_task', parsed.error));
    return;
  }
  res.status(202).json(loginQueue.enqueue(parsed.value));
});

tasksApiRouter.get('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  res.json(task);
});

tasksApiRouter.post('/tasks/:id/cancel', (req, res) => {
  const task = loginQueue.cancel(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  res.status(task.status === 'cancelling' ? 202 : 200).json(task);
});

tasksApiRouter.delete('/tasks/:id', async (req, res) => {
  const result = await deleteLoginTask(req.params.id);
  if (result === 'not_found') {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  if (result === 'not_allowed') {
    res.status(400).json(apiError('task_delete_not_allowed', 'Pending or running login tasks cannot be deleted.'));
    return;
  }
  res.status(204).end();
});

tasksApiRouter.post('/tasks/:id/retry', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  try {
    const body: Record<string, unknown> = req.body ?? {};
    if (body.ssoUrl !== undefined && typeof body.ssoUrl !== 'string') throw new HttpApiError(400, 'invalid_sso_url', 'ssoUrl must be a string.');
    if (body.selectorOverrides !== undefined && !isStringRecord(body.selectorOverrides)) throw new HttpApiError(400, 'invalid_selectors', 'selectorOverrides must contain strings.');
    if (body.accountType !== undefined && body.accountType !== 'business' && body.accountType !== 'enterprise') throw new HttpApiError(400, 'invalid_account_type', 'Invalid account type.');
    res.status(202).json(await retryTask(task.id, readLoginCredentials(body), {
      ...(typeof body.ssoUrl === 'string' && body.ssoUrl.trim() ? { ssoUrl: body.ssoUrl.trim() } : {}),
      ...(isStringRecord(body.selectorOverrides) ? { selectorOverrides: body.selectorOverrides } : {}),
      ...(body.accountType === 'business' || body.accountType === 'enterprise' ? { accountType: body.accountType } : {}),
    }));
  } catch (err) {
    const code = err instanceof HttpApiError ? err.code : 'retry_failed';
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof HttpApiError ? err.status : 502).json(apiError(code, message));
  }
});

type ParseResult = { ok: true; value: CreateLoginTaskRequest } | { ok: false; error: string };

function readCreateTask(body: unknown): ParseResult {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof value.identity !== 'string' || !value.identity.trim()) return { ok: false, error: 'identity is required.' };
  if (typeof value.ssoUser !== 'string' || !value.ssoUser.trim()) return { ok: false, error: 'ssoUser is required.' };
  if (typeof value.ghLogin !== 'string' || !value.ghLogin.trim()) return { ok: false, error: 'ghLogin is required.' };
  if (typeof value.oauthAttemptId !== 'string' || !value.oauthAttemptId.trim()) {
    return { ok: false, error: 'oauthAttemptId is required; start a new reauthorization for legacy tasks.' };
  }
  if (value.ssoType !== 'azure' && value.ssoType !== 'custom') return { ok: false, error: 'ssoType must be custom or azure.' };
  return {
    ok: true,
    value: {
      identity: value.identity.trim(),
      ssoUser: value.ssoUser.trim(),
      ssoPassword: typeof value.ssoPassword === 'string' ? value.ssoPassword : '',
      ghLogin: value.ghLogin.trim(),
      oauthAttemptId: value.oauthAttemptId.trim(),
      ssoType: value.ssoType,
      ssoUrl: typeof value.ssoUrl === 'string' && value.ssoUrl.trim() ? value.ssoUrl.trim() : undefined,
      accountType: value.accountType === 'business' || value.accountType === 'enterprise' ? value.accountType : undefined,
      selectorOverrides: isStringRecord(value.selectorOverrides) ? value.selectorOverrides : undefined,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}
