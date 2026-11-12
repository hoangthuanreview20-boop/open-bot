#!/usr/bin/env node
/**
 * Fake `codex` CLI — CHỈ DÙNG CHO TEST (tests/detected-cli-m1.test.mjs,
 * tests/detected-cli-m2.test.mjs).
 *
 * - `--version` -> 'codex-cli 0.164.0-alpha.9'.
 * - `login status` -> exit 0 + dòng 'Logged in as test@example.com…';
 *   `FAKE_CODEX_AUTH=fail` -> exit 1 (chưa đăng nhập).
 * - `app-server --help` -> exit 0 (detector M2 kiểm tra subcommand có sẵn).
 * - `app-server` -> JSON-RPC NDJSON trên stdio (theo protocol thật của
 *   codex 0.164.0-alpha.9 — schema sinh từ CLI thật, xem
 *   packages/core/src/providers/cli/codexAppServer.ts):
 *   `initialize` -> result {userAgent, codexHome, platformFamily,
 *   platformOs}; `thread/start` -> result {thread: {id}} + notification
 *   `thread/started`; `thread/resume` -> result {thread: {id}} (hoặc
 *   lỗi -32600 khi `FAKE_CODEX_RESUME_FAIL=1`); `turn/start` -> delta
 *   `item/agentMessage/delta` + `thread/tokenUsage/updated` +
 *   `turn/completed`.
 *
 * Hành vi điều khiển bằng biến môi trường:
 * - `FAKE_CODEX_MODE`: 'default' | 'approval' | 'toolcall' | 'slow' |
 *   'die' | 'die-after-first' | 'turnerror'
 *   - 'approval': trước khi hoàn thành turn, gửi request
 *     `item/commandExecution/requestApproval` từ server và chờ driver
 *     trả lời (ghi response vào FAKE_CODEX_APPROVAL_LOG), rồi mới
 *     hoàn thành turn.
 *   - 'die': gửi delta rồi exit(1) giữa turn.
 *   - 'die-after-first': turn đầu hoàn thành bình thường, turn thứ 2
 *     trở đi thì exit(1) giữa turn (test resume sau khi process chết).
 *   - 'turnerror': trả JSON-RPC error cho request `turn/start`.
 * - `FAKE_CODEX_LOG`: file append mỗi user message nhận được
 *   ('prompt:<text>').
 * - `FAKE_CODEX_THREAD_LOG`: file append mỗi thao tác thread
 *   ('start' | 'resume:<threadId>' | 'turn:<threadId>:<text>').
 * - `FAKE_CODEX_APPROVAL_LOG`: file append response driver trả cho
 *   approval request (dạng JSON một dòng).
 * - `FAKE_CODEX_SPAWN_LOG` / `FAKE_CODEX_PID_FILE` /
 *   `FAKE_CODEX_ENV_DUMP`: như fake-claude.
 * - `FAKE_CODEX_RESUME_FAIL=1`: `thread/resume` trả lỗi -32600
 *   'no rollout found' (bắt chước hành vi thật đã probe live).
 *
 * Không gọi API thật, không đọc credential thật.
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? 'default';

function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Log test là best-effort.
  }
}

if (args.includes('--version')) {
  console.log('codex-cli 0.164.0-alpha.9');
  process.exit(0);
}

if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_AUTH === 'fail') {
    console.error('Not logged in (fake)');
    process.exit(1);
  }
  console.log('Logged in as test@example.com (ChatGPT Plus)');
  process.exit(0);
}

if (args[0] === 'app-server' && args.includes('--help')) {
  console.log('Usage: codex app-server [OPTIONS] [COMMAND]\n\nCommands:\n  daemon  Manage the local app-server daemon');
  process.exit(0);
}

// Chế độ app-server (nhận diện bằng subcommand 'app-server').
if (args[0] !== 'app-server') {
  console.error(`fake-codex: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}

appendLog(process.env.FAKE_CODEX_SPAWN_LOG, 'spawned');
if (process.env.FAKE_CODEX_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
  } catch {
    // ignore
  }
}
if (process.env.FAKE_CODEX_ENV_DUMP) {
  try {
    fs.writeFileSync(process.env.FAKE_CODEX_ENV_DUMP, JSON.stringify(process.env));
  } catch {
    // ignore
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const THREAD_ID = 'thread-fake-1';
let turnCount = 0;
let awaitingApprovalResponse = false;

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
  // Đang chờ response cho approval request thì dòng này là response đó.
  if (awaitingApprovalResponse) {
    awaitingApprovalResponse = false;
    appendLog(process.env.FAKE_CODEX_APPROVAL_LOG, line.trim());
    finishTurnAfterApproval();
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialized') return; // notification, không cần trả lời.
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  if (method === 'initialize') {
    send({
      id,
      result: {
        userAgent: 'fake-codex/0.164.0 (Linux; x86_64) open-bot; 0.44',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    return;
  }
  if (method === 'thread/start') {
    appendLog(process.env.FAKE_CODEX_THREAD_LOG, 'start');
    send({
      id,
      result: {
        thread: { id: THREAD_ID },
        model: 'gpt-fake',
        modelProvider: 'openai',
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly', networkAccess: false },
        cwd: params.cwd ?? '/tmp',
      },
    });
    send({ method: 'thread/started', params: { thread: { id: THREAD_ID } } });
    return;
  }
  if (method === 'thread/resume') {
    const resumeId = params.threadId ?? THREAD_ID;
    appendLog(process.env.FAKE_CODEX_THREAD_LOG, `resume:${resumeId}`);
    if (process.env.FAKE_CODEX_RESUME_FAIL === '1') {
      send({
        id,
        error: { code: -32600, message: `no rollout found for thread id ${resumeId}` },
      });
      return;
    }
    send({ id, result: { thread: { id: resumeId } } });
    return;
  }
  if (method === 'turn/start') {
    turnCount += 1;
    const input = Array.isArray(params.input) ? params.input : [];
    const text = input.map((i) => i.text ?? '').join('\n');
    // Log từng input item riêng (một dòng 'prompt:' mỗi message) để
    // test kiểm tra delta/resend chính xác.
    for (const item of input) {
      appendLog(process.env.FAKE_CODEX_LOG, `prompt:${item.text ?? ''}`);
      appendLog(process.env.FAKE_CODEX_THREAD_LOG, `turn:${params.threadId}:${item.text ?? ''}`);
    }
    pendingTurn = { id, threadId: params.threadId ?? THREAD_ID, text };
    if (mode === 'slow') return; // không bao giờ trả lời (test timeout/abort)
    if (mode === 'turnerror') {
      send({ id, error: { code: -32000, message: 'fake turn boom' } });
      return;
    }
    if (mode === 'die' || (mode === 'die-after-first' && turnCount >= 2)) {
      send({
        method: 'item/agentMessage/delta',
        params: { delta: 'partial…', itemId: 'msg-1', threadId: params.threadId, turnId: 'turn-1' },
      });
      process.exit(1);
    }
    if (mode === 'approval') {
      // Gửi approval request từ server, chờ driver trả lời rồi mới xong turn.
      awaitingApprovalResponse = true;
      send({
        jsonrpc: '2.0',
        id: 'srv-approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          callId: 'call-1',
          command: { cmd: 'rm -rf /' },
          reason: 'fake approval',
        },
      });
      return;
    }
    finishTurn(pendingTurn);
    return;
  }
  // Method lạ: trả lỗi JSON-RPC -32601 (như server thật).
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let pendingTurn = null;

function finishTurnAfterApproval() {
  if (!pendingTurn) return;
  const turn = pendingTurn;
  pendingTurn = null;
  finishTurn(turn);
}

function finishTurn(turn) {
  const reply = `Fake reply to: ${turn.text.slice(0, 50)}`;
  if (mode === 'toolcall') {
    send({
      method: 'item/completed',
      params: {
        item: { type: 'commandExecution', id: 'item-1', command: 'ls /tmp' },
        threadId: turn.threadId,
      },
    });
  }
  send({
    method: 'item/agentMessage/delta',
    params: { delta: reply, itemId: 'msg-1', threadId: turn.threadId, turnId: 'turn-1' },
  });
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: turn.threadId,
      turnId: 'turn-1',
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 15 },
        total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 15 },
      },
    },
  });
  send({
    method: 'turn/completed',
    params: {
      threadId: turn.threadId,
      turn: {
        id: 'turn-1',
        items: [{ type: 'agentMessage', id: 'msg-1', text: reply }],
      },
    },
  });
}
