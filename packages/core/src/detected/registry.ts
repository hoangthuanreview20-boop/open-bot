/**
 * DetectedEngineRegistry (M1) — quét PATH tìm CLI agent, probe version,
 * kiểm tra đăng nhập bằng lệnh của chính CLI, lưu snapshot trạng thái.
 *
 * Thiết kế (theo mẫu OpenMausBot `server/harness/registry.ts`):
 * - Snapshot có deadline tái dùng: `detect()` dùng cache trong TTL
 *   (mặc định 60 giây, như danh sách engine của OMB); `force: true`
 *   để quét lại ngay (nút Re-detect trong UI).
 * - CLI hỏng/chưa cài chỉ thành 'unavailable' kèm lý do — không bao giờ
 *   làm crash app hay các detector khác (mỗi detector chạy độc lập,
 *   lỗi nào cũng bắt và ghi vào snapshot của chính nó).
 * - Registry mở rộng được: thêm detector = thêm một khai báo qua
 *   `registerDetector()` (hoặc constructor), không sửa code registry.
 * - Opt-in fail-closed: `enabled` mặc định false cho mọi nguồn; chỉ
 *   user bật trong Settings → Engines mới được dùng. Trạng thái bật/tắt
 *   bền vững trong file JSON (chỉ kind + boolean, không secret).
 * - KHÔNG đọc credential: xem detected/types.ts + definitions.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BUILTIN_DETECTORS } from './definitions';
import {
  customAcpDetectorDefinition,
  customAcpKind,
  validateCustomAcpCliConfig,
} from './custom';
import {
  AUTH_PROBE_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  findOnPath,
  meetsMinVersion,
  parseVersion,
  runProbe,
  truncateText,
} from './probe';
import type {
  CustomAcpCliConfig,
  DetectedEngineKind,
  DetectedEngineSnapshot,
  DetectedEnginesSnapshot,
  DetectedEnginesStateFile,
  DetectorDefinition,
  EngineAccount,
  EngineUnavailableReason,
  ProbeResult,
} from './types';

export type { DetectedEnginesSnapshot };

/** Mọi kind mà registry biết (theo detector đã đăng ký). */
export const KNOWN_ENGINE_KINDS: DetectedEngineKind[] = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'gemini',
  'cursor',
  // Sóng B (đội platform): 5 detector mới.
  'aider',
  'continue',
  'copilot',
  'amazonq',
  'windsurf',
  // v0.76: Kiro CLI (kế tiếp của Amazon Q CLI).
  'kiro',
];

/** TTL mặc định của cache detect (ms) — theo OMB, danh sách engine tái dùng 60s. */
export const DETECT_CACHE_TTL_MS = 60_000;

export interface DetectedEngineRegistryOptions {
  /** Detector thêm ngoài built-in (ghi đè kind trùng). */
  definitions?: DetectorDefinition[];
  /** Thư mục tìm binary TRƯỚC PATH (test dùng thư mục tạm chứa fake binary). */
  pathDirs?: string[];
  /** Thư mục home dùng cho kiểm tra file-exists (mặc định os.homedir()). */
  homeDir?: string;
  /** Env dùng cho PATH/GROK_HOME/... (mặc định process.env). */
  env?: NodeJS.ProcessEnv;
  /** TTL cache detect (ms); 0 = không cache. */
  cacheTtlMs?: number;
  /** File bền vững cho trạng thái bật/tắt (`<userData>/detected-engines.json`). */
  stateFilePath?: string;
  /** Timeout probe version / auth (ms). */
  versionProbeTimeoutMs?: number;
  authProbeTimeoutMs?: number;
  /** Hàm chạy lệnh probe (mặc định runProbe thật; test có thể inject fake). */
  execFn?: (binary: string, args: string[], opts: { timeoutMs?: number }) => Promise<ProbeResult>;
  /** Nơi ghi cảnh báo (mặc định console.warn). */
  logger?: { warn(message: string): void };
}

/** Tên file trạng thái opt-in (tương đối so với userData). */
export const DETECTED_ENGINES_FILE = 'detected-engines.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Đọc file trạng thái opt-in + cấu hình CLI tuỳ chỉnh; file thiếu/hỏng = tất cả tắt, không CLI tuỳ chỉnh (fail-closed). */
function readStateFile(
  filePath: string,
  warn: (message: string) => void,
): { enabled: Partial<Record<string, boolean>>; customClis: CustomAcpCliConfig[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`không đọc được ${DETECTED_ENGINES_FILE}: ${(err as Error).message}; coi như tất cả nguồn đều tắt.`);
    }
    return { enabled: {}, customClis: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    warn(`${DETECTED_ENGINES_FILE} hỏng (không phải JSON hợp lệ); coi như tất cả nguồn đều tắt.`);
    return { enabled: {}, customClis: [] };
  }
  if (!isRecord(parsed)) return { enabled: {}, customClis: [] };
  const enabled: Partial<Record<string, boolean>> = {};
  if (isRecord(parsed['enabled'])) {
    for (const [kind, value] of Object.entries(parsed['enabled'])) {
      if (typeof kind === 'string' && kind.length > 0 && typeof value === 'boolean') {
        enabled[kind] = value;
      }
    }
  }
  // M3: cấu hình CLI ACP tuỳ chỉnh — mục hỏng thì bỏ qua mục đó (kèm
  // cảnh báo), không làm hỏng cả file.
  const customClis: CustomAcpCliConfig[] = [];
  if (parsed['customClis'] !== undefined) {
    if (!Array.isArray(parsed['customClis'])) {
      warn(`${DETECTED_ENGINES_FILE}: "customClis" phải là mảng, đã bỏ qua.`);
    } else {
      for (const entry of parsed['customClis']) {
        try {
          customClis.push(validateCustomAcpCliConfig(entry));
        } catch (err) {
          warn(`${DETECTED_ENGINES_FILE}: bỏ qua CLI tuỳ chỉnh không hợp lệ: ${(err as Error).message}`);
        }
      }
    }
  }
  return { enabled, customClis };
}

export class DetectedEngineRegistry {
  private readonly definitions = new Map<string, DetectorDefinition>();
  private readonly pathDirs: string[];
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cacheTtlMs: number;
  private readonly stateFilePath?: string;
  private readonly versionProbeTimeoutMs: number;
  private readonly authProbeTimeoutMs: number;
  private readonly execFn: NonNullable<DetectedEngineRegistryOptions['execFn']>;
  private readonly warn: (message: string) => void;
  private enabled: Partial<Record<string, boolean>> = {};
  /** M3: cấu hình CLI ACP tuỳ chỉnh (key = slug). */
  private customClis = new Map<string, CustomAcpCliConfig>();
  private lastSnapshot: DetectedEnginesSnapshot | null = null;
  private lastDetectAt = 0;
  private detectInFlight: Promise<DetectedEnginesSnapshot> | null = null;

  constructor(options: DetectedEngineRegistryOptions = {}) {
    for (const def of BUILTIN_DETECTORS) this.definitions.set(def.kind, def);
    for (const def of options.definitions ?? []) this.definitions.set(def.kind, def);
    this.pathDirs = options.pathDirs ?? [];
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.cacheTtlMs = options.cacheTtlMs ?? DETECT_CACHE_TTL_MS;
    this.stateFilePath = options.stateFilePath;
    this.versionProbeTimeoutMs = options.versionProbeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
    this.authProbeTimeoutMs = options.authProbeTimeoutMs ?? AUTH_PROBE_TIMEOUT_MS;
    this.execFn = options.execFn ?? ((binary, args, opts) => runProbe(binary, args, opts));
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[DetectedEngines] ${message}`);
    if (this.stateFilePath) {
      const state = readStateFile(this.stateFilePath, this.warn);
      this.enabled = state.enabled;
      for (const cfg of state.customClis) {
        this.customClis.set(cfg.id, cfg);
        this.definitions.set(customAcpKind(cfg.id), customAcpDetectorDefinition(cfg));
      }
    }
  }

  // ------------------------------------------------------------------
  // Detector registration
  // ------------------------------------------------------------------

  /**
   * Đăng ký thêm (hoặc ghi đè) một detector. Thêm CLI mới chỉ cần gọi
   * hàm này với một khai báo — không sửa code registry.
   */
  registerDetector(definition: DetectorDefinition): void {
    if (!definition || typeof definition.kind !== 'string' || !Array.isArray(definition.binaries)) {
      throw new Error('registerDetector cần một DetectorDefinition hợp lệ.');
    }
    this.definitions.set(definition.kind, definition);
    this.lastSnapshot = null;
    this.lastDetectAt = 0;
  }

  /** Các kind đã đăng ký (built-in + custom). */
  listKinds(): string[] {
    return [...this.definitions.keys()];
  }

  // ------------------------------------------------------------------
  // Custom ACP CLI (M3)
  // ------------------------------------------------------------------

  /** Danh sách cấu hình CLI ACP tuỳ chỉnh (bản sao). */
  listCustomClis(): CustomAcpCliConfig[] {
    return [...this.customClis.values()].map((cfg) => ({
      ...cfg,
      acpArgs: [...cfg.acpArgs],
      statusArgs: cfg.statusArgs ? [...cfg.statusArgs] : undefined,
    }));
  }

  /** Cấu hình của CLI tuỳ chỉnh có slug `id` (undefined khi không có). */
  getCustomCli(id: string): CustomAcpCliConfig | undefined {
    const cfg = this.customClis.get(id);
    if (!cfg) return undefined;
    return {
      ...cfg,
      acpArgs: [...cfg.acpArgs],
      statusArgs: cfg.statusArgs ? [...cfg.statusArgs] : undefined,
    };
  }

  /** Kiểm tra binary của CLI tuỳ chỉnh tồn tại + là file chạy được (throw khi không). */
  private assertCustomBinaryUsable(binaryPath: string): void {
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
      if (!fs.statSync(binaryPath).isFile()) {
        throw new Error(`"${binaryPath}" không phải là file.`);
      }
    } catch (err) {
      throw new Error(
        `CLI tuỳ chỉnh: không chạy được binary "${binaryPath}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Thêm một CLI ACP tuỳ chỉnh (validate + kiểm tra binary + đăng ký
   * detector + lưu bền vững). Throw khi cấu hình không hợp lệ, slug
   * đã tồn tại, hoặc binary không chạy được.
   */
  addCustomCli(input: unknown): CustomAcpCliConfig {
    const cfg = validateCustomAcpCliConfig(input);
    if (this.customClis.has(cfg.id)) {
      throw new Error(`CLI tuỳ chỉnh: slug "${cfg.id}" đã tồn tại — chọn slug khác hoặc sửa CLI cũ.`);
    }
    this.assertCustomBinaryUsable(cfg.binaryPath);
    this.customClis.set(cfg.id, cfg);
    this.definitions.set(customAcpKind(cfg.id), customAcpDetectorDefinition(cfg));
    this.saveState();
    this.lastSnapshot = null;
    this.lastDetectAt = 0;
    return this.getCustomCli(cfg.id) as CustomAcpCliConfig;
  }

  /**
   * Sửa cấu hình của CLI tuỳ chỉnh có slug `id` (gộp patch lên cấu
   * hình cũ rồi validate lại toàn bộ). `id` trong patch (nếu có) phải
   * trùng `id` cũ — đổi slug thì xoá rồi thêm mới. Throw khi không
   * tìm thấy CLI, cấu hình mới không hợp lệ, hoặc binary mới không
   * chạy được.
   */
  updateCustomCli(id: string, patch: unknown): CustomAcpCliConfig {
    const existing = this.customClis.get(id);
    if (!existing) throw new Error(`CLI tuỳ chỉnh: không tìm thấy slug "${id}".`);
    if (!isRecord(patch)) throw new Error('CLI tuỳ chỉnh: patch sửa phải là object.');
    if (patch['id'] !== undefined && patch['id'] !== id) {
      throw new Error('CLI tuỳ chỉnh: không đổi được slug — xoá rồi thêm mới với slug khác.');
    }
    const cfg = validateCustomAcpCliConfig({ ...existing, ...patch, id });
    this.assertCustomBinaryUsable(cfg.binaryPath);
    this.customClis.set(id, cfg);
    this.definitions.set(customAcpKind(id), customAcpDetectorDefinition(cfg));
    this.saveState();
    this.lastSnapshot = null;
    this.lastDetectAt = 0;
    return this.getCustomCli(id) as CustomAcpCliConfig;
  }

  /**
   * Xoá một CLI ACP tuỳ chỉnh (gỡ detector + trạng thái bật/tắt của
   * nó + lưu bền vững). Throw khi không tìm thấy slug.
   */
  removeCustomCli(id: string): void {
    if (!this.customClis.has(id)) {
      throw new Error(`CLI tuỳ chỉnh: không tìm thấy slug "${id}".`);
    }
    this.customClis.delete(id);
    this.definitions.delete(customAcpKind(id));
    delete this.enabled[customAcpKind(id)];
    this.saveState();
    this.lastSnapshot = null;
    this.lastDetectAt = 0;
  }

  // ------------------------------------------------------------------
  // Opt-in (fail-closed: mặc định tắt)
  // ------------------------------------------------------------------

  /** True khi user đã bật nguồn này (mặc định false). */
  isEnabled(kind: string): boolean {
    return this.enabled[kind] === true;
  }

  /**
   * Bật/tắt một nguồn. Ghi bền vững xuống file trạng thái (nếu có) và
   * cập nhật snapshot trong bộ nhớ (không cần detect lại).
   */
  setEnabled(kind: string, enabled: boolean): void {
    if (!this.definitions.has(kind)) {
      throw new Error(`Không rõ nguồn detected engine: "${kind}".`);
    }
    if (typeof enabled !== 'boolean') throw new Error('setEnabled cần enabled là boolean.');
    this.enabled[kind] = enabled;
    this.saveState();
    if (this.lastSnapshot) {
      const entry = this.lastSnapshot.engines[kind];
      if (entry) entry.enabled = enabled;
    }
  }

  /** Snapshot hiện tại (chỉ các nguồn đang bật và available). */
  enabledAvailable(): DetectedEngineSnapshot[] {
    if (!this.lastSnapshot) return [];
    return Object.values(this.lastSnapshot.engines).filter((e) => e.enabled && e.status === 'available');
  }

  /** Ghi trạng thái bật/tắt + cấu hình CLI tuỳ chỉnh xuống file (ghi atomic qua file tạm + rename). */
  saveState(): void {
    if (!this.stateFilePath) return;
    const payload: DetectedEnginesStateFile = { version: 1, enabled: { ...this.enabled } };
    if (this.customClis.size > 0) {
      payload.customClis = this.listCustomClis();
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      const tmp = `${this.stateFilePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.stateFilePath);
    } catch (err) {
      this.warn(`không lưu được ${DETECTED_ENGINES_FILE}: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // Detection
  // ------------------------------------------------------------------

  /** Snapshot lần detect gần nhất (null khi chưa detect lần nào). */
  snapshot(): DetectedEnginesSnapshot | null {
    return this.lastSnapshot
      ? {
          engines: Object.fromEntries(
            Object.entries(this.lastSnapshot.engines).map(([k, v]) => [k, { ...v }]),
          ) as Record<string, DetectedEngineSnapshot>,
          detectedAt: this.lastSnapshot.detectedAt,
        }
      : null;
  }

  /**
   * Quét tất cả detector và trả snapshot mới. Dùng cache trong TTL trừ
   * khi `force: true`. Hai lần gọi đồng thời dùng chung một lần quét
   * (không spawn trùng).
   */
  async detect(options: { force?: boolean } = {}): Promise<DetectedEnginesSnapshot> {
    const now = Date.now();
    const cacheFresh =
      this.lastSnapshot !== null &&
      this.cacheTtlMs > 0 &&
      now - this.lastDetectAt < this.cacheTtlMs;
    if (!options.force && cacheFresh && this.lastSnapshot) {
      return this.snapshot() as DetectedEnginesSnapshot;
    }
    if (this.detectInFlight) return this.detectInFlight;
    const run = this.runDetection();
    this.detectInFlight = run;
    try {
      return await run;
    } finally {
      this.detectInFlight = null;
    }
  }

  /**
   * M4 — quét lại CHỈ MỘT engine (nút Re-detect từng engine trong
   * Settings → Engines). Chỉ chạy probe của detector đó rồi vá mục
   * tương ứng trong snapshot (các engine khác giữ nguyên detectedAt +
   * trạng thái cũ); chưa detect lần nào thì quét đầy đủ một lần.
   * Throw khi kind chưa đăng ký. Một detector lỗi chỉ thành
   * 'unavailable' kèm lý do như quét đầy đủ, không throw.
   */
  async redetectOne(kind: string): Promise<DetectedEnginesSnapshot> {
    const def = this.definitions.get(kind);
    if (!def) throw new Error(`Không rõ nguồn detected engine: "${kind}".`);
    if (this.detectInFlight) await this.detectInFlight;
    if (!this.lastSnapshot) return this.detect({ force: true });
    const detectedAt = new Date().toISOString();
    let entry: DetectedEngineSnapshot;
    try {
      entry = await this.detectOne(def, detectedAt);
    } catch (err) {
      this.warn(`detector "${def.kind}" lỗi: ${(err as Error).message}`);
      entry = this.unavailableSnapshot(def, detectedAt, 'auth-check-failed', 'Lỗi nội bộ khi detect.');
    }
    this.lastSnapshot = {
      engines: { ...this.lastSnapshot.engines, [kind]: entry },
      detectedAt,
    };
    this.lastDetectAt = Date.now();
    return this.snapshot() as DetectedEnginesSnapshot;
  }

  private async runDetection(): Promise<DetectedEnginesSnapshot> {
    const detectedAt = new Date().toISOString();
    const engines: Record<string, DetectedEngineSnapshot> = {};
    const results = await Promise.all(
      [...this.definitions.values()].map(async (def) => {
        try {
          return await this.detectOne(def, detectedAt);
        } catch (err) {
          // Một detector lỗi không được làm hỏng cả lần quét.
          this.warn(`detector "${def.kind}" lỗi: ${(err as Error).message}`);
          return this.unavailableSnapshot(def, detectedAt, 'auth-check-failed', 'Lỗi nội bộ khi detect.');
        }
      }),
    );
    for (const snap of results) engines[snap.kind] = snap;
    const snapshot: DetectedEnginesSnapshot = { engines, detectedAt };
    this.lastSnapshot = snapshot;
    this.lastDetectAt = Date.now();
    return this.snapshot() as DetectedEnginesSnapshot;
  }

  private unavailableSnapshot(
    def: DetectorDefinition,
    detectedAt: string,
    reason: EngineUnavailableReason,
    reasonDetail?: string,
    partial: Partial<DetectedEngineSnapshot> = {},
  ): DetectedEngineSnapshot {
    return {
      kind: def.kind,
      label: def.label,
      binary: def.binaries[0] ?? def.kind,
      binaryPath: null,
      version: null,
      minVersion: def.minVersion,
      status: 'unavailable',
      reason,
      reasonDetail: reasonDetail ? truncateText(reasonDetail, 200) : undefined,
      authMethod: authMethodOf(def),
      detectedAt,
      enabled: this.isEnabled(def.kind),
      ...partial,
    };
  }

  private async detectOne(def: DetectorDefinition, detectedAt: string): Promise<DetectedEngineSnapshot> {
    // M3: detector custom ACP trỏ thẳng tới binary tuyệt đối (không
    // tìm trên PATH) — binary phải tồn tại + chạy được.
    let binaryPath: string | null;
    if (def.binaryPath) {
      try {
        fs.accessSync(def.binaryPath, fs.constants.X_OK);
        binaryPath = fs.statSync(def.binaryPath).isFile() ? def.binaryPath : null;
      } catch {
        binaryPath = null;
      }
      if (!binaryPath) {
        return this.unavailableSnapshot(def, detectedAt, 'not-installed', `Không chạy được binary "${def.binaryPath}".`);
      }
    } else {
      binaryPath = findOnPath(def.binaries, this.pathDirs, this.env);
      if (!binaryPath) {
        return this.unavailableSnapshot(def, detectedAt, 'not-installed');
      }
    }
    const base: Partial<DetectedEngineSnapshot> = { binaryPath };
    // 1. Probe version.
    const versionResult = await this.execFn(binaryPath, def.versionArgs, {
      timeoutMs: this.versionProbeTimeoutMs,
    });
    if (versionResult.timedOut || versionResult.spawnError || versionResult.code !== 0) {
      return this.unavailableSnapshot(
        def,
        detectedAt,
        'version-probe-failed',
        versionResult.timedOut
          ? `Hết thời gian chờ ${this.versionProbeTimeoutMs}ms khi chạy --version.`
          : versionResult.spawnError ?? `Thoát với mã ${versionResult.code ?? '?'}.`,
        base,
      );
    }
    const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (!meetsMinVersion(version, def.minVersion)) {
      return this.unavailableSnapshot(
        def,
        detectedAt,
        'version-too-old',
        version
          ? `Version ${version} dưới mức tối thiểu ${def.minVersion}.`
          : `Không đọc được version (cần tối thiểu ${def.minVersion}).`,
        { ...base, version },
      );
    }
    // 2. Kiểm tra đăng nhập bằng cơ chế của chính CLI.
    // M3: auth 'none' (CLI tuỳ chỉnh không khai lệnh status) → trạng
    // thái 'unknown' (không rõ đăng nhập — không bịa là đã đăng nhập).
    if (def.auth.type === 'none') {
      return {
        kind: def.kind,
        label: def.label,
        binary: def.binaries[0] ?? def.kind,
        binaryPath,
        version,
        minVersion: def.minVersion,
        status: 'unknown',
        reasonDetail: 'CLI tuỳ chỉnh không khai lệnh kiểm tra đăng nhập — trạng thái đăng nhập không rõ, bật nguồn rồi thử chạy bot để biết.',
        authMethod: 'none',
        detectedAt,
        enabled: this.isEnabled(def.kind),
      };
    }
    const account = await this.checkAuth(def, binaryPath);
    if (!account) {
      return this.unavailableSnapshot(def, detectedAt, 'not-signed-in', undefined, {
        ...base,
        version,
      });
    }
    return {
      kind: def.kind,
      label: def.label,
      binary: def.binaries[0] ?? def.kind,
      binaryPath,
      version,
      minVersion: def.minVersion,
      status: 'available',
      account,
      authMethod: authMethodOf(def),
      detectedAt,
      enabled: this.isEnabled(def.kind),
    };
  }

  /** Chạy bước kiểm tra đăng nhập của một detector; lỗi -> null (chưa đăng nhập / không rõ). */
  private async checkAuth(def: DetectorDefinition, binaryPath: string): Promise<EngineAccount | null> {
    const auth = def.auth;
    try {
      if (auth.type === 'env-present') {
        // Sóng B: chỉ kiểm tra TÊN biến có tồn tại + không rỗng —
        // GIÁ TRỊ key không bao giờ được đọc hay ghi log.
        for (const name of auth.envNames) {
          const value = this.env[name];
          if (typeof value === 'string' && value.trim().length > 0) {
            return {
              label: auth.labelForEnv ? auth.labelForEnv(name) : name,
              method: 'api-key',
            };
          }
        }
        return null;
      }
      if (auth.type === 'command') {
        // Sóng B: `binary` cho phép chạy lệnh kiểm tra bằng một binary
        // khác trên PATH (vd 'gh' cho Copilot CLI). Không tìm thấy
        // binary đó thì coi như chưa kiểm chứng được đăng nhập.
        let target = binaryPath;
        if (auth.binary) {
          const found = findOnPath([auth.binary], this.pathDirs, this.env);
          if (!found) return null;
          target = found;
        }
        const result = await this.execFn(target, auth.args, {
          timeoutMs: this.authProbeTimeoutMs,
        });
        if (result.timedOut) {
          this.warn(`kiểm tra đăng nhập "${def.kind}" hết thời gian chờ.`);
          return null;
        }
        return auth.parse(result);
      }
      if (auth.type === 'file-exists') {
        const paths = auth.paths(this.homeDir, this.env);
        for (const p of paths) {
          try {
            if (fs.existsSync(p)) {
              return { label: auth.accountLabel, method: auth.method ?? 'subscription' };
            }
          } catch {
            // Không đọc được trạng thái file — coi như chưa đăng nhập.
          }
        }
        return null;
      }
      if (auth.type === 'none') {
        // Không có cách kiểm tra đăng nhập (detectOne đã rẽ nhánh
        // 'unknown' trước khi tới đây) — về tới đây thì coi như không rõ.
        return null;
      }
      // file-label: chỉ đọc file nhãn (không token); file token chỉ kiểm tra tồn tại.
      return auth.readLabel(this.homeDir, this.env);
    } catch (err) {
      this.warn(`kiểm tra đăng nhập "${def.kind}" lỗi: ${(err as Error).message}`);
      return null;
    }
  }
}

function authMethodOf(def: DetectorDefinition): DetectedEngineSnapshot['authMethod'] {
  if (def.auth.type === 'command') return 'cli-status';
  if (def.auth.type === 'file-exists') return 'file-exists';
  if (def.auth.type === 'env-present') return 'env-present';
  if (def.auth.type === 'none') return 'none';
  return 'file-label';
}
