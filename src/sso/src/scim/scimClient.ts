import { errorFields, loggerFor } from '@ghcp/shared';
import { config } from '../config.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import { normalizeHandle } from './handle.js';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export type ScimEnterpriseRole = 'user' | 'enterprise_owner';

export interface ScimUserResource {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string };
  displayName?: string;
  emails?: { value: string; primary?: boolean; type?: string }[];
  roles?: { value: ScimEnterpriseRole | string; primary?: boolean; display?: string; type?: string }[];
  active?: boolean;
  githubLogin?: string;
}

interface ScimListResponse {
  totalResults?: number;
  startIndex?: number;
  itemsPerPage?: number;
  Resources?: ScimUserResource[];
}

export interface ProvisionResult {
  scimId: string;
  ghLogin: string;
}

const logger = loggerFor('sso', 'scim');

export async function syncUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole = 'user'): Promise<ProvisionResult> {
  if (user.ghScimId) {
    logger.info('sync-existing', 'Updating existing SCIM user', { ssoUser: user.ssoUser, scimId: user.ghScimId, enterpriseRole });
    const updated = await replaceUser(user.ghScimId, user, enterpriseRole);
    if (updated) return resultFromScimUser(updated);
  }
  logger.info('sync-create', 'Creating SCIM user', { ssoUser: user.ssoUser, enterpriseRole });
  const created = await createUser(user, enterpriseRole);
  if (created) return resultFromScimUser(created);
  logger.info('sync-conflict-lookup', 'SCIM user already exists, looking up by SSO user', { ssoUser: user.ssoUser });
  const existing = await findScimUserByUsername(user.ssoUser);
  if (!existing?.id) throw new Error(`SCIM user ${user.ssoUser} already exists but could not be found`);
  logger.info('sync-conflict-update', 'Updating existing SCIM user found by SSO user', { ssoUser: user.ssoUser, scimId: existing.id });
  const updated = await replaceUser(existing.id, user, enterpriseRole);
  if (!updated) throw new Error(`SCIM user ${user.ssoUser} disappeared before update`);
  return resultFromScimUser(updated);
}

export async function suspendUser(scimId: string): Promise<void> {
  logger.info('suspend', 'Suspending SCIM user', { scimId });
  const res = await scimFetch(`/Users/${scimId}`, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify({ schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] }),
  }, 'SCIM suspend');
  if (!res.ok) throw new Error(`SCIM suspend failed: ${res.status} ${await res.text()}`);
}

export async function deleteProvisionedUser(user: SsoUserRecord): Promise<boolean> {
  logger.info('delete-provisioned-start', 'Deleting provisioned SCIM user if present', { ssoUser: user.ssoUser, scimId: user.ghScimId });
  let deleted = false;
  if (user.ghScimId) deleted = await deleteByScimId(user.ghScimId);
  const existing = await findScimUserByUsername(user.ssoUser);
  if (!existing?.id) return deleted;
  return (await deleteByScimId(existing.id)) || deleted;
}

async function createUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole): Promise<ScimUserResource | undefined> {
  const res = await scimFetch('/Users', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM create');
  if (res.status === 409) return undefined;
  if (!res.ok) throw new Error(`SCIM create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScimUserResource;
}

async function replaceUser(scimId: string, user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole): Promise<ScimUserResource | undefined> {
  const res = await scimFetch(`/Users/${scimId}`, {
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM update');
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`SCIM update failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScimUserResource;
}

export async function findScimUserByUsername(username: string): Promise<ScimUserResource | undefined> {
  const filter = encodeURIComponent(`userName eq "${scimStringLiteral(username)}"`);
  const res = await scimFetch(`/Users?filter=${filter}`, { headers: authHeader() }, 'SCIM lookup');
  if (!res.ok) throw new Error(`SCIM lookup failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as ScimListResponse;
  return body.Resources?.[0];
}

export async function listScimUsers(): Promise<ScimUserResource[]> {
  const users: ScimUserResource[] = [];
  const seen = new Set<string>();
  const count = 100;
  let startIndex = 1;
  while (true) {
    const search = new URLSearchParams({ startIndex: String(startIndex), count: String(count) });
    const res = await scimFetch(`/Users?${search}`, { headers: authHeader() }, 'SCIM list users');
    if (!res.ok) throw new Error(`SCIM list users failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as ScimListResponse;
    const page = body.Resources ?? [];
    const newUsers = page.filter((user) => {
      const key = user.id || user.userName;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    users.push(...newUsers);
    if (page.length === 0) return users;
    if (newUsers.length === 0) return users;
    if (typeof body.totalResults === 'number' && users.length >= body.totalResults) return users;
    if (page.length < count) return users;
    startIndex += body.itemsPerPage && body.itemsPerPage > 0 ? body.itemsPerPage : page.length;
  }
}

async function deleteByScimId(scimId: string): Promise<boolean> {
  const res = await scimFetch(`/Users/${scimId}`, { method: 'DELETE', headers: authHeader() }, 'SCIM delete');
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`SCIM delete failed: ${res.status} ${await res.text()}`);
  return true;
}

async function scimFetch(path: string, init: RequestInit, operation: string): Promise<Response> {
  const settings = getSsoRuntimeSettings();
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= settings.scimMaxRetries; attempt += 1) {
    await waitForScimSlot(settings.scimRequestDelayMs);
    const startedAt = Date.now();
    try {
      logger.debug('request', 'Sending SCIM request', { operation, method: init.method ?? 'GET', path, attempt });
      const res = await fetch(`${scimBase()}${path}`, init);
      const fields = { operation, method: init.method ?? 'GET', path, attempt, status: res.status, durationMs: Date.now() - startedAt };
      if (!isRetryable(res)) {
        if (res.ok) logger.info('response', 'SCIM request completed', fields);
        else logger.warn('response-failed', 'SCIM request returned non-success status', fields);
        return res;
      }
      const body = await res.text();
      if (attempt === settings.scimMaxRetries) throw new Error(`${operation} failed after retries: ${res.status} ${body}`);
      logger.warn('retry', 'SCIM request will retry after retryable response', { ...fields, responseBody: body });
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs, res));
    } catch (err) {
      lastError = err as Error;
      if (attempt === settings.scimMaxRetries) break;
      logger.warn('retry-error', 'SCIM request failed and will retry', { operation, path, attempt, durationMs: Date.now() - startedAt, ...errorFields(err) });
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs));
    }
  }
  logger.error('failed', 'SCIM request failed after retries', { operation, path, ...errorFields(lastError) });
  throw lastError ?? new Error(`${operation} failed`);
}

let nextScimRequestAt = 0;

async function waitForScimSlot(requestDelayMs: number): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextScimRequestAt - now);
  nextScimRequestAt = Math.max(now, nextScimRequestAt) + requestDelayMs;
  if (waitMs > 0) await sleep(waitMs);
}

function scimBase(): string {
  if (config.scimBaseUrl) return config.scimBaseUrl;
  if (config.mockGithubBaseUrl) return `${config.mockGithubBaseUrl}/scim/v2/enterprises/${config.enterpriseSlug}`;
  throw new Error('SCIM_BASE_URL must be configured, or MOCK_GITHUB_BASE_URL must be set for dev/mock usage.');
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.scimToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  };
}

function scimStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toScimUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    userName: user.ssoUser,
    externalId: user.ssoUser,
    displayName: user.ssoUser,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    roles: [{ value: enterpriseRole, primary: false }],
    active: true,
  };
}

function resultFromScimUser(body: ScimUserResource): ProvisionResult {
  if (!body.id) throw new Error(`SCIM response for ${body.userName} did not include an id`);
  const ghLogin = body.githubLogin ?? normalizeHandle(body.userName, config.enterpriseShortcode);
  logger.info('provision-result', 'SCIM user provisioned', { ssoUser: body.userName, scimId: body.id, ghLogin });
  return { scimId: body.id, ghLogin };
}

function isRetryable(res: Response): boolean {
  return res.status === 429 || res.status >= 500 || (res.status === 403 && Boolean(res.headers.get('retry-after')));
}

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function backoffMs(attempt: number, retryBaseDelayMs: number, res?: Response): number {
  return retryAfterMs(res ?? new Response()) ?? Math.min(30_000, retryBaseDelayMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
