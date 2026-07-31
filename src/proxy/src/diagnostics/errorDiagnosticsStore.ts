import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticRecordDto,
  ProxyErrorDiagnosticsListResponse,
} from '@ghcp/shared';
import { formatDiagnosticRecord, parseDiagnosticLog } from './humanDiagnosticFormat.js';

export interface ErrorDiagnosticsStoreOptions {
  enabled: boolean;
  directory: string;
  redacted: boolean;
  maxFileBytes: number;
  maxFiles: number;
}

export class ErrorDiagnosticsDisabledError extends Error {
  constructor() {
    super('Proxy error diagnostics collection is disabled.');
    this.name = 'ErrorDiagnosticsDisabledError';
  }
}

export class ErrorDiagnosticsStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly options: ErrorDiagnosticsStoreOptions) {}

  append(record: ProxyErrorDiagnosticRecordDto): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    return this.serialized(async () => {
      await mkdir(this.options.directory, { recursive: true });
      const block = formatDiagnosticRecord(record);
      const blockBytes = Buffer.byteLength(block);
      const active = this.filePath(0);
      let activeBytes = await fileSize(active);
      let prefix = activeBytes > 0 && !await endsWithNewline(active, activeBytes) ? '\n' : '';
      if (activeBytes > 0 && activeBytes + Buffer.byteLength(prefix) + blockBytes > this.options.maxFileBytes) {
        await this.rotate();
        prefix = '';
      }
      await appendFile(active, `${prefix}${block}`, 'utf8');
    });
  }

  list(page = 1, pageSize = 25): Promise<ProxyErrorDiagnosticsListResponse> {
    const normalizedPage = Math.max(1, Math.trunc(page));
    const normalizedPageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    if (!this.options.enabled) {
      return Promise.resolve({
        enabled: false,
        redacted: this.options.redacted,
        items: [],
        total: 0,
        page: normalizedPage,
        pageSize: normalizedPageSize,
      });
    }
    return this.serialized(async () => {
      const start = (normalizedPage - 1) * normalizedPageSize;
      const items: ProxyErrorDiagnosticsListResponse['items'] = [];
      let total = 0;
      await this.visitNewestFirst((record) => {
        if (total >= start && items.length < normalizedPageSize) {
          const { content: _content, ...summary } = record;
          items.push(summary);
        }
        total += 1;
      });
      return {
        enabled: true,
        redacted: this.options.redacted,
        items,
        total,
        page: normalizedPage,
        pageSize: normalizedPageSize,
      };
    });
  }

  get(id: string): Promise<ProxyErrorDiagnosticDetailDto | undefined> {
    this.assertEnabled();
    return this.serialized(async () => {
      let found: ProxyErrorDiagnosticDetailDto | undefined;
      await this.visitNewestFirst((record) => {
        if (!found && record.id === id) found = record;
      }, () => found !== undefined);
      return found;
    });
  }

  clear(): Promise<void> {
    this.assertEnabled();
    return this.serialized(async () => {
      const clearingDirectory = `${this.options.directory}.clearing-${randomUUID()}`;
      await mkdir(dirname(this.options.directory), { recursive: true });
      try {
        await rename(this.options.directory, clearingDirectory);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      await mkdir(this.options.directory, { recursive: true });
      await rm(clearingDirectory, { recursive: true, force: true });
    });
  }

  private assertEnabled(): void {
    if (!this.options.enabled) throw new ErrorDiagnosticsDisabledError();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async rotate(): Promise<void> {
    const oldest = this.filePath(this.options.maxFiles - 1);
    await rm(oldest, { force: true });
    for (let index = this.options.maxFiles - 2; index >= 0; index -= 1) {
      try {
        await rename(this.filePath(index), this.filePath(index + 1));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  private async visitNewestFirst(
    visitor: (record: ProxyErrorDiagnosticDetailDto) => void,
    stop?: () => boolean,
  ): Promise<void> {
    for (let fileIndex = 0; fileIndex < this.options.maxFiles; fileIndex += 1) {
      let content: string;
      try {
        content = await readFile(this.filePath(fileIndex), 'utf8');
      } catch (err) {
        if (isNotFound(err)) continue;
        throw err;
      }
      const records = parseDiagnosticLog(content);
      for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex -= 1) {
        const record = records[recordIndex]!;
        visitor(record);
        if (stop?.()) return;
      }
    }
  }

  private filePath(index: number): string {
    return join(this.options.directory, index === 0 ? 'diagnostics.log' : `diagnostics.${index}.log`);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (isNotFound(err)) return 0;
    throw err;
  }
}

async function endsWithNewline(path: string, size: number): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const byte = Buffer.allocUnsafe(1);
    await file.read(byte, 0, 1, size - 1);
    return byte[0] === 10;
  } finally {
    await file.close();
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
