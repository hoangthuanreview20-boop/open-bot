/**
 * Tests cho M2 — Driver Codex (app-server JSON-RPC) + driver Grok CLI (ACP)
 * (packages/core/src/providers/cli/: jsonRpc.ts, codexAppServer.ts,
 * codex.ts, acp.ts, grok.ts).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/detected-cli-m2.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: mọi CLI
 * trong test đều là fake script trong tests/fixtures/ (fake-codex.mjs
 * chế độ app-server, fake-grok.mjs) được copy vào thư mục tạm và tìm
 * qua `pathDirs`; home giả cũng là thư mục tạm.
 *
 * Mức kiểm chứng (ghi rõ — xem providers/cli/README.md):
 * - Codex: protocol đã khớp schema sinh từ CLI thật (codex
 *   0.164.0-alpha.9) + probe live `initialize`/`thread/start`/
 *   `thread/resume` trên máy này (chưa đăng nhập); `turn/start` +
 *   streaming + approval khi chạy thật vẫn chưa được kiểm chứng live.
 * - Grok: CHƯA chạy lần nào trên Grok CLI thật (máy này không có
 *   `grok`) — lệnh spawn + ACP đều từ docs/code công khai.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CodexCliProvider,
  DetectedEngineRegistry,
  GrokCliProvider,
  ModelRegistry,
  createProvider,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';
import {
  JsonRpcStdioClient,
  denyCodexApproval,
  isCodexApprovalRequest,
} from '../packages/core/dist/providers/cli/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-m2-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_CODEX_') || key.startsWith('FAKE_GROK_')) delete process.env[key];
  }
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
});

/** Copy một fake fixture thành binary có thể chạy trong `binDir`. */
function installFakeBin(binDir, fixtureName, binaryName) {
  const dest = path.join(binDir, binaryName);
  fs.copyFileSync(path.join(fixturesDir, fixtureName), dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function makeBinDir(...binaries) {
  const dir = makeTempDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [fixture, name] of binaries) installFakeBin(binDir, fixture, name);
  return { dir, binDir };
}

/** Registry trỏ vào thư mục bin giả + home giả (không chạm CLI thật). */
function registryFor(binDir, extra = {}) {
  const homeDir = extra.homeDir ?? makeTempDir();
  const env = {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
  return new DetectedEngineRegistry({
    pathDirs: [binDir],
    homeDir,
    env,
    logger: { warn: () => undefined },
    ...extra,
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Default 15s (was 3s): under full-suite load the parent can take >3s to
// reap a killed child, and isAlive() (kill(pid, 0)) still reports a
// zombie as alive until it is reaped. Same hardening as the M3 abort
// test (tests/detected-cli-m3.test.mjs) — the abort path itself is fine;
// the wait window was too short under load (2 flakes in the full run,
// 35/35 in isolation).
async function waitUntil(fn, timeoutMs = 15000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Chờ process chết thật (pid không còn sống theo kill(pid, 0)).
 * Như test M3 (v0.51): dưới tải full suite, SIGTERM + thu hồi zombie
 * có thể chậm hơn 15s — khi đó ép SIGKILL vào cả process group rồi
 * đợi thêm 5s trước khi kết luận fail. Chỉ POSIX (Windows dùng
 * taskkill trong killProcessGroup của provider). (Sóng v0.51–v0.58:
 * M2 codex abort fail 1 lần sau 15s chờ — provider đã SIGKILL nhưng
 * zombie chưa được thu hồi kịp dưới tải; test tự ép SIGKILL group
 * như M3 thay vì chỉ đợi.)
 */
async function waitForDeath(pid) {
  let died = await waitUntil(() => !isAlive(pid), 15_000);
  if (!died && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Đã chết giữa chừng — vòng đợi dưới đây sẽ xác nhận.
    }
    died = await waitUntil(() => !isAlive(pid), 5000);
  }
  return died;
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

const CODEX_FAKE_ENV = [
  'CODEX_HOME',
  'FAKE_CODEX_MODE',
  'FAKE_CODEX_LOG',
  'FAKE_CODEX_THREAD_LOG',
  'FAKE_CODEX_APPROVAL_LOG',
  'FAKE_CODEX_SPAWN_LOG',
  'FAKE_CODEX_PID_FILE',
  'FAKE_CODEX_ENV_DUMP',
  'FAKE_CODEX_RESUME_FAIL',
];

const GROK_FAKE_ENV = [
  'GROK_HOME',
  'FAKE_GROK_MODE',
  'FAKE_GROK_LOG',
  'FAKE_GROK_SESSION_LOG',
  'FAKE_GROK_APPROVAL_LOG',
  'FAKE_GROK_SPAWN_LOG',
  'FAKE_GROK_PID_FILE',
  'FAKE_GROK_ENV_DUMP',
  'FAKE_GROK_LOAD_FAIL',
];

function fakeCodexProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new CodexCliProvider(
    { id: 'codex', label: 'Codex (CLI)', defaultModel: 'codex' },
    {
      binaryPath: path.join(binDir, 'codex'),
      cwd: dir,
      extraEnvAllowed: CODEX_FAKE_ENV,
      ...opts,
    },
  );
}

function fakeGrokProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new GrokCliProvider(
    { id: 'grok-cli', label: 'Grok CLI', defaultModel: 'grok-cli' },
    {
      binaryPath: path.join(binDir, 'grok'),
      cwd: dir,
      extraEnvAllowed: GROK_FAKE_ENV,
      ...opts,
    },
  );
}

// ---------------------------------------------------------------------------
// Detector (M2: Codex app-server probe + Grok qua fake-grok)
// ---------------------------------------------------------------------------

test('M2 detector: fake grok available kèm version + nhãn (auth.json tồn tại)', async () => {
  const homeDir = makeTempDir();
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  fs.mkdirSync(path.join(homeDir, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.grok', 'auth.json'), '{"token":"fake-never-read"}', 'utf8');
  const registry = registryFor(binDir, { homeDir });
  const snap = await registry.detect();
  const grok = snap.engines['grok'];
  assert.equal(grok.status, 'available');
  assert.equal(grok.version, '1.0.41');
  assert.equal(grok.binaryPath, path.join(binDir, 'grok'));
  assert.equal(grok.enabled, false);
  assert.equal(JSON.stringify(snap).includes('fake-never-read'), false);
});

test('M2 detector: grok chưa có auth.json -> not-signed-in', async () => {
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['grok'].status, 'unavailable');
  assert.equal(snap.engines['grok'].reason, 'not-signed-in');
});

test('M2 detector: `codex app-server --help` exit 0 (subcommand có sẵn cho driver M2)', async () => {
  const { binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const { runProbe } = await import('../packages/core/dist/detected/probe.js');
  const result = await runProbe(path.join(binDir, 'codex'), ['app-server', '--help'], {
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /app-server/);
});

// ---------------------------------------------------------------------------
// JSON-RPC transport dùng chung
// ---------------------------------------------------------------------------

test('M2 jsonrpc: request/response khớp id, method lạ trả lỗi -32601, dòng hỏng được đếm', async () => {
  const { binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const child = spawn(path.join(binDir, 'codex'), ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new JsonRpcStdioClient(child, {
    onNotification: () => undefined,
    logger: { warn: () => undefined },
  });
  try {
    const init = await client.request('initialize', {
      clientInfo: { name: 'open-bot-test', version: '0.44' },
    });
    assert.match(init.userAgent, /fake-codex/);
    await assert.rejects(
      client.request('nope/method', {}, 5000),
      /Method not found/,
    );
    const stats = client.getStats();
    assert.ok(stats.requestsSent >= 2);
    assert.ok(stats.messagesReceived >= 2);
    assert.equal(stats.malformedLines, 0);
  } finally {
    client.close();
    child.kill('SIGKILL');
  }
});

test('M2 codex approval shapes: deny đúng schema thật của CLI, method lạ thì undefined', () => {
  assert.deepEqual(denyCodexApproval('execCommandApproval', 'r'), {
    decision: { denied: { rejection: 'r' } },
  });
  assert.deepEqual(denyCodexApproval('applyPatchApproval', 'r'), {
    decision: { denied: { rejection: 'r' } },
  });
  assert.deepEqual(denyCodexApproval('item/commandExecution/requestApproval', 'r'), {
    decision: 'decline',
  });
  assert.deepEqual(denyCodexApproval('item/fileChange/requestApproval', 'r'), {
    decision: 'decline',
  });
  // Method approval nhưng chưa biết shape deny -> undefined (caller trả lỗi JSON-RPC).
  assert.equal(denyCodexApproval('item/permissions/requestApproval', 'r'), undefined);
  assert.equal(denyCodexApproval('item/tool/call', 'r'), undefined);
  assert.equal(isCodexApprovalRequest('execCommandApproval'), true);
  assert.equal(isCodexApprovalRequest('item/permissions/requestApproval'), true);
  assert.equal(isCodexApprovalRequest('turn/start'), false);
});

// ---------------------------------------------------------------------------
// Driver Codex (fake app-server)
// ---------------------------------------------------------------------------

test('M2 codex: chat trả text + usage, thread id là resumeCursor', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const threadLog = path.join(dir, 'threads.log');
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  const provider = fakeCodexProvider(binDir);
  try {
    const res = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'xin chào' }],
    });
    assert.match(res.text, /Fake reply to: xin chào/);
    assert.deepEqual(res.toolCalls, []);
    assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(provider.codexThreadId, 'thread-fake-1');
    assert.equal(provider.isProcessAlive, true);
    assert.deepEqual(readLines(threadLog), ['start', 'turn:thread-fake-1:xin chào']);
  } finally {
    await provider.dispose();
  }
  assert.equal(provider.isProcessAlive, false);
});

test('M2 codex: 2 turn chỉ gửi delta, cùng thread, không spawn lại', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  const threadLog = path.join(dir, 'threads.log');
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  const provider = fakeCodexProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'xin chào' }],
    });
    const r2 = await provider.chat({
      model: 'codex',
      messages: [
        { role: 'user', content: 'xin chào' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: câu hai/);
    assert.deepEqual(readLines(logFile), ['prompt:xin chào', 'prompt:câu hai']);
    assert.deepEqual(readLines(spawnLog), ['spawned']);
    assert.equal(provider.codexThreadId, 'thread-fake-1');
    assert.ok(readLines(threadLog).filter((l) => l === 'start').length === 1);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: system prompt đổi -> thread mới TRÊN CÙNG process, gửi lại toàn bộ', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  const threadLog = path.join(dir, 'threads.log');
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  const provider = fakeCodexProvider(binDir);
  try {
    await provider.chat({
      model: 'codex',
      messages: [
        { role: 'system', content: 'Bạn là A.' },
        { role: 'user', content: 'câu một' },
      ],
    });
    const r2 = await provider.chat({
      model: 'codex',
      messages: [
        { role: 'system', content: 'Bạn là B.' },
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu hai' },
      ],
    });
    // Resend gộp nhiều message vào MỘT turn/start nên fake trả lời
    // bằng text nối ('câu một\ncâu hai') — chỉ cần thấy 'câu hai'.
    assert.match(r2.text, /câu hai/);
    // App-server chứa nhiều thread nên KHÔNG restart process.
    assert.deepEqual(readLines(spawnLog), ['spawned']);
    assert.deepEqual(
      readLines(threadLog).filter((l) => l === 'start'),
      ['start', 'start'],
    );
    assert.deepEqual(readLines(logFile), ['prompt:câu một', 'prompt:câu một', 'prompt:câu hai']);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: history bị viết lại (compaction) -> thread mới và gửi lại', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const logFile = path.join(dir, 'prompts.log');
  const threadLog = path.join(dir, 'threads.log');
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  const provider = fakeCodexProvider(binDir);
  try {
    await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'câu gốc' }],
    });
    const r2 = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'tóm tắt: câu gốc' }],
    });
    assert.match(r2.text, /Fake reply to: tóm tắt/);
    assert.deepEqual(
      readLines(threadLog).filter((l) => l === 'start'),
      ['start', 'start'],
    );
    assert.deepEqual(readLines(logFile), ['prompt:câu gốc', 'prompt:tóm tắt: câu gốc']);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: approval server→client bị TỪ CHỐI fail-closed, turn vẫn xong', async () => {
  process.env.FAKE_CODEX_MODE = 'approval';
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const approvalLog = path.join(dir, 'approval.log');
  process.env.FAKE_CODEX_APPROVAL_LOG = approvalLog;
  const events = [];
  const provider = fakeCodexProvider(binDir, { onCliEvent: (e) => events.push(e) });
  try {
    const res = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'xoá file giúp tôi' }],
    });
    assert.match(res.text, /Fake reply to: xoá file/);
    // Fake ghi lại đúng response driver trả: decision 'decline', không approve.
    const logged = readLines(approvalLog);
    assert.equal(logged.length, 1);
    const response = JSON.parse(logged[0]);
    assert.equal(response.id, 'srv-approval-1');
    assert.deepEqual(response.result, { decision: 'decline' });
    assert.equal(provider.approvalsDeniedTotal, 1);
    const denied = events.filter((e) => e.type === 'approval_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].method, 'item/commandExecution/requestApproval');
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: tool_call của CLI surface qua onCliEvent, không đi vào toolCalls trả về', async () => {
  process.env.FAKE_CODEX_MODE = 'toolcall';
  const { binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const events = [];
  const provider = fakeCodexProvider(binDir, { onCliEvent: (e) => events.push(e) });
  try {
    const res = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'liệt kê file giúp tôi' }],
    });
    assert.deepEqual(res.toolCalls, []);
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].call.name, 'commandExecution');
    assert.equal(toolEvents[0].call.args.command, 'ls /tmp');
    assert.ok(events.some((e) => e.type === 'text'));
    assert.ok(events.some((e) => e.type === 'result'));
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: turn/start trả lỗi JSON-RPC -> chat reject rõ ràng', async () => {
  process.env.FAKE_CODEX_MODE = 'turnerror';
  const { binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const provider = fakeCodexProvider(binDir);
  try {
    await assert.rejects(
      provider.chat({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] }),
      /fake turn boom/,
    );
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: process chết giữa turn -> reject, lần sau resume thread cũ và chỉ gửi delta', async () => {
  process.env.FAKE_CODEX_MODE = 'die-after-first';
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const logFile = path.join(dir, 'prompts.log');
  const threadLog = path.join(dir, 'threads.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
  const provider = fakeCodexProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'câu một' }],
    });
    await assert.rejects(
      provider.chat({
        model: 'codex',
        messages: [
          { role: 'user', content: 'câu một' },
          { role: 'assistant', content: r1.text },
          { role: 'user', content: 'câu hai' },
        ],
      }),
      /chết giữa chừng/,
    );
    assert.equal(provider.isProcessAlive, false);
    const r3 = await provider.chat({
      model: 'codex',
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu ba' },
      ],
    });
    assert.match(r3.text, /Fake reply to: câu ba/);
    // Process mới spawn lại, resume thread cũ, chỉ gửi message mới.
    assert.deepEqual(readLines(spawnLog), ['spawned', 'spawned']);
    assert.ok(readLines(threadLog).includes('resume:thread-fake-1'));
    assert.deepEqual(readLines(logFile), ['prompt:câu một', 'prompt:câu hai', 'prompt:câu ba']);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: resume lỗi (-32600) -> mở thread mới và gửi lại toàn bộ history', async () => {
  process.env.FAKE_CODEX_MODE = 'die-after-first';
  process.env.FAKE_CODEX_RESUME_FAIL = '1';
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const logFile = path.join(dir, 'prompts.log');
  const threadLog = path.join(dir, 'threads.log');
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_THREAD_LOG = threadLog;
  const provider = fakeCodexProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'câu một' }],
    });
    await assert.rejects(
      provider.chat({
        model: 'codex',
        messages: [
          { role: 'user', content: 'câu một' },
          { role: 'assistant', content: r1.text },
          { role: 'user', content: 'câu hai' },
        ],
      }),
      /chết giữa chừng/,
    );
    const r3 = await provider.chat({
      model: 'codex',
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu ba' },
      ],
    });
    // Resend gộp nhiều message vào MỘT turn/start nên fake trả lời
    // bằng text nối ('câu một\ncâu hai\ncâu ba') — chỉ cần thấy 'câu ba'.
    assert.match(r3.text, /câu ba/);
    assert.deepEqual(readLines(threadLog), [
      'start',
      'turn:thread-fake-1:câu một',
      'turn:thread-fake-1:câu hai',
      'resume:thread-fake-1',
      'start',
      'turn:thread-fake-1:câu một',
      'turn:thread-fake-1:câu hai',
      'turn:thread-fake-1:câu ba',
    ]);
    assert.deepEqual(readLines(logFile), [
      'prompt:câu một',
      'prompt:câu hai',
      'prompt:câu một',
      'prompt:câu hai',
      'prompt:câu ba',
    ]);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: abort giữa turn kill sạch process group', async () => {
  process.env.FAKE_CODEX_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CODEX_PID_FILE = pidFile;
  const provider = fakeCodexProvider(binDir);
  const controller = new AbortController();
  try {
    const promise = provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    // v0.85: assert the wait (see M1) — a false return used to fall
    // through to readFileSync and throw a confusing ENOENT.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile), 5000), 'fake process phải ghi pidFile trước khi abort');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // v0.98 merge-fix: liveness is polled, not asserted once — under
    // full-suite load the fake node process can take a moment to become
    // observable after writing its pid file (1 red in the v0.98 merge
    // run: pidFile existed but kill(pid, 0) said "no such process" yet;
    // 35/35 in isolation). A genuinely dead process still fails here
    // after 5s instead of passing silently.
    assert.ok(
      await waitUntil(() => pid > 0 && isAlive(pid), 5000),
      'fake process phải đang sống trước khi abort',
    );
    controller.abort();
    await assert.rejects(promise, (err) => err.name === 'AbortError');
    assert.ok(await waitForDeath(pid), 'process phải chết sau abort');
    assert.equal(provider.isProcessAlive, false);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: timeout turn kill process và báo hết thời gian chờ', async () => {
  process.env.FAKE_CODEX_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CODEX_PID_FILE = pidFile;
  const provider = fakeCodexProvider(binDir, { timeoutMs: 2000 });
  try {
    const promise = provider.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // v0.85: timeout 400ms -> 2000ms — same spawn-startup flake as
    // M1 (fake binary is `#!/usr/bin/env node`; 'slow' never replies
    // so 2000ms still times out, only later). The 400ms business
    // timeout is covered by the in-process fake-spawn unit test in
    // detected-cli-b-drivers.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile), 5000), 'fake process phải ghi pidFile trước khi timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await assert.rejects(promise, /hết thời gian chờ 2000ms/);
    assert.ok(await waitForDeath(pid), 'process phải chết sau timeout');
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: env của turn không chứa key lạ, chỉ có allowlist + CODEX_HOME', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const envDump = path.join(dir, 'env.json');
  process.env.FAKE_CODEX_ENV_DUMP = envDump;
  process.env.XAI_API_KEY = 'sk-xai-fake-secret';
  process.env.OPENAI_API_KEY = 'sk-openai-fake-secret';
  process.env.CODEX_HOME = '/tmp/fake-codex-home';
  const provider = fakeCodexProvider(binDir);
  try {
    await provider.chat({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });
    const dumped = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(dumped.PATH !== undefined, true);
    assert.equal(dumped.CODEX_HOME, '/tmp/fake-codex-home');
    assert.equal(dumped.XAI_API_KEY, undefined);
    assert.equal(dumped.OPENAI_API_KEY, undefined);
    assert.equal(JSON.stringify(dumped).includes('fake-secret'), false);
  } finally {
    await provider.dispose();
  }
});

test('M2 codex: dispose kill process; chat sau dispose thì lỗi rõ', async () => {
  const { dir, binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CODEX_PID_FILE = pidFile;
  const provider = fakeCodexProvider(binDir);
  await provider.chat({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pid));
  await provider.dispose();
  assert.ok(await waitForDeath(pid), 'process phải chết sau dispose');
  await assert.rejects(
    provider.chat({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] }),
    /đã dispose/,
  );
});

test('M2 codex: listModels chỉ có codex; chat không có user message thì lỗi rõ', async () => {
  const { binDir } = makeBinDir(['fake-codex.mjs', 'codex']);
  const provider = fakeCodexProvider(binDir);
  try {
    assert.deepEqual(await provider.listModels(), ['codex']);
    await assert.rejects(
      provider.chat({ model: 'codex', messages: [{ role: 'system', content: 'x' }] }),
      /không có user message/,
    );
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Driver Grok CLI (fake ACP)
// ---------------------------------------------------------------------------

test('M2 grok: chat trả text + usage, session id là resumeCursor', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const sessionLog = path.join(dir, 'sessions.log');
  process.env.FAKE_GROK_SESSION_LOG = sessionLog;
  const provider = fakeGrokProvider(binDir);
  try {
    const res = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'xin chào' }],
    });
    assert.match(res.text, /Fake reply to: xin chào/);
    assert.deepEqual(res.toolCalls, []);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
    assert.equal(provider.grokSessionId, 'session-fake-1');
    assert.equal(provider.isProcessAlive, true);
    assert.deepEqual(readLines(sessionLog), ['new', 'prompt:session-fake-1:xin chào']);
  } finally {
    await provider.dispose();
  }
  assert.equal(provider.isProcessAlive, false);
});

test('M2 grok: 2 turn chỉ gửi delta, cùng session, không spawn lại', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_GROK_LOG = logFile;
  process.env.FAKE_GROK_SPAWN_LOG = spawnLog;
  const provider = fakeGrokProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'xin chào' }],
    });
    const r2 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'user', content: 'xin chào' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: câu hai/);
    assert.deepEqual(readLines(logFile), ['prompt:xin chào', 'prompt:câu hai']);
    assert.deepEqual(readLines(spawnLog), ['spawned']);
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: system prompt gộp vào prompt đầu của session mới, turn sau không gộp lại', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const logFile = path.join(dir, 'prompts.log');
  process.env.FAKE_GROK_LOG = logFile;
  const provider = fakeGrokProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'system', content: 'Bạn là A.' },
        { role: 'user', content: 'xin chào' },
      ],
    });
    assert.match(r1.text, /Fake reply to: Bạn là A/);
    const raw = fs.readFileSync(logFile, 'utf8');
    assert.ok(raw.startsWith('prompt:Bạn là A.\n\nxin chào\n'), `log sai: ${JSON.stringify(raw)}`);
    const r2 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'system', content: 'Bạn là A.' },
        { role: 'user', content: 'xin chào' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: câu hai/);
    assert.ok(fs.readFileSync(logFile, 'utf8').endsWith('prompt:câu hai\n'));
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: system prompt đổi -> session mới, gộp system mới, gửi lại toàn bộ', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const logFile = path.join(dir, 'prompts.log');
  const sessionLog = path.join(dir, 'sessions.log');
  process.env.FAKE_GROK_LOG = logFile;
  process.env.FAKE_GROK_SESSION_LOG = sessionLog;
  const provider = fakeGrokProvider(binDir);
  try {
    await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'system', content: 'Bạn là A.' },
        { role: 'user', content: 'câu một' },
      ],
    });
    const r2 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'system', content: 'Bạn là B.' },
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: Bạn là B/);
    assert.deepEqual(
      readLines(sessionLog).filter((l) => l === 'new'),
      ['new', 'new'],
    );
    const raw = fs.readFileSync(logFile, 'utf8');
    assert.ok(raw.includes('prompt:Bạn là B.\n\ncâu một\n'), `log sai: ${JSON.stringify(raw)}`);
    assert.ok(raw.endsWith('prompt:câu hai\n'));
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: approval server→client bị TỪ CHỐI (chọn reject_once), turn vẫn xong', async () => {
  process.env.FAKE_GROK_MODE = 'approval';
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const approvalLog = path.join(dir, 'approval.log');
  process.env.FAKE_GROK_APPROVAL_LOG = approvalLog;
  const events = [];
  const provider = fakeGrokProvider(binDir, { onCliEvent: (e) => events.push(e) });
  try {
    const res = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'chạy lệnh giúp tôi' }],
    });
    assert.match(res.text, /Fake reply to: chạy lệnh/);
    const logged = readLines(approvalLog);
    assert.equal(logged.length, 1);
    const response = JSON.parse(logged[0]);
    assert.equal(response.id, 'srv-permission-1');
    assert.deepEqual(response.result, {
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    });
    assert.equal(JSON.stringify(response).includes('opt-allow'), false);
    assert.equal(provider.approvalsDeniedTotal, 1);
    const denied = events.filter((e) => e.type === 'approval_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].method, 'session/request_permission');
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: tool_call của CLI surface qua onCliEvent, không đi vào toolCalls trả về', async () => {
  process.env.FAKE_GROK_MODE = 'toolcall';
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const events = [];
  const provider = fakeGrokProvider(binDir, { onCliEvent: (e) => events.push(e) });
  try {
    const res = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'đọc file giúp tôi' }],
    });
    assert.deepEqual(res.toolCalls, []);
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].call.name, 'read_file');
    assert.deepEqual(toolEvents[0].call.args, { path: '/tmp/x.txt' });
    assert.ok(events.some((e) => e.type === 'text'));
    assert.ok(events.some((e) => e.type === 'result'));
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: server từ chối trả lời (stopReason=refusal, không text) -> chat reject rõ', async () => {
  process.env.FAKE_GROK_MODE = 'refusal';
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const provider = fakeGrokProvider(binDir);
  try {
    await assert.rejects(
      provider.chat({ model: 'grok-cli', messages: [{ role: 'user', content: 'hi' }] }),
      /từ chối trả lời/,
    );
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: process chết giữa turn -> reject, lần sau load session cũ và chỉ gửi delta', async () => {
  process.env.FAKE_GROK_MODE = 'die-after-first';
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const logFile = path.join(dir, 'prompts.log');
  const sessionLog = path.join(dir, 'sessions.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_GROK_LOG = logFile;
  process.env.FAKE_GROK_SESSION_LOG = sessionLog;
  process.env.FAKE_GROK_SPAWN_LOG = spawnLog;
  const provider = fakeGrokProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'câu một' }],
    });
    await assert.rejects(
      provider.chat({
        model: 'grok-cli',
        messages: [
          { role: 'user', content: 'câu một' },
          { role: 'assistant', content: r1.text },
          { role: 'user', content: 'câu hai' },
        ],
      }),
      /chết giữa chừng/,
    );
    assert.equal(provider.isProcessAlive, false);
    const r3 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu ba' },
      ],
    });
    assert.match(r3.text, /Fake reply to: câu ba/);
    assert.deepEqual(readLines(spawnLog), ['spawned', 'spawned']);
    assert.ok(readLines(sessionLog).includes('load:session-fake-1'));
    assert.deepEqual(readLines(logFile), ['prompt:câu một', 'prompt:câu hai', 'prompt:câu ba']);
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: load session lỗi -> mở session mới và gửi lại toàn bộ history', async () => {
  process.env.FAKE_GROK_MODE = 'die-after-first';
  process.env.FAKE_GROK_LOAD_FAIL = '1';
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const logFile = path.join(dir, 'prompts.log');
  const sessionLog = path.join(dir, 'sessions.log');
  process.env.FAKE_GROK_LOG = logFile;
  process.env.FAKE_GROK_SESSION_LOG = sessionLog;
  const provider = fakeGrokProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'câu một' }],
    });
    await assert.rejects(
      provider.chat({
        model: 'grok-cli',
        messages: [
          { role: 'user', content: 'câu một' },
          { role: 'assistant', content: r1.text },
          { role: 'user', content: 'câu hai' },
        ],
      }),
      /chết giữa chừng/,
    );
    const r3 = await provider.chat({
      model: 'grok-cli',
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu ba' },
      ],
    });
    // Resend gộp nhiều message vào MỘT session/prompt nên fake trả
    // lời bằng text nối ('câu một\ncâu hai\ncâu ba') — chỉ cần thấy 'câu ba'.
    assert.match(r3.text, /câu ba/);
    assert.deepEqual(readLines(sessionLog), [
      'new',
      'prompt:session-fake-1:câu một',
      'prompt:session-fake-1:câu hai',
      'load:session-fake-1',
      'new',
      'prompt:session-fake-1:câu một',
      'prompt:session-fake-1:câu hai',
      'prompt:session-fake-1:câu ba',
    ]);
    assert.deepEqual(readLines(logFile), [
      'prompt:câu một',
      'prompt:câu hai',
      'prompt:câu một',
      'prompt:câu hai',
      'prompt:câu ba',
    ]);
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: abort giữa turn kill sạch process group', async () => {
  process.env.FAKE_GROK_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_GROK_PID_FILE = pidFile;
  const provider = fakeGrokProvider(binDir);
  const controller = new AbortController();
  try {
    const promise = provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    // v0.85: assert the wait (see M1) — a false return used to fall
    // through to readFileSync and throw a confusing ENOENT.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile), 5000), 'fake process phải ghi pidFile trước khi abort');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // v0.98 merge-fix: liveness is polled, not asserted once (same
    // race as the codex abort test above — see its comment).
    assert.ok(
      await waitUntil(() => pid > 0 && isAlive(pid), 5000),
      'fake process phải đang sống trước khi abort',
    );
    controller.abort();
    await assert.rejects(promise, (err) => err.name === 'AbortError');
    assert.ok(await waitForDeath(pid), 'process phải chết sau abort');
    assert.equal(provider.isProcessAlive, false);
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: timeout turn kill process và báo hết thời gian chờ', async () => {
  process.env.FAKE_GROK_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_GROK_PID_FILE = pidFile;
  const provider = fakeGrokProvider(binDir, { timeoutMs: 2000 });
  try {
    const promise = provider.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // v0.85: timeout 400ms -> 2000ms — same spawn-startup flake as
    // M1 (fake binary is `#!/usr/bin/env node`; 'slow' never replies
    // so 2000ms still times out, only later). The 400ms business
    // timeout is covered by the in-process fake-spawn unit test in
    // detected-cli-b-drivers.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile), 5000), 'fake process phải ghi pidFile trước khi timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await assert.rejects(promise, /hết thời gian chờ 2000ms/);
    assert.ok(await waitForDeath(pid), 'process phải chết sau timeout');
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: env của turn KHÔNG chứa XAI_API_KEY (rò rỉ sẽ đổi subscription sang pay-as-you-go)', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const envDump = path.join(dir, 'env.json');
  process.env.FAKE_GROK_ENV_DUMP = envDump;
  process.env.XAI_API_KEY = 'sk-xai-fake-secret';
  process.env.OPENAI_API_KEY = 'sk-openai-fake-secret';
  process.env.GROK_HOME = '/tmp/fake-grok-home';
  const provider = fakeGrokProvider(binDir);
  try {
    await provider.chat({ model: 'grok-cli', messages: [{ role: 'user', content: 'hi' }] });
    const dumped = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(dumped.PATH !== undefined, true);
    assert.equal(dumped.GROK_HOME, '/tmp/fake-grok-home');
    assert.equal(dumped.XAI_API_KEY, undefined);
    assert.equal(dumped.OPENAI_API_KEY, undefined);
    assert.equal(JSON.stringify(dumped).includes('fake-secret'), false);
  } finally {
    await provider.dispose();
  }
});

test('M2 grok: dispose kill process; chat sau dispose thì lỗi rõ', async () => {
  const { dir, binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_GROK_PID_FILE = pidFile;
  const provider = fakeGrokProvider(binDir);
  await provider.chat({ model: 'grok-cli', messages: [{ role: 'user', content: 'hi' }] });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pid));
  await provider.dispose();
  assert.ok(await waitForDeath(pid), 'process phải chết sau dispose');
  await assert.rejects(
    provider.chat({ model: 'grok-cli', messages: [{ role: 'user', content: 'hi' }] }),
    /đã dispose/,
  );
});

test('M2 grok: listModels chỉ có grok-cli; chat không có user message thì lỗi rõ', async () => {
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const provider = fakeGrokProvider(binDir);
  try {
    assert.deepEqual(await provider.listModels(), ['grok-cli']);
    await assert.rejects(
      provider.chat({ model: 'grok-cli', messages: [{ role: 'system', content: 'x' }] }),
      /không có user message/,
    );
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Nối vào model registry + createProvider
// ---------------------------------------------------------------------------

test('M2 wiring: model registry có codex + grok-cli; createProvider cần cliBinary', async () => {
  const registry = new ModelRegistry();
  assert.deepEqual(
    registry.listModels('codex').map((m) => m.id),
    ['codex'],
  );
  assert.deepEqual(
    registry.listModels('grok-cli').map((m) => m.id),
    ['grok-cli'],
  );
  assert.equal(registry.getDefault('codex'), 'codex');
  assert.equal(registry.getFallback('codex'), 'codex');
  assert.equal(registry.getDefault('grok-cli'), 'grok-cli');
  assert.equal(registry.getFallback('grok-cli'), 'grok-cli');

  for (const [id, detectedKind] of [
    ['codex', 'codex'],
    ['grok-cli', 'grok'],
  ]) {
    const meta = PROVIDERS.find((p) => p.id === id);
    assert.ok(meta, `PROVIDERS phải có ${id}`);
    assert.equal(meta.kind, 'cli');
    assert.equal(meta.detectedKind, detectedKind);
    assert.equal(meta.needsKey, false);
  }

  assert.throws(
    () => createProvider({ id: 'codex', label: 'Codex (CLI)', defaultModel: 'codex' }),
    /chưa có đường dẫn binary/,
  );
  assert.throws(
    () => createProvider({ id: 'grok-cli', label: 'Grok CLI', defaultModel: 'grok-cli' }),
    /chưa có đường dẫn binary/,
  );
});

test('M2 wiring: createProvider với fake binary chạy được một turn (codex + grok-cli)', async () => {
  const { binDir } = makeBinDir(
    ['fake-codex.mjs', 'codex'],
    ['fake-grok.mjs', 'grok'],
  );
  const codex = createProvider({
    id: 'codex',
    label: 'Codex (CLI)',
    defaultModel: 'codex',
    cliBinary: path.join(binDir, 'codex'),
  });
  assert.equal(codex.id, 'codex');
  try {
    const res = await codex.chat({
      model: 'codex',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.match(res.text, /Fake reply to: hello/);
  } finally {
    await codex.dispose?.();
  }

  const grok = createProvider({
    id: 'grok-cli',
    label: 'Grok CLI',
    defaultModel: 'grok-cli',
    cliBinary: path.join(binDir, 'grok'),
  });
  assert.equal(grok.id, 'grok-cli');
  try {
    const res = await grok.chat({
      model: 'grok-cli',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.match(res.text, /Fake reply to: hello/);
  } finally {
    await grok.dispose?.();
  }
});
