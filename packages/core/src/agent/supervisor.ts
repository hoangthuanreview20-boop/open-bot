/**
 * Supervisor / swarm routing — v0.14 mục 7.
 *
 * Chọn agent phù hợp nhất cho một task dựa trên năng lực đã khai báo
 * (skill + mô tả), dùng được cho cả bot local lẫn agent A2A remote:
 * năng lực của bot local lấy từ skill descriptions (xem
 * `packages/core/src/skills/registry.ts` — skill có `name` +
 * `description` + `whenToUse`), năng lực của agent remote lấy từ
 * Agent Card A2A (xem `packages/core/src/a2a/types.ts` —
 * `A2aAgentCard { name, description, url, skills?: A2aAgentSkill[] }`
 * với `A2aAgentSkill { id, name, description, tags? }`; đọc card bằng
 * `fetchAgentCard(baseUrl)` trong `packages/core/src/a2a/client.ts`).
 * Coordinator tự build `AgentCapability` từ hai nguồn đó rồi đăng ký
 * vào router — module này không tự đọc card hay registry (không gọi
 * mạng, không chạm filesystem).
 *
 * Chấm điểm hoàn toàn bằng khớp từ khoá (tokenize đơn giản, hỗ trợ
 * tiếng Việt: lowercase + tách từ có dấu), không phụ thuộc model.
 * Supervisor chỉ chọn agent + gọi callback handoff do coordinator
 * truyền vào — KHÔNG import handoff.ts/coordinator (tránh phụ thuộc
 * vòng tròn). Handoff thật dùng `createHandoff()` /
 * `formatHandoffForPrompt()` trong `packages/core/src/agent/handoff.ts`
 * (payload `{ fromBot, toBot, reason, transcript, ... }`, tối đa
 * `MAX_HANDOFF_HOPS` = 5 hop); coordinator là bên dựng payload đó
 * rồi đưa vào callback `handoff(agentId, task)`.
 */

/** Loại agent supervisor có thể điều phối. */
export type AgentKind = 'local-bot' | 'a2a';

/**
 * Năng lực của một agent, do coordinator khai báo khi đăng ký.
 * - Bot local: `description` = mô tả bot, `skills` = tên các skill
 *   của bot (vd `['translate', 'code-review']`); có thể kèm thêm
 *   mô tả skill trong `description` để scoring khớp từ khoá tốt hơn.
 * - Agent A2A remote: `description` = `card.description`,
 *   `skills` = `card.skills.map(s => s.id)` (hoặc `s.name`),
 *   `agentCardUrl` = URL gốc của agent (để `fetchAgentCard` đọc lại
 *   khi cần), `maxParallel` = số task song song tối đa agent nhận.
 */
export interface AgentCapability {
  /** Id duy nhất, vd tên bot local hoặc tên trong Agent Card. */
  id: string;
  kind: AgentKind;
  /** Mô tả năng lực (mô tả bot / card.description). */
  description: string;
  /** Tên skill agent có (skill local hoặc card.skills[].id/name). */
  skills: string[];
  /** URL gốc của agent A2A (chỉ dùng khi kind = 'a2a'). */
  agentCardUrl?: string;
  /** Số task song song tối đa; mặc định 1 (không giới hạn khi = 0). */
  maxParallel?: number;
}

/** Kết quả chấm điểm một agent cho một task. */
export interface AgentScore {
  agentId: string;
  /** Điểm 0–1 (0 = không khớp gì, 1 = khớp toàn bộ từ khoá task). */
  score: number;
  /** Skill của agent xuất hiện trong task. */
  matchedSkills: string[];
  /** Lý do từng điểm cộng (tiếng Việt, để debug/giải thích). */
  reasons: string[];
}

/** Kết quả dispatch tới một agent. */
export interface DispatchResult<T = unknown> {
  agentId: string;
  /** Điểm routing của agent này cho task. */
  score: number;
  /** Kết quả callback handoff trả về (chỉ có khi thành công). */
  result?: T;
  /** Lỗi (chỉ có khi agent lỗi / callback ném lỗi). */
  error?: string;
}

/** Callback thực thi task trên một agent — do coordinator truyền vào. */
export type HandoffCallback<T = unknown> = (agentId: string, task: string) => Promise<T>;

export interface RouteOptions {
  /** Id các agent bỏ qua ở lần route này. */
  excludeIds?: string[];
}

export interface DispatchOptions<T = unknown> {
  /** Các agent tham gia dispatch (đăng ký tạm cho lần này, không ghi đè router). */
  agents?: AgentCapability[];
  /** Callback chạy task trên agent được chọn — bắt buộc. */
  handoff: HandoffCallback<T>;
  /**
   * Chế độ dispatch:
   * - 'sequential' (mặc định): thử agent tốt nhất, lỗi thì thử agent
   *   tiếp theo, tối đa `maxAttempts` lần.
   * - 'parallel': dispatch tới top-N agent cùng lúc, gom kết quả.
   */
  mode?: 'sequential' | 'parallel';
  /** Số agent thử tối đa ở chế độ sequential (mặc định 3). */
  maxAttempts?: number;
  /** Số agent dispatch cùng lúc ở chế độ parallel (mặc định 3). */
  topN?: number;
  /** Id các agent bỏ qua. */
  excludeIds?: string[];
}

/** Số lần thử tối đa mặc định ở chế độ sequential. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Số agent song song mặc định ở chế độ parallel. */
export const DEFAULT_TOP_N = 3;

// ---------------------------------------------------------------------------
// Tokenize + chấm điểm (không phụ thuộc model)
// ---------------------------------------------------------------------------

/**
 * Tách task/mô tả thành token: lowercase, giữ chữ có dấu tiếng Việt
 * (à–ỹ, đ) + chữ số, bỏ token 1 ký tự (vd "a", "ở" lẻ). Dấu gạch
 * nối/gạch dưới trong tên skill được tách thành từ riêng để khớp
 * với task viết bằng khoảng trắng (vd skill `code-review` khớp
 * "review code").
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]+/u)
    .filter((t) => t.length > 1);
}

/** Token của một skill: tách tên skill + mô tả skill (nếu có trong description). */
function skillTokens(skillName: string): string[] {
  return tokenize(skillName.replace(/[-_]+/g, ' '));
}

/**
 * Chấm điểm một agent cho một task, trả về điểm 0–1.
 *
 * Cách tính (tổng có trọng số, chuẩn hoá về 0–1):
 * - Mỗi token của task khớp với token trong `description` của agent: +1.
 * - Mỗi token của task khớp với token trong TÊN skill: +3 (tên skill
 *   là tín hiệu mạnh nhất — vd task "dịch tài liệu" khớp skill
 *   `translate`).
 * - Skill name xuất hiện NGUYÊN VẸN trong task (vd task chứa đúng
 *   "code-review"): +5 và ghi vào `matchedSkills`.
 * - Điểm thô chia cho `taskTokens * 5` rồi kẹp 0–1, để task ngắn
 *   khớp hết vẫn đạt 1 và task dài khớp một phần được điểm tương ứng.
 * Task rỗng → điểm 0, không lỗi (lỗi task rỗng thuộc về router/dispatch).
 */
export function scoreAgent(task: string, agent: AgentCapability): AgentScore {
  const taskText = task.toLowerCase();
  const taskTokens = new Set(tokenize(task));
  const matchedSkills: string[] = [];
  const reasons: string[] = [];
  if (taskTokens.size === 0) {
    return { agentId: agent.id, score: 0, matchedSkills, reasons: ['Task rỗng — không có từ khoá để chấm điểm.'] };
  }

  let raw = 0;
  const descTokens = new Set(tokenize(agent.description ?? ''));
  for (const token of taskTokens) {
    if (descTokens.has(token)) {
      raw += 1;
      reasons.push(`Từ khoá "${token}" khớp với mô tả của agent "${agent.id}".`);
    }
  }
  for (const skill of agent.skills ?? []) {
    const name = skill.trim();
    if (!name) continue;
    // Skill name nguyên vẹn xuất hiện trong task (vd "code-review", "translate").
    if (taskText.includes(name.toLowerCase())) {
      raw += 5;
      matchedSkills.push(name);
      reasons.push(`Skill "${name}" xuất hiện trong task — agent "${agent.id}" chuyên về việc này.`);
      continue;
    }
    // Khớp từng token của tên skill (vd skill "code-review" khớp task "review code").
    const tokens = skillTokens(name);
    let hits = 0;
    for (const token of tokens) {
      if (taskTokens.has(token)) hits += 1;
    }
    if (hits > 0) {
      raw += 3 * hits;
      matchedSkills.push(name);
      reasons.push(`Skill "${name}" khớp ${hits} từ khoá trong task (${tokens.filter((t) => taskTokens.has(t)).join(', ')}).`);
    }
  }

  const maxRaw = taskTokens.size * 5;
  const score = Math.min(1, raw / maxRaw);
  if (raw === 0) {
    reasons.push(`Agent "${agent.id}" không khớp từ khoá nào trong task.`);
  }
  return { agentId: agent.id, score, matchedSkills, reasons };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Router chọn agent theo năng lực + tải hiện tại.
 * - `register(agent)`: thêm/ghi đè agent theo `id` (id rỗng → lỗi).
 * - `route(task)`: agent điểm cao nhất; hoà điểm → agent ít việc
 *   đang chạy (`inFlight`) nhất; vẫn hoà → id nhỏ nhất (ổn định).
 * - `inFlight` được theo dõi qua `beginTask(id)` / `endTask(id)` —
 *   coordinator/supervisor gọi khi bắt đầu/kết thúc một task thật.
 */
export class SupervisorRouter {
  private readonly agents = new Map<string, AgentCapability>();
  private readonly inFlight = new Map<string, number>();

  /** Đăng ký (hoặc ghi đè) một agent. Id rỗng → lỗi tiếng Việt. */
  register(agent: AgentCapability): void {
    const id = agent.id?.trim();
    if (!id) throw new Error('Đăng ký agent cần `id` không rỗng.');
    this.agents.set(id, { ...agent, id, skills: [...(agent.skills ?? [])] });
    if (!this.inFlight.has(id)) this.inFlight.set(id, 0);
  }

  /** Xoá agent khỏi router (trả về true khi agent đã tồn tại). */
  unregister(agentId: string): boolean {
    const existed = this.agents.delete(agentId);
    this.inFlight.delete(agentId);
    return existed;
  }

  /** Tất cả agent đã đăng ký (bản sao, theo thứ tự đăng ký). */
  list(): AgentCapability[] {
    return [...this.agents.values()].map((a) => ({ ...a, skills: [...a.skills] }));
  }

  /** Số task đang chạy trên agent này (0 khi chưa đăng ký / chưa chạy gì). */
  inFlightCount(agentId: string): number {
    return this.inFlight.get(agentId) ?? 0;
  }

  /** Đánh dấu bắt đầu một task trên agent (tăng inFlight). Agent chưa đăng ký → lỗi. */
  beginTask(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new Error(`Không theo dõi task cho agent chưa đăng ký: "${agentId}".`);
    }
    this.inFlight.set(agentId, (this.inFlight.get(agentId) ?? 0) + 1);
  }

  /** Đánh dấu kết thúc một task trên agent (giảm inFlight, không xuống dưới 0). */
  endTask(agentId: string): void {
    if (!this.agents.has(agentId)) return;
    this.inFlight.set(agentId, Math.max(0, (this.inFlight.get(agentId) ?? 0) - 1));
  }

  /**
   * Xếp hạng TẤT CẢ agent cho task (điểm cao trước, hoà điểm thì
   * inFlight thấp trước, vẫn hoà thì id nhỏ trước). Task rỗng → lỗi;
   * chưa có agent nào → lỗi. Trả về cả agent điểm 0 (để caller thấy
   * toàn bộ thứ hạng) — `route()` chỉ lấy đầu bảng.
   */
  routeAll(task: string, opts: RouteOptions = {}): AgentScore[] {
    if (!task || !task.trim()) {
      throw new Error('Routing cần task không rỗng — mô tả việc cần làm để chọn agent phù hợp.');
    }
    const excluded = new Set(opts.excludeIds ?? []);
    const candidates = [...this.agents.values()].filter((a) => !excluded.has(a.id));
    if (candidates.length === 0) {
      throw new Error(
        excluded.size > 0
          ? 'Không còn agent nào để routing sau khi loại trừ — kiểm tra lại danh sách excludeIds.'
          : 'Chưa có agent nào được đăng ký — đăng ký ít nhất một agent bằng register() trước khi routing.',
      );
    }
    const scored = candidates.map((agent) => scoreAgent(task, agent));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const loadA = this.inFlightCount(a.agentId);
      const loadB = this.inFlightCount(b.agentId);
      if (loadA !== loadB) return loadA - loadB;
      return a.agentId.localeCompare(b.agentId);
    });
    return scored;
  }

  /** Agent phù hợp nhất cho task (đầu bảng của `routeAll`). */
  route(task: string, opts: RouteOptions = {}): AgentScore {
    return this.routeAll(task, opts)[0];
  }

  /** Lấy capability đã đăng ký theo id (undefined khi chưa đăng ký). */
  get(agentId: string): AgentCapability | undefined {
    const agent = this.agents.get(agentId);
    return agent ? { ...agent, skills: [...agent.skills] } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Supervisor — chọn agent + dispatch qua callback handoff của coordinator
// ---------------------------------------------------------------------------

/**
 * Supervisor: dùng `SupervisorRouter` để chọn agent, rồi giao việc
 * qua callback `handoff` do coordinator truyền vào — callback này
 * là nơi coordinator dựng payload handoff thật (`createHandoff()`)
 * và chạy agent (bot local hoặc A2A remote). Supervisor KHÔNG import
 * handoff/coordinator nên không có phụ thuộc vòng tròn.
 *
 * `dispatch()` nhận thêm `agents` để dispatch một lần với danh sách
 * agent riêng (không ghi đè agent đã đăng ký trong router).
 */
export class Supervisor {
  readonly router: SupervisorRouter;

  constructor(router?: SupervisorRouter) {
    this.router = router ?? new SupervisorRouter();
  }

  /** Đăng ký agent vào router dùng chung (shortcut cho `router.register`). */
  register(agent: AgentCapability): void {
    this.router.register(agent);
  }

  /**
   * Dispatch một task.
   * - sequential (mặc định): thử agent tốt nhất, nếu callback lỗi thì
   *   thử agent tiếp theo, tối đa `maxAttempts` lần (mặc định 3).
   *   Trả về kết quả của agent đầu tiên thành công; tất cả đều lỗi
   *   thì trả về mảng lỗi của từng agent đã thử (error gộp, không throw).
   * - parallel: dispatch tới top-N agent cùng lúc (mặc định 3), gom
   *   đủ kết quả (agent lỗi vẫn có entry với `error`, không kéo sập
   *   cả nhóm).
   * Task rỗng / không có agent / thiếu callback `handoff` → throw lỗi
   * tiếng Việt rõ ràng.
   */
  async dispatch<T = unknown>(task: string, opts: DispatchOptions<T>): Promise<DispatchResult<T>[]> {
    if (!task || !task.trim()) {
      throw new Error('Dispatch cần task không rỗng — mô tả việc cần làm để chọn agent phù hợp.');
    }
    if (!opts || typeof opts.handoff !== 'function') {
      throw new Error('Dispatch cần callback `handoff(agentId, task)` — coordinator truyền vào để chạy agent được chọn.');
    }
    const router = this.buildRouter(opts.agents);
    const mode = opts.mode ?? 'sequential';
    if (mode === 'parallel') {
      const topN = Math.max(1, Math.floor(opts.topN ?? DEFAULT_TOP_N));
      const ranked = router.routeAll(task, { excludeIds: opts.excludeIds }).slice(0, topN);
      const results = await Promise.all(
        ranked.map(async (entry) => this.runOne(router, entry, task, opts.handoff)),
      );
      return results;
    }
    // sequential
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const ranked = router.routeAll(task, { excludeIds: opts.excludeIds });
    const tried: DispatchResult<T>[] = [];
    const exclude = new Set(opts.excludeIds ?? []);
    for (const entry of ranked) {
      if (tried.length >= maxAttempts) break;
      if (exclude.has(entry.agentId)) continue;
      const result = await this.runOne(router, entry, task, opts.handoff);
      tried.push(result);
      if (!result.error) return [result];
    }
    return tried;
  }

  /** Router dùng cho lần dispatch này: agent riêng (nếu có) + agent đã đăng ký. */
  private buildRouter(agents?: AgentCapability[]): SupervisorRouter {
    if (!agents || agents.length === 0) return this.router;
    const router = new SupervisorRouter();
    for (const agent of this.router.list()) router.register(agent);
    for (const agent of agents) router.register(agent);
    return router;
  }

  /** Chạy một agent qua callback, theo dõi inFlight, lỗi → entry có `error` (không throw). */
  private async runOne<T>(
    router: SupervisorRouter,
    entry: AgentScore,
    task: string,
    handoff: HandoffCallback<T>,
  ): Promise<DispatchResult<T>> {
    router.beginTask(entry.agentId);
    try {
      const result = await handoff(entry.agentId, task);
      return { agentId: entry.agentId, score: entry.score, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        agentId: entry.agentId,
        score: entry.score,
        error: `Agent "${entry.agentId}" lỗi khi nhận task: ${message}`,
      };
    } finally {
      router.endTask(entry.agentId);
    }
  }
}
