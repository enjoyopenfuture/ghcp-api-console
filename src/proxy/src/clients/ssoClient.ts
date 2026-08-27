import { JsonHttpClient, type BatchResult, type EnsureSsoUserRequest, type EnsureSsoUserResponse, type SsoUserBatchRow, type SsoUserDto } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.ssoBaseUrl,
  internalToken: config.internalApiToken,
});

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
