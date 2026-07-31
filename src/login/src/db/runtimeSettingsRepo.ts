import type Database from 'better-sqlite3';
import type {
  LoginRuntimeSettingsDto,
  LoginRuntimeSettingsValues,
  UpdateLoginRuntimeSettingsRequest,
} from '@ghcp/shared';
import { getDb } from './connection.js';

export type LoginRuntimeSettingsSnapshot = Readonly<LoginRuntimeSettingsDto>;

interface RuntimeSettingsRow {
  id: number;
  concurrency: number;
  auth_timeout_ms: number;
  auth_debug_logs: number;
  auth_debug_artifacts: number;
  version: number;
  updated_at: string;
}

const SETTINGS_KEYS = new Set<keyof LoginRuntimeSettingsValues>([
  'concurrency',
  'authTimeoutMs',
  'authDebugLogs',
  'authDebugArtifacts',
]);

export class RuntimeSettingsValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join(' '));
    this.name = 'RuntimeSettingsValidationError';
  }
}

export class RuntimeSettingsVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(`Runtime settings version conflict: expected ${expectedVersion}, current version is ${currentVersion}.`);
    this.name = 'RuntimeSettingsVersionConflictError';
  }
}

export class LoginRuntimeSettingsRepository {
  private snapshot?: LoginRuntimeSettingsSnapshot;

  constructor(private readonly database: Database.Database | (() => Database.Database) = getDb) {}

  getSnapshot(): LoginRuntimeSettingsSnapshot {
    if (!this.snapshot) this.snapshot = readSnapshot(this.db());
    return this.snapshot;
  }

  update(request: UpdateLoginRuntimeSettingsRequest): LoginRuntimeSettingsSnapshot {
    validateUpdateRequest(request);
    const db = this.db();
    const write = db.transaction(() => {
      const current = readSnapshot(db);
      const candidate = {
        concurrency: current.concurrency,
        authTimeoutMs: current.authTimeoutMs,
        authDebugLogs: current.authDebugLogs,
        authDebugArtifacts: current.authDebugArtifacts,
        ...request.changes,
      } as LoginRuntimeSettingsValues;
      validateRuntimeSettingsValues(candidate);
      if (current.version !== request.expectedVersion) {
        throw new RuntimeSettingsVersionConflictError(request.expectedVersion, current.version);
      }
      const updatedAt = new Date().toISOString();
      const result = db.prepare(`
        UPDATE login_runtime_settings
        SET concurrency = ?,
            auth_timeout_ms = ?,
            auth_debug_logs = ?,
            auth_debug_artifacts = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = 1 AND version = ?
      `).run(
        candidate.concurrency,
        candidate.authTimeoutMs,
        candidate.authDebugLogs ? 1 : 0,
        candidate.authDebugArtifacts ? 1 : 0,
        updatedAt,
        request.expectedVersion,
      );
      if (result.changes !== 1) {
        const latest = readSnapshot(db);
        throw new RuntimeSettingsVersionConflictError(request.expectedVersion, latest.version);
      }
      return readSnapshot(db);
    });
    const next = write.immediate();

    this.snapshot = next;
    return next;
  }

  private db(): Database.Database {
    return typeof this.database === 'function' ? this.database() : this.database;
  }
}

export function validateRuntimeSettingsValues(values: LoginRuntimeSettingsValues): void {
  const issues: string[] = [];
  if (!Number.isInteger(values.concurrency) || values.concurrency < 1 || values.concurrency > 20) {
    issues.push('concurrency must be an integer from 1 through 20.');
  }
  if (!Number.isInteger(values.authTimeoutMs) || values.authTimeoutMs < 5_000 || values.authTimeoutMs > 600_000) {
    issues.push('authTimeoutMs must be an integer from 5000 through 600000.');
  }
  if (typeof values.authDebugLogs !== 'boolean') {
    issues.push('authDebugLogs must be a boolean.');
  }
  if (typeof values.authDebugArtifacts !== 'boolean') {
    issues.push('authDebugArtifacts must be a boolean.');
  }
  if (issues.length > 0) throw new RuntimeSettingsValidationError(issues);
}

function validateUpdateRequest(request: unknown): asserts request is UpdateLoginRuntimeSettingsRequest {
  if (!isRecord(request)) {
    throw new RuntimeSettingsValidationError(['runtime settings update must be an object.']);
  }
  const issues: string[] = [];
  if (!Number.isInteger(request.expectedVersion) || (request.expectedVersion as number) < 1) {
    issues.push('expectedVersion must be a positive integer.');
  }
  if (!isRecord(request.changes)) {
    issues.push('changes must be an object.');
  } else {
    const unknown = Object.keys(request.changes).filter((key) => !SETTINGS_KEYS.has(key as keyof LoginRuntimeSettingsValues));
    if (unknown.length > 0) issues.push(`changes contains unknown field(s): ${unknown.join(', ')}.`);
  }
  if (issues.length > 0) throw new RuntimeSettingsValidationError(issues);
}

function readSnapshot(db: Database.Database): LoginRuntimeSettingsSnapshot {
  const row = db.prepare('SELECT * FROM login_runtime_settings WHERE id = 1').get() as RuntimeSettingsRow | undefined;
  if (!row) throw new RuntimeSettingsValidationError(['login_runtime_settings row with id 1 is missing.']);
  const storageIssues: string[] = [];
  if (row.auth_debug_logs !== 0 && row.auth_debug_logs !== 1) {
    storageIssues.push('auth_debug_logs must be stored as 0 or 1.');
  }
  if (row.auth_debug_artifacts !== 0 && row.auth_debug_artifacts !== 1) {
    storageIssues.push('auth_debug_artifacts must be stored as 0 or 1.');
  }
  if (!Number.isInteger(row.version) || row.version < 1) storageIssues.push('version must be a positive integer.');
  if (typeof row.updated_at !== 'string' || !row.updated_at) storageIssues.push('updated_at must be a non-empty string.');
  if (storageIssues.length > 0) throw new RuntimeSettingsValidationError(storageIssues);

  const snapshot: LoginRuntimeSettingsDto = {
    concurrency: row.concurrency,
    authTimeoutMs: row.auth_timeout_ms,
    authDebugLogs: row.auth_debug_logs === 1,
    authDebugArtifacts: row.auth_debug_artifacts === 1,
    version: row.version,
    updatedAt: row.updated_at,
  };
  validateRuntimeSettingsValues(snapshot);
  return Object.freeze(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const loginRuntimeSettings = new LoginRuntimeSettingsRepository();
