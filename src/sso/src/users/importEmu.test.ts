import assert from 'node:assert/strict';
import test from 'node:test';

test('imports direct seat snapshots, dates and date-only updates without changing frozen previews', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://scim.test/scim/v2/enterprises/test';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  let seatStatus = 200;
  let seats: Array<{ assignee: { login: string }; pending_cancellation_date: string | null; organization?: { id: number }; assigning_team?: { id: number } }> = [
    { assignee: { login: 'BOB_emu' }, pending_cancellation_date: null },
    { assignee: { login: 'carol_emu' }, pending_cancellation_date: '2026-10-17' },
    { assignee: { login: 'carol_emu' }, organization: { id: 1 }, pending_cancellation_date: null },
    { assignee: { login: 'org-only_emu' }, organization: { id: 2 }, pending_cancellation_date: null },
    { assignee: { login: 'team-only_emu' }, assigning_team: { id: 1 }, pending_cancellation_date: null },
  ];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://scim.test/')) {
      return jsonResponse(200, {
        Resources: ['bob', 'carol', 'dave', 'org-only', 'team-only'].map((name) => ({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          id: `scim-${name}`,
          userName: name,
          githubLogin: `${name}_emu`,
          active: true,
          emails: [{ value: `${name}@example.com`, primary: true }],
        })),
      });
    }
    if (url.includes('/copilot/billing/seats')) {
      return jsonResponse(seatStatus, { total_seats: seats.length, seats });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const { createUser, getUser, recordCopilotSeatError, updateCopilotSeatFromGitHub } = await import('../db/usersRepo.js');
    const { getDb } = await import('../db/connection.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { applyEmuImportPlan, createEmuImportPlan, importEmuUsers, listEmuImportPlanRows } = await import('./service.js');
    updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });
    createUser({ ssoUser: 'bob', email: 'old@example.com', passwordHash: 'keep-hash', salt: 'keep-salt', role: 'admin' });
    const plan = await createEmuImportPlan();
    const preview = listEmuImportPlanRows(plan.planId);
    const previewByUser = new Map(preview.items.map((row) => [row.ssoUser, row]));

    assert.equal(previewByUser.get('bob')?.copilotSeatStatus, 'assigned');
    assert.equal(previewByUser.get('carol')?.copilotSeatStatus, 'pending_cancellation');
    assert.equal(previewByUser.get('carol')?.copilotSeatPendingCancellationDate, '2026-10-17');
    assert.equal(previewByUser.get('bob')?.status, 'pending_update');
    assert.equal(previewByUser.get('carol')?.status, 'pending_create');
    for (const name of ['dave', 'org-only', 'team-only']) assert.equal(previewByUser.get(name)?.copilotSeatStatus, 'unassigned');
    assert.equal(getUser('carol'), undefined, 'Preview does not create a user');

    seats[1]!.pending_cancellation_date = '2026-11-17';
    await applyEmuImportPlan(plan.planId);

    assert.equal(getUser('bob')?.copilotSeatStatus, 'assigned');
    assert.equal(getUser('bob')?.passwordHash, 'keep-hash');
    assert.equal(getUser('bob')?.role, 'admin');
    assert.equal(getUser('carol')?.copilotSeatStatus, 'pending_cancellation');
    assert.equal(getUser('carol')?.copilotSeatPendingCancellationDate, '2026-10-17', 'Apply uses the stored snapshot');
    assert.equal(listEmuImportPlanRows(plan.planId).items.find((row) => row.ssoUser === 'carol')?.copilotSeatPendingCancellationDate, '2026-10-17');
    const second = await createEmuImportPlan();
    assert.equal(second.summary.pendingUpdate, 1, 'A date-only change must not be skipped');
    assert.equal(listEmuImportPlanRows(second.planId, { status: 'pending_update', pageSize: 1 }).items[0]?.copilotSeatPendingCancellationDate, '2026-11-17');
    await applyEmuImportPlan(second.planId);
    assert.equal(getUser('carol')?.copilotSeatPendingCancellationDate, '2026-11-17');
    assert.equal((await applyEmuImportPlan(second.planId)).summary.updated, 1, 'Apply is reentrant');
    assert.equal((await createEmuImportPlan()).summary.skipped, 5);

    recordCopilotSeatError('carol', 'remove', 'Previous readback failed');
    const clearErrorPlan = await createEmuImportPlan();
    assert.equal(clearErrorPlan.summary.pendingUpdate, 1);
    await applyEmuImportPlan(clearErrorPlan.planId);
    assert.equal(Boolean(getUser('carol')?.copilotSeatLastError), false);

    seats[1]!.pending_cancellation_date = null;
    await importEmuUsers();
    assert.equal(getUser('carol')?.copilotSeatStatus, 'assigned');
    assert.equal(getUser('carol')?.copilotSeatPendingCancellationDate, undefined);
    seats[1]!.pending_cancellation_date = '2000-01-01';
    await importEmuUsers();
    assert.equal(getUser('carol')?.copilotSeatStatus, 'pending_cancellation');
    assert.equal(getUser('carol')?.copilotSeatPendingCancellationDate, '2000-01-01', 'Even a past date remains the GitHub snapshot');
    seats = seats.filter((seat) => seat.organization || seat.assigning_team);
    await importEmuUsers();
    assert.equal(getUser('carol')?.copilotSeatStatus, 'unassigned', 'Other sources cannot restore the direct seat');
    assert.equal(getUser('bob')?.copilotSeatStatus, 'unassigned');
    const planCount = () => (getDb().prepare('SELECT COUNT(*) AS count FROM sso_emu_import_plans').get() as { count: number }).count;
    const beforeFailure = planCount();
    updateCopilotSeatFromGitHub('bob', { status: 'pending_cancellation', pendingCancellationDate: '2026-10-17' });
    seatStatus = 503;
    await assert.rejects(createEmuImportPlan(), /503/);
    assert.equal(planCount(), beforeFailure, 'Failed lookup does not create an unassigned preview');
    assert.equal(getUser('bob')?.copilotSeatPendingCancellationDate, '2026-10-17');
    assert.equal(getUser('bob')?.copilotSeatStatus, 'pending_cancellation');
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
