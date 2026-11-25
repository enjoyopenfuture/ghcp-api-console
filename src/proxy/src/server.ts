import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { shouldRedact, managementErrorHandler } from '@ghcp/shared';
import { config } from './config.js';
import { closeStorage, initializeStorage, pingStorage } from './db/connection.js';
import { pruneAllRequestStats } from './db/requestStatsRepo.js';
import { requireApiKey } from './auth/apiKey.js';
import { requireIdentityHeader } from './auth/identityHeader.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { Logger } from './logger.js';
import { compatibleRouter } from './routes/compatible.js';
import { resolveClaudeCodeOptimized } from './routes/claudeCodeMode.js';
import { adminApiRouter } from './routes/adminApi.js';
import { internalApiRouter } from './routes/internalApi.js';
import { accountOperationsRouter } from './routes/operationsApi.js';

const requestLogger = new Logger('request');
const MIB = 1024 * 1024;
// Mirrors the mount paths of the management routers, whose own error handlers answer body errors.
const MANAGEMENT_PATH = /^\/(?:api|internal)(?:\/|$)/i;

export function buildApp(): express.Express {
  const app = express();
  app.use(logRequestHeaders);
  app.use(captureRawRequestBody);
  app.use(express.json({ limit: config.maxRequestBodyBytes }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'proxy' });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await pingStorage();
      res.json({ status: 'ok', service: 'proxy', storage: config.storageDriver });
    } catch (err) {
      requestLogger.error('readiness-failed', 'Proxy storage readiness check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ status: 'unavailable', service: 'proxy' });
    }
  });
  app.use('/api/accounts/operations', requireInternalToken, accountOperationsRouter, managementErrorHandler('proxy'));
  app.use('/api', requireInternalToken, adminApiRouter, managementErrorHandler('proxy'));
  app.use('/internal', requireInternalToken, internalApiRouter, managementErrorHandler('proxy'));
  app.use(requireApiKey, requireIdentityHeader, compatibleRouter);
  app.use((req, res) => {
    const claudeCodeOptimized = resolveClaudeCodeOptimized(req);
    if (!claudeCodeOptimized.ok) {
      sendInvalidRequestError(req, res, claudeCodeOptimized.message);
      return;
    }
    const message =
      `Unsupported Copilot API path: ${req.originalUrl}. ` +
      supportedPathsMessage(claudeCodeOptimized.enabled);
    if (req.path.startsWith('/v1/messages')) {
      res.status(404).json({ type: 'error', error: { type: 'invalid_request_error', message } });
      return;
    }
    res.status(404).json({ error: { message, type: 'invalid_request_error' } });
  });
  app.use(handleRequestBodyError);
  return app;
}

export function captureRawRequestBody(req: Request, _res: Response, next: NextFunction): void {
  // Upload bodies are parsed by a route-level raw parser; an early 'data' listener would start the
  // stream flowing before that parser attaches and double the memory held per request.
  if (req.is('application/octet-stream')) {
    next();
    return;
  }
  let chunks: Buffer[] | undefined = [];
  let byteLength = 0;
  req.on('data', (chunk: Buffer | Uint8Array | string) => {
    if (!chunks) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    // body-parser drains oversized bodies before answering 413, so stop buffering past the limit.
    if (byteLength > config.maxRequestBodyBytes) {
      chunks = undefined;
      return;
    }
    chunks.push(buffer);
  });
  req.on('end', () => {
    if (chunks) req.rawBody = Buffer.concat(chunks, byteLength);
  });
  next();
}

function handleRequestBodyError(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const bodyError = readRequestBodyError(err);
  if (!bodyError || res.headersSent || MANAGEMENT_PATH.test(req.path)) {
    next(err);
    return;
  }
  const message = requestBodyErrorMessage(bodyError);
  const tooLarge = bodyError.status === 413;
  requestLogger.warn('request-body-rejected', 'Rejected inbound request body', {
    method: req.method,
    path: req.path,
    status: bodyError.status,
    type: bodyError.type,
    message,
  });
  if (req.path.startsWith('/v1/messages')) {
    res.status(bodyError.status).json({
      type: 'error',
      error: { type: tooLarge ? 'request_too_large' : 'invalid_request_error', message },
    });
    return;
  }
  res.status(bodyError.status).json({
    error: { message, type: 'invalid_request_error', ...(tooLarge ? { code: 'request_too_large' } : {}) },
  });
}

interface RequestBodyError {
  type: string;
  status: number;
  message: string;
  limit?: number;
}

/** Recognizes body-parser style client errors such as entity.too.large or entity.parse.failed. */
function readRequestBodyError(err: unknown): RequestBodyError | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const { type, status, statusCode, message, limit } = err as Record<string, unknown>;
  const code = typeof status === 'number' ? status : statusCode;
  if (typeof type !== 'string' || typeof code !== 'number' || !Number.isInteger(code) || code < 400 || code > 499) {
    return undefined;
  }
  return {
    type,
    status: code,
    message: typeof message === 'string' ? message : 'Invalid request body.',
    limit: typeof limit === 'number' ? limit : undefined,
  };
}

function requestBodyErrorMessage(error: RequestBodyError): string {
  if (error.status === 413) {
    const limitMib = Number(((error.limit ?? config.maxRequestBodyBytes) / MIB).toFixed(2));
    return `Request body exceeds the proxy limit of ${limitMib} MiB.`;
  }
  if (error.type === 'entity.parse.failed') return 'Request body is not valid JSON.';
  return error.message;
}

function logRequestHeaders(req: Request, _res: Response, next: NextFunction): void {
  requestLogger.debug('request-headers', 'Received proxy request headers', {
    method: req.method,
    path: req.originalUrl,
    identityHeader: config.identityHeader,
    rawHeaders: redactRawHeaders(req.rawHeaders),
  });
  next();
}

function redactRawHeaders(rawHeaders: string[]): string[] {
  return rawHeaders.map((value, index) => {
    if (index % 2 === 0) return value;
    const headerName = rawHeaders[index - 1] ?? '';
    return shouldRedactHeader(headerName) ? '<redacted>' : value;
  });
}

function shouldRedactHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return shouldRedact(normalized) || normalized === 'x-api-key' || normalized === 'api-key' || normalized === 'apikey';
}

function supportedPathsMessage(claudeCodeOptimized: boolean): string {
  const paths = ['GET /v1/models', 'POST /chat/completions', 'POST /v1/messages', 'POST /responses'];
  if (claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  if (config.imageUploadMode !== 'off') paths.push('POST /copilot/chat/attachments');
  return `Supported paths: ${paths.join(', ')}.`;
}

function sendInvalidRequestError(req: Request, res: Response, message: string): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message } });
    return;
  }
  res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

export async function startServer(): Promise<Server> {
  let server: Server;
  try {
    await initializeStorage();
    await pruneAllRequestStats();
    server = await new Promise<Server>((resolve, reject) => {
      const listening = buildApp().listen(config.port, () => {
        console.log(`[proxy] listening on http://localhost:${config.port}`);
        resolve(listening);
      });
      listening.once('error', reject);
    });
  } catch (err) {
    try {
      await closeStorage();
    } catch (closeError) {
      throw new AggregateError([err, closeError], 'Proxy startup and storage cleanup both failed.');
    }
    throw err;
  }
  const shutdown = () => {
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
    }, 25_000);
    forceCloseTimer.unref();
    server.close((serverError) => {
      clearTimeout(forceCloseTimer);
      void closeStorage()
        .catch((storageError: unknown) => {
          console.error('[proxy] failed to close storage', storageError);
          process.exitCode = 1;
        })
        .finally(() => {
          if (serverError) {
            console.error('[proxy] failed to close HTTP server', serverError);
            process.exitCode = 1;
          }
        });
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
