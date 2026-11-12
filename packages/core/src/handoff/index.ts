/**
 * Handoff phiên làm việc — public surface (v0.37, P1-3).
 * Record bền để chuyển giao công việc giữa các bot/phiên (khác handoff
 * trực tiếp `transfer_to_X` ở `agent/handoff.ts`).
 */

export {
  SESSION_HANDOFF_FORMAT_VERSION,
  SESSION_HANDOFFS_FILE_NAME,
  MAX_SESSION_HANDOFFS,
} from './types';
export type {
  AcceptedHandoffConfirmation,
  SessionHandoffBlocker,
  SessionHandoffDecision,
  SessionHandoffMessage,
  SessionHandoffRecord,
  SessionHandoffSummary,
  SessionHandoffWorkStatus,
} from './types';
export {
  acceptedHandoffConfirmation,
  createSessionHandoff,
  formatSessionHandoffForPrompt,
  HANDOFF_WORK_STATUSES,
  MAX_HANDOFF_BLOCKERS,
  MAX_HANDOFF_CONTEXT_CHARS,
  MAX_HANDOFF_DECISIONS,
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_FILE_CHARS,
  MAX_HANDOFF_LIST_ITEMS,
  MAX_HANDOFF_LIST_ITEM_CHARS,
  MAX_HANDOFF_NEXT_STEP_CHARS,
  MAX_HANDOFF_STATE_CHARS,
  MAX_HANDOFF_SUMMARY_CHARS,
  MAX_HANDOFF_TITLE_CHARS,
  MAX_SESSION_HANDOFF_TRANSCRIPT_CHARS,
  parseSessionHandoffRecord,
  redactHandoffText,
  sessionHandoffSummary,
} from './record';
export type { CreateSessionHandoffInput, CreateSessionHandoffOptions } from './record';
export { SessionHandoffStore } from './store';
export type { ListSessionHandoffsFilter, MarkAcceptedInput } from './store';
