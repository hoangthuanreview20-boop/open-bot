/**
 * Tests for the plugin marketplace catalog (packages/core/src/plugins/catalog.ts).
 *
 * Covers manifest parsing, scanning installed plugins + templates,
 * merging (installed wins), search, and the pre-install permission
 * review (including unknown permissions flagged high risk).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-catalog-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  mergePluginCatalog,
  parsePluginManifest,
  readPluginEnabledMap,
  reviewPluginPermissions,
  scanInstalledPlugins,
  scanPluginTemplatesAsCatalog,
  searchPluginCatalog,
  summarizePluginRisk,
} from '../packages/core/dist/plugins/catalog.js';
import { createPluginTemplate, savePluginTemplate } from '../packages/core/dist/plugins/templates.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-catalog-'));
}

function writePlugin(pluginsDir, id, manifest, extraFiles = {}) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function makeTemplate(id, permissions, entrySource) {
  return createPluginTemplate({
    id,
    name: `Template ${id}`,
    description: `A template plugin (${id}).`,
    manifest: {
      id,
      name: `Template ${id}`,
      version: '1.2.0',
      description: `A template plugin (${id}).`,
      author: 'tester',
      permissions,
      main: 'index.js',
    },
    ...(entrySource !== undefined ? { config: { entrySource } } : {}),
  });
}

// --- manifest parsing ------------------------------------------------------

test('plugin catalog: parsePluginManifest accepts valid manifests, rejects bad ones', () => {
  const valid = parsePluginManifest({
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    description: 'Take notes.',
    author: 'me',
    permissions: ['fs', 'fs', 'network'],
    main: 'index.js',
  });
  assert.equal(valid.id, 'notes');
  assert.deepEqual(valid.permissions, ['fs', 'network']);
  assert.equal(parsePluginManifest(null), null);
  assert.equal(parsePluginManifest({ id: 'x' }), null);
  assert.equal(parsePluginManifest({ id: 'x', name: 'X', version: '1.0.0', description: '', main: '' }), null);
  assert.equal(parsePluginManifest({ id: 'x', name: 'X', version: '1.0.0', description: 42, main: 'i.js' }), null);
});

// --- installed scan ----------------------------------------------------------

test('plugin catalog: scanInstalledPlugins reads manifests + enabled map', () => {
  const dir = tmpDir();
  const pluginsDir = path.join(dir, 'plugins');
  writePlugin(pluginsDir, 'notes', {
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    description: 'Take notes.',
    permissions: ['fs'],
    main: 'index.js',
  }, { 'index.js': 'module.exports = {};' });
  writePlugin(pluginsDir, 'sheller', {
    id: 'sheller',
    name: 'Sheller',
    version: '0.3.0',
    description: 'Runs commands.',
    permissions: ['shell'],
    main: 'main.js',
  });
  // No manifest at all: skipped, must not break the scan.
  fs.mkdirSync(path.join(pluginsDir, 'broken'), { recursive: true });
  // Invalid manifest (missing main): skipped.
  writePlugin(pluginsDir, 'bad', { id: 'bad', name: 'Bad', version: '1.0.0', description: 'x', permissions: [] });
  fs.writeFileSync(
    path.join(pluginsDir, 'enabled.json'),
    JSON.stringify({ enabled: { notes: true, sheller: false } }),
    'utf8',
  );
  const entries = scanInstalledPlugins(pluginsDir);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['notes', 'sheller'],
  );
  const notes = entries.find((e) => e.id === 'notes');
  assert.equal(notes.source, 'installed');
  assert.equal(notes.enabled, true);
  assert.equal(notes.hasEntry, true);
  const sheller = entries.find((e) => e.id === 'sheller');
  assert.equal(sheller.enabled, false);
  assert.equal(sheller.hasEntry, false);
  assert.deepEqual(scanInstalledPlugins(path.join(dir, 'missing-dir')), []);
  assert.deepEqual(readPluginEnabledMap(path.join(dir, 'missing-dir')), {});
});

test('plugin catalog: enabled map ignores non-boolean values and corrupt files', () => {
  const dir = tmpDir();
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'enabled.json'), JSON.stringify({ enabled: { a: true, b: 'yes', c: 1 } }), 'utf8');
  assert.deepEqual(readPluginEnabledMap(pluginsDir), { a: true });
  fs.writeFileSync(path.join(pluginsDir, 'enabled.json'), '{not json', 'utf8');
  assert.deepEqual(readPluginEnabledMap(pluginsDir), {});
});

// --- templates + merge -------------------------------------------------------

test('plugin catalog: templates list with hasEntry from entrySource', () => {
  const dir = tmpDir();
  const templatesDir = path.join(dir, 'plugin-templates');
  savePluginTemplate(templatesDir, makeTemplate('tmpl-a', ['fs'], 'module.exports = {};'));
  savePluginTemplate(templatesDir, makeTemplate('tmpl-b', ['network']));
  const entries = scanPluginTemplatesAsCatalog(templatesDir);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['tmpl-a', 'tmpl-b'],
  );
  assert.ok(entries.every((e) => e.source === 'template' && e.enabled === null));
  assert.equal(entries.find((e) => e.id === 'tmpl-a').hasEntry, true);
  assert.equal(entries.find((e) => e.id === 'tmpl-b').hasEntry, false);
  assert.deepEqual(scanPluginTemplatesAsCatalog(path.join(dir, 'missing-dir')), []);
});

test('plugin catalog: merge dedupes by id, installed wins', () => {
  const dir = tmpDir();
  const pluginsDir = path.join(dir, 'plugins');
  const templatesDir = path.join(dir, 'plugin-templates');
  writePlugin(pluginsDir, 'notes', {
    id: 'notes',
    name: 'Notes',
    version: '2.0.0',
    description: 'Installed notes.',
    permissions: ['fs'],
    main: 'index.js',
  });
  savePluginTemplate(templatesDir, makeTemplate('notes', ['fs'], 'module.exports = {};'));
  savePluginTemplate(templatesDir, makeTemplate('other', ['mcp'], 'module.exports = {};'));
  const merged = mergePluginCatalog(scanInstalledPlugins(pluginsDir), scanPluginTemplatesAsCatalog(templatesDir));
  assert.deepEqual(
    merged.map((e) => `${e.id}:${e.source}`),
    ['notes:installed', 'other:template'],
  );
  assert.equal(merged.find((e) => e.id === 'notes').version, '2.0.0');
});

// --- search + permission review ----------------------------------------------

test('plugin catalog: search matches name, description, id and permissions', () => {
  const entries = [
    { id: 'notes', name: 'Notes', version: '1.0.0', description: 'Take notes fast.', author: '', permissions: ['fs'], source: 'installed', enabled: true, hasEntry: true },
    { id: 'sheller', name: 'Sheller', version: '1.0.0', description: 'Runs commands.', author: '', permissions: ['shell'], source: 'template', enabled: null, hasEntry: true },
  ];
  assert.deepEqual(searchPluginCatalog(entries, 'notes').map((e) => e.id), ['notes']);
  assert.deepEqual(searchPluginCatalog(entries, 'SHELL').map((e) => e.id), ['sheller']);
  assert.deepEqual(searchPluginCatalog(entries, 'take fast').map((e) => e.id), ['notes']);
  assert.deepEqual(searchPluginCatalog(entries, 'nope'), []);
  assert.equal(searchPluginCatalog(entries, '  ').length, 2);
});

test('plugin catalog: permission review ranks risk and flags unknown permissions', () => {
  const reviews = reviewPluginPermissions(['fs', 'shell', 'network', 'mcp']);
  assert.deepEqual(
    reviews.map((r) => `${r.permission}:${r.risk}`),
    ['fs:medium', 'shell:high', 'network:high', 'mcp:medium'],
  );
  assert.ok(reviews.every((r) => r.summary.length > 0));
  const unknown = reviewPluginPermissions(['teleport']);
  assert.equal(unknown[0].risk, 'high');
  assert.match(unknown[0].summary, /Unknown permission "teleport"/);
  // Dedupe + ignore non-strings, keep manifest order.
  assert.deepEqual(
    reviewPluginPermissions(['fs', 'fs', 42, 'shell']).map((r) => r.permission),
    ['fs', 'shell'],
  );
  assert.deepEqual(reviewPluginPermissions([]), []);
  assert.equal(summarizePluginRisk([]), 'low');
  assert.equal(summarizePluginRisk(reviewPluginPermissions(['fs'])), 'medium');
  assert.equal(summarizePluginRisk(reviewPluginPermissions(['fs', 'shell'])), 'high');
});
