import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, type ProxyConfig } from '../config.js';
import type { CopilotAuthContext } from './copilotAuth.js';
import { evictImageAttachments, prepareImageAttachments, sanitizeAttachmentName } from './imageAttachments.js';

interface UploadCall {
  url: string;
  headers: Headers;
  data: Buffer;
}

type Respond = (call: UploadCall, count: number) => Response | Promise<Response>;

const ATTACHMENTS_URL = 'https://github.com/github-copilot/chat/attachments';
const PNG_1 = base64('png-bytes-1');
const PNG_2 = base64('png-bytes-2');

const created: Respond = (_call, count) => json(201, { url: attachment(count) });

test('always mode uploads each distinct chat image once and rewrites every occurrence', async () => {
  await withUploads('always', created, async (calls) => {
    const copilot = copilotContext();
    const body = chatBody(dataUrl(PNG_1), dataUrl(base64('<svg/>'), 'image/svg+xml'), dataUrl(PNG_1));
    const original = structuredClone(body);

    const result = await prepareImageAttachments(copilot, '/chat/completions', body);

    assert.equal(calls.length, 2);
    const [png, svg] = calls as [UploadCall, UploadCall];
    assert.match(uploadQuery(png), /^name=img-[0-9a-f]{16}\.png&content_type=image\/png$/);
    assert.match(uploadQuery(svg), /^name=img-[0-9a-f]{16}\.svg&content_type=image\/svg%2Bxml$/);
    assert.deepEqual(
      [...png.headers],
      [
        ['accept', 'application/json'],
        ['authorization', `Bearer ${copilot.accessToken}`],
        ['content-type', 'application/octet-stream'],
        ['user-agent', config.opencodeUserAgent],
      ],
    );
    assert.deepEqual(png.data, Buffer.from('png-bytes-1'));
    assert.deepEqual(chatImageUrls(result.body), [
      { url: attachment(1), media_type: 'image/png' },
      { url: attachment(2), media_type: 'image/svg+xml' },
      { url: attachment(1), media_type: 'image/png' },
    ]);
    assert.equal(result.attachmentKeys.length, 2);
    assert.deepEqual(body, original);
  });
});

test('caches URLs per identity, shares in-flight uploads and uploads again after eviction', async () => {
  const delayed: Respond = async (call, count) => {
    await sleep(20);
    return created(call, count);
  };
  await withUploads('always', delayed, async (calls) => {
    const alice = copilotContext();
    const body = chatBody(dataUrl(PNG_1));
    const [first, concurrent] = await Promise.all([
      prepareImageAttachments(alice, '/chat/completions', body),
      prepareImageAttachments(alice, '/chat/completions', body),
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(chatImageUrls(first.body), [{ url: attachment(1), media_type: 'image/png' }]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(await prepareImageAttachments(alice, '/chat/completions', body), first);
    assert.equal(calls.length, 1);

    await prepareImageAttachments(copilotContext(), '/chat/completions', body);
    assert.equal(calls.length, 2);

    evictImageAttachments(alice.identity, first.attachmentKeys);
    const reuploaded = await prepareImageAttachments(alice, '/chat/completions', body);
    assert.equal(calls.length, 3);
    assert.deepEqual(chatImageUrls(reuploaded.body), [{ url: attachment(3), media_type: 'image/png' }]);
  });
});

test('runs at most four uploads at a time per request', async () => {
  let active = 0;
  let peak = 0;
  const slow: Respond = async (call, count) => {
    peak = Math.max(peak, ++active);
    await sleep(10);
    active--;
    return created(call, count);
  };
  await withUploads('always', slow, async (calls) => {
    const images = Array.from({ length: 6 }, (_, index) => dataUrl(base64(`png-bytes-${index}`)));
    const result = await prepareImageAttachments(copilotContext(), '/chat/completions', chatBody(...images));
    assert.equal(calls.length, 6);
    assert.equal(peak, 4);
    assert.equal(result.attachmentKeys.length, 6);
  });
});

test('off mode and count_tokens leave bodies untouched without uploading', async () => {
  await withUploads('off', created, async (calls) => {
    const copilot = copilotContext();
    const chat = chatBody(dataUrl(PNG_1));
    const off = await prepareImageAttachments(copilot, '/chat/completions', chat);
    assert.equal(off.body, chat);
    assert.deepEqual(off.attachmentKeys, []);

    config.imageUploadMode = 'always';
    const messages = messagesBody(PNG_1);
    assert.equal((await prepareImageAttachments(copilot, '/v1/messages/count_tokens', messages)).body, messages);
    assert.equal(calls.length, 0);
  });
});

test('auto mode uploads only for bodies over the endpoint limit but reuses cached URLs', async () => {
  await withUploads('auto', created, async (calls) => {
    const copilot = copilotContext();
    const small = chatBody(dataUrl(PNG_1));
    assert.equal((await prepareImageAttachments(copilot, '/chat/completions', small)).body, small);

    // 4.2 MB decoded: over the 5 MiB /chat/completions limit, within 32 MiB and the per-image limit.
    const large = 'A'.repeat(5_600_000);
    const responses = responsesBody(large);
    assert.equal((await prepareImageAttachments(copilot, '/responses', responses)).body, responses);
    assert.equal(calls.length, 0);

    const oversized = await prepareImageAttachments(copilot, '/chat/completions', chatBody(dataUrl(large), dataUrl(PNG_1)));
    assert.equal(calls.length, 2);
    assert.equal(oversized.attachmentKeys.length, 2);
    assert.equal(calls[0]?.data.byteLength, 4_200_000);

    const mixed = await prepareImageAttachments(copilot, '/chat/completions', chatBody(dataUrl(PNG_1), dataUrl(PNG_2)));
    assert.equal(calls.length, 2);
    assert.deepEqual(chatImageUrls(mixed.body), [{ url: attachment(2), media_type: 'image/png' }, { url: dataUrl(PNG_2) }]);
    assert.equal(mixed.attachmentKeys.length, 1);
  });
});

test('keeps images inline when uploads fail and retries all but rejected images', async () => {
  const replies = sequence(
    () => json(500, { message: 'Internal Server Error' }),
    () => json(201, { url: 'http://insecure.example/attachment' }),
    () => json(201, {}),
    created,
    () => json(422, { message: 'The maximum size for this file type is 20MB.' }),
  );
  await withUploads('always', replies, async (calls) => {
    const copilot = copilotContext();
    const body = chatBody(dataUrl(PNG_1));
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await prepareImageAttachments(copilot, '/chat/completions', body);
      assert.equal(result.body, body);
      assert.deepEqual(result.attachmentKeys, []);
    }
    assert.equal((await prepareImageAttachments(copilot, '/chat/completions', body)).attachmentKeys.length, 1);
    assert.equal(calls.length, 4);

    const rejected = chatBody(dataUrl(PNG_2));
    assert.equal((await prepareImageAttachments(copilot, '/chat/completions', rejected)).body, rejected);
    assert.equal((await prepareImageAttachments(copilot, '/chat/completions', rejected)).body, rejected);
    assert.equal(calls.length, 5);
  });
});

test('backs off an identity after auth or network failures but still uses its cached URLs', async () => {
  const failures: Respond[] = [
    () => json(401, { message: 'Bad credentials' }),
    () => {
      throw new TypeError('fetch failed');
    },
  ];
  for (const failure of failures) {
    await withUploads('always', sequence(created, failure, created), async (calls) => {
      const copilot = copilotContext();
      const cached = await prepareImageAttachments(copilot, '/chat/completions', chatBody(dataUrl(PNG_1)));
      const failed = chatBody(dataUrl(PNG_2));
      assert.equal((await prepareImageAttachments(copilot, '/chat/completions', failed)).body, failed);

      const other = dataUrl(base64('png-bytes-3'));
      const backedOff = await prepareImageAttachments(copilot, '/chat/completions', chatBody(dataUrl(PNG_1), other));
      assert.equal(calls.length, 2);
      assert.deepEqual(chatImageUrls(backedOff.body), [...chatImageUrls(cached.body), { url: other }]);

      await prepareImageAttachments(copilotContext(), '/chat/completions', failed);
      assert.equal(calls.length, 3);
    });
  }
});

test('starts no queued uploads once a failure triggers backoff', async () => {
  await withUploads('always', () => json(403, { message: 'Forbidden' }), async (calls) => {
    const images = Array.from({ length: 6 }, (_, index) => dataUrl(base64(`png-bytes-${index}`)));
    const body = chatBody(...images);
    assert.equal((await prepareImageAttachments(copilotContext(), '/chat/completions', body)).body, body);
    assert.equal(calls.length, 4);
  });
});

test('never uploads images above the per-image limit', async () => {
  await withUploads('always', created, async (calls) => {
    const result = await prepareImageAttachments(copilotContext(), '/v1/messages', messagesBody('A'.repeat(21_000_000), PNG_1));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.data, Buffer.from('png-bytes-1'));
    const [inline, uploaded] = messageSources(result.body);
    assert.equal(inline?.type, 'base64');
    assert.deepEqual(uploaded, { type: 'url', url: attachment(1) });
  });
});

test('keeps /v1/messages images above 5 MB of base64 inline, even when chat already uploaded them', async () => {
  await withUploads('always', created, async (calls) => {
    const copilot = copilotContext();
    const atLimit = 'B'.repeat(5_000_000);
    const overLimit = 'A'.repeat(5_000_004);
    await prepareImageAttachments(copilot, '/chat/completions', chatBody(dataUrl(overLimit)));
    assert.equal(calls.length, 1);

    const result = await prepareImageAttachments(copilot, '/v1/messages', messagesBody(overLimit, atLimit));

    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.data.byteLength, 3_750_000);
    const [inline, uploaded] = messageSources(result.body);
    assert.deepEqual(inline, { type: 'base64', media_type: 'image/png', data: overLimit });
    assert.deepEqual(uploaded, { type: 'url', url: attachment(2) });
    assert.equal(result.attachmentKeys.length, 1);
  });
});

test('sanitizes attachment names like VS Code', () => {
  assert.equal(sanitizeAttachmentName('my shot!.png'), 'myshot.png');
  assert.equal(sanitizeAttachmentName(''), 'image');
  assert.equal(sanitizeAttachmentName('a'.repeat(150)), 'a'.repeat(100));
});

async function withUploads(
  mode: ProxyConfig['imageUploadMode'],
  respond: Respond,
  run: (calls: UploadCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalMode = config.imageUploadMode;
  const calls: UploadCall[] = [];
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), headers: new Headers(init?.headers), data: Buffer.from(init?.body as Uint8Array) };
    calls.push(call);
    return respond(call, calls.length);
  };
  config.imageUploadMode = mode;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    config.imageUploadMode = originalMode;
  }
}

function sequence(...responders: Respond[]): Respond {
  return (call, count) => {
    const respond = responders[count - 1];
    if (!respond) throw new Error(`Unexpected upload #${count}`);
    return respond(call, count);
  };
}

function uploadQuery(call: UploadCall): string {
  const prefix = `${config.copilotAttachmentUploadUrl}?`;
  assert.ok(call.url.startsWith(prefix), call.url);
  return call.url.slice(prefix.length);
}

function copilotContext(): CopilotAuthContext {
  const identity = randomUUID();
  return { identity, accessToken: `token-${identity}`, api: 'https://api.githubcopilot.com' };
}

function attachment(count: number): string {
  return `${ATTACHMENTS_URL}/upload-${count}`;
}

function base64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function dataUrl(data: string, mediaType = 'image/png'): string {
  return `data:${mediaType};base64,${data}`;
}

function chatBody(...imageUrls: string[]): Record<string, unknown> {
  const images = imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }));
  return { model: 'gpt-4.1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe.' }, ...images] }] };
}

function responsesBody(data: string): Record<string, unknown> {
  return { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(data) }] }] };
}

function messagesBody(...images: string[]): Record<string, unknown> {
  const content = images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }));
  return { model: 'claude-sonnet-4.5', max_tokens: 64, messages: [{ role: 'user', content }] };
}

function chatImageUrls(body: Record<string, unknown>): unknown[] {
  const [message] = body.messages as Array<{ content: Array<{ type: string; image_url?: unknown }> }>;
  return message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url);
}

function messageSources(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const [message] = body.messages as Array<{ content: Array<{ source: Record<string, unknown> }> }>;
  return message.content.map((block) => block.source);
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
