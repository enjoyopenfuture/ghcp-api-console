import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';

test('a restart closes unfinished tasks, releases their attempts at Proxy and never replays work', async (t) => {
  const released: string[] = [];
  const app = express();
  app.use(express.json());
  app.post('/internal/accounts/:identity/mark-copilot-oauth-failed', (req, res) => {
    released.push(`${req.params.identity}:${req.body.oauthAttemptId}`);
    res.json({ identity: req.params.identity, copilotOauthStatus: 'failed' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.PROXY_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const repo = await import('./tasksRepo.js');
  const { getDb } = await import('./connection.js');
  const { runMigrations } = await import('./migrations.js');
  const { recoverLoginOutcomes } = await import('../tasks/recovery.js');
  const { loginQueue } = await import('../tasks/queue.js');
  const tasks = ['queued', 'executing', 'cancelling', 'finished'].map((identity) =>
    repo.createTask({ identity, ssoUser: identity, ghLogin: `${identity}-gh`, ssoType: 'custom', oauthAttemptId: randomUUID() }));
  repo.markRunning(tasks[1]!.id, '/fixture-unavailable-log', tasks[1]!.oauthAttemptId);
  repo.markRunning(tasks[2]!.id, '/fixture-unavailable-log', tasks[2]!.oauthAttemptId);
  repo.requestCancellation(tasks[2]!.id);
  repo.markRunning(tasks[3]!.id, '/fixture-unavailable-log', tasks[3]!.oauthAttemptId);
  repo.markSuccess(tasks[3]!.id, tasks[3]!.oauthAttemptId);
  repo.claimTaskDeletion(tasks[3]!.id);
  getDb().prepare("INSERT INTO login_tasks (id, identity, sso_user, sso_type, status, attempts, created_at) VALUES ('legacy-task', 'legacy', 'legacy', 'custom', 'pending', 0, ?)").run(new Date().toISOString());
  runMigrations(getDb());
  recoverLoginOutcomes();
  assert.equal(repo.listUnfinishedTasks().length, 0, 'Recovery settles every unfinished task synchronously');
  assert.deepEqual(tasks.map((task) => repo.getTask(task.id)?.status), ['failed', 'failed', 'cancelled', 'success']);
  assert.equal(repo.getTask(tasks[0]!.id)?.failureCode, 'service_interrupted');
  assert.equal(repo.getTask(tasks[0]!.id)?.attempts, 0, 'Nothing was replayed');
  assert.equal(repo.getTask(tasks[1]!.id)?.failureCode, 'service_interrupted');
  assert.equal(repo.getTask(tasks[3]!.id)?.stage, 'success', 'An interrupted delete claim is released');
  assert.equal(repo.getTask('legacy-task')?.failureCode, 'service_interrupted');
  assert.equal(repo.listAttempts('legacy-task')[0]?.status, 'failed');
  assert.equal(repo.listAttempts('legacy-task')[0]?.oauthAttemptId, undefined);
  for (let index = 0; index < 200 && released.length < 3; index++) await delay(10);
  assert.deepEqual(released.sort(), tasks.slice(0, 3).map((task) => `${task.identity}:${task.oauthAttemptId}`).sort(),
    'Proxy is asked to drop each interrupted attempt; legacy tasks without an attempt are not reported');
  assert.deepEqual(loginQueue.snapshot().pending, []);
  assert.deepEqual(loginQueue.snapshot().active, []);
});
