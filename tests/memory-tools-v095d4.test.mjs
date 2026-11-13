/**
 * Tests for v0.95d4 — memory tools: memory_save / memory_search /
 * memory_list / memory_delete (packages/tools/src/memoryTools.ts).
 *
 * Bao phủ: tên tool + cờ needsApproval (ghi/xoá cần duyệt, đọc không),
 * save/search/list/delete end-to-end trên store thật + fake embedder,
 * output KHÔNG chứa vector embedding, wording đồng ý trong description
 * của memory_save, lỗi rõ khi host chưa truyền store.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-tools-v095d4.test.mjs
 *
 * No network. Fake embedder deterministic theo từ khoá.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import { createMemoryTools, MEMORY_TOOLS } from '../packages/tools/dist/memoryTools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memtools-v095d4-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const keywordEmbedder = {
  model: 'fake-keyword',
  async isAvailable() {
    return true;
  },
  async embed(text) {
    const t = text.toLowerCase();
    const v = [0, 0, 0];
    if (t.includes('phở')) v[0] = 1;
    else if (t.includes('biển')) v[1] = 1;
    else v[2] = 1;
    return v;
  },
};

const CTX = { botId: 'bot-a', workspaceDir: '/tmp' };

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('memory tools: đủ 4 tool, cờ approval đúng (ghi/xoá cần duyệt)', () => {
  assert.deepEqual(
    MEMORY_TOOLS.map((t) => t.definition.name).sort(),
    ['memory_delete', 'memory_list', 'memory_save', 'memory_search'],
  );
  const byName = Object.fromEntries(MEMORY_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.memory_save.needsApproval, true);
  assert.equal(byName.memory_delete.needsApproval, true);
  assert.equal(byName.memory_search.needsApproval, false);
  assert.equal(byName.memory_list.needsApproval, false);
  // Quy tắc đồng ý phải nằm trong description để model tuân theo.
  assert.ok(byName.memory_save.definition.description.includes('explicitly asked'));
  assert.ok(byName.memory_save.definition.description.includes('NEVER silently'));
});

test('memory tools: save → search → list → delete end-to-end, không lộ vector', async () => {
  const store = new LongTermMemory(makeTempDir());
  const tools = createMemoryTools({ store, embedder: keywordEmbedder, getUserId: () => 'user-1' });
  const save = toolByName(tools, 'memory_save');
  const search = toolByName(tools, 'memory_search');
  const list = toolByName(tools, 'memory_list');
  const del = toolByName(tools, 'memory_delete');

  const savedRaw = await save.execute(
    { key: 'ăn uống', value: 'thích phở bò', tags: ['ăn uống'] },
    CTX,
  );
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.saved, true);
  assert.equal(saved.embedded, true);
  assert.ok(saved.id);
  assert.equal(savedRaw.includes('embedding'), false);

  const foundRaw = await search.execute({ query: 'phở bò' }, CTX);
  const found = JSON.parse(foundRaw);
  assert.equal(found.usedFallback, false);
  assert.equal(found.hits[0].key, 'ăn uống');
  assert.equal(foundRaw.includes('embedding'), false);

  const listedRaw = await list.execute({}, CTX);
  const listed = JSON.parse(listedRaw);
  assert.equal(listed.count, 1);
  assert.equal(listed.entries[0].key, 'ăn uống');
  assert.equal(listedRaw.includes('embedding'), false);

  const deletedRaw = await del.execute({ id: saved.id }, CTX);
  assert.deepEqual(JSON.parse(deletedRaw), { deleted: true, id: saved.id });
  const afterDelete = JSON.parse(await list.execute({}, CTX));
  assert.equal(afterDelete.count, 0);
});

test('memory tools: save shared=false thì chỉ bot gọi mới thấy (list có includeShared)', async () => {
  const store = new LongTermMemory(makeTempDir());
  const tools = createMemoryTools({ store, embedder: keywordEmbedder });
  const save = toolByName(tools, 'memory_save');
  const list = toolByName(tools, 'memory_list');
  await save.execute({ key: 'riêng', value: 'chỉ bot A', shared: false }, { botId: 'bot-a' });
  await save.execute({ key: 'chung', value: 'mọi bot', shared: true }, { botId: 'bot-a' });
  const aList = JSON.parse(await list.execute({}, { botId: 'bot-a' }));
  assert.equal(aList.count, 2);
  const bList = JSON.parse(await list.execute({}, { botId: 'bot-b' }));
  assert.deepEqual(bList.entries.map((e) => e.key), ['chung']);
  // Xoá theo key khi không có id.
  const del = toolByName(tools, 'memory_delete');
  assert.deepEqual(JSON.parse(await del.execute({ key: 'riêng' }, { botId: 'bot-a' })), {
    deleted: true,
    key: 'riêng',
  });
  assert.ok((await del.execute({}, { botId: 'bot-a' })).startsWith('Error:'));
});

test('memory tools: không có embedder thì save/search vẫn chạy (không-embedding)', async () => {
  const store = new LongTermMemory(makeTempDir());
  const tools = createMemoryTools({ store });
  const save = toolByName(tools, 'memory_save');
  const search = toolByName(tools, 'memory_search');
  const saved = JSON.parse(await save.execute({ key: 'ăn uống', value: 'thích phở bò' }, CTX));
  assert.equal(saved.embedded, false);
  const found = JSON.parse(await search.execute({ query: 'phở' }, CTX));
  assert.equal(found.usedFallback, true);
  assert.equal(found.fallbackReason, 'no-embedder');
  assert.equal(found.hits[0].key, 'ăn uống');
});

test('memory tools: chưa truyền store thì tool báo lỗi rõ, không crash', async () => {
  const tools = createMemoryTools({});
  for (const tool of tools) {
    const out = await tool.execute({ key: 'x', value: 'y', query: 'x' }, CTX);
    assert.ok(out.startsWith('Error:'), tool.definition.name);
    assert.ok(out.includes('LongTermMemory'));
  }
});
