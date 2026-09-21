import type { LoginRuntimeSettingsDto, LoginTaskDto, UpdateLoginRuntimeSettingsRequest } from '@ghcp/shared';
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
