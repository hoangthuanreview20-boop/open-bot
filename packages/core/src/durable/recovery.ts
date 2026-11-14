/**
 * Crash recovery — find runs that can be resumed (v1.02 rescue port
 * of the v0.99 work).
 *
 * Two sources, merged and de-duplicated by runId:
 * - `ActiveRunRegistry` (`active-runs.json`, atomic writes): runs
 *   whose process died or whose heartbeat is older than 60s, and
 *   whose journal has no `run_finished`.
 * - `scanResumableRuns`: scan the journal directory; any run with a
 *   checkpoint but no `run_finished` is resumable (no registry needed).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RunJournal } from './journal';

/** Heartbeat older than this means the run's process is gone (60s). */
export const ACTIVE_RUN_STALE_MS = 60_000;

export interface ActiveRunEntry {
  runId: string;
  botId?: string;
  startedAt: string;
  lastHeartbeatAt: string;
  pid: number;
}

export interface RecoveryCandidate {
  runId: string;
  botId?: string;
  /** 'registry' = dead pid / stale heartbeat; 'journal' = checkpoint without finish. */
  source: 'registry' | 'journal';
  lastCheckpointAt?: string;
  journalPath?: string;
}

/** Registry of runs currently alive (JSON file, atomic writes). */
export class ActiveRunRegistry {
  private readonly filePath: string;
  private entries = new Map<string, ActiveRunEntry>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  register(runId: string, botId?: string): ActiveRunEntry {
    const now = new Date().toISOString();
    const entry: ActiveRunEntry = { runId, botId, startedAt: now, lastHeartbeatAt: now, pid: process.pid };
    this.entries.set(runId, entry);
    this.persist();
    return entry;
  }

  heartbeat(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry) return false;
    entry.lastHeartbeatAt = new Date().toISOString();
    this.persist();
    return true;
  }

  unregister(runId: string): boolean {
    const removed = this.entries.delete(runId);
    if (removed) this.persist();
    return removed;
  }

  get(runId: string): ActiveRunEntry | undefined {
    return this.entries.get(runId);
  }

  list(): ActiveRunEntry[] {
    return [...this.entries.values()];
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'object' && entry !== null && typeof (entry as ActiveRunEntry).runId === 'string') {
            this.entries.set((entry as ActiveRunEntry).runId, entry as ActiveRunEntry);
          }
        }
      }
    } catch {
      this.entries = new Map();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Registry is best-effort; a failed write must not break the run.
    }
  }
}

/** Is this process alive? (Used to tell a dead pid from a live one.) */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs in the registry whose process died or heartbeat went stale. */
export function detectInterruptedRuns(
  registry: ActiveRunRegistry,
  journalDir: string,
  now = Date.now(),
  staleMs = ACTIVE_RUN_STALE_MS,
): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = [];
  for (const entry of registry.list()) {
    const pidDead = entry.pid !== process.pid && !isPidAlive(entry.pid);
    const stale = now - Date.parse(entry.lastHeartbeatAt) > staleMs;
    if (!pidDead && !stale) continue;
    const journalPath = path.join(journalDir, `${entry.runId}.journal.jsonl`);
    const verification = RunJournal.verifyJournal(journalPath);
    if (verification.finished || verification.entries === 0) continue;
    candidates.push({
      runId: entry.runId,
      botId: entry.botId,
      source: 'registry',
      journalPath,
    });
  }
  return candidates;
}

/** Scan the journal dir: runs with a checkpoint but no `run_finished` are resumable. */
export function scanResumableRuns(journalDir: string): RecoveryCandidate[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.journal.jsonl'));
  } catch {
    return [];
  }
  const candidates: RecoveryCandidate[] = [];
  for (const file of files) {
    const full = path.join(journalDir, file);
    const verification = RunJournal.verifyJournal(full);
    if (!verification.hasCheckpoint || verification.finished) continue;
    const runId = file.slice(0, -'.journal.jsonl'.length);
    const replay = RunJournal.replayEntries(full);
    candidates.push({
      runId,
      source: 'journal',
      journalPath: full,
      lastCheckpointAt: replay.lastCheckpoint ? new Date().toISOString() : undefined,
    });
  }
  return candidates;
}

/** Merge both sources, de-duplicated by runId (registry wins on conflict). */
export function listRecoveryCandidates(registry: ActiveRunRegistry, journalDir: string, now = Date.now()): RecoveryCandidate[] {
  const byId = new Map<string, RecoveryCandidate>();
  for (const candidate of scanResumableRuns(journalDir)) byId.set(candidate.runId, candidate);
  for (const candidate of detectInterruptedRuns(registry, journalDir, now)) byId.set(candidate.runId, candidate);
  return [...byId.values()].sort((a, b) => (a.runId < b.runId ? -1 : 1));
}
