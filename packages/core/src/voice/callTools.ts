/**
 * Voice-call toolset (P0-1, REA deep-dive §5.3).
 *
 * While a voice call is live the model does NOT get the agent's general
 * tool registry (131 tools, file diffs, shell — none of which fit a
 * short spoken turn). It gets this small set instead: nudge the working
 * agent, peek at agents/runs/changes, recall/search past text, stay
 * silent, switch agent, transfer, or hang up.
 *
 * Isolation is structural, not a comment: these definitions live only
 * in this module and in `VoiceCallHarness` (voice/harness.ts). Nothing
 * here registers into `ToolRegistry` / `defaultToolFactory` / ALL_TOOLS
 * — the general registry never sees a voice-call tool name, and the
 * voice toolset never sees a general tool name. `createVoiceCallToolSet`
 * takes its handlers as constructor arguments, so a voice call can only
 * run the handlers its caller explicitly bound for that call.
 *
 * Every argument has a per-field char limit and the whole request has a
 * total cap (`VOICE_CALL_REQUEST_CHAR_LIMIT`): the realtime connection
 * cannot carry large tool results, so requests stay small by
 * construction. Over-limit or unknown arguments are rejected
 * (fail-closed) instead of truncated silently — the model must ask
 * again, shorter.
 */
import type {
  VoiceCallHarnessOutcome,
  VoiceCallToolDefinition,
  VoiceCallToolName,
} from './types';
import { VOICE_CALL_TOOL_DEFINITIONS } from './types';

/** All voice-call tool names, in definition order. */
export const VOICE_CALL_TOOL_NAMES: readonly VoiceCallToolName[] =
  VOICE_CALL_TOOL_DEFINITIONS.map((d) => d.name);

/** True when `name` is one of the ten voice-call tools. */
export function isVoiceCallToolName(name: unknown): name is VoiceCallToolName {
  return (
    typeof name === 'string' &&
    (VOICE_CALL_TOOL_NAMES as readonly string[]).includes(name)
  );
}

/** The definition for a voice-call tool, or undefined when unknown. */
export function getVoiceCallToolDefinition(
  name: string,
): VoiceCallToolDefinition | undefined {
  return VOICE_CALL_TOOL_DEFINITIONS.find((d) => d.name === name);
}

export type VoiceCallValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate voice-call tool arguments against the tool's char limits.
 * Rejects (never truncates): unknown tool, non-object args, missing
 * required field, unknown field, non-string value, a field over its
 * char limit, or a request over the total char limit.
 */
export function validateVoiceCallArgs(
  name: string,
  args: unknown,
): VoiceCallValidationResult {
  const definition = getVoiceCallToolDefinition(name);
  if (!definition) {
    return { ok: false, error: `unknown voice-call tool: ${name}` };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: `voice-call tool ${name}: arguments must be an object.`,
    };
  }
  const record = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const param = definition.parameters[key];
    if (!param) {
      return {
        ok: false,
        error: `voice-call tool ${name}: unknown argument "${key}".`,
      };
    }
    if (typeof value !== 'string') {
      return {
        ok: false,
        error: `voice-call tool ${name}: argument "${key}" must be a string.`,
      };
    }
    if (value.length > param.charLimit) {
      return {
        ok: false,
        error:
          `voice-call tool ${name}: argument "${key}" is ${value.length} chars, ` +
          `over the ${param.charLimit}-char limit — ask again, shorter.`,
      };
    }
  }
  for (const [key, param] of Object.entries(definition.parameters)) {
    if (param.required && !(key in record)) {
      return {
        ok: false,
        error: `voice-call tool ${name}: missing required argument "${key}".`,
      };
    }
  }
  const totalChars = Object.values(record).reduce<number>(
    (sum, value) => sum + (typeof value === 'string' ? value.length : 0),
    0,
  );
  if (totalChars > definition.maxRequestChars) {
    return {
      ok: false,
      error:
        `voice-call tool ${name}: request is ${totalChars} chars, over the ` +
        `${definition.maxRequestChars}-char limit.`,
    };
  }
  return { ok: true, args: record };
}

/**
 * Handlers bound for one voice call. Each handler receives the validated
 * arguments and returns its result (sync or async). A tool with no
 * handler bound in this call is not runnable in that call — the harness
 * reports `unknown_tool` for it. Handlers are plain callbacks supplied
 * by the caller (the desktop main process binds them to the coordinator);
 * this module never imports the agent, the coordinator, or the general
 * tool registry.
 */
export type VoiceCallToolHandlers = {
  [K in VoiceCallToolName]?: (
    args: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
};

export interface VoiceCallToolSet {
  /** The ten definitions, for the realtime `session.update` tools list. */
  readonly definitions: readonly VoiceCallToolDefinition[];
  /** True when `name` is a voice-call tool. */
  has(name: string): boolean;
  /** Execute one voice-call tool through its bound handler. */
  execute(name: string, args: unknown): Promise<VoiceCallHarnessOutcome>;
}

/**
 * Build the voice-call toolset for one call, bound to exactly the
 * handlers given. No handler is ever added implicitly, and nothing is
 * registered anywhere else.
 */
export function createVoiceCallToolSet(
  handlers: VoiceCallToolHandlers = {},
): VoiceCallToolSet {
  return {
    definitions: VOICE_CALL_TOOL_DEFINITIONS,
    has(name: string): boolean {
      return isVoiceCallToolName(name);
    },
    async execute(name: string, args: unknown): Promise<VoiceCallHarnessOutcome> {
      if (!isVoiceCallToolName(name)) {
        return {
          kind: 'unknown_tool',
          tool: String(name),
          error: `unknown voice-call tool: ${String(name)}`,
        };
      }
      const validated = validateVoiceCallArgs(name, args);
      if (!validated.ok) {
        return { kind: 'invalid_input', tool: name, error: validated.error };
      }
      const handler = handlers[name];
      if (!handler) {
        return {
          kind: 'unknown_tool',
          tool: name,
          error: `voice-call tool ${name} has no handler bound for this call.`,
        };
      }
      try {
        const output = await handler(validated.args);
        return { kind: 'served', tool: name, output };
      } catch (err) {
        return {
          kind: 'invalid_input',
          tool: name,
          error: `voice-call tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
