import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { request } from 'node:http';
import { config } from './config.js';
import { serviceProxy } from './apiProxy.js';

test('preserves attachment content type, disposition, and bytes', async () => {
  const payload = Buffer.from('{"id":"diagnostic-id"}\n');
  const upstreamApp = express();
  upstreamApp.get('/api/error-diagnostics/diagnostic-id/download', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="proxy-error-diagnostic-id.json"');
    res.send(payload);
  });

  const upstream = upstreamApp.listen(0, '127.0.0.1');
  await listening(upstream);

  const originalProxyBaseUrl = config.proxyBaseUrl;
  const upstreamAddress = upstream.address() as AddressInfo;
  config.proxyBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const consoleApp = express();
  consoleApp.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const consoleServer = consoleApp.listen(0, '127.0.0.1');
  await listening(consoleServer);

  try {
    const consoleAddress = consoleServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${consoleAddress.port}/api/console/proxy/error-diagnostics/diagnostic-id/download`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="proxy-error-diagnostic-id.json"',
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  } finally {
    config.proxyBaseUrl = originalProxyBaseUrl;
    await close(consoleServer);
    await close(upstream);
  }
});

test('preserves public path prefixes, rejects traversal and releases interrupted download streams', async (t) => {
  let calls = 0;
  let closed: (() => void) | undefined;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const upstreamApp = express();
  upstreamApp.use((req, res) => {
    calls++;
    assert.match(req.url, /^\/base\/api\//);
    if (req.url.endsWith('/percent%25value')) { res.status(204).end(); return; }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="fixture.csv"');
    res.setHeader('X-Export-Matched-At-Start', '1000');
    const timer = setInterval(() => res.write('fixture,row\n'.repeat(100)), 10);
    res.on('close', () => { clearInterval(timer); closed!(); });
  });
  const upstream = upstreamApp.listen(0, '127.0.0.1');
  await listening(upstream);
  t.after(() => { upstream.closeAllConnections(); return close(upstream); });
  const previous = config.proxyBaseUrl;
  config.proxyBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/base`;
  t.after(() => { config.proxyBaseUrl = previous; });
  const app = express();
  app.use('/api/console/proxy', serviceProxy('proxy', '/api/console/proxy'));
  const server = app.listen(0, '127.0.0.1');
  await listening(server);
  t.after(() => { server.closeAllConnections(); return close(server); });
  const port = (server.address() as AddressInfo).port;
  for (const suffix of ['/%2e%2e/internal/users/user/login-credentials', '/%252e%252e/internal/users/user/login-credentials']) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: `/api/console/proxy${suffix}` }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/console/proxy/accounts/percent%25value`)).status, 204);
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/console/proxy/accounts/export`, { signal: abort.signal });
  assert.equal(response.headers.get('x-export-matched-at-start'), '1000');
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  abort.abort();
  await disconnected;
  assert.equal(calls, 2);
});

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
