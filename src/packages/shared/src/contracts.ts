export type CopilotOauthStatus = 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
export type EmuStatus = 'active' | 'suspended' | 'deleted' | 'not_synced';
export type CopilotSeatStatus = 'unknown' | 'assigned' | 'unassigned' | 'assign_failed' | 'remove_failed';
export type CopilotSeatOperation = 'assign' | 'remove';
export type LoginTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type SsoType = 'azure' | 'custom';
export type AccountType = 'business' | 'enterprise';

export interface RequestIdentity {
  identity: string;
  apiKeyName?: string;
}

export interface ProxyAccountDto {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteProxyAccountResult {
  identity: string;
  deletedRequestStats: number;
}

export interface ImportCopilotOauthTokensRequest {
  csvText: string;
}

export type ImportCopilotOauthTokenRowStatus = 'success' | 'failed';

export interface ImportCopilotOauthTokenRow {
  line: number;
  name: string;
  status: ImportCopilotOauthTokenRowStatus;
  detail: string;
  account?: ProxyAccountDto;
}

export interface ProxyRequestStatDto {
  id: string;
  identity: string;
  ghLogin?: string;
  requestedAt: string;
  path: '/chat/completions' | '/v1/messages' | '/v1/messages/count_tokens' | '/responses' | '/v1/models';
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface SsoUserDto {
  ssoUser: string;
  email: string;
  role: 'user' | 'admin';
  ghLogin?: string;
  ghScimId?: string;
  emuStatus: EmuStatus;
  copilotSeatStatus: CopilotSeatStatus;
  copilotSeatLastOperation?: CopilotSeatOperation;
  copilotSeatLastError?: string;
  copilotSeatUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnsureSsoUserRequest {
  identity: string;
  preferredSsoUser?: string;
}

export interface EnsureSsoUserResponse {
  user: SsoUserDto;
  passwordForLogin?: string;
  created: boolean;
}

export type SsoUserBatchOperation = 'sync_emu' | 'suspend_emu' | 'delete_emu' | 'delete_sso' | 'assign_copilot' | 'remove_copilot';
export type SsoUserBatchRowStatus = 'success' | 'failed';

export interface SsoUserBatchRequest {
  operation: SsoUserBatchOperation;
  ssoUsers: string[];
  enterpriseRole?: 'user' | 'enterprise_owner';
}

export interface SsoUserBatchRow {
  ssoUser: string;
  status: SsoUserBatchRowStatus;
  detail: string;
  warning?: string;
  user?: SsoUserDto;
}

export interface ImportEmuUsersRequest {
  ssoUser?: string;
  dryRun?: boolean;
}

export type ImportEmuUserStatus = 'pending_create' | 'pending_update' | 'created' | 'updated' | 'skipped' | 'conflict' | 'failed';
export type ImportEmuPlanStatus = 'planned' | 'applied';

export interface CreateImportEmuPlanRequest {
  ssoUser?: string;
}

export interface ImportEmuUserRow {
  rowIndex?: number;
  ssoUser: string;
  email?: string;
  ghLogin?: string;
  ghScimId?: string;
  emuStatus?: EmuStatus;
  copilotSeatStatus?: 'assigned' | 'unassigned';
  status: ImportEmuUserStatus;
  detail: string;
  passwordForLogin?: string;
}

export interface ImportEmuPlanSummary {
  total: number;
  pendingCreate: number;
  pendingUpdate: number;
  created: number;
  updated: number;
  skipped: number;
  conflict: number;
  failed: number;
  actionable: number;
}

export interface ImportEmuPlanDto {
  planId: string;
  ssoUser?: string;
  status: ImportEmuPlanStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  summary: ImportEmuPlanSummary;
}

export interface AiCreditsPeriodUsageDto {
  year: number;
  month: number;
  quantity: number;
  unitType?: string;
  fetchedAt?: string;
}

export interface AiCreditsUsageDto {
  enterprise: string;
  lastMonth: AiCreditsPeriodUsageDto;
  currentMonth: AiCreditsPeriodUsageDto;
  projectedCurrentMonthQuantity: number;
  assignedSeatCount: number;
  assignedSeatMonthlyCost: number;
  seatPricePerMonth: number;
  fetchedAt: string;
}

export interface CreateLoginTaskRequest {
  identity: string;
  ssoUser: string;
  ssoPassword: string;
  ghLogin: string;
  oauthAttemptId: string;
  ssoType: SsoType;
  ssoUrl?: string;
  accountType?: AccountType;
  selectorOverrides?: Record<string, string>;
}

export interface LoginTaskDto {
  id: string;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  oauthAttemptId?: string;
  ssoType: SsoType;
  status: LoginTaskStatus;
  attempts: number;
  failureReason?: string;
  logPath?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
