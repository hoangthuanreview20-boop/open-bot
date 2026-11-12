/**
 * Tests cho v0.90b (đội G) — model picker hoàn thiện: tắt nguồn theo
 * từng bot + nút quét lại trong picker.
 *
 * - Mục 1 (5 engine mới Aider/Continue/Copilot/Amazon Q/Windsurf):
 *   KHÔNG có code mới — test này chứng minh chúng ĐÃ hiện trên rail
 *   (provider + driver từ M4 sóng B, rail dựng từ PROVIDERS): snapshot
 *   có 5 engine available → 5 entry usable, chọn được, nguồn account.
 * - Mục 2 (tắt nguồn theo từng bot): `filterRailForBot` +
 *   `cleanDisabledProviders` (packages/core/src/models/rail.ts) và
 *   `sanitizeConfig` giữ `disabledProviders`
 *   (packages/core/src/agent/marketplace.ts).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/model-picker-v090b.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: rail test dùng snapshot giả; secret giả chỉ sống trong
 * closure của `hasApiKey` (trả boolean) để chứng minh rail không thể
 * chứa secret — không bao giờ được truyền vào rail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProviderRail,
  cleanDisabledProviders,
  filterRailForBot,
  sanitizeConfig,
} from '../packages/core/dist/index.js';
import { PROVIDERS } from '../packages/core/dist/providers/index.js';

const LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok CLI',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  cursor: 'Cursor CLI',
  aider: 'Aider',
  continue: 'Continue',
  copilot: 'GitHub Copilot CLI',
  amazonq: 'Amazon Q CLI',
  windsurf: 'Windsurf',
  kiro: 'Kiro CLI',
};

/** Snapshot giả: mọi engine available + đã đăng nhập + đang bật. */
function engineSnapshot(overrides = {}) {
  const engines = {};
  for (const kind of Object.keys(LABELS)) {
    engines[kind] = {
      kind,
      label: LABELS[kind],
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
  aider: ['aider'],
  'continue-cli': ['continue-cli'],
  'amazon-q': ['amazon-q'],
  'copilot-cli': ['copilot-cli'],
  windsurf: ['windsurf'],
  'kiro-cli': ['kiro-cli'],
};

/** Fake secret chỉ sống trong closure boolean — rail không bao giờ thấy giá trị. */
const FAKE_SECRET = 'sk-fake-secret-12345-never-in-rail';
const KEYED = new Set(['openai', 'anthropic', 'gemini', 'xai']);

function railFor(snapshot) {
  return buildProviderRail({
    providers: PROVIDERS,
    engines: snapshot,
    modelsByProvider: MODELS,
    hasApiKey: (id) => {
      const secret = FAKE_SECRET;
      return secret.length > 0 && KEYED.has(id);
    },
    isConfigured: () => false,
  });
}

// ---------------------------------------------------------------------------
// Mục 1 — 5 engine mới đã hiện trên rail (không code mới, chỉ chứng minh)
// ---------------------------------------------------------------------------

test('v0.90b item 1: 5 engine mới (Aider/Continue/Copilot/Amazon Q/Windsurf) hiện trên rail, usable khi available', () => {
  const rail = railFor(engineSnapshot());
  for (const [providerId, detectedKind] of [
    ['aider', 'aider'],
    ['continue-cli', 'continue'],
    ['copilot-cli', 'copilot'],
    ['amazon-q', 'amazonq'],
    ['windsurf', 'windsurf'],
  ]) {
    const entry = rail.entries.find((e) => e.providerId === providerId);
    assert.ok(entry, `rail phải có entry ${providerId}`);
    assert.equal(entry.status, 'usable', `${providerId} usable khi engine available + bật`);
    assert.equal(entry.selectable, true, `${providerId} chọn được`);
    assert.equal(entry.sourceKind, 'account', `${providerId} chạy qua tài khoản CLI`);
    assert.equal(entry.detectedKind, detectedKind, `${providerId} gắn đúng detector`);
    assert.equal(entry.group, 'subscription', `${providerId} nằm nhóm subscription`);
    assert.equal(entry.accountLabel, 'alice@example.com', `${providerId} hiện nhãn tài khoản, không secret`);
  }
  // Chưa cài thì vẫn hiện (mờ, lý do rõ) — không biến mất khỏi picker.
  const missing = railFor(engineSnapshot({ aider: { status: 'unavailable', reason: 'not-installed', binaryPath: null, version: null, account: undefined } }));
  const aider = missing.entries.find((e) => e.providerId === 'aider');
  assert.equal(aider.status, 'unavailable');
  assert.equal(aider.reason, 'not-installed');
  assert.equal(aider.selectable, false);
});

// ---------------------------------------------------------------------------
// Mục 2 — filterRailForBot
// ---------------------------------------------------------------------------

test('v0.90b filter: không tắt gì → trả rail gốc, không gợi ý', () => {
  const rail = railFor(engineSnapshot());
  for (const disabled of [undefined, []]) {
    const out = filterRailForBot(rail, disabled, 'xai');
    assert.equal(out.rail, rail, 'không copy thừa khi không có gì bị tắt');
    assert.equal(out.currentDisabled, false);
    assert.equal(out.suggestion, null);
  }
});

test('v0.90b filter: nguồn tắt (không phải model hiện tại) bị ẩn khỏi picker của bot', () => {
  const rail = railFor(engineSnapshot());
  const out = filterRailForBot(rail, ['openai', 'claude-code', 'ollama'], 'xai');
  assert.equal(out.currentDisabled, false);
  assert.equal(out.suggestion, null);
  const ids = out.rail.entries.map((e) => e.providerId);
  assert.ok(!ids.includes('openai'), 'openai bị ẩn');
  assert.ok(!ids.includes('claude-code'), 'claude-code bị ẩn');
  assert.ok(!ids.includes('ollama'), 'ollama bị ẩn');
  assert.ok(ids.includes('xai'), 'provider hiện tại vẫn hiện');
  assert.ok(ids.includes('anthropic'), 'provider không tắt vẫn hiện');
  // Nhóm được dựng lại đúng (không còn entry đã ẩn trong groups).
  for (const group of ['subscription', 'api', 'custom']) {
    for (const e of out.rail.groups[group]) {
      assert.ok(!['openai', 'claude-code', 'ollama'].includes(e.providerId));
      assert.equal(e.group, group);
    }
    assert.deepEqual(
      out.rail.groups[group].map((e) => e.providerId),
      out.rail.entries.filter((e) => e.group === group).map((e) => e.providerId),
    );
  }
});

test('v0.90b filter: nguồn của model đang chạy bị tắt → giữ lại mờ + lý do bot-disabled + gợi ý thay thế, KHÔNG tự đổi', () => {
  const rail = railFor(engineSnapshot());
  const out = filterRailForBot(rail, ['xai', 'openai'], 'xai');
  assert.equal(out.currentDisabled, true);
  const current = out.rail.entries.find((e) => e.providerId === 'xai');
  assert.ok(current, 'provider hiện tại vẫn hiện để báo rõ, không biến mất');
  assert.equal(current.status, 'unavailable');
  assert.equal(current.selectable, false);
  assert.equal(current.reason, 'bot-disabled');
  // Các entry tắt khác thì ẩn.
  assert.ok(!out.rail.entries.some((e) => e.providerId === 'openai'));
  // Gợi ý: entry chọn được đầu tiên khác provider hiện tại.
  assert.ok(out.suggestion, 'có gợi ý thay thế');
  assert.equal(out.suggestion.selectable, true);
  assert.notEqual(out.suggestion.providerId, 'xai');
  const expected = out.rail.entries.find((e) => e.selectable && e.providerId !== 'xai');
  assert.equal(out.suggestion.providerId, expected.providerId);
  assert.ok(typeof out.suggestion.defaultModel === 'string' && out.suggestion.defaultModel.length > 0);
});

test('v0.90b filter: mọi nguồn đều tắt → chỉ còn model hiện tại (mờ), không gợi ý', () => {
  const rail = railFor(engineSnapshot());
  const allIds = rail.entries.map((e) => e.providerId);
  const out = filterRailForBot(rail, allIds, 'xai');
  assert.equal(out.currentDisabled, true);
  assert.equal(out.suggestion, null);
  assert.deepEqual(
    out.rail.entries.map((e) => e.providerId),
    ['xai'],
  );
  assert.equal(out.rail.entries[0].reason, 'bot-disabled');
});

test('v0.90b filter: id lạ trong danh sách tắt bị bỏ qua; không truyền provider hiện tại thì entry tắt bị ẩn luôn', () => {
  const rail = railFor(engineSnapshot());
  const out = filterRailForBot(rail, ['xai', 'provider-khong-co-that'], undefined);
  assert.equal(out.currentDisabled, false);
  assert.equal(out.suggestion, null);
  assert.ok(!out.rail.entries.some((e) => e.providerId === 'xai'), 'xai bị ẩn khi không phải current');
  assert.ok(out.rail.entries.some((e) => e.providerId === 'openai'), 'provider khác không bị ẩn nhầm');
  const untouched = filterRailForBot(rail, ['provider-khong-co-that'], 'xai');
  assert.equal(untouched.rail.entries.length, rail.entries.length);
  assert.equal(untouched.currentDisabled, false);
});

// ---------------------------------------------------------------------------
// cleanDisabledProviders
// ---------------------------------------------------------------------------

test('v0.90b clean: chỉ giữ id đã biết, bỏ chuỗi lạ/không phải chuỗi/rỗng, gộp trùng, giữ thứ tự', () => {
  const known = PROVIDERS.map((p) => p.id);
  assert.deepEqual(
    cleanDisabledProviders(['xai', 'openai', 'xai', 'provider-la', '', 42, null, 'ollama'], known),
    ['xai', 'openai', 'ollama'],
  );
  assert.deepEqual(cleanDisabledProviders(undefined, known), []);
  assert.deepEqual(cleanDisabledProviders('xai', known), []);
  assert.deepEqual(cleanDisabledProviders(['provider-la'], known), []);
});

// ---------------------------------------------------------------------------
// sanitizeConfig giữ disabledProviders (clone/publish/install)
// ---------------------------------------------------------------------------

test('v0.90b sanitize: clone giữ disabledProviders như denyTools/denySkills, copy mảng mới', () => {
  const config = {
    id: 'bot-1',
    name: 'Bot',
    providerId: 'xai',
    model: 'grok-4.7',
    systemPrompt: '',
    workspaceDir: '',
    autoApprove: false,
    denyTools: ['shell_exec'],
    denySkills: ['skill-a'],
    disabledProviders: ['openai', 'claude-code'],
  };
  const clean = sanitizeConfig(config);
  assert.deepEqual(clean.disabledProviders, ['openai', 'claude-code']);
  assert.deepEqual(clean.denyTools, ['shell_exec']);
  assert.deepEqual(clean.denySkills, ['skill-a']);
  // Copy mảng mới: đổi mảng gốc không ảnh hưởng bản đã sanitize.
  config.disabledProviders.push('ollama');
  assert.deepEqual(clean.disabledProviders, ['openai', 'claude-code']);
  // Entry lạ/rỗng bị lược; rỗng thì bỏ field (tương đương không tắt gì).
  const dirty = sanitizeConfig({ ...config, disabledProviders: ['xai', '', 7, 'ollama'] });
  assert.deepEqual(dirty.disabledProviders, ['xai', 'ollama']);
  const empty = sanitizeConfig({ ...config, disabledProviders: [] });
  assert.equal(empty.disabledProviders, undefined);
  const missing = sanitizeConfig({ ...config, disabledProviders: undefined });
  assert.equal(missing.disabledProviders, undefined);
});
