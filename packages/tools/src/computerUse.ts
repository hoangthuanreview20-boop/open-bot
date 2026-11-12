/**
 * Computer-use tools for @open-bot/tools (v0.6).
 *
 * Control the local Linux desktop like a user — screenshot, screen
 * recording, mouse and keyboard — via ImageMagick (`import`/`convert`),
 * ffmpeg (x11grab) and xdotool. Linux + X11 only; every tool requires a
 * running X display (DISPLAY set, e.g. under `xvfb-run` in tests).
 *
 * Safety rules:
 *  - Every external command is spawned directly with an argv array —
 *    never through a shell string — with a hard timeout per operation
 *    and truncated output.
 *  - Child processes inherit only a safe env allowlist (see sandbox
 *    safeEnv) plus DISPLAY / XAUTHORITY, so no secrets leak.
 *  - All output files (screenshots, recordings) are confined to the
 *    agent workspace via resolveWithin().
 *  - Screenshot is read-only (needsApproval: false). Recording, mouse
 *    and keyboard all need approval (needsApproval: true).
 *  - `computer_screenshot` captures the whole screen by default, or one
 *    window when `window` is given: the window is resolved with
 *    `xdotool search --name <title>` (or verified with
 *    `xdotool getwindowname <id>` for a numeric/hex window id) and
 *    captured with `import -window <id>`. Fail-closed: no match or
 *    several matches is a clear error, never a guessed window.
 *  - `computer_type` must NEVER be used to type passwords, secrets or
 *    API keys: its description says so, and the tool refuses strings
 *    that look like long random tokens (best-effort heuristic).
 *  - Recordings are capped by duration (default 10 minutes) and file
 *    size (default 200 MB); the recorder auto-stops at either limit.
 *
 * Exported as COMPUTER_USE_TOOLS (defaults) + createComputerUseTools()
 * (overridable recording defaults), mirroring CODE_TOOLS in codeTools.ts.
 * The coordinator wires them into the registry; this module registers
 * nothing itself.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '@open-bot/core';
import { MAX_OUTPUT_CHARS, resolveWithin, safeEnv } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

const SCREENSHOT_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 10_000;
const RECORD_READY_WAIT_MS = 1_000;
const RECORD_STOP_TIMEOUT_MS = 10_000;
const RECORD_KILL_GRACE_MS = 5_000;
const MAX_THUMBNAIL_BYTES = 200_000;
const MAX_TYPE_CHARS = 1_000;
const DEFAULT_MAX_RECORD_SECONDS = 600; // 10 minutes
const MIN_MAX_RECORD_SECONDS = 5;
const MAX_MAX_RECORD_SECONDS = 600;
const DEFAULT_MAX_RECORD_MB = 200;
const MIN_MAX_RECORD_MB = 10;
const MAX_MAX_RECORD_MB = 500;
const RECORD_WATCHDOG_MS = 5_000;

/** Max chars kept from any one child-process output stream. */
const MAX_PROC_OUTPUT_CHARS = 50_000;


function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Env for X11 child processes: safe allowlist + DISPLAY / XAUTHORITY. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...safeEnv() };
  if (process.env['DISPLAY']) env['DISPLAY'] = process.env['DISPLAY'];
  if (process.env['XAUTHORITY']) env['XAUTHORITY'] = process.env['XAUTHORITY'];
  return env;
}

/** The X display in use, or a clear error when there is none.
 *  Computer-use chỉ chạy trên Linux + X11: trên Windows/macOS không có
 *  X display nên báo rõ là tính năng chưa hỗ trợ trên OS đó, thay vì
 *  khuyên chạy dưới xvfb-run (không tồn tại trên Windows/macOS). */
function requireDisplay(): string {
  const display = process.env['DISPLAY'];
  if (!display) {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      throw new Error(
        'Computer-use is only available on Linux with an X11 display: ' +
          'it needs xdotool / ImageMagick under X, which do not exist on ' +
          'Windows/macOS. (Tính năng điều khiển màn hình/chuột/bàn phím ' +
          'chỉ hỗ trợ trên Linux + X11.)',
      );
    }
    throw new Error(
      'No X display available: the DISPLAY environment variable is not set. ' +
        'Computer-use tools need a running X11 display (e.g. run the bot under xvfb-run on a headless machine).',
    );
  }
  return display;
}

interface ProcResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

const BINARY_HINTS: Record<string, string> = {
  import: 'ImageMagick (`import`)',
  convert: 'ImageMagick (`convert`)',
  identify: 'ImageMagick (`identify`)',
  ffmpeg: 'ffmpeg',
  xdotool: 'xdotool',
};

/**
 * Spawn a command directly with an argv array (no shell), with a hard
 * timeout. stdout is returned as a Buffer (screenshots/thumbnails are
 * binary); stderr as truncated text.
 */
function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolvePromise, rejectPromise) => {
    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      env: childEnv(),
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return rejectPromise(new Error('Operation aborted before it started.'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_PROC_OUTPUT_CHARS) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_PROC_OUTPUT_CHARS) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const hint = BINARY_HINTS[command] ?? `\`${command}\``;
      rejectPromise(
        new Error(
          `Failed to run ${hint}: ${(err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `binary not found — is ${hint} installed and on PATH?`
            : err.message}`,
        ),
      );
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) stderr += `\n[process killed after ${timeoutMs}ms timeout]`;
      resolvePromise({
        code: timedOut ? null : code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: truncate(stderr, MAX_PROC_OUTPUT_CHARS),
        timedOut,
      });
    });
  });
}

/** Screen size via `xdotool getdisplaygeometry` ("<width> <height>"). */
export async function getDisplayGeometry(
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  requireDisplay();
  const result = await runProcess('xdotool', ['getdisplaygeometry'], CONTROL_TIMEOUT_MS, signal);
  if (result.code !== 0) {
    throw new Error(
      `xdotool getdisplaygeometry failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`,
    );
  }
  const match = result.stdout.toString('utf8').trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    throw new Error(
      `Could not parse screen size from xdotool output: "${result.stdout.toString('utf8').trim()}"`,
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Parse PNG width/height from the IHDR chunk (no extra dependency). */
export function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG signature + IHDR chunk header.
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Build a small JPEG thumbnail (base64) of a PNG, capped at ~200 KB. */
async function makeThumbnail(pngPath: string, signal?: AbortSignal): Promise<string | null> {
  // Try 640px wide first, then 320px if still too big.
  for (const width of [640, 320]) {
    const result = await runProcess(
      'convert',
      [pngPath, '-resize', `${width}x>`, '-quality', '82', 'jpg:-'],
      SCREENSHOT_TIMEOUT_MS,
      signal,
    );
    if (result.code !== 0 || result.stdout.length === 0) continue;
    if (result.stdout.length <= MAX_THUMBNAIL_BYTES) {
      return result.stdout.toString('base64');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/** A window selector that is a raw X window id: decimal or 0x-hex. */
const WINDOW_ID_RE = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

/** Escape a literal title so xdotool search --name treats it as text, not a regex. */
export function escapeWindowSearchPattern(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a `computer_screenshot` window selector to one X window id.
 *
 * - A decimal / 0x-hex id is verified with `xdotool getwindowname <id>`.
 * - Anything else is a window title (literal substring): resolved with
 *   `xdotool search --name <title>`.
 *
 * Fail-closed: no match, several matches, an unknown id, or any xdotool
 * failure throws a clear error — the caller must never guess a window.
 * Exported so tests can exercise resolution without taking a screenshot.
 */
export async function resolveWindow(
  query: string,
  signal?: AbortSignal,
): Promise<string> {
  const selector = query.trim();
  if (selector === '') {
    throw new Error('Window selector must not be empty: give a window title or a window id.');
  }
  requireDisplay();
  if (WINDOW_ID_RE.test(selector)) {
    const check = await runProcess(
      'xdotool',
      ['getwindowname', selector],
      CONTROL_TIMEOUT_MS,
      signal,
    );
    if (check.code !== 0) {
      throw new Error(
        `No window with id "${selector}": xdotool getwindowname failed (exit ${check.code}): ${check.stderr.trim() || 'no output'}`,
      );
    }
    return selector;
  }
  const result = await runProcess(
    'xdotool',
    ['search', '--name', escapeWindowSearchPattern(selector)],
    CONTROL_TIMEOUT_MS,
    signal,
  );
  const ids = result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (result.code !== 0) {
    // xdotool search exits 1 with empty output when nothing matches.
    if (result.code === 1 && ids.length === 0) {
      throw new Error(
        `No window matching "${selector}" was found on this display. Check the window title (or pass its window id).`,
      );
    }
    throw new Error(
      `xdotool search for window "${selector}" failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`,
    );
  }
  if (ids.length === 0) {
    throw new Error(
      `No window matching "${selector}" was found on this display. Check the window title (or pass its window id).`,
    );
  }
  if (ids.length > 1) {
    const shown = ids.slice(0, 5).join(', ');
    const more = ids.length > 5 ? ` (and ${ids.length - 5} more)` : '';
    throw new Error(
      `Multiple windows (${ids.length}) match "${selector}": ${shown}${more}. ` +
        'Refine the title or pass a single window id instead — refusing to pick one at random.',
    );
  }
  return ids[0] as string;
}

function makeScreenshotTool(): Tool {
  return {
    definition: {
      name: 'computer_screenshot',
      description:
        'Take a screenshot of the whole X11 screen (ImageMagick `import -window root`) and save it as a PNG inside the workspace. Pass `window` (a window title, or a window id such as "12345678" / "0x1a00007") to capture just that one window instead (`import -window <id>`); no match or several matching windows is an error, never a guessed window. Read-only. Returns the file path, screen/window size, file size and a small base64 JPEG thumbnail (max ~200 KB). Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Optional file name for the PNG (default: screenshot-<timestamp>-<id>.png). Saved under computer-use/screenshots/ in the workspace.',
          },
          window: {
            type: 'string',
            description:
              'Optional window to capture instead of the whole screen: a window title (matched literally, e.g. "Firefox") or a window id (decimal, e.g. "12345678", or hex, e.g. "0x1a00007"). Omit or leave empty for the full screen. Fails with a clear error when no window matches or several do.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        requireDisplay();
        const rawName = args['filename'] === undefined ? '' : getStringArg(args, 'filename', false);
        const rawWindow = args['window'] === undefined ? '' : getStringArg(args, 'window', false);
        const windowQuery = rawWindow.trim();
        // Resolve BEFORE creating the output file: a bad selector must
        // fail without leaving an empty/partial screenshot behind.
        const windowId = windowQuery === '' ? 'root' : await resolveWindow(windowQuery, ctx.signal);
        const filename =
          rawName.trim() === ''
            ? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`
            : rawName.endsWith('.png')
              ? rawName
              : `${rawName}.png`;
        const relPath = path.posix.join('computer-use', 'screenshots', filename);
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const result = await runProcess(
          'import',
          ['-window', windowId, fullPath],
          SCREENSHOT_TIMEOUT_MS,
          ctx.signal,
        );
        if (result.code !== 0) {
          throw new Error(
            `Screenshot failed (import exit ${result.code}): ${result.stderr.trim() || 'no output'}`,
          );
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          throw new Error('Screenshot failed: ImageMagick reported success but no PNG file was created.');
        }
        if (stat.size === 0) throw new Error('Screenshot failed: the PNG file is empty.');
        const dims = parsePngDimensions(fs.readFileSync(fullPath).subarray(0, 24));
        const thumbnail = await makeThumbnail(fullPath, ctx.signal).catch(() => null);
        return truncate(
          JSON.stringify({
            ok: true,
            path: relPath,
            window: windowQuery === '' ? null : windowQuery,
            windowId,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            sizeBytes: stat.size,
            thumbnailBase64: thumbnail,
            thumbnailNote:
              thumbnail === null
                ? 'Thumbnail unavailable (conversion failed or still over 200 KB at 320px).'
                : undefined,
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Screen recording (ffmpeg x11grab)
// ---------------------------------------------------------------------------

export interface ComputerUseOptions {
  /** Default max recording length in seconds (5–600, default 600). */
  defaultMaxDurationSeconds?: number;
  /** Default max recording file size in MB (10–500, default 200). */
  defaultMaxFileSizeMB?: number;
}

interface RecordingInfo {
  recordingId: string;
  path: string;
  durationSeconds: number;
  sizeBytes: number;
  status: 'recording' | 'stopped' | 'auto-stopped';
  stopReason?: string;
}

interface ActiveRecording {
  id: string;
  relPath: string;
  fullPath: string;
  proc: ChildProcess;
  startedAt: number;
  maxDurationMs: number;
  maxBytes: number;
  timer: NodeJS.Timeout;
  watchdog: NodeJS.Timeout;
  stderrTail: string;
  finished: boolean;
  finishReason?: string;
  finishedAt?: number;
  exitCode?: number | null;
  finalizePromise?: Promise<RecordingInfo>;
}

/** Normalize a DISPLAY value (":99", ":99.0") to an ffmpeg x11grab input (":99.0+0,0"). */
export function displayToX11GrabInput(display: string): string {
  const match = display.match(/^:?(\d+)(?:\.(\d+))?$/);
  const num = match ? match[1] : '0';
  const screen = match?.[2] ?? '0';
  return `:${num}.${screen}+0,0`;
}

function recordingInfo(entry: ActiveRecording): RecordingInfo {
  const finishedAt = entry.finishedAt ?? Date.now();
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(entry.fullPath).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    recordingId: entry.id,
    path: entry.relPath,
    durationSeconds: Math.round(((finishedAt - entry.startedAt) / 1000) * 10) / 10,
    sizeBytes,
    status: entry.finished
      ? entry.finishReason === 'stopped'
        ? 'stopped'
        : 'auto-stopped'
      : 'recording',
    stopReason: entry.finishReason,
  };
}

/**
 * Gracefully stop an ffmpeg recording: SIGINT (lets ffmpeg finalize the
 * file), SIGKILL after a grace period. Idempotent — concurrent callers
 * share one finalize promise.
 */
function finalizeRecording(entry: ActiveRecording, reason: string): Promise<RecordingInfo> {
  if (entry.finalizePromise) return entry.finalizePromise;
  entry.finalizePromise = new Promise<RecordingInfo>((resolvePromise) => {
    clearTimeout(entry.timer);
    clearInterval(entry.watchdog);
    entry.finished = true;
    entry.finishReason = reason;
    const done = (): void => {
      entry.finishedAt = Date.now();
      resolvePromise(recordingInfo(entry));
    };
    if (entry.proc.exitCode !== null && entry.proc.exitCode !== undefined) {
      done();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }, RECORD_KILL_GRACE_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    entry.proc.once('close', () => {
      clearTimeout(killTimer);
      done();
    });
    try {
      entry.proc.kill('SIGINT');
    } catch {
      done();
    }
    // Safety net: never hang the caller longer than the stop timeout.
    const hardTimer = setTimeout(() => {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      done();
    }, RECORD_STOP_TIMEOUT_MS);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
  });
  return entry.finalizePromise;
}

function makeRecordStartTool(
  recordings: Map<string, ActiveRecording>,
  defaults: Required<ComputerUseOptions>,
): Tool {
  return {
    definition: {
      name: 'computer_record_start',
      description:
        'Start recording the X11 screen to a video file (ffmpeg x11grab, H.264/webm) inside the workspace. Returns a recordingId — pass it to computer_record_stop. Recording auto-stops at the duration limit (default 10 minutes) or the file-size limit (default 200 MB). Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description:
              'Optional file name (default: recording-<timestamp>-<id>.mp4). Saved under computer-use/recordings/ in the workspace.',
          },
          maxDurationSeconds: {
            type: 'number',
            description: `Max recording length in seconds (5–${MAX_MAX_RECORD_SECONDS}, default ${defaults.defaultMaxDurationSeconds}). Recording auto-stops at this limit.`,
          },
          maxFileSizeMB: {
            type: 'number',
            description: `Max recording file size in MB (10–${MAX_MAX_RECORD_MB}, default ${defaults.defaultMaxFileSizeMB}). Recording auto-stops at this limit.`,
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const display = requireDisplay();
        const maxDurationSeconds = Math.round(
          getNumberArg(args, 'maxDurationSeconds') ?? defaults.defaultMaxDurationSeconds,
        );
        if (maxDurationSeconds < MIN_MAX_RECORD_SECONDS || maxDurationSeconds > MAX_MAX_RECORD_SECONDS) {
          return errorResult(
            `maxDurationSeconds must be between ${MIN_MAX_RECORD_SECONDS} and ${MAX_MAX_RECORD_SECONDS}, got ${maxDurationSeconds}.`,
          );
        }
        const maxFileSizeMB = Math.round(
          getNumberArg(args, 'maxFileSizeMB') ?? defaults.defaultMaxFileSizeMB,
        );
        if (maxFileSizeMB < MIN_MAX_RECORD_MB || maxFileSizeMB > MAX_MAX_RECORD_MB) {
          return errorResult(
            `maxFileSizeMB must be between ${MIN_MAX_RECORD_MB} and ${MAX_MAX_RECORD_MB}, got ${maxFileSizeMB}.`,
          );
        }
        const geometry = await getDisplayGeometry(ctx.signal);
        const rawName = args['filename'] === undefined ? '' : getStringArg(args, 'filename', false);
        const filename =
          rawName.trim() === ''
            ? `recording-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.mp4`
            : rawName.endsWith('.mp4') || rawName.endsWith('.webm')
              ? rawName
              : `${rawName}.mp4`;
        const relPath = path.posix.join('computer-use', 'recordings', filename);
        const fullPath = resolveWithin(ctx.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });

        const recordingId = randomUUID();
        const proc = spawn(
          'ffmpeg',
          [
            '-y',
            '-f', 'x11grab',
            '-video_size', `${geometry.width}x${geometry.height}`,
            '-framerate', '15',
            '-i', displayToX11GrabInput(display),
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'veryfast',
            '-crf', '28',
            fullPath,
          ],
          { env: childEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const entry: ActiveRecording = {
          id: recordingId,
          relPath,
          fullPath,
          proc,
          startedAt: Date.now(),
          maxDurationMs: maxDurationSeconds * 1000,
          maxBytes: maxFileSizeMB * 1024 * 1024,
          timer: setTimeout(() => undefined, 0),
          watchdog: setInterval(() => undefined, 0),
          stderrTail: '',
          finished: false,
        };
        clearTimeout(entry.timer);
        clearInterval(entry.watchdog);
        recordings.set(recordingId, entry);

        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          entry.stderrTail = (entry.stderrTail + text).slice(-2000);
        });
        proc.on('error', (err: Error) => {
          entry.finished = true;
          entry.finishReason = `spawn-failed: ${(err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'ffmpeg binary not found — is ffmpeg installed and on PATH?'
            : err.message}`;
          entry.finishedAt = Date.now();
          recordings.delete(recordingId);
        });
        proc.on('close', (code: number | null) => {
          entry.exitCode = code;
          if (!entry.finished) {
            entry.finished = true;
            entry.finishReason = `ffmpeg exited unexpectedly (code ${code}): ${entry.stderrTail.trim().slice(-500) || 'no output'}`;
            entry.finishedAt = Date.now();
          }
          clearTimeout(entry.timer);
          clearInterval(entry.watchdog);
        });

        entry.timer = setTimeout(() => {
          void finalizeRecording(entry, 'max-duration').catch(() => undefined);
        }, entry.maxDurationMs);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        entry.watchdog = setInterval(() => {
          try {
            if (fs.statSync(fullPath).size >= entry.maxBytes) {
              void finalizeRecording(entry, 'max-file-size').catch(() => undefined);
            }
          } catch {
            // File not created yet; ignore.
          }
        }, RECORD_WATCHDOG_MS);
        if (typeof entry.watchdog.unref === 'function') entry.watchdog.unref();

        // Wait briefly: if ffmpeg dies immediately (bad display, no
        // codec, ...) report the error instead of a bogus recordingId.
        await new Promise<void>((resolvePromise) => {
          if (entry.finished) {
            resolvePromise();
            return;
          }
          const timer = setTimeout(() => resolvePromise(), RECORD_READY_WAIT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          proc.once('close', () => {
            clearTimeout(timer);
            resolvePromise();
          });
        });
        if (entry.finished && entry.finishReason?.startsWith('spawn-failed')) {
          recordings.delete(recordingId);
          return errorResult(entry.finishReason.replace(/^spawn-failed: /, ''));
        }
        if (entry.finished) {
          recordings.delete(recordingId);
          return errorResult(`Recording failed to start: ${entry.finishReason ?? 'ffmpeg exited'}`);
        }
        return truncate(
          JSON.stringify({
            ok: true,
            recordingId,
            path: relPath,
            width: geometry.width,
            height: geometry.height,
            maxDurationSeconds,
            maxFileSizeMB,
            status: 'recording',
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeRecordStopTool(recordings: Map<string, ActiveRecording>): Tool {
  return {
    definition: {
      name: 'computer_record_stop',
      description:
        'Stop a screen recording started by computer_record_start. Returns the video file path, duration in seconds and file size. If the recording already auto-stopped (duration or file-size limit), returns its final info instead of an error.',
      parameters: {
        type: 'object',
        properties: {
          recordingId: {
            type: 'string',
            description: 'The recordingId returned by computer_record_start.',
          },
        },
        required: ['recordingId'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const recordingId = getStringArg(args, 'recordingId');
        const entry = recordings.get(recordingId);
        if (!entry) {
          return errorResult(
            `Unknown recordingId "${recordingId}": no such active recording (it may already have been stopped).`,
          );
        }
        const info = await finalizeRecording(entry, 'stopped');
        recordings.delete(recordingId);
        if (info.sizeBytes === 0) {
          return errorResult(
            `Recording "${recordingId}" stopped but the video file is empty or missing (${info.path}). ffmpeg said: ${entry.stderrTail.trim().slice(-500) || 'no output'}`,
          );
        }
        return truncate(JSON.stringify({ ok: true, ...info }));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mouse / keyboard (xdotool)
// ---------------------------------------------------------------------------

/** Keys xdotool accepts, as '+'-separated tokens (e.g. "ctrl+alt+t"). */
export const ALLOWED_KEY_TOKENS = new Set<string>([
  'ctrl', 'control', 'alt', 'shift', 'super', 'meta', 'hyper',
  'Return', 'Tab', 'Escape', 'space', 'BackSpace', 'Delete', 'Insert',
  'Home', 'End', 'Page_Up', 'Page_Down', 'Up', 'Down', 'Left', 'Right',
  'Caps_Lock', 'Num_Lock', 'Scroll_Lock', 'Print', 'Pause', 'Menu',
  'KP_Enter', 'KP_0', 'KP_1', 'KP_2', 'KP_3', 'KP_4', 'KP_5', 'KP_6',
  'KP_7', 'KP_8', 'KP_9',
  'minus', 'equal', 'bracketleft', 'bracketright', 'semicolon',
  'apostrophe', 'comma', 'period', 'slash', 'backslash', 'grave', 'plus',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

const SINGLE_CHAR_KEY_RE = /^[a-zA-Z0-9!@#$%^*()_\-=\[\];:'",.<>\/?\\`~]$/;

/** Validate an xdotool key spec; throws with a clear message when invalid. */
export function validateKeySpec(spec: string): void {
  if (spec.length === 0 || spec.length > 64) {
    throw new Error(`Key spec must be 1–64 characters, got ${spec.length}.`);
  }
  const tokens = spec.split('+');
  if (tokens.length > 5) {
    throw new Error(`Key spec has too many parts (max 5 '+''-separated keys): "${spec}"`);
  }
  for (const token of tokens) {
    if (token === '') {
      throw new Error(`Invalid key spec "${spec}": empty part (check '+' placement).`);
    }
    if (!ALLOWED_KEY_TOKENS.has(token) && !SINGLE_CHAR_KEY_RE.test(token)) {
      throw new Error(
        `Unsupported key "${token}" in "${spec}". Use letters/digits, F1–F12, Return, Tab, Escape, space, BackSpace, Delete, arrow keys, Home/End/Page_Up/Page_Down, or modifiers ctrl/alt/shift/super/meta.`,
      );
    }
  }
}

/**
 * Best-effort check for a string that looks like a long random secret /
 * token (no spaces, >= 32 chars, mixed upper + lower + digit, no URL-ish
 * punctuation). computer_type refuses such strings — it must never be
 * used to type passwords, API keys or tokens.
 */
export function looksLikeSecretToken(text: string): boolean {
  if (text.length < 32) return false;
  if (/\s/.test(text)) return false;
  if (/[./:]/.test(text)) return false; // URLs / file paths are not tokens
  return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
}

function makeMouseMoveTool(): Tool {
  return {
    definition: {
      name: 'computer_mouse_move',
      description:
        'Move the mouse pointer to absolute screen coordinates (x, y). Coordinates are validated against the current screen size. Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Absolute horizontal coordinate in pixels (0 = left edge).' },
          y: { type: 'number', description: 'Absolute vertical coordinate in pixels (0 = top edge).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        requireDisplay();
        const x = getNumberArg(args, 'x');
        const y = getNumberArg(args, 'y');
        if (x === undefined || y === undefined) throw new Error('Missing required arguments: "x" and "y"');
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          throw new Error(`Coordinates must be integers, got x=${x}, y=${y}.`);
        }
        const geometry = await getDisplayGeometry(ctx.signal);
        if (x < 0 || x >= geometry.width || y < 0 || y >= geometry.height) {
          return errorResult(
            `Coordinates (${x}, ${y}) are outside the screen (${geometry.width}x${geometry.height}).`,
          );
        }
        // Chain getmouselocation in the SAME xdotool invocation: the
        // warp is verified on the same X connection. (On this machine's
        // Xvfb the pointer position resets to screen centre when a
        // client disconnects, so a separate getmouselocation process
        // would not see the move — the tool must check it itself.)
        const result = await runProcess(
          'xdotool',
          ['mousemove', String(x), String(y), 'getmouselocation'],
          CONTROL_TIMEOUT_MS,
          ctx.signal,
        );
        if (result.code !== 0) {
          throw new Error(`xdotool mousemove failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`);
        }
        const loc = result.stdout.toString('utf8').match(/x:(\d+)\s+y:(\d+)/);
        if (!loc || Number(loc[1]) !== x || Number(loc[2]) !== y) {
          throw new Error(
            `Mouse move to (${x}, ${y}) was not confirmed by xdotool (reported: "${result.stdout.toString('utf8').trim()}").`,
          );
        }
        return `Mouse moved to (${x}, ${y}) on a ${geometry.width}x${geometry.height} screen.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeClickTool(): Tool {
  return {
    definition: {
      name: 'computer_click',
      description:
        'Click the mouse at the current pointer position (move it first with computer_mouse_move). Buttons: left, right, middle. Set doubleClick for a double-click. Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button to click (default: left).',
          },
          doubleClick: {
            type: 'boolean',
            description: 'Double-click instead of a single click (default: false).',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        requireDisplay();
        const buttonRaw = args['button'] === undefined ? 'left' : getStringArg(args, 'button', false);
        const buttonMap: Record<string, string> = { left: '1', right: '3', middle: '2' };
        const button = buttonMap[buttonRaw];
        if (!button) {
          return errorResult(`Unknown button "${buttonRaw}": use "left", "right" or "middle".`);
        }
        const doubleClick = getBooleanArg(args, 'doubleClick');
        const clickArgs = doubleClick
          ? ['click', '--repeat', '2', '--delay', '100', button]
          : ['click', button];
        const result = await runProcess('xdotool', clickArgs, CONTROL_TIMEOUT_MS, ctx.signal);
        if (result.code !== 0) {
          throw new Error(`xdotool click failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`);
        }
        return `Clicked ${buttonRaw}${doubleClick ? ' (double-click)' : ''}.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeKeyTool(): Tool {
  return {
    definition: {
      name: 'computer_key',
      description:
        'Press a key or key combination via xdotool (e.g. "Return", "ctrl+l", "alt+Tab", "F5"). Key names are validated against an allowlist. Do NOT use to type passwords or secrets. Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key or "+"-separated combination, e.g. "Return", "ctrl+c", "alt+Tab". Max 5 parts, 64 chars.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        requireDisplay();
        const key = getStringArg(args, 'key');
        validateKeySpec(key);
        const result = await runProcess('xdotool', ['key', key], CONTROL_TIMEOUT_MS, ctx.signal);
        if (result.code !== 0) {
          throw new Error(`xdotool key failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`);
        }
        return `Pressed key "${key}".`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

function makeTypeTool(): Tool {
  return {
    definition: {
      name: 'computer_type',
      description:
        'Type a text string via xdotool at the current focus (max 1000 chars). NEVER use this to type passwords, secrets, API keys or tokens — the tool refuses strings that look like long random tokens, and credentials must never be entered this way. Requires a running X display.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to type (max 1000 characters, no control characters other than tab/newline). Must not be a password, secret or token.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        requireDisplay();
        const text = getStringArg(args, 'text');
        if (text.length === 0) return errorResult('Nothing to type: "text" is empty.');
        if (text.length > MAX_TYPE_CHARS) {
          return errorResult(`Text is ${text.length} chars, over the ${MAX_TYPE_CHARS} char limit. Split it into smaller chunks.`);
        }
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          if ((code < 0x20 && ch !== '\t' && ch !== '\n') || code === 0x7f) {
            return errorResult(
              `Text contains a control character (U+${code.toString(16).padStart(4, '0')}). Only tab and newline are allowed.`,
            );
          }
        }
        if (looksLikeSecretToken(text)) {
          return errorResult(
            'Refusing to type a string that looks like a long random secret/token. computer_type must never be used to enter passwords, API keys or tokens.',
          );
        }
        const result = await runProcess(
          'xdotool',
          ['type', '--delay', '12', '--', text],
          CONTROL_TIMEOUT_MS + 10_000,
          ctx.signal,
        );
        if (result.code !== 0) {
          throw new Error(`xdotool type failed (exit ${result.code}): ${result.stderr.trim() || 'no output'}`);
        }
        return `Typed ${text.length} character(s).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Exports (kept separate from ALL_TOOLS — the coordinator integrates them)
// ---------------------------------------------------------------------------

/**
 * Build the computer-use tools. Each call gets its own recording table,
 * so two registries never share (or stop) each other's recordings.
 * `opts` overrides the default recording duration / file-size limits.
 */
export function createComputerUseTools(opts: ComputerUseOptions = {}): Tool[] {
  const defaults: Required<ComputerUseOptions> = {
    defaultMaxDurationSeconds:
      opts.defaultMaxDurationSeconds ?? DEFAULT_MAX_RECORD_SECONDS,
    defaultMaxFileSizeMB: opts.defaultMaxFileSizeMB ?? DEFAULT_MAX_RECORD_MB,
  };
  const recordings = new Map<string, ActiveRecording>();
  return [
    makeScreenshotTool(),
    makeRecordStartTool(recordings, defaults),
    makeRecordStopTool(recordings),
    makeMouseMoveTool(),
    makeClickTool(),
    makeKeyTool(),
    makeTypeTool(),
  ];
}

export const COMPUTER_USE_TOOLS: Tool[] = createComputerUseTools();
