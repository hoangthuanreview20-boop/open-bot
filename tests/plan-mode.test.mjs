/**
 * plan-mode.test.mjs — plan mode thật (v0.11, P0-3).
 *
 * - plan file: render/ghi/đọc Markdown (.open-bot/plans/<id>.md), chặn
 *   projectId không an toàn.
 * - plan_create nộp plan: PlanService lưu plan + ghi file + trạng thái
 *   chờ duyệt (coordination.ts).
 * - plan_update reviewDecision: approve -> mode chat, reject -> mode vẫn
 *   plan, request-changes -> ghi note + mode vẫn plan; duyệt lại thì lỗi.
 *
 * Run: npm run build --workspace=@open-bot/core (cả tools) rồi
 *      node --test tests/plan-mode.test.mjs (dưới xvfb-run khi chạy full)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import {
  PLAN_FILE_DIR,
  planFileRelativePath,
  readPlanFile,
  renderPlanMarkdown,
  writePlanFile,
} from '../packages/core/dist/agent/planning.js';
import {
  getBotMode,
  getPlanApproval,
  listPendingPlans,
  reviewPlan,
  submitPlanForReview,
} from '../packages/core/dist/agent/coordination.js';
import { createPlanTools } from '../packages/tools/dist/planTools.js';

const BOT = 'bot-plan-mode';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plan-mode-'));
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

function memIn(dir) {
  return new BotMemory(dir);
}

test('plan file: render Markdown có đủ tiêu đề + bước + lựa chọn cần quyết', () => {
  const md = renderPlanMarkdown({
    projectId: 'abc-123',
    title: 'Làm web bán hàng',
    detail: 'Next.js + Stripe.',
    steps: ['Dựng khung', 'Thêm giỏ hàng', 'Deploy'],
    decisions: ['Dùng Stripe hay MoMo?', 'Tên miền nào?'],
  });
  assert.match(md, /# Kế hoạch: Làm web bán hàng/);
  assert.match(md, /Project: `abc-123`/);
  assert.match(md, /Next\.js \+ Stripe/);
  assert.match(md, /1\. Dựng khung/);
  assert.match(md, /3\. Deploy/);
  assert.match(md, /Dùng Stripe hay MoMo\?/);
  assert.match(md, /Tên miền nào\?/);

  const empty = renderPlanMarkdown({ projectId: 'x', title: 'T', steps: [], decisions: [] });
  assert.match(empty, /Chưa có bước nào/);
  assert.match(empty, /Không có lựa chọn nào cần quyết/);
});

test('plan file: write/read + chặn projectId không an toàn', () => {
  const dir = tmpDir();
  try {
    assert.equal(planFileRelativePath('abc-123'), `${PLAN_FILE_DIR}/abc-123.md`);
    assert.throws(() => planFileRelativePath('../evil'), /không hợp lệ/);
    assert.throws(() => planFileRelativePath('a/b'), /không hợp lệ/);
    assert.throws(() => planFileRelativePath(''), /không hợp lệ/);

    const abs = writePlanFile(dir, {
      projectId: 'abc-123',
      title: 'Kế hoạch A',
      steps: ['B1', 'B2'],
      decisions: ['Chọn X hay Y?'],
    });
    assert.equal(abs, path.resolve(dir, PLAN_FILE_DIR, 'abc-123.md'));
    assert.ok(fs.existsSync(abs));
    const back = readPlanFile(dir, 'abc-123');
    assert.match(back, /Kế hoạch A/);
    assert.match(back, /1\. B1/);
    assert.match(back, /Chọn X hay Y\?/);
    assert.equal(readPlanFile(dir, 'khong-co'), null);
    assert.equal(readPlanFile('', 'abc-123'), null);
    assert.throws(() => writePlanFile('', { projectId: 'a', title: 'T', steps: [] }), /workspaceDir/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination: submit/get/list/review plan — trạng thái + pending index', () => {
  const dir = tmpDir();
  const mem = memIn(dir);
  try {
    assert.equal(getBotMode(mem, BOT), 'chat');
    mem.setMemory(BOT, 'agent:mode', 'plan');
    assert.equal(getBotMode(mem, BOT), 'plan');

    const state = submitPlanForReview(mem, BOT, {
      projectId: 'p1',
      title: 'Plan 1',
      filePath: '.open-bot/plans/p1.md',
      steps: ['B1', 'B2'],
      decisions: ['D1'],
    });
    assert.equal(state.status, 'pending');
    assert.deepEqual(listPendingPlans(mem, BOT).map((s) => s.projectId), ['p1']);
    assert.equal(getPlanApproval(mem, BOT, 'p1').title, 'Plan 1');
    assert.equal(getPlanApproval(mem, BOT, 'khong-co'), null);

    // Re-submit cùng projectId: reset về pending, index không trùng.
    submitPlanForReview(mem, BOT, { projectId: 'p1', title: 'Plan 1 sửa', steps: ['B1'] });
    assert.equal(getPlanApproval(mem, BOT, 'p1').title, 'Plan 1 sửa');
    assert.equal(listPendingPlans(mem, BOT).length, 1);

    // Approve: hết pending + mode sang chat.
    const approved = reviewPlan(mem, BOT, 'p1', 'approve');
    assert.equal(approved.state.status, 'approved');
    assert.equal(approved.mode, 'chat');
    assert.equal(getBotMode(mem, BOT), 'chat');
    assert.equal(listPendingPlans(mem, BOT).length, 0);
    assert.throws(() => reviewPlan(mem, BOT, 'p1', 'approve'), /đã có quyết định/);
    assert.throws(() => reviewPlan(mem, BOT, 'khong-co', 'approve'), /Không thấy plan/);
  } finally {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination: reject + request-changes giữ mode plan, ghi note', () => {
  const dir = tmpDir();
  const mem = memIn(dir);
  try {
    mem.setMemory(BOT, 'agent:mode', 'plan');
    submitPlanForReview(mem, BOT, { projectId: 'p2', title: 'Plan 2', steps: ['B1'] });
    const rejected = reviewPlan(mem, BOT, 'p2', 'reject');
    assert.equal(rejected.state.status, 'rejected');
    assert.equal(rejected.mode, 'plan');
    assert.equal(getBotMode(mem, BOT), 'plan');

    submitPlanForReview(mem, BOT, { projectId: 'p3', title: 'Plan 3', steps: ['B1'] });
    const changed = reviewPlan(mem, BOT, 'p3', 'request-changes', 'Bỏ bước B1, thêm bước test.');
    assert.equal(changed.state.status, 'changes-requested');
    assert.equal(changed.state.note, 'Bỏ bước B1, thêm bước test.');
    assert.equal(changed.mode, 'plan');
    assert.equal(listPendingPlans(mem, BOT).length, 0);
  } finally {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan_create: nộp plan ghi file + chờ duyệt; plan_update reviewDecision chuyển mode đúng', async () => {
  const dir = tmpDir();
  const mem = memIn(dir);
  try {
    const tools = createPlanTools(mem);
    const ctx = { workspaceDir: dir, botId: BOT };
    mem.setMemory(BOT, 'agent:mode', 'plan');

    const out = JSON.parse(
      await toolByName(tools, 'plan_create').execute(
        {
          title: 'Kế hoạch A',
          detail: 'Mô tả A',
          steps: ['B1', 'B2'],
          decisions: ['Chọn X hay Y?'],
        },
        ctx,
      ),
    );
    assert.equal(out.tasks.length, 2);
    assert.equal(out.status, 'pending');
    assert.deepEqual(out.decisions, ['Chọn X hay Y?']);
    assert.deepEqual(out.steps, ['B1', 'B2']);
    assert.ok(out.filePath);
    assert.ok(fs.existsSync(out.filePath));
    assert.match(fs.readFileSync(out.filePath, 'utf8'), /Kế hoạch A/);
    assert.match(fs.readFileSync(out.filePath, 'utf8'), /Chọn X hay Y\?/);
    assert.equal(getPlanApproval(mem, BOT, out.projectId).status, 'pending');
    assert.equal(listPendingPlans(mem, BOT).length, 1);

    // Duyệt: mode sang chat.
    const approved = JSON.parse(
      await toolByName(tools, 'plan_update').execute(
        { projectId: out.projectId, reviewDecision: 'approve' },
        ctx,
      ),
    );
    assert.equal(approved.approvalStatus, 'approved');
    assert.equal(approved.mode, 'chat');
    assert.equal(mem.getMemory(BOT, 'agent:mode'), 'chat');
    assert.equal(listPendingPlans(mem, BOT).length, 0);
    // Duyệt lại -> lỗi rõ (tool trả Error, không throw).
    const again = await toolByName(tools, 'plan_update').execute(
      { projectId: out.projectId, reviewDecision: 'approve' },
      ctx,
    );
    assert.match(again, /đã có quyết định/);

    // Từ chối: mode vẫn plan.
    const out2 = JSON.parse(
      await toolByName(tools, 'plan_create').execute({ title: 'Kế hoạch B', steps: ['B1'] }, ctx),
    );
    mem.setMemory(BOT, 'agent:mode', 'plan');
    const rejected = JSON.parse(
      await toolByName(tools, 'plan_update').execute(
        { projectId: out2.projectId, reviewDecision: 'reject' },
        ctx,
      ),
    );
    assert.equal(rejected.approvalStatus, 'rejected');
    assert.equal(rejected.mode, 'plan');
    assert.equal(mem.getMemory(BOT, 'agent:mode'), 'plan');

    // Yêu cầu sửa: ghi note, mode vẫn plan.
    const out3 = JSON.parse(
      await toolByName(tools, 'plan_create').execute({ title: 'Kế hoạch C', steps: ['B1'] }, ctx),
    );
    const changed = JSON.parse(
      await toolByName(tools, 'plan_update').execute(
        { projectId: out3.projectId, reviewDecision: 'request-changes', note: 'Thêm bước test.' },
        ctx,
      ),
    );
    assert.equal(changed.approvalStatus, 'changes-requested');
    assert.equal(changed.note, 'Thêm bước test.');
    assert.equal(getPlanApproval(mem, BOT, out3.projectId).note, 'Thêm bước test.');

    // reviewDecision sai / plan chưa nộp -> lỗi rõ.
    const bad = await toolByName(tools, 'plan_update').execute(
      { projectId: out3.projectId, reviewDecision: 'maybe' },
      ctx,
    );
    assert.match(bad, /không hợp lệ/);
    const missing = await toolByName(tools, 'plan_update').execute(
      { projectId: 'khong-co', reviewDecision: 'approve' },
      ctx,
    );
    assert.match(missing, /Không thấy plan/);

    // plan_update không reviewDecision vẫn giữ hành vi cũ.
    const plain = JSON.parse(
      await toolByName(tools, 'plan_update').execute({ projectId: out3.projectId, status: 'done' }, ctx),
    );
    assert.equal(plain.status, 'done');
  } finally {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan_create: không decisions + workspaceDir rỗng vẫn nộp được (filePath null)', async () => {
  const dir = tmpDir();
  const mem = memIn(dir);
  try {
    const tools = createPlanTools(mem);
    const out = JSON.parse(
      await toolByName(tools, 'plan_create').execute(
        { title: 'Kế hoạch D', steps: ['B1'] },
        { workspaceDir: '', botId: BOT },
      ),
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.filePath, null);
    assert.match(out.fileError, /workspaceDir rỗng/);
    assert.deepEqual(out.decisions, []);
    assert.equal(getPlanApproval(mem, BOT, out.projectId).status, 'pending');
  } finally {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
