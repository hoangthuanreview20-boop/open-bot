/**
 * Settings tabs + search index (UI-4, v0.59).
 *
 * Pure data — no React, no IPC. `SettingsView` renders one tab at a time
 * (each tab scrolls on its own); the search box filters sections across
 * all tabs. Nothing here changes behaviour: it only maps the sections
 * that already existed in `SettingsView` onto tabs.
 *
 * Section inventory (before UI-4, `SettingsView.tsx` 2.422 lines):
 * 19 section groups + 6 provider cards + 1 nested Composio section =
 * 25 `<section>` elements. After UI-4 the same 25 exist, plus the
 * v0.59 1Password section (26 total), split as 24 in Settings
 * (19 groups, providers = 6 cards) + 2 in `ConnectedAppsView`
 * (apps + Composio). See `docs/settings-tabs-ui4.md`
 * and `tests/settings-ui4.test.mjs` for the before/after count.
 */

export type SettingsTabId = 'general' | 'bot-model' | 'connections' | 'security' | 'advanced';

/** One section group in Settings. `providers` = the 6 provider key cards. */
export type SettingsSectionId =
  | 'smallModelGuard'
  | 'autoApprove'
  | 'usage'
  | 'language'
  | 'appearance'
  | 'auth'
  | 'connectors'
  | 'apps'
  | 'update'
  | 'vault'
  | 'dream'
  | 'perf'
  | 'models'
  | 'plugins'
  | 'hooks'
  | 'api'
  | 'engines'
  | 'providers'
  | 'mediaKeys'
  | 'limits'
  | 'usageReset'
  | 'onePassword'
  | 'crashReports'
  | 'notifications'
  | 'profile';

export interface SettingsTab {
  id: SettingsTabId;
  /** i18n key for the tab label (added in UI-4, vi/en). */
  labelKey: string;
  /** Sections in this tab, in the order they had in the old long page. */
  sections: SettingsSectionId[];
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    id: 'general',
    labelKey: 'settings.tab.general',
    sections: ['profile', 'usage', 'language', 'notifications', 'appearance', 'update', 'limits', 'usageReset'],
  },
  {
    id: 'bot-model',
    labelKey: 'settings.tab.botModel',
    sections: ['smallModelGuard', 'autoApprove', 'models', 'engines', 'providers', 'mediaKeys'],
  },
  {
    id: 'connections',
    labelKey: 'settings.tab.connections',
    // `apps` no longer renders inside Settings: the Connections tab shows
    // a link card that opens the standalone Connected apps view instead.
    sections: ['connectors', 'apps'],
  },
  {
    id: 'security',
    labelKey: 'settings.tab.security',
    sections: ['auth', 'vault', 'onePassword', 'crashReports'],
  },
  {
    id: 'advanced',
    labelKey: 'settings.tab.advanced',
    sections: ['dream', 'perf', 'plugins', 'hooks', 'api'],
  },
];

/** Which tab a section lives in (every section in exactly one tab). */
export const SECTION_TAB: Record<SettingsSectionId, SettingsTabId> = (() => {
  const out = {} as Record<SettingsSectionId, SettingsTabId>;
  for (const tab of SETTINGS_TABS) {
    for (const section of tab.sections) out[section] = tab.id;
  }
  return out;
})();

/** All section ids, in tab order. */
export const SETTINGS_SECTIONS: SettingsSectionId[] = SETTINGS_TABS.flatMap((t) => t.sections);

/**
 * Search keywords per section (vi + en, lowercase). Matching strips
 * diacritics, so "bao mat" finds "bảo mật" and "vault" finds the Vault
 * section. Keywords are search data, not display strings, so they live
 * here instead of the locale files.
 */
export const SECTION_KEYWORDS: Record<SettingsSectionId, string[]> = {
  smallModelGuard: ['small model guard', 'guard', 'mô hình nhỏ', 'model nhỏ', 'bot'],
  autoApprove: ['auto-approve', 'auto approve', 'tự động duyệt', 'duyệt', 'rule', 'quy tắc', 'allow always'],
  usage: ['usage', 'sử dụng', 'chi phí', 'cost', 'token', 'tokens'],
  language: ['language', 'ngôn ngữ', 'locale', 'tiếng việt', 'english'],
  appearance: ['theme', 'giao diện', 'dark', 'light', 'sáng', 'tối', 'màu', 'appearance', 'chủ đề'],
  auth: ['auth', 'tài khoản', 'account', 'profile', 'hồ sơ', 'đăng nhập', 'login', 'oauth', 'sign in'],
  connectors: ['connector', 'kết nối', 'slack', 'gmail', 'teams', 'oauth'],
  apps: ['connected apps', 'app đã kết nối', 'app', 'apps', 'composio', 'gmail', 'slack', 'notion', 'github'],
  update: ['update', 'cập nhật', 'version', 'phiên bản', 'track', 'stable', 'nightly'],
  vault: ['vault', 'khóa', 'secret', 'bí mật', 'no_storage', 'no-storage', 'không lưu', 'bảo mật'],
  dream: ['dream', 'mơ', 'idle', 'tự động chạy', 'automation'],
  perf: ['performance', 'hiệu năng', 'cache', 'worker', 'bộ nhớ đệm', 'perf'],
  models: ['model', 'mô hình', 'registry', 'ollama', 'feature', 'flag', 'fallback', 'default model'],
  plugins: ['plugin', 'tiện ích', 'template', 'plugin'],
  hooks: ['hook', 'hooks'],
  api: ['api', 'local api', 'token', 'webhook', 'webhooks', 'port', 'cổng'],
  engines: ['engine', 'engines', 'cli', 'codex', 'claude', 'opencode', 'cursor', 'gemini cli', 'grok', 'acp'],
  providers: ['provider', 'api key', 'khóa api', 'openai', 'anthropic', 'gemini', 'xai', 'ollama', 'base url', 'model'],
  mediaKeys: ['media', 'media keys', 'khóa media', 'ảnh', 'video', 'image', 'video generation', 'stability', 'replicate', 'runway', 'luma', 'pika', 'sora'],
  limits: ['limit', 'giới hạn', 'spend', 'chi tiêu', 'daily', 'monthly', 'hạn mức'],
  usageReset: ['reset', 'đặt lại', 'usage', 'xóa usage', 'xóa'],
  onePassword: ['1password', 'one password', 'password manager', 'quản lý mật khẩu', 'mật khẩu', 'broker', 'vault'],
  crashReports: ['crash', 'crash report', 'báo cáo lỗi', 'lỗi', 'error', 'sự cố', 'sập', 'opt-in'],
  notifications: ['notification', 'notifications', 'thông báo', 'thông báo hệ thống', 'popup', 'duyệt', 'approval', 'xong việc', 'run complete'],
  profile: ['profile', 'hồ sơ', 'cá nhân', 'tên', 'xưng hô', 'sở thích', 'thói quen', 'personalization', 'cá nhân hoá', 'user', 'người dùng'],
};

/** Lowercase + strip diacritics so "bao mat" matches "bảo mật". */
export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd');
}

/**
 * Sections matching a search query, in tab order. Every whitespace
 * token must appear (as a substring) in at least one of the section's
 * keywords. An empty query matches nothing — the caller renders the
 * active tab instead of search results.
 */
export function filterSections(query: string): SettingsSectionId[] {
  const tokens = normalizeSearchText(query).split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  return SETTINGS_SECTIONS.filter((section) => {
    const keywords = SECTION_KEYWORDS[section].map((k) => normalizeSearchText(k));
    return tokens.every((token) => keywords.some((k) => k.includes(token)));
  });
}
