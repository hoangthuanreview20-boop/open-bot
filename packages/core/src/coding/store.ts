/**
 * Append-only event store for coding runs (v1.02, Team T4).
 *
 * The store keeps every event of one run in memory, chains them with
 * SHA-256 hashes, can persist to / load from a JSONL file, verifies
 * sequence + hash integrity, and replays a log back into run state
 * (status, plan progress, files changed, checks, token usage).
 *
 * This is deliberately separate from the generic run log in
 * `event-log/`: coding events have their own types and replay rules,
 * and the module must stay usable without the rest of the agent loop.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ActionPayload,
  CheckResultPayload,
  CodingEvent,
  CodingEventPayload,
  CodingEventType,
  CodingRunStatus,
  FileChangedPayload,
  ObservationPayload,
  PlanCreatedPayload,
  PlanStepUpdatedPayload,
  ReasoningPayload,
  RunFinishedPayload,
  RunStartedPayload,
} from './events';

/** State rebuilt by replaying a run's events. */
export interface ReplayedRunState {
  runId: string;
  status: CodingRunStatus;
  task: string;
  workspaceRoot: string;
  model: string;
  /** Plan steps in order with their latest status. */
  plan: Array<{ id: string; description: string; status: string }>;
  /** Files changed during the run, keyed by path. */
  filesChanged: Record<string, { kind: string; linesAdded: number; linesRemoved: number }>;
  /** Check results in the order they ran. */
  checks: Array<{ name: string; passed: boolean }>;
  /** Last reasoning text, if any. */
  lastThought: string;
  /** Last observation summary, if any. */
  lastObservation: string;
  stepsUsed: number;
  events: number;
}

/** Result of verifying a store's integrity. */
export interface StoreVerification {
  ok: boolean;
  /** First sequence number that breaks continuity, if any. */
  badSeq?: number;
  /** First event whose hash does not match, if any. */
  badHashSeq?: number;
  reason?: string;
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Hash of one event, chained on the previous event's hash. */
export function hashEvent(
  prevHash: string,
  seq: number,
  runId: string,
  at: string,
  step: number,
  type: CodingEventType,
  payload: CodingEventPayload,
): string {
  const canonical = stableStringify({ prevHash, seq, runId, at, step, type, payload });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface EventStoreOptions {
  /** Directory to persist the JSONL log in (optional, in-memory only when omitted). */
  persistDir?: string;
  /** File name inside persistDir (default `<runId>.jsonl`). */
  fileName?: string;
}

/**
 * Append-only store for one coding run's events.
 *
 * Usage:
 *   const store = new CodingEventStore(runId);
 *   store.append('run.started', { task, workspaceRoot, model, maxSteps });
 *   ...
 *   store.verify();            // integrity check
 *   store.replay();            // rebuild state from events
 *   store.toJSONL();           // serialize for disk / export
 */
export class CodingEventStore {
  readonly runId: string;
  private readonly events: CodingEvent[] = [];
  private readonly persistPath: string | null;

  constructor(runId: string, options: EventStoreOptions = {}) {
    this.runId = runId;
    this.persistPath = options.persistDir
      ? path.join(options.persistDir, options.fileName ?? `${runId}.jsonl`)
      : null;
    if (this.persistPath) fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
  }

  /** All events in order. Returns a copy. */
  all(): CodingEvent[] {
    return [...this.events];
  }

  /** Number of events recorded. */
  get size(): number {
    return this.events.length;
  }

  /** Append one event. Returns the stored event (with seq + hash). */
  append(type: CodingEventType, payload: CodingEventPayload, step = 0): CodingEvent {
    const prev = this.events[this.events.length - 1];
    const seq = this.events.length + 1;
    const at = new Date().toISOString();
    const prevHash = prev ? prev.hash : '';
    const event: CodingEvent = {
      seq,
      runId: this.runId,
      at,
      step,
      type,
      payload,
      prevHash,
      hash: hashEvent(prevHash, seq, this.runId, at, step, type, payload),
    };
    this.events.push(event);
    if (this.persistPath) fs.appendFileSync(this.persistPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  /** Events of the given types, in order. */
  byType(...types: CodingEventType[]): CodingEvent[] {
    const wanted = new Set(types);
    return this.events.filter((e) => wanted.has(e.type));
  }

  /** Events recorded during one loop step. */
  byStep(step: number): CodingEvent[] {
    return this.events.filter((e) => e.step === step);
  }

  /** Verify sequence continuity and the hash chain. */
  verify(): StoreVerification {
    let prevHash = '';
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i] as CodingEvent;
      if (e.seq !== i + 1) {
        return { ok: false, badSeq: e.seq, reason: `expected seq ${i + 1}, got ${e.seq}` };
      }
      if (e.prevHash !== prevHash) {
        return { ok: false, badHashSeq: e.seq, reason: `prevHash mismatch at seq ${e.seq}` };
      }
      const recomputed = hashEvent(e.prevHash, e.seq, e.runId, e.at, e.step, e.type, e.payload);
      if (recomputed !== e.hash) {
        return { ok: false, badHashSeq: e.seq, reason: `hash mismatch at seq ${e.seq}` };
      }
      prevHash = e.hash;
    }
    return { ok: true };
  }

  /** Serialize the whole log as JSONL (one event per line). */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n');
  }

  /** Load a store from JSONL text. Throws on malformed lines. */
  static fromJSONL(runId: string, text: string): CodingEventStore {
    const store = new CodingEventStore(runId);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line) as CodingEvent;
      if (event.runId !== runId) {
        throw new Error(`fromJSONL: event runId ${event.runId} does not match ${runId}`);
      }
      store.events.push(event);
    }
    return store;
  }

  /** Load a store from a JSONL file. */
  static fromFile(filePath: string): CodingEventStore {
    const text = fs.readFileSync(filePath, 'utf8');
    const runId = path.basename(filePath, '.jsonl');
    return CodingEventStore.fromJSONL(runId, text);
  }

  /**
   * Replay the log into run state. Pure reduction over events — the
   * same log always rebuilds the same state.
   */
  replay(): ReplayedRunState {
    const state: ReplayedRunState = {
      runId: this.runId,
      status: 'running',
      task: '',
      workspaceRoot: '',
      model: '',
      plan: [],
      filesChanged: {},
      checks: [],
      lastThought: '',
      lastObservation: '',
      stepsUsed: 0,
      events: this.events.length,
    };
    for (const event of this.events) {
      state.stepsUsed = Math.max(state.stepsUsed, event.step);
      switch (event.type) {
        case 'run.started': {
          const p = event.payload as RunStartedPayload;
          state.task = p.task;
          state.workspaceRoot = p.workspaceRoot;
          state.model = p.model;
          break;
        }
        case 'plan.created': {
          const p = event.payload as PlanCreatedPayload;
          state.plan = p.stepIds.map((id, i) => ({
            id,
            description: p.steps[i] ?? id,
            status: 'pending',
          }));
          break;
        }
        case 'plan.step.updated': {
          const p = event.payload as PlanStepUpdatedPayload;
          const step = state.plan.find((s) => s.id === p.stepId);
          if (step) step.status = p.status;
          break;
        }
        case 'reasoning': {
          state.lastThought = (event.payload as ReasoningPayload).thought;
          break;
        }
        case 'observation': {
          state.lastObservation = (event.payload as ObservationPayload).summary;
          break;
        }
        case 'file.changed': {
          const p = event.payload as FileChangedPayload;
          state.filesChanged[p.path] = {
            kind: p.kind,
            linesAdded: p.linesAdded ?? 0,
            linesRemoved: p.linesRemoved ?? 0,
          };
          break;
        }
        case 'check.result': {
          const p = event.payload as CheckResultPayload;
          state.checks.push({ name: p.name, passed: p.passed });
          break;
        }
        case 'run.finished': {
          const p = event.payload as RunFinishedPayload;
          state.status = p.status;
          break;
        }
        default:
          break;
      }
    }
    return state;
  }
}

/** Type guard helper for tests / inspectors: is this event a file change? */
export function isFileChangeEvent(e: CodingEvent): boolean {
  return e.type === 'file.changed';
}

/** Extract the action payload of an action event, if it is one. */
export function asActionPayload(e: CodingEvent): ActionPayload | null {
  return e.type === 'action.proposed' || e.type === 'action.executed'
    ? (e.payload as ActionPayload)
    : null;
}
