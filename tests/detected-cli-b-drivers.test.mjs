/**
 * Tests cho driver sóng B (M4) — 5 CLI Team B mới chỉ làm detector:
 * Aider, Continue, GitHub Copilot CLI, Amazon Q CLI, Windsurf
 * (packages/core/src/providers/cli/: oneShot.ts, aider.ts,
 * continueCli.ts, amazonQ.ts, copilotCli.ts, windsurf.ts; đăng ký ở
 * providers/index.ts + main process providerConfigFor).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/detected-cli-b-drivers.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: mọi CLI
 * trong test đều là fake script trong tests/fixtures/ (fake-aider.mjs,
 * fake-cn.mjs, fake-q.mjs cho one-shot; fake-acp-generic.mjs đóng
 * vai copilot/devin cho ACP) được copy vào thư mục tạm. Biến môi
 * trường API key trong test chỉ là chuỗi giả ('test-fake-key-...') —
 * snapshot/output không bao giờ được chứa giá trị key thật (test env
 * kiểm tra).
 *
 * Mức kiểm chứng (ghi rõ — xem providers/cli/README.md mục M4):
 * - 5 driver: CHƯA chạy lần nào trên CLI thật (máy này không có
 *   aider/cn/q/copilot/devin) — cờ spawn + shape output đều từ
 *   docs/code công khai; Continue `-p` chỉ được wrapper bên thứ ba
 *   xác nhận nên driver đánh dấu experimental.
 * - Windsurf: driver chỉ nhận binary `devin` (Devin CLI) — launcher
 *   của editor (`windsurf`/`devin-desktop`) bị từ chối rõ ràng.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AiderCliProvider,
  AmazonQCliProvider,
  ContinueCliProvider,
  CopilotCliProvider,
  DetectedEngineRegistry,
  WindsurfCliProvider,
  createProvider,
  isDevinCliBinary,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';
import {
  AIDER_KEY_ENV_VARS,
  parseAiderUsage,
  renderOneShotPrompt,
  stripAnsi,
} from '../packages/core/dist/providers/cli/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-b-drivers-test-'));
  tempDirs.push(dir);
  return dir;
}

// Fake binary cần `node` trên PATH (shebang `#!/usr/bin/env node`).
const savedPath = process.env.PATH;
process.env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`;

const FAKE_ENV_KEYS = [
  'FAKE_AIDER_MODE',
  'FAKE_AIDER_ARGS_LOG',
  'FAKE_AIDER_ENV_DUMP',
  'FAKE_CN_MODE',
  'FAKE_CN_ARGS_LOG',
  'FAKE_CN_ENV_DUMP',
  'FAKE_Q_MODE',
  'FAKE_Q_ARGS_LOG',
  'FAKE_Q_ENV_DUMP',
  'FAKE_ACP_MODE',
  'FAKE_ACP_LOG',
  'FAKE_ACP_SESSION_LOG',
  'FAKE_ACP_APPROVAL_LOG',
  'FAKE_ACP_SPAWN_LOG',
  'FAKE_ACP_ENV_DUMP',
];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.HIDDEN_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.COPILOT_PROVIDERS_CONFIG;
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

function chatReq(text, system) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: text });
  return { messages, model: 'test-model' };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --- Helpers tạo provider (fake env được phép chui qua sanitize) --------

function aiderProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new AiderCliProvider(
    { id: 'aider', label: 'Aider', defaultModel: 'aider' },
    {
      binaryPath: path.join(binDir, 'aider'),
      cwd: dir,
      extraEnvAllowed: [
        ...AIDER_KEY_ENV_VARS,
        'FAKE_AIDER_MODE',
        'FAKE_AIDER_ARGS_LOG',
        'FAKE_AIDER_ENV_DUMP',
      ],
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

function continueProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new ContinueCliProvider(
    { id: 'continue-cli', label: 'Continue CLI', defaultModel: 'continue-cli' },
    {
      binaryPath: path.join(binDir, 'cn'),
      cwd: dir,
      extraEnvAllowed: [
        'ANTHROPIC_API_KEY',
        'CONTINUE_USE_BEDROCK',
        'FAKE_CN_MODE',
        'FAKE_CN_ARGS_LOG',
        'FAKE_CN_ENV_DUMP',
      ],
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

function amazonQProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new AmazonQCliProvider(
    { id: 'amazon-q', label: 'Amazon Q CLI', defaultModel: 'amazon-q' },
    {
      binaryPath: path.join(binDir, 'q'),
      cwd: dir,
      extraEnvAllowed: [
        'AWS_PROFILE',
        'FAKE_Q_MODE',
        'FAKE_Q_ARGS_LOG',
        'FAKE_Q_ENV_DUMP',
      ],
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

const ACP_FAKE_ENV = [
  'FAKE_ACP_MODE',
  'FAKE_ACP_LOG',
  'FAKE_ACP_SESSION_LOG',
  'FAKE_ACP_APPROVAL_LOG',
  'FAKE_ACP_SPAWN_LOG',
  'FAKE_ACP_ENV_DUMP',
];

function copilotProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new CopilotCliProvider(
    { id: 'copilot-cli', label: 'GitHub Copilot CLI', defaultModel: 'copilot-cli' },
    {
      binaryPath: path.join(binDir, 'copilot'),
      cwd: dir,
      extraEnvAllowed: [...ACP_FAKE_ENV, 'COPILOT_PROVIDERS_CONFIG'],
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

function windsurfProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new WindsurfCliProvider(
    { id: 'windsurf', label: 'Windsurf', defaultModel: 'windsurf' },
    {
      binaryPath: path.join(binDir, 'devin'),
      cwd: dir,
      extraEnvAllowed: ACP_FAKE_ENV,
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

// --- Registry: 5 provider mới --------------------------------------------

test('B-drivers registry: 5 provider CLI mới trong PROVIDERS + createProvider', async () => {
  const expected = [
    ['aider', 'aider'],
    ['continue-cli', 'continue'],
    ['amazon-q', 'amazonq'],
    ['copilot-cli', 'copilot'],
    ['windsurf', 'windsurf'],
  ];
  for (const [id, detectedKind] of expected) {
    const meta = PROVIDERS.find((m) => m.id === id);
    assert.ok(meta, id);
    assert.equal(meta.kind, 'cli', id);
    assert.equal(meta.detectedKind, detectedKind, id);
    assert.equal(meta.needsKey, false, id);
  }
  // createProvider không có binary → throw fail-closed (windsurf
  // báo riêng: binary rỗng không phải Devin CLI — cũng fail-closed).
  for (const [id] of expected) {
    const pattern = id === 'windsurf' ? /không phải Devin CLI/ : /chưa có đường dẫn binary/;
    assert.throws(() => createProvider({ id, label: id, defaultModel: id }), pattern, id);
  }
  // createProvider với binary giả → listModels trả đúng model id.
  const { binDir } = makeBinDir(
    ['fake-aider.mjs', 'aider'],
    ['fake-cn.mjs', 'cn'],
    ['fake-q.mjs', 'q'],
    ['fake-acp-generic.mjs', 'copilot'],
    ['fake-acp-generic.mjs', 'devin'],
  );
  const bins = {
    aider: path.join(binDir, 'aider'),
    'continue-cli': path.join(binDir, 'cn'),
    'amazon-q': path.join(binDir, 'q'),
    'copilot-cli': path.join(binDir, 'copilot'),
    windsurf: path.join(binDir, 'devin'),
  };
  for (const [id, detectedKind] of expected) {
    void detectedKind;
    const provider = createProvider({
      id,
      label: id,
      defaultModel: id,
      cliBinary: bins[id],
    });
    assert.deepEqual(await provider.listModels(), [id]);
    await provider.dispose?.();
  }
});

// --- Helpers one-shot (unit, không cần process) ---------------------------

test('B-drivers one-shot helpers: render prompt + strip ANSI + parse usage Aider', () => {
  const prompt = renderOneShotPrompt([
    { role: 'system', content: 'Bạn là trợ lý.' },
    { role: 'user', content: 'Xin chào' },
    { role: 'assistant', content: 'Chào bạn' },
    { role: 'user', content: 'Làm gì tiếp?' },
  ]);
  assert.ok(prompt.includes('Bạn là trợ lý.'));
  assert.ok(prompt.includes('User: Xin chào'));
  assert.ok(prompt.includes('Assistant: Chào bạn'));
  assert.ok(prompt.includes('User: Làm gì tiếp?'));

  assert.equal(stripAnsi('\u001b[32mOK\u001b[0m và \u001b[1mbold\u001b[22m'), 'OK và bold');
  assert.equal(stripAnsi('a\r\nb\rc'), 'a\nb\nc');

  assert.deepEqual(parseAiderUsage('Tokens: 1.2k sent, 300 received, 1.5k total.'), {
    inputTokens: 1200,
    outputTokens: 300,
  });
  assert.deepEqual(parseAiderUsage('Tokens: 12,345 sent, 1,234 received.'), {
    inputTokens: 12345,
    outputTokens: 1234,
  });
  assert.equal(parseAiderUsage('không có dòng tokens'), undefined);
});

// --- Aider ----------------------------------------------------------------

test('B-drivers aider: turn đơn giản, usage từ dòng Tokens, argv đủ cờ an toàn', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const dir = makeTempDir();
  const argsLog = path.join(dir, 'aider-args.log');
  const events = [];
  const provider = aiderProvider(binDir, { onCliEvent: (e) => events.push(e) });
  process.env.FAKE_AIDER_ARGS_LOG = argsLog;
  const res = await provider.chat(chatReq('xin chào aider', 'Bạn là trợ lý.'));
  assert.match(res.text, /Aider reply to:/);
  assert.deepEqual(res.toolCalls, []);
  assert.deepEqual(res.usage, { inputTokens: 1200, outputTokens: 300 });
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(events.some((e) => e.type === 'result'));
  const logged = readLines(argsLog).join(' ');
  assert.ok(logged.includes('--message'), logged);
  assert.ok(logged.includes('--yes-always'), logged);
  assert.ok(logged.includes('--no-auto-commits'), logged);
  assert.ok(logged.includes('--no-pretty'), logged);
  // Prompt gửi đi chứa system + user message (one-shot gửi toàn bộ).
  assert.ok(logged.includes('Bạn là trợ lý.'), logged);
  assert.ok(logged.includes('xin chào aider'), logged);
  await provider.dispose();
});

test('B-drivers aider: lỗi exit != 0, output rỗng, timeout, abort, env đã lọc secret', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'aider-env.json');

  process.env.FAKE_AIDER_MODE = 'fail';
  process.env.FAKE_AIDER_ENV_DUMP = envDump;
  const failing = aiderProvider(binDir);
  await assert.rejects(() => failing.chat(chatReq('x')), /mã 1.*No API key/);
  await failing.dispose();

  process.env.FAKE_AIDER_MODE = 'empty';
  const empty = aiderProvider(binDir);
  await assert.rejects(() => empty.chat(chatReq('x')), /không in ra text nào/);
  await empty.dispose();

  process.env.FAKE_AIDER_MODE = 'slow';
  const slow = aiderProvider(binDir, { timeoutMs: 300 });
  await assert.rejects(() => slow.chat(chatReq('x')), /hết thời gian chờ 300ms/);
  assert.equal(slow.isProcessAlive, false);
  await slow.dispose();

  const controller = new AbortController();
  const aborting = aiderProvider(binDir, { timeoutMs: 10_000 });
  const promise = aborting.chat({ ...chatReq('x'), signal: controller.signal });
  promise.catch(() => undefined);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, (err) => err.name === 'AbortError');
  assert.equal(aborting.isProcessAlive, false);
  await aborting.dispose();
  delete process.env.FAKE_AIDER_MODE;

  // Env: key Aider được phép chui qua, biến secret khác bị chặn.
  process.env.OPENAI_API_KEY = 'test-fake-key-openai';
  process.env.HIDDEN_TOKEN = 'test-fake-hidden-token';
  process.env.FAKE_AIDER_ENV_DUMP = envDump;
  const envCheck = aiderProvider(binDir);
  await envCheck.chat(chatReq('kiểm tra env'));
  const dumped = readJson(envDump);
  assert.equal(dumped.OPENAI_API_KEY, 'test-fake-key-openai');
  assert.equal(dumped.HIDDEN_TOKEN, undefined);
  await envCheck.dispose();
});

test('B-drivers aider: không user message / 2 turn cùng lúc / dispose đều lỗi rõ', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const provider = aiderProvider(binDir);
  await assert.rejects(
    () => provider.chat({ messages: [{ role: 'system', content: 'chỉ system' }], model: 'x' }),
    /không có user message/,
  );
  assert.throws(
    () =>
      new AiderCliProvider(
        { id: 'aider', label: 'A', defaultModel: 'aider' },
        { binaryPath: '' },
      ),
    /chưa có đường dẫn binary/,
  );
  process.env.FAKE_AIDER_MODE = 'slow';
  // v0.85: timeout 400ms -> 2000ms — same spawn-startup flake as M1
  // (fake binary is `#!/usr/bin/env node`; 'slow' never replies so
  // 2000ms still times out, only later). The 400ms business timeout
  // itself is covered in-process below (no binary spawn at all).
  const busy = aiderProvider(binDir, { timeoutMs: 2000 });
  const first = busy.chat(chatReq('chậm'));
  first.catch(() => undefined);
  await assert.rejects(() => busy.chat(chatReq('chen ngang')), /đã có một turn đang chạy/);
  await assert.rejects(first, /hết thời gian chờ/);
  await busy.dispose();
  await assert.rejects(() => busy.chat(chatReq('sau dispose')), /đã dispose/);
  await provider.dispose();
});

/**
 * v0.85: the 400ms business timeout, covered WITHOUT spawning any
 * binary. The binary-based timeout tests above had to move to 2000ms
 * because spawn + node startup alone can exceed 400ms under load —
 * so this in-process test (injected `spawn`, a fake child that never
 * outputs or exits until killed) is what still proves a 400ms turn
 * timeout fires with the exact message and kills the process.
 */
function neverExitingChild() {
  let killed = false;
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = { end() {}, write() { return true; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    if (killed) return false;
    killed = true;
    child.signalCode = 'SIGTERM';
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  return { child, wasKilled: () => killed };
}

test('B-drivers aider: timeout 400ms nghiệp vụ với fake spawn in-process (không spawn binary)', async () => {
  const { child, wasKilled } = neverExitingChild();
  const dir = makeTempDir();
  const provider = new AiderCliProvider(
    { id: 'aider', label: 'Aider', defaultModel: 'aider' },
    {
      binaryPath: '/nonexistent/aider',
      cwd: dir,
      timeoutMs: 400,
      spawn: () => child,
    },
  );
  await assert.rejects(() => provider.chat(chatReq('x')), /hết thời gian chờ 400ms/);
  assert.equal(wasKilled(), true, 'timeout phải kill process');
  assert.equal(provider.isProcessAlive, false);
  await provider.dispose();
});

// --- Continue ---------------------------------------------------------------

test('B-drivers continue: turn đơn giản qua -p, không auto-allow tool, experimental', async () => {
  const { binDir } = makeBinDir(['fake-cn.mjs', 'cn']);
  const dir = makeTempDir();
  const argsLog = path.join(dir, 'cn-args.log');
  process.env.FAKE_CN_ARGS_LOG = argsLog;
  const provider = continueProvider(binDir);
  assert.equal(provider.experimental, true);
  const res = await provider.chat(chatReq('xin chào cn'));
  assert.match(res.text, /Continue reply to:/);
  assert.deepEqual(res.toolCalls, []);
  const logged = readLines(argsLog).join(' ');
  assert.ok(logged.includes('-p'), logged);
  assert.ok(!logged.includes('--allow'), logged);
  await provider.dispose();
});

test('B-drivers continue: lỗi exit != 0, timeout, env chỉ cho ANTHROPIC_API_KEY qua', async () => {
  const { binDir } = makeBinDir(['fake-cn.mjs', 'cn']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'cn-env.json');

  process.env.FAKE_CN_MODE = 'fail';
  const failing = continueProvider(binDir);
  await assert.rejects(() => failing.chat(chatReq('x')), /mã 1.*No model configured/);
  await failing.dispose();

  process.env.FAKE_CN_MODE = 'slow';
  const slow = continueProvider(binDir, { timeoutMs: 300 });
  await assert.rejects(() => slow.chat(chatReq('x')), /hết thời gian chờ 300ms/);
  assert.equal(slow.isProcessAlive, false);
  await slow.dispose();
  delete process.env.FAKE_CN_MODE;

  process.env.ANTHROPIC_API_KEY = 'test-fake-key-anthropic';
  process.env.HIDDEN_TOKEN = 'test-fake-hidden-token';
  process.env.FAKE_CN_ENV_DUMP = envDump;
  const envCheck = continueProvider(binDir);
  await envCheck.chat(chatReq('kiểm tra env'));
  const dumped = readJson(envDump);
  assert.equal(dumped.ANTHROPIC_API_KEY, 'test-fake-key-anthropic');
  assert.equal(dumped.HIDDEN_TOKEN, undefined);
  await envCheck.dispose();
});

// --- Amazon Q ---------------------------------------------------------------

test('B-drivers amazonq: turn đơn giản qua chat --no-interactive, không --trust-all-tools', async () => {
  const { binDir } = makeBinDir(['fake-q.mjs', 'q']);
  const dir = makeTempDir();
  const argsLog = path.join(dir, 'q-args.log');
  process.env.FAKE_Q_ARGS_LOG = argsLog;
  const provider = amazonQProvider(binDir);
  const res = await provider.chat(chatReq('xin chào q'));
  assert.match(res.text, /Amazon Q reply to:/);
  assert.deepEqual(res.toolCalls, []);
  const logged = readLines(argsLog).join(' ');
  assert.ok(logged.startsWith('chat --no-interactive --input'), logged);
  assert.ok(!logged.includes('--trust-all-tools'), logged);
  await provider.dispose();
});

test('B-drivers amazonq: lỗi exit != 0, output rỗng, env chỉ cho AWS_PROFILE qua', async () => {
  const { binDir } = makeBinDir(['fake-q.mjs', 'q']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'q-env.json');

  process.env.FAKE_Q_MODE = 'fail';
  const failing = amazonQProvider(binDir);
  await assert.rejects(() => failing.chat(chatReq('x')), /mã 1.*Not logged in/);
  await failing.dispose();

  process.env.FAKE_Q_MODE = 'empty';
  const empty = amazonQProvider(binDir);
  await assert.rejects(() => empty.chat(chatReq('x')), /không in ra text nào/);
  await empty.dispose();
  delete process.env.FAKE_Q_MODE;

  process.env.AWS_PROFILE = 'test-profile';
  process.env.HIDDEN_TOKEN = 'test-fake-hidden-token';
  process.env.FAKE_Q_ENV_DUMP = envDump;
  const envCheck = amazonQProvider(binDir);
  await envCheck.chat(chatReq('kiểm tra env'));
  const dumped = readJson(envDump);
  assert.equal(dumped.AWS_PROFILE, 'test-profile');
  assert.equal(dumped.HIDDEN_TOKEN, undefined);
  await envCheck.dispose();
});

// --- Copilot CLI (ACP) ------------------------------------------------------

test('B-drivers copilot: turn ACP đơn giản qua --acp --stdio, usage + session', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'copilot']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'copilot-spawn.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  const provider = copilotProvider(binDir);
  const res = await provider.chat(chatReq('xin chào copilot'));
  assert.match(res.text, /Fake reply to: xin chào copilot/);
  assert.deepEqual(res.toolCalls, []);
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
  assert.ok(provider.copilotCliSessionId);
  assert.ok(readLines(spawnLog).join(' ').includes('--acp --stdio'));
  // Turn 2 tái dùng session trên cùng process.
  const res2 = await provider.chat({
    messages: [
      { role: 'user', content: 'xin chào copilot' },
      { role: 'assistant', content: res.text },
      { role: 'user', content: 'tiếp theo' },
    ],
    model: 'test-model',
  });
  assert.match(res2.text, /Fake reply to:/);
  await provider.dispose();
  assert.equal(provider.isProcessAlive, false);
});

test('B-drivers copilot: approval bị từ chối fail-closed, timeout khi server im lặng', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'copilot']);
  process.env.FAKE_ACP_MODE = 'approval';
  const events = [];
  const provider = copilotProvider(binDir, { onCliEvent: (e) => events.push(e) });
  const res = await provider.chat(chatReq('chạy lệnh nguy hiểm'));
  assert.match(res.text, /Fake reply to:/);
  assert.ok(events.some((e) => e.type === 'approval_denied'), JSON.stringify(events));
  await provider.dispose();
  delete process.env.FAKE_ACP_MODE;

  process.env.FAKE_ACP_MODE = 'slow';
  const slow = copilotProvider(binDir, { timeoutMs: 300 });
  await assert.rejects(() => slow.chat(chatReq('x')), /hết thời gian chờ 300ms/);
  assert.equal(slow.isProcessAlive, false);
  await slow.dispose();
  delete process.env.FAKE_ACP_MODE;
});

// --- Windsurf (Devin CLI, ACP) ----------------------------------------------

test('B-drivers windsurf: turn ACP đơn giản qua devin acp, experimental', async () => {
  const { binDir } = makeBinDir(['fake-acp-generic.mjs', 'devin']);
  const dir = makeTempDir();
  const spawnLog = path.join(dir, 'devin-spawn.log');
  process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
  const provider = windsurfProvider(binDir);
  assert.equal(provider.experimental, true);
  assert.equal(isDevinCliBinary(path.join(binDir, 'devin')), true);
  assert.equal(isDevinCliBinary(path.join(binDir, 'windsurf')), false);
  assert.equal(isDevinCliBinary('/usr/bin/devin.exe'), true);
  const res = await provider.chat(chatReq('xin chào windsurf'));
  assert.match(res.text, /Fake reply to: xin chào windsurf/);
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 6 });
  assert.ok(provider.windsurfSessionId);
  assert.ok(readLines(spawnLog).join(' ').includes('spawned:acp'));
  await provider.dispose();
});

test('B-drivers windsurf: từ chối binary launcher của editor (windsurf/devin-desktop)', async () => {
  const { binDir } = makeBinDir(['fake-windsurf.mjs', 'windsurf']);
  assert.throws(
    () =>
      new WindsurfCliProvider(
        { id: 'windsurf', label: 'Windsurf', defaultModel: 'windsurf' },
        { binaryPath: path.join(binDir, 'windsurf') },
      ),
    /không phải Devin CLI/,
  );
  assert.throws(
    () =>
      new WindsurfCliProvider(
        { id: 'windsurf', label: 'Windsurf', defaultModel: 'windsurf' },
        { binaryPath: '/usr/bin/devin-desktop' },
      ),
    /không phải Devin CLI/,
  );
});

test('B-drivers windsurf detector: dò devin trước windsurf, trạng thái unknown', async () => {
  const { binDir } = makeBinDir(
    ['fake-acp-generic.mjs', 'devin'],
    ['fake-windsurf.mjs', 'windsurf'],
  );
  const homeDir = makeTempDir();
  const registry = new DetectedEngineRegistry({
    pathDirs: [binDir],
    homeDir,
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    },
    logger: { warn: () => undefined },
  });
  const snap = await registry.detect();
  const windsurf = snap.engines['windsurf'];
  assert.equal(windsurf.status, 'unknown');
  assert.equal(windsurf.version, '1.0.0');
  assert.ok(windsurf.binaryPath.endsWith(`${path.sep}devin`), windsurf.binaryPath);
});
