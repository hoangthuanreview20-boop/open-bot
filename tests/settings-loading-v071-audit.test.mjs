/**
 * Tests for v0.71 — async-load audit (milestone 3c).
 *
 * v0.68c/v0.69c claimed every Settings load was covered (first-load
 * flag + *LoadedOnce ref + finally + dedicated error + retry). This
 * file pins the audit that re-checked that claim systematically
 * instead of trusting it — and the gaps it actually found.
 *
 * Audit method (2026-11-10, on HEAD 8ad7255):
 *   1. Enumerated every async loader in SettingsView (loadSettings,
 *      loadAuth, loadPerf, loadRegistry, loadOllama, loadApi,
 *      loadNoStorage, loadOnePasswordStatus, loadPlugins, loadHooks,
 *      loadAutoApproveRules, loadEngines, loadUsage, loadVault,
 *      loadLimits, loadDream, loadUpdateStatus) and checked each
 *      against the v0.68c pattern, loader AND render side (the flag
 *      is useless if the tab never renders it).
 *   2. Same sweep over every other renderer view with a mount-time
 *      load (grep for useEffect + window.openBot in
 *      apps/desktop/src/renderer): App, A2aClientView,
 *      AgentMarketplaceView, AutomationsView, BotForm, CallView,
 *      ChatView, CheckpointPanel, CommandPalette, GroupView,
 *      McpMarketplaceView, ModelPicker, PlanReviewView, Sidebar,
 *      SkillsView, TeamView, TemplatePluginModal, ToolsView,
 *      TraceView, ConnectedAppsView (useConnectedApps hook).
 *
 * Verdicts:
 *   - Already covered, no change: every Settings loader except
 *     loadUpdateStatus; loadSettings top-level (loading + error +
 *     retry); 1Password (loading line via null status + error +
 *     Check-as-retry); useConnectedApps (v0.67b); SkillsView
 *     (Reload doubles as retry); McpMarketplaceView, TemplatePluginModal
 *     (v0.70a), TraceView, CheckpointPanel (refresh button);
 *     PlanReviewView stored plans (background extra, notice on
 *     error); BotForm templates + ChatView/CommandPalette slash
 *     commands (optional extras, silent fallback by design); CallView
 *     (no data load, only a surface registration); Sidebar (no data
 *     load); App (botsLoaded first-paint guard + error banner +
 *     tasksLoading; loadHistory's silent catch is a transient that
 *     self-heals on the next bot/thread switch).
 *   - Real gaps, fixed here:
 *     (1) Settings update-status: no loading state — the track
 *         selector showed its 'stable' default while IPC was in
 *         flight (the exact "defaults as if real" class v0.69c
 *         fixed for limits/dream/noStorage).
 *     (2) GroupView: NO loading state at all for listGroupChats +
 *         listGroupMessages — "no groups yet" / "no messages yet"
 *         showed while loading, and a failed load had no retry.
 *     (3) Six views had loading + error but no retry button:
 *         ModelPicker, ToolsView, A2aClientView,
 *         AgentMarketplaceView, AutomationsView, TeamView.
 *
 * These are source-contract tests (same style as
 * tests/confirm-modal.test.mjs): they assert the pattern is present
 * in the source and the new i18n keys exist in vi + en, so a later
 * edit cannot silently drop a loading line or a retry again.
 *
 * Run: node --test tests/settings-loading-v071-audit.test.mjs
 * (also run tests/i18n.test.mjs — the new keys must exist in vi+en.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const components = path.join(renderer, 'components');
const read = (p) => fs.readFileSync(p, 'utf-8');
const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));

const vietnamese = /[À-ỹđĐ]/;

/** New keys the audit fixes introduce (all must exist in vi + en). */
const NEW_KEYS = {
  'settings.updateStatusLoading': ['Loading update status…', 'Đang tải trạng thái cập nhật…'],
  'group.loading': ['Loading group chats…', 'Đang tải nhóm chat…'],
  'group.messagesLoading': ['Loading messages…', 'Đang tải tin nhắn…'],
  'group.retry': ['Retry', 'Thử lại'],
  'modelPicker.retry': ['Retry', 'Thử lại'],
  'tools.retry': ['Retry', 'Thử lại'],
  'a2a.retry': ['Retry', 'Thử lại'],
  'marketplace.retry': ['Retry', 'Thử lại'],
  'automations.retry': ['Retry', 'Thử lại'],
  'team.retry': ['Retry', 'Thử lại'],
};

/** Files the audit changed (no hard-coded Vietnamese in any of them). */
const EDITED_FILES = [
  'SettingsView.tsx',
  'SettingsGeneralTab.tsx',
  'GroupView.tsx',
  'ModelPicker.tsx',
  'ToolsView.tsx',
  'A2aClientView.tsx',
  'AgentMarketplaceView.tsx',
  'AutomationsView.tsx',
  'TeamView.tsx',
];

test('i18n: all audit keys exist, non-empty, in vi + en', () => {
  assert.equal(Object.keys(NEW_KEYS).length, 10, 'the key list must stay complete');
  for (const [key, [enText, viText]] of Object.entries(NEW_KEYS)) {
    assert.equal(en[key], enText, `en ${key} must be ${JSON.stringify(enText)}`);
    assert.equal(vi[key], viText, `vi ${key} must be ${JSON.stringify(viText)}`);
  }
});

test('audit: no hard-coded Vietnamese in the edited renderer files', () => {
  for (const file of EDITED_FILES) {
    const src = read(path.join(components, file));
    assert.ok(!vietnamese.test(src), `${file} must not hard-code Vietnamese (i18n scans comments too)`);
  }
});

// ---------------------------------------------------------------------------
// (1) Settings update-status loading
// ---------------------------------------------------------------------------

test('audit (1): update-status load has the full first-load pattern', () => {
  const src = read(path.join(components, 'SettingsView.tsx'));
  assert.match(src, /const \[updateStatusLoading, setUpdateStatusLoading\] = useState\(true\)/, 'first-load flag, true initially');
  assert.match(src, /const updateStatusLoadedOnce = useRef\(false\)/, 'LoadedOnce ref');
  assert.match(src, /const showLoading = !updateStatusLoadedOnce\.current;/, 'showLoading guards the flag');
  assert.match(src, /updateStatusLoadedOnce\.current = true;/, 'ref set on a successful load');
  assert.match(src, /if \(showLoading\) setUpdateStatusLoading\(false\);/, 'finally always clears the flag');
  assert.match(src, /updateStatusLoading, reloadUpdateStatus: loadUpdateStatus/, 'flag is passed to the tabs through shared props');
  const shared = read(path.join(components, 'settings/settingsShared.ts'));
  assert.match(shared, /updateStatusLoading: boolean;/, 'shared props type carries the flag');
  const tab = read(path.join(components, 'SettingsGeneralTab.tsx'));
  assert.match(tab, /updateStatusLoading, reloadUpdateStatus/, 'General tab reads the flag');
  assert.match(tab, /data-testid="update-status-loading"/, 'loading line has a test id');
  assert.match(tab, /t\('settings\.updateStatusLoading'\)/, 'loading line comes from i18n');
  assert.match(tab, /data-testid="update-status-retry"/, 'the existing retry is still there');
});

// ---------------------------------------------------------------------------
// (2) GroupView loading + dedicated load error + retry
// ---------------------------------------------------------------------------

test('audit (2): GroupView loads have the full first-load pattern', () => {
  const src = read(path.join(components, 'GroupView.tsx'));
  assert.match(src, /const \[groupsLoading, setGroupsLoading\] = useState\(true\)/, 'groups first-load flag, true initially');
  assert.match(src, /const groupsLoadedOnce = useRef\(false\)/, 'groups LoadedOnce ref');
  assert.match(src, /const \[messagesLoading, setMessagesLoading\] = useState\(false\)/, 'messages loading flag');
  assert.match(src, /const \[loadError, setLoadError\] = useState\(''\)/, 'dedicated load error, separate from the action error');
  assert.match(src, /if \(showLoading\) setGroupsLoading\(false\);/, 'groups finally always clears the flag');
  assert.match(src, /setMessagesLoading\(false\);/, 'messages finally always clears the flag');
  assert.match(src, /groupsLoadedOnce\.current = true;/, 'ref set on a successful groups load');
  assert.match(src, /data-testid="groups-loading"/, 'groups loading line has a test id');
  assert.match(src, /data-testid="group-messages-loading"/, 'messages loading line has a test id');
  assert.match(src, /t\('group\.loading'\)/, 'groups loading line comes from i18n');
  assert.match(src, /t\('group\.messagesLoading'\)/, 'messages loading line comes from i18n');
  assert.match(src, /data-testid="groups-retry"/, 'retry button has a test id');
  assert.match(src, /onClick=\{\(\) => void reloadGroups\(\)\}/, 'retry re-runs the loads');
  assert.match(src, /t\('group\.retry'\)/, 'retry label comes from i18n');
  // The empty states must wait for the loads: no "no groups yet"
  // while the list is still loading, no "no messages yet" while the
  // thread is still loading.
  assert.ok(!src.includes("{groups.length === 0 && <p className=\"empty\">{t('group.noGroups')}</p>}"),
    'the groups empty line must not render unconditionally while loading');
  assert.ok(!src.includes("{messages.length === 0 && <p className=\"empty\">{t('group.empty')}</p>}"),
    'the messages empty line must not render unconditionally while loading');
});

// ---------------------------------------------------------------------------
// (3) Retry buttons for the six views that had loading + error only
// ---------------------------------------------------------------------------

/** [file, retry test id, retry key, loader call the button runs]. */
const RETRY_VIEWS = [
  ['ModelPicker.tsx', 'model-picker-retry', 'modelPicker.retry', 'void loadRail()'],
  ['ToolsView.tsx', 'tools-retry', 'tools.retry', 'botId && void load(botId)'],
  ['A2aClientView.tsx', 'a2a-retry', 'a2a.retry', 'void load()'],
  ['AgentMarketplaceView.tsx', 'marketplace-retry', 'marketplace.retry', 'void load()'],
  ['AutomationsView.tsx', 'automations-retry', 'automations.retry', 'void load()'],
  ['TeamView.tsx', 'team-retry', 'team.retry', 'void load()'],
];

test('audit (3): every view with loading + error also has a retry', () => {
  for (const [file, testId, key, loaderCall] of RETRY_VIEWS) {
    const src = read(path.join(components, file));
    assert.ok(src.includes(`data-testid="${testId}"`), `${file} must render a retry button (${testId})`);
    assert.ok(src.includes(`t('${key}')`), `${file} retry label must come from i18n (${key})`);
    assert.ok(src.includes(`onClick={() => ${loaderCall}`), `${file} retry must re-run its loader (${loaderCall})`);
  }
  // ToolsView loads tools and skills in one load(): the skills error
  // gets its own retry next to its own error line.
  const tools = read(path.join(components, 'ToolsView.tsx'));
  assert.ok(tools.includes('data-testid="tools-skills-retry"'), 'ToolsView skills error needs its own retry');
});

// ---------------------------------------------------------------------------
// Spot-checks: the "already covered" claims the audit verified
// ---------------------------------------------------------------------------

test('audit: the already-covered Settings loaders still follow the pattern', () => {
  const src = read(path.join(components, 'SettingsView.tsx'));
  // Every named Settings loader except the two covered separately
  // (loadSettings top-level, loadOnePasswordStatus) must have a
  // first-load flag + LoadedOnce ref + finally.
  for (const name of [
    'usage', 'vault', 'auth', 'registry', 'ollama', 'plugins', 'hooks',
    'autoApprove', 'perf', 'api', 'engines', 'limits', 'dream', 'noStorage',
  ]) {
    assert.ok(
      src.includes(`const ${name}LoadedOnce = useRef(false)`),
      `SettingsView must keep the ${name}LoadedOnce ref`,
    );
    assert.ok(
      src.includes(`if (showLoading) set${name[0].toUpperCase()}${name.slice(1)}Loading(false)`),
      `SettingsView must clear the ${name} flag in finally`,
    );
  }
});
