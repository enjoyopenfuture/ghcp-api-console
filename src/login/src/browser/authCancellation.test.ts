import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright';
import { chromium } from 'playwright-extra';
import { AccountLogger } from '../tasks/accountLogger.js';
import { HeadlessPlaywrightAuthStrategy } from '../auth/HeadlessPlaywrightAuthStrategy.js';

test('cancellation closes a real authorization browser, including a transient close failure', { timeout: 60_000 }, async (t) => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { config } = await import('../config.js');
  const directory = await mkdtemp(join(tmpdir(), 'login-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let entered: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html><body>Waiting for cancellation');
    entered!();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const originalLaunch = chromium.launch.bind(chromium);
  let browser: Browser | undefined;
  let closeCalls = 0;
  t.mock.method(chromium, 'launch', async (...args: Parameters<typeof chromium.launch>) => {
    browser = await originalLaunch(...args);
    const close = browser.close.bind(browser);
    t.after(() => close());
    t.mock.method(browser, 'close', async () => {
      if (++closeCalls === 1) throw new Error('Fixture transient browser cleanup failure');
      await close();
    });
    return browser;
  });
  const logger = AccountLogger.create(directory, 'fixture-user', false, 'fixture-attempt', undefined, ['fixture-password']);
  const strategy = new HeadlessPlaywrightAuthStrategy(
    { ...config.auth, ssoProvider: 'custom', headless: true, timeoutMs: 30_000, debugArtifacts: false, debugLogs: false },
    { githubUsername: 'fixture-gh', ssoUsername: 'fixture-user', ssoPassword: 'fixture-password' },
    logger,
  );
  const controller = new AbortController();
  const authorization = strategy.authorize({
    device_code: 'fixture-code', user_code: 'fixture-user-code',
    verification_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/device`,
    expires_in: 900, interval: 1,
  }, controller.signal);
  const rejected = assert.rejects(authorization, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await opened;
  controller.abort();
  await rejected;
  assert.equal(browser?.isConnected(), false);
  assert.equal(closeCalls, 2);
  assert.equal((await readFile(logger.path, 'utf8')).includes('fixture-password'), false);
});
