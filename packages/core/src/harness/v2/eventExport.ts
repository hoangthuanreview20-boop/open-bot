/**
 * Harness v2 — versioned NDJSON event bus export (v0.97, Team T5).
 *
 * Every runtime/harness event can be written to a stable NDJSON
 * stream: one JSON object per line, envelope version 2
 * (`{ v: 2, seq, at, kind, botId, threadId, payload }`). The format
 * is stable by contract — readers may rely on those fields always
 * being present; new optional fields may be added but existing ones
 * never change meaning. Payloads are sanitized before writing (no
 * secrets, strings truncated) with the same rules as the v1 harness
 * log, so the export is safe to hand to another tool or to `tail`.
 *
 * Two sinks:
 * - File sink (`NdjsonEventExporter`): appends to
 *   `<dir>/<threadId>.ndjson` (or one shared file), rotates past
 *   `maxFileBytes`, prunes old rotated files past `maxTotalBytes`
 *   (same policy as the v1 `ThreadLog`).
 * - Stream sink: the exporter can also write each line to a
 *   caller-supplied `Writable` (stdout for headless `--ndjson`, a
 *   socket, a test buffer).
 *
 * Reading back: `readNdjsonEvents` parses a file (or text) into
 * validated v2 events, skipping corrupt lines instead of failing;
 * `tailNdjsonEvents` returns the last N events; `followNdjsonFile`
 * polls a file for new lines (the `tail -f` equivalent for hosts
 * that cannot use `fs.watch` reliably).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { safeThreadFileName, sanitizeHarnessPayload } from '../ndjson';
import type { HarnessEventKind } from '../types';
import type { HarnessV2Event, HarnessV2EventKind } from './types';
import { HARNESS_V2_EVENT_KINDS, HARNESS_V2_EVENT_VERSION } from './types';

/** All kinds the v2 exporter accepts (v1 kinds + v2 kinds). */
export const NDJSON_EXPORT_KINDS: readonly string[] = [
  'text',
  'tool_call',
  'result',
  'error',
  'abort',
  'approval_request',
  'approval_denied',
  'permission_request',
  'permission_denied',
  'approval_decision',
  'lifecycle',
  'router.decision',
  ...HARNESS_V2_EVENT_KINDS,
];

/** Is this string a kind the v2 exporter accepts? */
export function isExportableEventKind(kind: string): kind is HarnessV2EventKind | HarnessEventKind {
  return (NDJSON_EXPORT_KINDS as readonly string[]).includes(kind);
}

export interface NdjsonEventExporterOptions {
  /** Rotate the file when it passes this size. Default 5 MB. */
  maxFileBytes?: number;
  /** Prune oldest rotated files when the total passes this size. Default 50 MB. */
  maxTotalBytes?: number;
  /** Extra sink: every line is also written here (stdout, a socket, a test buffer). */
  stream?: NodeJS.WritableStream;
  /** Where to send warnings (rotate/prune/stream failures). */
  logger?: { warn(message: string): void };
}

export interface NdjsonExportStats {
  /** Events emitted since this exporter was created. */
  emitted: number;
  /** Lines that failed to write (counted, never thrown). */
  writeErrors: number;
  /** Files rotated so far. */
  rotated: number;
}

/** Parse one NDJSON line into a v2 event. Returns null for corrupt / foreign lines. */
export function parseNdjsonEventLine(line: string): HarnessV2Event | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['v'] !== HARNESS_V2_EVENT_VERSION) return null;
  if (typeof rec['seq'] !== 'number' || typeof rec['at'] !== 'string') return null;
  if (typeof rec['kind'] !== 'string' || !isExportableEventKind(rec['kind'])) return null;
  if (typeof rec['botId'] !== 'string' || typeof rec['threadId'] !== 'string') return null;
  if (!rec['payload'] || typeof rec['payload'] !== 'object' || Array.isArray(rec['payload'])) {
    return null;
  }
  return {
    v: HARNESS_V2_EVENT_VERSION,
    seq: rec['seq'],
    at: rec['at'],
    kind: rec['kind'] as HarnessV2Event['kind'],
    botId: rec['botId'],
    threadId: rec['threadId'],
    payload: rec['payload'] as Record<string, unknown>,
  };
}

/**
 * Read all v2 events from NDJSON text (file content or a stream
 * capture). Corrupt lines are skipped and counted in `skipped`.
 */
export function readNdjsonEvents(text: string): { events: HarnessV2Event[]; skipped: number } {
  const events: HarnessV2Event[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const event = parseNdjsonEventLine(line);
    if (event) events.push(event);
    else skipped += 1;
  }
  return { events, skipped };
}

/**
 * Read v2 events from a file on disk. A missing file reads as empty
 * (no throw); a corrupt file still returns the good lines.
 */
export function readNdjsonEventFile(file: string): { events: HarnessV2Event[]; skipped: number } {
  try {
    return readNdjsonEvents(fs.readFileSync(file, 'utf8'));
  } catch {
    return { events: [], skipped: 0 };
  }
}

/** Last N v2 events from a file (newest last), without loading the whole file twice. */
export function tailNdjsonEvents(file: string, count: number): HarnessV2Event[] {
  const { events } = readNdjsonEventFile(file);
  return events.slice(Math.max(0, events.length - Math.max(0, count)));
}

export interface NdjsonFollowHandle {
  /** Stop polling. Safe to call twice. */
  stop(): void;
}

/**
 * Follow a NDJSON file: call `onEvent` for every new v2 event
 * appended after this call (plus, when `fromStart` is true, for the
 * events already in the file). Polls every `pollMs` (default 500 ms)
 * and survives rotation (a shrinking file restarts reading from 0).
 * The callback must never throw into the poll loop — errors are
 * counted on the returned handle via `errors`.
 */
export function followNdjsonFile(
  file: string,
  onEvent: (event: HarnessV2Event) => void,
  opts: { pollMs?: number; fromStart?: boolean } = {},
): NdjsonFollowHandle & { errors: number } {
  const pollMs = opts.pollMs ?? 500;
  let offset = 0;
  let stopped = false;
  let errors = 0;
  const handle = {
    get errors() {
      return errors;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  } as NdjsonFollowHandle & { errors: number };
  if (opts.fromStart !== true) {
    try {
      offset = fs.statSync(file).size;
    } catch {
      offset = 0;
    }
  }
  const poll = (): void => {
    if (stopped) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size < offset) offset = 0; // Rotated: start over.
      if (stat.size === offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = stat.size;
        const { events } = readNdjsonEvents(buf.toString('utf8'));
        for (const event of events) {
          try {
            onEvent(event);
          } catch {
            errors += 1;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // File missing / unreadable for now — retry on the next poll.
    }
  };
  const timer = setInterval(poll, pollMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref(): void }).unref();
  }
  if (opts.fromStart === true) poll();
  return handle;
}

export class NdjsonEventExporter {
  /** Directory holding the per-thread NDJSON files (undefined = stream-only). */
  readonly dir?: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly stream?: NodeJS.WritableStream;
  private readonly warn: (message: string) => void;
  private seq = 0;
  private emittedTotal = 0;
  private writeErrorsTotal = 0;
  private rotatedTotal = 0;
  private rotateCounter = 0;

  constructor(dir: string | undefined, options: NdjsonEventExporterOptions = {}) {
    this.dir = dir;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
    this.stream = options.stream;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : () => undefined;
  }

  /** Events emitted so far (file + stream). */
  get stats(): NdjsonExportStats {
    return {
      emitted: this.emittedTotal,
      writeErrors: this.writeErrorsTotal,
      rotated: this.rotatedTotal,
    };
  }

  /**
   * Emit one event. Builds the v2 envelope (version, sequence,
   * timestamp, sanitized payload), appends it to the thread file
   * and/or the stream. Never throws — write failures are counted.
   */
  emit(
    kind: HarnessV2EventKind | HarnessEventKind,
    botId: string,
    threadId: string,
    payload: Record<string, unknown>,
    at: string = new Date().toISOString(),
  ): HarnessV2Event {
    const event: HarnessV2Event = {
      v: HARNESS_V2_EVENT_VERSION,
      seq: this.seq++,
      at,
      kind: kind as HarnessV2Event['kind'],
      botId,
      threadId,
      payload: sanitizeHarnessPayload(kind as HarnessEventKind, payload),
    };
    const line = `${JSON.stringify(event)}\n`;
    this.emittedTotal += 1;
    if (this.dir !== undefined) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const file = path.join(this.dir, safeThreadFileName(threadId || 'harness'));
        this.rotateIfNeeded(file);
        fs.appendFileSync(file, line, 'utf8');
      } catch (err) {
        this.writeErrorsTotal += 1;
        this.warn(`ndjson export: cannot append event for thread ${threadId}: ${(err as Error).message}`);
      }
    }
    if (this.stream) {
      try {
        this.stream.write(line);
      } catch (err) {
        this.writeErrorsTotal += 1;
        this.warn(`ndjson export: cannot write stream: ${(err as Error).message}`);
      }
    }
    return event;
  }

  /** Read back the events for one thread (file sink only). */
  readThread(
    threadId: string,
    options: { limit?: number; offset?: number } = {},
  ): { threadId: string; events: HarnessV2Event[]; total: number } {
    if (this.dir === undefined) return { threadId, events: [], total: 0 };
    const base = safeThreadFileName(threadId || 'harness');
    const events: HarnessV2Event[] = [];
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => name === base || (name.startsWith(`${base}.`) && name.endsWith('.ndjson')))
        .sort((a, b) => {
          if (a === base) return 1;
          if (b === base) return -1;
          return a < b ? -1 : 1;
        });
      for (const name of files) {
        const { events: parsed } = readNdjsonEventFile(path.join(this.dir, name));
        events.push(...parsed);
      }
    } catch {
      // Directory missing — empty.
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const offset = Math.max(options.offset ?? 0, 0);
    return { threadId, events: events.slice(offset, offset + limit), total: events.length };
  }

  /** Threads with an export file (live files only, rotated files excluded). */
  listThreads(): string[] {
    if (this.dir === undefined) return [];
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => {
          if (!name.endsWith('.ndjson')) return false;
          const stripped = name.slice(0, -'.ndjson'.length);
          return !/\.\d+-\d+-\d+$/.test(stripped);
        })
        .map((name) => name.slice(0, -'.ndjson'.length));
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(file: string): void {
    try {
      const stat = fs.statSync(file);
      if (stat.size < this.maxFileBytes) return;
      const stamp = `${Date.now()}-${process.pid}-${this.rotateCounter++}`;
      const rotated = `${file}.${stamp}.ndjson`;
      fs.renameSync(file, rotated);
      this.rotatedTotal += 1;
      this.pruneOldRotated(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`ndjson export: cannot rotate ${file}: ${(err as Error).message}`);
      }
    }
  }

  private pruneOldRotated(liveFile: string): void {
    try {
      const prefix = `${path.basename(liveFile)}.`;
      const dirEntries = fs
        .readdirSync(this.dir as string)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, full: path.join(this.dir as string, name) }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      let total = 0;
      const sizes = new Map<string, number>();
      for (const entry of dirEntries) {
        const size = fs.statSync(entry.full).size;
        sizes.set(entry.name, size);
        total += size;
      }
      try {
        total += fs.statSync(liveFile).size;
      } catch {
        // Live file missing after rotate — ignore.
      }
      for (const entry of dirEntries) {
        if (total <= this.maxTotalBytes) break;
        try {
          fs.unlinkSync(entry.full);
          total -= sizes.get(entry.name) ?? 0;
        } catch {
          break;
        }
      }
    } catch {
      // Prune is best-effort.
    }
  }
}
