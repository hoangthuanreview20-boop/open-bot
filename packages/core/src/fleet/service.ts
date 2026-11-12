/**
 * Fleet service manager (đội D) — vòng đời service theo workspace.
 *
 * Mỗi workspace có 1 service riêng: process node chạy
 * `serviceWorker.js` (chỉ trả lời GET /health trên 127.0.0.1, cần
 * token Bearer tạo lúc start, chỉ giữ trong bộ nhớ). Manager giữ
 * token + child handle trong bộ nhớ — không ghi token ra đĩa.
 *
 * - start: spawn (detached process group trên POSIX để kill cả cây),
 *   chờ ready bằng cách poll /health tối đa 10s; spawn lỗi hoặc
 *   worker thoát sớm → throw kèm stderr (giới hạn 4KB).
 * - stop: SIGTERM cả process group, chờ tối đa 5s rồi SIGKILL
 *   (Windows: taskkill /T /F). Idempotent.
 * - restart: stop rồi start (token mới).
 * - health: GET /health với token, timeout 3s.
 * - Tự restart: service đang chạy mà chết bất ngờ → restart với
 *   backoff 200ms/1s/3s, tối đa 3 lần, rồi state 'error'. Start
 *   chưa từng thành công thì KHÔNG tự restart (báo lỗi ngay).
 * - Mức cô lập 'os-user': spawn với uid của OS user (chỉ có tác
 *   dụng khi process chạy đặc quyền trên POSIX).
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import type { FleetServiceState, FleetWorkspace } from './types';

export const FLEET_SERVICE_READY_TIMEOUT_MS = 10_000;
export const FLEET_SERVICE_HEALTH_TIMEOUT_MS = 3000;
export const FLEET_SERVICE_STOP_TIMEOUT_MS = 5000;
export const FLEET_SERVICE_MAX_RESTARTS = 3;
export const FLEET_SERVICE_RESTART_BACKOFF_MS = [200, 1000, 3000];

export interface FleetServiceStatus {
  workspaceId: string;
  state: FleetServiceState;
  pid?: number;
  startedAt?: number;
  lastHealthAt?: number;
  restarts: number;
  lastError?: string;
}

export interface FleetServiceManagerOptions {
  /** Đường dẫn worker (mặc định: serviceWorker.js cùng thư mục dist). */
  workerPath?: string;
  /** Hàm spawn (inject để test dùng worker giả). */
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
}

interface TrackedService {
  child: ChildProcess;
  token: string;
  state: FleetServiceState;
  pid: number;
  startedAt: number;
  lastHealthAt: number | null;
  restarts: number;
  lastError?: string;
  stderr: string;
  disposed: boolean;
}

function healthRequest(port: number, token: string, timeoutMs: number): Promise<{ uptimeMs: number; pid: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`health check trả HTTP ${res.statusCode}.`));
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              ok?: unknown;
              uptimeMs?: unknown;
              pid?: unknown;
            };
            if (body.ok !== true || typeof body.uptimeMs !== 'number' || typeof body.pid !== 'number') {
              reject(new Error('health check trả body không đúng shape.'));
              return;
            }
            resolve({ uptimeMs: body.uptimeMs, pid: body.pid });
          } catch {
            reject(new Error('health check trả body không phải JSON.'));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('health check timeout.'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** PID còn sống không (kill(pid, 0) — false khi không có quyền/không tồn tại). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcessGroup(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Tiến trình đã thoát — bỏ qua.
    }
  }
}

async function killProcessGroupForce(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Tiến trình đã thoát — bỏ qua.
    }
  }
}

export class FleetServiceManager {
  private readonly workerPath: string;
  private readonly spawnFn: FleetServiceManagerOptions['spawnFn'];
  private readonly services = new Map<string, TrackedService>();

  constructor(options: FleetServiceManagerOptions = {}) {
    this.workerPath = options.workerPath ?? path.join(__dirname, 'serviceWorker.js');
    this.spawnFn = options.spawnFn;
  }

  /** Trạng thái service (chỉ từ bộ nhớ — sau khi app khởi động lại thì 'stopped'). */
  status(workspaceId: string): FleetServiceStatus {
    const svc = this.services.get(workspaceId);
    if (!svc) return { workspaceId, state: 'stopped', restarts: 0 };
    if (svc.state === 'running' && svc.child.exitCode !== null) {
      svc.state = 'error';
      svc.lastError = svc.lastError ?? 'service đã thoát bất ngờ.';
    }
    return {
      workspaceId,
      state: svc.state,
      ...(svc.child.pid !== undefined ? { pid: svc.child.pid } : {}),
      ...(svc.state === 'running' ? { startedAt: svc.startedAt } : {}),
      ...(svc.lastHealthAt !== null ? { lastHealthAt: svc.lastHealthAt } : {}),
      restarts: svc.restarts,
      ...(svc.lastError !== undefined ? { lastError: svc.lastError } : {}),
    };
  }

  isRunning(workspaceId: string): boolean {
    const svc = this.services.get(workspaceId);
    return svc !== undefined && svc.state === 'running' && svc.child.exitCode === null;
  }

  /**
   * Start service cho workspace. Idempotent khi đã chạy (trả về trạng
   * thái hiện tại). `uid` chỉ có tác dụng khi chạy đặc quyền (POSIX).
   */
  async start(workspace: FleetWorkspace, opts: { uid?: number } = {}): Promise<FleetServiceStatus> {
    return this.startInternal(workspace, opts, 0);
  }

  private async startInternal(
    workspace: FleetWorkspace,
    opts: { uid?: number },
    priorRestarts: number,
  ): Promise<FleetServiceStatus> {
    const existing = this.services.get(workspace.id);
    if (existing && existing.state === 'running' && existing.child.exitCode === null) {
      return this.status(workspace.id);
    }
    if (existing) {
      // Đánh dấu tracked cũ đã hết hiệu lực để vòng lặp restart của nó dừng.
      existing.disposed = true;
      this.services.delete(workspace.id);
    }
    const token = randomBytes(32).toString('hex');
    const tracked: TrackedService = {
      child: null as unknown as ChildProcess,
      token,
      state: 'starting',
      pid: -1,
      startedAt: Date.now(),
      lastHealthAt: null,
      restarts: priorRestarts,
      stderr: '',
      disposed: false,
    };
    const spawnOptions: Record<string, unknown> = {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '', FLEET_SERVICE_TOKEN: token },
    };
    if (opts.uid !== undefined && process.platform !== 'win32') spawnOptions.uid = opts.uid;
    let child: ChildProcess;
    try {
      child = this.spawnFn
        ? this.spawnFn(process.execPath, [this.workerPath, workspace.id, String(workspace.port)], spawnOptions)
        : spawn(process.execPath, [this.workerPath, workspace.id, String(workspace.port)], spawnOptions as never);
    } catch (err) {
      throw new Error(`Không spawn được fleet service cho "${workspace.name}": ${(err as Error).message}`);
    }
    tracked.child = child;
    if (child.pid !== undefined) tracked.pid = child.pid;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      tracked.stderr = `${tracked.stderr}${chunk}`.slice(-4096);
    });
    child.on('error', () => {
      if (tracked.state === 'starting') {
        tracked.state = 'error';
        tracked.lastError = 'Không spawn được fleet service (lỗi khởi động).';
      }
    });
    child.on('exit', () => {
      void this.onChildExit(workspace, tracked);
    });
    this.services.set(workspace.id, tracked);

    // Chờ ready bằng /health (tối đa 10s). Worker thoát sớm → lỗi ngay.
    const deadline = Date.now() + FLEET_SERVICE_READY_TIMEOUT_MS;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        tracked.state = 'error';
        tracked.lastError = `fleet service thoát sớm (code ${child.exitCode})${tracked.stderr ? `: ${tracked.stderr.trim().slice(0, 300)}` : '.'}`;
        throw new Error(tracked.lastError);
      }
      try {
        await healthRequest(workspace.port, token, 1000);
        tracked.state = 'running';
        tracked.startedAt = Date.now();
        tracked.lastHealthAt = Date.now();
        return this.status(workspace.id);
      } catch (err) {
        lastErr = err as Error;
        await sleep(100);
      }
    }
    tracked.state = 'error';
    tracked.lastError = `fleet service không ready sau ${FLEET_SERVICE_READY_TIMEOUT_MS}ms: ${lastErr?.message ?? 'timeout.'}`;
    throw new Error(tracked.lastError);
  }

  private async onChildExit(workspace: FleetWorkspace, tracked: TrackedService): Promise<void> {
    // Start chưa từng thành công: start() đã/đang báo lỗi — không restart.
    if (tracked.state !== 'running' || tracked.disposed) return;
    tracked.state = 'error';
    tracked.lastError = `fleet service thoát bất ngờ (code ${tracked.child.exitCode ?? 'unknown'}).`;
    // Tối đa FLEET_SERVICE_MAX_RESTARTS lần restart TÍNH TỪ LẦN CHẠY ĐẦU:
    // mỗi lần chết chỉ kích hoạt đúng 1 lần restart (bộ đếm đi theo
    // tracked mới), backoff tăng dần theo số lần đã restart.
    if (tracked.restarts >= FLEET_SERVICE_MAX_RESTARTS) return;
    await sleep(FLEET_SERVICE_RESTART_BACKOFF_MS[tracked.restarts] ?? 1000);
    // Đã có tracked mới thay thế (start khác thành công) hoặc đã dispose → dừng.
    if (tracked.disposed || this.services.get(workspace.id) !== tracked) return;
    try {
      await this.startInternal(workspace, {}, tracked.restarts + 1);
    } catch (err) {
      // Restart thất bại — giữ state 'error' để caller thấy rõ.
      tracked.state = 'error';
      tracked.lastError = `fleet service restart thất bại (đã restart ${tracked.restarts + 1}/${FLEET_SERVICE_MAX_RESTARTS} lần): ${(err as Error).message}`;
    }
  }

  /** Dừng service (idempotent). */
  async stop(workspaceId: string): Promise<FleetServiceStatus> {
    const svc = this.services.get(workspaceId);
    if (!svc || svc.child.exitCode !== null) {
      if (svc) {
        svc.disposed = true;
        svc.state = 'stopped';
      }
      return this.status(workspaceId);
    }
    svc.disposed = true;
    const pid = svc.child.pid;
    if (pid !== undefined) await killProcessGroup(pid);
    const deadline = Date.now() + FLEET_SERVICE_STOP_TIMEOUT_MS;
    while (svc.child.exitCode === null && Date.now() < deadline) {
      await sleep(50);
    }
    if (svc.child.exitCode === null && pid !== undefined) {
      await killProcessGroupForce(pid);
      const forceDeadline = Date.now() + 2000;
      while (svc.child.exitCode === null && Date.now() < forceDeadline) {
        await sleep(50);
      }
    }
    svc.state = 'stopped';
    return this.status(workspaceId);
  }

  /**
   * Dừng service theo pid đã lưu trong registry — dùng khi process này
   * không còn handle của child (vd CLI chạy riêng process muốn dừng
   * service do desktop start). Service spawn với detached process group
   * trên POSIX nên pgid == pid, kill cả cây như stop() thường.
   */
  async stopByPid(workspaceId: string, pid: number): Promise<FleetServiceStatus> {
    const tracked = this.services.get(workspaceId);
    if (tracked) return this.stop(workspaceId);
    if (!isPidAlive(pid)) {
      return { workspaceId, state: 'stopped', restarts: 0 };
    }
    await killProcessGroup(pid);
    const deadline = Date.now() + FLEET_SERVICE_STOP_TIMEOUT_MS;
    while (isPidAlive(pid) && Date.now() < deadline) {
      await sleep(50);
    }
    if (isPidAlive(pid)) {
      await killProcessGroupForce(pid);
      const forceDeadline = Date.now() + 2000;
      while (isPidAlive(pid) && Date.now() < forceDeadline) {
        await sleep(50);
      }
    }
    return { workspaceId, state: isPidAlive(pid) ? 'error' : 'stopped', restarts: 0 };
  }

  /** Restart service (token mới). */
  async restart(workspace: FleetWorkspace, opts: { uid?: number } = {}): Promise<FleetServiceStatus> {
    await this.stop(workspace.id);
    return this.start(workspace, opts);
  }

  /** Health check một lần (cần service đang chạy). */
  async health(workspace: FleetWorkspace): Promise<{ uptimeMs: number; pid: number }> {
    const svc = this.services.get(workspace.id);
    if (!svc || svc.state !== 'running') {
      throw new Error(`Service của workspace "${workspace.name}" không chạy.`);
    }
    const result = await healthRequest(workspace.port, svc.token, FLEET_SERVICE_HEALTH_TIMEOUT_MS);
    svc.lastHealthAt = Date.now();
    return result;
  }

  /** Dừng toàn bộ service (khi tắt app) — best-effort, không throw. */
  async dispose(): Promise<void> {
    for (const id of [...this.services.keys()]) {
      try {
        await this.stop(id);
      } catch {
        // Bỏ qua lỗi khi dọn dẹp lúc tắt app.
      }
    }
  }
}
