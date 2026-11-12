/**
 * Tests v0.15 — @-mentions (packages/core/src/agent/mentions.ts).
 *
 * Chỉ dùng file tạm local, không mạng, không API key.
 * Run: build core rồi `node --test tests/mentions-v015.test.mjs`
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseMentions,
  resolveMentions,
  MENTION_MAX_FILE_BYTES,
  MENTION_MAX_TOTAL_BYTES,
} from '../packages/core/dist/agent/mentions.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mentions-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// ---------------------------------------------------------------------------
// parseMentions
// ---------------------------------------------------------------------------

test('parse: nhiều mention, cả @files lẫn @docs, mỗi mention nhiều path', () => {
  const out = parseMentions('xem @files src/index.ts src/util.ts và @docs README.md giúp mình');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    kind: 'files',
    raw: '@files src/index.ts src/util.ts',
    paths: ['src/index.ts', 'src/util.ts'],
  });
  assert.deepEqual(out[1], {
    kind: 'docs',
    raw: '@docs README.md',
    paths: ['README.md'],
  });
});

test('parse: mention giữa câu — chữ sau path không phải path thì không bị nuốt', () => {
  const out = parseMentions('xem giúp @files README.md nhé');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].paths, ['README.md']);
  assert.equal(out[0].raw, '@files README.md');
});

test('parse: @files không có path → không tính là mention', () => {
  assert.deepEqual(parseMentions('xem @files'), []);
  assert.deepEqual(parseMentions('@files'), []);
  assert.deepEqual(parseMentions('@files   \n@docs'), []);
  assert.deepEqual(parseMentions('không có mention nào ở đây'), []);
});

test('parse: tên mention sai chính tả / sai hoa-thường không khớp', () => {
  assert.deepEqual(parseMentions('@file src/a.ts'), []);
  assert.deepEqual(parseMentions('@doc README.md'), []);
  assert.deepEqual(parseMentions('@Files src/a.ts'), []);
  assert.deepEqual(parseMentions('@DOCS README.md'), []);
  assert.deepEqual(parseMentions('@files2 src/a.ts'), []);
  assert.deepEqual(parseMentions('mail@files src/a.ts'), []);
  // @files đúng vẫn khớp dù đứng sau dấu mở ngoặc.
  assert.equal(parseMentions('xem (@files src/a.ts) nhé').length, 1);
});

test('parse: file không đuôi (LICENSE, Makefile) vẫn nhận làm path đầu tiên', () => {
  const out = parseMentions('@files LICENSE');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].paths, ['LICENSE']);
});

test('parse: path trên dòng khác không thuộc mention; mention thứ hai cùng dòng vẫn tách được', () => {
  const out = parseMentions('@files src/a.ts\n@docs README.md');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].paths, ['src/a.ts']);
  assert.deepEqual(out[1].paths, ['README.md']);
  const sameLine = parseMentions('@files src/a.ts @docs README.md');
  assert.equal(sameLine.length, 2);
  assert.deepEqual(sameLine[0].paths, ['src/a.ts']);
  assert.deepEqual(sameLine[1].paths, ['README.md']);
});

test('parse: path trong ngoặc kép giữ nguyên khoảng trắng; dấu phẩy cuối token được lược', () => {
  const quoted = parseMentions('@files "my notes.md" src/a.ts');
  assert.equal(quoted.length, 1);
  assert.deepEqual(quoted[0].paths, ['my notes.md', 'src/a.ts']);
  const comma = parseMentions('@files src/a.ts, src/b.ts.');
  assert.deepEqual(comma[0].paths, ['src/a.ts', 'src/b.ts']);
});

// ---------------------------------------------------------------------------
// resolveMentions — file tồn tại
// ---------------------------------------------------------------------------

test('resolve: file tồn tại → nội dung vào text dạng khối code, giữ tên file + dòng nguồn', () => {
  const ws = makeTempDir();
  writeFile(ws, 'src/index.ts', "export const a = 1;\n");
  writeFile(ws, 'README.md', '# Hello\n');
  const res = resolveMentions('xem @files src/index.ts và @docs README.md giúp mình', ws);
  assert.equal(res.skipped.length, 0);
  assert.equal(res.included.length, 2);
  assert.equal(res.included[0].kind, 'files');
  assert.equal(res.included[0].path, 'src/index.ts');
  assert.equal(res.included[0].chars, 'export const a = 1;\n'.length);
  assert.equal(res.included[0].truncated, false);
  assert.equal(res.included[1].kind, 'docs');
  assert.ok(res.text.includes('[@files src/index.ts]'), res.text);
  assert.ok(res.text.includes('```ts'), res.text);
  assert.ok(res.text.includes('export const a = 1;'), res.text);
  assert.ok(res.text.includes('[@docs README.md]'), res.text);
  assert.ok(res.text.includes('# Hello'), res.text);
  // Phần text ngoài mention được giữ nguyên.
  assert.ok(res.text.startsWith('xem '), res.text);
  assert.ok(res.text.endsWith(' giúp mình'), res.text);
  // Không còn mention gốc trong text.
  assert.ok(!res.text.includes('@files src/index.ts\n'), res.text);
});

test('resolve: text không có mention → trả nguyên text, included/skipped rỗng', () => {
  const ws = makeTempDir();
  const res = resolveMentions('hello, không có mention', ws);
  assert.equal(res.text, 'hello, không có mention');
  assert.deepEqual(res.included, []);
  assert.deepEqual(res.skipped, []);
});

// ---------------------------------------------------------------------------
// resolveMentions — skipped
// ---------------------------------------------------------------------------

test('resolve: file ngoài workspace / "../" → skipped, không đọc nội dung', () => {
  const ws = makeTempDir();
  const outside = makeTempDir();
  writeFile(outside, 'secret.txt', 'BÍ MẬT NGOÀI WORKSPACE');
  const res = resolveMentions('@files ../secret.txt và @files /etc/passwd', ws);
  assert.equal(res.included.length, 0);
  assert.equal(res.skipped.length, 2);
  assert.match(res.skipped[0].reason, /ngoài/);
  assert.match(res.skipped[1].reason, /ngoài/);
  assert.ok(!res.text.includes('BÍ MẬT'), res.text);
  // Mention bị bỏ qua hết được thay bằng ghi chú, không để model tưởng tượng.
  assert.ok(res.text.includes('đã bỏ qua'), res.text);
});

test('resolve: đường dẫn tuyệt đối trong workspace vẫn đọc được; symlink trỏ ra ngoài → skipped', () => {
  const ws = makeTempDir();
  const abs = writeFile(ws, 'a.txt', 'nội dung a');
  const res = resolveMentions(`@files ${abs}`, ws);
  assert.equal(res.included.length, 1);
  assert.ok(res.text.includes('nội dung a'));

  const outside = makeTempDir();
  const secret = writeFile(outside, 'secret.txt', 'BÍ MẬT QUA SYMLINK');
  const link = path.join(ws, 'link.txt');
  fs.symlinkSync(secret, link);
  const res2 = resolveMentions('@files link.txt', ws);
  assert.equal(res2.included.length, 0);
  assert.equal(res2.skipped.length, 1);
  assert.match(res2.skipped[0].reason, /symlink|ngoài/);
  assert.ok(!res2.text.includes('BÍ MẬT'), res2.text);
});

test('resolve: file không tồn tại → skipped với reason rõ; file còn lại vẫn resolve', () => {
  const ws = makeTempDir();
  writeFile(ws, 'co.txt', 'tôi tồn tại');
  const res = resolveMentions('@files khong-co.txt co.txt', ws);
  assert.equal(res.included.length, 1);
  assert.equal(res.included[0].path, 'co.txt');
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].path, 'khong-co.txt');
  assert.match(res.skipped[0].reason, /không tồn tại/);
  assert.ok(res.text.includes('tôi tồn tại'), res.text);
});

test('resolve: thư mục → skipped (không phải file); file nhị phân → skipped', () => {
  const ws = makeTempDir();
  fs.mkdirSync(path.join(ws, 'mydir'));
  const res = resolveMentions('@files mydir', ws);
  assert.equal(res.included.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /không phải file/);

  fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));
  const res2 = resolveMentions('@files bin.dat', ws);
  assert.equal(res2.included.length, 0);
  assert.equal(res2.skipped[0].reason, 'file nhị phân, không đọc dạng text');
});

// ---------------------------------------------------------------------------
// resolveMentions — giới hạn kích thước
// ---------------------------------------------------------------------------

test('resolve: file quá 100KB chỉ lấy đầu + ghi chú đã cắt; hằng số giới hạn đúng giá trị', () => {
  assert.equal(MENTION_MAX_FILE_BYTES, 100 * 1024);
  assert.equal(MENTION_MAX_TOTAL_BYTES, 500 * 1024);
  const ws = makeTempDir();
  const big = 'x'.repeat(150 * 1024);
  writeFile(ws, 'big.txt', big);
  const res = resolveMentions('@files big.txt', ws);
  assert.equal(res.included.length, 1);
  assert.equal(res.included[0].truncated, true);
  assert.equal(res.included[0].chars, MENTION_MAX_FILE_BYTES);
  assert.ok(res.text.includes('Đã cắt bớt'), res.text);
  assert.ok(res.text.includes('153600'), res.text); // kích thước file gốc (byte)
  assert.ok(!res.text.includes(big), res.text);
});

test('resolve: tổng tối đa 500KB — file sau vượt ngân sách thì skipped/cắt theo phần còn lại', () => {
  const ws = makeTempDir();
  // 6 file x 100KB = 600KB > 500KB ngân sách tổng.
  for (let i = 0; i < 6; i++) {
    writeFile(ws, `f${i}.txt`, 'y'.repeat(100 * 1024));
  }
  const res = resolveMentions('@files f0.txt f1.txt f2.txt f3.txt f4.txt f5.txt', ws);
  assert.equal(res.included.length, 5);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].path, 'f5.txt');
  assert.match(res.skipped[0].reason, /tổng giới hạn/);

  // Giới hạn tổng tuỳ chỉnh nhỏ: file thứ hai chỉ lấy phần còn lại rồi cắt.
  const res2 = resolveMentions('@files f0.txt f1.txt', ws, { maxTotalBytes: 150 * 1024 });
  assert.equal(res2.included.length, 2);
  assert.equal(res2.included[0].chars, 100 * 1024);
  assert.equal(res2.included[1].chars, 50 * 1024);
  assert.equal(res2.included[1].truncated, true);
});

// ---------------------------------------------------------------------------
// resolveMentions — workspace rỗng / không có
// ---------------------------------------------------------------------------

test('resolve: workspace rỗng (không có file) → file mention skipped "không tồn tại"', () => {
  const ws = makeTempDir();
  const res = resolveMentions('@files src/a.ts', ws);
  assert.equal(res.included.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /không tồn tại/);
  assert.equal(res.text, '[@files src/a.ts — đã bỏ qua: src/a.ts (không tồn tại trong workspace)]');
});

test('resolve: không truyền workspace / workspace không tồn tại → mọi file skipped với reason rõ', () => {
  const res = resolveMentions('@files src/a.ts', '');
  assert.equal(res.included.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /không có thư mục workspace/);

  const missing = path.join(os.tmpdir(), 'open-bot-mentions-khong-ton-tai');
  const res2 = resolveMentions('@files src/a.ts', missing);
  assert.equal(res2.skipped.length, 1);
  assert.match(res2.skipped[0].reason, /không tồn tại/);
});
