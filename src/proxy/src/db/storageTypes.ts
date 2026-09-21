import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyRequestStatDto,
  ManagementQuery,
  ManagementSummary,
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

export interface AccountListQuery extends ManagementQuery { }

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
  withReadSnapshot<T>(read: (reader: Pick<ProxyStorage, 'listAccounts' | 'listRequestStatsPage'>) => Promise<T>): Promise<T>;
  initialize(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  listAccounts(query?: AccountListQuery): Promise<PageResponse<ProxyAccountRecord>>;
  summarizeAccounts(): Promise<ManagementSummary>;
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
  /**
   * Switches the account to a new authorization attempt. When `expectedAttemptId` is given (a string
   * or `null`), the switch only happens if the account still points at that attempt, so a stale
   * caller cannot supersede an authorization it does not know about; `undefined` forces the switch.
   */
  beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, expectedAttemptId?: string | null): Promise<boolean>;
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
  listRequestStatsPage(query?: ManagementQuery): Promise<PageResponse<ProxyRequestStatDto>>;
  pruneAllRequestStats(): Promise<void>;
}
