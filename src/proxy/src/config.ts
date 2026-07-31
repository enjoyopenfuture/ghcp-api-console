import 'dotenv/config';

export interface ProxyConfig {
  port: number;
  dbPath: string;
  apiKey: string;
  identityHeader: string;
  identityHeaderRequired: boolean;
  claudeCodeOptimized: boolean;
  internalApiToken: string;
  ssoBaseUrl: string;
  loginBaseUrl: string;
  enterpriseShortcode: string;
  requestStatsPerAccountLimit: number;
  errorDiagnosticsEnabled: boolean;
  errorDiagnosticsDir: string;
  errorDiagnosticsRedact: boolean;
  errorDiagnosticsMaxFileBytes: number;
  errorDiagnosticsMaxFiles: number;
  copilotApiBaseUrl: string;
  opencodeUserAgent: string;
  githubApiVersion: string;
}

export const config: ProxyConfig = {
  port: readPort(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH ?? './data/proxy.sqlite',
  apiKey: process.env.API_KEY ?? '',
  identityHeader: process.env.IDENTITY_HEADER ?? 'X-User-Identity',
  identityHeaderRequired: readBoolean(process.env.IDENTITY_HEADER_REQUIRED, true),
  claudeCodeOptimized: readBoolean(process.env.CLAUDE_CODE_OPTIMIZED, false),
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  ssoBaseUrl: process.env.SSO_BASE_URL ?? 'http://localhost:7001',
  loginBaseUrl: process.env.LOGIN_BASE_URL ?? 'http://localhost:7003',
  enterpriseShortcode: readOptionalString(process.env.ENTERPRISE_SHORTCODE) ?? 'octo',
  requestStatsPerAccountLimit: readPositiveInteger(process.env.REQUEST_STATS_PER_ACCOUNT_LIMIT, 100),
  errorDiagnosticsEnabled: readBoolean(process.env.PROXY_ERROR_DIAGNOSTICS_ENABLED, true),
  errorDiagnosticsDir: readOptionalString(process.env.PROXY_ERROR_DIAGNOSTICS_DIR) ?? './data/error-diagnostics',
  errorDiagnosticsRedact: readBoolean(process.env.PROXY_ERROR_DIAGNOSTICS_REDACT, false),
  errorDiagnosticsMaxFileBytes: readPositiveInteger(process.env.PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB, 50) * 1024 * 1024,
  errorDiagnosticsMaxFiles: readPositiveInteger(process.env.PROXY_ERROR_DIAGNOSTICS_MAX_FILES, 5),
  copilotApiBaseUrl: readOptionalString(process.env.COPILOT_API_BASE_URL) ?? 'https://api.githubcopilot.com',
  opencodeUserAgent: readOptionalString(process.env.OPENCODE_USER_AGENT)
    ?? `opencode/${readOptionalString(process.env.OPENCODE_VERSION) ?? '1.0.0'}`,
  githubApiVersion: readOptionalString(process.env.GITHUB_API_VERSION) ?? '2026-06-01',
};

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}

function readPositiveInteger(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer "${value}".`);
  return parsed;
}

function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean "${value}".`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
