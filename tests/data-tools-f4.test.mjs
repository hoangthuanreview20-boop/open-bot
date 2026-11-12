/**
 * Tests for the v0.89 data tools (worker F4): csv_parse, csv_filter,
 * csv_aggregate, json_query, json_to_csv, csv_to_json
 * (packages/tools/src/dataTools.ts, wired into tools.ts ALL_TOOLS).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/data-tools-f4.test.mjs
 *
 * No live network, no real credentials. Pure functions are tested
 * directly; tool wrappers are tested through createDefaultTools()
 * with a temp workspace.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDefaultTools, ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  DATA_TOOLS,
  parseCsv,
  csvToJson,
  jsonToCsv,
  filterRows,
  parseConditions,
  parseAggregates,
  aggregateRows,
  queryJsonPath,
  MAX_DATA_INPUT_BYTES,
  MAX_DATA_ROWS,
} from '../packages/tools/dist/dataTools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => {
  const t = createDefaultTools().find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

const tempDirs = [];
function makeTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-data-f4-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const SAMPLE_CSV = 'name,age,city\nAn,30,Hanoi\nBinh,25,Saigon\nChi,30,Hanoi\n';

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('data-tools: 6 tools in DATA_TOOLS and in ALL_TOOLS, no approval, no duplicate names', () => {
  const names = DATA_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, [
    'csv_aggregate',
    'csv_filter',
    'csv_parse',
    'csv_to_json',
    'json_query',
    'json_to_csv',
  ]);
  for (const t of DATA_TOOLS) assert.equal(t.needsApproval, false, t.definition.name);
  for (const name of names) assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), name);
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(allNames).size, allNames.length, 'duplicate tool names in ALL_TOOLS');
});

// ---------------------------------------------------------------------------
// parseCsv / csvToJson
// ---------------------------------------------------------------------------

test('data-tools: parseCsv handles quotes, doubled quotes, embedded commas/newlines, CRLF', () => {
  const rows = parseCsv('name,note\r\n"An, A","line1\nline2"\r\nB,"say ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['An, A', 'line1\nline2'],
    ['B', 'say "hi"'],
  ]);
});

test('data-tools: csvToJson uses the first row as header; blank/short rows padded', () => {
  const rows = csvToJson('a,b,c\n1,2\n3,4,5,6\n');
  assert.deepEqual(rows, [
    { a: '1', b: '2', c: '' },
    { a: '3', b: '4', c: '5' },
  ]);
});

test('data-tools: csvToJson rejects an unterminated quoted field', () => {
  assert.throws(() => parseCsv('"unterminated'), /unterminated quoted field/);
});

test('data-tools: parseCsv rejects input over 5 MB / 100k rows', () => {
  assert.throws(() => parseCsv('x'.repeat(MAX_DATA_INPUT_BYTES + 1)), /over the .* byte limit/);
  const many = `h\n${'r\n'.repeat(MAX_DATA_ROWS)}`;
  assert.throws(() => parseCsv(many), /over the .* row limit/);
});

// ---------------------------------------------------------------------------
// filter / aggregate
// ---------------------------------------------------------------------------

test('data-tools: filterRows numeric + string compare, && conditions, contains', () => {
  const rows = csvToJson(SAMPLE_CSV);
  assert.deepEqual(
    filterRows(rows, parseConditions('age > 28 && city == Hanoi')).map((r) => r.name),
    ['An', 'Chi'],
  );
  assert.deepEqual(
    filterRows(rows, parseConditions('name contains in')).map((r) => r.name),
    ['Binh'],
  );
  assert.deepEqual(
    filterRows(rows, parseConditions('city != Hanoi')).map((r) => r.name),
    ['Binh'],
  );
  assert.deepEqual(
    filterRows(rows, parseConditions('age <= 25')).map((r) => r.name),
    ['Binh'],
  );
});

test('data-tools: parseConditions rejects bad syntax and doubled operators', () => {
  assert.throws(() => parseConditions('age >> 3'), /Bad condition/);
  assert.throws(() => parseConditions('just words'), /Bad condition/);
  assert.throws(() => parseConditions(''), /must not be empty/);
});

test('data-tools: aggregateRows group-by + count/sum/avg/min/max', () => {
  const rows = csvToJson(SAMPLE_CSV);
  const out = aggregateRows(rows, 'city', parseAggregates('count, sum:age, avg:age, min:age, max:age'));
  assert.deepEqual(out, [
    { group: 'Hanoi', count: 2, sum_age: 60, avg_age: 30, min_age: 30, max_age: 30 },
    { group: 'Saigon', count: 1, sum_age: 25, avg_age: 25, min_age: 25, max_age: 25 },
  ]);
});

test('data-tools: parseAggregates rejects unknown aggregates', () => {
  assert.throws(() => parseAggregates('median:age'), /Bad aggregate/);
  assert.throws(() => parseAggregates('sum'), /Bad aggregate/);
});

// ---------------------------------------------------------------------------
// json_query / json_to_csv
// ---------------------------------------------------------------------------

test('data-tools: queryJsonPath dotted path, index, filter, array map', () => {
  const doc = {
    a: { b: [{ c: 1 }, { c: 2 }] },
    users: [
      { name: 'An', age: 30 },
      { name: 'Binh', age: 20 },
    ],
  };
  assert.equal(queryJsonPath(doc, 'a.b[1].c'), 2);
  assert.deepEqual(queryJsonPath(doc, 'users[?age>25].name'), ['An']);
  assert.deepEqual(queryJsonPath(doc, 'users.name'), ['An', 'Binh']);
  assert.equal(queryJsonPath(doc, 'a.missing'), undefined);
  assert.throws(() => queryJsonPath(doc, 'a..b'), /Bad JSON path segment/);
});

test('data-tools: jsonToCsv quotes cells, stringifies nested values', () => {
  assert.equal(jsonToCsv([{ a: 1, b: 'x,y' }, { a: 2, b: 'q"q', c: [1] }]), 'a,b,c\n1,"x,y",\n2,"q""q",[1]');
  assert.throws(() => jsonToCsv([1, 2]), /array of objects/);
});

// ---------------------------------------------------------------------------
// Tool wrappers (through the registry)
// ---------------------------------------------------------------------------

test('data-tools: csv_parse tool reads inline CSV and a workspace file', async () => {
  const ws = makeTempWorkspace({ 't.csv': SAMPLE_CSV });
  const out = await tool('csv_parse').execute({ csv: SAMPLE_CSV }, CTX(ws));
  assert.match(out, /^3 row\(s\)/);
  assert.match(out, /"name": "An"/);
  const fromFile = await tool('csv_parse').execute({ path: 't.csv' }, CTX(ws));
  assert.match(fromFile, /^3 row\(s\)/);
  const bad = await tool('csv_parse').execute({}, CTX(ws));
  assert.match(bad, /^Error: Missing required argument: "path"/);
});

test('data-tools: csv_filter / csv_aggregate / json_query / json_to_csv / csv_to_json tools', async () => {
  const ws = makeTempWorkspace();
  const ctx = CTX(ws);
  const filtered = await tool('csv_filter').execute({ csv: SAMPLE_CSV, where: 'age > 28' }, ctx);
  assert.match(filtered, /2 of 3 row\(s\) kept/);
  const agg = await tool('csv_aggregate').execute({ csv: SAMPLE_CSV, group_by: 'city', agg: 'count, sum:age' }, ctx);
  assert.match(agg, /2 group\(s\) from 3 row\(s\)/);
  assert.match(agg, /"group": "Hanoi"/);
  const q = await tool('json_query').execute(
    { json: '{"users":[{"name":"An","age":30}]}', query: 'users[0].name' },
    ctx,
  );
  assert.equal(q, 'An');
  const missing = await tool('json_query').execute({ json: '{"a":1}', query: 'b.c' }, ctx);
  assert.match(missing, /No value at path/);
  const badJson = await tool('json_query').execute({ json: 'not json', query: 'a' }, ctx);
  assert.match(badJson, /^Error: Input is not valid JSON/);
  const j2c = await tool('json_to_csv').execute({ json: '[{"a":1},{"a":2}]' }, ctx);
  assert.equal(j2c, 'a\n1\n2');
  const c2j = await tool('csv_to_json').execute({ csv: 'a,b\n1,2\n' }, ctx);
  assert.match(c2j, /"a": "1"/);
  const badFilter = await tool('csv_filter').execute({ csv: SAMPLE_CSV, where: 'age >> 3' }, ctx);
  assert.match(badFilter, /^Error: Bad condition/);
  const noInput = await tool('csv_to_json').execute({}, ctx);
  assert.match(noInput, /^Error: Missing required argument: "path"/);
});

test('data-tools: csv_parse refuses a path outside the workspace', async () => {
  const ws = makeTempWorkspace();
  const out = await tool('csv_parse').execute({ path: '../secret.csv' }, CTX(ws));
  assert.match(out, /^Error:/);
});
