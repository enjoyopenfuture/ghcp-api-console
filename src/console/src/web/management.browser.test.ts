import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import { chromium } from 'playwright';
import type { LoginTaskDto, ManagementOperation, ManagementSelection } from '@ghcp/shared';
import { assertNoAutomaticReads, createConsoleFixture, paths, settle } from './test-support/console-fixture.js';

const customPasswordLabel = 'Use a custom password instead of the default password';

test('admin lists support adjustable pages, cross-page retry overrides and restored navigation', { timeout: 90_000 }, async (t) => {
  const tasks: LoginTaskDto[] = Array.from({ length: 73 }, (_, index) => ({
    id: `task-${String(index).padStart(3, '0')}`, identity: `identity-${index}`, ssoUser: `user-${index}`,
    ghLogin: `gh-${index}`, ssoType: 'custom', status: 'failed', attempts: 1,
    failureReason: 'Fixture login failure', createdAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:00:01.000Z',
  }));
  let submitted: { overrides: Array<{ id: string; password: string }> } | undefined;
  let operation: ManagementOperation | undefined;
  let taskRequests = 0;
  let authenticated = true;
  const exports: { scope?: string; selection?: ManagementSelection }[] = [];
  const app = express();
  app.use(express.json());
  app.get('/api/console/setup', (_req, res) => res.json({ initialized: true }));
  app.get('/api/console/me', (_req, res) => authenticated ? res.json({ username: 'fixture-admin', role: 'admin' }) : res.status(401).json({ error: { code: 'not_authenticated', message: 'Sign in required.' } }));
  app.use('/api/console/login-service', (_req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: { code: 'not_authenticated', message: 'Sign in required.' } }); return; }
    next();
  });
  app.get('/api/console/proxy/accounts/summary', (_req, res) => res.json({ total: 137, counts: { valid: 137 }, updatedAt: new Date().toISOString() }));
  app.get('/api/console/sso/users/summary', (_req, res) => res.json({ total: 146, counts: { active: 146 }, updatedAt: new Date().toISOString() }));
  app.get('/api/console/login-service/tasks/summary', (_req, res) => res.json({ total: tasks.length, counts: { failed: tasks.filter((task) => task.status === 'failed').length }, updatedAt: new Date().toISOString() }));
  app.get('/api/console/proxy/request-stats', (_req, res) => res.json([]));
  app.get('/api/console/login-service/queue', (_req, res) => res.json({ concurrency: 2, pending: [], active: [], cancelling: [], updatedAt: new Date().toISOString() }));
  app.route('/api/console/login-service/tasks/export')
    .get((req, res) => {
      exports.push({ scope: req.query.scope ? String(req.query.scope) : undefined });
      res.attachment('tasks.csv').type('text/csv').send('id,status\ntask-000,failed\n');
    })
    .post((req, res) => {
      exports.push({ selection: req.body.selection });
      res.attachment('tasks.csv').type('text/csv').send('id,status\ntask-000,failed\n');
    });
  app.get('/api/console/login-service/tasks', (req, res) => {
    taskRequests++;
    if (req.query.limit) { res.json(tasks.slice(0, Number(req.query.limit))); return; }
    const statuses = String(req.query.status ?? '').split(',').filter(Boolean);
    const filtered = tasks.filter((task) => (!statuses.length || statuses.includes(task.status)) && (!req.query.q || task.id.includes(String(req.query.q))));
    const pageSize = Number(req.query.pageSize ?? 25);
    const page = Math.min(Number(req.query.page ?? 1), Math.max(1, Math.ceil(filtered.length / pageSize)));
    res.json({ items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize });
  });
  app.get('/api/console/login-service/tasks/:id/attempts', (req, res) => {
    const task = tasks.find((entry) => entry.id === req.params.id)!;
    res.json([{ ...task, id: `attempt-${task.id}`, taskId: task.id, attemptNumber: 1, queuedAt: task.createdAt, historyIncomplete: false }]);
  });
  app.get('/api/console/login-service/tasks/:id', (req, res) => {
    const task = tasks.find((entry) => entry.id === req.params.id);
    if (!task) { res.status(404).json({ error: { code: 'task_not_found', message: 'Task was removed.' } }); return; }
    res.json(task);
  });
  app.get('/api/console/login-service/tasks/:id/attempts/:attemptId/log', (_req, res) => res.json({ content: 'Fixture log preview.', truncated: true }));
  app.post('/api/console/login-service/tasks/operations/preview', (req, res) => {
    const ids = req.body.selection.ids as string[];
    operation = {
      id: 'fixture-operation', scope: 'tasks', action: req.body.action, status: 'preview',
      items: ids.map((id) => ({ id, label: tasks.find((task) => task.id === id)?.identity, status: 'pending' })),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    res.status(201).json(operation);
  });
  app.post('/api/console/login-service/tasks/operations/:id/execute', (req, res) => {
    submitted = req.body;
    operation = { ...operation!, status: 'completed', items: operation!.items.map((item) => ({ ...item, status: 'success' })) };
    for (const item of operation.items) tasks.find((task) => task.id === item.id)!.status = 'success';
    res.status(202).json(operation);
  });
  app.get('/api/console/proxy/accounts', (req, res) => res.json({
    items: [{ identity: String(req.query.q ?? 'identity-26'), ssoUser: 'user-26', ghLogin: 'gh-26', copilotOauthStatus: 'valid', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
    total: 1, page: 1, pageSize: Number(req.query.pageSize ?? 25),
  }));
  app.use(express.static(fileURLToPath(new URL('../../dist/web', import.meta.url))));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.clock.install();
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined }); });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.goto(`${base}/#dashboard`);
  await page.getByText('137', { exact: true }).waitFor();
  await page.getByText('146', { exact: true }).waitFor();
  await page.getByText('73', { exact: true }).waitFor();
  await page.goto(`${base}/#tasks?status=failed&pageSize=25`);
  await page.getByText('73 total / page 1 of 3', { exact: true }).waitFor();
  const beforePause = taskRequests;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); });
  await page.clock.fastForward(300_000);
  assert.equal(taskRequests, beforePause);
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(300_000);
  assert.equal(taskRequests, beforePause, 'Returning to a visible page must not refresh records');
  const refreshed = page.waitForResponse((response) => response.url().includes('/login-service/tasks?'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await refreshed;
  assert.equal(taskRequests, beforePause + 1, 'Manual refresh reads the current list once');
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select task-001', exact: true }).uncheck();
  await page.getByText('24 record(s) selected', { exact: true }).waitFor();
  for (const label of ['Export selected', 'Export page', 'Export matches']) {
    const download = page.waitForEvent('download');
    if (label !== 'Export selected') await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'tasks.csv');
  }
  const selection = exports[0]?.selection;
  assert.deepEqual(selection, { ids: tasks.slice(0, 25).filter((task) => task.id !== 'task-001').map((task) => task.id) });
  assert.equal(exports[1]?.scope, 'page');
  assert.equal(exports[2]?.scope, undefined);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select task-025', exact: true }).check();
  await page.getByText('26 record(s) selected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry failed tasks', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm: retry', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('checkbox', { name: `identity-0 ${customPasswordLabel}`, exact: true }).check();
  await dialog.getByLabel('Password override for task-000', { exact: true }).fill('browser-fixture-override');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  const nextOverride = dialog.getByRole('checkbox', { name: `identity-25 ${customPasswordLabel}`, exact: true });
  assert.equal(await nextOverride.isChecked(), false);
  await nextOverride.check();
  await dialog.getByLabel('Password override for task-025', { exact: true }).fill('browser-fixture-second-override');
  await dialog.getByRole('button', { name: 'Previous', exact: true }).click();
  assert.equal(await dialog.getByLabel('Password override for task-000', { exact: true }).inputValue(), 'browser-fixture-override');
  await dialog.getByRole('button', { name: 'Confirm 26 item(s)', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0, 'Submission does not open a results dialog');
  assert.deepEqual(submitted?.overrides, [
    { id: 'task-000', password: 'browser-fixture-override' },
    { id: 'task-025', password: 'browser-fixture-second-override' },
  ]);
  await page.getByRole('group', { name: 'Selection actions', exact: true }).getByText('0 record(s) selected', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select current page', exact: true }).isChecked(), false);
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption('50');
  await page.getByText('47 total / page 1 of 1', { exact: true }).waitFor();
  assert.match(page.url(), /pageSize=50/);
  await page.getByRole('checkbox', { name: 'Select task-026', exact: true }).check();
  await page.getByRole('button', { name: 'Proxy Accounts', exact: true }).click();
  await page.getByRole('heading', { name: 'Proxy Accounts', exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: 'Login Tasks', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Rows per page', exact: true }).inputValue(), '50');
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-026', exact: true }).isChecked(), true);
  const rowRetry = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select task-026', exact: true }) }).getByRole('button', { name: 'Retry', exact: true });
  await rowRetry.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await rowRetry.evaluate((button) => button === document.activeElement), true);
  const rowActions = page.getByRole('button', { name: 'Actions for task-026', exact: true });
  await rowActions.click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Login task details', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Preview log', exact: true }).click();
  await page.getByText(/Preview truncated at 20 KB/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await rowActions.evaluate((button) => button === document.activeElement), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(() => {
    const header = document.querySelector('header.sticky')!;
    const toolbar = document.querySelector('[data-management-toolbar]')!;
    return toolbar.getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 1;
  });
  const scrollable = await page.locator('table').first().evaluate((table) => {
    const parent = table.parentElement!;
    return getComputedStyle(parent).overflowX === 'auto' && parent.scrollWidth > parent.clientWidth;
  });
  assert.equal(scrollable, true);
  authenticated = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('heading', { name: 'Admin Login', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'session expired' }).waitFor();
  assert.match(page.url(), /pageSize=50/);
  const unauthenticated = page.waitForResponse((response) => response.url().endsWith('/api/console/me'));
  await page.reload();
  await unauthenticated;
  await page.getByRole('heading', { name: 'Admin Login', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
});

test('list actions remain visible before selection and after clearing on desktop and phone lists', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, id, actions] of [
      ['users', 'user-0', ['Sync GH login', 'Assign seat', 'Remove seat', 'Suspend GH login', 'Delete GH login', 'Delete SSO users']],
      ['accounts', 'identity-0', ['Reauthorize selected', 'Delete selected']],
      ['tasks', 'task-failed', ['Retry failed tasks', 'Cancel selected', 'Delete terminal tasks']],
      ['stats', 'request-0', []],
      ['error-diagnostics', 'diagnostic-0', []],
    ] as const) {
      await fixture.goto(route);
      const selected = page.getByRole('group', { name: 'Selection actions', exact: true });
      assert.equal(await page.getByRole('button', { name: /^Select all \d+ matches$/ }).count(), 0);
      const reads = fixture.requests.length;
      for (const name of [...actions, 'Export selected', 'Clear selection']) {
        const button = selected.getByRole('button', { name, exact: true });
        assert.equal(await button.isVisible(), true, `${route}: ${name} is visible without a selection`);
        assert.equal(await button.isDisabled(), true, `${route}: ${name} requires selected records`);
        await button.evaluate((element: HTMLButtonElement) => element.click());
      }
      await settle(page);
      assert.equal(fixture.requests.length, reads, 'Empty-selection controls cannot submit or export');
      assert.equal(await page.getByRole('textbox', { name: 'Search', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: 'Filters', exact: true }).isVisible(), true);
      const toolbarHeightBefore = await page.locator('[data-management-toolbar]').evaluate((element) => element.getBoundingClientRect().height);
      await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
      for (const name of [...actions, 'Export selected', 'Clear selection']) {
        const button = selected.getByRole('button', { name, exact: true });
        assert.equal(await button.isVisible(), true, `${route} at ${width}px: ${name} is directly visible`);
        assert.equal(await button.isEnabled(), true);
        const box = await button.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${route}: ${name} stays within the viewport`);
      }
      assert.equal(await selected.getByRole('button', { name: /^Select all \d+ matches$/ }).count(), 0);
      assert.equal(await selected.locator('[aria-haspopup]').count(), 0, 'No selected action is hidden inside a dropdown');
      if (route === 'users') assert.equal(await selected.getByRole('checkbox', { name: 'Assign seat when syncing GH login', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('dialog').count(), 0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${route} at ${width}px: the expanded toolbar does not widen the document`);
      const toolbarHeightAfter = await page.locator('[data-management-toolbar]').evaluate((element) => element.getBoundingClientRect().height);
      assert.ok(Math.abs(toolbarHeightBefore - toolbarHeightAfter) <= 1, `${route} at ${width}px: selection does not add or remove toolbar rows`);
      await selected.getByRole('button', { name: 'Clear selection', exact: true }).click();
      for (const name of [...actions, 'Export selected', 'Clear selection']) {
        assert.equal(await selected.getByRole('button', { name, exact: true }).isDisabled(), true);
      }
    }
  }
  fixture.assertHealthy();
});

test('current-page selection handles individual deselection and empty search results', { timeout: 30_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('users');
  const controls = page.getByRole('group', { name: 'Selection actions', exact: true });
  const selectPage = page.getByRole('checkbox', { name: 'Select current page', exact: true });
  await selectPage.check();
  await controls.getByText('2 record(s) selected', { exact: true }).waitFor();
  assert.equal(await selectPage.isChecked(), true);
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).uncheck();
  assert.equal(await selectPage.evaluate((element: HTMLInputElement) => element.indeterminate), true);
  await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).uncheck();
  await controls.getByText('0 record(s) selected', { exact: true }).waitFor();
  assert.equal(await controls.getByRole('button', { name: 'Sync GH login', exact: true }).isDisabled(), true);
  assert.equal(await controls.getByRole('button', { name: 'Export selected', exact: true }).isDisabled(), true);
  assert.equal(await controls.getByRole('button', { name: 'Clear selection', exact: true }).isDisabled(), true);
  await selectPage.check();
  await controls.getByText('2 record(s) selected', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('no-fixture-matches');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await settle(page);
  await controls.getByText('0 record(s) selected', { exact: true }).waitFor();
  assert.equal(await controls.getByRole('button', { name: /^Select all \d+ matches$/ }).count(), 0);
  assert.equal(await controls.getByRole('button', { name: 'Delete SSO users', exact: true }).isDisabled(), true);
  assert.equal(await controls.getByRole('button', { name: 'Clear selection', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Select current page', exact: true }).isDisabled(), true);
  assert.equal(fixture.count(`${paths.users}/operations/preview`, 'POST'), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  fixture.assertHealthy();
});

test('SSO sync submits directly once with frozen selected records and inline sync options', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const previewPath = `${paths.users}/operations/preview`;
  const executePath = `${paths.users}/operations/fixture-operation/execute`;
  await fixture.goto('users?q=user-');
  const columns = await page.getByRole('columnheader').allTextContents();
  assert.equal(columns.includes('Last action'), false);
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Assign seat when syncing GH login', exact: true }).check();
  const before = fixture.count(paths.users);
  const releasePreview = fixture.hold(previewPath);
  const releaseExecute = fixture.hold(executePath);
  t.after(() => { releasePreview(); releaseExecute(); });
  const previewRequested = page.waitForRequest((request) => new URL(request.url()).pathname === previewPath);
  const sync = page.getByRole('button', { name: 'Sync GH login', exact: true });
  await sync.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await previewRequested;
  assert.equal(await sync.isDisabled(), true);
  assert.equal(fixture.count(previewPath, 'POST'), 1, 'Rapid clicks cannot create duplicate batches');
  assert.equal(await page.getByRole('dialog').count(), 0);
  const executeRequested = page.waitForRequest((request) => new URL(request.url()).pathname === executePath);
  releasePreview();
  await executeRequested;
  assert.equal(await page.getByRole('dialog').count(), 0, 'Freezing targets never opens a preview dialog');
  assert.equal(await sync.isDisabled(), true, 'Actions stay disabled until execution is accepted');
  assert.deepEqual(fixture.requests.find((request) => request.path === previewPath)?.body, {
    action: 'sync_emu', selection: { ids: ['user-0'] }, options: { assignCopilotSeat: true },
  });
  assert.deepEqual(fixture.requests.find((request) => request.path === executePath)?.body, { assignCopilotSeat: true, overrides: [] });
  assert.deepEqual(data.operation?.items.map((item) => item.id), ['user-0']);
  data.users.push({ ...data.users[0]!, ssoUser: 'user-later' });
  releaseExecute();
  await settle(page);
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(), columns, 'Submitting SSO actions never adds a Last action column');
  assert.equal(await page.locator('td[data-action-status]').count(), 0);
  assert.equal(fixture.count(executePath, 'POST'), 1);
  assert.equal(fixture.count(paths.users), before + 1, 'The accepted operation refreshes the list once');
  assert.equal(fixture.count(paths.capacity), before + 1, 'The same read updates SSO capacity');
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-later', exact: true }).isChecked(), false, 'New matching users are not added to the frozen selection');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Results stay in the list');
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  await page.getByRole('status').filter({ hasText: 'Sync GH login: submitted 1 target(s)' }).waitFor();
  fixture.assertHealthy();
});

test('seat assignment and task cancellation execute directly without confirmation or result dialogs', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  for (const [route, base, id, label, action] of [
    ['users', paths.users, 'user-0', 'Assign seat', 'assign_copilot'],
    ['tasks', paths.tasks, 'task-running', 'Cancel selected', 'cancel'],
  ] as const) {
    await fixture.goto(route);
    await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
    await page.getByRole('button', { name: label, exact: true }).click();
    await settle(page);
    assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
    assert.equal(fixture.count(`${base}/operations/preview`, 'POST'), 1);
    assert.equal(fixture.count(`${base}/operations/fixture-operation/execute`, 'POST'), 1);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  }
  fixture.assertHealthy();
});

test('destructive actions show only a concise confirmation and cancellation never executes', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  for (const [route, base, id, label, action, warning] of [
    ['users', paths.users, 'user-0', 'Remove seat', 'remove_copilot', /not immediate loss of access/],
    ['users', paths.users, 'user-0', 'Suspend GH login', 'suspend_emu', /interrupts their GitHub access/],
    ['users', paths.users, 'user-0', 'Delete GH login', 'delete_emu', /Local SSO users and Proxy records remain/],
    ['users', paths.users, 'user-0', 'Delete SSO users', 'delete_sso', /associated Proxy accounts\/request statistics/],
    ['accounts', paths.accounts, 'identity-0', 'Delete selected', 'delete', /retained request statistics/],
    ['tasks', paths.tasks, 'task-failed', 'Delete terminal tasks', 'delete', /attempt history, and isolated logs/],
  ] as const) {
    await fixture.goto(route);
    await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
    const trigger = page.getByRole('button', { name: label, exact: true });
    const executePath = `${base}/operations/fixture-operation/execute`;
    const before = fixture.count(executePath, 'POST');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: `Confirm: ${action}`, exact: true });
    await dialog.getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).waitFor();
    assert.match(await dialog.innerText(), warning);
    assert.equal(await dialog.getByRole('table').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Refresh status', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('link', { name: 'Export results', exact: true }).count(), 0);
    assert.equal(fixture.count(executePath, 'POST'), before, 'Opening confirmation does not execute');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settle(page);
    assert.equal(fixture.count(executePath, 'POST'), before);
    assert.equal(await trigger.evaluate((button) => button === document.activeElement), true);
    assert.equal(await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).isChecked(), true);
    await trigger.click();
    await dialog.getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await settle(page);
    assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
    assert.equal(fixture.count(executePath, 'POST'), before + 1);
    assert.equal(await page.getByRole('dialog').count(), 0, 'Confirming never replaces the confirmation with a results dialog');
    assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  }
  fixture.assertHealthy();
});

test('direct failures remain visible and retry submission reuses the frozen operation', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const previewPath = `${paths.users}/operations/preview`;
  const operationPath = `${paths.users}/operations/fixture-operation`;
  const executePath = `${operationPath}/execute`;
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  fixture.failures.set(previewPath, { message: 'Fixture cannot freeze selection' });
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture cannot freeze selection' }).waitFor();
  assert.equal(fixture.count(executePath, 'POST'), 0);
  assert.equal(await page.getByRole('button', { name: 'Assign seat', exact: true }).isEnabled(), true);
  fixture.failures.delete(previewPath);
  fixture.failures.set(executePath, { message: 'Fixture submission unavailable' });
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  const result = page.getByRole('region', { name: 'Records', exact: true });
  await page.getByRole('alert').filter({ hasText: 'Fixture submission unavailable' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Select current page', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('button', { name: 'Assign seat', exact: true }).isDisabled(), true, 'An unconfirmed submission cannot start a new batch');
  const previewCount = fixture.count(previewPath, 'POST');
  fixture.failures.delete(executePath);
  await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(previewPath, 'POST'), previewCount, 'Retry uses the same idempotent execute endpoint');
  assert.equal(fixture.count(executePath, 'POST'), 2);
  data.operation = {
    ...data.operation!, status: 'completed',
    items: [{ id: 'user-0', status: 'success' }, { id: 'user-1', status: 'failed', detail: 'Fixture seat assignment failed' }],
  };
  await result.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '1 target(s) failed' }).waitFor();
  await settle(page);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).isChecked(), true);
  await page.getByText('Fixture seat assignment failed', { exact: true }).waitFor();
  assert.equal(await result.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.doesNotMatch(await page.getByRole('alert').filter({ hasText: '1 target(s) failed' }).innerText(), /Last action/);
  await result.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await settle(page);
  assert.deepEqual(data.operation?.items.map((item) => item.id), ['user-1']);
  assert.equal(await page.getByRole('dialog').count(), 0);
  fixture.assertHealthy();
});

test('action failures are dismissible fixed notifications without moving desktop or phone tables', { timeout: 90_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.clock.install();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [route, id, label] of [
      ['users', 'user-0', 'Assign seat'],
      ['tasks', 'task-running', 'Cancel selected'],
      ['accounts', 'identity-0', 'Delete selected'],
    ] as const) {
      await fixture.goto(route);
      await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
      await page.getByRole('button', { name: label, exact: true }).click();
      if (route === 'accounts') await page.getByRole('dialog').getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).click();
      await settle(page);
      const columns = await page.getByRole('columnheader').allTextContents();
      const table = page.getByRole('table');
      const geometry = () => table.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top + window.scrollY, height: rect.height };
      });
      const before = await geometry();
      const detail = 'Fixture action could not finish. '.repeat(60);
      data.operation = { ...data.operation!, status: 'completed', items: [{ id, status: 'failed', detail }] };
      if (route === 'users') await page.clock.fastForward(1100);
      else await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const notification = page.getByRole('alert').filter({ hasText: 'Fixture action could not finish.' });
      await notification.waitFor();
      await settle(page);
      assert.equal(await page.getByRole('region', { name: 'Notifications', exact: true }).evaluate((element) => getComputedStyle(element).position), 'fixed');
      const notices = await page.locator('[data-notification]').evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }).sort((left, right) => left.top - right.top));
      for (let index = 1; index < notices.length; index++) assert.ok(notices[index - 1]!.bottom <= notices[index]!.top, 'Submission and failure notifications never overlap');
      assert.deepEqual(await page.getByRole('columnheader').allTextContents(), columns);
      assert.deepEqual(await geometry(), before, 'Showing failures does not shift or enlarge the table');
      assert.equal(columns.includes('Last action'), false);
      assert.ok(await notification.locator('ul').evaluate((element) => element.scrollHeight > element.clientHeight), 'Long failure details scroll inside the notification');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
      await page.clock.fastForward(6000);
      await notification.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      await notification.waitFor({ state: 'hidden' });
      await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).uncheck();
      await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
      assert.equal(await page.getByRole('alert').count(), 0, 'Ordinary renders do not resurrect a dismissed failure');
      await assertNoAutomaticReads(fixture);
    }
  }
  fixture.assertHealthy();
});

test('single and bulk Proxy reauthorization default to Custom and submit without selecting a provider', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await fixture.goto('accounts');
  const columns = await page.getByRole('columnheader').allTextContents();
  assert.equal(columns.includes('Last action'), false);
  const account = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  await account.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  const single = page.getByRole('dialog', { name: 'Reauthorize Copilot OAuth', exact: true });
  const singleProvider = single.getByRole('combobox', { name: 'SSO type', exact: true });
  const singleOverride = single.getByRole('checkbox', { name: `identity-0 ${customPasswordLabel}`, exact: true });
  assert.equal(await singleProvider.inputValue(), 'custom');
  assert.equal(await singleOverride.isChecked(), false);
  await singleProvider.selectOption('azure');
  assert.equal(await singleOverride.isChecked(), true);
  assert.equal(await singleOverride.isDisabled(), true);
  await single.getByText(/Azure requires a custom password for this account\./).waitFor();
  await single.getByRole('button', { name: 'Create reauthorization task', exact: true }).click();
  await single.getByText('Provide a password override for this account. Azure cannot use the local default password.', { exact: true }).waitFor();
  const singlePath = `${paths.accounts}/identity-0/copilot-oauth/reauthorize`;
  assert.equal(fixture.count(singlePath, 'POST'), 0, 'Azure cannot submit without a password override');
  await single.getByRole('button', { name: 'Cancel', exact: true }).click();
  await account.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  assert.equal(await singleProvider.inputValue(), 'custom', 'Reopening resets the provider to Custom');
  assert.equal(await singleOverride.isChecked(), false);
  assert.equal(await single.locator('input[type="password"]').count(), 0);
  await single.getByRole('button', { name: 'Create reauthorization task', exact: true }).click();
  await single.waitFor({ state: 'hidden' });
  await settle(page);
  assert.equal(fixture.count(singlePath, 'POST'), 1);
  assert.deepEqual(fixture.requests.find((request) => request.path === singlePath)?.body, { credentialMode: 'default', ssoType: 'custom' });

  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('button', { name: 'Reauthorize selected', exact: true }).click();
  const bulk = page.getByRole('dialog', { name: 'Confirm: reauthorize', exact: true });
  const bulkProvider = bulk.getByRole('combobox', { name: 'SSO provider', exact: true });
  const confirm = bulk.getByRole('button', { name: 'Confirm 2 item(s)', exact: true });
  assert.equal(await bulkProvider.inputValue(), 'custom');
  assert.deepEqual(await bulk.getByRole('checkbox').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).checked)), [false, false]);
  assert.equal(await bulk.locator('input[type="password"]').count(), 0);
  assert.equal(await confirm.isEnabled(), true);
  await bulkProvider.selectOption('azure');
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await bulk.getByText('Azure requires a custom password for this account.', { exact: true }).count(), 2);
  await bulk.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Reauthorize selected', exact: true }).click();
  assert.equal(await bulkProvider.inputValue(), 'custom', 'A fresh batch does not retain the previous Azure selection');
  assert.equal(await confirm.isEnabled(), true);
  await confirm.click();
  await bulk.waitFor({ state: 'hidden' });
  await settle(page);
  const executePath = `${paths.accounts}/operations/fixture-operation/execute`;
  assert.equal(fixture.count(executePath, 'POST'), 1);
  assert.deepEqual(fixture.requests.find((request) => request.path === executePath)?.body, { ssoType: 'custom', overrides: [] });
  assert.deepEqual(data.operation?.items.map((item) => item.id), ['identity-0', 'identity-1']);
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(), columns, 'Submitting Proxy actions never adds an action column');
  data.operation = { ...data.operation!, status: 'completed', items: data.operation!.items.map((item) => ({ ...item, status: 'success' })) };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(), columns, 'Completed Proxy actions do not change columns either');
  assert.equal(await page.locator('td[data-action-status]').count(), 0);
  for (const id of ['identity-0', 'identity-1']) assert.equal(await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).isChecked(), false, 'Operation result tracking still clears completed targets');
  assert.equal(fixture.count(executePath, 'POST'), 1, 'Refreshing results does not repeat authorization');
  fixture.assertHealthy();
});

test('credential confirmations still require Azure overrides and preserve passwords on submission failure', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  data.tasks[1]!.ssoType = 'azure';
  await fixture.goto('tasks');
  await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).check();
  await page.getByRole('button', { name: 'Retry failed tasks', exact: true }).click();
  const retry = page.getByRole('dialog', { name: 'Confirm: retry', exact: true });
  const retryConfirm = retry.getByRole('button', { name: 'Confirm 1 item(s)', exact: true });
  await retryConfirm.waitFor();
  assert.equal(await retryConfirm.isDisabled(), true);
  await retry.getByText('Azure requires a custom password for this account.', { exact: true }).waitFor();
  await retry.getByRole('checkbox', { name: `identity-1 / user-1 ${customPasswordLabel}`, exact: true }).check();
  await retry.getByLabel('Password override for task-failed', { exact: true }).fill('fixture-azure-password');
  const executePath = `${paths.operations}/fixture-operation/execute`;
  fixture.failures.set(executePath, { message: 'Fixture credentials submission unavailable' });
  await retryConfirm.click();
  await retry.getByRole('alert').filter({ hasText: 'Fixture credentials submission unavailable' }).waitFor();
  assert.equal(await retry.getByLabel('Password override for task-failed', { exact: true }).inputValue(), 'fixture-azure-password');
  fixture.failures.delete(executePath);
  await retryConfirm.click();
  await retry.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Retry failed tasks: submitted 1 target(s)' }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);

  await fixture.goto('accounts');
  await page.getByRole('checkbox', { name: 'Select identity-0', exact: true }).check();
  await page.getByRole('button', { name: 'Reauthorize selected', exact: true }).click();
  const reauthorize = page.getByRole('dialog', { name: 'Confirm: reauthorize', exact: true });
  const confirm = reauthorize.getByRole('button', { name: 'Confirm 1 item(s)', exact: true });
  await confirm.waitFor();
  assert.equal(await reauthorize.getByRole('combobox', { name: 'SSO provider', exact: true }).inputValue(), 'custom');
  assert.equal(await confirm.isEnabled(), true, 'Custom can use the server-resolved default password');
  await reauthorize.getByRole('combobox', { name: 'SSO provider', exact: true }).selectOption('azure');
  assert.equal(await confirm.isDisabled(), true, 'Azure reauthorization requires an override');
  await reauthorize.getByRole('checkbox', { name: `identity-0 ${customPasswordLabel}`, exact: true }).check();
  await reauthorize.getByLabel('Password override for identity-0', { exact: true }).fill('fixture-proxy-password');
  await confirm.click();
  await reauthorize.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Reauthorize selected: submitted 1 target(s)' }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.deepEqual(fixture.requests.find((request) => request.path === `${paths.accounts}/operations/fixture-operation/execute`)?.body, {
    ssoType: 'azure', overrides: [{ id: 'identity-0', password: 'fixture-proxy-password' }],
  });
  assert.equal(await page.getByRole('dialog').count(), 0);
  fixture.assertHealthy();
});

test('credential checkbox keeps single-account wording stable and preserves custom passwords on failure', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('accounts');
  const account = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  await account.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reauthorize Copilot OAuth', exact: true });
  const checkbox = dialog.getByRole('checkbox', { name: `identity-0 ${customPasswordLabel}`, exact: true });
  const password = dialog.getByLabel('SSO password override', { exact: true });
  const submit = dialog.getByRole('button', { name: 'Create reauthorization task', exact: true });
  const path = `${paths.accounts}/identity-0/copilot-oauth/reauthorize`;
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await password.count(), 0);
  await dialog.getByText('identity-0', { exact: true }).click();
  assert.equal(await checkbox.isChecked(), true, 'The account name labels the custom-password checkbox');
  await submit.click();
  await dialog.getByText('Provide a password override for this account. Azure cannot use the local default password.', { exact: true }).waitFor();
  assert.equal(fixture.count(path, 'POST'), 0);
  await password.fill('discarded-password');
  await checkbox.focus();
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await password.count(), 0);
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await password.inputValue(), '', 'Toggling clears the previous override');
  await password.fill('fixture-single-password');
  fixture.failures.set(path, { message: 'Fixture single reauthorization unavailable' });
  await submit.click();
  await dialog.getByText('Fixture single reauthorization unavailable', { exact: true }).waitFor();
  assert.equal(await password.inputValue(), 'fixture-single-password');
  fixture.failures.delete(path);
  await submit.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(fixture.requests.filter((request) => request.path === path).map((request) => request.body), [
    { credentialMode: 'override', ssoPassword: 'fixture-single-password', ssoType: 'custom' },
    { credentialMode: 'override', ssoPassword: 'fixture-single-password', ssoType: 'custom' },
  ]);
  await account.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await password.count(), 0);
  const provider = dialog.getByRole('combobox', { name: 'SSO type', exact: true });
  await provider.selectOption('azure');
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await checkbox.isDisabled(), true);
  assert.equal(await password.inputValue(), '');
  await provider.selectOption('custom');
  assert.equal(await checkbox.isChecked(), true, 'Switching back to Custom preserves the active credential mode');
  assert.equal(await checkbox.isEnabled(), true);
  await checkbox.uncheck();
  assert.equal(await password.count(), 0);
  await submit.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(fixture.requests.filter((request) => request.path === path).at(-1)?.body, { credentialMode: 'default', ssoType: 'custom' });
  fixture.assertHealthy();
});

for (const action of ['reauthorize', 'retry'] as const) {
  test(`credential checkbox preserves per-account Custom overrides for ${action}`, { timeout: 45_000 }, async (t) => {
    const fixture = await createConsoleFixture(t);
    const { page } = fixture;
    const ids = action === 'reauthorize' ? ['identity-0', 'identity-1'] : ['task-failed', 'task-retry'];
    const labels = action === 'reauthorize' ? ids : ['identity-1 / user-1', 'identity-2 / user-2'];
    await fixture.goto(action === 'reauthorize' ? 'accounts' : 'tasks');
    for (const id of ids) await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
    await page.getByRole('button', { name: action === 'reauthorize' ? 'Reauthorize selected' : 'Retry failed tasks', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Confirm: ${action}`, exact: true });
    const first = dialog.getByRole('checkbox', { name: `${labels[0]} ${customPasswordLabel}`, exact: true });
    const second = dialog.getByRole('checkbox', { name: `${labels[1]} ${customPasswordLabel}`, exact: true });
    const password = dialog.getByLabel(`Password override for ${ids[0]}`, { exact: true });
    const confirm = dialog.getByRole('button', { name: 'Confirm 2 item(s)', exact: true });
    assert.equal(await first.isChecked(), false);
    assert.equal(await second.isChecked(), false);
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    assert.equal(await confirm.isEnabled(), true);
    await dialog.getByText(labels[0]!, { exact: true }).click();
    assert.equal(await first.isChecked(), true);
    assert.equal(await second.isChecked(), false);
    assert.equal(await confirm.isDisabled(), true);
    await password.fill('discarded-password');
    await first.focus();
    await page.keyboard.press('Space');
    assert.equal(await first.isChecked(), false);
    assert.equal(await password.count(), 0);
    assert.equal(await confirm.isEnabled(), true);
    await page.keyboard.press('Space');
    assert.equal(await first.isChecked(), true);
    assert.equal(await password.inputValue(), '');
    assert.equal(await confirm.isDisabled(), true);
    await password.fill('fixture-custom-password');
    assert.equal(await second.isChecked(), false);
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    const base = action === 'reauthorize' ? `${paths.accounts}/operations` : paths.operations;
    assert.deepEqual(fixture.requests.find((request) => request.path === `${base}/fixture-operation/execute`)?.body, {
      ssoType: 'custom', overrides: [{ id: ids[0], password: 'fixture-custom-password' }],
    });
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    fixture.assertHealthy();
  });
}

for (const entry of ['single', 'bulk', 'retry'] as const) {
  test(`credential checkbox layout wraps account names without overflow for ${entry}`, { timeout: 45_000 }, async (t) => {
    const fixture = await createConsoleFixture(t);
    const { page, data } = fixture;
    for (const identity of ['identity-0', `long-${'account'.repeat(20)}`]) {
      data.accounts[0]!.identity = identity;
      data.tasks[1]!.identity = identity;
      await page.setViewportSize({ width: 1280, height: 900 });
      await fixture.goto(entry === 'retry' ? 'tasks' : 'accounts');
      if (identity !== 'identity-0') {
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await settle(page);
      }
      const id = entry === 'retry' ? 'task-failed' : identity;
      if (entry === 'single') {
        await page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${id}`, exact: true }) })
          .getByRole('button', { name: 'Reauthorize', exact: true }).click();
      } else {
        await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
        await page.getByRole('button', { name: entry === 'retry' ? 'Retry failed tasks' : 'Reauthorize selected', exact: true }).click();
      }
      const dialog = page.getByRole('dialog', { name: entry === 'single' ? 'Reauthorize Copilot OAuth' : `Confirm: ${entry === 'retry' ? 'retry' : 'reauthorize'}`, exact: true });
      const label = entry === 'retry' ? `${identity} / user-1` : identity;
      const checkbox = dialog.getByRole('checkbox', { name: `${label} ${customPasswordLabel}`, exact: true });
      await dialog.getByText(/When selected, enter the password for this account\./).waitFor();
      if (entry === 'retry') await dialog.getByText('task-failed', { exact: true }).waitFor();
      await checkbox.check();
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await checkbox.evaluate((input) => {
          const label = input.closest('label')!;
          const dialog = input.closest('[role="dialog"]')!;
          const [checkbox, account, wording, panel, ...controls] = [
            input, input.nextElementSibling!, label.lastElementChild!, dialog, ...dialog.querySelectorAll('input, select, label'),
          ].map((element) => {
            const { top, left, bottom, right } = element.getBoundingClientRect();
            return { top, left, bottom, right };
          });
          return {
            checkbox: checkbox!, account: account!, wording: wording!, dialog: panel!, controls,
            dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            help: document.getElementById(input.getAttribute('aria-describedby')!)?.textContent,
            wordingBackground: getComputedStyle(label.lastElementChild!).backgroundColor,
            accountBackground: getComputedStyle(input.nextElementSibling!).backgroundColor,
          };
        });
        assert.match(bounds.help ?? '', /When selected, enter the password for this account\./);
        assert.notEqual(bounds.wordingBackground, 'rgba(0, 0, 0, 0)', 'Credential wording has a visible background');
        assert.notEqual(bounds.wordingBackground, bounds.accountBackground, 'Credential wording is visually distinct from the account');
        assert.ok(bounds.checkbox.right <= bounds.account.left, 'The checkbox does not overlap the account name');
        if (width === 1280 && identity === 'identity-0') {
          assert.ok(bounds.account.right <= bounds.wording.left, 'Short account and wording share a desktop row');
          for (const element of [bounds.account, bounds.wording]) {
            assert.ok(element.top < bounds.checkbox.bottom && element.bottom > bounds.checkbox.top, 'Account, checkbox and wording are vertically aligned');
          }
        } else {
          assert.ok(bounds.wording.top >= bounds.account.bottom - 1, 'Long or narrow rows wrap wording below the account');
        }
        assert.ok(bounds.dialogOverflow <= 1, `Dialog overflow at ${width}px: ${bounds.dialogOverflow}`);
        assert.ok(bounds.pageOverflow <= 1, `Page overflow at ${width}px: ${bounds.pageOverflow}`);
        for (const control of bounds.controls) {
          assert.ok(control.left >= bounds.dialog.left && control.right <= bounds.dialog.right, 'Credential controls remain inside the dialog');
        }
      }
      await dialog.getByRole('button', { name: entry === 'single' ? 'Cancel' : 'Close', exact: true }).click();
    }
    fixture.assertHealthy();
  });
}

test('ineligible targets show a notification and delayed previews cannot execute after leaving the list', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const users = [...data.users];
  const previewPath = `${paths.users}/operations/preview`;
  const executePath = `${paths.users}/operations/fixture-operation/execute`;
  for (const label of ['Sync GH login', 'Delete SSO users']) {
    data.users = [...users];
    await fixture.goto('users');
    await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
    data.users = [];
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'No eligible targets. Nothing was submitted.' }).waitFor();
    assert.equal(fixture.count(executePath, 'POST'), 0);
    assert.equal(await page.getByRole('dialog').count(), 0, 'An empty eligible set does not show a useless confirmation');
    await page.getByRole('alert').filter({ hasText: 'Fixture record was removed.' }).waitFor();
  }
  data.users = [...users];
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  const release = fixture.hold(previewPath);
  t.after(release);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === previewPath);
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await requested;
  await page.getByRole('button', { name: 'Proxy Accounts', exact: true }).click();
  await page.getByRole('heading', { name: 'Proxy Accounts', exact: true }).waitFor();
  release();
  await settle(page);
  assert.equal(fixture.count(executePath, 'POST'), 0, 'A discarded preview cannot start a mutation on the previous page');
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  fixture.assertHealthy();
});

test('a lost execution response is recovered by Refresh across navigation without a new batch', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const operationPath = `${paths.users}/operations/fixture-operation`;
  const executePath = `${operationPath}/execute`;
  const previewPath = `${paths.users}/operations/preview`;
  await page.clock.install();
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  await page.route(`**${executePath}`, async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'submission is unconfirmed' }).waitFor();
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  assert.equal(await page.getByRole('alert').count(), 0, 'Dismissing an error does not discard its unconfirmed operation');
  assert.equal(data.operation?.status, 'running', 'The server accepted the operation even though its response was lost');
  assert.equal(await page.getByRole('button', { name: 'Sync GH login', exact: true }).isDisabled(), true);
  assert.equal(fixture.count(executePath, 'POST'), 1);
  await page.unroute(`**${executePath}`);
  await assertNoAutomaticReads(fixture);
  await page.getByRole('button', { name: 'Proxy Accounts', exact: true }).click();
  await page.getByRole('heading', { name: 'Proxy Accounts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'SSO Users', exact: true }).click();
  await settle(page);
  await page.getByRole('alert').filter({ hasText: 'previous submission is unconfirmed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sync GH login', exact: true }).isDisabled(), true);
  assert.equal(fixture.count(operationPath), 0, 'Returning to the list does not fetch action status automatically');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Sync GH login', exact: true }).isEnabled(), true);
  assert.equal(fixture.count(operationPath), 1);
  assert.equal(fixture.count(previewPath, 'POST'), 1);
  assert.equal(fixture.count(executePath, 'POST'), 1, 'Recovery only reads the original operation');
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.clock.fastForward(1100);
  await settle(page);
  assert.equal(fixture.count(operationPath), 2, 'A recovered SSO submission is followed without replaying execution');
  await page.getByRole('button', { name: 'Proxy Accounts', exact: true }).click();
  await settle(page);
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('SSO Refresh retains active batches and newer selections without an action column', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const firstPath = `${paths.users}/operations/fixture-operation`;
  const secondPath = `${paths.users}/operations/second-operation`;
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await settle(page);
  const first = data.operation!;
  data.nextOperationId = 'second-operation';
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await settle(page);
  const firstRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select user-0', exact: true }) });
  const secondRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select user-1', exact: true }) });
  data.operations.set(first.id, { ...first, status: 'completed', items: first.items.map((item) => ({ ...item, status: 'success' })) });
  const before = fixture.count(paths.users);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(firstPath), 1);
  assert.equal(fixture.count(secondPath), 1, 'Starting another batch must not lose the earlier active operation');
  assert.equal(fixture.count(paths.users), before + 1, 'Several operation results still trigger one list refresh');
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(await firstRow.getByRole('checkbox').isChecked(), false);
  assert.equal(await secondRow.getByRole('checkbox').isChecked(), true, 'An older successful sync cannot clear selection for the newer seat assignment');
  data.operation = {
    ...data.operation!, status: 'completed',
    items: [{ id: 'user-1', status: 'failed', detail: 'Fixture latest action failed' }],
  };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').getByText('Fixture latest action failed', { exact: true }).waitFor();
  assert.equal(fixture.count(firstPath), 1, 'Completed batches are not fetched again');
  assert.equal(fixture.count(secondPath), 2);
  assert.equal(await secondRow.getByRole('checkbox').isChecked(), true);
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, 'Row feedback stays within the phone layout');
  fixture.assertHealthy();
});

test('expired SSO results retain a failure warning without an action column or replay', { timeout: 30_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  const operationPath = `${paths.users}/operations/fixture-operation`;
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await settle(page);
  fixture.failures.set(operationPath, { status: 404, code: 'operation_not_found', message: 'Fixture operation expired.' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /service no longer has this result/ }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  await page.getByRole('alert').filter({ hasText: 'Fixture operation expired.' }).waitFor();
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1);
  assert.equal(await page.getByRole('button', { name: 'Retry submission', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(operationPath), 1, 'Expired results do not become a permanently failing request');
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1);
  fixture.assertHealthy();
});

test('logout and session expiry clear action snapshots before another administrator signs in', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  const operationPath = `${paths.users}/operations/fixture-operation`;
  await fixture.goto('users');
  for (const exit of ['logout', 'expiry']) {
    await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
    await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
    await settle(page);
    const release = exit === 'expiry' ? fixture.hold(operationPath) : () => {};
    t.after(release);
    if (exit === 'logout') await page.getByRole('button', { name: 'Logout', exact: true }).click();
    else {
      fixture.failures.set(paths.users, { status: 401, code: 'not_authenticated', message: 'Fixture session expired.' });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    }
    await page.getByRole('heading', { name: 'Admin Login', exact: true }).waitFor();
    release();
    fixture.failures.delete(paths.users);
    await page.getByPlaceholder('Password', { exact: true }).fill('fixture-console-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'SSO Users', exact: true }).waitFor();
    await settle(page);
    assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), false);
    const before = fixture.count(operationPath);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await settle(page);
    assert.equal(fixture.count(operationPath), before, 'The new administrator never reads the old action IDs');
  }
  fixture.assertHealthy();
});
