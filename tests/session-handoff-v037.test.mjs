/**
 * Tests for v0.37 (P1-3): handoff phiên làm việc — record bền chuyển giao
 * công việc giữa các bot/phiên (kiểu Claude Code / Cursor handoff).
 *
 * Covers:
 *  - `packages/core/src/handoff/` — tạo record (đủ trường, cắt ngắn khi
 *    quá lớn, khử secret), đọc lại record cũ thiếu trường (tương thích
 *    ngược), render khối ngữ cảnh cho bot nhận, store file JSON
 *    (persist, cap, file hỏng).
 *  - `packages/tools/src/handoffTools.ts` — tool agent `create_handoff`
 *    (factory + callback, lỗi rõ khi thiếu callback).
 *  - Coordinator RPC (`listHandoffs` / `getHandoff` / `createHandoffRecord`
 *    / `acceptHandoff`) + tham số run `handoffId` (nạp record vào đúng
 *    run qua mock provider, kèm xác nhận trong RunResult).
 *
 * Khác handoff trực tiếp v0.12 (`transfer_to_X` — chuyển ngay trong run):
 * record ở đây là bản bàn giao BỀN, bot nhận chạy ở run khác, có thể
 * nhiều giờ sau. Không sửa `loop.ts` / `runSubagent` / subagent.
 *
 * No real API key, no network. Mock provider + in-process coordinator.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/session-handoff-v037.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SESSION_HANDOFFS_FILE_NAME,
  SessionHandoffStore,
  acceptedHandoffConfirmation,
  createSessionHandoff,
  formatSessionHandoffForPrompt,
  parseSessionHandoffRecord,
  redactHandoffText,
  sessionHandoffSummary,
} from '../packages/core/dist/handoff/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import {
  SESSION_HANDOFF_TOOLS,
  SESSION_HANDOFF_TOOL_NAMES,
  createSessionHandoffTools,
} from '../packages/tools/dist/handoffTools.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const BASE_INPUT = {
  fromBotId: 'bot-a',
  fromBotName: 'Bot A',
  toBotId: 'bot-b',
  toBotName: 'Bot B',
  title: 'Thêm tool create_handoff',
  workStatus: 'in-progress',
  taskSummary: 'Thêm tool create_handoff cho open-bot.',
  currentState: 'Đã viết xong module core, đang viết test.',
  completed: ['module core handoff', 'tool create_handoff'],
  remaining: ['viết test', 'chạy build + typecheck'],
  nextStep: 'viết test',
  filesChanged: ['packages/core/src/handoff/record.ts'],
  filesRelevant: ['packages/core/src/coordinator/coordinator.ts'],
  decisions: [{ decision: 'Lưu record dạng JSON', reason: 'đơn giản, đọc được bằng tay' }],
  blockers: [{ description: 'chưa có API key thật', attempted: 'dùng mock provider' }],
  context: 'Repo local ~/workspace/open-bot, branch main.',
  transcriptExcerpt: [
    { role: 'user', content: 'Làm handoff P1-3 đi' },
    { role: 'assistant', content: 'Đã xong module core.' },
  ],
};

// ---------------------------------------------------------------------------
// 1. Tạo record: đủ trường, cắt ngắn, khử secret, validate
// ---------------------------------------------------------------------------

test('tạo record đủ trường: version/id/createdAt + mọi danh sách giữ nguyên', () => {
  const record = createSessionHandoff(BASE_INPUT);
  assert.equal(record.version, 1);
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
  assert.equal(record.title, 'Thêm tool create_handoff');
  assert.equal(record.fromBotId, 'bot-a');
  assert.equal(record.toBotId, 'bot-b');
  assert.equal(record.workStatus, 'in-progress');
  assert.deepEqual(record.completed, ['module core handoff', 'tool create_handoff']);
  assert.deepEqual(record.remaining, ['viết test', 'chạy build + typecheck']);
  assert.equal(record.nextStep, 'viết test');
  assert.deepEqual(record.decisions, [
    { decision: 'Lưu record dạng JSON', reason: 'đơn giản, đọc được bằng tay' },
  ]);
  assert.deepEqual(record.transcriptExcerpt, BASE_INPUT.transcriptExcerpt);
  assert.equal(record.truncated, false);
  assert.deepEqual(record.truncatedFields, []);
  assert.equal(record.redacted, false);
  assert.deepEqual(record.chain, []);
});

test('cắt ngắn khi quá lớn: context dài, quá 20 việc, title dài đều bị cắt + ghi trường', () => {
  const record = createSessionHandoff({
    ...BASE_INPUT,
    title: 'T'.repeat(300),
    context: 'x'.repeat(9_000),
    completed: Array.from({ length: 25 }, (_, i) => `việc ${i + 1}`),
    remaining: ['a'.repeat(600)],
    transcriptExcerpt: [
      { role: 'user', content: 'u'.repeat(6_000) },
      { role: 'assistant', content: 'v'.repeat(6_000) },
    ],
  });
  assert.equal(record.truncated, true);
  assert.ok(record.truncatedFields.includes('title'));
  assert.ok(record.truncatedFields.includes('context'));
  assert.ok(record.truncatedFields.includes('completed'));
  assert.ok(record.truncatedFields.includes('remaining'));
  assert.ok(record.truncatedFields.includes('transcriptExcerpt'));
  assert.equal(record.completed.length, 20);
  assert.ok(record.context.length < 9_000);
  assert.match(record.context, /\[\.\.\. đã cắt ngắn/);
  assert.ok(record.title.length < 300);
  const excerptTotal = record.transcriptExcerpt.reduce((s, m) => s + m.content.length, 0);
  assert.ok(excerptTotal <= 10_000 + 100, `excerpt ${excerptTotal} ký tự phải ≤ ~10.000`);
});

test('khử secret: sk-…/Bearer/apiKey/secret đã biết đều thành <redacted>, không lọt vào JSON', () => {
  const knownSecret = 'my-known-api-key-12345';
  const record = createSessionHandoff(
    {
      ...BASE_INPUT,
      context:
        `Key test: sk-abcdefgh12345678 và xai-0123456789abcdef. ` +
        `Authorization: Bearer abcdefghijklmnop. apiKey: ${knownSecret}. ` +
        `Ghi chú: ${knownSecret} dùng để test.`,
      currentState: 'password: hunter2-khong-phai-secret-that',
    },
    { secrets: [knownSecret] },
  );
  assert.equal(record.redacted, true);
  const json = JSON.stringify(record);
  assert.ok(!json.includes('sk-abcdefgh12345678'), 'key sk-… không được lọt vào record');
  assert.ok(!json.includes('xai-0123456789abcdef'), 'key xai-… không được lọt vào record');
  assert.ok(!json.includes('abcdefghijklmnop'), 'Bearer token không được lọt vào record');
  assert.ok(!json.includes(knownSecret), 'secret đã biết không được lọt vào record');
  assert.ok(json.includes('<redacted>'));
  // Văn bản thường không bị khử nhầm.
  assert.match(record.context, /Key test:/);
});

test('redactHandoffText: khử Bearer + dạng key, giữ nguyên text thường', () => {
  const { text, redacted } = redactHandoffText('gọi API với Bearer abcdef123456 và key sk-abcdefgh1234');
  assert.equal(redacted, true);
  assert.match(text, /Bearer <redacted>/);
  assert.match(text, /<redacted>/);
  assert.doesNotMatch(text, /abcdef123456/);
  assert.equal(redactHandoffText('không có gì nhạy cảm').redacted, false);
});

test('validate: from rỗng, handoff cho chính mình, không có nội dung đều ném lỗi rõ', () => {
  assert.throws(
    () => createSessionHandoff({ ...BASE_INPUT, fromBotId: '  ' }),
    /fromBotId/,
  );
  assert.throws(
    () => createSessionHandoff({ ...BASE_INPUT, fromBotName: '' }),
    /fromBotName/,
  );
  assert.throws(
    () => createSessionHandoff({ ...BASE_INPUT, toBotId: 'bot-a' }),
    /chính mình/,
  );
  assert.throws(
    () => createSessionHandoff({ ...BASE_INPUT, toBotName: 'Bot A', toBotId: undefined }),
    /chính mình/,
  );
  assert.throws(
    () =>
      createSessionHandoff({
        fromBotId: 'a',
        fromBotName: 'A',
        title: '',
        taskSummary: '',
        currentState: '',
        remaining: [],
        context: '',
      }),
    /ít nhất một nội dung/,
  );
});

test('formatSessionHandoffForPrompt: đủ mục + ghi chú cắt ngắn/khử secret', () => {
  const record = createSessionHandoff({
    ...BASE_INPUT,
    context: 'c'.repeat(9_000),
    blockers: ['đang kẹt ở bước test'],
  });
  const block = formatSessionHandoffForPrompt(record);
  assert.match(block, /\[handoff nhận\] Bot "Bot A" bàn giao/);
  assert.match(block, /Tiêu đề: Thêm tool create_handoff/);
  assert.match(block, /Bước tiếp theo: viết test/);
  assert.match(block, /- module core handoff/);
  assert.match(block, /- viết test/);
  assert.match(block, /File đã đổi: packages\/core\/src\/handoff\/record\.ts/);
  assert.match(block, /Quyết định đã chốt:/);
  assert.match(block, /Lỗi\/blocker đang gặp:/);
  assert.match(block, /đang kẹt ở bước test/);
  assert.match(block, /- \[user\] Làm handoff P1-3 đi/);
  assert.match(block, /đã bị cắt ngắn khi lưu \(context\)/);
  assert.match(block, /Tiếp tục công việc từ bước tiếp theo/);
});

// ---------------------------------------------------------------------------
// 2. Tương thích ngược: record cũ thiếu trường vẫn đọc được
// ---------------------------------------------------------------------------

test('parseSessionHandoffRecord: record cũ thiếu trường nhận giá trị mặc định', () => {
  const old = {
    id: 'old-id-1',
    fromBotId: 'bot-a',
    title: 'Việc cũ',
    taskSummary: 'Việc từ phiên trước.',
    // Không có: version, fromBotName, workStatus, completed, remaining,
    // decisions, blockers, context, transcriptExcerpt, truncated...
  };
  const record = parseSessionHandoffRecord(old);
  assert.ok(record);
  assert.equal(record.version, 1);
  assert.equal(record.id, 'old-id-1');
  assert.equal(record.fromBotName, 'bot-a');
  assert.equal(record.workStatus, 'in-progress');
  assert.deepEqual(record.completed, []);
  assert.deepEqual(record.remaining, []);
  assert.deepEqual(record.decisions, []);
  assert.deepEqual(record.blockers, []);
  assert.equal(record.context, '');
  assert.deepEqual(record.transcriptExcerpt, []);
  assert.equal(record.truncated, false);
  assert.equal(record.redacted, false);
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
});

test('parseSessionHandoffRecord: workStatus lạ → in-progress; thiếu title → suy ra từ taskSummary', () => {
  const record = parseSessionHandoffRecord({
    fromBotId: 'a',
    fromBotName: 'A',
    workStatus: 'đang-làm-kiểu-lạ',
    taskSummary: 'Sửa lỗi đăng nhập.',
  });
  assert.ok(record);
  assert.equal(record.workStatus, 'in-progress');
  assert.equal(record.title, 'Sửa lỗi đăng nhập.');
  const untitled = parseSessionHandoffRecord({ fromBotId: 'a' });
  assert.ok(untitled);
  assert.equal(untitled.title, '(không tiêu đề)');
});

test('parseSessionHandoffRecord: không phải object / thiếu fromBotId → null', () => {
  assert.equal(parseSessionHandoffRecord(null), null);
  assert.equal(parseSessionHandoffRecord('chuỗi'), null);
  assert.equal(parseSessionHandoffRecord([]), null);
  assert.equal(parseSessionHandoffRecord({}), null);
  assert.equal(parseSessionHandoffRecord({ fromBotId: '   ' }), null);
  assert.equal(parseSessionHandoffRecord({ fromBotId: 123 }), null);
});

test('sessionHandoffSummary + acceptedHandoffConfirmation: dạng gọn đủ đếm', () => {
  const record = createSessionHandoff(BASE_INPUT);
  const summary = sessionHandoffSummary(record);
  assert.equal(summary.id, record.id);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.remainingCount, 2);
  assert.equal(summary.filesChangedCount, 1);
  assert.equal(summary.blockersCount, 1);
  assert.equal(summary.nextStep, 'viết test');
  assert.equal('transcriptExcerpt' in summary, false);
  const confirmation = acceptedHandoffConfirmation(record, '2026-11-09T00:00:00.000Z');
  assert.equal(confirmation.id, record.id);
  assert.equal(confirmation.acceptedAt, '2026-11-09T00:00:00.000Z');
  assert.equal(confirmation.fromBotName, 'Bot A');
});

// ---------------------------------------------------------------------------
// 3. Store: memory-only + file JSON (persist, cap, file hỏng)
// ---------------------------------------------------------------------------

test('store memory-only: save/get/list/filter/markAccepted/remove', () => {
  const store = new SessionHandoffStore();
  const r1 = store.save(createSessionHandoff({ ...BASE_INPUT, title: 'Việc 1' }));
  const r2 = store.save(
    createSessionHandoff({
      ...BASE_INPUT,
      fromBotId: 'bot-c',
      fromBotName: 'Bot C',
      title: 'Việc 2',
      workStatus: 'blocked',
    }),
  );
  assert.equal(store.get(r1.id).title, 'Việc 1');
  assert.equal(store.get('không-có'), null);
  // Mới nhất trước.
  assert.deepEqual(store.list().map((r) => r.id), [r2.id, r1.id]);
  assert.deepEqual(store.list({ toBotId: 'bot-b' }).map((r) => r.id), [r2.id, r1.id]);
  assert.deepEqual(store.list({ fromBotId: 'bot-c' }).map((r) => r.id), [r2.id]);
  assert.deepEqual(store.list({ workStatus: 'blocked' }).map((r) => r.id), [r2.id]);
  assert.deepEqual(store.list({ limit: 1 }).map((r) => r.id), [r2.id]);
  assert.equal(store.listSummaries().length, 2);
  assert.equal(store.listSummaries()[0].completedCount, 2);

  const accepted = store.markAccepted(r1.id, { botId: 'bot-b', botName: 'Bot B' });
  assert.equal(accepted.acceptedByBotId, 'bot-b');
  assert.ok(accepted.acceptedAt);
  assert.equal(store.markAccepted('không-có', { botId: 'x', botName: 'X' }), null);
  assert.equal(store.remove(r2.id), true);
  assert.equal(store.remove(r2.id), false);
  assert.equal(store.list().length, 1);
});

test('store cap 50: lưu thêm thì record cũ nhất bị bỏ', () => {
  const store = new SessionHandoffStore();
  for (let i = 0; i < 55; i++) {
    store.save(createSessionHandoff({ ...BASE_INPUT, title: `Việc ${i}` }));
  }
  const listed = store.list();
  assert.equal(listed.length, 50);
  assert.equal(listed[0].title, 'Việc 54');
  assert.equal(listed[49].title, 'Việc 5');
});

test('store file: persist JSON + mode 0600, instance mới đọc lại được, file hỏng thì bắt đầu rỗng', () => {
  const dir = makeTempDir('open-bot-handoff-store-');
  const filePath = path.join(dir, SESSION_HANDOFFS_FILE_NAME);
  const store = new SessionHandoffStore(filePath);
  const saved = store.save(createSessionHandoff(BASE_INPUT));
  assert.ok(fs.existsSync(filePath));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.records.length, 1);

  const reopened = new SessionHandoffStore(filePath);
  assert.equal(reopened.get(saved.id).title, 'Thêm tool create_handoff');

  // File JSON hỏng hẳn → bắt đầu rỗng, không throw.
  fs.writeFileSync(filePath, '{ json hỏng', 'utf8');
  const broken = new SessionHandoffStore(filePath);
  assert.deepEqual(broken.list(), []);

  // Một record hỏng trong file → bỏ qua entry đó, giữ record tốt.
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, records: [{ nope: true }, { ...BASE_INPUT, id: 'good-1' }] }),
    'utf8',
  );
  const partial = new SessionHandoffStore(filePath);
  assert.deepEqual(partial.list().map((r) => r.id), ['good-1']);
});

// ---------------------------------------------------------------------------
// 4. Tool agent create_handoff
// ---------------------------------------------------------------------------

test('tool create_handoff: lưu record + trả xác nhận có id/title/bước tiếp theo', async () => {
  const saved = [];
  const tools = createSessionHandoffTools({
    botId: 'bot-a',
    botName: 'Bot A',
    getTranscript: () => [
      { role: 'user', content: 'Làm handoff P1-3 đi' },
      { role: 'assistant', content: 'Đã xong module core.' },
    ],
    saveRecord: (record) => {
      saved.push(record);
    },
  });
  assert.deepEqual(tools.map((t) => t.definition.name), ['create_handoff']);
  assert.deepEqual(SESSION_HANDOFF_TOOL_NAMES, ['create_handoff']);
  const tool = tools[0];
  assert.equal(tool.needsApproval, false);
  const output = await tool.execute(
    {
      toBot: 'Bot B',
      title: 'Thêm tool create_handoff',
      taskSummary: 'Thêm tool create_handoff cho open-bot.',
      currentState: 'Đã viết xong module core.',
      completed: ['module core handoff'],
      remaining: ['viết test'],
      nextStep: 'viết test',
      context: 'key test sk-abcdefgh12345678 phải bị khử',
    },
    { workspaceDir: os.tmpdir(), botId: 'bot-a' },
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].fromBotId, 'bot-a');
  assert.equal(saved[0].toBotName, 'Bot B');
  assert.equal(saved[0].transcriptExcerpt.length, 2);
  assert.equal(saved[0].redacted, true);
  assert.ok(!JSON.stringify(saved[0]).includes('sk-abcdefgh12345678'));
  assert.match(output, /Đã lưu handoff "Thêm tool create_handoff" \(id: /);
  assert.match(output, /Đã xong 1 việc, còn lại 1 việc/);
  assert.match(output, /handoffId "/);
  assert.match(output, /đã khử secret/);
});

test('tool create_handoff: thiếu saveRecord / thiếu bot → trả lỗi rõ, không throw', async () => {
  const noStore = createSessionHandoffTools({ botId: 'bot-a', botName: 'Bot A' })[0];
  assert.match(await noStore.execute({ title: 'x', taskSummary: 'y' }, {}), /thiếu saveRecord/);
  const noBot = createSessionHandoffTools({ saveRecord: () => {} })[0];
  assert.match(await noBot.execute({ title: 'x', taskSummary: 'y' }, {}), /thiếu botId\/botName/);
  const empty = createSessionHandoffTools({
    botId: 'bot-a',
    botName: 'Bot A',
    saveRecord: () => {},
  })[0];
  assert.match(await empty.execute({}, {}), /ít nhất một nội dung/);
  // Placeholder chưa cấu hình cũng trả lỗi rõ (không throw).
  assert.match(
    await SESSION_HANDOFF_TOOLS[0].execute({ title: 'x', taskSummary: 'y' }, {}),
    /thiếu botId\/botName|thiếu saveRecord/,
  );
});

// ---------------------------------------------------------------------------
// 5. Coordinator RPC + run với handoffId (mock provider, in-process)
// ---------------------------------------------------------------------------

function makeHandoffCoordinator(dataDir) {
  const coordinator = new AgentCoordinator({ dataDir });
  return { coordinator };
}

async function createMockBot(coordinator, botId, dir, mockResponses, extraProvider = {}) {
  await coordinator.createBot({
    bot: {
      id: botId,
      name: `Bot ${botId}`,
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: dir,
      autoApprove: false,
    },
    provider: { id: 'mock', label: 'Mock', mockResponses, ...extraProvider },
  });
}

test('coordinator RPC: tạo/liệt kê/đọc/nhận handoff + file handoffs.json không chứa secret', async () => {
  const dataDir = makeTempDir('open-bot-handoff-data-');
  const dirA = makeTempDir('open-bot-handoff-a-');
  const dirB = makeTempDir('open-bot-handoff-b-');
  const { coordinator } = makeHandoffCoordinator(dataDir);
  try {
    await createMockBot(coordinator, 'bot-a', dirA, [{ text: 'a xong' }]);
    await createMockBot(coordinator, 'bot-b', dirB, [{ text: 'b xong' }]);
    // Lịch sử bot A (main lưu qua saveMessage như desktop thật).
    await coordinator.saveMessage({ botId: 'bot-a', role: 'user', content: 'Làm handoff P1-3 đi' });
    await coordinator.saveMessage({ botId: 'bot-a', role: 'assistant', content: 'Đã xong module core.' });

    assert.deepEqual((await coordinator.listHandoffs()).handoffs, []);
    const { record } = await coordinator.createHandoffRecord({
      botId: 'bot-a',
      toBotId: 'bot-b',
      title: 'Thêm tool create_handoff',
      taskSummary: 'Thêm tool create_handoff cho open-bot.',
      currentState: 'Đã viết xong module core.',
      completed: ['module core handoff'],
      remaining: ['viết test'],
      nextStep: 'viết test',
      context: 'key test sk-abcdefgh12345678 phải bị khử',
    });
    assert.equal(record.fromBotId, 'bot-a');
    assert.equal(record.toBotId, 'bot-b');
    assert.equal(record.toBotName, 'Bot bot-b');
    assert.equal(record.transcriptExcerpt.length, 2);
    assert.match(record.transcriptExcerpt[0].content, /Làm handoff P1-3/);
    assert.equal(record.redacted, true);
    // File đã persist + không chứa secret.
    const filePath = path.join(dataDir, SESSION_HANDOFFS_FILE_NAME);
    assert.ok(fs.existsSync(filePath));
    assert.ok(!fs.readFileSync(filePath, 'utf8').includes('sk-abcdefgh12345678'));

    const listed = await coordinator.listHandoffs();
    assert.equal(listed.handoffs.length, 1);
    assert.equal(listed.handoffs[0].id, record.id);
    assert.equal(listed.handoffs[0].completedCount, 1);
    assert.deepEqual((await coordinator.listHandoffs({ fromBotId: 'bot-a' })).handoffs.length, 1);
    assert.deepEqual((await coordinator.listHandoffs({ fromBotId: 'bot-z' })).handoffs, []);
    assert.deepEqual(
      (await coordinator.listHandoffs({ workStatus: 'blocked' })).handoffs,
      [],
    );
    assert.equal((await coordinator.getHandoff({ id: record.id })).record.title, 'Thêm tool create_handoff');
    assert.throws(() => coordinator.getHandoff({ id: 'không-có' }), /Không có handoff/);

    // Nhận sai bot → lỗi rõ (record dành cho bot-b).
    assert.throws(() => coordinator.acceptHandoff({ id: record.id, botId: 'bot-a' }), /dành cho bot/);
    // Nhận đúng bot → trả record + promptBlock + confirmation.
    const accepted = await coordinator.acceptHandoff({ id: record.id, botId: 'bot-b' });
    assert.equal(accepted.record.acceptedByBotId, 'bot-b');
    assert.match(accepted.promptBlock, /\[handoff nhận\] Bot "Bot bot-a" bàn giao/);
    assert.match(accepted.promptBlock, /Bước tiếp theo: viết test/);
    assert.equal(accepted.confirmation.id, record.id);
    assert.equal(accepted.confirmation.completedCount, 1);
    assert.equal(accepted.confirmation.remainingCount, 1);
    assert.ok(accepted.confirmation.acceptedAt);

    // Lỗi validate RPC.
    assert.throws(
      () => coordinator.createHandoffRecord({ botId: 'bot-a', toBotId: 'bot-chưa-có' }),
      /Chưa tạo bot/,
    );
    assert.throws(
      () => coordinator.createHandoffRecord({ botId: 'bot-a', previousHandoffId: 'không-có' }),
      /Không có handoff trước/,
    );
    assert.throws(() => coordinator.acceptHandoff({ id: record.id, botId: '' }), /{id, botId}/);
  } finally {
    coordinator.shutdown();
  }
});

test('run với handoffId: ngữ cảnh vào đúng run (mock thấy khối handoff) + RunResult xác nhận', async () => {
  const dataDir = makeTempDir('open-bot-handoff-run-');
  const dirA = makeTempDir('open-bot-handoff-run-a-');
  const dirB = makeTempDir('open-bot-handoff-run-b-');
  const recordPath = path.join(dataDir, 'mock-calls-b.jsonl');
  const { coordinator } = makeHandoffCoordinator(dataDir);
  try {
    await createMockBot(coordinator, 'bot-a', dirA, [{ text: 'a xong' }]);
    await createMockBot(coordinator, 'bot-b', dirB, [{ text: 'b nhận việc, làm tiếp đây' }], {
      mockRecordPath: recordPath,
    });
    const { record } = await coordinator.createHandoffRecord({
      botId: 'bot-a',
      toBotId: 'bot-b',
      title: 'Thêm tool create_handoff',
      taskSummary: 'Thêm tool create_handoff cho open-bot.',
      completed: ['module core handoff'],
      remaining: ['viết test'],
      nextStep: 'viết test',
      includeTranscript: false,
    });

    const result = await coordinator.run({
      botId: 'bot-b',
      text: 'Tiếp tục làm đi',
      handoffId: record.id,
    });
    assert.equal(result.text, 'b nhận việc, làm tiếp đây');
    assert.ok(result.acceptedHandoff, 'RunResult phải có acceptedHandoff');
    assert.equal(result.acceptedHandoff.id, record.id);
    assert.equal(result.acceptedHandoff.title, 'Thêm tool create_handoff');
    assert.equal(result.acceptedHandoff.completedCount, 1);
    assert.equal(result.acceptedHandoff.remainingCount, 1);
    // Mock provider nhận đúng khối handoff trong request.
    const calls = fs
      .readFileSync(recordPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    const userText = calls[0].messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    assert.match(userText, /\[handoff nhận\] Bot "Bot bot-a" bàn giao/);
    assert.match(userText, /Bước tiếp theo: viết test/);
    assert.match(userText, /Tiếp tục làm đi/);
    // Record đã ghi run nào nạp nó.
    const stored = (await coordinator.getHandoff({ id: record.id })).record;
    assert.equal(stored.acceptedByBotId, 'bot-b');
    assert.equal(stored.acceptedRunId, result.runId);

    // Lỗi: id lạ, id rỗng, kèm resumeRunId, record dành cho bot khác.
    await assert.rejects(
      () => coordinator.run({ botId: 'bot-b', text: 'x', handoffId: 'không-có' }),
      /Không có handoff/,
    );
    await assert.rejects(
      () => coordinator.run({ botId: 'bot-b', text: 'x', handoffId: '   ' }),
      /handoffId phải là id record không rỗng/,
    );
    await assert.rejects(
      () =>
        coordinator.run({
          botId: 'bot-b',
          text: 'x',
          handoffId: record.id,
          resumeRunId: 'run-cu',
        }),
      /resumeRunId/,
    );
    const { record: forA } = await coordinator.createHandoffRecord({
      botId: 'bot-b',
      toBotId: 'bot-a',
      title: 'Việc cho A',
      taskSummary: 'Việc chỉ A làm.',
    });
    await assert.rejects(
      () => coordinator.run({ botId: 'bot-b', text: 'x', handoffId: forA.id }),
      /dành cho bot/,
    );
  } finally {
    coordinator.shutdown();
  }
});

test('tool create_handoff trong run thật: mock gọi tool → record lưu vào store coordinator', async () => {
  const dataDir = makeTempDir('open-bot-handoff-toolrun-');
  const dirA = makeTempDir('open-bot-handoff-toolrun-a-');
  const { coordinator } = makeHandoffCoordinator(dataDir);
  try {
    await createMockBot(coordinator, 'bot-a', dirA, [
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'create_handoff',
            args: {
              title: 'Bàn giao từ tool',
              taskSummary: 'Việc đang làm dở, cần bàn giao.',
              completed: ['bước 1'],
              remaining: ['bước 2'],
              nextStep: 'bước 2',
            },
          },
        ],
      },
      { text: 'đã bàn giao xong' },
    ]);
    const result = await coordinator.run({ botId: 'bot-a', text: 'bàn giao việc này đi' });
    assert.equal(result.text, 'đã bàn giao xong');
    const listed = await coordinator.listHandoffs();
    assert.equal(listed.handoffs.length, 1);
    assert.equal(listed.handoffs[0].title, 'Bàn giao từ tool');
    assert.equal(listed.handoffs[0].fromBotId, 'bot-a');
    assert.equal(listed.handoffs[0].remainingCount, 1);
    assert.equal(listed.handoffs[0].nextStep, 'bước 2');
  } finally {
    coordinator.shutdown();
  }
});

// v0.37 (điều phối viên nối thêm): lỗi sớm trong executeRun (vd resumeRunId
// sai — throw TRƯỚC khối try/finally chính) không được để entry.running
// kẹt true: run sau của cùng bot phải chạy được, không treo trong hàng
// đợi mãi. Không có fix này thì run thứ hai treo vĩnh viễn (test timeout).
test('run với resumeRunId sai: lỗi trả về, run sau vẫn chạy được (không kẹt running)', async () => {
  const dataDir = makeTempDir('open-bot-handoff-resume-');
  const dirB = makeTempDir('open-bot-handoff-resume-b-');
  const { coordinator } = makeHandoffCoordinator(dataDir);
  try {
    await createMockBot(coordinator, 'bot-b', dirB, [{ text: 'b vẫn chạy' }]);
    await assert.rejects(
      () => coordinator.run({ botId: 'bot-b', text: 'x', resumeRunId: 'không-có' }),
      /Không resume được run/,
    );
    const result = await coordinator.run({ botId: 'bot-b', text: 'chạy tiếp đi' });
    assert.equal(result.text, 'b vẫn chạy');
  } finally {
    coordinator.shutdown();
  }
});
