import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { HttpApiError, type LoginAttemptDto } from '@ghcp/shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { AccountLogger } from './accountLogger.js';

export async function resolveAttemptLog(attempt: LoginAttemptDto): Promise<string | undefined> {
  if (!attempt.logPath || attempt.historyIncomplete) return undefined;
  try {
    const expected = AccountLogger.pathFor(config.logDir, attempt.ssoUser, `${attempt.taskId}-${attempt.id}`);
    const [root, file, owned, info] = await Promise.all([
      realpath(config.logDir), realpath(attempt.logPath), realpath(expected), lstat(attempt.logPath),
    ]);
    const path = relative(root, file);
    if (file !== owned || info.isSymbolicLink() || path.startsWith('..') || isAbsolute(path)) {
      throw new HttpApiError(409, 'invalid_log_owner', 'The log is not an isolated file owned by this attempt.');
    }
    const shared = getDb().prepare('SELECT 1 FROM login_task_attempts WHERE log_path IN (?, ?) AND id != ?')
      .get(attempt.logPath, file, attempt.id)
      ?? getDb().prepare('SELECT 1 FROM login_tasks WHERE log_path IN (?, ?) AND id != ?').get(attempt.logPath, file, attempt.taskId);
    if (shared) throw new HttpApiError(409, 'shared_log', 'This log is referenced by another task or attempt and cannot be managed as an isolated log.');
    return file;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
