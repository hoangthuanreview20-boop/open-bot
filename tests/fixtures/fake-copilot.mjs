#!/usr/bin/env node
/**
 * Fake `copilot` (GitHub Copilot CLI) — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Chỉ trả version cho
 * `--version`; việc kiểm tra đăng nhập chạy qua `gh auth status`
 * (fake-gh.mjs), vì chính Copilot CLI không có lệnh status.
 */
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('GitHub Copilot CLI 1.0.88');
  process.exit(0);
}

console.error(`fake-copilot: không rõ args: ${args.join(' ')}`);
process.exit(2);
