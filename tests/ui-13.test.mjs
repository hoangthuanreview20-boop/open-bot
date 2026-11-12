/**
 * UI-13 tests (v0.61, renderer-only, no Electron).
 *
 * Covers the five P2 items in docs/ui-parity-review.md §5 + the cron
 * builder extra:
 *
 * - Nav menu: the 10 bottom sidebar buttons collapse into one menu
 *   (button + dropdown + Esc/outside handling in Sidebar).
 * - Delete-bot modal: `window.confirm` is gone from App; the in-app
 *   confirm modal (same pattern as the thread-delete modal) does it.
 * - Manual theme: `theme.ts` rules (system/light/dark, storage,
 *   attribute application) + the Settings → General section + the
 *   dark CSS applying under `data-theme="dark"` as well as the OS
 *   media query.
 * - Shortcuts: Cmd/Ctrl+K toggles the palette, Esc closes the topmost
 *   layer; the palette lists bots / slash commands / screens and the
 *   slash pick inserts into the composer via ChatView `externalInsert`.
 * - Unified error banner: the fixed bottom-right error line is gone;
 *   App renders AppErrorBanner (same shape as the A2A persist banner)
 *   at the top of the main column.
 * - Cron builder: `cronBuilder.ts` composes/parses/describes 5-field
 *   expressions; AutomationsView renders the builder + summary.
 * - UI-10 fix (from the verification smokes): no silent default bot
 *   (`ensureDefaultBot` deleted) and `bots:create` / `bots:delete`
 *   broadcast `bots:changed` so the renderer reloads the list.
 *
 * Run: node --test tests/ui-13.test.mjs
 * (also run tests/i18n.test.mjs — the new keys must exist in vi+en.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  THEME_STORAGE_KEY,
  applyThemeMode,
  isThemeMode,
  readThemeMode,
  resolveTheme,
  saveThemeMode,
} from '../apps/desktop/src/renderer/components/theme.ts';
import {
  CRON_DEFAULT_FIELDS,
  CRON_PRESETS,
  buildCronExpression,
  describeCron,
  parseCronFields,
  weekdayLongName,
  weekdayShortName,
} from '../apps/desktop/src/renderer/components/cronBuilder.ts';
import {
  BOT_COLORS,
  BOT_COLOR_DEFAULT,
  botColor,
  botInitial,
  isBotColor,
} from '../apps/desktop/src/renderer/components/botColors.ts';
import { SETTINGS_SECTIONS, SECTION_TAB, filterSections } from '../apps/desktop/src/renderer/components/settings/settingsTabs.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const read = (p) => fs.readFileSync(p, 'utf-8');

const appSrc = read(path.join(renderer, 'App.tsx'));
const chatSrc = read(path.join(renderer, 'components/ChatView.tsx'));
const sidebarSrc = read(path.join(renderer, 'components/Sidebar.tsx'));
const paletteSrc = read(path.join(renderer, 'components/CommandPalette.tsx'));
const generalTabSrc = read(path.join(renderer, 'components/SettingsGeneralTab.tsx'));
const automationsSrc = read(path.join(renderer, 'components/AutomationsView.tsx'));
const bannerSrc = read(path.join(renderer, 'components/AppErrorBanner.tsx'));
const a2aAlertSrc = read(path.join(renderer, 'components/A2aPersistAlert.tsx'));
const cssSrc = read(path.join(renderer, 'styles.css'));
const mainSrc = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
const botFormSrc = read(path.join(renderer, 'components/BotForm.tsx'));
const coreTypesSrc = read(path.join(repo, 'packages/core/src/types.ts'));
const marketplaceSrc = read(path.join(repo, 'packages/core/src/agent/marketplace.ts'));
const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));

const NEW_KEYS = [
  'settings.themeTitle',
  'settings.themeLabel',
  'settings.themeSystem',
  'settings.themeLight',
  'settings.themeDark',
  'settings.themeHint',
  'sidebar.navMenu',
  'sidebar.navMenuClose',
  'app.deleteBotTitle',
  'palette.title',
  'palette.placeholder',
  'palette.bots',
  'palette.commands',
  'palette.views',
  'palette.empty',
  'palette.hint',
  'palette.chatView',
  'automations.cronBuilderTitle',
  'automations.cronPresetDaily',
  'automations.cronPresetWeekdays',
  'automations.cronPresetHourly',
  'automations.cronPresetWeekly',
  'automations.cronMinuteLabel',
  'automations.cronHourLabel',
  'automations.cronWeekdayLabel',
  'automations.cronSummaryDaily',
  'automations.cronSummaryWeekdays',
  'automations.cronSummaryWeekly',
  'automations.cronSummaryHourly',
  'automations.cronSummaryCustom',
  'botForm.colorLabel',
  'botForm.colorHint',
];

test('i18n: all UI-13 keys exist, non-empty, in vi + en', () => {
  assert.equal(NEW_KEYS.length, 32, 'the key list must stay complete');
  for (const key of NEW_KEYS) {
    assert.ok(typeof vi[key] === 'string' && vi[key].trim().length > 0, `missing/empty in vi.json: ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].trim().length > 0, `missing/empty in en.json: ${key}`);
  }
});

// --- theme.ts ---------------------------------------------------------------

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); },
  };
}

function throwingStorage() {
  return {
    getItem: () => { throw new Error('no storage'); },
    setItem: () => { throw new Error('no storage'); },
  };
}

function fakeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (k, v) => { attrs.set(k, v); },
    removeAttribute: (k) => { attrs.delete(k); },
  };
}

test('theme: read/save round-trip, invalid/missing/throwing storage means system', () => {
  assert.equal(readThemeMode(null), 'system');
  assert.equal(readThemeMode(undefined), 'system');
  assert.equal(readThemeMode(fakeStorage()), 'system');
  assert.equal(readThemeMode(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' })), 'system');
  assert.equal(readThemeMode(throwingStorage()), 'system');
  for (const mode of ['system', 'light', 'dark']) {
    const s = fakeStorage();
    saveThemeMode(s, mode);
    assert.equal(readThemeMode(s), mode, `mode ${mode} must round-trip`);
  }
  assert.equal(isThemeMode('dark'), true);
  assert.equal(isThemeMode('sepia'), false);
  // Saving never throws, even when storage is broken.
  saveThemeMode(throwingStorage(), 'dark');
  saveThemeMode(null, 'dark');
});

test('theme: resolveTheme — system follows the OS, light/dark win', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('theme: applyThemeMode sets/removes data-theme, never throws', () => {
  const root = fakeRoot();
  applyThemeMode('dark', root);
  assert.equal(root.attrs.get('data-theme'), 'dark');
  applyThemeMode('light', root);
  assert.equal(root.attrs.get('data-theme'), 'light');
  applyThemeMode('system', root);
  assert.equal(root.attrs.has('data-theme'), false, 'system removes the attribute');
  applyThemeMode('dark', null);
  applyThemeMode('dark', undefined);
});

test('theme: wired into App (mount) + Settings General tab (appearance section)', () => {
  assert.ok(appSrc.includes('readThemeMode'), 'App must read the stored theme on mount');
  assert.ok(appSrc.includes('applyThemeMode'), 'App must apply the stored theme on mount');
  assert.ok(generalTabSrc.includes("show('appearance')"), 'General tab must render the appearance section');
  assert.ok(generalTabSrc.includes('data-section="appearance"'), 'appearance section needs its data-section marker');
  assert.ok(generalTabSrc.includes('data-testid="theme-select"'), 'theme select must be testable');
  assert.ok(generalTabSrc.includes("t('settings.themeTitle')"), 'theme section uses the i18n title');
  assert.ok(generalTabSrc.includes("changeTheme(e.target.value as ThemeMode)"), 'changing the select applies the theme');
  assert.ok(cssSrc.includes(':root[data-theme="dark"]'), 'dark variables must apply under a manual Dark theme');
  assert.ok(cssSrc.includes(':root:not([data-theme])'), 'the OS media query must only apply with no manual choice');
  assert.ok(/:root\[data-theme="dark"\] \.badge\.approval/.test(cssSrc), 'dark approval badge must exist under manual Dark');
});

test('theme: appearance is a real Settings section (tab + search)', () => {
  assert.ok(SETTINGS_SECTIONS.includes('appearance'), 'appearance must be in SETTINGS_SECTIONS');
  assert.equal(SECTION_TAB['appearance'], 'general', 'appearance must live in the General tab');
  assert.deepEqual(filterSections('giao diện'), ['appearance'], 'search "giao diện" must find the theme section');
  assert.deepEqual(filterSections('theme'), ['appearance'], 'search "theme" must find the theme section');
  assert.deepEqual(filterSections('dark'), ['appearance'], 'search "dark" must find the theme section');
});

// --- nav menu ---------------------------------------------------------------

test('nav menu: Sidebar collapses the 10 bottom buttons into one menu', () => {
  assert.ok(sidebarSrc.includes('data-testid="sidebar-nav-menu"'), 'menu toggle button must exist');
  assert.ok(sidebarSrc.includes('data-testid="sidebar-nav-dropdown"'), 'dropdown must exist');
  assert.ok(sidebarSrc.includes('data-nav-key'), 'dropdown rows must carry data-nav-key');
  assert.ok(sidebarSrc.includes('navItems'), 'destinations must be one data list, not 10 loose buttons');
  for (const key of ['marketplace', 'mcp', 'a2a', 'team', 'group', 'skills', 'tools', 'connected-apps', 'automations', 'settings']) {
    assert.ok(sidebarSrc.includes(`key: '${key}'`), `nav menu must list ${key}`);
  }
  assert.ok(!sidebarSrc.includes('data-testid="nav-tools"'), 'the old loose Tools button (nav-tools) must be gone');
  assert.ok(sidebarSrc.includes("t('sidebar.navMenu')"), 'menu button uses the i18n label');
  assert.ok(sidebarSrc.includes("if (e.key === 'Escape')"), 'Esc must close the menu');
  assert.ok(sidebarSrc.includes('sidebar-nav-overlay'), 'a click-outside overlay must close the menu');
  assert.ok(sidebarSrc.includes("title={navOpen ? t('sidebar.navMenuClose') : t('sidebar.navMenu')}"), 'menu button title must follow open/closed state');
  assert.ok(cssSrc.includes('.sidebar-nav-overlay'), 'overlay needs its CSS');
  assert.ok(automationsSrc.includes('setCronFields({ ...CRON_DEFAULT_FIELDS'), 'creating an automation must reset the cron builder to the default');
});

// --- delete-bot modal --------------------------------------------------------

test('delete bot: window.confirm is gone; the in-app modal confirms', () => {
  assert.ok(!appSrc.includes('window.confirm('), 'App must not call window.confirm any more');
  assert.ok(appSrc.includes('deleteBotTarget'), 'App must track the bot awaiting delete confirmation');
  assert.ok(appSrc.includes('data-testid="delete-bot-modal"'), 'delete modal must be testable');
  assert.ok(appSrc.includes('data-testid="delete-bot-confirm"'), 'delete confirm button must be testable');
  assert.ok(appSrc.includes("t('app.deleteBotTitle')"), 'modal uses the i18n title');
  assert.ok(appSrc.includes("t('app.deleteBotConfirm'"), 'modal reuses the existing confirm body text');
  assert.ok(appSrc.includes('confirmDeleteBot'), 'the real delete runs from the modal confirm');
});

// --- error banner -----------------------------------------------------------

test('error banner: fixed bottom-right line is gone; AppErrorBanner renders at the top', () => {
  assert.ok(!appSrc.includes("position: 'fixed', bottom: 8, right: 12"), 'the old fixed error line must be gone');
  assert.ok(appSrc.includes('<AppErrorBanner message={loadError}'), 'App must render the banner for loadError');
  assert.ok(appSrc.includes('onDismiss={() => setLoadError'), 'dismissing the banner clears the error');
  assert.ok(bannerSrc.includes('role="alert"'), 'banner must be an alert');
  assert.ok(bannerSrc.includes('data-testid="app-error-banner"'), 'banner must be testable');
  assert.ok(bannerSrc.includes("t('a2a.persistDismiss')"), 'banner reuses the "Got it" dismiss label');
  assert.ok(cssSrc.includes('.app-alert'), 'banner needs the shared .app-alert style');
  assert.ok(a2aAlertSrc.includes('className="app-alert"'), 'the A2A banner uses the same shared style');
});

// --- command palette + shortcuts --------------------------------------------

test('shortcuts: Cmd/Ctrl+K toggles the palette; Esc closes the topmost layer', () => {
  assert.ok(appSrc.includes('paletteOpen'), 'App must own the palette open state');
  assert.ok(appSrc.includes("e.key === 'k'"), 'Cmd/Ctrl+K must toggle the palette');
  assert.ok(appSrc.includes("e.metaKey || e.ctrlKey"), 'the shortcut must work with Cmd or Ctrl');
  assert.ok(appSrc.includes("target?.closest?.('.chat-input textarea')"), 'Esc inside the composer stays with ChatView (autocomplete)');
  assert.ok(appSrc.includes('setPaletteOpen(false)'), 'Esc must close the palette');
  assert.ok(appSrc.includes('<CommandPalette'), 'App must render the palette');
  assert.ok(appSrc.includes('externalInsert={composerInsert}'), 'App must pass palette inserts to ChatView');
  assert.ok(chatSrc.includes('externalInsert'), 'ChatView must accept the insert prop');
  assert.ok(chatSrc.includes('appliedInsertNonceRef'), 'ChatView must apply each insert exactly once');
  // Regression guard (UI-13 smoke found it): a hook after the
  // `if (!bot)` early return changes the hook count between the
  // bot=null render (bots loading) and the bot-selected render, and
  // React crashes the whole app with error #310 on reload. The
  // externalInsert effect must live ABOVE that return.
  const earlyReturnAt = chatSrc.indexOf('if (!bot) {');
  const insertEffectAt = chatSrc.indexOf('appliedInsertNonceRef.current === externalInsert.nonce');
  assert.ok(earlyReturnAt !== -1 && insertEffectAt !== -1 && insertEffectAt < earlyReturnAt, 'the externalInsert effect must be above the early return');
  assert.ok(paletteSrc.includes('data-testid="command-palette"'), 'palette must be testable');
  assert.ok(paletteSrc.includes('data-testid="command-palette-input"'), 'palette input must be testable');
  assert.ok(paletteSrc.includes('listSlashCommands'), 'palette loads slash commands from the registry');
  assert.ok(paletteSrc.includes("t('palette.bots')"), 'palette groups bots');
  assert.ok(paletteSrc.includes("t('palette.commands')"), 'palette groups slash commands');
  assert.ok(paletteSrc.includes("t('palette.views')"), 'palette groups screens');
  assert.ok(paletteSrc.includes("e.key === 'ArrowDown'"), 'palette supports arrow navigation');
  assert.ok(paletteSrc.includes("e.key === 'Enter'"), 'palette runs the active row on Enter');
  assert.ok(paletteSrc.includes('filterBots'), 'palette bot search reuses the sidebar filter');
  assert.ok(cssSrc.includes('.palette-list'), 'palette needs its CSS');
});

// --- cron builder -----------------------------------------------------------

const fakeT = (key, vars = {}) => {
  const dict = {
    'automations.cronSummaryDaily': `Daily at ${vars.time}`,
    'automations.cronSummaryWeekdays': `Weekdays at ${vars.time}`,
    'automations.cronSummaryWeekly': `Every ${vars.day} at ${vars.time}`,
    'automations.cronSummaryHourly': `Hourly at minute ${vars.minute}`,
    'automations.cronSummaryCustom': `Cron: ${vars.expression}`,
  };
  return dict[key] ?? key;
};

test('cron builder: presets compose exact expressions', () => {
  const byKey = Object.fromEntries(CRON_PRESETS.map((p) => [p.key, p.fields]));
  assert.equal(buildCronExpression(byKey.daily), '0 9 * * *');
  assert.equal(buildCronExpression(byKey.weekdays), '0 9 * * 1-5');
  assert.equal(buildCronExpression(byKey.hourly), '0 * * * *');
  assert.equal(buildCronExpression(byKey.weekly), '0 9 * * 1');
  assert.equal(buildCronExpression({ minute: '30', hour: '14', weekdays: [0, 6] }), '30 14 * * 0,6');
  assert.equal(buildCronExpression({ minute: '5', hour: '8', weekdays: [1, 2, 3, 4, 5, 6, 0] }), '5 8 * * *');
  assert.deepEqual(CRON_DEFAULT_FIELDS, { minute: '0', hour: '9', weekdays: [1, 2, 3, 4, 5] });
});

test('cron builder: parse round-trips the presets, rejects unrepresentable shapes', () => {
  for (const preset of CRON_PRESETS) {
    const expr = buildCronExpression(preset.fields);
    assert.deepEqual(parseCronFields(expr), preset.fields, `${preset.key} must round-trip`);
  }
  assert.equal(parseCronFields('0 9 1 * *'), null, 'day-of-month is not representable');
  assert.equal(parseCronFields('0 9 * 6 *'), null, 'month is not representable');
  assert.equal(parseCronFields('*/15 * * * *'), null, 'step minutes are not representable');
  assert.equal(parseCronFields('* 9 * * *'), null, 'star minutes are not representable');
  assert.equal(parseCronFields('0 9 * * 2-4'), null, 'ranges other than 1-5 are not representable');
  assert.equal(parseCronFields('not a cron'), null, 'garbage is not parseable');
  assert.equal(parseCronFields('0 9 * *'), null, '4 fields are not parseable');
  // Leading zeros are ordinary cron ("09 9 * * 1-5") — they must parse
  // and normalise to the canonical form, not fall back to "Cron: …".
  assert.deepEqual(parseCronFields('09 9 * * 1-5'), { minute: '9', hour: '9', weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseCronFields('00 09 * * 0,6'), { minute: '0', hour: '9', weekdays: [0, 6] });
  assert.equal(describeCron('09 9 * * 1-5', fakeT, 'vi'), 'Weekdays at 09:09');
});

test('cron builder: describeCron paraphrases known shapes, echoes the rest', () => {
  assert.equal(describeCron('0 9 * * *', fakeT, 'vi'), 'Daily at 09:00');
  assert.equal(describeCron('0 9 * * 1-5', fakeT, 'vi'), 'Weekdays at 09:00');
  assert.equal(describeCron('30 14 * * 1', fakeT, 'en'), 'Every Monday at 14:30');
  assert.equal(describeCron('0 * * * *', fakeT, 'vi'), 'Hourly at minute 0');
  assert.equal(describeCron('0 9 1 * *', fakeT, 'vi'), 'Cron: 0 9 1 * *');
  assert.equal(describeCron('*/15 * * * *', fakeT, 'en'), 'Cron: */15 * * * *');
});

test('cron builder: weekday names are localised and distinct', () => {
  const viNames = [0, 1, 2, 3, 4, 5, 6].map((d) => weekdayLongName(d, 'vi'));
  const enNames = [0, 1, 2, 3, 4, 5, 6].map((d) => weekdayLongName(d, 'en'));
  assert.equal(new Set(viNames).size, 7, `vi weekday names must be distinct: ${viNames.join(', ')}`);
  assert.equal(new Set(enNames).size, 7, `en weekday names must be distinct: ${enNames.join(', ')}`);
  assert.ok(enNames[1].startsWith('Mon'), `day 1 in en must be Monday, got ${enNames[1]}`);
  assert.ok(enNames[0].startsWith('Sun'), `day 0 in en must be Sunday, got ${enNames[0]}`);
  assert.ok(weekdayShortName(1, 'en').length > 0, 'short names must be non-empty');
});

test('cron builder: wired into AutomationsView', () => {
  assert.ok(automationsSrc.includes('data-testid="cron-builder"'), 'builder must be testable');
  assert.ok(automationsSrc.includes('data-testid="cron-summary"'), 'summary must be testable');
  assert.ok(automationsSrc.includes('CRON_PRESETS'), 'presets must render as buttons');
  assert.ok(automationsSrc.includes('describeCron(cronExpression'), 'summary must describe the current expression');
  assert.ok(automationsSrc.includes('applyCronFields'), 'builder controls must compose the expression');
  assert.ok(automationsSrc.includes('changeCronExpression'), 'typing in the text input must sync the builder back');
});

// --- bot colour / avatar --------------------------------------------------

test('bot colour: 8-colour palette, unknown values fall back, initial letter', () => {
  assert.equal(BOT_COLORS.length, 8, 'the picker offers 8 colours');
  assert.equal(new Set(BOT_COLORS).size, 8, 'palette colours must be distinct');
  assert.ok(BOT_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'palette entries must be hex colours');
  assert.equal(BOT_COLOR_DEFAULT, BOT_COLORS[0]);
  assert.equal(isBotColor('#7c3aed'), true);
  assert.equal(isBotColor('#ff0000'), false);
  assert.equal(isBotColor(undefined), false);
  assert.equal(botColor('#7c3aed'), '#7c3aed');
  assert.equal(botColor('#ff0000'), BOT_COLOR_DEFAULT, 'unknown colours fall back to default');
  assert.equal(botColor(undefined), BOT_COLOR_DEFAULT, 'missing colours fall back to default');
  assert.equal(botInitial('Trợ lý mẫu'), 'T');
  assert.equal(botInitial('  ollama bot'), 'O');
  assert.equal(botInitial(''), '?');
  assert.equal(botInitial('   '), '?');
});

test('bot colour: wired into BotForm / Sidebar / ChatView + persisted in core + main', () => {
  assert.ok(botFormSrc.includes('BOT_COLORS'), 'BotForm must offer the palette');
  assert.ok(botFormSrc.includes('data-color={c}'), 'swatches must be testable by colour');
  assert.ok(botFormSrc.includes("t('botForm.colorLabel')"), 'picker uses the i18n label');
  assert.ok(botFormSrc.includes('color,'), 'BotForm must submit the colour');
  assert.ok(sidebarSrc.includes('data-testid="bot-avatar"'), 'sidebar rows must show the avatar');
  assert.ok(sidebarSrc.includes('botColor(bot.color)'), 'sidebar avatar uses the stored colour');
  assert.ok(sidebarSrc.includes('botInitial(bot.name)'), 'sidebar avatar shows the initial');
  assert.ok(chatSrc.includes('bot-avatar'), 'chat header must show the avatar');
  assert.ok(coreTypesSrc.includes('color?: string;'), 'core BotConfig must carry the colour');
  assert.ok(mainSrc.includes("optionalString(config.color, 'color'"), 'bots:create must persist the colour');
  assert.ok(marketplaceSrc.includes('color: config.color.trim()'), 'cloning a bot must keep its colour');
  assert.ok(cssSrc.includes('.bot-avatar'), 'avatar needs its CSS');
  assert.ok(cssSrc.includes('.bot-color-swatch'), 'swatches need their CSS');
});

// --- UI-10 fix (verification follow-up) -------------------------------------

test('UI-10 fix: no silent default bot; bots:create/delete broadcast the change', () => {
  assert.ok(!/ensureDefaultBot\(\);/.test(mainSrc), 'main must not auto-create a default bot any more');
  assert.ok(!/function ensureDefaultBot/.test(mainSrc), 'the ensureDefaultBot function must be deleted');
  const broadcasts = (mainSrc.match(/sendToRenderer\('bots:changed'/g) ?? []).length;
  assert.ok(broadcasts >= 3, `bots:changed must be sent on create, delete and agent-created (found ${broadcasts})`);
  assert.ok(mainSrc.includes("sendToRenderer('bots:changed', { botId: bot.id })"), 'bots:create must broadcast the new bot id');
});
