/**
 * Tests cho v0.79b — diff plan so với bản trước (UI parity §7).
 *
 * Covers:
 *  - Core `writePlanFile`: ghi đè snapshot bản cũ vào
 *    `.open-bot/plans/.history/` (bản đầu tiên không snapshot); ghi 7
 *    bản thì chỉ giữ 5 snapshot mới nhất; `listPlanHistoryFiles` trả
 *    mới nhất trước.
 *  - Core `diffStringLists` / `diffPlanVersions`: added / removed /
 *    unchanged theo khớp chuỗi chính xác, trùng lặp tính một lần.
 *  - Main `plans.ts`: `listStoredPlans` đọc bản trước mới nhất vào
 *    `previous` + tính `diff` (added/removed đúng); plan chưa từng sửa
 *    thì không có `previous`/`diff`; snapshot hỏng chỉ mất diff, plan
 *    vẫn liệt kê đủ.
 *
 * KHÔNG dùng CLI thật, KHÔNG gọi API ngoài: ghi file vào thư mục tạm.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/plan-diff-v079.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PLAN_HISTORY_MAX_VERSIONS,
  diffPlanVersions,
  diffStringLists,
  listPlanHistoryFiles,
  writePlanFile,
} from '../packages/core/dist/index.js';
import { listStoredPlans, readPreviousPlan } from '../apps/desktop/src/main/plans.ts';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const V1 = {
  projectId: 'proj-1',
  title: 'Kế hoạch A',
  detail: 'Mô tả v1',
  steps: ['Bước một', 'Bước hai', 'Bước ba'],
  decisions: ['Chọn X', 'Chọn Y'],
};
const V2 = {
  ...V1,
  title: 'Kế hoạch A',
  detail: 'Mô tả v2',
  steps: ['Bước một', 'Bước hai sửa', 'Bước bốn'],
  decisions: ['Chọn X', 'Chọn Z'],
};

test('diffStringLists/diffPlanVersions: added/removed/unchanged theo khớp chuỗi', () => {
  assert.deepEqual(diffStringLists(['a', 'b'], ['b', 'c']), {
    added: ['c'],
    removed: ['a'],
    unchanged: ['b'],
  });
  assert.deepEqual(diffStringLists([], ['x']), { added: ['x'], removed: [], unchanged: [] });
  assert.deepEqual(diffStringLists(['x'], []), { added: [], removed: ['x'], unchanged: [] });
  // Trùng lặp tính một lần; thứ tự added theo `cur`, removed theo `prev`.
  assert.deepEqual(diffStringLists(['a', 'a', 'b'], ['b', 'b', 'c', 'c']), {
    added: ['c'],
    removed: ['a'],
    unchanged: ['b'],
  });
  const d = diffPlanVersions(
    { steps: ['s1', 's2'], decisions: ['d1'] },
    { steps: ['s2', 's3'], decisions: ['d1', 'd2'] },
  );
  assert.deepEqual(d.steps, { added: ['s3'], removed: ['s1'], unchanged: ['s2'] });
  assert.deepEqual(d.decisions, { added: ['d2'], removed: [], unchanged: ['d1'] });
});

test('writePlanFile: snapshot bản trước + giữ tối đa 5 bản mới nhất', () => {
  const ws = makeTempDir('open-bot-v079-planhist-');
  writePlanFile(ws, V1);
  assert.deepEqual(listPlanHistoryFiles(ws, 'proj-1'), [], 'bản đầu tiên không có gì để snapshot');

  writePlanFile(ws, V2);
  const afterV2 = listPlanHistoryFiles(ws, 'proj-1');
  assert.equal(afterV2.length, 1, 'ghi đè 1 lần → 1 snapshot');
  const snapContent = fs.readFileSync(afterV2[0], 'utf8');
  assert.match(snapContent, /Bước một/, 'snapshot giữ nội dung bản v1');
  assert.match(snapContent, /Bước ba/, 'snapshot giữ bước đã bị xoá ở v2');

  // Ghi thêm 6 bản nữa (tổng 7 lần ghi đè) → chỉ giữ 5 snapshot mới nhất.
  for (let i = 3; i <= 8; i++) {
    writePlanFile(ws, { ...V1, steps: [`Bước v${i}`], decisions: [] });
  }
  const kept = listPlanHistoryFiles(ws, 'proj-1');
  assert.equal(kept.length, PLAN_HISTORY_MAX_VERSIONS, `chỉ giữ ${PLAN_HISTORY_MAX_VERSIONS} snapshot`);
  assert.equal(PLAN_HISTORY_MAX_VERSIONS, 5);
  // Mới nhất trước: snapshot mới nhất là bản v7 (ghi trước lần ghi v8).
  assert.match(fs.readFileSync(kept[0], 'utf8'), /Bước v7/);
  // Plan của project khác không lẫn vào.
  assert.deepEqual(listPlanHistoryFiles(ws, 'proj-khac'), []);
  assert.deepEqual(listPlanHistoryFiles('/tmp/khong-co-thu-muc-nay', 'proj-1'), []);
});

test('plans.ts: listStoredPlans trả previous + diff; plan mới không có diff', () => {
  const ws = makeTempDir('open-bot-v079-plandiff-');
  writePlanFile(ws, V1);
  let listed = listStoredPlans('bot-1', ws);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].previous, undefined, 'chưa sửa lần nào → không có previous');
  assert.equal(listed[0].diff, undefined, 'chưa sửa lần nào → không có diff');

  writePlanFile(ws, V2);
  listed = listStoredPlans('bot-1', ws);
  assert.equal(listed.length, 1);
  assert.ok(listed[0].previous, 'đã sửa 1 lần → có previous');
  assert.deepEqual(listed[0].previous.steps, ['Bước một', 'Bước hai', 'Bước ba']);
  assert.deepEqual(listed[0].previous.decisions, ['Chọn X', 'Chọn Y']);
  assert.ok(listed[0].diff, 'đã sửa 1 lần → có diff');
  assert.deepEqual(listed[0].diff.steps, {
    added: ['Bước hai sửa', 'Bước bốn'],
    removed: ['Bước hai', 'Bước ba'],
    unchanged: ['Bước một'],
  });
  assert.deepEqual(listed[0].diff.decisions, {
    added: ['Chọn Z'],
    removed: ['Chọn Y'],
    unchanged: ['Chọn X'],
  });

  // readPreviousPlan trực tiếp + plan không có history.
  const prev = readPreviousPlan(ws, 'proj-1');
  assert.deepEqual(prev?.steps, ['Bước một', 'Bước hai', 'Bước ba']);
  assert.equal(readPreviousPlan(ws, 'proj-khac'), undefined);
});

test('plans.ts: snapshot hỏng chỉ mất diff, plan vẫn liệt kê đủ', () => {
  const ws = makeTempDir('open-bot-v079-plandiff-bad-');
  writePlanFile(ws, V1);
  writePlanFile(ws, V2);
  const historyDir = path.join(ws, '.open-bot', 'plans', '.history');
  for (const name of fs.readdirSync(historyDir)) {
    // Ghi đè snapshot thành file rỗng (parsePlanFile trả null — không title).
    fs.writeFileSync(path.join(historyDir, name), '', 'utf8');
  }
  const listed = listStoredPlans('bot-1', ws);
  assert.equal(listed.length, 1, 'plan vẫn liệt kê đủ');
  assert.equal(listed[0].title, 'Kế hoạch A');
  assert.equal(listed[0].previous, undefined, 'snapshot hỏng → không có previous');
  assert.equal(listed[0].diff, undefined, 'snapshot hỏng → không có diff');
});
