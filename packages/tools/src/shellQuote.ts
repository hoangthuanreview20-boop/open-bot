/**
 * shellQuote — hàm quote DUY NHẤT cho toàn bộ @open-bot/tools (v0.15).
 *
 * Trước đây 4 bản copy giống hệt nhau nằm rải rác ở tools.ts, codeTools.ts,
 * webMedia.ts và gitTools.ts. Cả 4 đã được gộp về đây; các file đó chỉ còn
 * `import { shellQuote } from './shellQuote'`. Mọi chỗ dùng (git blame,
 * git commit, ffmpeg concat, ...) đều đi qua `runShell`, nên quoting phải
 * khớp với shell mà `runShell` chọn trên từng nền tảng.
 *
 * Hành vi giữ nguyên so với bản copy cũ:
 *  - POSIX: bao bằng dấu nháy đơn, `'` thành `'\''` (idiom chuẩn của
 *    /bin/sh). Kể cả chuỗi an toàn cũng vẫn được quote — giữ nguyên để
 *    không đổi hành vi của các lệnh đã chạy ổn từ trước.
 *  - Windows: KHÁC bản cũ một điểm, có chủ đích. Bản cũ XÓA hẳn `"`, `$`,
 *    backtick (`value.replace(/["$`]/g, '')`), tức làm mất dữ liệu âm thầm
 *    (vd: tên file hay commit message chứa `$` bị biến dạng mà không báo).
 *    Bản này escape đúng cho PowerShell — shell mà `runShell` dùng trên
 *    Windows (`powershell -NoProfile -Command`):
 *      backtick -> `` `` `` (gấp đôi), `"` -> `` `" ``, `$` -> `` `$ ``.
 *    Thứ tự escape quan trọng: backtick trước, để các backtick vừa chèn
 *    khi escape `"` / `$` không bị escape lần nữa. `%` không cần escape
 *    trong PowerShell (chỉ cmd mới mở rộng `%VAR%`); hàm này KHÔNG dùng
 *    cho lệnh cmd thuần — chỗ nào gọi `cmd /c` thì không dùng shellQuote.
 *
 * @param value chuỗi cần quote (luôn được bao bằng quote, kể cả chuỗi rỗng:
 *   POSIX -> `''`, Windows -> `""`).
 * @param platform nền tảng muốn quote cho: `'win32'` hoặc `'posix'`.
 *   Nhận cả `NodeJS.Platform` (`'darwin'`, `'linux'`, ...) — mọi nền tảng
 *   khác `'win32'` đều được coi là POSIX. Mặc định lấy `process.platform`
 *   của máy đang chạy, nên các call site cũ gọi `shellQuote(x)` không cần
 *   đổi gì mà vẫn chạy đúng trên máy đó.
 */
export type ShellPlatform = 'win32' | 'posix';

/**
 * Chuẩn hoá một platform (Node hoặc rút gọn) về `'win32' | 'posix'`.
 * Mặc định (không truyền gì) lấy `process.platform`.
 */
export function resolveShellPlatform(
  platform?: ShellPlatform | NodeJS.Platform,
): ShellPlatform {
  const p = platform ?? process.platform;
  return p === 'win32' ? 'win32' : 'posix';
}

export function shellQuote(
  value: string,
  platform?: ShellPlatform | NodeJS.Platform,
): string {
  if (resolveShellPlatform(platform) === 'win32') {
    // PowerShell, chuỗi trong dấu nháy kép: chỉ có backtick, `"` và `$`
    // là ký tự đặc biệt — escape cả ba bằng backtick, backtick đi trước.
    const escaped = value
      .replace(/`/g, '``')
      .replace(/"/g, '`"')
      .replace(/\$/g, '`$');
    return `"${escaped}"`;
  }
  // POSIX: `'...'` với `'` -> `'\''`. Viết bằng nối chuỗi thay vì template
  // literal để tránh nhầm lẫn với các dấu backslash trong source.
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
