import { HttpApiError, operationRoutes, resolveOperationSelection, withSqliteReadSnapshot, type LoginCredentials, type OperationItem } from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import { getTask, listAttempts, listTasksPage } from '../db/tasksRepo.js';
import { deleteLoginTask } from '../tasks/delete.js';
import { loginQueue } from '../tasks/queue.js';
import { retryTask } from '../tasks/retry.js';

export const loginOperationsRouter = operationRoutes({
  scope: 'tasks',
  actions: ['retry', 'cancel', 'delete'],
  resolve: (selection) => withSqliteReadSnapshot(getDb(), (database) => resolveOperationSelection(selection, async (query) => listTasksPage(query, database), (task) => task.id)),
  async snapshot(id) {
    const task = getTask(id);
    return { revision: task?.oauthAttemptId ?? 'legacy', label: task ? `${task.identity} / ${task.ssoUser}` : id, requiresPasswordOverride: task?.ssoType === 'azure' };
  },
  async dedupeKey(action, id) { return action === 'retry' ? getTask(id)?.identity : undefined; },
  async eligibility(action, id) {
    const task = getTask(id);
    if (!task) return 'The task was removed.';
    if (action === 'retry' && task.status !== 'failed') return 'Only failed tasks can be retried.';
    if (action === 'retry' && loginQueue.isBusy(id)) return 'The previous attempt is still finishing. Wait for its queue slot to be released.';
    if (action === 'retry' && getDb().prepare("SELECT 1 FROM login_tasks WHERE identity = ? AND status IN ('pending', 'running', 'cancelling')").get(task.identity)) {
      return 'This account already has an active login attempt.';
    }
    if (action === 'cancel' && ['success', 'failed', 'cancelled'].includes(task.status)) return 'The task is already finished.';
    if (action === 'delete' && !['success', 'failed', 'cancelled'].includes(task.status)) return 'Active tasks cannot be deleted.';
    return undefined;
  },
  prepareExecution(input) {
    const overrides = new Map<string, string>();
    if (input.overrides !== undefined) {
      if (!Array.isArray(input.overrides) || input.overrides.length > 1000) throw new HttpApiError(400, 'invalid_overrides', 'Invalid password overrides.');
      for (const row of input.overrides) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.password !== 'string' || !row.password) {
          throw new HttpApiError(400, 'invalid_overrides', 'Each override needs a task ID and a nonempty password.');
        }
        overrides.set(row.id, row.password);
      }
    }
    return async (action, item): Promise<OperationItem> => {
      if (action === 'delete') {
        const result = await deleteLoginTask(item.id);
        if (result !== 'deleted') return { ...item, status: 'skipped', detail: result };
        return { ...item, status: 'success', detail: 'Task and attempt records deleted.' };
      }
      if (action === 'cancel') {
        const task = loginQueue.cancel(item.id);
        return { ...item, status: task?.status === 'cancelled' ? 'cancelled' : 'running', attemptId: task?.oauthAttemptId };
      }
      const password = overrides.get(item.id);
      overrides.delete(item.id);
      const credentials: LoginCredentials = password ? { credentialMode: 'override', ssoPassword: password } : { credentialMode: 'default' };
      const task = await retryTask(item.id, credentials);
      return { ...item, status: 'running', attemptId: task.oauthAttemptId, detail: 'Waiting for login completion.' };
    };
  },
  async refresh(item, action) {
    const attempt = listAttempts(item.id).find((entry) => entry.id === item.attemptId);
    if (!attempt) return { ...item, status: 'interrupted', detail: 'Attempt history is no longer available.' };
    if (action === 'cancel' && attempt.status === 'success') return { ...item, status: 'skipped', detail: 'Authorization already completed and was not rolled back.' };
    if (attempt.status === 'pending' || attempt.status === 'running' || attempt.status === 'cancelling') {
      return { ...item, status: 'running', detail: attempt.stage ?? attempt.status };
    }
    return { ...item, status: attempt.status, detail: attempt.failureReason ?? attempt.status };
  },
});
