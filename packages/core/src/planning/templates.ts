/**
 * Plan templates (v0.98, Team T4 — planning v2).
 *
 * Ready-made plans for the task shapes that show up most often.
 * A template is a title pattern plus ordered steps with `{variable}`
 * placeholders — `instantiate()` fills them in and returns the
 * concrete plan (title + steps) the caller hands to PlanEngine.
 *
 * Steps are plan content (like steps a user types by hand), so they
 * stay in English in core; the template *name* and *description*
 * shown in the picker are localised in the UI
 * (`planner.template.<id>.name` / `.desc`).
 *
 * Templates shipped:
 *   research     — research a topic and write up findings.
 *   code-fix     — reproduce, fix and verify a bug.
 *   automation   — a multi-step automation (gather → act → verify).
 *   content      — draft, revise and publish a piece of writing.
 */

export interface PlanTemplateVariable {
  /** Placeholder name, e.g. `topic` for `{topic}`. */
  name: string;
  /** Whether instantiate() refuses to run without it. */
  required: boolean;
  /** Short hint shown in the picker (English; UI may localise). */
  hint: string;
  /** Value used when an optional variable is not supplied. */
  default?: string;
}

export interface PlanTemplateStep {
  title: string;
  detail?: string;
}

export interface PlanTemplate {
  id: string;
  /** Title pattern — may contain `{variable}` placeholders. */
  title: string;
  steps: PlanTemplateStep[];
  variables: PlanTemplateVariable[];
}

export interface InstantiatedPlan {
  title: string;
  steps: string[];
  templateId: string;
}

function variableNames(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}

export const PLAN_TEMPLATES: readonly PlanTemplate[] = [
  {
    id: 'research',
    title: 'Research: {topic}',
    variables: [
      { name: 'topic', required: true, hint: 'Topic to research' },
      { name: 'audience', required: false, hint: 'Who the findings are for', default: 'the team' },
    ],
    steps: [
      {
        title: 'Clarify the research question for "{topic}"',
        detail: 'Write down what a good answer looks like and what is out of scope.',
      },
      {
        title: 'Gather sources on "{topic}" from several independent places',
        detail: 'Prefer primary sources; note the date and author of each.',
      },
      {
        title: 'Compare the sources and note where they agree or disagree',
        detail: 'Flag contradictions explicitly instead of picking one side silently.',
      },
      {
        title: 'Draft the findings for {audience}',
        detail: 'Lead with the answer, then the evidence, then the caveats.',
      },
      {
        title: 'Check every factual claim against its source',
        detail: 'Drop or fix anything that cannot be traced back.',
      },
      { title: 'Deliver the final write-up on "{topic}"' },
    ],
  },
  {
    id: 'code-fix',
    title: 'Fix: {issue}',
    variables: [
      { name: 'issue', required: true, hint: 'Bug or issue to fix' },
      { name: 'area', required: false, hint: 'Code area / module involved', default: 'the affected code' },
    ],
    steps: [
      {
        title: 'Reproduce "{issue}" in {area}',
        detail: 'Record the exact steps, input and observed output.',
      },
      {
        title: 'Locate the root cause in {area}',
        detail: 'Read the code path, not just the symptom — note the file and lines.',
      },
      {
        title: 'Write a failing test for "{issue}"',
        detail: 'The test must fail before the fix and pass after it.',
      },
      {
        title: 'Apply the minimal fix for "{issue}"',
        detail: 'Change the cause, not the symptom; keep the diff small.',
      },
      {
        title: 'Run the failing test plus the surrounding test suite',
        detail: 'No regressions in neighbouring tests.',
      },
      { title: 'Review the diff and clean up reproduction artefacts' },
    ],
  },
  {
    id: 'automation',
    title: 'Automate: {task}',
    variables: [
      { name: 'task', required: true, hint: 'Multi-step task to automate' },
      { name: 'trigger', required: false, hint: 'What starts the automation', default: 'on demand' },
    ],
    steps: [
      {
        title: 'Describe "{task}" end to end and its trigger ({trigger})',
        detail: 'List inputs, outputs and the success condition before automating anything.',
      },
      {
        title: 'Do "{task}" once by hand and record every step',
        detail: 'The manual run is the spec — automate what actually happened.',
      },
      {
        title: 'Break "{task}" into steps that can each succeed or fail independently',
        detail: 'Each step gets one clear outcome so a failure points at one place.',
      },
      {
        title: 'Automate the steps in order, dry-run first',
        detail: 'Dry-run must show the exact actions before anything executes for real.',
      },
      {
        title: 'Add a check after each step of "{task}"',
        detail: 'A step that silently fails is worse than a step that loudly stops.',
      },
      {
        title: 'Run "{task}" live once and verify the outcome',
        detail: 'Compare the live result against the manual run from step 2.',
      },
      { title: 'Save "{task}" as a repeatable automation with its trigger ({trigger})' },
    ],
  },
  {
    id: 'content',
    title: 'Write: {topic}',
    variables: [
      { name: 'topic', required: true, hint: 'Topic of the piece' },
      { name: 'audience', required: false, hint: 'Who will read it', default: 'the team' },
      { name: 'format', required: false, hint: 'Post, article, script…', default: 'piece' },
    ],
    steps: [
      {
        title: 'Define the angle and audience for "{topic}" ({audience})',
        detail: 'One idea per piece; write down the single takeaway for the reader.',
      },
      {
        title: 'Outline the {format} on "{topic}"',
        detail: 'Headline, three beats, closing — no prose yet.',
      },
      {
        title: 'Draft the {format} on "{topic}"',
        detail: 'Write fast; do not edit while drafting.',
      },
      {
        title: 'Revise for clarity: cut, reorder, strengthen the opening',
        detail: 'Every paragraph must earn its place for {audience}.',
      },
      {
        title: 'Fact-check names, numbers and quotes in the draft',
        detail: 'Fix or remove anything unverifiable.',
      },
      { title: 'Final read-aloud pass and publish the {format}' },
    ],
  },
];

/** Template metadata for pickers (no step text — the UI fetches that on create). */
export function listPlanTemplates(): Array<{
  id: string;
  title: string;
  stepCount: number;
  variables: PlanTemplateVariable[];
}> {
  return PLAN_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    stepCount: t.steps.length,
    variables: t.variables.map((v) => ({ ...v })),
  }));
}

export function getPlanTemplate(id: string): PlanTemplate | null {
  return PLAN_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Fill a template's variables and return the concrete plan. Throws
 * when the template is unknown, a required variable is missing, or
 * a step would still contain an unfilled `{placeholder}`.
 */
export function instantiatePlanTemplate(
  id: string,
  vars: Record<string, string>,
): InstantiatedPlan {
  const template = getPlanTemplate(id);
  if (!template) throw new Error(`Unknown plan template: ${id}`);
  for (const variable of template.variables) {
    if (variable.required && !(vars[variable.name] ?? '').trim()) {
      throw new Error(`Template "${id}" needs a value for "${variable.name}".`);
    }
  }
  // Optional variables fall back to their default (or '' when they
  // have none) so a template never ships with an unfilled `{...}`.
  const effective: Record<string, string> = {};
  for (const variable of template.variables) {
    const supplied = (vars[variable.name] ?? '').trim();
    effective[variable.name] = supplied || variable.default || '';
  }
  const filled = (text: string): string => {
    const out = fill(text, effective);
    const missing = variableNames(out);
    if (missing.length > 0) {
      throw new Error(
        `Template "${id}" is missing values for: ${missing.join(', ')}.`,
      );
    }
    return out;
  };
  return {
    title: filled(template.title),
    steps: template.steps.map((s) => filled(s.title)),
    templateId: template.id,
  };
}
