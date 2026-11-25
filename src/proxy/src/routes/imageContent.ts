import type { CopilotApiPath } from '../copilot/copilotClient.js';

export interface InlineImage {
  /** Lowercased image media type, e.g. 'image/png' ('image/jpg' normalized to 'image/jpeg'). */
  mediaType: string;
  /** Base64 payload only (no data: prefix). Non-empty. */
  base64: string;
}

type RecordMapper = (record: Record<string, unknown>) => Record<string, unknown>;

interface ImageRules {
  /** Copy-on-write map over every image part (inline or URL) in document order. */
  mapImageParts(body: Record<string, unknown>, mapPart: RecordMapper): Record<string, unknown>;
  inlineImage(part: Record<string, unknown>): InlineImage | undefined;
  urlPart(part: Record<string, unknown>, url: string, image: InlineImage): Record<string, unknown>;
}

const DATA_URL_HEADER_MAX_LENGTH = 256;
const DATA_URL_HEADER = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,]*)*;base64$/i;
const IMAGE_MEDIA_TYPE = /^image\/[a-z0-9.+-]+$/i;

const CHAT_RULES: ImageRules = {
  mapImageParts: mapChatImageParts,
  inlineImage: chatInlineImage,
  urlPart: chatUrlPart,
};

const RESPONSES_RULES: ImageRules = {
  mapImageParts: mapResponsesImageParts,
  inlineImage: responsesInlineImage,
  urlPart: responsesUrlPart,
};

const MESSAGES_RULES: ImageRules = {
  mapImageParts: mapMessagesImageParts,
  inlineImage: messagesInlineImage,
  urlPart: messagesUrlPart,
};

/** True when the body carries any image content (inline or URL) — OpenCode's Copilot-Vision-Request rule. */
export function containsImageContent(path: CopilotApiPath, body: Record<string, unknown>): boolean {
  let found = false;
  imageRules(path).mapImageParts(body, (part) => {
    found = true;
    return part;
  });
  return found;
}

/** Inline base64 images in document order (duplicates included). */
export function collectInlineImages(path: CopilotApiPath, body: Record<string, unknown>): InlineImage[] {
  const images: InlineImage[] = [];
  // Reuses the replace walk so collected images match the order resolveUrl sees them.
  replaceInlineImages(path, body, (image) => {
    images.push(image);
    return undefined;
  });
  return images;
}

/**
 * Copy-on-write rewrite: every inline image for which resolveUrl returns a URL is replaced by the
 * endpoint's URL form. Returns the SAME body object when nothing was replaced; never mutates input.
 */
export function replaceInlineImages(
  path: CopilotApiPath,
  body: Record<string, unknown>,
  resolveUrl: (image: InlineImage) => string | undefined,
): Record<string, unknown> {
  const rules = imageRules(path);
  return rules.mapImageParts(body, (part) => {
    const image = rules.inlineImage(part);
    if (!image) return part;
    const url = resolveUrl(image);
    return url ? rules.urlPart(part, url, image) : part;
  });
}

/** Parses `data:image/<subtype>[;param...];base64,<payload>`; undefined for anything else. */
export function parseImageDataUrl(value: string): InlineImage | undefined {
  if (value.slice(0, 5).toLowerCase() !== 'data:') return undefined;
  // Payloads can be tens of MiB, so only the bounded header is ever matched.
  const comma = value.slice(0, DATA_URL_HEADER_MAX_LENGTH).indexOf(',');
  if (comma < 0) return undefined;
  const mediaType = normalizeImageMediaType(DATA_URL_HEADER.exec(value.slice(0, comma))?.[1]);
  const base64 = value.slice(comma + 1);
  return mediaType && base64 ? { mediaType, base64 } : undefined;
}

function imageRules(path: CopilotApiPath): ImageRules {
  switch (path) {
    case '/chat/completions':
      return CHAT_RULES;
    case '/responses':
      return RESPONSES_RULES;
    case '/v1/messages':
    case '/v1/messages/count_tokens':
      return MESSAGES_RULES;
  }
}

function mapChatImageParts(body: Record<string, unknown>, mapPart: RecordMapper): Record<string, unknown> {
  return mapField(body, 'messages', (messages) =>
    mapRecords(messages, (message) => mapField(message, 'content', (content) => mapPartsOfType(content, 'image_url', mapPart))),
  );
}

function chatInlineImage(part: Record<string, unknown>): InlineImage | undefined {
  const reference = typeof part.image_url === 'string' ? part.image_url : recordField(part.image_url)?.url;
  return typeof reference === 'string' ? parseImageDataUrl(reference) : undefined;
}

function chatUrlPart(part: Record<string, unknown>, url: string, image: InlineImage): Record<string, unknown> {
  // Copilot rejects URL images without media_type ("image media type is required").
  return { ...part, image_url: { ...recordField(part.image_url), url, media_type: image.mediaType } };
}

function mapResponsesImageParts(body: Record<string, unknown>, mapPart: RecordMapper): Record<string, unknown> {
  const mapParts = (parts: unknown) => mapPartsOfType(parts, 'input_image', mapPart);
  // `output` carries the list output of function_call_output items.
  return mapField(body, 'input', (input) =>
    mapRecords(input, (item) => mapField(mapField(item, 'content', mapParts), 'output', mapParts)),
  );
}

function responsesInlineImage(part: Record<string, unknown>): InlineImage | undefined {
  return typeof part.image_url === 'string' ? parseImageDataUrl(part.image_url) : undefined;
}

function responsesUrlPart(part: Record<string, unknown>, url: string): Record<string, unknown> {
  return { ...part, image_url: url };
}

function mapMessagesImageParts(body: Record<string, unknown>, mapPart: RecordMapper): Record<string, unknown> {
  const mapBlock = (block: Record<string, unknown>): Record<string, unknown> => {
    if (block.type === 'tool_result') return mapField(block, 'content', (content) => mapPartsOfType(content, 'image', mapPart));
    return block.type === 'image' ? mapPart(block) : block;
  };
  return mapField(body, 'messages', (messages) =>
    mapRecords(messages, (message) => mapField(message, 'content', (content) => mapRecords(content, mapBlock))),
  );
}

function messagesInlineImage(block: Record<string, unknown>): InlineImage | undefined {
  const source = recordField(block.source);
  if (source?.type !== 'base64') return undefined;
  const mediaType = normalizeImageMediaType(source.media_type);
  const base64 = stringField(source.data);
  return mediaType && base64 ? { mediaType, base64 } : undefined;
}

function messagesUrlPart(block: Record<string, unknown>, url: string): Record<string, unknown> {
  return { ...block, source: { type: 'url', url } };
}

function normalizeImageMediaType(value: unknown): string | undefined {
  if (typeof value !== 'string' || !IMAGE_MEDIA_TYPE.test(value)) return undefined;
  const mediaType = value.toLowerCase();
  return mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;
}

function mapPartsOfType(parts: unknown, type: string, mapPart: RecordMapper): unknown {
  return mapRecords(parts, (part) => (part.type === type ? mapPart(part) : part));
}

/** Maps the record items of an array, returning the same array when no item changed. */
function mapRecords(value: unknown, map: RecordMapper): unknown {
  if (!Array.isArray(value)) return value;
  let copy: unknown[] | undefined;
  for (let index = 0; index < value.length; index++) {
    const record = recordField(value[index]);
    if (!record) continue;
    const next = map(record);
    if (next === record) continue;
    copy ??= value.slice();
    copy[index] = next;
  }
  return copy ?? value;
}

/** Maps one field, returning the same record when its value did not change. */
function mapField(record: Record<string, unknown>, key: string, map: (value: unknown) => unknown): Record<string, unknown> {
  const value = record[key];
  const next = map(value);
  return next === value ? record : { ...record, [key]: next };
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
