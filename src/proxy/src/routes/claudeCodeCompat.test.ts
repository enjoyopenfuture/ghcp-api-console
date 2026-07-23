import assert from 'node:assert/strict';
import test from 'node:test';
import { preprocessClaudeCodeMessagesBody } from './claudeCodeCompat.js';

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
