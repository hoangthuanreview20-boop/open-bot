/**
 * Tests for P0-3 plan mode thật (v0.30):
 *   packages/core/src/agent/loop.ts — plan/review mode ép chỉ đọc NGAY
 *   TRONG LOOP (fail-closed), subagent kế thừa mode của bot cha.
 *
 * Plan file + approval state (plan_create ghi .open-bot/plans/<id>.md,
 * plan_update reviewDecision approve/reject/request-changes) đã có từ
 * v0.11 và được kiểm chứng ở tests/planning.test.mjs — ở đây chỉ kiểm
 * chứng thêm ở tầng loop: model CỐ GỌI tool ghi/shell vẫn bị chặn,
 * plan file ghi đúng format qua loop, duyệt -> chuyển mode chat rồi mới
 * thực thi, từ chối -> không làm gì.
 *
 * Each test drives a real AgentRunner with a scripted mock provider.
 * No real API key, no network.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/plan-mode-v030.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { getBotMode, getPlanApproval } from '../packages/core/dist/agent/coordination.js';
import { readPlanFile } from '../packages/core/dist/agent/planning.js';
import { createPlanTools } from '../packages/tools/dist/planTools.js';

const BOT = 'bot-plan-mode';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let callSeq = 0;
function nextCallId() {
  return `call-${++callSeq}`;
}

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

function makeBot(workspaceDir) {
  return {
    id: BOT,
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function makeTool(name, opts = {}) {
  const calls = [];
  const tool = {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: opts.needsApproval ?? false,
    calls,
    async execute(args, ctx) {
      calls.push(args);
      if (opts.execute) return opts.execute(args, ctx);
      return opts.output ?? `ok:${name}:${JSON.stringify(args)}`;
    },
  };
  return tool;
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

// ---------------------------------------------------------------------------
// 1. Plan mode chặn tool ghi/shell — kể cả khi model cố gọi trực tiếp.
// ---------------------------------------------------------------------------

test('plan mode: model cố gọi write_file/shell_exec/delete_file đều bị chặn, không ghi gì', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const tools = [
    makeTool('read_file'),
    makeTool('write_file', { needsApproval: true }),
    makeTool('delete_file', { needsApproval: true }),
    makeTool('shell_exec', { needsApproval: true }),
    makeTool('list_files'),
    makeTool('ask_user'),
  ];
  const seen = [];
  const provider = scriptedProvider(
    [
      {
        toolCalls: [
          { id: nextCallId(), name: 'write_file', args: { path: 'evil.txt' } },
          { id: nextCallId(), name: 'shell_exec', args: { command: 'rm -rf /tmp/x' } },
          { id: nextCallId(), name: 'delete_file', args: { path: 'a.txt' } },
        ],
      },
      { text: 'đã rõ, tôi chỉ đọc thôi' },
    ],
    seen,
  );
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: 'plan', group: false },
  });
  const result = await runner.run('làm web đi');
  assert.equal(result, 'đã rõ, tôi chỉ đọc thôi');
  // Provider không hề thấy tool ghi (lớp filter) ...
  const names = seen[0].tools.map((d) => d.name);
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('shell_exec'));
  assert.ok(!names.includes('delete_file'));
  // ... và kể cả khi model gọi đúng tên thì loop chặn trước khi chạy
  // (trước đây executeCallInner fallback về full tool map nên vẫn chạy).
  assert.equal(events.toolResults.length, 3);
  for (const r of events.toolResults) {
    assert.equal(r.ok, false);
    assert.match(r.output, /Bị chặn ở chế độ plan \(chỉ đọc\)/);
    assert.match(r.output, /plan_create/);
  }
  for (const name of ['write_file', 'delete_file', 'shell_exec']) {
    assert.equal(toolByName(tools, name).calls.length, 0, `${name} không được chạy lần nào`);
  }
  assert.equal(fs.existsSync(path.join(ws, 'evil.txt')), false);
});

test('plan mode: gọi dispatcher gom nhóm với operation ghi cũng bị từ chối', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const tools = [
    makeTool('read_file'),
    makeTool('write_file'),
    makeTool('list_files'),
    makeTool('ask_user'),
  ];
  const provider = scriptedProvider([
    {
      toolCalls: [
        {
          id: nextCallId(),
          name: 'file',
          args: { operation: 'write_file', args: { path: 'evil.txt' } },
        },
      ],
    },
    { text: 'xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    // group: true (mặc định): plan mode chỉ giữ thành viên chỉ-đọc trong
    // nhóm file nên dispatcher không có operation write_file.
    toolFilter: { mode: 'plan' },
  });
  await runner.run('ghi file');
  assert.equal(events.toolResults.length, 1);
  assert.equal(events.toolResults[0].ok, false);
  // Dispatcher ở plan mode chỉ chứa thành viên chỉ-đọc nên operation
  // write_file không tồn tại trong nhóm — từ chối ngay trong dispatcher.
  assert.match(
    events.toolResults[0].output,
    /Nhóm "file": operation phải là một trong: read_file, list_files/,
  );
  assert.equal(toolByName(tools, 'write_file').calls.length, 0);
  assert.equal(fs.existsSync(path.join(ws, 'evil.txt')), false);
});

test('review mode: chặn tool ghi như plan mode', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const tools = [makeTool('read_file'), makeTool('write_file'), makeTool('git_status')];
  const provider = scriptedProvider([
    { toolCalls: [{ id: nextCallId(), name: 'write_file', args: { path: 'x.txt' } }] },
    { text: 'xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: 'review', group: false },
  });
  await runner.run('rà soát rồi sửa');
  assert.equal(events.toolResults[0].ok, false);
  assert.match(events.toolResults[0].output, /Bị chặn ở chế độ review/);
  assert.equal(toolByName(tools, 'write_file').calls.length, 0);
});

test('chat mode (đối chứng): cùng tool call write_file thì chạy bình thường', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const writeTool = makeTool('write_file', {
    execute: (args) => {
      fs.writeFileSync(path.join(ws, 'hello.txt'), 'hi', 'utf8');
      return 'đã ghi';
    },
  });
  const tools = [makeTool('read_file'), writeTool];
  const provider = scriptedProvider([
    { toolCalls: [{ id: nextCallId(), name: 'write_file', args: { path: 'hello.txt' } }] },
    { text: 'xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: 'chat', group: false },
  });
  await runner.run('ghi file');
  assert.equal(events.toolResults[0].ok, true);
  assert.equal(writeTool.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hi');
});

// ---------------------------------------------------------------------------
// 2. Plan mode cho phép đọc + plan_create: plan file đúng format, chờ duyệt.
// ---------------------------------------------------------------------------

test('plan mode qua loop: read_file chạy, plan_create ghi file đúng format + chờ duyệt', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const mem = new BotMemory(ws);
  const tools = [
    ...createPlanTools(mem),
    makeTool('read_file', { output: 'nội dung file' }),
    makeTool('write_file'),
    makeTool('ask_user'),
  ];
  const provider = scriptedProvider([
    {
      toolCalls: [
        { id: nextCallId(), name: 'read_file', args: { path: 'README.md' } },
        {
          id: nextCallId(),
          name: 'plan_create',
          args: {
            title: 'Làm web bán hàng',
            detail: 'MVP trong 1 tuần',
            steps: ['Thiết kế giao diện', 'Code trang chủ', 'Deploy'],
            decisions: ['Chọn framework nào?', 'Dùng DB gì?'],
          },
        },
      ],
    },
    { text: 'Đã nộp plan, chờ duyệt.' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: 'plan', group: false },
  });
  const result = await runner.run('lập kế hoạch làm web');
  assert.equal(result, 'Đã nộp plan, chờ duyệt.');
  const planResult = events.toolResults.find((r) => r.ok && r.output.includes('projectId'));
  assert.ok(planResult, 'plan_create phải chạy thành công ở plan mode');
  const plan = JSON.parse(planResult.output);
  assert.equal(plan.status, 'pending');
  assert.equal(plan.steps.length, 3);
  // Plan file: đúng format Markdown (title, bước đánh số, lựa chọn, chờ duyệt).
  const md = readPlanFile(ws, plan.projectId);
  assert.ok(md, 'plan_create phải ghi file plan');
  assert.match(md, /# Kế hoạch: Làm web bán hàng/);
  assert.match(md, /- Trạng thái duyệt: chờ duyệt/);
  assert.match(md, /1\. Thiết kế giao diện/);
  assert.match(md, /2\. Code trang chủ/);
  assert.match(md, /3\. Deploy/);
  assert.match(md, /## Lựa chọn cần quyết/);
  assert.match(md, /- Chọn framework nào\?/);
  assert.match(md, /- Dùng DB gì\?/);
  assert.ok(md.includes(`Project: \`${plan.projectId}\``));
  assert.ok(fs.existsSync(path.join(ws, '.open-bot', 'plans', `${plan.projectId}.md`)));
  // Trạng thái duyệt trong memory: pending.
  const approval = getPlanApproval(mem, BOT, plan.projectId);
  assert.ok(approval);
  assert.equal(approval.status, 'pending');
  assert.deepEqual(approval.steps, ['Thiết kế giao diện', 'Code trang chủ', 'Deploy']);
  assert.deepEqual(approval.decisions, ['Chọn framework nào?', 'Dùng DB gì?']);
});

async function submitPlanViaLoop(ws, mem) {
  const tools = createPlanTools(mem);
  const plan = JSON.parse(
    await toolByName(tools, 'plan_create').execute(
      {
        title: 'Kế hoạch duyệt thử',
        detail: '',
        steps: ['Bước một', 'Bước hai'],
        decisions: ['Quyết A hay B?'],
      },
      { workspaceDir: ws, botId: BOT },
    ),
  );
  return { tools, plan };
}

// ---------------------------------------------------------------------------
// 3. Duyệt -> chuyển mode chat và thực thi; từ chối -> không làm gì.
// ---------------------------------------------------------------------------

test('duyệt plan (approve): mode chuyển sang chat, file ghi "đã duyệt", lượt sau thực thi được', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const mem = new BotMemory(ws);
  mem.setMemory(BOT, 'agent:mode', 'plan');
  const { tools, plan } = await submitPlanViaLoop(ws, mem);
  assert.equal(getBotMode(mem, BOT), 'plan');

  const reviewed = JSON.parse(
    await toolByName(tools, 'plan_update').execute(
      { projectId: plan.projectId, reviewDecision: 'approve' },
      { workspaceDir: ws, botId: BOT },
    ),
  );
  assert.equal(reviewed.approvalStatus, 'approved');
  assert.equal(reviewed.mode, 'chat');
  assert.equal(getBotMode(mem, BOT), 'chat');
  assert.match(readPlanFile(ws, plan.projectId), /Trạng thái duyệt: đã duyệt/);

  // Lượt chạy sau (mode chat): write_file chạy thật.
  const writeTool = makeTool('write_file', {
    execute: () => {
      fs.writeFileSync(path.join(ws, 'done.txt'), 'xong', 'utf8');
      return 'đã ghi';
    },
  });
  const provider = scriptedProvider([
    { toolCalls: [{ id: nextCallId(), name: 'write_file', args: { path: 'done.txt' } }] },
    { text: 'đã thực thi bước một' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [writeTool, makeTool('read_file')], {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: getBotMode(mem, BOT), group: false },
  });
  const result = await runner.run('thực thi plan đã duyệt');
  assert.equal(result, 'đã thực thi bước một');
  assert.equal(events.toolResults[0].ok, true);
  assert.equal(writeTool.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'done.txt'), 'utf8'), 'xong');
});

test('từ chối plan (reject): mode vẫn là plan, file ghi "đã từ chối", không thực thi gì', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const mem = new BotMemory(ws);
  mem.setMemory(BOT, 'agent:mode', 'plan');
  const { tools, plan } = await submitPlanViaLoop(ws, mem);

  const reviewed = JSON.parse(
    await toolByName(tools, 'plan_update').execute(
      { projectId: plan.projectId, reviewDecision: 'reject' },
      { workspaceDir: ws, botId: BOT },
    ),
  );
  assert.equal(reviewed.approvalStatus, 'rejected');
  assert.equal(reviewed.mode, 'plan');
  assert.equal(getBotMode(mem, BOT), 'plan');
  assert.match(readPlanFile(ws, plan.projectId), /Trạng thái duyệt: đã từ chối/);

  // Vẫn ở plan mode: model cố gọi write_file vẫn bị chặn, không ghi gì.
  const writeTool = makeTool('write_file');
  const provider = scriptedProvider([
    { toolCalls: [{ id: nextCallId(), name: 'write_file', args: { path: 'done.txt' } }] },
    { text: 'không làm gì' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [writeTool, makeTool('read_file')], {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: getBotMode(mem, BOT), group: false },
  });
  await runner.run('thực thi plan bị từ chối');
  assert.equal(events.toolResults[0].ok, false);
  assert.match(events.toolResults[0].output, /Bị chặn ở chế độ plan/);
  assert.equal(writeTool.calls.length, 0);
  assert.equal(fs.existsSync(path.join(ws, 'done.txt')), false);
});

test('yêu cầu sửa (request-changes): mode vẫn là plan, note được lưu', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const mem = new BotMemory(ws);
  mem.setMemory(BOT, 'agent:mode', 'plan');
  const { tools, plan } = await submitPlanViaLoop(ws, mem);
  const reviewed = JSON.parse(
    await toolByName(tools, 'plan_update').execute(
      {
        projectId: plan.projectId,
        reviewDecision: 'request-changes',
        note: 'Thêm bước kiểm thử trước khi deploy.',
      },
      { workspaceDir: ws, botId: BOT },
    ),
  );
  assert.equal(reviewed.approvalStatus, 'changes-requested');
  assert.equal(reviewed.mode, 'plan');
  assert.equal(getBotMode(mem, BOT), 'plan');
  assert.equal(reviewed.note, 'Thêm bước kiểm thử trước khi deploy.');
  assert.match(readPlanFile(ws, plan.projectId), /Trạng thái duyệt: yêu cầu sửa/);
});

// ---------------------------------------------------------------------------
// 4. Subagent kế thừa plan mode của bot cha.
// ---------------------------------------------------------------------------

test('subagent ở plan mode cũng bị chặn ghi (không lách qua agent con)', async () => {
  const ws = makeTempDir('open-bot-plan-mode-');
  const writeTool = makeTool('write_file', { needsApproval: true });
  const tools = [writeTool, makeTool('read_file'), makeTool('ask_user')];
  // Lưu ý: tool spawn subagent (delegate_task / delegate_specialized)
  // KHÔNG nằm trong READ_ONLY_TOOLS nên ở plan mode model không gọi
  // được chúng qua loop — đó cũng là fail-closed đúng. Việc kế thừa mode
  // là phòng thủ chiều sâu cho đường gọi trực tiếp runSubagent (vd host
  // khác, tool spawn được thêm vào allowlist sau này): gọi thẳng
  // runner.runSubagent (phương thức public ở runtime) để kiểm chứng con
  // vẫn bị chặn ghi dù cha không chặn được qua tool.
  const provider = scriptedProvider([
    { toolCalls: [{ id: nextCallId(), name: 'write_file', args: { path: 'evil.txt' } }] },
    { text: 'con không ghi được, bị chặn ở plan mode' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, tools, {
    bot: makeBot(ws),
    events,
    toolFilter: { mode: 'plan', group: false },
  });
  const outcome = await runner.runSubagent('ghi file hộ tao', {});
  assert.match(outcome, /\[subagent [^\]]+\] done:/);
  assert.match(outcome, /con không ghi được, bị chặn ở plan mode/);
  assert.equal(writeTool.calls.length, 0, 'agent con không được ghi file ở plan mode');
  assert.equal(fs.existsSync(path.join(ws, 'evil.txt')), false);
  // Kết quả tool của agent con (chung events với cha) phải là lỗi chặn
  // ở plan mode — con nhận tool result lỗi đó rồi mới trả text về.
  assert.ok(
    events.toolResults.some((r) => !r.ok && /Bị chặn ở chế độ plan/.test(r.output)),
    'agent con phải nhận tool result "Bị chặn ở chế độ plan"',
  );
});
