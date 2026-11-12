/**
 * Webhook keys for automations (v0.52, P0-5; store riêng từ v0.59).
 *
 * One HMAC secret per webhook automation. Since v0.59 the keys live in
 * the DEDICATED `WebhookKeyStore` — a separate file
 * `automation-webhook-keys.json` in userData, namespace `webhook`
 * (see `vault/webhookKeys.ts`, P1-6) — NOT in the main Vault any more.
 *
 * Migration (one-time, lazy): keys created before v0.59 still sit in
 * the main Vault under namespace `automation-webhook-keys/`. Every read
 * first checks the dedicated store; on a miss it falls back to the
 * legacy Vault entry and MOVES it (copy into the dedicated store,
 * delete from the legacy one) — so the first delivery / key lookup
 * after the upgrade migrates the key, and later reads never touch the
 * old store again. All new writes (create/rotate) go to the dedicated
 * store only; delete removes from BOTH stores so a deleted key can
 * never verify again through the legacy fallback.
 *
 * The functions accept three shapes of store (union
 * `AutomationWebhookKeyStoreInput`):
 * - a dedicated store (`setKey`/`getKey`/`deleteKey`/`hasKey`, e.g.
 *   the real `WebhookKeyStore`) — reads/writes go there only;
 * - a legacy Vault-like store (`setSecret`/`getSecret`/`deleteSecret`/
 *   `hasSecret`, e.g. the real `Vault`) — the pre-v0.59 behaviour,
 *   kept so old callers and tests keep working unchanged;
 * - a pair `{ store, legacyStore }` — the main process passes this:
 *   writes go to the dedicated store, reads fall back to the legacy
 *   store once (with migration).
 *
 * Rules (unchanged from v0.52):
 * - The key id is the automation id (stable, unique, matches the Vault
 *   key-name rules). No separate mapping table to keep in sync.
 * - The secret is 32 random bytes, hex-encoded (64 chars). It is
 *   returned ONLY by `createAutomationWebhookKey` and
 *   `rotateAutomationWebhookKey`, exactly once each — the caller must
 *   show it to the user then and never store it in plaintext again.
 * - Listing never returns values: `hasAutomationWebhookKey` is the
 *   only existence check the UI gets.
 * - Secrets are never logged here.
 */

import { randomBytes } from 'node:crypto';

/** Vault namespace holding automation webhook HMAC secrets (legacy, pre-v0.59). */
export const AUTOMATION_WEBHOOK_KEYS_NAMESPACE = 'automation-webhook-keys';

/**
 * Minimal Vault surface this module needs for the LEGACY store. The
 * real `Vault` class satisfies it; tests may pass a fake. Only the
 * public secret API is used — never vault internals.
 */
export interface AutomationWebhookKeyStore {
  setSecret(namespace: string, key: string, value: string): void;
  getSecret(namespace: string, key: string): string | null;
  deleteSecret(namespace: string, key: string): boolean;
  hasSecret(namespace: string, key: string): boolean;
}

/**
 * Minimal surface of the DEDICATED store (`vault/webhookKeys.ts`
 * `WebhookKeyStore`). The real class satisfies this structurally;
 * tests may pass a fake.
 */
export interface DedicatedWebhookKeyStore {
  setKey(id: string, secret: string, opts?: { maxAgeMs?: number; saveToVault?: boolean }): void;
  getKey(id: string): string | null;
  deleteKey(id: string): boolean;
  hasKey(id: string): boolean;
}

/**
 * Both stores together: the dedicated store is the primary (all new
 * writes go here); the legacy Vault store is only a one-time
 * migration source, read on a primary miss.
 */
export interface AutomationWebhookKeyStores {
  /** Dedicated store — receives all new writes. */
  store: DedicatedWebhookKeyStore;
  /** Legacy Vault store — read-only fallback, migrated on read. */
  legacyStore?: AutomationWebhookKeyStore;
}

/** What the key functions accept (see the header comment). */
export type AutomationWebhookKeyStoreInput =
  | AutomationWebhookKeyStore
  | DedicatedWebhookKeyStore
  | AutomationWebhookKeyStores;

export interface AutomationWebhookKey {
  /** Vault key name (= the automation id). */
  keyId: string;
  /**
   * The HMAC secret. Present ONLY in the return value of create /
   * rotate — never readable afterwards.
   */
  secret: string;
}

function newSecret(): string {
  return randomBytes(32).toString('hex');
}

function assertKeyId(keyId: string): void {
  if (!keyId || typeof keyId !== 'string') {
    throw new Error('Webhook key id must be a non-empty string (the automation id).');
  }
}

function isDedicatedStore(value: unknown): value is DedicatedWebhookKeyStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DedicatedWebhookKeyStore).getKey === 'function' &&
    typeof (value as DedicatedWebhookKeyStore).setKey === 'function' &&
    typeof (value as DedicatedWebhookKeyStore).deleteKey === 'function' &&
    typeof (value as DedicatedWebhookKeyStore).hasKey === 'function'
  );
}

function isLegacyStore(value: unknown): value is AutomationWebhookKeyStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AutomationWebhookKeyStore).getSecret === 'function' &&
    typeof (value as AutomationWebhookKeyStore).setSecret === 'function' &&
    typeof (value as AutomationWebhookKeyStore).deleteSecret === 'function' &&
    typeof (value as AutomationWebhookKeyStore).hasSecret === 'function'
  );
}

/** Normalised read/write surface over whichever store shape was passed. */
interface ResolvedWebhookKeyStores {
  primaryGet(id: string): string | null;
  primarySet(id: string, secret: string): void;
  primaryHas(id: string): boolean;
  primaryDelete(id: string): boolean;
  /** Legacy store, consulted only on a primary miss (migration source). */
  legacy?: {
    get(id: string): string | null;
    has(id: string): boolean;
    delete(id: string): boolean;
  };
}

function resolveStores(input: AutomationWebhookKeyStoreInput): ResolvedWebhookKeyStores {
  if (isDedicatedStore(input)) {
    return {
      primaryGet: (id) => input.getKey(id),
      primarySet: (id, secret) => input.setKey(id, secret),
      primaryHas: (id) => input.hasKey(id),
      primaryDelete: (id) => input.deleteKey(id),
    };
  }
  if (isLegacyStore(input)) {
    const ns = AUTOMATION_WEBHOOK_KEYS_NAMESPACE;
    return {
      primaryGet: (id) => input.getSecret(ns, id),
      primarySet: (id, secret) => input.setSecret(ns, id, secret),
      primaryHas: (id) => input.hasSecret(ns, id),
      primaryDelete: (id) => input.deleteSecret(ns, id),
    };
  }
  const pair = input as AutomationWebhookKeyStores;
  if (!isDedicatedStore(pair.store)) {
    throw new Error(
      'Webhook key stores: "store" must be a WebhookKeyStore (setKey/getKey/deleteKey/hasKey).',
    );
  }
  const resolved: ResolvedWebhookKeyStores = {
    primaryGet: (id) => pair.store.getKey(id),
    primarySet: (id, secret) => pair.store.setKey(id, secret),
    primaryHas: (id) => pair.store.hasKey(id),
    primaryDelete: (id) => pair.store.deleteKey(id),
  };
  if (pair.legacyStore !== undefined) {
    if (!isLegacyStore(pair.legacyStore)) {
      throw new Error(
        'Webhook key stores: "legacyStore" must be a Vault-like store (setSecret/getSecret/deleteSecret/hasSecret).',
      );
    }
    const ns = AUTOMATION_WEBHOOK_KEYS_NAMESPACE;
    const legacyStore = pair.legacyStore;
    resolved.legacy = {
      get: (id) => legacyStore.getSecret(ns, id),
      has: (id) => legacyStore.hasSecret(ns, id),
      delete: (id) => legacyStore.deleteSecret(ns, id),
    };
  }
  return resolved;
}

/**
 * Create the webhook key for an automation. Returns the secret exactly
 * once — the caller shows it to the user now; it cannot be read back.
 * Overwrites an existing key for the same automation (same as rotate).
 * Writes ONLY to the primary (dedicated) store; a stale legacy copy
 * of the same id is deleted best-effort so the old secret leaves the
 * disk (it is unreachable anyway once the new store holds the key).
 */
export function createAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  automationId: string,
): AutomationWebhookKey {
  assertKeyId(automationId);
  const resolved = resolveStores(store);
  const secret = newSecret();
  resolved.primarySet(automationId, secret);
  if (resolved.legacy) {
    try {
      resolved.legacy.delete(automationId);
    } catch {
      // Best-effort: the new key is already in the primary store,
      // the legacy copy is unreachable (primary is checked first).
    }
  }
  return { keyId: automationId, secret };
}

/** Rotate the key: a fresh secret replaces the old one. The old secret stops working immediately. */
export function rotateAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  automationId: string,
): AutomationWebhookKey {
  return createAutomationWebhookKey(store, automationId);
}

/**
 * Read the secret for verification. Returns null when no key exists.
 * Internal use only — never send to the renderer.
 *
 * With a `{ store, legacyStore }` pair this performs the one-time
 * migration: a key found only in the legacy store is copied into the
 * dedicated store and deleted from the legacy one before it is
 * returned, so the next read never touches the old store. The legacy
 * copy is only deleted AFTER the new store holds the key — a failed
 * write never loses the key.
 */
export function getAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  keyId: string,
): string | null {
  assertKeyId(keyId);
  const resolved = resolveStores(store);
  const fresh = resolved.primaryGet(keyId);
  if (fresh !== null) return fresh;
  if (!resolved.legacy) return null;
  const old = resolved.legacy.get(keyId);
  if (old === null) return null;
  resolved.primarySet(keyId, old);
  try {
    resolved.legacy.delete(keyId);
  } catch {
    // The migrated copy is already safe in the primary store; a
    // leftover legacy copy is harmless (primary is checked first).
  }
  return old;
}

/**
 * Move one key from the legacy store to the dedicated store, if it is
 * still there. Returns true when a legacy key was found and moved,
 * false when there was nothing to migrate (already in the new store,
 * or no key at all, or no legacy store attached). Never throws for a
 * missing key; throws for a malformed store argument.
 */
export function migrateAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  keyId: string,
): boolean {
  assertKeyId(keyId);
  const resolved = resolveStores(store);
  if (!resolved.legacy) return false;
  if (resolved.primaryGet(keyId) !== null) {
    // Already migrated (or created fresh): drop any stale legacy copy.
    try {
      resolved.legacy.delete(keyId);
    } catch {
      // Best-effort cleanup.
    }
    return false;
  }
  const old = resolved.legacy.get(keyId);
  if (old === null) return false;
  resolved.primarySet(keyId, old);
  try {
    resolved.legacy.delete(keyId);
  } catch {
    // The migrated copy is already safe in the primary store.
  }
  return true;
}

/** Does a key exist for this automation? (No value is ever exposed.) Checks the primary store first, then the legacy fallback. */
export function hasAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  keyId: string,
): boolean {
  assertKeyId(keyId);
  const resolved = resolveStores(store);
  if (resolved.primaryHas(keyId)) return true;
  return resolved.legacy?.has(keyId) ?? false;
}

/**
 * Delete the key (e.g. when its automation is deleted). Returns false
 * when there was no key. Deletes from BOTH stores, so a deleted key
 * can never verify again through the legacy fallback.
 */
export function deleteAutomationWebhookKey(
  store: AutomationWebhookKeyStoreInput,
  keyId: string,
): boolean {
  assertKeyId(keyId);
  const resolved = resolveStores(store);
  const fromPrimary = resolved.primaryDelete(keyId);
  let fromLegacy = false;
  if (resolved.legacy) {
    try {
      fromLegacy = resolved.legacy.delete(keyId);
    } catch {
      fromLegacy = false;
    }
  }
  return fromPrimary || fromLegacy;
}
