import assert from 'node:assert/strict';
import test from 'node:test';

test('updates SSO runtime settings with validation and optimistic version checks', async () => {
  process.env.DB_PATH = ':memory:';
  const {
    getSsoRuntimeSettings,
    InvalidSsoRuntimeSettingsError,
    SsoSettingsVersionConflictError,
    updateSsoRuntimeSettings,
  } = await import('./runtimeSettingsRepo.js');

  const initial = getSsoRuntimeSettings();
  assert.equal(initial.version, 1);
  assert.equal(initial.maxSsoUsers, null);

  const updated = updateSsoRuntimeSettings({
    expectedVersion: initial.version,
    changes: {
      maxSsoUsers: 25,
      userPrefix: ' Team User ',
      emailDomain: 'EXAMPLE.COM',
      scimRequestDelayMs: 0,
    },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.maxSsoUsers, 25);
  assert.equal(updated.userPrefix, 'team-user');
  assert.equal(updated.emailDomain, 'example.com');
  assert.equal(updated.scimRequestDelayMs, 0);
  assert.equal(getSsoRuntimeSettings(), updated);

  assert.throws(
    () => updateSsoRuntimeSettings({ expectedVersion: 1, changes: { maxSsoUsers: null } }),
    (err: unknown) => err instanceof SsoSettingsVersionConflictError && err.currentVersion === 2,
  );
  assert.throws(
    () => updateSsoRuntimeSettings({ expectedVersion: 2, changes: { bulkSyncConcurrency: 0 } }),
    (err: unknown) => err instanceof InvalidSsoRuntimeSettingsError && Boolean(err.fields.bulkSyncConcurrency),
  );
  assert.throws(
    () => updateSsoRuntimeSettings({ expectedVersion: 2, changes: { userPrefix: '...', emailDomain: 'http://example.com' } }),
    (err: unknown) => err instanceof InvalidSsoRuntimeSettingsError
      && Boolean(err.fields.userPrefix)
      && Boolean(err.fields.emailDomain),
  );

  const unlimited = updateSsoRuntimeSettings({ expectedVersion: 2, changes: { maxSsoUsers: null } });
  assert.equal(unlimited.maxSsoUsers, null);
  assert.equal(unlimited.version, 3);
});
