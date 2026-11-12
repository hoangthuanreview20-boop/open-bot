/**
 * Guest agent cho VM của máy-tính-bot (v0.78, M3).
 *
 * Host <-> guest nói NDJSON qua Unix socket của QEMU virtio-serial
 * (xem `buildQemuBootArgs` — chardev `agent0`, port
 * `org.open-bot.guest-agent`). Protocol:
 *
 *   Host -> guest: {"id":n,"type":"exec","command":"...","args":[...],
 *                   "timeoutMs":n,"cwd":"..."}
 *              hoặc {"id":n,"type":"ping"} / {"id":n,"type":"info"}
 *                   (v0.90c — health check, guest cũ trả lỗi thì host
 *                   báo 'unknown', không crash)
 *   Guest -> host: {"id":n,"type":"result","code":n,
 *                   "stdout":"...","stderr":"..."}
 *              hoặc {"id":n,"type":"error","message":"..."}
 *              hoặc {"id":n,"type":"pong","version":"...","uptimeSeconds":n}
 *              hoặc {"id":n,"type":"info","version":"...","uptimeSeconds":n,
 *                      "node":"...","platform":"...","arch":"..."}
 *
 * Guest là script Node thuần, không dependency
 * (`packages/core/src/compute/guest-agent.mjs`) — user tự copy vào
 * image VM của mình (xem `compute/README.md` — mục Guest agent).
 * Client này chạy trên host: kết nối tới socket QEMU tạo ra khi boot
 * VM (`<rootDir>/<botId>.agent.sock`).
 *
 * Giới hạn: stdout/stderr mỗi chiều tối đa 4MB (guest cắt/báo lỗi
 * khi vượt; host cắt phòng thủ nếu guest gửi quá dài). Lệnh chạy
 * trong VM KHÔNG qua EgressGate — VM dùng NAT thì mạng ra ngoài
 * không bị chặn (xem M2); VM mặc định không có mạng (`-nic none`).
 */
import * as net from 'node:net';

/** Tên virtio-serial port của guest agent (phải khớp QEMU + guest). */
export const GUEST_AGENT_PORT_NAME = 'org.open-bot.guest-agent';

/** Version protocol guest agent (host + guest cùng ghi — ping/info trả về). */
export const GUEST_AGENT_VERSION = '0.90c';

/** Cap stdout/stderr một lần chạy trong VM (bytes). */
export const GUEST_AGENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Timeout mặc định một lần exec qua guest agent (ms). */
export const GUEST_AGENT_DEFAULT_TIMEOUT_MS = 120_000;

/** Timeout mặc định cho ping/info (ms) — health check phải nhanh. */
export const GUEST_AGENT_PING_TIMEOUT_MS = 3000;

/** Số lần thử lại tối đa khi reconnect (không vòng lặp vô hạn). */
export const GUEST_AGENT_MAX_RECONNECT_ATTEMPTS = 3;

/** Độ trễ giữa các lần reconnect (ms). */
export const GUEST_AGENT_RECONNECT_DELAY_MS = 500;

export interface GuestAgentExecOptions {
  /** Timeout một lần chạy (ms, mặc định 120_000). */
  timeoutMs?: number;
  /** Thư mục làm việc trong VM (mặc định: thư mục làm việc của guest). */
  cwd?: string;
  /** Timeout kết nối socket (ms, mặc định 10_000). */
  connectTimeoutMs?: number;
}

export interface GuestAgentExecResult {
  /** Exit code của lệnh trong VM (null khi bị kill bởi signal). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * v0.90c: kết quả ping guest. 'ok' = guest trả pong (kèm version /
 * uptime khi có); 'unknown' = guest không trả lời đúng protocol
 * (guest CŨ trước v0.90c trả lỗi "type phải là exec", hoặc timeout) —
 * KHÔNG phải lỗi crash: caller báo 'unknown' thay vì throw.
 */
export type GuestAgentPingResult =
  | { status: 'ok'; version?: string; uptimeSeconds?: number; rttMs: number }
  | { status: 'unknown'; rttMs: number };

/** v0.90c: thông tin guest trả qua lệnh info (null = guest không hỗ trợ). */
export interface GuestAgentInfo {
  version?: string;
  uptimeSeconds?: number;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
}

interface PendingExec {
  kind: 'exec' | 'ping' | 'info';
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function truncateOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= GUEST_AGENT_MAX_OUTPUT_BYTES) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, GUEST_AGENT_MAX_OUTPUT_BYTES);
  return buf.toString('utf8') + '\n[open-bot: output đã cắt ở 4MB]';
}

/**
 * Client NDJSON tới guest agent trong VM. Một client = một socket;
 * dùng lại cho nhiều lần exec (id tăng dần). Mọi lỗi protocol (dòng
 * không phải JSON, reply không đúng shape, socket ngắt) đều reject
 * các exec đang chờ + đóng socket — không đoán mò.
 */
export class GuestAgentClient {
  private readonly socketPath: string;
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingExec>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Kết nối tới socket QEMU (reject khi hết timeout / socket không có). */
  connect(connectTimeoutMs = 10_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Không kết nối được tới guest agent (${this.socketPath}) sau ${connectTimeoutMs}ms — VM đã boot chưa, guest agent đã cài trong VM chưa?`));
      }, connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => this.onSocketError(err));
        socket.on('close', () => this.onSocketClose());
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Không kết nối được tới guest agent (${this.socketPath}): ${err.message}`));
      });
    });
  }

  /**
   * Chạy một lệnh trong VM qua guest agent. Reject khi timeout, khi
   * guest trả lỗi, hoặc khi socket ngắt giữa chừng.
   */
  exec(
    command: string,
    args: string[] = [],
    opts: GuestAgentExecOptions = {},
  ): Promise<GuestAgentExecResult> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Guest agent chưa kết nối — gọi connect() trước.'));
    }
    if (typeof command !== 'string' || command.trim() === '') {
      return Promise.reject(new Error('Lệnh chạy trong VM không được rỗng.'));
    }
    const timeoutMs = opts.timeoutMs ?? GUEST_AGENT_DEFAULT_TIMEOUT_MS;
    const id = this.nextId;
    this.nextId += 1;
    const request = {
      id,
      type: 'exec',
      command,
      args,
      timeoutMs,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    return new Promise<GuestAgentExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Guest agent timeout sau ${timeoutMs}ms (lệnh: ${command}).`));
      }, timeoutMs + 1000);
      // +1s cho độ trễ đường truyền: guest tự timeout đúng timeoutMs.
      this.pending.set(id, { kind: 'exec', resolve: (r) => resolve(r as GuestAgentExecResult), reject, timer });
      try {
        this.socket?.write(`${JSON.stringify(request)}\n`, 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Không gửi được lệnh tới guest agent: ${(err as Error).message}`));
      }
    });
  }

  /**
   * v0.90c: ping guest (health check). Không bao giờ throw khi đã
   * kết nối: guest trả pong -> 'ok'; guest cũ trả lỗi / timeout ->
   * 'unknown' (không crash, caller báo trạng thái đó). Throw chỉ khi
   * chưa kết nối — caller kiểm tra `connected` trước.
   */
  ping(timeoutMs: number = GUEST_AGENT_PING_TIMEOUT_MS): Promise<GuestAgentPingResult> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Guest agent chưa kết nối — gọi connect() trước.'));
    }
    const startedAt = Date.now();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<GuestAgentPingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 'unknown', rttMs: Date.now() - startedAt });
      }, timeoutMs);
      this.pending.set(id, {
        kind: 'ping',
        resolve: (r) => resolve({ ...(r as { status: 'ok'; version?: string; uptimeSeconds?: number }), rttMs: Date.now() - startedAt }),
        reject,
        timer,
      });
      try {
        this.socket?.write(`${JSON.stringify({ id, type: 'ping' })}\n`, 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Không gửi được ping tới guest agent: ${(err as Error).message}`));
      }
    });
  }

  /**
   * v0.90c: hỏi thông tin guest (version/uptime/node/platform).
   * Guest cũ không hỗ trợ (trả lỗi) hoặc timeout -> null, không throw
   * (trừ khi chưa kết nối — như ping).
   */
  info(timeoutMs: number = GUEST_AGENT_PING_TIMEOUT_MS): Promise<GuestAgentInfo | null> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Guest agent chưa kết nối — gọi connect() trước.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<GuestAgentInfo | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        kind: 'info',
        resolve: (r) => resolve(r as GuestAgentInfo | null),
        reject,
        timer,
      });
      try {
        this.socket?.write(`${JSON.stringify({ id, type: 'info' })}\n`, 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Không gửi được info tới guest agent: ${(err as Error).message}`));
      }
    });
  }

  /**
   * v0.90c: kết nối lại khi socket đứt — thử tối đa `maxAttempts`
   * lần (mặc định 3), cách nhau `delayMs` (mặc định 500ms). Trả true
   * khi kết nối lại được, false khi hết lần thử (không vòng lặp vô
   * hạn, không throw khi hết lần thử). Đã kết nối thì trả true ngay.
   */
  async reconnect(
    opts: { maxAttempts?: number; delayMs?: number; connectTimeoutMs?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? GUEST_AGENT_MAX_RECONNECT_ATTEMPTS));
    const delayMs = Math.max(0, opts.delayMs ?? GUEST_AGENT_RECONNECT_DELAY_MS);
    const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.connected) return true;
      try {
        await this.connect(connectTimeoutMs);
        return true;
      } catch {
        // Hết lần thử thì dừng; còn lần thì chờ rồi thử lại.
        if (attempt < maxAttempts && delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    return this.connected;
  }

  /** Ngắt kết nối (reject các exec đang chờ). */
  close(): void {
    this.failAllPending(new Error('Guest agent đã ngắt kết nối.'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line !== '') this.onLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > GUEST_AGENT_MAX_OUTPUT_BYTES + 1024) {
      this.onProtocolError('Guest agent gửi một dòng dài hơn giới hạn 4MB — nghi protocol hỏng.');
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onProtocolError(`Guest agent gửi dòng không phải JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.onProtocolError('Guest agent gửi reply không phải object JSON.');
      return;
    }
    const rec = msg as Record<string, unknown>;
    if (typeof rec.id !== 'number' || !this.pending.has(rec.id)) {
      // v0.90c: reply pong/info tới muộn (ping/info đã timeout và
      // resolve 'unknown'/null) thì bỏ qua lặng lẽ — không coi là lỗi
      // protocol (tránh đóng socket chỉ vì health check tới muộn).
      if (rec.type === 'pong' || rec.type === 'info') return;
      this.onProtocolError('Guest agent gửi reply không có id khớp với lệnh đang chờ.');
      return;
    }
    const pending = this.pending.get(rec.id) as PendingExec;
    this.pending.delete(rec.id);
    clearTimeout(pending.timer);
    // v0.90c: ping/info có đường xử lý riêng (guest cũ trả 'error'
    // thì resolve 'unknown'/null thay vì reject — tương thích ngược).
    if (pending.kind === 'ping') {
      if (rec.type === 'error') {
        pending.resolve({ status: 'unknown' });
        return;
      }
      if (rec.type !== 'pong') {
        pending.reject(new Error(`Guest agent trả type lạ cho ping: ${String(rec.type)}`));
        return;
      }
      pending.resolve({
        status: 'ok',
        ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
        ...(typeof rec.uptimeSeconds === 'number' ? { uptimeSeconds: rec.uptimeSeconds } : {}),
      });
      return;
    }
    if (pending.kind === 'info') {
      if (rec.type === 'error') {
        pending.resolve(null);
        return;
      }
      if (rec.type !== 'info') {
        pending.reject(new Error(`Guest agent trả type lạ cho info: ${String(rec.type)}`));
        return;
      }
      pending.resolve({
        ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
        ...(typeof rec.uptimeSeconds === 'number' ? { uptimeSeconds: rec.uptimeSeconds } : {}),
        ...(typeof rec.node === 'string' ? { nodeVersion: rec.node } : {}),
        ...(typeof rec.platform === 'string' ? { platform: rec.platform } : {}),
        ...(typeof rec.arch === 'string' ? { arch: rec.arch } : {}),
      });
      return;
    }
    if (rec.type === 'error') {
      pending.reject(new Error(`Guest agent lỗi: ${typeof rec.message === 'string' ? rec.message : 'không rõ lý do'}`));
      return;
    }
    if (rec.type !== 'result') {
      pending.reject(new Error(`Guest agent trả type lạ: ${String(rec.type)}`));
      return;
    }
    if (
      (typeof rec.code !== 'number' && rec.code !== null) ||
      typeof rec.stdout !== 'string' ||
      typeof rec.stderr !== 'string'
    ) {
      pending.reject(new Error('Guest agent trả result thiếu code/stdout/stderr đúng kiểu.'));
      return;
    }
    pending.resolve({
      code: rec.code,
      stdout: truncateOutput(rec.stdout),
      stderr: truncateOutput(rec.stderr),
    });
  }

  private onProtocolError(message: string): void {
    this.failAllPending(new Error(message));
    this.close();
  }

  private onSocketError(err: Error): void {
    this.failAllPending(new Error(`Socket guest agent lỗi: ${err.message}`));
  }

  private onSocketClose(): void {
    this.socket = null;
    this.failAllPending(new Error('Guest agent đã ngắt kết nối (socket đóng).'));
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}
