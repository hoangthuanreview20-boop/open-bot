/**
 * Pause/resume/fork cho run log (v1.01, Đội T1).
 *
 * - `RunPauseGate`: cổng mà loop `await` ở biên mỗi step (và biên
 *   tool call). Khi gate đóng (paused), `waitIfPaused()` treo cho tới
 *   khi `resume()` mở lại, hoặc `abort()` ném lỗi huỷ. Gate là
 *   in-memory (không bền vững qua restart process) — log trên đĩa
 *   vẫn ghi `run.paused`/`run.resumed` nên trạng thái pause/resume
 *   được audit đầy đủ; sau restart, run đang paused được coi như
 *   phải resume bằng tay (ghi rõ trong doc của recorder).
 * - `pauseRun` / `resumeRun`: ghi event vào log + đóng/mở gate.
 *   Gate sống trong `RunControlRegistry` (map runId → gate) để
 *   coordinator/UI tìm được gate của run đang chạy.
 * - `forkRun`: tạo run con từ một seq của run cha — sao chép prefix
 *   event (tới seq đó) sang file log mới, ghi `run.forked` ở cả hai
 *   phía. Run con có `parentRunId` + `forkFromSeq` trong event
 *   `run.started` của nó; run cha không bị ảnh hưởng.
 */

import { randomUUID } from 'node:crypto';

import type { RunLogStore } from './store';
import type { RunPausePayload } from './types';

/** Lỗi ném ra khi gate bị abort trong lúc pause. */
export class RunGateAbortedError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} đã bị huỷ trong lúc tạm dừng.`);
    this.name = 'RunGateAbortedError';
  }
}

/**
 * Cổng tạm dừng một run. Loop gọi `waitIfPaused()` ở biên step:
 * - Gate mở → trả về ngay (không overhead đáng kể).
 * - Gate đóng → promise treo tới khi `resume()` hoặc `abort()`.
 * `pause()` khi đã pause là no-op; `resume()` khi đang chạy cũng
 * no-op — UI bấm pause hai lần không hỏng gì.
 */
export class RunPauseGate {
  private paused = false;
  private aborted = false;
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(private readonly runId: string) {}

  get isPaused(): boolean {
    return this.paused;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  pause(): void {
    if (this.aborted) return;
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
  }

  /** Huỷ run đang pause: mọi `waitIfPaused()` đang treo đều reject. */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(new RunGateAbortedError(this.runId));
  }

  /**
   * Treo khi gate đang đóng. Gọi ở biên step / biên tool call.
   * Không bao giờ treo khi gate mở — loop gọi mỗi step mà không sợ
   * tốn chi phí (một lần kiểm tra boolean).
   */
  waitIfPaused(): Promise<void> {
    if (!this.paused) {
      if (this.aborted) return Promise.reject(new RunGateAbortedError(this.runId));
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

/** Interface tối thiểu mà loop cần để chờ gate (dễ mock trong test). */
export interface RunPauseGateLike {
  waitIfPaused(): Promise<void>;
}

/**
 * Registry giữ gate của các run đang chạy (in-memory). Coordinator
 * tạo một registry dùng chung; UI/CLI tra gate qua `get` để pause/
 * resume/abort một run đang chạy. Run kết thúc thì `remove` gate để
 * không rò bộ nhớ.
 */
export class RunControlRegistry {
  private readonly gates = new Map<string, RunPauseGate>();

  /** Lấy gate của run, tạo mới nếu chưa có. */
  getOrCreate(runId: string): RunPauseGate {
    let gate = this.gates.get(runId);
    if (!gate) {
      gate = new RunPauseGate(runId);
      this.gates.set(runId, gate);
    }
    return gate;
  }

  get(runId: string): RunPauseGate | undefined {
    return this.gates.get(runId);
  }

  remove(runId: string): void {
    this.gates.delete(runId);
  }

  get size(): number {
    return this.gates.size;
  }
}

/** Kết quả pause/resume — kèm event đã ghi vào log. */
export interface PauseResumeResult {
  runId: string;
  /** true khi trạng thái thật sự đổi (false khi đã pause/resume rồi). */
  changed: boolean;
  seq: number;
}

/**
 * Tạm dừng một run: đóng gate (nếu run đang chạy) + ghi event
 * `run.paused` vào log. Khi run không có gate (đã kết thúc hoặc
 * chưa chạy trên process này) thì chỉ ghi event — log vẫn đúng,
 * gate không có gì để đóng.
 */
export function pauseRun(
  store: RunLogStore,
  registry: RunControlRegistry,
  runId: string,
  payload: RunPausePayload,
): PauseResumeResult {
  const gate = registry.get(runId);
  const alreadyPaused = gate?.isPaused === true;
  gate?.pause();
  const event = store.append(runId, { type: 'run.paused', payload });
  return { runId, changed: !alreadyPaused, seq: event.seq };
}

/** Tiếp tục một run đã pause: mở gate + ghi event `run.resumed`. */
export function resumeRun(
  store: RunLogStore,
  registry: RunControlRegistry,
  runId: string,
  payload: RunPausePayload,
): PauseResumeResult {
  const gate = registry.get(runId);
  const wasPaused = gate?.isPaused === true;
  gate?.resume();
  const event = store.append(runId, { type: 'run.resumed', payload });
  return { runId, changed: wasPaused, seq: event.seq };
}

/** Kết quả fork — id run con + seq fork ở hai phía. */
export interface ForkRunResult {
  parentRunId: string;
  childRunId: string;
  /** Seq trong run cha mà fork sao chép tới (bao gồm). */
  forkFromSeq: number;
  /** Số event đã sao chép sang run con (chưa tính `run.started`/`run.forked` của con). */
  copiedEvents: number;
}

/**
 * Fork một run tại một seq: tạo run con mới, sao chép prefix event
 * của cha (seq 1..forkFromSeq) sang log con, rồi ghi `run.forked`
 * ở cả hai phía.
 *
 * - `forkFromSeq` mặc định = seq cuối hiện tại của cha (fork từ "hiện tại").
 * - Run con bắt đầu bằng event `run.started` riêng (mang
 *   `parentRunId` + `forkFromSeq`), rồi tới prefix đã sao chép, rồi
 *   `run.forked` (side `child`). Run cha chỉ thêm một `run.forked`
 *   (side `parent`) — lịch sử cha không bị sửa (append-only).
 * - Prefix sao chép được ghi với seq/hash MỚI của run con (hash phụ
 *   thuộc runId) — nội dung `at`/`type`/`payload` giữ nguyên, nên
 *   replay của con tới điểm fork cho cùng trạng thái với cha.
 * - Fork run đã kết thúc vẫn được (fork để xem lại / chạy tiếp từ
 *   một điểm cũ); fork từ seq 0 = fork rỗng (chỉ có started+forked).
 */
export function forkRun(
  store: RunLogStore,
  parentRunId: string,
  options: {
    /** Id run con — mặc định random UUID. */
    childRunId?: string;
    /** Seq trong run cha để fork (mặc định = seq cuối). */
    fromSeq?: number;
    /** Bot của run con (mặc định = bot của run cha). */
    botId?: string;
    /** Model/provider của run con. */
    model?: string;
    providerId?: string;
  } = {},
): ForkRunResult {
  const parent = store.readRun(parentRunId);
  if (parent.events.length === 0) {
    throw new Error(`Không fork được: run ${parentRunId} chưa có event nào.`);
  }
  const lastSeq = parent.events[parent.events.length - 1]!.seq;
  const forkFromSeq = options.fromSeq ?? lastSeq;
  if (forkFromSeq < 0 || forkFromSeq > lastSeq) {
    throw new Error(`forkFromSeq ${forkFromSeq} ngoài khoảng 0..${lastSeq} của run ${parentRunId}.`);
  }
  const childRunId = options.childRunId ?? randomUUID();
  if (store.exists(childRunId)) {
    throw new Error(`Run con ${childRunId} đã tồn tại — fork bị từ chối để không ghi đè log.`);
  }
  const parentStarted = parent.events.find((e) => e.type === 'run.started');
  const parentBotId =
    options.botId ??
    (parentStarted?.payload as { botId?: string } | undefined)?.botId ??
    '';
  // 1. Event `run.started` của con (ghi rõ cha + điểm fork).
  store.append(childRunId, {
    type: 'run.started',
    payload: {
      botId: parentBotId,
      parentRunId,
      forkFromSeq,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
      title: `Fork từ ${parentRunId} @seq ${forkFromSeq}`,
    },
  });
  // 2. Sao chép prefix của cha (bỏ `run.started` gốc của cha — con
  // đã có started riêng; bỏ cả `run.forked` cũ để tránh vòng lặp
  // fork lồng nhau ghi sai ngữ cảnh).
  const prefix = parent.events.filter(
    (e) => e.seq <= forkFromSeq && e.type !== 'run.started' && e.type !== 'run.forked',
  );
  store.appendMany(
    childRunId,
    prefix.map((e) => ({ type: e.type, payload: e.payload, at: e.at })),
  );
  // 3. Ghi `run.forked` ở cả hai phía. `atSeq` của con là seq mà
  // event `run.forked` này sẽ mang (số event hiện có + 1).
  const childSeqBeforeFork = store.readRun(childRunId).events.length;
  store.append(childRunId, {
    type: 'run.forked',
    payload: { otherRunId: parentRunId, atSeq: childSeqBeforeFork + 1, side: 'child' },
  });
  store.append(parentRunId, {
    type: 'run.forked',
    payload: { otherRunId: childRunId, atSeq: forkFromSeq, side: 'parent' },
  });
  return { parentRunId, childRunId, forkFromSeq, copiedEvents: prefix.length };
}
