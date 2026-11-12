/**
 * Hardware probe — dò cấu hình máy thật (sóng B, đội platform).
 *
 * Chạy được cả Linux / Windows / macOS, dùng API Node sẵn có
 * (node:os) + lệnh hệ thống chỉ-đọc (df, sysctl, powershell, lspci,
 * system_profiler). Mọi lần đo đều best-effort: đo không được thì ghi
 * vào `warnings` của MachineProfile, KHÔNG throw, KHÔNG bịa số.
 *
 * Test dùng dữ liệu giả: `probeMachine(deps)` nhận `ProbeDeps` để
 * inject os giả / file giả / lệnh giả — test không bao giờ phụ thuộc
 * máy chạy test (xem tests/computers-b-platform.test.mjs).
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';

import type {
  CpuInfo,
  DiskInfo,
  GpuInfo,
  MachineProfile,
  NetworkInfo,
  ProbeOs,
  VirtualizationInfo,
} from './types';

/** Kết quả một lệnh probe (không bao giờ throw — lỗi nằm trong result). */
export interface ProbeCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Dependencies có thể inject (test truyền dữ liệu giả; production
 * dùng mặc định là node:os / fs / execFile thật).
 */
export interface ProbeDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  hostname?: string;
  osVersion?: string;
  osRelease?: string;
  totalmem?: number;
  freemem?: number;
  cpus?: Array<{ model: string; speed: number }>;
  loadavg?: number[];
  networkInterfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Đọc file text; null khi không đọc được (test trả dữ liệu giả). */
  readFile?: (path: string) => string | null;
  fileExists?: (path: string) => boolean;
  /** Chạy lệnh chỉ-đọc với timeout; không bao giờ throw. */
  run?: (command: string, args: string[], timeoutMs?: number) => Promise<ProbeCommandResult>;
}

const RUN_TIMEOUT_MS = 10_000;
const GPU_RUN_TIMEOUT_MS = 20_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

function defaultRun(
  command: string,
  args: string[],
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<ProbeCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const timedOut =
            !!error &&
            ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
              (error as Error).message.includes('ETIMEDOUT'));
          const code = !error
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null;
          finish({
            code,
            stdout: String(stdout ?? '').slice(0, PROBE_OUTPUT_LIMIT),
            stderr: String(stderr ?? '').slice(0, PROBE_OUTPUT_LIMIT),
            timedOut,
          });
        },
      );
    } catch (err) {
      finish({ code: null, stdout: '', stderr: (err as Error).message, timedOut: false });
    }
  });
}

function defaultReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function defaultFileExists(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

interface ResolvedDeps {
  platform: ProbeOs;
  arch: string;
  hostname: string;
  osVersion: string;
  osRelease: string;
  totalmem: number;
  freemem: number;
  cpus: Array<{ model: string; speed: number }>;
  loadavg: number[];
  networkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  readFile: (path: string) => string | null;
  fileExists: (path: string) => boolean;
  run: (command: string, args: string[], timeoutMs?: number) => Promise<ProbeCommandResult>;
}

function resolveDeps(deps: ProbeDeps = {}): ResolvedDeps {
  const platform = (deps.platform ?? process.platform) as ProbeOs;
  return {
    platform: platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'linux',
    arch: deps.arch ?? process.arch,
    hostname: deps.hostname ?? os.hostname(),
    osVersion: deps.osVersion ?? osVersionSafe(),
    osRelease: deps.osRelease ?? os.release(),
    totalmem: deps.totalmem ?? os.totalmem(),
    freemem: deps.freemem ?? os.freemem(),
    cpus: deps.cpus ?? os.cpus().map((c) => ({ model: c.model, speed: c.speed })),
    loadavg: deps.loadavg ?? os.loadavg(),
    networkInterfaces: deps.networkInterfaces ?? os.networkInterfaces(),
    readFile: deps.readFile ?? defaultReadFile,
    fileExists: deps.fileExists ?? defaultFileExists,
    run: deps.run ?? defaultRun,
  };
}

function osVersionSafe(): string {
  try {
    return os.version();
  } catch {
    return os.release();
  }
}

function firstNumber(text: string): number | null {
  const m = /(\d+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Parse 'cpu cores' đầu tiên trong /proc/cpuinfo (Linux). */
function parseCpuCoresFromCpuinfo(text: string): number | null {
  const m = /^cpu cores\s*:\s*(\d+)\s*$/m.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Flag ảo hoá trong dòng 'flags' của /proc/cpuinfo (Linux). */
function parseVirtFlagsFromCpuinfo(text: string): string[] {
  const m = /^flags\s*:\s*(.+)$/m.exec(text);
  if (!m) return [];
  const flags = new Set(m[1].split(/\s+/));
  const out: string[] = [];
  if (flags.has('vmx')) out.push('vmx');
  if (flags.has('svm')) out.push('svm');
  return out;
}

async function probeCpu(d: ResolvedDeps, warnings: string[]): Promise<CpuInfo> {
  const logicalCores = d.cpus.length > 0 ? d.cpus.length : 1;
  const model = d.cpus[0]?.model?.trim() || 'unknown';
  const speedMhz = d.cpus[0]?.speed && d.cpus[0].speed > 0 ? d.cpus[0].speed : null;
  let physicalCores: number | null = null;
  let virtualizationFlags: string[] = [];

  if (d.platform === 'linux') {
    const cpuinfo = d.readFile('/proc/cpuinfo');
    if (cpuinfo) {
      physicalCores = parseCpuCoresFromCpuinfo(cpuinfo);
      virtualizationFlags = parseVirtFlagsFromCpuinfo(cpuinfo);
    } else {
      warnings.push('không đọc được /proc/cpuinfo (số core vật lý + flag ảo hoá không rõ).');
    }
  } else if (d.platform === 'darwin') {
    if (d.arch === 'arm64') {
      // Apple Silicon luôn hỗ trợ ảo hoá (Virtualization.framework).
      virtualizationFlags = ['apple-silicon'];
    } else {
      const r = await d.run('sysctl', ['-n', 'machdep.cpu.features']);
      if (r.code === 0 && /VMX/i.test(r.stdout)) virtualizationFlags = ['vmx'];
    }
    const r = await d.run('sysctl', ['-n', 'hw.physicalcpu']);
    if (r.code === 0) physicalCores = firstNumber(r.stdout);
    if (physicalCores === null) warnings.push('không đọc được hw.physicalcpu (số core vật lý không rõ).');
  } else if (d.platform === 'win32') {
    const r = await d.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_Processor | Select-Object -First 1).NumberOfCores',
    ]);
    if (r.code === 0) physicalCores = firstNumber(r.stdout);
    if (physicalCores === null) warnings.push('không đọc được số core vật lý trên Windows.');
    const v = await d.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled',
    ]);
    if (v.code === 0 && /true/i.test(v.stdout)) virtualizationFlags = ['vmx'];
  }

  const loadAvg1m = d.loadavg[0] !== undefined && d.loadavg[0] > 0 ? d.loadavg[0] : null;
  return {
    model,
    logicalCores,
    physicalCores,
    speedMhz,
    virtualizationFlags,
    loadAvg1m,
    loadPerCore: loadAvg1m !== null ? loadAvg1m / logicalCores : null,
  };
}

function parseDfOutput(stdout: string): DiskInfo[] {
  const out: DiskInfo[] = [];
  const lines = stdout.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    // df -P: filesystem 1024-blocks used available capacity mount
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const totalKb = Number(parts[1]);
    const freeKb = Number(parts[3]);
    const mount = parts.slice(5).join(' ');
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb <= 0) continue;
    // Bỏ qua mount ảo (không phải đĩa thật).
    if (/^\/(dev|proc|sys|run)(\/|$)/.test(mount)) continue;
    const totalBytes = totalKb * 1024;
    const freeBytes = freeKb * 1024;
    out.push({
      mount,
      totalBytes,
      freeBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0,
    });
  }
  return out;
}

async function probeDisks(d: ResolvedDeps, warnings: string[]): Promise<DiskInfo[]> {
  if (d.platform === 'linux' || d.platform === 'darwin') {
    const r = await d.run('df', ['-k', '-P']);
    if (r.code === 0) {
      const disks = parseDfOutput(r.stdout);
      if (disks.length > 0) return disks;
      warnings.push('df không trả về ổ đĩa nào.');
      return [];
    }
    warnings.push('không chạy được df để đo ổ đĩa.');
    return [];
  }
  // Windows: Win32_LogicalDisk (DriveType=3 = ổ local).
  const r = await d.run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json',
  ]);
  if (r.code !== 0) {
    warnings.push('không chạy được Get-CimInstance để đo ổ đĩa trên Windows.');
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const out: DiskInfo[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const size = typeof rec['Size'] === 'number' ? rec['Size'] : Number(rec['Size']);
      const free = typeof rec['FreeSpace'] === 'number' ? rec['FreeSpace'] : Number(rec['FreeSpace']);
      const mount = typeof rec['DeviceID'] === 'string' ? rec['DeviceID'] : '';
      if (!mount || !Number.isFinite(size) || !Number.isFinite(free) || size <= 0) continue;
      out.push({ mount, totalBytes: size, freeBytes: free, freeRatio: free / size });
    }
    if (out.length === 0) warnings.push('không đọc được ổ đĩa nào trên Windows.');
    return out;
  } catch {
    warnings.push('không parse được danh sách ổ đĩa trên Windows.');
    return [];
  }
}

async function probeVirtualization(
  d: ResolvedDeps,
  cpuFlags: string[],
  warnings: string[],
): Promise<VirtualizationInfo> {
  const info: VirtualizationInfo = {
    supported: false,
    kvmAvailable: false,
    hyperVAvailable: false,
    appleVirtualization: false,
    wslAvailable: false,
    detail: 'không rõ hỗ trợ ảo hoá',
  };
  if (d.platform === 'linux') {
    info.supported = cpuFlags.includes('vmx') || cpuFlags.includes('svm');
    info.kvmAvailable = d.fileExists('/dev/kvm');
    const parts: string[] = [];
    if (info.supported) parts.push(cpuFlags.includes('svm') ? 'SVM (AMD)' : 'VMX (Intel)');
    if (info.kvmAvailable) parts.push('KVM (/dev/kvm)');
    if (parts.length === 0) parts.push('CPU không báo flag ảo hoá (vmx/svm)');
    info.detail = parts.join(' + ');
    if (!info.supported) warnings.push('CPU không báo hỗ trợ ảo hoá — mức VM sẽ không khả thi.');
  } else if (d.platform === 'darwin') {
    if (d.arch === 'arm64') {
      info.supported = true;
      info.appleVirtualization = true;
      info.detail = 'Apple Silicon (Virtualization.framework)';
    } else {
      info.supported = cpuFlags.includes('vmx');
      info.appleVirtualization = info.supported;
      info.detail = info.supported
        ? 'VMX (Intel) + Virtualization.framework'
        : 'CPU không báo flag ảo hoá (VMX)';
      if (!info.supported) warnings.push('CPU không báo hỗ trợ ảo hoá — mức VM sẽ không khả thi.');
    }
  } else if (d.platform === 'win32') {
    info.supported = cpuFlags.includes('vmx');
    const hv = await d.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V).State',
    ]);
    if (hv.code === 0) info.hyperVAvailable = /Enabled/i.test(hv.stdout);
    else warnings.push('không kiểm tra được Hyper-V (Get-WindowsOptionalFeature lỗi).');
    const wsl = await d.run('wsl', ['--status']);
    info.wslAvailable = wsl.code === 0;
    const parts: string[] = [];
    if (info.supported) parts.push('ảo hoá firmware bật');
    if (info.hyperVAvailable) parts.push('Hyper-V');
    if (info.wslAvailable) parts.push('WSL2');
    info.detail = parts.length > 0 ? parts.join(' + ') : 'không rõ hỗ trợ ảo hoá trên Windows';
    if (!info.supported && !info.hyperVAvailable && !info.wslAvailable) {
      warnings.push('không thấy Hyper-V/WSL2 — mức VM sẽ không khả thi.');
    }
  }
  return info;
}

async function probeGpus(d: ResolvedDeps, warnings: string[]): Promise<GpuInfo[]> {
  if (d.platform === 'linux') {
    const r = await d.run('lspci', ['-mm']);
    if (r.code !== 0) {
      warnings.push('không đọc được GPU (thiếu lspci hoặc chạy lỗi).');
      return [];
    }
    const out: GpuInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) continue;
      const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      // lspci -mm: "slot" "class" "vendor" "device" ...
      const model = quoted[3] ?? quoted[2] ?? quoted[quoted.length - 1] ?? '';
      if (model) out.push({ model: model.trim(), vendor: quoted[2]?.trim() || undefined });
    }
    return out;
  }
  if (d.platform === 'darwin') {
    const r = await d.run('system_profiler', ['SPDisplaysDataType'], GPU_RUN_TIMEOUT_MS);
    if (r.code !== 0) {
      warnings.push('không đọc được GPU (system_profiler lỗi).');
      return [];
    }
    const out: GpuInfo[] = [];
    for (const m of r.stdout.matchAll(/Chipset Model:\s*(.+)/g)) {
      const model = m[1]?.trim();
      if (model) out.push({ model });
    }
    return out;
  }
  // Windows.
  const r = await d.run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
  ]);
  if (r.code !== 0) {
    warnings.push('không đọc được GPU trên Windows.');
    return [];
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((model) => ({ model }));
}

function probeNetwork(d: ResolvedDeps): NetworkInfo {
  const interfaces: NetworkInfo['interfaces'] = [];
  for (const [name, infos] of Object.entries(d.networkInterfaces)) {
    if (!infos) continue;
    interfaces.push({
      name,
      addresses: infos.map((i) => i.address),
      internal: infos.every((i) => i.internal),
    });
  }
  return { interfaces };
}

/**
 * Dò cấu hình máy thật. Không bao giờ throw vì đo không được — phần
 * nào không đo được thì ghi vào `warnings` và để giá trị rỗng/null.
 */
export async function probeMachine(deps: ProbeDeps = {}): Promise<MachineProfile> {
  const d = resolveDeps(deps);
  const warnings: string[] = [];
  const cpu = await probeCpu(d, warnings);
  const disks = await probeDisks(d, warnings);
  const virtualization = await probeVirtualization(d, cpu.virtualizationFlags, warnings);
  const gpus = await probeGpus(d, warnings);
  const network = probeNetwork(d);
  const totalBytes = d.totalmem;
  const freeBytes = d.freemem;
  return {
    os: d.platform,
    osVersion: d.osVersion,
    arch: d.arch,
    hostname: d.hostname,
    cpu,
    memory: {
      totalBytes,
      freeBytes,
      freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0,
    },
    disks,
    virtualization,
    gpus,
    network,
    probedAt: new Date().toISOString(),
    warnings,
  };
}

/** Tiện ích cho test: dựng MachineProfile giả từ vài con số chính. */
export function fakeMachineProfile(overrides: Partial<MachineProfile> = {}): MachineProfile {
  const base: MachineProfile = {
    os: 'linux',
    osVersion: 'Ubuntu 24.04.1 LTS',
    arch: 'x64',
    hostname: 'test-machine',
    cpu: {
      model: 'Test CPU',
      logicalCores: 8,
      physicalCores: 4,
      speedMhz: 3000,
      virtualizationFlags: ['vmx'],
      loadAvg1m: 1.0,
      loadPerCore: 0.125,
    },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 12 * 1024 ** 3,
      freeRatio: 0.75,
    },
    disks: [{ mount: '/', totalBytes: 500 * 1024 ** 3, freeBytes: 300 * 1024 ** 3, freeRatio: 0.6 }],
    virtualization: {
      supported: true,
      kvmAvailable: true,
      hyperVAvailable: false,
      appleVirtualization: false,
      wslAvailable: false,
      detail: 'VMX (Intel) + KVM (/dev/kvm)',
    },
    gpus: [],
    network: { interfaces: [{ name: 'lo', addresses: ['127.0.0.1'], internal: true }] },
    probedAt: '2026-11-10T00:00:00.000Z',
    warnings: [],
  };
  return {
    ...base,
    ...overrides,
    cpu: { ...base.cpu, ...(overrides.cpu ?? {}) },
    memory: { ...base.memory, ...(overrides.memory ?? {}) },
    virtualization: { ...base.virtualization, ...(overrides.virtualization ?? {}) },
  };
}
