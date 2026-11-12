#!/usr/bin/env node
/**
 * Fake `aider` CLI — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs
 * + tests/detected-cli-b-drivers.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Chỉ trả version cho
 * `--version`; việc kiểm tra đăng nhập của Aider là kiểu 'env-present'
 * (biến môi trường API key) nên fixture này không cần xử lý auth.
 *
 * Chế độ driver one-shot (`--message <msg> --yes-always
 * --no-auto-commits --no-pretty`): in đáp án giả + dòng tóm tắt
 * `Tokens: 1.2k sent, 300 received, …` (để test parse usage).
 * Hành vi điều khiển bằng biến môi trường (tiền tố FAKE_AIDER_):
 * - `FAKE_AIDER_MODE`: 'default' | 'fail' | 'slow' | 'empty' | 'die'
 *   - 'fail': in lỗi ra stderr, exit 1.
 *   - 'slow': không bao giờ thoát (test timeout/abort).
 *   - 'empty': exit 0 nhưng không in gì (test output rỗng).
 *   - 'die': in lỗi ra stderr, exit 3.
 * - `FAKE_AIDER_ARGS_LOG`: file append argv nhận được (một dòng).
 * - `FAKE_AIDER_ENV_DUMP`: file ghi JSON process.env lúc spawn
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
  console.log('aider 0.86.2');
  process.exit(0);
}

if (args.includes('--message')) {
  appendLog(process.env.FAKE_AIDER_ARGS_LOG, args.join(' '));
  if (process.env.FAKE_AIDER_ENV_DUMP) {
    try {
      fs.writeFileSync(process.env.FAKE_AIDER_ENV_DUMP, JSON.stringify(process.env));
    } catch {
      // ignore
    }
  }
  const mode = process.env.FAKE_AIDER_MODE ?? 'default';
  const msgIdx = args.indexOf('--message');
  const msg = args[msgIdx + 1] ?? '';
  if (mode === 'fail') {
    console.error('aider: No API key found. Set OPENAI_API_KEY and retry.');
    process.exit(1);
  }
  if (mode === 'die') {
    console.error('aider: unexpected crash (fake)');
    process.exit(3);
  }
  if (mode === 'slow') {
    // Không bao giờ trả lời trong thời gian test: giữ process sống
    // bằng timer dài KHÔNG unref (unref sẽ làm process thoát ngay).
    setTimeout(() => process.exit(0), 60_000);
  } else if (mode === 'empty') {
    process.exit(0);
  } else {
    console.log(`Aider reply to: ${msg.slice(0, 50)}`);
    console.log('Tokens: 1.2k sent, 300 received, 1.5k total.');
    process.exit(0);
  }
} else {
  console.error(`fake-aider: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}
