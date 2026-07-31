import assert from 'node:assert/strict';
import test from 'node:test';

test('limits sync_emu concurrency and preserves result order', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  let activeCreates = 0;
  let maxActiveCreates = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://scim.test/scim/v2/enterprises/test/Users' && init?.method === 'POST') {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      const body = JSON.parse(String(init.body)) as { userName: string };
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCreates -= 1;
      return jsonResponse(201, {
        id: `scim-${body.userName}`,
        userName: body.userName,
        githubLogin: `${body.userName}_emu`,
      });
    }
    if (url.includes('/copilot/billing/selected_users') && init?.method === 'POST') {
      return jsonResponse(201, {});
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  };

  try {
    const { createUser } = await import('../db/usersRepo.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { runSsoUserBatch } = await import('./service.js');
    for (const ssoUser of ['charlie', 'alice', 'bob']) {
      createUser({ ssoUser, passwordHash: 'hash', salt: 'salt', email: `${ssoUser}@example.com` });
    }
    updateSsoRuntimeSettings({
      expectedVersion: 1,
      changes: { bulkSyncConcurrency: 2, scimRequestDelayMs: 0, scimMaxRetries: 0 },
    });

    const result = await runSsoUserBatch({
      operation: 'sync_emu',
      ssoUsers: ['charlie', 'alice', 'bob'],
    });

    assert.equal(maxActiveCreates, 2);
    assert.deepEqual(result.rows.map((row) => row.ssoUser), ['charlie', 'alice', 'bob']);
    assert.equal(result.summary.failed, 0);
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
