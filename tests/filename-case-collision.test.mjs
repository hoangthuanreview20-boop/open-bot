/**
 * Regression test for CI #1 (run 43219860787, 2026-11-12): the Windows /
 * macOS build failed with TS1261 + TS1192 ("no default export" in
 * CanvasView.tsx / ChatView.tsx) because
 * `apps/desktop/src/renderer/components/Markdown.tsx` (the React
 * component, default export) and `.../markdown.ts` (the parser, named
 * exports only) share a case-insensitive stem in the same directory.
 * Linux never catches this (case-sensitive filesystem); Windows and
 * macOS default to case-insensitive, so the module resolver / emitted
 * JS confuses the two. The parser was renamed to `markdownParser.ts`;
 * this test forbids any recurrence anywhere in apps/ + packages/.
 *
 * Pure filesystem scan, no build, no network.
 *
 * Run: node --test tests/filename-case-collision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!/\.(tsx?|mts|cts)$/.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

test('no two source files in one directory share a case-insensitive stem', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(repo, r), []));
  assert.ok(files.length > 100, `expected many source files, found ${files.length}`);
  const byDir = new Map();
  for (const f of files) {
    const dir = path.dirname(f);
    const stem = path.basename(f).replace(/\.[^.]*$/, '').toLowerCase();
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    const seen = byDir.get(dir);
    if (seen.has(stem)) {
      assert.fail(
        `case-insensitive stem collision in ${path.relative(repo, dir)}: ` +
          `${path.basename(seen.get(stem))} vs ${path.basename(f)} ` +
          `(breaks Windows/macOS builds — rename one)`,
      );
    }
    seen.set(stem, f);
  }
});
