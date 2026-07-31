import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
  redactSensitiveValue,
  shouldRedact,
  type HttpHeaderPair,
  type ProxyErrorDiagnosticBodyDto,
  type ProxyErrorDiagnosticFailureKind,
  type ProxyErrorDiagnosticRecordDto,
  type ProxyErrorDiagnosticRequestDto,
  type ProxyErrorDiagnosticResponseDto,
  type ProxyRequestStatDto,
} from '@ghcp/shared';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import { ErrorDiagnosticsStore } from './errorDiagnosticsStore.js';

const RESPONSE_CAPTURE_LIMIT = 20 * 1024 * 1024;
const logger = new Logger('error-diagnostics');

export const errorDiagnosticsStore = new ErrorDiagnosticsStore({
  enabled: config.errorDiagnosticsEnabled,
  directory: config.errorDiagnosticsDir,
  redacted: config.errorDiagnosticsRedact,
  maxFileBytes: config.errorDiagnosticsMaxFileBytes,
  maxFiles: config.errorDiagnosticsMaxFiles,
});

export interface ErrorDiagnosticContext {
  identity: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  inboundRequest: {
    method: string;
    url: string;
    rawHeaders: string[];
    body?: Buffer;
  };
}

export interface PreparedUpstreamRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export class DiagnosticBodyCapture {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private observedBytes = 0;

  add(value: Uint8Array): void {
    this.observedBytes += value.byteLength;
    const remaining = RESPONSE_CAPTURE_LIMIT - this.capturedBytes;
    if (remaining <= 0) return;
    const chunk = Buffer.from(value);
    const captured = chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(captured));
    this.capturedBytes += captured.byteLength;
  }

  result(complete: boolean): CapturedResponseBody {
    return {
      buffer: Buffer.concat(this.chunks, this.capturedBytes),
      byteLength: this.observedBytes,
      complete,
      truncated: this.observedBytes > this.capturedBytes,
    };
  }
}

export interface CapturedResponseBody {
  buffer: Buffer;
  byteLength: number;
  complete: boolean;
  truncated: boolean;
}

export function createErrorDiagnosticContext(
  req: Request,
  identity: string,
  path: ProxyRequestStatDto['path'],
  model?: string,
): ErrorDiagnosticContext {
  return {
    identity,
    path,
    model,
    inboundRequest: {
      method: req.method,
      url: req.originalUrl,
      rawHeaders: [...req.rawHeaders],
      body: req.rawBody ? Buffer.from(req.rawBody) : undefined,
    },
  };
}

export async function recordHttpFailure(
  context: ErrorDiagnosticContext,
  request: PreparedUpstreamRequest,
  response: Response,
  body?: CapturedResponseBody,
): Promise<string> {
  const diagnosticId = await persistRecord('http', context, request, response, body);
  const fields = failureLogFields(diagnosticId, context, request, response.status, body);
  if (response.status >= 500) {
    logger.error('upstream-http-error', 'Copilot upstream returned an error response', fields);
  } else {
    logger.warn('upstream-http-error', 'Copilot upstream returned an error response', fields);
  }
  return diagnosticId;
}

export async function recordFetchFailure(
  context: ErrorDiagnosticContext,
  request: PreparedUpstreamRequest,
  err: unknown,
): Promise<string> {
  const diagnosticId = await persistRecord('fetch', context, request, undefined, undefined, err);
  logger.error('upstream-fetch-failed', 'Copilot upstream request failed before receiving a response', {
    diagnosticId,
    identity: context.identity,
    path: context.path,
    model: context.model,
    upstreamUrl: request.url,
    error: errorMessage(err),
  });
  return diagnosticId;
}

export async function recordStreamFailure(
  context: ErrorDiagnosticContext,
  request: PreparedUpstreamRequest,
  response: Response,
  body: CapturedResponseBody,
  err: unknown,
): Promise<string> {
  const diagnosticId = await persistRecord('stream', context, request, response, body, err);
  logger.error('upstream-stream-failed', 'Copilot upstream response stream failed', {
    ...failureLogFields(diagnosticId, context, request, response.status, body),
    error: errorMessage(err),
  });
  return diagnosticId;
}

async function persistRecord(
  failureKind: ProxyErrorDiagnosticFailureKind,
  context: ErrorDiagnosticContext,
  request: PreparedUpstreamRequest,
  response?: Response,
  responseBody?: CapturedResponseBody,
  err?: unknown,
): Promise<string> {
  const id = randomUUID();
  if (!errorDiagnosticsStore.options.enabled) return id;
  const record: ProxyErrorDiagnosticRecordDto = {
    id,
    timestamp: new Date().toISOString(),
    failureKind,
    identity: context.identity,
    path: context.path,
    model: context.model,
    redacted: config.errorDiagnosticsRedact,
    inboundRequest: requestDto(
      context.inboundRequest.method,
      context.inboundRequest.url,
      rawHeadersToPairs(context.inboundRequest.rawHeaders),
      context.inboundRequest.body,
    ),
    upstreamRequest: requestDto(
      request.method,
      request.url,
      Object.entries(request.headers).map(([name, value]) => ({ name, value })),
      request.body === undefined ? undefined : Buffer.from(request.body),
    ),
    upstreamResponse: response ? responseDto(response, responseBody) : undefined,
    error: err ? thrownErrorDto(err) : undefined,
  };
  try {
    await errorDiagnosticsStore.append(record);
  } catch (storeError) {
    logger.error('diagnostic-persistence-failed', 'Failed to persist Copilot upstream error diagnostic', {
      diagnosticId: id,
      error: errorMessage(storeError),
    });
  }
  return id;
}

function requestDto(
  method: string,
  url: string,
  headers: HttpHeaderPair[],
  body?: Buffer,
): ProxyErrorDiagnosticRequestDto {
  const contentType = headerValue(headers, 'content-type');
  const contentEncoding = headerValue(headers, 'content-encoding');
  return {
    method,
    url,
    headers: diagnosticHeaders(headers),
    body: body === undefined ? undefined : bodyDto({
      buffer: body,
      byteLength: body.byteLength,
      complete: true,
      truncated: false,
    }, contentType, contentEncoding),
  };
}

function responseDto(response: Response, body?: CapturedResponseBody): ProxyErrorDiagnosticResponseDto {
  const headers = [...response.headers.entries()].map(([name, value]) => ({ name, value }));
  return {
    status: response.status,
    statusText: response.statusText,
    headers: diagnosticHeaders(headers),
    body: body ? bodyDto(body, response.headers.get('content-type') ?? undefined) : undefined,
  };
}

function bodyDto(
  body: CapturedResponseBody,
  contentType?: string,
  contentEncoding?: string,
): ProxyErrorDiagnosticBodyDto {
  if (!config.errorDiagnosticsRedact) {
    const textual = isTextContentType(contentType) && !isEncodedContent(contentEncoding);
    return {
      encoding: textual ? 'utf8' : 'base64',
      data: body.buffer.toString(textual ? 'utf8' : 'base64'),
      byteLength: body.byteLength,
      capturedByteLength: body.buffer.byteLength,
      truncated: body.truncated,
      complete: body.complete,
    };
  }
  if (!body.complete || body.truncated) {
    return unavailableBody(body, 'Body unavailable because incomplete or truncated content cannot be safely redacted.');
  }
  if (!isJsonContentType(contentType)) {
    return unavailableBody(body, 'Body unavailable because non-JSON content cannot be safely redacted.');
  }
  try {
    const redacted = JSON.stringify(redactSensitiveValue(JSON.parse(body.buffer.toString('utf8'))));
    return {
      encoding: 'utf8',
      data: redacted,
      byteLength: body.byteLength,
      capturedByteLength: Buffer.byteLength(redacted),
      truncated: false,
      complete: true,
    };
  } catch {
    return unavailableBody(body, 'Body unavailable because JSON content could not be safely parsed for redaction.');
  }
}

function unavailableBody(body: CapturedResponseBody, unavailableReason: string): ProxyErrorDiagnosticBodyDto {
  return {
    encoding: 'unavailable',
    byteLength: body.byteLength,
    capturedByteLength: 0,
    truncated: body.truncated,
    complete: body.complete,
    unavailableReason,
  };
}

function diagnosticHeaders(headers: HttpHeaderPair[]): HttpHeaderPair[] {
  if (!config.errorDiagnosticsRedact) return headers.map((header) => ({ ...header }));
  return headers.map((header) => ({
    name: header.name,
    value: isSensitiveHeader(header.name) ? '<redacted>' : header.value,
  }));
}

function rawHeadersToPairs(rawHeaders: string[]): HttpHeaderPair[] {
  const pairs: HttpHeaderPair[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    pairs.push({ name: rawHeaders[index] ?? '', value: rawHeaders[index + 1] ?? '' });
  }
  return pairs;
}

function isSensitiveHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return shouldRedact(normalized) || normalized === 'x-api-key' || normalized === 'api-key' || normalized === 'apikey';
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes('json') ?? false;
}

function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript')
    || normalized.includes('x-www-form-urlencoded');
}

function isEncodedContent(contentEncoding: string | undefined): boolean {
  const normalized = contentEncoding?.trim().toLowerCase();
  return Boolean(normalized && normalized !== 'identity');
}

function headerValue(headers: HttpHeaderPair[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function thrownErrorDto(err: unknown): NonNullable<ProxyErrorDiagnosticRecordDto['error']> {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    cause: err.cause === undefined ? undefined : errorMessage(err.cause),
  };
}

function failureLogFields(
  diagnosticId: string,
  context: ErrorDiagnosticContext,
  request: PreparedUpstreamRequest,
  status: number,
  body?: CapturedResponseBody,
): Record<string, unknown> {
  return {
    diagnosticId,
    identity: context.identity,
    path: context.path,
    model: context.model,
    status,
    upstreamUrl: request.url,
    upstreamRequestBodyBytes: request.body === undefined ? 0 : Buffer.byteLength(request.body),
    upstreamResponseBodyBytes: body?.byteLength ?? 0,
    upstreamResponseBodyTruncated: body?.truncated ?? false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
