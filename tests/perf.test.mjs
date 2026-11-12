/**
 * Tests for the v0.4 perf module (packages/core/src/perf/) and the
 * ToolResultCache hook in ToolRegistry (packages/tools/src/registry.ts).
 *
 * Run after building the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/perf.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JobQueue } from '../packages/core/dist/perf/queue.js';
import { WorkerPool } from '../packages/core/dist/perf/pool.js';
import {
  ToolResultCache,
  cacheKeyFor,
  stableStringify,
  SUGGESTED_CACHEABLE_TOOLS,
} from '../packages/core/dist/perf/cache.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `cond()` until true or the timeout hits. */
async function waitFor(cond, timeoutMs = 5000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const CTX = { workspaceDir: '/tmp/open-bot-perf-test', botId: 'test-bot' };

function countingTool(name, result, { fail = false } = {}) {
  let calls = 0;
  const tool = {
    definition: {
      name,
      description: `Test tool ${name}.`,
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
    needsApproval: false,
    execute: async (args) => {
      calls += 1;
      if (fail) throw new Error('boom');
      return `${result}:${args.q ?? ''}`;
    },
  };
  return { tool, get calls() { return calls; } };
}

// ---------------------------------------------------------------------------
// ToolResultCache
// ---------------------------------------------------------------------------

test('cache: hit/miss, stable key (arg order does not matter), invalidate, clear', () => {
  const cache = new ToolResultCache({ defaultTtlMs: 60_000, maxEntries: 10 });
  assert.equal(cache.get('read_file', { path: 'a.txt' }), undefined);
  assert.equal(cache.stats().misses, 1);

  cache.set('read_file', { path: 'a.txt' }, 'content-a');
  // Same args in a different key order must hit the same entry.
  assert.equal(cache.get('read_file', { path: 'a.txt' }), 'content-a');
  assert.equal(cache.stats().hits, 1);
  assert.equal(
    cacheKeyFor('read_file', { a: 1, b: 2 }),
    cacheKeyFor('read_file', { b: 2, a: 1 }),
  );
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');

  // Different args = different entry.
  assert.equal(cache.get('read_file', { path: 'b.txt' }), undefined);
  cache.set('read_file', { path: 'b.txt' }, 'content-b');
  assert.equal(cache.size(), 2);

  // Invalidate one call, then the whole tool.
  cache.invalidate('read_file', { path: 'a.txt' });
  assert.equal(cache.get('read_file', { path: 'a.txt' }), undefined);
  assert.equal(cache.get('read_file', { path: 'b.txt' }), 'content-b');
  cache.invalidate('read_file');
  assert.equal(cache.size(), 0);

  cache.set('grep', { q: 'x' }, 'hit');
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.stats().hits, 0);
});

test('cache: entries expire after TTL', async () => {
  const cache = new ToolResultCache({ defaultTtlMs: 30, maxEntries: 10 });
  cache.set('read_file', { path: 'a.txt' }, 'v');
  assert.equal(cache.get('read_file', { path: 'a.txt' }), 'v');
  await sleep(50);
  assert.equal(cache.get('read_file', { path: 'a.txt' }), undefined);
  assert.equal(cache.has('read_file', { path: 'a.txt' }), false);
});

test('cache: LRU evicts the least-recently-used entry when full', () => {
  const cache = new ToolResultCache({ defaultTtlMs: 60_000, maxEntries: 3 });
  cache.set('t', { n: 1 }, 'one');
  cache.set('t', { n: 2 }, 'two');
  cache.set('t', { n: 3 }, 'three');
  // Touch n:1 so n:2 becomes the least recently used.
  assert.equal(cache.get('t', { n: 1 }), 'one');
  cache.set('t', { n: 4 }, 'four');
  assert.equal(cache.size(), 3);
  assert.equal(cache.get('t', { n: 2 }), undefined);
  assert.equal(cache.get('t', { n: 1 }), 'one');
  assert.equal(cache.get('t', { n: 4 }), 'four');
  assert.equal(cache.stats().evictions, 1);
});

test('cache: suggested allowlist contains only read-only tools', () => {
  for (const writeTool of ['write_file', 'shell_exec', 'git_commit', 'delete_file']) {
    assert.ok(!SUGGESTED_CACHEABLE_TOOLS.includes(writeTool), `${writeTool} must not be cacheable`);
  }
  assert.ok(SUGGESTED_CACHEABLE_TOOLS.includes('read_file'));
});

// ---------------------------------------------------------------------------
// JobQueue
// ---------------------------------------------------------------------------

test('queue: respects concurrency (max N running at once)', async () => {
  const queue = new JobQueue({ concurrency: 2 });
  let running = 0;
  let maxRunning = 0;
  const job = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(30);
    running -= 1;
    return 'ok';
  };
  const handles = [queue.enqueue(job), queue.enqueue(job), queue.enqueue(job), queue.enqueue(job)];
  const results = await Promise.all(handles.map((h) => h.promise));
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok']);
  assert.equal(maxRunning, 2);
  assert.deepEqual(queue.stats(), {
    pending: 0,
    running: 0,
    completed: 4,
    failed: 0,
    cancelled: 0,
    paused: false,
    concurrency: 2,
  });
});

test('queue: higher priority runs first, same priority stays FIFO', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const order = [];
  const mk = (label) => async () => {
    order.push(label);
    return label;
  };
  const h1 = queue.enqueue(mk('low'), { priority: 0 });
  const h2 = queue.enqueue(mk('high'), { priority: 10 });
  const h3 = queue.enqueue(mk('mid'), { priority: 5 });
  const h4 = queue.enqueue(mk('low2'), { priority: 0 });
  queue.resume();
  await Promise.all([h1.promise, h2.promise, h3.promise, h4.promise]);
  assert.deepEqual(order, ['high', 'mid', 'low', 'low2']);
});

test('queue: pause/resume stops new jobs until resumed', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  let started = 0;
  queue.pause();
  const h = queue.enqueue(async () => {
    started += 1;
    return 'done';
  });
  await sleep(30);
  assert.equal(started, 0);
  assert.equal(queue.stats().pending, 1);
  queue.resume();
  assert.equal(await h.promise, 'done');
  assert.equal(started, 1);
});

test('queue: cancel a pending job (never runs) and a running job (aborts)', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  let ran = 0;
  const first = queue.enqueue(async () => {
    await sleep(30);
    return 'first';
  });
  const pending = queue.enqueue(async () => {
    ran += 1;
    return 'never';
  });
  pending.cancel();
  await assert.rejects(pending.promise, /đã bị huỷ/);
  assert.equal(await first.promise, 'first');
  assert.equal(ran, 0);
  assert.equal(queue.stats().cancelled, 1);

  // Cancel a running job: the signal aborts, the job rejects.
  const running = queue.enqueue(async (signal) => {
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted by test')));
    });
  });
  await waitFor(() => queue.runningCount() === 1);
  running.cancel();
  await assert.rejects(running.promise, /aborted by test/);
  await queue.waitIdle();
  assert.equal(queue.stats().cancelled, 2);
});

test('queue: job timeout fails the job and frees the slot', async () => {
  const queue = new JobQueue({ concurrency: 1, defaultTimeoutMs: 30 });
  const slow = queue.enqueue(async (signal) => {
    // Ignores the abort on purpose: timeout must still fail it.
    await sleep(200);
    return 'too-late';
  });
  await assert.rejects(slow.promise, /hết thời gian chờ sau 30ms/);
  const fast = queue.enqueue(async () => 'fast');
  assert.equal(await fast.promise, 'fast');
  assert.equal(queue.stats().failed, 1);
  assert.equal(queue.stats().completed, 1);
});

test('queue: onJobDone/onJobFailed fire with job id + label', async () => {
  const done = [];
  const failed = [];
  const queue = new JobQueue({
    concurrency: 2,
    onJobDone: (id, label) => done.push([id, label]),
    onJobFailed: (id, err, label) => failed.push([id, err.message, label]),
  });
  const ok = queue.enqueue(async () => 'x', { label: 'good-job' });
  const bad = queue.enqueue(async () => {
    throw new Error('kaboom');
  }, { label: 'bad-job' });
  assert.equal(await ok.promise, 'x');
  await assert.rejects(bad.promise, /kaboom/);
  await queue.waitIdle();
  assert.equal(done.length, 1);
  assert.equal(done[0][1], 'good-job');
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1], 'kaboom');
  assert.equal(failed[0][2], 'bad-job');
});

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

test('pool: runs jobs in parallel up to size, waitAll + stats are correct', async () => {
  const pool = new WorkerPool({ size: 3, maxJobTimeMs: 5000 });
  let running = 0;
  let maxRunning = 0;
  const job = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(30);
    running -= 1;
    return 1;
  };
  const handles = Array.from({ length: 6 }, () => pool.submit(job));
  await pool.waitAll();
  const results = await Promise.all(handles.map((h) => h.promise));
  assert.deepEqual(results, [1, 1, 1, 1, 1, 1]);
  assert.equal(maxRunning, 3);
  const stats = pool.stats();
  assert.equal(stats.workers, 3);
  assert.equal(stats.completed, 6);
  assert.equal(stats.failed, 0);
  assert.equal(stats.busyWorkers, 0);
  assert.equal(stats.idleWorkers, 3);
  assert.equal(stats.effectiveConcurrency, 3);
});

test('pool: maxConcurrentToolExecs caps concurrency below size; per-job timeout applies', async () => {
  // maxJobTimeMs 200ms (không phải 40ms): job nhanh ngủ 20ms nhưng
  // dưới tải full suite, setTimeout 20ms có thể trễ hơn 40ms nên job
  // bị timeout oan dù pool chạy đúng (job chậm 500ms vẫn vượt 200ms
  // và phải reject với lỗi timeout — ý của test không đổi, chỉ nới
  // budget cho job nhanh).
  const pool = new WorkerPool({ size: 4, maxConcurrentToolExecs: 2, maxJobTimeMs: 200 });
  let running = 0;
  let maxRunning = 0;
  const job = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await sleep(20);
    running -= 1;
    return 'ok';
  };
  await Promise.all([pool.submit(job), pool.submit(job), pool.submit(job)].map((h) => h.promise));
  assert.equal(maxRunning, 2);
  assert.equal(pool.stats().effectiveConcurrency, 2);

  const slow = pool.submit(async () => {
    await sleep(500);
    return 'late';
  });
  await assert.rejects(slow.promise, /hết thời gian chờ sau 200ms/);
});

// ---------------------------------------------------------------------------
// ToolRegistry + cache hook
// ---------------------------------------------------------------------------

test('registry: without cache, execute() runs the tool every time (old behaviour)', async () => {
  const registry = new ToolRegistry();
  const c = countingTool('read_file', 'content');
  registry.register(c.tool);
  assert.equal(await registry.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(await registry.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(c.calls, 2);
  assert.equal(registry.cacheStats(), null);
  await assert.rejects(registry.execute('nope', {}, CTX), /Không rõ công cụ/);
});

test('registry: with cache, the 2nd identical call does not re-run the tool', async () => {
  const cache = new ToolResultCache({ defaultTtlMs: 60_000 });
  const registry = new ToolRegistry({ cache, cacheableTools: ['read_file'] });
  const c = countingTool('read_file', 'content');
  registry.register(c.tool);
  assert.equal(await registry.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(await registry.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(c.calls, 1);
  assert.equal(registry.cacheStats().hits, 1);
  // Different args = a real 2nd run.
  assert.equal(await registry.execute('read_file', { q: 'y' }, CTX), 'content:y');
  assert.equal(c.calls, 2);
});

test('registry: write tools are never cached even when a cache is attached', async () => {
  const cache = new ToolResultCache({ defaultTtlMs: 60_000 });
  // Deliberately attach a cache but do NOT list the write tool.
  const registry = new ToolRegistry({ cache, cacheableTools: ['read_file'] });
  const w = countingTool('write_file', 'written');
  registry.register(w.tool);
  assert.equal(registry.isCacheable('write_file'), false);
  assert.equal(await registry.execute('write_file', { q: 'a' }, CTX), 'written:a');
  assert.equal(await registry.execute('write_file', { q: 'a' }, CTX), 'written:a');
  assert.equal(w.calls, 2);
  assert.equal(cache.size(), 0);
});

test('registry: failed tool runs are not cached; clearCache() drops entries', async () => {
  const cache = new ToolResultCache({ defaultTtlMs: 60_000 });
  const registry = new ToolRegistry({ cache, cacheableTools: ['read_file'] });
  const c = countingTool('read_file', 'content', { fail: true });
  registry.register(c.tool);
  await assert.rejects(registry.execute('read_file', { q: 'x' }, CTX), /boom/);
  await assert.rejects(registry.execute('read_file', { q: 'x' }, CTX), /boom/);
  assert.equal(c.calls, 2);
  assert.equal(cache.size(), 0);

  // setCache() after construction works too.
  const registry2 = new ToolRegistry();
  const c2 = countingTool('read_file', 'content');
  registry2.register(c2.tool);
  registry2.setCache(cache, ['read_file']);
  assert.equal(await registry2.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(await registry2.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(c2.calls, 1);
  registry2.clearCache();
  assert.equal(await registry2.execute('read_file', { q: 'x' }, CTX), 'content:x');
  assert.equal(c2.calls, 2);
});
