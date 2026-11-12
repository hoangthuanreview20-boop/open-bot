/**
 * subagent-roles-v037.test.mjs — subagent theo vai trò (role) P1-4 (v0.37).
 *
 * - Role built-in: đúng tool allowlist / system prompt / giới hạn, tool
 *   nào cũng là tên tool thật (đối chiếu 146 tool của defaultToolFactory).
 * - resolveRoleOptions: giao với tool cha, gọi trực tiếp thu hẹp thêm,
 *   role lạ lỗi rõ, giao rỗng lỗi rõ.
 * - Role custom từ file JSON (mẫu docs/subagent-roles.example.json) +
 *   loadRolesFromDir (file hỏng không kéo sập file khác).
 * - AgentRunner (mock provider): delegate_task { role } → con nhận đúng
 *   system prompt role + đúng tool; con không gọi được tool ngoài role
 *   ("Không rõ công cụ"); con không vượt quyền cha (giao tool); role lạ
 *   báo lỗi rõ, không spawn con.
 * - Tool list_subagent_roles liệt kê role; runSpecializedSubagents nhận
 *   spec.role.
 *
 * Run: node --test tests/subagent-roles-v037.test.mjs (after building
 * core + tools). Không gọi mạng, không gọi x.ai.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  BUILTIN_ROLES,
  BotMemory,
  EmptyRoleToolsError,
  SubagentRoleRegistry,
  UnknownSubagentRoleError,
  createRoleRegistry,
  defaultToolFactory,
  describeRole,
  loadRolesFromDir,
  loadRolesFromFile,
  validateRole,
} from '../packages/core/dist/index.js';
import { SUBAGENT_TOOLS, createSubagentTools } from '../packages/tools/dist/subagentTools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_JSON = path.join(HERE, '..', 'docs', 'subagent-roles.example.json');

const BOT = {
  id: 'bot-test',
  name: 'Test',
  providerId: 'mock',
  model: 'mock',
  systemPrompt: 'You are a test bot.',
  workspaceDir: '',
  autoApprove: true,
};

let callSeq = 0;
function toolCall(name, args) {
  return { id: `call-${++callSeq}`, name, args };
}

/** Provider ghi lại mọi lần gọi chat() rồi trả response soạn sẵn theo thứ tự. */
function capturingProvider(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    provider: {
      id: 'mock',
      label: 'Mock',
      async chat(req) {
        calls.push({ model: req.model, messages: req.messages, tools: req.tools ?? [] });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (typeof r === 'function') return r(req);
        return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
      },
      async listModels() {
        return ['mock'];
      },
    },
  };
}

function makeEvents(extra = {}) {
  const events = {
    texts: [],
    toolCalls: [],
    toolResults: [],
    onText(delta) {
      events.texts.push(delta);
    },
    onToolCall(call) {
      events.toolCalls.push(call);
    },
    onToolResult(r) {
      events.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
    onProgress() {},
    onFinalSummary() {},
    ...extra,
  };
  return events;
}

function tmpDir(prefix = 'open-bot-roles-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Tool giả tối giản (cha cấp cho con qua toolsList). */
function fakeTool(name, output = `ok:${name}`) {
  return {
    definition: {
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
    needsApproval: false,
    async execute() {
      return output;
    },
  };
}

function roleById(id) {
  const r = BUILTIN_ROLES.find((x) => x.id === id);
  assert.ok(r, `thiếu role built-in ${id}`);
  return r;
}

function toolResultFor(events, toolName) {
  return events.toolResults.filter((r) =>
    events.toolCalls.some((c) => c.id === r.callId && c.name === toolName),
  );
}

// ---------------------------------------------------------------------------
// Role built-in: định nghĩa đúng + tool nào cũng là tên tool thật
// ---------------------------------------------------------------------------

test('roles: 5 role built-in, đủ id/mô tả/systemPrompt/giới hạn', () => {
  assert.deepEqual(
    BUILTIN_ROLES.map((r) => r.id),
    ['researcher', 'coder', 'reviewer', 'planner', 'tester'],
  );
  for (const role of BUILTIN_ROLES) {
    assert.ok(role.description.trim().length > 0, `${role.id} thiếu description`);
    assert.ok(role.systemPrompt.trim().length > 0, `${role.id} thiếu systemPrompt`);
    assert.ok(Array.isArray(role.tools) && role.tools.length > 0, `${role.id} thiếu tools`);
    assert.equal(new Set(role.tools).size, role.tools.length, `${role.id} có tool trùng`);
    assert.ok(Number.isFinite(role.maxSteps) && role.maxSteps > 0, `${role.id} thiếu maxSteps`);
    assert.ok(Number.isFinite(role.timeoutMs) && role.timeoutMs > 0, `${role.id} thiếu timeoutMs`);
    assert.equal(role.source, 'builtin');
  }
});

test('roles: mọi tool role built-in đều là tên tool thật của defaultToolFactory', () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  const realNames = new Set(defaultToolFactory(mem, dir, 'bot-1').map((t) => t.definition.name));
  assert.ok(realNames.size >= 100, `cần ~146 tool thật, chỉ có ${realNames.size}`);
  for (const role of BUILTIN_ROLES) {
    for (const name of role.tools) {
      assert.ok(realNames.has(name), `role ${role.id} khai tool không tồn tại: ${name}`);
    }
  }
});

test('roles: researcher/reviewer chỉ đọc + cấm shell; coder được ghi+shell; tester chạy shell nhưng không ghi', () => {
  const researcher = roleById('researcher');
  const reviewer = roleById('reviewer');
  const coder = roleById('coder');
  const tester = roleById('tester');
  const planner = roleById('planner');
  for (const r of [researcher, reviewer]) {
    assert.equal(r.readOnly, true, `${r.id} phải readOnly`);
    assert.equal(r.allowShell, false, `${r.id} phải cấm shell`);
    assert.ok(!r.tools.includes('write_file'), `${r.id} không được có write_file`);
    assert.ok(!r.tools.includes('shell_exec'), `${r.id} không được có shell_exec`);
    assert.ok(!r.tools.includes('apply_diff'), `${r.id} không được có apply_diff`);
  }
  assert.ok(coder.tools.includes('write_file') && coder.tools.includes('shell_exec'));
  assert.equal(coder.allowShell, true);
  assert.ok(tester.tools.includes('shell_exec'), 'tester cần shell_exec để chạy test');
  assert.ok(!tester.tools.includes('write_file'), 'tester không được ghi file');
  assert.ok(!tester.tools.includes('apply_diff'), 'tester không được sửa file');
  assert.ok(planner.tools.includes('plan_create'), 'planner cần plan_create');
  assert.ok(planner.tools.includes('plan_update'), 'planner cần plan_update');
  assert.ok(!planner.tools.includes('write_file'), 'planner không sửa code');
  assert.match(reviewer.systemPrompt, /CHỈ ĐỌC/);
  assert.match(reviewer.systemPrompt, /KHÔNG ĐẠT/);
});

test('roles: describeRole tóm tắt đúng để liệt kê cho agent cha / user', () => {
  const summary = describeRole(roleById('reviewer'));
  assert.equal(summary.id, 'reviewer');
  assert.equal(summary.readOnly, true);
  assert.equal(summary.allowShell, false);
  assert.equal(summary.maxSteps, 10);
  assert.deepEqual(summary.tools, roleById('reviewer').tools);
});

// ---------------------------------------------------------------------------
// resolveRoleOptions: giao với cha, gọi trực tiếp thu hẹp, lỗi rõ
// ---------------------------------------------------------------------------

test('roles: resolveRoleOptions giao tool role với tool cha (con không vượt quyền cha)', () => {
  const registry = new SubagentRoleRegistry();
  const parent = ['read_file', 'write_file', 'shell_exec', 'web_search'];
  const coder = registry.resolveRoleOptions('coder', parent);
  // Coder xin shell_exec + write_file (cha có) nhưng không xin được
  // apply_diff/delete_file/... (cha không có).
  assert.deepEqual(coder.tools, ['read_file', 'write_file', 'shell_exec']);
  assert.deepEqual(
    coder.unavailableTools,
    roleById('coder').tools.filter((t) => !parent.includes(t)),
  );
  assert.ok(coder.unavailableTools.includes('apply_diff'));
  const researcher = registry.resolveRoleOptions('researcher', parent);
  assert.deepEqual(researcher.tools, ['web_search', 'read_file']);
  assert.equal(researcher.maxSteps, 15);
  assert.equal(researcher.timeoutMs, 120_000);
  assert.match(researcher.instructions, /researcher/);
});

test('roles: gọi trực tiếp chỉ thu hẹp thêm (tools/model/maxSteps/timeout/instructions)', () => {
  const registry = new SubagentRoleRegistry();
  const parent = ['read_file', 'write_file', 'shell_exec', 'web_search'];
  const narrowed = registry.resolveRoleOptions('coder', parent, {
    tools: ['read_file'],
    model: 'model-truc-tiep',
    maxSteps: 3,
    timeoutMs: 5000,
    instructions: 'Chỉ làm bước 1.',
  });
  assert.deepEqual(narrowed.tools, ['read_file']);
  assert.equal(narrowed.model, 'model-truc-tiep');
  assert.equal(narrowed.maxSteps, 3);
  assert.equal(narrowed.timeoutMs, 5000);
  assert.match(narrowed.instructions, /coder/);
  assert.match(narrowed.instructions, /Chỉ làm bước 1/);
});

test('roles: role lạ throw UnknownSubagentRoleError kèm danh sách role có sẵn, không fallback', () => {
  const registry = new SubagentRoleRegistry();
  assert.throws(
    () => registry.resolveRoleOptions('khong-co-role-nay', ['read_file']),
    (err) => {
      assert.ok(err instanceof UnknownSubagentRoleError);
      assert.equal(err.roleId, 'khong-co-role-nay');
      assert.match(err.message, /không tồn tại/);
      assert.match(err.message, /researcher/);
      assert.match(err.message, /list_subagent_roles/);
      return true;
    },
  );
});

test('roles: giao tool rỗng throw EmptyRoleToolsError (cha không cấp được gì role cần)', () => {
  const registry = new SubagentRoleRegistry();
  assert.throws(
    () => registry.resolveRoleOptions('reviewer', ['ask_user']),
    (err) => {
      assert.ok(err instanceof EmptyRoleToolsError);
      assert.match(err.message, /không còn tool nào/);
      return true;
    },
  );
});

test('roles: allowShell=false loại tool shell dù role có khai; readOnly giao thêm READ_ONLY_TOOLS', () => {
  const registry = new SubagentRoleRegistry([
    {
      id: 'shell-but-no',
      description: 'Role mâu thuẫn: khai shell nhưng cấm shell.',
      systemPrompt: 'Test mâu thuẫn.',
      tools: ['read_file', 'shell_exec', 'write_file'],
      allowShell: false,
    },
    {
      id: 'ro-but-write',
      description: 'Role mâu thuẫn: readOnly nhưng khai tool ghi.',
      systemPrompt: 'Test mâu thuẫn 2.',
      tools: ['read_file', 'write_file'],
      readOnly: true,
    },
  ]);
  const a = registry.resolveRoleOptions('shell-but-no', ['read_file', 'shell_exec', 'write_file']);
  assert.deepEqual(a.tools, ['read_file', 'write_file']);
  const b = registry.resolveRoleOptions('ro-but-write', ['read_file', 'write_file']);
  assert.deepEqual(b.tools, ['read_file']);
});

test('roles: validateRole từ chối id sai / thiếu prompt / maxSteps sai', () => {
  assert.throws(() => validateRole({ id: 'Researcher', description: 'x', systemPrompt: 'y' }), /không hợp lệ/);
  assert.throws(() => validateRole({ id: 'ok', description: 'x', systemPrompt: '  ' }), /systemPrompt/);
  assert.throws(
    () => validateRole({ id: 'ok', description: 'x', systemPrompt: 'y', maxSteps: 0 }),
    /maxSteps/,
  );
  assert.throws(
    () => validateRole({ id: 'ok', description: 'x', systemPrompt: 'y', tools: 'read_file' }),
    /tools/,
  );
  const ok = validateRole({
    id: 'ok-role',
    description: 'd',
    systemPrompt: 'p',
    tools: ['read_file', 'read_file'],
  });
  assert.deepEqual(ok.tools, ['read_file']);
});

// ---------------------------------------------------------------------------
// Role custom từ file JSON
// ---------------------------------------------------------------------------

test('roles: load file JSON mẫu docs/subagent-roles.example.json (2 role custom)', () => {
  const roles = loadRolesFromFile(EXAMPLE_JSON);
  assert.deepEqual(
    roles.map((r) => r.id),
    ['summarizer', 'doc-writer'],
  );
  assert.equal(roles[0].source, 'custom');
  const registry = createRoleRegistry(roles);
  assert.deepEqual(registry.listSummaries().map((s) => s.id).slice(0, 5), [
    'researcher',
    'coder',
    'reviewer',
    'planner',
    'tester',
  ]);
  const resolved = registry.resolveRoleOptions('summarizer', ['read_file', 'write_file', 'shell_exec']);
  assert.deepEqual(resolved.tools, ['read_file']);
  assert.match(resolved.instructions, /summarizer/);
});

test('roles: custom trùng id built-in thì throw (không shadow lặng lẽ)', () => {
  assert.throws(
    () => createRoleRegistry([{ id: 'coder', description: 'x', systemPrompt: 'y' }]),
    /trùng id với role có sẵn/,
  );
});

test('roles: loadRolesFromDir — file hỏng không kéo sập file khác; thư mục vắng = rỗng', () => {
  const dir = tmpDir('open-bot-roles-dir-');
  fs.writeFileSync(
    path.join(dir, 'good.json'),
    JSON.stringify({ id: 'good-one', description: 'd', systemPrompt: 'p', tools: ['read_file'] }),
  );
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ không phải json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'không phải json, phải bị bỏ qua');
  const { roles, errors } = loadRolesFromDir(dir);
  assert.deepEqual(
    roles.map((r) => r.id),
    ['good-one'],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad\.json/);
  const empty = loadRolesFromDir(path.join(dir, 'khong-ton-tai'));
  assert.deepEqual(empty, { roles: [], errors: [] });
  assert.throws(() => loadRolesFromFile(path.join(dir, 'khong-co.json')), /Không đọc được file role/);
});

// ---------------------------------------------------------------------------
// Tool list_subagent_roles
// ---------------------------------------------------------------------------

test('roles: tool list_subagent_roles liệt kê 5 role built-in (factory mặc định)', async () => {
  const tool = SUBAGENT_TOOLS.find((t) => t.definition.name === 'list_subagent_roles');
  assert.ok(tool, 'thiếu tool list_subagent_roles');
  assert.equal(tool.needsApproval, false);
  const out = await tool.execute({}, { workspaceDir: tmpDir(), botId: 'b' });
  const list = JSON.parse(out);
  assert.equal(list.length, 5);
  assert.deepEqual(
    list.map((r) => r.id),
    ['researcher', 'coder', 'reviewer', 'planner', 'tester'],
  );
  const reviewer = list.find((r) => r.id === 'reviewer');
  assert.equal(reviewer.readOnly, true);
  assert.equal(reviewer.allowShell, false);
  assert.ok(reviewer.description.length > 0);
});

test('roles: tool list_subagent_roles liệt kê cả role custom khi factory truyền roles', async () => {
  const custom = loadRolesFromFile(EXAMPLE_JSON);
  const tools = createSubagentTools({ roles: [...BUILTIN_ROLES, ...custom] });
  const tool = tools.find((t) => t.definition.name === 'list_subagent_roles');
  const list = JSON.parse(await tool.execute({}, { workspaceDir: tmpDir(), botId: 'b' }));
  assert.equal(list.length, 7);
  assert.ok(list.some((r) => r.id === 'summarizer' && r.source === 'custom'));
});

// ---------------------------------------------------------------------------
// AgentRunner: delegate_task { role } — con đúng prompt + đúng tool
// ---------------------------------------------------------------------------

test('loop: delegate_task role=reviewer — con nhận system prompt role, không gọi được write_file', async () => {
  const dir = tmpDir();
  const parentTools = [
    fakeTool('read_file', 'nội dung file'),
    fakeTool('write_file'),
    fakeTool('shell_exec'),
    fakeTool('web_search'),
    ...createSubagentTools(),
  ];
  const { calls, provider } = capturingProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'soát file a.ts', role: 'reviewer' })] },
    // Con: thử gọi write_file (ngoài role) rồi trả text.
    { toolCalls: [toolCall('write_file', { path: 'a.ts', content: 'x' })] },
    { text: 'review xong: ĐẠT' },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, parentTools, {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  const out = await runner.run('soát giúp tôi');
  assert.equal(out, 'parent xong');
  // calls[0] = cha, calls[1] = con (thử write_file), calls[2] = con (text), calls[3] = cha.
  assert.equal(calls.length, 4);
  const childCall = calls[1];
  const childSystem = childCall.messages.find((m) => m.role === 'system');
  assert.ok(childSystem, 'con phải có system message');
  assert.match(childSystem.content, /\[subagent chuyên biệt: reviewer\]/);
  assert.match(childSystem.content, /CHỈ ĐỌC/);
  // Con không được thấy tool ghi/shell trong definitions gửi cho model.
  const childToolNames = childCall.tools.map((t) => t.name);
  assert.ok(!childToolNames.includes('write_file'), 'con reviewer không được thấy write_file');
  assert.ok(!childToolNames.includes('shell_exec'), 'con reviewer không được thấy shell_exec');
  assert.ok(!childToolNames.includes('shell'), 'con reviewer không được thấy nhóm shell');
  // Con thử gọi write_file → loop từ chối vì tool không có trong map của con.
  const writeResults = toolResultFor(events, 'write_file');
  assert.equal(writeResults.length, 1);
  assert.match(writeResults[0].output, /Không rõ công cụ: write_file/);
  // Kết quả delegate trả về cho cha vẫn là tóm tắt của con.
  const delegateResults = toolResultFor(events, 'delegate_task');
  assert.equal(delegateResults.length, 1);
  assert.match(delegateResults[0].output, /review xong: ĐẠT/);
});

test('loop: delegate_task role=coder — con gọi được read_file, maxSteps/timeout theo role', async () => {
  const dir = tmpDir();
  const parentTools = [
    fakeTool('read_file', 'nội dung file'),
    fakeTool('write_file'),
    fakeTool('shell_exec'),
    ...createSubagentTools(),
  ];
  const { calls, provider } = capturingProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'đọc file rồi sửa', role: 'coder' })] },
    { toolCalls: [toolCall('read_file', { path: 'a.ts' })] },
    { text: 'coder xong' },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, parentTools, {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  await runner.run('làm giúp tôi');
  const readResults = toolResultFor(events, 'read_file');
  assert.equal(readResults.length, 1);
  assert.equal(readResults[0].output, 'nội dung file');
  const childSystem = calls[1].messages.find((m) => m.role === 'system');
  assert.match(childSystem.content, /\[subagent chuyên biệt: coder\]/);
  assert.match(childSystem.content, /chạy test/);
});

test('loop: con không vượt quyền cha — cha chỉ có read_file/write_file thì coder cũng chỉ có 2 tool đó', async () => {
  const dir = tmpDir();
  const parentTools = [
    fakeTool('read_file', 'nội dung file'),
    fakeTool('write_file'),
    ...createSubagentTools(),
  ];
  const { calls, provider } = capturingProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'code đi', role: 'coder' })] },
    { toolCalls: [toolCall('shell_exec', { command: 'npm test' })] },
    { text: 'coder xong' },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, parentTools, {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  await runner.run('code đi');
  const childToolNames = calls[1].tools.map((t) => t.name);
  assert.ok(!childToolNames.includes('shell_exec'), 'cha không có shell_exec thì con cũng không');
  const shellResults = toolResultFor(events, 'shell_exec');
  assert.equal(shellResults.length, 1);
  assert.match(shellResults[0].output, /Không rõ công cụ: shell_exec/);
});

test('loop: delegate_task role lạ — lỗi rõ ràng, không spawn con, không gọi provider thêm', async () => {
  const dir = tmpDir();
  const { calls, provider } = capturingProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'làm gì đó', role: 'role-khong-ton-tai' })] },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  const out = await runner.run('giao việc');
  assert.equal(out, 'parent xong');
  // Chỉ 2 lần gọi provider: cha lần 1 (delegate) + cha lần 2 (kết thúc).
  // Con không bao giờ được spawn.
  assert.equal(calls.length, 2);
  const delegateResults = toolResultFor(events, 'delegate_task');
  assert.equal(delegateResults.length, 1);
  assert.match(delegateResults[0].output, /Role subagent "role-khong-ton-tai" không tồn tại/);
  assert.match(delegateResults[0].output, /researcher/);
});

test('loop: role custom qua AgentRunnerOptions.customRoles — delegate_task chạy được', async () => {
  const dir = tmpDir();
  const custom = loadRolesFromFile(EXAMPLE_JSON);
  const parentTools = [fakeTool('read_file', 'nội dung dài'), ...createSubagentTools()];
  const { calls, provider } = capturingProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'tóm tắt file', role: 'summarizer' })] },
    { text: 'tóm tắt xong' },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, parentTools, {
    bot: { ...BOT, workspaceDir: dir },
    events,
    customRoles: custom,
  });
  await runner.run('tóm tắt giúp tôi');
  assert.equal(calls.length, 3);
  const childSystem = calls[1].messages.find((m) => m.role === 'system');
  assert.match(childSystem.content, /\[subagent chuyên biệt: summarizer\]/);
  assert.match(childSystem.content, /chuyên gia tóm tắt/);
});

test('loop: runSpecializedSubagents nhận spec.role — con reviewer chỉ được tool đọc', async () => {
  const dir = tmpDir();
  const { calls, provider } = capturingProvider([
    { text: 'review xong: KHÔNG ĐẠT' },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(
    provider,
    [fakeTool('read_file', 'code'), fakeTool('write_file'), fakeTool('shell_exec')],
    { bot: { ...BOT, workspaceDir: dir }, events },
  );
  const merged = await runner.runSpecializedSubagents([
    { spec: { name: 'rev', role: 'reviewer' }, task: 'soát code' },
  ]);
  assert.match(merged, /review xong: KHÔNG ĐẠT/);
  assert.equal(calls.length, 1);
  const childToolNames = calls[0].tools.map((t) => t.name);
  assert.ok(!childToolNames.includes('write_file'));
  assert.ok(!childToolNames.includes('shell_exec'));
  const childSystem = calls[0].messages.find((m) => m.role === 'system');
  assert.match(childSystem.content, /\[subagent chuyên biệt: reviewer\]/);
});
