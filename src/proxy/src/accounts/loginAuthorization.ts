import { HttpApiError, type CreateLoginTaskRequest, type LoginCredentials, type SsoType } from '@ghcp/shared';
import { resolveDefaultLoginPassword } from '../clients/ssoClient.js';
import { beginCopilotOauthAuthorization, getAccount } from '../db/accountsRepo.js';

export type PrepareLoginAuthorizationInput = LoginCredentials & {
  ssoType: SsoType;
  ssoUser: string;
  ghLogin: string;
} & (
  /** Manual re-authorization: supersedes whatever attempt the account currently points at. */
  | { force: true }
  /**
   * Retry of an earlier attempt: only proceeds while the account still points at that attempt
   * (`null` for an account that never had one), so a stale retry cannot hijack a newer authorization.
   */
  | { force?: false; previousAttemptId: string | null }
);

/**
 * Switches the Proxy account to a new authorization attempt and returns the payload Login needs to
 * run it. The account row is the only fence: `copilot_oauth_attempt_id` decides which attempt may
 * still write a token or report a failure, and a forced begin simply replaces it.
 */
export async function prepareLoginAuthorization(
  identity: string,
  attemptId: string,
  input: PrepareLoginAuthorizationInput,
): Promise<CreateLoginTaskRequest> {
  const account = await getAccount(identity);
  if (!account) throw new HttpApiError(404, 'account_not_found', 'The Proxy account no longer exists.');
  if (account.ssoUser !== input.ssoUser || account.ghLogin !== input.ghLogin) {
    throw new HttpApiError(409, 'account_mapping_changed', 'The account mapping changed. Open the current account to reauthorize.');
  }
  if (!input.force) {
    if (account.copilotOauthStatus === 'valid') {
      throw new HttpApiError(409, 'authorization_not_needed', 'The account is already authorized. Reauthorize it from the account if a new token is required.');
    }
    if ((account.copilotOauthAttemptId ?? null) !== input.previousAttemptId) {
      throw new HttpApiError(409, 'authorization_conflict', 'Another authorization changed this account. Refresh before retrying.');
    }
  }
  if (input.credentialMode === 'default' && input.ssoType !== 'custom') {
    throw new HttpApiError(409, 'password_override_required', 'Azure login requires an explicit password override.');
  }
  const password = input.credentialMode === 'override' ? input.ssoPassword : await resolveDefaultLoginPassword(account.ssoUser);
  if (!await beginCopilotOauthAuthorization(identity, attemptId, input.force ? undefined : input.previousAttemptId)) {
    throw new HttpApiError(409, 'authorization_conflict', 'Another authorization changed this account. Refresh before retrying.');
  }
  return {
    identity, oauthAttemptId: attemptId, ssoUser: account.ssoUser, ghLogin: input.ghLogin,
    ssoType: input.ssoType, ssoPassword: password,
  };
}
