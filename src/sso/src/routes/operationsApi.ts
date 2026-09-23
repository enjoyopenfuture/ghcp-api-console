import { HttpApiError, operationRoutes, resolveOperationSelection, withSqliteReadSnapshot, type SsoUserBatchOperation } from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import { getUser, listUsers } from '../db/usersRepo.js';
import { runSsoUserBatch } from '../users/service.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';

const actions: SsoUserBatchOperation[] = ['sync_emu', 'suspend_emu', 'delete_emu', 'delete_sso', 'assign_copilot', 'remove_copilot'];

export const userOperationsRouter = operationRoutes({
  scope: 'users', actions,
  resolve: (selection) => withSqliteReadSnapshot(getDb(), (database) => resolveOperationSelection(selection, async (query) => listUsers(query, database), (user) => user.ssoUser)),
  async snapshot(id) {
    const user = getUser(id);
    return { revision: user ? JSON.stringify([user.updatedAt, user.ghLogin, user.emuStatus, user.copilotSeatStatus, user.copilotSeatPendingCancellationDate, user.role, user.email]) : undefined, label: id };
  },
  concurrency: (action) => action === 'sync_emu' ? getSsoRuntimeSettings().bulkSyncConcurrency : 1,
  async eligibility(_action, id) { return getUser(id) ? undefined : 'The SSO user was removed.'; },
  prepareExecution(input) {
    if (input.assignCopilotSeat !== undefined && typeof input.assignCopilotSeat !== 'boolean') {
      throw new HttpApiError(400, 'invalid_assign_copilot_seat', 'assignCopilotSeat must be a boolean.');
    }
    const assignCopilotSeat = input.assignCopilotSeat as boolean | undefined;
    return async (action, item) => {
      const operation = actions.find((entry) => entry === action);
      if (!operation) throw new HttpApiError(400, 'invalid_operation', 'Unknown SSO operation.');
      const result = await runSsoUserBatch({ operation, ssoUsers: [item.id], assignCopilotSeat });
      const row = result.rows[0];
      if (!row) throw new Error('SSO operation did not return an item result.');
      return {
        ...item, status: row.status,
        detail: `${row.detail}${row.warning ? ` Warning: ${row.warning}` : ''}${row.status === 'failed' ? ' Some external steps may have completed; check GitHub, seat and Proxy state before retrying.' : ''}`,
      };
    };
  },
});
