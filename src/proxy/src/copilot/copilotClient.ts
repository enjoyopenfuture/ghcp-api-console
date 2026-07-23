import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import type { CopilotAuthContext } from './copilotAuth.js';

export const COPILOT_API_PATHS = ['/chat/completions', '/v1/messages', '/responses'] as const;
export const COPILOT_FORWARD_PATHS = ['/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/responses'] as const;
export type CopilotApiPath = (typeof COPILOT_FORWARD_PATHS)[number];
type ModelsCacheKey = string;

interface ModelsSnapshot {
  models: ModelInfo[];
  pathMap: Map<string, CopilotApiPath[]>;
  fetchedAt: number;
  expiresAt: number;
}

interface ModelsCacheEntry {
  snapshot?: ModelsSnapshot;
  refreshPromise?: Promise<ModelsSnapshot>;
}

export interface ModelInfo {
  id: string;
  [key: string]: unknown;
}

export interface ForwardCopilotRequestOptions {
  claudeCodeOptimized?: boolean;
  anthropicVersion?: string;
  anthropicBeta?: string;
  visionRequest?: boolean;
  initiator?: 'user' | 'agent';
  interactionType?: string;
}

export interface ListModelsOptions {
  useCache?: boolean;
}

export class CopilotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CopilotApiError';
  }
}

export class CopilotModelPathError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'CopilotModelPathError';
  }
}

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const MODELS_CACHE_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MODELS_CACHE_NEGATIVE_RECHECK_MS = 60 * 1000;
const modelsCache = new Map<ModelsCacheKey, ModelsCacheEntry>();
const modelsCacheLogger = new Logger('models-cache');

export async function listModels(copilot: CopilotAuthContext, options: ListModelsOptions = {}): Promise<ModelInfo[]> {
  const useCache = options.useCache !== false;
  const snapshot = await getModelsSnapshot(copilot, {
    forceRefresh: !useCache,
    allowStaleOnError: useCache,
  });
  return snapshot.models;
}

async function fetchModels(copilot: CopilotAuthContext): Promise<ModelInfo[]> {
  const res = await fetch(copilotUrl(copilot, '/models'), { headers: modelHeaders(copilot) });
  if (!res.ok) throw new CopilotApiError(`List models failed with HTTP ${res.status}.`, res.status);
  const data = (await res.json()) as { data?: ModelInfo[] };
  if (!Array.isArray(data.data)) throw new CopilotApiError('List models returned an invalid response.', 502);
  return data.data;
}

export async function validateCopilotOauthToken(identity: string, accessToken: string): Promise<void> {
  await fetchModels({ identity, accessToken, api: config.copilotApiBaseUrl });
}

export function clearModelsCache(identity: string): void {
  modelsCache.delete(identity);
}

export async function forwardCopilotRequest(
  copilot: CopilotAuthContext,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  options: ForwardCopilotRequestOptions = {},
): Promise<Response> {
  return fetch(copilotUrl(copilot, path), {
    method: 'POST',
    headers: copilotHeaders(copilot, body.stream === true, options),
    body: JSON.stringify(body),
  });
}

export async function assertModelSupportsPath(
  copilot: CopilotAuthContext,
  path: CopilotApiPath,
  model: string,
): Promise<void> {
  const capabilityPath = modelCapabilityPath(path);
  let snapshot = await getModelsSnapshot(copilot);
  let supportedPaths = snapshot.pathMap.get(model);
  if (supportedPaths?.includes(capabilityPath)) return;

  if (Date.now() - snapshot.fetchedAt > MODELS_CACHE_NEGATIVE_RECHECK_MS) {
    snapshot = await getModelsSnapshot(copilot, { forceRefresh: true, allowStaleOnError: false });
    supportedPaths = snapshot.pathMap.get(model);
    if (supportedPaths?.includes(capabilityPath)) return;
  }

  throw modelPathError(model, path, supportedPaths);
}

export function modelSupportsPath(model: ModelInfo, path: CopilotApiPath): boolean {
  return inferSupportedPaths(model).includes(modelCapabilityPath(path));
}

async function getModelsSnapshot(
  copilot: CopilotAuthContext,
  options: { forceRefresh?: boolean; allowStaleOnError?: boolean } = {},
): Promise<ModelsSnapshot> {
  const cacheKey = modelsCacheKey(copilot);
  const entry = modelsCacheEntry(cacheKey);
  const now = Date.now();
  const snapshot = entry.snapshot;
  if (!options.forceRefresh && snapshot && snapshot.expiresAt > now) return snapshot;

  try {
    return await refreshModelsSnapshot(cacheKey, copilot, entry);
  } catch (err) {
    if (err instanceof CopilotApiError && (err.status === 401 || err.status === 403)) throw err;
    if (options.allowStaleOnError !== false && snapshot && now - snapshot.fetchedAt <= MODELS_CACHE_STALE_MAX_AGE_MS) {
      modelsCacheLogger.warn('refresh-failed-stale', 'Using stale Copilot models cache after refresh failed', {
        cacheKey,
        ageSeconds: Math.round((now - snapshot.fetchedAt) / 1000),
        error: errorMessage(err),
      });
      return snapshot;
    }
    throw err;
  }
}

function modelsCacheEntry(cacheKey: ModelsCacheKey): ModelsCacheEntry {
  const existing = modelsCache.get(cacheKey);
  if (existing) return existing;
  const created: ModelsCacheEntry = {};
  modelsCache.set(cacheKey, created);
  return created;
}

function refreshModelsSnapshot(
  cacheKey: ModelsCacheKey,
  copilot: CopilotAuthContext,
  entry: ModelsCacheEntry,
): Promise<ModelsSnapshot> {
  if (entry.refreshPromise) return entry.refreshPromise;

  const promise = fetchModels(copilot)
    .then((models) => {
      const now = Date.now();
      const snapshot: ModelsSnapshot = {
        models,
        pathMap: buildPathMap(models),
        fetchedAt: now,
        expiresAt: now + MODELS_CACHE_TTL_MS,
      };
      entry.snapshot = snapshot;
      modelsCacheLogger.info('refresh-done', 'Refreshed Copilot models cache', {
        cacheKey,
        modelCount: models.length,
        ttlSeconds: Math.round(MODELS_CACHE_TTL_MS / 1000),
      });
      return snapshot;
    })
    .finally(() => {
      if (entry.refreshPromise === promise) entry.refreshPromise = undefined;
    });

  entry.refreshPromise = promise;
  return promise;
}

function buildPathMap(models: ModelInfo[]): Map<string, CopilotApiPath[]> {
  const pathMap = new Map<string, CopilotApiPath[]>();
  for (const model of models) pathMap.set(model.id, inferSupportedPaths(model));
  return pathMap;
}

function modelPathError(model: string, path: CopilotApiPath, supportedPaths: CopilotApiPath[] | undefined): CopilotModelPathError {
  if (!supportedPaths) return new CopilotModelPathError(`Unknown Copilot model "${model}". Check GET /v1/models for available models.`);
  if (supportedPaths.length === 0) {
    return new CopilotModelPathError(
      `Cannot determine a supported Copilot LLM API path for model "${model}". Check GET /v1/models for model metadata.`,
    );
  }
  return new CopilotModelPathError(`Model "${model}" is not available on ${path}. Supported path(s): ${supportedPaths.join(', ')}.`);
}

function modelsCacheKey(copilot: CopilotAuthContext): ModelsCacheKey {
  return copilot.identity;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function copilotHeaders(
  copilot: CopilotAuthContext,
  acceptsStream = false,
  options: ForwardCopilotRequestOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilot.accessToken}`,
    'Content-Type': 'application/json',
    Accept: acceptsStream ? 'text/event-stream' : 'application/json',
    'Openai-Intent': 'conversation-edits',
    'X-Request-Id': randomUUID(),
    'User-Agent': config.opencodeUserAgent,
    'X-GitHub-Api-Version': config.githubApiVersion,
    'x-initiator': options.initiator ?? 'user',
  };
  if (options.anthropicVersion) headers['anthropic-version'] = options.anthropicVersion;
  if (options.anthropicBeta) headers['anthropic-beta'] = options.anthropicBeta;
  if (options.visionRequest) headers['Copilot-Vision-Request'] = 'true';
  if (options.interactionType) headers['X-Interaction-Type'] = options.interactionType;
  return headers;
}

function modelHeaders(copilot: CopilotAuthContext): Record<string, string> {
  return {
    Authorization: `Bearer ${copilot.accessToken}`,
    Accept: 'application/json',
    'User-Agent': config.opencodeUserAgent,
    'X-GitHub-Api-Version': config.githubApiVersion,
  };
}

function copilotUrl(copilot: CopilotAuthContext, path: string): string {
  return `${copilot.api.replace(/\/+$/, '')}${path}`;
}

function inferSupportedPaths(model: ModelInfo): CopilotApiPath[] {
  const metadataPaths = collectMetadataPathHints(model);
  if (metadataPaths.length > 0) return metadataPaths;
  const id = model.id.toLowerCase();
  if (/\b(claude|anthropic)\b/.test(id)) return ['/v1/messages'];
  if (/(^|[-_.])gpt[-_.]?5($|[-_.])|(^|[-_.])codex($|[-_.])|(^|[-_.])o\d($|[-_.])/.test(id)) return ['/responses'];
  if (/\b(gpt|openai|gemini|llama|mistral)\b/.test(id)) return ['/chat/completions'];
  if (capabilityType(model) === 'chat') return ['/chat/completions'];
  return [];
}

function modelCapabilityPath(path: CopilotApiPath): CopilotApiPath {
  return path === '/v1/messages/count_tokens' ? '/v1/messages' : path;
}

function capabilityType(model: ModelInfo): string | undefined {
  const capabilities = model.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return undefined;
  const type = (capabilities as Record<string, unknown>).type;
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

function collectMetadataPathHints(value: unknown, key = ''): CopilotApiPath[] {
  const found = new Set<CopilotApiPath>();
  collectMetadataPathHintsInto(value, key, found);
  return [...found];
}

function collectMetadataPathHintsInto(value: unknown, key: string, found: Set<CopilotApiPath>): void {
  if (typeof value === 'string') {
    const path = pathHintFromString(value, key);
    if (path) found.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMetadataPathHintsInto(item, key, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) collectMetadataPathHintsInto(childValue, childKey, found);
}

function pathHintFromString(value: string, key: string): CopilotApiPath | undefined {
  const normalized = value.trim().toLowerCase();
  const normalizedKey = key.toLowerCase();
  if (normalized.includes('/chat/completions') || normalized.includes('chat_completions')) return '/chat/completions';
  if (normalized.includes('/v1/messages') || normalized.includes('anthropic_messages')) return '/v1/messages';
  if (normalized.includes('/responses') || normalized.includes('responses_api')) return '/responses';
  if (!/(endpoint|api|path|route|capabilit)/.test(normalizedKey)) return undefined;
  if (/^chat[-_. ]?completions$/.test(normalized)) return '/chat/completions';
  if (/^(v1[-_/])?messages$/.test(normalized) || normalized === 'anthropic') return '/v1/messages';
  if (normalized === 'responses' || normalized === 'response') return '/responses';
  return undefined;
}
