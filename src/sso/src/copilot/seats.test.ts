import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import { assignCopilotSeat, CopilotSeatNotAssignedError, getCopilotSeatAssignment, isCancellationDate, listCopilotSeatAssignments, removeCopilotSeat } from './seats.js';

test('identifies a missing Copilot seat without hiding other cancellation errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';

  try {
    globalThis.fetch = async () => jsonResponse(422, {
      message: 'Cannot cancel a user without a Copilot seat.',
    });
    await assert.rejects(
      removeCopilotSeat('alice_emu'),
      (err: unknown) => err instanceof CopilotSeatNotAssignedError && err.status === 422,
    );

    globalThis.fetch = async () => jsonResponse(422, {
      message: 'Seat assignment for user alice_emu could not be cancelled: User is not assigned to a seat',
    });
    await assert.rejects(
      removeCopilotSeat('alice_emu'),
      (err: unknown) => err instanceof CopilotSeatNotAssignedError && err.status === 422,
    );

    globalThis.fetch = async () => jsonResponse(422, {
      message: 'The seat cannot be cancelled because it was assigned through a team.',
    });
    await assert.rejects(
      removeCopilotSeat('alice_emu'),
      (err: unknown) => err instanceof Error && !(err instanceof CopilotSeatNotAssignedError),
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.githubCopilotSeatPat = originalPat;
  }
});

test('lists all enterprise Copilot seat assignments with pagination', async () => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';
  const urls: string[] = [];

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('page=1')) {
        return jsonResponse(200, {
          total_seats: 101,
          seats: Array.from({ length: 100 }, (_, index) => ({ assignee: { login: `user-${index}` }, pending_cancellation_date: null })),
        });
      }
      return jsonResponse(200, {
        total_seats: 101,
        seats: [{ assignee: { login: 'LAST-USER' }, pending_cancellation_date: '2026-10-17' }],
      });
    };

    const assignments = await listCopilotSeatAssignments();

    assert.equal(assignments.size, 101);
    assert.equal(assignments.has('last-user'), true);
    assert.deepEqual(assignments.get('last-user'), { status: 'pending_cancellation', pendingCancellationDate: '2026-10-17' });
    assert.equal(urls.length, 2);
    assert.match(urls[1] ?? '', /page=2$/);
  } finally {
    globalThis.fetch = originalFetch;
    config.githubCopilotSeatPat = originalPat;
  }
});

test('reads only direct seats without ending pagination at the unique user count', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';
  t.after(() => { globalThis.fetch = originalFetch; config.githubCopilotSeatPat = originalPat; });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return jsonResponse(200, {
      total_seats: 2,
      seats: urls.length === 1
        ? Array.from({ length: 100 }, (_, id) => ({
          assignee: { login: 'alice' }, organization: { id: id + 1 }, pending_cancellation_date: null,
        }))
        : [
          { assignee: { login: 'ALICE' }, pending_cancellation_date: '2026-10-01' },
          { assignee: { login: 'alice' }, assigning_team: { id: 1 }, pending_cancellation_date: null },
          { assignee: { login: 'bob' }, organization: null, assigning_team: null, pending_cancellation_date: null },
        ],
    });
  };
  const seats = await listCopilotSeatAssignments();
  assert.equal(urls.length, 2);
  assert.deepEqual([...seats], [
    ['alice', { status: 'pending_cancellation', pendingCancellationDate: '2026-10-01' }],
    ['bob', { status: 'assigned' }],
  ]);
});

test('honors safe pagination links and rejects incomplete or conflicting direct snapshots', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';
  t.after(() => { globalThis.fetch = originalFetch; config.githubCopilotSeatPat = originalPat; });
  let requests = 0;
  globalThis.fetch = async (input) => {
    requests++;
    const next = new URL(String(input));
    next.searchParams.set('page', '2');
    return new Response(JSON.stringify({ seats: [{ assignee: { login: `user-${requests}` }, pending_cancellation_date: null }] }), {
      headers: requests === 1 ? { Link: `<${next.href}>; rel="next"` } : {},
    });
  };
  assert.equal((await listCopilotSeatAssignments()).size, 2);
  assert.equal(requests, 2);
  globalThis.fetch = async () => new Response(JSON.stringify({ seats: [] }), {
    headers: { Link: '<https://other.test/seats>; rel="next"' },
  });
  await assert.rejects(listCopilotSeatAssignments(), /unexpected pagination URL/);
  globalThis.fetch = async (input) => new Response(JSON.stringify({ seats: [] }), {
    headers: { Link: `<${String(input)}>; rel="next"` },
  });
  await assert.rejects(listCopilotSeatAssignments(), /repeated pagination link/);

  for (const date of [undefined, '', '2026-02-30', '2026-10-01T00:00:00Z', 123]) {
    globalThis.fetch = async () => jsonResponse(200, { seats: [{ assignee: { login: 'alice' }, pending_cancellation_date: date }] });
    await assert.rejects(listCopilotSeatAssignments(), /pending_cancellation_date/);
  }
  for (const seats of [
    [{ assignee: {}, pending_cancellation_date: null }],
    [{ assignee: { login: 'alice' }, organization: 'unknown', pending_cancellation_date: null }],
    [
      { assignee: { login: 'alice' }, pending_cancellation_date: null },
      { assignee: { login: 'ALICE' }, pending_cancellation_date: '2026-10-01' },
    ],
  ]) {
    globalThis.fetch = async () => jsonResponse(200, { seats });
    await assert.rejects(listCopilotSeatAssignments(), /invalid|conflicting/);
  }
  globalThis.fetch = async () => jsonResponse(200, {});
  await assert.rejects(listCopilotSeatAssignments(), /seats array/);
  assert.equal(isCancellationDate('2028-02-29'), true);
  assert.equal(isCancellationDate('2026-02-29'), false);
});

test('enterprise member lookup uses a seats array and confirms 404 through the enterprise list', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';
  t.after(() => { globalThis.fetch = originalFetch; config.githubCopilotSeatPat = originalPat; });
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/enterprises\/[^/]+\/members\/ALICE\/copilot$/);
    return jsonResponse(200, { total_seats: 1, seats: [
      { assignee: { login: 'alice' }, pending_cancellation_date: '2026-10-01' },
      { assignee: { login: 'alice' }, organization: { id: 1 }, pending_cancellation_date: null },
    ] });
  };
  assert.deepEqual(await getCopilotSeatAssignment(' ALICE '), { status: 'pending_cancellation', pendingCancellationDate: '2026-10-01' });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return String(input).includes('/members/')
      ? jsonResponse(404, { message: 'Not Found' })
      : jsonResponse(200, { total_seats: 0, seats: [] });
  };
  assert.deepEqual(await getCopilotSeatAssignment('alice'), { status: 'unassigned' });
  assert.equal(urls.length, 2);
  for (const status of [401, 403, 422, 429, 500]) {
    globalThis.fetch = async () => jsonResponse(status, { message: 'Unavailable' });
    await assert.rejects(getCopilotSeatAssignment('alice'), new RegExp(String(status)));
  }
  globalThis.fetch = async () => jsonResponse(404, { message: 'Not Found' });
  await assert.rejects(getCopilotSeatAssignment('alice'), /404/);
  globalThis.fetch = async () => jsonResponse(200, { assignee: { login: 'alice' }, pending_cancellation_date: null });
  await assert.rejects(getCopilotSeatAssignment('alice'), /seats array/);
});

test('mutation responses require a count but never infer a cancellation date', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalPat = config.githubCopilotSeatPat;
  config.githubCopilotSeatPat = 'test-token';
  t.after(() => { globalThis.fetch = originalFetch; config.githubCopilotSeatPat = originalPat; });
  globalThis.fetch = async () => jsonResponse(200, { seats_cancelled: 0 });
  assert.deepEqual((await removeCopilotSeat('alice')).response, { seats_cancelled: 0 });
  globalThis.fetch = async () => jsonResponse(201, { seats_created: 1 });
  assert.equal((await assignCopilotSeat('alice')).status, 201);
  globalThis.fetch = async () => jsonResponse(200, {});
  await assert.rejects(removeCopilotSeat('alice'), /accepted.*invalid seats_cancelled/);
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
