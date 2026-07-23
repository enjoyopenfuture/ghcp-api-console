import { TextDecoder } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { apiError } from '@ghcp/shared';
import { recordRequestStat } from '../db/requestStatsRepo.js';
import { Logger } from '../logger.js';
import { copilotAuthManager, CopilotAuthNotReadyError } from '../copilot/copilotAuthManager.js';
import {
  assertModelSupportsPath,
  CopilotApiError,
  CopilotModelPathError,
  forwardCopilotRequest,
  listModels,
  modelSupportsPath,
  type CopilotApiPath,
  type ForwardCopilotRequestOptions,
  type ModelInfo,
} from '../copilot/copilotClient.js';
import {
  estimateInputTokens,
  isTokenCountFallbackStatus,
  prepareClaudeCodeMessagesRequest,
  shouldTranslateWebSearchError,
  webSearchUnsupportedMessage,
} from './claudeCodeCompat.js';
import { resolveClaudeCodeOptimized } from './claudeCodeMode.js';

export const compatibleRouter = Router();
const logger = new Logger('compatible');

interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

compatibleRouter.get('/v1/models', async (req, res) => {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  let accessToken: string | undefined;
  try {
    const copilot = await copilotAuthManager.getAuth(identity);
    accessToken = copilot.accessToken;
    const useCache = req.get('x-cache')?.trim().toLowerCase() !== 'false';
    const models = await listModels(copilot, { useCache });
    const visibleModels = claudeCodeOptimized ? models.filter((m) => modelSupportsPath(m, '/v1/messages')) : models;
    recordRequestStat({ identity, path: '/v1/models', success: true });
    if (claudeCodeOptimized) {
      const data = visibleModels.map(toClaudeCodeModel);
      res.json({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
      return;
    }
    res.json({ object: 'list', data: visibleModels.map((m) => ({ object: 'model', owned_by: 'github-copilot', ...m })) });
  } catch (err) {
    invalidateUnauthorizedAuth(identity, accessToken, err);
    recordRequestStat({ identity, path: '/v1/models', success: false, failureReason: errorMessage(err) });
    sendCompatibleError(req, res, err);
  }
});

compatibleRouter.post('/chat/completions', async (req, res) => {
  await handleForward(req, res, '/chat/completions');
});

compatibleRouter.post('/responses', async (req, res) => {
  await handleForward(req, res, '/responses');
});

compatibleRouter.post('/v1/messages/count_tokens', async (req, res) => {
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  if (!claudeCodeOptimized) {
    sendUnsupportedCompatiblePath(req, res, claudeCodeOptimized);
    return;
  }
  await handleCountTokens(req, res, claudeCodeOptimized);
});

compatibleRouter.post('/v1/messages', async (req, res) => {
  await handleForward(req, res, '/v1/messages');
});

compatibleRouter.use('/v1/files', handleFilesApiUnsupported);

function handleFilesApiUnsupported(req: Request, res: Response, next: NextFunction): void {
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  if (!claudeCodeOptimized) {
    next();
    return;
  }
  sendAnthropicError(
    res,
    404,
    'not_supported',
    'The Anthropic Files API is not supported by the GitHub Copilot backend. Disable Claude Code features that require /v1/files or use a separate Anthropic-compatible file service.',
  );
}

async function handleForward(req: Request, res: Response, path: CopilotApiPath): Promise<void> {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  const body = readJsonObject(req.body);
  if (!body) {
    sendOpenAiLikeError(req, res, 400, 'Request body must be a JSON object.', 'invalid_request_error');
    return;
  }
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  try {
    if (!requestedModel) throw new CopilotModelPathError('Request body must include a string "model".');
    const prepared = prepareForward(req, path, body, claudeCodeOptimized);
    if (prepared.preflightError) {
      recordRequestStat({ identity, path, model: requestedModel, success: false, failureReason: prepared.preflightError.message });
      sendAnthropicError(res, prepared.preflightError.status, prepared.preflightError.type, prepared.preflightError.message);
      return;
    }
    const model = typeof prepared.body.model === 'string' ? prepared.body.model : requestedModel;
    const upstream = await forwardAuthenticated(identity, path, prepared.body, model, prepared.forwardOptions);
    await pipeAndRecord(upstream, res, { identity, path, model }, { ...prepared.pipeOptions, requestBody: prepared.body });
  } catch (err) {
    recordRequestStat({ identity, path, model: requestedModel, success: false, failureReason: errorMessage(err) });
    if (!res.headersSent) sendCompatibleError(req, res, err);
    else res.end();
  }
}

async function handleCountTokens(req: Request, res: Response, claudeCodeOptimized: boolean): Promise<void> {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const path: CopilotApiPath = '/v1/messages/count_tokens';
  const body = readJsonObject(req.body);
  if (!body) {
    sendOpenAiLikeError(req, res, 400, 'Request body must be a JSON object.', 'invalid_request_error');
    return;
  }
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  try {
    if (!requestedModel) throw new CopilotModelPathError('Request body must include a string "model".');
    const prepared = prepareForward(req, path, body, claudeCodeOptimized);
    if (prepared.preflightError) {
      recordRequestStat({ identity, path, model: requestedModel, success: false, failureReason: prepared.preflightError.message });
      sendAnthropicError(res, prepared.preflightError.status, prepared.preflightError.type, prepared.preflightError.message);
      return;
    }
    const model = typeof prepared.body.model === 'string' ? prepared.body.model : requestedModel;
    const upstream = await forwardAuthenticated(identity, path, prepared.body, model, prepared.forwardOptions);
    if (isTokenCountFallbackStatus(upstream.status)) {
      await upstream.body?.cancel();
      const inputTokens = estimateInputTokens(prepared.body);
      recordRequestStat({ identity, path, model, success: true, inputTokens });
      res.json({ input_tokens: inputTokens });
      return;
    }
    await pipeAndRecord(upstream, res, { identity, path, model }, { ...prepared.pipeOptions, requestBody: prepared.body });
  } catch (err) {
    recordRequestStat({ identity, path, model: requestedModel, success: false, failureReason: errorMessage(err) });
    if (!res.headersSent) sendCompatibleError(req, res, err);
    else res.end();
  }
}

function prepareForward(
  req: Request,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  claudeCodeOptimized: boolean,
): {
  body: Record<string, unknown>;
  forwardOptions?: ForwardCopilotRequestOptions;
  pipeOptions?: PipeOptions;
  preflightError?: { status: number; type: string; message: string };
} {
  if (!claudeCodeOptimized || !path.startsWith('/v1/messages')) return { body };
  const prepared = prepareClaudeCodeMessagesRequest(req, body, { tokenCounting: path === '/v1/messages/count_tokens' });
  return {
    body: prepared.body,
    forwardOptions: prepared.forwardOptions,
    pipeOptions: { claudeCodeOptimized: true, requestBody: prepared.body },
    preflightError: prepared.preflightError,
  };
}

async function forwardAuthenticated(
  identity: string,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  model: string,
  options?: ForwardCopilotRequestOptions,
): Promise<globalThis.Response> {
  const copilot = await copilotAuthManager.getAuth(identity);
  try {
    await assertModelSupportsPath(copilot, path, model);
  } catch (err) {
    invalidateUnauthorizedAuth(identity, copilot.accessToken, err);
    throw err;
  }
  const upstream = await forwardCopilotRequest(copilot, path, body, options);
  if (upstream.status === 401) {
    copilotAuthManager.invalidate(identity, copilot.accessToken);
  }
  return upstream;
}

async function pipeAndRecord(
  upstream: globalThis.Response,
  res: Response,
  stat: { identity: string; path: CopilotApiPath; model?: string },
  options: PipeOptions = {},
): Promise<void> {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  res.setHeader('content-type', contentType);
  if (!upstream.body) {
    logUpstreamError(stat, upstream.status, contentType, undefined, options.requestBody);
    res.end();
    recordRequestStat({ ...stat, success: upstream.ok, failureReason: upstream.ok ? undefined : `HTTP ${upstream.status}` });
    return;
  }
  if (contentType.includes('application/json')) {
    const text = await upstream.text();
    logUpstreamError(stat, upstream.status, contentType, text, options.requestBody);
    if (options.claudeCodeOptimized && shouldTranslateWebSearchError(upstream.status, text, options.requestBody)) {
      sendAnthropicError(res, 400, 'not_supported', webSearchUnsupportedMessage(options.requestBody));
      recordRequestStat({ ...stat, success: false, failureReason: `HTTP ${upstream.status}` });
      return;
    }
    res.send(text);
    const usage = parseUsage(text);
    recordRequestStat({
      ...stat,
      success: upstream.ok,
      failureReason: upstream.ok ? undefined : `HTTP ${upstream.status}`,
      ...usageStatFields(usage),
    });
    return;
  }
  if (!upstream.ok && contentType.includes('text/event-stream')) {
    const text = await upstream.text();
    logUpstreamError(stat, upstream.status, contentType, text, options.requestBody);
    res.send(text);
    recordRequestStat({ ...stat, success: false, failureReason: `HTTP ${upstream.status}` });
    return;
  }
  if (options.claudeCodeOptimized && !upstream.ok && !contentType.includes('text/event-stream')) {
    const text = await upstream.text();
    logUpstreamError(stat, upstream.status, contentType, text, options.requestBody);
    if (shouldTranslateWebSearchError(upstream.status, text, options.requestBody)) {
      sendAnthropicError(res, 400, 'not_supported', webSearchUnsupportedMessage(options.requestBody));
    } else {
      res.send(text);
    }
    recordRequestStat({ ...stat, success: false, failureReason: `HTTP ${upstream.status}` });
    return;
  }
  const reader = upstream.body.getReader();
  const usage: UsageStats = {};
  const decoder = new TextDecoder();
  let sseBuffer = '';
  const filterCopilotDone = options.claudeCodeOptimized && contentType.includes('text/event-stream');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filterCopilotDone) {
        sseBuffer = forwardSseEvents(sseBuffer + decoder.decode(value, { stream: true }), res, usage);
      } else {
        sseBuffer = collectSseUsage(sseBuffer + decoder.decode(value, { stream: true }), usage);
        res.write(value);
      }
    }
    const remaining = decoder.decode();
    if (filterCopilotDone) {
      if (remaining) sseBuffer = forwardSseEvents(sseBuffer + remaining, res, usage);
      flushSseRemainder(sseBuffer, res, usage);
    } else {
      if (remaining) sseBuffer = collectSseUsage(sseBuffer + remaining, usage);
      collectSseEventUsage(sseBuffer, usage);
    }
  } finally {
    res.end();
    recordRequestStat({
      ...stat,
      success: upstream.ok,
      failureReason: upstream.ok ? undefined : `HTTP ${upstream.status}`,
      ...usageStatFields(usage),
    });
  }
}

interface PipeOptions {
  claudeCodeOptimized?: boolean;
  requestBody?: Record<string, unknown>;
}

function logUpstreamError(
  stat: { identity: string; path: CopilotApiPath; model?: string },
  status: number,
  contentType: string,
  responseBody: string | undefined,
  requestBody: Record<string, unknown> | undefined,
): void {
  if (status < 400) return;
  logger.warn('upstream-error', 'Copilot upstream returned an error response', {
    identity: stat.identity,
    path: stat.path,
    model: stat.model,
    status,
    contentType,
    upstreamRequestBodyBytes: requestBody ? JSON.stringify(requestBody).length : undefined,
    upstreamResponseBodyBytes: responseBody === undefined ? undefined : responseBody.length,
  });
}

function usageStatFields(usage: UsageStats): UsageStats {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheTokens: cacheTokenTotal(usage),
    cacheInputTokens: usage.cacheInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function parseUsage(text: string): UsageStats {
  try {
    const usage: UsageStats = {};
    collectUsageFromValue(JSON.parse(text) as unknown, usage);
    return usage;
  } catch {
    return {};
  }
}

function collectSseUsage(buffer: string, usage: UsageStats): string {
  let remaining = buffer;
  for (;;) {
    const boundary = nextSseEventBoundary(remaining);
    if (!boundary) return remaining;
    collectSseEventUsage(remaining.slice(0, boundary.eventEnd), usage);
    remaining = remaining.slice(boundary.nextEventStart);
  }
}

function forwardSseEvents(buffer: string, res: Response, usage: UsageStats): string {
  let remaining = buffer;
  for (;;) {
    const boundary = nextSseEventBoundary(remaining);
    if (!boundary) return remaining;
    const eventText = remaining.slice(0, boundary.eventEnd);
    collectSseEventUsage(eventText, usage);
    if (!isCopilotDoneEvent(eventText)) res.write(remaining.slice(0, boundary.nextEventStart));
    remaining = remaining.slice(boundary.nextEventStart);
  }
}

function flushSseRemainder(buffer: string, res: Response, usage: UsageStats): void {
  if (!buffer) return;
  collectSseEventUsage(buffer, usage);
  if (!isCopilotDoneEvent(buffer)) res.write(buffer);
}

function nextSseEventBoundary(buffer: string): { eventEnd: number; nextEventStart: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { eventEnd: crlf, nextEventStart: crlf + 4 };
  return { eventEnd: lf, nextEventStart: lf + 2 };
}

function collectSseEventUsage(eventText: string, usage: UsageStats): void {
  const data = sseData(eventText);
  if (!data || data === '[DONE]') return;
  try {
    collectUsageFromValue(JSON.parse(data) as unknown, usage);
  } catch {
    return;
  }
}

function sseData(eventText: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5);
    dataLines.push(data.startsWith(' ') ? data.slice(1) : data);
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

function sseEventName(eventText: string): string | undefined {
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('event:')) continue;
    const eventName = line.slice(6).trim();
    return eventName || undefined;
  }
  return undefined;
}

function isCopilotDoneEvent(eventText: string): boolean {
  const data = sseData(eventText)?.trim();
  if (data !== '[DONE]') return false;
  const eventName = sseEventName(eventText);
  return eventName === undefined || eventName === 'message';
}

function collectUsageFromValue(value: unknown, usage: UsageStats): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUsageFromValue(item, usage);
    return;
  }

  const object = recordField(value);
  if (!object) return;

  const usageObject = recordField(object.usage);
  if (usageObject) mergeUsage(usage, usageFromObject(usageObject));

  const copilotUsage = recordField(object.copilot_usage);
  if (copilotUsage) mergeUsage(usage, usageFromCopilotObject(copilotUsage));

  for (const childValue of Object.values(object)) collectUsageFromValue(childValue, usage);
}

function usageFromObject(usage: Record<string, unknown>): UsageStats {
  const promptDetails = recordField(usage.prompt_tokens_details);
  const inputDetails = recordField(usage.input_tokens_details);
  const cacheInputTokens =
    numberField(usage.cache_read_input_tokens) ??
    numberField(usage.input_cached_tokens) ??
    numberField(promptDetails?.cached_tokens) ??
    numberField(inputDetails?.cached_tokens);
  const cacheWriteTokens =
    numberField(usage.cache_creation_input_tokens) ?? cacheCreationInputTokens(recordField(usage.cache_creation));
  return {
    inputTokens: numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    outputTokens: numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    cacheTokens: numberField(usage.cache_tokens) ?? sumDefined(cacheInputTokens, cacheWriteTokens),
    cacheInputTokens,
    cacheWriteTokens,
  };
}

function usageFromCopilotObject(copilotUsage: Record<string, unknown>): UsageStats {
  const details = Array.isArray(copilotUsage.token_details) ? copilotUsage.token_details : [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheTokens: number | undefined;
  let cacheInputTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

  for (const detail of details) {
    const detailObject = recordField(detail);
    const tokenType = typeof detailObject?.token_type === 'string' ? detailObject.token_type : undefined;
    const tokenCount = numberField(detailObject?.token_count);
    if (!tokenType || tokenCount === undefined) continue;

    if (tokenType === 'input') inputTokens = addDefined(inputTokens, tokenCount);
    else if (tokenType === 'output') outputTokens = addDefined(outputTokens, tokenCount);
    else if (tokenType === 'cache_read') cacheInputTokens = addDefined(cacheInputTokens, tokenCount);
    else if (tokenType === 'cache_write' || tokenType === 'cache_creation') {
      cacheWriteTokens = addDefined(cacheWriteTokens, tokenCount);
    } else if (tokenType.startsWith('cache_')) {
      cacheTokens = addDefined(cacheTokens, tokenCount);
    }
  }

  return { inputTokens, outputTokens, cacheTokens, cacheInputTokens, cacheWriteTokens };
}

function mergeUsage(target: UsageStats, source: UsageStats): void {
  if (source.inputTokens !== undefined) target.inputTokens = source.inputTokens;
  if (source.outputTokens !== undefined) target.outputTokens = source.outputTokens;
  if (source.cacheTokens !== undefined) target.cacheTokens = source.cacheTokens;
  if (source.cacheInputTokens !== undefined) target.cacheInputTokens = source.cacheInputTokens;
  if (source.cacheWriteTokens !== undefined) target.cacheWriteTokens = source.cacheWriteTokens;
}

function addDefined(current: number | undefined, value: number): number {
  return (current ?? 0) + value;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value !== undefined) total = addDefined(total, value);
  }
  return total;
}

function cacheCreationInputTokens(cacheCreation: Record<string, unknown> | undefined): number | undefined {
  if (!cacheCreation) return undefined;
  return sumDefined(
    numberField(cacheCreation.ephemeral_5m_input_tokens),
    numberField(cacheCreation.ephemeral_1h_input_tokens),
  );
}

function cacheTokenTotal(usage: UsageStats): number | undefined {
  return usage.cacheTokens ?? sumDefined(usage.cacheInputTokens, usage.cacheWriteTokens);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readJsonObject(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function requireIdentity(req: Request, res: Response): string | undefined {
  if (req.identity) return req.identity;
  res.status(400).json(apiError('missing_identity', 'Request identity has not been resolved.'));
  return undefined;
}

function requireClaudeCodeOptimized(req: Request, res: Response): boolean | undefined {
  const resolved = resolveClaudeCodeOptimized(req);
  if (resolved.ok) return resolved.enabled;
  sendOpenAiLikeError(req, res, 400, resolved.message, 'invalid_request_error');
  return undefined;
}

function sendCompatibleError(req: Request, res: Response, err: unknown): void {
  if (err instanceof CopilotAuthNotReadyError) {
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  const status = proxyErrorStatus(err);
  sendOpenAiLikeError(req, res, status, errorMessage(err), proxyErrorType(err));
}

function sendOpenAiLikeError(req: Request, res: Response, status: number, message: string, type = 'api_error'): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(status).json({ type: 'error', error: { type, message } });
    return;
  }
  res.status(status).json({ error: { message, type } });
}

function sendAnthropicError(res: Response, status: number, type: string, message: string): void {
  res.status(status).type('application/json').json({ type: 'error', error: { type, message } });
}

function sendUnsupportedCompatiblePath(req: Request, res: Response, claudeCodeOptimized: boolean): void {
  const message =
    `Unsupported Copilot API path: ${req.originalUrl}. ` +
    supportedPathsMessage(claudeCodeOptimized);
  sendOpenAiLikeError(req, res, 404, message, 'invalid_request_error');
}

function supportedPathsMessage(claudeCodeOptimized: boolean): string {
  const paths = ['GET /v1/models', 'POST /chat/completions', 'POST /v1/messages', 'POST /responses'];
  if (claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  return `Supported paths: ${paths.join(', ')}.`;
}

function toClaudeCodeModel(model: ModelInfo): Record<string, unknown> {
  const capabilities = recordField(model.capabilities);
  const limits = recordField(capabilities?.limits);
  return {
    type: 'model',
    id: model.id,
    display_name: stringField(model.name) ?? model.id,
    created_at: '1970-01-01T00:00:00Z',
    max_input_tokens: numberField(limits?.max_context_window_tokens),
    max_tokens: numberField(limits?.max_output_tokens),
  };
}

function proxyErrorStatus(err: unknown): number {
  if (err instanceof CopilotModelPathError) return err.status;
  if (err instanceof CopilotApiError && (err.status === 401 || err.status === 403)) return err.status;
  return 502;
}

function proxyErrorType(err: unknown): string {
  return err instanceof CopilotModelPathError ? 'invalid_request_error' : 'api_error';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalidateUnauthorizedAuth(identity: string, accessToken: string | undefined, err: unknown): void {
  if (accessToken && err instanceof CopilotApiError && err.status === 401) {
    copilotAuthManager.invalidate(identity, accessToken);
  }
}
