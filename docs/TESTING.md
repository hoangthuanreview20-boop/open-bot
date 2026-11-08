# Kiểm tra (Testing) — open-bot v0.1

Ngày kiểm tra: 2026-11-08. Môi trường: Linux VM, Node v24.22.1, npm 10.9.4.
Chưa test với API key thật của bất kỳ provider nào — muốn test provider thật
(OpenAI / Anthropic / Gemini / xAI / Ollama) cần có key và endpoint thật.

## Lệnh build / typecheck

| Lệnh | Kết quả |
| --- | --- |
| `npm install` (root, workspaces) | PASS — 138 packages, không lỗi native build (core dùng `node:sqlite` có sẵn, không có `better-sqlite3`). |
| `npm run build` | PASS — core → tools → desktop, sạch. |
| `npm run typecheck` | PASS — sạch, 0 lỗi. |

Hai lỗi build có sẵn đã sửa trong đợt tích hợp (không phải do code mới):

1. `packages/tools/tsconfig.json` map `@open-bot/core` thẳng tới source của
   core (`../core/src/index.ts`) nên `tsc` báo TS6059 (`rootDir` là
   `packages/tools/src`). Đã bỏ map `paths` — tools dùng bản `dist` đã build
   của core.
2. `packages/tools/tsconfig.json` kế thừa `module: ESNext` từ
   `tsconfig.base.json`, nên `dist` của tools là ESM với import không đuôi
   `.js` (`export ... from './tools'`) — Node/Electron không load được
   package này. Đã set `module: commonjs`, `moduleResolution: node` (như core).
3. Script `build`/`typecheck` ở root dùng `npm run ... --workspaces`
   chạy desktop trước khi core/tools có `dist`, nên `tsc` của desktop lỗi
   resolve `@open-bot/*`. Đã đổi thành chạy tuần tự core → tools → desktop.

## Smoke test agent core (mock provider + tool thật)

Script kiểm tra (tạm, lưu ở `/tmp/open-bot-smoke/mock-test.cjs`, không commit):
mock server HTTP local giả lập OpenAI `/chat/completions`.

- Vòng 1: mock trả tool call `write_file` (`hello.txt`, nội dung
  `xin chao open-bot`).
- Vòng 2: mock kiểm tra request chứa assistant message có `tool_calls` +
  message `role: tool` với `tool_call_id` khớp, rồi trả tool call `read_file`.
- Vòng 3: mock kiểm tra lại pairing, trả text cuối.
- Kết quả: **PASS** — 3 vòng, file `hello.txt` được ghi thật bằng
  `createDefaultTools()` (autoApprove true trong test) và đọc lại đúng nội
  dung, câu trả lời cuối chứa `xin chao open-bot`.

## Kiểm tra provider Anthropic + Gemini (mock server)

Script `/tmp/open-bot-smoke/provider-test.cjs`:

- Anthropic: vòng 2 gửi đúng `tool_use` (id `toolu_1`) trước `tool_result`
  với `tool_use_id` khớp và nội dung kết quả — **PASS**.
- Gemini: vòng 2 gửi đúng `functionCall` + `functionResponse` với `name`
  `read_file` và `response.result` là nội dung file — **PASS**.

## Kiểm tra BotMemory (API thật mà desktop dùng)

Script `/tmp/open-bot-smoke/websearch-test.cjs`: `saveBot`/`getBot`,
`saveMessage`/`getHistory`, `setMemory`/`getMemory`,
`createTask`/`updateTask`/`listTasks` trên DB SQLite tạm — **PASS**.

## Kiểm tra web_search (DuckDuckGo + fallback Bing)

Cùng script trên, query `open source desktop AI agent`:

- DuckDuckGo không trả kết quả dùng được trong lần chạy này → fallback Bing
  chạy và trả **8 kết quả** — **PASS** (fallback đã được chứng minh chạy).
- Hạn chế nhỏ: URL kết quả Bing là link redirect `bing.com/ck/a?...`,
  chưa unwrap về URL đích. Ghi nhận cho v0.2, không chặn v0.1.

## Smoke test desktop (Electron thật)

- `npm run build` trong `apps/desktop`: **PASS** (`dist/main/main.js`,
  `dist/main/preload.js`, `dist/renderer/index.html` đều có).
- Khởi động thật: `timeout 20 xvfb-run -a npx electron . --no-sandbox`
  (cần `--no-sandbox` vì đang chạy dưới user root; `xvfb-run` đã có sẵn
  trên máy, không cần cài thêm). App **chạy suốt 20s** tới khi bị timeout
  kill (exit 124 = bị kill, không phải crash), không có lỗi JS
  (không `Uncaught`, `TypeError`, `Cannot find module` trong log).
  Bằng chứng main process chạy thật: file `settings.json` được tạo ở
  `~/.config/@open-bot/desktop/` với bot mặc định `Trợ lý` (xai, grok-4.7)
  và Local Storage/Cache của renderer được tạo.
- Log chỉ có nhiễu môi trường VM: lỗi kết nối D-Bus (không có system bus),
  lỗi khởi tạo GPU, và `FATAL: Failed to shutdown` lúc bị SIGTERM kill —
  không phải lỗi của app.

## Chưa kiểm chứng

- Provider thật (OpenAI/Anthropic/Gemini/xAI/Ollama): chưa có API key thật
  trong đợt này. Code provider đã được kiểm tra bằng mock server ở trên.
- Chat end-to-end trong UI thật (gõ tin nhắn, phê duyệt tool call):
  chưa làm — cần key thật + thao tác tay trong app.
- Chạy trên Windows/macOS: chưa test, chỉ test trên Linux VM này.
