import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// CSP chỉ áp cho bản build: meta CSP trong index.html bị strip khỏi dev
// server (apply: 'serve') để HMR qua WebSocket (ws://localhost:5173)
// không bị connect-src ← default-src 'self' chặn. Bản build
// (loadFile, file://) không qua plugin này nên meta CSP còn nguyên.
function stripCspMetaInDev(): Plugin {
  return {
    name: 'open-bot:strip-csp-meta-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>\s*/gi,
        '',
      );
    },
  };
}

// Chỉ build renderer qua Vite. Electron main (src/main) KHÔNG qua Vite:
// main được biên dịch riêng bằng `tsc -p tsconfig.main.json` ra dist/main.
export default defineConfig({
  // v0.27 (L5 click test): base tương đối — main process load renderer
  // bằng loadFile (file://) nên asset KHÔNG được dùng đường dẫn tuyệt
  // đối '/assets/...' (trỏ về gốc filesystem, 404, cửa sổ trắng).
  // Với base './', bản build chạy được cả qua loadFile lẫn dev server.
  base: './',
  plugins: [react(), stripCspMetaInDev()],
  root: 'src/renderer',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // v0.55: KHÔNG inline asset nhỏ thành data: URL — AudioWorklet
    // ghi âm (pcm-capture.worklet.js, import `?url` ở ChatView) phải
    // là file thật thì CSP `script-src 'self'` mới cho load (data:
    // cũng bị chặn như blob:). File ~1,2 kB, dưới ngưỡng inline mặc
    // định (4096) của Vite nên không đặt 0 thì build sẽ nhúng nó
    // thành `data:text/javascript;base64,...` và worklet lại hỏng.
    assetsInlineLimit: 0,
  },
});
