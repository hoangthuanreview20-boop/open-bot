/**
 * Tests cho M4 — Model picker + provider rail + engine status UI +
 * đổi model giữa chừng không mất thread
 * (packages/core/src/models/rail.ts,
 *  packages/core/src/coordinator/coordinator.ts switchModel,
 *  packages/core/src/detected/registry.ts redetectOne).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/model-picker-m4.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: rail test dùng snapshot giả; switchModel test dùng mock
 * provider + fake `claude` trong tests/fixtures/ (như M1); redetectOne
 * test dùng fake binary + thư mục tạm. Secret giả chỉ xuất hiện trong
 * closure của `hasApiKey` (trả boolean) để chứng minh rail không thể
 * chứa secret — không bao giờ được truyền vào rail.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentCoordinator,
  buildProviderRail,
  sourceLabelText,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';
import { DetectedEngineRegistry } from '../packages/core/dist/detected/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const fixturesDir = path.join(here, 'fixtures');

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m4-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitUntil(fn, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

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

// ---------------------------------------------------------------------------
// Rail helpers
// ---------------------------------------------------------------------------

/** Snapshot giả: engine nào cũng available + đã đăng nhập + đang bật. */
function engineSnapshot(overrides = {}) {
  const kinds = ['claude', 'codex', 'grok', 'opencode', 'gemini', 'cursor'];
  const labels = {
    claude: 'Claude Code',
    codex: 'Codex',
    grok: 'Grok CLI',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
    cursor: 'Cursor CLI',
  };
  const engines = {};
  for (const kind of kinds) {
    engines[kind] = {
      kind,
      label: labels[kind],
      binary: kind === 'cursor' ? 'cursor-agent' : kind,
      binaryPath: `/usr/bin/${kind}`,
      version: '2.0.0',
      minVersion: '1.0.0',
      status: 'available',
      account: { label: 'alice@example.com', method: 'subscription' },
      authMethod: 'cli-status',
      detectedAt: new Date().toISOString(),
      enabled: true,
      ...(overrides[kind] ?? {}),
    };
  }
  return { engines, detectedAt: new Date().toISOString() };
}

const MODELS = {
  openai: ['gpt-5', 'gpt-5-nano'],
  anthropic: ['claude-opus-4-5'],
  gemini: ['gemini-2.5-flash'],
  xai: ['grok-4.7'],
  ollama: ['qwen2.5:0.5b'],
  'openai-compatible': ['deepseek-chat'],
  'claude-code': ['claude-code'],
  codex: ['codex'],
  'grok-cli': ['grok-cli'],
  opencode: ['opencode'],
  'gemini-cli': ['gemini-cli'],
  'cursor-cli': ['cursor-cli'],
  'custom-acp': ['custom-acp'],
};

/** Fake secret chỉ sống trong closure boolean — rail không bao giờ thấy giá trị. */
const FAKE_SECRET = 'sk-fake-secret-12345-never-in-rail';
const KEYED = new Set(['openai', 'anthropic', 'gemini', 'xai']);

function railFor(snapshot, extra = {}) {
  return buildProviderRail({
    providers: PROVIDERS,
    engines: snapshot,
    modelsByProvider: MODELS,
    hasApiKey: (id) => {
      // Đọc secret thật (giả) ở đây nhưng chỉ trả boolean — rail
      // không có đường nào nhận giá trị secret.
      const secret = FAKE_SECRET;
      return secret.length > 0 && KEYED.has(id) && (extra.keyed ?? KEYED).has(id);
    },
    isConfigured: (id) => extra.configured?.includes(id) ?? false,
  });
}

// ---------------------------------------------------------------------------
// Rail: nhóm 3 rail
// ---------------------------------------------------------------------------

test('M4 rail: 3 nhóm subscription / api / custom đúng thành viên', () => {
  const rail = railFor(engineSnapshot());
  const sub = rail.groups.subscription.map((e) => e.providerId);
  assert.deepEqual(
    [...sub].sort(),
    [
      'aider',
      'amazon-q',
      'claude-code',
      'codex',
      'continue-cli',
      'copilot-cli',
      'cursor-cli',
      'gemini-cli',
      'grok-cli',
      'kiro-cli',
      'opencode',
      'windsurf',
    ].sort(),
  );
  assert.deepEqual(
    [...rail.groups.api.map((e) => e.providerId)].sort(),
    ['anthropic', 'gemini', 'ollama', 'openai', 'xai'].sort(),
  );
  assert.deepEqual(
    [...rail.groups.custom.map((e) => e.providerId)].sort(),
    ['custom-acp', 'openai-compatible'].sort(),
  );
  // Thứ tự nhóm: subscription → api → custom.
  const order = rail.entries.map((e) => e.group);
  const firstApi = order.indexOf('api');
  const firstCustom = order.indexOf('custom');
  assert.ok(order.slice(0, firstApi).every((g) => g === 'subscription'));
  assert.ok(order.slice(firstApi, firstCustom).every((g) => g === 'api'));
  assert.ok(order.slice(firstCustom).every((g) => g === 'custom'));
});

test('M4 rail: API provider thiếu key thì mờ + lý do no-api-key; đủ key thì usable', () => {
  const noKey = railFor(engineSnapshot(), { keyed: new Set() });
  const openai = noKey.groups.api.find((e) => e.providerId === 'openai');
  assert.equal(openai.status, 'unavailable');
  assert.equal(openai.selectable, false);
  assert.equal(openai.reason, 'no-api-key');

  const withKey = railFor(engineSnapshot());
  const openai2 = withKey.groups.api.find((e) => e.providerId === 'openai');
  assert.equal(openai2.status, 'usable');
  assert.equal(openai2.selectable, true);
  assert.equal(openai2.sourceKind, 'api-key');
});

test('M4 rail: ollama usable không cần key, nguồn local; openai-compatible chưa cấu hình thì mờ', () => {
  const rail = railFor(engineSnapshot());
  const ollama = rail.groups.api.find((e) => e.providerId === 'ollama');
  assert.equal(ollama.status, 'usable');
  assert.equal(ollama.sourceKind, 'local');
  const compat = rail.groups.custom.find((e) => e.providerId === 'openai-compatible');
  assert.equal(compat.status, 'unavailable');
  assert.equal(compat.reason, 'not-configured');
  assert.equal(compat.selectable, false);

  const configured = railFor(engineSnapshot(), { configured: ['openai-compatible'] });
  assert.equal(
    configured.groups.custom.find((e) => e.providerId === 'openai-compatible').status,
    'usable',
  );
});

test('M4 rail: CLI tắt opt-in thì disabled + lý do; chưa đăng nhập thì unavailable + lý do', () => {
  const snap = engineSnapshot({
    claude: { enabled: false },
    codex: { status: 'unavailable', reason: 'not-signed-in', account: undefined },
    grok: { status: 'unavailable', reason: 'not-installed', binaryPath: null, version: null, account: undefined },
  });
  const rail = railFor(snap);
  const claude = rail.groups.subscription.find((e) => e.providerId === 'claude-code');
  assert.equal(claude.status, 'disabled');
  assert.equal(claude.reason, 'disabled');
  assert.equal(claude.selectable, false);
  const codex = rail.groups.subscription.find((e) => e.providerId === 'codex');
  assert.equal(codex.status, 'unavailable');
  assert.equal(codex.reason, 'not-signed-in');
  assert.equal(codex.selectable, false);
  const grok = rail.groups.subscription.find((e) => e.providerId === 'grok-cli');
  assert.equal(grok.reason, 'not-installed');
});

test('M4 rail: CLI available + bật thì usable kèm nhãn tài khoản; snapshot null thì unavailable', () => {
  const rail = railFor(engineSnapshot());
  const claude = rail.groups.subscription.find((e) => e.providerId === 'claude-code');
  assert.equal(claude.status, 'usable');
  assert.equal(claude.accountLabel, 'alice@example.com');
  assert.equal(claude.accountMethod, 'subscription');
  assert.deepEqual(claude.models, ['claude-code']);

  const none = railFor(null);
  for (const e of none.groups.subscription) {
    assert.equal(e.status, 'unavailable');
    assert.equal(e.reason, 'not-installed');
    assert.equal(e.selectable, false);
  }
});

test('M4 rail: custom ACP unknown thì selectable kèm lý do unknown-status, models là slug', () => {
  const snap = engineSnapshot();
  snap.engines['custom-acp:my-agent'] = {
    kind: 'custom-acp:my-agent',
    label: 'My Agent',
    binary: 'my-agent',
    binaryPath: '/usr/local/bin/my-agent',
    version: '1.2.3',
    minVersion: '',
    status: 'unknown',
    reasonDetail: 'CLI tuỳ chỉnh không khai lệnh kiểm tra đăng nhập.',
    authMethod: 'none',
    detectedAt: new Date().toISOString(),
    enabled: true,
  };
  snap.engines['custom-acp:other'] = {
    kind: 'custom-acp:other',
    label: 'Other',
    binary: 'other',
    binaryPath: '/usr/local/bin/other',
    version: null,
    minVersion: '',
    status: 'available',
    account: { label: 'bob@example.com', method: 'oauth' },
    authMethod: 'cli-status',
    detectedAt: new Date().toISOString(),
    enabled: true,
  };
  const rail = railFor(snap);
  const custom = rail.groups.custom.find((e) => e.providerId === 'custom-acp');
  assert.equal(custom.selectable, true);
  assert.deepEqual(custom.models, ['my-agent', 'other']);
  assert.equal(custom.defaultModel, 'my-agent');

  // Không có CLI tuỳ chỉnh nào → custom-acp mờ.
  const empty = railFor(engineSnapshot());
  const customEmpty = empty.groups.custom.find((e) => e.providerId === 'custom-acp');
  assert.equal(customEmpty.selectable, false);
  assert.equal(customEmpty.status, 'unavailable');
});

test('M4 rail: sắp xếp trong nhóm — usable trước, unavailable cuối, cùng trạng thái thì theo tên', () => {
  const snap = engineSnapshot({
    claude: { status: 'unavailable', reason: 'not-signed-in', account: undefined },
    cursor: { enabled: false },
  });
  const rail = railFor(snap);
  const sub = rail.groups.subscription;
  const ranks = sub.map((e) => e.status);
  const firstUnavailable = ranks.indexOf('unavailable');
  const firstDisabled = ranks.indexOf('disabled');
  // Thứ tự: usable (0) → unknown (1) → disabled (2) → unavailable (3).
  assert.ok(firstDisabled > 0 && firstUnavailable > firstDisabled);
  assert.ok(ranks.slice(0, firstDisabled).every((s) => s === 'usable'));
  const usableLabels = sub.filter((e) => e.status === 'usable').map((e) => e.label);
  assert.deepEqual(usableLabels, [...usableLabels].sort());
});

test('M4 rail: nhãn nguồn không chứa secret — key chỉ đi qua boolean, nhãn tài khoản chỉ là email', () => {
  const rail = railFor(engineSnapshot());
  const dump = JSON.stringify(rail);
  assert.ok(!dump.includes(FAKE_SECRET), 'rail JSON không được chứa giá trị secret giả');
  assert.ok(dump.includes('alice@example.com'), 'nhãn tài khoản (email) được giữ trong rail');
  const openai = rail.groups.api.find((e) => e.providerId === 'openai');
  assert.equal(sourceLabelText(openai), 'OpenAI · API key (Vault)');
  assert.ok(!sourceLabelText(openai).includes(FAKE_SECRET));
  const claude = rail.groups.subscription.find((e) => e.providerId === 'claude-code');
  assert.equal(sourceLabelText(claude), 'Claude Code (CLI) · alice@example.com');
  const ollama = rail.groups.api.find((e) => e.providerId === 'ollama');
  assert.equal(sourceLabelText(ollama), 'Ollama (local) · Local');
});

// ---------------------------------------------------------------------------
// switchModel (coordinator in-process, mock provider)
// ---------------------------------------------------------------------------

function makeCoordinator(botId, dir, botOverrides = {}) {
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    emit: () => undefined,
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock-old',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
    ...botOverrides,
  };
  return {
    coordinator,
    bot,
    async createBot(providerOverrides = {}) {
      await coordinator.createBot({
        bot,
        provider: {
          id: 'mock',
          label: 'Mock',
          defaultModel: 'mock-old',
          mockResponses: [{ text: 'from-old' }],
          ...providerOverrides,
        },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Best-effort cleanup.
      }
      coordinator.shutdown();
    },
  };
}

test('M4 switchModel: đổi lúc rảnh áp dụng ngay, run sau dùng provider mới, history giữ nguyên', async () => {
  const dir = makeTempDir();
  const setup = makeCoordinator('bot-switch-idle', dir);
  try {
    await setup.createBot();
    await setup.coordinator.saveMessage({ botId: 'bot-switch-idle', role: 'user', content: 'nhớ giúp tôi: mã số 42' });
    await setup.coordinator.saveMessage({ botId: 'bot-switch-idle', role: 'assistant', content: 'đã nhớ mã số 42' });
    const res = setup.coordinator.switchModel({
      botId: 'bot-switch-idle',
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new', mockResponses: [{ text: 'from-new' }] },
    });
    assert.equal(res.applied, true);
    assert.equal(res.pending, false);
    assert.equal(res.running, false);
    assert.equal(res.providerId, 'mock');
    assert.equal(res.model, 'mock-new');
    // History trong BotMemory còn nguyên sau switch.
    const history = setup.coordinator.getHistory({ botId: 'bot-switch-idle', limit: 10 });
    assert.deepEqual(
      history.messages.map((m) => m.content),
      ['nhớ giúp tôi: mã số 42', 'đã nhớ mã số 42'],
    );
    // Run sau dùng provider mới.
    const run = await setup.coordinator.run({ botId: 'bot-switch-idle', text: 'hi' });
    assert.equal(run.text, 'from-new');
    // Task/plan không bị đụng: history sau run vẫn có đủ 2 tin cũ + 2 tin mới của run.
    const after = setup.coordinator.getHistory({ botId: 'bot-switch-idle', limit: 10 });
    assert.ok(after.messages.length >= 2);
    assert.equal(after.messages[0].content, 'nhớ giúp tôi: mã số 42');
  } finally {
    await setup.destroy();
  }
});

test('M4 switchModel: qua RPC handle() cũng áp dụng (đường CoordinatorClient đi qua)', async () => {
  const dir = makeTempDir();
  const setup = makeCoordinator('bot-switch-rpc', dir);
  try {
    await setup.createBot();
    const res = await setup.coordinator.handle('switchModel', {
      botId: 'bot-switch-rpc',
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-rpc', mockResponses: [{ text: 'from-rpc' }] },
    });
    assert.equal(res.applied, true);
    const run = await setup.coordinator.run({ botId: 'bot-switch-rpc', text: 'hi' });
    assert.equal(run.text, 'from-rpc');
  } finally {
    await setup.destroy();
  }
});

test('M4 switchModel: validate fail-closed — provider lạ, model rỗng, CLI thiếu binary, bot lạ', async () => {
  const dir = makeTempDir();
  const setup = makeCoordinator('bot-switch-validate', dir);
  try {
    await setup.createBot();
    assert.throws(
      () =>
        setup.coordinator.switchModel({
          botId: 'bot-switch-validate',
          provider: { id: 'nope', label: 'Nope', defaultModel: 'x' },
        }),
      /không rõ provider/,
    );
    assert.throws(
      () =>
        setup.coordinator.switchModel({
          botId: 'bot-switch-validate',
          provider: { id: 'mock', label: 'Mock', defaultModel: '   ' },
        }),
      /defaultModel không rỗng/,
    );
    assert.throws(
      () =>
        setup.coordinator.switchModel({
          botId: 'bot-switch-validate',
          provider: { id: 'claude-code', label: 'Claude Code (CLI)', defaultModel: 'claude-code' },
        }),
      /cần cliBinary/,
    );
    assert.throws(
      () =>
        setup.coordinator.switchModel({
          botId: 'bot-khong-co',
          provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new' },
        }),
      /Chưa tạo bot/,
    );
    // Bot vẫn chạy bằng provider cũ sau các lần switch lỗi.
    const run = await setup.coordinator.run({ botId: 'bot-switch-validate', text: 'hi' });
    assert.equal(run.text, 'from-old');
  } finally {
    await setup.destroy();
  }
});

test('M4 switchModel: đang chạy thì pending — run cũ chạy hết bằng model cũ, run sau dùng model mới', async () => {
  const dir = makeTempDir();
  const recordPath = path.join(dir, 'mock-calls.jsonl');
  const setup = makeCoordinator('bot-switch-pending', dir);
  try {
    await setup.createBot({
      mockResponses: [{ text: 'from-old', delayMs: 400 }],
      mockRecordPath: recordPath,
    });
    const runPromise = setup.coordinator.run({ botId: 'bot-switch-pending', text: 'chạy lâu' });
    // Chờ mock provider thật sự nhận chat (run đang chạy) rồi mới switch.
    assert.ok(
      await waitUntil(() => fs.existsSync(recordPath) && fs.statSync(recordPath).size > 0),
      'mock phải bắt đầu chat trước khi switch',
    );
    const res = setup.coordinator.switchModel({
      botId: 'bot-switch-pending',
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new', mockResponses: [{ text: 'from-new' }] },
    });
    assert.equal(res.applied, false);
    assert.equal(res.pending, true);
    assert.equal(res.running, true);
    // Run đang chạy KHÔNG bị ngắt, vẫn trả text của provider cũ.
    const first = await runPromise;
    assert.equal(first.text, 'from-old');
    assert.equal(first.stopped, false);
    // Run kế tiếp áp dụng model mới (pending tiêu thụ ở đầu run).
    const second = await setup.coordinator.run({ botId: 'bot-switch-pending', text: 'hi again' });
    assert.equal(second.text, 'from-new');
  } finally {
    await setup.destroy();
  }
});

test('M4 switchModel: pending bị huỷ khi bot bị xoá — tạo lại bot thì chạy bằng provider cũ', async () => {
  const dir = makeTempDir();
  const recordPath = path.join(dir, 'mock-calls.jsonl');
  const setup = makeCoordinator('bot-switch-destroy', dir);
  try {
    await setup.createBot({
      mockResponses: [{ text: 'from-old', delayMs: 400 }],
      mockRecordPath: recordPath,
    });
    const runPromise = setup.coordinator.run({ botId: 'bot-switch-destroy', text: 'chạy lâu' });
    assert.ok(
      await waitUntil(() => fs.existsSync(recordPath) && fs.statSync(recordPath).size > 0),
      'mock phải bắt đầu chat trước khi switch',
    );
    const res = setup.coordinator.switchModel({
      botId: 'bot-switch-destroy',
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new', mockResponses: [{ text: 'from-new' }] },
    });
    assert.equal(res.pending, true);
    await setup.coordinator.destroyBot({ botId: 'bot-switch-destroy' });
    await runPromise.catch(() => undefined);
    // Tạo lại cùng bot id (cùng workspace/BotMemory): pending đã hết,
    // bot chạy bằng provider truyền lúc tạo lại.
    await setup.createBot();
    const run = await setup.coordinator.run({ botId: 'bot-switch-destroy', text: 'hi' });
    assert.equal(run.text, 'from-old');
  } finally {
    await setup.destroy();
  }
});

test('M4 switchModel: đổi từ claude-code sang mock thì process CLI cũ chết (kể cả khi bọc MeteredProvider)', async () => {
  const dir = makeTempDir();
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  // Wrapper shell ghi pid rồi `exec` fake-claude (cùng pid): env
  // FAKE_CLAUDE_PID_FILE bị sanitize ở tầng driver nên không dùng được
  // qua coordinator — pid ghi thẳng trong wrapper, không qua env.
  const pidFile = path.join(dir, 'pid');
  const wrapper = path.join(binDir, 'claude-wrapped');
  const fixture = path.join(fixturesDir, 'fake-claude.mjs');
  fs.writeFileSync(wrapper, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec ${process.execPath} ${JSON.stringify(fixture)} "$@"\n`, 'utf8');
  fs.chmodSync(wrapper, 0o755);
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    emit: () => undefined,
  });
  const botId = 'bot-switch-claude';
  const bot = {
    id: botId,
    name: 'Bot Claude',
    providerId: 'claude-code',
    model: 'claude-code',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
  const usageStorePath = path.join(dir, 'usage.json');
  try {
    await coordinator.createBot({
      bot,
      provider: {
        id: 'claude-code',
        label: 'Claude Code (CLI)',
        defaultModel: 'claude-code',
        cliBinary: wrapper,
      },
      usageStorePath,
    });
    const run = await coordinator.run({ botId, text: 'hi claude' });
    assert.match(run.text, /Fake reply to: hi claude/);
    assert.ok(await waitUntil(() => fs.existsSync(pidFile)), 'fake claude phải spawn và ghi pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0 && isAlive(pid), 'fake process phải đang sống trước khi switch');
    const res = coordinator.switchModel({
      botId,
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock-new', mockResponses: [{ text: 'from-new' }] },
      usageStorePath,
    });
    assert.equal(res.applied, true);
    assert.ok(
      await waitUntil(() => !isAlive(pid), 5000),
      'process CLI cũ phải chết sau switch (dispose qua MeteredProvider unwrap)',
    );
    const after = await coordinator.run({ botId, text: 'hi mock' });
    assert.equal(after.text, 'from-new');
  } finally {
    try {
      await coordinator.destroyBot({ botId });
    } catch {
      // Best-effort cleanup.
    }
    coordinator.shutdown();
  }
});

// ---------------------------------------------------------------------------
// redetectOne (registry)
// ---------------------------------------------------------------------------

test('M4 redetectOne: chỉ quét lại một engine, engine khác giữ nguyên', async () => {
  const { binDir } = makeBinDir(
    ['fake-claude.mjs', 'claude'],
    ['fake-codex.mjs', 'codex'],
  );
  const registry = registryFor(binDir);
  const first = await registry.detect();
  assert.equal(first.engines['claude'].version, '2.1.318');
  assert.equal(first.engines['codex'].status, 'available');
  const codexDetectedAt = first.engines['codex'].detectedAt;

  // Fake claude đổi version; chỉ redetect claude.
  process.env.FAKE_CLAUDE_VERSION = 'claude/9.9.9 (Fake)';
  const second = await registry.redetectOne('claude');
  assert.equal(second.engines['claude'].version, '9.9.9');
  assert.equal(second.engines['codex'].detectedAt, codexDetectedAt, 'engine khác không bị quét lại');
  assert.equal(second.engines['codex'].status, 'available');
});

test('M4 redetectOne: kind lạ thì throw; detector lỗi chỉ thành unavailable, không throw', async () => {
  const { binDir } = makeBinDir(['fake-claude.mjs', 'claude']);
  const registry = registryFor(binDir);
  await registry.detect();
  await assert.rejects(registry.redetectOne('khong-co'), /Không rõ nguồn/);
  // Fake auth fail → redetectOne trả unavailable, không throw.
  process.env.FAKE_CLAUDE_AUTH = 'fail';
  const snap = await registry.redetectOne('claude');
  assert.equal(snap.engines['claude'].status, 'unavailable');
  assert.equal(snap.engines['claude'].reason, 'not-signed-in');
});
