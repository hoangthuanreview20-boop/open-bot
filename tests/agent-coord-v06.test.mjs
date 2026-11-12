/**
 * agent-coord-v06.test.mjs — agent-to-agent / grind / reflect / permissions (v0.6).
 * Mock provider only, no network, no x.ai. BotMemory thật trên thư mục tạm
 * (checkpoint grind + reflection note lưu bền thật).
 * Run: node --test tests/agent-coord-v06.test.mjs (after building core + tools)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import {
  GrindSession,
  advanceGrind,
  getGrindStatus,
  reflectOnProgress,
  resumeGrind,
  startGrind,
  stopGrind,
} from '../packages/core/dist/agent/coordination.js';
import {
  AgentPermissions,
  checkToolCall,
} from '../packages/core/dist/agent/permissions.js';
import { AGENT_TOOLS, createAgentTools, defaultCanReadBot } from '../packages/tools/dist/agentTools.js';

const BOT_A = 'bot-a';
const BOT_B = 'bot-b';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-agentcoord-'));
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

function ctx(botId = BOT_A, extra = {}) {
  return { workspaceDir: '', botId, ...extra };
}

/** AgentRunner với mock provider trả về đúng 1 câu trả lời rồi lặp lại. */
function inProcessRunner(replyText) {
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      return { text: replyText, toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const events = {
    onText() {},
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => true,
  };
  return new AgentRunner(provider, [], {
    bot: {
      id: BOT_B,
      name: 'B',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are bot B.',
      workspaceDir: '',
      autoApprove: true,
    },
    events,
  });
}

test('create_agent: validate + tạo bot qua callback, trả id + tên', async () => {
  const store = new Map();
  const tools = createAgentTools({
    createBot: async (config) => {
      const id = `bot-${store.size + 1}`;
      const info = { id, name: config.name, providerId: config.providerId, model: config.model, mode: config.mode };
      store.set(id, info);
      return info;
    },
  });
  const c = ctx();
  const created = JSON.parse(
    await toolByName(tools, 'create_agent').execute(
      { name: 'Trợ lý code', providerId: 'ollama', model: 'qwen2.5:0.5b', mode: 'plan' },
      c,
    ),
  );
  assert.equal(created.name, 'Trợ lý code');
  assert.equal(created.providerId, 'ollama');
  assert.equal(created.mode, 'plan');
  assert.ok(created.id.startsWith('bot-'));
  assert.equal(store.size, 1);

  // Validate: tên rỗng, provider rỗng, mode sai đều lỗi rõ.
  assert.match(
    await toolByName(tools, 'create_agent').execute({ name: '  ', providerId: 'ollama', model: 'm' }, c),
    /Tên bot không được rỗng/,
  );
  assert.match(
    await toolByName(tools, 'create_agent').execute({ name: 'X', providerId: 'ollama', model: 'm', mode: 'turbo' }, c),
    /Invalid mode "turbo"/,
  );
  // Không có callback createBot -> lỗi rõ, không crash.
  assert.match(
    await toolByName(AGENT_TOOLS, 'create_agent').execute({ name: 'X', providerId: 'ollama', model: 'm' }, c),
    /chưa có callback createBot/,
  );
});

test('message_agent: sendToAgent trả reply; rỗng = queued; fallback AgentRunner mock; không kênh thì lỗi rõ', async () => {
  const seen = [];
  const tools = createAgentTools({
    sendToAgent: async (botId, text) => {
      seen.push([botId, text]);
      return botId === BOT_B ? 'nhận được rồi' : '';
    },
  });
  const c = ctx();
  const replied = JSON.parse(
    await toolByName(tools, 'message_agent').execute({ botId: BOT_B, text: 'chào B' }, c),
  );
  assert.equal(replied.reply, 'nhận được rồi');
  assert.equal(replied.queued, false);
  assert.deepEqual(seen, [[BOT_B, 'chào B']]);

  const queued = JSON.parse(
    await toolByName(tools, 'message_agent').execute({ botId: 'bot-khac', text: 'chào' }, c),
  );
  assert.equal(queued.queued, true);

  // Fallback in-process: AgentRunner + mock provider thật.
  const fallbackTools = createAgentTools({
    runAgentInProcess: async (botId, text) => inProcessRunner('chào từ bot-b').run(text),
  });
  const viaRunner = JSON.parse(
    await toolByName(fallbackTools, 'message_agent').execute({ botId: BOT_B, text: 'ping' }, c),
  );
  assert.equal(viaRunner.reply, 'chào từ bot-b');

  // Coordinator fallback: run() trả { text }.
  const coordTools = createAgentTools({
    coordinator: { run: async () => ({ text: 'trả qua coordinator' }) },
  });
  const viaCoord = JSON.parse(
    await toolByName(coordTools, 'message_agent').execute({ botId: BOT_B, text: 'ping' }, c),
  );
  assert.equal(viaCoord.reply, 'trả qua coordinator');

  assert.match(
    await toolByName(AGENT_TOOLS, 'message_agent').execute({ botId: BOT_B, text: 'ping' }, c),
    /chưa có kênh gửi/,
  );
});

test('set_agent_mode: mode hợp lệ lưu bền vào memory; mode sai lỗi rõ', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const tools = createAgentTools({ memory: mem });
    const c = ctx();
    const first = JSON.parse(
      await toolByName(tools, 'set_agent_mode').execute({ botId: BOT_A, mode: 'grind' }, c),
    );
    assert.equal(first.mode, 'grind');
    assert.equal(mem.getMemory(BOT_A, 'agent:mode'), 'grind');
    const second = JSON.parse(
      await toolByName(tools, 'set_agent_mode').execute({ botId: BOT_A, mode: 'review' }, c),
    );
    assert.equal(second.previous, 'grind');
    assert.equal(mem.getMemory(BOT_A, 'agent:mode'), 'review');
    assert.match(
      await toolByName(tools, 'set_agent_mode').execute({ botId: BOT_A, mode: 'turbo' }, c),
      /Invalid mode "turbo"/,
    );
  } finally {
    mem.close();
  }
});

test('reflect: tóm tắt có cấu trúc từ history + task thật, lưu note vào memory', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    mem.saveMessage(BOT_A, 'user', 'hãy viết báo cáo');
    mem.saveMessage(BOT_A, 'assistant', 'đã viết xong phần 1, còn lỗi ở phần 2 chưa sửa được');
    const doneId = mem.createTask(BOT_A, 'Viết phần 1');
    mem.updateTask(doneId, 'done');
    const stuckId = mem.createTask(BOT_A, 'Sửa lỗi phần 2');
    mem.updateTask(stuckId, 'in_progress');
    mem.createTask(BOT_A, 'Viết phần 3');
    mem.createTask(BOT_A, 'Gửi báo cáo');

    // Hàm core trực tiếp.
    const direct = reflectOnProgress(mem, BOT_A);
    assert.deepEqual(direct.done, ['Viết phần 1']);
    assert.ok(direct.blocked.some((b) => b.includes('Sửa lỗi phần 2')));
    assert.ok(direct.blocked.some((b) => b.includes('lỗi')));
    assert.deepEqual(direct.nextSteps, ['Viết phần 3', 'Gửi báo cáo']);
    assert.equal(direct.counts.tasksDone, 1);
    assert.match(direct.summary, /đã xong 1 task/);

    // Qua tool reflect: lưu note thật vào memory.
    const tools = createAgentTools({ memory: mem });
    const out = JSON.parse(await toolByName(tools, 'reflect').execute({}, ctx()));
    assert.equal(out.botId, BOT_A);
    assert.deepEqual(out.done, ['Viết phần 1']);
    assert.ok(out.savedKeys.includes('reflection:latest'));
    const saved = JSON.parse(mem.getMemory(BOT_A, 'reflection:latest'));
    assert.equal(saved.botId, BOT_A);
    assert.deepEqual(saved.nextSteps, ['Viết phần 3', 'Gửi báo cáo']);
    // reflect không làm bẩn history chat (chỉ ghi memory_entries).
    assert.equal(mem.getHistory(BOT_A).length, 2);
  } finally {
    mem.close();
  }
});

test('search_conversations: tìm qua memory của mọi bot, trích đoạn có botId', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    mem.saveMessage(BOT_A, 'user', 'hãy tìm hiểu về GRIND và checkpoint');
    mem.saveMessage(BOT_A, 'assistant', 'ok');
    mem.saveMessage(BOT_B, 'user', 'kế hoạch grind cho dự án X');
    mem.saveMessage(BOT_B, 'assistant', 'không liên quan');
    const tools = createAgentTools({
      memory: mem,
      listBotIds: () => [BOT_A, BOT_B],
    });
    const hits = JSON.parse(
      await toolByName(tools, 'search_conversations').execute({ query: 'grind' }, ctx()),
    );
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.botId).sort(), [BOT_A, BOT_B]);
    assert.ok(hits.every((h) => h.content.toLowerCase().includes('grind')));

    // Callback searchAllHistories được ưu tiên.
    const override = createAgentTools({
      searchAllHistories: async (q) => [{ botId: 'bot-x', role: 'user', content: `hit cho ${q}` }],
    });
    const hits2 = JSON.parse(
      await toolByName(override, 'search_conversations').execute({ query: 'zz' }, ctx()),
    );
    assert.equal(hits2.length, 1);
    assert.equal(hits2[0].botId, 'bot-x');

    // Không có kênh tìm -> lỗi rõ.
    assert.match(
      await toolByName(AGENT_TOOLS, 'search_conversations').execute({ query: 'x' }, ctx()),
      /chưa được hỗ trợ/,
    );
  } finally {
    mem.close();
  }
});

test('read_agent_transcript: cùng user được đọc, khác team bị từ chối, canReadBot override được', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    mem.saveMessage(BOT_B, 'user', 'bí mật của B');
    mem.saveMessage(BOT_B, 'assistant', 'trả lời B');
    const tools = createAgentTools({ memory: mem, listBotIds: () => [BOT_A, BOT_B] });
    const ok = JSON.parse(
      await toolByName(tools, 'read_agent_transcript').execute({ botId: BOT_B }, ctx(BOT_A)),
    );
    assert.equal(ok.botId, BOT_B);
    assert.equal(ok.messages.length, 2);
    assert.equal(ok.messages[0].content, 'bí mật của B');

    // Bot ngoài danh sách user sở hữu -> khác team -> từ chối.
    const denied = await toolByName(tools, 'read_agent_transcript').execute(
      { botId: 'bot-ngoai-team' },
      ctx(BOT_A),
    );
    assert.match(denied, /Không có quyền đọc transcript/);

    // defaultCanReadBot: tự đọc mình + cùng user cho phép, khác team từ chối.
    assert.equal(defaultCanReadBot(BOT_A, BOT_A, []), true);
    assert.equal(defaultCanReadBot(BOT_A, BOT_B, [BOT_A, BOT_B]), true);
    assert.equal(defaultCanReadBot(BOT_A, 'bot-la', [BOT_A, BOT_B]), false);

    // Host override canReadBot: cho phép cả bot ngoài team (vd bot được share).
    const shared = createAgentTools({
      memory: mem,
      canReadBot: async (req, target) => target === 'bot-shared',
    });
    mem.saveMessage('bot-shared', 'user', 'transcript được share');
    const sharedOut = JSON.parse(
      await toolByName(shared, 'read_agent_transcript').execute({ botId: 'bot-shared' }, ctx(BOT_A)),
    );
    assert.equal(sharedOut.messages[0].content, 'transcript được share');
  } finally {
    mem.close();
  }
});

test('grind (coordination): start -> advance từng lát -> checkpoint bền -> resume tiếp tục', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const session = new GrindSession(mem, BOT_A);
    const state = session.start('Ra mắt web', ['Thiết kế', 'Code', 'Test', 'Deploy'], { sliceSize: 2 });
    assert.equal(state.status, 'running');
    assert.equal(state.totalSlices, 2);
    assert.match(state.checkpoint, /Đã lập kế hoạch/);
    // Checkpoint lưu bền thật: đọc lại từ memory_entries.
    const stored = JSON.parse(mem.getMemory(BOT_A, `grind:${state.projectId}`));
    assert.equal(stored.goal, 'Ra mắt web');

    // Planning-only advance: trả lát, không đổi task/checkpoint.
    const preview = await advanceGrind(mem, BOT_A, state.projectId);
    assert.deepEqual(preview.slice.map((s) => s.title), ['Thiết kế', 'Code']);
    assert.deepEqual(preview.results, []);
    assert.equal(mem.listTasks(BOT_A, { status: 'done' }).length, 0);

    // Advance thật với runStep giả: xong lát 1, checkpoint cập nhật.
    const ran = [];
    const r1 = await session.advance(async (step) => {
      ran.push(step.title);
      return `xong ${step.title}`;
    });
    assert.deepEqual(ran, ['Thiết kế', 'Code']);
    assert.equal(r1.state.currentSlice, 1);
    assert.match(r1.state.checkpoint, /Checkpoint lát 1\/2/);
    assert.equal(mem.listTasks(BOT_A, { status: 'done' }).length, 2);

    // Resume: lát tiếp theo là Test + Deploy (đọc từ checkpoint bền).
    const resumed = resumeGrind(mem, BOT_A, state.projectId);
    assert.deepEqual(resumed.nextSlice.map((s) => s.title), ['Test', 'Deploy']);
    const r2 = await session.advance(async (step) => `xong ${step.title}`);
    assert.equal(r2.state.status, 'done');
    assert.equal(mem.listTasks(BOT_A, { status: 'done' }).length, 4);

    // startGrind / getGrindStatus / stopGrind trực tiếp.
    const started = startGrind(mem, BOT_A, 'Grind 2', ['A', 'B'], { sliceSize: 1 });
    const report = getGrindStatus(mem, BOT_A, started.projectId);
    assert.equal(report.totalSteps, 2);
    assert.equal(report.pendingSteps, 2);
    assert.deepEqual(report.nextSlice, ['A']);
    const stopped = stopGrind(mem, BOT_A, started.projectId, 'hết giờ');
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.checkpoint, /Đã dừng grind/);
    assert.throws(() => getGrindStatus(mem, BOT_A, 'không-tồn-tại'), /Không thấy grind/);
  } finally {
    mem.close();
  }
});

test('grind tools: grind_start/status/stop qua tool, executeFirstSlice chạy qua runSubagent', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const tools = createAgentTools({ memory: mem });
    const c = ctx();
    const started = JSON.parse(
      await toolByName(tools, 'grind_start').execute(
        { goal: 'Dọn kho', steps: ['Liệt kê', 'Phân loại', 'Dọn', 'Kiểm tra'], sliceSize: 2 },
        c,
      ),
    );
    assert.equal(started.goal, 'Dọn kho');
    assert.equal(started.status, 'running');
    assert.deepEqual(started.firstSlice, ['Liệt kê', 'Phân loại']);
    const projectId = started.projectId;

    const status = JSON.parse(
      await toolByName(tools, 'grind_status').execute({ projectId }, c),
    );
    assert.equal(status.totalSteps, 4);
    assert.equal(status.pendingSteps, 4);
    assert.deepEqual(status.nextSlice, ['Liệt kê', 'Phân loại']);

    // executeFirstSlice: chạy lát đầu qua ctx.runSubagent, task lát 1 thành done.
    const executed = [];
    const c2 = ctx(BOT_A, {
      runSubagent: async (task) => {
        executed.push(task);
        return `subagent xong: ${task}`;
      },
    });
    const started2 = JSON.parse(
      await toolByName(tools, 'grind_start').execute(
        { goal: 'Grind chạy thật', steps: ['B1', 'B2', 'B3'], sliceSize: 2, executeFirstSlice: true },
        c2,
      ),
    );
    assert.deepEqual(executed, ['B1', 'B2']);
    assert.match(started2.firstSliceResults[0], /done: B1/);
    assert.equal(mem.listTasks(BOT_A, { status: 'done' }).length, 2);

    const stopped = JSON.parse(
      await toolByName(tools, 'grind_stop').execute({ projectId, reason: 'test xong' }, c),
    );
    assert.equal(stopped.status, 'stopped');
    assert.match(
      await toolByName(tools, 'grind_status').execute({ projectId: 'không-tồn-tại' }, c),
      /Không thấy grind/,
    );
  } finally {
    mem.close();
  }
});

test('permissions: mặc định cho tất cả; denylist thắng; allowlist giới hạn; ask/deny; checkToolCall', () => {
  const perms = new AgentPermissions();
  // Mặc định: cho tất cả, policy allow.
  assert.equal(perms.isToolAllowed(BOT_A, 'read_file'), true);
  assert.equal(perms.approvalPolicy(BOT_A, 'read_file'), 'allow');
  assert.deepEqual(perms.checkToolCall(BOT_A, 'read_file'), {
    allowed: true,
    policy: 'allow',
    reason: 'Tool "read_file" được phép chạy.',
  });

  // Denylist: cấm shell_exec, policy deny.
  perms.setBotPolicy(BOT_A, { denyTools: ['shell_exec'] });
  assert.equal(perms.isToolAllowed(BOT_A, 'shell_exec'), false);
  assert.equal(perms.isToolAllowed(BOT_A, 'read_file'), true);
  assert.equal(perms.approvalPolicy(BOT_A, 'shell_exec'), 'deny');
  const denied = perms.checkToolCall(BOT_A, 'shell_exec');
  assert.equal(denied.allowed, false);
  assert.equal(denied.policy, 'deny');
  assert.match(denied.reason, /bị cấm/);

  // Denylist thắng cả allowlist + policy allow.
  perms.setBotPolicy(BOT_B, {
    allowTools: ['shell_exec', 'read_file'],
    denyTools: ['shell_exec'],
    policies: { shell_exec: 'allow' },
  });
  assert.equal(perms.isToolAllowed(BOT_B, 'shell_exec'), false);
  assert.equal(perms.isToolAllowed(BOT_B, 'read_file'), true);

  // Allowlist: chỉ tool trong danh sách được chạy.
  perms.setBotPolicy('bot-c', { allowTools: ['read_file'] });
  assert.equal(perms.isToolAllowed('bot-c', 'read_file'), true);
  assert.equal(perms.isToolAllowed('bot-c', 'write_file'), false);

  // Policy ask: được chạy nhưng phải hỏi trước.
  perms.setBotPolicy('bot-d', { policies: { write_file: 'ask', delete_file: 'deny' } });
  assert.deepEqual(perms.checkToolCall('bot-d', 'write_file'), {
    allowed: true,
    policy: 'ask',
    reason: 'Tool "write_file" cần phê duyệt trước khi chạy.',
  });
  assert.equal(perms.checkToolCall('bot-d', 'delete_file').allowed, false);

  // Hàm standalone checkToolCall(permissions, botId, toolName).
  assert.equal(checkToolCall(perms, 'bot-d', 'write_file').policy, 'ask');
  assert.equal(checkToolCall(perms, BOT_A, 'shell_exec').allowed, false);

  // clearBotPolicy trở về mặc định.
  assert.equal(perms.clearBotPolicy(BOT_A), true);
  assert.equal(perms.isToolAllowed(BOT_A, 'shell_exec'), true);
  assert.deepEqual(perms.listBotIds().sort(), ['bot-c', 'bot-d', BOT_B].sort());
});

test('AGENT_TOOLS: đủ 12 tool; needsApproval đúng', () => {
  const names = AGENT_TOOLS.map((t) => t.definition.name);
  for (const n of [
    'create_agent', 'message_agent', 'set_agent_mode', 'reflect',
    'search_conversations', 'read_agent_transcript',
    'conversation_history', // v0.85 (P2-3): đọc lịch sử hội thoại hiện tại
    'grind_start', 'grind_status', 'grind_stop',
    'grind_pause', // v0.54 (P1-8): dừng tạm grind giữa các lát
    'supervisor_dispatch', // v0.14: route task tới bot khớp nhất
  ]) {
    assert.ok(names.includes(n), `thiếu tool ${n}`);
  }
  assert.equal(names.length, 12);
  for (const t of AGENT_TOOLS) {
    const needs = ['create_agent', 'message_agent', 'set_agent_mode', 'grind_start', 'grind_stop', 'supervisor_dispatch'].includes(
      t.definition.name,
    );
    assert.equal(t.needsApproval, needs, `${t.definition.name} needsApproval sai`);
    // Mọi tool đều có JSON Schema parameters đầy đủ.
    assert.equal(t.definition.parameters.type, 'object');
    assert.ok(Array.isArray(t.definition.parameters.required));
    assert.equal(typeof t.definition.parameters.properties, 'object');
  }
});
