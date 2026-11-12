/**
 * Workflow graph khai báo (v0.12, mục 6) — @open-bot/core.
 *
 * Một workflow là một graph có hướng, khai báo bằng JSON/TS object:
 * node (bước) + edge (chuyển bước, có điều kiện). Executor chạy graph
 * từng node, truyền output node trước làm input node sau qua state chung,
 * dừng khi tới node kết thúc hoặc khi lỗi / vượt giới hạn lặp.
 *
 * Học pattern từ LangGraph (graph + state) và grind trong
 * `coordination.ts` (state machine + checkpoint từng lát), nhưng viết
 * lại hoàn toàn cho open-bot, không sao chép code/text/tài sản nào
 * của xAI/Cursor/LangGraph.
 *
 * KHÔNG nối vào AgentRunner ở đây (cố ý): executor nhận một "runner"
 * trừu tượng — callback chạy một node (gọi agent với prompt riêng hoặc
 * gọi một tool cụ thể). Điều phối viên sẽ nối runner thật sau:
 *   1. Viết runner thật: node `agent` → chạy AgentRunner với
 *      `node.prompt` đã render template; node `tool` → gọi tool trong
 *      registry bằng `node.toolName` + `node.args`.
 *   2. Đăng ký workflow thành tool/lệnh cho agent gọi, vd tool
 *      `run_workflow` (nhận `workflowId` + `initialState`) hoặc slash
 *      command `/workflow <id>`, và load 2 workflow mẫu trong
 *      `workflows/` làm workflow mặc định.
 *   3. (Tùy chọn) Lưu checkpoint sau mỗi node vào `run_checkpoints`
 *      (W4d) để resume được workflow giữa chừng.
 *
 * Chống lặp vô hạn: mỗi node chỉ được thăm tối đa `maxIterations`
 * lần trong một lần chạy; cycle chỉ hợp lệ khi có ít nhất một edge
 * có điều kiện để thoát (validator kiểm tra).
 */

export type WorkflowNodeKind = 'agent' | 'tool' | 'branch' | 'parallel' | 'end';

/**
 * Điều kiện rẽ nhánh, đánh giá trên state chung của workflow.
 * `field` là đường dẫn dạng `a.b.c` vào state (vd `test` — output của
 * node `test`, hoặc `ketQua.passed` khi output là object). Chỉ cần
 * khai MỘT trong các phép so sánh dưới đây; khai nhiều phép thì TẤT CẢ
 * phải đúng (AND). Không khai phép nào → luôn đúng.
 */
export interface WorkflowCondition {
  /** Đường dẫn vào state, vd `test`, `plan.approved`. */
  field: string;
  /** Bằng (so sánh sâu với === cho primitive, JSON cho object). */
  equals?: unknown;
  /** Khác. */
  notEquals?: unknown;
  /** Chuỗi chứa (không phân biệt hoa/thường); field phải là string. */
  contains?: string;
  /** Chuỗi KHÔNG chứa (không phân biệt hoa/thường); field phải là string. */
  notContains?: string;
  /** Regex (chuỗi pattern); field phải là string. */
  matches?: string;
  /** Field tồn tại (không phải undefined/null). */
  exists?: boolean;
  /** Field truthy. */
  truthy?: boolean;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Mô tả ngắn cho người đọc/debug (tiếng Việt). */
  description?: string;
  /**
   * Node `agent`: prompt riêng cho agent. Hỗ trợ template `{{field}}`
   * (đường dẫn vào state), vd `{{topic}}`, `{{searchResults}}`.
   */
  prompt?: string;
  /**
   * Node `tool`: tên tool trong registry (vd `web_search`, `shell_exec`).
   * Runner thật sẽ tra tool này để chạy.
   */
  toolName?: string;
  /**
   * Node `tool`: tham số cho tool. Giá trị string hỗ trợ template
   * `{{field}}` như prompt; các giá trị khác truyền nguyên.
   */
  args?: Record<string, unknown>;
  /**
   * Node `parallel`: danh sách node con chạy song song. Mỗi nhánh là
   * MỘT node (agent/tool) — không phải sub-graph; kết quả mỗi nhánh
   * lưu vào state dưới id của node nhánh đó.
   */
  branches?: string[];
  /**
   * Key lưu output của node vào state. Mặc định là `node.id`.
   * Node `end` có thể đọc lại bằng `resultFrom`.
   */
  outputKey?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Không có condition → edge mặc định (luôn đi được). */
  condition?: WorkflowCondition;
  /** Mô tả ngắn, vd "test fail → fix lại". */
  description?: string;
}

export interface WorkflowDefinition {
  /** Id duy nhất, vd `research-brief`. */
  id: string;
  name: string;
  description?: string;
  /** Node bắt đầu chạy. */
  startNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /**
   * Số lần tối đa một node được thăm trong một lần chạy (chống cycle
   * vô hạn). Mặc định 10. Workflow plan→edit→test→fix nên đặt 3–5
   * để giới hạn số vòng fix–test.
   */
  maxIterations?: number;
  /** Số node tối đa chạy trong một lần chạy (mặc định 100). */
  maxSteps?: number;
}

export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
}

/** Đọc một giá trị trong state theo đường dẫn `a.b.c`. */
export function getStateField(state: Record<string, unknown>, field: string): unknown {
  let current: unknown = state;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Render template `{{field}}` trong một chuỗi bằng giá trị trong state.
 * Giá trị không phải string được JSON-stringify (object) hoặc String().
 * Field không có trong state → giữ nguyên `{{field}}` để dễ debug.
 */
export function renderTemplate(text: string, state: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g, (whole, field: string) => {
    const value = getStateField(state, field);
    if (value === undefined || value === null) return whole;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  });
}

/** Render template cho mọi giá trị string trong args của node tool. */
export function renderArgs(
  args: Record<string, unknown>,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? renderTemplate(value, state) : value;
  }
  return out;
}

/** Đánh giá một điều kiện trên state. Không có condition → true. */
export function evaluateCondition(
  condition: WorkflowCondition | undefined,
  state: Record<string, unknown>,
): boolean {
  if (!condition) return true;
  const value = getStateField(state, condition.field);
  if (condition.equals !== undefined) {
    const same =
      typeof value === 'object' || typeof condition.equals === 'object'
        ? JSON.stringify(value) === JSON.stringify(condition.equals)
        : value === condition.equals;
    if (!same) return false;
  }
  if (condition.notEquals !== undefined) {
    const same =
      typeof value === 'object' || typeof condition.notEquals === 'object'
        ? JSON.stringify(value) === JSON.stringify(condition.notEquals)
        : value === condition.notEquals;
    if (same) return false;
  }
  if (condition.contains !== undefined) {
    if (typeof value !== 'string') return false;
    if (!value.toLowerCase().includes(condition.contains.toLowerCase())) return false;
  }
  if (condition.notContains !== undefined) {
    if (typeof value !== 'string') return false;
    if (value.toLowerCase().includes(condition.notContains.toLowerCase())) return false;
  }
  if (condition.matches !== undefined) {
    if (typeof value !== 'string') return false;
    let re: RegExp;
    try {
      re = new RegExp(condition.matches);
    } catch {
      return false;
    }
    if (!re.test(value)) return false;
  }
  if (condition.exists !== undefined) {
    const exists = value !== undefined && value !== null;
    if (exists !== condition.exists) return false;
  }
  if (condition.truthy !== undefined) {
    if (Boolean(value) !== condition.truthy) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const NODE_KINDS: readonly WorkflowNodeKind[] = ['agent', 'tool', 'branch', 'parallel', 'end'];

/**
 * Kiểm tra graph hợp lệ TRƯỚC KHI chạy. Trả về danh sách lỗi (rỗng
 * khi hợp lệ) — không throw để caller gom hết lỗi một lượt.
 *
 * Kiểm tra: id/name/start tồn tại; id node duy nhất; mỗi node đủ
 * trường theo kind; edge trỏ tới node có thật; mỗi node (trừ `end`)
 * có ít nhất một edge đi ra; không có 2 edge mặc định cùng đi ra
 * khỏi một node (mơ hồ); node `end` tới được từ start; cycle chỉ
 * hợp lệ khi có ít nhất một edge có điều kiện để thoát.
 */
export function validateWorkflow(def: WorkflowDefinition): WorkflowValidation {
  const errors: string[] = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['Workflow không phải object.'] };
  if (!def.id || typeof def.id !== 'string' || !def.id.trim()) {
    errors.push('Workflow cần `id` không rỗng.');
  }
  if (!def.name || typeof def.name !== 'string' || !def.name.trim()) {
    errors.push('Workflow cần `name` không rỗng.');
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push('Workflow cần ít nhất một node.');
    return { ok: false, errors };
  }
  if (def.maxIterations !== undefined && (!Number.isInteger(def.maxIterations) || def.maxIterations < 1)) {
    errors.push('`maxIterations` phải là số nguyên ≥ 1.');
  }
  if (def.maxSteps !== undefined && (!Number.isInteger(def.maxSteps) || def.maxSteps < 1)) {
    errors.push('`maxSteps` phải là số nguyên ≥ 1.');
  }

  const nodeById = new Map<string, WorkflowNode>();
  for (const node of def.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      errors.push('Mỗi node cần `id` không rỗng.');
      continue;
    }
    if (nodeById.has(node.id)) errors.push(`Trùng id node: "${node.id}".`);
    nodeById.set(node.id, node);
    if (!NODE_KINDS.includes(node.kind)) {
      errors.push(`Node "${node.id}" có kind không hợp lệ: "${String(node.kind)}".`);
      continue;
    }
    if (node.kind === 'agent' && (!node.prompt || !node.prompt.trim())) {
      errors.push(`Node agent "${node.id}" cần \`prompt\` không rỗng.`);
    }
    if (node.kind === 'tool' && (!node.toolName || !node.toolName.trim())) {
      errors.push(`Node tool "${node.id}" cần \`toolName\` không rỗng.`);
    }
    if (node.kind === 'parallel') {
      if (!Array.isArray(node.branches) || node.branches.length < 2) {
        errors.push(`Node parallel "${node.id}" cần ít nhất 2 nhánh trong \`branches\`.`);
      } else {
        for (const branchId of node.branches) {
          if (typeof branchId !== 'string' || !branchId.trim()) {
            errors.push(`Node parallel "${node.id}" có nhánh không phải id hợp lệ.`);
          }
        }
      }
    }
    if (node.kind === 'branch' && node.prompt) {
      errors.push(`Node branch "${node.id}" không dùng \`prompt\` — rẽ nhánh chỉ dựa vào edge có điều kiện.`);
    }
  }

  if (!nodeById.has(def.startNodeId)) {
    errors.push(`Node bắt đầu không tồn tại: "${def.startNodeId}".`);
  }
  if (!Array.isArray(def.edges)) {
    errors.push('Workflow cần `edges` là mảng (có thể rỗng chỉ khi có 1 node `end`).');
    return { ok: false, errors };
  }
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of def.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      errors.push('Mỗi edge cần `from` và `to` là id node.');
      continue;
    }
    if (!nodeById.has(edge.from)) errors.push(`Edge trỏ từ node không tồn tại: "${edge.from}".`);
    if (!nodeById.has(edge.to)) errors.push(`Edge trỏ tới node không tồn tại: "${edge.to}".`);
    if (edge.from === edge.to) {
      errors.push(`Edge tự trỏ chính mình ở node "${edge.from}" — dùng cycle qua 2 node trở lên thay vì self-loop.`);
    }
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
  }
  // Parallel branches phải trỏ tới node có thật, và nhánh không được là node `end`/`parallel` lồng nhau.
  for (const node of def.nodes) {
    if (node.kind !== 'parallel' || !Array.isArray(node.branches)) continue;
    for (const branchId of node.branches) {
      const branch = nodeById.get(branchId);
      if (!branch) {
        errors.push(`Node parallel "${node.id}" trỏ nhánh không tồn tại: "${branchId}".`);
      } else if (branch.kind === 'parallel' || branch.kind === 'end') {
        errors.push(`Node parallel "${node.id}" không hỗ trợ nhánh là node \`${branch.kind}\`: "${branchId}".`);
      }
    }
  }
  // Mỗi node trừ `end` phải có edge đi ra; không 2 edge mặc định cùng nguồn.
  // Ngoại lệ: node là nhánh của node `parallel` — nó chạy qua node
  // parallel, không đi bằng edge nên không cần edge đi ra.
  const parallelBranchIds = new Set<string>();
  for (const node of def.nodes) {
    if (node.kind === 'parallel' && Array.isArray(node.branches)) {
      for (const b of node.branches) parallelBranchIds.add(b);
    }
  }
  for (const node of def.nodes) {
    const outs = outgoing.get(node.id) ?? [];
    if (node.kind === 'end') continue;
    if (parallelBranchIds.has(node.id)) continue;
    if (outs.length === 0) {
      errors.push(`Node "${node.id}" (${node.kind}) không có edge đi ra — graph sẽ kẹt ở đây.`);
    }
    const unconditional = outs.filter((e) => !e.condition);
    if (unconditional.length > 1) {
      errors.push(
        `Node "${node.id}" có ${unconditional.length} edge mặc định (không điều kiện) — mơ hồ, chỉ giữ 1 edge mặc định làm fallback.`,
      );
    }
  }
  // Node `end` phải tới được từ start (đi theo edge + nhánh parallel).
  if (nodeById.has(def.startNodeId)) {
    const reachable = new Set<string>();
    const stack = [def.startNodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const node = nodeById.get(id);
      if (node?.kind === 'parallel' && Array.isArray(node.branches)) {
        for (const b of node.branches) stack.push(b);
      }
      for (const edge of outgoing.get(id) ?? []) stack.push(edge.to);
    }
    const hasEndReachable = [...reachable].some((id) => nodeById.get(id)?.kind === 'end');
    if (!hasEndReachable) errors.push('Không có node `end` nào tới được từ node bắt đầu.');
    for (const node of def.nodes) {
      if (!reachable.has(node.id)) {
        errors.push(`Node "${node.id}" không tới được từ node bắt đầu — node mồ côi.`);
      }
    }
    // Cycle: mỗi cycle phải có ít nhất một edge có điều kiện để thoát.
    // Tìm bằng DFS: khi gặp back-edge, kiểm tra cycle vừa khép có edge có điều kiện không.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const pathEdges: WorkflowEdge[] = [];
    const checkCycle = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const idx = path.indexOf(id);
        const cycleEdges = pathEdges.slice(idx);
        if (cycleEdges.length > 0 && !cycleEdges.some((e) => e.condition)) {
          const cycleNodes = [...path.slice(idx), id].join(' → ');
          errors.push(
            `Cycle không có lối thoát (toàn edge không điều kiện): ${cycleNodes} — thêm điều kiện vào ít nhất một edge trong cycle hoặc bỏ cycle.`,
          );
        }
        return;
      }
      visiting.add(id);
      path.push(id);
      for (const edge of outgoing.get(id) ?? []) {
        pathEdges.push(edge);
        checkCycle(edge.to);
        pathEdges.pop();
      }
      path.pop();
      visiting.delete(id);
      visited.add(id);
    };
    checkCycle(def.startNodeId);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Input runner nhận khi chạy một node. */
export interface WorkflowRunnerInput {
  /** Node đang chạy (prompt/args đã render template từ state). */
  node: WorkflowNode;
  /** State chung hiện tại (chỉ đọc — ghi lại qua `stateUpdates` ở output). */
  state: Record<string, unknown>;
  /** Abort signal của lần chạy (nếu có). */
  signal?: AbortSignal;
}

/** Output runner trả về sau khi chạy xong một node. */
export interface WorkflowNodeOutput {
  /** Kết quả của node — sẽ lưu vào state dưới `node.outputKey ?? node.id`. */
  output: unknown;
  /** Cập nhật thêm vào state chung (vd agent đặt cờ `passed: true`). */
  stateUpdates?: Record<string, unknown>;
  /**
   * Node tiếp theo do runner tự quyết (vd agent quyết định rẽ nhánh).
   * Nếu có, nó thắng edge của graph. Không đặt → đi theo edge.
   */
  next?: string;
}

/**
 * Runner trừu tượng chạy một node. Điều phối viên sẽ nối runner thật:
 * node `agent` → AgentRunner với `node.prompt`; node `tool` → tool
 * trong registry với `node.toolName` + `node.args`. Runner KHÔNG được
 * tự ý đổi graph — nó chỉ trả output (và có thể gợi ý `next`).
 */
export type WorkflowNodeRunner = (input: WorkflowRunnerInput) => Promise<WorkflowNodeOutput>;

export type WorkflowStepStatus = 'ok' | 'error' | 'skipped';

export interface WorkflowStepRecord {
  nodeId: string;
  kind: WorkflowNodeKind;
  /** Id node cha khi đây là nhánh của node `parallel`. */
  parentId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: WorkflowStepStatus;
  /** Output của node (đã cắt ngắn nếu là chuỗi quá dài, để trace gọn). */
  output?: unknown;
  error?: string;
}

export type WorkflowRunStatus = 'done' | 'error' | 'stopped' | 'max-iterations' | 'max-steps';

export interface WorkflowRunResult {
  workflowId: string;
  status: WorkflowRunStatus;
  /** Kết quả cuối: output của node `end` (state[resultFrom] nếu có, không thì output node cuối). */
  output?: unknown;
  /** State chung sau khi chạy xong (kể cả khi lỗi — để debug/resume). */
  state: Record<string, unknown>;
  /** Lịch sử từng node đã chạy, theo thứ tự — dùng để debug/trace. */
  history: WorkflowStepRecord[];
  /** Node `end` đã tới (khi status `done`). */
  endNodeId?: string;
  /** Thông báo lỗi (khi status `error`/`max-iterations`/`max-steps`). */
  error?: string;
}

export interface RunWorkflowOptions {
  /** State ban đầu (vd `{ topic: "..." }` cho workflow research). */
  initialState?: Record<string, unknown>;
  /** Ghi đè `maxIterations` của workflow. */
  maxIterations?: number;
  /** Ghi đè `maxSteps` của workflow. */
  maxSteps?: number;
  /** Abort signal: abort giữa chừng → status `stopped`. */
  signal?: AbortSignal;
  /** Callback sau mỗi node (để UI/trace cập nhật tiến độ). */
  onStep?: (record: WorkflowStepRecord) => void;
  /**
   * Node `end` lấy kết quả cuối từ field nào của state. Mặc định:
   * output của node chạy ngay trước `end` (state `lastOutput`).
   */
  resultFrom?: string;
}

const MAX_OUTPUT_CHARS_IN_HISTORY = 20_000;

function summarizeForHistory(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_OUTPUT_CHARS_IN_HISTORY) {
    return value.slice(0, MAX_OUTPUT_CHARS_IN_HISTORY) + `\n[... cắt ngắn, còn ${value.length - MAX_OUTPUT_CHARS_IN_HISTORY} ký tự ...]`;
  }
  return value;
}

/**
 * Định nghĩa workflow bằng code (helper mỏng): chỉ kiểm tra nhanh
 * rồi trả về definition — validation đầy đủ vẫn qua `validateWorkflow`.
 */
export function defineWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    maxIterations: def.maxIterations ?? 10,
    maxSteps: def.maxSteps ?? 100,
  };
}

/**
 * Chạy một workflow graph. Validate trước khi chạy — graph không hợp
 * lệ thì trả ngay status `error` kèm danh sách lỗi, không chạy node nào.
 */
export async function runWorkflow(
  def: WorkflowDefinition,
  runner: WorkflowNodeRunner,
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const validation = validateWorkflow(def);
  const state: Record<string, unknown> = { ...(opts.initialState ?? {}) };
  const history: WorkflowStepRecord[] = [];
  if (!validation.ok) {
    return {
      workflowId: def?.id ?? '',
      status: 'error',
      state,
      history,
      error: `Workflow không hợp lệ: ${validation.errors.join(' | ')}`,
    };
  }
  const maxIterations = opts.maxIterations ?? def.maxIterations ?? 10;
  const maxSteps = opts.maxSteps ?? def.maxSteps ?? 100;
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of def.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
  }
  const visits = new Map<string, number>();
  const record = (entry: WorkflowStepRecord): void => {
    history.push(entry);
    opts.onStep?.(entry);
  };
  const fail = (status: WorkflowRunStatus, error: string): WorkflowRunResult => ({
    workflowId: def.id,
    status,
    state,
    history,
    error,
  });

  let currentId: string | undefined = def.startNodeId;
  let steps = 0;
  while (currentId) {
    if (opts.signal?.aborted) return fail('stopped', 'Workflow bị dừng bởi abort signal.');
    if (steps >= maxSteps) {
      return fail('max-steps', `Đã chạy ${maxSteps} node mà chưa tới node kết thúc — có thể graph lặp không thoát được.`);
    }
    const node = nodeById.get(currentId);
    if (!node) return fail('error', `Node không tồn tại: "${currentId}".`);
    const count = (visits.get(node.id) ?? 0) + 1;
    visits.set(node.id, count);
    if (count > maxIterations) {
      return fail(
        'max-iterations',
        `Node "${node.id}" đã chạy ${count} lần, vượt giới hạn ${maxIterations} — cycle không thoát được.`,
      );
    }
    steps += 1;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    // Node `end`: kết thúc, không gọi runner.
    if (node.kind === 'end') {
      const output = opts.resultFrom
        ? getStateField(state, opts.resultFrom)
        : state['lastOutput'];
      record({
        nodeId: node.id,
        kind: node.kind,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'ok',
        output: summarizeForHistory(output),
      });
      return { workflowId: def.id, status: 'done', output, state, history, endNodeId: node.id };
    }

    // Node `branch`: không gọi runner, chỉ rẽ theo edge có điều kiện.
    if (node.kind === 'branch') {
      const next = pickNextEdge(outgoing.get(node.id) ?? [], state);
      record({
        nodeId: node.id,
        kind: node.kind,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'ok',
      });
      if (!next) {
        return fail('error', `Node branch "${node.id}" không có edge nào khớp với state hiện tại — thêm edge mặc định làm fallback.`);
      }
      currentId = next;
      continue;
    }

    // Node `parallel`: chạy các nhánh song song qua runner, mỗi nhánh là một node.
    if (node.kind === 'parallel') {
      const branchIds = node.branches ?? [];
      const settled = await Promise.allSettled(
        branchIds.map(async (branchId) => {
          const branchNode = nodeById.get(branchId)!;
          const rendered = renderNode(branchNode, state);
          const bStarted = new Date().toISOString();
          const bStartedMs = Date.now();
          try {
            const out = await runner({ node: rendered, state: { ...state }, signal: opts.signal });
            const key = branchNode.outputKey ?? branchNode.id;
            record({
              nodeId: branchNode.id,
              kind: branchNode.kind,
              parentId: node.id,
              startedAt: bStarted,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - bStartedMs,
              status: 'ok',
              output: summarizeForHistory(out.output),
            });
            return { branchId, output: out.output, stateUpdates: out.stateUpdates };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            record({
              nodeId: branchNode.id,
              kind: branchNode.kind,
              parentId: node.id,
              startedAt: bStarted,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - bStartedMs,
              status: 'error',
              error: message,
            });
            throw new Error(`Nhánh "${branchId}" của node parallel "${node.id}" lỗi: ${message}`);
          }
        }),
      );
      const failed = settled.find((r) => r.status === 'rejected');
      if (failed) {
        return fail('error', (failed as PromiseRejectedResult).reason instanceof Error
          ? (failed as PromiseRejectedResult).reason.message
          : String((failed as PromiseRejectedResult).reason));
      }
      const outputs: Record<string, unknown> = {};
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        outputs[r.value.branchId] = r.value.output;
        state[r.value.branchId] = r.value.output;
        if (r.value.stateUpdates) Object.assign(state, r.value.stateUpdates);
      }
      const key = node.outputKey ?? node.id;
      state[key] = outputs;
      state['lastOutput'] = outputs;
      record({
        nodeId: node.id,
        kind: node.kind,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'ok',
        output: summarizeForHistory(outputs),
      });
      const next = pickNextEdge(outgoing.get(node.id) ?? [], state);
      if (!next) return fail('error', `Node parallel "${node.id}" không có edge đi ra khớp — thêm edge mặc định.`);
      currentId = next;
      continue;
    }

    // Node `agent` / `tool`: gọi runner (đã render template từ state).
    const rendered = renderNode(node, state);
    try {
      const out = await runner({ node: rendered, state: { ...state }, signal: opts.signal });
      const key = node.outputKey ?? node.id;
      state[key] = out.output;
      state['lastOutput'] = out.output;
      if (out.stateUpdates) Object.assign(state, out.stateUpdates);
      record({
        nodeId: node.id,
        kind: node.kind,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'ok',
        output: summarizeForHistory(out.output),
      });
      if (out.next) {
        if (!nodeById.has(out.next)) {
          return fail('error', `Runner yêu cầu chuyển tới node không tồn tại: "${out.next}".`);
        }
        currentId = out.next;
        continue;
      }
      const next = pickNextEdge(outgoing.get(node.id) ?? [], state);
      if (!next) {
        return fail('error', `Node "${node.id}" không có edge đi ra khớp với state hiện tại — thêm edge mặc định làm fallback.`);
      }
      currentId = next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record({
        nodeId: node.id,
        kind: node.kind,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: 'error',
        error: message,
      });
      return fail('error', `Node "${node.id}" (${node.kind}) lỗi: ${message}`);
    }
  }
  return fail('error', 'Workflow kết thúc mà không tới node `end` — kiểm tra lại edge.');
}

/** Render prompt/args của node từ state trước khi đưa cho runner. */
function renderNode(node: WorkflowNode, state: Record<string, unknown>): WorkflowNode {
  const rendered: WorkflowNode = { ...node };
  if (node.prompt) rendered.prompt = renderTemplate(node.prompt, state);
  if (node.args) rendered.args = renderArgs(node.args, state);
  return rendered;
}

/**
 * Chọn edge đi tiếp: edge có điều kiện khớp đầu tiên (theo thứ tự
 * khai báo), nếu không có thì edge mặc định (không điều kiện).
 */
function pickNextEdge(edges: WorkflowEdge[], state: Record<string, unknown>): string | undefined {
  for (const edge of edges) {
    if (edge.condition && evaluateCondition(edge.condition, state)) return edge.to;
  }
  return edges.find((e) => !e.condition)?.to;
}
