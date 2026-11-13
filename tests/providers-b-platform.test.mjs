/**
 * B-platform M3 tests: 4 preset OpenAI-compatible mới (Cerebras,
 * Fireworks, SambaNova, Google AI Studio), Ollama listLocalModelInfo +
 * OLLAMA_KNOWN_MODELS mới, ModelRegistry.setDiscoveredModels.
 *
 * Ollama dùng fetch giả (không gọi server thật, không cần Ollama chạy).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COMPATIBLE_PRESETS, listCompatiblePresets, resolvePreset } from '../packages/core/dist/models/presets.js';
import { OLLAMA_KNOWN_MODELS, OllamaProvider } from '../packages/core/dist/providers/ollama.js';
import { ModelRegistry } from '../packages/core/dist/models/registry.js';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test('M3 presets: 12 preset (6 cũ + 6 mới), id duy nhất, baseUrl https', () => {
  assert.equal(COMPATIBLE_PRESETS.length, 12);
  const ids = COMPATIBLE_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of COMPATIBLE_PRESETS) {
    assert.ok(p.baseUrl.startsWith('https://'), `${p.id} baseUrl phải https`);
    assert.ok(p.defaultModel.trim().length > 0, `${p.id} cần defaultModel`);
  }
  // 6 preset cũ còn nguyên, không đổi — trừ default của deepseek:
  // deepseek-chat đã bị gỡ 2026-07-24 (v0.97: -> deepseek-v4-flash).
  assert.equal(resolvePreset('deepseek')?.defaultModel, 'deepseek-v4-flash');
  assert.equal(resolvePreset('openrouter')?.defaultModel, 'openrouter/auto');
});

test('M3 presets: 4 preset mới đúng baseUrl + defaultModel đã kiểm chứng', () => {
  const expected = {
    cerebras: ['https://api.cerebras.ai/v1', 'gpt-oss-120b'],
    fireworks: ['https://api.fireworks.ai/inference/v1', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    sambanova: ['https://api.sambanova.ai/v1', 'Meta-Llama-3.3-70B-Instruct'],
    'google-ai-studio': ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'],
  };
  for (const [id, [baseUrl, defaultModel]] of Object.entries(expected)) {
    const preset = resolvePreset(id);
    assert.ok(preset, `thiếu preset ${id}`);
    assert.equal(preset.baseUrl, baseUrl);
    assert.equal(preset.defaultModel, defaultModel);
  }
  // resolvePreset/listCompatiblePresets trả bản sao — sửa ngoài không làm hỏng preset gốc.
  const copy = resolvePreset('cerebras');
  copy.defaultModel = 'x';
  assert.equal(resolvePreset('cerebras')?.defaultModel, 'gpt-oss-120b');
  assert.equal(listCompatiblePresets().length, 12);
});

// ---------------------------------------------------------------------------
// Ollama: known models + listLocalModelInfo (fetch giả)
// ---------------------------------------------------------------------------

test('M3 ollama: OLLAMA_KNOWN_MODELS có qwen3 + llama3.3', () => {
  assert.ok(OLLAMA_KNOWN_MODELS.includes('qwen3'));
  assert.ok(OLLAMA_KNOWN_MODELS.includes('llama3.3'));
  assert.ok(OLLAMA_KNOWN_MODELS.includes('llama3.1'));
});

function withFakeTagsResponse(body, status = 200) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return new Response(JSON.stringify(body), { status });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

test('M3 ollama listLocalModelInfo: parse đầy đủ field từ /api/tags', async () => {
  const restore = withFakeTagsResponse({
    models: [
      {
        name: 'qwen2.5:0.5b',
        size: 397_000_000,
        modified_at: '2026-11-09T10:00:00Z',
        details: { parameter_size: '0.5B', quantization_level: 'Q4_K_M', family: 'qwen2' },
      },
      { name: 'llama3.1:8b', details: { family: 'llama' } },
      { name: '', details: {} },
      { details: { family: 'x' } },
    ],
  });
  try {
    const provider = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
    const infos = await provider.listLocalModelInfo();
    assert.equal(infos.length, 2);
    assert.deepEqual(infos[0], {
      name: 'qwen2.5:0.5b',
      size: 397_000_000,
      modifiedAt: '2026-11-09T10:00:00Z',
      parameterSize: '0.5B',
      quantizationLevel: 'Q4_K_M',
      family: 'qwen2',
    });
    assert.deepEqual(infos[1], { name: 'llama3.1:8b', family: 'llama' });
    // listLocalModels vẫn chỉ trả tên, qua cùng một nguồn dữ liệu.
    assert.deepEqual(await provider.listLocalModels(), ['qwen2.5:0.5b', 'llama3.1:8b']);
  } finally {
    restore();
  }
});

test('M3 ollama listLocalModelInfo: HTTP lỗi / fetch lỗi → []', async () => {
  const provider = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  let restore = withFakeTagsResponse({ models: [] }, 500);
  try {
    assert.deepEqual(await provider.listLocalModelInfo(), []);
    assert.deepEqual(await provider.listLocalModels(), []);
  } finally {
    restore();
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    assert.deepEqual(await provider.listLocalModelInfo(), []);
    assert.deepEqual(await provider.listLocalModels(), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// ModelRegistry.setDiscoveredModels
// ---------------------------------------------------------------------------

function ollamaModels(registry) {
  return registry.snapshot().providers['ollama'].models;
}

function openaiCompatModels(registry) {
  return registry.snapshot().providers['openai-compatible'].models;
}

test('M3 registry: preset mới hiện trong catalogue openai-compatible với nhãn preset', () => {
  const registry = new ModelRegistry();
  const models = openaiCompatModels(registry);
  const byId = new Map(models.map((m) => [m.id, m.label]));
  assert.equal(byId.get('gpt-oss-120b'), 'gpt-oss-120b (Cerebras)');
  assert.equal(
    byId.get('accounts/fireworks/models/llama-v3p3-70b-instruct'),
    'accounts/fireworks/models/llama-v3p3-70b-instruct (Fireworks AI)',
  );
  assert.equal(byId.get('Meta-Llama-3.3-70B-Instruct'), 'Meta-Llama-3.3-70B-Instruct (SambaNova)');
  assert.equal(byId.get('gemini-2.5-flash'), 'gemini-2.5-flash (Google AI Studio)');
});

test('M3 registry setDiscoveredModels: gộp model local, nhãn (local), gọi lại thay thế', () => {
  const registry = new ModelRegistry();
  registry.setDiscoveredModels('ollama', ['qwen2.5:0.5b', 'my-model:1b']);
  let models = ollamaModels(registry);
  const byId = new Map(models.map((m) => [m.id, m.label]));
  assert.equal(byId.get('qwen2.5:0.5b'), 'qwen2.5:0.5b (local)');
  assert.equal(byId.get('my-model:1b'), 'my-model:1b (local)');
  // Model biết trước nhưng chưa pull thì giữ nguyên nhãn.
  assert.equal(byId.get('qwen2.5'), 'qwen2.5');

  // Gọi lại: thay thế, không cộng dồn.
  registry.setDiscoveredModels('ollama', ['other:2b']);
  models = ollamaModels(registry);
  const ids = models.map((m) => m.id);
  assert.ok(!ids.includes('my-model:1b'));
  assert.ok(ids.includes('other:2b'));
  assert.equal(new Map(models.map((m) => [m.id, m.label])).get('other:2b'), 'other:2b (local)');

  // Danh sách rỗng: xoá hết discovered (chỉ còn nhãn (local) mặc định
  // của chính catalogue cho qwen2.5:0.5b — đó là nhãn built-in, không phải discovered).
  registry.setDiscoveredModels('ollama', []);
  models = ollamaModels(registry);
  assert.ok(!models.map((m) => m.id).includes('other:2b'));
  assert.equal(new Map(models.map((m) => [m.id, m.label])).get('qwen2.5:0.5b'), 'qwen2.5:0.5b (local)');
});

test('M3 registry setDiscoveredModels: provider lạ throw; tên rỗng/trùng được lọc', () => {
  const registry = new ModelRegistry();
  assert.throws(() => registry.setDiscoveredModels('nope', ['a:1']), /provider không rõ/);
  registry.setDiscoveredModels('ollama', ['  ', 'dup:1b', 'dup:1b', ' ok:1b ']);
  const ids = ollamaModels(registry).map((m) => m.id);
  assert.ok(ids.includes('dup:1b'));
  assert.ok(ids.includes('ok:1b'));
  assert.equal(ids.filter((id) => id === 'dup:1b').length, 1);
});

test('M3 registry setDiscoveredModels: KHÔNG ghi vào models.json, load() không xoá discovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-models-m3-'));
  try {
    const filePath = path.join(dir, 'models.json');
    const registry = new ModelRegistry({ filePath });
    registry.setDiscoveredModels('ollama', ['my-model:1b']);
    registry.save();
    const saved = fs.readFileSync(filePath, 'utf8');
    assert.ok(!saved.includes('my-model:1b'), 'discovered không được ghi vào models.json');

    // Registry mới load từ cùng file: không thấy model discovered.
    const reloaded = new ModelRegistry({ filePath });
    reloaded.load();
    assert.ok(!ollamaModels(reloaded).map((m) => m.id).includes('my-model:1b'));

    // load() trên cùng registry không xoá discovered đang có.
    registry.load();
    assert.ok(ollamaModels(registry).map((m) => m.id).includes('my-model:1b'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
