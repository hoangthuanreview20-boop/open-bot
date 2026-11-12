/**
 * Tests for the v0.41 follow-up (blob-truncation dedup):
 * the 14 local `truncate()` copies in packages/tools/src now delegate to
 * one shared helper (packages/tools/src/truncate.ts).
 *
 * This is a behaviour-preserving refactor: same limits, same footers,
 * same observable output. Tests assert EXACT outputs (not just "contains
 * truncated") at the boundary cases — shorter than limit, exactly at
 * limit, longer than limit, empty string — for the shared helper AND
 * through real tool call sites (read_file/blob, grep_search, runShell,
 * truncatePluginOutput), so a before/after difference would fail here.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/truncate-shared-v041.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_LOCAL_BRIDGE_RESULT_CHARS,
  MAX_MCP_RESULT_CHARS,
  MAX_PLUGIN_TOOL_OUTPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  truncateText,
  truncateTextWithRemainder,
} from '../packages/tools/dist/truncate.js';
import {
  MAX_TOOL_RESULT_CHARS as INDEX_MAX_TOOL_RESULT_CHARS,
  createDefaultTools,
  truncateText as truncateTextFromIndex,
  truncateWithBlob,
} from '../packages/tools/dist/index.js';
import { MAX_OUTPUT_CHARS, runShell } from '../packages/tools/dist/sandbox.js';
import {
  MAX_PLUGIN_TOOL_OUTPUT_CHARS as LOADER_MAX_PLUGIN_TOOL_OUTPUT_CHARS,
  truncatePluginOutput,
} from '../packages/tools/dist/plugins/loader.js';
import * as accessTools from '../packages/tools/dist/accessTools.js';
import * as agentDataTools from '../packages/tools/dist/agentDataTools.js';
import * as ciTools from '../packages/tools/dist/ciTools.js';
import * as codeTools from '../packages/tools/dist/codeTools.js';
import * as computerUse from '../packages/tools/dist/computerUse.js';
import * as gitTools from '../packages/tools/dist/gitTools.js';
import * as integrationTools from '../packages/tools/dist/integrationTools.js';
import * as localBridge from '../packages/tools/dist/localBridge.js';
import * as localTools from '../packages/tools/dist/localTools.js';
import * as mcpSystemTools from '../packages/tools/dist/mcpSystemTools.js';
import * as mcpTools from '../packages/tools/dist/mcpTools.js';
import * as shellTools from '../packages/tools/dist/shellTools.js';
import * as toolsModule from '../packages/tools/dist/tools.js';
import * as webMedia from '../packages/tools/dist/webMedia.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(workspaceDir, botId = 'bot-1') {
  return { workspaceDir, botId };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Shared constants: every migrated module still exports its old name,
// all equal to 20_000, and the package index re-exports the helper.
// ---------------------------------------------------------------------------

test('v041 shared constants: all MAX_* aliases are 20_000 everywhere', () => {
  assert.equal(MAX_TOOL_RESULT_CHARS, 20_000);
  assert.equal(MAX_MCP_RESULT_CHARS, 20_000);
  assert.equal(MAX_LOCAL_BRIDGE_RESULT_CHARS, 20_000);
  assert.equal(MAX_PLUGIN_TOOL_OUTPUT_CHARS, 20_000);
  assert.equal(INDEX_MAX_TOOL_RESULT_CHARS, 20_000);
  assert.equal(truncateTextFromIndex, truncateText);
  assert.equal(LOADER_MAX_PLUGIN_TOOL_OUTPUT_CHARS, 20_000);
  // Re-exports kept on the migrated modules (old import paths keep working).
  for (const [name, mod] of [
    ['accessTools', accessTools],
    ['agentDataTools', agentDataTools],
    ['ciTools', ciTools],
    ['codeTools', codeTools],
    ['computerUse', computerUse],
    ['gitTools', gitTools],
    ['integrationTools', integrationTools],
    ['localTools', localTools],
    ['mcpSystemTools', mcpSystemTools],
    ['shellTools', shellTools],
    ['tools', toolsModule],
    ['webMedia', webMedia],
  ]) {
    assert.equal(mod.MAX_TOOL_RESULT_CHARS, 20_000, `${name}.MAX_TOOL_RESULT_CHARS`);
  }
  assert.equal(mcpTools.MAX_MCP_RESULT_CHARS, 20_000);
  assert.equal(localBridge.MAX_LOCAL_BRIDGE_RESULT_CHARS, 20_000);
});

// ---------------------------------------------------------------------------
// truncateText: exact-output boundary cases.
// ---------------------------------------------------------------------------

test('v041 truncateText: empty / shorter / exactly at limit pass through untouched', () => {
  assert.equal(truncateText(''), '');
  assert.equal(truncateText('abc'), 'abc');
  assert.equal(truncateText('x'.repeat(19_999)), 'x'.repeat(19_999));
  assert.equal(truncateText('x'.repeat(20_000)), 'x'.repeat(20_000));
  assert.doesNotMatch(truncateText('x'.repeat(20_000)), /truncated/);
});

test('v041 truncateText: one char over the limit cuts + appends the exact footer', () => {
  const text = 'x'.repeat(20_001);
  assert.equal(truncateText(text), `${'x'.repeat(20_000)}\n[... truncated to 20000 chars ...]`);
});

test('v041 truncateText: long text keeps only the first maxChars + footer', () => {
  const text = 'abcdefghij'.repeat(3_000); // 30_000 chars
  assert.equal(
    truncateText(text),
    `${text.slice(0, 20_000)}\n[... truncated to 20000 chars ...]`,
  );
});

test('v041 truncateText: explicit maxChars is honoured (incl. 0 and 1)', () => {
  assert.equal(truncateText('hello world', 10), 'hello worl\n[... truncated to 10 chars ...]');
  assert.equal(truncateText('hello world', 11), 'hello world');
  assert.equal(truncateText('ab', 1), 'a\n[... truncated to 1 chars ...]');
  assert.equal(truncateText('abcde', 0), '\n[... truncated to 0 chars ...]');
  // Call sites that pass their own limit (e.g. 8000 / 50_000) keep it.
  assert.equal(
    truncateText('y'.repeat(9_000), 8_000),
    `${'y'.repeat(8_000)}\n[... truncated to 8000 chars ...]`,
  );
  assert.equal(
    truncateText('y'.repeat(60_000), 50_000),
    `${'y'.repeat(50_000)}\n[... truncated to 50000 chars ...]`,
  );
});

test('v041 truncateText: multi-byte chars truncate by UTF-16 units, same as before', () => {
  const text = 'é'.repeat(20_001);
  assert.equal(truncateText(text), `${'é'.repeat(20_000)}\n[... truncated to 20000 chars ...]`);
});

// ---------------------------------------------------------------------------
// truncateTextWithRemainder (sandbox variant): footer states the remainder.
// ---------------------------------------------------------------------------

test('v041 truncateTextWithRemainder: boundaries + remainder count in footer', () => {
  assert.equal(truncateTextWithRemainder('', 200), '');
  assert.equal(truncateTextWithRemainder('abc', 200), 'abc');
  assert.equal(truncateTextWithRemainder('x'.repeat(200), 200), 'x'.repeat(200));
  assert.equal(
    truncateTextWithRemainder('x'.repeat(201), 200),
    `${'x'.repeat(200)}\n[... truncated, 1 more chars ...]`,
  );
  assert.equal(
    truncateTextWithRemainder('x'.repeat(250), 200),
    `${'x'.repeat(200)}\n[... truncated, 50 more chars ...]`,
  );
});

// ---------------------------------------------------------------------------
// Delegating wrappers keep the old behaviour exactly.
// ---------------------------------------------------------------------------

test('v041 truncateWithBlob fallback (no workspaceDir) is exactly truncateText', () => {
  const short = 'hello';
  assert.equal(truncateWithBlob(short), short);
  const long = 'x'.repeat(25_000);
  assert.equal(truncateWithBlob(long), truncateText(long));
  assert.equal(
    truncateWithBlob(long),
    `${'x'.repeat(20_000)}\n[... truncated to 20000 chars ...]`,
  );
  assert.doesNotMatch(truncateWithBlob(long), /blob_id/);
});

test('v041 truncatePluginOutput still truncates plugin output at 20_000', () => {
  assert.equal(truncatePluginOutput('ok'), 'ok');
  assert.equal(truncatePluginOutput(''), '');
  const long = 'z'.repeat(25_000);
  assert.equal(truncatePluginOutput(long), truncateText(long));
});

// ---------------------------------------------------------------------------
// Real call sites: exact outputs through the tools themselves.
// ---------------------------------------------------------------------------

test('v041 call site read_file (tools.ts blob wrapper): preview is exactly the first 20_000 chars', async () => {
  const ws = makeTempDir('open-bot-v041-read-');
  const text = `line-${'y'.repeat(24_000)}-end`; // 24_009 chars
  fs.writeFileSync(path.join(ws, 'big.txt'), text, 'utf8');
  const tools = createDefaultTools();
  const out = await toolByName(tools, 'read_file').execute({ path: 'big.txt' }, ctx(ws));
  assert.ok(out.startsWith(text.slice(0, 20_000)), 'preview must be the first 20000 chars');
  assert.match(out, /truncated to 20000 chars/);
  assert.match(out, /original_size_bytes: 24009/);
  const blobId = out.match(/blob_id: (blob-[A-Za-z0-9_-]+)/)[1];
  assert.ok(blobId);
  const page = await toolByName(tools, 'tool_blob_fetch').execute(
    { blob_id: blobId, offset: 20_000, length: 10_000 },
    ctx(ws),
  );
  assert.ok(page.includes(text.slice(20_000)), 'fetched page must contain the file tail');
});

test('v041 call site grep_search (codeTools.ts): long match list ends with the exact footer', async () => {
  const ws = makeTempDir('open-bot-v041-grep-');
  const line = `needle ${'x'.repeat(193)}`; // 200 chars per line
  fs.writeFileSync(path.join(ws, 'big.txt'), Array(150).fill(line).join('\n'), 'utf8');
  const out = await toolByName(codeTools.CODE_TOOLS, 'grep_search').execute(
    { pattern: 'needle' },
    ctx(ws),
  );
  const footer = '\n[... truncated to 20000 chars ...]';
  assert.ok(out.endsWith(footer), 'output must end with the exact hard-cut footer');
  assert.equal(out.length, 20_000 + footer.length);
  assert.ok(out.startsWith('Matches for "needle" (100):\nbig.txt:1: needle'));
});

test('v041 call site runShell (sandbox.ts): stdout over 200_000 chars uses the remainder footer', async () => {
  const ws = makeTempDir('open-bot-v041-shell-');
  const result = await runShell(`node -e "process.stdout.write('y'.repeat(210000))"`, ws);
  assert.equal(MAX_OUTPUT_CHARS, 200_000);
  assert.equal(
    result.stdout,
    `${'y'.repeat(200_000)}\n[... truncated, 10000 more chars ...]`,
  );
});

test('v041 call site runShell (sandbox.ts): short output is untouched', async () => {
  const ws = makeTempDir('open-bot-v041-shell-short-');
  const result = await runShell(`node -e "process.stdout.write('hello')"`, ws);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.code, 0);
});

test('v041 call site sandbox denylist: blocked command is truncated to 200 chars in the error', async () => {
  const ws = makeTempDir('open-bot-v041-deny-');
  const longCommand = `sudo ${'x'.repeat(300)}`; // 305 chars: 'sudo ' + 300 x's
  // NB: runShell() throws synchronously for a denylisted command, and
  // assert.rejects skips the validator for sync throws — so the thunk
  // must be async (sync throw -> rejected promise -> validator runs).
  await assert.rejects(
    async () => runShell(longCommand, ws),
    (err) => {
      assert.match(err.message, /Command blocked by sandbox denylist/);
      // Exactly the first 200 chars of the command are shown ('sudo ' + 195 x's),
      // plus the remainder footer (305 - 200 = 105 more chars).
      assert.ok(err.message.includes(longCommand.slice(0, 200)));
      assert.match(err.message, /\[\.\.\. truncated, 105 more chars \.\.\.\]/);
      assert.doesNotMatch(err.message, /x{196}/);
      return true;
    },
  );
});
