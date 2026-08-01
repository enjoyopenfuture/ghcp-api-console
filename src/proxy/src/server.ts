import express, { type NextFunction, type Request, type Response } from 'express';
import { shouldRedact } from '@ghcp/shared';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { pruneAllRequestStats } from './db/requestStatsRepo.js';
import { requireApiKey } from './auth/apiKey.js';
import { requireIdentityHeader } from './auth/identityHeader.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { Logger } from './logger.js';
import { compatibleRouter } from './routes/compatible.js';
import { resolveClaudeCodeOptimized } from './routes/claudeCodeMode.js';
import { adminApiRouter } from './routes/adminApi.js';
import { internalApiRouter } from './routes/internalApi.js';

const requestLogger = new Logger('request');

export function buildApp(): express.Express {
  const app = express();
  app.use(logRequestHeaders);
  app.use(captureRawRequestBody);
  app.use(express.json({ limit: '20mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'proxy' });
  });
  app.use('/api', requireInternalToken, adminApiRouter);
  app.use('/internal', requireInternalToken, internalApiRouter);
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
  return app;
}

export function captureRawRequestBody(req: Request, _res: Response, next: NextFunction): void {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  req.on('data', (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(Buffer.from(buffer));
    byteLength += buffer.byteLength;
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks, byteLength);
  });
  next();
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
  return `Supported paths: ${paths.join(', ')}.`;
}

function sendInvalidRequestError(req: Request, res: Response, message: string): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message } });
    return;
  }
  res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

export function startServer(): void {
  getDb();
  pruneAllRequestStats();
  buildApp().listen(config.port, () => {
    console.log(`[proxy] listening on http://localhost:${config.port}`);
  });
}
