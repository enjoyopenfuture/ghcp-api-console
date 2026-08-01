import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_CONTINUE_PROMPT, resolveRequestIntent } from './requestIntent.js';

test('normalizes a valid incoming initiator and lets it override inference', () => {
  const intent = resolveRequestIntent(
    '/v1/messages',
    { messages: [{ role: 'user', content: '<compact-summary>state</compact-summary>' }] },
    ' User ',
  );

  assert.deepEqual(intent, {
    initiator: 'user',
    interactionType: 'conversation-other',
  });
});

test('ignores an invalid incoming initiator and infers Anthropic tool continuations', () => {
  const intent = resolveRequestIntent(
    '/v1/messages',
    {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
      }],
    },
    'service',
  );

  assert.equal(intent.initiator, 'agent');
});

test('identifies Anthropic automatic continuation and ordinary user prompts', () => {
  assert.equal(
    resolveRequestIntent('/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'text', text: AUTOMATIC_CONTINUE_PROMPT }] }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain this code.' }] }],
    }).initiator,
    'user',
  );
});

test('identifies Chat Completions tool continuations', () => {
  assert.equal(
    resolveRequestIntent('/chat/completions', {
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'done' }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/chat/completions', {
      messages: [{ role: 'user', content: 'Continue.' }],
    }).initiator,
    'user',
  );
});

test('identifies Responses tool call outputs', () => {
  assert.equal(
    resolveRequestIntent('/responses', {
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/responses', {
      input: [{ type: 'message', role: 'user', content: 'Continue.' }],
    }).initiator,
    'user',
  );
});
