/**
 * Tests for the v0.19 (W12a) small-model guardrail:
 *   packages/core/src/agent/smallModel.ts
 *   packages/core/src/agent/loop.ts (guard at the start of runLoop)
 *
 * Gap: model local nhỏ (vd context 4.096 token) lỗi 400 vì 119 tool nạp
 * vào mỗi request quá nặng, và chưa có rào chắn nào khi model có context
 * nhỏ. Guard: model nhỏ (≤ 8k) → ép filtering + grouping mạnh nhất
 * (plan mode + grouping), ước lượng lại → vẫn vượt thì dừng run với lỗi
 * tiếng Việt rõ ràng thay vì để provider trả 400.
 *
 * Không gọi provider thật, không API key, không mạng (mock provider +
 * tool giả; tool thật từ defaultToolFactory chỉ để đếm/đo token).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/small-model-v019.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SMALL_CONTEXT_THRESHOLD_TOKENS,
  SmallModelContextError,
  assertFitsSmallModel,
  effectiveContextLimit,
  estimateFirstRequestTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  inferContextLimitFromModelName,
  isSmallContextModel,
} from '../packages/core/dist/agent/smallModel.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { estimateToolsTokens } from '../packages/core/dist/agent/toolFilter.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTool(name, opts = {}) {
  return {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, query: { type: 'string' } },
      },
    },
    needsApproval: opts.needsApproval ?? false,
    async execute(args) {
      return `ok:${name}:${JSON.stringify(args)}`;
    },
  };
}

/** ~24 tool trộn đọc/ghi/shell/web/git/comms — mô phỏng list nặng. */
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
  makeTool('send_message_to_user'),
  makeTool('mcp_call_tool', { needsApproval: true }),
  makeTool('task_list'),
  makeTool('goal_list'),
  makeTool('memory_recall'),
  makeTool('system_info'),
  makeTool('computer_screenshot'),
  makeTool('email_read'),
  makeTool('slack_read'),
  makeTool('canvas_read'),
  makeTool('pr_list'),
];

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

function makeBot(overrides = {}) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: '',
    autoApprove: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSmallContextModel: ngưỡng 8k, đúng hai phía biên
// ---------------------------------------------------------------------------

test('isSmallContextModel: ngưỡng 8192 — 8192 là nhỏ, 8193 không còn nhỏ', () => {
  assert.equal(SMALL_CONTEXT_THRESHOLD_TOKENS, 8192);
  assert.equal(isSmallContextModel('model-bat-ky', 8192), true);
  assert.equal(isSmallContextModel('model-bat-ky', 8193), false);
  assert.equal(isSmallContextModel('model-bat-ky', 4096), true);
  assert.equal(isSmallContextModel('model-bat-ky', 128_000), false);
  assert.equal(isSmallContextModel('model-bat-ky', 32_768), false);
  assert.equal(isSmallContextModel('model-bat-ky', 0), true);
});

test('isSmallContextModel: không có contextLimit thì suy ra từ tên model, tên lạ không đoán', () => {
  assert.equal(isSmallContextModel('qwen2.5:0.5b-4k'), true);
  assert.equal(isSmallContextModel('llama-ctx4096'), true);
  assert.equal(isSmallContextModel('local-model-8k'), true);
  assert.equal(isSmallContextModel('local-model-16k'), false);
  assert.equal(isSmallContextModel('gpt-4o'), false);
  assert.equal(isSmallContextModel('qwen2.5:0.5b'), false);
  assert.equal(isSmallContextModel('llama-3.2-1b'), false);
  assert.equal(isSmallContextModel(''), false);
  // contextLimit tường minh thắng tên: tên ghi 4k nhưng limit thật 128k.
  assert.equal(isSmallContextModel('model-4k', 128_000), false);
  assert.equal(isSmallContextModel('gpt-4o', 4096), true);
});

test('inferContextLimitFromModelName / effectiveContextLimit: chỉ nhận số context, không nhầm số tham số hay version', () => {
  assert.equal(inferContextLimitFromModelName('qwen2.5:0.5b-4k'), 4000);
  assert.equal(inferContextLimitFromModelName('ctx4096'), 4096);
  assert.equal(inferContextLimitFromModelName('model-context-8k'), 8000);
  assert.equal(inferContextLimitFromModelName('llama-4096'), 4096);
  assert.equal(inferContextLimitFromModelName('gpt-4o'), undefined);
  assert.equal(inferContextLimitFromModelName('llama-3.2-1b'), undefined);
  assert.equal(effectiveContextLimit('gpt-4o', 4096), 4096);
  assert.equal(effectiveContextLimit('model-4k'), 4000);
  assert.equal(effectiveContextLimit('gpt-4o'), undefined);
});

// ---------------------------------------------------------------------------
// assertFitsSmallModel: lỗi tiếng Việt rõ ràng + gợi ý, chỉ khi vượt
// ---------------------------------------------------------------------------

test('assertFitsSmallModel: model 4k vượt ước lượng → ném lỗi tiếng Việt kèm gợi ý', () => {
  assert.throws(
    () =>
      assertFitsSmallModel({
        model: 'qwen2.5:0.5b',
        contextLimit: 4096,
        estimatedTokens: 5500,
        toolCount: 119,
      }),
    (err) => {
      assert.ok(err instanceof SmallModelContextError);
      assert.equal(err.name, 'SmallModelContextError');
      assert.equal(err.model, 'qwen2.5:0.5b');
      assert.equal(err.contextLimit, 4096);
      assert.equal(err.estimatedTokens, 5500);
      assert.equal(err.toolCount, 119);
      assert.match(err.message, /chỉ có context 4\.096 token/);
      assert.match(err.message, /~5\.500 token/);
      assert.match(err.message, /119 tool/);
      assert.match(err.message, /provider sẽ trả lỗi 400/);
      assert.match(err.message, /plan mode/);
      assert.match(err.message, /grouping/);
      assert.match(err.message, /giảm số tool/);
      return true;
    },
  );
});

test('assertFitsSmallModel: vừa đúng ngưỡng thì không ném; model lớn không ném dù ước lượng to; không biết limit thì không chặn nhầm', () => {
  // Vừa đúng ngưỡng: estimated == limit → qua.
  assert.doesNotThrow(() =>
    assertFitsSmallModel({ model: 'm', contextLimit: 4096, estimatedTokens: 4096, toolCount: 20 }),
  );
  // Vượt 1 token → ném.
  assert.throws(() =>
    assertFitsSmallModel({ model: 'm', contextLimit: 4096, estimatedTokens: 4097, toolCount: 20 }),
  );
  // Model lớn: 100k token vẫn qua.
  assert.doesNotThrow(() =>
    assertFitsSmallModel({
      model: 'gpt-4o',
      contextLimit: 128_000,
      estimatedTokens: 100_000,
      toolCount: 119,
    }),
  );
  // Tên lạ, không có contextLimit → không đoán, không chặn.
  assert.doesNotThrow(() =>
    assertFitsSmallModel({ model: 'model-la', estimatedTokens: 999_999, toolCount: 119 }),
  );
  // Tên ghi rõ 4k → chặn được dù không truyền contextLimit.
  assert.throws(() =>
    assertFitsSmallModel({ model: 'local-4k', estimatedTokens: 5000, toolCount: 10 }),
  );
});

test('estimateTextTokens / estimateMessagesTokens / estimateFirstRequestTokens: estimator đã hiệu chuẩn', () => {
  assert.equal(estimateTextTokens(''), 0);
  // v0.24 (W17b): không còn chars/4 — từ ASCII dài tính 1 + ceil((len-8)/5)
  // nên 'a'×100 và 'a'×101 đều = 20 (tiktoken thật cho 'a'×100 là 13;
  // chuỗi ký tự lặp là trường hợp estimator thừa, xem docstring tokens.ts).
  assert.equal(estimateTextTokens('a'.repeat(100)), 20);
  assert.equal(estimateTextTokens('a'.repeat(101)), 20);
  const messages = [
    { role: 'system', content: 'a'.repeat(400) },
    { role: 'user', content: 'b'.repeat(100) },
  ];
  assert.equal(estimateMessagesTokens(messages), 100);
  const tools = FAKE_TOOLS();
  assert.equal(
    estimateFirstRequestTokens(messages, tools),
    100 + estimateToolsTokens(tools),
  );
});

// ---------------------------------------------------------------------------
// Loop guard: model 4k + nhiều tool → ép filtering, không gọi provider thật với full list
// ---------------------------------------------------------------------------

test('loop guard: model 4k, không cấu hình toolFilter — provider chỉ thấy tool plan-mode đã gom nhóm', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'qwen2.5:0.5b' }),
    events: makeEvents(),
    smallModel: { contextLimit: 4096 },
  });
  const result = await runner.run('lập kế hoạch');
  assert.equal(result, 'xong');
  assert.equal(seen.length, 1, 'provider chỉ được gọi sau khi guard ép lọc');
  const names = seen[0].tools.map((d) => d.name);
  // Tool ghi/shell/MCP bị loại ở plan mode; nhóm file gom thành 1 tool.
  assert.ok(!names.includes('write_file'), 'write_file phải bị ép lọc ở model nhỏ');
  assert.ok(!names.includes('delete_file'));
  assert.ok(!names.includes('apply_diff'));
  assert.ok(!names.includes('shell_exec'));
  assert.ok(!names.includes('git_commit'));
  assert.ok(!names.includes('mcp_call_tool'));
  assert.ok(names.includes('file'), 'nhóm file phải được gom thành tool điều phối');
  assert.ok(!names.includes('read_file'), 'read_file đã gom vào nhóm file');
  assert.ok(names.length < tools.length, `đã ép từ ${tools.length} xuống ${names.length} defs`);
  assert.ok(
    estimateToolsTokens(seen[0].tools) < 4096,
    `token ước lượng sau khi ép phải dưới 4096, thực tế ${estimateToolsTokens(seen[0].tools)}`,
  );
});

test('loop guard: model 4k + system prompt khổng lồ — vẫn vượt sau khi ép → dừng với lỗi rõ, provider không được gọi', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'không bao giờ tới đây' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({
      model: 'qwen2.5:0.5b',
      // ~30.000 ký tự ≈ 6.000 token (estimator đã hiệu chuẩn) — một mình đã vượt 4.096.
      systemPrompt: 'x'.repeat(30_000),
    }),
    events: makeEvents(),
    smallModel: { contextLimit: 4096 },
  });
  await assert.rejects(runner.run('hi'), (err) => {
    assert.ok(err instanceof SmallModelContextError);
    assert.match(err.message, /chỉ có context 4\.096 token/);
    assert.match(err.message, /plan mode/);
    assert.match(err.message, /grouping/);
    return true;
  });
  assert.equal(seen.length, 0, 'provider.chat không được gọi khi guard đã chặn');
});

test('loop guard: model 4k + toolFilter chat cấu hình sẵn — guard thắng cấu hình, vẫn ép plan mode', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'qwen2.5:0.5b' }),
    events: makeEvents(),
    // Người dùng cấu hình chat mode (full tool) — model nhỏ vẫn bị ép.
    toolFilter: { mode: 'chat', group: false },
    smallModel: { contextLimit: 4096 },
  });
  await runner.run('hi');
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('shell_exec'));
  assert.ok(names.includes('file'));
});

test('loop guard: contextLimit lấy từ compaction (đường coordinator truyền contextLimitForModel) cũng ép lọc', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'qwen2.5:0.5b' }),
    events: makeEvents(),
    compaction: { contextLimit: 4096 },
  });
  await runner.run('hi');
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(names.includes('file'));
});

test('loop guard: tên model ghi rõ 4k, không truyền limit nào — vẫn ép lọc (heuristic theo tên)', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'local-4k' }),
    events: makeEvents(),
  });
  await runner.run('hi');
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(names.includes('file'));
});

test('loop guard: smallModel.enabled=false tắt guard — model 4k + prompt khổng lồ vẫn gọi provider', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'qwen2.5:0.5b', systemPrompt: 'x'.repeat(30_000) }),
    events: makeEvents(),
    smallModel: { contextLimit: 4096, enabled: false },
  });
  assert.equal(await runner.run('hi'), 'xong');
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------
// Loop guard: model lớn không bị ép; ngưỡng 8k đúng hai phía biên
// ---------------------------------------------------------------------------

test('loop guard: model lớn 128k — không bị ép, provider thấy full list (hành vi v0.1)', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'gpt-4o' }),
    events: makeEvents(),
    smallModel: { contextLimit: 128_000 },
  });
  await runner.run('hi');
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    tools.map((t) => t.definition.name),
  );
});

test('loop guard: ngưỡng 8k — contextLimit 8192 ép lọc, 8193 không ép', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seenSmall = [];
  const runnerSmall = new AgentRunner(
    scriptedProvider([{ text: 'xong' }], seenSmall),
    tools,
    {
      bot: makeBot({ model: 'model-bat-ky' }),
      events: makeEvents(),
      smallModel: { contextLimit: 8192 },
    },
  );
  await runnerSmall.run('hi');
  const namesSmall = seenSmall[0].tools.map((d) => d.name);
  assert.ok(!namesSmall.includes('write_file'), '8192 là model nhỏ → phải ép lọc');
  assert.ok(namesSmall.includes('file'));

  const seenBig = [];
  const runnerBig = new AgentRunner(
    scriptedProvider([{ text: 'xong' }], seenBig),
    tools,
    {
      bot: makeBot({ model: 'model-bat-ky' }),
      events: makeEvents(),
      smallModel: { contextLimit: 8193 },
    },
  );
  await runnerBig.run('hi');
  assert.deepEqual(
    seenBig[0].tools.map((d) => d.name),
    tools.map((t) => t.definition.name),
    '8193 không còn là model nhỏ → full list',
  );
});

// ---------------------------------------------------------------------------
// Loop guard trên 119 tool thật: model 4k vẫn chạy được sau khi ép
// ---------------------------------------------------------------------------

test('loop guard: 119 tool thật + model 4k — ép plan mode + grouping, dưới 4096 token, chạy được', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const mem = new BotMemory(ws);
  const tools = defaultToolFactory(mem, ws, 'bot-1');
  assert.ok(tools.length >= 100, `dự kiến ~119 tool, thực tế ${tools.length}`);
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot({ model: 'qwen2.5:0.5b' }),
    events: makeEvents(),
    smallModel: { contextLimit: 4096 },
  });
  assert.equal(await runner.run('lập kế hoạch'), 'xong');
  const defs = seen[0].tools;
  const tokens = estimateToolsTokens(defs);
  console.log(`119 tool thật + model 4k: ${tools.length} -> ${defs.length} defs / ~${tokens} token`);
  assert.ok(defs.length <= 60, `defs sau khi ép phải nhỏ, thực tế ${defs.length}`);
  assert.ok(tokens < 4096, `token ước lượng ${tokens} phải dưới context 4096`);
  assert.ok(!defs.some((d) => d.name === 'write_file'));
  assert.ok(!defs.some((d) => d.name === 'shell_exec'));
});

// ---------------------------------------------------------------------------
// W14a: BotConfig.smallModelGuard -> AgentRunnerOptions.smallModel.enabled
// (coordinator.ts, executeRun — toggle ở desktop Settings).
//
// Mirror đúng đường coordinator truyền: `smallModel: { enabled:
// bot.smallModelGuard ?? true }`. `contextLimit: 4096` ở đây đứng cho
// model 4k đã biết chắc context (coordinator lấy limit từ `compaction`,
// xem ghi chú ở test coordinator bên dưới).
// ---------------------------------------------------------------------------

/** Mirror của wiring trong coordinator: unset = guard bật (true). */
function smallModelEnabledFor(bot) {
  return bot.smallModelGuard ?? true;
}

test('w14a: bot smallModelGuard:false + model 4k — guard tắt, provider thấy full list', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const bot = makeBot({ model: 'qwen2.5:0.5b', smallModelGuard: false });
  const runner = new AgentRunner(provider, tools, {
    bot,
    events: makeEvents(),
    smallModel: { contextLimit: 4096, enabled: smallModelEnabledFor(bot) },
  });
  assert.equal(await runner.run('hi'), 'xong');
  assert.deepEqual(
    seen[0].tools.map((d) => d.name),
    tools.map((t) => t.definition.name),
    'guard tắt: provider phải thấy đủ 24 tool, không lọc, không gom nhóm',
  );
  assert.ok(seen[0].tools.some((d) => d.name === 'write_file'));
  assert.ok(seen[0].tools.some((d) => d.name === 'shell_exec'));
});

test('w14a: bot không set smallModelGuard (mặc định) + model 4k — guard bật như cũ', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const bot = makeBot({ model: 'qwen2.5:0.5b' });
  assert.equal(bot.smallModelGuard, undefined);
  assert.equal(smallModelEnabledFor(bot), true, 'unset phải map thành enabled=true');
  const runner = new AgentRunner(provider, tools, {
    bot,
    events: makeEvents(),
    smallModel: { contextLimit: 4096, enabled: smallModelEnabledFor(bot) },
  });
  await runner.run('hi');
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'), 'mặc định: guard bật, write_file phải bị ép lọc');
  assert.ok(!names.includes('shell_exec'));
  assert.ok(names.includes('file'), 'nhóm file phải được gom thành tool điều phối');
  assert.ok(names.length < tools.length);
});

test('w14a: bot smallModelGuard:true tường minh + model 4k — guard bật', async () => {
  const ws = makeTempDir('open-bot-small-model-');
  const tools = FAKE_TOOLS();
  const seen = [];
  const provider = scriptedProvider([{ text: 'xong' }], seen);
  const bot = makeBot({ model: 'qwen2.5:0.5b', smallModelGuard: true });
  const runner = new AgentRunner(provider, tools, {
    bot,
    events: makeEvents(),
    smallModel: { contextLimit: 4096, enabled: smallModelEnabledFor(bot) },
  });
  await runner.run('hi');
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(names.includes('file'));
});

// ---------------------------------------------------------------------------
// W14a: coordinator thật (in-process) nhận BotConfig.smallModelGuard.
//
// v0.22: `contextLimitForModel` đã có nhánh tên ghi rõ context nhỏ
// (vd `qwen2.5:0.5b-4k` → 4000), nên qua coordinator.run guard KÍCH
// HOẠT được với model 4k — hai test e2e cuối file chứng minh: prompt
// khổng lồ + model 4k → run dừng với SmallModelContextError, cùng
// prompt + model 32k → run chạy bình thường.
// ---------------------------------------------------------------------------

function makeCoordinatorSetup(botId, dir, botOverrides = {}) {
  const coordinator = new AgentCoordinator({
    toolFactory: () => FAKE_TOOLS(),
    emit: () => undefined,
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'qwen2.5:0.5b-4k',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
    ...botOverrides,
  };
  return {
    coordinator,
    async createBot() {
      await coordinator.createBot({
        bot,
        provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'xong' }] },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Bot có thể đã bị xoá — destroy là dọn dẹp best-effort.
      }
      coordinator.shutdown();
    },
  };
}

test('w14a coordinator: bot smallModelGuard:false — createBot + run chạy, mock trả text', async () => {
  const dir = makeTempDir('open-bot-small-model-coord-');
  const setup = makeCoordinatorSetup('bot-guard-off', dir, { smallModelGuard: false });
  try {
    await setup.createBot();
    const result = await setup.coordinator.run({ botId: 'bot-guard-off', text: 'hi' });
    assert.equal(result.botId, 'bot-guard-off');
    assert.equal(result.text, 'xong');
    assert.equal(result.stopped, false);
  } finally {
    await setup.destroy();
  }
});

test('w14a coordinator: bot không set smallModelGuard (mặc định) — createBot + run chạy', async () => {
  const dir = makeTempDir('open-bot-small-model-coord-');
  const setup = makeCoordinatorSetup('bot-guard-default', dir);
  try {
    await setup.createBot();
    const result = await setup.coordinator.run({ botId: 'bot-guard-default', text: 'hi' });
    assert.equal(result.botId, 'bot-guard-default');
    assert.equal(result.text, 'xong');
    assert.equal(result.stopped, false);
  } finally {
    await setup.destroy();
  }
});

test('v0.22 coordinator e2e: model tên 4k + system prompt khổng lồ → guard dừng run với SmallModelContextError (không gọi provider)', async () => {
  const dir = makeTempDir('open-bot-small-model-coord-');
  const setup = makeCoordinatorSetup('bot-guard-e2e', dir, { systemPrompt: 'x'.repeat(30_000) });
  try {
    await setup.createBot();
    await assert.rejects(
      setup.coordinator.run({ botId: 'bot-guard-e2e', text: 'hi' }),
      (err) => err instanceof Error && err.name === 'SmallModelContextError',
    );
  } finally {
    await setup.destroy();
  }
});

test('v0.22 coordinator e2e: model qwen2.5:0.5b (32k) + cùng prompt khổng lồ → guard không dừng, run chạy', async () => {
  const dir = makeTempDir('open-bot-small-model-coord-');
  const setup = makeCoordinatorSetup('bot-guard-e2e-32k', dir, {
    model: 'qwen2.5:0.5b',
    systemPrompt: 'x'.repeat(30_000),
  });
  try {
    await setup.createBot();
    const result = await setup.coordinator.run({ botId: 'bot-guard-e2e-32k', text: 'hi' });
    assert.equal(result.botId, 'bot-guard-e2e-32k');
    assert.equal(result.text, 'xong');
    assert.equal(result.stopped, false);
  } finally {
    await setup.destroy();
  }
});

// ---------------------------------------------------------------------------
// v0.26 (W19a): coordinator đo context thật từ Ollama local.
//
// `qwen2.5:0.5b` không ghi rõ context trong tên nhưng Ollama chạy nó
// với 4096 token (default `num_ctx`) — `executeRun` hỏi
// `OllamaProvider.getContextLimit` rồi truyền số đo vào
// `contextLimitForModel`, nên guard kích hoạt mà không cần hậu tố `-4k`
// hay `contextLimit` tường minh. Test live cần Ollama local đang chạy
// và đã pull `qwen2.5:0.5b` — không có thì skip, không fail.
// Test "Ollama down" không cần server: trỏ provider tới cổng chết để
// chứng minh đo lỗi → fallback 32k cũ, không throw, không chặn run.
// ---------------------------------------------------------------------------

/** True khi Ollama local đang chạy và đã có model `qwen2.5:0.5b`. */
async function liveOllamaHasQwen05b() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return (data.models ?? []).some((m) => m.name === 'qwen2.5:0.5b');
  } catch {
    return false;
  }
}

function makeOllamaCoordinatorSetup(botId, dir, botOverrides = {}, providerOverrides = {}) {
  const coordinator = new AgentCoordinator({
    toolFactory: () => FAKE_TOOLS(),
    emit: () => undefined,
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'ollama',
    model: 'qwen2.5:0.5b',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
    ...botOverrides,
  };
  return {
    coordinator,
    async createBot() {
      await coordinator.createBot({
        bot,
        provider: { id: 'ollama', label: 'Ollama', ...providerOverrides },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Bot có thể đã bị xoá — destroy là dọn dẹp best-effort.
      }
      coordinator.shutdown();
    },
  };
}

test('v0.26 coordinator e2e (live): Ollama thật đo qwen2.5:0.5b = 4096 → guard dừng run với SmallModelContextError (không cần hậu tố -4k)', async (t) => {
  if (!(await liveOllamaHasQwen05b())) {
    t.skip('Ollama local không chạy hoặc chưa pull qwen2.5:0.5b — bỏ qua test live');
    return;
  }
  const dir = makeTempDir('open-bot-small-model-coord-ollama-');
  // Prompt ~30.000 ký tự ≈ 6.000 token: vừa trong 32k cũ nhưng vượt 4096 đo được.
  const setup = makeOllamaCoordinatorSetup('bot-ollama-live-4k', dir, {
    systemPrompt: 'x'.repeat(30_000),
  });
  try {
    await setup.createBot();
    await assert.rejects(
      setup.coordinator.run({ botId: 'bot-ollama-live-4k', text: 'hi' }),
      (err) => err instanceof Error && err.name === 'SmallModelContextError',
    );
  } finally {
    await setup.destroy();
  }
});

test('v0.26 coordinator e2e: Ollama không chạy (cổng chết) → đo lỗi, fallback 32k cũ, guard không chặn run (lỗi chỉ tới ở bước gọi provider)', async () => {
  const dir = makeTempDir('open-bot-small-model-coord-ollama-');
  const setup = makeOllamaCoordinatorSetup(
    'bot-ollama-down',
    dir,
    { systemPrompt: 'x'.repeat(30_000) },
    // Cổng không có gì nghe: /api/show fail ngay (ECONNREFUSED).
    { baseUrl: 'http://127.0.0.1:59999/v1' },
  );
  try {
    await setup.createBot();
    await assert.rejects(
      setup.coordinator.run({ botId: 'bot-ollama-down', text: 'hi' }),
      (err) => {
        assert.ok(err instanceof Error);
        // Guard KHÔNG được chặn: lỗi phải là lỗi kết nối provider,
        // không phải SmallModelContextError.
        assert.notEqual(err.name, 'SmallModelContextError');
        assert.doesNotMatch(err.message, /chỉ có context/);
        return true;
      },
    );
  } finally {
    await setup.destroy();
  }
});
