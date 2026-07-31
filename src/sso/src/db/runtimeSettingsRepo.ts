import type { SsoRuntimeSettingsDto, SsoRuntimeSettingsValues, UpdateSsoRuntimeSettingsRequest } from '@ghcp/shared';
import type Database from 'better-sqlite3';
import { nowIso } from '@ghcp/shared';
import { getDb } from './connection.js';

interface SsoRuntimeSettingsRow {
  max_sso_users: number | null;
  user_prefix: string;
  email_domain: string;
  bulk_sync_concurrency: number;
  scim_request_delay_ms: number;
  scim_max_retries: number;
  scim_retry_base_delay_ms: number;
  version: number;
  updated_at: string;
}

const ALLOWED_KEYS = new Set<keyof SsoRuntimeSettingsValues>([
  'maxSsoUsers',
  'userPrefix',
  'emailDomain',
  'bulkSyncConcurrency',
  'scimRequestDelayMs',
  'scimMaxRetries',
  'scimRetryBaseDelayMs',
]);

export class InvalidSsoRuntimeSettingsError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('One or more SSO runtime settings are invalid.');
    this.name = 'InvalidSsoRuntimeSettingsError';
  }
}

export class SsoSettingsVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(`SSO runtime settings changed from version ${expectedVersion} to ${currentVersion}. Reload and try again.`);
    this.name = 'SsoSettingsVersionConflictError';
  }
}

let snapshot: Readonly<SsoRuntimeSettingsDto> | undefined;

export function getSsoRuntimeSettings(): Readonly<SsoRuntimeSettingsDto> {
  if (!snapshot) snapshot = Object.freeze(readSettings(getDb()));
  return snapshot;
}

export function readMaxSsoUsers(db: Database.Database = getDb()): number | null {
  const row = db.prepare('SELECT max_sso_users FROM sso_runtime_settings WHERE id = 1').get() as { max_sso_users: number | null } | undefined;
  if (!row) throw new Error('SSO runtime settings row is missing.');
  return row.max_sso_users;
}

export function updateSsoRuntimeSettings(request: UpdateSsoRuntimeSettingsRequest): SsoRuntimeSettingsDto {
  const db = getDb();
  const next = db.transaction(() => {
    const current = readSettings(db);
    if (!Number.isInteger(request.expectedVersion) || request.expectedVersion !== current.version) {
      throw new SsoSettingsVersionConflictError(request.expectedVersion, current.version);
    }
    const changes = request.changes as Record<string, unknown>;
    const values = validateSettings({
      maxSsoUsers: current.maxSsoUsers,
      userPrefix: current.userPrefix,
      emailDomain: current.emailDomain,
      bulkSyncConcurrency: current.bulkSyncConcurrency,
      scimRequestDelayMs: current.scimRequestDelayMs,
      scimMaxRetries: current.scimMaxRetries,
      scimRetryBaseDelayMs: current.scimRetryBaseDelayMs,
      ...changes,
    }, changes);
    const updatedAt = nowIso();
    const result = db.prepare(`
      UPDATE sso_runtime_settings
      SET max_sso_users = ?, user_prefix = ?, email_domain = ?, bulk_sync_concurrency = ?,
          scim_request_delay_ms = ?, scim_max_retries = ?, scim_retry_base_delay_ms = ?,
          version = version + 1, updated_at = ?
      WHERE id = 1 AND version = ?
    `).run(
      values.maxSsoUsers,
      values.userPrefix,
      values.emailDomain,
      values.bulkSyncConcurrency,
      values.scimRequestDelayMs,
      values.scimMaxRetries,
      values.scimRetryBaseDelayMs,
      updatedAt,
      current.version,
    );
    if (result.changes !== 1) {
      const latest = readSettings(db);
      throw new SsoSettingsVersionConflictError(current.version, latest.version);
    }
    return readSettings(db);
  }).immediate();
  snapshot = Object.freeze(next);
  return next;
}

export function resetSsoRuntimeSettingsCacheForTests(): void {
  snapshot = undefined;
}

function readSettings(db: Database.Database): SsoRuntimeSettingsDto {
  const row = db.prepare('SELECT * FROM sso_runtime_settings WHERE id = 1').get() as SsoRuntimeSettingsRow | undefined;
  if (!row) throw new Error('SSO runtime settings row is missing.');
  return {
    maxSsoUsers: row.max_sso_users,
    userPrefix: row.user_prefix,
    emailDomain: row.email_domain,
    bulkSyncConcurrency: row.bulk_sync_concurrency,
    scimRequestDelayMs: row.scim_request_delay_ms,
    scimMaxRetries: row.scim_max_retries,
    scimRetryBaseDelayMs: row.scim_retry_base_delay_ms,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function validateSettings(values: Record<string, unknown>, changes: Record<string, unknown>): SsoRuntimeSettingsValues {
  const errors: Record<string, string> = {};
  for (const key of Object.keys(changes)) {
    if (!ALLOWED_KEYS.has(key as keyof SsoRuntimeSettingsValues)) errors[key] = 'Unknown setting.';
  }

  if (values.maxSsoUsers !== null && (typeof values.maxSsoUsers !== 'number' || !Number.isInteger(values.maxSsoUsers) || values.maxSsoUsers <= 0 || values.maxSsoUsers > 1_000_000)) {
    errors.maxSsoUsers = 'Must be null or an integer from 1 to 1000000.';
  }
  const userPrefix = normalizeUserPrefix(values.userPrefix);
  if (!/[a-z0-9]/.test(userPrefix)) errors.userPrefix = 'Must contain at least one letter or digit.';
  const emailDomain = typeof values.emailDomain === 'string' ? values.emailDomain.trim().toLowerCase() : '';
  if (!isValidHostname(emailDomain)) {
    errors.emailDomain = 'Must be a valid domain name.';
  }
  validateInteger(errors, 'bulkSyncConcurrency', values.bulkSyncConcurrency, 1, 20);
  validateInteger(errors, 'scimRequestDelayMs', values.scimRequestDelayMs, 0, 60_000);
  validateInteger(errors, 'scimMaxRetries', values.scimMaxRetries, 0, 10);
  validateInteger(errors, 'scimRetryBaseDelayMs', values.scimRetryBaseDelayMs, 0, 60_000);
  if (Object.keys(errors).length > 0) throw new InvalidSsoRuntimeSettingsError(errors);

  return {
    maxSsoUsers: values.maxSsoUsers as number | null,
    userPrefix,
    emailDomain,
    bulkSyncConcurrency: values.bulkSyncConcurrency as number,
    scimRequestDelayMs: values.scimRequestDelayMs as number,
    scimMaxRetries: values.scimMaxRetries as number,
    scimRetryBaseDelayMs: values.scimRetryBaseDelayMs as number,
  };
}

function normalizeUserPrefix(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
    : '';
}

function validateInteger(errors: Record<string, string>, key: string, value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors[key] = `Must be an integer from ${min} to ${max}.`;
}

function isValidHostname(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false;
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}
