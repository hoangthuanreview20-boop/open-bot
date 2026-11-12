/**
 * Guardrail types (v0.10, BEYOND-ROADMAP item 5–6; research P0-5).
 *
 * A guardrail is a cheap, rule-based check (no model call) that runs at
 * one of three layers:
 * - `input`  — user text / pasted content / `web_fetch` results, before
 *   the turn reaches the model (prompt injection).
 * - `output` — the model's final answer, before it reaches the user
 *   (leaked secrets / PII).
 * - `tool`   — tool arguments, before the tool executes (path escapes,
 *   secrets smuggled into args, injected instructions).
 *
 * Two modes (research P0-5, OpenAI Agents SDK pattern):
 * - `blocking` — cheap, runs first; the first blocking violation stops
 *   the check and the run must not proceed.
 * - `parallel` — fast, runs alongside; every guardrail runs and every
 *   violation is recorded, but nothing is blocked (observe-only).
 *
 * A violation's `severity` decides whether it can block: `block`
 * violations block in blocking mode; `warn` violations never block —
 * they are only recorded (e.g. a user pasting their own API key as
 * input is flagged, not refused).
 *
 * Wiring into the agent loop (head/end of turn + before each tool call)
 * is NOT done here — the coordinator does that in a later step. This
 * module only ships a clean API + rules + tests.
 */

/** Where a guardrail runs: input text, final output, or tool arguments. */
export type GuardrailLayer = 'input' | 'output' | 'tool';

/** How a guardrail check is executed. */
export type GuardrailMode = 'blocking' | 'parallel';

/** Whether a violation can stop the run (`block`) or is only recorded (`warn`). */
export type GuardrailSeverity = 'block' | 'warn';

/** Byte/char offsets of the offending text inside the checked string. */
export interface GuardrailSpan {
  /** Inclusive start offset (string index). */
  start: number;
  /** Exclusive end offset (string index). */
  end: number;
  /** The matched text, if it is safe to keep (never a raw secret). */
  text?: string;
}

/** One rule that fired. */
export interface GuardrailViolation {
  /** Id of the guardrail that fired, e.g. `prompt-injection`. */
  guardrailId: string;
  /** Layer the check ran at. */
  layer: GuardrailLayer;
  /** `block` stops the run in blocking mode; `warn` never blocks. */
  severity: GuardrailSeverity;
  /** Short machine-readable code, e.g. `secret.openai-key`, `pii.email`. */
  code: string;
  /** Human-readable reason (must never contain a raw secret). */
  reason: string;
  /** Where the offending text sits, when the checked value is a string. */
  span?: GuardrailSpan;
}

/** Context handed to every guardrail check. */
export interface GuardrailContext {
  /** Layer the check runs at. */
  layer: GuardrailLayer;
  /** Workspace root — tool-layer path checks resolve against this. */
  workspaceDir?: string;
  /** Tool being called, for the `tool` layer. */
  toolName?: string;
  /** Secrets already known (e.g. from the Vault) — redacted on sight. */
  knownSecrets?: string[];
  /** Where the checked text came from, e.g. `web_fetch`, `paste`, `user`. */
  source?: string;
}

/** Result of running the guardrails for one layer. */
export interface GuardrailResult {
  /** True when the run may proceed (no blocking violation in blocking mode). */
  passed: boolean;
  /** True when a blocking violation stopped the check (blocking mode only). */
  blocked: boolean;
  /** Mode the check ran in. */
  mode: GuardrailMode;
  /** Layer that was checked. */
  layer: GuardrailLayer;
  /** Every violation found (in blocking mode: up to the first blocker). */
  violations: GuardrailViolation[];
  /**
   * Output layer only: the checked text with every secret/PII span
   * replaced by `<redacted>` (see `util/redact.ts`). Present when the
   * checked value was a string and at least one violation has a span.
   * Callers that block should show this instead of the raw text; callers
   * in parallel mode can log it.
   */
  redactedText?: string;
}

/**
 * A single guardrail rule. `check` receives the value to inspect —
 * a string for `input`/`output`, the tool-args record for `tool` —
 * plus context. It may be sync or async (model-based guardrails in a
 * later wave will be async); rule-based built-ins are sync.
 */
export interface GuardrailDefinition {
  /** Stable id, e.g. `prompt-injection`, `secret`, `pii`, `tool-path`. */
  id: string;
  /** Layer this guardrail applies to. */
  layer: GuardrailLayer;
  /** One-line description for logs / UI. */
  description: string;
  /** Start disabled when false (default true). */
  enabled?: boolean;
  /** Run the rule; return every violation found (empty = clean). */
  check: (
    value: unknown,
    ctx: GuardrailContext,
  ) => GuardrailViolation[] | Promise<GuardrailViolation[]>;
}

/**
 * Thrown by `GuardrailRegistry.enforce()` when a blocking-mode check
 * trips — the OpenAI Agents SDK calls this a tripwire
 * (`InputGuardrailTripwireTriggered`). The coordinator catches it at
 * the loop boundary (start/end of turn, before a tool call) and turns
 * it into a safe refusal instead of letting the run continue.
 */
export class GuardrailTripwireError extends Error {
  readonly code = 'GUARDRAIL_TRIPWIRE';
  readonly violations: GuardrailViolation[];
  readonly layer: GuardrailLayer;

  constructor(violations: GuardrailViolation[], layer: GuardrailLayer) {
    const first = violations[0];
    super(
      `Guardrail tripwire at layer "${layer}": ` +
        (first ? first.reason : 'blocked by guardrail'),
    );
    this.name = 'GuardrailTripwireError';
    this.violations = violations;
    this.layer = layer;
  }
}
