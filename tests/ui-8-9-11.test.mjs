/**
 * UI-8 + UI-9 + UI-11 tests (v0.60, renderer-only, no Electron).
 *
 * UI-8 — per-turn token/usage footer in chat:
 *   - `diffTurnUsage` (components/turnUsage.ts) diffs two `usage:get`
 *     snapshots into one turn's usage; null when there is nothing to
 *     show (no usage reported, store reset mid-run, missing snapshot).
 *   - App snapshots usage before `sendChat` and attaches the diff to
 *     the assistant message; ChatView renders it as a footer under
 *     the assistant bubble (data-testid="turn-usage").
 *
 * UI-9 — approval tray + sidebar badge:
 *   - decision cards (approval / CLI permission / interrupt) move out
 *     of the open chat into `ApprovalTray` (right dock, all bots,
 *     every view); App no longer clears approvals on bot switch (the
 *     old M8 loss shape); the tray auto-opens on the 0 -> N transition.
 *   - `countPendingByBot` sums the three card kinds per bot — the
 *     sidebar badge number.
 *
 * UI-11 — bot search + running/idle in the sidebar:
 *   - `filterBots` matches name / provider (model too), diacritic-
 *     insensitive; Sidebar renders a search box, a running/idle dot
 *     per bot and the approval badge.
 *
 * Run: node --test tests/ui-8-9-11.test.mjs
 * (also run tests/i18n.test.mjs — the new keys must exist in vi+en.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffTurnUsage,
  formatTokenCount,
  formatTurnCostUsd,
} from '../apps/desktop/src/renderer/components/turnUsage.ts';
import { countPendingByBot, filterBots } from '../apps/desktop/src/renderer/components/botList.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const read = (p) => fs.readFileSync(p, 'utf-8');

const appSrc = read(path.join(renderer, 'App.tsx'));
const chatSrc = read(path.join(renderer, 'components/ChatView.tsx'));
const sidebarSrc = read(path.join(renderer, 'components/Sidebar.tsx'));
const traySrc = read(path.join(renderer, 'components/ApprovalTray.tsx'));
const typesSrc = read(path.join(renderer, 'types.ts'));
const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));

const spend = (total, today) => ({ today: today ?? total, month: total, total });

const NEW_KEYS = [
  'chat.turnUsage',
  'approval.trayTitle',
  'approval.trayClose',
  'approval.trayEmpty',
  'approval.trayToggle',
  'approval.trayOpenBot',
  'sidebar.searchBotsPlaceholder',
  'sidebar.noBotResults',
  'sidebar.botRunning',
  'sidebar.botIdle',
  'sidebar.pendingApprovals',
];

// ---------------------------------------------------------------------------
// UI-8: per-turn usage diff
// ---------------------------------------------------------------------------

test('UI-8: diffTurnUsage returns the turn tokens + cost + calls', () => {
  const before = spend({ inputTokens: 1000, outputTokens: 500, costUsd: 0.05, calls: 3, unpricedCalls: 0 });
  const after = spend({ inputTokens: 1500, outputTokens: 700, costUsd: 0.07, calls: 5, unpricedCalls: 0 });
  assert.deepEqual(diffTurnUsage(before, after), {
    inputTokens: 500,
    outputTokens: 200,
    costUsd: 0.02,
    calls: 2,
  });
});

test('UI-8: diffTurnUsage cost is null when any side is unpriced, tokens still shown', () => {
  const before = spend({ inputTokens: 100, outputTokens: 50, costUsd: null, calls: 1, unpricedCalls: 1 });
  const after = spend({ inputTokens: 300, outputTokens: 90, costUsd: null, calls: 2, unpricedCalls: 1 });
  assert.deepEqual(diffTurnUsage(before, after), {
    inputTokens: 200,
    outputTokens: 40,
    costUsd: null,
    calls: 1,
  });
});

test('UI-8: diffTurnUsage is null on zero tokens (provider reported no usage)', () => {
  const snap = spend({ inputTokens: 100, outputTokens: 50, costUsd: 0, calls: 1, unpricedCalls: 0 });
  assert.equal(diffTurnUsage(snap, snap), null);
});

test('UI-8: diffTurnUsage is null on a negative diff (store reset mid-run), never a made-up number', () => {
  const before = spend({ inputTokens: 900, outputTokens: 400, costUsd: 0.04, calls: 9, unpricedCalls: 0 });
  const after = spend({ inputTokens: 10, outputTokens: 5, costUsd: 0.001, calls: 1, unpricedCalls: 0 });
  assert.equal(diffTurnUsage(before, after), null);
});

test('UI-8: diffTurnUsage is null without snapshots, falls back to the today window', () => {
  assert.equal(diffTurnUsage(null, null), null);
  assert.equal(diffTurnUsage(undefined, spend({ inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, unpricedCalls: 0 })), null);
  const before = { today: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, unpricedCalls: 0 } };
  const after = { today: { inputTokens: 40, outputTokens: 10, costUsd: 0.001, calls: 1, unpricedCalls: 0 } };
  assert.deepEqual(diffTurnUsage(before, after), {
    inputTokens: 40,
    outputTokens: 10,
    costUsd: 0.001,
    calls: 1,
  });
});

test('UI-8: cost formatting shows 4 decimals below one cent, 2 above', () => {
  assert.equal(formatTurnCostUsd(0.005), '$0.0050');
  assert.equal(formatTurnCostUsd(0.02), '$0.02');
  assert.equal(formatTurnCostUsd(1.5), '$1.50');
  assert.equal(formatTokenCount(1234567), '1,234,567');
});

test('UI-8: App snapshots usage around sendChat and attaches the diff; ChatView renders the footer', () => {
  assert.ok(appSrc.includes('getUsage(botId)'), 'App must read usage:get for the turn');
  assert.ok(appSrc.includes('diffTurnUsage(usageBefore, after)'), 'App must diff before/after into the turn usage');
  assert.ok(appSrc.includes('usageBefore'), 'App must snapshot usage BEFORE sendChat');
  assert.ok(typesSrc.includes('usage?: TurnUsageView'), 'ChatMessageView must carry the turn usage');
  assert.ok(typesSrc.includes('interface TurnUsageView'), 'TurnUsageView must be defined');
  assert.ok(chatSrc.includes('data-testid="turn-usage"'), 'ChatView must render the usage footer');
  assert.ok(chatSrc.includes("t('chat.turnUsage'"), 'ChatView footer must use the i18n key');
  assert.ok(chatSrc.includes('m.usage.costUsd !== null'), 'ChatView must hide the cost when unpriced');
});

// ---------------------------------------------------------------------------
// UI-9: approval tray + badge counts
// ---------------------------------------------------------------------------

test('UI-9: countPendingByBot sums approvals + permissions + interrupts per bot', () => {
  const approvals = [
    { botId: 'a', callId: 'c1', call: {} },
    { botId: 'a', callId: 'c2', call: {} },
    { botId: 'b', callId: 'c3', call: {} },
  ];
  const permissions = [{ botId: 'a', requestId: 'p1', engine: 'codex', method: 'shell', allowable: true }];
  const interrupts = [{ botId: 'b', requestId: 'i1', runId: 'r1', stepIndex: 0, reason: 'x' }];
  assert.deepEqual(countPendingByBot(approvals, permissions, interrupts), { a: 3, b: 2 });
  assert.deepEqual(countPendingByBot([], [], []), {});
});

test('UI-9: App renders the tray (not cards in chat), keeps cards across bot switches, auto-opens on 0 -> N', () => {
  assert.ok(appSrc.includes('<ApprovalTray'), 'App must render ApprovalTray');
  assert.ok(!appSrc.includes('<ApprovalCard'), 'App must not render ApprovalCard inline in chat any more');
  assert.ok(!appSrc.includes('<PermissionCard'), 'App must not render PermissionCard inline in chat any more');
  assert.ok(!appSrc.includes('<InterruptCard'), 'App must not render InterruptCard inline in chat any more');
  assert.ok(!appSrc.includes('setApprovals([])'), 'App must not clear approvals when switching bots (M8 loss shape)');
  assert.ok(appSrc.includes('prevPendingTotalRef.current === 0 && pendingTotal > 0'), 'Tray must auto-open on the 0 -> N transition');
  assert.ok(appSrc.includes('data-testid="approval-tray-toggle"'), 'Chat must offer a tray toggle button');
  assert.ok(appSrc.includes("pendingCounts={countPendingByBot(approvals, harnessPermissions, interrupts)}"), 'App must pass per-bot pending counts to Sidebar');
});

test('UI-9: ApprovalTray renders all three card kinds, names the bot, offers jump-to-bot', () => {
  assert.ok(traySrc.includes('<ApprovalCard'), 'Tray must render ApprovalCard');
  assert.ok(traySrc.includes('<PermissionCard'), 'Tray must render PermissionCard');
  assert.ok(traySrc.includes('<InterruptCard'), 'Tray must render InterruptCard');
  assert.ok(traySrc.includes('data-testid="approval-tray"'), 'Tray must be identifiable');
  assert.ok(traySrc.includes("t('approval.trayOpenBot'"), 'Tray cards must offer a jump to their bot');
  assert.ok(traySrc.includes('onJumpToBot'), 'Tray must call back to switch to the card bot');
  assert.ok(traySrc.includes('data-testid="approval-tray-close"'), 'Tray must be closable');
});

test('UI-9: Sidebar renders the per-bot approval badge', () => {
  assert.ok(sidebarSrc.includes('data-testid="bot-approval-badge"'), 'Sidebar must render the approval badge');
  assert.ok(sidebarSrc.includes('pendingCounts[bot.id]'), 'Badge must read the per-bot pending count');
  assert.ok(sidebarSrc.includes("t('sidebar.pendingApprovals'"), 'Badge must have an accessible label');
});

// ---------------------------------------------------------------------------
// UI-11: bot search + running/idle
// ---------------------------------------------------------------------------

const bots = [
  { id: '1', name: 'Quản lý kho', providerId: 'gemini', model: 'gemini-2.5-flash', systemPrompt: '', workspaceDir: '', autoApprove: false },
  { id: '2', name: 'Trợ lý viết', providerId: 'openai', model: 'gpt-5', systemPrompt: '', workspaceDir: '', autoApprove: false },
  { id: '3', name: 'Code Helper', providerId: 'codex', model: '', systemPrompt: '', workspaceDir: '', autoApprove: false },
];

test('UI-11: filterBots matches name, provider and model', () => {
  assert.deepEqual(filterBots(bots, 'quản').map((b) => b.id), ['1']);
  assert.deepEqual(filterBots(bots, 'gemini').map((b) => b.id), ['1']);
  assert.deepEqual(filterBots(bots, 'gpt-5').map((b) => b.id), ['2']);
  assert.deepEqual(filterBots(bots, 'codex').map((b) => b.id), ['3']);
});

test('UI-11: filterBots is diacritic-insensitive and every token must match', () => {
  assert.deepEqual(filterBots(bots, 'quan ly').map((b) => b.id), ['1']);
  assert.deepEqual(filterBots(bots, 'QUAN LY KHO').map((b) => b.id), ['1']);
  assert.deepEqual(filterBots(bots, 'quan openai').map((b) => b.id), []);
  assert.deepEqual(filterBots(bots, 'tro ly viet').map((b) => b.id), ['2']);
});

test('UI-11: filterBots returns all bots on an empty query, none on no match', () => {
  assert.deepEqual(filterBots(bots, '').map((b) => b.id), ['1', '2', '3']);
  assert.deepEqual(filterBots(bots, '   ').map((b) => b.id), ['1', '2', '3']);
  assert.deepEqual(filterBots(bots, 'zzz-no-such-bot'), []);
});

test('UI-11: Sidebar has a bot search box, a running/idle dot and App feeds it live running state', () => {
  assert.ok(sidebarSrc.includes('data-testid="bot-search"'), 'Sidebar must have a bot search box');
  assert.ok(sidebarSrc.includes("t('sidebar.searchBotsPlaceholder'"), 'Bot search must use the i18n placeholder');
  assert.ok(sidebarSrc.includes("t('sidebar.noBotResults'"), 'Bot search must show an empty state');
  assert.ok(sidebarSrc.includes('bot-status'), 'Sidebar must render a running/idle dot per bot');
  assert.ok(sidebarSrc.includes('runningBotIds.has(bot.id)'), 'Dot must read the live running set');
  assert.ok(appSrc.includes('runningBotIds={runningBotIds}'), 'App must pass the running set to Sidebar');
  assert.ok((appSrc.match(/markBotRunning\(botId\)/g) ?? []).length >= 3, 'App must mark bots running on delta, tool call and send');
  assert.ok(appSrc.includes('clearBotRunning(botId)'), 'App must clear the running mark when a run settles');
});

// ---------------------------------------------------------------------------
// i18n: the new keys exist in both locales with matching placeholders
// ---------------------------------------------------------------------------

test('UI-8/9/11: new i18n keys exist in vi and en with matching placeholders', () => {
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of NEW_KEYS) {
    assert.ok(typeof vi[key] === 'string' && vi[key].length > 0, `vi.json must have ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en.json must have ${key}`);
    assert.deepEqual(placeholders(vi[key]), placeholders(en[key]), `${key} placeholders must match`);
  }
});
