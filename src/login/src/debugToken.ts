import type { SsoType } from '@ghcp/shared';
import { config } from './config.js';
import { HeadlessPlaywrightAuthStrategy } from './auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from './auth/deviceFlow.js';
import { AccountLogger } from './tasks/accountLogger.js';

interface DebugLoginOptions {
  ghLogin: string;
  ssoUser: string;
  ssoPassword: string;
  ssoType: SsoType;
  ssoUrl?: string;
  debugLogs?: boolean;
  debugArtifacts?: boolean;
  headless?: boolean;
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const logger = AccountLogger.create(config.logDir, options.ssoUser, options.debugLogs ?? config.auth.debugLogs);
  const authConfig = {
    ...config.auth,
    ssoUrl: options.ssoUrl ?? config.auth.ssoUrl,
    ssoProvider: options.ssoType === 'azure' ? 'azure' as const : 'custom' as const,
    debugLogs: options.debugLogs ?? config.auth.debugLogs,
    debugArtifacts: options.debugArtifacts ?? config.auth.debugArtifacts,
    headless: options.headless ?? config.auth.headless,
  };

  console.error(`[login-token] starting login for ghLogin=${options.ghLogin}, ssoUser=${options.ssoUser}, ssoType=${options.ssoType}`);
  console.error(`[login-token] account log: ${logger.path}`);

  const token = await loginWithDeviceFlow(
    new HeadlessPlaywrightAuthStrategy(
      authConfig,
      {
        githubUsername: options.ghLogin,
        ssoUsername: options.ssoUser,
        ssoPassword: options.ssoPassword,
      },
      logger,
    ),
    logger,
  );

  console.error('[login-token] login succeeded; raw Copilot OAuth token follows on stdout');
  console.log(token);
}

function readOptions(args: string[]): DebugLoginOptions {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const values = parseArgs(args);
  const ssoType = readSsoType(values.ssoType ?? env('LOGIN_SSO_TYPE') ?? env('SSO_TYPE') ?? 'custom');
  const options: DebugLoginOptions = {
    ghLogin: readRequired(values.ghLogin ?? env('LOGIN_GH_LOGIN'), 'ghLogin', '--gh-login or LOGIN_GH_LOGIN'),
    ssoUser: readRequired(values.ssoUser ?? env('LOGIN_SSO_USER'), 'ssoUser', '--sso-user or LOGIN_SSO_USER'),
    ssoPassword: readRequired(values.ssoPassword ?? env('LOGIN_SSO_PASSWORD'), 'ssoPassword', '--sso-password or LOGIN_SSO_PASSWORD'),
    ssoType,
    ssoUrl: values.ssoUrl ?? env('LOGIN_SSO_URL'),
    debugLogs: values.debugLogs,
    debugArtifacts: values.debugArtifacts,
    headless: values.headless,
  };
  return options;
}

interface ParsedArgs {
  ghLogin?: string;
  ssoUser?: string;
  ssoPassword?: string;
  ssoType?: string;
  ssoUrl?: string;
  debugLogs?: boolean;
  debugArtifacts?: boolean;
  headless?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const values: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--gh-login':
        values.ghLogin = readArgValue(args, ++i, arg);
        break;
      case '--sso-user':
        values.ssoUser = readArgValue(args, ++i, arg);
        break;
      case '--sso-password':
        values.ssoPassword = readArgValue(args, ++i, arg);
        break;
      case '--sso-type':
        values.ssoType = readArgValue(args, ++i, arg);
        break;
      case '--sso-url':
        values.ssoUrl = readArgValue(args, ++i, arg);
        break;
      case '--debug-logs':
        values.debugLogs = true;
        break;
      case '--debug-artifacts':
        values.debugArtifacts = true;
        break;
      case '--headful':
        values.headless = false;
        break;
      case '--headless':
        values.headless = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}".\n${usage()}`);
    }
  }
  return values;
}

function readArgValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return value;
}

function readRequired(value: string | undefined, label: string, source: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required. Provide ${source}.`);
  return trimmed;
}

function readSsoType(value: string): SsoType {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'azure' || normalized === 'custom') return normalized;
  throw new Error(`Invalid ssoType "${value}". Use "custom" or "azure".`);
}

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function usage(): string {
  return `Usage:
  npm run login:token -- --gh-login <gh-login> --sso-user <sso-user> --sso-password <password> [--sso-type custom|azure] [--sso-url <url>]

Environment alternatives:
  LOGIN_GH_LOGIN=<gh-login>
  LOGIN_SSO_USER=<sso-user>
  LOGIN_SSO_PASSWORD=<password>
  LOGIN_SSO_TYPE=custom|azure
  LOGIN_SSO_URL=<url>

Debug flags:
  --headful           Show browser window.
  --debug-logs       Enable verbose account log.
  --debug-artifacts  Save Playwright traces/screenshots on failure.

The command prints only the raw Copilot OAuth token to stdout. Progress and log path go to stderr.`;
}

main().catch((err: unknown) => {
  console.error(`[login-token] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
