/**
 * Tests cho M3 — Tầng ACP chung + driver OpenCode / Gemini CLI /
 * Cursor CLI / Custom ACP CLI (packages/core/src/providers/cli/:
 * acp.ts, acpProvider.ts, opencode.ts, geminiCli.ts, cursorCli.ts,
 * customAcp.ts, grok.ts mỏng hoá; packages/core/src/detected/:
 * custom.ts + registry custom CLI).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/detected-cli-m3.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: mọi CLI
 * trong test đều là fake script trong tests/fixtures/
 * (fake-acp-generic.mjs đóng vai opencode/gemini/cursor-agent/custom,
 * fake-grok.mjs cho hồi quy Grok) được copy vào thư mục tạm và tìm
 * qua `pathDirs`; home giả cũng là thư mục tạm.
 *
 * Mức kiểm chứng (ghi rõ — xem providers/cli/README.md):
 * - Tầng ACP chung + 4 driver mới: CHƯA chạy lần nào trên CLI thật
 *   (máy này không có opencode/gemini/cursor-agent/grok) — lệnh
 *   spawn ACP + handshake + session/prompt đều từ docs công khai
 *   (opencode.ai/docs/cli/acp, geminicli.com/docs/cli/acp-mode,
 *   cursor.com/docs/cli/acp) + ACP chuẩn.
 * - Cursor `authenticate` (`cursor_login`) và Gemini fallback cờ
 *   `--experimental-acp`: suy ra từ docs, chưa thấy CLI thật gửi.
 * - Re-detect → picker: chỉ kiểm chứng ở tầng core (registry snapshot
 *   + helper visibility); đường UI thật (BotForm subscribe event
 *   `engines:changed`) chưa chạy Electron thật để bấm.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AcpClient,
  BaseAcpCliProvider,
  CursorCliProvider,
  CustomAcpCliProvider,
  DetectedEngineRegistry,
  GeminiCliProvider,
  GrokCliProvider,
  ModelRegistry,
  OpenCodeCliProvider,
  createProvider,
  customAcpKind,
  isCustomAcpKind,
  isEngineUsable,
  isEngineUsableAllowingUnknown,
  usableCustomEngineBinary,
  validateCustomAcpCliConfig,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-m3-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_ACP_') || key.startsWith('FAKE_GROK_')) delete process.env[key];
  }
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CURSOR_API_KEY;
  delete process.env.GEMINI_CLI_HOME;
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

async function waitUntil(fn, timeoutMs = 3000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

/** Biến env fake ACP được phép chui qua sanitizeEnvForCli (như M2 làm với FAKE_GROK_*). */
const ACP_FAKE_ENV = [
  'FAKE_ACP_MODE',
  'FAKE_ACP_LOG',
  'FAKE_ACP_SESSION_LOG',
  'FAKE_ACP_APPROVAL_LOG',
  'FAKE_ACP_SERVER_REQUEST_LOG',
  'FAKE_ACP_AUTHENTICATE_LOG',
  'FAKE_ACP_SPAWN_LOG',
  'FAKE_ACP_PID_FILE',
  'FAKE_ACP_ENV_DUMP',
  'FAKE_ACP_LOAD_FAIL',
  'FAKE_ACP_REJECT_ACP_FLAG',
];

function chatReq(text, system) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: text });
  return { messages, model: 'test-model' };
}

function opencodeProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new OpenCodeCliProvider(
    { id: 'opencode', label: 'OpenCode', defaultModel: 'opencode' },
    {
      binaryPath: path.join(binDir, 'opencode'),
      cwd: dir,
      extraEnvAllowed: ACP_FAKE_ENV,
      timeoutMs: 10_000,
      ...opts,
    },
  );
}

function geminiProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new GeminiCliProvider(
    { id: 'gemini-cli', label: 'Gemini CLI', defaultModel: 'gemini-cli' },
    {
      binaryPath: path.join(binDir, 'gemini'),
      cwd: dir,
      extraEnvAllowed: [...ACP_FAKE_ENV, 'GEMINI_CLI_HOME'],
      timeoutMs: 10_000,
      ...opts,
    },
  );
}

function cursorProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new CursorCliProvider(
    { id: 'cursor-cli', label: 'Cursor CLI', defaultModel: 'cursor-cli' },
    {
      binaryPath: path.join(binDir, 'cursor-agent'),
      cwd: dir,
      extraEnvAllowed: ACP_FAKE_ENV,
      timeoutMs: 10_000,
      ...opts,
    },
  );
}

function customProvider(binPath, acpArgs, slug, opts = {}) {
  const dir = makeTempDir();
  return new CustomAcpCliProvider(
    { id: 'custom-acp', label: 'Custom', defaultModel: slug },
    {
      binaryPath: binPath,
      acpArgs,
      cwd: dir,
      extraEnvAllowed: ACP_FAKE_ENV,
      timeoutMs: 10_000,
      ...opts,
    },
  );
}

// ---------------------------------------------------------------------------
// Detector M1 đã đủ cho 3 CLI mới (chỉ kiểm chứng lại bằng fake)
// ---------------------------------------------------------------------------

test('M3 detector: fake opencode available kèm version + nhãn provider từ `auth list`', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const engine = snap.engines['opencode'];
  assert.equal(engine.status, 'available');
  assert.equal(engine.version, '1.2.3');
  assert.equal(engine.binaryPath, path.join(binDir, 'opencode'));
  assert.equal(engine.account?.label, 'Anthropic, OpenAI');
  assert.equal(engine.account?.method, 'oauth');
  assert.equal(engine.enabled, false);
});

test('M3 detector: opencode chưa cài -> not-installed', async () => {
  const { binDir } = makeBinDir();
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['opencode'].status, 'unavailable');
  assert.equal(snap.engines['opencode'].reason, 'not-installed');
});

test('M3 detector: fake cursor-agent available kèm version + email từ `status --format json`', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'cursor-agent']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const engine = snap.engines['cursor'];
  assert.equal(engine.status, 'available');
  assert.equal(engine.version, '2026.1.0');
  assert.equal(engine.binaryPath, path.join(binDir, 'cursor-agent'));
  assert.equal(engine.account?.label, 'cursor-user@example.com');
  assert.equal(engine.account?.method, 'subscription');
});

test('M3 detector: fake gemini available, nhãn email chỉ từ google_accounts.json (không đọc oauth_creds.json)', async () => {
  const homeDir = makeTempDir();
  fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.gemini', 'google_accounts.json'),
    JSON.stringify({ activeAccount: 'gemini-user@example.com' }),
    'utf8',
  );
  // File token tồn tại nhưng detector KHÔNG được đọc nội dung của nó.
  fs.writeFileSync(
    path.join(homeDir, '.gemini', 'oauth_creds.json'),
    '{"access_token":"secret-never-read"}',
    'utf8',
  );
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  const registry = registryFor(binDir, { homeDir });
  const snap = await registry.detect();
  const engine = snap.engines['gemini'];
  assert.equal(engine.status, 'available');
  assert.equal(engine.version, '0.45.0');
  assert.equal(engine.account?.label, 'gemini-user@example.com');
  assert.equal(JSON.stringify(snap).includes('secret-never-read'), false);
});

test('M3 detector: gemini chưa có file nhãn/token -> not-signed-in', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['gemini'].status, 'unavailable');
  assert.equal(snap.engines['gemini'].reason, 'not-signed-in');
});

// ---------------------------------------------------------------------------
// Tầng ACP chung (AcpClient trực tiếp trên fake child process)
// ---------------------------------------------------------------------------

test('M3 acp chung: handshake trả protocolVersion + agentInfo, prompt streaming + usage', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const child = spawn(path.join(binDir, 'mycli'), ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const events = [];
    const client = new AcpClient(child, { onCliEvent: (e) => events.push(e) });
    await client.initialize();
    assert.equal(client.isInitialized, true);
    assert.equal(client.negotiatedProtocolVersion, 1);
    assert.equal(client.serverAgentInfo?.name, 'fake-acp-generic');
    const sessionId = await client.newSession({});
    assert.equal(sessionId, 'session-fake-acp-1');
    const result = await client.prompt(sessionId, ['hello acp']);
    assert.match(result.text, /Fake reply to: hello acp/);
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 6 });
    assert.equal(result.approvalsDenied, 0);
    assert.ok(events.some((e) => e.type === 'text' && e.delta.includes('Fake reply')));
    assert.ok(events.some((e) => e.type === 'result'));
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã chết.
    }
  }
});

test('M3 acp chung: session/request_permission -> chọn reject_once, đếm approvalsDenied', async () => {
  const dir = makeTempDir();
  const approvalLog = path.join(dir, 'approval.log');
  process.env.FAKE_ACP_MODE = 'approval';
  process.env.FAKE_ACP_APPROVAL_LOG = approvalLog;
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const child = spawn(path.join(binDir, 'mycli'), ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  try {
    const events = [];
    const client = new AcpClient(child, { onCliEvent: (e) => events.push(e) });
    await client.initialize();
    const sessionId = await client.newSession({});
    const result = await client.prompt(sessionId, ['do a risky thing']);
    assert.match(result.text, /Fake reply/);
    assert.equal(result.approvalsDenied, 1);
    assert.equal(client.approvalsDeniedTotal, 1);
    assert.ok(events.some((e) => e.type === 'approval_denied'));
    const lines = readLines(approvalLog);
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.result.outcome.outcome, 'selected');
    assert.equal(response.result.outcome.optionId, 'opt-reject');
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã chết.
    }
  }
});

test('M3 acp chung: request fs từ server -> trả lỗi JSON-RPC -32601', async () => {
  const dir = makeTempDir();
  const serverRequestLog = path.join(dir, 'srv-req.log');
  process.env.FAKE_ACP_MODE = 'fsrequest';
  process.env.FAKE_ACP_SERVER_REQUEST_LOG = serverRequestLog;
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const child = spawn(path.join(binDir, 'mycli'), ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  try {
    const client = new AcpClient(child, {});
    await client.initialize();
    const sessionId = await client.newSession({});
    const result = await client.prompt(sessionId, ['read a file']);
    assert.match(result.text, /Fake reply/);
    const lines = readLines(serverRequestLog);
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.error.code, -32601);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã chết.
    }
  }
});

test('M3 acp chung: authenticate gửi methodId, loadSession lỗi thì throw cho caller fallback', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const dir = makeTempDir();
  const authLog = path.join(dir, 'auth.log');
  process.env.FAKE_ACP_AUTHENTICATE_LOG = authLog;
  process.env.FAKE_ACP_LOAD_FAIL = '1';
  const child = spawn(path.join(binDir, 'mycli'), ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  try {
    const client = new AcpClient(child, {});
    await client.initialize();
    await client.authenticate('cursor_login');
    assert.deepEqual(readLines(authLog), ['authenticate:cursor_login']);
    await assert.rejects(() => client.loadSession('session-fake-acp-1', {}), /no session found/);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã chết.
    }
  }
});

// ---------------------------------------------------------------------------
// Driver OpenCode
// ---------------------------------------------------------------------------

test('M3 opencode: 1 turn text + usage, spawn đúng `opencode acp`', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  const provider = opencodeProvider(binDir);
  try {
    const res = await provider.chat(chatReq('xin chào', 'Bạn là trợ lý.'));
    // Fake trả lại đúng text đã nhận (đã gộp system prompt vào đầu).
    assert.match(res.text, /Bạn là trợ lý\./);
    assert.match(res.text, /xin chào/);
    assert.deepEqual(res.toolCalls, []);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
    assert.equal(provider.opencodeSessionId, 'session-fake-acp-1');
    assert.deepEqual(readLines(spawnLog), ['spawned:acp']);
  } finally {
    await provider.dispose();
  }
});

test('M3 opencode: system prompt gộp vào message đầu session, 2 turn chỉ gửi delta', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const logFile = path.join(dir, 'prompts.log');
  process.env.FAKE_ACP_LOG = logFile;
  const provider = opencodeProvider(binDir);
  try {
    await provider.chat(chatReq('câu một', 'Hệ thống A.'));
    await provider.chat({
      messages: [
        { role: 'system', content: 'Hệ thống A.' },
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
      ],
      model: 'test-model',
    });
    // Log ghi mỗi prompt block trên một dòng 'prompt:' — nhưng text
    // đã gộp system prompt chứa '\n' nên đọc raw thay vì đếm dòng.
    const raw = fs.readFileSync(logFile, 'utf8');
    assert.equal((raw.match(/^prompt:/gm) ?? []).length, 2);
    assert.ok(raw.includes('prompt:Hệ thống A.\n\ncâu một'));
    assert.ok(raw.includes('prompt:câu hai'));
    assert.equal(provider.isProcessAlive, true);
  } finally {
    await provider.dispose();
  }
});

test('M3 opencode: system đổi -> session mới trên cùng process + gửi lại toàn bộ', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const sessionLog = path.join(dir, 'sessions.log');
  const logFile = path.join(dir, 'prompts.log');
  process.env.FAKE_ACP_SESSION_LOG = sessionLog;
  process.env.FAKE_ACP_LOG = logFile;
  const provider = opencodeProvider(binDir);
  try {
    await provider.chat(chatReq('câu một', 'Hệ thống A.'));
    await provider.chat(chatReq('câu một', 'Hệ thống B.'));
    const sessions = readLines(sessionLog).filter((l) => l === 'new');
    assert.equal(sessions.length, 2);
    // Text đã gộp system prompt chứa '\n' nên đọc raw thay vì đếm dòng.
    const raw = fs.readFileSync(logFile, 'utf8');
    assert.equal((raw.match(/^prompt:/gm) ?? []).length, 2);
    assert.ok(raw.includes('prompt:Hệ thống B.\n\ncâu một'));
  } finally {
    await provider.dispose();
  }
});

test('M3 opencode: process chết giữa turn -> resume bằng session id trên process mới', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const sessionLog = path.join(dir, 'sessions.log');
  process.env.FAKE_ACP_MODE = 'die-after-first';
  process.env.FAKE_ACP_SESSION_LOG = sessionLog;
  const provider = opencodeProvider(binDir);
  try {
    const first = await provider.chat(chatReq('câu một'));
    assert.match(first.text, /Fake reply/);
    await assert.rejects(() => provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
      ],
      model: 'test-model',
    }), /chết giữa chừng/);
    const third = await provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
        { role: 'user', content: 'câu ba' },
      ],
      model: 'test-model',
    });
    assert.match(third.text, /Fake reply to: câu ba/);
    assert.ok(readLines(sessionLog).some((l) => l.startsWith('load:session-fake-acp-1')));
  } finally {
    await provider.dispose();
  }
});

test('M3 opencode: load lỗi -> mở session mới + gửi lại toàn bộ history', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const sessionLog = path.join(dir, 'sessions.log');
  const logFile = path.join(dir, 'prompts.log');
  process.env.FAKE_ACP_MODE = 'die-after-first';
  process.env.FAKE_ACP_LOAD_FAIL = '1';
  process.env.FAKE_ACP_SESSION_LOG = sessionLog;
  process.env.FAKE_ACP_LOG = logFile;
  const provider = opencodeProvider(binDir);
  try {
    await provider.chat(chatReq('câu một'));
    await assert.rejects(() => provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
      ],
      model: 'test-model',
    }), /chết giữa chừng/);
    const third = await provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
        { role: 'user', content: 'câu ba' },
      ],
      model: 'test-model',
    });
    assert.match(third.text, /Fake reply/);
    assert.equal(readLines(sessionLog).filter((l) => l === 'new').length, 2);
    assert.ok(readLines(logFile).filter((l) => l === 'prompt:câu một').length >= 2);
  } finally {
    await provider.dispose();
  }
});

test('M3 opencode: approval bị từ chối fail-closed, tool_call chỉ surface qua event', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const events = [];
  const provider = opencodeProvider(binDir, { onCliEvent: (e) => events.push(e) });
  process.env.FAKE_ACP_MODE = 'approval';
  try {
    const res = await provider.chat(chatReq('xoá hết file'));
    assert.match(res.text, /Fake reply/);
    assert.equal(provider.approvalsDeniedTotal, 1);
    assert.ok(events.some((e) => e.type === 'approval_denied'));
  } finally {
    await provider.dispose();
  }
  const provider2 = opencodeProvider(binDir, { onCliEvent: (e) => events.push(e) });
  process.env.FAKE_ACP_MODE = 'toolcall';
  try {
    const res = await provider2.chat(chatReq('đọc file'));
    assert.match(res.text, /Fake reply/);
    assert.deepEqual(res.toolCalls, []);
    assert.ok(events.some((e) => e.type === 'tool_call' && e.call.name === 'read_file'));
  } finally {
    await provider2.dispose();
  }
});

test('M3 opencode: env sạch — key lạ không lọt vào process con', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'env.json');
  process.env.XAI_API_KEY = 'xai-secret';
  process.env.OPENAI_API_KEY = 'openai-secret';
  process.env.FAKE_ACP_ENV_DUMP = envDump;
  const provider = opencodeProvider(binDir);
  try {
    await provider.chat(chatReq('hello'));
    const dumped = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(dumped.XAI_API_KEY, undefined);
    assert.equal(dumped.OPENAI_API_KEY, undefined);
    assert.ok(typeof dumped.PATH === 'string');
    assert.ok(typeof dumped.HOME === 'string');
  } finally {
    await provider.dispose();
  }
});

/**
 * FLAKY — v0.50: fail 1 lần khi chạy full suite, chạy lẻ pass 3/3.
 * Nguyên nhân: dưới tải full suite (nhiều file test chạy song song
 * trên CPU chia sẻ) SIGTERM tới process group + thu hồi process con
 * có thể chậm hơn 5s bình thường. Sửa v0.51: cửa sổ chờ 15s; vẫn còn
 * sống thì ép SIGKILL vào cả group rồi đợi thêm 5s trước khi kết
 * luận fail. Lưu ý `isAlive()` dùng kill(pid, 0) nên process zombie
 * chưa thu hồi vẫn tính là sống — chờ dài là để thu hồi kịp, không
 * phải chỉ để kill kịp.
 */
test('M3 opencode: abort giữa turn kill sạch process group (pid chết thật)', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const dir = makeTempDir();
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_ACP_MODE = 'slow';
  process.env.FAKE_ACP_PID_FILE = pidFile;
  const provider = opencodeProvider(binDir, { timeoutMs: 30_000 });
  const controller = new AbortController();
  try {
    const promise = provider.chat({ messages: [{ role: 'user', content: 'chậm' }], model: 'x', signal: controller.signal });
    assert.equal(await waitUntil(() => fs.existsSync(pidFile), 5000), true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(isAlive(pid));
    controller.abort();
    await assert.rejects(promise, (err) => err.name === 'AbortError');
    let died = await waitUntil(() => !isAlive(pid), 15_000);
    if (!died && process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Đã chết giữa chừng — vòng đợi dưới đây sẽ xác nhận.
      }
      died = await waitUntil(() => !isAlive(pid), 5000);
    }
    assert.equal(died, true);
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Driver Gemini CLI (kể cả fallback cờ --experimental-acp)
// ---------------------------------------------------------------------------

test('M3 gemini-cli: 1 turn text + usage, spawn đúng `gemini --acp`', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  const provider = geminiProvider(binDir);
  try {
    const res = await provider.chat(chatReq('xin chào'));
    assert.match(res.text, /Fake reply to: xin chào/);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
    assert.deepEqual(readLines(spawnLog), ['spawned:--acp']);
  } finally {
    await provider.dispose();
  }
});

test('M3 gemini-cli: --acp bị từ chối thì thử lại --experimental-acp rồi mới chạy', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_ACP_REJECT_ACP_FLAG = '1';
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  const provider = geminiProvider(binDir);
  try {
    const res = await provider.chat(chatReq('xin chào bản cũ'));
    assert.match(res.text, /Fake reply to: xin chào bản cũ/);
    assert.deepEqual(readLines(spawnLog), ['spawned:--acp', 'spawned:--experimental-acp']);
  } finally {
    await provider.dispose();
  }
});

test('M3 gemini-cli: env có GEMINI_CLI_HOME, GEMINI_API_KEY không lọt vào process con', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'env.json');
  process.env.GEMINI_CLI_HOME = path.join(dir, '.gemini');
  process.env.GEMINI_API_KEY = 'gemini-secret';
  process.env.FAKE_ACP_ENV_DUMP = envDump;
  const provider = geminiProvider(binDir);
  try {
    await provider.chat(chatReq('hello'));
    const dumped = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(dumped.GEMINI_CLI_HOME, path.join(dir, '.gemini'));
    assert.equal(dumped.GEMINI_API_KEY, undefined);
  } finally {
    await provider.dispose();
  }
});

test('M3 gemini-cli: refusal không text -> lỗi rõ, không trả text rỗng', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'gemini']);
  process.env.FAKE_ACP_MODE = 'refusal';
  const provider = geminiProvider(binDir);
  try {
    await assert.rejects(() => provider.chat(chatReq('hello')), /từ chối trả lời/);
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Driver Cursor CLI (kể cả bước authenticate cursor_login)
// ---------------------------------------------------------------------------

test('M3 cursor-cli: 1 turn text + gọi authenticate cursor_login sau initialize', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'cursor-agent']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  const authLog = path.join(dir, 'auth.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  process.env.FAKE_ACP_AUTHENTICATE_LOG = authLog;
  const provider = cursorProvider(binDir);
  try {
    const res = await provider.chat(chatReq('xin chào'));
    assert.match(res.text, /Fake reply to: xin chào/);
    assert.deepEqual(readLines(spawnLog), ['spawned:acp']);
    assert.deepEqual(readLines(authLog), ['authenticate:cursor_login']);
    assert.equal(provider.cursorCliSessionId, 'session-fake-acp-1');
  } finally {
    await provider.dispose();
  }
});

test('M3 cursor-cli: 2 turn delta + resume sau khi process chết', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'cursor-agent']);
  const dir = makeTempDir();
  const logFile = path.join(dir, 'prompts.log');
  process.env.FAKE_ACP_MODE = 'die-after-first';
  process.env.FAKE_ACP_LOG = logFile;
  const provider = cursorProvider(binDir);
  try {
    await provider.chat(chatReq('câu một'));
    await assert.rejects(() => provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
      ],
      model: 'test-model',
    }), /chết giữa chừng/);
    const third = await provider.chat({
      messages: [
        { role: 'user', content: 'câu một' },
        { role: 'user', content: 'câu hai' },
        { role: 'user', content: 'câu ba' },
      ],
      model: 'test-model',
    });
    assert.match(third.text, /Fake reply to: câu ba/);
    assert.deepEqual(readLines(logFile), ['prompt:câu một', 'prompt:câu hai', 'prompt:câu ba']);
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Hồi quy: Grok CLI mỏng hoá trên tầng chung (hành vi M2 không đổi)
// ---------------------------------------------------------------------------

test('M3 grok (mỏng hoá): 1 turn text + usage + grokSessionId, spawn đúng cờ M2', async () => {
  const { binDir } = makeBinDir(['fake-grok.mjs', 'grok']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_GROK_SPAWN_LOG = spawnLog;
  const provider = new GrokCliProvider(
    { id: 'grok-cli', label: 'Grok CLI', defaultModel: 'grok-cli' },
    {
      binaryPath: path.join(binDir, 'grok'),
      cwd: dir,
      extraEnvAllowed: [
        'GROK_HOME',
        'FAKE_GROK_MODE',
        'FAKE_GROK_LOG',
        'FAKE_GROK_SESSION_LOG',
        'FAKE_GROK_APPROVAL_LOG',
        'FAKE_GROK_SPAWN_LOG',
        'FAKE_GROK_PID_FILE',
        'FAKE_GROK_ENV_DUMP',
        'FAKE_GROK_LOAD_FAIL',
      ],
      timeoutMs: 10_000,
    },
  );
  try {
    const res = await provider.chat(chatReq('xin chào'));
    assert.match(res.text, /Fake reply to: xin chào/);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
    assert.equal(provider.grokSessionId, 'session-fake-1');
    assert.equal(provider.isProcessAlive, true);
  } finally {
    await provider.dispose();
  }
  assert.equal(provider.isProcessAlive, false);
});

// ---------------------------------------------------------------------------
// Custom ACP CLI: validate + registry CRUD + provider
// ---------------------------------------------------------------------------

test('M3 custom validate: slug sai, binary tương đối, acpArgs rỗng, cờ key đều bị từ chối', () => {
  assert.throws(() => validateCustomAcpCliConfig({ id: 'My Agent', label: 'X', binaryPath: '/bin/x', acpArgs: ['acp'] }), /"id"/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'a'.repeat(33), label: 'X', binaryPath: '/bin/x', acpArgs: ['acp'] }), /"id"/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'ok', label: 'X', binaryPath: 'relative/x', acpArgs: ['acp'] }), /binaryPath/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'ok', label: 'X', binaryPath: '/bin/x', acpArgs: [] }), /acpArgs/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'ok', label: 'X', binaryPath: '/bin/x', acpArgs: ['--api-key', 'secret'] }), /API key/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'ok', label: 'X', binaryPath: '/bin/x', acpArgs: ['--token=secret'] }), /API key/);
  assert.throws(() => validateCustomAcpCliConfig({ id: 'ok', label: '', binaryPath: '/bin/x', acpArgs: ['acp'] }), /label/);
  const ok = validateCustomAcpCliConfig({ id: 'my-agent', label: ' My Agent ', binaryPath: '/bin/x', acpArgs: ['acp'], statusArgs: ['status'] });
  assert.deepEqual(ok, { id: 'my-agent', label: 'My Agent', binaryPath: '/bin/x', acpArgs: ['acp'], statusArgs: ['status'] });
  assert.equal(customAcpKind('my-agent'), 'custom-acp:my-agent');
  assert.equal(isCustomAcpKind('custom-acp:my-agent'), true);
  assert.equal(isCustomAcpKind('opencode'), false);
});

test('M3 custom registry: thêm CLI không có lệnh status -> status unknown (không bịa đã đăng nhập)', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'detected-engines.json');
  const registry = registryFor(binDir, { stateFilePath: stateFile });
  const cfg = registry.addCustomCli({
    id: 'my-agent',
    label: 'My Agent',
    binaryPath: path.join(binDir, 'mycli'),
    acpArgs: ['acp'],
  });
  assert.equal(cfg.id, 'my-agent');
  assert.equal(registry.isEnabled('custom-acp:my-agent'), false);
  const snap = await registry.detect({ force: true });
  const engine = snap.engines['custom-acp:my-agent'];
  assert.equal(engine.status, 'unknown');
  assert.equal(engine.version, '1.0.0');
  assert.equal(engine.binaryPath, path.join(binDir, 'mycli'));
  assert.match(engine.reasonDetail ?? '', /không khai lệnh kiểm tra đăng nhập/);
  // Helper nghiêm ngặt (chỉ 'available') từ chối; helper custom chấp nhận 'unknown' khi đã bật.
  assert.equal(isEngineUsable(snap, 'custom-acp:my-agent'), false);
  registry.setEnabled('custom-acp:my-agent', true);
  const snap2 = await registry.detect({ force: true });
  assert.equal(isEngineUsableAllowingUnknown(snap2, 'custom-acp:my-agent'), true);
  assert.equal(usableCustomEngineBinary(snap2, 'custom-acp:my-agent'), path.join(binDir, 'mycli'));
  // State file chỉ chứa đường dẫn + argv, ghi atomic.
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.enabled['custom-acp:my-agent'], true);
  assert.deepEqual(saved.customClis, [{ id: 'my-agent', label: 'My Agent', binaryPath: path.join(binDir, 'mycli'), acpArgs: ['acp'] }]);
});

test('M3 custom registry: có lệnh status exit 0 -> available; sửa + xoá + bền vững qua registry mới', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'detected-engines.json');
  const registry = registryFor(binDir, { stateFilePath: stateFile });
  registry.addCustomCli({
    id: 'my-agent',
    label: 'My Agent',
    binaryPath: path.join(binDir, 'mycli'),
    acpArgs: ['acp'],
    statusArgs: ['--version'],
  });
  registry.setEnabled('custom-acp:my-agent', true);
  let snap = await registry.detect({ force: true });
  assert.equal(snap.engines['custom-acp:my-agent'].status, 'available');
  // Sửa: đổi label + args.
  const updated = registry.updateCustomCli('my-agent', { label: 'My Agent 2', acpArgs: ['--acp'] });
  assert.equal(updated.label, 'My Agent 2');
  assert.deepEqual(updated.acpArgs, ['--acp']);
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['custom-acp:my-agent'].label, 'My Agent 2');
  assert.equal(snap.engines['custom-acp:my-agent'].status, 'available');
  // Registry mới đọc lại từ cùng state file: cấu hình + opt-in còn nguyên.
  const registry2 = registryFor(binDir, { stateFilePath: stateFile });
  assert.equal(registry2.getCustomCli('my-agent')?.label, 'My Agent 2');
  assert.equal(registry2.isEnabled('custom-acp:my-agent'), true);
  // Xoá: kind biến mất khỏi snapshot, helper trả false.
  registry.removeCustomCli('my-agent');
  assert.equal(registry.getCustomCli('my-agent'), undefined);
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['custom-acp:my-agent'], undefined);
  assert.equal(isEngineUsableAllowingUnknown(snap, 'custom-acp:my-agent'), false);
});

test('M3 custom registry: thêm trùng slug, binary không tồn tại, sửa slug lạ đều throw', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const registry = registryFor(binDir);
  registry.addCustomCli({ id: 'my-agent', label: 'A', binaryPath: path.join(binDir, 'mycli'), acpArgs: ['acp'] });
  assert.throws(
    () => registry.addCustomCli({ id: 'my-agent', label: 'B', binaryPath: path.join(binDir, 'mycli'), acpArgs: ['acp'] }),
    /đã tồn tại/,
  );
  assert.throws(
    () => registry.addCustomCli({ id: 'other', label: 'B', binaryPath: path.join(binDir, 'khong-co'), acpArgs: ['acp'] }),
    /không chạy được binary/,
  );
  assert.throws(() => registry.updateCustomCli('nope', { label: 'X' }), /không tìm thấy/);
  assert.throws(() => registry.updateCustomCli('my-agent', { id: 'khac' }), /không đổi được slug/);
  assert.throws(() => registry.removeCustomCli('nope'), /không tìm thấy/);
  assert.throws(() => registry.setEnabled('custom-acp:nope', true), /Không rõ nguồn/);
});

test('M3 custom provider: chat qua CLI tuỳ chỉnh, model = slug; thiếu binary/args thì createProvider throw', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  // createProvider cần cliBinary + cliArgs (fail-closed).
  assert.throws(() => createProvider({ id: 'custom-acp', label: 'X', defaultModel: 'my-agent' }), /chưa có đường dẫn binary/);
  assert.throws(
    () => createProvider({ id: 'custom-acp', label: 'X', defaultModel: 'my-agent', cliBinary: path.join(binDir, 'mycli') }),
    /acpArgs rỗng/,
  );
  const provider = createProvider({
    id: 'custom-acp',
    label: 'My Agent',
    defaultModel: 'my-agent',
    cliBinary: path.join(binDir, 'mycli'),
    cliArgs: ['acp'],
  });
  assert.equal(provider.id, 'custom-acp');
  assert.deepEqual(await provider.listModels(), ['my-agent']);
  const viaHelper = customProvider(path.join(binDir, 'mycli'), ['acp'], 'my-agent');
  try {
    const res = await viaHelper.chat(chatReq('xin chào custom'));
    assert.match(res.text, /Fake reply to: xin chào custom/);
    assert.equal(viaHelper.customCliId, 'my-agent');
    assert.deepEqual(readLines(spawnLog), ['spawned:acp']);
  } finally {
    await viaHelper.dispose();
  }
  await provider.dispose?.();
});

// ---------------------------------------------------------------------------
// Nối registry: PROVIDERS meta + createProvider + ModelRegistry
// ---------------------------------------------------------------------------

test('M3 registry nối: PROVIDERS meta 4 provider mới (kind cli, needsKey false, detectedKind đúng)', () => {
  const expected = {
    opencode: 'opencode',
    'gemini-cli': 'gemini',
    'cursor-cli': 'cursor',
    'custom-acp': 'custom-acp',
  };
  for (const [id, detectedKind] of Object.entries(expected)) {
    const meta = PROVIDERS.find((p) => p.id === id);
    assert.ok(meta, `thiếu provider ${id}`);
    assert.equal(meta.kind, 'cli');
    assert.equal(meta.needsKey, false);
    assert.equal(meta.detectedKind, detectedKind);
  }
  assert.equal(PROVIDERS.find((p) => p.id === 'opencode')?.defaultModel, 'opencode');
  assert.equal(PROVIDERS.find((p) => p.id === 'custom-acp')?.defaultModel, 'custom-acp');
});

test('M3 createProvider: 3 driver mới cần cliBinary, đủ binary thì listModels đúng', async () => {
  for (const id of ['opencode', 'gemini-cli', 'cursor-cli']) {
    assert.throws(() => createProvider({ id, label: 'X', defaultModel: id }), /chưa có đường dẫn binary/);
  }
  const { binDir } = makeBinDir(
    ['fake-acp-generic.mjs', 'opencode'],
    ['fake-acp-generic.mjs', 'gemini'],
    ['fake-acp-generic.mjs', 'cursor-agent'],
  );
  const opencode = createProvider({ id: 'opencode', label: 'X', defaultModel: 'opencode', cliBinary: path.join(binDir, 'opencode') });
  assert.deepEqual(await opencode.listModels(), ['opencode']);
  const gemini = createProvider({ id: 'gemini-cli', label: 'X', defaultModel: 'gemini-cli', cliBinary: path.join(binDir, 'gemini') });
  assert.deepEqual(await gemini.listModels(), ['gemini-cli']);
  const cursor = createProvider({ id: 'cursor-cli', label: 'X', defaultModel: 'cursor-cli', cliBinary: path.join(binDir, 'cursor-agent') });
  assert.deepEqual(await cursor.listModels(), ['cursor-cli']);
  await opencode.dispose?.();
  await gemini.dispose?.();
  await cursor.dispose?.();
});

test('M3 model registry: catalogue 4 provider mới, fallback là chính nó', () => {
  const registry = new ModelRegistry({ logger: { warn: () => undefined } });
  const snap = registry.snapshot();
  assert.deepEqual(snap.providers['opencode'].models, [{ id: 'opencode', label: 'opencode' }]);
  assert.deepEqual(snap.providers['gemini-cli'].models, [{ id: 'gemini-cli', label: 'gemini-cli' }]);
  assert.deepEqual(snap.providers['cursor-cli'].models, [{ id: 'cursor-cli', label: 'cursor-cli' }]);
  assert.deepEqual(snap.providers['custom-acp'].models, [{ id: 'custom-acp', label: 'custom-acp' }]);
  assert.equal(registry.getFallback('opencode'), 'opencode');
  assert.equal(registry.getFallback('custom-acp'), 'custom-acp');
});

test('M3 base class export: BaseAcpCliProvider dùng được trực tiếp (driver tự viết)', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const dir = makeTempDir();
  const provider = new BaseAcpCliProvider(
    { id: 'my-acp', label: 'My ACP', defaultModel: 'my-acp' },
    { providerId: 'my-acp', modelId: 'my-acp', displayName: 'My ACP' },
    {
      binaryPath: path.join(binDir, 'mycli'),
      acpArgs: ['acp'],
      cwd: dir,
      extraEnvAllowed: ACP_FAKE_ENV,
      timeoutMs: 10_000,
    },
  );
  try {
    assert.equal(provider.id, 'my-acp');
    assert.deepEqual(await provider.listModels(), ['my-acp']);
    const res = await provider.chat(chatReq('hello base'));
    assert.match(res.text, /Fake reply to: hello base/);
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Re-detect -> picker (tầng core): available hiện, unavailable/tắt thì ẩn
// ---------------------------------------------------------------------------

test('M3 redetect picker (core): bật nguồn + available thì dùng được; tắt nguồn thì ẩn', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const registry = registryFor(binDir);
  let snap = await registry.detect({ force: true });
  assert.equal(snap.engines['opencode'].status, 'available');
  assert.equal(isEngineUsable(snap, 'opencode'), false); // chưa bật (mặc định tắt)
  registry.setEnabled('opencode', true);
  snap = await registry.detect({ force: true });
  assert.equal(isEngineUsable(snap, 'opencode'), true); // picker hiện
  registry.setEnabled('opencode', false);
  snap = await registry.detect({ force: true });
  assert.equal(isEngineUsable(snap, 'opencode'), false); // picker ẩn
});

test('M3 redetect picker (core): xoá binary rồi quét lại -> unavailable, picker ẩn', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'opencode']);
  const registry = registryFor(binDir);
  registry.setEnabled('opencode', true);
  let snap = await registry.detect({ force: true });
  assert.equal(isEngineUsable(snap, 'opencode'), true);
  fs.unlinkSync(path.join(binDir, 'opencode'));
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['opencode'].status, 'unavailable');
  assert.equal(snap.engines['opencode'].reason, 'not-installed');
  assert.equal(isEngineUsable(snap, 'opencode'), false);
});

test('M3 redetect picker (core): custom CLI vừa thêm thì hiện sau khi bật, vừa xoá thì ẩn', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'mycli']);
  const registry = registryFor(binDir);
  registry.addCustomCli({ id: 'my-agent', label: 'My Agent', binaryPath: path.join(binDir, 'mycli'), acpArgs: ['acp'] });
  let snap = await registry.detect({ force: true });
  assert.equal(isEngineUsableAllowingUnknown(snap, 'custom-acp:my-agent'), false);
  registry.setEnabled('custom-acp:my-agent', true);
  snap = await registry.detect({ force: true });
  assert.equal(isEngineUsableAllowingUnknown(snap, 'custom-acp:my-agent'), true);
  registry.removeCustomCli('my-agent');
  snap = await registry.detect({ force: true });
  assert.equal(isEngineUsableAllowingUnknown(snap, 'custom-acp:my-agent'), false);
});
