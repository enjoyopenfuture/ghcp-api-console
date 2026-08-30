import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('shared mode aggregates cross-instance records in global newest-first order', async () => {
  const directory = testDirectory();
  const alpha = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'alpha',
  });
  const beta = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'beta',
  });
  const alphaFirst = record('30000000-0000-4000-8000-000000000001', '2026-07-31T09:10:01.000Z');
  const betaFirst = record('30000000-0000-4000-8000-000000000002', '2026-07-31T09:10:02.000Z');
  const alphaSecond = record('30000000-0000-4000-8000-000000000003', '2026-07-31T09:10:03.000Z');
  const betaSecond = record('30000000-0000-4000-8000-000000000004', '2026-07-31T09:10:04.000Z');

  try {
    await alpha.append(alphaFirst);
    await beta.append(betaFirst);
    await alpha.append(alphaSecond);
    await beta.append(betaSecond);

    const listed = await alpha.list(1, 10);
    assert.equal(listed.total, 4);
    assert.deepEqual(listed.items.map((item) => item.id), [
      betaSecond.id,
      alphaSecond.id,
      betaFirst.id,
      alphaFirst.id,
    ]);
    assert.equal((await alpha.get(betaFirst.id))?.id, betaFirst.id);
    assert.equal((await beta.get(alphaSecond.id))?.id, alphaSecond.id);

    const alphaLog = parseDiagnosticLog(await readFile(join(directory, 'instances', 'alpha', 'diagnostics.log'), 'utf8'));
    const betaLog = parseDiagnosticLog(await readFile(join(directory, 'instances', 'beta', 'diagnostics.log'), 'utf8'));
    assert.deepEqual(new Set(alphaLog.map((item) => item.id)), new Set([alphaFirst.id, alphaSecond.id]));
    assert.deepEqual(new Set(betaLog.map((item) => item.id)), new Set([betaFirst.id, betaSecond.id]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared mode rotates files independently for each instance', async () => {
  const directory = testDirectory();
  const sample = record('31000000-0000-4000-8000-000000000000', '2026-07-31T09:11:00.000Z');
  const storeOptions = {
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: Buffer.byteLength(formatDiagnosticRecord(sample)) + 8,
    maxFiles: 2,
    shared: true,
  } as const;
  const alpha = new ErrorDiagnosticsStore({ ...storeOptions, instanceId: 'alpha' });
  const beta = new ErrorDiagnosticsStore({ ...storeOptions, instanceId: 'beta' });
  const alphaRecords = [
    record('31000000-0000-4000-8000-000000000001', '2026-07-31T09:11:01.000Z'),
    record('31000000-0000-4000-8000-000000000002', '2026-07-31T09:11:02.000Z'),
    record('31000000-0000-4000-8000-000000000003', '2026-07-31T09:11:03.000Z'),
  ];
  const betaRecords = [
    record('32000000-0000-4000-8000-000000000001', '2026-07-31T09:11:04.000Z'),
    record('32000000-0000-4000-8000-000000000002', '2026-07-31T09:11:05.000Z'),
    record('32000000-0000-4000-8000-000000000003', '2026-07-31T09:11:06.000Z'),
  ];

  try {
    await Promise.all([
      ...alphaRecords.map((item) => alpha.append(item)),
      ...betaRecords.map((item) => beta.append(item)),
    ]);

    const listed = await alpha.list(1, 10);
    assert.equal(listed.total, 4);
    assert.equal(await alpha.get(alphaRecords[0]!.id), undefined);
    assert.equal(await beta.get(betaRecords[0]!.id), undefined);

    const alphaRetained = await recordsInInstanceLogs(directory, 'alpha', 2);
    const betaRetained = await recordsInInstanceLogs(directory, 'beta', 2);
    assert.deepEqual(new Set(alphaRetained.map((item) => item.id)), new Set(alphaRecords.slice(1).map((item) => item.id)));
    assert.deepEqual(new Set(betaRetained.map((item) => item.id)), new Set(betaRecords.slice(1).map((item) => item.id)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared mode clear uses a global cutoff and keeps post-clear records visible', async () => {
  const directory = testDirectory();
  const alpha = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'alpha',
  });
  const beta = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'beta',
  });
  const oldAlpha = record('33000000-0000-4000-8000-000000000001', '2001-01-01T00:00:01.000Z');
  const oldBeta = record('33000000-0000-4000-8000-000000000002', '2001-01-01T00:00:02.000Z');
  const newAlpha = record('33000000-0000-4000-8000-000000000003', '2099-01-01T00:00:03.000Z');
  const newBeta = record('33000000-0000-4000-8000-000000000004', '2099-01-01T00:00:04.000Z');

  try {
    await alpha.append(oldAlpha);
    await beta.append(oldBeta);
    await alpha.clear();

    assert.equal((await alpha.list()).total, 0);
    assert.equal((await beta.list()).total, 0);
    const betaOldFile = parseDiagnosticLog(await readFile(join(directory, 'instances', 'beta', 'diagnostics.log'), 'utf8'));
    assert.equal(betaOldFile[0]?.id, oldBeta.id);

    await alpha.append(newAlpha);
    await beta.append(newBeta);
    const listed = await alpha.list(1, 10);
    assert.deepEqual(listed.items.map((item) => item.id), [newBeta.id, newAlpha.id]);
    assert.equal(await alpha.get(oldAlpha.id), undefined);
    assert.equal(await beta.get(oldBeta.id), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared mode reads legacy root files and validates instance IDs', async () => {
  const directory = testDirectory();
  const legacy = record('34000000-0000-4000-8000-000000000001', '2026-07-31T09:12:01.000Z');
  const shared = record('34000000-0000-4000-8000-000000000002', '2026-07-31T09:12:02.000Z');
  const alpha = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'alpha',
  });
  const beta = new ErrorDiagnosticsStore({
    enabled: true,
    directory,
    redacted: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 3,
    shared: true,
    instanceId: 'beta',
  });

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'diagnostics.log'), formatDiagnosticRecord(legacy), 'utf8');
    await alpha.append(shared);

    const listed = await beta.list(1, 10);
    assert.deepEqual(listed.items.map((item) => item.id), [shared.id, legacy.id]);
    assert.equal((await beta.get(legacy.id))?.id, legacy.id);

    assert.throws(() => new ErrorDiagnosticsStore({
      enabled: true,
      directory,
      redacted: false,
      maxFileBytes: 1024,
      maxFiles: 2,
      shared: true,
      instanceId: '../../outside',
    }), /Invalid shared diagnostics instance id/);
    assert.throws(() => new ErrorDiagnosticsStore({
      enabled: true,
      directory,
      redacted: false,
      maxFileBytes: 1024,
      maxFiles: 2,
      shared: true,
      instanceId: '////',
    }), /Invalid shared diagnostics instance id/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function recordsInInstanceLogs(directory: string, instanceId: string, maxFiles: number): Promise<ReturnType<typeof parseDiagnosticLog>> {
  const records: ReturnType<typeof parseDiagnosticLog> = [];
  for (let fileIndex = 0; fileIndex < maxFiles; fileIndex += 1) {
    const path = join(directory, 'instances', instanceId, fileIndex === 0 ? 'diagnostics.log' : `diagnostics.${fileIndex}.log`);
    try {
      records.push(...parseDiagnosticLog(await readFile(path, 'utf8')));
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err;
    }
  }
  return records;
}
