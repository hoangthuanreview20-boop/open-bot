/**
 * Tests for v0.96 (Đội T1) — memory blocks: MemoryBlockStore
 * (packages/core/src/memory/blocks.ts), prompt render
 * (buildMemoryBlocksSection / buildMemoryTurnContext), consolidation
 * (packages/core/src/memory/consolidate.ts) và MemFS-lite
 * (packages/core/src/memory/memfs.ts).
 *
 * Bao phủ: CRUD + validate label/giới hạn ký tự, read-only guard,
 * attach/detach/share giữa các bot, audit log, render block vào system
 * prompt (human/persona ưu tiên, ngân sách), consolidate dedupe /
 * conflict (mới hơn thắng, bản thua vào archive) / promote lên block
 * human, scheduler idle (mặc định TẮT), memfs export/import round-trip
 * + merge không ghi đè bừa.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-blocks-v096.test.mjs
 *
 * No network. No model. Mọi quyết định consolidate đều là luật xác
 * định trên text nên test assert được chính xác.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore, normalizeBlockLabel, isValidBlockLabel } from '../packages/core/dist/memory/blocks.js';
import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import { buildMemoryTurnContext, buildMemoryBlocksSection } from '../packages/core/dist/memory/turnContext.js';
import {
  consolidate,
  ConsolidationScheduler,
  normalizeFactText,
  groupDuplicateEntries,
  findConflicts,
  shouldConsolidateNow,
  runIdleConsolidationIfDue,
  noteConsolidationActivity,
} from '../packages/core/dist/memory/consolidate.js';
import {
  exportBlocksToMemFs,
  importBlocksFromMemFs,
  importFactsFromMemFs,
  parseMemFsFrontmatter,
  parseFactsFile,
} from '../packages/core/dist/memory/memfs.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memblk-v096-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStores() {
  const dir = makeTempDir();
  return { dir, blocks: new MemoryBlockStore(dir), longTerm: new LongTermMemory(dir) };
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

test('normalizeBlockLabel: chuẩn hoá slug, bỏ dấu tiếng Việt', () => {
  assert.equal(normalizeBlockLabel('Sở Thích Ăn Uống'), 'so-thich-an-uong');
  assert.equal(normalizeBlockLabel('  human  '), 'human');
  assert.equal(normalizeBlockLabel('Project_X 2026!'), 'project-x-2026');
  assert.equal(isValidBlockLabel('human'), true);
  assert.equal(isValidBlockLabel('a-b_c9'), true);
  assert.equal(isValidBlockLabel(''), false);
  assert.equal(isValidBlockLabel('-abc'), false);
  assert.equal(isValidBlockLabel('a'.repeat(65)), false);
});

// ---------------------------------------------------------------------------
// MemoryBlockStore — CRUD
// ---------------------------------------------------------------------------

test('blocks: create/get/list — label chuẩn hoá, version 1, giới hạn mặc định 2000', () => {
  const { blocks } = makeStores();
  const created = blocks.create({ label: 'Human', description: 'Về user', content: 'Thích phở.' });
  assert.equal(created.label, 'human');
  assert.equal(created.version, 1);
  assert.equal(created.charLimit, 2000);
  assert.equal(created.readOnly, false);
  assert.equal(blocks.get('human')?.id, created.id);
  assert.equal(blocks.get(created.id)?.label, 'human');
  assert.equal(blocks.get('khong-co'), null);
  assert.equal(blocks.list().length, 1);
});

test('blocks: label trùng -> throw; label không hợp lệ -> throw', () => {
  const { blocks } = makeStores();
  blocks.create({ label: 'human', content: 'a' });
  assert.throws(() => blocks.create({ label: 'HUMAN', content: 'b' }), /Đã có memory block/);
  assert.throws(() => blocks.create({ label: '!!!', content: 'b' }), /không hợp lệ/);
  assert.throws(() => blocks.create({ label: '', content: 'b' }), /không hợp lệ/);
});

test('blocks: nội dung vượt charLimit -> throw (không cắt lén)', () => {
  const { blocks } = makeStores();
  assert.throws(() => blocks.create({ label: 'x', content: 'a'.repeat(101), charLimit: 100 }), /vượt giới hạn 100/);
  assert.throws(() => blocks.create({ label: 'x', content: 'a'.repeat(2001) }), /vượt giới hạn 2000/);
  const ok = blocks.create({ label: 'x', content: 'a'.repeat(150), charLimit: 150 });
  assert.equal(ok.content.length, 150);
});

test('blocks: update tăng version + updatedAt; append nối dòng mới; replace ghi đè', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'notes', content: 'dòng 1' });
  const updated = blocks.update(b.id, { description: 'ghi chú', content: 'dòng 1 sửa' });
  assert.equal(updated.version, 2);
  assert.equal(updated.description, 'ghi chú');
  assert.equal(updated.content, 'dòng 1 sửa');
  const appended = blocks.append(b.id, 'dòng 2');
  assert.equal(appended.version, 3);
  assert.equal(appended.content, 'dòng 1 sửa\ndòng 2');
  const replaced = blocks.replace('notes', 'mới hoàn toàn');
  assert.equal(replaced.version, 4);
  assert.equal(replaced.content, 'mới hoàn toàn');
});

test('blocks: update không đổi gì thì không tăng version', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'notes', content: 'x' });
  const same = blocks.update(b.id, { content: 'x' });
  assert.equal(same.version, 1);
  const sameReplace = blocks.replace(b.id, 'x');
  assert.equal(sameReplace.version, 1);
});

test('blocks: append vượt giới hạn -> throw, nội dung cũ giữ nguyên', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'notes', content: 'a'.repeat(90), charLimit: 100 });
  assert.throws(() => blocks.append(b.id, 'b'.repeat(20)), /vượt giới hạn 100/);
  assert.equal(blocks.get(b.id)?.content.length, 90);
  assert.throws(() => blocks.append(b.id, '   '), /Không có nội dung/);
});

test('blocks: read-only chặn update/append/replace/delete; tắt cờ thì sửa được', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'core', content: 'cố định', readOnly: true });
  assert.throws(() => blocks.update(b.id, { content: 'đổi' }), /read-only/);
  assert.throws(() => blocks.append(b.id, 'thêm'), /read-only/);
  assert.throws(() => blocks.replace(b.id, 'đổi'), /read-only/);
  assert.throws(() => blocks.delete(b.id), /read-only/);
  assert.equal(blocks.get(b.id)?.content, 'cố định');
  const unlocked = blocks.setReadOnly(b.id, false);
  assert.equal(unlocked.readOnly, false);
  const edited = blocks.replace(b.id, 'đổi được rồi');
  assert.equal(edited.content, 'đổi được rồi');
  // Bật lại read-only và kiểm tra delete vẫn bị chặn.
  blocks.setReadOnly(b.id, true);
  assert.throws(() => blocks.delete(b.id), /read-only/);
});

test('blocks: delete gỡ block + mọi attachment', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'tmp', content: 'x' });
  blocks.attach('bot-a', b.id);
  blocks.attach('bot-b', b.id);
  assert.equal(blocks.delete(b.id), true);
  assert.equal(blocks.get(b.id), null);
  assert.deepEqual(blocks.attachedBotIds(b.id), []);
  assert.equal(blocks.list({ botId: 'bot-a' }).length, 0);
});

test('blocks: importFromLongTerm — tạo block từ long-term entry, ghi rõ nguồn', () => {
  const { blocks, longTerm } = makeStores();
  const entry = longTerm.remember({
    key: 'Sở thích ăn uống',
    value: 'thích phở bò, không ăn cay',
    tags: ['ăn uống'],
    confidence: 0.9,
  });
  const block = blocks.importFromLongTerm(entry);
  assert.equal(block.label, 'so-thich-an-uong');
  assert.equal(block.content, 'thích phở bò, không ăn cay');
  assert.ok(block.description.includes('Sở thích ăn uống'));
  assert.ok(block.description.includes('ăn uống'));
  // Label đã tồn tại -> throw (không ghi đè bừa).
  assert.throws(() => blocks.importFromLongTerm(entry), /Đã có memory block/);
  // Entry rỗng -> throw.
  const empty = longTerm.remember({ key: 'Trống', value: 'x' });
  assert.throws(() => blocks.importFromLongTerm({ ...empty, value: '   ' }), /không có nội dung/);
});

test('blocks: ensureBlock trả block đã có, chưa có thì tạo', () => {
  const { blocks } = makeStores();
  const first = blocks.ensureBlock('human', { description: 'Về user' });
  const second = blocks.ensureBlock('human', { description: 'Mô tả khác — không ghi đè' });
  assert.equal(first.id, second.id);
  assert.equal(second.description, 'Về user');
  assert.equal(blocks.list().length, 1);
});

// ---------------------------------------------------------------------------
// Attach / detach / share
// ---------------------------------------------------------------------------

test('blocks: attach/detach theo bot — list(botId) chỉ thấy block đã attach', () => {
  const { blocks } = makeStores();
  const human = blocks.create({ label: 'human', content: 'user' });
  const proj = blocks.create({ label: 'project', content: 'dự án' });
  blocks.attach('bot-a', human.id);
  assert.deepEqual(blocks.list({ botId: 'bot-a' }).map((b) => b.label), ['human']);
  assert.deepEqual(blocks.list({ botId: 'bot-b' }).map((b) => b.label), []);
  assert.equal(blocks.list().length, 2);
  assert.equal(blocks.isAttached('bot-a', human.id), true);
  assert.equal(blocks.isAttached('bot-a', proj.id), false);
  // Attach lại idempotent — không trùng lặp.
  blocks.attach('bot-a', 'human');
  assert.deepEqual(blocks.list({ botId: 'bot-a' }).map((b) => b.label), ['human']);
  // Detach idempotent.
  blocks.detach('bot-a', proj.id);
  blocks.detach('bot-a', human.id);
  assert.equal(blocks.isAttached('bot-a', human.id), false);
  assert.deepEqual(blocks.list({ botId: 'bot-a' }), []);
});

test('blocks: share — cùng block id, sửa 1 nơi thấy ở mọi bot', () => {
  const { blocks } = makeStores();
  const b = blocks.create({ label: 'shared-notes', content: 'v1' });
  blocks.attach('bot-a', b.id);
  const newly = blocks.share(b.id, ['bot-b', 'bot-c', 'bot-a']);
  assert.deepEqual(newly, ['bot-b', 'bot-c']);
  assert.deepEqual(blocks.attachedBotIds(b.id), ['bot-a', 'bot-b', 'bot-c']);
  // Sửa 1 nơi: mọi bot đều thấy nội dung mới (cùng block id).
  blocks.replace(b.id, 'v2 — đã sửa');
  for (const botId of ['bot-a', 'bot-b', 'bot-c']) {
    assert.equal(blocks.list({ botId })[0]?.content, 'v2 — đã sửa');
  }
  // unshareAll gỡ khỏi mọi bot nhưng giữ block.
  assert.equal(blocks.unshareAll(b.id), 3);
  assert.equal(blocks.get(b.id)?.content, 'v2 — đã sửa');
  assert.deepEqual(blocks.attachedBotIds(b.id), []);
});

test('blocks: attach block không tồn tại -> throw rõ', () => {
  const { blocks } = makeStores();
  assert.throws(() => blocks.attach('bot-a', 'khong-co'), /Không tìm thấy memory block/);
  assert.throws(() => blocks.detach('bot-a', 'khong-co'), /Không tìm thấy memory block/);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('blocks: audit ghi mọi thay đổi, đọc được N dòng mới nhất', () => {
  const { blocks } = makeStores();
  assert.deepEqual(blocks.readAudit(), []);
  const b = blocks.create({ label: 'human', content: 'a' }, 'user');
  blocks.attach('bot-a', b.id, 'user');
  blocks.append(b.id, 'b', 'agent:bot-a');
  blocks.setReadOnly(b.id, true, 'user');
  const audit = blocks.readAudit(10);
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.map((e) => e.action), ['set-read-only', 'append', 'attach', 'create']);
  assert.equal(audit[1]?.actor, 'agent:bot-a');
  assert.equal(audit[3]?.label, 'human');
  assert.equal(blocks.readAudit(2).length, 2);
});

// ---------------------------------------------------------------------------
// Prompt render
// ---------------------------------------------------------------------------

test('prompt: buildMemoryBlocksSection render <memory>, human/persona trước', () => {
  const { blocks } = makeStores();
  blocks.create({ label: 'zeta', description: 'Z', content: 'nội dung zeta' });
  blocks.create({ label: 'persona', description: 'Tính cách', content: 'Trả lời ngắn gọn.' });
  blocks.create({ label: 'human', description: 'Về user', content: 'Tên Huy.' });
  blocks.create({ label: 'detached', content: 'không attach' });
  blocks.attach('bot-a', 'zeta');
  blocks.attach('bot-a', 'persona');
  blocks.attach('bot-a', 'human');
  const part = buildMemoryBlocksSection(blocks, 'bot-a');
  assert.equal(part.included.join(','), 'human,persona,zeta');
  assert.ok(part.section.startsWith('<memory>\n'));
  assert.ok(part.section.endsWith('\n</memory>'));
  assert.ok(part.section.indexOf('[human') < part.section.indexOf('[persona'));
  assert.ok(part.section.indexOf('[persona') < part.section.indexOf('[zeta'));
  assert.ok(!part.section.includes('detached'));
  assert.equal(part.truncated, false);
});

test('prompt: block rỗng không render; không có botId thì không render block', () => {
  const { blocks } = makeStores();
  blocks.create({ label: 'empty', content: '' });
  blocks.attach('bot-a', 'empty');
  assert.equal(buildMemoryBlocksSection(blocks, 'bot-a').section, '');
  blocks.create({ label: 'human', content: 'x' });
  blocks.attach('bot-a', 'human');
  assert.equal(buildMemoryBlocksSection(blocks, undefined).section, '');
  assert.equal(buildMemoryBlocksSection(undefined, 'bot-a').section, '');
});

test('prompt: ngân sách blocks cắt nội dung và báo truncated', () => {
  const { blocks } = makeStores();
  blocks.create({ label: 'human', content: 'a'.repeat(500) });
  blocks.create({ label: 'big', content: 'b'.repeat(500) });
  blocks.attach('bot-a', 'human');
  blocks.attach('bot-a', 'big');
  const part = buildMemoryBlocksSection(blocks, 'bot-a', { maxChars: 200 });
  assert.equal(part.truncated, true);
  assert.ok(part.section.includes('…'));
  assert.ok(part.section.length <= 200 + '<memory>\n'.length + '\n</memory>'.length + 10);
});

test('prompt: buildMemoryTurnContext nối blocks vào section, detached không lọt', async () => {
  const { blocks } = makeStores();
  blocks.create({ label: 'human', content: 'Tên Huy, thích phở bò.' });
  blocks.attach('bot-a', 'human');
  blocks.create({ label: 'secret', content: 'chỉ bot-b biết' });
  blocks.attach('bot-b', 'secret');
  const ctx = await buildMemoryTurnContext({
    profile: null,
    blocksStore: blocks,
    botId: 'bot-a',
    userText: 'xin chào',
  });
  assert.ok(ctx.section.includes('<memory>'));
  assert.ok(ctx.section.includes('Tên Huy'));
  assert.ok(!ctx.section.includes('chỉ bot-b biết'));
  assert.deepEqual(ctx.blocksIncluded, ['human']);
  assert.equal(ctx.blocksTruncated, false);
});

// ---------------------------------------------------------------------------
// Consolidation — pure helpers
// ---------------------------------------------------------------------------

test('consolidate helpers: normalizeFactText bỏ dấu + dấu câu', () => {
  assert.equal(normalizeFactText('Thích phở bò!'), 'thich pho bo');
  assert.equal(normalizeFactText('  ĂN   uống,  ngon  '), 'an uong ngon');
  assert.equal(normalizeFactText(''), '');
});

test('consolidate helpers: groupDuplicateEntries giữ bản mới nhất', () => {
  const now = new Date().toISOString();
  const entries = [
    { id: '1', key: 'Sở thích', value: 'Thích phở bò!', tags: [], confidence: 0.8, botId: '', createdAt: now, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', key: 'sở thích', value: 'thich pho bo', tags: [], confidence: 0.9, botId: '', createdAt: now, updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: '3', key: 'khác', value: 'không trùng', tags: [], confidence: 0.8, botId: '', createdAt: now, updatedAt: now },
  ];
  const groups = groupDuplicateEntries(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.keep.id, '2');
  assert.deepEqual(groups[0]?.duplicates.map((d) => d.id), ['1']);
});

test('consolidate helpers: findConflicts — cùng key, value khác, mới hơn thắng', () => {
  const now = new Date().toISOString();
  const entries = [
    { id: 'old', key: 'Món khoái khẩu', value: 'bún chả', tags: [], confidence: 0.9, botId: '', createdAt: now, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', key: 'món khoái khẩu', value: 'phở bò', tags: [], confidence: 0.7, botId: '', createdAt: now, updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'same', key: 'khác', value: 'giống nhau', tags: [], confidence: 0.8, botId: '', createdAt: now, updatedAt: now },
  ];
  const conflicts = findConflicts(entries);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.winner.id, 'new');
  assert.deepEqual(conflicts[0]?.losers.map((l) => l.id), ['old']);
});

// ---------------------------------------------------------------------------
// Consolidation — end to end
// ---------------------------------------------------------------------------

test('consolidate: dedupe + conflict + promote + archive trong một lần chạy', async () => {
  const { dir, blocks, longTerm } = makeStores();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Trùng nhau (khác dấu/case — key khác nhau từng ký tự nên remember
  // không ghi đè, nhưng chuẩn hoá thì trùng) — giữ bản mới nhất.
  longTerm.remember({ key: 'Sở thích', value: 'Thích phở bò!', confidence: 0.8 });
  await sleep(5);
  longTerm.remember({ key: 'sở thích', value: 'thich pho bo', confidence: 0.8 });
  // Xung đột cùng key chuẩn hoá nhưng khác case — bản mới hơn thắng
  // (sleep để updatedAt khác nhau rõ ràng, tránh hoà mili-giây).
  longTerm.remember({ key: 'Món khoái khẩu', value: 'bún chả', confidence: 0.9 });
  await sleep(5);
  longTerm.remember({ key: 'món khoái khẩu', value: 'phở bò', confidence: 0.7 });
  // Fact quan trọng (confidence cao + tag) -> promote lên human.
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95, tags: ['sức khỏe'] });
  longTerm.remember({ key: 'Ngôn ngữ', value: 'nói tiếng Việt', confidence: 0.5, tags: ['quan trọng'] });

  const report = consolidate(longTerm, blocks);
  assert.equal(report.examined, 6);
  assert.equal(report.deduped, 1);
  assert.equal(report.conflictsResolved, 1);
  assert.equal(report.conflicts[0]?.key, 'món khoái khẩu'); // raw key của bản thắng (mới nhất)
  assert.equal(report.conflicts[0]?.winnerValue, 'phở bò');
  assert.equal(report.conflicts[0]?.superseded[0]?.value, 'bún chả');
  assert.equal(report.promoted, 2);
  assert.equal(report.archived, 2);
  assert.ok(report.archivedFile);
  assert.ok(fs.existsSync(report.archivedFile));
  // Kho live còn lại: sở thích (bản mới), món khoái khẩu (phở bò), dị ứng, ngôn ngữ.
  const live = longTerm.recall({ limit: 200 });
  assert.equal(live.length, 4);
  assert.ok(live.some((e) => e.key === 'món khoái khẩu' && e.value === 'phở bò'));
  // Block human có 2 bullet.
  const human = blocks.get('human');
  assert.ok(human);
  assert.ok(human.content.includes('- Dị ứng: dị ứng đậu phộng'));
  assert.ok(human.content.includes('- Ngôn ngữ: nói tiếng Việt'));
  // Archive giữ bản thua.
  const archived = JSON.parse(fs.readFileSync(report.archivedFile, 'utf8'));
  assert.equal(archived.entries.length, 2);
  assert.ok(archived.entries.some((a) => a.entry.value === 'bún chả' && a.archivedReason === 'conflict-loser'));
  // Audit có dòng consolidate.
  assert.ok(blocks.readAudit(5).some((e) => e.action === 'consolidate'));
});

test('consolidate: chạy lần 2 không promote trùng dòng, không dedupe thêm', () => {
  const { blocks, longTerm } = makeStores();
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95 });
  const first = consolidate(longTerm, blocks);
  assert.equal(first.promoted, 1);
  const second = consolidate(longTerm, blocks);
  assert.equal(second.promoted, 0);
  assert.equal(second.deduped, 0);
  assert.equal(second.conflictsResolved, 0);
  assert.equal(blocks.get('human')?.content.split('\n').length, 1);
});

test('consolidate: kho rỗng -> report 0, không tạo file archive', () => {
  const { dir, blocks, longTerm } = makeStores();
  const report = consolidate(longTerm, blocks);
  assert.equal(report.examined, 0);
  assert.equal(report.archived, 0);
  assert.equal(report.archivedFile, undefined);
  assert.equal(fs.existsSync(path.join(dir, '.open-bot', 'memory-archives')), false);
  assert.equal(blocks.get('human'), null);
});

test('consolidate: block human read-only -> promote bị skip, không throw', () => {
  const { blocks, longTerm } = makeStores();
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95 });
  const human = blocks.ensureBlock('human', { description: 'Về user' });
  blocks.setReadOnly(human.id, true);
  const report = consolidate(longTerm, blocks);
  // ensureBlock đã tạo human rỗng; append bị chặn read-only -> skip.
  assert.equal(report.promoted, 0);
  assert.equal(report.promotedSkipped, 1);
});

// ---------------------------------------------------------------------------
// Idle scheduler
// ---------------------------------------------------------------------------

test('scheduler: mặc định TẮT; bật + đủ idle mới chạy; chạy xong reset đồng hồ', () => {
  const { blocks, longTerm } = makeStores();
  const sched = new ConsolidationScheduler();
  assert.equal(sched.state.enabled, false);
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95 });
  sched.noteActivity(1000);
  assert.equal(sched.shouldRun(1000 + 60_000), false); // tắt -> không chạy
  sched.setEnabled(true);
  sched.setIdleMinutes(30);
  assert.equal(sched.shouldRun(1000 + 29 * 60_000), false);
  assert.equal(sched.shouldRun(1000 + 30 * 60_000), true);
  const report = sched.runIfDue(longTerm, blocks, {}, 1000 + 31 * 60_000);
  assert.ok(report);
  assert.equal(report.promoted, 1);
  assert.equal(sched.shouldRun(1000 + 32 * 60_000), false); // vừa chạy -> chưa đủ idle lại
});

test('idle helpers trên store: cấu hình lưu bền trong file, mặc định tắt', () => {
  const { dir, blocks, longTerm } = makeStores();
  assert.deepEqual(blocks.getConsolidationConfig(), { enabled: false, idleMinutes: 30 });
  assert.equal(shouldConsolidateNow(blocks, new Date()), false);
  // Bật + ghi activity 40 phút trước -> đủ idle (30 phút).
  blocks.setConsolidationConfig({ enabled: true, idleMinutes: 30 });
  noteConsolidationActivity(blocks, new Date(Date.now() - 40 * 60_000));
  assert.equal(shouldConsolidateNow(blocks, new Date()), true);
  longTerm.remember({ key: 'Dị ứng', value: 'dị ứng đậu phộng', confidence: 0.95 });
  const report = runIdleConsolidationIfDue(longTerm, blocks);
  assert.ok(report);
  assert.equal(report.promoted, 1);
  // Cấu hình bền qua instance mới (đọc lại từ file).
  const reloaded = new MemoryBlockStore(dir);
  assert.equal(reloaded.getConsolidationConfig().enabled, true);
  assert.ok(reloaded.getConsolidationConfig().lastRunAt);
  // Sau khi chạy, chưa đủ idle -> null.
  assert.equal(runIdleConsolidationIfDue(longTerm, reloaded), null);
});

// ---------------------------------------------------------------------------
// MemFS-lite
// ---------------------------------------------------------------------------

test('memfs: export 1 file/block + facts; frontmatter parse được', () => {
  const { dir, blocks, longTerm } = makeStores();
  const human = blocks.create({ label: 'human', description: 'Về user', content: 'Tên Huy.' });
  blocks.attach('bot-a', human.id);
  blocks.create({ label: 'project-x', content: 'Dự án X.' });
  longTerm.remember({ key: 'Sở thích', value: 'thích phở', confidence: 0.9, tags: ['ăn uống'] });
  const memDir = path.join(dir, 'memfs');
  const result = exportBlocksToMemFs(blocks, memDir, { longTerm });
  assert.equal(result.blockCount, 2);
  assert.deepEqual(result.blockFiles, ['human.md', 'project-x.md']);
  assert.equal(result.factsFile, 'longterm-facts.md');
  assert.equal(result.factCount, 1);
  const humanMd = fs.readFileSync(path.join(memDir, 'human.md'), 'utf8');
  const { data, body } = parseMemFsFrontmatter(humanMd);
  assert.equal(data['label'], 'human');
  assert.equal(data['description'], 'Về user');
  assert.equal(data['readOnly'], false);
  assert.deepEqual(data['attachedBots'], ['bot-a']);
  assert.equal(body.trim(), 'Tên Huy.');
  assert.ok(fs.readFileSync(path.join(memDir, 'longterm-facts.md'), 'utf8').includes('## Sở thích'));
});

test('memfs: import round-trip — tạo mới, import lại thì skip, bản mới hơn thì update', () => {
  const { dir, blocks } = makeStores();
  const src = blocks;
  src.create({ label: 'human', description: 'Về user', content: 'Tên Huy.' });
  src.create({ label: 'notes', content: 'ghi chú v1' });
  src.attach('bot-a', 'human');
  const memDir = path.join(dir, 'memfs');
  exportBlocksToMemFs(src, memDir);

  const dstDir = makeTempDir();
  const dst = new MemoryBlockStore(dstDir);
  const first = importBlocksFromMemFs(dst, memDir);
  assert.deepEqual([first.imported, first.updated, first.skipped], [2, 0, 0]);
  assert.deepEqual(dst.list().map((b) => b.label), ['human', 'notes']);
  assert.deepEqual(dst.attachedBotIds(dst.get('human').id), ['bot-a']);
  // Import lại y hệt -> skip hết (không tạo trùng, không ghi đè).
  const second = importBlocksFromMemFs(dst, memDir);
  assert.deepEqual([second.imported, second.updated, second.skipped], [0, 0, 2]);
  assert.equal(dst.list().length, 2);
  // Sửa file nguồn: nội dung mới + updatedAt mới hơn -> update.
  const notesPath = path.join(memDir, 'notes.md');
  const newer = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    notesPath,
    `---\nlabel: "notes"\ndescription: ""\nscope: "shared"\nreadOnly: false\nversion: 2\nupdatedAt: "${newer}"\ncharLimit: 2000\nattachedBots: []\n---\nghi chú v2\n`,
    'utf8',
  );
  const third = importBlocksFromMemFs(dst, memDir);
  assert.equal(third.updated, 1);
  assert.equal(dst.get('notes')?.content, 'ghi chú v2');
});

test('memfs: import không ghi đè block read-only — ghi conflict', () => {
  const { dir, blocks } = makeStores();
  const b = blocks.create({ label: 'core', content: 'cố định', readOnly: true });
  void b;
  const memDir = path.join(dir, 'memfs');
  fs.mkdirSync(memDir, { recursive: true });
  const newer = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    path.join(memDir, 'core.md'),
    `---\nlabel: "core"\ndescription: ""\nscope: "shared"\nreadOnly: false\nversion: 9\nupdatedAt: "${newer}"\ncharLimit: 2000\nattachedBots: []\n---\nnội dung mới\n`,
    'utf8',
  );
  const result = importBlocksFromMemFs(blocks, memDir);
  assert.equal(result.updated, 0);
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.conflicts[0]?.reason.includes('read-only'));
  assert.equal(blocks.get('core')?.content, 'cố định');
});

test('memfs: facts export/import round-trip, bản mới hơn thắng', () => {
  const { dir, blocks, longTerm } = makeStores();
  longTerm.remember({ key: 'Sở thích', value: 'thích phở', confidence: 0.9, tags: ['ăn uống'] });
  const memDir = path.join(dir, 'memfs');
  exportBlocksToMemFs(blocks, memDir, { longTerm });
  const factsText = fs.readFileSync(path.join(memDir, 'longterm-facts.md'), 'utf8');
  const parsed = parseFactsFile(factsText);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.key, 'Sở thích');
  assert.equal(parsed[0]?.value, 'thích phở');
  assert.deepEqual(parsed[0]?.tags, ['ăn uống']);

  const dstDir = makeTempDir();
  const dstLongTerm = new LongTermMemory(dstDir);
  const first = importFactsFromMemFs(dstLongTerm, memDir);
  assert.deepEqual([first.imported, first.updated, first.skipped], [1, 0, 0]);
  // Import lại -> skip.
  const second = importFactsFromMemFs(dstLongTerm, memDir);
  assert.deepEqual([second.imported, second.updated, second.skipped], [0, 0, 1]);
  // Sửa file: value mới + updatedAt mới hơn -> update.
  const newer = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    path.join(memDir, 'longterm-facts.md'),
    `# Long-term facts\n\n## Sở thích\n- botId: shared\n- confidence: 0.9\n- tags: ăn uống\n- updatedAt: ${newer}\n\nthích phở bò\n`,
    'utf8',
  );
  const third = importFactsFromMemFs(dstLongTerm, memDir);
  assert.equal(third.updated, 1);
  assert.equal(dstLongTerm.recall({ query: 'phở bò' })[0]?.value, 'thích phở bò');
});

test('memfs: import từ thư mục không có file -> kết quả 0, không throw', () => {
  const { blocks } = makeStores();
  const emptyDir = makeTempDir();
  assert.deepEqual(importBlocksFromMemFs(blocks, emptyDir), {
    imported: 0,
    updated: 0,
    skipped: 0,
    conflicts: [],
  });
  const dstDir = makeTempDir();
  assert.deepEqual(importFactsFromMemFs(new LongTermMemory(dstDir), emptyDir), {
    imported: 0,
    updated: 0,
    skipped: 0,
  });
});
