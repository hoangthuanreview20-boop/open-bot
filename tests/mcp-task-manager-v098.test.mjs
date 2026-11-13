/**
 * MCP TaskManager tests (v0.98, sóng T6 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/taskManager.ts (multi-task orchestration
 * on top of TaskHandle in ./tasks.ts) with fake transports:
 *  - create/track: working -> completed (2025-11-25 via tasks/result,
 *    and 2026-07-28 via inline result in tasks/get)
 *  - failed / cancelled snapshots, cancel + cancelAll
 *  - timeout: snapshot timedOut + failed + server-side cancel attempted
 *  - input_required (2026): sendInput + resume to completion; 2025
 *    sendInput is refused with a clear error
 *  - waitFor / list / get / activeCount / pruneTerminal / maxTracked
 *  - onChange events
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-task-manager-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { McpTaskManager } from '../packages/core/dist/mcp/taskManager.js';
import { TaskHandle } from '../packages/core/dist/mcp/tasks.js';

/** Fake transport: scripted answers per method, records every call. */
function makeTransport(script) {
  const calls = [];
  const counters = new Map();
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const n = (counters.get(method) ?? 0) + 1;
      counters.set(method, n);
      const handler = script[method];
      if (typeof handler !== 'function') throw new Error(`unexpected method ${method}`);
      const out = handler(n, params);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const handle = (overrides = {}) => ({ taskId: 't-1', status: 'working', pollInterval: 5, ...overrides });

/** Transport whose tasks/get walks a status list, then stays at the last one. */
function pollingTransport(statuses, resultPayload) {
  return makeTransport({
    'tasks/get': (n) => {
      const status = statuses[Math.min(n - 1, statuses.length - 1)];
      const out = { taskId: 't-1', status, pollInterval: 5 };
      if (status === 'completed') out.result = resultPayload;
      return out;
    },
    'tasks/result': () => resultPayload,
    'tasks/cancel': () => ({ taskId: 't-1', status: 'cancelled' }),
    'tasks/update': () => ({ taskId: 't-1', status: 'working', pollInterval: 5 }),
  });
}

async function waitForSnapshot(manager, key, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = manager.get(key);
    if (snap && predicate(snap)) return snap;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${key} (last: ${JSON.stringify(snap)})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// create / track / completion
// ---------------------------------------------------------------------------

test('tasks: track working -> completed keeps the tasks/result payload', async () => {
  const transport = pollingTransport(['working', 'completed'], { content: [{ type: 'text', text: 'done' }] });
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  assert.equal(snap.key, 'fake:t-1');
  assert.equal(snap.status, 'working');
  const done = await manager.waitFor(snap.key);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { content: [{ type: 'text', text: 'done' }] });
  assert.equal(manager.activeCount(), 0);
  assert.equal(transport.calls.filter((c) => c.method === 'tasks/get').length, 2);
});

test('tasks: 2026-07-28 completed reads the inline result (no tasks/result call)', async () => {
  const transport = pollingTransport(['working', 'completed'], { value: 42 });
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle(), { specVersion: '2026-07-28' });
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow', specVersion: '2026-07-28' });
  const done = await manager.waitFor(snap.key);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { value: 42 });
  assert.equal(transport.calls.filter((c) => c.method === 'tasks/result').length, 0);
});

test('tasks: failed snapshot keeps the error, task stays listed', async () => {
  const transport = pollingTransport(['working', 'failed'], undefined);
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  const done = await manager.waitFor(snap.key);
  assert.equal(done.status, 'failed');
  assert.match(done.error ?? '', /thất bại/);
  assert.equal(manager.list().length, 1);
});

test('tasks: create() sends _meta.task and tracks the returned handle', async () => {
  const transport = makeTransport({
    'tools/call': (_n, params) => {
      assert.ok(params._meta && typeof params._meta.task === 'object', 'createTask must add _meta.task');
      return { taskId: 't-9', status: 'working', pollInterval: 5 };
    },
    'tasks/get': () => ({ taskId: 't-9', status: 'completed', pollInterval: 5, result: { ok: true } }),
    'tasks/result': () => ({ ok: true }),
    'tasks/cancel': () => ({ taskId: 't-9', status: 'cancelled' }),
  });
  const manager = new McpTaskManager();
  const snap = await manager.create(
    transport,
    'tools/call',
    { name: 'slow', arguments: { x: 1 } },
    { serverName: 'fake', method: 'tools/call', label: 'slow' },
  );
  assert.equal(snap.key, 'fake:t-9');
  const done = await manager.waitFor(snap.key);
  assert.equal(done.status, 'completed');
});

// ---------------------------------------------------------------------------
// cancel / timeout
// ---------------------------------------------------------------------------

test('tasks: cancel stops the wait loop and marks the task cancelled', async () => {
  const transport = pollingTransport(['working', 'working', 'working'], undefined);
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  // Let the loop start polling, then cancel.
  await new Promise((r) => setTimeout(r, 30));
  const cancelled = await manager.cancel(snap.key);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(transport.calls.some((c) => c.method === 'tasks/cancel'), 'server-side cancel must be attempted');
  assert.equal(manager.activeCount(), 0);
  // Cancelling a terminal task is a no-op returning the snapshot.
  const again = await manager.cancel(snap.key);
  assert.equal(again.status, 'cancelled');
});

test('tasks: cancelAll cancels every active task', async () => {
  const manager = new McpTaskManager();
  const keys = [];
  for (let i = 0; i < 2; i += 1) {
    const transport = pollingTransport(['working'], undefined);
    const h = new TaskHandle(transport, { taskId: `t-${i}`, status: 'working', pollInterval: 5 });
    keys.push(manager.track(h, { serverName: 'fake', method: 'tools/call', label: `slow-${i}` }).key);
  }
  assert.equal(manager.activeCount(), 2);
  await manager.cancelAll();
  assert.equal(manager.activeCount(), 0);
  for (const key of keys) assert.equal(manager.get(key)?.status, 'cancelled');
});

test('tasks: timeout marks failed + timedOut and cancels on the server', async () => {
  const transport2 = makeTransport({
    'tools/call': () => ({ taskId: 't-2', status: 'working', pollInterval: 5 }),
    'tasks/get': () => ({ taskId: 't-2', status: 'working', pollInterval: 5 }),
    'tasks/cancel': () => ({ taskId: 't-2', status: 'cancelled' }),
  });
  const manager2 = new McpTaskManager();
  const snap2 = await manager2.create(
    transport2,
    'tools/call',
    { name: 'slow', arguments: {} },
    { serverName: 'fake', method: 'tools/call', label: 'slow', timeoutMs: 120 },
  );
  const done = await waitForSnapshot(manager2, snap2.key, (s) => s.status === 'failed');
  assert.equal(done.timedOut, true);
  assert.match(done.error ?? '', /hết thời gian chờ/);
  assert.ok(transport2.calls.some((c) => c.method === 'tasks/cancel'), 'timeout must cancel on the server');
});

// ---------------------------------------------------------------------------
// input_required / sendInput / resume
// ---------------------------------------------------------------------------

test('tasks: 2026 input_required -> sendInput -> resume -> completed', async () => {
  let gets = 0;
  const transport = makeTransport({
    'tasks/get': () => {
      gets += 1;
      if (gets === 1) return { taskId: 't-1', status: 'input_required', pollInterval: 5 };
      return { taskId: 't-1', status: 'completed', pollInterval: 5, result: { withInput: true } };
    },
    'tasks/update': (_n, params) => {
      assert.deepEqual(params.input, { answer: 'yes' });
      return { taskId: 't-1', status: 'working', pollInterval: 5 };
    },
    'tasks/cancel': () => ({ taskId: 't-1', status: 'cancelled' }),
  });
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle(), { specVersion: '2026-07-28' });
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow', specVersion: '2026-07-28' });
  const waiting = await waitForSnapshot(manager, snap.key, (s) => s.status === 'input_required');
  assert.match(waiting.error ?? '', /chờ input/);
  const resumed = await manager.sendInput(snap.key, { answer: 'yes' });
  assert.equal(resumed.status, 'working');
  const done = await manager.waitFor(snap.key);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { withInput: true });
});

test('tasks: sendInput on 2025-11-25 is refused with a clear error', async () => {
  const transport = pollingTransport(['input_required'], undefined);
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  await waitForSnapshot(manager, snap.key, (s) => s.status === 'input_required');
  await assert.rejects(() => manager.sendInput(snap.key, { answer: 'yes' }), /2025-11-25/);
  await manager.cancel(snap.key);
});

test('tasks: sendInput on a working task is refused', async () => {
  const transport = pollingTransport(['working'], undefined);
  const manager = new McpTaskManager();
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  await assert.rejects(() => manager.sendInput(snap.key, {}), /input_required/);
  await manager.cancel(snap.key);
});

// ---------------------------------------------------------------------------
// list / prune / caps / events
// ---------------------------------------------------------------------------

test('tasks: list newest first, get returns a copy, pruneTerminal clears done tasks', async () => {
  const manager = new McpTaskManager();
  const t1 = pollingTransport(['completed'], { ok: 1 });
  const h1 = new TaskHandle(t1, { taskId: 't-1', status: 'working', pollInterval: 5 });
  const s1 = manager.track(h1, { serverName: 'fake', method: 'tools/call', label: 'one' });
  await manager.waitFor(s1.key);
  const t2 = pollingTransport(['working'], undefined);
  const h2 = new TaskHandle(t2, { taskId: 't-2', status: 'working', pollInterval: 5 });
  const s2 = manager.track(h2, { serverName: 'fake', method: 'tools/call', label: 'two' });
  const list = manager.list();
  assert.equal(list[0].key, s2.key, 'newest first');
  assert.equal(list[1].key, s1.key);
  const copy = manager.get(s1.key);
  assert.ok(copy);
  copy.status = 'working';
  assert.equal(manager.get(s1.key)?.status, 'completed', 'get returns a copy, not the live snapshot');
  assert.equal(manager.pruneTerminal(), 1, 'only the terminal task is pruned');
  assert.equal(manager.list().length, 1);
  await manager.cancel(s2.key);
  assert.equal(manager.pruneTerminal(), 1);
  assert.equal(manager.list().length, 0);
});

test('tasks: maxTracked refuses new tasks instead of silently dropping old ones', async () => {
  const manager = new McpTaskManager({ maxTracked: 1 });
  const t1 = pollingTransport(['working'], undefined);
  manager.track(new TaskHandle(t1, handle()), { serverName: 'fake', method: 'tools/call', label: 'one' });
  const t2 = pollingTransport(['working'], undefined);
  assert.throws(
    () => manager.track(new TaskHandle(t2, { taskId: 't-2', status: 'working', pollInterval: 5 }), { serverName: 'fake', method: 'tools/call', label: 'two' }),
    /tối đa 1/,
  );
  await manager.cancelAll();
});

test('tasks: tracking the same key twice is refused', async () => {
  const manager = new McpTaskManager();
  const transport = pollingTransport(['working'], undefined);
  manager.track(new TaskHandle(transport, handle()), { serverName: 'fake', method: 'tools/call', label: 'one' });
  assert.throws(
    () => manager.track(new TaskHandle(transport, handle()), { serverName: 'fake', method: 'tools/call', label: 'dup' }),
    /đã được theo dõi/,
  );
  await manager.cancelAll();
});

test('tasks: onChange fires on status changes', async () => {
  const manager = new McpTaskManager();
  const seen = [];
  const off = manager.onChange((tasks) => seen.push(tasks.map((s) => `${s.taskId}:${s.status}`)));
  const transport = pollingTransport(['working', 'completed'], { ok: true });
  const h = new TaskHandle(transport, handle());
  const snap = manager.track(h, { serverName: 'fake', method: 'tools/call', label: 'slow' });
  await manager.waitFor(snap.key);
  off();
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[0], ['t-1:working']);
  assert.ok(seen.some((row) => row.includes('t-1:completed')));
});

test('tasks: waitFor on an unknown key throws', async () => {
  const manager = new McpTaskManager();
  await assert.rejects(() => manager.waitFor('fake:nope'), /Không có MCP task/);
});
