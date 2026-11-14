/**
 * Skill token budget — cap how much prompt a skill may cost (v1.02
 * rescue port of the v0.99 work).
 *
 * A skill body injected into a prompt costs tokens. `SkillTokenBudget`
 * tracks how much of the budget the selected skills use and drops
 * the lowest-priority bodies when the budget is exceeded (tier-1
 * index entries — name + description — are always kept, so the model
 * still knows the skill exists). Estimation is chars/4, the same
 * heuristic as the context estimator.
 */

import { estimateTokens } from './registry';
import type { Skill } from './types';

export interface SkillTokenBudgetOptions {
  /** Max tokens for all skill bodies together (default 8000). */
  maxTokens?: number;
}

/** One skill's cost inside the budget. */
export interface SkillCost {
  name: string;
  tokens: number;
  /** True when the body was dropped for budget. */
  bodyDropped: boolean;
}

/** Tracks and enforces a token budget for injected skill bodies. */
export class SkillTokenBudget {
  private readonly maxTokens: number;
  private used = 0;
  private readonly costs: SkillCost[] = [];

  constructor(options: SkillTokenBudgetOptions = {}) {
    this.maxTokens = options.maxTokens ?? 8000;
  }

  /** Tokens spent so far. */
  get usedTokens(): number {
    return this.used;
  }

  /** Tokens left in the budget. */
  get remainingTokens(): number {
    return Math.max(0, this.maxTokens - this.used);
  }

  /**
   * Decide which skill bodies fit: skills are taken in order until
   * the budget runs out; the rest keep only their index entry.
   * Returns the skills whose body is kept, in input order.
   */
  fit(skills: Skill[]): { kept: Skill[]; dropped: Skill[]; costs: SkillCost[] } {
    const kept: Skill[] = [];
    const dropped: Skill[] = [];
    this.used = 0;
    this.costs.length = 0;
    for (const skill of skills) {
      const tokens = estimateTokens(skill.body);
      if (this.used + tokens <= this.maxTokens) {
        this.used += tokens;
        this.costs.push({ name: skill.name, tokens, bodyDropped: false });
        kept.push(skill);
      } else {
        this.costs.push({ name: skill.name, tokens, bodyDropped: true });
        dropped.push(skill);
      }
    }
    return { kept, dropped, costs: [...this.costs] };
  }

  /** Cost breakdown of the last `fit` call. */
  get lastCosts(): SkillCost[] {
    return [...this.costs];
  }
}
