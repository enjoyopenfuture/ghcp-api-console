import assert from 'node:assert/strict';
import test from 'node:test';

test('imports the current GitHub Copilot seat status with the SCIM user', async () => {
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
        Resources: [{
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          id: 'scim-bob',
          userName: 'bob',
          githubLogin: 'bob_emu',
          active: true,
          emails: [{ value: 'bob@example.com', primary: true }],
        }, {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          id: 'scim-carol',
          userName: 'carol',
          githubLogin: 'carol_emu',
          active: true,
          emails: [{ value: 'carol@example.com', primary: true }],
        }],
      });
    }
    if (url.includes('/copilot/billing/seats')) {
      return jsonResponse(200, {
        total_seats: 1,
        seats: [{ assignee: { login: 'bob_emu' } }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const { getUser } = await import('../db/usersRepo.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { applyEmuImportPlan, createEmuImportPlan, listEmuImportPlanRows } = await import('./service.js');
    updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });
    const plan = await createEmuImportPlan();
    const preview = listEmuImportPlanRows(plan.planId);
    const previewByUser = new Map(preview.items.map((row) => [row.ssoUser, row]));

    assert.equal(previewByUser.get('bob')?.copilotSeatStatus, 'assigned');
    assert.equal(previewByUser.get('carol')?.copilotSeatStatus, 'unassigned');
    assert.equal(previewByUser.get('bob')?.status, 'pending_create');

    applyEmuImportPlan(plan.planId);

    assert.equal(getUser('bob')?.copilotSeatStatus, 'assigned');
    assert.equal(getUser('carol')?.copilotSeatStatus, 'unassigned');
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
