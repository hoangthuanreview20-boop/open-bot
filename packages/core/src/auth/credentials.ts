/**
 * Three credential kinds, three Vault namespaces (v0.7, ROADMAP §2d:
 * "Tách 3 loại credential: token phiên, OAuth refresh token, API key
 * — không trộn lẫn").
 *
 *   'session'       — session tokens (key = account id)
 *   'oauth-refresh' — OAuth refresh tokens (key = provider/service id)
 *   'provider'      — provider API keys (key = provider id)
 *
 * Other namespaces exist for other secrets ('api' = Local API token,
 * 'service-account' = service-account tokens, 'mcp', 'plugin',
 * 'identity' = display-only provider identities — see identity.ts),
 * but the three kinds above must never be read from, or written to,
 * each other's namespace. New code uses the constants + helpers here;
 * `migrateCredentials` moves secrets that older versions stored in
 * the wrong place.
 */
import type { Vault } from '../vault/vault';

/** The three credential namespaces. */
export const CREDENTIAL_NAMESPACES = {
  session: 'session',
  oauthRefresh: 'oauth-refresh',
  apiKey: 'provider',
} as const;

export type CredentialKind = keyof typeof CREDENTIAL_NAMESPACES;

/** Namespace for a credential kind. */
export function namespaceFor(kind: CredentialKind): string {
  return CREDENTIAL_NAMESPACES[kind];
}

export interface CredentialMigrationMove {
  fromNamespace: string;
  toNamespace: string;
  key: string;
}

export interface CredentialMigrationReport {
  moved: CredentialMigrationMove[];
  /** Keys that were already in the right place (or had a conflict). */
  skipped: string[];
}

/**
 * Move credentials that live in a wrong namespace to the right one.
 *
 * Rules (all idempotent — running twice moves nothing the second time):
 *  - 'oauth' (v0.4 name) -> 'oauth-refresh' for every key. v0.4
 *    stored OAuth refresh tokens under 'oauth'; v0.7 uses
 *    'oauth-refresh', so the old entries are moved, not copied.
 *  - 'provider' keys starting with 'session-' -> 'session' namespace
 *    (prefix stripped). A session token must never sit next to API keys.
 *  - 'session' keys starting with 'api-key-' -> 'provider' namespace
 *    (prefix stripped). An API key must never sit next to sessions.
 *
 * When the destination already holds the same key, the source entry
 * is left untouched and reported in `skipped` (never overwrite a
 * secret silently — the host decides which one is real).
 */
export function migrateCredentials(vault: Vault): CredentialMigrationReport {
  const moved: CredentialMigrationMove[] = [];
  const skipped: string[] = [];

  const move = (fromNs: string, toNs: string, fromKey: string, toKey: string): void => {
    const value = vault.getSecret(fromNs, fromKey);
    if (value === null) return;
    if (vault.hasSecret(toNs, toKey)) {
      skipped.push(`${fromNs}:${fromKey} (đích ${toNs}:${toKey} đã có)`);
      return;
    }
    vault.setSecret(toNs, toKey, value);
    vault.deleteSecret(fromNs, fromKey);
    moved.push({ fromNamespace: fromNs, toNamespace: toNs, key: fromKey });
  };

  for (const key of vault.listSecrets('oauth')) {
    move('oauth', CREDENTIAL_NAMESPACES.oauthRefresh, key, key);
  }
  for (const key of vault.listSecrets(CREDENTIAL_NAMESPACES.apiKey)) {
    if (key.startsWith('session-')) {
      move(CREDENTIAL_NAMESPACES.apiKey, CREDENTIAL_NAMESPACES.session, key, key.slice('session-'.length));
    }
  }
  for (const key of vault.listSecrets(CREDENTIAL_NAMESPACES.session)) {
    if (key.startsWith('api-key-')) {
      move(CREDENTIAL_NAMESPACES.session, CREDENTIAL_NAMESPACES.apiKey, key, key.slice('api-key-'.length));
    }
  }
  return { moved, skipped };
}

/**
 * Audit helper: list every secret whose namespace is one of the three
 * credential namespaces but whose key looks like it belongs to
 * another kind. Returns human-readable findings (empty = clean).
 * Used by tests + the startup log; it never returns secret values.
 */
export function auditCredentialNamespaces(vault: Vault): string[] {
  const findings: string[] = [];
  for (const key of vault.listSecrets('oauth')) {
    findings.push(`oauth:${key} nên nằm ở oauth-refresh`);
  }
  for (const key of vault.listSecrets(CREDENTIAL_NAMESPACES.apiKey)) {
    if (key.startsWith('session-')) findings.push(`provider:${key} nên nằm ở session`);
  }
  for (const key of vault.listSecrets(CREDENTIAL_NAMESPACES.session)) {
    if (key.startsWith('api-key-')) findings.push(`session:${key} nên nằm ở provider`);
  }
  return findings;
}
