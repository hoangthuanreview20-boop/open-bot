/**
 * Composio app-event polling (v0.96 Team T4).
 *
 * Không phải toolkit nào cũng có webhook realtime: nhiều trigger
 * Composio là dạng poll (Gmail, Google Drive, Zoom, Salesforce... —
 * xem `triggers.ts` COMPOSIO_TRIGGER_DEFS: delivery 'poll'). Với
 * các app đó, cách nhận event khi webhook không tới được (Local API
 * chỉ loopback, user chưa dựng tunnel) là HỎI ĐỊNH KỲ bằng chính tool
 * Composio đã có: gọi tool list/search của toolkit qua Tool Router
 * (COMPOSIO_MULTI_EXECUTE_TOOL, wire shape đã xác nhận v0.72) rồi
 * đối chiếu với lần poll trước để tìm item MỚI.
 *
 * Module này KHÔNG tạo connection mới (dùng session + connected
 * account đã có trong Composio — trigger instance vẫn do user tạo
 * trong Composio khi muốn webhook; polling là đường thay thế khi
 * webhook không tới được), KHÔNG gọi API Composio trực tiếp: mọi lần
 * fetch đều đi qua một `fetchItems` do host tiêm (host nối
 * `ComposioToolRouter.executeTool` thật; test tiêm mock). Vì vậy
 * module này không cần key, không biết key là gì.
 *
 * Mặc định: Gmail poll 15 phút (`GMAIL_FETCH_EMAILS`, query mặc
 * định 'newer_than:15m' — chỉ lấy mail 15 phút gần nhất), dedupe
 * theo id mail trong cửa sổ 24h, mỗi lần poll tối đa 25 item mới.
 * Poller chung dùng được cho mọi toolkit có tool list/search:
 *  - Google Drive: `GOOGLEDRIVE_LIST_FILES` (dedupe theo file id)
 *  - GitHub: `GITHUB_SEARCH_ISSUES` (dedupe theo issue id)
 *  - Slack: `SLACK_SEARCH_MESSAGES` (dedupe theo ts)
 *  - Zoom: `ZOOM_LIST_ALL_RECORDINGS` (dedupe theo recording id)
 *  - ...bất kỳ tool list/search nào, miễn caller cho biết field id.
 *
 * An toàn: poll lỗi (mất mạng, session hết hạn, connection chưa
 * Active) thì ghi lỗi vào lần poll đó, KHÔNG crash, KHÔNG xoá trạng
 * thái dedupe — lần sau poll lại bình thường. Timer dùng
 * `setInterval` có unref (không giữ process sống).
 */

/** Một item thô trả về từ tool list/search (phải là object có id). */
export type ComposioPollItem = Record<string, unknown>;

/** Hàm host tiêm: chạy tool Composio và trả danh sách item thô. */
export type ComposioPollFetchFn = (args: Record<string, unknown>) => Promise<ComposioPollItem[]>;

/** Cấu hình một poller (một toolkit + một tool list/search). */
export interface ComposioPollerConfig {
  /** Tên gợi nhớ, vd 'gmail-new-mail'. */
  name: string;
  /** Toolkit slug Composio, vd 'gmail'. */
  toolkit: string;
  /** Slug tool list/search, vd 'GMAIL_FETCH_EMAILS'. */
  toolSlug: string;
  /** Argument cố định gửi kèm mỗi lần poll (vd query Gmail). */
  toolArgs?: Record<string, unknown>;
  /** Field trong item dùng làm id dedupe (vd 'id', 'messageId'). */
  idField?: string;
  /** Chu kỳ poll, ms (mặc định 15 phút). */
  intervalMs?: number;
  /** Số item mới tối đa trả về mỗi lần poll (mặc định 25). */
  maxNewItems?: number;
  /** Cửa sổ nhớ id đã thấy, ms (mặc định 24h). */
  dedupeWindowMs?: number;
  /** Hàm chạy tool (host tiêm — router thật hoặc mock test). */
  fetchItems: ComposioPollFetchFn;
  /** Clock tiêm được (test). */
  now?: () => number;
}

/** Kết quả một lần poll. */
export interface ComposioPollResult {
  /** Tên poller. */
  name: string;
  /** ms epoch lúc poll. */
  polledAtMs: number;
  /** Item mới (chưa từng thấy trong cửa sổ dedupe), tối đa maxNewItems. */
  newItems: ComposioPollItem[];
  /** Tổng số item tool trả về lần này (kể cả đã thấy). */
  totalFetched: number;
  /** Lỗi lần poll này (nếu có — newItems rỗng, dedupe giữ nguyên). */
  error?: string;
}

/** Mặc định Gmail: poll 15 phút, nhớ id 24h, tối đa 25 mail mới/lần. */
export const COMPOSIO_GMAIL_POLL_INTERVAL_MS = 15 * 60 * 1000;
export const COMPOSIO_POLL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS = 25;
/** Query Gmail mặc định: chỉ mail 15 phút gần nhất (khớp chu kỳ poll). */
export const COMPOSIO_GMAIL_POLL_QUERY = 'newer_than:15m';

/**
 * Preset Gmail: poll mail mới 15 phút/lần qua `GMAIL_FETCH_EMAILS`.
 * Host chỉ cần tiêm `fetchItems` (nối router.executeTool) là chạy.
 * Id dedupe: field 'messageId' của mail — SHAPE THẬT (live v0.98):
 * `GMAIL_FETCH_EMAILS` trả `{ messages: [...], nextPageToken,
 * resultSizeEstimate }`, mỗi message có `messageId` (KHÔNG có `id`
 * như ghi chú v0.96 đoán). Dedupe vẫn chạy được trước v0.98 nhờ
 * fallback 'messageId' trong `composioPollItemId`, nhưng preset
 * phải ghi đúng field thật để không lệ thuộc fallback.
 *
 * max_results = 10 (KHÔNG phải 25 như v0.96): đo live v0.98 —
 * max_results 25 khiến server trả `data_preview` cắt ngắn (chỉ 3
 * mail đầu) thay vì `data` đầy đủ; 10–15 vẫn trả đủ `data`. Poller
 * vẫn cap item mới/lần ở 25 (COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS)
 * nhưng tool chỉ xin 10/lần để tránh cắt ngắn — hộp thư quá 10 mail
 * mới/15 phút thì số còn lại vào poll sau (vẫn trong cửa sổ 15m).
 */
export function createGmailPollerConfig(
  fetchItems: ComposioPollFetchFn,
  opts: { intervalMs?: number; query?: string; now?: () => number } = {},
): ComposioPollerConfig {
  return {
    name: 'gmail-new-mail',
    toolkit: 'gmail',
    toolSlug: 'GMAIL_FETCH_EMAILS',
    toolArgs: { query: opts.query ?? COMPOSIO_GMAIL_POLL_QUERY, max_results: 10 },
    idField: 'messageId',
    intervalMs: opts.intervalMs ?? COMPOSIO_GMAIL_POLL_INTERVAL_MS,
    maxNewItems: COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS,
    dedupeWindowMs: COMPOSIO_POLL_DEDUPE_WINDOW_MS,
    fetchItems,
    ...(opts.now ? { now: opts.now } : {}),
  };
}

/** Lấy id dedupe của một item: field idField, fallback 'id' rồi 'messageId'. */
export function composioPollItemId(item: ComposioPollItem, idField?: string): string | undefined {
  const candidates = [idField, 'id', 'messageId', 'ts', 'uuid'].filter(
    (f): f is string => typeof f === 'string' && f !== '',
  );
  for (const field of candidates) {
    const value = item[field];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Bóc danh sách item thô từ output text của MULTI_EXECUTE (v0.98).
 *
 * Hai shape wire đều gặp live (xem live.mjs `parseMultiExecuteResults`
 * + probe shape v0.98):
 * - Đường `ComposioSessionManager.executeTools` (main process +
 *   scheduler nền): text JSON `{ successful, data: { results: [{
 *   response: { successful, data: <toolData> }, tool_slug, index }],
 *   total_count, ... }, error, log_id }` — results nằm trong `data`.
 * - Đường MCP trực tiếp (`mcpClient.callTool`, live.mjs): text JSON
 *   `{ results: [{ response: { data: <toolData> }, ... }] }` — results
 *   ở top-level.
 * `<toolData>` của tool list/search thường là object có mảng
 * `messages` (Gmail — `{ messages: [...], nextPageToken,
 * resultSizeEstimate }`, mỗi message có `messageId`), hoặc chính nó
 * là mảng (tool khác). Hàm thử lần lượt các key đã gặp
 * (`messages`/`data`/`emails`/`items`/`results`); không khớp shape
 * nào thì trả [] thay vì ném (poller coi như lần này không có item
 * mới — lỗi parse không được biến thành event giả).
 *
 * BẪY `data_preview` (live v0.98): khi kết quả tool QUÁ LỚN, server
 * không trả `response.data` đầy đủ mà trả `response.data_preview`
 * CẮT NGẮN (đo thật với GMAIL_FETCH_EMAILS: max_results 15 → `data`
 * đủ 15 mail; max_results 25 → `data_preview` chỉ 3 mail đầu).
 * Hàm chấp nhận `data_preview` làm fallback (có 3 mail còn hơn 0),
 * nhưng preset Gmail dùng max_results 10 để thường xuyên nhận đủ
 * `data` — xem `createGmailPollerConfig`.
 */
export function parseComposioPollItems(outputText: string): ComposioPollItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText) as unknown;
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const results = Array.isArray(root.results)
    ? root.results
    : Array.isArray((root.data as Record<string, unknown> | undefined)?.results)
      ? ((root.data as Record<string, unknown>).results as unknown[])
      : null;
  if (!results || results.length === 0) return [];
  const first = results[0] as { response?: unknown; data?: unknown };
  const resp = first?.response as { data?: unknown; data_preview?: unknown } | undefined;
  const toolData = resp?.data ?? resp?.data_preview ?? first?.data;
  if (Array.isArray(toolData)) return toolData as ComposioPollItem[];
  if (toolData !== null && typeof toolData === 'object') {
    const obj = toolData as Record<string, unknown>;
    for (const key of ['messages', 'data', 'emails', 'items', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as ComposioPollItem[];
    }
    // Slack search: `{ messages: { matches: [...], paging, total } }`
    // — `messages` là object, không phải mảng (shape thật, live v0.98).
    const messages = obj.messages;
    if (messages !== null && typeof messages === 'object') {
      const matches = (messages as Record<string, unknown>).matches;
      if (Array.isArray(matches)) return matches as ComposioPollItem[];
    }
  }
  return [];
}

/**
 * Một poller: chạy tool định kỳ, trả về chỉ item MỚI.
 *
 * Dedupe: nhớ id đã thấy kèm thời điểm (cửa sổ dedupeWindowMs);
 * item không có id thì vẫn trả về (không dedupe được — tốt hơn là
 * bỏ sót event) nhưng không chiếm slot nhớ. Lỗi fetch: trả result
 * có `error`, không đụng tới trạng thái dedupe.
 */
export class ComposioPoller {
  readonly name: string;
  readonly toolkit: string;
  readonly toolSlug: string;
  readonly intervalMs: number;
  private readonly config: ComposioPollerConfig;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ComposioPollResult | null = null;
  private pollCount = 0;

  constructor(config: ComposioPollerConfig) {
    if (!config.name || !config.toolkit || !config.toolSlug || typeof config.fetchItems !== 'function') {
      throw new Error('ComposioPoller cần name, toolkit, toolSlug và fetchItems.');
    }
    this.config = config;
    this.name = config.name;
    this.toolkit = config.toolkit;
    this.toolSlug = config.toolSlug;
    this.intervalMs =
      config.intervalMs !== undefined && config.intervalMs > 0
        ? Math.floor(config.intervalMs)
        : COMPOSIO_GMAIL_POLL_INTERVAL_MS;
    this.now = config.now ?? Date.now;
  }

  /** Poller đang chạy timer không. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Số lần đã poll (kể cả lỗi). */
  get polls(): number {
    return this.pollCount;
  }

  /** Kết quả lần poll gần nhất (null khi chưa poll lần nào). */
  get last(): ComposioPollResult | null {
    return this.lastResult;
  }

  /** Xoá trạng thái dedupe đã nhớ (vd user đổi tài khoản). */
  forgetSeen(): void {
    this.seen.clear();
  }

  /**
   * Khôi phục trạng thái dedupe đã persist (v0.98, pollScheduler):
   * nạp lại các id đã thấy kèm thời điểm — chỉ giữ id còn trong cửa
   * sổ dedupe (id quá hạn bị bỏ, lần poll sau sẽ thấy lại như mới).
   * Gọi lúc scheduler khởi động để restart app không tạo event trùng.
   */
  restoreSeen(ids: Array<{ id: string; at: number }>): void {
    const now = this.now();
    const windowMs = this.config.dedupeWindowMs ?? COMPOSIO_POLL_DEDUPE_WINDOW_MS;
    for (const entry of ids) {
      if (typeof entry.id !== 'string' || entry.id === '') continue;
      if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue;
      if (now - entry.at > windowMs) continue;
      this.seen.set(entry.id, entry.at);
    }
    this.purgeSeen(now);
  }

  /** Snapshot các id đang nhớ (để pollScheduler persist sau mỗi lần poll). */
  seenSnapshot(): Array<{ id: string; at: number }> {
    this.purgeSeen(this.now());
    return [...this.seen.entries()].map(([id, at]) => ({ id, at }));
  }

  /** Số id đang nhớ trong cửa sổ dedupe. */
  get seenCount(): number {
    return this.seen.size;
  }

  private purgeSeen(now: number): void {
    const windowMs = this.config.dedupeWindowMs ?? COMPOSIO_POLL_DEDUPE_WINDOW_MS;
    for (const [id, at] of [...this.seen.entries()]) {
      if (now - at > windowMs) this.seen.delete(id);
    }
  }

  /** Một lần poll: chạy tool, lọc item mới, cập nhật dedupe. Không bao giờ ném. */
  async pollOnce(): Promise<ComposioPollResult> {
    const now = this.now();
    this.pollCount++;
    this.purgeSeen(now);
    let fetched: ComposioPollItem[];
    try {
      const out = await this.config.fetchItems({ ...(this.config.toolArgs ?? {}) });
      if (!Array.isArray(out)) throw new Error(`Tool ${this.toolSlug} trả về không phải danh sách.`);
      fetched = out;
    } catch (err) {
      const result: ComposioPollResult = {
        name: this.name,
        polledAtMs: now,
        newItems: [],
        totalFetched: 0,
        error: (err as Error).message,
      };
      this.lastResult = result;
      return result;
    }
    const maxNew = this.config.maxNewItems ?? COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS;
    const fresh: ComposioPollItem[] = [];
    for (const item of fetched) {
      if (!item || typeof item !== 'object') continue;
      const id = composioPollItemId(item, this.config.idField);
      if (id === undefined) {
        // Không dedupe được thì vẫn báo là mới (bỏ sót còn tệ hơn trùng).
        if (fresh.length < maxNew) fresh.push(item);
        continue;
      }
      if (!this.seen.has(id)) {
        this.seen.set(id, now);
        if (fresh.length < maxNew) fresh.push(item);
      }
    }
    const result: ComposioPollResult = {
      name: this.name,
      polledAtMs: now,
      newItems: fresh,
      totalFetched: fetched.length,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Chạy định kỳ: poll ngay một lần rồi lặp theo intervalMs; mỗi lần
   * có item mới thì gọi `onNewItems`. Lỗi poll không dừng timer.
   * Gọi `stop()` để dừng. Gọi `start()` lần 2 khi đang chạy thì
   * không làm gì (không tạo timer đôi).
   */
  start(onNewItems: (result: ComposioPollResult) => void): void {
    if (this.timer !== null) return;
    const tick = async () => {
      const result = await this.pollOnce();
      if (result.newItems.length > 0 || result.error) onNewItems(result);
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Dừng timer định kỳ (pollOnce vẫn gọi tay được). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
