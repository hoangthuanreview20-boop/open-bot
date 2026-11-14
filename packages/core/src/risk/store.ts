/**
 * RiskRuleStore (v1.01, Đội T3) — rule chấm risk + allowlist/denylist
 * của user, lưu bền trong file JSON.
 *
 * Học theo `approval/rules.ts` (AutoApproveRuleStore): cùng shape file
 * versioned + ghi atomic (temp + rename, mode 0600) + validate lúc đọc
 * (file hỏng → bắt đầu rỗng, không crash app). Khác ở chỗ store này
 * giữ RULE CHẤM RISK (RiskRule: level/score/pattern), còn
 * AutoApproveRuleStore giữ rule TỰ DUYỆT (cho phép chạy không hỏi).
 * Hai store độc lập: chấm risk không bao giờ tự duyệt.
 *
 * File mặc định: `<dataDir>/risk-rules.json` (coordinator truyền
 * dataDir; CLI truyền thư mục làm việc). Shape:
 *   { version: 1, rules: RiskRule[], allowlist: string[],
 *     denylist: string[], disabledBuiltinRuleIds: string[] }
 *
 * Validate: rule phải có id + description + level hợp lệ + score
 * 0–100; pattern regex sai → rule bị loại lúc đọc (ghi log qua
 * `onInvalid` callback, không throw). Tool/argsPattern rỗng = khớp
 * mọi tool / mọi args (theo semantics của RiskRule).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RiskAnalyzerOptions, RiskLevel, RiskRule } from './types';
import { isRiskLevel } from './types';

export const RISK_RULES_FILE_NAME = 'risk-rules.json';
export const RISK_RULES_FILE_VERSION = 1;

/** Tối đa rule custom trong một file (tránh file phình vô hạn). */
export const MAX_CUSTOM_RISK_RULES = 200;
/** Tối đa entry trong mỗi list allow/deny. */
export const MAX_RISK_LIST_ENTRIES = 500;

export interface StoredRiskRules {
  version: number;
  rules: RiskRule[];
  allowlist: string[];
  denylist: string[];
  disabledBuiltinRuleIds: string[];
}

export interface RiskRuleStoreOptions {
  /** Callback khi một rule/list entry trong file bị loại lúc đọc. */
  onInvalid?: (reason: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRegex(source: unknown): source is string {
  if (typeof source !== 'string' || source.length === 0) return false;
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate một rule đọc từ file (hoặc do user thêm). Trả về rule đã
 * chuẩn hoá, hoặc undefined khi rule hỏng (kèm lý do qua onInvalid).
 * Không throw — file hỏng không được crash app lúc khởi động.
 */
export function validateStoredRiskRule(
  value: unknown,
  onInvalid?: (reason: string) => void,
): RiskRule | undefined {
  if (!isRecord(value)) {
    onInvalid?.('rule không phải object — bỏ qua.');
    return undefined;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) {
    onInvalid?.('rule thiếu id — bỏ qua.');
    return undefined;
  }
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  if (!description) {
    onInvalid?.(`rule "${id}" thiếu description — bỏ qua.`);
    return undefined;
  }
  const level: unknown = value.level;
  if (!isRiskLevel(level)) {
    onInvalid?.(`rule "${id}" có level không hợp lệ (${String(level)}) — bỏ qua.`);
    return undefined;
  }
  const score = typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    onInvalid?.(`rule "${id}" có score ngoài 0–100 — bỏ qua.`);
    return undefined;
  }
  const rule: RiskRule = { id, description, level, score: Math.floor(score) };
  if (typeof value.tool === 'string' && value.tool.trim()) rule.tool = value.tool.trim();
  if (value.toolPattern !== undefined) {
    if (!validRegex(value.toolPattern)) {
      onInvalid?.(`rule "${id}" có toolPattern regex sai — bỏ qua rule.`);
      return undefined;
    }
    rule.toolPattern = value.toolPattern as string;
  }
  if (value.argsPattern !== undefined) {
    if (!validRegex(value.argsPattern)) {
      onInvalid?.(`rule "${id}" có argsPattern regex sai — bỏ qua rule.`);
      return undefined;
    }
    rule.argsPattern = value.argsPattern as string;
  }
  if (typeof value.argsKey === 'string' && value.argsKey.trim()) {
    rule.argsKey = value.argsKey.trim();
  }
  if (rule.tool === undefined && rule.toolPattern === undefined && rule.argsPattern === undefined) {
    // Rule không khớp gì cả (không tool, không pattern) thì vô nghĩa —
    // giữ lại vẫn an toàn (không bao giờ khớp) nhưng báo cho user biết.
    onInvalid?.(`rule "${id}" không có điều kiện khớp nào — rule không bao giờ khớp.`);
  }
  return rule;
}

/** Validate một entry allowlist/denylist: `tool` hoặc `tool:regex`. */
export function validateRiskListEntry(
  value: unknown,
  onInvalid?: (reason: string) => void,
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const entry = value.trim();
  const colon = entry.indexOf(':');
  if (colon !== -1) {
    const pattern = entry.slice(colon + 1);
    if (!validRegex(pattern)) {
      onInvalid?.(`entry "${entry}" có regex sai — bỏ qua.`);
      return undefined;
    }
  }
  return entry;
}

function cleanStringList(
  value: unknown,
  onInvalid?: (reason: string) => void,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const cleaned = validateRiskListEntry(item, onInvalid);
    if (cleaned !== undefined && !out.includes(cleaned)) out.push(cleaned);
  }
  return out.slice(0, MAX_RISK_LIST_ENTRIES);
}

/**
 * Store rule risk trên đĩa. Đọc lười ở constructor (file thiếu/hỏng
 * → store rỗng, không throw); mọi thay đổi ghi ngay xuống đĩa (atomic).
 */
export class RiskRuleStore {
  private readonly filePath: string | undefined;
  private readonly onInvalid?: (reason: string) => void;
  private rules: RiskRule[] = [];
  private allowlist: string[] = [];
  private denylist: string[] = [];
  private disabledBuiltinRuleIds: string[] = [];

  constructor(dataDir?: string, options: RiskRuleStoreOptions = {}) {
    this.filePath = dataDir ? path.join(dataDir, RISK_RULES_FILE_NAME) : undefined;
    this.onInvalid = options.onInvalid;
    this.load();
  }

  /** Đường dẫn file (undefined = chỉ giữ trong bộ nhớ, không lưu đĩa). */
  get path(): string | undefined {
    return this.filePath;
  }

  /** Tất cả rule custom (bản sao — sửa ngoài không ảnh hưởng store). */
  listRules(): RiskRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  listAllowlist(): string[] {
    return [...this.allowlist];
  }

  listDenylist(): string[] {
    return [...this.denylist];
  }

  listDisabledBuiltinRuleIds(): string[] {
    return [...this.disabledBuiltinRuleIds];
  }

  /** Options cho RiskAnalyzer từ store hiện tại. */
  toAnalyzerOptions(): RiskAnalyzerOptions {
    return {
      extraRules: this.listRules(),
      allowlist: this.listAllowlist(),
      denylist: this.listDenylist(),
      disabledBuiltinRuleIds: this.listDisabledBuiltinRuleIds(),
    };
  }

  /** Thêm rule custom (id trùng → ghi đè). Trả về rule đã lưu. */
  addRule(rule: RiskRule): RiskRule {
    // Ghi lại lý do validate để throw kèm (UI/CLI báo lại cho user),
    // đồng thời vẫn gọi onInvalid để log như khi tải file.
    let reason = '';
    const validated = validateStoredRiskRule(rule, (r) => {
      reason = r;
      this.onInvalid?.(r);
    });
    if (!validated) throw new Error(`Rule risk không hợp lệ: ${reason}`);
    const idx = this.rules.findIndex((r) => r.id === validated.id);
    if (idx === -1) {
      if (this.rules.length >= MAX_CUSTOM_RISK_RULES) {
        throw new Error(`Đã đạt tối đa ${MAX_CUSTOM_RISK_RULES} rule custom.`);
      }
      this.rules.push(validated);
    } else {
      this.rules[idx] = validated;
    }
    this.save();
    return { ...validated };
  }

  /** Xoá rule theo id. Trả true khi có rule bị xoá. */
  removeRule(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.save();
    return true;
  }

  /** Thêm entry allowlist (trùng → không đúp). */
  addAllowlist(entry: string): boolean {
    const cleaned = validateRiskListEntry(entry, this.onInvalid);
    if (cleaned === undefined) throw new Error(`Entry allowlist không hợp lệ: ${String(entry)}`);
    if (this.allowlist.includes(cleaned)) return false;
    if (this.allowlist.length >= MAX_RISK_LIST_ENTRIES) {
      throw new Error(`Đã đạt tối đa ${MAX_RISK_LIST_ENTRIES} entry allowlist.`);
    }
    this.allowlist.push(cleaned);
    this.save();
    return true;
  }

  /** Xoá entry allowlist. */
  removeAllowlist(entry: string): boolean {
    const before = this.allowlist.length;
    this.allowlist = this.allowlist.filter((e) => e !== entry);
    if (this.allowlist.length === before) return false;
    this.save();
    return true;
  }

  /** Thêm entry denylist (trùng → không đúp). */
  addDenylist(entry: string): boolean {
    const cleaned = validateRiskListEntry(entry, this.onInvalid);
    if (cleaned === undefined) throw new Error(`Entry denylist không hợp lệ: ${String(entry)}`);
    if (this.denylist.includes(cleaned)) return false;
    if (this.denylist.length >= MAX_RISK_LIST_ENTRIES) {
      throw new Error(`Đã đạt tối đa ${MAX_RISK_LIST_ENTRIES} entry denylist.`);
    }
    this.denylist.push(cleaned);
    this.save();
    return true;
  }

  /** Xoá entry denylist. */
  removeDenylist(entry: string): boolean {
    const before = this.denylist.length;
    this.denylist = this.denylist.filter((e) => e !== entry);
    if (this.denylist.length === before) return false;
    this.save();
    return true;
  }

  /** Tắt một rule built-in theo id (vd rule gây nhiễu). */
  disableBuiltinRule(id: string): boolean {
    if (this.disabledBuiltinRuleIds.includes(id)) return false;
    this.disabledBuiltinRuleIds.push(id);
    this.save();
    return true;
  }

  /** Bật lại một rule built-in đã tắt. */
  enableBuiltinRule(id: string): boolean {
    const before = this.disabledBuiltinRuleIds.length;
    this.disabledBuiltinRuleIds = this.disabledBuiltinRuleIds.filter((r) => r !== id);
    if (this.disabledBuiltinRuleIds.length === before) return false;
    this.save();
    return true;
  }

  /** Đọc lại file từ đĩa (vd file bị sửa tay bên ngoài). */
  reload(): void {
    this.load();
  }

  private load(): void {
    this.rules = [];
    this.allowlist = [];
    this.denylist = [];
    this.disabledBuiltinRuleIds = [];
    if (!this.filePath) return; // Không có dataDir → chỉ giữ trong bộ nhớ.
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return; // File chưa có → store rỗng (lần đầu dùng).
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.onInvalid?.(`File ${RISK_RULES_FILE_NAME} hỏng JSON — dùng store rỗng.`);
      return;
    }
    if (!isRecord(parsed)) {
      this.onInvalid?.(`File ${RISK_RULES_FILE_NAME} không phải object — dùng store rỗng.`);
      return;
    }
    if (parsed.version !== RISK_RULES_FILE_VERSION) {
      this.onInvalid?.(
        `File ${RISK_RULES_FILE_NAME} version ${String(parsed.version)} khác ${RISK_RULES_FILE_VERSION} — đọc phần tương thích, bỏ phần lạ.`,
      );
    }
    if (Array.isArray(parsed.rules)) {
      for (const item of parsed.rules) {
        const rule = validateStoredRiskRule(item, this.onInvalid);
        if (rule && !this.rules.some((r) => r.id === rule.id)) this.rules.push(rule);
      }
      this.rules = this.rules.slice(0, MAX_CUSTOM_RISK_RULES);
    }
    this.allowlist = cleanStringList(parsed.allowlist, this.onInvalid);
    this.denylist = cleanStringList(parsed.denylist, this.onInvalid);
    this.disabledBuiltinRuleIds = cleanStringList(parsed.disabledBuiltinRuleIds, this.onInvalid);
  }

  private save(): void {
    if (!this.filePath) return; // Chỉ giữ trong bộ nhớ, không ghi đĩa.
    const payload: StoredRiskRules = {
      version: RISK_RULES_FILE_VERSION,
      rules: this.rules,
      allowlist: this.allowlist,
      denylist: this.denylist,
      disabledBuiltinRuleIds: this.disabledBuiltinRuleIds,
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // chmod trên hệ không hỗ trợ thì bỏ qua — file đã ghi xong.
    }
  }
}
