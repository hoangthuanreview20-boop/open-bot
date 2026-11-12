/**
 * handoff-v012.test.mjs — Handoff chuẩn v0.12 mục 1 + template triage mục 2.
 * API thuần (packages/core/src/agent/handoff.ts, templates.ts) — không gọi
 * mạng, không cần API key, không chạm coordinator/loop.
 * Run: build core rồi `node --test tests/handoff-v012.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HANDOFF_HOPS,
  HandoffLog,
  checkHop,
  createHandoff,
  extractOriginalRequest,
  formatHandoffForPrompt,
  handoffChain,
  isTransferTool,
  parseTransferToolName,
  slugifyBotName,
  summarizeTranscript,
  transferToolNameFor,
  truncateTranscript,
  wouldRepeatHandoff,
} from '../packages/core/dist/agent/handoff.js';
import {
  TRIAGE_TEMPLATE_ID,
  TRIAGE_DEFAULT_SPECIALISTS,
  buildTriageSystemPrompt,
  getTemplate,
  getTriageTemplate,
  listBuiltInTemplates,
} from '../packages/core/dist/agent/templates.js';

const TRANSCRIPT = [
  { role: 'user', content: 'Viết hàm tính tổng trong src/math.ts' },
  { role: 'assistant', content: 'Đã đọc file src/math.ts, thấy hàm còn thiếu.' },
  { role: 'tool', content: 'nội dung file math.ts…' },
  { role: 'assistant', content: 'Cần chuyên môn code để viết hàm này.' },
];

function historyOf(n, from = 'triage', to = 'code') {
  return Array.from({ length: n }, (_, i) => ({
    fromBot: i % 2 === 0 ? from : to,
    toBot: i % 2 === 0 ? to : from,
    reason: `lý do ${i + 1}`,
    hop: i + 1,
    createdAt: new Date(Date.now() + i * 1000).toISOString(),
  }));
}

test('transfer_to_<bot>: slug hoá tên bot có dấu/khoảng trắng', () => {
  assert.equal(transferToolNameFor('code'), 'transfer_to_code');
  assert.equal(transferToolNameFor('Code Bot'), 'transfer_to_code_bot');
  assert.equal(transferToolNameFor('Nghiên cứu'), 'transfer_to_nghien_cuu');
  assert.equal(slugifyBotName('  Data-Analyst! '), 'data_analyst');
  assert.throws(() => transferToolNameFor('   '), /tên bot không rỗng/);
  assert.throws(() => transferToolNameFor('!!!'), /tên bot không rỗng/);
});

test('isTransferTool / parseTransferToolName', () => {
  assert.equal(isTransferTool('transfer_to_code'), true);
  assert.equal(isTransferTool('transfer_to_'), false);
  assert.equal(isTransferTool('read_file'), false);
  assert.equal(parseTransferToolName('transfer_to_code'), 'code');
  assert.equal(parseTransferToolName('transfer_to_nghien_cuu'), 'nghien_cuu');
  assert.equal(parseTransferToolName('read_file'), null);
});

test('createHandoff mang toàn bộ hội thoại + tóm tắt + kết quả trung gian sang bot nhận', () => {
  const payload = createHandoff({
    fromBot: 'triage',
    toBot: 'code',
    reason: 'cần chuyên môn code',
    transcript: TRANSCRIPT,
    intermediateResults: [{ step: 'đọc file src/math.ts', output: 'file có 120 dòng' }],
  });
  assert.equal(payload.fromBot, 'triage');
  assert.equal(payload.toBot, 'code');
  assert.equal(payload.reason, 'cần chuyên môn code');
  assert.equal(payload.hopCount, 1);
  assert.equal(payload.maxHops, MAX_HANDOFF_HOPS);
  assert.equal(payload.hopsRemaining, MAX_HANDOFF_HOPS - 1);
  assert.equal(payload.originalRequest, 'Viết hàm tính tổng trong src/math.ts');
  assert.equal(payload.transcript.length, TRANSCRIPT.length);
  assert.equal(payload.transcript[0].content, TRANSCRIPT[0].content);
  assert.equal(payload.intermediateResults.length, 1);
  assert.equal(payload.intermediateResults[0].step, 'đọc file src/math.ts');
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].hop, 1);
  assert.match(payload.summary, /Viết hàm tính tổng/);
});

test('createHandoff nối tiếp: hop tăng theo history, summary tự sinh khi không đưa', () => {
  const first = createHandoff({ fromBot: 'triage', toBot: 'code', transcript: TRANSCRIPT });
  const second = createHandoff({
    fromBot: 'code',
    toBot: 'research',
    reason: 'cần tra cứu thêm',
    transcript: TRANSCRIPT,
    history: first.history,
  });
  assert.equal(second.hopCount, 2);
  assert.equal(second.history.length, 2);
  assert.deepEqual(handoffChain(second.history), ['triage', 'code', 'research']);
  assert.match(second.summary, /Hội thoại đã có 4 dòng/);
});

test('createHandoff ném lỗi rõ: cùng bot, transcript rỗng, dòng rỗng', () => {
  assert.throws(
    () => createHandoff({ fromBot: 'code', toBot: 'code', transcript: TRANSCRIPT }),
    /chính mình/,
  );
  assert.throws(
    () => createHandoff({ fromBot: 'a', toBot: 'b', transcript: [] }),
    /transcript không rỗng/,
  );
  assert.throws(
    () =>
      createHandoff({
        fromBot: 'a',
        toBot: 'b',
        transcript: [{ role: 'user', content: '   ' }],
      }),
    /nội dung rỗng/,
  );
  assert.throws(
    () => createHandoff({ fromBot: ' ', toBot: 'b', transcript: TRANSCRIPT }),
    /bot nguồn/,
  );
});

test('hop counter: đủ 5 hop thì chặn, vượt thì báo rõ và dừng', () => {
  assert.equal(checkHop(0).allowed, true);
  assert.equal(checkHop(0).nextHop, 1);
  assert.equal(checkHop(4).allowed, true);
  assert.equal(checkHop(4).hopsRemaining, 0);
  const blocked = checkHop(5);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.blockReason, /vượt giới hạn handoff/);
  assert.match(blocked.blockReason, /5 lần/);
  assert.throws(
    () =>
      createHandoff({
        fromBot: 'a',
        toBot: 'b',
        transcript: TRANSCRIPT,
        history: historyOf(5),
      }),
    /vượt giới hạn handoff/,
  );
  // Giới hạn tuỳ chỉnh vẫn tôn trọng.
  assert.equal(checkHop(2, 2).allowed, false);
  assert.equal(checkHop(1, 2).allowed, true);
});

test('wouldRepeatHandoff phát hiện lặp A→B→A, handoffChain vẽ chuỗi', () => {
  const history = historyOf(2); // triage→code, code→triage
  assert.equal(wouldRepeatHandoff(history, 'triage', 'code'), true);
  assert.equal(wouldRepeatHandoff(history, 'code', 'research'), false);
  assert.equal(wouldRepeatHandoff([], 'a', 'b'), false);
  assert.deepEqual(handoffChain(history), ['triage', 'code', 'triage']);
  assert.deepEqual(handoffChain([]), []);
});

test('extractOriginalRequest / summarizeTranscript', () => {
  assert.equal(extractOriginalRequest(TRANSCRIPT), 'Viết hàm tính tổng trong src/math.ts');
  assert.equal(extractOriginalRequest([{ role: 'assistant', content: 'xin chào' }]), '');
  const summary = summarizeTranscript(TRANSCRIPT);
  assert.match(summary, /Yêu cầu gốc/);
  assert.match(summary, /4 dòng/);
});

test('truncateTranscript giữ trong ngân sách ký tự, giữ dòng user đầu', () => {
  const long = [
    { role: 'user', content: 'yêu cầu gốc' },
    { role: 'assistant', content: 'x'.repeat(5000) },
    { role: 'assistant', content: 'y'.repeat(5000) },
  ];
  const kept = truncateTranscript(long, 1000);
  const total = kept.reduce((s, m) => s + m.content.length, 0);
  assert.ok(total <= 1100, `tổng ${total} vượt ngân sách`);
  assert.equal(kept[0].content, 'yêu cầu gốc');
});

test('formatHandoffForPrompt: bot nhận đọc là hiểu việc, không hỏi lại từ đầu', () => {
  const payload = createHandoff({
    fromBot: 'triage',
    toBot: 'code',
    reason: 'cần chuyên môn code',
    transcript: TRANSCRIPT,
    intermediateResults: [{ step: 'đọc file', output: 'ok' }],
  });
  const text = formatHandoffForPrompt(payload);
  assert.match(text, /triage/);
  assert.match(text, /code/);
  assert.match(text, /cần chuyên môn code/);
  assert.match(text, /Viết hàm tính tổng/);
  assert.match(text, /đọc file/);
  assert.match(text, /triage → code/);
  assert.match(text, /đừng hỏi lại user/);
});

test('HandoffLog ghi lịch sử, tra theo bot, phát hiện lặp, không ghi trùng payload', () => {
  const log = new HandoffLog();
  const payload = createHandoff({
    fromBot: 'triage',
    toBot: 'code',
    transcript: TRANSCRIPT,
  });
  log.recordPayload(payload);
  log.recordPayload(payload); // ghi lại cùng payload không nhân đôi
  assert.equal(log.list().length, 1);
  assert.equal(log.hopCount(), 1);
  assert.equal(log.listForBot('code').length, 1);
  assert.equal(log.listForBot('research').length, 0);
  assert.equal(log.hasRepeated('triage', 'code'), true);
  assert.equal(log.hasRepeated('code', 'triage'), false);
  log.clear();
  assert.equal(log.list().length, 0);
});

// --- Template triage (v0.12 mục 2) ---

test('template triage tồn tại, chỉ handoff, không tool thường', () => {
  const triage = getTriageTemplate();
  assert.ok(triage, 'thiếu template triage');
  assert.equal(triage.id, TRIAGE_TEMPLATE_ID);
  assert.equal(triage.id, 'triage');
  assert.deepEqual(triage.suggestedTools, []);
  assert.equal(getTemplate('triage')?.id, 'triage');
  assert.ok(listBuiltInTemplates().some((t) => t.id === 'triage'));
  // Template cũ không bị đụng: vẫn đủ 6 template cũ + triage.
  const ids = listBuiltInTemplates().map((t) => t.id);
  for (const old of ['code', 'research', 'writing', 'data', 'automation', 'general']) {
    assert.ok(ids.includes(old), `mất template cũ ${old}`);
  }
  // v0.72c (Team C): +13 template mới (code-reviewer, test-writer,
  // devops-helper, competitor-analysis, news-digest, translator,
  // email-assistant, content-creator, meeting-notes, finance-tracker,
  // file-organizer, project-manager, tutor) => 7 + 13 = 20.
  assert.equal(ids.length, 20);
});

test('buildTriageSystemPrompt liệt kê bot chuyên môn + tool transfer tương ứng', () => {
  const prompt = buildTriageSystemPrompt(TRIAGE_DEFAULT_SPECIALISTS);
  assert.match(prompt, /chỉ.*route|điều phối/i);
  assert.match(prompt, /KHÔNG tự trả lời/);
  assert.match(prompt, /transfer_to_code/);
  assert.match(prompt, /transfer_to_research/);
  assert.match(prompt, /không được dùng bất kỳ tool nào khác ngoài các tool transfer_to_/);
  assert.match(prompt, /tối đa 5 hop/);
  // Danh sách tuỳ chỉnh được phản ánh đúng.
  const custom = buildTriageSystemPrompt([
    { name: 'Kế toán', description: 'Làm sổ sách.', capabilities: ['báo cáo thuế'] },
  ]);
  assert.match(custom, /transfer_to_ke_toan/);
  assert.match(custom, /báo cáo thuế/);
  // Không có chuyên môn nào: prompt nói rõ thay vì bịa tool.
  assert.match(buildTriageSystemPrompt([]), /chưa có bot chuyên môn/);
});

test('template triage dùng được để tạo BotConfig (qua createBotConfigFromTemplate)', async () => {
  const { createBotConfigFromTemplate } = await import(
    '../packages/core/dist/agent/templates.js'
  );
  const triage = getTriageTemplate();
  const config = createBotConfigFromTemplate(triage, { name: 'Điều phối viên' });
  assert.equal(config.name, 'Điều phối viên');
  assert.match(config.systemPrompt, /transfer_to_code/);
  assert.equal(config.workspaceDir, '');
  assert.ok(config.id.length > 0);
});
