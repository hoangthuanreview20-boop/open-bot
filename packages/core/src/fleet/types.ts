/**
 * Tầng fleet đa người dùng — types (đội D).
 *
 * Core open-bot là single-user; đa người dùng thật nằm ở TẦNG FLEET
 * RIÊNG này, không mở rộng core thành multi-user (kết luận từ nghiên
 * cứu OpenMausBot — xem docs/team-b-platform.md: mỗi workspace 1 OS
 * user + 1 service + 1 port loopback + thư mục dữ liệu riêng, audit
 * fleet.jsonl + decision log + usage ledger).
 *
 * NGUYÊN TẮC TRUNG THỰC (ghi rõ để không ai vô tình phá):
 * - Cô lập cấp OS user chỉ thật khi service chạy đặc quyền (root) VÀ
 *   OS user đã tồn tại VÀ child được spawn với uid đó. Còn không thì
 *   mức cô lập là 'directory' (thư mục + port + vault namespace
 *   riêng) và phải báo rõ như vậy — không bao giờ ghi 'os-user' khi
 *   thực tế chỉ là directory.
 * - Service chỉ bind 127.0.0.1, không bao giờ expose port ra ngoài
 *   (nguyên tắc loopback-trust). Health check cần token tạo lúc start,
 *   chỉ giữ trong bộ nhớ, không ghi đĩa.
 * - Audit/decision là log LOCAL cho máy tin cậy: chuỗi hash SHA-256
 *   phát hiện hỏng/sửa lén không tính lại hash, KHÔNG chống được
 *   người có quyền sửa file tính lại chuỗi (giới hạn đã ghi ở team/audit).
 * - Số liệu "đang dùng" chỉ ghi khi đo được thật; số đã cấp ghi riêng.
 */
import type { PlannerPolicy } from '../compute/types';

/** Vai trò trong một workspace fleet (theo mô hình fleet OpenMausBot). */
export type FleetRole = 'admin' | 'member' | 'chat-only';

export const FLEET_ROLES: readonly FleetRole[] = ['admin', 'member', 'chat-only'];

/** Thành viên của một workspace fleet. */
export interface FleetMember {
  /** Id người dùng trong workspace (vd email hoặc tên đăng nhập nội bộ). */
  userId: string;
  role: FleetRole;
  addedBy: string;
  addedAt: string;
}

/** Trạng thái đăng ký của workspace (không phải trạng thái service). */
export type FleetWorkspaceStatus = 'active' | 'suspended';

/** Trạng thái service của workspace (do FleetServiceManager quản lý). */
export type FleetServiceState = 'stopped' | 'starting' | 'running' | 'error';

/** Mức cô lập THẬT của workspace (xem nguyên tắc ở đầu file). */
export type FleetIsolationLevel = 'directory' | 'os-user';

/** Một workspace fleet: 1 OS user + 1 service + 1 port loopback + 1 thư mục riêng. */
export interface FleetWorkspace {
  /** Id ổn định: `fw-<uuid>`. */
  id: string;
  /** Tên hiển thị (duy nhất trong fleet). */
  name: string;
  /** OS user được chỉ định cho workspace (vd 'alice'). */
  osUser: string;
  /** Tên service (duy nhất trong fleet, vd 'open-bot-alice'). */
  serviceName: string;
  /** Port loopback riêng của service (1024–65535, duy nhất trong fleet). */
  port: number;
  /** Thư mục dữ liệu riêng (đường dẫn tuyệt đối, duy nhất trong fleet). */
  rootDir: string;
  /** CPU đã cấp (core, có thể là 0.5). */
  cpuCores: number;
  /** RAM đã cấp (bytes). */
  ramBytes: number;
  /** Đĩa đã cấp (bytes). */
  diskBytes: number;
  members: FleetMember[];
  status: FleetWorkspaceStatus;
  /** Trạng thái service (persist để UI/CLI thấy sau khi app khởi động lại). */
  serviceState: FleetServiceState;
  /** PID của service khi đang chạy (có thể đã cũ — kiểm tra liveness khi đọc). */
  pid?: number;
  /** Mức cô lập thật đang áp dụng (xem nguyên tắc ở đầu file). */
  isolationLevel: FleetIsolationLevel;
  /** Lý do khi isolationLevel là 'directory' (vd 'chưa chạy đặc quyền'). */
  isolationReason?: string;
  /** Lỗi cuối cùng của service (khi serviceState = 'error'). */
  lastError?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Đầu vào tạo workspace (port/cpu/ram/disk có mặc định an toàn). */
export interface CreateFleetWorkspaceInput {
  /** Id ổn định — mặc định tạo mới (`fw-<uuid>`); FleetManager đặt trước để tính rootDir. */
  id?: string;
  name: string;
  osUser: string;
  /** Tên service; mặc định `open-bot-<osUser>`. */
  serviceName?: string;
  /** Port loopback; mặc định cấp tự động từ dải 18000–18999. */
  port?: number;
  /** Thư mục dữ liệu; mặc định `<fleetRoot>/workspaces/<id>`. */
  rootDir?: string;
  /** CPU cấp (core); mặc định 1. */
  cpuCores?: number;
  /** RAM cấp (bytes); mặc định 512 MB. */
  ramBytes?: number;
  /** Đĩa cấp (bytes); mặc định 10 GB. */
  diskBytes?: number;
  createdBy?: string;
}

/** Kết quả kiểm tra sức chứa máy khi tạo workspace mới. */
export interface FleetCapacityCheck {
  ok: boolean;
  /** Lý do ngắn khi ok = false (vd 'not-enough-ram'). */
  reason?: string;
  reasonDetail?: string;
  /** Headroom còn lại cho host SAU khi cấp (core/RAM/đĩa). */
  headroom: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Tổng đã cấp cho các workspace active (không tính workspace đang xét). */
  allocated: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Yêu cầu của workspace mới. */
  requested: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Máy host đang bận lúc kiểm tra. */
  busy: boolean;
  busyReason?: string;
}

/** Chính sách sức chứa fleet (tái dùng PlannerPolicy của compute). */
export type FleetCapacityPolicy = PlannerPolicy;

/** Một mẫu đo mức dùng của workspace (ghi vào usage.jsonl). */
export interface FleetUsageSample {
  workspaceId: string;
  /** Epoch milliseconds khi đo. */
  at: number;
  /** Tổng CPU time của service (giây, từ /proc — null khi không đo được). */
  cpuSeconds: number | null;
  /** RAM vật lý service đang dùng (bytes, từ /proc — null khi không đo được). */
  rssBytes: number | null;
  /** Dung lượng đĩa thư mục workspace đã dùng (bytes — null khi không đo được). */
  diskBytes: number | null;
  /** PID service lúc đo (null khi service không chạy). */
  servicePid: number | null;
}

/** Tóm tắt mức dùng của một workspace trong một cửa sổ thời gian. */
export interface FleetUsageSummary {
  workspaceId: string;
  samples: number;
  windowStart: number;
  windowEnd: number;
  /** Tổng CPU time lớn nhất đo được trong cửa sổ (giây) — null khi chưa đo được. */
  cpuSecondsMax: number | null;
  /** RSS mới nhất (bytes) — null khi chưa đo được. */
  rssBytesLatest: number | null;
  /** Đĩa đã dùng mới nhất (bytes) — null khi chưa đo được. */
  diskBytesLatest: number | null;
}

/** Một quyết định trong decision log (ai cho phép/cấm cái gì, khi nào). */
export interface FleetDecision {
  id: string;
  seq: number;
  at: number;
  actor: string;
  /** Hành động được quyết định, vd 'workspace.create', 'service.start'. */
  action: string;
  target: string;
  decision: 'allow' | 'deny';
  reason?: string;
  detail?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface NewFleetDecisionInput {
  actor: string;
  action: string;
  target: string;
  decision: 'allow' | 'deny';
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Trạng thái đầy đủ của một workspace để UI/CLI vẽ (không chứa secret). */
export interface FleetStatusView {
  workspace: FleetWorkspace;
  service: {
    state: FleetServiceState;
    /** PID còn sống thật (đã kiểm tra liveness) — undefined khi không chạy. */
    pid?: number;
    /** Thời gian service đã chạy (ms) — null khi không chạy/không đo được. */
    uptimeMs: number | null;
    /** Lần health check thành công gần nhất (epoch ms) — null khi chưa có. */
    lastHealthAt: number | null;
    lastError?: string;
  };
  usage: FleetUsageSummary | null;
}
