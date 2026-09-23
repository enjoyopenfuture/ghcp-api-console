import assert from 'node:assert/strict';
import test from 'node:test';
import type { Locator, Page } from 'playwright';
import { createConsoleFixture, paths, settle } from './test-support/console-fixture.js';

const pages = [
  ['dashboard', 'Dashboard'], ['users', 'SSO Users'], ['budgets', 'AI Credits Usage'],
  ['stats', 'Request Stats'], ['accounts', 'Proxy Accounts'], ['tasks', 'Login Tasks'],
  ['settings', 'Settings'], ['error-diagnostics', 'Error Diagnostics'], ['diagnostics', 'Diagnostics'],
] as const;
const listPages = new Set(['users', 'stats', 'accounts', 'tasks', 'error-diagnostics']);

async function assertContainedLayout(page: Page, label: string, requireScrollableTable = false) {
  const geometry = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('main table'));
    return {
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      tables: tables.map((table) => {
        let container = table.parentElement;
        while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowX)) container = container.parentElement;
        return {
          shared: table.classList.contains('ui-table'),
          scrollable: Boolean(container && container.scrollWidth > container.clientWidth),
          contained: Boolean(container && container.getBoundingClientRect().width <= window.innerWidth + 1),
          tableWidth: table.getBoundingClientRect().width,
          availableWidth: container?.clientWidth ?? window.innerWidth,
        };
      }),
    };
  });
  assert.ok(geometry.overflow <= 1, `${label}: document overflow is ${geometry.overflow}px`);
  for (const table of geometry.tables) {
    assert.equal(table.shared, true, `${label}: every table uses the shared Table primitive`);
    if (table.tableWidth > table.availableWidth + 1) {
      assert.ok(table.scrollable && table.contained, `${label}: a wide table scrolls inside its own contained region`);
    }
  }
  if (requireScrollableTable) assert.ok(geometry.tables.some((table) => table.scrollable && table.contained), `${label}: narrow layouts retain a readable, locally scrolling table`);
}

async function assertSurfaceContrast(page: Page, label: string) {
  const surfaces = await page.locator('main table').evaluateAll((tables) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const colors = {
      rgba(color: string) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      },
      luminance(color: number[], background: number[]) {
        const alpha = color[3]! / 255;
        const rgb = color.slice(0, 3).map((channel, index) => {
          channel = channel * alpha + background[index]! * (1 - alpha);
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      },
    };
    const borders = tables.map((table) => {
      const elements = [table, table.parentElement!, ...table.querySelectorAll('thead, tr, th, td')];
      return elements.flatMap((element) => {
        const style = getComputedStyle(element);
        let surface: Element | null = element;
        let background = colors.rgba(style.backgroundColor);
        while (surface && background[3] !== 255) {
          surface = surface.parentElement;
          if (surface) background = colors.rgba(getComputedStyle(surface).backgroundColor);
        }
        return ['top', 'right', 'bottom', 'left'].flatMap((side) => {
          const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
          const borderStyle = style.getPropertyValue(`border-${side}-style`);
          if (!(width > 0) || borderStyle === 'none') return [];
          const color = style.getPropertyValue(`border-${side}-color`);
          const border = colors.rgba(color);
          if (border[3] === 0) return [];
          return [{ color, foreground: style.color, border: colors.luminance(border, background), text: colors.luminance(colors.rgba(style.color), background) }];
        });
      });
    });
    const actions = Array.from(document.querySelectorAll<HTMLElement>('.console-admin .ui-button--secondary:not(:disabled), .console-admin .ui-action-card:not(:disabled)'))
      .filter((element) => element.getClientRects().length).map((element) => {
        const style = getComputedStyle(element);
        const background = colors.rgba(style.backgroundColor);
        const border = colors.rgba(style.borderTopColor);
        const backgroundLuminance = colors.luminance(background, background);
        const borderLuminance = colors.luminance(border, background);
        return {
          label: element.getAttribute('aria-label') ?? element.textContent,
          width: Number.parseFloat(style.borderTopWidth),
          style: style.borderTopStyle,
          opaque: background[3] === 255 && border[3] === 255,
          contrast: (Math.max(backgroundLuminance, borderLuminance) + 0.05) / (Math.min(backgroundLuminance, borderLuminance) + 0.05),
          cursor: style.cursor,
          height: element.getBoundingClientRect().height,
        };
      });
    return { borders, actions };
  });
  for (const tableBorders of surfaces.borders) {
    assert.ok(tableBorders.length > 0, `${label}: table separators are explicitly rendered`);
    for (const border of tableBorders) {
      assert.ok(border.border > border.text && border.border > 0.15,
        `${label}: table border ${border.color} must be lighter than text ${border.foreground}, not inherited near-black`);
    }
  }
  assert.ok(surfaces.actions.length, `${label}: secondary actions are present`);
  for (const action of surfaces.actions) {
    assert.ok(action.width >= 1 && action.style === 'solid' && action.opaque, `${label}: ${action.label} has a solid visible boundary and surface`);
    assert.ok(action.contrast >= 3, `${label}: ${action.label} boundary contrast is at least 3:1 (actual ${action.contrast.toFixed(2)})`);
    assert.equal(action.cursor, 'pointer', `${label}: ${action.label} has an interactive cursor`);
    assert.ok(action.height >= 32, `${label}: ${action.label} retains a usable hit target`);
  }
}

async function buttonAppearance(button: Locator) {
  return button.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderColor, outline: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
}

test('all nine admin pages share contained desktop and phone layouts with light table separators', { timeout: 120_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [hash, title] of pages) {
      await fixture.goto(hash);
      await page.locator('header').getByRole('heading', { name: title, exact: true }).waitFor();
      const label = `${hash} at ${viewport.width}px`;
      assert.equal(await page.getByRole('alert').count(), 0, `${label}: fixture data loads without errors`);
      await assertContainedLayout(page, label, viewport.width === 390 && listPages.has(hash));
      await assertSurfaceContrast(page, label);
      assert.equal(await page.locator('main table a[href]').count(), 0, `${label}: records do not navigate to related pages`);
      assert.equal(await page.locator('.console-admin .ui-button--ghost').count(), 0, `${label}: standalone actions are not unframed text`);
      if (listPages.has(hash)) {
        const selection = page.getByRole('group', { name: 'Selection actions', exact: true });
        assert.equal(await selection.isVisible(), true, `${label}: selection controls are permanent`);
        await selection.getByText('0 record(s) selected', { exact: true }).waitFor();
        for (const button of await selection.getByRole('button').all()) {
          const name = await button.getAttribute('aria-label') ?? await button.innerText();
          assert.equal(await button.isDisabled(), !name.startsWith('Select all'), `${label}: ${name} has a safe empty-selection state`);
        }
        assert.equal(await page.getByRole('spinbutton', { name: 'Go to page', exact: true }).count(), 0, `${label}: a single page has no useless jump input`);
        assert.equal(await page.locator('[data-management-toolbar]').evaluate((element) => getComputedStyle(element).position), 'sticky');
      }
      fixture.assertHealthy();
    }
  }
});

test('dashboard and account details retain compact summary columns, totals and empty states', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await fixture.goto('dashboard');
  const tasks = page.locator('main table').nth(0);
  const requests = page.locator('main table').nth(1);
  const requestColumns = ['Identity', 'Path', 'Model', 'Outcome', 'Total', 'Failure'];
  assert.deepEqual(await tasks.getByRole('columnheader').allTextContents(), ['Identity', 'SSO user', 'Status', 'Failure']);
  assert.deepEqual(await requests.getByRole('columnheader').allTextContents(), requestColumns);
  assert.equal(await tasks.getAttribute('data-density'), 'compact');
  assert.equal(await requests.getAttribute('data-density'), 'compact');
  assert.equal(await tasks.locator('tbody tr').count(), 2, 'The dashboard keeps only failed tasks');
  assert.equal(await tasks.getByRole('checkbox').count(), 0);
  assert.equal(await requests.getByRole('cell', { name: '1,385', exact: true }).count(), 1, 'Totals include both cache token fields');
  await tasks.getByTitle('Fixture authorization failure', { exact: true }).waitFor();
  await requests.getByTitle('Fixture upstream request failed', { exact: true }).waitFor();

  await fixture.goto('accounts');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  await row.getByRole('button', { name: 'Details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Account identity-0', exact: true });
  await dialog.getByText('fixture-model', { exact: true }).waitFor();
  const details = dialog.getByRole('table');
  assert.deepEqual(await details.getByRole('columnheader').allTextContents(), requestColumns);
  assert.equal(await details.getAttribute('data-density'), 'compact');
  assert.equal(await details.getByRole('cell', { name: '1,385', exact: true }).count(), 1);
  data.stats[0]!.cacheTokens = 200;
  await dialog.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await details.getByRole('cell', { name: '1,475', exact: true }).waitFor();
  data.stats.length = 0;
  await dialog.getByRole('button', { name: 'Refresh details', exact: true }).click();
  const emptyDetails = details.getByRole('cell', { name: 'No request stats found.', exact: true });
  await emptyDetails.waitFor();
  assert.equal(await emptyDetails.getAttribute('colspan'), '6');
  await dialog.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  data.tasks.length = 0;
  await fixture.goto('dashboard');
  assert.equal(await tasks.getByRole('cell', { name: 'No login tasks found.', exact: true }).getAttribute('colspan'), '4');
  assert.equal(await requests.getByRole('cell', { name: 'No request stats found.', exact: true }).getAttribute('colspan'), '6');
  fixture.assertHealthy();
});

test('list toolbars expose contextual actions, accessible tooltips and persistent View controls', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('accounts');
  const records = page.getByRole('region', { name: 'Records', exact: true });
  const toolbar = page.locator('[data-management-toolbar]');
  for (const name of ['Search', 'Filters', 'Refresh', 'Export', 'View']) {
    assert.equal(await toolbar.getByRole('button', { name, exact: true }).isVisible(), true, `${name} has an explicit accessible entry point`);
  }
  const firstRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  assert.equal(await firstRow.getByRole('button', { name: 'Details', exact: true }).isVisible(), true);
  assert.equal(await firstRow.getByRole('button', { name: 'Reauthorize', exact: true }).isVisible(), true);
  const copy = page.getByRole('button', { name: 'Copy identity-0', exact: true });
  const description = await copy.getAttribute('aria-describedby');
  assert.ok(description, 'The copy icon is associated with its tooltip');
  const tooltip = page.locator('[role="tooltip"]').filter({ hasText: 'Copy value' });
  assert.ok(await tooltip.count());
  await copy.focus();
  await page.waitForFunction((id) => {
    const tip = document.getElementById(id);
    return tip && tip.getAttribute('role') === 'tooltip' && getComputedStyle(tip).opacity === '1';
  }, description.split(' ').at(-1)!);
  const copyBox = await copy.boundingBox();
  assert.ok(copyBox && copyBox.width >= 24 && copyBox.height >= 24, 'Icon targets remain operable');
  assert.match(await copy.ariaSnapshot(), /button "Copy identity-0"/);

  const view = toolbar.getByRole('button', { name: 'View', exact: true });
  await view.click();
  assert.equal(await view.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('menu').count(), 0, 'The dropdown uses ordinary controls, not an incomplete ARIA menu');
  await page.getByRole('checkbox', { name: 'GH login', exact: true }).uncheck();
  assert.equal(await view.getAttribute('aria-expanded'), 'true', 'Changing a column must not close View');
  await page.getByRole('checkbox', { name: 'Compact rows', exact: true }).check();
  assert.equal(await view.getAttribute('aria-expanded'), 'true', 'Changing density must not close View');
  assert.equal(await records.getByRole('table').getAttribute('data-density'), 'compact');
  assert.equal(await records.getByRole('columnheader', { name: 'GH login', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Compact rows', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await view.getAttribute('aria-expanded'), 'false');
  assert.equal(await view.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the dropdown trigger');
  await page.reload();
  await settle(page);
  assert.equal(await records.getByRole('columnheader', { name: 'GH login', exact: true }).count(), 0, 'Column preferences survive reload');
  assert.equal(await records.getByRole('table').getAttribute('data-density'), 'compact', 'The rendered density survives reload');
  await view.click();
  assert.equal(await page.getByRole('checkbox', { name: 'Compact rows', exact: true }).isChecked(), true, 'Density survives reload');
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Compact rows', exact: true }).waitFor({ state: 'hidden' });

  await page.getByRole('checkbox', { name: 'Select identity-0', exact: true }).check();
  const selection = page.getByRole('group', { name: 'Selection actions', exact: true });
  await selection.getByText('1 record(s) selected', { exact: true }).waitFor();
  assert.equal(await firstRow.getAttribute('data-selected'), 'true', 'Selected rows carry the shared visual state');
  assert.equal(await toolbar.getByRole('textbox', { name: 'Search', exact: true }).isVisible(), true, 'Search remains available with a selection');
  assert.equal(await toolbar.getByRole('button', { name: 'Filters', exact: true }).isVisible(), true);
  assert.equal(await selection.getByRole('button', { name: 'Reauthorize selected', exact: true }).isVisible(), true);
  assert.equal(await selection.getByRole('button', { name: 'Selection actions', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Select all \d+ matches$/ }).count(), 0);
  await page.getByRole('button', { name: 'Export selected', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete selected', exact: true }).waitFor();
  await assertContainedLayout(page, 'Expanded selection toolbar');
  await selection.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await selection.getByText('0 record(s) selected', { exact: true }).waitFor();
  await toolbar.getByRole('textbox', { name: 'Search', exact: true }).waitFor();
  assert.equal(await selection.getByRole('button', { name: 'Reauthorize selected', exact: true }).isDisabled(), true);
  assert.equal(await selection.getByRole('button', { name: 'Delete selected', exact: true }).isDisabled(), true);
  assert.equal(await selection.getByRole('button', { name: 'Export selected', exact: true }).isDisabled(), true);
  assert.equal(await firstRow.getAttribute('data-selected'), 'false');

  assert.equal(await toolbar.getByRole('button', { name: 'List actions', exact: true }).count(), 0, 'There is no operation history menu');
  const requestsBeforeDraft = fixture.count(paths.accounts);
  await toolbar.getByRole('textbox', { name: 'Search', exact: true }).fill('identity-1');
  await settle(page);
  assert.equal(fixture.count(paths.accounts), requestsBeforeDraft, 'Typing remains an unsubmitted search draft');
  await toolbar.getByRole('button', { name: 'Search', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(paths.accounts), requestsBeforeDraft + 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Select identity-0', exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: 'Select identity-1', exact: true }).waitFor();
  fixture.assertHealthy();
});

test('user imports and task quick filters remain discoverable without selection', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('users');
  assert.equal(await page.getByRole('button', { name: 'Create user', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('button', { name: 'Import CSV', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Import from GH', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await settle(page);
  assert.equal(await page.getByRole('button', { name: 'Import', exact: true }).evaluate((button) => button === document.activeElement), true);
  assert.equal(await page.getByRole('button', { name: 'Actions for user-0', exact: true }).count(), 0, 'The redundant related-account menu is removed');
  const edit = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select user-0', exact: true }) }).getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  await page.getByRole('dialog', { name: 'Edit user-0', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await settle(page);
  assert.equal(await edit.evaluate((button) => button === document.activeElement), true);

  await fixture.goto('tasks');
  const before = fixture.count(paths.tasks);
  await page.getByRole('link', { name: 'Failed tasks', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(paths.tasks), before + 1);
  assert.match(page.url(), /status=failed/);
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-running', exact: true }).count(), 0);
  const rowActions = page.getByRole('button', { name: 'Actions for task-failed', exact: true });
  await rowActions.click();
  assert.equal(await rowActions.getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Active tasks', exact: true }).click();
  await settle(page);
  await page.getByRole('checkbox', { name: 'Select task-running', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).count(), 0);
  fixture.assertHealthy();
});

test('record identities and related tasks are plain text while details and row operations remain usable', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  for (const route of ['users', 'stats', 'accounts', 'tasks', 'error-diagnostics']) {
    await fixture.goto(route);
    const row = page.locator('main table tbody tr').first();
    const text = row.getByText(route === 'users' || route === 'accounts' ? 'user-0' : 'identity-0', { exact: route !== 'stats' });
    const url = page.url();
    const reads = fixture.requests.length;
    await text.click();
    await settle(page);
    assert.equal(page.url(), url, `${route}: clicking record text cannot navigate`);
    assert.equal(fixture.requests.length, reads, `${route}: clicking record text does not fetch related data`);
    assert.equal(await row.locator('a[href]').count(), 0);
    if (route === 'stats') {
      await row.locator('summary').click();
      await row.locator('details p').getByText('Fixture upstream request failed', { exact: true }).waitFor();
      assert.equal(await page.getByText(/Related diagnostics/).count(), 0);
    }
  }
  await fixture.goto('accounts');
  const account = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select identity-0', exact: true }) });
  assert.equal(await account.getByRole('button', { name: 'Actions for identity-0', exact: true }).count(), 0);
  await account.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  const authorization = page.getByRole('dialog', { name: 'Reauthorize Copilot OAuth', exact: true });
  await authorization.waitFor();
  await assertSurfaceContrast(page, 'account authorization');
  await authorization.getByRole('button', { name: 'Cancel', exact: true }).click();
  await account.getByRole('button', { name: 'Details', exact: true }).click();
  const accountDetails = page.getByRole('dialog', { name: 'Account identity-0', exact: true });
  await accountDetails.getByText('Fixture upstream request failed', { exact: true }).first().waitFor();
  assert.equal(await accountDetails.locator('a[href^="#"]').count(), 0);
  await accountDetails.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await fixture.goto('tasks');
  assert.equal(await page.getByRole('link', { name: 'task-running', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Actions for task-running', exact: true }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Login task details', exact: true });
  await details.getByText('Attempt 1', { exact: true }).waitFor();
  await details.getByText('Proxy: identity-0', { exact: true }).waitFor();
  await details.getByText('SSO: user-0', { exact: true }).waitFor();
  assert.equal(await details.locator('a[href^="#"]').count(), 0);
  assert.match(await details.getByRole('link', { name: 'Download log', exact: true }).getAttribute('href') ?? '', /log\?download=1$/);
  await assertSurfaceContrast(page, 'task details');
  await details.getByRole('button', { name: 'Close dialog', exact: true }).click();

  const task = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select task-failed', exact: true }) });
  await task.getByRole('button', { name: 'Retry', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Confirm: retry', exact: true });
  await preview.getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).waitFor();
  assert.equal(await preview.locator('a[href^="#"]').count(), 0);
  await preview.getByRole('button', { name: 'Confirm 1 item(s)', exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Retry failed tasks: submitted 1 target(s)' }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Last action', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: /^Operation:/ }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.ok(data.operation);
  data.operation.status = 'completed';
  data.operation.items = [{ id: 'task-failed', status: 'success', relatedTaskId: 'task-follow-up' }];
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settle(page);
  assert.equal(await task.getByRole('checkbox').isChecked(), false);
  assert.equal(await task.locator('td[data-action-status]').count(), 0);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  assert.match(await page.getByRole('link', { name: 'Export last action results', exact: true }).getAttribute('href') ?? '', /\/export$/);
  await page.keyboard.press('Escape');
  await assertSurfaceContrast(page, 'operation results');
  fixture.assertHealthy();
});

test('task status uses a compact multi-select dropdown with draft submission, URL restoration and a clear option', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('tasks');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const status = page.getByRole('button', { name: /^Status:/ });
  assert.equal(await page.getByRole('listbox').count(), 0, 'Status is not a permanently expanded native list');
  assert.equal(await page.getByRole('button', { name: 'Status: All', exact: true }).count(), 1);
  const collapsed = await status.boundingBox();
  assert.ok(collapsed && collapsed.height <= 40, 'The collapsed filter occupies one control row');
  const beforeDraft = fixture.count(paths.tasks);
  await status.focus();
  await status.press('Enter');
  const choices = page.getByRole('group', { name: 'Status options', exact: true });
  await choices.waitFor();
  assert.equal(await choices.getByRole('checkbox').count(), 6);
  assert.equal(await choices.getByRole('checkbox', { name: 'pending', exact: true }).evaluate((checkbox) => checkbox === document.activeElement), true);
  await choices.getByRole('checkbox', { name: 'running', exact: true }).check();
  await choices.getByRole('checkbox', { name: 'failed', exact: true }).check();
  await settle(page);
  assert.equal(await status.getAttribute('aria-expanded'), 'true', 'Selecting a status keeps the menu open for additional choices');
  assert.equal(fixture.count(paths.tasks), beforeDraft, 'Changing choices only edits the draft');
  await page.keyboard.press('Escape');
  await choices.waitFor({ state: 'hidden' });
  assert.equal(await status.evaluate((button) => button === document.activeElement), true);
  assert.equal(await page.getByRole('button', { name: 'Status: 2 selected', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(paths.tasks), beforeDraft + 1);
  assert.equal(new URLSearchParams(page.url().split('?')[1]).get('status'), 'running,failed');

  await page.reload();
  await settle(page);
  assert.equal(await page.getByRole('button', { name: 'Status: 2 selected', exact: true }).count(), 1);
  await status.click();
  assert.equal(await choices.getByRole('checkbox', { name: 'running', exact: true }).isChecked(), true);
  assert.equal(await choices.getByRole('checkbox', { name: 'failed', exact: true }).isChecked(), true);
  assert.equal(await choices.getByRole('checkbox', { name: 'pending', exact: true }).isChecked(), false);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Active tasks', exact: true }).click();
  await settle(page);
  assert.equal(await page.getByRole('button', { name: 'Status: 3 selected', exact: true }).count(), 1, 'The existing multi-status shortcut is preserved');
  await status.click();
  for (const name of ['pending', 'running', 'cancelling']) assert.equal(await choices.getByRole('checkbox', { name, exact: true }).isChecked(), true);
  assert.equal(await choices.getByRole('checkbox', { name: 'failed', exact: true }).isChecked(), false);
  await choices.getByRole('checkbox', { name: 'pending', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await page.goBack();
  await settle(page);
  assert.equal(await page.getByRole('button', { name: 'Status: 2 selected', exact: true }).count(), 1);
  await status.click();
  assert.equal(await choices.getByRole('checkbox', { name: 'running', exact: true }).isChecked(), true);
  assert.equal(await choices.getByRole('checkbox', { name: 'failed', exact: true }).isChecked(), true, 'History navigation restores the applied filter over an unsubmitted draft');
  const beforeClear = fixture.count(paths.tasks);
  await page.getByRole('button', { name: 'Clear status filter', exact: true }).click();
  await choices.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Status: All', exact: true }).count(), 1);
  assert.equal(fixture.count(paths.tasks), beforeClear, 'Clearing also waits for Apply filters');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await settle(page);
  assert.equal(fixture.count(paths.tasks), beforeClear + 1);
  assert.equal(new URLSearchParams(page.url().split('?')[1]).get('status'), null);
  await page.getByRole('checkbox', { name: 'Select task-running', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Select task-failed', exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await status.click();
  await choices.waitFor();
  assert.equal(await choices.getByRole('checkbox', { checked: true }).count(), 0);
  const menu = await page.locator('.ui-dropdown-panel').boundingBox();
  assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 390, 'The dropdown stays inside a phone viewport');
  await assertContainedLayout(page, 'task status menu at 390px', true);
  await page.keyboard.press('Escape');
  await fixture.goto('accounts');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'OAuth status', exact: true }).count(), 1, 'Single-choice filters retain their native dropdown');
  fixture.assertHealthy();
});

test('the Task column displays a complete copyable ID without opening details or reading task data', { timeout: 30_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  const id = '12345678-1234-5678-9012-123456789012';
  data.tasks[0]!.id = id;
  data.queue.active = [id];
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.base });
  await fixture.goto('tasks');
  const row = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${id}`, exact: true }) });
  const cell = row.getByRole('cell').nth(1);
  const text = cell.getByText(id, { exact: true });
  assert.equal(await text.textContent(), id, 'The displayed ID is not truncated to its prefix');
  assert.equal(await text.evaluate((element) => element.closest('a, button, [role="button"]') !== null), false);
  assert.equal(await cell.getByRole('button').count(), 1, 'Copy is the only control in the Task cell');
  const before = fixture.requests.length;
  const url = page.url();
  await text.click();
  await settle(page);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(page.url(), url);
  assert.equal(fixture.requests.length, before);
  assert.equal(fixture.count(`${paths.tasks}/${id}`), 0);
  assert.equal(fixture.count(`${paths.tasks}/${id}/attempts`), 0);
  await cell.getByRole('button', { name: `Copy ${id}`, exact: true }).click();
  await cell.getByRole('status').filter({ hasText: 'Copied' }).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertContainedLayout(page, 'full task IDs at 390px', true);
  const idBox = await text.boundingBox();
  assert.ok(idBox && idBox.height <= 24, 'A full ID stays readable on one line inside the scrolling table');
  fixture.assertHealthy();
});

test('secondary buttons distinguish resting, hover, pressed, expanded, keyboard focus and disabled states', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('accounts');
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const resting = await buttonAppearance(refresh);
  await refresh.hover();
  const hovered = await buttonAppearance(refresh);
  assert.notEqual(hovered.background, resting.background);
  assert.notEqual(hovered.border, resting.border);
  await page.mouse.down();
  const pressed = await buttonAppearance(refresh);
  assert.notEqual(pressed.background, hovered.background);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  const view = page.getByRole('button', { name: 'View', exact: true });
  await view.click();
  await page.getByRole('checkbox', { name: 'Compact rows', exact: true }).waitFor();
  const expanded = await buttonAppearance(view);
  assert.notEqual(expanded.background, resting.background);
  assert.equal(await view.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await settle(page);
  const focused = await buttonAppearance(view);
  assert.equal(focused.outline, 'solid');
  assert.ok(focused.outlineWidth >= 2, 'Keyboard focus is visibly outlined');
  const previous = page.getByRole('button', { name: 'Previous', exact: true });
  assert.equal(await previous.isDisabled(), true);
  const disabled = await previous.evaluate((button) => ({ opacity: Number(getComputedStyle(button).opacity), cursor: getComputedStyle(button).cursor }));
  assert.ok(disabled.opacity < 1);
  assert.equal(disabled.cursor, 'not-allowed');
  fixture.assertHealthy();
});

test('list loading, stale errors, empty results and diagnostic confirmation preserve layout and scope', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture.goto('accounts');
  const release = fixture.hold(paths.accounts);
  t.after(release);
  const started = page.waitForRequest((request) => new URL(request.url()).pathname === paths.accounts);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started;
  assert.equal(await page.getByRole('checkbox', { name: 'Select identity-0', exact: true }).count(), 1, 'Refreshing preserves already displayed rows');
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
  await assertContainedLayout(page, 'accounts while refreshing', true);
  fixture.failures.set(paths.accounts, { message: 'Fixture list unavailable' });
  release();
  await page.getByRole('alert').filter({ hasText: 'Fixture list unavailable' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select identity-0', exact: true }).count(), 1, 'Failed refresh retains the previous result');
  await assertContainedLayout(page, 'accounts with a stale error', true);
  fixture.failures.delete(paths.accounts);
  data.accounts = [];
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('No records yet.', { exact: true }).waitFor();
  await assertContainedLayout(page, 'empty accounts');
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('not-found');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('No matching records. Try clearing the filters.', { exact: true }).waitFor();
  await assertContainedLayout(page, 'accounts without matching records');

  await fixture.goto('error-diagnostics');
  let nativeDialogs = 0;
  page.on('dialog', async (dialog) => { nativeDialogs++; await dialog.dismiss(); });
  const clear = page.getByRole('button', { name: 'Clear all diagnostics', exact: true });
  await clear.click();
  const confirmation = page.getByRole('dialog', { name: 'Clear all diagnostics', exact: true });
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /all stored|all.*diagnostics/i);
  assert.match(await confirmation.innerText(), /not only the filtered results/i);
  assert.match(await confirmation.innerText(), /cannot be undone/i);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(fixture.count(paths.diagnostics, 'DELETE'), 0);
  await clear.click();
  await confirmation.getByRole('button', { name: 'Clear all diagnostics', exact: true }).click();
  await page.getByText('No records yet.', { exact: true }).waitFor();
  assert.equal(fixture.count(paths.diagnostics, 'DELETE'), 1);
  assert.equal(fixture.count(paths.diagnostics), 2, 'The confirmed mutation performs one readback');
  assert.equal(nativeDialogs, 0, 'Destructive confirmation uses the shared dialog, not a native confirm');
  const deletion = fixture.requests.find((request) => request.path === paths.diagnostics && request.method === 'DELETE');
  assert.deepEqual(deletion?.body, { confirm: true });
  await assertContainedLayout(page, 'diagnostics after clearing');
  fixture.assertHealthy();
});
