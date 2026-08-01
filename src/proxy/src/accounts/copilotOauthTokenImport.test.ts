import assert from 'node:assert/strict';
import test from 'node:test';
import { importCopilotOauthTokens } from './copilotOauthTokenImport.js';

test('rejects the whole CSV before importing when the header is invalid', async () => {
  const result = await importCopilotOauthTokens('name,wrongHeader\nalice,candidate-token\n');

  assert.deepEqual(result.summary, { total: 1, success: 0, failed: 1 });
  assert.equal(result.rows[0]?.line, 1);
  assert.match(result.rows[0]?.detail ?? '', /name,copilotOauthToken/);
});
