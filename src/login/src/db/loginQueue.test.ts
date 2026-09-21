import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreateLoginTaskRequest } from '@ghcp/shared';
import type { LoginTaskRecord } from './tasksRepo.js';
import { LoginQueue } from '../tasks/queue.js';

test('queue responds immediately to increased concurrency and honors decreases', async () => {
  let concurrency = 1;
  let taskNumber = 0;
  const tasks = new Map<string, LoginTaskRecord>();
  const started: string[] = [];
  const complete = new Map<string, () => void>();
  const queue = new LoginQueue({
    getConcurrency: () => concurrency,
    createTask: (input) => {
      const id = `task-${++taskNumber}`;
      const task: LoginTaskRecord = {
        id,
        identity: input.identity,
        ssoUser: input.ssoUser,
        ghLogin: input.ghLogin,
        oauthAttemptId: input.oauthAttemptId,
        ssoType: input.ssoType,
        status: 'pending',
        stage: 'queued',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      tasks.set(id, task);
      return task;
    },
    getTask: (id) => tasks.get(id),
    markCancelled: (id) => tasks.get(id),
    runLoginTask: async (_task, payload) => {
      started.push(payload.taskId);
      await new Promise<void>((resolve) => complete.set(payload.taskId, resolve));
    },
    markCopilotOauthFailed: async () => {},
  });

  const ids = Array.from({ length: 4 }, (_, index) => queue.enqueue(request(index)).id);
  assert.deepEqual(started, [ids[0]]);

  concurrency = 3;
  queue.onRuntimeSettingsUpdated();
  assert.deepEqual(started, ids.slice(0, 3));

  concurrency = 1;
  queue.onRuntimeSettingsUpdated();
  complete.get(ids[0])!();
  await settleQueue();
  assert.deepEqual(started, ids.slice(0, 3));
  complete.get(ids[1])!();
  await settleQueue();
  assert.deepEqual(started, ids.slice(0, 3));
  complete.get(ids[2])!();
  await settleQueue();
  assert.deepEqual(started, ids);
  complete.get(ids[3])!();
  await settleQueue();
});

function request(index: number): CreateLoginTaskRequest {
  return {
    identity: `identity-${index}`,
    ssoUser: `user-${index}`,
    ssoPassword: 'secret',
    ghLogin: `github-${index}`,
    oauthAttemptId: `attempt-${index}`,
    ssoType: 'custom',
  };
}

async function settleQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const outcome of ['cancelled', 'success'] as const) {
  test(`cancellation aborts execution but waits for resource release; a run that still finishes keeps its ${outcome}`, async () => {
    const tasks = new Map<string, LoginTaskRecord>();
    const releasedAtProxy: string[] = [];
    let release: (() => void) | undefined;
    let aborted = false;
    const queue = new LoginQueue({
      getConcurrency: () => 1,
      createTask(input) {
        const task: LoginTaskRecord = { id: input.identity, ...input, status: 'pending', stage: 'queued', attempts: 0, createdAt: new Date().toISOString() };
        tasks.set(task.id, task);
        return task;
      },
      getTask: (id) => tasks.get(id),
      listUnfinishedTasks: () => [...tasks.values()].filter((task) => ['pending', 'running', 'cancelling'].includes(task.status)),
      requestCancellation(id) { const task = tasks.get(id); if (task && (task.status === 'pending' || task.status === 'running')) task.status = 'cancelling'; return task; },
      markCancelled(id) { const task = tasks.get(id)!; task.status = 'cancelled'; return task; },
      markCopilotOauthFailed: async (identity, attemptId) => { releasedAtProxy.push(`${identity}:${attemptId}`); },
      runLoginTask: async (task, payload) => {
        task.status = 'running';
        payload.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
        await new Promise<void>((resolve) => { release = resolve; });
        // The token write was already in flight when the abort arrived and it landed.
        if (outcome === 'success') task.status = 'success';
      },
    });
    const active = queue.enqueue(request(0));
    const waiting = queue.enqueue(request(1));
    queue.cancel(waiting.id);
    queue.cancel(active.id);
    await settleQueue();
    assert.equal(aborted, true);
    assert.equal(waiting.status, 'cancelled');
    assert.deepEqual(releasedAtProxy, ['identity-1:attempt-1'], 'A waiting task is released at Proxy immediately');
    assert.equal(active.status, 'cancelling');
    assert.equal(queue.snapshot().active.length, 1);
    assert.deepEqual(queue.snapshot().pending, []);
    release!();
    await settleQueue();
    await settleQueue();
    assert.equal(active.status, outcome);
    assert.equal(queue.snapshot().active.length, 0);
    assert.deepEqual(releasedAtProxy, outcome === 'cancelled' ? ['identity-1:attempt-1', 'identity-0:attempt-0'] : ['identity-1:attempt-1'],
      'Proxy is told to drop the attempt only when the run did not finish on its own');
  });
}
