/**
 * Detected CLI engines — types (M1, mốc mở rộng quy mô).
 *
 * Một "detected engine" là một CLI agent đã cài trên máy người dùng
 * (Claude Code, Codex, Grok CLI, OpenCode, Gemini CLI, Cursor CLI)
 * mà open-bot có thể mượn model/tài khoản đăng nhập sẵn của nó —
 * theo mẫu OpenMausBot (xem docs/research-openmausbot.md §4).
 *
 * NGUYÊN TẮC BẢO MẬT (ghi rõ để không ai vô tình phá):
 * - Snapshot CHỈ chứa nhãn (tên CLI, version, trạng thái, nhãn tài
 *   khoản, lý do) — KHÔNG BAO GIỜ chứa token, secret hay nội dung
 *   credential. Detector hỏi chính CLI bằng lệnh status của nó
 *   (`claude auth status --json`…), không đọc file credential.
 * - Ngoại lệ duy nhất là kiểm tra SỰ TỒN TẠI của file auth (Grok:
 *   `~/.grok/auth.json` có tồn tại không — Grok không có lệnh status);
 *   nội dung file không bao giờ được đọc.
 * - Gemini: `~/.gemini/google_accounts.json` chỉ chứa email (không
 *   phải token) nên được đọc để lấy nhãn tài khoản; `oauth_creds.json`
 *   (chứa token) KHÔNG bao giờ được đọc.
 * - Opt-in mặc định TẮT (fail-closed): nguồn chưa được user bật thì
 *   provider CLI tương ứng không xuất hiện trong picker và không bao
 *   giờ được dùng, dù CLI đã cài và đã đăng nhập.
 */

/** Các CLI mà open-bot biết cách phát hiện (M1: đủ 6; sóng B đội platform: +5 = 11; v0.76: +Kiro CLI = 12). */
export type DetectedEngineKind =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'opencode'
  | 'gemini'
  | 'cursor'
  | 'aider'
  | 'continue'
  | 'copilot'
  | 'amazonq'
  | 'windsurf'
  | 'kiro';

/** Trạng thái của một engine sau một lần detect. */
export type EngineStatus = 'available' | 'unavailable' | 'unknown';

/**
 * Mã lý do khi status = 'unavailable' (UI map mã này sang text i18n,
 * `reasonDetail` chỉ là chi tiết kỹ thuật đã cắt ngắn — không chứa secret).
 */
export type EngineUnavailableReason =
  | 'not-installed' // không tìm thấy binary trên PATH
  | 'version-too-old' // có binary nhưng version dưới mức tối thiểu
  | 'version-probe-failed' // chạy `--version` lỗi/timeout
  | 'not-signed-in' // CLI chạy được nhưng chưa đăng nhập
  | 'auth-check-failed' // lệnh kiểm tra đăng nhập lỗi/timeout (không kết luận được)
  | 'disabled'; // nguồn đang tắt (chỉ dùng cho hiển thị, không phải kết quả detect)

/** Nhãn tài khoản mà CLI tự báo — chỉ nhãn, không token. */
export interface EngineAccount {
  /** Email / tên tài khoản / nhãn hiển thị (có thể undefined khi CLI không cho biết). */
  label?: string;
  /** Cách tài khoản này đăng nhập (theo CLI báo hoặc suy ra từ cơ chế). */
  method: 'subscription' | 'api-key' | 'oauth' | 'unknown';
}

/**
 * Snapshot của một engine sau một lần detect. Đây là thứ UI đọc để vẽ
 * Settings → Engines và provider picker — an toàn để gửi qua IPC vì
 * không chứa secret.
 */
export interface DetectedEngineSnapshot {
  /** Kind của detector (6 kind có sẵn, hoặc kind tuỳ chỉnh do registerDetector thêm). */
  kind: string;
  /** Tên hiển thị, vd 'Claude Code'. */
  label: string;
  /** Tên binary, vd 'claude'. */
  binary: string;
  /** Đường dẫn tuyệt đối tới binary đã tìm thấy; null khi chưa cài. */
  binaryPath: string | null;
  /** Version đã probe được (dạng 'x.y.z' khi parse được); null khi chưa rõ. */
  version: string | null;
  /** Version tối thiểu mà driver yêu cầu. */
  minVersion: string;
  status: EngineStatus;
  /** Mã lý do khi unavailable (xem EngineUnavailableReason). */
  reason?: EngineUnavailableReason;
  /** Chi tiết kỹ thuật đã cắt ngắn (stderr/exit code) — không secret. */
  reasonDetail?: string;
  /** Tài khoản mà CLI đang đăng nhập (chỉ khi available). */
  account?: EngineAccount;
  /** Cơ chế kiểm tra đăng nhập đã dùng. */
  authMethod: 'cli-status' | 'cli-list' | 'file-exists' | 'file-label' | 'env-present' | 'none';
  /** Thời điểm detect (ISO string). */
  detectedAt: string;
  /** User đã bật nguồn này chưa (opt-in; mặc định false). */
  enabled: boolean;
}

/** Toàn bộ snapshot detector: một mục mỗi engine + thời điểm detect. */
export interface DetectedEnginesSnapshot {
  engines: Record<string, DetectedEngineSnapshot>;
  detectedAt: string;
}

/** File trạng thái opt-in bền vững (`<userData>/detected-engines.json`). */
export interface DetectedEnginesStateFile {
  version: 1;
  /** kind -> đã bật hay chưa. Kind vắng mặt = chưa bật (mặc định tắt). */
  enabled: Partial<Record<string, boolean>>;
  /**
   * M3: cấu hình các CLI ACP tuỳ chỉnh do user khai báo (Settings →
   * Engines → "Set CLI…"). Vắng mặt = chưa có CLI tuỳ chỉnh nào.
   * Chỉ chứa đường dẫn + argv (không secret — argv chứa cờ key/token
   * bị từ chối lúc thêm, xem detected/custom.ts).
   */
  customClis?: CustomAcpCliConfig[];
}

/**
 * M3 — cấu hình một CLI ACP tuỳ chỉnh do user khai báo. Lưu bền vững
 * trong `detected-engines.json` (cùng file opt-in, ghi atomic).
 */
export interface CustomAcpCliConfig {
  /**
   * Slug định danh (vd `my-agent`): chỉ chữ thường/số/gạch nối,
   * tối đa 32 ký tự. Kind của engine là `custom-acp:<slug>`; model
   * của bot dùng CLI này cũng là slug.
   */
  id: string;
  /** Tên hiển thị trong Settings → Engines và picker (tối đa 100 ký tự). */
  label: string;
  /** Đường dẫn tuyệt đối tới binary CLI. */
  binaryPath: string;
  /** argv đưa CLI vào chế độ ACP stdio (vd `['acp']` hay `['--acp']`). */
  acpArgs: string[];
  /**
   * argv (tuỳ chọn) kiểm tra đăng nhập, vd `['status']`: exit 0 =
   * available, khác 0 = chưa đăng nhập. Không có thì trạng thái là
   * 'unknown' (không rõ đăng nhập — không bịa là đã đăng nhập).
   */
  statusArgs?: string[];
}

/** Kết quả chạy một lệnh probe (version / auth status). */
export interface ProbeResult {
  /** Exit code; null khi process bị kill (timeout) hoặc không spawn được. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True khi bị kill do hết timeout. */
  timedOut: boolean;
  /** Lỗi spawn (vd binary không chạy được) — khi có thì code = null. */
  spawnError?: string;
}

/** Cách kiểm tra đăng nhập của một detector. */
export type AuthCheck =
  | {
      type: 'command';
      /** argv sau tên binary, vd ['auth', 'status', '--json']. */
      args: string[];
      /**
       * Sóng B (đội platform): tên binary KHÁC để chạy lệnh kiểm tra
       * đăng nhập (tìm trên PATH), vd 'gh' cho Copilot CLI (`gh auth
       * status` — chính Copilot CLI không có lệnh status). Không đặt
       * thì chạy bằng binary của chính detector.
       */
      binary?: string;
      /**
       * Đọc kết quả lệnh thành nhãn tài khoản. Trả null khi CLI báo
       * chưa đăng nhập (exit != 0 cũng được coi là chưa đăng nhập).
       * Parser phải phòng thủ: output của CLI thật chưa được kiểm
       * chứng trên máy này, nên mọi field đều optional và parse lỗi
       * thì trả null thay vì throw.
       */
      parse: (result: ProbeResult) => EngineAccount | null;
    }
  | {
      type: 'file-exists';
      /**
       * Các đường dẫn (tương đối so với homeDir, hoặc tuyệt đối) mà
       * sự TỒN TẠI của bất kỳ file nào cũng nghĩa là đã đăng nhập.
       * CHỈ kiểm tra tồn tại — không đọc nội dung.
       */
      paths: (homeDir: string, env: NodeJS.ProcessEnv) => string[];
      /** Nhãn mặc định khi file tồn tại mà không đọc được nhãn thật. */
      accountLabel?: string;
      /**
       * Sóng B: cách tài khoản đăng nhập (mặc định 'subscription').
       * Vd Continue: file config chỉ chứng minh đã cấu hình API key
       * nên method là 'api-key'.
       */
      method?: EngineAccount['method'];
    }
  | {
      /**
       * Sóng B (đội platform): kiểm tra SỰ TỒN TẠI (và không rỗng) của
       * biến môi trường chứa API key — dùng cho CLI không có tài khoản
       * đăng nhập mà chỉ chạy bằng key (vd Aider). CHỈ kiểm tra tên
       * biến có tồn tại hay không — GIÁ TRỊ key không bao giờ được
       * đọc, ghi log hay đưa vào snapshot. Nhãn trả về chỉ nêu HỌ key
       * (vd 'OpenAI API key'), không phải giá trị key.
       */
      type: 'env-present';
      /** Tên biến môi trường ứng viên, theo thứ tự ưu tiên. */
      envNames: string[];
      /**
       * Nhãn hiển thị theo tên biến tìm thấy (vd 'OpenAI API key').
       * Không đặt thì nhãn là tên biến.
       */
      labelForEnv?: (envName: string) => string;
    }
  | {
      type: 'file-label';
      /**
       * Đọc NHÃN từ một file chỉ chứa nhãn (không token), vd
       * `~/.gemini/google_accounts.json` (chỉ email). File chứa token
       * KHÔNG BAO GIỜ được dùng ở đây. Trả null khi file không tồn
       * tại hoặc không đọc được nhãn.
       */
      readLabel: (homeDir: string, env: NodeJS.ProcessEnv) => EngineAccount | null;
    }
  | {
      /**
       * M3 (custom ACP CLI): không có cách kiểm tra đăng nhập — trạng
       * thái detect là 'unknown' (không rõ), không bịa là đã đăng
       * nhập. Provider vẫn dùng được khi user bật nguồn (user tự chịu
       * trách nhiệm về login của CLI tuỳ chỉnh); `session/new` lỗi
       * thì báo rõ.
       */
      type: 'none';
    };

/**
 * Khai báo một detector. Thêm một CLI mới = thêm một khai báo vào
 * `BUILTIN_DETECTORS` (hoặc `registry.registerDetector()`), không sửa
 * core của registry. `kind` là string mở (6 kind có sẵn xem
 * DetectedEngineKind) để detector tuỳ chỉnh không cần sửa types.
 */
export interface DetectorDefinition {
  kind: string;
  label: string;
  /** Tên binary ứng viên, theo thứ tự ưu tiên (vd ['cursor-agent', 'agent']). */
  binaries: string[];
  /**
   * M3 (custom ACP CLI): đường dẫn tuyệt đối tới binary. Khi có thì
   * detector dùng thẳng đường dẫn này (kiểm tra tồn tại + chạy được)
   * thay vì tìm tên binary trên PATH.
   */
  binaryPath?: string;
  /** Version tối thiểu (semver 'x.y.z'); '' = chấp nhận mọi version. */
  minVersion: string;
  /** argv cho probe version, vd ['--version']. */
  versionArgs: string[];
  /** Cách kiểm tra đăng nhập. */
  auth: AuthCheck;
}
