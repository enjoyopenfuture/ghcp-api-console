import { Router } from 'express';
import {
  apiError,
  type LoginRuntimeSettingsValues,
  type UpdateLoginRuntimeSettingsRequest,
} from '@ghcp/shared';
import {
  loginRuntimeSettings,
  RuntimeSettingsValidationError,
  RuntimeSettingsVersionConflictError,
} from '../db/runtimeSettingsRepo.js';
import { loginQueue } from '../tasks/queue.js';

export const settingsApiRouter = Router();
const ROOT_KEYS = new Set(['expectedVersion', 'changes']);
const SETTINGS_KEYS = new Set<keyof LoginRuntimeSettingsValues>([
  'concurrency',
  'authTimeoutMs',
  'authDebugLogs',
  'authDebugArtifacts',
]);

settingsApiRouter.get('/settings/runtime', (_req, res) => {
  res.json(loginRuntimeSettings.getSnapshot());
});

settingsApiRouter.patch('/settings/runtime', (req, res) => {
  try {
    const request = readUpdateRequest(req.body);
    const updated = loginRuntimeSettings.update(request);
    loginQueue.onRuntimeSettingsUpdated();
    res.json(updated);
  } catch (error) {
    if (error instanceof RuntimeSettingsValidationError) {
      res.status(400).json(apiError('invalid_runtime_settings', error.message, { issues: error.issues }));
      return;
    }
    if (error instanceof RuntimeSettingsVersionConflictError) {
      res.status(409).json(apiError('settings_version_conflict', error.message, {
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
      }));
      return;
    }
    throw error;
  }
});

function readUpdateRequest(body: unknown): UpdateLoginRuntimeSettingsRequest {
  const issues: string[] = [];
  if (!isRecord(body)) {
    throw new RuntimeSettingsValidationError(['request body must be an object.']);
  }

  const unknownRootKeys = Object.keys(body).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) issues.push(`request contains unknown field(s): ${unknownRootKeys.join(', ')}.`);
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    issues.push('expectedVersion must be a positive integer.');
  }
  if (!isRecord(body.changes)) {
    issues.push('changes must be an object.');
  } else {
    const unknownChangeKeys = Object.keys(body.changes).filter(
      (key) => !SETTINGS_KEYS.has(key as keyof LoginRuntimeSettingsValues),
    );
    if (unknownChangeKeys.length > 0) {
      issues.push(`changes contains unknown field(s): ${unknownChangeKeys.join(', ')}.`);
    }
    validateChangeFields(body.changes, issues);
  }
  if (issues.length > 0) throw new RuntimeSettingsValidationError(issues);
  return body as unknown as UpdateLoginRuntimeSettingsRequest;
}

function validateChangeFields(changes: Record<string, unknown>, issues: string[]): void {
  if ('concurrency' in changes && (
    !Number.isInteger(changes.concurrency)
    || (changes.concurrency as number) < 1
    || (changes.concurrency as number) > 20
  )) {
    issues.push('concurrency must be an integer from 1 through 20.');
  }
  if ('authTimeoutMs' in changes && (
    !Number.isInteger(changes.authTimeoutMs)
    || (changes.authTimeoutMs as number) < 5_000
    || (changes.authTimeoutMs as number) > 600_000
  )) {
    issues.push('authTimeoutMs must be an integer from 5000 through 600000.');
  }
  if ('authDebugLogs' in changes && typeof changes.authDebugLogs !== 'boolean') {
    issues.push('authDebugLogs must be a boolean.');
  }
  if ('authDebugArtifacts' in changes && typeof changes.authDebugArtifacts !== 'boolean') {
    issues.push('authDebugArtifacts must be a boolean.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
