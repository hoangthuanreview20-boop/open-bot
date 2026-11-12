/**
 * Tests for v0.86 (P2-4): tree-sitter AST support for code tools —
 * `parseCodeSymbols` in packages/tools/src/code/ast.ts and the
 * `code_symbols` tool in CODE_TOOLS.
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/code-ast-v086.test.mjs
 *
 * No network, no live services: grammars are prebuilt WASM files from
 * the tree-sitter-* npm packages, loaded from node_modules.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseCodeSymbols,
  detectAstLanguage,
  supportedAstLanguagesText,
  SUPPORTED_AST_LANGUAGES,
} from '../packages/tools/dist/code/ast.js';
import { CODE_TOOLS } from '../packages/tools/dist/codeTools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => CODE_TOOLS.find((t) => t.definition.name === name);

const tempDirs = [];
function makeTempWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ast-'));
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

const JS_SAMPLE = `function greet(name) {
  return 'hi ' + name;
}

const add = (a, b) => a + b;

class Foo {
  bar() {
    return 1;
  }
}
`;

const TS_SAMPLE = `interface Shape {
  area(): number;
}

type ID = string | number;

enum Color {
  Red = 'red',
}

export function areaOf(s: Shape): number {
  return s.area();
}
`;

const TSX_SAMPLE = `export const App = () => {
  return <div>hello</div>;
};

function helper(): string {
  return 'x';
}
`;

const PY_SAMPLE = `def hello(name):
    return name

class Dog:
    def bark(self):
        return 'woof'

    def _hidden(self):
        pass
`;

function byName(symbols, qualifiedName) {
  const found = symbols.find((s) => s.qualifiedName === qualifiedName);
  assert.ok(found, `expected symbol "${qualifiedName}", got: ${symbols.map((s) => s.qualifiedName).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

test('ast: detectAstLanguage maps extensions, null for unsupported', () => {
  assert.equal(detectAstLanguage('a.js'), 'javascript');
  assert.equal(detectAstLanguage('a.jsx'), 'javascript');
  assert.equal(detectAstLanguage('a.mjs'), 'javascript');
  assert.equal(detectAstLanguage('a.cjs'), 'javascript');
  assert.equal(detectAstLanguage('a.ts'), 'typescript');
  assert.equal(detectAstLanguage('a.tsx'), 'tsx');
  assert.equal(detectAstLanguage('a.py'), 'python');
  assert.equal(detectAstLanguage('a.go'), null);
  assert.equal(detectAstLanguage('a.rs'), null);
  assert.equal(detectAstLanguage('README.md'), null);
  assert.equal(detectAstLanguage('noext'), null);
  assert.deepEqual([...SUPPORTED_AST_LANGUAGES], ['javascript', 'typescript', 'tsx', 'python']);
  assert.match(supportedAstLanguagesText(), /javascript \(\.js/);
  assert.match(supportedAstLanguagesText(), /python \(\.py\)/);
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

test('ast: JavaScript — function, arrow const, class, method with positions', async () => {
  const { language, symbols, hasError } = await parseCodeSymbols(JS_SAMPLE, 'javascript');
  assert.equal(language, 'javascript');
  assert.equal(hasError, false);

  const greet = byName(symbols, 'greet');
  assert.equal(greet.kind, 'function');
  assert.equal(greet.line, 1);
  assert.equal(greet.column, 10); // `function ` is 9 chars, name starts col 10
  assert.equal(greet.endLine, 3);

  const add = byName(symbols, 'add');
  assert.equal(add.kind, 'function');
  assert.equal(add.line, 5);

  const foo = byName(symbols, 'Foo');
  assert.equal(foo.kind, 'class');
  assert.equal(foo.line, 7);

  const bar = byName(symbols, 'Foo.bar');
  assert.equal(bar.kind, 'method');
  assert.equal(bar.line, 8);
  assert.equal(bar.column, 3);
});

// ---------------------------------------------------------------------------
// TypeScript / TSX
// ---------------------------------------------------------------------------

test('ast: TypeScript — interface, type alias, enum, exported function', async () => {
  const { symbols, hasError } = await parseCodeSymbols(TS_SAMPLE, 'typescript');
  assert.equal(hasError, false);

  const shape = byName(symbols, 'Shape');
  assert.equal(shape.kind, 'interface');
  assert.equal(shape.line, 1);

  const id = byName(symbols, 'ID');
  assert.equal(id.kind, 'type');
  assert.equal(id.line, 5);

  const color = byName(symbols, 'Color');
  assert.equal(color.kind, 'enum');
  assert.equal(color.line, 7);

  const areaOf = byName(symbols, 'areaOf');
  assert.equal(areaOf.kind, 'function');
  assert.equal(areaOf.line, 11);
});

test('ast: TSX — arrow component const + plain function', async () => {
  const { symbols, hasError } = await parseCodeSymbols(TSX_SAMPLE, 'tsx');
  assert.equal(hasError, false);
  const app = byName(symbols, 'App');
  assert.equal(app.kind, 'function');
  assert.equal(app.line, 1);
  const helper = byName(symbols, 'helper');
  assert.equal(helper.kind, 'function');
  assert.equal(helper.line, 5);
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

test('ast: Python — function, class, methods with positions', async () => {
  const { symbols, hasError } = await parseCodeSymbols(PY_SAMPLE, 'python');
  assert.equal(hasError, false);

  const hello = byName(symbols, 'hello');
  assert.equal(hello.kind, 'function');
  assert.equal(hello.line, 1);
  assert.equal(hello.column, 5); // `def ` is 4 chars

  const dog = byName(symbols, 'Dog');
  assert.equal(dog.kind, 'class');
  assert.equal(dog.line, 4);

  const bark = byName(symbols, 'Dog.bark');
  assert.equal(bark.kind, 'method');
  assert.equal(bark.line, 5);

  const hidden = byName(symbols, 'Dog._hidden');
  assert.equal(hidden.kind, 'method');
  assert.equal(hidden.line, 8);
});

// ---------------------------------------------------------------------------
// Fail-closed + robustness
// ---------------------------------------------------------------------------

test('ast: unsupported language throws a clear error (fail-closed)', async () => {
  await assert.rejects(
    () => parseCodeSymbols('package main', 'go'),
    /không hỗ trợ|Unsupported/i,
  );
  await assert.rejects(
    () => parseCodeSymbols('fn main() {}', 'rust'),
    /javascript.*typescript.*python|Hỗ trợ:/,
  );
});

test('ast: empty file parses to zero symbols, no error', async () => {
  for (const lang of ['javascript', 'typescript', 'tsx', 'python']) {
    const result = await parseCodeSymbols('', lang);
    assert.deepEqual(result.symbols, []);
    assert.equal(result.hasError, false);
  }
  const wsOnly = await parseCodeSymbols('   \n\n  ', 'python');
  assert.deepEqual(wsOnly.symbols, []);
});

test('ast: syntax-broken file does not crash, flags hasError, keeps good symbols', async () => {
  const broken = `function ok() {
  return 1;
}

function broken( {
`;
  const result = await parseCodeSymbols(broken, 'javascript');
  assert.equal(result.hasError, true);
  // The valid function before the break must still be reported.
  assert.ok(
    result.symbols.some((s) => s.qualifiedName === 'ok'),
    `expected "ok" among ${result.symbols.map((s) => s.qualifiedName).join(', ')}`,
  );

  const brokenPy = `def ok():
    return 1

def broken(
`;
  const pyResult = await parseCodeSymbols(brokenPy, 'python');
  assert.equal(pyResult.hasError, true);
  assert.ok(pyResult.symbols.some((s) => s.qualifiedName === 'ok'));
});

// ---------------------------------------------------------------------------
// code_symbols tool (via CODE_TOOLS)
// ---------------------------------------------------------------------------

test('ast: code_symbols tool is registered in CODE_TOOLS', () => {
  const t = tool('code_symbols');
  assert.ok(t, 'code_symbols missing from CODE_TOOLS');
  assert.equal(t.needsApproval, false);
  assert.ok(t.definition.description.includes('tree-sitter'));
  assert.deepEqual(t.definition.parameters.required, ['path']);
});

test('ast: code_symbols tool lists symbols of a workspace .ts file', async () => {
  const ws = makeTempWorkspace({ 'src/a.ts': TS_SAMPLE });
  const out = await tool('code_symbols').execute({ path: 'src/a.ts' }, CTX(ws));
  assert.match(out, /Symbols in "src\/a\.ts" \(typescript, 4 symbol\(s\)\)/);
  assert.match(out, /interface Shape — line 1, column 11/);
  assert.match(out, /type ID — line 5/);
  assert.match(out, /enum Color — line 7/);
  assert.match(out, /function areaOf — line 11/);
});

test('ast: code_symbols tool — Python file + language override', async () => {
  const ws = makeTempWorkspace({ 'lib/dog.py': PY_SAMPLE, 'odd.txt': 'def f():\n    pass\n' });
  const out = await tool('code_symbols').execute({ path: 'lib/dog.py' }, CTX(ws));
  assert.match(out, /function hello — line 1, column 5/);
  assert.match(out, /method Dog\.bark — line 5/);

  const forced = await tool('code_symbols').execute(
    { path: 'odd.txt', language: 'python' },
    CTX(ws),
  );
  assert.match(forced, /function f — line 1, column 5/);
});

test('ast: code_symbols tool — unsupported extension fails clearly, no guess', async () => {
  const ws = makeTempWorkspace({ 'main.go': 'package main\nfunc main() {}\n' });
  const out = await tool('code_symbols').execute({ path: 'main.go' }, CTX(ws));
  assert.match(out, /^Error:/);
  assert.match(out, /Không hỗ trợ AST/);
  assert.match(out, /python/); // lists what IS supported

  const badLang = await tool('code_symbols').execute(
    { path: 'main.go', language: 'go' },
    CTX(ws),
  );
  assert.match(badLang, /^Error: Unsupported language "go"/);
});

test('ast: code_symbols tool — missing file, empty file, broken file', async () => {
  const ws = makeTempWorkspace({
    'empty.js': '',
    'broken.js': 'function ok() { return 1; }\nfunction broken( {\n',
  });
  const missing = await tool('code_symbols').execute({ path: 'nope.js' }, CTX(ws));
  assert.match(missing, /^Error:/);

  const empty = await tool('code_symbols').execute({ path: 'empty.js' }, CTX(ws));
  assert.match(empty, /No symbols found in "empty\.js" \(javascript\)/);

  const broken = await tool('code_symbols').execute({ path: 'broken.js' }, CTX(ws));
  assert.match(broken, /function ok — line 1/);
  assert.match(broken, /lỗi cú pháp/);
});
