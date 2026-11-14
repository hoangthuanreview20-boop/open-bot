/**
 * Handoff envelopes — what a worker receives for one subtask (v1.02
 * rescue port of the v0.99 work).
 *
 * Workers receive work as a handoff envelope: the subtask, the
 * shared context they need, and the priority in words — never a raw
 * internal object. The envelope is versioned (v1) and validated
 * fail-closed on receipt.
 */

import type { OrchestraSubtask, WorkerResult } from './types';
import { priorityToWord } from './types';

/** The envelope a worker receives for one subtask. */
export interface HandoffEnvelope {
  /** Envelope version (1). */
  version: 1;
  sessionId: string;
  subtaskId: string;
  title: string;
  detail?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** Shared context the worker may need (blackboard snapshot, read-only). */
  context: Record<string, unknown>;
  /** Results of the subtasks this one depends on. */
  dependencyResults: Record<string, WorkerResult>;
  /** Where to send the result (the supervisor collects it). */
  replyTo: 'supervisor';
}

/** Build a handoff envelope for a subtask. */
export function buildHandoffEnvelope(
  sessionId: string,
  subtask: OrchestraSubtask,
  context: Record<string, unknown>,
  dependencyResults: Record<string, WorkerResult>,
): HandoffEnvelope {
  return {
    version: 1,
    sessionId,
    subtaskId: subtask.id,
    title: subtask.title,
    ...(subtask.detail ? { detail: subtask.detail } : {}),
    priority: priorityToWord(subtask.priority),
    context,
    dependencyResults,
    replyTo: 'supervisor',
  };
}

/** Validate a handoff envelope shape (fail-closed on bad input). */
export function isValidHandoffEnvelope(value: unknown): value is HandoffEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as HandoffEnvelope;
  return (
    envelope.version === 1 &&
    typeof envelope.sessionId === 'string' &&
    typeof envelope.subtaskId === 'string' &&
    typeof envelope.title === 'string' &&
    typeof envelope.context === 'object' &&
    envelope.context !== null
  );
}
