/**
 * Durable execution — public surface of `packages/core/src/durable/`.
 *
 * Crash-safe runs: an append-only journal per run, an active-run
 * registry with heartbeats, recovery candidates, and a resume path
 * that never re-executes a finished step. See `journal.ts` for the
 * entry kinds and `recovery.ts` for how interrupted runs are found.
 */
export { RunJournal } from './journal';
export type { JournalCheckpointData, JournalEntry, JournalEntryKind, JournalVerification } from './journal';
export { DurableSession } from './session';
export type { DurableSessionOptions } from './session';
export {
  ACTIVE_RUN_STALE_MS,
  ActiveRunRegistry,
  detectInterruptedRuns,
  isPidAlive,
  listRecoveryCandidates,
  scanResumableRuns,
} from './recovery';
export type { ActiveRunEntry, RecoveryCandidate } from './recovery';
export { DurableRunner, ReplayGuard, resumeRunFromJournal } from './resume';
export type { DurableResumeState } from './resume';
