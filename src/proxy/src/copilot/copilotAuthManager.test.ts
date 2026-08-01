import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

test('returns a stable account limit error when SSO rejects automatic creation', async () => {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 'sso_user_limit_reached',
        message: 'SSO user limit of 1 has been reached.',
        details: { current: 1, limit: 1 },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  process.env.DB_PATH = ':memory:';
  process.env.SSO_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.INTERNAL_API_TOKEN = 'test-token';
  process.env.LOG_LEVEL = 'error';

  try {
    const { copilotAuthManager, CopilotAuthNotReadyError } = await import('./copilotAuthManager.js');
    await assert.rejects(
      () => copilotAuthManager.getAuth('new-user'),
      (err: unknown) => {
        assert.ok(err instanceof CopilotAuthNotReadyError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'account_limit_reached');
        assert.deepEqual(err.details, { current: 1, limit: 1 });
        return true;
      },
    );
    assert.equal(requestCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
