/**
 * Tests for the v0.2 tools: ToolRegistry + CODE_TOOLS (glob/grep/delete/
 * apply_diff/git_blame/diagnostics/semantic_search/x_search).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/tools-code.test.mjs
 *
 * x_search is tested with a mocked global fetch — no real network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  CODE_TOOLS,
  parseUnifiedDiff,
  applyHunksToLines,
  unwrapBingRedirect,
} from '../packages/tools/dist/codeTools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => CODE_TOOLS.find((t) => t.definition.name === name);

// ---------------------------------------------------------------------------
// Temp workspace helper
// ---------------------------------------------------------------------------

const tempDirs = [];
function makeTempWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-test-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function fakeTool(name) {
  return {
    definition: {
      name,
      description: `Fake tool ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
    needsApproval: false,
    execute: async () => 'ok',
  };
}

test('registry: register / get / list / unregister', () => {
  const reg = new ToolRegistry();
  assert.equal(reg.size(), 0);
  reg.register(fakeTool('alpha'));
  reg.register(fakeTool('beta'));
  assert.equal(reg.size(), 2);
  assert.equal(reg.get('alpha').definition.name, 'alpha');
  assert.equal(reg.get('missing'), undefined);
  assert.deepEqual(reg.list().map((t) => t.definition.name), ['alpha', 'beta']);
  assert.equal(reg.unregister('alpha'), true);
  assert.equal(reg.unregister('alpha'), false);
  assert.equal(reg.size(), 1);
  assert.deepEqual(reg.list().map((t) => t.definition.name), ['beta']);
});

test('registry: duplicate name is rejected', () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool('dup'));
  assert.throws(() => reg.register(fakeTool('dup')), /already registered/);
});

test('registry: invalid definitions are rejected', () => {
  const reg = new ToolRegistry();
  assert.throws(
    () => reg.register({ definition: { name: '', description: 'x', parameters: { type: 'object' } }, needsApproval: false, execute: async () => '' }),
    /non-empty string "name"/,
  );
  assert.throws(
    () => reg.register({ definition: { name: 'bad name!', description: 'x', parameters: { type: 'object' } }, needsApproval: false, execute: async () => '' }),
    /Invalid tool name/,
  );
  assert.throws(
    () => reg.register({ definition: { name: 'nodesc', description: '', parameters: { type: 'object' } }, needsApproval: false, execute: async () => '' }),
    /non-empty string "description"/,
  );
  assert.throws(
    () => reg.register({ definition: { name: 'noparams', description: 'x' }, needsApproval: false, execute: async () => '' }),
    /"parameters" object/,
  );
  assert.throws(
    () => reg.register({ definition: { name: 'badreq', description: 'x', parameters: { type: 'object', properties: {}, required: ['nope'] } }, needsApproval: false, execute: async () => '' }),
    /not declared in parameters\.properties/,
  );
});

test('registry: fromDefaults builds a registry from CODE_TOOLS', () => {
  const reg = ToolRegistry.fromDefaults(CODE_TOOLS);
  assert.equal(reg.size(), 8); // v0.86 (P2-4): + 1 code_symbols (code 7 → 8).
  assert.equal(reg.get('glob_files').needsApproval, false);
  assert.equal(reg.get('delete_file').needsApproval, true);
  assert.equal(reg.get('apply_diff').needsApproval, true);
});

// ---------------------------------------------------------------------------
// glob_files / grep_search
// ---------------------------------------------------------------------------

test('glob_files: **, * and basename matching', async () => {
  const dir = makeTempWorkspace({
    'src/a.ts': 'export const a = 1;\n',
    'src/deep/b.ts': 'export const b = 2;\n',
    'README.md': '# hi\n',
    'notes/todo.md': '- x\n',
  });
  const out = await tool('glob_files').execute({ pattern: 'src/**/*.ts' }, CTX(dir));
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /src\/deep\/b\.ts/);
  assert.doesNotMatch(out, /README\.md/);

  const md = await tool('glob_files').execute({ pattern: '*.md' }, CTX(dir));
  assert.match(md, /README\.md/);
  assert.match(md, /notes\/todo\.md/);

  const none = await tool('glob_files').execute({ pattern: '**/*.py' }, CTX(dir));
  assert.match(none, /0 match/);
});

test('grep_search: plain, regex and case-insensitive', async () => {
  const dir = makeTempWorkspace({
    'a.txt': 'Hello world\nsecond line\nHELLO again\n',
    'b.txt': 'nothing here\n',
  });
  const plain = await tool('grep_search').execute({ pattern: 'Hello' }, CTX(dir));
  assert.match(plain, /a\.txt:1: Hello world/);
  assert.doesNotMatch(plain, /HELLO again/);

  const ci = await tool('grep_search').execute(
    { pattern: 'hello', case_insensitive: true },
    CTX(dir),
  );
  assert.match(ci, /a\.txt:1:/);
  assert.match(ci, /a\.txt:3: HELLO again/);

  const re = await tool('grep_search').execute(
    { pattern: '^second', regex: true },
    CTX(dir),
  );
  assert.match(re, /a\.txt:2: second line/);

  const badRe = await tool('grep_search').execute({ pattern: '([', regex: true }, CTX(dir));
  assert.match(badRe, /^Error: Invalid regex/);

  const miss = await tool('grep_search').execute({ pattern: 'zzz-nope' }, CTX(dir));
  assert.match(miss, /No matches/);
});

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

test('delete_file: deletes a file, refuses .open-bot', async () => {
  const dir = makeTempWorkspace({
    'gone.txt': 'bye\n',
    '.open-bot/state.json': '{}\n',
  });
  const out = await tool('delete_file').execute({ path: 'gone.txt' }, CTX(dir));
  assert.match(out, /Deleted "gone\.txt"/);
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);

  const refused = await tool('delete_file').execute(
    { path: '.open-bot/state.json' },
    CTX(dir),
  );
  assert.match(refused, /^Error: Refusing to delete anything under \.open-bot/);
  assert.equal(fs.existsSync(path.join(dir, '.open-bot', 'state.json')), true);

  const missing = await tool('delete_file').execute({ path: 'nope.txt' }, CTX(dir));
  assert.match(missing, /^Error:/);
});

// ---------------------------------------------------------------------------
// apply_diff
// ---------------------------------------------------------------------------

test('apply_diff: applies hunks and rejects mismatched context', async () => {
  const dir = makeTempWorkspace({ 'f.txt': 'a\nb\nc\nd\n' });
  const diff = [
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,4 +1,4 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    ' d',
  ].join('\n');
  const out = await tool('apply_diff').execute({ path: 'f.txt', diff }, CTX(dir));
  assert.match(out, /Applied 1 hunk/);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nB\nc\nd\n');

  const stale = [
    '@@ -1,4 +1,4 @@',
    ' a',
    '-zzz-not-there',
    '+Z',
    ' c',
    ' d',
  ].join('\n');
  const err = await tool('apply_diff').execute({ path: 'f.txt', diff: stale }, CTX(dir));
  assert.match(err, /^Error: Context mismatch/);
  // File is unchanged after the failed apply.
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nB\nc\nd\n');
});

test('apply_diff helpers: parse + apply pure functions', () => {
  const hunks = parseUnifiedDiff('@@ -2,2 +2,3 @@\n line2\n-line3\n+LINE3\n+extra\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(applyHunksToLines(['line1', 'line2', 'line3', 'line4'], hunks), [
    'line1',
    'line2',
    'LINE3',
    'extra',
    'line4',
  ]);
  assert.throws(() => parseUnifiedDiff('no hunks here'), /No hunks found/);
});

// ---------------------------------------------------------------------------
// code_diagnostics (node --check path — no tsconfig in the temp workspace)
// ---------------------------------------------------------------------------

test('code_diagnostics: node --check on a .js file', async () => {
  const dir = makeTempWorkspace({
    'good.js': 'const x = 1;\nconsole.log(x);\n',
    'bad.js': 'const = ;\n',
  });
  const ok = await tool('code_diagnostics').execute({ file: 'good.js' }, CTX(dir));
  assert.match(ok, /Syntax OK/);
  const bad = await tool('code_diagnostics').execute({ file: 'bad.js' }, CTX(dir));
  assert.match(bad, /SyntaxError/);

  const none = await tool('code_diagnostics').execute({}, CTX(dir));
  assert.match(none, /^Error: No tsconfig\.json/);
});

// ---------------------------------------------------------------------------
// semantic_search (keyword TF-IDF ranking)
// ---------------------------------------------------------------------------

test('semantic_search: keyword ranking puts the topical file first', async () => {
  const dir = makeTempWorkspace({
    'db.md': 'database connection pooling improves database performance and connection reuse\n'.repeat(3),
    'recipes.md': 'cooking recipes with pasta and tomato sauce for dinner\n'.repeat(3),
  });
  const out = await tool('semantic_search').execute(
    { query: 'database connection pooling' },
    CTX(dir),
  );
  assert.match(out, /db\.md/);
  assert.ok(out.indexOf('db.md') < out.indexOf('recipes.md') || !out.includes('recipes.md'));
  assert.match(out, /Keyword-ranked \(TF-IDF\)/);
});

// ---------------------------------------------------------------------------
// unwrapBingRedirect (v0.6: Bing's newer u=a1<base64> redirect format).
// x_search itself moved to webMedia.ts — its tests live in web-media-v06.
// ---------------------------------------------------------------------------

test('unwrapBingRedirect: old a1https%3A format still unwraps', () => {
  const out = unwrapBingRedirect(
    'https://www.bing.com/ck/a?!&&p=abc&u=a1https%3A%2F%2Fx.com%2Fpost%2F9&ntb=1',
  );
  assert.equal(out, 'https://x.com/post/9');
});

test('unwrapBingRedirect: new u=a1<base64> format unwraps', () => {
  const target = 'https://x.com/someone/status/123';
  const encoded = 'a1' + Buffer.from(target, 'utf-8').toString('base64');
  const out = unwrapBingRedirect(`https://www.bing.com/ck/a?!&&p=abc&u=${encoded}&ntb=1`);
  assert.equal(out, target);
});

test('unwrapBingRedirect: non-redirect URLs pass through unchanged', () => {
  assert.equal(unwrapBingRedirect('https://example.com/a'), 'https://example.com/a');
  assert.equal(unwrapBingRedirect('not a url'), 'not a url');
});

test('unwrapBingRedirect: unwraps ck/a links, leaves other URLs alone', () => {
  assert.equal(
    unwrapBingRedirect(
      'https://www.bing.com/ck/a?!&&p=abc123&u=a1https%3A%2F%2Fexample.com%2Fpage&ntb=1',
    ),
    'https://example.com/page',
  );
  assert.equal(
    unwrapBingRedirect('https://example.com/normal'),
    'https://example.com/normal',
  );
  assert.equal(unwrapBingRedirect('not a url'), 'not a url');
});
