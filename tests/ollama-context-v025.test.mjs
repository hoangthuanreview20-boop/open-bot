/**
 * Tests for v0.26 (W19a): Ollama local đo context thật của model.
 *   packages/core/src/providers/ollama.ts
 *     (`OllamaProvider.getContextLimit`, `ollamaEffectiveContextLimit`)
 *   packages/core/src/coordinator/coordinator.ts
 *     (`contextLimitForModel` + `measuredOllamaContextLimit` ở executeRun)
 *
 * Gap (ghi chú v0.22/v0.24 trong docs/BEYOND-ROADMAP.md): model local mà
 * tên không ghi rõ context (vd `qwen2.5:0.5b` — thực tế Ollama mặc định
 * 4k) vẫn được `contextLimitForModel` tính là 32k, nên small-model
 * guard không kích hoạt khi cần; muốn chắc chắn phải truyền
 * `contextLimit` tường minh hoặc đặt tên model có hậu tố context.
 * Giờ Ollama provider tự đo context thật qua `POST /api/show` rồi dùng
 * làm giới hạn — thứ tự ưu tiên: tường minh (tên ghi rõ context) >
 * tên model > Ollama đo được > mặc định theo họ.
 *
 * Nghiên cứu bằng Ollama thật (server 0.40.15 local, xem comment trong
 * `ollamaEffectiveContextLimit`): `model_info` chứa context HUẤN LUYỆN
 * tối đa (`qwen2.context_length: 32768` với qwen2.5:0.5b) — là TRẦN,
 * không phải context chạy thật; `parameters` (chuỗi Modelfile) có dòng
 * `num_ctx N` thì chạy với N; không có thì server dùng default 4096
 * (log khởi động: `default_num_ctx=4096`). Modelfile mặc định của
 * `qwen2.5:0.5b` KHÔNG set `num_ctx` → hiệu dụng 4096.
 *
 * Phần lớn test dùng stub fetch trả đúng shape `/api/show` (không mạng,
 * không cần Ollama chạy); 1 test live dùng Ollama local thật nếu đang
 * chạy và đã có model `qwen2.5:0.5b`, còn không thì skip — không fail
 * khi Ollama chưa được cài/pull.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/ollama-context-v025.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS,
  OllamaProvider,
  ollamaEffectiveContextLimit,
} from '../packages/core/dist/providers/ollama.js';
import { contextLimitForModel } from '../packages/core/dist/coordinator/coordinator.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';

const OLLAMA_CONFIG = { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' };
const OLLAMA_NATIVE = 'http://localhost:11434';

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

/** Shape `/api/show` thật của `qwen2.5:0.5b` (đo ngày 2026-11-09, server 0.40.15). */
function showQwen05b(overrides = {}) {
  return {
    modelfile: '# Modelfile created by "ollama show --modelfile"\nFROM qwen2.5:0.5b\n',
    // Response thật KHÔNG có key `parameters` (Modelfile mặc định không
    // set gì thêm) — xem ghi chú nghiên cứu ở đầu file.
    template: '{{ .Prompt }}',
    details: { format: 'gguf', family: 'qwen2', parameter_size: '494M' },
    model_info: {
      'general.architecture': 'qwen2',
      'general.file_type': 15,
      'qwen2.context_length': 32768,
      'qwen2.embedding_length': 896,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ollamaEffectiveContextLimit: parse đúng shape /api/show
// ---------------------------------------------------------------------------

test('parse /api/show: qwen2.5:0.5b thật — trần huấn luyện 32768 nhưng hiệu dụng 4096 (default Ollama)', () => {
  assert.equal(ollamaEffectiveContextLimit(showQwen05b()), 4096);
});

test('parse /api/show: num_ctx trong Modelfile thắng default, kẹp bởi trần huấn luyện', () => {
  // num_ctx 8192 < trần 32768 → 8192.
  assert.equal(
    ollamaEffectiveContextLimit(showQwen05b({ parameters: 'num_ctx 8192\nstop "x"' })),
    8192,
  );
  // num_ctx 65536 > trần 32768 → kẹp xuống 32768.
  assert.equal(
    ollamaEffectiveContextLimit(showQwen05b({ parameters: 'num_ctx 65536' })),
    32768,
  );
  // Không biết trần huấn luyện → num_ctx giữ nguyên.
  assert.equal(
    ollamaEffectiveContextLimit({ parameters: 'num_ctx 16384' }),
    16384,
  );
});

test('parse /api/show: trần huấn luyện nhỏ hơn default thì kẹp default xuống', () => {
  // Model chỉ huấn luyện 2048: chạy 4096 cũng bị kẹp xuống 2048.
  assert.equal(
    ollamaEffectiveContextLimit({ model_info: { 'llama.context_length': 2048 } }),
    2048,
  );
  // Không có model_info lẫn parameters → default 4096.
  assert.equal(ollamaEffectiveContextLimit({}), 4096);
  assert.equal(ollamaEffectiveContextLimit({ model_info: {} }), 4096);
});

test('parse /api/show: parameters không phải chuỗi / num_ctx lạ thì bỏ qua, không throw', () => {
  assert.equal(ollamaEffectiveContextLimit({ parameters: 123 }), 4096);
  assert.equal(ollamaEffectiveContextLimit({ parameters: 'num_ctx abc' }), 4096);
  assert.equal(ollamaEffectiveContextLimit({ parameters: 'num_ctx 0' }), 4096);
  assert.equal(
    ollamaEffectiveContextLimit({ model_info: { 'qwen2.context_length': '32768' } }),
    4096,
  );
  assert.equal(ollamaEffectiveContextLimit(null), 4096);
  assert.equal(ollamaEffectiveContextLimit(undefined), 4096);
});

// ---------------------------------------------------------------------------
// getContextLimit: stub fetch — đo, cache, lỗi/timeout → undefined
// ---------------------------------------------------------------------------

test('getContextLimit (stub /api/show): qwen2.5:0.5b → 4096, gọi 1 lần cho 2 lần hỏi (cache theo model)', async () => {
  let calls = 0;
  const restore = stubFetch(async (url, init) => {
    calls++;
    assert.equal(url, `${OLLAMA_NATIVE}/api/show`);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(typeof body.name, 'string');
    if (calls === 1) assert.equal(body.name, 'qwen2.5:0.5b');
    return { ok: true, status: 200, json: async () => showQwen05b() };
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), 4096);
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), 4096);
    assert.equal(calls, 1, 'lần 2 phải đọc cache, không gọi lại /api/show');
    // Model khác → đo riêng, không dùng cache của model kia.
    assert.equal(await provider.getContextLimit('llama3.1'), 4096);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('getContextLimit (stub /api/show): num_ctx trong Modelfile được dùng', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => showQwen05b({ parameters: 'num_ctx 8192' }),
  }));
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), 8192);
  } finally {
    restore();
  }
});

test('getContextLimit: Ollama không chạy (fetch throw) / model không tồn tại (404) → undefined, không throw, lần sau thử lại', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    throw new Error('fetch failed');
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), undefined);
    // Lỗi được cache ngắn: hỏi lại ngay không gọi fetch nữa.
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), undefined);
    assert.equal(calls, 1);
  } finally {
    restore();
  }

  const restore404 = stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.equal(await provider.getContextLimit('ghost-model'), undefined);
  } finally {
    restore404();
  }
});

test('getContextLimit: tên rỗng → undefined, không gọi fetch', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return { ok: true, json: async () => ({}) };
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    assert.equal(await provider.getContextLimit(''), undefined);
    assert.equal(await provider.getContextLimit('   '), undefined);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('getContextLimit: fetch treo → timeout ~5s rồi undefined, không treo run', async () => {
  const restore = stubFetch((_url, init) => {
    // Treo cho tới khi signal timeout hủy — mô phỏng Ollama đơ.
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // Không có signal thì test này không đo được timeout.
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  try {
    const provider = new OllamaProvider(OLLAMA_CONFIG);
    const started = Date.now();
    assert.equal(await provider.getContextLimit('qwen2.5:0.5b'), undefined);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS - 500,
      `phải chờ hết timeout ~${OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS}ms, thực tế ${elapsed}ms`,
    );
    assert.ok(elapsed < OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS + 5000, `không được treo quá lâu: ${elapsed}ms`);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// contextLimitForModel: thứ tự ưu tiên với số đo Ollama
// ---------------------------------------------------------------------------

test('contextLimitForModel: số đo Ollama thắng mặc định theo họ, thua tên ghi rõ context', () => {
  // qwen2.5:0.5b đo được 4096 — thắng nhánh họ qwen (32k).
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', 4096), 4096);
  // Tên ghi rõ 4k thắng cả số đo (4000 ≠ 4096 để phân biệt nguồn).
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b-4k', 4096), 4000);
  assert.equal(contextLimitForModel('ollama', 'llama-ctx8192', 4096), 8192);
  // Không có số đo → giá trị cũ (32k theo họ qwen / nhánh ollama).
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b'), 32768);
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', undefined), 32768);
  // Số đo không hợp lệ → bỏ qua như không có.
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', 0), 32768);
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', NaN), 32768);
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', -100), 32768);
  // Provider khác giữ nguyên giá trị cũ.
  assert.equal(contextLimitForModel('xai', 'grok-4.7', undefined), 262144);
  assert.equal(contextLimitForModel('openai', 'gpt-4o', undefined), 128000);
});

// ---------------------------------------------------------------------------
// Loop: contextLimit tường minh (smallModel) vẫn thắng compaction (đường coordinator)
// ---------------------------------------------------------------------------

function makeTool(name, opts = {}) {
  return {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
    needsApproval: opts.needsApproval ?? false,
    async execute() {
      return `ok:${name}`;
    },
  };
}

test('loop: smallModel.contextLimit tường minh thắng compaction.contextLimit của coordinator', async () => {
  const tools = [makeTool('read_file'), makeTool('write_file', { needsApproval: true })];
  const seen = [];
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seen.push(req);
      return { text: 'xong', toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const events = {
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onApprovalNeeded: async () => true,
  };
  // Coordinator đo được 4096 (compaction) nhưng bot set tường minh 128k
  // → guard không ép lọc, provider thấy full list.
  const runner = new AgentRunner(provider, tools, {
    bot: {
      id: 'bot-1',
      name: 'Test',
      providerId: 'mock',
      model: 'qwen2.5:0.5b',
      systemPrompt: 'You are a test bot.',
      workspaceDir: '',
      autoApprove: true,
    },
    events,
    compaction: { contextLimit: 4096 },
    smallModel: { contextLimit: 128000 },
  });
  assert.equal(await runner.run('hi'), 'xong');
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    ['read_file', 'write_file'],
    'contextLimit tường minh 128k phải thắng compaction 4096',
  );
});

// ---------------------------------------------------------------------------
// Live: Ollama local thật (skip khi không chạy / chưa pull model)
// ---------------------------------------------------------------------------

/** True khi Ollama local đang chạy và đã có model `qwen2.5:0.5b`. */
async function liveOllamaHasQwen05b() {
  try {
    const res = await fetch(`${OLLAMA_NATIVE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models ?? []).some((m) => m.name === 'qwen2.5:0.5b');
  } catch {
    return false;
  }
}

test('live: Ollama local thật — qwen2.5:0.5b đo được 4096 (skip khi Ollama không chạy)', async (t) => {
  if (!(await liveOllamaHasQwen05b())) {
    t.skip('Ollama local không chạy hoặc chưa pull qwen2.5:0.5b — bỏ qua test live');
    return;
  }
  // Ghi lại shape thật để đối chiếu với stub ở trên.
  const showRes = await fetch(`${OLLAMA_NATIVE}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'qwen2.5:0.5b' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(showRes.ok, true);
  const show = await showRes.json();
  console.log(
    'live /api/show qwen2.5:0.5b: model_info keys =',
    Object.keys(show.model_info ?? {}).filter((k) => k.endsWith('context_length')),
    '| context_length =',
    Object.entries(show.model_info ?? {})
      .filter(([k]) => k.endsWith('context_length'))
      .map(([, v]) => v),
    '| parameters =',
    JSON.stringify(show.parameters),
  );
  const provider = new OllamaProvider(OLLAMA_CONFIG);
  const limit = await provider.getContextLimit('qwen2.5:0.5b');
  console.log(`live getContextLimit('qwen2.5:0.5b') = ${limit}`);
  assert.equal(limit, 4096, 'model không set num_ctx → hiệu dụng phải là default Ollama 4096, không phải trần huấn luyện 32768');
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b', limit), 4096);
});
