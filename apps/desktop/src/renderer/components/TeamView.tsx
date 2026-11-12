import { useEffect, useState } from 'react';
import type { BotConfigLike, ServiceAccountView, TeamBundleView, TeamConfigLike, TeamImportConflictView, TeamImportSummaryView, TeamRoleLike } from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';

/**
 * Call a v0.5 window.openBot method by its IPC channel name, falling back
 * to the camelCase spelling. Returns null when the preload side has not
 * exposed the method yet, so the UI degrades instead of crashing.
 */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

/** Copy text to the clipboard; returns false when the clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the textarea fallback below. */
  }
  try {
    // Keep the tag name in a variable so the i18n key scan does not
    // mistake the fallback element creation for a translation call.
    const tag = 'textarea';
    const el = document.createElement(tag);
    el.value = text;
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** Format an ISO date for display; falls back to the raw value when invalid. */
function formatDate(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString();
}

const SERVICE_ACCOUNT_SCOPES = ['run', 'admin'];

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
}

const USER_ID_RE = /^[A-Za-z0-9_-]+$/;
const ROLES: TeamRoleLike[] = ['admin', 'member', 'viewer'];

/**
 * Team management (v0.3): local team members (team.json) and which bots
 * are shared with the team. There is no central server and no real
 * authentication yet — the UI says so (see `team.localNote`).
 */
export default function TeamView({ bots, onBack }: Props) {
  const t = useT();
  const [team, setTeam] = useState<TeamConfigLike | null>(null);
  const [sharedBotIds, setSharedBotIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<TeamRoleLike>('member');
  const [formError, setFormError] = useState('');
  // v0.5: shared team workspace + service accounts.
  const [workspace, setWorkspace] = useState<{ dir: string; teamId: string } | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [serviceAccounts, setServiceAccounts] = useState<ServiceAccountView[]>([]);
  const [saName, setSaName] = useState('');
  const [saScope, setSaScope] = useState('run');
  const [saFormError, setSaFormError] = useState('');
  /** Vault is in NO_STORAGE mode: service-account tokens are lost on quit. */
  const [noStorage, setNoStorage] = useState(false);
  /** The token of the account just created: shown once, never re-fetched. */
  const [newSaToken, setNewSaToken] = useState<ServiceAccountView | null>(null);
  const [copied, setCopied] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // v0.80: portable team bundle — an import whose file conflicts with
  // local data waits here for the user to choose "only what's new" or
  // "overwrite all" (never overwrites silently).
  const [importPending, setImportPending] = useState<{
    summary: TeamImportSummaryView;
    conflicts: TeamImportConflictView[];
    bundle: TeamBundleView;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [teamConfig, shared] = await Promise.all([
        window.openBot.getTeam(),
        window.openBot.listSharedBots(),
      ]);
      setTeam(teamConfig);
      setSharedBotIds(shared);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setLoading(false);
    }
    // v0.5 extras: each load is independent and best-effort so a missing
    // IPC does not block the rest of the view.
    try {
      const ws = await callOpenBot<{ dir: string; teamId: string }>('team:get-workspace', 'getTeamWorkspace');
      if (ws) {
        setWorkspace(ws);
        setWorkspaceDir(ws.dir);
      }
    } catch {
      /* Workspace IPC not available yet; the section stays empty. */
    }
    try {
      const accounts = await callOpenBot<ServiceAccountView[]>(
        'team:service-accounts-list',
        'listServiceAccounts',
      );
      if (accounts) setServiceAccounts(accounts);
    } catch {
      /* Service-account IPC not available yet; the section stays empty. */
    }
    try {
      const ns = await callOpenBot<{ enabled: boolean }>('vault:get-nostorage', 'getVaultNoStorage');
      if (ns) setNoStorage(ns.enabled);
    } catch {
      /* NO_STORAGE state unavailable; the warning stays hidden. */
    }
  };

  useEffect(() => {
    void load();
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTeam = (next: TeamConfigLike) => {
    setTeam(next);
    setSharedBotIds(next.sharedBots.map((b) => b.botId));
  };

  const addMember = async () => {
    const userId = newUserId.trim();
    const name = newName.trim();
    if (!USER_ID_RE.test(userId)) {
      setFormError(t('team.userIdInvalid'));
      return;
    }
    if (!name) {
      setFormError(t('team.nameRequired'));
      return;
    }
    setFormError('');
    setBusy('add');
    setError('');
    setNotice('');
    try {
      const next = await window.openBot.addTeamMember({ userId, name, role: newRole });
      applyTeam(next);
      setNewUserId('');
      setNewName('');
      setNewRole('member');
      setNotice(t('team.addedOk', { name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setBusy(null);
    }
  };

  const removeMember = (userId: string, name: string) => {
    setPendingConfirm({
      title: t('team.membersTitle'),
      message: t('team.removeConfirm', { name }),
      confirmLabel: t('team.removeButton'),
      onConfirm: () => void doRemoveMember(userId, name),
    });
  };

  const doRemoveMember = async (userId: string, name: string) => {
    setBusy(`remove:${userId}`);
    setError('');
    setNotice('');
    try {
      const next = await window.openBot.removeTeamMember(userId);
      applyTeam(next);
      setNotice(t('team.removedOk', { name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (userId: string, role: TeamRoleLike) => {
    setBusy(`role:${userId}`);
    setError('');
    setNotice('');
    try {
      const next = await window.openBot.setTeamRole(userId, role);
      applyTeam(next);
      setNotice(t('team.roleChangedOk', { name: userId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setBusy(null);
    }
  };

  const share = async (bot: BotConfigLike) => {
    setBusy(`share:${bot.id}`);
    setError('');
    setNotice('');
    try {
      const next = await window.openBot.shareBot(bot.id);
      applyTeam(next);
      setNotice(t('team.sharedOk', { name: bot.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setBusy(null);
    }
  };

  const unshare = async (bot: BotConfigLike) => {
    setBusy(`share:${bot.id}`);
    setError('');
    setNotice('');
    try {
      const next = await window.openBot.unshareBot(bot.id);
      applyTeam(next);
      setNotice(t('team.unsharedOk', { name: bot.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.loadError'));
    } finally {
      setBusy(null);
    }
  };

  // ---- v0.80: portable team bundle (export/import one file) ----

  const doExportTeam = async () => {
    setBusy('portable-export');
    setError('');
    setNotice('');
    try {
      const res = await window.openBot.exportTeam();
      if (res.cancelled) return;
      let msg = t('team.exportSaved', { path: res.path });
      if (res.skippedSkills.length > 0) {
        const parts = res.skippedSkills.map((s) =>
          s.reason === 'oversize'
            ? t('team.exportSkippedOversize', {
                name: s.name,
                chars: String(s.chars),
                max: String(200000),
              })
            : t('team.exportSkippedEmpty', { name: s.name }),
        );
        msg += ` ${parts.join(' ')}`;
      }
      setNotice(msg);
    } catch {
      setError(t('team.exportError'));
    } finally {
      setBusy(null);
    }
  };

  const applyImport = async (bundle: TeamBundleView, overwrite: boolean) => {
    setImportPending(null);
    setBusy('portable-import');
    setError('');
    setNotice('');
    try {
      const res = await window.openBot.importTeamApply({ bundle, overwrite });
      const r = res.report;
      let msg = t('team.importDone', {
        bots: String(r.botsAdded + r.botsReplaced),
        automations: String(r.automationsAdded + r.automationsReplaced),
        skills: String(r.skillsWritten),
      });
      if (res.skipped.length > 0) {
        msg += ` ${t('team.importSkipped', { count: String(res.skipped.length) })}`;
      }
      if (r.webhookDisabled > 0) {
        msg += ` ${t('team.importWebhooksDisabled', { count: String(r.webhookDisabled) })}`;
      }
      if (res.failures.length > 0) {
        setError(res.failures.join('\n'));
      }
      setNotice(msg);
      await load();
    } catch (e) {
      setError(t('team.importError', { error: e instanceof Error ? e.message : t('team.loadError') }));
    } finally {
      setBusy(null);
    }
  };

  const doImportTeam = async () => {
    setBusy('portable-import');
    setError('');
    setNotice('');
    try {
      const res = await window.openBot.importTeam();
      if (res.cancelled) return;
      if (res.conflicts.length === 0) {
        await applyImport(res.bundle, false);
      } else {
        // Conflicts: wait for the user to choose — never overwrite silently.
        setImportPending({ summary: res.summary, conflicts: res.conflicts, bundle: res.bundle });
      }
    } catch (e) {
      setError(t('team.importError', { error: e instanceof Error ? e.message : t('team.loadError') }));
    } finally {
      setBusy(null);
    }
  };

  // ---- v0.5: shared workspace + service accounts ----

  const copyAndMark = async (text: string, flag: string) => {
    if (await copyText(text)) {
      setCopied(flag);
      window.setTimeout(() => setCopied((prev) => (prev === flag ? '' : prev)), 2000);
    }
  };

  const saveWorkspace = async () => {
    const dir = workspaceDir.trim();
    if (!dir) return;
    setBusy('workspace');
    setError('');
    setNotice('');
    try {
      const next = await callOpenBot<{ dir: string; teamId: string }>(
        'team:set-workspace-dir',
        'setTeamWorkspaceDir',
        dir,
      );
      if (next) {
        setWorkspace(next);
        setWorkspaceDir(next.dir);
        setNotice(t('team.workspaceSaved'));
      } else {
        setError(t('team.workspaceSaveError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.workspaceSaveError'));
    } finally {
      setBusy(null);
    }
  };

  const createServiceAccount = async () => {
    const name = saName.trim();
    if (!name) {
      setSaFormError(t('team.serviceAccountNameRequired'));
      return;
    }
    setSaFormError('');
    setBusy('sa-create');
    setError('');
    setNotice('');
    try {
      const created = await callOpenBot<ServiceAccountView>(
        'team:service-account-create',
        'createServiceAccount',
        { name, scope: saScope },
      );
      if (!created) {
        setError(t('team.serviceAccountCreateError'));
        return;
      }
      setServiceAccounts((prev) => [...prev, created]);
      // Keep the returned token in state only: it is shown once below and
      // never fetched again or logged anywhere.
      setNewSaToken(created);
      setSaName('');
      setSaScope('run');
      setNotice(t('team.serviceAccountCreatedOk', { name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.serviceAccountCreateError'));
    } finally {
      setBusy(null);
    }
  };

  const deleteServiceAccount = (account: ServiceAccountView) => {
    setPendingConfirm({
      title: t('team.serviceAccountTitle'),
      message: t('team.serviceAccountDeleteConfirm', { name: account.name }),
      confirmLabel: t('team.serviceAccountDelete'),
      onConfirm: () => void doDeleteServiceAccount(account),
    });
  };

  const doDeleteServiceAccount = async (account: ServiceAccountView) => {
    setBusy(`sa-delete:${account.id}`);
    setError('');
    setNotice('');
    try {
      const ok = await callOpenBot<boolean>(
        'team:service-account-delete',
        'deleteServiceAccount',
        account.id,
      );
      if (ok !== false) {
        setServiceAccounts((prev) => prev.filter((a) => a.id !== account.id));
        if (newSaToken?.id === account.id) setNewSaToken(null);
        setNotice(t('team.serviceAccountDeletedOk', { name: account.name }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.serviceAccountCreateError'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="panel">
        <p>{t('team.loading')}</p>
      </div>
    );
  }

  const members = team?.members ?? [];
  const sharedByFor = (botId: string) =>
    team?.sharedBots.find((b) => b.botId === botId)?.sharedBy;

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('team.back')}</button>
      <h2>{t('team.title')}</h2>
      <p className="hint">{t('team.localNote')}</p>
      {error && (
        <>
          <p className="error">{error}</p>
          {/* v0.71 (audit): the team load had a loading line and an
              error but no retry — leaving the view was the only way to
              reload. */}
          <button className="btn secondary" data-testid="team-retry" onClick={() => void load()}>
            {t('team.retry')}
          </button>
        </>
      )}
      {notice && <p className="success">{notice}</p>}

      <section className="card">
        <h3>{t('team.workspaceTitle')}</h3>
        <p className="hint">{t('team.workspaceIntro')}</p>
        {workspace && (
          <div className="field">
            <label>{t('team.workspaceTeamIdLabel')}</label>
            <div className="row">
              <input readOnly value={workspace.teamId} />
              <button className="btn secondary" onClick={() => void copyAndMark(workspace.teamId, 'team-id')}>
                {copied === 'team-id' ? t('team.copied') : t('team.workspaceCopy')}
              </button>
            </div>
          </div>
        )}
        <div className="field">
          <label>{t('team.workspaceDirLabel')}</label>
          <input
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            placeholder={t('team.workspaceDirPlaceholder')}
          />
        </div>
        <button className="btn" disabled={busy === 'workspace' || !workspaceDir.trim()} onClick={() => void saveWorkspace()}>
          {t('team.workspaceSave')}
        </button>
      </section>

      {/* v0.80: portable team bundle — export the team to one file, or
          import a team from one file (validated + checksum-checked). */}
      <section className="card">
        <h3>{t('team.portableTitle')}</h3>
        <p className="hint">{t('team.portableHint')}</p>
        <div className="row wrap">
          <button
            className="btn"
            data-testid="team-export"
            disabled={busy === 'portable-export'}
            onClick={() => void doExportTeam()}
          >
            {t('team.exportTeam')}
          </button>
          <button
            className="btn secondary"
            data-testid="team-import"
            disabled={busy === 'portable-import'}
            onClick={() => void doImportTeam()}
          >
            {t('team.importTeam')}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>{t('team.serviceAccountTitle')}</h3>
        <p className="hint">{t('team.serviceAccountIntro')}</p>
        {noStorage && <p className="error">{t('team.serviceAccountNoStorageWarning')}</p>}
        {serviceAccounts.length === 0 && <p className="empty">{t('team.serviceAccountEmpty')}</p>}
        {serviceAccounts.map((account) => (
          <div key={account.id} className="card">
            <h3>{account.name}</h3>
            <p className="hint">
              {account.scope === 'admin' ? t('team.serviceAccountScopeAdmin') : t('team.serviceAccountScopeRun')}
              {' · '}
              {t('team.serviceAccountCreatedAt', { date: formatDate(account.createdAt) })}
            </p>
            <button
              className="btn secondary"
              disabled={busy === `sa-delete:${account.id}`}
              onClick={() => void deleteServiceAccount(account)}
            >
              {t('team.serviceAccountDelete')}
            </button>
          </div>
        ))}
        {newSaToken?.token && (
          <div className="card">
            <h3>{t('team.serviceAccountTokenTitle')}</h3>
            <p className="hint">{t('team.serviceAccountTokenWarning')}</p>
            <div className="row">
              <input type="password" readOnly value={newSaToken.token} autoComplete="off" />
              <button
                className="btn secondary"
                onClick={() => void copyAndMark(newSaToken.token as string, 'sa-token')}
              >
                {copied === 'sa-token' ? t('team.copied') : t('team.serviceAccountCopyToken')}
              </button>
            </div>
          </div>
        )}
        <div className="field">
          <label>{t('team.serviceAccountNameLabel')}</label>
          <input
            value={saName}
            onChange={(e) => setSaName(e.target.value)}
            placeholder={t('team.serviceAccountNamePlaceholder')}
          />
        </div>
        <div className="field">
          <label>{t('team.serviceAccountScopeLabel')}</label>
          <select value={saScope} onChange={(e) => setSaScope(e.target.value)}>
            {SERVICE_ACCOUNT_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope === 'admin' ? t('team.serviceAccountScopeAdmin') : t('team.serviceAccountScopeRun')}
              </option>
            ))}
          </select>
        </div>
        {saFormError && <p className="error">{saFormError}</p>}
        <button className="btn" disabled={busy === 'sa-create'} onClick={() => void createServiceAccount()}>
          {t('team.serviceAccountCreate')}
        </button>
      </section>

      <section className="card">
        <h3>{t('team.membersTitle')}</h3>
        {members.length === 0 && <p className="empty">{t('team.emptyMembers')}</p>}
        {members.map((member) => (
          <div key={member.userId} className="card">
            <h3>
              {member.name}{' '}
              <span className="badge">{t(`team.role.${member.role}`)}</span>
            </h3>
            <p className="hint">{member.userId}</p>
            <div className="row wrap">
              <select
                value={member.role}
                disabled={busy === `role:${member.userId}`}
                onChange={(e) => void changeRole(member.userId, e.target.value as TeamRoleLike)}
                aria-label={t('team.roleLabel')}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>{t(`team.role.${role}`)}</option>
                ))}
              </select>
              <button
                className="btn secondary"
                disabled={busy === `remove:${member.userId}`}
                onClick={() => void removeMember(member.userId, member.name)}
              >
                {t('team.removeButton')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>{t('team.addTitle')}</h3>
        <div className="field">
          <label>{t('team.userIdLabel')}</label>
          <input
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            placeholder={t('team.userIdPlaceholder')}
          />
        </div>
        <div className="field">
          <label>{t('team.nameLabel')}</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('team.namePlaceholder')}
          />
        </div>
        <div className="field">
          <label>{t('team.roleLabel')}</label>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as TeamRoleLike)}>
            {ROLES.map((role) => (
              <option key={role} value={role}>{t(`team.role.${role}`)}</option>
            ))}
          </select>
        </div>
        {formError && <p className="error">{formError}</p>}
        <button className="btn" disabled={busy === 'add'} onClick={() => void addMember()}>
          {t('team.addButton')}
        </button>
      </section>

      <section className="card">
        <h3>{t('team.botsTitle')}</h3>
        {bots.length === 0 && <p className="empty">{t('team.emptyBots')}</p>}
        {bots.map((bot) => {
          const shared = sharedBotIds.includes(bot.id);
          const sharedBy = sharedByFor(bot.id);
          return (
            <div key={bot.id} className="card">
              <h3>
                {bot.name}{' '}
                {shared ? (
                  <span className="badge done">{t('team.shared')}</span>
                ) : (
                  <span className="badge">{t('team.notShared')}</span>
                )}
              </h3>
              <p className="hint">{bot.providerId} · {bot.model || '—'}</p>
              {shared && sharedBy && (
                <p className="hint">{t('team.sharedBy', { name: sharedBy })}</p>
              )}
              <div className="row">
                {shared ? (
                  <button
                    className="btn secondary"
                    disabled={busy === `share:${bot.id}`}
                    onClick={() => void unshare(bot)}
                  >
                    {t('team.unshare')}
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={busy === `share:${bot.id}`}
                    onClick={() => void share(bot)}
                  >
                    {t('team.share')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
      {importPending && (
        <div className="modal-backdrop" onClick={() => setImportPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('team.importConflictsTitle')}</h2>
            <p>
              {t('team.importSummary', {
                name: importPending.summary.teamName,
                bots: String(importPending.summary.bots),
                automations: String(importPending.summary.automations),
                skills: String(importPending.summary.skills),
              })}
            </p>
            <ul style={{ fontSize: 13, paddingLeft: 20 }}>
              {importPending.conflicts.map((c, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{c.detail}</li>
              ))}
            </ul>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn secondary" onClick={() => setImportPending(null)}>
                {t('botForm.cancel')}
              </button>
              <button
                className="btn"
                data-testid="team-import-keep"
                onClick={() => void applyImport(importPending.bundle, false)}
              >
                {t('team.importKeepExisting')}
              </button>
              <button
                className="btn danger"
                data-testid="team-import-overwrite"
                onClick={() => void applyImport(importPending.bundle, true)}
              >
                {t('team.importOverwrite')}
              </button>
            </div>
          </div>
        </div>
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
