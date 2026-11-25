import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.PROXY_ERROR_DIAGNOSTICS_ENABLED = 'false';

const { config } = await import('../config.js');
const { copilotAuthManager } = await import('../copilot/copilotAuthManager.js');
const { buildApp } = await import('../server.js');

config.apiKey = 'compatible-test-key';
config.imageUploadMode = 'always';

const realFetch = globalThis.fetch;
const COPILOT_API = 'https://api.githubcopilot.com';
const UPLOAD_PATH = '/copilot/chat/attachments';
const OCTET_STREAM = { 'Content-Type': 'application/octet-stream' };
const MODELS = [
  { id: 'gemini-4-neon', supported_endpoints: ['/chat/completions'] },
  { id: 'gpt-6-luna', supported_endpoints: ['/responses'] },
  { id: 'claude-sonnet-4.6', supported_endpoints: ['/v1/messages'] },
];
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000031', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300', 'hex');
const CHAT_IMAGE_PART = { type: 'image_url', image_url: { url: dataUrl('image/png', PNG), detail: 'high' } };
const MESSAGES_BODY = {
  model: 'claude-sonnet-4.6',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Read shot.png' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'shot.png' } }] },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_read',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }],
      }],
    },
  ],
};

interface RecordedCall {
  url: URL;
  headers: Headers;
  body: Buffer;
}

type StubResponder = (call: RecordedCall, count: number) => Response;

interface Harness {
  uploads: RecordedCall[];
  upstream: RecordedCall[];
  send(path: string, body: string | Buffer, headers: Record<string, string>): Promise<Response>;
  postJson(path: string, body: unknown, claudeCodeOptimized?: boolean): Promise<Response>;
}

test('uploads inline chat images and forwards the attachment URL with the vision header', async (t) => {
  await withHarness(t, {}, async (harness) => {
    assert.equal((await harness.postJson('/chat/completions', chatBody())).status, 200);

    assert.equal(harness.uploads.length, 1);
    const [upload] = harness.uploads;
    assert.equal(upload.headers.get('authorization'), 'Bearer oauth-token');
    assert.equal(upload.headers.get('content-type'), 'application/octet-stream');
    assert.equal(upload.url.searchParams.get('content_type'), 'image/png');
    assert.match(upload.url.searchParams.get('name') ?? '', /^img-[0-9a-f]{16}\.png$/);
    assert.deepEqual(upload.body, PNG);

    assert.equal(harness.upstream[0]?.headers.get('copilot-vision-request'), 'true');
    assert.deepEqual(forwardedJson(harness.upstream[0]).messages[0].content[1], {
      type: 'image_url',
      image_url: { url: attachmentUrl(PNG), detail: 'high', media_type: 'image/png' },
    });
  });
});

test('rewrites responses input images, including images in function call output', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const response = await harness.postJson('/responses', {
      model: 'gpt-6-luna',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Compare the screenshots.' },
            { type: 'input_image', image_url: dataUrl('image/png', PNG), detail: 'auto' },
          ],
        },
        { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: dataUrl('image/jpeg', JPEG) }] },
      ],
    });
    assert.equal(response.status, 200);

    assert.equal(harness.uploads.length, 2);
    const forwarded = forwardedJson(harness.upstream[0]);
    assert.deepEqual(forwarded.input[0].content[1], { type: 'input_image', image_url: attachmentUrl(PNG), detail: 'auto' });
    assert.deepEqual(forwarded.input[2].output[0], { type: 'input_image', image_url: attachmentUrl(JPEG) });
    assert.equal(harness.upstream[0]?.headers.get('copilot-vision-request'), 'true');
  });
});

test('uploads a Claude Code tool result image once and reuses the cached URL', async (t) => {
  await withHarness(t, {}, async (harness) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await harness.postJson('/v1/messages', MESSAGES_BODY, true)).status, 200);
    }

    assert.equal(harness.uploads.length, 1);
    assert.equal(harness.upstream.length, 2);
    for (const call of harness.upstream) {
      assert.equal(call.headers.get('copilot-vision-request'), 'true');
      assert.deepEqual(forwardedJson(call).messages[2].content[0].content[0], {
        type: 'image',
        source: { type: 'url', url: attachmentUrl(PNG) },
      });
    }
  });
});

test('evicts the attachment URLs of a request Copilot rejected so the next request uploads again', async (t) => {
  const upstream: StubResponder = (_call, count) => count === 1
    ? Response.json({ error: { message: 'invalid image url' } }, { status: 400 })
    : Response.json({ id: 'chatcmpl-ok' });
  await withHarness(t, { upstream }, async (harness) => {
    assert.equal((await harness.postJson('/chat/completions', chatBody())).status, 400);
    assert.equal((await harness.postJson('/chat/completions', chatBody())).status, 200);

    assert.equal(harness.uploads.length, 2);
    assert.equal(forwardedJson(harness.upstream[1]).messages[0].content[1].image_url.url, attachmentUrl(PNG));
  });
});

test('forwards the inline image when the attachment upload fails', async (t) => {
  const upload: StubResponder = () => new Response('upload unavailable', { status: 503 });
  await withHarness(t, { upload }, async (harness) => {
    assert.equal((await harness.postJson('/chat/completions', chatBody())).status, 200);

    assert.equal(harness.uploads.length, 1);
    assert.deepEqual(forwardedJson(harness.upstream[0]).messages[0].content[1], CHAT_IMAGE_PART);
  });
});

test('keeps images inline and hides the upload endpoint when image upload is off', async (t) => {
  config.imageUploadMode = 'off';
  try {
    await withHarness(t, {}, async (harness) => {
      assert.equal((await harness.postJson('/chat/completions', chatBody())).status, 200);
      assert.deepEqual(forwardedJson(harness.upstream[0]).messages[0].content[1], CHAT_IMAGE_PART);
      assert.equal(harness.upstream[0]?.headers.get('copilot-vision-request'), 'true');

      const upload = await harness.send(`${UPLOAD_PATH}?name=shot.png&content_type=image/png`, PNG, OCTET_STREAM);
      assert.equal(upload.status, 404);
      assert.equal(harness.uploads.length, 0);
    });
  } finally {
    config.imageUploadMode = 'always';
  }
});

test('proxies raw attachment uploads with the identity OAuth token', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const response = await harness.send(`${UPLOAD_PATH}?name=my%20shot!.png&content_type=image/png`, PNG, OCTET_STREAM);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { url: attachmentUrl(PNG) });

    assert.equal(harness.uploads.length, 1);
    const [upload] = harness.uploads;
    assert.equal(upload.url.searchParams.get('name'), 'myshot.png');
    assert.equal(upload.url.searchParams.get('content_type'), 'image/png');
    assert.equal(upload.headers.get('authorization'), 'Bearer oauth-token');
    assert.deepEqual(upload.body, PNG);

    const rejections = [
      {
        query: '?content_type=image/png',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        status: 415,
        message: 'Content-Type must be application/octet-stream.',
      },
      {
        query: '?content_type=png',
        body: PNG,
        headers: OCTET_STREAM,
        status: 400,
        message: 'Query parameter "content_type" must be a MIME type such as image/png.',
      },
      {
        query: '?content_type=image/png',
        body: Buffer.alloc(20 * 1024 * 1024 + 1),
        headers: OCTET_STREAM,
        status: 413,
        message: 'Request body exceeds the proxy limit of 20 MiB.',
      },
    ];
    for (const { query, body, headers, status, message } of rejections) {
      const rejected = await harness.send(`${UPLOAD_PATH}${query}`, body, headers);
      assert.equal(rejected.status, status, message);
      assert.equal((await rejected.json() as { error: { message: string } }).error.message, message);
    }
    assert.equal(harness.uploads.length, 1);
  });
});

test('estimates count_tokens locally without uploading when Copilot answers 413', async (t) => {
  const upstream: StubResponder = () => new Response('request too large', { status: 413 });
  await withHarness(t, { upstream }, async (harness) => {
    const response = await harness.postJson('/v1/messages/count_tokens', MESSAGES_BODY, true);
    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json() as { input_tokens: unknown }).input_tokens, 'number');

    assert.equal(harness.upstream.length, 1);
    assert.equal(harness.uploads.length, 0);
  });
});

async function withHarness(
  t: TestContext,
  stubs: { upload?: StubResponder; upstream?: StubResponder },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const identity = `compatible-${randomUUID()}`;
  t.mock.method(copilotAuthManager, 'getAuth', async (id: string) => ({ identity: id, accessToken: 'oauth-token', api: COPILOT_API }));
  const uploads: RecordedCall[] = [];
  const upstream: RecordedCall[] = [];
  const server = buildApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const call = { url: new URL(request.url), headers: request.headers, body: Buffer.from(await request.arrayBuffer()) };
    if (request.url.startsWith(config.copilotAttachmentUploadUrl)) {
      uploads.push(call);
      return (stubs.upload ?? createdAttachment)(call, uploads.length);
    }
    if (request.url === `${COPILOT_API}/models`) return Response.json({ data: MODELS });
    if (call.url.origin !== COPILOT_API) throw new Error(`Unexpected fetch to ${request.url}`);
    upstream.push(call);
    return stubs.upstream?.(call, upstream.length) ?? Response.json({ id: 'upstream-ok' });
  };
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send: Harness['send'] = (path, body, headers) => realFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, [config.identityHeader]: identity, ...headers },
      body,
    });
    const postJson: Harness['postJson'] = (path, body, claudeCodeOptimized = false) => send(path, JSON.stringify(body), {
      'Content-Type': 'application/json',
      'X-Claude-Code-Optimized': String(claudeCodeOptimized),
    });
    await run({ uploads, upstream, send, postJson });
  } finally {
    globalThis.fetch = realFetch;
    await closeServer(server);
  }
}

function createdAttachment(call: RecordedCall): Response {
  return Response.json({ url: attachmentUrl(call.body) }, { status: 201 });
}

/** Derived from the uploaded bytes, so assertions do not depend on upload order. */
function attachmentUrl(bytes: Buffer): string {
  return `https://github.com/github-copilot/chat/attachments/${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
}

function forwardedJson(call: RecordedCall | undefined) {
  assert.ok(call, 'expected a forwarded Copilot request');
  return JSON.parse(call.body.toString('utf8'));
}

function chatBody(): Record<string, unknown> {
  return {
    model: 'gemini-4-neon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the screenshot.' }, CHAT_IMAGE_PART] }],
  };
}

function dataUrl(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((err) => err ? reject(err) : resolveClosed());
  });
}
