import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { HttpApiError, type CreateLoginTaskRequest, type LoginTaskDto } from '@ghcp/shared';

test('lost Login responses reconcile accepted tasks and roll back rejected attempts without touching committed tokens', async (t) => {
  let task: LoginTaskDto | undefined;
  let lookupAvailable = true;
  let commit: ((payload: CreateLoginTaskRequest) => Promise<void>) | undefined;
  const app = express();
  app.use(express.json());
  app.post('/api/tasks', async (req, res) => {
    const payload = req.body as CreateLoginTaskRequest;
    task = { id: `task-${payload.identity}`, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, ssoType: payload.ssoType, oauthAttemptId: payload.oauthAttemptId, status: 'pending', attempts: 0, createdAt: new Date().toISOString() };
    await commit?.(payload);
    res.socket?.destroy();
  });
  app.get('/api/tasks/by-attempt/:attemptId', (_req, res) => {
    if (lookupAvailable) res.json(task);
    else res.status(503).json({ error: { code: 'unavailable', message: 'Fixture unavailable' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.STORAGE_DRIVER = 'sqlite';
  process.env.LOGIN_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { copilotAuthManager } = await import('../copilot/copilotAuthManager.js');
  const { createAccount, deleteAccount, getAccount, saveCopilotOauthToken } = await import('../db/accountsRepo.js');
  const credentials = { credentialMode: 'override' as const, ssoPassword: 'fixture-only-password' };
  for (const identity of ['accepted', 'uncertain', 'committed']) await createAccount({ identity, ssoUser: identity, ghLogin: `${identity}-gh` });
  assert.equal((await copilotAuthManager.triggerOauthRefresh('accepted', credentials)).id, 'task-accepted');
  assert.equal((await getAccount('accepted'))?.copilotOauthStatus, 'refreshing');

  lookupAvailable = false;
  await assert.rejects(copilotAuthManager.triggerOauthRefresh('uncertain', credentials), (error: unknown) => error instanceof HttpApiError && error.code === 'login_submission_unconfirmed');
  const uncertain = await getAccount('uncertain');
  assert.equal(uncertain?.copilotOauthStatus, 'failed', 'A submission Proxy could not confirm does not leave the account refreshing');
  assert.equal(uncertain?.copilotOauthAttemptId, task!.oauthAttemptId, 'The failed attempt stays recorded so a retry can name it');
  assert.equal(await saveCopilotOauthToken('uncertain', task!.oauthAttemptId!, 'late-fixture-token'), undefined, 'A late token for the failed attempt is refused');

  commit = async (payload) => { await saveCopilotOauthToken(payload.identity, payload.oauthAttemptId, 'committed-fixture-token'); };
  await assert.rejects(copilotAuthManager.triggerOauthRefresh('committed', credentials), (error: unknown) => error instanceof HttpApiError && error.code === 'login_submission_unconfirmed');
  const committed = await getAccount('committed');
  assert.equal(committed?.copilotOauthToken, 'committed-fixture-token', 'The rollback is fenced on the attempt id and never undoes a committed token');
  assert.equal(committed?.copilotOauthStatus, 'valid');
  lookupAvailable = true;
  commit = async (payload) => { await deleteAccount(payload.identity); };
  await createAccount({ identity: 'removed', ssoUser: 'removed', ghLogin: 'removed-gh' });
  const { adminApiRouter } = await import('../routes/adminApi.js');
  const proxy = express();
  proxy.use(express.json());
  proxy.use('/api', adminApiRouter);
  const proxyServer = proxy.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => proxyServer.once('listening', resolve));
  t.after(() => { proxyServer.closeAllConnections(); return new Promise<void>((resolve) => proxyServer.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}/api/accounts/removed/copilot-oauth/reauthorize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'account_removed_after_submission');
});
