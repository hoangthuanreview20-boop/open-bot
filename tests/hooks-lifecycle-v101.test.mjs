/**
 * Tests for the v1.01 lifecycle events (packages/core/src/hooks/):
 * SubagentStart / SubagentStop / PreCompact / PostCompact /
 * UserPromptSubmit in `HookRunner`.
 *
 * Semantics under test:
 * - SubagentStart: first `block` wins (spawn cancelled); `modify` +
 *   `context` lines are collected for the subagent's task.
 * - SubagentStop: first `block` wins; `additionalContext` is collected
 *   from every hook that ran (modify AND block), in order.
 * - PreCompact / PostCompact: first `block` wins; `modify` + `context`
 *   lines are collected.
 * - UserPromptSubmit: first `block` wins; `modify` + `context` lines
 *   are collected for the prompt.
 * - A throwing / timing-out hook is fail-closed (block) by default and
 *   `allow` with `onHookError: 'allow'`, exactly like PreToolUse.
 * - Unknown events are rejected at registration time.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-lifecycle-v101.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_HOOK_EVENTS,
  allowDecision,
  blockDecision,
  blockStopDecision,
  HookRegistrationError,
  HookRegistry,
  HookRunner,
  modifyAdditionalContextDecision,
  modifyContextDecision,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hooks-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function registryWith(hooks = []) {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  for (const hook of hooks) registry.register(hook);
  return registry;
}

function fnHook(name, events, handler, extra = {}) {
  return { name, events, handler, source: 'builtin', enabled: true, ...extra };
}

// ---------------------------------------------------------------------------
// Event catalogue
// ---------------------------------------------------------------------------

test('ALL_HOOK_EVENTS lists all ten lifecycle events', () => {
  assert.deepEqual([...ALL_HOOK_EVENTS].sort(), [
    'PostCompact',
    'PostToolUse',
    'PreCompact',
    'PreToolUse',
    'SessionEnd',
    'SessionStart',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'UserPromptSubmit',
  ]);
});

test('registering a hook for an unknown event throws HookRegistrationError', () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  assert.throws(
    () =>
      registry.register(
        fnHook('bad-event', ['NotAnEvent'], () => allowDecision()),
      ),
    HookRegistrationError,
  );
});

// ---------------------------------------------------------------------------
// SubagentStart
// ---------------------------------------------------------------------------

test('runSubagentStart: allow when no hooks; block wins and later hooks do not run', async () => {
  const empty = new HookRunner(registryWith([]));
  const allowed = await empty.runSubagentStart({
    subagentId: 'sub-1',
    task: 'do thing',
  });
  assert.equal(allowed.decision, 'allow');
  assert.deepEqual(allowed.context, []);
  assert.deepEqual(allowed.hooksRun, []);

  const seen = [];
  const runner = new HookRunner(
    registryWith([
      fnHook('blocker', ['SubagentStart'], (event) => {
        seen.push('blocker');
        assert.equal(event.subagentId, 'sub-1');
        assert.equal(event.task, 'do thing');
        return blockDecision('spawn forbidden here');
      }),
      fnHook('never-runs', ['SubagentStart'], () => {
        seen.push('never-runs');
        return allowDecision();
      }),
    ]),
  );
  const blocked = await runner.runSubagentStart({ subagentId: 'sub-1', task: 'do thing' });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blockedBy, 'blocker');
  assert.equal(blocked.reason, 'spawn forbidden here');
  assert.deepEqual(seen, ['blocker']);
});

test('runSubagentStart: modify + context lines are collected in order', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('a', ['SubagentStart'], () => modifyContextDecision('line A')),
      fnHook('b', ['SubagentStart'], () => modifyContextDecision('line B')),
    ]),
  );
  const out = await runner.runSubagentStart({ subagentId: 's', task: 't' });
  assert.equal(out.decision, 'modify');
  assert.deepEqual(out.context, ['line A', 'line B']);
  assert.deepEqual(out.hooksRun, ['a', 'b']);
});

test('runSubagentStart: a throwing hook fails closed (block) by default', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('boom', ['SubagentStart'], () => {
        throw new Error('kaboom');
      }),
    ]),
  );
  const out = await runner.runSubagentStart({ subagentId: 's', task: 't' });
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, 'boom');
  assert.equal(out.hookErrors.length, 1);
  assert.match(out.hookErrors[0].error, /kaboom/);

  const lenient = new HookRunner(
    registryWith([
      fnHook('boom', ['SubagentStart'], () => {
        throw new Error('kaboom');
      }),
    ]),
    { onHookError: 'allow' },
  );
  const allowed = await lenient.runSubagentStart({ subagentId: 's', task: 't' });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.hookErrors.length, 1);
});

// ---------------------------------------------------------------------------
// SubagentStop
// ---------------------------------------------------------------------------

test('runSubagentStop: allow collects modify additionalContext; block collects it too', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('reviewer', ['SubagentStop'], () =>
        modifyAdditionalContextDecision('note: check the edge case'),
      ),
      fnHook('gate', ['SubagentStop'], () =>
        blockStopDecision('FAIL: 2 tests failed', 'tests failed'),
      ),
      fnHook('never-runs', ['SubagentStop'], () => allowDecision()),
    ]),
  );
  const out = await runner.runSubagentStop({
    subagentId: 's-1',
    name: 'worker',
    status: 'done',
    output: 'all done',
    durationMs: 1234,
  });
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, 'gate');
  assert.equal(out.reason, 'tests failed');
  assert.deepEqual(out.additionalContexts, [
    'note: check the edge case',
    'FAIL: 2 tests failed',
  ]);
  assert.match(out.additionalContext, /note: check the edge case/);
  assert.match(out.additionalContext, /FAIL: 2 tests failed/);
  assert.deepEqual(out.hooksRun, ['reviewer', 'gate']);
});

test('runSubagentStop: no hooks → allow with empty additionalContext', async () => {
  const runner = new HookRunner(registryWith([]));
  const out = await runner.runSubagentStop({
    subagentId: 's',
    status: 'timeout',
    output: '',
    durationMs: 5000,
    reason: 'timeout',
  });
  assert.equal(out.decision, 'allow');
  assert.equal(out.additionalContext, '');
  assert.deepEqual(out.additionalContexts, []);
});

test('runSubagentStop: a timing-out hook fails closed', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('slow', ['SubagentStop'], async () => {
        await new Promise((r) => setTimeout(r, 500));
        return allowDecision();
      }),
    ]),
    { timeoutMs: 50 },
  );
  const out = await runner.runSubagentStop({
    subagentId: 's',
    status: 'done',
    output: 'x',
    durationMs: 10,
  });
  assert.equal(out.decision, 'block');
  assert.equal(out.hookErrors.length, 1);
  assert.equal(out.hookErrors[0].timedOut, true);
});

// ---------------------------------------------------------------------------
// PreCompact / PostCompact
// ---------------------------------------------------------------------------

test('runPreCompact: block skips the round; modify collects context', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('skipper', ['PreCompact'], (event) => {
        assert.equal(event.messageCount, 42);
        assert.equal(event.tokensBefore, 9000);
        return blockDecision('not yet');
      }),
    ]),
  );
  const blocked = await runner.runPreCompact({
    messageCount: 42,
    tokensBefore: 9000,
    contextLimit: 10000,
  });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blockedBy, 'skipper');

  const modifier = new HookRunner(
    registryWith([
      fnHook('noter', ['PreCompact'], () => modifyContextDecision('keep the plan')),
    ]),
  );
  const out = await modifier.runPreCompact({ messageCount: 5, tokensBefore: 100 });
  assert.equal(out.decision, 'modify');
  assert.deepEqual(out.context, ['keep the plan']);
});

test('runPostCompact: block means revert; outcome carries the summary fields', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('reverter', ['PostCompact'], (event) => {
        assert.equal(event.summarizedCount, 10);
        assert.equal(event.tokensBefore, 9000);
        assert.equal(event.tokensAfter, 1200);
        assert.equal(event.fallbackUsed, false);
        return blockDecision('summary lost the plan');
      }),
    ]),
  );
  const out = await runner.runPostCompact({
    summarizedCount: 10,
    tokensBefore: 9000,
    tokensAfter: 1200,
    summaryText: 'summary…',
    fallbackUsed: false,
  });
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, 'reverter');
  assert.equal(out.reason, 'summary lost the plan');
});

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

test('runUserPromptSubmit: block refuses the turn; modify prepends context', async () => {
  const blocker = new HookRunner(
    registryWith([
      fnHook('refuser', ['UserPromptSubmit'], (event) => {
        assert.equal(event.prompt, 'rm -rf /');
        return blockDecision('prompt bị chặn: lệnh nguy hiểm');
      }),
    ]),
  );
  const blocked = await blocker.runUserPromptSubmit({ prompt: 'rm -rf /' });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.reason, 'prompt bị chặn: lệnh nguy hiểm');

  const modifier = new HookRunner(
    registryWith([
      fnHook('adder', ['UserPromptSubmit'], () => modifyContextDecision('user is Huy')),
    ]),
  );
  const out = await modifier.runUserPromptSubmit({ prompt: 'hi' });
  assert.equal(out.decision, 'modify');
  assert.deepEqual(out.context, ['user is Huy']);
});

test('runUserPromptSubmit: hook error fails closed by default', async () => {
  const runner = new HookRunner(
    registryWith([
      fnHook('boom', ['UserPromptSubmit'], () => {
        throw new Error('nope');
      }),
    ]),
  );
  const out = await runner.runUserPromptSubmit({ prompt: 'hi' });
  assert.equal(out.decision, 'block');
  assert.equal(out.hookErrors.length, 1);
});

// ---------------------------------------------------------------------------
// Cross-event isolation
// ---------------------------------------------------------------------------

test('hooks only run for their own events', async () => {
  const seen = [];
  const runner = new HookRunner(
    registryWith([
      fnHook('only-stop', ['SubagentStop'], () => {
        seen.push('stop');
        return allowDecision();
      }),
      fnHook('only-start', ['SubagentStart'], () => {
        seen.push('start');
        return allowDecision();
      }),
    ]),
  );
  await runner.runSubagentStart({ subagentId: 's', task: 't' });
  assert.deepEqual(seen, ['start']);
  await runner.runSubagentStop({
    subagentId: 's',
    status: 'done',
    output: '',
    durationMs: 1,
  });
  assert.deepEqual(seen, ['start', 'stop']);
  const pre = await runner.runPreCompact({ messageCount: 1, tokensBefore: 1 });
  assert.deepEqual(pre.hooksRun, []);
});
