/**
 * Tests for v0.89a — vision over the Local API
 * (`POST /v1/bots/:id/run` with `attachments`).
 *
 * Audit finding (v0.89a): the desktop chat (`chat:send`) had carried
 * images since v0.63/v0.64, but the Local API — the other programmatic
 * entry point — rejected every image: it required non-empty `text`
 * and had no `attachments` field at all, so scripts and third-party
 * apps on the same machine could never show the agent a picture.
 * This file proves the fix through the real HTTP server with a
 * recording `runBot` handler (no network, no key, no provider call):
 * text+image and image-only turns reach the handler with the exact
 * attachments, invalid attachments are 400 before any run starts,
 * and text-only / empty-text behaviour is unchanged.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api-vision-v089a.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';

import { createApiServer } from '../packages/core/dist/api/server.js';

const TOKEN = 'test-token-vision-v089a';
const BOTS = [{ id: 'bot-1', name: 'Trợ lý', providerId: 'gemini', model: 'gemini-2.5-flash' }];

const servers = [];
async function startServer(handlers) {
  const server = createApiServer({ port: 0, token: TOKEN, handlers });
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

/** Recording runBot: captures exactly what the server passes through. */
function recordingHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      listBots: async () => BOTS,
      runBot: async (botId, text, opts) => {
        calls.push({ botId, text, opts });
        await new Promise((r) => setTimeout(r, 10));
        return { text: `echo: ${text}` };
      },
      getHistory: async () => [],
      listTasks: async () => [],
    },
  };
}

async function postRun(server, body) {
  return fetch(`http://127.0.0.1:${server.port}/v1/bots/bot-1/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function pollRun(server, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const run = await res.json();
    if (run.status !== 'running') return run;
    assert.ok(Date.now() < deadline, 'run did not finish in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- Tiny solid-red PNG, built byte-exact in-test (no fixture file) ---

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** Solid-red RGB PNG, base64. Default 8x8 — small but a real image. */
function makeRedPngBase64(w = 8, h = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = 255; // R
      raw[o + 1] = 0;
      raw[o + 2] = 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

const RED_PNG = makeRedPngBase64();
const ATT = { mimeType: 'image/png', data: RED_PNG, name: 'red.png' };

test('POST run với text + 1 ảnh: 202, runBot nhận đúng attachments, run done', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, { text: 'màu gì đây?', attachments: [ATT] });
  if (res.status !== 202) assert.fail(`status ${res.status}: ${await res.text()}`);
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal(started.status, 'running');
  assert.equal(typeof started.runId, 'string');
  const run = await pollRun(server, started.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.text, 'echo: màu gì đây?');
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].botId, 'bot-1');
  assert.equal(rec.calls[0].text, 'màu gì đây?');
  assert.deepEqual(rec.calls[0].opts?.attachments, [ATT]);
});

test('POST run chỉ có ảnh (text rỗng): 202 — tin chỉ-ảnh đi được qua Local API', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, { text: '', attachments: [ATT] });
  if (res.status !== 202) assert.fail(`status ${res.status}: ${await res.text()}`);
  assert.equal(res.status, 202);
  const started = await res.json();
  const run = await pollRun(server, started.runId);
  assert.equal(run.status, 'done');
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].text, '');
  assert.deepEqual(rec.calls[0].opts?.attachments, [ATT]);
});

test('POST run text-only (không có attachments): như cũ — 202, runBot không nhận opts', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, { text: 'chào' });
  if (res.status !== 202) assert.fail(`status ${res.status}: ${await res.text()}`);
  assert.equal(res.status, 202);
  const started = await res.json();
  await pollRun(server, started.runId);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].opts, undefined);
});

test('POST run text rỗng, không ảnh: vẫn 400 như cũ, không chạy gì', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, { text: '   ' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /non-empty/);
  assert.equal(rec.calls.length, 0);
});

test('POST run ảnh sai định dạng (SVG): 400, runBot không được gọi', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, {
    text: 'xem ảnh này',
    attachments: [{ mimeType: 'image/svg+xml', data: RED_PNG, name: 'a.svg' }],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /không hỗ trợ/);
  assert.equal(rec.calls.length, 0);
});

test('POST run 6 ảnh: 400 (quá giới hạn 5), runBot không được gọi', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, {
    text: 'nhiều ảnh',
    attachments: Array.from({ length: 6 }, (_, i) => ({ ...ATT, name: `a${i}.png` })),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /tối đa 5 ảnh/);
  assert.equal(rec.calls.length, 0);
});

test('POST run ảnh base64 hỏng: 400, runBot không được gọi', async () => {
  const rec = recordingHandlers();
  const server = await startServer(rec.handlers);
  const res = await postRun(server, {
    text: 'xem ảnh này',
    attachments: [{ mimeType: 'image/png', data: '!!!not-base64!!!', name: 'a.png' }],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /base64/);
  assert.equal(rec.calls.length, 0);
});
