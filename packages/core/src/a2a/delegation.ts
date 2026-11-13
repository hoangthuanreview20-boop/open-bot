/**
 * Bot-to-bot delegation qua A2A (v0.97, Đội T2).
 *
 * Một bot trong open-bot ủy thác subtask cho một bot khác bằng đúng
 * giao thức A2A (Agent Card → `message:send` → task lifecycle), thay
 * vì gọi thẳng function nội bộ. Nhờ vậy cùng một đường code phục vụ
 * cả hai trường hợp:
 *  - Bot đích ở ngay trong app (có runner nội bộ): delegator dựng
 *    một A2A server tạm trên loopback (port 0, token ngẫu nhiên)
 *    với runner của bot đích, rồi gọi qua `A2aClient` thật bằng
 *    HTTP — đúng nghĩa "dùng nội bộ trước, qua loopback".
 *  - Bot đích là agent ngoài có URL: gọi thẳng bằng `A2aClient`
 *    (URL phải qua policy mạng — loopback mặc định).
 *
 * Giới hạn an toàn (bài học hồi quy v0.96 — tính năng mặc định BẬT
 * đã route cả bot mock sang Ollama thật):
 *  - Bot nguồn provider `mock` hoặc kind `cli` KHÔNG được ủy thác:
 *    bot mock không có runner thật (kết quả ủy thác sẽ là giả), bot
 *    CLI chạy qua session CLI của nó (ủy thác A2A sẽ bypass CLI).
 *    Cả hai đều bị từ chối ngay với lỗi rõ ràng, không chạy thử.
 *  - Độ sâu ủy thác tối đa 3 (mặc định): chain ủy thác ghi trong
 *    `task.metadata['a2a-delegation-chain']` (mảng botId) — bot đã
 *    có trong chain thì không nhận lại (chống vòng lặp A → B → A).
 *  - Timeout mỗi request và thời gian chờ task xong đều có giới hạn
 *    (mặc định 30s / 120s, kẹp trên).
 *
 * Chỉ dùng `A2aClient` + `startA2aHttpServer` có sẵn, không thêm
 * dependency.
 */
import { randomUUID } from 'node:crypto';
import { A2aClient } from './client';
import { startA2aHttpServer } from './server';
import {
  A2aError,
  isA2aTerminalState,
  type A2aAgentRunner,
  type A2aTask,
} from './types';
import { assertA2aUrlAllowed, type A2aNetworkPolicy } from './network';

/** Độ sâu ủy thác tối đa (A → B → C → D là 3 lần ủy thác). */
export const A2A_DELEGATION_MAX_DEPTH = 3;
/** Timeout mặc định mỗi request HTTP khi ủy thác (30s). */
export const A2A_DELEGATION_TIMEOUT_MS = 30_000;
/** Thời gian chờ tối đa task đích chạy xong (2 phút). */
export const A2A_DELEGATION_WAIT_MS = 120_000;
/** Key metadata ghi chain ủy thác trên task. */
export const A2A_DELEGATION_CHAIN_KEY = 'a2a-delegation-chain';

/**
 * Một bot đích có thể nhận ủy thác.
 *  - `runner`: bot nội bộ của app (chạy qua server A2A tạm trên loopback).
 *  - `baseUrl`: agent ngoài có endpoint A2A (gọi qua HTTP).
 *  - `provider`/`kind`: để áp dụng miễn trừ mock/cli cho bot NGUỒN
 *    (bot đích không bị miễn trừ — đích nào cũng nhận task được).
 */
export interface A2aLocalBotTarget {
  botId: string;
  name?: string;
  provider?: string;
  /** Kind của bot nguồn (vd 'cli' cho Claude Code / Codex CLI). */
  kind?: string;
  runner?: A2aAgentRunner;
  baseUrl?: string;
  /** Bearer <redacted> khi bot đích HTTP yêu cầu auth (không log, không lưu file). */
  token?: string;
  skills?: string[];
}

/** Registry bot đích — tối giản, đồng bộ, trong bộ nhớ. */
export class A2aLocalBotRegistry {
  private readonly bots = new Map<string, A2aLocalBotTarget>();

  register(target: A2aLocalBotTarget): void {
    if (!target || typeof target.botId !== 'string' || target.botId.trim().length === 0) {
      throw new Error('A2aLocalBotRegistry.register cần botId (string, không rỗng).');
    }
    if (!target.runner && !target.baseUrl) {
      throw new Error(`Bot "${target.botId}" cần runner nội bộ hoặc baseUrl để nhận ủy thác.`);
    }
    this.bots.set(target.botId, { ...target, botId: target.botId.trim() });
  }

  unregister(botId: string): boolean {
    return this.bots.delete(botId);
  }

  get(botId: string): A2aLocalBotTarget | undefined {
    return this.bots.get(botId);
  }

  list(): A2aLocalBotTarget[] {
    return [...this.bots.values()];
  }

  get size(): number {
    return this.bots.size;
  }

  clear(): void {
    this.bots.clear();
  }
}

/** Đọc chain ủy thác từ metadata của task (mảng botId, rỗng khi chưa có). */
export function readDelegationChain(task: A2aTask | undefined | null): string[] {
  if (!task || typeof task !== 'object') return [];
  const meta = (task as A2aTask).metadata;
  if (!meta || typeof meta !== 'object') return [];
  const chain = (meta as Record<string, unknown>)[A2A_DELEGATION_CHAIN_KEY];
  if (!Array.isArray(chain)) return [];
  return chain.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Ghi chain ủy thác lên metadata của task (trả task mới, không sửa task cũ). */
export function withDelegationChain(task: A2aTask, chain: readonly string[]): A2aTask {
  return {
    ...task,
    metadata: { ...(task.metadata ?? {}), [A2A_DELEGATION_CHAIN_KEY]: [...chain] },
  };
}

export interface A2aDelegateOptions {
  /** Bot nguồn ủy thác (botId đã đăng ký hoặc mô tả tối thiểu). */
  fromBotId: string;
  /** Provider của bot nguồn (vd 'mock', 'openai') — để miễn trừ mock. */
  fromProvider?: string;
  /** Kind của bot nguồn (vd 'cli') — để miễn trừ bot CLI. */
  fromKind?: string;
  /** Bot đích nhận subtask (phải có trong registry). */
  toBotId: string;
  /** Việc cần ủy thác (text gộp thành message A2A). */
  message: string;
  /** ID hội thoại tùy chọn (nối tiếp task cũ ở bot đích). */
  contextId?: string;
  /** Chain ủy thác đã có (khi bot đích lại ủy thác tiếp). */
  chain?: readonly string[];
  /** Timeout mỗi request HTTP, ms (mặc định 30s, kẹp 1s–300s). */
  timeoutMs?: number;
  /** Thời gian chờ tối đa task đích xong, ms (mặc định 120s, kẹp 1s–600s). */
  waitMs?: number;
}

export interface A2aDelegateResult {
  /** Task cuối của bot đích (kèm chain ủy thác trong metadata). */
  task: A2aTask;
  /** Bot đích đã chạy subtask. */
  targetBotId: string;
  /** Độ sâu của lần ủy thác này (1 = trực tiếp). */
  depth: number;
  /** Đường gọi: server tạm loopback hay HTTP tới URL đích. */
  via: 'local-loopback-server' | 'http';
  /** URL endpoint đã gọi (để log/debug, không chứa token). */
  endpoint: string;
}

/**
 * Kiểm tra bot nguồn có được ủy thác không. Bot mock / bot CLI bị
 * từ chối ngay (xem ghi chú đầu file). Trả lỗi rõ ràng để caller
 * hiện cho user thay vì chạy rồi nhận kết quả giả.
 */
export function checkDelegationSourceAllowed(
  fromBotId: string,
  fromProvider?: string,
  fromKind?: string,
): { allowed: boolean; reason?: string } {
  if (!fromBotId || fromBotId.trim().length === 0) {
    return { allowed: false, reason: 'Thiếu bot nguồn (fromBotId).' };
  }
  if (typeof fromProvider === 'string' && fromProvider.toLowerCase() === 'mock') {
    return {
      allowed: false,
      reason:
        `Bot "${fromBotId}" dùng provider mock (không có model/runner thật) nên không ủy thác qua A2A — ` +
        'kết quả ủy thác sẽ là giả. Đổi bot nguồn sang provider thật hoặc bot CLI rồi thử lại.',
    };
  }
  if (typeof fromKind === 'string' && fromKind.toLowerCase() === 'cli') {
    return {
      allowed: false,
      reason:
        `Bot "${fromBotId}" là bot CLI (chạy qua session CLI của nó) nên không ủy thác qua A2A — ` +
        'ủy thác sẽ bypass CLI session. Dùng tool của CLI bot đó thay vì a2a_delegate.',
    };
  }
  return { allowed: true };
}

function clampMs(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Delegator bot-bot qua A2A. Một instance dùng chung cho cả app
 * (giữ registry bot đích); mỗi lần `delegate()` là một lần ủy thác
 * độc lập, không giữ state giữa các lần gọi ngoài registry.
 */
export class A2aDelegator {
  private readonly registry: A2aLocalBotRegistry;
  private readonly networkPolicy?: A2aNetworkPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly defaultWaitMs: number;
  private readonly maxDepth: number;

  constructor(
    options: {
      registry?: A2aLocalBotRegistry;
      networkPolicy?: A2aNetworkPolicy;
      defaultTimeoutMs?: number;
      defaultWaitMs?: number;
      maxDepth?: number;
    } = {},
  ) {
    this.registry = options.registry ?? new A2aLocalBotRegistry();
    this.networkPolicy = options.networkPolicy;
    this.defaultTimeoutMs = clampMs(options.defaultTimeoutMs, A2A_DELEGATION_TIMEOUT_MS, 1_000, 300_000);
    this.defaultWaitMs = clampMs(options.defaultWaitMs, A2A_DELEGATION_WAIT_MS, 1_000, 600_000);
    this.maxDepth = Math.max(1, Math.floor(options.maxDepth ?? A2A_DELEGATION_MAX_DEPTH));
  }

  get bots(): A2aLocalBotRegistry {
    return this.registry;
  }

  /**
   * Ủy thác một subtask từ bot nguồn sang bot đích qua A2A.
   * Throw `A2aError` khi: bot nguồn bị miễn trừ (mock/cli), bot
   * đích không có trong registry, chain có vòng lặp, vượt độ sâu,
   * URL đích bị policy chặn, hoặc task đích lỗi/timeout.
   */
  async delegate(options: A2aDelegateOptions): Promise<A2aDelegateResult> {
    const fromBotId = options.fromBotId?.trim() ?? '';
    const toBotId = options.toBotId?.trim() ?? '';
    const message = options.message?.trim() ?? '';
    if (message.length === 0) throw new A2aError('a2a_delegate cần message (việc cần ủy thác, không rỗng).');
    if (toBotId.length === 0) throw new A2aError('a2a_delegate cần toBotId (bot đích).');
    if (fromBotId === toBotId) {
      throw new A2aError(`Bot "${fromBotId}" không tự ủy thác cho chính nó.`);
    }
    const sourceCheck = checkDelegationSourceAllowed(fromBotId, options.fromProvider, options.fromKind);
    if (!sourceCheck.allowed) throw new A2aError(sourceCheck.reason ?? 'Bot nguồn không được ủy thác.');

    const chain = [...(options.chain ?? [])];
    if (chain.includes(fromBotId)) {
      throw new A2aError(`Vòng lặp ủy thác: bot "${fromBotId}" đã có trong chain [${chain.join(' → ')}].`);
    }
    if (chain.includes(toBotId)) {
      throw new A2aError(`Vòng lặp ủy thác: bot đích "${toBotId}" đã có trong chain [${chain.join(' → ')}].`);
    }
    const depth = chain.length + 1;
    if (depth > this.maxDepth) {
      throw new A2aError(
        `Vượt độ sâu ủy thác tối đa (${this.maxDepth}): chain [${chain.join(' → ')}] + "${toBotId}".`,
      );
    }
    const target = this.registry.get(toBotId);
    if (!target) {
      const known = this.registry.list().map((b) => b.botId);
      throw new A2aError(
        `Bot đích "${toBotId}" chưa đăng ký nhận ủy thác.` +
          (known.length > 0 ? ` Bot đã đăng ký: ${known.join(', ')}.` : ' Chưa có bot nào đăng ký.'),
      );
    }

    const timeoutMs = clampMs(options.timeoutMs, this.defaultTimeoutMs, 1_000, 300_000);
    const waitMs = clampMs(options.waitMs, this.defaultWaitMs, 1_000, 600_000);
    const newChain = [...chain, fromBotId];

    if (target.runner) {
      return this.delegateViaLocalServer(target, {
        fromBotId,
        message,
        contextId: options.contextId,
        timeoutMs,
        waitMs,
        chain: newChain,
        depth,
      });
    }
    if (target.baseUrl) {
      return this.delegateViaHttp(target, {
        fromBotId,
        message,
        contextId: options.contextId,
        timeoutMs,
        waitMs,
        chain: newChain,
        depth,
      });
    }
    throw new A2aError(`Bot đích "${toBotId}" không có runner nội bộ lẫn baseUrl.`);
  }

  /**
   * Bot đích nội bộ: dựng A2A server tạm trên loopback với runner
   * của bot đích, gọi qua A2aClient thật, đóng server sau khi xong
   * (kể cả khi lỗi — `finally`).
   */
  private async delegateViaLocalServer(
    target: A2aLocalBotTarget,
    args: {
      fromBotId: string;
      message: string;
      contextId?: string;
      timeoutMs: number;
      waitMs: number;
      chain: string[];
      depth: number;
    },
  ): Promise<A2aDelegateResult> {
    const token = `a2a-delegate-${randomUUID()}`;
    const httpServer = await startA2aHttpServer(
      {
        name: target.name ?? target.botId,
        description: `Local bot "${target.botId}" (delegation target).`,
        token,
        runner: target.runner as A2aAgentRunner,
        allowUnauthenticated: false,
      },
      { port: 0, host: '127.0.0.1' },
    );
    try {
      const client = new A2aClient({ baseUrl: httpServer.url, token, timeoutMs: args.timeoutMs });
      let task = await client.sendMessage(args.message, {
        contextId: args.contextId,
        timeoutMs: args.timeoutMs,
      });
      if (!isA2aTerminalState(task.status.state)) {
        task = await client.pollTask(task.id, { timeoutMs: args.waitMs });
      }
      return {
        task: withDelegationChain(task, args.chain),
        targetBotId: target.botId,
        depth: args.depth,
        via: 'local-loopback-server',
        endpoint: httpServer.url,
      };
    } finally {
      await httpServer.close().catch(() => undefined);
    }
  }

  /** Bot đích ngoài: gọi thẳng qua A2aClient (URL qua policy mạng). */
  private async delegateViaHttp(
    target: A2aLocalBotTarget,
    args: {
      fromBotId: string;
      message: string;
      contextId?: string;
      timeoutMs: number;
      waitMs: number;
      chain: string[];
      depth: number;
    },
  ): Promise<A2aDelegateResult> {
    const baseUrl = (target.baseUrl as string).replace(/\/+$/, '') + '/';
    assertA2aUrlAllowed(baseUrl, this.networkPolicy);
    const client = new A2aClient({ baseUrl, token: target.token, timeoutMs: args.timeoutMs });
    let task = await client.sendMessage(args.message, {
      contextId: args.contextId,
      timeoutMs: args.timeoutMs,
    });
    if (!isA2aTerminalState(task.status.state)) {
      task = await client.pollTask(task.id, { timeoutMs: args.waitMs });
    }
    return {
      task: withDelegationChain(task, args.chain),
      targetBotId: target.botId,
      depth: args.depth,
      via: 'http',
      endpoint: baseUrl,
    };
  }
}

/**
 * Tạo một delegator nhanh với danh sách bot đích cho trước (tiện
 * cho tool `a2a_delegate` và test). Bot không có runner/baseUrl thì
 * bị bỏ qua (không throw cả loạt).
 */
export function createA2aDelegator(
  targets: readonly A2aLocalBotTarget[],
  options: {
    networkPolicy?: A2aNetworkPolicy;
    defaultTimeoutMs?: number;
    defaultWaitMs?: number;
    maxDepth?: number;
  } = {},
): A2aDelegator {
  const delegator = new A2aDelegator(options);
  for (const target of targets) {
    try {
      delegator.bots.register(target);
    } catch {
      // Bot khai thiếu runner/baseUrl → bỏ qua, không chặn các bot khác.
    }
  }
  return delegator;
}
