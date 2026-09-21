import { errorFields, loggerFor } from '@ghcp/shared';
import { markCopilotOauthFailed } from '../clients/proxyClient.js';
import { failLegacyInterruptedTask, listUnfinishedTasks, markCancelled, markFailed, releaseTaskDeletion, type LoginTaskRecord } from '../db/tasksRepo.js';

const logger = loggerFor('login', 'recovery');
const INTERRUPTED_REASON = 'Login service restarted before this attempt completed. No work was replayed.';

/**
 * Closes out whatever a previous process left unfinished. Nothing is replayed: the browser session
 * and device code of an interrupted attempt are gone, so the task is failed (or, when a cancel was
 * pending, cancelled) and Proxy is told to drop the attempt so the account does not stay `refreshing`.
 * If the token write had already landed, Proxy ignores that report because the attempt id no longer
 * matches; the account keeps its token and only the task history shows the interruption.
 */
export function recoverLoginOutcomes(): void {
  releaseTaskDeletion();
  const unfinished = listUnfinishedTasks();
  logger.info('recover', 'Closing tasks interrupted by a restart', { tasks: unfinished.length });
  const notify: LoginTaskRecord[] = [];
  for (const task of unfinished) {
    if (!task.oauthAttemptId) { failLegacyInterruptedTask(task.id); continue; }
    if (task.status === 'cancelling') markCancelled(task.id, task.oauthAttemptId);
    else markFailed(task.id, INTERRUPTED_REASON, task.oauthAttemptId, 'service_interrupted');
    notify.push(task);
  }
  void releaseProxyAttempts(notify);
}

async function releaseProxyAttempts(tasks: LoginTaskRecord[]): Promise<void> {
  // Sequential on purpose: a restart with a large backlog must not burst onto Proxy.
  for (const task of tasks) {
    try {
      await markCopilotOauthFailed(task.identity, task.oauthAttemptId!, INTERRUPTED_REASON);
    } catch (err) {
      logger.error('proxy-status-sync-failed', 'Could not report the interrupted attempt to Proxy; reauthorize the account if it stays refreshing', {
        taskId: task.id, identity: task.identity, attemptId: task.oauthAttemptId, ...errorFields(err),
      });
    }
  }
}
