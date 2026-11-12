/**
 * Subagent theo vai trò (role) — P1-4 (v0.37).
 *
 * Kiểu Claude Code subagents (`.claude/agents/`): mỗi role có system
 * prompt riêng, bộ tool riêng, giới hạn riêng (maxSteps, timeout, có/không
 * cho shell, chỉ-đọc) và gợi ý model riêng. Bot cha gọi đúng chuyên gia
 * thay vì subagent chung chung — vd giao việc nghiên cứu cho `researcher`
 * (chỉ đọc + web), giao sửa code cho `coder`, giao soát code cho
 * `reviewer` (chỉ đọc, không được sửa).
 *
 * Quy tắc an ninh (không thỏa hiệp):
 * - Role chỉ THU HẸP, không mở rộng quyền của cha: tool của con là giao
 *   của (tool cha cho phép) ∩ (tool role cho phép) ∩ (tool gọi trực tiếp
 *   cho phép, nếu có). Tool role xin mà cha không có thì lặng lẽ rơi
 *   khỏi danh sách (ghi lại ở `unavailableTools` để debug), không báo
 *   lỗi — vì cha bị giới hạn bởi allowlist/mode của nó là chuyện bình
 *   thường, không phải lỗi cấu hình.
 * - Role không tồn tại → lỗi rõ ràng (`UnknownSubagentRoleError`), KHÔNG
 *   fallback lặng lẽ về subagent chung.
 * - Role xin tool mà sau khi giao với tool cha còn rỗng → lỗi rõ ràng
 *   (`EmptyRoleToolsError`), không spawn agent con không có tool nào.
 * - `readOnly: true` giao thêm với `READ_ONLY_TOOLS` (defence-in-depth);
 *   `allowShell: false` loại mọi tool shell dù role có khai trong
 *   `tools` (fail-closed khi cấu hình mâu thuẫn).
 *
 * Role custom: file JSON, một role một file hoặc `{ "roles": [...] }`
 * hoặc mảng `[...]` — xem `loadRolesFromDir` / `loadRolesFromFile`.
 * File mẫu: `docs/subagent-roles.example.json`. Host (coordinator) có
 * thể trỏ loader tới `<userData>/subagent-roles/` hoặc workspace
 * `.open-bot/subagent-roles/` rồi truyền vào `AgentRunner` qua
 * `customRoles` / `roleRegistry` — loop tự nó không đọc đĩa (pure).
 *
 * Module này là tầng pure (chỉ `node:fs`/`node:path` ở loader), không
 * import loop.ts (tránh cycle).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { READ_ONLY_TOOLS } from '../agent/toolFilter';

/** Tool chạy shell — bị loại khi role có `allowShell: false`. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'shell_exec',
  'shell_session_start',
  'shell_session_write',
  'shell_session_read',
  'shell_session_close',
  'exec_task',
  'exec_task_status',
  'exec_task_stop',
]);

export type SubagentRoleSource = 'builtin' | 'custom';

export interface SubagentRole {
  /** Id duy nhất, lowercase + gạch ngang, vd `researcher`. */
  id: string;
  /** Mô tả ngắn — hiện cho agent cha / người dùng khi chọn role. */
  description: string;
  /** System prompt (instructions) riêng của role, đưa vào prompt con. */
  systemPrompt: string;
  /**
   * Tool được phép dùng (tên tool như trong ToolRegistry).
   * Trống/undefined = không giới hạn thêm (kế thừa toàn bộ tool cha).
   */
  tools?: string[];
  /** false = cấm mọi tool shell (dù có khai trong `tools`). Mặc định true. */
  allowShell?: boolean;
  /** true = chỉ giữ tool trong READ_ONLY_TOOLS (giao thêm một lớp nữa). */
  readOnly?: boolean;
  /** Số bước tối đa của con; trống = maxSteps của runner cha. */
  maxSteps?: number;
  /** Timeout riêng (ms); trống = 120_000 mặc định của runSubagent. */
  timeoutMs?: number;
  /** Model gợi ý; trống = model của bot cha. Chỉ là gợi ý, không ép. */
  suggestedModel?: string;
  /** Nguồn role — loader đặt, code không cần truyền. */
  source?: SubagentRoleSource;
}

/** Bản tóm tắt role để liệt kê cho agent cha / người dùng chọn. */
export interface SubagentRoleSummary {
  id: string;
  description: string;
  tools: string[];
  allowShell: boolean;
  readOnly: boolean;
  maxSteps?: number;
  timeoutMs?: number;
  suggestedModel?: string;
  source: SubagentRoleSource;
}

export function describeRole(role: SubagentRole): SubagentRoleSummary {
  return {
    id: role.id,
    description: role.description,
    tools: role.tools ? [...role.tools] : [],
    allowShell: role.allowShell !== false,
    readOnly: role.readOnly === true,
    ...(role.maxSteps !== undefined ? { maxSteps: role.maxSteps } : {}),
    ...(role.timeoutMs !== undefined ? { timeoutMs: role.timeoutMs } : {}),
    ...(role.suggestedModel ? { suggestedModel: role.suggestedModel } : {}),
    source: role.source ?? 'builtin',
  };
}

// ---------------------------------------------------------------------------
// Role built-in
// ---------------------------------------------------------------------------

export const BUILTIN_ROLES: readonly SubagentRole[] = [
  {
    id: 'researcher',
    description:
      'Nghiên cứu, tìm hiểu: chỉ đọc và tra cứu web/file, không sửa gì, không chạy shell. Trả về bản tóm tắt có nguồn.',
    systemPrompt:
      'Bạn là researcher — chuyên gia nghiên cứu và tìm hiểu. ' +
      'Chỉ đọc và tra cứu (web, file, lịch sử trò chuyện): KHÔNG sửa file, KHÔNG chạy shell, KHÔNG tạo task/bot mới. ' +
      'Thu thập thông tin từ nhiều nguồn, đối chiếu khi nguồn mâu thuẫn, và trả về bản tóm tắt ngắn gọn ' +
      'có ghi nguồn (tên file/URL) cho từng khẳng định quan trọng. Nếu không tìm thấy thông tin thì nói rõ là không tìm thấy, không bịa.',
    tools: [
      'web_search',
      'web_fetch',
      'http_get',
      'x_search',
      'read_file',
      'list_files',
      'glob_files',
      'grep_search',
      'semantic_search',
      'memory_recall',
      'search_conversations',
      'read_agent_transcript',
      'git_status',
      'git_diff',
      'mcp_read_resource',
      'mcp_list_resources',
    ],
    allowShell: false,
    readOnly: true,
    maxSteps: 15,
    timeoutMs: 120_000,
    source: 'builtin',
  },
  {
    id: 'coder',
    description:
      'Viết/sửa code theo yêu cầu: được đọc, ghi file và chạy shell/test. Không tự ý đổi phạm vi ngoài yêu cầu.',
    systemPrompt:
      'Bạn là coder — chuyên gia viết và sửa code. ' +
      'Được đọc file, ghi/sửa file và chạy shell (kể cả chạy test/lint/typecheck) để hoàn thành đúng yêu cầu được giao. ' +
      'Chỉ sửa trong phạm vi yêu cầu, giữ đúng style của codebase, và SAU MỖI lần sửa phải chạy test/typecheck liên quan để chứng minh code chạy được. ' +
      'Trả về tóm tắt ngắn: đã đổi file nào, chạy test nào, kết quả ra sao. Không tự ý làm thêm tính năng ngoài yêu cầu.',
    tools: [
      'read_file',
      'list_files',
      'glob_files',
      'grep_search',
      'semantic_search',
      'code_diagnostics',
      'write_file',
      'apply_diff',
      'delete_file',
      'shell_exec',
      'shell_session_start',
      'shell_session_write',
      'shell_session_read',
      'shell_session_close',
      'exec_task',
      'exec_task_status',
      'git_status',
      'git_diff',
      'git_blame',
      'task_list',
      'memory_recall',
    ],
    allowShell: true,
    readOnly: false,
    maxSteps: 25,
    timeoutMs: 180_000,
    source: 'builtin',
  },
  {
    id: 'reviewer',
    description:
      'Soát code/kế hoạch: chỉ đọc, không sửa, không chạy shell. Trả về nhận xét + kết luận đạt/không đạt.',
    systemPrompt:
      'Bạn là reviewer — chuyên gia soát xét code và kế hoạch. ' +
      'CHỈ ĐỌC: không sửa file, không chạy shell, không tạo task hay đổi trạng thái gì. ' +
      'Soát kỹ: lỗi logic, lỗi biên (edge case), bảo mật (secret, injection, đường dẫn ngoài workspace), ' +
      'và chỗ làm trái quy ước repo. Trả về danh sách finding có mức độ (nghiêm trọng/trung bình/nhỏ) kèm file:dòng, ' +
      'rồi kết luận cuối cùng rõ ràng: ĐẠT hoặc KHÔNG ĐẠT + lý do. Không viết lại code, chỉ nhận xét.',
    tools: [
      'read_file',
      'list_files',
      'glob_files',
      'grep_search',
      'semantic_search',
      'code_diagnostics',
      'git_status',
      'git_diff',
      'git_blame',
      'pr_list',
      'pr_code_tour_view',
      'ci_investigate',
      'memory_recall',
      'search_conversations',
    ],
    allowShell: false,
    readOnly: true,
    maxSteps: 10,
    timeoutMs: 120_000,
    source: 'builtin',
  },
  {
    id: 'planner',
    description:
      'Lập kế hoạch: chỉ đọc và soạn plan (plan_create/plan_update), không sửa code, không chạy shell.',
    systemPrompt:
      'Bạn là planner — chuyên gia lập kế hoạch. ' +
      'Chỉ đọc codebase/tài liệu và soạn plan (tạo/cập nhật plan): KHÔNG sửa code, KHÔNG chạy shell. ' +
      'Plan phải chia thành bước nhỏ, mỗi bước ghi rõ: làm gì, file nào, kiểm chứng bằng gì (lệnh test/typecheck), ' +
      'và những lựa chọn cần người quyết thì liệt kê riêng để hỏi, không tự quyết thay. ' +
      'Trả về plan ngắn gọn, khả thi, không vẽ thêm tính năng ngoài yêu cầu.',
    tools: [
      'read_file',
      'list_files',
      'glob_files',
      'grep_search',
      'semantic_search',
      'code_diagnostics',
      'git_status',
      'git_diff',
      'task_list',
      'project_list',
      'goal_list',
      'plan_create',
      'plan_update',
      'memory_recall',
      'search_conversations',
    ],
    allowShell: false,
    readOnly: true,
    maxSteps: 12,
    timeoutMs: 120_000,
    source: 'builtin',
  },
  {
    id: 'tester',
    description:
      'Chạy kiểm thử: được đọc code và chạy shell/test, nhưng không sửa file. Trả về kết quả pass/fail từng test.',
    systemPrompt:
      'Bạn là tester — chuyên gia kiểm thử. ' +
      'Được đọc code và chạy shell/test để kiểm chứng, nhưng KHÔNG được sửa file (kể cả sửa test để cho pass). ' +
      'Chạy đúng test liên quan tới thay đổi, ghi lại kết quả từng test (pass/fail + log lỗi ngắn), ' +
      'và kết luận: PASS (mọi test liên quan xanh) hoặc FAIL kèm lỗi cụ thể cần sửa. ' +
      'Nếu test fail vì môi trường (thiếu tool, thiếu mạng) thì nói rõ là lỗi môi trường, không đổ cho code.',
    tools: [
      'read_file',
      'list_files',
      'glob_files',
      'grep_search',
      'semantic_search',
      'code_diagnostics',
      'shell_exec',
      'shell_session_start',
      'shell_session_write',
      'shell_session_read',
      'shell_session_close',
      'exec_task',
      'exec_task_status',
      'git_status',
      'git_diff',
      'ci_investigate',
      'task_list',
    ],
    allowShell: true,
    readOnly: false,
    maxSteps: 20,
    timeoutMs: 180_000,
    source: 'builtin',
  },
];

// ---------------------------------------------------------------------------
// Lỗi rõ ràng (không fallback lặng lẽ)
// ---------------------------------------------------------------------------

export class UnknownSubagentRoleError extends Error {
  readonly roleId: string;
  readonly availableRoleIds: string[];
  constructor(roleId: string, availableRoleIds: string[]) {
    super(
      `Role subagent "${roleId}" không tồn tại. ` +
        `Role có sẵn: ${availableRoleIds.length > 0 ? availableRoleIds.join(', ') : '(không có role nào)'}. ` +
        `Dùng tool list_subagent_roles để xem danh sách role.`,
    );
    this.name = 'UnknownSubagentRoleError';
    this.roleId = roleId;
    this.availableRoleIds = [...availableRoleIds];
  }
}

export class EmptyRoleToolsError extends Error {
  readonly roleId: string;
  constructor(roleId: string) {
    super(
      `Role subagent "${roleId}" không còn tool nào sau khi giao với tool bot cha cho phép — ` +
        `bot cha đã bị giới hạn (allowlist/mode) nên không cấp được tool nào role cần. ` +
        `Nới allowlist của bot cha hoặc chọn role khác.`,
    );
    this.name = 'EmptyRoleToolsError';
    this.roleId = roleId;
  }
}

// ---------------------------------------------------------------------------
// Validate role (dùng cho cả built-in lẫn custom từ file)
// ---------------------------------------------------------------------------

const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Kiểm tra một role thô (vd parse từ JSON); ném lỗi tiếng Việt rõ khi sai. */
export function validateRole(raw: unknown, source: SubagentRoleSource = 'custom'): SubagentRole {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Role subagent phải là một object JSON { id, description, systemPrompt, ... }.');
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
  if (!ROLE_ID_RE.test(id)) {
    throw new Error(
      `Role id không hợp lệ: ${JSON.stringify(r['id'])} — dùng chữ thường, số, gạch ngang, bắt đầu bằng chữ cái (tối đa 64 ký tự).`,
    );
  }
  const description = typeof r['description'] === 'string' ? r['description'].trim() : '';
  if (!description) throw new Error(`Role "${id}" cần description không rỗng.`);
  const systemPrompt = typeof r['systemPrompt'] === 'string' ? r['systemPrompt'].trim() : '';
  if (!systemPrompt) throw new Error(`Role "${id}" cần systemPrompt không rỗng.`);
  let tools: string[] | undefined;
  if (r['tools'] !== undefined) {
    if (!Array.isArray(r['tools']) || r['tools'].some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error(`Role "${id}": "tools" phải là mảng tên tool (string không rỗng).`);
    }
    tools = [...new Set((r['tools'] as string[]).map((t) => t.trim()))];
  }
  if (r['allowShell'] !== undefined && typeof r['allowShell'] !== 'boolean') {
    throw new Error(`Role "${id}": "allowShell" phải là boolean.`);
  }
  if (r['readOnly'] !== undefined && typeof r['readOnly'] !== 'boolean') {
    throw new Error(`Role "${id}": "readOnly" phải là boolean.`);
  }
  if (
    r['maxSteps'] !== undefined &&
    (typeof r['maxSteps'] !== 'number' || !Number.isFinite(r['maxSteps']) || r['maxSteps'] <= 0)
  ) {
    throw new Error(`Role "${id}": "maxSteps" phải là số > 0.`);
  }
  if (
    r['timeoutMs'] !== undefined &&
    (typeof r['timeoutMs'] !== 'number' || !Number.isFinite(r['timeoutMs']) || r['timeoutMs'] <= 0)
  ) {
    throw new Error(`Role "${id}": "timeoutMs" phải là số > 0 (ms).`);
  }
  if (r['suggestedModel'] !== undefined && typeof r['suggestedModel'] !== 'string') {
    throw new Error(`Role "${id}": "suggestedModel" phải là string.`);
  }
  return {
    id,
    description,
    systemPrompt,
    ...(tools !== undefined ? { tools } : {}),
    ...(r['allowShell'] !== undefined ? { allowShell: r['allowShell'] as boolean } : {}),
    ...(r['readOnly'] !== undefined ? { readOnly: r['readOnly'] as boolean } : {}),
    ...(r['maxSteps'] !== undefined ? { maxSteps: Math.floor(r['maxSteps'] as number) } : {}),
    ...(r['timeoutMs'] !== undefined ? { timeoutMs: Math.floor(r['timeoutMs'] as number) } : {}),
    ...(typeof r['suggestedModel'] === 'string' && r['suggestedModel'].trim()
      ? { suggestedModel: (r['suggestedModel'] as string).trim() }
      : {}),
    source,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ResolvedRoleOptions {
  /** Role đã resolve (để caller ghi log / đặt tên subagent). */
  role: SubagentRole;
  /** Instructions cuối cho con: systemPrompt role + instructions gọi trực tiếp (nếu có). */
  instructions: string;
  /**
   * Tool con được dùng — ĐÃ giao với tool cha (undefined = không giới
   * hạn thêm, con kế thừa toàn bộ tool cha như subagent thường).
   */
  tools?: string[];
  /** Tool role xin mà cha không có (rơi khỏi danh sách) — để debug. */
  unavailableTools: string[];
  /** Model con: gọi trực tiếp > suggestedModel của role > undefined (= model cha). */
  model?: string;
  /** maxSteps con: gọi trực tiếp > role > undefined (= maxSteps cha). */
  maxSteps?: number;
  /** timeoutMs con: gọi trực tiếp > role > undefined (= mặc định runSubagent). */
  timeoutMs?: number;
}

export interface RoleCallOverrides {
  /** Tool gọi trực tiếp cho phép thêm — cũng bị giao với role + tool cha. */
  tools?: string[];
  /** Model gọi trực tiếp (thắng suggestedModel của role). */
  model?: string;
  /** maxSteps gọi trực tiếp (thắng role). */
  maxSteps?: number;
  /** timeoutMs gọi trực tiếp (thắng role). */
  timeoutMs?: number;
  /** Instructions thêm của caller — nối sau systemPrompt của role. */
  instructions?: string;
}

function intersectInOrder(want: readonly string[], have: readonly string[]): string[] {
  const haveSet = new Set(have);
  return [...new Set(want)].filter((t) => haveSet.has(t));
}

export class SubagentRoleRegistry {
  private readonly roles = new Map<string, SubagentRole>();

  /**
   * @param customRoles role custom (đã validate hoặc thô — constructor
   *   validate lại). Id custom trùng built-in thì THROW (không cho
   *   shadow role built-in lặng lẽ — muốn đổi hành vi thì sửa role
   *   built-in trong code, không ghi đè bằng file).
   */
  constructor(customRoles: readonly unknown[] = []) {
    for (const role of BUILTIN_ROLES) this.roles.set(role.id, role);
    for (const raw of customRoles) {
      const role = validateRole(raw, 'custom');
      if (this.roles.has(role.id)) {
        throw new Error(
          `Role custom "${role.id}" trùng id với role có sẵn — không cho ghi đè role built-in bằng file. Đặt id khác.`,
        );
      }
      this.roles.set(role.id, role);
    }
  }

  list(): SubagentRole[] {
    return [...this.roles.values()];
  }

  listSummaries(): SubagentRoleSummary[] {
    return this.list().map(describeRole);
  }

  has(id: string): boolean {
    return this.roles.has(id);
  }

  get(id: string): SubagentRole | undefined {
    return this.roles.get(id);
  }

  /** Lấy role theo id; không có thì throw UnknownSubagentRoleError. */
  resolve(id: string): SubagentRole {
    const role = this.roles.get(id);
    if (!role) throw new UnknownSubagentRoleError(id, [...this.roles.keys()]);
    return role;
  }

  /**
   * Resolve role thành options chạy subagent, giao tool với tool cha.
   * @param parentToolNames tên tool runner cha đang có (toolsList).
   * @param overrides tuỳ chọn gọi trực tiếp (cũng chỉ thu hẹp thêm).
   */
  resolveRoleOptions(
    roleId: string,
    parentToolNames: readonly string[],
    overrides: RoleCallOverrides = {},
  ): ResolvedRoleOptions {
    const role = this.resolve(roleId);
    const parent = [...new Set(parentToolNames)];
    const unavailableTools =
      role.tools !== undefined
        ? [...new Set(role.tools)].filter((t) => !parent.includes(t))
        : [];
    // Giao 1: role ∩ cha. Không giới hạn role (tools undefined) = toàn bộ tool cha.
    let tools: string[] | undefined =
      role.tools !== undefined ? intersectInOrder(role.tools, parent) : undefined;
    // Giao 2: gọi trực tiếp chỉ thu hẹp thêm.
    if (overrides.tools !== undefined) {
      const base = tools ?? parent;
      tools = intersectInOrder(overrides.tools, base);
    }
    // Lớp an ninh: readOnly giao thêm với READ_ONLY_TOOLS; cấm shell loại
    // mọi tool shell (kể cả khi role/gọi trực tiếp có khai).
    if (tools !== undefined) {
      if (role.readOnly === true) tools = tools.filter((t) => READ_ONLY_TOOLS.has(t));
      if (role.allowShell === false) tools = tools.filter((t) => !SHELL_TOOL_NAMES.has(t));
    } else if (role.readOnly === true || role.allowShell === false) {
      // Role không giới hạn tool nhưng có giới hạn an ninh → phải tính
      // danh sách cụ thể, không thể để undefined (undefined = toàn bộ).
      tools = parent.filter((t) => {
        if (role.readOnly === true && !READ_ONLY_TOOLS.has(t)) return false;
        if (role.allowShell === false && SHELL_TOOL_NAMES.has(t)) return false;
        return true;
      });
    }
    // Role xin tool cụ thể mà giao xong còn rỗng = cấu hình không chạy
    // được (cha không cấp được gì) → lỗi rõ, không spawn con tay trắng.
    if (role.tools !== undefined && role.tools.length > 0 && (tools?.length ?? 0) === 0) {
      throw new EmptyRoleToolsError(roleId);
    }
    const instructions = [role.systemPrompt, overrides.instructions?.trim()]
      .filter((s): s is string => Boolean(s && s.length > 0))
      .join('\n\n');
    return {
      role,
      instructions,
      ...(tools !== undefined ? { tools } : {}),
      unavailableTools,
      ...(overrides.model ?? role.suggestedModel
        ? { model: overrides.model ?? role.suggestedModel }
        : {}),
      ...(overrides.maxSteps ?? role.maxSteps
        ? { maxSteps: overrides.maxSteps ?? role.maxSteps }
        : {}),
      ...(overrides.timeoutMs ?? role.timeoutMs
        ? { timeoutMs: overrides.timeoutMs ?? role.timeoutMs }
        : {}),
    };
  }
}

/** Registry chỉ role built-in (mặc định khi host không truyền custom). */
export const DEFAULT_ROLE_REGISTRY = new SubagentRoleRegistry();

/** Tạo registry từ role custom (vd load từ file) + built-in. */
export function createRoleRegistry(customRoles: readonly unknown[] = []): SubagentRoleRegistry {
  return new SubagentRoleRegistry(customRoles);
}

// ---------------------------------------------------------------------------
// Load role custom từ file / thư mục JSON (local config)
// ---------------------------------------------------------------------------

export interface LoadedRoles {
  roles: SubagentRole[];
  /** Lỗi từng file (file hỏng không kéo sập các file khác). */
  errors: string[];
}

/** Parse nội dung JSON: một role, mảng role, hoặc `{ "roles": [...] }`. */
export function parseRolesJson(text: string, sourceLabel: string): SubagentRole[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`File role ${sourceLabel} không phải JSON hợp lệ: ${(err as Error).message}`);
  }
  const raws: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['roles'])
      ? ((parsed as Record<string, unknown>)['roles'] as unknown[])
      : [parsed];
  if (raws.length === 0) throw new Error(`File role ${sourceLabel} không chứa role nào.`);
  return raws.map((raw) => validateRole(raw, 'custom'));
}

/** Đọc role custom từ một file JSON. File không tồn tại → lỗi rõ. */
export function loadRolesFromFile(filePath: string): SubagentRole[] {
  const abs = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`Không đọc được file role ${abs} — kiểm tra đường dẫn.`);
  }
  return parseRolesJson(text, abs);
}

/**
 * Đọc role custom từ một thư mục: mỗi file `*.json` là một role (hoặc
 * nhiều role). Thư mục không tồn tại = không có role custom (không lỗi).
 * File hỏng chỉ ghi vào `errors`, các file khác vẫn load.
 */
export function loadRolesFromDir(dirPath: string): LoadedRoles {
  const abs = path.resolve(dirPath);
  if (!fs.existsSync(abs)) return { roles: [], errors: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (err) {
    return { roles: [], errors: [`Không đọc được thư mục role ${abs}: ${(err as Error).message}`] };
  }
  const roles: SubagentRole[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const file of entries.sort()) {
    const full = path.join(abs, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
      for (const role of loadRolesFromFile(full)) {
        if (seen.has(role.id)) {
          errors.push(`File ${full}: role "${role.id}" trùng id với file trước — bỏ qua role này.`);
          continue;
        }
        seen.add(role.id);
        roles.push(role);
      }
    } catch (err) {
      errors.push(`File ${full}: ${(err as Error).message}`);
    }
  }
  return { roles, errors };
}
