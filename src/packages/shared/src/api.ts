export const INTERNAL_AUTH_HEADER = 'X-Internal-Token';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

export interface PageResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BatchSummary {
  total: number;
  success: number;
  skipped?: number;
  warnings?: number;
  failed: number;
}

export interface BatchResult<Row> {
  batchId: string;
  startedAt: string;
  finishedAt: string;
  summary: BatchSummary;
  rows: Row[];
}

export class HttpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpApiError';
  }
}

export function apiError(code: string, message: string, details?: unknown, requestId?: string): ApiErrorResponse {
  return { error: { code, message, details, requestId } };
}

export function pageResponse<T>(items: T[], total: number, page: number, pageSize: number): PageResponse<T> {
  return { items, total, page, pageSize };
}
