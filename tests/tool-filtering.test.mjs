/**
 * Tests for v0.10a context-aware tool filtering + grouping (P0-4):
 *   packages/core/src/agent/toolFilter.ts
 *   packages/core/src/agent/permissions.ts (filterToolsFor / filterTools)
 *   packages/tools/src/registry.ts (filterTools / groupTools / filteredGroupedTools)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/tool-filtering.test.mjs
 * Không cần API key thật, không gọi mạng (mock provider + tool giả).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ESSENTIAL_TOOLS,
  READ_ONLY_TOOLS,
  estimateToolDefinitionTokens,
  estimateToolsTokens,
  filterTools,
  filterToolDefinitions,
  getToolGroups,
  groupTools,
  isReadOnlyTool,
  toolGroupFor,
} from '../packages/core/dist/agent/toolFilter.js';
import {
  AgentPermissions,
  filterToolsFor,
  filterToolsForBot,
} from '../packages/core/dist/agent/permissions.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name, opts = {}) {
  const calls = [];
  const tool = {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, query: { type: 'string' } },
      },
    },
    needsApproval: opts.needsApproval ?? false,
    calls,
    async execute(args) {
      calls.push(args);
      return `ok:${name}:${JSON.stringify(args)}`;
    },
  };
  return tool;
}

function names(tools) {
  return tools.map((t) => t.definition.name);
}

const FAKE_TOOLS = () => [
  makeTool('read_file'),
  makeTool('write_file', { needsApproval: true }),
  makeTool('delete_file', { needsApproval: true }),
  makeTool('list_files'),
  makeTool('glob_files'),
  makeTool('apply_diff', { needsApproval: true }),
  makeTool('shell_exec', { needsApproval: true }),
  makeTool('git_status'),
  makeTool('git_commit', { needsApproval: true }),
  makeTool('web_search'),
  makeTool('grep_search'),
  makeTool('ask_user'),
  makeTool('send_final_summary'),
  makeTool('mcp_call_tool', { needsApproval: true }),
];

const BOT = {
  id: 'bot-1',
  name: 'Test',
  providerId: 'mock',
  model: 'mock',
  systemPrompt: 'You are a test bot.',
  workspaceDir: '',
  autoApprove: true,
};

let callSeq = 0;
function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seenRequests.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents() {
  const events = {
    texts: [],
    toolCalls: [],
    toolResults: [],
    onText(d) {
      events.texts.push(d);
    },
    onToolCall(c) {
      events.toolCalls.push(c);
    },
    onToolResult(r) {
      events.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
  };
  return events;
}

/** 119 tool thật từ defaultToolFactory (BotMemory tạm, không gọi mạng). */
function realTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-toolfilter-'));
  const mem = new BotMemory(dir);
  const tools = defaultToolFactory(mem, dir, 'bot-1');
  return { dir, tools };
}

// ---------------------------------------------------------------------------
// filterTools: không options = giữ nguyên
// ---------------------------------------------------------------------------

test('filterTools không options trả bản sao y nguyên (thứ tự giữ nguyên)', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools);
  assert.deepEqual(names(out), names(tools));
  assert.notEqual(out, tools);
});

// ---------------------------------------------------------------------------
// Lớp 1: bot allowlist (AgentPermissions)
// ---------------------------------------------------------------------------

test('lọc theo bot allowlist: chỉ giữ tool trong allowTools (qua permissions, bot id string và BotConfig)', () => {
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['read_file', 'write_file', 'shell_exec'] });
  const tools = FAKE_TOOLS();
  assert.deepEqual(names(filterTools(tools, { bot: 'bot-1', permissions: perms })), [
    'read_file',
    'write_file',
    'shell_exec',
  ]);
  // bot dạng BotConfig object cũng được.
  assert.deepEqual(names(filterTools(tools, { bot: BOT, permissions: perms })), [
    'read_file',
    'write_file',
    'shell_exec',
  ]);
  // policy trực tiếp, không cần instance.
  assert.deepEqual(
    names(filterTools(tools, { policy: { allowTools: ['git_status'] } })),
    ['git_status'],
  );
});

test('lọc theo bot allowlist: deny thắng allow (denyTools + policies.deny)', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools, {
    policy: { allowTools: ['read_file', 'write_file', 'shell_exec'], denyTools: ['write_file'] },
  });
  assert.deepEqual(names(out), ['read_file', 'shell_exec']);
  const out2 = filterTools(tools, {
    policy: { allowTools: ['read_file', 'write_file'], policies: { write_file: 'deny' } },
  });
  assert.deepEqual(names(out2), ['read_file']);
});

test('permissions: filterToolsFor (pure) + AgentPermissions.filterTools + filterToolsForBot', () => {
  const tools = FAKE_TOOLS();
  const policy = { allowTools: ['read_file', 'git_status'] };
  assert.deepEqual(names(filterToolsFor(policy, tools)), ['read_file', 'git_status']);
  // Bot chưa có policy = allow all mặc định.
  const perms = new AgentPermissions();
  assert.equal(perms.filterTools('bot-chua-co-policy', tools).length, tools.length);
  perms.setBotPolicy('bot-1', policy);
  assert.deepEqual(names(perms.filterTools('bot-1', tools)), ['read_file', 'git_status']);
  assert.deepEqual(names(filterToolsForBot(perms, 'bot-1', tools)), ['read_file', 'git_status']);
});

// ---------------------------------------------------------------------------
// Lớp 2: skill đang bật (allowed-tools)
// ---------------------------------------------------------------------------

test('lọc theo skill: chỉ giữ hợp tools của skill đang bật + tool giao tiếp thiết yếu', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools, {
    activeSkills: [{ name: 'code-review', tools: ['read_file', 'grep_search', 'git_status'] }],
  });
  assert.deepEqual(names(out), ['read_file', 'git_status', 'grep_search', 'ask_user', 'send_final_summary']);
  // Skill dùng field agentskills `allowedTools` cũng được.
  const out2 = filterTools(tools, {
    activeSkills: [{ name: 'research', tools: [], allowedTools: ['web_search'] }],
  });
  assert.deepEqual(names(out2), ['web_search', 'ask_user', 'send_final_summary']);
});

test('lọc theo skill: skill không khai tool nào thì không lọc gì (chỉ là hướng dẫn)', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools, {
    activeSkills: [{ name: 'writing-vi', tools: [] }],
  });
  assert.equal(out.length, tools.length);
  const out2 = filterTools(tools, { activeSkills: [] });
  assert.equal(out2.length, tools.length);
});

// ---------------------------------------------------------------------------
// Lớp 3: mode — plan/review chỉ tool đọc
// ---------------------------------------------------------------------------

test('plan mode: chỉ giữ tool chỉ-đọc + tool giao tiếp thiết yếu, loại tool ghi/shell', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools, { mode: 'plan' });
  for (const t of out) {
    assert.ok(
      isReadOnlyTool(t.definition.name) || ESSENTIAL_TOOLS.has(t.definition.name),
      `${t.definition.name} không được phép ở plan mode`,
    );
  }
  assert.ok(!names(out).includes('write_file'));
  assert.ok(!names(out).includes('delete_file'));
  assert.ok(!names(out).includes('apply_diff'));
  assert.ok(!names(out).includes('shell_exec'));
  assert.ok(!names(out).includes('git_commit'));
  assert.ok(!names(out).includes('mcp_call_tool'));
  assert.ok(names(out).includes('read_file'));
  assert.ok(names(out).includes('ask_user'));
  // review mode cùng luật.
  assert.deepEqual(
    names(filterTools(tools, { mode: 'review' })),
    names(out),
  );
  // chat/grind không giới hạn theo mode.
  assert.equal(filterTools(tools, { mode: 'chat' }).length, tools.length);
  assert.equal(filterTools(tools, { mode: 'grind' }).length, tools.length);
});

test('plan mode trên 119 tool thật: mọi tool còn lại đều chỉ-đọc, tool ghi bị loại hết', () => {
  const { tools } = realTools();
  assert.ok(tools.length >= 100, `dự kiến ~119 tool, thực tế ${tools.length}`);
  const out = filterTools(tools, { mode: 'plan' });
  const expected = tools.filter(
    (t) => READ_ONLY_TOOLS.has(t.definition.name) || ESSENTIAL_TOOLS.has(t.definition.name),
  );
  assert.equal(out.length, expected.length);
  for (const t of out) {
    assert.ok(
      READ_ONLY_TOOLS.has(t.definition.name) || ESSENTIAL_TOOLS.has(t.definition.name),
      `${t.definition.name} không được phép ở plan mode`,
    );
  }
  for (const banned of ['write_file', 'shell_exec', 'git_commit', 'delete_file', 'mcp_call_tool', 'email_send', 'slack_send']) {
    assert.ok(!names(out).includes(banned), `${banned} phải bị loại ở plan mode`);
  }
  console.log(`plan mode trên tool thật: ${tools.length} -> ${out.length} tool`);
});

test('kết hợp 3 lớp: bot allowlist + skill + plan mode giao nhau', () => {
  const tools = FAKE_TOOLS();
  const out = filterTools(tools, {
    bot: 'bot-1',
    permissions: (() => {
      const p = new AgentPermissions();
      p.setBotPolicy('bot-1', { allowTools: ['read_file', 'write_file', 'git_status', 'web_search'] });
      return p;
    })(),
    activeSkills: [{ name: 'research', tools: ['read_file', 'web_search', 'git_status'] }],
    mode: 'plan',
  });
  // write_file rớt ở plan mode (ghi); còn lại read_file + git_status + web_search.
  // Lưu ý: ask_user/send_final_summary KHÔNG được giữ ở đây — bot allowlist
  // (lớp 1) là ranh giới an ninh, không có ngoại lệ ESSENTIAL_TOOLS.
  assert.deepEqual(names(out), ['read_file', 'git_status', 'web_search']);
});

test('filterToolDefinitions: cùng luật lọc, áp trên definitions (phía provider)', () => {
  const tools = FAKE_TOOLS();
  const defs = tools.map((t) => t.definition);
  const out = filterToolDefinitions(defs, { mode: 'plan' });
  assert.deepEqual(
    out.map((d) => d.name),
    names(filterTools(tools, { mode: 'plan' })),
  );
});

// ---------------------------------------------------------------------------
// Gom nhóm
// ---------------------------------------------------------------------------

test('toolGroupFor: file/git/shell/mcp/computer/plan/web theo tên', () => {
  assert.equal(toolGroupFor('read_file'), 'file');
  assert.equal(toolGroupFor('write_file'), 'file');
  assert.equal(toolGroupFor('apply_diff'), 'file');
  assert.equal(toolGroupFor('git_status'), 'git');
  assert.equal(toolGroupFor('pr_create'), 'git');
  assert.equal(toolGroupFor('shell_exec'), 'shell');
  assert.equal(toolGroupFor('shell_session_read'), 'shell');
  assert.equal(toolGroupFor('mcp_call_tool'), 'mcp');
  assert.equal(toolGroupFor('computer_screenshot'), 'computer');
  assert.equal(toolGroupFor('task_list'), 'plan');
  assert.equal(toolGroupFor('grind_start'), 'plan');
  assert.equal(toolGroupFor('web_search'), 'web');
  assert.equal(toolGroupFor('x_search'), 'web');
  assert.equal(toolGroupFor('canvas_read'), 'canvas');
  assert.equal(toolGroupFor('memory_recall'), 'memory');
  assert.equal(toolGroupFor('image_generate'), 'media');
});

test('groupTools: nhóm file.* thành một tool điều phối, tool lẻ giữ nguyên, dispatch chạy tool gốc', async () => {
  const tools = FAKE_TOOLS();
  const grouped = groupTools(tools);
  // file: 6 thành viên -> 1; git: git_status + git_commit -> 1; còn lại lẻ.
  const groupedNames = names(grouped);
  assert.ok(groupedNames.includes('file'));
  assert.ok(groupedNames.includes('git'));
  assert.ok(!groupedNames.includes('read_file'));
  assert.ok(!groupedNames.includes('write_file'));
  assert.ok(!groupedNames.includes('git_status'));
  assert.ok(groupedNames.includes('shell_exec')); // lẻ -> giữ nguyên
  assert.ok(groupedNames.includes('web_search'));
  assert.ok(grouped.length < tools.length);
  // Dispatcher file: needsApproval = true vì write_file/apply_diff cần duyệt.
  const fileGroup = grouped.find((t) => t.definition.name === 'file');
  assert.equal(fileGroup.needsApproval, true);
  assert.deepEqual(fileGroup.definition.parameters.properties.operation.enum, [
    'read_file',
    'write_file',
    'delete_file',
    'list_files',
    'glob_files',
    'apply_diff',
  ]);
  // Dispatch về tool gốc.
  const ctx = { workspaceDir: '', botId: 'bot-1' };
  const out = await fileGroup.execute({ operation: 'read_file', args: { path: 'a.txt' } }, ctx);
  assert.match(out, /^ok:read_file:/);
  const readTool = tools.find((t) => t.definition.name === 'read_file');
  assert.deepEqual(readTool.calls, [{ path: 'a.txt' }]);
  // Operation không có trong nhóm -> lỗi rõ ràng, liệt kê operation hợp lệ.
  await assert.rejects(
    () => fileGroup.execute({ operation: 'shell_exec', args: {} }, ctx),
    /operation phải là một trong/,
  );
});

test('groupTools: tên nhóm đụng tool đã có thì đổi thành <nhóm>_group (không ghi đè)', () => {
  const tools = [makeTool('file'), makeTool('read_file'), makeTool('write_file')];
  const grouped = groupTools(tools);
  assert.deepEqual(names(grouped), ['file', 'file_group']);
});

test('groupTools: minGroupSize=3 thì nhóm 2 thành viên không gộp', () => {
  const tools = FAKE_TOOLS();
  const grouped = groupTools(tools, { minGroupSize: 3 });
  assert.ok(!names(grouped).includes('git')); // git chỉ có 2 thành viên
  assert.ok(names(grouped).includes('file')); // file có 6 thành viên
});

test('getToolGroups: gom đúng thành viên theo nhóm', () => {
  const groups = getToolGroups(FAKE_TOOLS());
  const file = groups.find((g) => g.name === 'file');
  assert.deepEqual(names(file.members), [
    'read_file',
    'write_file',
    'delete_file',
    'list_files',
    'glob_files',
    'apply_diff',
  ]);
});

// ---------------------------------------------------------------------------
// Đo token: trước/sau lọc + gom nhóm trên 119 tool thật
// ---------------------------------------------------------------------------

test('đo token ước lượng: 119 tool thật -> lọc plan mode + gom nhóm giảm mạnh', () => {
  const { tools } = realTools();
  const beforeDefs = tools.length;
  const beforeTokens = estimateToolsTokens(tools);
  const filtered = filterTools(tools, { mode: 'plan' });
  const filteredTokens = estimateToolsTokens(filtered);
  const grouped = groupTools(filtered);
  const groupedTokens = estimateToolsTokens(grouped);
  console.log(
    `token ước lượng (đã hiệu chuẩn): ${beforeDefs} defs / ~${beforeTokens} token ` +
      `-> plan-filtered ${filtered.length} defs / ~${filteredTokens} token ` +
      `-> +grouped ${grouped.length} defs / ~${groupedTokens} token`,
  );
  assert.ok(beforeTokens > 1000, `kỳ vọng >1000 token, thực tế ${beforeTokens}`);
  assert.ok(filteredTokens < beforeTokens);
  assert.ok(grouped.length < filtered.length);
  assert.ok(groupedTokens < filteredTokens);
  // Sau lọc+gom phải dưới ngưỡng context local 4.096 token (ước lượng mới theo từ/CJK).
  assert.ok(
    groupedTokens < 4096,
    `sau lọc+gom còn ~${groupedTokens} token, vẫn trên context 4.096 của model local`,
  );
  // Sanity: estimator đếm đúng 1 definition (≥ 1, cùng bậc độ lớn với
  // chars/4 cũ). Đo thật trên 123 tool (v0.24 W17b, estimator đã hiệu
  // chuẩn): estimator / chars4 = 0,84–1,48 (trung bình 1,04) vì JSON
  // nhiều dấu câu — band [0,8x–1,5x] phản ánh đúng hành vi đã đo,
  // không phải đoán.
  const one = estimateToolDefinitionTokens(tools[0].definition);
  const chars4 = Math.ceil(JSON.stringify(tools[0].definition).length / 4);
  assert.ok(one >= 1 && one >= chars4 * 0.8 && one <= chars4 * 1.5);
});

// ---------------------------------------------------------------------------
// ToolRegistry: API filter/nhóm mới, API cũ giữ nguyên
// ---------------------------------------------------------------------------

test('ToolRegistry.filterTools/groupTools/filteredGroupedTools/estimateTokens (API cũ không đổi)', async () => {
  const tools = FAKE_TOOLS();
  const registry = ToolRegistry.fromDefaults(tools);
  assert.equal(registry.size(), tools.length);
  // API cũ: get/list/execute vẫn chạy.
  assert.equal(registry.get('read_file').definition.name, 'read_file');
  const out = await registry.execute('read_file', { path: 'x' }, { workspaceDir: '', botId: 'b' });
  assert.match(out, /^ok:read_file:/);
  // API mới: filter theo plan mode.
  const filtered = registry.filterTools({ mode: 'plan' });
  assert.deepEqual(
    names(filtered),
    names(filterTools(tools, { mode: 'plan' })),
  );
  // API mới: group.
  const grouped = registry.groupTools();
  assert.ok(names(grouped).includes('file'));
  assert.ok(grouped.length < tools.length);
  // API mới: lọc + gom một lần.
  const both = registry.filteredGroupedTools({ mode: 'plan' });
  assert.deepEqual(names(both), names(groupTools(filterTools(tools, { mode: 'plan' }))));
  assert.ok(names(both).includes('file'));
  assert.ok(!names(both).includes('write_file'));
  // API mới: đo token.
  assert.equal(registry.estimateTokens(), estimateToolsTokens(tools));
  assert.ok(registry.estimateTokens(both) < registry.estimateTokens());
});

// ---------------------------------------------------------------------------
// AgentRunner nhận list đã lọc qua constructor (không sửa loop.ts)
// ---------------------------------------------------------------------------

test('AgentRunner với tool đã lọc: provider chỉ thấy definitions đã lọc, tool chạy được', async () => {
  const tools = FAKE_TOOLS();
  const filtered = filterTools(tools, { mode: 'plan' });
  const seen = [];
  const provider = scriptedProvider(
    [
      { toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'xong' },
    ],
    seen,
  );
  const events = makeEvents();
  const runner = new AgentRunner(provider, filtered, { bot: BOT, events });
  const result = await runner.run('đọc file a.txt');
  assert.equal(result, 'xong');
  // Provider chỉ nhận definitions đã lọc (không có write_file/shell_exec).
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    names(filtered),
  );
  assert.ok(!seen[0].tools.some((d) => d.name === 'write_file'));
  assert.equal(events.toolCalls[0].name, 'read_file');
  assert.match(events.toolResults[0].output, /^ok:read_file:/);
});
