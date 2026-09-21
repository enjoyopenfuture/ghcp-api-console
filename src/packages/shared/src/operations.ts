import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpApiError, type PageResponse } from './api.js';
import { loggerFor } from './logger.js';
import { MANAGEMENT_BATCH_LIMIT, readManagementQuery, type ManagementOperation, type ManagementQuery, type ManagementSelection, type OperationItem } from './management.js';

/** Consecutive failed progress reads after which a still-running item is reported as interrupted. */
const MAX_REFRESH_FAILURES = 10;

/** Poll interval per round; each round costs one downstream call per item still running. */
const REFRESH_INTERVALS_MS = [1000, 1000, 1000, 1000, 1000, 2000, 2000, 5000, 5000, 10_000, 15_000];

/** A preview has to be confirmed within this window; afterwards the operator previews again. */
const PREVIEW_TTL_MS = 600_000;

/** Finished operations stay readable (Refresh status, export) for this long after their last change. */
const RESULT_TTL_MS = 60 * 60 * 1000;

export async function resolveOperationSelection<T>(
  input: unknown, list: (query: ManagementQuery) => Promise<PageResponse<T>>, identify: (item: T) => string,
): Promise<string[]> {
  if (!input || typeof input !== 'object') throw new HttpApiError(400, 'invalid_selection', 'A selection is required.');
  const selection = input as ManagementSelection;
  const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 500);
  if (selection.ids !== undefined) {
    if (!validIds(selection.ids) || selection.ids.length > MANAGEMENT_BATCH_LIMIT) {
      throw new HttpApiError(400, 'batch_limit', `Select at most ${MANAGEMENT_BATCH_LIMIT} records.`);
    }
    return [...new Set(selection.ids)];
  }
  if (!selection.query || typeof selection.query !== 'object' || Array.isArray(selection.query)) {
    throw new HttpApiError(400, 'invalid_selection', 'Provide record IDs or a filter query.');
  }
  if (selection.excludedIds !== undefined && (!validIds(selection.excludedIds) || selection.excludedIds.length > MANAGEMENT_BATCH_LIMIT)) {
    throw new HttpApiError(400, 'invalid_selection', 'Excluded IDs are invalid.');
  }
  const excluded = new Set(selection.excludedIds);
  const query = { ...readManagementQuery({ ...selection.query }), asOf: new Date().toISOString() };
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const result = await list({ ...query, page, pageSize: 100 });
    if (result.page !== page) break;
    for (const item of result.items) {
      const id = identify(item);
      if (!excluded.has(id)) ids.add(id);
      if (ids.size > MANAGEMENT_BATCH_LIMIT) throw new HttpApiError(400, 'batch_limit', `More than ${MANAGEMENT_BATCH_LIMIT} records match. Narrow the filter; no records were submitted.`);
    }
    if (page * result.pageSize >= result.total) break;
  }
  return [...ids];
}

/**
 * Holds batch operations for one scope in process memory: a preview freezes the targets, a single
 * confirmation runs them, and the result stays readable for a while so the dialog can refresh it.
 *
 * Nothing is persisted. A restart drops previews and results (the console then reports the
 * operation as not found and asks for a new preview); the work already submitted to the underlying
 * services is unaffected because each item is its own committed change downstream.
 */
export class OperationManager {
  private readonly operations = new Map<string, ManagementOperation>();
  private readonly logger = loggerFor('management', 'operations');
  constructor(readonly scope: string) { }

  get(id: string): ManagementOperation | undefined {
    this.sweep();
    const operation = this.operations.get(id);
    return operation?.scope === this.scope ? operation : undefined;
  }

  async preview(action: string, ids: string[], eligibility: (id: string) => Promise<string | undefined>, snapshot?: (id: string) => Promise<Pick<OperationItem, 'revision' | 'label' | 'requiresPasswordOverride'>>, options?: ManagementOperation['options']): Promise<ManagementOperation> {
    if (!ids.length || ids.length > MANAGEMENT_BATCH_LIMIT) throw new HttpApiError(400, 'invalid_selection', `Select 1 to ${MANAGEMENT_BATCH_LIMIT} records.`);
    const items: OperationItem[] = [];
    for (const id of ids) {
      const reason = await eligibility(id);
      items.push({ ...await snapshot?.(id), id, status: reason ? 'skipped' : 'pending', detail: reason });
    }
    const now = new Date().toISOString();
    const operation: ManagementOperation = {
      id: randomUUID(), scope: this.scope, action, status: 'preview', items, createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), options,
    };
    this.sweep();
    this.operations.set(operation.id, operation);
    return operation;
  }

  execute(
    id: string, perform: (action: string, item: OperationItem) => Promise<OperationItem>,
    refresh?: (item: OperationItem, action: string) => Promise<OperationItem>,
    options?: ManagementOperation['options'],
    concurrency = 1,
  ): ManagementOperation {
    const operation = this.get(id);
    // An expired preview has already been swept, so it surfaces as "not found" and the console asks
    // for a new preview.
    if (!operation) throw new HttpApiError(404, 'operation_not_found', 'Operation preview was not found.');
    // Re-submitting an accepted operation (double click, client retry) returns its current state
    // instead of running it twice. The check and the transition below are synchronous, so two
    // concurrent requests cannot both pass.
    if (operation.status !== 'preview') return operation;
    operation.status = 'running';
    operation.options = { ...operation.options, ...options };
    operation.updatedAt = new Date().toISOString();
    void this.run(operation, perform, refresh, concurrency).catch((err: unknown) => {
      this.logger.error('operation-failed', 'Operation worker stopped', { id, error: errorMessage(err) });
      operation.status = 'interrupted';
      operation.items = operation.items.map((item) => item.status === 'pending' || item.status === 'running'
        ? { ...item, status: 'interrupted', detail: 'The worker stopped before this item finished. Check the resource before retrying.' } : item);
      operation.updatedAt = new Date().toISOString();
    });
    return operation;
  }

  private async run(
    operation: ManagementOperation, perform: (action: string, item: OperationItem) => Promise<OperationItem>,
    refresh?: (item: OperationItem, action: string) => Promise<OperationItem>,
    concurrency = 1,
  ): Promise<void> {
    let nextIndex = 0;
    let stopped = false;
    const worker = async () => {
      try {
        while (!stopped && nextIndex < operation.items.length) {
          const index = nextIndex++;
          const item = operation.items[index]!;
          if (item.status !== 'pending') continue;
          operation.items[index] = { ...item, status: 'running' };
          touch(operation);
          try {
            operation.items[index] = await perform(operation.action, item);
          } catch (err) {
            this.logger.warn('item-failed', 'Operation item failed', { operationId: operation.id, id: item.id, error: errorMessage(err) });
            const conflict = err instanceof HttpApiError && [
              'task_already_active', 'task_changed', 'account_mapping_changed', 'authorization_conflict', 'authorization_not_needed',
            ].includes(err.code);
            operation.items[index] = { ...item, status: err instanceof HttpApiError && err.code.endsWith('_unconfirmed') ? 'interrupted' : conflict ? 'skipped' : 'failed', detail: errorMessage(err) };
          }
          touch(operation);
        }
      } catch (err) {
        stopped = true;
        throw err;
      }
    };
    // Wait for every worker so items that were mid-flight when one worker failed still land in
    // the final snapshot instead of being reported as never having run.
    const results = await Promise.allSettled(Array.from({ length: Math.min(operation.items.length, Math.max(1, Math.min(20, concurrency))) }, worker));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    await this.awaitCompletion(operation, refresh);
    operation.status = 'completed';
    touch(operation);
  }

  /**
   * Polls the items that are still running until every one reaches a terminal state.
   *
   * Refresh failures are bounded: an item whose progress cannot be read `MAX_REFRESH_FAILURES`
   * times in a row is marked `interrupted` rather than being left `running`, otherwise an
   * unreachable downstream service keeps this loop alive forever.
   * The poll interval backs off because each round costs one downstream call per running item.
   */
  private async awaitCompletion(
    operation: ManagementOperation,
    refresh?: (item: OperationItem, action: string) => Promise<OperationItem>,
  ): Promise<void> {
    if (!refresh) return;
    const failures = new Map<number, number>();
    for (let round = 0; operation.items.some((item) => item.status === 'running'); round++) {
      await delay(REFRESH_INTERVALS_MS[Math.min(round, REFRESH_INTERVALS_MS.length - 1)]!);
      for (let index = 0; index < operation.items.length; index++) {
        const current = operation.items[index]!;
        if (current.status !== 'running') continue;
        try {
          const next = await refresh(current, operation.action);
          failures.delete(index);
          if (next.status !== current.status || next.detail !== current.detail) {
            operation.items[index] = next;
            touch(operation);
          }
        } catch (err) {
          const attempts = (failures.get(index) ?? 0) + 1;
          failures.set(index, attempts);
          const missing = err instanceof HttpApiError && err.status === 404;
          const exhausted = missing || attempts >= MAX_REFRESH_FAILURES;
          this.logger.warn('progress-unavailable', 'Could not refresh operation item progress',
            { operationId: operation.id, id: current.id, attempts, error: errorMessage(err) });
          operation.items[index] = {
            ...current,
            status: exhausted ? 'interrupted' : 'running',
            detail: exhausted
              ? `Progress could not be confirmed after ${attempts} attempt(s). Check the resource before retrying: ${errorMessage(err)}`
              : `Progress is currently unavailable: ${errorMessage(err)}`,
          };
          touch(operation);
        }
      }
    }
  }

  /** Drops expired previews and stale results; running operations are never evicted. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, operation] of this.operations) {
      const expired = operation.status === 'preview'
        ? Date.parse(operation.expiresAt) <= now
        : operation.status !== 'running' && Date.parse(operation.updatedAt) + RESULT_TTL_MS <= now;
      if (expired) this.operations.delete(id);
    }
  }
}

function touch(operation: ManagementOperation): void {
  operation.updatedAt = new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
