/**
 * Self-evolving skills — skills the agent proposes from experience
 * (v1.02 rescue port of the v1.00 work).
 *
 * Idea learned from closed learning loops: an agent derives a
 * "skill" from tasks it completed successfully, then improves that
 * skill through later uses based on success/failure feedback — but
 * redesigned from scratch for open-bot, 100% local, NO model, NO
 * content copied from any repo.
 *
 * Lifecycle of an evolved skill:
 *  1. PROPOSE — `proposeSkillsFromTasks()` groups successful task
 *     logs by their IDENTICAL tool sequence (e.g. `read_file >
 *     grep_search > write_file` repeated 3 times) and drafts a
 *     skill in Agent Skills form (description + when to use +
 *     steps + example). All deterministic rules on logs — no model,
 *     no invention.
 *  2. REVIEW — a new skill is `proposed`, NOT active: only the user
 *     may approve (`approveSkill`) or reject (`rejectSkill`).
 *     Approving writes the `SKILL.md` file into the user's skills
 *     directory so the existing loader loads it like a normal skill.
 *  3. EVOLVE — each time the skill is used, the host records
 *     feedback (`recordFeedback`: success/failure + note). With
 *     enough evidence (>= 3 feedbacks since the last evolve, of
 *     which >= 2 failures), `maybeEvolveSkill()` automatically bumps
 *     the version (v1 -> v2...) and appends a "Lessons learned"
 *     section from the failure notes to the body — the skill learns
 *     from its own mistakes. Every evolve is recorded in `history`
 *     for the user to review.
 *  4. DELETE — the user deletes a skill any time (`deleteSkill`);
 *     the written SKILL.md is deleted too (best-effort).
 *
 * Storage: one JSON file `.open-bot/evolved-skills.json` (atomic
 * temp + rename, mode 0600, like LongTermMemory). An approved skill
 * keeps its record in the store (to track version/feedback) + its
 * SKILL.md in the user's skills directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const EVOLVED_SKILLS_REL_PATH = path.join('.open-bot', 'evolved-skills.json');
/** Minimum successful tasks with the same tool sequence to propose a skill. */
export const MIN_TASKS_TO_PROPOSE = 2;
/** Minimum feedbacks since the last evolve to consider evolving again. */
export const MIN_FEEDBACKS_TO_EVOLVE = 3;
/** Minimum failures among those feedbacks to evolve. */
export const MIN_FAILURES_TO_EVOLVE = 2;
/** Max description length (Agent Skills standard: 1-1024). */
export const MAX_EVOLVED_DESCRIPTION_LENGTH = 1024;
/** Max body length of a generated skill. */
export const MAX_EVOLVED_BODY_CHARS = 20000;
/** Max length of one feedback note. */
export const MAX_FEEDBACK_NOTE_LENGTH = 1000;

/** Lifecycle state of an evolved skill (only the user moves proposed -> approved/rejected). */
export type EvolvedSkillStatus = 'proposed' | 'approved' | 'rejected' | 'disabled';

export interface SkillFeedback {
  at: string;
  outcome: 'success' | 'failure';
  /** Short note (e.g. why it failed) — used as "lessons learned" when evolving. */
  note?: string;
}

export interface EvolvedSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  version: number;
  status: EvolvedSkillStatus;
  /** Tool sequence the skill was proposed from. */
  toolSequence: string[];
  /** Task ids that led to the proposal. */
  sourceTaskIds: string[];
  feedback: SkillFeedback[];
  /** Feedbacks counted at the last evolve (to measure "since then"). */
  feedbacksAtLastEvolve: number;
  history: Array<{ at: string; event: string; detail?: string }>;
  createdAt: string;
  updatedAt: string;
}

/** One completed task log (what the agent did). */
export interface TaskLogEntry {
  id: string;
  title: string;
  success: boolean;
  /** Tool names in call order. */
  tools: string[];
}

/** Draft a skill from a repeated tool sequence (pure, deterministic). */
export function draftSkillFromTasks(tasks: TaskLogEntry[]): EvolvedSkill | undefined {
  if (tasks.length < MIN_TASKS_TO_PROPOSE) return undefined;
  const sequence = tasks[0].tools.join(' > ');
  const name = `auto-${tasks[0].tools.join('-').slice(0, 40)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const steps = tasks[0].tools.map((tool, index) => `${index + 1}. Call \`${tool}\` with the inputs from the task.`);
  const description = `Repeated ${tasks.length} times: ${sequence}. Use when the task needs this exact sequence.`;
  const body = [
    `# ${name}`,
    '',
    description,
    '',
    '## When to use',
    '',
    `When the task matches this pattern: ${sequence}.`,
    '',
    '## Steps',
    '',
    ...steps,
    '',
    '## Example',
    '',
    `Task: "${tasks[0].title}" — followed the steps above and succeeded.`,
    '',
  ].join('\n');
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    description: description.slice(0, MAX_EVOLVED_DESCRIPTION_LENGTH),
    body: body.slice(0, MAX_EVOLVED_BODY_CHARS),
    version: 1,
    status: 'proposed',
    toolSequence: tasks[0].tools,
    sourceTaskIds: tasks.map((t) => t.id),
    feedback: [],
    feedbacksAtLastEvolve: 0,
    history: [{ at: now, event: 'proposed', detail: `${tasks.length} tasks` }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Store for evolved skills (JSON file, atomic writes). */
export class EvolvedSkillStore {
  private readonly filePath: string;
  private readonly userSkillsDir: string;
  private skills: EvolvedSkill[] = [];

  constructor(workspaceDir: string, userSkillsDir: string) {
    this.filePath = path.join(workspaceDir, EVOLVED_SKILLS_REL_PATH);
    this.userSkillsDir = userSkillsDir;
    this.load();
  }

  /** Propose skills from successful task logs (grouped by identical tool sequence). */
  proposeSkillsFromTasks(tasks: TaskLogEntry[]): EvolvedSkill[] {
    const groups = new Map<string, TaskLogEntry[]>();
    for (const task of tasks) {
      if (!task.success || task.tools.length === 0) continue;
      const key = task.tools.join(' > ');
      const group = groups.get(key) ?? [];
      group.push(task);
      groups.set(key, group);
    }
    const proposed: EvolvedSkill[] = [];
    for (const group of groups.values()) {
      if (group.length < MIN_TASKS_TO_PROPOSE) continue;
      const draft = draftSkillFromTasks(group);
      if (!draft) continue;
      if (this.skills.some((s) => s.name === draft.name)) continue;
      this.skills.push(draft);
      proposed.push(draft);
    }
    if (proposed.length > 0) this.persist();
    return proposed;
  }

  list(): EvolvedSkill[] {
    return [...this.skills];
  }

  get(id: string): EvolvedSkill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /** Approve a proposed skill: writes SKILL.md into the user's skills dir. */
  approveSkill(id: string): EvolvedSkill {
    const skill = this.get(id);
    if (!skill) throw new Error(`unknown evolved skill: ${id}`);
    if (skill.status !== 'proposed') throw new Error(`cannot approve a skill in status ${skill.status}`);
    const dir = path.join(this.userSkillsDir, skill.name);
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = [
      '---',
      `name: ${skill.name}`,
      `description: ${JSON.stringify(skill.description)}`,
      `version: ${skill.version}.0.0`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}${skill.body}`, 'utf8');
    skill.status = 'approved';
    skill.updatedAt = new Date().toISOString();
    skill.history.push({ at: skill.updatedAt, event: 'approved' });
    this.persist();
    return { ...skill };
  }

  /** Reject a proposed skill (no file is written). */
  rejectSkill(id: string): EvolvedSkill {
    const skill = this.get(id);
    if (!skill) throw new Error(`unknown evolved skill: ${id}`);
    skill.status = 'rejected';
    skill.updatedAt = new Date().toISOString();
    skill.history.push({ at: skill.updatedAt, event: 'rejected' });
    this.persist();
    return { ...skill };
  }

  /** Record one use of a skill (success/failure + note). */
  recordFeedback(id: string, outcome: 'success' | 'failure', note?: string): EvolvedSkill {
    const skill = this.get(id);
    if (!skill) throw new Error(`unknown evolved skill: ${id}`);
    skill.feedback.push({
      at: new Date().toISOString(),
      outcome,
      ...(note ? { note: note.slice(0, MAX_FEEDBACK_NOTE_LENGTH) } : {}),
    });
    skill.updatedAt = new Date().toISOString();
    this.persist();
    return { ...skill };
  }

  /**
   * Evolve a skill when there is enough failure evidence since the
   * last evolve (>= 3 feedbacks, >= 2 failures): bump the version
   * and append "Lessons learned" from the failure notes.
   */
  maybeEvolveSkill(id: string): EvolvedSkill | undefined {
    const skill = this.get(id);
    if (!skill) throw new Error(`unknown evolved skill: ${id}`);
    const recent = skill.feedback.slice(skill.feedbacksAtLastEvolve);
    const failures = recent.filter((f) => f.outcome === 'failure');
    if (recent.length < MIN_FEEDBACKS_TO_EVOLVE || failures.length < MIN_FAILURES_TO_EVOLVE) return undefined;
    skill.version++;
    skill.feedbacksAtLastEvolve = skill.feedback.length;
    const lessons = failures
      .map((f) => f.note)
      .filter((note): note is string => Boolean(note))
      .map((note) => `- ${note}`);
    const addition = `\n## Lessons learned (v${skill.version})\n\n${lessons.length > 0 ? lessons.join('\n') : '- Avoid repeating the last failed approach.'}\n`;
    skill.body = (skill.body + addition).slice(0, MAX_EVOLVED_BODY_CHARS);
    skill.updatedAt = new Date().toISOString();
    skill.history.push({ at: skill.updatedAt, event: 'evolved', detail: `v${skill.version}` });
    this.persist();
    return { ...skill };
  }

  /** Delete a skill (and its SKILL.md, best-effort). */
  deleteSkill(id: string): boolean {
    const index = this.skills.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const [skill] = this.skills.splice(index, 1);
    try {
      fs.rmSync(path.join(this.userSkillsDir, skill.name), { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
    this.persist();
    return true;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.skills = parsed.filter(
          (entry): entry is EvolvedSkill =>
            typeof entry === 'object' && entry !== null && typeof (entry as EvolvedSkill).id === 'string',
        );
      }
    } catch {
      this.skills = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.skills, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Store is best-effort; a failed write must not break the run.
    }
  }
}
