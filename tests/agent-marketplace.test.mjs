/**
 * agent-marketplace.test.mjs — v0.3 agent templates + local marketplace.
 * Run: node --test tests/agent-marketplace.test.mjs (after building core)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createBotConfigFromTemplate,
  getTemplate,
  listBuiltInTemplates,
} from '../packages/core/dist/agent/templates.js';
import {
  cloneAgent,
  getPublished,
  installPublished,
  listPublished,
  publishAgent,
  sanitizeConfig,
  uninstallPublished,
} from '../packages/core/dist/agent/marketplace.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-marketplace-'));
}

const BASE_BOT = {
  id: 'bot-1',
  name: 'Trợ lý',
  providerId: 'xai',
  model: 'grok-4.7',
  systemPrompt: 'Bạn là trợ lý.',
  workspaceDir: '/some/workspace',
  autoApprove: false,
};

// --- templates -------------------------------------------------------------

test('templates: exactly 20 built-in templates with distinct ids/categories', () => {
  const templates = listBuiltInTemplates();
  assert.equal(templates.length, 20);
  const ids = templates.map((t) => t.id).sort();
  assert.deepEqual(ids, [
    'automation',
    'code',
    'code-reviewer',
    'competitor-analysis',
    'content-creator',
    'data',
    'devops-helper',
    'email-assistant',
    'file-organizer',
    'finance-tracker',
    'general',
    'meeting-notes',
    'news-digest',
    'project-manager',
    'research',
    'test-writer',
    'translator',
    'triage',
    'tutor',
    'writing',
  ]);
  const categories = new Set(templates.map((t) => t.category));
  assert.equal(categories.size, 6, 'triage shares the general category, so 20 templates / 6 categories');
  for (const t of templates) {
    assert.ok(t.name.trim().length > 0, `${t.id} needs a name`);
    assert.ok(t.description.trim().length > 0, `${t.id} needs a description`);
    assert.ok(t.systemPrompt.trim().length > 0, `${t.id} needs a system prompt`);
    if (t.id === 'triage') {
      // v0.12: triage has no static tools by design — transfer_to_* tools
      // are generated dynamically per coordinator bot list.
      assert.deepEqual(t.suggestedTools, []);
      continue;
    }
    assert.ok(Array.isArray(t.suggestedTools) && t.suggestedTools.length > 0, `${t.id} needs suggested tools`);
    assert.ok(t.suggestedTools.every((s) => typeof s === 'string' && s.length > 0));
  }
});

test('templates: 13 new templates (team C) exist with valid categories, prompts and tools', () => {
  const expected = [
    ['code-reviewer', 'code'],
    ['test-writer', 'code'],
    ['devops-helper', 'code'],
    ['competitor-analysis', 'research'],
    ['news-digest', 'research'],
    ['translator', 'writing'],
    ['email-assistant', 'writing'],
    ['content-creator', 'writing'],
    ['meeting-notes', 'writing'],
    ['finance-tracker', 'data'],
    ['file-organizer', 'automation'],
    ['project-manager', 'general'],
    ['tutor', 'general'],
  ];
  const validCategories = new Set(['code', 'research', 'writing', 'data', 'automation', 'general']);
  // Tool names already used by the built-in templates in templates.ts.
  const knownTools = new Set([
    'read_file',
    'write_file',
    'list_files',
    'glob_files',
    'grep_search',
    'shell_exec',
    'git_status',
    'git_diff',
    'git_commit',
    'web_search',
    'web_fetch',
    'http_get',
    'x_search',
    'apply_diff',
    'code_diagnostics',
    'semantic_search',
  ]);
  const all = listBuiltInTemplates();
  assert.equal(new Set(all.map((t) => t.id)).size, all.length, 'template ids must be unique');
  for (const [id, category] of expected) {
    const t = getTemplate(id);
    assert.ok(t, `${id} must exist via getTemplate()`);
    assert.equal(t.category, category, `${id} must be in category ${category}`);
    assert.ok(validCategories.has(t.category), `${id} has an invalid category`);
    assert.ok(t.name.trim().length > 0, `${id} needs a name`);
    assert.ok(t.description.trim().length > 0, `${id} needs a description`);
    assert.ok(t.systemPrompt.trim().length > 0, `${id} needs a system prompt`);
    assert.ok(
      Array.isArray(t.suggestedTools) && t.suggestedTools.length > 0,
      `${id} needs non-empty suggestedTools`,
    );
    for (const tool of t.suggestedTools) {
      assert.equal(typeof tool, 'string', `${id} tool names must be strings`);
      assert.ok(!/\s/.test(tool), `${id} tool name must not contain whitespace: ${tool}`);
      assert.ok(knownTools.has(tool), `${id} uses unknown tool ${tool}`);
    }
    assert.equal(t.model, undefined, `${id} must not hard-code a model`);
    assert.equal(t.providerId, 'xai', `${id} must use provider xai`);
  }
});

test('templates: getTemplate returns a copy; unknown id returns undefined', () => {
  const code = getTemplate('code');
  assert.ok(code);
  assert.equal(code.id, 'code');
  assert.ok(code.suggestedTools.includes('read_file'));
  assert.ok(code.suggestedTools.includes('git_status'));
  code.name = 'MUTATED';
  code.suggestedTools.push('nope');
  assert.notEqual(getTemplate('code').name, 'MUTATED', 'list/get must return copies');
  assert.ok(!getTemplate('code').suggestedTools.includes('nope'));
  assert.equal(getTemplate('khong-co'), undefined);
});

test('templates: built-in templates carry no hard-coded model', () => {
  // v0.8: the model comes from the model registry at creation time, never
  // from a hard-coded name in the template (see docs/v05-worker1-integration.md §5.2).
  for (const t of listBuiltInTemplates()) {
    assert.equal(t.model, undefined, `${t.id} must not hard-code a model`);
  }
});

test('templates: createBotConfigFromTemplate fills fields, new id, empty workspace', () => {
  const tpl = getTemplate('research');
  const bot = createBotConfigFromTemplate(tpl);
  assert.equal(bot.name, tpl.name);
  assert.equal(bot.providerId, tpl.providerId);
  // No template model and no registry getter: model stays '' and main
  // fills it from the registry at bots:create time.
  assert.equal(bot.model, '');
  assert.equal(bot.systemPrompt, tpl.systemPrompt);
  assert.ok(bot.id && bot.id !== tpl.id, 'bot gets a fresh id');
  assert.equal(bot.workspaceDir, '', 'workspace must be empty (main assigns per-bot dir)');
  assert.equal(bot.autoApprove, false);

  const bot2 = createBotConfigFromTemplate(tpl, { name: 'Nghiên cứu của tôi', model: 'other-model' });
  assert.equal(bot2.name, 'Nghiên cứu của tôi');
  assert.equal(bot2.model, 'other-model');
  assert.notEqual(bot2.id, bot.id, 'two bots from one template get different ids');
});

test('templates: createBotConfigFromTemplate resolves the model from the registry getter', () => {
  const tpl = getTemplate('code');
  const registry = (providerId) => (providerId === 'xai' ? 'registry-model' : '');
  const bot = createBotConfigFromTemplate(tpl, {}, { getDefaultModel: registry });
  assert.equal(bot.model, 'registry-model', 'registry default fills the empty template model');
  // Explicit override wins over the registry.
  const bot2 = createBotConfigFromTemplate(tpl, { model: 'override-model' }, { getDefaultModel: registry });
  assert.equal(bot2.model, 'override-model');
  // A template that names its own model wins over the registry.
  const withModel = { ...tpl, model: 'template-model' };
  const bot3 = createBotConfigFromTemplate(withModel, {}, { getDefaultModel: registry });
  assert.equal(bot3.model, 'template-model');
  // A throwing getter never breaks bot creation: model falls back to ''.
  const bot4 = createBotConfigFromTemplate(tpl, {}, {
    getDefaultModel: () => {
      throw new Error('no registry');
    },
  });
  assert.equal(bot4.model, '');
});

// --- marketplace -----------------------------------------------------------

test('marketplace: publish/list/get round-trip on a temp dir', () => {
  const dir = tmpDir();
  assert.deepEqual(listPublished(dir), [], 'empty marketplace at first');
  const entry = publishAgent(dir, BASE_BOT, { author: 'Huy', description: 'Bot trợ lý chung' });
  assert.ok(entry.id);
  assert.equal(entry.name, 'Trợ lý');
  assert.equal(entry.author, 'Huy');
  assert.equal(entry.description, 'Bot trợ lý chung');
  assert.equal(entry.installs, 0);
  assert.ok(entry.createdAt);
  assert.deepEqual(getPublished(dir, entry.id).config, {
    ...BASE_BOT,
    workspaceDir: '/some/workspace',
  });
  assert.equal(listPublished(dir).length, 1);
  // File really lives at <baseDir>/marketplace/agents.json.
  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, 'marketplace', 'agents.json'), 'utf-8'),
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'Trợ lý');
});

test('marketplace: publish never leaks extra fields / API keys', () => {
  const dir = tmpDir();
  const dirty = {
    ...BASE_BOT,
    apiKey: 'sk-SECRET-DO-NOT-STORE',
    token: 'also-secret',
    password: 'hunter2',
  };
  const entry = publishAgent(dir, dirty);
  const stored = JSON.parse(
    fs.readFileSync(path.join(dir, 'marketplace', 'agents.json'), 'utf-8'),
  );
  const blob = JSON.stringify(stored);
  assert.ok(!blob.includes('sk-SECRET-DO-NOT-STORE'), 'apiKey must not be stored');
  assert.ok(!blob.includes('also-secret'));
  assert.ok(!blob.includes('hunter2'));
  assert.deepEqual(Object.keys(entry.config).sort(), [
    'autoApprove',
    'id',
    'model',
    'name',
    'providerId',
    'systemPrompt',
    'workspaceDir',
  ]);
  // sanitizeConfig alone also strips unknown fields.
  assert.deepEqual(Object.keys(sanitizeConfig(dirty)).sort(), Object.keys(entry.config).sort());
});

test('marketplace: install returns a fresh bot + bumps installs; unknown id throws', () => {
  const dir = tmpDir();
  const entry = publishAgent(dir, BASE_BOT, { author: 'Huy' });
  const installed = installPublished(dir, entry.id);
  assert.notEqual(installed.id, BASE_BOT.id, 'install gets a new id');
  assert.notEqual(installed.id, entry.config.id);
  assert.equal(installed.name, BASE_BOT.name);
  assert.equal(installed.systemPrompt, BASE_BOT.systemPrompt);
  assert.equal(installed.workspaceDir, '', 'install must not reuse the original workspace');
  assert.equal(getPublished(dir, entry.id).installs, 1);
  installPublished(dir, entry.id);
  assert.equal(getPublished(dir, entry.id).installs, 2);
  assert.throws(() => installPublished(dir, 'khong-co'), /Không tìm thấy/);
});

test('marketplace: re-publish same bot updates entry, keeps id/installs', () => {
  const dir = tmpDir();
  const first = publishAgent(dir, BASE_BOT, { author: 'Huy', description: 'v1' });
  installPublished(dir, first.id);
  const second = publishAgent(dir, { ...BASE_BOT, name: 'Trợ lý v2' }, { description: 'v2' });
  assert.equal(second.id, first.id);
  assert.equal(second.name, 'Trợ lý v2');
  assert.equal(second.description, 'v2');
  assert.equal(second.installs, 1, 'install count survives re-publish');
  assert.equal(listPublished(dir).length, 1);
});

test('marketplace: uninstall removes entry, returns false for unknown id', () => {
  const dir = tmpDir();
  const entry = publishAgent(dir, BASE_BOT);
  assert.equal(uninstallPublished(dir, 'khong-co'), false);
  assert.equal(uninstallPublished(dir, entry.id), true);
  assert.deepEqual(listPublished(dir), []);
  assert.equal(getPublished(dir, entry.id), undefined);
  assert.equal(uninstallPublished(dir, entry.id), false);
});

test('marketplace: clone gets a new id, new name, empty workspace, no key leak', () => {
  const cloned = cloneAgent(BASE_BOT);
  assert.notEqual(cloned.id, BASE_BOT.id);
  assert.equal(cloned.name, 'Trợ lý (copy)');
  assert.equal(cloned.workspaceDir, '', 'clone must not share the original workspace');
  assert.equal(cloned.systemPrompt, BASE_BOT.systemPrompt);
  assert.equal(cloned.providerId, BASE_BOT.providerId);

  const named = cloneAgent(BASE_BOT, 'Trợ lý (bản sao)');
  assert.equal(named.name, 'Trợ lý (bản sao)');
  assert.notEqual(named.id, cloned.id);

  const dirty = { ...BASE_BOT, apiKey: 'sk-SECRET' };
  const clean = cloneAgent(dirty);
  assert.ok(!('apiKey' in clean));
  assert.ok(!JSON.stringify(clean).includes('sk-SECRET'));
});

test('marketplace: clone keeps denyTools + denySkills as fresh copies (v0.65)', () => {
  const bot = {
    ...BASE_BOT,
    denyTools: ['shell_exec', 'read_file'],
    denySkills: ['web-search', 'pdf'],
  };
  const cloned = cloneAgent(bot);
  // Bằng nội dung, thứ tự không quan trọng.
  assert.deepEqual([...cloned.denyTools].sort(), ['read_file', 'shell_exec']);
  assert.deepEqual([...cloned.denySkills].sort(), ['pdf', 'web-search']);
  // Không share tham chiếu: sửa mảng của bản clone không chạm bản gốc.
  assert.notEqual(cloned.denyTools, bot.denyTools);
  assert.notEqual(cloned.denySkills, bot.denySkills);
  cloned.denyTools.push('write_file');
  cloned.denySkills.push('git');
  assert.deepEqual(bot.denyTools, ['shell_exec', 'read_file']);
  assert.deepEqual(bot.denySkills, ['web-search', 'pdf']);
  // Bot không có deny gì thì clone cũng không có field (như trước).
  const plain = cloneAgent(BASE_BOT);
  assert.ok(!('denyTools' in plain));
  assert.ok(!('denySkills' in plain));
});

test('marketplace: publish/install keep denyTools + denySkills (v0.65)', () => {
  const dir = tmpDir();
  const bot = { ...BASE_BOT, denyTools: ['shell_exec'], denySkills: ['pdf'] };
  const entry = publishAgent(dir, bot);
  assert.deepEqual(entry.config.denyTools, ['shell_exec']);
  assert.deepEqual(entry.config.denySkills, ['pdf']);
  const installed = installPublished(dir, entry.id);
  assert.deepEqual(installed.denyTools, ['shell_exec']);
  assert.deepEqual(installed.denySkills, ['pdf']);
  // Sửa bản install không chạm entry đã publish (không share tham chiếu).
  installed.denyTools.push('write_file');
  installed.denySkills.push('git');
  assert.deepEqual(getPublished(dir, entry.id).config.denyTools, ['shell_exec']);
  assert.deepEqual(getPublished(dir, entry.id).config.denySkills, ['pdf']);
});

test('marketplace: sanitizeConfig drops non-string/empty deny entries', () => {
  const dirty = {
    ...BASE_BOT,
    denyTools: ['shell_exec', 42, '', null],
    denySkills: 'khong-phai-mang',
  };
  const clean = sanitizeConfig(dirty);
  assert.deepEqual(clean.denyTools, ['shell_exec']);
  assert.ok(!('denySkills' in clean), 'non-array denySkills must be dropped');
  const empty = sanitizeConfig({ ...BASE_BOT, denyTools: [], denySkills: [] });
  assert.ok(!('denyTools' in empty), 'empty deny list stays absent');
  assert.ok(!('denySkills' in empty));
});
