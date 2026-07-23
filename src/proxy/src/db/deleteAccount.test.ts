import assert from 'node:assert/strict';
import test from 'node:test';

test('deletes one Proxy account and its request stats without affecting other identities', async () => {
  process.env.DB_PATH = ':memory:';
  const { getDb } = await import('./connection.js');
  const { createAccount, deleteAccount, getAccount } = await import('./accountsRepo.js');

  createAccount({ identity: 'alice', ssoUser: 'alice', ghLogin: 'alice_emu' });
  createAccount({ identity: 'bob', ssoUser: 'bob', ghLogin: 'bob_emu' });
  const insertStat = getDb().prepare(`
    INSERT INTO proxy_request_stats (id, identity, requested_at, path, success)
    VALUES (?, ?, ?, '/v1/models', 1)
  `);
  insertStat.run('alice-request', 'alice', '2026-07-23T00:00:00.000Z');
  insertStat.run('bob-request', 'bob', '2026-07-23T00:00:00.000Z');

  assert.deepEqual(deleteAccount('alice'), {
    identity: 'alice',
    deletedRequestStats: 1,
  });
  assert.equal(getAccount('alice'), undefined);
  assert.notEqual(getAccount('bob'), undefined);
  assert.equal(
    (getDb().prepare('SELECT COUNT(*) AS count FROM proxy_request_stats WHERE identity = ?').get('alice') as { count: number }).count,
    0,
  );
  assert.equal(
    (getDb().prepare('SELECT COUNT(*) AS count FROM proxy_request_stats WHERE identity = ?').get('bob') as { count: number }).count,
    1,
  );
  assert.equal(deleteAccount('alice'), undefined);
});
