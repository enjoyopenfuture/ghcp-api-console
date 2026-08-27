import { randomUUID } from 'node:crypto';
import { HttpApiError, type EnsureSsoUserResponse, type SsoType } from '@ghcp/shared';
import {
  beginCopilotOauthAuthorization,
  createAccount,
  failCopilotOauthAuthorization,
  getAccount,
  invalidateCopilotOauthToken,
} from '../db/accountsRepo.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { createLoginTask } from '../clients/loginClient.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import type { CopilotAuthContext } from './copilotAuth.js';

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
    const account = getAccount(identity);
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

  async triggerOauthRefresh(identity: string, options: { ssoPassword?: string; ssoType?: SsoType } = {}): Promise<void> {
    const account = getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    if (!options.ssoPassword) throw new Error('ssoPassword is required to reauthorize Copilot OAuth.');
    const oauthAttemptId = randomUUID();
    if (!beginCopilotOauthAuthorization(identity, oauthAttemptId)) {
      throw new Error(`Unknown identity "${identity}".`);
    }
    try {
      await createLoginTask({
        identity,
        ssoUser: account.ssoUser,
        ssoPassword: options.ssoPassword,
        ghLogin: account.ghLogin,
        oauthAttemptId,
        ssoType: options.ssoType ?? 'custom',
      });
    } catch (err) {
      failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw err;
    }
  }

  invalidate(identity: string, expectedToken: string): boolean {
    return invalidateCopilotOauthToken(identity, expectedToken, 'expired');
  }

  private beginIdentityInitialization(identity: string): Promise<void> {
    const existing = this.initializing.get(identity);
    if (existing) return existing.prepared;

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
      .finally(() => {
        if (this.initializing.get(identity) === state) this.initializing.delete(identity);
      });
    return prepared;
  }

  private async initializeEnsuredIdentity(identity: string, ensured: EnsureSsoUserResponse): Promise<void> {
    const synced = await syncEmuUser(ensured.user.ssoUser, { assignCopilotSeat: true });
    if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);
    const oauthAttemptId = randomUUID();
    createAccount({
      identity,
      ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin,
      copilotOauthStatus: 'refreshing',
      copilotOauthAttemptId: oauthAttemptId,
    });
    const ssoPassword = ensured.passwordForLogin;
    if (!ssoPassword) {
      failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw new Error(`SSO password is required to initialize identity "${identity}"; reauthorize it from Console with an explicit password.`);
    }
    try {
      await createLoginTask({
        identity,
        ssoUser: ensured.user.ssoUser,
        ssoPassword,
        ghLogin: synced.ghLogin,
        oauthAttemptId,
        ssoType: 'custom',
      });
    } catch (err) {
      failCopilotOauthAuthorization(identity, oauthAttemptId);
      throw err;
    }
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
