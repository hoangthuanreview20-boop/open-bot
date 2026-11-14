/**
 * Orchestra events (v1.02 rescue port of the v0.99 work).
 *
 * Every state change in an orchestration session is an event
 * (append-only, in order) so the UI can show a timeline and the
 * supervisor can audit what happened.
 */

export type OrchestraEventKind =
  | 'session_created'
  | 'session_started'
  | 'session_finished'
  | 'subtask_created'
  | 'subtask_assigned'
  | 'subtask_started'
  | 'subtask_done'
  | 'subtask_failed'
  | 'subtask_skipped'
  | 'subtask_escalated'
  | 'subtask_retried'
  | 'handoff_sent'
  | 'merge_done';

export interface OrchestraEvent {
  seq: number;
  at: string;
  sessionId: string;
  kind: OrchestraEventKind;
  subtaskId?: string;
  workerId?: string;
  message?: string;
}

/** Append-only event log for one session. */
export class OrchestraEventLog {
  private readonly events: OrchestraEvent[] = [];
  private seq = 0;

  append(event: Omit<OrchestraEvent, 'seq' | 'at'> & { at?: string }): OrchestraEvent {
    const full: OrchestraEvent = {
      ...event,
      seq: ++this.seq,
      at: event.at ?? new Date().toISOString(),
    };
    this.events.push(full);
    return full;
  }

  list(): OrchestraEvent[] {
    return [...this.events];
  }

  forSubtask(subtaskId: string): OrchestraEvent[] {
    return this.events.filter((e) => e.subtaskId === subtaskId);
  }

  get size(): number {
    return this.events.length;
  }
}
