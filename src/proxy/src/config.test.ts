import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('parses MYSQL_AUTO_MIGRATE without changing the default migration behavior', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configUrl = new URL('./config.js', import.meta.url).href;
  const cases: Array<{ value?: string; expected?: boolean }> = [
    { expected: true },
    ...['true', 'TRUE', '1', 'yes', 'on'].map((value) => ({ value, expected: true })),
    ...['false', 'FALSE', '0', 'no', 'off'].map((value) => ({ value, expected: false })),
    { value: '' },
    { value: 'invalid' },
  ];

  for (const { value, expected } of cases) {
    await t.test(value === undefined ? 'unset defaults to true' : `value ${JSON.stringify(value)}`, () => {
      const result = spawnSync(process.execPath, [
        '--import', 'tsx',
        '--input-type=module',
        '--eval', `const { config } = await import(${JSON.stringify(configUrl)}); console.log(config.mysqlAutoMigrate);`,
      ], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          DOTENV_CONFIG_PATH: join(directory, 'missing.env'),
          STORAGE_DRIVER: 'mysql',
          MYSQL_URL: 'mysql://test:test@127.0.0.1/proxy_test',
          ...(value === undefined ? {} : { MYSQL_AUTO_MIGRATE: value }),
        },
      });

      assert.equal(result.error, undefined);
      if (expected === undefined) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Invalid boolean/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), String(expected));
      }
    });
  }
});
