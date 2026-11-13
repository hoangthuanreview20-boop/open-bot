/**
 * Harness v2 — headless CI-style job mode (v0.97, Team T5).
 *
 * `open-bot run --job job.json` runs one bot job without any UI:
 * the job file names a bot (or a temporary provider + model) and a
 * prompt, the runner executes it through a host-supplied `runBot`
 * function (the CLI wires the real `AgentCoordinator`; tests inject
 * a fake), and the result is printed as JSON and/or streamed as
 * versioned NDJSON events.
 *
 * Exit codes (shared with the CLI, see types.ts):
 * - 0 done, 1 usage/config error, 2 run error, 3 approval denied.
 * Approval is fail-closed headless: when the run stops because an
 * approval was denied, the result text is `APPROVAL_DENIED_TEXT`
 * and the exit code is 3 — the caller (CI) can tell a denied run
 * apart from a crashed one.
 *
 * Mock/CLI exemption (v0.96 lesson): the headless runner never
 * applies provider routing to its own runs. When the job's provider
 * is `mock`, or the bot runs through a CLI-kind driver, the runner
 * calls `runBot` directly with no router in the path — a headless
 * smoke test must never be re-routed to a real local Ollama. The
 * `shouldBypassRouter` helper is the single place that decides this,
 * so the CLI and any future host agree.
 *
 * The runner itself never spawns a provider or reads the Vault: the
 * host owns credentials (the CLI reads `OPENBOT_<PROVIDER>_API_KEY`
 * from the environment). Timeouts are enforced with a race so a hung
 * provider cannot hang CI forever.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { NdjsonEventExporter } from './eventExport';
import type { HeadlessJobFile, HeadlessJobResult } from './types';
import {
  HEADLESS_EXIT_APPROVAL_DENIED,
  HEADLESS_EXIT_OK,
  HEADLESS_EXIT_RUN_ERROR,
} from './types';

/** Text a run returns when an approval was denied headless (matches the CLI constant). */
export const APPROVAL_DENIED_TEXT = 'đã hủy';
/** Default run timeout for a headless job (5 minutes). */
export const DEFAULT_HEADLESS_JOB_TIMEOUT_MS = 300_000;
/** Max prompt chars accepted from a job file. */
export const MAX_HEADLESS_PROMPT_CHARS = 100_000;
/** Max image files per job. */
export const MAX_HEADLESS_IMAGES = 5;

/** Provider ids that are CLI-kind drivers (run through a local CLI, not an API). */
export const CLI_KIND_PROVIDER_IDS: readonly string[] = [
  'claude-code',
  'codex',
  'aider',
  'copilot',
  'cursor',
  'kiro',
  'opencode',
  'gemini-cli',
  'grok-cli',
  'continue',
  'windsurf',
  'amazon-q',
  'acp',
];

/**
 * Should this job bypass provider routing? True for provider `mock`
 * and for CLI-kind providers: their runs must go straight to the
 * driver, never through the router (which could otherwise send a
 * mock/CLI run to a real local model).
 */
export function shouldBypassRouter(providerId: string): boolean {
  const id = providerId.trim().toLowerCase();
  return id === 'mock' || (CLI_KIND_PROVIDER_IDS as readonly string[]).includes(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse + validate a job file object. Throws a clear error on any
 * problem (wrong version, missing bot/provider, missing prompt,
 * bad timeout, too many images). Never reads the filesystem.
 */
export function parseHeadlessJobFile(value: unknown): HeadlessJobFile {
  if (!isRecord(value)) throw new Error('Job file must be a JSON object.');
  if (value['version'] !== 1) {
    throw new Error(`Unsupported job file version: ${JSON.stringify(value['version'])} (expected 1).`);
  }
  const job: HeadlessJobFile = { version: 1 };
  if (value['name'] !== undefined) {
    if (typeof value['name'] !== 'string' || value['name'].trim() === '') {
      throw new Error('Job "name" must be a non-empty string when present.');
    }
    job.name = value['name'].trim();
  }
  if (value['bot'] !== undefined) {
    if (typeof value['bot'] !== 'string' || value['bot'].trim() === '') {
      throw new Error('Job "bot" must be a non-empty string when present.');
    }
    job.bot = value['bot'].trim();
  }
  if (value['provider'] !== undefined) {
    if (typeof value['provider'] !== 'string' || value['provider'].trim() === '') {
      throw new Error('Job "provider" must be a non-empty string when present.');
    }
    job.provider = value['provider'].trim();
  }
  if (value['model'] !== undefined) {
    if (typeof value['model'] !== 'string' || value['model'].trim() === '') {
      throw new Error('Job "model" must be a non-empty string when present.');
    }
    job.model = value['model'].trim();
  }
  if (job.bot === undefined && job.provider === undefined) {
    throw new Error('Job needs "bot" (id or name) or "provider" (with "model").');
  }
  if (job.provider !== undefined && job.model === undefined) {
    throw new Error('Job with "provider" also needs "model".');
  }
  if (value['prompt'] !== undefined) {
    if (typeof value['prompt'] !== 'string') {
      throw new Error('Job "prompt" must be a string when present.');
    }
    if (value['prompt'].length > MAX_HEADLESS_PROMPT_CHARS) {
      throw new Error(`Job "prompt" is too long (max ${MAX_HEADLESS_PROMPT_CHARS} chars).`);
    }
    job.prompt = value['prompt'];
  }
  if (value['imageFiles'] !== undefined) {
    if (!Array.isArray(value['imageFiles'])) {
      throw new Error('Job "imageFiles" must be an array of file paths.');
    }
    if (value['imageFiles'].length > MAX_HEADLESS_IMAGES) {
      throw new Error(`Job "imageFiles" holds at most ${MAX_HEADLESS_IMAGES} images.`);
    }
    for (const entry of value['imageFiles']) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error('Job "imageFiles" entries must be non-empty strings.');
      }
    }
    job.imageFiles = value['imageFiles'] as string[];
  }
  const hasPrompt = typeof job.prompt === 'string' && job.prompt.trim() !== '';
  if (!hasPrompt && (job.imageFiles ?? []).length === 0) {
    throw new Error('Job needs a non-empty "prompt" (or "imageFiles").');
  }
  if (value['timeoutMs'] !== undefined) {
    if (
      typeof value['timeoutMs'] !== 'number' ||
      !Number.isInteger(value['timeoutMs']) ||
      value['timeoutMs'] <= 0
    ) {
      throw new Error('Job "timeoutMs" must be a positive integer when present.');
    }
    job.timeoutMs = value['timeoutMs'];
  }
  if (value['autoApprove'] !== undefined) {
    if (typeof value['autoApprove'] !== 'boolean') {
      throw new Error('Job "autoApprove" must be a boolean when present.');
    }
    job.autoApprove = value['autoApprove'];
  }
  if (value['ndjson'] !== undefined) {
    if (typeof value['ndjson'] !== 'boolean') {
      throw new Error('Job "ndjson" must be a boolean when present.');
    }
    job.ndjson = value['ndjson'];
  }
  if (value['ndjsonFile'] !== undefined) {
    if (typeof value['ndjsonFile'] !== 'string' || value['ndjsonFile'].trim() === '') {
      throw new Error('Job "ndjsonFile" must be a non-empty string when present.');
    }
    job.ndjsonFile = value['ndjsonFile'].trim();
  }
  if (value['routineId'] !== undefined) {
    if (typeof value['routineId'] !== 'string' || value['routineId'].trim() === '') {
      throw new Error('Job "routineId" must be a non-empty string when present.');
    }
    job.routineId = value['routineId'].trim();
  }
  return job;
}

/** Read + parse a job file from disk. Throws a clear error when unreadable or invalid. */
export function loadHeadlessJobFile(file: string): HeadlessJobFile {
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    throw new Error(`Cannot read job file "${file}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Job file "${file}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseHeadlessJobFile(parsed);
}

/** What the host's `runBot` resolves to for one headless run. */
export interface HeadlessRunOutcome {
  botId: string;
  botName: string;
  text: string;
  stopped: boolean;
  runId: string;
}

/** Host-supplied runner: executes one job against a real bot. */
export type HeadlessBotRunner = (
  job: HeadlessJobFile,
  opts: { bypassRouter: boolean; timeoutMs: number; signal: AbortSignal },
) => Promise<HeadlessRunOutcome>;

export interface HeadlessJobRunnerOptions {
  /** Where NDJSON events go when `job.ndjson` is on (default: process.stdout). */
  ndjsonStream?: NodeJS.WritableStream;
  /** Directory for the NDJSON file sink (used when `job.ndjsonFile` is set). */
  ndjsonDir?: string;
  /** Clock override (tests). */
  now?: () => Date;
}

/**
 * Runs headless jobs: validates the job, emits `cli.job.started` /
 * `cli.job.completed` NDJSON events, enforces the timeout, and maps
 * the outcome to a `HeadlessJobResult` with the right exit code.
 * A timeout or a throwing runner is a run error (exit 2), never a
 * hang: the abort signal is passed to the runner so it can stop.
 */
export class HeadlessJobRunner {
  private readonly runner: HeadlessBotRunner;
  private readonly opts: HeadlessJobRunnerOptions;

  constructor(runner: HeadlessBotRunner, opts: HeadlessJobRunnerOptions = {}) {
    this.runner = runner;
    this.opts = opts;
  }

  async runJob(jobInput: HeadlessJobFile | unknown): Promise<HeadlessJobResult> {
    const job = isRecord(jobInput) && jobInput['version'] !== undefined
      ? parseHeadlessJobFile(jobInput)
      : (jobInput as HeadlessJobFile);
    const startedAt = Date.now();
    const botIdForEvents = job.bot ?? job.provider ?? 'unknown';
    const threadId = `headless-${job.routineId ?? job.name ?? 'job'}`;
    const exporter = this.buildExporter(job);
    let eventsEmitted = 0;
    const emit = (kind: 'cli.job.started' | 'cli.job.completed', payload: Record<string, unknown>): void => {
      if (!job.ndjson && !job.ndjsonFile) return;
      exporter.emit(kind, botIdForEvents, threadId, payload);
      eventsEmitted += 1;
    };
    emit('cli.job.started', {
      jobName: job.name ?? '',
      bot: job.bot ?? '',
      provider: job.provider ?? '',
      model: job.model ?? '',
      bypassRouter: shouldBypassRouter(job.provider ?? ''),
      timeoutMs: job.timeoutMs ?? DEFAULT_HEADLESS_JOB_TIMEOUT_MS,
    });
    const timeoutMs = job.timeoutMs ?? DEFAULT_HEADLESS_JOB_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: HeadlessJobResult;
    try {
      const outcome = await this.runner(job, {
        bypassRouter: shouldBypassRouter(job.provider ?? ''),
        timeoutMs,
        signal: controller.signal,
      });
      const approvalDenied = outcome.text === APPROVAL_DENIED_TEXT;
      result = {
        ...(job.name !== undefined ? { jobName: job.name } : {}),
        botId: outcome.botId,
        botName: outcome.botName,
        text: outcome.text,
        stopped: outcome.stopped,
        runId: outcome.runId,
        approvalDenied,
        durationMs: Date.now() - startedAt,
        exitCode: approvalDenied ? HEADLESS_EXIT_APPROVAL_DENIED : HEADLESS_EXIT_OK,
        eventsEmitted,
      };
      emit('cli.job.completed', {
        runId: outcome.runId,
        approvalDenied,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stopped: outcome.stopped,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = controller.signal.aborted;
      result = {
        ...(job.name !== undefined ? { jobName: job.name } : {}),
        botId: botIdForEvents,
        botName: botIdForEvents,
        text: timedOut ? `Job timed out after ${timeoutMs}ms.` : `Job failed: ${message}`,
        stopped: true,
        runId: '',
        approvalDenied: false,
        durationMs: Date.now() - startedAt,
        exitCode: HEADLESS_EXIT_RUN_ERROR,
        eventsEmitted,
      };
      emit('cli.job.completed', {
        runId: '',
        approvalDenied: false,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        error: timedOut ? 'timeout' : message.slice(0, 500),
      });
    } finally {
      clearTimeout(timer);
    }
    result.eventsEmitted = eventsEmitted;
    this.moveNdjsonFile(job, threadId);
    return result;
  }

  /**
   * When `job.ndjsonFile` is set, the exporter wrote the thread's
   * events to `<dir>/<threadId>.ndjson` — move that file to the exact
   * path the job asked for (best-effort, never fails the run).
   */
  private moveNdjsonFile(job: HeadlessJobFile, threadId: string): void {
    if (job.ndjsonFile === undefined) return;
    try {
      const target = path.resolve(job.ndjsonFile);
      const dir = this.opts.ndjsonDir ?? path.dirname(target);
      const source = path.join(dir, `${threadId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)}.ndjson`);
      if (source === target) return;
      if (!fs.existsSync(source)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
    } catch {
      // Best-effort: the events are still in the thread file.
    }
  }

  private buildExporter(job: HeadlessJobFile): NdjsonEventExporter {
    const stream = job.ndjson === true ? (this.opts.ndjsonStream ?? process.stdout) : undefined;
    const dir = job.ndjsonFile !== undefined
      ? (this.opts.ndjsonDir ?? path.dirname(path.resolve(job.ndjsonFile)))
      : undefined;
    // When a ndjsonFile is set, the exporter writes per-thread files
    // into that file's directory; the CLI renames the thread file to
    // the requested name after the run (see apps/cli).
    return new NdjsonEventExporter(dir, ...(stream !== undefined ? [{ stream }] : []));
  }
}
