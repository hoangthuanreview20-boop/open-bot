/**
 * Multi Round-Trip Requests — MRTR (v0.97, Team T1).
 *
 * MCP 2.0 (SEP-2322) removes server-initiated callbacks mid-request
 * (sampling, elicitation, roots): a server can no longer interrupt a
 * request to ask the client for something. Instead the server
 * returns a result that says what is still missing (`resultType`),
 * and the client issues a follow-up request. Every round trip is an
 * independent, stateless request — the continuation state travels in
 * `_meta.roundTrip` (see `stateless.ts`), never in server memory.
 *
 * Round kinds a server may ask for:
 *   - `needs_input`      — the server needs more arguments / a missing field.
 *   - `needs_sampling`   — the server needs a model completion (the old
 *                          `sampling/createMessage`, now client-driven).
 *   - `needs_elicitation`— the server needs a value from the user
 *                          (the old `elicitation/create`).
 *   - `needs_roots`      — the server needs a workspace root list
 *                          (the old `roots/list`).
 *   - `needs_confirmation`— the server wants the user to confirm before
 *                          proceeding (destructive / outside-machine effect).
 *   - `complete`         — final result, no more rounds.
 *
 * The driver (`runMultiRoundTrip`) loops: call → inspect `resultType`
 * → ask the registered handler for that kind → follow up with the
 * handler's answer in `_meta.roundTrip` → repeat until `complete`
 * or the round budget runs out. Handlers are plain callbacks the
 * coordinator wires to the real UI / provider; this module never
 * calls a model, never prompts a user, and never touches the network
 * itself — it only orchestrates JSON-RPC round trips.
 *
 * Statelessness rule: the server must be able to resume from the
 * `roundTripId` + `round` + the follow-up payload alone. The driver
 * therefore sends the full accumulated context on every follow-up
 * (the `answers` map), so a different server instance may answer
 * round N+1. Servers that keep round state in memory still work —
 * the id is stable across rounds — but nothing in this module
 * requires it.
 */

import { buildStatelessMeta, withStatelessMeta } from './stateless';

export const MCP_MRTR_MAX_ROUNDS_DEFAULT = 8;

/** Kinds of follow-up a server may request via `resultType`. */
export type MrtrResultType =
  | 'complete'
  | 'needs_input'
  | 'needs_sampling'
  | 'needs_elicitation'
  | 'needs_roots'
  | 'needs_confirmation';

/** Every follow-up kind except `complete`. */
export const MRTR_FOLLOW_UP_TYPES: readonly MrtrResultType[] = [
  'needs_input',
  'needs_sampling',
  'needs_elicitation',
  'needs_roots',
  'needs_confirmation',
];

/**
 * What the server asks for in one follow-up round. `prompt` is the
 * human-readable question; `schema` constrains the answer shape
 * (JSON Schema for `needs_input` / `needs_elicitation`); `detail`
 * carries kind-specific data (e.g. the sampling messages for
 * `needs_sampling`, the candidate roots for `needs_roots`).
 */
export interface MrtrNeed {
  resultType: Exclude<MrtrResultType, 'complete'>;
  /** Human-readable question / instruction for the client or user. */
  prompt?: string;
  /** JSON Schema the follow-up answer must satisfy (when applicable). */
  schema?: Record<string, unknown>;
  /** Kind-specific payload (sampling messages, root candidates, ...). */
  detail?: Record<string, unknown>;
}

/** A server result that carries an MRTR `resultType`. */
export interface MrtrResult {
  resultType: MrtrResultType;
  /** Final payload when `resultType` is `complete`. */
  result?: unknown;
  /** What the server still needs (absent when `complete`). */
  need?: MrtrNeed;
  /** Round-trip id the server assigned (stable across rounds). */
  roundTripId?: string;
  /** Human-readable progress note for this round. */
  note?: string;
}

/** Minimal transport the MRTR driver needs. */
export interface MrtrTransport {
  requestJsonRpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** One round that happened, for logs / the activity feed. */
export interface MrtrRoundRecord {
  round: number;
  method: string;
  resultType: MrtrResultType;
  note?: string;
}

/** Callbacks the coordinator wires to the real world. */
export interface MrtrHandlers {
  /** Server asked for more input — return the extra arguments. */
  onNeedsInput?: (need: MrtrNeed, round: number) => Promise<Record<string, unknown>>;
  /** Server asked for a model completion — return the sampled text. */
  onNeedsSampling?: (need: MrtrNeed, round: number) => Promise<string>;
  /** Server asked the user for a value — return the elicited fields. */
  onNeedsElicitation?: (need: MrtrNeed, round: number) => Promise<Record<string, unknown>>;
  /** Server asked for workspace roots — return the root list. */
  onNeedsRoots?: (need: MrtrNeed, round: number) => Promise<Array<{ uri: string; name?: string }>>;
  /** Server asked for confirmation — return true to proceed. */
  onNeedsConfirmation?: (need: MrtrNeed, round: number) => Promise<boolean>;
  /** Called after every round (for progress UI / tracing). */
  onRound?: (record: MrtrRoundRecord) => void;
}

export class MrtrError extends Error {
  readonly resultType?: MrtrResultType;
  readonly round?: number;
  constructor(message: string, resultType?: MrtrResultType, round?: number) {
    super(message);
    this.name = 'MrtrError';
    this.resultType = resultType;
    this.round = round;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMrtrResultType(value: unknown): value is MrtrResultType {
  return (
    value === 'complete' ||
    (MRTR_FOLLOW_UP_TYPES as readonly string[]).includes(value as string)
  );
}

/**
 * Parse a server result into an `MrtrResult`. A result without
 * `resultType` is a legacy (pre-MRTR) result and counts as
 * `complete` with the whole payload as `result` — old servers keep
 * working through the driver without changes.
 */
export function parseMrtrResult(value: unknown): MrtrResult {
  if (!isRecord(value)) return { resultType: 'complete', result: value };
  const rawType = value['resultType'];
  if (rawType === undefined) return { resultType: 'complete', result: value };
  if (!isMrtrResultType(rawType)) {
    throw new MrtrError(
      `MRTR: resultType không hợp lệ: ${JSON.stringify(rawType)}`,
      undefined,
    );
  }
  if (rawType === 'complete') {
    return {
      resultType: 'complete',
      result: value['result'] !== undefined ? value['result'] : value,
      ...(typeof value['roundTripId'] === 'string' ? { roundTripId: value['roundTripId'] } : {}),
      ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
    };
  }
  const needRaw = isRecord(value['need']) ? value['need'] : {};
  const need: MrtrNeed = {
    resultType: rawType,
    ...(typeof needRaw['prompt'] === 'string' ? { prompt: needRaw['prompt'] } : {}),
    ...(typeof value['prompt'] === 'string' && !needRaw['prompt']
      ? { prompt: value['prompt'] as string }
      : {}),
    ...(isRecord(needRaw['schema']) ? { schema: needRaw['schema'] } : {}),
    ...(isRecord(needRaw['detail']) ? { detail: needRaw['detail'] } : {}),
  };
  return {
    resultType: rawType,
    need,
    ...(typeof value['roundTripId'] === 'string' ? { roundTripId: value['roundTripId'] } : {}),
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  };
}

/** True when a result asks for another round. */
export function mrtrNeedsFollowUp(result: MrtrResult): boolean {
  return result.resultType !== 'complete';
}

/**
 * Build a server-side MRTR result. Convenience for servers (the
 * built-in server and tests) so `resultType` shapes stay consistent:
 * a `needs_*` result always carries a `need` object; a `complete`
 * result always carries `result`.
 */
export function buildMrtrResult(
  resultType: MrtrResultType,
  options: {
    result?: unknown;
    need?: Omit<MrtrNeed, 'resultType'>;
    roundTripId?: string;
    note?: string;
  } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { resultType };
  if (resultType === 'complete') {
    out['result'] = options.result ?? null;
  } else if (options.need) {
    out['need'] = { resultType, ...options.need };
  }
  if (options.roundTripId) out['roundTripId'] = options.roundTripId;
  if (options.note) out['note'] = options.note;
  return out;
}

/**
 * Build the follow-up request params for the next round. The full
 * accumulated answers travel in `_meta.roundTrip` context so the
 * round stays stateless; the answer itself goes in `params.answer`
 * (and, for `needs_input`, merged into `params.arguments` when the
 * original call was `tools/call`).
 */
export function buildMrtrFollowUpParams(
  originalParams: Record<string, unknown>,
  roundTripId: string,
  round: number,
  answer: unknown,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...originalParams };
  const meta = buildStatelessMeta({ roundTrip: { roundTripId, round } });
  const withMeta = withStatelessMeta(params, meta);
  withMeta['answer'] = answer;
  withMeta['roundTripId'] = roundTripId;
  withMeta['round'] = round;
  return withMeta;
}

/**
 * Resolve one follow-up round by calling the handler registered for
 * its kind. Throws `MrtrError` when no handler is registered — the
 * client must not silently invent an answer for a sampling,
 * elicitation or confirmation request; the caller decides whether
 * to fail the whole call or surface the question to the user.
 */
export async function resolveMrtrNeed(
  need: MrtrNeed,
  round: number,
  handlers: MrtrHandlers,
): Promise<unknown> {
  switch (need.resultType) {
    case 'needs_input': {
      if (!handlers.onNeedsInput) {
        throw new MrtrError(
          `MRTR: server cần thêm input ở round ${round} nhưng client không đăng ký onNeedsInput`,
          need.resultType,
          round,
        );
      }
      return handlers.onNeedsInput(need, round);
    }
    case 'needs_sampling': {
      if (!handlers.onNeedsSampling) {
        throw new MrtrError(
          `MRTR: server cần sampling ở round ${round} nhưng client không đăng ký onNeedsSampling`,
          need.resultType,
          round,
        );
      }
      return handlers.onNeedsSampling(need, round);
    }
    case 'needs_elicitation': {
      if (!handlers.onNeedsElicitation) {
        throw new MrtrError(
          `MRTR: server cần elicitation ở round ${round} nhưng client không đăng ký onNeedsElicitation`,
          need.resultType,
          round,
        );
      }
      return handlers.onNeedsElicitation(need, round);
    }
    case 'needs_roots': {
      if (!handlers.onNeedsRoots) {
        throw new MrtrError(
          `MRTR: server cần roots ở round ${round} nhưng client không đăng ký onNeedsRoots`,
          need.resultType,
          round,
        );
      }
      return handlers.onNeedsRoots(need, round);
    }
    case 'needs_confirmation': {
      if (!handlers.onNeedsConfirmation) {
        throw new MrtrError(
          `MRTR: server cần confirmation ở round ${round} nhưng client không đăng ký onNeedsConfirmation`,
          need.resultType,
          round,
        );
      }
      return handlers.onNeedsConfirmation(need, round);
    }
    default:
      throw new MrtrError(
        `MRTR: resultType không xử lý được: ${String(need.resultType)}`,
        need.resultType,
        round,
      );
  }
}

/** Outcome of a full multi-round-trip call. */
export interface MrtrCallOutcome {
  /** Final payload from the server's `complete` round. */
  result: unknown;
  /** How many round trips the call took (1 = single round). */
  rounds: number;
  /** Stable id the server assigned (when it assigned one). */
  roundTripId?: string;
  /** Per-round history, for the activity feed / tracing. */
  history: MrtrRoundRecord[];
}

/**
 * Run a method through as many round trips as the server asks for.
 * Each round is an independent stateless request (its own `_meta`
 * with the round-trip continuation). The loop stops when the server
 * says `complete`, when the round budget (`maxRounds`) runs out, or
 * when a needed handler is missing. A `needs_confirmation` round
 * that answers `false` aborts the call with `MrtrError` instead of
 * sending a follow-up the user refused.
 */
export async function runMultiRoundTrip(
  transport: MrtrTransport,
  method: string,
  params: Record<string, unknown> | undefined,
  handlers: MrtrHandlers,
  options: {
    maxRounds?: number;
    protocolVersion?: string;
  } = {},
): Promise<MrtrCallOutcome> {
  const maxRounds = options.maxRounds ?? MCP_MRTR_MAX_ROUNDS_DEFAULT;
  if (maxRounds < 1) throw new MrtrError('MRTR: maxRounds phải >= 1');
  const history: MrtrRoundRecord[] = [];
  const answers: Record<string, unknown> = {};
  let roundTripId: string | undefined;
  let currentParams = params ? { ...params } : {};
  let round = 1;
  for (;;) {
    const raw = await transport.requestJsonRpc(method, currentParams);
    const parsed = parseMrtrResult(raw);
    if (parsed.roundTripId) roundTripId = parsed.roundTripId;
    const record: MrtrRoundRecord = {
      round,
      method,
      resultType: parsed.resultType,
      ...(parsed.note ? { note: parsed.note } : {}),
    };
    history.push(record);
    handlers.onRound?.(record);
    if (parsed.resultType === 'complete') {
      return { result: parsed.result, rounds: round, roundTripId, history };
    }
    if (round >= maxRounds) {
      throw new MrtrError(
        `MRTR: vượt quá ${maxRounds} round cho "${method}" (server vẫn cần ${parsed.resultType})`,
        parsed.resultType,
        round,
      );
    }
    const need = parsed.need ?? { resultType: parsed.resultType };
    const answer = await resolveMrtrNeed(need, round, handlers);
    if (need.resultType === 'needs_confirmation' && answer === false) {
      throw new MrtrError(
        `MRTR: người dùng từ chối confirmation ở round ${round} cho "${method}"`,
        need.resultType,
        round,
      );
    }
    answers[`round${round}`] = answer;
    const nextId = roundTripId ?? `mrtr-${method}-${Date.now()}`;
    roundTripId = nextId;
    const followUp = buildMrtrFollowUpParams(params ?? {}, nextId, round + 1, answer);
    // Carry the accumulated answers so any server instance can
    // resume the conversation from this request alone.
    followUp['previousAnswers'] = { ...answers };
    currentParams = followUp;
    round += 1;
  }
}
