/**
 * planning.test.mjs — BotMemory goals/todos/projects/tasks+tags,
 * v0.1 -> v0.2 tags migration, PlanService, createPlanTools.
 * Run: node --test tests/planning.test.mjs (after building core + tools)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { PlanService } from '../packages/core/dist/agent/planning.js';
import { PLAN_TOOLS, createPlanTools } from '../packages/tools/dist/planTools.js';

const BOT = 'bot-test';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-planning-'));
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

const CTX = { workspaceDir: '', botId: BOT };

test('memory: goal/todo/project/task CRUD + tags', () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    // goals
    const goalId = mem.createGoal(BOT, 'Học tiếng Anh', 'B2 trong 6 tháng');
    let goal = mem.getGoal(goalId);
    assert.equal(goal.status, 'active');
    assert.equal(goal.detail, 'B2 trong 6 tháng');
    mem.updateGoal(goalId, { status: 'done' });
    goal = mem.getGoal(goalId);
    assert.equal(goal.status, 'done');
    assert.equal(mem.listGoals(BOT, 'done').length, 1);
    assert.equal(mem.listGoals(BOT, 'active').length, 0);
    mem.deleteGoal(goalId);
    assert.equal(mem.getGoal(goalId), null);

    // todos
    const todoId = mem.createTodo(BOT, 'Mua sữa');
    assert.equal(mem.getTodo(todoId).done, false);
    mem.updateTodo(todoId, { done: true });
    assert.equal(mem.getTodo(todoId).done, true);
    assert.equal(mem.listTodos(BOT, false).length, 0);
    assert.equal(mem.listTodos(BOT, true).length, 1);
    mem.deleteTodo(todoId);
    assert.equal(mem.getTodo(todoId), null);

    // projects + updates flag
    const projectId = mem.createProject(BOT, 'Dự án X', 'mô tả');
    assert.equal(mem.getProject(projectId).updatesEnabled, false);
    mem.setProjectUpdates(projectId, true);
    assert.equal(mem.getProject(projectId).updatesEnabled, true);
    mem.updateProject(projectId, { status: 'paused' });
    assert.equal(mem.listProjects(BOT, 'paused').length, 1);
    mem.deleteProject(projectId);
    assert.equal(mem.getProject(projectId), null);

    // tasks + tags
    const taskId = mem.createTask(BOT, 'Viết báo cáo', 'urgent,work');
    const task = mem.getTask(taskId);
    assert.equal(task.status, 'pending');
    assert.equal(task.tags, 'urgent,work');
    mem.updateTask(taskId, 'in_progress');
    assert.equal(mem.getTask(taskId).status, 'in_progress');
    mem.setTaskTags(taskId, 'done-soon');
    assert.equal(mem.getTask(taskId).tags, 'done-soon');
    assert.equal(mem.listTasks(BOT, { tag: 'done-soon' }).length, 1);
    assert.equal(mem.listTasks(BOT, { tag: 'nope' }).length, 0);
    assert.equal(mem.listTasks(BOT, { status: 'done' }).length, 0);
    mem.updateTaskFields(taskId, { title: 'Viết báo cáo v2', status: 'done' });
    assert.equal(mem.getTask(taskId).title, 'Viết báo cáo v2');
    mem.deleteTask(taskId);
    assert.equal(mem.getTask(taskId), null);
  } finally {
    mem.close();
  }
});

test('memory: migration không vỡ DB cũ (tasks chưa có cột tags)', () => {
  const dir = tmpDir();
  // Tạo DB theo schema v0.1: bảng tasks KHÔNG có cột tags.
  fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
  const dbPath = path.join(dir, '.open-bot', 'memory.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      botId TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  old.prepare(
    'INSERT INTO tasks (id, botId, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('old-1', BOT, 'Task cũ', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  old.close();

  // Mở lại bằng BotMemory mới: phải migrate được, dữ liệu cũ còn nguyên.
  const mem = new BotMemory(dir);
  try {
    const tasks = mem.listTasks(BOT);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'old-1');
    assert.equal(tasks[0].title, 'Task cũ');
    assert.equal(tasks[0].status, 'pending');
    assert.equal(tasks[0].tags, '');
    // Ghi mới trên DB đã migrate vẫn chạy.
    const id = mem.createTask(BOT, 'Task mới', 'x');
    assert.equal(mem.getTask(id).tags, 'x');
    // 3 bảng mới tồn tại.
    assert.deepEqual(mem.listGoals(BOT), []);
    assert.deepEqual(mem.listTodos(BOT), []);
    assert.deepEqual(mem.listProjects(BOT), []);
  } finally {
    mem.close();
  }
});

test('PlanService: createPlan / grindPlan / grindRun chỉ lập kế hoạch, không tự chạy', () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const svc = new PlanService(mem);
    const plan = svc.createPlan(BOT, 'Ra mắt web', 'MVP', ['Thiết kế', 'Code', 'Deploy']);
    assert.equal(plan.tasks.length, 3);
    assert.equal(plan.project.title, 'Ra mắt web');
    // Mỗi task đều gắn tag project:<id>.
    for (const t of plan.tasks) {
      assert.ok(t.tags.includes(`project:${plan.projectId}`), `task ${t.id} thiếu tag project`);
    }
    // grindRun trả về đúng thứ tự thực thi (cũ trước), KHÔNG đổi trạng thái.
    const run = svc.grindRun(plan.projectId);
    assert.equal(run.project.id, plan.projectId);
    assert.deepEqual(
      run.steps.map((s) => s.title),
      ['Thiết kế', 'Code', 'Deploy'],
    );
    assert.ok(run.steps.every((s) => s.status === 'pending'));
    // grindPlan: project dài hơi, cũng chỉ tạo dữ liệu.
    const grind = svc.grindPlan(BOT, 'Grind dài hơi', '', ['Bước 1', 'Bước 2']);
    assert.equal(grind.tasks.length, 2);
    assert.equal(svc.grindRun(grind.projectId).steps.length, 2);
    assert.throws(() => svc.grindRun('không-tồn-tại'), /Không thấy project/);
  } finally {
    mem.close();
  }
});

test('planTools: factory bound chạy đủ 16 tool chỉ định (+ todo_create); needsApproval đúng', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const tools = createPlanTools(mem);
    const names = tools.map((t) => t.definition.name);
    for (const n of [
      'plan_create', 'plan_update', 'task_create', 'task_update', 'task_delete',
      'task_list', 'task_set_status', 'task_set_tags', 'goal_create', 'goal_update',
      'goal_list', 'todo_list', 'todo_update', 'project_create', 'project_list',
      'project_set_updates',
    ]) {
      assert.ok(names.includes(n), `thiếu tool ${n}`);
    }
    // Reads: false; writes: true.
    for (const t of tools) {
      const isRead = ['task_list', 'goal_list', 'todo_list', 'project_list'].includes(t.definition.name);
      assert.equal(t.needsApproval, !isRead, `${t.definition.name} needsApproval sai`);
    }

    const ctx = { ...CTX, workspaceDir: dir };
    const plan = JSON.parse(
      await toolByName(tools, 'plan_create').execute(
        { title: 'Kế hoạch A', steps: ['B1', 'B2'] }, ctx,
      ),
    );
    assert.equal(plan.tasks.length, 2);
    const projectId = plan.projectId;

    const listed = JSON.parse(await toolByName(tools, 'task_list').execute({}, ctx));
    assert.equal(listed.length, 2);
    const taskId = listed[0].id;
    const updated = JSON.parse(
      await toolByName(tools, 'task_set_status').execute({ taskId, status: 'done' }, ctx),
    );
    assert.equal(updated.status, 'done');
    const tagged = JSON.parse(
      await toolByName(tools, 'task_set_tags').execute({ taskId, tags: 'x,y' }, ctx),
    );
    assert.equal(tagged.tags, 'x,y');
    const renamed = JSON.parse(
      await toolByName(tools, 'task_update').execute({ taskId, title: 'B1 mới' }, ctx),
    );
    assert.equal(renamed.title, 'B1 mới');
    const del = await toolByName(tools, 'task_delete').execute({ taskId }, ctx);
    assert.match(del, /Đã xoá task/);

    const goal = JSON.parse(
      await toolByName(tools, 'goal_create').execute({ title: 'G1' }, ctx),
    );
    assert.equal(goal.status, 'active');
    const goalUpd = JSON.parse(
      await toolByName(tools, 'goal_update').execute({ goalId: goal.id, status: 'done' }, ctx),
    );
    assert.equal(goalUpd.status, 'done');
    assert.equal(JSON.parse(await toolByName(tools, 'goal_list').execute({}, ctx)).length, 1);

    const todo = JSON.parse(
      await toolByName(tools, 'todo_create').execute({ title: 'T1' }, ctx),
    );
    const todoUpd = JSON.parse(
      await toolByName(tools, 'todo_update').execute({ todoId: todo.id, done: true }, ctx),
    );
    assert.equal(todoUpd.done, true);
    assert.equal(JSON.parse(await toolByName(tools, 'todo_list').execute({ done: true }, ctx)).length, 1);

    const proj = JSON.parse(
      await toolByName(tools, 'project_create').execute({ title: 'P1' }, ctx),
    );
    const projUpd = JSON.parse(
      await toolByName(tools, 'project_set_updates').execute({ projectId: proj.id, enabled: true }, ctx),
    );
    assert.equal(projUpd.updatesEnabled, true);
    // v0.94c: kênh gửi thật đã có — note mô tả digest 6 giờ + trả thời
    // điểm digest kế tiếp (không còn câu "chưa có kênh gửi thật").
    assert.match(projUpd.note, /mỗi 6 giờ/);
    assert.match(projUpd.note, /thông báo hệ thống/);
    assert.ok(projUpd.nextDigestAt, 'project_set_updates trả nextDigestAt');
    assert.equal(JSON.parse(await toolByName(tools, 'project_list').execute({}, ctx)).length, 2);
    const planUpd = JSON.parse(
      await toolByName(tools, 'plan_update').execute({ projectId, status: 'done' }, ctx),
    );
    assert.equal(planUpd.status, 'done');

    // Lỗi rõ khi status sai / id không tồn tại.
    const bad = await toolByName(tools, 'task_set_status').execute({ taskId: 'x', status: 'sai' }, ctx);
    assert.match(bad, /Invalid task status/);
  } finally {
    mem.close();
  }
});

test('planTools: PLAN_TOOLS chưa bound trả lỗi rõ thay vì crash', async () => {
  assert.ok(PLAN_TOOLS.length > 0);
  const ctx = { ...CTX, workspaceDir: tmpDir() };
  const out = await toolByName(PLAN_TOOLS, 'task_list').execute({}, ctx);
  assert.match(out, /chưa được khởi tạo với BotMemory/);
});

test('plan_update reviewDecision ghi trạng thái vào file plan (v0.18, W10b follow-up)', async () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    const tools = createPlanTools(mem);
    const ctx = { ...CTX, workspaceDir: dir };
    // plan_create ghi file với "chờ duyệt".
    const plan = JSON.parse(
      await toolByName(tools, 'plan_create').execute(
        { title: 'Kế hoạch B', steps: ['B1'] }, ctx,
      ),
    );
    const filePath = path.join(dir, '.open-bot', 'plans', `${plan.projectId}.md`);
    assert.ok(fs.existsSync(filePath), 'plan_create phải ghi file plan');
    assert.match(fs.readFileSync(filePath, 'utf8'), /Trạng thái duyệt: chờ duyệt/);

    // Duyệt qua plan_update -> file phải đổi thành "đã duyệt".
    const approved = JSON.parse(
      await toolByName(tools, 'plan_update').execute(
        { projectId: plan.projectId, reviewDecision: 'approve' }, ctx,
      ),
    );
    assert.equal(approved.approvalStatus, 'approved');
    assert.equal(approved.fileStatusUpdated, true);
    assert.match(fs.readFileSync(filePath, 'utf8'), /Trạng thái duyệt: đã duyệt/);

    // Helper trực tiếp: reject + request-changes + file không tồn tại.
    const { updatePlanFileStatus, readPlanFile } = await import(
      '../packages/core/dist/agent/planning.js'
    );
    assert.equal(updatePlanFileStatus(dir, plan.projectId, 'rejected'), true);
    assert.match(readPlanFile(dir, plan.projectId), /Trạng thái duyệt: đã từ chối/);
    assert.equal(updatePlanFileStatus(dir, plan.projectId, 'changes-requested'), true);
    assert.match(readPlanFile(dir, plan.projectId), /Trạng thái duyệt: yêu cầu sửa/);
    assert.equal(updatePlanFileStatus(dir, 'khong-co-plan', 'approved'), false);
    assert.equal(updatePlanFileStatus('', plan.projectId, 'approved'), false);
  } finally {
    mem.close();
  }
});
