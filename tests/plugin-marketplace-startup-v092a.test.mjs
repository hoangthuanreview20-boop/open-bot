/**
 * Tests for plugin marketplace loading at bot start (v0.92a).
 *
 * Gap closed: the plugin marketplace v2 (team F) recorded installed
 * plugins with `sandboxed: true` and exported
 * `loadMarketplacePluginSandboxed`, but nothing called it at bot
 * start — the record was only a policy declaration. `loadPlugins`
 * (coordinator) now enforces it: after the generic scan it reads
 * `marketplace-installed.json` (records only, no rescan) and loads
 * each recorded sandboxed plugin out-of-process, even when the caller
 * asked for in-process loading (`pluginsSandbox: false`, legacy).
 *
 * ALL tests here are MOCK / LOCAL-ONLY: the plugin is a temp-dir
 * fixture installed through the real marketplace install path
 * (approval + installPluginFromSource), the provider is "mock"
 * (no network, no key), and the coordinator runs over NDJSON-RPC
 * to a real child process. Nothing here is a live test.
 *
 * How the tests prove "sandboxed, not in-process": the fixture
 * module appends `loaded:<pid>` to a marker file next to itself
 * (`__dirname`, so it works in every process — test, coordinator
 * child, sandbox worker — with no env inheritance involved) every
 * time it is required, and `called:<text>` every time its tool
 * executes. A pid equal to the test process pid means "required
 * in-process here"; any other pid means "required in another
 * process" (coordinator child or forked sandbox worker).
 *
 * Run after building the tools + core packages:
 *   npm run build --workspace=@open-bot/tools
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-marketplace-startup-v092a.test.mjs
 */
import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

import {
  disposePluginManagers,
  loadPlugins,
  loadMarketplacePluginsAtStartup,
} from '../packages/core/dist/coordinator/coordinator.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { installPluginFromSource } from '../packages/tools/dist/plugins/marketplace.js';
import { recordMarketplaceApproval } from '../packages/core/dist/mcp/marketplaceApproval.js';

const PLUGIN_ID = 'mkt-demo';
const TOOL_NAME = 'mkt_demo_echo';
const MARKER_FILE = 'mkt92-markers.log';

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readLogLines(markerFile) {
  if (!fs.existsSync(markerFile)) return [];
  return fs.readFileSync(markerFile, 'utf8').split('\n').filter(Boolean);
}

function loadedPids(markerFile) {
  return readLogLines(markerFile)
    .filter((line) => line.startsWith('loaded:'))
    .map((line) => Number(line.slice('loaded:'.length)));
}

afterEach(async () => {
  // Dispose sandbox hosts forked by direct loadPlugins() calls:
  // SIGKILL-ing the worker is NOT enough — the host restarts it, and
  // the open IPC channel keeps this test process alive forever.
  await disposePluginManagers();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Build a minimal loadable plugin SOURCE folder (not yet installed). */
function makePluginSource() {
  const dir = makeTempDir(`open-bot-mkt92-src-${PLUGIN_ID}-`);
  const manifest = {
    id: PLUGIN_ID,
    name: 'Marketplace Demo Plugin',
    version: '1.0.0',
    description: 'Fixture plugin installed via the marketplace.',
    // The fixture writes pid/call markers with node:fs — the loader
    // requires the matching permission (same as coordinator.test.mjs
    // widening the sample-plugin manifest to ['fs', 'shell']).
    permissions: ['fs'],
    main: 'index.js',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const indexJs = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const marker = path.join(__dirname, '${MARKER_FILE}');`,
    "fs.appendFileSync(marker, `loaded:${process.pid}\\n`);",
    'module.exports = { tools: [{',
    `  definition: { name: '${TOOL_NAME}', description: 'Echo (marketplace fixture).',`,
    "    parameters: { type: 'object', properties: { text: { type: 'string' } } } },",
    '  needsApproval: false,',
    '  execute: async (args) => {',
    "    fs.appendFileSync(marker, `called:${args?.text ?? ''}\\n`);",
    "    return `echo:${args?.text ?? ''}`;",
    '  },',
    '}] };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf8');
  return dir;
}

/**
 * Install the fixture through the REAL marketplace path (approval
 * record + installPluginFromSource), so the on-disk record
 * (`marketplace-installed.json`, `sandboxed: true`) is exactly what
 * a user install produces. Returns { pluginsDir, userDataDir,
 * markerFile } — markerFile is the marker INSIDE the installed
 * plugin folder (empty after install; the install itself requires
 * the module in this process, so it is truncated here).
 */
async function installMarketplaceFixture() {
  const userDataDir = makeTempDir('open-bot-mkt92-userdata-');
  const pluginsDir = path.join(userDataDir, 'plugins');
  const srcDir = makePluginSource();
  recordMarketplaceApproval(userDataDir, {
    kind: 'plugin-install',
    targetId: PLUGIN_ID,
    version: '1.0.0',
    source: 'local',
  });
  await installPluginFromSource({ kind: 'local', path: srcDir }, pluginsDir, { userDataDir });
  const markerFile = path.join(pluginsDir, PLUGIN_ID, MARKER_FILE);
  fs.writeFileSync(markerFile, '', 'utf8');
  return { pluginsDir, userDataDir, markerFile };
}

/** Drop the installed fixture module from this process's require cache
 *  (the install step already required it here). Without this, the
 *  in-process scan in the `sandboxed:false` test would hit the cache
 *  and never re-execute the module top-level, so its `loaded:<pid>`
 *  line — the proof the legacy scan ran in-process — would be missing. */
function clearPluginRequireCache(pluginsDir) {
  const entry = path.join(pluginsDir, PLUGIN_ID, 'index.js');
  try {
    delete requireCjs.cache[requireCjs.resolve(entry)];
  } catch {
    // Never required in this process — nothing to clear.
  }
}

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function mockProvider(responses) {
  return { id: 'mock', label: 'Mock', mockResponses: responses };
}

// ---------------------------------------------------------------------------
// loadPlugins() — direct, in-process coordinator module
// ---------------------------------------------------------------------------

test('loadPlugins mặc định: plugin marketplace chạy sandboxed, tool có trong registry', async () => {
  const { pluginsDir, markerFile } = await installMarketplaceFixture();
  const { tools } = await loadPlugins(pluginsDir);
  const names = tools.map((t) => t.definition.name);
  assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`);
  const pids = loadedPids(markerFile);
  assert.ok(pids.length >= 1, 'sandbox worker phải require plugin ít nhất 1 lần');
  assert.ok(
    pids.every((pid) => pid !== process.pid),
    `plugin không được require in-process (pids: ${pids.join(', ')}, test pid: ${process.pid})`,
  );
  const tool = tools.find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'xin chao' }, {}), 'echo:xin chao');
  assert.ok(
    readLogLines(markerFile).includes('called:xin chao'),
    'tool marketplace phải thực thi được qua sandbox',
  );
});

test('loadPlugins với sandboxed:false: plugin marketplace VẪN chạy sandboxed (chính sách ghi trong bản ghi)', async () => {
  const { pluginsDir, markerFile } = await installMarketplaceFixture();
  clearPluginRequireCache(pluginsDir);
  const { tools } = await loadPlugins(pluginsDir, { sandboxed: false });
  const names = tools.map((t) => t.definition.name);
  assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`);
  // v0.93a behaviour change: marketplace plugins are EXCLUDED from
  // the generic scan and load ONLY after signature verification, so
  // the legacy in-process load no longer happens at all — the log
  // must hold NO in-process pid (v0.92a asserted >= 2 distinct pids
  // here: in-process + sandbox). The marketplace step still forks a
  // sandbox worker, so at least one non-test pid is present.
  const pids = [...new Set(loadedPids(markerFile))];
  assert.ok(
    pids.every((pid) => pid !== process.pid),
    `plugin marketplace không được require in-process (pids: ${pids.join(', ')}, test pid: ${process.pid})`,
  );
  assert.ok(
    pids.length >= 1,
    'marketplace step phải fork sandbox worker dù sandboxed:false',
  );
  const tool = tools.find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'sandbox' }, {}), 'echo:sandbox');
  assert.ok(readLogLines(markerFile).includes('called:sandbox'));
});

test('loadPlugins: không có plugin marketplace thì không lỗi, không tool lạ', async () => {
  const emptyDir = makeTempDir('open-bot-mkt92-empty-');
  const { tools, bundleParts } = await loadPlugins(emptyDir);
  assert.deepEqual(tools, []);
  assert.deepEqual(bundleParts, []);
});

test('loadMarketplacePluginsAtStartup: bản ghi thiếu/hỏng không bao giờ throw', async () => {
  // (a) No records file at all — plain empty dir.
  const bareDir = makeTempDir('open-bot-mkt92-bare-');
  const empty = await loadMarketplacePluginsAtStartup(
    { loadSandboxed: async () => assert.fail('must not be called') },
    bareDir,
  );
  assert.deepEqual(empty, { loadedIds: [], skipped: [], rolledBack: [] });

  // (b) Record lists a plugin whose folder is gone — skipped, not thrown.
  const ghostDir = makeTempDir('open-bot-mkt92-ghost-');
  fs.writeFileSync(
    path.join(ghostDir, 'marketplace-installed.json'),
    JSON.stringify({
      'ghost-plugin': {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        source: { kind: 'local', path: '/nonexistent' },
        sandboxed: true,
      },
    }),
    'utf8',
  );
  const { PluginManager } = await import('../packages/tools/dist/plugins/manager.js');
  const ghostManager = new PluginManager(ghostDir);
  const ghost = await loadMarketplacePluginsAtStartup(ghostManager, ghostDir);
  assert.deepEqual(ghost.loadedIds, []);
  assert.equal(ghost.skipped.length, 1);
  assert.equal(ghost.skipped[0].id, 'ghost-plugin');
  assert.match(ghost.skipped[0].error, /ghost-plugin/);

  // (c) Corrupt records JSON — the whole step is skipped, no throw,
  // and the generic scan in loadPlugins still loads the folder.
  const { pluginsDir } = await installMarketplaceFixture();
  const corruptDir = makeTempDir('open-bot-mkt92-corrupt-');
  const pluginDir = path.join(corruptDir, PLUGIN_ID);
  fs.cpSync(path.join(pluginsDir, PLUGIN_ID), pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(corruptDir, 'marketplace-installed.json'),
    '{ not valid json',
    'utf8',
  );
  const corrupt = await loadMarketplacePluginsAtStartup(
    new PluginManager(corruptDir),
    corruptDir,
  );
  assert.deepEqual(corrupt, { loadedIds: [], skipped: [], rolledBack: [] });
  const scanned = await loadPlugins(corruptDir);
  assert.ok(
    scanned.tools.map((t) => t.definition.name).includes(TOOL_NAME),
    'bản ghi hỏng không được chặn đường scan thường',
  );
});

// ---------------------------------------------------------------------------
// Headless run thật qua CoordinatorClient (coordinator con + mock provider)
// ---------------------------------------------------------------------------

let client;
before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

after(async () => {
  await client.dispose();
  await client.dispose();
});

test('createBot headless: tool marketplace xuất hiện trong registry sau khi start, chạy được qua run', async () => {
  const ws = makeTempDir('open-bot-mkt92-ws-');
  const { pluginsDir, markerFile } = await installMarketplaceFixture();
  // Baseline: bot không có pluginsDir — đếm tool gốc để so sánh.
  const baseline = await client.createBot({
    bot: botConfig('bot-mkt92-base', ws),
    provider: mockProvider([{ text: 'ok' }]),
  });
  await client.destroyBot('bot-mkt92-base');

  const ws2 = makeTempDir('open-bot-mkt92-ws2-');
  const created = await client.createBot({
    bot: botConfig('bot-mkt92', ws2),
    provider: mockProvider([
      {
        toolCalls: [{ id: 'c1', name: TOOL_NAME, args: { text: 'xin chao' } }],
      },
      { text: 'xong' },
    ]),
    pluginsDir,
  });
  try {
    assert.equal(
      created.toolCount,
      baseline.toolCount + 1,
      `expected baseline+1 tools, got ${created.toolCount} (baseline ${baseline.toolCount})`,
    );
    assert.ok(created.toolNames.includes(TOOL_NAME));
    const result = await client.run('bot-mkt92', 'gọi tool marketplace');
    assert.equal(result.text, 'xong');
    assert.ok(
      readLogLines(markerFile).includes('called:xin chao'),
      'tool marketplace phải thực thi trong run thật',
    );
    const pids = loadedPids(markerFile);
    assert.ok(pids.length >= 1, 'plugin phải được require ở tiến trình con');
    assert.ok(
      pids.every((pid) => pid !== process.pid),
      'plugin marketplace không được require in-process ở tiến trình test',
    );
  } finally {
    await client.destroyBot('bot-mkt92');
  }
});

test('createBot headless với pluginsSandbox:false: tool marketplace vẫn sandboxed', async () => {
  const { pluginsDir, markerFile } = await installMarketplaceFixture();
  const ws = makeTempDir('open-bot-mkt92-ws3-');
  const created = await client.createBot({
    bot: botConfig('bot-mkt92-nonsandbox', ws),
    provider: mockProvider([{ text: 'ok' }]),
    pluginsDir,
    pluginsSandbox: false,
  });
  try {
    assert.ok(created.toolNames.includes(TOOL_NAME));
    // v0.93a behaviour change: marketplace plugins are EXCLUDED from
    // the generic scan and load ONLY after signature verification, so
    // the coordinator child no longer requires the plugin in-process
    // first (v0.92a asserted >= 2 distinct pids here: coordinator
    // child + sandbox worker). The log must hold at least one pid —
    // the sandbox worker — and none of them this test process.
    const pids = [...new Set(loadedPids(markerFile))];
    assert.ok(
      pids.length >= 1,
      `expected >= 1 sandbox pid, got [${pids.join(', ')}]`,
    );
    assert.ok(
      pids.every((pid) => pid !== process.pid),
      'không pid nào được là tiến trình test',
    );
  } finally {
    await client.destroyBot('bot-mkt92-nonsandbox');
  }
});

test('createBot headless với pluginsDir trống: tạo bot bình thường, không tool marketplace', async () => {
  const ws = makeTempDir('open-bot-mkt92-ws4-');
  const emptyDir = makeTempDir('open-bot-mkt92-empty2-');
  const baseline = await client.createBot({
    bot: botConfig('bot-mkt92-empty-base', ws),
    provider: mockProvider([{ text: 'ok' }]),
  });
  await client.destroyBot('bot-mkt92-empty-base');
  const created = await client.createBot({
    bot: botConfig('bot-mkt92-empty', ws),
    provider: mockProvider([{ text: 'ok' }]),
    pluginsDir: emptyDir,
  });
  try {
    assert.equal(created.toolCount, baseline.toolCount);
    assert.ok(!created.toolNames.includes(TOOL_NAME));
  } finally {
    await client.destroyBot('bot-mkt92-empty');
  }
});
