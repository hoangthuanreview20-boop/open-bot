#!/usr/bin/env node
/**
 * Fake `q` (Amazon Q Developer CLI) — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs
 * + tests/detected-cli-b-drivers.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật:
 *
 * - `--version`: in 'q 1.19.7', exit 0.
 * - `whoami`: mặc định in trạng thái đăng nhập + user, exit 0;
 *   `FAKE_Q_AUTH=fail` thì in 'Not logged in', exit 1.
 * - `chat --no-interactive --input <prompt>` (driver one-shot):
 *   in đáp án giả, exit 0. Hành vi điều khiển bằng biến môi trường
 *   (tiền tố FAKE_Q_):
 *   - `FAKE_Q_MODE`: 'default' | 'fail' | 'slow' | 'empty'
 *     - 'fail': in lỗi ra stderr, exit 1.
 *     - 'slow': không bao giờ thoát (test timeout/abort).
 *     - 'empty': exit 0 nhưng không in gì (test output rỗng).
 *   - `FAKE_Q_ARGS_LOG`: file append argv nhận được (một dòng).
 *   - `FAKE_Q_ENV_DUMP`: file ghi JSON process.env lúc spawn
 *     (test env đã lọc secret).
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
  console.log('q 1.19.7');
  process.exit(0);
}

if (args[0] === 'whoami') {
  if (process.env.FAKE_Q_AUTH === 'fail') {
    console.error('Not logged in. Run `q login` to authenticate.');
    process.exit(1);
  }
  console.log('Logged in as alice@example.com (Builder ID)');
  process.exit(0);
}

if (args[0] === 'chat' && args.includes('--no-interactive')) {
  appendLog(process.env.FAKE_Q_ARGS_LOG, args.join(' '));
  if (process.env.FAKE_Q_ENV_DUMP) {
    try {
      fs.writeFileSync(process.env.FAKE_Q_ENV_DUMP, JSON.stringify(process.env));
    } catch {
      // ignore
    }
  }
  const mode = process.env.FAKE_Q_MODE ?? 'default';
  const prompt = args[args.indexOf('--input') + 1] ?? '';
  if (mode === 'fail') {
    console.error('q: Not logged in. Run `q login` to authenticate.');
    process.exit(1);
  }
  if (mode === 'slow') {
    // Không bao giờ trả lời trong thời gian test: giữ process sống
    // bằng timer dài KHÔNG unref (unref sẽ làm process thoát ngay).
    setTimeout(() => process.exit(0), 60_000);
  } else if (mode === 'empty') {
    process.exit(0);
  } else {
    console.log(`Amazon Q reply to: ${prompt.slice(0, 50)}`);
    process.exit(0);
  }
} else {
  console.error(`fake-q: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}
