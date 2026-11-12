/**
 * automations-seed-samples-v074.test.mjs — v0.74d: nút "Nạp dữ liệu mẫu".
 *
 * `AutomationScheduler.seedSampleAutomations()` ghi `SAMPLE_AUTOMATIONS`
 * vào store thật (qua `create()` — validate + timestamp mới + `nextRunAt`
 * tính thật), sample đã có sẵn thì bỏ qua, không nhân đôi.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations-seed-samples-v074.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutomationScheduler,
  JsonFileAutomationStore,
  SAMPLE_AUTOMATIONS,
  sampleAutomations,
  validateAutomation,
} from '../packages/core/dist/automations/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-seed-v074-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeScheduler(dir) {
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, {
    runAgent: async () => 'agent ok',
    runTool: async () => 'tool ok',
    createTask: async () => 'task-123',
    notify: () => undefined,
  }, { now: () => new Date('2026-11-10T10:00:00.000Z') });
  return { scheduler, store };
}

test('seed lần đầu: tạo đủ 4 sample, timestamp mới, nextRunAt tính thật', () => {
  const { scheduler, store } = makeScheduler(makeTempDir());
  const result = scheduler.seedSampleAutomations();

  assert.equal(result.created.length, 4);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.created.map((a) => a.id).sort(),
    SAMPLE_AUTOMATIONS.map((a) => a.id).sort(),
    'phải seed đúng 4 id trong samples.ts',
  );
  assert.equal(store.list().length, 4);
  for (const created of result.created) {
    // Timestamp mới (giờ seed), không phải placeholder trong samples.ts.
    assert.equal(created.createdAt, '2026-11-10T10:00:00.000Z');
    assert.notEqual(created.createdAt, '2026-11-10T00:00:00.000Z');
    assert.deepEqual(validateAutomation(created), [], `${created.id} phải validate được`);
  }
  // Interval chưa từng chạy thì due ngay (cùng luật routines:
  // nextRunAt = giờ seed, không phải +480 phút).
  const morning = result.created.find((a) => a.id === 'morning-brief-auto');
  assert.ok(morning);
  assert.equal(morning.nextRunAt, '2026-11-10T10:00:00.000Z');
  // Cron '0 9 * * 1' tính thật theo GIỜ ĐỊA PHƯƠNG (cronMatches trong
  // engine.ts ghi rõ "(Local time)" — 9h nghĩa là 9h giờ máy user):
  // 2026-11-10 là thứ Ba nên lần tới là thứ Hai 2026-11-16 09:00
  // giờ địa phương. Kỳ vọng tính bằng constructor local-time để test
  // không phụ thuộc TZ của máy chạy — trước đây hardcode
  // '2026-11-16T09:00:00.000Z' (09:00 UTC) nên chỉ đúng khi TZ=UTC,
  // đỏ dưới TZ=Asia/Saigon (09:00 local = 02:00Z).
  const weekly = result.created.find((a) => a.id === 'weekly-report-auto');
  assert.ok(weekly);
  assert.equal(weekly.nextRunAt, new Date(2026, 10, 16, 9, 0, 0).toISOString());
  assert.equal(new Date(weekly.nextRunAt).getHours(), 9, 'cron 9h phải là 9h giờ địa phương');
});

test('seed lần 2: không tạo thêm, skip đủ 4 id, store vẫn đúng 4', () => {
  const dir = makeTempDir();
  const { scheduler, store } = makeScheduler(dir);
  const first = scheduler.seedSampleAutomations();
  assert.equal(first.created.length, 4);

  const second = scheduler.seedSampleAutomations();
  assert.deepEqual(second.created, []);
  assert.deepEqual(
    second.skipped.sort(),
    SAMPLE_AUTOMATIONS.map((a) => a.id).sort(),
  );
  assert.equal(store.list().length, 4, 'bấm seed 2 lần không được nhân đôi');

  // Đọc lại từ file: vẫn 4, không có bản sao.
  const reopened = new JsonFileAutomationStore(dir);
  assert.equal(reopened.list().length, 4);
});

test('seed khi 1 sample đã có sẵn: chỉ tạo 3 còn thiếu, giữ nguyên sample cũ', () => {
  const dir = makeTempDir();
  const { scheduler, store } = makeScheduler(dir);
  // Người dùng đã tạo tay một automation trùng id sample (nội dung khác).
  const mine = scheduler.create({
    id: 'weekly-report-auto',
    botId: 'bot-1',
    name: 'Báo cáo tuần của tôi',
    trigger: { kind: 'cron', expression: '0 9 * * 1' },
    action: { kind: 'notify', message: 'của tôi' },
    enabled: true,
  });
  assert.equal(mine.name, 'Báo cáo tuần của tôi');

  const result = scheduler.seedSampleAutomations();
  assert.equal(result.created.length, 3);
  assert.deepEqual(result.skipped, ['weekly-report-auto']);
  assert.equal(store.list().length, 4);
  // Sample đã có không bị ghi đè bởi bản mẫu.
  assert.equal(scheduler.get('weekly-report-auto').name, 'Báo cáo tuần của tôi');
  assert.equal(scheduler.get('weekly-report-auto').botId, 'bot-1');
});

test('sampleAutomations() trả bản sao sâu — seed không mutate SAMPLE_AUTOMATIONS', () => {
  const dir = makeTempDir();
  const { scheduler } = makeScheduler(dir);
  const before = JSON.stringify(SAMPLE_AUTOMATIONS);
  scheduler.seedSampleAutomations();
  assert.equal(JSON.stringify(SAMPLE_AUTOMATIONS), before);
  assert.notEqual(sampleAutomations()[0], SAMPLE_AUTOMATIONS[0]);
});
