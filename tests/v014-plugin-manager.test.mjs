/**
 * Tests for v0.14 PluginManager integration: sandboxed loading + bundle
 * discovery (packages/tools/src/plugins/manager.ts).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/v014-plugin-manager.test.mjs
 *
 * All fixtures are written to temp dirs; plugin code runs in a real
 * forked child process for the sandboxed cases. No network, no x.ai.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PluginManager } from '../packages/tools/dist/plugins/manager.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-mgr-v014-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

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
const pidTool = {
  definition: {
    name: 'whoami_pid',
    description: 'Return the pid of the process running this tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  needsApproval: false,
  execute: async () => String(process.pid),
};
module.exports = { tools: [echoTool, pidTool] };
`;

function writePlugin(dir, manifest, indexJs = ECHO_INDEX_JS) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf8');
  return dir;
}

function writeBundle(dir, manifest, extraFiles = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });

// ---------------------------------------------------------------------------
// scanDir discovers bundles
// ---------------------------------------------------------------------------

test('v0.14 manager: scanDir discovers a bundle (plugin.json + main) and collects its parts', () => {
  const pluginsDir = makeTempDir();
  writeBundle(
    path.join(pluginsDir, 'greet-bundle'),
    {
      id: 'greet-bundle',
      name: 'Greet Bundle',
      version: '1.0.0',
      description: 'Bundle with a tool, a skill, a slash command and an MCP server.',
      permissions: [],
      main: 'index.js',
      tools: ['echo'],
      skill: { name: 'greeter', description: 'Greets users.', instructions: 'Say hello.' },
      slashCommand: [{ name: 'greet', description: 'Greet someone.', file: 'commands/greet.md' }],
      mcpServer: { name: 'greet-mcp', command: 'node', args: ['server.js'] },
    },
    {
      'index.js': ECHO_INDEX_JS,
      'commands/greet.md': '# Greet\nSay hello to {{args}}.',
    },
  );
  const manager = new PluginManager(pluginsDir);
  const infos = manager.scanDir();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].manifest.id, 'greet-bundle');
  assert.deepEqual(infos[0].loadedTools, ['echo']);
  const parts = manager.listBundleParts();
  assert.equal(parts.length, 1);
  assert.equal(parts[0].skill?.name, 'greeter');
  assert.equal(parts[0].slashCommands.length, 1);
  assert.equal(parts[0].slashCommands[0].name, 'greet');
  assert.equal(parts[0].mcpServer?.name, 'greet-mcp');
  // Tool chạy được qua registry như plugin thường.
  const tools = manager.toolsForRegistry();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].definition.name, 'echo');
});

test('v0.14 manager: bundle without main loads no tools but parts are still collected', () => {
  const pluginsDir = makeTempDir();
  writeBundle(path.join(pluginsDir, 'skill-only'), {
    id: 'skill-only',
    name: 'Skill Only',
    version: '1.0.0',
    description: 'Bundle with only a skill.',
    permissions: [],
    skill: { name: 'helper', description: 'Helps.', instructions: 'Help.' },
  });
  const manager = new PluginManager(pluginsDir);
  const infos = manager.scanDir();
  assert.equal(infos.length, 0);
  assert.equal(manager.listBundleParts().length, 1);
  assert.equal(manager.listBundleParts()[0].skill?.name, 'helper');
  assert.deepEqual(manager.toolsForRegistry(), []);
});

// ---------------------------------------------------------------------------
// Sandboxed loading
// ---------------------------------------------------------------------------

test('v0.14 manager: loadSandboxed runs the tool in a child process (pid differs)', async () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), {
    id: 'echo-plugin',
    name: 'Echo Plugin',
    version: '1.0.0',
    description: 'A minimal valid plugin.',
    permissions: [],
    main: 'index.js',
  });
  const manager = new PluginManager(pluginsDir);
  const info = await manager.loadSandboxed('echo-plugin');
  assert.equal(info.manifest.id, 'echo-plugin');
  assert.deepEqual(info.loadedTools, ['echo', 'whoami_pid']);
  const status = manager.getSandboxedStatus('echo-plugin');
  assert.ok(status, 'expected a sandbox status');
  assert.equal(status.status, 'running');
  assert.ok(typeof status.pid === 'number' && status.pid !== process.pid);
  const tools = manager.toolsForRegistry();
  assert.equal(tools.length, 2);
  const pidTool = tools.find((t) => t.definition.name === 'whoami_pid');
  const out = await pidTool.execute({}, CTX(pluginsDir));
  assert.notEqual(Number(out), process.pid, 'tool must run in the child, not the host');
  assert.equal(Number(out), status.pid);
  const echoTool = tools.find((t) => t.definition.name === 'echo');
  assert.equal(await echoTool.execute({ text: 'hi' }, CTX(pluginsDir)), 'hi');
  await manager.disposeSandboxed();
  assert.equal(manager.getSandboxedStatus('echo-plugin'), undefined);
});

test('v0.14 manager: scanDirSandboxed loads manifest plugins sandboxed; disable hides their tools', async () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), {
    id: 'echo-plugin',
    name: 'Echo Plugin',
    version: '1.0.0',
    description: 'A minimal valid plugin.',
    permissions: [],
    main: 'index.js',
  });
  const manager = new PluginManager(pluginsDir);
  try {
    const infos = await manager.scanDirSandboxed();
    assert.equal(infos.length, 1);
    assert.equal(manager.toolsForRegistry().length, 2);
    assert.equal(manager.disable('echo-plugin'), true);
    assert.deepEqual(manager.toolsForRegistry(), []);
    assert.equal(manager.enable('echo-plugin'), true);
    assert.equal(manager.toolsForRegistry().length, 2);
  } finally {
    await manager.disposeSandboxed();
  }
});

test('v0.14 manager: unload disposes the sandbox host', async () => {
  const pluginsDir = makeTempDir();
  writePlugin(path.join(pluginsDir, 'echo-plugin'), {
    id: 'echo-plugin',
    name: 'Echo Plugin',
    version: '1.0.0',
    description: 'A minimal valid plugin.',
    permissions: [],
    main: 'index.js',
  });
  const manager = new PluginManager(pluginsDir);
  await manager.loadSandboxed('echo-plugin');
  assert.ok(manager.getSandboxedStatus('echo-plugin'));
  assert.equal(manager.unload('echo-plugin'), true);
  assert.equal(manager.getSandboxedStatus('echo-plugin'), undefined);
  assert.deepEqual(manager.toolsForRegistry(), []);
});
