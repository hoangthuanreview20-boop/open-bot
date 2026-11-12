/**
 * UI-10 + UI-12 tests (v0.60).
 *
 * UI-10 — onboarding first-run (no Electron needed):
 *   - the pure rules in apps/desktop/src/renderer/components/onboarding.ts:
 *     show only with zero bots and no done-flag; the flag round-trips
 *     through storage and never throws; the sample bot prefers the
 *     'general' template, skips the triage router, and falls back to a
 *     bare config when there is no template.
 *   - i18n: every key OnboardingView uses exists and is non-empty in
 *     both vi and en, with the same key set in both languages.
 *   - wiring (static): App renders OnboardingView behind the
 *     showOnboarding guard (chat view, list loaded, no bot, not done),
 *     creates the sample bot through saveBot, and marks the flag done
 *     on dismiss / first bot creation.
 *
 * UI-12 — IPC `plans:list` (no Electron needed for the reader itself):
 *   - the handler was already wired in main + preload + global.d.ts +
 *     PlanReviewView (v0.11/v0.18); v0.60 moved the reader out of
 *     main.ts into apps/desktop/src/main/plans.ts so it is testable.
 *   - REAL round-trip: core writes a plan file (writePlanFile, the same
 *     function plan_create uses) -> plans.ts parses it back with the
 *     right title/steps/decisions/status -> core records the decision
 *     (updatePlanFileStatus) -> the parser reads the decision back.
 *     That is the exact writer/reader contract the review screen relies
 *     on to show plans from previous sessions.
 *   - listStoredPlans: missing dir / empty workspace -> []; one corrupt
 *     file never breaks the list; newest first across bots.
 *   - static: main registers 'plans:list' and calls the moved reader,
 *     preload bridges it, global.d.ts types it, PlanReviewView invokes
 *     it, App passes the selected botId down.
 *
 * Run: node --test tests/ui-onboarding-plans-v060.test.mjs
 * (the core part needs packages/core/dist built, like the other core
 * tests; no network, no API key, no Electron.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ONBOARDING_DONE_KEY,
  SAMPLE_TEMPLATE_ID,
  buildSampleBotConfig,
  markOnboardingDone,
  pickSampleTemplate,
  readOnboardingDone,
  shouldShowOnboarding,
} from '../apps/desktop/src/renderer/components/onboarding.ts';
import {
  listStoredPlans,
  listStoredPlansForBots,
  parsePlanFile,
  planStatusFromText,
} from '../apps/desktop/src/main/plans.ts';
import {
  updatePlanFileStatus,
  writePlanFile,
} from '../packages/core/dist/agent/planning.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const read = (p) => fs.readFileSync(p, 'utf-8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ui10-ui12-'));
}

/** Minimal fake Storage (localStorage shape) for the flag helpers. */
function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    has: (k) => store.has(k),
  };
}

const GENERAL_TEMPLATE = {
  id: 'general',
  name: 'General Assistant',
  description: 'A general-purpose assistant.',
  category: 'general',
  systemPrompt: 'You are a helpful general-purpose assistant.',
  providerId: 'xai',
  model: '',
  suggestedTools: [],
};
const TRIAGE_TEMPLATE = {
  id: 'triage',
  name: 'Triage / Điều phối',
  description: 'Routes work to specialist bots.',
  category: 'general',
  systemPrompt: 'You only route work.',
  providerId: 'xai',
  suggestedTools: [],
};
const CODE_TEMPLATE = {
  id: 'code',
  name: 'Code Assistant',
  description: 'Write, review and refactor code.',
  category: 'code',
  systemPrompt: 'You are a senior software engineer.',
  providerId: 'xai',
  suggestedTools: [],
};

// ---------------------------------------------------------------------------
// UI-10: show / hide rules
// ---------------------------------------------------------------------------

test('UI-10: onboarding shows only with zero bots and no done-flag', () => {
  assert.equal(shouldShowOnboarding(0, false), true);
  assert.equal(shouldShowOnboarding(0, true), false);
  assert.equal(shouldShowOnboarding(1, false), false);
  assert.equal(shouldShowOnboarding(3, false), false);
  assert.equal(shouldShowOnboarding(1, true), false);
});

test('UI-10: done-flag round-trips through storage and never throws', () => {
  const storage = fakeStorage();
  assert.equal(readOnboardingDone(storage), false);
  markOnboardingDone(storage);
  assert.equal(readOnboardingDone(storage), true);
  assert.equal(storage.getItem(ONBOARDING_DONE_KEY), '1');
  // Null / throwing storage degrades to "not done" instead of crashing.
  assert.equal(readOnboardingDone(null), false);
  assert.equal(readOnboardingDone(undefined), false);
  assert.doesNotThrow(() => markOnboardingDone(null));
  const throwing = {
    getItem: () => {
      throw new Error('no storage');
    },
    setItem: () => {
      throw new Error('no storage');
    },
  };
  assert.equal(readOnboardingDone(throwing), false);
  assert.doesNotThrow(() => markOnboardingDone(throwing));
});

// ---------------------------------------------------------------------------
// UI-10: sample bot config
// ---------------------------------------------------------------------------

test('UI-10: sample bot prefers the general template', () => {
  assert.equal(SAMPLE_TEMPLATE_ID, 'general');
  assert.equal(pickSampleTemplate([CODE_TEMPLATE, GENERAL_TEMPLATE]), GENERAL_TEMPLATE);
  assert.equal(pickSampleTemplate([GENERAL_TEMPLATE, TRIAGE_TEMPLATE]), GENERAL_TEMPLATE);
});

test('UI-10: sample bot skips the triage router when general is missing', () => {
  assert.equal(pickSampleTemplate([TRIAGE_TEMPLATE, CODE_TEMPLATE]), CODE_TEMPLATE);
  assert.equal(pickSampleTemplate([TRIAGE_TEMPLATE]), undefined);
  assert.equal(pickSampleTemplate([]), undefined);
});

test('UI-10: sample bot config comes from the template, fallback is bare', () => {
  const fromTemplate = buildSampleBotConfig([CODE_TEMPLATE, GENERAL_TEMPLATE], 'Trợ lý mẫu');
  assert.equal(fromTemplate.name, 'Trợ lý mẫu');
  assert.equal(fromTemplate.providerId, 'xai');
  assert.equal(fromTemplate.systemPrompt, 'You are a helpful general-purpose assistant.');
  assert.equal(fromTemplate.approvalLevel, 'ask-for-writes');
  // No template at all: still a usable bare config (main fills the model).
  const bare = buildSampleBotConfig([], 'Sample Assistant');
  assert.equal(bare.name, 'Sample Assistant');
  assert.equal(bare.providerId, 'xai');
  assert.equal(bare.systemPrompt, '');
  assert.equal(bare.approvalLevel, 'ask-for-writes');
});

// ---------------------------------------------------------------------------
// UI-10: i18n keys used by OnboardingView exist in vi + en
// ---------------------------------------------------------------------------

test('UI-10: onboarding i18n keys exist, non-empty, same set in vi and en', () => {
  const used = [
    'onboarding.title',
    'onboarding.intro',
    'onboarding.step1Title',
    'onboarding.step1Text',
    'onboarding.step2Title',
    'onboarding.step2Text',
    'onboarding.step3Title',
    'onboarding.step3Text',
    'onboarding.createSample',
    'onboarding.creatingSample',
    'onboarding.createOwn',
    'onboarding.dismiss',
    'onboarding.keyHint',
    'onboarding.sampleBotName',
    // v0.72c (Team C): first-run model paths — keyless options first.
    // OnboardingView looks these up dynamically via onboardingModelPaths(),
    // so they are listed here explicitly rather than scanned from t('...').
    'onboarding.keylessTitle',
    'onboarding.pathCliTitle',
    'onboarding.pathCliText',
    'onboarding.pathOllamaTitle',
    'onboarding.pathOllamaText',
    'onboarding.pathKeyTitle',
    'onboarding.pathKeyText',
    'common.error',
  ];
  const dicts = {};
  for (const code of ['vi', 'en']) {
    const dict = JSON.parse(read(path.join(repo, 'apps/desktop/src/renderer/i18n/locales', `${code}.json`)));
    dicts[code] = dict;
    for (const key of used) {
      assert.equal(typeof dict[key], 'string', `${code} missing ${key}`);
      assert.ok(dict[key].length > 0, `${code} empty ${key}`);
    }
  }
  const viKeys = Object.keys(dicts.vi).filter((k) => k.startsWith('onboarding.')).sort();
  const enKeys = Object.keys(dicts.en).filter((k) => k.startsWith('onboarding.')).sort();
  assert.deepEqual(enKeys, viKeys);
  assert.equal(viKeys.length, 21); // 14 (v0.60) + 7 model-path keys (v0.72c)
});

// ---------------------------------------------------------------------------
// UI-10: App wiring (static — the live behaviour is the helpers above)
// ---------------------------------------------------------------------------

test('UI-10: App renders onboarding behind the first-run guard', () => {
  const app = read(path.join(repo, 'apps/desktop/src/renderer/App.tsx'));
  assert.match(app, /import OnboardingView from '\.\/components\/OnboardingView'/);
  assert.match(app, /shouldShowOnboarding\(bots\.length, onboardingDone\)/);
  assert.match(app, /view === 'chat' && botsLoaded && shouldShowOnboarding/);
  assert.match(app, /<OnboardingView/);
  assert.match(app, /onCreateSample=\{\(\) => void createSampleBot\(\)\}/);
  assert.match(app, /onDismiss=\{dismissOnboarding\}/);
  // Dismiss and first-bot creation both set the flag for good.
  assert.match(app, /markOnboardingDone\(safeLocalStorage\(\)\)/);
  assert.match(app, /if \(!config\.id\) \{\s*\n\s*markOnboardingDone/);
  // The guard needs the list to have really loaded (no flash for
  // existing users while bots are still loading).
  assert.match(app, /void loadBots\(\)\.finally\(\(\) => setBotsLoaded\(true\)\)/);
});

test('UI-10: OnboardingView offers sample / own bot / dismiss', () => {
  const view = read(path.join(repo, 'apps/desktop/src/renderer/components/OnboardingView.tsx'));
  assert.match(view, /onCreateSample/);
  assert.match(view, /onCreateBot/);
  assert.match(view, /onDismiss/);
  assert.match(view, /creatingSample/);
  assert.match(view, /onboarding\.createSample/);
  assert.match(view, /onboarding\.createOwn/);
  assert.match(view, /onboarding\.dismiss/);
  assert.match(view, /onboarding\.step1Title/);
  assert.match(view, /onboarding\.step2Title/);
  assert.match(view, /onboarding\.step3Title/);
  assert.match(view, /onboarding\.keyHint/);
});

// ---------------------------------------------------------------------------
// UI-12: status text mapping (the Vietnamese line in the plan file)
// ---------------------------------------------------------------------------

test('UI-12: planStatusFromText maps the file status line', () => {
  assert.equal(planStatusFromText('chờ duyệt'), 'pending');
  assert.equal(planStatusFromText('đã duyệt'), 'approved');
  assert.equal(planStatusFromText('đã duyệt lúc 2026-11-10'), 'approved');
  assert.equal(planStatusFromText('đã từ chối'), 'rejected');
  assert.equal(planStatusFromText('bị từ chối'), 'rejected');
  assert.equal(planStatusFromText('yêu cầu sửa'), 'changes-requested');
  assert.equal(planStatusFromText('cần sửa'), 'changes-requested');
  assert.equal(planStatusFromText('  ĐÃ DUYỆT  '), 'approved');
  assert.equal(planStatusFromText('không rõ'), 'pending');
});

test('UI-12: parsePlanFile rejects empty / heading-less files', () => {
  assert.equal(parsePlanFile('', 'x'), null);
  assert.equal(parsePlanFile('   \n', 'x'), null);
  assert.equal(parsePlanFile('no heading here\n- Project: `x`', 'x'), null);
});

// ---------------------------------------------------------------------------
// UI-12: REAL round-trip — core writes the plan file, plans.ts reads it
// ---------------------------------------------------------------------------

test('UI-12: plan written by core parses back with title/steps/decisions', () => {
  const ws = tmpDir();
  const filePath = writePlanFile(ws, {
    projectId: 'plan-abc',
    title: 'Xây tính năng X',
    detail: 'Mô tả ngắn.',
    steps: ['Khảo sát code', 'Viết code', 'Chạy test'],
    decisions: ['Dùng SQLite hay Postgres?'],
  });
  assert.equal(filePath, path.join(ws, '.open-bot', 'plans', 'plan-abc.md'));
  assert.ok(fs.existsSync(filePath));
  const parsed = parsePlanFile(fs.readFileSync(filePath, 'utf8'), 'plan-abc');
  assert.ok(parsed);
  assert.equal(parsed.projectId, 'plan-abc');
  assert.equal(parsed.title, 'Xây tính năng X');
  assert.equal(parsed.detail, 'Mô tả ngắn.');
  assert.deepEqual(parsed.steps, ['Khảo sát code', 'Viết code', 'Chạy test']);
  assert.deepEqual(parsed.decisions, ['Dùng SQLite hay Postgres?']);
  assert.equal(parsed.status, 'pending');
  assert.ok(!Number.isNaN(Date.parse(parsed.createdAt)));
});

test('UI-12: decision written by core reads back as decided', () => {
  const ws = tmpDir();
  writePlanFile(ws, {
    projectId: 'plan-decide',
    title: 'Kế hoạch cần duyệt',
    steps: ['Bước 1'],
    decisions: [],
  });
  for (const [decision, expected] of [
    ['approved', 'approved'],
    ['rejected', 'rejected'],
    ['changes-requested', 'changes-requested'],
  ]) {
    assert.equal(updatePlanFileStatus(ws, 'plan-decide', decision), true);
    const parsed = parsePlanFile(
      fs.readFileSync(path.join(ws, '.open-bot', 'plans', 'plan-decide.md'), 'utf8'),
      'plan-decide',
    );
    assert.ok(parsed);
    assert.equal(parsed.status, expected);
    // Back to pending for the next decision in the loop.
    const content = fs.readFileSync(path.join(ws, '.open-bot', 'plans', 'plan-decide.md'), 'utf8');
    fs.writeFileSync(
      path.join(ws, '.open-bot', 'plans', 'plan-decide.md'),
      content.replace(/^- Trạng thái duyệt:.*$/m, '- Trạng thái duyệt: chờ duyệt'),
      'utf8',
    );
  }
  // Unknown plan / empty workspace: no crash, just false.
  assert.equal(updatePlanFileStatus(ws, 'khong-co-plan', 'approved'), false);
  assert.equal(updatePlanFileStatus('', 'plan-decide', 'approved'), false);
});

test('UI-12: listStoredPlans lists a bot workspace, skips bad files', () => {
  const ws = tmpDir();
  // No plans dir at all -> empty, not an error.
  assert.deepEqual(listStoredPlans('bot-1', ws), []);
  assert.deepEqual(listStoredPlans('bot-1', ''), []);
  writePlanFile(ws, { projectId: 'plan-good', title: 'Kế hoạch tốt', steps: ['A'], decisions: [] });
  // Corrupt file (no heading) + non-md file: both skipped, good plan kept.
  const dir = path.join(ws, '.open-bot', 'plans');
  fs.writeFileSync(path.join(dir, 'plan-bad.md'), 'not a plan at all\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '# not a plan file\n', 'utf8');
  const plans = listStoredPlans('bot-1', ws);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].projectId, 'plan-good');
  assert.equal(plans[0].botId, 'bot-1');
  assert.equal(plans[0].status, 'pending');
  assert.equal(plans[0].filePath, path.join(dir, 'plan-good.md'));
  assert.equal(plans[0].path, plans[0].filePath);
  assert.ok(plans[0].updatedAt.length > 0);
});

test('UI-12: listStoredPlansForBots merges bots, newest first', () => {
  const wsA = tmpDir();
  const wsB = tmpDir();
  writePlanFile(wsA, { projectId: 'plan-old', title: 'Cũ', steps: [], decisions: [] });
  writePlanFile(wsB, { projectId: 'plan-new', title: 'Mới', steps: [], decisions: [] });
  // Force the mtimes so "new" really is newer regardless of write order.
  const now = Date.now();
  fs.utimesSync(path.join(wsA, '.open-bot', 'plans', 'plan-old.md'), new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(path.join(wsB, '.open-bot', 'plans', 'plan-new.md'), new Date(now), new Date(now));
  const plans = listStoredPlansForBots([
    { id: 'bot-a', workspaceDir: wsA },
    { id: 'bot-b', workspaceDir: wsB },
  ]);
  assert.deepEqual(
    plans.map((p) => p.projectId),
    ['plan-new', 'plan-old'],
  );
  assert.deepEqual(
    plans.map((p) => p.botId),
    ['bot-b', 'bot-a'],
  );
});

// ---------------------------------------------------------------------------
// UI-12: IPC wiring (static — the behaviour is the round-trip above)
// ---------------------------------------------------------------------------

test('UI-12: plans:list is wired main -> preload -> types -> PlanReviewView', () => {
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  assert.match(main, /ipcMain\.handle\(\s*'plans:list'/);
  assert.match(main, /listStoredPlansForBots\(withDirs\)/);
  assert.match(main, /import \{ listStoredPlansForBots, type StoredPlan \} from '\.\/plans'/);
  const plansModule = read(path.join(repo, 'apps/desktop/src/main/plans.ts'));
  assert.match(plansModule, /export function listStoredPlansForBots/);
  assert.match(plansModule, /export function parsePlanFile/);
  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  assert.match(preload, /'plans:list': \(payload\) => ipcRenderer\.invoke\('plans:list', payload\)/);
  const globalDts = read(path.join(repo, 'apps/desktop/src/renderer/global.d.ts'));
  assert.match(globalDts, /'plans:list'\(payload\?: \{ botId\?: string \}\)/);
  const view = read(path.join(repo, 'apps/desktop/src/renderer/components/PlanReviewView.tsx'));
  assert.match(view, /window\.openBot\['plans:list'\]/);
  // App passes the selected bot down so the view lists that bot's plans.
  const app = read(path.join(repo, 'apps/desktop/src/renderer/App.tsx'));
  assert.match(app, /botId=\{selectedBotId\}/);
});

// ---------------------------------------------------------------------------
// W4 follow-up: chat:send seeds the run with the selected thread's history
// ---------------------------------------------------------------------------

test('W4 follow-up: chat:send passes the selected threadId into run()', () => {
  // main.ts cannot be imported in node (Electron), so — like the UI-2
  // chat:send assertions in ui-markdown-stop-v059 — this is a static
  // contract test. The behaviour (thread history actually seeding the
  // run) is covered by tests/thread-history-seed.test.mjs at the core
  // level: RunParams.threadId -> executeRun -> thread messages as
  // context, empty thread runs as before, unknown thread fails fast.
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  // The handler already validates the thread from the payload and saves
  // both messages of the turn into it (v0.59 UI-5).
  assert.match(main, /ipcMain\.handle\(\s*'chat:send'/);
  assert.match(main, /const threadId =\s*\n\s*typeof payload\?\.threadId === 'string'/);
  // v0.65 (vision persistence): the user message is saved with its
  // attachments, so a reload shows the images again (not just the
  // file name) — the call gained the `attachments` argument.
  assert.match(main, /await syncMessageToMemory\(runtime, userMsg, threadId, attachments\)/);
  // ... and now the same threadId seeds the run itself (attachments
  // may ride along in the same options object — v0.64 vision; the
  // spread `{ attachments }` contains a `}` of its own, so do not
  // anchor on the object's closing brace).
  assert.match(main, /getCoordinator\(\)\.run\(bot\.id, text, undefined, \{[\s\S]*?threadId,/);
  // The client forwards it (only when defined) and the core type carries it.
  const client = read(path.join(repo, 'packages/core/src/coordinator/client.ts'));
  assert.match(client, /\.\.\.\(opts\?\.threadId !== undefined \? \{ threadId: opts\.threadId \} : \{\}\)/);
  const types = read(path.join(repo, 'packages/core/src/coordinator/types.ts'));
  assert.match(types, /threadId\?: string;/);
});
