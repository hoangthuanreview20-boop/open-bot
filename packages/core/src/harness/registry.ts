/**
 * Registry instance → process sống (M5).
 *
 * Mỗi bot/engine instance có MỘT entry (botId, engine kind, provider
 * id, pid, trạng thái, startedAt, lastEventAt). Đăng ký khi provider
 * được tạo cho bot (coordinator `createBot`), gỡ khi bot bị xoá /
 * shutdown. Đăng ký trùng botId đang sống thì THROW (chống spawn trùng
 * process cho cùng bot — daemon/coordinator phải unregister trước khi
 * tạo lại; `switchModel` dùng `reregister` vì provider cũ đã dispose).
 *
 * Registry KHÔNG spawn process: nó chỉ giữ hàm `kill` do caller đưa
 * (thường là `provider.dispose()`) + `pidProvider` (đọc pid lười,
 * vì driver spawn lười lúc turn đầu). `shutdownAll()` kill toàn bộ
 * process còn sống theo registry, best-effort, ghi log — chống rò
 * process khi app tắt.
 */

import { randomUUID } from 'node:crypto';

import type { HarnessInstanceSnapshot, HarnessInstanceStatus } from './types';

export interface RegisterInstanceOptions {
  botId: string;
  /** Kind engine (vd 'claude', 'codex', 'grok-cli', 'mock'). */
  engine: string;
  /** Provider id (vd 'claude-code', 'codex', 'mock'). */
  providerId: string;
  threadId?: string;
  /** PID khi đã biết lúc đăng ký (thường chưa có — driver spawn lười). */
  pid?: number;
  /** Đọc pid lười (driver spawn xong mới có pid). */
  pidProvider?: () => number | undefined;
  /**
   * Hàm kill process của instance (thường `() => provider.dispose()`).
   * Best-effort: throw thì shutdownAll vẫn tiếp tục instance khác.
   */
  kill: () => void | Promise<void>;
  /** Nơi ghi cảnh báo (kill lỗi / đăng ký trùng). */
  logger?: { warn(message: string): void };
}

interface RegistryEntry {
  snapshot: HarnessInstanceSnapshot;
  kill: () => void | Promise<void>;
  pidProvider?: () => number | undefined;
  logger?: { warn(message: string): void };
}

export interface HarnessShutdownResult {
  killed: number;
  /** Instance id mà kill lỗi (best-effort — đã ghi warn, không throw). */
  failed: string[];
}

export class HarnessRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly byBotId = new Map<string, string>();

  /** Số instance đang giữ trong registry. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Đăng ký một instance. Throw khi botId đã có instance sống
   * (chống spawn trùng) — caller unregister/reregister trước.
   */
  register(options: RegisterInstanceOptions): HarnessInstanceSnapshot {
    const existingId = this.byBotId.get(options.botId);
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId);
      if (existing && existing.snapshot.status !== 'exited' && existing.snapshot.status !== 'killed') {
        throw new Error(
          `harness: bot "${options.botId}" đã có instance sống (${existingId}) — gọi unregister trước khi đăng ký lại.`,
        );
      }
      this.byBotId.delete(options.botId);
      this.entries.delete(existingId);
    }
    const now = new Date().toISOString();
    const instanceId = randomUUID();
    const snapshot: HarnessInstanceSnapshot = {
      instanceId,
      botId: options.botId,
      engine: options.engine,
      providerId: options.providerId,
      threadId: options.threadId,
      pid: options.pid ?? options.pidProvider?.(),
      status: 'starting',
      startedAt: now,
      lastEventAt: now,
    };
    this.entries.set(instanceId, {
      snapshot,
      kill: options.kill,
      pidProvider: options.pidProvider,
      logger: options.logger,
    });
    this.byBotId.set(options.botId, instanceId);
    return { ...snapshot };
  }

  /** Cập nhật trạng thái một instance (không throw khi không có). */
  updateStatus(instanceId: string, status: HarnessInstanceStatus, exitCode?: number | null): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.snapshot.status = status;
    entry.snapshot.lastEventAt = new Date().toISOString();
    if (exitCode !== undefined) entry.snapshot.exitCode = exitCode;
  }

  /** Ghi nhận event mới cho instance (cập nhật lastEventAt + running). */
  touch(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.snapshot.lastEventAt = new Date().toISOString();
    if (entry.snapshot.status === 'starting' || entry.snapshot.status === 'idle') {
      entry.snapshot.status = 'running';
    }
  }

  /** Đánh dấu instance đã thoát (giữ entry để tra cứu, gỡ khỏi byBotId). */
  markExited(instanceId: string, exitCode?: number | null): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.snapshot.status = 'exited';
    entry.snapshot.lastEventAt = new Date().toISOString();
    if (exitCode !== undefined) entry.snapshot.exitCode = exitCode;
    if (this.byBotId.get(entry.snapshot.botId) === instanceId) {
      this.byBotId.delete(entry.snapshot.botId);
    }
  }

  /** Gỡ một instance khỏi registry (KHÔNG kill process — caller kill trước). */
  unregister(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (!entry) return false;
    this.entries.delete(instanceId);
    if (this.byBotId.get(entry.snapshot.botId) === instanceId) {
      this.byBotId.delete(entry.snapshot.botId);
    }
    return true;
  }

  /** Gỡ instance của một bot (trả true khi có). */
  unregisterByBotId(botId: string): boolean {
    const instanceId = this.byBotId.get(botId);
    if (instanceId === undefined) return false;
    return this.unregister(instanceId);
  }

  /** Snapshot một instance (undefined khi không có). */
  get(instanceId: string): HarnessInstanceSnapshot | undefined {
    return this.snapshotOf(instanceId);
  }

  /** Snapshot instance của một bot (undefined khi bot chưa đăng ký). */
  getByBotId(botId: string): HarnessInstanceSnapshot | undefined {
    const instanceId = this.byBotId.get(botId);
    if (instanceId === undefined) return undefined;
    return this.snapshotOf(instanceId);
  }

  /** True khi bot đang có instance sống trong registry. */
  hasLive(botId: string): boolean {
    const snapshot = this.getByBotId(botId);
    return snapshot !== undefined && snapshot.status !== 'exited' && snapshot.status !== 'killed';
  }

  /** Toàn bộ snapshot (bản sao — sửa ngoài không ảnh hưởng registry). */
  list(): HarnessInstanceSnapshot[] {
    return [...this.entries.keys()]
      .map((id) => this.snapshotOf(id))
      .filter((s): s is HarnessInstanceSnapshot => s !== undefined);
  }

  /**
   * Kill toàn bộ process còn sống theo registry (best-effort, không
   * throw): mỗi instance gọi hàm `kill` của nó, lỗi thì ghi warn +
   * đưa vào `failed`, instance vẫn bị gỡ khỏi registry. Sau shutdown,
   * registry rỗng.
   */
  async shutdownAll(): Promise<HarnessShutdownResult> {
    const failed: string[] = [];
    let killed = 0;
    for (const [instanceId, entry] of [...this.entries]) {
      try {
        await entry.kill();
        killed += 1;
      } catch (err) {
        failed.push(instanceId);
        entry.logger?.warn(
          `harness shutdown: kill instance ${instanceId} (bot ${entry.snapshot.botId}) lỗi: ${(err as Error).message}`,
        );
      }
      this.entries.delete(instanceId);
      if (this.byBotId.get(entry.snapshot.botId) === instanceId) {
        this.byBotId.delete(entry.snapshot.botId);
      }
    }
    return { killed, failed };
  }

  private snapshotOf(instanceId: string): HarnessInstanceSnapshot | undefined {
    const entry = this.entries.get(instanceId);
    if (!entry) return undefined;
    const pid = entry.pidProvider?.() ?? entry.snapshot.pid;
    return { ...entry.snapshot, ...(pid !== undefined ? { pid } : {}) };
  }
}
