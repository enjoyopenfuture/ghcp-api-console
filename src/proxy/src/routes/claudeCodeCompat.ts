import type { Request } from 'express';
import {
  getAnthropicModelProfile,
  normalizeAnthropicModelId,
  type AnthropicModelProfile,
} from './anthropicModelProfiles.js';
import { AUTOMATIC_CONTINUE_PROMPT, resolveRequestIntent } from './requestIntent.js';

export interface ClaudeCodeForwardOptions {
  claudeCodeOptimized: true;
  anthropicVersion: string;
  anthropicBeta?: string;
  visionRequest: boolean;
  initiator?: 'user' | 'agent';
  interactionType?: string;
}

export interface ClaudeCodePreflightError {
  status: number;
  type: string;
  message: string;
}

export interface ClaudeCodePrepareOptions {
  tokenCounting?: boolean;
}

export interface ClaudeCodePreparedRequest {
  body: Record<string, unknown>;
  forwardOptions: ClaudeCodeForwardOptions;
  preflightError?: ClaudeCodePreflightError;
}

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
const ADVANCED_TOOL_USE_BETA = 'advanced-tool-use-2025-11-20';
const TOKEN_COUNTING_BETA = 'token-counting-2024-11-01';
const CONTEXT_1M_BETA = 'context-1m-2025-08-07';
const INJECTED_SYSTEM_MARKER = '[Claude Code injected]\n';
const TOOL_LOADED_MARKER = 'Tool loaded.';

const ALLOWED_ANTHROPIC_BETAS = new Set([
  INTERLEAVED_THINKING_BETA,
  CONTEXT_MANAGEMENT_BETA,
  ADVANCED_TOOL_USE_BETA,
  TOKEN_COUNTING_BETA,
  CONTEXT_1M_BETA,
]);

const GLOBAL_BETA_STRIPS = ['claude-code-*', 'prompt-caching-*', 'advisor-tool-*', 'structured-outputs-*'];

export function prepareClaudeCodeMessagesRequest(
  req: Request,
  body: Record<string, unknown>,
  options: ClaudeCodePrepareOptions = {},
): ClaudeCodePreparedRequest {
  const prepared = preprocessClaudeCodeMessagesBody(body);
  const profile = getAnthropicModelProfile(stringField(prepared.model) ?? '');
  const intent = resolveRequestIntent('/v1/messages', prepared, req.get('x-initiator'));
  const unsupportedTool = firstWebSearchToolType(prepared);

  return {
    body: prepared,
    forwardOptions: {
      claudeCodeOptimized: true,
      anthropicVersion: headerValue(req, 'anthropic-version') ?? DEFAULT_ANTHROPIC_VERSION,
      anthropicBeta: anthropicBetaHeader(req, prepared, profile, options),
      visionRequest: containsContentBlockType(prepared, 'image'),
      initiator: intent.initiator,
      interactionType: intent.interactionType,
    },
    preflightError: unsupportedTool
      ? { status: 400, type: 'not_supported', message: webSearchUnsupportedMessageForTool(unsupportedTool) }
      : undefined,
  };
}

export function preprocessClaudeCodeMessagesBody(body: Record<string, unknown>): Record<string, unknown> {
  const prepared = cloneJson(body) as Record<string, unknown>;
  normalizeModel(prepared);
  const profile = getAnthropicModelProfile(stringField(prepared.model) ?? '');

  stripCacheControlScope(prepared);
  stripVolatileCurrentDate(prepared);
  applyModelProfile(prepared, profile);
  filterInvalidAssistantThinkingBlocks(prepared);
  sanitizeTools(prepared);
  mergeToolResultTextBlocks(prepared);
  stripToolReferenceTurnBoundary(prepared);
  rewriteMidConversationSystemMessages(prepared, profile);
  fixTrailingAssistantMessage(prepared);
  return prepared;
}

export function estimateInputTokens(body: Record<string, unknown>): number {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
}

export function isTokenCountFallbackStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export function shouldTranslateWebSearchError(status: number, bodyText: string, requestBody: Record<string, unknown> | undefined): boolean {
  if (!requestBody || !containsWebSearchTool(requestBody)) return false;
  if (status !== 400 && status !== 404) return false;
  return /web[\s_-]*search|unsupported_value|not supported|unsupported/i.test(bodyText);
}

export function webSearchUnsupportedMessage(requestBody: Record<string, unknown> | undefined): string {
  return webSearchUnsupportedMessageForTool(firstWebSearchToolType(requestBody) ?? 'web_search');
}

export { normalizeAnthropicModelId };

function normalizeModel(body: Record<string, unknown>): void {
  const model = stringField(body.model);
  if (!model) return;
  body.model = normalizeAnthropicModelId(model);
}

function anthropicBetaHeader(
  req: Request,
  body: Record<string, unknown>,
  profile: AnthropicModelProfile,
  options: ClaudeCodePrepareOptions,
): string | undefined {
  const betas = new Set<string>();
  addBetaValues(betas, headerValue(req, 'anthropic-beta'));
  addBetaValues(betas, body.anthropic_beta);

  if (!profile.supportsAdaptiveThinking && recordField(body.thinking)) betas.add(INTERLEAVED_THINKING_BETA);
  if (recordField(body.context_management)) betas.add(CONTEXT_MANAGEMENT_BETA);
  if (containsAdvancedToolUse(body)) betas.add(ADVANCED_TOOL_USE_BETA);
  if (options.tokenCounting) betas.add(TOKEN_COUNTING_BETA);

  const stripPatterns = [...GLOBAL_BETA_STRIPS, ...profile.stripBetas];
  const filtered = [...betas].filter((beta) => isAllowedAnthropicBeta(beta) && !matchesAnyPattern(beta, stripPatterns));
  return filtered.length > 0 ? filtered.join(',') : undefined;
}

function addBetaValues(betas: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    for (const part of value.split(',')) {
      const beta = part.trim();
      if (beta) betas.add(beta);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addBetaValues(betas, item);
  }
}

function isAllowedAnthropicBeta(beta: string): boolean {
  return ALLOWED_ANTHROPIC_BETAS.has(beta);
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
  });
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.header(name)?.trim();
  return value || undefined;
}

function stripCacheControlScope(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripCacheControlScope(item);
    return;
  }
  const object = recordField(value);
  if (!object) return;

  const cacheControl = recordField(object.cache_control);
  if (cacheControl) delete cacheControl.scope;
  for (const child of Object.values(object)) stripCacheControlScope(child);
}

function stripVolatileCurrentDate(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripVolatileCurrentDate(item);
    return;
  }
  const object = recordField(value);
  if (!object) return;

  for (const [key, child] of Object.entries(object)) {
    if (key === 'text' && typeof child === 'string') {
      object[key] = stripCurrentDateBlock(child);
      continue;
    }
    stripVolatileCurrentDate(child);
  }
}

function stripCurrentDateBlock(input: string): string {
  const marker = '# currentDate\n';
  if (!input.includes(marker)) return input;

  let output = '';
  let cursor = 0;
  for (;;) {
    const index = input.indexOf(marker, cursor);
    if (index < 0) {
      output += input.slice(cursor);
      return output;
    }
    output += input.slice(cursor, index);
    const dateLineStart = index + marker.length;
    const dateLineEnd = input.indexOf('\n', dateLineStart);
    if (dateLineEnd < 0) {
      output += input.slice(index);
      return output;
    }
    const dateLine = input.slice(dateLineStart, dateLineEnd).trim();
    if (!/^Today's date is \d{4}-\d{2}-\d{2}\.?$/.test(dateLine)) {
      output += input.slice(index, dateLineEnd + 1);
      cursor = dateLineEnd + 1;
      continue;
    }
    cursor = dateLineEnd + 1;
    while (input[cursor] === '\n') cursor++;
  }
}

function applyModelProfile(body: Record<string, unknown>, profile: AnthropicModelProfile): void {
  applyEffortPolicy(body, profile);
  applyThinkingPolicy(body, profile);
  applyEffortPolicy(body, profile);
  capThinkingBudget(body, profile);
  disableForcedToolChoiceWhenThinking(body);
}

function applyEffortPolicy(body: Record<string, unknown>, profile: AnthropicModelProfile): void {
  const outputConfig = recordField(body.output_config);
  const effort = stringField(outputConfig?.effort);
  if (!outputConfig || !effort) return;
  if (profile.acceptedEfforts.some((accepted) => accepted.toLowerCase() === effort.toLowerCase())) return;
  delete outputConfig.effort;
  if (Object.keys(outputConfig).length === 0) delete body.output_config;
}

function applyThinkingPolicy(body: Record<string, unknown>, profile: AnthropicModelProfile): void {
  const thinking = recordField(body.thinking);
  if (!thinking) return;

  const thinkingType = stringField(thinking.type);
  if (!thinkingType || thinkingType === 'disabled') return;

  if (profile.thinking === 'enabled-only' && thinkingType === 'adaptive') {
    const budget = explicitThinkingBudget(body, thinking);
    if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };
    else delete body.thinking;
    return;
  }

  if (profile.thinking === 'adaptive-only' && thinkingType === 'enabled') {
    body.thinking = { type: 'adaptive' };
  }
}

function explicitThinkingBudget(body: Record<string, unknown>, thinking: Record<string, unknown>): number | undefined {
  const maxTokens = positiveInteger(body.max_tokens);
  if (maxTokens !== undefined && maxTokens <= 1024) return undefined;

  const requested = positiveInteger(thinking.budget_tokens);
  if (requested !== undefined) return maxTokens === undefined ? requested : Math.min(requested, maxTokens - 1);
  if (maxTokens !== undefined) return Math.min(4096, maxTokens - 1);
  return 1024;
}

function capThinkingBudget(body: Record<string, unknown>, profile: AnthropicModelProfile): void {
  const thinking = recordField(body.thinking);
  if (!thinking || thinking.type !== 'enabled') return;
  const budget = positiveInteger(thinking.budget_tokens);
  if (budget === undefined) return;

  const maxTokens = positiveInteger(body.max_tokens);
  if (maxTokens !== undefined && maxTokens <= 1) {
    delete body.thinking;
    stripOutputConfigEffort(body);
    return;
  }
  const cap = maxTokens === undefined ? profile.maxThinkingBudget : Math.min(profile.maxThinkingBudget, Math.max(1, maxTokens - 1));
  if (budget > cap) thinking.budget_tokens = cap;
}

function stripOutputConfigEffort(body: Record<string, unknown>): void {
  const outputConfig = recordField(body.output_config);
  if (!outputConfig || !Object.hasOwn(outputConfig, 'effort')) return;
  delete outputConfig.effort;
  if (Object.keys(outputConfig).length === 0) delete body.output_config;
}

function disableForcedToolChoiceWhenThinking(body: Record<string, unknown>): void {
  const thinking = recordField(body.thinking);
  if (!thinking || thinking.type === 'disabled') return;

  const toolChoice = recordField(body.tool_choice);
  const choiceType = stringField(toolChoice?.type);
  if (choiceType === 'any' || choiceType === 'tool') body.tool_choice = { type: 'auto' };
}

function filterInvalidAssistantThinkingBlocks(body: Record<string, unknown>): void {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return;

  for (const message of messages) {
    const object = recordField(message);
    if (!object || object.role !== 'assistant' || !Array.isArray(object.content)) continue;
    object.content = object.content.filter((block) => !isInvalidThinkingBlock(block));
  }
}

function isInvalidThinkingBlock(block: unknown): boolean {
  const object = recordField(block);
  if (!object || object.type !== 'thinking') return false;
  const signature = stringField(object.signature);
  const thinking = stringField(object.thinking);
  return !signature || signature.includes('@') || thinking?.trim() === 'Thinking...';
}

function sanitizeTools(body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) return;
  body.tools = body.tools.filter((tool) => {
    const object = recordField(tool);
    return !(object?.name === 'mcp__ide__executeCode' && object.defer_loading !== true);
  });
}

function mergeToolResultTextBlocks(body: Record<string, unknown>): void {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return;

  for (const message of messages) {
    const object = recordField(message);
    if (!object || object.role !== 'user' || !Array.isArray(object.content)) continue;
    const content = object.content;
    if (!content.some((block) => recordField(block)?.type === 'tool_result')) continue;

    const textParts: string[] = [];
    const rebuilt = content.filter((block) => {
      const blockObject = recordField(block);
      if (blockObject?.type === 'text' && typeof blockObject.text === 'string') {
        const text = blockObject.text.trim();
        if (text) textParts.push(text);
        return false;
      }
      return true;
    });
    if (textParts.length === 0) continue;

    const targetIndex = findLastIndex(rebuilt, (block) => recordField(block)?.type === 'tool_result');
    const target = recordField(rebuilt[targetIndex]);
    if (!target) continue;
    if (toolResultHasReferenceBlock(target)) continue;
    appendTextToToolResult(target, textParts.join('\n\n'));
    object.content = rebuilt;
  }
}

function toolResultHasReferenceBlock(toolResult: Record<string, unknown>): boolean {
  const content = toolResult.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => recordField(block)?.type === 'tool_reference');
}

function appendTextToToolResult(toolResult: Record<string, unknown>, text: string): void {
  const content = toolResult.content;
  if (content === undefined) {
    toolResult.content = text;
    return;
  }
  if (typeof content === 'string') {
    toolResult.content = content.trim() ? `${content}\n\n${text}` : text;
    return;
  }
  if (Array.isArray(content)) {
    content.push({ type: 'text', text });
    return;
  }
  toolResult.content = [{ type: 'text', text }];
}

function stripToolReferenceTurnBoundary(body: Record<string, unknown>): void {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return;

  const rebuiltMessages: unknown[] = [];
  for (const message of messages) {
    const object = recordField(message);
    if (!object || !Array.isArray(object.content)) {
      rebuiltMessages.push(message);
      continue;
    }
    const content = object.content.filter((block) => {
      const blockObject = recordField(block);
      return !(blockObject?.type === 'text' && stringField(blockObject.text)?.trim() === TOOL_LOADED_MARKER);
    });
    object.content = content;
    if (content.length > 0) rebuiltMessages.push(object);
  }
  body.messages = rebuiltMessages;
}

function rewriteMidConversationSystemMessages(body: Record<string, unknown>, profile: AnthropicModelProfile): void {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return;

  for (let index = 0; index < messages.length; index++) {
    const message = recordField(messages[index]);
    if (!message || message.role !== 'system') continue;
    if (profile.acceptsMidConversationSystem && isLegalSystemPlacement(messages, index)) continue;
    message.role = 'user';
    prefixMessageContent(message);
  }
}

function isLegalSystemPlacement(messages: unknown[], index: number): boolean {
  const previous = recordField(messages[index - 1]);
  const next = recordField(messages[index + 1]);
  return previous?.role === 'user' && (next === undefined || next.role === 'assistant');
}

function prefixMessageContent(message: Record<string, unknown>): void {
  if (typeof message.content === 'string') {
    message.content = INJECTED_SYSTEM_MARKER + message.content;
    return;
  }
  if (!Array.isArray(message.content)) {
    message.content = [{ type: 'text', text: INJECTED_SYSTEM_MARKER }];
    return;
  }
  for (const block of message.content) {
    const object = recordField(block);
    if (object?.type === 'text' && typeof object.text === 'string') {
      object.text = INJECTED_SYSTEM_MARKER + object.text;
      return;
    }
  }
  message.content.unshift({ type: 'text', text: INJECTED_SYSTEM_MARKER });
}

function fixTrailingAssistantMessage(body: Record<string, unknown>): void {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages || messages.length === 0) return;
  const last = recordField(messages[messages.length - 1]);
  if (last?.role !== 'assistant') return;
  messages.push({ role: 'user', content: [{ type: 'text', text: AUTOMATIC_CONTINUE_PROMPT }] });
}

function containsAdvancedToolUse(body: Record<string, unknown>): boolean {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some((tool) => {
    const object = recordField(tool);
    const type = stringField(object?.type);
    return Boolean(type?.startsWith('tool_search_tool_') || object?.defer_loading === true);
  });
}

function containsWebSearchTool(body: Record<string, unknown>): boolean {
  return firstWebSearchToolType(body) !== undefined;
}

function firstWebSearchToolType(body: Record<string, unknown> | undefined): string | undefined {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    const type = stringField(recordField(tool)?.type);
    if (type === 'web_search' || type?.startsWith('web_search_')) return type;
  }
  return undefined;
}

function webSearchUnsupportedMessageForTool(toolType: string): string {
  return (
    `The '${toolType}' server tool is not available from the GitHub Copilot backend for this account, model, or region. ` +
    'Copilot WebSearch is a preview capability, so retry with a supported model/account or configure a Claude Code MCP search tool as a fallback.'
  );
}

function containsContentBlockType(value: unknown, blockType: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsContentBlockType(item, blockType));
  const object = recordField(value);
  if (!object) return false;
  if (object.type === blockType) return true;
  return Object.values(object).some((child) => containsContentBlockType(child, blockType));
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  const object = recordField(value);
  if (!object) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) clone[key] = cloneJson(child);
  return clone;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
