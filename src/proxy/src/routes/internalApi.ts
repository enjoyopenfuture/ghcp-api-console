import { Router } from 'express';
import { apiError, HttpApiError, readLoginCredentials } from '@ghcp/shared';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { deleteAccountsBySsoUser, failCopilotOauthAuthorization, getAccount, saveCopilotOauthToken, toAccountDto } from '../db/accountsRepo.js';
import { prepareLoginAuthorization } from '../accounts/loginAuthorization.js';
import { Logger } from '../logger.js';

export const internalApiRouter = Router();
const logger = new Logger('internal-api');

/**
 * Login calls this to retry a task: Proxy resolves the default SSO password (or takes the override)
 * and switches the account to the new attempt, but only if the account still points at the attempt
 * the task ran before (`previousAttemptId`, `null` for none).
 */
internalApiRouter.post('/accounts/:identity/oauth-attempts/:attemptId/prepare', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body: Record<string, unknown> = req.body ?? {};
    if (!/^[a-f0-9-]{36}$/i.test(req.params.attemptId)
      || typeof body.ssoUser !== 'string' || typeof body.ghLogin !== 'string'
      || (body.ssoType !== 'custom' && body.ssoType !== 'azure')
      || (body.previousAttemptId !== null && typeof body.previousAttemptId !== 'string')) {
      throw new HttpApiError(400, 'invalid_attempt', 'A valid attempt ID, previous attempt, account mapping and SSO type are required.');
    }
    res.json(await prepareLoginAuthorization(req.params.identity, req.params.attemptId, {
      ...readLoginCredentials(body), ssoUser: body.ssoUser, ghLogin: body.ghLogin, ssoType: body.ssoType, previousAttemptId: body.previousAttemptId,
    }));
  } catch (err) {
    logger.warn('prepare-authorization-failed', 'Could not prepare login authorization', { identity: req.params.identity, error: err instanceof Error ? err.message : String(err) });
    res.status(err instanceof HttpApiError ? err.status : 502)
      .json(apiError(err instanceof HttpApiError ? err.code : 'authorization_prepare_failed', err instanceof Error ? err.message : String(err)));
  }
});

internalApiRouter.put('/accounts/:identity/copilot-oauth-token', async (req, res) => {
  const { oauthAttemptId, copilotOauthToken, ghLogin } = req.body as {
    oauthAttemptId?: unknown;
    copilotOauthToken?: unknown;
    ghLogin?: unknown;
  };
  if (typeof oauthAttemptId !== 'string' || !oauthAttemptId.trim()) {
    res.status(400).json(apiError('invalid_oauth_attempt', 'Request body must include a non-empty oauthAttemptId string.'));
    return;
  }
  if (typeof copilotOauthToken !== 'string' || !copilotOauthToken.trim()) {
    res.status(400).json(apiError('invalid_copilot_oauth_token', 'Request body must include a non-empty copilotOauthToken string.'));
    return;
  }
  const account = await saveCopilotOauthToken(
    req.params.identity,
    oauthAttemptId,
    copilotOauthToken,
    typeof ghLogin === 'string' ? ghLogin : undefined,
  );
  if (!account) {
    res.status(409).json(apiError('stale_oauth_attempt', 'This OAuth authorization attempt is no longer active.'));
    return;
  }
  clearModelsCache(req.params.identity);
  logger.info('save-copilot-oauth', 'Saved Copilot OAuth token from login service', {
    identity: req.params.identity,
    ghLogin: account.ghLogin,
    copilotOauthStatus: account.copilotOauthStatus,
  });
  res.json(toAccountDto(account));
});

internalApiRouter.delete('/accounts/by-sso-user/:ssoUser', async (req, res) => {
  const result = await deleteAccountsBySsoUser(req.params.ssoUser);
  logger.info('delete-by-sso-user', 'Deleted proxy account data by SSO user', { ...result });
  res.json(result);
});

internalApiRouter.post('/accounts/:identity/mark-copilot-oauth-failed', async (req, res) => {
  const account = await getAccount(req.params.identity);
  if (!account) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  const { oauthAttemptId } = req.body as { oauthAttemptId?: unknown };
  if (typeof oauthAttemptId !== 'string' || !oauthAttemptId.trim()) {
    res.status(400).json(apiError('invalid_oauth_attempt', 'Request body must include a non-empty oauthAttemptId string.'));
    return;
  }
  const updated = await failCopilotOauthAuthorization(req.params.identity, oauthAttemptId);
  logger.warn(
    updated ? 'mark-copilot-oauth-failed' : 'ignore-stale-copilot-oauth-failure',
    updated
      ? 'Marked Copilot OAuth authorization failed from login service'
      : 'Ignored a stale Copilot OAuth failure because the authorization attempt is no longer active',
    { identity: req.params.identity },
  );
  res.json(toAccountDto((await getAccount(req.params.identity))!));
});
