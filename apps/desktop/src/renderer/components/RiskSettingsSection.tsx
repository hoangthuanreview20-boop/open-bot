/**
 * RiskSettingsSection (v1.01, Team T3) — risk rules + allow/deny lists +
 * built-in rule toggles + pending confirmations + audit + budget history,
 * in Settings (Security tab).
 *
 * Self-contained: it loads its own data over IPC (`risk-*`, see
 * apps/desktop/src/main/main.ts) and owns its drafts, so SettingsView
 * needs no new state — the Security tab only renders this section.
 * Approving/denying a pending confirmation still happens in Chat
 * (ApprovalCard); this section is read-only for confirmations and
 * the audit, so a user cannot approve a risky call from a settings
 * page they are not looking at.
 *
 * i18n: all display strings live in locales/*.json under
 * `settings.risk.*` (plus the shared `risk.low/medium/high` labels)
 * and are read through useT() — no hard-coded strings in this file.
 * Renderer comments are in English: tests/i18n.test.mjs bans
 * Vietnamese characters in renderer files.
 */

import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

/** Local mirror of the core RiskRule shape (see global.d.ts). */
interface RiskRuleView {
  id: string;
  description: string;
  level: 'low' | 'medium' | 'high';
  score: number;
  tool?: string;
  toolPattern?: string;
  argsPattern?: string;
  argsKey?: string;
}

interface RiskRulesData {
  rules: RiskRuleView[];
  allowlist: string[];
  denylist: string[];
  disabledBuiltinRuleIds: string[];
}

interface BuiltinRiskRuleView extends RiskRuleView {
  enabled: boolean;
}

interface PendingConfirmationView {
  id: string;
  botId: string;
  toolName: string;
  riskLevel: string;
  createdAtMs: number;
}

interface ConfirmationAuditView {
  confirmationId: string;
  callId: string;
  botId: string;
  toolName: string;
  riskLevel: string;
  riskScore: number;
  status: string;
  decidedBy: string;
  atMs: number;
}

interface BudgetHistoryView {
  conversationId: string;
  botId: string;
  model: string | null;
  totalTokens: number;
  costUsd: number | null;
  status: string;
  endedAtMs: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? '?' : `$${costUsd.toFixed(4)}`;
}

export default function RiskSettingsSection() {
  const t = useT();
  const [rulesData, setRulesData] = useState<RiskRulesData | null>(null);
  const [builtinRules, setBuiltinRules] = useState<BuiltinRiskRuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Add-rule form drafts.
  const [ruleDescription, setRuleDescription] = useState('');
  const [ruleLevel, setRuleLevel] = useState<'low' | 'medium' | 'high'>('high');
  const [ruleScore, setRuleScore] = useState('80');
  const [ruleTool, setRuleTool] = useState('');
  const [ruleArgsPattern, setRuleArgsPattern] = useState('');

  // Allow/deny list drafts.
  const [allowDraft, setAllowDraft] = useState('');
  const [denyDraft, setDenyDraft] = useState('');

  // Read-only views (pending confirmations, audit, budget history).
  const [pending, setPending] = useState<PendingConfirmationView[]>([]);
  const [audit, setAudit] = useState<ConfirmationAuditView[]>([]);
  const [budget, setBudget] = useState<BudgetHistoryView[]>([]);

  // Risk level labels — literal t() calls so the i18n key scan finds them.
  const levelLabels: Record<string, string> = {
    low: t('risk.low'),
    medium: t('risk.medium'),
    high: t('risk.high'),
  };
  // Audit status labels — literal t() calls, same reason.
  const auditStatusLabels: Record<string, string> = {
    approved: t('settings.risk.auditApproved'),
    denied: t('settings.risk.auditDenied'),
    edited: t('settings.risk.auditEdited'),
    expired: t('settings.risk.auditExpired'),
    pending: t('settings.risk.auditPending'),
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [rulesRes, builtinRes, pendingRes, auditRes, budgetRes] =
        await Promise.allSettled([
          window.openBot.listRiskRules(),
          window.openBot.listBuiltinRiskRules(),
          window.openBot.listPendingConfirmations(),
          window.openBot.getConfirmationAudit(),
          window.openBot.listBudgetHistory(),
        ]);
      if (rulesRes.status === 'fulfilled') setRulesData(rulesRes.value);
      else setError(t('settings.risk.loadError'));
      if (builtinRes.status === 'fulfilled') setBuiltinRules(builtinRes.value.rules);
      if (pendingRes.status === 'fulfilled') setPending(pendingRes.value);
      if (auditRes.status === 'fulfilled') setAudit(auditRes.value.slice(-10).reverse());
      if (budgetRes.status === 'fulfilled') setBudget(budgetRes.value.slice(-10).reverse());
      if (
        rulesRes.status === 'rejected' &&
        builtinRes.status === 'rejected' &&
        pendingRes.status === 'rejected' &&
        auditRes.status === 'rejected' &&
        budgetRes.status === 'rejected'
      ) {
        setError(t('settings.risk.loadError'));
      }
    } catch {
      setError(t('settings.risk.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once on mount; refresh is manual (button) so the page
    // never re-renders under the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addRule = async () => {
    const description = ruleDescription.trim();
    const score = Number(ruleScore);
    if (!description) {
      setError(t('settings.risk.formInvalid'));
      return;
    }
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      setError(t('settings.risk.formInvalid'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const rule: RiskRuleView = {
        id: `custom-${Date.now().toString(36)}`,
        description,
        level: ruleLevel,
        score: Math.floor(score),
        ...(ruleTool.trim() ? { tool: ruleTool.trim() } : {}),
        ...(ruleArgsPattern.trim() ? { argsPattern: ruleArgsPattern.trim() } : {}),
      };
      await window.openBot.addRiskRule(rule);
      setRuleDescription('');
      setRuleTool('');
      setRuleArgsPattern('');
      setNotice(t('settings.risk.ruleAdded'));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (id: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.removeRiskRule(id);
      setNotice(t('settings.risk.ruleRemoved'));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleBuiltinRule = async (id: string, enabled: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.setBuiltinRiskRuleEnabled(id, enabled);
      setNotice(enabled ? t('settings.risk.builtinEnabled') : t('settings.risk.builtinDisabled'));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setListEntry = async (list: 'allow' | 'deny', action: 'add' | 'remove', entry: string) => {
    const trimmed = entry.trim();
    if (action === 'add' && !trimmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.setRiskListEntry(list, action, trimmed);
      if (list === 'allow') setAllowDraft('');
      else setDenyDraft('');
      setNotice(t('settings.risk.entrySaved'));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>{t('settings.risk.title')}</h3>
      <p className="hint">{t('settings.risk.intro')}</p>
      {loading && <p className="hint">{t('settings.risk.loading')}</p>}
      {error && (
        <>
          <p className="error">{error}</p>
          <button className="btn secondary" data-testid="risk-retry" onClick={() => void load()}>
            {t('settings.risk.retry')}
          </button>
        </>
      )}
      {notice && <p className="hint">{notice}</p>}

      {/* Custom rules: user-defined, evaluated after the built-in table. */}
      <h4>{t('settings.risk.rulesTitle')}</h4>
      <p className="hint">{t('settings.risk.rulesHint')}</p>
      {rulesData && rulesData.rules.length === 0 && (
        <p className="hint">{t('settings.risk.rulesEmpty')}</p>
      )}
      {rulesData && rulesData.rules.length > 0 && (
        <ul>
          {rulesData.rules.map((rule) => (
            <li key={rule.id}>
              <strong>{rule.description}</strong> — {levelLabels[rule.level] ?? rule.level} (
              {rule.score})
              {rule.tool ? ` · ${rule.tool}` : ''}
              {rule.argsPattern ? ` · /${rule.argsPattern}/` : ''}
              <button
                className="btn secondary"
                data-testid={`risk-rule-remove-${rule.id}`}
                disabled={busy}
                onClick={() => void removeRule(rule.id)}
              >
                {t('settings.risk.ruleRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label htmlFor="risk-rule-description">{t('settings.risk.formDescription')}</label>
        <input
          id="risk-rule-description"
          value={ruleDescription}
          placeholder={t('settings.risk.formDescriptionPlaceholder')}
          onChange={(e) => setRuleDescription(e.target.value)}
        />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="risk-rule-level">{t('settings.risk.formLevel')}</label>
          <select
            id="risk-rule-level"
            value={ruleLevel}
            onChange={(e) => setRuleLevel(e.target.value as 'low' | 'medium' | 'high')}
          >
            <option value="low">{t('risk.low')}</option>
            <option value="medium">{t('risk.medium')}</option>
            <option value="high">{t('risk.high')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="risk-rule-score">{t('settings.risk.formScore')}</label>
          <input
            id="risk-rule-score"
            type="number"
            min={0}
            max={100}
            value={ruleScore}
            onChange={(e) => setRuleScore(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="risk-rule-tool">{t('settings.risk.formTool')}</label>
        <input
          id="risk-rule-tool"
          value={ruleTool}
          placeholder={t('settings.risk.formToolPlaceholder')}
          onChange={(e) => setRuleTool(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="risk-rule-args-pattern">{t('settings.risk.formArgsPattern')}</label>
        <input
          id="risk-rule-args-pattern"
          value={ruleArgsPattern}
          placeholder={t('settings.risk.formArgsPatternPlaceholder')}
          onChange={(e) => setRuleArgsPattern(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="btn" data-testid="risk-rule-add" disabled={busy} onClick={() => void addRule()}>
          {t('settings.risk.formAdd')}
        </button>
        <button className="btn secondary" data-testid="risk-refresh" disabled={busy} onClick={() => void load()}>
          {t('settings.risk.refresh')}
        </button>
      </div>

      {/* Built-in rules: read-only table, each can be disabled. */}
      <h4>{t('settings.risk.builtinTitle')}</h4>
      <p className="hint">{t('settings.risk.builtinHint')}</p>
      {builtinRules.length > 0 && (
        <ul>
          {builtinRules.map((rule) => (
            <li key={rule.id}>
              <strong>{rule.description}</strong> — {levelLabels[rule.level] ?? rule.level} (
              {rule.score})
              <button
                className="btn secondary"
                data-testid={`risk-builtin-toggle-${rule.id}`}
                disabled={busy}
                onClick={() => void toggleBuiltinRule(rule.id, !rule.enabled)}
              >
                {rule.enabled
                  ? t('settings.risk.builtinDisable')
                  : t('settings.risk.builtinEnable')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Allowlist / denylist: entries are `tool` or `tool:regex`. */}
      <h4>{t('settings.risk.allowTitle')}</h4>
      <p className="hint">{t('settings.risk.allowHint')}</p>
      {rulesData && rulesData.allowlist.length === 0 && (
        <p className="hint">{t('settings.risk.allowEmpty')}</p>
      )}
      {rulesData && rulesData.allowlist.length > 0 && (
        <ul>
          {rulesData.allowlist.map((entry) => (
            <li key={entry}>
              {entry}
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => void setListEntry('allow', 'remove', entry)}
              >
                {t('settings.risk.entryRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          value={allowDraft}
          placeholder={t('settings.risk.entryPlaceholder')}
          onChange={(e) => setAllowDraft(e.target.value)}
        />
        <button
          className="btn secondary"
          data-testid="risk-allow-add"
          disabled={busy}
          onClick={() => void setListEntry('allow', 'add', allowDraft)}
        >
          {t('settings.risk.entryAdd')}
        </button>
      </div>

      <h4>{t('settings.risk.denyTitle')}</h4>
      <p className="hint">{t('settings.risk.denyHint')}</p>
      {rulesData && rulesData.denylist.length === 0 && (
        <p className="hint">{t('settings.risk.denyEmpty')}</p>
      )}
      {rulesData && rulesData.denylist.length > 0 && (
        <ul>
          {rulesData.denylist.map((entry) => (
            <li key={entry}>
              {entry}
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => void setListEntry('deny', 'remove', entry)}
              >
                {t('settings.risk.entryRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          value={denyDraft}
          placeholder={t('settings.risk.entryPlaceholder')}
          onChange={(e) => setDenyDraft(e.target.value)}
        />
        <button
          className="btn secondary"
          data-testid="risk-deny-add"
          disabled={busy}
          onClick={() => void setListEntry('deny', 'add', denyDraft)}
        >
          {t('settings.risk.entryAdd')}
        </button>
      </div>

      {/* Pending confirmations: read-only here — approve in Chat. */}
      <h4>{t('settings.risk.pendingTitle')}</h4>
      <p className="hint">{t('settings.risk.pendingHint')}</p>
      {pending.length === 0 && <p className="hint">{t('settings.risk.pendingEmpty')}</p>}
      {pending.length > 0 && (
        <ul>
          {pending.map((c) => (
            <li key={c.id}>
              {c.toolName} — {levelLabels[c.riskLevel] ?? c.riskLevel} · {c.botId} ·{' '}
              {new Date(c.createdAtMs).toLocaleString()}
            </li>
          ))}
        </ul>
      )}

      {/* Audit: last 10 decisions, newest first. */}
      <h4>{t('settings.risk.auditTitle')}</h4>
      {audit.length === 0 && <p className="hint">{t('settings.risk.auditEmpty')}</p>}
      {audit.length > 0 && (
        <ul>
          {audit.map((a) => (
            <li key={a.confirmationId}>
              {a.toolName} — {auditStatusLabels[a.status] ?? a.status} ·{' '}
              {levelLabels[a.riskLevel] ?? a.riskLevel} ({a.riskScore}) · {a.botId} ·{' '}
              {new Date(a.atMs).toLocaleString()}
            </li>
          ))}
        </ul>
      )}

      {/* Budget history: last 10 finished conversations, newest first. */}
      <h4>{t('settings.risk.budgetTitle')}</h4>
      <p className="hint">{t('settings.risk.budgetHint')}</p>
      {budget.length === 0 && <p className="hint">{t('settings.risk.budgetEmpty')}</p>}
      {budget.length > 0 && (
        <ul>
          {budget.map((b) => (
            <li key={b.conversationId}>
              {b.botId} · {b.totalTokens.toLocaleString()} tokens · {formatCost(b.costUsd)} ·{' '}
              {b.status} · {shortId(b.conversationId)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
