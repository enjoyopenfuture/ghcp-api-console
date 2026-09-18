import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPool, type Pool } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';

const testUrl = 'mysql://test:test@127.0.0.1:1/proxy_test';
const tables = ['proxy_accounts', 'proxy_request_stats', 'proxy_identity_initializations'];
const tableQueries = tables.map((table) => `SELECT 1 FROM ${table} LIMIT 0`);
const initializationQueries = [...tableQueries, 'SELECT 1'];

for (const autoMigrate of [undefined, true]) {
  test(`runs migrations when autoMigrate is ${autoMigrate} and does not fall back on failure`, async (t) => {
    const pool = createTestPool(t);
    const denied = new Error('CREATE command denied');
    const migration = t.mock.method(pool, 'getConnection', async () => { throw denied; });
    const query = t.mock.method(pool, 'query', async () => {
      assert.fail('Must not fall back to table checks or ping after a migration failure.');
    });
    const storage = autoMigrate === undefined
      ? new MysqlStorage(pool, 2)
      : new MysqlStorage(pool, 2, autoMigrate);

    await assert.rejects(storage.initialize(), (error) => error === denied);
    assert.equal(migration.mock.callCount(), 1);
    assert.equal(query.mock.callCount(), 0);
  });
}

test('checks only empty business tables and pings without accessing migration history', async (t) => {
  const pool = createTestPool(t);
  const queries: string[] = [];
  t.mock.method(pool, 'query', async (sql: string) => {
    assert.ok(initializationQueries.includes(sql), `Unexpected query: ${sql}`);
    queries.push(sql);
    return [[], []];
  });

  await new MysqlStorage(pool, 2, false).initialize();

  assert.deepEqual(queries, initializationQueries);
});

for (const table of tables) {
  for (const code of ['ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR']) {
    test(`rejects startup when ${table} returns ${code}`, async (t) => {
      const pool = createTestPool(t);
      const cause = Object.assign(new Error(code), { code });
      const queries: string[] = [];
      t.mock.method(pool, 'query', async (sql: string) => {
        assert.ok(tableQueries.includes(sql), `Unexpected query: ${sql}`);
        queries.push(sql);
        if (sql === `SELECT 1 FROM ${table} LIMIT 0`) throw cause;
        return [[], []];
      });

      await assert.rejects(new MysqlStorage(pool, 2, false).initialize(), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(table));
        assert.match(error.message, /MYSQL_AUTO_MIGRATE=false/);
        assert.match(error.message, /database administrator/);
        assert.equal(error.cause, cause);
        return true;
      });
      assert.deepEqual(queries, tableQueries.slice(0, tables.indexOf(table) + 1));
    });
  }
}

test('propagates a failed connection ping when migrations are disabled', async (t) => {
  const pool = createTestPool(t);
  const unavailable = new Error('Connection lost');
  t.mock.method(pool, 'query', async (sql: string) => {
    if (sql === 'SELECT 1') throw unavailable;
    assert.ok(tableQueries.includes(sql), `Unexpected query: ${sql}`);
    return [[], []];
  });

  await assert.rejects(new MysqlStorage(pool, 2, false).initialize(), (error) => error === unavailable);
});

test('wires the setting through startup, readiness, repositories and storage reinitialization', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-mysql-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment: Record<string, string> = {
    DOTENV_CONFIG_PATH: join(directory, 'missing.env'),
    STORAGE_DRIVER: 'mysql',
    MYSQL_URL: testUrl,
    MYSQL_AUTO_MIGRATE: 'false',
    MYSQL_SSL_MODE: 'disabled',
    PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
  };
  for (const [key, value] of Object.entries(environment)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }

  const pool = createTestPool(t);
  const prototype: Pick<Pool, 'query' | 'execute' | 'getConnection'> = Object.getPrototypeOf(pool);
  const queries: string[] = [];
  const executions: string[] = [];
  const migrationError = new Error('Migrations must not run.');
  const missingTable = new Error('Table does not exist');
  let failedQuery: string | undefined;
  t.mock.method(prototype, 'getConnection', async () => { throw migrationError; });
  t.mock.method(prototype, 'query', async (sql: string) => {
    assert.ok(initializationQueries.includes(sql), `Unexpected query: ${sql}`);
    queries.push(sql);
    if (sql === failedQuery) throw missingTable;
    return [[], []];
  });
  t.mock.method(prototype, 'execute', async (sql: string) => {
    assert.ok(
      sql === 'SELECT * FROM proxy_accounts WHERE identity = ?' || sql.trimStart().startsWith('DELETE stats'),
      `Unexpected execution: ${sql}`,
    );
    executions.push(sql);
    return [[], []];
  });

  const { config } = await import('../config.js');
  const originalConfig = { ...config };
  t.after(() => Object.assign(config, originalConfig));
  config.port = 0;
  const { closeStorage, getStorage, initializeStorage, pingStorage } = await import('./connection.js');
  t.after(closeStorage);
  const { getAccount } = await import('./accountsRepo.js');
  const { startServer } = await import('../server.js');

  await Promise.all([initializeStorage(), initializeStorage()]);
  assert.ok(getStorage() instanceof MysqlStorage);
  assert.deepEqual(queries, initializationQueries);
  await pingStorage();
  assert.equal(await getAccount('missing-account'), undefined);
  assert.deepEqual(queries, [...initializationQueries, 'SELECT 1']);

  const signals = ['SIGTERM', 'SIGINT'] as const;
  const originalListeners = signals.map((signal) => new Set(process.listeners(signal)));
  t.after(() => {
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!originalListeners[index]?.has(listener)) process.removeListener(signal, listener);
      }
    }
  });
  const server = await startServer();
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'proxy', storage: 'mysql' });
  assert.deepEqual(queries, [...initializationQueries, 'SELECT 1', 'SELECT 1']);
  assert.equal(executions.length, 2);

  await closeStorage();
  queries.length = 0;
  await initializeStorage();
  assert.deepEqual(queries, initializationQueries);

  await closeStorage();
  queries.length = 0;
  executions.length = 0;
  failedQuery = tableQueries[0];
  await assert.rejects(startServer(), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, missingTable);
    assert.match(error.message, /proxy_accounts/);
    return true;
  });
  assert.deepEqual(queries, [tableQueries[0]]);
  assert.equal(executions.length, 0);

  failedQuery = undefined;
  config.mysqlAutoMigrate = true;
  queries.length = 0;
  await assert.rejects(startServer(), (error) => error === migrationError);
  assert.deepEqual(queries, []);

  config.mysqlAutoMigrate = false;
  config.storageDriver = 'sqlite';
  config.dbPath = ':memory:';
  await initializeStorage();
  assert.equal(await getAccount('missing-account'), undefined);
  assert.deepEqual(queries, []);
});

function createTestPool(t: TestContext): Pool {
  const pool = createPool(testUrl);
  t.after(() => pool.end());
  t.mock.method(pool, 'getConnection', async () => {
    assert.fail('Unexpected migration connection.');
  });
  t.mock.method(pool, 'execute', async () => {
    assert.fail('Unexpected SQL execution.');
  });
  return pool;
}
