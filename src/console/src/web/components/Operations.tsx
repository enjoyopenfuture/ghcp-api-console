import { useEffect, useRef, useState } from 'react';
import type { ManagementOperation, ManagementSelection, SsoType } from '@ghcp/shared';
import { api, ConsoleApiError } from '../api/client.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { ConfirmDialog, Dialog } from './ui/dialog.js';
import { Input } from './ui/input.js';
import { Select } from './ui/select.js';
import { Badge } from './ui/badge.js';

type OperationChange = 'submitted' | 'refreshed' | 'recovered' | 'followed';
const FOLLOW_DURATION = 120_000;
const FOLLOW_READ_TIMEOUT = 15_000;
const savedOperations = new Map<string, { results: ManagementOperation[]; latestId?: string; unconfirmedId?: string }>();
let sessionGeneration = 0;

export function resetOperationState(): void {
  savedOperations.clear();
  sessionGeneration++;
}

export function useOperations(basePath: string | undefined, onChanged: (operation: ManagementOperation, change: OperationChange) => void, followSubmitted = false) {
  const [operation, setOperation] = useState<ManagementOperation>();
  const [results, setResults] = useState<ManagementOperation[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [visible, setVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [followNotice, setFollowNotice] = useState<string>();
  const active = useRef(true);
  const generation = useRef(sessionGeneration);
  const currentBasePath = useRef(basePath);
  currentBasePath.current = basePath;
  const currentOperation = useRef<ManagementOperation | undefined>(undefined);
  const operationRequest = useRef<AbortController | undefined>(undefined);
  const operationSequence = useRef(0);
  const mutationPending = useRef(false);
  const submissionUnconfirmed = useRef(false);
  const snapshots = useRef(new Map<string, ManagementOperation>());
  const following = useRef(new Map<string, { until: number; reads: number }>());
  const options = useRef<Record<string, unknown>>({});
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const returnFocus = useRef<HTMLElement | undefined>(undefined);
  const persist = () => {
    if (basePath && generation.current === sessionGeneration) savedOperations.set(basePath, {
      results: [...snapshots.current.values()],
      latestId: currentOperation.current?.id,
      unconfirmedId: submissionUnconfirmed.current ? currentOperation.current?.id : undefined,
    });
  };
  const remember = (next: ManagementOperation) => {
    snapshots.current.set(next.id, next);
    setResults([...snapshots.current.values()]);
    persist();
  };
  const reportRefreshed = (next: ManagementOperation, source: 'refreshed' | 'followed') => {
    const operations = [...snapshots.current.values()];
    const newerIds = new Set(operations.slice(operations.findIndex((item) => item.id === next.id) + 1)
      .flatMap((operation) => operation.items.map((item) => item.id)));
    changed.current({ ...next, items: next.items.filter((item) => !newerIds.has(item.id)) }, source);
  };
  const follow = (next: ManagementOperation) => {
    if (followSubmitted && next.status === 'running') {
      following.current.set(next.id, { until: Date.now() + FOLLOW_DURATION, reads: 0 });
    }
  };
  const cancelOperation = () => {
    operationSequence.current++;
    operationRequest.current?.abort();
    operationRequest.current = undefined;
    mutationPending.current = false;
  };
  useEffect(() => {
    active.current = true;
    following.current.clear();
    setFollowNotice(undefined);
    const saved = basePath ? savedOperations.get(basePath) : undefined;
    const previous = saved?.results.find((result) => result.id === (saved.unconfirmedId ?? saved.latestId));
    currentOperation.current = previous;
    options.current = previous?.options ?? {};
    snapshots.current = new Map(saved?.results.map((result) => [result.id, result]));
    submissionUnconfirmed.current = Boolean(saved?.unconfirmedId && previous);
    setOperation(previous);
    setResults([...snapshots.current.values()]);
    setVisible(false);
    setBusy(false); setRefreshing(false);
    setUnconfirmed(submissionUnconfirmed.current);
    setError(submissionUnconfirmed.current ? 'The previous submission is unconfirmed. Use Refresh to check it or retry the same submission before starting another action.' : undefined);
    return () => {
      active.current = false;
      following.current.clear();
      cancelOperation();
    };
  }, [basePath]);
  const rememberFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) returnFocus.current = active;
  };
  const refresh = async (source: 'refreshed' | 'followed' = 'refreshed') => {
    if (!basePath || !active.current || generation.current !== sessionGeneration || operationRequest.current) return;
    const targets = [...snapshots.current.values()].filter((item) => (item.status === 'running'
      || submissionUnconfirmed.current && item.id === currentOperation.current?.id)
      && (source !== 'followed' || following.current.has(item.id)));
    if (source === 'refreshed') setFollowNotice(undefined);
    if (!targets.length) return;
    const controller = new AbortController();
    const current = ++operationSequence.current;
    operationRequest.current = controller;
    setRefreshing(true);
    if (source === 'refreshed') setError(undefined);
    const ownsRequest = () => active.current && generation.current === sessionGeneration && operationSequence.current === current && currentBasePath.current === basePath;
    let timedOut = false;
    const timeout = source === 'followed' ? window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, Math.min(FOLLOW_READ_TIMEOUT, ...targets.map((target) => following.current.get(target.id)!.until - Date.now())))) : undefined;
    if (source === 'followed') {
      for (const target of targets) following.current.get(target.id)!.reads++;
    }
    try {
      const responses = await Promise.allSettled(targets.map((previous) => api<ManagementOperation>(
        `${basePath}/${encodeURIComponent(previous.id)}`, { signal: controller.signal },
      )));
      if (!ownsRequest()) return;
      if (timedOut) {
        for (const target of targets) following.current.delete(target.id);
        setError('Automatic status check timed out. The action may still be running. Use Refresh to check the outcome; nothing was resubmitted.');
        return;
      }
      if (controller.signal.aborted) return;
      const errors: string[] = [];
      responses.forEach((response, index) => {
        const previous = targets[index]!;
        if (response.status === 'rejected') {
          following.current.delete(previous.id);
          errors.push(message(response.reason));
          // Expired results cannot be queried again; preserve an explicit row-level warning.
          if (response.reason instanceof ConsoleApiError && response.reason.status === 404) {
            remember({
              ...previous, status: 'interrupted',
              items: previous.items.map((item) => ['pending', 'running'].includes(item.status)
                ? { ...item, status: 'interrupted', detail: 'The service no longer has this result. Check the record before starting another action.' } : item),
            });
            if (previous.id === currentOperation.current?.id) {
              submissionUnconfirmed.current = false; setUnconfirmed(false);
              currentOperation.current = undefined; setOperation(undefined);
              setVisible(false);
            }
          }
          return;
        }
        const next = response.value;
        if (next.status !== 'running') following.current.delete(next.id);
        const recovered = submissionUnconfirmed.current && next.id === currentOperation.current?.id;
        remember(next);
        if (next.id === currentOperation.current?.id) {
          currentOperation.current = next;
          setOperation(next);
        }
        if (recovered) {
          submissionUnconfirmed.current = false; setUnconfirmed(false);
          if (next.status === 'preview') {
            errors.push('The previous submission was not accepted. Retry the same submission or choose another action.');
          } else {
            setVisible(false);
            follow(next);
            changed.current(next, 'recovered');
          }
        } else if (operationResultsChanged(previous, next)) reportRefreshed(next, source);
      });
      if (errors.length) setError(`Some action results could not be confirmed; displayed statuses may be stale. ${errors.join(' ')} Use Refresh to check again.`);
      else if (source === 'refreshed') setError(undefined);
    } finally {
      window.clearTimeout(timeout);
      if (ownsRequest()) { persist(); operationRequest.current = undefined; setRefreshing(false); }
    }
  };
  const preview = async (action: string, selection: ManagementSelection, nextOptions: Record<string, unknown> = {}) => {
    if (!basePath || !active.current || operationRequest.current) return;
    if (submissionUnconfirmed.current) {
      setError('The previous submission is unconfirmed. Use Refresh to check it or retry the same submission before starting another action.');
      return;
    }
    rememberFocus();
    cancelOperation();
    const controller = new AbortController();
    const current = ++operationSequence.current;
    operationRequest.current = controller; mutationPending.current = true;
    setBusy(true); setBusyAction(action); setRefreshing(false); setError(undefined);
    const isCurrent = () => active.current && !controller.signal.aborted && operationSequence.current === current && currentBasePath.current === basePath;
    try {
      const next = await api<ManagementOperation>(`${basePath}/preview`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action, selection, options: nextOptions }) });
      if (!isCurrent()) return;
      options.current = next.options ?? nextOptions;
      currentOperation.current = next;
      const confirmation = needsCredentials(action) || isDangerous(action);
      setOperation(next); setVisible(confirmation);
      if (!next.items.some((item) => item.status === 'pending')) {
        remember(next);
        setVisible(false);
        setError(`No eligible targets. Nothing was submitted. ${next.items.slice(0, 3).map((item) => `${item.label ?? item.id}: ${item.detail ?? item.status}`).join(' ')}`);
      } else if (!needsCredentials(action) && !isDangerous(action)) {
        operationRequest.current = undefined;
        mutationPending.current = false;
        await execute({}, '');
      }
    } catch (err) { if (isCurrent()) setError(`Operation preview failed: ${message(err)}`); }
    finally {
      if (isCurrent()) { operationRequest.current = undefined; mutationPending.current = false; setBusy(false); }
    }
  };
  /** Resolves true only when the batch was accepted, so the caller can keep typed passwords on failure. */
  const execute = async (overrides: Record<string, string>, ssoType: string): Promise<boolean> => {
    const previous = currentOperation.current;
    if (!previous || !basePath || !active.current || operationRequest.current) return false;
    const controller = new AbortController();
    const current = ++operationSequence.current;
    operationRequest.current = controller; mutationPending.current = true;
    setBusy(true); setBusyAction(previous.action); setError(undefined);
    submissionUnconfirmed.current = true; setUnconfirmed(true);
    remember(previous);
    const isCurrent = () => active.current && !controller.signal.aborted && operationSequence.current === current
      && currentBasePath.current === basePath && currentOperation.current?.id === previous.id;
    try {
      const next = await api<ManagementOperation>(`${basePath}/${encodeURIComponent(previous.id)}/execute`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          ...options.current, ...(ssoType ? { ssoType } : {}),
          overrides: Object.entries(overrides).map(([id, password]) => ({ id, password })),
        }),
      });
      if (!isCurrent()) return false;
      currentOperation.current = next;
      submissionUnconfirmed.current = false; setUnconfirmed(false);
      remember(next); setOperation(next);
      setVisible(false);
      follow(next);
      changed.current(next, 'submitted');
      return true;
    } catch (err) {
      if (isCurrent()) {
        const rejected = err instanceof ConsoleApiError && err.status >= 400 && err.status < 500 && err.status !== 408;
        if (rejected) { submissionUnconfirmed.current = false; setUnconfirmed(false); }
        setError(`Action submission ${rejected ? 'failed' : 'is unconfirmed'}: ${message(err)}${rejected ? '' : ' Use Refresh to check the outcome, or retry the same submission; do not create another batch.'}`);
        if (rejected && err.status === 404) {
          currentOperation.current = undefined; setOperation(undefined);
          setVisible(false);
          snapshots.current.delete(previous.id); setResults([...snapshots.current.values()]);
        }
      }
      return false;
    }
    finally {
      if (isCurrent()) { persist(); operationRequest.current = undefined; mutationPending.current = false; setBusy(false); }
    }
  };
  useEffect(() => {
    if (!followSubmitted || busy || refreshing || visible || unconfirmed || !following.current.size) return;
    const watches = [...following.current.values()];
    const delay = Math.max(0, Math.min(5000, ...watches.map((watch) => Math.min(1000 * 2 ** Math.min(watch.reads, 3), watch.until - Date.now()))));
    const timer = window.setTimeout(() => {
      if (!active.current || generation.current !== sessionGeneration) return;
      for (const [id, watch] of following.current) {
        if (watch.until > Date.now()) continue;
        following.current.delete(id);
        setFollowNotice('Automatic tracking stopped after two minutes. The action may still be running. Use Refresh to check the outcome; nothing was resubmitted.');
      }
      if (following.current.size) void refresh('followed');
    }, delay);
    return () => window.clearTimeout(timer);
  }, [followSubmitted, results, busy, refreshing, visible, unconfirmed]);
  return {
    basePath, operation, results, error, followNotice, busy, busyAction, visible, unconfirmed, preview, execute, refresh, refreshing, returnFocus: returnFocus.current,
    retrySubmission: () => {
      if (!currentOperation.current || operationRequest.current) return;
      if (needsCredentials(currentOperation.current.action) || isDangerous(currentOperation.current.action)) {
        rememberFocus();
        setVisible(true);
      } else void execute({}, '');
    },
    close: () => {
      if (mutationPending.current) return;
      cancelOperation();
      if (!submissionUnconfirmed.current) {
        currentOperation.current = undefined; setOperation(undefined);
        options.current = {}; setError(undefined);
      }
      persist();
      setVisible(false); setBusy(false); setRefreshing(false);
    },
  };
}

export function OperationConfirmation({ controller }: { controller: ReturnType<typeof useOperations> }) {
  const { operation, error, busy } = controller;
  const [page, setPage] = useState(1);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [ssoType, setSsoType] = useState<SsoType>('custom');
  useEffect(() => { setPage(1); setOverrides({}); setSsoType(operation?.options?.ssoType ?? 'custom'); }, [operation?.id, controller.visible]);
  const rows = operation?.items ?? [];
  const counts = rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});
  const pending = counts.pending ?? 0;
  const preview = operation?.status === 'preview';
  const credentials = needsCredentials(operation?.action ?? '');
  const dangerous = isDangerous(operation?.action ?? '');
  const missingOverride = Object.values(overrides).some((value) => !value) || credentials && rows.some((row) =>
    row.status === 'pending' && (row.requiresPasswordOverride || operation?.action === 'reauthorize' && ssoType === 'azure') && !overrides[row.id]);
  const confirming = preview && pending > 0 && (credentials || dangerous);
  const items = <div className="max-h-[45vh] overflow-auto">
    {rows.slice((page - 1) * 25, page * 25).map((row) => <div key={row.id} className="space-y-1 border-b border-slate-200 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono">{row.label ?? row.id}</span><Badge>{row.status}</Badge></div>
      {row.label && row.label !== row.id ? <p className="break-all text-xs text-slate-500">{row.id}</p> : null}
      {row.detail ? <p className="whitespace-pre-wrap break-words text-slate-600">{row.detail}</p> : null}
      {row.relatedTaskId ? <p className="break-all text-xs text-slate-600">Login task: {row.relatedTaskId}</p> : null}
      {preview && credentials && row.status === 'pending' ? <div>
        <label className="flex min-h-8 items-center gap-2"><Checkbox checked={row.id in overrides} onChange={(event) => setOverrides((current) => {
          const next = { ...current };
          if (event.target.checked) next[row.id] = ''; else delete next[row.id];
          return next;
        })} />{row.id in overrides ? 'Override password for this account' : row.requiresPasswordOverride ? 'Password override required (Azure)' : 'Using default password'}</label>
        {row.id in overrides ? <Input type="password" autoComplete="new-password" aria-label={`Password override for ${row.id}`} value={overrides[row.id]} onChange={(event) => setOverrides((current) => ({ ...current, [row.id]: event.target.value }))} /> : null}
      </div> : null}
    </div>)}
    {rows.length > 25 ? <div className="mt-2 flex items-center gap-3"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span>{page} / {Math.ceil(rows.length / 25)}</span><Button variant="secondary" disabled={page * 25 >= rows.length} onClick={() => setPage(page + 1)}>Next</Button></div> : null}
  </div>;
  return <>
    <ConfirmDialog open={Boolean(controller.visible && confirming && dangerous)} onClose={controller.close} returnFocusTo={controller.returnFocus}
      title={`Confirm: ${operation?.action ?? ''}`}
      description={`${pending} eligible target(s) out of ${rows.length} frozen target(s). ${destructiveWarning(operation)}`}
      confirmLabel={`Confirm ${pending} item(s)`} busy={busy || controller.refreshing} error={error} danger
      onConfirm={async () => { await controller.execute({}, ''); }} />
    <Dialog open={Boolean(controller.visible && confirming && credentials)} onClose={controller.close} closeDisabled={busy} returnFocusTo={controller.returnFocus} title={`Confirm: ${operation?.action ?? ''}`}
      description={`${rows.length} frozen target(s). New matching records are not added to this batch.`}>
      <div className="space-y-3">
        <p className="text-sm">{Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(' / ')}</p>
        <div className="rounded bg-blue-50 p-3 text-sm text-blue-900">
          Using default passwords resolved by SSO. Passwords are not stored. Override only the accounts that need a different password; Azure accounts require overrides.
          {operation?.action === 'reauthorize' ? <label className="mt-2 flex flex-wrap items-center gap-2">SSO provider <Select value={ssoType} onChange={(event) => setSsoType(event.target.value as SsoType)}>
            <option value="custom">Custom</option>
            <option value="azure">Azure</option>
          </Select></label> : null}
        </div>
        {items}
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy || controller.refreshing} onClick={controller.close}>Close</Button>
          <Button disabled={busy || controller.refreshing || !pending || missingOverride} onClick={() => {
            // Keep the typed passwords until the submission is accepted: clearing them up front
            // means a network failure forces the operator to retype every Azure override.
            void controller.execute(overrides, ssoType).then((submitted) => { if (submitted) setOverrides({}); });
          }}>{busy ? 'Submitting...' : `Confirm ${pending} item(s)`}</Button>
        </div>
      </div>
    </Dialog>
  </>;
}

function needsCredentials(action: string): boolean { return action === 'retry' || action === 'reauthorize'; }
function isDangerous(action: string): boolean { return action.includes('delete') || action === 'remove_copilot' || action === 'suspend_emu'; }

function destructiveWarning(operation: ManagementOperation | undefined): string {
  if (operation?.scope === 'tasks') return 'Deletes terminal task records, attempt history, and isolated logs. Existing Proxy authorizations and shared legacy logs are kept.';
  if (operation?.scope === 'accounts') return 'Permanently deletes the selected Proxy accounts and their retained request statistics. SSO and GitHub users are unchanged.';
  if (operation?.action === 'delete_sso') return 'Removes Copilot seats, deletes provisioned GitHub users and associated Proxy accounts/request statistics, then deletes local SSO users. Deleted data cannot be recovered here.';
  if (operation?.action === 'delete_emu') return 'Removes Copilot seats and deletes provisioned GitHub users. Local SSO users and Proxy records remain; their authorization may no longer work.';
  if (operation?.action === 'suspend_emu') return 'Suspends the selected GitHub users and interrupts their GitHub access. Local SSO users and Proxy records remain.';
  return 'Removes Copilot seats for the selected users. SSO, GitHub and Proxy records remain. Seat removal can interrupt Copilot access.';
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function operationResultsChanged(previous: ManagementOperation, next: ManagementOperation): boolean {
  if (previous.status !== next.status || previous.items.length !== next.items.length) return true;
  const statuses = new Map(previous.items.map((item) => [item.id, item.status]));
  return next.items.some((item) => statuses.get(item.id) !== item.status);
}
