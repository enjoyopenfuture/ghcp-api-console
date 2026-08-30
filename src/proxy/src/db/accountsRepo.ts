import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyAccountDto,
} from '@ghcp/shared';
import { getStorage, initializeStorage } from './connection.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
} from './storageTypes.js';

export type {
  AccountListQuery,
  DeleteAccountsBySsoUserResult,
  ProxyAccountRecord,
} from './storageTypes.js';

export async function listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
  await initializeStorage();
  return getStorage().listAccounts(query);
}

export async function getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
  await initializeStorage();
  return getStorage().getAccount(identity);
}

export async function deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined> {
  await initializeStorage();
  return getStorage().deleteAccount(identity);
}

export async function deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
  await initializeStorage();
  return getStorage().deleteAccountsBySsoUser(ssoUser);
}

export async function createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
  await initializeStorage();
  return getStorage().createAccount(input);
}

export async function importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
  await initializeStorage();
  return getStorage().importCopilotOauthToken(input);
}

export async function saveCopilotOauthToken(
  identity: string,
  oauthAttemptId: string,
  copilotOauthToken: string,
  ghLogin?: string,
): Promise<ProxyAccountRecord | undefined> {
  await initializeStorage();
  return getStorage().saveCopilotOauthToken(identity, oauthAttemptId, copilotOauthToken, ghLogin);
}

export async function markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
  await initializeStorage();
  await getStorage().markCopilotOauthStatus(identity, status);
}

export async function beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().beginCopilotOauthAuthorization(identity, oauthAttemptId);
}

export async function failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().failCopilotOauthAuthorization(identity, oauthAttemptId);
}

export async function invalidateCopilotOauthToken(
  identity: string,
  expectedToken: string,
  status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
): Promise<boolean> {
  await initializeStorage();
  return getStorage().invalidateCopilotOauthToken(identity, expectedToken, status);
}

export async function claimIdentityInitialization(
  identity: string,
  claimId: string,
  leaseSeconds: number,
): Promise<boolean> {
  await initializeStorage();
  return getStorage().claimIdentityInitialization(identity, claimId, leaseSeconds);
}

export async function releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().releaseIdentityInitialization(identity, claimId);
}

export function toAccountDto(account: ProxyAccountRecord): ProxyAccountDto {
  return {
    identity: account.identity,
    ssoUser: account.ssoUser,
    ghLogin: account.ghLogin,
    copilotOauthStatus: account.copilotOauthStatus,
    copilotOauthUpdatedAt: account.copilotOauthUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
