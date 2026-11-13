/**
 * MediaKeysSection (v0.95, Team D2) — the Media keys panel in
 * Settings (bot-model tab, after the provider cards).
 *
 * Self-contained: it loads its own status over IPC
 * (`media:get-status` / `media:set-key` / `media:clear-key`, see
 * apps/desktop/src/main/main.ts) and owns its drafts, so SettingsView
 * needs no new state — the tab only renders this section. The main
 * process never returns a key: status is `{configured, suffix}`
 * per provider, where suffix is the last 4 characters (enough to
 * tell keys apart, never enough to reuse one). Inputs are never
 * prefilled from the Vault and are cleared after a successful save.
 *
 * i18n: all display strings live in locales/*.json under
 * `settings.mediaKeys.*` and are read through useT() — no hard-coded
 * strings in this file. Provider labels/hints are looked up with
 * literal t() calls so the key scan in tests/i18n.test.mjs picks
 * them up.
 */

import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type { MediaKeyStatusView } from '../types';

/** Media providers in render order (mirrors core MEDIA_PROVIDERS). */
export const MEDIA_KEYS_META: Array<{ id: string; kinds: Array<'image' | 'video'> }> = [
  { id: 'openai', kinds: ['image', 'video'] },
  { id: 'gemini', kinds: ['image'] },
  { id: 'stability', kinds: ['image'] },
  { id: 'replicate', kinds: ['image', 'video'] },
  { id: 'runway', kinds: ['video'] },
  { id: 'luma', kinds: ['video'] },
  { id: 'pika', kinds: ['video'] },
];

export default function MediaKeysSection() {
  const t = useT();
  const [status, setStatus] = useState<MediaKeyStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // Provider display names — literal t() calls so the i18n key scan
  // finds them (a dynamic lookup would not be collected).
  const labels: Record<string, string> = {
    openai: t('settings.provider.openai'),
    gemini: t('settings.provider.gemini'),
    stability: t('settings.mediaKeys.provider.stability'),
    replicate: t('settings.mediaKeys.provider.replicate'),
    runway: t('settings.mediaKeys.provider.runway'),
    luma: t('settings.mediaKeys.provider.luma'),
    pika: t('settings.mediaKeys.provider.pika'),
  };
  // Short "where to get a key" hints — literal t() calls, same reason.
  const hints: Record<string, string> = {
    openai: t('settings.mediaKeys.hint.openai'),
    gemini: t('settings.mediaKeys.hint.gemini'),
    stability: t('settings.mediaKeys.hint.stability'),
    replicate: t('settings.mediaKeys.hint.replicate'),
    runway: t('settings.mediaKeys.hint.runway'),
    luma: t('settings.mediaKeys.hint.luma'),
    pika: t('settings.mediaKeys.hint.pika'),
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.openBot.getMediaKeyStatus();
      if (res) setStatus(res);
      else setError(t('settings.mediaKeys.loadError'));
    } catch {
      setError(t('settings.mediaKeys.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async (providerId: string) => {
    const draft = (drafts[providerId] ?? '').trim();
    if (!draft || busy) return;
    setBusy(providerId);
    setError('');
    try {
      const res = await window.openBot.setMediaKey(providerId, draft);
      if (res) {
        setStatus(res);
        setDrafts((prev) => ({ ...prev, [providerId]: '' }));
      } else {
        setError(t('settings.mediaKeys.saveError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.mediaKeys.saveError'));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async (providerId: string) => {
    if (busy) return;
    setBusy(providerId);
    setError('');
    try {
      const res = await window.openBot.clearMediaKey(providerId);
      if (res) {
        setStatus(res);
        setDrafts((prev) => ({ ...prev, [providerId]: '' }));
      } else {
        setError(t('settings.mediaKeys.saveError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.mediaKeys.saveError'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-section="mediaKeys" className="card">
      <h3>{t('settings.mediaKeys.title')}</h3>
      <p className="hint">{t('settings.mediaKeys.intro')}</p>
      {loading && (
        <p className="hint" data-testid="media-keys-loading">
          {t('settings.mediaKeys.loading')}
        </p>
      )}
      {error && (
        <>
          <p className="error">{error}</p>
          <button className="btn secondary" data-testid="media-keys-retry" onClick={() => void load()}>
            {t('settings.retry')}
          </button>
        </>
      )}
      {status &&
        MEDIA_KEYS_META.map((meta) => {
          const entry = status[meta.id];
          const configured = entry?.configured ?? false;
          const suffix = entry?.suffix ?? null;
          const draft = drafts[meta.id] ?? '';
          return (
            <div key={meta.id}>
              <h4>
                {labels[meta.id] ?? meta.id}{' '}
                {meta.kinds.map((kind) => (
                  <span key={kind} className="badge">
                    {kind === 'image'
                      ? t('settings.mediaKeys.kind.image')
                      : t('settings.mediaKeys.kind.video')}
                  </span>
                ))}{' '}
                {configured && <span className="badge done">{t('settings.keySavedBadge')}</span>}
              </h4>
              {configured ? (
                <p data-testid={`media-key-status-${meta.id}`}>
                  {t('settings.mediaKeys.configured', { suffix: suffix ?? '' })}
                </p>
              ) : (
                <p data-testid={`media-key-status-${meta.id}`}>
                  {t('settings.mediaKeys.missing')}
                </p>
              )}
              <p className="hint">{hints[meta.id]}</p>
              <div className="field">
                <label htmlFor={`media-key-${meta.id}`}>{t('settings.apiKeyLabel')}</label>
                <input
                  id={`media-key-${meta.id}`}
                  data-testid={`media-key-input-${meta.id}`}
                  type="password"
                  autoComplete="off"
                  value={draft}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [meta.id]: e.target.value }))}
                  placeholder={
                    configured
                      ? t('settings.keyPlaceholderSaved')
                      : t('settings.keyPlaceholderEmpty')
                  }
                />
              </div>
              <button
                className="btn secondary"
                data-testid={`media-key-save-${meta.id}`}
                disabled={!draft.trim() || busy !== null}
                onClick={() => void saveKey(meta.id)}
              >
                {t('settings.mediaKeys.save')}
              </button>{' '}
              {configured && (
                <button
                  className="btn secondary"
                  data-testid={`media-key-clear-${meta.id}`}
                  disabled={busy !== null}
                  onClick={() => void clearKey(meta.id)}
                >
                  {t('settings.mediaKeys.clear')}
                </button>
              )}
            </div>
          );
        })}
    </section>
  );
}
