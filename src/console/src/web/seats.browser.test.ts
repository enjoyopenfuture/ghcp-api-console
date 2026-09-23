import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImportEmuPlanDto, ImportEmuUserRow } from '@ghcp/shared';
import { createConsoleFixture, paths, settle } from './test-support/console-fixture.js';

test('direct seat cancellation dates, filters and import snapshots render consistently', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  Object.assign(data.users[0]!, { copilotSeatStatus: 'pending_cancellation', copilotSeatPendingCancellationDate: '2000-01-01' });
  data.users.push({ ...data.users[1]!, ssoUser: 'user-2', copilotSeatStatus: 'unassigned' });
  await fixture.goto('users');
  const label = page.getByText('cancell at 2000-01-01', { exact: true });
  await label.waitFor();
  assert.match(await label.getAttribute('class') ?? '', /ui-badge--warning/);
  assert.equal(await page.getByText('assigned', { exact: true }).count(), 1);
  assert.equal(await page.getByText('unassigned', { exact: true }).count(), 1);
  await page.getByText(/enterprise direct assignments only/).waitFor();

  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Copilot seat', exact: true }).selectOption('pending_cancellation');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await settle(page);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).count(), 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).count(), 0);
  assert.equal(fixture.requests.filter((request) => request.path === paths.users).at(-1)?.query.seatStatus, 'pending_cancellation');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await settle(page);

  const rows: ImportEmuUserRow[] = [{
    rowIndex: 1, ssoUser: 'user-1', ghLogin: 'gh-1', status: 'pending_update',
    copilotSeatStatus: 'pending_cancellation', copilotSeatPendingCancellationDate: '2026-10-17',
    detail: 'Update the enterprise direct seat snapshot.',
  }];
  let applied = false;
  const importRequests: string[] = [];
  await page.route('**/api/console/sso/users/emu/import/plans**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    importRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/apply')) {
      applied = true;
      Object.assign(data.users[1]!, { copilotSeatStatus: 'pending_cancellation', copilotSeatPendingCancellationDate: '2026-10-17' });
      rows[0]!.status = 'updated';
    }
    const plan: ImportEmuPlanDto = {
      planId: 'seat-plan', status: applied ? 'applied' : 'planned', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
      summary: { total: 1, pendingCreate: 0, pendingUpdate: applied ? 0 : 1, created: 0, updated: applied ? 1 : 0, skipped: 0, conflict: 0, failed: 0, actionable: applied ? 0 : 1 },
    };
    await route.fulfill({ json: url.pathname.endsWith('/rows') ? { items: rows, page: 1, pageSize: 25, total: 1 } : plan });
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('button', { name: 'Import from GH', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import SSO users from GH', exact: true });
  await dialog.getByRole('button', { name: 'Preview alignment', exact: true }).click();
  await dialog.getByText('Direct Copilot seat: cancell at 2026-10-17', { exact: true }).waitFor();
  assert.equal(data.users[1]!.copilotSeatStatus, 'assigned', 'Preview does not apply changes');
  await dialog.getByRole('button', { name: 'Apply safe changes', exact: true }).click();
  await settle(page);
  await dialog.getByRole('listitem').getByText('updated', { exact: true }).waitFor();
  assert.equal(importRequests.filter((request) => request.endsWith('/apply')).length, 1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('cancell at 2026-10-17', { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const date = page.getByText('cancell at 2026-10-17', { exact: true });
  await date.scrollIntoViewIfNeeded();
  assert.equal(await date.isVisible(), true);
  assert.equal(await date.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'The cancellation label is not clipped');
  fixture.assertHealthy();
});
