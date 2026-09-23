import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ManagementQuery, OperationItem, PageResponse } from '@ghcp/shared';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Download, Filter, MoreHorizontal, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { api, downloadApi } from '../api/client.js';
import { filterKey, listQueryString, matchesSelection, readListQuery, selectionForQuery } from '../lib/management.js';
import { Button, ButtonLink } from './ui/button.js';
import { Input } from './ui/input.js';
import { Notification } from './ui/notification.js';
import { Checkbox } from './ui/checkbox.js';
import { Dropdown } from './ui/dropdown.js';
import { Select } from './ui/select.js';
import { Table, Th, Td } from './ui/table.js';
import { Tooltip } from './ui/tooltip.js';
import { OperationConfirmation, resetOperationState, useOperations } from './Operations.js';

export interface ManagementColumn<T> {
  key: string;
  label: string;
  render(item: T): ReactNode;
  sort?: string;
  align?: 'left' | 'right';
  nowrap?: boolean;
  defaultHidden?: boolean;
}

export interface ManagementFilter {
  key: Exclude<keyof ManagementQuery, 'ids'>;
  label: string;
  options?: string[];
  type?: 'text' | 'datetime-local' | 'number';
  multiple?: boolean;
}

const scrollPositions = new Map<string, number>();
const selections = new Map<string, { key: string; ids: Set<string>; all: boolean }>();

/**
 * Drops the cross-mount list state. These maps live at module scope so navigating between tabs keeps
 * a selection alive; without an explicit reset the next operator to sign in on the same tab would
 * inherit the previous one's selected identities. Called from the app on logout and session expiry.
 */
export function resetManagedListState(): void {
  scrollPositions.clear();
  selections.clear();
  resetOperationState();
}

interface Props<T, R extends PageResponse<T>> {
  scope: string;
  path: string;
  identify(item: T): string;
  columns: ManagementColumn<T>[];
  filters?: ManagementFilter[];
  actions?: { id: string; label: string; rowLabel?: string; canRun?(item: T): boolean; danger?: boolean; options?: Record<string, unknown> }[];
  toolbar?: ReactNode;
  selectionOptions?: ReactNode;
  followSubmittedActions?: boolean;
  refreshKey?: number;
  refreshDisabled?: boolean;
  onRefresh?(): void;
  onMutation?(): void;
  onNotify?(message: string, tone?: 'success' | 'warning' | 'error'): void;
  onRowDetails?(item: T): void;
  onResult?(result: R): void;
}

export function ManagedList<T, R extends PageResponse<T> = PageResponse<T>>(props: Props<T, R>) {
  const preference = (name: string) => `console.${props.scope}.${name}`;
  const [preferenceError, setPreferenceError] = useState<string>();
  const [query, setQuery] = useState<ManagementQuery>(() => {
    let size = 25;
    try { size = Number(localStorage.getItem(preference('pageSize')) ?? 25); }
    catch (err) { console.warn('Cannot read list preferences', err); }
    return readListQuery(window.location.hash, size);
  });
  const [draft, setDraft] = useState(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [filtersOpen, setFiltersOpen] = useState(() => Boolean(props.filters?.some((filter) => query[filter.key] !== undefined && query[filter.key] !== '')));
  const [result, setResult] = useState<R>();
  const savedSelection = selections.get(props.scope);
  const [selected, setSelected] = useState(() => savedSelection?.key === filterKey(query) ? savedSelection.ids : new Set<string>());
  const [allMatching, setAllMatching] = useState(savedSelection?.key === filterKey(query) ? savedSelection.all : false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [compact, setCompact] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [exportNotice, setExportNotice] = useState<string>();
  const [dismissedActionNotice, setDismissedActionNotice] = useState<string>();
  const table = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef('');
  const sequence = useRef(0);
  const onResult = useRef(props.onResult);
  onResult.current = props.onResult;
  const request = useRef<AbortController | undefined>(undefined);
  const manualRefresh = useRef(false);
  const queryKey = listQueryString(query);
  const scrollKey = `${props.scope}:${queryKey}`;
  const savePreference = (name: string, value: string) => {
    try { localStorage.setItem(preference(name), value); }
    catch (err) { console.warn('Cannot save list preferences', err); setPreferenceError('List preferences could not be saved in this browser.'); }
  };
  useEffect(() => {
    try {
      setCompact(localStorage.getItem(preference('compact')) === 'true');
      const saved = localStorage.getItem(preference('hidden'));
      const value: unknown = saved === null ? props.columns.filter((column) => column.defaultHidden).map((column) => column.key) : JSON.parse(saved);
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        const keys = value.filter((key) => props.columns.some((column) => column.key === key));
        setHidden(keys.length < props.columns.length ? keys : []);
      }
    } catch (err) { console.warn('Cannot read table preferences', err); setPreferenceError('Some table preferences could not be restored.'); }
  }, [props.scope]);
  const clear = () => { setSelected(new Set()); setAllMatching(false); };
  useEffect(() => { selections.set(props.scope, { key: filterKey(query), ids: selected, all: allMatching }); }, [props.scope, query, selected, allMatching]);
  const change = (next: ManagementQuery) => {
    if (filterKey(next) !== filterKey(query)) clear();
    const normalized = { ...next, page: next.page ?? 1, pageSize: next.pageSize ?? 25 };
    setQuery(normalized);
    setDraft(normalized);
    window.location.hash = `${props.scope}?${listQueryString(normalized)}`;
    try { localStorage.setItem(preference('pageSize'), String(normalized.pageSize)); }
    catch (err) { console.warn('Cannot save list preferences', err); setPreferenceError('List preferences could not be saved in this browser.'); }
  };
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setLoading(true);
    try {
      const next = await api<R>(`${props.path}?${queryKey}`, { signal: controller.signal });
      if (current !== sequence.current || controller.signal.aborted) return;
      setResult(next);
      onResult.current?.(next);
      setUpdatedAt(new Date().toLocaleTimeString());
      setError(undefined);
      if (restoredScroll.current !== scrollKey) {
        restoredScroll.current = scrollKey;
        requestAnimationFrame(() => { if (table.current) table.current.scrollTop = scrollPositions.get(scrollKey) ?? 0; });
      }
      if (next.page !== (query.page ?? 1)) {
        const adjusted = { ...query, page: next.page };
        setQuery(adjusted);
        setDraft(adjusted);
        window.history.replaceState(null, '', `#${props.scope}?${listQueryString(adjusted)}`);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally { if (current === sequence.current) setLoading(false); }
  }, [props.path, queryKey, props.scope]);
  const actionLabel = (action: string) => props.actions?.find((item) => item.id === action)?.label ?? action;
  const operations = useOperations(props.actions?.length ? `${props.path}/operations` : undefined, (operation, change) => {
    const remaining = operation.items.filter((item) => ['pending', 'running', 'failed', 'interrupted'].includes(item.status)).map((item) => item.id);
    const submitted = change === 'submitted' || change === 'recovered';
    const finished = operation.status !== 'running' && operation.status !== 'preview';
    if (submitted) {
      setAllMatching(false);
      setSelected(new Set(remaining));
    } else {
      const completed = operation.items.filter((item) => !remaining.includes(item.id)).map((item) => item.id);
      // `selected` holds exclusions while `allMatching` is on, so a finished record must be *added*
      // there. Deleting it unconditionally would re-select records the operator had excluded.
      setSelected((current) => {
        const next = new Set(current);
        for (const id of completed) { if (allMatching) next.add(id); else next.delete(id); }
        return next;
      });
    }
    if (change === 'submitted' || change === 'followed' && finished) {
      setRevision((value) => value + 1);
      props.onMutation?.();
    }
    if (submitted || change === 'followed' && finished && operation.items.length > 0) {
      const skipped = operation.items.filter((item) => item.status === 'skipped').length;
      const failed = operation.items.some((item) => item.status === 'failed' || item.status === 'interrupted');
      if (!finished || !failed) {
        const outcome = finished ? 'completed' : 'submitted';
        const next = finished ? '' : props.followSubmittedActions ? ' The list will refresh when the action finishes.' : ' Use Refresh to check the outcome.';
        props.onNotify?.(`${actionLabel(operation.action)}: ${outcome} ${operation.items.length - skipped} target(s)${skipped ? `; ${skipped} skipped` : ''}.${next}`, skipped ? 'warning' : 'success');
      }
    }
  }, props.followSubmittedActions);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [reload, props.refreshKey, revision]);
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.slice(1).split('?')[0] !== props.scope) return;
      // Read the current query from a ref rather than from a setQuery updater: React may invoke an
      // updater twice, and clear()/setDraft() inside one would fire their side effects twice too.
      const current = queryRef.current;
      const next = readListQuery(window.location.hash, current.pageSize);
      if (filterKey(next) !== filterKey(current)) clear();
      setDraft(next);
      if (listQueryString(next) !== listQueryString(current)) setQuery(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [props.scope]);
  const rows = result?.items ?? [];
  const total = result?.total ?? 0;
  const count = allMatching ? Math.max(0, total - selected.size) : selected.size;
  const checked = (id: string) => matchesSelection(id, selected, allMatching);
  const toggle = (id: string, value: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (allMatching ? !value : value) next.add(id); else next.delete(id);
    return next;
  });
  const allPage = rows.length > 0 && rows.every((row) => checked(props.identify(row)));
  const somePage = rows.some((row) => checked(props.identify(row)));
  const pageCount = Math.max(1, Math.ceil(total / (query.pageSize ?? 25)));
  const rowActions = props.actions?.filter((action) => action.rowLabel) ?? [];
  const hasRowActions = rowActions.length > 0 || Boolean(props.onRowDetails);
  const exportRows = async (scope: 'selected' | 'page' | 'matches') => {
    if (exporting) return;
    setExporting(true);
    setExportError(undefined);
    setExportNotice(undefined);
    try {
      const { blob, filename, matchedAtStart } = await downloadApi(scope === 'selected' ? `${props.path}/export` : `${props.path}/export?${queryKey}${scope === 'page' ? '&scope=page' : ''}`, scope === 'selected' ? {
        method: 'POST', body: JSON.stringify({ selection: selectionForQuery(query, selected, allMatching) }),
      } : undefined);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // The server counts matches when the export starts; a mismatch means records were added or
      // removed while the file streamed, and the download is a snapshot rather than what is on screen.
      setExportNotice(scope === 'matches' && matchedAtStart !== undefined && matchedAtStart !== total
        ? `The export contains ${matchedAtStart} records, which differs from the ${total} shown. The list changed while the file was generated.`
        : undefined);
    } catch (err) { setExportError(err instanceof Error ? err.message : String(err)); }
    finally { setExporting(false); }
  };
  const appliedFilters = Object.entries(query).filter(([key, value]) => !['page', 'pageSize', 'sort', 'dir'].includes(key) && value !== undefined && value !== '');
  const visibleColumns = props.columns.filter((column) => !hidden.includes(column.key));
  const busy = loading || props.refreshDisabled || operations.busy || operations.refreshing;
  const actionDisabled = busy || operations.unconfirmed;
  const refresh = async () => {
    if (manualRefresh.current || busy) return;
    setDismissedActionNotice(undefined);
    manualRefresh.current = true;
    props.onRefresh?.();
    try { await Promise.all([operations.refresh(), reload()]); }
    finally { manualRefresh.current = false; }
  };
  const lastActions = new Map<string, { operationId: string; action: string; item: OperationItem }>();
  for (const result of operations.results) {
    for (const item of result.items) lastActions.set(item.id, { operationId: result.id, action: result.action, item });
  }
  const failedActions = [...lastActions.values()].filter(({ item }) => item.status === 'failed' || item.status === 'interrupted');
  const actionError = operations.visible ? undefined : operations.error;
  const actionNoticeKey = JSON.stringify([actionError, operations.followNotice, failedActions.map(({ operationId, item }) => [operationId, item.id, item.status, item.detail])]);
  const showActionNotice = (actionError || operations.followNotice || failedActions.length > 0) && actionNoticeKey !== dismissedActionNotice;
  const batchActions = props.actions ?? [];
  const runAction = (action: (typeof batchActions)[number], id?: string) => {
    setDismissedActionNotice(undefined);
    void operations.preview(action.id, id === undefined ? selectionForQuery(query, selected, allMatching) : { ids: [id] }, action.options);
  };
  return <section className="min-w-0 rounded-lg border border-slate-200 bg-white" aria-label="Records">
    {props.toolbar ? <div className="flex flex-wrap items-center justify-end gap-2 border-b border-slate-200 p-4">{props.toolbar}</div> : null}
    <div data-management-toolbar className="sticky z-20 rounded-t-lg border-b border-slate-200 bg-white" style={{ top: 'var(--console-header-height, 6rem)' }}>
      <div className="flex min-h-16 flex-wrap items-center gap-2 px-4 py-3">
        <form className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-lg" onSubmit={(event) => { event.preventDefault(); change({ ...draft, page: 1 }); }}>
          <label className="relative min-w-0 flex-1 text-xs text-slate-600">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
            <Input className="w-full pl-8" value={draft.q ?? ''} onChange={(event) => setDraft({ ...draft, q: event.target.value })} placeholder="Search records" />
          </label>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        {props.filters?.length ? <Button variant="secondary" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}><Filter size={14} />Filters{appliedFilters.length ? ` (${appliedFilters.length})` : ''}</Button> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'animate-spin' : ''} />Refresh</Button>
          <Dropdown label={<><Download size={14} />Export</>} disabled={exporting}>
            <Button variant="ghost" disabled={exporting} onClick={() => void exportRows('matches')}>Export matches</Button>
            <Button variant="ghost" disabled={exporting} onClick={() => void exportRows('page')}>Export page</Button>
            {operations.operation && operations.operation.status !== 'preview' ? <>
              <ButtonLink variant="ghost" href={`${operations.basePath}/${encodeURIComponent(operations.operation.id)}/export`} target="_blank" rel="noreferrer">Export last action results</ButtonLink>
              {operations.operation.items.some((item) => item.status === 'failed') ? <ButtonLink variant="ghost" href={`${operations.basePath}/${encodeURIComponent(operations.operation.id)}/export?failed=1`} target="_blank" rel="noreferrer">Export last action failures</ButtonLink> : null}
            </> : null}
          </Dropdown>
          <Dropdown label={<><SlidersHorizontal size={14} />View</>}>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={compact} onChange={(event) => { setCompact(event.target.checked); savePreference('compact', String(event.target.checked)); }} />Compact rows</label>
            <p className="my-2 text-xs text-slate-600">Times use your local time zone.</p>
            <div className="space-y-2 border-t border-slate-200 pt-2">
              <p className="text-xs font-semibold text-slate-600">Columns</p>
              {props.columns.map((column) => <label key={column.key} className="flex items-center gap-2 text-sm"><Checkbox checked={!hidden.includes(column.key)} disabled={!hidden.includes(column.key) && hidden.length === props.columns.length - 1} onChange={(event) => {
                const next = event.target.checked ? hidden.filter((key) => key !== column.key) : [...hidden, column.key];
                setHidden(next); savePreference('hidden', JSON.stringify(next));
              }} />{column.label}</label>)}
            </div>
          </Dropdown>
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3 ${count ? 'bg-blue-50' : ''}`} role="group" aria-label="Selection actions">
        <strong className="mr-2 text-sm tabular-nums" aria-live="polite">{count} {allMatching ? 'matching records' : 'record(s)'} selected</strong>
        {batchActions.map((action) => <Button key={action.id} size="sm" variant={action.danger ? 'dangerOutline' : 'secondary'} disabled={actionDisabled || !count} onClick={() => runAction(action)}>{operations.busy && operations.busyAction === action.id ? <RefreshCw aria-hidden="true" size={14} className="animate-spin" /> : null}{action.label}</Button>)}
        <Button size="sm" variant="secondary" disabled={exporting || loading || !count} onClick={() => void exportRows('selected')}>{exporting ? 'Exporting...' : 'Export selected'}</Button>
        <Tooltip content="Clear selection"><Button size="icon" variant="secondary" aria-label="Clear selection" disabled={!allMatching && !selected.size} onClick={clear}><X size={14} /></Button></Tooltip>
        {props.selectionOptions ? <div className="basis-full">{props.selectionOptions}</div> : null}
      </div>
    </div>
    <div className="px-4">
      {filtersOpen && props.filters?.length ? (
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-200 py-3" onSubmit={(event) => { event.preventDefault(); change({ ...draft, page: 1 }); }}>
          {props.filters.map((filter) => {
            const options = filter.options;
            const selected = String(draft[filter.key] ?? '').split(',').filter(Boolean);
            return options && filter.multiple ? <fieldset key={filter.key} className="min-w-0 text-xs text-slate-600">
              <legend>{filter.label}</legend>
              <Dropdown align="start" className="mt-1" label={<><span className="sr-only">{filter.label}: </span><span className="min-w-24 text-left">{selected.length === 0 ? 'All' : selected.length === 1 ? selected[0] : `${selected.length} selected`}</span></>}>
                <div role="group" aria-label={`${filter.label} options`}>
                  {options.map((value) => <label key={value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-100">
                    <Checkbox checked={selected.includes(value)} onChange={(event) => setDraft({
                      ...draft, [filter.key]: options.filter((option) => option === value ? event.target.checked : selected.includes(option)).join(','),
                    })} />{value}
                  </label>)}
                </div>
                <p className="px-2 text-xs text-slate-600">No selection includes all records.</p>
                <Button type="button" variant="ghost" disabled={!selected.length} onClick={() => setDraft({ ...draft, [filter.key]: '' })}>Clear {filter.label.toLowerCase()} filter</Button>
              </Dropdown>
            </fieldset> : <label key={filter.key} className="text-xs text-slate-600">{filter.label}
              {options ? <Select className="mt-1 block" value={String(draft[filter.key] ?? '')} onChange={(event) => setDraft({ ...draft, [filter.key]: event.target.value })}>
                <option value="">All</option>{options.map((value) => <option key={value}>{value}</option>)}</Select>
                : <Input className="mt-1 block" type={filter.type ?? 'text'} value={inputValue(draft[filter.key], filter.type)} onChange={(event) => setDraft({ ...draft, [filter.key]: filter.type === 'datetime-local' && event.target.value ? new Date(event.target.value).toISOString() : event.target.value })} />}
            </label>;
          })}
          <Button type="submit" variant="secondary">Apply filters</Button>
        </form>
      ) : null}
      {appliedFilters.length ? <div className="flex flex-wrap items-center gap-2 py-2" aria-label="Applied filters">
        {appliedFilters.map(([key, value]) => <Button key={key} size="sm" variant="secondary" className="max-w-full" aria-label={`Remove ${props.filters?.find((filter) => filter.key === key)?.label ?? key} filter`} onClick={() => {
          const next = { ...query }; delete next[key as keyof ManagementQuery]; change({ ...next, page: 1 });
        }}><span className="max-w-56 truncate">{props.filters?.find((filter) => filter.key === key)?.label ?? key}: {String(value)}</span><X size={12} /></Button>)}
        <Button size="sm" variant="secondary" onClick={() => change({ page: 1, pageSize: query.pageSize, sort: query.sort, dir: query.dir })}>Clear filters</Button>
      </div> : null}
      <div className="flex min-h-9 items-center justify-between gap-2 py-2 text-xs text-slate-600" role="status">
        <span>{loading ? (result ? 'Refreshing records...' : 'Loading records...') : `${total} record(s)`}</span>
        <span>{updatedAt ? `Updated ${updatedAt}` : 'Not loaded'}{error ? ' · stale' : ''}</span>
      </div>
      {error ? <p role="alert" className="mb-3 break-words rounded-md bg-red-50 p-3 text-sm text-red-700">{error}{result ? ' Previous records may be stale.' : ''}</p> : null}
      {exportError ? <p role="alert" className="mb-3 break-words rounded-md bg-red-50 p-3 text-sm text-red-700">Export failed: {exportError}</p> : null}
      {exportNotice ? <p role="status" className="mb-3 break-words rounded-md bg-amber-50 p-3 text-sm text-amber-800">{exportNotice}</p> : null}
      {preferenceError ? <p role="status" className="mb-2 text-sm text-amber-800">{preferenceError}</p> : null}
      {operations.busy ? <p role="status" className="sr-only">Submitting action...</p> : null}
      {showActionNotice ? <Notification tone={actionError || failedActions.length ? 'error' : 'warning'} onClose={() => setDismissedActionNotice(actionNoticeKey)}>
        {actionError ? <p>{actionError}</p> : null}
        {actionError && operations.operation?.status === 'preview' && operations.operation.items.some((item) => item.status === 'pending')
          ? <Button size="sm" variant="secondary" disabled={busy} onClick={operations.retrySubmission}>Retry submission</Button> : null}
        {operations.followNotice ? <p>{operations.followNotice}</p> : null}
        {failedActions.length ? <>
          <p>{failedActions.length} target(s) failed or were interrupted.</p>
          <ul className="max-h-48 space-y-2 overflow-auto">
            {failedActions.map(({ action, item }) => <li key={item.id}>
              <span className="font-mono">{item.label ?? item.id}</span>: {actionLabel(action)} - <span className="whitespace-pre-wrap">{item.detail ?? item.status}</span>
            </li>)}
          </ul>
        </> : null}
      </Notification> : null}
      <OperationConfirmation controller={operations} />
    </div>
    <div ref={table} onScroll={(event) => scrollPositions.set(scrollKey, event.currentTarget.scrollTop)} className="max-h-[65vh] overflow-auto" aria-busy={loading}>
      <Table className="min-w-[900px]" data-density={compact ? 'compact' : 'comfortable'}>
        <thead className="sticky top-0 z-10 bg-slate-50"><tr>
          <Th className="w-12"><Checkbox aria-label="Select current page" disabled={loading || !rows.length} checked={allPage} indeterminate={somePage && !allPage} onChange={(event) => {
            const value = event.target.checked;
            setSelected((current) => { const next = new Set(current); for (const row of rows) { const id = props.identify(row); if (allMatching ? !value : value) next.add(id); else next.delete(id); } return next; });
          }} /></Th>
          {visibleColumns.map((column) => <Th key={column.key} className={`whitespace-nowrap ${column.align === 'right' ? 'text-right' : ''}`} aria-sort={column.sort ? query.sort === column.sort ? query.dir === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}>
            {column.sort ? <button className="inline-flex min-h-8 items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-blue-600" onClick={() => change({ ...query, sort: column.sort, dir: query.sort === column.sort && query.dir === 'desc' ? 'asc' : 'desc', page: 1 })}>{column.label}{query.sort !== column.sort ? <ArrowUpDown size={12} className="text-slate-500" /> : query.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</button> : column.label}
          </Th>)}
          {hasRowActions ? <Th>Actions</Th> : null}
        </tr></thead>
        <tbody>{rows.map((row) => {
          const primary = rowActions.find((action) => !action.danger && action.canRun?.(row) !== false);
          return <tr key={props.identify(row)} data-selected={checked(props.identify(row))}>
            <Td><Checkbox disabled={loading} aria-label={`Select ${props.identify(row)}`} checked={checked(props.identify(row))} onChange={(event) => toggle(props.identify(row), event.target.checked)} /></Td>
            {visibleColumns.map((column) => <Td key={column.key} className={`max-w-sm ${column.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : ''} ${column.nowrap ? 'whitespace-nowrap' : ''}`}>{column.render(row)}</Td>)}
            {hasRowActions ? <Td><div className="flex items-center gap-2">
              {primary ? <Button size="sm" variant="secondary" disabled={actionDisabled} onClick={() => runAction(primary, props.identify(row))}>{primary.rowLabel}</Button> : null}
              <Dropdown label={<><MoreHorizontal size={16} /><span className="sr-only">Actions for {props.identify(row)}</span></>} size="sm">
                {props.onRowDetails ? <Button variant="ghost" disabled={loading} onClick={() => props.onRowDetails?.(row)}>Details</Button> : null}
                {rowActions.filter((action) => action !== primary).map((action) => <Button key={action.id} variant={action.danger ? 'dangerOutline' : 'ghost'} title={action.canRun?.(row) === false ? 'Unavailable for the current task state.' : undefined} disabled={actionDisabled || action.canRun?.(row) === false} onClick={() => runAction(action, props.identify(row))}>{action.rowLabel}</Button>)}
              </Dropdown>
            </div></Td> : null}
          </tr>;
        })}
          {loading && !result ? Array.from({ length: 5 }, (_, index) => <tr key={`loading-${index}`} aria-hidden="true">{Array.from({ length: visibleColumns.length + 1 + (hasRowActions ? 1 : 0) }, (_, column) => <Td key={column}><div className="h-4 w-3/4 rounded bg-slate-100" /></Td>)}</tr>) : null}
        </tbody>
      </Table>
      {!loading && !rows.length && !error ? <p className="p-10 text-center text-sm text-slate-600">{appliedFilters.length ? 'No matching records. Try clearing the filters.' : 'No records yet.'}</p> : null}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
      <span>{total} total / page {query.page ?? 1} of {pageCount}</span>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">Rows <Select aria-label="Rows per page" value={query.pageSize} onChange={(event) => change({ ...query, pageSize: Number(event.target.value), page: 1 })}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</Select></label>
        {pageCount > 1 ? <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get('page')); if (Number.isInteger(value) && value >= 1 && value <= pageCount) change({ ...query, page: value }); }}>
          <Input name="page" type="number" aria-label="Go to page" min={1} max={pageCount} className="w-20" defaultValue={query.page} key={query.page} /><Button size="sm" variant="secondary" type="submit">Go</Button>
        </form> : null}
        <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={(query.page ?? 1) <= 1} onClick={() => change({ ...query, page: (query.page ?? 1) - 1 })}>Previous</Button><Button size="sm" variant="secondary" disabled={(query.page ?? 1) >= pageCount} onClick={() => change({ ...query, page: (query.page ?? 1) + 1 })}>Next</Button></div>
      </div>
    </div>
  </section>;
}

function inputValue(value: string | number | undefined, type?: string): string | number {
  if (value === undefined || value === '' || type !== 'datetime-local') return value ?? '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function CopyValue({ value, compact }: { value: string; compact?: boolean }) {
  const [notice, setNotice] = useState<string>();
  return <span className="inline-flex max-w-full flex-wrap items-center gap-1">
    {!compact ? <span className="break-all">{value}</span> : null}
    <Tooltip content={notice ?? 'Copy value'}><Button size="icon" type="button" variant="secondary" aria-label={`Copy ${value}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setNotice('Copied'); }
      catch (err) { console.warn('Copy failed', err); setNotice('Copy unavailable; select the text manually.'); }
    }}>{notice === 'Copied' ? <Check size={14} /> : <Copy size={14} />}</Button></Tooltip>
    <span role="status" className={notice && notice !== 'Copied' ? 'text-xs text-amber-800' : 'sr-only'}>{notice}</span>
  </span>;
}
