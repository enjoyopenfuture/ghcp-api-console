import { config } from '../config.js';
import type { AccountLogger } from '../tasks/accountLogger.js';
import type { AuthStrategy } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpApiError } from '@ghcp/shared';

type DeviceFlowLogger = Pick<AccountLogger, 'info' | 'warn'>;

interface DeviceFlowRuntime {
  fetch: typeof globalThis.fetch;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

const defaultRuntime: DeviceFlowRuntime = {
  fetch: globalThis.fetch,
  sleep,
  now: Date.now,
};

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export async function loginWithDeviceFlow(
  strategy: AuthStrategy,
  logger: DeviceFlowLogger,
  runtime: DeviceFlowRuntime = defaultRuntime,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const device = await requestDeviceCode(logger, runtime, signal);
  logger.info('device-flow', 'Received GitHub device code', {
    verificationUri: device.verification_uri,
    expiresIn: device.expires_in,
    interval: device.interval,
  });
  await strategy.authorize(device, signal);
  signal?.throwIfAborted();
  return pollAccessToken(device, logger, runtime, signal);
}

async function requestDeviceCode(logger: DeviceFlowLogger, runtime: DeviceFlowRuntime, signal?: AbortSignal): Promise<DeviceCodeResponse> {
  const maxAttempts = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    const res = await runtime.fetch(config.endpoints.deviceCode, {
      signal,
      method: 'POST',
      headers: deviceFlowHeaders(),
      body: JSON.stringify({ client_id: config.githubOauthClientId, scope: config.githubOauthScope }),
    });

    if (res.ok) {
      logger.info('device-flow', 'Requested GitHub device code', { attempt });
      return (await res.json()) as DeviceCodeResponse;
    }

    lastError = `${res.status} ${await res.text()}`.trim();
    if (attempt < maxAttempts) {
      logger.warn('device-flow', 'Device code request failed; retrying', { attempt, error: lastError });
      await runtime.sleep(1000 * attempt, signal);
    }
  }

  throw new HttpApiError(502, 'device_code_request_failed', `Device code request failed after ${maxAttempts} attempts: ${lastError}`);
}

async function pollAccessToken(device: DeviceCodeResponse, logger: DeviceFlowLogger, runtime: DeviceFlowRuntime, signal?: AbortSignal): Promise<string> {
  const started = runtime.now();
  let interval = (Math.max(1, device.interval) + 3) * 1000;
  let attempt = 0;
  let lastPendingLogAt = 0;
  logger.info('device-flow', 'Waiting for GitHub OAuth authorization', {
    expiresIn: device.expires_in,
    intervalMs: interval,
  });
  while (runtime.now() - started < device.expires_in * 1000) {
    signal?.throwIfAborted();
    await runtime.sleep(interval, signal);
    attempt++;
    const res = await runtime.fetch(config.endpoints.accessToken, {
      signal,
      method: 'POST',
      headers: deviceFlowHeaders(),
      body: JSON.stringify({
        client_id: config.githubOauthClientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) throw new HttpApiError(502, 'token_poll_failed', `Access token poll failed: HTTP ${res.status}.`);
    const body = (await res.json()) as AccessTokenResponse;
    if (body.access_token) {
      logger.info('device-flow', 'GitHub OAuth authorization complete', {
        attempt,
        tokenType: body.token_type,
        scope: body.scope,
      });
      return body.access_token;
    }
    if (body.error === 'authorization_pending') {
      const now = runtime.now();
      if (now - lastPendingLogAt >= 30_000) {
        lastPendingLogAt = now;
        logger.info('device-flow', 'Authorization is still pending', {
          attempt,
          elapsedSeconds: Math.round((now - started) / 1000),
          intervalMs: interval,
        });
      }
      continue;
    }
    if (body.error === 'slow_down') {
      interval = body.interval ? (Math.max(1, body.interval) + 3) * 1000 : interval + 5000;
      logger.warn('device-flow', 'GitHub requested slower polling', { attempt, intervalMs: interval });
      continue;
    }
    if (body.error === 'expired_token') throw new HttpApiError(409, 'authorization_expired', 'Device code expired before authorization. Run login again.');
    if (body.error === 'access_denied') throw new HttpApiError(403, 'authorization_denied', 'Authorization was denied.');
    logger.warn('device-flow', 'GitHub token poll returned an error', { error: body.error, description: body.error_description });
    throw new HttpApiError(502, 'authorization_failed', body.error_description || body.error || 'GitHub device-flow authorization failed.');
  }
  throw new HttpApiError(504, 'authorization_timeout', 'GitHub device-flow authorization timed out.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

function deviceFlowHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': config.opencodeUserAgent,
  };
}
