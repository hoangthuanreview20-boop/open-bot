#!/usr/bin/env node
/**
 * Fake `kiro-cli` (Kiro CLI) — CHỈ DÙNG CHO TEST (tests/kiro-cli-v076.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Hành vi theo docs
 * chính thức kiro.dev (tra cứu 2026-11-11):
 *
 * - `--version`: in 'kiro-cli 2.0.0', exit 0.
 * - `whoami --format json`: mặc định in JSON trạng thái đăng nhập +
 *   email, exit 0; `FAKE_KIRO_AUTH=fail` thì in 'Not logged in',
 *   exit 1; `FAKE_KIRO_AUTH=json-error` thì in JSON lỗi mà exit 0
 *   (test parser từ chối tường minh khi text báo chưa đăng nhập);
 *   `FAKE_KIRO_AUTH=plain` thì in text (không JSON) — test fallback.
 * - `chat --no-interactive <prompt>` (driver one-shot, prompt là đối
 *   số vị trí): in đáp án giả, exit 0. Hành vi điều khiển bằng biến
 *   môi trường (tiền tố FAKE_KIRO_):
 *   - `FAKE_KIRO_MODE`: 'default' | 'fail' | 'slow' | 'empty'
 *     - 'fail': in lỗi ra stderr, exit 1.
 *     - 'slow': không bao giờ thoát (test timeout/abort).
 *     - 'empty': exit 0 nhưng không in gì (test output rỗng).
 *   - `FAKE_KIRO_ARGS_LOG`: file append argv nhận được (một dòng).
 *   - `FAKE_KIRO_ENV_DUMP`: file ghi JSON process.env lúc spawn
 *     (test env đã lọc secret — KIRO_API_KEY không được chui qua).
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
  console.log('kiro-cli 2.0.0');
  process.exit(0);
}

if (args[0] === 'whoami') {
  const auth = process.env.FAKE_KIRO_AUTH ?? 'default';
  if (auth === 'fail') {
    console.error('Not logged in. Run `kiro-cli login` to authenticate.');
    process.exit(1);
  }
  if (auth === 'json-error') {
    // JSON lỗi nhưng exit 0 — parser thật phải từ chối qua text.
    console.log(JSON.stringify({ error: 'Not logged in' }));
    process.exit(0);
  }
  if (auth === 'plain') {
    console.log('Logged in with Builder ID\nProfile:\nbuilder-id-username');
    process.exit(0);
  }
  // Mặc định: JSON theo cờ --format json (shape thật chưa được docs
  // ghi rõ — fake dùng shape hợp lý nhất: email + method).
  console.log(JSON.stringify({ email: 'alice@example.com', authMethod: 'Builder ID' }));
  process.exit(0);
}

if (args[0] === 'chat' && args.includes('--no-interactive')) {
  appendLog(process.env.FAKE_KIRO_ARGS_LOG, args.join(' '));
  if (process.env.FAKE_KIRO_ENV_DUMP) {
    try {
      fs.writeFileSync(process.env.FAKE_KIRO_ENV_DUMP, JSON.stringify(process.env));
    } catch {
      // ignore
    }
  }
  const mode = process.env.FAKE_KIRO_MODE ?? 'default';
  // Prompt là đối số vị trí cuối cùng (sau --no-interactive).
  const prompt = args[args.length - 1] ?? '';
  if (mode === 'fail') {
    console.error('kiro-cli: Not logged in. Run `kiro-cli login` to authenticate.');
    process.exit(1);
  }
  if (mode === 'slow') {
    // Không bao giờ trả lời trong thời gian test: giữ process sống
    // bằng timer dài KHÔNG unref (unref sẽ làm process thoát ngay).
    setTimeout(() => process.exit(0), 60_000);
  } else if (mode === 'empty') {
    process.exit(0);
  } else {
    console.log(`Kiro reply to: ${prompt.slice(0, 50)}`);
    process.exit(0);
  }
} else {
  console.error(`fake-kiro-cli: không rõ args: ${args.join(' ')}`);
  process.exit(2);
}
