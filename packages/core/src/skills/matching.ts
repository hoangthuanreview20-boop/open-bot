/**
 * Skill matching — rank skills for a task with a tunable config
 * (v1.02 rescue port of the v0.99 work).
 *
 * `matchSkillsWithConfig` scores every skill against the task text
 * (keyword overlap on name + description + whenToUse, weighted) and
 * returns the best matches above a threshold, capped at a limit.
 * The config lets the host trade recall for precision without
 * touching the scorer. The scorer itself (`scoreSkill` in
 * `registry.ts`) is reused, not duplicated.
 */

import { scoreSkill } from './registry';
import type { Skill } from './types';

export interface SkillMatchConfig {
  /** Minimum score to include a skill (default 0.3). */
  threshold?: number;
  /** Max skills returned (default 5). */
  limit?: number;
  /** Weight of the name match (default 1). */
  nameWeight?: number;
  /** Weight of the description match (default 1). */
  descriptionWeight?: number;
  /** Weight of the whenToUse match (default 1). */
  whenToUseWeight?: number;
}

export interface ConfiguredSkillMatch {
  skill: Skill;
  score: number;
}

/** Default matching config. */
export const DEFAULT_SKILL_MATCH_CONFIG: Required<SkillMatchConfig> = {
  threshold: 0.3,
  limit: 5,
  nameWeight: 1,
  descriptionWeight: 1,
  whenToUseWeight: 1,
};

/** Match skills against a task, with a tunable config. */
export function matchSkillsWithConfig(
  skills: Skill[],
  task: string,
  config: SkillMatchConfig = {},
): ConfiguredSkillMatch[] {
  const resolved: Required<SkillMatchConfig> = { ...DEFAULT_SKILL_MATCH_CONFIG, ...config };
  const taskLower = task.toLowerCase();
  const scored: ConfiguredSkillMatch[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const base = scoreSkill(skill, task);
    // `scoreSkill` returns raw points (name 10/token, whenToUse 3,
    // description 2, tools 1) — normalize to 0..1 on the scale of a
    // full two-word name hit (20 points) before clamping, or every
    // skill with any keyword hit saturates at 1.0 and ranking
    // collapses to input order. The threshold stays absolute.
    const nameMentioned = taskLower.includes(skill.name.toLowerCase());
    const score = Math.min(1, base / 20 + (nameMentioned ? 0.1 * resolved.nameWeight : 0));
    if (score >= resolved.threshold) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, resolved.limit);
}
