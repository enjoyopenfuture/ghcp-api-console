import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCopilotSeat, statusTone } from './format.js';

test('pending direct seats display the exact cancellation label without timezone conversion', () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = timezone;
      assert.equal(formatCopilotSeat('pending_cancellation', '2026-10-01'), 'cancell at 2026-10-01');
      assert.equal(formatCopilotSeat('pending_cancellation', '2000-01-01'), 'cancell at 2000-01-01');
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  assert.equal(formatCopilotSeat('assigned'), 'assigned');
  assert.equal(formatCopilotSeat('unassigned', '2026-10-01'), 'unassigned');
  assert.equal(formatCopilotSeat('pending_cancellation'), 'cancell at (date unavailable)');
  assert.equal(statusTone('pending_cancellation'), 'warning');
});
