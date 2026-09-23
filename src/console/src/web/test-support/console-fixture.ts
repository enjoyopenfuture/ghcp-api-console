import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { chromium, type Page, type Request as BrowserRequest } from 'playwright';
import type {
  AiCreditsUsageDto, LoginAttemptDto, LoginQueueDto, LoginRuntimeSettingsDto, LoginTaskDto,
  ManagementOperation, ManagementSelection, ProxyAccountDto, ProxyErrorDiagnosticSummaryDto,
  ProxyRequestStatDto, SsoRuntimeSettingsDto, SsoUserDto,
} from '@ghcp/shared';

export const paths = {
  tasks: '/api/console/login-service/tasks',
  queue: '/api/console/login-service/queue',
  summary: '/api/console/login-service/tasks/summary',
  operations: '/api/console/login-service/tasks/operations',
  users: '/api/console/sso/users',
  capacity: '/api/console/sso/users/capacity',
  accounts: '/api/console/proxy/accounts',
  stats: '/api/console/proxy/request-stats',
  diagnostics: '/api/console/proxy/error-diagnostics',
  ssoSettings: '/api/console/sso/settings/runtime',
  loginSettings: '/api/console/login-service/settings/runtime',
  password: '/api/console/password',
} as const;

const timestamp = '2026-09-01T12:00:00.000Z';
const pendingRequests = new WeakMap<Page, Set<BrowserRequest>>();

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
}

function initialData() {
  const tasks: LoginTaskDto[] = [
    { id: 'task-running', status: 'running', stage: 'authorizing' },
    { id: 'task-failed', status: 'failed', stage: 'finished', failureReason: 'Fixture authorization failure' },
    { id: 'task-retry', status: 'failed', stage: 'finished', failureReason: 'Fixture retry failure' },
  ].map((task, index) => ({
    identity: `identity-${index}`, ssoUser: `user-${index}`, ghLogin: `gh-${index}`,
    ssoType: 'custom', attempts: 1, createdAt: timestamp, queuedAt: timestamp, startedAt: timestamp,
    ...task,
  } as LoginTaskDto));
  const attempts: Record<string, LoginAttemptDto[]> = Object.fromEntries(tasks.map((task) => [
    task.id, [{ ...task, id: `attempt-${task.id}`, taskId: task.id, attemptNumber: 1, historyIncomplete: false }],
  ]));
  const queue: LoginQueueDto = {
    concurrency: 4, preparing: [], pending: [], active: ['task-running'], cancelling: [],
    longestWaitMs: 0, items: [], updatedAt: timestamp,
  };
  const users: SsoUserDto[] = [0, 1].map((index) => ({
    ssoUser: `user-${index}`, email: `user-${index}@example.test`, ghLogin: `gh-${index}`, role: 'user',
    emuStatus: 'active', copilotSeatStatus: 'assigned', createdAt: timestamp, updatedAt: timestamp,
  }));
  const accounts: ProxyAccountDto[] = [0, 1].map((index) => ({
    identity: `identity-${index}`, ssoUser: `user-${index}`, ghLogin: `gh-${index}`,
    copilotOauthStatus: 'valid', copilotOauthUpdatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  }));
  const stats: ProxyRequestStatDto[] = [{
    id: 'request-0', identity: 'identity-0', ghLogin: 'gh-0', requestedAt: timestamp,
    path: '/chat/completions', model: 'fixture-model', success: false, inputTokens: 1200, outputTokens: 75,
    cacheInputTokens: 100, cacheWriteTokens: 10, failureReason: 'Fixture upstream request failed',
  }];
  const diagnostics: ProxyErrorDiagnosticSummaryDto[] = [{
    id: 'diagnostic-0', timestamp, identity: 'identity-0', path: '/chat/completions', model: 'fixture-model',
    failureKind: 'http', status: 502, redacted: true,
    inboundRequestBodyBytes: 128, upstreamRequestBodyBytes: 256, upstreamResponseBodyBytes: 512,
  }];
  const usage: AiCreditsUsageDto = {
    enterprise: 'fixture-enterprise', lastMonth: { year: 2026, month: 8, quantity: 75 },
    currentMonth: { year: 2026, month: 9, quantity: 25 }, projectedCurrentMonthQuantity: 100,
    assignedSeatCount: 2, assignedSeatMonthlyCost: 38, seatPricePerMonth: 19, fetchedAt: timestamp,
  };
  const ssoSettings: SsoRuntimeSettingsDto = {
    maxSsoUsers: 100, userPrefix: 'fixture', emailDomain: 'example.test', bulkSyncConcurrency: 2,
    scimRequestDelayMs: 100, scimMaxRetries: 2, scimRetryBaseDelayMs: 100, version: 1, updatedAt: timestamp,
  };
  const loginSettings: LoginRuntimeSettingsDto = {
    concurrency: 4, authTimeoutMs: 60000, authDebugLogs: true, authDebugArtifacts: false,
    version: 1, updatedAt: timestamp,
  };
  return {
    tasks, attempts, queue, users, accounts, stats, diagnostics, usage, ssoSettings, loginSettings,
    operation: undefined as ManagementOperation | undefined,
    operations: new Map<string, ManagementOperation>(),
    nextOperationId: 'fixture-operation',
    authenticated: true,
  };
}

export async function createConsoleFixture(t: TestContext) {
  const data = initialData();
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const failures = new Map<string, { message: string; status?: number; code?: string }>();
  const holds = new Map<string, Array<() => void>>();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/console/')) { next(); return; }
    requests.push({ method: req.method, path: req.path, query: { ...req.query }, body: req.body });
    const respond = () => {
      if (res.destroyed) return;
      const failure = failures.get(req.path);
      if (failure) {
        res.status(failure.status ?? 503).json({ error: { code: failure.code ?? 'fixture_unavailable', message: failure.message } });
      } else next();
    };
    const waiting = holds.get(req.path);
    if (waiting) waiting.push(respond);
    else respond();
  });
  const paged = <T extends object>(req: Request, rows: T[]) => {
    const q = String(req.query.q ?? '').toLowerCase();
    const statuses = String(req.query.status ?? '').split(',').filter(Boolean);
    const seatStatuses = String(req.query.seatStatus ?? '').split(',').filter(Boolean);
    const filtered = rows.filter((row) => (!q || JSON.stringify(row).toLowerCase().includes(q))
      && (!statuses.length || !('status' in row) || statuses.includes(String(row.status)))
      && (!seatStatuses.length || !('copilotSeatStatus' in row) || seatStatuses.includes(String(row.copilotSeatStatus))));
    const pageSize = Number(req.query.pageSize ?? 25);
    const page = Math.min(Number(req.query.page ?? 1), Math.max(1, Math.ceil(filtered.length / pageSize)));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  };
  const summary = (rows: object[], key: string) => ({
    total: rows.length, counts: rows.reduce<Record<string, number>>((counts, row) => {
      const value = String((row as Record<string, unknown>)[key]);
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {}), updatedAt: timestamp,
  });
  app.get('/api/console/setup', (_req, res) => res.json({ initialized: true }));
  app.get('/api/console/me', (_req, res) => data.authenticated
    ? res.json({ username: 'fixture-admin', role: 'admin' })
    : res.status(401).json({ error: { code: 'not_authenticated', message: 'Sign in required.' } }));
  app.post('/api/console/logout', (_req, res) => { data.authenticated = false; res.status(204).end(); });
  app.post('/api/console/login', (_req, res) => { data.authenticated = true; res.json({ username: 'fixture-admin', role: 'admin' }); });
  app.get(`${paths.accounts}/summary`, (_req, res) => res.json(summary(data.accounts, 'copilotOauthStatus')));
  app.get(`${paths.users}/summary`, (_req, res) => res.json(summary(data.users, 'emuStatus')));
  app.get(paths.summary, (_req, res) => res.json(summary(data.tasks, 'status')));
  app.get(paths.queue, (_req, res) => res.json(data.queue));
  app.get(paths.capacity, (_req, res) => res.json({ current: data.users.length, limit: 100, remaining: 100 - data.users.length, reached: false }));
  app.get('/api/console/sso/ai-credits/usage', (_req, res) => res.json(data.usage));
  app.post('/api/console/sso/ai-credits/usage/refresh', (_req, res) => res.json(data.usage));
  app.get(paths.ssoSettings, (_req, res) => res.json(data.ssoSettings));
  app.get(paths.loginSettings, (_req, res) => res.json(data.loginSettings));
  for (const key of ['ssoSettings', 'loginSettings'] as const) {
    app.patch(paths[key], (req, res) => {
      if (req.body.expectedVersion !== data[key].version) {
        res.status(409).json({ error: { code: 'version_conflict', message: 'Settings changed in another session.' } });
        return;
      }
      Object.assign(data[key], req.body.changes, { version: data[key].version + 1, updatedAt: '2026-09-01T12:01:00.000Z' });
      res.json(data[key]);
    });
  }
  app.patch(paths.password, (_req, res) => res.status(204).end());

  for (const base of [paths.tasks, paths.users, paths.accounts]) {
    app.post(`${base}/operations/preview`, (req, res) => {
      const selection = req.body.selection as ManagementSelection;
      const records = base === paths.tasks ? data.tasks.map((task) => ({ ...task, id: task.id }))
        : base === paths.users ? data.users.map((user) => ({ ...user, id: user.ssoUser }))
          : data.accounts.map((account) => ({ ...account, id: account.identity }));
      const ids = selection.ids ?? records.filter((row) => !selection.excludedIds?.includes(row.id)
        && (!selection.query?.q || JSON.stringify(row).toLowerCase().includes(selection.query.q.toLowerCase()))).map((row) => row.id);
      data.operation = {
        id: data.nextOperationId, scope: base === paths.tasks ? 'tasks' : base === paths.users ? 'users' : 'accounts',
        action: req.body.action, status: 'preview', options: req.body.options,
        items: ids.map((id) => {
          const task = base === paths.tasks ? data.tasks.find((task) => task.id === id) : undefined;
          return {
            id, label: task ? `${task.identity} / ${task.ssoUser}` : id,
            status: records.some((row) => row.id === id) ? 'pending' : 'skipped',
            detail: records.some((row) => row.id === id) ? undefined : 'Fixture record was removed.',
            requiresPasswordOverride: task?.ssoType === 'azure',
          };
        }),
        createdAt: timestamp, updatedAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z',
      };
      data.operations.set(data.operation.id, data.operation);
      res.status(201).json(data.operation);
    });
    app.post(`${base}/operations/:id/execute`, (req, res) => {
      const previous = data.operation?.id === req.params.id ? data.operation : data.operations.get(req.params.id);
      if (!previous) { res.status(404).end(); return; }
      const next: ManagementOperation = {
        ...previous, status: 'running',
        items: previous.items.map((item) => item.status === 'pending' ? { ...item, status: 'running' } : item),
      };
      data.operations.set(next.id, next);
      if (data.operation?.id === next.id) data.operation = next;
      res.status(202).json(next);
    });
    app.get(`${base}/operations/:id`, (req, res) => {
      const operation = data.operation?.id === req.params.id ? data.operation : data.operations.get(req.params.id);
      if (operation) res.json(operation);
      else res.status(404).json({ error: { code: 'operation_not_found', message: 'Fixture operation expired.' } });
    });
  }

  app.get(paths.tasks, (req, res) => res.json(req.query.limit ? data.tasks.slice(0, Number(req.query.limit)) : paged(req, data.tasks)));
  app.get(`${paths.tasks}/:id/attempts`, (req, res) => res.json(data.attempts[req.params.id] ?? []));
  app.get(`${paths.tasks}/:id/attempts/:attemptId/log`, (req, res) => {
    if (req.query.download) res.attachment('fixture-attempt.log').type('text/plain').send('Fixture log preview.');
    else res.json({ content: 'Fixture log preview.', truncated: true });
  });
  app.get(`${paths.tasks}/:id`, (req, res) => {
    const task = data.tasks.find((item) => item.id === req.params.id);
    if (task) res.json(task);
    else res.status(404).json({ error: { code: 'task_not_found', message: 'Task was removed.' } });
  });
  app.get(paths.users, (req, res) => res.json(paged(req, data.users)));
  app.post(paths.users, (req, res) => {
    const user: SsoUserDto = {
      ...data.users[0]!, ...req.body, email: req.body.email ?? '', createdAt: timestamp, updatedAt: timestamp,
    };
    data.users.push(user);
    res.status(201).json(user);
  });
  app.patch(`${paths.users}/:id`, (req, res) => {
    const user = data.users.find((item) => item.ssoUser === req.params.id)!;
    Object.assign(user, req.body);
    res.json(user);
  });
  app.get(paths.accounts, (req, res) => res.json(paged(req, data.accounts)));
  app.post(`${paths.accounts}/:id/copilot-oauth/reauthorize`, (req, res) => {
    const account = data.accounts.find((item) => item.identity === req.params.id);
    if (!account) { res.status(404).json({ error: { code: 'account_not_found', message: 'Fixture account was removed.' } }); return; }
    account.copilotOauthStatus = 'refreshing';
    res.json(account);
  });
  app.get(`${paths.accounts}/:id/request-stats`, (_req, res) => res.json(data.stats));
  app.get(`${paths.accounts}/:id`, (req, res) => res.json(data.accounts.find((item) => item.identity === req.params.id)));
  app.get(paths.stats, (req, res) => res.json(req.query.limit ? data.stats : paged(req, data.stats)));
  app.get(paths.diagnostics, (req, res) => res.json({ ...paged(req, data.diagnostics), enabled: true, redacted: true }));
  app.get(`${paths.diagnostics}/:id`, (req, res) => res.json({ ...data.diagnostics.find((item) => item.id === req.params.id), content: 'Fixture diagnostic content.' }));
  app.delete(paths.diagnostics, (_req, res) => { data.diagnostics = []; res.json({ cleared: true }); });
  app.use('/api', (req, res: Response) => {
    unexpected.push(`${req.method} ${req.originalUrl}`);
    res.status(501).json({ error: { code: 'fixture_route_missing', message: 'No fixture route registered.' } });
  });
  app.use(express.static(fileURLToPath(new URL('../../../dist/web', import.meta.url))));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      unexpected.push(`External request: ${url.origin}`);
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  const pending = new Set<BrowserRequest>();
  pendingRequests.set(page, pending);
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/console/')) pending.add(request); });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  const count = (path: string, method = 'GET') => requests.filter((request) => request.path === path && request.method === method).length;
  return {
    page, base, data, failures, requests, count,
    async goto(hash: string) {
      await page.goto(`${base}/#${hash}`);
      await page.locator('.console-admin').waitFor();
      await settle(page);
    },
    hold(path: string) {
      assert.equal(holds.has(path), false, `Already holding ${path}`);
      const waiting: Array<() => void> = [];
      holds.set(path, waiting);
      return () => {
        if (holds.get(path) !== waiting) return;
        holds.delete(path);
        for (const respond of waiting) respond();
      };
    },
    assertHealthy() {
      assert.deepEqual(errors, [], 'No uncaught browser exceptions');
      assert.deepEqual(unexpected, [], 'Only registered local fixture APIs are used');
    },
  };
}

export type ConsoleFixture = Awaited<ReturnType<typeof createConsoleFixture>>;

export async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  const deadline = Date.now() + 8000;
  let stableFrames = 0;
  while (Date.now() < deadline) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const busy = await page.locator('[aria-busy="true"]').count();
    if (!pendingRequests.get(page)?.size && !busy) {
      if (++stableFrames >= 2) return;
    } else stableFrames = 0;
    await delay(20);
  }
  assert.fail(`Console did not settle: ${[...pendingRequests.get(page) ?? []].map((request) => request.url()).join(', ') || 'rendered busy state'}`);
}

export function requestCounts(fixture: ConsoleFixture) {
  const counts: Record<string, number> = {};
  for (const request of fixture.requests) {
    const key = `${request.method} ${request.path}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function assertNoAutomaticReads(fixture: ConsoleFixture) {
  const { page } = fixture;
  await settle(page);
  const before = requestCounts(fixture);
  assert.equal(await page.getByRole('checkbox', { name: /auto.?refresh|refresh queue|real.?time/i }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /auto.?refresh|refresh queue|real.?time/i }).count(), 0);
  await page.clock.fastForward(300_000);
  await settle(page);
  assert.deepEqual(requestCounts(fixture), before, 'Five visible minutes must not fetch any endpoint');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await page.clock.fastForward(300_000);
  await settle(page);
  assert.deepEqual(requestCounts(fixture), before, 'Five hidden minutes must not fetch any endpoint');
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward(300_000);
  await settle(page);
  assert.deepEqual(requestCounts(fixture), before, 'Visibility, focus and connectivity recovery must not fetch');
}
