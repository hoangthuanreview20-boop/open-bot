/**
 * Live test: open-bot GeminiProvider thật qua proxy local.
 *
 * GATED — suite thường (`npm test`) KHÔNG BAO GIỜ gọi API live hay tốn
 * quota: cả hai test dưới đây tự skip khi proxy không chạy HOẶC biến
 * môi trường OPENBOT_LIVE_GEMINI chưa bật. Chạy live như sau:
 *
 *   # Terminal 1: proxy (key thật nằm trong vault custom.gemini, proxy
 *   # gắn surrogate — key KHÔNG chạm file, log hay biến môi trường)
 *   python3 ~/workspace/custom-connectors/custom.gemini/bin/gemini_proxy.py --port 8765
 *
 *   # Terminal 2:
 *   OPENBOT_LIVE_GEMINI=1 node --test tests/gemini-live.test.mjs
 *
 * Provider dùng apiKey dummy 'via-proxy' (proxy bỏ đi và gắn surrogate)
 * và baseUrl 'http://127.0.0.1:8765/v1beta' — KHÔNG hardcode key thật,
 * không đọc key từ đâu cả. Chi tiết: docs/live-test-gemini.md.
 *
 * Kết quả đo lần đầu (2026-11-09, gemini-2.5-flash): 1 tool call echo
 * + usage 60 in / 18 out trong 1.7s; loop 3 vòng (add → echo → text)
 * xem docs/live-test-gemini.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiProvider } from '../packages/core/dist/providers/gemini.js';

const PROXY_BASE_URL = 'http://127.0.0.1:8765/v1beta';
const LIVE_MODEL = 'gemini-2.5-flash';

/** True khi proxy local đang chạy (GET / trả {"ok": true}). */
async function proxyUp() {
  try {
    const res = await fetch('http://127.0.0.1:8765/', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

/** Gate chung: chỉ chạy live khi được bật tường minh VÀ proxy đang chạy. */
async function liveEnabled(t) {
  if (process.env.OPENBOT_LIVE_GEMINI !== '1') {
    t.skip('OPENBOT_LIVE_GEMINI != 1 — bỏ qua test live Gemini (không tốn quota)');
    return false;
  }
  if (!(await proxyUp())) {
    t.skip('Proxy Gemini local (127.0.0.1:8765) không chạy — bỏ qua test live Gemini');
    return false;
  }
  return true;
}

function liveProvider() {
  return new GeminiProvider({
    id: 'gemini',
    label: 'Gemini',
    apiKey: 'via-proxy',
    baseUrl: PROXY_BASE_URL,
    defaultModel: LIVE_MODEL,
  });
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo back the given text.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

const ADD_TOOL = {
  name: 'add',
  description: 'Add two integers and return the sum.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer' },
      b: { type: 'integer' },
    },
    required: ['a', 'b'],
  },
};

/** Cộng dồn usage qua các vòng, để kiểm tra usage tổng của cả loop. */
function addUsage(total, usage) {
  if (!usage) return total;
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
  };
}

test(
  'live: Gemini chat 1 vòng — functionCall echo + usage',
  { timeout: 120_000 },
  async (t) => {
    if (!(await liveEnabled(t))) return;
    const provider = liveProvider();
    const started = Date.now();
    const res = await provider.chat({
      model: LIVE_MODEL,
      messages: [
        { role: 'system', content: 'Bạn là trợ lý của open-bot.' },
        { role: 'user', content: "Gọi tool echo với text là 'xin chao open-bot'." },
      ],
      tools: [ECHO_TOOL],
    });
    const elapsedMs = Date.now() - started;
    console.log(
      `[gemini-live] 1 vòng ${LIVE_MODEL}: ${elapsedMs}ms, ` +
        `toolCalls=${JSON.stringify(res.toolCalls)}, usage=${JSON.stringify(res.usage)}`,
    );
    assert.equal(res.toolCalls.length, 1, 'model phải gọi đúng 1 tool');
    assert.equal(res.toolCalls[0].name, 'echo');
    assert.equal(res.toolCalls[0].args.text, 'xin chao open-bot');
    assert.ok(res.toolCalls[0].id.startsWith('gemini-'), 'id tool call có prefix gemini-');
    assert.ok(res.usage && res.usage.inputTokens > 0, 'usage.inputTokens phải > 0');
    assert.ok(res.usage && res.usage.outputTokens > 0, 'usage.outputTokens phải > 0');
  },
);

test(
  'live: Gemini agent loop 3 vòng — functionCall add, functionResponse, echo, rồi text cuối',
  { timeout: 180_000 },
  async (t) => {
    if (!(await liveEnabled(t))) return;
    const provider = liveProvider();
    const tools = [ADD_TOOL, ECHO_TOOL];
    // Dạng loop thật của agent: sau functionResponse KHÔNG thêm user
    // message mới — chỉ nối assistant(toolCalls) + tool(result) rồi gọi
    // tiếp. (Thêm user message ngay sau functionResponse làm model trả
    // candidate rỗng, finishReason STOP, 0 output token — đã đo thật
    // 2026-11-09; xem docs/live-test-gemini.md.)
    const messages = [
      { role: 'system', content: 'Bạn là trợ lý của open-bot. Dùng tool khi được yêu cầu.' },
      {
        role: 'user',
        content: 'Tính 17 + 25 bằng tool add, rồi dùng tool echo để nhắc lại kết quả.',
      },
    ];
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    const started = Date.now();

    // Vòng 1: model phải gọi add(17, 25).
    const round1 = await provider.chat({ model: LIVE_MODEL, messages, tools });
    totalUsage = addUsage(totalUsage, round1.usage);
    console.log(
      `[gemini-live] vòng 1 ${LIVE_MODEL}: toolCalls=${JSON.stringify(round1.toolCalls)}, ` +
        `usage=${JSON.stringify(round1.usage)}`,
    );
    assert.equal(round1.toolCalls.length, 1, 'vòng 1 phải gọi đúng 1 tool');
    assert.equal(round1.toolCalls[0].name, 'add');
    assert.equal(round1.toolCalls[0].args.a, 17);
    assert.equal(round1.toolCalls[0].args.b, 25);

    // "Chạy" tool thật ở phía client: 17 + 25 = 42, rồi trả
    // functionResponse về cho model đúng như agent loop làm.
    messages.push({ role: 'assistant', content: '', toolCalls: round1.toolCalls });
    messages.push({ role: 'tool', content: '42', toolCallId: round1.toolCalls[0].id });

    // Vòng 2: model phải gọi echo('42').
    const round2 = await provider.chat({ model: LIVE_MODEL, messages, tools });
    totalUsage = addUsage(totalUsage, round2.usage);
    console.log(
      `[gemini-live] vòng 2 ${LIVE_MODEL}: text=${JSON.stringify(round2.text)}, ` +
        `toolCalls=${JSON.stringify(round2.toolCalls)}, usage=${JSON.stringify(round2.usage)}`,
    );
    assert.equal(round2.toolCalls.length, 1, 'vòng 2 phải gọi đúng 1 tool');
    assert.equal(round2.toolCalls[0].name, 'echo');
    assert.ok(
      String(round2.toolCalls[0].args.text ?? '').includes('42'),
      'vòng 2 phải echo kết quả 42',
    );

    // Trả kết quả echo về, model trả lời text cuối.
    messages.push({ role: 'assistant', content: '', toolCalls: round2.toolCalls });
    messages.push({ role: 'tool', content: '42', toolCallId: round2.toolCalls[0].id });
    const round3 = await provider.chat({ model: LIVE_MODEL, messages, tools });
    totalUsage = addUsage(totalUsage, round3.usage);
    const elapsedMs = Date.now() - started;
    console.log(
      `[gemini-live] vòng 3 ${LIVE_MODEL}: text=${JSON.stringify(round3.text)}, ` +
        `toolCalls=${JSON.stringify(round3.toolCalls)}, usage=${JSON.stringify(round3.usage)}, ` +
        `tổng ${elapsedMs}ms, usage cộng dồn=${JSON.stringify(totalUsage)}`,
    );
    assert.equal(round3.toolCalls.length, 0, 'vòng 3 phải dừng gọi tool');
    assert.ok(round3.text.includes('42'), 'đáp cuối phải nhắc lại kết quả 42');
    assert.ok(totalUsage.inputTokens > 0 && totalUsage.outputTokens > 0, 'usage cộng dồn phải > 0');
  },
);
