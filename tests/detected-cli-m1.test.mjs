/**
 * Tests cho M1 — Detector registry + driver Claude Code
 * (packages/core/src/detected/, packages/core/src/providers/cli/).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/detected-cli-m1.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: mọi CLI
 * trong test đều là fake script trong tests/fixtures/ (fake-claude.mjs,
 * fake-codex.mjs) được copy vào thư mục tạm và tìm qua `pathDirs`;
 * home giả cũng là thư mục tạm. Máy test này không có CLI nào đăng nhập
 * nên hành vi thật (shape `claude auth status --json`, stream-JSON thật)
 * vẫn là follow-up bắt buộc (xem detected/README.md).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ClaudeCodeCliProvider,
  DetectedEngineRegistry,
  ModelRegistry,
  createProvider,
  isEngineUsable,
  sanitizeEnvForCli,
  usableEngineBinary,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';
import { NdjsonEventParser, mapClaudeEvent } from '../packages/core/dist/providers/cli/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-m1-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_CLAUDE_') || key.startsWith('FAKE_CODEX_')) delete process.env[key];
  }
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

/** Registry trỏ vào thư mục bin giả + home giả. PATH được kiểm soát để
 *  detector không bao giờ chạm tới CLI thật trên máy (vd `codex` thật
 *  đi kèm VM image) — test chỉ dùng fake binary. */
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
    return (err).code === 'EPERM';
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

// ---------------------------------------------------------------------------
// Detector registry
// ---------------------------------------------------------------------------

test('M1 detector: fake claude + codex available kèm version + nhãn tài khoản; CLI chưa cài thì unavailable', async () => {
  const { binDir } = makeBinDir(
    ['fake-claude.mjs', 'claude'],
    ['fake-codex.mjs', 'codex'],
  );
  const registry = registryFor(binDir);
  const snap = await registry.detect();

  const claude = snap.engines['claude'];
  assert.equal(claude.status, 'available');
  assert.equal(claude.version, '2.1.318');
  assert.equal(claude.binaryPath, path.join(binDir, 'claude'));
  assert.equal(claude.account?.label, 'test@example.com');
  assert.equal(claude.account?.method, 'subscription');
  // Opt-in mặc định TẮT.
  assert.equal(claude.enabled, false);

  const codex = snap.engines['codex'];
  assert.equal(codex.status, 'available');
  assert.equal(codex.version, '0.164.0');
  assert.ok(codex.account?.label?.includes('test@example.com'));

  for (const kind of ['grok', 'opencode', 'gemini', 'cursor']) {
    assert.equal(snap.engines[kind].status, 'unavailable', kind);
    assert.equal(snap.engines[kind].reason, 'not-installed', kind);
    assert.equal(snap.engines[kind].binaryPath, null, kind);
  }
});

test('M1 detector: version dưới tối thiểu -> version-too-old', async () => {
  process.env.FAKE_CLAUDE_VERSION = 'claude/1.0.0 (Fake)';
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['claude'].status, 'unavailable');
  assert.equal(snap.engines['claude'].reason, 'version-too-old');
  assert.equal(snap.engines['claude'].version, '1.0.0');
});

test('M1 detector: auth status lỗi -> not-signed-in', async () => {
  process.env.FAKE_CLAUDE_AUTH = 'fail';
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['claude'].status, 'unavailable');
  assert.equal(snap.engines['claude'].reason, 'not-signed-in');
  assert.equal(snap.engines['claude'].version, '2.1.318');
});

test('M1 detector: cache TTL — detect lần 2 dùng cache, force quét lại', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  let calls = 0;
  const { runProbe } = await import('../packages/core/dist/detected/probe.js');
  const registry = registryFor(binDir, {
    cacheTtlMs: 60_000,
    execFn: async (binary, args, opts) => {
      calls += 1;
      return runProbe(binary, args, opts);
    },
  });
  await registry.detect();
  const afterFirst = calls;
  assert.ok(afterFirst > 0, 'lần detect đầu phải chạy probe');
  await registry.detect();
  assert.equal(calls, afterFirst, 'lần detect 2 trong TTL không chạy thêm probe');
  await registry.detect({ force: true });
  assert.ok(calls > afterFirst, 'force phải chạy probe lại');
});

test('M1 detector: registerDetector thêm CLI mới không cần sửa core', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'mycli']);
  const registry = registryFor(binDir);
  registry.registerDetector({
    kind: 'mycli',
    label: 'My CLI',
    binaries: ['mycli'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: {
      type: 'command',
      args: ['auth', 'status', '--json'],
      parse: (result) => (result.code === 0 ? { method: 'oauth' } : null),
    },
  });
  const snap = await registry.detect();
  assert.equal(snap.engines['mycli'].status, 'available');
  assert.equal(snap.engines['mycli'].label, 'My CLI');
  assert.ok(registry.listKinds().includes('mycli'));
});

test('M1 detector: Grok kiểm tra bằng sự TỒN TẠI của auth.json (không đọc nội dung)', async () => {
  const homeDir = makeTempDir();
  const { binDir } = makeBinDir(['fake-claude.mjs', 'grok']);
  const registry = registryFor(binDir, { homeDir });
  // Chưa có file -> not-signed-in.
  let snap = await registry.detect();
  assert.equal(snap.engines['grok'].status, 'unavailable');
  assert.equal(snap.engines['grok'].reason, 'not-signed-in');
  // Tạo file rỗng -> available (chỉ cần tồn tại).
  fs.mkdirSync(path.join(homeDir, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.grok', 'auth.json'), '{"token":"fake-never-read"}', 'utf8');
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['grok'].status, 'available');
  // Snapshot không chứa nội dung file.
  assert.equal(JSON.stringify(snap).includes('fake-never-read'), false);
});

test('M1 detector: Gemini lấy nhãn từ google_accounts.json (chỉ email), oauth_creds.json chỉ kiểm tra tồn tại', async () => {
  const homeDir = makeTempDir();
  const { binDir } = makeBinDir(['fake-claude.mjs', 'gemini']);
  const registry = registryFor(binDir, { homeDir });
  let snap = await registry.detect();
  assert.equal(snap.engines['gemini'].status, 'unavailable');
  assert.equal(snap.engines['gemini'].reason, 'not-signed-in');

  fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.gemini', 'google_accounts.json'),
    JSON.stringify({ activeAccount: 'gemini-user@example.com' }),
    'utf8',
  );
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['gemini'].status, 'available');
  assert.equal(snap.engines['gemini'].account?.label, 'gemini-user@example.com');

  // Chỉ có oauth_creds.json (file token) -> available nhưng không có nhãn.
  fs.rmSync(path.join(homeDir, '.gemini', 'google_accounts.json'));
  fs.writeFileSync(path.join(homeDir, '.gemini', 'oauth_creds.json'), '{"access_token":"fake"}', 'utf8');
  snap = await registry.detect({ force: true });
  assert.equal(snap.engines['gemini'].status, 'available');
  assert.equal(snap.engines['gemini'].account?.label, undefined);
  assert.equal(JSON.stringify(snap).includes('fake'), false);
});

// ---------------------------------------------------------------------------
// Opt-in + visibility (fail-closed)
// ---------------------------------------------------------------------------

test('M1 opt-in: mặc định tắt, setEnabled bền vững qua file, file hỏng thì tất cả tắt', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const stateFile = path.join(dir, 'detected-engines.json');
  const registry = registryFor(binDir, { stateFilePath: stateFile });
  await registry.detect();
  assert.equal(registry.isEnabled('claude'), false);
  assert.deepEqual(registry.enabledAvailable(), []);

  registry.setEnabled('claude', true);
  assert.equal(registry.isEnabled('claude'), true);
  assert.equal(registry.enabledAvailable().length, 1);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.enabled['claude'], true);
  // Không có secret nào trong file trạng thái.
  assert.equal(JSON.stringify(saved).includes('test@example.com'), false);

  const registry2 = registryFor(binDir, { stateFilePath: stateFile });
  assert.equal(registry2.isEnabled('claude'), true);
  assert.throws(() => registry2.setEnabled('khong-co', true), /Không rõ nguồn/);

  // File hỏng -> tất cả tắt, không throw.
  fs.writeFileSync(stateFile, '{hong', 'utf8');
  const registry3 = registryFor(binDir, { stateFilePath: stateFile });
  assert.equal(registry3.isEnabled('claude'), false);
});

test('M1 visibility: provider CLI chỉ dùng được khi vừa bật vừa available', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(isEngineUsable(null, 'claude'), false);
  assert.equal(isEngineUsable(snap, 'claude'), false, 'chưa bật thì không dùng được');
  assert.equal(usableEngineBinary(snap, 'claude'), null);
  registry.setEnabled('claude', true);
  const snap2 = registry.snapshot();
  assert.equal(isEngineUsable(snap2, 'claude'), true);
  assert.equal(usableEngineBinary(snap2, 'claude'), path.join(binDir, 'claude'));
});

// ---------------------------------------------------------------------------
// Stream-JSON parser
// ---------------------------------------------------------------------------

test('M1 parser: mapClaudeEvent dịch system/assistant/result, bỏ qua event lạ', () => {
  const { events: sysEvents, sessionId } = mapClaudeEvent({
    type: 'system',
    subtype: 'init',
    session_id: 's-1',
  });
  assert.deepEqual(sysEvents, []);
  assert.equal(sessionId, 's-1');

  const { events } = mapClaudeEvent({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'chào ' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/a' } },
        { type: 'thinking', thinking: '...' },
      ],
    },
  });
  assert.deepEqual(events, [
    { type: 'text', delta: 'chào ' },
    { type: 'tool_call', call: { id: 'tu1', name: 'read_file', args: { path: '/a' } } },
  ]);

  const result = mapClaudeEvent({
    type: 'result',
    subtype: 'success',
    result: 'xong',
    usage: { input_tokens: 3, output_tokens: 4 },
    session_id: 's-1',
  });
  assert.deepEqual(result.events, [
    { type: 'result', text: 'xong', usage: { inputTokens: 3, outputTokens: 4 }, sessionId: 's-1' },
  ]);

  const errResult = mapClaudeEvent({
    type: 'result',
    subtype: 'error',
    is_error: true,
    errors: ['boom'],
  });
  assert.equal(errResult.events[0].type, 'error');
  assert.match(errResult.events[0].message, /boom/);

  assert.deepEqual(mapClaudeEvent({ type: 'weird-thing' }).events, []);
  assert.deepEqual(mapClaudeEvent('not-an-object').events, []);
});

test('M1 parser: NdjsonEventParser xử lý chunk cắt đôi + dòng hỏng', () => {
  const seen = [];
  const parser = new NdjsonEventParser((e) => seen.push(e));
  parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"a');
  parser.feed('bc"}]}}\nnot json\n{"type":"result","subtype":"success","result":"abc"}\n');
  parser.flush();
  assert.deepEqual(seen, [
    { type: 'text', delta: 'abc' },
    { type: 'result', text: 'abc', usage: undefined, sessionId: undefined },
  ]);
  const stats = parser.getStats();
  assert.equal(stats.malformedLines, 1);
  assert.equal(stats.events, 2);
});

// ---------------------------------------------------------------------------
// Env sanitization
// ---------------------------------------------------------------------------

test('M1 env: chỉ allowlist đi qua, mọi key lạ đều bị chặn', () => {
  const env = sanitizeEnvForCli(
    {
      PATH: '/usr/bin:/bin',
      HOME: '/home/test',
      XAI_API_KEY: 'sk-xai-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      CUSTOM_VAR: 'hello',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    },
    ['CLAUDE_CODE_OAUTH_TOKEN'],
  );
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token');
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CUSTOM_VAR, undefined);
  assert.equal(JSON.stringify(env).includes('secret'), false);

  // Không khai extraAllowed thì cả token OAuth của CLI cũng bị chặn
  // (mặc định an toàn — driver phải khai tường minh biến nó cần).
  const strict = sanitizeEnvForCli({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token', PATH: '/usr/bin' });
  assert.equal(strict.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

// ---------------------------------------------------------------------------
// Driver Claude Code (fake CLI)
// ---------------------------------------------------------------------------

/** Provider trỏ tới fake claude trong thư mục bin tạm. */
function fakeClaudeProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  const extra = ['FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SPAWN_LOG', 'FAKE_CLAUDE_PID_FILE', 'FAKE_CLAUDE_ENV_DUMP'];
  return new ClaudeCodeCliProvider(
    { id: 'claude-code', label: 'Claude Code (CLI)', defaultModel: 'claude-code' },
    {
      binaryPath: path.join(binDir, 'claude'),
      cwd: dir,
      extraEnvAllowed: ['CLAUDE_CODE_OAUTH_TOKEN', ...extra],
      ...opts,
    },
  );
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

test('M1 driver: chat trả text + usage, process sống qua 2 turn, chỉ gửi delta', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.FAKE_CLAUDE_SPAWN_LOG = spawnLog;
  const provider = fakeClaudeProvider(binDir);
  try {
    const r1 = await provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'xin chào' }],
    });
    assert.match(r1.text, /Fake reply to: xin chào/);
    assert.deepEqual(r1.toolCalls, []);
    assert.deepEqual(r1.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(provider.isProcessAlive, true);

    const r2 = await provider.chat({
      model: 'claude-code',
      messages: [
        { role: 'user', content: 'xin chào' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: câu hai/);
    // Chỉ gửi message mới: log có đúng 2 prompt, không gửi lại 'xin chào'.
    assert.deepEqual(readLines(logFile), ['prompt:xin chào', 'prompt:câu hai']);
    // Không restart: chỉ spawn 1 lần.
    assert.deepEqual(readLines(spawnLog), ['spawned']);
  } finally {
    await provider.dispose();
  }
  assert.equal(provider.isProcessAlive, false);
});

test('M1 driver: system prompt đổi -> restart process và gửi lại toàn bộ history', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.FAKE_CLAUDE_SPAWN_LOG = spawnLog;
  const provider = fakeClaudeProvider(binDir);
  try {
    await provider.chat({
      model: 'claude-code',
      messages: [
        { role: 'system', content: 'Bạn là A.' },
        { role: 'user', content: 'câu một' },
      ],
    });
    const r2 = await provider.chat({
      model: 'claude-code',
      messages: [
        { role: 'system', content: 'Bạn là B.' },
        { role: 'user', content: 'câu một' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'câu hai' },
      ],
    });
    assert.match(r2.text, /Fake reply to: câu hai/);
    assert.deepEqual(readLines(spawnLog), ['spawned', 'spawned']);
    // Sau restart gửi lại toàn bộ user message: câu một rồi câu hai.
    assert.deepEqual(readLines(logFile), ['prompt:câu một', 'prompt:câu một', 'prompt:câu hai']);
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: history bị viết lại (compaction) -> restart và gửi lại', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const logFile = path.join(dir, 'prompts.log');
  const spawnLog = path.join(dir, 'spawn.log');
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.FAKE_CLAUDE_SPAWN_LOG = spawnLog;
  const provider = fakeClaudeProvider(binDir);
  try {
    await provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'câu gốc' }],
    });
    const r2 = await provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'tóm tắt: câu gốc' }],
    });
    assert.match(r2.text, /Fake reply to: tóm tắt/);
    assert.deepEqual(readLines(spawnLog), ['spawned', 'spawned']);
    assert.deepEqual(readLines(logFile), ['prompt:câu gốc', 'prompt:tóm tắt: câu gốc']);
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: tool_call của CLI surface qua onCliEvent, không đi vào toolCalls trả về', async () => {
  process.env.FAKE_CLAUDE_MODE = 'toolcall';
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const events = [];
  const provider = fakeClaudeProvider(binDir, { onCliEvent: (e) => events.push(e) });
  try {
    const res = await provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'đọc file giúp tôi' }],
    });
    assert.deepEqual(res.toolCalls, [], 'CLI tự chạy tool của nó — open-bot không thực thi lại');
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

test('M1 driver: result error -> chat reject rõ ràng', async () => {
  process.env.FAKE_CLAUDE_MODE = 'error';
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const provider = fakeClaudeProvider(binDir);
  try {
    await assert.rejects(
      provider.chat({ model: 'claude-code', messages: [{ role: 'user', content: 'hi' }] }),
      /fake boom/,
    );
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: process chết giữa chừng -> chat reject, lần sau spawn lại được', async () => {
  process.env.FAKE_CLAUDE_MODE = 'die';
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const provider = fakeClaudeProvider(binDir);
  try {
    await assert.rejects(
      provider.chat({ model: 'claude-code', messages: [{ role: 'user', content: 'hi' }] }),
      /chết giữa chừng/,
    );
    assert.equal(provider.isProcessAlive, false);
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: abort giữa turn kill sạch process group', async () => {
  process.env.FAKE_CLAUDE_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const provider = fakeClaudeProvider(binDir);
  const controller = new AbortController();
  try {
    const promise = provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    // v0.85: assert the wait — waitUntil() returns false after 3000ms
    // when the pidFile never appears, and the readFileSync below used
    // to throw a confusing ENOENT instead of a real assertion.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile)), 'fake process phải ghi pidFile trước khi abort');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0 && isAlive(pid), 'fake process phải đang sống trước khi abort');
    controller.abort();
    await assert.rejects(promise, (err) => err.name === 'AbortError');
    assert.ok(await waitUntil(() => !isAlive(pid)), 'process phải chết sau abort');
    assert.equal(provider.isProcessAlive, false);
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: timeout turn kill process và báo hết thời gian chờ', async () => {
  process.env.FAKE_CLAUDE_MODE = 'slow';
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const provider = fakeClaudeProvider(binDir, { timeoutMs: 2000 });
  try {
    const promise = provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // v0.85: timeout 400ms -> 2000ms — the fake binary is
    // `#!/usr/bin/env node`, and spawn + runtime startup alone can
    // exceed 400ms under load (red once at 422ms: the turn timed out
    // before the fake process was even observable). The fake 'slow'
    // mode never replies, so 2000ms still times out — only later.
    // The 400ms business timeout itself is still covered by the
    // in-process fake-spawn unit test in detected-cli-b-drivers.
    assert.ok(await waitUntil(() => fs.existsSync(pidFile)), 'fake process phải ghi pidFile trước khi timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await assert.rejects(promise, /hết thời gian chờ 2000ms/);
    assert.ok(await waitUntil(() => !isAlive(pid)), 'process phải chết sau timeout');
  } finally {
    await provider.dispose();
  }
});

test('M1 driver: env của turn không chứa key lạ, chỉ có allowlist + token OAuth của CLI', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const envDump = path.join(dir, 'env.json');
  process.env.FAKE_CLAUDE_ENV_DUMP = envDump;
  process.env.XAI_API_KEY = 'sk-xai-fake-secret';
  process.env.OPENAI_API_KEY = 'sk-openai-fake-secret';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fake-token';
  const provider = fakeClaudeProvider(binDir);
  try {
    await provider.chat({ model: 'claude-code', messages: [{ role: 'user', content: 'hi' }] });
    const dumped = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    assert.equal(dumped.PATH !== undefined, true);
    assert.equal(dumped.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-fake-token');
    assert.equal(dumped.XAI_API_KEY, undefined);
    assert.equal(dumped.OPENAI_API_KEY, undefined);
    assert.equal(JSON.stringify(dumped).includes('fake-secret'), false);
  } finally {
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await provider.dispose();
  }
});

test('M1 driver: dispose kill process; chat sau dispose thì lỗi rõ', async () => {
  const { dir, binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const pidFile = path.join(dir, 'pid');
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const provider = fakeClaudeProvider(binDir);
  await provider.chat({ model: 'claude-code', messages: [{ role: 'user', content: 'hi' }] });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pid));
  await provider.dispose();
  assert.ok(await waitUntil(() => !isAlive(pid)), 'process phải chết sau dispose');
  await assert.rejects(
    provider.chat({ model: 'claude-code', messages: [{ role: 'user', content: 'hi' }] }),
    /đã dispose/,
  );
});

test('M1 driver: listModels chỉ có claude-code; chat không có user message thì lỗi rõ', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const provider = fakeClaudeProvider(binDir);
  try {
    assert.deepEqual(await provider.listModels(), ['claude-code']);
    await assert.rejects(
      provider.chat({ model: 'claude-code', messages: [{ role: 'system', content: 'x' }] }),
      /không có user message/,
    );
  } finally {
    await provider.dispose();
  }
});

// ---------------------------------------------------------------------------
// Nối vào model registry + createProvider
// ---------------------------------------------------------------------------

test('M1 wiring: model registry có claude-code; createProvider cần cliBinary', async () => {
  const registry = new ModelRegistry();
  assert.deepEqual(
    registry.listModels('claude-code').map((m) => m.id),
    ['claude-code'],
  );
  assert.equal(registry.getDefault('claude-code'), 'claude-code');
  assert.equal(registry.getFallback('claude-code'), 'claude-code');

  const meta = PROVIDERS.find((p) => p.id === 'claude-code');
  assert.ok(meta, 'PROVIDERS phải có claude-code');
  assert.equal(meta.kind, 'cli');
  assert.equal(meta.detectedKind, 'claude');
  assert.equal(meta.needsKey, false);

  assert.throws(
    () => createProvider({ id: 'claude-code', label: 'Claude Code (CLI)', defaultModel: 'claude-code' }),
    /chưa có đường dẫn binary/,
  );
});

test('M1 wiring: createProvider với fake binary chạy được một turn', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const provider = createProvider({
    id: 'claude-code',
    label: 'Claude Code (CLI)',
    defaultModel: 'claude-code',
    cliBinary: path.join(binDir, 'claude'),
  });
  assert.equal(provider.id, 'claude-code');
  try {
    const res = await provider.chat({
      model: 'claude-code',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.match(res.text, /Fake reply to: hello/);
  } finally {
    await provider.dispose?.();
  }
});
