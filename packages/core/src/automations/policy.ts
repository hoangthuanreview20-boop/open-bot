/**
 * Automation policy — who may do what to an automation (v0.52, P0-5).
 *
 * Modelled on Grok Bot's policy-based automation permissions
 * (`GrokBotAutomationPolicyAction`: CREATE, CHANGE_POLICY, … and
 * `GrokBotAutomationAction`: OPEN, TOGGLE, EDIT, DELETE, derived from
 * `viewerCapabilities` / `viewerPermissions.allowedActions`), mapped
 * onto open-bot's local team roles (see `team/types.ts`):
 *
 *   - admin:  every action, including CHANGE_POLICY.
 *   - member: CREATE, OPEN, TOGGLE, EDIT, DELETE — but EDIT / TOGGLE /
 *     DELETE only for automations they created themselves (or legacy
 *     automations with no creator recorded). No CHANGE_POLICY.
 *   - viewer: OPEN only (see, never change or run).
 *
 * Two extra rules, both fail-closed:
 * - An automation with `access.roles` set additionally requires the
 *   viewer's role to be listed (admins always pass — an admin must
 *   always be able to recover an automation).
 * - Running an automation (`runNow` / retry) is checked as TOGGLE:
 *   Grok's policy set has no separate RUN action, and actuating an
 *   automation changes runtime state just like toggling it. Viewers
 *   therefore never actuate.
 *
 * This is a LOCAL sharing model for a trusted single install, like
 * the team module itself: it is not access control against a hostile
 * user. The scheduler enforces it only when the host supplies a
 * `policyChecker`; with no checker configured (plain single-user
 * install) everything is allowed.
 */

import type { Automation } from './types';
import type { TeamRole } from '../team/types';
import { TEAM_ROLES } from '../team/types';

/** Policy actions for automations (Grok Bot's `GrokBotAutomationPolicyAction` + action set). */
export type AutomationPolicyAction =
  | 'CREATE'
  | 'CHANGE_POLICY'
  | 'OPEN'
  | 'TOGGLE'
  | 'EDIT'
  | 'DELETE';

export const AUTOMATION_POLICY_ACTIONS: readonly AutomationPolicyAction[] = [
  'CREATE',
  'CHANGE_POLICY',
  'OPEN',
  'TOGGLE',
  'EDIT',
  'DELETE',
];

/**
 * Actions a viewer with this role may perform. `createdBy` ownership
 * (member editing only their own) is applied by `canAutomationAction`,
 * not here.
 */
export function viewerAutomationCapabilities(role: TeamRole): AutomationPolicyAction[] {
  switch (role) {
    case 'admin':
      return [...AUTOMATION_POLICY_ACTIONS];
    case 'member':
      return ['CREATE', 'OPEN', 'TOGGLE', 'EDIT', 'DELETE'];
    case 'viewer':
      return ['OPEN'];
    default:
      return [];
  }
}

export interface AutomationPolicyCheckOptions {
  /** userId of the viewer asking. */
  userId?: string;
  /** userId recorded on the automation (`createdBy`, '' = unknown / legacy). */
  createdBy?: string;
}

/**
 * May this role perform this action? Fail-closed: unknown roles and
 * unknown actions are denied.
 */
export function canAutomationAction(
  role: TeamRole,
  action: AutomationPolicyAction,
  opts: AutomationPolicyCheckOptions = {},
): boolean {
  if (!TEAM_ROLES.includes(role)) return false;
  if (!AUTOMATION_POLICY_ACTIONS.includes(action)) return false;
  if (!viewerAutomationCapabilities(role).includes(action)) return false;
  // Members only manage automations they created (legacy automations
  // with no creator are manageable by any member, as before).
  if (role === 'member' && (action === 'EDIT' || action === 'TOGGLE' || action === 'DELETE')) {
    const createdBy = opts.createdBy ?? '';
    if (createdBy !== '' && opts.userId !== undefined && opts.userId !== createdBy) return false;
  }
  return true;
}

/** Does an automation's own `access.roles` allow this role? Admins always pass. */
export function automationAccessAllows(automation: Automation, role: TeamRole): boolean {
  if (role === 'admin') return true;
  const roles = automation.access?.roles;
  if (roles === undefined) return true;
  return roles.includes(role);
}

export interface AutomationPolicyContext {
  automation?: Automation;
}

/** A checker the host supplies to the scheduler; returns true when allowed. */
export type AutomationPolicyChecker = (
  action: AutomationPolicyAction,
  ctx: AutomationPolicyContext,
) => boolean;

/**
 * Build a checker for one viewer (role + userId). It applies the
 * role map, the member-ownership rule (via `automation.createdBy`)
 * and the automation's own `access.roles` restriction.
 */
export function createRolePolicyChecker(role: TeamRole, userId?: string): AutomationPolicyChecker {
  return (action, ctx) => {
    const automation = ctx.automation;
    if (automation && !automationAccessAllows(automation, role)) return false;
    return canAutomationAction(role, action, { userId, createdBy: automation?.createdBy });
  };
}

/** Human-readable denial message for the UI / IPC error. */
export function automationPolicyDeniedMessage(role: TeamRole, action: AutomationPolicyAction): string {
  return `Role "${role}" is not allowed to perform automation action "${action}".`;
}
