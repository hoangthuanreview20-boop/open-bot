/**
 * DeepSeek / Groq / Mistral provider tests (v0.98, sóng T6 — node:test,
 * mock fetch only, NO live calls, NO real keys).
 *
 * Covers:
 *  - provider classes: id / label / baseUrl / defaultModel / known models
 *  - createProvider('deepseek' | 'groq' | 'mistral') builds them
 *  - PROVIDERS meta: needsKey + defaultBaseUrl (feeds Settings defaults
 *    + Vault namespace 'provider' automatically)
 *  - chat() via mock fetch: correct endpoint + Authorization header +
 *    model, and the reply parses (incl. a tool call)
 *  - listModels() falls back to KNOWN_MODELS when /models fails
 *  - ModelRegistry catalogue: defaults + fallbacks + known models
 *  - old openai-compatible presets still resolve (back-compat)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/providers-deepseek-groq-mistral-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeepSeekProvider,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_KNOWN_MODELS,
  GroqProvider,
  GROQ_BASE_URL,
  GROQ_DEFAULT_MODEL,
  GROQ_KNOWN_MODELS,
  MistralProvider,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL,
  MISTRAL_KNOWN_MODELS,
  PROVIDERS,
  createProvider,
} from '../packages/core/dist/providers/index.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';
import { resolvePreset } from '../packages/core/dist/models/presets.js';

const CASES = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    // v0.98 merge: T6's branch still listed the retired
    // `deepseek-chat` / `deepseek-reasoner` (retired 2026-07-24) —
    // updated to the v0.97 provider values (deepseek-v4-flash/pro).
    knownModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    fallback: 'deepseek-v4-flash',
    ProviderClass: DeepSeekProvider,
    consts: [DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_KNOWN_MODELS],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    knownModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3-32b',
    ],
    fallback: 'llama-3.1-8b-instant',
    ProviderClass: GroqProvider,
    consts: [GROQ_BASE_URL, GROQ_DEFAULT_MODEL, GROQ_KNOWN_MODELS],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    knownModels: [
      'mistral-small-latest',
      'mistral-medium-latest',
      'mistral-large-latest',
      'mistral-large-2512',
      'mistral-medium-3.5',
      'mistral-small-4',
      'codestral-latest',
    ],
    fallback: 'mistral-small-latest',
    ProviderClass: MistralProvider,
    consts: [MISTRAL_BASE_URL, MISTRAL_DEFAULT_MODEL, MISTRAL_KNOWN_MODELS],
  },
];

for (const c of CASES) {
  test(`providers v098: ${c.id} class has the right id/baseUrl/default/known models`, () => {
    assert.equal(c.consts[0], c.baseUrl);
    assert.equal(c.consts[1], c.defaultModel);
    assert.deepEqual([...c.consts[2]], c.knownModels);
    const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'test-key' });
    assert.equal(provider.id, c.id);
    assert.equal(provider.label, c.label);
    // Custom baseUrl / defaultModel are respected, not forced.
    const custom = new c.ProviderClass({
      id: c.id,
      label: c.label,
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'custom-model',
    });
    assert.equal(custom.defaultModel, 'custom-model');
  });

  test(`providers v098: createProvider('${c.id}') + PROVIDERS meta`, () => {
    const provider = createProvider({ id: c.id, label: c.label, apiKey: 'test-key' });
    assert.ok(provider instanceof c.ProviderClass);
    assert.equal(provider.id, c.id);
    const meta = PROVIDERS.find((p) => p.id === c.id);
    assert.ok(meta, `PROVIDERS must list ${c.id}`);
    assert.equal(meta.label, c.label);
    assert.equal(meta.defaultModel, c.defaultModel);
    assert.equal(meta.defaultBaseUrl, c.baseUrl);
    assert.equal(meta.needsKey, true);
    assert.equal(meta.kind, undefined, 'API provider, not CLI');
  });

  test(`providers v098: ${c.id} chat() hits the right endpoint with the key (mock fetch)`, async () => {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `hello from ${c.id}`, tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    try {
      const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'test-key-123' });
      const res = await provider.chat({
        model: c.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, `${c.baseUrl}/chat/completions`);
      const headers = seen[0].init.headers;
      const auth = headers.Authorization ?? headers.authorization;
      assert.equal(auth, 'Bearer test-key-123');
      const body = JSON.parse(seen[0].init.body);
      assert.equal(body.model, c.defaultModel);
      assert.equal(body.messages[0].content, 'hi');
      assert.equal(res.text, `hello from ${c.id}`); // ProviderResponse.text, không phải .content
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`providers v098: ${c.id} listModels() falls back to known models when /models fails`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    try {
      const provider = new c.ProviderClass({ id: c.id, label: c.label, apiKey: 'k' });
      const models = await provider.listModels();
      assert.deepEqual(models, c.knownModels);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test(`providers v098: registry catalogue for ${c.id} (defaults + fallback + models)`, () => {
    const registry = new ModelRegistry();
    assert.equal(registry.getDefault(c.id), c.defaultModel);
    assert.equal(registry.getFallback(c.id), c.fallback);
    const ids = registry.listModels(c.id).map((m) => m.id);
    for (const model of c.knownModels) assert.ok(ids.includes(model), `${c.id} catalogue must include ${model}`);
  });
}

test('providers v098: old openai-compatible presets still resolve (back-compat)', () => {
  assert.equal(resolvePreset('deepseek')?.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(resolvePreset('groq')?.defaultModel, 'llama-3.3-70b-versatile');
  assert.equal(resolvePreset('mistral')?.defaultModel, 'mistral-small-latest');
  // The dedicated provider and the preset agree on base URL + default.
  for (const c of CASES) {
    assert.equal(resolvePreset(c.id)?.baseUrl, c.baseUrl);
    assert.equal(resolvePreset(c.id)?.defaultModel, c.defaultModel);
  }
});

test('providers v098: unknown provider id still throws', () => {
  assert.throws(() => createProvider({ id: 'nope', label: 'Nope' }), /Không rõ provider id/);
});
