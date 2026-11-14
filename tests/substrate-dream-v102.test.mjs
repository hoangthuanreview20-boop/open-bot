/**
 * Tests for the v1.02 rescue substrate snapshots, Deep Dream and
 * job memory.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/substrate-dream-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DeepDreamEngine,
  DeepDreamScheduler,
  JobMemory,
  LongTermMemory,
  MemoryBlockStore,
  listBotSessionSnapshots,
  readBotSessionManifest,
  restoreBotSessionSnapshot,
  takeBotSessionSnapshot,
  verifyBotSessionSnapshot,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-substrate-v102-'));
}

test('substrate: snapshot copies files, skips sensitive files, verifies checksum, tamper refused', () => {
  const dir = tmpDir();
  const state = {
    botId: 'bot-1',
    config: { name: 'Bot' },
    memory: [{ role: 'user', content: 'hello', at: '2026-11-14T00:00:00Z' }],
    workDir: dir,
    createdAt: '2026-11-14T00:00:00Z',
  };
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'some notes');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'private key');
  const manifest = takeBotSessionSnapshot(dir, state);
  assert.ok(manifest.snapshotId.length > 0);
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.excludedFiles >= 2, 'sensitive files are counted as excluded');
  assert.equal(manifest.checksum.length, 64);
  const snapshots = listBotSessionSnapshots(dir, 'bot-1');
  assert.equal(snapshots.length, 1);
  const snapshotDir = path.join(dir, '.open-bot', 'bot-sessions', 'bot-1', 'snapshots', manifest.snapshotId);
  assert.deepEqual(verifyBotSessionSnapshot(snapshotDir), [], 'fresh snapshot verifies clean');
  assert.equal(readBotSessionManifest(snapshotDir)?.checksum, manifest.checksum);

  // Restore into a fresh dir.
  const target = tmpDir();
  const restored = restoreBotSessionSnapshot(snapshotDir, target);
  assert.equal(restored.botId, 'bot-1');
  assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'some notes');
  assert.equal(fs.existsSync(path.join(target, '.env')), false);
  // Tamper with the snapshot and the restore must refuse.
  fs.writeFileSync(path.join(snapshotDir, 'files', 'notes.txt'), 'tampered');
  assert.throws(() => restoreBotSessionSnapshot(snapshotDir, tmpDir()), /snapshot failed verification/);
});

test('dream: daily notes distill into facts and promote to the human block', async () => {
  const dir = tmpDir();
  const memory = new LongTermMemory(dir);
  const engine = new DeepDreamEngine({ workspaceDir: dir, memory });
  engine.notes.addNote('I always drink coffee in the morning.', 'test');
  engine.notes.addNote('I like tea in the afternoon.', 'test');
  engine.notes.addNote('Work on open-bot all day.', 'test');
  const report = await engine.runOnce();
  assert.equal(report.notesSeen, 3);
  assert.ok(report.factsExtracted > 0, 'daily notes yield facts');
  assert.ok(report.factsPromoted > 0, 'strong facts are promoted');
  const blocks = new MemoryBlockStore(dir);
  const human = blocks.get('human');
  assert.ok(human, 'human block was created');
  assert.match(human.content, /coffee/);

  // Second run on the same day yields nothing new.
  const report2 = await engine.runOnce();
  assert.equal(report2.factsExtracted, 0);
});

test('dream scheduler: ticks only at the configured hour', async () => {
  const dir = tmpDir();
  const memory = new LongTermMemory(dir);
  const engine = new DeepDreamEngine({ workspaceDir: dir, memory });
  const scheduler = new DeepDreamScheduler(engine, { hour: 3 });
  assert.ok(await scheduler.tick(new Date('2026-11-14T03:00:00Z')), 'runs at the configured hour');
  assert.equal(await scheduler.tick(new Date('2026-11-14T12:00:00Z')), null, 'other hours are skipped');
  assert.equal(await scheduler.tick(new Date('2026-11-14T03:00:00Z')), null, 'already ran today');
});

test('job memory: keyed facts per job, overwrite, forget, promote keepers', () => {
  const dir = tmpDir();
  const memory = new JobMemory({ jobId: 'build', filePath: path.join(dir, 'job-memory.json') });
  memory.remember('build-cmd', 'Use npm run build before testing.');
  memory.remember('dist-stale', 'The dist folder is stale after edits.', { keep: true });
  assert.equal(memory.size, 2);
  assert.equal(memory.get('build-cmd')?.value, 'Use npm run build before testing.');
  // Same key overwrites instead of duplicating.
  memory.remember('build-cmd', 'Use npm run build --workspace=@open-bot/core.');
  assert.equal(memory.size, 2);
  assert.equal(memory.get('build-cmd')?.value, 'Use npm run build --workspace=@open-bot/core.');
  assert.equal(memory.keepers().length, 1);
  assert.equal(memory.forget('build-cmd'), true);
  assert.equal(memory.size, 1);
  assert.equal(memory.forget('missing-key'), false);
  const reloaded = new JobMemory({ jobId: 'build', filePath: path.join(dir, 'job-memory.json') });
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.get('dist-stale')?.value, 'The dist folder is stale after edits.');
  // Promote the keepers into long-term memory.
  const longTerm = new LongTermMemory(dir);
  assert.equal(reloaded.promoteToLongTerm(longTerm, 'bot-1'), 1);
  assert.ok(longTerm.list().some((entry) => entry.key === 'dist-stale'));
});
