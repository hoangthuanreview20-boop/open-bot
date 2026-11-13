/**
 * Tests for the deep file search tool added in v0.97 (Team T6):
 * search_files_deep (packages/tools/src/fileSearchTools.ts).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/file-search-v097.test.mjs
 *
 * Pure filesystem fixtures in the OS temp dir — no network.
 * Covers: literal/regex/whole-word matching, include/exclude globs,
 * .gitignore, context lines, max_results/max_files caps, the time
 * budget (partial results on timeout), binary + oversized skips, and
 * workspace confinement.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FILE_SEARCH_TOOLS,
  createFileSearchTools,
  globToRegExp,
  isGitignored,
  matchesGlob,
  parseGitignore,
  searchFilesDeep,
} from '../packages/tools/dist/fileSearchTools.js';

const tmpDirs = [];

function tmpDir(prefix = 'open-bot-search-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function fixtureTree() {
  const dir = tmpDir();
  write(dir, 'src/a.ts', 'export const foo = 1;\n// foo bar baz\nconst foobar = 2;\n');
  write(dir, 'src/b.ts', 'import { foo } from "./a";\nconsole.log("hello");\n');
  write(dir, 'src/deep/c.ts', 'const needle = "FOO";\n// nothing here\n');
  write(dir, 'notes.md', '# Title\nfoo appears in markdown too\n');
  write(dir, 'notes.test.ts', 'test("foo", () => {});\n');
  write(dir, 'ignored.log', 'foo in an ignored file\n');
  write(dir, '.gitignore', '*.log\nbuild/\n');
  write(dir, 'build/out.js', 'foo in build output\n');
  // Binary file (NUL byte) + a file the search must skip.
  const bin = path.join(dir, 'bin.dat');
  fs.writeFileSync(bin, Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01, 0x02]));
  return dir;
}

const CTX = (workspaceDir) => ({ workspaceDir, signal: undefined });
const tool = FILE_SEARCH_TOOLS[0];
const run = (args, workspaceDir) => tool.execute(args, CTX(workspaceDir));

// ---------------------------------------------------------------------------
// Registration + pure helpers
// ---------------------------------------------------------------------------

test('file search: one tool, read-only, correct name', () => {
  assert.equal(FILE_SEARCH_TOOLS.length, 1);
  assert.equal(createFileSearchTools().length, 1);
  assert.equal(tool.definition.name, 'search_files_deep');
  assert.equal(tool.needsApproval, false);
  assert.ok(tool.definition.description.length > 20);
  assert.deepEqual(tool.definition.parameters.required, ['pattern']);
});

test('file search: glob matching (basename + ** + ?)', () => {
  assert.ok(matchesGlob('src/a.ts', '*.ts'));
  assert.ok(matchesGlob('src/deep/c.ts', '*.ts'));
  assert.ok(matchesGlob('src/deep/c.ts', 'src/**'));
  assert.ok(matchesGlob('src/deep/c.ts', 'src/**/*.ts'));
  assert.ok(!matchesGlob('src/a.ts', 'src/*.md'));
  assert.ok(matchesGlob('src/a.ts', 'src/a.t?'));
  assert.ok(!matchesGlob('src/a.ts', 'src/b.t?'));
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('a.ts.bak'));
});

test('file search: .gitignore parsing (negation, dir-only, bare names)', () => {
  const rules = parseGitignore('# comment\n*.log\nbuild/\n!important.log\n');
  assert.equal(rules.length, 3);
  assert.ok(isGitignored('a.log', rules));
  assert.ok(isGitignored('deep/a.log', rules));
  assert.ok(!isGitignored('important.log', rules));
  assert.ok(isGitignored('build/out.js', rules));
  assert.ok(isGitignored('build', rules));
  assert.ok(!isGitignored('src/a.ts', rules));
});

// ---------------------------------------------------------------------------
// Core search behaviour (via the tool)
// ---------------------------------------------------------------------------

test('file search: literal match across files, file:line format', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'foo' }, dir);
  assert.ok(!out.startsWith('Error:'), out);
  assert.match(out, /Search "foo" in "\." — 6 match\(es\) in 4 file\(s\) \(6 file\(s\) searched, 3 skipped\)/);
  assert.match(out, /^src\/a\.ts:1: export const foo = 1;$/m);
  assert.match(out, /^src\/a\.ts:2: \/\/ foo bar baz$/m);
  assert.match(out, /^src\/b\.ts:1: import \{ foo \} from "\.\/a";$/m);
  assert.match(out, /^notes\.md:2: foo appears in markdown too$/m);
  // .gitignore: *.log + build/ are skipped; binary is skipped.
  assert.doesNotMatch(out, /ignored\.log/);
  assert.doesNotMatch(out, /build\/out\.js/);
  assert.doesNotMatch(out, /bin\.dat/);
});

test('file search: case-insensitive + regex + whole-word', async () => {
  const dir = fixtureTree();
  const ci = await run({ pattern: 'FOO', case_insensitive: true }, dir);
  assert.match(ci, /7 match\(es\)/, 'FOO (ci) also matches the uppercase line in c.ts');

  const cs = await run({ pattern: 'FOO' }, dir);
  assert.match(cs, /1 match\(es\)/);

  const re = await run({ pattern: 'foo\\s+bar', regex: true }, dir);
  assert.match(re, /1 match\(es\)/);
  assert.match(re, /src\/a\.ts:2/);

  const badRe = await run({ pattern: '(unclosed', regex: true }, dir);
  assert.match(badRe, /^Error: Invalid regex/);

  const whole = await run({ pattern: 'foo', whole_word: true }, dir);
  // 'foobar' on a.ts:3 must NOT match; 'foo' on a.ts:1/2, b.ts:1, notes.md:2 must.
  assert.match(whole, /5 match\(es\)/);
  assert.doesNotMatch(whole, /foobar/);

  const empty = await run({ pattern: '' }, dir);
  assert.match(empty, /^Error: Pattern must not be empty/);
});

test('file search: include / exclude globs narrow the search', async () => {
  const dir = fixtureTree();
  const onlyTs = await run({ pattern: 'foo', include: ['*.ts'] }, dir);
  assert.match(onlyTs, /5 match\(es\) in 3 file\(s\)/);
  assert.doesNotMatch(onlyTs, /notes\.md/);

  const noTests = await run({ pattern: 'foo', exclude: ['*.test.*'] }, dir);
  assert.match(noTests, /5 match\(es\)/);
  const withTests = await run({ pattern: 'foo', include: ['*.test.*'] }, dir);
  assert.match(withTests, /1 match\(es\)/);
  assert.match(withTests, /notes\.test\.ts:1/);

  const subdir = await run({ pattern: 'foo', path: 'src/deep' }, dir);
  assert.match(subdir, /No matches for "foo" in "src\/deep"/);

  const single = await run({ pattern: 'foo', path: 'src/a.ts' }, dir);
  assert.match(single, /3 match\(es\) in 1 file\(s\)/);
});

test('file search: context lines are shown with a two-space prefix', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'foobar', context_lines: 1 }, dir);
  assert.match(out, /^src\/a\.ts:3: const foobar = 2;$/m);
  assert.match(out, /^  src\/a\.ts:2: \/\/ foo bar baz$/m);
  const badCtx = await run({ pattern: 'foo', context_lines: 9 }, dir);
  assert.match(badCtx, /^Error: Argument "context_lines" must be an integer between 0 and 5/);
});

test('file search: max_results caps output with a clear note', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'foo', max_results: 2 }, dir);
  assert.match(out, /2 match\(es\) in 2 file\(s\)/);
  assert.match(out, /\[\.\.\. showing first 2 of at least 2 matches/);
  const badMax = await run({ pattern: 'foo', max_results: 0 }, dir);
  assert.match(badMax, /^Error: Argument "max_results" must be an integer between 1 and 500/);
});

test('file search: respect_gitignore=false reads ignored files', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'foo', respect_gitignore: false }, dir);
  assert.match(out, /ignored\.log:1: foo in an ignored file/);
  assert.match(out, /build\/out\.js:1: foo in build output/);
});

test('file search: no matches reports files searched', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'zzz-no-such-string' }, dir);
  assert.match(out, /^No matches for "zzz-no-such-string" in "\." \(6 file\(s\) searched, 3 skipped\)/);
});

test('file search: a path escaping the workspace is rejected', async () => {
  const dir = fixtureTree();
  const out = await run({ pattern: 'foo', path: '../outside' }, dir);
  assert.match(out, /^Error: Path escapes workspace/);
});

// ---------------------------------------------------------------------------
// Time budget + file caps (core function, direct)
// ---------------------------------------------------------------------------

test('file search: timeout returns partial results instead of hanging', async () => {
  const dir = fixtureTree();
  // One huge file: 200k matching lines cannot be scanned inside a 1ms
  // budget, so the per-200-line deadline check must fire mid-file.
  write(dir, 'many/big.txt', 'foo\n'.repeat(200_000));
  const result = searchFilesDeep({
    workspaceDir: dir,
    pattern: 'foo',
    path: 'many',
    maxResults: 500,
    maxFiles: 1000,
    timeoutMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.matches.length > 0, 'partial results survive the timeout');
  assert.ok(result.matches.length < 200_000, 'the scan stopped early');
  // The formatted tool output carries the timeout note (max_results
  // raised so the match cap cannot fire before the deadline check).
  const out = await run({ pattern: 'foo', path: 'many', timeout_ms: 1, max_results: 500 }, dir);
  assert.match(out, /stopped early: 1ms time budget ran out/);
});

test('file search: max_files cap stops the search with files skipped', () => {
  const dir = fixtureTree();
  for (let i = 0; i < 10; i++) {
    write(dir, `cap/g${i}.txt`, 'foo\n');
  }
  const result = searchFilesDeep({
    workspaceDir: dir,
    pattern: 'foo',
    path: 'cap',
    maxResults: 500,
    maxFiles: 3,
    timeoutMs: 10_000,
  });
  assert.equal(result.filesSearched, 3);
  assert.equal(result.matches.length, 3);
  assert.equal(result.stoppedEarly, true);
  assert.ok(result.filesSkipped > 0);
});

test('file search: per-file counts are reported in first-match order', () => {
  const dir = fixtureTree();
  const result = searchFilesDeep({ workspaceDir: dir, pattern: 'foo', timeoutMs: 10_000 });
  assert.deepEqual(
    result.perFileCounts.map((c) => c.file),
    ['notes.md', 'notes.test.ts', 'src/a.ts', 'src/b.ts'],
  );
  assert.equal(result.perFileCounts.find((c) => c.file === 'src/a.ts').count, 3);
});
