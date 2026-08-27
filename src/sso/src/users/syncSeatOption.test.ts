import assert from 'node:assert/strict';
import test from 'node:test';

test('sync_emu assigns a Copilot seat only when explicitly requested', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  const seatAssignments: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://scim.test/scim/v2/enterprises/test/Users' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { userName: string };
      return jsonResponse(201, {
        id: `scim-${body.userName}`,
        userName: body.userName,
        githubLogin: `${body.userName}_emu`,
      });
    }
    if (url.includes('/copilot/billing/selected_users') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { selected_usernames: string[] };
      seatAssignments.push(...body.selected_usernames);
      return jsonResponse(201, {});
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  };

  try {
    const { createUser, getUser } = await import('../db/usersRepo.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { runSsoUserBatch } = await import('./service.js');
    for (const ssoUser of ['login-only', 'login-with-seat']) {
      createUser({ ssoUser, passwordHash: 'hash', salt: 'salt', email: `${ssoUser}@example.com` });
    }
    updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });

    const loginOnly = await runSsoUserBatch({
      operation: 'sync_emu',
      ssoUsers: ['login-only'],
      assignCopilotSeat: false,
    });
    const loginWithSeat = await runSsoUserBatch({
      operation: 'sync_emu',
      ssoUsers: ['login-with-seat'],
      assignCopilotSeat: true,
    });

    assert.equal(loginOnly.rows[0]?.detail, 'Synced to EMU.');
    assert.equal(loginOnly.rows[0]?.user?.copilotSeatStatus, 'unknown');
    assert.equal(getUser('login-only')?.copilotSeatStatus, 'unknown');
    assert.equal(loginWithSeat.rows[0]?.detail, 'Synced to EMU and assigned Copilot seat.');
    assert.equal(loginWithSeat.rows[0]?.user?.copilotSeatStatus, 'assigned');
    assert.deepEqual(seatAssignments, ['login-with-seat_emu']);
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
