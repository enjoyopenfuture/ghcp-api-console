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

  await createAccount({ identity: 'alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
  assert.equal(await beginCopilotOauthAuthorization('alice', 'attempt-1'), true);
  await saveCopilotOauthToken('alice', 'attempt-1', 'new-token', 'alice_octo');

  assert.equal(await invalidateCopilotOauthToken('alice', 'stale-token', 'expired'), false);
  assert.deepEqual(
    pickAuth(await getAccount('alice')),
    { token: 'new-token', status: 'valid' },
  );
  assert.equal(await failCopilotOauthAuthorization('alice', 'stale-attempt'), false);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'valid');

  await beginCopilotOauthAuthorization('alice', 'attempt-2');
  assert.equal(await invalidateCopilotOauthToken('alice', 'new-token', 'expired'), false);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'refreshing');
  assert.equal(await failCopilotOauthAuthorization('alice', 'attempt-2'), true);
  assert.equal((await getAccount('alice'))?.copilotOauthStatus, 'failed');

  await beginCopilotOauthAuthorization('alice', 'attempt-3');
  assert.equal(await saveCopilotOauthToken('alice', 'attempt-2', 'stale-token', 'alice_octo'), undefined);
  await saveCopilotOauthToken('alice', 'attempt-3', 'new-token', 'alice_octo');
  assert.equal(await invalidateCopilotOauthToken('alice', 'new-token', 'expired'), true);
  assert.deepEqual(
    pickAuth(await getAccount('alice')),
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
