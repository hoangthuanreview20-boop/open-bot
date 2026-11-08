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
