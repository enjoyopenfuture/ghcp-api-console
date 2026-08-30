import assert from 'node:assert/strict';
import test from 'node:test';

test('deletes one Proxy account and its request stats without affecting other identities', async () => {
  process.env.DB_PATH = ':memory:';
  const { createAccount, deleteAccount, getAccount } = await import('./accountsRepo.js');
  const { listRequestStats, recordRequestStat } = await import('./requestStatsRepo.js');

  await createAccount({ identity: 'alice', ssoUser: 'alice', ghLogin: 'alice_emu' });
  await createAccount({ identity: 'bob', ssoUser: 'bob', ghLogin: 'bob_emu' });
  await recordRequestStat({ identity: 'alice', path: '/v1/models', success: true });
  await recordRequestStat({ identity: 'bob', path: '/v1/models', success: true });

  assert.deepEqual(await deleteAccount('alice'), {
    identity: 'alice',
    deletedRequestStats: 1,
  });
  assert.equal(await getAccount('alice'), undefined);
  assert.notEqual(await getAccount('bob'), undefined);
  assert.equal((await listRequestStats('alice')).length, 0);
  assert.equal((await listRequestStats('bob')).length, 1);
  assert.equal(await deleteAccount('alice'), undefined);
});
