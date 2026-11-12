/**
 * Automation scheduler (v0.4).
 *
 * Owns the timer and the durable store. The engine (`engine.ts`) stays
 * pure; this module adds persistence + the tick loop + the missed-run
 * policy.
 *
 * Persistence: a JSON file `<stateDir>/automations.json`
 * (`{ automations: [...], runs: [...] }`), mirroring how `BotMemory`
 * persists routines as JSON in `memory_entries` — one JSON document, no
 * extra SQLite table. The file lives next to `memory.db`
 * (`<workspace>/.open-bot/automations.json`) when the host passes the
 * workspace's `.open-bot` dir as `stateDir`. Writes are atomic-ish
 * (write temp file, rename over the target) so a crash mid-write cannot
 * leave a half-written file. A corrupt file loads as empty (and the
 * corrupt text is kept in `<stateDir>/automations.json.corrupt` for
 * inspection instead of being silently deleted).
 *
 * Missed-run policy (the important part):
 * - A scheduled run whose `nextRunAt` has passed fires on the next tick —
 *   unless it is TOO late. "Too late" = `now - nextRunAt` exceeds the
 *   grace window: for interval triggers `max(2 × interval, 5 minutes)`,
 *   for cron triggers 60 minutes.
 * - A too-late run is recorded as a `skipped` run (visible in run
 *   history, with the reason) and the automation is rescheduled from
 *   NOW — never a catch-up burst. The app being off for a week must not
 *   fire a week's worth of runs when it reopens.
 * - While a chat is active the scheduler does not fire at all: the host
 *   passes `isChatActive: () => boolean` and `tick()` is a no-op when it
 *   returns true. Automations wait for the next tick.
 *
 * Concurrency: an automation already running is never started twice
 * (guarded by an in-flight set). `tick()` runs due automations
 * sequentially so a slow agent run cannot pile up parallel runs.
 *
 * Event triggers: the host calls `notifyEvent(event)` (e.g. from the
 * chat:send handler when a run finishes, or from an `fs.watch` callback
 * in main). Matching automations run immediately, subject to the same
 * chat-active guard and a per-automation cooldown (`eventCooldownMs`,
 * default 60 s) so a burst of file changes cannot spam runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Automation,
  AutomationEvent,
  AutomationHandlers,
  AutomationRun,
} from './types';
import {
  automationDue,
  evaluateCondition,
  executeAutomation,
  nextRunAtFor,
  validateAutomation,
  validateForEnable,
} from './engine';
import { handleWebhookDelivery, applyTriggerInputToAction } from './webhook';
import {
  composioTriggerToInput,
  parseComposioTriggerPayload,
  verifyComposioTriggerToken,
  verifyComposioWebhookSignature,
} from '../composio/triggers';
import {
  isSlackMessageTriggerSlug,
  normalizeSlackMessageFromComposioData,
  parseSlackInboundPayload,
  slackEventMatchesSlug,
  slackInteractionToTriggerInput,
  slackMessageToTriggerInput,
  verifySlackSignature,
} from '../slack/inbound';
import { sampleAutomations } from './samples';
import type { AutomationPolicyAction, AutomationPolicyChecker } from './policy';

export const AUTOMATIONS_FILE = 'automations.json';
/** Cap on stored run records (history screen shows the newest 100). */
export const MAX_RUN_HISTORY = 100;
export const DEFAULT_EVENT_COOLDOWN_MS = 60_000;

/** Minimal store interface so tests can substitute an in-memory store. */
export interface AutomationStore {
  list(): Automation[];
  save(automation: Automation): void;
  remove(id: string): boolean;
  listRuns(automationId?: string): AutomationRun[];
  appendRun(run: AutomationRun): void;
  /**
   * Replace the stored run with the same id, in place (same position,
   * same id — no duplicate record). When no run with that id exists
   * yet, appends it instead, so an in-flight `running` record whose
   * initial append was lost is not silently dropped on completion.
   * The history cap still applies when appending.
   */
  updateRun(run: AutomationRun): void;
}

/** JSON-file store (see header). */
export class JsonFileAutomationStore implements AutomationStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, AUTOMATIONS_FILE);
  }

  private read(): { automations: Automation[]; runs: AutomationRun[] } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { automations: [], runs: [] };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      const doc = parsed as { automations?: unknown; runs?: unknown };
      return {
        automations: Array.isArray(doc.automations) ? (doc.automations as Automation[]) : [],
        runs: Array.isArray(doc.runs) ? (doc.runs as AutomationRun[]) : [],
      };
    } catch {
      // Keep the corrupt file for inspection; start empty.
      try {
        fs.writeFileSync(`${this.file}.corrupt`, raw, 'utf8');
      } catch {
        // Best effort only.
      }
      return { automations: [], runs: [] };
    }
  }

  private write(doc: { automations: Automation[]; runs: AutomationRun[] }): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list(): Automation[] {
    return this.read().automations;
  }

  save(automation: Automation): void {
    const doc = this.read();
    const i = doc.automations.findIndex((a) => a.id === automation.id);
    if (i >= 0) doc.automations[i] = automation;
    else doc.automations.push(automation);
    this.write(doc);
  }

  remove(id: string): boolean {
    const doc = this.read();
    const before = doc.automations.length;
    doc.automations = doc.automations.filter((a) => a.id !== id);
    if (doc.automations.length === before) return false;
    this.write(doc);
    return true;
  }

  listRuns(automationId?: string): AutomationRun[] {
    const runs = this.read().runs;
    return automationId === undefined ? runs : runs.filter((r) => r.automationId === automationId);
  }

  appendRun(run: AutomationRun): void {
    const doc = this.read();
    doc.runs.push(run);
    if (doc.runs.length > MAX_RUN_HISTORY) {
      doc.runs = doc.runs.slice(doc.runs.length - MAX_RUN_HISTORY);
    }
    this.write(doc);
  }

  updateRun(run: AutomationRun): void {
    const doc = this.read();
    const i = doc.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) {
      doc.runs[i] = run;
    } else {
      doc.runs.push(run);
      if (doc.runs.length > MAX_RUN_HISTORY) {
        doc.runs = doc.runs.slice(doc.runs.length - MAX_RUN_HISTORY);
      }
    }
    this.write(doc);
  }
}

export interface AutomationSchedulerOptions {
  /** How often `tick()` runs automatically once started. Default 60_000 ms. */
  tickMs?: number;
  /** True while the user has a chat running — scheduler will not fire. */
  isChatActive?: () => boolean;
  /** Clock override (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Minimum gap between two event-triggered runs of one automation. Default 60_000 ms. */
  eventCooldownMs?: number;
  /**
   * Validate-on-enable master switch (P0-5, mirrors Grok's
   * `automations_validate_on_enable` flag, default ON). When false,
   * enabling never validates. Per-automation `validateOnEnable: false`
   * opts a single automation out. Disabling always skips validation.
   */
  validateOnEnable?: boolean;
  /**
   * Policy checker (P0-5, see `policy.ts`). When absent (plain
   * single-user install) every operation is allowed. When present, a
   * denied action throws and nothing changes.
   */
  policyChecker?: AutomationPolicyChecker;
  /** userId recorded as `createdBy` on automations this scheduler creates. */
  currentUserId?: string;
  /**
   * Webhook key lookup (P0-5): returns the HMAC secret for a key id,
   * or null when missing. The host wires this to the Vault
   * (`getAutomationWebhookKey`). Without it, webhook deliveries are
   * refused and validate-on-enable cannot check key existence.
   */
  webhookKeyProvider?: (keyId: string) => string | null;
  /**
   * Composio trigger signing-secret lookup (v0.83b): returns the
   * project's `COMPOSIO_WEBHOOK_SECRET` for a key id (the automation
   * id), or null when missing. The host wires this to the Vault
   * (`getComposioTriggerSigningSecret`). Without it, signed Composio
   * deliveries are refused and validate-on-enable cannot check the
   * secret exists.
   */
  composioWebhookSecretProvider?: (keyId: string) => string | null;
  /**
   * Composio trigger URL-token lookup (v0.83b): returns the token
   * secret for a token key id (`<automationId>-url-token`), or null
   * when missing. The host wires this to the Vault
   * (`getComposioTriggerToken`). Without it, `?token=` deliveries
   * are refused.
   */
  composioTriggerTokenProvider?: (keyId: string) => string | null;
  /**
   * Slack inbound signing-secret lookup (v0.87a, P2-2): returns the
   * Slack app's signing secret for a key id (the automation id), or
   * null when missing. The host wires this to the Vault
   * (`getSlackSigningSecret`). Without it, direct-Slack deliveries
   * are refused and validate-on-enable cannot check the secret
   * exists.
   */
  slackSigningSecretProvider?: (keyId: string) => string | null;
  /**
   * v0.66a: called after every run record is written (started and
   * finished, for every source — tick / run-now / retry / event /
   * webhook / skipped). The host uses it to push a live update to the
   * UI so the run history refreshes without re-entering the view.
   * Must never throw: the scheduler wraps every call in try/catch
   * and logs failures instead of breaking the run.
   */
  onRunChanged?: (run: AutomationRun) => void;
}

/**
 * What `handleSlackInbound` returns (v0.87a, P2-2). A finished
 * `AutomationRun` for a delivered message / interaction; the Slack
 * URL-verification challenge (no run) for `url_verification`; or an
 * `ignored` acknowledgement (no run) for bot messages and
 * non-message subtypes.
 */
export type SlackInboundResult =
  | AutomationRun
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'ignored'; ok: true; reason: string };

export interface SkippedRunInfo {
  automation: Automation;
  run: AutomationRun;
}

/**
 * Grace window for a missed scheduled run: beyond this the run is
 * skipped instead of fired. Interval: max(2× interval, 5 min).
 * Cron: the trigger's `window` when set (P0-5), else 60 minutes flat.
 */
export function missedGraceMs(automation: Automation): number {
  if (automation.trigger.kind === 'interval') {
    return Math.max(2 * automation.trigger.minutes * 60_000, 5 * 60_000);
  }
  if (automation.trigger.kind === 'cron' && automation.trigger.window !== undefined) {
    return Math.max(1, automation.trigger.window.minutes) * 60_000;
  }
  return 60 * 60_000;
}

/**
 * v0.74d (nút seed sample data): kết quả của `seedSampleAutomations`.
 * `created` là các sample thật sự ghi vào store (timestamp mới, không
 * phải placeholder trong `samples.ts`); `skipped` là id sample đã có
 * sẵn — không ghi đè, không nhân đôi.
 */
export interface SeedSampleAutomationsResult {
  created: Automation[];
  skipped: string[];
}

export class AutomationScheduler {
  private readonly store: AutomationStore;
  private readonly handlers: AutomationHandlers;
  private readonly opts: Required<Pick<AutomationSchedulerOptions, 'tickMs' | 'eventCooldownMs'>> &
    AutomationSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly lastEventRunAt = new Map<string, number>();

  constructor(store: AutomationStore, handlers: AutomationHandlers, opts: AutomationSchedulerOptions = {}) {
    this.store = store;
    this.handlers = handlers;
    this.opts = {
      tickMs: opts.tickMs ?? 60_000,
      eventCooldownMs: opts.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS,
      ...opts,
    };
  }

  // --- CRUD ---------------------------------------------------------------

  list(): Automation[] {
    return this.store.list();
  }

  get(id: string): Automation | undefined {
    return this.store.list().find((a) => a.id === id);
  }

  /**
   * Create an automation (id + timestamps filled in when absent).
   * Throws on validation errors. Computes the first `nextRunAt` for
   * scheduled triggers.
   */
  create(input: Omit<Automation, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Automation {
    this.requirePolicy('CREATE');
    const now = this.now();
    const automation: Automation = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (automation.createdBy === undefined && this.opts.currentUserId !== undefined) {
      automation.createdBy = this.opts.currentUserId;
    }
    const errors = validateAutomation(automation);
    if (errors.length > 0) throw new Error(`Invalid automation: ${errors.join(' ')}`);
    automation.nextRunAt = nextRunAtFor(automation, now)?.toISOString() ?? null;
    this.store.save(automation);
    return automation;
  }

  /**
   * v0.74d: nạp dữ liệu mẫu — ghi mọi `SAMPLE_AUTOMATIONS` chưa có
   * vào store thật qua `create()` (validate + timestamp mới +
   * `nextRunAt` tính thật; sample `botId` rỗng giữ nguyên theo
   * `samples.ts` — "bot mặc định"). Sample đã có sẵn (cùng id) được
   * bỏ qua, không ghi đè, không nhân đôi — bấm nút 2 lần vẫn chỉ có
   * đúng 4 automation mẫu. Ném lỗi khi policy chặn CREATE hoặc một
   * sample không validate được (khi đó các sample trước đó đã ghi
   * vẫn ở trong store — caller báo lỗi và list lại để thấy phần đã nạp).
   */
  seedSampleAutomations(): SeedSampleAutomationsResult {
    const existing = new Set(this.store.list().map((a) => a.id));
    const created: Automation[] = [];
    const skipped: string[] = [];
    for (const sample of sampleAutomations()) {
      if (existing.has(sample.id)) {
        skipped.push(sample.id);
        continue;
      }
      created.push(this.create(sample));
      existing.add(sample.id);
    }
    return { created, skipped };
  }

  /** Replace an automation (matched by id). Throws when missing/invalid. */
  update(automation: Automation): Automation {
    const existing = this.get(automation.id);
    if (!existing) throw new Error(`No automation with id ${automation.id}.`);
    this.requirePolicy('EDIT', existing);
    // Changing who may manage the automation, or who owns it, is a
    // policy change — not an ordinary edit.
    if (
      JSON.stringify(automation.access ?? null) !== JSON.stringify(existing.access ?? null) ||
      (automation.createdBy ?? '') !== (existing.createdBy ?? '')
    ) {
      this.requirePolicy('CHANGE_POLICY', existing);
    }
    const errors = validateAutomation(automation);
    if (errors.length > 0) throw new Error(`Invalid automation: ${errors.join(' ')}`);
    const next: Automation = { ...automation, updatedAt: this.now().toISOString() };
    next.nextRunAt = nextRunAtFor(next, this.now())?.toISOString() ?? null;
    this.store.save(next);
    return next;
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (existing) this.requirePolicy('DELETE', existing);
    return this.store.remove(id);
  }

  setEnabled(id: string, enabled: boolean): Automation {
    const automation = this.get(id);
    if (!automation) throw new Error(`No automation with id ${id}.`);
    this.requirePolicy('TOGGLE', automation);
    if (enabled) {
      // Validate-on-enable (P0-5, fail-closed): an invalid automation
      // cannot be enabled. The error names every problem; the
      // automation stays disabled. The global switch and the
      // per-automation flag both default to ON.
      const validateOn = this.opts.validateOnEnable !== false && automation.validateOnEnable !== false;
      if (validateOn) {
        const errors = validateForEnable(automation, {
          hasWebhookKey: this.opts.webhookKeyProvider
            ? (keyId) => {
                try {
                  return this.opts.webhookKeyProvider!(keyId) !== null;
                } catch {
                  return false;
                }
              }
            : undefined,
          // v0.83b: a Composio-trigger automation cannot be enabled
          // without its signing secret in the Vault.
          hasComposioTriggerSecret: this.opts.composioWebhookSecretProvider
            ? (keyId) => {
                try {
                  return this.opts.composioWebhookSecretProvider!(keyId) !== null;
                } catch {
                  return false;
                }
              }
            : undefined,
        });
        if (errors.length > 0) {
          throw new Error(
            `Cannot enable automation "${automation.name}": ${errors.join(' ')} Fix the automation first, or turn off validate-on-enable for it.`,
          );
        }
      }
    }
    // Save directly (not via update()): update() re-validates the
    // whole automation, which would defeat the validate-on-enable
    // opt-out above. Enabling only flips `enabled`, so no other field
    // — and no CHANGE_POLICY check — is involved; the TOGGLE policy
    // check above is the only gate. An opted-out automation whose
    // schedule cannot be computed (e.g. a bad cron) gets no next run
    // instead of throwing here; tick() skips uncomputable schedules.
    const next: Automation = { ...automation, enabled, updatedAt: this.now().toISOString() };
    try {
      next.nextRunAt = nextRunAtFor(next, this.now())?.toISOString() ?? null;
    } catch {
      next.nextRunAt = null;
    }
    this.store.save(next);
    return next;
  }

  listRuns(automationId?: string): AutomationRun[] {
    return this.store.listRuns(automationId);
  }

  /**
   * v0.66a: reconcile runs left `running` by an interrupted app
   * (crash / force-quit while a run was still in flight). Every such
   * record is marked `error` with `finishedAt = now` and a clear
   * note, so the history never shows a run as "running" forever.
   * Idempotent (a second call finds nothing to fix), never touches
   * runs that already finished (`ok` / `error` / `skipped`), and
   * only fixes runs already in the store at call time — a run
   * created after this call is untouched. Returns the runs that
   * were reconciled (empty when there was nothing to fix).
   */
  reconcileInterruptedRuns(now: Date = this.now()): AutomationRun[] {
    const interrupted = this.store.listRuns().filter((r) => r.status === 'running');
    const reconciled: AutomationRun[] = [];
    for (const run of interrupted) {
      const fixed: AutomationRun = {
        ...run,
        status: 'error',
        finishedAt: now.toISOString(),
        error: 'Interrupted — the app stopped while this run was still in flight.',
      };
      this.store.updateRun(fixed);
      reconciled.push(fixed);
    }
    return reconciled;
  }

  /**
   * Latest failed run of an automation that has NOT been resolved by
   * a successful retry yet, if any. A failed run counts as resolved
   * once a later run with `retriedFromRunId` pointing at it finished
   * `ok` — retrying it again would just repeat the same success.
   */
  lastFailedRun(automationId: string): AutomationRun | undefined {
    const runs = this.store.listRuns(automationId);
    const resolved = new Set(
      runs.filter((r) => r.status === 'ok' && r.retriedFromRunId).map((r) => r.retriedFromRunId as string),
    );
    const failed = runs.filter((r) => r.status === 'error' && !resolved.has(r.id));
    if (failed.length === 0) return undefined;
    return failed[failed.length - 1];
  }

  // --- Running ------------------------------------------------------------

  /** Start the periodic timer. Safe to call twice (second call is a no-op). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.opts.tickMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One scheduler pass: fire every due scheduled automation (or record
   * it skipped when too late). No-op while a chat is active. Returns the
   * runs produced by this tick (including `skipped` records).
   */
  async tick(): Promise<AutomationRun[]> {
    if (this.opts.isChatActive?.()) return [];
    const now = this.now();
    const runs: AutomationRun[] = [];
    for (const automation of this.store.list()) {
      // One automation with an uncomputable schedule (e.g. enabled
      // with validate-on-enable opted out and a bad cron) must not
      // break the whole tick: skip it and continue with the rest.
      let due: boolean;
      try {
        due = automationDue(automation, now);
      } catch {
        continue;
      }
      if (!due) continue;
      if (this.inFlight.has(automation.id)) continue;
      const nextAt = automation.nextRunAt ? new Date(automation.nextRunAt).getTime() : now.getTime();
      if (now.getTime() - nextAt > missedGraceMs(automation)) {
        runs.push(this.recordSkipped(automation, now, nextAt));
        continue;
      }
      runs.push(await this.fire(automation, now));
    }
    return runs;
  }

  /** Run one automation right now, regardless of its schedule. */
  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.get(id);
    if (!automation) throw new Error(`No automation with id ${id}.`);
    if (!automation.enabled) throw new Error(`Automation "${automation.name}" is disabled.`);
    this.requirePolicy('TOGGLE', automation);
    if (this.inFlight.has(id)) throw new Error(`Automation "${automation.name}" is already running.`);
    return this.fire(automation, this.now());
  }

  /**
   * Retry a failed run (P0-5): re-run the automation with the same
   * trigger input the failed run had. The new run records
   * `retriedFromRunId`. The automation's CURRENT action runs (not a
   * snapshot) — if the action was edited since the failure, the edited
   * version runs. Throws when the run does not exist, did not fail,
   * or its automation is gone / disabled.
   */
  async retryRun(runId: string): Promise<AutomationRun> {
    const run = this.store.listRuns().find((r) => r.id === runId);
    if (!run) throw new Error(`No automation run with id ${runId}.`);
    if (run.status !== 'error') {
      throw new Error(`Run ${runId} did not fail (status: ${run.status}) — only failed runs can be retried.`);
    }
    const automation = this.get(run.automationId);
    if (!automation) throw new Error(`Automation ${run.automationId} no longer exists.`);
    if (!automation.enabled) throw new Error(`Automation "${automation.name}" is disabled.`);
    this.requirePolicy('TOGGLE', automation);
    if (this.inFlight.has(automation.id)) {
      throw new Error(`Automation "${automation.name}" is already running.`);
    }
    let input: unknown;
    if (run.triggerInput !== undefined) {
      try {
        input = JSON.parse(run.triggerInput) as unknown;
      } catch {
        input = run.triggerInput;
      }
    }
    return this.fire(automation, this.now(), input, run.id);
  }

  /** Retry the most recent failed run of an automation, if there is one. */
  async retryLastFailedRun(automationId: string): Promise<AutomationRun> {
    const failed = this.lastFailedRun(automationId);
    if (!failed) throw new Error(`Automation ${automationId} has no failed run to retry.`);
    return this.retryRun(failed.id);
  }

  /**
   * Deliver a webhook to an automation (P0-5).
   * The HMAC signature is verified BEFORE any action runs; a bad
   * signature, a missing key, a disabled automation or a non-webhook
   * trigger throws and no run is recorded. `rawBody` must be the exact
   * bytes received — verification runs on the raw body, never on a
   * re-serialised object.
   */
  async handleWebhook(
    automationId: string,
    rawBody: string | Buffer,
    signature: string | null | undefined,
  ): Promise<AutomationRun> {
    const automation = this.get(automationId);
    if (!automation) throw new Error(`No automation with id ${automationId}.`);
    if (automation.trigger.kind !== 'webhook') {
      throw new Error(`Automation "${automation.name}" does not have a webhook trigger.`);
    }
    if (!automation.enabled) throw new Error(`Automation "${automation.name}" is disabled.`);
    if (this.inFlight.has(automationId)) {
      throw new Error(`Automation "${automation.name}" is already running.`);
    }
    if (!this.opts.webhookKeyProvider) {
      throw new Error('Webhook key provider is not configured — webhook deliveries are refused.');
    }
    let secret: string | null;
    try {
      secret = this.opts.webhookKeyProvider(automation.trigger.keyId);
    } catch {
      throw new Error('Webhook key lookup failed — delivery refused.');
    }
    const now = this.now();
    // The guard is checked BEFORE the delivery runs (as in `fire()`):
    // the in-flight mark must be held for the whole delivery, otherwise
    // two concurrent deliveries could both pass the check above.
    this.inFlight.add(automation.id);
    try {
      const run = await handleWebhookDelivery(automation, {
        rawBody,
        signature,
        secret,
        handlers: this.handlers,
        now,
        // Persist the `running` record as soon as the (verified)
        // delivery starts executing, not only when it finishes.
        onStarted: (started) => {
          this.store.appendRun(started);
          this.emitRunChanged(started);
        },
      });
      // Update the same record in place — never append a second one.
      const next = nextRunAtFor({ ...automation, lastRunAt: now.toISOString() }, now);
      this.store.save({
        ...automation,
        lastRunAt: now.toISOString(),
        nextRunAt: next?.toISOString() ?? null,
        updatedAt: now.toISOString(),
      });
      this.store.updateRun(run);
      this.emitRunChanged(run);
      return run;
    } finally {
      this.inFlight.delete(automation.id);
    }
  }

  /**
   * Deliver a Composio trigger event to a Composio-trigger automation
   * (v0.83b).
   *
   * Auth runs BEFORE parsing or running anything (a bad delivery
   * records no run):
   * - When signature headers are present (`webhookSignature`
   *   non-null), the `COMPOSIO_WEBHOOK_SECRET` for the automation
   *   verifies them (HMAC over
   *   `${webhookId}.${timestamp}.${rawBody}`, 300 s replay
   *   tolerance). A present-but-invalid signature is rejected even
   *   when a valid `?token=` is also supplied.
   * - Otherwise, when `token` is present, it is compared
   *   timing-safe against the automation's URL-token secret (the
   *   automation must have `tokenKeyId` set and the token provider
   *   configured).
   * - With neither, the delivery is rejected.
   *
   * Then the V3 envelope is parsed and its `trigger_slug` must match
   * the automation's configured slug (one URL receives every trigger
   * of the project — a mismatch records no run). The event data
   * becomes the trigger input (same shaping as webhook deliveries:
   * run-agent gets it appended to the prompt, run-tool args are
   * filled from it) and the run is recorded with trigger
   * `'composio'` (see `engine.executeAutomation`).
   */
  async handleComposioTrigger(
    automationId: string,
    rawBody: string | Buffer,
    auth: {
      webhookId?: string | null;
      webhookTimestamp?: string | number | null;
      webhookSignature?: string | null;
      token?: string | null;
    },
  ): Promise<AutomationRun> {
    const automation = this.get(automationId);
    if (!automation) throw new Error(`No automation with id ${automationId}.`);
    if (automation.trigger.kind !== 'composio') {
      throw new Error(`Automation "${automation.name}" does not have a Composio trigger.`);
    }
    if (!automation.enabled) throw new Error(`Automation "${automation.name}" is disabled.`);
    if (this.inFlight.has(automationId)) {
      throw new Error(`Automation "${automation.name}" is already running.`);
    }
    const hasSignature = typeof auth.webhookSignature === 'string' && auth.webhookSignature !== '';
    if (hasSignature) {
      if (!this.opts.composioWebhookSecretProvider) {
        throw new Error('Composio webhook secret provider is not configured — delivery refused.');
      }
      let secret: string | null;
      try {
        secret = this.opts.composioWebhookSecretProvider(automation.trigger.keyId);
      } catch {
        throw new Error('Composio webhook secret lookup failed — delivery refused.');
      }
      if (secret === null) {
        throw new Error(
          `Automation "${automation.name}" has no Composio webhook secret yet — paste the project's COMPOSIO_WEBHOOK_SECRET before delivering triggers.`,
        );
      }
      if (
        !verifyComposioWebhookSignature(
          secret,
          auth.webhookId ?? null,
          auth.webhookTimestamp ?? null,
          rawBody,
          auth.webhookSignature ?? null,
        )
      ) {
        throw new Error('Invalid Composio webhook signature: delivery rejected before running any action.');
      }
    } else if (typeof auth.token === 'string' && auth.token !== '') {
      if (!automation.trigger.tokenKeyId) {
        throw new Error(
          `Automation "${automation.name}" has no URL token configured — deliveries without a signature are refused.`,
        );
      }
      if (!this.opts.composioTriggerTokenProvider) {
        throw new Error('Composio trigger token provider is not configured — delivery refused.');
      }
      let stored: string | null;
      try {
        stored = this.opts.composioTriggerTokenProvider(automation.trigger.tokenKeyId);
      } catch {
        throw new Error('Composio trigger token lookup failed — delivery refused.');
      }
      if (!verifyComposioTriggerToken(stored, auth.token)) {
        throw new Error('Invalid Composio trigger token: delivery rejected before running any action.');
      }
    } else {
      throw new Error(
        'Composio trigger delivery needs a signature (webhook-signature headers) or a ?token= — neither was supplied.',
      );
    }
    const event = parseComposioTriggerPayload(rawBody);
    if (event.triggerSlug !== automation.trigger.triggerSlug) {
      throw new Error(
        `Composio trigger slug mismatch: delivery is for "${event.triggerSlug}" but automation "${automation.name}" listens for "${automation.trigger.triggerSlug}" — no run recorded.`,
      );
    }
    // v0.87a (P2-2): a Slack message trigger carries a Slack message
    // inside `data` — normalize it (best effort; the exact `data`
    // shape was never observed live, so an unrecognised shape leaves
    // the input exactly as before and the raw `data` still reaches
    // the automation). The normalized `slack` block + top-level
    // `channel` / `text` let a run-tool action answer through
    // SLACK_SEND_MESSAGE and a run-agent prompt read the message
    // instead of raw JSON.
    let input: Record<string, unknown> = composioTriggerToInput(event);
    if (isSlackMessageTriggerSlug(event.triggerSlug)) {
      const message = normalizeSlackMessageFromComposioData(event.data);
      if (message) {
        input = {
          ...input,
          source: 'slack',
          channel: message.channel,
          text: message.text,
          ts: message.ts,
          slack: { ...message },
          ...(message.channelType ? { channelType: message.channelType } : {}),
          ...(message.user ? { user: message.user } : {}),
          ...(message.teamId ? { teamId: message.teamId } : {}),
          ...(message.threadTs ? { threadTs: message.threadTs } : {}),
        };
      }
    }
    return this.fire(automation, this.now(), input);
  }

  /**
   * Deliver a direct-Slack payload to a Slack-message automation
   * (v0.87a, P2-2) — the receiving side of the Slack app's Events
   * API / interactivity webhooks (`POST
   * /v1/automations/:id/slack-inbound`).
   *
   * The automation reuses the `composio` trigger kind with a Slack
   * message slug (`SLACK_CHANNEL_MESSAGE_RECEIVED` /
   * `SLACK_DIRECT_MESSAGE_RECEIVED` / `SLACK_RECEIVE_MESSAGE`) — the
   * same automation can therefore receive a Slack message EITHER
   * through Composio (v0.83b route) OR straight from Slack (this
   * route), whichever the user wired up.
   *
   * Auth runs BEFORE parsing or running anything (a bad delivery
   * records no run): the Slack signing secret for the automation
   * verifies `x-slack-signature` (HMAC-SHA256 over
   * `v0:{timestamp}:{rawBody}`, 300 s replay tolerance). There is no
   * `?token=<redacted> fallback on this route — Slack signs every request,
   * and a token in the URL would leak into Slack's delivery logs.
   *
   * Then the body is parsed (`parseSlackInboundPayload`):
   * - `url_verification` → the challenge is returned, no run.
   * - Bot messages / non-message subtypes → `{ kind: 'ignored' }`,
   *   no run (the bot never answers itself).
   * - `message` / `app_mention` → the event's channel kind must
   *   match the automation's slug (a DM does not fire a
   *   channel-message automation); the run fires with the normalized
   *   Slack input (same shaping as the Composio path, so a run-tool
   *   action can answer via `SLACK_SEND_MESSAGE`).
   * - `block_actions` / `view_submission` / `view_closed` →
   *   the run fires with the interaction as input; open-bot does NOT
   *   answer `response_url` (see `slack/inbound.ts`).
   */
  async handleSlackInbound(
    automationId: string,
    rawBody: string | Buffer,
    auth: {
      signature?: string | null;
      timestamp?: string | number | null;
    },
    contentType?: string | null,
  ): Promise<SlackInboundResult> {
    const automation = this.get(automationId);
    if (!automation) throw new Error(`No automation with id ${automationId}.`);
    if (automation.trigger.kind !== 'composio') {
      throw new Error(`Automation "${automation.name}" does not have a Composio trigger.`);
    }
    if (!isSlackMessageTriggerSlug(automation.trigger.triggerSlug)) {
      throw new Error(
        `Automation "${automation.name}" does not listen for Slack messages (trigger slug "${automation.trigger.triggerSlug}" is not a Slack message trigger) — direct Slack deliveries are refused.`,
      );
    }
    if (!automation.enabled) throw new Error(`Automation "${automation.name}" is disabled.`);
    if (this.inFlight.has(automationId)) {
      throw new Error(`Automation "${automation.name}" is already running.`);
    }
    if (!this.opts.slackSigningSecretProvider) {
      throw new Error('Slack signing secret provider is not configured — delivery refused.');
    }
    let secret: string | null;
    try {
      secret = this.opts.slackSigningSecretProvider(automation.trigger.keyId);
    } catch {
      throw new Error('Slack signing secret lookup failed — delivery refused.');
    }
    if (secret === null) {
      throw new Error(
        `Automation "${automation.name}" has no Slack signing secret yet — paste the Slack app's Signing Secret before delivering Slack events.`,
      );
    }
    if (
      !verifySlackSignature(secret, auth.timestamp ?? null, rawBody, auth.signature ?? null)
    ) {
      throw new Error('Invalid Slack signature: delivery rejected before running any action.');
    }
    const parsed = parseSlackInboundPayload(rawBody, contentType);
    if (parsed.kind === 'url_verification') {
      return { kind: 'url_verification', challenge: parsed.challenge };
    }
    if (parsed.kind === 'ignored') {
      return { kind: 'ignored', ok: true, reason: parsed.reason };
    }
    if (parsed.kind === 'event_callback') {
      const message = parsed.message;
      if (!slackEventMatchesSlug(message, automation.trigger.triggerSlug)) {
        throw new Error(
          `Slack event slug mismatch: a ${message.channelType ?? 'unknown'}-kind message does not match automation "${automation.name}" listening for "${automation.trigger.triggerSlug}" — no run recorded.`,
        );
      }
      const rawEvent = (() => {
        try {
          return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as unknown;
        } catch {
          return undefined;
        }
      })();
      return this.fire(
        automation,
        this.now(),
        slackMessageToTriggerInput(message, {
          triggerSlug: automation.trigger.triggerSlug,
          rawEvent,
        }),
      );
    }
    const rawPayload = (() => {
      try {
        const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        if (text.startsWith('payload=')) {
          return JSON.parse(new URLSearchParams(text).get('payload') ?? 'null') as unknown;
        }
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    })();
    return this.fire(
      automation,
      this.now(),
      slackInteractionToTriggerInput(parsed.interaction, {
        triggerSlug: automation.trigger.triggerSlug,
        rawPayload,
      }),
    );
  }

  /**
   * Deliver an event (agent finished, file changed). Matching enabled
   * automations run immediately — still gated by the chat-active check
   * and the per-automation event cooldown.
   */
  async notifyEvent(event: AutomationEvent): Promise<AutomationRun[]> {
    if (this.opts.isChatActive?.()) return [];
    const now = this.now();
    const runs: AutomationRun[] = [];
    for (const automation of this.store.list()) {
      if (!automation.enabled) continue;
      if (automation.trigger.kind !== 'event') continue;
      if (!evaluateCondition(automation, event)) continue;
      const last = this.lastEventRunAt.get(automation.id) ?? 0;
      if (now.getTime() - last < this.opts.eventCooldownMs) continue;
      if (this.inFlight.has(automation.id)) continue;
      this.lastEventRunAt.set(automation.id, now.getTime());
      runs.push(await this.fire(automation, now));
    }
    return runs;
  }

  // --- Internals ----------------------------------------------------------

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /**
   * v0.66a: notify the host that a run record was written. A throwing
   * callback must never break the run itself, so failures are logged
   * and swallowed here.
   */
  private emitRunChanged(run: AutomationRun): void {
    const cb = this.opts.onRunChanged;
    if (!cb) return;
    try {
      cb(run);
    } catch (err) {
      console.error('[open-bot] onRunChanged failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Enforce the automation policy (P0-5). No-op when no checker is
   * configured (plain single-user install). Throws on denial; the
   * caller must not change anything after a denial.
   */
  private requirePolicy(action: AutomationPolicyAction, automation?: Automation): void {
    const checker = this.opts.policyChecker;
    if (!checker) return;
    let allowed: boolean;
    try {
      allowed = checker(action, { automation });
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new Error(
        `Automation action "${action}" is not allowed by the current policy.`,
      );
    }
  }

  private recordSkipped(automation: Automation, now: Date, missedAtMs: number): AutomationRun {
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      status: 'skipped',
      trigger: automation.trigger.kind,
      output: `Skipped: scheduled run for ${new Date(missedAtMs).toISOString()} was missed by more than the grace window (${Math.round(missedGraceMs(automation) / 60_000)} min) — app was off or busy. Rescheduled from now; no catch-up run.`,
    };
    // Same guard as in fire(): an opted-out bad schedule has no next run.
    let next: Date | null = null;
    try {
      next = nextRunAtFor({ ...automation, lastRunAt: now.toISOString() }, now);
    } catch {
      next = null;
    }
    this.store.save({
      ...automation,
      lastRunAt: now.toISOString(),
      nextRunAt: next?.toISOString() ?? null,
      updatedAt: now.toISOString(),
    });
    this.store.appendRun(run);
    this.emitRunChanged(run);
    return run;
  }

  private async fire(
    automation: Automation,
    now: Date,
    triggerInput?: unknown,
    retriedFromRunId?: string,
  ): Promise<AutomationRun> {
    this.inFlight.add(automation.id);
    try {
      // A trigger input (webhook payload, or a retried run's input)
      // shapes the action the same way the original delivery did.
      const effective =
        triggerInput === undefined
          ? automation
          : { ...automation, action: applyTriggerInputToAction(automation.action, triggerInput) };
      const run = await executeAutomation(effective, this.handlers, now, {
        triggerInput,
        // Persist the `running` record the moment execution starts, so
        // the history shows it while the action is still going — for
        // every source that goes through `fire()` (tick, run-now,
        // retry, event). The finished run below updates this same
        // record in place (same id), never a second record.
        onStarted: (started) => {
          this.store.appendRun(started);
          this.emitRunChanged(started);
        },
      });
      if (retriedFromRunId !== undefined) run.retriedFromRunId = retriedFromRunId;
      // An opted-out automation with an uncomputable schedule (bad
      // cron) still ran — it just gets no next run instead of
      // throwing after the fact.
      let next: Date | null = null;
      try {
        next = nextRunAtFor({ ...automation, lastRunAt: now.toISOString() }, now);
      } catch {
        next = null;
      }
      this.store.save({
        ...automation,
        lastRunAt: now.toISOString(),
        nextRunAt: next?.toISOString() ?? null,
        updatedAt: now.toISOString(),
      });
      // Same record id as the `running` record appended at start:
      // update it in place so the history holds exactly one record
      // per run, with the correct final status — including `error`
      // when the action failed midway (`executeAutomation` never
      // throws for an action error, so this line always runs).
      this.store.updateRun(run);
      this.emitRunChanged(run);
      return run;
    } finally {
      this.inFlight.delete(automation.id);
    }
  }
}
