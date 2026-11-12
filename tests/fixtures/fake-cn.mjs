#!/usr/bin/env node
/**
 * Fake `cn` (Continue CLI) — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs
 * + tests/detected-cli-b-drivers.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Chỉ trả version cho
 * `--version`; việc kiểm tra đăng nhập của Continue là kiểm tra tồn tại
 * của `~/.continue/config.yaml` nên fixture này không cần xử lý auth.
 *
 * Chế độ driver one-shot (`-p <prompt>`): in đáp án giả, exit 0.
 * Hành vi điều khiển bằng biến môi trường (tiền tố FAKE_CN_):
 * - `FAKE_CN_MODE`: 'default' | 'fail' | 'slow' | 'empty'
 *   - 'fail': in lỗi ra stderr, exit 1.
 *   - 'slow': không bao giờ thoát (test timeout/abort).
 *   - 'empty': exit 0 nhưng không in gì (test output rỗng).
 * - `FAKE_CN_ARGS_LOG`: file append argv nhận được (một dòng).
 * - `FAKE_CN_ENV_DUMP`: file ghi JSON process.env lúc spawn
 *   (test env đã lọc secret).
 */
import * as fs from 'node:fs';

const args = process.argv.slice(2);

function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Log test là best-effort.
  }
}

if (args.includes('--version')) {
  console.log('cn 1.5.47');
  process.exit(0);
}

if (args.includes('-p')) {
  appendLog(process.env.FAKE_CN_ARGS_LOG, args.join(' '));
  if (process.env.FAKE_CN_ENV_DUMP) {
    try {
      fs.writeFileSync(process.env.FAKE_CN_ENV_DUMP, JSON.stringify(process.env));
    } catch {
      // ignore
    }
  }
  const mode = process.env.FAKE_CN_MODE ?? 'default';
  const prompt = args[args.indexOf('-p') + 1] ?? '';
  if (mode === 'fail') {
    console.error('cn: No model configured. Add a model to ~/.continue/config.yaml.');
    process.exit(1);
  }
  if (mode === 'slow') {
    // Không bao giờ trả lời trong thời gian test: giữ process sống
    // bằng timer dài KHÔNG unref (unref sẽ làm process thoát ngay).
    setTimeout(() => process.exit(0), 60_000);
  } else if (mode === 'empty') {
    process.exit(0);
  } else {
    console.log(`Continue reply to: ${prompt.slice(0, 50)}`);
    process.exit(0);
  }
} else {
  console.error(`fake-cn: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}
