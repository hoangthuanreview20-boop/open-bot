/**
 * Tests for the v0.3 plugin system (packages/tools/src/plugins/).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/plugins.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlugin } from '../packages/tools/dist/plugins/loader.js';
import { PluginManager, toolsFromPlugins, registerPluginTools } from '../packages/tools/dist/plugins/manager.js';
import { PluginLoadError } from '../packages/tools/dist/plugins/types.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SAMPLE_PLUGIN = path.join(FIXTURES, 'sample-plugin');
const FS_PLUGIN = path.join(FIXTURES, 'fs-plugin');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Write a plugin directory: manifest.json + index.js (CommonJS). */
function writePlugin(dir, manifest, indexJs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf8');
  return dir;
}

const ECHO_INDEX_JS = `
const echoTool = {
  definition: {
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
  },
  needsApproval: false,
  execute: async (args) => String(args.text ?? ''),
};
module.exports = { tools: [echoTool] };
`;

function echoManifest(id = 'echo-plugin', extra = {}) {
  return {
    id,
    name: 'Echo Plugin',
    version: '1.0.0',
    description: 'A minimal valid plugin.',
    permissions: [],
    main: 'index.js',
    tools: ['echo'],
    ...extra,
  };
}

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });

// ---------------------------------------------------------------------------
// loadPlugin: valid plugin
// ---------------------------------------------------------------------------

test('loadPlugin loads a valid plugin and truncates tool output to 20_000 chars', async () => {
  const dir = writePlugin(path.join(makeTempDir(), 'echo-plugin'), echoManifest(), ECHO_INDEX_JS);
  const loaded = loadPlugin(dir);
  assert.equal(loaded.manifest.id, 'echo-plugin');
  assert.equal(loaded.tools.length, 1);
  assert.equal(loaded.tools[0].definition.name, 'echo');

  const ws = makeTempDir();
  assert.equal(await loaded.tools[0].execute({ text: 'hello' }, CTX(ws)), 'hello');

  const long = 'x'.repeat(25_000);
  const out = await loaded.tools[0].execute({ text: long }, CTX(ws));
  assert.ok(out.length < long.length, 'output must be truncated');
  assert.ok(out.startsWith('x'.repeat(20_000)), 'first 20_000 chars kept');
  assert.match(out, /truncated to 20000 chars/);
});

// ---------------------------------------------------------------------------
// loadPlugin: fixture with undeclared shell use is blocked
// ---------------------------------------------------------------------------

test('loadPlugin blocks the sample plugin: shell tool without shell permission', () => {
  assert.throws(
    () => loadPlugin(SAMPLE_PLUGIN),
    (err) => err instanceof PluginLoadError && /shell/.test(err.message) && /sample-plugin/.test(err.message),
  );
});

test('loadPlugin allows the same shell tool when the manifest declares shell', () => {
  const dir = makeTempDir();
  const indexJs = `
    const { execSync } = require('node:child_process');
    const shellTool = {
      definition: {
        name: 'do_shell',
        description: 'Runs a shell command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Command.' } },
          required: ['command'],
        },
      },
      needsApproval: true,
      execute: async (args) => execSync(String(args.command ?? 'echo hi'), { encoding: 'utf8' }),
    };
    module.exports = { tools: [shellTool] };
  `;
  writePlugin(
    dir,
    { id: 'shell-plugin', name: 'Shell', version: '0.1.0', description: 'Shell plugin.', permissions: ['shell'], main: 'index.js' },
    indexJs,
  );
  const loaded = loadPlugin(dir);
  assert.equal(loaded.tools.length, 1);
  assert.equal(loaded.tools[0].definition.name, 'do_shell');
});

// ---------------------------------------------------------------------------
// loadPlugin: bad manifests / forbidden requires
// ---------------------------------------------------------------------------

test('loadPlugin rejects bad manifests: bad id, missing main, missing entry file', () => {
  const base = makeTempDir();

  const badId = writePlugin(path.join(base, 'a'), echoManifest('bad id!'), ECHO_INDEX_JS);
  assert.throws(() => loadPlugin(badId), (e) => e instanceof PluginLoadError && /id/.test(e.message));

  const noMainDir = path.join(base, 'b');
  fs.mkdirSync(noMainDir, { recursive: true });
  const { main, ...noMain } = echoManifest();
  fs.writeFileSync(path.join(noMainDir, 'manifest.json'), JSON.stringify(noMain), 'utf8');
  fs.writeFileSync(path.join(noMainDir, 'index.js'), ECHO_INDEX_JS, 'utf8');
  assert.throws(() => loadPlugin(noMainDir), (e) => e instanceof PluginLoadError && /main/.test(e.message));

  const missingEntry = writePlugin(
    path.join(base, 'c'),
    echoManifest('missing-entry', { main: 'nope.js' }),
    ECHO_INDEX_JS,
  );
  assert.throws(
    () => loadPlugin(missingEntry),
    (e) => e instanceof PluginLoadError && /does not exist/.test(e.message),
  );

  const badVersion = writePlugin(path.join(base, 'd'), echoManifest('bad-ver', { version: 'one' }), ECHO_INDEX_JS);
  assert.throws(() => loadPlugin(badVersion), (e) => e instanceof PluginLoadError && /version/.test(e.message));
});

test('loadPlugin rejects a plugin requiring an external npm package', () => {
  const dir = writePlugin(
    path.join(makeTempDir(), 'ext-plugin'),
    echoManifest('ext-plugin'),
    `const _ = require('lodash');\n${ECHO_INDEX_JS}`,
  );
  assert.throws(
    () => loadPlugin(dir),
    (e) => e instanceof PluginLoadError && /external package "lodash"/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// Plugin tools stay inside the workspace (resolveWithin)
// ---------------------------------------------------------------------------

test('plugin fs tool reads inside the workspace and refuses paths outside it', async () => {
  const loaded = loadPlugin(FS_PLUGIN);
  assert.equal(loaded.tools.length, 1);
  const tool = loaded.tools[0];

  const ws = makeTempDir();
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'inside-content', 'utf8');
  assert.equal(await tool.execute({ path: 'hello.txt' }, CTX(ws)), 'inside-content');

  // The workspace's parent holds a file the tool must NOT reach.
  fs.writeFileSync(path.join(path.dirname(ws), 'outside.txt'), 'secret', 'utf8');
  await assert.rejects(tool.execute({ path: '../outside.txt' }, CTX(ws)), /escapes workspace/);
});

// ---------------------------------------------------------------------------
// PluginManager: scan / enable / disable / toolsForRegistry / registry wiring
// ---------------------------------------------------------------------------

test('manager scanDir + disable/enable changes toolsForRegistry, persisted in enabled.json', () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), echoManifest(), ECHO_INDEX_JS);

  const manager = new PluginManager(pluginsDir);
  const infos = manager.scanDir();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].manifest.id, 'echo-plugin');
  assert.equal(infos[0].enabled, true);
  assert.deepEqual(infos[0].loadedTools, ['echo']);
  assert.equal(manager.toolsForRegistry().length, 1);
  assert.deepEqual(manager.listPlugins().map((p) => p.manifest.id), ['echo-plugin']);

  assert.equal(manager.disable('echo-plugin'), true);
  assert.equal(manager.toolsForRegistry().length, 0);
  assert.equal(manager.getPlugin('echo-plugin').enabled, false);

  // A fresh manager reading the same directory must still see it disabled.
  const manager2 = new PluginManager(pluginsDir);
  manager2.scanDir();
  assert.equal(manager2.toolsForRegistry().length, 0);

  assert.equal(manager2.enable('echo-plugin'), true);
  assert.equal(manager2.toolsForRegistry().length, 1);
  assert.equal(manager2.toolsForRegistry()[0].definition.name, 'echo');

  // toolsFromPlugins + registerPluginTools wire into a ToolRegistry.
  const registry = new ToolRegistry();
  const names = registerPluginTools(registry, manager2);
  assert.deepEqual(names, ['echo']);
  assert.equal(registry.has('echo'), true);
  assert.equal(registry.size(), 1);
  assert.deepEqual(toolsFromPlugins(manager2).map((t) => t.definition.name), ['echo']);
  // Duplicate registration fails loudly, like any core tool collision.
  assert.throws(() => registerPluginTools(registry, manager2), /already registered/);
});

test('manager scanDir skips a broken plugin instead of crashing', () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), echoManifest(), ECHO_INDEX_JS);
  fs.cpSync(SAMPLE_PLUGIN, path.join(pluginsDir, 'sample-plugin'), { recursive: true });

  const manager = new PluginManager(pluginsDir);
  const infos = manager.scanDir();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].manifest.id, 'echo-plugin');
  assert.equal(manager.loadErrors().length, 1);
  assert.match(manager.loadErrors()[0].error.message, /shell/);
  assert.equal(manager.toolsForRegistry().length, 1);
});

// ---------------------------------------------------------------------------
// PluginManager: install / uninstall
// ---------------------------------------------------------------------------

test('manager installFromDir validates, copies and loads; uninstall removes it', () => {
  const src = writePlugin(path.join(makeTempDir(), 'echo-plugin'), echoManifest(), ECHO_INDEX_JS);
  const pluginsDir = makeTempDir();
  const manager = new PluginManager(pluginsDir);

  // Invalid source is rejected BEFORE anything is copied.
  assert.throws(() => manager.installFromDir(SAMPLE_PLUGIN), PluginLoadError);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'sample-plugin')), false);

  const info = manager.installFromDir(src);
  assert.equal(info.manifest.id, 'echo-plugin');
  assert.equal(fs.existsSync(path.join(pluginsDir, 'echo-plugin', 'manifest.json')), true);
  assert.equal(manager.toolsForRegistry().length, 1);

  assert.throws(() => manager.installFromDir(src), /already installed/);
  const replaced = manager.installFromDir(src, { overwrite: true });
  assert.equal(replaced.manifest.id, 'echo-plugin');

  assert.equal(manager.uninstall('echo-plugin'), true);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'echo-plugin')), false);
  assert.equal(manager.toolsForRegistry().length, 0);
  assert.equal(manager.listPlugins().length, 0);
  assert.equal(manager.uninstall('echo-plugin'), false);
});

test('manager load/unload drops a plugin tools without deleting its folder', () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), echoManifest(), ECHO_INDEX_JS);
  const manager = new PluginManager(pluginsDir);
  manager.scanDir();
  assert.equal(manager.toolsForRegistry().length, 1);
  assert.equal(manager.unload('echo-plugin'), true);
  assert.equal(manager.toolsForRegistry().length, 0);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'echo-plugin', 'manifest.json')), true);
  const info = manager.load('echo-plugin');
  assert.equal(info.manifest.id, 'echo-plugin');
  assert.equal(manager.toolsForRegistry().length, 1);
});
