import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { csvCell, HttpApiError, OperationManager, readLoginCredentials, readManagementQuery, redactSecrets, resolveOperationSelection, type OperationItem } from '@ghcp/shared';

test('attempt history survives retries and old callbacks cannot change the current attempt', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const repo = await import('./tasksRepo.js');
  const firstId = randomUUID();
  const task = repo.createTask({ identity: 'history-user', ssoUser: 'history-user', ghLogin: 'history-user-gh', oauthAttemptId: firstId, ssoType: 'custom' });
  repo.markRunning(task.id, '/not-a-real-log', firstId);
  repo.markFailed(task.id, 'first failure', firstId);
  const secondId = randomUUID();
  const retried = repo.reserveRetry(repo.getTask(task.id)!, secondId);
  assert.equal(retried.id, task.id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.stage, 'preparing');
  assert.equal(retried.failureReason, undefined);
  assert.equal(repo.listAttempts(task.id).find((attempt) => attempt.id === firstId)?.failureReason, 'first failure');
  assert.equal(repo.getTaskByAttempt(firstId)?.status, 'failed');
  assert.equal(repo.getTaskByAttempt(firstId)?.oauthAttemptId, firstId);
  assert.equal(repo.createTask({ identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin!, oauthAttemptId: firstId, ssoType: task.ssoType }).id, task.id);
  assert.equal(repo.getTask(task.id)?.oauthAttemptId, secondId);
  assert.throws(() => repo.reserveRetry(retried, randomUUID()), /already has an active/);
  repo.markSuccess(task.id, firstId);
  assert.equal(repo.getTask(task.id)?.status, 'pending');
  repo.markRunning(task.id, '/another-test-log', secondId);
  assert.equal(repo.getTask(task.id)?.attempts, 2);
  repo.requestCancellation(task.id);
  assert.equal(repo.deleteTask(task.id), 'not_allowed');
  repo.markCancelled(task.id, secondId);
  repo.markSuccess(task.id, secondId);
  assert.equal(repo.getTask(task.id)?.status, 'cancelled');
  assert.equal(repo.listAttempts(task.id).length, 2);
});

test('operations run once per preview, stay readable afterwards and expire when unconfirmed', async () => {
  const manager = new OperationManager('tasks');
  const preview = await manager.preview('delete', ['one', 'two'], async (id) => id === 'two' ? 'not terminal' : undefined);
  assert.equal(preview.items[1]?.status, 'skipped');
  let executed = 0;
  const perform = async (_action: string, item: OperationItem) => {
    executed++;
    await delay(5);
    return { ...item, status: 'success' as const };
  };
  const [first, second] = [manager.execute(preview.id, perform), manager.execute(preview.id, perform)];
  assert.equal(first, second, 'A concurrent second confirmation returns the accepted operation instead of running it again');
  for (let count = 0; count < 100 && manager.get(preview.id)?.status !== 'completed'; count++) await delay(5);
  assert.equal(manager.get(preview.id)?.status, 'completed');
  assert.equal(executed, 1);
  assert.equal(manager.execute(preview.id, perform).status, 'completed');
  assert.equal(executed, 1);
  assert.equal(new OperationManager('users').get(preview.id), undefined, 'Operations are scoped per manager');

  const expired = await manager.preview('delete', ['three'], async () => undefined);
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => manager.execute(expired.id, perform), (error: unknown) => error instanceof HttpApiError && error.code === 'operation_not_found', 'An expired preview cannot be confirmed');
  assert.equal(manager.get(expired.id), undefined, 'Expired previews are dropped on the next read');
  assert.throws(() => manager.execute(randomUUID(), perform), (error: unknown) => error instanceof HttpApiError && error.code === 'operation_not_found');

  const list = async (query: { page?: number; pageSize?: number }) => {
    const start = ((query.page ?? 1) - 1) * 100;
    return { items: Array.from({ length: Math.min(100, 1001 - start) }, (_, index) => ({ id: String(start + index) })), total: 1001, page: query.page ?? 1, pageSize: 100 };
  };
  await assert.rejects(resolveOperationSelection({ query: {} }, list, (item) => item.id), /More than 1000/);
  const ids = await resolveOperationSelection({ query: {}, excludedIds: ['0'] }, list, (item) => item.id);
  assert.equal(ids.length, 1000);
  assert.equal(ids.includes('0'), false);
});

test('query and credential validation is explicit and secret redaction includes escaped values', () => {
  assert.deepEqual(readLoginCredentials({ credentialMode: 'default', ssoPassword: 'ignored' }), { credentialMode: 'default' });
  assert.throws(() => readLoginCredentials({ credentialMode: 'override', ssoPassword: '' }), HttpApiError);
  assert.throws(() => readManagementQuery({ pageSize: '101' }), /outside/);
  assert.throws(() => readManagementQuery({ pageSize: true }), /integer/);
  assert.equal(csvCell('\n=SUM(1,2)'), '"\'\n=SUM(1,2)"');
  assert.equal(csvCell('  @formula'), '"\'  @formula"');
  assert.throws(() => readManagementQuery({ from: 'invalid' }), /ISO/);
  assert.throws(() => readManagementQuery({ from: '2026-02-02', to: '2026-02-01' }), /before/);
  const secret = 'fixture"password\nvalue';
  assert.equal(redactSecrets(`fill(${JSON.stringify(secret)})`, [secret]).includes('fixture'), false);
});

test('batch concurrency is bounded and item failures are classified without stopping the batch', async () => {
  const manager = new OperationManager('users');
  const preview = await manager.preview('sync_emu', ['a', 'b', 'c', 'd', 'e'], async () => undefined);
  let active = 0;
  let peak = 0;
  manager.execute(preview.id, async (_action, item) => {
    peak = Math.max(peak, ++active);
    await delay(10);
    active--;
    if (item.id === 'c') throw new HttpApiError(409, 'task_already_active', 'busy');
    if (item.id === 'd') throw new Error('downstream exploded');
    return { ...item, status: 'success' };
  }, undefined, undefined, 2);
  for (let count = 0; count < 100 && manager.get(preview.id)?.status === 'running'; count++) await delay(5);
  assert.equal(peak, 2);
  const result = manager.get(preview.id)!;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.items.map((item) => item.status), ['success', 'success', 'skipped', 'failed', 'success']);
  assert.match(result.items[3]?.detail ?? '', /downstream exploded/);
});
