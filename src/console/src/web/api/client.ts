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

export async function downloadApi(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    throw new ConsoleApiError(
      res.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `HTTP ${res.status}`,
      body?.error?.details,
    );
  }
  return {
    blob: await res.blob(),
    filename: attachmentFilename(res.headers.get('content-disposition')) ?? 'proxy-error-diagnostic.log',
  };
}

function attachmentFilename(contentDisposition: string | null): string | undefined {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1];
}
