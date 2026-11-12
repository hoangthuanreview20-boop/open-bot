import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

interface SkillRow {
  name: string;
  description: string;
  version: string;
  whenToUse: string;
  tools: string[];
  source: string;
  pluginId: string | null;
  enabled: boolean;
}

export default function SkillsView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // v0.66b: the skill whose full SKILL.md is open + the loaded content.
  const [viewing, setViewing] = useState('');
  const [viewContent, setViewContent] = useState('');
  const [viewLoading, setViewLoading] = useState(false);
  // v0.66b: form to install a new skill from pasted text.
  const [installName, setInstallName] = useState('');
  const [installContent, setInstallContent] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [installSuccess, setInstallSuccess] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setSkills(await window.openBot.listSkills());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.loadError'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (name: string, enabled: boolean) => {
    try {
      await window.openBot.toggleSkill(name, enabled);
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.toggleError'));
    }
  };

  // Reload from disk, then refresh the list. A reload error count is shown
  // after the refresh because load() clears the error on success.
  const reload = async () => {
    try {
      const res = await window.openBot.reloadSkills();
      await load();
      if (res.errors.length > 0) {
        setError(t('skills.reloadErrors', { count: String(res.errors.length) }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.loadError'));
    }
  };

  // v0.66b: open/close the panel showing one skill's full SKILL.md.
  // The content loads on demand (not preloaded for every listed skill).
  const viewSkill = async (name: string) => {
    if (viewing === name) {
      setViewing('');
      setViewContent('');
      return;
    }
    setViewing(name);
    setViewContent('');
    setViewLoading(true);
    try {
      const res = await window.openBot.readSkill(name);
      setViewContent(res.content);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.readError'));
      setViewing('');
    } finally {
      setViewLoading(false);
    }
  };

  // v0.66b: install a new skill from text the user pasted. Main + core
  // validate (name, frontmatter, builtin clash, secret) before writing
  // the file; any error is shown, nothing is half-written.
  const install = async () => {
    setInstallError('');
    setInstallSuccess('');
    setInstalling(true);
    try {
      const installed = await window.openBot.installSkill(installName.trim(), installContent);
      setInstallSuccess(t('skills.installSuccess', { name: installed.name }));
      setInstallName('');
      setInstallContent('');
      setViewing('');
      setViewContent('');
      await load();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : t('skills.installError'));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('skills.back')}</button>
      <h2>{t('skills.title')}</h2>
      <p>{t('skills.intro')}</p>
      {loading && <p data-testid="skills-loading">{t('skills.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {skills.map((s) => (
        <section key={s.name} className="card">
          <h3>{s.name} <span className="badge">v{s.version}</span> {s.source === 'builtin' && <span>{t('skills.builtin')}</span>}</h3>
          <p>{s.description}</p>
          {s.whenToUse && <p><em>{t('skills.whenToUse')}: {s.whenToUse}</em></p>}
          {s.tools.length > 0 && <p>{t('skills.tools')}: {s.tools.join(', ')}</p>}
          {s.pluginId && <p>{t('skills.fromPlugin')}: {s.pluginId}</p>}
          <label>
            <input type="checkbox" checked={s.enabled} onChange={(e) => void toggle(s.name, e.target.checked)} />
            {t('skills.enabled')}
          </label>
          <button
            className="btn secondary"
            data-testid={`skill-view-${s.name}`}
            onClick={() => void viewSkill(s.name)}
          >
            {viewing === s.name ? t('skills.hideContent') : t('skills.viewContent')}
          </button>
          {viewing === s.name && (
            <div>
              {viewLoading && <p>{t('skills.contentLoading')}</p>}
              {!viewLoading && viewContent && (
                <pre
                  data-testid="skill-content"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto' }}
                >
                  {viewContent}
                </pre>
              )}
              {!viewLoading && viewContent && (
                <button className="btn secondary" onClick={() => { setViewing(''); setViewContent(''); }}>
                  {t('skills.close')}
                </button>
              )}
            </div>
          )}
        </section>
      ))}
      {/* v0.68c: the empty line used to show next to the load error
          (both render when the list is empty) — it now waits for a
          finished load without an error. The Reload button below
          already doubles as the retry after a load error. */}
      {skills.length === 0 && !loading && !error && <p>{t('skills.empty')}</p>}
      <button className="btn secondary" onClick={() => void reload()}>{t('skills.reload')}</button>
      <section className="card">
        <h3>{t('skills.installTitle')}</h3>
        <p>{t('skills.installIntro')}</p>
        {installError && <p className="error">{installError}</p>}
        {installSuccess && <p>{installSuccess}</p>}
        <label>
          {t('skills.installName')}
          <input
            id="skill-install-name"
            type="text"
            value={installName}
            placeholder={t('skills.installNamePlaceholder')}
            onChange={(e) => setInstallName(e.target.value)}
          />
        </label>
        <label>
          {t('skills.installContent')}
          <textarea
            id="skill-install-content"
            value={installContent}
            placeholder={t('skills.installContentPlaceholder')}
            rows={12}
            onChange={(e) => setInstallContent(e.target.value)}
          />
        </label>
        <button
          className="btn"
          data-testid="skill-install"
          disabled={installing || installName.trim() === '' || installContent.trim() === ''}
          onClick={() => void install()}
        >
          {installing ? t('skills.installing') : t('skills.installButton')}
        </button>
      </section>
    </div>
  );
}
