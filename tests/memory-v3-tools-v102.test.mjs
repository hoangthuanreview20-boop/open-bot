/**
 * Tests for v1.02 (Team T2) — memory v3 tools:
 * packages/tools/src/memoryV3Tools.ts.
 *
 * Covers: tool registration (9 tools, unique names, approval flags),
 * fused search (multi-scope recall), one-pass ingest (ADD/UPDATE +
 * duplicate turn), temporal query, contradictions between windows,
 * entity timeline, sleep maintenance (dedupe via tool), block
 * history / restore / conflicts (list + resolve). Placeholder tools
 * (no store) refuse with a clear error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v3-tools-v102.test.mjs
 *
 * No network. No model (semantic source skipped: no embedder passed).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  MemoryBlockStore,
  BlockConflictStore,
} from '../packages/core/dist/index.js';
import {
  createMemoryV3Tools,
  MEMORY_V3_TOOLS,
  MEMORY_V3_TOOL_NAMES,
} from '../packages/tools/dist/memoryV3Tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv3-tools-v102-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = { botId: 'bot-a', runId: 'run-1' };

function makeTools() {
  const dir = makeTempDir();
  const graphStore = TemporalGraphStore.fromWorkspace(dir);
  const blocksStore = new MemoryBlockStore(dir);
  const tools = createMemoryV3Tools({ graphStore, workspaceDir: dir, blocksStore });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { dir, graphStore, blocksStore, tools, byName };
}

async function run(tool, args) {
  const out = await tool.execute(args, CTX);
  return JSON.parse(out);
}

test('registration: 9 tools, unique names, approval flags as designed', () => {
  assert.equal(MEMORY_V3_TOOLS.length, 9);
  assert.deepEqual([...MEMORY_V3_TOOL_NAMES], [
    'memory_v3_fused_search',
    'memory_v3_one_pass_ingest',
    'memory_v3_temporal_query',
    'memory_v3_contradictions',
    'memory_v3_entity_timeline',
    'memory_v3_sleep_maintenance',
    'memory_block_history',
    'memory_block_restore',
    'memory_block_conflicts',
  ]);
  const names = MEMORY_V3_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  const approval = new Map(MEMORY_V3_TOOLS.map((t) => [t.definition.name, t.needsApproval]));
  assert.equal(approval.get('memory_v3_fused_search'), false);
  assert.equal(approval.get('memory_v3_one_pass_ingest'), true);
  assert.equal(approval.get('memory_v3_temporal_query'), false);
  assert.equal(approval.get('memory_v3_contradictions'), false);
  assert.equal(approval.get('memory_v3_entity_timeline'), false);
  assert.equal(approval.get('memory_v3_sleep_maintenance'), true);
  assert.equal(approval.get('memory_block_history'), false);
  assert.equal(approval.get('memory_block_restore'), true);
  assert.equal(approval.get('memory_block_conflicts'), true);
  // Placeholders refuse cleanly instead of crashing.
  const placeholders = createMemoryV3Tools();
  assert.equal(placeholders.length, 9);
});

test('memory_v3_one_pass_ingest + memory_v3_fused_search: ADD then recall', async () => {
  const { byName } = makeTools();
  const ingest = await run(byName.get('memory_v3_one_pass_ingest'), { text: 'Tôi thích phở bò.', turnId: 'turn-1' });
  assert.equal(ingest.ingested, true);
  assert.equal(ingest.added, 1);
  assert.equal(ingest.modelCalls, 0);
  const dup = await run(byName.get('memory_v3_one_pass_ingest'), { text: 'Tôi thích phở bò.', turnId: 'turn-1' });
  assert.equal(dup.duplicate, true);
  const search = await run(byName.get('memory_v3_fused_search'), { query: 'likes' });
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0].fact.object, 'phở bò');
  assert.equal(search.hits[0].factScopeLevel, 'run');
  assert.ok(!('embedding' in search.hits[0].fact), 'no vector leaks to the model');
  const update = await run(byName.get('memory_v3_one_pass_ingest'), { text: 'Tôi thích bún chả.', turnId: 'turn-2' });
  assert.equal(update.updated, 1);
});

test('memory_v3_temporal_query + contradictions + entity_timeline', async () => {
  const { byName, graphStore } = makeTools();
  const scope = { userId: '', botId: 'bot-a', runId: 'run-1' };
  const at = (turnId, sourceText) => ({ episodeId: `ep-${turnId}`, turnId, runId: 'run-1', botId: 'bot-a', userId: '', at: '2026-11-03T10:00:00.000Z', sourceText });
  const old = graphStore.addFact({
    subjectName: 'user', predicate: 'lives_in', objectText: 'Hà Nội', confidence: 0.9,
    scope, provenance: at('t1', 'Tôi sống ở Hà Nội.'), validFrom: '2026-11-03T10:00:00.000Z',
  });
  // Superseded "now" (Nov 14): old fact valid Nov 3 -> Nov 14, new
  // fact valid from Nov 14. Window A = Nov 3-9, window B = Nov 12-16,
  // so the pair still contradicts across the two windows.
  graphStore.supersedeFact(old.id, {
    subjectName: 'user', predicate: 'lives_in', objectText: 'TP. Hồ Chí Minh', confidence: 0.95,
    scope, provenance: at('t2', 'Tôi đã chuyển vào TP. Hồ Chí Minh.'),
  });

  const lastWeek = await run(byName.get('memory_v3_temporal_query'), { at: '2026-11-05T00:00:00.000Z' });
  assert.ok(lastWeek.facts.some((f) => f.object === 'Hà Nội'), JSON.stringify(lastWeek));
  assert.ok(!lastWeek.facts.some((f) => f.object === 'TP. Hồ Chí Minh'));

  const contra = await run(byName.get('memory_v3_contradictions'), {
    windowAFrom: '2026-11-03T00:00:00.000Z',
    windowATo: '2026-11-09T00:00:00.000Z',
    windowBFrom: '2026-11-12T00:00:00.000Z',
    windowBTo: '2026-11-16T00:00:00.000Z',
  });
  assert.equal(contra.count, 1);
  assert.equal(contra.contradictions[0].earlier.object, 'Hà Nội');
  assert.equal(contra.contradictions[0].later.object, 'TP. Hồ Chí Minh');
  assert.ok(contra.contradictions[0].summary.includes('2026-11-03'));

  const timeline = await run(byName.get('memory_v3_entity_timeline'), { entity: 'user' });
  assert.equal(timeline.count, 2);
  assert.equal(timeline.steps[0].kind, 'superseded');
  assert.equal(timeline.steps[1].kind, 'active');
});

test('memory_v3_sleep_maintenance: dedupes via the tool', async () => {
  const { byName, graphStore } = makeTools();
  const scope = { userId: '', botId: 'bot-a', runId: 'run-1' };
  const prov = { episodeId: 'ep-1', turnId: 't1', runId: 'run-1', botId: 'bot-a', userId: '', at: '2026-11-14T08:00:00.000Z', sourceText: 'x' };
  graphStore.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở bò', confidence: 0.9, scope, provenance: prov });
  graphStore.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'pho bo', confidence: 0.7, scope, provenance: prov });
  const report = await run(byName.get('memory_v3_sleep_maintenance'), {});
  assert.equal(report.deduped, 1);
  assert.equal(report.promoted, 0);
  assert.equal(report.pruned, 0);
  assert.deepEqual(report.errors, []);
});

test('memory_block_history + restore + conflicts via tools', async () => {
  const { byName, blocksStore } = makeTools();
  const block = blocksStore.create({ label: 'human', content: 'original' }, 'user');
  blocksStore.replace(block.id, 'changed', 'user');
  const history = await run(byName.get('memory_block_history'), { block: 'human' });
  assert.equal(history.count, 2);
  assert.deepEqual(history.versions.map((v) => v.version), [1, 2]);

  const restored = await run(byName.get('memory_block_restore'), { block: 'human', version: 1 });
  assert.equal(restored.restored, true);
  assert.equal(restored.version, 3);
  assert.equal(restored.content, 'original');

  // A conflicting fact line against the block.
  blocksStore.replace(block.id, '- user: lives_in Hà Nội', 'user');
  // Record the conflict directly (the ingest path records it when a
  // promotion contradicts the block), then list/resolve via tools.
  const conflicts = new BlockConflictStore(blocksStore.dir);
  const conflict = conflicts.checkAndRecord(
    block.id, 'human', '- user: lives_in Hà Nội', 4, 'user', 'lives_in', 'TP. Hồ Chí Minh',
    { factId: 'fact-1', confidence: 0.95 },
  );
  const listed = await run(byName.get('memory_block_conflicts'), { action: 'list' });
  assert.equal(listed.pending, 1);
  assert.equal(listed.items[0].id, conflict.id);
  const resolved = await run(byName.get('memory_block_conflicts'), {
    action: 'resolve',
    conflictId: conflict.id,
    resolution: 'keep-current',
  });
  assert.equal(resolved.conflict.status, 'resolved');
  const listedAfter = await run(byName.get('memory_block_conflicts'), { action: 'list' });
  assert.equal(listedAfter.pending, 0);
});

test('tools without a store return an Error string, never throw', async () => {
  const placeholders = createMemoryV3Tools();
  const byName = new Map(placeholders.map((t) => [t.definition.name, t]));
  const out = await byName.get('memory_v3_fused_search').execute({ query: 'x' }, CTX);
  assert.ok(out.startsWith('Error:'), out);
  const out2 = await byName.get('memory_block_history').execute({ block: 'human' }, CTX);
  assert.ok(out2.startsWith('Error:'), out2);
});
