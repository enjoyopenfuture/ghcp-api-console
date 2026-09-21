import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express from 'express';
import type { CreateLoginTaskRequest, ManagementOperation } from '@ghcp/shared';
import type { LoginTaskRecord } from '../db/tasksRepo.js';

test('batch retry uses server defaults and one-account overrides without persisting passwords', async (t) => {
  const received: Array<{ identity: string; mode: string; password?: string; attemptId: string }> = [];
  let prepared: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { prepared = resolve; });
  const preparation = new Promise<void>((resolve) => { release = resolve; });
  const proxy = express();
  proxy.use(express.json());
  proxy.post('/internal/accounts/:identity/oauth-attempts/:attemptId/prepare', async (req, res) => {
    received.push({ identity: req.params.identity, mode: req.body.credentialMode, password: req.body.ssoPassword, attemptId: req.params.attemptId });
    if (req.params.identity === 'cancel-during-prepare') { prepared!(); await preparation; }
    res.json({
      identity: req.params.identity, ssoUser: req.body.ssoUser, ghLogin: req.body.ghLogin, ssoType: req.body.ssoType,
      oauthAttemptId: req.params.attemptId, ssoPassword: req.body.ssoPassword ?? 'fixture-server-default',
    });
  });
  const releasedAtProxy: string[] = [];
  proxy.post('/internal/accounts/:identity/mark-copilot-oauth-failed', (req, res) => {
    releasedAtProxy.push(`${req.params.identity}:${req.body.oauthAttemptId}`);
    res.json({ identity: req.params.identity, copilotOauthStatus: 'failed' });
  });
  const proxyServer = proxy.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => proxyServer.once('listening', resolve));
  t.after(() => { proxyServer.closeAllConnections(); return new Promise<void>((resolve) => proxyServer.close(() => resolve())); });
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.PROXY_BASE_URL = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
  process.env.INTERNAL_API_TOKEN = 'fixture-internal-token';
  const { getDb } = await import('../db/connection.js');
  const repo = await import('../db/tasksRepo.js');
  const { loginQueue } = await import('../tasks/queue.js');
  const { buildApp } = await import('../server.js');
  t.mock.method(loginQueue, 'retry', (task: LoginTaskRecord, payload: CreateLoginTaskRequest) => {
    repo.markRunning(task.id, '/unavailable-fixture-log', payload.oauthAttemptId);
    repo.markSuccess(task.id, payload.oauthAttemptId);
    return repo.getTask(task.id)!;
  });
  const tasks = ['default-user', 'override-user'].map((identity) => {
    const task = repo.createTask({ identity, ssoUser: identity, ghLogin: `${identity}-gh`, ssoType: 'custom', oauthAttemptId: randomUUID() });
    repo.markFailed(task.id, 'initial failure', task.oauthAttemptId);
    return task;
  });
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/operations`;
  const headers = { 'Content-Type': 'application/json', 'X-Internal-Token': 'fixture-internal-token' };
  const previewResponse = await fetch(`${base}/preview`, { method: 'POST', headers, body: JSON.stringify({ action: 'retry', selection: { ids: tasks.map((task) => task.id) } }) });
  assert.equal(previewResponse.status, 201);
  const preview = await previewResponse.json() as ManagementOperation;
  assert.equal(preview.items.length, 2);
  assert.equal(JSON.stringify(preview).includes('fixture-server-default'), false);
  const body = { overrides: [{ id: tasks[1]!.id, password: 'fixture-account-override' }] };
  const execute = await fetch(`${base}/${preview.id}/execute`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(execute.status, 202);
  let finished = await execute.json() as ManagementOperation;
  for (let attempt = 0; attempt < 200 && finished.status === 'running'; attempt++) {
    await delay(10);
    finished = await (await fetch(`${base}/${preview.id}`, { headers })).json() as ManagementOperation;
  }
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.items.map((item) => item.status), ['success', 'success']);
  assert.equal(received.length, 2);
  const duplicates = Array.from({ length: 2 }, () => {
    const task = repo.createTask({ identity: 'duplicate-account', ssoUser: 'duplicate-account', ghLogin: 'duplicate-gh', ssoType: 'azure', oauthAttemptId: randomUUID() });
    repo.markFailed(task.id, 'Fixture failure', task.oauthAttemptId);
    return task.id;
  });
  const deduplicated = await (await fetch(`${base}/preview`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'retry', selection: { ids: duplicates } }),
  })).json() as ManagementOperation;
  assert.equal(deduplicated.items.filter((item) => item.status === 'pending').length, 1);
  assert.match(deduplicated.items.find((item) => item.status === 'skipped')!.detail!, /same account/);
  assert.equal(deduplicated.items[0]?.requiresPasswordOverride, true);
  const busy = t.mock.method(loginQueue, 'isBusy', (id: string) => id === duplicates[0]);
  const busyResponse = await fetch(`${base.replace('/operations', '')}/${duplicates[0]}/retry`, {
    method: 'POST', headers, body: JSON.stringify({ credentialMode: 'default' }),
  });
  assert.equal(busyResponse.status, 409);
  assert.equal(repo.listAttempts(duplicates[0]!).length, 1);
  busy.mock.restore();
  assert.equal(received[0]?.mode, 'default');
  assert.equal(received[0]?.password, undefined);
  assert.equal(received[1]?.password, 'fixture-account-override');
  assert.notEqual(received[0]?.attemptId, tasks[0]?.oauthAttemptId);
  assert.equal(repo.listAttempts(tasks[0]!.id).length, 2);
  const persisted = JSON.stringify(getDb().prepare('SELECT * FROM login_tasks').all())
    + JSON.stringify(getDb().prepare('SELECT * FROM login_task_attempts').all())
    + JSON.stringify(finished);
  assert.equal(persisted.includes('fixture-account-override'), false);
  assert.equal(persisted.includes('fixture-server-default'), false);
  const duplicate = await fetch(`${base}/${preview.id}/execute`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(duplicate.status, 202);
  assert.equal(received.length, 2);
  const cancelling = repo.createTask({ identity: 'cancel-during-prepare', ssoUser: 'cancel-user', ghLogin: 'cancel-gh', ssoType: 'custom', oauthAttemptId: randomUUID() });
  repo.markFailed(cancelling.id, 'Initial failure', cancelling.oauthAttemptId);
  const taskBase = base.replace('/operations', '');
  const retry = fetch(`${taskBase}/${cancelling.id}/retry`, { method: 'POST', headers, body: JSON.stringify({ credentialMode: 'default' }) });
  await entered;
  await fetch(`${taskBase}/${cancelling.id}/cancel`, { method: 'POST', headers });
  for (let index = 0; index < 100 && repo.getTask(cancelling.id)?.status !== 'cancelled'; index++) await delay(10);
  release!();
  assert.equal((await (await retry).json() as LoginTaskRecord).status, 'cancelled');
  assert.deepEqual(loginQueue.snapshot().pending, []);
  assert.equal(repo.getTask(cancelling.id)?.attempts, 0);
  const cancelledAttempt = repo.getTask(cancelling.id)?.oauthAttemptId;
  for (let index = 0; index < 100 && releasedAtProxy.filter((entry) => entry === `cancel-during-prepare:${cancelledAttempt}`).length < 1; index++) await delay(10);
  assert.ok(releasedAtProxy.includes(`cancel-during-prepare:${cancelledAttempt}`), 'The attempt Proxy prepared for a cancelled retry is released');
});
