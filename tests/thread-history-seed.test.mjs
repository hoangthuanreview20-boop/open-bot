/**
 * Tests for thread-history seeding (v0.60, sóng sau v0.59 UI-5):
 *   - `packages/core/src/agent/threadHistory.ts` — pure selector:
 *     keep most recent, cap by message count + estimated tokens,
 *     drop the just-saved current user message and tool-role rows.
 *   - `packages/core/src/agent/loop.ts` — `historyMessages` option:
 *     `[system, ...history, user]`, `initialMessages` (resume) wins.
 *   - `packages/core/src/coordinator/coordinator.ts` — `executeRun`
 *     seeds history from `RunParams.threadId` (BotMemory thread);
 *     empty thread runs exactly as before; unknown thread fails fast
 *     and does not wedge the bot.
 *
 * No real API key, no network. Mock provider + in-process coordinator;
 * provider requests are captured through the mock's `mockRecordPath`
 * JSONL file (v0.25 W18a test hook).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/thread-history-seed.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  THREAD_HISTORY_MAX_MESSAGES,
  THREAD_HISTORY_MAX_TOKENS,
  selectThreadHistory,
  threadHistoryTokenBudget,
} from '../packages/core/dist/agent/threadHistory.js';
import { estimateTokens } from '../packages/core/dist/agent/tokens.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function msg(role, content) {
  return { role, content };
}

function historyTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// ---------------------------------------------------------------------------
// 1. Pure selector
// ---------------------------------------------------------------------------

test('selector: giữ đúng thứ tự cũ → mới, cắt từ đầu khi quá maxMessages', () => {
  const history = [];
  for (let i = 0; i < 60; i++) {
    history.push(msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`));
  }
  const kept = selectThreadHistory(history, { maxMessages: 50 });
  assert.equal(kept.length, 50);
  assert.equal(kept[0].content, 'turn 10');
  assert.equal(kept[49].content, 'turn 59');
  // Mặc định cũng là 50.
  assert.equal(selectThreadHistory(history).length, THREAD_HISTORY_MAX_MESSAGES);
  assert.equal(THREAD_HISTORY_MAX_MESSAGES, 50);
});

test('selector: cap token được tôn trọng — history dài bị cắt, chỉ giữ lượt gần nhất', () => {
  const long = 'nội dung dài '.repeat(100); // ~1.300 token ước lượng
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push(msg(i % 2 === 0 ? 'user' : 'assistant', `${long} #${i}`));
  }
  const budget = 3000;
  const kept = selectThreadHistory(history, { maxTokens: budget });
  assert.ok(kept.length >= 1, 'phải giữ được ít nhất lượt gần nhất');
  assert.ok(kept.length < history.length, 'history dài phải bị cắt');
  assert.ok(historyTokens(kept) <= budget, `tổng token ${historyTokens(kept)} phải ≤ ${budget}`);
  // Lượt gần nhất (cuối cùng) luôn còn.
  assert.equal(kept[kept.length - 1].content, history[history.length - 1].content);
  // Cắt từ đầu: các message còn lại là một hậu tố liên tục của history.
  assert.equal(kept[0].content, history[history.length - kept.length].content);
});

test('selector: một message đơn lẻ vượt budget thì history rỗng (cap là bất biến cứng)', () => {
  const kept = selectThreadHistory([msg('user', 'x'.repeat(10000))], { maxTokens: 100 });
  assert.deepEqual(kept, []);
});

test('selector: bỏ message user cuối trùng tin hiện tại (đã lưu trước run), giữ lượt cũ trùng câu', () => {
  const history = [
    msg('user', 'xin chào'),
    msg('assistant', 'chào bạn'),
    msg('user', 'xin chào'), // lượt trước trùng câu — không phải tin hiện tại
    msg('assistant', 'bạn cần gì?'),
    msg('user', 'câu hỏi mới'), // tin hiện tại, main đã lưu trước khi run
  ];
  const kept = selectThreadHistory(history, { currentText: 'câu hỏi mới' });
  assert.deepEqual(
    kept.map((m) => m.content),
    ['xin chào', 'chào bạn', 'xin chào', 'bạn cần gì?'],
  );
  // Không truyền currentText thì không bỏ gì.
  assert.equal(selectThreadHistory(history).length, 5);
});

test('selector: bỏ message role tool, giữ user/assistant/system; rỗng vào rỗng ra', () => {
  const history = [
    msg('system', 'ghi chú hệ thống'),
    msg('user', 'hỏi'),
    { role: 'tool', content: 'kết quả tool', toolCallId: 'c1' },
    msg('assistant', 'đáp'),
  ];
  const kept = selectThreadHistory(history);
  assert.deepEqual(
    kept.map((m) => m.role),
    ['system', 'user', 'assistant'],
  );
  assert.deepEqual(selectThreadHistory([]), []);
  assert.deepEqual(selectThreadHistory([msg('user', 'a')], { maxMessages: 0 }), []);
  assert.deepEqual(selectThreadHistory([msg('user', 'a')], { maxTokens: 0 }), []);
});

test('budget: không quá 1/4 context, trần tuyệt đối 8000', () => {
  assert.equal(THREAD_HISTORY_MAX_TOKENS, 8000);
  assert.equal(threadHistoryTokenBudget(4096), 1024); // Ollama đo được (qwen2.5:0.5b)
  assert.equal(threadHistoryTokenBudget(8192), 2048);
  assert.equal(threadHistoryTokenBudget(131072), 8000); // trần tuyệt đối thắng
  assert.equal(threadHistoryTokenBudget(undefined), 8000);
  assert.equal(threadHistoryTokenBudget(0), 8000);
});

// ---------------------------------------------------------------------------
// 2. Loop: historyMessages chèn giữa system và tin mới
// ---------------------------------------------------------------------------

function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      // Snapshot: runLoop mutate mảng messages sau khi chat() trả về
      // (append reply assistant) nên phải copy, không giữ tham chiếu.
      seenRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeBot(workspaceDir) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function makeEvents() {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onApprovalNeeded: async () => true,
  };
}

test('loop: historyMessages → [system, ...history, user], system vẫn đầy đủ', async () => {
  const dir = makeTempDir('open-bot-thread-seed-loop-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'đáp' }], seen);
  const history = [msg('user', 'câu cũ'), msg('assistant', 'đáp cũ')];
  const runner = new AgentRunner(provider, [], {
    bot: makeBot(dir),
    events: makeEvents(),
    historyMessages: history,
  });
  assert.equal(await runner.run('câu mới'), 'đáp');
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0].messages.map((m) => [m.role, m.content]),
    [
      ['system', 'You are a test bot.'],
      ['user', 'câu cũ'],
      ['assistant', 'đáp cũ'],
      ['user', 'câu mới'],
    ],
  );
});

test('loop: không có historyMessages thì [system, user] như trước', async () => {
  const dir = makeTempDir('open-bot-thread-seed-loop-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'đáp' }], seen);
  const runner = new AgentRunner(provider, [], {
    bot: makeBot(dir),
    events: makeEvents(),
  });
  assert.equal(await runner.run('câu mới'), 'đáp');
  assert.deepEqual(
    seen[0].messages.map((m) => [m.role, m.content]),
    [
      ['system', 'You are a test bot.'],
      ['user', 'câu mới'],
    ],
  );
});

test('loop: initialMessages (resume) thắng historyMessages', async () => {
  const dir = makeTempDir('open-bot-thread-seed-loop-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'đáp' }], seen);
  const resumed = [
    msg('system', 'System của run cũ.'),
    msg('user', 'yêu cầu của run cũ'),
  ];
  const runner = new AgentRunner(provider, [], {
    bot: makeBot(dir),
    events: makeEvents(),
    initialMessages: resumed,
    historyMessages: [msg('user', 'history phải bị bỏ qua')],
  });
  assert.equal(await runner.run('tin này bị bỏ qua vì resume'), 'đáp');
  // `resumed` bị loop mutate (append reply) nên so với literal, không
  // so với biến `resumed` nữa; snapshot trong `seen` giữ nguyên lúc gửi.
  assert.deepEqual(seen[0].messages, [
    { role: 'system', content: 'System của run cũ.' },
    { role: 'user', content: 'yêu cầu của run cũ' },
  ]);
});

// ---------------------------------------------------------------------------
// 3. Coordinator end-to-end: executeRun seed từ BotMemory thread
// ---------------------------------------------------------------------------

function makeCoordinatorSetup(botId, dir, recordPath) {
  const coordinator = new AgentCoordinator({
    dataDir: makeTempDir('open-bot-thread-seed-data-'),
    toolFactory: () => [],
    emit: () => undefined,
  });
  return {
    coordinator,
    async createBot() {
      await coordinator.createBot({
        bot: {
          id: botId,
          name: `Bot ${botId}`,
          providerId: 'mock',
          model: 'mock',
          systemPrompt: 'You are a test bot.',
          workspaceDir: dir,
          autoApprove: true,
        },
        provider: {
          id: 'mock',
          label: 'Mock',
          mockResponses: [{ text: 'mock reply' }],
          mockRecordPath: recordPath,
        },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Best-effort cleanup.
      }
      coordinator.shutdown();
    },
  };
}

/** Đọc các ChatCompletionRequest mock đã ghi (JSONL, một dòng một request). */
function readRecordedRequests(recordPath) {
  if (!fs.existsSync(recordPath)) return [];
  return fs
    .readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test('coordinator: run với threadId thì model thấy lượt cũ, đúng thứ tự, tin hiện tại chỉ 1 lần', async () => {
  const dir = makeTempDir('open-bot-thread-seed-coord-');
  const recordPath = path.join(makeTempDir('open-bot-thread-seed-rec-'), 'mock.jsonl');
  const setup = makeCoordinatorSetup('bot-hist', dir, recordPath);
  try {
    await setup.createBot();
    const { thread } = setup.coordinator.createThread({ botId: 'bot-hist' });
    setup.coordinator.saveMessage({
      botId: 'bot-hist',
      role: 'user',
      content: 'tôi thích màu xanh',
      threadId: thread.id,
    });
    setup.coordinator.saveMessage({
      botId: 'bot-hist',
      role: 'assistant',
      content: 'đã nhớ: bạn thích màu xanh',
      threadId: thread.id,
    });
    // Như main (chat:send): tin hiện tại lưu vào thread TRƯỚC khi run.
    setup.coordinator.saveMessage({
      botId: 'bot-hist',
      role: 'user',
      content: 'màu tôi thích là gì?',
      threadId: thread.id,
    });

    const result = await setup.coordinator.run({
      botId: 'bot-hist',
      text: 'màu tôi thích là gì?',
      threadId: thread.id,
    });
    assert.equal(result.text, 'mock reply');
    assert.equal(result.stopped, false);

    const requests = readRecordedRequests(recordPath);
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0].messages.map((m) => [m.role, m.content]),
      [
        ['system', 'You are a test bot.'],
        ['user', 'tôi thích màu xanh'],
        ['assistant', 'đã nhớ: bạn thích màu xanh'],
        ['user', 'màu tôi thích là gì?'],
      ],
    );
  } finally {
    await setup.destroy();
  }
});

test('coordinator: thread rỗng và run không threadId chạy y như trước ([system, user])', async () => {
  const dir = makeTempDir('open-bot-thread-seed-coord-');
  const recordPath = path.join(makeTempDir('open-bot-thread-seed-rec-'), 'mock.jsonl');
  const setup = makeCoordinatorSetup('bot-empty', dir, recordPath);
  try {
    await setup.createBot();
    const { thread } = setup.coordinator.createThread({ botId: 'bot-empty' });

    const r1 = await setup.coordinator.run({
      botId: 'bot-empty',
      text: 'chào',
      threadId: thread.id,
    });
    assert.equal(r1.text, 'mock reply');

    const r2 = await setup.coordinator.run({ botId: 'bot-empty', text: 'chào lần nữa' });
    assert.equal(r2.text, 'mock reply');

    const requests = readRecordedRequests(recordPath);
    assert.equal(requests.length, 2);
    for (const req of requests) {
      assert.equal(req.messages.length, 2);
      assert.equal(req.messages[0].role, 'system');
      assert.equal(req.messages[1].role, 'user');
    }
    assert.equal(requests[0].messages[1].content, 'chào');
    assert.equal(requests[1].messages[1].content, 'chào lần nữa');
  } finally {
    await setup.destroy();
  }
});

test('coordinator: cap được tôn trọng end-to-end — thread 60 tin dài bị cắt ≤ 8000 token', async () => {
  const dir = makeTempDir('open-bot-thread-seed-coord-');
  const recordPath = path.join(makeTempDir('open-bot-thread-seed-rec-'), 'mock.jsonl');
  const setup = makeCoordinatorSetup('bot-long', dir, recordPath);
  try {
    await setup.createBot();
    const { thread } = setup.coordinator.createThread({ botId: 'bot-long' });
    // 60 lượt, mỗi lượt ~500 token ước lượng → tổng ~30.000 token.
    for (let i = 0; i < 60; i++) {
      setup.coordinator.saveMessage({
        botId: 'bot-long',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `lượt ${i} ` + 'nội dung dài '.repeat(100),
        threadId: thread.id,
      });
    }
    // Tin hiện tại lưu trước run (như main) — không tính vào cap history
    // sau khi dedup, và phải xuất hiện đúng 1 lần ở cuối.
    setup.coordinator.saveMessage({
      botId: 'bot-long',
      role: 'user',
      content: 'tóm tắt giúp tôi',
      threadId: thread.id,
    });

    const result = await setup.coordinator.run({
      botId: 'bot-long',
      text: 'tóm tắt giúp tôi',
      threadId: thread.id,
    });
    assert.equal(result.text, 'mock reply');

    const requests = readRecordedRequests(recordPath);
    assert.equal(requests.length, 1);
    const sent = requests[0].messages;
    // [system, ...history đã cắt, user mới]
    assert.equal(sent[0].role, 'system');
    assert.equal(sent[sent.length - 1].content, 'tóm tắt giúp tôi');
    assert.equal(
      sent.filter((m) => m.role === 'user' && m.content === 'tóm tắt giúp tôi').length,
      1,
      'tin hiện tại chỉ xuất hiện đúng 1 lần',
    );
    const historyPart = sent.slice(1, -1);
    assert.ok(
      historyPart.length < 60,
      `history phải bị cắt (còn ${historyPart.length}/60)`,
    );
    assert.ok(
      historyPart.length <= THREAD_HISTORY_MAX_MESSAGES,
      `history ≤ ${THREAD_HISTORY_MAX_MESSAGES} message`,
    );
    // Mock model 'mock' → contextLimit mặc định 131.072 → budget 8.000.
    assert.ok(
      historyTokens(historyPart) <= THREAD_HISTORY_MAX_TOKENS,
      `history ${historyTokens(historyPart)} token phải ≤ ${THREAD_HISTORY_MAX_TOKENS}`,
    );
    // Lượt gần nhất còn nguyên (không tính tin hiện tại đã dedup).
    assert.match(historyPart[historyPart.length - 1].content, /lượt 59/);
  } finally {
    await setup.destroy();
  }
});

test('coordinator: threadId lạ lỗi rõ ngay và bot không kẹt (run sau vẫn chạy)', async () => {
  const dir = makeTempDir('open-bot-thread-seed-coord-');
  const recordPath = path.join(makeTempDir('open-bot-thread-seed-rec-'), 'mock.jsonl');
  const setup = makeCoordinatorSetup('bot-bad', dir, recordPath);
  try {
    await setup.createBot();
    await assert.rejects(
      setup.coordinator.run({
        botId: 'bot-bad',
        text: 'chào',
        threadId: 'thread-khong-ton-tai',
      }),
      /Không tìm thấy thread/,
    );
    // Bot không kẹt trong hàng đợi: run sau (không thread) chạy được.
    const result = await setup.coordinator.run({ botId: 'bot-bad', text: 'chào lại' });
    assert.equal(result.text, 'mock reply');
    const requests = readRecordedRequests(recordPath);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages[1].content, 'chào lại');
  } finally {
    await setup.destroy();
  }
});

test('coordinator: history của thread khác không lọt sang (cô lập theo thread)', async () => {
  const dir = makeTempDir('open-bot-thread-seed-coord-');
  const recordPath = path.join(makeTempDir('open-bot-thread-seed-rec-'), 'mock.jsonl');
  const setup = makeCoordinatorSetup('bot-iso', dir, recordPath);
  try {
    await setup.createBot();
    const { thread: t1 } = setup.coordinator.createThread({ botId: 'bot-iso' });
    const { thread: t2 } = setup.coordinator.createThread({ botId: 'bot-iso' });
    setup.coordinator.saveMessage({
      botId: 'bot-iso',
      role: 'user',
      content: 'bí mật của thread một',
      threadId: t1.id,
    });
    setup.coordinator.saveMessage({
      botId: 'bot-iso',
      role: 'user',
      content: 'chuyện của thread hai',
      threadId: t2.id,
    });

    await setup.coordinator.run({
      botId: 'bot-iso',
      text: 'tiếp tục nhé',
      threadId: t2.id,
    });
    const requests = readRecordedRequests(recordPath);
    assert.equal(requests.length, 1);
    const contents = requests[0].messages.map((m) => m.content).join('\n');
    assert.match(contents, /chuyện của thread hai/);
    assert.doesNotMatch(contents, /bí mật của thread một/);
  } finally {
    await setup.destroy();
  }
});
