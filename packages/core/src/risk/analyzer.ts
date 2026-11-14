/**
 * RiskAnalyzer (v1.01, Đội T3) — chấm mức rủi ro cho một tool call.
 *
 * Ý tưởng học từ OpenHands SecurityAnalyzer (chấm risk cho action
 * trước khi chạy), thiết kế + rule của open-bot, không copy code nào.
 *
 * Cách chấm (3 lớp, lớp sau thắng lớp trước):
 *  1. Mức nền theo TÊN tool: tool chỉ-đọc (`isReadOnlyTool`) → low;
 *     tool ghi/xoá/shell/mạng/computer-use → medium/high theo bảng
 *     `BASE_RISK_BY_TOOL` + pattern tên; tool lạ chưa biết → medium
 *     (fail-closed: không rõ thì không cho là an toàn).
 *  2. Rule theo ARGS (bảng built-in `BUILTIN_RISK_RULES` + rule cấu
 *     hình thêm): vd `rm -rf` trong lệnh shell, ghi/xoá ngoài
 *     workspace, xoá hàng loạt, `git push --force`, `curl | sh`.
 *     Mức cuối = max(mức nền, mức các rule khớp); điểm cuối = max
 *     điểm các rule khớp (mức nền cũng có điểm).
 *  3. Allowlist / denylist cấu hình: allowlist ép về low; denylist
 *     ép high + `denied: true` (loop chặn cứng, không hỏi duyệt).
 *     Denylist thắng allowlist, thắng cả rule extra.
 *
 * Module PURE (không I/O): dùng được trong loop, coordinator, CLI,
 * test. Rule regex cấu hình sai → rule đó bị bỏ qua lặng lẽ (không
 * throw, không chặn turn) — fail-open ở tầng cấu hình nhưng fail-
 * closed ở tầng mức nền (tool lạ vẫn medium).
 *
 * GIỚI HẠN (nói thẳng): đây là heuristic trên tên tool + args dạng
 * text. Lệnh shell tinh vi (vd mã hoá base64, biến môi trường) có
 * thể lọt mức medium. Analyzer là lớp HỖ TRỢ DUYỆT, không thay thế
 * sandbox, guardrail hay hook PreToolUse.
 */

import { isReadOnlyTool } from '../agent/toolFilter';
import type { RiskAnalyzerOptions, RiskAssessment, RiskLevel, RiskRule } from './types';

/** Ngưỡng điểm: < 40 low, 40–69 medium, >= 70 high. */
export const RISK_SCORE_MEDIUM = 40;
export const RISK_SCORE_HIGH = 70;

export function levelForScore(score: number): RiskLevel {
  if (score >= RISK_SCORE_HIGH) return 'high';
  if (score >= RISK_SCORE_MEDIUM) return 'medium';
  return 'low';
}

/** Mức nền + điểm nền cho tool không chỉ-đọc, theo tên chính xác. */
const BASE_RISK_BY_TOOL: Record<string, { level: RiskLevel; score: number; reason: string }> = {
  write_file: { level: 'medium', score: 50, reason: 'Ghi file (thay đổi nội dung trên đĩa).' },
  apply_diff: { level: 'medium', score: 50, reason: 'Sửa file bằng diff (thay đổi code).' },
  create_handoff: { level: 'medium', score: 45, reason: 'Tạo handoff (ghi file bàn giao).' },
  delete_file: { level: 'high', score: 75, reason: 'Xoá file (không khôi phục được).' },
  delete_files: { level: 'high', score: 80, reason: 'Xoá nhiều file (không khôi phục được).' },
  shell_exec: { level: 'high', score: 75, reason: 'Chạy lệnh shell trên máy (mã tuỳ ý).' },
  elevate: { level: 'high', score: 95, reason: 'Chạy lệnh với quyền cao hơn (elevate).' },
  git_commit: { level: 'medium', score: 50, reason: 'Commit git (ghi lịch sử repo).' },
  git_push: { level: 'high', score: 70, reason: 'Push git (đẩy thay đổi lên remote).' },
  git_checkout: { level: 'medium', score: 55, reason: 'Checkout git (đổi nhánh / khôi phục file).' },
  http_request: { level: 'medium', score: 55, reason: 'HTTP request ra ngoài (gửi/nhận dữ liệu).' },
  http_post: { level: 'medium', score: 60, reason: 'HTTP POST ra ngoài (gửi dữ liệu đi).' },
  web_post: { level: 'medium', score: 60, reason: 'POST ra ngoài (gửi dữ liệu đi).' },
  mcp_call_tool: { level: 'high', score: 70, reason: 'Gọi tool của MCP server ngoài.' },
  mcp2_call_tool_mrtr: { level: 'high', score: 70, reason: 'Gọi tool của MCP server ngoài.' },
  computer_click: { level: 'high', score: 75, reason: 'Điều khiển chuột thật trên máy.' },
  computer_type: { level: 'high', score: 75, reason: 'Gõ phím thật trên máy.' },
  computer_key: { level: 'high', score: 75, reason: 'Nhấn phím thật trên máy.' },
  computer_local_tool: { level: 'high', score: 80, reason: 'Chạy tool local trên máy (computer-use).' },
  browser_click: { level: 'medium', score: 55, reason: 'Click trên trình duyệt (thao tác web).' },
  browser_type: { level: 'medium', score: 55, reason: 'Gõ trên trình duyệt (nhập dữ liệu web).' },
  browser_navigate: { level: 'medium', score: 50, reason: 'Điều hướng trình duyệt.' },
  skill_marketplace_install: {
    level: 'high',
    score: 75,
    reason: 'Cài skill từ marketplace (chạy code bên ngoài).',
  },
  feed_subscribe: { level: 'medium', score: 45, reason: 'Đăng ký feed ngoài.' },
  watch_url: { level: 'medium', score: 45, reason: 'Theo dõi URL ngoài.' },
  tool_call_replay: { level: 'medium', score: 55, reason: 'Chạy lại tool call đã ghi (thực thi lại).' },
};

/** Pattern tên tool → mức nền (khi không có tên chính xác trong bảng). */
const BASE_RISK_BY_PATTERN: Array<{
  pattern: RegExp;
  level: RiskLevel;
  score: number;
  reason: string;
}> = [
  { pattern: /^shell/, level: 'high', score: 75, reason: 'Tool shell (chạy lệnh trên máy).' },
  { pattern: /^computer_/, level: 'high', score: 75, reason: 'Tool computer-use (điều khiển máy).' },
  { pattern: /^delete_/, level: 'high', score: 75, reason: 'Tool xoá (không khôi phục được).' },
  { pattern: /^browser_/, level: 'medium', score: 50, reason: 'Tool trình duyệt (thao tác web).' },
  { pattern: /^mcp.*call_tool/, level: 'high', score: 70, reason: 'Gọi tool MCP ngoài.' },
  { pattern: /_delete$/, level: 'high', score: 75, reason: 'Tool xoá (không khôi phục được).' },
  { pattern: /_write$|^write_/, level: 'medium', score: 50, reason: 'Tool ghi (thay đổi trạng thái).' },
  { pattern: /^send_/, level: 'medium', score: 55, reason: 'Tool gửi (tin nhắn/dữ liệu ra ngoài).' },
];

/**
 * Rule built-in theo args. `argsPattern` chạy trên JSON.stringify(args)
 * (không phụ thuộc schema từng tool); `argsKey` giới hạn xét một key.
 * Điểm >= 70 = high, 40–69 = medium.
 */
export const BUILTIN_RISK_RULES: readonly RiskRule[] = [
  // --- Shell nguy hiểm -------------------------------------------------
  {
    id: 'shell-rm-rf',
    description: 'Lệnh shell chứa rm -rf (xoá đệ quy, không khôi phục).',
    level: 'high',
    score: 95,
    tool: 'shell_exec',
    argsPattern: 'rm\\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)',
  },
  {
    id: 'shell-sudo',
    description: 'Lệnh shell dùng sudo (leo quyền).',
    level: 'high',
    score: 90,
    tool: 'shell_exec',
    argsPattern: '(^|[^a-zA-Z0-9_])sudo\\b',
  },
  {
    id: 'shell-pipe-to-shell',
    description: 'Tải script từ mạng rồi pipe thẳng vào shell (curl | sh).',
    level: 'high',
    score: 95,
    tool: 'shell_exec',
    argsPattern: '(curl|wget)[^|]*\\|\\s*(sh|bash|zsh)\\b',
  },
  {
    id: 'shell-destructive',
    description: 'Lệnh phá huỷ hệ thống (mkfs / dd ghi thiết bị / format).',
    level: 'high',
    score: 95,
    tool: 'shell_exec',
    argsPattern: '\\b(mkfs(\\.[a-z0-9]+)?|dd\\s+[^"]*of=/dev/)',
  },
  {
    id: 'shell-chmod-777',
    description: 'chmod 777 — mở quyền đọc/ghi/thực thi cho mọi người.',
    level: 'high',
    score: 80,
    tool: 'shell_exec',
    argsPattern: 'chmod\\s+(-R\\s+)?777\\b',
  },
  {
    id: 'shell-package-install',
    description: 'Cài package hệ thống / toàn cục (đổi môi trường máy).',
    level: 'high',
    score: 75,
    tool: 'shell_exec',
    argsPattern: '\\b(apt(-get)?\\s+install|brew\\s+install|npm\\s+(i|install)\\s+(-g\\b|[^"]*\\s-g\\b)|pip\\s+install)',
  },
  {
    id: 'shell-git-force',
    description: 'Git destructive: push --force / reset --hard (mất lịch sử).',
    level: 'high',
    score: 90,
    tool: 'shell_exec',
    argsPattern: 'git\\s+(push\\s+[^"]*--force|reset\\s+--hard|checkout\\s+[^"]*--\\s+\\.)',
  },
  {
    id: 'shell-redirect-system',
    description: 'Ghi đè file hệ thống bằng redirect shell (> /etc, > /dev).',
    level: 'high',
    score: 85,
    tool: 'shell_exec',
    argsPattern: '>\\s*/(etc|dev|usr|System|var|bin|Library)/',
  },
  // --- Ghi/xoá ngoài workspace ----------------------------------------
  {
    id: 'write-outside-workspace',
    description: 'Ghi file ra ngoài workspace của bot.',
    level: 'high',
    score: 85,
    toolPattern: '^(write_file|apply_diff)$',
    argsKey: 'path',
    argsPattern: '^(~|\\.\\./|\\.\\.\\\\)',
  },
  {
    id: 'delete-outside-workspace',
    description: 'Xoá file ngoài workspace của bot.',
    level: 'high',
    score: 90,
    toolPattern: '^delete_',
    argsKey: 'path',
    argsPattern: '^(~|\\.\\./|\\.\\.\\\\)',
  },
  {
    id: 'delete-bulk',
    description: 'Xoá hàng loạt (mảng nhiều path hoặc glob *).',
    level: 'high',
    score: 85,
    toolPattern: '^delete_',
    argsPattern: '"(paths|files)":\\s*\\[[^\\]]*,|\\*',
  },
  {
    id: 'delete-home',
    description: 'Xoá trong thư mục home / thư mục gốc của user.',
    level: 'high',
    score: 92,
    toolPattern: '^delete_',
    argsPattern: '("path":\\s*")?(~\\/|/home/|/Users/|C:\\\\Users\\\\)',
  },
  // --- Mạng ra ngoài ----------------------------------------------------
  {
    id: 'http-write-method',
    description: 'HTTP ghi ra ngoài (POST/PUT/DELETE gửi dữ liệu đi).',
    level: 'medium',
    score: 60,
    tool: 'http_request',
    argsKey: 'method',
    argsPattern: '^(POST|PUT|PATCH|DELETE)$',
  },
  {
    id: 'http-post-body',
    description: 'HTTP POST kèm body (gửi dữ liệu ra ngoài).',
    level: 'medium',
    score: 65,
    tool: 'http_request',
    argsPattern: '"body"\\s*:',
  },
  // --- Computer-use / MCP ----------------------------------------------
  {
    id: 'computer-record',
    description: 'Ghi hình / ghi thao tác màn hình (computer-use record).',
    level: 'high',
    score: 70,
    toolPattern: '^computer_record',
  },
  {
    id: 'mcp-call-external',
    description: 'Gọi tool MCP ngoài (code chạy ở server thứ ba).',
    level: 'high',
    score: 70,
    toolPattern: '^mcp.*call_tool',
  },
  // --- Shell: đọc secret / leo thang / thực thi mã --------------------
  {
    id: 'shell-env-dump',
    description: 'Đọc biến môi trường / file secret (env, ~/.ssh, /etc/passwd).',
    level: 'high',
    score: 85,
    tool: 'shell_exec',
    argsPattern: '(\\benv\\b|printenv|cat\\s+[^"]*(\\.ssh/|\\.aws/|\\.gnupg/|/etc/passwd|/etc/shadow|credentials))',
  },
  {
    id: 'shell-eval-exec',
    description: 'Thực thi mã động (eval / python -c / node -e / ruby -e).',
    level: 'high',
    score: 85,
    tool: 'shell_exec',
    argsPattern: '(\\beval\\b|python[0-9]?\\s+-c|node\\s+-e|ruby\\s+-e|perl\\s+-e)',
  },
  {
    id: 'shell-history-clear',
    description: 'Xoá lịch sử shell (che dấu vết: history -c / xoá .bash_history).',
    level: 'high',
    score: 80,
    tool: 'shell_exec',
    argsPattern: '(history\\s+-c|rm\\s+[^"]*\\.bash_history|rm\\s+[^"]*\\.zsh_history)',
  },
  {
    id: 'shell-git-history-rewrite',
    description: 'Viết lại lịch sử git (filter-branch / filter-repo / rebase -i).',
    level: 'high',
    score: 90,
    tool: 'shell_exec',
    argsPattern: 'git\\s+(filter-branch|filter-repo|rebase\\s+(-i|--interactive))',
  },
  {
    id: 'shell-npm-publish',
    description: 'Publish package lên registry (phát hành code ra ngoài).',
    level: 'high',
    score: 75,
    tool: 'shell_exec',
    argsPattern: '\\bnpm\\s+publish\\b',
  },
  {
    id: 'shell-ssh',
    description: 'SSH ra máy khác (truy cập từ xa).',
    level: 'high',
    score: 75,
    tool: 'shell_exec',
    argsPattern: '(^|[^a-zA-Z0-9_])ssh\\s+[^\"]',
  },
  {
    id: 'shell-docker',
    description: 'Chạy container / lệnh trong container (docker run/exec).',
    level: 'high',
    score: 80,
    tool: 'shell_exec',
    argsPattern: '\\bdocker\\s+(run|exec|cp)\\b',
  },
  {
    id: 'shell-curl-post',
    description: 'curl/wget gửi dữ liệu đi (POST body / upload).',
    level: 'medium',
    score: 65,
    tool: 'shell_exec',
    argsPattern: '(curl|wget)\\s+[^"]*(-d|--data|--data-binary|--upload-file|-T\\s)',
  },
  {
    id: 'shell-process-kill',
    description: 'Kill process (kill -9 / pkill / killall).',
    level: 'medium',
    score: 60,
    tool: 'shell_exec',
    argsPattern: '\\b(kill\\s+-9|pkill|killall)\\b',
  },
  // --- Ghi file secret / xoá .git ---------------------------------------
  {
    id: 'write-secret-file',
    description: 'Ghi file chứa secret (.env / credentials / key / token).',
    level: 'high',
    score: 90,
    toolPattern: '^(write_file|apply_diff)$',
    argsKey: 'path',
    argsPattern: '(\\.env|credentials|\\.pem|id_rsa|\\.key|token)',
  },
  {
    id: 'delete-git-dir',
    description: 'Xoá thư mục .git (mất toàn bộ lịch sử repo).',
    level: 'high',
    score: 92,
    toolPattern: '^delete_',
    argsPattern: '(\\.git(/|\\|$)|"path":\\s*"[^"]*\\.git")',
  },
];

/** Một entry allowlist/denylist đã parse: tool + regex optional trên args. */
interface ListEntry {
  tool: string;
  argsRegex: RegExp | null;
}

function parseListEntry(raw: string): ListEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { tool: trimmed, argsRegex: null };
  const tool = trimmed.slice(0, colon).trim();
  const pattern = trimmed.slice(colon + 1);
  if (!tool || !pattern) return null;
  try {
    return { tool, argsRegex: new RegExp(pattern, 'i') };
  } catch {
    return null;
  }
}

function safeRegExp(source: string | undefined, flags = 'i'): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * RiskAnalyzer — chấm risk cho tool call. Tạo một lần, dùng lại cho
 * nhiều call (rule đã biên dịch sẵn ở constructor).
 */
export class RiskAnalyzer {
  private readonly rules: RiskRule[];
  private readonly allowlist: ListEntry[];
  private readonly denylist: ListEntry[];

  constructor(options: RiskAnalyzerOptions = {}) {
    const disabled = new Set(options.disabledBuiltinRuleIds ?? []);
    const byId = new Map<string, RiskRule>();
    for (const rule of BUILTIN_RISK_RULES) {
      if (!disabled.has(rule.id)) byId.set(rule.id, rule);
    }
    // Rule extra ghi đè built-in khi trùng id (cấu hình của user thắng).
    for (const rule of options.extraRules ?? []) {
      if (rule?.id) byId.set(rule.id, rule);
    }
    this.rules = [...byId.values()];
    this.allowlist = (options.allowlist ?? [])
      .map(parseListEntry)
      .filter((e): e is ListEntry => e !== null);
    this.denylist = (options.denylist ?? [])
      .map(parseListEntry)
      .filter((e): e is ListEntry => e !== null);
  }

  /** Số rule đang có hiệu lực (built-in + extra, trừ rule bị tắt). */
  get ruleCount(): number {
    return this.rules.length;
  }

  /** Id các rule đang có hiệu lực. */
  listRuleIds(): string[] {
    return this.rules.map((r) => r.id);
  }

  /**
   * Chấm risk cho một tool call. `workspaceDir` dùng để phát hiện
   * ghi/xoá ngoài workspace (so sánh tiền tố path tuyệt đối).
   */
  analyze(
    toolName: string,
    args: Record<string, unknown>,
    options: { workspaceDir?: string } = {},
  ): RiskAssessment {
    const assessedAtMs = Date.now();
    const argsJson = safeStringify(args);
    const matchedRuleIds: string[] = [];
    const reasons: string[] = [];

    // Lớp 3a — denylist: thắng mọi thứ, chặn cứng.
    if (this.matchesList(this.denylist, toolName, argsJson)) {
      return {
        level: 'high',
        score: 100,
        reasons: [`Tool "${toolName}" nằm trong denylist (cấm tường minh).`],
        matchedRuleIds: ['denylist'],
        denied: true,
        toolName,
        assessedAtMs,
      };
    }

    // Lớp 1 — mức nền theo tool.
    const base = this.baseRisk(toolName);
    let score = base.score;
    let level = base.level;
    reasons.push(base.reason);

    // Lớp 2 — rule theo args (built-in + extra).
    for (const rule of this.rules) {
      if (!this.ruleMatches(rule, toolName, args, argsJson)) continue;
      matchedRuleIds.push(rule.id);
      reasons.push(rule.description);
      if (rule.score > score) score = rule.score;
      if (rule.level === 'high' || (rule.level === 'medium' && level === 'low')) {
        level = rule.level;
      }
    }

    // Phát hiện ghi/xoá ngoài workspace bằng so sánh path thật (chính
    // xác hơn regex trên JSON): chỉ khi workspaceDir được truyền vào.
    if (options.workspaceDir) {
      const outside = this.findOutsideWorkspacePath(toolName, args, options.workspaceDir);
      if (outside) {
        matchedRuleIds.push('outside-workspace');
        reasons.push(`Đường dẫn "${outside}" nằm ngoài workspace của bot.`);
        score = Math.max(score, 85);
        level = 'high';
      }
    }

    // Đồng bộ level với score (rule có thể đẩy điểm mà chưa đẩy level).
    const levelByScore = levelForScore(score);
    if (levelByScore === 'high') level = 'high';
    else if (levelByScore === 'medium' && level === 'low') level = 'medium';

    // Lớp 3b — allowlist: ép về low. Đây là opt-in tường minh của
    // người dùng ("tool này tôi tin tưởng") nên thắng cả mức nền lẫn
    // rule theo args; chỉ denylist (đã return ở trên) thắng nó.
    const allowlisted = this.matchesList(this.allowlist, toolName, argsJson);
    if (allowlisted) {
      return {
        level: 'low',
        score: Math.min(score, 10),
        reasons: [`Tool "${toolName}" nằm trong allowlist (đã tin tưởng).`],
        matchedRuleIds,
        denied: false,
        toolName,
        assessedAtMs,
      };
    }

    return { level, score, reasons, matchedRuleIds, denied: false, toolName, assessedAtMs };
  }

  /** Mức nền theo tên tool. */
  private baseRisk(toolName: string): { level: RiskLevel; score: number; reason: string } {
    if (isReadOnlyTool(toolName)) {
      return { level: 'low', score: 5, reason: `Tool chỉ-đọc "${toolName}" (không đổi trạng thái).` };
    }
    const exact = BASE_RISK_BY_TOOL[toolName];
    if (exact) return exact;
    for (const entry of BASE_RISK_BY_PATTERN) {
      if (entry.pattern.test(toolName)) {
        return { level: entry.level, score: entry.score, reason: entry.reason };
      }
    }
    // Tool lạ: không rõ → medium (fail-closed), không cho là an toàn.
    return {
      level: 'medium',
      score: 50,
      reason: `Tool "${toolName}" chưa có phân loại — mặc định medium (chưa rõ).`,
    };
  }

  private ruleMatches(
    rule: RiskRule,
    toolName: string,
    args: Record<string, unknown>,
    argsJson: string,
  ): boolean {
    if (rule.tool !== undefined && rule.tool !== toolName) return false;
    if (rule.toolPattern !== undefined) {
      const re = safeRegExp(rule.toolPattern);
      if (!re || !re.test(toolName)) return false;
    }
    if (rule.argsPattern === undefined) return true;
    const re = safeRegExp(rule.argsPattern);
    if (!re) return false;
    if (rule.argsKey !== undefined) {
      const value = args[rule.argsKey];
      if (value === undefined) return false;
      return re.test(typeof value === 'string' ? value : safeStringify(value));
    }
    return re.test(argsJson);
  }

  private matchesList(list: ListEntry[], toolName: string, argsJson: string): boolean {
    for (const entry of list) {
      if (entry.tool !== '*' && entry.tool !== toolName) continue;
      if (entry.argsRegex && !entry.argsRegex.test(argsJson)) continue;
      return true;
    }
    return false;
  }

  /**
   * Tìm path trong args nằm ngoài workspaceDir (path tuyệt đối không
   * bắt đầu bằng workspaceDir, hoặc path tương đối leo ra `..`).
   * Chỉ xét các key path thường gặp; không xét = không kết luận.
   */
  private findOutsideWorkspacePath(
    toolName: string,
    args: Record<string, unknown>,
    workspaceDir: string,
  ): string | null {
    if (!/^(write_file|apply_diff|delete_|shell_exec)/.test(toolName)) return null;
    const ws = workspaceDir.replace(/[/\\]+$/, '');
    const candidates: string[] = [];
    for (const key of ['path', 'file', 'filePath', 'target', 'destination']) {
      const v = args[key];
      if (typeof v === 'string' && v) candidates.push(v);
    }
    const arr = args['paths'];
    if (Array.isArray(arr)) {
      for (const v of arr) if (typeof v === 'string') candidates.push(v);
    }
    for (const p of candidates) {
      const norm = p.replace(/\\/g, '/');
      if (norm.startsWith('../') || norm === '..' || norm.startsWith('~/')) return p;
      if (norm.startsWith('/') && !norm.startsWith(`${ws}/`) && norm !== ws) return p;
      if (/^[A-Za-z]:\//.test(norm) && !norm.toLowerCase().startsWith(ws.toLowerCase().replace(/\\/g, '/') + '/')) {
        return p;
      }
    }
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Analyzer mặc định (built-in rules, không allow/deny thêm). */
export const DEFAULT_RISK_ANALYZER = new RiskAnalyzer();

/** Chấm risk nhanh bằng analyzer mặc định (tiện cho test/CLI). */
export function analyzeRisk(
  toolName: string,
  args: Record<string, unknown>,
  options: { workspaceDir?: string } = {},
): RiskAssessment {
  return DEFAULT_RISK_ANALYZER.analyze(toolName, args, options);
}
