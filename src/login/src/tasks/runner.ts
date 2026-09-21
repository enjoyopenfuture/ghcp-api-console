import type { CreateLoginTaskRequest } from '@ghcp/shared';
import { HttpApiError, loggerFor, redactSecrets } from '@ghcp/shared';
import { config, type RuntimeAuthConfig } from '../config.js';
import { loginRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import { HeadlessPlaywrightAuthStrategy } from '../auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from '../auth/deviceFlow.js';
import { saveCopilotOauthToken } from '../clients/proxyClient.js';
import { markFailed, markRunning, markSuccess, setStage, type LoginTaskRecord } from '../db/tasksRepo.js';
import { AccountLogger } from './accountLogger.js';

const stdoutLogger = loggerFor('login', 'runner');

export interface RuntimeTaskPayload extends CreateLoginTaskRequest {
  taskId: string;
  signal?: AbortSignal;
}

export async function runLoginTask(task: LoginTaskRecord, payload: RuntimeTaskPayload): Promise<void> {
  const runtimeSettings = loginRuntimeSettings.getSnapshot();
  const logger = AccountLogger.create(config.logDir, payload.ssoUser, runtimeSettings.authDebugLogs, `${task.id}-${payload.oauthAttemptId}`,
    (stage) => setStage(task.id, payload.oauthAttemptId, stage), [payload.ssoPassword]);
  if (!markRunning(task.id, logger.path, payload.oauthAttemptId)) return;
  stdoutLogger.info('running', 'Login task marked running', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, logPath: logger.path });
  let writingToken = false;
  try {
    payload.signal?.throwIfAborted();
    if (!payload.ssoPassword) throw new Error('ssoPassword is required to run a login task.');
    if (!payload.ghLogin.trim()) throw new Error('ghLogin is required to run a login task.');
    const authConfig: RuntimeAuthConfig = {
      ...config.auth,
      ssoUrl: payload.ssoUrl ?? config.auth.ssoUrl,
      ssoProvider: payload.ssoType === 'azure' ? 'azure' as const : 'custom' as const,
      timeoutMs: runtimeSettings.authTimeoutMs,
      debugLogs: runtimeSettings.authDebugLogs,
      debugArtifacts: runtimeSettings.authDebugArtifacts,
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
      undefined,
      payload.signal,
    );
    payload.signal?.throwIfAborted();
    setStage(task.id, payload.oauthAttemptId, 'saving-token');
    writingToken = true;
    await saveCopilotOauthToken(payload.identity, payload.oauthAttemptId, copilotOauthToken, payload.ghLogin);
    markSuccess(task.id, payload.oauthAttemptId);
    logger.info('complete', 'Login task completed and Copilot OAuth token was written back to Proxy');
    stdoutLogger.info('success', 'Login task completed and Copilot OAuth token was written back to Proxy', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, logPath: logger.path });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(rawMessage, [payload.ssoPassword]);
    // A cancelled run is closed out by the queue once this promise settles; do not overwrite it here.
    if (payload.signal?.aborted) throw payload.signal.reason;
    // When the token write itself failed the outcome at Proxy is unknown. The task is failed and the
    // queue reports the attempt failed to Proxy; that report is fenced on the attempt id, so a write
    // that did land is kept and only this task record shows the failure.
    markFailed(task.id, message, payload.oauthAttemptId, writingToken ? 'token_write_failed' : err instanceof HttpApiError ? err.code : 'login_failed');
    logger.error('failed', 'Login task failed', { error: message });
    stdoutLogger.error('failed', 'Login task failed', { taskId: task.id, identity: payload.identity, ssoUser: payload.ssoUser, ghLogin: payload.ghLogin, error: message, logPath: logger.path });
    throw new Error(message);
  }
}
