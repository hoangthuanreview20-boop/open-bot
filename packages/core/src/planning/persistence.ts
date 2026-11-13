/**
 * Plan persistence (v0.98, Team T4 — planning v2).
 *
 * Run-bound plans live as one JSON file per plan under
 * `<dataDir>/run-plans/<planId>.json` (same dataDir the coordinator
 * already uses for auto-approve rules). The file is an envelope
 * around the engine's `toJSON` shape, plus the run that owns the
 * plan — so a restart can reload the plan AND know which run it
 * belonged to.
 *
 * Resume rule (the point of this module): a step that was `running`
 * when the process died can never be running any more — the run
 * that owned it is gone. On `resumePlans()` every `running` step
 * goes back to `pending` (attempts kept, so the UI can show the
 * step was interrupted), and the caller gets the list of plans that
 * actually had a running step, so it can say so in the UI instead
 * of silently pretending nothing happened.
 *
 * All methods are synchronous and best-effort where the caller
 * says so: a corrupt file is skipped (not fatal) and reported in
 * the `skipped` list, so one bad file never blocks the rest.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from './engine';

export interface StoredRunPlan {
  plan: Plan;
  /** Run the plan was bound to (null = created, not yet run). */
  runId: string | null;
  /** Bot that owns the plan. */
  botId: string | null;
  /** Template the plan was created from, if any. */
  templateId?: string | null;
  savedAt: number;
}

export interface ResumeResult {
  /** Plans that had at least one `running` step reset to `pending`. */
  resumed: StoredRunPlan[];
  /** Plans loaded unchanged (no running step). */
  untouched: StoredRunPlan[];
  /** File names skipped because they did not parse / validate. */
  skipped: string[];
}

export const RUN_PLANS_DIR = 'run-plans';

function safePlanId(planId: string): string {
  // File names come from ids the engine generated; refuse anything
  // that could escape the plans directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId)) {
    throw new Error(`Unsafe plan id for storage: ${planId}`);
  }
  return planId;
}

function isValidPlan(value: unknown): value is Plan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as { id?: unknown; steps?: unknown };
  return typeof plan.id === 'string' && Array.isArray(plan.steps);
}

export class PlanFileStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, RUN_PLANS_DIR);
  }

  /** Directory the store writes into (tests assert on it). */
  get directory(): string {
    return this.dir;
  }

  save(stored: StoredRunPlan): string {
    safePlanId(stored.plan.id);
    fs.mkdirSync(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${stored.plan.id}.json`);
    const payload: StoredRunPlan = { ...stored, savedAt: Date.now() };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  }

  load(planId: string): StoredRunPlan | null {
    const filePath = path.join(this.dir, `${safePlanId(planId)}.json`);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const data = parsed as Partial<StoredRunPlan>;
      if (!isValidPlan(data.plan)) return null;
      return {
        plan: data.plan,
        runId: typeof data.runId === 'string' ? data.runId : null,
        botId: typeof data.botId === 'string' ? data.botId : null,
        templateId: typeof data.templateId === 'string' ? data.templateId : null,
        savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
      };
    } catch {
      return null;
    }
  }

  list(): StoredRunPlan[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: StoredRunPlan[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const loaded = this.load(name.slice(0, -'.json'.length));
      if (loaded) out.push(loaded);
    }
    return out;
  }

  delete(planId: string): boolean {
    const filePath = path.join(this.dir, `${safePlanId(planId)}.json`);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load every stored plan; reset `running` steps to `pending`
   * (the run that owned them is gone) and re-save the changed
   * plans. A corrupt file is reported in `skipped`, never thrown.
   *
   * `excludeIds` are plans with a run still alive (a caller that
   * opens the planner while a run executes a plan): their running
   * step belongs to the live run, so they come back `untouched`
   * instead of being reset under it.
   */
  resumePlans(excludeIds?: ReadonlySet<string>): ResumeResult {
    const resumed: StoredRunPlan[] = [];
    const untouched: StoredRunPlan[] = [];
    const skipped: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return { resumed, untouched, skipped };
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const planId = name.slice(0, -'.json'.length);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      } catch {
        skipped.push(name);
        continue;
      }
      if (typeof raw !== 'object' || raw === null || !isValidPlan((raw as { plan?: unknown }).plan)) {
        skipped.push(name);
        continue;
      }
      const stored = this.load(planId);
      if (!stored) {
        skipped.push(name);
        continue;
      }
      if (excludeIds?.has(planId)) {
        untouched.push(stored);
        continue;
      }
      const running = stored.plan.steps.filter((s) => s.status === 'running');
      if (running.length === 0) {
        untouched.push(stored);
        continue;
      }
      for (const step of running) {
        step.status = 'pending';
        step.startedAt = null;
        step.finishedAt = null;
      }
      stored.plan.updatedAt = Date.now();
      stored.runId = null;
      this.save(stored);
      resumed.push(stored);
    }
    return { resumed, untouched, skipped };
  }
}
