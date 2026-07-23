import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forwardCopilotRequest,
  listModels,
  validateCopilotOauthToken,
} from './copilotClient.js';
import { config } from '../config.js';

test('uses OpenCode headers and isolates model caches by identity', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    if (String(input).endsWith('/models')) {
      return jsonResponse({ data: [{ id: `model-${requests.length}` }] });
    }
    return jsonResponse({ id: 'response' });
  };

  try {
    const alice = { identity: 'test-alice', accessToken: 'alice-token', api: 'https://api.githubcopilot.com' };
    const bob = { identity: 'test-bob', accessToken: 'bob-token', api: 'https://api.githubcopilot.com' };
    await listModels(alice);
    await listModels(alice);
    await listModels(bob);
    assert.equal(requests.length, 2);

    const refreshed = await listModels(alice, { useCache: false });
    assert.equal(requests.length, 3);
    assert.equal(refreshed[0]?.id, 'model-3');
    assert.equal((await listModels(alice))[0]?.id, 'model-3');

    await forwardCopilotRequest(alice, '/responses', { model: 'gpt-5', input: 'hello' }, {
      initiator: 'agent',
      visionRequest: true,
      interactionType: 'agent-session-name-generation',
    });

    const forward = requests[3]!;
    assert.equal(String(forward.input), 'https://api.githubcopilot.com/responses');
    const headers = new Headers(forward.init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer alice-token');
    assert.equal(headers.get('User-Agent'), config.opencodeUserAgent);
    assert.equal(headers.get('X-GitHub-Api-Version'), config.githubApiVersion);
    assert.equal(headers.get('Openai-Intent'), 'conversation-edits');
    assert.equal(headers.get('x-initiator'), 'agent');
    assert.equal(headers.get('Copilot-Vision-Request'), 'true');
    assert.equal(headers.get('X-Interaction-Type'), 'agent-session-name-generation');

    await validateCopilotOauthToken('test-import', 'candidate-token');
    const validation = requests[4]!;
    assert.equal(new Headers(validation.init?.headers).get('Authorization'), 'Bearer candidate-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cache bypass does not fall back to a stale models snapshot', async () => {
  const originalFetch = globalThis.fetch;
  const copilot = {
    identity: `cache-bypass-${Date.now()}`,
    accessToken: 'test-token',
    api: 'https://api.githubcopilot.com',
  };
  globalThis.fetch = async () => jsonResponse({ data: [{ id: 'cached-model' }] });

  try {
    await listModels(copilot);
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 500 });

    await assert.rejects(
      listModels(copilot, { useCache: false }),
      /List models failed with HTTP 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
