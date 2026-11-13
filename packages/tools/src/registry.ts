/**
 * ToolRegistry for @open-bot/tools.
 *
 * A small registry that owns the set of tools an agent may call. It
 * validates every tool definition on registration (name, description and
 * a well-formed JSON-Schema `parameters` object) and refuses duplicate
 * names, so a bad or colliding tool fails loudly at setup time instead of
 * silently confusing the model at call time.
 *
 * The registry does NOT decide approval — the agent core keeps doing
 * that from each tool's `needsApproval` flag. It CAN execute a tool via
 * `execute()` (v0.4): plain execution, or cached execution when a
 * ToolResultCache is attached and the tool is on the caller-supplied
 * read-only `cacheableTools` allowlist (default: cache nothing).
 */
import type { Tool, ToolContext, ToolDefinition } from '@open-bot/core';
import type { ToolResultCache } from '@open-bot/core/dist/perf/cache';
// v0.10a: lọc/gom tool theo ngữ cảnh — registry chỉ delegate sang core,
// giữ nguyên mọi API cũ (register/list/execute/cache). Import từ dist
// trực tiếp (như ToolResultCache ở trên) để không phụ thuộc barrel.
import {
  estimateToolsTokens as coreEstimateToolsTokens,
  filterTools as coreFilterTools,
  groupTools as coreGroupTools,
} from '@open-bot/core/dist/agent/toolFilter.js';
import type {
  GroupToolsOptions,
  ToolFilterOptions,
} from '@open-bot/core/dist/agent/toolFilter.js';
// P1-2 (v0.31): tool A2A client — đăng ký qua registerA2aTools() dưới đây.
// Chỉ user mới được thêm agent tin tưởng (UI); tool không tự trust.
import { createA2aTools } from './a2aTools';
import type { A2aToolOptions, TrustedA2aAgent, TrustedA2aAgentStore } from './a2aTools';

export { A2A_TOOLS, A2A_TOOL_NAMES, createA2aTools, createFileTrustedAgentStore, createMemoryTrustedAgentStore, trustedAgentFromCard } from './a2aTools';
export type { A2aToolOptions, TrustedA2aAgent, TrustedA2aAgentStore } from './a2aTools';

const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Validate a tool definition; throws with a clear message when invalid. */
export function validateToolDefinition(definition: ToolDefinition): void {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('Tool definition must be an object.');
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new Error('Tool definition must have a non-empty string "name".');
  }
  if (!TOOL_NAME_RE.test(definition.name)) {
    throw new Error(
      `Invalid tool name "${definition.name}": use only letters, digits, "-" and "_".`,
    );
  }
  if (typeof definition.description !== 'string' || definition.description.trim() === '') {
    throw new Error(`Tool "${definition.name}" must have a non-empty string "description".`);
  }
  const params = definition.parameters as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(
      `Tool "${definition.name}" must have a "parameters" object (JSON Schema).`,
    );
  }
  if (params['type'] !== 'object') {
    throw new Error(
      `Tool "${definition.name}" parameters must be a JSON Schema object (type: "object").`,
    );
  }
  const properties = params['properties'];
  if (
    properties !== undefined &&
    (typeof properties !== 'object' || properties === null || Array.isArray(properties))
  ) {
    throw new Error(`Tool "${definition.name}" parameters.properties must be an object.`);
  }
  const required = params['required'];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) {
      throw new Error(`Tool "${definition.name}" parameters.required must be an array of strings.`);
    }
    if (properties && typeof properties === 'object') {
      for (const name of required as string[]) {
        if (!(name in (properties as Record<string, unknown>))) {
          throw new Error(
            `Tool "${definition.name}": required parameter "${name}" is not declared in parameters.properties.`,
          );
        }
      }
    }
  }
}

function validateTool(tool: Tool): void {
  if (!tool || typeof tool !== 'object') {
    throw new Error('register() expects a Tool object.');
  }
  validateToolDefinition(tool.definition);
  if (typeof tool.execute !== 'function') {
    throw new Error(`Tool "${tool.definition.name}" must have an execute(args, ctx) function.`);
  }
  if (typeof tool.needsApproval !== 'boolean') {
    throw new Error(`Tool "${tool.definition.name}" must have a boolean needsApproval flag.`);
  }
}

export interface ToolRegistryOptions {
  /**
   * Cache kết quả tool (ToolResultCache ở @open-bot/core/perf). Không
   * bắt buộc — registry không có cache vẫn chạy như cũ.
   */
  cache?: ToolResultCache;
  /**
   * Danh sách tool ĐƯỢC cache (chỉ tool read-only). Mặc định rỗng:
   * không cache tool nào, kể cả khi đã gắn cache. Tool ghi file/shell
   * KHÔNG BAO GIỜ được đưa vào danh sách này.
   */
  cacheableTools?: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private cache?: ToolResultCache;
  private readonly cacheableTools = new Set<string>();

  /** `new ToolRegistry()` giữ nguyên hành vi cũ; truyền options để gắn cache. */
  constructor(options: ToolRegistryOptions = {}) {
    if (options.cache) this.cache = options.cache;
    for (const name of options.cacheableTools ?? []) this.cacheableTools.add(name);
  }

  /** Register a tool. Throws on a duplicate name or an invalid definition. */
  register(tool: Tool): void {
    validateTool(tool);
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered.`);
    }
    this.tools.set(name, tool);
  }

  /** Register several tools at once (same validation as register). */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Remove a tool by name. Returns true when a tool was actually removed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * P1-2 (v0.31): đăng ký 6 tool A2A client (`a2a_discover`,
   * `a2a_list_agents`, `a2a_send`, `a2a_status`, `a2a_cancel`,
   * `a2a_list_tasks`) vào registry này. v0.97 (Đội T2): + 2 tool
   * (`a2a_delegate` bot-bot, `a2a_verify_card` ký + version). Tool chỉ gọi agent mà user
   * đã tin tưởng (xem `A2aToolOptions.store` / `trustedAgentsFile`);
   * không truyền store thì dùng store trong bộ nhớ (trống).
   * Ném lỗi khi trùng tên như registerMany.
   */
  registerA2aTools(options: A2aToolOptions = {}): void {
    this.registerMany(createA2aTools(options));
  }

  /** Look up a tool by name, or undefined when not registered. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** True when a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** All registered tools, in registration order. Returns a copy. */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * v0.10a — lọc tool đã đăng ký theo ngữ cảnh (bot allowlist, skill
   * đang bật, mode; xem `ToolFilterOptions` ở @open-bot/core). Trả list
   * mới, registry gốc không đổi. Không options = trả toàn bộ list.
   *
   * v0.28 (P0-4 fallback) — fail-open CÓ KIỂM SOÁT khi filter rỗng bất
   * thường (đầu vào còn tool mà lọc xong không còn tool nào, vd skill
   * khai `allowed-tools` sai tên): thử lại chỉ với bot allowlist + mode
   * (bỏ lớp skill — lớp hay sai nhất) rồi trả list đó + log cảnh báo
   * `[tools]`. KHÔNG fallback vượt qua bot allowlist/denylist hay mode
   * plan/review (chỉ-đọc): hai lớp đó là ranh giới an toàn, nếu chúng
   * cũng không giữ tool nào thì trả rỗng (fail-closed) + log cảnh báo.
   */
  filterTools(options: ToolFilterOptions = {}): Tool[] {
    return this.filterWithFallback(options);
  }

  /**
   * v0.28 — lọc có fallback (xem `filterTools`): list rỗng bất thường
   * thì quay về baseline bot allowlist + mode, chưa bao giờ vượt qua
   * hai lớp an toàn đó. Baseline vẫn rỗng → trả rỗng + cảnh báo.
   */
  private filterWithFallback(options: ToolFilterOptions): Tool[] {
    const all = this.list();
    const filtered = coreFilterTools(all, options);
    if (filtered.length > 0 || all.length === 0) return filtered;
    const baseline = coreFilterTools(all, {
      bot: options.bot,
      permissions: options.permissions,
      policy: options.policy,
      mode: options.mode,
    });
    if (baseline.length > 0) {
      console.warn(
        `[tools] tool filter rỗng (mode=${options.mode ?? 'chat'} ` +
          `skills=${options.activeSkills?.length ?? 0}) — fallback sang ` +
          `${baseline.length}/${all.length} tool (bot allowlist + mode), bỏ lớp skill.`,
      );
      return baseline;
    }
    console.warn(
      `[tools] tool filter rỗng và bot allowlist/mode cũng không giữ tool nào ` +
        `(mode=${options.mode ?? 'chat'}) — trả rỗng (fail-closed, không fallback qua ranh giới an toàn).`,
    );
    return [];
  }

  /**
   * v0.10a — gom tool đã đăng ký theo nhóm thành tool điều phối
   * (vd `file.*` → một tool `file`). Trả list mới, registry gốc không đổi.
   */
  groupTools(options: GroupToolsOptions = {}): Tool[] {
    return coreGroupTools(this.list(), options);
  }

  /**
   * v0.10a — lọc rồi gom trong một lần gọi: đây là list nên đưa cho
   * model mỗi turn (ít definitions → ít token). Registry gốc không đổi.
   * v0.28: lọc có fallback như `filterTools` (rỗng bất thường → về
   * baseline bot allowlist + mode + cảnh báo) rồi mới gom nhóm.
   */
  filteredGroupedTools(
    options: ToolFilterOptions & GroupToolsOptions = {},
  ): Tool[] {
    return coreGroupTools(this.filterWithFallback(options), options);
  }

  /** v0.10a — tổng token ước lượng (chars/4) của một list tool (mặc định: toàn bộ registry). */
  estimateTokens(tools: Tool[] = this.list()): number {
    return coreEstimateToolsTokens(tools);
  }

  /** Number of registered tools. */
  size(): number {
    return this.tools.size;
  }

  /** Build a registry pre-filled with the given tools. */
  static fromDefaults(tools: Tool[], options: ToolRegistryOptions = {}): ToolRegistry {
    const registry = new ToolRegistry(options);
    for (const tool of tools) {
      registry.register(tool);
    }
    return registry;
  }

  /**
   * Gắn (hoặc thay) cache sau khi tạo registry. `cacheableTools` mới
   * thay thế danh sách cũ khi được truyền vào.
   */
  setCache(cache: ToolResultCache, cacheableTools?: string[]): void {
    this.cache = cache;
    if (cacheableTools !== undefined) {
      this.cacheableTools.clear();
      for (const name of cacheableTools) this.cacheableTools.add(name);
    }
  }

  /** True khi tool này được phép dùng cache (đã gắn cache + có trong danh sách). */
  isCacheable(name: string): boolean {
    return this.cache !== undefined && this.cacheableTools.has(name);
  }

  /**
   * Chạy một tool đã đăng ký (kèm cache khi tool được phép cache).
   * - Tool không trong danh sách cache (hoặc không gắn cache, hoặc tool
   *   ghi): chạy thẳng, không đọc/ghi cache.
   * - Tool được cache: lần 2 với cùng args trả kết quả cũ mà không chạy
   *   lại tool. Chỉ kết quả THÀNH CÔNG mới được lưu (tool ném lỗi thì
   *   lỗi lan ra như thường và không cache).
   * Throws khi tool chưa đăng ký.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Không rõ công cụ: ${name}`);
    }
    if (this.isCacheable(name) && this.cache) {
      const cached = this.cache.get(name, args);
      if (cached !== undefined) return cached;
      const output = await tool.execute(args, ctx);
      this.cache.set(name, args, output);
      return output;
    }
    return tool.execute(args, ctx);
  }

  /** Thống kê cache (null khi registry không gắn cache). */
  cacheStats(): ReturnType<ToolResultCache['stats']> | null {
    return this.cache ? this.cache.stats() : null;
  }

  /** Xoá toàn bộ cache đã gắn (không làm gì khi chưa gắn cache). */
  clearCache(): void {
    this.cache?.clear();
  }
}
