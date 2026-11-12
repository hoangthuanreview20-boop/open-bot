/**
 * Guardrail registry (v0.10, BEYOND-ROADMAP items 5–6; research P0-5).
 *
 * Owns the guardrails for one run / bot: registration, enable/disable
 * per guardrail, and execution in the two supported modes:
 *
 * - `blocking` — run guardrails for the layer in registration order and
 *   stop at the first `block` violation (cheap: the common case, a
 *   clean input, still runs every guardrail for the layer). The result
 *   has `blocked: true` and `passed: false`.
 * - `parallel` — run every guardrail for the layer, collect every
 *   violation, and never block (`blocked: false`, `passed: true`).
 *   For recording / tracing what *would* have tripped.
 *
 * `enforce()` is the call the loop boundary uses: it runs the check
 * and throws `GuardrailTripwireError` when blocked, so the coordinator
 * can turn it into a safe refusal. `run()` never throws for a
 * violation — it reports.
 *
 * The registry is deliberately independent of the agent loop: wiring
 * (start/end of turn + before each tool call) is done by the
 * coordinator in a later step.
 */

import { BUILTIN_GUARDRAILS, redactOutputText } from './builtin';
import type {
  GuardrailContext,
  GuardrailDefinition,
  GuardrailLayer,
  GuardrailMode,
  GuardrailResult,
  GuardrailViolation,
} from './types';
import { GuardrailTripwireError } from './types';

export type GuardrailModeConfig = GuardrailMode | Partial<Record<GuardrailLayer, GuardrailMode>>;

export interface GuardrailRegistryOptions {
  /**
   * Execution mode: one mode for all layers, or per-layer.
   * Default: `blocking` everywhere.
   */
  mode?: GuardrailModeConfig;
  /** Workspace root handed to tool-layer path checks by default. */
  workspaceDir?: string;
  /** Secrets already known — redacted / flagged on sight. */
  knownSecrets?: string[];
}

interface RegisteredGuardrail {
  def: GuardrailDefinition;
  enabled: boolean;
}

export class GuardrailRegistry {
  private readonly guardrails = new Map<string, RegisteredGuardrail>();
  private readonly modeConfig: GuardrailModeConfig;
  private readonly defaultWorkspaceDir?: string;
  private readonly defaultKnownSecrets: string[];

  constructor(options: GuardrailRegistryOptions = {}) {
    this.modeConfig = options.mode ?? 'blocking';
    this.defaultWorkspaceDir = options.workspaceDir;
    this.defaultKnownSecrets = options.knownSecrets ?? [];
  }

  /** Register a guardrail. Throws on a duplicate id. */
  register(def: GuardrailDefinition): this {
    if (this.guardrails.has(def.id)) {
      throw new Error(`Guardrail "${def.id}" is already registered.`);
    }
    this.guardrails.set(def.id, { def, enabled: def.enabled ?? true });
    return this;
  }

  /** Remove a guardrail. No-op when the id is unknown. Returns true when removed. */
  unregister(id: string): boolean {
    return this.guardrails.delete(id);
  }

  /** Enable a previously disabled guardrail. Throws on an unknown id. */
  enable(id: string): this {
    const entry = this.require(id);
    entry.enabled = true;
    return this;
  }

  /** Disable a guardrail (it stays registered, but never runs). Throws on an unknown id. */
  disable(id: string): this {
    const entry = this.require(id);
    entry.enabled = false;
    return this;
  }

  /** Whether the guardrail is registered and enabled. Unknown id = false. */
  isEnabled(id: string): boolean {
    return this.guardrails.get(id)?.enabled ?? false;
  }

  /** All registered guardrails, optionally filtered by layer, in registration order. */
  list(layer?: GuardrailLayer): GuardrailDefinition[] {
    const all = [...this.guardrails.values()].map((e) => e.def);
    return layer ? all.filter((d) => d.layer === layer) : all;
  }

  /** Enabled guardrails for a layer, in registration order. */
  private enabledFor(layer: GuardrailLayer): GuardrailDefinition[] {
    return [...this.guardrails.values()]
      .filter((e) => e.enabled && e.def.layer === layer)
      .map((e) => e.def);
  }

  /** Mode that applies to a layer (per-layer override wins, else the global mode). */
  modeFor(layer: GuardrailLayer): GuardrailMode {
    if (typeof this.modeConfig === 'string') return this.modeConfig;
    return this.modeConfig[layer] ?? 'blocking';
  }

  private require(id: string): RegisteredGuardrail {
    const entry = this.guardrails.get(id);
    if (!entry) throw new Error(`Unknown guardrail "${id}".`);
    return entry;
  }

  /**
   * Run the enabled guardrails for `ctx.layer` over `value`:
   * - `input` / `output`: `value` is the text string.
   * - `tool`: `value` is the tool-args record (or a string arg).
   *
   * Blocking mode stops at the first `block` violation; parallel mode
   * runs everything and never blocks. Never throws for a violation
   * (use `enforce()` for the throwing variant). A guardrail whose
   * `check()` throws is fail-closed: it contributes a `block`
   * violation (`guardrail.check-failed`) instead of passing silently —
   * so a future model-based guardrail whose model call fails blocks
   * the run rather than letting unchecked content through.
   *
   * For the output layer with a string value, `result.redactedText`
   * holds the text with every secret/PII span replaced by
   * `<redacted>` whenever at least one violation carries a span.
   */
  async run(
    value: unknown,
    ctx: GuardrailContext,
    mode?: GuardrailMode,
  ): Promise<GuardrailResult> {
    const effectiveMode = mode ?? this.modeFor(ctx.layer);
    const effectiveCtx: GuardrailContext = {
      ...ctx,
      workspaceDir: ctx.workspaceDir ?? this.defaultWorkspaceDir,
      knownSecrets: ctx.knownSecrets ?? this.defaultKnownSecrets,
    };
    const violations: GuardrailViolation[] = [];
    for (const def of this.enabledFor(ctx.layer)) {
      // P0-5 fail-closed: a guardrail that throws (buggy custom rule, or
      // a future model-based guardrail whose model call failed) must
      // BLOCK the run, never silently pass. The violation carries only
      // the guardrail id — never the error message, which could contain
      // a secret / PII from the checked value.
      let found: GuardrailViolation[];
      try {
        found = await def.check(value, effectiveCtx);
      } catch {
        found = [
          {
            guardrailId: def.id,
            layer: ctx.layer,
            severity: 'block',
            code: 'guardrail.check-failed',
            reason:
              `Guardrail "${def.id}" lỗi khi kiểm tra — chặn fail-closed ` +
              `(không cho qua lặng).`,
          },
        ];
      }
      violations.push(...found);
      if (
        effectiveMode === 'blocking' &&
        found.some((v) => v.severity === 'block')
      ) {
        break;
      }
    }
    const blocked =
      effectiveMode === 'blocking' &&
      violations.some((v) => v.severity === 'block');
    const result: GuardrailResult = {
      passed: !blocked,
      blocked,
      mode: effectiveMode,
      layer: ctx.layer,
      violations,
    };
    if (
      ctx.layer === 'output' &&
      typeof value === 'string' &&
      violations.some((v) => v.span)
    ) {
      result.redactedText = redactOutputText(
        value,
        violations,
        effectiveCtx.knownSecrets ?? [],
      );
    }
    return result;
  }

  /**
   * Like `run()`, but throws `GuardrailTripwireError` when the check
   * blocks. The loop boundary calls this and converts the error into
   * a safe refusal; parallel mode never throws.
   */
  async enforce(
    value: unknown,
    ctx: GuardrailContext,
    mode?: GuardrailMode,
  ): Promise<GuardrailResult> {
    const result = await this.run(value, ctx, mode);
    if (result.blocked) {
      throw new GuardrailTripwireError(result.violations, ctx.layer);
    }
    return result;
  }
}

/**
 * Build a registry pre-loaded with the built-in rule-based guardrails
 * (`BUILTIN_GUARDRAILS`). This is what the coordinator will use.
 */
export function createDefaultRegistry(
  options: GuardrailRegistryOptions = {},
): GuardrailRegistry {
  const registry = new GuardrailRegistry(options);
  for (const def of BUILTIN_GUARDRAILS) registry.register(def);
  return registry;
}
