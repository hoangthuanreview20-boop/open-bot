/**
 * Nested subagent + fan-out tools for @open-bot/tools (v1.01, Team T6).
 *
 *  - list_subagent_tree: đọc cây nested subagent của run này qua
 *    `ctx.subagentTree` (depth, trạng thái, token, budget) — nối bởi
 *    AgentRunner; ngoài runner thì báo rõ là chưa hỗ trợ.
 *  - fanout_tasks: chia việc cho nhiều subagent chạy song song + chấm
 *    theo rubric qua `ctx.runFanOutWithGrading`; grader mặc định là
 *    keyword grader dựng từ `keywords` kèm trong từng tiêu chí của
 *    rubric (hoặc `keywordRules` truyền riêng).
 *
 * Factory:
 *   createNestedSubagentTools() -> Tool[]   (bound, usable)
 *   NESTED_SUBAGENT_TOOLS                  (unbound placeholder)
 *
 * Approval: list_subagent_tree chỉ đọc -> false; fanout_tasks spawn
 * nhiều subagent + tốn token -> true.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import {
  createKeywordGrader,
  validateRubric,
  type FanOutTaskInput,
  type KeywordRule,
  type Rubric,
  type SubagentTreeSnapshotNode,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

/** Model có thể truyền object trực tiếp hoặc chuỗi JSON — cả hai đều chấp nhận. */
function parseJsonArg(
  args: Record<string, unknown>,
  name: string,
  required = true,
): unknown {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Argument "${name}" không phải JSON hợp lệ.`);
    }
  }
  return value;
}

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

/** Vẽ cây subagent thành text có thụt lề theo depth (để model/user đọc). */
export function formatSubagentTree(node: SubagentTreeSnapshotNode): string {
  const lines: string[] = [];
  const walk = (n: SubagentTreeSnapshotNode): void => {
    const indent = '  '.repeat(n.depth);
    const status =
      n.status === 'done'
        ? 'xong'
        : n.status === 'running'
          ? 'đang chạy'
          : n.status === 'timeout'
            ? 'hết giờ'
            : n.status === 'stopped'
              ? 'đã dừng'
              : 'lỗi';
    const budget = n.overBudget ? ' ⚠️ vượt context budget' : '';
    const model = n.model ? ` · model ${n.model}` : '';
    const task = n.task ? ` — ${n.task.split('\n')[0]?.slice(0, 80) ?? ''}` : '';
    lines.push(
      `${indent}- ${n.name} [${status}] depth ${n.depth}, ${n.tokensUsed} token, ${n.spawnsUsed} con${model}${budget}${task}`,
    );
    if (n.error) lines.push(`${indent}  Lỗi: ${n.error}`);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return lines.join('\n');
}

interface FanOutTaskJson {
  name?: unknown;
  task?: unknown;
  instructions?: unknown;
  tools?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  maxSteps?: unknown;
  role?: unknown;
}

function parseFanOutTasks(raw: unknown): FanOutTaskInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('fanout_tasks cần "tasks" là mảng không rỗng, mỗi phần tử { name, task, ... }.');
  }
  return raw.map((entry, i) => {
    const item = entry as FanOutTaskJson;
    if (!item || typeof item !== 'object') {
      throw new Error(`fanout_tasks: task #${i + 1} phải là object { name, task }.`);
    }
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    if (!name) throw new Error(`fanout_tasks: task #${i + 1} cần "name" không rỗng.`);
    const task = typeof item.task === 'string' && item.task.trim() ? item.task.trim() : '';
    if (!task) throw new Error(`fanout_tasks: task "${name}" cần "task" không rỗng.`);
    const spec: FanOutTaskInput['spec'] = {};
    if (typeof item.instructions === 'string' && item.instructions.trim()) {
      spec.instructions = item.instructions;
    }
    if (Array.isArray(item.tools) && item.tools.every((t) => typeof t === 'string')) {
      spec.tools = [...(item.tools as string[])];
    }
    if (typeof item.model === 'string' && item.model.trim()) spec.model = item.model;
    if (typeof item.timeoutMs === 'number' && Number.isFinite(item.timeoutMs)) {
      spec.timeoutMs = item.timeoutMs;
    }
    if (typeof item.maxSteps === 'number' && Number.isFinite(item.maxSteps)) {
      spec.maxSteps = item.maxSteps;
    }
    if (typeof item.role === 'string' && item.role.trim()) spec.role = item.role;
    return { name, task, ...(Object.keys(spec).length > 0 ? { spec } : {}) };
  });
}

interface RubricCriterionJson {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  weight?: unknown;
  maxScore?: unknown;
  keywords?: unknown;
}

/**
 * Rubric từ JSON của tool: giống `Rubric` của core, cộng thêm trường
 * `keywords` (string[]) ở từng tiêu chí để keyword grader biết chấm
 * bằng từ khoá nào khi caller không truyền `keywordRules` riêng.
 */
function parseRubric(raw: unknown): {
  rubric: Rubric;
  keywordRules: Record<string, KeywordRule[]>;
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('fanout_tasks cần "rubric" là object { id, name, criteria[] }.');
  }
  const obj = raw as { id?: unknown; name?: unknown; passThreshold?: unknown; criteria?: unknown };
  const criteriaRaw = obj.criteria;
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length === 0) {
    throw new Error('fanout_tasks: rubric cần "criteria" là mảng không rỗng.');
  }
  const keywordRules: Record<string, KeywordRule[]> = {};
  const criteria = criteriaRaw.map((entry, i) => {
    const c = entry as RubricCriterionJson;
    const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : '';
    if (!id) throw new Error(`fanout_tasks: rubric criteria #${i + 1} cần "id" không rỗng.`);
    if (Array.isArray(c.keywords)) {
      keywordRules[id] = (c.keywords as unknown[])
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .map((k) => ({ keyword: k.trim() }));
    }
    return {
      id,
      label: typeof c.label === 'string' && c.label.trim() ? c.label : id,
      description: typeof c.description === 'string' ? c.description : '',
      ...(typeof c.weight === 'number' ? { weight: c.weight } : {}),
      ...(typeof c.maxScore === 'number' ? { maxScore: c.maxScore } : {}),
    };
  });
  const rubric = validateRubric({
    id: typeof obj.id === 'string' ? obj.id : '',
    name: typeof obj.name === 'string' ? obj.name : '',
    ...(typeof obj.passThreshold === 'number' ? { passThreshold: obj.passThreshold } : {}),
    criteria,
  });
  return { rubric, keywordRules };
}

function parseKeywordRulesArg(raw: unknown): Record<string, KeywordRule[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"keywordRules" phải là object { "<criterionId>": ["từ khoá", ...] }.');
  }
  const out: Record<string, KeywordRule[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new Error(`"keywordRules.${key}" phải là mảng chuỗi từ khoá.`);
    }
    out[key] = (value as unknown[])
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => ({ keyword: k.trim() }));
  }
  return out;
}

export function createNestedSubagentTools(): Tool[] {
  const listSubagentTree: Tool = {
    definition: toolDef(
      'list_subagent_tree',
      'Xem cây nested subagent của run này: node nào đang chạy/xong/lỗi, depth, token đã dùng, ngân sách context còn lại. Dùng để kiểm tra trước khi spawn thêm con (tránh vượt depth/budget).',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx: ToolContext) {
      try {
        if (!ctx.subagentTree) {
          return errorResult(
            'list_subagent_tree chưa được hỗ trợ trong phiên này (ToolContext.subagentTree chưa được cấu hình).',
          );
        }
        const snapshot = ctx.subagentTree();
        const header =
          `Cây subagent: ${snapshot.totalNodes} node, ${snapshot.totalTokensUsed}/${snapshot.totalBudgetTokens} token` +
          (snapshot.totalOverBudget ? ' — ⚠️ ĐÃ VƯỢT ngân sách context tổng' : '') +
          ` (maxDepth ${snapshot.policy.maxDepth}, tối đa ${snapshot.policy.maxSpawnsPerRoot} node).`;
        return `${header}\n${formatSubagentTree(snapshot.root)}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fanoutTasks: Tool = {
    definition: toolDef(
      'fanout_tasks',
      'Chia việc cho nhiều subagent chạy song song rồi chấm từng kết quả theo rubric: task chưa đạt được gửi sửa lại kèm feedback của grader, tối đa maxRounds vòng. Rubric truyền dạng JSON { id, name, passThreshold?, criteria: [{ id, label, description, weight?, maxScore?, keywords? }] }; grader chấm bằng từ khoá (keywords trong tiêu chí, hoặc keywordRules riêng).',
      {
        tasks: {
          type: 'array',
          description:
            'Mảng task, mỗi phần tử { name, task, instructions?, tools?, model?, timeoutMs?, maxSteps?, role? }. Tên phải duy nhất.',
        },
        rubric: {
          type: 'object',
          description:
            'Rubric JSON { id, name, passThreshold? (0..1, mặc định 0.7), criteria: [{ id, label, description, weight?, maxScore?, keywords? }] }.',
        },
        keywordRules: {
          type: 'object',
          description:
            'Ghi đè từ khoá chấm theo tiêu chí: { "<criterionId>": ["từ khoá", ...] }. Không truyền = dùng keywords trong rubric.',
        },
        concurrency: { type: 'number', description: 'Số subagent chạy cùng lúc tối đa. Mặc định 4.' },
        maxRounds: { type: 'number', description: 'Số vòng tối đa (vòng 1 = chạy lần đầu). Mặc định 3.' },
      },
      ['tasks', 'rubric'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      try {
        if (!ctx.runFanOutWithGrading) {
          return errorResult(
            'fanout_tasks chưa được hỗ trợ trong phiên này (ToolContext.runFanOutWithGrading chưa được cấu hình).',
          );
        }
        const tasks = parseFanOutTasks(parseJsonArg(args, 'tasks'));
        const { rubric, keywordRules: rubricRules } = parseRubric(parseJsonArg(args, 'rubric'));
        const rulesOverride = parseKeywordRulesArg(
          args['keywordRules'] === undefined ? undefined : parseJsonArg(args, 'keywordRules', false),
        );
        const rules = rulesOverride ?? rubricRules;
        const concurrency = getNumberArg(args, 'concurrency');
        const maxRounds = getNumberArg(args, 'maxRounds');
        const result = await ctx.runFanOutWithGrading(tasks, rubric, {
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(maxRounds !== undefined ? { maxRounds } : {}),
          grader: createKeywordGrader(rules),
        });
        return result.summary;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listSubagentTree, fanoutTasks];
}

/**
 * Unbound placeholder: cùng shape tool, nhưng chạy ngoài AgentRunner
 * thì `execute()` trả lỗi "chưa hỗ trợ" rõ ràng thay vì crash.
 */
export const NESTED_SUBAGENT_TOOLS: Tool[] = createNestedSubagentTools();
