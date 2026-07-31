import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import {
  LoginRuntimeSettingsRepository,
  RuntimeSettingsValidationError,
  RuntimeSettingsVersionConflictError,
} from './runtimeSettingsRepo.js';

test('reads immutable runtime settings and updates them transactionally', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repository = new LoginRuntimeSettingsRepository(db);

  const initial = repository.getSnapshot();
  assert.deepEqual(initial, {
    concurrency: 1,
    authTimeoutMs: 60_000,
    authDebugLogs: false,
    authDebugArtifacts: false,
    version: 1,
    updatedAt: initial.updatedAt,
  });
  assert.equal(Object.isFrozen(initial), true);

  const updated = repository.update({
    expectedVersion: 1,
    changes: {
      concurrency: 4,
      authTimeoutMs: 120_000,
      authDebugLogs: true,
      authDebugArtifacts: true,
    },
  });
  assert.deepEqual(updated, {
    concurrency: 4,
    authTimeoutMs: 120_000,
    authDebugLogs: true,
    authDebugArtifacts: true,
    version: 2,
    updatedAt: updated.updatedAt,
  });
  assert.equal(repository.getSnapshot(), updated);
  assert.deepEqual(
    db.prepare(`
      SELECT concurrency, auth_timeout_ms, auth_debug_logs, auth_debug_artifacts, version
      FROM login_runtime_settings WHERE id = 1
    `).get(),
    {
      concurrency: 4,
      auth_timeout_ms: 120_000,
      auth_debug_logs: 1,
      auth_debug_artifacts: 1,
      version: 2,
    },
  );
  db.close();
});

test('rejects stale versions without replacing the current snapshot', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repository = new LoginRuntimeSettingsRepository(db);
  const initial = repository.getSnapshot();
  const updated = repository.update({ expectedVersion: initial.version, changes: { concurrency: 2 } });

  assert.throws(
    () => repository.update({ expectedVersion: initial.version, changes: { concurrency: 3 } }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeSettingsVersionConflictError);
      assert.equal(error.expectedVersion, 1);
      assert.equal(error.currentVersion, 2);
      return true;
    },
  );
  assert.equal(repository.getSnapshot(), updated);
  assert.equal(
    (db.prepare('SELECT concurrency FROM login_runtime_settings WHERE id = 1').get() as { concurrency: number }).concurrency,
    2,
  );
  db.close();
});

test('validates every runtime setting before writing', () => {
  const invalidChanges = [
    { concurrency: 0 },
    { concurrency: 1.5 },
    { authTimeoutMs: 4_999 },
    { authTimeoutMs: 600_001 },
    { authDebugLogs: 1 },
    { authDebugArtifacts: 'true' },
    { unknown: true },
  ];

  for (const changes of invalidChanges) {
    const db = new Database(':memory:');
    runMigrations(db);
    const repository = new LoginRuntimeSettingsRepository(db);
    const initial = repository.getSnapshot();
    assert.throws(
      () => repository.update({ expectedVersion: 1, changes } as never),
      RuntimeSettingsValidationError,
    );
    assert.equal(repository.getSnapshot(), initial);
    assert.equal(
      (db.prepare('SELECT version FROM login_runtime_settings WHERE id = 1').get() as { version: number }).version,
      1,
    );
    db.close();
  }
});
