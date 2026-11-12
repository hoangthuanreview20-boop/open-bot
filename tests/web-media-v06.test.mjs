/**
 * Tests for the v0.6 web & media tools: x_search (X API + labelled
 * fallback), image_generate, video_generate, video_from_images (real
 * ffmpeg) and CanvasStore + canvas tools.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/web-media-v06.test.mjs
 *
 * No live network: global fetch is mocked for the X / image / video
 * APIs. video_from_images runs the real ffmpeg binary on tiny fake
 * PNGs. No real API key is used anywhere.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  CANVAS_TOOLS,
  WEB_MEDIA_TOOLS,
  createCanvasTools,
  createWebMediaTools,
  formatXPosts,
  parseXSearchResponse,
} from '../packages/tools/dist/webMedia.js';
import { CODE_TOOLS } from '../packages/tools/dist/codeTools.js';
import { CanvasStore } from '../packages/core/dist/canvas/store.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

// 1x1 transparent PNG (68 bytes).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tempDirs = [];
function makeTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-webmedia-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
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

// ---------------------------------------------------------------------------
// Exports / registry shape
// ---------------------------------------------------------------------------

test('web-media exports: 6 web/media tools + 3 canvas tools, approval flags', () => {
  assert.deepEqual(
    WEB_MEDIA_TOOLS.map((t) => t.definition.name),
    ['x_search', 'image_generate', 'video_generate', 'video_status', 'video_cancel', 'video_from_images'],
  );
  assert.deepEqual(
    CANVAS_TOOLS.map((t) => t.definition.name),
    ['canvas_read', 'canvas_write', 'canvas_list'],
  );
  assert.equal(tool(WEB_MEDIA_TOOLS, 'x_search').needsApproval, false);
  assert.equal(tool(WEB_MEDIA_TOOLS, 'image_generate').needsApproval, true);
  assert.equal(tool(WEB_MEDIA_TOOLS, 'video_generate').needsApproval, true);
  assert.equal(tool(WEB_MEDIA_TOOLS, 'video_status').needsApproval, false);
  assert.equal(tool(WEB_MEDIA_TOOLS, 'video_cancel').needsApproval, true);
  assert.equal(tool(WEB_MEDIA_TOOLS, 'video_from_images').needsApproval, true);
  assert.equal(tool(CANVAS_TOOLS, 'canvas_read').needsApproval, false);
  assert.equal(tool(CANVAS_TOOLS, 'canvas_write').needsApproval, true);
  assert.equal(tool(CANVAS_TOOLS, 'canvas_list').needsApproval, false);

  const reg = ToolRegistry.fromDefaults([...WEB_MEDIA_TOOLS, ...CANVAS_TOOLS]);
  assert.equal(reg.size(), 9);
});

test('x_search: exactly one registration — CODE_TOOLS no longer ships a fallback copy', () => {
  // v0.6: the fallback-only x_search was removed from CODE_TOOLS; the
  // only x_search is the web-media one (X API + labelled fallback).
  assert.equal(tool(CODE_TOOLS, 'x_search'), undefined);
  const reg = ToolRegistry.fromDefaults([...CODE_TOOLS, ...WEB_MEDIA_TOOLS, ...CANVAS_TOOLS]);
  const named = reg.list().filter((t) => t.definition.name === 'x_search');
  assert.equal(named.length, 1);
  assert.match(named[0].definition.description, /X API/i);
});

// ---------------------------------------------------------------------------
// x_search — pure helpers
// ---------------------------------------------------------------------------

test('parseXSearchResponse + formatXPosts: maps users, builds status URLs', () => {
  const posts = parseXSearchResponse({
    data: [
      { id: '111', text: 'hello world', author_id: 'u1', created_at: '2026-11-08T10:00:00.000Z' },
      { id: '222', text: 'second post', author_id: 'u9', created_at: '2026-11-08T11:00:00.000Z' },
    ],
    includes: { users: [{ id: 'u1', username: 'alice', name: 'Alice' }] },
  });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, 'https://x.com/alice/status/111');
  assert.equal(posts[0].authorUsername, 'alice');
  assert.equal(posts[0].authorName, 'Alice');
  assert.equal(posts[1].authorUsername, 'unknown'); // author not in includes
  assert.equal(posts[1].url, 'https://x.com/unknown/status/222');

  const out = formatXPosts('hello', 'X API', posts);
  assert.match(out, /X search for "hello" via X API — 2 result\(s\)/);
  assert.match(out, /@alice \(Alice\) — 2026-11-08T10:00:00\.000Z/);
  assert.match(out, /https:\/\/x\.com\/alice\/status\/111/);
  assert.deepEqual(parseXSearchResponse({ data: [] }), []);
  assert.deepEqual(parseXSearchResponse({}), []);
});

// ---------------------------------------------------------------------------
// x_search — X API path (mocked fetch)
// ---------------------------------------------------------------------------

test('x_search with bearer token: calls the X API, never the fallback', async () => {
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization });
    return jsonResponse({
      data: [{ id: '42', text: 'grok is fast', author_id: 'u1', created_at: '2026-11-08T09:00:00.000Z' }],
      includes: { users: [{ id: 'u1', username: 'bob', name: 'Bob' }] },
    });
  });
  try {
    const tools = createWebMediaTools({ getXBearer: async () => 'test-bearer-token' });
    const out = await tool(tools, 'x_search').execute({ query: 'grok' }, CTX('/tmp'));
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^https:\/\/api\.x\.com\/2\/tweets\/search\/recent\?/);
    assert.match(seen[0].url, /query=grok/);
    assert.match(seen[0].url, /max_results=10/);
    assert.equal(seen[0].auth, 'Bearer test-bearer-token');
    assert.match(out, /via X API — 1 result/);
    assert.match(out, /@bob \(Bob\)/);
    assert.match(out, /https:\/\/x\.com\/bob\/status\/42/);
    assert.doesNotMatch(out, /FALLBACK/);
  } finally {
    restore();
  }
});

test('x_search with bearer token: API 401 is a clear error, no silent fallback', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ title: 'Unauthorized' }),
      json: async () => ({}),
    };
  });
  try {
    const tools = createWebMediaTools({ getXBearer: () => 'bad-token' });
    const out = await tool(tools, 'x_search').execute({ query: 'grok' }, CTX('/tmp'));
    assert.equal(calls, 1);
    assert.match(out, /^Error: X API search failed with HTTP 401/);
    assert.match(out, /Vault \(namespace 'x'\)/);
    assert.doesNotMatch(out, /FALLBACK/);
  } finally {
    restore();
  }
});

test('x_search without token: falls back to web search and SAYS SO', async () => {
  const seenUrls = [];
  const restore = mockFetch(async (url) => {
    seenUrls.push(String(url));
    return {
      ok: true,
      text: async () =>
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fsomeone%2Fstatus%2F1">A post on X</a>' +
        '<a class="result__snippet" href="#">snippet words</a>',
    };
  });
  try {
    const out = await tool(WEB_MEDIA_TOOLS, 'x_search').execute(
      { query: 'open source agents' },
      CTX('/tmp'),
    );
    assert.equal(seenUrls.length, 1);
    assert.match(seenUrls[0], /site%3Ax\.com%20open%20source%20agents/);
    assert.match(out, /\[FALLBACK\] No X bearer token is configured, so this is NOT the X API/);
    assert.match(out, /x\.com\/someone\/status\/1/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// image_generate (mocked provider API)
// ---------------------------------------------------------------------------

const fakeProvider = (overrides = {}) => ({
  getProviderConfig: async (providerId) => ({
    id: providerId,
    apiKey: 'sk-test-secret-never-logged',
    baseUrl: 'https://api.openai.com/v1',
    ...overrides,
  }),
  defaultProviderId: 'openai',
});

test('image_generate: b64_json response is saved into the workspace', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return jsonResponse({ data: [{ b64_json: TINY_PNG_BASE64 }] });
  });
  try {
    const tools = createWebMediaTools(fakeProvider());
    const out = await tool(tools, 'image_generate').execute(
      { prompt: 'a red cat', size: '1024x1024' },
      CTX(dir),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.openai.com/v1/images/generations');
    assert.equal(seen[0].body.model, 'gpt-image-1');
    assert.equal(seen[0].body.prompt, 'a red cat');
    assert.match(out, /Image generated via provider "openai" \(model "gpt-image-1"/);
    assert.match(out, /Saved to: generated-media\/image-.*\.png/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    const saved = fs.readFileSync(path.join(dir, savedRel));
    assert.equal(saved.toString('base64'), TINY_PNG_BASE64);
    assert.doesNotMatch(out, /sk-test-secret/);
  } finally {
    restore();
  }
});

test('image_generate: xai uses grok-2-image; url response is downloaded', async () => {
  const dir = makeTempWorkspace();
  // The download branch needs arrayBuffer() to return the PNG bytes.
  const restore2 = mockFetch(async (url, init) => {
    if (String(url).includes('/images/generations')) {
      assert.match(String(url), /api\.x\.ai\/v1\/images\/generations/);
      assert.equal(JSON.parse(init.body).model, 'grok-2-image');
      return jsonResponse({ data: [{ url: 'https://example.com/pic.png' }] });
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const buf = Buffer.from(TINY_PNG_BASE64, 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      json: async () => ({}),
      text: async () => '',
    };
  });
  try {
    const tools = createWebMediaTools({
      getProviderConfig: async () => ({
        id: 'xai',
        apiKey: 'xai-test-key',
        baseUrl: 'https://api.x.ai/v1',
      }),
      defaultProviderId: 'xai',
    });
    const out = await tool(tools, 'image_generate').execute({ prompt: 'a rocket' }, CTX(dir));
    assert.match(out, /provider "xai" \(model "grok-2-image"/);
    const savedRel = out.match(/Saved to: (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(dir, savedRel)).toString('base64'), TINY_PNG_BASE64);
  } finally {
    restore2();
  }
});

test('image_generate: unsupported provider + missing config give clear errors', async () => {
  const tools = createWebMediaTools(fakeProvider());
  const unsupported = await tool(tools, 'image_generate').execute(
    { prompt: 'x', providerId: 'anthropic' },
    CTX('/tmp'),
  );
  assert.match(unsupported, /^Error: Provider "anthropic" does not support image generation/);
  assert.match(unsupported, /Supported providers: openai, xai, gemini/);

  const unbound = await tool(WEB_MEDIA_TOOLS, 'image_generate').execute(
    { prompt: 'x' },
    CTX('/tmp'),
  );
  assert.match(unbound, /^Error: No provider config is wired up/);

  const badSize = await tool(tools, 'image_generate').execute(
    { prompt: 'x', size: 'huge' },
    CTX('/tmp'),
  );
  assert.match(badSize, /^Error: Invalid "size"/);
});

// ---------------------------------------------------------------------------
// video_generate (mocked provider API)
// ---------------------------------------------------------------------------

test('video_generate: provider without video support errors and suggests video_from_images', async () => {
  const tools = createWebMediaTools(fakeProvider());
  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a cat dancing', providerId: 'anthropic' },
    CTX('/tmp'),
  );
  assert.match(out, /^Error: Provider "anthropic" does not support video generation/);
  assert.match(out, /video_from_images/);
});

test('video_generate: configured video model creates an async job, driver polls to done (mocked fetch)', async () => {
  const dir = makeTempWorkspace();
  const seen = [];
  const restore = mockFetch(async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    if (String(url) === 'https://video.example.com/v1/generate' && init.method === 'POST') {
      return jsonResponse({ id: 'job-123', status: 'queued' });
    }
    if (String(url) === 'https://video.example.com/v1/generate/job-123/content') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const buf = Buffer.from(TINY_PNG_BASE64, 'base64');
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        json: async () => ({}),
        text: async () => '',
      };
    }
    if (String(url) === 'https://video.example.com/v1/generate/job-123') {
      return jsonResponse({ id: 'job-123', status: 'completed' });
    }
    throw new Error(`unexpected mocked-fetch call: ${init.method} ${url}`);
  });
  try {
    const tools = createWebMediaTools({
      ...fakeProvider({ videoModel: 'vid-1', videoEndpoint: 'https://video.example.com/v1/generate' }),
      videoJobPollIntervalMs: 10,
    });
    const out = await tool(tools, 'video_generate').execute({ prompt: 'a cat dancing' }, CTX(dir));
    // video_generate is async now: it returns the LOCAL job id at once.
    assert.match(out, /Video job created via provider "openai" \(model "vid-1"/);
    assert.match(out, /Status: queued/);
    assert.match(out, /poll the job with video_status/);
    const jobId = out.match(/Job ID: (\S+)/)[1];
    assert.notEqual(jobId, 'job-123'); // the local id, not the provider's
    // The driver runs in the background: wait until it POSTs once to
    // the configured endpoint (it may not have run yet when execute
    // returned — video_generate is async by design).
    const postDeadline = Date.now() + 5000;
    while (!seen.some((s) => s.method === 'POST')) {
      if (Date.now() > postDeadline) throw new Error('driver never POSTed to the video endpoint');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(seen.filter((s) => s.method === 'POST').length, 1);
    assert.equal(seen[0].url, 'https://video.example.com/v1/generate');
    assert.equal(JSON.parse(seen[0].body).model, 'vid-1');
    // ...then polls video_status until the driver finishes the job.
    const deadline = Date.now() + 5000;
    let statusOut = '';
    for (;;) {
      statusOut = await tool(tools, 'video_status').execute({ jobId }, CTX(dir));
      if (statusOut.includes('Status: done')) break;
      if (Date.now() > deadline) throw new Error(`job did not finish:\n${statusOut}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(statusOut, new RegExp(`Output: generated-media/video-${jobId}\\.mp4`));
    assert.ok(fs.existsSync(path.join(dir, 'generated-media', `video-${jobId}.mp4`)));
    assert.ok(seen.some((s) => s.url.endsWith('/job-123/content')));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// video_from_images (REAL ffmpeg on tiny fake PNGs)
// ---------------------------------------------------------------------------

test('video_from_images: real ffmpeg slideshow from workspace images', async () => {
  const dir = makeTempWorkspace({
    'img/a.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
    'img/b.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
  });
  const out = await tool(WEB_MEDIA_TOOLS, 'video_from_images').execute(
    { images: ['img/a.png', 'img/b.png'], secondsPerImage: 1 },
    CTX(dir),
  );
  assert.match(out, /Slideshow video created: generated-media\/slideshow-.*\.mp4/);
  assert.match(out, /2 image\(s\) x 1s/);
  const outRel = out.match(/Slideshow video created: (\S+)/)[1];
  const full = path.join(dir, outRel);
  assert.ok(fs.existsSync(full));
  assert.ok(fs.statSync(full).size > 1000, 'mp4 should have real content');
  // No leftover concat file in .open-bot.
  const leftovers = fs.readdirSync(path.join(dir, '.open-bot')).filter((n) => n.startsWith('ffmpeg-concat-'));
  assert.deepEqual(leftovers, []);
});

test('video_from_images: missing image is a clear error', async () => {
  const dir = makeTempWorkspace();
  const out = await tool(WEB_MEDIA_TOOLS, 'video_from_images').execute(
    { images: ['nope.png'] },
    CTX(dir),
  );
  assert.match(out, /^Error: Image not found in the workspace: "nope\.png"/);
});

// ---------------------------------------------------------------------------
// CanvasStore (real files) + canvas tools
// ---------------------------------------------------------------------------

test('CanvasStore: create/read/write versions, list, optimistic concurrency', async () => {
  const dir = makeTempWorkspace();
  const store = new CanvasStore(dir, 'bot-1');
  const created = await store.create('My doc', [{ type: 'text', text: 'hi' }]);
  assert.equal(created.version, 1);
  assert.equal(created.botId, 'bot-1');
  assert.ok(created.id);
  assert.ok(fs.existsSync(path.join(dir, '.open-bot', 'canvas', 'bot-1', `${created.id}.json`)));

  const read = await store.read(created.id);
  assert.deepEqual(read.blocks, [{ type: 'text', text: 'hi' }]);

  const updated = await store.write(created.id, [{ type: 'text', text: 'v2' }], {
    expectedVersion: 1,
  });
  assert.equal(updated.version, 2);

  await assert.rejects(
    store.write(created.id, [], { expectedVersion: 1 }),
    /Version conflict: canvas .* is at version 2, but the write expected version 1/,
  );
  // Failed write leaves version 2 intact.
  assert.equal((await store.read(created.id)).version, 2);

  const second = await store.create('Second', []);
  const listed = await store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, second.id); // newest first
  assert.equal(listed[1].blockCount, 1);

  assert.equal(await store.read('does-not-exist'), null);
  assert.equal(await store.delete(second.id), true);
  assert.equal(await store.delete(second.id), false);
  assert.equal((await store.list()).length, 1);

  // Canvases are scoped per bot.
  const other = new CanvasStore(dir, 'bot-2');
  assert.deepEqual(await other.list(), []);
  assert.equal(await other.read(created.id), null);
});

test('CanvasStore: invalid ids/blocks/titles are rejected', async () => {
  const dir = makeTempWorkspace();
  const store = new CanvasStore(dir, 'bot-1');
  await assert.rejects(store.create('', []), /non-empty string/);
  await assert.rejects(store.create('ok', [{ noType: true }]), /string "type"/);
  await assert.rejects(store.create('ok', 'not-an-array'), /must be an array/);
  await assert.rejects(store.read('../escape'), /Invalid canvas id/);
  await assert.rejects(store.write('../escape', []), /Invalid canvas id/);
});

test('canvas tools: write/read/list round-trip through ToolContext', async () => {
  const dir = makeTempWorkspace();
  const tools = createCanvasTools();
  const writeOut = await tool(tools, 'canvas_write').execute(
    { title: 'Plan', blocks: [{ type: 'heading', text: 'Week 1' }] },
    CTX(dir),
  );
  assert.match(writeOut, /Canvas "Plan" saved \(id: (\S+), version: 1, 1 block\(s\)/);
  const id = writeOut.match(/id: ([^,]+), version/)[1];

  const readOut = await tool(tools, 'canvas_read').execute({ id }, CTX(dir));
  const doc = JSON.parse(readOut);
  assert.equal(doc.title, 'Plan');
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.blocks, [{ type: 'heading', text: 'Week 1' }]);

  const write2 = await tool(tools, 'canvas_write').execute(
    { id, blocks: JSON.stringify([{ type: 'text', text: 'updated' }]), expectedVersion: 1 },
    CTX(dir),
  );
  assert.match(write2, /version: 2/);

  const conflict = await tool(tools, 'canvas_write').execute(
    { id, blocks: [], expectedVersion: 1 },
    CTX(dir),
  );
  assert.match(conflict, /^Error: Version conflict/);

  const listOut = await tool(tools, 'canvas_list').execute({}, CTX(dir));
  assert.match(listOut, /Canvases \(1\):/);
  assert.match(listOut, new RegExp(id));

  const missing = await tool(tools, 'canvas_read').execute({ id: 'nope' }, CTX(dir));
  assert.match(missing, /^Error: No canvas with id "nope"/);

  const empty = await tool(tools, 'canvas_list').execute({}, CTX(makeTempWorkspace()));
  assert.match(empty, /no canvases yet/);
});
