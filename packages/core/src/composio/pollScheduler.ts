/**
 * Scheduler nền cho Composio polling (v0.98 Team T3).
 *
 * Nối 3 mảnh v0.96 lại thành một vòng chạy tự động, không cần poll tay:
 *
 * ```
 * ComposioPoller (polling.ts — hỏi tool list/search định kỳ)
 *   → enqueueComposioPollResult (pollBridge.ts — item mới thành event)
 *   → ComposioTriggerQueue (triggerQueue.ts — đệm + dedupe)
 *   → onEventsEnqueued → AutomationScheduler.drainComposioTriggerQueue()
 *        (automations/scheduler.ts — automation có trigger 'composio'
 *         khớp triggerSlug tự chạy)
 * ```
 *
 * Những gì module này thêm so với chạy poller tay:
 * - Trạng thái poll BỀN VỮNG (`pollState.ts`): id đã thấy, số lỗi liên
 *   tiếp, thời điểm poll kế tiếp đều xuống đĩa sau mỗi lần poll —
 *   restart app không tạo event trùng, không reset backoff.
 * - Cấu hình khoảng poll từng poller (`setPollerInterval`, tối thiểu
 *   1 phút để không đốt quota Composio, tối đa 24 giờ), bật/tắt từng
 *   poller, persist cùng state.
 * - Backoff khi lỗi: poll lỗi thì lần sau đợi lâu hơn theo cấp số
 *   nhân (mặc định nền = interval, ×2 mỗi lỗi liên tiếp, trần 2 giờ),
 *   thành công thì reset về interval thường. Lỗi không crash timer,
 *   không xoá dedupe — lần sau poll lại bình thường.
 * - Timer theo chuỗi `setTimeout` (không phải `setInterval` cố định)
 *   để mỗi lần poll xong mới tính delay lần sau (interval thường hay
 *   backoff). Timer `unref` — không giữ process sống.
 * - `getStatus()` cho UI/IPC: mỗi poller hiện gì (lần poll cuối,
 *   lỗi cuối, poll kế tiếp, số item mới, số event đang chờ trong
 *   queue) — không chứa key/token/nội dung item.
 *
 * Module này KHÔNG tạo connection Composio mới, KHÔNG biết key là gì:
 * mỗi poller chạy tool qua `fetchItems` do host tiêm (host nối
 * `ComposioSessionManager.executeTools` thật; test tiêm mock) — cùng
 * quy tắc với `ComposioPoller`. Scheduler cũng KHÔNG chạy automation
 * trực tiếp: nó chỉ enqueue event rồi gọi callback
 * `onEventsEnqueued` để host (main process) gọi
 * `AutomationScheduler.drainComposioTriggerQueue()` — tránh vòng
 * import composio → automations.
 */

import {
  COMPOSIO_GMAIL_POLL_INTERVAL_MS,
  COMPOSIO_GMAIL_POLL_QUERY,
  COMPOSIO_POLL_DEDUPE_WINDOW_MS,
  COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS,
  ComposioPoller,
} from './polling';
import type { ComposioPollFetchFn, ComposioPollResult } from './polling';
import { COMPOSIO_GMAIL_POLL_TRIGGER_SLUG, enqueueComposioPollResult } from './pollBridge';
import type { ComposioTriggerQueue } from './triggerQueue';
import {
  COMPOSIO_POLL_STATE_MAX_SEEN_IDS,
  defaultComposioPollState,
  resolveComposioPollState,
} from './pollState';
import type { ComposioPollState, ComposioPollStateStore } from './pollState';

/** Khoảng poll tối thiểu: 1 phút (ngắn hơn sẽ đốt quota Composio vô ích). */
export const COMPOSIO_POLL_MIN_INTERVAL_MS = 60_000;
/** Khoảng poll tối đa: 24 giờ. */
export const COMPOSIO_POLL_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Trần backoff mặc định: 2 giờ (poll lỗi liên tục cũng không đợi quá 2 giờ). */
export const COMPOSIO_POLL_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;
/** Hệ số nhân backoff mặc định: mỗi lỗi liên tiếp nhân đôi thời gian đợi. */
export const COMPOSIO_POLL_BACKOFF_MULTIPLIER = 2;

/** Cấu hình một poller trong scheduler (một toolkit + một tool list/search). */
export interface ComposioPollEntryConfig {
  /** Tên gợi nhớ, vd 'gmail-new-mail' (key của state trên đĩa). */
  name: string;
  /** Toolkit slug Composio, vd 'gmail'. */
  toolkit: string;
  /** Slug tool list/search, vd 'GMAIL_FETCH_EMAILS'. */
  toolSlug: string;
  /** Argument cố định gửi kèm mỗi lần poll (vd query Gmail). */
  toolArgs?: Record<string, unknown>;
  /** Field trong item dùng làm id dedupe (vd 'id'). */
  idField?: string;
  /** Chu kỳ poll, ms (mặc định 15 phút; clamp vào [1 phút, 24 giờ]). */
  intervalMs?: number;
  /** Slug trigger gắn cho synthetic event (vd 'GMAIL_NEW_GMAIL_MESSAGE'). */
  triggerSlug: string;
  /** Bật poller này không (mặc định true). */
  enabled?: boolean;
  /** Hàm chạy tool (host tiêm — session manager thật hoặc mock test). */
  fetchItems: ComposioPollFetchFn;
  /** Cửa sổ nhớ id đã thấy, ms (mặc định 24h). */
  dedupeWindowMs?: number;
  /** Số item mới tối đa trả về mỗi lần poll (mặc định 25). */
  maxNewItems?: number;
  /** Nền backoff, ms (mặc định = intervalMs). */
  backoffBaseMs?: number;
  /** Trần backoff, ms (mặc định 2 giờ). */
  backoffMaxMs?: number;
  /** Hệ số nhân backoff (mặc định 2). */
  backoffMultiplier?: number;
}

/** Trạng thái hiển thị của một poller (cho UI/IPC — không chứa key/item). */
export interface ComposioPollStatus {
  name: string;
  toolkit: string;
  toolSlug: string;
  triggerSlug: string;
  enabled: boolean;
  /** Scheduler đang chạy timer cho poller này không. */
  running: boolean;
  intervalMs: number;
  lastPolledAtMs: number;
  lastSuccessAtMs: number;
  lastError: string | null;
  consecutiveFailures: number;
  nextPollAtMs: number;
  totalPolls: number;
  totalNewItems: number;
  /** Số id đang nhớ trong cửa sổ dedupe. */
  seenCount: number;
  /** Số event đang chờ trong queue chung lúc này. */
  queuePending: number;
}

/** Thông tin callback khi poller enqueue được event mới. */
export interface ComposioPollEnqueuedInfo {
  pollerName: string;
  enqueued: number;
}

export interface ComposioPollSchedulerOptions {
  /** Queue chung — event poll enqueue vào đây (host đọc/drain). */
  queue: ComposioTriggerQueue;
  /** Store trạng thái bền vững (file thật hoặc bộ nhớ cho test). */
  stateStore: ComposioPollStateStore;
  /** Clock tiêm được (test). */
  now?: () => number;
  /**
   * Gọi sau mỗi lần poll enqueue được event mới — host nối vào
   * `AutomationScheduler.drainComposioTriggerQueue()` để automation
   * khớp triggerSlug tự chạy. Lỗi trong callback không chặn poll sau.
   */
  onEventsEnqueued?: (info: ComposioPollEnqueuedInfo) => void | Promise<void>;
  /** Gọi sau mỗi lần poll (kể cả lỗi) — host dùng để log/status. */
  onPollResult?: (result: ComposioPollResult) => void;
}

/**
 * Delay lần poll sau khi lỗi liên tiếp `failures` lần: nền × hệ số
 * ^(failures-1), chặn trần. Lỗi đầu (failures=1) → đúng nền (thường
 * bằng interval); lỗi thứ 2 → ×2, thứ 3 → ×4… `failures <= 0` → 0
 * (không backoff khi không có lỗi).
 */
export function composioPollBackoffDelayMs(
  failures: number,
  baseMs: number,
  maxMs: number = COMPOSIO_POLL_BACKOFF_MAX_MS,
  multiplier: number = COMPOSIO_POLL_BACKOFF_MULTIPLIER,
): number {
  if (failures <= 0) return 0;
  if (!(baseMs > 0) || !Number.isFinite(baseMs)) return 0;
  if (!(maxMs > 0) || !Number.isFinite(maxMs)) maxMs = COMPOSIO_POLL_BACKOFF_MAX_MS;
  if (!(multiplier > 1) || !Number.isFinite(multiplier)) multiplier = COMPOSIO_POLL_BACKOFF_MULTIPLIER;
  let delay = baseMs;
  for (let i = 1; i < failures; i++) {
    delay = Math.min(delay * multiplier, maxMs);
    if (delay >= maxMs) break;
  }
  return Math.min(Math.floor(delay), maxMs);
}

/** Clamp interval vào [1 phút, 24 giờ]; giá trị không hợp lệ → mặc định Gmail 15 phút. */
export function clampComposioPollIntervalMs(intervalMs: unknown): number {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) {
    return COMPOSIO_GMAIL_POLL_INTERVAL_MS;
  }
  return Math.max(
    COMPOSIO_POLL_MIN_INTERVAL_MS,
    Math.min(COMPOSIO_POLL_MAX_INTERVAL_MS, Math.floor(intervalMs)),
  );
}

/**
 * Preset Gmail cho scheduler: poll mail mới qua `GMAIL_FETCH_EMAILS`,
 * event gắn slug trigger thật `GMAIL_NEW_GMAIL_MESSAGE` để automation
 * nghe slug đó nhận được cả event webhook lẫn event poll.
 */
export function createGmailComposioPollEntry(
  fetchItems: ComposioPollFetchFn,
  opts: { intervalMs?: number; query?: string } = {},
): ComposioPollEntryConfig {
  return {
    name: 'gmail-new-mail',
    toolkit: 'gmail',
    toolSlug: 'GMAIL_FETCH_EMAILS',
    toolArgs: { query: opts.query ?? COMPOSIO_GMAIL_POLL_QUERY, max_results: 10 },
    idField: 'messageId',
    intervalMs: opts.intervalMs ?? COMPOSIO_GMAIL_POLL_INTERVAL_MS,
    triggerSlug: COMPOSIO_GMAIL_POLL_TRIGGER_SLUG,
    fetchItems,
  };
}

/**
 * Slug trigger thật cho event poll GitHub (xem `triggers.ts`
 * COMPOSIO_TRIGGER_DEFS: delivery 'poll' — trigger này vốn đã là
 * dạng poll trên Composio, nên synthetic event poll khớp đúng slug
 * automation nghe).
 */
export const COMPOSIO_GITHUB_POLL_TRIGGER_SLUG = 'GITHUB_ISSUE_CREATED_TRIGGER';
/**
 * Slug trigger thật cho event poll Slack (xem `triggers.ts`:
 * `SLACK_CHANNEL_MESSAGE_RECEIVED`, delivery 'webhook' — automation
 * nghe slug này nhận được cả event webhook thật lẫn event poll).
 */
export const COMPOSIO_SLACK_POLL_TRIGGER_SLUG = 'SLACK_CHANNEL_MESSAGE_RECEIVED';

/**
 * Preset GitHub cho scheduler: poll issue mới trong MỘT repo qua
 * `GITHUB_SEARCH_ISSUES` (shape thật, live v0.98: tool trả
 * `{ items: [...], total_count, ... }`, mỗi issue có `id` số nguyên
 * — `composioPollItemId` đổi số thành string để dedupe; schema bắt
 * buộc field `q`, không phải `query`). `repo` bắt buộc dạng
 * 'owner/repo' (vd 'openbot1/open-bot') — không có default vì poller
 * phải biết rõ repo nào cần theo dõi; host chưa cấu hình repo thì
 * đừng đăng ký entry này.
 */
export function createGithubComposioPollEntry(
  fetchItems: ComposioPollFetchFn,
  opts: { repo: string; intervalMs?: number },
): ComposioPollEntryConfig {
  if (!opts.repo || !opts.repo.includes('/') || opts.repo.split('/').length !== 2) {
    throw new Error('createGithubComposioPollEntry cần repo dạng \'owner/repo\'.');
  }
  return {
    name: 'github-new-issues',
    toolkit: 'github',
    toolSlug: 'GITHUB_SEARCH_ISSUES',
    toolArgs: { q: `repo:${opts.repo}`, per_page: 10, sort: 'created', order: 'desc' },
    idField: 'id',
    intervalMs: opts.intervalMs ?? COMPOSIO_GMAIL_POLL_INTERVAL_MS,
    triggerSlug: COMPOSIO_GITHUB_POLL_TRIGGER_SLUG,
    fetchItems,
  };
}

/**
 * Preset Slack cho scheduler: poll tin nhắn mới qua
 * `SLACK_SEARCH_MESSAGES` (shape thật, live v0.98: tool trả
 * `{ messages: { matches: [...], paging, total }, ok, query }` —
 * parser bóc `messages.matches`; mỗi match có `ts` theo shape chuẩn
 * của Slack search). `query` bắt buộc (vd 'in:#social' để theo dõi
 * một kênh, hoặc một từ khoá) — Slack search là tìm theo nội dung,
 * không có API "liệt kê tin mới nhất" nên preset không đoán query
 * thay user. LƯU Ý live v0.98: workspace "open-bot" không có tin nào
 * khớp tìm kiếm nên chưa quan sát được match thật — `idField: 'ts'`
 * theo shape chuẩn của Slack (mỗi match có `ts` là id tin nhắn);
 * khi workspace có tin, poll lần đầu sẽ chứng minh trực tiếp.
 */
export function createSlackComposioPollEntry(
  fetchItems: ComposioPollFetchFn,
  opts: { query: string; intervalMs?: number },
): ComposioPollEntryConfig {
  if (!opts.query || !opts.query.trim()) {
    throw new Error('createSlackComposioPollEntry cần query tìm kiếm (vd \'in:#social\').');
  }
  return {
    name: 'slack-new-messages',
    toolkit: 'slack',
    toolSlug: 'SLACK_SEARCH_MESSAGES',
    toolArgs: { query: opts.query, count: 10 },
    idField: 'ts',
    intervalMs: opts.intervalMs ?? COMPOSIO_GMAIL_POLL_INTERVAL_MS,
    triggerSlug: COMPOSIO_SLACK_POLL_TRIGGER_SLUG,
    fetchItems,
  };
}

interface PollEntryRuntime {
  config: ComposioPollEntryConfig;
  poller: ComposioPoller;
  state: ComposioPollState;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

export class ComposioPollScheduler {
  private readonly queue: ComposioTriggerQueue;
  private readonly stateStore: ComposioPollStateStore;
  private readonly now: () => number;
  private readonly onEventsEnqueued?: ComposioPollSchedulerOptions['onEventsEnqueued'];
  private readonly onPollResult?: ComposioPollSchedulerOptions['onPollResult'];
  private readonly entries = new Map<string, PollEntryRuntime>();
  private started = false;

  constructor(entries: ComposioPollEntryConfig[], opts: ComposioPollSchedulerOptions) {
    if (!opts.queue || !opts.stateStore) {
      throw new Error('ComposioPollScheduler cần queue và stateStore.');
    }
    this.queue = opts.queue;
    this.stateStore = opts.stateStore;
    this.now = opts.now ?? Date.now;
    this.onEventsEnqueued = opts.onEventsEnqueued;
    this.onPollResult = opts.onPollResult;
    for (const config of entries) {
      if (!config.name || !config.toolkit || !config.toolSlug || !config.triggerSlug) {
        throw new Error('Mỗi Composio poll entry cần name, toolkit, toolSlug và triggerSlug.');
      }
      if (typeof config.fetchItems !== 'function') {
        throw new Error(`Poll entry "${config.name}" thiếu fetchItems.`);
      }
      if (this.entries.has(config.name)) {
        throw new Error(`Trùng tên poll entry: "${config.name}".`);
      }
      const intervalMs = clampComposioPollIntervalMs(config.intervalMs);
      const stored = this.stateStore.get(config.name);
      const state = resolveComposioPollState(stored, config.name, intervalMs);
      // Cấu hình code thắng state cũ về interval khi host đổi preset,
      // nhưng enabled/interval user đã chỉnh qua setPoller* thì giữ:
      // state đã lưu có interval riêng — chỉ dùng preset khi chưa có state.
      if (stored === null) {
        state.intervalMs = intervalMs;
        state.enabled = config.enabled !== false;
      } else {
        state.intervalMs = clampComposioPollIntervalMs(state.intervalMs);
      }
      const poller = new ComposioPoller({
        name: config.name,
        toolkit: config.toolkit,
        toolSlug: config.toolSlug,
        ...(config.toolArgs ? { toolArgs: config.toolArgs } : {}),
        ...(config.idField ? { idField: config.idField } : {}),
        intervalMs: state.intervalMs,
        maxNewItems: config.maxNewItems ?? COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS,
        dedupeWindowMs: config.dedupeWindowMs ?? COMPOSIO_POLL_DEDUPE_WINDOW_MS,
        fetchItems: config.fetchItems,
        now: this.now,
      });
      // Khôi phục dedupe đã persist — restart không tạo event trùng.
      poller.restoreSeen(state.seenIds);
      this.entries.set(config.name, { config: { ...config, intervalMs: state.intervalMs }, poller, state, timer: null, inFlight: false });
    }
  }

  /** Scheduler đang chạy không. */
  get running(): boolean {
    return this.started;
  }

  /** Tên các poller đã đăng ký. */
  pollerNames(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Bắt đầu chạy nền: mỗi poller đang bật poll ngay (trừ khi state
   * còn backoff chưa tới hạn — khi đó đợi tới `nextPollAtMs`), rồi
   * lặp theo interval/backoff. Gọi 2 lần không tạo timer đôi.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    for (const runtime of this.entries.values()) {
      if (!runtime.state.enabled) continue;
      const delay = runtime.state.nextPollAtMs > now ? runtime.state.nextPollAtMs - now : 0;
      this.schedule(runtime, delay);
    }
  }

  /** Dừng mọi timer nền (state đã persist sau mỗi lần poll nên không mất gì). */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const runtime of this.entries.values()) {
      this.clearTimer(runtime);
    }
  }

  /**
   * Poll tay một poller ngay (UI "Poll now" / test). Chạy được cả khi
   * scheduler chưa start; khi đang chạy nền thì reset luôn timer lần
   * sau (tính từ lúc poll tay này xong).
   */
  async pollNow(name: string): Promise<ComposioPollResult> {
    const runtime = this.entries.get(name);
    if (!runtime) throw new Error(`Không có poller Composio tên "${name}".`);
    return this.runPollCycle(runtime);
  }

  /** Bật/tắt một poller (persist ngay; tắt thì dừng timer, bật thì poll ngay). */
  setPollerEnabled(name: string, enabled: boolean): ComposioPollState {
    const runtime = this.entries.get(name);
    if (!runtime) throw new Error(`Không có poller Composio tên "${name}".`);
    runtime.state.enabled = enabled;
    this.persist(runtime);
    if (!enabled) {
      this.clearTimer(runtime);
    } else if (this.started) {
      this.schedule(runtime, 0);
    }
    return { ...runtime.state, seenIds: [...runtime.state.seenIds] };
  }

  /**
   * Đổi khoảng poll một poller (persist ngay; clamp [1 phút, 24 giờ]).
   * Timer lần sau tính lại theo interval mới (backoff đang chạy — nếu
   * có — vẫn tôn trọng tới khi poll thành công).
   */
  setPollerInterval(name: string, intervalMs: number): ComposioPollState {
    const runtime = this.entries.get(name);
    if (!runtime) throw new Error(`Không có poller Composio tên "${name}".`);
    const clamped = clampComposioPollIntervalMs(intervalMs);
    runtime.state.intervalMs = clamped;
    runtime.config = { ...runtime.config, intervalMs: clamped };
    this.persist(runtime);
    return { ...runtime.state, seenIds: [...runtime.state.seenIds] };
  }

  /** Trạng thái hiển thị của mọi poller (cho UI/IPC). */
  getStatus(): ComposioPollStatus[] {
    const queuePending = this.queue.stats().pending;
    return [...this.entries.values()].map((runtime) => ({
      name: runtime.config.name,
      toolkit: runtime.config.toolkit,
      toolSlug: runtime.config.toolSlug,
      triggerSlug: runtime.config.triggerSlug,
      enabled: runtime.state.enabled,
      running: this.started && runtime.state.enabled && runtime.timer !== null,
      intervalMs: runtime.state.intervalMs,
      lastPolledAtMs: runtime.state.lastPolledAtMs,
      lastSuccessAtMs: runtime.state.lastSuccessAtMs,
      lastError: runtime.state.lastError,
      consecutiveFailures: runtime.state.consecutiveFailures,
      nextPollAtMs: runtime.state.nextPollAtMs,
      totalPolls: runtime.state.totalPolls,
      totalNewItems: runtime.state.totalNewItems,
      seenCount: runtime.poller.seenCount,
      queuePending,
    }));
  }

  /** Trạng thái bền vững của một poller (bản sao — sửa không ảnh hưởng store). */
  getState(name: string): ComposioPollState | null {
    const runtime = this.entries.get(name);
    if (!runtime) return null;
    return { ...runtime.state, seenIds: [...runtime.state.seenIds] };
  }

  private persist(runtime: PollEntryRuntime): void {
    runtime.state.seenIds = runtime.poller.seenSnapshot().slice(-COMPOSIO_POLL_STATE_MAX_SEEN_IDS);
    try {
      this.stateStore.save({ ...runtime.state, seenIds: [...runtime.state.seenIds] });
    } catch {
      // Ghi state lỗi không được chặn poll/automation — lần poll sau
      // ghi lại; lỗi ghi đĩa đã có log ở host nếu cần.
    }
  }

  private clearTimer(runtime: PollEntryRuntime): void {
    if (runtime.timer !== null) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }

  private schedule(runtime: PollEntryRuntime, delayMs: number): void {
    this.clearTimer(runtime);
    const delay = Math.max(0, Math.floor(delayMs));
    const timer = setTimeout(() => {
      runtime.timer = null;
      void this.runPollCycle(runtime).catch(() => undefined);
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    runtime.timer = timer;
  }

  /**
   * Một chu kỳ poll: chạy tool, cập nhật + persist state (kể cả khi
   * lỗi), enqueue item mới vào queue, báo host drain queue. Không bao
   * giờ ném (lỗi poll đã nằm trong result + state). Poll tay và poll
   * theo timer đi chung một chu kỳ — timer nền tính lại từ lần này.
   */
  private async runPollCycle(runtime: PollEntryRuntime): Promise<ComposioPollResult> {
    if (runtime.inFlight) {
      // Lần poll trước chưa xong (tool chậm) — bỏ qua tick này, không
      // chạy chồng; timer lần sau vẫn được lên lịch ở finally.
      return (
        runtime.poller.last ?? {
          name: runtime.config.name,
          polledAtMs: this.now(),
          newItems: [],
          totalFetched: 0,
          error: 'Poll trước chưa xong — bỏ qua tick này.',
        }
      );
    }
    runtime.inFlight = true;
    const now = this.now();
    let result: ComposioPollResult;
    try {
      result = await runtime.poller.pollOnce();
    } catch (err) {
      // pollOnce theo hợp đồng không ném, nhưng fail-closed: ghi lỗi
      // vào state thay vì crash scheduler.
      result = {
        name: runtime.config.name,
        polledAtMs: now,
        newItems: [],
        totalFetched: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      runtime.inFlight = false;
    }
    const atMs = result.polledAtMs;
    runtime.state.lastPolledAtMs = atMs;
    runtime.state.totalPolls += 1;
    if (result.error) {
      runtime.state.consecutiveFailures += 1;
      runtime.state.lastError = result.error;
      const base = runtime.config.backoffBaseMs ?? runtime.state.intervalMs;
      const delay = composioPollBackoffDelayMs(
        runtime.state.consecutiveFailures,
        base,
        runtime.config.backoffMaxMs ?? COMPOSIO_POLL_BACKOFF_MAX_MS,
        runtime.config.backoffMultiplier ?? COMPOSIO_POLL_BACKOFF_MULTIPLIER,
      );
      runtime.state.nextPollAtMs = atMs + delay;
    } else {
      runtime.state.lastSuccessAtMs = atMs;
      runtime.state.consecutiveFailures = 0;
      runtime.state.lastError = null;
      runtime.state.totalNewItems += result.newItems.length;
      runtime.state.nextPollAtMs = atMs + runtime.state.intervalMs;
    }
    this.persist(runtime);
    let enqueued = 0;
    if (!result.error && result.newItems.length > 0) {
      enqueued = enqueueComposioPollResult(this.queue, result, { triggerSlug: runtime.config.triggerSlug });
    }
    try {
      this.onPollResult?.(result);
    } catch {
      // Callback host lỗi không chặn chu kỳ sau.
    }
    if (enqueued > 0) {
      try {
        await this.onEventsEnqueued?.({ pollerName: runtime.config.name, enqueued });
      } catch {
        // Drain queue lỗi (vd automation lỗi) không chặn poll sau —
        // event đã ở trong queue, lần drain sau vẫn lấy được nếu còn TTL.
      }
    }
    // Lên lịch lần sau (kể cả poll tay — timer nền tính từ lần này).
    // Khi scheduler đã dừng thì không đặt timer mới.
    if (this.started && runtime.state.enabled) {
      const delay = Math.max(0, runtime.state.nextPollAtMs - this.now());
      this.schedule(runtime, delay);
    }
    return result;
  }
}
