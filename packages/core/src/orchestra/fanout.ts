/**
 * Fan-out / fan-in + merge (v1.02 rescue port of the v0.99 work).
 *
 * Fan-out runs independent subtasks in parallel waves (topological
 * order on `dependsOn`); fan-in collects the results. `mergeResults`
 * combines worker outputs into one document: outputs are joined in
 * subtask order, conflicting file changes are reported (same file
 * changed by two workers = conflict, first writer wins, the other
 * is listed for the supervisor to resolve by hand).
 */

import type { OrchestraSubtask } from './types';

export interface FanOutPlan {
  /** Waves of subtask ids (one wave runs in parallel). */
  waves: string[][];
}

/** Split subtasks into parallel waves (topological order). Throws on cycles / unknown deps. */
export function planFanOut(subtasks: OrchestraSubtask[]): FanOutPlan {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  for (const subtask of subtasks) {
    for (const dep of subtask.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`subtask ${subtask.id} depends on unknown subtask ${dep}`);
    }
  }
  const done = new Set<string>();
  const waves: string[][] = [];
  const remaining = new Map(byId);
  while (remaining.size > 0) {
    const wave = [...remaining.values()]
      .filter((s) => (s.dependsOn ?? []).every((dep) => done.has(dep)))
      .map((s) => s.id);
    if (wave.length === 0) {
      throw new Error(`dependency cycle among subtasks: ${[...remaining.keys()].join(', ')}`);
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return { waves };
}

/** Run one wave in parallel through a worker function. */
export async function runFanOutWave<T>(
  subtaskIds: string[],
  runOne: (subtaskId: string) => Promise<T>,
): Promise<Array<{ subtaskId: string; ok: boolean; value?: T; error?: string }>> {
  return Promise.all(
    subtaskIds.map(async (subtaskId) => {
      try {
        const value = await runOne(subtaskId);
        return { subtaskId, ok: true as const, value };
      } catch (error) {
        return { subtaskId, ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
