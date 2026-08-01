import { JsonHttpClient } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export async function saveCopilotOauthToken(
  identity: string,
  oauthAttemptId: string,
  copilotOauthToken: string,
  ghLogin?: string,
): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/copilot-oauth-token`, {
    method: 'PUT',
    body: { oauthAttemptId, copilotOauthToken, ghLogin },
  });
}

export async function markCopilotOauthFailed(identity: string, oauthAttemptId: string, failureReason: string): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/mark-copilot-oauth-failed`, {
    method: 'POST',
    body: { oauthAttemptId, failureReason },
  });
}
