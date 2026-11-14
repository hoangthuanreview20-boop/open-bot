/**
 * Shell-command hooks manager for Settings → Hooks (v1.01, T2).
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all IPC lives in `SettingsView`; this component only holds the
 * add/edit form draft + the two-step delete confirmation.
 *
 * Three blocks:
 * 1. Command hooks — list (name, command, events, timeout, enabled)
 *    with add / edit / delete. A command hook is a shell command run
 *    on every matching lifecycle event (stdin gets the event as JSON;
 *    exit 0 = allow, exit 2 = block, other non-zero = error).
 * 2. Test gate — the command run when a subagent stops; while it
 *    fails, the subagent is sent back to fix its work.
 * 3. Recent hook runs — the execution log (newest first).
 */
import { useState } from 'react';
import type { HookCommandView, HookTestRunView, TestGateView } from '../types';
import type { SettingsShared } from './settings/settingsShared';

/** All lifecycle events a command hook can attach to (see core hooks). */
const ALL_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
] as const;

interface Draft {
  name: string;
  command: string;
  events: string[];
  timeoutMs: string;
  description: string;
  /** Extra env for the hook process, one KEY=VALUE per line. */
  envText: string;
  enabled: boolean;
}

function emptyDraft(): Draft {
  return {
    name: '',
    command: '',
    events: ['PreToolUse'],
    timeoutMs: '10000',
    description: '',
    envText: '',
    enabled: true,
  };
}

function envTextFrom(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Parse the env textarea (one KEY=VALUE per line). Same rules as the
 * core runtime (`shellCommandRunner`): keys must be shell-safe
 * identifiers, and secret-looking names are refused here instead of
 * being silently dropped at run time.
 */
function parseEnvText(
  text: string,
  t: SettingsShared['t'],
): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { env: {}, error: t('settings.hooksCommandEnvInvalid') };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { env: {}, error: t('settings.hooksCommandEnvInvalid') };
    }
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i.test(key)) {
      return { env: {}, error: t('settings.hooksCommandEnvSecret') };
    }
    env[key] = line.slice(eq + 1).trim();
  }
  return { env, error: null };
}

function draftFrom(view: HookCommandView): Draft {
  return {
    name: view.name,
    command: view.command,
    events: view.events.length > 0 ? [...view.events] : ['PreToolUse'],
    timeoutMs: String(view.timeoutMs ?? 10000),
    description: view.description ?? '',
    envText: envTextFrom(view.env),
    enabled: view.enabled !== false,
  };
}

function draftError(draft: Draft, t: SettingsShared['t']): string | null {
  if (!draft.name.trim()) return t('settings.hooksCommandNameRequired');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(draft.name.trim())) {
    return t('settings.hooksCommandNameInvalid');
  }
  if (!draft.command.trim()) return t('settings.hooksCommandCommandRequired');
  if (draft.events.length === 0) return t('settings.hooksCommandEventsRequired');
  const timeout = Number(draft.timeoutMs);
  if (!Number.isFinite(timeout) || Math.floor(timeout) !== timeout || timeout < 100 || timeout > 300000) {
    return t('settings.hooksCommandTimeoutInvalid');
  }
  const { error } = parseEnvText(draft.envText, t);
  if (error) return error;
  return null;
}

export default function HookCommandSection({ s }: { s: SettingsShared }) {
  const {
    t,
    hookCommands,
    hookCommandsError,
    hookCommandsLoading,
    reloadHookCommands,
    saveHookCommand,
    deleteHookCommand,
    toggleHookCommand,
    testHookCommand,
    testGate,
    testGateError,
    testGateSaved,
    saveTestGate,
    hookLog,
    hookLogError,
    hookLogLoading,
    reloadHookLog,
  } = s;

  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [gateDraft, setGateDraft] = useState<TestGateView | null>(null);
  const [gateSaving, setGateSaving] = useState(false);
  const [testRun, setTestRun] = useState<{ name: string; result: HookTestRunView } | null>(null);
  const [testingName, setTestingName] = useState<string | null>(null);

  const doTestRun = async (view: HookCommandView) => {
    setTestingName(view.name);
    try {
      const result = await testHookCommand(view, view.events[0]);
      if (result) setTestRun({ name: view.name, result });
    } finally {
      setTestingName(null);
    }
  };

  const startAdd = () => {
    setEditing(emptyDraft());
    setEditingOriginal(null);
    setFormError('');
  };

  const startEdit = (view: HookCommandView) => {
    setEditing(draftFrom(view));
    setEditingOriginal(view.name);
    setFormError('');
  };

  const saveDraft = async () => {
    if (!editing) return;
    const err = draftError(editing, t);
    if (err) {
      setFormError(err);
      return;
    }
    // Renaming is not supported: the name is the identity. Editing
    // keeps the original name even when the field changed.
    const { env } = parseEnvText(editing.envText, t);
    const entry: HookCommandView = {
      name: (editingOriginal ?? editing.name).trim(),
      command: editing.command.trim(),
      events: [...editing.events],
      enabled: editing.enabled,
      timeoutMs: Number(editing.timeoutMs),
      ...(editing.description.trim() ? { description: editing.description.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    setSaving(true);
    try {
      const saveErr = await saveHookCommand(entry);
      if (saveErr) {
        setFormError(saveErr);
        return;
      }
      setEditing(null);
      setEditingOriginal(null);
      setFormError('');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (name: string) => {
    setConfirmDelete(null);
    await deleteHookCommand(name);
  };

  const gate = gateDraft ?? testGate ?? {};
  // v1.01 merge (defensive): SettingsShared may lack the v101 fields
  // (e.g. an old test harness only builds the pre-v101 fields) — treat
  // a missing list as empty instead of crashing the Settings page.
  const hookCommandsSafe = hookCommands ?? [];
  const hookLogSafe = hookLog ?? [];
  /** Gate commands as one-per-line text (commands[] wins over command). */
  const gateCommandsText =
    gate.commands && gate.commands.length > 0
      ? gate.commands.join('\n')
      : (gate.command ?? '');
  const saveGate = async () => {
    setGateSaving(true);
    try {
      const lines = gateCommandsText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await saveTestGate({
        ...(lines.length > 1
          ? { commands: lines }
          : lines.length === 1
            ? { command: lines[0] }
            : {}),
        ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
      });
      setGateDraft(null);
    } finally {
      setGateSaving(false);
    }
  };

  const toggleEvent = (event: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      events: editing.events.includes(event)
        ? editing.events.filter((e) => e !== event)
        : [...editing.events, event],
    });
  };

  return (
    <>
      <h3>{t('settings.hooksCommandTitle')}</h3>
      <p className="hint">{t('settings.hooksCommandIntro')}</p>
      <p className="hint">{t('settings.hooksCommandExitNote')}</p>
      {hookCommandsLoading && (
        <p className="hint" data-testid="hooks-command-loading">{t('settings.hooksLoading')}</p>
      )}
      {hookCommandsError && (
        <>
          <p className="error">{hookCommandsError}</p>
          <button className="btn secondary" data-testid="hooks-command-retry" onClick={() => void reloadHookCommands()}>
            {t('settings.retry')}
          </button>
        </>
      )}
      {!hookCommandsLoading && !hookCommandsError && hookCommandsSafe.length === 0 && !editing && (
        <p>{t('settings.hooksCommandEmpty')}</p>
      )}
      {hookCommandsSafe.map((c) => (
        <div key={c.name}>
          <strong>{c.name}</strong>
          <p>
            <code>{c.command}</code>
          </p>
          {c.description && <p>{c.description}</p>}
          <p className="hint">
            {t('settings.hooksEvents', { events: c.events.join(', ') })}
            {' · '}
            {t('settings.hooksCommandTimeout', { ms: c.timeoutMs ?? 10000 })}
            {c.env && Object.keys(c.env).length > 0
              ? ` · ${t('settings.hooksCommandEnvCount', { keys: Object.keys(c.env).join(', ') })}`
              : ''}
          </p>
          <label>
            <input
              type="checkbox"
              checked={c.enabled !== false}
              onChange={(e) => void toggleHookCommand(c.name, e.target.checked)}
            />
            {t('settings.hooksEnableLabel')}
          </label>{' '}
          <button className="btn secondary" onClick={() => startEdit(c)}>
            {t('settings.hooksCommandEdit')}
          </button>{' '}
          <button
            className="btn secondary"
            disabled={testingName === c.name}
            onClick={() => void doTestRun(c)}
          >
            {testingName === c.name
              ? t('settings.hooksCommandTesting')
              : t('settings.hooksCommandTest')}
          </button>{' '}
          {confirmDelete === c.name ? (
            <>
              <button className="btn secondary" onClick={() => void doDelete(c.name)}>
                {t('settings.hooksCommandDeleteConfirm')}
              </button>{' '}
              <button className="btn secondary" onClick={() => setConfirmDelete(null)}>
                {t('settings.cancel')}
              </button>
            </>
          ) : (
            <button className="btn secondary" onClick={() => setConfirmDelete(c.name)}>
              {t('settings.hooksCommandDelete')}
            </button>
          )}
        </div>
      ))}

      {!editing && (
        <button className="btn secondary" onClick={startAdd}>
          {t('settings.hooksCommandAdd')}
        </button>
      )}

      {testRun && (
        <div>
          <h3>{t('settings.hooksCommandTestTitle', { name: testRun.name })}</h3>
          <p>
            {t('settings.hooksCommandTestEvent', { event: testRun.result.event })}
            {' · '}
            {t('settings.hooksCommandTestDuration', { ms: testRun.result.durationMs })}
            {' · '}
            {t('settings.hooksCommandTestExit', {
              exit:
                testRun.result.exitCode === null
                  ? `signal ${testRun.result.signal ?? '?'}`
                  : String(testRun.result.exitCode),
            })}
            {testRun.result.timedOut ? ` · ${t('settings.hooksLogTimeout')}` : ''}
          </p>
          {testRun.result.ok && testRun.result.decision ? (
            <p>
              {t('settings.hooksCommandTestDecision', { action: testRun.result.decision.action })}
              {testRun.result.decision.reason ? ` — ${testRun.result.decision.reason}` : ''}
            </p>
          ) : (
            <p className="error">{testRun.result.error ?? t('settings.hooksCommandSaveError')}</p>
          )}
          {testRun.result.stdout.trim() && <pre>{testRun.result.stdout.trim()}</pre>}
          {testRun.result.stderr.trim() && <pre>{testRun.result.stderr.trim()}</pre>}
          <p className="hint">{t('settings.hooksCommandTestCwd', { cwd: testRun.result.cwd })}</p>
          <button className="btn secondary" onClick={() => setTestRun(null)}>
            {t('settings.cancel')}
          </button>
        </div>
      )}

      {editing && (
        <div>
          <h3>{editingOriginal ? t('settings.hooksCommandEditTitle') : t('settings.hooksCommandAddTitle')}</h3>
          <div className="field">
            <label htmlFor="hook-command-name">{t('settings.hooksCommandNameLabel')}</label>
            <input
              id="hook-command-name"
              value={editing.name}
              disabled={editingOriginal !== null}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="hook-command-command">{t('settings.hooksCommandCommandLabel')}</label>
            <input
              id="hook-command-command"
              value={editing.command}
              placeholder="npm test"
              onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            />
          </div>
          <div className="field">
            <span>{t('settings.hooksCommandEventsLabel')}</span>
            {ALL_EVENTS.map((event) => (
              <label key={event} title={t(`settings.hooksEventDesc${event}`)}>
                <input
                  type="checkbox"
                  checked={editing.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                />
                {event}
              </label>
            ))}
            <p className="hint">
              {editing.events
                .map((event) => t(`settings.hooksEventDesc${event}`))
                .join(' ')}
            </p>
          </div>
          <div className="field">
            <label htmlFor="hook-command-timeout">{t('settings.hooksCommandTimeoutLabel')}</label>
            <input
              id="hook-command-timeout"
              type="number"
              min={100}
              max={300000}
              step={100}
              value={editing.timeoutMs}
              onChange={(e) => setEditing({ ...editing, timeoutMs: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="hook-command-description">{t('settings.hooksCommandDescriptionLabel')}</label>
            <input
              id="hook-command-description"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="hook-command-env">{t('settings.hooksCommandEnvLabel')}</label>
            <textarea
              id="hook-command-env"
              rows={3}
              value={editing.envText}
              placeholder="MY_FLAG=1"
              onChange={(e) => setEditing({ ...editing, envText: e.target.value })}
            />
            <p className="hint">{t('settings.hooksCommandEnvHint')}</p>
          </div>
          <label>
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            {t('settings.hooksEnableLabel')}
          </label>
          {formError && <p className="error">{formError}</p>}
          <div className="row wrap">
            <button className="btn secondary" disabled={saving} onClick={() => void saveDraft()}>
              {t('settings.save')}
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                setEditing(null);
                setEditingOriginal(null);
                setFormError('');
              }}
            >
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      )}

      <h3>{t('settings.hooksTestGateTitle')}</h3>
      <p className="hint">{t('settings.hooksTestGateIntro')}</p>
      <p className="hint">{t('settings.hooksTestGateCommandsHint')}</p>
      {testGateError && <p className="error">{testGateError}</p>}
      {testGateSaved && <p className="success">{t('settings.hooksTestGateSaved')}</p>}
      <div className="field">
        <label htmlFor="hook-testgate-command">{t('settings.hooksTestGateCommandLabel')}</label>
        <textarea
          id="hook-testgate-command"
          rows={3}
          value={gateCommandsText}
          placeholder={'npm run typecheck\nnpm test'}
          onChange={(e) => {
            const lines = e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            setGateDraft({
              ...gate,
              ...(lines.length > 1
                ? { commands: lines, command: undefined }
                : { command: lines[0] ?? '', commands: undefined }),
            });
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="hook-testgate-timeout">{t('settings.hooksCommandTimeoutLabel')}</label>
        <input
          id="hook-testgate-timeout"
          type="number"
          min={100}
          max={300000}
          step={1000}
          value={gate.timeoutMs ?? 300000}
          onChange={(e) =>
            setGateDraft({ ...gate, timeoutMs: Number(e.target.value) || 300000 })
          }
        />
      </div>
      <button className="btn secondary" disabled={gateSaving} onClick={() => void saveGate()}>
        {t('settings.save')}
      </button>

      <h3>{t('settings.hooksLogTitle')}</h3>
      <p className="hint">{t('settings.hooksLogIntro')}</p>
      {hookLogLoading && (
        <p className="hint" data-testid="hooks-log-loading">{t('settings.hooksLoading')}</p>
      )}
      {hookLogError && (
        <>
          <p className="error">{hookLogError}</p>
          <button className="btn secondary" data-testid="hooks-log-retry" onClick={() => void reloadHookLog()}>
            {t('settings.retry')}
          </button>
        </>
      )}
      {!hookLogLoading && !hookLogError && hookLogSafe.length === 0 && (
        <p>{t('settings.hooksLogEmpty')}</p>
      )}
      {hookLogSafe.length > 0 && (
        <>
          <p className="hint">
            {t('settings.hooksLogSummary', {
              total: Math.min(hookLogSafe.length, 50),
              blocks: hookLogSafe.filter((r) => r.action === 'block').length,
              errors: hookLogSafe.filter((r) => r.action === 'error').length,
            })}
          </p>
          <button className="btn secondary" onClick={() => void reloadHookLog()}>
            {t('settings.hooksLogReload')}
          </button>
          <ul>
            {hookLogSafe.slice(0, 50).map((r) => (
              <li key={r.seq}>
                <strong>{r.hookName}</strong> · {r.event} · {r.action} · {r.durationMs}ms
                {r.timedOut ? ` · ${t('settings.hooksLogTimeout')}` : ''}
                {r.reason ? ` — ${r.reason}` : ''}
                {r.error ? ` — ${r.error}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
