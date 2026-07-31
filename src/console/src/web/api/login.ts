import type { LoginRuntimeSettingsDto, LoginTaskDto, LoginTaskStatus, PageResponse, SsoType, UpdateLoginRuntimeSettingsRequest } from '@ghcp/shared';
import { api } from './client.js';

export function listLoginTasks(limit = 100): Promise<LoginTaskDto[]> {
  return api<LoginTaskDto[]>(`/api/console/login-service/tasks?limit=${encodeURIComponent(String(limit))}`);
}

export function getLoginRuntimeSettings(): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>('/api/console/login-service/settings/runtime');
}

export function updateLoginRuntimeSettings(body: UpdateLoginRuntimeSettingsRequest): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>('/api/console/login-service/settings/runtime', { method: 'PATCH', body: JSON.stringify(body) });
}

export function listLoginTasksPage(params: { q?: string; status?: LoginTaskStatus | ''; page?: number; pageSize?: number } = {}): Promise<PageResponse<LoginTaskDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return api<PageResponse<LoginTaskDto>>(`/api/console/login-service/tasks?${search.toString()}`);
}

export function cancelLoginTask(id: string): Promise<LoginTaskDto> {
  return api<LoginTaskDto>(`/api/console/login-service/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
}

export function deleteLoginTask(id: string): Promise<void> {
  return api<void>(`/api/console/login-service/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function retryLoginTask(id: string, body: { ssoPassword: string; ssoType?: SsoType }): Promise<LoginTaskDto> {
  return api<LoginTaskDto>(`/api/console/login-service/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(body) });
}
