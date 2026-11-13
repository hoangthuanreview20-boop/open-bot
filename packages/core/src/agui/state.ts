/**
 * AG-UI run state store (v0.97, Team T3).
 *
 * The agent and the user share one small piece of state per run: the
 * agent publishes a snapshot at run start and deltas afterwards
 * (STATE_SNAPSHOT / STATE_DELTA events), and any consumer — the
 * desktop feed, an SSE dashboard — can read the current state without
 * replaying the whole event stream.
 *
 * The store is deliberately boring:
 * - State is a flat-ish JSON object (max 64 top-level keys, depth 4 —
 *   the same caps the validator enforces, so a snapshot that passed
 *   validation always fits).
 * - Deltas are JSON-patch-style operations (`set` / `delete` /
 *   `append`) on dot-separated paths. `append` only works on arrays
 *   (or on a missing path, which becomes a one-item array).
 * - Prototype-polluting paths (`__proto__`, `constructor`,
 *   `prototype`) are rejected — the validator already rejects them,
 *   this store rejects them again so a direct caller cannot smuggle
 *   one past validation.
 * - The store keeps a version counter per run (the sequence of the
 *   last applied event) so a consumer can tell whether its copy is
 *   stale, and a short history of applied deltas for debugging.
 * - Nothing here touches the network, the disk, or a provider. It is
 *   pure in-memory state, safe to use from the runtime emitter and
 *   from tests alike.
 */

import { validateAgUiStateOperation } from './validate';
import type { AgUiStateOperation } from './types';

/** Maximum number of applied deltas kept per run (debugging history). */
export const AG_UI_STATE_HISTORY_LIMIT = 50;

/** One run's shared state, as a consumer reads it. */
export interface AgUiRunState {
  runId: string;
  botId?: string;
  /** Current state object (a copy — mutating it cannot corrupt the store). */
  state: Record<string, unknown>;
  /** Sequence of the last event applied (snapshot or delta). */
  version: number;
  /** ISO timestamp of the last applied event. */
  updatedAt: string;
  /** How many snapshots + deltas have been applied to this run. */
  appliedEvents: number;
}

interface StoredRun {
  runId: string;
  botId?: string;
  state: Record<string, unknown>;
  version: number;
  updatedAt: string;
  appliedEvents: number;
  history: Array<{ sequence: number; operations: AgUiStateOperation[] }>;
}

function cloneState(state: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function isSafePathPart(part: string): boolean {
  return part !== '__proto__' && part !== 'constructor' && part !== 'prototype';
}

function splitPath(path: string): string[] {
  return path.split('.').filter((part) => part.length > 0);
}

/** Apply one operation to `state` in place. Throws on an illegal path. */
function applyOperation(state: Record<string, unknown>, op: AgUiStateOperation): void {
  const parts = splitPath(op.path);
  if (parts.length === 0) throw new Error('AG-UI state path must not be empty.');
  if (!parts.every(isSafePathPart)) {
    throw new Error('AG-UI state path must not touch prototype properties.');
  }
  if (op.op === 'delete') {
    let node: Record<string, unknown> = state;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) return;
      node = next as Record<string, unknown>;
    }
    delete node[parts[parts.length - 1]];
    return;
  }
  if (op.op === 'append') {
    let node: Record<string, unknown> = state;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        node[part] = created;
        node = created;
      } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        node = next as Record<string, unknown>;
      } else {
        throw new Error(`AG-UI state path "${op.path}" does not lead through objects.`);
      }
    }
    const last = parts[parts.length - 1];
    const current = node[last];
    if (current === undefined) {
      node[last] = [op.value === undefined ? null : JSON.parse(JSON.stringify(op.value))];
    } else if (Array.isArray(current)) {
      current.push(op.value === undefined ? null : JSON.parse(JSON.stringify(op.value)));
    } else {
      throw new Error(`AG-UI state path "${op.path}" is not an array, cannot append.`);
    }
    return;
  }
  // op === 'set'
  let node: Record<string, unknown> = state;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      throw new Error(`AG-UI state path "${op.path}" does not lead through objects.`);
    }
  }
  node[parts[parts.length - 1]] =
    op.value === undefined ? null : JSON.parse(JSON.stringify(op.value));
}

export class AgUiStateStore {
  private readonly runs = new Map<string, StoredRun>();

  /** Number of runs currently tracked. */
  get runCount(): number {
    return this.runs.size;
  }

  /** Run ids currently tracked, in insertion order. */
  runIds(): string[] {
    return [...this.runs.keys()];
  }

  /**
   * Replace a run's state with a snapshot. `version` is the sequence
   * of the snapshot event; a snapshot with an older version than the
   * stored one is ignored (out-of-order delivery must not rewind
   * state). Returns the stored state, or `null` when ignored.
   */
  applySnapshot(
    runId: string,
    state: Record<string, unknown>,
    version: number,
    opts?: { botId?: string; updatedAt?: string },
  ): AgUiRunState | null {
    const existing = this.runs.get(runId);
    if (existing && version < existing.version) return null;
    const stored: StoredRun = {
      runId,
      botId: opts?.botId ?? existing?.botId,
      state: cloneState(state),
      version,
      updatedAt: opts?.updatedAt ?? new Date().toISOString(),
      appliedEvents: (existing?.appliedEvents ?? 0) + 1,
      history: existing?.history ?? [],
    };
    this.runs.set(runId, stored);
    return this.toPublic(stored);
  }

  /**
   * Apply delta operations on top of the stored state. When the run
   * has no state yet, the delta applies to an empty object (a run may
   * legitimately start with deltas before its first snapshot). A
   * delta with an older version than the stored one is ignored.
   * Invalid operations are validated first — the whole delta is
   * rejected when any operation is invalid, so state never ends up
   * half-applied. Returns the stored state, or `null` when ignored.
   */
  applyDelta(
    runId: string,
    operations: AgUiStateOperation[],
    version: number,
    opts?: { botId?: string; updatedAt?: string },
  ): AgUiRunState | null {
    const validated = operations.map((op) => validateAgUiStateOperation(op));
    const existing = this.runs.get(runId);
    if (existing && version < existing.version) return null;
    const working: StoredRun =
      existing ??
      {
        runId,
        botId: opts?.botId,
        state: {},
        version: -1,
        updatedAt: opts?.updatedAt ?? new Date().toISOString(),
        appliedEvents: 0,
        history: [],
      };
    // Apply on a copy first: a failing operation mid-delta must not
    // leave half-applied state behind.
    const nextState = cloneState(working.state);
    for (const op of validated) applyOperation(nextState, op);
    working.state = nextState;
    working.version = version;
    working.updatedAt = opts?.updatedAt ?? new Date().toISOString();
    working.appliedEvents += 1;
    if (opts?.botId !== undefined) working.botId = opts.botId;
    working.history.push({ sequence: version, operations: validated });
    while (working.history.length > AG_UI_STATE_HISTORY_LIMIT) working.history.shift();
    this.runs.set(runId, working);
    return this.toPublic(working);
  }

  /** Read a run's current state (a copy), or `undefined` when unknown. */
  get(runId: string): AgUiRunState | undefined {
    const stored = this.runs.get(runId);
    return stored ? this.toPublic(stored) : undefined;
  }

  /** Read one top-level key of a run's state (a copy), or `undefined`. */
  getKey(runId: string, key: string): unknown {
    const stored = this.runs.get(runId);
    if (!stored) return undefined;
    const value = stored.state[key];
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /** Applied-delta history of a run (newest last), for debugging. */
  history(runId: string): Array<{ sequence: number; operations: AgUiStateOperation[] }> {
    const stored = this.runs.get(runId);
    if (!stored) return [];
    return stored.history.map((entry) => ({
      sequence: entry.sequence,
      operations: entry.operations.map((op) => ({ ...op })),
    }));
  }

  /** Forget one run's state. Returns true when a run was removed. */
  clearRun(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /** Forget every run's state. */
  clearAll(): void {
    this.runs.clear();
  }

  private toPublic(stored: StoredRun): AgUiRunState {
    return {
      runId: stored.runId,
      ...(stored.botId !== undefined ? { botId: stored.botId } : {}),
      state: cloneState(stored.state),
      version: stored.version,
      updatedAt: stored.updatedAt,
      appliedEvents: stored.appliedEvents,
    };
  }
}

/**
 * Apply a delta to a plain state object without a store (pure helper
 * for the renderer feed reducer and for tests). Returns a new object;
 * the input is never mutated. Throws on an invalid operation.
 */
export function applyAgUiStateDelta(
  state: Record<string, unknown>,
  operations: AgUiStateOperation[],
): Record<string, unknown> {
  const validated = operations.map((op) => validateAgUiStateOperation(op));
  const next = cloneState(state);
  for (const op of validated) applyOperation(next, op);
  return next;
}
