import type {
  BatchResult,
  ClearProxyErrorDiagnosticsResponse,
  DeleteProxyAccountResult,
  ImportCopilotOauthTokenRow,
  PageResponse,
  ProxyAccountDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticsListResponse,
  ProxyRequestStatDto,
  SsoType,
} from '@ghcp/shared';
import { api, downloadApi } from './client.js';

export interface ListProxyAccountsQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function listProxyAccounts(params: ListProxyAccountsQuery = {}): Promise<PageResponse<ProxyAccountDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const queryString = search.toString();
  return api<PageResponse<ProxyAccountDto> | ProxyAccountDto[]>(`/api/console/proxy/accounts${queryString ? `?${queryString}` : ''}`)
    .then((result) => {
      if (!Array.isArray(result)) return result;
      const page = Math.max(1, Math.trunc(params.page ?? 1));
      const pageSize = Math.max(1, Math.trunc(params.pageSize ?? (result.length || 25)));
      return {
        items: result,
        total: result.length,
        page,
        pageSize,
      };
    });
}

export function getProxyAccount(identity: string): Promise<ProxyAccountDto> {
  return api<ProxyAccountDto>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}`);
}

export function deleteProxyAccount(identity: string): Promise<DeleteProxyAccountResult> {
  return api<DeleteProxyAccountResult>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}`, { method: 'DELETE' });
}

export function listRequestStats(params: { identity?: string; limit?: number } = {}): Promise<ProxyRequestStatDto[]> {
  const search = new URLSearchParams();
  if (params.limit) search.set('limit', String(params.limit));
  if (params.identity) {
    return api<ProxyRequestStatDto[]>(`/api/console/proxy/accounts/${encodeURIComponent(params.identity)}/request-stats${query(search)}`);
  }
  return api<ProxyRequestStatDto[]>(`/api/console/proxy/request-stats${query(search)}`);
}

export function reauthorizeCopilotOauth(identity: string, body: { ssoPassword: string; ssoType: SsoType }): Promise<ProxyAccountDto | undefined> {
  return api<ProxyAccountDto | undefined>(`/api/console/proxy/accounts/${encodeURIComponent(identity)}/copilot-oauth/reauthorize`, { method: 'POST', body: JSON.stringify(body) });
}

export function importCopilotOauthTokens(csvText: string): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  return api<BatchResult<ImportCopilotOauthTokenRow>>('/api/console/proxy/accounts/copilot-oauth-token/import', {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export function listErrorDiagnostics(params: { page?: number; pageSize?: number } = {}): Promise<ProxyErrorDiagnosticsListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  return api<ProxyErrorDiagnosticsListResponse>(`/api/console/proxy/error-diagnostics${query(search)}`);
}

export function getErrorDiagnostic(id: string): Promise<ProxyErrorDiagnosticDetailDto> {
  return api<ProxyErrorDiagnosticDetailDto>(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}`);
}

export function downloadErrorDiagnostic(id: string): Promise<{ blob: Blob; filename: string }> {
  return downloadApi(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}/download`);
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
