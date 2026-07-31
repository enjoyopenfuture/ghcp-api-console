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

export type ProxyErrorDiagnosticFailureKind = 'http' | 'fetch' | 'stream';

export interface HttpHeaderPair {
  name: string;
  value: string;
}

export interface ProxyErrorDiagnosticBodyDto {
  encoding: 'base64' | 'utf8' | 'unavailable';
  data?: string;
  byteLength: number;
  capturedByteLength: number;
  truncated: boolean;
  complete: boolean;
  unavailableReason?: string;
}

export interface ProxyErrorDiagnosticRequestDto {
  method: string;
  url: string;
  headers: HttpHeaderPair[];
  body?: ProxyErrorDiagnosticBodyDto;
}

export interface ProxyErrorDiagnosticResponseDto {
  status: number;
  statusText: string;
  headers: HttpHeaderPair[];
  body?: ProxyErrorDiagnosticBodyDto;
}

export interface ProxyErrorDiagnosticThrownErrorDto {
  name: string;
  message: string;
  stack?: string;
  cause?: string;
}

export interface ProxyErrorDiagnosticRecordDto {
  id: string;
  timestamp: string;
  failureKind: ProxyErrorDiagnosticFailureKind;
  identity: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  redacted: boolean;
  inboundRequest: ProxyErrorDiagnosticRequestDto;
  upstreamRequest: ProxyErrorDiagnosticRequestDto;
  upstreamResponse?: ProxyErrorDiagnosticResponseDto;
  error?: ProxyErrorDiagnosticThrownErrorDto;
}

export interface ProxyErrorDiagnosticSummaryDto {
  id: string;
  timestamp: string;
  failureKind: ProxyErrorDiagnosticFailureKind;
  identity: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  status?: number;
  redacted: boolean;
  inboundRequestBodyBytes: number;
  upstreamRequestBodyBytes: number;
  upstreamResponseBodyBytes: number;
}

export interface ProxyErrorDiagnosticDetailDto extends ProxyErrorDiagnosticSummaryDto {
  content: string;
}

export interface ProxyErrorDiagnosticsListResponse {
  enabled: boolean;
  redacted: boolean;
  items: ProxyErrorDiagnosticSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClearProxyErrorDiagnosticsRequest {
  confirm: true;
}

export interface ClearProxyErrorDiagnosticsResponse {
  cleared: true;
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

export interface SsoUserCapacityDto {
  current: number;
  limit: number | null;
  remaining: number | null;
  reached: boolean;
}

export interface SsoRuntimeSettingsValues {
  maxSsoUsers: number | null;
  userPrefix: string;
  emailDomain: string;
  bulkSyncConcurrency: number;
  scimRequestDelayMs: number;
  scimMaxRetries: number;
  scimRetryBaseDelayMs: number;
}

export interface SsoRuntimeSettingsDto extends SsoRuntimeSettingsValues {
  version: number;
  updatedAt: string;
}

export interface UpdateSsoRuntimeSettingsRequest {
  expectedVersion: number;
  changes: Partial<SsoRuntimeSettingsValues>;
}

export interface LoginRuntimeSettingsValues {
  concurrency: number;
  authTimeoutMs: number;
  authDebugLogs: boolean;
  authDebugArtifacts: boolean;
}

export interface LoginRuntimeSettingsDto extends LoginRuntimeSettingsValues {
  version: number;
  updatedAt: string;
}

export interface UpdateLoginRuntimeSettingsRequest {
  expectedVersion: number;
  changes: Partial<LoginRuntimeSettingsValues>;
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
