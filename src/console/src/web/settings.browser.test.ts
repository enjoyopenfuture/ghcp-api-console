import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleFixture, paths, settle } from './test-support/console-fixture.js';

const sectionTitles = ['SSO runtime settings', 'Login runtime settings', 'Console administrator password'];

test('settings have aligned sections, grouped fields and contained phone controls', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('settings');
  const sso = page.getByRole('region', { name: sectionTitles[0], exact: true });
  const login = page.getByRole('region', { name: sectionTitles[1], exact: true });
  await sso.getByRole('group', { name: 'Account defaults', exact: true }).waitFor();
  await sso.getByRole('group', { name: 'Synchronization and retries', exact: true }).waitFor();
  await login.getByRole('group', { name: 'Task execution', exact: true }).waitFor();
  await login.getByRole('group', { name: 'Debugging', exact: true }).waitFor();
  assert.equal(await login.getByRole('checkbox', { name: 'Account debug logs', exact: true }).isChecked(), true);
  assert.equal(await login.getByRole('checkbox', { name: 'Debug artifacts', exact: true }).isChecked(), false);
  const limit = sso.getByRole('spinbutton', { name: 'Maximum SSO users', exact: true });
  assert.equal(await limit.getAttribute('min'), '1');
  assert.equal(await limit.getAttribute('max'), '1000000');
  const hint = await limit.getAttribute('aria-describedby');
  assert.ok(hint);
  assert.equal(await page.locator(`[id="${hint}"]`).textContent(), 'Leave blank for unlimited.');
  const timeout = login.getByRole('spinbutton', { name: 'Authentication timeout (ms)', exact: true });
  assert.equal(await timeout.getAttribute('min'), '5000');
  assert.equal(await timeout.getAttribute('max'), '600000');

  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await settle(page);
    const geometry = await page.locator('main section[aria-labelledby]').evaluateAll((sections) => sections.map((section) => {
      const rect = section.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom,
        controls: Array.from(section.querySelectorAll('input, button')).map((input) => {
          const control = input.getBoundingClientRect();
          return { left: control.left, right: control.right, height: control.height };
        }),
      };
    }));
    assert.equal(geometry.length, 3);
    for (const [index, section] of geometry.entries()) {
      assert.ok(Math.abs(section.x - geometry[0]!.x) <= 1 && Math.abs(section.width - geometry[0]!.width) <= 1, 'All three sections share the same width and alignment');
      if (index) assert.ok(section.y >= geometry[index - 1]!.bottom + 16, 'Independent settings sections are stacked with clear spacing');
      for (const control of section.controls) {
        assert.ok(control.left >= section.x && control.right <= section.x + section.width, `${width}px: each control stays inside its section`);
        assert.ok(control.height >= 24);
      }
    }
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
    assert.ok(overflow <= 1, `${width}px: no horizontal page overflow`);
    const heading = await sso.getByRole('heading', { name: sectionTitles[0], exact: true }).boundingBox();
    const fields = await sso.getByRole('group', { name: 'Account defaults', exact: true }).boundingBox();
    assert.ok(heading && fields);
    if (width >= 1280) assert.ok(fields.x > heading.x + heading.width, 'Desktop sections separate explanations from form fields');
    else {
      assert.ok(fields.y > heading.y + heading.height, 'Phone sections stack the explanation above the fields');
      const save = await sso.getByRole('button', { name: 'Save and apply', exact: true }).boundingBox();
      assert.ok(save && Math.abs(save.width - fields.width) <= 1, 'The phone save action spans the form width');
    }
  }
  fixture.assertHealthy();
});

test('runtime settings keep independent saves, pending states, errors and version-conflict reloads', { timeout: 60_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page, data } = fixture;
  await page.clock.install();
  await fixture.goto('settings');
  const sso = page.getByRole('region', { name: sectionTitles[0], exact: true });
  const login = page.getByRole('region', { name: sectionTitles[1], exact: true });
  await page.clock.fastForward(300_000);
  assert.equal(fixture.count(paths.ssoSettings), 1);
  assert.equal(fixture.count(paths.loginSettings), 1);
  await sso.getByLabel('Maximum SSO users', { exact: true }).fill('');
  await sso.getByLabel('Fallback user prefix', { exact: true }).fill('updated');
  await sso.getByLabel('Default email domain', { exact: true }).fill('updated.example.test');
  await sso.getByLabel('Sync EMU concurrency', { exact: true }).fill('4');
  await sso.getByLabel('SCIM request delay (ms)', { exact: true }).fill('250');
  await sso.getByLabel('SCIM max retries', { exact: true }).fill('3');
  await sso.getByLabel('SCIM retry base delay (ms)', { exact: true }).fill('1500');
  assert.equal(fixture.count(paths.ssoSettings, 'PATCH'), 0, 'Editing only changes the local draft');
  const release = fixture.hold(paths.ssoSettings);
  t.after(release);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === paths.ssoSettings && request.method() === 'PATCH');
  await sso.getByRole('button', { name: 'Save and apply', exact: true }).click();
  await requested;
  const saving = sso.getByRole('button', { name: 'Saving...', exact: true });
  assert.equal(await saving.isDisabled(), true);
  assert.equal(await sso.getAttribute('aria-busy'), 'true');
  await saving.evaluate((button: HTMLButtonElement) => button.click());
  assert.equal(fixture.count(paths.ssoSettings, 'PATCH'), 1);
  assert.deepEqual(fixture.requests.find((request) => request.path === paths.ssoSettings && request.method === 'PATCH')?.body, {
    expectedVersion: 1,
    changes: {
      maxSsoUsers: null, userPrefix: 'updated', emailDomain: 'updated.example.test',
      bulkSyncConcurrency: 4, scimRequestDelayMs: 250, scimMaxRetries: 3, scimRetryBaseDelayMs: 1500,
    },
  });
  release();
  await sso.getByText('Version 2', { exact: true }).waitFor();
  await settle(page);
  assert.equal(fixture.count(paths.ssoSettings), 1, 'The save response updates the snapshot without an extra read');
  assert.equal(fixture.count(paths.loginSettings, 'PATCH'), 0);
  assert.equal(await sso.getByLabel('Maximum SSO users', { exact: true }).inputValue(), '');

  await login.getByLabel('Login concurrency', { exact: true }).fill('6');
  await login.getByLabel('Authentication timeout (ms)', { exact: true }).fill('120000');
  await login.getByRole('checkbox', { name: 'Account debug logs', exact: true }).uncheck();
  await login.getByRole('checkbox', { name: 'Debug artifacts', exact: true }).check();
  await login.getByRole('button', { name: 'Save and apply', exact: true }).click();
  await login.getByText('Version 2', { exact: true }).waitFor();
  assert.deepEqual(fixture.requests.find((request) => request.path === paths.loginSettings && request.method === 'PATCH')?.body, {
    expectedVersion: 1, changes: { concurrency: 6, authTimeoutMs: 120000, authDebugLogs: false, authDebugArtifacts: true },
  });
  assert.equal(fixture.count(paths.loginSettings), 1);

  fixture.failures.set(paths.ssoSettings, { status: 400, message: 'Fixture settings validation failed.' });
  await sso.getByLabel('Fallback user prefix', { exact: true }).fill('draft-kept');
  await sso.getByRole('button', { name: 'Save and apply', exact: true }).click();
  await sso.getByRole('alert').filter({ hasText: 'Fixture settings validation failed.' }).waitFor();
  await settle(page);
  assert.equal(await sso.getByLabel('Fallback user prefix', { exact: true }).inputValue(), 'draft-kept');
  await sso.getByText('Version 2', { exact: true }).waitFor();
  fixture.failures.delete(paths.ssoSettings);
  data.ssoSettings = { ...data.ssoSettings, version: 9, userPrefix: 'external' };
  await sso.getByRole('button', { name: 'Save and apply', exact: true }).click();
  await sso.getByRole('alert').filter({ hasText: 'changed in another session' }).waitFor();
  await sso.getByText('Version 9', { exact: true }).waitFor();
  assert.equal(await sso.getByLabel('Fallback user prefix', { exact: true }).inputValue(), 'external');
  assert.equal(fixture.count(paths.ssoSettings), 2, 'A version conflict reloads the latest service settings once');
  assert.equal(fixture.count(paths.loginSettings), 1);
  assert.equal(await login.getByLabel('Login concurrency', { exact: true }).inputValue(), '6');
  fixture.assertHealthy();
});

test('the administrator password section preserves validation, errors and successful clearing', { timeout: 45_000 }, async (t) => {
  const fixture = await createConsoleFixture(t);
  const { page } = fixture;
  await fixture.goto('settings');
  const password = page.getByRole('region', { name: sectionTitles[2], exact: true });
  const current = password.getByLabel('Current password', { exact: true });
  const next = password.getByLabel('New password', { exact: true });
  const confirm = password.getByLabel('Confirm new password', { exact: true });
  const save = password.getByRole('button', { name: 'Change password', exact: true });
  for (const input of [current, next, confirm]) assert.equal(await input.getAttribute('type'), 'password');
  assert.equal(await current.getAttribute('autocomplete'), 'current-password');
  assert.equal(await next.getAttribute('autocomplete'), 'new-password');
  await save.click();
  await password.getByRole('alert').filter({ hasText: 'are required' }).waitFor();
  await current.fill('fixture-current');
  await next.fill('fixture-next');
  await confirm.fill('fixture-mismatch');
  await save.click();
  await password.getByRole('alert').filter({ hasText: 'do not match' }).waitFor();
  await next.fill('fixture-current');
  await confirm.fill('fixture-current');
  await save.click();
  await password.getByRole('alert').filter({ hasText: 'must be different' }).waitFor();
  assert.equal(fixture.count(paths.password, 'PATCH'), 0);
  await next.fill('fixture-next');
  await confirm.fill('fixture-next');
  fixture.failures.set(paths.password, { status: 400, message: 'Fixture current password was rejected.' });
  await save.click();
  await password.getByRole('alert').filter({ hasText: 'current password was rejected' }).waitFor();
  await settle(page);
  assert.equal(await next.inputValue(), 'fixture-next', 'A service error keeps the entered draft');
  fixture.failures.delete(paths.password);
  const release = fixture.hold(paths.password);
  t.after(release);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === paths.password);
  await save.click();
  await requested;
  assert.equal(await password.getByRole('button', { name: 'Changing...', exact: true }).isDisabled(), true);
  assert.equal(await password.getAttribute('aria-busy'), 'true');
  release();
  await settle(page);
  assert.deepEqual(fixture.requests.filter((request) => request.path === paths.password).at(-1)?.body, { currentPassword: 'fixture-current', newPassword: 'fixture-next' });
  for (const input of [current, next, confirm]) assert.equal(await input.inputValue(), '');
  assert.equal(await password.getByRole('alert').count(), 0);
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(fixture.data.authenticated, true);
  fixture.assertHealthy();
});
