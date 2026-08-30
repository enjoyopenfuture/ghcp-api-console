import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AiCreditsUsageDto, BatchResult, ImportCopilotOauthTokenRow, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUserStatus, LoginRuntimeSettingsDto, LoginRuntimeSettingsValues, LoginTaskDto, LoginTaskStatus, ProxyAccountDto, ProxyErrorDiagnosticDetailDto, ProxyErrorDiagnosticsListResponse, ProxyRequestStatDto, SsoRuntimeSettingsDto, SsoRuntimeSettingsValues, SsoType, SsoUserBatchOperation, SsoUserBatchRequest, SsoUserBatchRow, SsoUserCapacityDto, SsoUserDto } from '@ghcp/shared';
import { api, ConsoleApiError } from './api/client.js';
import { cancelLoginTask, deleteLoginTask, getLoginRuntimeSettings, listLoginTasks, listLoginTasksPage, retryLoginTask, updateLoginRuntimeSettings } from './api/login.js';
import { clearErrorDiagnostics, deleteProxyAccount, downloadErrorDiagnostic, getErrorDiagnostic, importCopilotOauthTokens, listErrorDiagnostics, listProxyAccounts, listRequestStats, reauthorizeCopilotOauth } from './api/proxy.js';
import {
  createSsoUser,
  applyEmuImportPlan,
  createEmuImportPlan,
  deleteEmuImportPlan,
  importSsoUsers,
  getSsoUserCapacity,
  getSsoRuntimeSettings,
  listEmuImportPlanRows,
  listSsoUsers,
  patchSsoUser,
  readAiCreditsUsage,
  refreshAiCreditsUsage,
  runSsoUserBatch,
  updateSsoRuntimeSettings,
} from './api/sso.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardDescription, CardTitle } from './components/ui/card.js';
import { Dialog } from './components/ui/dialog.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { Tooltip } from './components/ui/tooltip.js';
import { formatDate, formatNumber, statusTone, tokenTotal } from './lib/format.js';

interface SetupState {
  initialized: boolean;
}

type Page = 'dashboard' | 'users' | 'budgets' | 'stats' | 'accounts' | 'tasks' | 'settings' | 'error-diagnostics' | 'diagnostics';
type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
const EMU_IMPORT_ROW_PAGE_SIZE = 100;
const EMU_IMPORT_ROW_STATUSES: (ImportEmuUserStatus | '')[] = ['', 'pending_create', 'pending_update', 'created', 'updated', 'skipped', 'conflict', 'failed'];
const LOGIN_TASK_STATUSES: (LoginTaskStatus | '')[] = ['', 'pending', 'running', 'success', 'failed', 'cancelled'];

const pages: { id: Page; label: string; description: string }[] = [
  { id: 'dashboard', label: 'Dashboard', description: 'Health, failures, and top operational signals.' },
  { id: 'users', label: 'SSO Users', description: 'Create, import, sync, suspend, and manage SSO accounts.' },
  { id: 'budgets', label: 'AI Credits Usage', description: 'Review enterprise AI Credits consumption and Copilot seat cost.' },
  { id: 'stats', label: 'Request Stats', description: 'Review request failures and input/output/cache token usage.' },
  { id: 'accounts', label: 'Proxy Accounts', description: 'Inspect identity mappings and refresh GitHub or Copilot tokens.' },
  { id: 'tasks', label: 'Login Tasks', description: 'Monitor automatic login and GitHub-token refresh tasks.' },
  { id: 'settings', label: 'Settings', description: 'Change the Console password and update runtime service settings.' },
  { id: 'error-diagnostics', label: 'Error Diagnostics', description: 'Inspect complete Copilot upstream failure snapshots.' },
  { id: 'diagnostics', label: 'Diagnostics', description: 'Check console-to-service API connectivity.' },
];

export function App() {
  const [initialized, setInitialized] = useState<boolean | undefined>();
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api<SetupState>('/api/console/setup')
      .then((state) => setInitialized(state.initialized))
      .catch((err: Error) => setError(err.message));
    void api('/api/console/me').then(() => setAuthed(true)).catch(() => undefined);
  }, []);

  if (initialized === undefined) return <AuthShell error={error}>Loading console...</AuthShell>;
  if (!initialized) return <AuthForm mode="setup" onDone={() => { setInitialized(true); setAuthed(true); }} />;
  if (!authed) return <AuthForm mode="login" onDone={() => setAuthed(true)} />;
  return <AdminApp onLogout={() => setAuthed(false)} />;
}

function AuthForm(props: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setError(undefined);
    setSaving(true);
    try {
      await api(`/api/console/${props.mode}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <AuthShell error={error}>
      <Card className="mx-auto mt-20 max-w-md">
        <CardTitle>{props.mode === 'setup' ? 'Initialize Console' : 'Admin Login'}</CardTitle>
        <CardDescription>Sign in before accessing service operations and token controls.</CardDescription>
        <div className="flex flex-col gap-3">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" />
          <Input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" />
          <Button onClick={submit} disabled={saving}>{saving ? 'Working...' : props.mode === 'setup' ? 'Create admin' : 'Sign in'}</Button>
        </div>
      </Card>
    </AuthShell>
  );
}

function AuthShell(props: { children: ReactNode; error?: string }) {
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <header className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold text-slate-950">GHCP Production Console</h1>
        <p className="text-sm text-slate-600">Accounts, SSO users, AI Credits usage, request stats, and login operations.</p>
      </header>
      {props.error ? <p className="mx-auto mt-4 max-w-6xl rounded bg-red-50 p-3 text-sm text-red-700">{props.error}</p> : null}
      {props.children}
    </main>
  );
}

function AdminApp(props: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>(() => readPageFromHash());
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'warning' | 'error' }>();

  useEffect(() => {
    const onHash = () => setPage(readPageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const notify: Notify = (message, tone = 'success') => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(undefined), 4000);
  };

  const navigate = (next: Page) => {
    window.location.hash = next;
    setPage(next);
  };

  const current = pages.find((entry) => entry.id === page) ?? pages[0]!;
  return (
    <div className="min-h-screen bg-slate-100">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-4 lg:block">
        <h1 className="text-xl font-bold text-slate-950">GHCP API Console</h1>
        <p className="mt-1 text-xs text-slate-500">provided by openfuture</p>
        <nav className="mt-6 flex flex-col gap-1">
          {pages.map((entry) => (
            <button
              key={entry.id}
              className={`rounded-md px-3 py-2 text-left text-sm font-medium ${entry.id === page ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              onClick={() => navigate(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-semibold text-slate-950">{current.label}</h2>
                <Badge tone="info">local</Badge>
              </div>
              <p className="text-sm text-slate-600">{current.description}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm lg:hidden" value={page} onChange={(event) => navigate(event.target.value as Page)}>
                {pages.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
              <Button variant="secondary" onClick={async () => { await api('/api/console/logout', { method: 'POST' }); props.onLogout(); }}>Logout</Button>
            </div>
          </div>
        </header>
        <main className="p-6">
          {page === 'dashboard' ? <DashboardPage notify={notify} /> : null}
          {page === 'users' ? <UsersPage notify={notify} /> : null}
          {page === 'budgets' ? <AiCreditsUsagePage notify={notify} /> : null}
          {page === 'stats' ? <RequestStatsPage /> : null}
          {page === 'accounts' ? <ProxyAccountsPage notify={notify} /> : null}
          {page === 'tasks' ? <LoginTasksPage notify={notify} /> : null}
          {page === 'settings' ? <SettingsPage notify={notify} /> : null}
          {page === 'error-diagnostics' ? <ErrorDiagnosticsPage notify={notify} /> : null}
          {page === 'diagnostics' ? <DiagnosticsPage /> : null}
        </main>
      </div>
      {toast ? (
        <div className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 text-sm shadow-lg ${
          toast.tone === 'success' ? 'bg-slate-950 text-white' : toast.tone === 'warning' ? 'bg-amber-500 text-amber-950' : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function DashboardPage(_props: { notify: Notify }) {
  const [accounts, setAccounts] = useState<ProxyAccountDto[]>([]);
  const [users, setUsers] = useState<SsoUserDto[]>([]);
  const [tasks, setTasks] = useState<LoginTaskDto[]>([]);
  const [stats, setStats] = useState<ProxyRequestStatDto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void Promise.allSettled([
      listProxyAccounts({ pageSize: 100 }),
      listSsoUsers({ pageSize: 100 }),
      listLoginTasks(20),
      listRequestStats({ limit: 100 }),
    ]).then(([accountResult, userResult, taskResult, statResult]) => {
      if (!mounted) return;
      const nextErrors: Record<string, string> = {};
      if (accountResult.status === 'fulfilled') setAccounts(accountResult.value.items);
      else nextErrors.accounts = accountResult.reason instanceof Error ? accountResult.reason.message : String(accountResult.reason);
      if (userResult.status === 'fulfilled') setUsers(userResult.value.items);
      else nextErrors.users = userResult.reason instanceof Error ? userResult.reason.message : String(userResult.reason);
      if (taskResult.status === 'fulfilled') setTasks(taskResult.value);
      else nextErrors.tasks = taskResult.reason instanceof Error ? taskResult.reason.message : String(taskResult.reason);
      if (statResult.status === 'fulfilled') setStats(statResult.value);
      else nextErrors.stats = statResult.reason instanceof Error ? statResult.reason.message : String(statResult.reason);
      setErrors(nextErrors);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  const failedTasks = tasks.filter((task) => task.status === 'failed').slice(0, 5);
  const failedStats = stats.filter((stat) => !stat.success).slice(0, 5);
  const totals = stats.reduce((sum, stat) => ({
    input: sum.input + (stat.inputTokens ?? 0),
    output: sum.output + (stat.outputTokens ?? 0),
    cache: sum.cache + (statCacheTokens(stat) ?? 0),
    cacheInput: sum.cacheInput + (stat.cacheInputTokens ?? 0),
    cacheWrite: sum.cacheWrite + (stat.cacheWriteTokens ?? 0),
  }), { input: 0, output: 0, cache: 0, cacheInput: 0, cacheWrite: 0 });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Proxy accounts" value={accounts.length} detail={countBy(accounts, 'copilotOauthStatus')} error={errors.accounts} />
        <MetricCard title="SSO users" value={users.length} detail={countBy(users, 'emuStatus')} error={errors.users} />
        <MetricCard title="Login failures" value={failedTasks.length} detail={`${tasks.length} recent task(s)`} error={errors.tasks} />
        <MetricCard title="Recent tokens" value={formatNumber(totals.input + totals.output + totals.cache)} detail={`in ${formatNumber(totals.input)} / out ${formatNumber(totals.output)} / cache ${formatNumber(totals.cache)} (input ${formatNumber(totals.cacheInput)} / write ${formatNumber(totals.cacheWrite)})`} error={errors.stats} />
      </div>
      {loading ? <LoadingState label="Loading dashboard..." /> : null}
      <div className="grid gap-4">
        <Card className="min-w-0">
          <CardTitle>Recent failed login tasks</CardTitle>
          <LoginTasksTable tasks={failedTasks} compact />
        </Card>
        <Card className="min-w-0">
          <CardTitle>Recent failed proxy requests</CardTitle>
          <RequestStatsTable stats={failedStats} compact />
        </Card>
      </div>
    </div>
  );
}

function UsersPage(props: { notify: Notify }) {
  const [users, setUsers] = useState<SsoUserDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [emuImportOpen, setEmuImportOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState<SsoUserDto>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<string>();
  const [batchResult, setBatchResult] = useState<UserBatchActionResult>();
  const [capacity, setCapacity] = useState<SsoUserCapacityDto>();
  const [assignCopilotOnSync, setAssignCopilotOnSync] = useState(false);
  const allCurrentPageSelected = users.length > 0 && users.every((user) => selected.has(user.ssoUser));

  const load = async (nextPage = page) => {
    setLoading(true);
    setError(undefined);
    try {
      const [result, nextCapacity] = await Promise.all([
        listSsoUsers({ q, page: nextPage, pageSize: 25, sort: 'ssoUser', dir: 'asc' }),
        getSsoUserCapacity(),
      ]);
      setUsers(result.items);
      setTotal(result.total);
      setPage(result.page);
      setCapacity(nextCapacity);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
  }, []);

  const setUserSelected = (ssoUser: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(ssoUser);
      else next.delete(ssoUser);
      return next;
    });
  };

  const setCurrentPageSelected = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const user of users) {
        if (checked) next.add(user.ssoUser);
        else next.delete(user.ssoUser);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const runBulkUserAction = async (
    operation: SsoUserBatchOperation,
    label: string,
    confirmMessage?: (count: number) => string,
    requestOptions: Pick<SsoUserBatchRequest, 'assignCopilotSeat'> = {},
  ) => {
    const ssoUsers = [...selected];
    if (ssoUsers.length === 0) return;
    if (confirmMessage && !window.confirm(confirmMessage(ssoUsers.length))) return;
    setBulkAction(label);
    try {
      const result = await runSsoUserBatch({ operation, ssoUsers, ...requestOptions });
      const failed = result.rows.filter((row) => row.status === 'failed');
      const warnings = result.summary.warnings ?? result.rows.filter((row) => row.warning).length;
      setBatchResult({ title: label, result });
      setSelected(new Set(failed.map((row) => row.ssoUser)));
      props.notify(
        `${label}: ${result.summary.success} succeeded, ${result.summary.failed} failed${warnings > 0 ? `, ${warnings} warning(s)` : ''}.`,
        result.summary.failed > 0 ? 'error' : warnings > 0 ? 'warning' : 'success',
      );
      await load();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    } finally {
      setBulkAction(undefined);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="relative">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <form
            className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              clearSelection();
              void load(1);
            }}
          >
            <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search SSO user, email, or GH login" className="flex-1 w-full max-w-xl" />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            {capacity ? (
              <span className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                capacity.reached ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}>
                {capacity.current}{capacity.limit === null ? ' users / unlimited' : ` / ${capacity.limit} users`}
                {capacity.remaining !== null ? ` - ${capacity.remaining} remaining` : ''}
              </span>
            ) : null}
            <Button variant="secondary" onClick={() => setBatchOpen(true)} disabled={!capacity || capacity.reached}>Batch create</Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>Import CSV</Button>
            <Button variant="secondary" onClick={() => setEmuImportOpen(true)}>Import from GH</Button>
            <Button onClick={() => setCreateOpen(true)} disabled={!capacity || capacity.reached}>Create user</Button>
          </div>
        </div>
      </Card>
      <BulkUserActionBar
        count={selected.size}
        busy={bulkAction}
        assignCopilotOnSync={assignCopilotOnSync}
        onAssignCopilotOnSyncChange={setAssignCopilotOnSync}
        onSync={() => runBulkUserAction(
          'sync_emu',
          'Sync GH login',
          undefined,
          assignCopilotOnSync ? { assignCopilotSeat: true } : {},
        )}
        onAssignCopilot={() => runBulkUserAction('assign_copilot', 'Assign Copilot seat')}
        onRemoveCopilot={() => runBulkUserAction('remove_copilot', 'Remove Copilot seat', (count) => `Remove Copilot seat(s) for ${count} selected user(s)?`)}
        onSuspend={() => runBulkUserAction('suspend_emu', 'Suspend GH login', (count) => `Suspend ${count} selected GH login(s)?`)}
        onDeleteEmu={() => runBulkUserAction('delete_emu', 'Delete GH login data', (count) => `Delete provisioned GH login data for ${count} selected user(s)? Copilot seats will be removed first.`)}
        onDeleteSso={() => runBulkUserAction('delete_sso', 'Delete SSO users', (count) => `Delete ${count} selected local SSO user(s)? Copilot seats and provisioned GH login data will be deleted first when present.`)}
        onClear={clearSelection}
      />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState label="Loading users..." /> : null}
      <Card className="p-0">
        <div className="min-h-48 max-h-[70vh] overflow-auto rounded-lg">
          <Table>
            <thead className="sticky top-0 z-10">
              <tr>
                <Th><input type="checkbox" checked={allCurrentPageSelected} onChange={(event) => setCurrentPageSelected(event.target.checked)} aria-label="Select all users on current page" /></Th>
                <Th>SSO user</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>GH login</Th>
                <Th>Status</Th>
                <Th>Copilot seat</Th>
                <Th>Updated</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.ssoUser}>
                  <Td><input type="checkbox" checked={selected.has(user.ssoUser)} onChange={(event) => setUserSelected(user.ssoUser, event.target.checked)} aria-label={`Select ${user.ssoUser}`} /></Td>
                  <Td className="font-medium">{user.ssoUser}</Td>
                  <Td className="max-w-64 truncate" title={user.email}>{user.email}</Td>
                  <Td><Badge tone={user.role === 'admin' ? 'info' : 'default'}>{user.role}</Badge></Td>
                  <Td>{user.ghLogin ?? '-'}</Td>
                  <Td><Badge tone={statusTone(user.emuStatus)}>{user.emuStatus}</Badge></Td>
                  <Td><CopilotSeatCell user={user} /></Td>
                  <Td>{formatDate(user.updatedAt)}</Td>
                  <Td><Button variant="secondary" onClick={() => setEditing(user)}>Edit</Button></Td>
                </tr>
              ))}
              {users.length === 0 ? <EmptyRow colSpan={9} label="No SSO users found." /> : null}
            </tbody>
          </Table>
        </div>
      </Card>
      <Pagination page={page} total={total} pageSize={25} onPage={(next) => { clearSelection(); void load(next); }} />
      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} onDone={async () => { setCreateOpen(false); await load(1); props.notify('SSO user created.'); }} />
      <ImportUsersDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={async () => { await load(1); props.notify('Import completed.'); }} />
      <ImportEmuUsersDialog open={emuImportOpen} onClose={() => setEmuImportOpen(false)} onDone={async () => { await load(1); props.notify('GH import completed.'); }} />
      <BatchCreateDialog open={batchOpen} remaining={capacity?.remaining ?? null} onClose={() => setBatchOpen(false)} onDone={async () => { setBatchOpen(false); await load(1); props.notify('Batch create completed.'); }} />
      <EditUserDialog user={editing} onClose={() => setEditing(undefined)} onDone={async () => { setEditing(undefined); await load(); props.notify('SSO user updated.'); }} />
      <UserBatchActionResultDialog result={batchResult} onClose={() => setBatchResult(undefined)} />
    </div>
  );
}

interface UserBatchActionResult {
  title: string;
  result: BatchResult<SsoUserBatchRow>;
}

function BulkUserActionBar(props: {
  count: number;
  busy?: string;
  assignCopilotOnSync: boolean;
  onAssignCopilotOnSyncChange: (checked: boolean) => void;
  onSync: () => void;
  onAssignCopilot: () => void;
  onRemoveCopilot: () => void;
  onSuspend: () => void;
  onDeleteEmu: () => void;
  onDeleteSso: () => void;
  onClear: () => void;
}) {
  const disabled = props.count === 0 || Boolean(props.busy);
  return (
    <Card className={`sticky top-36 z-20 shadow-md backdrop-blur lg:top-24 ${props.count > 0 ? 'border-blue-200 bg-blue-50/95' : 'bg-white/95'}`}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <p className={`text-sm font-semibold ${props.count > 0 ? 'text-blue-950' : 'text-slate-700'}`}>{props.count} user{props.count === 1 ? '' : 's'} selected</p>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={props.onClear} disabled={disabled}>Clear selection</Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(22rem,1.35fr)_minmax(16rem,1fr)_minmax(20rem,1.15fr)_auto] 2xl:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">GitHub sync</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Tooltip content="Create or update the selected GH managed logins. A Copilot seat is assigned only when this option is selected.">
                <Button variant="warning" onClick={props.onSync} disabled={disabled}>{props.busy === 'Sync GH login' ? 'Syncing...' : 'Sync GH login'}</Button>
              </Tooltip>
              <label className="flex items-center gap-2 whitespace-nowrap px-1 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={props.assignCopilotOnSync}
                  disabled={disabled}
                  onChange={(event) => props.onAssignCopilotOnSyncChange(event.target.checked)}
                />
                Also assign Copilot seat
              </label>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Copilot</p>
            <div className="flex flex-wrap gap-2">
              <Tooltip content="Assign a Copilot seat to each selected user that already has a GH login.">
                <Button variant="secondary" onClick={props.onAssignCopilot} disabled={disabled}>{props.busy === 'Assign Copilot seat' ? 'Assigning...' : 'Assign seat'}</Button>
              </Tooltip>
              <Tooltip content="Remove the Copilot seat from each selected GH login without changing the GH login or local SSO user.">
                <Button variant="secondary" onClick={props.onRemoveCopilot} disabled={disabled}>{props.busy === 'Remove Copilot seat' ? 'Removing...' : 'Remove seat'}</Button>
              </Tooltip>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">GH account</p>
            <div className="flex flex-wrap gap-2">
              <Tooltip content="Suspend each selected GH managed login. Copilot seats and local SSO users are not removed.">
                <Button variant="warning" onClick={props.onSuspend} disabled={disabled}>{props.busy === 'Suspend GH login' ? 'Suspending...' : 'Suspend'}</Button>
              </Tooltip>
              <Tooltip content="Remove the Copilot seat, delete the provisioned GH login, and reset its local sync status. The local SSO user and Proxy data are retained.">
                <Button variant="dangerOutline" onClick={props.onDeleteEmu} disabled={disabled}>{props.busy === 'Delete GH login data' ? 'Deleting...' : 'Delete GH login'}</Button>
              </Tooltip>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Local account</p>
            <Button variant="danger" onClick={props.onDeleteSso} disabled={disabled}>{props.busy === 'Delete SSO users' ? 'Deleting...' : 'Delete Users'}</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function CopilotSeatCell(props: { user: SsoUserDto }) {
  const updated = props.user.copilotSeatUpdatedAt ? formatDate(props.user.copilotSeatUpdatedAt) : undefined;
  return (
    <div className="flex max-w-48 items-center gap-1.5">
      <Badge tone={statusTone(props.user.copilotSeatStatus)} title={updated}>{props.user.copilotSeatStatus}</Badge>
      {props.user.copilotSeatLastError ? (
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-xs font-bold text-red-700"
          title={props.user.copilotSeatLastError}
          aria-label={props.user.copilotSeatLastError}
        >
          !
        </span>
      ) : null}
    </div>
  );
}

function UserBatchActionResultDialog(props: { result?: UserBatchActionResult; onClose: () => void }) {
  if (!props.result) return null;
  const failed = props.result.result.summary.failed;
  const success = props.result.result.summary.success;
  const warnings = props.result.result.summary.warnings ?? props.result.result.rows.filter((row) => row.warning).length;
  return (
    <Dialog title={props.result.title} description={`${success} succeeded, ${failed} failed${warnings > 0 ? `, ${warnings} warning(s)` : ''}.`} open={Boolean(props.result)} onClose={props.onClose}>
      <ul className="max-h-80 overflow-auto rounded-md bg-slate-50 p-3 text-sm">
        {props.result.result.rows.map((row) => (
          <li key={`${row.ssoUser}-${row.status}`} className={row.status === 'failed' ? 'text-red-700' : row.warning ? 'text-amber-700' : 'text-slate-700'}>
            {row.ssoUser} - {row.status} - {row.detail}{row.warning ? ` Warning: ${row.warning}` : ''}
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end">
        <Button onClick={props.onClose}>Close</Button>
      </div>
    </Dialog>
  );
}

function AiCreditsUsagePage(props: { notify: Notify }) {
  const [usage, setUsage] = useState<AiCreditsUsageDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = refresh ? await refreshAiCreditsUsage() : await readAiCreditsUsage();
      setUsage(next);
      if (refresh) props.notify('AI Credits usage refreshed.');
    } catch (err) {
      if (!refresh) {
        try {
          const next = await refreshAiCreditsUsage();
          setUsage(next);
          return;
        } catch (refreshErr) {
          setError((refreshErr as Error).message);
          return;
        }
      }
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle className="mb-1">AI Credits Usage</CardTitle>
            <p className="text-sm text-slate-600">Enterprise-level Copilot AI Credits consumption from GitHub billing usage summary.</p>
          </div>
          <Button onClick={() => void load(true)} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh usage'}</Button>
        </div>
      </Card>
      {loading ? <LoadingState label="Loading AI Credits usage..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {usage ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard title={`${periodLabel(usage.lastMonth)} usage`} value={formatAiUnits(usage.lastMonth.quantity)} detail={usage.lastMonth.unitType ?? 'AI Credits'} />
            <MetricCard title={`${periodLabel(usage.currentMonth)} usage`} value={formatAiUnits(usage.currentMonth.quantity)} detail={usage.currentMonth.unitType ?? 'AI Credits'} />
            <MetricCard title="Projected this month" value={formatAiUnits(usage.projectedCurrentMonthQuantity)} detail="Based on daily average so far" />
            <MetricCard title="Assigned seats" value={usage.assignedSeatCount} detail="Tracked in SSO Copilot seat status" />
            <MetricCard title="Seat monthly cost" value={formatCurrency(usage.assignedSeatMonthlyCost)} detail={`${formatCurrency(usage.seatPricePerMonth)} x ${usage.assignedSeatCount} seat(s)`} />
          </div>
          <Card>
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <Info label="Enterprise" value={usage.enterprise} />
              <Info label="Last fetched" value={formatDate(usage.fetchedAt)} />
              <Info label="Source" value="GitHub billing usage summary / copilot_ai_unit" />
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function RequestStatsPage() {
  const [stats, setStats] = useState<ProxyRequestStatDto[]>([]);
  const [identity, setIdentity] = useState('');
  const [success, setSuccess] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setStats(await listRequestStats({ limit: 1000 }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => stats.filter((stat) => {
    if (identity && !`${stat.identity} ${stat.ghLogin ?? ''}`.toLowerCase().includes(identity.toLowerCase())) return false;
    if (success && String(stat.success) !== success) return false;
    if (model && !(stat.model ?? '').toLowerCase().includes(model.toLowerCase())) return false;
    return true;
  }), [identity, model, stats, success]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="Identity or GH login" />
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model" />
          <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={success} onChange={(event) => setSuccess(event.target.value)}>
            <option value="">All outcomes</option>
            <option value="true">Success</option>
            <option value="false">Failed</option>
          </select>
          <Button variant="secondary" onClick={load}>Refresh</Button>
        </div>
      </Card>
      {loading ? <LoadingState label="Loading request stats..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      <Card className="overflow-hidden p-0">
        <RequestStatsTable stats={filtered} />
      </Card>
    </div>
  );
}

function ProxyAccountsPage(props: { notify: Notify }) {
  const [accounts, setAccounts] = useState<ProxyAccountDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [oauthReauthorization, setOauthReauthorization] = useState<ProxyAccountDto>();
  const [detail, setDetail] = useState<ProxyAccountDto>();
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const allCurrentPageSelected = accounts.length > 0 && accounts.every((account) => selected.has(account.identity));
  const selectedAccounts = accounts.filter((account) => selected.has(account.identity));
  const singleSelected = selected.size === 1 ? selectedAccounts[0] : undefined;

  const load = async (nextPage = page) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listProxyAccounts({ q, page: nextPage, pageSize: 25, sort: 'updatedAt', dir: 'desc' });
      setAccounts(result.items);
      setTotal(result.total);
      setPage(result.page);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setAccountSelected = (identity: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(identity);
      else next.delete(identity);
      return next;
    });
  };

  const setCurrentPageSelected = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const account of accounts) {
        if (checked) next.add(account.identity);
        else next.delete(account.identity);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const deleteSelected = async () => {
    const identities = [...selected];
    if (identities.length === 0) return;
    if (!window.confirm(
      `Delete ${identities.length} selected Proxy account(s)? OAuth credentials and request stats will be deleted. SSO/GH users are not affected, and a future request may recreate the account and trigger login.`,
    )) return;
    setDeleting(true);
    const failures: Array<{ identity: string; message: string }> = [];
    try {
      for (const identity of identities) {
        try {
          await deleteProxyAccount(identity);
        } catch (err) {
          failures.push({ identity, message: (err as Error).message });
        }
      }
      const succeeded = identities.length - failures.length;
      setSelected(new Set(failures.map((failure) => failure.identity)));
      if (detail && identities.includes(detail.identity)) setDetail(undefined);
      if (oauthReauthorization && identities.includes(oauthReauthorization.identity)) setOauthReauthorization(undefined);
      props.notify(
        `Proxy account delete: ${succeeded} succeeded, ${failures.length} failed.${failures[0] ? ` ${failures[0].identity}: ${failures[0].message}` : ''}`,
        failures.length > 0 ? 'error' : 'success',
      );
      const remainingTotal = Math.max(0, total - succeeded);
      const nextPage = Math.min(page, Math.max(1, Math.ceil(remainingTotal / 25)));
      await load(nextPage);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle className="mb-1">Proxy accounts</CardTitle>
            <p className="text-sm text-slate-600">Identity header mappings, token status, and manual recovery actions.</p>
          </div>
          <div className="flex flex-1 justify-end gap-2">
            <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search identity, SSO user, or GH login" className="max-w-md flex-1" />
            <Button variant="secondary" onClick={() => setImportOpen(true)}>Import Copilot OAuth tokens</Button>
            <Button variant="secondary" onClick={() => { clearSelection(); void load(1); }}>Search</Button>
            <Button variant="secondary" onClick={() => void load()}>Refresh list</Button>
          </div>
        </div>
      </Card>
      <ProxyAccountActionBar
        count={selected.size}
        singleSelected={Boolean(singleSelected)}
        deleting={deleting}
        onDetails={() => { if (singleSelected) setDetail(singleSelected); }}
        onReauthorize={() => { if (singleSelected) setOauthReauthorization(singleSelected); }}
        onDelete={deleteSelected}
        onClear={clearSelection}
      />
      {loading ? <LoadingState label="Loading proxy accounts..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      <Card className="overflow-hidden p-0">
        <Table>
          <thead>
            <tr>
              <Th><input type="checkbox" checked={allCurrentPageSelected} onChange={(event) => setCurrentPageSelected(event.target.checked)} aria-label="Select all proxy accounts on current page" /></Th>
              <Th>Header identity</Th>
              <Th>SSO user</Th>
              <Th>GH login</Th>
              <Th>Copilot OAuth</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.identity}>
                <Td><input type="checkbox" checked={selected.has(account.identity)} onChange={(event) => setAccountSelected(account.identity, event.target.checked)} aria-label={`Select ${account.identity}`} /></Td>
                <Td className="font-medium">{account.identity}</Td>
                <Td>{account.ssoUser}</Td>
                <Td>{account.ghLogin ?? '-'}</Td>
                <Td><StatusWithDate status={account.copilotOauthStatus} date={account.copilotOauthUpdatedAt} /></Td>
                <Td>{formatDate(account.updatedAt)}</Td>
              </tr>
            ))}
            {accounts.length === 0 ? <EmptyRow colSpan={6} label="No proxy accounts found." /> : null}
          </tbody>
        </Table>
      </Card>
      <Pagination page={page} total={total} pageSize={25} onPage={(next) => { clearSelection(); void load(next); }} />
      <CopilotOauthReauthorizationDialog account={oauthReauthorization} onClose={() => setOauthReauthorization(undefined)} onDone={async () => { setOauthReauthorization(undefined); props.notify('Copilot OAuth reauthorization task requested.'); await load(); }} />
      <ProxyAccountDetailDialog account={detail} onClose={() => setDetail(undefined)} />
      <ImportCopilotOauthTokensDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={async () => { await load(1); props.notify('Copilot OAuth token import completed.'); }} />
    </div>
  );
}

function ProxyAccountActionBar(props: {
  count: number;
  singleSelected: boolean;
  deleting: boolean;
  onDetails: () => void;
  onReauthorize: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const singleDisabled = !props.singleSelected || props.deleting;
  return (
    <Card className="border-blue-200 bg-blue-50">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm font-medium text-blue-900">{props.count} selected</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.onDetails} disabled={singleDisabled}>Details</Button>
          <Button onClick={props.onReauthorize} disabled={singleDisabled}>Reauthorize Copilot</Button>
          <Button variant="danger" onClick={props.onDelete} disabled={props.count === 0 || props.deleting}>{props.deleting ? 'Deleting...' : 'Delete selected'}</Button>
          <Button variant="ghost" onClick={props.onClear} disabled={props.count === 0 || props.deleting}>Clear selection</Button>
        </div>
      </div>
    </Card>
  );
}

function ImportCopilotOauthTokensDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [csvText, setCsvText] = useState('name,copilotOauthToken\n');
  const [result, setResult] = useState<BatchResult<ImportCopilotOauthTokenRow>>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const importResult = await importCopilotOauthTokens(csvText);
      setResult(importResult);
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Import Copilot OAuth tokens"
      description="CSV format: name,copilotOauthToken. Tokens must come from the OpenCode OAuth client and are validated against Copilot /models before storage."
      open={props.open}
      onClose={props.onClose}
    >
      <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
        Create missing SSO users manually before importing. Validated tokens overwrite existing credentials and are never echoed back.
      </div>
      <Textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} className="h-56 w-full font-mono" />
      {result ? (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">Batch {result.batchId}: {result.summary.success} success, {result.summary.failed} failed</p>
          <ul className="mt-2 max-h-52 overflow-auto">
            {result.rows.map((row) => (
              <li key={`${row.line}-${row.name}`} className={row.status === 'failed' ? 'text-red-700' : 'text-slate-700'}>
                Line {row.line}: {row.name || '-'} - {row.status} - {row.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Import" />
    </Dialog>
  );
}

function LoginTasksPage(props: { notify: Notify }) {
  const [tasks, setTasks] = useState<LoginTaskDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<LoginTaskStatus | ''>('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<LoginTaskDto>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const load = async (nextPage = page) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listLoginTasksPage({ q, status, page: nextPage, pageSize: 25 });
      setTasks(result.items);
      setTotal(result.total);
      setPage(result.page);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedTasks = tasks.filter((task) => selected.has(task.id));
  const singleSelected = selectedTasks.length === 1 ? selectedTasks[0] : undefined;
  const cancellableSelected = selectedTasks.filter((task) => !isTerminalLoginTask(task));
  const deletableSelected = selectedTasks.filter(isDeletableLoginTask);
  const hasNonDeletableSelected = selectedTasks.some((task) => !isDeletableLoginTask(task));
  const allCurrentPageSelected = tasks.length > 0 && tasks.every((task) => selected.has(task.id));

  const setTaskSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const setFilteredSelected = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const task of tasks) {
        if (checked) next.add(task.id);
        else next.delete(task.id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const cancelSelected = async () => {
    if (cancellableSelected.length === 0) return;
    if (!window.confirm(`Cancel ${cancellableSelected.length} selected login task(s)?`)) return;
    const failures: string[] = [];
    try {
      for (const task of cancellableSelected) {
        try {
          await cancelLoginTask(task.id);
        } catch (err) {
          failures.push(`${task.id}: ${(err as Error).message}`);
        }
      }
      props.notify(
        `Login task cancel: ${cancellableSelected.length - failures.length} succeeded, ${failures.length} failed.${failures[0] ? ` ${failures[0]}` : ''}`,
        failures.length > 0 ? 'error' : 'success',
      );
      clearSelection();
      await load();
    } catch (err) {
      props.notify((err as Error).message, 'error');
    }
  };

  const deleteSelected = async () => {
    if (deletableSelected.length === 0 || hasNonDeletableSelected) return;
    if (!window.confirm(`Delete ${deletableSelected.length} selected login task(s)? This cannot be undone.`)) return;
    const failures: string[] = [];
    for (const task of deletableSelected) {
      try {
        await deleteLoginTask(task.id);
      } catch (err) {
        failures.push(`${task.id}: ${(err as Error).message}`);
      }
    }
    props.notify(
      `Login task delete: ${deletableSelected.length - failures.length} succeeded, ${failures.length} failed.${failures[0] ? ` ${failures[0]}` : ''}`,
      failures.length > 0 ? 'error' : 'success',
    );
    clearSelection();
    await load(page);
  };

  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between">
        <div>
          <CardTitle className="mb-1">Login tasks</CardTitle>
          <p className="text-sm text-slate-600">Automatic GitHub device-flow and SSO login jobs.</p>
        </div>
        <div className="flex flex-1 justify-end gap-2">
          <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search task, identity, SSO user, or GH login" className="max-w-md flex-1" />
          <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={status} onChange={(event) => setStatus(event.target.value as LoginTaskStatus | '')}>
            {LOGIN_TASK_STATUSES.map((item) => <option key={item || 'all'} value={item}>{item || 'All statuses'}</option>)}
          </select>
          <Button variant="secondary" onClick={() => { clearSelection(); void load(1); }}>Search</Button>
          <Button variant="secondary" onClick={() => void load(page)}>Refresh</Button>
        </div>
      </Card>
      <LoginTaskActionBar
        count={selected.size}
        cancellableCount={cancellableSelected.length}
        deletableCount={deletableSelected.length}
        deleteBlocked={hasNonDeletableSelected}
        retryable={singleSelected?.status === 'failed'}
        onCancel={cancelSelected}
        onDelete={deleteSelected}
        onRetry={() => { if (singleSelected?.status === 'failed') setRetrying(singleSelected); }}
        onClear={clearSelection}
      />
      {loading ? <LoadingState label="Loading login tasks..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      <Card className="overflow-hidden p-0">
        <LoginTasksTable tasks={tasks} selected={selected} allSelected={allCurrentPageSelected} onSelect={setTaskSelected} onSelectAll={setFilteredSelected} />
      </Card>
      <Pagination page={page} total={total} pageSize={25} onPage={(next) => { clearSelection(); void load(next); }} />
      <RetryTaskDialog task={retrying} onClose={() => setRetrying(undefined)} onDone={async () => { setRetrying(undefined); props.notify('Login task retry queued.'); await load(); }} />
    </div>
  );
}

function LoginTaskActionBar(props: {
  count: number;
  cancellableCount: number;
  deletableCount: number;
  deleteBlocked: boolean;
  retryable: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onClear: () => void;
}) {
  return (
    <Card className="border-blue-200 bg-blue-50">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm font-medium text-blue-900">
          {props.count} selected
          {props.deleteBlocked ? <span className="ml-2 font-normal text-blue-700">Pending/running tasks cannot be deleted.</span> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.onCancel} disabled={props.cancellableCount === 0}>Cancel selected</Button>
          <Button variant="secondary" onClick={props.onRetry} disabled={!props.retryable}>Retry failed task</Button>
          <Button variant="danger" onClick={props.onDelete} disabled={props.deletableCount === 0 || props.deleteBlocked}>Delete selected</Button>
          <Button variant="ghost" onClick={props.onClear} disabled={props.count === 0}>Clear selection</Button>
        </div>
      </div>
    </Card>
  );
}

function isTerminalLoginTask(task: LoginTaskDto): boolean {
  return task.status === 'success' || task.status === 'failed' || task.status === 'cancelled';
}

function isDeletableLoginTask(task: LoginTaskDto): boolean {
  return task.status !== 'pending' && task.status !== 'running';
}

function SettingsPage(props: { notify: Notify }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <AdminPasswordCard notify={props.notify} />
      <SsoRuntimeSettingsCard notify={props.notify} />
      <LoginRuntimeSettingsCard notify={props.notify} />
    </div>
  );
}

function AdminPasswordCard(props: { notify: Notify }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setError(undefined);
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('Current password, new password, and confirmation are required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from the current password.');
      return;
    }
    setSaving(true);
    try {
      await api('/api/console/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      props.notify('Console administrator password changed.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardTitle>Console administrator password</CardTitle>
      <CardDescription>Change the password for the currently signed-in administrator. The current session remains signed in.</CardDescription>
      {error ? <ErrorState message={error} /> : null}
      <div className="space-y-3">
        <Label text="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Label>
        <Label text="New password">
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Label>
        <Label text="Confirm new password">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Label>
      </div>
      <div className="mt-5 flex justify-end border-t border-slate-200 pt-4">
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Changing...' : 'Change password'}</Button>
      </div>
    </Card>
  );
}

interface SsoSettingsDraft {
  maxSsoUsers: string;
  userPrefix: string;
  emailDomain: string;
  bulkSyncConcurrency: string;
  scimRequestDelayMs: string;
  scimMaxRetries: string;
  scimRetryBaseDelayMs: string;
}

function SsoRuntimeSettingsCard(props: { notify: Notify }) {
  const [settings, setSettings] = useState<SsoRuntimeSettingsDto>();
  const [draft, setDraft] = useState<SsoSettingsDraft>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await getSsoRuntimeSettings();
      setSettings(next);
      setDraft(toSsoSettingsDraft(next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!settings || !draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const changes: SsoRuntimeSettingsValues = {
        maxSsoUsers: draft.maxSsoUsers.trim() ? Number(draft.maxSsoUsers) : null,
        userPrefix: draft.userPrefix,
        emailDomain: draft.emailDomain,
        bulkSyncConcurrency: Number(draft.bulkSyncConcurrency),
        scimRequestDelayMs: Number(draft.scimRequestDelayMs),
        scimMaxRetries: Number(draft.scimMaxRetries),
        scimRetryBaseDelayMs: Number(draft.scimRetryBaseDelayMs),
      };
      const next = await updateSsoRuntimeSettings({ expectedVersion: settings.version, changes });
      setSettings(next);
      setDraft(toSsoSettingsDraft(next));
      props.notify('SSO settings saved and applied.');
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 409) {
        await load();
        setError('SSO settings changed in another session. The latest values were reloaded.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardTitle>SSO runtime settings</CardTitle>
      <CardDescription>Saved in sso.sqlite. Changes apply to new users, SCIM operations, and new sync batches without restarting SSO.</CardDescription>
      {loading ? <LoadingState label="Loading SSO settings..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {settings && draft ? (
        <>
          <FormGrid>
            <Label text="Maximum SSO users">
              <Input value={draft.maxSsoUsers} placeholder="Unlimited" type="number" min={1} max={1_000_000} onChange={(event) => setDraft({ ...draft, maxSsoUsers: event.target.value })} />
            </Label>
            <Label text="Fallback user prefix">
              <Input value={draft.userPrefix} onChange={(event) => setDraft({ ...draft, userPrefix: event.target.value })} />
            </Label>
            <Label text="Default email domain">
              <Input value={draft.emailDomain} onChange={(event) => setDraft({ ...draft, emailDomain: event.target.value })} />
            </Label>
            <Label text="Sync EMU concurrency">
              <Input value={draft.bulkSyncConcurrency} type="number" min={1} max={20} onChange={(event) => setDraft({ ...draft, bulkSyncConcurrency: event.target.value })} />
            </Label>
            <Label text="SCIM request delay (ms)">
              <Input value={draft.scimRequestDelayMs} type="number" min={0} max={60_000} onChange={(event) => setDraft({ ...draft, scimRequestDelayMs: event.target.value })} />
            </Label>
            <Label text="SCIM max retries">
              <Input value={draft.scimMaxRetries} type="number" min={0} max={10} onChange={(event) => setDraft({ ...draft, scimMaxRetries: event.target.value })} />
            </Label>
            <Label text="SCIM retry base delay (ms)">
              <Input value={draft.scimRetryBaseDelayMs} type="number" min={0} max={60_000} onChange={(event) => setDraft({ ...draft, scimRetryBaseDelayMs: event.target.value })} />
            </Label>
          </FormGrid>
          <SettingsFooter settings={settings} saving={saving} onSave={save} />
        </>
      ) : null}
    </Card>
  );
}

function LoginRuntimeSettingsCard(props: { notify: Notify }) {
  const [settings, setSettings] = useState<LoginRuntimeSettingsDto>();
  const [draft, setDraft] = useState<LoginRuntimeSettingsValues>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await getLoginRuntimeSettings();
      setSettings(next);
      setDraft(toLoginSettingsDraft(next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!settings || !draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await updateLoginRuntimeSettings({ expectedVersion: settings.version, changes: draft });
      setSettings(next);
      setDraft(toLoginSettingsDraft(next));
      props.notify('Login settings saved and applied.');
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 409) {
        await load();
        setError('Login settings changed in another session. The latest values were reloaded.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardTitle>Login runtime settings</CardTitle>
      <CardDescription>Saved in login.sqlite. Changes apply to queued work and newly started Playwright tasks; running tasks keep their starting snapshot.</CardDescription>
      {loading ? <LoadingState label="Loading Login settings..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {settings && draft ? (
        <>
          <FormGrid>
            <Label text="Login concurrency">
              <Input value={draft.concurrency} type="number" min={1} max={20} onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })} />
            </Label>
            <Label text="Authentication timeout (ms)">
              <Input value={draft.authTimeoutMs} type="number" min={5_000} max={600_000} onChange={(event) => setDraft({ ...draft, authTimeoutMs: Number(event.target.value) })} />
            </Label>
          </FormGrid>
          <div className="mt-4 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.authDebugLogs} onChange={(event) => setDraft({ ...draft, authDebugLogs: event.target.checked })} />
              Enable account debug logs for new tasks
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.authDebugArtifacts} onChange={(event) => setDraft({ ...draft, authDebugArtifacts: event.target.checked })} />
              Save debug artifacts for new tasks
            </label>
          </div>
          <SettingsFooter settings={settings} saving={saving} onSave={save} />
        </>
      ) : null}
    </Card>
  );
}

function SettingsFooter(props: { settings: { version: number; updatedAt: string }; saving: boolean; onSave: () => void }) {
  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-slate-500">Version {props.settings.version} - updated {formatDate(props.settings.updatedAt)}</p>
      <Button onClick={props.onSave} disabled={props.saving}>{props.saving ? 'Saving...' : 'Save and apply'}</Button>
    </div>
  );
}

function toSsoSettingsDraft(settings: SsoRuntimeSettingsDto): SsoSettingsDraft {
  return {
    maxSsoUsers: settings.maxSsoUsers === null ? '' : String(settings.maxSsoUsers),
    userPrefix: settings.userPrefix,
    emailDomain: settings.emailDomain,
    bulkSyncConcurrency: String(settings.bulkSyncConcurrency),
    scimRequestDelayMs: String(settings.scimRequestDelayMs),
    scimMaxRetries: String(settings.scimMaxRetries),
    scimRetryBaseDelayMs: String(settings.scimRetryBaseDelayMs),
  };
}

function toLoginSettingsDraft(settings: LoginRuntimeSettingsDto): LoginRuntimeSettingsValues {
  return {
    concurrency: settings.concurrency,
    authTimeoutMs: settings.authTimeoutMs,
    authDebugLogs: settings.authDebugLogs,
    authDebugArtifacts: settings.authDebugArtifacts,
  };
}

function ErrorDiagnosticsPage(props: { notify: Notify }) {
  const [result, setResult] = useState<ProxyErrorDiagnosticsListResponse>();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<ProxyErrorDiagnosticDetailDto>();
  const [detailLoading, setDetailLoading] = useState(false);

  const load = async (nextPage = page) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await listErrorDiagnostics({ page: nextPage, pageSize: 25 });
      setResult(next);
      setPage(next.page);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(page);
  }, [page]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      setDetail(await getErrorDiagnostic(id));
    } catch (err) {
      props.notify((err as Error).message, 'error');
      setSelectedId(undefined);
    } finally {
      setDetailLoading(false);
    }
  };

  const download = async (id: string) => {
    try {
      const downloadResult = await downloadErrorDiagnostic(id);
      const url = URL.createObjectURL(downloadResult.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadResult.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      props.notify((err as Error).message, 'error');
    }
  };

  const clear = async () => {
    if (!window.confirm('Clear all stored proxy error diagnostics? This cannot be undone.')) return;
    try {
      await clearErrorDiagnostics();
      setSelectedId(undefined);
      setDetail(undefined);
      props.notify('Proxy error diagnostics cleared.');
      await load(1);
    } catch (err) {
      props.notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mb-0">Copilot upstream failures</CardTitle>
            {result ? <Badge tone={result.enabled ? 'success' : 'warning'}>{result.enabled ? 'Collection enabled' : 'Collection disabled'}</Badge> : null}
            {result ? <Badge tone={result.redacted ? 'info' : 'warning'}>{result.redacted ? 'Sensitive data redacted' : 'Unredacted records'}</Badge> : null}
          </div>
          <p className="mt-2 text-sm text-slate-600">Human-readable logs include headers, formatted bodies, curl commands, and the actual request sent upstream.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void load(page)} disabled={loading}>Refresh</Button>
          <Button variant="danger" onClick={() => void clear()} disabled={!result?.enabled || result.total === 0}>Clear all</Button>
        </div>
      </Card>
      {loading ? <LoadingState label="Loading error diagnostics..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {result && !result.enabled ? <ErrorState message="Proxy error diagnostics collection is disabled by configuration." /> : null}
      {result?.enabled ? (
        <>
          <Card className="overflow-x-auto p-0">
            <Table>
              <thead><tr><Th>Time</Th><Th>Identity</Th><Th>Route / model</Th><Th>Failure</Th><Th>Status</Th><Th>Body sizes</Th><Th>Actions</Th></tr></thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <Td>{formatDate(item.timestamp)}</Td>
                    <Td><span className="break-all font-mono text-xs">{item.identity}</span></Td>
                    <Td><div>{item.path}</div><div className="text-xs text-slate-500">{item.model ?? '-'}</div></Td>
                    <Td><Badge tone={item.failureKind === 'http' ? 'warning' : 'danger'}>{item.failureKind}</Badge></Td>
                    <Td>{item.status ?? '-'}</Td>
                    <Td className="whitespace-nowrap text-xs">
                      in {formatBytes(item.inboundRequestBodyBytes)} / sent {formatBytes(item.upstreamRequestBodyBytes)} / received {formatBytes(item.upstreamResponseBodyBytes)}
                    </Td>
                    <Td>
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => void openDetail(item.id)}>Details</Button>
                        <Button variant="ghost" onClick={() => void download(item.id)}>Download</Button>
                      </div>
                    </Td>
                  </tr>
                ))}
                {result.items.length === 0 ? <EmptyRow colSpan={7} label="No Copilot upstream failures have been recorded." /> : null}
              </tbody>
            </Table>
          </Card>
          <Pagination page={result.page} total={result.total} pageSize={result.pageSize} onPage={setPage} />
        </>
      ) : null}
      <Dialog
        title="Proxy error diagnostic"
        description={selectedId}
        open={selectedId !== undefined}
        onClose={() => { setSelectedId(undefined); setDetail(undefined); }}
      >
        {detailLoading ? <LoadingState label="Loading complete diagnostic..." /> : null}
        {detail ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Info label="Failure" value={`${detail.failureKind}${detail.status ? ` / HTTP ${detail.status}` : ''}`} />
              <Info label="Recorded" value={formatDate(detail.timestamp)} />
              <Info label="Identity" value={<span className="break-all font-mono text-xs">{detail.identity}</span>} />
              <Info label="Route / model" value={`${detail.path} / ${detail.model ?? '-'}`} />
            </div>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-xs text-slate-100">
              {previewText(detail.content)}
            </pre>
            <div className="flex justify-end">
              <Button onClick={() => void download(detail.id)}>Download complete log</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

const DIAGNOSTIC_PREVIEW_CHARS = 20_000;

function previewText(value: string, alreadyTruncated = false): string {
  const truncated = alreadyTruncated || value.length > DIAGNOSTIC_PREVIEW_CHARS;
  return `${value.slice(0, DIAGNOSTIC_PREVIEW_CHARS)}${truncated ? '\n\n[Preview truncated; download the record for complete data.]' : ''}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function DiagnosticsPage() {
  const [results, setResults] = useState<{ name: string; ok: boolean; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const checks = [
    { name: 'Proxy accounts', path: '/api/console/proxy/accounts' },
    { name: 'SSO users', path: '/api/console/sso/users' },
    { name: 'Login tasks', path: '/api/console/login-service/tasks' },
    { name: 'Request stats', path: '/api/console/proxy/request-stats' },
  ];

  const run = async () => {
    setLoading(true);
    const next = await Promise.all(checks.map(async (check) => {
      try {
        await api(check.path);
        return { name: check.name, ok: true, message: 'OK' };
      } catch (err) {
        return { name: check.name, ok: false, message: (err as Error).message };
      }
    }));
    setResults(next);
    setLoading(false);
  };

  useEffect(() => {
    void run();
  }, []);

  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between">
        <div>
          <CardTitle className="mb-1">Service connectivity</CardTitle>
          <p className="text-sm text-slate-600">Confirms console proxy routes and internal service token alignment.</p>
        </div>
        <Button variant="secondary" onClick={run}>Run checks</Button>
      </Card>
      {loading ? <LoadingState label="Running diagnostics..." /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {results.map((result) => (
          <Card key={result.name}>
            <div className="flex items-center justify-between">
              <CardTitle className="mb-0">{result.name}</CardTitle>
              <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'OK' : 'Failed'}</Badge>
            </div>
            <p className={`mt-3 text-sm ${result.ok ? 'text-slate-600' : 'text-red-600'}`}>{result.message}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateUserDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [ssoUser, setSsoUser] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await createSsoUser({ ssoUser, password: password || undefined, email: email || undefined, role });
      setSsoUser('');
      setPassword('');
      setEmail('');
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Create SSO user" description="Password defaults to SSO user when left blank." open={props.open} onClose={props.onClose}>
      <FormGrid>
        <Label text="SSO user"><Input value={ssoUser} onChange={(event) => setSsoUser(event.target.value)} /></Label>
        <Label text="Password"><Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" /></Label>
        <Label text="Email"><Input value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create user" />
    </Dialog>
  );
}

function EditUserDialog(props: { user?: SsoUserDto; onClose: () => void; onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.user) return;
    setEmail(props.user.email);
    setRole(props.user.role);
    setPassword('');
    setError(undefined);
  }, [props.user]);

  const submit = async () => {
    if (!props.user) return;
    setSaving(true);
    setError(undefined);
    try {
      await patchSsoUser(props.user.ssoUser, { email, role, password: password || undefined });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Edit ${props.user?.ssoUser ?? ''}`} description="Leave password blank to keep the current password." open={Boolean(props.user)} onClose={props.onClose}>
      <FormGrid>
        <Label text="Email"><Input value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
        <Label text="New password"><Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Save changes" />
    </Dialog>
  );
}

function ImportUsersDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [csvText, setCsvText] = useState('ssoUser,password\n');
  const [result, setResult] = useState<ReactNode>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const importResult = await importSsoUsers(csvText);
      setResult(
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">Batch {importResult.batchId}: {importResult.summary.success} success, {importResult.summary.failed} failed</p>
          <ul className="mt-2 max-h-52 overflow-auto">
            {importResult.rows.map((row) => <li key={`${row.line}-${row.ssoUser}`}>Line {row.line}: {row.ssoUser || '-'} - {row.status} - {row.detail}</li>)}
          </ul>
        </div>,
      );
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Import SSO users" description="CSV format: ssoUser or ssoUser,password. Existing users get password updates." open={props.open} onClose={props.onClose}>
      <Textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} className="h-56 w-full font-mono" />
      {result}
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Import" />
    </Dialog>
  );
}

function ImportEmuUsersDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [ssoUser, setSsoUser] = useState('');
  const [plan, setPlan] = useState<ImportEmuPlanDto>();
  const [rows, setRows] = useState<ImportEmuUserRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowPage, setRowPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<ImportEmuUserStatus | ''>('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<'preview' | 'apply' | 'rows' | 'delete'>();

  const loadRows = async (planId: string, nextPage = rowPage, nextStatus = statusFilter) => {
    setSaving('rows');
    setError(undefined);
    try {
      const result = await listEmuImportPlanRows(planId, { page: nextPage, pageSize: EMU_IMPORT_ROW_PAGE_SIZE, status: nextStatus });
      setRows(result.items);
      setRowTotal(result.total);
      setRowPage(result.page);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  const preview = async () => {
    setSaving('preview');
    setError(undefined);
    try {
      const nextPlan = await createEmuImportPlan({ ssoUser: ssoUser.trim() || undefined });
      setPlan(nextPlan);
      setStatusFilter('');
      await loadRows(nextPlan.planId, 1, '');
    } catch (err) {
      setError((err as Error).message);
      setSaving(undefined);
    }
  };

  const applyPlan = async () => {
    if (!plan) return;
    setSaving('apply');
    setError(undefined);
    try {
      const nextPlan = await applyEmuImportPlan(plan.planId);
      setPlan(nextPlan);
      await loadRows(nextPlan.planId, rowPage, statusFilter);
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(undefined);
    }
  };

  const deletePlan = async () => {
    if (!plan) return;
    if (!window.confirm('Delete this GH import plan data? This only removes preview/apply rows and does not delete SSO users or GH logins.')) return;
    setSaving('delete');
    setError(undefined);
    try {
      await deleteEmuImportPlan(plan.planId);
      setPlan(undefined);
      setRows([]);
      setRowTotal(0);
      setRowPage(1);
      setStatusFilter('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  const resetSsoUser = (value: string) => {
    setSsoUser(value);
    setPlan(undefined);
    setRows([]);
    setRowTotal(0);
    setRowPage(1);
  };
  const changeStatusFilter = (value: ImportEmuUserStatus | '') => {
    setStatusFilter(value);
    if (plan) void loadRows(plan.planId, 1, value);
  };
  const actionable = (plan?.summary.actionable ?? 0) > 0;

  return (
    <Dialog
      title="Import SSO users from GH"
      description="Preview GitHub SCIM and Enterprise Copilot seat alignment, then apply safe local create/update rows. Leave SSO user blank to scan all users."
      open={props.open}
      onClose={props.onClose}
    >
      <Label text="SSO user">
        <Input value={ssoUser} onChange={(event) => resetSsoUser(event.target.value)} placeholder="Optional; blank imports all" />
      </Label>
      {plan ? (
        <EmuImportResult
          plan={plan}
          rows={rows}
          rowTotal={rowTotal}
          rowPage={rowPage}
          statusFilter={statusFilter}
          loadingRows={saving === 'rows'}
          onStatusFilter={changeStatusFilter}
          onPage={(nextPage) => loadRows(plan.planId, nextPage, statusFilter)}
        />
      ) : null}
      <footer className="mt-5 flex flex-col gap-3">
        {error ? <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          {plan ? (
            <Button variant="danger" onClick={deletePlan} disabled={Boolean(saving)}>
              {saving === 'delete' ? 'Deleting...' : 'Delete plan data'}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button variant="secondary" onClick={preview} disabled={Boolean(saving)}>
            {saving === 'preview' ? 'Previewing...' : 'Preview alignment'}
          </Button>
          <Button onClick={applyPlan} disabled={Boolean(saving) || !actionable}>
            {saving === 'apply' ? 'Applying...' : 'Apply safe changes'}
          </Button>
        </div>
      </footer>
    </Dialog>
  );
}

function EmuImportResult(props: {
  plan: ImportEmuPlanDto;
  rows: ImportEmuUserRow[];
  rowTotal: number;
  rowPage: number;
  statusFilter: ImportEmuUserStatus | '';
  loadingRows: boolean;
  onStatusFilter: (status: ImportEmuUserStatus | '') => void;
  onPage: (page: number) => void;
}) {
  const summary = props.plan.summary;
  return (
    <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
      <p className="font-medium">Plan {props.plan.planId}: {summary.actionable} actionable, {summary.skipped} skipped, {summary.conflict} conflict, {summary.failed} failed</p>
      <div className="mt-2 grid gap-2 text-xs md:grid-cols-4">
        <Info label="Pending create" value={formatNumber(summary.pendingCreate)} />
        <Info label="Pending update" value={formatNumber(summary.pendingUpdate)} />
        <Info label="Created/updated" value={`${formatNumber(summary.created)} / ${formatNumber(summary.updated)}`} />
        <Info label="Total rows" value={formatNumber(summary.total)} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={props.statusFilter} onChange={(event) => props.onStatusFilter(event.target.value as ImportEmuUserStatus | '')}>
          {EMU_IMPORT_ROW_STATUSES.map((status) => <option key={status || 'all'} value={status}>{status || 'all statuses'}</option>)}
        </select>
        <span className="text-xs text-slate-500">{props.loadingRows ? 'Loading rows...' : `${formatNumber(props.rowTotal)} row(s)`}</span>
      </div>
      <ul className="mt-2 max-h-52 overflow-auto">
        {props.rows.map((row, index) => (
          <li key={`${row.ghScimId ?? row.ssoUser}-${row.status}-${index}`} className={row.status === 'conflict' || row.status === 'failed' ? 'text-red-700' : ''}>
            #{row.rowIndex ?? '-'} {row.ssoUser || '-'} - {row.status} - {row.detail}
            {row.ghLogin ? ` GH login: ${row.ghLogin}` : ''}
            {row.copilotSeatStatus ? ` Copilot seat: ${row.copilotSeatStatus}` : ''}
          </li>
        ))}
        {props.rows.length === 0 ? <li className="text-slate-500">No rows match this filter.</li> : null}
      </ul>
      <Pagination page={props.rowPage} total={props.rowTotal} pageSize={EMU_IMPORT_ROW_PAGE_SIZE} onPage={props.onPage} />
    </div>
  );
}

function BatchCreateDialog(props: { open: boolean; remaining: number | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [prefix, setPrefix] = useState('user');
  const [start, setStart] = useState(1);
  const [count, setCount] = useState(5);
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [syncAfterCreate, setSyncAfterCreate] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const preview = Array.from({ length: Math.max(0, Math.min(count, 20)) }, (_, index) => `${prefix}${start + index}`);

  const submit = async () => {
    if (props.remaining !== null && count > props.remaining) {
      setError(`Only ${props.remaining} SSO user slot(s) remain.`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const createdSsoUsers: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const ssoUser = `${prefix}${start + index}`;
        await createSsoUser({ ssoUser, role });
        createdSsoUsers.push(ssoUser);
      }
      if (syncAfterCreate && createdSsoUsers.length > 0) await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: createdSsoUsers });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Batch create SSO users" description="Generate a predictable set of local SSO accounts." open={props.open} onClose={props.onClose}>
      <FormGrid>
        <Label text="Prefix"><Input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></Label>
        <Label text="Start index"><Input type="number" value={start} onChange={(event) => setStart(Number(event.target.value))} /></Label>
        <Label text="Count"><Input type="number" min={1} max={props.remaining === null ? 500 : Math.min(500, props.remaining)} value={count} onChange={(event) => setCount(Number(event.target.value))} /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={syncAfterCreate} onChange={(event) => setSyncAfterCreate(event.target.checked)} />
        Sync each user to GH login after creation
      </label>
      <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        <p className="font-medium">Preview</p>
        <p className="mt-1">{preview.join(', ')}{count > preview.length ? ` ... +${count - preview.length} more` : ''}</p>
        {props.remaining !== null ? <p className="mt-2">{props.remaining} SSO user slot(s) remaining.</p> : null}
      </div>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create users" />
    </Dialog>
  );
}

function CopilotOauthReauthorizationDialog(props: { account?: ProxyAccountDto; onClose: () => void; onDone: () => Promise<void> }) {
  const [ssoPassword, setSsoPassword] = useState('');
  const [ssoType, setSsoType] = useState<SsoType>('custom');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.account) {
      setSsoPassword('');
      setSsoType('custom');
      setError(undefined);
    }
  }, [props.account]);

  const submit = async () => {
    if (!props.account) return;
    setSaving(true);
    setError(undefined);
    try {
      await reauthorizeCopilotOauth(props.account.identity, { ssoPassword, ssoType });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Reauthorize Copilot OAuth${props.account ? ` for ${props.account.identity}` : ''}`} description="This creates an OpenCode OAuth Device Flow login task and requires the user's SSO password." open={Boolean(props.account)} onClose={props.onClose}>
      <FormGrid>
        <Label text="SSO password"><Input type="password" value={ssoPassword} onChange={(event) => setSsoPassword(event.target.value)} /></Label>
        <Label text="SSO type">
          <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={ssoType} onChange={(event) => setSsoType(event.target.value as SsoType)}>
            <option value="custom">Custom</option>
            <option value="azure">Azure</option>
          </select>
        </Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create reauthorization task" />
    </Dialog>
  );
}

function RetryTaskDialog(props: { task?: LoginTaskDto; onClose: () => void; onDone: () => Promise<void> }) {
  const [ssoPassword, setSsoPassword] = useState('');
  const [ssoType, setSsoType] = useState<SsoType>('custom');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (props.task) {
      setSsoPassword('');
      setSsoType(props.task.ssoType === 'azure' ? 'azure' : 'custom');
      setError(undefined);
    }
  }, [props.task]);

  const submit = async () => {
    if (!props.task) return;
    setSaving(true);
    setError(undefined);
    try {
      await retryLoginTask(props.task.id, { ssoPassword, ssoType });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Retry login task ${props.task?.id.slice(0, 8) ?? ''}`} description="Retry requires an SSO password because passwords are not stored." open={Boolean(props.task)} onClose={props.onClose}>
      <FormGrid>
        <Label text="SSO password"><Input type="password" value={ssoPassword} onChange={(event) => setSsoPassword(event.target.value)} /></Label>
        <Label text="SSO type">
          <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={ssoType} onChange={(event) => setSsoType(event.target.value as SsoType)}>
            <option value="custom">Custom</option>
            <option value="azure">Azure</option>
          </select>
        </Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Retry task" />
    </Dialog>
  );
}

function ProxyAccountDetailDialog(props: { account?: ProxyAccountDto; onClose: () => void }) {
  const [stats, setStats] = useState<ProxyRequestStatDto[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!props.account) return;
    setStats([]);
    setError(undefined);
    void listRequestStats({ identity: props.account.identity, limit: 20 })
      .then(setStats)
      .catch((err: Error) => setError(err.message));
  }, [props.account]);

  return (
    <Dialog title={`Account ${props.account?.identity ?? ''}`} description="Identity mapping, token status, and recent request stats." open={Boolean(props.account)} onClose={props.onClose}>
      {props.account ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Info label="Header identity" value={props.account.identity} />
            <Info label="SSO user" value={props.account.ssoUser} />
            <Info label="GH login" value={props.account.ghLogin ?? '-'} />
            <Info label="Copilot OAuth" value={props.account.copilotOauthStatus} />
            <Info label="OAuth updated" value={formatDate(props.account.copilotOauthUpdatedAt)} />
          </div>
          {error ? <ErrorState message={error} /> : null}
          <div className="max-h-96 overflow-auto rounded border border-slate-200">
            <RequestStatsTable stats={stats} compact />
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function LoginTasksTable(props: {
  tasks: LoginTaskDto[];
  compact?: boolean;
  selected?: Set<string>;
  allSelected?: boolean;
  onSelect?: (id: string, checked: boolean) => void;
  onSelectAll?: (checked: boolean) => void;
}) {
  return (
    <Table compact={props.compact}>
      <thead>
        <tr>
          {!props.compact ? <Th><input type="checkbox" checked={Boolean(props.allSelected)} onChange={(event) => props.onSelectAll?.(event.target.checked)} aria-label="Select all login tasks" /></Th> : null}
          {!props.compact ? <Th>Task ID</Th> : null}
          <Th>Identity</Th>
          <Th>SSO user</Th>
          {!props.compact ? <Th>GH login</Th> : null}
          <Th>Status</Th>
          {!props.compact ? <Th>Attempts</Th> : null}
          <Th>Failure</Th>
          {!props.compact ? <Th>Created</Th> : null}
        </tr>
      </thead>
      <tbody>
        {props.tasks.map((task) => (
          <tr key={task.id}>
            {!props.compact ? <Td><input type="checkbox" checked={props.selected?.has(task.id) ?? false} onChange={(event) => props.onSelect?.(task.id, event.target.checked)} aria-label={`Select login task ${task.id}`} /></Td> : null}
            {!props.compact ? <Td className="font-mono text-xs">{task.id}</Td> : null}
            <Td>{task.identity}</Td>
            <Td>{task.ssoUser}</Td>
            {!props.compact ? <Td>{task.ghLogin ?? '-'}</Td> : null}
            <Td><Badge tone={statusTone(task.status)}>{task.status}</Badge></Td>
            {!props.compact ? <Td>{task.attempts}</Td> : null}
            <Td className="max-w-xs truncate" title={task.failureReason}>{task.failureReason ?? '-'}</Td>
            {!props.compact ? <Td>{formatDate(task.createdAt)}</Td> : null}
          </tr>
        ))}
        {props.tasks.length === 0 ? <EmptyRow colSpan={props.compact ? 4 : 9} label="No login tasks found." /> : null}
      </tbody>
    </Table>
  );
}

function RequestStatsTable(props: { stats: ProxyRequestStatDto[]; compact?: boolean }) {
  return (
    <Table compact={props.compact}>
      <thead>
        <tr>
          {!props.compact ? <Th>Requested</Th> : null}
          <Th>Identity</Th>
          {!props.compact ? <Th>GH login</Th> : null}
          <Th>Path</Th>
          <Th>Model</Th>
          <Th>Outcome</Th>
          {!props.compact ? <Th>Input</Th> : null}
          {!props.compact ? <Th>Output</Th> : null}
          {!props.compact ? <Th>Cache input</Th> : null}
          {!props.compact ? <Th>Cache write</Th> : null}
          {!props.compact ? <Th>Cache total</Th> : null}
          <Th>Total</Th>
          <Th>Failure</Th>
        </tr>
      </thead>
      <tbody>
        {props.stats.map((stat) => {
          const cache = statCacheTokens(stat);
          const total = tokenTotal(stat.inputTokens, stat.outputTokens, cache);
          return (
            <tr key={stat.id}>
              {!props.compact ? <Td>{formatDate(stat.requestedAt)}</Td> : null}
              <Td>{stat.identity}</Td>
              {!props.compact ? <Td>{stat.ghLogin ?? '-'}</Td> : null}
              <Td>{stat.path}</Td>
              <Td>{stat.model ?? '-'}</Td>
              <Td><Badge tone={stat.success ? 'success' : 'danger'}>{stat.success ? 'success' : 'failed'}</Badge></Td>
              {!props.compact ? <Td>{formatNumber(stat.inputTokens)}</Td> : null}
              {!props.compact ? <Td>{formatNumber(stat.outputTokens)}</Td> : null}
              {!props.compact ? <Td>{formatNumber(stat.cacheInputTokens)}</Td> : null}
              {!props.compact ? <Td>{formatNumber(stat.cacheWriteTokens)}</Td> : null}
              {!props.compact ? <Td>{formatNumber(cache)}</Td> : null}
              <Td>{formatNumber(total)}</Td>
              <Td className="max-w-xs truncate" title={stat.failureReason}>{stat.failureReason ?? '-'}</Td>
            </tr>
          );
        })}
        {props.stats.length === 0 ? <EmptyRow colSpan={props.compact ? 6 : 13} label="No request stats found." /> : null}
      </tbody>
    </Table>
  );
}

function statCacheTokens(stat: ProxyRequestStatDto): number | undefined {
  return stat.cacheTokens ?? tokenTotal(stat.cacheInputTokens, stat.cacheWriteTokens);
}

function periodLabel(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}

function formatAiUnits(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function MetricCard(props: { title: string; value: string | number; detail: string; error?: string }) {
  return (
    <Card>
      <p className="text-sm font-medium text-slate-600">{props.title}</p>
      <p className="mt-2 text-3xl font-bold text-slate-950">{props.error ? '-' : props.value}</p>
      <p className={`mt-2 text-sm ${props.error ? 'text-red-600' : 'text-slate-600'}`}>{props.error ?? props.detail}</p>
    </Card>
  );
}

function StatusWithDate(props: { status: string; date?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={statusTone(props.status)}>{props.status}</Badge>
      {props.date ? <span className="text-xs text-slate-500">{props.date.startsWith('expires ') ? props.date : formatDate(props.date)}</span> : null}
    </div>
  );
}

function DialogActions(props: { error?: string; saving: boolean; submitLabel: string; onCancel: () => void; onSubmit: () => void | Promise<void> }) {
  return (
    <footer className="mt-5 flex flex-col gap-3">
      {props.error ? <p className="rounded bg-red-50 p-3 text-sm text-red-700">{props.error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
        <Button onClick={props.onSubmit} disabled={props.saving}>{props.saving ? 'Working...' : props.submitLabel}</Button>
      </div>
    </footer>
  );
}

function RoleSelect(props: { value: 'user' | 'admin'; onChange: (role: 'user' | 'admin') => void }) {
  return (
    <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={props.value} onChange={(event) => props.onChange(event.target.value as 'user' | 'admin')}>
      <option value="user">User</option>
      <option value="admin">Admin</option>
    </select>
  );
}

function FormGrid(props: { children: ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2">{props.children}</div>;
}

function Label(props: { text: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-sm font-medium text-slate-700"><span>{props.text}</span>{props.children}</label>;
}

function Info(props: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{props.label}</p>
      <p className="mt-1 text-sm text-slate-950">{props.value}</p>
    </div>
  );
}

function Table(props: { children: ReactNode; compact?: boolean }) {
  return <table className={`w-full border-collapse text-left text-sm ${props.compact ? 'table-fixed' : 'min-w-[1000px]'}`}>{props.children}</table>;
}

function Th(props: { children: ReactNode }) {
  return <th className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{props.children}</th>;
}

function Td(props: { children: ReactNode; className?: string; title?: string }) {
  return <td title={props.title} className={`border-b border-slate-100 px-3 py-2 align-top text-slate-700 ${props.className ?? ''}`}>{props.children}</td>;
}

function EmptyRow(props: { colSpan: number; label: string }) {
  return <tr><td colSpan={props.colSpan} className="px-3 py-8 text-center text-sm text-slate-500">{props.label}</td></tr>;
}

function LoadingState(props: { label: string }) {
  return <p className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-blue-700">{props.label}</p>;
}

function ErrorState(props: { message: string }) {
  return <p className="rounded-md border border-red-100 bg-red-50 p-3 text-sm text-red-700">{props.message}</p>;
}

function Pagination(props: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-3 text-sm">
      <span>Page {props.page} of {totalPages}, {props.total} total</span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</Button>
        <Button variant="secondary" disabled={props.page >= totalPages} onClick={() => props.onPage(props.page + 1)}>Next</Button>
      </div>
    </div>
  );
}

function countBy<T extends object>(items: T[], key: keyof T): string {
  if (items.length === 0) return 'No records';
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String(item[key] ?? 'unknown');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => `${value}: ${count}`).join(' / ');
}

function readPageFromHash(): Page {
  const raw = window.location.hash.replace(/^#/, '');
  return pages.some((entry) => entry.id === raw) ? raw as Page : 'dashboard';
}
