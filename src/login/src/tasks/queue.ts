import type { CreateLoginTaskRequest, LoginQueueDto } from '@ghcp/shared';
import { errorFields, loggerFor, redactSecrets } from '@ghcp/shared';
import { markCancelled, markFailed, requestCancellation, setStage, createTask, getTask, listUnfinishedTasks, type LoginTaskRecord } from '../db/tasksRepo.js';
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
  requestCancellation: typeof requestCancellation;
  listUnfinishedTasks: typeof listUnfinishedTasks;
  markFailed: typeof markFailed;
}

const defaultDependencies: LoginQueueDependencies = {
  createTask,
  getTask,
  markCancelled,
  runLoginTask,
  markCopilotOauthFailed,
  getConcurrency: () => loginRuntimeSettings.getSnapshot().concurrency,
  requestCancellation,
  listUnfinishedTasks,
  markFailed,
};

export class LoginQueue {
  private readonly logger = loggerFor('login', 'queue');
  private readonly pending: RuntimeTaskPayload[] = [];
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly cancelling = new Set<string>();
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
    if (this.isBusy(task.id) || task.status !== 'pending' || task.stage !== 'queued') return task;
    this.pending.push({ ...request, taskId: task.id });
    this.logger.info('enqueue', 'Queued login task', { taskId: task.id, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin, ssoType: task.ssoType, pending: this.pending.length });
    this.drain();
    return task;
  }

  retry(task: LoginTaskRecord, request: CreateLoginTaskRequest): LoginTaskRecord {
    const current = this.dependencies.getTask(task.id);
    if (!current || current.status !== 'pending' || current.oauthAttemptId !== request.oauthAttemptId) return current ?? task;
    if (this.active.has(task.id) || this.pending.some((item) => item.taskId === task.id)) return this.dependencies.getTask(task.id)!;
    setStage(task.id, request.oauthAttemptId, 'queued');
    this.pending.push({ ...request, taskId: task.id });
    this.logger.info('retry', 'Queued login task retry', { taskId: task.id, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin, pending: this.pending.length });
    this.drain();
    return this.dependencies.getTask(task.id)!;
  }

  isBusy(id: string): boolean {
    return this.active.has(id) || this.pending.some((item) => item.taskId === id);
  }

  cancel(id: string): LoginTaskRecord | undefined {
    const task = this.dependencies.requestCancellation(id);
    if (!task || task.status !== 'cancelling' || !task.oauthAttemptId) return task;
    this.cancelled.add(`${id}:${task.oauthAttemptId}`);
    const index = this.pending.findIndex((item) => item.taskId === id);
    if (index !== -1) this.pending.splice(index, 1);
    this.controllers.get(id)?.abort(new DOMException('Login task cancelled.', 'AbortError'));
    if (!this.cancelling.has(id)) {
      this.cancelling.add(id);
      void this.finishCancellation(task).finally(() => this.cancelling.delete(id));
    }
    this.logger.info('cancel', 'Cancelled login task', { taskId: id, status: task?.status });
    return task;
  }

  /**
   * Waits for the aborted run to release its browser and device code, then closes the task out.
   * The runner may still finish successfully in that window (the token write was already in flight);
   * in that case the success stands and nothing is reported to Proxy.
   */
  private async finishCancellation(task: LoginTaskRecord): Promise<void> {
    const attemptId = task.oauthAttemptId!;
    try {
      await this.completions.get(task.id);
      const current = this.dependencies.getTask(task.id);
      if (current?.status !== 'cancelling' || current.oauthAttemptId !== attemptId) return;
      this.dependencies.markCancelled(task.id, attemptId);
      // Fenced on the attempt id at Proxy: a token that landed before the abort is kept.
      await this.dependencies.markCopilotOauthFailed(task.identity, attemptId, 'Cancelled by request.');
    } catch (err) {
      this.logger.error('proxy-status-sync-failed', 'Could not report the cancelled attempt to Proxy; reauthorize the account if it stays refreshing', { taskId: task.id, attemptId, ...errorFields(err) });
    } finally {
      // Always release the guard key: leaving it behind leaks one entry per cancelled attempt.
      this.cancelled.delete(`${task.id}:${attemptId}`);
    }
  }

  snapshot(): LoginQueueDto {
    const tasks = this.dependencies.listUnfinishedTasks();
    const pending = this.pending.map((item) => item.taskId);
    const positions = new Map(pending.map((id, index) => [id, index + 1]));
    const now = Date.now();
    const items = tasks.map((task) => ({
      taskId: task.id, identity: task.identity, status: task.status, stage: task.stage, stageUpdatedAt: task.stageUpdatedAt,
      position: positions.get(task.id),
      waitMs: Math.max(0, (task.startedAt ? Date.parse(task.startedAt) : now) - Date.parse(task.queuedAt ?? task.createdAt)),
      runMs: task.startedAt ? Math.max(0, now - Date.parse(task.startedAt)) : undefined,
    }));
    return {
      concurrency: this.dependencies.getConcurrency(),
      preparing: tasks.filter((task) => task.stage === 'preparing').map((task) => task.id),
      pending,
      active: [...this.active],
      cancelling: tasks.filter((task) => task.status === 'cancelling').map((task) => task.id),
      longestWaitMs: items.reduce((longest, item) => item.position === undefined ? longest : Math.max(longest, item.waitMs), 0),
      items,
      updatedAt: new Date().toISOString(),
    };
  }

  onRuntimeSettingsUpdated(): void {
    this.drain();
  }

  private drain(): void {
    while (this.active.size < this.dependencies.getConcurrency() && this.pending.length > 0) {
      const payload = this.pending.shift()!;
      const task = this.dependencies.getTask(payload.taskId);
      if (!task || this.cancelled.has(`${payload.taskId}:${payload.oauthAttemptId}`) || task.oauthAttemptId !== payload.oauthAttemptId || task.status !== 'pending') continue;
      this.active.add(payload.taskId);
      const controller = new AbortController();
      this.controllers.set(payload.taskId, controller);
      this.logger.info('start', 'Starting login task', { taskId: payload.taskId, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, active: this.active.size });
      const completion = this.dependencies.runLoginTask(task, { ...payload, signal: controller.signal })
        .catch(async (err: unknown) => {
          if (controller.signal.aborted) return;
          const message = redactSecrets(err instanceof Error ? err.message : String(err), [payload.ssoPassword]);
          this.dependencies.markFailed(payload.taskId, message, payload.oauthAttemptId, 'runner_failed');
          this.logger.error('failed', 'Login task failed', { taskId: payload.taskId, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, error: message });
          try {
            await this.dependencies.markCopilotOauthFailed(
              payload.identity,
              payload.oauthAttemptId,
              message,
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
          this.controllers.delete(payload.taskId);
          this.completions.delete(payload.taskId);
          this.drain();
        });
      this.completions.set(payload.taskId, completion);
    }
  }
}

export const loginQueue = new LoginQueue();
