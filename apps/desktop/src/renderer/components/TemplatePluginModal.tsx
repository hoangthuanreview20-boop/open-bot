import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';

/**
 * Template plugin modal (v0.14).
 *
 * A plugin template is a shareable recipe for a plugin (see
 * packages/core/src/plugins/templates.ts): manifest + default config.
 * From here the user can pick an existing template, edit its fields and
 * save it as a new template, install a plugin from it, export it as a
 * JSON file to share with someone else, or import a template JSON file
 * they received. Every template call runs in the main process through
 * the preload bridge — the renderer never touches the core module.
 *
 * v0.70: first-load state for the template list — a loading line while
 * the first `listPluginTemplates` call is in flight, and a load error
 * with a retry button (same first-load pattern as `useConnectedApps`
 * v0.67b / Settings v0.68c/v0.69c: a `*LoadedOnce` ref, `finally`
 * always clears loading, a failed first load leaves the ref unset so
 * a retry shows loading again, and refreshes after a successful first
 * load never flash loading over data already on screen). The load
 * error lives in its own `loadError` state so the retry button only
 * ever re-runs the template load, never a save/apply/import error
 * (those still use the shared `error` line, unchanged).
 */

interface PluginTemplateView {
  id: string;
  name: string;
  description: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    permissions: string[];
    main: string;
    tools?: string[];
  };
  config: Record<string, unknown>;
  createdAt: string;
}

const PERMISSION_OPTIONS: Array<{ id: string; labelKey: string }> = [
  { id: 'fs', labelKey: 'pluginTemplate.permission.fs' },
  { id: 'shell', labelKey: 'pluginTemplate.permission.shell' },
  { id: 'network', labelKey: 'pluginTemplate.permission.network' },
  { id: 'mcp', labelKey: 'pluginTemplate.permission.mcp' },
];

const ALL_PERMISSIONS = ['fs', 'shell', 'network', 'mcp'];

interface Props {
  onClose: () => void;
  /** Called after a plugin was installed from a template (refresh the plugin list). */
  onInstalled: () => void;
}

export default function TemplatePluginModal({ onClose, onInstalled }: Props) {
  const t = useT();
  const [templates, setTemplates] = useState<PluginTemplateView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formVersion, setFormVersion] = useState('1.0.0');
  const [formAuthor, setFormAuthor] = useState('');
  const [formMain, setFormMain] = useState('index.js');
  const [formTools, setFormTools] = useState('');
  const [formPermissions, setFormPermissions] = useState<string[]>([]);
  const [formEntrySource, setFormEntrySource] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // v0.70: first-load state for the template list (see header comment).
  // `loadError` is separate from `error` so the retry button below
  // only ever re-runs the template load.
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const templatesLoadedOnce = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadTemplates = async () => {
    const showLoading = !templatesLoadedOnce.current;
    if (showLoading) {
      setTemplatesLoading(true);
      setLoadError('');
    }
    try {
      const list = await window.openBot.listPluginTemplates();
      setTemplates(list);
      setLoadError('');
      templatesLoadedOnce.current = true;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('pluginTemplate.loadError'));
    } finally {
      if (showLoading) setTemplatesLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null;

  /** Fill the create form from a template (or clear it for a blank one). */
  const fillForm = (tpl: PluginTemplateView | null) => {
    setFormId(tpl?.id ?? '');
    setFormName(tpl?.name ?? '');
    setFormDescription(tpl?.description ?? '');
    setFormVersion(tpl?.manifest.version ?? '1.0.0');
    setFormAuthor(tpl?.manifest.author ?? '');
    setFormMain(tpl?.manifest.main ?? 'index.js');
    setFormTools((tpl?.manifest.tools ?? []).join(', '));
    setFormPermissions(tpl ? [...tpl.manifest.permissions] : []);
    const entrySource = tpl?.config?.['entrySource'];
    setFormEntrySource(typeof entrySource === 'string' ? entrySource : '');
  };

  const selectTemplate = (id: string) => {
    setSelectedId(id);
    setMessage('');
    setError('');
    fillForm(templates.find((tpl) => tpl.id === id) ?? null);
  };

  const togglePermission = (permission: string) => {
    setFormPermissions((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
  };

  const saveTemplate = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const tools = formTools
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const saved = await window.openBot.createPluginTemplate({
        id: formId.trim(),
        name: formName.trim(),
        description: formDescription.trim(),
        manifest: {
          id: formId.trim(),
          name: formName.trim(),
          version: formVersion.trim(),
          description: formDescription.trim(),
          author: formAuthor.trim() || undefined,
          permissions: formPermissions.filter((p) => ALL_PERMISSIONS.includes(p)) as Array<
            'fs' | 'shell' | 'network' | 'mcp'
          >,
          main: formMain.trim(),
          tools: tools.length > 0 ? tools : undefined,
        },
        config: formEntrySource.trim() ? { entrySource: formEntrySource } : {},
      });
      await loadTemplates();
      setSelectedId(saved.id);
      setMessage(t('pluginTemplate.createOk', { name: saved.name }));
    } catch (e) {
      setError(t('common.error', { message: e instanceof Error ? e.message : t('pluginTemplate.loadError') }));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = async () => {
    if (!selected) {
      setError(t('pluginTemplate.selectFirst'));
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const applied = await window.openBot.applyPluginTemplate({ id: selected.id, overwrite });
      setMessage(
        applied.hasEntry
          ? t('pluginTemplate.applyOk', { name: applied.manifest.name })
          : t('pluginTemplate.applyNoEntry', { name: applied.manifest.name }),
      );
      onInstalled();
    } catch (e) {
      setError(t('common.error', { message: e instanceof Error ? e.message : t('pluginTemplate.loadError') }));
    } finally {
      setBusy(false);
    }
  };

  const exportTemplate = async () => {
    if (!selected) {
      setError(t('pluginTemplate.selectFirst'));
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const { json } = await window.openBot.exportPluginTemplate({ id: selected.id });
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      // Keep the tag name in a variable so the i18n key scan does not
      // mistake the anchor creation for a translation call.
      const tag = 'a';
      const a = document.createElement(tag);
      a.href = url;
      a.download = `${selected.id}.plugin-template.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(t('common.error', { message: e instanceof Error ? e.message : t('pluginTemplate.loadError') }));
    } finally {
      setBusy(false);
    }
  };

  const importTemplateFile = async (file: File) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const json = await file.text();
      const imported = await window.openBot.importPluginTemplate({ json });
      await loadTemplates();
      setSelectedId(imported.id);
      fillForm(imported);
      setMessage(t('pluginTemplate.importOk', { name: imported.name }));
    } catch (e) {
      setError(t('common.error', { message: e instanceof Error ? e.message : t('pluginTemplate.loadError') }));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteTemplate = () => {
    if (!selected) {
      setError(t('pluginTemplate.selectFirst'));
      return;
    }
    setPendingConfirm({
      title: t('pluginTemplate.title'),
      message: t('pluginTemplate.deleteConfirm', { name: selected.name }),
      confirmLabel: t('pluginTemplate.deleteButton'),
      onConfirm: () => void doDeleteTemplate(selected),
    });
  };

  const doDeleteTemplate = async (template: PluginTemplateView) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await window.openBot.deletePluginTemplate({ id: template.id });
      setSelectedId('');
      fillForm(null);
      await loadTemplates();
      setMessage(t('pluginTemplate.deleteOk'));
    } catch (e) {
      setError(t('common.error', { message: e instanceof Error ? e.message : t('pluginTemplate.loadError') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{t('pluginTemplate.title')}</h2>
        <p className="hint">{t('pluginTemplate.intro')}</p>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}

        <h3>{t('pluginTemplate.listTitle')}</h3>
        {/* v0.70: loading line while the first load is in flight (the
            empty line used to show during the load), a load error with
            a retry that re-runs `loadTemplates`, and the empty line
            only once a load finished with no templates. A load that
            fails after a successful first load keeps the loaded list
            on screen under the error + retry. */}
        {templatesLoading && (
          <p className="hint" data-testid="templates-loading">{t('settings.pluginsLoading')}</p>
        )}
        {loadError && (
          <>
            <p className="error" data-testid="templates-error">{loadError}</p>
            <button
              className="btn secondary"
              data-testid="templates-retry"
              onClick={() => void loadTemplates()}
              disabled={templatesLoading}
            >
              {t('settings.retry')}
            </button>
          </>
        )}
        {!templatesLoading && !loadError && templates.length === 0 && (
          <p>{t('pluginTemplate.empty')}</p>
        )}
        {!templatesLoading && templates.length > 0 && (
          <select value={selectedId} onChange={(e) => selectTemplate(e.target.value)}>
            <option value="">{t('pluginTemplate.selectNone')}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name} ({tpl.id})
              </option>
            ))}
          </select>
        )}
        {selected && (
          <div>
            <p>{selected.description}</p>
            <p className="hint">
              {selected.manifest.version}
              {selected.manifest.author ? ` (${selected.manifest.author})` : ''}
              {` — ${selected.manifest.permissions.join(', ')}`}
            </p>
            <button className="btn secondary" onClick={() => void applyTemplate()} disabled={busy}>
              {t('pluginTemplate.applyButton')}
            </button>{' '}
            <button className="btn secondary" onClick={() => void exportTemplate()} disabled={busy}>
              {t('pluginTemplate.exportButton')}
            </button>{' '}
            <button className="btn secondary" onClick={() => void deleteTemplate()} disabled={busy}>
              {t('pluginTemplate.deleteButton')}
            </button>
            <label style={{ display: 'block', marginTop: 8 }}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              {t('pluginTemplate.overwriteLabel')}
            </label>
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button className="btn secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            {t('pluginTemplate.importButton')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importTemplateFile(file);
            }}
          />
        </div>

        <h3>{t('pluginTemplate.createButton')}</h3>
        <label>
          {t('pluginTemplate.idLabel')}
          <input value={formId} onChange={(e) => setFormId(e.target.value)} placeholder={t('pluginTemplate.idPlaceholder')} />
        </label>
        <label>
          {t('pluginTemplate.nameLabel')}
          <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t('pluginTemplate.namePlaceholder')} />
        </label>
        <label>
          {t('pluginTemplate.descriptionLabel')}
          <input
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder={t('pluginTemplate.descriptionPlaceholder')}
          />
        </label>
        <label>
          {t('pluginTemplate.versionLabel')}
          <input value={formVersion} onChange={(e) => setFormVersion(e.target.value)} />
        </label>
        <label>
          {t('pluginTemplate.authorLabel')}
          <input value={formAuthor} onChange={(e) => setFormAuthor(e.target.value)} />
        </label>
        <label>
          {t('pluginTemplate.mainLabel')}
          <input value={formMain} onChange={(e) => setFormMain(e.target.value)} />
        </label>
        <label>
          {t('pluginTemplate.toolsLabel')}
          <input value={formTools} onChange={(e) => setFormTools(e.target.value)} />
        </label>
        <p className="hint">{t('pluginTemplate.toolsHint')}</p>
        <fieldset>
          <legend>{t('pluginTemplate.permissionsLabel')}</legend>
          {PERMISSION_OPTIONS.map((opt) => (
            <label key={opt.id} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={formPermissions.includes(opt.id)}
                onChange={() => togglePermission(opt.id)}
              />
              {t(opt.labelKey)}
            </label>
          ))}
        </fieldset>
        <label>
          {t('pluginTemplate.entrySourceLabel')}
          <textarea
            value={formEntrySource}
            onChange={(e) => setFormEntrySource(e.target.value)}
            placeholder={t('pluginTemplate.entrySourcePlaceholder')}
            rows={6}
            style={{ width: '100%' }}
          />
        </label>
        <p className="hint">{t('pluginTemplate.entrySourceHint')}</p>
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void saveTemplate()} disabled={busy || !formId.trim() || !formName.trim()}>
            {t('pluginTemplate.createButton')}
          </button>{' '}
          <button className="btn secondary" onClick={onClose}>
            {t('pluginTemplate.close')}
          </button>
        </div>
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
    </div>
  );
}
