/**
 * plan-review-rpc-v020.test.mjs — duyệt plan trực tiếp qua RPC, không qua tool-call (v0.20, W13a).
 *
 * Gap còn lại sau W12e (v0.19): plan đã duyệt thì run *tiếp theo* được
 * tự duyệt tool-call, nhưng thẻ approval của chính tool-call
 * `plan_update` trong run duyệt vẫn hiện một lần. Từ v0.20, nút
 * Approve/Reject/Request-changes ở màn hình Kế hoạch gọi thẳng
 * coordinator RPC `reviewPlan` (main chuyển tiếp qua IPC `plans:review`)
 * thay vì gửi chat để agent gọi plan_update trong run — nên không còn
 * thẻ approval nào hiện cho hành động duyệt.
 *
 * RPC phải làm đúng những gì plan_update làm khi duyệt:
 *  - reviewPlan(): cập nhật trạng thái trong bộ nhớ (pending ->
 *    approved/rejected/changes-requested, approve thì mode sang chat);
 *  - updatePlanFileStatus(): ghi quyết định vào file plan;
 *  - chỉ approve mới ghi dấu planApprovedRuns loại `approve` (tái dùng
 *    cơ chế W12e): run kế tiếp của cùng bot tự duyệt tool-call, không
 *    hiện thẻ. Request-changes ghi dấu cùng map, loại `revision`
 *    (v0.20, W15a): run kế tiếp chỉ tự duyệt riêng tool `plan_create`
 *    (lập lại plan), các tool khác vẫn hỏi approval như thường.
 * `plan_update` vẫn giữ nguyên làm tool cho agent (agent tự review plan
 * trong run thì thẻ approval hiện như thường — đã có
 * tests/plan-approval-v019.test.mjs chứng minh).
 *
 * Dùng mock provider + coordinator thật (in-process, như
 * tests/plan-approval-v019.test.mjs) với toolFactory riêng: plan tools
 * thật (createPlanTools) + một tool ghi giả `test_write`
 * (needsApproval: true) để quan sát tool có chạy mà không cần approval
 * hay không. Không gọi mạng, không API key thật.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/plan-review-rpc-v020.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { PlanService } from '../packages/core/dist/agent/planning.js';
import { readPlanFile, writePlanFile } from '../packages/core/dist/agent/planning.js';
import {
  getPlanApproval,
  submitPlanForReview,
} from '../packages/core/dist/agent/coordination.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { createPlanTools } from '../packages/tools/dist/planTools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plan-review-rpc-'));
}

/**
 * Gieo một plan đang chờ duyệt vào DB của workspace (như plan_create đã
 * nộp) + ghi file plan ra đĩa (như plan_create đã ghi): tạo project +
 * task qua PlanService, ghi trạng thái pending qua submitPlanForReview,
 * ghi file Markdown qua writePlanFile. Mở BotMemory riêng rồi đóng lại
 * trước khi coordinator tạo BotMemory của nó trên cùng file — tránh hai
 * kết nối SQLite cùng lúc.
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
    writePlanFile(dir, {
      projectId: plan.projectId,
      title: 'Kế hoạch test',
      detail: '',
      steps: ['Bước 1'],
      decisions: [],
    });
    return plan.projectId;
  } finally {
    mem.close();
  }
}

/** Đọc trạng thái duyệt trong bộ nhớ của workspace (mở riêng rồi đóng).
 * CHỈ gọi khi coordinator đã đóng BotMemory của nó — hai BotMemory cùng
 * mở một file SQLite sẽ tranh lock (xem header coordinator.ts). */
function readApprovalState(dir, botId, projectId) {
  const mem = new BotMemory(dir);
  try {
    return getPlanApproval(mem, botId, projectId);
  } finally {
    mem.close();
  }
}

/**
 * Một coordinator + bot mock cho một test. `events` nhận mọi notification;
 * thẻ approval nào hiện lên cũng được ghi vào `approvals` rồi trả lời
 * "đồng ý" — nhưng trả lời phải hoãn sang tick sau (setTimeout 0):
 * coordinator emit 'approval-needed' TRƯỚC khi ghi resolve vào
 * pendingApprovals, nên trả lời đồng bộ trong emit sẽ không tìm thấy
 * callId và run treo tới timeout 10 phút.
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
      const created = await coordinator.createBot({
        bot,
        provider: { id: 'mock', label: 'Mock', mockResponses },
      });
      assert.ok(
        created.toolNames.includes('plan_update'),
        'plan_update vẫn phải là tool của agent (chỉ đường duyệt ở UI đổi sang RPC)',
      );
      return created;
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

test('RPC review approve: không hiện thẻ nào, file ghi "đã duyệt", run kế tiếp tự duyệt', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-approved';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [
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
    try {
      await setup.createBot();

    // RPC duyệt trực tiếp — KHÔNG chạy run nào, KHÔNG hiện thẻ nào.
    const result = await setup.coordinator.reviewPlan({
      botId,
      projectId,
      decision: 'approve',
    });
    assert.equal(result.projectId, projectId);
    assert.equal(result.botId, botId);
    assert.equal(result.status, 'approved');
    assert.equal(result.mode, 'chat', 'approve chuyển mode sang chat như plan_update');
    assert.equal(result.fileStatusUpdated, true);
    assert.deepEqual(setup.approvals, [], 'RPC duyệt không được hiện thẻ approval nào');
    assert.deepEqual(setup.executions, [], 'RPC duyệt không chạy tool nào');

    // File plan ghi "đã duyệt" (đọc file thuần — an toàn khi coordinator đang chạy).
    assert.ok(
      (readPlanFile(dir, projectId) ?? '').includes('đã duyệt'),
      'file plan phải ghi "đã duyệt"',
    );

    // Run kế tiếp (thực thi plan): tự duyệt tool-call, không thẻ.
    const first = await setup.coordinator.run({ botId, text: 'thực thi plan' });
    assert.equal(first.text, 'Đã thực thi bước 1.');
    assert.deepEqual(
      setup.approvals,
      [],
      'run sau RPC approve không được hiện thẻ approval',
    );
    assert.deepEqual(setup.executions, ['exec-1']);

    // Dấu chỉ dùng một lần: run sau đó lại hỏi approval như thường.
    setup.approvals.length = 0;
    const second = await setup.coordinator.run({ botId, text: 'làm tiếp' });
    assert.equal(second.text, 'Đã thực thi bước 2.');
    assert.deepEqual(approvalNames(setup.approvals), ['test_write']);
    assert.deepEqual(setup.executions, ['exec-1', 'exec-2']);
    } finally {
      await setup.destroy();
    }
    // Coordinator đã đóng — kiểm chứng độc lập trạng thái trong bộ nhớ.
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'approved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review reject: file ghi "đã từ chối", không ghi dấu, run sau vẫn hỏi approval', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-rejected';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'after-reject' } },
      ],
    },
    { text: 'đã ghi xong' },
  ]);
  try {
    try {
      await setup.createBot();

      const result = await setup.coordinator.reviewPlan({
        botId,
        projectId,
        decision: 'reject',
      });
      assert.equal(result.status, 'rejected');
      // Seed không đặt mode plan nên mode mặc định là chat — reject giữ nguyên mode đó.
      assert.equal(result.mode, 'chat');
      assert.equal(result.fileStatusUpdated, true);
      assert.deepEqual(setup.approvals, [], 'RPC từ chối không được hiện thẻ approval nào');

      assert.ok(
        (readPlanFile(dir, projectId) ?? '').includes('đã từ chối'),
        'file plan phải ghi "đã từ chối"',
      );

      // Không có dấu plan-approved: run sau vẫn hỏi approval.
      const out = await setup.coordinator.run({ botId, text: 'ghi giúp tôi' });
      assert.equal(out.text, 'đã ghi xong');
      assert.deepEqual(approvalNames(setup.approvals), ['test_write']);
      assert.deepEqual(setup.executions, ['after-reject']);
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review request-changes: ghi note + file "yêu cầu sửa", không ghi dấu', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-changes';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'after-changes' } },
      ],
    },
    { text: 'đã ghi xong' },
  ]);
  try {
    try {
      await setup.createBot();

      const result = await setup.coordinator.reviewPlan({
        botId,
        projectId,
        decision: 'request-changes',
        note: 'sửa bước 1',
      });
      assert.equal(result.status, 'changes-requested');
      assert.equal(result.note, 'sửa bước 1');
      assert.equal(result.fileStatusUpdated, true);
      assert.deepEqual(setup.approvals, [], 'RPC yêu cầu sửa không được hiện thẻ approval nào');

      assert.ok(
        (readPlanFile(dir, projectId) ?? '').includes('yêu cầu sửa'),
        'file plan phải ghi "yêu cầu sửa"',
      );

      // Không có dấu plan-approved: run sau vẫn hỏi approval.
      const out = await setup.coordinator.run({ botId, text: 'ghi giúp tôi' });
      assert.equal(out.text, 'đã ghi xong');
      assert.deepEqual(approvalNames(setup.approvals), ['test_write']);
      assert.deepEqual(setup.executions, ['after-changes']);
    } finally {
      await setup.destroy();
    }
    const state = readApprovalState(dir, botId, projectId);
    assert.equal(state?.status, 'changes-requested');
    assert.equal(state?.note, 'sửa bước 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review: plan không tồn tại / bot không tồn tại / decision sai / duyệt lại đều lỗi rõ', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-errors';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [{ text: 'không dùng tới' }]);
  try {
    try {
      await setup.createBot();

      // Plan id không tồn tại.
      await assert.rejects(
        async () =>
          setup.coordinator.reviewPlan({
            botId,
            projectId: 'khong-co-plan-nay',
            decision: 'approve',
          }),
        /Không thấy plan đang chờ duyệt: "khong-co-plan-nay"/,
      );

      // Bot không tồn tại trong coordinator.
      await assert.rejects(
        async () =>
          setup.coordinator.reviewPlan({
            botId: 'bot-khong-co',
            projectId,
            decision: 'approve',
          }),
        /Chưa tạo bot "bot-khong-co"/,
      );

      // Decision không hợp lệ.
      await assert.rejects(
        async () =>
          setup.coordinator.reviewPlan({
            botId,
            projectId,
            decision: 'maybe',
          }),
        /decision là approve, reject hoặc request-changes/,
      );

      // Các lỗi trên không được động vào plan: duyệt vẫn thành công
      // (reviewPlan sẽ throw "đã có quyết định rồi" nếu plan không còn pending).
      const ok = await setup.coordinator.reviewPlan({
        botId,
        projectId,
        decision: 'approve',
      });
      assert.equal(ok.status, 'approved');
      // Duyệt xong rồi duyệt lại -> lỗi rõ.
      await assert.rejects(
        async () =>
          setup.coordinator.reviewPlan({
            botId,
            projectId,
            decision: 'reject',
          }),
        /đã có quyết định rồi/,
      );
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'approved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review qua handle() (đường NDJSON-RPC): method "reviewPlan" được dispatch', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-handle';
  const projectId = seedPendingPlan(dir, botId);
  const setup = makeSetup(botId, dir, [{ text: 'không dùng tới' }]);
  try {
    try {
      await setup.createBot();
      // handle() là entry point của tiến trình coordinator con khi main
      // gửi request qua stdio — IPC `plans:review` đi qua đây.
      const result = await setup.coordinator.handle('reviewPlan', {
        botId,
        projectId,
        decision: 'approve',
      });
      assert.equal(result.status, 'approved');
      assert.deepEqual(setup.approvals, []);
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'approved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review request-changes (W15a): run kế tiếp tự duyệt riêng plan_create, tool ghi khác vẫn hỏi; run sau lại hỏi cả plan_create', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-changes-revision';
  const projectId = seedPendingPlan(dir, botId);
  const planFileCount = () =>
    fs
      .readdirSync(path.join(dir, '.open-bot', 'plans'))
      .filter((f) => f.endsWith('.md')).length;
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        {
          id: 'pc-1',
          name: 'plan_create',
          args: { title: 'Kế hoạch sửa lại', steps: ['Bước sửa 1'] },
        },
      ],
    },
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'after-changes' } },
      ],
    },
    { text: 'Đã lập lại plan và ghi xong.' },
    {
      toolCalls: [
        {
          id: 'pc-2',
          name: 'plan_create',
          args: { title: 'Kế hoạch sửa lần 2', steps: ['Bước sửa 2'] },
        },
      ],
    },
    {
      toolCalls: [
        { id: 'w-2', name: 'test_write', args: { marker: 'second-run' } },
      ],
    },
    { text: 'Đã lập lại lần 2 và ghi xong.' },
  ]);
  try {
    try {
      await setup.createBot();
      assert.equal(planFileCount(), 1, 'seed chỉ ghi 1 file plan');

      const result = await setup.coordinator.reviewPlan({
        botId,
        projectId,
        decision: 'request-changes',
        note: 'sửa bước 1',
      });
      assert.equal(result.status, 'changes-requested');
      assert.deepEqual(setup.approvals, [], 'RPC yêu cầu sửa không được hiện thẻ approval nào');

      // Run kế tiếp: plan_create chạy luôn không thẻ (dấu revision),
      // nhưng test_write trong cùng run vẫn hỏi approval như thường.
      const first = await setup.coordinator.run({ botId, text: 'lập lại plan theo yêu cầu sửa' });
      assert.equal(first.text, 'Đã lập lại plan và ghi xong.');
      assert.deepEqual(
        approvalNames(setup.approvals),
        ['test_write'],
        'dấu revision chỉ tự duyệt plan_create, test_write vẫn phải hỏi',
      );
      assert.deepEqual(setup.executions, ['after-changes']);
      assert.equal(planFileCount(), 2, 'plan_create đã chạy và ghi file plan mới');

      // Dấu revision chỉ dùng một lần: run sau đó lại hỏi cả plan_create.
      setup.approvals.length = 0;
      const second = await setup.coordinator.run({ botId, text: 'lập lại lần nữa' });
      assert.equal(second.text, 'Đã lập lại lần 2 và ghi xong.');
      assert.deepEqual(approvalNames(setup.approvals), ['plan_create', 'test_write']);
      assert.deepEqual(setup.executions, ['after-changes', 'second-run']);
      assert.equal(planFileCount(), 3, 'plan_create ở run sau vẫn chạy (sau khi được duyệt)');
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'changes-requested');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC review approve (W15a, không regression): dấu approve vẫn tự duyệt mọi tool kể cả plan_create', async () => {
  const dir = tmpDir();
  const botId = 'bot-rpc-approved-plan-create';
  const projectId = seedPendingPlan(dir, botId);
  const planFileCount = () =>
    fs
      .readdirSync(path.join(dir, '.open-bot', 'plans'))
      .filter((f) => f.endsWith('.md')).length;
  const setup = makeSetup(botId, dir, [
    {
      toolCalls: [
        {
          id: 'pc-1',
          name: 'plan_create',
          args: { title: 'Kế hoạch mới sau duyệt', steps: ['Bước mới 1'] },
        },
      ],
    },
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'exec-approved' } },
      ],
    },
    { text: 'Đã lập plan mới và ghi xong.' },
  ]);
  try {
    try {
      await setup.createBot();
      const result = await setup.coordinator.reviewPlan({
        botId,
        projectId,
        decision: 'approve',
      });
      assert.equal(result.status, 'approved');

      const first = await setup.coordinator.run({ botId, text: 'lập plan mới và ghi' });
      assert.equal(first.text, 'Đã lập plan mới và ghi xong.');
      assert.deepEqual(
        setup.approvals,
        [],
        'dấu approve tự duyệt mọi tool, kể cả plan_create lẫn test_write',
      );
      assert.deepEqual(setup.executions, ['exec-approved']);
      assert.equal(planFileCount(), 2, 'plan_create đã chạy và ghi file plan mới');
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'approved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan_update request-changes qua tool (W16a): run kế tiếp tự duyệt riêng plan_create, tool ghi khác vẫn hỏi; run sau lại hỏi cả plan_create', async () => {
  const dir = tmpDir();
  const botId = 'bot-tool-changes-revision';
  const projectId = seedPendingPlan(dir, botId);
  const planFileCount = () =>
    fs
      .readdirSync(path.join(dir, '.open-bot', 'plans'))
      .filter((f) => f.endsWith('.md')).length;
  const setup = makeSetup(botId, dir, [
    // Run 1 — agent gọi plan_update request-changes qua đường tool.
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
    // Run 2 — lập lại plan + ghi: plan_create tự duyệt, test_write vẫn hỏi.
    {
      toolCalls: [
        {
          id: 'pc-1',
          name: 'plan_create',
          args: { title: 'Kế hoạch sửa lại', steps: ['Bước sửa 1'] },
        },
      ],
    },
    {
      toolCalls: [
        { id: 'w-1', name: 'test_write', args: { marker: 'after-changes' } },
      ],
    },
    { text: 'Đã lập lại plan và ghi xong.' },
    // Run 3 — dấu đã tiêu thụ: cả plan_create lẫn test_write đều hỏi lại.
    {
      toolCalls: [
        {
          id: 'pc-2',
          name: 'plan_create',
          args: { title: 'Kế hoạch sửa lần 2', steps: ['Bước sửa 2'] },
        },
      ],
    },
    {
      toolCalls: [
        { id: 'w-2', name: 'test_write', args: { marker: 'second-run' } },
      ],
    },
    { text: 'Đã lập lại lần 2 và ghi xong.' },
  ]);
  try {
    try {
      await setup.createBot();
      assert.equal(planFileCount(), 1, 'seed chỉ ghi 1 file plan');

      // Run 1: chính tool-call plan_update vẫn hiện thẻ như cũ (dấu
      // chỉ ghi SAU khi plan_update chạy xong), user đồng ý ở thẻ.
      const decided = await setup.coordinator.run({ botId, text: 'yêu cầu sửa plan' });
      assert.equal(decided.text, 'Đã ghi yêu cầu sửa.');
      assert.deepEqual(approvalNames(setup.approvals), ['plan_update']);
      assert.ok(
        (readPlanFile(dir, projectId) ?? '').includes('yêu cầu sửa'),
        'file plan phải ghi "yêu cầu sửa" sau plan_update request-changes',
      );

      // Run 2: dấu revision qua đường tool — plan_create chạy luôn
      // không thẻ, nhưng test_write trong cùng run vẫn hỏi approval.
      setup.approvals.length = 0;
      const first = await setup.coordinator.run({ botId, text: 'lập lại plan theo yêu cầu sửa' });
      assert.equal(first.text, 'Đã lập lại plan và ghi xong.');
      assert.deepEqual(
        approvalNames(setup.approvals),
        ['test_write'],
        'dấu revision (qua plan_update) chỉ tự duyệt plan_create, test_write vẫn phải hỏi',
      );
      assert.deepEqual(setup.executions, ['after-changes']);
      assert.equal(planFileCount(), 2, 'plan_create đã chạy và ghi file plan mới');

      // Run 3: dấu revision chỉ dùng một lần — lại hỏi cả plan_create.
      setup.approvals.length = 0;
      const second = await setup.coordinator.run({ botId, text: 'lập lại lần nữa' });
      assert.equal(second.text, 'Đã lập lại lần 2 và ghi xong.');
      assert.deepEqual(approvalNames(setup.approvals), ['plan_create', 'test_write']);
      assert.deepEqual(setup.executions, ['after-changes', 'second-run']);
      assert.equal(planFileCount(), 3, 'plan_create ở run sau vẫn chạy (sau khi được duyệt)');
    } finally {
      await setup.destroy();
    }
    assert.equal(readApprovalState(dir, botId, projectId)?.status, 'changes-requested');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
