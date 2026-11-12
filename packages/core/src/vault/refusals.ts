/**
 * Vault refusal taxonomy + wire errors (v0.53, P1-6 — REA deep-dive
 * lần 2 §7.4: Grok's `GrokBotVaultCreateRefusal` has `VAULT_FULL` →
 * `{kind: "vault_full"}` and other refusals → `{kind: "refused",
 * message}`, plus `GrokBotVaultWireError` with a 15s timeout).
 *
 * Original code, same shape: callers that create a credential get a
 * structured refusal instead of a bare string — `trySetSecret` returns
 * `{ok: false, refusal}` and `setSecret` throws a `VaultRefusalError`
 * carrying the same `{kind, message}` payload.
 */

/** Kinds of vault creation refusal (mirrors Grok's taxonomy). */
export type VaultRefusalKind = 'vault_full' | 'refused';

/** Structured refusal payload — safe to show to the user / UI. */
export interface VaultRefusal {
  kind: VaultRefusalKind;
  /** Human-readable reason (never contains a secret value). */
  message: string;
}

/**
 * Thrown by `Vault.setSecret` (and friends) when creation is refused.
 * `kind` is `'vault_full'` when the vault hit its entry cap, `'refused'`
 * for any other refusal (e.g. invalid name/value). Carries the same
 * payload `trySetSecret` returns, so callers can handle both paths
 * with one check.
 */
export class VaultRefusalError extends Error {
  readonly kind: VaultRefusalKind;
  readonly refusal: VaultRefusal;

  constructor(refusal: VaultRefusal) {
    super(`Vault refused: ${refusal.kind} — ${refusal.message}`);
    this.name = 'VaultRefusalError';
    this.kind = refusal.kind;
    this.refusal = refusal;
  }
}

/**
 * Timeout for a vault operation that crosses a process boundary
 * (1Password broker RPC, same 15s as Grok's `GrokBotVaultWireError`).
 */
export const VAULT_WIRE_TIMEOUT_MS = 15_000;

/**
 * A vault call that talks to another process timed out (or the other
 * end died mid-call). Fail-closed: the caller must assume the
 * operation did NOT complete — never retry a write blindly, and never
 * present a timeout as success.
 */
export class VaultWireError extends Error {
  /** Timeout (ms) that fired. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number = VAULT_WIRE_TIMEOUT_MS) {
    super(message);
    this.name = 'VaultWireError';
    this.timeoutMs = timeoutMs;
  }
}

/** Default cap on the number of entries a Vault may hold. */
export const DEFAULT_VAULT_MAX_ENTRIES = 1000;
