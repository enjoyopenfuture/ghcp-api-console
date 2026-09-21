import { Router, type Response, type ErrorRequestHandler } from 'express';
import { apiError, HttpApiError } from './api.js';
import { csvRow, type ManagementOperation, type OperationItem } from './management.js';
import { OperationManager } from './operations.js';
import { loggerFor } from './logger.js';

export interface OperationRoutesOptions {
  scope: string;
  actions: readonly string[];
  resolve(selection: unknown): Promise<string[]>;
  eligibility(action: string, id: string): Promise<string | undefined>;
  prepareExecution(input: Record<string, unknown>, action: string): (action: string, item: OperationItem) => Promise<OperationItem>;
  refresh?(item: OperationItem, action: string): Promise<OperationItem>;
  snapshot?(id: string): Promise<Pick<OperationItem, 'revision' | 'label' | 'requiresPasswordOverride'>>;
  dedupeKey?(action: string, id: string): Promise<string | undefined>;
  concurrency?(action: string): number;
}

export function operationRoutes(options: OperationRoutesOptions): Router {
  const router = Router();
  const manager = new OperationManager(options.scope);
  const logger = loggerFor(options.scope, 'operations-api');
  const fail = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('operation-request-failed', 'Management operation request failed', { error: message });
    res.status(error instanceof HttpApiError ? error.status : 500)
      .json(apiError(error instanceof HttpApiError ? error.code : 'operation_failed', message));
  };
  router.post('/preview', async (req, res) => {
    try {
      const body = objectBody(req.body);
      if (typeof body.action !== 'string' || !options.actions.includes(body.action)) throw new HttpApiError(400, 'invalid_operation', 'Unsupported management action.');
      const action = body.action;
      const ids = await options.resolve(body.selection);
      const seen = new Set<string>();
      res.status(201).json(await manager.preview(action, ids, async (id) => {
        const reason = await options.eligibility(action, id);
        if (reason) return reason;
        const key = await options.dedupeKey?.(action, id);
        if (key && seen.has(key)) return 'Another selected task targets the same account. Only one attempt per account will be submitted.';
        if (key) seen.add(key);
        return undefined;
      }, options.snapshot, publicOptions(body.options)));
    } catch (err) { fail(res, err); }
  });
  router.get('/:id', (req, res) => {
    try {
      const operation = manager.get(req.params.id);
      if (!operation) throw new HttpApiError(404, 'operation_not_found', 'Operation was not found. Results are kept in memory for a limited time; preview the operation again if needed.');
      res.json(operation);
    } catch (err) { fail(res, err); }
  });
  router.get('/:id/export', (req, res) => {
    try {
      const operation = manager.get(req.params.id);
      if (!operation) throw new HttpApiError(404, 'operation_not_found', 'Operation was not found.');
      const items = req.query.failed === '1' ? operation.items.filter((item) => item.status === 'failed') : operation.items;
      res.type('text/csv').attachment(`operation-${operation.id}.csv`)
        .send('\ufeff' + csvRow(['id', 'status', 'detail', 'attemptId', 'taskId'])
          + items.map((item) => csvRow([item.id, item.status, item.detail, item.attemptId, item.relatedTaskId])).join(''));
    } catch (err) { fail(res, err); }
  });
  router.post('/:id/execute', (req, res) => {
    try {
      const body = objectBody(req.body);
      const preview = manager.get(req.params.id);
      // Resolve the preview first: without this, a dropped or unknown operation makes every override
      // look invalid and the operator is told to fix their selection instead of to preview again.
      if (!preview) {
        throw new HttpApiError(404, 'operation_not_found', 'The operation preview was not found. Reload the list and preview the operation again.');
      }
      if (Array.isArray(body.overrides)) {
        const ids = new Set(preview.items.map((item) => item.id));
        if (body.overrides.some((row) => !row || typeof row !== 'object' || !ids.has(row.id))) {
          throw new HttpApiError(400, 'invalid_overrides', 'Password overrides must belong to the confirmed selection.');
        }
      }
      const execution = { ...body, ...preview.options, ...(body.ssoType === undefined ? {} : { ssoType: body.ssoType }) };
      const perform = options.prepareExecution(execution, preview.action);
      const result = manager.execute(req.params.id, async (action, item) => {
        const reason = await options.eligibility(action, item.id);
        if (reason) return { ...item, status: 'skipped', detail: reason };
        if (options.snapshot && (await options.snapshot(item.id)).revision !== item.revision) {
          return { ...item, status: 'skipped', detail: 'The record changed after preview. Review it before submitting another operation.' };
        }
        return perform(action, item);
      }, options.refresh, publicOptions(execution), options.concurrency?.(preview.action) ?? 1);
      res.status(202).json(result);
    } catch (err) { fail(res, err); }
  });
  return router;
}

export function managementErrorHandler(service: string): ErrorRequestHandler {
  const logger = loggerFor(service, 'api');
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('request-failed', 'API request failed', { error: message });
    res.status(error instanceof HttpApiError ? error.status : 500)
      .json(apiError(error instanceof HttpApiError ? error.code : 'internal_error', message));
  };
}

function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpApiError(400, 'invalid_request', 'A JSON object is required.');
  return input as Record<string, unknown>;
}

function publicOptions(input: unknown): ManagementOperation['options'] {
  if (!input || typeof input !== 'object') return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.assignCopilotSeat === 'boolean' ? { assignCopilotSeat: value.assignCopilotSeat } : {}),
    ...(value.ssoType === 'custom' || value.ssoType === 'azure' ? { ssoType: value.ssoType } : {}),
  };
}
