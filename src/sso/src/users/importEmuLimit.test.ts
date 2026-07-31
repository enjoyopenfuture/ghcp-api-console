import assert from 'node:assert/strict';
import test from 'node:test';

test('marks excess GH imports as failed without rolling back available slots', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://scim.test/')) {
      return jsonResponse(200, {
        Resources: [
          scimUser('scim-alice', 'alice', 'alice_emu'),
          scimUser('scim-bob', 'bob', 'bob_emu'),
        ],
      });
    }
    if (url.includes('/copilot/billing/seats')) {
      return jsonResponse(200, { total_seats: 0, seats: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const { getUser } = await import('../db/usersRepo.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { applyEmuImportPlan, createEmuImportPlan, listEmuImportPlanRows } = await import('./service.js');
    updateSsoRuntimeSettings({
      expectedVersion: 1,
      changes: { maxSsoUsers: 1, scimRequestDelayMs: 0, scimMaxRetries: 0 },
    });
    const plan = await createEmuImportPlan();

    applyEmuImportPlan(plan.planId);

    const rows = listEmuImportPlanRows(plan.planId).items;
    assert.equal(rows.find((row) => row.ssoUser === 'alice')?.status, 'created');
    assert.equal(rows.find((row) => row.ssoUser === 'bob')?.status, 'failed');
    assert.match(rows.find((row) => row.ssoUser === 'bob')?.detail ?? '', /limit of 1 has been reached/);
    assert.equal(getUser('alice')?.ghLogin, 'alice_emu');
    assert.equal(getUser('bob'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function scimUser(id: string, userName: string, githubLogin: string): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id,
    userName,
    githubLogin,
    active: true,
    emails: [{ value: `${userName}@example.com`, primary: true }],
  };
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
