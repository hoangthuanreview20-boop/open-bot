/**
 * Tests for the v0.8 plugin template system (packages/core/src/plugins/templates.ts).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/plugin-templates-v08.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PLUGIN_TEMPLATES_DIR,
  applyPluginTemplate,
  createPluginTemplate,
  deletePluginTemplate,
  exportPluginTemplate,
  getPluginTemplate,
  importPluginTemplate,
  listPluginTemplates,
  savePluginTemplate,
  validatePluginTemplate,
} from '../packages/core/dist/plugins/templates.js';
import { loadPlugin } from '../packages/tools/dist/plugins/loader.js';
import { PluginManager } from '../packages/tools/dist/plugins/manager.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugintpl-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Minimal loadable plugin entry: one harmless tool, no permissions needed. */
const HELLO_ENTRY = `module.exports = { tools: [{ definition: { name: 'hello_tpl', description: 'Say hello.', parameters: { type: 'object', properties: {} } }, needsApproval: false, execute: async () => 'hello from template' }] };\n`;

function helloTemplate(overrides = {}) {
  return createPluginTemplate({
    id: 'hello-tpl',
    name: 'Hello Template',
    description: 'A minimal plugin template for tests.',
    manifest: {
      id: 'hello-tpl',
      name: 'Hello Plugin',
      version: '1.2.0',
      description: 'Says hello.',
      author: 'open-bot tests',
      permissions: [],
      main: 'index.js',
      tools: ['hello_tpl'],
    },
    config: { greeting: 'hello', entrySource: HELLO_ENTRY },
    ...overrides,
  });
}

// --- save / list / get / delete --------------------------------------------

test('plugin templates: save/list/get round-trip stores one JSON file per template', () => {
  const base = makeTempDir();
  const templatesDir = path.join(base, PLUGIN_TEMPLATES_DIR);
  assert.deepEqual(listPluginTemplates(templatesDir), [], 'empty at first');
  assert.equal(getPluginTemplate(templatesDir, 'hello-tpl'), undefined);

  const saved = savePluginTemplate(templatesDir, helloTemplate());
  assert.equal(saved.id, 'hello-tpl');
  assert.ok(saved.createdAt);
  assert.equal(
    fs.existsSync(path.join(templatesDir, 'hello-tpl.json')),
    true,
    'one file per template',
  );
  const stored = JSON.parse(fs.readFileSync(path.join(templatesDir, 'hello-tpl.json'), 'utf-8'));
  assert.equal(stored.manifest.version, '1.2.0');
  assert.equal(stored.config.greeting, 'hello');

  assert.deepEqual(listPluginTemplates(templatesDir).map((t) => t.id), ['hello-tpl']);
  assert.equal(getPluginTemplate(templatesDir, 'hello-tpl').name, 'Hello Template');
  // Saving again replaces the entry (same id, new description).
  savePluginTemplate(templatesDir, helloTemplate({ description: 'Updated.' }));
  assert.equal(listPluginTemplates(templatesDir).length, 1);
  assert.equal(getPluginTemplate(templatesDir, 'hello-tpl').description, 'Updated.');

  assert.equal(deletePluginTemplate(templatesDir, 'hello-tpl'), true);
  assert.equal(deletePluginTemplate(templatesDir, 'hello-tpl'), false);
  assert.deepEqual(listPluginTemplates(templatesDir), []);
});

test('plugin templates: list skips corrupt files instead of crashing', () => {
  const base = makeTempDir();
  const templatesDir = path.join(base, PLUGIN_TEMPLATES_DIR);
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(
    path.join(templatesDir, 'bad-id.json'),
    JSON.stringify({ id: 'bad id!', name: 'x', description: 'y', manifest: {} }),
    'utf8',
  );
  savePluginTemplate(templatesDir, helloTemplate());
  assert.deepEqual(listPluginTemplates(templatesDir).map((t) => t.id), ['hello-tpl']);
  assert.equal(getPluginTemplate(templatesDir, 'broken'), undefined);
});

// --- validation ------------------------------------------------------------

test('plugin templates: invalid templates are rejected', () => {
  const bad = (mutate) => {
    const tpl = helloTemplate();
    mutate(tpl);
    return tpl;
  };
  assert.throws(() => validatePluginTemplate(null), /object/);
  assert.throws(() => validatePluginTemplate(bad((t) => { t.id = 'bad id!'; })), /id/);
  assert.throws(() => validatePluginTemplate(bad((t) => { t.name = '  '; })), /name/);
  assert.throws(() => validatePluginTemplate(bad((t) => { t.manifest.version = '1.0'; })), /version/);
  assert.throws(() => validatePluginTemplate(bad((t) => { t.manifest.permissions = ['root']; })), /permissions/);
  assert.throws(() => validatePluginTemplate(bad((t) => { t.manifest.main = '../escape.js'; })), /main/);
  assert.throws(
    () => validatePluginTemplate(bad((t) => { t.manifest.id = 'other-id'; })),
    /phải trùng với template id/,
  );
  assert.throws(() => validatePluginTemplate(bad((t) => { t.config = []; })), /config.*object/);
  assert.throws(
    () => validatePluginTemplate(bad((t) => { t.config.entrySource = 42; })),
    /entrySource/,
  );
  // Non-JSON values cannot be stored.
  assert.throws(
    () => validatePluginTemplate(bad((t) => { t.config.fn = () => 1; })),
    /JSON hợp lệ/,
  );
});

// --- secrets ---------------------------------------------------------------

test('plugin templates: secrets are rejected on save and on import', () => {
  const secret = helloTemplate();
  secret.config.apiKey = 'sk-SECRET-DO-NOT-STORE';
  const base = makeTempDir();
  const templatesDir = path.join(base, PLUGIN_TEMPLATES_DIR);
  assert.throws(() => savePluginTemplate(templatesDir, secret), /credential|secret/i);
  assert.equal(fs.existsSync(path.join(templatesDir, 'hello-tpl.json')), false, 'never written to disk');

  for (const key of ['token', 'password', 'client_secret', 'authToken', 'private_key']) {
    const tpl = helloTemplate();
    tpl.config[key] = 'x';
    assert.throws(() => validatePluginTemplate(tpl), /credential|secret/i, `${key} must be rejected`);
  }
  // Nested secret keys are caught too.
  const nested = helloTemplate();
  nested.config.nested = { bearerToken: 'abc' };
  assert.throws(() => validatePluginTemplate(nested), /credential|secret/i);
  // A pasted provider token as a value is caught even under an innocent key.
  const pasted = helloTemplate();
  pasted.config.defaultValue = 'sk-SECRET-DO-NOT-STORE';
  assert.throws(() => validatePluginTemplate(pasted), /token/);
});

// --- export / import --------------------------------------------------------

test('plugin templates: export/import round-trip, no secret leaks', () => {
  const tpl = helloTemplate();
  const json = exportPluginTemplate(tpl);
  assert.ok(!json.includes('sk-'), 'export contains no token-like value');
  const imported = importPluginTemplate(json);
  assert.equal(imported.id, tpl.id);
  assert.equal(imported.manifest.version, tpl.manifest.version);
  assert.equal(imported.config.greeting, 'hello');
  assert.equal(imported.config.entrySource, HELLO_ENTRY);
  assert.equal(imported.createdAt, tpl.createdAt);

  // Unknown top-level fields are dropped on import.
  const dirty = JSON.parse(json);
  dirty.apiKey = 'sk-SECRET-DO-NOT-STORE';
  dirty.extraField = 'drop me';
  const cleaned = importPluginTemplate(JSON.stringify(dirty));
  assert.equal('apiKey' in cleaned, false);
  assert.equal('extraField' in cleaned, false);
  assert.ok(!exportPluginTemplate(cleaned).includes('sk-SECRET-DO-NOT-STORE'));

  assert.throws(() => importPluginTemplate('{ not json'), /không phải JSON/);
  assert.throws(() => importPluginTemplate(JSON.stringify({ id: 'x' })), /không hợp lệ/);
  const smuggled = helloTemplate();
  smuggled.config = { apiKey: 'sk-SECRET-DO-NOT-STORE' };
  assert.throws(() => importPluginTemplate(JSON.stringify(smuggled)), /credential|secret/i);
});

// --- apply ------------------------------------------------------------------

test('plugin templates: apply creates a loadable plugin in pluginsDir', () => {
  const base = makeTempDir();
  const templatesDir = path.join(base, PLUGIN_TEMPLATES_DIR);
  const pluginsDir = path.join(base, 'plugins');
  savePluginTemplate(templatesDir, helloTemplate());

  const applied = applyPluginTemplate(templatesDir, 'hello-tpl', pluginsDir);
  assert.equal(applied.dir, path.join(pluginsDir, 'hello-tpl'));
  assert.equal(applied.hasEntry, true);
  assert.equal(fs.existsSync(path.join(applied.dir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(applied.dir, 'index.js')), true);
  const config = JSON.parse(fs.readFileSync(applied.configPath, 'utf-8'));
  assert.equal(config.greeting, 'hello');
  assert.equal('entrySource' in config, false, 'entrySource is a file, not config');

  // The applied plugin really loads through the normal plugin loader.
  const loaded = loadPlugin(applied.dir);
  assert.equal(loaded.manifest.id, 'hello-tpl');
  assert.deepEqual(loaded.tools.map((t) => t.definition.name), ['hello_tpl']);
  const manager = new PluginManager(pluginsDir);
  assert.deepEqual(manager.scanDir().map((p) => p.manifest.id), ['hello-tpl']);
  assert.deepEqual(manager.toolsForRegistry().map((t) => t.definition.name), ['hello_tpl']);

  // Second apply refuses without overwrite, replaces with it.
  assert.throws(() => applyPluginTemplate(templatesDir, 'hello-tpl', pluginsDir), /đã được cài/);
  const again = applyPluginTemplate(templatesDir, 'hello-tpl', pluginsDir, { overwrite: true });
  assert.equal(again.hasEntry, true);
  assert.throws(() => applyPluginTemplate(templatesDir, 'no-such-template', pluginsDir), /Không tìm thấy/);
});

test('plugin templates: apply without entrySource still writes manifest + config', () => {
  const base = makeTempDir();
  const templatesDir = path.join(base, PLUGIN_TEMPLATES_DIR);
  const pluginsDir = path.join(base, 'plugins');
  const tpl = helloTemplate();
  delete tpl.config.entrySource;
  savePluginTemplate(templatesDir, tpl);

  const applied = applyPluginTemplate(templatesDir, 'hello-tpl', pluginsDir);
  assert.equal(applied.hasEntry, false);
  assert.equal(fs.existsSync(path.join(applied.dir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(applied.dir, 'index.js')), false);
  const storedManifest = JSON.parse(
    fs.readFileSync(path.join(applied.dir, 'manifest.json'), 'utf-8'),
  );
  assert.equal(storedManifest.id, 'hello-tpl');
});
