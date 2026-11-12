/**
 * Test P1-9 (v0.32) — embedding thật qua Ollama local cho long-term
 * memory và code tools.
 *
 * Chỉ dùng localhost (fake HTTP server 127.0.0.1 + fetch stub), không gọi
 * mạng ngoài, không cần API key, không yêu cầu Ollama thật đang chạy hay
 * model nomic-embed-text đã pull.
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/embeddings-p1-9-v032.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { OllamaProvider } from '../packages/core/dist/providers/ollama.js';
import {
  DEFAULT_EMBED_MODEL,
  EmbeddingError,
} from '../packages/core/dist/memory/embeddings.js';
import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import { CODE_TOOLS } from '../packages/tools/dist/codeTools.js';
import { createIntegrationTools } from '../packages/tools/dist/integrationTools.js';

// ---------------------------------------------------------------------------
// Helpers: thư mục tạm, fake embedder, fake Ollama HTTP server
// ---------------------------------------------------------------------------

const tempDirs = [];
const servers = [];
function makeTempDir(prefix = 'open-bot-p19-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await new Promise((r) => s.close(r));
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

async function deadPort() {
  const { server, port } = await startServer(() => {});
  await new Promise((r) => server.close(r));
  servers.pop();
  return port;
}

/**
 * Fake embedder xác định (4 chiều: db / nấu ăn / code / khác), đã chuẩn
 * hoá L2 — cosine giữa hai text cùng chủ đề = 1, khác chủ đề = 0.
 */
function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const v = [0, 0, 0, 0];
  if (/(database|sql|postgres|connection pooling)/.test(t)) v[0] += 2;
  if (/(cook|recipe|nấu|pasta|tomato)/.test(t)) v[1] += 2;
  if (/(code|typescript|function|hàm)/.test(t)) v[2] += 2;
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) v[3] = 1;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

function makeFakeEmbedder({ model = 'fake-embed', fail = false } = {}) {
  let calls = 0;
  const embedder = {
    model,
    calls: () => calls,
    async embed(text) {
      calls += 1;
      if (fail) throw new Error('fake embedder down');
      return fakeEmbed(text);
    },
    async embedBatch(texts) {
      const out = [];
      for (const t of texts) out.push(await embedder.embed(t));
      return out;
    },
  };
  return embedder;
}

/**
 * Fake Ollama server: POST /api/embeddings trả vector fake theo prompt,
 * GET /api/tags trả model giả. Đếm số lần embed để kiểm chứng cache.
 */
async function startFakeOllama({ failEmbed = false } = {}) {
  let embedCalls = 0;
  const prompts = [];
  const { port } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/embeddings') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        embedCalls += 1;
        if (failEmbed) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fake ollama down' }));
          return;
        }
        let prompt = '';
        try {
          prompt = JSON.parse(body).prompt ?? '';
        } catch {
          prompt = '';
        }
        prompts.push(prompt);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embedding: fakeEmbed(prompt) }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    embedCalls: () => embedCalls,
    prompts: () => [...prompts],
  };
}

const CTX = (workspaceDir, botId = 'bot-a') => ({ workspaceDir, botId });
const codeTool = (name) => CODE_TOOLS.find((t) => t.definition.name === name);
const integrationTool = (tools, name) => tools.find((t) => t.definition.name === name);

function seedMemories(dir) {
  const store = new LongTermMemory(dir);
  store.remember({
    key: 'db.config',
    value: 'database connection pooling with postgres',
    tags: ['infra'],
    confidence: 0.9,
    botId: 'bot-a',
  });
  store.remember({
    key: 'recipe.pasta',
    value: 'nấu pasta với sốt cà chua cho bữa tối',
    tags: ['cooking'],
    confidence: 0.8,
    botId: 'bot-a',
  });
  return store;
}

// ---------------------------------------------------------------------------
// A. OllamaProvider.embed — client embedding trong provider (P1-9, mục 1)
// ---------------------------------------------------------------------------

test('OllamaProvider.embed: mặc định model nomic-embed-text, đổi được qua constructor', () => {
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  assert.equal(p.embedModel, DEFAULT_EMBED_MODEL);
  assert.equal(DEFAULT_EMBED_MODEL, 'nomic-embed-text');
  const custom = new OllamaProvider({
    id: 'ollama',
    label: 'Ollama',
    defaultModel: 'qwen2.5:0.5b',
    embedModel: 'my-embed',
  });
  assert.equal(custom.embedModel, 'my-embed');
});

test('OllamaProvider.embed/embedBatch: trả vector từ /api/embeddings (fetch stub)', async () => {
  let seenBody = null;
  const fetchFn = async (url, init) => {
    assert.match(url, /\/api\/embeddings$/);
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ embedding: [0.6, 0.8, 0] }) };
  };
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  const vec = await p.embed('hello world', { fetchFn });
  assert.deepEqual(vec, [0.6, 0.8, 0]);
  assert.equal(seenBody.model, 'nomic-embed-text');
  assert.equal(seenBody.prompt, 'hello world');

  const batch = await p.embedBatch(['a', 'b'], { fetchFn });
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], [0.6, 0.8, 0]);
});

test('OllamaProvider.embed: Ollama chưa chạy → EmbeddingError rõ ràng, không crash', async () => {
  const fetchFn = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  };
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  await assert.rejects(() => p.embed('hello', { fetchFn }), (err) => {
    assert.ok(err instanceof EmbeddingError);
    assert.match(err.message, /Không kết nối được tới Ollama/);
    return true;
  });
  assert.equal(await p.isEmbeddingAvailable({ fetchFn }), false);
});

test('OllamaProvider.embed: model chưa pull (404) → lỗi kèm gợi ý ollama pull', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
  });
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  await assert.rejects(() => p.embed('hello', { fetchFn }), (err) => {
    assert.ok(err instanceof EmbeddingError);
    assert.match(err.message, /ollama pull nomic-embed-text/);
    return true;
  });
});

test('OllamaProvider.isEmbeddingAvailable: stub fetch → true/false, không throw khi down', async () => {
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  assert.equal(await p.isEmbeddingAvailable({ fetchFn: async () => ({ ok: true }) }), true);
  assert.equal(
    await p.isEmbeddingAvailable({
      fetchFn: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    }),
    false,
  );
});

test('OllamaProvider.embed: text rỗng → lỗi rõ', async () => {
  const p = new OllamaProvider({ id: 'ollama', label: 'Ollama', defaultModel: 'qwen2.5:0.5b' });
  await assert.rejects(() => p.embed('   ', { fetchFn: async () => ({ ok: true }) }), /text rỗng/);
});

// ---------------------------------------------------------------------------
// B. LongTermMemory — recall ngữ nghĩa, migration, backfill (P1-9, mục 2+3)
// ---------------------------------------------------------------------------

test('LongTermMemory: file cũ không có vector vẫn đọc được; recallSemantic không embedder → fallback từ khoá', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  // File cũ: chỉ { version, entries } — không embeddingModel/embeddingDims, entry không có embedding.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.open-bot', 'memories.json'), 'utf8'));
  assert.equal(raw.embeddingModel, undefined);
  assert.equal(raw.entries[0].embedding, undefined);
  // recall từ khoá cũ vẫn chạy.
  assert.equal(store.recall({ query: 'postgres', botId: 'bot-a' })[0].key, 'db.config');

  const res = await store.recallSemantic('database connection pooling', { botId: 'bot-a' });
  assert.equal(res.usedFallback, true);
  assert.equal(res.fallbackReason, 'no-embedder');
  assert.equal(res.hits[0].entry.key, 'db.config');
});

test('LongTermMemory: rememberWithEmbedding lưu vector chuẩn hoá + metadata model/dims', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  const embedder = makeFakeEmbedder();
  const { entry, embedded, error } = await store.rememberWithEmbedding(
    { key: 'db.config', value: 'database connection pooling', tags: ['infra'], botId: 'bot-a' },
    embedder,
  );
  assert.equal(embedded, true);
  assert.equal(error, undefined);
  assert.equal(entry.embedding.length, 4);
  // Vector đã chuẩn hoá L2 (norm ≈ 1).
  const norm = Math.hypot(...entry.embedding);
  assert.ok(Math.abs(norm - 1) < 1e-9);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.open-bot', 'memories.json'), 'utf8'));
  assert.equal(raw.embeddingModel, 'fake-embed');
  assert.equal(raw.embeddingDims, 4);
  assert.equal(raw.entries[0].embedding.length, 4);
});

test('LongTermMemory: rememberWithEmbedding lỗi embed → memory vẫn lưu, embedded=false', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  const embedder = makeFakeEmbedder({ fail: true });
  const { entry, embedded, error } = await store.rememberWithEmbedding(
    { key: 'db.config', value: 'database connection pooling', botId: 'bot-a' },
    embedder,
  );
  assert.equal(embedded, false);
  assert.match(error, /fake embedder down/);
  assert.equal(entry.embedding, undefined);
  assert.equal(store.recall({ query: 'database' })[0].key, 'db.config');
});

test('LongTermMemory: ghi đè value xoá vector cũ (vector lỗi thời không được dùng)', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  const embedder = makeFakeEmbedder();
  await store.rememberWithEmbedding(
    { key: 'db.config', value: 'database connection pooling', botId: 'bot-a' },
    embedder,
  );
  assert.ok(store.recall({})[0].embedding);
  store.remember({ key: 'db.config', value: 'nấu pasta với sốt cà chua', botId: 'bot-a' });
  assert.equal(store.recall({})[0].embedding, undefined);
});

test('LongTermMemory: recallSemantic xếp hạng theo cosine + ngưỡng similarity', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const embedder = makeFakeEmbedder();
  await store.backfillEmbeddings(embedder);

  const res = await store.recallSemantic('database connection pooling', {
    embedder,
    botId: 'bot-a',
  });
  assert.equal(res.usedFallback, false);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].entry.key, 'db.config');
  assert.ok(Math.abs(res.hits[0].score - 1) < 1e-9);

  // Ngưỡng cao (0.99) vẫn giữ kết quả cosine = 1; ngưỡng > 1 thì không còn kết quả → fallback.
  const strict = await store.recallSemantic('database connection pooling', {
    embedder,
    botId: 'bot-a',
    minSimilarity: 1.01,
  });
  assert.equal(strict.usedFallback, true);
  assert.equal(strict.fallbackReason, 'no-match-above-threshold');
});

test('LongTermMemory: recallSemantic không có vector + không backfill → fallback no-vectors', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const embedder = makeFakeEmbedder();
  const res = await store.recallSemantic('database connection pooling', {
    embedder,
    botId: 'bot-a',
  });
  assert.equal(res.usedFallback, true);
  assert.equal(res.fallbackReason, 'no-vectors');
  assert.equal(res.hits[0].entry.key, 'db.config');
  assert.equal(embedder.calls(), 0, 'không backfill thì không embed memory nào');
});

test('LongTermMemory: recallSemantic backfill=true embed 1 lần rồi dùng lại vector đã lưu', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const embedder = makeFakeEmbedder();
  const first = await store.recallSemantic('database connection pooling', {
    embedder,
    botId: 'bot-a',
    backfill: true,
  });
  assert.equal(first.usedFallback, false);
  assert.equal(first.hits[0].entry.key, 'db.config');
  const callsAfterFirst = embedder.calls();
  assert.equal(callsAfterFirst, 3, '2 memory + 1 query');

  const second = await store.recallSemantic('database connection pooling', {
    embedder,
    botId: 'bot-a',
  });
  assert.equal(second.usedFallback, false);
  assert.equal(embedder.calls(), callsAfterFirst + 1, 'lần 2 chỉ embed query');
});

test('LongTermMemory: embedder lỗi khi embed query → fallback embed-failed', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const good = makeFakeEmbedder();
  await store.backfillEmbeddings(good);
  const bad = makeFakeEmbedder({ fail: true });
  const res = await store.recallSemantic('database connection pooling', {
    embedder: bad,
    botId: 'bot-a',
  });
  assert.equal(res.usedFallback, true);
  assert.equal(res.fallbackReason, 'embed-failed');
  assert.equal(res.hits[0].entry.key, 'db.config');
});

test('LongTermMemory: backfillEmbeddings đếm embedded/skipped/failed', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const embedder = makeFakeEmbedder();
  const first = await store.backfillEmbeddings(embedder);
  assert.deepEqual(
    { embedded: first.embedded, skipped: first.skipped, failed: first.failed, total: first.total },
    { embedded: 2, skipped: 0, failed: 0, total: 2 },
  );
  const second = await store.backfillEmbeddings(embedder);
  assert.deepEqual(
    { embedded: second.embedded, skipped: second.skipped, failed: second.failed, total: second.total },
    { embedded: 0, skipped: 2, failed: 0, total: 2 },
  );
  const bad = makeFakeEmbedder({ fail: true });
  const fresh = new LongTermMemory(makeTempDir());
  fresh.remember({ key: 'x', value: 'database', botId: 'bot-a' });
  const failed = await fresh.backfillEmbeddings(bad);
  assert.equal(failed.failed, 1);
  assert.equal(failed.embedded, 0);
});

test('LongTermMemory: đổi model embedding → vector cũ lỗi thời, backfill embed lại', async () => {
  const dir = makeTempDir();
  const store = seedMemories(dir);
  const embedderA = makeFakeEmbedder({ model: 'model-a' });
  await store.backfillEmbeddings(embedderA);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, '.open-bot', 'memories.json'), 'utf8')).embeddingModel,
    'model-a',
  );

  const embedderB = makeFakeEmbedder({ model: 'model-b' });
  const res = await store.recallSemantic('database connection pooling', {
    embedder: embedderB,
    botId: 'bot-a',
  });
  assert.equal(res.usedFallback, true);
  assert.equal(res.fallbackReason, 'no-vectors');

  const backfill = await store.backfillEmbeddings(embedderB);
  assert.equal(backfill.embedded, 2);
  assert.equal(backfill.skipped, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, '.open-bot', 'memories.json'), 'utf8')).embeddingModel,
    'model-b',
  );
  const after = await store.recallSemantic('database connection pooling', {
    embedder: embedderB,
    botId: 'bot-a',
  });
  assert.equal(after.usedFallback, false);
  assert.equal(after.hits[0].entry.key, 'db.config');
});

// ---------------------------------------------------------------------------
// C. Tool memory_recall / memory_remember — mode semantic qua fake Ollama
// ---------------------------------------------------------------------------

test('memory_recall semantic: xếp hạng ngữ nghĩa qua Ollama fake, nhớ lại lần 2 không embed lại', async () => {
  const dir = makeTempDir();
  const ollama = await startFakeOllama();
  const tools = createIntegrationTools();
  const remember = integrationTool(tools, 'memory_remember');
  const recall = integrationTool(tools, 'memory_recall');

  const out1 = await remember.execute(
    {
      key: 'db.config',
      value: 'database connection pooling with postgres',
      tags: ['infra'],
      embed: true,
      ollama_base_url: ollama.baseUrl,
    },
    CTX(dir),
  );
  assert.match(out1, /Đã lưu vector embedding/);
  await remember.execute(
    { key: 'recipe.pasta', value: 'nấu pasta với sốt cà chua cho bữa tối', tags: ['cooking'] },
    CTX(dir),
  );
  assert.equal(ollama.embedCalls(), 1, 'chỉ memory embed=true mới gọi Ollama');

  const out2 = await recall.execute(
    { query: 'database connection pooling', mode: 'semantic', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.match(out2, /tìm kiếm ngữ nghĩa/);
  assert.match(out2, /db\.config/);
  assert.ok(out2.indexOf('db.config') < out2.indexOf('recipe.pasta') || !out2.includes('recipe.pasta'));
  assert.match(out2, /score 1\.00/);
  // recall semantic: backfill embed recipe (1) + embed query (1) = 2 lần gọi thêm.
  assert.equal(ollama.embedCalls(), 3);

  const out3 = await recall.execute(
    { query: 'database connection pooling', mode: 'semantic', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.match(out3, /tìm kiếm ngữ nghĩa/);
  assert.equal(ollama.embedCalls(), 4, 'lần 2 chỉ embed query');
});

test('memory_recall semantic: Ollama chết → fallback về từ khoá và báo rõ', async () => {
  const dir = makeTempDir();
  seedMemories(dir);
  const port = await deadPort();
  const tools = createIntegrationTools();
  const recall = integrationTool(tools, 'memory_recall');
  const out = await recall.execute(
    {
      query: 'database connection pooling',
      mode: 'semantic',
      ollama_base_url: `http://127.0.0.1:${port}`,
    },
    CTX(dir),
  );
  assert.match(out, /fallback về tìm kiếm từ khoá/);
  assert.match(out, /db\.config/);
});

test('memory_recall keyword (mặc định): không đổi hành vi cũ', async () => {
  const dir = makeTempDir();
  seedMemories(dir);
  const tools = createIntegrationTools();
  const recall = integrationTool(tools, 'memory_recall');
  const out = await recall.execute({ query: 'postgres' }, CTX(dir));
  assert.match(out, /db\.config/);
  assert.doesNotMatch(out, /tìm kiếm ngữ nghĩa/);
  assert.doesNotMatch(out, /fallback/);
});

test('memory_recall semantic: min_similarity sai kiểu → lỗi rõ', async () => {
  const dir = makeTempDir();
  const tools = createIntegrationTools();
  const recall = integrationTool(tools, 'memory_recall');
  const out = await recall.execute({ query: 'database', mode: 'semantic', min_similarity: 2 }, CTX(dir));
  assert.match(out, /^Error: Argument "min_similarity" must be a number between 0 and 1\./);
});

// ---------------------------------------------------------------------------
// D. Tool semantic_search mode embeddings — index vector persistent
// ---------------------------------------------------------------------------

function seedCodeWorkspace(dir) {
  fs.writeFileSync(
    path.join(dir, 'db.md'),
    'database connection pooling improves database performance and connection reuse\n'.repeat(3),
  );
  fs.writeFileSync(
    path.join(dir, 'recipes.md'),
    'cooking recipes with pasta and tomato sauce for dinner\n'.repeat(3),
  );
  return dir;
}

function readEmbeddingsIndex(dir) {
  const root = path.join(dir, '.open-bot', 'embeddings');
  const scopes = fs.existsSync(root) ? fs.readdirSync(root) : [];
  assert.equal(scopes.length, 1, 'một scope index cho một thư mục gốc');
  const file = path.join(root, scopes[0], 'embeddings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('semantic_search embeddings: cache vector — lần 2 chỉ embed query, file đổi thì embed lại, file xoá thì prune', async () => {
  const dir = makeTempDir();
  seedCodeWorkspace(dir);
  const ollama = await startFakeOllama();
  const tool = codeTool('semantic_search');

  const out1 = await tool.execute(
    { query: 'database connection pooling', mode: 'embeddings', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.match(out1, /db\.md/);
  assert.ok(out1.indexOf('db.md') < out1.indexOf('recipes.md'));
  assert.match(out1, /\(embeddings, model nomic-embed-text\)/);
  assert.equal(ollama.embedCalls(), 3, 'lần 1: 2 file + 1 query');

  const index1 = readEmbeddingsIndex(dir);
  assert.equal(index1.items.length, 2);
  assert.deepEqual(
    index1.items.map((i) => i.id).sort(),
    ['db.md', 'recipes.md'],
  );

  const out2 = await tool.execute(
    { query: 'database connection pooling', mode: 'embeddings', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.match(out2, /db\.md/);
  assert.equal(ollama.embedCalls(), 4, 'lần 2 (không đổi): chỉ embed query');

  // Đổi nội dung recipes.md → lần 3 embed lại đúng file đó + query.
  fs.writeFileSync(
    path.join(dir, 'recipes.md'),
    'cooking recipes with pasta and tomato sauce for dinner\n'.repeat(3) + 'thêm dòng mới\n',
  );
  await tool.execute(
    { query: 'database connection pooling', mode: 'embeddings', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.equal(ollama.embedCalls(), 6, 'lần 3: 1 file đổi + 1 query');

  // Xoá db.md → lần 4 chỉ embed query, index không còn db.md.
  fs.rmSync(path.join(dir, 'db.md'));
  const out4 = await tool.execute(
    { query: 'database connection pooling', mode: 'embeddings', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.doesNotMatch(out4, /db\.md/);
  assert.equal(ollama.embedCalls(), 7, 'lần 4: chỉ embed query');
  const index4 = readEmbeddingsIndex(dir);
  assert.deepEqual(
    index4.items.map((i) => i.id),
    ['recipes.md'],
  );
});

test('semantic_search embeddings: Ollama chết → lỗi rõ, KHÔNG lặng lẽ fallback TF-IDF', async () => {
  const dir = makeTempDir();
  seedCodeWorkspace(dir);
  const port = await deadPort();
  const tool = codeTool('semantic_search');
  const out = await tool.execute(
    {
      query: 'database connection pooling',
      mode: 'embeddings',
      ollama_base_url: `http://127.0.0.1:${port}`,
    },
    CTX(dir),
  );
  assert.match(out, /^Error: Không kết nối được tới Ollama/);
  assert.doesNotMatch(out, /Keyword-ranked/);
});

test('semantic_search embeddings: scope khác nhau thì index riêng (không lẫn file)', async () => {
  const dir = makeTempDir();
  seedCodeWorkspace(dir);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(
    path.join(dir, 'sub', 'notes.md'),
    'database connection pooling improves database performance\n'.repeat(3),
  );
  const ollama = await startFakeOllama();
  const tool = codeTool('semantic_search');

  await tool.execute(
    { query: 'database', mode: 'embeddings', ollama_base_url: ollama.baseUrl, path: 'sub' },
    CTX(dir),
  );
  const root = path.join(dir, '.open-bot', 'embeddings');
  assert.equal(fs.readdirSync(root).length, 1, 'mới chỉ có 1 scope');
  const subIndex = readEmbeddingsIndex(dir);
  assert.deepEqual(
    subIndex.items.map((i) => i.id),
    ['sub/notes.md'],
  );

  await tool.execute(
    { query: 'database', mode: 'embeddings', ollama_base_url: ollama.baseUrl },
    CTX(dir),
  );
  assert.equal(fs.readdirSync(root).length, 2, 'thêm scope workspace gốc');
});
