#!/usr/bin/env node
/**
 * Fake `windsurf` CLI — CHỈ DÙNG CHO TEST (tests/detected-cli-b-platform.test.mjs).
 *
 * Không gọi API thật, không đọc credential thật. Chỉ trả version cho
 * `--version`; Windsurf không có lệnh status riêng (CLI thừa hưởng đăng
 * nhập trong editor) nên detector dùng kiểu 'none' → trạng thái 'unknown'.
 */
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('windsurf 1.2.3');
  process.exit(0);
}

console.error(`fake-windsurf: không rõ args: ${args.join(' ')}`);
process.exit(2);
