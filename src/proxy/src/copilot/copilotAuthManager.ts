import { randomUUID } from 'node:crypto';
import { HttpApiError, readLoginCredentials, type CreateLoginTaskRequest, type EnsureSsoUserResponse, type LoginTaskDto, type SsoType } from '@ghcp/shared';
import {
  claimIdentityInitialization,
  createAccount,
  failCopilotOauthAuthorization,
  getAccount,
  invalidateCopilotOauthToken,
  releaseIdentityInitialization,
} from '../db/accountsRepo.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { createLoginTask } from '../clients/loginClient.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import type { CopilotAuthContext } from './copilotAuth.js';
import { prepareLoginAuthorization } from '../accounts/loginAuthorization.js';

export class CopilotAuthNotReadyError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'account_initializing' | 'account_limit_reached' | 'oauth_not_ready',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CopilotAuthNotReadyError';
  }
}

class CopilotAuthManager {
  private readonly logger = new Logger('copilot-auth-manager');
  private readonly initializing = new Map<string, { prepared: Promise<void>; completed: Promise<void> }>();

  async getAuth(identity: string): Promise<CopilotAuthContext> {
    const account = await getAccount(identity);
    if (!account) {
      try {
        await this.beginIdentityInitialization(identity);
      } catch (err) {
        if (err instanceof HttpApiError && err.code === 'sso_user_limit_reached') {
          throw new CopilotAuthNotReadyError(409, 'account_limit_reached', err.message, err.details);
        }
        throw err;
      }
      throw new CopilotAuthNotReadyError(202, 'account_initializing', 'Account initialization has started.');
    }
    if (!account.copilotOauthToken || account.copilotOauthStatus !== 'valid') {
      const initializing = account.copilotOauthStatus === 'refreshing';
      throw new CopilotAuthNotReadyError(
        initializing ? 202 : 503,
        initializing ? 'account_initializing' : 'oauth_not_ready',
        initializing
          ? 'Copilot OAuth authorization is in progress for this identity.'
          : 'Copilot OAuth authorization is required for this identity.',
      );
    }
    return {
      identity,
      accessToken: account.copilotOauthToken,
      api: config.copilotApiBaseUrl,
    };
  }

  async triggerOauthRefresh(identity: string, options: { ssoPassword?: string; ssoType?: SsoType; credentialMode?: 'default' | 'override' } = {}): Promise<LoginTaskDto> {
    const account = await getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    const oauthAttemptId = randomUUID();
    const payload = await prepareLoginAuthorization(identity, oauthAttemptId, {
      ...readLoginCredentials(options), ssoUser: account.ssoUser, ghLogin: account.ghLogin,
      ssoType: options.ssoType ?? 'custom', force: true,
    });
    return this.submitLogin(payload);
  }

  private async submitLogin(payload: CreateLoginTaskRequest): Promise<LoginTaskDto> {
    try { return await createLoginTask(payload); }
    catch (err) {
      // Login did not accept the task, so the account must not stay `refreshing`. The rollback is
      // fenced on the attempt id: if Login did accept it and already wrote the token, this is a no-op.
      await failCopilotOauthAuthorization(payload.identity, payload.oauthAttemptId).catch((rollbackErr: unknown) => {
        this.logger.error('rollback-failed', 'Could not mark the authorization attempt failed after a rejected Login submission; reauthorize the account manually if it stays refreshing', {
          identity: payload.identity, oauthAttemptId: payload.oauthAttemptId,
          submissionError: err instanceof Error ? err.message : String(err),
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      });
      throw err;
    }
  }

  invalidate(identity: string, expectedToken: string): Promise<boolean> {
    return invalidateCopilotOauthToken(identity, expectedToken, 'expired');
  }

  private async beginIdentityInitialization(identity: string): Promise<void> {
    const existing = this.initializing.get(identity);
    if (existing) return existing.prepared;

    const claimId = randomUUID();
    const claimed = await claimIdentityInitialization(identity, claimId, config.identityInitLeaseSeconds);
    if (!claimed) return;

    this.logger.info('identity-init', 'Initializing unknown identity', { identity });
    const ensured = ensureSsoUser({ identity, preferredSsoUser: ssoUserFromIdentity(identity) });
    const prepared = ensured.then(() => undefined);
    const completed = ensured.then((result) => this.initializeEnsuredIdentity(identity, result));
    const state = { prepared, completed };
    this.initializing.set(identity, state);
    void completed
      .catch((err: unknown) => {
        this.logger.error('identity-init', 'Identity initialization failed', {
          identity,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(async () => {
        if (this.initializing.get(identity) === state) this.initializing.delete(identity);
        try {
          await releaseIdentityInitialization(identity, claimId);
        } catch (err) {
          this.logger.error('identity-init-release', 'Failed to release identity initialization claim', {
            identity,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return prepared;
  }

  private async initializeEnsuredIdentity(identity: string, ensured: EnsureSsoUserResponse): Promise<void> {
    const synced = await syncEmuUser(ensured.user.ssoUser, { assignCopilotSeat: true });
    if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);
    const oauthAttemptId = randomUUID();
    const ssoPassword = ensured.passwordForLogin;
    await createAccount({
      identity,
      ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin,
      copilotOauthStatus: ssoPassword ? 'missing' : 'failed',
    });
    if (!ssoPassword) {
      throw new Error(`SSO password is required to initialize identity "${identity}"; reauthorize it from Console with an explicit password.`);
    }
    // The row was created (or re-created) by this initialization, so there is no earlier attempt to respect.
    const payload = await prepareLoginAuthorization(identity, oauthAttemptId, {
      credentialMode: 'override', ssoPassword, ssoUser: ensured.user.ssoUser, ghLogin: synced.ghLogin, ssoType: 'custom', force: true,
    });
    await this.submitLogin(payload);
  }
}

function ssoUserFromIdentity(identity: string): string {
  const normalized = identity
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized).slice(0, 32);
}

function stripEnterpriseShortcode(value: string): string {
  const shortcode = config.enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}

export const copilotAuthManager = new CopilotAuthManager();
