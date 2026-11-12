#!/usr/bin/env node
/**
 * Fake ACP CLI chung — CHỈ DÙNG CHO TEST (tests/detected-cli-m3.test.mjs).
 *
 * Một script duy nhất đóng vai mọi CLI nói ACP (OpenCode, Gemini CLI,
 * Cursor CLI, custom ACP, Grok) — test copy nó thành binary tên khác
 * nhau trong thư mục tạm. Hành vi theo tên binary (basename argv[1])
 * và biến môi trường; KHÔNG gọi API thật, KHÔNG đọc credential thật.
 *
 * - `--version` -> 'opencode/1.2.3 (Fake)' | 'gemini/0.45.0 (Fake)' |
 *   'cursor-agent/2026.1.0 (Fake)' | 'grok/1.0.41 (Fake)' |
 *   'fake-acp/1.0.0 (Fake)' (theo tên binary).
 * - `auth list` (OpenCode) -> 2 dòng provider, không secret.
 * - `status --format json` (Cursor) -> {loggedIn: true, email}.
 * - ACP stdio khi args chứa 'acp' | '--acp' | '--experimental-acp':
 *   `initialize` -> {protocolVersion: 1, agentInfo};
 *   `authenticate` -> {} (ghi methodId vào FAKE_ACP_AUTHENTICATE_LOG);
 *   `session/new` -> {sessionId}; `session/load` -> {} (hoặc lỗi
 *   -32600 khi FAKE_ACP_LOAD_FAIL=1); `session/prompt` ->
 *   notification `session/update` (agent_message_chunk + usage_update)
 *   rồi response {stopReason: 'end_turn'}.
 *
 * Hành vi điều khiển bằng biến môi trường (tiền tố FAKE_ACP_):
 * - `FAKE_ACP_MODE`: 'default' | 'approval' | 'toolcall' | 'slow' |
 *   'die' | 'die-after-first' | 'refusal' | 'fsrequest'
 *   - 'approval': gửi request `session/request_permission` (options
 *     allow_once + reject_once), chờ driver trả lời (ghi response vào
 *     FAKE_ACP_APPROVAL_LOG), rồi mới hoàn thành.
 *   - 'fsrequest': gửi request `fs/read_text_file` từ server, chờ
 *     driver trả lời (ghi response vào FAKE_ACP_SERVER_REQUEST_LOG),
 *     rồi mới hoàn thành — driver phải trả lỗi JSON-RPC -32601.
 *   - 'die': gửi một chunk rồi exit(1) giữa turn.
 *   - 'die-after-first': prompt đầu xong bình thường, prompt thứ 2
 *     trở đi thì exit(1) giữa turn (test resume sau khi process chết).
 *   - 'refusal': trả {stopReason: 'refusal'} mà không gửi chunk nào.
 * - `FAKE_ACP_REJECT_ACP_FLAG=1`: `initialize` trả lỗi -32600 khi
 *   args chứa '--acp' nhưng KHÔNG chứa '--experimental-acp' (giả lập
 *   Gemini CLI bản cũ chỉ biết cờ `--experimental-acp`).
 * - `FAKE_ACP_LOG`: file append mỗi user prompt nhận được
 *   ('prompt:<text>' — text là block text đầu tiên, có thể đã gộp
 *   system prompt).
 * - `FAKE_ACP_SESSION_LOG`: file append mỗi thao tác session
 *   ('new' | 'load:<sessionId>' | 'prompt:<sessionId>:<text>').
 * - `FAKE_ACP_APPROVAL_LOG` / `FAKE_ACP_SERVER_REQUEST_LOG` /
 *   `FAKE_ACP_AUTHENTICATE_LOG`: như tên gọi.
 * - `FAKE_ACP_SPAWN_LOG`: file append mỗi lần spawn
 *   ('spawned:<args nối bằng khoảng trắng>').
 * - `FAKE_ACP_PID_FILE` / `FAKE_ACP_ENV_DUMP`: như fake-claude.
 * - `FAKE_ACP_LOAD_FAIL=1`: `session/load` trả lỗi -32600
 *   'no session found'.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const mode = process.env.FAKE_ACP_MODE ?? 'default';
const binaryName = path.basename(process.argv[1] ?? 'fake-acp');

function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Log test là best-effort.
  }
}

if (args.includes('--version')) {
  const versions = {
    opencode: 'opencode/1.2.3 (Fake)',
    gemini: 'gemini/0.45.0 (Fake)',
    'cursor-agent': 'cursor-agent/2026.1.0 (Fake)',
    agent: 'cursor-agent/2026.1.0 (Fake)',
    grok: 'grok/1.0.41 (Fake)',
  };
  console.log(versions[binaryName] ?? 'fake-acp/1.0.0 (Fake)');
  process.exit(0);
}

// OpenCode: `opencode auth list` — liệt kê provider đã lưu, không secret.
if (args[0] === 'auth' && args[1] === 'list') {
  console.log('Anthropic (oauth)');
  console.log('OpenAI (api)');
  process.exit(0);
}

// Cursor: `cursor-agent status --format json`.
if (args[0] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, email: 'cursor-user@example.com' }));
  process.exit(0);
}

// Chế độ ACP (nhận diện bằng 'acp' | '--acp' | '--experimental-acp').
if (!(args.includes('acp') || args.includes('--acp') || args.includes('--experimental-acp'))) {
  console.error(`fake-acp-generic: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}

appendLog(process.env.FAKE_ACP_SPAWN_LOG, `spawned:${args.join(' ')}`);
if (process.env.FAKE_ACP_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
  } catch {
    // ignore
  }
}
if (process.env.FAKE_ACP_ENV_DUMP) {
  try {
    fs.writeFileSync(process.env.FAKE_ACP_ENV_DUMP, JSON.stringify(process.env));
  } catch {
    // ignore
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const SESSION_ID = 'session-fake-acp-1';
let promptCount = 0;
let awaitingServerResponse = null; // { kind: 'approval' | 'fsrequest' }
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
  // Đang chờ response cho một request từ server thì dòng này là response đó.
  if (awaitingServerResponse) {
    const kind = awaitingServerResponse;
    awaitingServerResponse = null;
    if (kind === 'approval') appendLog(process.env.FAKE_ACP_APPROVAL_LOG, line.trim());
    else appendLog(process.env.FAKE_ACP_SERVER_REQUEST_LOG, line.trim());
    finishPromptAfterServerResponse();
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
    // Giả lập Gemini CLI bản cũ: chỉ biết --experimental-acp.
    if (
      process.env.FAKE_ACP_REJECT_ACP_FLAG === '1' &&
      args.includes('--acp') &&
      !args.includes('--experimental-acp')
    ) {
      send({ id, error: { code: -32600, message: 'ACP flag --acp not supported in this old version' } });
      return;
    }
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: 'fake-acp-generic', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'authenticate') {
    appendLog(process.env.FAKE_ACP_AUTHENTICATE_LOG, `authenticate:${params.methodId ?? ''}`);
    send({ id, result: {} });
    return;
  }
  if (method === 'session/new') {
    appendLog(process.env.FAKE_ACP_SESSION_LOG, 'new');
    send({ id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (method === 'session/load') {
    const loadId = params.sessionId ?? SESSION_ID;
    appendLog(process.env.FAKE_ACP_SESSION_LOG, `load:${loadId}`);
    if (process.env.FAKE_ACP_LOAD_FAIL === '1') {
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
    for (const block of prompt) {
      appendLog(process.env.FAKE_ACP_LOG, `prompt:${block.text ?? ''}`);
      appendLog(process.env.FAKE_ACP_SESSION_LOG, `prompt:${params.sessionId}:${block.text ?? ''}`);
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
      awaitingServerResponse = 'approval';
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
    if (mode === 'fsrequest') {
      awaitingServerResponse = 'fsrequest';
      send({
        jsonrpc: '2.0',
        id: 'srv-fs-1',
        method: 'fs/read_text_file',
        params: { sessionId: params.sessionId, path: '/etc/passwd' },
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

function finishPromptAfterServerResponse() {
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
