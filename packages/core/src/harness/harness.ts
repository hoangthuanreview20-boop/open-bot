/**
 * LocalHarness (M5) — facade gom registry + event bus + NDJSON log +
 * snapshot + permission broker thành một đối tượng duy nhất.
 *
 * Coordinator giữ MỘT harness (qua `CoordinatorOptions.harness`);
 * desktop main sẽ dựng nó với `dataDir` (userData) để log/snapshot
 * ghi đĩa. Không có dataDir thì harness vẫn chạy đầy đủ bus +
 * registry + broker, chỉ không ghi đĩa (dùng cho test in-process).
 *
 * Luồng event: driver CLI emit `CliEvent` qua sink đã gắn
 * (`attachToProvider`) → bus publish envelope chuẩn + NDJSON log
 * append (thread = botId khi driver không báo thread riêng). Callback
 * `onCliEvent` cũ của driver vẫn chạy song song (harness không thay
 * thế nó — driver gọi cả hai, xem providers/cli).
 *
 * Luồng permission: driver ACP/Codex gọi `permissionHandler()` →
 * broker (mặc định từ chối; có UI thì chờ quyết, timeout thì từ chối).
 */

import * as path from 'node:path';

import type { Provider } from '../types';
import type { CliEvent } from '../providers/cli/types';
import { HarnessEventBus } from './bus';
import { PermissionBroker } from './broker';
import { ThreadLog, sanitizeHarnessPayload } from './ndjson';
import { HarnessRegistry } from './registry';
import { readHarnessSnapshot, writeHarnessSnapshotAtomic } from './snapshot';
import type {
  HarnessDecidePermissionResult,
  HarnessEvent,
  HarnessEventKind,
  HarnessInstanceSnapshot,
  HarnessPermissionRequest,
  HarnessSnapshotFile,
  HarnessStatusResult,
  PermissionDecisionRecord,
  ThreadLogPage,
} from './types';

export interface LocalHarnessOptions {
  /**
   * Thư mục dữ liệu (userData): log NDJSON `<dataDir>/harness-logs/`,
   * snapshot `<dataDir>/harness-snapshot.json`. Không set → không ghi đĩa.
   */
  dataDir?: string;
  /** Timeout chờ user quyết permission (ms); mặc định 120s (broker). */
  permissionTimeoutMs?: number;
  /**
   * Handler UI cho thẻ duyệt permission: nhận request, trả true =
   * cho phép. Không set → broker từ chối ngay (fail-closed).
   * Desktop main sẽ set handler này để mở thẻ duyệt trong chat.
   * Request ở đây là `HarnessPermissionRequest` đầy đủ (có requestId)
   * — broker luôn truyền đúng shape này.
   */
  permissionUiHandler?: (
    request: HarnessPermissionRequest,
  ) => boolean | null | undefined | Promise<boolean | null | undefined>;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
}

/**
 * Provider CLI tối thiểu mà harness cần để đăng ký instance: có
 * `dispose()` (kill process) và (tuỳ chọn) `cliPid` + gắn sink event
 * `attachHarnessSink`. Driver M1–M4 đều có 3 thứ này; mock provider
 * trong test chỉ cần `dispose`.
 */
export interface HarnessAttachableProvider {
  dispose?: () => void | Promise<void>;
  cliPid?: number;
  attachHarnessSink?: (sink: (event: CliEvent) => void) => void;
  attachPermissionHandler?: (
    handler: (request: {
      method: string;
      detail?: string;
      allowable: boolean;
    }) => Promise<boolean>,
  ) => void;
}

export class LocalHarness {
  readonly bus = new HarnessEventBus();
  readonly registry = new HarnessRegistry();
  readonly broker: PermissionBroker;
  readonly log: ThreadLog | null;
  readonly dataDir?: string;
  private readonly warn: (message: string) => void;
  /**
   * v0.60: provider (đã unwrap MeteredProvider) đang gắn với mỗi bot
   * — để `attachToProvider` nhận ra re-attach cùng provider (trả
   * snapshot hiện có) thay vì throw "đã có instance sống". Chỉ tra
   * khi registry còn instance sống của bot đó; entry thừa sau
   * unregister không ảnh hưởng vì `getByBotId` khi đó trả undefined.
   */
  private readonly attachedProviders = new Map<string, HarnessAttachableProvider>();

  constructor(options: LocalHarnessOptions = {}) {
    this.dataDir = options.dataDir;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : () => undefined;
    this.log = options.dataDir
      ? new ThreadLog(path.join(options.dataDir, 'harness-logs'), {
          logger: { warn: this.warn },
        })
      : null;
    // v0.50 (M8): bọc permissionUiHandler để promise UI không treo mãi
    // khi quyết định tới bằng đường khác (decide()/timeout/shutdown):
    // broker chỉ resolve promise của REQUEST, còn promise UI handler trả
    // về vẫn treo nếu handler không tự resolve (vd handler chỉ emit
    // event rồi chờ user bấm thẻ ở tiến trình khác). Map này giữ resolve
    // của từng request; callback onDecision (chạy cho MỌI quyết định:
    // ui, decide, timeout, default-deny, shutdown) resolve nó, nên
    // promise UI luôn kết thúc cùng quyết định — không rò rỉ.
    const uiPending = new Map<string, (allowed: boolean) => void>();
    const wrappedUiHandler =
      options.permissionUiHandler === undefined
        ? undefined
        : (request: HarnessPermissionRequest): Promise<boolean | null | undefined> =>
            new Promise<boolean>((resolve) => {
              uiPending.set(request.requestId, resolve);
              void Promise.resolve()
                .then(() => options.permissionUiHandler?.(request))
                .then(
                  (answer) => {
                    const pending = uiPending.get(request.requestId);
                    if (!pending) return; // Đã quyết bằng decide()/timeout.
                    uiPending.delete(request.requestId);
                    pending(answer === true);
                  },
                  () => {
                    const pending = uiPending.get(request.requestId);
                    if (!pending) return;
                    uiPending.delete(request.requestId);
                    pending(false);
                  },
                );
            });
    this.broker = new PermissionBroker({
      ...(options.permissionTimeoutMs !== undefined
        ? { timeoutMs: options.permissionTimeoutMs }
        : {}),
      ...(wrappedUiHandler !== undefined ? { uiHandler: wrappedUiHandler } : {}),
      onRequest: (request) => {
        // Request mới → event approval_request lên bus (UI thấy thẻ chờ).
        this.bus.publish({
          instanceId: this.registry.getByBotId(request.botId)?.instanceId ?? `unregistered:${request.botId}`,
          botId: request.botId,
          threadId: request.threadId ?? request.botId,
          engine: request.engine,
          kind: 'approval_request',
          payload: { method: request.method, detail: request.detail },
          at: request.requestedAt,
        });
      },
      onDecision: (decision) => {
        // v0.50 (M8): kết thúc promise UI handler đang chờ quyết định này.
        const pendingUi = uiPending.get(decision.requestId);
        if (pendingUi) {
          uiPending.delete(decision.requestId);
          pendingUi(decision.allowed);
        }
        this.bus.publish({
          instanceId: this.registry.getByBotId(decision.botId)?.instanceId ?? `unregistered:${decision.botId}`,
          botId: decision.botId,
          threadId: decision.botId,
          engine: decision.engine,
          kind: 'approval_decision',
          payload: {
            method: decision.method,
            allowed: decision.allowed,
            reason: decision.reason,
            source: decision.source,
          },
          at: decision.decidedAt,
        });
      },
      logger: { warn: this.warn },
    });
  }

  /** Thư mục log NDJSON (undefined khi harness không ghi đĩa). */
  get logDir(): string | undefined {
    return this.log?.dir;
  }

  /** File snapshot (undefined khi harness không ghi đĩa). */
  get snapshotFile(): string | undefined {
    return this.dataDir ? path.join(this.dataDir, 'harness-snapshot.json') : undefined;
  }

  // ------------------------------------------------------------------
  // Đăng ký bot / provider
  // ------------------------------------------------------------------

  /**
   * Đăng ký bot vào registry + gắn sink event + permission handler
   * vào provider (khi provider hỗ trợ). Gọi ở `createBot` (và
   * `createAgentBot`).
   *
   * v0.60: re-attach idempotent — gắn lại ĐÚNG provider đã đăng ký
   * (cùng object đã unwrap + cùng providerId/engine) thì trả về
   * snapshot hiện có, KHÔNG throw, KHÔNG gắn sink/handler lần nữa
   * (gắn lại sẽ nhân đôi event trên bus). Đây là đường main gọi
   * `createBot` 2 lần cho cùng bot lúc khởi động: lần 2 không còn
   * rơi vào cảnh báo "đã có instance sống" nữa. Gắn provider KHÁC
   * (object khác, hoặc providerId/engine khác) cho bot đang sống
   * thì vẫn THROW như cũ — chống spawn trùng; muốn thay provider
   * thì đi qua `reregisterProvider` (unregister trước) hoặc
   * destroy/unregister rồi đăng ký lại.
   */
  attachToProvider(
    botId: string,
    provider: Provider | HarnessAttachableProvider,
    options: { engine: string; threadId?: string },
  ): HarnessInstanceSnapshot {
    const attachable = provider as HarnessAttachableProvider;
    const inner = this.unwrapProvider(provider);
    // Re-attach cùng provider: trả snapshot hiện có, không đăng ký lại.
    const live = this.registry.getByBotId(botId);
    if (live && live.status !== 'exited' && live.status !== 'killed') {
      const sameProvider = this.attachedProviders.get(botId) === inner;
      const sameIdentity =
        live.providerId === this.providerIdOf(provider) && live.engine === options.engine;
      if (sameProvider && sameIdentity) {
        return { ...live };
      }
    }
    const snapshot = this.registry.register({
      botId,
      engine: options.engine,
      providerId: this.providerIdOf(provider),
      ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
      pidProvider: () => {
        const pid = (inner as HarnessAttachableProvider).cliPid;
        return typeof pid === 'number' ? pid : undefined;
      },
      kill: () => {
        const disposed = (inner as HarnessAttachableProvider).dispose?.();
        if (disposed && typeof (disposed as Promise<void>).catch === 'function') {
          return (disposed as Promise<void>).catch(() => undefined);
        }
        return undefined;
      },
      logger: { warn: this.warn },
    });
    this.attachedProviders.set(botId, inner);
    // Gắn sink event: driver emit CliEvent → bus + NDJSON log.
    // (Callback onCliEvent cũ của driver vẫn chạy song song.)
    try {
      (inner as HarnessAttachableProvider).attachHarnessSink?.(
        this.cliEventSink(botId, options.engine, options.threadId ?? botId),
      );
    } catch (err) {
      this.warn(`harness: gắn sink cho bot ${botId} lỗi: ${(err as Error).message}`);
    }
    // Gắn permission handler: driver hỏi broker thay vì tự từ chối.
    try {
      (inner as HarnessAttachableProvider).attachPermissionHandler?.(
        (request: { method: string; detail?: string; allowable: boolean }) =>
          this.broker.request({
            botId,
            threadId: options.threadId ?? botId,
            engine: options.engine,
            method: request.method,
            detail: request.detail,
            allowable: request.allowable,
          }),
      );
    } catch (err) {
      this.warn(`harness: gắn permission handler cho bot ${botId} lỗi: ${(err as Error).message}`);
    }
    return snapshot;
  }

  /**
   * Đăng ký lại sau `switchModel`: provider cũ đã dispose (không
   * kill lại), chỉ gỡ entry cũ rồi đăng ký provider mới.
   */
  reregisterProvider(
    botId: string,
    provider: Provider | HarnessAttachableProvider,
    options: { engine: string; threadId?: string },
  ): HarnessInstanceSnapshot {
    this.registry.unregisterByBotId(botId);
    return this.attachToProvider(botId, provider, options);
  }

  /** Gỡ bot khỏi registry + từ chối mọi permission đang chờ của nó. */
  unregisterBot(botId: string): boolean {
    this.broker.denyAll(botId);
    this.attachedProviders.delete(botId);
    return this.registry.unregisterByBotId(botId);
  }

  // ------------------------------------------------------------------
  // Event sink (driver → bus + log)
  // ------------------------------------------------------------------

  /**
   * v0.90a (Đội G): sink cho agent loop (không phải CLI driver) — mỗi
   * event của turn (turn-start/end, text, tool_call, result, error,
   * approval_denied) → publish envelope chuẩn lên bus + append NDJSON
   * log theo thread. Payload được sanitize ở đây (giống cliEventSink)
   * nên caller không cần tự sanitize. Không throw (loop không được
   * hỏng vì log/bus lỗi).
   */
  publishLoopEvent(
    botId: string,
    threadId: string,
    engine: string,
    kind: HarnessEventKind,
    payload: Record<string, unknown>,
    // v0.90e (Đội G): run im lặng → envelope + log entry mang cờ silent;
    // forwarder/SSE bỏ qua, log vẫn giữ (audit). Mặc định = run thường.
    opts?: { silent?: boolean },
  ): void {
    try {
      const instance = this.registry.getByBotId(botId);
      const silent = opts?.silent === true;
      const envelope: HarnessEvent = {
        instanceId: instance?.instanceId ?? `unregistered:${botId}`,
        botId,
        threadId,
        engine,
        kind,
        payload: sanitizeHarnessPayload(kind, payload),
        ...(silent ? { silent: true as const } : {}),
        at: new Date().toISOString(),
      };
      this.bus.publish(envelope);
      if (instance) this.registry.touch(instance.instanceId);
      this.log?.append({
        at: envelope.at,
        botId,
        threadId,
        kind: envelope.kind,
        payload: envelope.payload,
        ...(silent ? { silent: true as const } : {}),
      });
    } catch {
      // Sink không bao giờ làm hỏng loop.
    }
  }

  /**
   * v0.90e (Đội G): đánh dấu bot đang chạy một run im lặng. CLI driver
   * gắn sink theo provider (không biết run nào đang chạy) nên cờ này là
   * cách duy nhất để cliEventSink biết event thuộc run im lặng và gắn
   * cờ silent lên envelope (log vẫn giữ, forwarder/SSE bỏ qua). Một
   * bot chỉ chạy tối đa một run tại một thời điểm nên cờ theo botId là
   * đủ; coordinator set trước `runner.run()` và clear trong `finally`.
   */
  private readonly silentRuns = new Set<string>();

  setSilentRun(botId: string, on: boolean): void {
    if (on) this.silentRuns.add(botId);
    else this.silentRuns.delete(botId);
  }

  isSilentRun(botId: string): boolean {
    return this.silentRuns.has(botId);
  }

  /**
   * Sink gắn vào driver: mỗi `CliEvent` → publish envelope chuẩn lên
   * bus + append NDJSON log theo thread. Không throw (driver không
   * được hỏng vì log/bus lỗi).
   */
  cliEventSink(botId: string, engine: string, threadId: string): (event: CliEvent) => void {
    return (event: CliEvent) => {
      try {
        const instance = this.registry.getByBotId(botId);
        // v0.90e (Đội G): driver chạy trong run im lặng → event mang cờ
        // silent (log vẫn giữ, forwarder/SSE bỏ qua — như loop event).
        const silent = this.silentRuns.has(botId);
        const envelope: HarnessEvent = this.bus.publishCliEvent(
          instance?.instanceId ?? `unregistered:${botId}`,
          botId,
          threadId,
          engine,
          event,
          undefined,
          silent,
        );
        if (instance) this.registry.touch(instance.instanceId);
        this.log?.append({
          at: envelope.at,
          botId,
          threadId,
          kind: envelope.kind,
          payload: envelope.payload,
          ...(silent ? { silent: true as const } : {}),
        });
      } catch {
        // Sink không bao giờ làm hỏng driver.
      }
    };
  }

  // ------------------------------------------------------------------
  // Permission (UI / RPC / Local API gọi vào)
  // ------------------------------------------------------------------

  /** UI quyết một request đang chờ (thẻ Allow/Deny). */
  decidePermission(requestId: string, allowed: boolean, reason?: string): HarnessDecidePermissionResult {
    const found = this.broker.decide(requestId, allowed, reason);
    return { requestId, found, ...(found ? { allowed } : {}) };
  }

  /** Quyết định permission đã ghi (audit, mới nhất cuối). */
  listPermissionDecisions(): PermissionDecisionRecord[] {
    return this.broker.listDecisions();
  }

  // ------------------------------------------------------------------
  // Trạng thái / log / snapshot (RPC + Local API)
  // ------------------------------------------------------------------

  harnessStatus(): HarnessStatusResult {
    return {
      enabled: true,
      instances: this.registry.list(),
      pendingPermissions: this.broker.listPending(),
      decisionsTotal: this.broker.listDecisions().length,
      ...(this.logDir !== undefined ? { logDir: this.logDir } : {}),
      ...(this.snapshotFile !== undefined ? { snapshotFile: this.snapshotFile } : {}),
    };
  }

  readThreadLog(
    threadId: string,
    options: { limit?: number; offset?: number; kinds?: HarnessEvent['kind'][] } = {},
  ): ThreadLogPage {
    if (!this.log) return { threadId, entries: [], total: 0, offset: options.offset ?? 0, limit: options.limit ?? 100 };
    return this.log.read(threadId, options);
  }

  /**
   * Lưu snapshot engine + instance xuống đĩa (atomic). `engines` là
   * snapshot detector (chỉ nhãn/trạng thái, không secret) — caller
   * (desktop main) truyền vào; không có thì lưu engines rỗng.
   */
  saveSnapshot(engines: Record<string, unknown> = {}): string | null {
    if (!this.dataDir) return null;
    const snapshot: HarnessSnapshotFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      engines,
      instances: this.registry.list(),
    };
    return writeHarnessSnapshotAtomic(this.dataDir, snapshot);
  }

  /** Đọc snapshot đã lưu (khôi phục HIỂN THỊ — không spawn lại process). */
  loadSnapshot(): { snapshot: HarnessSnapshotFile | null; warning?: string } {
    if (!this.dataDir) return { snapshot: null, warning: 'harness không có dataDir — không có snapshot để đọc.' };
    return readHarnessSnapshot(this.dataDir);
  }

  /** Kill toàn bộ process còn sống theo registry + từ chối permission chờ. */
  async shutdownAll(): Promise<{ killed: number; failed: string[] }> {
    this.broker.denyAll();
    this.attachedProviders.clear();
    return this.registry.shutdownAll();
  }

  // ------------------------------------------------------------------
  // Helper nội bộ
  // ------------------------------------------------------------------

  /** Unwrap MeteredProvider (giống disposeProvider của coordinator). */
  private unwrapProvider(provider: Provider | HarnessAttachableProvider): HarnessAttachableProvider {
    const wrapped = (provider as unknown as { wrapped?: Provider }).wrapped;
    return (wrapped ?? provider) as HarnessAttachableProvider;
  }

  private providerIdOf(provider: Provider | HarnessAttachableProvider): string {
    const inner = this.unwrapProvider(provider) as unknown as { id?: unknown };
    return typeof inner.id === 'string' && inner.id ? inner.id : 'unknown';
  }
}
