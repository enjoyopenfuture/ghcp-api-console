import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { prepareClaudeCodeMessagesRequest, preprocessClaudeCodeMessagesBody } from './claudeCodeCompat.js';

test('keeps text outside a tool result that contains a tool reference', () => {
  const prepared = preprocessClaudeCodeMessagesBody({
    model: 'claude-opus-4.7',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: [{ tool_name: 'Bash', type: 'tool_reference' }],
        },
        { type: 'text', text: 'Tool loaded.' },
        { type: 'text', text: 'Run the loaded tool.' },
      ],
    }],
  });

  assert.deepEqual(prepared.messages, [{
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_search',
        content: [{ tool_name: 'Bash', type: 'tool_reference' }],
      },
      { type: 'text', text: 'Run the loaded tool.' },
    ],
  }]);
});

test('still merges sibling text into a normal tool result', () => {
  const prepared = preprocessClaudeCodeMessagesBody({
    model: 'claude-opus-4.7',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash',
          content: [{ type: 'text', text: 'command output' }],
        },
        { type: 'text', text: 'Continue from this output.' },
      ],
    }],
  });

  assert.deepEqual(prepared.messages, [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_bash',
      content: [
        { type: 'text', text: 'command output' },
        { type: 'text', text: 'Continue from this output.' },
      ],
    }],
  }]);
});

test('classifies an optimized generated continuation as agent initiated', () => {
  const prepared = prepareClaudeCodeMessagesRequest(request(), {
    model: 'claude-opus-4.7',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] }],
  });

  assert.equal(prepared.forwardOptions.initiator, 'agent');
  assert.deepEqual(
    (prepared.body.messages as Array<Record<string, unknown>>).at(-1),
    { role: 'user', content: [{ type: 'text', text: 'Please continue.' }] },
  );
});

test('lets a valid incoming initiator override optimized compact inference', () => {
  const prepared = prepareClaudeCodeMessagesRequest(request(' User '), {
    model: 'claude-opus-4.7',
    messages: [{ role: 'user', content: '<compact-summary>state</compact-summary>' }],
  });

  assert.equal(prepared.forwardOptions.initiator, 'user');
  assert.equal(prepared.forwardOptions.interactionType, 'conversation-other');
});

function request(initiator?: string): Request {
  const header = (name: string): string | undefined =>
    name.toLowerCase() === 'x-initiator' ? initiator : undefined;
  return { get: header, header } as Request;
}
