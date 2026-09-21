import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

test('default credential resolution is internal, read-only and refuses changed passwords', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sso-credential-test-'));
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DB_PATH = ':memory:';
  process.env.SSO_DEFAULT_USER_PASSWORD = 'fixture-default-password';
  process.env.SSO_USER_EVENTS_LOG = join(directory, 'events.log');
  process.env.INTERNAL_API_TOKEN = 'fixture-internal-token';
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { createSsoUser } = await import('../users/service.js');
  const { countUsers } = await import('../db/usersRepo.js');
  const { requireInternalToken } = await import('../auth/internalAuth.js');
  const { loginCredentialsRouter } = await import('./loginCredentials.js');
  createSsoUser({ ssoUser: 'default-user' });
  createSsoUser({ ssoUser: 'changed-user', password: 'fixture-custom-password' });
  const app = express();
  app.use(express.json());
  app.use('/internal', requireInternalToken, loginCredentialsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, authenticated = true) => fetch(`${base}${path}`, {
    method: 'POST', headers: authenticated ? { 'X-Internal-Token': 'fixture-internal-token' } : {},
  });
  const denied = await request('/internal/users/default-user/login-credentials', false);
  assert.equal(denied.status, 401);
  const resolved = await request('/internal/users/default-user/login-credentials');
  assert.equal(resolved.status, 200);
  assert.equal(resolved.headers.get('cache-control'), 'no-store');
  assert.equal((await resolved.json() as { password: string }).password, 'fixture-default-password');
  const changed = await request('/internal/users/changed-user/login-credentials');
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { error: { code: string } }).error.code, 'password_override_required');
  assert.equal((await request('/internal/users/missing-user/login-credentials')).status, 404);
  assert.equal((await request('/api/users/default-user/login-credentials')).status, 404);
  assert.equal(countUsers(), 2);
});
