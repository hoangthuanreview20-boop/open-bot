/**
 * Tests cho sóng B (đội platform) — 5 detector CLI mới: Aider, Continue,
 * GitHub Copilot CLI, Amazon Q CLI, Windsurf
 * (packages/core/src/detected/).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/detected-cli-b-platform.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật: mọi CLI
 * trong test đều là fake script trong tests/fixtures/ được copy vào thư
 * mục tạm và tìm qua `pathDirs`; home giả cũng là thư mục tạm. Biến môi
 * trường API key trong test chỉ là chuỗi giả ('test-fake-key-...') —
 * snapshot không bao giờ được chứa giá trị key (test cuối kiểm tra).
 *
 * Cơ chế từng detector (xem detected/definitions.ts):
 * - Aider: kiểu 'env-present' — chỉ kiểm tra TÊN biến môi trường có
 *   tồn tại không, không đọc giá trị.
 * - Continue: file `~/.continue/config.yaml` có tồn tại không.
 * - Copilot CLI: hỏi `gh auth status` (fake-gh.mjs) vì chính CLI
 *   không có lệnh status.
 * - Amazon Q CLI: `q whoami` (fake-q.mjs).
 * - Windsurf: kiểu 'none' → trạng thái 'unknown' (không bịa là đã
 *   đăng nhập).
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
} from '../packages/core/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-b-platform-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FAKE_GH_') || key.startsWith('FAKE_Q_')) delete process.env[key];
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

/**
 * Registry trỏ vào thư mục bin giả + home giả. Env được dựng từ đầu
 * (chỉ PATH + các biến test truyền vào) để biến môi trường thật trên
 * máy chạy test (vd OPENAI_API_KEY thật) không rò vào kết quả detect.
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

test('B-platform detectors: 12 detector có sẵn, KNOWN_ENGINE_KINDS đủ 6 kind mới (5 sóng B + Kiro v0.76)', () => {
  assert.equal(BUILTIN_DETECTORS.length, 12);
  for (const kind of ['aider', 'continue', 'copilot', 'amazonq', 'windsurf', 'kiro']) {
    assert.ok(KNOWN_ENGINE_KINDS.includes(kind), kind);
    assert.ok(BUILTIN_DETECTORS.some((d) => d.kind === kind), kind);
  }
});

test('B-platform detector: aider available khi có API key trong env, nhãn chỉ nêu họ key', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const registry = registryFor(binDir, { env: { OPENAI_API_KEY: 'test-fake-key-openai' } });
  const snap = await registry.detect();
  const aider = snap.engines['aider'];
  assert.equal(aider.status, 'available');
  assert.equal(aider.version, '0.86.2');
  assert.equal(aider.account?.label, 'OpenAI API key');
  assert.equal(aider.account?.method, 'api-key');
  assert.equal(aider.authMethod, 'env-present');
  assert.equal(aider.enabled, false);
  // Snapshot không bao giờ chứa giá trị key.
  assert.ok(!JSON.stringify(snap).includes('test-fake-key-openai'));
});

test('B-platform detector: aider ưu tiên biến đầu tiên trong danh sách, không có key thì not-signed-in', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const withTwo = registryFor(binDir, {
    env: { ANTHROPIC_API_KEY: 'test-fake-key-anthropic', DEEPSEEK_API_KEY: 'test-fake-key-deepseek' },
  });
  const snapTwo = await withTwo.detect();
  assert.equal(snapTwo.engines['aider'].status, 'available');
  assert.equal(snapTwo.engines['aider'].account?.label, 'Anthropic API key');

  const withoutKey = registryFor(binDir);
  const snapNone = await withoutKey.detect();
  assert.equal(snapNone.engines['aider'].status, 'unavailable');
  assert.equal(snapNone.engines['aider'].reason, 'not-signed-in');
  // Biến rỗng (chỉ khoảng trắng) không tính là có key.
  const withBlank = registryFor(binDir, { env: { OPENAI_API_KEY: '   ' } });
  const snapBlank = await withBlank.detect();
  assert.equal(snapBlank.engines['aider'].status, 'unavailable');
});

test('B-platform detector: continue available khi ~/.continue/config.yaml tồn tại', async () => {
  const homeDir = makeTempDir();
  fs.mkdirSync(path.join(homeDir, '.continue'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.continue', 'config.yaml'), 'models: []\n', 'utf8');
  const { binDir } = makeBinDir(['fake-cn.mjs', 'cn']);
  const registry = registryFor(binDir, { homeDir });
  const snap = await registry.detect();
  const cont = snap.engines['continue'];
  assert.equal(cont.status, 'available');
  assert.equal(cont.version, '1.5.47');
  assert.equal(cont.account?.method, 'api-key');
  assert.equal(cont.authMethod, 'file-exists');

  const noConfig = registryFor(binDir);
  const snapNone = await noConfig.detect();
  assert.equal(snapNone.engines['continue'].status, 'unavailable');
  assert.equal(snapNone.engines['continue'].reason, 'not-signed-in');
});

test('B-platform detector: copilot available khi gh báo đã đăng nhập, nhãn là username GitHub', async () => {
  const { binDir } = makeBinDir(
    ['fake-copilot.mjs', 'copilot'],
    ['fake-gh.mjs', 'gh'],
  );
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const copilot = snap.engines['copilot'];
  assert.equal(copilot.status, 'available');
  assert.equal(copilot.version, '1.0.88');
  assert.equal(copilot.account?.label, 'octocat');
  assert.equal(copilot.account?.method, 'oauth');
  assert.equal(copilot.authMethod, 'cli-status');
});

test('B-platform detector: copilot not-signed-in khi gh lỗi hoặc khi không có gh', async () => {
  process.env.FAKE_GH_AUTH = 'fail';
  const { binDir } = makeBinDir(
    ['fake-copilot.mjs', 'copilot'],
    ['fake-gh.mjs', 'gh'],
  );
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  assert.equal(snap.engines['copilot'].status, 'unavailable');
  assert.equal(snap.engines['copilot'].reason, 'not-signed-in');
  assert.equal(snap.engines['copilot'].version, '1.0.88');

  delete process.env.FAKE_GH_AUTH;
  const { binDir: binDirNoGh } = makeBinDir(['fake-copilot.mjs', 'copilot']);
  const registryNoGh = registryFor(binDirNoGh);
  const snapNoGh = await registryNoGh.detect();
  assert.equal(snapNoGh.engines['copilot'].status, 'unavailable');
  assert.equal(snapNoGh.engines['copilot'].reason, 'not-signed-in');
});

test('B-platform detector: amazonq available khi q whoami báo đã đăng nhập', async () => {
  const { binDir } = makeBinDir(['fake-q.mjs', 'q']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const amazonq = snap.engines['amazonq'];
  assert.equal(amazonq.status, 'available');
  assert.equal(amazonq.version, '1.19.7');
  assert.equal(amazonq.account?.label, 'alice@example.com');
  assert.equal(amazonq.account?.method, 'oauth');

  process.env.FAKE_Q_AUTH = 'fail';
  const registryFail = registryFor(binDir);
  const snapFail = await registryFail.detect();
  assert.equal(snapFail.engines['amazonq'].status, 'unavailable');
  assert.equal(snapFail.engines['amazonq'].reason, 'not-signed-in');
});

test('B-platform detector: windsurf có binary thì trạng thái unknown (không bịa là đã đăng nhập)', async () => {
  const { binDir } = makeBinDir(['fake-windsurf.mjs', 'windsurf']);
  const registry = registryFor(binDir);
  const snap = await registry.detect();
  const windsurf = snap.engines['windsurf'];
  assert.equal(windsurf.status, 'unknown');
  assert.equal(windsurf.version, '1.2.3');
  assert.equal(windsurf.authMethod, 'none');
  assert.equal(windsurf.enabled, false);

  const noBinary = registryFor(binDir);
  const snapNone = await noBinary.detect();
  // Các kind mới chưa cài đều unavailable / not-installed.
  for (const kind of ['aider', 'continue', 'copilot', 'amazonq']) {
    assert.equal(snapNone.engines[kind].status, 'unavailable', kind);
    assert.equal(snapNone.engines[kind].reason, 'not-installed', kind);
  }
});

test('B-platform detector: opt-in bật/tắt được cho từng nguồn mới', async () => {
  const { binDir } = makeBinDir(['fake-aider.mjs', 'aider']);
  const registry = registryFor(binDir, { env: { OPENAI_API_KEY: 'test-fake-key-openai' } });
  await registry.detect();
  assert.equal(registry.isEnabled('aider'), false);
  registry.setEnabled('aider', true);
  assert.equal(registry.isEnabled('aider'), true);
  assert.equal(registry.snapshot().engines['aider'].enabled, true);
  registry.setEnabled('aider', false);
  assert.equal(registry.isEnabled('aider'), false);
});
