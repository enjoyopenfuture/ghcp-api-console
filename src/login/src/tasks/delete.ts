import { unlink } from 'node:fs/promises';
import { HttpApiError, loggerFor } from '@ghcp/shared';
import { claimTaskDeletion, deleteTask, listAttempts, releaseTaskDeletion } from '../db/tasksRepo.js';
import { resolveAttemptLog } from './taskLogs.js';

const logger = loggerFor('login', 'task-cleanup');

export async function deleteLoginTask(id: string) {
  const claimed = claimTaskDeletion(id);
  if (claimed !== 'claimed') return claimed;
  try {
    const paths = await Promise.all(listAttempts(id).map(resolveAttemptLog));
    for (const file of paths) {
      if (!file) continue;
      try { await unlink(file); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        logger.error('log-cleanup-failed', 'Log cleanup stopped; task records were retained for explicit retry', { taskId: id, path: file, error: err instanceof Error ? err.message : String(err) });
        throw new HttpApiError(500, 'log_cleanup_failed', 'Some logs could not be removed. Task history was retained; retry cleanup after resolving the filesystem error.');
      }
    }
    return deleteTask(id);
  } finally { releaseTaskDeletion(id); }
}
