import assert from 'node:assert/strict';
import test from 'node:test';

test('continues deleting an SSO user when the GitHub user has no Copilot seat', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.SCIM_REQUEST_DELAY_MS = '0';
  process.env.SCIM_MAX_RETRIES = '0';
  process.env.PROXY_BASE_URL = 'https://proxy.test';
  process.env.INTERNAL_API_TOKEN = 'test-internal-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url.includes('/copilot/billing/selected_users')) {
      return jsonResponse(422, { message: 'Cannot cancel a user without a Copilot seat.' });
    }
    if (url.startsWith('https://scim.test/')) {
      return jsonResponse(200, { Resources: [] });
    }
    if (url.startsWith('https://proxy.test/')) {
      return jsonResponse(200, {
        ssoUser: 'alice',
        matchedAccounts: 0,
        deletedAccounts: 0,
        deletedRequestStats: 0,
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const { createUser, getUser, updateEmu } = await import('../db/usersRepo.js');
    const { runSsoUserBatch } = await import('./service.js');
    createUser({
      ssoUser: 'alice',
      passwordHash: 'hash',
      salt: 'salt',
      email: 'alice@example.com',
    });
    updateEmu('alice', { ghLogin: 'alice_emu', emuStatus: 'active' });

    const result = await runSsoUserBatch({
      operation: 'delete_sso',
      ssoUsers: ['alice'],
    });

    assert.equal(result.summary.success, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.warnings, 1);
    assert.equal(result.rows[0]?.status, 'success');
    assert.match(result.rows[0]?.warning ?? '', /has no Copilot seat/);
    assert.equal(getUser('alice'), undefined);
    assert.deepEqual(requests.map(({ method }) => method), ['DELETE', 'GET', 'DELETE']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
