/**
 * Tests for the v0.86b (P1-5) async video jobs: video_generate creates
 * a durable job, video_status polls it, video_cancel stops it.
 *
 * MOCK ONLY: MockVideoProvider below is a fake in-process provider —
 * it never touches the network and never calls a real video API. Its
 * name and every test name say MOCK. Live generation through
 * HttpVideoProvider (OpenAI Sora shape) is NOT tested live here (no
 * key on this machine); the HTTP request/response shape is covered
 * with a mocked global fetch at the bottom of this file, and the old
 * video_generate test in web-media-v06.test.mjs covers the same path
 * through the tool.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/video-provider-v086.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createWebMediaTools,
  VideoJobStore,
  HttpVideoProvider,
  formatVideoJob,
  isVideoJobTerminal,
} from '../packages/tools/dist/index.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

const FAKE_MP4 = Buffer.from('FAKE-MP4-BYTES-v086');

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-video-v086-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MockVideoProvider — a fake in-process video backend (NO network, NO key)
// ---------------------------------------------------------------------------

/**
 * script = {
 *   providerJobId?: string,
 *   failStart?: string,          // startJob throws Error(failStart)
 *   polls: Array<VideoPollResult | Error>,  // consumed in order, then repeats the last one
 * }
 */
class MockVideoProvider {
  constructor(script = {}) {
    this.id = 'mock-video';
    this.script = script;
    this.calls = [];
    this.pollCount = 0;
    this.cancelled = [];
  }

  async startJob(req) {
    this.calls.push(['start', req]);
    if (this.script.failStart) throw new Error(this.script.failStart);
    return {
      providerJobId: this.script.providerJobId ?? 'mock-provider-job-1',
      status: 'queued',
    };
  }

  async pollJob(providerJobId) {
    this.pollCount += 1;
    this.calls.push(['poll', providerJobId]);
    const polls = this.script.polls ?? [{ status: 'done' }];
    const step = polls[Math.min(this.pollCount - 1, polls.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  }

  async downloadJob(providerJobId) {
    this.calls.push(['download', providerJobId]);
    return FAKE_MP4;
  }

  async cancelJob(providerJobId) {
    this.cancelled.push(providerJobId);
  }
}

const running = { status: 'running' };
const done = { status: 'done' };

function mockTools(mock, extraOpts = {}) {
  return createWebMediaTools({
    getProviderConfig: async () => ({
      id: 'openai',
      apiKey: 'sk-test-never-logged',
      baseUrl: 'https://api.openai.com/v1',
    }),
    defaultProviderId: 'openai',
    createVideoProvider: () => mock,
    videoJobPollIntervalMs: 10,
    ...extraOpts,
  });
}

function extractJobId(out) {
  const m = out.match(/Job ID: (\S+)/);
  assert.ok(m, `expected "Job ID: ..." in output:\n${out}`);
  return m[1];
}

async function waitForStatus(tools, ctx, jobId, wanted, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    last = await tool(tools, 'video_status').execute({ jobId }, ctx);
    if (last.includes(`Status: ${wanted}`)) return last;
    if (Date.now() > deadline) {
      throw new Error(`MOCK: timed out waiting for status ${wanted}; last output:\n${last}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle with the MOCK provider
// ---------------------------------------------------------------------------

test('MOCK lifecycle: video_generate -> running -> done, mp4 saved, status reports the path', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({ polls: [running, running, done] });
  const tools = mockTools(mock);
  const ctx = CTX(dir);

  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a cat dancing in the rain' },
    ctx,
  );
  assert.match(out, /Video job created via provider "openai" \(model "sora-2"/);
  assert.match(out, /Status: queued/);
  assert.match(out, /poll the job with video_status/);
  const jobId = extractJobId(out);
  assert.doesNotMatch(out, /sk-test-never-logged/);

  const finalOut = await waitForStatus(tools, ctx, jobId, 'done');
  assert.match(finalOut, /Status: done/);
  assert.match(finalOut, new RegExp(`Output: generated-media/video-${jobId}\\.mp4`));
  assert.match(finalOut, /The video file is saved in the workspace/);
  const saved = fs.readFileSync(path.join(dir, 'generated-media', `video-${jobId}.mp4`));
  assert.deepEqual(saved, FAKE_MP4);

  // The mock saw the right start request (default model sora-2, 5s).
  const start = mock.calls.find(([kind]) => kind === 'start');
  assert.deepEqual(start[1], {
    prompt: 'a cat dancing in the rain',
    model: 'sora-2',
    durationSeconds: 5,
  });
  assert.ok(mock.calls.some(([kind]) => kind === 'download'));
});

test('MOCK failed: provider reports failed -> job failed with the provider error', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({
    polls: [running, { status: 'failed', error: 'MOCK render exploded' }],
  });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute({ prompt: 'x' }, ctx);
  const jobId = extractJobId(out);
  const finalOut = await waitForStatus(tools, ctx, jobId, 'failed');
  assert.match(finalOut, /Status: failed/);
  assert.match(finalOut, /MOCK render exploded/);
});

test('MOCK start failure: startJob throws -> job failed, no hang', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({ failStart: 'MOCK provider is down' });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute({ prompt: 'x' }, ctx);
  const jobId = extractJobId(out);
  const finalOut = await waitForStatus(tools, ctx, jobId, 'failed');
  assert.match(finalOut, /Failed to start the video job on provider "mock-video"/);
  assert.match(finalOut, /MOCK provider is down/);
});

test('MOCK timeout: always running + timeoutSeconds 1 -> timed_out', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({ polls: [running] });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute(
    { prompt: 'a very slow video', timeoutSeconds: 1 },
    ctx,
  );
  const jobId = extractJobId(out);
  const finalOut = await waitForStatus(tools, ctx, jobId, 'timed_out', 5000);
  assert.match(finalOut, /Status: timed_out/);
  assert.match(finalOut, /timed out after 1s/);
});

test('MOCK cancel: cancel a running job -> cancelled, driver stops, provider cancelJob called', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({ polls: [running] });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute({ prompt: 'x' }, ctx);
  const jobId = extractJobId(out);
  // Let the driver start the provider job first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cancelOut = await tool(tools, 'video_cancel').execute({ jobId }, ctx);
  assert.match(cancelOut, new RegExp(`Video job "${jobId}" cancelled \\(was (queued|running)\\)`));
  // The driver must not revive it afterwards.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statusOut = await tool(tools, 'video_status').execute({ jobId }, ctx);
  assert.match(statusOut, /Status: cancelled/);
  assert.ok(
    mock.cancelled.includes('mock-provider-job-1'),
    `expected provider cancelJob to be called, got ${JSON.stringify(mock.cancelled)}`,
  );
  // Cancelling again is an error.
  const again = await tool(tools, 'video_cancel').execute({ jobId }, ctx);
  assert.match(again, /^Error: Video job .* is already cancelled/);
});

test('MOCK cancel of a done job is an error', async () => {
  const dir = makeTempWorkspace();
  const mock = new MockVideoProvider({ polls: [done] });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute({ prompt: 'x' }, ctx);
  const jobId = extractJobId(out);
  await waitForStatus(tools, ctx, jobId, 'done');
  const cancelOut = await tool(tools, 'video_cancel').execute({ jobId }, ctx);
  assert.match(cancelOut, /^Error: Video job .* is already done/);
});

test('video_status / video_cancel: unknown job id is a clear error', async () => {
  const dir = makeTempWorkspace();
  const tools = mockTools(new MockVideoProvider());
  const ctx = CTX(dir);
  const statusOut = await tool(tools, 'video_status').execute({ jobId: 'no-such-job' }, ctx);
  assert.match(statusOut, /^Error: No video job with id "no-such-job"/);
  const cancelOut = await tool(tools, 'video_cancel').execute({ jobId: 'no-such-job' }, ctx);
  assert.match(cancelOut, /^Error: No video job with id "no-such-job"/);
  const badId = await tool(tools, 'video_status').execute({ jobId: '../escape' }, ctx);
  assert.match(badId, /^Error: Invalid video job id/);
});

test('video_generate: provider without video support errors and suggests video_from_images', async () => {
  const dir = makeTempWorkspace();
  const tools = createWebMediaTools({
    getProviderConfig: async () => ({
      id: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
    }),
    defaultProviderId: 'anthropic',
  });
  const out = await tool(tools, 'video_generate').execute({ prompt: 'x' }, CTX(dir));
  assert.match(out, /^Error: Provider "anthropic" does not support video generation/);
  assert.match(out, /video_from_images/);
  assert.match(out, /Grok Imagine is app-only/);
});

// ---------------------------------------------------------------------------
// Persistence: a fresh store / fresh tools instance reads the same job
// (simulates a restart — no driver is running for these records)
// ---------------------------------------------------------------------------

test('MOCK persistence after restart: fresh store + fresh tools read the same job', async () => {
  const dir = makeTempWorkspace();
  // 1. A queued job written by one store instance...
  const store1 = new VideoJobStore(dir, 'test-bot');
  const job = await store1.create({
    prompt: 'restart me',
    providerId: 'openai',
    model: 'sora-2',
    durationSeconds: 5,
    timeoutMs: 600_000,
  });
  assert.equal(job.status, 'queued');
  assert.ok(
    fs.existsSync(path.join(dir, '.open-bot', 'video-jobs', 'test-bot', `${job.id}.json`)),
  );

  // 2. ...is read back by a brand-new store instance (simulated restart).
  const store2 = new VideoJobStore(dir, 'test-bot');
  const reread = await store2.read(job.id);
  assert.equal(reread.status, 'queued');
  assert.equal(reread.prompt, 'restart me');
  assert.equal(reread.model, 'sora-2');

  // 3. ...and by a brand-new tools factory via video_status (no live
  // refresh is possible: no providerJobId yet, so the stored state
  // is reported as-is).
  const freshTools = mockTools(new MockVideoProvider());
  const statusOut = await tool(freshTools, 'video_status').execute({ jobId: job.id }, CTX(dir));
  assert.match(statusOut, /Status: queued/);
  assert.match(statusOut, new RegExp(`Video job ${job.id}`));

  // 4. A finished job persists too (full MOCK flow, then a fresh store).
  const mock = new MockVideoProvider({ polls: [done] });
  const tools = mockTools(mock);
  const ctx = CTX(dir);
  const out = await tool(tools, 'video_generate').execute({ prompt: 'persisted done' }, ctx);
  const doneId = extractJobId(out);
  await waitForStatus(tools, ctx, doneId, 'done');
  const store3 = new VideoJobStore(dir, 'test-bot');
  const doneJob = await store3.read(doneId);
  assert.equal(doneJob.status, 'done');
  assert.equal(doneJob.outputPath, `generated-media/video-${doneId}.mp4`);
  assert.ok(fs.existsSync(path.join(dir, doneJob.outputPath)));
  assert.equal((await store3.list()).length, 2);

  // Jobs are scoped per bot.
  const otherBot = new VideoJobStore(dir, 'other-bot');
  assert.deepEqual(await otherBot.list(), []);
  assert.equal(await otherBot.read(job.id), null);
});

test('VideoJobStore: invalid ids rejected, delete works, terminal helper', async () => {
  const dir = makeTempWorkspace();
  const store = new VideoJobStore(dir, 'test-bot');
  await assert.rejects(store.read('../escape'), /Invalid video job id/);
  await assert.rejects(store.delete('../escape'), /Invalid video job id/);
  assert.equal(await store.delete('does-not-exist'), false);
  assert.equal(isVideoJobTerminal('done'), true);
  assert.equal(isVideoJobTerminal('timed_out'), true);
  assert.equal(isVideoJobTerminal('running'), false);
  assert.equal(isVideoJobTerminal('queued'), false);
  const job = await store.create({
    prompt: 'x',
    providerId: 'openai',
    model: 'sora-2',
    durationSeconds: 5,
    timeoutMs: 600_000,
  });
  assert.equal(await store.delete(job.id), true);
  assert.equal(await store.read(job.id), null);
  assert.deepEqual(formatVideoJob({ ...job, status: 'queued' }).split('\n')[1], 'Status: queued');
});

// ---------------------------------------------------------------------------
// HttpVideoProvider shape (mocked fetch — NO live call, NO real key)
// ---------------------------------------------------------------------------

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

test('HttpVideoProvider (mocked fetch): Sora-shaped start/poll/download/cancel, key never in errors', async () => {
  const seen = [];
  const restore = mockFetch(async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', body: init.body, auth: init.headers?.Authorization });
    if (String(url).endsWith('/videos') && init.method === 'POST') {
      return jsonResponse({ id: 'vid-9', status: 'queued' });
    }
    if (String(url).endsWith('/videos/vid-9/content')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          const buf = Buffer.from(FAKE_MP4);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        json: async () => ({}),
        text: async () => '',
      };
    }
    if (String(url).endsWith('/videos/vid-9') && (init.method ?? 'GET') === 'GET') {
      return jsonResponse({ id: 'vid-9', status: 'in_progress', progress: 0.5 });
    }
    if (String(url).endsWith('/videos/vid-9') && init.method === 'DELETE') {
      return jsonResponse({ id: 'vid-9', status: 'cancelled' });
    }
    throw new Error(`unexpected mocked-fetch call: ${init.method} ${url}`);
  });
  try {
    const provider = new HttpVideoProvider({
      id: 'openai',
      apiKey: 'sk-test-never-logged',
      baseUrl: 'https://api.openai.com/v1',
    });
    assert.equal(provider.id, 'openai');
    const started = await provider.startJob({ prompt: 'a river', model: 'sora-2', durationSeconds: 5 });
    assert.equal(started.providerJobId, 'vid-9');
    assert.equal(seen[0].url, 'https://api.openai.com/v1/videos');
    assert.equal(seen[0].method, 'POST');
    assert.deepEqual(JSON.parse(seen[0].body), { model: 'sora-2', prompt: 'a river', seconds: '5' });
    assert.equal(seen[0].auth, 'Bearer sk-test-never-logged');

    const polled = await provider.pollJob('vid-9');
    assert.equal(polled.status, 'running'); // in_progress -> running
    assert.equal(polled.progress, 0.5);
    assert.equal(seen[1].url, 'https://api.openai.com/v1/videos/vid-9');

    const bytes = await provider.downloadJob('vid-9');
    assert.deepEqual(bytes, FAKE_MP4);
    assert.equal(seen[2].url, 'https://api.openai.com/v1/videos/vid-9/content');

    await provider.cancelJob('vid-9');
    assert.equal(seen[3].method, 'DELETE');

    // A failed start surfaces the HTTP status without the key.
    const restore2 = mockFetch(async () => jsonResponse({ error: 'bad key' }, false, 401));
    try {
      await assert.rejects(
        provider.startJob({ prompt: 'x', model: 'sora-2', durationSeconds: 5 }),
        /HTTP 401/,
      );
    } finally {
      restore2();
    }
  } finally {
    restore();
  }
});
