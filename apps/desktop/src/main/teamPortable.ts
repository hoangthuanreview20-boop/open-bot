/**
 * Apply decisions for a portable team bundle (v0.80).
 *
 * PURE (no Electron, no file I/O, no settings access): given the
 * current local state + a validated bundle + the user's overwrite
 * choice, this decides exactly what changes — the desktop main process
 * then persists the plan (team.json, settings.bots, scheduler,
 * SKILL.md files) and reports the result.
 *
 * Rules (the "no overwrite without confirmation" contract):
 *  - Team: an EMPTY local team adopts the bundle team wholesale. A
 *    non-empty local team with the SAME teamId merges (members +
 *    shared bots union by id, bundle wins on the same id; local
 *    workspaceDir/egress kept when set, bundle's otherwise). A
 *    DIFFERENT non-empty team is a conflict: without overwrite the
 *    team is left untouched (skipped); with overwrite the bundle team
 *    replaces it. Service accounts NEVER come from a bundle (the
 *    bundle holds none — see portable.ts); the local accounts are
 *    always kept.
 *  - Bots: a bot id that already exists is SKIPPED without overwrite
 *    and REPLACED with overwrite; new ids are added.
 *  - Automations: same skip/replace rule by id. An automation whose
 *    action targets a bot that is neither local nor in the bundle is
 *    skipped (its bot does not exist here). A `webhook` automation
 *    always imports DISABLED — its HMAC key lives in the source
 *    machine's Vault and does not travel (listed in
 *    `webhookDisabledIds` so the UI can tell the user to recreate the
 *    key and re-enable it). Run history is reset (lastRunAt null;
 *    nextRunAt is recomputed by the scheduler on create/update).
 *  - Skills: same skip/replace rule by name.
 *
 * The plan never throws for conflicts — conflicts become `skipped`
 * entries (or replacements, with overwrite). It only throws on a
 * structurally invalid bundle (which `parseTeamBundle` already
 * rejects before this runs).
 */
import { isNonEmptyTeam, type TeamBundle, type TeamBundleSkill } from '@open-bot/core';
import type { Automation, BotConfig, TeamConfig } from '@open-bot/core';

export interface TeamImportSkipped {
  kind: 'team' | 'bot' | 'automation' | 'skill';
  id: string;
  reason: string;
}

export interface TeamImportPlanInput {
  currentTeam: TeamConfig;
  currentBots: BotConfig[];
  currentAutomations: Automation[];
  currentSkillNames: string[];
  bundle: TeamBundle;
  /** True only after the user confirmed overwriting conflicting items. */
  overwrite: boolean;
}

export interface TeamImportReport {
  teamChanged: boolean;
  botsAdded: number;
  botsReplaced: number;
  botsSkipped: number;
  automationsAdded: number;
  automationsReplaced: number;
  automationsSkipped: number;
  skillsWritten: number;
  skillsSkipped: number;
  webhookDisabled: number;
}

export interface TeamImportPlan {
  team: TeamConfig;
  botsToAdd: BotConfig[];
  botsToReplace: BotConfig[];
  automationsToAdd: Automation[];
  automationsToReplace: Automation[];
  skillsToWrite: TeamBundleSkill[];
  skipped: TeamImportSkipped[];
  webhookDisabledIds: string[];
  report: TeamImportReport;
}

function mergeTeamMembers(
  local: TeamConfig,
  incoming: TeamConfig,
): TeamConfig['members'] {
  const byId = new Map(local.members.map((m) => [m.userId, m]));
  for (const m of incoming.members) byId.set(m.userId, { ...m });
  return [...byId.values()];
}

function mergeSharedBots(
  local: TeamConfig,
  incoming: TeamConfig,
): TeamConfig['sharedBots'] {
  const byId = new Map(local.sharedBots.map((b) => [b.botId, b]));
  for (const b of incoming.sharedBots) byId.set(b.botId, { ...b });
  return [...byId.values()];
}

/** The action's bot, for run-agent / create-task actions ('' = none). */
function actionBotId(action: Automation['action']): string {
  if (action.kind === 'run-agent' || action.kind === 'create-task') return action.botId;
  return '';
}

export function planTeamImport(input: TeamImportPlanInput): TeamImportPlan {
  const { currentTeam, currentBots, currentAutomations, currentSkillNames, bundle, overwrite } = input;
  const bundleTeam = bundle.data.team;
  const skipped: TeamImportSkipped[] = [];
  const webhookDisabledIds: string[] = [];

  // -- team ---------------------------------------------------------------
  const localNonEmpty = isNonEmptyTeam(currentTeam);
  const localTeamId = currentTeam.teamId ?? '';
  const bundleTeamId = bundle.teamId || bundleTeam.teamId || '';
  let team: TeamConfig;
  let teamChanged = false;
  if (!localNonEmpty) {
    team = { ...bundleTeam, serviceAccounts: [] };
    teamChanged = true;
  } else if (localTeamId !== '' && bundleTeamId !== '' && localTeamId !== bundleTeamId) {
    if (!overwrite) {
      team = currentTeam;
      skipped.push({
        kind: 'team',
        id: bundleTeamId,
        reason: `Team hiện tại khác team trong file — nhập sẽ thay team hiện tại.`,
      });
    } else {
      team = { ...bundleTeam, serviceAccounts: currentTeam.serviceAccounts ?? [] };
      teamChanged = true;
    }
  } else {
    // Same team (or one side has no teamId): merge, bundle wins per id.
    team = {
      ...currentTeam,
      name: bundleTeam.name,
      members: mergeTeamMembers(currentTeam, bundleTeam),
      sharedBots: mergeSharedBots(currentTeam, bundleTeam),
      workspaceDir: currentTeam.workspaceDir ?? bundleTeam.workspaceDir,
      egress: bundleTeam.egress ?? currentTeam.egress,
    };
    teamChanged = true;
  }

  // -- bots ---------------------------------------------------------------
  const existingBotIds = new Set(currentBots.map((b) => b.id));
  const botsToAdd: BotConfig[] = [];
  const botsToReplace: BotConfig[] = [];
  for (const bot of bundle.data.bots) {
    if (existingBotIds.has(bot.id)) {
      if (overwrite) botsToReplace.push({ ...bot });
      else {
        skipped.push({ kind: 'bot', id: bot.id, reason: `Bot "${bot.name}" đã có trên máy này.` });
      }
    } else {
      botsToAdd.push({ ...bot });
    }
  }

  // -- automations ---------------------------------------------------------
  const knownBotIds = new Set([...existingBotIds, ...bundle.data.bots.map((b) => b.id)]);
  const existingAutoIds = new Set(currentAutomations.map((a) => a.id));
  const automationsToAdd: Automation[] = [];
  const automationsToReplace: Automation[] = [];
  const nowIso = new Date().toISOString();
  for (const auto of bundle.data.automations) {
    const targetBot = actionBotId(auto.action);
    if (targetBot !== '' && !knownBotIds.has(targetBot)) {
      skipped.push({
        kind: 'automation',
        id: auto.id,
        reason: `Automation "${auto.name}" gọi bot "${targetBot}" không có trên máy này (và không có trong file).`,
      });
      continue;
    }
    const normalized: Automation = {
      ...auto,
      // Webhook keys do not travel: import disabled, never enabled.
      enabled: auto.trigger.kind === 'webhook' ? false : auto.enabled,
      lastRunAt: null,
      nextRunAt: null,
      updatedAt: nowIso,
    };
    if (auto.trigger.kind === 'webhook') webhookDisabledIds.push(auto.id);
    if (existingAutoIds.has(auto.id)) {
      if (overwrite) automationsToReplace.push(normalized);
      else {
        skipped.push({ kind: 'automation', id: auto.id, reason: `Automation "${auto.name}" đã có trên máy này.` });
      }
    } else {
      automationsToAdd.push(normalized);
    }
  }

  // -- skills --------------------------------------------------------------
  const existingSkills = new Set(currentSkillNames);
  const skillsToWrite: TeamBundleSkill[] = [];
  for (const skill of bundle.data.skills) {
    if (existingSkills.has(skill.name)) {
      if (overwrite) skillsToWrite.push({ ...skill });
      else {
        skipped.push({ kind: 'skill', id: skill.name, reason: `Skill "${skill.name}" đã có trên máy này.` });
      }
    } else {
      skillsToWrite.push({ ...skill });
    }
  }

  const report: TeamImportReport = {
    teamChanged,
    botsAdded: botsToAdd.length,
    botsReplaced: botsToReplace.length,
    botsSkipped: skipped.filter((s) => s.kind === 'bot').length,
    automationsAdded: automationsToAdd.length,
    automationsReplaced: automationsToReplace.length,
    automationsSkipped: skipped.filter((s) => s.kind === 'automation').length,
    skillsWritten: skillsToWrite.length,
    skillsSkipped: skipped.filter((s) => s.kind === 'skill').length,
    webhookDisabled: webhookDisabledIds.length,
  };
  return {
    team,
    botsToAdd,
    botsToReplace,
    automationsToAdd,
    automationsToReplace,
    skillsToWrite,
    skipped,
    webhookDisabledIds,
    report,
  };
}
