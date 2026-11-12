/**
 * plan-approval-v019.test.mjs — plan đã duyệt thì run tiếp theo tự duyệt tool-call (v0.19, W12e).
 *
 * Gap v0.11: bấm Approve ở màn hình Plan xong, thẻ approval của tool-call
 * vẫn hiện lại dưới chat — duyệt 2 lần cho cùng một plan. Coordinator
 * ghi dấu "plan-approved" dùng một lần khi plan_update chạy xong với
 * reviewDecision "approve": run ngay sau đó của cùng bot được tự duyệt
 * tool-call (không hiện thẻ approval nữa), hết run thì dấu hết hiệu lực.
 *
 * Dùng mock provider + coordinator thật (in-process, như
 * tests/v012-integration.test.mjs) với toolFactory riêng: plan tools thật
 * (createPlanTools) + một tool ghi giả `test_write` (needsApproval: true)
 * để quan sát tool có chạy mà không cần approval hay không. Không gọi
 * mạng, không API key thật.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/plan-approval-v019.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { PlanService } from '../packages/core/dist/agent/planning.js';
import { submitPlanForReview } from '../packages/core/dist/agent/coordination.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { createPlanTools } from '../packages/tools/dist/planTools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plan-approval-'));
}

/**
 * Gieo một plan đang chờ duyệt vào DB của workspace (như plan_create đã
 * nộp): tạo project + task qua PlanService rồi ghi trạng thái pending qua
 * submitPlanForReview. Mở BotMemory riêng rồi đóng lại trước khi
 * coordinator tạo BotMemory của nó trên cùng file — tránh hai kết nối
 * SQLite cùng lúc.
 */
function seedPendingPlan(dir, botId) {
  const mem = new BotMemory(dir);
  try {
    const svc = new PlanService(mem);
    const plan = svc.createPlan(botId, 'Kế hoạch test', '', ['Bước 1']);
    submitPlanForReview(mem, botId, {
      projectId: plan.projectId,
      title: 'Kế hoạch test',
      steps: ['Bước 1'],
    });
    return plan.projectId;
  } finally {
    mem.close();
  }
}

/**
 * Một coordinator + bot mock cho một test. `events` nhận mọi notification;
 * thẻ approval nào hiện lên cũng được ghi vào `approvals` rồi trả lời
 * "đồng ý" — nhưng trả lời phải hoãn sang tick sau (setTimeout 0): coordinator
 * emit 'approval-needed' TRƯỚC khi ghi resolve vào pendingApprovals, nên
 * trả lời đồng bộ trong emit sẽ không tìm thấy callId và run treo tới
 * timeout 10 phút.
 */
function makeSetup(botId, dir, mockResponses) {
  const events = [];
  const approvals = [];
  const executions = [];
  let coordinator;
  coordinator = new AgentCoordinator({
    toolFactory: (memory) => [
      ...createPlanTools(memory),
      {
        definition: {
          name: 'test_write',
          description: 'Tool ghi giả để quan sát approval (test only).',
          parameters: {
            type: 'object',
            properties: { marker: { type: 'string' } },
            required: ['marker'],
            additionalProperties: false,
          },
        },
        needsApproval: true,
        async execute(args) {
          executions.push(args.marker);
          return `đã ghi ${args.marker}`;
        },
      },
    ],
    emit: (n) => {
      events.push(n);
      if (n.data?.kind === 'approval-needed') {
        approvals.push(n.data.payload);
        const callId = n.data.payload.callId;
        setTimeout(
          () => coordinator.respondApproval({ callId, approved: true }),
          0,
        );
      }
    },
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: false,
  };
  return {
    coordinator,
    events,
    approvals,
    executions,
    async createBot() {
      await coordinator.createBot({
        bot,
        provider: { id: 'mock', label: 'Mock', mockResponses },
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

function approvalNames(approvals) {
  return approvals.map((a) => a.call.name);
}

test('plan approve -> run tiếp theo tự duyệt tool-call, run sau đó lại hỏi approval', async () => {
  const dir = tmpDir();
  const botId = 'bot-plan-approved';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        {
          id: 'ap-1',
          name: 'plan_update',
          args: { projectId, reviewDecision: 'approve' },
        },
      ],
    },
    { text: 'Plan đã duyệt.' },
    {
      toolCalls: [
        { id: 'ex-1', name: 'test_write', args: { marker: 'exec-1' } },
      ],
    },
    { text: 'Đã thực thi bước 1.' },
    {
      toolCalls: [
        { id: 'ex-2', name: 'test_write', args: { marker: 'exec-2' } },
      ],
    },
    { text: 'Đã thực thi bước 2.' },
  ]);
  try {
    await setup.createBot();

    // Run 1 — duyệt plan: plan_update vẫn hỏi thẻ approval như cũ
    // (dấu chỉ ghi SAU khi plan_update chạy xong), user đồng ý ở thẻ.
    const approved = await setup.coordinator.run({ botId, text: 'duyệt plan đi' });
    assert.equal(approved.text, 'Plan đã duyệt.');
    assert.deepEqual(approvalNames(setup.approvals), ['plan_update']);
    assert.deepEqual(setup.executions, [], 'run duyệt chưa thực thi bước nào');

    // Run 2 — run của plan đã duyệt: KHÔNG hiện thẻ approval nữa,
    // tool chạy luôn.
    setup.approvals.length = 0;
    const first = await setup.coordinator.run({ botId, text: 'thực thi plan' });
    assert.equal(first.text, 'Đã thực thi bước 1.');
    assert.deepEqual(
      setup.approvals,
      [],
      'run plan-approved không được hiện thẻ approval',
    );
    assert.deepEqual(setup.executions, ['exec-1']);

    // Run 3 — dấu đã hết hiệu lực sau 1 run: tool-call lại hỏi approval
    // như thường (responder đồng ý nên tool vẫn chạy).
    setup.approvals.length = 0;
    const second = await setup.coordinator.run({ botId, text: 'làm tiếp' });
    assert.equal(second.text, 'Đã thực thi bước 2.');
    assert.deepEqual(approvalNames(setup.approvals), ['test_write']);
    assert.deepEqual(setup.executions, ['exec-1', 'exec-2']);
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan chưa duyệt -> tool-call vẫn hỏi approval như cũ', async () => {
  const dir = tmpDir();
  const botId = 'bot-no-plan';
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'plain-1' } },
      ],
    },
    { text: 'đã ghi xong' },
  ]);
  try {
    await setup.createBot();
    const result = await setup.coordinator.run({ botId, text: 'ghi giúp tôi' });
    assert.equal(result.text, 'đã ghi xong');
    assert.deepEqual(approvalNames(setup.approvals), ['test_write']);
    assert.deepEqual(setup.executions, ['plain-1']);
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan bị từ chối -> run sau vẫn hỏi approval (không được hưởng dấu)', async () => {
  const dir = tmpDir();
  const botId = 'bot-plan-rejected';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        {
          id: 'rj-1',
          name: 'plan_update',
          args: { projectId, reviewDecision: 'reject' },
        },
      ],
    },
    { text: 'Plan đã bị từ chối.' },
    {
      toolCalls: [
        { id: 'w-2', name: 'test_write', args: { marker: 'after-reject' } },
      ],
    },
    { text: 'đã ghi xong' },
  ]);
  try {
    await setup.createBot();
    const rejected = await setup.coordinator.run({ botId, text: 'từ chối plan đi' });
    assert.equal(rejected.text, 'Plan đã bị từ chối.');
    assert.deepEqual(approvalNames(setup.approvals), ['plan_update']);

    setup.approvals.length = 0;
    const result = await setup.coordinator.run({ botId, text: 'ghi giúp tôi' });
    assert.equal(result.text, 'đã ghi xong');
    assert.deepEqual(
      approvalNames(setup.approvals),
      ['test_write'],
      'plan bị từ chối thì run sau vẫn phải hỏi approval',
    );
    assert.deepEqual(setup.executions, ['after-reject']);
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan yêu cầu sửa -> run sau vẫn hỏi approval; dấu không rò sang bot khác', async () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  const botA = 'bot-plan-changes';
  const botB = 'bot-khac';
  const projectId = seedPendingPlan(dirA, botA);
  // Bot A: request-changes rồi chạy tool — vẫn hỏi approval.
  const setupA = makeSetup(botA, dirA, [
    {
      toolCalls: [
        {
          id: 'ch-1',
          name: 'plan_update',
          args: { projectId, reviewDecision: 'request-changes', note: 'sửa bước 1' },
        },
      ],
    },
    { text: 'Đã ghi yêu cầu sửa.' },
    {
      toolCalls: [
        { id: 'w-a', name: 'test_write', args: { marker: 'after-changes' } },
      ],
    },
    { text: 'đã ghi xong' },
  ]);
  // Bot B (chưa duyệt plan nào) được tạo trên CÙNG coordinator của A
  // để chứng minh dấu plan-approved gắn theo bot, không rò sang bot khác.
  try {
    await setupA.createBot();
    const decided = await setupA.coordinator.run({ botId: botA, text: 'yêu cầu sửa plan' });
    assert.equal(decided.text, 'Đã ghi yêu cầu sửa.');
    assert.deepEqual(approvalNames(setupA.approvals), ['plan_update']);

    setupA.approvals.length = 0;
    const afterChanges = await setupA.coordinator.run({ botId: botA, text: 'ghi giúp tôi' });
    assert.equal(afterChanges.text, 'đã ghi xong');
    assert.deepEqual(
      approvalNames(setupA.approvals),
      ['test_write'],
      'request-changes không ghi dấu plan-approved',
    );
    assert.deepEqual(setupA.executions, ['after-changes']);

    // Bot B chưa duyệt plan nào: tool-call của nó vẫn hỏi approval.
    await setupA.coordinator.createBot({
      bot: {
        id: botB,
        name: 'Bot khác',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'You are a test bot.',
        workspaceDir: dirB,
        autoApprove: false,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        mockResponses: [
          {
            toolCalls: [
              { id: 'w-b', name: 'test_write', args: { marker: 'bot-b-1' } },
            ],
          },
          { text: 'bot B đã ghi xong' },
        ],
      },
    });
    setupA.approvals.length = 0;
    const resultB = await setupA.coordinator.run({ botId: botB, text: 'ghi giúp tôi' });
    assert.equal(resultB.text, 'bot B đã ghi xong');
    assert.deepEqual(approvalNames(setupA.approvals), ['test_write']);
    assert.ok(setupA.executions.includes('bot-b-1'));
  } finally {
    await setupA.destroy();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
