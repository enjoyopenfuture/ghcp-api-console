import { randomUUID } from 'node:crypto';
import { HttpApiError, loggerFor, redactSecrets, type CreateLoginTaskRequest, type LoginCredentials, type LoginTaskDto } from '@ghcp/shared';
import { markCopilotOauthFailed, prepareLoginRetry } from '../clients/proxyClient.js';
import { getTask, markFailed, reserveRetry } from '../db/tasksRepo.js';
import { loginQueue } from './queue.js';

const logger = loggerFor('login', 'retry');

export async function retryTask(id: string, credentials: LoginCredentials, overrides: Pick<CreateLoginTaskRequest, 'ssoUrl' | 'accountType' | 'selectorOverrides'> = {}): Promise<LoginTaskDto> {
  const task = getTask(id);
  if (!task) throw new HttpApiError(404, 'task_not_found', 'Login task was not found.');
  if (loginQueue.isBusy(id)) throw new HttpApiError(409, 'task_already_active', 'The previous attempt is still finishing. Wait for its queue slot to be released before retrying.');
  const attemptId = randomUUID();
  // `task` still carries the attempt the account should point at; `reserveRetry` moves the task on.
  const reserved = reserveRetry(task, attemptId);
  try {
    const request = { ...await prepareLoginRetry(reserved, attemptId, credentials, task.oauthAttemptId ?? null), ...overrides };
    const current = getTask(id);
    if (current?.status === 'cancelling') return loginQueue.cancel(id)!;
    if (!current || current.status !== 'pending' || current.oauthAttemptId !== attemptId) {
      // The task was cancelled (or otherwise closed) while Proxy was preparing the attempt, so the
      // attempt Proxy just switched to will never run; release it instead of leaving it refreshing.
      await releaseAttempt(task.identity, id, attemptId, 'Retry was cancelled before it started.');
      return current ?? reserved;
    }
    return loginQueue.retry(reserved, request);
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), credentials.credentialMode === 'override' ? [credentials.ssoPassword] : []);
    const current = getTask(id);
    if (current?.status === 'cancelling') return loginQueue.cancel(id)!;
    if (current?.status === 'cancelled') return current;
    markFailed(id, message, attemptId, err instanceof HttpApiError ? err.code : 'retry_failed');
    // Fenced on the attempt id at Proxy: a no-op unless preparation already switched the account.
    await releaseAttempt(task.identity, id, attemptId, message);
    throw new HttpApiError(err instanceof HttpApiError ? err.status : 502, err instanceof HttpApiError ? err.code : 'retry_failed', message);
  }
}

async function releaseAttempt(identity: string, taskId: string, attemptId: string, reason: string): Promise<void> {
  try {
    await markCopilotOauthFailed(identity, attemptId, reason);
  } catch (err) {
    logger.error('retry-cleanup-failed', 'Could not report the abandoned retry attempt to Proxy; reauthorize the account if it stays refreshing', {
      taskId, attemptId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
