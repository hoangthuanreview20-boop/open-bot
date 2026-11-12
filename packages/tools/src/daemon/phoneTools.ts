/**
 * Phone-tool allowlist for the local-exec-daemon (v0.53, P1-7 — REA
 * deep-dive lần 2 §2.5: Grok's daemon has an allowlist of phone-side
 * tools, each bound to a scope).
 *
 * Original code, same list (names + scope taken from the analysis,
 * not copied from any source): the daemon's "phone surface" — read /
 * send iMessage, send mail, open an app on the phone — plus the
 * local file/shell tools the bridge also routes. `computer_local_tool`
 * (localBridge.ts) MUST pass `assertPhoneToolAllowed(toolId)` before
 * dispatching anything: an unknown `tool_id` is refused fail-closed
 * instead of reaching a handler.
 *
 * The allowlist is about WHICH tool may run, not WHETHER this
 * machine can run it: a phone tool that is allowlisted but has no
 * phone paired (or no Gmail token) still reports "unavailable" from
 * its handler — allowlist ≠ capability.
 */
export interface PhoneToolAllowlistEntry {
  toolId: string;
  scope: string;
}

/** The phone-surface tools, each with its scope (all "global" per §2.5). */
export const PHONE_TOOL_ALLOWLIST: ReadonlyArray<PhoneToolAllowlistEntry> = [
  { toolId: 'run-command', scope: 'global' },
  { toolId: 'send-input', scope: 'global' },
  { toolId: 'read-file', scope: 'global' },
  { toolId: 'list-directory', scope: 'global' },
  { toolId: 'write-file', scope: 'global' },
  { toolId: 'read-ai-tool-setup', scope: 'global' },
  { toolId: 'read-messages', scope: 'global' },
  { toolId: 'send-imessage', scope: 'global' },
  { toolId: 'run-phone-tool', scope: 'global' },
  { toolId: 'use-app', scope: 'global' },
  { toolId: 'send-mail', scope: 'global' },
];

/** Just the ids, for validation / error messages. */
export const PHONE_TOOL_IDS: ReadonlyArray<string> = PHONE_TOOL_ALLOWLIST.map((e) => e.toolId);

/** Tool ids that touch the phone (as opposed to the local machine). */
export const PHONE_ONLY_TOOL_IDS: ReadonlyArray<string> = [
  'read-messages',
  'send-imessage',
  'run-phone-tool',
  'use-app',
  'send-mail',
];

/** True when `toolId` is on the daemon allowlist. */
export function isPhoneToolAllowed(toolId: string): boolean {
  return PHONE_TOOL_ALLOWLIST.some((e) => e.toolId === toolId);
}

/** True when `toolId` touches the phone (not the local machine). v0.59: used by PhoneBridge. */
export function isPhoneOnlyTool(toolId: string): boolean {
  return (PHONE_ONLY_TOOL_IDS as readonly string[]).includes(toolId);
}

/** Scope of an allowlisted tool, or null when not allowlisted. */
export function phoneToolScope(toolId: string): string | null {
  return PHONE_TOOL_ALLOWLIST.find((e) => e.toolId === toolId)?.scope ?? null;
}

/**
 * Throw when `toolId` is not on the allowlist (fail-closed — the
 * bridge calls this before any dispatch). The message lists the
 * allowed ids so the model can correct itself.
 */
export function assertPhoneToolAllowed(toolId: string): void {
  if (typeof toolId !== 'string' || toolId === '') {
    throw new Error('computer_local_tool needs a tool_id.');
  }
  if (!isPhoneToolAllowed(toolId)) {
    throw new Error(
      `Unknown local tool "${toolId}" — refused (not on the daemon phone-tool allowlist: ${PHONE_TOOL_IDS.join(', ')}).`,
    );
  }
}
