import { setTimeout as delay } from 'node:timers/promises';
import { HttpApiError, JsonHttpClient, type BatchResult, type EnsureSsoUserRequest, type EnsureSsoUserResponse, type SsoUserBatchRow, type SsoUserDto } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.ssoBaseUrl,
  internalToken: config.internalApiToken,
});

/**
 * SSO caps concurrent scrypt verifications and answers 429 `default_credentials_busy` beyond it.
 * That is backpressure, not a failure: a batch re-authorization would otherwise fail most of its
 * accounts simply because they were submitted at the same time.
 */
const BUSY_RETRIES = 5;
const BUSY_RETRY_DELAY_MS = 1000;

export async function resolveDefaultLoginPassword(ssoUser: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await client.request<{ password: string }>(
        `/internal/users/${encodeURIComponent(ssoUser)}/login-credentials`, { method: 'POST', body: {} },
      );
      return result.password;
    } catch (err) {
      const busy = err instanceof HttpApiError && err.status === 429 && err.code === 'default_credentials_busy';
      if (!busy || attempt > BUSY_RETRIES) throw err;
      await delay(BUSY_RETRY_DELAY_MS * attempt);
    }
  }
}

export async function ensureSsoUser(request: EnsureSsoUserRequest): Promise<EnsureSsoUserResponse> {
  return client.request<EnsureSsoUserResponse>('/api/users/ensure', { method: 'POST', body: request });
}

export async function getSsoUser(ssoUser: string): Promise<SsoUserDto> {
  return client.request<SsoUserDto>(`/api/users/${encodeURIComponent(ssoUser)}`);
}

export async function syncEmuUser(
  ssoUser: string,
  options: { assignCopilotSeat?: boolean } = {},
): Promise<SsoUserDto> {
  const result = await client.request<BatchResult<SsoUserBatchRow>>('/api/users/batch', {
    method: 'POST',
    body: {
      operation: 'sync_emu',
      ssoUsers: [ssoUser],
      ...(options.assignCopilotSeat ? { assignCopilotSeat: true } : {}),
    },
  });
  const row = result.rows[0];
  if (!row || row.status === 'failed' || !row.user) throw new Error(row?.detail ?? `Failed to sync GH login "${ssoUser}".`);
  return row.user;
}
