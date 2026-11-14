/**
 * Nested subagents — v1.01 (Team T6).
 *
 * Một subagent có thể spawn subagent con, nhưng không vô hạn. Module này
 * là tầng pure (không import loop.ts, không gọi provider) giữ MỘT cây
 * đăng ký cho cả cây spawn của một run gốc:
 *
 *  - `NestedSubagentPolicy`: depth tối đa (mặc định 5), spawn budget
 *    (tổng số node/cây + số con trực tiếp/một cha), context budget
 *    (mỗi node + tổng cây), chặn task trùng đang chạy cùng cha.
 *  - `SubagentTree`: `requestSpawn()` là MỘT chỗ duy nhất quyết định
 *    có được spawn không; `recordTokens/recordEstimate` theo dõi
 *    context từng node; `snapshot()` trả cây lồng nhau cho UI/tool.
 * Ước lượng token dùng chung `estimateTokens` của `agent/tokens.ts`
 * (không tự viết estimator mới).
 *
 * Chống vòng lặp spawn = 4 lớp độc lập (không lớp nào dựa vào model
 * tự dừng): depth cap + spawn budget (root + branch) + context budget
 * tổng + chặn task trùng đang chạy. `AgentRunner` (loop.ts) nối cây
 * này vào `runSubagent()` — xem `sdk/query.ts` và test để biết cách
 * dùng.
 */

import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../agent/tokens';

export const DEFAULT_NESTED_MAX_DEPTH = 5;
export const DEFAULT_NESTED_MAX_SPAWNS_PER_ROOT = 50;
export const DEFAULT_NESTED_MAX_SPAWNS_PER_BRANCH = 10;
export const DEFAULT_NESTED_CONTEXT_BUDGET_PER_NODE = 32_000;
export const DEFAULT_NESTED_CONTEXT_BUDGET_TOTAL = 128_000;
/** Task trùng được so theo 200 ký tự đầu đã chuẩn hoá (xem fingerprintTask). */
export const DUPLICATE_TASK_FINGERPRINT_CHARS = 200;

export interface NestedSubagentPolicy {
  /**
   * Độ sâu tối đa của node con (root depth 0). Spawn từ node depth
   * `maxDepth` bị chặn. Mặc định 5.
   */
  maxDepth?: number;
  /** Tổng số node tối đa trong một cây (kể cả root). Mặc định 50. */
  maxSpawnsPerRoot?: number;
  /** Số con trực tiếp tối đa của một node cha. Mặc định 10. */
  maxSpawnsPerBranch?: number;
  /** Token tối đa một node được dùng (usage thật hoặc ước lượng). Mặc định 32_000. */
  contextBudgetTokensPerNode?: number;
  /** Token tối đa cả cây được dùng. Mặc định 128_000. */
  contextBudgetTokensTotal?: number;
  /**
   * true (mặc định): chặn spawn task giống hệt một task ĐANG CHẠY của
   * cùng cha — dấu hiệu vòng lặp spawn. Task giống nhưng con cũ đã
   * xong thì vẫn spawn được (retry hợp lệ). false = tắt lớp chặn này.
   */
  denyConcurrentDuplicateTasks?: boolean;
}

export interface ResolvedNestedPolicy {
  maxDepth: number;
  maxSpawnsPerRoot: number;
  maxSpawnsPerBranch: number;
  contextBudgetTokensPerNode: number;
  contextBudgetTokensTotal: number;
  denyConcurrentDuplicateTasks: boolean;
}

export function resolveNestedPolicy(policy: NestedSubagentPolicy = {}): ResolvedNestedPolicy {
  const num = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`NestedSubagentPolicy.${name} phải > 0 (nhận ${String(value)}).`);
    }
    return Math.floor(value);
  };
  return {
    maxDepth: num(policy.maxDepth, DEFAULT_NESTED_MAX_DEPTH, 'maxDepth'),
    maxSpawnsPerRoot: num(
      policy.maxSpawnsPerRoot,
      DEFAULT_NESTED_MAX_SPAWNS_PER_ROOT,
      'maxSpawnsPerRoot',
    ),
    maxSpawnsPerBranch: num(
      policy.maxSpawnsPerBranch,
      DEFAULT_NESTED_MAX_SPAWNS_PER_BRANCH,
      'maxSpawnsPerBranch',
    ),
    contextBudgetTokensPerNode: num(
      policy.contextBudgetTokensPerNode,
      DEFAULT_NESTED_CONTEXT_BUDGET_PER_NODE,
      'contextBudgetTokensPerNode',
    ),
    contextBudgetTokensTotal: num(
      policy.contextBudgetTokensTotal,
      DEFAULT_NESTED_CONTEXT_BUDGET_TOTAL,
      'contextBudgetTokensTotal',
    ),
    denyConcurrentDuplicateTasks: policy.denyConcurrentDuplicateTasks ?? true,
  };
}

export type SubagentNodeStatus = 'running' | 'done' | 'error' | 'timeout' | 'stopped';

export interface SubagentNode {
  id: string;
  parentId: string | null;
  /** Tên hiển thị (role hoặc tên spec; root là 'root'). */
  name: string;
  depth: number;
  status: SubagentNodeStatus;
  /** Task được giao (đã cắt ngắn khi snapshot, xem MAX_NODE_TASK_CHARS). */
  task: string;
  /** Model của node (trống = model của cha). */
  model?: string;
  /** Tool được phép (trống = toàn bộ tool của cha). */
  tools?: string[];
  /** Token đã dùng: usage thật cộng dồn, hoặc ước lượng (estimateTokens). */
  tokensUsed: number;
  /**
   * v1.01 (Team T6): context budget RIÊNG của node này (token). Mặc định
   * = policy.contextBudgetTokensPerNode; spawn có thể ghi đè qua
   * `SubagentOptions.contextBudgetTokens` (xem loop.ts).
   */
  budgetTokens: number;
  /** Số con trực tiếp đã spawn từ node này. */
  spawnsUsed: number;
  startedAt: number;
  endedAt?: number;
  /** Lỗi / lý do kết thúc, chỉ có khi status != 'done'. */
  error?: string;
  /** true khi tokensUsed vượt contextBudgetTokensPerNode. */
  overBudget: boolean;
}

/** Task lưu trong node cắt ở 2.000 ký tự — snapshot không phình vì task dài. */
export const MAX_NODE_TASK_CHARS = 2_000;

export type SpawnDenialReason =
  | 'max-depth'
  | 'max-spawns-root'
  | 'max-spawns-branch'
  | 'context-budget-total'
  | 'duplicate-task-running'
  | 'unknown-parent';

export type SpawnRequest =
  | { ok: true; node: SubagentNode }
  | { ok: false; reason: SpawnDenialReason; message: string };

/** Mô tả lý do chặn bằng tiếng Việt, dùng trong chuỗi lỗi trả cho cha. */
export const SPAWN_DENIAL_MESSAGES: Record<SpawnDenialReason, string> = {
  'max-depth':
    'đã đạt độ sâu lồng tối đa (maxDepth) — subagent ở tầng này không được spawn con nữa',
  'max-spawns-root':
    'đã đạt tổng số subagent tối đa cho cây này (maxSpawnsPerRoot) — không spawn thêm',
  'max-spawns-branch':
    'cha này đã spawn tối đa số con trực tiếp (maxSpawnsPerBranch) — không spawn thêm',
  'context-budget-total':
    'ngân sách context tổng của cây sắp hết (contextBudgetTokensTotal) — không spawn thêm',
  'duplicate-task-running':
    'task giống hệt một task đang chạy của cùng cha — nghi vòng lặp spawn, đã chặn',
  'unknown-parent': 'không tìm thấy node cha trong cây subagent',
};

export interface SubagentTreeSnapshotNode {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  status: SubagentNodeStatus;
  task: string;
  model?: string;
  tools?: string[];
  tokensUsed: number;
  spawnsUsed: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** Context budget riêng của node (mặc định = policy per-node). */
  budgetTokens: number;
  overBudget: boolean;
  children: SubagentTreeSnapshotNode[];
}

export interface SubagentTreeSnapshot {
  root: SubagentTreeSnapshotNode;
  /** Tổng node trong cây (kể cả root). */
  totalNodes: number;
  /** Tổng token đã dùng cả cây. */
  totalTokensUsed: number;
  /** Token tối đa cả cây (policy). */
  totalBudgetTokens: number;
  /** true khi totalTokensUsed >= totalBudgetTokens. */
  totalOverBudget: boolean;
  policy: ResolvedNestedPolicy;
}

/** Chuẩn hoá task để so trùng: trim + gộp khoảng trắng + lowercase + cắt ngắn. */
export function fingerprintTask(task: string): string {
  return task.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, DUPLICATE_TASK_FINGERPRINT_CHARS);
}

function truncateTask(task: string): string {
  if (task.length <= MAX_NODE_TASK_CHARS) return task;
  return task.slice(0, MAX_NODE_TASK_CHARS) + `\n[... task cắt ngắn còn ${MAX_NODE_TASK_CHARS} ký tự ...]`;
}

/**
 * Cây đăng ký nested subagent cho một run gốc. Một instance = một cây;
 * runner root tạo cây, runner con nhận cùng instance qua opts (xem
 * loop.ts). Mọi kiểm tra spawn đều qua `requestSpawn()` — không spawn
 * lén ngoài cây.
 */
export class SubagentTree {
  readonly policy: ResolvedNestedPolicy;
  private readonly nodes = new Map<string, SubagentNode>();
  private readonly children = new Map<string, string[]>();
  readonly rootId: string;

  constructor(policy: NestedSubagentPolicy = {}, rootName = 'root') {
    this.policy = resolveNestedPolicy(policy);
    const root: SubagentNode = {
      id: randomUUID(),
      parentId: null,
      name: rootName.trim() || 'root',
      depth: 0,
      status: 'running',
      task: '',
      tokensUsed: 0,
      budgetTokens: this.policy.contextBudgetTokensPerNode,
      spawnsUsed: 0,
      startedAt: Date.now(),
      overBudget: false,
    };
    this.rootId = root.id;
    this.nodes.set(root.id, root);
    this.children.set(root.id, []);
  }

  /** Node theo id (bản sao nông — caller không sửa được cây qua nó). */
  getNode(id: string): SubagentNode | undefined {
    const node = this.nodes.get(id);
    return node ? { ...node } : undefined;
  }

  get root(): SubagentNode {
    return this.getNode(this.rootId) as SubagentNode;
  }

  totalNodes(): number {
    return this.nodes.size;
  }

  totalTokensUsed(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.tokensUsed;
    return total;
  }

  isTotalOverBudget(): boolean {
    return this.totalTokensUsed() >= this.policy.contextBudgetTokensTotal;
  }

  /**
   * Xin spawn một node con của `parentId`. Trả về node mới khi được phép;
   * khi bị chặn, trả về lý do rõ ràng và KHÔNG tạo node — caller (loop)
   * chỉ việc trả chuỗi lỗi cho cha, không cần xử lý thêm.
   */
  requestSpawn(
    parentId: string,
    task: string,
    opts: { name?: string; model?: string; tools?: string[]; budgetTokens?: number } = {},
  ): SpawnRequest {
    const parent = this.nodes.get(parentId);
    if (!parent) {
      return { ok: false, reason: 'unknown-parent', message: SPAWN_DENIAL_MESSAGES['unknown-parent'] };
    }
    const childDepth = parent.depth + 1;
    if (childDepth > this.policy.maxDepth) {
      return {
        ok: false,
        reason: 'max-depth',
        message:
          `${SPAWN_DENIAL_MESSAGES['max-depth']} ` +
          `(cha depth ${parent.depth}, con sẽ là depth ${childDepth}, maxDepth ${this.policy.maxDepth}).`,
      };
    }
    if (this.nodes.size >= this.policy.maxSpawnsPerRoot) {
      return {
        ok: false,
        reason: 'max-spawns-root',
        message:
          `${SPAWN_DENIAL_MESSAGES['max-spawns-root']} ` +
          `(${this.nodes.size}/${this.policy.maxSpawnsPerRoot} node).`,
      };
    }
    if (parent.spawnsUsed >= this.policy.maxSpawnsPerBranch) {
      return {
        ok: false,
        reason: 'max-spawns-branch',
        message:
          `${SPAWN_DENIAL_MESSAGES['max-spawns-branch']} ` +
          `("${parent.name}" đã spawn ${parent.spawnsUsed}/${this.policy.maxSpawnsPerBranch} con).`,
      };
    }
    const estimatedTaskTokens = estimateTokens(task);
    if (this.totalTokensUsed() + estimatedTaskTokens >= this.policy.contextBudgetTokensTotal) {
      return {
        ok: false,
        reason: 'context-budget-total',
        message:
          `${SPAWN_DENIAL_MESSAGES['context-budget-total']} ` +
          `(${this.totalTokensUsed()}/${this.policy.contextBudgetTokensTotal} token đã dùng, ` +
          `task mới ước lượng ${estimatedTaskTokens} token).`,
      };
    }
    if (this.policy.denyConcurrentDuplicateTasks) {
      const fingerprint = fingerprintTask(task);
      const siblings = this.children.get(parentId) ?? [];
      for (const siblingId of siblings) {
        const sibling = this.nodes.get(siblingId);
        if (
          sibling &&
          sibling.status === 'running' &&
          fingerprintTask(sibling.task) === fingerprint &&
          fingerprint.length > 0
        ) {
          return {
            ok: false,
            reason: 'duplicate-task-running',
            message:
              `${SPAWN_DENIAL_MESSAGES['duplicate-task-running']} ` +
              `(con "${sibling.name}" đang chạy cùng task).`,
          };
        }
      }
    }
    // Budget riêng của node: spawn ghi đè được (phải > 0), nếu không
    // dùng budget per-node của policy. Ghi đè sai (<= 0 / NaN) thì rơi
    // về policy thay vì throw — requestSpawn đã là đường nóng của loop.
    const budgetTokens =
      opts.budgetTokens !== undefined &&
      Number.isFinite(opts.budgetTokens) &&
      opts.budgetTokens > 0
        ? Math.floor(opts.budgetTokens)
        : this.policy.contextBudgetTokensPerNode;
    const node: SubagentNode = {
      id: randomUUID(),
      parentId,
      name: (opts.name?.trim() || 'subagent').slice(0, 80),
      depth: childDepth,
      status: 'running',
      task: truncateTask(task),
      ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
      ...(opts.tools && opts.tools.length > 0 ? { tools: [...opts.tools] } : {}),
      tokensUsed: 0,
      budgetTokens,
      spawnsUsed: 0,
      startedAt: Date.now(),
      overBudget: false,
    };
    this.nodes.set(node.id, node);
    this.children.set(node.id, []);
    this.children.get(parentId)?.push(node.id);
    parent.spawnsUsed += 1;
    return { ok: true, node: { ...node } };
  }

  /**
   * Cộng token thật (usage provider trả về) vào node. Trả về true khi
   * node vừa vượt budget RIÊNG của nó (`node.budgetTokens`) — caller
   * quyết định dừng turn hay chỉ ghi cờ (loop.ts dừng turn của
   * subagent, không dừng run gốc).
   */
  recordTokens(nodeId: string, tokens: number): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || !Number.isFinite(tokens) || tokens <= 0) return false;
    node.tokensUsed += Math.floor(tokens);
    if (node.tokensUsed >= node.budgetTokens) node.overBudget = true;
    return node.overBudget;
  }

  /** Cộng token ước lượng từ độ dài text (khi không có usage thật). */
  recordEstimate(nodeId: string, text: string): boolean {
    return this.recordTokens(nodeId, estimateTokens(text));
  }

  /**
   * Đánh dấu node kết thúc (done/error/timeout/stopped). `finalText` chỉ
   * được ước lượng token khi node CHƯA có usage thật nào — provider trả
   * usage thì số thật đã đủ, không cộng thêm ước lượng để khỏi đếm trùng.
   */
  completeNode(
    nodeId: string,
    status: Exclude<SubagentNodeStatus, 'running'>,
    opts: { error?: string; finalText?: string } = {},
  ): SubagentNode | undefined {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    if (opts.finalText && node.tokensUsed === 0) this.recordEstimate(nodeId, opts.finalText);
    node.status = status;
    node.endedAt = Date.now();
    if (opts.error?.trim()) node.error = opts.error.trim().slice(0, 500);
    return { ...node };
  }

  /** true khi node đã vượt context budget của chính nó. */
  isNodeOverBudget(nodeId: string): boolean {
    return this.nodes.get(nodeId)?.overBudget ?? false;
  }

  /** Cây lồng nhau (root → children) để UI/tool hiển thị; task đã cắt ngắn. */
  snapshot(): SubagentTreeSnapshot {
    const build = (id: string): SubagentTreeSnapshotNode => {
      const node = this.nodes.get(id) as SubagentNode;
      return {
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        depth: node.depth,
        status: node.status,
        task: node.task,
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.tools !== undefined ? { tools: [...node.tools] } : {}),
        tokensUsed: node.tokensUsed,
        budgetTokens: node.budgetTokens,
        spawnsUsed: node.spawnsUsed,
        startedAt: node.startedAt,
        ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
        ...(node.error !== undefined ? { error: node.error } : {}),
        overBudget: node.overBudget,
        children: (this.children.get(id) ?? []).map(build),
      };
    };
    const totalTokensUsed = this.totalTokensUsed();
    return {
      root: build(this.rootId),
      totalNodes: this.nodes.size,
      totalTokensUsed,
      totalBudgetTokens: this.policy.contextBudgetTokensTotal,
      totalOverBudget: totalTokensUsed >= this.policy.contextBudgetTokensTotal,
      policy: { ...this.policy },
    };
  }
}

/**
 * Tóm tắt kết quả của một node con để đưa vào context của cha: giữ kết
 * luận + cắt ngắn output dài. Cha không bao giờ nhận toàn bộ context
 * của con — đó là cách context isolation được giữ ở tầng text.
 */
export function summarizeChildForParent(
  node: SubagentNode,
  output: string,
  maxChars = 2_000,
): string {
  const statusLine =
    node.status === 'done'
      ? 'xong'
      : node.status === 'timeout'
        ? 'hết giờ'
        : node.status === 'stopped'
          ? 'đã dừng'
          : 'lỗi';
  const body = output.length > maxChars ? output.slice(0, maxChars) + '\n[... đã cắt ngắn ...]' : output;
  const lines = [`[subagent ${node.name} (depth ${node.depth}) — ${statusLine}, ${node.tokensUsed} token]`];
  if (body.trim()) lines.push(body);
  if (node.error?.trim()) lines.push(`Lỗi: ${node.error}`);
  return lines.join('\n');
}
