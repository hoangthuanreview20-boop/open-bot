/**
 * Settings tab bar + search box (UI-4, v0.59).
 *
 * Pure render: the active tab and the search query live in
 * `SettingsView` (the parent), so switching tabs cannot lose state.
 * While a query is typed, `SettingsView` shows the matching sections
 * from every tab instead of the active tab.
 */
import { useT } from '../i18n/useT';
import type { SettingsTab, SettingsTabId } from './settings/settingsTabs';

interface Props {
  tabs: SettingsTab[];
  activeTab: SettingsTabId;
  onSelect: (id: SettingsTabId) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

export default function SettingsTabBar({ tabs, activeTab, onSelect, query, onQueryChange }: Props) {
  const t = useT();
  return (
    <div>
      <div className="settings-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-selected={activeTab === tab.id}
            className={`btn secondary settings-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      <div className="field">
        <input
          data-testid="settings-search"
          className="settings-search"
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('settings.searchPlaceholder')}
          aria-label={t('settings.searchPlaceholder')}
        />
      </div>
    </div>
  );
}
