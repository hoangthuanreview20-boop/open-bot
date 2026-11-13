/**
 * Test v0.97 T1: MCP Tasks — server-side task store (node:test).
 * Local only, no network, no timers beyond short sleeps.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v097-task-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isServerTaskTerminal,
  McpTaskStore,
  TaskStoreError,
} from '../packages/core/dist/mcp/taskStore.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('taskStore: terminal statuses are completed / failed / cancelled', () => {
  assert.equal(isServerTaskTerminal('completed'), true);
  assert.equal(isServerTaskTerminal('failed'), true);
  assert.equal(isServerTaskTerminal('cancelled'), true);
  assert.equal(isServerTaskTerminal('working'), false);
  assert.equal(isServerTaskTerminal('input_required'), false);
});

test('taskStore: submit returns a handle at once, runner completes in background', async () => {
  const store = new McpTaskStore();
  const handle = store.submit('tools/call', { name: 'slow' }, async (ctx) => {
    ctx.reportProgress(0.5, 'halfway');
    await sleep(10);
    return { answer: 42 };
  });
  assert.equal(handle.status, 'working');
  assert.equal(typeof handle.taskId, 'string');
  assert.equal(handle.pollInterval, 1000);
  assert.equal(store.size, 1);
  // Progress reported while working is visible on the stored task.
  assert.equal(store.get(handle.taskId).progress, 0.5);
  assert.equal(store.get(handle.taskId).progressMessage, 'halfway');
  await sleep(30);
  const done = store.get(handle.taskId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { answer: 42 });
  assert.equal(store.toHandleData(done).result.answer, 42);
});

test('taskStore: a throwing runner becomes failed with the error message', async () => {
  const store = new McpTaskStore();
  const handle = store.submit('tools/call', {}, async () => {
    throw new Error('boom in runner');
  });
  await sleep(20);
  const task = store.get(handle.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'boom in runner');
  assert.equal(store.toHandleData(task).error, 'boom in runner');
});

test('taskStore: cancel marks the task and fires the abort signal', async () => {
  const store = new McpTaskStore();
  let sawAbort = false;
  const handle = store.submit('tools/call', {}, async (ctx) => {
    await sleep(5);
    if (ctx.signal.aborted) sawAbort = true;
    await sleep(50);
    return 'late result';
  });
  const cancelled = store.cancel(handle.taskId);
  assert.equal(cancelled.status, 'cancelled');
  await sleep(80);
  // The runner's late result is discarded — status stays cancelled.
  assert.equal(store.get(handle.taskId).status, 'cancelled');
  assert.equal(store.get(handle.taskId).result, undefined);
  assert.equal(sawAbort, true);
  // Cancelling a terminal task is a no-op, not an error.
  assert.equal(store.cancel(handle.taskId).status, 'cancelled');
});

test('taskStore: cancel of an unknown task throws TaskStoreError', () => {
  const store = new McpTaskStore();
  assert.throws(() => store.cancel('no-such-task'), TaskStoreError);
  assert.throws(() => store.get('no-such-task'), TaskStoreError);
  assert.throws(() => store.update('no-such-task', {}), TaskStoreError);
});

test('taskStore: input_required parks the task; update resumes it with the answer', async () => {
  const store = new McpTaskStore();
  let received = null;
  const handle = store.submit('tools/call', {}, async (ctx) => {
    const input = await ctx.requestInput('What is the path?', { type: 'object' });
    received = input;
    return `read ${input.path}`;
  });
  await sleep(20);
  assert.equal(store.get(handle.taskId).status, 'input_required');
  assert.equal(store.get(handle.taskId).inputRequest?.prompt, 'What is the path?');
  // update() on a non-parked task throws; here it is parked so it works.
  const resumed = store.update(handle.taskId, { path: '/workspace/a.txt' });
  assert.equal(resumed.status, 'working');
  await sleep(20);
  assert.deepEqual(received, { path: '/workspace/a.txt' });
  assert.equal(store.get(handle.taskId).status, 'completed');
  assert.equal(store.get(handle.taskId).result, 'read /workspace/a.txt');
});

test('taskStore: update on a working (not input_required) task throws', async () => {
  const store = new McpTaskStore();
  const handle = store.submit('tools/call', {}, async () => {
    await sleep(30);
    return 'ok';
  });
  assert.throws(() => store.update(handle.taskId, {}), /input_required/);
  await sleep(50);
});

test('taskStore: cancel rejects a parked input waiter so the runner unwinds', async () => {
  const store = new McpTaskStore();
  let runnerError = null;
  const handle = store.submit('tools/call', {}, async (ctx) => {
    try {
      await ctx.requestInput('Waiting…');
      return 'never';
    } catch (err) {
      runnerError = err;
      throw err;
    }
  });
  await sleep(20);
  assert.equal(store.get(handle.taskId).status, 'input_required');
  store.cancel(handle.taskId);
  await sleep(20);
  assert.equal(store.get(handle.taskId).status, 'cancelled');
  assert.ok(runnerError instanceof Error);
});

test('taskStore: list is newest-first and filters by status', async () => {
  let now = 1000;
  const store = new McpTaskStore({ nowMs: () => now });
  const a = store.submit('tools/call', {}, async () => 'a');
  now += 10;
  const b = store.submit('tools/call', {}, async () => {
    throw new Error('b fails');
  });
  await sleep(20);
  const all = store.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].taskId, b.taskId);
  assert.equal(all[1].taskId, a.taskId);
  assert.equal(store.list('completed').length, 1);
  assert.equal(store.list('failed').length, 1);
  assert.equal(store.list('working').length, 0);
  assert.equal(store.list('completed')[0].taskId, a.taskId);
});

test('taskStore: finished tasks expire after TTL and get() then throws unknown', async () => {
  let now = 1000;
  const store = new McpTaskStore({ nowMs: () => now, defaultTtlMs: 50 });
  const handle = store.submit('tools/call', {}, async () => 'quick');
  await sleep(20);
  assert.equal(store.get(handle.taskId).status, 'completed');
  now += 100;
  assert.throws(() => store.get(handle.taskId), /expired/);
  assert.equal(store.sweepExpired(), 0);
});

test('taskStore: sweepExpired removes expired tasks and reports the count', async () => {
  let now = 1000;
  const store = new McpTaskStore({ nowMs: () => now, defaultTtlMs: 50 });
  store.submit('tools/call', {}, async () => 'one');
  store.submit('tools/call', {}, async () => 'two');
  await sleep(20);
  now += 100;
  assert.equal(store.sweepExpired(), 2);
  assert.equal(store.size, 0);
});

test('taskStore: maxTasks evicts the oldest finished task, refuses to grow past working tasks', async () => {
  const store = new McpTaskStore({ maxTasks: 2, defaultTtlMs: 60_000 });
  const first = store.submit('tools/call', {}, async () => 'first');
  store.submit('tools/call', {}, async () => 'second');
  await sleep(20);
  assert.equal(store.size, 2);
  const third = store.submit('tools/call', {}, async () => 'third');
  assert.equal(store.size, 2);
  assert.throws(() => store.get(first.taskId), TaskStoreError);
  await sleep(20);
  assert.equal(store.get(third.taskId).status, 'completed');
});

test('taskStore: progress is clamped to 0..1 and ignored after completion', async () => {
  const store = new McpTaskStore();
  const handle = store.submit('tools/call', {}, async (ctx) => {
    ctx.reportProgress(5, 'over');
    ctx.reportProgress(-1, 'under');
    return 'done';
  });
  await sleep(20);
  const task = store.get(handle.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.progress, 0);
  assert.equal(task.progressMessage, 'under');
});
