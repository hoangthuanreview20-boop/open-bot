/**
 * Tests for v0.54 (P1-8): checkpoint/resume + interrupt HITL + time-travel
 * replay (§12.4) + grind pause.
 *
 * Covered here (pure core + tools, no Electron, no API key, no network):
 *  - InterruptController: request / take / hasPending / clear.
 *  - matchesInterruptPoint / normalizeInterruptPoints: tên tool + predicate.
 *  - listCheckpointSummaries / replayFromCheckpoint: summary nhẹ + lỗi rõ
 *    khi không có checkpoint; replay trả đúng nextStepIndex.
 *  - AgentRunner: interruptBeforeTools với quyết định deny-tool (tool
 *    không chạy, run tiếp tục); runner.interrupt() giữa run với handler
 *    continue-with-message (message mới vào history, chạy tiếp đúng step);
 *    không có handler thì run dừng an toàn + checkpoint đã lưu;
 *    replayFrom() chạy lại từ checkpoint mà không gọi lại tool đã xong.
 *  - Grind: pauseGrind / resumeGrind / advanceGrind từ chối khi paused;
 *    tool grind_pause; GrindSession.pause().
 *  - Coordinator RPC: interruptRun (run lạ → accepted:false; run đang
 *    chạy + handler cancel → dừng với text hủy), listBotCheckpoints,
 *    replayRun (sai run → lỗi rõ), respondInterrupt.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/interrupt-checkpoint-v054.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { InterruptController, matchesInterruptPoint, normalizeInterruptPoints } from '../packages/core/dist/agent/interrupt.js';
import {
  BotMemory,
  GrindSession,
  INTERRUPT_CANCELLED_TEXT,
  advanceGrind,
  getGrindStatus,
  listCheckpointSummaries,
  listCheckpoints,
  pauseGrind,
  replayFromCheckpoint,
  resumeGrind,
  resumeFromCheckpoint,
  saveCheckpoint,
  startGrind,
} from '../packages/core/dist/index.js';
import { createAgentTools } from '../packages/tools/dist/agentTools.js';

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
  const calls = [];
  const tool = {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: opts.needsApproval ?? false,
    calls,
    async execute(args) {
      calls.push(args);
      return opts.output ?? `ok:${name}`;
    },
  };
  return tool;
}

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

function makeEvents(overrides = {}) {
  return {
    texts: [],
    toolCalls: [],
    toolResults: [],
    onText(d) {
      this.texts.push(d);
    },
    onToolCall(c) {
      this.toolCalls.push(c);
    },
    onToolResult(r) {
      this.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
    ...overrides,
  };
}

function makeBot(workspaceDir, overrides = {}) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: false,
    ...overrides,
  };
}

function coordinatorBotConfig(id, name, workspaceDir) {
  return {
    id,
    name,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

// ---------------------------------------------------------------------------
// 1. InterruptController + matching (thuần túy)
// ---------------------------------------------------------------------------

test('P1-8: InterruptController request/take/hasPending/clear', () => {
  const c = new InterruptController();
  assert.equal(c.hasPending(), false);
  assert.equal(c.take(), null);
  c.request('user-requested', 'dừng lại hỏi đã');
  assert.equal(c.hasPending(), true);
  assert.deepEqual(c.take(), { reason: 'user-requested', question: 'dừng lại hỏi đã' });
  assert.equal(c.hasPending(), false);
  c.request();
  assert.deepEqual(c.take(), { reason: 'user-requested', question: undefined });
  c.request('step-boundary');
  c.clear();
  assert.equal(c.hasPending(), false);
});

test('P1-8: matchesInterruptPoint theo tên + predicate; predicate lỗi thì không khớp', () => {
  const call = { id: 'c1', name: 'write_file', args: { path: 'a.txt' } };
  assert.equal(matchesInterruptPoint(call, ['write_file']), true);
  assert.equal(matchesInterruptPoint(call, ['read_file']), false);
  assert.equal(matchesInterruptPoint(call, [(c) => c.name.startsWith('write')]), true);
  assert.equal(
    matchesInterruptPoint(call, [
      () => {
        throw new Error('predicate hỏng');
      },
    ]),
    false,
  );
  assert.deepEqual(normalizeInterruptPoints(undefined), []);
  assert.deepEqual(normalizeInterruptPoints('write_file'), ['write_file']);
  assert.deepEqual(normalizeInterruptPoints(['a', 'b']), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 2. Checkpoint summaries + time-travel replay (thuần túy)
// ---------------------------------------------------------------------------

test('P1-8: listCheckpointSummaries nhẹ + replayFromCheckpoint lỗi rõ khi thiếu', () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'làm việc' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] },
    { role: 'tool', content: 'nội dung', toolCallId: 'c1' },
  ];
  saveCheckpoint(memory, {
    runId: 'run-sum',
    botId: 'bot-1',
    stepIndex: 0,
    messages,
    toolCalls: [{ call: { id: 'c1', name: 'read_file', args: {} }, result: { callId: 'c1', ok: true, output: 'nội dung' } }],
    tokensUsed: 42,
  });
  saveCheckpoint(memory, {
    runId: 'run-sum',
    botId: 'bot-1',
    stepIndex: 1,
    messages: [...messages, { role: 'assistant', content: 'xong' }],
    toolCalls: [],
    tokensUsed: 50,
  });
  const summaries = listCheckpointSummaries(memory, 'run-sum');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].stepIndex, 0);
  assert.equal(summaries[0].messageCount, 4);
  assert.equal(summaries[0].toolCallCount, 1);
  assert.equal(summaries[0].tokensUsed, 42);
  assert.equal(summaries[1].messageCount, 5);

  const replayed = replayFromCheckpoint(memory, 'run-sum', 0);
  assert.equal(replayed.nextStepIndex, 1);
  assert.equal(replayed.messages.length, 4);
  assert.equal(replayed.completedToolCalls.length, 1);
  assert.throws(() => replayFromCheckpoint(memory, 'run-khong-co'), /Không replay được run "run-khong-co"/);
  assert.throws(() => replayFromCheckpoint(memory, 'run-sum', 9), /chưa có checkpoint ở step 9/);
  // resumeFromCheckpoint cũ vẫn trả null khi thiếu (không throw).
  assert.equal(resumeFromCheckpoint(memory, 'run-khong-co'), null);
});

// ---------------------------------------------------------------------------
// 3. AgentRunner: interruptBeforeTools (deny-tool) + interrupt() giữa run
// ---------------------------------------------------------------------------

test('P1-8: loop interruptBeforeTools deny-tool — tool không chạy, run tiếp tục', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const writeFile = makeTool('write_file', { output: 'đã ghi' });
  const seen = [];
  const provider = scriptedProvider(
    [
      { text: '', toolCalls: [{ id: `call-${++callSeq}`, name: 'write_file', args: { path: 'a.txt' } }] },
      { text: 'đã xong, không ghi file' },
    ],
    seen,
  );
  const decisions = [];
  const events = makeEvents();
  const runner = new AgentRunner(provider, [writeFile], {
    bot: makeBot(ws),
    events,
    memory,
    runId: 'run-deny',
    interruptBeforeTools: ['write_file'],
    onInterrupt: async (req) => {
      decisions.push(req);
      return { action: 'deny-tool' };
    },
  });
  const text = await runner.run('ghi file a.txt giúp');
  assert.equal(text, 'đã xong, không ghi file');
  assert.equal(writeFile.calls.length, 0, 'tool bị từ chối thì không được chạy');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, 'before-tool');
  assert.equal(decisions[0].toolCall.name, 'write_file');
  // Kết quả "bị từ chối" nằm trong history để model thấy.
  assert.equal(events.toolResults.length, 1);
  assert.equal(events.toolResults[0].ok, false);
  assert.match(events.toolResults[0].output, /từ chối/);
});

test('P1-8: loop runner.interrupt() giữa run — handler continue-with-message, chạy tiếp đúng step', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const readFile = makeTool('read_file', { output: 'nội dung a.txt' });
  const seen = [];
  const provider = scriptedProvider(
    [
      { text: '', toolCalls: [{ id: `call-${++callSeq}`, name: 'read_file', args: { path: 'a.txt' } }] },
      { text: 'đọc xong' },
    ],
    seen,
  );
  const decisions = [];
  let runner;
  const events = makeEvents({
    onToolResult(r) {
      this.toolResults.push(r);
      // User bấm "tạm dừng" ngay khi tool đầu xong — dừng ở biên step sau.
      runner.interrupt('user-requested', 'kiểm tra lại giúp mình');
    },
  });
  runner = new AgentRunner(provider, [readFile], {
    bot: makeBot(ws),
    events,
    memory,
    runId: 'run-interrupt',
    onInterrupt: async (req) => {
      decisions.push(req);
      return { action: 'continue-with-message', message: 'ghi chú thêm: ưu tiên phần kết luận' };
    },
  });
  const text = await runner.run('đọc file a.txt');
  assert.equal(text, 'đọc xong');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, 'user-requested');
  assert.equal(decisions[0].question, 'kiểm tra lại giúp mình');
  // Message của user được đẩy vào history trước step tiếp theo.
  const secondRequest = seen[1];
  assert.ok(secondRequest, 'phải có request thứ hai');
  const userMessages = secondRequest.messages.filter((m) => m.role === 'user');
  assert.ok(
    userMessages.some((m) => String(m.content).includes('ghi chú thêm')),
    'message continue-with-message phải nằm trong history gửi cho model',
  );
  // Checkpoint của step đã xong vẫn lưu (resume được).
  assert.ok(listCheckpoints(memory, 'run-interrupt').length >= 1);
});

test('P1-8: loop interrupt không có handler — dừng an toàn, checkpoint đã lưu', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const readFile = makeTool('read_file', { output: 'nội dung' });
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: `call-${++callSeq}`, name: 'read_file', args: { path: 'a.txt' } }] },
    { text: 'không tới được đây' },
  ]);
  let runner;
  const events = makeEvents({
    onToolResult(r) {
      this.toolResults.push(r);
      runner.interrupt();
    },
  });
  runner = new AgentRunner(provider, [readFile], {
    bot: makeBot(ws),
    events,
    memory,
    runId: 'run-no-handler',
    // Không có onInterrupt → dừng an toàn, không treo.
  });
  const text = await runner.run('đọc file');
  assert.match(text, /Đã tạm dừng run ở step 2/);
  assert.equal(listCheckpoints(memory, 'run-no-handler').length, 1);
  assert.equal(listCheckpoints(memory, 'run-no-handler')[0].stepIndex, 0);
});

test('P1-8: loop replayFrom() chạy lại từ checkpoint mà không gọi lại tool đã xong', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const readFile = makeTool('read_file', { output: 'nội dung a.txt' });
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: `call-${++callSeq}`, name: 'read_file', args: { path: 'a.txt' } }] },
    { text: 'đọc xong' },
  ]);
  const runner = new AgentRunner(provider, [readFile], {
    bot: makeBot(ws),
    events: makeEvents(),
    memory,
    runId: 'run-replay',
  });
  assert.equal(await runner.run('đọc file a.txt'), 'đọc xong');
  assert.equal(readFile.calls.length, 1);
  const state = replayFromCheckpoint(memory, 'run-replay', 0);
  const replayProvider = scriptedProvider([{ text: 'chạy lại xong' }]);
  const replayRunner = new AgentRunner(replayProvider, [readFile], {
    bot: makeBot(ws),
    events: makeEvents(),
    memory,
    runId: 'run-replay',
  });
  assert.equal(await replayRunner.replayFrom(state.messages, state.nextStepIndex), 'chạy lại xong');
  assert.equal(readFile.calls.length, 1, 'tool đã xong trong checkpoint không chạy lại');
});

// ---------------------------------------------------------------------------
// 4. Grind pause / resume (run dài nhất)
// ---------------------------------------------------------------------------

test('P1-8: grind pause/resume — advance từ chối khi paused, resume mở lại', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const { projectId } = startGrind(memory, 'bot-1', 'Dọn dẹp repo', ['Bước 1', 'Bước 2', 'Bước 3'], { sliceSize: 1 });
  const paused = pauseGrind(memory, 'bot-1', projectId, 'kiểm tra bước 1 đã ổn chưa?');
  assert.equal(paused.status, 'paused');
  assert.match(paused.checkpoint, /kiểm tra bước 1 đã ổn chưa/);
  await assert.rejects(
    advanceGrind(memory, 'bot-1', projectId, async () => 'xong'),
    /đang tạm dừng/,
  );
  const resumed = resumeGrind(memory, 'bot-1', projectId);
  assert.equal(resumed.state.status, 'running');
  const advanced = await advanceGrind(memory, 'bot-1', projectId, async () => 'xong bước 1');
  assert.equal(advanced.state.completedStepIds.length, 1);
  assert.equal(getGrindStatus(memory, 'bot-1', projectId).doneSteps, 1);
  // Chạy hết 2 bước còn lại → grind done; pause grind đã done thì lỗi rõ.
  await advanceGrind(memory, 'bot-1', projectId, async () => 'xong bước 2');
  const last = await advanceGrind(memory, 'bot-1', projectId, async () => 'xong bước 3');
  assert.equal(last.state.status, 'done');
  assert.equal(getGrindStatus(memory, 'bot-1', projectId).doneSteps, 3);
  assert.throws(() => pauseGrind(memory, 'bot-1', projectId), /đã hoàn tất/);
  assert.throws(() => pauseGrind(memory, 'bot-1', 'project-khong-co'), /Không thấy grind/);
});

test('P1-8: tool grind_pause + GrindSession.pause()', async () => {
  const ws = makeTempDir('open-bot-v054-');
  const memory = new BotMemory(ws);
  const tools = createAgentTools({ memory });
  const byName = (name) => tools.find((t) => t.definition.name === name);
  assert.ok(byName('grind_pause'), 'tool grind_pause phải có trong registry');
  const session = new GrindSession(memory, 'bot-1');
  session.start('Mục tiêu dài', ['A', 'B'], { sliceSize: 1 });
  const projectId = session.status().state.projectId;
  const paused = JSON.parse(
    await byName('grind_pause').execute({ projectId, question: 'dừng hỏi user' }, { botId: 'bot-1', workspaceDir: ws }),
  );
  assert.equal(paused.status, 'paused');
  assert.match(paused.checkpoint, /dừng hỏi user/);
  const sessionPaused = session.pause('hỏi lại');
  assert.equal(sessionPaused.status, 'paused');
});

// ---------------------------------------------------------------------------
// 5. Coordinator RPC: interruptRun / listBotCheckpoints / replayRun
// ---------------------------------------------------------------------------

test('P1-8: coordinator interruptRun — run lạ từ chối, run đang chạy dừng theo handler cancel', async () => {
  const notifications = [];
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    emit: (n) => notifications.push(n),
    interruptHandler: async () => ({ action: 'cancel' }),
  });
  await coordinator.createBot({
    bot: coordinatorBotConfig('it-1', 'Bot interrupt', makeTempDir('open-bot-v054-')),
    provider: {
      id: 'mock',
      mockResponses: [
        // delayMs ở response ĐẦU: step 0 chờ provider 150ms nên poll
        // interruptRun (25ms) chắc chắn gặp runner đã đăng ký trong lúc
        // run còn ở step 0; interrupt được xếp hàng rồi step 1 top sẽ
        // dừng. (Delay ở response sau sẽ phản tác dụng: run kết thúc
        // ngay sau khi provider trả text cuối, không còn biên step nào
        // để kiểm tra interrupt.)
        { text: '', toolCalls: [{ id: 'c1', name: 'read_file', args: {} }], delayMs: 150 },
        { text: 'không tới được đây' },
      ],
    },
  });
  const unknown = coordinator.interruptRun({ runId: 'run-khong-co' });
  assert.equal(unknown.accepted, false);
  assert.match(unknown.reason ?? '', /Không có run nào đang chạy/);

  // Run đang chạy: provider trả tool call ở step 0 (toolFactory rỗng nên
  // loop trả kết quả "không rõ công cụ" và chạy tiếp, không throw).
  // Runner được đăng ký bất đồng bộ trong executeRun (sau vài await) nên
  // poll interruptRun tới khi được nhận (tối đa ~2s) thay vì gọi 1 lần.
  const runPromise = coordinator.run({ botId: 'it-1', text: 'làm việc', runId: 'run-it-1' });
  let accepted = coordinator.interruptRun({ runId: 'run-it-1', question: 'dừng kiểm tra' });
  const deadline = Date.now() + 2000;
  while (!accepted.accepted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    accepted = coordinator.interruptRun({ runId: 'run-it-1', question: 'dừng kiểm tra' });
  }
  assert.equal(accepted.accepted, true, 'interruptRun phải được nhận khi run đang chạy');
  const result = await runPromise;
  assert.equal(result.text, INTERRUPT_CANCELLED_TEXT);
  assert.equal(result.runId, 'run-it-1');
});

test('P1-8: coordinator listBotCheckpoints + replayRun + respondInterrupt', async () => {
  const coordinator = new AgentCoordinator({ toolFactory: () => [] });
  await coordinator.createBot({
    bot: coordinatorBotConfig('rp-1', 'Bot replay', makeTempDir('open-bot-v054-')),
    provider: { id: 'mock', mockResponses: [{ text: 'xong lần 1' }] },
  });
  const first = await coordinator.run({ botId: 'rp-1', text: 'làm việc', runId: 'run-rp-1' });
  assert.equal(first.text, 'xong lần 1');
  const listed = coordinator.listBotCheckpoints({ botId: 'rp-1' });
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].runId, 'run-rp-1');
  assert.ok(listed.runs[0].checkpoints.length >= 1);
  assert.equal(listed.runs[0].checkpoints[0].messageCount >= 2, true);
  const byRun = coordinator.listRunCheckpoints({ runId: 'run-rp-1' });
  assert.equal(byRun.checkpoints.length, listed.runs[0].checkpoints.length);
  assert.deepEqual(coordinator.listRunCheckpoints({ runId: 'run-khong-co' }).checkpoints, []);

  const replayed = await coordinator.replayRun({ botId: 'rp-1', runId: 'run-rp-1', stepIndex: 0 });
  assert.equal(replayed.text, 'xong lần 1');
  assert.equal(replayed.replayedFromStep, 0);
  await assert.rejects(
    coordinator.replayRun({ botId: 'rp-1', runId: 'run-khong-co' }),
    /Không replay được run "run-khong-co"/,
  );
  // respondInterrupt khi không có request chờ → found:false (không throw).
  assert.deepEqual(coordinator.respondInterrupt({ requestId: 'req-khong-co', decision: { action: 'cancel' } }), {
    found: false,
  });
});
