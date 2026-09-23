import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { SsoUserDto } from '@ghcp/shared';

test('direct seat cancellation, readback errors, restoration and API exports share one persistent snapshot', async (t) => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.SCIM_BASE_URL = 'https://scim.test/enterprise';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.LOG_LEVEL = 'error';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ url: string; method: string }> = [];
  let mutationStatus = 200;
  let mutationMessage = '';
  let lookupStatus = 200;
  let listStatus = 200;
  const seats = (date: string | null) => ({
    total_seats: 1, seats: [{ assignee: { login: 'alice_emu' }, pending_cancellation_date: date }],
  });
  let lookupBody: unknown = seats('2026-10-17');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url.endsWith('/copilot/billing/selected_users')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { selected_usernames: ['alice_emu'] });
      return mutationStatus === 200
        ? jsonResponse(method === 'POST' ? 201 : 200, method === 'POST' ? { seats_created: 1 } : { seats_cancelled: 1 })
        : jsonResponse(mutationStatus, { message: mutationMessage });
    }
    if (url.endsWith('/members/alice_emu/copilot')) return jsonResponse(lookupStatus, lookupBody);
    if (url.includes('/copilot/billing/seats?')) return jsonResponse(listStatus, { total_seats: 0, seats: [] });
    if (url === 'https://scim.test/enterprise/Users/scim-alice' && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith('https://scim.test/enterprise/Users?filter=')) return jsonResponse(200, { Resources: [] });
    throw new Error(`Unexpected external step: ${method} ${url}`);
  };

  const { createUser, getUser, listUsers, updateEmu, updateCopilotSeat } = await import('../db/usersRepo.js');
  const { getDb } = await import('../db/connection.js');
  const { saveAiCreditsUsagePeriod, countAssignedCopilotSeats } = await import('../db/budgetRepo.js');
  const { readAiCreditsUsage } = await import('../budget/budgetService.js');
  const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
  const { assignCopilotSeatForSsoUser, deleteEmuUser, removeCopilotSeatForSsoUser, runSsoUserBatch } = await import('./service.js');
  const { usersApiRouter } = await import('../routes/usersApi.js');
  updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });
  createUser({ ssoUser: 'alice', email: 'alice@example.test', passwordHash: 'hash', salt: 'salt' });
  updateEmu('alice', { ghLogin: 'alice_emu', ghScimId: 'scim-alice', emuStatus: 'active' });
  updateCopilotSeat('alice', { status: 'assigned', lastOperation: 'assign' });
  for (const month of [9, 10]) saveAiCreditsUsagePeriod({ year: 2026, month, quantity: 10, rawJson: {}, fetchedAt: '2026-10-20T00:00:00Z' });
  const usage = () => readAiCreditsUsage(new Date('2026-10-20T00:00:00Z'));

  const app = express();
  app.use(express.json());
  app.use('/api', usersApiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  await t.test('single DELETE retains access metadata and counts the pending seat', async () => {
    const response = await originalFetch(`${base}/users/alice/copilot-seat`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    const user = await response.json() as SsoUserDto;
    assert.equal(user.copilotSeatStatus, 'pending_cancellation');
    assert.equal(user.copilotSeatPendingCancellationDate, '2026-10-17');
    assert.equal(user.emuStatus, 'active');
    assert.equal(user.ghLogin, 'alice_emu');
    assert.deepEqual(requests.map((request) => request.method), ['DELETE', 'GET']);
    assert.equal(countAssignedCopilotSeats(), 1);
    assert.equal(usage()?.assignedSeatMonthlyCost, 19);
    assert.deepEqual(getDb().prepare('SELECT copilot_seat_status, copilot_seat_pending_cancellation_date FROM sso_users').get(), {
      copilot_seat_status: 'pending_cancellation', copilot_seat_pending_cancellation_date: '2026-10-17',
    });
  });

  await t.test('past dates remain pending across list, filter, CSV and cost reads without GH calls', async () => {
    lookupBody = seats('2000-01-01');
    const batch = await runSsoUserBatch({ operation: 'remove_copilot', ssoUsers: ['alice'] });
    assert.equal(batch.summary.success, 1);
    assert.match(batch.rows[0]!.detail, /cancell at 2000-01-01/);
    const before = requests.length;
    assert.equal(listUsers({ seatStatus: 'pending_cancellation', pageSize: 1 }).total, 1);
    assert.equal(listUsers({ seatStatus: 'unassigned' }).total, 0);
    const list = await originalFetch(`${base}/users?seatStatus=pending_cancellation`);
    const body = await list.json() as { items: SsoUserDto[]; total: number };
    assert.equal(body.items[0]?.copilotSeatPendingCancellationDate, '2000-01-01');
    const csv = await originalFetch(`${base}/users/export?seatStatus=pending_cancellation`);
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.match(text, /copilotSeatPendingCancellationDate/);
    assert.match(text, /"pending_cancellation","2000-01-01"/);
    assert.equal(usage()?.assignedSeatMonthlyCost, 19);
    assert.equal(requests.length, before);
  });

  await t.test('successful mutation with failed readback preserves snapshot and exposes a partial-success error', async () => {
    const previous = getUser('alice')!;
    lookupStatus = 503;
    const response = await originalFetch(`${base}/users/alice/copilot-seat`, { method: 'DELETE' });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /accepted.*synchronization failed.*503/);
    assert.equal(getUser('alice')?.copilotSeatStatus, previous.copilotSeatStatus);
    assert.equal(getUser('alice')?.copilotSeatPendingCancellationDate, previous.copilotSeatPendingCancellationDate);
    assert.equal(getUser('alice')?.copilotSeatUpdatedAt, previous.copilotSeatUpdatedAt);
    assert.match(getUser('alice')?.copilotSeatLastError ?? '', /Previous confirmed state was kept/);
    const batch = await runSsoUserBatch({ operation: 'remove_copilot', ssoUsers: ['alice'] });
    assert.equal(batch.summary.failed, 1);
    assert.match(batch.rows[0]!.detail, /accepted.*synchronization failed/);
    await assert.rejects(assignCopilotSeatForSsoUser('alice'), /accepted.*assign.*synchronization failed/);
    assert.equal(getUser('alice')?.copilotSeatPendingCancellationDate, '2000-01-01');
    assert.equal(countAssignedCopilotSeats(), 1);
    lookupStatus = 200;
    lookupBody = { seats: [{ assignee: { login: 'alice_emu' } }] };
    await assert.rejects(removeCopilotSeatForSsoUser('alice'), /missing or invalid pending_cancellation_date/);
    assert.equal(getUser('alice')?.copilotSeatUpdatedAt, previous.copilotSeatUpdatedAt);
  });

  await t.test('Assign confirms recovery and clears the previous date and errors', async () => {
    lookupBody = seats(null);
    const user = await assignCopilotSeatForSsoUser('alice');
    assert.equal(user.copilotSeatStatus, 'assigned');
    assert.equal(user.copilotSeatPendingCancellationDate, undefined);
    assert.equal(Boolean(user.copilotSeatLastError), false);
    assert.equal(usage()?.assignedSeatMonthlyCost, 19);
    await assert.rejects(removeCopilotSeatForSsoUser('alice'), /still assigned.*not yet confirmed/);
    assert.equal(getUser('alice')?.copilotSeatStatus, 'assigned');
    assert.match(getUser('alice')?.copilotSeatLastError ?? '', /not yet confirmed/);
    lookupBody = seats('2026-10-17');
    await assert.rejects(assignCopilotSeatForSsoUser('alice'), /still pending_cancellation.*not yet confirmed/);
    assert.equal(getUser('alice')?.copilotSeatPendingCancellationDate, '2026-10-17');
  });

  await t.test('mutation failures cannot erase a previously confirmed cancellation', async () => {
    mutationStatus = 422;
    mutationMessage = 'The seat cannot be cancelled because it was assigned through a team.';
    await assert.rejects(removeCopilotSeatForSsoUser('alice'), /assigned through a team/);
    assert.equal(getUser('alice')?.copilotSeatStatus, 'pending_cancellation');
    assert.equal(getUser('alice')?.copilotSeatPendingCancellationDate, '2026-10-17');
    mutationStatus = 200;
  });

  await t.test('another Remove confirms expiration, while a forbidden fallback cannot mark unassigned', async () => {
    lookupStatus = 404;
    listStatus = 403;
    await assert.rejects(removeCopilotSeatForSsoUser('alice'), /synchronization failed.*403/);
    assert.equal(getUser('alice')?.copilotSeatStatus, 'pending_cancellation');
    listStatus = 200;
    const result = await runSsoUserBatch({ operation: 'remove_copilot', ssoUsers: ['alice'] });
    assert.equal(result.summary.success, 1);
    assert.match(result.rows[0]!.detail, /No enterprise direct Copilot seat/);
    assert.equal(getUser('alice')?.copilotSeatStatus, 'unassigned');
    assert.equal(getUser('alice')?.copilotSeatPendingCancellationDate, undefined);
    assert.equal(usage()?.assignedSeatCount, 0);
    assert.equal(usage()?.assignedSeatMonthlyCost, 0);
    mutationStatus = 422;
    mutationMessage = 'Cannot cancel a user without a Copilot seat.';
    const missing = await removeCopilotSeatForSsoUser('alice');
    assert.match(missing.warning ?? '', /has no Copilot seat/);
    assert.equal(missing.user?.copilotSeatStatus, 'unassigned');
    mutationStatus = 200;
    lookupStatus = 200;
  });

  await t.test('deleting the EMU does not wait for the scheduled seat date', async () => {
    lookupBody = seats('2026-10-17');
    const result = await deleteEmuUser('alice');
    assert.equal(result.user?.emuStatus, 'not_synced');
    assert.equal(result.user?.copilotSeatStatus, 'unassigned');
    assert.equal(result.user?.copilotSeatPendingCancellationDate, undefined);
    assert.equal(requests.at(-2)?.url, 'https://scim.test/enterprise/Users/scim-alice');
    assert.equal(requests.at(-2)?.method, 'DELETE');
  });
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
