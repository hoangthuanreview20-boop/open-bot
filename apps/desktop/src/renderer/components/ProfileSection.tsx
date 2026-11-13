/**
 * ProfileSection — edit the user profile in Settings (v0.95, Team D4).
 *
 * Personalization profile: display name, how to address the user,
 * interests, habits, other facts about the user. Stored locally in
 * `<userData>/profile.json` via IPC `profile:get` / `profile:update`
 * — no cloud, no sync. The agent uses this profile to address the
 * user and personalize answers (injected into the system prompt every
 * turn — see memory/profile.ts).
 *
 * List fields are textareas, one item per line (easy to type in
 * Vietnamese). Pure render + direct IPC (no SettingsShared — like the
 * other self-managed sections).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type { UserProfileView } from '../types';

function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const item = line.trim();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function joinList(items: string[] | undefined): string {
  return (items ?? []).join('\n');
}

export default function ProfileSection() {
  const t = useT();
  const [profile, setProfile] = useState<UserProfileView | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [addressForm, setAddressForm] = useState('');
  const [interests, setInterests] = useState('');
  const [habits, setHabits] = useState('');
  const [facts, setFacts] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.openBot
      .getUserProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setDisplayName(p?.displayName ?? '');
        setAddressForm(p?.addressForm ?? '');
        setInterests(joinList(p?.interests));
        setHabits(joinList(p?.habits));
        setFacts(joinList(p?.facts));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('profile.loadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const next = await window.openBot.updateUserProfile({
        displayName,
        addressForm,
        interests: parseList(interests),
        habits: parseList(habits),
        facts: parseList(facts),
      });
      setProfile(next);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('profile.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-section="profile" className="card">
      <h3>{t('profile.title')}</h3>
      <p className="hint">{t('profile.intro')}</p>
      <p className="hint">{t('profile.localOnly')}</p>
      {loading && <p className="hint" data-testid="profile-loading">{t('profile.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {saved && <p className="hint" data-testid="profile-saved">{t('profile.saved')}</p>}
      {!loading && (
        <>
          <label>
            {t('profile.displayName')}
            <input
              type="text"
              value={displayName}
              data-testid="profile-display-name"
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('profile.displayNamePlaceholder')}
              maxLength={200}
            />
          </label>
          <label>
            {t('profile.addressForm')}
            <input
              type="text"
              value={addressForm}
              data-testid="profile-address-form"
              onChange={(e) => setAddressForm(e.target.value)}
              placeholder={t('profile.addressFormPlaceholder')}
              maxLength={200}
            />
          </label>
          <p className="hint">{t('profile.addressFormHint')}</p>
          <label>
            {t('profile.interests')}
            <textarea
              value={interests}
              data-testid="profile-interests"
              onChange={(e) => setInterests(e.target.value)}
              placeholder={t('profile.listPlaceholder')}
              rows={3}
            />
          </label>
          <label>
            {t('profile.habits')}
            <textarea
              value={habits}
              data-testid="profile-habits"
              onChange={(e) => setHabits(e.target.value)}
              placeholder={t('profile.listPlaceholder')}
              rows={3}
            />
          </label>
          <label>
            {t('profile.facts')}
            <textarea
              value={facts}
              data-testid="profile-facts"
              onChange={(e) => setFacts(e.target.value)}
              placeholder={t('profile.listPlaceholder')}
              rows={3}
            />
          </label>
          {profile && (
            <p className="hint" data-testid="profile-user-id">
              {t('profile.userId')}: {profile.userId}
            </p>
          )}
          <div className="row">
            <button className="btn" data-testid="profile-save" onClick={() => void save()} disabled={saving}>
              {saving ? t('profile.saving') : t('profile.save')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
