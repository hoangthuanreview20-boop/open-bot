/**
 * Tests cho v0.55 — CSP worker (a): worklet ghi âm load từ file, không
 * blob, không nới CSP.
 *
 * Bối cảnh: AudioWorklet ghi âm (pcm-capture) trước đây load từ blob URL
 * và bị CSP `script-src 'self'` chặn lúc load app (Chromium kiểm tra
 * AudioWorklet.addModule theo `script-src`, không theo `worker-src` —
 * đã xác minh bằng smoke Electron + CDP, xem /tmp/csp-smoke.mjs).
 * Sửa đúng cách là load worklet từ file asset do Vite emit (`?url`),
 * cùng origin 'self', thay vì nới CSP (`script-src blob:` thì nới
 * lỏng chung; `worker-src blob:` thì không cứu được worklet).
 *
 * Test này khóa 3 điểm ở mức source (không cần chạy app):
 *  1. CSP meta không cho blob:/data: trong script-src (và không có
 *     worker-src blob: trá hình).
 *  2. ChatView không còn tạo blob URL cho worklet, mà import file
 *     bằng `?url`.
 *  3. Vite không inline asset nhỏ thành data: URL (data: cũng bị
 *     CSP chặn) — `assetsInlineLimit: 0`.
 *
 * Chạy: node --test tests/csp-worklet-v055.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = path.join(ROOT, 'apps/desktop/src/renderer/index.html');
const CHAT_VIEW = path.join(ROOT, 'apps/desktop/src/renderer/components/ChatView.tsx');
const WORKLET = path.join(ROOT, 'apps/desktop/src/renderer/pcm-capture.worklet.js');
const VITE_CONFIG = path.join(ROOT, 'apps/desktop/vite.config.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('csp-worklet: meta CSP giữ script-src self, không blob:/data:/worker-src', () => {
  const html = read(INDEX_HTML);
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'index.html phải có meta CSP');
  const csp = m[1];
  assert.match(csp, /script-src 'self'/, 'script-src vẫn là self');
  assert.ok(!csp.includes('blob:'), `CSP không được chứa blob: — nhận ${csp}`);
  assert.ok(!csp.includes('data:'), `CSP không được chứa data: — nhận ${csp}`);
  assert.ok(!/worker-src[^;]*blob:/.test(csp), 'worker-src (nếu có) không được chứa blob:');
});

test('csp-worklet: ChatView load worklet từ file (?url), không tạo blob URL', () => {
  const src = read(CHAT_VIEW);
  assert.match(
    src,
    /from '\.\.\/pcm-capture\.worklet\.js\?url'/,
    'ChatView phải import worklet bằng ?url (file asset)',
  );
  assert.ok(!src.includes('?raw'), 'không còn import worklet bằng ?raw');
  assert.ok(!src.includes('createObjectURL'), 'ChatView không còn tạo blob URL cho worklet');
  assert.match(src, /audioWorklet\.addModule\(workletUrl\)/, 'addModule dùng URL file asset');
  // Worklet vẫn đăng ký đúng processor mà AudioWorkletNode cần.
  assert.match(read(WORKLET), /registerProcessor\('pcm-capture'/);
});

test('csp-worklet: Vite không inline asset thành data: URL', () => {
  const config = read(VITE_CONFIG);
  assert.match(config, /assetsInlineLimit:\s*0/, 'assetsInlineLimit phải là 0 để worklet thành file thật');
});
