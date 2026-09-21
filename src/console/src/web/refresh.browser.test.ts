import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoAutomaticReads, createConsoleFixture, paths, requestCounts, settle, type ConsoleFixture } from './test-support/console-fixture.js';

const taskReads = [paths.tasks, paths.queue, paths.summary];
const detailPath = `${paths.tasks}/task-running`;
const attemptsPath = `${detailPath}/attempts`;
const operationPath = `${paths.operations}/fixture-operation`;

async function refreshTasks(fixture: ConsoleFixture) {
  const before = taskReads.map((path) => fixture.count(path));
  await fixture.page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(fixture.page);
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), before[index]! + 1, `${path} is read exactly once per Refresh`));
}

test('idle management lists remain manual snapshots, including an active task queue', { timeout: 90_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  await fixture.page.clock.install();
  for (const [hash, endpoint] of [
    ['users', paths.users], ['accounts', paths.accounts], ['stats', paths.stats],
    ['error-diagnostics', paths.diagnostics], ['tasks', paths.tasks],
  ]) {
    await fixture.goto(hash!);
    assert.ok(fixture.count(endpoint!) > 0, `${hash} initially reads its list`);
    await fixture.page.getByRole('table').waitFor();
    const view = fixture.page.getByRole('button', { name: 'View', exact: true });
    await view.click();
    await fixture.page.getByRole('checkbox', { name: 'Compact rows', exact: true }).waitFor();
    await assertNoAutomaticReads(fixture);
    await view.press('Escape');
  }
  assert.equal(fixture.count(paths.queue), 1, 'The active queue loads once when Tasks opens');
  assert.equal(fixture.count(paths.summary), 1, 'The task summary loads once when Tasks opens');
  await fixture.page.getByText('1 / 4', { exact: false }).first().waitFor();
  fixture.assertHealthy();
});

test('Tasks Refresh reads list, queue and summary once and preserves independently stale data', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.clock.install();
  await fixture.goto('tasks');
  taskReads.forEach((path) => assert.equal(fixture.count(path), 1, `${path} initially loads once`));
  const taskRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select task-running', exact: true }) });
  await taskRow.getByText('authorizing', { exact: true }).waitFor();
  data.tasks[0]!.stage = 'waiting-for-manual-refresh';
  data.queue.concurrency = 6;
  await assertNoAutomaticReads(fixture);
  assert.equal(await taskRow.getByText('authorizing', { exact: true }).count(), 1, 'Server changes do not silently replace the task snapshot');
  await refreshTasks(fixture);
  await taskRow.getByText('waiting-for-manual-refresh', { exact: true }).waitFor();
  await page.getByText('1 / 6', { exact: false }).first().waitFor();

  const queueFetched = await page.getByText(/^Queue fetched /).innerText();
  await page.clock.fastForward(60_000);
  fixture.failures.set(paths.queue, { message: 'Queue fixture unavailable' });
  data.tasks[0]!.stage = 'list-still-updates';
  await refreshTasks(fixture);
  await taskRow.getByText('list-still-updates', { exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Queue fixture unavailable' }).waitFor();
  assert.match(await page.getByRole('alert').filter({ hasText: 'Queue fixture unavailable' }).innerText(), /stale|previous|last|snapshot/i);
  assert.ok(await page.getByText('1 / 6', { exact: false }).count(), 'A queue failure retains the previous capacity, not a fake zero');
  assert.equal(await page.getByText(/^Queue fetched /).innerText(), queueFetched, 'Failed queue reads preserve the actual successful fetch time');

  fixture.failures.delete(paths.queue);
  const summaryFetched = (await page.getByText(/^All retained tasks:/).innerText()).match(/Summary fetched (.+)\.$/)?.[1];
  assert.ok(summaryFetched, 'The task summary exposes its own successful fetch time');
  await page.clock.fastForward(60_000);
  fixture.failures.set(paths.summary, { message: 'Summary fixture unavailable' });
  data.queue.concurrency = 8;
  await refreshTasks(fixture);
  await page.getByRole('alert').filter({ hasText: 'Summary fixture unavailable' }).waitFor();
  await page.getByText('1 / 8', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Queue fixture unavailable' }).count(), 0);
  assert.match(await page.locator('main').innerText(), /All retained tasks: 3/);
  assert.equal((await page.getByText(/^All retained tasks:/).innerText()).match(/Summary fetched (.+)\.$/)?.[1], summaryFetched, 'Failed summaries do not acquire a false new timestamp');

  fixture.failures.delete(paths.summary);
  fixture.failures.set(paths.tasks, { message: 'Task list fixture unavailable' });
  await refreshTasks(fixture);
  await page.getByRole('alert').filter({ hasText: 'Task list fixture unavailable' }).waitFor();
  await taskRow.getByText('list-still-updates', { exact: true }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Records', exact: true }).innerText(), /stale|previous/i);
  await assertNoAutomaticReads(fixture);
  fixture.failures.delete(paths.tasks);
  await refreshTasks(fixture);
  assert.equal(await page.getByRole('alert').count(), 0, 'Explicit retry clears only recovered errors');
  fixture.assertHealthy();
});

test('a pending manual task refresh cannot start overlapping requests', { timeout: 30_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('tasks');
  const before = taskReads.map((path) => fixture.count(path));
  const releases = taskReads.map((path) => fixture.hold(path));
  t.after(() => releases.forEach((release) => release()));
  const started = Promise.all(taskReads.map((path) => page.waitForRequest((request) => new URL(request.url()).pathname === path)));
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.click();
  await started;
  assert.equal(await refresh.isDisabled(), true, 'The shared refresh remains disabled until every region settles');
  await refresh.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), before[index]! + 1, `Pending ${path} is not duplicated`));
  releases.forEach((release) => release());
  await settle(page);
  assert.equal(await refresh.isDisabled(), false);
  fixture.assertHealthy();
});

test('running task details load both snapshots once; status and logs update only on explicit requests', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.clock.install();
  await fixture.goto('tasks');
  await page.getByRole('button', { name: 'Actions for task-running', exact: true }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Login task details', exact: true });
  await dialog.getByText('Attempt 1', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(detailPath), 1, 'Opening task details reads the latest task, not just its old list row');
  assert.equal(fixture.count(attemptsPath), 1);
  const logPath = `${attemptsPath}/attempt-task-running/log`;
  assert.equal(fixture.count(logPath), 0, 'Opening details never reads log content');
  const taskListCount = fixture.count(paths.tasks);
  data.tasks[0]!.status = 'success';
  data.tasks[0]!.stage = 'finished';
  data.attempts['task-running']![0]!.status = 'success';
  data.attempts['task-running']![0]!.stage = 'finished';
  await assertNoAutomaticReads(fixture);
  assert.ok(await dialog.getByText('running', { exact: true }).count(), 'An active attempt remains a snapshot');
  const refresh = dialog.getByRole('button', { name: /^Refresh(?:ing)? details/ });
  const releases = [detailPath, attemptsPath].map((path) => fixture.hold(path));
  t.after(() => releases.forEach((release) => release()));
  const requested = Promise.all([detailPath, attemptsPath].map((path) => page.waitForRequest((request) => new URL(request.url()).pathname === path)));
  await refresh.click();
  await requested;
  assert.equal(await refresh.isDisabled(), true);
  await refresh.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  assert.equal(fixture.count(detailPath), 2, 'A pending task snapshot read is not duplicated');
  assert.equal(fixture.count(attemptsPath), 2, 'A pending attempts read is not duplicated');
  releases.forEach((release) => release());
  await dialog.getByText('success', { exact: true }).first().waitFor();
  await settle(page);
  assert.equal(fixture.count(detailPath), 2);
  assert.equal(fixture.count(attemptsPath), 2);
  assert.equal(fixture.count(paths.tasks), taskListCount, 'Refreshing details does not also fetch the parent list');
  assert.equal(fixture.count(logPath), 0, 'Refresh details does not fetch logs');

  await dialog.getByRole('button', { name: /Preview log/i }).click();
  await dialog.getByText('Fixture log preview.', { exact: false }).waitFor();
  assert.equal(fixture.count(logPath), 1);
  assert.match(await dialog.innerText(), /truncat/i);
  await assertNoAutomaticReads(fixture);
  await dialog.getByRole('button', { name: /Preview log/i }).click();
  await settle(page);
  assert.equal(fixture.count(logPath), 2, 'Reopening the preview is an explicit log read');

  fixture.failures.set(attemptsPath, { message: 'Attempt fixture unavailable' });
  await refresh.click();
  await dialog.getByRole('alert').filter({ hasText: 'Attempt fixture unavailable' }).waitFor();
  await dialog.getByText('Attempt 1', { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /stale|previous|snapshot/i);
  await assertNoAutomaticReads(fixture);
  fixture.failures.delete(attemptsPath);
  fixture.failures.set(detailPath, { status: 404, code: 'task_not_found', message: 'Task was removed.' });
  await refresh.click();
  await dialog.getByRole('alert').filter({ hasText: /removed|cleaned up/i }).waitFor();
  await dialog.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('Login Refresh updates results, queue and summary once without an action column or replaying execution', { timeout: 90_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.clock.install();
  await fixture.goto('tasks');
  for (const id of ['task-failed', 'task-retry']) await page.getByRole('checkbox', { name: `Select ${id}`, exact: true }).check();
  await page.getByRole('button', { name: 'Retry failed tasks', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm: retry', exact: true });
  await confirm.getByRole('button', { name: 'Confirm 2 item(s)', exact: true }).waitFor();
  const beforeExecution = taskReads.map((path) => fixture.count(path));
  await confirm.getByRole('button', { name: 'Confirm 2 item(s)', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Retry failed tasks: submitted 2 target(s)' }).waitFor();
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  await settle(page);
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1);
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), beforeExecution[index]! + 1, `Submission reads back ${path} once`));
  assert.equal(fixture.count(operationPath), 0, 'The execution response is the initial operation snapshot');
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).isChecked(), true, 'Accepted tasks remain selected until completion is confirmed');
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-retry', exact: true }).isChecked(), true);

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  data.operation = {
    ...data.operation!, updatedAt: '2026-09-01T12:00:30.000Z',
    items: [
      { id: 'task-failed', status: 'success', detail: 'Fixture task queued' },
      { id: 'task-retry', status: 'running' },
    ],
  };
  data.tasks[1]!.status = 'pending';
  const beforePartial = taskReads.map((path) => fixture.count(path));
  const releaseStatus = fixture.hold(operationPath);
  t.after(releaseStatus);
  const statusRequested = page.waitForRequest((request) => new URL(request.url()).pathname === operationPath);
  await refresh.click();
  await statusRequested;
  assert.equal(await refresh.isDisabled(), true);
  await refresh.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  assert.equal(fixture.count(operationPath), 1, 'A pending status read cannot be duplicated');
  releaseStatus();
  await settle(page);
  assert.equal(fixture.count(operationPath), 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-retry', exact: true }).isChecked(), true);
  const queuedTask = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select task-failed', exact: true }) });
  await queuedTask.getByText('pending', { exact: true }).waitFor();
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), beforePartial[index]! + 1, `Partial results in a still-running batch read back ${path} once`));
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1);

  fixture.failures.set(operationPath, { message: 'Operation status fixture unavailable' });
  await refreshTasks(fixture);
  await page.getByRole('alert').filter({ hasText: 'Operation status fixture unavailable' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-retry', exact: true }).isChecked(), true, 'A failed status read does not falsely report completion');
  await assertNoAutomaticReads(fixture);
  fixture.failures.delete(operationPath);

  data.operation = {
    ...data.operation!, status: 'completed', updatedAt: '2026-09-01T12:01:00.000Z',
    items: [
      { id: 'task-failed', status: 'success', detail: 'Fixture task queued' },
      { id: 'task-retry', status: 'failed', detail: 'Fixture target remains retryable' },
    ],
  };
  await assertNoAutomaticReads(fixture);
  assert.equal(await page.getByText('Fixture target remains retryable', { exact: true }).count(), 0, 'Login results still require manual Refresh');
  const beforeRefresh = taskReads.map((path) => fixture.count(path));
  await refresh.click();
  await page.getByRole('alert').getByText('Fixture target remains retryable', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(operationPath), 3);
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), beforeRefresh[index]! + 1, `Changed operation results read back ${path} once`));
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1, 'Status refresh must never execute again');
  const afterChanged = taskReads.map((path) => fixture.count(path));
  data.operation.updatedAt = '2026-09-01T12:02:00.000Z';
  await refresh.click();
  await settle(page);
  assert.equal(fixture.count(operationPath), 3, 'Terminal results do not need another operation read');
  taskReads.forEach((path, index) => assert.equal(fixture.count(path), afterChanged[index]! + 1, `Refresh still reads ${path} once`));
  assert.equal(fixture.count(`${operationPath}/execute`, 'POST'), 1);
  await assertNoAutomaticReads(fixture);
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).isChecked(), false, 'Successful targets leave the selection');
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-retry', exact: true }).isChecked(), true, 'Failed targets stay selected');
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0, 'There is no result panel to dismiss');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Operation results stay in the list instead of a dialog');
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(fixture.count(paths.operations), 0, 'No operation history is ever listed');
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('SSO follows accepted actions and refreshes actual records and capacity only on completion', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const statusPath = `${paths.users}/operations/fixture-operation`;
  await page.clock.install();
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await settle(page);
  const before = [paths.users, paths.capacity].map((path) => fixture.count(path));
  assert.equal(fixture.count(statusPath), 0);
  await page.clock.fastForward(1100);
  await settle(page);
  assert.equal(fixture.count(statusPath), 1);
  [paths.users, paths.capacity].forEach((path, index) => assert.equal(fixture.count(path), before[index], 'A running result does not repeatedly reload the list'));
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), true);
  data.users[0]!.ghLogin = 'gh-automatically-synced';
  data.operation = { ...data.operation!, status: 'completed', items: [{ id: 'user-0', status: 'success' }] };
  await page.clock.fastForward(2100);
  await page.getByRole('cell', { name: 'gh-automatically-synced', exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(statusPath), 2);
  [paths.users, paths.capacity].forEach((path, index) => assert.equal(fixture.count(path), before[index]! + 1, 'Completion refreshes the list and capacity exactly once'));
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), false);
  await page.getByRole('status').filter({ hasText: 'Sync GH login: completed 1 target(s)' }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(fixture.count(`${statusPath}/execute`, 'POST'), 1);
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('automatic SSO completion retains newer batch selections and reports their failures', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const firstPath = `${paths.users}/operations/fixture-operation`;
  const secondPath = `${paths.users}/operations/second-operation`;
  await page.clock.install();
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select current page', exact: true }).check();
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await settle(page);
  const first = data.operation!;
  data.nextOperationId = 'second-operation';
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await settle(page);
  data.operations.set(first.id, { ...first, status: 'completed', items: first.items.map((item) => ({ ...item, status: 'success' })) });
  const before = fixture.count(paths.users);
  await page.clock.fastForward(1100);
  await settle(page);
  assert.equal(fixture.count(firstPath), 1);
  assert.equal(fixture.count(secondPath), 1);
  assert.equal(fixture.count(paths.users), before + 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).isChecked(), true, 'An older completion cannot clear a newer action selection');
  data.operation = { ...data.operation!, status: 'completed', items: [{ id: 'user-1', status: 'failed', detail: 'Fixture later action failed' }] };
  await page.clock.fastForward(2100);
  await page.getByRole('alert').getByText('Fixture later action failed', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(firstPath), 1);
  assert.equal(fixture.count(secondPath), 2);
  assert.equal(fixture.count(paths.users), before + 2, 'A failed completion also refreshes actual record state');
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-1', exact: true }).isChecked(), true);
  for (const path of [firstPath, secondPath]) assert.equal(fixture.count(`${path}/execute`, 'POST'), 1);
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('SSO automatic tracking is bounded to two minutes without reporting success or replaying', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  const statusPath = `${paths.users}/operations/fixture-operation`;
  await page.clock.install();
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  await page.getByRole('button', { name: 'Sync GH login', exact: true }).click();
  await settle(page);
  const listReads = fixture.count(paths.users);
  for (let interval = 0; interval < 24; interval++) {
    await page.clock.fastForward(5000);
    await settle(page);
  }
  const notice = page.getByRole('status').filter({ hasText: 'Automatic tracking stopped after two minutes' });
  await notice.waitFor();
  const reads = fixture.count(statusPath);
  assert.ok(reads > 1 && reads <= 25, `Status reads are bounded, received ${reads}`);
  assert.equal(fixture.count(paths.users), listReads, 'Running status checks never reload unchanged records');
  assert.equal(fixture.count(`${statusPath}/execute`, 'POST'), 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), true, 'A tracking timeout is not successful completion');
  await assertNoAutomaticReads(fixture);
  await notice.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await notice.waitFor({ state: 'hidden' });
  fixture.assertHealthy();
});

test('SSO tracking stops on read errors, expiration and hung requests while manual recovery stays usable', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const statusPath = `${paths.users}/operations/fixture-operation`;
  await page.clock.install();
  for (const failure of ['unavailable', 'expired', 'timeout'] as const) {
    await fixture.goto('users');
    await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
    await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
    await settle(page);
    const before = fixture.count(statusPath);
    const executions = fixture.count(`${statusPath}/execute`, 'POST');
    const release = failure === 'timeout' ? fixture.hold(statusPath) : () => {};
    t.after(release);
    if (failure !== 'timeout') fixture.failures.set(statusPath, {
      status: failure === 'expired' ? 404 : 503, message: `Fixture status ${failure}`,
    });
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === statusPath);
    await page.clock.fastForward(1100);
    await requested;
    if (failure === 'timeout') await page.clock.fastForward(15_000);
    const error = page.getByRole('alert').filter({ hasText: failure === 'timeout' ? 'Automatic status check timed out' : `Fixture status ${failure}` });
    await error.waitFor();
    await settle(page);
    assert.equal(fixture.count(statusPath), before + 1);
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true);
    if (failure === 'expired') await error.getByText(/service no longer has this result/).waitFor();
    await assertNoAutomaticReads(fixture);
    release();
    fixture.failures.delete(statusPath);
    await error.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    data.operation = { ...data.operation!, status: 'completed', items: [{ id: 'user-0', status: 'success' }] };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await settle(page);
    assert.equal(fixture.count(statusPath), before + (failure === 'expired' ? 1 : 2));
    assert.equal(fixture.count(`${statusPath}/execute`, 'POST'), executions, 'Read recovery never resubmits');
    if (failure !== 'expired') assert.equal(await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).isChecked(), false);
  }
  fixture.assertHealthy();
});

test('leaving SSO aborts in-flight follow-up and returning never resumes old polling', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  const statusPath = `${paths.users}/operations/fixture-operation`;
  await page.clock.install();
  await fixture.goto('users');
  await page.getByRole('checkbox', { name: 'Select user-0', exact: true }).check();
  await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
  await settle(page);
  const release = fixture.hold(statusPath);
  t.after(release);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === statusPath);
  await page.clock.fastForward(1100);
  await requested;
  await page.getByRole('button', { name: 'Proxy Accounts', exact: true }).click();
  await settle(page);
  release();
  await assertNoAutomaticReads(fixture);
  await page.getByRole('button', { name: 'SSO Users', exact: true }).click();
  await settle(page);
  await assertNoAutomaticReads(fixture);
  assert.equal(fixture.count(statusPath), 1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(statusPath), 2, 'The saved operation is still available for manual recovery');
  assert.equal(fixture.count(`${statusPath}/execute`, 'POST'), 1);
  fixture.assertHealthy();
});

test('creating a user refreshes the visible list and capacity only once', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await page.clock.install();
  await fixture.goto('users');
  assert.equal(fixture.count(paths.users), 1);
  assert.equal(fixture.count(paths.capacity), 1, 'Initial capacity follows the initial user result once');
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create SSO user', exact: true });
  await dialog.getByLabel('SSO user', { exact: true }).fill('new-fixture-user');
  await dialog.getByLabel('Email', { exact: true }).fill('new-fixture-user@example.test');
  await dialog.getByRole('button', { name: 'Create user', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select new-fixture-user', exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(paths.users, 'POST'), 1);
  assert.equal(fixture.count(paths.users), 2);
  assert.equal(fixture.count(paths.capacity), 2, 'Capacity is not fetched both by mutation and list success');
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('account details refresh the account and recent requests together without background reads', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const accountPath = `${paths.accounts}/identity-0`;
  const statsPath = `${accountPath}/request-stats`;
  await page.clock.install();
  await fixture.goto('accounts');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  await row.getByRole('button', { name: 'Details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Account identity-0', exact: true });
  await dialog.getByText('fixture-model', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(accountPath), 1, 'Initial details read the latest account');
  assert.equal(fixture.count(statsPath), 1, 'Initial details also read recent requests');
  const parentListCount = fixture.count(paths.accounts);
  data.accounts[0]!.ghLogin = 'new-fixture-gh-login';
  data.stats[0]!.model = 'new-fixture-model';
  await assertNoAutomaticReads(fixture);
  await dialog.getByText('gh-0', { exact: true }).waitFor();
  await dialog.getByText('fixture-model', { exact: true }).waitFor();
  const refresh = dialog.getByRole('button', { name: 'Refresh details', exact: true });
  await refresh.click();
  await dialog.getByText('new-fixture-gh-login', { exact: true }).waitFor();
  await dialog.getByText('new-fixture-model', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(accountPath), 2);
  assert.equal(fixture.count(statsPath), 2);

  for (const [path, message] of [
    [accountPath, 'Account fixture unavailable'],
    [statsPath, 'Recent requests fixture unavailable'],
  ]) {
    const beforeAccount = fixture.count(accountPath);
    const beforeStats = fixture.count(statsPath);
    fixture.failures.set(path!, { message: message! });
    await refresh.click();
    await dialog.getByRole('alert').filter({ hasText: message! }).waitFor();
    await settle(page);
    assert.equal(fixture.count(accountPath), beforeAccount + 1);
    assert.equal(fixture.count(statsPath), beforeStats + 1);
    assert.match(await dialog.innerText(), /stale/i);
    await dialog.getByText('new-fixture-gh-login', { exact: true }).waitFor();
    await dialog.getByText('new-fixture-model', { exact: true }).waitFor();
    await assertNoAutomaticReads(fixture);
    fixture.failures.delete(path!);
  }
  await refresh.click();
  await settle(page);
  assert.equal(await dialog.getByRole('alert').count(), 0);
  assert.equal(fixture.count(paths.accounts), parentListCount, 'Account-detail refresh does not refetch the list');
  await dialog.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await assertNoAutomaticReads(fixture);
  fixture.assertHealthy();
});

test('closing details and navigating away prevents a delayed response from changing the new page', { timeout: 30_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('tasks');
  const release = fixture.hold(attemptsPath);
  t.after(release);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === attemptsPath);
  await page.getByRole('button', { name: 'Actions for task-running', exact: true }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await requested;
  const dialog = page.getByRole('dialog', { name: 'Login task details', exact: true });
  await dialog.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(() => { window.location.hash = 'accounts'; });
  await page.getByRole('heading', { name: 'Proxy Accounts', exact: true }).waitFor();
  release();
  await settle(page);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByText('Attempt 1', { exact: true }).count(), 0);
  const before = requestCounts(fixture);
  await page.clock.install();
  await assertNoAutomaticReads(fixture);
  assert.deepEqual(requestCounts(fixture), before);
  fixture.assertHealthy();
});
