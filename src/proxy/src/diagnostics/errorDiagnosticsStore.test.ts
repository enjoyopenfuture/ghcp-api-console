import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { ProxyErrorDiagnosticRecordDto } from '@ghcp/shared';
import { ErrorDiagnosticsStore } from './errorDiagnosticsStore.js';
import { formatDiagnosticRecord, parseDiagnosticLog } from './humanDiagnosticFormat.js';

test('rotates by size, retains configured files, lists newest first, looks up, and clears', async () => {
  const directory = testDirectory();
  const first = record('00000000-0000-4000-8000-000000000001', '2026-07-31T09:00:01.000Z');
  const second = record('00000000-0000-4000-8000-000000000002', '2026-07-31T09:00:02.000Z');
  const third = record('00000000-0000-4000-8000-000000000003', '2026-07-31T09:00:03.000Z');
  const oneRecordBytes = Buffer.byteLength(formatDiagnosticRecord(first));
  const store = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: oneRecordBytes + 8,
    maxFiles: 2,
  });

  try {
    await store.append(first);
    await store.append(second);
    assert.deepEqual((await store.list()).items.map((item) => item.id), [second.id, first.id]);
    const storedFirst = await store.get(first.id);
    assert.equal(storedFirst?.id, first.id);
    assert.match(storedFirst?.content ?? '', /## Inbound request/);

    await store.append(third);
    const retained = await store.list();
    assert.equal(retained.total, 2);
    assert.deepEqual(retained.items.map((item) => item.id), [third.id, second.id]);
    assert.equal(await store.get(first.id), undefined);

    await store.clear();
    assert.equal((await store.list()).total, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serializes concurrent appends without corrupting human-readable records', async () => {
  const directory = testDirectory();
  const store = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 10 * 1024 * 1024,
    maxFiles: 2,
  });
  const records = Array.from({ length: 30 }, (_, index) => record(
    `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    new Date(Date.UTC(2026, 6, 31, 9, 1, index)).toISOString(),
  ));

  try {
    await Promise.all(records.map((value) => store.append(value)));
    const listed = await store.list(1, 100);
    assert.equal(listed.total, records.length);
    assert.deepEqual(new Set(listed.items.map((item) => item.id)), new Set(records.map((item) => item.id)));
    const parsed = parseDiagnosticLog(await readFile(join(directory, 'diagnostics.log'), 'utf8'));
    assert.equal(parsed.length, records.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes oversized records intact and tolerates malformed or partial lines', async () => {
  const directory = testDirectory();
  const existing = record('20000000-0000-4000-8000-000000000000', '2026-07-31T09:01:59.000Z');
  const oversized = record('20000000-0000-4000-8000-000000000001', '2026-07-31T09:02:00.000Z', 'x'.repeat(4096));
  const store = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 2000,
    maxFiles: 3,
  });

  try {
    await store.append(existing);
    await store.append(oversized);
    assert.equal((await store.get(oversized.id))?.id, oversized.id);
    assert.equal(await readFile(join(directory, 'diagnostics.log'), 'utf8'), formatDiagnosticRecord(oversized));
    assert.equal(await readFile(join(directory, 'diagnostics.1.log'), 'utf8'), formatDiagnosticRecord(existing));

    const next = record(
      '20000000-0000-4000-8000-000000000002',
      '2026-07-31T09:02:01.000Z',
    );
    await writeFile(
      join(directory, 'diagnostics.log'),
      `${formatDiagnosticRecord(oversized)}${formatDiagnosticRecord(next)}===== GHCP PROXY ERROR DIAGNOSTIC BEGIN partial =====\n`,
      'utf8',
    );
    const listed = await store.list();
    assert.equal(listed.total, 3);
    assert.deepEqual(listed.items.map((item) => item.id), [
      '20000000-0000-4000-8000-000000000002',
      oversized.id,
      existing.id,
    ]);

    const afterPartial = record('20000000-0000-4000-8000-000000000003', '2026-07-31T09:02:02.000Z');
    await store.append(afterPartial);
    assert.deepEqual((await store.list()).items.map((item) => item.id), [
      afterPartial.id,
      '20000000-0000-4000-8000-000000000002',
      oversized.id,
      existing.id,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports disabled state without creating storage', async () => {
  const directory = testDirectory();
  const store = new ErrorDiagnosticsStore({
    enabled: false,
    directory,
    redacted: true,
    maxFileBytes: 1024,
    maxFiles: 2,
  });
  const result = await store.list();
  assert.equal(result.enabled, false);
  assert.equal(result.redacted, true);
  assert.equal(result.total, 0);
  assert.throws(() => store.get(randomUUID()), /disabled/);
});

function record(id: string, timestamp: string, content = '{"hello":"world"}'): ProxyErrorDiagnosticRecordDto {
  const body = {
    encoding: 'utf8' as const,
    data: content,
    byteLength: Buffer.byteLength(content),
    capturedByteLength: Buffer.byteLength(content),
    truncated: false,
    complete: true,
  };
  return {
    id,
    timestamp,
    failureKind: 'http',
    identity: 'alice',
    path: '/responses',
    model: 'gpt-5',
    redacted: false,
    inboundRequest: {
      method: 'POST',
      url: '/responses',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body,
    },
    upstreamRequest: {
      method: 'POST',
      url: 'https://api.githubcopilot.com/responses',
      headers: [{ name: 'Authorization', value: 'Bearer token' }],
      body,
    },
    upstreamResponse: {
      status: 500,
      statusText: 'Internal Server Error',
      headers: [{ name: 'content-type', value: 'application/json' }],
      body,
    },
  };
}

function testDirectory(): string {
  const root = resolve(process.cwd(), 'data', 'error-diagnostics-tests');
  return join(root, randomUUID());
}
