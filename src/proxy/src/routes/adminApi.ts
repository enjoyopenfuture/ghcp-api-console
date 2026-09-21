import { Router, type Response } from 'express';
import {
  apiError,
  errorFields,
  readManagementQuery,
  csvExport,
  HttpApiError,
  type ClearProxyErrorDiagnosticsRequest,
  type ImportCopilotOauthTokensRequest,
} from '@ghcp/shared';
import { importCopilotOauthTokens } from '../accounts/copilotOauthTokenImport.js';
import { deleteAccount, getAccount, listAccounts, toAccountDto } from '../db/accountsRepo.js';
import { listRequestStats, listRequestStatsPage } from '../db/requestStatsRepo.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { errorDiagnosticsStore } from '../diagnostics/errorDiagnostics.js';
import { ErrorDiagnosticsDisabledError } from '../diagnostics/errorDiagnosticsStore.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { Logger } from '../logger.js';

export const adminApiRouter = Router();
const logger = new Logger('admin-api');

adminApiRouter.get('/error-diagnostics', async (req, res) => {
  try {
    const query = readManagementQuery(req.query);
    if (query.status && !/^[1-5]\d\d$/.test(query.status)) throw new HttpApiError(400, 'invalid_status', 'HTTP status must be a three-digit status code.');
    if (query.failureCode && !['http', 'fetch', 'stream'].includes(query.failureCode)) throw new HttpApiError(400, 'invalid_failure_kind', 'Unknown diagnostic failure kind.');
    res.json(await errorDiagnosticsStore.list(query.page, query.pageSize, query));
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.route('/error-diagnostics/export').get(exportDiagnostics()).post(exportDiagnostics());
function exportDiagnostics() {
  return csvExport('error-diagnostics',
    ['id', 'identity', 'timestamp', 'path', 'model', 'failureKind', 'status'],
    (query) => errorDiagnosticsStore.list(query.page, query.pageSize, query),
    (record) => [record.id, record.identity, record.timestamp, record.path, record.model, record.failureKind, record.status],
    async (_query, consume) => {
      const items = await errorDiagnosticsStore.snapshot();
      await consume(async (query) => errorDiagnosticsStore.pageSnapshot(items, query));
    },
  );
}

adminApiRouter.delete('/error-diagnostics', async (req, res) => {
  const body = req.body as Partial<ClearProxyErrorDiagnosticsRequest>;
  if (body.confirm !== true) {
    res.status(400).json(apiError('error_diagnostics_confirmation_required', 'Set confirm to true to clear all error diagnostics.'));
    return;
  }
  try {
    await errorDiagnosticsStore.clear();
    logger.info('clear-error-diagnostics', 'Cleared all proxy error diagnostics');
    res.json({ cleared: true });
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.get('/error-diagnostics/:id/download', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, true);
});

adminApiRouter.get('/error-diagnostics/:id', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, false);
});

adminApiRouter.get('/accounts', async (req, res) => {
  const result = await listAccounts(readManagementQuery(req.query));
  res.json({ ...result, items: result.items.map(toAccountDto) });
});

adminApiRouter.get('/accounts/summary', async (_req, res) => {
  await initializeStorage();
  res.json(await getStorage().summarizeAccounts());
});

adminApiRouter.route('/accounts/export').get(exportAccounts()).post(exportAccounts());
function exportAccounts() {
  return csvExport('proxy-accounts',
    ['identity', 'ssoUser', 'ghLogin', 'copilotOauthStatus', 'updatedAt'],
    listAccounts, (account) => [account.identity, account.ssoUser, account.ghLogin, account.copilotOauthStatus, account.updatedAt],
    async (_query, consume) => { await initializeStorage(); await getStorage().withReadSnapshot((reader) => consume(reader.listAccounts)); },
  );
}

adminApiRouter.route('/request-stats/export').get(exportRequests()).post(exportRequests());
function exportRequests() {
  return csvExport('request-stats',
    ['id', 'identity', 'ghLogin', 'requestedAt', 'path', 'model', 'success', 'inputTokens', 'outputTokens', 'cacheInputTokens', 'cacheWriteTokens', 'failureReason'],
    listRequestStatsPage, (stat) => [stat.id, stat.identity, stat.ghLogin, stat.requestedAt, stat.path, stat.model, stat.success, stat.inputTokens, stat.outputTokens, stat.cacheInputTokens, stat.cacheWriteTokens, stat.failureReason],
    async (_query, consume) => { await initializeStorage(); await getStorage().withReadSnapshot((reader) => consume(reader.listRequestStatsPage)); },
  );
}

adminApiRouter.get('/accounts/:identity', async (req, res) => {
  const account = await getAccount(req.params.identity);
  if (!account) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  res.json(toAccountDto(account));
});

adminApiRouter.delete('/accounts/:identity', async (req, res) => {
  const result = await deleteAccount(req.params.identity);
  if (!result) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  clearModelsCache(result.identity);
  logger.info('delete-account', 'Deleted Proxy account and request stats', { ...result });
  res.json(result);
});

adminApiRouter.post('/accounts/copilot-oauth-token/import', async (req, res) => {
  const body = req.body as ImportCopilotOauthTokensRequest;
  if (typeof body.csvText !== 'string' || !body.csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  try {
    logger.info('import-copilot-oauth-start', 'Copilot OAuth token CSV import requested');
    const result = await importCopilotOauthTokens(body.csvText);
    logger.info('import-copilot-oauth-done', 'Copilot OAuth token CSV import completed', { total: result.summary.total, success: result.summary.success, failed: result.summary.failed });
    res.json(result);
  } catch (err) {
    logger.error('import-copilot-oauth-failed', 'Copilot OAuth token CSV import failed', { ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_import_failed', err instanceof Error ? err.message : String(err)));
  }
});

adminApiRouter.get('/accounts/:identity/request-stats', async (req, res) => {
  res.json(await listRequestStats(req.params.identity, readLimit(req.query.limit)));
});

adminApiRouter.get('/request-stats', async (req, res) => {
  res.json(Object.keys(req.query).some((key) => key !== 'limit')
    ? await listRequestStatsPage(readManagementQuery(req.query))
    : await listRequestStats(undefined, readLimit(req.query.limit)));
});

adminApiRouter.post('/accounts/:identity/copilot-oauth/reauthorize', async (req, res) => {
  try {
    const body = req.body as { ssoPassword?: unknown; ssoType?: unknown; credentialMode?: unknown };
    logger.info('reauthorize-copilot-start', 'Manual Copilot OAuth reauthorization requested', { identity: req.params.identity, ssoType: body.ssoType });
    await copilotAuthManager.triggerOauthRefresh(req.params.identity, {
      ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : undefined,
      ssoType: body.ssoType === 'azure' || body.ssoType === 'custom' ? body.ssoType : undefined,
      credentialMode: body.credentialMode === 'default' ? 'default' : 'override',
    });
    const account = await getAccount(req.params.identity);
    if (!account) throw new HttpApiError(409, 'account_removed_after_submission', 'Authorization was submitted, but the account was removed. Check the associated Login task before retrying.');
    logger.info('reauthorize-copilot-queued', 'Copilot OAuth reauthorization queued a login task', { identity: req.params.identity, copilotOauthStatus: account?.copilotOauthStatus });
    res.json(toAccountDto(account));
  } catch (err) {
    logger.error('reauthorize-copilot-failed', 'Manual Copilot OAuth reauthorization failed', { identity: req.params.identity, ...errorFields(err) });
    res.status(err instanceof HttpApiError ? err.status : 400)
      .json(apiError(err instanceof HttpApiError ? err.code : 'copilot_oauth_reauthorization_failed', err instanceof Error ? err.message : String(err)));
  }
});

function readLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

async function sendDiagnosticRecord(id: string, res: Response, download: boolean): Promise<void> {
  if (!isDiagnosticId(id)) {
    res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
    return;
  }
  try {
    const record = await errorDiagnosticsStore.get(id);
    if (!record) {
      res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
      return;
    }
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="proxy-error-${record.id}.log"`);
      res.type('text/plain').send(record.content);
      return;
    }
    res.json(record);
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
}

function sendDiagnosticsError(res: Response, err: unknown): void {
  if (err instanceof HttpApiError) {
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof ErrorDiagnosticsDisabledError) {
    res.status(503).json(apiError('error_diagnostics_disabled', err.message));
    return;
  }
  logger.error('error-diagnostics-storage-failed', 'Proxy error diagnostics storage operation failed', {
    ...errorFields(err),
  });
  res.status(500).json(apiError('error_diagnostics_storage_failed', err instanceof Error ? err.message : String(err)));
}

function isDiagnosticId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
