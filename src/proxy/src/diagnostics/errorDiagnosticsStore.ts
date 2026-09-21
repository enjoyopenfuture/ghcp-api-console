import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticRecordDto,
  ProxyErrorDiagnosticsListResponse,
  ManagementQuery,
} from '@ghcp/shared';
import { formatDiagnosticRecord, parseDiagnosticLog } from './humanDiagnosticFormat.js';
import { HttpApiError } from '@ghcp/shared';

const SHARED_INSTANCES_DIR = 'instances';
const SHARED_CLEAR_CUTOFF_FILE = 'diagnostics.clear-cutoff.json';

export interface ErrorDiagnosticsStoreOptions {
  enabled: boolean;
  directory: string;
  redacted: boolean;
  maxFileBytes: number;
  maxFiles: number;
  shared?: boolean;
  instanceId?: string;
}

export class ErrorDiagnosticsDisabledError extends Error {
  constructor() {
    super('Proxy error diagnostics collection is disabled.');
    this.name = 'ErrorDiagnosticsDisabledError';
  }

}

function matchesDiagnostic(record: ProxyErrorDiagnosticsListResponse['items'][number], query: ManagementQuery): boolean {
  if (query.ids && !query.ids.includes(record.id)) return false;
  if (query.q && !`${record.id} ${record.identity} ${record.path} ${record.model ?? ''}`.toLowerCase().includes(query.q.toLowerCase())) return false;
  if (query.identity && record.identity !== query.identity) return false;
  if (query.model && !(record.model ?? '').toLowerCase().includes(query.model.toLowerCase())) return false;
  if (query.status && String(record.status) !== query.status) return false;
  if (query.failureCode && record.failureKind !== query.failureCode) return false;
  const timestamp = asSortTimestamp(record.timestamp);
  if ((query.from || query.to) && !Number.isFinite(timestamp)) return false;
  if (query.from && timestamp < Date.parse(query.from)) return false;
  if (query.to && timestamp >= Date.parse(query.to)) return false;
  return true;
}

export class ErrorDiagnosticsStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly options: ErrorDiagnosticsStoreOptions) {
    if (this.sharedModeEnabled()) this.sharedInstanceDirectoryPath();
  }

  append(record: ProxyErrorDiagnosticRecordDto): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    return this.serialized(async () => {
      const directory = this.writeDirectory();
      await mkdir(directory, { recursive: true });
      const block = formatDiagnosticRecord(record);
      const blockBytes = Buffer.byteLength(block);
      const active = this.filePath(directory, 0);
      let activeBytes = await fileSize(active);
      let prefix = activeBytes > 0 && !await endsWithNewline(active, activeBytes) ? '\n' : '';
      if (activeBytes > 0 && activeBytes + Buffer.byteLength(prefix) + blockBytes > this.options.maxFileBytes) {
        await this.rotate(directory);
        prefix = '';
      }
      await appendFile(active, `${prefix}${block}`, 'utf8');
    });
  }

  list(page = 1, pageSize = 25, query: ManagementQuery = {}): Promise<ProxyErrorDiagnosticsListResponse> {
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
    return this.snapshot().then((items) => this.pageSnapshot(items, { ...query, page: normalizedPage, pageSize: normalizedPageSize }));
  }

  snapshot(): Promise<ProxyErrorDiagnosticsListResponse['items']> {
    if (!this.options.enabled) throw new HttpApiError(503, 'error_diagnostics_disabled', 'Proxy error diagnostics collection is disabled.');
    return this.serialized(async () => {
      const items: ProxyErrorDiagnosticsListResponse['items'] = [];
      const cutoff = this.sharedModeEnabled() ? await this.readSharedClearCutoff() : undefined;
      const collect = (record: ProxyErrorDiagnosticDetailDto) => {
        if (cutoff !== undefined && recordAtOrBeforeCutoff(record, cutoff)) return;
        const { content: _content, ...summary } = record;
        items.push(summary);
      };
      if (this.sharedModeEnabled()) await this.visitSharedRecords(collect);
      else await this.visitNewestFirst(collect);
      return items;
    });
  }

  pageSnapshot(source: ProxyErrorDiagnosticsListResponse['items'], query: ManagementQuery): ProxyErrorDiagnosticsListResponse {
    if (query.status && !/^[1-5]\d\d$/.test(query.status)) throw new HttpApiError(400, 'invalid_status', 'HTTP status must be a three-digit status code.');
    if (query.failureCode && !['http', 'fetch', 'stream'].includes(query.failureCode)) throw new HttpApiError(400, 'invalid_failure_kind', 'Unknown diagnostic failure kind.');
    const sort = (['timestamp', 'identity', 'model', 'status', 'failureKind'] as const).find((key) => key === (query.sort ?? 'timestamp'));
    if (!sort) throw new HttpApiError(400, 'invalid_sort', 'Unknown diagnostic sort field.');
    const direction = query.dir === 'asc' ? 1 : -1;
    const items = source.filter((item) => matchesDiagnostic(item, query)).sort((left, right) => {
      if (sort === 'timestamp') return -direction * compareRecordsNewestFirst(left, right);
      const a = left[sort]; const b = right[sort];
      return direction * ((typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''))) || left.id.localeCompare(right.id));
    });
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const page = Math.min(Math.max(1, query.page ?? 1), Math.max(1, Math.ceil(items.length / pageSize)));
    return { enabled: true, redacted: this.options.redacted, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  get(id: string): Promise<ProxyErrorDiagnosticDetailDto | undefined> {
    this.assertEnabled();
    return this.serialized(async () => {
      if (this.sharedModeEnabled()) return this.getShared(id);
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
      if (this.sharedModeEnabled()) {
        const cutoffTimestamp = new Date().toISOString();
        await mkdir(this.options.directory, { recursive: true });
        await this.writeSharedCutoff(cutoffTimestamp);
        await this.clearOwnSharedFiles();
        return;
      }
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

  private async rotate(directory: string): Promise<void> {
    const oldest = this.filePath(directory, this.options.maxFiles - 1);
    await rm(oldest, { force: true });
    for (let index = this.options.maxFiles - 2; index >= 0; index -= 1) {
      try {
        await rename(this.filePath(directory, index), this.filePath(directory, index + 1));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  private async visitNewestFirst(
    visitor: (record: ProxyErrorDiagnosticDetailDto) => void,
    stop?: () => boolean,
  ): Promise<void> {
    const directory = this.options.directory;
    for (let fileIndex = 0; fileIndex < this.options.maxFiles; fileIndex += 1) {
      let content: string;
      try {
        content = await readFile(this.filePath(directory, fileIndex), 'utf8');
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

  private async getShared(id: string): Promise<ProxyErrorDiagnosticDetailDto | undefined> {
    const clearCutoff = await this.readSharedClearCutoff();
    let found: ProxyErrorDiagnosticDetailDto | undefined;
    await this.visitSharedRecords((record) => {
      if (record.id !== id) return;
      if (clearCutoff !== undefined && recordAtOrBeforeCutoff(record, clearCutoff)) return;
      found = record;
    }, () => found !== undefined);
    return found;
  }

  private async sharedReadDirectories(): Promise<string[]> {
    const directories = [this.options.directory];
    const instancesRoot = this.sharedInstancesRoot();
    let entries: Dirent[];
    try {
      entries = await readdir(instancesRoot, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return directories;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(join(instancesRoot, entry.name));
    }
    return directories;
  }

  private async visitSharedRecords(
    visitor: (record: ProxyErrorDiagnosticDetailDto) => void,
    stop?: () => boolean,
  ): Promise<void> {
    const directories = await this.sharedReadDirectories();
    for (const directory of directories) {
      for (let fileIndex = 0; fileIndex < this.options.maxFiles; fileIndex += 1) {
        let content: string;
        try {
          content = await readFile(this.filePath(directory, fileIndex), 'utf8');
        } catch (err) {
          if (isNotFound(err)) continue;
          throw err;
        }
        for (const record of parseDiagnosticLog(content)) {
          visitor(record);
          if (stop?.()) return;
        }
      }
    }
  }

  private async readSharedClearCutoff(): Promise<number | undefined> {
    let content: string;
    try {
      content = await readFile(this.sharedClearCutoffPath(), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const parsed = JSON.parse(content) as { cutoffTimestamp?: unknown };
    if (typeof parsed.cutoffTimestamp !== 'string') {
      throw new Error(`Invalid shared diagnostics clear marker: ${this.sharedClearCutoffPath()}`);
    }
    const cutoff = Date.parse(parsed.cutoffTimestamp);
    if (Number.isNaN(cutoff)) {
      throw new Error(`Invalid shared diagnostics clear timestamp: ${parsed.cutoffTimestamp}`);
    }
    return cutoff;
  }

  private async writeSharedCutoff(cutoffTimestamp: string): Promise<void> {
    const markerPath = this.sharedClearCutoffPath();
    const pendingPath = `${markerPath}.${randomUUID()}.pending`;
    await writeFile(pendingPath, `${JSON.stringify({ cutoffTimestamp })}\n`, 'utf8');
    let renamed = false;
    try {
      await rename(pendingPath, markerPath);
      renamed = true;
    } finally {
      if (!renamed) await rm(pendingPath, { force: true });
    }
  }

  private async clearOwnSharedFiles(): Promise<void> {
    const directory = this.sharedInstanceDirectoryPath();
    for (let fileIndex = 0; fileIndex < this.options.maxFiles; fileIndex += 1) {
      await rm(this.filePath(directory, fileIndex), { force: true });
    }
  }

  private writeDirectory(): string {
    return this.sharedModeEnabled() ? this.sharedInstanceDirectoryPath() : this.options.directory;
  }

  private sharedModeEnabled(): boolean {
    return this.options.enabled && this.options.shared === true;
  }

  private sharedInstancesRoot(): string {
    return join(this.options.directory, SHARED_INSTANCES_DIR);
  }

  private sharedClearCutoffPath(): string {
    return join(this.options.directory, SHARED_CLEAR_CUTOFF_FILE);
  }

  private sharedInstanceDirectoryPath(): string {
    const sanitized = sanitizeInstanceId(this.options.instanceId);
    if (!sanitized) {
      throw new Error(`Invalid shared diagnostics instance id: ${String(this.options.instanceId)}`);
    }
    const instancesRoot = resolve(this.sharedInstancesRoot());
    const instanceDirectory = resolve(instancesRoot, sanitized);
    const relativePath = relative(instancesRoot, instanceDirectory);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Invalid shared diagnostics instance directory: ${sanitized}`);
    }
    return instanceDirectory;
  }

  private filePath(directory: string, index: number): string {
    return join(directory, index === 0 ? 'diagnostics.log' : `diagnostics.${index}.log`);
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

function sanitizeInstanceId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().normalize('NFKC');
  if (!normalized) return undefined;
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) return undefined;
  const sanitized = normalized
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^[-._]+|[-._]+$/g, '');
  if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized.length > 120) return undefined;
  return sanitized;
}

function recordAtOrBeforeCutoff(record: ProxyErrorDiagnosticDetailDto, cutoff: number): boolean {
  const timestamp = Date.parse(record.timestamp);
  return !Number.isNaN(timestamp) && timestamp <= cutoff;
}

function compareRecordsNewestFirst(
  left: Pick<ProxyErrorDiagnosticDetailDto, 'id' | 'timestamp'>,
  right: Pick<ProxyErrorDiagnosticDetailDto, 'id' | 'timestamp'>,
): number {
  const leftTime = asSortTimestamp(left.timestamp);
  const rightTime = asSortTimestamp(right.timestamp);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.timestamp !== right.timestamp) return right.timestamp.localeCompare(left.timestamp);
  return right.id.localeCompare(left.id);
}

function asSortTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
