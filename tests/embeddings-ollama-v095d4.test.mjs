/**
 * Tests for v0.95d4 — Ollama embedding client (mock + live tuỳ chọn).
 *
 * Mock: fetch giả lập /api/tags + /api/embeddings (OllamaEmbeddings
 * nhận fetchFn) — embed, isAvailable, lỗi model chưa có.
 * Live: chỉ chạy khi Ollama thật đang chạy ở 127.0.0.1:11434 (skip
 * nếu không có); kiểm tra nomic-embed-text trả vector 768 chiều.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/embeddings-ollama-v095d4.test.mjs
 *
 * Không gọi mạng ngoài — Ollama local (127.0.0.1) là được.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaEmbeddings, DEFAULT_EMBED_MODEL } from '../packages/core/dist/memory/embeddings.js';

function mockResponse({ ok, status, json }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

/** Fake fetch giả lập Ollama: /api/tags ok, /api/embeddings trả vector cố định. */
function makeMockFetch({ modelPresent = true } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/tags')) {
      return mockResponse({
        ok: true,
        status: 200,
        json: { models: modelPresent ? [{ name: 'nomic-embed-text:latest' }] : [] },
      });
    }
    if (url.endsWith('/api/embeddings')) {
      const body = JSON.parse(init.body);
      if (body.model !== 'nomic-embed-text') {
        return mockResponse({ ok: false, status: 404, json: { error: `model '${body.model}' not found` } });
      }
      return mockResponse({ ok: true, status: 200, json: { embedding: [0.5, 0.5, 0.5, 0.5] } });
    }
    return mockResponse({ ok: false, status: 404, json: { error: 'not found' } });
  };
  return { fetchFn, calls };
}

test('ollama client (mock): embed + isAvailable + embedBatch', async () => {
  const { fetchFn, calls } = makeMockFetch();
  const client = new OllamaEmbeddings({ fetchFn });
  assert.equal(client.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(client.model, DEFAULT_EMBED_MODEL);
  assert.equal(await client.isAvailable(), true);
  const vec = await client.embed('thích phở bò');
  assert.deepEqual(vec, [0.5, 0.5, 0.5, 0.5]);
  const batch = await client.embedBatch(['a', 'b']);
  assert.equal(batch.length, 2);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/embeddings')).length, 3);
});

test('ollama client (mock): Ollama chết thì isAvailable false, embed báo lỗi rõ', async () => {
  const down = new OllamaEmbeddings({
    fetchFn: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    },
  });
  assert.equal(await down.isAvailable(), false);
  await assert.rejects(() => down.embed('x'), /Không kết nối được tới Ollama/);
});

test('ollama client (mock): model chưa có thì lỗi nhắc ollama pull', async () => {
  const { fetchFn } = makeMockFetch();
  const client = new OllamaEmbeddings({ fetchFn, model: 'model-chua-co' });
  await assert.rejects(() => client.embed('x'), /ollama pull model-chua-co/);
  await assert.rejects(() => client.embed('   '), /text rỗng/);
});

test('ollama client (live, tuỳ chọn): nomic-embed-text thật trả 768 chiều', async (t) => {
  const client = new OllamaEmbeddings();
  if (!(await client.isAvailable())) {
    t.skip('Ollama không chạy ở 127.0.0.1:11434 — bỏ qua kiểm tra live');
    return;
  }
  const vec = await client.embed('thích phở bò, không ăn cay');
  assert.equal(vec.length, 768, 'nomic-embed-text có 768 chiều');
  assert.ok(vec.every((n) => Number.isFinite(n)));
  const norm = Math.sqrt(vec.reduce((s, n) => s + n * n, 0));
  assert.ok(norm > 0);
});
