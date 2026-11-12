/**
 * FleetManager (đội D) — điều phối tầng fleet đa người dùng.
 *
 * Một FleetManager giữ một thư mục gốc của fleet (`<root>/`):
 * - `fleet.json` — registry workspace (xem registry.ts).
 * - `fleet.jsonl` — audit chuỗi hash (xem audit.ts).
 * - `decisions.jsonl` — decision log chuỗi hash.
 * - `usage.jsonl` — usage ledger.
 * - `workspaces/<id>/` — thư mục dữ liệu riêng từng workspace.
 *
 * Thứ tự ghi như TeamStore: lưu state trước, ghi audit sau; nếu ghi
 * audit lỗi thì throw để caller biết (state đã đổi nhưng event thiếu).
 * Quyết định TỪ CHỐI (vd máy không đủ sức chứa) chỉ ghi vào decision
 * log (không có gì thay đổi nên không có audit event).
 *
 * Manager giữ FleetServiceManager trong bộ nhớ — sau khi app khởi
 * động lại, service được coi là 'stopped' cho tới khi start lại
 * (registry chỉ giữ trạng thái đã persist; getStatus kiểm tra
 * liveness của pid đã lưu để không báo chạy khi process đã chết).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeMachine, type ProbeDeps } from '../compute/probe';
import type { MachineProfile, PlannerPolicy } from '../compute/types';
import {
  appendFleetAuditEvent,
  appendFleetDecision,
  listFleetAuditEvents,
  listFleetDecisions,
  verifyFleetAuditLog,
  verifyFleetDecisionLog,
} from './audit';
import type { AuditEvent, AuditVerifyResult } from '../team/audit';
import { checkFleetCapacity } from './capacity';
import {
  assertWorkspaceRootInsideFleet,
  currentOsUser,
  getOsUserUid,
  isRunningPrivileged,
  probeOsUser,
  readWorkspaceFile,
  resolveIsolationLevel,
  writeWorkspaceFile,
} from './isolation';
import {
  FLEET_AUTO_PORT_MAX,
  FLEET_AUTO_PORT_MIN,
  createFleetWorkspace,
  findFleetWorkspace,
  loadFleetWorkspaces,
  pickFreePort,
  removeFleetWorkspace,
  renameFleetWorkspace,
  saveFleetWorkspaces,
  setFleetWorkspaceStatus,
  updateFleetWorkspace,
} from './registry';
import { FleetServiceManager } from './service';
import type { FleetServiceManagerOptions } from './service';
import {
  measureWorkspaceUsage,
  readUsageSamplesFor,
  recordUsageSample,
  summarizeUsage,
} from './usage';
import type {
  CreateFleetWorkspaceInput,
  FleetCapacityCheck,
  FleetDecision,
  FleetMember,
  FleetRole,
  FleetStatusView,
  FleetUsageSummary,
  FleetWorkspace,
} from './types';

export interface FleetManagerOptions {
  /** Thư mục gốc của fleet (vd <userData>/fleet). */
  rootDir: string;
  /** Hàm probe máy (inject để test dùng fake profile). */
  probeFn?: (deps?: ProbeDeps) => Promise<MachineProfile>;
  /** Tuỳ chọn cho FleetServiceManager (workerPath/spawnFn để test). */
  serviceOptions?: FleetServiceManagerOptions;
  /** Chính sách sức chứa (mặc định theo planner của compute). */
  capacityPolicy?: PlannerPolicy;
}

/** Kiểm tra port có đang trống trên loopback không (bind thử rồi đóng). */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export class FleetManager {
  readonly rootDir: string;
  private readonly probeFn: (deps?: ProbeDeps) => Promise<MachineProfile>;
  private readonly services: FleetServiceManager;
  private readonly capacityPolicy?: PlannerPolicy;

  constructor(options: FleetManagerOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
      throw new Error('FleetManager cần rootDir không rỗng.');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.probeFn = options.probeFn ?? probeMachine;
    this.services = new FleetServiceManager(options.serviceOptions);
    this.capacityPolicy = options.capacityPolicy;
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  listWorkspaces(): FleetWorkspace[] {
    return loadFleetWorkspaces(this.rootDir);
  }

  getWorkspace(id: string): FleetWorkspace {
    const ws = findFleetWorkspace(this.listWorkspaces(), id);
    if (!ws) throw new Error(`Không có workspace fleet "${id}".`);
    return ws;
  }

  /** Kiểm tra sức chứa cho một yêu cầu (probe máy tươi). */
  async checkCapacity(request: { cpuCores: number; ramBytes: number; diskBytes: number }): Promise<FleetCapacityCheck> {
    const profile = await this.probeFn();
    return checkFleetCapacity(profile, this.listWorkspaces(), request, this.capacityPolicy);
  }

  /**
   * Tạo workspace: kiểm tra sức chứa trước (không đủ → ghi decision
   * deny + throw, không tạo gì), rồi lưu registry, tạo thư mục
   * (0700), ghi audit + decision allow.
   */
  async createWorkspace(input: CreateFleetWorkspaceInput, actor?: string): Promise<FleetWorkspace> {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const list = this.listWorkspaces();
    const id = input.id !== undefined && input.id.trim() !== '' ? input.id.trim() : `fw-${randomUUID()}`;
    const rootDir = input.rootDir !== undefined ? path.resolve(input.rootDir) : path.join(this.rootDir, 'workspaces', id);
    assertWorkspaceRootInsideFleet(this.rootDir, rootDir);
    const cpuCores = input.cpuCores ?? 1;
    const ramBytes = input.ramBytes ?? 512 * 1024 ** 2;
    const diskBytes = input.diskBytes ?? 10 * 1024 ** 3;
    const profile = await this.probeFn();
    const check = checkFleetCapacity(profile, list, { cpuCores, ramBytes, diskBytes }, this.capacityPolicy);
    if (!check.ok) {
      appendFleetDecision(this.rootDir, {
        actor: who,
        action: 'workspace.create',
        target: `workspace:${input.name.trim()}`,
        decision: 'deny',
        reason: check.reasonDetail ?? check.reason ?? 'máy không đủ sức chứa.',
        detail: { cpuCores, ramBytes, diskBytes },
      });
      throw new Error(`Không tạo được workspace "${input.name.trim()}": ${check.reasonDetail ?? check.reason ?? 'máy không đủ sức chứa.'}`);
    }
    // Cấp port: người dùng cho trước thì dùng, còn không thì chọn port
    // trống trong registry VÀ kiểm tra thật trên loopback.
    let port = input.port;
    if (port === undefined) {
      port = pickFreePort(list);
      for (let attempt = 0; attempt < 20 && !(await isPortFree(port)); attempt++) {
        port += 1;
        if (port > FLEET_AUTO_PORT_MAX) port = FLEET_AUTO_PORT_MIN;
      }
      if (!(await isPortFree(port))) {
        throw new Error('Không tìm được port trống cho service fleet (đã thử 20 port).');
      }
    } else if (!(await isPortFree(port))) {
      throw new Error(`Port ${port} đang bị chiếm trên máy này.`);
    }
    const osUserProbe = probeOsUser(input.osUser.trim());
    const isolation = resolveIsolationLevel({
      runningAsRoot: isRunningPrivileged(),
      osUserExists: osUserProbe.exists,
      platform: process.platform,
    });
    const { list: next, workspace } = createFleetWorkspace(list, {
      ...input,
      id,
      port,
      rootDir,
      cpuCores,
      ramBytes,
      diskBytes,
    });
    const finalWorkspace: FleetWorkspace = {
      ...workspace,
      isolationLevel: isolation.level,
      ...(isolation.reason !== undefined ? { isolationReason: isolation.reason } : {}),
    };
    const finalList = next.map((ws) => (ws.id === finalWorkspace.id ? finalWorkspace : ws));
    saveFleetWorkspaces(this.rootDir, finalList);
    fs.mkdirSync(finalWorkspace.rootDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(finalWorkspace.rootDir, 0o700);
    } catch {
      // Windows không có chmod POSIX — bỏ qua.
    }
    appendFleetAuditEvent(this.rootDir, {
      actor: who,
      action: 'workspace.create',
      target: `workspace:${finalWorkspace.id}`,
      detail: { name: finalWorkspace.name, osUser: finalWorkspace.osUser, port: finalWorkspace.port, isolationLevel: isolation.level },
    });
    appendFleetDecision(this.rootDir, {
      actor: who,
      action: 'workspace.create',
      target: `workspace:${finalWorkspace.id}`,
      decision: 'allow',
      detail: { name: finalWorkspace.name },
    });
    return finalWorkspace;
  }

  /** Đổi tên workspace. */
  renameWorkspace(id: string, name: string, actor?: string): FleetWorkspace {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const next = renameFleetWorkspace(this.listWorkspaces(), id, name);
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'workspace.rename', target: `workspace:${id}`, detail: { name: name.trim() } });
    const ws = findFleetWorkspace(next, id);
    if (!ws) throw new Error(`Không có workspace fleet "${id}".`);
    return ws;
  }

  /**
   * Xoá workspace khỏi registry. Service phải dừng trước (fail-closed).
   * Thư mục dữ liệu chỉ xoá khi `deleteData: true` — và chỉ khi nằm
   * trong thư mục gốc của fleet.
   */
  removeWorkspace(id: string, actor?: string, opts: { deleteData?: boolean } = {}): void {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(id);
    if (this.services.isRunning(id)) {
      throw new Error(`Service của workspace "${ws.name}" đang chạy — dừng service trước khi xoá.`);
    }
    const next = removeFleetWorkspace(this.listWorkspaces(), id);
    saveFleetWorkspaces(this.rootDir, next);
    if (opts.deleteData === true) {
      assertWorkspaceRootInsideFleet(this.rootDir, ws.rootDir);
      fs.rmSync(ws.rootDir, { recursive: true, force: true });
    }
    appendFleetAuditEvent(this.rootDir, {
      actor: who,
      action: 'workspace.remove',
      target: `workspace:${id}`,
      detail: { name: ws.name, deleteData: opts.deleteData === true },
    });
  }

  /** Tạm dừng workspace (đồng thời dừng service nếu đang chạy). */
  async suspendWorkspace(id: string, actor?: string): Promise<FleetWorkspace> {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(id);
    if (this.services.isRunning(id)) await this.stopService(id, who);
    const next = setFleetWorkspaceStatus(this.listWorkspaces(), id, 'suspended');
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'workspace.suspend', target: `workspace:${id}` });
    return this.getWorkspace(id);
  }

  /** Kích hoạt lại workspace đã tạm dừng. */
  activateWorkspace(id: string, actor?: string): FleetWorkspace {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const next = setFleetWorkspaceStatus(this.listWorkspaces(), id, 'active');
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'workspace.activate', target: `workspace:${id}` });
    return this.getWorkspace(id);
  }

  // -------------------------------------------------------------------------
  // Thành viên
  // -------------------------------------------------------------------------

  addMember(workspaceId: string, member: { userId: string; role: FleetRole }, actor?: string): FleetWorkspace {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(workspaceId);
    const userId = member.userId.trim();
    if (userId.length === 0) throw new Error('userId không được rỗng.');
    if (!['admin', 'member', 'chat-only'].includes(member.role)) {
      throw new Error("role phải là 'admin', 'member' hoặc 'chat-only'.");
    }
    if (ws.members.some((m) => m.userId === userId)) {
      throw new Error(`"${userId}" đã là thành viên của workspace "${ws.name}".`);
    }
    const now = new Date().toISOString();
    const nextMembers: FleetMember[] = [...ws.members, { userId, role: member.role, addedBy: who, addedAt: now }];
    const next = this.listWorkspaces().map((other) =>
      other.id === workspaceId ? { ...other, members: nextMembers, updatedAt: now } : other,
    );
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, {
      actor: who,
      action: 'member.add',
      target: `workspace:${workspaceId}`,
      detail: { userId, role: member.role },
    });
    return this.getWorkspace(workspaceId);
  }

  removeMember(workspaceId: string, userId: string, actor?: string): FleetWorkspace {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(workspaceId);
    if (!ws.members.some((m) => m.userId === userId)) {
      throw new Error(`"${userId}" không phải thành viên của workspace "${ws.name}".`);
    }
    const now = new Date().toISOString();
    const next = this.listWorkspaces().map((other) =>
      other.id === workspaceId
        ? { ...other, members: other.members.filter((m) => m.userId !== userId), updatedAt: now }
        : other,
    );
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'member.remove', target: `workspace:${workspaceId}`, detail: { userId } });
    return this.getWorkspace(workspaceId);
  }

  setMemberRole(workspaceId: string, userId: string, role: FleetRole, actor?: string): FleetWorkspace {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(workspaceId);
    if (!['admin', 'member', 'chat-only'].includes(role)) {
      throw new Error("role phải là 'admin', 'member' hoặc 'chat-only'.");
    }
    if (!ws.members.some((m) => m.userId === userId)) {
      throw new Error(`"${userId}" không phải thành viên của workspace "${ws.name}".`);
    }
    const now = new Date().toISOString();
    const next = this.listWorkspaces().map((other) =>
      other.id === workspaceId
        ? { ...other, members: other.members.map((m) => (m.userId === userId ? { ...m, role } : m)), updatedAt: now }
        : other,
    );
    saveFleetWorkspaces(this.rootDir, next);
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'member.set-role', target: `workspace:${workspaceId}`, detail: { userId, role } });
    return this.getWorkspace(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  /** Start service của workspace (ghi decision allow/deny + audit). */
  async startService(id: string, actor?: string): Promise<FleetStatusView> {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(id);
    if (ws.status !== 'active') {
      appendFleetDecision(this.rootDir, {
        actor: who,
        action: 'service.start',
        target: `workspace:${id}`,
        decision: 'deny',
        reason: `workspace "${ws.name}" đang tạm dừng.`,
      });
      throw new Error(`Workspace "${ws.name}" đang tạm dừng — kích hoạt lại trước khi start service.`);
    }
    const uid = ws.isolationLevel === 'os-user' ? getOsUserUid(ws.osUser) ?? undefined : undefined;
    try {
      await this.services.start(ws, uid !== undefined ? { uid } : {});
    } catch (err) {
      const message = (err as Error).message;
      saveFleetWorkspaces(
        this.rootDir,
        updateFleetWorkspace(this.listWorkspaces(), id, { serviceState: 'error', lastError: message, pid: undefined }),
      );
      appendFleetDecision(this.rootDir, {
        actor: who,
        action: 'service.start',
        target: `workspace:${id}`,
        decision: 'deny',
        reason: message,
      });
      throw err;
    }
    const status = this.services.status(id);
    saveFleetWorkspaces(
      this.rootDir,
      updateFleetWorkspace(this.listWorkspaces(), id, {
        serviceState: 'running',
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
        lastError: undefined,
      }),
    );
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'service.start', target: `workspace:${id}` });
    appendFleetDecision(this.rootDir, { actor: who, action: 'service.start', target: `workspace:${id}`, decision: 'allow' });
    return this.getStatus(id);
  }

  /** Dừng service: dùng handle trong bộ nhớ nếu có, còn không thì dừng theo pid đã lưu (vd CLI dừng service do desktop start). */
  private async stopServiceInternal(ws: FleetWorkspace): Promise<void> {
    if (this.services.isRunning(ws.id)) {
      await this.services.stop(ws.id);
    } else if (ws.serviceState === 'running' && ws.pid !== undefined) {
      await this.services.stopByPid(ws.id, ws.pid);
    }
  }

  /** Dừng service của workspace. */
  async stopService(id: string, actor?: string): Promise<FleetStatusView> {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(id);
    await this.stopServiceInternal(ws);
    saveFleetWorkspaces(
      this.rootDir,
      updateFleetWorkspace(this.listWorkspaces(), id, { serviceState: 'stopped', pid: undefined }),
    );
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'service.stop', target: `workspace:${id}` });
    return this.getStatus(id);
  }

  /** Restart service của workspace. */
  async restartService(id: string, actor?: string): Promise<FleetStatusView> {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(id);
    const uid = ws.isolationLevel === 'os-user' ? getOsUserUid(ws.osUser) ?? undefined : undefined;
    await this.stopServiceInternal(ws);
    await this.services.restart(ws, uid !== undefined ? { uid } : {});
    const status = this.services.status(id);
    saveFleetWorkspaces(
      this.rootDir,
      updateFleetWorkspace(this.listWorkspaces(), id, {
        serviceState: 'running',
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
        lastError: undefined,
      }),
    );
    appendFleetAuditEvent(this.rootDir, { actor: who, action: 'service.restart', target: `workspace:${id}` });
    return this.getStatus(id);
  }

  /** Health check một lần (cần service đang chạy). */
  async healthCheck(id: string): Promise<{ uptimeMs: number; pid: number }> {
    const ws = this.getWorkspace(id);
    return this.services.health(ws);
  }

  // -------------------------------------------------------------------------
  // Trạng thái / mức dùng
  // -------------------------------------------------------------------------

  /** Trạng thái đầy đủ của một workspace (kiểm tra liveness của pid đã lưu). */
  getStatus(id: string): FleetStatusView {
    const ws = this.getWorkspace(id);
    const svc = this.services.status(id);
    let pid: number | undefined;
    let uptimeMs: number | null = null;
    let lastHealthAt: number | null = null;
    let state = svc.state;
    if (svc.state === 'running' && svc.pid !== undefined) {
      pid = svc.pid;
      uptimeMs = svc.startedAt !== undefined ? Date.now() - svc.startedAt : null;
      lastHealthAt = svc.lastHealthAt ?? null;
    } else if (svc.state === 'stopped' && ws.serviceState === 'running' && ws.pid !== undefined) {
      // Manager trong bộ nhớ không còn service nhưng registry ghi đang
      // chạy (vd app vừa khởi động lại): kiểm tra pid còn sống không.
      if (isPidAlive(ws.pid)) {
        state = 'running';
        pid = ws.pid;
      } else {
        state = 'stopped';
      }
    }
    return {
      workspace: { ...ws, serviceState: state },
      service: {
        state,
        ...(pid !== undefined ? { pid } : {}),
        uptimeMs,
        lastHealthAt,
        ...(svc.lastError !== undefined ? { lastError: svc.lastError } : {}),
      },
      usage: summarizeUsage(this.rootDir, id),
    };
  }

  listFleet(): FleetStatusView[] {
    return this.listWorkspaces().map((ws) => this.getStatus(ws.id));
  }

  /** Đo + ghi một mẫu mức dùng cho workspace. */
  recordUsage(id: string): FleetUsageSummary | null {
    const ws = this.getWorkspace(id);
    const svc = this.services.status(id);
    // PID đo CPU/RSS: handle trong bộ nhớ trước, còn không thì pid đã
    // lưu trong registry (service do process khác start, vd desktop) —
    // chỉ khi pid đó còn sống.
    let pid: number | null = null;
    if (svc.state === 'running' && svc.pid !== undefined) {
      pid = svc.pid;
    } else if (ws.serviceState === 'running' && ws.pid !== undefined && isPidAlive(ws.pid)) {
      pid = ws.pid;
    }
    const sample = measureWorkspaceUsage(id, pid, ws.rootDir);
    recordUsageSample(this.rootDir, sample);
    return summarizeUsage(this.rootDir, id);
  }

  getUsage(id: string, opts: { since?: number } = {}): FleetUsageSummary | null {
    this.getWorkspace(id);
    return summarizeUsage(this.rootDir, id, opts);
  }

  // -------------------------------------------------------------------------
  // Audit / decision / file trong workspace
  // -------------------------------------------------------------------------

  verifyAudit(): AuditVerifyResult {
    return verifyFleetAuditLog(this.rootDir);
  }

  verifyDecisions(): AuditVerifyResult {
    return verifyFleetDecisionLog(this.rootDir);
  }

  listAudit(filter: { actor?: string; action?: string; target?: string; since?: number; until?: number } = {}): AuditEvent[] {
    return listFleetAuditEvents(this.rootDir, filter);
  }

  listDecisions(filter: {
    actor?: string;
    action?: string;
    target?: string;
    decision?: 'allow' | 'deny';
    since?: number;
    until?: number;
  } = {}): FleetDecision[] {
    return listFleetDecisions(this.rootDir, filter);
  }

  /** Đọc file trong workspace (fail-closed khi nằm ngoài workspace). */
  readWorkspaceFile(workspaceId: string, relPath: string): string {
    const ws = this.getWorkspace(workspaceId);
    try {
      return readWorkspaceFile(ws, relPath);
    } catch (err) {
      appendFleetAuditEvent(this.rootDir, {
        actor: currentOsUser(),
        action: 'file.read-denied',
        target: `workspace:${workspaceId}`,
        detail: { relPath },
      });
      throw err;
    }
  }

  /** Ghi file trong workspace (fail-closed khi nằm ngoài workspace). */
  writeWorkspaceFile(workspaceId: string, relPath: string, content: string, actor?: string): void {
    const who = (actor ?? currentOsUser()).trim() || 'system';
    const ws = this.getWorkspace(workspaceId);
    try {
      writeWorkspaceFile(ws, relPath, content);
    } catch (err) {
      appendFleetAuditEvent(this.rootDir, {
        actor: who,
        action: 'file.write-denied',
        target: `workspace:${workspaceId}`,
        detail: { relPath },
      });
      throw err;
    }
  }

  /** Đọc mẫu mức dùng thô của một workspace. */
  readUsageSamples(workspaceId: string, opts: { since?: number; limit?: number } = {}) {
    this.getWorkspace(workspaceId);
    return readUsageSamplesFor(this.rootDir, workspaceId, opts);
  }

  /** Dừng toàn bộ service (khi tắt app) — best-effort. */
  async dispose(): Promise<void> {
    await this.services.dispose();
  }
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
