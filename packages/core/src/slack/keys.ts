/**
 * Slack inbound signing secrets (v0.87a, P2-2).
 *
 * One secret per Slack-inbound automation, in the Vault namespace
 * `slack-inbound-keys/` (the Vault interface only — the same minimal
 * shape `composio/triggerKeys.ts` uses, so tests can inject a fake):
 *
 * - Signing secret — the Slack app's *Signing Secret* (Slack app
 *   settings → Basic Information → Signing Secret). The user PASTES
 *   it here (open-bot never fetches it from Slack — there is no API
 *   for reading it back). Key id is the automation id. Verified
 *   against `x-slack-signature` on every direct-Slack delivery (see
 *   `inbound.ts`). The same Slack app secret value is pasted for
 *   every automation that listens to that app — one app, one secret.
 *
 * Rules (same as the Composio trigger keys):
 * - Listing never returns values: `has*` is the only existence check
 *   the UI gets. Secrets are never logged here.
 * - Deleting an automation must delete its signing secret (the main
 *   process does this — a deleted automation must not leave a live
 *   Slack secret behind).
 */

/** Vault namespace holding Slack inbound signing secrets. */
export const SLACK_INBOUND_KEYS_NAMESPACE = 'slack-inbound-keys';

/** Minimal Vault surface this module needs (the real Vault satisfies it). */
export interface SlackInboundKeyVault {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
  hasSecret(namespace: string, key: string): boolean;
}

/**
 * Store the user-pasted Slack app signing secret for an automation
 * (key id = automation id). Overwrites any previous value. Throws on
 * an empty secret. Never logs the value.
 */
export function setSlackSigningSecret(
  vault: SlackInboundKeyVault,
  automationId: string,
  secretValue: string,
): void {
  if (typeof secretValue !== 'string' || secretValue.trim() === '') {
    throw new Error('Slack signing secret must not be empty.');
  }
  vault.setSecret(SLACK_INBOUND_KEYS_NAMESPACE, automationId, secretValue.trim());
}

/** Read the signing secret for an automation; null when missing. */
export function getSlackSigningSecret(
  vault: SlackInboundKeyVault,
  automationId: string,
): string | null {
  try {
    const raw = vault.getSecret(SLACK_INBOUND_KEYS_NAMESPACE, automationId);
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Has a signing secret been stored for this automation (boolean only)? */
export function hasSlackSigningSecret(vault: SlackInboundKeyVault, automationId: string): boolean {
  return getSlackSigningSecret(vault, automationId) !== null;
}

/** Delete the signing secret; true when one existed. */
export function deleteSlackSigningSecret(vault: SlackInboundKeyVault, automationId: string): boolean {
  try {
    return vault.deleteSecret(SLACK_INBOUND_KEYS_NAMESPACE, automationId);
  } catch {
    return false;
  }
}
