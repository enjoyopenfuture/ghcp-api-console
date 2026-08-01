import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import { CopilotSeatNotAssignedError, listCopilotSeatAssignments, removeCopilotSeat } from './seats.js';

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
          seats: Array.from({ length: 100 }, (_, index) => ({ assignee: { login: `user-${index}` } })),
        });
      }
      return jsonResponse(200, {
        total_seats: 101,
        seats: [{ assignee: { login: 'LAST-USER' } }],
      });
    };

    const assignments = await listCopilotSeatAssignments();

    assert.equal(assignments.size, 101);
    assert.equal(assignments.has('last-user'), true);
    assert.equal(urls.length, 2);
    assert.match(urls[1] ?? '', /page=2$/);
  } finally {
    globalThis.fetch = originalFetch;
    config.githubCopilotSeatPat = originalPat;
  }
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
