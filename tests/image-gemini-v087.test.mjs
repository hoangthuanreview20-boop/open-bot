/**
 * Tests for the v0.87d Gemini image backend: image_generate beyond
 * OpenAI/xAI (Gemini Nano Banana via generateContent) + the generic
 * OpenAI-compatible image path (any provider whose config sets an
 * imageModel goes through POST /images/generations).
 *
 * MOCK ONLY: every test below uses a mocked global fetch or an
 * injected Mock* provider — nothing here touches the network and no
 * real API key is used anywhere. Live generation through
 * HttpGeminiImageProvider (Gemini generateContent shape) is NOT
 * tested live here (no Gemini key inside this repo); the HTTP
 * request/response shape is covered with a mocked global fetch, and
 * the shape itself is checked against Google's official docs — see
 * packages/tools/src/geminiImage.ts for the sources.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/image-gemini-v087.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWebMediaTools } from '../packages/tools/dist/webMedia.js';
import {
  HttpGeminiImageProvider,
  geminiImageConfigForSize,
  parseGeminiImageResponse,
  extFromGeminiMimeType,
  GEMINI_DEFAULT_IMAGE_MODEL,
  GEMINI_IMAGE_MODELS,
} from '../packages/tools/dist/geminiImage.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

// 1x1 transparent PNG (68 bytes).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-gemini-image-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Mock-fetch helper: swap globalThis.fetch for one test.
function mockFetch(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const jsonResponse = (obj, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Error',
  json: async () => obj,
  text: async () => JSON.stringify(obj),
  arrayBuffer: async () => Buffer.from(JSON.stringify(obj)).buffer,
});

/** A generateContent response whose first part carries the image. */
const geminiImageResponse = (overrides = {}) => ({
  candidates: [
    {
      content: {
        parts: [
          { text: 'Here is your image.' },
          { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } },
        ],
      },
    },
  ],
  ...overrides,
});

const geminiProvider = (overrides = {}) => ({
  getProviderConfig: async (providerId) => ({
    id: providerId,
    apiKey: 'gemini-test-key-never-logged',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    ...overrides,
  }),
  defaultProviderId: 'gemini',
});

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

test('gemini image models: default is Nano Banana 2.1, list has the documented models', () => {
  assert.equal(GEMINI_DEFAULT_IMAGE_MODEL, 'gemini-nano-banana-2.1');
  for (const model of [
    'gemini-nano-banana-2.1',
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image',
  ]) {
    assert.ok(GEMINI_IMAGE_MODELS.includes(model), `missing model ${model}`);
  }
});

// ---------------------------------------------------------------------------
// geminiImageConfigForSize — size "WxH" -> imageConfig
// ---------------------------------------------------------------------------

test('geminiImageConfigForSize: square / landscape / portrait map to listed ratios + tiers', () => {
  assert.deepEqual(geminiImageConfigForSize('1024x1024'), { aspectRatio: '1:1', imageSize: '1K' });
  assert.deepEqual(geminiImageConfigForSize('1280x720'), { aspectRatio: '16:9', imageSize: '1K' });
  assert.deepEqual(geminiImageConfigForSize('1024x768'), { aspectRatio: '4:3', imageSize: '1K' });
  assert.deepEqual(geminiImageConfigForSize('720x1280'), { aspectRatio: '9:16', imageSize: '1K' });
  assert.deepEqual(geminiImageConfigForSize('2560x1080'), { aspectRatio: '21:9', imageSize: '2K' });
  assert.deepEqual(geminiImageConfigForSize('2048x2048'), { aspectRatio: '1:1', imageSize: '2K' });
  // 3:4 portrait has no listed ratio in the docs — it is left out
  // rather than guessed, and the model picks its default.
  assert.deepEqual(geminiImageConfigForSize('768x1024'), { imageSize: '1K' });
  assert.throws(() => geminiImageConfigForSize('huge'), /Invalid "size"/);
  assert.throws(() => geminiImageConfigForSize('0x1024'), /Invalid "size"/);
});

// ---------------------------------------------------------------------------
// parseGeminiImageResponse — generateContent response parsing
// ---------------------------------------------------------------------------

test('parseGeminiImageResponse: camelCase inlineData + snake_case inline_data both work', () => {
  const camel = parseGeminiImageResponse(geminiImageResponse());
  assert.equal(camel.mimeType, 'image/png');
  assert.equal(camel.bytes.toString('base64'), TINY_PNG_BASE64);

  const snake = parseGeminiImageResponse({
    candidates: [
      {
        content: {
          parts: [{ inline_data: { mime_type: 'image/jpeg', data: TINY_PNG_BASE64 } }],
        },
      },
    ],
  });
  assert.equal(snake.mimeType, 'image/jpeg');
  assert.equal(snake.bytes.toString('base64'), TINY_PNG_BASE64);
});

test('parseGeminiImageResponse: text-only reply surfaces the model text; empty shapes error', () => {
  assert.throws(
    () =>
      parseGeminiImageResponse({
        candidates: [{ content: { parts: [{ text: 'I cannot create that image.' }] } }],
      }),
    /no image \(model text: "I cannot create that image\."\)/,
  );
  assert.throws(() => parseGeminiImageResponse({ candidates: [] }), /no candidates/);
  assert.throws(() => parseGeminiImageResponse({}), /no candidates/);
  assert.throws(() => parseGeminiImageResponse(null), /not an object/);
  assert.throws(
    () => parseGeminiImageResponse({ candidates: [{ content: { parts: [] } }] }),
    /no image \(no inlineData part/,
  );
});

test('extFromGeminiMimeType: png/jpg/webp, unknown defaults to png', () => {
  assert.equal(extFromGeminiMimeType('image/png'), '.png');
  assert.equal(extFromGeminiMimeType('image/jpeg'), '.jpg');
  assert.equal(extFromGeminiMimeType('image/webp'), '.webp');
  assert.equal(extFromGeminiMimeType('image/gif'), '.png');
  assert.equal(extFromGeminiMimeType('image/png; charset=binary'), '.png');
});

// ---------------------------------------------------------------------------
// image_generate via Gemini (mocked fetch) — request shape + save
// ---------------------------------------------------------------------------

test('image_generate (gemini, MOCK fetch): generateContent request shape is exact, image is saved', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), method: init.method });
    return jsonResponse(geminiImageResponse());
  });
  try {
    const tools = createWebMediaTools(geminiProvider());
    const out = await tool(tools, 'image_generate').execute(
      { prompt: 'a red cat', size: '1024x1024' },
      CTX(dir),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    // generateContent endpoint with the model in the path, key as a
    // query param (same placement as the in-repo GeminiProvider).
    assert.match(
      seen[0].url,
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-nano-banana-2\.1:generateContent\?key=/,
    );
    assert.deepEqual(seen[0].body, {
      contents: [{ role: 'user', parts: [{ text: 'a red cat' }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      },
    });
    assert.match(out, /Image generated via provider "gemini" \(model "gemini-nano-banana-2.1"/);
    assert.match(out, /Saved to: generated-media\/image-.*\.png/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(dir, savedRel)).toString('base64'), TINY_PNG_BASE64);
    assert.doesNotMatch(out, /gemini-test-key/);
  } finally {
    restore();
  }
});

test('image_generate (gemini, MOCK fetch): jpeg mime saves .jpg; model override is honoured', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/jpeg', data: TINY_PNG_BASE64 } }],
          },
        },
      ],
    });
  });
  try {
    const tools = createWebMediaTools(geminiProvider());
    const out = await tool(tools, 'image_generate').execute(
      { prompt: 'a rocket', model: 'gemini-3-pro-image', size: '1280x720' },
      CTX(dir),
    );
    assert.match(seen[0].url, /models\/gemini-3-pro-image:generateContent\?key=/);
    assert.equal(seen[0].body.generationConfig.imageConfig.aspectRatio, '16:9');
    assert.match(out, /Saved to: generated-media\/image-.*\.jpg/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(dir, savedRel)).toString('base64'), TINY_PNG_BASE64);
  } finally {
    restore();
  }
});

test('image_generate (gemini, MOCK fetch): HTTP error + text-only reply give clear errors, no file', async () => {
  const dir = makeTempWorkspace();
  const restore = mockFetch(async () =>
    jsonResponse({ error: { message: 'API key not valid' } }, false, 400),
  );
  try {
    const tools = createWebMediaTools(geminiProvider());
    const out = await tool(tools, 'image_generate').execute({ prompt: 'x' }, CTX(dir));
    assert.match(out, /^Error: Gemini image generation failed with HTTP 400/);
    assert.match(out, /API key not valid/);
    assert.equal(fs.existsSync(path.join(dir, 'generated-media')), false);
  } finally {
    restore();
  }

  const dir2 = makeTempWorkspace();
  const restore2 = mockFetch(async () =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: 'I cannot create that image.' }] } }],
    }),
  );
  try {
    const tools = createWebMediaTools(geminiProvider());
    const out = await tool(tools, 'image_generate').execute({ prompt: 'x' }, CTX(dir2));
    assert.match(out, /^Error: Gemini image API returned no image/);
    assert.match(out, /I cannot create that image/);
    assert.equal(fs.existsSync(path.join(dir2, 'generated-media')), false);
  } finally {
    restore2();
  }
});

// ---------------------------------------------------------------------------
// image_generate via Gemini with an injected Mock* provider (no fetch)
// ---------------------------------------------------------------------------

test('image_generate (gemini, MOCK provider): createGeminiImageProvider injection is used', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  class MockGeminiImageProvider {
    async generateImage(input) {
      seen.push(input);
      return { bytes: Buffer.from(TINY_PNG_BASE64, 'base64'), mimeType: 'image/png' };
    }
  }
  let fetchCalls = 0;
  const restore = mockFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({});
  });
  try {
    const tools = createWebMediaTools({
      ...geminiProvider(),
      createGeminiImageProvider: async () => new MockGeminiImageProvider(),
    });
    const out = await tool(tools, 'image_generate').execute(
      { prompt: 'a cat', size: '1024x1024' },
      CTX(dir),
    );
    assert.equal(fetchCalls, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, 'a cat');
    assert.equal(seen[0].model, 'gemini-nano-banana-2.1');
    assert.equal(seen[0].size, '1024x1024');
    assert.match(out, /Image generated via provider "gemini"/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(dir, savedRel)).toString('base64'), TINY_PNG_BASE64);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HttpGeminiImageProvider directly (mocked fetch) — URL + error paths
// ---------------------------------------------------------------------------

test('HttpGeminiImageProvider (MOCK fetch): posts to generateContent, rejects bad responses', async () => {
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse(geminiImageResponse());
  });
  try {
    const provider = new HttpGeminiImageProvider();
    const result = await provider.generateImage({
      apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      model: 'gemini-nano-banana-2.1',
      prompt: 'a cat',
      size: '1024x1024',
    });
    assert.equal(result.bytes.toString('base64'), TINY_PNG_BASE64);
    assert.equal(result.mimeType, 'image/png');
    assert.match(seen[0].url, /:generateContent\?key=k$/);
    // Trailing slash on baseUrl is tolerated (no double slash).
    assert.doesNotMatch(seen[0].url, /v1beta\/\/models/);
  } finally {
    restore();
  }

  await assert.rejects(
    () =>
      new HttpGeminiImageProvider().generateImage({
        apiKey: '',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-nano-banana-2.1',
        prompt: 'x',
        size: '1024x1024',
      }),
    /needs an API key/,
  );
  await assert.rejects(
    () =>
      new HttpGeminiImageProvider().generateImage({
        apiKey: 'k',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-nano-banana-2.1',
        prompt: 'x',
        size: 'huge',
      }),
    /Invalid "size"/,
  );
});

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible provider with an imageModel (mocked fetch)
// ---------------------------------------------------------------------------

test('image_generate (MOCK fetch): any provider with imageModel uses /images/generations', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ data: [{ b64_json: TINY_PNG_BASE64 }] });
  });
  try {
    const tools = createWebMediaTools({
      getProviderConfig: async () => ({
        id: 'my-compat',
        apiKey: 'compat-test-key',
        baseUrl: 'https://images.example.com/v1',
        imageModel: 'some-image-model',
      }),
      defaultProviderId: 'my-compat',
    });
    const out = await tool(tools, 'image_generate').execute({ prompt: 'a cat' }, CTX(dir));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://images.example.com/v1/images/generations');
    assert.equal(seen[0].body.model, 'some-image-model');
    assert.match(out, /Image generated via provider "my-compat" \(model "some-image-model"/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(dir, savedRel)).toString('base64'), TINY_PNG_BASE64);
  } finally {
    restore();
  }
});
