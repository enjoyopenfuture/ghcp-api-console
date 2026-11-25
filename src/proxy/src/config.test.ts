import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const configUrl = new URL('./config.js', import.meta.url).href;
// Never created, so dotenv cannot load the developer's src/proxy/.env into the child process.
const missingEnvPath = join(tmpdir(), `proxy-config-${randomUUID()}`, 'missing.env');

test('parses MYSQL_AUTO_MIGRATE without changing the default migration behavior', async (t) => {
  const cases: Array<{ value?: string; expected?: boolean }> = [
    { expected: true },
    ...['true', 'TRUE', '1', 'yes', 'on'].map((value) => ({ value, expected: true })),
    ...['false', 'FALSE', '0', 'no', 'off'].map((value) => ({ value, expected: false })),
    { value: '' },
    { value: 'invalid' },
  ];

  for (const { value, expected } of cases) {
    await t.test(value === undefined ? 'unset defaults to true' : `value ${JSON.stringify(value)}`, () => {
      const result = loadConfig({
        STORAGE_DRIVER: 'mysql',
        MYSQL_URL: 'mysql://test:test@127.0.0.1/proxy_test',
        ...(value === undefined ? {} : { MYSQL_AUTO_MIGRATE: value }),
      }, 'config.mysqlAutoMigrate');

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

test('parses image upload settings and the inbound request body limit', async (t) => {
  const MIB = 1024 * 1024;
  const cases: Array<{ name: string; env: Record<string, string>; expected?: object; error?: RegExp }> = [
    {
      name: 'defaults target github.com uploads with a 64 MiB limit',
      env: {},
      expected: {
        imageUploadMode: 'always',
        copilotAttachmentUploadUrl: 'https://uploads.github.com/copilot/chat/attachments',
        maxRequestBodyBytes: 64 * MIB,
      },
    },
    {
      name: 'GHE.com derives its uploads host; mode is case-insensitive',
      env: { GITHUB_BASE_URL: 'https://acme.ghe.com', PROXY_IMAGE_UPLOAD_MODE: ' AUTO ', PROXY_MAX_REQUEST_BODY_MB: '8' },
      expected: {
        imageUploadMode: 'auto',
        copilotAttachmentUploadUrl: 'https://uploads.acme.ghe.com/copilot/chat/attachments',
        maxRequestBodyBytes: 8 * MIB,
      },
    },
    {
      name: 'rejects an unknown mode',
      env: { PROXY_IMAGE_UPLOAD_MODE: 'sometimes' },
      error: /Invalid PROXY_IMAGE_UPLOAD_MODE "sometimes"\. Expected "always", "auto", or "off"\./,
    },
  ];

  for (const { name, env, expected, error } of cases) {
    await t.test(name, () => {
      const result = loadConfig(
        env,
        'JSON.stringify({ imageUploadMode: config.imageUploadMode, ' +
          'copilotAttachmentUploadUrl: config.copilotAttachmentUploadUrl, maxRequestBodyBytes: config.maxRequestBodyBytes })',
      );

      assert.equal(result.error, undefined);
      if (error) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, error);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), expected);
      }
    });
  }
});

/** Imports config.ts in a fresh process with only the given env and prints the expression's value. */
function loadConfig(env: Record<string, string>, expression: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '--eval', `const { config } = await import(${JSON.stringify(configUrl)}); console.log(${expression});`,
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: missingEnvPath, ...env },
  });
}
