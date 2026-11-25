import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import { collectInlineImages, replaceInlineImages, type InlineImage } from '../routes/imageContent.js';
import type { CopilotAuthContext } from './copilotAuth.js';
import type { CopilotApiPath } from './copilotClient.js';

export interface ImageAttachmentResult {
  /** Body to forward upstream: the original object when nothing was replaced. */
  body: Record<string, unknown>;
  /** Unique cache keys of the attachment URLs placed into `body` (hits and fresh uploads). */
  attachmentKeys: string[];
}

export interface ChatAttachmentUpload {
  data: Uint8Array;
  /** Already sanitized file name. */
  name: string;
  contentType: string;
}

/** Resolves to the attachment URL, or undefined when the image stays inline. Never rejects. */
type UrlPromise = Promise<string | undefined>;

interface PendingEntry {
  kind: 'pending';
  promise: UrlPromise;
}

type CacheEntry = { kind: 'url'; url: string; expiresAt: number } | { kind: 'failed'; until: number } | PendingEntry;

interface UniqueImage {
  key: string;
  image: InlineImage;
}

interface UploadJob extends UniqueImage {
  entry: PendingEntry;
  resolve: (url: string | undefined) => void;
}

interface UploadFailure {
  /** backoff: pause the identity's uploads; rejected: remember the image as not uploadable; retry: next request tries again. */
  kind: 'backoff' | 'rejected' | 'retry';
  status?: number;
  error?: string;
  response?: string;
}

type UploadOutcome = { kind: 'uploaded'; url: string } | UploadFailure;

interface CacheLookup {
  urls: Map<string, string>;
  /** Uploads of the same images already in flight for another request. */
  pending: Map<string, UrlPromise>;
  candidates: UniqueImage[];
}

interface PrepareContext {
  copilot: CopilotAuthContext;
  path: CopilotApiPath;
  body: Record<string, unknown>;
  /** Cache key of every inline image occurrence, in collectInlineImages order. */
  keys: string[];
  unique: UniqueImage[];
}

interface PrepareCounts {
  uploaded: number;
  cacheHits: number;
}

/** Decoded size whose base64 plus upload metadata stays within the 20 MB attachment limit. */
const MAX_UPLOAD_IMAGE_BYTES = 15 * 1024 * 1024 - 4 * 1024;
/**
 * /v1/messages only resolves attachment URLs whose base64 is at most 5,000,000 bytes (measured: 3,750,000 raw
 * bytes pass, 3,760,000 get a plain 413), while inline base64 images there may be about twice as large.
 */
const MAX_MESSAGES_UPLOAD_IMAGE_BYTES = 3_750_000;
/** Copilot gateway request body limits, enforced before model routing. */
const CHAT_COMPLETIONS_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const RESPONSES_MESSAGES_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_CONCURRENCY = 4;
const ATTACHMENT_URL_TTL_MS = 60 * 60 * 1000;
const REJECTED_IMAGE_TTL_MS = 60 * 60 * 1000;
const UPLOAD_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;
const MAX_ATTACHMENT_NAME_LENGTH = 100;
const LOGGED_RESPONSE_CHARS = 200;
const BACKOFF_STATUSES = new Set([401, 403, 404]);
const REJECTED_STATUSES = new Set([400, 413, 415, 422]);

const attachmentCache = new Map<string, CacheEntry>();
const uploadBackoffUntil = new Map<string, number>();
const logger = new Logger('image-attachments');

/**
 * Uploads/reuses attachment URLs for inline images.
 * Never rejects: unexpected errors are logged and the original body is returned.
 */
export async function prepareImageAttachments(
  copilot: CopilotAuthContext,
  path: CopilotApiPath,
  body: Record<string, unknown>,
): Promise<ImageAttachmentResult> {
  try {
    const mode = config.imageUploadMode;
    if (mode === 'off' || path === '/v1/messages/count_tokens') return { body, attachmentKeys: [] };
    const images = collectInlineImages(path, body);
    if (images.length === 0) return { body, attachmentKeys: [] };
    const keys = images.map(attachmentKey);
    return await attachImages({ copilot, path, body, keys, unique: uniqueImages(images, keys) }, mode);
  } catch (err) {
    logger.error('prepare-failed', 'Preparing Copilot image attachments failed; sending images inline', {
      identity: copilot.identity,
      path,
      error: errorMessage(err),
    });
    return { body, attachmentKeys: [] };
  }
}

/** Drops cached URLs (e.g. after Copilot rejected a request that used them). */
export function evictImageAttachments(identity: string, attachmentKeys: readonly string[]): void {
  for (const key of attachmentKeys) attachmentCache.delete(cacheKey(identity, key));
}

/** Raw POST to config.copilotAttachmentUploadUrl with the identity's OAuth token. Rejects on network error / 60 s timeout. */
export async function postChatAttachment(copilot: CopilotAuthContext, upload: ChatAttachmentUpload): Promise<Response> {
  // Like VS Code, the media type keeps its "/" raw while "+" and other reserved characters stay encoded.
  const contentType = encodeURIComponent(upload.contentType).replace(/%2F/gi, '/');
  return fetch(`${config.copilotAttachmentUploadUrl}?name=${encodeURIComponent(upload.name)}&content_type=${contentType}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${copilot.accessToken}`,
      'Content-Type': 'application/octet-stream',
      Accept: 'application/json',
      'User-Agent': config.opencodeUserAgent,
    },
    body: upload.data,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
}

/** VS Code-compatible sanitizing: keep [A-Za-z0-9._-], truncate to 100 chars, fallback 'image' when empty. */
export function sanitizeAttachmentName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_ATTACHMENT_NAME_LENGTH) || 'image';
}

async function attachImages(ctx: PrepareContext, mode: 'always' | 'auto'): Promise<ImageAttachmentResult> {
  const { urls, pending, candidates } = lookupCachedImages(ctx);
  const cacheHits = urls.size;
  if (mode === 'auto') {
    const body = rewriteBody(ctx, urls);
    // The gateway accepts this body as is, so only already cached URLs are worth using.
    if (Buffer.byteLength(JSON.stringify(body)) <= requestBodyLimit(ctx.path)) {
      return finish(ctx, body, urls, { uploaded: 0, cacheHits });
    }
  }
  const [awaited, uploaded] = await Promise.all([awaitPendingUploads(pending, urls), uploadImages(ctx, candidates, urls)]);
  return finish(ctx, rewriteBody(ctx, urls), urls, { uploaded, cacheHits: cacheHits + awaited });
}

function lookupCachedImages(ctx: PrepareContext): CacheLookup {
  const now = Date.now();
  const maxBytes = maxUploadImageBytes(ctx.path);
  const lookup: CacheLookup = { urls: new Map(), pending: new Map(), candidates: [] };
  for (const item of ctx.unique) {
    // Checked before the cache, so a URL uploaded for a more permissive path is never reused here.
    if (decodedSize(item.image.base64) > maxBytes) continue;
    const entry = cachedEntry(ctx.copilot.identity, item.key, now);
    if (entry?.kind === 'url') lookup.urls.set(item.key, entry.url);
    else if (entry?.kind === 'pending') lookup.pending.set(item.key, entry.promise);
    else if (!entry) lookup.candidates.push(item);
  }
  return lookup;
}

function maxUploadImageBytes(path: CopilotApiPath): number {
  return path === '/v1/messages' ? MAX_MESSAGES_UPLOAD_IMAGE_BYTES : MAX_UPLOAD_IMAGE_BYTES;
}

async function awaitPendingUploads(pending: ReadonlyMap<string, UrlPromise>, urls: Map<string, string>): Promise<number> {
  let resolved = 0;
  await Promise.all(
    [...pending].map(async ([key, promise]) => {
      const url = await promise;
      if (!url) return;
      urls.set(key, url);
      resolved++;
    }),
  );
  return resolved;
}

async function uploadImages(ctx: PrepareContext, candidates: readonly UniqueImage[], urls: Map<string, string>): Promise<number> {
  const jobs = candidates
    .filter((candidate) => !skipDuringBackoff(ctx, candidate))
    .map((candidate) => createUploadJob(ctx, candidate));
  let uploaded = 0;
  try {
    await runWorkerPool(jobs, UPLOAD_CONCURRENCY, async (job) => {
      const url = await runUploadJob(ctx, job);
      if (!url) return;
      urls.set(job.key, url);
      uploaded++;
    });
  } finally {
    // Settles jobs a failed worker never started, so requests awaiting their pending entries cannot hang.
    for (const job of jobs) {
      settlePending(ctx, job, undefined);
      job.resolve(undefined);
    }
  }
  return uploaded;
}

function createUploadJob(ctx: PrepareContext, candidate: UniqueImage): UploadJob {
  let resolve!: (url: string | undefined) => void;
  const promise: UrlPromise = new Promise((settle) => {
    resolve = settle;
  });
  const entry: PendingEntry = { kind: 'pending', promise };
  // Registered before any upload starts so concurrent requests await it instead of uploading again.
  storeCacheEntry(cacheKey(ctx.copilot.identity, candidate.key), entry);
  return { ...candidate, entry, resolve };
}

async function runWorkerPool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Always settles the job's cache entry and resolves its promise, which never rejects. */
async function runUploadJob(ctx: PrepareContext, job: UploadJob): Promise<string | undefined> {
  let url: string | undefined;
  try {
    url = await uploadImage(ctx, job);
  } catch (err) {
    failUpload(ctx, job, decodedSize(job.image.base64), { kind: 'retry', error: errorMessage(err) });
  } finally {
    job.resolve(url);
  }
  return url;
}

async function uploadImage(ctx: PrepareContext, job: UploadJob): Promise<string | undefined> {
  // Another upload of this request may have started a backoff while this one was queued.
  if (skipDuringBackoff(ctx, job)) {
    settlePending(ctx, job, undefined);
    return undefined;
  }
  const data = Buffer.from(job.image.base64, 'base64');
  let outcome: UploadOutcome;
  try {
    const response = await postChatAttachment(ctx.copilot, { data, name: attachmentName(job), contentType: job.image.mediaType });
    outcome = await readUploadOutcome(response);
  } catch (err) {
    outcome = { kind: 'backoff', error: errorMessage(err) };
  }
  if (outcome.kind !== 'uploaded') {
    failUpload(ctx, job, data.byteLength, outcome);
    return undefined;
  }
  settlePending(ctx, job, { kind: 'url', url: outcome.url, expiresAt: Date.now() + ATTACHMENT_URL_TTL_MS });
  return outcome.url;
}

async function readUploadOutcome(response: Response): Promise<UploadOutcome> {
  const { status } = response;
  const kind = response.ok ? 'retry' : failureKind(status);
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return { kind, status, error: errorMessage(err) };
  }
  const url = response.ok ? attachmentUrl(text) : undefined;
  if (url) return { kind: 'uploaded', url };
  return {
    kind,
    status,
    error: response.ok ? 'Upload response did not include an https attachment URL.' : undefined,
    response: text.slice(0, LOGGED_RESPONSE_CHARS) || undefined,
  };
}

function failureKind(status: number): UploadFailure['kind'] {
  if (BACKOFF_STATUSES.has(status)) return 'backoff';
  return REJECTED_STATUSES.has(status) ? 'rejected' : 'retry';
}

function attachmentUrl(text: string): string | undefined {
  try {
    const url: unknown = (JSON.parse(text) as { url?: unknown } | null)?.url;
    return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
  } catch {
    return undefined;
  }
}

function failUpload(ctx: PrepareContext, job: UploadJob, bytes: number, failure: UploadFailure): void {
  const now = Date.now();
  if (failure.kind === 'backoff') uploadBackoffUntil.set(ctx.copilot.identity, now + UPLOAD_BACKOFF_MS);
  settlePending(ctx, job, failure.kind === 'rejected' ? { kind: 'failed', until: now + REJECTED_IMAGE_TTL_MS } : undefined);
  logger.warn('upload-failed', 'Copilot attachment upload failed; sending image inline', {
    identity: ctx.copilot.identity,
    path: ctx.path,
    status: failure.status,
    error: failure.error,
    mediaType: job.image.mediaType,
    bytes,
    backoffSeconds: failure.kind === 'backoff' ? UPLOAD_BACKOFF_MS / 1000 : undefined,
    response: failure.response,
  });
}

/** Replaces (or drops) the job's pending entry unless it was evicted or superseded meanwhile. */
function settlePending(ctx: PrepareContext, job: UploadJob, next: CacheEntry | undefined): void {
  const key = cacheKey(ctx.copilot.identity, job.key);
  if (attachmentCache.get(key) !== job.entry) return;
  if (next) storeCacheEntry(key, next);
  else attachmentCache.delete(key);
}

function skipDuringBackoff(ctx: PrepareContext, { image }: UniqueImage): boolean {
  const remainingMs = backoffRemainingMs(ctx.copilot.identity);
  if (remainingMs === 0) return false;
  logger.debug('upload-skipped', 'Copilot attachment uploads are backing off; sending image inline', {
    identity: ctx.copilot.identity,
    path: ctx.path,
    mediaType: image.mediaType,
    bytes: decodedSize(image.base64),
    backoffSeconds: Math.ceil(remainingMs / 1000),
  });
  return true;
}

function backoffRemainingMs(identity: string): number {
  const until = uploadBackoffUntil.get(identity);
  if (until === undefined) return 0;
  const remainingMs = until - Date.now();
  if (remainingMs > 0) return remainingMs;
  uploadBackoffUntil.delete(identity);
  return 0;
}

function finish(
  ctx: PrepareContext,
  body: Record<string, unknown>,
  urls: ReadonlyMap<string, string>,
  counts: PrepareCounts,
): ImageAttachmentResult {
  const attachmentKeys = ctx.unique.map(({ key }) => key).filter((key) => urls.has(key));
  const fields = {
    identity: ctx.copilot.identity,
    path: ctx.path,
    images: ctx.keys.length,
    uploaded: counts.uploaded,
    cacheHits: counts.cacheHits,
    inline: ctx.unique.length - attachmentKeys.length,
  };
  if (counts.uploaded > 0) logger.info('images-uploaded', 'Replaced inline images with Copilot attachment URLs', fields);
  else logger.debug('images-prepared', 'Prepared inline images for Copilot', fields);
  return { body, attachmentKeys };
}

function rewriteBody(ctx: PrepareContext, urls: ReadonlyMap<string, string>): Record<string, unknown> {
  const occurrenceUrls = ctx.keys.map((key) => urls.get(key));
  let index = 0;
  // replaceInlineImages visits inline images in exactly the order collectInlineImages returned them.
  return replaceInlineImages(ctx.path, ctx.body, () => occurrenceUrls[index++]);
}

function requestBodyLimit(path: CopilotApiPath): number {
  return path === '/chat/completions' ? CHAT_COMPLETIONS_BODY_LIMIT_BYTES : RESPONSES_MESSAGES_BODY_LIMIT_BYTES;
}

function cacheKey(identity: string, key: string): string {
  return `${identity}\n${key}`;
}

function cachedEntry(identity: string, key: string, now: number): CacheEntry | undefined {
  const compositeKey = cacheKey(identity, key);
  const entry = attachmentCache.get(compositeKey);
  if (!entry || entry.kind === 'pending') return entry;
  if ((entry.kind === 'url' ? entry.expiresAt : entry.until) <= now) {
    attachmentCache.delete(compositeKey);
    return undefined;
  }
  if (entry.kind === 'url') {
    // Re-inserting moves the URL to the most recently used end of the map.
    attachmentCache.delete(compositeKey);
    attachmentCache.set(compositeKey, entry);
  }
  return entry;
}

function storeCacheEntry(compositeKey: string, entry: CacheEntry): void {
  attachmentCache.delete(compositeKey);
  attachmentCache.set(compositeKey, entry);
  while (attachmentCache.size > MAX_CACHE_ENTRIES) {
    const oldest = attachmentCache.keys().next().value;
    if (oldest === undefined) break;
    attachmentCache.delete(oldest);
  }
}

function attachmentKey(image: InlineImage): string {
  // Base64 is ASCII, so latin1 hashes the same bytes without UTF-8 encoding work.
  return createHash('sha256').update(`${image.mediaType}\n`).update(image.base64, 'latin1').digest('hex');
}

function uniqueImages(images: readonly InlineImage[], keys: readonly string[]): UniqueImage[] {
  const unique = new Map<string, UniqueImage>();
  images.forEach((image, index) => {
    const key = keys[index];
    if (!unique.has(key)) unique.set(key, { key, image });
  });
  return [...unique.values()];
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function attachmentName({ key, image }: UniqueImage): string {
  const subtype = image.mediaType.slice(image.mediaType.indexOf('/') + 1).split(/[+;]/, 1)[0];
  const extension = subtype.toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'bin';
  return sanitizeAttachmentName(`img-${key.slice(0, 16)}.${extension}`);
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch reports network failures as "fetch failed" with the actual reason in `cause`.
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}
