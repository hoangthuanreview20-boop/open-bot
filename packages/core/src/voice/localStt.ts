/**
 * Local streaming STT (v0.95, Đội D3).
 *
 * The realtime transports do speech-to-speech in the cloud; this
 * module is the LOCAL leg: transcribe mic audio on this machine
 * without sending it to a provider. It has two jobs:
 *
 *   1. `detectLocalStt()` — report what is actually installed.
 *      v0.95: nothing — this VM had `espeak-ng` (TTS out) and
 *      `ffmpeg`, but no whisper binary and no whisper model, so the
 *      probe returned `available: false` with the exact reason and
 *      what to install. v0.96 (Đội T5): whisper.cpp was built from
 *      source into `~/tools/whisper.cpp` (cmake, `whisper-cli`
 *      target) with the `ggml-tiny` model in `~/.cache/whisper`,
 *      so the probe now finds it when the build landed; when it
 *      has not (fresh machine, build failed), the probe still
 *      returns `available: false` honestly — see
 *      docs/voice-live-v096.md § "Local STT".
 *   2. `WhisperCliSttEngine` — the engine for a whisper.cpp-style
 *      CLI (`whisper-cpp` / `whisper`), driven argv-only (no shell)
 *      over a temp WAV file (`pcm16ToWav` from voice/dictation.ts).
 *      It is mock-verified only: no whisper binary exists on this
 *      machine, so the CLI flags and the transcript file it reads
 *      back have NOT been live-verified — see
 *      docs/voice-realtime-v095.md § "Live limits". Do not present
 *      this as working until a real binary + model have run it.
 *
 * `MockLocalSttEngine` returns scripted text for tests and for the
 * local-fallback demo path. `LocalSttEngine.transcribe()` is
 * utterance-based (one PCM16 buffer in, one string out), not
 * streaming: true streaming whisper (whisper.cpp `stream` mode) is
 * a follow-up once a binary is actually installed.
 */
import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants as fsConstants, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pcm16ToWav } from './dictation';

/** Default model search paths for a whisper.cpp install. */
export const WHISPER_MODEL_CANDIDATES = [
  'ggml-tiny.en.bin',
  'ggml-tiny.bin',
  'ggml-base.en.bin',
  'ggml-base.bin',
  'ggml-small.en.bin',
  'ggml-small.bin',
];

/** Candidate whisper CLI binaries, in priority order. */
export const WHISPER_BINARY_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];

/** Max audio per local transcription (25 MB PCM16, like dictation). */
export const LOCAL_STT_MAX_BYTES = 25 * 1024 * 1024;
/** Timeout for one local transcription (ms). */
export const LOCAL_STT_TIMEOUT_MS = 120_000;

export interface LocalSttStatus {
  available: boolean;
  /** Engine id when available (`whisper-cli`), else null. */
  engineId: string | null;
  /** Whisper binary path when found, else null. */
  binaryPath: string | null;
  /** Model file path when found, else null. */
  modelPath: string | null;
  /** Human-readable reason when unavailable. */
  reason?: string;
}

export interface LocalSttTranscribeOptions {
  /** Sample rate of the PCM16 audio (Hz). Default 16000. */
  sampleRateHz?: number;
  /** BCP-47 language hint, e.g. "vi". Default "en" for whisper.cpp. */
  language?: string;
  /** Timeout (ms). Default 120_000. */
  timeoutMs?: number;
  /**
   * Threads for the whisper encoder (v0.98 — `-t N`). Default: the
   * machine's available CPUs, capped at 4. Measured on this
   * 1.5-CPU VM: the binary's own default (4 threads) took ~77 s
   * for 0.84 s of audio, while 2 threads took ~22–38 s — the
   * extra threads only thrash on a throttled CPU. Callers that
   * measured a better value pass it explicitly. Ignored when <= 0.
   */
  threads?: number;
  /**
   * Translate to English instead of transcribing in-language
   * (v0.98 — `-tr`). Default false.
   */
  translate?: boolean;
}

/** One whisper segment with word-level timing (from `-ojf` JSON). */
export interface WhisperSegment {
  /** Segment start (ms). */
  startMs: number;
  /** Segment end (ms). */
  endMs: number;
  /** Segment text (trimmed). */
  text: string;
}

/** Detailed transcription: text + timed segments + wall time. */
export interface WhisperDetailedResult {
  /** Full transcript (segments joined with spaces, trimmed). */
  text: string;
  /** Timed segments (empty when the engine heard nothing). */
  segments: WhisperSegment[];
  /** Wall-clock time the engine took (ms). */
  durationMs: number;
}

/** Default whisper threads: effective CPUs, capped at 4 (v0.98 —
 *  the binary's own default of 4 thrashes on a throttled 1.5-CPU
 *  VM — measured ~77 s vs ~22–38 s with 2 threads for 0.84 s of
 *  audio). "Effective" means the cgroup CPU quota when present
 *  (`availableParallelism()` reports the host's 4 CPUs here while
 *  the cgroup only allows 1.5), else `availableParallelism()`.
 *  Exported for tests. */
let cachedDefaultWhisperThreads: number | null = null;

export function defaultWhisperThreads(): number {
  if (cachedDefaultWhisperThreads !== null) return cachedDefaultWhisperThreads;
  let effective: number | null = null;
  try {
    // cgroup v2: /sys/fs/cgroup/cpu.max — "max" or "<quota> <period>".
    try {
      const cpuMax = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
      if (cpuMax[0] !== 'max' && cpuMax.length === 2) {
        const quota = Number(cpuMax[0]);
        const period = Number(cpuMax[1]);
        if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0) {
          effective = quota / period;
        }
      }
    } catch {
      // Not cgroup v2 — try v1 below.
    }
    if (effective === null) {
      // cgroup v1: cpu.cfs_quota_us / cpu.cfs_period_us.
      try {
        const quota = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
        const period = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
        if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0) {
          effective = quota / period;
        }
      } catch {
        // No cgroup quota visible.
      }
    }
  } catch {
    // fs unavailable — fall through to availableParallelism.
  }
  if (effective === null) {
    try {
      const cpus = (globalThis as { process?: { availableParallelism?: () => number } }).process
        ?.availableParallelism?.();
      if (typeof cpus === 'number' && cpus > 0) effective = cpus;
    } catch {
      // Fall through to 2.
    }
  }
  cachedDefaultWhisperThreads = Math.min(4, Math.max(1, Math.round(effective ?? 2)));
  return cachedDefaultWhisperThreads;
}

/** Parse a whisper timestamp "HH:MM:SS,mmm" (or "MM:SS.mmm") to ms. */
export function parseWhisperTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number((m[4] as string).padEnd(3, '0'));
  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** One local STT engine. */
export interface LocalSttEngine {
  readonly id: string;
  /** True when this engine can transcribe on this machine. */
  isAvailable(): boolean;
  /** Human-readable status (binary / model / reason). */
  status(): LocalSttStatus;
  /** Transcribe one PCM16 buffer. Throws when unavailable. */
  transcribe(pcm16: Uint8Array, opts?: LocalSttTranscribeOptions): Promise<string>;
}

function findOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here — keep looking.
    }
  }
  return null;
}

function findModelFile(): string | null {
  const roots = [
    process.env.WHISPER_MODEL ?? '',
    path.join(process.env.HOME ?? '', '.cache', 'whisper'),
    path.join(process.env.HOME ?? '', 'tools', 'whisper'),
    '/usr/share/whisper',
    '/usr/local/share/whisper',
  ];
  for (const root of roots) {
    if (!root) continue;
    for (const name of WHISPER_MODEL_CANDIDATES) {
      const candidate = path.join(root, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

/** Runner type for the whisper child process (injectable in tests). */
export type WhisperRunner = (
  binaryPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

function defaultWhisperRunner(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child;
    try {
      child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/**
 * whisper.cpp-style CLI engine. `transcribe()` writes the PCM16 as a
 * temp WAV, runs `<binary> -m <model> -f <wav> -l <lang> -otxt
 * -of <out-prefix>`, and reads back `<out-prefix>.txt`.
 *
 * NOT live-verified: no whisper binary or model exists on this
 * machine, so these flags are the documented whisper.cpp CLI shape
 * only. If the binary on a user's machine uses different flags,
 * this engine fails loudly (non-zero exit / missing .txt) instead
 * of returning a guessed transcript.
 */
export class WhisperCliSttEngine implements LocalSttEngine {
  readonly id = 'whisper-cli';
  private readonly binaryPath: string | null;
  private readonly modelPath: string | null;
  private readonly runner: WhisperRunner;

  constructor(options: { runner?: WhisperRunner } = {}) {
    this.runner = options.runner ?? defaultWhisperRunner;
    let binary: string | null = null;
    for (const name of WHISPER_BINARY_CANDIDATES) {
      binary = findOnPath(name);
      if (binary) break;
    }
    if (!binary) {
      // Known install locations (v0.96: whisper.cpp built from
      // source into ~/tools — see docs/voice-live-v096.md), plus an
      // explicit WHISPER_BINARY override. PATH alone misses them.
      const extra = [
        process.env.WHISPER_BINARY ?? '',
        path.join(process.env.HOME ?? '', 'tools', 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
        path.join(process.env.HOME ?? '', 'tools', 'whisper.cpp', 'build', 'bin', 'main'),
        '/usr/local/bin/whisper-cli',
      ];
      for (const candidate of extra) {
        if (!candidate) continue;
        try {
          if (existsSync(candidate)) {
            accessSync(candidate, fsConstants.X_OK);
            binary = candidate;
            break;
          }
        } catch {
          // Not executable here — keep looking.
        }
      }
    }
    this.binaryPath = binary;
    this.modelPath = binary ? findModelFile() : null;
  }

  isAvailable(): boolean {
    return this.binaryPath !== null && this.modelPath !== null;
  }

  status(): LocalSttStatus {
    if (!this.binaryPath) {
      return {
        available: false,
        engineId: null,
        binaryPath: null,
        modelPath: null,
        reason:
          'No whisper CLI found (looked for whisper-cpp / whisper / main on PATH). Install whisper.cpp to enable local STT.',
      };
    }
    if (!this.modelPath) {
      return {
        available: false,
        engineId: null,
        binaryPath: this.binaryPath,
        modelPath: null,
        reason:
          'Whisper CLI found but no model file (ggml-*.bin) — download a whisper.cpp model first.',
      };
    }
    return {
      available: true,
      engineId: this.id,
      binaryPath: this.binaryPath,
      modelPath: this.modelPath,
    };
  }

  async transcribe(pcm16: Uint8Array, opts: LocalSttTranscribeOptions = {}): Promise<string> {
    const { text } = await this.transcribeDetailed(pcm16, opts);
    return text;
  }

  /**
   * Transcribe with word-level timing (v0.98): runs whisper with
   * `-ojf` (JSON-full output) and returns the text plus timed
   * segments. `transcribe()` is this method's text only. The JSON
   * shape is `{ transcription: [{ timestamps: { from, to },
   * text }] }`; a missing/unparseable JSON falls back to the
   * plain `-otxt` file (text without segments) instead of failing
   * — timing is best-effort, the transcript is not.
   */
  async transcribeDetailed(
    pcm16: Uint8Array,
    opts: LocalSttTranscribeOptions = {},
  ): Promise<WhisperDetailedResult> {
    if (!this.isAvailable() || !this.binaryPath || !this.modelPath) {
      throw new Error(`LocalSttEngine: ${this.status().reason ?? 'local STT unavailable.'}`);
    }
    if (!(pcm16 instanceof Uint8Array) || pcm16.length === 0 || pcm16.length % 2 !== 0) {
      throw new Error('LocalSttEngine: audio must be a non-empty even-length PCM16 buffer.');
    }
    if (pcm16.length > LOCAL_STT_MAX_BYTES) {
      throw new Error('LocalSttEngine: audio too large (max 25 MB PCM16).');
    }
    const sampleRateHz = opts.sampleRateHz ?? 16_000;
    const language = opts.language ?? 'en';
    const timeoutMs = opts.timeoutMs ?? LOCAL_STT_TIMEOUT_MS;
    const started = Date.now();
    const dir = mkdtempSync(path.join(tmpdir(), 'open-bot-stt-'));
    try {
      const wavPath = path.join(dir, 'audio.wav');
      const outPrefix = path.join(dir, 'out');
      writeFileSync(wavPath, pcm16ToWav(pcm16, sampleRateHz));
      const extraArgs: string[] = ['-m', this.modelPath, '-f', wavPath, '-l', language];
      // Threads: explicit opt wins, else the CPU-adapted default
      // (v0.98 — the binary's default of 4 thrashes on this VM).
      const threads =
        typeof opts.threads === 'number' && opts.threads > 0
          ? Math.floor(opts.threads)
          : defaultWhisperThreads();
      extraArgs.push('-t', String(threads));
      if (opts.translate) extraArgs.push('-tr');
      // JSON-full (segments + timestamps) AND plain text: the text
      // file is the fallback when the JSON cannot be parsed.
      const { code, stderr } = await this.runner(
        this.binaryPath,
        [...extraArgs, '-ojf', '-otxt', '-of', outPrefix],
        timeoutMs,
      );
      if (code !== 0) {
        throw new Error(
          `LocalSttEngine: whisper exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
        );
      }
      const txtPath = `${outPrefix}.txt`;
      if (!existsSync(txtPath)) {
        throw new Error('LocalSttEngine: whisper produced no transcript file.');
      }
      const text = readFileSync(txtPath, 'utf8').trim();
      const segments = this.readSegments(`${outPrefix}.json`);
      return { text, segments, durationMs: Date.now() - started };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Temp dir cleanup is best-effort.
      }
    }
  }

  /** Read timed segments from a whisper `-ojf` JSON file (best-effort). */
  private readSegments(jsonPath: string): WhisperSegment[] {
    try {
      if (!existsSync(jsonPath)) return [];
      const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const list =
        parsed && typeof parsed === 'object'
          ? (parsed as { transcription?: unknown }).transcription
          : undefined;
      if (!Array.isArray(list)) return [];
      const segments: WhisperSegment[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as { timestamps?: { from?: unknown; to?: unknown }; text?: unknown };
        const startMs = parseWhisperTimestamp(rec.timestamps?.from);
        const endMs = parseWhisperTimestamp(rec.timestamps?.to);
        const text = typeof rec.text === 'string' ? rec.text.trim() : '';
        if (startMs === null || endMs === null || !text) continue;
        segments.push({ startMs, endMs, text });
      }
      return segments;
    } catch {
      return [];
    }
  }
}

/**
 * Scripted engine for tests / demos. Returns the scripted lines in
 * order (last line repeats); `isAvailable()` is always true.
 */
export class MockLocalSttEngine implements LocalSttEngine {
  readonly id = 'mock-stt';
  private index = 0;
  /** Transcripts returned, in order. */
  readonly calls: Uint8Array[] = [];

  constructor(private readonly script: string[] = ['hello world']) {
    if (script.length === 0) this.script = ['hello world'];
  }

  isAvailable(): boolean {
    return true;
  }

  status(): LocalSttStatus {
    return { available: true, engineId: this.id, binaryPath: null, modelPath: null };
  }

  async transcribe(pcm16: Uint8Array): Promise<string> {
    if (!(pcm16 instanceof Uint8Array) || pcm16.length === 0) {
      throw new Error('MockLocalSttEngine: audio must be a non-empty PCM16 buffer.');
    }
    this.calls.push(new Uint8Array(pcm16));
    const text = this.script[Math.min(this.index, this.script.length - 1)] ?? '';
    this.index += 1;
    return text;
  }
}

/**
 * Probe this machine for local STT. Today this returns the
 * whisper-cli engine with `available: false` (no binary, no model
 * on this VM) — the caller should fall back to provider STT
 * (voice/dictation.ts) and say so in the UI, not silently fail.
 */
export function detectLocalStt(): LocalSttEngine {
  return new WhisperCliSttEngine();
}
