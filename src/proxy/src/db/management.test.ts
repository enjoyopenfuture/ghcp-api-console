import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStorage } from './sqliteStorage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('the account attempt id fences late writes, stale retries and superseded attempts', async (t) => {
  const storage = new SqliteStorage(':memory:', 2000);
  await storage.initialize();
  t.after(() => storage.close());
  await storage.createAccount({ identity: 'account', ssoUser: 'user', ghLogin: 'github-user' });

  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'first', null), true);
  assert.equal(await storage.failCopilotOauthAuthorization('account', 'first'), true);
  assert.equal(await storage.saveCopilotOauthToken('account', 'first', 'must-not-be-written'), undefined, 'A failed attempt cannot write late');
  assert.equal((await storage.getAccount('account'))?.copilotOauthStatus, 'failed');

  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'second', 'wrong-previous'), false, 'A retry must name the attempt the account still points at');
  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'second', 'first'), true);
  assert.ok(await storage.saveCopilotOauthToken('account', 'second', 'committed-token'));
  const committed = await storage.getAccount('account');
  assert.equal(committed?.copilotOauthToken, 'committed-token');
  assert.equal(committed?.copilotOauthAttemptId, undefined);
  assert.equal(await storage.failCopilotOauthAuthorization('account', 'second'), false, 'A failure report for a committed attempt is ignored');
  assert.equal((await storage.getAccount('account'))?.copilotOauthStatus, 'valid');

  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'third', 'second'), false, 'The committed attempt is no longer current');
  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'third', null), true);
  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'fourth'), true, 'A forced begin supersedes the running attempt');
  assert.equal((await storage.getAccount('account'))?.copilotOauthAttemptId, 'fourth');
  assert.equal(await storage.saveCopilotOauthToken('account', 'third', 'superseded-token'), undefined);
  assert.equal(await storage.failCopilotOauthAuthorization('account', 'third'), false);
  assert.equal(await storage.beginCopilotOauthAuthorization('account', 'conflicting', 'third'), false);
  assert.ok(await storage.saveCopilotOauthToken('account', 'fourth', 'fourth-token'));
  assert.equal((await storage.getAccount('account'))?.copilotOauthToken, 'fourth-token');
});

test('SQLite export snapshots do not change while matching records are inserted or removed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-snapshot-'));
  const storage = new SqliteStorage(join(directory, 'snapshot.sqlite'), 1000);
  await storage.initialize();
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  await storage.createAccount({ identity: 'before', ssoUser: 'before' });
  await storage.withReadSnapshot(async (reader) => {
    assert.equal((await reader.listAccounts()).total, 1);
    await storage.deleteAccount('before');
    await storage.createAccount({ identity: 'after', ssoUser: 'after' });
    assert.equal((await reader.listAccounts()).items[0]?.identity, 'before');
    assert.equal((await storage.listAccounts()).items[0]?.identity, 'after');
  });
});

test('management counts and request filters cover data beyond old page and sample limits', async (t) => {
  const storage = new SqliteStorage(':memory:', 2000);
  await storage.initialize();
  t.after(() => storage.close());
  for (let index = 0; index < 137; index++) {
    await storage.createAccount({
      identity: `account-${String(index).padStart(3, '0')}`, ssoUser: `user-${index}`,
      copilotOauthStatus: index % 2 === 0 ? 'failed' : 'valid',
    });
  }
  const summary = await storage.summarizeAccounts();
  assert.equal(summary.total, 137);
  assert.equal(summary.counts.failed, 69);
  const page = await storage.listAccounts({ page: 999, pageSize: 50, sort: 'identity', dir: 'asc' });
  assert.equal(page.page, 3);
  assert.equal(page.items.length, 37);
  assert.equal((await storage.listAccounts({ status: 'failed' })).total, 69);
  await assert.rejects(storage.listAccounts({ status: 'invalid' }), /Invalid OAuth status/);

  for (let index = 0; index < 1501; index++) {
    await storage.recordRequestStat({
      identity: 'account-000', path: '/chat/completions', model: index === 0 ? 'old-only' : 'recent',
      success: index !== 0, inputTokens: index,
    });
  }
  assert.equal((await storage.listRequestStats(undefined, 1000)).some((row) => row.model === 'old-only'), false);
  const old = await storage.listRequestStatsPage({ model: 'old-only', success: 'false', pageSize: 10 });
  assert.equal(old.total, 1);
  assert.equal(old.items[0]?.model, 'old-only');
  assert.equal((await storage.listRequestStatsPage({ pageSize: 100, page: 16 })).items.length, 1);
});
