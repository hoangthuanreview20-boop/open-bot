import { useEffect, useState } from 'react';
import type { AutomationLike, AutomationRunLike, BotConfigLike } from '../types';
import { useLocale, useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';
import {
  buildCronExpression,
  CRON_DEFAULT_FIELDS,
  CRON_PRESETS,
  describeCron,
  parseCronFields,
  weekdayShortName,
  type CronBuilderFields,
} from './cronBuilder';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onBack: () => void;
  onSelectBot?: (botId: string) => void;
}

type TriggerKind = 'interval' | 'cron' | 'event' | 'manual' | 'webhook' | 'composio';

// v0.87a (P2-2): Composio trigger slugs that carry an inbound Slack
// message — only these automations get the direct-Slack section
// (signing secret + slack-inbound route hint). Keep in sync with
// SLACK_MESSAGE_TRIGGER_SLUGS in packages/core/src/slack/inbound.ts.
const SLACK_MESSAGE_SLUGS = [
  'SLACK_CHANNEL_MESSAGE_RECEIVED',
  'SLACK_DIRECT_MESSAGE_RECEIVED',
  'SLACK_RECEIVE_MESSAGE',
];
type ActionKind = 'run-agent' | 'run-tool' | 'create-task' | 'notify';

function asAutomation(value: unknown): AutomationLike | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as AutomationLike;
  return typeof v.id === 'string' && typeof v.name === 'string' ? v : null;
}

function asAutomationList(value: unknown): AutomationLike[] {
  if (!Array.isArray(value)) return [];
  const out: AutomationLike[] = [];
  for (const item of value) {
    const a = asAutomation(item);
    if (a) out.push(a);
  }
  return out;
}

function asRunList(value: unknown): AutomationRunLike[] {
  if (!Array.isArray(value)) return [];
  const out: AutomationRunLike[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as AutomationRunLike;
    if (typeof r.id === 'string' && typeof r.automationId === 'string') out.push(r);
  }
  return out;
}

type HistoryStatusFilter = 'all' | 'ok' | 'error' | 'skipped' | 'running';

/** One row of the run-history tab: a stored run, or a run in flight. */
interface HistoryRow {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'ok' | 'error' | 'skipped' | 'running';
  trigger?: string;
  output?: string;
  error?: string;
  triggerInput?: string;
  retriedFromRunId?: string;
}

function durationMs(startedAt: string, finishedAt?: string): number | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function durationText(startedAt: string, finishedAt?: string): string {
  const ms = durationMs(startedAt, finishedAt);
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

export default function AutomationsView({ bots, botId, onBack, onSelectBot }: Props) {
  const t = useT();
  const locale = useLocale();
  const [automations, setAutomations] = useState<AutomationLike[]>([]);
  const [runs, setRuns] = useState<Record<string, AutomationRunLike[]>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // Run-history tab: flat list of all stored runs, newest first.
  const [tab, setTab] = useState<'list' | 'history'>('list');
  const [allRuns, setAllRuns] = useState<AutomationRunLike[]>([]);
  const [historyAutomationFilter, setHistoryAutomationFilter] = useState('all');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<HistoryStatusFilter>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Runs started from this view whose IPC call has not returned yet.
  // Stored runs only appear after a run finishes, so in-flight runs are
  // shown from this ephemeral map (startedAt = when the click happened).
  const [running, setRunning] = useState<Record<string, string>>({});

  // Create form state.
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('interval');
  const [minutes, setMinutes] = useState(30);
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  // v0.62 (UI-13): visual cron builder — presets + minute/hour/weekday
  // controls compose the expression above; typing in the text input
  // syncs the controls back when the shape is representable.
  const [cronFields, setCronFields] = useState<CronBuilderFields>(() => CRON_DEFAULT_FIELDS);
  const applyCronFields = (next: CronBuilderFields) => {
    setCronFields(next);
    setCronExpression(buildCronExpression(next));
  };
  const changeCronExpression = (value: string) => {
    setCronExpression(value);
    const parsed = parseCronFields(value);
    if (parsed) setCronFields(parsed);
  };
  const [windowMinutes, setWindowMinutes] = useState<number | ''>('');
  const [eventKind, setEventKind] = useState<'agent-done' | 'file-changed'>('agent-done');
  const [pathPattern, setPathPattern] = useState('');
  const [textContains, setTextContains] = useState('');
  const [validateOnEnable, setValidateOnEnable] = useState(true);
  const [actionKind, setActionKind] = useState<ActionKind>('notify');
  const [prompt, setPrompt] = useState('');
  const [tool, setTool] = useState('');
  const [argsJson, setArgsJson] = useState('{}');
  const [taskTitle, setTaskTitle] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  // v0.74d: "Load sample data" button — seed status (success/error).
  const [seedMessage, setSeedMessage] = useState('');
  const [seeding, setSeeding] = useState(false);
  // Webhook keys: existence per automation, plus a secret shown exactly
  // once right after creation/rotation (never stored in state longer).
  const [keyExists, setKeyExists] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState<{ automationId: string; keyId: string; secret: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  // v0.83b: Composio trigger — curated defs for the picker (loaded
  // lazily when the kind is first picked), the slug to fire on, the
  // pasted signing secret, and the optional URL token (shown once).
  const [composioDefs, setComposioDefs] = useState<Array<{ toolkit: string; slug: string; name: string; delivery: string }>>([]);
  const [composioDefsLoaded, setComposioDefsLoaded] = useState(false);
  const [composioDefsError, setComposioDefsError] = useState(false);
  const [composioSlug, setComposioSlug] = useState('');
  const [composioSlugCustom, setComposioSlugCustom] = useState('');
  const [composioSecret, setComposioSecret] = useState('');
  const [composioSecretExists, setComposioSecretExists] = useState<Record<string, boolean>>({});
  const [composioTokenExists, setComposioTokenExists] = useState<Record<string, boolean>>({});
  const [newComposioToken, setNewComposioToken] = useState<{ automationId: string; keyId: string; secret: string } | null>(null);
  const [composioBusy, setComposioBusy] = useState(false);
  const loadComposioDefs = async () => {
    if (composioDefsLoaded) return;
    try {
      const defs = await window.openBot.listComposioTriggerDefs();
      if (Array.isArray(defs)) setComposioDefs(defs as typeof composioDefs);
      setComposioDefsLoaded(true);
    } catch {
      setComposioDefsError(true);
      setComposioDefsLoaded(true);
    }
  };

  const loadRuns = async () => {
    try {
      const all = asRunList(await window.openBot.listAutomationRuns());
      all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      // The store keeps the newest 100 runs (MAX_RUN_HISTORY); the
      // history tab shows all of them, the per-automation lists the
      // newest 10 each.
      setAllRuns(all.slice(0, 100));
      const grouped: Record<string, AutomationRunLike[]> = {};
      for (const run of all) {
        if (!grouped[run.automationId]) grouped[run.automationId] = [];
        grouped[run.automationId].push(run);
      }
      for (const key of Object.keys(grouped)) {
        grouped[key].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        grouped[key] = grouped[key].slice(0, 10);
      }
      setRuns(grouped);
    } catch {
      // Run history is best-effort; the automation list still renders.
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const list = asAutomationList(await window.openBot.listAutomations());
      setAutomations(list);
      setError('');
      await loadRuns();
      const exists: Record<string, boolean> = {};
      const compSecretExists: Record<string, boolean> = {};
      const compTokenExists: Record<string, boolean> = {};
      const slackExists: Record<string, boolean> = {};
      for (const a of list) {
        if (a.trigger.kind === 'webhook') {
          try {
            exists[a.id] = await window.openBot.hasAutomationWebhookKey(a.id);
          } catch {
            exists[a.id] = false;
          }
        }
        if (a.trigger.kind === 'composio') {
          try {
            compSecretExists[a.id] = await window.openBot.hasComposioTriggerSecret(a.id);
          } catch {
            compSecretExists[a.id] = false;
          }
          try {
            compTokenExists[a.id] = await window.openBot.hasComposioTriggerToken(a.id);
          } catch {
            compTokenExists[a.id] = false;
          }
          // v0.87a (P2-2): Slack-message automations can also receive
          // events straight from Slack — load the signing-secret state.
          if (SLACK_MESSAGE_SLUGS.includes(a.trigger.triggerSlug ?? '')) {
            try {
              slackExists[a.id] = await window.openBot.hasSlackSigningSecret(a.id);
            } catch {
              slackExists[a.id] = false;
            }
          }
        }
      }
      setKeyExists(exists);
      setComposioSecretExists(compSecretExists);
      setComposioTokenExists(compTokenExists);
      setSlackSecretExists(slackExists);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.loadError'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // v0.83b: load the curated Composio trigger defs the first time the
  // kind is picked (one IPC call; the list is static).
  useEffect(() => {
    if (triggerKind === 'composio') void loadComposioDefs();
  }, [triggerKind]);

  // v0.66a: the scheduler reports run changes (started/finished,
  // every source: tick/run-now/retry/event/webhook) — reload history
  // right away so runs from the scheduler/webhook show up without
  // re-entering the view. The ephemeral `running` map stays as is
  // (runs started from this view, before the IPC round-trip returns).
  useEffect(() => {
    const unsubscribe = window.openBot.onAutomationRunsChanged(() => {
      void loadRuns();
    });
    return () => {
      unsubscribe();
    };
  }, []);

  /**
   * v0.74d: seed the sample automations (SAMPLE_AUTOMATIONS) into the
   * real store via IPC `automations:seed-samples`. No bot needs to be
   * picked first: samples carry an empty `botId` ("the default bot").
   * On success the list is reloaded (via `listAutomations` directly,
   * not `load()`, so a reload failure surfaces through `error` instead
   * of overwriting the seed message) and the counts seeded / already
   * present are shown; on seed failure the IPC error is shown and the
   * list is left untouched.
   */
  const seedSamples = async () => {
    setSeeding(true);
    setSeedMessage('');
    try {
      const result = (await window.openBot.seedSampleAutomations()) as {
        created?: unknown[];
        skipped?: string[];
      };
      const createdCount = Array.isArray(result?.created) ? result.created.length : 0;
      const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
      const list = asAutomationList(await window.openBot.listAutomations());
      setAutomations(list);
      await loadRuns();
      setSeedMessage(
        createdCount > 0
          ? t('automations.seedSamplesSuccess', { created: createdCount, skipped: skippedCount })
          : t('automations.seedSamplesAllExist', { skipped: skippedCount }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.seedSamplesError'));
    } finally {
      setSeeding(false);
    }
  };

  const create = async () => {
    if (!botId) return;
    if (!name.trim()) {
      setError(t('automations.createError'));
      return;
    }
    // Webhook automations need their key id up front: the key id is
    // the automation id, so the client picks the id before creating.
    const automationId = crypto.randomUUID();
    const trigger: Record<string, unknown> = { kind: triggerKind };
    if (triggerKind === 'interval') {
      if (!Number.isFinite(minutes) || minutes < 1) {
        setError(t('automations.createError'));
        return;
      }
      trigger.minutes = minutes;
    }
    if (triggerKind === 'cron') {
      if (!cronExpression.trim()) {
        setError(t('automations.createError'));
        return;
      }
      trigger.expression = cronExpression.trim();
      if (windowMinutes !== '' && Number.isFinite(windowMinutes) && windowMinutes >= 1) {
        trigger.window = { minutes: Math.floor(windowMinutes) };
      }
    }
    if (triggerKind === 'webhook') {
      trigger.keyId = automationId;
    }
    if (triggerKind === 'composio') {
      // A custom slug wins over the picker (the picker only lists the
      // 50 curated triggers; any catalog slug is accepted if the shape
      // matches — the core validates the format).
      const slug = composioSlugCustom.trim() || composioSlug.trim();
      if (!slug) {
        setError(t('automations.composioSlugError'));
        return;
      }
      trigger.triggerSlug = slug;
      trigger.keyId = automationId;
    }
    if (triggerKind === 'event') {
      trigger.event = eventKind;
      if (eventKind === 'file-changed' && pathPattern.trim()) {
        trigger.pathPattern = pathPattern.trim();
      }
    }
    const condition: Record<string, unknown> = {};
    if (textContains.trim()) condition.textContains = textContains.trim();

    const action: Record<string, unknown> = { kind: actionKind };
    if (actionKind === 'run-agent') {
      if (!prompt.trim()) {
        setError(t('automations.createError'));
        return;
      }
      action.botId = botId;
      action.prompt = prompt.trim();
    }
    if (actionKind === 'run-tool') {
      if (!tool.trim()) {
        setError(t('automations.createError'));
        return;
      }
      let args: unknown = {};
      try {
        args = argsJson.trim() ? (JSON.parse(argsJson) as unknown) : {};
      } catch {
        setError(t('automations.badArgsJson'));
        return;
      }
      action.tool = tool.trim();
      action.args = args;
    }
    if (actionKind === 'create-task') {
      if (!taskTitle.trim()) {
        setError(t('automations.createError'));
        return;
      }
      action.botId = botId;
      action.title = taskTitle.trim();
    }
    if (actionKind === 'notify') {
      if (!message.trim()) {
        setError(t('automations.createError'));
        return;
      }
      action.message = message.trim();
    }

    const payload: Record<string, unknown> = {
      id: automationId,
      botId,
      name: name.trim(),
      trigger,
      action,
      enabled: true,
      validateOnEnable,
    };
    if (Object.keys(condition).length > 0) payload.condition = condition;

    setCreating(true);
    try {
      const created = asAutomation(await window.openBot.createAutomation(payload));
      if (!created) throw new Error(t('automations.createError'));
      setAutomations((prev) => [...prev, created]);
      setError('');
      // Webhook automations need a key before they can receive anything:
      // create it now and show the secret exactly once.
      if (triggerKind === 'webhook') {
        try {
          const key = await window.openBot.createAutomationWebhookKey(created.id);
          setNewKey({ automationId: created.id, keyId: key.keyId, secret: key.secret });
          setKeyExists((prev) => ({ ...prev, [created.id]: true }));
        } catch (e) {
          setError(e instanceof Error ? e.message : t('automations.webhookKeyError'));
        }
      }
      // Composio automations need the signing secret (pasted in the
      // form) before Composio can deliver anything: store it now. An
      // empty secret is NOT an error here — the row shows "secret
      // missing" and the user can paste it later.
      if (triggerKind === 'composio') {
        if (composioSecret.trim()) {
          try {
            await window.openBot.setComposioTriggerSecret(created.id, composioSecret.trim());
            setComposioSecretExists((prev) => ({ ...prev, [created.id]: true }));
          } catch (e) {
            setError(e instanceof Error ? e.message : t('automations.composioSecretError'));
          }
        }
        setComposioSecret('');
        setComposioSlugCustom('');
      }
      setName('');
      setPrompt('');
      setTool('');
      setArgsJson('{}');
      setTaskTitle('');
      setMessage('');
      setTextContains('');
      setPathPattern('');
      setWindowMinutes('');
      // v0.61 (UI-13 fix): reset the cron builder too — every other
      // field above is cleared, so the next automation must not silently
      // inherit the previous one's schedule.
      setCronFields({ ...CRON_DEFAULT_FIELDS, weekdays: [...CRON_DEFAULT_FIELDS.weekdays] });
      setCronExpression(buildCronExpression(CRON_DEFAULT_FIELDS));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.createError'));
    } finally {
      setCreating(false);
    }
  };

  const toggleEnabled = async (a: AutomationLike, enabled: boolean) => {
    try {
      const updated = asAutomation(await window.openBot.setAutomationEnabled(a.id, enabled));
      setAutomations((prev) =>
        prev.map((x) =>
          x.id === a.id ? { ...x, enabled: updated ? updated.enabled : enabled } : x,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.loadError'));
    }
  };

  const markRunning = (automationId: string) => {
    setRunning((prev) => ({ ...prev, [automationId]: new Date().toISOString() }));
  };

  const clearRunning = (automationId: string) => {
    setRunning((prev) => {
      const next = { ...prev };
      delete next[automationId];
      return next;
    });
  };

  const runNow = async (a: AutomationLike) => {
    markRunning(a.id);
    try {
      await window.openBot.runAutomationNow(a.id);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.loadError'));
    } finally {
      clearRunning(a.id);
    }
  };

  const retryRun = async (runId: string) => {
    const target = allRuns.find((r) => r.id === runId);
    if (target) markRunning(target.automationId);
    try {
      await window.openBot.retryAutomationRun(runId);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.retryError'));
    } finally {
      if (target) clearRunning(target.automationId);
    }
  };

  const createWebhookKey = async (a: AutomationLike) => {
    setKeyBusy(true);
    try {
      const key = await window.openBot.createAutomationWebhookKey(a.id);
      setNewKey({ automationId: a.id, keyId: key.keyId, secret: key.secret });
      setKeyExists((prev) => ({ ...prev, [a.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.webhookKeyError'));
    } finally {
      setKeyBusy(false);
    }
  };

  const rotateWebhookKey = async (a: AutomationLike) => {
    setKeyBusy(true);
    try {
      const key = await window.openBot.rotateAutomationWebhookKey(a.id);
      setNewKey({ automationId: a.id, keyId: key.keyId, secret: key.secret });
      setKeyExists((prev) => ({ ...prev, [a.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.webhookKeyError'));
    } finally {
      setKeyBusy(false);
    }
  };

  const deleteWebhookKey = (a: AutomationLike) => {
    setPendingConfirm({
      title: t('automations.title'),
      message: t('automations.webhookKeyDeleteConfirm', { name: a.name }),
      confirmLabel: t('automations.webhookKeyDelete'),
      onConfirm: () => void doDeleteWebhookKey(a),
    });
  };

  const doDeleteWebhookKey = async (a: AutomationLike) => {
    setKeyBusy(true);
    try {
      await window.openBot.deleteAutomationWebhookKey(a.id);
      setKeyExists((prev) => ({ ...prev, [a.id]: false }));
      setNewKey((prev) => (prev?.automationId === a.id ? null : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.webhookKeyError'));
    } finally {
      setKeyBusy(false);
    }
  };

  const testWebhook = async (a: AutomationLike) => {
    markRunning(a.id);
    try {
      await window.openBot.testAutomationWebhook(a.id, { test: true, at: new Date().toISOString() });
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.webhookTestError'));
    } finally {
      clearRunning(a.id);
    }
  };

  // --- v0.83b: Composio trigger secrets + URL token + test event ---
  const [composioSecretDraft, setComposioSecretDraft] = useState<Record<string, string>>({});
  // --- v0.87a (P2-2): Slack inbound signing secret (direct Slack path) ---
  const [slackSecretExists, setSlackSecretExists] = useState<Record<string, boolean>>({});
  const [slackSecretDraft, setSlackSecretDraft] = useState<Record<string, string>>({});
  const saveSlackSecret = async (a: AutomationLike) => {
    const secret = (slackSecretDraft[a.id] ?? '').trim();
    if (!secret) return;
    setComposioBusy(true);
    try {
      await window.openBot.setSlackSigningSecret(a.id, secret);
      setSlackSecretExists((prev) => ({ ...prev, [a.id]: true }));
      setSlackSecretDraft((prev) => ({ ...prev, [a.id]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.slackSecretError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const deleteSlackSecret = (a: AutomationLike) => {
    setPendingConfirm({
      title: t('automations.title'),
      message: t('automations.slackSecretDeleteConfirm', { name: a.name }),
      confirmLabel: t('automations.slackSecretDelete'),
      onConfirm: () => void doDeleteSlackSecret(a),
    });
  };
  const doDeleteSlackSecret = async (a: AutomationLike) => {
    setComposioBusy(true);
    try {
      await window.openBot.deleteSlackSigningSecret(a.id);
      setSlackSecretExists((prev) => ({ ...prev, [a.id]: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.slackSecretError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const testSlackInbound = async (a: AutomationLike) => {
    markRunning(a.id);
    try {
      await window.openBot.testSlackInbound(a.id);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.slackTestError'));
    } finally {
      clearRunning(a.id);
    }
  };
  const saveComposioSecret = async (a: AutomationLike) => {
    const secret = (composioSecretDraft[a.id] ?? '').trim();
    if (!secret) return;
    setComposioBusy(true);
    try {
      await window.openBot.setComposioTriggerSecret(a.id, secret);
      setComposioSecretExists((prev) => ({ ...prev, [a.id]: true }));
      setComposioSecretDraft((prev) => ({ ...prev, [a.id]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioSecretError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const deleteComposioSecret = (a: AutomationLike) => {
    setPendingConfirm({
      title: t('automations.title'),
      message: t('automations.composioSecretDeleteConfirm', { name: a.name }),
      confirmLabel: t('automations.composioSecretDelete'),
      onConfirm: () => void doDeleteComposioSecret(a),
    });
  };
  const doDeleteComposioSecret = async (a: AutomationLike) => {
    setComposioBusy(true);
    try {
      await window.openBot.deleteComposioTriggerSecret(a.id);
      setComposioSecretExists((prev) => ({ ...prev, [a.id]: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioSecretError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const createComposioToken = async (a: AutomationLike) => {
    setComposioBusy(true);
    try {
      const key = await window.openBot.createComposioTriggerToken(a.id);
      setNewComposioToken({ automationId: a.id, keyId: key.keyId, secret: key.secret });
      setComposioTokenExists((prev) => ({ ...prev, [a.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioTokenError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const rotateComposioToken = async (a: AutomationLike) => {
    setComposioBusy(true);
    try {
      const key = await window.openBot.rotateComposioTriggerToken(a.id);
      setNewComposioToken({ automationId: a.id, keyId: key.keyId, secret: key.secret });
      setComposioTokenExists((prev) => ({ ...prev, [a.id]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioTokenError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const deleteComposioToken = async (a: AutomationLike) => {
    setComposioBusy(true);
    try {
      await window.openBot.deleteComposioTriggerToken(a.id);
      setComposioTokenExists((prev) => ({ ...prev, [a.id]: false }));
      setNewComposioToken((prev) => (prev?.automationId === a.id ? null : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioTokenError'));
    } finally {
      setComposioBusy(false);
    }
  };
  const testComposioTrigger = async (a: AutomationLike) => {
    markRunning(a.id);
    try {
      await window.openBot.testComposioTrigger(a.id, { test: true, at: new Date().toISOString() });
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.composioTestError'));
    } finally {
      clearRunning(a.id);
    }
  };

  const remove = (a: AutomationLike) => {
    setPendingConfirm({
      title: t('automations.title'),
      message: t('automations.deleteConfirm', { name: a.name }),
      confirmLabel: t('automations.delete'),
      onConfirm: () => void doRemove(a),
    });
  };

  const doRemove = async (a: AutomationLike) => {
    try {
      await window.openBot.deleteAutomation(a.id);
      setAutomations((prev) => prev.filter((x) => x.id !== a.id));
      setRuns((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
      setAllRuns((prev) => prev.filter((r) => r.automationId !== a.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('automations.loadError'));
    }
  };

  const triggerSummary = (a: AutomationLike): string => {
    if (a.triggerDescription && a.triggerDescription.trim() !== '') return a.triggerDescription;
    if (a.trigger.kind === 'interval') {
      return `${t('automations.trigger.interval')} · ${t('automations.minutesLabel')}: ${a.trigger.minutes ?? ''}`;
    }
    if (a.trigger.kind === 'cron') {
      const base = `${t('automations.trigger.cron')}: ${a.trigger.expression ?? ''}`;
      return a.trigger.window?.minutes ? `${base} · ±${a.trigger.window.minutes} min` : base;
    }
    if (a.trigger.kind === 'webhook') {
      return `${t('automations.trigger.webhook')} · key ${a.trigger.keyId ?? a.id}`;
    }
    if (a.trigger.kind === 'composio') {
      return `${t('automations.trigger.composio')} · ${a.trigger.triggerSlug ?? ''}`;
    }
    if (a.trigger.kind === 'event') {
      if (a.trigger.event === 'file-changed') {
        return a.trigger.pathPattern
          ? `${t('automations.event.fileChanged')} · ${a.trigger.pathPattern}`
          : t('automations.event.fileChanged');
      }
      return t('automations.event.agentDone');
    }
    return t('automations.trigger.manual');
  };

  const actionSummary = (a: AutomationLike): string => {
    if (a.action.kind === 'run-agent') return t('automations.action.runAgent');
    if (a.action.kind === 'run-tool') {
      return a.action.tool ? `${t('automations.action.runTool')}: ${a.action.tool}` : t('automations.action.runTool');
    }
    if (a.action.kind === 'create-task') {
      return a.action.title ? `${t('automations.action.createTask')}: ${a.action.title}` : t('automations.action.createTask');
    }
    if (a.action.kind === 'notify') {
      return a.action.message ? `${t('automations.action.notify')}: ${a.action.message}` : t('automations.action.notify');
    }
    return a.action.kind;
  };

  const runStatusText = (status: AutomationRunLike['status'] | 'running'): string => {
    if (status === 'ok') return t('automations.runStatus.ok');
    if (status === 'error') return t('automations.runStatus.error');
    if (status === 'running') return t('automations.runStatus.running');
    return t('automations.runStatus.skipped');
  };

  /** Display label for the trigger that fired a run. Prefers the trigger
   * recorded on the run itself; falls back to the automation's trigger
   * (runs recorded before the trigger field existed have neither). */
  const triggerLabel = (row: Pick<HistoryRow, 'trigger' | 'automationId'>): string => {
    const kind = row.trigger ?? automations.find((a) => a.id === row.automationId)?.trigger.kind;
    if (kind === 'interval') return t('automations.trigger.interval');
    if (kind === 'cron') return t('automations.trigger.cron');
    if (kind === 'event') return t('automations.trigger.event');
    if (kind === 'webhook') return t('automations.trigger.webhook');
    if (kind === 'composio') return t('automations.trigger.composio');
    if (kind === 'manual') return t('automations.trigger.manual');
    return '—';
  };

  const automationName = (automationId: string): string =>
    automations.find((a) => a.id === automationId)?.name ?? automationId;

  /** History rows: stored runs plus one synthetic row per in-flight run.
   * The store now also writes a `running` record at start for every
   * source (scheduler/webhook/event/run-now), so a synthetic row is
   * only added when no stored `running` record exists yet for that
   * automation — otherwise the same run would show twice. */
  const storedRunningAutomationIds = new Set(
    allRuns.filter((r) => r.status === 'running').map((r) => r.automationId),
  );
  const historyRows: HistoryRow[] = [
    ...Object.entries(running)
      .filter(([automationId]) => !storedRunningAutomationIds.has(automationId))
      .map(([automationId, startedAt]): HistoryRow => ({
        id: `running:${automationId}`,
        automationId,
        startedAt,
        status: 'running',
        trigger: automations.find((a) => a.id === automationId)?.trigger.kind,
      })),
    ...allRuns.map((r): HistoryRow => ({ ...r })),
  ].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  const visibleHistoryRows = historyRows.filter(
    (row) =>
      (historyAutomationFilter === 'all' || row.automationId === historyAutomationFilter) &&
      (historyStatusFilter === 'all' || row.status === historyStatusFilter),
  );

  const selectedRun = historyRows.find((row) => row.id === selectedRunId) ?? null;

  const selectedBot = bots.find((b) => b.id === botId) ?? null;

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('automations.back')}</button>
      <h2>{t('automations.title')}</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className={tab === 'list' ? 'btn' : 'btn secondary'}
          data-testid="automations-tab-list"
          onClick={() => setTab('list')}
        >
          {t('automations.title')}
        </button>
        <button
          className={tab === 'history' ? 'btn' : 'btn secondary'}
          data-testid="automations-tab-history"
          onClick={() => setTab('history')}
        >
          {t('automations.historyTab')}
        </button>
        <button
          className="btn secondary"
          data-testid="automations-seed-samples"
          onClick={() => void seedSamples()}
          disabled={seeding}
        >
          {seeding ? t('skills.loading') : t('automations.seedSamples')}
        </button>
      </div>
      {seedMessage && (
        <p className="success" data-testid="automations-seed-message">{seedMessage}</p>
      )}
      {error && (
        <>
          <p className="error">{error}</p>
          {/* v0.71 (audit): the automations load had a loading line and
              an error but no retry — leaving the view was the only way
              to reload. */}
          <button className="btn secondary" data-testid="automations-retry" onClick={() => void load()}>
            {t('automations.retry')}
          </button>
        </>
      )}
      {loading && <p>{t('skills.loading')}</p>}

      {bots.length > 0 && (
        <div className="field">
          <select
            id="automation-bot"
            value={botId ?? ''}
            onChange={(e) => onSelectBot?.(e.target.value)}
          >
            <option value="">—</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}
      {!botId && <p>{t('automations.selectBotFirst')}</p>}

      {tab === 'list' && botId && (
        <section className="card">
          <h3>{selectedBot ? selectedBot.name : botId}</h3>
          <div className="field">
            <label htmlFor="automation-name">{t('automations.nameLabel')}</label>
            <input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('automations.namePlaceholder')}
            />
          </div>
          <div className="field">
            <label htmlFor="automation-trigger">{t('automations.triggerLabel')}</label>
            <select
              id="automation-trigger"
              value={triggerKind}
              onChange={(e) => setTriggerKind(e.target.value as TriggerKind)}
            >
              <option value="interval">{t('automations.trigger.interval')}</option>
              <option value="cron">{t('automations.trigger.cron')}</option>
              <option value="event">{t('automations.trigger.event')}</option>
              <option value="webhook">{t('automations.trigger.webhook')}</option>
              <option value="composio">{t('automations.trigger.composio')}</option>
              <option value="manual">{t('automations.trigger.manual')}</option>
            </select>
          </div>
          {triggerKind === 'interval' && (
            <div className="field">
              <label htmlFor="automation-minutes">{t('automations.minutesLabel')}</label>
              <input
                id="automation-minutes"
                type="number"
                min={1}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value) || 1)}
              />
            </div>
          )}
          {triggerKind === 'cron' && (
            <>
              <div className="field">
                <label htmlFor="automation-cron">{t('automations.cronLabel')}</label>
                <input
                  id="automation-cron"
                  value={cronExpression}
                  onChange={(e) => changeCronExpression(e.target.value)}
                  placeholder="0 9 * * 1-5"
                />
                <p className="hint">{t('automations.cronHint')}</p>
              </div>
              <div className="field" data-testid="cron-builder">
                <label>{t('automations.cronBuilderTitle')}</label>
                <div className="row wrap" style={{ marginBottom: 8 }}>
                  {CRON_PRESETS.map((preset) => (
                    <button
                      key={preset.key}
                      type="button"
                      className="btn secondary"
                      onClick={() => applyCronFields(preset.fields)}
                    >
                      {t(preset.labelKey)}
                    </button>
                  ))}
                </div>
                <div className="row wrap">
                  <label>
                    {t('automations.cronMinuteLabel')}{' '}
                    <select
                      value={cronFields.minute}
                      aria-label={t('automations.cronMinuteLabel')}
                      onChange={(e) => applyCronFields({ ...cronFields, minute: e.target.value })}
                    >
                      {Array.from({ length: 60 }, (_, m) => (
                        <option key={m} value={String(m)}>{String(m).padStart(2, '0')}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('automations.cronHourLabel')}{' '}
                    <select
                      value={cronFields.hour}
                      aria-label={t('automations.cronHourLabel')}
                      onChange={(e) => applyCronFields({ ...cronFields, hour: e.target.value })}
                    >
                      <option value="*">∗</option>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={String(h)}>{String(h).padStart(2, '0')}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="row wrap" style={{ marginTop: 8 }}>
                  <span>{t('automations.cronWeekdayLabel')}:</span>
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <label key={day} className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={cronFields.weekdays.includes(day)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...cronFields.weekdays, day]
                            : cronFields.weekdays.filter((d) => d !== day);
                          applyCronFields({ ...cronFields, weekdays: next });
                        }}
                      />
                      {weekdayShortName(day, locale)}
                    </label>
                  ))}
                </div>
                <p className="hint" data-testid="cron-summary">{describeCron(cronExpression, t, locale)}</p>
              </div>
              <div className="field">
                <label htmlFor="automation-window">{t('automations.windowLabel')}</label>
                <input
                  id="automation-window"
                  type="number"
                  min={1}
                  max={1440}
                  value={windowMinutes}
                  onChange={(e) => {
                    const v = e.target.value;
                    setWindowMinutes(v === '' ? '' : Number(v) || '');
                  }}
                  placeholder="60"
                />
                <p className="hint">{t('automations.windowHint')}</p>
              </div>
            </>
          )}
          {triggerKind === 'webhook' && (
            <p className="hint">{t('automations.webhookHint')}</p>
          )}
          {triggerKind === 'composio' && (
            <>
              <div className="field">
                <label htmlFor="automation-composio-slug">{t('automations.composioSlugLabel')}</label>
                <select
                  id="automation-composio-slug"
                  value={composioSlug}
                  onChange={(e) => setComposioSlug(e.target.value)}
                >
                  <option value="">—</option>
                  {composioDefs.map((d) => (
                    <option key={d.slug} value={d.slug}>
                      {d.toolkit} · {d.name} ({d.slug})
                    </option>
                  ))}
                </select>
                <p className="hint">{t('automations.composioSlugHint')}</p>
                {composioDefsError && <p className="hint">{t('automations.composioDefsError')}</p>}
              </div>
              <div className="field">
                <label htmlFor="automation-composio-slug-custom">{t('automations.composioSlugCustomLabel')}</label>
                <input
                  id="automation-composio-slug-custom"
                  value={composioSlugCustom}
                  onChange={(e) => setComposioSlugCustom(e.target.value)}
                  placeholder={t('automations.composioSlugCustomPlaceholder')}
                />
              </div>
              <div className="field">
                <label htmlFor="automation-composio-secret">{t('automations.composioSecretLabel')}</label>
                <input
                  id="automation-composio-secret"
                  type="password"
                  value={composioSecret}
                  onChange={(e) => setComposioSecret(e.target.value)}
                  placeholder={t('automations.composioSecretPlaceholder')}
                />
                <p className="hint">{t('automations.composioSecretHint')}</p>
              </div>
              <p className="hint" data-testid="automation-composio-setup-hint">
                {t('automations.composioSetupHint')}{' '}
                <a
                  href="https://docs.composio.dev/docs/setting-up-triggers/creating-triggers"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('automations.composioSetupDocs')}
                </a>
              </p>
            </>
          )}
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={validateOnEnable}
                onChange={(e) => setValidateOnEnable(e.target.checked)}
              />
              {t('automations.validateOnEnableLabel')}
            </label>
            <p className="hint">{t('automations.validateOnEnableHint')}</p>
          </div>
          {triggerKind === 'event' && (
            <>
              <div className="field">
                <label htmlFor="automation-event">{t('automations.eventLabel')}</label>
                <select
                  id="automation-event"
                  value={eventKind}
                  onChange={(e) => setEventKind(e.target.value as 'agent-done' | 'file-changed')}
                >
                  <option value="agent-done">{t('automations.event.agentDone')}</option>
                  <option value="file-changed">{t('automations.event.fileChanged')}</option>
                </select>
              </div>
              {eventKind === 'file-changed' && (
                <div className="field">
                  <label htmlFor="automation-pattern">{t('automations.pathPatternLabel')}</label>
                  <input
                    id="automation-pattern"
                    value={pathPattern}
                    onChange={(e) => setPathPattern(e.target.value)}
                    placeholder="notes/*.md"
                  />
                </div>
              )}
              {eventKind === 'agent-done' && (
                <div className="field">
                  <label htmlFor="automation-contains">{t('automations.textContainsLabel')}</label>
                  <input
                    id="automation-contains"
                    value={textContains}
                    onChange={(e) => setTextContains(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          <div className="field">
            <label htmlFor="automation-action">{t('automations.actionLabel')}</label>
            <select
              id="automation-action"
              value={actionKind}
              onChange={(e) => setActionKind(e.target.value as ActionKind)}
            >
              <option value="run-agent">{t('automations.action.runAgent')}</option>
              <option value="run-tool">{t('automations.action.runTool')}</option>
              <option value="create-task">{t('automations.action.createTask')}</option>
              <option value="notify">{t('automations.action.notify')}</option>
            </select>
          </div>
          {actionKind === 'run-agent' && (
            <div className="field">
              <label htmlFor="automation-prompt">{t('automations.promptLabel')}</label>
              <textarea
                id="automation-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          )}
          {actionKind === 'run-tool' && (
            <>
              <div className="field">
                <label htmlFor="automation-tool">{t('automations.toolLabel')}</label>
                <input
                  id="automation-tool"
                  value={tool}
                  onChange={(e) => setTool(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="automation-args">{t('automations.argsLabel')}</label>
                <textarea
                  id="automation-args"
                  value={argsJson}
                  onChange={(e) => setArgsJson(e.target.value)}
                />
              </div>
            </>
          )}
          {actionKind === 'create-task' && (
            <div className="field">
              <label htmlFor="automation-task-title">{t('automations.titleLabel')}</label>
              <input
                id="automation-task-title"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
            </div>
          )}
          {actionKind === 'notify' && (
            <div className="field">
              <label htmlFor="automation-message">{t('automations.messageLabel')}</label>
              <input
                id="automation-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          )}
          <button className="btn" data-testid="automation-create" onClick={() => void create()} disabled={creating}>
            {t('automations.createButton')}
          </button>
        </section>
      )}

      {tab === 'list' && automations.map((a) => (
        <section key={a.id} className="card">
          <h3>{a.name}</h3>
          <p>{triggerSummary(a)}</p>
          {a.triggerPresentation?.detail && <p>{a.triggerPresentation.label} · {a.triggerPresentation.detail}</p>}
          <p>{actionSummary(a)}</p>
          <p>
            {t('automations.nextRun')}: {a.nextRunAt ? new Date(a.nextRunAt).toLocaleString() : '—'}
          </p>
          {a.trigger.kind === 'webhook' && (
            <div>
              <p>
                {keyExists[a.id]
                  ? t('automations.webhookKeyExists')
                  : t('automations.webhookKeyMissing')}
              </p>
              {newKey?.automationId === a.id && (
                <div>
                  <p className="hint">{t('automations.webhookKeyShownOnce')}</p>
                  <p><code>{newKey.secret}</code></p>
                  <button
                    className="btn secondary"
                    onClick={() => void navigator.clipboard?.writeText(newKey.secret)}
                  >
                    {t('automations.webhookKeyCopy')}
                  </button>
                  <button className="btn secondary" onClick={() => setNewKey(null)}>
                    {t('automations.webhookKeyHide')}
                  </button>
                </div>
              )}
              <div className="row wrap">
                {!keyExists[a.id] && (
                  <button className="btn secondary" onClick={() => void createWebhookKey(a)} disabled={keyBusy}>
                    {t('automations.webhookKeyCreate')}
                  </button>
                )}
                {keyExists[a.id] && (
                  <>
                    <button className="btn secondary" onClick={() => void rotateWebhookKey(a)} disabled={keyBusy}>
                      {t('automations.webhookKeyRotate')}
                    </button>
                    <button className="btn secondary" onClick={() => void deleteWebhookKey(a)} disabled={keyBusy}>
                      {t('automations.webhookKeyDelete')}
                    </button>
                    <button className="btn secondary" onClick={() => void testWebhook(a)} disabled={!a.enabled}>
                      {t('automations.webhookTest')}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {a.trigger.kind === 'composio' && (
            <div>
              <p className="hint">{t('automations.composioRouteHint', { id: a.id })}</p>
              <p className="hint">
                <a
                  href="https://docs.composio.dev/docs/setting-up-triggers/creating-triggers"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('automations.composioSetupDocs')}
                </a>
              </p>
              <p>
                {composioSecretExists[a.id]
                  ? t('automations.composioSecretExists')
                  : t('automations.composioSecretMissing')}
              </p>
              {!composioSecretExists[a.id] && (
                <div className="row wrap">
                  <input
                    type="password"
                    aria-label={t('automations.composioSecretLabel')}
                    value={composioSecretDraft[a.id] ?? ''}
                    onChange={(e) =>
                      setComposioSecretDraft((prev) => ({ ...prev, [a.id]: e.target.value }))
                    }
                    placeholder={t('automations.composioSecretPlaceholder')}
                  />
                  <button
                    className="btn secondary"
                    onClick={() => void saveComposioSecret(a)}
                    disabled={composioBusy || !(composioSecretDraft[a.id] ?? '').trim()}
                  >
                    {t('automations.composioSecretSave')}
                  </button>
                </div>
              )}
              {composioSecretExists[a.id] && (
                <div className="row wrap">
                  <button className="btn secondary" onClick={() => void deleteComposioSecret(a)} disabled={composioBusy}>
                    {t('automations.composioSecretDelete')}
                  </button>
                  <button className="btn secondary" onClick={() => void testComposioTrigger(a)} disabled={!a.enabled}>
                    {t('automations.composioTest')}
                  </button>
                </div>
              )}
              <p>
                {composioTokenExists[a.id]
                  ? t('automations.composioTokenExists')
                  : t('automations.composioTokenMissing')}
              </p>
              {newComposioToken?.automationId === a.id && (
                <div>
                  <p className="hint">{t('automations.composioTokenShownOnce')}</p>
                  <p><code>{newComposioToken.secret}</code></p>
                  <button
                    className="btn secondary"
                    onClick={() => void navigator.clipboard?.writeText(newComposioToken.secret)}
                  >
                    {t('automations.composioTokenCopy')}
                  </button>
                  <button className="btn secondary" onClick={() => setNewComposioToken(null)}>
                    {t('automations.composioTokenHide')}
                  </button>
                </div>
              )}
              <div className="row wrap">
                {!composioTokenExists[a.id] && (
                  <button className="btn secondary" onClick={() => void createComposioToken(a)} disabled={composioBusy}>
                    {t('automations.composioTokenCreate')}
                  </button>
                )}
                {composioTokenExists[a.id] && (
                  <>
                    <button className="btn secondary" onClick={() => void rotateComposioToken(a)} disabled={composioBusy}>
                      {t('automations.composioTokenRotate')}
                    </button>
                    <button className="btn secondary" onClick={() => void deleteComposioToken(a)} disabled={composioBusy}>
                      {t('automations.composioTokenDelete')}
                    </button>
                  </>
                )}
              </div>
              {/* v0.87a (P2-2): direct-Slack inbound for Slack-message
                  automations — same automation, second delivery path
                  (Slack app posts straight to open-bot instead of
                  going through Composio). */}
              {SLACK_MESSAGE_SLUGS.includes(a.trigger.triggerSlug ?? '') && (
                <div>
                  <p className="hint">{t('automations.slackRouteHint', { id: a.id })}</p>
                  <p className="hint">{t('automations.slackTunnelHint')}</p>
                  <p>
                    {slackSecretExists[a.id]
                      ? t('automations.slackSecretExists')
                      : t('automations.slackSecretMissing')}
                  </p>
                  {!slackSecretExists[a.id] && (
                    <div className="row wrap">
                      <input
                        type="password"
                        aria-label={t('automations.slackSecretLabel')}
                        value={slackSecretDraft[a.id] ?? ''}
                        onChange={(e) =>
                          setSlackSecretDraft((prev) => ({ ...prev, [a.id]: e.target.value }))
                        }
                        placeholder={t('automations.slackSecretPlaceholder')}
                      />
                      <button
                        className="btn secondary"
                        onClick={() => void saveSlackSecret(a)}
                        disabled={composioBusy || !(slackSecretDraft[a.id] ?? '').trim()}
                      >
                        {t('automations.slackSecretSave')}
                      </button>
                    </div>
                  )}
                  {slackSecretExists[a.id] && (
                    <div className="row wrap">
                      <button className="btn secondary" onClick={() => void deleteSlackSecret(a)} disabled={composioBusy}>
                        {t('automations.slackSecretDelete')}
                      </button>
                      <button className="btn secondary" onClick={() => void testSlackInbound(a)} disabled={!a.enabled}>
                        {t('automations.slackTest')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="row wrap">
            <label>
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={(e) => void toggleEnabled(a, e.target.checked)}
              />
              {t('automations.enabled')}
            </label>
            <button className="btn secondary" data-testid="automation-run-now" onClick={() => void runNow(a)} disabled={!a.enabled}>
              {t('automations.runNow')}
            </button>
            <button className="btn secondary" data-testid="automation-delete" onClick={() => void remove(a)}>
              {t('automations.delete')}
            </button>
          </div>
          {(runs[a.id]?.length ?? 0) > 0 && (
            <div>
              <h4>{t('automations.runsTitle')}</h4>
              <ul className="task-list">
                {runs[a.id].map((r) => {
                  const detail = (r.output ?? r.error ?? '').slice(0, 200);
                  return (
                    <li key={r.id} title={r.output ?? r.error ?? ''}>
                      {new Date(r.startedAt).toLocaleString()} · {runStatusText(r.status)}
                      {r.retriedFromRunId ? ` · ${t('automations.retriedFrom')}` : ''}
                      {detail ? ` · ${detail}` : ''}
                      {r.status === 'error' && (
                        <button className="btn secondary" onClick={() => void retryRun(r.id)}>
                          {t('automations.retryRun')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      ))}
      {tab === 'history' && (
        <section className="card" data-testid="run-history">
          <h3>{t('automations.historyTab')}</h3>
          <div className="row wrap">
            <label>
              {t('automations.historyFilterAutomation')}{' '}
              <select
                data-testid="history-filter-automation"
                value={historyAutomationFilter}
                onChange={(e) => setHistoryAutomationFilter(e.target.value)}
              >
                <option value="all">{t('automations.historyFilterAll')}</option>
                {automations.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label>
              {t('automations.historyFilterStatus')}{' '}
              <select
                data-testid="history-filter-status"
                value={historyStatusFilter}
                onChange={(e) => setHistoryStatusFilter(e.target.value as HistoryStatusFilter)}
              >
                <option value="all">{t('automations.historyFilterAll')}</option>
                <option value="ok">{t('automations.runStatus.ok')}</option>
                <option value="error">{t('automations.runStatus.error')}</option>
                <option value="skipped">{t('automations.runStatus.skipped')}</option>
                <option value="running">{t('automations.runStatus.running')}</option>
              </select>
            </label>
          </div>
          {visibleHistoryRows.length === 0 && <p>{t('automations.historyEmpty')}</p>}
          <ul className="task-list">
            {visibleHistoryRows.map((row) => {
              const short = (row.error ?? row.output ?? '').slice(0, 200);
              return (
                <li
                  key={row.id}
                  data-testid="run-history-row"
                  data-run-id={row.id}
                  data-run-status={row.status}
                  onClick={() => setSelectedRunId(row.id)}
                  style={{ cursor: 'pointer' }}
                  title={row.output ?? row.error ?? ''}
                >
                  {automationName(row.automationId)} · {new Date(row.startedAt).toLocaleString()} ·{' '}
                  {runStatusText(row.status)} · {durationText(row.startedAt, row.finishedAt)}
                  {short ? ` · ${short}` : ''}
                </li>
              );
            })}
          </ul>
          {selectedRun && (
            <div className="card" data-testid="run-history-detail">
              <h4>{t('automations.historyDetailTitle')}</h4>
              <p>
                {automationName(selectedRun.automationId)} · {new Date(selectedRun.startedAt).toLocaleString()}
              </p>
              <p>
                {runStatusText(selectedRun.status)} · {t('automations.historyTrigger')}: {triggerLabel(selectedRun)} ·{' '}
                {t('automations.historyDuration')}: {durationText(selectedRun.startedAt, selectedRun.finishedAt)}
              </p>
              <p>
                {t('automations.historyStarted')}: {new Date(selectedRun.startedAt).toLocaleString()} ·{' '}
                {t('automations.historyFinished')}:{' '}
                {selectedRun.finishedAt ? new Date(selectedRun.finishedAt).toLocaleString() : '—'}
              </p>
              {selectedRun.retriedFromRunId && <p>{t('automations.retriedFrom')}</p>}
              {selectedRun.error && (
                <>
                  <p><strong>{t('automations.historyError')}</strong></p>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>{selectedRun.error}</pre>
                </>
              )}
              {selectedRun.output && (
                <>
                  <p><strong>{t('automations.historyOutput')}</strong></p>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>{selectedRun.output}</pre>
                </>
              )}
              {selectedRun.triggerInput && (
                <>
                  <p><strong>{t('automations.historyTriggerInput')}</strong></p>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>{selectedRun.triggerInput}</pre>
                </>
              )}
              <button className="btn secondary" onClick={() => setSelectedRunId(null)}>
                {t('automations.historyClose')}
              </button>
            </div>
          )}
        </section>
      )}
      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            c.onConfirm();
          }}
        />
      )}
    </div>
  );
}
