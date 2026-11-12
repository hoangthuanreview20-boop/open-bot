/**
 * @open-bot/core automations — public surface for the automations module.
 * (v0.4; imported directly as `@open-bot/core/dist/automations/index.js`
 * until the core barrel `src/index.ts` gains these exports — see
 * docs/v04-worker2-integration.md.)
 */

export type {
  Automation,
  AutomationAccessPolicy,
  AutomationAction,
  AutomationCondition,
  AutomationEvent,
  AutomationEventKind,
  AutomationHandlers,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerPresentation,
  AutomationCronWindow,
} from './types';

export {
  automationDue,
  buildTriggerPresentation,
  cronMatches,
  describeTrigger,
  evaluateCondition,
  executeAutomation,
  getTriggerDescription,
  getTriggerPresentation,
  globMatch,
  isValidCronExpression,
  MAX_AUTOMATION_OUTPUT_CHARS,
  MAX_TRIGGER_INPUT_CHARS,
  nextCronOccurrence,
  nextRunAtFor,
  parseCronExpression,
  validateAutomation,
  validateForEnable,
} from './engine';
export type { CronFields, ExecuteAutomationOptions, ValidateForEnableOptions } from './engine';

export {
  computeWebhookSignature,
  handleWebhookDelivery,
  applyTriggerInputToAction,
  parseWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
} from './webhook';
export type { WebhookDeliveryOptions } from './webhook';

export {
  AUTOMATION_WEBHOOK_KEYS_NAMESPACE,
  createAutomationWebhookKey,
  deleteAutomationWebhookKey,
  getAutomationWebhookKey,
  hasAutomationWebhookKey,
  migrateAutomationWebhookKey,
  rotateAutomationWebhookKey,
} from './webhookKeys';
export type {
  AutomationWebhookKey,
  AutomationWebhookKeyStore,
  AutomationWebhookKeyStores,
  AutomationWebhookKeyStoreInput,
  DedicatedWebhookKeyStore,
} from './webhookKeys';

export {
  AUTOMATION_POLICY_ACTIONS,
  automationAccessAllows,
  automationPolicyDeniedMessage,
  canAutomationAction,
  createRolePolicyChecker,
  viewerAutomationCapabilities,
} from './policy';
export type {
  AutomationPolicyAction,
  AutomationPolicyChecker,
  AutomationPolicyCheckOptions,
  AutomationPolicyContext,
} from './policy';

export {
  AutomationScheduler,
  JsonFileAutomationStore,
  AUTOMATIONS_FILE,
  DEFAULT_EVENT_COOLDOWN_MS,
  MAX_RUN_HISTORY,
  missedGraceMs,
} from './scheduler';
export type { AutomationSchedulerOptions, AutomationStore, SeedSampleAutomationsResult, SkippedRunInfo, SlackInboundResult } from './scheduler';

export {
  buildDreamPrompt,
  DreamEngine,
  DEFAULT_DREAM_HISTORY_LIMIT,
  DEFAULT_DREAM_IDLE_MINUTES,
} from './dream';
export type { DreamConfig, DreamEngineOptions, DreamResult, DreamSkipReason } from './dream';

export { SAMPLE_AUTOMATIONS, sampleAutomations } from './samples';
