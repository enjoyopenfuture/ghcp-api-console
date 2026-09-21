import { HttpApiError, JsonHttpClient, loggerFor, redactSecrets, type CreateLoginTaskRequest, type LoginTaskDto } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.loginBaseUrl,
  internalToken: config.internalApiToken,
});

export async function createLoginTask(request: CreateLoginTaskRequest): Promise<LoginTaskDto> {
  try {
    return await client.request<LoginTaskDto>('/api/tasks', { method: 'POST', body: request });
  } catch (submissionError) {
    if (submissionError instanceof HttpApiError && submissionError.status < 500 && submissionError.status !== 408) throw submissionError;
    try {
      return await getLoginTaskByAttempt(request.oauthAttemptId);
    } catch (lookupError) {
      loggerFor('proxy', 'login-client').warn('submission-unconfirmed', 'Could not reconcile the login submission response', {
        identity: request.identity, attemptId: request.oauthAttemptId,
        error: redactSecrets(lookupError instanceof Error ? lookupError.message : String(lookupError), [request.ssoPassword]),
      });
      throw new HttpApiError(502, 'login_submission_unconfirmed', 'The Login submission response could not be confirmed; inspect this account and its Login tasks before retrying.');
    }
  }
}

export function getLoginTaskByAttempt(attemptId: string): Promise<LoginTaskDto> {
  return client.request(`/api/tasks/by-attempt/${encodeURIComponent(attemptId)}`);
}
