/**
 * Tests for the 7 dedicated OpenAI-compatible API providers added in
 * v0.97 (Team T6): DeepSeek, Moonshot/Kimi, Qwen, Mistral, Groq,
 * Together, Cohere.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/providers-v097.test.mjs
 *
 * No real API key and no network: global fetch is stubbed. The tests
 * prove each provider posts to its own verified base URL with the
 * right model + Bearer key, falls back to its known models when the
 * list endpoint is unreachable, and is registered in PROVIDERS /
 * createProvider / the model registry with its own Vault key
 * namespace ('provider', <id> — resolved generically, so a key the
 * user enters in Settings reaches the right provider).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CohereProvider, COHERE_BASE_URL, COHERE_DEFAULT_MODEL, COHERE_KNOWN_MODELS } from '../packages/core/dist/providers/cohere.js';
import { DeepSeekProvider, DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_KNOWN_MODELS } from '../packages/core/dist/providers/deepseek.js';
import { GroqProvider, GROQ_BASE_URL, GROQ_DEFAULT_MODEL, GROQ_KNOWN_MODELS } from '../packages/core/dist/providers/groq.js';
import { MistralProvider, MISTRAL_BASE_URL, MISTRAL_DEFAULT_MODEL, MISTRAL_KNOWN_MODELS } from '../packages/core/dist/providers/mistral.js';
import { MoonshotProvider, MOONSHOT_BASE_URL, MOONSHOT_DEFAULT_MODEL, MOONSHOT_KNOWN_MODELS } from '../packages/core/dist/providers/moonshot.js';
import { QwenProvider, QWEN_BASE_URL, QWEN_DEFAULT_MODEL, QWEN_KNOWN_MODELS } from '../packages/core/dist/providers/qwen.js';
import { TogetherProvider, TOGETHER_BASE_URL, TOGETHER_DEFAULT_MODEL, TOGETHER_KNOWN_MODELS } from '../packages/core/dist/providers/together.js';
import { PROVIDERS, createProvider } from '../packages/core/dist/providers/index.js';
import { COMPATIBLE_PRESETS, listCompatiblePresets, resolvePreset } from '../packages/core/dist/models/presets.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPEN_BOT_FETCH_TIMEOUT_MS;
});

// id -> [Provider class, BASE_URL, DEFAULT_MODEL, KNOWN_MODELS]
const EXPECTED = {
  deepseek: [DeepSeekProvider, DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_KNOWN_MODELS],
  moonshot: [MoonshotProvider, MOONSHOT_BASE_URL, MOONSHOT_DEFAULT_MODEL, MOONSHOT_KNOWN_MODELS],
  qwen: [QwenProvider, QWEN_BASE_URL, QWEN_DEFAULT_MODEL, QWEN_KNOWN_MODELS],
  mistral: [MistralProvider, MISTRAL_BASE_URL, MISTRAL_DEFAULT_MODEL, MISTRAL_KNOWN_MODELS],
  groq: [GroqProvider, GROQ_BASE_URL, GROQ_DEFAULT_MODEL, GROQ_KNOWN_MODELS],
  together: [TogetherProvider, TOGETHER_BASE_URL, TOGETHER_DEFAULT_MODEL, TOGETHER_KNOWN_MODELS],
  cohere: [CohereProvider, COHERE_BASE_URL, COHERE_DEFAULT_MODEL, COHERE_KNOWN_MODELS],
};

const EXPECTED_BASE_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
};

const EXPECTED_DEFAULT_MODELS = {
  deepseek: 'deepseek-v4-flash',
  moonshot: 'kimi-k3',
  qwen: 'qwen-plus',
  mistral: 'mistral-small-latest',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  cohere: 'command-a-03-2025',
};

function configFor(id) {
  return {
    id,
    label: id,
    apiKey: `test-key-for-${id}`,
    defaultModel: EXPECTED_DEFAULT_MODELS[id],
  };
}

const chatReq = (model) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
});

function fakeChatResponse(text = 'hello from mock') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }),
    { status: 200 },
  );
}

// ---------------------------------------------------------------------------
// Constants: verified base URLs + default models + known-model lists
// ---------------------------------------------------------------------------

test('v097 providers: base URLs match the verified provider endpoints', () => {
  for (const [id, url] of Object.entries(EXPECTED_BASE_URLS)) {
    const [, baseUrl] = EXPECTED[id];
    assert.equal(baseUrl, url, `${id} baseUrl`);
    assert.ok(baseUrl.startsWith('https://'), `${id} baseUrl must be https`);
  }
});

test('v097 providers: default models are the verified current defaults', () => {
  for (const [id, model] of Object.entries(EXPECTED_DEFAULT_MODELS)) {
    const [, , defaultModel] = EXPECTED[id];
    assert.equal(defaultModel, model, `${id} defaultModel`);
  }
});

test('v097 providers: known models are non-empty, unique, and contain the default', () => {
  for (const [id, [, , defaultModel, known]] of Object.entries(EXPECTED)) {
    assert.ok(known.length >= 2, `${id} needs at least 2 known models`);
    assert.equal(new Set(known).size, known.length, `${id} known models must be unique`);
    assert.ok(known.includes(defaultModel), `${id} known models must contain the default`);
    for (const m of known) {
      assert.equal(typeof m, 'string');
      assert.ok(m.trim().length > 0, `${id} model id must not be empty`);
    }
  }
});

test('v097 providers: retired model ids are NOT in the known lists', () => {
  // DeepSeek retired deepseek-chat / deepseek-reasoner on 2026-07-24;
  // Moonshot retired moonshot-v1-* and kimi-k2.5 on 2026-08-31.
  assert.ok(!DEEPSEEK_KNOWN_MODELS.includes('deepseek-chat'));
  assert.ok(!DEEPSEEK_KNOWN_MODELS.includes('deepseek-reasoner'));
  assert.ok(!MOONSHOT_KNOWN_MODELS.includes('moonshot-v1-8k'));
  assert.ok(!MOONSHOT_KNOWN_MODELS.includes('kimi-k2.5'));
});

// ---------------------------------------------------------------------------
// chat(): posts to the provider's own /chat/completions with key + model
// ---------------------------------------------------------------------------

for (const [id, [ProviderClass, baseUrl, defaultModel]] of Object.entries(EXPECTED)) {
  test(`v097 providers: ${id} chat() posts to its own endpoint with Bearer key + model`, async () => {
    let seenUrl;
    let seenHeaders;
    let seenBody;
    globalThis.fetch = async (url, opts) => {
      seenUrl = String(url);
      seenHeaders = opts.headers;
      seenBody = JSON.parse(opts.body);
      return fakeChatResponse();
    };
    const provider = new ProviderClass(configFor(id));
    assert.equal(provider.id, id);
    const res = await provider.chat(chatReq(defaultModel));
    assert.equal(res.text, 'hello from mock');
    assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 4 });
    assert.equal(seenUrl, `${baseUrl}/chat/completions`);
    assert.equal(seenHeaders.Authorization, `Bearer test-key-for-${id}`);
    assert.equal(seenBody.model, defaultModel);
    assert.equal(seenBody.messages[0].content, 'hi');
  });

  test(`v097 providers: ${id} chat() surfaces an HTTP error with status`, async () => {
    globalThis.fetch = async () =>
      new Response('{"error": {"message": "bad key"}}', { status: 401, statusText: 'Unauthorized' });
    const provider = new ProviderClass(configFor(id));
    await assert.rejects(() => provider.chat(chatReq(defaultModel)), /HTTP 401/);
  });

  test(`v097 providers: ${id} empty baseUrl fails closed with a clear error`, async () => {
    // `??` only falls back on null/undefined, so an explicit '' stays
    // '' and chat() refuses before any fetch — fail-closed, like xAI.
    // (In production providerConfigFor turns '' into undefined, so
    // the provider constant wins there.)
    const provider = new ProviderClass({ ...configFor(id), baseUrl: '' });
    await assert.rejects(
      () => provider.chat(chatReq(defaultModel)),
      /chưa cấu hình baseUrl cho provider này/,
    );
  });

  test(`v097 providers: ${id} listModels() returns the live list when /models answers`, async () => {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/models$/);
      return new Response(JSON.stringify({ data: [{ id: 'live-model-a' }, { id: 'live-model-b' }] }), { status: 200 });
    };
    const provider = new ProviderClass(configFor(id));
    assert.deepEqual(await provider.listModels(), ['live-model-a', 'live-model-b']);
  });

  test(`v097 providers: ${id} listModels() falls back to known models when /models fails`, async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const provider = new ProviderClass(configFor(id));
    assert.deepEqual(await provider.listModels(), [...EXPECTED[id][3]]);
  });
}

// ---------------------------------------------------------------------------
// Registry: PROVIDERS meta + createProvider dispatch
// ---------------------------------------------------------------------------

test('v097 providers: PROVIDERS has all 7, needsKey, api kind, matching baseUrl/model', () => {
  for (const [id, [, baseUrl, defaultModel]] of Object.entries(EXPECTED)) {
    const meta = PROVIDERS.find((m) => m.id === id);
    assert.ok(meta, `PROVIDERS missing ${id}`);
    assert.equal(meta.defaultBaseUrl, baseUrl, `${id} meta baseUrl`);
    assert.equal(meta.defaultModel, defaultModel, `${id} meta defaultModel`);
    assert.equal(meta.needsKey, true, `${id} must need a user key`);
    assert.ok(meta.kind === undefined || meta.kind === 'api', `${id} must be an api provider, not cli`);
  }
  const ids = PROVIDERS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'PROVIDERS ids must be unique');
});

test('v097 providers: createProvider dispatches all 7 ids (and still rejects unknown ids)', () => {
  for (const id of Object.keys(EXPECTED)) {
    const provider = createProvider(configFor(id));
    assert.equal(provider.id, id, `createProvider(${id})`);
    assert.equal(typeof provider.chat, 'function');
    assert.equal(typeof provider.listModels, 'function');
  }
  assert.throws(() => createProvider({ id: 'no-such-provider', label: 'x', defaultModel: '' }), /Không rõ provider id/);
});

test('v097 providers: createProvider respects a user-overridden baseUrl/model', async () => {
  let seenUrl;
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url);
    assert.equal(JSON.parse(opts.body).model, 'my-custom-model');
    return fakeChatResponse();
  };
  const provider = createProvider({
    ...configFor('groq'),
    baseUrl: 'https://my-proxy.example/v1',
    defaultModel: 'my-custom-model',
  });
  await provider.chat(chatReq('my-custom-model'));
  assert.equal(seenUrl, 'https://my-proxy.example/v1/chat/completions');
});

// ---------------------------------------------------------------------------
// Presets: moonshot + cohere added, deepseek default fixed
// ---------------------------------------------------------------------------

test('v097 presets: 12 presets, moonshot + cohere resolve to the dedicated endpoints', () => {
  assert.equal(COMPATIBLE_PRESETS.length, 12);
  assert.equal(listCompatiblePresets().length, 12);
  const ids = COMPATIBLE_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(resolvePreset('moonshot'), {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
  });
  assert.deepEqual(resolvePreset('cohere'), {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-03-2025',
  });
  // Existing presets keep their endpoints; deepseek's default moved to
  // the current V4 model (deepseek-chat was retired 2026-07-24).
  assert.equal(resolvePreset('deepseek')?.defaultModel, 'deepseek-v4-flash');
  assert.equal(resolvePreset('qwen')?.defaultModel, 'qwen-plus');
  assert.equal(resolvePreset('mistral')?.defaultModel, 'mistral-small-latest');
  assert.equal(resolvePreset('groq')?.defaultModel, 'llama-3.3-70b-versatile');
  assert.equal(resolvePreset('together')?.defaultModel, 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
  assert.equal(resolvePreset('nope'), undefined);
});

// ---------------------------------------------------------------------------
// Model registry: catalogue + fallback per new provider
// ---------------------------------------------------------------------------

test('v097 model registry: catalogue lists all 7 providers with their known models', () => {
  const registry = new ModelRegistry();
  const snapshot = registry.snapshot();
  for (const [id, [, , defaultModel, known]] of Object.entries(EXPECTED)) {
    const entry = snapshot.providers[id];
    assert.ok(entry, `registry catalogue missing ${id}`);
    assert.equal(entry.defaultModel, defaultModel, `${id} catalogue default`);
    assert.ok(entry.fallbackModel && entry.fallbackModel.length > 0, `${id} needs a fallback model`);
    for (const model of known) {
      assert.ok(
        entry.models.some((m) => m.id === model),
        `${id} catalogue must list known model ${model}`,
      );
    }
  }
});
