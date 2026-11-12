/**
 * Tests cho Kiro CLI (v0.76) — detector + driver one-shot
 * (packages/core/src/detected/definitions.ts kind 'kiro',
 * packages/core/src/providers/cli/kiroCli.ts).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/kiro-cli-v076.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: `kiro-cli`
 * trong test là fake script tests/fixtures/fake-kiro-cli.mjs được copy
 * vào thư mục tạm. `KIRO_API_KEY` trong test chỉ là chuỗi giả
 * ('test-fake-key-kiro') — snapshot/output không bao giờ được chứa giá
 * trị key thật (test env kiểm tra).
 *
 * Mức kiểm chứng (ghi rõ — xem providers/cli/README.md):
 * - Detector + driver: CHƯA chạy lần nào trên `kiro-cli` thật (máy này
 *   không có kiro-cli) — cờ spawn + lệnh `whoami --format json` đều từ
 *   docs chính thức kiro.dev (tra cứu 2026-11-11); shape JSON của
 *   `whoami` chưa được docs ghi rõ nên parser phòng thủ nhiều lớp
 *   (JSON → text → không nhãn) và fake dùng shape hợp lý nhất.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_DETECTORS,
  DetectedEngineRegistry,
  KNOWN_ENGINE_KINDS,
  KiroCliProvider,
  createProvider,
} from '../packages/core/dist/index.js';
import { kiroCliOneShotArgs } from '../packages/core/dist/providers/cli/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-kiro-test-'));
  tempDirs.push(dir);
  return dir;
}

// Fake binary cần `node` trên PATH (shebang `#!/usr/bin/env node`).
const savedPath = process.env.PATH;
process.env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`;

const FAKE_ENV_KEYS = [
  'FAKE_KIRO_MODE',
  'FAKE_KIRO_AUTH',
  'FAKE_KIRO_ARGS_LOG',
  'FAKE_KIRO_ENV_DUMP',
];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  delete process.env.KIRO_HOME;
  delete process.env.KIRO_API_KEY;
  delete process.env.HIDDEN_TOKEN;
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

/**
 * Registry trỏ vào thư mục bin giả + home giả. Env được dựng từ đầu
 * (chỉ PATH) để biến môi trường thật trên máy chạy test không rò vào
 * kết quả detect.
 */
function registryFor(binDir, extra = {}) {
  const homeDir = extra.homeDir ?? makeTempDir();
  const env = {
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ...(extra.env ?? {}),
  };
  return new DetectedEngineRegistry({
    pathDirs: [binDir],
    homeDir,
    env,
    logger: { warn: () => undefined },
  });
}

function kiroProvider(binDir, opts = {}) {
  const dir = makeTempDir();
  return new KiroCliProvider(
    { id: 'kiro-cli', label: 'Kiro CLI', defaultModel: 'kiro-cli' },
    {
      binaryPath: path.join(binDir, 'kiro-cli'),
      cwd: dir,
      extraEnvAllowed: [
        'KIRO_HOME',
        'FAKE_KIRO_MODE',
        'FAKE_KIRO_ARGS_LOG',
        'FAKE_KIRO_ENV_DUMP',
      ],
      timeoutMs: 5_000,
      ...opts,
    },
  );
}

// --- Đăng ký ---------------------------------------------------------------

test('kiro v0.76: detector + provider đã đăng ký, 12 detector có sẵn', () => {
  assert.equal(BUILTIN_DETECTORS.length, 12);
  assert.ok(KNOWN_ENGINE_KINDS.includes('kiro'));
  assert.ok(BUILTIN_DETECTORS.some((d) => d.kind === 'kiro' && d.binaries.includes('kiro-cli')));
  // Chỉ dò `kiro-cli` — bí danh `kiro` có thể mở IDE nên không dò.
  const def = BUILTIN_DETECTORS.find((d) => d.kind === 'kiro');
  assert.deepEqual(def.binaries, ['kiro-cli']);
  const meta = PROVIDERS.find((m) => m.id === 'kiro-cli');
  assert.ok(meta);
  assert.equal(meta.kind, 'cli');
  assert.equal(meta.detectedKind, 'kiro');
  assert.equal(meta.needsKey, false);
  // createProvider không có binary → throw fail-closed.
  assert.throws(
    () => createProvider({ id: 'kiro-cli', label: 'kiro-cli', defaultModel: 'kiro-cli' }),
    /chưa có đường dẫn binary/,
  );
  // createProvider với binary giả → listModels trả đúng model id.
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  const provider = createProvider({
    id: 'kiro-cli',
    label: 'kiro-cli',
    defaultModel: 'kiro-cli',
    cliBinary: path.join(binDir, 'kiro-cli'),
  });
  return provider.listModels().then((models) => {
    assert.deepEqual(models, ['kiro-cli']);
    return provider.dispose?.();
  });
});

test('kiro v0.76: argv one-shot — prompt là đối số vị trí, không --input', () => {
  assert.deepEqual(kiroCliOneShotArgs('xin chào'), ['chat', '--no-interactive', 'xin chào']);
});

// --- Detector ---------------------------------------------------------------

test('kiro detector: available khi whoami --format json báo email', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const kiro = snap.engines['kiro'];
  assert.equal(kiro.status, 'available');
  assert.equal(kiro.version, '2.0.0');
  assert.equal(kiro.account?.label, 'alice@example.com');
  assert.equal(kiro.account?.method, 'oauth');
  assert.equal(kiro.enabled, false);
});

test('kiro detector: whoami lỗi (exit 1) → unavailable / not-signed-in', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  process.env.FAKE_KIRO_AUTH = 'fail';
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['kiro'].status, 'unavailable');
  assert.equal(snap.engines['kiro'].reason, 'not-signed-in');
});

test('kiro detector: JSON lỗi nhưng exit 0 → vẫn unavailable (từ chối qua text)', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  process.env.FAKE_KIRO_AUTH = 'json-error';
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['kiro'].status, 'unavailable');
  assert.equal(snap.engines['kiro'].reason, 'not-signed-in');
});

test('kiro detector: whoami in text (không JSON) → available, không rõ nhãn', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  process.env.FAKE_KIRO_AUTH = 'plain';
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const kiro = snap.engines['kiro'];
  assert.equal(kiro.status, 'available');
  assert.equal(kiro.account?.label, undefined);
});

test('kiro detector: không có binary → unavailable / not-installed', async () => {
  const { binDir } = makeBinDir(['fake-q.mjs', 'q']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['kiro'].status, 'unavailable');
  assert.equal(snap.engines['kiro'].reason, 'not-installed');
  // amazonq vẫn dò được bình thường (không lẫn binary).
  assert.equal(snap.engines['amazonq'].status, 'available');
});

// --- Driver -----------------------------------------------------------------

test('kiro driver: turn đơn giản qua chat --no-interactive, không --trust-all-tools', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  const dir = makeTempDir();
  const argsLog = path.join(dir, 'kiro-args.log');
  const events = [];
  const provider = kiroProvider(binDir, { onCliEvent: (e) => events.push(e) });
  process.env.FAKE_KIRO_ARGS_LOG = argsLog;
  const res = await provider.chat(chatReq('xin chào kiro', 'Bạn là trợ lý.'));
  assert.match(res.text, /Kiro reply to:/);
  assert.deepEqual(res.toolCalls, []);
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(events.some((e) => e.type === 'result'));
  const logged = readLines(argsLog).join(' ');
  assert.ok(logged.startsWith('chat --no-interactive'), logged);
  assert.ok(!logged.includes('--input'), logged);
  assert.ok(!logged.includes('--trust-all-tools'), logged);
  assert.ok(!logged.includes('--trust-tools'), logged);
  // Prompt gửi đi chứa system + user message (one-shot gửi toàn bộ).
  assert.ok(logged.includes('Bạn là trợ lý.'), logged);
  assert.ok(logged.includes('xin chào kiro'), logged);
  await provider.dispose();
});

test('kiro driver: lỗi exit != 0, output rỗng, timeout, abort', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);

  process.env.FAKE_KIRO_MODE = 'fail';
  const failing = kiroProvider(binDir);
  await assert.rejects(() => failing.chat(chatReq('x')), /mã 1.*Not logged in/);
  await failing.dispose();

  process.env.FAKE_KIRO_MODE = 'empty';
  const empty = kiroProvider(binDir);
  await assert.rejects(() => empty.chat(chatReq('x')), /không in ra text nào/);
  await empty.dispose();

  process.env.FAKE_KIRO_MODE = 'slow';
  const slow = kiroProvider(binDir, { timeoutMs: 300 });
  await assert.rejects(() => slow.chat(chatReq('x')), /hết thời gian chờ 300ms/);
  assert.equal(slow.isProcessAlive, false);
  await slow.dispose();

  const controller = new AbortController();
  const aborting = kiroProvider(binDir, { timeoutMs: 10_000 });
  const promise = aborting.chat({ ...chatReq('x'), signal: controller.signal });
  promise.catch(() => undefined);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, (err) => err.name === 'AbortError');
  assert.equal(aborting.isProcessAlive, false);
  await aborting.dispose();
  delete process.env.FAKE_KIRO_MODE;
});

test('kiro driver: KIRO_HOME được qua, KIRO_API_KEY + secret khác bị chặn', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  const dir = makeTempDir();
  const envDump = path.join(dir, 'kiro-env.json');
  process.env.KIRO_HOME = '/tmp/fake-kiro-home';
  process.env.KIRO_API_KEY = 'test-fake-key-kiro';
  process.env.HIDDEN_TOKEN = 'test-fake-hidden-token';
  process.env.FAKE_KIRO_ENV_DUMP = envDump;
  const provider = kiroProvider(binDir);
  await provider.chat(chatReq('kiểm tra env'));
  const dumped = readJson(envDump);
  assert.equal(dumped.KIRO_HOME, '/tmp/fake-kiro-home');
  assert.equal(dumped.KIRO_API_KEY, undefined);
  assert.equal(dumped.HIDDEN_TOKEN, undefined);
  await provider.dispose();
});

test('kiro driver: không user message / không binary / dispose đều lỗi rõ', async () => {
  const { binDir } = makeBinDir(['fake-kiro-cli.mjs', 'kiro-cli']);
  const provider = kiroProvider(binDir);
  await assert.rejects(
    () => provider.chat({ messages: [{ role: 'system', content: 'chỉ system' }], model: 'x' }),
    /không có user message/,
  );
  assert.throws(
    () =>
      new KiroCliProvider(
        { id: 'kiro-cli', label: 'K', defaultModel: 'kiro-cli' },
        { binaryPath: '' },
      ),
    /chưa có đường dẫn binary/,
  );
  await provider.dispose();
  await assert.rejects(() => provider.chat(chatReq('sau dispose')), /đã dispose/);
});
