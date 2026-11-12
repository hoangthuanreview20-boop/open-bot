/**
 * @open-bot/core guardrails — public surface for the guardrails module
 * (v0.10; BEYOND-ROADMAP items 5–6, research P0-5).
 *
 * Rule-based (no model) input / output / tool guardrails, blocking +
 * parallel modes. Wiring into the agent loop is done by the coordinator
 * in a later step; this module ships the API + rules + tests only.
 */

export type {
  GuardrailContext,
  GuardrailDefinition,
  GuardrailLayer,
  GuardrailMode,
  GuardrailResult,
  GuardrailSeverity,
  GuardrailSpan,
  GuardrailViolation,
} from './types';
export { GuardrailTripwireError } from './types';

export {
  applyRedactions,
  BUILTIN_GUARDRAILS,
  createPiiGuardrail,
  createPromptInjectionGuardrail,
  createScopeGuardrail,
  createSecretGuardrail,
  createToolInjectionGuardrail,
  createToolPathGuardrail,
  createToolSecretGuardrail,
  INJECTION_PATTERNS,
  luhnValid,
  PII_PATTERNS,
  redactOutputText,
  REDACTED,
  SECRET_PATTERNS,
} from './builtin';
export type { NamedPattern, ScopeGuardrailOptions } from './builtin';

export { createDefaultRegistry, GuardrailRegistry } from './registry';
export type { GuardrailModeConfig, GuardrailRegistryOptions } from './registry';
