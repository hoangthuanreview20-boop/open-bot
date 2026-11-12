/**
 * Bot box / sandbox theo turn + egress gate (M6, mốc mở rộng quy mô).
 *
 * Mô hình (chọn 1, ghi rõ — xem README.md trong thư mục này):
 *  - Box THEO BOT: mỗi bot có đúng 1 box (thư mục làm việc riêng dưới
 *    `<root>/boxes/<botId>/`). Turn chạy BÊN TRONG box đó.
 *  - Reset theo turn là TUỲ CHỌN (`resetPerTurn: true`): đầu mỗi turn
 *    xoá nội dung workspace của box (giữ lại thư mục `auth/` — trạng
 *    thái đăng nhập đã đồng bộ về host không bị xoá theo).
 *
 * Đây là sandbox LOCAL, không phải VM/container/cloud:
 *  - Linux: bubblewrap (`bwrap`) khi có, fallback namespace `unshare`
 *    khi có, fallback cuối chạy thường + trạng thái "không cách ly".
 *  - macOS: `sandbox-exec` khi có, còn không thì chạy thường + cảnh báo.
 *  - Windows: chạy thường + cảnh báo (chưa có cơ chế cách ly tương đương).
 * KHÔNG BAO GIỜ báo "đã cách ly" khi thực tế chạy thường.
 *
 * Secret chỉ đi qua Vault: box KHÔNG BAO GIỜ đọc toàn bộ
 * `process.env` của host. Env trong box được dựng từ allow-list tên
 * biến + giá trị do caller đưa rõ ràng (caller lấy giá trị từ Vault).
 * Xem `env.ts`.
 */

export type IsolationKind = 'bwrap' | 'unshare' | 'sandbox-exec' | 'none' | 'vm';

/** Mức cách ly thật của một lần chạy trong box. */
export interface IsolationInfo {
  kind: IsolationKind;
  /** True khi tiến trình con thật sự chạy trong namespace/sandbox. */
  isolated: boolean;
  /** Mô tả ngắn cho log/UI (vd 'bwrap (user+pid ns)', 'none — chạy thường'). */
  detail: string;
  /** Cảnh báo khi không cách ly (undefined khi đã cách ly). */
  warning?: string;
}

/** Giới hạn tài nguyên của box (cap rõ ràng, xem README). */
export interface BoxResourceLimits {
  /** Timeout một lần chạy trong box, ms (mặc định 120_000). */
  timeoutMs?: number;
  /** Tổng dung lượng ghi tối đa trong workspace, bytes (mặc định 100 MB). */
  maxWriteBytes?: number;
  /** Số ký tự output tối đa giữ lại (mặc định 200_000). */
  maxOutputChars?: number;
  /** Số file tối đa trong workspace (metadata — chỉ kiểm tra sau khi chạy). */
  maxFiles?: number;
  /**
   * Tổng thời gian CPU tối đa một lần chạy, giây (sóng B — máy-tính-bot).
   * Enforce bằng `prlimit --cpu` trên Linux; undefined = không giới hạn.
   * Gợi ý từ planner: cpuCores * timeoutMs/1000 (không đốt CPU quá
   * số core đã cấp trong thời gian chạy).
   */
  cpuSeconds?: number | undefined;
  /**
   * Bộ nhớ ảo tối đa một lần chạy, bytes (sóng B). Enforce bằng
   * `prlimit --as` trên Linux — LƯU Ý: --as giới hạn không gian địa
   * chỉ ẢO (không phải RAM vật lý; RLIMIT_RSS không được kernel
   * enforce), floor 4GB vì Node cần ≥4GB ảo. Giới hạn RAM vật lý thật
   * cần cgroup (follow-up). undefined = không giới hạn.
   */
  maxMemoryBytes?: number | undefined;
  /**
   * Số process tối đa một lần chạy (sóng B). Enforce bằng
   * `prlimit --nproc` trên Linux; undefined = không giới hạn.
   */
  maxProcesses?: number | undefined;
}

/**
 * Giới hạn đã resolve đầy đủ cho một box (mọi field đều có mặt; 3
 * field mới có thể là undefined = không giới hạn thêm). Dùng type
 * riêng thay vì `Required<BoxResourceLimits>` vì Required<> lột
 * `| undefined` khỏi field optional (TS quirk đã kiểm chứng).
 */
export type ResolvedBoxLimits = {
  timeoutMs: number;
  maxWriteBytes: number;
  maxOutputChars: number;
  maxFiles: number;
  cpuSeconds: number | undefined;
  maxMemoryBytes: number | undefined;
  maxProcesses: number | undefined;
};

/** Giới hạn tài nguyên đã áp dụng (hay chưa) cho một lần chạy trong box. */
export interface AppliedResourceLimits {
  cpuSeconds?: number;
  maxMemoryBytes?: number;
  maxProcesses?: number;
  /** True khi prlimit có mặt và argv đã được bọc prlimit thật. */
  enforced: boolean;
  /** Lý do chưa enforce (vd 'thiếu prlimit trên máy này'). */
  reason?: string;
}

export interface BotBoxOptions {
  /** Box theo bot: reset workspace đầu mỗi turn (mặc định false). */
  resetPerTurn?: boolean;
  /** Tên biến env cho phép (ngoài biến mặc định an toàn, xem env.ts). */
  envAllowlist?: string[];
  /** Giới hạn tài nguyên. */
  limits?: BoxResourceLimits;
  /** Ép backend cách ly ('auto' = tự chọn tốt nhất có thể). */
  isolation?: 'auto' | IsolationKind;
  /** Port cho egress gate của box (0 = chọn port trống; mặc định 0). */
  gatePort?: number;
  /** Nơi ghi cảnh báo (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

/** Metadata của một bot box (ghi vào `box.json`, không chứa secret). */
export interface BotBox {
  id: string;
  botId: string;
  /** Thư mục gốc của box: `<root>/boxes/<botId>/`. */
  dir: string;
  /** Thư mục làm việc riêng của bot (không chạm workspace bot khác). */
  workspaceDir: string;
  /** Thư mục trạng thái đăng nhập đã đồng bộ (quyền 0700). */
  authDir: string;
  envAllowlist: string[];
  limits: ResolvedBoxLimits;
  resetPerTurn: boolean;
  isolation: IsolationKind;
  status: 'active' | 'destroyed';
  createdAt: string;
  updatedAt: string;
}

/** Kết quả một lần chạy lệnh trong box. */
export interface BoxRunResult {
  boxId: string;
  botId: string;
  command: string;
  args: string[];
  /** Mức cách ly THẬT của lần chạy này. */
  isolation: IsolationInfo;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True khi bị kill vì vượt cap ghi. */
  writeCapExceeded: boolean;
  /** Dung lượng workspace đo được sau khi chạy (bytes). */
  workspaceBytes: number;
  durationMs: number;
  /** Giới hạn CPU/RAM/process đã áp dụng (hay chưa) cho lần chạy này. */
  limitsApplied?: AppliedResourceLimits;
}

/** Trạng thái đăng nhập được đồng bộ (CHỈ trạng thái + nhãn — KHÔNG token). */
export type SignInStatus = 'signed-in' | 'signed-out' | 'unknown';

export interface SignInState {
  /** Provider/CLI (vd 'claude', 'codex', 'grok-cli'). */
  provider: string;
  /** Nhãn tài khoản hiển thị (vd email/username đã che — KHÔNG token). */
  accountLabel?: string;
  status: SignInStatus;
  /** Thời điểm trạng thái này được quan sát (ISO string). */
  observedAt: string;
  /** Nguồn quan sát (vd 'cli-probe', 'box-exit'). */
  source?: string;
}

/** Một quyết định của egress gate (log: chỉ host + kind, không URL đầy đủ). */
export interface GateDecisionLog {
  at: string;
  boxId: string;
  method: string;
  /** Host đích (không path/query — tránh rò secret trong URL). */
  host: string;
  allowed: boolean;
  /** Kind theo egress (`allowed` | `blocked` | `unconfigured` | `unreachable` | `invalid_response`). */
  kind: string;
  reason?: string;
}

export interface EgressGateOptions {
  /** Port bind (0 = chọn port trống; mặc định 0). Chỉ bind 127.0.0.1. */
  port?: number;
  /** Policy egress (tái dùng `egress/` — không viết policy thứ hai). */
  policy: import('../egress/types').EgressPolicy;
  /** Hàm resolve DNS (test inject fake; mặc định dns.lookup). */
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /**
   * Hàm forward HTTP thật (test inject fake để tránh mạng thật).
   * Nhận { method, url, headers, body } và trả { status, headers, body }.
   */
  forwardFn?: (request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Buffer;
  }) => Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }>;
  /**
   * Hàm mở tunnel TCP cho CONNECT (test inject fake để tránh mạng thật).
   * Mặc định dùng `net.connect` tới host:port thật.
   */
  connectFn?: (host: string, port: number) => Promise<import('node:net').Socket>;
  /** Nơi ghi quyết định gate (mặc định ghi vào mảng nội bộ). */
  onDecision?: (decision: GateDecisionLog) => void;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
}
