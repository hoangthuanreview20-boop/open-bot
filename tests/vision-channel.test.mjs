/**
 * Vision channel (v0.63) — mock-based tests, no live API, no real key.
 *
 * Proves, end to end through the core only (renderer/main wiring is a
 * later wave — see the v0.63 wave report):
 *   1. `validateVisionAttachments` enforces the limits (count / size /
 *      mime / base64) with clear Vietnamese errors.
 *   2. `providerSupportsVision` / `ollamaModelSupportsVision` know
 *      which provider+model can see images — notably `qwen2.5:0.5b`
 *      (text-only) is refused while `qwen2.5-vl` / `llava` / `gemma3`
 *      pass.
 *   3. Each vision provider puts the image into the request in its
 *      own native shape (Gemini `inlineData`, OpenAI-compatible
 *      `image_url`, Anthropic `image` source) — asserted on a stubbed
 *      `fetch`, never on the network.
 *   4. `OllamaProvider.chat` refuses a text-only model with a clear
 *      error before any fetch; a vision model goes through.
 *   5. `AgentRunner.run` attaches the images to the first user
 *      message for a vision-capable provider, and refuses the turn
 *      (friendly text, provider NEVER called) for an unsupported
 *      model or invalid attachments.
 *   6. `AgentCoordinator.run` carries `RunParams.attachments` into
 *      the loop: a mock bot (no vision) answers with the friendly
 *      refusal and the mock provider records zero calls; a plain
 *      text run is unchanged.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core && node --test tests/vision-channel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  VISION_MAX_IMAGES,
  ollamaModelSupportsVision,
  providerSupportsVision,
  validateVisionAttachments,
} from '../packages/core/dist/agent/vision.js';
import { GeminiProvider } from '../packages/core/dist/providers/gemini.js';
import { OpenAICompatibleProvider } from '../packages/core/dist/providers/openaiCompatible.js';
import { AnthropicProvider } from '../packages/core/dist/providers/anthropic.js';
import { OllamaProvider } from '../packages/core/dist/providers/ollama.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const PNG = { mimeType: 'image/png', data: Buffer.from('fake-png-bytes').toString('base64'), name: 'cat.png' };
const JPEG = { mimeType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes').toString('base64'), name: 'dog.jpg' };

function stubFetch(captured, responseJson) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(responseJson),
    };
  };
  return () => {
    globalThis.fetch = prev;
  };
}

function makeBot(overrides = {}) {
  return {
    id: 'bot-vision',
    name: 'Bot Vision',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'Bạn là trợ lý.',
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vision-ws-')),
    autoApprove: true,
    ...overrides,
  };
}

const EVENTS = {
  onText() {},
  onToolCall() {},
  onToolResult() {},
  onApprovalNeeded: async () => true,
};

function scriptedProvider({ vision, calls }) {
  return {
    id: 'mock',
    label: 'Mock',
    ...(vision !== undefined ? { supportsVision: () => vision } : {}),
    async chat(req) {
      calls.push(req);
      return { text: 'đã thấy ảnh', toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Validation
// ---------------------------------------------------------------------------

test('vision: validateVisionAttachments accepts valid png/jpeg images', () => {
  const r = validateVisionAttachments([PNG, JPEG]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.attachments.length, 2);
});

test('vision: validateVisionAttachments accepts empty / absent attachments', () => {
  assert.equal(validateVisionAttachments([]).ok, true);
  assert.equal(validateVisionAttachments(undefined).ok, true);
});

test('vision: too many images are refused with a clear message', () => {
  const many = Array.from({ length: VISION_MAX_IMAGES + 1 }, (_, i) => ({ ...PNG, name: `a${i}.png` }));
  const r = validateVisionAttachments(many);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /tối đa 5 ảnh/);
});

test('vision: one oversized image is refused (per-image 10 MB cap)', () => {
  // 'A'.repeat(n) is valid base64; decoded bytes ≈ n*3/4 — 14M chars ≈ 10.5 MB.
  const big = { mimeType: 'image/png', data: 'A'.repeat(14_000_000), name: 'huge.png' };
  const r = validateVisionAttachments([big]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /quá lớn.*10\.0 MB/);
});

test('vision: total size over 20 MB is refused', () => {
  // Each ~7 MB decoded (base64 ~9.4M chars); three of them ≈ 21 MB total.
  const one = { mimeType: 'image/png', data: 'A'.repeat(9_400_000), name: 'big.png' };
  const r = validateVisionAttachments([one, { ...one }, { ...one }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Tổng dung lượng ảnh quá lớn/);
});

test('vision: unsupported mime (svg) is refused', () => {
  const r = validateVisionAttachments([{ mimeType: 'image/svg+xml', data: PNG.data, name: 'logo.svg' }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /không hỗ trợ.*PNG, JPEG, GIF và WebP/);
});

test('vision: malformed base64 is refused', () => {
  const r = validateVisionAttachments([{ mimeType: 'image/png', data: 'not base64!!!', name: 'bad.png' }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /không phải base64 hợp lệ/);
});

// ---------------------------------------------------------------------------
// 2. Capability table
// ---------------------------------------------------------------------------

test('vision: providerSupportsVision — API providers yes, CLI/unknown no', () => {
  const p = (id) => ({ id, label: id, chat: async () => ({ text: '', toolCalls: [] }), listModels: async () => [] });
  for (const id of ['gemini', 'openai', 'anthropic', 'xai', 'openai-compatible']) {
    assert.equal(providerSupportsVision(p(id), 'anything'), true, id);
  }
  for (const id of ['claude-code', 'codex', 'opencode', 'mock', 'unknown-provider']) {
    assert.equal(providerSupportsVision(p(id), 'anything'), false, id);
  }
  // A provider's own supportsVision() method wins over the table.
  assert.equal(
    providerSupportsVision({ ...p('mock'), supportsVision: () => true }, 'mock'),
    true,
  );
});

test('vision: ollamaModelSupportsVision — qwen2.5:0.5b is text-only, vision families pass', () => {
  assert.equal(ollamaModelSupportsVision('qwen2.5:0.5b'), false);
  assert.equal(ollamaModelSupportsVision('qwen2.5'), false);
  assert.equal(ollamaModelSupportsVision('llama3.1'), false);
  assert.equal(ollamaModelSupportsVision('qwen2.5-vl'), true);
  assert.equal(ollamaModelSupportsVision('qwen2.5vl:7b'), true);
  assert.equal(ollamaModelSupportsVision('llava'), true);
  assert.equal(ollamaModelSupportsVision('llava-llama3:8b'), true);
  assert.equal(ollamaModelSupportsVision('llama3.2-vision:11b'), true);
  assert.equal(ollamaModelSupportsVision('gemma3:4b'), true);
  assert.equal(ollamaModelSupportsVision('moondream'), true);
  assert.equal(ollamaModelSupportsVision('minicpm-v'), true);
  assert.equal(providerSupportsVision({ id: 'ollama', label: 'Ollama', chat: async () => ({ text: '', toolCalls: [] }), listModels: async () => [] }, 'qwen2.5:0.5b'), false);
});

// ---------------------------------------------------------------------------
// 3. Provider request shapes (stubbed fetch — no network)
// ---------------------------------------------------------------------------

test('vision: Gemini sends images as inlineData parts', async () => {
  const captured = [];
  const restore = stubFetch(captured, {
    candidates: [{ content: { parts: [{ text: 'thấy một con mèo' }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 },
  });
  try {
    const provider = new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' });
    const res = await provider.chat({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'Bạn là trợ lý.' },
        { role: 'user', content: 'Trong ảnh có gì?', attachments: [PNG, JPEG] },
      ],
    });
    assert.equal(res.text, 'thấy một con mèo');
    assert.equal(captured.length, 1);
    const contents = captured[0].body.contents;
    const user = contents.find((c) => c.role === 'user');
    assert.deepEqual(
      user.parts.map((part) => (part.text !== undefined ? 'text' : 'inlineData')),
      ['text', 'inlineData', 'inlineData'],
    );
    assert.deepEqual(user.parts[1], { inlineData: { mimeType: 'image/png', data: PNG.data } });
    assert.deepEqual(user.parts[2], { inlineData: { mimeType: 'image/jpeg', data: JPEG.data } });
  } finally {
    restore();
  }
});

test('vision: Gemini text-only message is unchanged (no inlineData)', async () => {
  const captured = [];
  const restore = stubFetch(captured, {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  });
  try {
    const provider = new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' });
    await provider.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'chào' }] });
    const user = captured[0].body.contents.find((c) => c.role === 'user');
    assert.deepEqual(user.parts, [{ text: 'chào' }]);
  } finally {
    restore();
  }
});

test('vision: OpenAI-compatible sends images as image_url parts', async () => {
  const captured = [];
  const restore = stubFetch(captured, {
    choices: [{ message: { content: 'a cat', tool_calls: [] } }],
    usage: { prompt_tokens: 50, completion_tokens: 5 },
  });
  try {
    const provider = new OpenAICompatibleProvider({
      id: 'openai-compatible',
      label: 'Custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      defaultModel: 'gpt-4.1',
    });
    const res = await provider.chat({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Trong ảnh có gì?', attachments: [PNG] }],
    });
    assert.equal(res.text, 'a cat');
    const msg = captured[0].body.messages[0];
    assert.equal(Array.isArray(msg.content), true);
    assert.deepEqual(msg.content, [
      { type: 'text', text: 'Trong ảnh có gì?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.data}` } },
    ]);
  } finally {
    restore();
  }
});

test('vision: OpenAI-compatible text-only message keeps the plain-string shape', async () => {
  const captured = [];
  const restore = stubFetch(captured, { choices: [{ message: { content: 'ok' } }] });
  try {
    const provider = new OpenAICompatibleProvider({
      id: 'openai-compatible',
      label: 'Custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      defaultModel: 'gpt-4.1',
    });
    await provider.chat({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'chào' }] });
    assert.equal(captured[0].body.messages[0].content, 'chào');
  } finally {
    restore();
  }
});

test('vision: Anthropic sends images as base64 image blocks', async () => {
  const captured = [];
  const restore = stubFetch(captured, {
    content: [{ type: 'text', text: 'thấy ảnh' }],
    usage: { input_tokens: 10, output_tokens: 3 },
  });
  try {
    const provider = new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' });
    const res = await provider.chat({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Trong ảnh có gì?', attachments: [JPEG] }],
    });
    assert.equal(res.text, 'thấy ảnh');
    const msg = captured[0].body.messages[0];
    assert.deepEqual(msg.content, [
      { type: 'text', text: 'Trong ảnh có gì?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.data } },
    ]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Ollama gate (defence-in-depth for direct provider callers)
// ---------------------------------------------------------------------------

test('vision: Ollama qwen2.5:0.5b refuses images before any fetch', async () => {
  const captured = [];
  const restore = stubFetch(captured, { choices: [{ message: { content: 'x' } }] });
  try {
    const provider = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
    await assert.rejects(
      provider.chat({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Trong ảnh có gì?', attachments: [PNG] }],
      }),
      /không xem được ảnh/,
    );
    assert.equal(captured.length, 0, 'no fetch must happen for a text-only model');
  } finally {
    restore();
  }
});

test('vision: Ollama qwen2.5-vl passes images through as image_url', async () => {
  const captured = [];
  const restore = stubFetch(captured, { choices: [{ message: { content: 'a cat' } }] });
  try {
    const provider = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5-vl' });
    const res = await provider.chat({
      model: 'qwen2.5-vl',
      messages: [{ role: 'user', content: 'Trong ảnh có gì?', attachments: [PNG] }],
    });
    assert.equal(res.text, 'a cat');
    assert.equal(captured.length, 1);
    const msg = captured[0].body.messages[0];
    assert.equal(msg.content[1].type, 'image_url');
    assert.equal(msg.content[1].image_url.url, `data:image/png;base64,${PNG.data}`);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Agent loop
// ---------------------------------------------------------------------------

test('vision: loop attaches images to the first user message (vision provider)', async () => {
  const calls = [];
  const runner = new AgentRunner(scriptedProvider({ vision: true, calls }), [], {
    bot: makeBot(),
    events: EVENTS,
    attachments: [PNG],
  });
  const text = await runner.run('Trong ảnh có gì?');
  assert.equal(text, 'đã thấy ảnh');
  assert.equal(calls.length, 1);
  const user = calls[0].messages.find((m) => m.role === 'user');
  assert.equal(user.content, 'Trong ảnh có gì?');
  assert.deepEqual(user.attachments, [PNG]);
});

test('vision: loop refuses the turn (provider never called) when the model has no vision', async () => {
  const calls = [];
  const runner = new AgentRunner(scriptedProvider({ vision: false, calls }), [], {
    bot: makeBot({ model: 'qwen2.5:0.5b' }),
    events: EVENTS,
    attachments: [PNG],
  });
  const text = await runner.run('Trong ảnh có gì?');
  assert.match(text, /chưa xem được ảnh|không xem được ảnh/);
  assert.equal(calls.length, 0, 'provider must not be called for an unsupported model');
});

test('vision: loop refuses the turn (provider never called) for invalid attachments', async () => {
  const calls = [];
  const runner = new AgentRunner(scriptedProvider({ vision: true, calls }), [], {
    bot: makeBot(),
    events: EVENTS,
    attachments: [{ mimeType: 'image/svg+xml', data: PNG.data, name: 'logo.svg' }],
  });
  const text = await runner.run('Trong ảnh có gì?');
  assert.match(text, /không hỗ trợ/);
  assert.equal(calls.length, 0);
});

test('vision: loop without attachments behaves exactly as before', async () => {
  const calls = [];
  const runner = new AgentRunner(scriptedProvider({ vision: true, calls }), [], {
    bot: makeBot(),
    events: EVENTS,
  });
  const text = await runner.run('chào');
  assert.equal(text, 'đã thấy ảnh');
  const user = calls[0].messages.find((m) => m.role === 'user');
  assert.equal(user.content, 'chào');
  assert.equal(user.attachments, undefined);
});

// ---------------------------------------------------------------------------
// 6. Coordinator: RunParams.attachments reaches the loop
// ---------------------------------------------------------------------------

test('vision: coordinator run with attachments on a no-vision bot returns the friendly refusal and never calls the provider', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vision-coord-'));
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const recordPath = path.join(dataDir, 'mock-record.jsonl');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    await coordinator.createBot({
      bot: {
        id: 'bot-vision',
        name: 'Bot Vision',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: true,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [{ text: 'xong' }],
        mockRecordPath: recordPath,
      },
    });
    const result = await coordinator.run({
      botId: 'bot-vision',
      text: 'Trong ảnh có gì?',
      attachments: [PNG],
    });
    assert.match(result.text, /chưa xem được ảnh|không xem được ảnh/);
    assert.equal(result.stopped, false);
    assert.equal(fs.existsSync(recordPath), false, 'mock provider must record zero calls');
  } finally {
    coordinator.shutdown();
  }
});

test('vision: coordinator plain-text run is unchanged (no attachments)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vision-coord2-'));
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const recordPath = path.join(dataDir, 'mock-record.jsonl');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    await coordinator.createBot({
      bot: {
        id: 'bot-vision',
        name: 'Bot Vision',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: true,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [{ text: 'xong' }],
        mockRecordPath: recordPath,
      },
    });
    const result = await coordinator.run({ botId: 'bot-vision', text: 'chào' });
    assert.equal(result.text, 'xong');
    const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const user = JSON.parse(lines[0]).messages.find((m) => m.role === 'user');
    assert.equal(user.content, 'chào');
    assert.equal(user.attachments, undefined);
  } finally {
    coordinator.shutdown();
  }
});
