import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool, type RowDataPacket } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';

const mysqlUrl = process.env.MYSQL_TEST_URL;

test('provides MySQL repository parity and cross-instance claims', {
  skip: mysqlUrl ? false : 'Set MYSQL_TEST_URL to run MySQL integration tests.',
}, async () => {
  const firstPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const secondPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const thirdPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const fourthPool = createPool({
    uri: mysqlUrl!,
    connectionLimit: 3,
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: true,
  });
  const first = new MysqlStorage(firstPool, 2);
  const second = new MysqlStorage(secondPool, 2);
  const third = new MysqlStorage(thirdPool, 2);
  const fourth = new MysqlStorage(fourthPool, 2);
  const contenders = [first, second, third, fourth];
  try {
    await Promise.all(contenders.map((storage) => storage.initialize()));
    await clearTestData(firstPool);

    await first.createAccount({ identity: 'Alice', ssoUser: 'alice', ghLogin: 'alice_octo' });
    assert.equal((await second.getAccount('Alice'))?.ghLogin, 'alice_octo');
    assert.equal(await second.getAccount('alice'), undefined);
    assert.equal((await first.listAccounts({ q: 'ALICE' })).total, 1);

    assert.equal(await first.beginCopilotOauthAuthorization('Alice', 'attempt-1'), true);
    assert.equal(await second.saveCopilotOauthToken('Alice', 'stale-attempt', 'stale-token'), undefined);
    assert.equal((await second.saveCopilotOauthToken('Alice', 'attempt-1', 'CaseSensitiveToken'))?.copilotOauthStatus, 'valid');
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'stale-token', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'casesensitivetoken', 'expired'), false);
    assert.equal(await first.invalidateCopilotOauthToken('Alice', 'CaseSensitiveToken', 'expired'), true);

    const claims = await Promise.all([
      first.claimIdentityInitialization('new-user', 'claim-a', 60),
      second.claimIdentityInitialization('new-user', 'claim-b', 60),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winnerClaim = claims[0] ? 'claim-a' : 'claim-b';
    const winnerStorage = claims[0] ? first : second;
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', 'stale-claim'), false);
    assert.equal(await winnerStorage.releaseIdentityInitialization('new-user', winnerClaim), true);
    await firstPool.execute(`
      INSERT INTO proxy_identity_initializations (
        identity, claim_id, lease_expires_at, created_at, updated_at
      ) VALUES ('expired-user', 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000')
    `);
    assert.equal(await second.claimIdentityInitialization('expired-user', 'replacement-claim', 60), true);
    const [reclaimedRows] = await firstPool.query<Array<RowDataPacket & {
      claim_id: string;
      updated_at: string;
    }>>(
      'SELECT claim_id, updated_at FROM proxy_identity_initializations WHERE identity = ?',
      ['expired-user'],
    );
    assert.equal(reclaimedRows[0]?.claim_id, 'replacement-claim');
    assert.notEqual(reclaimedRows[0]?.updated_at, '2020-01-01 00:00:00.000');

    for (let round = 0; round < 20; round += 1) {
      const freshIdentity = `fresh-race-${round}`;
      const freshClaims = await Promise.all(contenders.map((storage, index) =>
        storage.claimIdentityInitialization(freshIdentity, `fresh-${round}-${index}`, 60)));
      assert.equal(freshClaims.filter(Boolean).length, 1);

      const expiredIdentity = `expired-race-${round}`;
      await firstPool.execute(`
        INSERT INTO proxy_identity_initializations (
          identity, claim_id, lease_expires_at, created_at, updated_at
        ) VALUES (?, 'expired-claim', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000', '2020-01-01 00:00:00.000')
      `, [expiredIdentity]);
      const expiredClaims = await Promise.all(contenders.map((storage, index) =>
        storage.claimIdentityInitialization(expiredIdentity, `expired-${round}-${index}`, 60)));
      assert.equal(expiredClaims.filter(Boolean).length, 1);
    }

    for (let index = 0; index < 3; index += 1) {
      await first.recordRequestStat({
        identity: 'Alice',
        path: '/v1/models',
        success: index !== 0,
        inputTokens: index,
      });
    }
    const stats = await second.listRequestStats('Alice', 10);
    assert.equal(stats.length, 2);
    assert.deepEqual(stats.map((stat) => stat.inputTokens).sort(), [1, 2]);
    await first.pruneAllRequestStats();

    assert.deepEqual(await second.deleteAccount('Alice'), {
      identity: 'Alice',
      deletedRequestStats: 2,
    });
    assert.equal(await first.getAccount('Alice'), undefined);
  } finally {
    await clearTestData(firstPool).catch(() => undefined);
    await Promise.all(contenders.map((storage) => storage.close()));
  }
});

async function clearTestData(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query('DELETE FROM proxy_identity_initializations');
  await pool.query('DELETE FROM proxy_request_stats');
  await pool.query('DELETE FROM proxy_accounts');
}
