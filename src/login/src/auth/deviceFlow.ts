import { config } from '../config.js';
import type { AccountLogger } from '../tasks/accountLogger.js';
import type { AuthStrategy } from './types.js';

type DeviceFlowLogger = Pick<AccountLogger, 'info' | 'warn'>;

interface DeviceFlowRuntime {
  fetch: typeof globalThis.fetch;
  sleep(ms: number): Promise<void>;
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
): Promise<string> {
  const device = await requestDeviceCode(logger, runtime);
  logger.info('device-flow', 'Received GitHub device code', {
    verificationUri: device.verification_uri,
    expiresIn: device.expires_in,
    interval: device.interval,
  });
  await strategy.authorize(device);
  return pollAccessToken(device, logger, runtime);
}

async function requestDeviceCode(logger: DeviceFlowLogger, runtime: DeviceFlowRuntime): Promise<DeviceCodeResponse> {
  const maxAttempts = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await runtime.fetch(config.endpoints.deviceCode, {
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
      await runtime.sleep(1000 * attempt);
    }
  }

  throw new Error(`Device code request failed after ${maxAttempts} attempts: ${lastError}`);
}

async function pollAccessToken(device: DeviceCodeResponse, logger: DeviceFlowLogger, runtime: DeviceFlowRuntime): Promise<string> {
  const started = runtime.now();
  let interval = (Math.max(1, device.interval) + 3) * 1000;
  let attempt = 0;
  let lastPendingLogAt = 0;
  logger.info('device-flow', 'Waiting for GitHub OAuth authorization', {
    expiresIn: device.expires_in,
    intervalMs: interval,
  });
  while (runtime.now() - started < device.expires_in * 1000) {
    await runtime.sleep(interval);
    attempt++;
    const res = await runtime.fetch(config.endpoints.accessToken, {
      method: 'POST',
      headers: deviceFlowHeaders(),
      body: JSON.stringify({
        client_id: config.githubOauthClientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) throw new Error(`Access token poll failed: ${res.status} ${await res.text()}`);
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
    if (body.error === 'expired_token') throw new Error('Device code expired before authorization. Run login again.');
    if (body.error === 'access_denied') throw new Error('Authorization was denied.');
    logger.warn('device-flow', 'GitHub token poll returned an error', { error: body.error, description: body.error_description });
    throw new Error(body.error_description || body.error || 'GitHub device-flow authorization failed.');
  }
  throw new Error('GitHub device-flow authorization timed out.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deviceFlowHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': config.opencodeUserAgent,
  };
}
