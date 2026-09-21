import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { redactSensitiveValue, redactSecrets } from '@ghcp/shared';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export class AccountLogger {
  private constructor(
    private readonly accountName: string,
    private readonly filePath: string,
    private readonly debugEnabled: boolean,
    private readonly onStage?: (step: string) => void,
    private readonly secrets: string[] = [],
  ) {}

  static create(logDir: string, accountName: string, debugEnabled: boolean, attemptKey?: string, onStage?: (step: string) => void, secrets: string[] = []): AccountLogger {
    const filePath = AccountLogger.pathFor(logDir, accountName, attemptKey);
    mkdirSync(dirname(filePath), { recursive: true });
    const logger = new AccountLogger(accountName, filePath, debugEnabled, onStage, secrets);
    writeLine(filePath, 'w', logger.format('info', 'start', 'Starting login task log', { accountName }));
    return logger;
  }

  static pathFor(logDir: string, accountName: string, attemptKey?: string): string {
    const bucket = createHash('sha256').update(accountName).digest('hex').slice(0, 2);
    const dir = join(logDir, bucket);
    const name = attemptKey ? `${sanitizeFileName(accountName).slice(0, 80)}-${createHash('sha256').update(attemptKey).digest('hex')}` : sanitizeFileName(accountName);
    return join(dir, `${name}.log`);
  }

  get path(): string {
    return this.filePath;
  }

  info(step: string, message: string, fields?: Record<string, unknown>): void {
    this.onStage?.(step);
    this.write('info', step, message, fields);
  }

  warn(step: string, message: string, fields?: Record<string, unknown>): void {
    this.write('warn', step, message, fields);
  }

  error(step: string, message: string, fields?: Record<string, unknown>): void {
    this.write('error', step, message, fields);
  }

  debug(step: string, message: string, fields?: Record<string, unknown>): void {
    if (this.debugEnabled) this.write('debug', step, message, fields);
  }

  private write(level: LogLevel, step: string, message: string, fields?: Record<string, unknown>): void {
    writeLine(this.filePath, 'a', this.format(level, step, message, fields));
  }

  private format(level: LogLevel, step: string, message: string, fields?: Record<string, unknown>): string {
    const suffix = fields ? ` ${JSON.stringify(redactSensitiveValue(fields))}` : '';
    return redactSecrets(`${new Date().toISOString()} [${this.accountName}] ${level.toUpperCase()} ${step}: ${message}${suffix}\n`, this.secrets);
  }
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'account';
}

function writeLine(filePath: string, flag: 'a' | 'w', line: string): void {
  const fd = openSync(filePath, flag);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
