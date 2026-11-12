/**
 * Tests for v0.51 — M7 tool cap wired into the real turn (nợ từ v0.49):
 *   `applyAppToolCaps` existed with unit tests, but `AgentRunner`/loop
 *   never called it — app tools only went through `filterTools`.
 *
 * These tests drive a REAL turn with a mock provider that records the
 * definitions sent to the model:
 *   1. loop: an app with 12 tools is cut to the default cap 10, catalog
 *      order kept, non-app tools untouched, dropped tools reported
 *      (log + progress event), token saving measured like v0.29.
 *   2. loop: per-app override from SharedAppAuthStore (`setToolCap` →
 *      `getToolCaps()`) is honoured.
 *   3. loop: without `appToolCaps` the old behaviour is unchanged
 *      (no cap — regression guard for hosts that did not wire it).
 *   4. coordinator: `apps.setToolCap` RPC + a real `coordinator.run()`
 *      turn — the recorded mock request shows the Slack dispatcher
 *      with only the first 2 members, Gmail untouched, and the cap
 *      surfaces in `listStatuses` + a `progress` agent.event.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/apps-m7-cap-loop-v051.test.mjs
 *
 * No live network, no real accounts or credentials.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { estimateToolsTokens } from '../packages/core/dist/agent/toolFilter.js';
import {
  AppRegistry,
  SharedAppAuthStore,
} from '../packages/core/dist/apps/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** In-memory TokenStore (fake Vault) for the auth-store test. */
function memoryTokenStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getToken(id) {
      const v = map.get(id);
      return v ? { ...v } : null;
    },
    async setToken(id, token) {
      map.set(id, { ...token });
    },
    async clearToken(id) {
      map.delete(id);
    },
  };
}

function makeTool(name, description = `Tool ${name} for testing.`) {
  return {
    definition: {
      name,
      description,
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
    needsApproval: false,
    async execute() {
      return `ok:${name}`;
    },
  };
}

/** Registry with one 12-tool app ('big') — the default cap (10) must cut it. */
function bigRegistry() {
  const registry = new AppRegistry();
  registry.register({
    id: 'big',
    label: 'Big',
    description: '',
    icon: 'B',
    authType: 'none',
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `big_tool_${i + 1}`,
      description: `Big tool ${i + 1}.`,
      needsApproval: false,
    })),
  });
  return registry;
}

function bigTools() {
  return [
    ...Array.from({ length: 12 }, (_, i) => makeTool(`big_tool_${i + 1}`)),
    makeTool('read_file'),
    makeTool('shell_exec'),
  ];
}

function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seenRequests.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents() {
  const events = {
    texts: [],
    toolCalls: [],
    toolResults: [],
    progress: [],
    onText(d) {
      events.texts.push(d);
    },
    onToolCall(c) {
      events.toolCalls.push(c);
    },
    onToolResult(r) {
      events.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
    onProgress(m) {
      events.progress.push(m);
    },
  };
  return events;
}

function makeBot(workspaceDir) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

/** Run one turn capturing console.warn (restored afterwards). */
async function runWithWarnCapture(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => {
    warns.push(args.join(' '));
  };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------------------
// Loop: cap applies in a real turn
// ---------------------------------------------------------------------------

test('v0.51 loop cap: app with 12 tools is cut to default 10, order kept, non-app tools untouched', async () => {
  const dir = tmpDir('open-bot-cap-loop-');
  const registry = bigRegistry();
  const tools = bigTools();
  const seenRequests = [];
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider([{ text: 'ok' }], seenRequests), tools, {
    bot: makeBot(dir),
    events,
    toolFilter: { group: false },
    appToolCaps: { registry },
  });
  const { warns } = await runWithWarnCapture(() => runner.run('hello'));
  assert.equal(seenRequests.length, 1, 'one provider call');
  const sentNames = seenRequests[0].tools.map((d) => d.name);
  assert.deepEqual(sentNames, [
    ...Array.from({ length: 10 }, (_, i) => `big_tool_${i + 1}`),
    'read_file',
    'shell_exec',
  ]);
  // Dropped tools are reported clearly: log + UI (progress) event, once.
  const capWarn = warns.find((w) => w.includes('app tool cap'));
  assert.ok(capWarn, 'cap must log a warning');
  assert.match(capWarn, /App "big"/);
  assert.match(capWarn, /big_tool_11/);
  assert.match(capWarn, /big_tool_12/);
  assert.equal(events.progress.length, 1, 'one progress event for the cut');
  assert.match(events.progress[0], /App "big"/);
  assert.match(events.progress[0], /big_tool_11, big_tool_12/);
  // Token saving, measured like v0.29 (estimateToolsTokens, chars/4).
  const before = estimateToolsTokens(tools);
  const after = estimateToolsTokens(seenRequests[0].tools);
  const saved = before - after;
  assert.ok(
    saved > 0,
    `cap must save tokens: ${before} → ${after} (saved ${saved})`,
  );
  assert.ok(after < before * 0.95, `saving should be material, got ${before} → ${after}`);
});

test('v0.51 loop cap: per-app override from SharedAppAuthStore (setToolCap → getToolCaps) wins', async () => {
  const dir = tmpDir('open-bot-cap-loop-');
  const registry = bigRegistry();
  const store = new SharedAppAuthStore({ store: memoryTokenStore(), registry });
  store.setToolCap('big', 2);
  assert.deepEqual(store.getToolCaps(), { big: 2 });
  const seenRequests = [];
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider([{ text: 'ok' }], seenRequests), bigTools(), {
    bot: makeBot(dir),
    events,
    toolFilter: { group: false },
    appToolCaps: { capsByApp: store.getToolCaps(), registry },
  });
  await runner.run('hello');
  assert.deepEqual(
    seenRequests[0].tools.map((d) => d.name),
    ['big_tool_1', 'big_tool_2', 'read_file', 'shell_exec'],
  );
  assert.match(events.progress[0], /cap 2 tool\/turn/);
  assert.match(events.progress[0], /big_tool_3/);
});

test('v0.51 loop cap: no appToolCaps option → old behaviour, nothing is cut', async () => {
  const dir = tmpDir('open-bot-cap-loop-');
  const seenRequests = [];
  const events = makeEvents();
  const runner = new AgentRunner(scriptedProvider([{ text: 'ok' }], seenRequests), bigTools(), {
    bot: makeBot(dir),
    events,
    toolFilter: { group: false },
  });
  await runner.run('hello');
  assert.equal(seenRequests[0].tools.length, 14, 'all 12 app tools + 2 non-app tools reach the model');
  assert.equal(events.progress.length, 0, 'no cap report without cap config');
});

// ---------------------------------------------------------------------------
// Coordinator: cap from the shared auth store reaches a real run
// ---------------------------------------------------------------------------

test('v0.51 coordinator cap: apps.setToolCap RPC cuts Slack to 2 in a real run, Gmail untouched', async () => {
  const dataDir = tmpDir('open-bot-cap-coord-');
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const recordPath = path.join(dataDir, 'mock-record.jsonl');
  const progressEvents = [];
  const coordinator = new AgentCoordinator({
    dataDir,
    emit: (notification) => {
      if (notification.event === 'agent.event' && notification.data?.kind === 'progress') {
        progressEvents.push(notification.data.payload);
      }
    },
  });
  try {
    await coordinator.createBot({
      bot: {
        id: 'bot-cap',
        name: 'Bot Cap',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: true,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [{ text: 'xong' }],
        mockRecordPath: recordPath,
      },
    });

    // Cap Slack to 2 via RPC (default is 10, Slack has 3 tools).
    const capped = await coordinator.handle('apps.setToolCap', { appId: 'slack', cap: 2 });
    assert.equal(capped.toolCap, 2);
    assert.deepEqual(capped.cappedOutToolNames, ['slack_read']);
    assert.equal(capped.exposedToolCount, 2);

    const result = await coordinator.run({ botId: 'bot-cap', text: 'hello' });
    assert.equal(result.text, 'xong');

    // The mock recorded the exact request the loop sent to the model.
    const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'one provider call recorded');
    const defs = JSON.parse(lines[0]).tools;
    assert.ok(Array.isArray(defs) && defs.length > 0, 'definitions were sent');
    const names = defs.map((d) => d.name);
    // Grouping is on in coordinator runs: Slack's tools arrive as one
    // `slack` dispatcher whose description lists its members in order.
    const slack = defs.find((d) => d.name === 'slack');
    assert.ok(slack, 'slack dispatcher must be sent');
    const slackMembers = slack.description.match(/Thành viên: ([^.]+)\./)?.[1].split(', ');
    assert.deepEqual(slackMembers, ['slack_send', 'slack_list_channels']);
    assert.ok(!names.includes('slack_read'), 'cut tool must not reach the model');
    assert.ok(
      !defs.some((d) => (d.description ?? '').includes('slack_read')),
      'cut tool must not leak into any dispatcher description',
    );
    // Gmail (default cap 10, 2 tools) is untouched.
    const email = defs.find((d) => d.name === 'email');
    assert.ok(email, 'gmail dispatcher must be sent');
    const emailMembers = email.description.match(/Thành viên: ([^.]+)\./)?.[1].split(', ');
    assert.deepEqual(emailMembers, ['email_read', 'email_send']);
    // A non-app group is untouched too.
    assert.ok(names.includes('file'), 'non-app tools must be untouched');

    // The cut is reported to the UI as a progress event…
    assert.ok(progressEvents.length >= 1, 'cap must emit a progress event');
    assert.match(progressEvents.join('\n'), /App "slack"/);
    assert.match(progressEvents.join('\n'), /slack_read/);
    // …and visible in listStatuses.
    const statuses = await coordinator.handle('apps.listStatuses', {});
    const slackStatus = statuses.find((s) => s.app.id === 'slack');
    assert.equal(slackStatus.toolCap, 2);
    assert.deepEqual(slackStatus.cappedOutToolNames, ['slack_read']);

    // Bad params are clear errors, not silent no-ops.
    await assert.rejects(
      coordinator.handle('apps.setToolCap', { appId: 'nope', cap: 2 }),
      /Không rõ app/,
    );
    await assert.rejects(
      coordinator.handle('apps.setToolCap', { appId: 'slack', cap: 0 }),
      /1\.\.100/,
    );
  } finally {
    coordinator.shutdown();
  }
});
