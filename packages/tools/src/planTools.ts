/**
 * Plan / goal / todo / project tools for @open-bot/tools (v0.2).
 *
 * All data tools go through a PlanService built over a BotMemory instance
 * supplied to the factory — this file imports PlanService and the data
 * types from the @open-bot/core public surface. There is no runtime import
 * of BotMemory itself.
 *
 * Factory:
 *   createPlanTools(memory) -> Tool[]   (bound, usable)
 *   PLAN_TOOLS                          (unbound placeholder: execute()
 *                                        returns a clear error telling the
 *                                        host to use createPlanTools(memory))
 *
 * Approval: every tool that writes data has needsApproval: true;
 * read-only tools (task_list, goal_list, todo_list, project_list) are false.
 *
 * v0.11 (P0-3) — plan mode thật: plan_create nộp plan để duyệt (ghi file
 * Markdown .open-bot/plans/<id>.md + đánh dấu chờ duyệt qua
 * coordination.ts); plan_update { reviewDecision } áp dụng quyết định
 * duyệt/từ chối/yêu cầu sửa của người dùng (approve chuyển mode sang
 * chat). needsApproval giữ nguyên true cho cả hai (test planning.test.mjs
 * assert như vậy): thẻ phê duyệt tool-call là cửa kiểm soát việc ghi
 * file / đổi mode, còn màn hình Kế hoạch là nơi duyệt nội dung plan.
 */
import type {
  BotMemory,
  GoalStatus,
  ProjectStatus,
  TaskStatus,
  Tool,
  ToolContext,
} from '@open-bot/core';
import { PlanService, nextProjectDigestAt } from '@open-bot/core';
// v0.11 (P0-3): plan file + approval state live in core, imported by deep
// path like the other tools files do (@open-bot/core/dist/agent/...).
import { planFileRelativePath, updatePlanFileStatus, writePlanFile } from '@open-bot/core/dist/agent/planning';
import {
  isPlanReviewDecision,
  reviewPlan,
  submitPlanForReview,
} from '@open-bot/core/dist/agent/coordination';

const TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];
const GOAL_STATUSES: GoalStatus[] = ['active', 'paused', 'done', 'cancelled'];
const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'cancelled'];

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, required = true): boolean {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return value as string[];
}

function asTaskStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as string[]).includes(value)) return value as TaskStatus;
  throw new Error(
    `Invalid task status "${value}" (expected one of: ${TASK_STATUSES.join(', ')})`,
  );
}

function asGoalStatus(value: string): GoalStatus {
  if ((GOAL_STATUSES as string[]).includes(value)) return value as GoalStatus;
  throw new Error(
    `Invalid goal status "${value}" (expected one of: ${GOAL_STATUSES.join(', ')})`,
  );
}

function asProjectStatus(value: string): ProjectStatus {
  if ((PROJECT_STATUSES as string[]).includes(value)) return value as ProjectStatus;
  throw new Error(
    `Invalid project status "${value}" (expected one of: ${PROJECT_STATUSES.join(', ')})`,
  );
}

const UNBOUND_ERROR =
  'plan tools chưa được khởi tạo với BotMemory — host phải dùng createPlanTools(memory) thay vì PLAN_TOOLS.';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export function createPlanTools(memory?: BotMemory): Tool[] {
  const service = memory ? new PlanService(memory) : null;
  const needService = (): PlanService => {
    if (!service) throw new Error(UNBOUND_ERROR);
    return service;
  };

  const planCreate: Tool = {
    definition: toolDef(
      'plan_create',
      'Nộp một kế hoạch để người dùng duyệt (plan mode): tạo một project kèm các task theo từng bước (steps), ghi plan ra file Markdown (.open-bot/plans/<projectId>.md trong workspace) và đánh dấu plan đang "chờ duyệt". Mỗi step thành một task, gắn tag "project:<projectId>". "decisions" là các lựa chọn còn mở cần người dùng quyết trước khi thực thi (có thể rỗng). Sau khi nộp thì DỪNG và chờ người dùng duyệt ở màn hình Kế hoạch — KHÔNG tự thực thi. Chỉ khi người dùng duyệt (qua plan_update reviewDecision "approve", mode chuyển sang chat) mới thực thi các bước.',
      {
        title: { type: 'string', description: 'Tên kế hoạch / project.' },
        detail: { type: 'string', description: 'Mô tả chi tiết (không bắt buộc).' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Danh sách các bước, mỗi bước thành một task.',
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Các lựa chọn còn mở cần người dùng quyết trước khi thực thi (không bắt buộc).',
        },
      },
      ['title'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        // needService() đã throw khi memory undefined; dòng này chỉ để
        // TypeScript thu hẹp kiểu cho submitPlanForReview bên dưới.
        if (!memory) throw new Error(UNBOUND_ERROR);
        const title = getStringArg(args, 'title');
        const detail = getOptionalStringArg(args, 'detail') ?? '';
        const steps = getStringArrayArg(args, 'steps');
        const decisions = getStringArrayArg(args, 'decisions');
        const plan = svc.createPlan(ctx.botId, title, detail, steps);
        // v0.11: ghi file Markdown + đánh dấu chờ duyệt. Ghi file lỗi
        // (vd workspaceDir rỗng) thì plan trong memory vẫn nộp được —
        // filePath null + fileError nói rõ, không mất plan.
        let filePath: string | null = null;
        let fileRel: string | null = null;
        let fileError: string | undefined;
        const workspaceDir = (ctx.workspaceDir ?? '').trim();
        if (workspaceDir) {
          try {
            filePath = writePlanFile(workspaceDir, {
              projectId: plan.projectId,
              title,
              detail,
              steps,
              decisions,
            });
            fileRel = planFileRelativePath(plan.projectId);
          } catch (err) {
            fileError = err instanceof Error ? err.message : String(err);
          }
        } else {
          fileError = 'workspaceDir rỗng — chưa ghi file plan.';
        }
        const approval = submitPlanForReview(memory, ctx.botId, {
          projectId: plan.projectId,
          title,
          filePath: fileRel ?? '',
          steps,
          decisions,
        });
        return JSON.stringify(
          {
            ...plan,
            title,
            detail,
            steps,
            decisions,
            filePath,
            fileRel,
            ...(fileError ? { fileError } : {}),
            status: approval.status,
            note: 'Plan đang chờ duyệt — người dùng duyệt ở màn hình Kế hoạch rồi agent mới thực thi.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const planUpdate: Tool = {
    definition: toolDef(
      'plan_update',
      'Cập nhật một kế hoạch (project): đổi tên, mô tả hoặc trạng thái (active/paused/done/cancelled). Chỉ đổi các field được truyền. DUYỆT PLAN (v0.11): khi người dùng trả lời về một plan đang chờ duyệt, truyền thêm reviewDecision — "approve" (duyệt: plan được duyệt, mode chuyển sang chat để thực thi), "reject" (từ chối: không thực thi, mode vẫn là plan), "request-changes" (yêu cầu sửa: kèm "note" ghi yêu cầu của người dùng, rồi lập lại plan mới). reviewDecision chỉ dùng được cho plan đang ở trạng thái chờ duyệt.',
      {
        projectId: { type: 'string', description: 'Id của project (kế hoạch).' },
        title: { type: 'string', description: 'Tên mới (không bắt buộc).' },
        detail: { type: 'string', description: 'Mô tả mới (không bắt buộc).' },
        status: { type: 'string', description: 'Trạng thái mới: active, paused, done, cancelled.' },
        reviewDecision: {
          type: 'string',
          description: 'Quyết định duyệt plan: approve, reject, request-changes (không bắt buộc).',
        },
        note: {
          type: 'string',
          description: 'Ghi chú kèm quyết định duyệt (vd yêu cầu sửa của người dùng).',
        },
      },
      ['projectId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'projectId');
        const reviewRaw = getOptionalStringArg(args, 'reviewDecision');
        // v0.11: luồng duyệt plan — áp dụng quyết định của người dùng.
        if (reviewRaw !== undefined) {
          if (!memory) throw new Error(UNBOUND_ERROR);
          if (!isPlanReviewDecision(reviewRaw)) {
            return errorResult(
              `reviewDecision không hợp lệ: "${reviewRaw}" (chỉ nhận: approve, reject, request-changes).`,
            );
          }
          const note = getOptionalStringArg(args, 'note') ?? '';
          const title = getOptionalStringArg(args, 'title');
          const detail = getOptionalStringArg(args, 'detail');
          if (title !== undefined || detail !== undefined) {
            svc.updateProject(id, { title, detail });
          }
          const { state, mode } = reviewPlan(memory, ctx.botId, id, reviewRaw, note);
          // v0.18 (W10b follow-up): ghi quyết định vào file plan để
          // màn hình Kế hoạch không hiện lại plan đã duyệt thành "chờ
          // duyệt" ở phiên sau. Ghi file là best-effort: không ghi được
          // (vd không có file) thì lượt duyệt vẫn thành công.
          let fileStatusUpdated = false;
          try {
            const workspaceDir = (ctx.workspaceDir ?? '').trim();
            // Sau reviewPlan, status không còn 'pending' (reviewPlan
            // luôn đặt approved/rejected/changes-requested) — thu hẹp
            // kiểu để gọi updatePlanFileStatus.
            if (workspaceDir && state.status !== 'pending') {
              fileStatusUpdated = updatePlanFileStatus(workspaceDir, id, state.status);
            }
          } catch {
            fileStatusUpdated = false;
          }
          return JSON.stringify(
            {
              projectId: id,
              title: state.title,
              approvalStatus: state.status,
              mode,
              note: state.note,
              filePath: state.filePath,
              fileStatusUpdated,
              message:
                state.status === 'approved'
                  ? 'Plan đã được duyệt, mode đã chuyển sang chat — thực thi các bước từ lượt chạy sau.'
                  : state.status === 'rejected'
                    ? 'Plan đã bị từ chối — không thực thi bước nào, mode vẫn là plan.'
                    : 'Đã ghi yêu cầu sửa — lập lại plan mới theo yêu cầu rồi nộp lại để duyệt.',
            },
            null,
            2,
          );
        }
        const statusRaw = getOptionalStringArg(args, 'status');
        svc.updateProject(id, {
          title: getOptionalStringArg(args, 'title'),
          detail: getOptionalStringArg(args, 'detail'),
          status: statusRaw === undefined ? undefined : asProjectStatus(statusRaw),
        });
        const project = svc.getProject(id);
        return project ? JSON.stringify(project, null, 2) : errorResult(`Không thấy project: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskCreate: Tool = {
    definition: toolDef(
      'task_create',
      'Tạo một task mới (trạng thái pending). Tags là chuỗi tự do, phân tách bằng dấu phẩy.',
      {
        title: { type: 'string', description: 'Tiêu đề task.' },
        tags: { type: 'string', description: 'Tags, ví dụ "urgent,project:abc" (không bắt buộc).' },
      },
      ['title'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const id = svc.createTask(
          ctx.botId,
          getStringArg(args, 'title'),
          getOptionalStringArg(args, 'tags') ?? '',
        );
        const task = svc.getTask(id);
        return task ? JSON.stringify(task, null, 2) : errorResult(`Không tạo được task.`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskUpdate: Tool = {
    definition: toolDef(
      'task_update',
      'Cập nhật một task: đổi tiêu đề, trạng thái (pending/in_progress/done/cancelled) hoặc tags. Chỉ đổi các field được truyền.',
      {
        taskId: { type: 'string', description: 'Id của task.' },
        title: { type: 'string', description: 'Tiêu đề mới (không bắt buộc).' },
        status: { type: 'string', description: 'Trạng thái mới: pending, in_progress, done, cancelled.' },
        tags: { type: 'string', description: 'Tags mới (không bắt buộc).' },
      },
      ['taskId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'taskId');
        const statusRaw = getOptionalStringArg(args, 'status');
        svc.updateTaskFields(id, {
          title: getOptionalStringArg(args, 'title'),
          status: statusRaw === undefined ? undefined : asTaskStatus(statusRaw),
          tags: getOptionalStringArg(args, 'tags'),
        });
        const task = svc.getTask(id);
        return task ? JSON.stringify(task, null, 2) : errorResult(`Không thấy task: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskDelete: Tool = {
    definition: toolDef(
      'task_delete',
      'Xoá một task theo id.',
      { taskId: { type: 'string', description: 'Id của task cần xoá.' } },
      ['taskId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'taskId');
        if (!svc.getTask(id)) return errorResult(`Không thấy task: "${id}"`);
        svc.deleteTask(id);
        return `Đã xoá task "${id}".`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskList: Tool = {
    definition: toolDef(
      'task_list',
      'Liệt kê task của bot (mới nhất trước). Lọc theo trạng thái và/hoặc tag nếu cần.',
      {
        status: { type: 'string', description: 'Lọc theo trạng thái: pending, in_progress, done, cancelled.' },
        tag: { type: 'string', description: 'Lọc theo tag (khớp chuỗi con, ví dụ "project:<id>").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const statusRaw = getOptionalStringArg(args, 'status');
        const tasks = svc.listTasks(ctx.botId, {
          status: statusRaw === undefined ? undefined : asTaskStatus(statusRaw),
          tag: getOptionalStringArg(args, 'tag'),
        });
        return JSON.stringify(tasks, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskSetStatus: Tool = {
    definition: toolDef(
      'task_set_status',
      'Đổi trạng thái của một task (pending/in_progress/done/cancelled).',
      {
        taskId: { type: 'string', description: 'Id của task.' },
        status: { type: 'string', description: 'Trạng thái mới.' },
      },
      ['taskId', 'status'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'taskId');
        svc.updateTaskFields(id, { status: asTaskStatus(getStringArg(args, 'status')) });
        const task = svc.getTask(id);
        return task ? JSON.stringify(task, null, 2) : errorResult(`Không thấy task: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const taskSetTags: Tool = {
    definition: toolDef(
      'task_set_tags',
      'Đặt lại tags của một task (chuỗi tự do, phân tách bằng dấu phẩy).',
      {
        taskId: { type: 'string', description: 'Id của task.' },
        tags: { type: 'string', description: 'Tags mới, ví dụ "urgent,project:abc".' },
      },
      ['taskId', 'tags'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'taskId');
        svc.setTaskTags(id, getStringArg(args, 'tags'));
        const task = svc.getTask(id);
        return task ? JSON.stringify(task, null, 2) : errorResult(`Không thấy task: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const goalCreate: Tool = {
    definition: toolDef(
      'goal_create',
      'Tạo một mục tiêu (goal) mới, trạng thái active.',
      {
        title: { type: 'string', description: 'Tên mục tiêu.' },
        detail: { type: 'string', description: 'Mô tả chi tiết (không bắt buộc).' },
      },
      ['title'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const id = svc.createGoal(
          ctx.botId,
          getStringArg(args, 'title'),
          getOptionalStringArg(args, 'detail') ?? '',
        );
        const goal = svc.getGoal(id);
        return goal ? JSON.stringify(goal, null, 2) : errorResult('Không tạo được goal.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const goalUpdate: Tool = {
    definition: toolDef(
      'goal_update',
      'Cập nhật một goal: đổi tên, mô tả hoặc trạng thái (active/paused/done/cancelled). Chỉ đổi các field được truyền.',
      {
        goalId: { type: 'string', description: 'Id của goal.' },
        title: { type: 'string', description: 'Tên mới (không bắt buộc).' },
        detail: { type: 'string', description: 'Mô tả mới (không bắt buộc).' },
        status: { type: 'string', description: 'Trạng thái mới: active, paused, done, cancelled.' },
      },
      ['goalId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'goalId');
        const statusRaw = getOptionalStringArg(args, 'status');
        svc.updateGoal(id, {
          title: getOptionalStringArg(args, 'title'),
          detail: getOptionalStringArg(args, 'detail'),
          status: statusRaw === undefined ? undefined : asGoalStatus(statusRaw),
        });
        const goal = svc.getGoal(id);
        return goal ? JSON.stringify(goal, null, 2) : errorResult(`Không thấy goal: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const goalList: Tool = {
    definition: toolDef(
      'goal_list',
      'Liệt kê goal của bot (mới nhất trước). Lọc theo trạng thái nếu cần.',
      {
        status: { type: 'string', description: 'Lọc theo trạng thái: active, paused, done, cancelled.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const statusRaw = getOptionalStringArg(args, 'status');
        const goals = svc.listGoals(
          ctx.botId,
          statusRaw === undefined ? undefined : asGoalStatus(statusRaw),
        );
        return JSON.stringify(goals, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const todoCreate: Tool = {
    definition: toolDef(
      'todo_create',
      'Tạo một todo mới (chưa xong).',
      { title: { type: 'string', description: 'Nội dung todo.' } },
      ['title'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const id = svc.createTodo(ctx.botId, getStringArg(args, 'title'));
        const todo = svc.getTodo(id);
        return todo ? JSON.stringify(todo, null, 2) : errorResult('Không tạo được todo.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const todoList: Tool = {
    definition: toolDef(
      'todo_list',
      'Liệt kê todo của bot (mới nhất trước). Lọc theo đã xong / chưa xong nếu cần.',
      {
        done: { type: 'boolean', description: 'true = chỉ todo đã xong, false = chỉ todo chưa xong.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const doneRaw = args['done'];
        const done =
          doneRaw === undefined || doneRaw === null
            ? undefined
            : getBoolArg(args, 'done', false);
        const todos = svc.listTodos(ctx.botId, done);
        return JSON.stringify(todos, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const todoUpdate: Tool = {
    definition: toolDef(
      'todo_update',
      'Cập nhật một todo: đổi nội dung và/hoặc đánh dấu đã xong (done: true/false). Chỉ đổi các field được truyền.',
      {
        todoId: { type: 'string', description: 'Id của todo.' },
        title: { type: 'string', description: 'Nội dung mới (không bắt buộc).' },
        done: { type: 'boolean', description: 'true = đã xong, false = chưa xong.' },
      },
      ['todoId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'todoId');
        const doneRaw = args['done'];
        svc.updateTodo(id, {
          title: getOptionalStringArg(args, 'title'),
          done:
            doneRaw === undefined || doneRaw === null
              ? undefined
              : getBoolArg(args, 'done', false),
        });
        const todo = svc.getTodo(id);
        return todo ? JSON.stringify(todo, null, 2) : errorResult(`Không thấy todo: "${id}"`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const projectCreate: Tool = {
    definition: toolDef(
      'project_create',
      'Tạo một project mới, trạng thái active.',
      {
        title: { type: 'string', description: 'Tên project.' },
        detail: { type: 'string', description: 'Mô tả chi tiết (không bắt buộc).' },
      },
      ['title'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const id = svc.createProject(
          ctx.botId,
          getStringArg(args, 'title'),
          getOptionalStringArg(args, 'detail') ?? '',
        );
        const project = svc.getProject(id);
        return project ? JSON.stringify(project, null, 2) : errorResult('Không tạo được project.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const projectList: Tool = {
    definition: toolDef(
      'project_list',
      'Liệt kê project của bot (mới nhất trước). Lọc theo trạng thái nếu cần.',
      {
        status: { type: 'string', description: 'Lọc theo trạng thái: active, paused, done, cancelled.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const svc = needService();
        const statusRaw = getOptionalStringArg(args, 'status');
        const projects = svc.listProjects(
          ctx.botId,
          statusRaw === undefined ? undefined : asProjectStatus(statusRaw),
        );
        return JSON.stringify(projects, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const projectSetUpdates: Tool = {
    definition: toolDef(
      'project_set_updates',
      'Bật/tắt cập nhật định kỳ cho một project. Khi bật, app gửi digest tiến độ (số task theo trạng thái, task mới xong, task còn mở) mỗi 6 giờ qua thông báo hệ thống + tin nhắn trong chat của bot; khi tắt thì dừng. Trả về nextDigestAt = thời điểm digest kế tiếp tới hạn.',
      {
        projectId: { type: 'string', description: 'Id của project.' },
        enabled: { type: 'boolean', description: 'true = bật cập nhật định kỳ, false = tắt.' },
      },
      ['projectId', 'enabled'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const svc = needService();
        const id = getStringArg(args, 'projectId');
        const enabled = getBoolArg(args, 'enabled');
        svc.updateProject(id, { updatesEnabled: enabled });
        const project = svc.getProject(id);
        if (!project) return errorResult(`Không thấy project: "${id}"`);
        return JSON.stringify(
          {
            ...project,
            nextDigestAt: nextProjectDigestAt(project),
            note: enabled
              ? 'Đã bật cập nhật định kỳ: digest tiến độ được gửi mỗi 6 giờ qua thông báo hệ thống + tin nhắn trong chat của bot.'
              : 'Đã tắt cập nhật định kỳ: không gửi digest nữa.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    planCreate,
    planUpdate,
    taskCreate,
    taskUpdate,
    taskDelete,
    taskList,
    taskSetStatus,
    taskSetTags,
    goalCreate,
    goalUpdate,
    goalList,
    todoCreate,
    todoList,
    todoUpdate,
    projectCreate,
    projectList,
    projectSetUpdates,
  ];
}

/**
 * Unbound placeholder: same tool shapes, but no BotMemory attached, so
 * every execute() returns a clear error. Real usage:
 *   const tools = createPlanTools(memory);
 */
export const PLAN_TOOLS: Tool[] = createPlanTools();

export type { ToolContext };
