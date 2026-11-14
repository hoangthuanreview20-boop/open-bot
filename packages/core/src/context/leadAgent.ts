/**
 * Lead agent — split a goal, delegate to workers, collect results
 * (v1.02 rescue port of the v1.00 work).
 *
 * The lead agent does not run workers itself: the host injects a
 * `delegate` callback (a subagent run, a coordinator bot, a tool
 * call). The module owns the decomposition contract: every subtask
 * gets an id, a description, its dependencies, and a place to put
 * its result. Dependencies run in topological order; independent
 * subtasks run in the same wave. A failed subtask fails the wave
 * only when it is marked `required` — optional subtasks are skipped
 * with their error recorded.
 */

export interface LeadSubtask {
  id: string;
  title: string;
  detail?: string;
  dependsOn?: string[];
  /** When false, a failure skips the subtask instead of failing the run. */
  required?: boolean;
}

export interface LeadSubtaskResult {
  subtaskId: string;
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface LeadRunResult {
  ok: boolean;
  results: LeadSubtaskResult[];
  /** Results in subtask order, joined for the caller. */
  combinedOutput: string;
}

/** A worker that executes one subtask. */
export type LeadDelegate = (subtask: LeadSubtask, context: { resultsSoFar: Map<string, LeadSubtaskResult> }) => Promise<string>;

/** Split a goal into waves and run them through a delegate. */
export class LeadAgent {
  private readonly delegate: LeadDelegate;

  constructor(delegate: LeadDelegate) {
    this.delegate = delegate;
  }

  /** Topologically sort subtasks into waves (independent first). Throws on cycles. */
  static planWaves(subtasks: LeadSubtask[]): LeadSubtask[][] {
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    for (const subtask of subtasks) {
      for (const dep of subtask.dependsOn ?? []) {
        if (!byId.has(dep)) throw new Error(`subtask ${subtask.id} depends on unknown subtask ${dep}`);
      }
    }
    const done = new Set<string>();
    const waves: LeadSubtask[][] = [];
    const remaining = new Map(byId);
    while (remaining.size > 0) {
      const wave = [...remaining.values()].filter((s) => (s.dependsOn ?? []).every((dep) => done.has(dep)));
      if (wave.length === 0) {
        throw new Error(`dependency cycle among subtasks: ${[...remaining.keys()].join(', ')}`);
      }
      waves.push(wave);
      for (const subtask of wave) {
        remaining.delete(subtask.id);
        done.add(subtask.id);
      }
    }
    return waves;
  }

  /** Run all subtasks wave by wave. */
  async run(subtasks: LeadSubtask[]): Promise<LeadRunResult> {
    const waves = LeadAgent.planWaves(subtasks);
    const results = new Map<string, LeadSubtaskResult>();
    let failedRequired = false;
    for (const wave of waves) {
      if (failedRequired) break;
      const waveResults = await Promise.all(
        wave.map(async (subtask) => {
          const started = Date.now();
          try {
            const output = await this.delegate(subtask, { resultsSoFar: results });
            const result: LeadSubtaskResult = { subtaskId: subtask.id, ok: true, output, durationMs: Date.now() - started };
            results.set(subtask.id, result);
            return result;
          } catch (error) {
            const result: LeadSubtaskResult = {
              subtaskId: subtask.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              durationMs: Date.now() - started,
            };
            results.set(subtask.id, result);
            if (subtask.required !== false) failedRequired = true;
            return result;
          }
        }),
      );
      void waveResults;
    }
    const ordered = subtasks.map((s) => results.get(s.id)!).filter(Boolean);
    const ok = ordered.every((r) => r.ok || subtasks.find((s) => s.id === r.subtaskId)?.required === false);
    const combinedOutput = ordered
      .filter((r) => r.ok && r.output)
      .map((r) => `## ${r.subtaskId}\n${r.output}`)
      .join('\n\n');
    return { ok, results: ordered, combinedOutput };
  }
}
