import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.PROXY_ERROR_DIAGNOSTICS_ENABLED = 'false';
process.env.IDENTITY_HEADER_REQUIRED = 'false';

const { config } = await import('./config.js');
const { buildApp, captureRawRequestBody } = await import('./server.js');

config.apiKey = 'server-test-key';
// buildApp() reads the JSON limit once; a fractional MiB value also exercises the 413 message format.
config.maxRequestBodyBytes = 1.25 * 1024 * 1024;

test('answers request body errors in the error shape of the public endpoint', async () => {
  const oversized = JSON.stringify({ model: 'test-model', input: 'x'.repeat(config.maxRequestBodyBytes) });
  const tooLarge = 'Request body exceeds the proxy limit of 1.25 MiB.';
  const invalidJson = 'Request body is not valid JSON.';
  const cases = [
    {
      path: '/chat/completions',
      body: oversized,
      status: 413,
      expected: { error: { message: tooLarge, type: 'invalid_request_error', code: 'request_too_large' } },
    },
    {
      path: '/v1/messages',
      body: oversized,
      status: 413,
      expected: { type: 'error', error: { type: 'request_too_large', message: tooLarge } },
    },
    {
      path: '/responses',
      body: '{"model":',
      status: 400,
      expected: { error: { message: invalidJson, type: 'invalid_request_error' } },
    },
    {
      path: '/v1/messages/count_tokens',
      body: '{"model":',
      status: 400,
      expected: { type: 'error', error: { type: 'invalid_request_error', message: invalidJson } },
    },
  ];

  await withServer(buildApp(), async (baseUrl) => {
    for (const { path, body, status, expected } of cases) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, status, path);
      assert.deepEqual(await response.json(), expected, path);
    }
  });
});

test('captureRawRequestBody keeps bodies up to the limit and skips oversized or octet-stream bodies', async () => {
  const app = express();
  app.use(captureRawRequestBody);
  app.post('/capture', (req, res) => {
    const report = () => res.json({ captured: req.rawBody !== undefined, byteLength: req.rawBody?.byteLength });
    if (req.readableEnded) report();
    else req.once('end', report);
    req.resume();
  });
  const cases = [
    { name: 'at the limit', contentType: 'application/json', byteLength: config.maxRequestBodyBytes, captured: true },
    { name: 'over the limit', contentType: 'application/json', byteLength: config.maxRequestBodyBytes + 1, captured: false },
    { name: 'octet-stream', contentType: 'application/octet-stream', byteLength: 16, captured: false },
  ];

  await withServer(app, async (baseUrl) => {
    for (const { name, contentType, byteLength, captured } of cases) {
      const response = await fetch(`${baseUrl}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: Buffer.alloc(byteLength, 'a'),
      });
      assert.deepEqual(await response.json(), captured ? { captured, byteLength } : { captured }, name);
    }
  });
});

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolveReady) => server.once('listening', resolveReady));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolveClosed, reject) => {
      server.close((err) => err ? reject(err) : resolveClosed());
    });
  }
}
