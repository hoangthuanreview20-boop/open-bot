/**
 * Tests cho v0.90e — Đội G: sửa 3 hồi quy do sóng v0.90a/v0.90b gây ra
 * (phát hiện ở lần chạy full suite đầu của nhánh parallel/g-openmausbot).
 *
 *   (1) SILENT RUN: v0.90a gắn harnessSink vào loop + forward mọi bus
 *       event về parent qua notification 'agent.event' — làm vỡ hợp
 *       đồng v0.4 "silent run không đẩy event nào về parent" (test
 *       tests/coordinator-v04.test.mjs đỏ: 3 event harness.event).
 *       Fix: loop/CLI event của run im lặng mang cờ `silent: true`
 *       trên envelope + dòng NDJSON (log vẫn giữ để audit); forwarder
 *       ở coordinator con và SSE (live + replay) bỏ qua event silent.
 *   (2) BotForm: v0.90b gọi `listModelRail()` trần trong useEffect —
 *       mock `openBot` của test v0.77 không có hàm này → TypeError
 *       làm sập cả form (mất field description). Fix: guard typeof.
 *       Test đó (tests/bot-description-v077-renderer.test.mjs) là
 *       hồi quy trực tiếp, không viết lại ở đây.
 *   (3) UI-13: v0.90a thêm destination 'eventlog' vào sidebar → 13
 *       thành 14; test tests/ui-13-smoke.test.mjs cập nhật kỳ vọng.
 *
 * File này chỉ test phần (1) ở mức đơn vị + coordinator in-process:
 *   - publishLoopEvent({silent}) gắn cờ lên envelope + log entry;
 *     không có opts thì KHÔNG có field silent (absent, không phải false).
 *   - setSilentRun + cliEventSink: event CLI trong run im lặng mang cờ
 *     silent; clear cờ thì event sau hết silent.
 *   - coordinator.run({silent: true}) ghi NDJSON toàn entry silent;
 *     run thường ghi entry không có cờ silent.
 * Phần forwarder (stdio child → parent) đã có hồi quy trực tiếp ở
 * tests/coordinator-v04.test.mjs ('silent run: không đẩy event delta').
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-silent-run-v090e.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { LocalHarness } from '../packages/core/dist/harness/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-silent-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeBot(dir, id) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
}

function echoTool() {
  return {
    definition: {
      name: 'echo',
      description: 'Echo back the input.',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    needsApproval: false,
    async execute(args) {
      return `echo: ${args.msg}`;
    },
  };
}

// ---------------------------------------------------------------------------
// (1a) publishLoopEvent — cờ silent lên envelope + NDJSON
// ---------------------------------------------------------------------------

test('v0.90e publishLoopEvent({silent}): envelope + log entry mang cờ silent, log vẫn giữ', () => {
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const seenOnBus = [];
  harness.bus.subscribe({}, (event) => seenOnBus.push(event));

  harness.publishLoopEvent('bot-1', 'bot-1', 'mock', 'text', { text: 'hello' }, { silent: true });

  assert.equal(seenOnBus.length, 1);
  assert.equal(seenOnBus[0].silent, true, 'envelope của run im lặng phải mang silent:true');

  const page = harness.readThreadLog('bot-1', {});
  assert.equal(page.total, 1);
  assert.equal(page.entries[0].silent, true, 'log entry của run im lặng phải mang silent:true');

  const raw = fs.readFileSync(path.join(dataDir, 'harness-logs', 'bot-1.ndjson'), 'utf8');
  assert.ok(raw.includes('"silent":true'), 'dòng NDJSON phải chứa cờ silent');
  assert.ok(raw.includes('hello'), 'log im lặng vẫn giữ nội dung event (audit)');
});

test('v0.90e publishLoopEvent (không opts): run thường KHÔNG có field silent', () => {
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const seenOnBus = [];
  harness.bus.subscribe({}, (event) => seenOnBus.push(event));

  harness.publishLoopEvent('bot-1', 'bot-1', 'mock', 'text', { text: 'hi' });

  assert.equal(seenOnBus.length, 1);
  assert.equal('silent' in seenOnBus[0], false, 'envelope run thường không có field silent');
  const page = harness.readThreadLog('bot-1', {});
  assert.equal(page.total, 1);
  assert.equal('silent' in page.entries[0], false, 'log entry run thường không có field silent');
  const raw = fs.readFileSync(path.join(dataDir, 'harness-logs', 'bot-1.ndjson'), 'utf8');
  assert.ok(!raw.includes('silent'), 'dòng NDJSON run thường không chứa silent');
});

// ---------------------------------------------------------------------------
// (1b) cliEventSink + setSilentRun — event CLI trong run im lặng
// ---------------------------------------------------------------------------

test('v0.90e cliEventSink: setSilentRun(true) thì event CLI mang cờ silent; clear thì hết', () => {
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const seenOnBus = [];
  harness.bus.subscribe({}, (event) => seenOnBus.push(event));
  const sink = harness.cliEventSink('bot-1', 'mock', 'bot-1');

  assert.equal(harness.isSilentRun('bot-1'), false);
  sink({ type: 'text', delta: 'normal' });
  assert.equal(seenOnBus[0].silent, undefined, 'event thường không mang cờ');

  harness.setSilentRun('bot-1', true);
  assert.equal(harness.isSilentRun('bot-1'), true);
  sink({ type: 'text', delta: 'silent delta' });
  assert.equal(seenOnBus[1].silent, true, 'event trong run im lặng phải mang silent:true');

  harness.setSilentRun('bot-1', false);
  assert.equal(harness.isSilentRun('bot-1'), false);
  sink({ type: 'text', delta: 'after' });
  assert.equal(seenOnBus[2].silent, undefined, 'clear cờ xong event sau hết silent');

  const page = harness.readThreadLog('bot-1', {});
  assert.equal(page.total, 3);
  assert.deepEqual(
    page.entries.map((e) => e.silent ?? false),
    [false, true, false],
    'log chỉ entry giữa mang cờ silent',
  );
});

// ---------------------------------------------------------------------------
// (1c) coordinator.run({silent}) — NDJSON toàn entry silent
// ---------------------------------------------------------------------------

test('v0.90e coordinator: run silent ghi NDJSON toàn entry silent; run thường không cờ', async () => {
  const dir = makeTempDir();
  const dataDir = makeTempDir();
  const harness = new LocalHarness({ dataDir });
  const coordinator = new AgentCoordinator({
    dataDir,
    toolFactory: () => [echoTool()],
    emit: () => undefined,
    harness,
  });
  try {
    await coordinator.createBot({
      bot: makeBot(dir, 'bot-silent'),
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [{ text: 'silent ok' }, { text: 'normal ok' }],
      },
    });

    const silentResult = await coordinator.run({ botId: 'bot-silent', text: 'hi', silent: true });
    assert.equal(silentResult.text, 'silent ok');
    // Cờ phải được dọn sau run (event rớt lại sau run không bị gắn nhầm).
    assert.equal(harness.isSilentRun('bot-silent'), false, 'cờ silent phải clear sau run');

    const normalResult = await coordinator.run({ botId: 'bot-silent', text: 'hi again' });
    assert.equal(normalResult.text, 'normal ok');

    const page = await coordinator.handle('harnessThreadLog', { threadId: 'bot-silent' });
    assert.ok(page.total >= 2, 'cả 2 run đều ghi log');
    const silentEntries = page.entries.filter((e) => e.silent === true);
    const normalEntries = page.entries.filter((e) => e.silent !== true);
    assert.ok(silentEntries.length >= 1, 'run silent phải có ít nhất 1 entry mang cờ');
    assert.ok(normalEntries.length >= 1, 'run thường phải có entry không mang cờ');
    // Mọi entry silent đều là turn-start/text/turn-end của run đầu — không
    // lẫn entry run thường (2 run dùng cùng thread = botId nên phân biệt
    // bằng cờ, không bằng thứ tự).
    for (const entry of page.entries) {
      assert.ok(entry.silent === true || entry.silent === undefined, 'silent chỉ true hoặc absent');
    }
  } finally {
    coordinator.shutdown();
  }
});
