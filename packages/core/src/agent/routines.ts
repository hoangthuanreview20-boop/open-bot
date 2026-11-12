/**
 * Routines — scheduled prompts a bot runs every N minutes ("check the
 * inbox every 30 minutes", "summarise the news every morning" — the bot
 * itself decides what the prompt means; the routine only decides WHEN).
 *
 * Routines are stored as JSON in memory_entries under the key 'routines'
 * (one entry per bot), so no extra table is needed.
 *
 * This module deliberately never runs a timer: the main process / UI owns
 * scheduling and calls `routinesDue()` on its own tick, then feeds the
 * returned prompts to an AgentRunner and updates `lastRunAt`.
 */

import type { BotMemory } from './memory';
import type { Automation } from '../automations/types';

export interface Routine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  /** Run every N minutes. */
  cronMinutes: number;
  enabled: boolean;
  /** ISO timestamp of the last run, or null/undefined if never run. */
  lastRunAt?: string | null;
}

const ROUTINES_KEY = 'routines';

/** All routines stored for one bot (empty array when none are stored). */
export function loadRoutines(memory: BotMemory, botId: string): Routine[] {
  const raw = memory.getMemory(botId, ROUTINES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Routine[]) : [];
  } catch {
    // Corrupt JSON: start clean rather than crashing the scheduler tick.
    return [];
  }
}

/** Insert or replace one routine (matched by id) and persist the list. */
export function saveRoutine(memory: BotMemory, routine: Routine): void {
  const all = loadRoutines(memory, routine.botId);
  const i = all.findIndex((r) => r.id === routine.id);
  if (i >= 0) {
    all[i] = routine;
  } else {
    all.push(routine);
  }
  memory.setMemory(routine.botId, ROUTINES_KEY, JSON.stringify(all));
}

export function isRoutineDue(r: Routine, now: Date): boolean {
  if (!r.enabled) return false;
  if (!r.lastRunAt) return true;
  const elapsedMs = now.getTime() - new Date(r.lastRunAt).getTime();
  return elapsedMs >= r.cronMinutes * 60_000;
}

/** Routines whose interval has elapsed since their last run. */
export function routinesDue(routines: Routine[], now: Date): Routine[] {
  return routines.filter((r) => isRoutineDue(r, now));
}

// ---------------------------------------------------------------------------
// v0.4: routines on top of the automation engine
// ---------------------------------------------------------------------------
//
// A routine IS an automation with an interval trigger and a run-agent
// action — the scheduler owns the timer, the missed-run policy and the
// run history, while routines keep their own storage (memory_entries
// key 'routines') and their own API below. Nothing above changed: the
// old functions keep working exactly as before, and existing tests pass
// unchanged.
//
// Migration path (used by the coordinator/main when it adopts the
// scheduler): `routineToAutomation()` converts one routine; the
// scheduler then runs it, and `saveRoutine()` can delete the routine
// once the automation is confirmed stored. Conversion is one-way on
// purpose — automations have triggers (cron/event) routines cannot
// express, so converting back would lose information.

/** Convert one routine into the equivalent automation (same id). */
export function routineToAutomation(routine: Routine): Automation {
  const now = new Date().toISOString();
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    trigger: { kind: 'interval', minutes: routine.cronMinutes },
    action: { kind: 'run-agent', botId: routine.botId, prompt: routine.prompt },
    enabled: routine.enabled,
    lastRunAt: routine.lastRunAt ?? null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Convert all stored routines of one bot into automations. */
export function routinesToAutomations(memory: BotMemory, botId: string): Automation[] {
  return loadRoutines(memory, botId).map((r) => routineToAutomation(r));
}

/** Delete one routine (used after it has been migrated to an automation). */
export function deleteRoutine(memory: BotMemory, botId: string, routineId: string): boolean {
  const all = loadRoutines(memory, botId);
  const next = all.filter((r) => r.id !== routineId);
  if (next.length === all.length) return false;
  memory.setMemory(botId, ROUTINES_KEY, JSON.stringify(next));
  return true;
}

// ---------------------------------------------------------------------------
// v0.72c (Team C): sample routines
// ---------------------------------------------------------------------------
//
// Pure seed data, no timers: the UI can offer these as one-click
// starting points and the user assigns a bot (botId is '' here) when
// seeding them. Nothing in this module runs them.

/**
 * Five sample routines a new user can seed. `botId` is intentionally
 * empty: the caller assigns the bot when seeding (see `saveRoutine`).
 * Prompts are short English instructions for the bot.
 */
export const SAMPLE_ROUTINES: Routine[] = [
  {
    id: 'morning-brief',
    botId: '',
    name: 'Morning brief',
    prompt:
      'Summarise the morning news: check the usual news sources and give a short briefing of the most important headlines, one line each.',
    cronMinutes: 480,
    enabled: true,
  },
  {
    id: 'inbox-check',
    botId: '',
    name: 'Inbox check',
    prompt:
      'Check the inbox and notes for anything new since the last check, and list new items briefly with what needs a reply or action.',
    cronMinutes: 30,
    enabled: true,
  },
  {
    id: 'weekly-report',
    botId: '',
    name: 'Weekly report',
    prompt:
      'Summarise this week’s work from the task files: what was finished, what is still open, and what is planned next.',
    cronMinutes: 10080,
    enabled: true,
  },
  {
    id: 'backup-reminder',
    botId: '',
    name: 'Backup reminder',
    prompt:
      'Remind the user to check that the workspace backup ran and that the latest backup is complete and restorable.',
    cronMinutes: 1440,
    enabled: true,
  },
  {
    id: 'code-health',
    botId: '',
    name: 'Code health',
    prompt:
      'Check the repository health: run git status, list uncommitted changes, and report any failing tests found in the latest test run.',
    cronMinutes: 10080,
    enabled: true,
  },
];

/**
 * Return a fresh copy of the sample routines. Routine fields are all
 * primitives, so a per-item spread is a full copy — mutating the
 * returned array never touches `SAMPLE_ROUTINES`.
 */
export function sampleRoutines(): Routine[] {
  return SAMPLE_ROUTINES.map((r) => ({ ...r }));
}
