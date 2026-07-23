import { Router } from 'express';
import { apiError, type CreateLoginTaskRequest, type LoginTaskStatus } from '@ghcp/shared';
import { deleteTask, getTask, listTasks, listTasksPage } from '../db/tasksRepo.js';
import { loginQueue } from '../tasks/queue.js';

export const tasksApiRouter = Router();
const LOGIN_TASK_STATUSES = new Set<LoginTaskStatus>(['pending', 'running', 'success', 'failed', 'cancelled']);

tasksApiRouter.get('/tasks', (req, res) => {
  if (req.query.page !== undefined || req.query.pageSize !== undefined || req.query.q !== undefined || req.query.status !== undefined) {
    const status = stringQuery(req.query.status);
    if (status && !LOGIN_TASK_STATUSES.has(status as LoginTaskStatus)) {
      res.status(400).json(apiError('invalid_status', 'status is not a valid login task status.'));
      return;
    }
    res.json(listTasksPage({
      q: stringQuery(req.query.q),
      status: status as LoginTaskStatus | undefined,
      page: numberQuery(req.query.page),
      pageSize: numberQuery(req.query.pageSize),
    }));
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
  res.json(task);
});

tasksApiRouter.delete('/tasks/:id', (req, res) => {
  const result = deleteTask(req.params.id);
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

tasksApiRouter.post('/tasks/:id/retry', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  const parsed = readCreateTask({
    ...req.body,
    identity: task.identity,
    ssoUser: task.ssoUser,
    ghLogin: task.ghLogin,
    oauthAttemptId: task.oauthAttemptId,
    ssoType: task.ssoType,
  });
  if (!parsed.ok) {
    res.status(400).json(apiError('invalid_login_task', parsed.error));
    return;
  }
  res.status(202).json(loginQueue.retry(task, parsed.value));
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
  return value !== null && typeof value === 'object' && Object.values(value).every((v) => typeof v === 'string');
}

function stringQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const raw = typeof value === 'string' ? Number(value) : undefined;
  return Number.isFinite(raw) ? raw : undefined;
}
