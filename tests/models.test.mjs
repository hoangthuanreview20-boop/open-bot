/**
 * Tests for the v0.5 model registry + provider presets + local models
 * (packages/core/src/models/, providers/index.ts presets,
 * providers/ollama.ts pullModel/listLocalModels).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/models.test.mjs
 *
 * No real API key and no real Ollama needed: provider calls are
 * mocked by stubbing global fetch, and the registry is exercised
 * against temp-dir models.json files.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ModelRegistry,
  listCompatiblePresets,
  resolvePreset,
  COMPATIBLE_PRESETS,
} from '../packages/core/dist/models/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';
import { OllamaProvider } from '../packages/core/dist/providers/ollama.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-models-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Registry with a temp models.json path + a warning collector. */
function registryWithFile(content) {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'models.json');
  if (content !== undefined) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  const warnings = [];
  const registry = new ModelRegistry({
    filePath,
    logger: { warn: (msg) => warnings.push(msg) },
  });
  registry.load();
  return { registry, filePath, warnings };
}

const freshRegistry = () => new ModelRegistry();

// ---------------------------------------------------------------------------
// Built-in catalogue / defaults
// ---------------------------------------------------------------------------

test('registry defaults: catalogue, default and fallback per provider', () => {
  const registry = freshRegistry();

  const xaiIds = registry.listModels('xai').map((m) => m.id);
  assert.ok(xaiIds.includes('grok-4.7'), 'xai catalogue must include grok-4.7');
  assert.ok(xaiIds.includes('grok-4.6'), 'xai catalogue must include priced grok-4.6');
  assert.ok(xaiIds.includes('grok-3'), 'xai catalogue must include known grok-3');
  assert.equal(registry.getDefault('xai'), 'grok-4.7');
  assert.equal(registry.getFallback('xai'), 'grok-4.1-fast');

  assert.equal(registry.getDefault('openai'), 'gpt-5-mini');
  assert.equal(registry.getFallback('openai'), 'gpt-5-nano');
  assert.ok(registry.listModels('openai').some((m) => m.id === 'gpt-4o'));

  assert.equal(registry.getDefault('anthropic'), 'claude-sonnet-4-5');
  assert.equal(registry.getFallback('anthropic'), 'claude-haiku-4-5');

  assert.equal(registry.getDefault('gemini'), 'gemini-2.5-flash');
  assert.equal(registry.getFallback('gemini'), 'gemini-2.5-flash-lite');
  // Catalogue Gemini cập nhật 2026-11-09 từ live list-models (50 models):
  // bỏ gemini-2.0-flash (không còn trong live list), thêm model 3.x ổn
  // định + alias -latest + preview (nhãn "(preview)").
  const geminiIds = registry.listModels('gemini').map((m) => m.id);
  for (const id of [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-4-argon',
  ]) {
    assert.ok(geminiIds.includes(id), `gemini catalogue must include ${id}`);
  }
  assert.ok(!geminiIds.includes('gemini-2.0-flash'), 'gemini-2.0-flash left the live list');
  const geminiById = new Map(registry.listModels('gemini').map((m) => [m.id, m.label]));
  assert.equal(geminiById.get('gemini-3-flash-preview'), 'gemini-3-flash-preview (preview)');
  assert.equal(geminiById.get('gemini-4-argon'), 'gemini-4-argon (preview)');
  assert.equal(geminiById.get('gemini-3.5-flash'), 'gemini-3.5-flash');

  assert.equal(registry.getDefault('ollama'), 'llama3.1');
  assert.ok(registry.listModels('ollama').some((m) => m.id === 'qwen2.5:0.5b'));

  // openai-compatible has no single default; its catalogue is the presets.
  assert.equal(registry.getDefault('openai-compatible'), '');
  const compatIds = registry.listModels('openai-compatible').map((m) => m.id);
  // v0.97: deepseek-chat was retired by DeepSeek (2026-07-24) — the
  // catalogue now lists deepseek-v4-flash as the default instead.
  assert.ok(compatIds.includes('deepseek-v4-flash'));
  assert.ok(compatIds.includes('openrouter/auto'));

  // Unknown provider is a loud error, not a silent empty list.
  assert.throws(() => registry.listModels('nope'), /không rõ provider/);
  assert.throws(() => registry.getDefault('nope'), /không rõ provider/);
});

test('snapshot matches the IPC models:list shape', () => {
  const snap = freshRegistry().snapshot();
  assert.deepEqual(Object.keys(snap.providers).sort(), [
    'aider',
    'amazon-q',
    'anthropic',
    'claude-code',
    'codex',
    'cohere', // v0.97 (Team T6): dedicated provider
    'continue-cli',
    'copilot-cli',
    'cursor-cli',
    'custom-acp',
    'deepseek', // v0.97 (Team T6): dedicated provider
    'gemini',
    'gemini-cli',
    'grok-cli',
    'groq', // v0.97 (Team T6): dedicated provider
    'kiro-cli',
    'mistral', // v0.97 (Team T6): dedicated provider
    'moonshot', // v0.97 (Team T6): dedicated provider
    'ollama',
    'openai',
    'openai-compatible',
    'opencode',
    'qwen', // v0.97 (Team T6): dedicated provider
    'together', // v0.97 (Team T6): dedicated provider
    'windsurf',
    'xai',
  ]);
  assert.equal(snap.providers.xai.defaultModel, 'grok-4.7');
  assert.equal(snap.providers.xai.fallbackModel, 'grok-4.1-fast');
  assert.deepEqual(snap.providers.xai.features, {});
  // M1: CLI provider — single model, fallback is itself.
  assert.deepEqual(snap.providers['claude-code'].models, [{ id: 'claude-code', label: 'claude-code' }]);
  // M2: CLI provider Codex / Grok — single model each, fallback is itself.
  assert.deepEqual(snap.providers['codex'].models, [{ id: 'codex', label: 'codex' }]);
  assert.deepEqual(snap.providers['grok-cli'].models, [{ id: 'grok-cli', label: 'grok-cli' }]);
  // M3: CLI provider OpenCode / Gemini CLI / Cursor CLI / Custom ACP —
  // single model each, fallback is itself (custom-acp: model is the slug).
  assert.deepEqual(snap.providers['opencode'].models, [{ id: 'opencode', label: 'opencode' }]);
  assert.deepEqual(snap.providers['gemini-cli'].models, [{ id: 'gemini-cli', label: 'gemini-cli' }]);
  assert.deepEqual(snap.providers['cursor-cli'].models, [{ id: 'cursor-cli', label: 'cursor-cli' }]);
  assert.deepEqual(snap.providers['custom-acp'].models, [{ id: 'custom-acp', label: 'custom-acp' }]);
  // M4 (sóng B): CLI provider Aider / Continue / Amazon Q / Copilot /
  // Windsurf — single model each, fallback is itself.
  assert.deepEqual(snap.providers['aider'].models, [{ id: 'aider', label: 'aider' }]);
  assert.deepEqual(snap.providers['continue-cli'].models, [{ id: 'continue-cli', label: 'continue-cli' }]);
  assert.deepEqual(snap.providers['amazon-q'].models, [{ id: 'amazon-q', label: 'amazon-q' }]);
  assert.deepEqual(snap.providers['copilot-cli'].models, [{ id: 'copilot-cli', label: 'copilot-cli' }]);
  assert.deepEqual(snap.providers['windsurf'].models, [{ id: 'windsurf', label: 'windsurf' }]);
  assert.equal(snap.providers['opencode'].defaultModel, 'opencode');
  assert.equal(snap.providers['custom-acp'].fallbackModel, 'custom-acp');
  assert.equal(snap.providers['claude-code'].defaultModel, 'claude-code');
  assert.equal(snap.providers['claude-code'].fallbackModel, 'claude-code');
  assert.equal(snap.featureFlags.voice, true);
  assert.equal(snap.featureFlags.vision, false);
});

// ---------------------------------------------------------------------------
// User overrides: merge
// ---------------------------------------------------------------------------

test('user overrides merge: extra model, label override, custom default/fallback', () => {
  const { registry } = registryWithFile(
    JSON.stringify({
      providers: {
        xai: {
          models: [
            { id: 'grok-4.7', label: 'Grok 4.7 (mặc định)' },
            { id: 'grok-custom-1', label: 'Grok tuỳ chỉnh' },
          ],
          defaultModel: 'grok-4.6',
          fallbackModel: 'grok-4.3',
        },
      },
    }),
  );

  const models = registry.listModels('xai');
  // Same id replaces the label, never duplicates.
  assert.equal(models.filter((m) => m.id === 'grok-4.7').length, 1);
  assert.equal(models.find((m) => m.id === 'grok-4.7').label, 'Grok 4.7 (mặc định)');
  // Built-ins survive alongside the user model.
  assert.ok(models.some((m) => m.id === 'grok-4.5'));
  assert.ok(models.some((m) => m.id === 'grok-custom-1'));
  assert.equal(registry.getDefault('xai'), 'grok-4.6');
  assert.equal(registry.getFallback('xai'), 'grok-4.3');
  // Other providers are untouched.
  assert.equal(registry.getDefault('openai'), 'gpt-5-mini');
});

test('user overrides: unknown provider is ignored with a warning', () => {
  const { registry, warnings } = registryWithFile(
    JSON.stringify({ providers: { 'not-a-provider': { defaultModel: 'x' } } }),
  );
  assert.equal(registry.getDefault('xai'), 'grok-4.7');
  assert.ok(warnings.some((w) => /not-a-provider/.test(w)), `expected warning, got: ${warnings}`);
});

test('setDefault/setFallback auto-register an unknown model id', () => {
  const registry = freshRegistry();
  registry.setDefault('ollama', 'llama3.2:3b');
  assert.equal(registry.getDefault('ollama'), 'llama3.2:3b');
  assert.ok(registry.listModels('ollama').some((m) => m.id === 'llama3.2:3b'));
  assert.throws(() => registry.setDefault('nope', 'x'), /không rõ provider/);
  assert.throws(() => registry.setDefault('xai', ''), /không rỗng/);
});

// ---------------------------------------------------------------------------
// Per-feature models
// ---------------------------------------------------------------------------

test('feature model falls back to the provider default when unset', () => {
  const registry = freshRegistry();

  // No provider given: first provider with a default (openai, registry order).
  assert.deepEqual(registry.getModelForFeature('chat'), {
    providerId: 'openai',
    model: 'gpt-5-mini',
  });
  // Provider given, feature unset: that provider's default.
  assert.deepEqual(registry.getModelForFeature('voice', 'ollama'), {
    providerId: 'ollama',
    model: 'llama3.1',
  });
  assert.equal(registry.getFeatureModel('code', 'xai'), undefined);

  registry.setFeatureModel('code', 'xai', 'grok-4.7');
  assert.deepEqual(registry.getModelForFeature('code', 'xai'), {
    providerId: 'xai',
    model: 'grok-4.7',
  });
  // Without a provider, the explicit assignment is found.
  assert.deepEqual(registry.getModelForFeature('code'), {
    providerId: 'xai',
    model: 'grok-4.7',
  });
  assert.equal(registry.getFeatureModel('code', 'xai'), 'grok-4.7');

  // A feature model for a local model not in the built-in catalogue works.
  registry.setFeatureModel('chat', 'ollama', 'qwen2.5:0.5b');
  assert.deepEqual(registry.getModelForFeature('chat', 'ollama'), {
    providerId: 'ollama',
    model: 'qwen2.5:0.5b',
  });
  assert.throws(() => registry.setFeatureModel('code', 'nope', 'x'), /không rõ provider/);
  assert.throws(() => registry.setFeatureModel('', 'xai', 'grok-4.7'), /không rỗng/);
});

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

test('feature flags: built-in defaults, enable/disable, unknown defaults false', () => {
  const registry = freshRegistry();
  assert.equal(registry.getFeatureFlag('voice'), true);
  assert.equal(registry.isFeatureEnabled('voice'), true);
  assert.equal(registry.getFeatureFlag('vision'), false);
  assert.equal(registry.getFeatureFlag('long-context'), false);
  assert.equal(registry.getFeatureFlag('never-mentioned'), false);

  registry.setFeatureFlag('vision', true);
  assert.equal(registry.getFeatureFlag('vision'), true);
  registry.setFeatureFlag('vision', false);
  assert.equal(registry.getFeatureFlag('vision'), false);
  registry.setFeatureFlag('beta-thing', true);
  assert.equal(registry.getFeatureFlag('beta-thing'), true);
  assert.throws(() => registry.setFeatureFlag('vision', 'yes'), /boolean/);
});

// ---------------------------------------------------------------------------
// Corrupt file + save/load round-trip
// ---------------------------------------------------------------------------

test('corrupt models.json does not crash: built-ins + warning', () => {
  const { registry, warnings } = registryWithFile('{ not json,,,');
  assert.equal(registry.getDefault('xai'), 'grok-4.7');
  assert.ok(registry.listModels('xai').some((m) => m.id === 'grok-4.7'));
  assert.ok(warnings.length >= 1, 'a warning must be logged');
  assert.ok(/không phải JSON/.test(warnings[0]), `unexpected warning: ${warnings[0]}`);
});

test('corrupt entries inside models.json are skipped, good entries kept', () => {
  const { registry, warnings } = registryWithFile(
    JSON.stringify({
      providers: {
        xai: { models: [{ id: '' }, { id: 'grok-extra' }], defaultModel: 42 },
        openai: { defaultModel: 'gpt-5' },
      },
      featureFlags: { vision: 'yes', voice: false },
    }),
  );
  assert.ok(registry.listModels('xai').some((m) => m.id === 'grok-extra'));
  assert.equal(registry.getDefault('xai'), 'grok-4.7'); // bad default ignored
  assert.equal(registry.getDefault('openai'), 'gpt-5');
  assert.equal(registry.getFeatureFlag('voice'), false);
  assert.equal(registry.getFeatureFlag('vision'), false); // bad flag ignored
  assert.ok(warnings.length >= 2);
});

test('missing models.json means built-ins only, no error', () => {
  const { registry, warnings } = registryWithFile(undefined);
  assert.equal(registry.getDefault('xai'), 'grok-4.7');
  assert.deepEqual(warnings, []);
});

test('save/load round-trip persists only the user delta', () => {
  const { registry, filePath } = registryWithFile(undefined);
  registry.setDefault('xai', 'grok-4.6');
  registry.setFeatureModel('code', 'xai', 'grok-4.7');
  registry.setFeatureFlag('vision', true);
  registry.save();

  const saved = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(saved);
  // Only the delta is stored: no built-in-only model id may appear.
  assert.ok(!saved.includes('grok-4.5'), 'built-in grok-4.5 must not be persisted');
  assert.equal(parsed.providers.xai.defaultModel, 'grok-4.6');
  assert.equal(parsed.providers.xai.features.code, 'grok-4.7');
  assert.equal(parsed.featureFlags.vision, true);

  const reloaded = new ModelRegistry({ filePath });
  reloaded.load();
  assert.equal(reloaded.getDefault('xai'), 'grok-4.6');
  assert.equal(reloaded.getFeatureModel('code', 'xai'), 'grok-4.7');
  assert.equal(reloaded.getFeatureFlag('vision'), true);
  assert.equal(reloaded.getDefault('openai'), 'gpt-5-mini');
});

test('save without a filePath throws', () => {
  assert.throws(() => freshRegistry().save(), /filePath/);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test('compatible presets: all 12 with exact baseUrl + defaultModel', () => {
  const expected = {
    // v0.97: deepseek-chat retired 2026-07-24 -> deepseek-v4-flash.
    deepseek: ['https://api.deepseek.com/v1', 'deepseek-v4-flash'],
    // v0.97 (Team T6): dedicated Moonshot/Kimi + Cohere presets.
    moonshot: ['https://api.moonshot.ai/v1', 'kimi-k3'],
    cohere: ['https://api.cohere.ai/compatibility/v1', 'command-a-03-2025'],
    qwen: ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    mistral: ['https://api.mistral.ai/v1', 'mistral-small-latest'],
    together: ['https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    groq: ['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
    openrouter: ['https://openrouter.ai/api/v1', 'openrouter/auto'],
    // B-platform M3 (thêm 4 preset; model mặc định đã kiểm chứng 2026-11-10).
    cerebras: ['https://api.cerebras.ai/v1', 'gpt-oss-120b'],
    fireworks: ['https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    sambanova: ['https://api.sambanova.ai/v1', 'Meta-Llama-3.3-70B-Instruct'],
    'google-ai-studio': ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'],
  };
  assert.equal(COMPATIBLE_PRESETS.length, 12);
  assert.equal(listCompatiblePresets().length, 12);
  for (const [id, [baseUrl, defaultModel]] of Object.entries(expected)) {
    const preset = resolvePreset(id);
    assert.ok(preset, `missing preset ${id}`);
    assert.equal(preset.baseUrl, baseUrl, `baseUrl of ${id}`);
    assert.equal(preset.defaultModel, defaultModel, `defaultModel of ${id}`);
    assert.ok(preset.label.length > 0);
  }
  assert.equal(resolvePreset('groq').defaultModel, 'llama-3.3-70b-versatile');
  assert.equal(resolvePreset('unknown-provider'), undefined);
  // listCompatiblePresets returns copies: mutating one must not poison the next call.
  const first = listCompatiblePresets();
  first[0].baseUrl = 'https://evil.example';
  assert.notEqual(listCompatiblePresets()[0].baseUrl, 'https://evil.example');
});

test('PROVIDERS meta exposes the presets on openai-compatible', () => {
  const meta = PROVIDERS.find((p) => p.id === 'openai-compatible');
  assert.ok(meta);
  assert.equal(meta.presets.length, 12);
  assert.deepEqual(
    meta.presets.map((p) => p.id),
    ['deepseek', 'moonshot', 'qwen', 'mistral', 'together', 'groq', 'cohere', 'openrouter', 'cerebras', 'fireworks', 'sambanova', 'google-ai-studio'],
  );
  assert.equal(PROVIDERS.find((p) => p.id === 'openai').presets, undefined);
});

// ---------------------------------------------------------------------------
// Ollama: pullModel + listLocalModels (mock fetch)
// ---------------------------------------------------------------------------

const OLLAMA_CONFIG = { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' };

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

/** Fake streaming body: getReader yields the given text chunks, then done. */
function streamingBody(text) {
  const chunks = [new TextEncoder().encode(text)];
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  };
}

test('pullModel posts to /api/pull, reads NDJSON progress, resolves on success', async () => {
  const seen = [];
  const restore = stubFetch(async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      body: streamingBody(
        '{"status":"pulling manifest"}\n' +
          '{"status":"pulling 1234","completed":10,"total":100}\n' +
          '{"status":"verifying sha256 digest"}\n' +
          '{"status":"success"}\n',
      ),
    };
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    await provider.pullModel('qwen2.5:0.5b');
  } finally {
    restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://localhost:11434/api/pull');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].init.body), { name: 'qwen2.5:0.5b', stream: true });
});

test('pullModel throws when an NDJSON line reports an error', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      '{"status":"pulling manifest"}\n{"status":"error","error":"model not found"}\n',
  }));
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    await assert.rejects(provider.pullModel('no-such-model'), /model not found/);
  } finally {
    restore();
  }
});

test('pullModel throws on HTTP error and on empty model name', async () => {
  const restore = stubFetch(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => 'model not found',
  }));
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    await assert.rejects(provider.pullModel('ghost'), /HTTP 404/);
  } finally {
    restore();
  }
  const provider = new OllamaProvider(OLLAMA_CONFIG);
  await assert.rejects(provider.pullModel(''), /không rỗng/);
  await assert.rejects(provider.pullModel('   '), /không rỗng/);
});

test('listLocalModels reads /api/tags and returns [] when Ollama is down', async () => {
  let restore = stubFetch(async (url) => {
    assert.equal(url, 'http://localhost:11434/api/tags');
    return {
      ok: true,
      json: async () => ({ models: [{ name: 'qwen2.5:0.5b' }, { name: 'llama3.1' }, {}] }),
    };
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.deepEqual(await provider.listLocalModels(), ['qwen2.5:0.5b', 'llama3.1']);
  } finally {
    restore();
  }

  restore = stubFetch(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.deepEqual(await provider.listLocalModels(), []);
  } finally {
    restore();
  }
});
