import { useEffect, useRef, useState } from 'react';
import type { LoginAttemptDto, LoginQueueDto, LoginTaskDto, ManagementSummary } from '@ghcp/shared';
import { api, ConsoleApiError } from '../api/client.js';
import { Badge } from './ui/badge.js';
import { Button, ButtonLink } from './ui/button.js';
import { Card } from './ui/card.js';
import { Dialog } from './ui/dialog.js';
import { formatDate, statusTone } from '../lib/format.js';

export function QueueOverview({ refreshKey = 0, onLoadingChange }: { refreshKey?: number; onLoadingChange?: (loading: boolean) => void }) {
  const [queue, setQueue] = useState<LoginQueueDto>();
  const [summary, setSummary] = useState<ManagementSummary>();
  const [queueError, setQueueError] = useState<string>();
  const [summaryError, setSummaryError] = useState<string>();
  const [queueFetchedAt, setQueueFetchedAt] = useState<string>();
  const [summaryFetchedAt, setSummaryFetchedAt] = useState<string>();
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const loadingChanged = useRef(onLoadingChange);
  loadingChanged.current = onLoadingChange;
  useEffect(() => {
    const controller = new AbortController();
    const current = ++sequence.current;
    const isCurrent = () => !controller.signal.aborted && sequence.current === current;
    setLoading(true);
    loadingChanged.current?.(true);
    const loadQueue = async () => {
      try {
        const next = await api<LoginQueueDto>('/api/console/login-service/queue', { signal: controller.signal });
        if (isCurrent()) { setQueue(next); setQueueFetchedAt(new Date().toISOString()); setQueueError(undefined); }
      } catch (err) { if (isCurrent()) setQueueError(message(err)); }
    };
    const loadSummary = async () => {
      try {
        const next = await api<ManagementSummary>('/api/console/login-service/tasks/summary', { signal: controller.signal });
        if (isCurrent()) { setSummary(next); setSummaryFetchedAt(new Date().toISOString()); setSummaryError(undefined); }
      } catch (err) { if (isCurrent()) setSummaryError(message(err)); }
    };
    void Promise.all([loadQueue(), loadSummary()]).then(() => {
      if (isCurrent()) { setLoading(false); loadingChanged.current?.(false); }
    });
    return () => { controller.abort(); loadingChanged.current?.(false); };
  }, [refreshKey]);
  return <Card className="space-y-3" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Login queue</h3><ButtonLink variant="secondary" size="sm" href="#settings">Concurrency settings</ButtonLink></div>
    <p className="text-xs text-slate-500">Snapshot only, including wait and run times. Use the task list Refresh to update the list, queue and task summary.{loading ? ' Refreshing queue and summary…' : ''}</p>
    {queueError ? <p role="alert" className="text-sm text-red-700">Queue: {queueError} {queue ? 'Previous queue data may be stale.' : 'Queue data is unavailable.'}</p> : null}
    {queue ? <div className="flex flex-wrap gap-4 text-sm">
      <span><strong>{queue.preparing?.length ?? 0}</strong> preparing</span>
      <span><strong>{queue.pending.length}</strong> waiting</span>
      <span><strong>{queue.active.length} / {queue.concurrency}</strong> execution slots</span>
      <span><strong>{queue.cancelling.length}</strong> cancelling</span>
      <span>Longest wait: {Math.round((queue.longestWaitMs ?? 0) / 1000)}s</span>
      <span className="text-slate-500">Queue fetched {formatDate(queueFetchedAt)}</span>
    </div> : !queueError ? <p className="text-sm text-slate-500">Loading queue…</p> : null}
    {queue?.active.length ? <p className="break-all text-xs">Running: {queue.active.map((id) => <span key={id} className="mr-3">{id}</span>)}</p> : null}
    {queue?.items?.length ? <details><summary className="cursor-pointer text-sm">Queue details (first {Math.min(queue.items.length, 100)} of {queue.items.length}; browse all in the task list)</summary><div className="max-h-48 space-y-2 overflow-auto pt-2">{queue.items.slice(0, 100).map((item) => <p key={item.taskId} className="text-xs">
      {item.identity}
      {' / '}{item.position ? `Position ${item.position}` : item.status}{' / '}{item.stage ?? 'Unknown stage'}
      {' / '}wait {Math.round(item.waitMs / 1000)}s{item.runMs === undefined ? '' : ` / running ${Math.round(item.runMs / 1000)}s`}
      {' / '}stage updated {formatDate(item.stageUpdatedAt)}
    </p>)}</div></details> : null}
    {summaryError ? <p role="alert" className="text-sm text-red-700">Task summary: {summaryError} {summary ? 'Previous summary data may be stale.' : 'Task summary is unavailable.'}</p> : null}
    {summary ? <p className="text-xs text-slate-600">All retained tasks: {summary.total}. {Object.entries(summary.counts).map(([status, count]) => `${status}: ${count}`).join(' / ')}. These are historical task counts, not queue completion percentages. Summary fetched {formatDate(summaryFetchedAt)}.</p> : !summaryError ? <p className="text-xs text-slate-500">Loading task summary…</p> : null}
  </Card>;
}

export function LoginTaskDetails({ task, onClose }: { task?: LoginTaskDto; onClose: () => void }) {
  return task ? <TaskDetailsSnapshot key={task.id} task={task} onClose={onClose} /> : null;
}

function TaskDetailsSnapshot({ task, onClose }: { task: LoginTaskDto; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState(task);
  const [attempts, setAttempts] = useState<LoginAttemptDto[]>([]);
  const [taskError, setTaskError] = useState<string>();
  const [attemptsError, setAttemptsError] = useState<string>();
  const [taskFetchedAt, setTaskFetchedAt] = useState<string>();
  const [attemptsFetchedAt, setAttemptsFetchedAt] = useState<string>();
  const [removed, setRemoved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState<{ content: string; attemptNumber: number; fetchedAt: string }>();
  const [logError, setLogError] = useState<string>();
  const [logLoading, setLogLoading] = useState<string>();
  const active = useRef(true);
  const sequence = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const logRequest = useRef<AbortController | undefined>(undefined);
  const logPendingAttempt = useRef<string | undefined>(undefined);
  const logSequence = useRef(0);
  const refresh = async () => {
    if (!active.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setLoading(true);
    const path = `/api/console/login-service/tasks/${encodeURIComponent(task.id)}`;
    const [taskResult, attemptsResult] = await Promise.allSettled([
      api<LoginTaskDto>(path, { signal: controller.signal }).then((value) => ({ value, fetchedAt: new Date().toISOString() })),
      api<LoginAttemptDto[]>(`${path}/attempts`, { signal: controller.signal }).then((value) => ({ value, fetchedAt: new Date().toISOString() })),
    ]);
    if (!active.current || controller.signal.aborted || sequence.current !== current) return;
    request.current = undefined;
    setLoading(false);
    if ([taskResult, attemptsResult].some((result) => result.status === 'rejected' && isRemovedTask(result.reason))) {
      setRemoved(true);
      setTaskError('This task was removed or cleaned up. Its operation result is still retained.');
      setAttemptsError(undefined);
      setAttempts([]);
      logRequest.current?.abort();
      logRequest.current = undefined;
      logPendingAttempt.current = undefined;
      setLogLoading(undefined); setLog(undefined); setLogError(undefined);
      return;
    }
    if (taskResult.status === 'fulfilled' || attemptsResult.status === 'fulfilled') setRemoved(false);
    if (taskResult.status === 'fulfilled') {
      setSnapshot(taskResult.value.value); setTaskFetchedAt(taskResult.value.fetchedAt); setTaskError(undefined);
    } else { setTaskError(`Task details could not be refreshed. Displayed task data may be stale: ${message(taskResult.reason)}`); }
    if (attemptsResult.status === 'fulfilled') {
      setAttempts(attemptsResult.value.value); setAttemptsFetchedAt(attemptsResult.value.fetchedAt); setAttemptsError(undefined);
    } else { setAttemptsError(`Attempts could not be refreshed. Previously retrieved attempts may be stale: ${message(attemptsResult.reason)}`); }
  };
  const cancel = () => {
    active.current = false;
    sequence.current++;
    logSequence.current++;
    request.current?.abort(); request.current = undefined;
    logRequest.current?.abort(); logRequest.current = undefined;
    logPendingAttempt.current = undefined;
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    return cancel;
  }, [task.id]);
  const previewLog = async (attempt: LoginAttemptDto) => {
    if (!active.current || removed || logPendingAttempt.current === attempt.id) return;
    logRequest.current?.abort();
    const controller = new AbortController();
    logRequest.current = controller;
    logPendingAttempt.current = attempt.id;
    const current = ++logSequence.current;
    setLogLoading(attempt.id); setLogError(undefined);
    try {
      const result = await api<{ content: string; truncated: boolean }>(`/api/console/login-service/tasks/${encodeURIComponent(task.id)}/attempts/${encodeURIComponent(attempt.id)}/log`, { signal: controller.signal });
      if (active.current && !controller.signal.aborted && logSequence.current === current) setLog({
        content: result.content + (result.truncated ? '\n\n[Preview truncated at 20 KB. Download the complete log.]' : ''),
        attemptNumber: attempt.attemptNumber,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (active.current && !controller.signal.aborted && logSequence.current === current) setLogError(`Log preview could not be read. Any previous preview may be stale: ${message(err)}`);
    } finally {
      if (active.current && !controller.signal.aborted && logSequence.current === current) { logRequest.current = undefined; logPendingAttempt.current = undefined; setLogLoading(undefined); }
    }
  };
  return <Dialog open onClose={() => { cancel(); onClose(); }} title="Login task details" description={task.id}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span>{removed ? 'Record removed. Last known status:' : taskFetchedAt ? 'Retrieved status:' : 'List snapshot status:'}</span><Badge tone={statusTone(snapshot.status)}>{snapshot.status}</Badge>{snapshot.stage ? <span>{snapshot.stage}</span> : null}</div>
        <Button variant="secondary" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing details…' : 'Refresh details'}</Button>
      </div>
      <p className="text-xs text-slate-500">Snapshot only. Refresh details to retrieve the latest task and attempts. Logs update only when you choose Preview log.</p>
      {taskFetchedAt ? <p className="text-xs text-slate-500">Task fetched {formatDate(taskFetchedAt)}</p> : null}
      {snapshot.failureReason ? <p className="whitespace-pre-wrap break-words text-sm">{snapshot.failureReason}</p> : null}
      <div className="flex flex-wrap gap-3 break-all text-sm">
        <span>Proxy: {snapshot.identity}</span>
        <span>SSO: {snapshot.ssoUser}</span>
      </div>
      {taskError ? <p role="alert" className="text-sm text-red-700">{taskError}</p> : null}
      {attemptsError ? <p role="alert" className="text-sm text-red-700">{attemptsError}</p> : null}
      {logError ? <p role="alert" className="text-sm text-red-700">{logError}</p> : null}
      {attemptsFetchedAt && !removed ? <p className="text-xs text-slate-500">Attempts fetched {formatDate(attemptsFetchedAt)}</p> : null}
      {!attempts.length && !removed ? <p className="text-sm text-slate-500">{loading ? 'Loading attempts…' : attemptsError ? 'Attempt information is unavailable.' : 'No attempts recorded.'}</p> : null}
      <div aria-busy={loading} className="max-h-[45vh] space-y-3 overflow-auto">{attempts.map((attempt) => <div key={attempt.id} className="space-y-2 rounded border border-slate-200 p-3 text-sm">
        <div className="flex flex-wrap gap-2"><strong>Attempt {attempt.attemptNumber}</strong><Badge tone={statusTone(attempt.status)}>{attempt.status}</Badge><span>{attempt.stage}</span></div>
        <p className="text-xs text-slate-500">Queued {formatDate(attempt.queuedAt)} / started {formatDate(attempt.startedAt)} / finished {formatDate(attempt.finishedAt)}</p>
        <p className="whitespace-pre-wrap break-words">{attempt.failureReason ?? 'No failure reported.'}</p>
        {attempt.failureCode ? <p className="text-xs">Reason code: {attempt.failureCode}</p> : null}
        {attempt.status === 'failed' ? <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">{failureAdvice(attempt.failureCode)}</p> : null}
        {attempt.historyIncomplete ? <p className="text-xs text-amber-700">Legacy history is incomplete; the old account log may have been overwritten.</p> : <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={logLoading === attempt.id} onClick={() => void previewLog(attempt)}>{logLoading === attempt.id ? 'Reading log…' : 'Preview log'}</Button>
          <ButtonLink variant="secondary" target="_blank" rel="noreferrer" href={`/api/console/login-service/tasks/${encodeURIComponent(task.id)}/attempts/${encodeURIComponent(attempt.id)}/log?download=1`}>Download log</ButtonLink>
        </div>}
      </div>)}</div>
      {log ? <div className="space-y-2"><p className="text-xs text-slate-500">Attempt {log.attemptNumber} log fetched {formatDate(log.fetchedAt)}. This preview does not refresh automatically.</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-3 text-xs text-slate-100">{log.content}</pre></div> : null}
    </div>
  </Dialog>;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isRemovedTask(error: unknown): boolean {
  return error instanceof ConsoleApiError && (error.status === 404 || error.code === 'task_not_found');
}

function failureAdvice(code?: string): string {
  if (code?.includes('password') || code?.includes('credential')) return 'Provide a password override for this account before retrying. Retrying does not change the SSO password.';
  if (code?.includes('mapping') || code?.includes('conflict') || code === 'authorization_not_needed') return 'Review the current Proxy account and active login tasks before starting another authorization.';
  if (code === 'service_interrupted') return 'The service restarted. Confirm the current account status, then submit a new attempt if authorization is still needed.';
  if (code?.includes('timeout') || code?.includes('expired')) return 'Check service connectivity and authentication timeout settings. A retry starts a new authorization flow.';
  return 'Inspect the full failure and attempt log, resolve its cause, then retry only the affected account.';
}
