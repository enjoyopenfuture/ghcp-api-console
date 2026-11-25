import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectInlineImages,
  containsImageContent,
  parseImageDataUrl,
  replaceInlineImages,
  type InlineImage,
} from './imageContent.js';

const PNG_BASE64 = 'iVBORw0KGgo=';
const JPEG_BASE64 = '/9j/4AAQSkZJRg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BASE64}`;
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjc=';
const REMOTE_URL = 'https://example.com/cat.png';
const UPLOADED_URL = 'https://github.com/github-copilot/chat/attachments/0b7c4a5e-1f2d-4c3b-9a8e-6d5f4e3c2b1a';
const PNG_IMAGE: InlineImage = { mediaType: 'image/png', base64: PNG_BASE64 };
const JPEG_IMAGE: InlineImage = { mediaType: 'image/jpeg', base64: JPEG_BASE64 };

const uploaded = (): string => UPLOADED_URL;

test('parses only base64 image data URLs from a bounded header', () => {
  assert.deepEqual(parseImageDataUrl(PNG_DATA_URL), PNG_IMAGE);
  assert.deepEqual(parseImageDataUrl(`DATA:Image/JPG;name=photo.jpg;base64,${JPEG_BASE64}`), JPEG_IMAGE);
  assert.equal(parseImageDataUrl('data:image/png;base64,'), undefined);
  assert.equal(parseImageDataUrl(PDF_DATA_URL), undefined);
  assert.equal(parseImageDataUrl('data:image/svg+xml,%3Csvg%2F%3E'), undefined);
  assert.equal(parseImageDataUrl(REMOTE_URL), undefined);
  assert.equal(parseImageDataUrl(`data:image/png;name=${'x'.repeat(256)};base64,${PNG_BASE64}`), undefined);
});

test('rewrites inline Chat Completions images to URL parts with media_type', () => {
  const body = {
    messages: [
      { role: 'system', content: 'Describe images.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What changed?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL, detail: 'high' } },
          { type: 'image_url', image_url: JPEG_DATA_URL },
          { type: 'image_url', image_url: { url: REMOTE_URL } },
          { type: 'image_url', image_url: { url: PDF_DATA_URL } },
        ],
      },
    ],
  };

  assert.deepEqual(collectInlineImages('/chat/completions', body), [PNG_IMAGE, JPEG_IMAGE]);
  const messages = replaceInlineImages('/chat/completions', body, uploaded).messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'What changed?' },
    { type: 'image_url', image_url: { url: UPLOADED_URL, detail: 'high', media_type: 'image/png' } },
    { type: 'image_url', image_url: { url: UPLOADED_URL, media_type: 'image/jpeg' } },
    { type: 'image_url', image_url: { url: REMOTE_URL } },
    { type: 'image_url', image_url: { url: PDF_DATA_URL } },
  ]);
});

test('treats any Chat Completions image_url part as image content, including URL-only images', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: REMOTE_URL } }] }] };

  assert.equal(containsImageContent('/chat/completions', body), true);
  assert.deepEqual(collectInlineImages('/chat/completions', body), []);
  assert.equal(containsImageContent('/chat/completions', { messages: [{ role: 'user', content: 'Hi' }] }), false);
});

test('rewrites Responses input_image parts in message content and function_call_output lists', () => {
  const body = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Compare these.' },
          { type: 'input_image', image_url: PNG_DATA_URL, detail: 'low' },
          { type: 'input_image', file_id: 'file_123' },
          { type: 'input_image', image_url: REMOTE_URL, detail: 'auto' },
        ],
      },
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: JPEG_DATA_URL }] },
    ],
  };
  const snapshot = structuredClone(body);

  assert.equal(containsImageContent('/responses', body), true);
  assert.deepEqual(collectInlineImages('/responses', body), [PNG_IMAGE, JPEG_IMAGE]);
  const input = replaceInlineImages('/responses', body, uploaded).input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0].content, [
    { type: 'input_text', text: 'Compare these.' },
    { type: 'input_image', image_url: UPLOADED_URL, detail: 'low' },
    { type: 'input_image', file_id: 'file_123' },
    { type: 'input_image', image_url: REMOTE_URL, detail: 'auto' },
  ]);
  assert.deepEqual(input[2].output, [{ type: 'input_image', image_url: UPLOADED_URL }]);
  assert.deepEqual(body, snapshot);
});

test('treats string Responses input as image-free', () => {
  const body = { input: 'Describe the attached diagram.' };

  assert.equal(containsImageContent('/responses', body), false);
  assert.equal(replaceInlineImages('/responses', body, uploaded), body);
});

test('rewrites Anthropic base64 image blocks, including tool_result images, on both messages paths', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'What does the screenshot show?' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'screenshot', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'Captured.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/JPG', data: JPEG_BASE64 } },
          ],
        }],
      },
    ],
  };
  const snapshot = structuredClone(body);

  for (const path of ['/v1/messages', '/v1/messages/count_tokens'] as const) {
    assert.deepEqual(collectInlineImages(path, body), [PNG_IMAGE, JPEG_IMAGE]);
    const messages = replaceInlineImages(path, body, uploaded).messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0].content, [
      { type: 'image', source: { type: 'url', url: UPLOADED_URL }, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'What does the screenshot show?' },
    ]);
    assert.deepEqual(messages[2].content, [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [
        { type: 'text', text: 'Captured.' },
        { type: 'image', source: { type: 'url', url: UPLOADED_URL } },
      ],
    }]);
  }
  assert.deepEqual(body, snapshot);
});

test('detects Anthropic URL-source images inside tool_result without collecting them', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'image', source: { type: 'url', url: UPLOADED_URL } }],
      }],
    }],
  };

  assert.equal(containsImageContent('/v1/messages', body), true);
  assert.deepEqual(collectInlineImages('/v1/messages', body), []);
});

test('rewrites copy-on-write, keeping unresolved images and untouched subtrees by reference', () => {
  const tools = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }];
  const system = { role: 'system', content: 'Be brief.' };
  const pngPart = { type: 'image_url', image_url: { url: PNG_DATA_URL } };
  const later = { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_DATA_URL } }] };
  const body = {
    model: 'gpt-4.1',
    tools,
    messages: [system, { role: 'user', content: [pngPart, { type: 'image_url', image_url: { url: JPEG_DATA_URL } }] }, later],
  };
  const snapshot = structuredClone(body);

  assert.equal(replaceInlineImages('/chat/completions', body, () => undefined), body);

  const seen: InlineImage[] = [];
  const rewritten = replaceInlineImages('/chat/completions', body, (image) => {
    seen.push(image);
    return image.mediaType === 'image/jpeg' ? UPLOADED_URL : undefined;
  });
  const messages = rewritten.messages as Array<Record<string, unknown>>;
  const content = messages[1].content as unknown[];

  assert.deepEqual(body, snapshot);
  assert.deepEqual(seen, [PNG_IMAGE, JPEG_IMAGE, PNG_IMAGE]);
  assert.deepEqual(collectInlineImages('/chat/completions', body), seen);
  assert.equal(rewritten.tools, tools);
  assert.equal(messages[0], system);
  assert.equal(messages[2], later);
  assert.equal(content[0], pngPart);
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: UPLOADED_URL, media_type: 'image/jpeg' } });
});
