import assert from 'node:assert/strict';
import test from 'node:test';
import { loginWithDeviceFlow } from './deviceFlow.js';

test('uses the OpenCode OAuth client and headers while polling', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const responses = [
    jsonResponse({
      device_code: 'device-code',
      user_code: 'user-code',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    }),
    jsonResponse({ error: 'authorization_pending' }),
    jsonResponse({ access_token: 'oauth-token', token_type: 'bearer', scope: 'read:user' }),
  ];
  let now = 0;
  let authorizedCode: string | undefined;

  const token = await loginWithDeviceFlow(
    {
      name: 'test',
      authorize: async (device) => {
        authorizedCode = device.user_code;
      },
    },
    {
      info: () => undefined,
      warn: () => undefined,
    },
    {
      fetch: async (input, init) => {
        requests.push({ input, init });
        return responses.shift()!;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
  );

  assert.equal(token, 'oauth-token');
  assert.equal(authorizedCode, 'user-code');
  assert.deepEqual(sleeps, [4_000, 4_000]);
  assert.equal(requests.length, 3);

  const deviceRequest = requests[0]!;
  assert.equal(String(deviceRequest.input), 'https://github.com/login/device/code');
  assert.deepEqual(JSON.parse(String(deviceRequest.init?.body)), {
    client_id: 'Ov23li8tweQw6odWQebz',
    scope: 'read:user',
  });
  assert.deepEqual(deviceRequest.init?.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'opencode/1.0.0',
  });

  const pollRequest = requests[1]!;
  assert.equal(String(pollRequest.input), 'https://github.com/login/oauth/access_token');
  assert.deepEqual(JSON.parse(String(pollRequest.init?.body)), {
    client_id: 'Ov23li8tweQw6odWQebz',
    device_code: 'device-code',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
