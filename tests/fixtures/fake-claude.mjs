#!/usr/bin/env node
/**
 * Fake `claude` CLI — CHỈ DÙNG CHO TEST (tests/detected-cli-m1.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Hành vi điều khiển bằng
 * biến môi trường để test từng trường hợp:
 *
 * - `FAKE_CLAUDE_VERSION`: output của `--version` (mặc định
 *   'claude/2.1.318 (Fake)').
 * - `FAKE_CLAUDE_AUTH=fail`: `auth status` exit 1 (chưa đăng nhập).
 * - `FAKE_CLAUDE_MODE`: 'default' | 'toolcall' | 'error' | 'die' | 'slow'
 *   (xem handleLine). Mặc định 'default'.
 * - `FAKE_CLAUDE_LOG`: file append mỗi user message nhận được
 *   ('prompt:<text>') — test kiểm tra delta gửi.
 * - `FAKE_CLAUDE_SPAWN_LOG`: file append 'spawned' mỗi lần process
 *   khởi động — test kiểm tra restart.
 * - `FAKE_CLAUDE_PID_FILE`: file ghi pid process — test kiểm tra kill.
 * - `FAKE_CLAUDE_ENV_DUMP`: file ghi JSON process.env lúc spawn —
 *   test kiểm tra env sanitization.
 *
 * Stream-JSON: mỗi user message NDJSON trên stdin -> 1 assistant event
 * + 1 result event (giữ process sống để test retained process).
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'default';

function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Log test là best-effort.
  }
}

if (args.includes('--version')) {
  console.log(process.env.FAKE_CLAUDE_VERSION ?? 'claude/2.1.318 (Fake)');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_CLAUDE_AUTH === 'fail') {
    console.error('Not logged in (fake)');
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      email: 'test@example.com',
      organization: 'Test Org',
      loginExpiresAt: '2027-01-01T00:00:00Z',
    }),
  );
  process.exit(0);
}

// Chế độ stream-json (nhận diện bằng cờ --output-format stream-json).
if (!args.includes('stream-json')) {
  console.error(`fake-claude: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}

appendLog(process.env.FAKE_CLAUDE_SPAWN_LOG, 'spawned');
if (process.env.FAKE_CLAUDE_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
  } catch {
    // ignore
  }
}
if (process.env.FAKE_CLAUDE_ENV_DUMP) {
  try {
    fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_DUMP, JSON.stringify(process.env));
  } catch {
    // ignore
  }
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
out({ type: 'system', subtype: 'init', session_id: 'fake-session-1', model: 'claude-fake' });

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx = buffer.indexOf('\n');
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handleLine(line);
    idx = buffer.indexOf('\n');
  }
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const text = msg?.message?.content?.[0]?.text ?? '';
  appendLog(process.env.FAKE_CLAUDE_LOG, `prompt:${text}`);
  if (mode === 'slow') return; // không bao giờ trả lời (test timeout/abort)
  if (mode === 'die') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial…' }] } });
    process.exit(1);
  }
  if (mode === 'error') {
    out({
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['fake boom'],
      session_id: 'fake-session-1',
    });
    return;
  }
  const reply = `Fake reply to: ${text.slice(0, 50)}`;
  const blocks = [{ type: 'text', text: reply }];
  if (mode === 'toolcall') {
    blocks.push({
      type: 'tool_use',
      id: 'toolu_fake1',
      name: 'read_file',
      input: { path: '/tmp/x.txt' },
    });
  }
  out({ type: 'assistant', message: { content: blocks } });
  out({
    type: 'result',
    subtype: 'success',
    result: reply,
    usage: { input_tokens: 10, output_tokens: 5 },
    session_id: 'fake-session-1',
  });
}
