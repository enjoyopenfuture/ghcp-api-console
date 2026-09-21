export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    if (res.status === 401 && body?.error?.code === 'not_authenticated') window.dispatchEvent(new Event('console-session-expired'));
    throw new ConsoleApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.details,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface DownloadResult {
  blob: Blob;
  filename: string;
  /**
   * Row count the export matched when it began, from `X-Export-Matched-At-Start`. The CSV is built
   * from a snapshot, so a caller can compare this with the row count it displayed and warn that the
   * file is a point-in-time view rather than the list the operator was looking at.
   */
  matchedAtStart?: number;
}

export async function downloadApi(path: string, options: RequestInit & { fallbackFilename?: string } = {}): Promise<DownloadResult> {
  const { fallbackFilename = 'export.csv', ...init } = options;
  const res = await fetch(path, { ...init, headers: { Accept: 'text/csv, text/plain, application/json', 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    if (res.status === 401 && body?.error?.code === 'not_authenticated') window.dispatchEvent(new Event('console-session-expired'));
    throw new ConsoleApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.details,
    );
  }
  const matched = Number(res.headers.get('x-export-matched-at-start'));
  return {
    blob: await res.blob(),
    filename: attachmentFilename(res.headers.get('content-disposition')) ?? fallbackFilename,
    matchedAtStart: Number.isFinite(matched) && res.headers.has('x-export-matched-at-start') ? matched : undefined,
  };
}

function attachmentFilename(contentDisposition: string | null): string | undefined {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1];
}
