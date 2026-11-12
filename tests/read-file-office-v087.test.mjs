/**
 * Tests for v0.87b: read_file extracts text from PDF, DOCX and XLSX
 * (`extractOfficeText` in packages/tools/src/officeDocs.ts, wired into
 * the read_file tool in packages/tools/src/tools.ts).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/read-file-office-v087.test.mjs
 *
 * Fixtures are real files committed under tests/fixtures/ (see
 * tests/fixtures/gen-office-v087.py for how they were made):
 *   read-file-v087-sample.pdf    LibreOffice export of the sample DOCX (2 pages)
 *   read-file-v087-sample.docx   heading + paragraph + 2x3 table (minimal OOXML)
 *   read-file-v087-sample.xlsx   2 sheets via openpyxl (Summary, Details)
 *   read-file-v087-scanned.pdf   image-only page, no text layer (pikepdf)
 *   read-file-v087-corrupt.*     truncated / random bytes
 *   read-file-v087-encrypted.*   password "test123" (pikepdf / msoffcrypto)
 * No network, no live services. The too-big file is created at runtime
 * in a temp dir (5 MB + 1 byte of zeros — the size check fires before
 * any parsing, so its content does not matter).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  extractOfficeText,
  isOfficeExtension,
  MAX_OFFICE_READ_BYTES,
} from '../packages/tools/dist/officeDocs.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });

const readFileTool = createDefaultTools().find(
  (t) => t.definition.name === 'read_file',
);
assert.ok(readFileTool, 'read_file tool must exist in createDefaultTools()');

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-office-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(dir, fixtureName, asName = fixtureName) {
  fs.copyFileSync(path.join(FIXTURES, fixtureName), path.join(dir, asName));
  return asName;
}

async function read(relPath, dir) {
  return readFileTool.execute({ path: relPath }, CTX(dir));
}

test('PDF sample: text per page, 2 pages, Vietnamese text survives', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-sample.pdf');
  const out = await read('read-file-v087-sample.pdf', dir);
  assert.ok(!out.startsWith('Error:'), `expected success, got: ${out.slice(0, 200)}`);
  assert.match(out, /Format: PDF, 2 page\(s\)/);
  assert.match(out, /--- Page 1 of 2 ---/);
  assert.match(out, /--- Page 2 of 2 ---/);
  assert.ok(out.includes('Hello from the DOCX fixture.'));
  assert.ok(out.includes('Second page content for the PDF test.'));
  assert.ok(out.includes('Xin chao open-bot'));
  // Page 2 content must come after the page 2 marker, not page 1.
  assert.ok(
    out.indexOf('Second page content') > out.indexOf('--- Page 2 of 2 ---'),
    'page 2 text must follow the page 2 marker',
  );
});

test('DOCX sample: heading, paragraph, table as cell | cell rows', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-sample.docx');
  const out = await read('read-file-v087-sample.docx', dir);
  assert.ok(!out.startsWith('Error:'), `expected success, got: ${out.slice(0, 200)}`);
  assert.match(out, /Format: DOCX/);
  assert.ok(out.includes('# Section One'), 'heading kept as markdown heading');
  assert.ok(out.includes('Hello from the DOCX fixture.'));
  assert.ok(out.includes('Xin chao open-bot'));
  assert.ok(out.includes('Name | Value'), 'table header row kept');
  assert.ok(out.includes('Alpha | 1'));
  assert.ok(out.includes('Beta | 2'));
});

test('XLSX sample: both sheet names, rows as tab-separated values', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-sample.xlsx');
  const out = await read('read-file-v087-sample.xlsx', dir);
  assert.ok(!out.startsWith('Error:'), `expected success, got: ${out.slice(0, 200)}`);
  assert.match(out, /Format: XLSX, 2 sheet\(s\): Summary, Details/);
  assert.match(out, /--- Sheet: Summary \(3 row\(s\)\) ---/);
  assert.match(out, /--- Sheet: Details \(3 row\(s\)\) ---/);
  assert.ok(out.includes('Item\tQty'));
  assert.ok(out.includes('Apple\t10'));
  assert.ok(out.includes('Banana\t20'));
  assert.ok(out.includes('Hanoi\tCapital'));
  assert.ok(out.includes('Saigon\tBig city'));
});

test('scanned (image-only) PDF: clear error, no fake empty result', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-scanned.pdf');
  const out = await read('read-file-v087-scanned.pdf', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /no extractable text/i);
  assert.match(out, /OCR is not supported/i);
});

test('corrupt PDF: clear error, no crash', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-corrupt.pdf');
  const out = await read('read-file-v087-corrupt.pdf', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /Not a valid PDF|Could not read PDF/i);
});

test('corrupt DOCX: clear error, no crash', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-corrupt.docx');
  const out = await read('read-file-v087-corrupt.docx', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /Not a valid DOCX/i);
});

test('corrupt XLSX: clear error, no crash', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-corrupt.xlsx');
  const out = await read('read-file-v087-corrupt.xlsx', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /Not a valid XLSX/i);
});

test('password-protected PDF: clear error naming the password', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-encrypted.pdf');
  const out = await read('read-file-v087-encrypted.pdf', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /password-protected/i);
});

test('password-protected DOCX: clear error naming the password', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-encrypted.docx');
  const out = await read('read-file-v087-encrypted.docx', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /password-protected/i);
});

test('password-protected XLSX: clear error naming the password', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-encrypted.xlsx');
  const out = await read('read-file-v087-encrypted.xlsx', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.match(out, /password-protected/i);
});

test('office file over the 5 MB cap: rejected before parsing', async () => {
  const dir = makeTempWorkspace();
  const big = path.join(dir, 'big.pdf');
  fs.writeFileSync(big, Buffer.alloc(MAX_OFFICE_READ_BYTES + 1, 0));
  const out = await read('big.pdf', dir);
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out.slice(0, 200)}`);
  assert.ok(out.includes(String(MAX_OFFICE_READ_BYTES)), 'error names the office cap');
  assert.match(out, /office documents/i);
});

test('plain text regression: small txt still read, oversized txt still capped at 100 KB', async () => {
  const dir = makeTempWorkspace();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello plain text\n', 'utf8');
  const ok = await read('hello.txt', dir);
  assert.ok(ok.includes('hello plain text'), `expected text, got: ${ok.slice(0, 200)}`);
  fs.writeFileSync(path.join(dir, 'huge.txt'), 'x'.repeat(100_001), 'utf8');
  const tooBig = await read('huge.txt', dir);
  assert.ok(tooBig.startsWith('Error:'), `expected error, got: ${tooBig.slice(0, 200)}`);
  assert.ok(tooBig.includes('100000'), 'text cap error names the 100 KB limit');
});

test('uppercase extension is handled (.PDF)', async () => {
  const dir = makeTempWorkspace();
  copyFixture(dir, 'read-file-v087-sample.pdf', 'UPPER.PDF');
  const out = await read('UPPER.PDF', dir);
  assert.ok(!out.startsWith('Error:'), `expected success, got: ${out.slice(0, 200)}`);
  assert.match(out, /Format: PDF, 2 page\(s\)/);
});

test('officeDocs helpers: extension detection and direct extraction', async () => {
  assert.equal(isOfficeExtension('.pdf'), true);
  assert.equal(isOfficeExtension('.docx'), true);
  assert.equal(isOfficeExtension('.xlsx'), true);
  assert.equal(isOfficeExtension('.PDF'), true);
  assert.equal(isOfficeExtension('.txt'), false);
  assert.equal(isOfficeExtension('.doc'), false);
  assert.equal(isOfficeExtension(''), false);
  const buf = fs.readFileSync(path.join(FIXTURES, 'read-file-v087-sample.xlsx'));
  const out = await extractOfficeText('.xlsx', buf);
  assert.ok(out.includes('Summary'));
  assert.ok(out.includes('Apple\t10'));
  await assert.rejects(
    () => extractOfficeText('.pdf', Buffer.from('not a pdf at all')),
    /Not a valid PDF/,
  );
});
