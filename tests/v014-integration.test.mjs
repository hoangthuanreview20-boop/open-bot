/**
 * v014-integration.test.mjs — kiểm thử tích hợp v0.14 qua coordinator thật
 * (NDJSON-RPC, giống coordinator.test.mjs):
 *
 *  1. Plugin sandboxed (mặc định): createBot với pluginsDir chạy tool plugin
 *     qua runTool, tool chạy ở process khác (whoami_pid != pid của test).
 *  2. setPluginEnabled: tắt/bật tool cho bot ĐANG chạy (tool biến mất rồi
 *     xuất hiện lại trong runTool).
 *  3. Slash command từ Markdown workspace (.open-bot/commands/*.md):
 *     "/hello Huy" render thành prompt, progress event + history chứng minh.
 *  4. supervise: route task tới bot khớp skill nhất (dịch thuật vs git).
 *  5. Bundle: MCP server merge vào workspace .open-bot/mcp.json, tool
 *     bundle chạy được, slash của bundle resolve được.
 *  6. delegate_task shadow_workspace:true: agent con chạy trong git
 *     worktree, xong thì worktree được dọn sạch.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/v014-integration.test.mjs
 * Không mạng, không API key thật, không x.ai.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v014-'));
  tmpDirs.push(dir);
  return dir;
}

function botConfig(id, workspaceDir, extra = {}) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
    ...extra,
  };
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

function writeEchoPlugin(pluginsDir, id = 'echo-plugin') {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        name: 'Echo Plugin',
        version: '1.0.0',
        description: 'A minimal valid plugin.',
        permissions: [],
        main: 'index.js',
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'index.js'), ECHO_INDEX_JS, 'utf8');
  return dir;
}

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.14 sandboxed plugin: createBot chạy tool plugin qua runTool, tool ở process khác', async () => {
  const ws = tmpWorkspace();
  const pluginsDir = path.join(ws, 'plugins');
  writeEchoPlugin(pluginsDir);
  const created = await client.createBot({
    bot: botConfig('bot-plugin', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    pluginsDir,
  });
  assert.equal(created.toolCount, 261, `259 core + 2 plugin = 261, got ${created.toolCount}`); // v1.01 (Team T6): + 2 list_subagent_tree + fanout_tasks
  const echoed = await client.runTool('bot-plugin', 'echo', { text: 'xin chào' });
  assert.equal(echoed.output, 'xin chào');
  const pidOut = await client.runTool('bot-plugin', 'whoami_pid', {});
  const pluginPid = Number.parseInt(pidOut.output, 10);
  assert.ok(Number.isInteger(pluginPid) && pluginPid > 0, `pid phải là số, got ${pidOut.output}`);
  assert.notEqual(pluginPid, process.pid, 'tool plugin phải chạy ở process khác (sandbox), không phải process test');
});

test('v0.14 setPluginEnabled: tắt/bật tool cho bot đang chạy', async () => {
  const ws = tmpWorkspace();
  const pluginsDir = path.join(ws, 'plugins');
  writeEchoPlugin(pluginsDir);
  await client.createBot({
    bot: botConfig('bot-toggle', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    pluginsDir,
  });
  const off = await client.setPluginEnabled('bot-toggle', 'echo-plugin', false);
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(off.appliedToRunning, true, 'toggle phải áp dụng cho bot đang chạy, không chỉ bot mới');
  await assert.rejects(
    () => client.runTool('bot-toggle', 'echo', { text: 'hi' }),
    /Không tìm thấy tool "echo"/,
    'tool của plugin đã tắt phải biến mất khỏi runTool',
  );
  const on = await client.setPluginEnabled('bot-toggle', 'echo-plugin', true);
  assert.equal(on.enabled, true);
  const back = await client.runTool('bot-toggle', 'echo', { text: 'trở lại' });
  assert.equal(back.output, 'trở lại');
});

test('v0.14 slash: /hello từ Markdown workspace render thành prompt', async () => {
  const ws = tmpWorkspace();
  const cmdDir = path.join(ws, '.open-bot', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(
    path.join(cmdDir, 'hello.md'),
    '# Chào hỏi.\nChào {{args}}, tôi là bot test.\n',
    'utf8',
  );
  await client.createBot({
    bot: botConfig('bot-slash', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    tracesFile: path.join(ws, 'traces.jsonl'),
  });
  const progress = [];
  const unsubscribe = client.onEvent((e) => {
    if (e.kind === 'progress') progress.push(typeof e.payload === 'string' ? e.payload : '');
  });
  try {
    const run = await client.run('bot-slash', '/hello Huy');
    assert.equal(run.text, 'mock ok');
  } finally {
    unsubscribe();
  }
  assert.ok(
    progress.some((p) => p.includes('Đã chạy lệnh /hello.')),
    `phải có progress "Đã chạy lệnh /hello.", got ${JSON.stringify(progress)}`,
  );
  // run không ghi history (chỉ saveMessage mới ghi) — prompt đã render
  // chứng minh qua trace: span guardrail "input" ghi đúng user text.
  const traceText = fs.readFileSync(path.join(ws, 'traces.jsonl'), 'utf8');
  assert.ok(
    traceText.includes('Chào Huy, tôi là bot test.'),
    `trace phải chứa prompt đã render "Chào Huy, tôi là bot test.", got ${traceText.slice(0, 500)}`,
  );
  assert.ok(
    !traceText.includes('/hello Huy'),
    'trace không được chứa lệnh thô "/hello Huy" làm input (đã render xong mới đưa vào model)',
  );
});

test('v0.14 supervise: route task tới bot khớp skill nhất', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: botConfig('bot-dich', ws, {
      systemPrompt: 'Bạn là chuyên gia dịch thuật: dịch tài liệu, dịch văn bản tiếng Anh sang tiếng Việt.',
    }),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'dịch xong' }] },
  });
  await client.createBot({
    bot: botConfig('bot-git', ws, {
      systemPrompt: 'Bạn quản lý git và mã nguồn: commit, pull request, review code.',
    }),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'git xong' }] },
  });
  const result = await client.supervise({
    task: 'dịch tài liệu tiếng Anh sang tiếng Việt',
    agentIds: ['bot-dich', 'bot-git'],
  });
  assert.equal(result.mode, 'sequential');
  assert.equal(result.results.length, 1, 'sequential thành công ở agent đầu thì chỉ trả 1 kết quả');
  assert.equal(result.results[0].agentId, 'bot-dich', 'task dịch thuật phải route tới bot-dich');
  assert.equal(result.results[0].result, 'dịch xong');
});

test('v0.14 bundle: MCP server merge vào .open-bot/mcp.json, tool + slash bundle chạy', async () => {
  const ws = tmpWorkspace();
  const pluginsDir = path.join(ws, 'plugins');
  const bundleDir = path.join(pluginsDir, 'demo-bundle');
  fs.mkdirSync(path.join(bundleDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'index.js'), ECHO_INDEX_JS, 'utf8');
  fs.writeFileSync(
    path.join(bundleDir, 'commands', 'review.md'),
    '# Review code.\nReview code với {{args}}.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(bundleDir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'demo-bundle',
        name: 'Demo Bundle',
        version: '1.0.0',
        description: 'Bundle demo: tool + MCP + slash.',
        permissions: [],
        main: 'index.js',
        tools: ['echo', 'whoami_pid'],
        mcpServer: { name: 'notes-mcp', command: 'node', args: ['server.js'] },
        slashCommand: [{ name: 'review', description: 'Review code.', file: 'commands/review.md' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  const created = await client.createBot({
    bot: botConfig('bot-bundle', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'mock ok' }] },
    pluginsDir,
  });
  assert.equal(created.toolCount, 261, `259 core + 2 bundle tool = 261, got ${created.toolCount}`);
  const echoed = await client.runTool('bot-bundle', 'echo', { text: 'bundle ok' });
  assert.equal(echoed.output, 'bundle ok');
  const mcpJson = JSON.parse(fs.readFileSync(path.join(ws, '.open-bot', 'mcp.json'), 'utf8'));
  assert.ok(mcpJson.servers?.['notes-mcp'], 'bundle MCP server phải được merge vào workspace mcp.json');
  assert.equal(mcpJson.servers['notes-mcp'].command, 'node');
  const progress = [];
  const unsubscribe = client.onEvent((e) => {
    if (e.kind === 'progress') progress.push(typeof e.payload === 'string' ? e.payload : '');
  });
  try {
    await client.run('bot-bundle', '/review src/index.ts');
  } finally {
    unsubscribe();
  }
  assert.ok(
    progress.some((p) => p.includes('Đã chạy lệnh /review.')),
    `slash của bundle phải resolve được, got ${JSON.stringify(progress)}`,
  );
});

test('v0.14 delegate_task shadow_workspace: agent con chạy trong worktree rồi dọn sạch', async () => {
  const ws = tmpWorkspace();
  execFileSync('git', ['init', '-q', ws]);
  execFileSync('git', ['-C', ws, 'config', 'user.email', 'test@open-bot.local']);
  execFileSync('git', ['-C', ws, 'config', 'user.name', 'open-bot test']);
  fs.writeFileSync(path.join(ws, 'README.md'), '# test repo\n', 'utf8');
  execFileSync('git', ['-C', ws, 'add', '.']);
  execFileSync('git', ['-C', ws, 'commit', '-qm', 'init']);
  await client.createBot({
    bot: botConfig('bot-wt', ws),
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          text: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'delegate_task',
              args: { task: 'viết tài liệu ngắn', shadow_workspace: true },
            },
          ],
        },
        { text: 'đã xong' },
      ],
    },
  });
  const run = await client.run('bot-wt', 'giao việc cho agent con trong worktree');
  assert.equal(run.text, 'đã xong');
  const wtList = execFileSync('git', ['-C', ws, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const wtCount = wtList.split('\n').filter((l) => l.startsWith('worktree ')).length;
  assert.equal(wtCount, 1, `sau khi chạy xong chỉ còn worktree chính, got:\n${wtList}`);
  const wtDir = path.join(ws, '.open-bot', 'worktrees');
  assert.ok(
    !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0,
    'thư mục shadow worktree phải được dọn sạch',
  );
});
