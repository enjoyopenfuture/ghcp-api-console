import { JsonHttpClient, type CreateLoginTaskRequest, type LoginCredentials, type LoginTaskDto } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

/**
 * Asks Proxy to switch the account to a new attempt and to resolve the password for it. Proxy only
 * agrees while the account still points at the attempt this task ran before, so a retry of a stale
 * task cannot take over an authorization that was started elsewhere in the meantime.
 */
export function prepareLoginRetry(task: LoginTaskDto, attemptId: string, credentials: LoginCredentials, previousAttemptId: string | null): Promise<CreateLoginTaskRequest> {
  return client.request(`/internal/accounts/${encodeURIComponent(task.identity)}/oauth-attempts/${encodeURIComponent(attemptId)}/prepare`, {
    method: 'POST', body: { ...credentials, ssoUser: task.ssoUser, ghLogin: task.ghLogin, ssoType: task.ssoType, previousAttemptId },
  });
}

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
