/**
 * Tests for the v0.89 text + office-write tools (worker F4):
 * text_extract, text_diff, text_summarize_extract, markdown_toc,
 * docx_write, markdown_to_docx, xlsx_write
 * (packages/tools/src/textTools.ts + officeWriteTools.ts, wired into
 * tools.ts ALL_TOOLS).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/text-office-tools-f4.test.mjs
 *
 * No live network, no real credentials. Office files are verified two
 * ways: by unzipping them (node:zlib) and by reading them back with
 * the repo's own readers (extractOfficeText: mammoth for DOCX,
 * SheetJS for XLSX).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { createDefaultTools, ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  TEXT_TOOLS,
  extractWithRegex,
  diffLines,
  extractiveSummarize,
  markdownToc,
  slugifyHeading,
} from '../packages/tools/dist/textTools.js';
import {
  OFFICE_WRITE_TOOLS,
  buildDocx,
  buildXlsx,
  buildZip,
  crc32,
} from '../packages/tools/dist/officeWriteTools.js';
import { extractOfficeText } from '../packages/tools/dist/officeDocs.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const tool = (name) => {
  const t = createDefaultTools().find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

const tempDirs = [];
function makeTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-textoffice-f4-'));
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

/** Unzip a Buffer built by buildZip into { name: text }. */
function unzip(buf) {
  const out = {};
  let off = 0;
  while (off < buf.length - 4 && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const compLen = buf.readUInt32LE(off + 18);
    const method = buf.readUInt16LE(off + 8);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    out[name] =
      method === 8
        ? zlib.inflateRawSync(buf.subarray(start, start + compLen)).toString('utf8')
        : buf.subarray(start, start + compLen).toString('utf8');
    off = start + compLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

test('text-office-tools: 4 text + 3 office-write tools, approval flags, no duplicates', () => {
  assert.deepEqual(
    TEXT_TOOLS.map((t) => t.definition.name).sort(),
    ['markdown_toc', 'text_diff', 'text_extract', 'text_summarize_extract'],
  );
  assert.deepEqual(
    OFFICE_WRITE_TOOLS.map((t) => t.definition.name).sort(),
    ['docx_write', 'markdown_to_docx', 'xlsx_write'],
  );
  for (const t of TEXT_TOOLS) assert.equal(t.needsApproval, false, t.definition.name);
  for (const t of OFFICE_WRITE_TOOLS) assert.equal(t.needsApproval, true, t.definition.name);
  for (const t of [...TEXT_TOOLS, ...OFFICE_WRITE_TOOLS]) {
    assert.ok(ALL_TOOLS.some((x) => x.definition.name === t.definition.name));
  }
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in ALL_TOOLS');
});

// ---------------------------------------------------------------------------
// text_extract
// ---------------------------------------------------------------------------

test('text-tools: extractWithRegex finds matches with groups and indexes, caps at 100', () => {
  const found = extractWithRegex('mail a@b.com and c@d.org', '[\\w.]+@([\\w.]+)\\.\\w+', 'i');
  assert.equal(found.length, 2);
  assert.equal(found[0].match, 'a@b.com');
  assert.deepEqual(found[0].groups, ['b']);
  assert.equal(found[0].index, 5);
  const many = extractWithRegex('a '.repeat(500), 'a');
  assert.equal(many.length, 100);
});

test('text-tools: extractWithRegex rejects bad patterns and oversized input', () => {
  assert.throws(() => extractWithRegex('x', '('), /Invalid regex/);
  assert.throws(() => extractWithRegex('x', ''), /must not be empty/);
  assert.throws(() => extractWithRegex('x'.repeat(1_000_001), 'x'), /over the .* char limit/);
});

test('text-tools: text_extract tool reports matches and no-match', async () => {
  const ws = makeTempWorkspace();
  const out = await tool('text_extract').execute(
    { text: 'call 090-123-4567 now', pattern: '\\d{3}-\\d{3}-\\d{4}' },
    CTX(ws),
  );
  assert.match(out, /1 match\(es\)/);
  assert.match(out, /090-123-4567/);
  const none = await tool('text_extract').execute({ text: 'hello', pattern: '\\d+' }, CTX(ws));
  assert.match(none, /No matches/);
  const bad = await tool('text_extract').execute({ text: 'hello', pattern: '(' }, CTX(ws));
  assert.match(bad, /^Error: Invalid regex/);
});

// ---------------------------------------------------------------------------
// text_diff
// ---------------------------------------------------------------------------

test('text-tools: diffLines unified hunks; identical texts report no differences', () => {
  assert.equal(diffLines('same\n', 'same\n'), 'No differences.');
  const d = diffLines('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nf\nG');
  assert.match(d, /^@@ -1,7 \+1,7 @@/m);
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.match(d, /^-g$/m);
  assert.match(d, /^\+G$/m);
  assert.match(d, /^ a$/m);
});

test('text-tools: diffLines over 1000 lines falls back to a prefix/suffix summary', () => {
  const a = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 5', 'CHANGED');
  const d = diffLines(a, b);
  assert.match(d, /too long for an exact diff/);
  assert.match(d, /Common prefix: 5 line\(s\)/);
});

test('text-tools: text_diff tool works from inline text and from files', async () => {
  const ws = makeTempWorkspace({ 'a.txt': 'one\ntwo\n', 'b.txt': 'one\nTWO\n' });
  const out = await tool('text_diff').execute({ a: 'x\ny\n', b: 'x\nY\n' }, CTX(ws));
  assert.match(out, /^-y$/m);
  assert.match(out, /^\+Y$/m);
  const fromFiles = await tool('text_diff').execute({ path_a: 'a.txt', path_b: 'b.txt' }, CTX(ws));
  assert.match(fromFiles, /^-two$/m);
});

// ---------------------------------------------------------------------------
// text_summarize_extract / markdown_toc
// ---------------------------------------------------------------------------

test('text-tools: extractiveSummarize picks repeated-topic sentences in original order', () => {
  const text = [
    'Cats sleep a lot.',
    'Cats are cute animals.',
    'Quantum physics is hard.',
    'Cats sleep on sofas.',
    'Dogs bark loudly.',
  ].join(' ');
  const picked = extractiveSummarize(text, 2);
  assert.equal(picked.length, 2);
  assert.ok(picked.every((s) => s.includes('Cats')));
  assert.ok(picked[0].indexOf('Cats') === 0);
  // Short input returns everything.
  assert.deepEqual(extractiveSummarize('One sentence only.', 5), ['One sentence only.']);
});

test('text-tools: markdownToc nests headings, slugifies, dedupes duplicates', () => {
  assert.equal(
    markdownToc('# Title\n## Sub\n### Deep\n## Sub\n#### Too deep\n'),
    '- [Title](#title)\n  - [Sub](#sub)\n    - [Deep](#deep)\n  - [Sub](#sub-1)',
  );
  assert.equal(markdownToc('no headings here'), '(no headings found)');
  assert.equal(slugifyHeading('Hello, World!'), 'hello-world');
  assert.equal(markdownToc('# A\n## B\n', 1), '- [A](#a)');
});

test('text-tools: text_summarize_extract and markdown_toc tools', async () => {
  const ws = makeTempWorkspace();
  const sum = await tool('text_summarize_extract').execute(
    { text: 'Cats sleep a lot. Cats are cute. Quantum physics is hard. Cats sleep on sofas.', sentences: 2 },
    CTX(ws),
  );
  assert.match(sum, /Cats/);
  const toc = await tool('markdown_toc').execute({ markdown: '# T\n## S\n' }, CTX(ws));
  assert.equal(toc, '- [T](#t)\n  - [S](#s)');
});

// ---------------------------------------------------------------------------
// office write: ZIP + DOCX
// ---------------------------------------------------------------------------

test('office-tools: crc32 matches the known check value; buildZip round-trips', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(unzip(zip)['a.txt'], 'hello');
});

test('office-tools: buildDocx produces a docx mammoth can read (headings, bold, italic)', async () => {
  const buf = buildDocx('# Bao cao\nDoan **dam** va *nghieng*.\n- muc 1\n- muc 2\n');
  const parts = unzip(buf);
  assert.match(parts['word/document.xml'], /Bao cao/);
  assert.match(parts['word/document.xml'], /<w:b\/>/);
  assert.match(parts['word/document.xml'], /<w:i\/>/);
  const text = await extractOfficeText('.docx', buf);
  assert.match(text, /Bao cao/);
  assert.match(text, /muc 1/);
  assert.match(text, /dam/);
});

test('office-tools: docx_write and markdown_to_docx tools write into the workspace only', async () => {
  const ws = makeTempWorkspace();
  const out = await tool('markdown_to_docx').execute(
    { path: 'docs/report.docx', markdown: '# Hi\nHello **world**.\n' },
    CTX(ws),
  );
  assert.match(out, /Wrote \d+ bytes to "docs\/report\.docx"/);
  const back = await extractOfficeText('.docx', fs.readFileSync(path.join(ws, 'docs/report.docx')));
  assert.match(back, /Hi/);
  assert.match(back, /world/);
  const wrongExt = await tool('docx_write').execute({ path: 'x.txt', content: 'hi' }, CTX(ws));
  assert.match(wrongExt, /^Error: Output path must end in "\.docx"/);
  const escape = await tool('docx_write').execute({ path: '../evil.docx', content: 'hi' }, CTX(ws));
  assert.match(escape, /^Error:/);
});

// ---------------------------------------------------------------------------
// office write: XLSX
// ---------------------------------------------------------------------------

test('office-tools: buildXlsx produces an xlsx SheetJS can read with real types', () => {
  const buf = buildXlsx(['name', 'age', 'vip'], [['An', 30, true], ['Binh', 25.5, false], ['Chi', null, true]], 'Data');
  const parts = unzip(buf);
  assert.match(parts['xl/sharedStrings.xml'], /An/);
  assert.match(parts['xl/worksheets/sheet1.xml'], /<v>30<\/v>/);
  assert.match(parts['xl/worksheets/sheet1.xml'], /t="b"/);
  assert.match(parts['xl/workbook.xml'], /Data/);
});

test('office-tools: xlsx_write tool writes typed rows; rejects bad rows and bad paths', async () => {
  const ws = makeTempWorkspace();
  const out = await tool('xlsx_write').execute(
    { path: 'data.xlsx', headers: ['name', 'age'], rows: [['An', 30], ['Binh', 25]], sheet_name: 'People' },
    CTX(ws),
  );
  assert.match(out, /Wrote \d+ bytes to "data\.xlsx"/);
  const back = await extractOfficeText('.xlsx', fs.readFileSync(path.join(ws, 'data.xlsx')));
  assert.match(back, /Sheet: People \(3 row\(s\)\)/);
  assert.match(back, /An\t30/);
  const badRow = await tool('xlsx_write').execute({ path: 'x.xlsx', rows: ['not-an-array'] }, CTX(ws));
  assert.match(badRow, /^Error: Each row in "rows" must be an array/);
  const badExt = await tool('xlsx_write').execute({ path: 'x.csv', rows: [] }, CTX(ws));
  assert.match(badExt, /^Error: Output path must end in "\.xlsx"/);
  const tooMany = await tool('xlsx_write').execute(
    { path: 'x.xlsx', rows: Array.from({ length: 100_001 }, () => [1]) },
    CTX(ws),
  );
  assert.match(tooMany, /^Error: Too many rows/);
});
