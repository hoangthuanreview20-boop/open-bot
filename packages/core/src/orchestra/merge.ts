/**
 * Merge — combine worker results into one document (v1.02 rescue
 * port of the v0.99 work).
 *
 * Outputs are joined in subtask order; conflicting file changes are
 * reported (same file changed by two workers = conflict, first
 * writer wins, the other is listed for the supervisor to resolve by
 * hand). `resolveFileConflicts` lets the supervisor pick a winner
 * per file explicitly instead of taking the first writer.
 */

import type { OrchestraSubtask, WorkerResult } from './types';

export interface MergedResult {
  /** Combined output (subtask sections in order). */
  combinedOutput: string;
  /** Files changed by exactly one worker. */
  filesChanged: string[];
  /** Files changed by more than one worker (first writer wins). */
  conflicts: Array<{ file: string; workers: string[] }>;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** Merge worker results into one document + conflict report. */
export function mergeResults(
  subtasks: OrchestraSubtask[],
  results: Map<string, WorkerResult>,
): MergedResult {
  const sections: string[] = [];
  const fileWriters = new Map<string, string[]>();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const subtask of subtasks) {
    if (subtask.status === 'done') succeeded++;
    else if (subtask.status === 'failed' || subtask.status === 'escalated') failed++;
    else if (subtask.status === 'skipped') skipped++;
    const result = results.get(subtask.id);
    if (result?.output) sections.push(`## ${subtask.title}\n${result.output}`);
    for (const file of result?.filesChanged ?? []) {
      const writers = fileWriters.get(file) ?? [];
      writers.push(subtask.id);
      fileWriters.set(file, writers);
    }
  }
  const filesChanged: string[] = [];
  const conflicts: MergedResult['conflicts'] = [];
  for (const [file, writers] of [...fileWriters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (writers.length === 1) filesChanged.push(file);
    else conflicts.push({ file, workers: writers });
  }
  return {
    combinedOutput: sections.join('\n\n'),
    filesChanged,
    conflicts,
    succeeded,
    failed,
    skipped,
  };
}

/**
 * Resolve file conflicts explicitly: `winners` maps a file to the
 * subtask id whose version wins. Files without an explicit winner
 * keep the first writer. Returns the winning subtask per file.
 */
export function resolveFileConflicts(
  merged: MergedResult,
  winners: Record<string, string>,
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const file of merged.filesChanged) {
    resolved.set(file, winners[file] ?? '');
  }
  for (const conflict of merged.conflicts) {
    const winner = winners[conflict.file];
    resolved.set(conflict.file, winner && conflict.workers.includes(winner) ? winner : conflict.workers[0]);
  }
  return resolved;
}
