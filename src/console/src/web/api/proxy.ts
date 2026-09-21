import type {
  BatchResult,
  ClearProxyErrorDiagnosticsResponse,
  ImportCopilotOauthTokenRow,
  ProxyAccountDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyRequestStatDto,
  SsoType,
} from '@ghcp/shared';
import { api, downloadApi } from './client.js';

export function getProxyAccount(identity: string, signal?: AbortSignal): Promise<ProxyAccountDto> {
  return api<ProxyAccountDto>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}`, { signal });
}

export function listRequestStats(params: { identity?: string; limit?: number } = {}, signal?: AbortSignal): Promise<ProxyRequestStatDto[]> {
  const search = new URLSearchParams();
  if (params.limit) search.set('limit', String(params.limit));
  if (params.identity) {
    return api<ProxyRequestStatDto[]>(`/api/console/proxy/accounts/${encodeURIComponent(params.identity)}/request-stats${query(search)}`, { signal });
  }
  return api<ProxyRequestStatDto[]>(`/api/console/proxy/request-stats${query(search)}`, { signal });
}

export function reauthorizeCopilotOauth(identity: string, body: { ssoPassword?: string; ssoType?: SsoType; credentialMode?: 'default' | 'override' }): Promise<ProxyAccountDto> {
  return api<ProxyAccountDto>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}/copilot-oauth/reauthorize`, { method: 'POST', body: JSON.stringify(body) });
}

export function importCopilotOauthTokens(csvText: string): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  return api<BatchResult<ImportCopilotOauthTokenRow>>('/api/console/proxy/accounts/copilot-oauth-token/import', {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export function getErrorDiagnostic(id: string, signal?: AbortSignal): Promise<ProxyErrorDiagnosticDetailDto> {
  return api<ProxyErrorDiagnosticDetailDto>(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}`, { signal });
}

export function downloadErrorDiagnostic(id: string): Promise<{ blob: Blob; filename: string }> {
  return downloadApi(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}/download`, { fallbackFilename: 'proxy-error-diagnostic.log' });
}

export function clearErrorDiagnostics(): Promise<ClearProxyErrorDiagnosticsResponse> {
  return api<ClearProxyErrorDiagnosticsResponse>('/api/console/proxy/error-diagnostics', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
}

function query(search: URLSearchParams): string {
  const value = search.toString();
  return value ? `?${value}` : '';
}
