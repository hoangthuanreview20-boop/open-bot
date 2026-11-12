/**
 * A2A client view (P1-2, v0.31): enter an external agent URL, read its
 * Agent Card, then save it to the trusted list; send a trial task to a
 * trusted agent.
 *
 * Only the user may trust an agent here (IPC `a2a:trusted-add` reads the
 * card before saving). The bot's `a2a_send` tool can only call agents
 * on this list — the bot cannot add unknown agents by itself.
 */
import { useEffect, useState } from 'react';
import type { A2aSendResultView, TrustedA2aAgentView } from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';

interface Props {
  onBack: () => void;
}

export default function A2aClientView({ onBack }: Props) {
  const t = useT();
  const [agents, setAgents] = useState<TrustedA2aAgentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [trusting, setTrusting] = useState(false);
  // Trial task: selected agent + message + result.
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<A2aSendResultView | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setAgents(await window.openBot.listTrustedA2aAgents());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('a2a.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trust = async () => {
    if (!url.trim() || trusting) return;
    setTrusting(true);
    setError('');
    setNotice('');
    try {
      const added = await window.openBot.addTrustedA2aAgent(url.trim(), token.trim() || undefined);
      setAgents((prev) => [...prev.filter((a) => a.baseUrl !== added.baseUrl), added]);
      setNotice(t('a2a.trustedOk', { name: added.name }));
      setUrl('');
      setToken('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('a2a.loadError'));
    } finally {
      setTrusting(false);
    }
  };

  const remove = (agent: TrustedA2aAgentView) => {
    setPendingConfirm({
      title: t('a2a.title'),
      message: t('a2a.removeConfirm', { name: agent.name }),
      confirmLabel: t('a2a.remove'),
      onConfirm: () => void doRemove(agent),
    });
  };

  const doRemove = async (agent: TrustedA2aAgentView) => {
    setError('');
    setNotice('');
    try {
      setAgents(await window.openBot.removeTrustedA2aAgent(agent.baseUrl));
      if (selectedUrl === agent.baseUrl) {
        setSelectedUrl(null);
        setResult(null);
      }
      setNotice(t('a2a.removedOk', { name: agent.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('a2a.loadError'));
    }
  };

  const sendTest = async () => {
    if (!selectedUrl || !message.trim() || sending) return;
    setSending(true);
    setError('');
    setNotice('');
    setResult(null);
    try {
      setResult(await window.openBot.sendToTrustedA2aAgent(selectedUrl, message.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('a2a.loadError'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="main">
      <button className="btn secondary" onClick={onBack}>{t('a2a.back')}</button>
      <h2>🔗 {t('a2a.title')}</h2>
      <p>{t('a2a.intro')}</p>
      {error && (
        <>
          <p className="error">{error}</p>
          {/* v0.71 (audit): the trusted-agents load had a loading line
              and an error but no retry — leaving the view was the only
              way to reload. */}
          <button className="btn secondary" data-testid="a2a-retry" onClick={() => void load()}>
            {t('a2a.retry')}
          </button>
        </>
      )}
      {notice && <p className="notice ok">{notice}</p>}

      <h3>{t('a2a.trustButton')}</h3>
      <label style={{ display: 'block', marginBottom: 4 }}>{t('a2a.urlLabel')}</label>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t('a2a.urlPlaceholder')}
        style={{ width: '100%', marginBottom: 8 }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void trust();
        }}
      />
      <label style={{ display: 'block', marginBottom: 4 }}>{t('a2a.tokenLabel')}</label>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
        autoComplete="off"
      />
      <button className="btn" onClick={() => void trust()} disabled={trusting || !url.trim()}>
        {trusting ? t('a2a.trusting') : t('a2a.trustButton')}
      </button>

      <h3 style={{ marginTop: 24 }}>{t('a2a.trustedTitle')}</h3>
      {loading ? (
        <p>{t('a2a.loading')}</p>
      ) : agents.length === 0 ? (
        <p>{t('a2a.empty')}</p>
      ) : (
        agents.map((agent) => (
          <div key={agent.baseUrl} className="card" style={{ marginBottom: 12 }}>
            <strong>{agent.name}</strong>{' '}
            <span style={{ color: 'var(--text-dim)' }}>{agent.baseUrl}</span>
            {agent.description && <p>{agent.description}</p>}
            <p style={{ margin: '4px 0' }}>
              {(agent.skills ?? []).length > 0 &&
                t('a2a.skills', { skills: (agent.skills ?? []).map((s) => s.id).join(', ') })}
              {(agent.skills ?? []).length > 0 && agent.streaming ? ' · ' : ''}
              {agent.streaming ? t('a2a.streaming') : ''}
            </p>
            <p style={{ margin: '4px 0', color: 'var(--text-dim)', fontSize: 12 }}>
              {t('a2a.trustedAt', { date: new Date(agent.trustedAt).toLocaleString() })}
            </p>
            <button className="btn secondary" onClick={() => setSelectedUrl(agent.baseUrl)}>
              {t('a2a.sendTitle')}
            </button>{' '}
            <button className="btn secondary" onClick={() => void remove(agent)}>
              {t('a2a.remove')}
            </button>
          </div>
        ))
      )}

      {selectedUrl && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{t('a2a.sendTitle')}</h3>
          <p style={{ color: 'var(--text-dim)' }}>{selectedUrl}</p>
          <label style={{ display: 'block', marginBottom: 4 }}>{t('a2a.messageLabel')}</label>
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('a2a.messagePlaceholder')}
            style={{ width: '100%', marginBottom: 8 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendTest();
            }}
          />
          <button className="btn" onClick={() => void sendTest()} disabled={sending || !message.trim()}>
            {sending ? t('a2a.sending') : t('a2a.sendButton')}
          </button>
          {result && (
            <div style={{ marginTop: 12 }}>
              <p>
                <strong>{t('a2a.resultState', { state: result.state })}</strong>
                {' '}({result.taskId})
              </p>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{result.text || t('a2a.emptyResult')}</pre>
            </div>
          )}
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
