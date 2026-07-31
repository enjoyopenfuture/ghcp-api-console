import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
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

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once('listening', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
