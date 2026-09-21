import { HttpApiError } from './api.js';
import type { LoginCredentials } from './contracts.js';

export function readLoginCredentials(input: unknown): LoginCredentials {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (value.credentialMode === 'default') return { credentialMode: 'default' };
  if (value.credentialMode !== undefined && value.credentialMode !== 'override') {
    throw new HttpApiError(400, 'invalid_credentials', 'credentialMode must be default or override.');
  }
  if (typeof value.ssoPassword !== 'string' || !value.ssoPassword) {
    throw new HttpApiError(400, 'password_required', 'Provide a password override or explicitly choose the default password.');
  }
  return { credentialMode: 'override', ssoPassword: value.ssoPassword };
}

export const MANAGEMENT_BATCH_LIMIT = 1000;

export interface ManagementQuery {
  ids?: string[];
  asOf?: string;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  identity?: string;
  model?: string;
  success?: string;
  role?: string;
  seatStatus?: string;
  minAttempts?: number;
  minWaitSeconds?: number;
  minRunSeconds?: number;
  failureCode?: string;
  finishedBefore?: string;
}

export interface ManagementSelection {
  ids?: string[];
  query?: ManagementQuery;
  excludedIds?: string[];
}

export type OperationItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled' | 'interrupted';

export interface OperationItem {
  id: string;
  status: OperationItemStatus;
  detail?: string;
  attemptId?: string;
  relatedTaskId?: string;
  revision?: string;
  label?: string;
  requiresPasswordOverride?: boolean;
}

export interface ManagementOperation {
  id: string;
  scope: string;
  action: string;
  status: 'preview' | 'running' | 'completed' | 'interrupted';
  items: OperationItem[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  options?: { assignCopilotSeat?: boolean; ssoType?: 'custom' | 'azure' };
}

export interface ManagementSummary {
  total: number;
  counts: Record<string, number>;
  updatedAt: string;
}

export function readManagementQuery(input: Record<string, unknown>): ManagementQuery {
  const result: ManagementQuery = {};
  if (input.ids !== undefined) {
    const ids = typeof input.ids === 'string' ? [input.ids] : input.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > MANAGEMENT_BATCH_LIMIT || ids.some((id) => typeof id !== 'string' || !id || id.length > 500)) {
      throw new HttpApiError(400, 'invalid_query', 'Provide 1 to 1000 valid record IDs.');
    }
    result.ids = [...new Set<string>(ids)];
  }
  for (const key of ['q', 'status', 'sort', 'identity', 'model', 'success', 'role', 'seatStatus', 'failureCode'] as const) {
    if (input[key] === undefined || input[key] === '') continue;
    if (typeof input[key] !== 'string' || input[key].length > 500) {
      throw new HttpApiError(400, 'invalid_query', `${key} must be a string of at most 500 characters.`);
    }
    result[key] = input[key].trim();
  }
  for (const key of ['page', 'pageSize', 'minAttempts', 'minWaitSeconds', 'minRunSeconds'] as const) {
    if (input[key] === undefined || input[key] === '') continue;
    if (typeof input[key] !== 'string' && typeof input[key] !== 'number') {
      throw new HttpApiError(400, 'invalid_query', `${key} must be an integer.`);
    }
    const value = Number(input[key]);
    if (!Number.isSafeInteger(value) || value < (key.startsWith('min') ? 0 : 1) || (key === 'pageSize' && value > 100)
      || ((key === 'minWaitSeconds' || key === 'minRunSeconds') && value > 315360000)) {
      throw new HttpApiError(400, 'invalid_query', `${key} is outside the supported range.`);
    }
    result[key] = value;
  }
  if (input.dir !== undefined) {
    if (input.dir !== 'asc' && input.dir !== 'desc') throw new HttpApiError(400, 'invalid_query', 'dir must be asc or desc.');
    result.dir = input.dir;
  }
  for (const key of ['from', 'to', 'finishedBefore', 'asOf'] as const) {
    const value = input[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      throw new HttpApiError(400, 'invalid_query', `${key} must be an ISO timestamp.`);
    }
    result[key] = new Date(value).toISOString();
  }
  if (result.from && result.to && result.from >= result.to) {
    throw new HttpApiError(400, 'invalid_query', 'from must be before to.');
  }
  return result;
}

export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  // Plain numbers are data, not formulas: prefixing them would corrupt every negative numeric column.
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) && /^(?:[\t\r\n]|\s*[=+\-@])/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Escapes the LIKE wildcards in a user-supplied search term so that `foo_bar` matches a literal
 * underscore instead of any character. Pairs with `LIKE ? ESCAPE '/'`, which both SQLite and MySQL
 * parse identically (a backslash escape character cannot be written portably across the two).
 */
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '/'";

export function likeContains(value: string): string {
  return `%${value.replaceAll(/[/%_]/g, (character) => `/${character}`)}%`;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
