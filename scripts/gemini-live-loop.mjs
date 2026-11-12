#!/usr/bin/env node
/**
 * Live-test thủ công: chạy agent loop thật nhiều vòng với GeminiProvider
 * qua proxy local — KHÔNG nằm trong suite test (chạy tay khi cần đo).
 *
 * Cách chạy:
 *   # Terminal 1: proxy (key thật nằm trong vault custom.gemini)
 *   python3 ~/workspace/custom-connectors/custom.gemini/bin/gemini_proxy.py --port 8765
 *
 *   # Terminal 2 (sau khi `npm run build` ở repo root):
 *   node scripts/gemini-live-loop.mjs [--model gemini-2.5-flash]
 *
 * Script dùng apiKey dummy 'via-proxy' (proxy bỏ đi và gắn surrogate)
 * và baseUrl 'http://127.0.0.1:8765/v1beta' — KHÔNG hardcode key thật,
 * không đọc key từ đâu cả. Tối đa 4 vòng, mỗi vòng tối đa 1 lần gọi API
 * (tổng ≤ 4 request), dừng ngay khi gặp 429. Kết quả đo ghi vào
 * docs/live-test-gemini.md.
 */
import { GeminiProvider } from '../packages/core/dist/providers/gemini.js';

const PROXY_BASE_URL = 'http://127.0.0.1:8765/v1beta';
const MAX_ROUNDS = 4;
const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'gemini-2.5-flash';

const TOOLS = [
  {
    name: 'add',
    description: 'Add two integers and return the sum.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'echo',
    description: 'Echo back the given text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

/** "Chạy" tool ở phía client (không gọi API ngoài). */
function runToolLocally(call) {
  if (call.name === 'add') return String(Number(call.args.a) + Number(call.args.b));
  if (call.name === 'echo') return String(call.args.text ?? '');
  return `không rõ tool ${call.name}`;
}

async function proxyUp() {
  try {
    const res = await fetch('http://127.0.0.1:8765/', { signal: AbortSignal.timeout(3000) });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await proxyUp())) {
    console.error('Proxy Gemini local (127.0.0.1:8765) không chạy — khởi động proxy trước, xem docs/live-test-gemini.md.');
    process.exit(2);
  }
  const provider = new GeminiProvider({
    id: 'gemini',
    label: 'Gemini',
    apiKey: 'via-proxy',
    baseUrl: PROXY_BASE_URL,
    defaultModel: model,
  });
  const messages = [
    { role: 'system', content: 'Bạn là trợ lý của open-bot. Dùng tool khi được yêu cầu.' },
    {
      role: 'user',
      content: 'Tính 17 + 25 bằng tool add, rồi dùng tool echo để nhắc lại kết quả.',
    },
  ];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  const started = Date.now();
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const roundStarted = Date.now();
    let res;
    try {
      res = await provider.chat({ model, messages, tools: TOOLS });
    } catch (err) {
      if (/429/.test(String(err?.message ?? err))) {
        console.error(`[vòng ${round}] HTTP 429 (hết quota free tier) — dừng, thử lại sau.`);
        process.exit(3);
      }
      throw err;
    }
    if (res.usage) {
      totalUsage.inputTokens += res.usage.inputTokens ?? 0;
      totalUsage.outputTokens += res.usage.outputTokens ?? 0;
    }
    console.log(
      `[vòng ${round}] ${Date.now() - roundStarted}ms ` +
        `text=${JSON.stringify(res.text)} toolCalls=${JSON.stringify(res.toolCalls)} ` +
        `usage=${JSON.stringify(res.usage)}`,
    );
    if (res.toolCalls.length === 0) {
      console.log(`Xong sau ${round} vòng, tổng ${Date.now() - started}ms, usage cộng dồn: ${JSON.stringify(totalUsage)}`);
      console.log(`Đáp cuối: ${res.text}`);
      return;
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const result = runToolLocally(call);
      console.log(`  -> chạy tool ${call.name}(${JSON.stringify(call.args)}) = ${result}`);
      messages.push({ role: 'tool', content: result, toolCallId: call.id });
    }
  }
  console.log(`Hết ${MAX_ROUNDS} vòng mà model vẫn gọi tool — dừng. Tổng ${Date.now() - started}ms, usage: ${JSON.stringify(totalUsage)}`);
}

main().catch((err) => {
  console.error('GEMINI_LIVE_LOOP_FAILED', err);
  process.exit(1);
});
