import type { AiCreditsUsageDto, BatchResult, CreateImportEmuPlanRequest, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUsersRequest, ImportEmuUserStatus, PageResponse, SsoRuntimeSettingsDto, SsoUserBatchRequest, SsoUserBatchRow, SsoUserCapacityDto, SsoUserDto, UpdateSsoRuntimeSettingsRequest } from '@ghcp/shared';
import { api } from './client.js';

export interface ListUsersQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function listSsoUsers(params: ListUsersQuery = {}): Promise<PageResponse<SsoUserDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return api<PageResponse<SsoUserDto>>(`/api/console/sso/users${query ? `?${query}` : ''}`);
}

export function getSsoUserCapacity(): Promise<SsoUserCapacityDto> {
  return api<SsoUserCapacityDto>('/api/console/sso/users/capacity');
}

export function getSsoRuntimeSettings(): Promise<SsoRuntimeSettingsDto> {
  return api<SsoRuntimeSettingsDto>('/api/console/sso/settings/runtime');
}

export function updateSsoRuntimeSettings(body: UpdateSsoRuntimeSettingsRequest): Promise<SsoRuntimeSettingsDto> {
  return api<SsoRuntimeSettingsDto>('/api/console/sso/settings/runtime', { method: 'PATCH', body: JSON.stringify(body) });
}

export function createSsoUser(body: { ssoUser: string; password?: string; email?: string; role?: 'user' | 'admin' }): Promise<SsoUserDto> {
  return api<SsoUserDto>('/api/console/sso/users', { method: 'POST', body: JSON.stringify(body) });
}

export function importSsoUsers(csvText: string): Promise<BatchResult<{ line: number; ssoUser: string; status: string; detail: string }>> {
  return api<BatchResult<{ line: number; ssoUser: string; status: string; detail: string }>>('/api/console/sso/users/import', {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export function importEmuUsers(body: ImportEmuUsersRequest = {}): Promise<BatchResult<ImportEmuUserRow>> {
  return api<BatchResult<ImportEmuUserRow>>('/api/console/sso/users/emu/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createEmuImportPlan(body: CreateImportEmuPlanRequest = {}): Promise<ImportEmuPlanDto> {
  return api<ImportEmuPlanDto>('/api/console/sso/users/emu/import/plans', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function listEmuImportPlanRows(planId: string, params: { page?: number; pageSize?: number; status?: ImportEmuUserStatus | '' } = {}): Promise<PageResponse<ImportEmuUserRow>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return api<PageResponse<ImportEmuUserRow>>(`/api/console/sso/users/emu/import/plans/${encodeURIComponent(planId)}/rows${query ? `?${query}` : ''}`);
}

export function applyEmuImportPlan(planId: string): Promise<ImportEmuPlanDto> {
  return api<ImportEmuPlanDto>(`/api/console/sso/users/emu/import/plans/${encodeURIComponent(planId)}/apply`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function deleteEmuImportPlan(planId: string): Promise<void> {
  return api<void>(`/api/console/sso/users/emu/import/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
}

export function patchSsoUser(ssoUser: string, body: { password?: string; email?: string; role?: 'user' | 'admin' }): Promise<SsoUserDto> {
  return api<SsoUserDto>(`/api/console/sso/users/${encodeURIComponent(ssoUser)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function runSsoUserBatch(body: SsoUserBatchRequest): Promise<BatchResult<SsoUserBatchRow>> {
  return api<BatchResult<SsoUserBatchRow>>('/api/console/sso/users/batch', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function readAiCreditsUsage(): Promise<AiCreditsUsageDto> {
  return api<AiCreditsUsageDto>('/api/console/sso/ai-credits/usage');
}

export function refreshAiCreditsUsage(): Promise<AiCreditsUsageDto> {
  return api<AiCreditsUsageDto>('/api/console/sso/ai-credits/usage/refresh', { method: 'POST', body: JSON.stringify({}) });
}
