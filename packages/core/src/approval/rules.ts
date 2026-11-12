/**
 * Auto-approve rules (v0.35, P1-7 — kiểu Claude Code allowlist / Cursor
 * whitelist lệnh): cho phép người dùng cấu hình tự động duyệt một số
 * tool call an toàn mà không cần bấm duyệt từng lần.
 *
 * Một rule gồm:
 *  - pattern: rule shell (`kind: 'shell'`) khớp tiền tố lệnh shell
 *    (vd `npm test`, `git status`); rule tool (`kind: 'tool'`) khớp tên
 *    tool + pattern args (vd `write_file` với `path: 'src/*'`).
 *  - phạm vi: toàn cục (`scope: 'global'`) hay một bot cụ thể
 *    (`scope: 'bot'`, `botId`).
 *  - `enabled` + `note` (ghi chú tuỳ chọn, chỉ để người đọc hiểu rule).
 *
 * An toàn theo thiết kế (fail-closed):
 *  - Store bắt đầu RỖNG: không có rule nào → mọi tool call cần duyệt
 *    vẫn hỏi người dùng như cũ. Rule chỉ có hiệu lực khi người dùng
 *    tạo tường minh (thêm rule = opt-in).
 *  - Denylist thắng auto-approve, LUÔN: lệnh khớp denylist cứng
 *    (`matchBlockedCommandPattern` trong `../agent/rules`) không bao giờ
 *    khớp rule — kể cả rule tool cho `shell_exec` với `command` cấm.
 *    Kiểm tra này chạy trong `findMatchingAutoApproveRule` (lúc khớp)
 *    VÀ trong `validateAutoApproveRuleInput` (lúc tạo: pattern tự nó
 *    đã nguy hiểm như `sudo` hay `rm -rf /` thì bị từ chối ngay).
 *  - Rule shell chỉ khớp lệnh ĐƠN (không có toán tử ghép `&&`/`||`/`;`/
 *    `|`, redirect `>`/`<`, substitution `$(...)`/backtick): `npm test`
 *    không được phép tự duyệt `npm test && git push`.
 *  - Rule tool KHÔNG BAO GIỜ là allowlist tool: nó chỉ bỏ qua bước
 *    hỏi duyệt khi approval đã được yêu cầu; allow/deny của
 *    `AgentPermissions`, hook PreToolUse (denylist) và guardrail vẫn
 *    chạy trước/sau như cũ (xem `agent/loop.ts`).
 *
 * Module này là PURE trừ `AutoApproveRuleStore` (đọc/ghi file JSON):
 * matching + validation không có I/O, dùng được trong loop, coordinator
 * và test mà không cần store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyCommand, matchBlockedCommandPattern } from '../agent/rules';
import { ELEVATED_TOOL_NAME } from '../elevate/elevate';

/** Tên file rules trong thư mục dữ liệu local (userData). */
export const AUTO_APPROVE_RULES_FILE_NAME = 'auto-approve-rules.json';

/** Phiên bản format file rules (để migrate sau này nếu đổi shape). */
export const AUTO_APPROVE_RULES_FILE_VERSION = 1;

/** Ghi chú tối đa (tránh file rules phình vì note dài). */
export const MAX_AUTO_APPROVE_NOTE_CHARS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoApproveRuleKind = 'shell' | 'tool';

export type AutoApproveRuleScope = 'global' | 'bot';

/**
 * Một rule auto-approve đã lưu (có id + createdAt). `pattern` chỉ dùng
 * cho rule shell; `tool` + `argsPattern` chỉ dùng cho rule tool.
 */
export interface AutoApproveRule {
  /** Id ổn định (uuid), sinh lúc thêm — dùng để xoá/bật-tắt + ghi trace. */
  id: string;
  kind: AutoApproveRuleKind;
  /** Rule tắt thì không bao giờ khớp (dù pattern khớp). */
  enabled: boolean;
  scope: AutoApproveRuleScope;
  /** Bắt buộc khi scope === 'bot': rule chỉ áp cho bot này. */
  botId?: string;
  /** Rule shell: tiền tố lệnh (vd `npm test`). */
  pattern?: string;
  /** Rule tool: tên tool phải khớp chính xác (vd `write_file`). */
  tool?: string;
  /**
   * Rule tool: pattern cho args — mỗi key phải có trong args của tool
   * call. Giá trị string kết thúc bằng `*` là tiền tố (vd `path:
   * 'src/*'` khớp mọi file dưới `src/`); các giá trị khác phải bằng
   * chính xác (===). Không có argsPattern = mọi args đều khớp.
   */
  argsPattern?: Record<string, string | number | boolean>;
  /** Ghi chú cho người đọc (không ảnh hưởng matching). */
  note?: string;
  /** Epoch ms lúc tạo rule. */
  createdAt: number;
}

/** Input khi thêm rule mới (chưa có id/createdAt). */
export interface AutoApproveRuleInput {
  kind: AutoApproveRuleKind;
  enabled?: boolean;
  scope: AutoApproveRuleScope;
  botId?: string;
  pattern?: string;
  tool?: string;
  argsPattern?: Record<string, string | number | boolean>;
  note?: string;
}

/** Input cho việc khớp rule lúc duyệt một tool call. */
export interface AutoApproveMatchInput {
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Workspace của bot — hiện chưa dùng để khớp, giữ cho mở rộng sau. */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Validation (lúc tạo rule — từ chối pattern nguy hiểm ngay từ đầu)
// ---------------------------------------------------------------------------

/** Toán tử shell không được phép xuất hiện trong pattern rule shell. */
const SHELL_OPERATOR_RE = /(?:&&|\|\||[;&|`]|[$][(]|>|<|\n|\r)/;

/**
 * Validate input thêm rule. Trả về danh sách lỗi (rỗng = hợp lệ).
 * Không throw — caller (store / RPC) ném Error với các lỗi này.
 */
export function validateAutoApproveRuleInput(input: AutoApproveRuleInput): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return ['Rule phải là một object.'];
  if (input.kind !== 'shell' && input.kind !== 'tool') {
    errors.push('Rule cần "kind" là "shell" hoặc "tool".');
    return errors;
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    errors.push('"enabled" phải là boolean.');
  }
  if (input.scope !== 'global' && input.scope !== 'bot') {
    errors.push('Rule cần "scope" là "global" hoặc "bot".');
  } else if (input.scope === 'bot') {
    if (typeof input.botId !== 'string' || input.botId.trim() === '') {
      errors.push('Rule phạm vi bot cần "botId" là chuỗi không rỗng.');
    }
  }
  if (typeof input.note === 'string' && input.note.length > MAX_AUTO_APPROVE_NOTE_CHARS) {
    errors.push(`"note" tối đa ${MAX_AUTO_APPROVE_NOTE_CHARS} ký tự.`);
  } else if (input.note !== undefined && typeof input.note !== 'string') {
    errors.push('"note" phải là chuỗi.');
  }
  if (input.kind === 'shell') {
    if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
      errors.push('Rule shell cần "pattern" là chuỗi không rỗng (vd "npm test").');
    } else {
      const pattern = input.pattern.trim().replace(/\s+/g, ' ');
      if (SHELL_OPERATOR_RE.test(pattern)) {
        errors.push(
          'Rule shell không được chứa toán tử ghép/redirect/substitution (&&, ||, ;, |, >, <, $(...), backtick) — pattern phải là một lệnh đơn.',
        );
      }
      // Pattern tự nó đã nguy hiểm (vd `sudo`, `rm -rf /`) thì từ chối
      // ngay — denylist cũng chặn lúc khớp, đây là lớp báo lỗi sớm.
      if (classifyCommand(pattern) === 'blocked') {
        errors.push(`Pattern "${pattern}" bị chặn bởi denylist, không được làm rule auto-approve.`);
      }
    }
    if (input.tool !== undefined || input.argsPattern !== undefined) {
      errors.push('Rule shell không dùng "tool" hay "argsPattern".');
    }
  } else {
    if (typeof input.tool !== 'string' || input.tool.trim() === '' || /\s/.test(input.tool)) {
      errors.push('Rule tool cần "tool" là tên tool không rỗng, không chứa khoảng trắng.');
    }
    // v0.86 (P2-10): elevate KHÔNG BAO GIỜ được auto-approve — mỗi lần
    // chạy shell_elevate đều phải qua thẻ phê duyệt tay, nên không ai
    // được tạo rule "allow always" cho nó (dù là rule tool tường minh).
    if (input.tool?.trim() === ELEVATED_TOOL_NAME) {
      errors.push(
        `Tool "${ELEVATED_TOOL_NAME}" không bao giờ được auto-approve: mỗi lệnh elevate đều phải duyệt tay từng lần, không có rule "allow always".`,
      );
    }
    if (input.pattern !== undefined) {
      errors.push('Rule tool không dùng "pattern" (dùng "tool" + "argsPattern").');
    }
    if (input.argsPattern !== undefined) {
      if (
        input.argsPattern === null ||
        typeof input.argsPattern !== 'object' ||
        Array.isArray(input.argsPattern)
      ) {
        errors.push('"argsPattern" phải là một object phẳng.');
      } else {
        for (const [key, value] of Object.entries(input.argsPattern)) {
          if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            errors.push(`"argsPattern.${key}" chỉ nhận string/number/boolean.`);
          }
        }
        // Rule tool cho tool shell mà pattern command đã cấm → từ chối.
        const command = input.argsPattern['command'];
        if (typeof command === 'string' && classifyCommand(command) === 'blocked') {
          errors.push(
            `argsPattern.command "${command}" bị chặn bởi denylist, không được làm rule auto-approve.`,
          );
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

/** Khớp tiền tố đúng ranh giới token (`npm test` khớp `npm test --watch`, không khớp `npm testing`). */
function matchesPrefix(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(prefix + ' ');
}

/** Lệnh shell có "đơn" không (không toán tử ghép/redirect/substitution)? Rule chỉ khớp lệnh đơn. */
function isSimpleCommand(command: string): boolean {
  return !SHELL_OPERATOR_RE.test(command);
}

/**
 * Pattern args của rule tool có khớp args thật không: mọi key trong
 * pattern phải có mặt; string kết thúc `*` = tiền tố, còn lại ===.
 */
export function matchesArgsPattern(
  pattern: Record<string, string | number | boolean> | undefined,
  args: Record<string, unknown>,
): boolean {
  if (pattern === undefined) return true;
  for (const [key, expected] of Object.entries(pattern)) {
    const actual = args[key];
    if (typeof expected === 'string' && expected.endsWith('*')) {
      if (typeof actual !== 'string') return false;
      if (!actual.startsWith(expected.slice(0, -1))) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Một rule có khớp tool call này không. Thứ tự kiểm tra (fail-closed):
 * enabled → scope → denylist (thắng mọi rule) → pattern/tool.
 * Rule tắt, sai phạm vi, hoặc lệnh bị denylist chặn → không khớp.
 */
export function matchAutoApproveRule(
  rule: AutoApproveRule,
  input: AutoApproveMatchInput,
): boolean {
  if (!rule || !rule.enabled) return false;
  // v0.86 (P2-10): elevate KHÔNG BAO GIỜ khớp rule auto-approve — lớp
  // phòng thủ thứ hai sau `validateAutoApproveRuleInput` (rule cũ / rule
  // ghi tay trong file mà lọt qua validate vẫn không tự duyệt được).
  if (input.toolName === ELEVATED_TOOL_NAME) return false;
  if (rule.scope === 'bot' && rule.botId !== input.botId) return false;
  if (rule.kind === 'shell') {
    const command = input.args['command'];
    if (typeof command !== 'string') return false;
    // Denylist thắng auto-approve: lệnh cấm không bao giờ tự duyệt.
    if (matchBlockedCommandPattern(command) !== undefined) return false;
    if (!isSimpleCommand(command)) return false;
    const pattern = (rule.pattern ?? '').trim().replace(/\s+/g, ' ');
    if (pattern === '') return false;
    return matchesPrefix(command.trim().replace(/\s+/g, ' '), pattern);
  }
  if (rule.tool !== input.toolName) return false;
  // Rule tool cho tool shell: lệnh cấm trong args vẫn bị denylist chặn.
  const command = input.args['command'];
  if (typeof command === 'string' && matchBlockedCommandPattern(command) !== undefined) {
    return false;
  }
  return matchesArgsPattern(rule.argsPattern, input.args);
}

/**
 * Rule đầu tiên (theo thứ tự lưu) khớp tool call, hoặc undefined khi
 * không rule nào khớp — caller hỏi duyệt tay như cũ.
 */
export function findMatchingAutoApproveRule(
  rules: readonly AutoApproveRule[],
  input: AutoApproveMatchInput,
): AutoApproveRule | undefined {
  for (const rule of rules) {
    if (matchAutoApproveRule(rule, input)) return rule;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store: JSON file local, ghi atomic, mode 0600 (như Vault saveStore)
// ---------------------------------------------------------------------------

interface StoredRulesFile {
  version: number;
  rules: AutoApproveRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse file rules: hỏng → [] + cảnh báo (fail-closed, không crash app). */
function parseStoredRules(text: string, filePath: string): AutoApproveRule[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.warn(
      `[auto-approve] File rules hỏng (${filePath}): ${err instanceof Error ? err.message : String(err)} — dùng danh sách rỗng.`,
    );
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data['rules'])) {
    console.warn(`[auto-approve] File rules sai định dạng (${filePath}) — dùng danh sách rỗng.`);
    return [];
  }
  const out: AutoApproveRule[] = [];
  for (const entry of data['rules'] as unknown[]) {
    if (!isRecord(entry)) continue;
    // Chỉ giữ rule đủ shape tối thiểu; rule thiếu field thì bỏ qua
    // (không crash vì một rule tay sửa hỏng).
    if (
      typeof entry['id'] !== 'string' ||
      (entry['kind'] !== 'shell' && entry['kind'] !== 'tool') ||
      typeof entry['enabled'] !== 'boolean' ||
      (entry['scope'] !== 'global' && entry['scope'] !== 'bot') ||
      typeof entry['createdAt'] !== 'number'
    ) {
      continue;
    }
    out.push(entry as unknown as AutoApproveRule);
  }
  return out;
}

/**
 * Store rule auto-approve. `filePath` undefined = chỉ giữ trong bộ nhớ
 * (dùng cho test / khi host chưa cấu hình thư mục dữ liệu — rule vẫn
 * chạy trong phiên, mất khi restart). Có filePath thì mọi thay đổi ghi
 * ngay xuống đĩa (atomic tmp + rename, mode 0600).
 */
export class AutoApproveRuleStore {
  private readonly filePath?: string;
  private rules: AutoApproveRule[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) this.reload();
  }

  /** Đường dẫn file rules, hoặc undefined khi chỉ giữ trong bộ nhớ. */
  get path(): string | undefined {
    return this.filePath;
  }

  /** Đọc lại file từ đĩa (file ngoài đổi thì lần gọi sau thấy rule mới). */
  reload(): void {
    if (!this.filePath) return;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // File chưa có → danh sách rỗng (mặc định tắt hết, fail-closed).
      this.rules = [];
      return;
    }
    this.rules = parseStoredRules(text, this.filePath);
  }

  private save(): void {
    if (!this.filePath) return;
    const payload: StoredRulesFile = {
      version: AUTO_APPROVE_RULES_FILE_VERSION,
      rules: this.rules,
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // chmod lỗi trên FS lạ thì vẫn giữ file đã rename — không fail run.
    }
  }

  /** Tất cả rule (bản copy — sửa ngoài không ảnh hưởng store). */
  list(): AutoApproveRule[] {
    return this.rules.map((r) => ({
      ...r,
      ...(r.argsPattern ? { argsPattern: { ...r.argsPattern } } : {}),
    }));
  }

  /** Thêm rule mới (validate trước; lỗi → throw Error liệt kê lý do). */
  add(input: AutoApproveRuleInput): AutoApproveRule {
    const errors = validateAutoApproveRuleInput(input);
    if (errors.length > 0) {
      throw new Error(`Không thêm được rule auto-approve: ${errors.join(' ')}`);
    }
    const rule: AutoApproveRule = {
      id: randomUUID(),
      kind: input.kind,
      // Thêm rule là opt-in tường minh của người dùng nên mặc định BẬT;
      // hệ thống mặc định TẮT là vì store bắt đầu rỗng (không có rule
      // nào thì không có gì tự duyệt). Muốn rule chờ duyệt tay thì tạo
      // với `enabled: false` rồi bật sau.
      enabled: input.enabled ?? true,
      scope: input.scope,
      ...(input.scope === 'bot' ? { botId: input.botId!.trim() } : {}),
      ...(input.kind === 'shell' ? { pattern: input.pattern!.trim().replace(/\s+/g, ' ') } : {}),
      ...(input.kind === 'tool' ? { tool: input.tool!.trim() } : {}),
      ...(input.argsPattern ? { argsPattern: { ...input.argsPattern } } : {}),
      ...(typeof input.note === 'string' && input.note !== '' ? { note: input.note } : {}),
      createdAt: Date.now(),
    };
    this.rules.push(rule);
    this.save();
    return { ...rule };
  }

  /** Xoá rule theo id. Trả về true khi có rule bị xoá. */
  remove(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Bật/tắt rule theo id. Trả về rule sau khi đổi, hoặc undefined khi
   * không có rule với id đó (caller báo lỗi rõ).
   */
  setEnabled(id: string, enabled: boolean): AutoApproveRule | undefined {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    rule.enabled = enabled;
    this.save();
    return { ...rule };
  }

  /** Rule đầu tiên khớp tool call (xem `findMatchingAutoApproveRule`). */
  findMatch(input: AutoApproveMatchInput): AutoApproveRule | undefined {
    return findMatchingAutoApproveRule(this.rules, input);
  }
}
