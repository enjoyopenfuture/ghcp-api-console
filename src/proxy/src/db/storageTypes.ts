import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyRequestStatDto,
} from '@ghcp/shared';

export interface ProxyAccountRecord {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  copilotOauthAttemptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'copilotOauthStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface CreateAccountInput {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus?: CopilotOauthStatus;
  copilotOauthAttemptId?: string;
}

export interface ImportCopilotOauthTokenInput {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export interface RecordRequestStatInput {
  identity: string;
  ghLogin?: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface ProxyStorage {
  initialize(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  listAccounts(query?: AccountListQuery): Promise<PageResponse<ProxyAccountRecord>>;
  getAccount(identity: string): Promise<ProxyAccountRecord | undefined>;
  deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined>;
  deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult>;
  createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord>;
  importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord>;
  saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined>;
  markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void>;
  beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean>;
  failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean>;
  invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean>;

  claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number): Promise<boolean>;
  releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean>;

  recordRequestStat(input: RecordRequestStatInput): Promise<void>;
  listRequestStats(identity?: string, limit?: number): Promise<ProxyRequestStatDto[]>;
  pruneAllRequestStats(): Promise<void>;
}
