/**
 * A2A network settings (v0.97, Team T2): loopback-only by default.
 *
 * The user can explicitly allow external A2A agents, but only after
 * acknowledging the warning. The toggle alone is not enough: both
 * flags must be on before the policy allows anything outside
 * loopback. The Local API mount itself stays loopback-bound; the
 * policy governs push webhooks and client/delegation calls.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

export default function A2aNetworkSettings() {
  const t = useT();
  const [allowExternal, setAllowExternal] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loopbackNote, setLoopbackNote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.openBot
      .getA2aNetworkPolicy()
      .then((policy) => {
        if (cancelled) return;
        setAllowExternal(policy.allowExternal);
        setAcknowledged(policy.warningAcknowledged);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t('a2a.v097.networkLoadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Load once when the section mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await window.openBot.setA2aNetworkPolicy({
        allowExternal,
        warningAcknowledged: acknowledged,
      });
      setLoopbackNote(res.localApiStillLoopback);
      setNotice(t('a2a.v097.networkSaved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('a2a.v097.networkLoadError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>{t('a2a.loading')}</p>;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h3>{t('a2a.v097.networkTitle')}</h3>
      <p style={{ color: 'var(--text-dim)' }}>{t('a2a.v097.networkIntro')}</p>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={allowExternal}
          onChange={(e) => {
            setAllowExternal(e.target.checked);
            if (!e.target.checked) setAcknowledged(false);
          }}
        />{' '}
        {t('a2a.v097.networkAllowExternal')}
      </label>
      {allowExternal && (
        <>
          <p className="error">{t('a2a.v097.networkWarning')}</p>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />{' '}
            {t('a2a.v097.networkAcknowledge')}
          </label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {loopbackNote && <p style={{ color: 'var(--text-dim)' }}>{t('a2a.v097.networkLoopbackNote')}</p>}
      <button className="btn" onClick={() => void save()} disabled={saving || (allowExternal && !acknowledged)}>
        {saving ? t('a2a.v097.networkSaving') : t('a2a.v097.networkSave')}
      </button>
    </div>
  );
}
