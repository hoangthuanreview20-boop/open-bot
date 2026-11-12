// v0.84e — requireStringArray (packages/core/src/ipc/validate.ts):
// the IPC validator behind the MCP marketplace install-time args
// override (mcp-marketplace:install). The renderer sends one arg per
// line as an array; main must reject anything that is not an array of
// short non-empty strings before it reaches install().
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requireStringArray } from '../packages/core/dist/ipc/validate.js';

test('requireStringArray: valid arrays pass through, items are trimmed', () => {
  assert.deepEqual(requireStringArray(['-y', '@modelcontextprotocol/server-memory'], 'args'), [
    '-y',
    '@modelcontextprotocol/server-memory',
  ]);
  assert.deepEqual(requireStringArray(['  /tmp/foo  ', 'bar'], 'args'), ['/tmp/foo', 'bar']);
  assert.deepEqual(requireStringArray([], 'args'), [], 'empty array is a real value (explicitly no args)');
});

test('requireStringArray: undefined/null means "not provided"', () => {
  assert.equal(requireStringArray(undefined, 'args'), undefined);
  assert.equal(requireStringArray(null, 'args'), undefined);
});

test('requireStringArray: non-array, non-string items and empty items throw', () => {
  assert.throws(() => requireStringArray('not-an-array', 'args'), /phải là một mảng chuỗi/);
  assert.throws(() => requireStringArray(42, 'args'), /phải là một mảng chuỗi/);
  assert.throws(() => requireStringArray(['ok', 42], 'args'), /\[1\] phải là chuỗi không rỗng/);
  assert.throws(() => requireStringArray(['ok', '   '], 'args'), /\[1\] phải là chuỗi không rỗng/);
  assert.throws(() => requireStringArray(['ok', null], 'args'), /\[1\] phải là chuỗi không rỗng/);
});

test('requireStringArray: caps — too many items / too-long item throw', () => {
  assert.throws(
    () => requireStringArray(Array.from({ length: 65 }, (_, i) => `a${i}`), 'args'),
    /tối đa 64 mục/,
  );
  assert.deepEqual(
    requireStringArray(Array.from({ length: 64 }, (_, i) => `a${i}`), 'args').length,
    64,
    'exactly 64 items is allowed',
  );
  assert.throws(() => requireStringArray(['x'.repeat(1001)], 'args'), /tối đa 1000 ký tự/);
  assert.equal(requireStringArray(['x'.repeat(1000)], 'args')?.[0].length, 1000);
});
