/**
 * Auto-approve rules (v0.35, P1-7): user-configured allowlist rules that
 * let safe tool calls run without a manual approval click. See
 * `./rules.ts` for the safety model (fail-closed, denylist always wins).
 */
export {
  AUTO_APPROVE_RULES_FILE_NAME,
  AUTO_APPROVE_RULES_FILE_VERSION,
  AutoApproveRuleStore,
  findMatchingAutoApproveRule,
  matchAutoApproveRule,
  matchesArgsPattern,
  MAX_AUTO_APPROVE_NOTE_CHARS,
  validateAutoApproveRuleInput,
} from './rules';
export type {
  AutoApproveMatchInput,
  AutoApproveRule,
  AutoApproveRuleInput,
  AutoApproveRuleKind,
  AutoApproveRuleScope,
} from './rules';
export {
  BOT_APPROVAL_LEVELS,
  DEFAULT_BOT_APPROVAL_LEVEL,
  decideApprovalLevel,
  isBotApprovalLevel,
  parseBotApprovalLevel,
  shouldAskForCall,
} from './levels';
export type { ApprovalLevelDecisionInput, BotApprovalLevel } from './levels';
export {
  CARD_ARGS_SUMMARY_MAX_CHARS,
  REDACTED_ARG,
  isPathInsideWorkspace,
  isSelfReadCall,
  isSelfReadShellCommand,
  summarizeArgsForCard,
} from './selfRead';
