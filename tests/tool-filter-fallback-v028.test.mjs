/**
 * Tests for v0.28 context-aware tool filtering — controlled fail-open
 * fallback when a filter comes back empty (P0-4, phần còn thiếu sau v0.10a):
 *   packages/core/src/agent/permissions.ts (filterToolsFor / filterTools /
 *     filterToolsForBot — opts.fallbackOnEmpty, mặc định fail-closed)
 *   packages/tools/src/registry.ts (filterTools / filteredGroupedTools —
 *     fallback về baseline bot allowlist + mode, không vượt ranh giới an toàn)
 *   packages/core/src/agent/loop.ts (toolsForTurn / forcedSmallModelTools —
 *     fallback mỗi turn + lọc allowlist mặc định khi không cấu hình toolFilter)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/tool-filter-fallback-v028.test.mjs
 * Không cần API key thật. Phần lớn test dùng mock provider + tool giả;
 * 1 test live dùng Ollama local thật (qwen2.5:0.5b) nếu đang chạy, còn
 * không thì skip — không fail khi Ollama chưa được cài/pull.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { filterTools, estimateToolsTokens, groupTools } from '../packages/core/dist/agent/toolFilter.js';
import {
  AgentPermissions,
  filterToolsFor,
  filterToolsForBot,
} from '../packages/core/dist/agent/permissions.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { OllamaProvider } from '../packages/core/dist/providers/ollama.js';
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

/**
 * Bản không có tool giao tiếp thiết yếu — lớp skill/mode luôn giữ
 * ESSENTIAL_TOOLS nên chỉ list này mới lọc rỗng được qua lớp skill
 * (skill khai `allowed-tools` sai tên, không khớp tool nào).
 */
const FAKE_TOOLS_NO_ESSENTIAL = () => [
  makeTool('read_file'),
  makeTool('write_file', { needsApproval: true }),
  makeTool('delete_file', { needsApproval: true }),
  makeTool('list_files'),
  makeTool('shell_exec', { needsApproval: true }),
  makeTool('git_status'),
  makeTool('git_commit', { needsApproval: true }),
  makeTool('web_search'),
  makeTool('grep_search'),
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

/** Bắt console.warn trong một test, trả về mảng message đã bắt. */
function captureWarnings(t) {
  const caught = [];
  const original = console.warn;
  console.warn = (...args) => {
    caught.push(args.join(' '));
  };
  t.after(() => {
    console.warn = original;
  });
  return caught;
}

/** 119 tool thật từ defaultToolFactory (BotMemory tạm, không gọi mạng). */
function realTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-toolfilter-fb-'));
  const mem = new BotMemory(dir);
  const tools = defaultToolFactory(mem, dir, 'bot-1');
  return { dir, tools };
}

/** Skill khai `allowed-tools` sai tên — không khớp tool nào. */
const TYPO_SKILL = { name: 'skill-sai-ten', tools: ['khong_co_tool_nay'] };

// ---------------------------------------------------------------------------
// permissions.ts: fallbackOnEmpty opt-in (mặc định fail-closed)
// ---------------------------------------------------------------------------

test('permissions: filterToolsFor mặc định fail-closed khi allowlist không khớp tool nào', (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const out = filterToolsFor({ allowTools: ['khong_co_tool_nay'] }, tools);
  assert.equal(out.length, 0);
  assert.equal(warnings.length, 0, 'fail-closed thì không warn fallback');
});

test('permissions: filterToolsFor fallbackOnEmpty=true thì log cảnh báo + trả đủ tool như cũ', (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const out = filterToolsFor({ allowTools: ['khong_co_tool_nay'] }, tools, { fallbackOnEmpty: true });
  assert.equal(out.length, tools.length);
  assert.deepEqual(names(out), names(tools));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[permissions\] filter rỗng/);
  assert.match(warnings[0], /fallback/);
});

test('permissions: AgentPermissions.filterTools + filterToolsForBot nhận opts fallbackOnEmpty', (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['khong_co_tool_nay'] });
  // Mặc định: rỗng, không warn.
  assert.equal(perms.filterTools('bot-1', tools).length, 0);
  assert.equal(warnings.length, 0);
  // Opt-in: đủ tool + 1 cảnh báo.
  assert.equal(perms.filterTools('bot-1', tools, { fallbackOnEmpty: true }).length, tools.length);
  assert.equal(filterToolsForBot(perms, 'bot-1', tools, { fallbackOnEmpty: true }).length, tools.length);
  assert.equal(warnings.length, 2);
});

// ---------------------------------------------------------------------------
// registry.ts: fallback về baseline bot allowlist + mode
// ---------------------------------------------------------------------------

test('registry.filterTools: skill sai tên → fallback đủ tool như cũ + cảnh báo', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS_NO_ESSENTIAL());
  const out = registry.filterTools({ activeSkills: [TYPO_SKILL] });
  assert.equal(out.length, 9);
  assert.deepEqual(names(out), names(FAKE_TOOLS_NO_ESSENTIAL()));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[tools\] tool filter rỗng/);
  assert.match(warnings[0], /fallback sang 9\/9 tool/);
});

test('registry.filterTools: skill sai tên + allowlist → fallback chỉ trong allowlist, không vượt ranh giới', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS_NO_ESSENTIAL());
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['read_file', 'git_status'] });
  const out = registry.filterTools({
    bot: 'bot-1',
    permissions: perms,
    activeSkills: [TYPO_SKILL],
  });
  assert.deepEqual(names(out), ['read_file', 'git_status']);
  assert.match(warnings[0], /fallback sang 2\/9 tool/);
});

test('registry.filterTools: allowlist chỉ tên không tồn tại → vẫn rỗng (fail-closed), không fallback qua policy', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS());
  const out = registry.filterTools({ policy: { allowTools: ['khong_co_tool_nay'] } });
  assert.equal(out.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fail-closed/);
});

test('registry.filterTools: plan mode + allowlist chỉ tool ghi → vẫn rỗng (mode chỉ-đọc được tôn trọng)', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS());
  const out = registry.filterTools({
    policy: { allowTools: ['write_file'] },
    mode: 'plan',
  });
  assert.equal(out.length, 0);
  assert.match(warnings[0], /fail-closed/);
});

test('registry.filterTools: filter bình thường không rỗng thì không warn, không fallback', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS());
  const out = registry.filterTools({ mode: 'plan' });
  assert.ok(out.length > 0);
  assert.ok(!names(out).includes('write_file'));
  assert.equal(warnings.length, 0);
});

test('registry.filteredGroupedTools: skill sai tên → fallback rồi gom nhóm như cũ', (t) => {
  const warnings = captureWarnings(t);
  const registry = ToolRegistry.fromDefaults(FAKE_TOOLS_NO_ESSENTIAL());
  const out = registry.filteredGroupedTools({ activeSkills: [TYPO_SKILL] });
  assert.ok(names(out).includes('file'), 'fallback đủ tool rồi gom nhóm file.*');
  assert.ok(!names(out).includes('read_file'));
  assert.ok(out.length < 9);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fallback/);
});

// ---------------------------------------------------------------------------
// loop.ts: fallback mỗi turn + allowlist mặc định
// ---------------------------------------------------------------------------

test('loop: skill sai tên → provider thấy đủ tool (fallback), turn chạy xong', async (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS_NO_ESSENTIAL();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: BOT,
    events: makeEvents(),
    toolFilter: { activeSkills: [TYPO_SKILL], group: false },
  });
  const result = await runner.run('làm gì đó');
  assert.equal(result, 'xong');
  assert.equal(seen[0].tools.length, tools.length, 'fallback gửi đủ tool như cũ');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[agent-loop\] tool filter rỗng/);
});

test('loop: skill sai tên + allowlist → provider chỉ thấy tool trong allowlist', async (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS_NO_ESSENTIAL();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['read_file', 'git_status'] });
  const runner = new AgentRunner(provider, tools, {
    bot: BOT,
    events: makeEvents(),
    permissions: perms,
    toolFilter: { activeSkills: [TYPO_SKILL], group: false },
  });
  const result = await runner.run('làm gì đó');
  assert.equal(result, 'xong');
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    ['read_file', 'git_status'],
  );
  assert.equal(warnings.length, 1);
});

test('loop: không cấu hình toolFilter → allowlist mặc định vẫn lọc (deny tool không tới được model)', async (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { denyTools: ['shell_exec'] });
  const runner = new AgentRunner(provider, tools, {
    bot: BOT,
    events: makeEvents(),
    permissions: perms,
  });
  const result = await runner.run('làm gì đó');
  assert.equal(result, 'xong');
  assert.equal(seen[0].tools.length, tools.length - 1);
  assert.ok(!seen[0].tools.some((d) => d.name === 'shell_exec'));
  assert.equal(warnings.length, 0, 'filter không rỗng thì không warn');
});

test('loop: không cấu hình toolFilter, không policy → provider thấy đủ tool như hành vi cũ', async (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, { bot: BOT, events: makeEvents() });
  assert.equal(await runner.run('chào'), 'xong');
  assert.equal(seen[0].tools.length, tools.length);
  assert.equal(warnings.length, 0);
});

test('loop: plan mode + allowlist chỉ tool ghi → provider thấy 0 tool, turn text-only (fail-closed, không crash)', async (t) => {
  const warnings = captureWarnings(t);
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'đây là plan, chưa chạy tool nào' }], seen);
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['write_file'] });
  const runner = new AgentRunner(provider, tools, {
    bot: BOT,
    events: makeEvents(),
    permissions: perms,
    toolFilter: { mode: 'plan', group: false },
  });
  const result = await runner.run('lập plan');
  assert.equal(result, 'đây là plan, chưa chạy tool nào');
  assert.equal(seen[0].tools.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fail-closed/);
});

test('loop: small-model guard + skill sai tên + allowlist đọc/ghi → fallback về tool đọc của plan mode', async (t) => {
  const warnings = captureWarnings(t);
  const { tools } = realTools();
  assert.ok(tools.length >= 100);
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-1', { allowTools: ['read_file', 'write_file'] });
  const runner = new AgentRunner(provider, tools, {
    bot: { ...BOT, model: 'qwen2.5:0.5b' },
    events: makeEvents(),
    permissions: perms,
    toolFilter: { activeSkills: [TYPO_SKILL] },
    smallModel: { contextLimit: 4096 },
  });
  const result = await runner.run('đọc file');
  assert.equal(result, 'xong');
  // Fallback baseline = allowlist ∩ plan mode (chỉ-đọc) = read_file, gom nhóm giữ nguyên (lẻ).
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    ['read_file'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[agent-loop\] tool filter rỗng/);
});

// ---------------------------------------------------------------------------
// E2E mock: chứng minh số token tool giảm (119 tool thật)
// ---------------------------------------------------------------------------

test('e2e mock: tool thật — plan mode + gom nhóm giảm mạnh token, loop gửi đúng list đã lọc', async (t) => {
  const warnings = captureWarnings(t);
  const { tools } = realTools();
  assert.ok(tools.length >= 100, `dự kiến ~120 tool, thực tế ${tools.length}`);
  const fullTokens = estimateToolsTokens(tools);
  const planFiltered = filterTools(tools, { mode: 'plan' });
  const grouped = groupTools(planFiltered);
  const groupedTokens = estimateToolsTokens(grouped);
  console.log(
    `e2e mock token tool: ${tools.length} defs / ~${fullTokens} token ` +
      `-> plan ${planFiltered.length} defs -> +grouped ${grouped.length} defs / ~${groupedTokens} token`,
  );
  assert.ok(fullTokens > 4096, `đủ tool phải vượt context 4096 (thực tế ~${fullTokens})`);
  assert.ok(groupedTokens < 4096, `sau lọc+gom phải vừa context 4096 (thực tế ~${groupedTokens})`);
  assert.ok(groupedTokens < fullTokens / 2, 'giảm hơn một nửa token tool');

  const seen = [];
  const provider = scriptedProvider([{ text: 'đã xong plan' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: BOT,
    events: makeEvents(),
    toolFilter: { mode: 'plan' },
  });
  assert.equal(await runner.run('lập plan đọc code'), 'đã xong plan');
  const sentDefs = seen[0].tools;
  assert.deepEqual(
    sentDefs.map((d) => d.name),
    grouped.map((g) => g.definition.name),
  );
  assert.ok(estimateToolsTokens(sentDefs) < 4096);
  assert.ok(!sentDefs.some((d) => d.name === 'write_file'));
  assert.ok(!sentDefs.some((d) => d.name === 'shell_exec'));
  assert.ok(sentDefs.some((d) => d.name === 'file'), 'nhóm file.* đã gom thành dispatcher');
  assert.equal(warnings.length, 0, 'filter không rỗng thì không warn');
});

// ---------------------------------------------------------------------------
// E2E live: Ollama local qwen2.5:0.5b (nếu có) — request đã lọc vừa context 4096
// ---------------------------------------------------------------------------

/** Probe nhanh: Ollama có chạy + đã pull qwen2.5:0.5b không. */
async function ollamaHasQwen05b() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.models ?? []).some((m) => String(m.name ?? '').startsWith('qwen2.5:0.5b'));
  } catch {
    return false;
  }
}

const OLLAMA_READY = await ollamaHasQwen05b();
if (!OLLAMA_READY) {
  console.log('[tool-filter-fallback] Ollama local / qwen2.5:0.5b không có — skip test live, mock đã chứng minh giảm token.');
}

test(
  'e2e live Ollama qwen2.5:0.5b: request plan mode + gom nhóm vừa context 4096, trả text (không 400)',
  // v0.85: 120s -> 240s — the 0.5b model prefills the whole tool
  // registry on a small CPU VM; under parallel-suite load that
  // alone can exceed 120s (green at v084 but already at 74s, 62%
  // of budget). Same 240s allowance UI-8 uses for a live turn.
  { timeout: 240_000 },
  async (t) => {
    if (!OLLAMA_READY) {
      t.skip('Ollama local / qwen2.5:0.5b không có trên máy này');
      return;
    }
    const { tools } = realTools();
    const provider = new OllamaProvider({
      id: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
    const seen = [];
    const spying = {
      ...provider,
      async chat(req) {
        seen.push(req);
        return provider.chat(req);
      },
      async listModels() {
        return provider.listModels();
      },
    };
    const runner = new AgentRunner(spying, tools, {
      bot: {
        id: 'bot-1',
        name: 'Test',
        providerId: 'ollama',
        model: 'qwen2.5:0.5b',
        systemPrompt: 'Bạn là trợ lý ngắn gọn, trả lời bằng tiếng Việt.',
        workspaceDir: '',
        autoApprove: true,
      },
      events: makeEvents(),
      maxSteps: 2,
      toolFilter: { mode: 'plan' },
      smallModel: { contextLimit: 4096 },
    });
    const result = await runner.run('Chào bạn, bạn là ai? Trả lời trong một câu ngắn.');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0, 'model local phải trả text (không lỗi 400 vì quá context)');
    assert.ok(seen.length >= 1);
    const sentTokens = estimateToolsTokens(seen[0].tools);
    console.log(
      `e2e live Ollama: gửi ${seen[0].tools.length} tool defs / ~${sentTokens} token ` +
        `(đủ tool là ~${estimateToolsTokens(tools)} token) — model trả: ${JSON.stringify(result.slice(0, 120))}`,
    );
    assert.ok(sentTokens < 4096, `tool đã lọc phải vừa context 4096 (thực tế ~${sentTokens})`);
    assert.ok(seen[0].tools.length < tools.length);
  },
);
