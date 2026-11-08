import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Chỉ build renderer qua Vite. Electron main (src/main) KHÔNG qua Vite:
// main được biên dịch riêng bằng `tsc -p tsconfig.main.json` ra dist/main.
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
