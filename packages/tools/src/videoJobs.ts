/**
 * Video generation jobs for @open-bot/tools (v0.86b, P1-5).
 *
 * `video_generate` used to be a synchronous stub: it POSTed once and
 * returned whatever the provider said, with no way to follow the job.
 * Video generation is inherently asynchronous (a provider takes
 * seconds to minutes), so it now works like this:
 *
 *   video_generate  — creates a VideoJob (status 'queued'), starts the
 *                     background driver, returns the job id at once.
 *   video_status    — reads the job from the store; when the job is
 *                     still running and a provider job id is known it
 *                     best-effort polls the provider once to refresh
 *                     the stored state, then reports it.
 *   video_cancel    — marks the job cancelled; the driver stops at its
 *                     next poll (and asks the provider to cancel too,
 *                     when the provider supports it).
 *
 * Persistence: one JSON file per job under
 * `<workspaceDir>/.open-bot/video-jobs/<botId>/<id>.json` — the same
 * `.open-bot/` internal-state directory CanvasStore uses. Writes are
 * atomic (temp file + rename) and guarded by a per-job lock file, so a
 * job's status survives a restart: a fresh VideoJobStore on the same
 * workspace reads the same record. A job left 'running' by a crashed
 * process is NOT silently resurrected — `video_status` lazily marks a
 * non-terminal job 'timed_out' once its deadline passes, and the
 * driver only ever advances a job it re-reads as still non-terminal.
 *
 * Providers
 * ---------
 * `VideoProvider` is the interface a video backend implements:
 * start an async job, poll it, download the finished bytes, cancel.
 *
 * `HttpVideoProvider` is the built-in HTTP implementation. It speaks
 * the public OpenAI video API shape (Sora): POST `{baseUrl}/videos`
 * `{model, prompt, seconds}` -> `{id, status}`, GET
 * `{baseUrl}/videos/{id}` to poll (`queued` / `in_progress` /
 * `completed` / `failed`), GET `{baseUrl}/videos/{id}/content` to
 * download. The default video model for OpenAI is 'sora-2' (see
 * webMedia.ts). LIVE GENERATION THROUGH THIS PROVIDER HAS NOT BEEN
 * VERIFIED on this machine — there is no OpenAI key here, no live
 * call was made, and the shape is implemented from the public API
 * contract, not from a live response. xAI has NO default video model:
 * Grok Imagine is app-only and xAI publishes no public video
 * endpoint, so an xai config without an explicit videoModel /
 * videoEndpoint still errors out and points at video_from_images.
 *
 * A host can wire any other backend by passing its own VideoProvider
 * (see `createVideoProvider` in WebMediaToolOptions) — e.g. a
 * provider whose video API has a different shape. The API key always
 * comes from the Vault via the host's getProviderConfig; it is never
 * written to a job file or a log (job records hold no secrets).
 *
 * No secrets live here — job records are user data, not credentials.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fetchPublic } from './ssrf';
import { resolveWithin } from './sandbox';

/** Job lifecycle states. Terminal: done, failed, cancelled, timed_out. */
export type VideoJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const VIDEO_JOB_TERMINAL_STATUSES: readonly VideoJobStatus[] = [
  'done',
  'failed',
  'cancelled',
  'timed_out',
];

export function isVideoJobTerminal(status: VideoJobStatus): boolean {
  return (VIDEO_JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** One persisted video-generation job. No secrets in here, ever. */
export interface VideoJob {
  id: string;
  prompt: string;
  providerId: string;
  model: string;
  durationSeconds: number;
  status: VideoJobStatus;
  /** Provider-side job id, once startJob has returned it. */
  providerJobId?: string;
  /** Workspace-relative path of the finished mp4, once downloaded. */
  outputPath?: string;
  /** Provider-supplied result URL, when the provider returns one. */
  resultUrl?: string;
  /** Terminal failure reason (failed / timed_out). */
  error?: string;
  /** Last non-fatal poll error, cleared on the next successful poll. */
  lastError?: string;
  /** Set by video_cancel; the driver stops at its next poll. */
  cancelRequested: boolean;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Give up (timed_out) this many ms after createdAt. */
  timeoutMs: number;
  botId: string;
}

export interface VideoJobCreateInput {
  prompt: string;
  providerId: string;
  model: string;
  durationSeconds: number;
  timeoutMs: number;
}

const VIDEO_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** How long a lock file may live before it is treated as stale (crashed writer). */
const LOCK_STALE_MS = 10_000;
/** How long to keep retrying to take a lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

/** Default poll interval of the background driver (5s). */
export const VIDEO_JOB_POLL_INTERVAL_MS = 5_000;
/** Default job timeout (10 minutes from creation). */
export const VIDEO_JOB_DEFAULT_TIMEOUT_MS = 600_000;
/** Cap on a single provider poll / download HTTP call (2 minutes). */
const PROVIDER_FETCH_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeBotId(botId: string): string {
  const safe = botId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return safe === '' ? 'default-bot' : safe;
}

export function validateVideoJobId(id: string): void {
  if (typeof id !== 'string' || !VIDEO_JOB_ID_RE.test(id)) {
    throw new Error(
      `Invalid video job id "${id}": use only letters, digits, "-", "_" and ".", starting with a letter or digit.`,
    );
  }
}

/** fetch() with a hard timeout. Throws on timeout / network error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROVIDER_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Durable per-bot store of video jobs. Same pattern as CanvasStore:
 * one JSON file per job, atomic writes, per-job lock file.
 */
export class VideoJobStore {
  private readonly dir: string;
  private readonly botId: string;
  private lastTimestampMs = 0;

  /**
   * @param workspaceDir Bot workspace root; jobs live under
   *   `<workspaceDir>/.open-bot/video-jobs/<botId>/`.
   * @param botId Owner bot; used to scope the directory per bot.
   */
  constructor(workspaceDir: string, botId: string) {
    if (!workspaceDir) throw new Error('VideoJobStore needs a workspaceDir.');
    if (!botId) throw new Error('VideoJobStore needs a botId.');
    this.botId = botId;
    this.dir = path.join(workspaceDir, '.open-bot', 'video-jobs', sanitizeBotId(botId));
  }

  /** Monotonic ISO timestamp: never equal to (or before) the previous one. */
  private nextTimestamp(): string {
    const now = Date.now();
    this.lastTimestampMs = Math.max(now, this.lastTimestampMs + 1);
    return new Date(this.lastTimestampMs).toISOString();
  }

  /** Directory holding this bot's job files (created on first write). */
  get directory(): string {
    return this.dir;
  }

  /** Create a job in status 'queued'. */
  async create(input: VideoJobCreateInput): Promise<VideoJob> {
    const now = this.nextTimestamp();
    const job: VideoJob = {
      id: randomUUID(),
      prompt: input.prompt,
      providerId: input.providerId,
      model: input.model,
      durationSeconds: input.durationSeconds,
      status: 'queued',
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      timeoutMs: input.timeoutMs,
      botId: this.botId,
    };
    await this.withLock(job.id, async () => {
      this.saveJob(job);
    });
    return job;
  }

  /** Read a job by id, or null when it does not exist. */
  async read(id: string): Promise<VideoJob | null> {
    validateVideoJobId(id);
    const file = this.fileFor(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return this.parseJob(raw, file);
  }

  /**
   * Read-modify-write under the per-job lock. `fn` receives the current
   * job and returns the replacement, or null to leave it unchanged.
   * Returns the job as stored afterwards.
   */
  async update(
    id: string,
    fn: (current: VideoJob) => VideoJob | null,
  ): Promise<VideoJob | null> {
    validateVideoJobId(id);
    return this.withLock(id, async () => {
      const current = await this.read(id);
      if (!current) return null;
      const next = fn(current);
      if (!next) return current;
      next.updatedAt = this.nextTimestamp();
      this.saveJob(next);
      return next;
    });
  }

  /**
   * Mark a non-terminal job with a terminal status. No-op (returns the
   * job unchanged) when it is already terminal — so a late driver tick
   * can never overwrite a cancel / timeout / done.
   */
  async finish(
    id: string,
    status: 'done' | 'failed' | 'cancelled' | 'timed_out',
    patch: Partial<VideoJob> = {},
  ): Promise<VideoJob | null> {
    return this.update(id, (current) => {
      if (isVideoJobTerminal(current.status)) return null;
      return {
        ...current,
        ...patch,
        status,
        completedAt: new Date().toISOString(),
      };
    });
  }

  /** List this bot's jobs (newest first). */
  async list(): Promise<VideoJob[]> {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: VideoJob[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(
          this.parseJob(
            fs.readFileSync(path.join(this.dir, name), 'utf8'),
            path.join(this.dir, name),
          ),
        );
      } catch {
        // A corrupt file must not hide the healthy jobs.
        continue;
      }
    }
    out.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    return out;
  }

  /** Delete a job. Returns true when a file was actually removed. */
  async delete(id: string): Promise<boolean> {
    validateVideoJobId(id);
    return this.withLock(id, async () => {
      try {
        fs.unlinkSync(this.fileFor(id));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  // --- Internals ------------------------------------------------------------

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private lockFor(id: string): string {
    return path.join(this.dir, `${id}.lock`);
  }

  private parseJob(raw: string, file: string): VideoJob {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Video job file is not valid JSON: ${file}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Video job file has an unsupported shape: ${file}`);
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc['id'] !== 'string' || typeof doc['prompt'] !== 'string') {
      throw new Error(`Video job file is missing id/prompt: ${file}`);
    }
    const status = doc['status'];
    const valid: readonly string[] = [
      'queued',
      'running',
      'done',
      'failed',
      'cancelled',
      'timed_out',
    ];
    return {
      id: doc['id'] as string,
      prompt: doc['prompt'] as string,
      providerId: typeof doc['providerId'] === 'string' ? (doc['providerId'] as string) : '',
      model: typeof doc['model'] === 'string' ? (doc['model'] as string) : '',
      durationSeconds:
        typeof doc['durationSeconds'] === 'number' ? (doc['durationSeconds'] as number) : 0,
      status: valid.includes(status as string) ? (status as VideoJobStatus) : 'failed',
      providerJobId:
        typeof doc['providerJobId'] === 'string' ? (doc['providerJobId'] as string) : undefined,
      outputPath:
        typeof doc['outputPath'] === 'string' ? (doc['outputPath'] as string) : undefined,
      resultUrl:
        typeof doc['resultUrl'] === 'string' ? (doc['resultUrl'] as string) : undefined,
      error: typeof doc['error'] === 'string' ? (doc['error'] as string) : undefined,
      lastError:
        typeof doc['lastError'] === 'string' ? (doc['lastError'] as string) : undefined,
      cancelRequested: doc['cancelRequested'] === true,
      createdAt:
        typeof doc['createdAt'] === 'string'
          ? (doc['createdAt'] as string)
          : new Date().toISOString(),
      updatedAt:
        typeof doc['updatedAt'] === 'string'
          ? (doc['updatedAt'] as string)
          : new Date().toISOString(),
      startedAt:
        typeof doc['startedAt'] === 'string' ? (doc['startedAt'] as string) : undefined,
      completedAt:
        typeof doc['completedAt'] === 'string' ? (doc['completedAt'] as string) : undefined,
      timeoutMs:
        typeof doc['timeoutMs'] === 'number'
          ? (doc['timeoutMs'] as number)
          : VIDEO_JOB_DEFAULT_TIMEOUT_MS,
      botId: typeof doc['botId'] === 'string' ? (doc['botId'] as string) : this.botId,
    };
  }

  private saveJob(job: VideoJob): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(job.id);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * Take the per-job lock file (exclusive create), run `fn`, release.
   * A lock older than LOCK_STALE_MS is treated as left by a crashed
   * writer and removed. Gives up after LOCK_TIMEOUT_MS.
   */
  private async withLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lockPath = this.lockFor(id);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock vanished between the failed create and the stat — retry.
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for the lock on video job "${id}" (another writer holds it).`,
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Lock already gone (e.g. removed as stale) — nothing to do.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VideoProvider — the interface a video backend implements
// ---------------------------------------------------------------------------

export interface VideoGenerateRequest {
  prompt: string;
  model: string;
  durationSeconds: number;
}

export interface VideoStartResult {
  providerJobId: string;
  /** Raw provider status string, when the provider returns one. */
  status?: string;
}

export type VideoPollStatus = 'queued' | 'running' | 'done' | 'failed';

export interface VideoPollResult {
  status: VideoPollStatus;
  /** Direct download URL for the finished video, when the provider gives one. */
  videoUrl?: string;
  /** Failure reason, when status is 'failed'. */
  error?: string;
  /** 0..1 progress, when the provider reports it. */
  progress?: number;
  /** Raw provider status string, for debugging. */
  rawStatus?: string;
}

/**
 * A video-generation backend. `startJob` must return quickly (async
 * providers only — the driver polls afterwards); `pollJob` reports the
 * current state; `downloadJob` returns the finished video bytes when
 * the provider has no direct download URL. `cancelJob` is optional.
 */
export interface VideoProvider {
  readonly id: string;
  startJob(req: VideoGenerateRequest): Promise<VideoStartResult>;
  pollJob(providerJobId: string): Promise<VideoPollResult>;
  downloadJob?(providerJobId: string): Promise<Buffer>;
  cancelJob?(providerJobId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HttpVideoProvider — OpenAI video API shape (Sora), NOT live-verified
// ---------------------------------------------------------------------------

export interface HttpVideoProviderConfig {
  /** Provider id, e.g. 'openai'. */
  id: string;
  /** API key, resolved by the host from the Vault. Never logged. */
  apiKey: string;
  /** API base URL, e.g. 'https://api.openai.com/v1'. No trailing slash needed. */
  baseUrl: string;
  /** Full video-generation endpoint URL. Defaults to `<baseUrl>/videos`. */
  videoEndpoint?: string;
}

function mapProviderStatus(raw: unknown): VideoPollStatus {
  if (typeof raw !== 'string') return 'running';
  const s = raw.toLowerCase();
  if (s === 'queued' || s === 'pending') return 'queued';
  if (s === 'completed' || s === 'succeeded' || s === 'success' || s === 'done') return 'done';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  // in_progress / running / processing / anything unknown: still going.
  return 'running';
}

/**
 * HTTP video provider speaking the public OpenAI video API (Sora)
 * shape: POST `{baseUrl}/videos` `{model, prompt, seconds}` ->
 * `{id, status}`; GET `{baseUrl}/videos/{id}` to poll; GET
 * `{baseUrl}/videos/{id}/content` to download.
 *
 * NOT LIVE-VERIFIED: no OpenAI key exists on this machine, no live
 * call was ever made, and the shape is implemented from the public
 * API contract. A host that wires a provider whose video API differs
 * should pass its own VideoProvider instead (see WebMediaToolOptions
 * `createVideoProvider`).
 */
export class HttpVideoProvider implements VideoProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly videoEndpoint: string;

  constructor(config: HttpVideoProviderConfig) {
    this.id = config.id;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.videoEndpoint = config.videoEndpoint ?? `${this.baseUrl}/videos`;
  }

  async startJob(req: VideoGenerateRequest): Promise<VideoStartResult> {
    const res = await fetchWithTimeout(this.videoEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        seconds: String(req.durationSeconds),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Video API request failed with HTTP ${res.status}: ` +
          `${body.slice(0, 500) || res.statusText}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('Video API returned a response that is not valid JSON.');
    }
    const obj = parsed as Record<string, unknown>;
    const providerJobId =
      typeof obj['id'] === 'string'
        ? (obj['id'] as string)
        : typeof obj['job_id'] === 'string'
          ? (obj['job_id'] as string)
          : '';
    if (!providerJobId) {
      throw new Error('Video API returned no job id ("id" / "job_id").');
    }
    return {
      providerJobId,
      status: typeof obj['status'] === 'string' ? (obj['status'] as string) : undefined,
    };
  }

  async pollJob(providerJobId: string): Promise<VideoPollResult> {
    const url = `${this.videoEndpoint.replace(/\/+$/, '')}/${encodeURIComponent(providerJobId)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Video status poll failed with HTTP ${res.status}: ` +
          `${body.slice(0, 500) || res.statusText}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('Video API returned a response that is not valid JSON.');
    }
    const obj = parsed as Record<string, unknown>;
    const rawStatus = typeof obj['status'] === 'string' ? (obj['status'] as string) : undefined;
    const videoUrl =
      typeof obj['url'] === 'string'
        ? (obj['url'] as string)
        : typeof obj['video_url'] === 'string'
          ? (obj['video_url'] as string)
          : typeof obj['download_url'] === 'string'
            ? (obj['download_url'] as string)
            : undefined;
    const error =
      typeof obj['error'] === 'string'
        ? (obj['error'] as string)
        : typeof obj['error'] === 'object' && obj['error'] !== null
          ? JSON.stringify(obj['error']).slice(0, 500)
          : undefined;
    const progress =
      typeof obj['progress'] === 'number' && Number.isFinite(obj['progress'])
        ? Math.max(0, Math.min(1, obj['progress']))
        : undefined;
    return { status: mapProviderStatus(rawStatus), videoUrl, error, progress, rawStatus };
  }

  async downloadJob(providerJobId: string): Promise<Buffer> {
    const url = `${this.videoEndpoint.replace(/\/+$/, '')}/${encodeURIComponent(providerJobId)}/content`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'video/*' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Video download failed with HTTP ${res.status}: ` +
          `${body.slice(0, 500) || res.statusText}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async cancelJob(providerJobId: string): Promise<void> {
    const url = `${this.videoEndpoint.replace(/\/+$/, '')}/${encodeURIComponent(providerJobId)}`;
    const res = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Video cancel failed with HTTP ${res.status}: ` +
          `${body.slice(0, 500) || res.statusText}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Driver — advances one job from queued to a terminal state
// ---------------------------------------------------------------------------

export interface DriveVideoJobOptions {
  workspaceDir: string;
  pollIntervalMs?: number;
}

/** Render a job as the text video_status returns. Pure function. */
export function formatVideoJob(job: VideoJob): string {
  const lines = [
    `Video job ${job.id}`,
    `Status: ${job.status}`,
    `Provider: ${job.providerId} (model ${job.model}, ${job.durationSeconds}s)`,
    `Prompt: ${job.prompt}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
  ];
  if (job.providerJobId) lines.push(`Provider job ID: ${job.providerJobId}`);
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);
  if (job.outputPath) lines.push(`Output: ${job.outputPath}`);
  if (job.resultUrl) lines.push(`Video URL: ${job.resultUrl}`);
  if (job.error) lines.push(`Error: ${job.error}`);
  if (job.lastError && !isVideoJobTerminal(job.status)) {
    lines.push(`Last poll error (retrying): ${job.lastError}`);
  }
  if (job.status === 'done' && job.outputPath) {
    lines.push('The video file is saved in the workspace.');
  } else if (!isVideoJobTerminal(job.status)) {
    lines.push(
      `Still ${job.status} — poll again with video_status (jobId: ${job.id}) ` +
        `or stop it with video_cancel.`,
    );
  }
  return lines.join('\n');
}

/**
 * Download the finished video for a job whose provider poll says
 * 'done', save it into the workspace and mark the job done. When
 * there is no downloadable content (no downloadJob and no videoUrl)
 * the job is still marked done with the provider URL, if any.
 * Returns the job as stored afterwards.
 */
export async function finishVideoJob(
  store: VideoJobStore,
  provider: VideoProvider,
  job: VideoJob,
  polled: VideoPollResult,
  workspaceDir: string,
): Promise<VideoJob | null> {
  let bytes: Buffer | null = null;
  if (provider.downloadJob && job.providerJobId) {
    bytes = await provider.downloadJob(job.providerJobId);
  } else if (polled.videoUrl) {
    // v0.15 (H3 audit): a provider-supplied URL is also SSRF-guarded.
    const res = await fetchPublic(polled.videoUrl, {}, PROVIDER_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`Video download failed with HTTP ${res.status}.`);
    }
    bytes = Buffer.from(await res.arrayBuffer());
  }
  let outputPath: string | undefined;
  if (bytes) {
    outputPath = `generated-media/video-${job.id}.mp4`;
    const full = resolveWithin(workspaceDir, outputPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  }
  return store.finish(job.id, 'done', {
    outputPath,
    resultUrl: polled.videoUrl,
    lastError: undefined,
  });
}

/**
 * Background driver for one job: start it on the provider, poll until
 * it reaches a terminal state, times out, or is cancelled. Every
 * transition is persisted, and every step re-reads the job from the
 * store, so a concurrent video_cancel (or a lazy timeout applied by
 * video_status) wins over a stale driver tick. Never throws for a
 * provider failure — that is recorded on the job instead.
 */
export async function driveVideoJob(
  store: VideoJobStore,
  provider: VideoProvider,
  jobId: string,
  opts: DriveVideoJobOptions,
): Promise<VideoJob | null> {
  const pollIntervalMs = opts.pollIntervalMs ?? VIDEO_JOB_POLL_INTERVAL_MS;
  const job0 = await store.read(jobId);
  if (!job0 || isVideoJobTerminal(job0.status)) return job0;

  await store.update(jobId, (current) => {
    if (isVideoJobTerminal(current.status) || current.cancelRequested) return null;
    return { ...current, status: 'running', startedAt: new Date().toISOString() };
  });

  let providerJobId: string | undefined;
  try {
    const started = await provider.startJob({
      prompt: job0.prompt,
      model: job0.model,
      durationSeconds: job0.durationSeconds,
    });
    providerJobId = started.providerJobId;
  } catch (err) {
    return store.finish(jobId, 'failed', {
      error: `Failed to start the video job on provider "${provider.id}": ${(err as Error).message}`,
    });
  }

  // The job may have been cancelled while startJob was in flight.
  const afterStart = await store.read(jobId);
  if (!afterStart || isVideoJobTerminal(afterStart.status) || afterStart.cancelRequested) {
    if (providerJobId && provider.cancelJob) {
      await provider.cancelJob(providerJobId).catch(() => {});
    }
    return store.finish(jobId, 'cancelled', {
      providerJobId,
      error: 'Cancelled before the provider job started.',
    });
  }
  await store.update(jobId, (current) => {
    if (isVideoJobTerminal(current.status) || current.cancelRequested) return null;
    return { ...current, providerJobId };
  });

  for (;;) {
    await sleep(pollIntervalMs);
    const current = await store.read(jobId);
    if (!current || isVideoJobTerminal(current.status)) return current;
    if (current.cancelRequested || current.status === 'cancelled') {
      if (providerJobId && provider.cancelJob) {
        await provider.cancelJob(providerJobId).catch(() => {});
      }
      return store.finish(jobId, 'cancelled', {
        providerJobId,
        error: 'Cancelled by the user.',
      });
    }
    if (Date.now() > Date.parse(current.createdAt) + current.timeoutMs) {
      return store.finish(jobId, 'timed_out', {
        providerJobId,
        error:
          `Video job timed out after ${Math.round(current.timeoutMs / 1000)}s ` +
          `(provider job still ${current.status}). Increase "timeoutSeconds" and retry.`,
      });
    }
    let polled: VideoPollResult;
    try {
      polled = await provider.pollJob(providerJobId);
    } catch (err) {
      // Transient poll failure: record it and keep polling until timeout.
      await store.update(jobId, (c) => {
        if (isVideoJobTerminal(c.status) || c.cancelRequested) return null;
        return { ...c, lastError: (err as Error).message };
      });
      continue;
    }
    if (polled.status === 'done') {
      try {
        return await finishVideoJob(store, provider, current, polled, opts.workspaceDir);
      } catch (err) {
        return store.finish(jobId, 'failed', {
          providerJobId,
          error: `Video finished on the provider but the file could not be saved: ${(err as Error).message}`,
        });
      }
    }
    if (polled.status === 'failed') {
      return store.finish(jobId, 'failed', {
        providerJobId,
        resultUrl: polled.videoUrl,
        error: polled.error ?? `Provider "${provider.id}" reported the video job as failed.`,
      });
    }
    // Still queued/running: persist the fresh state (and clear lastError).
    await store.update(jobId, (c) => {
      if (isVideoJobTerminal(c.status) || c.cancelRequested) return null;
      return {
        ...c,
        status: polled.status === 'queued' ? 'queued' : 'running',
        resultUrl: polled.videoUrl ?? c.resultUrl,
        lastError: undefined,
      };
    });
  }
}
