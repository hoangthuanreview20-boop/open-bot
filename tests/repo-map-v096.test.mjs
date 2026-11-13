/**
 * Tests for v0.96 (Đội T2): repo map — `packages/tools/src/repoMap.ts`
 * (Personalized PageRank over the file-reference graph, token-budget
 * binary search, mtime parse cache, TreeContext render) and the
 * `repo_map` / `repo_map_query` tools.
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/repo-map-v096.test.mjs
 *
 * No network, no live services: tree-sitter grammars are prebuilt WASM
 * files from the tree-sitter-* npm packages, loaded from node_modules.
 * The one "live" test builds a map of this repo's own
 * `packages/core/src/coordinator` directory and asserts the ranking
 * observed there (types.ts first, coordinator.ts in the top 3).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO_MAP_TOOLS,
  buildRepoMap,
  queryRepoMap,
  buildRepoMapSection,
  formatRepoMapSection,
  buildRepoGraph,
  personalizedPageRank,
  rankRepoFiles,
  fitRepoMapToBudget,
  renderRepoFile,
  renderSymbolLine,
  discoverRepoFiles,
  parseRepoFile,
  extractImportSpecifiers,
  resolveRelativeImport,
  extractMentionedIdents,
  extractSymbolsRegexFallback,
  countIdents,
  identMultiplier,
  estimateRepoMapTokens,
  repoMapCacheStats,
  clearRepoMapCache,
  DEFAULT_REPO_MAP_TOKEN_BUDGET,
  CHAT_FILE_MULTIPLIER,
  MENTIONED_IDENT_MULTIPLIER,
  LONG_IDENT_MULTIPLIER,
  PRIVATE_IDENT_MULTIPLIER,
} from '../packages/tools/dist/repoMap.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => REPO_MAP_TOOLS.find((t) => t.definition.name === name);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tempDirs = [];
function makeTempWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-repomap-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}
afterEach(() => {
  clearRepoMapCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fixture repo mẫu ------------------------------------------------------
// core.ts: trung tâm — định nghĩa DataStore + loadData/saveData, được
// api.ts tham chiếu nhiều lần. util.py: Python, được main.ts import.
// unused.ts: không ai tham chiếu. main.ts: import api + util.

const CORE_TS = `export class DataStore {
  loadData(key: string): string {
    return 'value:' + key;
  }

  saveData(key: string, value: string): void {
    // thân hàm lưu trữ — render phải elide phần này
    const record = { key, value, savedAt: Date.now() };
    void record;
  }
}

export function loadData(key: string): string {
  return new DataStore().loadData(key);
}

export function saveData(key: string, value: string): void {
  new DataStore().saveData(key, value);
}
`;

const API_TS = `import { DataStore, loadData, saveData } from './core';

export class ApiServer {
  private store = new DataStore();

  get(key: string): string {
    return loadData(key);
  }

  put(key: string, value: string): void {
    saveData(key, value);
    const again = loadData(key);
    void again;
    const store = new DataStore();
    void store.loadData(key);
  }
}

export function startApi(): ApiServer {
  const server = new ApiServer();
  void server.get('boot');
  return server;
}
`;

const MAIN_TS = `import { startApi } from './api';
import { helper } from './util';

export function main(): void {
  const api = startApi();
  void api.get('health');
  void helper('x');
}
`;

const UTIL_PY = `def helper(name):
    """Trả về tên đã chuẩn hoá."""
    return name.strip().lower()


class Worker:
    def run(self, job):
        return helper(job)
`;

const UNUSED_TS = `export function lonelyFunction(): number {
  return 42;
}
`;

const FIXTURE = {
  'src/core.ts': CORE_TS,
  'src/api.ts': API_TS,
  'src/main.ts': MAIN_TS,
  'src/util.py': UTIL_PY,
  'src/unused.ts': UNUSED_TS,
};

const relOf = (map, rel) => map.files.findIndex((f) => f.rel === rel);
const rankPosOf = (map, rel) => map.ranked.indexOf(relOf(map, rel));

// --- Token estimate ---------------------------------------------------------

test('estimateRepoMapTokens: chars/4, làm tròn lên', () => {
  assert.equal(estimateRepoMapTokens(''), 0);
  assert.equal(estimateRepoMapTokens('abcd'), 1);
  assert.equal(estimateRepoMapTokens('abcde'), 2);
  assert.equal(estimateRepoMapTokens('x'.repeat(400)), 100);
});

// --- Ident multipliers ------------------------------------------------------

test('identMultiplier: nhắc tới 10x, dài 10x, _ đầu 0.1x, nhân dồn', () => {
  const none = new Set();
  assert.equal(identMultiplier('load', none), 1);
  assert.equal(identMultiplier('loadData', none), LONG_IDENT_MULTIPLIER); // 8 ký tự → dài
  assert.equal(identMultiplier('_priv', none), PRIVATE_IDENT_MULTIPLIER);
  assert.equal(identMultiplier('save', new Set(['save'])), MENTIONED_IDENT_MULTIPLIER);
  // Nhắc tới + dài: 10 * 10 = 100.
  assert.equal(
    identMultiplier('loadDataFromDisk', new Set(['loadDataFromDisk'])),
    MENTIONED_IDENT_MULTIPLIER * LONG_IDENT_MULTIPLIER,
  );
  // Dài + _ đầu: 10 * 0.1 = 1.
  assert.equal(identMultiplier('_longPrivateName', none), LONG_IDENT_MULTIPLIER * PRIVATE_IDENT_MULTIPLIER);
});

test('extractMentionedIdents: bỏ stopword/từ ngắn, dedupe, giao với known', () => {
  const found = extractMentionedIdents('Hãy sửa loadData trong DataStore, và kiểm tra function saveData nhé loadData');
  assert.ok(found.includes('loadData'));
  assert.ok(found.includes('DataStore'));
  assert.ok(found.includes('saveData'));
  assert.ok(!found.includes('function'));
  assert.equal(found.filter((x) => x === 'loadData').length, 1);
  const known = new Set(['loadData']);
  assert.deepEqual(extractMentionedIdents('sửa loadData và saveData', known), ['loadData']);
});

// --- Regex fallback ---------------------------------------------------------

test('extractSymbolsRegexFallback: Python def/class + scope class theo indent', () => {
  const syms = extractSymbolsRegexFallback(UTIL_PY, 'python');
  const names = syms.map((s) => s.qualifiedName);
  assert.ok(names.includes('helper'));
  assert.ok(names.includes('Worker'));
  assert.ok(names.includes('Worker.run'));
  assert.equal(syms.find((s) => s.name === 'run')?.kind, 'method');
  assert.equal(syms.find((s) => s.name === 'helper')?.kind, 'function');
});

test('extractSymbolsRegexFallback: TS function/class/interface/type', () => {
  const src = `export function foo() {}\nclass Bar {\n  baz() {}\n}\ninterface Shape { x: number }\ntype Alias = string;\nconst arrow = (a) => a;\n`;
  const syms = extractSymbolsRegexFallback(src, 'typescript');
  const byName = new Map(syms.map((s) => [s.name, s.kind]));
  assert.equal(byName.get('foo'), 'function');
  assert.equal(byName.get('Bar'), 'class');
  assert.equal(byName.get('Shape'), 'interface');
  assert.equal(byName.get('Alias'), 'type');
  assert.equal(byName.get('arrow'), 'function');
});

// --- countIdents + imports --------------------------------------------------

test('countIdents đếm identifier, bỏ stopword', () => {
  const counts = countIdents('const x = loadData(key); const y = loadData(key);');
  assert.equal(counts.get('loadData'), 2);
  assert.equal(counts.get('key'), 2);
  assert.equal(counts.get('const'), undefined);
});

test('extractImportSpecifiers: TS import/require + Python import/from', () => {
  const ts = `import { a } from './core';\nimport './side';\nconst x = require('../lib');\nimport dep from 'react';\n`;
  const specs = extractImportSpecifiers(ts, 'typescript');
  assert.ok(specs.includes('./core'));
  assert.ok(specs.includes('./side'));
  assert.ok(specs.includes('../lib'));
  assert.ok(specs.includes('react'));
  const py = `import os\nfrom . import helper\nfrom ..pkg import thing\n`;
  const pySpecs = extractImportSpecifiers(py, 'python');
  assert.ok(pySpecs.includes('os'));
  assert.ok(pySpecs.includes('.'));
  assert.ok(pySpecs.includes('..pkg'));
});

test('resolveRelativeImport: tương đối resolve được, bare thì null', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const apiAbs = path.join(dir, 'src', 'api.ts');
  const known = new Set(
    ['src/core.ts', 'src/api.ts', 'src/main.ts', 'src/util.py', 'src/unused.ts'].map((r) =>
      path.join(dir, r),
    ),
  );
  assert.equal(resolveRelativeImport('./core', apiAbs, known), path.join(dir, 'src', 'core.ts'));
  assert.equal(resolveRelativeImport('./util', path.join(dir, 'src', 'main.ts'), known), path.join(dir, 'src', 'util.py'));
  assert.equal(resolveRelativeImport('react', apiAbs, known), null);
  assert.equal(resolveRelativeImport('./nope', apiAbs, known), null);
});

// --- discoverRepoFiles ------------------------------------------------------

test('discoverRepoFiles: bỏ node_modules/dist/.git, bỏ file quá lớn, sắp xếp', () => {
  const dir = makeTempWorkspace({
    ...FIXTURE,
    'node_modules/dep/index.js': 'export const x = 1;\n',
    'dist/out.js': 'export const y = 1;\n',
    '.git/config': '[core]\n',
    'big.ts': `export const big = '${'x'.repeat(1_000_001)}';\n`,
  });
  const found = discoverRepoFiles(dir);
  assert.ok(!found.relPaths.some((r) => r.startsWith('node_modules')));
  assert.ok(!found.relPaths.some((r) => r.startsWith('dist')));
  assert.ok(!found.relPaths.some((r) => r.startsWith('.git')));
  assert.ok(!found.relPaths.includes('big.ts'));
  assert.equal(found.skippedOversize, 1);
  assert.ok(found.relPaths.includes('src/core.ts'));
  assert.deepEqual(found.relPaths, [...found.relPaths].sort());
});

// --- parseRepoFile (tree-sitter) --------------------------------------------

test('parseRepoFile: TS trích symbol + signature, Python không fallback', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const core = await parseRepoFile(path.join(dir, 'src', 'core.ts'), 'src/core.ts');
  assert.equal(core.fallback, false);
  assert.ok(core.symbols.some((s) => s.name === 'DataStore' && s.kind === 'class'));
  assert.ok(core.symbols.some((s) => s.name === 'loadData' && s.kind === 'function'));
  assert.ok(core.symbols.some((s) => s.qualifiedName === 'DataStore.loadData'));
  const sig = core.symbols.find((s) => s.name === 'loadData')?.signature ?? '';
  assert.ok(sig.includes('loadData'));
  const py = await parseRepoFile(path.join(dir, 'src', 'util.py'), 'src/util.py');
  assert.equal(py.fallback, false);
  assert.ok(py.symbols.some((s) => s.name === 'helper' && s.kind === 'function'));
  assert.ok(py.symbols.some((s) => s.qualifiedName === 'Worker.run' && s.kind === 'method'));
});

// --- PageRank trên repo mẫu -------------------------------------------------

test('PageRank: file trung tâm (core) xếp trên file không ai dùng (unused); tổng điểm = 1', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const map = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.equal(map.files.length, 5);
  assert.ok(map.edges.length > 0);
  const sum = map.scores.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `scores sum to ${sum}`);
  assert.ok(map.scores.every((s) => s > 0));
  assert.ok(rankPosOf(map, 'src/core.ts') < rankPosOf(map, 'src/unused.ts'));
  assert.ok(rankPosOf(map, 'src/api.ts') < rankPosOf(map, 'src/unused.ts'));
  assert.equal(map.ranked[map.ranked.length - 1], relOf(map, 'src/unused.ts'));
});

test('PageRank unit: chuỗi A→B→C, personalization dồn vào A thì A cao nhất', () => {
  // A tham chiếu B, B tham chiếu C; personalization chỉ vào A.
  const scores = personalizedPageRank(3, [
    { from: 0, to: 1, rawReferences: 4, weight: 2 },
    { from: 1, to: 2, rawReferences: 4, weight: 2 },
  ], [0]);
  assert.equal(scores.length, 3);
  assert.ok(Math.abs(scores.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(scores[0] > scores[1] && scores[1] > scores[2]);
  // Không personalization: vẫn là phân phối hợp lệ.
  const uniform = personalizedPageRank(3, [
    { from: 0, to: 1, rawReferences: 4, weight: 2 },
    { from: 1, to: 2, rawReferences: 4, weight: 2 },
  ], []);
  assert.ok(Math.abs(uniform.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(uniform.every((s) => s > 0));
});

test('buildRepoGraph: cạnh api→core tồn tại, weight = sqrt(raw) khi không có chat/mention', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const map = await buildRepoMap(dir, { tokenBudget: 4096 });
  const apiIdx = relOf(map, 'src/api.ts');
  const coreIdx = relOf(map, 'src/core.ts');
  const edge = map.edges.find((e) => e.from === apiIdx && e.to === coreIdx);
  assert.ok(edge, 'expected edge api.ts -> core.ts');
  assert.ok(edge.rawReferences > 0);
  assert.ok(Math.abs(edge.weight - Math.sqrt(edge.rawReferences)) < 1e-9);
  // Không có self-edge.
  assert.ok(!map.edges.some((e) => e.from === e.to));
});

test('chatFiles: file đang chat được 50x + personalization — api.ts vượt core.ts', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const base = await buildRepoMap(dir, { tokenBudget: 4096 });
  const withChat = await buildRepoMap(dir, {
    tokenBudget: 4096,
    chatFiles: ['src/api.ts'],
  });
  const baseApi = base.scores[relOf(base, 'src/api.ts')];
  const chatApi = withChat.scores[relOf(withChat, 'src/api.ts')];
  assert.ok(chatApi > baseApi, `api score ${baseApi} -> ${chatApi}`);
  assert.equal(withChat.ranked[0], relOf(withChat, 'src/api.ts'));
  // Cạnh main→api được nhân 50x vì đích là file đang chat.
  const mainIdx = relOf(withChat, 'src/main.ts');
  const apiIdx = relOf(withChat, 'src/api.ts');
  const edge = withChat.edges.find((e) => e.from === mainIdx && e.to === apiIdx);
  assert.ok(edge);
  assert.ok(Math.abs(edge.weight - Math.sqrt(edge.rawReferences) * CHAT_FILE_MULTIPLIER) < 1e-9);
});

test('mentionedIdents: nhắc helper thì util.py tăng điểm so với baseline', async () => {
  // LƯU Ý: mention chỉ đổi thứ hạng khi file nhắc tới có >= 2 cạnh ra
  // (mention scale trọng số cạnh, nhưng một file chỉ có 1 cạnh ra thì
  // xác suất chuyển đổi của nó vẫn là 1.0 — vd nhắc loadData chỉ scale
  // cạnh duy nhất api→core nên điểm không đổi). main.ts tham chiếu cả
  // api.ts (startApi) lẫn util.py (helper) nên nhắc helper làm lệch
  // cán cân main→util so với main→api.
  const dir = makeTempWorkspace(FIXTURE);
  const base = await buildRepoMap(dir, { tokenBudget: 4096 });
  const boosted = await buildRepoMap(dir, {
    tokenBudget: 4096,
    userText: 'Hãy sửa hàm helper trong Worker giúp mình.',
  });
  const baseUtil = base.scores[relOf(base, 'src/util.py')];
  const boostedUtil = boosted.scores[relOf(boosted, 'src/util.py')];
  assert.ok(boostedUtil > baseUtil, `util score ${baseUtil} -> ${boostedUtil}`);
  const baseApi = base.scores[relOf(base, 'src/api.ts')];
  const boostedApi = boosted.scores[relOf(boosted, 'src/api.ts')];
  assert.ok(boostedApi < baseApi, `api score ${baseApi} -> ${boostedApi}`);
  // Trực tiếp trên đồ thị: cạnh main→util nặng hơn khi helper được nhắc.
  const mainIdx = relOf(boosted, 'src/main.ts');
  const utilIdx = relOf(boosted, 'src/util.py');
  const edge = boosted.edges.find((e) => e.from === mainIdx && e.to === utilIdx);
  const baseEdge = base.edges.find((e) => e.from === mainIdx && e.to === utilIdx);
  assert.ok(edge && baseEdge && edge.weight > baseEdge.weight);
});

// --- Budget: binary search + hồi quy không vượt budget ----------------------

test('fitRepoMapToBudget: budget nhỏ thì ít file, budget lớn thì hết, luôn vừa budget', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const map = await buildRepoMap(dir, { tokenBudget: 4096 });
  const tiny = fitRepoMapToBudget(map.files, map.ranked, map.scores, 10);
  assert.equal(tiny.count, 0);
  assert.equal(tiny.rendered, '');
  const small = fitRepoMapToBudget(map.files, map.ranked, map.scores, 200);
  assert.ok(small.count >= 1 && small.count < map.files.length);
  assert.ok(small.tokenEstimate <= 200);
  const huge = fitRepoMapToBudget(map.files, map.ranked, map.scores, 1_000_000);
  assert.equal(huge.count, map.files.length);
  // Tính đơn điệu: budget tăng thì count không giảm.
  let prev = 0;
  for (const budget of [50, 100, 200, 400, 800, 1600]) {
    const fitted = fitRepoMapToBudget(map.files, map.ranked, map.scores, budget);
    assert.ok(fitted.count >= prev, `budget ${budget}: count ${fitted.count} < ${prev}`);
    assert.ok(fitted.tokenEstimate <= budget);
    prev = fitted.count;
  }
});

test('HỒI QUY: buildRepoMap không bao giờ vượt token budget (nhiều mức budget)', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  for (const budget of [1, 10, 50, 100, 256, 1024, 4096]) {
    const map = await buildRepoMap(dir, { tokenBudget: budget, chatFiles: ['src/api.ts'] });
    assert.ok(
      map.tokenEstimate <= budget,
      `budget ${budget}: tokenEstimate ${map.tokenEstimate} vượt budget`,
    );
    assert.equal(map.budget, budget);
  }
});

test('Không có chatFiles thì budget nhân 8x (mặc định 1024 → 8192)', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const map = await buildRepoMap(dir, {});
  assert.equal(map.budget, DEFAULT_REPO_MAP_TOKEN_BUDGET * 8);
  const withChat = await buildRepoMap(dir, { chatFiles: ['src/api.ts'] });
  assert.equal(withChat.budget, DEFAULT_REPO_MAP_TOKEN_BUDGET);
});

// --- Cache mtime ------------------------------------------------------------

test('Cache mtime: build lần 2 không parse lại; sửa file thì chỉ parse lại file đó', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const first = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.equal(first.cacheHits, 0);
  const second = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.equal(second.cacheHits, 5);
  assert.equal(repoMapCacheStats().entries, 5);
  // Sửa một file (đổi mtime + nội dung).
  fs.appendFileSync(path.join(dir, 'src', 'unused.ts'), '\nexport function extra(): void {}\n');
  const third = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.equal(third.cacheHits, 4);
  const unused = third.files.find((f) => f.rel === 'src/unused.ts');
  assert.ok(unused?.symbols.some((s) => s.name === 'extra'));
  // Đổi mtime nhưng giữ nguyên nội dung vẫn parse lại (cache key là mtime).
  const before = repoMapCacheStats();
  fs.utimesSync(path.join(dir, 'src', 'core.ts'), new Date(), new Date(Date.now() + 5000));
  await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.ok(repoMapCacheStats().misses > before.misses);
});

// --- Render elision ---------------------------------------------------------

test('Render: chỉ signature + "..." — thân hàm không lọt vào map', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const map = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.ok(map.rendered.includes('...'), 'rendered map should contain elision markers');
  assert.ok(!map.rendered.includes('savedAt: Date.now()'), 'function body must be elided');
  assert.ok(!map.rendered.includes('return \'value:\' + key'), 'function body must be elided');
  assert.ok(map.rendered.includes('src/core.ts'));
  assert.ok(map.rendered.includes('loadData'));
  const coreFile = map.files.find((f) => f.rel === 'src/core.ts');
  const line = renderSymbolLine(coreFile.symbols.find((s) => s.name === 'loadData'));
  assert.ok(line.includes('loadData'));
  assert.ok(line.includes('...'));
  assert.ok(line.includes('(line '));
  const fileText = renderRepoFile(coreFile, 0, 0.5);
  assert.ok(fileText.startsWith('### src/core.ts (rank 1, score 0.5000)'));
});

test('rankRepoFiles: điểm giảm dần, hoà thì đường dẫn tăng dần', () => {
  const files = [
    { rel: 'b.ts' },
    { rel: 'a.ts' },
    { rel: 'c.ts' },
  ];
  assert.deepEqual(rankRepoFiles(files, [0.5, 0.5, 0.1]), [1, 0, 2]);
});

// --- buildRepoMapSection / formatRepoMapSection ------------------------------

test('buildRepoMapSection: thư mục rỗng → "", enabled:false → "", có file → có header', async () => {
  const empty = makeTempWorkspace({});
  assert.equal(await buildRepoMapSection(empty), '');
  const dir = makeTempWorkspace(FIXTURE);
  assert.equal(await buildRepoMapSection(dir, { enabled: false }), '');
  const section = await buildRepoMapSection(dir, { tokenBudget: 4096 });
  assert.ok(section.startsWith('[Repo map'));
  assert.ok(section.includes('src/core.ts'));
  assert.ok(!section.includes('savedAt: Date.now()'));
  // Thư mục không tồn tại → '' (best-effort, không throw).
  assert.equal(await buildRepoMapSection(path.join(dir, 'khong-co')), '');
  // formatRepoMapSection dùng lại map đã build (không build lại) — cho
  // đúng section như buildRepoMapSection với cùng input.
  const map = await buildRepoMap(dir, { tokenBudget: 4096 });
  assert.equal(formatRepoMapSection(map), section);
});

test('buildRepoMap: thư mục trống → map rỗng; root không phải thư mục → throw', async () => {
  const empty = makeTempWorkspace({});
  const map = await buildRepoMap(empty);
  assert.equal(map.files.length, 0);
  assert.equal(map.renderedFiles, 0);
  assert.equal(map.rendered, '');
  const dir = makeTempWorkspace(FIXTURE);
  await assert.rejects(buildRepoMap(path.join(dir, 'src', 'core.ts')), /not a directory/);
});

// --- Tools ------------------------------------------------------------------

test('tool repo_map: build map cho 1 thư mục, trả top files + token estimate', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const out = await tool('repo_map').execute({ path: '.' }, CTX(dir));
  assert.ok(!out.startsWith('Error:'), out.slice(0, 200));
  assert.ok(out.includes('src/core.ts'));
  assert.ok(out.includes('Top files by PageRank'));
  assert.ok(out.includes('budget 8192'), out.slice(0, 300));
  assert.ok(out.includes('...'));
  const outChat = await tool('repo_map').execute(
    { path: '.', chatFiles: ['src/api.ts'], tokenBudget: 512 },
    CTX(dir),
  );
  assert.ok(outChat.includes('budget 512'));
  // tokenBudget <= 0 → lỗi rõ.
  const bad = await tool('repo_map').execute({ tokenBudget: 0 }, CTX(dir));
  assert.ok(bad.startsWith('Error:'));
  // Thư mục không có trong workspace → lỗi rõ (resolveWithin chặn).
  const outside = await tool('repo_map').execute({ path: '../outside' }, CTX(dir));
  assert.ok(outside.startsWith('Error:'));
});

test('tool repo_map_query: map cá nhân hoá theo file chat + tin user', async () => {
  const dir = makeTempWorkspace(FIXTURE);
  const out = await tool('repo_map_query').execute(
    { path: '.', chatFiles: ['src/api.ts'], userText: 'Sửa loadData trong ApiServer' },
    CTX(dir),
  );
  assert.ok(!out.startsWith('Error:'), out.slice(0, 200));
  assert.ok(out.includes('[Repo map'));
  assert.ok(out.includes('src/api.ts'));
  // mentionedIdents trực tiếp cũng được chấp nhận.
  const out2 = await tool('repo_map_query').execute(
    { path: '.', mentionedIdents: ['DataStore'] },
    CTX(dir),
  );
  assert.ok(out2.includes('src/core.ts'));
});

test('REPO_MAP_TOOLS: đúng 2 tool, read-only, có mô tả + schema hợp lệ', () => {
  assert.equal(REPO_MAP_TOOLS.length, 2);
  for (const t of REPO_MAP_TOOLS) {
    assert.equal(t.needsApproval, false);
    assert.ok(t.definition.description.length > 50);
    assert.equal(t.definition.parameters.type, 'object');
  }
  assert.deepEqual(
    REPO_MAP_TOOLS.map((t) => t.definition.name),
    ['repo_map', 'repo_map_query'],
  );
});

// --- Live test trên chính repo open-bot -------------------------------------

test('LIVE: map của packages/core/src/coordinator xếp types.ts đầu, coordinator.ts top 3', async () => {
  const dir = path.join(REPO_ROOT, 'packages', 'core', 'src', 'coordinator');
  // Budget 20000 (không chat → thực tế 160000) để cả 4 file vừa render.
  const map = await buildRepoMap(dir, { tokenBudget: 20000 });
  assert.equal(map.files.length, 4);
  assert.ok(map.files.some((f) => f.rel === 'coordinator.ts'));
  assert.equal(map.ranked[0], relOf(map, 'types.ts'));
  assert.ok(rankPosOf(map, 'coordinator.ts') < 3, 'coordinator.ts should rank in the top 3');
  assert.ok(map.tokenEstimate <= map.budget, 'live map must respect its budget');
  assert.ok(map.rendered.includes('coordinator.ts'));
});

test('LIVE: map của packages/core/src/agent có loop.ts trong top 5 và vừa budget', async () => {
  const dir = path.join(REPO_ROOT, 'packages', 'core', 'src', 'agent');
  const map = await queryRepoMap(dir, {
    chatFiles: ['loop.ts'],
    userText: 'sửa vòng lặp chạy tool trong loop',
    tokenBudget: 8192,
  });
  assert.ok(map.files.length >= 20, `expected many agent files, got ${map.files.length}`);
  assert.ok(rankPosOf(map, 'loop.ts') < 5, 'loop.ts should rank in the top 5 when in chat');
  assert.ok(map.tokenEstimate <= map.budget);
  assert.ok(map.rendered.includes('loop.ts'));
});
