/**
 * Tests for v0.96 (Đội T1) — memory block tools: memory_block_create /
 * list / get / append / replace / delete / attach / detach / share +
 * memory_consolidate (packages/tools/src/memoryBlockTools.ts).
 *
 * Bao phủ: tên tool + cờ needsApproval (ghi/share/consolidate cần
 * duyệt, đọc không), CRUD end-to-end trên store thật, read-only guard
 * qua tool (trả Error chứ không throw), attach/detach/share giữa các
 * bot, consolidate run/status/configure qua tool, audit actor
 * `agent:<botId>`, lỗi rõ khi host chưa truyền store.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-block-tools-v096.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import { createMemoryBlockTools, MEMORY_BLOCK_TOOLS } from '../packages/tools/dist/memoryBlockTools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memblktools-v096-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX_A = { botId: 'bot-a', workspaceDir: '/tmp' };
const CTX_B = { botId: 'bot-b', workspaceDir: '/tmp' };

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function makeTools() {
  const dir = makeTempDir();
  const blocks = new MemoryBlockStore(dir);
  const longTerm = new LongTermMemory(dir);
  const tools = createMemoryBlockTools({ blocksStore: blocks, longTermStore: longTerm });
  return { dir, blocks, longTerm, tools };
}

async function call(tools, name, args, ctx = CTX_A) {
  const tool = toolByName(tools, name);
  const out = await tool.execute(args, ctx);
  assert.equal(typeof out, 'string');
  return out;
}

function parseOk(out) {
  assert.ok(!out.startsWith('Error:'), `expected success, got: ${out}`);
  return JSON.parse(out);
}

function parseErr(out) {
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out}`);
  return out;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('tools: đủ 10 tool, tên đúng, needsApproval đúng', () => {
  const { tools } = makeTools();
  const names = tools.map((t) => t.definition.name);
  assert.deepEqual(names, [
    'memory_block_create',
    'memory_block_list',
    'memory_block_get',
    'memory_block_append',
    'memory_block_replace',
    'memory_block_delete',
    'memory_block_attach',
    'memory_block_detach',
    'memory_block_share',
    'memory_consolidate',
  ]);
  const approval = new Map(tools.map((t) => [t.definition.name, t.needsApproval]));
  // Chỉ đọc (list/get) không cần duyệt; mọi thao tác ghi đều cần duyệt.
  assert.equal(approval.get('memory_block_list'), false);
  assert.equal(approval.get('memory_block_get'), false);
  for (const name of names) {
    if (name === 'memory_block_list' || name === 'memory_block_get') continue;
    assert.equal(approval.get(name), true, `${name} phải needsApproval`);
  }
  // Placeholder unbound có cùng 10 tool.
  assert.equal(MEMORY_BLOCK_TOOLS.length, 10);
});

test('tools: thiếu store -> lỗi rõ, không crash', async () => {
  const tools = createMemoryBlockTools();
  const out = await call(tools, 'memory_block_list', {});
  parseErr(out);
  assert.ok(out.includes('chưa được hỗ trợ'));
});

// ---------------------------------------------------------------------------
// CRUD end-to-end qua tool
// ---------------------------------------------------------------------------

test('tools: create/list/get/append/replace/delete end-to-end', async () => {
  const { tools } = makeTools();
  const created = parseOk(
    await call(tools, 'memory_block_create', {
      label: 'Human',
      description: 'Về user',
      content: 'Tên Huy.',
    }),
  );
  assert.equal(created.created, true);
  assert.equal(created.block.label, 'human');
  assert.equal(created.block.attachedToCallingBot, true);

  const listed = parseOk(await call(tools, 'memory_block_list', {}));
  assert.equal(listed.count, 1);
  assert.equal(listed.blocks[0].label, 'human');

  const got = parseOk(await call(tools, 'memory_block_get', { idOrLabel: 'human' }));
  assert.equal(got.block.content, 'Tên Huy.');

  const appended = parseOk(
    await call(tools, 'memory_block_append', { idOrLabel: 'human', text: 'Thích phở bò.' }),
  );
  assert.equal(appended.block.content, 'Tên Huy.\nThích phở bò.');
  assert.equal(appended.block.version, 2);

  const replaced = parseOk(
    await call(tools, 'memory_block_replace', { idOrLabel: 'human', content: 'Tên Huy, thích phở.' }),
  );
  assert.equal(replaced.block.content, 'Tên Huy, thích phở.');

  const deleted = parseOk(await call(tools, 'memory_block_delete', { idOrLabel: 'human' }));
  assert.equal(deleted.deleted, true);
  assert.equal(parseOk(await call(tools, 'memory_block_list', {})).count, 0);
});

test('tools: create trùng label / nội dung vượt giới hạn -> Error', async () => {
  const { tools } = makeTools();
  parseOk(await call(tools, 'memory_block_create', { label: 'x', content: 'ok' }));
  parseErr(await call(tools, 'memory_block_create', { label: 'x', content: 'khác' }));
  parseErr(await call(tools, 'memory_block_create', { label: 'y', content: 'a'.repeat(2001) }));
  parseErr(await call(tools, 'memory_block_get', { idOrLabel: 'khong-co' }));
});

test('tools: read-only guard qua tool — append/replace/delete trả Error, block nguyên vẹn', async () => {
  const { tools } = makeTools();
  parseOk(
    await call(tools, 'memory_block_create', { label: 'core', content: 'cố định', readOnly: true }),
  );
  parseErr(await call(tools, 'memory_block_append', { idOrLabel: 'core', text: 'thêm' }));
  parseErr(await call(tools, 'memory_block_replace', { idOrLabel: 'core', content: 'đổi' }));
  parseErr(await call(tools, 'memory_block_delete', { idOrLabel: 'core' }));
  const got = parseOk(await call(tools, 'memory_block_get', { idOrLabel: 'core' }));
  assert.equal(got.block.content, 'cố định');
});

// ---------------------------------------------------------------------------
// Attach / detach / share qua tool
// ---------------------------------------------------------------------------

test('tools: attach/detach/share — block chỉ vào prompt của bot đã attach', async () => {
  const { tools } = makeTools();
  parseOk(
    await call(tools, 'memory_block_create', { label: 'notes', content: 'ghi chú' }, CTX_A),
  );
  // bot-b chưa attach -> list rỗng.
  assert.equal(parseOk(await call(tools, 'memory_block_list', {}, CTX_B)).count, 0);
  // Attach cho bot-b.
  const attached = parseOk(
    await call(tools, 'memory_block_attach', { idOrLabel: 'notes', botId: 'bot-b' }, CTX_A),
  );
  assert.equal(attached.attached, true);
  assert.equal(attached.botId, 'bot-b');
  assert.equal(parseOk(await call(tools, 'memory_block_list', {}, CTX_B)).count, 1);
  // Detach khỏi bot-b.
  parseOk(await call(tools, 'memory_block_detach', { idOrLabel: 'notes', botId: 'bot-b' }, CTX_A));
  assert.equal(parseOk(await call(tools, 'memory_block_list', {}, CTX_B)).count, 0);
  // Share cho bot-b bằng memory_block_share.
  const shared = parseOk(
    await call(tools, 'memory_block_share', { idOrLabel: 'notes', botId: 'bot-b' }, CTX_A),
  );
  assert.equal(shared.shared, true);
  assert.deepEqual(shared.block.attachedBots, ['bot-a', 'bot-b']);
  // Share all.
  const sharedAll = parseOk(
    await call(tools, 'memory_block_share', { idOrLabel: 'notes', all: true, botIds: ['bot-a', 'bot-b', 'bot-c'] }, CTX_A),
  );
  assert.deepEqual(sharedAll.newlyAttachedBots, ['bot-c']);
  // Share thiếu botId và all=false -> Error.
  parseErr(await call(tools, 'memory_block_share', { idOrLabel: 'notes' }, CTX_A));
});

test('tools: create với attach=false thì bot gọi không thấy trong list mặc định', async () => {
  const { tools } = makeTools();
  parseOk(
    await call(tools, 'memory_block_create', { label: 'free', content: 'chưa attach', attach: false }),
  );
  assert.equal(parseOk(await call(tools, 'memory_block_list', {})).count, 0);
  assert.equal(parseOk(await call(tools, 'memory_block_list', { includeDetached: true })).count, 1);
});

// ---------------------------------------------------------------------------
// Audit actor
// ---------------------------------------------------------------------------

test('tools: audit ghi actor agent:<botId> cho thao tác qua tool', async () => {
  const { blocks, tools } = makeTools();
  parseOk(await call(tools, 'memory_block_create', { label: 'human', content: 'a' }, CTX_A));
  parseOk(await call(tools, 'memory_block_append', { idOrLabel: 'human', text: 'b' }, CTX_B));
  const audit = blocks.readAudit(10);
  assert.ok(audit.some((e) => e.action === 'create' && e.actor === 'agent:bot-a'));
  assert.ok(audit.some((e) => e.action === 'append' && e.actor === 'agent:bot-b'));
});

// ---------------------------------------------------------------------------
// memory_consolidate qua tool
// ---------------------------------------------------------------------------

test('tools: memory_consolidate status mặc định TẮT, configure bật, run gộp + promote', async () => {
  const { longTerm, tools } = makeTools();
  const status0 = parseOk(await call(tools, 'memory_consolidate', { action: 'status' }));
  assert.equal(status0.enabled, false);
  assert.equal(status0.idleMinutes, 30);

  const configured = parseOk(
    await call(tools, 'memory_consolidate', { action: 'configure', enabled: true, idleMinutes: 15 }),
  );
  assert.equal(configured.enabled, true);
  assert.equal(configured.idleMinutes, 15);
  assert.equal(parseOk(await call(tools, 'memory_consolidate', { action: 'status' })).enabled, true);

  longTerm.remember({ key: 'Sở thích', value: 'Thích phở bò!', confidence: 0.8 });
  longTerm.remember({ key: 'sở thích', value: 'thich pho bo', confidence: 0.8 });
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95 });
  const report = parseOk(await call(tools, 'memory_consolidate', { action: 'run' }));
  assert.equal(report.action, 'run');
  assert.equal(report.deduped, 1);
  assert.equal(report.promoted, 1);
  assert.equal(report.archived, 1);
  assert.ok(Array.isArray(report.details) && report.details.length > 0);

  parseErr(await call(tools, 'memory_consolidate', { action: 'khong-co' }));
  parseErr(await call(tools, 'memory_consolidate', { action: 'configure', enabled: 'yes' }));
});

test('tools: memory_consolidate run thiếu longTermStore -> Error rõ', async () => {
  const dir = makeTempDir();
  const tools = createMemoryBlockTools({ blocksStore: new MemoryBlockStore(dir) });
  const out = await call(tools, 'memory_consolidate', { action: 'run' });
  parseErr(out);
  assert.ok(out.includes('long-term memory store'));
});
