/**
 * Realtime fallback factory (v0.98, Đội T5 — voice live).
 *
 * The mock fallback used to be assembled ad hoc in main
 * (`getOrCreateRealtimeSession` built a `MockRealtimeTransport`
 * when `!apiKey && !url`). That logic is now one place, driven
 * by the key gate (`keyGate.ts`): given a gate decision, return
 * the transport the session must use — the live adapter when the
 * decision is `live`, the mock when it is `mock` — plus a record
 * of *why*, so the UI can render the exact state ("mock vì chưa
 * có key" vs "live qua Vault") instead of guessing from a
 * boolean.
 *
 * Rules (explicit):
 *   - decision `live` → `createRealtimeTransport(provider, cb)`
 *     (the real adapter; it re-checks the key in `connect()` and
 *     throws `MissingRealtimeKeyError` if the key vanished
 *     between the decision and the dial — the two gates agree).
 *   - decision `mock` → `MockRealtimeTransport` with the default
 *     script (which says plainly that this is mock mode and where
 *     the key goes) — or a caller-supplied script for tests.
 *   - the fallback never dials: the mock constructor takes no
 *     URL and no key, so a mock session cannot leak a key or
 *     touch the network by construction.
 */
import type { RealtimeProvider } from './types';
import type { KeyGateDecision } from './keyGate';
import { decideRealtimeMode, type KeyGateInput } from './keyGate';
import {
  createRealtimeTransport,
  type RealtimeTransport,
  type RealtimeTransportCallbacks,
} from './adapters';
import {
  MockRealtimeTransport,
  isMockRealtimeTransport,
  type MockRealtimeTransportOptions,
} from './mockTransport';

/** What the fallback factory decided (for the UI / diagnostics). */
export interface RealtimeFallbackChoice {
  /** Provider the session will run on. */
  provider: RealtimeProvider;
  /** 'live' adapter or 'mock' fallback. */
  mode: 'live' | 'mock';
  /** True when the transport is the mock (never live). */
  mock: boolean;
  /** The gate decision this choice came from (no key material). */
  decision: KeyGateDecision;
  /** Plain-language reason, for the panel. */
  reason: string;
}

/** Options for the fallback factory. */
export interface RealtimeFallbackOptions {
  /** Scripted replies for the mock fallback (tests / demos). */
  mockOptions?: MockRealtimeTransportOptions;
}

/**
 * Choose the transport for a provider from a gate decision.
 * Returns the transport + the choice record. The transport is
 * created, not connected — the session still dials (and the live
 * adapter still re-checks the key) at `connect()` time.
 */
export function chooseRealtimeTransport(
  provider: RealtimeProvider,
  decision: KeyGateDecision,
  callbacks: RealtimeTransportCallbacks = {},
  options: RealtimeFallbackOptions = {},
): { transport: RealtimeTransport; choice: RealtimeFallbackChoice } {
  if (decision.provider !== provider) {
    throw new Error(
      `chooseRealtimeTransport: decision is for ${decision.provider}, not ${provider}.`,
    );
  }
  if (decision.mode === 'live') {
    return {
      transport: createRealtimeTransport(provider, callbacks),
      choice: {
        provider,
        mode: 'live',
        mock: false,
        decision,
        reason: decision.reason,
      },
    };
  }
  return {
    transport: new MockRealtimeTransport(callbacks, options.mockOptions, provider),
    choice: {
      provider,
      mode: 'mock',
      mock: true,
      decision,
      reason: decision.reason,
    },
  };
}

/**
 * Decide + choose in one call: run the key gate on the inputs,
 * then pick the transport. The common path for main: one call,
 * one transport, one honest choice record.
 */
export function decideAndChooseRealtimeTransport(
  provider: RealtimeProvider,
  input: KeyGateInput,
  callbacks: RealtimeTransportCallbacks = {},
  options: RealtimeFallbackOptions = {},
): { transport: RealtimeTransport; choice: RealtimeFallbackChoice } {
  const decision = decideRealtimeMode(provider, input);
  return chooseRealtimeTransport(provider, decision, callbacks, options);
}

/** True when the choice is the mock fallback (not a live adapter). */
export function isMockFallbackChoice(choice: RealtimeFallbackChoice): boolean {
  return choice.mock;
}

/** Re-exported for callers that only need the mock check. */
export { isMockRealtimeTransport };
