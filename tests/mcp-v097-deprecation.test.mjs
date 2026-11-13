/**
 * Test v0.97 T1: MCP 2.0 deprecation shim (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v097-deprecation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDeprecatedCapabilities,
  DeprecationShim,
  formatDeprecationWarning,
  getDeprecatedMethod,
  isDeprecatedMcpMethod,
  DEPRECATED_MCP_METHODS,
  MCP_DEPRECATION_REMOVE_AFTER,
} from '../packages/core/dist/mcp/deprecation.js';

test('deprecation: the deprecated set is sampling / roots / logging / elicitation', () => {
  assert.equal(MCP_DEPRECATION_REMOVE_AFTER, '2027-07-28');
  const methods = DEPRECATED_MCP_METHODS.map((m) => m.method);
  assert.ok(methods.includes('sampling/createMessage'));
  assert.ok(methods.includes('roots/list'));
  assert.ok(methods.includes('roots/subscribe'));
  assert.ok(methods.includes('notifications/message'));
  assert.ok(methods.includes('logging/setLevel'));
  assert.ok(methods.includes('elicitation/create'));
  for (const meta of DEPRECATED_MCP_METHODS) {
    assert.equal(meta.deprecatedIn, '2026-07-28');
    assert.equal(meta.removeAfter, '2027-07-28');
    assert.ok(meta.replacement.length > 0);
    assert.ok(meta.reason.length > 0);
  }
  assert.equal(isDeprecatedMcpMethod('sampling/createMessage'), true);
  assert.equal(isDeprecatedMcpMethod('tools/call'), false);
  assert.equal(isDeprecatedMcpMethod('server/discover'), false);
  assert.equal(getDeprecatedMethod('tools/call'), null);
  assert.equal(getDeprecatedMethod('roots/list')?.capability, 'roots');
  assert.match(getDeprecatedMethod('sampling/createMessage')?.replacement ?? '', /MRTR/);
});

test('deprecation: warning text names the method, the removal date and the replacement', () => {
  const meta = getDeprecatedMethod('notifications/message');
  const text = formatDeprecationWarning(meta);
  assert.match(text, /notifications\/message/);
  assert.match(text, /2027-07-28/);
  assert.match(text, /stderr|OpenTelemetry/);
});

test('deprecation: shim runs the handler and warns exactly once per method', () => {
  const warnings = [];
  const shim = new DeprecationShim({
    // Snapshot the count at warning time — the notice object keeps
    // counting afterwards, so the stored reference would read 3 later.
    onWarning: (notice, message) => warnings.push({ callCount: notice.callCount, message }),
  });
  let calls = 0;
  const wrapped = shim.wrap('sampling/createMessage', (x) => {
    calls += 1;
    return x * 2;
  });
  assert.equal(wrapped(21), 42);
  assert.equal(wrapped(1), 2);
  assert.equal(wrapped(2), 4);
  assert.equal(calls, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /sampling\/createMessage/);
  assert.equal(warnings[0].callCount, 1);
  // Notices keep counting even after the warning was shown once.
  const notices = shim.getNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].callCount, 3);
  assert.equal(notices[0].method, 'sampling/createMessage');
  assert.equal(shim.hasNotices, true);
});

test('deprecation: shim passes current methods through untouched (no warning)', () => {
  const warnings = [];
  const shim = new DeprecationShim({ onWarning: () => warnings.push(1) });
  const fn = shim.wrap('tools/call', (x) => x + 1);
  assert.equal(fn(1), 2);
  assert.equal(warnings.length, 0);
  assert.equal(shim.hasNotices, false);
  assert.deepEqual(shim.getNotices(), []);
});

test('deprecation: record() without a handler tracks use and warns once', () => {
  const warnings = [];
  const shim = new DeprecationShim({ onWarning: (n) => warnings.push(n.method) });
  assert.equal(shim.record('tools/call'), null);
  const first = shim.record('roots/list');
  assert.equal(first?.method, 'roots/list');
  assert.equal(first?.callCount, 1);
  assert.deepEqual(warnings, ['roots/list']);
  shim.record('roots/list');
  shim.record('roots/list');
  assert.equal(shim.getNotices()[0].callCount, 3);
  assert.deepEqual(warnings, ['roots/list']);
  shim.clear();
  assert.equal(shim.hasNotices, false);
  assert.deepEqual(shim.getNotices(), []);
});

test('deprecation: shim without onWarning collects silently (never writes to stdout)', () => {
  const shim = new DeprecationShim();
  const wrapped = shim.wrap('notifications/message', () => 'logged');
  assert.equal(wrapped(), 'logged');
  assert.equal(shim.getNotices().length, 1);
});

test('deprecation: checkDeprecatedCapabilities finds old capability keys', () => {
  assert.deepEqual(checkDeprecatedCapabilities(undefined), []);
  assert.deepEqual(checkDeprecatedCapabilities({}), []);
  assert.deepEqual(checkDeprecatedCapabilities({ tools: {} }), []);
  const found = checkDeprecatedCapabilities({ sampling: {}, roots: {}, logging: {}, tools: {} });
  assert.deepEqual(
    found.map((m) => m.capability).sort(),
    ['logging', 'roots', 'sampling'],
  );
  // One entry per capability even when several methods share it.
  const rootsOnly = checkDeprecatedCapabilities({ roots: {} });
  assert.equal(rootsOnly.length, 1);
  assert.equal(rootsOnly[0].method, 'roots/list');
});
