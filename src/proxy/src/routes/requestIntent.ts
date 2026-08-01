import type { CopilotApiPath } from '../copilot/copilotClient.js';

export type RequestInitiator = 'user' | 'agent';

export interface RequestIntent {
  initiator: RequestInitiator;
  interactionType?: string;
}

export const AUTOMATIC_CONTINUE_PROMPT = 'Please continue.';

export function resolveRequestIntent(
  path: CopilotApiPath,
  body: Record<string, unknown>,
  incomingInitiator?: string,
): RequestIntent {
  const inferred = inferRequestIntent(path, body);
  return {
    ...inferred,
    initiator: parseInitiator(incomingInitiator) ?? inferred.initiator,
  };
}

function parseInitiator(value: string | undefined): RequestInitiator | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'user' || normalized === 'agent' ? normalized : undefined;
}

function inferRequestIntent(path: CopilotApiPath, body: Record<string, unknown>): RequestIntent {
  if (path.startsWith('/v1/messages')) return inferMessagesIntent(body);
  if (path === '/chat/completions') return inferChatCompletionsIntent(body);
  return inferResponsesIntent(body);
}

function inferMessagesIntent(body: Record<string, unknown>): RequestIntent {
  if (isCompactRequest(body)) return { initiator: 'agent', interactionType: 'conversation-other' };

  const last = lastRecord(body.messages);
  if (last && containsBlockType(last.content, 'tool_result')) return { initiator: 'agent' };
  if (last && collectText(last.content).trim() === AUTOMATIC_CONTINUE_PROMPT) return { initiator: 'agent' };
  return { initiator: 'user' };
}

function inferChatCompletionsIntent(body: Record<string, unknown>): RequestIntent {
  const last = lastRecord(body.messages);
  return { initiator: last?.role === 'tool' ? 'agent' : 'user' };
}

function inferResponsesIntent(body: Record<string, unknown>): RequestIntent {
  const last = lastRecord(body.input);
  const type = typeof last?.type === 'string' ? last.type : undefined;
  return { initiator: type?.endsWith('_call_output') ? 'agent' : 'user' };
}

function isCompactRequest(body: Record<string, unknown>): boolean {
  const systemText = collectText(body.system).trimStart();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserText = collectText(lastRecordWithRole(messages, 'user')?.content).trimStart();
  return (
    systemText.startsWith('<compact-summary>') ||
    lastUserText.startsWith('<compact-summary>') ||
    /^(compact|summarize|summary of (the )?conversation|continue (from|with) (the )?summary)/i.test(lastUserText)
  );
}

function lastRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index--) {
    const record = recordField(value[index]);
    if (record) return record;
  }
  return undefined;
}

function lastRecordWithRole(value: unknown[], role: string): Record<string, unknown> | undefined {
  for (let index = value.length - 1; index >= 0; index--) {
    const record = recordField(value[index]);
    if (record?.role === role) return record;
  }
  return undefined;
}

function containsBlockType(value: unknown, blockType: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsBlockType(item, blockType));
  const object = recordField(value);
  if (!object) return false;
  if (object.type === blockType) return true;
  return Object.values(object).some((item) => containsBlockType(item, blockType));
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n');
  const object = recordField(value);
  if (!object) return '';
  if (typeof object.text === 'string') return object.text;
  if (object.content !== undefined) return collectText(object.content);
  return '';
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
