/**
 * Tests for v0.98 router (Đội T2) — packages/core/src/router/
 * (targets.ts, history.ts, router.ts) + coordinator RPC router.*.
 *
 * Bao phủ:
 * - targets: discoverCliTargets (snapshot giả: available/disabled/
 *   custom-acp/windsurf-unknown), discoverApiTargets (chỉ provider
 *   API có key seed), buildAvailableTargets (khử trùng, lọc
 *   allow* và disabledProviders, default không bao giờ rơi).
 * - history: RouterDecisionStore (bền vững theo bot qua các instance,
 *   cap mỗi bot, clear theo bot/toàn bộ, botIds), computeRouterStats
 *   (tỉ lệ fallback, p50/p95, theo kind/provider, tiết kiệm),
 *   validateRouterConfigPatch (key lạ, sai kiểu, kẹp số, bất biến
 *   simpleMax <= complexMin, disabledProviders id lạ).
 * - ModelRouter: updateConfig (áp patch + kẹp), isTargetAllowed,
 *   route với đích CLI/API (prompt khó từ default local → CLI mạnh
 *   nhất; allowCli=false / disabledProviders đổi lựa chọn; prompt
 *   dễ vẫn về local), defaultTargetId + savingsUsd trên quyết định.
 * - RPC round-trip qua CoordinatorClient (tiến trình con thật):
 *   get/setConfig (patch sai bị từ chối, config cũ giữ nguyên),
 *   setApiKey/getApiKeyStatus (provider CLI bị từ chối, xoá key),
 *   getTargets (thấy đích API đã seed, không gọi live),
 *   getDecisions/getStats/clearLog.
 * - LIVE (Ollama local): bot ollama chạy turn thật → quyết định
 *   được ghi bền vững (getDecisions/getStats qua RPC thấy được,
 *   kể cả sau khi coordinator respawn); bot mock chạy turn → KHÔNG
 *   ghi quyết định nào (miễn trừ v0.96 còn nguyên).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/router-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { ModelRouter } from '../packages/core/dist/router/router.js';
import {
  discoverCliTargets,
  discoverApiTargets,
  buildAvailableTargets,
  compareCapable,
} from '../packages/core/dist/router/targets.js';
import {
  RouterDecisionStore,
  computeRouterStats,
  validateRouterConfigPatch,
  loadRouterConfigFile,
  saveRouterConfigFile,
} from '../packages/core/dist/router/history.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers: fake embedder/decision router (như tests/router-v096.test.mjs)
// ---------------------------------------------------------------------------

class HashEmbedder {
  dim = 128;
  tokenIndex(token) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    return h % this.dim;
  }
  vectorOf(text) {
    const vec = new Array(this.dim).fill(0);
    const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const t of tokens) vec[this.tokenIndex(t)] += 1;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
  async embed(text) {
    return this.vectorOf(text);
  }
  async embedBatch(texts) {
    return texts.map((t) => this.vectorOf(t));
  }
  async isAvailable() {
    return true;
  }
}

function makeRouter(overrides = {}, deps = {}) {
  return new ModelRouter(
    { layers: { structural: true, semantic: true, decision: true }, ...overrides },
    { embedder: new HashEmbedder(), decisionRouter: { decide: async () => null }, ...deps },
  );
}

const LOCAL = {
  id: 'ollama-local:qwen2.5:0.5b',
  providerId: 'ollama',
  model: 'qwen2.5:0.5b',
  kind: 'local',
  costPer1kUsd: 0,
  contextLimit: 4096,
};
const API_DEFAULT = {
  id: 'bot-default',
  providerId: 'openai',
  model: 'gpt-4o',
  kind: 'api',
  costPer1kUsd: 0.01,
  contextLimit: 128000,
};
const CLI_CLAUDE = {
  id: 'cli:claude-code',
  providerId: 'claude-code',
  model: 'claude-code',
  kind: 'cli',
  costPer1kUsd: 0,
  contextLimit: 200000,
  cliBinary: '/usr/local/bin/claude',
};
const API_GEMINI = {
  id: 'api:gemini',
  providerId: 'gemini',
  model: 'gemini-2.5-flash',
  kind: 'api',
  costPer1kUsd: 0.0025,
  contextLimit: 1000000,
};

const HARD_PROMPT =
  'Chứng minh định lý Pythagore từng bước, chính xác tuyệt đối, không được bỏ sót bước nào. ' +
  'Bạn phải trình bày bắt buộc theo thứ tự, ít nhất 5 bước, mỗi bước phải có phương trình và đạo hàm kèm theo. ' +
  'Phân tích độ phức tạp của thuật toán, tối ưu và suy luận quy nạp.';

// ---------------------------------------------------------------------------
// targets: discoverCliTargets
// ---------------------------------------------------------------------------

function fakeSnapshot(engines) {
  return { engines, detectedAt: new Date().toISOString() };
}

function fakeEngine(kind, over = {}) {
  return {
    kind,
    label: kind,
    binary: kind,
    binaryPath: `/usr/bin/${kind}`,
    version: '1.0.0',
    minVersion: '0.1.0',
    status: 'available',
    authMethod: 'cli-status',
    detectedAt: new Date().toISOString(),
    enabled: true,
    ...over,
  };
}

test('targets: discoverCliTargets chỉ lấy engine available + enabled + có binary', () => {
  const snapshot = fakeSnapshot({
    claude: fakeEngine('claude'),
    codex: fakeEngine('codex', { status: 'unavailable', reason: 'not-signed-in' }),
    grok: fakeEngine('grok', { enabled: false }),
    opencode: fakeEngine('opencode', { binaryPath: null }),
    gemini: fakeEngine('gemini', { status: 'unknown' }),
  });
  const targets = discoverCliTargets(snapshot);
  assert.deepEqual(
    targets.map((t) => t.providerId),
    ['claude-code'],
  );
  assert.equal(targets[0].kind, 'cli');
  assert.equal(targets[0].cliBinary, '/usr/bin/claude');
  assert.equal(targets[0].costPer1kUsd, 0);
});

test('targets: windsurf unknown + enabled vẫn được offer (như main providerConfigFor)', () => {
  const snapshot = fakeSnapshot({ windsurf: fakeEngine('windsurf', { status: 'unknown' }) });
  const targets = discoverCliTargets(snapshot);
  assert.deepEqual(targets.map((t) => t.providerId), ['windsurf']);
});

test('targets: custom-acp bị bỏ qua (snapshot không mang acpArgs)', () => {
  const snapshot = fakeSnapshot({
    'custom-acp:mycli': fakeEngine('custom-acp:mycli'),
    claude: fakeEngine('claude'),
  });
  assert.deepEqual(
    discoverCliTargets(snapshot).map((t) => t.providerId),
    ['claude-code'],
  );
});

test('targets: discoverCliTargets tôn trọng excludeProviderIds + snapshot rỗng', () => {
  const snapshot = fakeSnapshot({ claude: fakeEngine('claude') });
  assert.deepEqual(discoverCliTargets(snapshot, ['claude-code']), []);
  assert.deepEqual(discoverCliTargets(null), []);
  assert.deepEqual(discoverCliTargets({ engines: {} }), []);
});

// ---------------------------------------------------------------------------
// targets: discoverApiTargets + buildAvailableTargets
// ---------------------------------------------------------------------------

test('targets: discoverApiTargets chỉ lấy provider API có model mặc định', () => {
  const targets = discoverApiTargets(['openai', 'gemini', 'ollama', 'claude-code', 'nope', 'openai-compatible', 'xai']);
  assert.deepEqual(
    targets.map((t) => t.providerId),
    ['gemini', 'openai', 'xai'],
  );
  assert.ok(targets.every((t) => t.kind === 'api' && (t.costPer1kUsd ?? 0) > 0));
  assert.deepEqual(discoverApiTargets(['openai'], ['openai']), []);
});

test('targets: buildAvailableTargets khử trùng + lọc allow/disabled, default không rơi', () => {
  const targets = buildAvailableTargets({
    defaultTarget: API_DEFAULT,
    localTarget: LOCAL,
    cliTargets: [CLI_CLAUDE, { ...CLI_CLAUDE, id: 'cli:claude-code-2' }],
    apiTargets: [API_GEMINI, { ...API_DEFAULT, id: 'api:openai' }],
    allow: { local: true, cli: false, api: true },
    disabledProviders: ['gemini'],
  });
  // CLI bị allowCli=false loại; gemini bị disabled loại; openai trùng
  // default loại; còn default + local.
  assert.deepEqual(
    targets.map((t) => t.id),
    ['bot-default', 'ollama-local:qwen2.5:0.5b'],
  );
});

test('targets: buildAvailableTargets giữ default dù provider của nó bị disabled', () => {
  const targets = buildAvailableTargets({
    defaultTarget: API_DEFAULT,
    localTarget: LOCAL,
    disabledProviders: ['openai'],
  });
  assert.equal(targets[0].id, 'bot-default');
});

test('targets: compareCapable xếp context lớn trước, CLI trước API', () => {
  const sorted = [API_GEMINI, CLI_CLAUDE, API_DEFAULT].sort(compareCapable);
  assert.deepEqual(
    sorted.map((t) => t.providerId),
    ['gemini', 'claude-code', 'openai'],
  );
});

// ---------------------------------------------------------------------------
// history: validateRouterConfigPatch
// ---------------------------------------------------------------------------

test('history: validateRouterConfigPatch chấp nhận patch hợp lệ + kẹp số', () => {
  const { ok, config, errors } = validateRouterConfigPatch(
    { enabled: false, simpleMax: 2, complexMin: -1, decisionTimeoutMs: 99, layers: { semantic: false } },
    ['openai', 'gemini'],
  );
  assert.equal(ok, true, errors.join(' '));
  assert.equal(config.enabled, false);
  assert.equal(config.simpleMax, 1);
  assert.equal(config.complexMin, 0);
  assert.equal(config.decisionTimeoutMs, 500);
  assert.deepEqual(config.layers, { semantic: false });
});

test('history: validateRouterConfigPatch từ chối key lạ / sai kiểu', () => {
  const bad1 = validateRouterConfigPatch({ nope: true });
  assert.equal(bad1.ok, false);
  assert.match(bad1.errors.join(' '), /không rõ/);
  const bad2 = validateRouterConfigPatch({ enabled: 'yes' });
  assert.equal(bad2.ok, false);
  const bad3 = validateRouterConfigPatch({ simpleMax: 'high' });
  assert.equal(bad3.ok, false);
  const bad4 = validateRouterConfigPatch({ disabledProviders: ['nope'] }, ['openai']);
  assert.equal(bad4.ok, false);
  const bad5 = validateRouterConfigPatch({ ollamaBaseUrl: 'notaurl' });
  assert.equal(bad5.ok, false);
  const bad6 = validateRouterConfigPatch('hello');
  assert.equal(bad6.ok, false);
});

test('history: ngưỡng đảo simpleMax > complexMin vẫn chấp nhận (structural ưu tiên local ở giữa)', () => {
  const { ok, config } = validateRouterConfigPatch({ simpleMax: 0.8, complexMin: 0.2 });
  assert.equal(ok, true);
  assert.equal(config.simpleMax, 0.8);
  assert.equal(config.complexMin, 0.2);
});

// ---------------------------------------------------------------------------
// history: RouterDecisionStore + computeRouterStats
// ---------------------------------------------------------------------------

function fakeDecision(botId, target, layer, latencyMs, at, extra = {}) {
  return {
    target,
    layer,
    routeId: null,
    reason: 'test',
    latencyMs,
    pinned: false,
    fallbackLadder: [],
    at,
    botId,
    defaultTargetId: 'bot-default',
    savingsUsd: 0,
    ...extra,
  };
}

test('history: store bền vững theo bot qua các instance + cap + clear', () => {
  const dir = tmpDir('open-bot-router-store-');
  const store = new RouterDecisionStore({ dataDir: dir });
  store.append(fakeDecision('bot-a', LOCAL, 'structural', 3, 1000), 'bot-default');
  store.append(fakeDecision('bot-a', API_DEFAULT, 'default', 5, 2000), 'bot-default');
  store.append(fakeDecision('bot-b', CLI_CLAUDE, 'semantic', 9, 3000), 'bot-default');
  assert.equal(store.getDecisions('bot-a').length, 2);
  assert.equal(store.getDecisions('bot-a')[0].target.providerId, 'openai');
  assert.equal(store.getDecisions().length, 3);
  assert.deepEqual(store.botIds(), ['bot-b', 'bot-a']);

  // Instance mới cùng file đọc lại được.
  const store2 = new RouterDecisionStore({ dataDir: dir });
  assert.equal(store2.getDecisions('bot-a').length, 2);
  assert.equal(fs.existsSync(path.join(dir, 'router-decisions.json')), true);

  assert.equal(store2.clear('bot-a'), 2);
  assert.equal(store2.getDecisions('bot-a').length, 0);
  assert.equal(store2.getDecisions().length, 1);
  assert.equal(store2.clear(), 1);
  assert.equal(store2.getDecisions().length, 0);
});

test('history: store cap mỗi bot (chỉ giữ mới nhất)', () => {
  const dir = tmpDir('open-bot-router-cap-');
  const store = new RouterDecisionStore({ dataDir: dir, maxPerBot: 3 });
  for (let i = 0; i < 5; i++) {
    store.append(fakeDecision('bot-a', LOCAL, 'structural', 1, 1000 + i), 'bot-default');
  }
  const kept = store.getDecisions('bot-a');
  assert.equal(kept.length, 3);
  assert.equal(kept[0].at, 1004);
});

test('history: store file hỏng không throw, về rỗng', () => {
  const dir = tmpDir('open-bot-router-bad-');
  fs.writeFileSync(path.join(dir, 'router-decisions.json'), '{ broken json', 'utf-8');
  const store = new RouterDecisionStore({ dataDir: dir });
  assert.equal(store.getDecisions().length, 0);
  assert.equal(store.append(fakeDecision('bot-a', LOCAL, 'structural', 1, 1000)), true);
  assert.equal(store.getDecisions().length, 1);
});

test('history: computeRouterStats — fallback, p50/p95, theo kind/provider, tiết kiệm', () => {
  const entries = [
    { target: LOCAL, layer: 'structural', latencyMs: 2, pinned: false, at: 1, botId: 'b', defaultTargetId: 'bot-default', savingsUsd: 0.01 },
    { target: API_DEFAULT, layer: 'default', latencyMs: 4, pinned: false, at: 2, botId: 'b', defaultTargetId: 'bot-default', savingsUsd: 0 },
    { target: CLI_CLAUDE, layer: 'semantic', latencyMs: 10, pinned: true, at: 3, botId: 'b', defaultTargetId: 'bot-default', savingsUsd: 0 },
    { target: API_GEMINI, layer: 'decision', latencyMs: 20, pinned: false, at: 4, botId: 'b', savingsUsd: 0 },
  ];
  const stats = computeRouterStats(entries);
  assert.equal(stats.totalDecisions, 4);
  assert.equal(stats.localTurns, 1);
  assert.equal(stats.cloudTurns, 3);
  assert.equal(stats.cliTurns, 1);
  assert.equal(stats.apiTurns, 2);
  assert.equal(stats.pinnedTurns, 1);
  assert.equal(stats.decisionsByLayer.structural, 1);
  assert.equal(stats.decisionsByProvider.ollama, 1);
  assert.equal(stats.decisionsByProvider['claude-code'], 1);
  // Fallback: 2/3 quyết định biết default rời khỏi default (local +
  // cli); quyết định thứ 4 không biết default nên không tính.
  assert.equal(stats.fallbackTurns, 2);
  assert.ok(Math.abs(stats.fallbackRate - 2 / 3) < 1e-9);
  assert.equal(stats.avgLatencyMs, 9);
  assert.equal(stats.latencyP50Ms, 4);
  assert.equal(stats.latencyP95Ms, 20);
  assert.ok(Math.abs(stats.estimatedSavingsUsd - 0.01) < 1e-9);

  const empty = computeRouterStats([]);
  assert.equal(empty.totalDecisions, 0);
  assert.equal(empty.fallbackRate, 0);
  assert.equal(empty.latencyP50Ms, 0);
});

test('history: save/load router-config file (round-trip + file hỏng → null)', () => {
  const dir = tmpDir('open-bot-router-cfg-');
  assert.equal(loadRouterConfigFile(dir), null);
  assert.equal(saveRouterConfigFile(dir, { enabled: false, simpleMax: 0.2 }), true);
  const loaded = loadRouterConfigFile(dir);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.simpleMax, 0.2);
  fs.writeFileSync(path.join(dir, 'router-config.json'), '{"enabled": "yes"}', 'utf-8');
  assert.equal(loadRouterConfigFile(dir), null);
});

// ---------------------------------------------------------------------------
// ModelRouter: updateConfig / isTargetAllowed / route CLI+API
// ---------------------------------------------------------------------------

test('router: updateConfig áp patch + kẹp + isTargetAllowed tôn trọng allow/disabled', () => {
  const router = makeRouter();
  const effective = router.updateConfig({ simpleMax: 5, allowCli: false, disabledProviders: ['gemini'] });
  assert.equal(effective.simpleMax, 1);
  assert.equal(effective.allowCli, false);
  assert.deepEqual(effective.disabledProviders, ['gemini']);
  assert.equal(router.isTargetAllowed(CLI_CLAUDE), false);
  assert.equal(router.isTargetAllowed(API_GEMINI), false);
  assert.equal(router.isTargetAllowed(API_DEFAULT), true);
  // Default luôn được phép dù provider bị disabled / kind bị tắt.
  assert.equal(router.isTargetAllowed(API_GEMINI, true), true);
  const again = router.updateConfig({ allowCli: true, disabledProviders: [] });
  assert.equal(again.allowCli, true);
  assert.equal(router.isTargetAllowed(CLI_CLAUDE), true);
});

test('router: route prompt khó từ default local → CLI mạnh nhất (context lớn nhất)', async () => {
  const router = makeRouter();
  const decision = await router.route({
    text: HARD_PROMPT,
    botId: 'bot-1',
    defaultTarget: { ...LOCAL, id: 'bot-default' },
    availableTargets: [
      { ...LOCAL, id: 'bot-default' },
      CLI_CLAUDE,
      API_GEMINI,
    ],
  });
  assert.equal(decision.target.providerId, 'gemini');
  assert.equal(decision.layer, 'structural');
  assert.equal(decision.defaultTargetId, 'bot-default');
});

test('router: allowCli=false thì prompt khó đi API; disabledProviders đổi lựa chọn', async () => {
  const router = makeRouter({ allowCli: false });
  const decision = await router.route({
    text: HARD_PROMPT,
    botId: 'bot-1',
    defaultTarget: { ...LOCAL, id: 'bot-default' },
    availableTargets: [{ ...LOCAL, id: 'bot-default' }, CLI_CLAUDE, API_GEMINI],
  });
  assert.equal(decision.target.providerId, 'gemini');

  const router2 = makeRouter({ disabledProviders: ['gemini'] });
  const decision2 = await router2.route({
    text: HARD_PROMPT,
    botId: 'bot-1',
    defaultTarget: { ...LOCAL, id: 'bot-default' },
    availableTargets: [{ ...LOCAL, id: 'bot-default' }, CLI_CLAUDE, API_GEMINI],
  });
  assert.equal(decision2.target.providerId, 'claude-code');
});

test('router: prompt dễ vẫn về local dù có đích CLI/API', async () => {
  const router = makeRouter();
  const decision = await router.route({
    text: 'xong',
    botId: 'bot-1',
    defaultTarget: { ...LOCAL, id: 'bot-default' },
    availableTargets: [{ ...LOCAL, id: 'bot-default' }, CLI_CLAUDE, API_GEMINI],
  });
  assert.equal(decision.target.kind, 'local');
  assert.equal(decision.layer, 'structural');
});

test('router: default API thì prompt khó giữ default (đã mạnh), fallback ladder có CLI/API', async () => {
  const router = makeRouter();
  const decision = await router.route({
    text: HARD_PROMPT,
    botId: 'bot-1',
    defaultTarget: API_DEFAULT,
    availableTargets: [API_DEFAULT, LOCAL, CLI_CLAUDE, API_GEMINI],
  });
  assert.equal(decision.target.providerId, 'openai');
  assert.ok(decision.fallbackLadder.some((t) => t.kind === 'cli'));
  assert.ok(decision.fallbackLadder.some((t) => t.providerId === 'gemini'));
});

// ---------------------------------------------------------------------------
// RPC round-trip qua CoordinatorClient (tiến trình con thật)
// ---------------------------------------------------------------------------

let client;
let dataDir;
test.before(async () => {
  dataDir = tmpDir('open-bot-router-rpc-');
  client = new CoordinatorClient({
    env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
    // Turn live Ollama trên máy 1,5 CPU (đang tải vì nhiều đội chạy
    // song song) có thể > 5 phút — timeout mặc định 300s sẽ cắt giữa
    // chừng dù coordinator vẫn chạy tốt.
    requestTimeoutMs: 900_000,
  });
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});
test.after(async () => {
  await client.dispose();
});

test('rpc: getRouterConfig mặc định + setRouterConfig round-trip + patch sai bị từ chối', async () => {
  const before = await client.getRouterConfig();
  assert.equal(before.enabled, true);
  assert.equal(before.allowCli, true);
  assert.deepEqual(before.disabledProviders, []);

  const updated = await client.setRouterConfig({ enabled: false, simpleMax: 0.25 });
  assert.equal(updated.enabled, false);
  assert.equal(updated.simpleMax, 0.25);
  const again = await client.getRouterConfig();
  assert.equal(again.enabled, false);

  await assert.rejects(() => client.setRouterConfig({ nope: true }), /không hợp lệ|không rõ/);
  await assert.rejects(() => client.setRouterConfig({ enabled: 'yes' }), /không hợp lệ/);
  const kept = await client.getRouterConfig();
  assert.equal(kept.enabled, false, 'patch sai không được đổi config cũ');

  // Bền vững: file router-config.json đã ghi.
  assert.equal(fs.existsSync(path.join(dataDir, 'router-config.json')), true);
  await client.setRouterConfig({ enabled: true });
});

test('rpc: setRouterApiKey / getApiKeyStatus (CLI bị từ chối, xoá key)', async () => {
  const r1 = await client.setRouterApiKey('gemini', 'test-key-123');
  assert.deepEqual(r1.configured, ['gemini']);
  const r2 = await client.setRouterApiKey('openai', 'test-key-456');
  assert.deepEqual(r2.configured, ['gemini', 'openai']);
  const status = await client.getRouterApiKeyStatus();
  assert.deepEqual(status.configured, ['gemini', 'openai']);
  await assert.rejects(() => client.setRouterApiKey('claude-code', 'x'), /không phải provider API/);
  await assert.rejects(() => client.setRouterApiKey('ollama', 'x'), /không phải provider API/);
  await assert.rejects(() => client.setRouterApiKey('nope', 'x'), /không phải provider API/);
  const r3 = await client.setRouterApiKey('gemini', null);
  assert.deepEqual(r3.configured, ['openai']);
  await client.setRouterApiKey('openai', null);
});

test('rpc: getRouterTargets thấy đích API đã seed (không gọi live)', async () => {
  await client.setRouterApiKey('gemini', 'test-key-123');
  const targets = await client.getRouterTargets();
  assert.ok(targets.api.some((t) => t.providerId === 'gemini' && t.kind === 'api'));
  assert.equal(typeof targets.discoveredAt, 'number');
  assert.ok(Array.isArray(targets.cliStatus));
  await client.setRouterApiKey('gemini', null);
  const after = await client.getRouterTargets();
  assert.equal(after.api.some((t) => t.providerId === 'gemini'), false);
});

test('rpc: getDecisions/getStats/clearLog ban đầu rỗng', async () => {
  const decisions = await client.getRouterDecisions();
  assert.deepEqual(decisions.decisions, []);
  assert.equal(decisions.total, 0);
  const stats = await client.getRouterStats();
  assert.equal(stats.totalDecisions, 0);
  assert.equal(stats.fallbackRate, 0);
  const cleared = await client.clearRouterLog();
  assert.equal(cleared.cleared, 0);
});

// ---------------------------------------------------------------------------
// LIVE: Ollama thật — turn ghi quyết định bền vững; mock không ghi gì
// ---------------------------------------------------------------------------

async function ollamaUp() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function ollamaBotConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'ollama',
    model: 'qwen2.5:0.5b',
    systemPrompt: 'You are a test bot. Answer in one short sentence.',
    workspaceDir,
    autoApprove: true,
  };
}

test('live: bot ollama chạy turn thật → quyết định ghi bền vững, RPC thấy được', async (t) => {
  if (!(await ollamaUp())) {
    t.skip('Ollama không chạy — bỏ qua test live');
    return;
  }
  const ws = tmpDir('open-bot-router-live-');
  await client.createBot({
    bot: ollamaBotConfig('router-live-1', ws),
    provider: { id: 'ollama', defaultModel: 'qwen2.5:0.5b' },
  });
  const result = await client.run('router-live-1', 'xong', () => {});
  assert.equal(result.stopped, false);
  assert.ok(typeof result.text === 'string' && result.text.length > 0);

  const decisions = await client.getRouterDecisions({ botId: 'router-live-1' });
  assert.ok(decisions.total >= 1, `phải có >= 1 quyết định, có ${decisions.total}`);
  assert.equal(decisions.decisions[0].botId, 'router-live-1');
  assert.equal(decisions.decisions[0].target.providerId, 'ollama');
  const stats = await client.getRouterStats({ botId: 'router-live-1' });
  assert.ok(stats.totalDecisions >= 1);
  assert.equal(stats.localTurns, stats.totalDecisions);
  assert.equal(stats.fallbackRate, 0);

  // Bền vững trên đĩa: file decisions đã ghi.
  const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'router-decisions.json'), 'utf-8'));
  assert.ok(Array.isArray(file.bots['router-live-1']) && file.bots['router-live-1'].length >= 1);

  const cleared = await client.clearRouterLog({ botId: 'router-live-1' });
  assert.ok(cleared.cleared >= 1);
  const after = await client.getRouterDecisions({ botId: 'router-live-1' });
  assert.equal(after.total, 0);
});

test('live: bot mock chạy turn → KHÔNG ghi quyết định nào (miễn trừ v0.96)', async (t) => {
  if (!(await ollamaUp())) {
    t.skip('Ollama không chạy — bỏ qua test live');
    return;
  }
  const ws = tmpDir('open-bot-router-mock-');
  await client.createBot({
    bot: {
      id: 'router-mock-1',
      name: 'Bot router-mock-1',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: ws,
      autoApprove: true,
    },
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
  });
  const result = await client.run('router-mock-1', 'xong', () => {});
  assert.equal(result.text, 'mock ok');
  const decisions = await client.getRouterDecisions({ botId: 'router-mock-1' });
  assert.equal(decisions.total, 0, 'bot mock không được route nên không có quyết định');
});
