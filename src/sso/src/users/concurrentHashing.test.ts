import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SSO_USER_EVENTS_LOG = '/dev/null';
process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
process.env.SCIM_TOKEN = 'test-scim-token';
process.env.GITHUB_API_BASE_URL = 'https://github.test';
process.env.ENTERPRISE_SLUG = 'test-enterprise';
process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
process.env.LOG_LEVEL = 'error';

test('password hashing yields to the event loop during bulk import', async () => {
  const { importUsers } = await import('./service.js');
  const events: string[] = [];
  setTimeout(() => events.push('timer'), 0);
  const result = await importUsers('ssoUser,password\nloop-a,pw-a\nloop-b,pw-b\nloop-c,pw-c');
  events.push('import-done');
  assert.equal(result.summary.success, 3);
  assert.deepEqual(events, ['timer', 'import-done']);
});

test('concurrent ensureUser calls for one identity create a single SSO user', async () => {
  const { ensureUser } = await import('./service.js');
  const { countUsers } = await import('../db/usersRepo.js');
  const before = countUsers();
  const results = await Promise.all([1, 2, 3].map(() => ensureUser('race@example.com')));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.deepEqual(new Set(results.map((result) => result.user.ssoUser)), new Set(['race']));
  assert.ok(results.every((result) => result.passwordForLogin), 'Existing default password is still reported');
  assert.equal(countUsers(), before + 1);
});

test('concurrent createSsoUser calls for one name report a clear conflict', async () => {
  const { createSsoUser } = await import('./service.js');
  const results = await Promise.allSettled([createSsoUser({ ssoUser: 'dup' }), createSsoUser({ ssoUser: 'dup' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.match(String(rejected?.reason?.message), /already exists/);
});

test('concurrent applies of one EMU import plan keep created rows', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://scim.test/')) {
      return jsonResponse({ Resources: ['erin', 'frank'].map((name) => ({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: `scim-${name}`,
        userName: name,
        githubLogin: `${name}_emu`,
        active: true,
        emails: [{ value: `${name}@example.com`, primary: true }],
      })) });
    }
    if (url.includes('/copilot/billing/seats')) return jsonResponse({ total_seats: 0, seats: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const { updateSsoRuntimeSettings, getSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { getUser } = await import('../db/usersRepo.js');
    const { applyEmuImportPlan, createEmuImportPlan, listEmuImportPlanRows } = await import('./service.js');
    updateSsoRuntimeSettings({ expectedVersion: getSsoRuntimeSettings().version, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });
    const plan = await createEmuImportPlan();
    assert.equal(plan.summary.pendingCreate, 2);

    const applied = await Promise.all([applyEmuImportPlan(plan.planId), applyEmuImportPlan(plan.planId)]);

    for (const result of applied) assert.equal(result.summary.created, 2);
    const statuses = listEmuImportPlanRows(plan.planId).items.map((row) => [row.ssoUser, row.status]);
    assert.deepEqual(statuses, [['erin', 'created'], ['frank', 'created']]);
    assert.equal(getUser('erin')?.ghLogin, 'erin_emu');
    assert.equal(getUser('frank')?.ghLogin, 'frank_emu');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
