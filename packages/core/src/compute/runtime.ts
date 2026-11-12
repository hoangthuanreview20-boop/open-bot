/**
 * Per-bot computer runtime — thang cách ly + vòng đời máy-tính-bot
 * (sóng B, đội platform).
 *
 * Thang cách ly (theo sức máy — planner chọn, runtime thực thi):
 *   box       — thư mục riêng + env allow-list (BotBoxManager). Luôn có.
 *   container — box chạy trong namespace thật (bwrap/unshare). Khi máy
 *               không có bwrap/unshare, mức container HẠ XUỐNG box và
 *               ghi cảnh báo rõ (không bao giờ báo đã cách ly khi chỉ
 *               là box thường).
 *   vm        — VM local thật (QEMU/KVM). Cần disk image do người dùng
 *               cung cấp (opt-in, yêu cầu rõ ràng); chưa có image thì
 *               start() báo lỗi rõ ràng, không giả vờ đã boot.
 *
 * Vòng đời: stopped -> running -> paused -> running -> stopped.
 * - pause (box/container): chặn lệnh mới (runInComputer từ chối khi
 *   không running); VM có pid thì SIGSTOP thật (đóng băng VM).
 * - resume: mở lại; VM đã thoát hẳn thì phải start lại (boot lại).
 * - stop: dừng gate egress; VM thì SIGTERM process group QEMU.
 *
 * Tài nguyên đã cấp được enforce ở mức box bằng prlimit (Linux) qua
 * BotBoxManager: cpuSeconds = cpuCores * timeout (không đốt CPU quá
 * số core đã cấp), maxMemoryBytes = ramBytes, maxProcesses = 256.
 * Xem sandbox/box.ts (wrapWithPrlimit).
 *
 * Mạng ra ngoài của box/container đi qua EgressGate riêng từng máy
 * (policy resolve từ team/global — caller truyền vào khi tạo).
 * Mạng của VM mặc định không có NIC (`vmNetwork: 'none'`, v0.78 M2);
 * chọn `'nat'` thì QEMU dùng user-mode NAT và egress policy KHÔNG
 * enforce được trong VM. Chạy lệnh trong VM qua guest agent
 * (`compute/guestAgent.ts` + `guest-agent.mjs` trong VM, v0.78 M3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { BotBoxManager, DEFAULT_BOX_LIMITS, EgressGate, dirSizeBytes } from '../sandbox/index';
import type { BoxRunResult, EgressGate as EgressGateType } from '../sandbox/index';
import type { EgressPolicy } from '../egress/types';
import { CGROUP_NAME_PREFIX, CgroupMemoryLimiter, probeCgroupMemory } from './cgroup';
import type { CgroupMemoryProbe } from './cgroup';
import { GUEST_AGENT_DEFAULT_TIMEOUT_MS, GuestAgentClient } from './guestAgent';
import { isHostBusy, suggestShedOrder } from './planner';
import {
  COMPUTER_AUTO_SHED_AUDIT_ACTION,
  clampPriority,
  emptySchedulerState,
  enqueueRequest,
  parseSchedulerState,
  removeFromQueue,
  selectAutoShedCandidates,
  setQueuePriority,
  tryPromoteQueue,
} from './scheduler';
import type {
  BotComputer,
  BotComputerRequest,
  ComputerAllocation,
  ComputerBackend,
  ComputerBackendKind,
  ComputerLevel,
  ComputerPlan,
  ComputerQueueEntry,
  ComputerSchedulerState,
  ComputerStatusView,
  GuestAgentHealth,
  MachineProfile,
  SchedulerTickResult,
} from './types';
import { commandAvailable } from '../sandbox/index';

export const COMPUTERS_FILE = 'computers.json';

/** Số process tối đa mặc định cho một máy-tính-bot (prlimit --nproc). */
export const DEFAULT_COMPUTER_MAX_PROCESSES = 256;

const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BotComputerRuntimeOptions {
  /** Thư mục gốc của runtime (vd `<userData>/computers`). */
  rootDir: string;
  /** Box manager dùng chung (test inject fake; mặc định tự tạo mới). */
  boxManager?: BotBoxManager;
  /** Backend đã dò (test inject; mặc định tự detect từ profile). */
  backends?: ComputerBackend[];
  /** Profile máy (dùng cho KVM flag của QEMU; test inject fake). */
  profile?: MachineProfile;
  logger?: { warn(message: string): void };
  now?: () => string;
  /**
   * v0.78 (cgroup): thư mục cgroup gốc để probe/tạo cgroup giới hạn
   * RAM (mặc định /sys/fs/cgroup; test truyền thư mục tạm đóng vai
   * cgroup root). Probe chỉ chạy một lần lúc tạo runtime.
   */
  cgroupRoot?: string;
  /**
   * Hàm spawn dùng để boot VM (test inject fake; mặc định spawn thật).
   * Trả về tiến trình đã spawn (cần pid + on + unref).
   */
  spawnFn?: (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: 'ignore' },
  ) => Pick<ChildProcess, 'pid' | 'on' | 'unref'>;
  /**
   * v0.78 (M3): factory tạo client guest agent (test inject fake;
   * mặc định tạo GuestAgentClient thật + connect tới socket QEMU).
   */
  connectGuestAgentFn?: (socketPath: string) => Promise<GuestAgentClient>;
  /**
   * v0.90c (đội G gói C): callback khi auto-shed tự tạm dừng một máy
   * (opt-in, mặc định tắt). Main nối vào audit log (`appendAuditEvent`
   * của team/audit.ts); runtime không tự ghi file audit — callback
   * throw thì runtime chỉ warn, không làm hỏng tick. Test inject
   * collector để assert audit được ghi.
   */
  onAutoShed?: (event: { botId: string; reason: string }) => void;
  /** v0.90c: clock cho `enqueuedAt` (test inject giờ cố định). */
  nowMs?: () => number;
}

/** Throttle kiểm tra sức khoẻ guest: tối đa 1 lần / 15s / bot. */
export const GUEST_HEALTH_CHECK_MIN_INTERVAL_MS = 15_000;

/** Gợi ý cài guest agent (dùng chung cho các trạng thái missing/unhealthy). */
export const GUEST_AGENT_INSTALL_HINT =
  'Guest agent chưa cài/chưa chạy trong VM — copy packages/core/src/compute/guest-agent.mjs vào image rồi chạy: node /opt/open-bot/guest-agent.mjs /dev/virtio-ports/org.open-bot.guest-agent (xem compute/README.md — mục Guest agent).';

function defaultSpawnFn(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
): Pick<ChildProcess, 'pid' | 'on' | 'unref'> {
  return spawn(command, args, options);
}

/** Dò backend thực thi có mặt trên máy (không chạy gì ngoài --version). */
export function detectComputerBackends(
  profile: MachineProfile,
  deps: { commandAvailable?: (cmd: string) => boolean } = {},
): ComputerBackend[] {
  const available = deps.commandAvailable ?? commandAvailable;
  const out: ComputerBackend[] = [
    { kind: 'box', level: 'box', available: true, detail: 'thư mục riêng (không namespace)' },
  ];
  const container: Array<[ComputerBackendKind, string]> = [
    ['bwrap', 'bwrap'],
    ['systemd-nspawn', 'systemd-nspawn'],
    ['podman', 'podman'],
    ['unshare', 'unshare'],
  ];
  for (const [kind, cmd] of container) {
    const ok = available(cmd);
    out.push({
      kind,
      level: 'container',
      available: ok,
      detail: ok ? `${cmd} có mặt trên máy` : `không có ${cmd} trên PATH`,
    });
  }
  const qemuOk = available('qemu-system-x86_64');
  out.push({
    kind: 'qemu',
    level: 'vm',
    available: qemuOk,
    detail: qemuOk
      ? `qemu-system-x86_64 có mặt${profile.virtualization.kvmAvailable ? ' + KVM (/dev/kvm)' : ' (không có KVM — chạy chậm hơn)'}`
      : 'không có qemu-system-x86_64 trên PATH',
  });
  out.push({
    kind: 'wsl',
    level: 'vm',
    available: profile.virtualization.wslAvailable,
    detail: profile.virtualization.wslAvailable ? 'WSL2 có mặt' : 'không thấy WSL2',
  });
  out.push({
    kind: 'hyperv',
    level: 'vm',
    available: profile.virtualization.hyperVAvailable,
    detail: profile.virtualization.hyperVAvailable ? 'Hyper-V đang bật' : 'Hyper-V chưa bật',
  });
  out.push({
    kind: 'macvm',
    level: 'vm',
    available: profile.virtualization.appleVirtualization,
    detail: profile.virtualization.appleVirtualization
      ? 'Virtualization.framework (macOS)'
      : 'không có Virtualization.framework',
  });
  return out;
}

/**
 * Dựng argv boot QEMU cho một VM (không chạy — chỉ dựng lệnh, để test
 * kiểm chứng được). RAM đổi sang MB, CPU lấy phần nguyên (>= 1).
 * `-enable-kvm` chỉ khi máy có KVM. Mạng (v0.78, M2): mặc định 'none'
 * (fail-closed — `-nic none`, VM hoàn toàn không ra mạng); 'nat' là
 * user-mode NAT (`-nic user`, egress policy KHÔNG enforce được).
 * Guest agent (v0.78, M3): `guestAgentSocketPath` thêm chardev socket
 * + virtio-serial port `org.open-bot.guest-agent` để host nói NDJSON
 * với guest trong VM.
 */
export function buildQemuBootArgs(
  imagePath: string,
  computer: Pick<BotComputer, 'cpuCores' | 'ramBytes'>,
  opts: { enableKvm?: boolean; network?: 'none' | 'nat'; guestAgentSocketPath?: string } = {},
): string[] {
  const args = [
    'qemu-system-x86_64',
    '-m',
    String(Math.max(256, Math.floor(computer.ramBytes / 1024 / 1024))),
    '-smp',
    String(Math.max(1, Math.floor(computer.cpuCores))),
    '-drive',
    `file=${imagePath},format=qcow2,if=virtio`,
  ];
  if (opts.enableKvm) args.push('-enable-kvm');
  const network = opts.network ?? 'none';
  args.push('-display', 'none', '-serial', 'none', '-monitor', 'none', '-nic', network === 'nat' ? 'user' : 'none');
  if (opts.guestAgentSocketPath) {
    args.push(
      '-chardev',
      `socket,path=${opts.guestAgentSocketPath},server=on,wait=off,id=agent0`,
      '-device',
      'virtio-serial-pci',
      '-device',
      'virtserialport,chardev=agent0,name=org.open-bot.guest-agent',
    );
  }
  return args;
}

interface ComputersFile {
  version: 1 | 2;
  computers: BotComputer[];
  /** v0.90c: hàng đợi scheduler + cờ auto-shed (chỉ version 2). */
  queue?: ComputerQueueEntry[];
  autoShed?: boolean;
}

function readComputersFile(file: string): { computers: BotComputer[]; scheduler: ComputerSchedulerState } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ComputersFile).computers)) {
      const computers = (parsed as ComputersFile).computers.filter(
        (c) => c && typeof c === 'object' && typeof c.botId === 'string',
      );
      return { computers, scheduler: parseSchedulerState(parsed) };
    }
    return { computers: [], scheduler: emptySchedulerState() };
  } catch {
    return { computers: [], scheduler: emptySchedulerState() };
  }
}

export class BotComputerRuntime {
  readonly rootDir: string;
  private readonly boxManager: BotBoxManager;
  private readonly backends: ComputerBackend[];
  private profile?: MachineProfile;
  private readonly warn: (message: string) => void;
  private readonly now: () => string;
  private readonly spawnFn: NonNullable<BotComputerRuntimeOptions['spawnFn']>;
  private readonly file: string;
  private computers: Map<string, BotComputer> = new Map();
  private readonly gates: Map<string, EgressGateType> = new Map();
  /** v0.78 (cgroup): kết quả probe enforce RAM (chạy 1 lần lúc tạo runtime). */
  private readonly memoryProbe: CgroupMemoryProbe;
  /** v0.78 (cgroup): limiter RAM vật lý theo bot (chỉ mức box/container). */
  private readonly limiters: Map<string, CgroupMemoryLimiter> = new Map();
  private readonly cgroupRoot?: string;
  /** v0.78 (M3): client guest agent đang kết nối theo bot (chỉ mức VM). */
  private readonly guestAgents: Map<string, GuestAgentClient> = new Map();
  private readonly connectGuestAgentFn: NonNullable<BotComputerRuntimeOptions['connectGuestAgentFn']>;
  /** v0.90c: state scheduler bền vững (queue + cờ auto-shed opt-in). */
  private schedulerState: ComputerSchedulerState = emptySchedulerState();
  private readonly onAutoShed?: BotComputerRuntimeOptions['onAutoShed'];
  private readonly nowMs: () => number;
  /** v0.90c: sức khoẻ guest đã kiểm tra gần nhất theo bot (để statusView đọc sync). */
  private readonly guestHealth: Map<string, GuestAgentHealth> = new Map();
  /** v0.90c: lần kiểm tra guest gần nhất (epoch ms) — throttle refresh. */
  private readonly lastGuestHealthCheckAt: Map<string, number> = new Map();
  /** v0.90c: bot đang kiểm tra guest (tránh 2 lần kiểm tra chồng nhau). */
  private readonly guestHealthInFlight: Set<string> = new Set();

  constructor(options: BotComputerRuntimeOptions) {
    this.rootDir = options.rootDir;
    this.boxManager = options.boxManager ?? new BotBoxManager({ rootDir: options.rootDir });
    this.profile = options.profile;
    this.backends = options.backends ?? [];
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnFn = options.spawnFn ?? defaultSpawnFn;
    this.connectGuestAgentFn =
      options.connectGuestAgentFn ??
      (async (socketPath: string) => {
        const client = new GuestAgentClient(socketPath);
        await client.connect();
        return client;
      });
    this.onAutoShed = options.onAutoShed;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.file = path.join(options.rootDir, COMPUTERS_FILE);
    fs.mkdirSync(options.rootDir, { recursive: true });
    this.load();
    // v0.78 (cgroup): probe 1 lần (best-effort, không throw) + gắn
    // hook đưa process của box vào cgroup ngay sau spawn.
    this.cgroupRoot = options.cgroupRoot;
    this.memoryProbe = probeCgroupMemory({ cgroupRoot: options.cgroupRoot });
    if (!this.memoryProbe.available) {
      this.warn(`computer runtime: không enforce RAM vật lý bằng cgroup được — ${this.memoryProbe.reason ?? 'không rõ lý do'} (giữ prlimit làm best-effort).`);
    }
    // v0.78 (cgroup): gắn hook đưa process của box vào cgroup ngay sau
    // spawn. BoxManager inject từ ngoài (fake trong test) có thể không
    // có setSpawnHook — khi đó chỉ không gắn được cgroup, runtime vẫn
    // chạy bình thường.
    const maybeHook = (
      this.boxManager as unknown as {
        setSpawnHook?: (fn: (botId: string, child: { pid?: number }) => void) => void;
      }
    ).setSpawnHook;
    if (typeof maybeHook === 'function') {
      maybeHook.call(this.boxManager, (botId, child) => {
        const limiter = this.limiters.get(botId);
        if (!limiter) return;
        if (child.pid === undefined) return;
        try {
          limiter.addPid(child.pid);
        } catch (err) {
          this.warn(`computer ${botId}: không đưa được pid ${child.pid} vào cgroup (${(err as Error).message}).`);
        }
      });
    }
  }

  /** Backend đã dò (để planner/UI dùng). */
  getBackends(): ComputerBackend[] {
    return [...this.backends];
  }

  /** Cập nhật profile máy (vd sau khi probe lại — QEMU dùng KVM flag mới). */
  setProfile(profile: MachineProfile): void {
    this.profile = profile;
  }

  listComputers(): BotComputer[] {
    return [...this.computers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getComputer(botId: string): BotComputer | undefined {
    return this.computers.get(botId);
  }

  /** Env proxy của gate egress (rỗng khi gate chưa chạy). */
  computerProxyEnv(botId: string): Record<string, string> {
    const gate = this.gates.get(botId);
    if (!gate || !gate.running) return {};
    return gate.proxyEnv();
  }

  /** True khi gate egress của máy-tính-bot đang chạy. */
  gateRunning(botId: string): boolean {
    const gate = this.gates.get(botId);
    return gate?.running ?? false;
  }

  /**
   * Tạo máy-tính-bot từ một allocation của planner (idempotent: đã có
   * thì trả về bản ghi cũ). Box được tạo kèm với giới hạn tài nguyên
   * suy ra từ allocation (prlimit, Linux).
   */
  createComputer(
    allocation: ComputerAllocation,
    opts: { egressPolicy?: EgressPolicy } = {},
  ): BotComputer {
    const botId = allocation.botId;
    if (!BOT_ID_RE.test(botId) || botId.includes('..')) {
      throw new Error(`Invalid botId "${botId}": use letters, digits, ".", "-" and "_" only.`);
    }
    const existing = this.computers.get(botId);
    if (existing) return existing;
    const timeoutMs = DEFAULT_BOX_LIMITS.timeoutMs;
    const box = this.boxManager.createBox(botId, {
      envAllowlist: ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'],
      limits: {
        timeoutMs,
        // Không đốt CPU quá số core đã cấp trong thời gian chạy.
        cpuSeconds: Math.max(1, Math.ceil(allocation.cpuCores * (timeoutMs / 1000))),
        maxMemoryBytes: allocation.ramBytes,
        maxProcesses: DEFAULT_COMPUTER_MAX_PROCESSES,
      },
    });
    const now = this.now();
    const computer: BotComputer = {
      id: `computer-${botId}`,
      botId,
      level: allocation.level,
      backend: allocation.backend,
      backendDetail: allocation.backendDetail,
      cpuCores: allocation.cpuCores,
      ramBytes: allocation.ramBytes,
      diskBytes: allocation.diskBytes,
      priority: allocation.priority,
      state: 'stopped',
      workspaceDir: box.workspaceDir,
      ...(opts.egressPolicy ? { egressPolicy: opts.egressPolicy } : {}),
      diskUsedBytes: null,
      createdAt: now,
      updatedAt: now,
    };
    this.computers.set(botId, computer);
    // v0.78 (cgroup): limiter RAM vật lý cho mức box/container (VM
    // không dùng cgroup — RAM VM đã bị chặn bởi QEMU `-m`).
    this.ensureMemoryLimiter(computer);
    this.save();
    return computer;
  }

  /** Gắn disk image cho VM (opt-in — image do người dùng cung cấp). */
  setVmImage(botId: string, imagePath: string): BotComputer {
    const computer = this.requireComputer(botId);
    if (computer.level !== 'vm') {
      throw new Error(`Bot "${botId}" đang ở mức "${computer.level}" — chỉ máy mức VM mới cần disk image.`);
    }
    computer.imagePath = imagePath;
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  /**
   * v0.78 (M2): đặt chế độ mạng của VM — 'none' (mặc định, fail-closed:
   * VM không có NIC, hoàn toàn không ra mạng) hoặc 'nat' (QEMU
   * user-mode NAT; egress policy KHÔNG enforce được trong VM).
   * Chỉ áp dụng cho máy mức VM; có hiệu lực ở lần boot sau.
   */
  setVmNetwork(botId: string, network: 'none' | 'nat'): BotComputer {
    const computer = this.requireComputer(botId);
    if (computer.level !== 'vm') {
      throw new Error(`Bot "${botId}" đang ở mức "${computer.level}" — chỉ máy mức VM mới có chế độ mạng VM.`);
    }
    if (network !== 'none' && network !== 'nat') {
      throw new Error(`Chế độ mạng VM không hợp lệ: "${String(network)}" — chỉ nhận 'none' hoặc 'nat'.`);
    }
    computer.vmNetwork = network;
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  /**
   * v0.78 (M3): đường dẫn Unix socket QEMU lắng nghe cho guest agent
   * của máy này (đạo ra từ rootDir — không lưu trong computers.json).
   */
  guestAgentSocketPath(botId: string): string {
    return path.join(this.rootDir, `${botId}.agent.sock`);
  }

  /**
   * v0.78 (M3): kết nối tới guest agent trong VM (chỉ máy mức VM
   * đang running). Trả client đã kết nối (cache lại để dùng lại).
   * Throw lỗi rõ kèm hướng dẫn cài guest khi không kết nối được —
   * không giả vờ VM chạy được lệnh.
   */
  async connectGuestAgent(botId: string): Promise<GuestAgentClient> {
    const computer = this.requireComputer(botId);
    if (computer.level !== 'vm') {
      throw new Error(`Bot "${botId}" đang ở mức "${computer.level}" — chỉ máy mức VM mới có guest agent.`);
    }
    if (computer.state !== 'running') {
      throw new Error(
        `Máy-tính-bot "${computer.id}" đang ở trạng thái "${computer.state}" — boot VM (start) trước khi kết nối guest agent.`,
      );
    }
    const existing = this.guestAgents.get(botId);
    if (existing?.connected) return existing;
    const socketPath = this.guestAgentSocketPath(botId);
    try {
      // Fail-fast: QEMU tạo socket ngay khi boot; chưa có file socket
      // nghĩa là VM chưa boot xong (thử lại sau vài giây) hoặc QEMU
      // boot không kèm chardev — đừng chờ hết timeout kết nối.
      if (!fs.existsSync(socketPath)) {
        throw new Error(
          `Socket guest agent chưa xuất hiện (${socketPath}) — VM có thể chưa boot xong (thử lại sau vài giây), hoặc QEMU boot không kèm chardev guest agent.`,
        );
      }
      const client = await this.connectGuestAgentFn(socketPath);
      this.guestAgents.set(botId, client);
      return client;
    } catch (err) {
      throw new Error(
        `Không kết nối được guest agent trong VM của bot "${botId}": ${(err as Error).message} ` +
          `Guest agent chưa cài/chưa chạy trong VM — copy file packages/core/src/compute/guest-agent.mjs vào image ` +
          `rồi chạy: node /opt/open-bot/guest-agent.mjs /dev/virtio-ports/org.open-bot.guest-agent ` +
          `(xem compute/README.md — mục Guest agent).`,
      );
    }
  }

  /** v0.78 (M3): trạng thái kết nối guest agent của một máy-tính-bot. */
  guestAgentStatus(botId: string): { connected: boolean; socketPath: string | null } {
    const computer = this.computers.get(botId);
    if (!computer || computer.level !== 'vm') return { connected: false, socketPath: null };
    return {
      connected: this.guestAgents.get(botId)?.connected ?? false,
      socketPath: this.guestAgentSocketPath(botId),
    };
  }

  /**
   * v0.90c: sức khoẻ guest đã kiểm tra gần nhất (đọc sync, để
   * `statusView` dùng). VM chưa kiểm tra lần nào -> 'unknown';
   * không phải VM -> undefined.
   */
  getGuestHealth(botId: string): GuestAgentHealth | undefined {
    const computer = this.computers.get(botId);
    if (!computer || computer.level !== 'vm') return undefined;
    return this.guestHealth.get(botId) ?? { status: 'unknown' };
  }

  /**
   * v0.90c: kiểm tra sức khoẻ guest của một máy VM (thật, có ping):
   * - máy không phải VM -> 'missing' (kèm hint) — không throw;
   * - VM chưa chạy / chưa có socket -> 'missing' + hint cài guest;
   * - ping trả pong -> 'ok' (+ version/uptime);
   * - guest CŨ (trước v0.90c) trả lỗi cho ping -> 'unknown' + hint
   *   cập nhật guest (không crash);
   * - socket đứt giữa chừng -> reconnect tối đa 3 lần rồi ping lại;
   *   vẫn lỗi -> 'unhealthy' + hint.
   * Kết quả được cache để `statusView` đọc. Không throw (trừ khi
   * không có máy cho botId — như các method khác).
   */
  async checkGuestHealth(botId: string): Promise<GuestAgentHealth> {
    const computer = this.requireComputer(botId);
    if (computer.level !== 'vm') {
      const health: GuestAgentHealth = {
        status: 'missing',
        hint: 'Chỉ máy mức VM mới có guest agent.',
      };
      this.guestHealth.set(botId, health);
      return health;
    }
    if (computer.state !== 'running') {
      const health: GuestAgentHealth = {
        status: 'missing',
        hint: 'VM chưa chạy — boot VM (start) trước khi kiểm tra guest agent.',
      };
      this.guestHealth.set(botId, health);
      return health;
    }
    const socketPath = this.guestAgentSocketPath(botId);
    if (!fs.existsSync(socketPath) && !this.guestAgents.get(botId)?.connected) {
      const health: GuestAgentHealth = { status: 'missing', hint: GUEST_AGENT_INSTALL_HINT };
      this.guestHealth.set(botId, health);
      return health;
    }
    let health: GuestAgentHealth;
    try {
      let client = this.guestAgents.get(botId);
      if (!client?.connected) {
        client = await this.connectGuestAgent(botId);
      }
      const ping = await client.ping();
      if (ping.status === 'ok') {
        health = {
          status: 'ok',
          ...(ping.version !== undefined ? { version: ping.version } : {}),
          ...(ping.uptimeSeconds !== undefined ? { uptimeSeconds: ping.uptimeSeconds } : {}),
        };
      } else {
        health = {
          status: 'unknown',
          hint: 'Guest agent trong VM là bản cũ (trước v0.90c) — không trả lời ping. Cập nhật file guest-agent.mjs trong VM để xem version/uptime.',
        };
      }
    } catch (err) {
      // Socket đứt giữa chừng: thử reconnect có giới hạn rồi ping lại.
      const reconnected = await this.reconnectGuestAgent(botId);
      if (reconnected) {
        try {
          const client = this.guestAgents.get(botId);
          const ping = await client?.ping();
          if (ping?.status === 'ok') {
            health = {
              status: 'ok',
              ...(ping.version !== undefined ? { version: ping.version } : {}),
              ...(ping.uptimeSeconds !== undefined ? { uptimeSeconds: ping.uptimeSeconds } : {}),
            };
            this.guestHealth.set(botId, health);
            return health;
          }
        } catch {
          // Rơi xuống nhánh unhealthy dưới.
        }
      }
      health = {
        status: 'unhealthy',
        hint: `Guest agent không trả lời được (${(err as Error).message}). ${GUEST_AGENT_INSTALL_HINT}`,
      };
    }
    this.guestHealth.set(botId, health);
    return health;
  }

  /**
   * v0.90c: kiểm tra guest có throttle — tối đa 1 lần / 15s / bot,
   * các lần gọi chồng nhau dùng chung 1 lần kiểm tra đang chạy.
   * Main gọi fire-and-forget trong handler `computers:list` (poll
   * 5s của UI) nên không bao giờ throw ra ngoài.
   */
  async refreshGuestHealth(botId: string): Promise<GuestAgentHealth> {
    const now = this.nowMs();
    const lastAt = this.lastGuestHealthCheckAt.get(botId) ?? 0;
    if (this.guestHealthInFlight.has(botId)) {
      return this.getGuestHealth(botId) ?? { status: 'unknown' };
    }
    if (now - lastAt < GUEST_HEALTH_CHECK_MIN_INTERVAL_MS && this.guestHealth.has(botId)) {
      return this.guestHealth.get(botId) as GuestAgentHealth;
    }
    this.guestHealthInFlight.add(botId);
    try {
      this.lastGuestHealthCheckAt.set(botId, now);
      return await this.checkGuestHealth(botId);
    } catch (err) {
      const health: GuestAgentHealth = {
        status: 'unhealthy',
        hint: `Không kiểm tra được guest agent: ${(err as Error).message}`,
      };
      this.guestHealth.set(botId, health);
      return health;
    } finally {
      this.guestHealthInFlight.delete(botId);
    }
  }

  /**
   * v0.90c: kết nối lại guest agent khi socket đứt — tối đa 3 lần
   * (xem `GuestAgentClient.reconnect`). Trả false khi không nối lại
   * được; không throw khi hết lần thử.
   */
  async reconnectGuestAgent(botId: string, maxAttempts = 3, connectTimeoutMs = 10_000): Promise<boolean> {
    const computer = this.computers.get(botId);
    if (!computer || computer.level !== 'vm') return false;
    const existing = this.guestAgents.get(botId);
    if (existing) {
      if (existing.connected) return true;
      const ok = await existing.reconnect({ maxAttempts, connectTimeoutMs });
      if (!ok) {
        this.disconnectGuestAgent(botId);
        return false;
      }
      return true;
    }
    try {
      await this.connectGuestAgent(botId);
      return true;
    } catch {
      return false;
    }
  }

  /** Ngắt client guest agent của một máy (best-effort, không throw). */
  private disconnectGuestAgent(botId: string): void {
    const client = this.guestAgents.get(botId);
    if (!client) return;
    try {
      client.close();
    } catch {
      // Ngắt best-effort.
    }
    this.guestAgents.delete(botId);
    // v0.90c: sức khoẻ đã đo thuộc về kết nối cũ — xoá để lần sau
    // kiểm tra lại thay vì hiện trạng thái cũ.
    this.guestHealth.delete(botId);
  }

  /** Khởi động máy-tính-bot (box/container: đảm bảo box + gate; VM: boot QEMU). */
  async startComputer(botId: string): Promise<BotComputer> {
    const computer = this.requireComputer(botId);
    if (computer.state === 'running') return computer;
    if (computer.level === 'vm') {
      return this.bootVm(computer);
    }
    // box / container: đảm bảo box tồn tại với đúng giới hạn đã cấp.
    try {
      this.boxManager.getBox(botId);
    } catch {
      this.boxManager.createBox(botId, {
        envAllowlist: ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'],
        limits: {
          cpuSeconds: Math.max(1, Math.ceil(computer.cpuCores * (DEFAULT_BOX_LIMITS.timeoutMs / 1000))),
          maxMemoryBytes: computer.ramBytes,
          maxProcesses: DEFAULT_COMPUTER_MAX_PROCESSES,
        },
      });
    }
    // v0.78 (cgroup): máy nạp lại từ file sau khi app restart thì chưa
    // có limiter — tạo lại ở đây (idempotent).
    this.ensureMemoryLimiter(computer);
    if (computer.egressPolicy && !this.gates.get(botId)?.running) {
      const gate = new EgressGate(`computer-${botId}`, { policy: computer.egressPolicy, port: 0 });
      try {
        await gate.start();
        this.gates.set(botId, gate);
      } catch (err) {
        this.warn(
          `computer ${computer.id}: không khởi động được egress gate (${(err as Error).message}) — máy vẫn chạy nhưng mạng ra ngoài không qua gate.`,
        );
      }
    }
    computer.state = 'running';
    computer.lastError = undefined;
    computer.lastPauseReason = undefined;
    computer.diskUsedBytes = this.measureDiskUsage(botId);
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  private bootVm(computer: BotComputer): BotComputer {
    if (!computer.imagePath) {
      computer.state = 'error';
      computer.lastError =
        'VM cần disk image để boot — chưa có imagePath. Đây là tính năng opt-in: cung cấp file image qcow2 (vd từ bản cài OS) rồi gọi lại start.';
      computer.updatedAt = this.now();
      this.save();
      return computer;
    }
    if (!fs.existsSync(computer.imagePath)) {
      computer.state = 'error';
      computer.lastError = `Disk image không tồn tại: ${computer.imagePath}`;
      computer.updatedAt = this.now();
      this.save();
      return computer;
    }
    const socketPath = this.guestAgentSocketPath(computer.botId);
    // Socket cũ từ lần boot trước còn sót sẽ làm QEMU không bind được
    // — xoá trước khi boot (best-effort).
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // Bỏ qua — QEMU sẽ báo lỗi rõ nếu vẫn bind không được.
    }
    const args = buildQemuBootArgs(computer.imagePath, computer, {
      enableKvm: this.profile?.virtualization.kvmAvailable ?? false,
      // v0.78 (M2): bản ghi cũ không có vmNetwork boot với '-nic none'
      // (fail-closed) — khác hành vi cũ vốn luôn dùng '-nic user'.
      network: computer.vmNetwork ?? 'none',
      // v0.78 (M3): chardev guest agent — QEMU lắng nghe trên socket
      // này, guest trong VM đọc qua virtio-serial port.
      guestAgentSocketPath: socketPath,
    });
    const child = this.spawnFn(args[0] as string, args.slice(1), { detached: true, stdio: 'ignore' });
    if (child.pid === undefined) {
      computer.state = 'error';
      computer.lastError = 'Không spawn được qemu-system-x86_64 (không lấy được pid).';
      computer.updatedAt = this.now();
      this.save();
      return computer;
    }
    computer.pid = child.pid;
    computer.state = 'running';
    computer.lastError = undefined;
    computer.lastPauseReason = undefined;
    computer.updatedAt = this.now();
    child.on('error', (err: Error) => {
      const current = this.computers.get(computer.botId);
      if (!current) return;
      current.state = 'error';
      current.lastError = `QEMU lỗi: ${err.message}`;
      current.pid = undefined;
      current.updatedAt = this.now();
      this.save();
    });
    child.on('close', () => {
      const current = this.computers.get(computer.botId);
      this.disconnectGuestAgent(computer.botId);
      if (!current || current.state !== 'running') return;
      current.state = 'stopped';
      current.pid = undefined;
      current.updatedAt = this.now();
      this.save();
    });
    try {
      child.unref();
    } catch {
      // Fake spawn trong test có thể không có unref thật — bỏ qua.
    }
    this.save();
    return computer;
  }

  /**
   * Tạm dừng: VM có pid thì SIGSTOP thật (đóng băng VM, giải phóng CPU
   * host); box/container thì chỉ đánh dấu paused — chặn lệnh mới, không
   * có tiến trình thường trú để đóng băng (ghi rõ trong docs).
   * v0.90c: `opts.reason` ghi vào `lastPauseReason` để UI hiện lý do
   * (vd auto-shed); tạm dừng thủ công (không reason) thì xoá lý do cũ.
   */
  pauseComputer(botId: string, opts: { reason?: string } = {}): BotComputer {
    const computer = this.requireComputer(botId);
    if (computer.state === 'paused') return computer;
    if (computer.level === 'vm' && computer.pid !== undefined) {
      try {
        process.kill(computer.pid, 'SIGSTOP');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          computer.pid = undefined;
          computer.state = 'stopped';
          computer.lastPauseReason = undefined;
          computer.updatedAt = this.now();
          this.save();
          return computer;
        }
        this.warn(`computer ${computer.id}: không SIGSTOP được VM (${(err as Error).message}).`);
      }
    }
    computer.state = 'paused';
    computer.lastPauseReason = opts.reason;
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  /** Mở lại sau tạm dừng (VM đã thoát hẳn thì phải start lại để boot). */
  resumeComputer(botId: string): BotComputer {
    const computer = this.requireComputer(botId);
    if (computer.state === 'running') return computer;
    if (computer.level === 'vm' && computer.pid === undefined) {
      throw new Error(
        `VM của bot "${botId}" đã dừng hẳn (không còn tiến trình QEMU) — dùng start để boot lại thay vì resume.`,
      );
    }
    if (computer.level === 'vm' && computer.pid !== undefined) {
      try {
        process.kill(computer.pid, 'SIGCONT');
      } catch (err) {
        this.warn(`computer ${computer.id}: không SIGCONT được VM (${(err as Error).message}).`);
      }
    }
    computer.state = 'running';
    computer.lastPauseReason = undefined;
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  /** Dừng máy-tính-bot (VM: SIGTERM process group QEMU; box/container: dừng gate). */
  async stopComputer(botId: string): Promise<BotComputer> {
    const computer = this.requireComputer(botId);
    if (computer.level === 'vm' && computer.pid !== undefined) {
      const pid = computer.pid;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Tiến trình đã thoát — bỏ qua.
        }
      }
      computer.pid = undefined;
    }
    const gate = this.gates.get(botId);
    if (gate) {
      try {
        await gate.stop();
      } catch {
        // Gate đã dừng — bỏ qua.
      }
      this.gates.delete(botId);
    }
    // v0.78 (M3): ngắt guest agent khi VM dừng.
    this.disconnectGuestAgent(botId);
    computer.state = 'stopped';
    computer.updatedAt = this.now();
    this.save();
    return computer;
  }

  /** Xoá máy-tính-bot (dừng + xoá box + xoá cgroup + xoá bản ghi). */
  async destroyComputer(botId: string): Promise<boolean> {
    const computer = this.computers.get(botId);
    if (!computer) return false;
    try {
      await this.stopComputer(botId);
    } catch {
      // Dừng lỗi thì vẫn xoá tiếp.
    }
    // v0.78 (cgroup): xoá cgroup giới hạn RAM của máy này.
    const limiter = this.limiters.get(botId);
    if (limiter) {
      limiter.destroy();
      this.limiters.delete(botId);
    }
    this.boxManager.destroyBox(botId);
    this.computers.delete(botId);
    // v0.90c: xoá cả entry hàng đợi + cache sức khoẻ guest của bot này.
    removeFromQueue(this.schedulerState, botId);
    this.guestHealth.delete(botId);
    this.save();
    return true;
  }

  /**
   * Chạy một lệnh trong máy-tính-bot (chỉ khi đang running).
   * - box/container: qua BotBoxManager (kèm env proxy của gate khi có).
   * - vm: qua guest agent trong VM (v0.78, M3) — kết nối lười (lazy)
   *   khi chưa có client; chưa cài guest thì throw lỗi rõ kèm hướng
   *   dẫn, KHÔNG chạy lệnh trên host rồi báo là "chạy trong VM".
   */
  async runInComputer(
    botId: string,
    command: string,
    args: string[] = [],
    opts: { timeoutMs?: number; envValues?: Record<string, string> } = {},
  ): Promise<BoxRunResult> {
    const computer = this.requireComputer(botId);
    if (computer.state !== 'running') {
      throw new Error(
        `Máy-tính-bot "${computer.id}" đang ở trạng thái "${computer.state}" — chạy lệnh cần trạng thái "running".`,
      );
    }
    if (computer.level === 'vm') {
      let client = this.guestAgents.get(botId);
      if (!client?.connected) {
        client = await this.connectGuestAgent(botId);
      }
      const startedAt = Date.now();
      const timeoutMs = opts.timeoutMs ?? GUEST_AGENT_DEFAULT_TIMEOUT_MS;
      try {
        const res = await client.exec(command, args, { timeoutMs });
        return {
          boxId: computer.id,
          botId,
          command,
          args,
          isolation: { kind: 'vm', isolated: true, detail: 'QEMU VM + guest agent' },
          exitCode: res.code,
          signal: null,
          stdout: res.stdout,
          stderr: res.stderr,
          timedOut: false,
          writeCapExceeded: false,
          workspaceBytes: computer.diskUsedBytes ?? 0,
          durationMs: Date.now() - startedAt,
          limitsApplied: {
            enforced: true,
            maxMemoryBytes: computer.ramBytes,
            reason: undefined,
          },
        };
      } catch (err) {
        if (/timeout/i.test((err as Error).message)) {
          return {
            boxId: computer.id,
            botId,
            command,
            args,
            isolation: { kind: 'vm', isolated: true, detail: 'QEMU VM + guest agent' },
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            timedOut: true,
            writeCapExceeded: false,
            workspaceBytes: computer.diskUsedBytes ?? 0,
            durationMs: Date.now() - startedAt,
            limitsApplied: { enforced: true, maxMemoryBytes: computer.ramBytes },
          };
        }
        throw new Error(`Chạy lệnh trong VM lỗi: ${(err as Error).message}`);
      }
    }
    const proxyEnv = this.computerProxyEnv(botId);
    return this.boxManager.runInBox(botId, command, args, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      envValues: { ...proxyEnv, ...(opts.envValues ?? {}) },
    });
  }

  /** Dung lượng đĩa workspace ĐO ĐƯỢC (bytes); null khi không đo được. */
  measureDiskUsage(botId: string): number | null {
    const computer = this.computers.get(botId);
    if (!computer) return null;
    try {
      return dirSizeBytes(computer.workspaceDir);
    } catch {
      return null;
    }
  }

  /** Trạng thái để UI vẽ — mức cách ly THẬT (hạ mức khi backend thiếu). */
  statusView(botId: string): ComputerStatusView | undefined {
    const computer = this.computers.get(botId);
    if (!computer) return undefined;
    let effectiveLevel: ComputerLevel = computer.level;
    let levelWarning: string | undefined;
    if (computer.level === 'container') {
      try {
        const box = this.boxManager.getBox(botId);
        if (box.isolation === 'none') {
          effectiveLevel = 'box';
          levelWarning =
            'Mức container yêu cầu bwrap/unshare nhưng máy không có — máy-tính-bot đang chạy dạng box thường (thư mục riêng, không namespace).';
        }
      } catch {
        // Chưa có box — chưa chạy gì nên chưa có mức thật.
      }
    }
    if (computer.level === 'vm' && computer.state === 'running' && computer.pid === undefined) {
      effectiveLevel = 'box';
      levelWarning = 'VM chưa boot được (không có tiến trình QEMU) — máy-tính-bot chưa thật sự chạy dạng VM.';
    }
    // v0.78 (cgroup): RAM vật lý enforce bằng gì + đang dùng bao nhiêu.
    const limiter = this.limiters.get(botId);
    const memoryEnforcement: 'cgroup-v2' | 'prlimit-only' = limiter ? 'cgroup-v2' : 'prlimit-only';
    // v0.78 (M2): VM dùng NAT thì egress policy KHÔNG enforce được.
    const vmNetworkWarning =
      computer.level === 'vm' && (computer.vmNetwork ?? 'none') === 'nat'
        ? 'VM dùng NAT — egress policy KHÔNG enforce được trong VM (mạng ra ngoài đi thẳng qua QEMU user-mode NAT).'
        : undefined;
    // v0.78 (M3): guest agent đang kết nối hay chưa (chỉ mức VM).
    const guestAgentConnected =
      computer.level === 'vm' ? (this.guestAgents.get(botId)?.connected ?? false) : undefined;
    // v0.90c: sức khoẻ guest đã kiểm tra gần nhất (chỉ mức VM).
    const guestAgentHealth = this.getGuestHealth(botId);
    return {
      computer,
      effectiveLevel,
      levelWarning,
      vmNetworkWarning,
      guestAgentConnected,
      guestAgentHealth,
      memoryEnforcement,
      ...(memoryEnforcement === 'prlimit-only'
        ? {
            memoryEnforcementReason:
              computer.level === 'vm'
                ? 'VM không dùng cgroup — RAM của VM đã bị chặn bởi QEMU -m.'
                : (this.memoryProbe.reason ?? 'Không tạo được cgroup cho máy này (xem log).'),
          }
        : {}),
      memoryUsageBytes: limiter?.readUsage()?.currentBytes ?? null,
    };
  }

  /** Kết quả probe enforce RAM bằng cgroup (để main/UI hiện lý do khi không khả dụng). */
  getMemoryProbe(): CgroupMemoryProbe {
    return { ...this.memoryProbe };
  }

  /**
   * v0.78 (cgroup): đảm bảo có limiter RAM vật lý cho máy-tính-bot.
   * VM không dùng cgroup (RAM của VM đã bị chặn bởi QEMU `-m`).
   * Trả limiter hoặc null (probe không khả dụng / tạo lỗi — giữ
   * prlimit làm best-effort, ghi warn rõ).
   */
  private ensureMemoryLimiter(computer: BotComputer): CgroupMemoryLimiter | null {
    if (computer.level === 'vm') return null;
    const existing = this.limiters.get(computer.botId);
    if (existing) return existing;
    if (!this.memoryProbe.available) return null;
    try {
      const limiter = new CgroupMemoryLimiter({
        cgroupRoot: this.cgroupRoot,
        name: `${CGROUP_NAME_PREFIX}${computer.botId}`,
        logger: { warn: this.warn },
      });
      limiter.create(computer.ramBytes);
      this.limiters.set(computer.botId, limiter);
      return limiter;
    } catch (err) {
      this.warn(
        `computer ${computer.id}: không tạo được cgroup giới hạn RAM (${(err as Error).message}) — giữ prlimit.`,
      );
      return null;
    }
  }

  /**
   * Giảm tải khi máy host bận: tạm dừng các máy đang chạy theo thứ tự
   * ưu tiên thấp trước (suggestShedOrder). Trả về danh sách botId đã
   * tạm dừng. Caller nên probe lại máy sau khi giảm tải.
   * v0.90c: ghi lý do tạm dừng (giảm tải thủ công) để UI hiện rõ.
   */
  async shedIfBusy(profile: MachineProfile): Promise<string[]> {
    if (!isHostBusy(profile).busy) return [];
    const plan: ComputerPlan = {
      profile,
      allocations: this.listComputers()
        .filter((c) => c.state === 'running')
        .map((c) => ({
          botId: c.botId,
          level: c.level,
          cpuCores: c.cpuCores,
          ramBytes: c.ramBytes,
          diskBytes: c.diskBytes,
          backend: c.backend,
          backendDetail: c.backendDetail,
          priority: c.priority,
        })),
      rejected: [],
      hostHeadroom: { cpuCores: 0, ramBytes: 0, diskBytes: 0 },
      busy: true,
      warnings: [],
      plannedAt: this.now(),
    };
    const order = suggestShedOrder(plan);
    const paused: string[] = [];
    for (const botId of order) {
      try {
        this.pauseComputer(botId, { reason: 'Giảm tải thủ công: máy host đang bận.' });
        paused.push(botId);
      } catch {
        // Một máy pause lỗi thì vẫn tiếp tục các máy còn lại.
      }
    }
    return paused;
  }

  // --- Scheduler v0.90c (hàng đợi + auto-shed opt-in) ----------------------

  /** State scheduler hiện tại (bản sao — sửa bản sao không đổi runtime). */
  getSchedulerState(): ComputerSchedulerState {
    return {
      autoShed: this.schedulerState.autoShed,
      queue: this.schedulerState.queue.map((e) => ({
        ...e,
        request: { ...e.request },
      })),
    };
  }

  /** Hàng đợi đang chờ (bản sao). */
  getQueue(): ComputerQueueEntry[] {
    return this.getSchedulerState().queue;
  }

  /** Cờ auto-shed hiện tại (mặc định false — tắt). */
  getAutoShed(): boolean {
    return this.schedulerState.autoShed;
  }

  /**
   * Thêm một yêu cầu vào hàng đợi (bot chưa có máy; đã có máy thì
   * throw). Entry mới có priority từ request (mặc định 50).
   */
  enqueueComputer(request: BotComputerRequest, reason?: string): ComputerQueueEntry {
    if (this.computers.has(request.botId)) {
      throw new Error(`Bot "${request.botId}" đã có máy-tính-bot — không cần xếp hàng đợi.`);
    }
    const entry = enqueueRequest(
      this.schedulerState,
      request,
      new Date(this.nowMs()).toISOString(),
      reason,
    );
    this.save();
    return entry;
  }

  /**
   * Đặt priority cho một bot: máy đã có thì đổi priority của máy;
   * bot đang chờ thì đổi priority entry trong hàng đợi; bot chưa có
   * gì thì tạo entry chờ mới với request mặc định (level auto).
   * Trả về state scheduler sau khi đổi.
   */
  setComputerPriority(botId: string, priority: number): ComputerSchedulerState {
    const clamped = clampPriority(priority);
    const computer = this.computers.get(botId);
    if (computer) {
      computer.priority = clamped;
      computer.updatedAt = this.now();
      this.save();
      return this.getSchedulerState();
    }
    if (!setQueuePriority(this.schedulerState, botId, clamped)) {
      enqueueRequest(
        this.schedulerState,
        { botId, priority: clamped },
        new Date(this.nowMs()).toISOString(),
      );
    }
    this.save();
    return this.getSchedulerState();
  }

  /** Bật/tắt tự giảm tải (opt-in; mặc định tắt). Trả về state mới. */
  setAutoShed(enabled: boolean): ComputerSchedulerState {
    this.schedulerState.autoShed = enabled === true;
    this.save();
    return this.getSchedulerState();
  }

  /**
   * Tick scheduler — main gọi trong handler `computers:list` (UI poll
   * 5s) với profile/backends đã probe (cache 30s, không probe mới):
   * 1. Host bận -> KHÔNG promote (chờ rảnh), nhưng nếu auto-shed
   *    đang BẬT thì tạm dừng 1 máy đang chạy có priority thấp nhất +
   *    ghi audit (qua `onAutoShed`; callback lỗi thì chỉ warn).
   * 2. Host rảnh + hàng đợi có entry -> thử promote theo thứ tự
   *    hàng đợi; entry được cấp thì tạo bản ghi máy (trạng thái
   *    stopped — user bấm start khi sẵn sàng, không tự chạy).
   * Không throw khi promote/shed lỗi từng máy (ghi warn, tiếp tục).
   */
  tickScheduler(profile: MachineProfile, backends: ComputerBackend[]): SchedulerTickResult {
    const result: SchedulerTickResult = { promoted: [], autoShedPaused: [] };
    const busy = isHostBusy(profile);
    if (busy.busy) {
      if (this.schedulerState.autoShed) {
        const running = this.listComputers()
          .filter((c) => c.state === 'running')
          .map((c) => ({ botId: c.botId, priority: c.priority, ramBytes: c.ramBytes }));
        const [victim] = selectAutoShedCandidates(running, 1);
        if (victim) {
          const reason = `Tự giảm tải: máy host đang bận (${busy.reason ?? 'không rõ lý do'}) — tạm dừng máy ưu tiên thấp nhất.`;
          try {
            this.pauseComputer(victim, { reason });
            result.autoShedPaused.push(victim);
          } catch (err) {
            this.warn(`computer ${victim}: auto-shed lỗi (${(err as Error).message}).`);
          }
          if (result.autoShedPaused.length > 0) {
            try {
              this.onAutoShed?.({ botId: victim, reason });
            } catch (err) {
              this.warn(`computer ${victim}: không ghi được audit auto-shed (${(err as Error).message}).`);
            }
          }
        }
      }
      return result;
    }
    if (this.schedulerState.queue.length === 0) return result;
    // Trừ tài nguyên đã cấp cho máy ĐÃ TỒN TẠI (kể cả stopped — bản
    // ghi giữ allocation) trước khi thử promote, nếu không tick sẽ
    // cấp vượt ngân sách vì chỉ nhìn hàng đợi.
    const alreadyAllocated: BotComputerRequest[] = this.listComputers().map((c) => ({
      botId: c.botId,
      level: c.level,
      cpuCores: c.cpuCores,
      ramBytes: c.ramBytes,
      diskBytes: c.diskBytes,
      priority: c.priority,
    }));
    const { promoted, remaining } = tryPromoteQueue(
      profile,
      this.schedulerState.queue,
      backends,
      {},
      alreadyAllocated,
    );
    this.schedulerState.queue = remaining;
    for (const allocation of promoted) {
      try {
        if (!this.computers.has(allocation.botId)) {
          this.createComputer(allocation);
        }
        result.promoted.push(allocation.botId);
      } catch (err) {
        this.warn(`computer ${allocation.botId}: promote từ hàng đợi lỗi (${(err as Error).message}).`);
      }
    }
    this.save();
    return result;
  }

  private requireComputer(botId: string): BotComputer {
    const computer = this.computers.get(botId);
    if (!computer) throw new Error(`Không có máy-tính-bot cho bot "${botId}".`);
    return computer;
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    const { computers, scheduler } = readComputersFile(this.file);
    for (const c of computers) {
      // Máy đang chạy lúc app tắt thì lần mở sau về 'stopped' — không
      // bịa là đang chạy khi thực tế tiến trình đã chết theo app.
      if (c.state === 'running' || c.state === 'paused') c.state = 'stopped';
      c.pid = undefined;
      this.computers.set(c.botId, c);
    }
    // v0.90c: hàng đợi + cờ auto-shed đọc lại sau restart (không mất).
    // Entry nào trỏ tới bot đã có máy thì bỏ (máy đã được cấp rồi).
    this.schedulerState = scheduler;
    this.schedulerState.queue = this.schedulerState.queue.filter(
      (e) => !this.computers.has(e.botId),
    );
  }

  private save(): void {
    const data: ComputersFile = {
      version: 2,
      computers: this.listComputers(),
      queue: this.schedulerState.queue,
      autoShed: this.schedulerState.autoShed,
    };
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
