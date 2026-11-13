/**
 * Local streaming STT (v0.95, Đội D3).
 *
 * The realtime transports do speech-to-speech in the cloud; this
 * module is the LOCAL leg: transcribe mic audio on this machine
 * without sending it to a provider. It has two jobs:
 *
 *   1. `detectLocalStt()` — report what is actually installed.
 *      Today that is nothing: this VM has `espeak-ng` (TTS out) and
 *      `ffmpeg`, but no whisper binary and no whisper model, so the
 *      probe returns `available: false` with the exact reason and
 *      what to install. The interface is ready for the day a
 *      whisper build lands; the session does not pretend otherwise.
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
  'ggml-base.en.bin',
  'ggml-base.bin',
  'ggml-small.en.bin',
  'ggml-small.bin',
];

/** Candidate whisper CLI binaries, in priority order. */
export const WHISPER_BINARY_CANDIDATES = ['whisper-cpp', 'whisper', 'main'];

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
    const dir = mkdtempSync(path.join(tmpdir(), 'open-bot-stt-'));
    try {
      const wavPath = path.join(dir, 'audio.wav');
      const outPrefix = path.join(dir, 'out');
      writeFileSync(wavPath, pcm16ToWav(pcm16, sampleRateHz));
      const { code, stderr } = await this.runner(
        this.binaryPath,
        ['-m', this.modelPath, '-f', wavPath, '-l', language, '-otxt', '-of', outPrefix],
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
      return readFileSync(txtPath, 'utf8').trim();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Temp dir cleanup is best-effort.
      }
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
