/**
 * Agent tool permissions for @open-bot/core (v0.6).
 *
 * Per-bot allowlist / denylist + per-tool approval policy. This module
 * is PURE (no I/O, no memory, no provider): the host owns the
 * AgentPermissions instance and decides where policies come from
 * (bot config, team settings, UI).
 *
 * Rules (fail-closed on deny, fail-open otherwise):
 *  - Denylist wins over everything: a denied tool is never allowed,
 *    even if it is also on the allowlist or has an `allow` policy.
 *  - When `allowTools` is non-empty, ONLY those tools are allowed
 *    (allowlist mode). When it is empty/absent, every tool is allowed
 *    except the denylist (default: allow all).
 *  - Approval policy per tool: `allow` (run without asking),
 *    `ask` (ask the user first), `deny` (same as denylist). No entry
 *    → `allow`, EXCEPT a tool on the denylist → `deny`.
 *
 * Wiring (the loop is NOT modified by v0.6 — the coordinator wires
 * this in): before executing a tool call, the loop should call
 * `checkToolCall(botId, toolName)`:
 *   - allowed === false → refuse the call (do not run the tool).
 *   - policy === 'ask'  → run the normal approval flow first
 *     (events.onApprovalNeeded), even when bot.autoApprove is on.
 *   - policy === 'allow' → run as today (approval only when the tool
 *     itself has needsApproval and the bot does not auto-approve).
 *
 * v0.10a: allowlist cũng là filter MẶC ĐỊNH trước khi gửi tool cho model
 * (xem `packages/core/src/agent/toolFilter.ts`): `filterToolsFor` /
 * `AgentPermissions.filterTools` lọc cả list theo đúng luật trên, để
 * model không bao giờ thấy tool bot không được dùng.
 *
 * v0.11c (P1-7): thay `autoApprove` boolean toàn cục bằng 3 mức
 * (`AutoApproveMode` — 'all' | 'safe-only' | 'none'), phân loại theo từng
 * lệnh shell qua rule engine trong `./rules.ts` (whitelist lệnh an toàn
 * chạy ngay, lệnh nhạy cảm luôn hỏi, còn lại theo policy bot). Backward
 * compatible: `autoApprove: true` → 'all' (chạy như trước), `false` →
 * 'none', không set → 'safe-only' (mặc định mới). `checkToolCall` nhận
 * thêm `args` (để thấy `command` của tool shell) và `opts.workspaceDir`
 * (để phát hiện ghi file ra ngoài workspace); gọi không có `args` thì
 * hành vi y hệt cũ — loop hiện tại gọi 2 tham số nên không đổi gì.
 */

import type { Tool } from '../types';
import { classifyCommand } from './rules';

export type ApprovalPolicy = 'allow' | 'ask' | 'deny';

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['allow', 'ask', 'deny'];

export function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return (APPROVAL_POLICIES as readonly string[]).includes(value);
}

/**
 * v0.11c — 3 mức auto-approve thay cho boolean toàn cục (P1-7):
 *  - 'all': duyệt hết (bot cũ `autoApprove: true`).
 *  - 'safe-only': lệnh trong whitelist an toàn chạy ngay, lệnh nhạy cảm
 *    luôn hỏi, còn lại theo policy bot (mặc định khi không set gì).
 *  - 'none': hỏi hết (bot cũ `autoApprove: false`).
 * 'all' không vượt qua được denylist cứng của sandbox (`rm -rf /`,
 * `curl | sh`…): lệnh `blocked` vẫn bị `checkToolCall` từ chối.
 */
export type AutoApproveMode = 'all' | 'safe-only' | 'none';

export const AUTO_APPROVE_MODES: readonly AutoApproveMode[] = ['all', 'safe-only', 'none'];

export function isAutoApproveMode(value: string): value is AutoApproveMode {
  return (AUTO_APPROVE_MODES as readonly string[]).includes(value);
}

/** Boolean cũ → mode; undefined → mặc định mới 'safe-only'. */
export function resolveAutoApproveMode(value: boolean | AutoApproveMode | undefined): AutoApproveMode {
  if (value === true) return 'all';
  if (value === false) return 'none';
  if (value !== undefined && isAutoApproveMode(value)) return value;
  return 'safe-only';
}

/** Per-bot tool policy, as stored by the host (plain JSON). */
export interface BotToolPolicy {
  /** When non-empty, only these tools may run. Empty/absent = allow all (except denylist). */
  allowTools?: string[];
  /** Tools that may never run for this bot. Wins over allowTools. */
  denyTools?: string[];
  /**
   * v0.64 (skills per-bot): skills that may never load/run for this
   * bot. Wins over everything skill-related: a denied skill is never
   * matched, never injected (tier 1 index / tier 2 body) and never
   * forked for this bot — the coordinator filters per turn (see
   * coordinator `executeRun`), the shared SkillRegistry is never
   * mutated so other bots are unaffected. Empty/absent = allow all
   * (except globally disabled skills).
   */
  denySkills?: string[];
  /** Per-tool approval policy. Missing entry = 'allow' (or 'deny' when denied). */
  policies?: Record<string, ApprovalPolicy>;
  /**
   * v0.11c — mức auto-approve của bot. Boolean cũ vẫn nhận: true → 'all',
   * false → 'none'. Không set → 'safe-only'. Chỉ ảnh hưởng tool call có
   * mang lệnh shell (`args.command`); tool khác theo `policies` như cũ.
   */
  autoApprove?: boolean | AutoApproveMode;
  /** Tiền tố lệnh an toàn bổ sung (cộng thêm vào whitelist mặc định). */
  safeCommands?: string[];
  /** Tiền tố lệnh nhạy cảm bổ sung (cộng thêm vào danh sách mặc định). */
  sensitiveCommands?: string[];
}

export interface ToolCallCheck {
  allowed: boolean;
  policy: ApprovalPolicy;
  /** Human-readable reason, for the refusal / approval prompt. */
  reason: string;
}

const EMPTY_POLICY: BotToolPolicy = {};

function normalizeList(list: string[] | undefined): string[] {
  if (!list) return [];
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Pure check against one bot's policy object (no instance needed). */
export function isToolAllowedFor(policy: BotToolPolicy | undefined, toolName: string): boolean {
  const p = policy ?? EMPTY_POLICY;
  const deny = normalizeList(p.denyTools);
  if (deny.includes(toolName)) return false;
  if (p.policies?.[toolName] === 'deny') return false;
  const allow = normalizeList(p.allowTools);
  if (allow.length > 0 && !allow.includes(toolName)) return false;
  return true;
}

/** Pure approval-policy lookup for one bot's policy object. */
export function approvalPolicyFor(policy: BotToolPolicy | undefined, toolName: string): ApprovalPolicy {
  const p = policy ?? EMPTY_POLICY;
  if (!isToolAllowedFor(p, toolName)) return 'deny';
  const explicit = p.policies?.[toolName];
  return explicit !== undefined && isApprovalPolicy(explicit) ? explicit : 'allow';
}

// ---------------------------------------------------------------------------
// v0.64 (skills per-bot): per-bot skill denylist — same "deny wins"
// posture as tools, but skills have no allowlist / approval policy:
// a skill is either usable for the bot or denied. The coordinator
// filters per turn (tier-1 index, tier-2 body, fork list) instead of
// mutating the shared SkillRegistry, so one bot's deny list never
// affects another bot.
// ---------------------------------------------------------------------------

/** Pure check: false when the skill is on the bot's denySkills list. */
export function isSkillAllowedFor(policy: BotToolPolicy | undefined, skillName: string): boolean {
  const p = policy ?? EMPTY_POLICY;
  return !normalizeList(p.denySkills).includes(skillName);
}

/**
 * Pure per-bot skill filter: drop every skill whose name is denied.
 * Generic over the item shape so callers can pass `Skill[]` or any
 * list with a `name` field; order of the survivors is preserved.
 */
export function filterSkillsFor<T extends { name: string }>(
  policy: BotToolPolicy | undefined,
  skills: T[],
): T[] {
  const deny = new Set(normalizeList(policy?.denySkills));
  if (deny.size === 0) return [...skills];
  return skills.filter((s) => !deny.has(s.name));
}

/**
 * v0.64: validate a bulk `denySkills` value (e.g. from IPC
 * `bots:update` in main). Only an array of strings is accepted —
 * anything else throws; non-string entries are dropped, and names
 * that are not in `knownNames` (the skill registry) are dropped and
 * reported in `dropped` so the caller can log a warning. Unknown
 * names NEVER throw the whole update: the surviving names still
 * apply. Pass the bot's already-stored denySkills as extra known
 * names when the registry cannot see them (bundle skills registered
 * per-bot in the coordinator) so an edit never silently wipes them.
 */
export function sanitizeDenySkills(
  input: unknown,
  knownNames: Iterable<string>,
): { kept: string[]; dropped: string[] } {
  if (!Array.isArray(input)) {
    throw new Error('denySkills phải là mảng chuỗi.');
  }
  const known = new Set([...knownNames].map((n) => n.trim()).filter((n) => n.length > 0));
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'string') {
      dropped.push(String(entry));
      continue;
    }
    const name = entry.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    if (known.has(name)) kept.push(name);
    else dropped.push(name);
  }
  return { kept, dropped };
}

/** Tuỳ chọn cho `checkToolCallFor` khi call mang lệnh shell. */
export interface ToolCallCheckOptions {
  /** Workspace của bot — dùng để phát hiện ghi file ra ngoài workspace. */
  workspaceDir?: string;
}

function truncateCommand(command: string, maxChars = 100): string {
  const trimmed = command.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/**
 * Pure combined check against one bot's policy object.
 *
 * v0.11c: khi `args` có `command` là chuỗi (tool shell như `shell_exec`,
 * `exec_task`), lệnh được phân loại bằng rule engine (`./rules.ts`):
 *  - `blocked` (rm -rf /, curl|sh, sudo…) → deny ở MỌI mode (sandbox
 *    cũng chặn cứng lúc chạy, đây chỉ là từ chối sớm với lý do rõ ràng).
 *  - mode 'all' → allow (bot cũ autoApprove=true chạy như trước).
 *  - mode 'none' → ask với mọi lệnh (bot cũ autoApprove=false).
 *  - mode 'safe-only' (mặc định): safe → allow, sensitive → ask,
 *    normal → theo policy tool như cũ.
 * Per-tool policy 'ask'/'deny' vẫn thắng lệnh safe (đặt 'ask' cho
 * `shell_exec` thì cả `npm test` cũng hỏi). Không có `args` → hành vi
 * y hệt trước v0.11c (lý do trả về giữ nguyên từng chữ).
 */
export function checkToolCallFor(
  policy: BotToolPolicy | undefined,
  toolName: string,
  args?: Record<string, unknown>,
  opts?: ToolCallCheckOptions,
): ToolCallCheck {
  if (!isToolAllowedFor(policy, toolName)) {
    return {
      allowed: false,
      policy: 'deny',
      reason: `Tool "${toolName}" bị cấm với bot này (denylist / policy deny).`,
    };
  }
  const policyName = approvalPolicyFor(policy, toolName);
  if (policyName === 'ask') {
    return { allowed: true, policy: 'ask', reason: `Tool "${toolName}" cần phê duyệt trước khi chạy.` };
  }
  const command = args?.['command'];
  if (typeof command === 'string' && command.trim() !== '') {
    const p = policy ?? EMPTY_POLICY;
    const cls = classifyCommand(command, {
      workspaceDir: opts?.workspaceDir,
      extraSafeCommands: p.safeCommands,
      extraSensitiveCommands: p.sensitiveCommands,
    });
    const short = truncateCommand(command);
    if (cls === 'blocked') {
      return {
        allowed: false,
        policy: 'deny',
        reason: `Lệnh "${short}" bị chặn bởi sandbox denylist, không được chạy.`,
      };
    }
    const mode = resolveAutoApproveMode(p.autoApprove);
    if (mode === 'all') {
      return { allowed: true, policy: 'allow', reason: `Tool "${toolName}" được phép chạy.` };
    }
    if (mode === 'none') {
      return {
        allowed: true,
        policy: 'ask',
        reason: `Bot không auto-approve: lệnh "${short}" cần phê duyệt trước khi chạy.`,
      };
    }
    if (cls === 'sensitive') {
      return {
        allowed: true,
        policy: 'ask',
        reason: `Lệnh "${short}" nhạy cảm, cần phê duyệt trước khi chạy.`,
      };
    }
    if (cls === 'safe') {
      return {
        allowed: true,
        policy: 'allow',
        reason: `Lệnh "${short}" nằm trong whitelist an toàn, chạy ngay không cần phê duyệt.`,
      };
    }
    // 'normal' → rơi xuống policy tool mặc định (allow) bên dưới.
  }
  return { allowed: true, policy: 'allow', reason: `Tool "${toolName}" được phép chạy.` };
}

/**
 * v0.10a — allowlist thành filter mặc định: lọc cả list tool theo đúng
 * luật `isToolAllowedFor` (deny thắng, allowlist non-empty thì chỉ giữ
 * tool trong allowlist). Đây là lớp 1 của `filterTools` trong
 * `agent/toolFilter.ts`. Pure, không đổi thứ tự tool còn lại.
 *
 * v0.28 (P0-4 fallback) — fail-open CÓ KIỂM SOÁT, opt-in qua
 * `opts.fallbackOnEmpty`: khi filter rỗng trong lúc đầu vào còn tool
 * (vd allowlist ghi tên tool đã đổi tên / không khớp tool nào) thì log
 * cảnh báo và trả toàn bộ list như cũ, thay vì để model mất hết tool.
 * Mặc định `false` (fail-closed): lớp allowlist/denylist là ranh giới
 * an ninh nên KHÔNG tự fallback — chỉ caller nào chủ động truyền
 * `fallbackOnEmpty: true` mới được fail-open, và việc chạy tool vẫn bị
 * `checkToolCall` chặn cuối lúc thực thi (filter chỉ quyết định tool
 * nào model ĐƯỢC THẤY, không phải tool nào ĐƯỢC CHẠY).
 */
export interface ToolListFilterOptions {
  /**
   * Khi true và kết quả lọc rỗng trong lúc đầu vào non-empty: log cảnh
   * báo `[permissions]` rồi trả toàn bộ list như cũ. Mặc định false.
   */
  fallbackOnEmpty?: boolean;
}

export function filterToolsFor(
  policy: BotToolPolicy | undefined,
  tools: Tool[],
  opts: ToolListFilterOptions = {},
): Tool[] {
  const out = tools.filter((t) => isToolAllowedFor(policy, t.definition.name));
  if (out.length === 0 && tools.length > 0 && opts.fallbackOnEmpty) {
    console.warn(
      `[permissions] filter rỗng (policy không giữ tool nào trong ${tools.length} tool) ` +
        `— fallback gửi đủ tool như cũ (fail-open có kiểm soát; checkToolCall vẫn chặn lúc chạy).`,
    );
    return [...tools];
  }
  return out;
}

/**
 * Registry of per-bot policies. One instance per host process (the
 * coordinator owns one; bots without an entry use the default policy:
 * allow all, no per-tool ask).
 */
export class AgentPermissions {
  private readonly bots = new Map<string, BotToolPolicy>();

  /** Replace (not merge) the policy for one bot. Pass {} to reset to default. */
  setBotPolicy(botId: string, policy: BotToolPolicy): void {
    if (!botId.trim()) throw new Error('setBotPolicy cần botId không rỗng.');
    this.bots.set(botId, {
      allowTools: policy.allowTools ? [...policy.allowTools] : undefined,
      denyTools: policy.denyTools ? [...policy.denyTools] : undefined,
      denySkills: policy.denySkills ? [...policy.denySkills] : undefined,
      policies: policy.policies ? { ...policy.policies } : undefined,
      autoApprove: policy.autoApprove,
      safeCommands: policy.safeCommands ? [...policy.safeCommands] : undefined,
      sensitiveCommands: policy.sensitiveCommands ? [...policy.sensitiveCommands] : undefined,
    });
  }

  /** The stored policy for a bot, or {} (default: allow all) when unset. */
  getBotPolicy(botId: string): BotToolPolicy {
    return this.bots.get(botId) ?? EMPTY_POLICY;
  }

  hasBotPolicy(botId: string): boolean {
    return this.bots.has(botId);
  }

  clearBotPolicy(botId: string): boolean {
    return this.bots.delete(botId);
  }

  listBotIds(): string[] {
    return [...this.bots.keys()];
  }

  /** Default allow-all-except-denylist check for one bot. */
  isToolAllowed(botId: string, toolName: string): boolean {
    return isToolAllowedFor(this.bots.get(botId), toolName);
  }

  /**
   * v0.64 (skills per-bot): false when the skill is on the bot's
   * denySkills list. The coordinator calls this per turn; a denied
   * skill is never matched / injected / forked for this bot.
   */
  isSkillAllowed(botId: string, skillName: string): boolean {
    return isSkillAllowedFor(this.bots.get(botId), skillName);
  }

  /** Approval policy for one tool of one bot (`allow` when unset). */
  approvalPolicy(botId: string, toolName: string): ApprovalPolicy {
    return approvalPolicyFor(this.bots.get(botId), toolName);
  }

  /**
   * The single check the agent loop should call before running a tool.
   * See the header comment for how to act on the result.
   *
   * v0.11c: truyền thêm `args` của tool call (để rule engine thấy
   * `command` của tool shell) và `opts.workspaceDir` khi có; không truyền
   * thì hành vi y hệt cũ.
   */
  checkToolCall(
    botId: string,
    toolName: string,
    args?: Record<string, unknown>,
    opts?: ToolCallCheckOptions,
  ): ToolCallCheck {
    return checkToolCallFor(this.bots.get(botId), toolName, args, opts);
  }

  /** v0.11c: mức auto-approve đã resolve của một bot (boolean cũ → mode). */
  autoApproveMode(botId: string): AutoApproveMode {
    return resolveAutoApproveMode(this.bots.get(botId)?.autoApprove);
  }

  /**
   * v0.64 (skills per-bot): filter mặc định theo denySkills của bot —
   * chỉ giữ skill bot được phép dùng (deny thắng). Bot chưa có policy
   * = giữ hết (allow all mặc định). Dùng trước khi match/inject skill
   * mỗi turn; registry dùng chung không bao giờ bị sửa nên bot khác
   * không bị ảnh hưởng.
   */
  filterSkills<T extends { name: string }>(botId: string, skills: T[]): T[] {
    return filterSkillsFor(this.bots.get(botId), skills);
  }

  /**
   * v0.10a — filter mặc định theo allowlist của bot: chỉ giữ tool bot
   * được phép dùng (deny thắng, allowlist non-empty thì chỉ giữ tool
   * trong allowlist). Bot chưa có policy = giữ hết (allow all mặc định).
   * Dùng trước khi gửi definitions cho model; `checkToolCall` vẫn là
   * lớp chặn cuối lúc tool chạy.
   *
   * v0.28 (P0-4 fallback) — `opts.fallbackOnEmpty: true` thì filter rỗng
   * bất thường sẽ log cảnh báo và trả toàn bộ list (xem `filterToolsFor`);
   * mặc định false (fail-closed, hành vi cũ).
   */
  filterTools(botId: string, tools: Tool[], opts: ToolListFilterOptions = {}): Tool[] {
    return filterToolsFor(this.bots.get(botId), tools, opts);
  }
}

/**
 * Standalone form of the loop hook, for hosts that hold the
 * AgentPermissions instance separately from the call site:
 *   const check = checkToolCall(permissions, botId, call.name, call.args);
 */
export function checkToolCall(
  permissions: AgentPermissions,
  botId: string,
  toolName: string,
  args?: Record<string, unknown>,
  opts?: ToolCallCheckOptions,
): ToolCallCheck {
  return permissions.checkToolCall(botId, toolName, args, opts);
}

/** Standalone form of `AgentPermissions.filterTools` (v0.10a). v0.28: nhận thêm `opts` (xem `filterToolsFor`). */
export function filterToolsForBot(
  permissions: AgentPermissions,
  botId: string,
  tools: Tool[],
  opts: ToolListFilterOptions = {},
): Tool[] {
  return permissions.filterTools(botId, tools, opts);
}

/** Standalone form of `AgentPermissions.filterSkills` (v0.64). */
export function filterSkillsForBot<T extends { name: string }>(
  permissions: AgentPermissions,
  botId: string,
  skills: T[],
): T[] {
  return permissions.filterSkills(botId, skills);
}
