#!/usr/bin/env node
/**
 * query-sdk-example.mjs — ví dụ dùng Agent SDK query() (v1.01, Team T6).
 *
 * Chạy agent loop trong chính process này, stream event ra stdout:
 *
 *   # Mặc định: mock provider (không cần key, không gọi mạng).
 *   node scripts/query-sdk-example.mjs
 *
 *   # Provider thật (cần key trong env):
 *   OPENBOT_QUERY_PROVIDER=gemini OPENBOT_QUERY_MODEL=gemini-2.5-flash \
 *     OPENBOT_QUERY_API_KEY=<key> node scripts/query-sdk-example.mjs "Giải thích ..."
 *
 * Prompt lấy từ argv (mặc định: hỏi giờ + nhờ tool get_time trả lời).
 * Yêu cầu: build core trước (`npm run build --workspace=@open-bot/core`).
 */
import { createMockProvider, query } from '../packages/core/dist/index.js';

const prompt = process.argv.slice(2).join(' ').trim() ||
  'Mấy giờ rồi? Dùng tool get_time để trả lời, rồi nói ngắn gọn.';

const providerId = process.env.OPENBOT_QUERY_PROVIDER?.trim();
const model = process.env.OPENBOT_QUERY_MODEL?.trim();
const apiKey = process.env.OPENBOT_QUERY_API_KEY?.trim();

/** Tool demo: trả giờ hiện tại (giờ hệ thống của máy chạy script). */
const getTimeTool = {
  definition: {
    name: 'get_time',
    description: 'Trả về giờ hiện tại của hệ thống (chuỗi ISO).',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  needsApproval: false,
  async execute() {
    return new Date().toISOString();
  },
};

let options;
if (providerId) {
  if (!model) {
    console.error('Thiếu OPENBOT_QUERY_MODEL khi dùng provider thật.');
    process.exit(1);
  }
  console.error(`[sdk-example] provider thật: ${providerId} / ${model}`);
  options = {
    providerId,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    tools: [getTimeTool],
    maxTurns: 5,
  };
} else {
  console.error('[sdk-example] mock provider (không cần key, không gọi mạng)');
  // Vòng 1: mock gọi tool get_time; vòng 2: mock trả text cuối.
  const provider = createMockProvider([
    { text: '', toolCalls: [{ id: 'call-1', name: 'get_time', args: {} }] },
    { text: 'Đã hỏi tool get_time — giờ hệ thống đã có trong kết quả tool.' },
  ]);
  options = { provider, model: 'mock', tools: [getTimeTool], maxTurns: 5 };
}

const handle = query(prompt, options);

// Stream event khi chạy.
for await (const event of handle) {
  if (event.type === 'text') process.stdout.write(event.text);
  else if (event.type === 'tool_call') {
    process.stdout.write(`\n[tool_call ${event.call.name} ${JSON.stringify(event.call.args)}]\n`);
  } else if (event.type === 'tool_result') {
    process.stdout.write(`[tool_result ok=${event.result.ok}]\n`);
  } else if (event.type === 'done') {
    process.stdout.write(`\n[done turns=${event.turns} toolCalls=${event.toolCalls} aborted=${event.aborted}]\n`);
  } else if (event.type === 'error') {
    process.stderr.write(`\n[error ${event.message}]\n`);
  }
}

const result = await handle.result();
console.error(`[sdk-example] result: ${JSON.stringify(result)}`);
const tree = handle.treeSnapshot();
if (tree) console.error(`[sdk-example] subagent tree: ${tree.totalNodes} node, ${tree.totalTokensUsed} token`);
