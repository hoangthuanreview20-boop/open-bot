/**
 * Tests cho v0.20 (W13b) + hiệu chuẩn v0.24 (W17b) — ước lượng token:
 *   packages/core/src/agent/tokens.ts (`estimateTokens`)
 *   packages/core/src/agent/compaction.ts (dùng chung `estimateTokens`)
 *   packages/core/src/agent/smallModel.ts (dùng chung `estimateTokens`,
 *     bỏ hàm chars/4 riêng trùng lặp)
 *
 * HIỆU CHUẨN BẰNG TOKENIZER THẬT (v0.24): `tiktoken` 1.0.22
 * (devDependency của `@open-bot/core`) với `cl100k_base` — BPE của họ
 * GPT-3.5/4. "Thật" trong file này = số token đếm bằng `tiktoken`,
 * KHÔNG còn là khoảng ước lượng từ quy tắc BPE công khai như bản v0.21.
 * Chạy sau khi build riêng core và đã `npm install` (để có `tiktoken`):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/token-estimate-v020.test.mjs
 * Không gọi provider thật, không API key, không mạng (tiktoken chạy
 * local, chỉ giải mã BPE đã đóng gói sẵn trong package).
 *
 * Hai tầng assert:
 *  (1) Corpus thực tế (`tests/token-benchmark-corpus.mjs`, 22 mẫu:
 *      Anh / Việt / code / CJK / số / đặc biệt-emoji): mỗi nhóm có
 *      sai số tương đối trung bình < 15% và mẫu tệ nhất < 25% so với
 *      `tiktoken` — mục tiêu W17b; số đo được: en 3.1%/6.0%,
 *      vi 0.4%/0.6%, code 4.6%/9.6%, cjk 1.4%/3.3%, num 0.0%/0.0%,
 *      special 6.2%/14.0% (toàn corpus 2.6%; heuristic v0.21 cũ trên
 *      cùng corpus: 26.8% toàn corpus, tệ nhất 68.0%).
 *  (2) Corpus tổng hợp cũ (1 câu lặp lại): điểm "thật" giờ là số đo
 *      bằng `tiktoken` — EN 1101, VI 1751, code 280, CJK 1300 — và
 *      ước lượng mới vẫn phải gần số thật hơn chars/4. Lưu ý: câu lặp
 *      là trường hợp xấu nhất của heuristic (câu CJK quen thuộc gộp
 *      bigram `"一个"` = 1 token/2 chữ nên ước thừa 32.7%; câu Việt
 *      lặp chứa nhiều âm tiết 1-token nên ước thừa 11.4%); văn xuôi
 *      thật không lặp thì sát như tầng (1). Hướng ước lượng thừa là
 *      hướng an toàn cho compaction/guard (kích hoạt sớm hơn).
 * Giới hạn: `cl100k_base` là BPE của OpenAI — Grok/Anthropic/Gemini
 * dùng BPE khác nên các con số chỉ là tham chiếu cho các model đó.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { get_encoding } from 'tiktoken';
import { CORPUS } from './token-benchmark-corpus.mjs';
import { estimateTokens } from '../packages/core/dist/agent/tokens.js';
import {
  checkAndCompact,
  estimateMessageTokens,
  estimateMessagesTokens,
  needsCompaction,
} from '../packages/core/dist/agent/compaction.js';
import {
  estimateFirstRequestTokens,
  estimateMessagesTokens as estimateMessagesTokensSmall,
  estimateTextTokens,
} from '../packages/core/dist/agent/smallModel.js';
import { estimateToolsTokens } from '../packages/core/dist/agent/toolFilter.js';

/** Tokenizer thật để đối chiếu (chỉ dùng trong test, không vào runtime). */
const enc = get_encoding('cl100k_base');
const realTokens = (s) => enc.encode(s).length;

/** Heuristic cũ: ceil(chars/4) — dùng làm mốc so sánh, không phải code chạy. */
const chars4 = (s) => Math.ceil(s.length / 4);

/** "Sát hơn": ước lượng mới gần điểm thật (đo bằng tiktoken) hơn chars/4. */
function assertCloserThanChars4(label, text, real) {
  const next = estimateTokens(text);
  const old = chars4(text);
  assert.ok(
    Math.abs(next - real) < Math.abs(old - real),
    `${label}: mới=${next} phải gần thật ${real} hơn chars/4=${old}`,
  );
  return next;
}

/** Sai số tương đối của ước lượng so với số thật. */
const relErr = (text) => Math.abs(estimateTokens(text) - realTokens(text)) / realTokens(text);

// ---------------------------------------------------------------------------
// (1) Corpus thực tế vs tiktoken cl100k_base — mục tiêu W17b
// ---------------------------------------------------------------------------

test('benchmark corpus thật: mỗi nhóm sai trung bình < 15%, mẫu tệ nhất < 25% (tiktoken cl100k_base)', () => {
  const rows = [];
  let grandSum = 0;
  let grandN = 0;
  for (const [group, samples] of Object.entries(CORPUS)) {
    let sum = 0;
    let worst = 0;
    for (const s of samples) {
      const e = relErr(s);
      sum += e;
      worst = Math.max(worst, e);
    }
    const mean = sum / samples.length;
    grandSum += sum;
    grandN += samples.length;
    rows.push(`${group}: mean=${(mean * 100).toFixed(1)}% worst=${(worst * 100).toFixed(1)}%`);
    assert.ok(mean < 0.15, `${group}: sai trung bình ${(mean * 100).toFixed(1)}% phải < 15%`);
    assert.ok(worst < 0.25, `${group}: mẫu tệ nhất ${(worst * 100).toFixed(1)}% phải < 25%`);
  }
  const overall = grandSum / grandN;
  assert.ok(overall < 0.1, `toàn corpus: sai trung bình ${(overall * 100).toFixed(1)}% phải < 10%`);
  // In bảng số đo để log test ghi lại kết quả hiệu chuẩn.
  console.log(`  token benchmark vs cl100k_base — ${rows.join(' | ')}; overall=${(overall * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// (2) Corpus tổng hợp cũ (1 câu lặp lại) — điểm thật đo bằng tiktoken
// ---------------------------------------------------------------------------

/** 10 từ/câu ×100 = 1000 từ tiếng Anh, 5100 ký tự. Thật (tiktoken): 1101. */
const EN_TEXT = 'The quick brown fox jumps over the lazy dog today. '.repeat(100);
/** 18 âm tiết/câu ×50 = 900 âm tiết tiếng Việt có dấu, 3950 ký tự. Thật: 1751. */
const VI_TEXT =
  'Tôi đang học cách viết một bài báo hay về thành phố Hồ Chí Minh vào buổi sáng. '.repeat(50);
/** Đoạn JS ×10, 860 ký tự. Thật (tiktoken): 280. */
const CODE_TEXT =
  'function add(a, b) {\n  return a + b;\n}\nconst total = add(12, 30);\nconsole.log(total);\n'.repeat(10);
/** 14 ký tự/câu ×100 = 1400 ký tự CJK, 1400 ký tự. Thật (tiktoken): 1300. */
const CJK_TEXT = '这是一个用于测试的中文句子。'.repeat(100);

// ---------------------------------------------------------------------------
// Rỗng / toàn khoảng trắng
// ---------------------------------------------------------------------------

test('estimateTokens: chuỗi rỗng và toàn khoảng trắng → 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n\t  '), 0);
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('   '), 0);
  // Khoảng trắng thừa: 1 khoảng trắng gộp vào token sau (2 token),
  // 10 khoảng trắng thành 1 token riêng (thật = 3 token, không phải 2).
  assert.equal(estimateTokens('hello world'), 2);
  assert.equal(estimateTokens('hello          world'), 3);
  assert.equal(realTokens('hello          world'), 3);
  assert.equal(estimateTokens('hello '), 2); // khoảng trắng cuối = 1 token
});

// ---------------------------------------------------------------------------
// 4 nhóm có nội dung (câu lặp): mới gần số thật hơn chars/4
// ---------------------------------------------------------------------------

test('tiếng Anh 1000 từ: mới = 1101 token, đúng số thật (tiktoken 1101), sát hơn chars/4', () => {
  assert.equal(EN_TEXT.trim().split(/\s+/).length, 1000);
  assert.equal(realTokens(EN_TEXT), 1101);
  const next = assertCloserThanChars4('tiếng Anh', EN_TEXT, 1101);
  assert.ok(next >= 1046 && next <= 1156, `mới=${next} phải trong ±5% số thật 1101`);
});

test('tiếng Việt 900 âm tiết có dấu: mới ~1951 token, thật 1751 (thừa 11.4% — câu lặp chứa nhiều âm tiết 1-token), sát hơn chars/4', () => {
  assert.equal(VI_TEXT.trim().split(/\s+/).length, 900);
  assert.equal(realTokens(VI_TEXT), 1751);
  const next = assertCloserThanChars4('tiếng Việt', VI_TEXT, 1751);
  assert.ok(next >= 1488 && next <= 2014, `mới=${next} phải trong ±15% số thật 1751`);
});

test('code JS: mới = 280 token, đúng số thật (tiktoken 280), sát hơn chars/4', () => {
  assert.equal(realTokens(CODE_TEXT), 280);
  const next = assertCloserThanChars4('code JS', CODE_TEXT, 280);
  assert.ok(next >= 266 && next <= 294, `mới=${next} phải trong ±5% số thật 280`);
});

test('CJK 1400 ký tự: mới ~1725 token, thật 1300 (thừa 32.7% — câu lặp gộp bigram, trường hợp xấu nhất; văn xuôi thật sai ~1.4%), sát hơn chars/4 rất nhiều', () => {
  assert.equal(realTokens(CJK_TEXT), 1300);
  const next = assertCloserThanChars4('CJK', CJK_TEXT, 1300);
  assert.ok(next >= 845 && next <= 1755, `mới=${next} phải trong ±35% số thật 1300`);
  // chars/4 chỉ tính 350 cho 1400 ký tự CJK — thấp hơn thực tế ~4 lần.
  assert.equal(chars4(CJK_TEXT), 350);
});

// ---------------------------------------------------------------------------
// Neo hồi quy: từ đơn dài, số / ký tự đặc biệt / emoji (số thật ghi chú)
// ---------------------------------------------------------------------------

test('neo hồi quy: từ đơn dài; message ngắn + overhead', () => {
  // 'a'×100: thật 13, 'a'×101: thật 14 — chuỗi ký tự lặp vô nghĩa là
  // giới hạn đã biết (BPE gộp ký tự lặp theo vocab, heuristic không
  // đoán được); ước lượng 20 nằm giữa 'a' (13) và 'z'×100 (thật 50).
  assert.equal(estimateTextTokens('a'.repeat(100)), 20);
  assert.equal(estimateTextTokens('a'.repeat(101)), 20);
  assert.equal(estimateTokens('abcd'), 1);
  // compaction: 'abcd' → 1 token + 4 overhead = 5 (như test v0.12 cũ).
  assert.equal(estimateMessageTokens({ role: 'user', content: 'abcd' }), 5);
  assert.equal(estimateMessagesTokens([]), 0);
  // smallModel: tổng messages vẫn là tổng từng message (100 như dưới).
  const messages = [
    { role: 'system', content: 'a'.repeat(400) },
    { role: 'user', content: 'b'.repeat(100) },
  ];
  assert.equal(estimateMessagesTokensSmall(messages), 100);
  assert.equal(estimateMessagesTokens(messages), 100 + 8); // compaction cộng 4 overhead/message
});

test('số và ký tự đặc biệt: tách số theo nhóm ~3 chữ số, ký tự đặc biệt ~1 token/3 ký tự, emoji ~2.75 token/ký tự', () => {
  assert.equal(estimateTokens('2026'), 2); // "20" + "26" trong BPE
  assert.equal(estimateTokens('1'), 1);
  assert.equal(estimateTokens('!!!'), 1); // thật 1 ("!!!" gộp thành 1 token)
  assert.equal(estimateTokens('=>'), 1);
  // '😀😀😀': thật 6, ước 9 — chuỗi emoji thuần là trường hợp xấu
  // (mỗi 😀 thật 2 token, 🎉 thật 3; 2.75 là trung bình cho tin nhắn
  // emoji lẫn text, đo trên corpus: sai 3.3%).
  assert.equal(estimateTokens('😀😀😀'), 9);
  // Dấu câu đơn gộp với từ sau thành 1 token; rút gọn "don't" = 2 token.
  assert.equal(estimateTokens("don't"), 2);
  assert.equal(estimateTokens('console.log(x)'), 4);
});

// ---------------------------------------------------------------------------
// smallModel dùng chung estimator: estimateFirstRequestTokens nhất quán
// ---------------------------------------------------------------------------

test('smallModel: estimateFirstRequestTokens = messages (mới) + tools (toolFilter)', () => {
  const messages = [{ role: 'user', content: EN_TEXT.slice(0, 500) }];
  const tools = [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }];
  assert.equal(
    estimateFirstRequestTokens(messages, tools),
    estimateMessagesTokensSmall(messages) + estimateToolsTokens(tools),
  );
});

// ---------------------------------------------------------------------------
// Compaction vẫn trigger đúng ngưỡng với ước lượng mới — và ước lượng mới
// thay đổi quyết định đúng chỗ chars/4 sai (CJK)
// ---------------------------------------------------------------------------

function cjkHistory(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: '这是一个用于测试的中文句子。'.repeat(3) });
  }
  return out;
}

test('compaction trigger: lịch sử CJK trigger ở ngưỡng 80% với ước lượng mới, chars/4 thì không', async () => {
  // 16 message (không phải 12 như bản v0.21): với estimator đã hiệu
  // chuẩn, bản tóm tắt tiếng Việt tốn ~135 token nên tóm tắt chỉ 2
  // message (112 token) KHÔNG tiết kiệm token — bản cũ pass chỉ vì ước
  // lượng tiếng Việt thiếu ~38%. Tóm tắt 6 message mới tiết kiệm thật
  // (896 → 695); run thật giữ 10 message gần nhất nên đây mới là
  // trường hợp thực tế.
  const history = cjkHistory(16);
  // Mới: mỗi message 39 ký tự CJK × 1.25 + 3 dấu "。" = 51.75 → 52 token
  // + 4 overhead = 56 → tổng 896. (Thật: 39 token/message — câu lặp
  // gộp bigram nên ước lượng thừa; hướng thừa là an toàn cho guard.)
  assert.equal(estimateMessagesTokens(history), 896);
  // Cũ (chars/4 + overhead): mỗi message ceil(42/4)+4 = 15 → tổng 240.
  const oldTotal = history.length * (Math.ceil(42 / 4) + 4);
  assert.equal(oldTotal, 240);
  // Ngưỡng 80% của limit 500 là 400: mới vượt, cũ không vượt.
  assert.equal(needsCompaction(history, undefined, 500), true);
  assert.equal(needsCompaction(history, oldTotal, 500), false);

  let calls = 0;
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      calls += 1;
      return { text: 'Tóm tắt bởi model.', toolCalls: [] };
    },
    async listModels() {
      return ['mock-model'];
    },
  };
  const result = await checkAndCompact(history, provider, {
    model: 'mock-model',
    contextLimit: 500,
  });
  assert.equal(result.compacted, true);
  assert.equal(calls, 1);
  assert.ok(result.tokensAfter < result.tokensBefore);
});

test('compaction trigger: dưới ngưỡng với ước lượng mới → không compact, không gọi provider', async () => {
  const history = cjkHistory(12);
  let calls = 0;
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      calls += 1;
      return { text: 'Tóm tắt bởi model.', toolCalls: [] };
    },
    async listModels() {
      return ['mock-model'];
    },
  };
  const result = await checkAndCompact(history, provider, {
    model: 'mock-model',
    contextLimit: 10_000,
  });
  assert.equal(result.compacted, false);
  assert.equal(calls, 0);
  assert.deepEqual(result.messages, history);
});
