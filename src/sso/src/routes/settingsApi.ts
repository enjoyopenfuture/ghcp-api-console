import { Router } from 'express';
import { apiError, errorFields, loggerFor, type UpdateSsoRuntimeSettingsRequest } from '@ghcp/shared';
import {
  getSsoRuntimeSettings,
  InvalidSsoRuntimeSettingsError,
  SsoSettingsVersionConflictError,
  updateSsoRuntimeSettings,
} from '../db/runtimeSettingsRepo.js';

export const settingsApiRouter = Router();
const logger = loggerFor('sso', 'settings-api');
const ROOT_KEYS = new Set(['expectedVersion', 'changes']);

settingsApiRouter.get('/settings/runtime', (_req, res) => {
  res.json(getSsoRuntimeSettings());
});

settingsApiRouter.patch('/settings/runtime', (req, res) => {
  const body = req.body as Partial<UpdateSsoRuntimeSettingsRequest> | undefined;
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedVersion) || !body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes)) {
    res.status(400).json(apiError('invalid_runtime_settings', 'expectedVersion and changes are required.'));
    return;
  }
  const unknownRootKeys = Object.keys(body).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) {
    res.status(400).json(apiError('invalid_runtime_settings', `Unknown request field(s): ${unknownRootKeys.join(', ')}.`));
    return;
  }
  try {
    res.json(updateSsoRuntimeSettings(body as UpdateSsoRuntimeSettingsRequest));
  } catch (err) {
    logger.error('update-failed', 'Update SSO runtime settings failed', { ...errorFields(err) });
    if (err instanceof InvalidSsoRuntimeSettingsError) {
      res.status(400).json(apiError('invalid_runtime_settings', err.message, { fields: err.fields }));
      return;
    }
    if (err instanceof SsoSettingsVersionConflictError) {
      res.status(409).json(apiError('settings_version_conflict', err.message, {
        expectedVersion: err.expectedVersion,
        currentVersion: err.currentVersion,
      }));
      return;
    }
    res.status(500).json(apiError('runtime_settings_update_failed', err instanceof Error ? err.message : String(err)));
  }
});
