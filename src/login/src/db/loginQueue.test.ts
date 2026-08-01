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
