/**
 * Máy tính riêng cho từng bot — types (sóng B, đội platform).
 *
 * Ý tưởng (theo hướng Huy giao 2026-11-10): giống Grok Bot, mỗi bot có
 * một máy tính riêng. Máy của người dùng được dò cấu hình rồi chia
 * thành nhiều máy-tính-bot, không ảnh hưởng việc người dùng dùng máy.
 *
 * Ba khái niệm tách riêng:
 * - `MachineProfile`: cấu hình máy thật đã dò được (probe.ts).
 * - `ComputerPlan`: kế hoạch chia tài nguyên (planner.ts) — thuần,
 *   không I/O, không chạy gì cả.
 * - `BotComputer`: một máy-tính-bot đang được runtime quản lý
 *   (runtime.ts) — có mức cách ly, backend, trạng thái, tài nguyên đã cấp.
 *
 * NGUYÊN TẮC TRUNG THỰC (ghi rõ để không ai vô tình phá):
 * - Không bao giờ báo mức cách ly cao hơn thực tế: box thường thì ghi
 *   'box', có namespace thật thì 'container', VM thật đang chạy thì
 *   'vm'. Mức nào chưa boot được thì trạng thái là 'stopped' + lý do.
 * - Số liệu "đang dùng" chỉ ghi khi đo được thật (vd dung lượng đĩa
 *   workspace); số đã cấp ghi riêng là "đã cấp". Không bịa số live.
 * - Planner luôn chừa headroom cho máy host (xem planner.ts) — không
 *   bao giờ cấp hết RAM/CPU trống cho bot.
 */

/** Hệ điều hành đã dò được. */
export type ProbeOs = 'linux' | 'darwin' | 'win32';

/** CPU: model, số core/luồng, flag ảo hoá, tải hiện tại. */
export interface CpuInfo {
  /** Model CPU, vd 'Intel(R) Core(TM) i7-12700H' (os.cpus()[0].model). */
  model: string;
  /** Số core logic (luồng) — os.cpus().length. */
  logicalCores: number;
  /** Số core vật lý khi đo được; null khi không đo được. */
  physicalCores: number | null;
  /** Tốc độ 1 core (MHz) khi đo được; null khi không rõ. */
  speedMhz: number | null;
  /** Flag ảo hoá đã thấy, vd ['vmx'] / ['svm'] / ['apple-silicon']. */
  virtualizationFlags: string[];
  /** Load trung bình 1 phút (unix); null trên Windows (os.loadavg trả 0). */
  loadAvg1m: number | null;
  /** loadAvg1m / logicalCores; null khi không đo được tải. */
  loadPerCore: number | null;
}

/** RAM: tổng + trống (os.totalmem/os.freemem). */
export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  /** freeBytes / totalBytes (0..1). */
  freeRatio: number;
}

/** Một ổ đĩa / điểm mount. */
export interface DiskInfo {
  /** Điểm mount ('/') hoặc tên ổ ('C:'). */
  mount: string;
  totalBytes: number;
  freeBytes: number;
  /** freeBytes / totalBytes (0..1). */
  freeRatio: number;
}

/** Hỗ trợ ảo hoá đã dò được trên máy. */
export interface VirtualizationInfo {
  /** CPU hỗ trợ ảo hoá (flag vmx/svm, hoặc Apple Silicon). */
  supported: boolean;
  /** /dev/kvm tồn tại (Linux). */
  kvmAvailable: boolean;
  /** Hyper-V đang bật (Windows). */
  hyperVAvailable: boolean;
  /** Virtualization.framework (macOS Apple Silicon). */
  appleVirtualization: boolean;
  /** WSL2 có sẵn (Windows). */
  wslAvailable: boolean;
  /** Mô tả ngắn cho UI/log (vd 'KVM (/dev/kvm) + QEMU'). */
  detail: string;
}

/** Một GPU đã dò được (best-effort — vắng mặt không phải lỗi). */
export interface GpuInfo {
  model: string;
  vendor?: string;
}

/** Mạng: các interface + địa chỉ (os.networkInterfaces). */
export interface NetworkInfo {
  interfaces: Array<{ name: string; addresses: string[]; internal: boolean }>;
}

/** Toàn bộ cấu hình máy đã dò được. */
export interface MachineProfile {
  os: ProbeOs;
  /** Phiên bản OS (vd 'Ubuntu 24.04.1 LTS', 'Microsoft Windows 11 Pro'). */
  osVersion: string;
  arch: string;
  hostname: string;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  virtualization: VirtualizationInfo;
  gpus: GpuInfo[];
  network: NetworkInfo;
  /** Thời điểm probe (ISO string). */
  probedAt: string;
  /** Những gì probe không đo được (vd 'không đọc được GPU') — để UI hiện rõ. */
  warnings: string[];
}

/** Mức cách ly của một máy-tính-bot (thang cách ly theo sức máy). */
export type ComputerLevel = 'box' | 'container' | 'vm';

/** Backend thực thi của một mức cách ly. */
export type ComputerBackendKind =
  | 'box' // thư mục riêng, không namespace (mức 'box')
  | 'bwrap' // bubblewrap (mức 'container', Linux)
  | 'unshare' // namespace unshare (mức 'container', Linux)
  | 'systemd-nspawn' // systemd-nspawn (mức 'container', Linux — ghi nhận có mặt)
  | 'podman' // podman (mức 'container' — ghi nhận có mặt)
  | 'qemu' // QEMU/KVM (mức 'vm')
  | 'wsl' // WSL2 (mức 'vm', Windows)
  | 'hyperv' // Hyper-V (mức 'vm', Windows)
  | 'macvm' // Virtualization.framework (mức 'vm', macOS)
  | 'none';

/** Một backend đã dò được (có mặt hay không + lý do). */
export interface ComputerBackend {
  kind: ComputerBackendKind;
  /** Mức cách ly mà backend này phục vụ. */
  level: ComputerLevel;
  available: boolean;
  /** Mô tả ngắn (vd 'bwrap 0.10.0' / 'không có qemu-system-x86_64 trên PATH'). */
  detail: string;
  /** Binary đã tìm thấy (khi available). */
  command?: string;
}

/** Yêu cầu một máy-tính-bot (đầu vào cho planner). */
export interface BotComputerRequest {
  botId: string;
  /** Mức muốn dùng; 'auto' (mặc định) = planner chọn mức mạnh nhất khả thi. */
  level?: ComputerLevel | 'auto';
  /** Số core muốn cấp (mặc định theo mức). */
  cpuCores?: number;
  /** RAM muốn cấp, bytes (mặc định theo mức). */
  ramBytes?: number;
  /** Đĩa muốn cấp, bytes (mặc định theo mức). */
  diskBytes?: number;
  /** Độ ưu tiên 0..100 (mặc định 50): cao hơn = quan trọng hơn khi cần giảm tải. */
  priority?: number;
}

/** Chính sách chia tài nguyên của planner (mọi field đều có mặc định an toàn). */
export interface PlannerPolicy {
  /** Số core chừa cho host (mặc định 2; planner còn chừa thêm 25% tổng core, lấy lớn hơn). */
  reserveCpuCores?: number;
  /** Chừa tối thiểu 25% tổng RAM cho host (mặc định 0.25). */
  reserveRamRatio?: number;
  /** Chừa tối thiểu 2 GB RAM cho host (mặc định 2*1024^3). */
  reserveRamBytes?: number;
  /** Chừa tối thiểu 5 GB trống trên ổ hệ thống (mặc định 5*1024^3). */
  reserveDiskBytes?: number;
  /** Số máy-tính-bot tối đa cùng lúc (mặc định 8). */
  maxComputers?: number;
  /** Ngưỡng coi là máy host đang bận: load/core (mặc định 0.8). */
  busyLoadPerCore?: number;
  /** Ngưỡng coi là máy host đang bận: RAM trống (mặc định 0.15). */
  busyMinFreeRamRatio?: number;
}

/** Một máy-tính-bot đã được cấp trong kế hoạch. */
export interface ComputerAllocation {
  botId: string;
  level: ComputerLevel;
  /** Mức yêu cầu ban đầu khi bị hạ mức (vd 'vm' -> 'container'). */
  downgradedFrom?: ComputerLevel;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Backend sẽ dùng (vd 'bwrap', 'qemu', 'box'). */
  backend: ComputerBackendKind;
  backendDetail: string;
  priority: number;
}

/** Kết quả lập kế hoạch chia tài nguyên. */
export interface ComputerPlan {
  /** Snapshot máy đã dùng để lập kế hoạch (để UI đối chiếu). */
  profile: MachineProfile;
  allocations: ComputerAllocation[];
  rejected: Array<{ botId: string; reason: string; reasonDetail?: string }>;
  /** Headroom còn lại cho host SAU khi cấp (core/RAM/đĩa). */
  hostHeadroom: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Máy host đang bận lúc lập kế hoạch (xem isHostBusy). */
  busy: boolean;
  busyReason?: string;
  warnings: string[];
  plannedAt: string;
}

/** Trạng thái của một máy-tính-bot đang được runtime quản lý. */
export type ComputerState = 'running' | 'paused' | 'stopped' | 'error';

/** Một máy-tính-bot (bản ghi bền vững trong computers.json). */
export interface BotComputer {
  /** Id ổn định: `computer-<botId>`. */
  id: string;
  botId: string;
  level: ComputerLevel;
  backend: ComputerBackendKind;
  backendDetail: string;
  /** Tài nguyên ĐÃ CẤP (không phải số đo live — xem diskUsedBytes). */
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Độ ưu tiên 0..100 (dùng khi cần giảm tải — thấp dừng trước). */
  priority: number;
  state: ComputerState;
  /** Thư mục làm việc riêng của máy-tính-bot. */
  workspaceDir: string;
  /** Policy egress riêng của máy-tính-bot (nếu có — gate khởi động khi start). */
  egressPolicy?: import('../egress/types').EgressPolicy;
  /** Đường dẫn tới disk image của VM (chỉ mức 'vm' khi đã chuẩn bị image). */
  imagePath?: string;
  /**
   * Mạng của VM (v0.78, M2): 'none' = không NIC (mặc định, fail-closed
   * — VM hoàn toàn không ra mạng), 'nat' = QEMU user-mode NAT.
   * Bản ghi cũ không có field này được coi như 'none' khi boot.
   */
  vmNetwork?: 'none' | 'nat';
  /** PID của tiến trình giám sát (container/VM), khi có. */
  pid?: number;
  /** Dung lượng đĩa workspace ĐO ĐƯỢC (bytes) — null khi chưa đo. */
  diskUsedBytes?: number | null;
  /** Lỗi cuối cùng (khi state = 'error'). */
  lastError?: string;
  /**
   * v0.90c (đội G gói C): lý do lần tạm dừng gần nhất — vd tự giảm
   * tải ("auto-shed: host busy ...") hoặc giảm tải thủ công. Xoá khi
   * resume/start. UI hiện kèm trạng thái paused.
   */
  lastPauseReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * v0.90c: một yêu cầu đang chờ trong hàng đợi scheduler (bền vững
 * trong computers.json — xem `scheduler.ts`).
 */
export interface ComputerQueueEntry {
  botId: string;
  /** Yêu cầu gốc (level/cpu/ram/disk/priority) để thử lại khi rảnh. */
  request: BotComputerRequest;
  /** Độ ưu tiên 0..100 (cao thử trước; FIFO trong cùng priority). */
  priority: number;
  /** Thời điểm vào hàng đợi (ISO) — dùng để FIFO + hiển thị. */
  enqueuedAt: string;
  /** Lý do vào hàng đợi (vd lý do planner từ chối lúc tạo). */
  reason?: string;
}

/** v0.90c: state scheduler bền vững (queue + cờ auto-shed opt-in). */
export interface ComputerSchedulerState {
  queue: ComputerQueueEntry[];
  /** Tự giảm tải khi host bận — OPT-IN, mặc định false (tắt). */
  autoShed: boolean;
}

/** v0.90c: kết quả một tick scheduler (để main/UI/log dùng). */
export interface SchedulerTickResult {
  /** Bot vừa được cấp máy từ hàng đợi (đã tạo bản ghi, trạng thái stopped). */
  promoted: string[];
  /** Bot vừa bị tạm dừng do auto-shed (rỗng khi auto-shed tắt / host không bận). */
  autoShedPaused: string[];
}

/** v0.90c: trạng thái sức khoẻ guest agent trong VM. */
export type GuestAgentHealthStatus = 'ok' | 'missing' | 'unhealthy' | 'unknown';

/** v0.90c: sức khoẻ guest agent (cache trong runtime, xem `runtime.ts`). */
export interface GuestAgentHealth {
  status: GuestAgentHealthStatus;
  /** Version guest trả qua ping/info (vd '0.90c'); vắng khi guest cũ/không trả. */
  version?: string;
  /** Uptime của guest (giây) — chỉ khi ping/info trả về. */
  uptimeSeconds?: number;
  /** Gợi ý cho user khi không ok (vd hướng dẫn cài guest). */
  hint?: string;
}

/** Trạng thái + tài nguyên của một máy-tính-bot để UI vẽ (không chứa secret). */
export interface ComputerStatusView {
  computer: BotComputer;
  /** Mức cách ly THẬT đang áp dụng (bằng level khi đang chạy, 'box' khi fallback). */
  effectiveLevel: ComputerLevel;
  /** Cảnh báo khi mức thật thấp hơn mức đã cấp (vd VM chưa boot nên chạy tạm bằng box). */
  levelWarning?: string;
  /**
   * v0.78 (cgroup): RAM vật lý enforce bằng gì — 'cgroup-v2'
   * (`memory.max` thật, xem compute/cgroup.ts) hay 'prlimit-only'
   * (chỉ giới hạn địa chỉ ảo bằng prlimit, như trước). VM không dùng
   * cgroup (RAM của VM đã bị chặn bởi QEMU `-m`) nên luôn báo
   * 'prlimit-only' với lý do riêng — xem `memoryEnforcementReason`.
   */
  memoryEnforcement: 'cgroup-v2' | 'prlimit-only';
  /** Lý do khi chỉ dùng prlimit (vd cgroup không khả dụng trên máy này). */
  memoryEnforcementReason?: string;
  /** RAM vật lý máy-tính-bot đang dùng (bytes, đọc từ cgroup) — null khi không đo được. */
  memoryUsageBytes?: number | null;
  /**
   * v0.78 (M2): cảnh báo khi VM dùng NAT — egress policy KHÔNG enforce
   * được trong VM (mạng ra ngoài đi thẳng qua QEMU user-mode NAT).
   */
  vmNetworkWarning?: string;
  /**
   * v0.78 (M3): true khi guest agent trong VM đang kết nối (chỉ có ý
   * nghĩa với máy mức VM; undefined/false khi chưa kết nối).
   */
  guestAgentConnected?: boolean;
  /**
   * v0.90c (đội G gói C): sức khoẻ guest agent — ping/info định kỳ
   * (chỉ mức VM; undefined khi không phải VM). 'unknown' = chưa kiểm
   * tra xong hoặc guest cũ không trả lời ping (không crash).
   */
  guestAgentHealth?: GuestAgentHealth;
}
