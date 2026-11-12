/**
 * Core tests for v0.82 — group bot status survives restart as
 * `interrupted` (follow-up 3b).
 *
 *   - Tracker with a file: markRunning persists a snapshot;
 *     a NEW tracker on the same file restores the entry as
 *     `interrupted` — NEVER as `running` (the old process is dead;
 *     showing "replying…" for it would be a lie).
 *   - markRunning again clears the interruption; markIdle clears it;
 *     clearInterrupted (Dismiss) clears it AND rewrites the file so
 *     the next restart does not resurrect it.
 *   - Corrupt / wrong-version / missing files load as empty, never throw.
 *   - Coordinator end-to-end: a snapshot file seeded in dataDir (as
 *     the previous process left it) surfaces via getGroupBotStatus as
 *     `interrupted`, and dismissGroupBotInterrupted clears it for
 *     good (a fresh coordinator on the same dir still sees none).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/group-bot-status-v082.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  GROUP_BOT_STATUS_FILE_NAME,
  GroupBotStatusTracker,
} from '../packages/core/dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSnapshot(dir) {
  const file = path.join(dir, GROUP_BOT_STATUS_FILE_NAME);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('tracker without a file: pure in-memory, no interrupted ever', () => {
  const tracker = new GroupBotStatusTracker();
  tracker.markRunning('g1', 'bot-a');
  assert.equal(tracker.getStatus('g1').length, 1);
  assert.deepEqual(tracker.getInterrupted('g1'), []);
  tracker.markIdle('g1', 'bot-a');
  assert.deepEqual(tracker.getStatus('g1'), []);
  assert.deepEqual(tracker.getInterrupted('g1'), []);
});

test('tracker with a file: restart turns running into interrupted, never running', () => {
  const dir = makeTempDir('open-bot-v082-groupstatus-');
  const file = path.join(dir, GROUP_BOT_STATUS_FILE_NAME);
  try {
    const first = new GroupBotStatusTracker({ filePath: file });
    first.markRunning('g1', 'bot-a');
    first.markRunning('g1', 'bot-b');
    const snapshot = readSnapshot(dir);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.running.length, 2);
    assert.deepEqual(
      snapshot.running.map((e) => e.botId).sort(),
      ['bot-a', 'bot-b'],
    );

    // "Restart": a new tracker on the same file.
    const second = new GroupBotStatusTracker({ filePath: file });
    assert.deepEqual(second.getStatus('g1'), [], 'nothing is running in the new process');
    const interrupted = second.getInterrupted('g1');
    assert.equal(interrupted.length, 2);
    assert.deepEqual(interrupted.map((e) => e.botId).sort(), ['bot-a', 'bot-b']);
    assert.ok(interrupted.every((e) => !Number.isNaN(Date.parse(e.since))), 'since is kept');
    // The original `since` survives the restart (not "now").
    assert.equal(interrupted.find((e) => e.botId === 'bot-a').since, snapshot.running.find((e) => e.botId === 'bot-a').since);

    // Bot-a runs again: its interruption clears, bot-b stays interrupted.
    second.markRunning('g1', 'bot-a');
    assert.deepEqual(second.getInterrupted('g1').map((e) => e.botId), ['bot-b']);
    assert.deepEqual(second.getStatus('g1').map((e) => e.botId), ['bot-a']);

    // Dismiss bot-b: gone from memory AND from the file, so the next
    // restart does not resurrect it.
    second.clearInterrupted('g1', 'bot-b');
    assert.deepEqual(second.getInterrupted('g1'), []);
    assert.deepEqual(readSnapshot(dir).running.map((e) => e.botId), ['bot-a']);

    // A third tracker ("second restart") sees bot-a running (it was
    // persisted by markRunning) — as interrupted again, not running.
    const third = new GroupBotStatusTracker({ filePath: file });
    assert.deepEqual(third.getStatus('g1'), []);
    assert.deepEqual(third.getInterrupted('g1').map((e) => e.botId), ['bot-a']);
    third.markIdle('g1', 'bot-a');
    assert.deepEqual(third.getInterrupted('g1'), []);
    assert.deepEqual(readSnapshot(dir).running, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tracker with a file: corrupt / wrong-version / missing file loads empty', () => {
  const dir = makeTempDir('open-bot-v082-groupstatus-bad-');
  const file = path.join(dir, GROUP_BOT_STATUS_FILE_NAME);
  try {
    fs.writeFileSync(file, '{not json', 'utf8');
    assert.deepEqual(new GroupBotStatusTracker({ filePath: file }).getInterrupted('g1'), []);
    fs.writeFileSync(file, JSON.stringify({ version: 99, running: [{ groupId: 'g1', botId: 'bot-a', since: new Date().toISOString() }] }), 'utf8');
    assert.deepEqual(new GroupBotStatusTracker({ filePath: file }).getInterrupted('g1'), []);
    fs.writeFileSync(file, JSON.stringify({ version: 1, running: [{ groupId: 'g1', botId: 'bot-a', since: 'not-a-date' }] }), 'utf8');
    assert.deepEqual(new GroupBotStatusTracker({ filePath: file }).getInterrupted('g1'), []);
    // Missing file: first markRunning creates it.
    fs.rmSync(file);
    const tracker = new GroupBotStatusTracker({ filePath: file });
    assert.deepEqual(tracker.getInterrupted('g1'), []);
    tracker.markRunning('g1', 'bot-a');
    assert.ok(fs.existsSync(file), 'snapshot file is created on first transition');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator: seeded snapshot -> interrupted; dismiss clears it for good', async () => {
  const dataDir = makeTempDir('open-bot-v082-groupstatus-coord-');
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    const ws = path.join(dataDir, 'ws', 'bot-a');
    fs.mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id: 'bot-a', name: 'Bot A', providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: 'hi' }] },
    });
    const { group } = coordinator.createGroupChat({ name: 'Nhóm việc', botIds: ['bot-a'] });
    // Simulate the previous process: it left a `running` snapshot behind.
    const since = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(dataDir, GROUP_BOT_STATUS_FILE_NAME),
      JSON.stringify({ version: 1, running: [{ groupId: group.id, botId: 'bot-a', since }] }),
      'utf8',
    );
    const status = coordinator.getGroupBotStatus({ groupId: group.id });
    assert.deepEqual(status.running, []);
    assert.deepEqual(status.interrupted, [{ botId: 'bot-a', since }]);

    const dismissed = coordinator.dismissGroupBotInterrupted({ groupId: group.id, botId: 'bot-a' });
    assert.deepEqual(dismissed, { groupId: group.id, botId: 'bot-a', dismissed: true });
    assert.deepEqual(coordinator.getGroupBotStatus({ groupId: group.id }).interrupted, []);
    assert.deepEqual(readSnapshot(dataDir).running, [], 'dismiss rewrites the snapshot file');

    // A fresh coordinator on the same dir ("another restart") still sees none.
    const second = new AgentCoordinator({ dataDir, emit: () => {} });
    try {
      assert.deepEqual(second.getGroupBotStatus({ groupId: group.id }).interrupted, []);
    } finally {
      second.shutdown();
    }
    assert.throws(() => coordinator.dismissGroupBotInterrupted({ groupId: 'nope', botId: 'bot-a' }), /Không thấy nhóm chat/);
    assert.throws(() => coordinator.dismissGroupBotInterrupted({ groupId: group.id }), /cần params/);
  } finally {
    coordinator.shutdown();
  }
});
