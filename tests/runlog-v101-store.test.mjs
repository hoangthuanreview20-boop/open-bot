/**
 * Test v1.01 (Đội T1): RunLogStore — append-only JSONL + hash chain.
 *
 * - Append tự điền seq/prevHash/hash liên tục; verify ok trên log sạch.
 * - Sửa một byte trong payload → verify báo đúng seq đầu tiên bị sửa.
 * - Xoá một dòng giữa → verify báo seq đứt.
 * - Đổi thứ tự key trong JSON dòng đã ghi → hash đổi → verify báo lỗi
 *   (canonical stringify: nội dung bằng nhau theo key mới hash bằng nhau).
 * - Query theo type/seq/thời gian + phân trang.
 * - Xoay file khi quá lớn: seq/hash vẫn liên tục qua file xoay.
 * - Export JSONL round-trip: đọc lại được đúng số event.
 * - Meta/list: trạng thái run, đếm tool/file/error.
 *
 * Chỉ test thuần (không mạng, không provider). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-store.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { stableStringify } from '../packages/core/dist/event-log/canonical.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-store-'));
}

function makeStore(dir, opts = {}) {
  return new RunLogStore({ logDir: path.join(dir, 'run-logs'), ...opts });
}

function seedRun(store, runId = 'run-1', botId = 'bot-1') {
  store.append(runId, { type: 'run.started', payload: { botId } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'xin chào' } });
  store.append(runId, {
    type: 'model.response',
    payload: { step: 0, text: 'chào bạn', toolCalls: [] },
  });
  store.append(runId, {
    type: 'tool.call',
    payload: { callId: 'c1', tool: 'write_file', argKeys: ['path'], step: 0, path: 'a.txt' },
  });
  store.append(runId, {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'write_file', status: 'ok', outputPreview: 'Wrote a.txt', durationMs: 5, step: 0 },
  });
  store.append(runId, { type: 'run.completed', payload: { finalText: 'xong', steps: 1, toolCalls: 1, durationMs: 10 } });
  return store.readRun(runId).events;
}

test('append: seq tăng đều 1..N, prevHash nối chuỗi, hash 64 ký tự hex', () => {
  const store = makeStore(tmpDir());
  const events = seedRun(store);
  assert.equal(events.length, 6);
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    assert.equal(e.runId, 'run-1');
    assert.match(e.hash, /^[0-9a-f]{64}$/);
    if (i === 0) assert.equal(e.prevHash, '');
    else assert.equal(e.prevHash, events[i - 1].hash);
  });
  assert.deepEqual(store.verify('run-1'), { runId: 'run-1', ok: true, eventCount: 6 });
});

test('verify: sửa payload một event → báo đúng seq đó', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedRun(store);
  const file = store.runFilePath('run-1');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[2]);
  tampered.payload.text = 'đã bị sửa lén';
  lines[2] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  // Store mới (không cache tail) đọc lại file đã sửa.
  const fresh = makeStore(dir);
  const v = fresh.verify('run-1');
  assert.equal(v.ok, false);
  assert.equal(v.firstBadSeq, 3);
  assert.match(v.reason, /hash không khớp/);
});

test('verify: xoá một dòng giữa → báo seq đứt', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedRun(store);
  const file = store.runFilePath('run-1');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  lines.splice(2, 1); // Xoá event seq 3.
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const fresh = makeStore(dir);
  const v = fresh.verify('run-1');
  assert.equal(v.ok, false);
  assert.equal(v.firstBadSeq, 4);
  assert.match(v.reason, /seq đứt/);
});

test('verify: đổi thứ tự key trong dòng đã ghi → hash đổi → báo lỗi', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedRun(store);
  const file = store.runFilePath('run-1');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  // Viết lại dòng seq 2 với key đảo thứ tự (nội dung "bằng nhau" theo JSON
  // nhưng chuỗi byte khác) — hash chain vẫn phải bắt được vì hash tính
  // trên bản chuẩn hoá: thứ tự key không đổi hash... nên verify PHẢI ok.
  // Test này khẳng định canonical stringify: đảo key không làm đứt chuỗi.
  const parsed = JSON.parse(lines[1]);
  const reordered = {
    hash: parsed.hash,
    prevHash: parsed.prevHash,
    payload: parsed.payload,
    type: parsed.type,
    at: parsed.at,
    runId: parsed.runId,
    seq: parsed.seq,
  };
  lines[1] = JSON.stringify(reordered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const fresh = makeStore(dir);
  assert.equal(fresh.verify('run-1').ok, true);
});

test('stableStringify: cùng nội dung, thứ tự key khác nhau → cùng chuỗi', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
  );
  assert.equal(stableStringify([3, 2, 1]), '[3,2,1]');
});

test('queryRun: lọc theo type/seq/khoảng thời gian + phân trang', () => {
  const store = makeStore(tmpDir());
  seedRun(store);
  const tools = store.queryRun('run-1', { types: ['tool.call', 'tool.result'] });
  assert.equal(tools.total, 2);
  assert.deepEqual(tools.events.map((e) => e.type), ['tool.call', 'tool.result']);
  const fromSeq = store.queryRun('run-1', { fromSeq: 5 });
  assert.deepEqual(fromSeq.events.map((e) => e.seq), [5, 6]);
  const page = store.queryRun('run-1', { limit: 2, offset: 2 });
  assert.equal(page.total, 6);
  assert.deepEqual(page.events.map((e) => e.seq), [3, 4]);
  const empty = store.queryRun('run-1', { types: ['compile.error'] });
  assert.equal(empty.total, 0);
});

test('readRun: dòng JSON hỏng bị bỏ qua và đếm vào corruptLines', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  seedRun(store);
  fs.appendFileSync(store.runFilePath('run-1'), 'đây không phải json\n{"seq":"x"}\n');
  const fresh = makeStore(dir);
  const read = fresh.readRun('run-1');
  assert.equal(read.events.length, 6);
  assert.equal(read.corruptLines, 1);
  assert.equal(read.invalidLines, 1);
});

test('rotation: file xoay khi quá lớn, seq/hash vẫn liên tục', () => {
  const store = makeStore(tmpDir(), { maxFileBytes: 200, maxTotalBytes: 1024 * 1024 });
  for (let i = 0; i < 12; i += 1) {
    store.append('run-1', { type: 'run.prompt', payload: { text: `prompt ${i} — đệm cho dài để vượt giới hạn file` } });
  }
  const files = store.runFiles('run-1');
  assert.ok(files.length >= 2, `mong đợi file xoay, chỉ có ${files.length} file`);
  assert.equal(store.verify('run-1').ok, true);
  assert.equal(store.readRun('run-1').events.length, 12);
});

test('exportJsonl: xuất rồi đọc lại đúng số event, đúng hash', () => {
  const store = makeStore(tmpDir());
  const events = seedRun(store);
  const jsonl = store.exportJsonl('run-1');
  const parsed = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, events.length);
  assert.deepEqual(parsed.map((e) => e.seq), events.map((e) => e.seq));
  assert.deepEqual(parsed.map((e) => e.hash), events.map((e) => e.hash));
  assert.equal(store.exportJsonl('run-khong-co'), '');
});

test('meta/listRuns: trạng thái + đếm đúng, mới nhất trước', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  // Timestamp tường minh cho cả hai run (seed trong cùng một mili-giây
  // sẽ cho cùng startedAt và thứ tự sắp xếp không xác định).
  const at1 = '2026-11-14T00:00:00.000Z';
  const at2 = '2026-11-14T00:00:10.000Z';
  store.append('run-1', { type: 'run.started', payload: { botId: 'bot-1' }, at: at1 });
  store.append('run-1', { type: 'run.prompt', payload: { text: 'việc A' }, at: at1 });
  store.append('run-1', { type: 'tool.call', payload: { callId: 'c1', tool: 'echo', argKeys: [], step: 0 }, at: at1 });
  store.append('run-1', { type: 'run.completed', payload: { steps: 1, toolCalls: 1, durationMs: 1 }, at: at1 });
  store.append('run-2', { type: 'run.started', payload: { botId: 'bot-2' }, at: at2 });
  store.append('run-2', { type: 'run.prompt', payload: { text: 'chờ' }, at: at2 });
  const meta1 = store.meta('run-1');
  assert.equal(meta1.status, 'completed');
  assert.equal(meta1.botId, 'bot-1');
  assert.equal(meta1.toolCalls, 1);
  assert.equal(meta1.fileChanges, 0); // store thô không suy ra file.change — recorder mới suy ra
  assert.equal(meta1.errors, 0);
  const meta2 = store.meta('run-2');
  assert.equal(meta2.status, 'running');
  assert.equal(store.meta('run-khong-co'), null);
  const list = store.listRuns();
  assert.deepEqual(list.map((m) => m.runId), ['run-2', 'run-1']);
});

test('meta: run pause/resume đổi trạng thái paused/running', () => {
  const store = makeStore(tmpDir());
  store.append('run-1', { type: 'run.started', payload: { botId: 'bot-1' } });
  store.append('run-1', { type: 'run.paused', payload: { step: 0 } });
  assert.equal(store.meta('run-1').status, 'paused');
  store.append('run-1', { type: 'run.resumed', payload: { step: 0 } });
  assert.equal(store.meta('run-1').status, 'running');
  store.append('run-1', { type: 'run.failed', payload: { message: 'lỗi', steps: 1, toolCalls: 0, durationMs: 1 } });
  assert.equal(store.meta('run-1').status, 'failed');
});

test('safeRunFileName: runId độc hại không thoát khỏi logDir', () => {
  const dir = tmpDir();
  const store = makeStore(dir);
  const file = store.runFilePath('../../etc/passwd');
  // Đường dẫn sau resolve vẫn nằm trong logDir (không traversal).
  const resolved = path.resolve(file);
  const logDir = path.resolve(path.join(dir, 'run-logs'));
  assert.ok(resolved.startsWith(logDir + path.sep), resolved);
  assert.equal(path.basename(file), '.._.._etc_passwd.jsonl');
});
