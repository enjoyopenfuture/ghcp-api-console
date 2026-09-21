import { HttpApiError, operationRoutes, resolveOperationSelection, type OperationItem } from '@ghcp/shared';
import { deleteAccount, getAccount } from '../db/accountsRepo.js';
import { getStorage } from '../db/connection.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { getLoginTaskByAttempt } from '../clients/loginClient.js';

export const accountOperationsRouter = operationRoutes({
  scope: 'accounts', actions: ['delete', 'reauthorize'],
  resolve: (selection) => getStorage().withReadSnapshot((reader) => resolveOperationSelection(selection, reader.listAccounts, (account) => account.identity)),
  async snapshot(id) {
    const account = await getAccount(id);
    return { revision: account ? JSON.stringify([account.updatedAt, account.ssoUser, account.ghLogin, account.copilotOauthStatus, account.copilotOauthAttemptId]) : undefined, label: id };
  },
  async eligibility(action, id) {
    const account = await getAccount(id);
    if (!account) return 'The Proxy account was removed.';
    if (action === 'reauthorize' && account.copilotOauthStatus === 'refreshing') return 'An authorization is already active.';
    return undefined;
  },
  prepareExecution(input, operationAction) {
    const overrides = new Map<string, string>();
    if (input.overrides !== undefined) {
      if (!Array.isArray(input.overrides) || input.overrides.length > 1000) throw new HttpApiError(400, 'invalid_overrides', 'Invalid password overrides.');
      for (const row of input.overrides) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || typeof row.password !== 'string' || !row.password) {
          throw new HttpApiError(400, 'invalid_overrides', 'Each override needs an account and password.');
        }
        overrides.set(row.id, row.password);
      }
    }
    if (input.ssoType !== undefined && input.ssoType !== 'custom' && input.ssoType !== 'azure') throw new HttpApiError(400, 'invalid_sso_type', 'Invalid SSO type.');
    // Proxy does not store a per-account SSO provider, so there is nothing to fall back to. Defaulting
    // to 'custom' would silently bypass the Azure guard that requires an explicit password, and every
    // Azure account in the batch would fail deep inside the browser automation instead of up front.
    if (operationAction === 'reauthorize' && input.ssoType === undefined) {
      throw new HttpApiError(400, 'sso_type_required', 'Choose the SSO provider (custom or azure) before re-authorizing.');
    }
    const ssoType = input.ssoType === 'azure' ? 'azure' as const : 'custom' as const;
    return async (action, item): Promise<OperationItem> => {
      if (action === 'delete') {
        const result = await deleteAccount(item.id);
        if (!result) return { ...item, status: 'skipped', detail: 'The account was removed.' };
        clearModelsCache(result.identity);
        return { ...item, status: 'success', detail: `Account and ${result.deletedRequestStats} request records deleted. SSO/GH users are unchanged.` };
      }
      const ssoPassword = overrides.get(item.id);
      overrides.delete(item.id);
      const task = await copilotAuthManager.triggerOauthRefresh(item.id, {
        credentialMode: ssoPassword ? 'override' : 'default', ssoPassword, ssoType,
      });
      return { ...item, status: 'running', relatedTaskId: task.id, attemptId: task.oauthAttemptId, detail: 'Waiting for login completion.' };
    };
  },
  async refresh(item) {
    if (!item.relatedTaskId || !item.attemptId) return { ...item, status: 'interrupted', detail: 'No login attempt was recorded.' };
    const task = await getLoginTaskByAttempt(item.attemptId);
    if (task.oauthAttemptId !== item.attemptId) return { ...item, status: 'interrupted', detail: 'A newer login attempt replaced this one.' };
    if (task.status === 'pending' || task.status === 'running' || task.status === 'cancelling') return { ...item, detail: task.stage ?? task.status };
    return { ...item, status: task.status, detail: task.failureReason ?? task.status };
  },
});
