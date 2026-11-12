// v0.84 — regression guard for the v0.83 verification hole.
//
// In v0.83 the desktop build was red (main.ts imported
// computeComposioWebhookSignature from @open-bot/core, but the export was
// missing from the core public index — TS2724) while `npm run typecheck`
// stayed green, because the desktop typecheck script only ran
// `tsc --noEmit -p tsconfig.json` (renderer) and never checked
// `tsconfig.main.json` (main process: src/main/*). The full suite runs
// against dist and never touches the desktop main process either, so
// nothing else caught it.
//
// This test pins the invariant: for every workspace, every tsconfig that
// the build script compiles must also be covered by the typecheck script,
// and every TS/TSX source file the build touches must be inside the
// `include` of at least one typecheck-referenced tsconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACES = [
  'packages/core',
  'packages/tools',
  'apps/cli',
  'apps/desktop',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** tsconfig file names mentioned in an npm script string. */
function tsconfigsIn(script) {
  const found = new Set();
  for (const m of String(script || '').matchAll(/tsconfig(?:\.[A-Za-z0-9_-]+)?\.json/g)) {
    found.add(m[0]);
  }
  return found;
}

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      listSourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Does a tsconfig `include` entry cover `file` (both workspace-relative)? */
function includeCovers(includeEntry, fileRel) {
  const entry = includeEntry.replace(/\/+$/, '');
  if (entry === fileRel) return true;
  // Directory include ("src", "src/main"): covers everything underneath.
  if (fileRel === entry || fileRel.startsWith(entry + '/')) return true;
  // Simple glob forms used in this repo, if any appear later.
  if (entry.endsWith('/**/*')) {
    const base = entry.slice(0, -5);
    return fileRel.startsWith(base + '/');
  }
  if (entry.endsWith('/*')) {
    const base = entry.slice(0, -2);
    return fileRel.startsWith(base + '/') && !fileRel.slice(base.length + 1).includes('/');
  }
  return false;
}

for (const ws of WORKSPACES) {
  test(`typecheck covers every tsconfig the build compiles (${ws})`, () => {
    const pkg = readJson(join(ROOT, ws, 'package.json'));
    const build = pkg.scripts?.build ?? '';
    const typecheck = pkg.scripts?.typecheck ?? '';
    assert.ok(build, `${ws}: expected a build script`);
    assert.ok(typecheck, `${ws}: expected a typecheck script`);

    const buildConfigs = tsconfigsIn(build);
    const typecheckConfigs = tsconfigsIn(typecheck);
    assert.ok(
      buildConfigs.size > 0,
      `${ws}: build script references no tsconfig at all`,
    );
    for (const cfg of buildConfigs) {
      assert.ok(
        typecheckConfigs.has(cfg),
        `${ws}: build compiles ${cfg} but typecheck never checks it ` +
          `(build: ${build} | typecheck: ${typecheck})`,
      );
    }
  });

  test(`every source file is inside a typechecked tsconfig include (${ws})`, () => {
    const pkg = readJson(join(ROOT, ws, 'package.json'));
    const typecheck = pkg.scripts?.typecheck ?? '';
    const typecheckConfigs = [...tsconfigsIn(typecheck)];
    assert.ok(typecheckConfigs.length > 0, `${ws}: typecheck references no tsconfig`);

    // Union of `include` entries across the typechecked tsconfigs.
    const includes = [];
    for (const cfg of typecheckConfigs) {
      const tsconfig = readJson(join(ROOT, ws, cfg));
      for (const inc of tsconfig.include ?? []) includes.push(String(inc));
    }
    assert.ok(includes.length > 0, `${ws}: typechecked tsconfigs declare no include`);

    const srcDir = join(ROOT, ws, 'src');
    const files = listSourceFiles(srcDir);
    // Desktop also compiles vite.config.ts (renderer tsconfig includes it).
    const viteConfig = join(ROOT, ws, 'vite.config.ts');
    try {
      if (statSync(viteConfig).isFile()) files.push(viteConfig);
    } catch {
      // No vite config in this workspace — fine.
    }
    assert.ok(files.length > 0, `${ws}: no source files found under src/`);

    const uncovered = [];
    for (const f of files) {
      const rel = relative(join(ROOT, ws), f).split(sep).join('/');
      if (!includes.some((inc) => includeCovers(inc, rel))) uncovered.push(rel);
    }
    assert.deepEqual(
      uncovered,
      [],
      `${ws}: ${uncovered.length} source file(s) are compiled by the build ` +
        `but by no typechecked tsconfig: ${uncovered.slice(0, 10).join(', ')}`,
    );
  });
}

test('desktop typecheck explicitly checks the main-process tsconfig', () => {
  const pkg = readJson(join(ROOT, 'apps/desktop/package.json'));
  assert.match(
    pkg.scripts.typecheck,
    /tsconfig\.main\.json/,
    'desktop typecheck must run tsc against tsconfig.main.json ' +
      '(src/main/* is invisible to the renderer tsconfig)',
  );
  // The main tsconfig must keep covering the whole main process.
  const main = readJson(join(ROOT, 'apps/desktop/tsconfig.main.json'));
  assert.deepEqual(main.include, ['src/main']);
  const mainFiles = listSourceFiles(join(ROOT, 'apps/desktop/src/main'));
  assert.ok(mainFiles.length >= 1, 'expected main-process sources under src/main');
});
