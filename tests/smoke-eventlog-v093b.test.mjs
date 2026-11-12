/**
 * v0.93b — EventLogView smoke trong app Electron THẬT (xvfb + CDP):
 * phân trang >100 entries + đổi bot trong select + live tail bền.
 *
 * Chạy `scripts/smoke-eventlog-v093b.mjs` (seed 150 NDJSON entries
 * cho bot A + 3 cho bot B, mở app thật, kiểm tra trang đầu 100/150,
 * "Tải thêm" → 150/150 không trùng, đổi bot sang B → đúng 3/3 không
 * lẫn, đổi lại A → lại 100/150, live tail append, resync 30s không
 * nhân đôi, refresh + tải thêm → tổng == dòng NDJSON trên đĩa, 0 lỗi
 * JS) và assert exit code 0. Bằng chứng (5 screenshot + summary.json
 * + main.log) nằm ở `.smoke-scratch/eventlog-v093b/` theo mặc định
 * (gitignored — chạy suite không làm bẩn cây); đặt
 * `SMOKE_EVENTLOG_REFRESH=1` để ghi đè snapshot đã commit ở
 * `docs/smoke-eventlog-v093b/` (chỉ khi refresh có chủ ý).
 *
 * Yêu cầu môi trường (thiếu thì SKIP, không fail — như các smoke khác):
 * - DISPLAY (chạy dưới `xvfb-run -a ...` khi không có màn hình thật).
 * - Ollama local ở http://127.0.0.1:11434 với model `qwen2.5:0.5b`.
 * - App đã build (`npm run build` — test này không tự build).
 *
 * Run:
 *   xvfb-run -a node --test tests/smoke-eventlog-v093b.test.mjs
 *
 * KHÔNG gọi API ngoài, KHÔNG dùng key: provider duy nhất là Ollama
 * local (1 lượt chạy thật). App chạy với --user-data-dir tạm nên
 * không đụng dữ liệu thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'smoke-eventlog-v093b.mjs');
// Same rule as the script (v0.93b): scratch by default, committed
// docs/ snapshot only with SMOKE_EVENTLOG_REFRESH=1.
const SHOTS_DIR = process.env.SMOKE_EVENTLOG_REFRESH === '1'
  ? path.join(REPO, 'docs', 'smoke-eventlog-v093b')
  : path.join(REPO, '.smoke-scratch', 'eventlog-v093b');
const SMOKE_TIMEOUT_MS = 540_000;

const hasDisplay = Boolean(process.env.DISPLAY);

async function ollamaReady() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body.models) && body.models.some((m) => m.name === 'qwen2.5:0.5b');
  } catch {
    return false;
  }
}

const shouldSkip = !hasDisplay || !(await ollamaReady());

test(
  'smoke: EventLogView trong app thật — paging 150, đổi bot, live tail, resync không trùng, 0 lỗi JS',
  { skip: shouldSkip, timeout: SMOKE_TIMEOUT_MS + 60_000 },
  async () => {
    assert.ok(fs.existsSync(path.join(REPO, 'apps', 'desktop', 'dist', 'main', 'main.js')),
      'app chưa build — chạy `npm run build` trước (smoke này không tự build)');
    const child = spawn(process.execPath, [SCRIPT, '--timeout-ms=540000'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, SMOKE_TIMEOUT_MS);
      child.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    // Log đầy đủ của script smoke để khi fail thì biết bước nào.
    process.stdout.write(out);
    if (err) process.stderr.write(err);
    assert.notEqual(code, null, `smoke script quá ${SMOKE_TIMEOUT_MS / 1000}s chưa xong`);
    const summaryPath = path.join(SHOTS_DIR, 'summary.json');
    assert.ok(fs.existsSync(summaryPath), `smoke phải ghi summary.json ở ${SHOTS_DIR}`);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const failed = (summary.steps ?? []).filter((s) => !s.ok);
    assert.deepEqual(failed, [], `các bước smoke fail: ${JSON.stringify(failed)}`);
    assert.equal(summary.seededA, 150, 'seed bot A phải là 150 entries');
    assert.equal(summary.seededB, 3, 'seed bot B phải là 3 entries');
    assert.equal(summary.finalTotal, summary.diskLinesA, 'tổng hiển thị phải == dòng NDJSON trên đĩa');
    assert.equal(code, 0, `smoke script exit ${code}`);
  },
);
