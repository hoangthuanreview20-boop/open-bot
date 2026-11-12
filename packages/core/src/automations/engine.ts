/**
 * Automation engine (v0.4) — pure logic, no timers, no I/O.
 *
 * - Minimal cron: 5 fields `minute hour day-of-month month day-of-week`,
 *   supporting `*`, `*\/n`, `a-b`, `a-b/n`, `a,b` and single values.
 *   Day-of-week 0 and 7 both mean Sunday. When both day-of-month and
 *   day-of-week are restricted, a day matches if EITHER matches (the
 *   standard Vixie-cron rule).
 * - `automationDue()` decides whether a scheduled automation should fire
 *   now. `nextRunAtFor()` computes the next scheduled time.
 * - `evaluateCondition()` filters event triggers.
 * - `executeAutomation()` runs one action through the host handlers and
 *   returns an `AutomationRun` record (never throws for an action error —
 *   the error is recorded on the run instead).
 *
 * No new dependencies: the cron parser is ~120 lines written for this
 * module (see ROADMAP — no extra npm packages for v0.4).
 */

import { randomUUID } from 'node:crypto';
import type {
  Automation,
  AutomationAction,
  AutomationCondition,
  AutomationEvent,
  AutomationHandlers,
  AutomationRun,
  AutomationTriggerPresentation,
} from './types';
import { TEAM_ROLES } from '../team/types';

export const MAX_AUTOMATION_OUTPUT_CHARS = 20_000;

/** Max stored size of a webhook trigger input (JSON) on a run record. */
export const MAX_TRIGGER_INPUT_CHARS = 2_000;

function truncate(text: string, maxChars: number = MAX_AUTOMATION_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars ...]`;
}

// ---------------------------------------------------------------------------
// Minimal cron
// ---------------------------------------------------------------------------

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the day-of-month field was restricted (not `*`). */
  domRestricted: boolean;
  /** True when the day-of-week field was restricted (not `*`). */
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();
  const addRange = (from: number, to: number, step: number): void => {
    if (from < min || to > max || from > to || step < 1) {
      throw new Error(`Invalid cron ${label} field ${JSON.stringify(field)}.`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  };
  for (const part of field.split(',')) {
    if (part === '*') {
      addRange(min, max, 1);
      continue;
    }
    const slash = part.split('/');
    const base = slash[0]!;
    const step = slash.length > 1 ? Number(slash[1]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${label} step in ${JSON.stringify(field)}.`);
    }
    if (base === '*') {
      addRange(min, max, step);
    } else if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Invalid cron ${label} range in ${JSON.stringify(field)}.`);
      }
      addRange(a, b, step);
    } else {
      const v = Number(base);
      if (!Number.isInteger(v) || v < min || v > max) {
        throw new Error(`Invalid cron ${label} value ${JSON.stringify(field)}.`);
      }
      values.add(v);
    }
  }
  if (values.size === 0) throw new Error(`Invalid cron ${label} field ${JSON.stringify(field)}.`);
  return values;
}

/** Parse a 5-field cron expression. Throws on any invalid field. */
export function parseCronExpression(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression ${JSON.stringify(expression)}: expected 5 fields "minute hour day month weekday".`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const dayOfWeek = parseCronField(dow, 0, 7, 'weekday');
  // Normalise Sunday: 7 -> 0.
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return {
    minute: parseCronField(minute, 0, 59, 'minute'),
    hour: parseCronField(hour, 0, 23, 'hour'),
    dayOfMonth: parseCronField(dom, 1, 31, 'day-of-month'),
    month: parseCronField(month, 1, 12, 'month'),
    dayOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** Does `date` match the parsed cron fields? (Local time.) */
export function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;
  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domMatch || dowMatch;
  if (fields.domRestricted) return domMatch;
  if (fields.dowRestricted) return dowMatch;
  return true;
}

/**
 * Next time strictly after `from` that matches the expression.
 * Scans minute by minute, capped at one year ahead (throws beyond that,
 * which only happens for impossible dates like Feb 31).
 */
export function nextCronOccurrence(expression: string, from: Date): Date {
  const fields = parseCronExpression(expression);
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    if (cronMatches(fields, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`No cron occurrence within a year for ${JSON.stringify(expression)}.`);
}

/** Validate a cron expression without computing anything (true = valid). */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling decisions (pure)
// ---------------------------------------------------------------------------

/** Next scheduled run for an automation, or null for manual/event triggers. */
export function nextRunAtFor(automation: Automation, from: Date): Date | null {
  const trigger = automation.trigger;
  if (trigger.kind === 'interval') {
    // Never run: due right now (same rule as routines: a routine with no
    // lastRunAt is due immediately). Otherwise: last run + interval.
    if (!automation.lastRunAt) return new Date(from.getTime());
    const next = new Date(new Date(automation.lastRunAt).getTime() + trigger.minutes * 60_000);
    // Never schedule in the past: if the last run was long ago, run now-ish.
    return next.getTime() <= from.getTime() ? new Date(from.getTime()) : next;
  }
  if (trigger.kind === 'cron') {
    const fromPoint = automation.lastRunAt
      ? new Date(Math.max(new Date(automation.lastRunAt).getTime(), from.getTime() - 1000))
      : from;
    return nextCronOccurrence(trigger.expression, fromPoint);
  }
  return null;
}

/** Is a scheduled automation due at `now`? Manual/event triggers are never due. */
export function automationDue(automation: Automation, now: Date): boolean {
  if (!automation.enabled) return false;
  if (automation.trigger.kind !== 'interval' && automation.trigger.kind !== 'cron') return false;
  if (automation.nextRunAt) return now.getTime() >= new Date(automation.nextRunAt).getTime();
  // No stored nextRunAt (e.g. just created): due when the interval since
  // the last run elapsed, or immediately when never run.
  if (!automation.lastRunAt) return true;
  const next = nextRunAtFor(automation, now);
  return next !== null && now.getTime() >= next.getTime();
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Glob match for `pathPattern`: `*` = any run without `/`, `**` = anything. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    '^' + escaped.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$',
  );
  return regex.test(value);
}

/**
 * Does `event` pass the automation's condition (and match its event
 * trigger)? No condition = always passes. Returns false for event kinds
 * the automation does not listen to.
 */
export function evaluateCondition(
  automation: Automation,
  event: AutomationEvent,
): boolean {
  const trigger = automation.trigger;
  if (trigger.kind !== 'event') return false;
  if (trigger.event !== event.kind) return false;
  const cond: AutomationCondition | undefined = automation.condition;
  const triggerPattern = trigger.pathPattern;
  if (event.kind === 'file-changed') {
    const p = event.path ?? '';
    if (triggerPattern && !globMatch(triggerPattern, p)) return false;
    if (cond?.pathPattern && !globMatch(cond.pathPattern, p)) return false;
  }
  if (event.kind === 'agent-done' && cond?.textContains) {
    const text = (event.text ?? '').toLowerCase();
    if (!text.includes(cond.textContains.toLowerCase())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate an automation's shape. Returns error strings (empty = valid). */
export function validateAutomation(a: Automation): string[] {
  const errors: string[] = [];
  if (!a.id || typeof a.id !== 'string') errors.push('Automation needs a non-empty string id.');
  if (!a.name || a.name.trim() === '') errors.push('Automation needs a non-empty name.');
  const t = a.trigger;
  if (t.kind === 'interval') {
    if (!Number.isFinite(t.minutes) || t.minutes <= 0) {
      errors.push('Interval trigger needs minutes > 0.');
    }
  } else if (t.kind === 'cron') {
    if (!isValidCronExpression(t.expression)) {
      errors.push(`Invalid cron expression: ${JSON.stringify(t.expression)}.`);
    }
    if (t.window !== undefined) {
      if (!Number.isInteger(t.window.minutes) || t.window.minutes < 1 || t.window.minutes > 1440) {
        errors.push('Cron window needs whole minutes between 1 and 1440.');
      }
    }
  } else if (t.kind === 'webhook') {
    if (!t.keyId || typeof t.keyId !== 'string' || t.keyId.trim() === '') {
      errors.push('Webhook trigger needs a non-empty keyId (the Vault webhook key).');
    }
  } else if (t.kind === 'composio') {
    // The slug FORMAT is validated here (any catalog slug qualifies —
    // the curated list is only the UI picker, see composio/triggers.ts).
    if (!t.triggerSlug || typeof t.triggerSlug !== 'string' || !/^[A-Z][A-Z0-9_]{2,}$/.test(t.triggerSlug)) {
      errors.push(
        `Composio trigger needs a triggerSlug like 'GMAIL_NEW_GMAIL_MESSAGE' (uppercase letters/digits/underscores).`,
      );
    }
    if (!t.keyId || typeof t.keyId !== 'string' || t.keyId.trim() === '') {
      errors.push('Composio trigger needs a non-empty keyId (the Vault Composio webhook secret).');
    }
    if (t.tokenKeyId !== undefined && (typeof t.tokenKeyId !== 'string' || t.tokenKeyId.trim() === '')) {
      errors.push('Composio trigger tokenKeyId must be a non-empty string when set.');
    }
  } else if (t.kind === 'event') {
    if (t.event !== 'agent-done' && t.event !== 'file-changed') {
      errors.push(`Unknown event trigger: ${JSON.stringify(t.event)}.`);
    }
  } else if (t.kind !== 'manual') {
    errors.push(`Unknown trigger kind: ${JSON.stringify((t as { kind: string }).kind)}.`);
  }
  if (a.triggerDescription !== undefined) {
    if (typeof a.triggerDescription !== 'string' || a.triggerDescription.length > 500) {
      errors.push('triggerDescription must be a string of at most 500 characters.');
    }
  }
  if (a.triggerPresentation !== undefined) {
    const p = a.triggerPresentation;
    if (!p.label || typeof p.label !== 'string' || p.label.trim() === '' || p.label.length > 200) {
      errors.push('triggerPresentation needs a non-empty label of at most 200 characters.');
    }
  }
  if (a.validateOnEnable !== undefined && typeof a.validateOnEnable !== 'boolean') {
    errors.push('validateOnEnable must be a boolean when set.');
  }
  if (a.access?.roles !== undefined) {
    if (
      !Array.isArray(a.access.roles) ||
      a.access.roles.length === 0 ||
      a.access.roles.some((r) => !TEAM_ROLES.includes(r))
    ) {
      errors.push(`access.roles must be a non-empty list of team roles (${TEAM_ROLES.join(', ')}).`);
    }
  }
  const action: AutomationAction = a.action;
  if (action.kind === 'run-agent') {
    if (!action.prompt || action.prompt.trim() === '') {
      errors.push('run-agent action needs a non-empty prompt.');
    }
  } else if (action.kind === 'run-tool') {
    if (!action.tool || action.tool.trim() === '') {
      errors.push('run-tool action needs a tool name.');
    }
  } else if (action.kind === 'create-task') {
    if (!action.title || action.title.trim() === '') {
      errors.push('create-task action needs a title.');
    }
  } else if (action.kind === 'notify') {
    if (!action.message || action.message.trim() === '') {
      errors.push('notify action needs a message.');
    }
  } else {
    errors.push(`Unknown action kind: ${JSON.stringify((action as { kind: string }).kind)}.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Trigger description / presentation (P0-5)
// ---------------------------------------------------------------------------

/** Human-readable one-line description of an automation's trigger. */
export function describeTrigger(automation: Automation): string {
  const t = automation.trigger;
  switch (t.kind) {
    case 'interval':
      return `Every ${t.minutes} minute${t.minutes === 1 ? '' : 's'}`;
    case 'cron':
      return t.window !== undefined
        ? `Cron ${t.expression} (allows runs up to ${t.window.minutes} min late)`
        : `Cron ${t.expression}`;
    case 'event':
      return t.event === 'file-changed'
        ? t.pathPattern
          ? `When a file changes (${t.pathPattern})`
          : 'When a file changes'
        : 'When an agent finishes a job';
    case 'manual':
      return 'Manual only';
    case 'webhook':
      return `Webhook (key ${t.keyId})`;
    case 'composio':
      return `Composio trigger ${t.triggerSlug} (key ${t.keyId})`;
    default:
      return `Unknown trigger ${JSON.stringify((t as { kind: string }).kind)}`;
  }
}

/** Display information for an automation's trigger (label + detail + icon key). */
export function buildTriggerPresentation(automation: Automation): AutomationTriggerPresentation {
  const t = automation.trigger;
  switch (t.kind) {
    case 'interval':
      return { label: 'Interval', detail: `Every ${t.minutes} min`, icon: 'clock' };
    case 'cron':
      return {
        label: 'Cron',
        detail: t.window !== undefined ? `${t.expression} · ±${t.window.minutes} min` : t.expression,
        icon: 'calendar',
      };
    case 'event':
      return {
        label: 'Event',
        detail: t.event === 'file-changed' ? (t.pathPattern ?? 'file-changed') : 'agent-done',
        icon: 'bolt',
      };
    case 'manual':
      return { label: 'Manual', detail: 'Run by hand only', icon: 'hand' };
    case 'webhook':
      return { label: 'Webhook', detail: `key ${t.keyId}`, icon: 'webhook' };
    case 'composio':
      return { label: 'Composio', detail: t.triggerSlug, icon: 'webhook' };
    default:
      return { label: 'Unknown', detail: JSON.stringify((t as { kind: string }).kind), icon: 'hand' };
  }
}

/** The trigger description to show the user: stored one, or the computed fallback. */
export function getTriggerDescription(automation: Automation): string {
  return automation.triggerDescription && automation.triggerDescription.trim() !== ''
    ? automation.triggerDescription
    : describeTrigger(automation);
}

/** The trigger presentation to show the user: stored one, or the computed fallback. */
export function getTriggerPresentation(automation: Automation): AutomationTriggerPresentation {
  return automation.triggerPresentation ?? buildTriggerPresentation(automation);
}

export interface ValidateForEnableOptions {
  /**
   * When provided, a webhook automation also fails validation when its
   * Vault key is missing. When omitted the key-existence check is
   * skipped (the host cannot verify it).
   */
  hasWebhookKey?: (keyId: string) => boolean;
  /**
   * When provided, a Composio-trigger automation also fails
   * validation when its Vault signing secret is missing (v0.83b).
   */
  hasComposioTriggerSecret?: (keyId: string) => boolean;
}

/**
 * Validate-on-enable (P0-5): the checks run when an automation is
 * enabled. Returns error strings (empty = may be enabled). This is the
 * same shape validation as `validateAutomation`, plus the webhook-key
 * existence check when the host can provide it.
 */
export function validateForEnable(
  automation: Automation,
  opts: ValidateForEnableOptions = {},
): string[] {
  const errors = validateAutomation(automation);
  if (automation.trigger.kind === 'webhook' && opts.hasWebhookKey) {
    if (!opts.hasWebhookKey(automation.trigger.keyId)) {
      errors.push(
        `Webhook key "${automation.trigger.keyId}" is missing from the Vault — create a webhook key before enabling this automation.`,
      );
    }
  }
  if (automation.trigger.kind === 'composio' && opts.hasComposioTriggerSecret) {
    if (!opts.hasComposioTriggerSecret(automation.trigger.keyId)) {
      errors.push(
        `Composio webhook secret "${automation.trigger.keyId}" is missing from the Vault — paste the project's COMPOSIO_WEBHOOK_SECRET before enabling this automation.`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecuteAutomationOptions {
  /** Trigger input (e.g. a webhook payload) the action runs with. Recorded on the run for retry. */
  triggerInput?: unknown;
  /**
   * Called with the run record the moment execution starts, while its
   * status is still `running` (before the action runs). The scheduler
   * uses this to persist the `running` record immediately, then updates
   * the same record in place when the returned (finished) run arrives.
   * A throwing callback aborts the run before the action executes.
   */
  onStarted?: (run: AutomationRun) => void;
}

/**
 * Run one automation's action through the host handlers.
 * Never throws for an action failure: the failure is recorded on the
 * returned run (`status: 'error'`, `error` set). Only a bug in the
 * handler wiring itself (non-function handler) throws. The returned run
 * is always finished (`ok` / `error` with `finishedAt` set); when
 * `opts.onStarted` is given, the same run object is first reported
 * with status `running` and no `finishedAt`, before the action starts.
 */
export async function executeAutomation(
  automation: Automation,
  handlers: AutomationHandlers,
  now: Date = new Date(),
  opts: ExecuteAutomationOptions = {},
): Promise<AutomationRun> {
  const startedAt = now.toISOString();
  const run: AutomationRun = {
    id: randomUUID(),
    automationId: automation.id,
    startedAt,
    status: 'running',
    trigger: automation.trigger.kind,
  };
  if (opts.triggerInput !== undefined) {
    const rendered =
      typeof opts.triggerInput === 'string'
        ? opts.triggerInput
        : JSON.stringify(opts.triggerInput);
    run.triggerInput = truncate(rendered ?? '', MAX_TRIGGER_INPUT_CHARS);
  }
  opts.onStarted?.(run);
  try {
    const action = automation.action;
    let output: string;
    switch (action.kind) {
      case 'run-agent':
        output = await handlers.runAgent(action.botId, action.prompt, {
          model: handlers.cheapestModel,
        });
        break;
      case 'run-tool':
        output = await handlers.runTool(action.tool, action.args ?? {});
        break;
      case 'create-task': {
        const taskId = await handlers.createTask(action.botId, action.title);
        output = `Task created: ${taskId}`;
        break;
      }
      case 'notify':
        handlers.notify(action.message);
        output = `Notified: ${action.message}`;
        break;
      default:
        throw new Error(`Unknown action kind: ${JSON.stringify((action as { kind: string }).kind)}`);
    }
    run.output = truncate(typeof output === 'string' ? output : String(output ?? ''));
    run.status = 'ok';
  } catch (err) {
    run.status = 'error';
    run.error = err instanceof Error ? err.message : String(err);
  }
  run.finishedAt = new Date().toISOString();
  return run;
}
