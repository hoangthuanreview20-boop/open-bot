#!/usr/bin/env node
/**
 * Fake `grok` CLI — CHỈ DÙNG CHO TEST (tests/detected-cli-m2.test.mjs).
 *
 * - `--version` -> 'grok/1.0.41 (Fake)'.
 * - `grok --permission-mode default agent stdio` -> ACP (JSON-RPC NDJSON
 *   trên stdio, theo Agent Client Protocol công khai — CHƯA kiểm chứng
 *   trên Grok CLI thật, xem packages/core/src/providers/cli/acp.ts):
 *   `initialize` -> {protocolVersion, agentCapabilities, agentInfo};
 *   `session/new` -> {sessionId}; `session/load` -> {} (hoặc lỗi
 *   -32600 khi `FAKE_GROK_LOAD_FAIL=1`); `session/prompt` ->
 *   notification `session/update` (`agent_message_chunk` + `usage_update`)
 *   rồi response {stopReason: 'end_turn'}.
 *
 * Hành vi điều khiển bằng biến môi trường:
 * - `FAKE_GROK_MODE`: 'default' | 'approval' | 'toolcall' | 'slow' |
 *   'die' | 'die-after-first' | 'refusal'
 *   - 'approval': trước khi hoàn thành prompt, gửi request
 *     `session/request_permission` từ server (options allow_once +
 *     reject_once) và chờ driver trả lời (ghi response vào
 *     FAKE_GROK_APPROVAL_LOG), rồi mới hoàn thành.
 *   - 'die': gửi một chunk rồi exit(1) giữa turn.
 *   - 'die-after-first': prompt đầu hoàn thành bình thường, prompt thứ
 *     2 trở đi thì exit(1) giữa turn (test resume sau khi process chết).
 *   - 'refusal': trả {stopReason: 'refusal'} mà không gửi chunk nào.
 * - `FAKE_GROK_LOG`: file append mỗi user prompt nhận được
 *   ('prompt:<text>' — text là block text đầu tiên, có thể đã gộp
 *   system prompt).
 * - `FAKE_GROK_SESSION_LOG`: file append mỗi thao tác session
 *   ('new' | 'load:<sessionId>' | 'prompt:<sessionId>:<text>').
 * - `FAKE_GROK_APPROVAL_LOG`: file append response driver trả cho
 *   request_permission (dạng JSON một dòng).
 * - `FAKE_GROK_SPAWN_LOG` / `FAKE_GROK_PID_FILE` /
 *   `FAKE_GROK_ENV_DUMP`: như fake-claude.
 * - `FAKE_GROK_LOAD_FAIL=1`: `session/load` trả lỗi -32600
 *   'no session found'.
 *
 * Không gọi API thật, không đọc credential thật. Login của Grok thật
 * kiểm tra bằng file `~/.grok/auth.json` (detector M1) — fake này
 * không đụng tới file đó; test dùng thư mục home tạm.
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_GROK_MODE ?? 'default';

function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Log test là best-effort.
  }
}

if (args.includes('--version')) {
  console.log('grok/1.0.41 (Fake)');
  process.exit(0);
}

// Chế độ ACP (nhận diện bằng 'agent' + 'stdio').
if (!(args.includes('agent') && args.includes('stdio'))) {
  console.error(`fake-grok: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}

appendLog(process.env.FAKE_GROK_SPAWN_LOG, 'spawned');
if (process.env.FAKE_GROK_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_GROK_PID_FILE, String(process.pid));
  } catch {
    // ignore
  }
}
if (process.env.FAKE_GROK_ENV_DUMP) {
  try {
    fs.writeFileSync(process.env.FAKE_GROK_ENV_DUMP, JSON.stringify(process.env));
  } catch {
    // ignore
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const SESSION_ID = 'session-fake-1';
let promptCount = 0;
let awaitingPermissionResponse = false;
let pendingPrompt = null;

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
  // Đang chờ response cho request_permission thì dòng này là response đó.
  if (awaitingPermissionResponse) {
    awaitingPermissionResponse = false;
    appendLog(process.env.FAKE_GROK_APPROVAL_LOG, line.trim());
    finishPromptAfterApproval();
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: 'grok-fake', version: '1.0.41' },
      },
    });
    return;
  }
  if (method === 'session/new') {
    appendLog(process.env.FAKE_GROK_SESSION_LOG, 'new');
    send({ id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (method === 'session/load') {
    const loadId = params.sessionId ?? SESSION_ID;
    appendLog(process.env.FAKE_GROK_SESSION_LOG, `load:${loadId}`);
    if (process.env.FAKE_GROK_LOAD_FAIL === '1') {
      send({ id, error: { code: -32600, message: `no session found: ${loadId}` } });
      return;
    }
    send({ id, result: {} });
    return;
  }
  if (method === 'session/prompt') {
    promptCount += 1;
    const prompt = Array.isArray(params.prompt) ? params.prompt : [];
    const text = prompt.map((b) => b.text ?? '').join('\n');
    // Log từng prompt block riêng (một dòng 'prompt:' mỗi message) để
    // test kiểm tra delta/resend chính xác.
    for (const block of prompt) {
      appendLog(process.env.FAKE_GROK_LOG, `prompt:${block.text ?? ''}`);
      appendLog(process.env.FAKE_GROK_SESSION_LOG, `prompt:${params.sessionId}:${block.text ?? ''}`);
    }
    pendingPrompt = { id, sessionId: params.sessionId ?? SESSION_ID, text };
    if (mode === 'slow') return; // không bao giờ trả lời (test timeout/abort)
    if (mode === 'refusal') {
      send({ id, result: { stopReason: 'refusal' } });
      return;
    }
    if (mode === 'die' || (mode === 'die-after-first' && promptCount >= 2)) {
      send({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial…' } },
        },
      });
      process.exit(1);
    }
    if (mode === 'approval') {
      // Gửi request_permission từ server, chờ driver trả lời rồi mới xong.
      awaitingPermissionResponse = true;
      send({
        jsonrpc: '2.0',
        id: 'srv-permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'tc-1',
            title: 'run_terminal_command',
            kind: 'execute',
            status: 'pending',
            content: [],
            rawInput: { command: 'rm -rf /' },
          },
          options: [
            { id: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
            { id: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      });
      return;
    }
    finishPrompt(pendingPrompt);
    return;
  }
  if (method === 'session/cancel') {
    send({ id, result: {} });
    return;
  }
  // Method lạ: trả lỗi JSON-RPC -32601 (như server thật).
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function finishPromptAfterApproval() {
  if (!pendingPrompt) return;
  const prompt = pendingPrompt;
  pendingPrompt = null;
  finishPrompt(prompt);
}

function finishPrompt(prompt) {
  const reply = `Fake reply to: ${prompt.text.slice(0, 50)}`;
  if (mode === 'toolcall') {
    send({
      method: 'session/update',
      params: {
        sessionId: prompt.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'read_file',
          kind: 'read',
          status: 'in_progress',
          content: [],
          rawInput: { path: '/tmp/x.txt' },
        },
      },
    });
  }
  send({
    method: 'session/update',
    params: {
      sessionId: prompt.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
    },
  });
  send({
    method: 'session/update',
    params: {
      sessionId: prompt.sessionId,
      update: { sessionUpdate: 'usage_update', usage: { inputTokens: 11, outputTokens: 6 } },
    },
  });
  send({ id: prompt.id, result: { stopReason: 'end_turn' } });
}
