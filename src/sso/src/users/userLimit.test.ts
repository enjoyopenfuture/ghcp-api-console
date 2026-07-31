import assert from 'node:assert/strict';
import test from 'node:test';

test('enforces the SSO user limit while allowing updates and released capacity', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SSO_DEFAULT_USER_PASSWORD = 'configured-default';
  process.env.LOG_LEVEL = 'error';

  const { deleteUser, getUser, SsoUserLimitReachedError } = await import('../db/usersRepo.js');
  const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
  const { verifyPassword } = await import('../auth/password.js');
  const { createSsoUser, ensureUser, getSsoUserCapacity, importUsers } = await import('./service.js');
  updateSsoRuntimeSettings({ expectedVersion: 1, changes: { maxSsoUsers: 2 } });

  createSsoUser({ ssoUser: 'alice', password: 'initial' });
  createSsoUser({ ssoUser: 'bob' });
  const bob = getUser('bob')!;
  assert.equal(verifyPassword('configured-default', bob.passwordHash, bob.salt), true);

  assert.deepEqual(getSsoUserCapacity(), {
    current: 2,
    limit: 2,
    remaining: 0,
    reached: true,
  });
  assert.equal(ensureUser('alice@example.com', 'alice').passwordForLogin, undefined);
  assert.equal(ensureUser('bob@example.com', 'bob').passwordForLogin, 'configured-default');
  assert.throws(
    () => createSsoUser({ ssoUser: 'carol' }),
    (err: unknown) => err instanceof SsoUserLimitReachedError && err.current === 2 && err.limit === 2,
  );

  const imported = importUsers('ssoUser,password\nalice\ncarol,password');
  assert.equal(imported.summary.success, 1);
  assert.equal(imported.summary.failed, 1);
  assert.equal(imported.rows.find((row) => row.ssoUser === 'alice')?.status, 'unchanged');
  assert.equal(verifyPassword('initial', getUser('alice')!.passwordHash, getUser('alice')!.salt), true);
  assert.match(imported.rows.find((row) => row.ssoUser === 'carol')?.detail ?? '', /limit of 2 has been reached/);
  assert.equal(getUser('carol'), undefined);

  assert.equal(deleteUser('bob'), true);
  createSsoUser({ ssoUser: 'carol' });
  assert.equal(getUser('carol')?.ssoUser, 'carol');
  assert.deepEqual(getSsoUserCapacity(), {
    current: 2,
    limit: 2,
    remaining: 0,
    reached: true,
  });
});
