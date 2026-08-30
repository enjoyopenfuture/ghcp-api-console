import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { INTERNAL_AUTH_HEADER } from '@ghcp/shared';
import { config } from '../config.js';
import { listModels, prepareCopilotRequest } from '../copilot/copilotClient.js';
import { listRequestStats } from '../db/requestStatsRepo.js';
import { pipeAndRecord, recordTokenCountFallbackFailure } from '../routes/compatible.js';
import { buildApp, captureRawRequestBody } from '../server.js';
import {
  DiagnosticBodyCapture,
  createErrorDiagnosticContext,
  errorDiagnosticsStore,
  recordHttpFailure,
} from './errorDiagnostics.js';

test('writes readable headers, pretty JSON bodies, and curl commands without base64 for text', async () => {
  await withDiagnosticsStore(false, async () => {
    const rawBody = Buffer.from('{"model":"gpt-5","input":"original","token":"inbound-value"}');
    const request = fakeRequest(rawBody, [
      'Host', 'localhost:3000',
      'Content-Type', 'application/json',
      'X-Duplicate', 'first',
      'x-duplicate', 'second',
      'Authorization', 'Bearer inbound-value',
    ]);
    const context = createErrorDiagnosticContext(request, 'alice', '/responses', 'gpt-5');
    const prepared = prepareCopilotRequest(
      { identity: 'alice', accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/responses',
      { model: 'gpt-5', input: 'transformed', stream: false },
      { initiator: 'agent', interactionType: 'diagnostic-test' },
    );
    const responseBody = Buffer.from('{"error":{"message":"rate limited"}}');
    const capture = new DiagnosticBodyCapture();
    capture.add(responseBody);

    const diagnosticId = await recordHttpFailure(
      context,
      prepared,
      new Response(responseBody, { status: 429, headers: { 'Content-Type': 'application/json' } }),
      capture.result(true),
    );
    const stored = await errorDiagnosticsStore.get(diagnosticId);

    assert.ok(stored);
    assert.match(stored.content, /## Inbound request/);
    assert.match(stored.content, /Content-Type: application\/json/);
    assert.match(stored.content, /X-Duplicate: first/);
    assert.match(stored.content, /x-duplicate: second/);
    assert.match(stored.content, /"input": "original"/);
    assert.match(stored.content, /## Actual upstream request/);
    assert.ok(stored.content.includes(`Authorization: ${prepared.headers.Authorization}`));
    assert.match(stored.content, /X-Request-Id: [0-9a-f-]{36}/);
    assert.match(stored.content, /"input": "transformed"/);
    assert.match(stored.content, /"message": "rate limited"/);
    assert.match(stored.content, /curl 'http:\/\/localhost:3000\/responses\?source=test'/);
    assert.match(stored.content, /curl 'https:\/\/api\.githubcopilot\.com\/responses'/);
    assert.doesNotMatch(stored.content, new RegExp(rawBody.toString('base64')));
    assert.equal(stored.redacted, false);
  });
});

test('captures compressed inbound request bytes before Express inflates JSON', async () => {
  const originalBody = Buffer.from('{"model":"gpt-5","input":"compressed"}');
  const compressedBody = gzipSync(originalBody);
  const app = express();
  app.use(captureRawRequestBody);
  app.use(express.json({ limit: '20mb' }));
  app.post('/capture', (req, res) => {
    res.json({
      parsed: req.body,
      rawBody: req.rawBody?.toString('base64'),
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolveReady) => server.once('listening', resolveReady));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: compressedBody,
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { parsed: unknown; rawBody: string };
    assert.deepEqual(result.parsed, JSON.parse(originalBody.toString()));
    assert.deepEqual(Buffer.from(result.rawBody, 'base64'), compressedBody);
  } finally {
    await closeServer(server);
  }
});

test('bounds diagnostic response capture and reports truncation metadata', () => {
  const capture = new DiagnosticBodyCapture();
  capture.add(Buffer.alloc(20 * 1024 * 1024 + 17, 1));
  const result = capture.result(true);
  assert.equal(result.byteLength, 20 * 1024 * 1024 + 17);
  assert.equal(result.buffer.byteLength, 20 * 1024 * 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, true);
});

test('redacts sensitive JSON and headers in the readable log', async () => {
  await withDiagnosticsStore(true, async () => {
    const request = fakeRequest(
      Buffer.from('{"password":"secret-value","nested":{"accessToken":"nested-value","safe":"visible"}}'),
      ['Content-Type', 'application/json', 'Authorization', 'Bearer inbound-value'],
    );
    const context = createErrorDiagnosticContext(request, 'alice', '/responses', 'gpt-5');
    const prepared = prepareCopilotRequest(
      { identity: 'alice', accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/responses',
      { model: 'gpt-5', apiToken: 'body-value', nested: { cookie: 'cookie-value', safe: 'visible' } },
    );
    const responseBody = Buffer.from('plain text containing private content');
    const capture = new DiagnosticBodyCapture();
    capture.add(responseBody);
    const diagnosticId = await recordHttpFailure(
      context,
      prepared,
      new Response(responseBody, { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      capture.result(true),
    );
    const stored = await errorDiagnosticsStore.get(diagnosticId);

    assert.ok(stored);
    assert.match(stored.content, /Authorization: <redacted>/);
    assert.match(stored.content, /"password": "<redacted>"/);
    assert.match(stored.content, /"accessToken": "<redacted>"/);
    assert.match(stored.content, /"apiToken": "<redacted>"/);
    assert.match(stored.content, /"cookie": "<redacted>"/);
    assert.doesNotMatch(stored.content, /secret-value|nested-value|body-value|cookie-value/);
    assert.match(stored.content, /Body unavailable because non-JSON content cannot be safely redacted/);
    assert.equal(stored.redacted, true);
  });
});

test('admin API lists, reads, downloads, clears, and reports disabled diagnostics', async () => {
  await withDiagnosticsStore(false, async () => {
    const originalToken = config.internalApiToken;
    config.internalApiToken = `diagnostics-test-${randomUUID()}`;
    const context = createErrorDiagnosticContext(fakeRequest(Buffer.from('{}')), 'admin-test', '/responses', 'gpt-5');
    const prepared = prepareCopilotRequest(
      { identity: 'admin-test', accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/responses',
      { model: 'gpt-5' },
    );
    const diagnosticId = await recordHttpFailure(context, prepared, new Response(null, { status: 503 }));
    const server = buildApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolveReady) => server.once('listening', resolveReady));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { [INTERNAL_AUTH_HEADER]: config.internalApiToken };

    try {
      const listResponse = await fetch(`${baseUrl}/api/error-diagnostics`, { headers });
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json() as { enabled: boolean; total: number };
      assert.equal(list.enabled, true);
      assert.equal(list.total, 1);

      const detailResponse = await fetch(`${baseUrl}/api/error-diagnostics/${diagnosticId}`, { headers });
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json() as { id: string; content: string };
      assert.equal(detail.id, diagnosticId);
      assert.match(detail.content, /## Inbound request/);

      const downloadResponse = await fetch(`${baseUrl}/api/error-diagnostics/${diagnosticId}/download`, { headers });
      assert.equal(downloadResponse.status, 200);
      assert.match(downloadResponse.headers.get('content-type') ?? '', /^text\/plain/);
      assert.match(downloadResponse.headers.get('content-disposition') ?? '', new RegExp(`${diagnosticId}\\.log`));
      assert.match(await downloadResponse.text(), /## Actual upstream request/);

      assert.equal((await fetch(`${baseUrl}/api/error-diagnostics/not-an-id`, { headers })).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/error-diagnostics`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })).status, 200);
      assert.equal((await errorDiagnosticsStore.list()).total, 0);

      errorDiagnosticsStore.options.enabled = false;
      const disabledList = await fetch(`${baseUrl}/api/error-diagnostics`, { headers });
      assert.equal((await disabledList.json() as { enabled: boolean }).enabled, false);
      assert.equal((await fetch(`${baseUrl}/api/error-diagnostics/${diagnosticId}`, { headers })).status, 503);
    } finally {
      await closeServer(server);
      config.internalApiToken = originalToken;
    }
  });
});

test('records model-list HTTP, fetch, and response-stream failures', async () => {
  await withDiagnosticsStore(false, async () => {
    const originalFetch = globalThis.fetch;
    const request = fakeRequest(Buffer.alloc(0), ['Accept', 'application/json']);
    try {
      globalThis.fetch = async () => new Response('upstream unavailable', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
      await assert.rejects(listModels(
        { identity: `http-${randomUUID()}`, accessToken: 'value', api: 'https://api.githubcopilot.com' },
        { useCache: false, diagnostics: createErrorDiagnosticContext(request, 'http-user', '/v1/models') },
      ), /HTTP 500/);

      globalThis.fetch = async () => {
        throw new Error('network unavailable');
      };
      await assert.rejects(listModels(
        { identity: `fetch-${randomUUID()}`, accessToken: 'value', api: 'https://api.githubcopilot.com' },
        { useCache: false, diagnostics: createErrorDiagnosticContext(request, 'fetch-user', '/v1/models') },
      ), /network unavailable/);

      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('{"data":'));
          controller.error(new Error('stream interrupted'));
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      await assert.rejects(listModels(
        { identity: `stream-${randomUUID()}`, accessToken: 'value', api: 'https://api.githubcopilot.com' },
        { useCache: false, diagnostics: createErrorDiagnosticContext(request, 'stream-user', '/v1/models') },
      ), /stream interrupted/);

      const listed = await errorDiagnosticsStore.list(1, 10);
      assert.deepEqual(new Set(listed.items.map((item) => item.failureKind)), new Set(['http', 'fetch', 'stream']));
      const streamSummary = listed.items.find((item) => item.failureKind === 'stream');
      assert.ok(streamSummary);
      const streamRecord = await errorDiagnosticsStore.get(streamSummary.id);
      assert.match(streamRecord?.content ?? '', /complete=false/);
      assert.match(streamRecord?.content ?? '', /Message: stream interrupted/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('records an upstream response-stream read failure as a failed request stat', async () => {
  await withDiagnosticsStore(false, async () => {
    const identity = `stream-stat-${randomUUID()}`;
    const context = createErrorDiagnosticContext(fakeRequest(Buffer.from('{"model":"gpt-5"}')), identity, '/responses', 'gpt-5');
    const prepared = prepareCopilotRequest(
      { identity, accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/responses',
      { model: 'gpt-5', stream: true },
    );
    let delivered = false;
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(Buffer.from('data: {"type":"partial"}\n\n'));
          return;
        }
        controller.error(new Error('stream read failed'));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    await assert.rejects(
      pipeAndRecord(upstream, prepared, fakeResponse(), { identity, path: '/responses', model: 'gpt-5' }, context),
      /stream read failed/,
    );
    const stats = await listRequestStats(identity, 10);
    assert.equal(stats.length, 1);
    assert.equal(stats[0]?.success, false);
    assert.match(stats[0]?.failureReason ?? '', /Upstream stream failed/);
    assert.equal((await errorDiagnosticsStore.list()).items[0]?.failureKind, 'stream');
  });
});

test('persists JSON, SSE, plain-text, and bodyless upstream HTTP failures', async () => {
  await withDiagnosticsStore(false, async () => {
    const identity = `http-shapes-${randomUUID()}`;
    const context = createErrorDiagnosticContext(fakeRequest(Buffer.from('{"model":"gpt-5"}')), identity, '/responses', 'gpt-5');
    const prepared = prepareCopilotRequest(
      { identity, accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/responses',
      { model: 'gpt-5' },
    );
    const responses = [
      new Response('{"error":"bad request"}', { status: 400, headers: { 'Content-Type': 'application/json' } }),
      new Response('event: error\ndata: {"error":"limited"}\n\n', { status: 429, headers: { 'Content-Type': 'text/event-stream' } }),
      new Response('gateway unavailable', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
      new Response(null, { status: 503 }),
    ];
    for (const response of responses) {
      await pipeAndRecord(response, prepared, fakeResponse(), { identity, path: '/responses', model: 'gpt-5' }, context);
    }
    const listed = await errorDiagnosticsStore.list(1, 10);
    assert.equal(listed.total, 4);
    assert.deepEqual(new Set(listed.items.map((item) => item.status)), new Set([400, 429, 502, 503]));
    assert.equal((await listRequestStats(identity, 10)).filter((stat) => !stat.success).length, 4);
  });
});

test('persists token-count fallback upstream errors before returning a local estimate', async () => {
  await withDiagnosticsStore(false, async () => {
    const context = createErrorDiagnosticContext(
      fakeRequest(Buffer.from('{"model":"claude-sonnet"}')),
      `token-count-${randomUUID()}`,
      '/v1/messages/count_tokens',
      'claude-sonnet',
    );
    const prepared = prepareCopilotRequest(
      { identity: context.identity, accessToken: 'upstream-value', api: 'https://api.githubcopilot.com' },
      '/v1/messages/count_tokens',
      { model: 'claude-sonnet' },
    );
    await recordTokenCountFallbackFailure(
      new Response('{"error":"not implemented"}', {
        status: 501,
        headers: { 'Content-Type': 'application/json' },
      }),
      prepared,
      context,
    );

    const listed = await errorDiagnosticsStore.list();
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]?.status, 501);
    const stored = await errorDiagnosticsStore.get(listed.items[0]!.id);
    assert.match(stored?.content ?? '', /"error": "not implemented"/);
  });
});

async function withDiagnosticsStore(redacted: boolean, run: () => Promise<void>): Promise<void> {
  const original = {
    enabled: errorDiagnosticsStore.options.enabled,
    directory: errorDiagnosticsStore.options.directory,
    redacted: errorDiagnosticsStore.options.redacted,
    maxFileBytes: errorDiagnosticsStore.options.maxFileBytes,
    maxFiles: errorDiagnosticsStore.options.maxFiles,
    configRedacted: config.errorDiagnosticsRedact,
  };
  const directory = join(resolve(process.cwd(), 'data', 'error-diagnostics-tests'), randomUUID());
  Object.assign(errorDiagnosticsStore.options, {
    enabled: true,
    directory,
    redacted,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
  });
  config.errorDiagnosticsRedact = redacted;
  try {
    await run();
  } finally {
    await rm(directory, { recursive: true, force: true });
    Object.assign(errorDiagnosticsStore.options, {
      enabled: original.enabled,
      directory: original.directory,
      redacted: original.redacted,
      maxFileBytes: original.maxFileBytes,
      maxFiles: original.maxFiles,
    });
    config.errorDiagnosticsRedact = original.configRedacted;
  }
}

function fakeRequest(rawBody: Buffer, rawHeaders = ['Content-Type', 'application/json']): Request {
  return {
    method: 'POST',
    originalUrl: '/responses?source=test',
    rawHeaders,
    rawBody,
  } as unknown as Request;
}

function fakeResponse(): ExpressResponse {
  let headersSent = false;
  const response = {
    status: () => response,
    setHeader: () => response,
    write: () => {
      headersSent = true;
      return true;
    },
    send: () => {
      headersSent = true;
      return response;
    },
    end: () => {
      headersSent = true;
      return response;
    },
    json: () => {
      headersSent = true;
      return response;
    },
    type: () => response,
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return false;
    },
  };
  return response as unknown as ExpressResponse;
}

function closeServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((err) => err ? reject(err) : resolveClosed());
  });
}
