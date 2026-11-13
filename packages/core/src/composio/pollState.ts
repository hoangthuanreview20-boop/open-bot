/**
 * Trạng thái poll Composio bền vững (v0.98 Team T3).
 *
 * Vấn đề: `ComposioPoller` (v0.96) chỉ nhớ id đã thấy trong bộ nhớ —
 * restart app là quên hết, lần poll đầu sau restart sẽ coi mọi mail
 * 15 phút gần nhất là "mới" và chạy automation trùng. Tương tự, số
 * lần poll lỗi liên tiếp (để backoff) và thời điểm poll kế tiếp cũng
 * mất khi restart, nên backoff sau lỗi mạng dài sẽ reset về 0.
 *
 * Module này persist toàn bộ trạng thái đó xuống đĩa (một JSON file
 * `<stateDir>/composio-poll-state.json`, cùng thư mục với
 * `automations.json` của scheduler — xem `automations/scheduler.ts`
 * `JsonFileAutomationStore`, cùng quy ước ghi atomic tmp+rename và
 * file hỏng thì giữ lại `<file>.corrupt` rồi bắt đầu trống).
 *
 * Nội dung file — CHỈ metadata vận hành, KHÔNG BAO GIỜ chứa key,
 * token hay nội dung mail/item: tên poller, interval đã cấu hình,
 * thời điểm poll cuối/thành công cuối, lỗi cuối, số lỗi liên tiếp,
 * thời điểm poll kế tiếp, bộ đếm, và danh sách id đã thấy (kèm thời
 * điểm — để dedupe sống qua restart). Id item (vd id mail Gmail) là
 * opaque identifier của Composio, không phải secret.
 *
 * Hai store:
 * - `JsonFileComposioPollStateStore`: dùng thật (main process).
 * - `MemoryComposioPollStateStore`: dùng cho test (không chạm đĩa).
 * Cả hai cùng interface `ComposioPollStateStore` nên test thay thế
 * được mà không cần thư mục tạm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tên file trạng thái poll (nằm trong stateDir của app). */
export const COMPOSIO_POLL_STATE_FILE = 'composio-poll-state.json';
/** Số id đã thấy tối đa giữ lại cho một poller (cắt cũ nhất khi vượt). */
export const COMPOSIO_POLL_STATE_MAX_SEEN_IDS = 1000;
/** Version của doc trên đĩa (đổi khi shape state đổi không tương thích). */
export const COMPOSIO_POLL_STATE_VERSION = 1;

/** Một id item đã thấy, kèm thời điểm thấy (để cắt theo cửa sổ dedupe). */
export interface ComposioPollSeenId {
  id: string;
  at: number;
}

/** Trạng thái bền vững của một poller. */
export interface ComposioPollState {
  /** Tên poller (key trong doc), vd 'gmail-new-mail'. */
  name: string;
  /** Poller đang bật không (user tắt thì scheduler bỏ qua, giữ state). */
  enabled: boolean;
  /** Chu kỳ poll đã cấu hình, ms. */
  intervalMs: number;
  /** ms epoch lần poll gần nhất (kể cả lỗi), 0 khi chưa poll lần nào. */
  lastPolledAtMs: number;
  /** ms epoch lần poll thành công gần nhất, 0 khi chưa thành công lần nào. */
  lastSuccessAtMs: number;
  /** Thông báo lỗi của lần poll gần nhất (null khi lần cuối thành công). */
  lastError: string | null;
  /** Số lần poll lỗi liên tiếp (reset về 0 khi thành công — đầu vào backoff). */
  consecutiveFailures: number;
  /** ms epoch thời điểm poll kế tiếp (đã tính backoff — restart vẫn tôn trọng). */
  nextPollAtMs: number;
  /** Tổng số lần đã poll (kể cả lỗi). */
  totalPolls: number;
  /** Tổng số item mới đã tìm thấy (cộng dồn). */
  totalNewItems: number;
  /** Id đã thấy (kèm thời điểm) — dedupe sống qua restart. */
  seenIds: ComposioPollSeenId[];
}

/** Doc trên đĩa: version + state từng poller theo tên. */
export interface ComposioPollStateDoc {
  version: number;
  pollers: Record<string, ComposioPollState>;
}

/** Trạng thái mặc định của một poller chưa từng chạy. */
export function defaultComposioPollState(name: string, intervalMs: number): ComposioPollState {
  return {
    name,
    enabled: true,
    intervalMs,
    lastPolledAtMs: 0,
    lastSuccessAtMs: 0,
    lastError: null,
    consecutiveFailures: 0,
    nextPollAtMs: 0,
    totalPolls: 0,
    totalNewItems: 0,
    seenIds: [],
  };
}

/**
 * Validate + chuẩn hoá một state đọc từ đĩa (dữ liệu ngoài, có thể
 * hỏng): mọi field sai kiểu đều rơi về mặc định an toàn (fail-closed:
 * poller hỏng state thì poll lại từ đầu thay vì crash scheduler;
 * `enabled` chỉ true khi đúng `true`).
 */
export function resolveComposioPollState(raw: unknown, name: string, intervalMs: number): ComposioPollState {
  const base = defaultComposioPollState(name, intervalMs);
  if (raw === null || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  const seenRaw = Array.isArray(obj.seenIds) ? obj.seenIds : [];
  const seenIds: ComposioPollSeenId[] = [];
  for (const entry of seenRaw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
    seenIds.push({ id: e.id, at: e.at });
  }
  return {
    name,
    enabled: obj.enabled === true,
    intervalMs:
      typeof obj.intervalMs === 'number' && Number.isFinite(obj.intervalMs) && obj.intervalMs > 0
        ? Math.floor(obj.intervalMs)
        : intervalMs,
    lastPolledAtMs: toMs(obj.lastPolledAtMs),
    lastSuccessAtMs: toMs(obj.lastSuccessAtMs),
    lastError: typeof obj.lastError === 'string' ? obj.lastError : null,
    consecutiveFailures:
      typeof obj.consecutiveFailures === 'number' && Number.isFinite(obj.consecutiveFailures)
        ? Math.max(0, Math.floor(obj.consecutiveFailures))
        : 0,
    nextPollAtMs: toMs(obj.nextPollAtMs),
    totalPolls:
      typeof obj.totalPolls === 'number' && Number.isFinite(obj.totalPolls)
        ? Math.max(0, Math.floor(obj.totalPolls))
        : 0,
    totalNewItems:
      typeof obj.totalNewItems === 'number' && Number.isFinite(obj.totalNewItems)
        ? Math.max(0, Math.floor(obj.totalNewItems))
        : 0,
    seenIds: seenIds.slice(-COMPOSIO_POLL_STATE_MAX_SEEN_IDS),
  };
}

function toMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Validate + chuẩn hoá cả doc trên đĩa. */
export function resolveComposioPollStateDoc(raw: unknown): ComposioPollStateDoc {
  const pollers: Record<string, ComposioPollState> = {};
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.pollers !== null && typeof obj.pollers === 'object') {
      for (const [name, entry] of Object.entries(obj.pollers as Record<string, unknown>)) {
        if (typeof name !== 'string' || name === '') continue;
        const intervalMs =
          entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).intervalMs === 'number'
            ? Math.floor((entry as Record<string, unknown>).intervalMs as number)
            : 0;
        pollers[name] = resolveComposioPollState(entry, name, intervalMs > 0 ? intervalMs : 0);
      }
    }
  }
  return { version: COMPOSIO_POLL_STATE_VERSION, pollers };
}

/** Interface store để test thay thế bằng bộ nhớ (không chạm đĩa). */
export interface ComposioPollStateStore {
  /** Đọc state một poller (null khi chưa có — caller dùng default). */
  get(name: string): ComposioPollState | null;
  /** Đọc toàn bộ state (doc đã resolve — bản sao, sửa không ảnh hưởng store). */
  getAll(): ComposioPollStateDoc;
  /** Ghi đè state một poller (đã cắt seenIds về cap). */
  save(state: ComposioPollState): void;
  /** Xoá state một poller (vd user xoá poller). Trả false khi không có. */
  remove(name: string): boolean;
}

/** Cắt seenIds về cap, giữ id mới nhất (theo `at`). */
export function pruneComposioPollSeenIds(
  seenIds: ComposioPollSeenId[],
  max: number = COMPOSIO_POLL_STATE_MAX_SEEN_IDS,
): ComposioPollSeenId[] {
  if (seenIds.length <= max) return [...seenIds];
  return [...seenIds].sort((a, b) => a.at - b.at).slice(seenIds.length - max);
}

/** Store trên đĩa (xem header module — cùng quy ước với JsonFileAutomationStore). */
export class JsonFileComposioPollStateStore implements ComposioPollStateStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, COMPOSIO_POLL_STATE_FILE);
  }

  private read(): ComposioPollStateDoc {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { version: COMPOSIO_POLL_STATE_VERSION, pollers: {} };
    }
    try {
      return resolveComposioPollStateDoc(JSON.parse(raw) as unknown);
    } catch {
      try {
        fs.writeFileSync(`${this.file}.corrupt`, raw, 'utf8');
      } catch {
        // Best effort only.
      }
      return { version: COMPOSIO_POLL_STATE_VERSION, pollers: {} };
    }
  }

  private write(doc: ComposioPollStateDoc): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(name: string): ComposioPollState | null {
    return this.read().pollers[name] ?? null;
  }

  getAll(): ComposioPollStateDoc {
    return this.read();
  }

  save(state: ComposioPollState): void {
    const doc = this.read();
    doc.pollers[state.name] = { ...state, seenIds: pruneComposioPollSeenIds(state.seenIds) };
    doc.version = COMPOSIO_POLL_STATE_VERSION;
    this.write(doc);
  }

  remove(name: string): boolean {
    const doc = this.read();
    if (!(name in doc.pollers)) return false;
    delete doc.pollers[name];
    this.write(doc);
    return true;
  }
}

/** Store trong bộ nhớ — dùng cho test (không chạm đĩa). */
export class MemoryComposioPollStateStore implements ComposioPollStateStore {
  private readonly pollers = new Map<string, ComposioPollState>();

  get(name: string): ComposioPollState | null {
    const found = this.pollers.get(name);
    return found === undefined ? null : { ...found, seenIds: [...found.seenIds] };
  }

  getAll(): ComposioPollStateDoc {
    const pollers: Record<string, ComposioPollState> = {};
    for (const [name, state] of this.pollers) {
      pollers[name] = { ...state, seenIds: [...state.seenIds] };
    }
    return { version: COMPOSIO_POLL_STATE_VERSION, pollers };
  }

  save(state: ComposioPollState): void {
    this.pollers.set(state.name, { ...state, seenIds: pruneComposioPollSeenIds(state.seenIds) });
  }

  remove(name: string): boolean {
    return this.pollers.delete(name);
  }
}
