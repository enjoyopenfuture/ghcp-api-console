import type { CreateLoginTaskRequest } from '@ghcp/shared';
import { loggerFor } from '@ghcp/shared';
import { config } from '../config.js';
import { HeadlessPlaywrightAuthStrategy } from '../auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from '../auth/deviceFlow.js';
import { saveCopilotOauthToken } from '../clients/proxyClient.js';
import { markFailed, markRunning, markSuccess, type LoginTaskRecord } from '../db/tasksRepo.js';
import { AccountLogger } from './accountLogger.js';

const stdoutLogger = loggerFor('login', 'runner');

export interface RuntimeTaskPayload extends CreateLoginTaskRequest {
  taskId: string;
}

export async function runLoginTask(task: LoginTaskRecord, payload: RuntimeTaskPayload): Promise<void> {
  const logger = AccountLogger.create(config.logDir, payload.ssoUser, config.auth.debugLogs);
  markRunning(task.id, logger.path);
  stdoutLogger.info('running', 'Login task marked running', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, logPath: logger.path });
  try {
    if (!payload.ssoPassword) throw new Error('ssoPassword is required to run a login task.');
    if (!payload.ghLogin.trim()) throw new Error('ghLogin is required to run a login task.');
    const authConfig = {
      ...config.auth,
      ssoUrl: payload.ssoUrl ?? config.auth.ssoUrl,
      ssoProvider: payload.ssoType === 'azure' ? 'azure' as const : 'custom' as const,
      selectors: { ...config.auth.selectors, ...payload.selectorOverrides },
    };
    const copilotOauthToken = await loginWithDeviceFlow(
      new HeadlessPlaywrightAuthStrategy(
        authConfig,
        {
          githubUsername: payload.ghLogin,
          ssoUsername: payload.ssoUser,
          ssoPassword: payload.ssoPassword,
        },
        logger,
      ),
      logger,
    );
    await saveCopilotOauthToken(payload.identity, payload.oauthAttemptId, copilotOauthToken, payload.ghLogin);
    markSuccess(task.id);
    logger.info('complete', 'Login task completed and Copilot OAuth token was written back to Proxy');
    stdoutLogger.info('success', 'Login task completed and Copilot OAuth token was written back to Proxy', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, logPath: logger.path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markFailed(task.id, message);
    logger.error('failed', 'Login task failed', { error: message });
    stdoutLogger.error('failed', 'Login task failed', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, error: message, logPath: logger.path });
    throw err;
  }
}
