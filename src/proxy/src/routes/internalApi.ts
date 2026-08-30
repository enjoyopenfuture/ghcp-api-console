import { Router } from 'express';
import { apiError } from '@ghcp/shared';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { deleteAccountsBySsoUser, failCopilotOauthAuthorization, getAccount, saveCopilotOauthToken, toAccountDto } from '../db/accountsRepo.js';
import { Logger } from '../logger.js';

export const internalApiRouter = Router();
const logger = new Logger('internal-api');

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
