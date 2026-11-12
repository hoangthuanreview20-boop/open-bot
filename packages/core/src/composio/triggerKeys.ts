/**
 * Composio trigger secrets (v0.83b).
 *
 * Two secrets per Composio-trigger automation, both in the Vault
 * namespace `composio-trigger-keys/` (the Vault interface only —
 * the same minimal shape `composio/keyStore.ts` uses, so tests can
 * inject a fake):
 *
 * - Signing secret — the project's `COMPOSIO_WEBHOOK_SECRET`
 *   (Composio dashboard → webhook subscription → signing secret).
 *   The user PASTES it here (open-bot never fetches it from
 *   Composio — there is no API for reading it back). Key id is the
 *   automation id. Verified against `webhook-signature` on every
 *   delivery (see `triggers.ts`).
 * - URL token — fallback auth for deliveries without signature
 *   headers (`?token=`). Key id is `${automationId}-url-token`.
 *   Created only on demand (the signing secret is the primary auth).
 *
 * Rules (same as the automation webhook keys):
 * - A secret is 32 random bytes, hex-encoded (64 chars). It is
 *   returned ONLY by `create*` / `rotate*`, exactly once each — the
 *   caller must show it to the user then and never store it in
 *   plaintext again. The signing secret is an exception in ONE way:
 *   the user pastes Composio's own secret instead of a generated
 *   one, so `setComposioTriggerSigningSecret` stores a user-supplied
 *   value (still never logged, never returned by a getter).
 * - Listing never returns values: `has*` is the only existence
 *   check the UI gets. Secrets are never logged here.
 * - Deleting an automation must delete both of its secrets (the
 *   main process does this — a deleted automation must not leave a
 *   live trigger secret behind).
 */

import { randomBytes } from 'node:crypto';

/** Vault namespace holding Composio trigger secrets. */
export const COMPOSIO_TRIGGER_KEYS_NAMESPACE = 'composio-trigger-keys';

/** Suffix of the URL-token key id (`<automationId>-url-token`). */
export const COMPOSIO_TRIGGER_TOKEN_KEY_SUFFIX = '-url-token';

/** Key id of the URL-token secret for an automation. */
export function composioTriggerTokenKeyId(automationId: string): string {
  return `${automationId}${COMPOSIO_TRIGGER_TOKEN_KEY_SUFFIX}`;
}

/** Minimal Vault surface this module needs (the real Vault satisfies it). */
export interface ComposioTriggerKeyVault {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
  hasSecret(namespace: string, key: string): boolean;
}

/** One created secret (returned exactly once — see header). */
export interface ComposioTriggerKey {
  keyId: string;
  secret: string;
}

function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Store the user-pasted Composio webhook signing secret for an
 * automation (key id = automation id). Overwrites any previous
 * value. Throws on an empty secret. Never logs the value.
 */
export function setComposioTriggerSigningSecret(
  vault: ComposioTriggerKeyVault,
  automationId: string,
  secret: string,
): void {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('Composio webhook secret must not be empty.');
  }
  vault.setSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, automationId, secret.trim());
}

/** Read the signing secret for an automation; null when missing. */
export function getComposioTriggerSigningSecret(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): string | null {
  try {
    const raw = vault.getSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, automationId);
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Has a signing secret been stored for this automation (boolean only)? */
export function hasComposioTriggerSigningSecret(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): boolean {
  return getComposioTriggerSigningSecret(vault, automationId) !== null;
}

/** Delete the signing secret; true when one existed. */
export function deleteComposioTriggerSigningSecret(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): boolean {
  try {
    return vault.deleteSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, automationId);
  } catch {
    return false;
  }
}

/**
 * Create a URL-token secret for an automation (key id
 * `<automationId>-url-token`). The token is generated here (32
 * random bytes, hex) and returned exactly once — show it to the
 * user then, it cannot be read back. Overwrites any previous token.
 */
export function createComposioTriggerToken(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): ComposioTriggerKey {
  const keyId = composioTriggerTokenKeyId(automationId);
  const secret = newSecret();
  vault.setSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, keyId, secret);
  return { keyId, secret };
}

/** Rotate the URL token (new random value, returned exactly once). */
export function rotateComposioTriggerToken(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): ComposioTriggerKey {
  return createComposioTriggerToken(vault, automationId);
}

/** Read the URL-token secret; null when missing. */
export function getComposioTriggerToken(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): string | null {
  return getComposioTriggerTokenByKeyId(vault, composioTriggerTokenKeyId(automationId));
}

/**
 * Read the URL-token secret by its full key id (what the
 * scheduler's token provider receives — `tokenKeyId`).
 */
export function getComposioTriggerTokenByKeyId(
  vault: ComposioTriggerKeyVault,
  keyId: string,
): string | null {
  try {
    const raw = vault.getSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, keyId);
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Has a URL token been stored for this automation (boolean only)? */
export function hasComposioTriggerToken(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): boolean {
  return getComposioTriggerToken(vault, automationId) !== null;
}

/** Delete the URL token; true when one existed. */
export function deleteComposioTriggerToken(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): boolean {
  try {
    return vault.deleteSecret(COMPOSIO_TRIGGER_KEYS_NAMESPACE, composioTriggerTokenKeyId(automationId));
  } catch {
    return false;
  }
}

/** Delete BOTH secrets of an automation (signing secret + URL token). */
export function deleteComposioTriggerSecrets(
  vault: ComposioTriggerKeyVault,
  automationId: string,
): void {
  deleteComposioTriggerSigningSecret(vault, automationId);
  deleteComposioTriggerToken(vault, automationId);
}
