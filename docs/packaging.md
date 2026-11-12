# Packaging — đóng gói open-bot desktop cho 3 OS

Config: `apps/desktop/electron-builder.yml` (YAML, không phải `.js` — khai báo
thuần túy, dễ review; electron-builder tự phát hiện khi chạy từ
`apps/desktop/`). App: `open-bot` (`appId: dev.openbot.desktop`).

| OS | Target | Arch | Lệnh |
|----|--------|------|------|
| macOS | dmg | arm64 + x64 | `npm run dist:mac --workspace=@open-bot/desktop` |
| Windows | nsis | x64 | `npm run dist:win --workspace=@open-bot/desktop` |
| Linux | AppImage | x64 | `npm run dist:linux --workspace=@open-bot/desktop` |

`npm run dist` ở root (hoặc `npm run dist` trong `apps/desktop/`) build cho
OS hiện tại. Mỗi lệnh `dist:*` chạy `npm run build` trước rồi mới đóng gói.
Output nằm ở `apps/desktop/release/`. Build sẵn có mà config khớp theo:
main `dist/main/main.js` (`tsc -p tsconfig.main.json`), renderer
`dist/renderer` (vite), `asar: true`, `files: dist/** + package.json`.

## Yêu cầu theo OS

- **Linux**: chạy trực tiếp trên máy này. Cần các thư viện hệ thống cho
  AppImage (thường đã có sẵn trên Ubuntu/Debian desktop). Lệnh thử nhẹ:
  `npx electron-builder --linux --dir` (chỉ giải nén thư mục app, không
  đóng AppImage).
- **Windows**: **phải chạy trên Windows thật** (hoặc CI `windows-latest`).
  Không build được NSIS installer từ Linux/macOS. Cần Node 24+ và
  `npm ci` trước.
- **macOS**: **phải chạy trên máy Mac thật** (hoặc CI `macos-latest`).
  Không build được dmg từ Linux/Windows. Code signing / notarization:
  chưa cấu hình trong `electron-builder.yml` — bản dmg hiện tại là
  **unsigned** (macOS sẽ cảnh báo Gatekeeper khi mở lần đầu). Để ký:
  cần Apple Developer ID certificate + `CSC_LINK` / `CSC_KEY_PASSWORD`
  (hoặc `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` cho notarize), thêm
  vào CI secrets rồi bổ sung mục `mac.identity` khi có chứng chỉ.

## CI

Workflow `.github/workflows/ci.yml` chạy build + typecheck + test trên cả
3 OS (matrix `ubuntu-latest` / `windows-latest` / `macos-latest`, Node 24,
cache npm, test Linux dưới `xvfb-run -a`), cộng job riêng chạy
`tests/platform.test.mjs` trên cả 3 OS. Chỉ trigger trên push/PR.

## Lưu ý

- Workspace deps (`@open-bot/core`, `@open-bot/tools`) được electron-builder
  gom qua `node_modules` production khi đóng gói; nếu bản release chạy
  thiếu module nội bộ, kiểm tra lại `files` trong config.
- Chưa từng chạy đóng gói thật cho Windows/macOS (không làm được trên
  Linux) — lần đầu nên chạy trên CI hoặc máy thật của từng OS để xác nhận.
