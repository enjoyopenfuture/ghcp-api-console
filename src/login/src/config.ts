import 'dotenv/config';

export interface LoginConfig {
  port: number;
  dbPath: string;
  internalApiToken: string;
  proxyBaseUrl: string;
  logDir: string;
  githubOauthClientId: string;
  githubOauthScope: string;
  opencodeUserAgent: string;
  auth: AuthConfig;
  endpoints: {
    deviceCode: string;
    accessToken: string;
  };
}

export type SsoProvider = 'custom' | 'azure';

export interface AuthConfig {
  ssoUrl?: string;
  ssoProvider: SsoProvider;
  azureStaySignedIn: boolean;
  headless: boolean;
  debugArtifactsDir: string;
  selectors: Record<string, string | undefined>;
}

export interface RuntimeAuthConfig extends AuthConfig {
  timeoutMs: number;
  debugLogs: boolean;
  debugArtifacts: boolean;
}

export const config: LoginConfig = {
  port: readPort(process.env.PORT, 7003),
  dbPath: process.env.DB_PATH ?? './data/login.sqlite',
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  logDir: process.env.LOG_DIR ?? './logs/login',
  githubOauthClientId: readOptionalString(process.env.GITHUB_OAUTH_CLIENT_ID) ?? 'Ov23li8tweQw6odWQebz',
  githubOauthScope: readOptionalString(process.env.GITHUB_OAUTH_SCOPE) ?? 'read:user',
  opencodeUserAgent: readOptionalString(process.env.OPENCODE_USER_AGENT)
    ?? `opencode/${readOptionalString(process.env.OPENCODE_VERSION) ?? '1.0.0'}`,
  endpoints: {
    deviceCode: 'https://github.com/login/device/code',
    accessToken: 'https://github.com/login/oauth/access_token',
  },
  auth: {
    ssoUrl: process.env.SSO_URL,
    ssoProvider: readSsoProvider(process.env.SSO_PROVIDER),
    azureStaySignedIn: readBoolean(process.env.AZURE_STAY_SIGNED_IN, false),
    headless: readBoolean(process.env.AUTH_HEADLESS, true),
    debugArtifactsDir: process.env.AUTH_DEBUG_ARTIFACT_DIR ?? '.auth-debug',
    selectors: {
      deviceCodeInput: process.env.AUTH_DEVICE_CODE_INPUT_SELECTOR,
      deviceCodeSubmit: process.env.AUTH_DEVICE_CODE_SUBMIT_SELECTOR,
      githubLoginInput: process.env.AUTH_GITHUB_LOGIN_INPUT_SELECTOR,
      githubLoginSubmit: process.env.AUTH_GITHUB_LOGIN_SUBMIT_SELECTOR,
      githubSsoSubmit: process.env.AUTH_GITHUB_SSO_SUBMIT_SELECTOR,
      ssoUsernameInput: process.env.AUTH_SSO_USERNAME_INPUT_SELECTOR,
      ssoPasswordInput: process.env.AUTH_SSO_PASSWORD_INPUT_SELECTOR,
      ssoSubmit: process.env.AUTH_SSO_SUBMIT_SELECTOR,
      azureUsernameInput: process.env.AUTH_AZURE_USERNAME_INPUT_SELECTOR,
      azureNextSubmit: process.env.AUTH_AZURE_NEXT_SUBMIT_SELECTOR,
      azurePasswordInput: process.env.AUTH_AZURE_PASSWORD_INPUT_SELECTOR,
      azureSignInSubmit: process.env.AUTH_AZURE_SIGN_IN_SUBMIT_SELECTOR,
      azureStaySignedInYes: process.env.AUTH_AZURE_STAY_SIGNED_IN_YES_SELECTOR,
      azureStaySignedInNo: process.env.AUTH_AZURE_STAY_SIGNED_IN_NO_SELECTOR,
      githubAuthorizeSubmit: process.env.AUTH_GITHUB_AUTHORIZE_SUBMIT_SELECTOR,
    },
  },
};

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}

function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean "${value}".`);
}

function readSsoProvider(value: string | undefined): SsoProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'custom') return 'custom';
  if (normalized === 'azure') return 'azure';
  throw new Error(`Invalid SSO_PROVIDER "${value}". Use "custom" or "azure".`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
