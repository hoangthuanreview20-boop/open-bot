#!/usr/bin/env node
/**
 * Fake `gh` (GitHub CLI) — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Chỉ phục vụ detector
 * Copilot CLI, vốn hỏi `gh auth status` vì chính Copilot CLI không có
 * lệnh status:
 *
 * - Mặc định: `auth status` in 'Logged in to github.com as octocat', exit 0.
 * - `FAKE_GH_AUTH=fail`: `auth status` exit 1 (chưa đăng nhập).
 */
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_GH_AUTH === 'fail') {
    console.error('You are not logged into any GitHub hosts. Run gh auth login to authenticate.');
    process.exit(1);
  }
  console.log('github.com');
  console.log('  Logged in to github.com as octocat (oauth)');
  console.log('  Git operations for github.com configured to use https protocol.');
  process.exit(0);
}

console.error(`fake-gh: không rõ args: ${args.join(' ')}`);
process.exit(2);
