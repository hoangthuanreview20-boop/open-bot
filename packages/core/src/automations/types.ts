/**
 * Automations — types (v0.4).
 *
 * An Automation is `trigger + condition + action`:
 * - Trigger decides WHEN it fires: on a schedule (minimal cron or a fixed
 *   interval), on an event (the bot finished a job, a file changed in the
 *   workspace), or manually (`run-now` only).
 * - Condition is an optional filter on the triggering event.
 * - Action decides WHAT runs: run the agent with a fixed prompt, run one
 *   tool, create a task, or post a notification.
 *
 * Safety rules baked into the design:
 * - Automations never run while the user is chatting: the scheduler only
 *   fires when the host says no chat is active (the main process owns
 *   that knowledge; see scheduler.ts `isChatActive`).
 * - A missed run is SKIPPED, never caught up in a burst (see scheduler.ts
 *   for the exact policy). This is what stops "app was off for a week,
 *   500 runs fire at once".
 * - Actions run through the host-provided handlers, so approval/sandbox
 *   rules of the normal agent path still apply (an automation that runs
 *   the agent goes through the same AgentRunner; a `run-tool` action goes
 *   through the same ToolRegistry).
 */

import type { TeamRole } from '../team/types';

export interface AutomationCronWindow {
  /** Allowed lateness, in minutes, for a cron run that fires late. */
  minutes: number;
}

export type AutomationTrigger =
  | { kind: 'interval'; /** Run every N minutes. */ minutes: number }
  | {
      kind: 'cron';
      /** Minimal 5-field cron: `minute hour day month weekday`. */
      expression: string;
      /** Allowed-lateness window for this schedule (P0-5). When absent, the scheduler default applies. */
      window?: AutomationCronWindow;
    }
  | { kind: 'event'; event: AutomationEventKind; /** File path pattern, e.g. `notes/*.md` (file-changed only). */ pathPattern?: string }
  | { kind: 'manual' }
  | {
      kind: 'webhook';
      /**
       * Id of the HMAC key in the Vault namespace `automation-webhook-keys/`
       * (see `webhookKeys.ts`). One key per automation; the keyId is the
       * automation id. The secret itself is NEVER stored on the automation
       * and is only returned once, at creation time.
       */
      keyId: string;
    }
  | {
      kind: 'composio';
      /**
       * Composio trigger slug, e.g. `GMAIL_NEW_GMAIL_MESSAGE` (see
       * `composio/triggers.ts` — curated list
       * `COMPOSIO_TRIGGER_DEFS`, any catalog slug allowed). The
       * route drops deliveries whose envelope slug differs.
       */
      triggerSlug: string;
      /**
       * Id of the Composio webhook signing secret
       * (`COMPOSIO_WEBHOOK_SECRET`) in the Vault namespace
       * `composio-trigger-keys/` (see `composio/triggerKeys.ts`).
       * The keyId is the automation id; the secret itself is NEVER
       * stored on the automation.
       */
      keyId: string;
      /**
       * Id of the optional URL-token secret (same namespace) that a
       * `?token=` delivery is compared against when it carries no
       * signature headers. Absent = signature-only (no token
       * fallback). When set it is `<automationId>-url-token`.
       */
      tokenKeyId?: string;
    };

export type AutomationEventKind = 'agent-done' | 'file-changed';

/** Optional filter applied to the triggering event before the action runs. */
export interface AutomationCondition {
  /** For `agent-done`: the finished run's final text must contain this (case-insensitive). */
  textContains?: string;
  /** For `file-changed`: the changed path must match this glob (`*` and `**` supported). */
  pathPattern?: string;
}

export type AutomationAction =
  | { kind: 'run-agent'; botId: string; prompt: string }
  | { kind: 'run-tool'; tool: string; args?: Record<string, unknown> }
  | { kind: 'create-task'; botId: string; title: string }
  | { kind: 'notify'; message: string };

/** Display information for a trigger, shown to the user (P0-5). */
export interface AutomationTriggerPresentation {
  /** Short label, e.g. `Webhook` or `Cron`. */
  label: string;
  /** One-line detail, e.g. the cron expression or the webhook key id. */
  detail?: string;
  /** Stable icon key for the UI (`clock` | `calendar` | `webhook` | `bolt` | `hand`). */
  icon?: string;
}

/**
 * Per-automation access policy (P0-5).
 * When `roles` is set, only viewers with one of those roles may manage
 * (edit / toggle / delete / run) this automation; admins always may.
 * Changing this field requires the `CHANGE_POLICY` policy action.
 */
export interface AutomationAccessPolicy {
  roles?: TeamRole[];
}

export interface Automation {
  id: string;
  /** Bot this automation belongs to ('' = global, runs with the default bot). */
  botId: string;
  name: string;
  trigger: AutomationTrigger;
  condition?: AutomationCondition;
  action: AutomationAction;
  enabled: boolean;
  /**
   * Human-readable description of the trigger (P0-5). When absent, the
   * engine computes one from the trigger (`describeTrigger()`).
   */
  triggerDescription?: string;
  /**
   * Display information for the trigger (P0-5). When absent, the engine
   * computes one from the trigger (`buildTriggerPresentation()`).
   */
  triggerPresentation?: AutomationTriggerPresentation;
  /**
   * Validate the automation when it is enabled (P0-5, default on).
   * When true (or absent) an invalid automation cannot be enabled:
   * enabling fails closed with a clear error and the automation stays
   * disabled. Set explicitly to `false` to opt out for one automation.
   */
  validateOnEnable?: boolean;
  /** userId of the member who created this automation ('' = unknown / local single user). */
  createdBy?: string;
  /** Per-automation access policy (P0-5). Absent = no extra restriction. */
  access?: AutomationAccessPolicy;
  /** ISO timestamp of the last run attempt (including skipped runs), or null. */
  lastRunAt?: string | null;
  /** ISO timestamp of the next scheduled run (schedule triggers only). */
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Run status. `running` is the in-flight state: a run record is written
 * with `running` (and no `finishedAt`) the moment execution starts, then
 * updated in place to `ok` / `error` when it finishes — so the history
 * shows a run while it is still going, whichever source started it
 * (scheduler tick, webhook, event, manual run-now, retry). `skipped`
 * is a scheduled run that never executed (missed its grace window).
 */
export type AutomationRunStatus = 'running' | 'ok' | 'error' | 'skipped';

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: AutomationRunStatus;
  /**
   * Trigger kind that fired this run (`interval` | `cron` | `event` |
   * `manual` | `webhook`), recorded at fire time so the run history
   * stays readable even after its automation is deleted.
   */
  trigger?: string;
  /** Action output (truncated by the engine) or the skip/error reason. */
  output?: string;
  error?: string;
  /**
   * JSON (truncated) of the trigger input this run executed with
   * (P0-5, webhook payload). Stored so a failed run can be retried
   * with the same input. Callers must not put secrets in webhook
   * payloads: this is persisted in the local run history.
   */
  triggerInput?: string;
  /** Id of the failed run this run is a retry of (P0-5), if any. */
  retriedFromRunId?: string;
}

/** The event object delivered to `notifyEvent` / condition evaluation. */
export interface AutomationEvent {
  kind: AutomationEventKind;
  botId?: string;
  /** Final text of the finished agent run (`agent-done`). */
  text?: string;
  /** Changed file path, workspace-relative (`file-changed`). */
  path?: string;
  at: string;
}

/**
 * Host-provided handlers: how the engine actually performs an action.
 * The engine never touches providers, tools or memory directly — the host
 * (main process) wires these to the real AgentRunner / ToolRegistry /
 * BotMemory, so automations inherit the app's approval and sandbox rules.
 */
export interface AutomationHandlers {
  /** Run one agent turn with the given prompt; resolves to the final text. */
  runAgent(botId: string, prompt: string, opts?: { model?: string }): Promise<string>;
  /** Run one tool by name; resolves to the tool's output text. */
  runTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Create a task; resolves to the task id. */
  createTask(botId: string, title: string): Promise<string>;
  /** Show a notification to the user (non-blocking). */
  notify(message: string): void;
  /** Optional: the cheapest configured model id for background runs (dream). */
  cheapestModel?: string;
}
