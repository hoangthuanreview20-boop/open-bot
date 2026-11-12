/**
 * Context-aware tool filtering + grouping (v0.10a, P0-4).
 *
 * Vấn đề: `defaultToolFactory` dựng 119 tool và AgentRunner gửi toàn bộ
 * definitions cho model mỗi request (~5.500 token theo ARCHITECTURE.md;
 * ước lượng ký tự/4 ở đây còn cho số lớn hơn). Model local context
 * 4.096 token sẽ lỗi 400. Module này là API lọc thuần (pure, không I/O,
 * không sửa loop/coordinator): điều phối viên sẽ gọi `filterTools` mỗi
 * turn rồi truyền list đã lọc vào `AgentRunner` qua constructor.
 *
 * Ba lớp lọc (áp dụng theo thứ tự, một tool phải qua hết mới được giữ):
 *  1. Bot allowlist — `AgentPermissions` / `BotToolPolicy` (deny thắng).
 *  2. Skill đang bật — hợp (union) `tools` / `allowedTools` của các skill;
 *     skill không khai tool nào thì không đóng góp gì (chỉ là hướng dẫn).
 *  3. Mode — `plan` / `review` chỉ giữ tool chỉ-đọc (`READ_ONLY_TOOLS`).
 *
 * Ngoại lệ duy nhất: `ESSENTIAL_TOOLS` (giao tiếp với user: `ask_user`,
 * `send_*`) luôn được giữ qua lớp skill và lớp mode — nếu không agent
 * mất khả năng hỏi user và trả lời cuối. Allowlist/denylist của bot là
 * ranh giới an ninh nên KHÔNG có ngoại lệ này: bot bị cấm `ask_user`
 * thì `ask_user` bị lọc thật.
 *
 * Gom nhóm (`groupTools`): các tool cùng nhóm (vd `file`: `read_file`,
 * `write_file`, `delete_file`, ...) gộp thành MỘT tool điều phối có tên
 * là tên nhóm, gọi bằng `{ operation: "<tên tool gốc>", args: {...} }`
 * và dispatch về tool gốc trong `execute()`. Nhóm chỉ gộp khi có từ
 * `minGroupSize` (mặc định 2) thành viên; tool lẻ giữ nguyên.
 *
 * Ước lượng token: `estimateToolDefinitionTokens` dùng `estimateTokens`
 * (heuristic theo từ/CJK/code, `agent/tokens.ts`) thay cho chars/4 cũ —
 * sát hơn với tool definition JSON (nhiều tên snake_case + mô tả tiếng
 * Anh). Dùng để đo trước/sau khi lọc, không phải số token thật của
 * tokenizer từng provider.
 */

import type { BotConfig, Tool, ToolDefinition } from '../types';
import type { AgentMode } from './coordination';
import type { AgentPermissions, BotToolPolicy } from './permissions';
import { isToolAllowedFor } from './permissions';
import { estimateTokens } from './tokens';
import type { Skill } from '../skills/types';

/** Skill đang bật: dùng field `tools` (format hiện tại) hoặc `allowedTools` (chuẩn agentskills.io `allowed-tools`). */
export type ActiveSkillInput = Pick<Skill, 'name' | 'tools'> & { allowedTools?: string[] };

export interface ToolFilterOptions {
  /** Bot (config hoặc id). Dùng với `permissions`/`policy` để lọc allowlist. */
  bot?: BotConfig | string;
  /** Allowlist/denylist theo bot. Khi có cả `permissions` và `policy`, `policy` thắng. */
  permissions?: AgentPermissions;
  /** Policy trực tiếp (không cần AgentPermissions instance). */
  policy?: BotToolPolicy;
  /** Mode làm việc: `plan`/`review` chỉ giữ tool chỉ-đọc. */
  mode?: AgentMode;
  /** Skill đang bật: chỉ giữ tool trong hợp `tools`/`allowedTools` của chúng (+ ESSENTIAL_TOOLS). */
  activeSkills?: ActiveSkillInput[];
  /** Allowlist trực tiếp thêm vào (giao với các lớp khác, + ESSENTIAL_TOOLS). */
  allowedTools?: string[];
}

/**
 * Tool giao tiếp tối thiểu — luôn được giữ qua lớp skill và lớp mode để
 * agent còn hỏi user và trả lời cuối. Không miễn qua lớp bot policy.
 */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'send_message_to_user',
  'send_progress_update',
  'send_final_summary',
]);

/**
 * Tool chỉ-đọc (không đổi file/shell/git-remote, không gửi tin, không tạo
 * bot/task mới). Danh sách tường minh, fail-closed: tool không có trong
 * này (kể cả tool plugin/MCP động chưa biết) bị loại ở plan/review mode.
 * Đối chiếu với `SUGGESTED_CACHEABLE_TOOLS` (perf/cache.ts) + 119 tool
 * thật từ `defaultToolFactory` (đếm ngày 2026-11-09).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Đọc file / code.
  'read_file',
  'list_files',
  'glob_files',
  'grep_search',
  'semantic_search',
  'code_diagnostics',
  // Đọc git (không commit / không đổi branch).
  'git_status',
  'git_diff',
  'git_blame',
  // Đọc web.
  'web_search',
  'web_fetch',
  'http_get',
  'x_search',
  // Đọc plan/task/goal/todo/project.
  'task_list',
  'goal_list',
  'todo_list',
  'project_list',
  // Plan mode: tạo/duyệt plan — chỉ ghi file plan nháp + ghi quyết định
  // duyệt, không thực thi bước nào, nên được giữ ở plan mode.
  'plan_create',
  'plan_update',
  // Trạng thái agent / subagent.
  'agent_status',
  'grind_status',
  'exec_task_status',
  'shell_session_read',
  // Đọc MCP (không gọi tool MCP ngoài).
  'mcp_list_servers',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_auth_status',
  // Quan sát hệ thống / màn hình.
  'system_info',
  'list_processes',
  'computer_screenshot',
  // Đọc canvas / dữ liệu.
  'canvas_read',
  'canvas_list',
  'session_box_list',
  // Đọc / tra cứu tri thức.
  'reflect',
  'search_conversations',
  'read_agent_transcript',
  'memory_recall',
  'team_context_summary',
  'transcript_archive',
  // Đọc tích hợp ngoài.
  'pr_list',
  'pr_code_tour_view',
  'ci_investigate',
  'slack_list_channels',
  'slack_read',
  'email_read',
  'teams_list_teams',
  'meeting_transcript',
  'meeting_summarize',
  // Chờ điều kiện: không đổi trạng thái, chỉ đợi.
  'await_condition',
]);

/** True khi tool này được phép chạy ở plan/review mode (chỉ-đọc). */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

function normalizeNames(names: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of names ?? []) {
    const t = n.trim();
    if (t) out.add(t);
  }
  return out;
}

function botIdOf(bot: BotConfig | string | undefined): string | undefined {
  if (!bot) return undefined;
  return typeof bot === 'string' ? bot : bot.id;
}

/** Predicate lọc theo TÊN tool — dùng chung cho Tool[] và ToolDefinition[]. */
export function makeToolNameFilter(options: ToolFilterOptions = {}): (toolName: string) => boolean {
  const botId = botIdOf(options.bot);
  const policy: BotToolPolicy | undefined =
    options.policy ??
    (options.permissions && botId ? options.permissions.getBotPolicy(botId) : undefined);
  let skillTools: Set<string> | null = null;
  if (options.activeSkills && options.activeSkills.length > 0) {
    const union = new Set<string>();
    for (const skill of options.activeSkills) {
      for (const name of normalizeNames(skill.tools)) union.add(name);
      for (const name of normalizeNames(skill.allowedTools)) union.add(name);
    }
    // Skill không khai tool nào thì không đóng góp — chỉ áp filter khi
    // hợp khác rỗng (nếu không mọi skill "hướng dẫn thuần" sẽ xoá hết tool).
    if (union.size > 0) skillTools = union;
  }
  const extra = options.allowedTools?.length ? normalizeNames(options.allowedTools) : null;
  const readOnlyOnly = options.mode === 'plan' || options.mode === 'review';
  return (toolName: string): boolean => {
    // 1. Bot allowlist/denylist — ranh giới an ninh, không ngoại lệ.
    if (policy && !isToolAllowedFor(policy, toolName)) return false;
    // 2. Skill đang bật (giữ lại ESSENTIAL_TOOLS).
    if (skillTools && !skillTools.has(toolName) && !ESSENTIAL_TOOLS.has(toolName)) return false;
    // 2b. Allowlist trực tiếp (giữ lại ESSENTIAL_TOOLS).
    if (extra && !extra.has(toolName) && !ESSENTIAL_TOOLS.has(toolName)) return false;
    // 3. Plan/review mode: chỉ tool chỉ-đọc (giữ lại ESSENTIAL_TOOLS).
    if (readOnlyOnly && !isReadOnlyTool(toolName) && !ESSENTIAL_TOOLS.has(toolName)) return false;
    return true;
  };
}

/**
 * Lọc tool theo ngữ cảnh (bot allowlist, skill đang bật, mode).
 * Không options = trả bản sao y nguyên (không lọc gì).
 */
export function filterTools(tools: Tool[], options: ToolFilterOptions = {}): Tool[] {
  const keep = makeToolNameFilter(options);
  return tools.filter((t) => keep(t.definition.name));
}

/** Như `filterTools` nhưng trên definitions (cho phía provider, không cần Tool đầy đủ). */
export function filterToolDefinitions(
  definitions: ToolDefinition[],
  options: ToolFilterOptions = {},
): ToolDefinition[] {
  const keep = makeToolNameFilter(options);
  return definitions.filter((d) => keep(d.name));
}

// ---------------------------------------------------------------------------
// Lọc / tìm kiếm danh sách tool đã liệt kê (v0.59, UI-3)
// ---------------------------------------------------------------------------

/** Đầu vào tối thiểu cho `filterToolList` — khớp `BotToolInfo` (coordinator/types.ts). */
export interface ToolListItem {
  name: string;
  description: string;
  group: string;
  enabled: boolean;
}

export interface ToolListFilterOptions {
  /** Chuỗi tìm kiếm: khớp tên / mô tả / nhóm, không phân biệt hoa-thường; nhiều từ thì phải khớp hết (AND). */
  query?: string;
  /** Chỉ giữ đúng nhóm này (`toolGroupFor`); null/undefined = mọi nhóm. */
  group?: string | null;
  /** True = chỉ tool đang bật. */
  enabledOnly?: boolean;
}

/**
 * v0.59 (UI-3): lọc + tìm kiếm danh sách tool đã liệt kê cho màn
 * Tools — pure, không I/O, dùng chung cho test node và (qua bản sao
 * gọn trong renderer — renderer không import core) cho UI. Giữ thứ tự
 * đầu vào; query rỗng = không lọc theo query.
 */
export function filterToolList<T extends ToolListItem>(
  tools: T[],
  options: ToolListFilterOptions = {},
): T[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const words = query.length > 0 ? query.split(/\s+/) : [];
  const group = options.group ?? null;
  return tools.filter((t) => {
    if (group !== null && t.group !== group) return false;
    if (options.enabledOnly && !t.enabled) return false;
    if (words.length === 0) return true;
    const haystack = `${t.name} ${t.description} ${t.group}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

// ---------------------------------------------------------------------------
// Ước lượng token
// ---------------------------------------------------------------------------

/** Ước lượng token của MỘT tool definition: ceil(chars(JSON)/4), tối thiểu 1. */
export function estimateToolDefinitionTokens(definition: ToolDefinition): number {
  return Math.max(1, estimateTokens(JSON.stringify(definition)));
}

/** Tổng token ước lượng của một list Tool hoặc ToolDefinition. */
export function estimateToolsTokens(tools: Array<Tool | ToolDefinition>): number {
  let total = 0;
  for (const item of tools) {
    const def = 'definition' in item ? (item as Tool).definition : (item as ToolDefinition);
    total += estimateToolDefinitionTokens(def);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Gom nhóm
// ---------------------------------------------------------------------------

/** Tên tool → tên nhóm, cho những tool không suy ra được từ prefix. */
const EXPLICIT_GROUPS: Readonly<Record<string, string>> = {
  // file.* (vd trong BEYOND-ROADMAP).
  read_file: 'file',
  write_file: 'file',
  delete_file: 'file',
  list_files: 'file',
  glob_files: 'file',
  apply_diff: 'file',
  // code search/diagnostics.
  grep_search: 'code',
  semantic_search: 'code',
  code_diagnostics: 'code',
  // web.
  x_search: 'web',
  // git / PR.
  set_active_branch: 'git',
  // agent.
  reflect: 'agent',
  search_conversations: 'agent',
  read_agent_transcript: 'agent',
  // giao tiếp.
  ask_user: 'comms',
  await_condition: 'comms',
  // ci / bug.
  ci_investigate: 'ci',
  bug_report: 'ci',
  bug_fix_report: 'ci',
  ai_attribution: 'ci',
  // dữ liệu agent.
  agent_export: 'data',
  agent_import: 'data',
  team_context_summary: 'data',
  transcript_archive: 'data',
  // hệ thống.
  sandbox_prepare: 'system',
  system_info: 'system',
  list_processes: 'system',
  kill_process: 'system',
  open_path: 'system',
};

/** Prefix → tên nhóm, thử theo thứ tự (prefix dài trước). */
const PREFIX_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['shell_session_', 'shell'],
  ['shell_', 'shell'],
  ['exec_task', 'shell'],
  ['session_box_', 'session'],
  ['computer_', 'computer'],
  ['mcp_', 'mcp'],
  ['git_', 'git'],
  ['pr_', 'git'],
  ['plan_', 'plan'],
  ['task_', 'plan'],
  ['goal_', 'plan'],
  ['todo_', 'plan'],
  ['project_', 'plan'],
  ['grind_', 'plan'],
  ['web_', 'web'],
  ['http_', 'web'],
  ['canvas_', 'canvas'],
  ['slack_', 'slack'],
  ['email_', 'email'],
  ['teams_', 'teams'],
  ['meeting_', 'meeting'],
  ['memory_', 'memory'],
  ['create_agent', 'agent'],
  ['message_agent', 'agent'],
  ['set_agent_mode', 'agent'],
  ['delegate_task', 'agent'],
  ['agent_', 'agent'],
  ['stop_agent', 'agent'],
  ['send_', 'comms'],
  ['image_', 'media'],
  ['video_', 'media'],
];

/** Nhóm của một tool theo tên. Fallback: đoạn đầu tiên trước `_` (vd `foo_bar` → `foo`). */
export function toolGroupFor(toolName: string): string {
  const explicit = EXPLICIT_GROUPS[toolName];
  if (explicit) return explicit;
  for (const [prefix, group] of PREFIX_GROUPS) {
    if (toolName.startsWith(prefix)) return group;
  }
  return toolName.split('_')[0] ?? toolName;
}

export interface ToolGroup {
  name: string;
  members: Tool[];
}

/** Gom tool theo nhóm (giữ thứ tự xuất hiện đầu tiên của mỗi nhóm). */
export function getToolGroups(tools: Tool[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  const byName = new Map<string, ToolGroup>();
  for (const tool of tools) {
    const name = toolGroupFor(tool.definition.name);
    let group = byName.get(name);
    if (!group) {
      group = { name, members: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.members.push(tool);
  }
  return groups;
}

export interface GroupToolsOptions {
  /** Số thành viên tối thiểu để gộp thành tool điều phối (mặc định 2). */
  minGroupSize?: number;
}

function makeGroupDispatcher(group: ToolGroup, takenNames: Set<string>): Tool {
  const members = new Map(group.members.map((t) => [t.definition.name, t]));
  // Tránh đụng tên tool đã có: vd đã có tool tên `file` thì điều phối là `file_group`.
  let name = group.name;
  if (takenNames.has(name)) name = `${group.name}_group`;
  const memberNames = group.members.map((t) => t.definition.name);
  const needsApproval = group.members.some((t) => t.needsApproval);
  return {
    definition: {
      name,
      description:
        `Nhóm tool "${group.name}" — gọi MỘT tool điều phối thay cho ${memberNames.length} tool riêng. ` +
        `Gọi với operation=<tên tool gốc> và args=<tham số của tool đó>. ` +
        `Thành viên: ${memberNames.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: memberNames,
            description: `Tool gốc trong nhóm "${group.name}".`,
          },
          args: {
            type: 'object',
            description: 'Tham số của tool gốc (xem mô tả từng tool).',
            additionalProperties: true,
          },
        },
        required: ['operation', 'args'],
      },
    },
    // Fail-closed: nhóm hỏi phê duyệt khi BẤT KỲ thành viên nào cần duyệt.
    needsApproval,
    async execute(args: Record<string, unknown>, ctx): Promise<string> {
      const operation = args['operation'];
      if (typeof operation !== 'string' || !members.has(operation)) {
        throw new Error(
          `Nhóm "${group.name}": operation phải là một trong: ${memberNames.join(', ')}.`,
        );
      }
      const inner = args['args'];
      const innerArgs =
        inner !== undefined && typeof inner === 'object' && !Array.isArray(inner)
          ? (inner as Record<string, unknown>)
          : {};
      return members.get(operation)!.execute(innerArgs, ctx);
    },
  };
}

/**
 * Gom tool theo nhóm: nhóm đủ `minGroupSize` thành viên thành MỘT tool
 * điều phối, tool lẻ giữ nguyên. Thứ tự: nhóm xuất hiện ở vị trí thành
 * viên đầu tiên của nó; tool lẻ giữ vị trí cũ.
 */
export function groupTools(tools: Tool[], options: GroupToolsOptions = {}): Tool[] {
  const minGroupSize = Math.max(2, Math.floor(options.minGroupSize ?? 2));
  const takenNames = new Set(tools.map((t) => t.definition.name));
  const groups = getToolGroups(tools);
  const out: Tool[] = [];
  const emitted = new Set<ToolGroup>();
  for (const tool of tools) {
    const group = groups.find((g) => g.members.includes(tool));
    if (!group || emitted.has(group)) continue;
    emitted.add(group);
    // Tool trùng tên nhóm (vd tool tên `file` trong nhóm `file`) KHÔNG
    // được nuốt vào điều phối — giữ nguyên, điều phối lấy tên `<nhóm>_group`.
    const selfNamed = group.members.filter((t) => t.definition.name === group.name);
    const rest = group.members.filter((t) => t.definition.name !== group.name);
    out.push(...selfNamed);
    if (rest.length >= minGroupSize) {
      out.push(makeGroupDispatcher({ name: group.name, members: rest }, takenNames));
    } else {
      out.push(...rest);
    }
  }
  return out;
}

/** Definitions của list đã gom nhóm (để đo token khi chưa có Tool đầy đủ). */
export function groupToolDefinitions(definitions: ToolDefinition[]): ToolDefinition[] {
  const stubs: Tool[] = definitions.map((d) => ({
    definition: d,
    needsApproval: false,
    execute: async () => {
      throw new Error('groupToolDefinitions chỉ dùng để đo token, không chạy tool.');
    },
  }));
  return groupTools(stubs).map((t) => t.definition);
}
