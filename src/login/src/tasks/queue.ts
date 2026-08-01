import type { CreateLoginTaskRequest } from '@ghcp/shared';
import { errorFields, loggerFor } from '@ghcp/shared';
import { markCancelled, createTask, getTask, type LoginTaskRecord } from '../db/tasksRepo.js';
import { loginRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import { markCopilotOauthFailed } from '../clients/proxyClient.js';
import { runLoginTask, type RuntimeTaskPayload } from './runner.js';

interface LoginQueueDependencies {
  createTask: typeof createTask;
  getTask: typeof getTask;
  markCancelled: typeof markCancelled;
  runLoginTask: typeof runLoginTask;
  markCopilotOauthFailed: typeof markCopilotOauthFailed;
  getConcurrency: () => number;
}

const defaultDependencies: LoginQueueDependencies = {
  createTask,
  getTask,
  markCancelled,
  runLoginTask,
  markCopilotOauthFailed,
  getConcurrency: () => loginRuntimeSettings.getSnapshot().concurrency,
};

export class LoginQueue {
  private readonly logger = loggerFor('login', 'queue');
  private readonly pending: RuntimeTaskPayload[] = [];
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly dependencies: LoginQueueDependencies;

  constructor(dependencies: Partial<LoginQueueDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  enqueue(request: CreateLoginTaskRequest): LoginTaskRecord {
    const task = this.dependencies.createTask({
      identity: request.identity,
      ssoUser: request.ssoUser,
      ghLogin: request.ghLogin,
      oauthAttemptId: request.oauthAttemptId,
      ssoType: request.ssoType,
    });
    this.pending.push({ ...request, taskId: task.id });
    this.logger.info('enqueue', 'Queued login task', { taskId: task.id, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin, ssoType: task.ssoType, pending: this.pending.length });
    this.drain();
    return task;
  }

  retry(task: LoginTaskRecord, request: CreateLoginTaskRequest): LoginTaskRecord {
    this.pending.push({ ...request, taskId: task.id });
    this.logger.info('retry', 'Queued login task retry', { taskId: task.id, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin, pending: this.pending.length });
    this.drain();
    return this.dependencies.getTask(task.id)!;
  }

  cancel(id: string): LoginTaskRecord | undefined {
    this.cancelled.add(id);
    const index = this.pending.findIndex((item) => item.taskId === id);
    if (index !== -1) this.pending.splice(index, 1);
    const task = this.dependencies.markCancelled(id);
    this.logger.info('cancel', 'Cancelled login task', { taskId: id, status: task?.status });
    return task;
  }

  onRuntimeSettingsUpdated(): void {
    this.drain();
  }

  private drain(): void {
    while (this.active.size < this.dependencies.getConcurrency() && this.pending.length > 0) {
      const payload = this.pending.shift()!;
      const task = this.dependencies.getTask(payload.taskId);
      if (!task || this.cancelled.has(payload.taskId)) continue;
      this.active.add(payload.taskId);
      this.logger.info('start', 'Starting login task', { taskId: payload.taskId, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, active: this.active.size });
      void this.dependencies.runLoginTask(task, payload)
        .catch(async (err: unknown) => {
          this.logger.error('failed', 'Login task failed', { taskId: payload.taskId, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, ...errorFields(err) });
          try {
            await this.dependencies.markCopilotOauthFailed(
              payload.identity,
              payload.oauthAttemptId,
              err instanceof Error ? err.message : String(err),
            );
          } catch (syncErr) {
            this.logger.error('proxy-status-sync-failed', 'Failed to mark Copilot OAuth authorization failed in Proxy', {
              taskId: payload.taskId,
              identity: payload.identity,
              ...errorFields(syncErr),
            });
          }
        })
        .finally(() => {
          this.logger.info('finish', 'Login task finished', { taskId: payload.taskId, identity: payload.identity, ghLogin: payload.ghLogin });
          this.active.delete(payload.taskId);
          this.drain();
        });
    }
  }
}

export const loginQueue = new LoginQueue();
