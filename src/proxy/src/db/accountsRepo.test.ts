import assert from 'node:assert/strict';
import test from 'node:test';

test('only invalidates the credential and authorization attempt that are still current', async () => {
  process.env.DB_PATH = ':memory:';
  const {
    createAccount,
    beginCopilotOauthAuthorization,
    failCopilotOauthAuthorization,
    getAccount,
    invalidateCopilotOauthToken,
    saveCopilotOauthToken,
  } = await import('./accountsRepo.js');

  createAccount({ identity: 'alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
  assert.equal(beginCopilotOauthAuthorization('alice', 'attempt-1'), true);
  saveCopilotOauthToken('alice', 'attempt-1', 'new-token', 'alice_octo');

  assert.equal(invalidateCopilotOauthToken('alice', 'stale-token', 'expired'), false);
  assert.deepEqual(
    pickAuth(getAccount('alice')),
    { token: 'new-token', status: 'valid' },
  );
  assert.equal(failCopilotOauthAuthorization('alice', 'stale-attempt'), false);
  assert.equal(getAccount('alice')?.copilotOauthStatus, 'valid');

  beginCopilotOauthAuthorization('alice', 'attempt-2');
  assert.equal(invalidateCopilotOauthToken('alice', 'new-token', 'expired'), false);
  assert.equal(getAccount('alice')?.copilotOauthStatus, 'refreshing');
  assert.equal(failCopilotOauthAuthorization('alice', 'attempt-2'), true);
  assert.equal(getAccount('alice')?.copilotOauthStatus, 'failed');

  beginCopilotOauthAuthorization('alice', 'attempt-3');
  assert.equal(saveCopilotOauthToken('alice', 'attempt-2', 'stale-token', 'alice_octo'), undefined);
  saveCopilotOauthToken('alice', 'attempt-3', 'new-token', 'alice_octo');
  assert.equal(invalidateCopilotOauthToken('alice', 'new-token', 'expired'), true);
  assert.deepEqual(
    pickAuth(getAccount('alice')),
    { token: undefined, status: 'expired' },
  );
});

function pickAuth(account: { copilotOauthToken?: string; copilotOauthStatus: string } | undefined): {
  token: string | undefined;
  status: string | undefined;
} {
  return {
    token: account?.copilotOauthToken,
    status: account?.copilotOauthStatus,
  };
}
