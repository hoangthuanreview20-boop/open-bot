/**
 * Tests cho v0.12 mục 7 — Compaction/tóm tắt ngữ cảnh tự động (W4d):
 *   packages/core/src/agent/compaction.ts
 *
 * Chạy sau khi build riêng core:
 *   npx tsc -p packages/core/tsconfig.json
 *   node --test tests/compaction-v012.test.mjs
 * Không cần API key thật, không gọi mạng (summarizer/provider đều giả).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompactionPrompt,
  buildSummaryMessageContent,
  checkAndCompact,
  compactMessages,
  compactWithProvider,
  estimateMessagesTokens,
  estimateMessageTokens,
  needsCompaction,
} from '../packages/core/dist/agent/compaction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(role, content, extra = {}) {
  return { role, content, ...extra };
}

function makeHistory(n) {
  const out = [msg('system', 'Bạn là trợ lý lập trình.')];
  for (let i = 1; i <= n; i++) {
    out.push(msg(i % 2 === 1 ? 'user' : 'assistant', `tin nhắn số ${i} `.repeat(10)));
  }
  return out;
}

const fakeSummarizer = async (toSummarize) =>
  `Tóm tắt ${toSummarize.length} tin nhắn: người dùng đang làm dự án X.`;

// ---------------------------------------------------------------------------
// estimateMessagesTokens / needsCompaction
// ---------------------------------------------------------------------------

test('estimateMessagesTokens: rỗng = 0, message ngắn ≈ chars/4 + overhead', () => {
  assert.equal(estimateMessagesTokens([]), 0);
  const m = msg('user', 'abcd'); // 4 ký tự → 1 token + 4 overhead = 5
  assert.equal(estimateMessageTokens(m), 5);
  assert.equal(estimateMessagesTokens([m, m]), 10);
});

test('estimateMessagesTokens: toolCalls cũng tính token', () => {
  const plain = msg('assistant', 'x');
  const withCalls = msg('assistant', 'x', {
    toolCalls: [{ id: 'c1', name: 'read_file', args: { path: '/tmp/a.txt' } }],
  });
  assert.ok(estimateMessageTokens(withCalls) > estimateMessageTokens(plain));
});

test('needsCompaction: dưới 80% limit → false, từ 80% trở lên → true', () => {
  const history = makeHistory(4);
  assert.equal(needsCompaction(history, 79, 100), false);
  assert.equal(needsCompaction(history, 80, 100), true);
  assert.equal(needsCompaction(history, 150, 100), true);
});

test('needsCompaction: không có limit → false; tự ước tính khi không đưa token', () => {
  const history = makeHistory(4);
  assert.equal(needsCompaction(history, 999), false);
  assert.equal(needsCompaction(history, 999, 0), false);
  assert.equal(needsCompaction(history, 999, -5), false);
  // Tự ước tính: 4 message ngắn không thể vượt 80% của limit 10_000.
  assert.equal(needsCompaction(history, undefined, 10_000), false);
  // Ngưỡng tuỳ chỉnh 50%.
  assert.equal(needsCompaction(history, 49, 100, 0.5), false);
  assert.equal(needsCompaction(history, 50, 100, 0.5), true);
});

// ---------------------------------------------------------------------------
// compactMessages — đường happy path
// ---------------------------------------------------------------------------

test('compactMessages: giữ system + 10 message cuối + 1 message tóm tắt', async () => {
  const history = makeHistory(20); // system + 20
  const seen = [];
  const result = await compactMessages(history, async (old, { language }) => {
    seen.push({ count: old.length, language });
    return fakeSummarizer(old);
  });
  assert.equal(result.compacted, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.summarizedCount, 10);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].count, 10);
  assert.equal(seen[0].language, 'vi');
  // system đầu + summary + 10 recent = 12 message.
  assert.equal(result.messages.length, 12);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'Bạn là trợ lý lập trình.');
  assert.equal(result.messages[1].role, 'user');
  assert.match(result.messages[1].content, /tóm tắt của 10 tin nhắn cũ/);
  assert.match(result.messages[1].content, /ước tính ~\d+ token/);
  assert.match(result.messages[1].content, /dự án X/);
  // 10 message cuối còn nguyên nội dung.
  assert.equal(result.messages[11].content, history[20].content);
  assert.ok(result.tokensAfter < result.tokensBefore);
  assert.ok(result.summaryTokens > 0);
  assert.equal(result.summaryText, 'Tóm tắt 10 tin nhắn: người dùng đang làm dự án X.');
});

test('compactMessages: ngôn ngữ en → tóm tắt ghi bằng tiếng Anh', async () => {
  const history = makeHistory(12);
  const result = await compactMessages(
    history,
    async () => 'Summary of the old messages.',
    { language: 'en', keepRecent: 2 },
  );
  assert.equal(result.summarizedCount, 10);
  assert.match(result.messages[1].content, /summary of 10 older messages/);
});

test('compactMessages: keepRecent tuỳ chỉnh + ít message → không compact', async () => {
  const history = makeHistory(5);
  let called = 0;
  const result = await compactMessages(history, async () => {
    called += 1;
    return 'x';
  });
  assert.equal(result.compacted, false);
  assert.equal(called, 0);
  assert.deepEqual(result.messages, history);
  assert.equal(result.tokensAfter, result.tokensBefore);
});

test('compactMessages: không có system prompt vẫn compact được', async () => {
  const history = [];
  for (let i = 1; i <= 15; i++) history.push(msg('user', `câu ${i}`));
  const result = await compactMessages(history, fakeSummarizer);
  assert.equal(result.compacted, true);
  assert.equal(result.summarizedCount, 5);
  assert.equal(result.messages[0].role, 'user'); // message tóm tắt đứng đầu
  assert.match(result.messages[0].content, /tóm tắt của 5 tin nhắn cũ/);
});

// ---------------------------------------------------------------------------
// compactMessages — không tách cặp assistant tool-call / tool result
// ---------------------------------------------------------------------------

test('compactMessages: không tách tool result khỏi assistant call của nó', async () => {
  const history = [msg('system', 'sys')];
  for (let i = 1; i <= 10; i++) history.push(msg('user', `u${i}`));
  history.push(
    msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] }),
    msg('tool', 'nội dung file', { toolCallId: 'c1' }),
    msg('user', 'u11'),
  );
  // keepRecent=2, điểm cắt thô sẽ rơi ngay trước tool result → phải dịch.
  const result = await compactMessages(history, fakeSummarizer, { keepRecent: 2 });
  assert.equal(result.compacted, true);
  // Mọi message tool đều có assistant call đi trước trong lịch sử đã compact.
  let seenCall = false;
  for (const m of result.messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) seenCall = true;
    if (m.role === 'tool') assert.ok(seenCall, 'tool result bị tách khỏi assistant call');
  }
  // Assistant call phải nằm trong phần recent (không bị tóm tắt mất).
  const callIdx = result.messages.findIndex(
    (m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'c1',
  );
  assert.ok(callIdx > 1, 'assistant call phải còn nguyên sau message tóm tắt');
});

test('compactMessages: assistant có toolCalls cuối phần cũ → đẩy tool result vào phần cũ', async () => {
  const history = [msg('system', 'sys')];
  for (let i = 1; i <= 10; i++) history.push(msg('user', `u${i}`));
  history.push(
    msg('assistant', '', { toolCalls: [{ id: 'c9', name: 'shell_exec', args: {} }] }),
    msg('user', 'u11'),
    msg('user', 'u12'),
  );
  const result = await compactMessages(history, fakeSummarizer, { keepRecent: 2 });
  assert.equal(result.compacted, true);
  // Lịch sử đã compact không được kết thúc phần cũ bằng assistant tool-call
  // mà thiếu tool result: kiểm tra không có assistant tool-call nào mà
  // message tool tương ứng đã biến mất khỏi lịch sử.
  const hasCall = result.messages.some(
    (m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'c9',
  );
  const hasResult = result.messages.some((m) => m.role === 'tool' && m.toolCallId === 'c9');
  assert.equal(hasCall, hasResult);
});

// ---------------------------------------------------------------------------
// compactMessages — fallback khi summarizer lỗi
// ---------------------------------------------------------------------------

test('compactMessages fallback: summarizer throw → cắt message cũ, không crash', async () => {
  const history = makeHistory(20);
  const result = await compactMessages(history, async () => {
    throw new Error('provider timeout');
  });
  assert.equal(result.compacted, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.summarizedCount, 10);
  assert.equal(result.summaryText, '');
  assert.equal(result.summaryTokens, 0);
  // Chỉ còn system + 10 recent, không có message tóm tắt.
  assert.equal(result.messages.length, 11);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[10].content, history[20].content);
  assert.ok(result.tokensAfter < result.tokensBefore);
});

test('compactMessages fallback: summarizer trả rỗng → fallback cắt bớt', async () => {
  const history = makeHistory(15);
  const result = await compactMessages(history, async () => '   ');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.messages.length, 11); // system + 10 recent
});

// ---------------------------------------------------------------------------
// buildSummaryMessageContent / buildCompactionPrompt
// ---------------------------------------------------------------------------

test('buildSummaryMessageContent: ghi rõ số message + token ước tính', () => {
  const vi = buildSummaryMessageContent(7, 123, 'nội dung tóm tắt', 'vi');
  assert.match(vi, /tóm tắt của 7 tin nhắn cũ/);
  assert.match(vi, /~123 token/);
  assert.match(vi, /nội dung tóm tắt/);
  const en = buildSummaryMessageContent(7, 123, 'summary body', 'en');
  assert.match(en, /summary of 7 older messages/);
  assert.match(en, /summary body/);
});

test('buildCompactionPrompt: hướng dẫn giữ quyết định/file/lỗi/bước tiếp theo', () => {
  const { system, user } = buildCompactionPrompt(
    [msg('user', 'làm web bán hàng'), msg('assistant', 'đã tạo file index.html')],
    'vi',
  );
  assert.match(system, /quyết định đã chốt/);
  assert.match(system, /file đã tạo/);
  assert.match(system, /Không bịa/);
  assert.match(user, /\[user\] làm web bán hàng/);
  assert.match(user, /\[assistant\] đã tạo file index.html/);
  const en = buildCompactionPrompt([msg('user', 'hello')], 'en');
  assert.match(en.system, /Do not invent/);
});

// ---------------------------------------------------------------------------
// compactWithProvider / checkAndCompact (provider giả)
// ---------------------------------------------------------------------------

function fakeProvider({ summaryText = 'Tóm tắt bởi model.', shouldThrow = false } = {}) {
  const calls = [];
  return {
    id: 'mock',
    label: 'Mock',
    calls,
    async chat(req) {
      calls.push(req);
      if (shouldThrow) throw new Error('provider lỗi 500');
      return { text: summaryText, toolCalls: [] };
    },
    async listModels() {
      return ['mock-model'];
    },
  };
}

test('compactWithProvider: gọi provider với prompt tóm tắt, dùng model của run', async () => {
  const provider = fakeProvider();
  const result = await compactWithProvider(makeHistory(15), provider, {
    model: 'mock-model',
  });
  assert.equal(result.compacted, true);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].model, 'mock-model');
  assert.equal(provider.calls[0].messages[0].role, 'system');
  assert.match(provider.calls[0].messages[0].content, /tóm tắt/);
  assert.match(result.summaryText, /Tóm tắt bởi model/);
});

test('compactWithProvider: summarizerModel riêng được ưu tiên', async () => {
  const provider = fakeProvider();
  await compactWithProvider(makeHistory(15), provider, {
    model: 'mock-model',
    summarizerModel: 'local-nho',
  });
  assert.equal(provider.calls[0].model, 'local-nho');
});

test('compactWithProvider: provider lỗi → fallback cắt bớt, không throw', async () => {
  const provider = fakeProvider({ shouldThrow: true });
  const result = await compactWithProvider(makeHistory(15), provider, {
    model: 'mock-model',
  });
  assert.equal(result.compacted, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.messages.length, 11);
});

test('checkAndCompact: dưới ngưỡng → không gọi provider, không compact', async () => {
  const provider = fakeProvider();
  const history = makeHistory(4);
  const result = await checkAndCompact(history, provider, {
    model: 'mock-model',
    contextLimit: 100_000,
  });
  assert.equal(result.compacted, false);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(result.messages, history);
});

test('checkAndCompact: vượt ngưỡng → gọi provider 1 lần và compact', async () => {
  const provider = fakeProvider();
  const history = makeHistory(15);
  const result = await checkAndCompact(history, provider, {
    model: 'mock-model',
    contextLimit: 100, // token ước tính của 15 message vượt 80% của 100
  });
  assert.equal(result.compacted, true);
  assert.equal(provider.calls.length, 1);
  assert.ok(result.tokensAfter < result.tokensBefore);
});

test('checkAndCompact: không có contextLimit → không compact', async () => {
  const provider = fakeProvider();
  const result = await checkAndCompact(makeHistory(15), provider, {
    model: 'mock-model',
  });
  assert.equal(result.compacted, false);
  assert.equal(provider.calls.length, 0);
});
