/**
 * Tests for v1.01 (Đội T4) — verbatim agent tools (packages/tools).
 *
 * Bao phủ: tên tool + cờ needsApproval (ghi/xoá cần duyệt, đọc không),
 * save/search/list/delete/stats/consolidate/backfill end-to-end trên
 * store thật + fake embedder, output KHÔNG chứa vector embedding,
 * wording đồng ý trong description của verbatim_memory_save, lỗi rõ
 * khi host chưa truyền store, placeholder chưa bound.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/verbatim-memory-tools-v101.test.mjs
 *
 * No network. Fake embedder deterministic theo từ khoá.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimMemoryStore, openVerbatimBackend } from '../packages/core/dist/memory/verbatim/index.js';
import {
  createVerbatimMemoryTools,
  VERBATIM_MEMORY_TOOLS,
  VERBATIM_MEMORY_TOOL_NAMES,
  isVerbatimMemoryToolName,
} from '../packages/tools/dist/verbatimMemoryTools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-verbatim-tools-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VOCAB = ['pho', 'paris', 'code', 'cat'];
const fakeEmbedder = {
  async embed(text) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
    return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
  },
  async isAvailable() {
    return true;
  },
};

async function makeTools(opts = {}) {
  const dir = makeTempDir();
  const opened = openVerbatimBackend({ dir, backend: 'sqlite' });
  const store = new VerbatimMemoryStore({ backend: opened.backend });
  const tools = createVerbatimMemoryTools({ store, embedder: fakeEmbedder, ...opts });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { dir, store, tools, byName };
}

const ctx = { botId: 'bot-1' };
async function run(tool, args) {
  return tool.execute(args, ctx);
}

test('verbatim tools: tên + needsApproval + placeholder', () => {
  assert.deepEqual([...VERBATIM_MEMORY_TOOL_NAMES], [
    'verbatim_memory_save',
    'verbatim_memory_search',
    'verbatim_memory_list',
    'verbatim_memory_delete',
    'verbatim_memory_stats',
    'verbatim_memory_consolidate',
    'verbatim_memory_backfill',
  ]);
  assert.equal(isVerbatimMemoryToolName('verbatim_memory_save'), true);
  assert.equal(isVerbatimMemoryToolName('memory_save'), false);
  // Placeholder chưa bound: execute trả lỗi rõ, không crash.
  assert.equal(VERBATIM_MEMORY_TOOLS.length, 7);
  const names = VERBATIM_MEMORY_TOOLS.map((t) => t.definition.name);
  assert.deepEqual(names, [...VERBATIM_MEMORY_TOOL_NAMES]);
});

test('verbatim tools: needsApproval — ghi/xoá cần duyệt, đọc không', async () => {
  const { tools } = await makeTools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('verbatim_memory_save').needsApproval, true);
  assert.equal(byName.get('verbatim_memory_delete').needsApproval, true);
  assert.equal(byName.get('verbatim_memory_search').needsApproval, false);
  assert.equal(byName.get('verbatim_memory_list').needsApproval, false);
  assert.equal(byName.get('verbatim_memory_stats').needsApproval, false);
  assert.equal(byName.get('verbatim_memory_consolidate').needsApproval, false);
  assert.equal(byName.get('verbatim_memory_backfill').needsApproval, false);
});

test('verbatim tools: description của save nói rõ quy tắc đồng ý', async () => {
  const { tools } = await makeTools();
  const save = tools.find((t) => t.definition.name === 'verbatim_memory_save');
  assert.match(save.definition.description, /ONLY when the user explicitly asked/);
  assert.match(save.definition.description, /NEVER silently record/);
  assert.match(save.definition.description, /word-for-word|EXACT words/);
});

test('verbatim tools: save/search/list/delete/stats end-to-end, không lộ vector', async () => {
  const { store, byName } = await makeTools();
  const saved = JSON.parse(await run(byName.get('verbatim_memory_save'), {
    text: 'Tôi thích phở bò, không ăn cay',
    wing: 'default',
    room: 'food',
    tags: ['ăn uống'],
  }));
  assert.equal(saved.saved, true);
  assert.equal(saved.created, true);
  assert.equal(saved.wing, 'default');
  const id = saved.id;

  const dup = JSON.parse(await run(byName.get('verbatim_memory_save'), {
    text: 'Tôi thích phở bò, không ăn cay',
    wing: 'default',
    room: 'food',
  }));
  assert.equal(dup.created, false);
  assert.equal(dup.id, id);

  const found = JSON.parse(await run(byName.get('verbatim_memory_search'), { query: 'phở bò' }));
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].id, id);
  assert.equal(found.hits[0].text, 'Tôi thích phở bò, không ăn cay');
  assert.equal('embedding' in found.hits[0], false);
  // Chưa backfill nên record chưa có vector → fallback từ khoá.
  assert.equal(found.usedFallback, true);
  assert.equal(found.fallbackReason, 'no-vectors');

  const listed = JSON.parse(await run(byName.get('verbatim_memory_list'), {}));
  assert.equal(listed.total, 1);
  assert.equal('embedding' in listed.records[0], false);

  const stats = JSON.parse(await run(byName.get('verbatim_memory_stats'), {}));
  assert.equal(stats.total, 1);
  assert.equal(stats.backend, 'sqlite');

  const deleted = JSON.parse(await run(byName.get('verbatim_memory_delete'), { id }));
  assert.deepEqual(deleted, { deleted: true, id });
  await store.close();
});

test('verbatim tools: search dùng embedder khi Ollama khả dụng (fake), fallback khi không', async () => {
  const { store, byName } = await makeTools();
  await store.save({ text: 'My cat is cute and fluffy' });
  await store.backfillEmbeddings(fakeEmbedder);
  const found = JSON.parse(await run(byName.get('verbatim_memory_search'), { query: 'cat' }));
  assert.equal(found.usedFallback, false);
  assert.equal(found.hits[0].text, 'My cat is cute and fluffy');
  assert.ok(found.hits[0].semanticScore > 0.3);

  // Không embedder → fallback từ khoá, vẫn tìm được.
  const dir = makeTempDir();
  const opened = openVerbatimBackend({ dir, backend: 'sqlite' });
  const store2 = new VerbatimMemoryStore({ backend: opened.backend });
  await store2.save({ text: 'Tôi thích phở bò' });
  const tools2 = createVerbatimMemoryTools({ store: store2 });
  const search2 = tools2.find((t) => t.definition.name === 'verbatim_memory_search');
  const found2 = JSON.parse(await search2.execute({ query: 'phở bò' }, ctx));
  assert.equal(found2.usedFallback, true);
  assert.equal(found2.fallbackReason, 'no-embedder');
  assert.equal(found2.hits[0].text, 'Tôi thích phở bò');
  await store.close();
  await store2.close();
});

test('verbatim tools: consolidate báo trùng + backfill embed', async () => {
  const { store, byName } = await makeTools();
  await store.save({ text: 'Tôi thích phở bò', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save({ text: 'Tôi thích phở bò!', wing: 'other', room: 'r', createdAt: '2026-01-02T00:00:00.000Z' });
  const report = JSON.parse(await run(byName.get('verbatim_memory_consolidate'), {}));
  assert.equal(report.examined, 2);
  assert.equal(report.removable, 1);
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].keep.text, 'Tôi thích phở bò');

  const backfilled = JSON.parse(await run(byName.get('verbatim_memory_backfill'), {}));
  assert.equal(backfilled.embedded, 2);
  assert.equal(backfilled.model, 'nomic-embed-text');
  await store.close();
});

test('verbatim tools: lỗi rõ khi host chưa truyền store', async () => {
  const tools = createVerbatimMemoryTools({});
  const search = tools.find((t) => t.definition.name === 'verbatim_memory_search');
  const out = await search.execute({ query: 'x' }, ctx);
  assert.match(out, /chưa được hỗ trợ/);
  const save = tools.find((t) => t.definition.name === 'verbatim_memory_save');
  const outSave = await save.execute({ text: 'x' }, ctx);
  assert.match(outSave, /chưa được hỗ trợ/);
});

test('verbatim tools: save thiếu text / delete sai id trả lỗi, không throw', async () => {
  const { store, byName } = await makeTools();
  const badSave = await run(byName.get('verbatim_memory_save'), {});
  assert.match(badSave, /^Error: Missing required argument/);
  const badDelete = JSON.parse(await run(byName.get('verbatim_memory_delete'), { id: 'no-such-id' }));
  assert.deepEqual(badDelete, { deleted: false, id: 'no-such-id' });
  await store.close();
});
